/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-drive.md, sub-PR 4: `agent-show` (`vimma_show`) asks, and on a yes switches
// the window that holds the agent tab to the agent workspace with that tab selected, through the
// ordinary workspace switch, so ctrl+^ returns to the user's workspace and split (D2, D3). It
// always asks and no grant covers it (D4), its question waits while the user types (D5), a private
// window never changes and no window is raised or focused (D5, D6), and 6 a minute is the most
// (D7). security.md M19, M20.

"use strict";

/* global focusContent -- from head.js */
/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const ARMING = "security.dialog_enable_delay";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const NOTICE_ID = "vimma-notice";

registerCleanupFunction(async () => {
  for (const pref of [MCP_ENABLED_PREF, ASK_TIMEOUT, ARMING]) Services.prefs.clearUserPref(pref);
  AgentGate.revoke();
  await VimmaControl.settled();
  if (PaneViews.get(window)?.panes) {
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("x");
  }
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = (win = window) =>
  win.gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = (win = window) => WindowWorkspaces.get(win);
const activeName = (win = window) =>
  ww(win).model.workspaces.find((w) => w.id === ww(win).model.active)?.name;
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;
const noticeText = (win = window) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
const line = () => document.getElementById("vimma-agent-prompt");
const lineOpen = () => !!line() && !line().hidden;

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace of `win`, loaded, hidden while the window shows `main`. */
async function openAgentTab(win = window, url = PAGE) {
  const tab = win.gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/**
 * `agent-show` of `tab`, answered with `answer` through the gate.
 * @param {any} c @param {any} tab @param {object} [answer]
 */
async function show(c, tab, answer = { kind: "once" }) {
  const id = c.request("agent-show", { tab: idOf(tab) });
  const q = await question();
  Assert.equal(q.tool, "vimma_show", "agent-show asks as vimma_show");
  AgentGate.answer(q.id, answer);
  const r = await c.response(id);
  if (r.ok) {
    Assert.deepEqual(validateMessage(r, { command: "agent-show" }).errors, [], "a valid result");
  }
  return r;
}

/** Quiet keys and a focused page: the question may open by itself after 1,500 ms. */
async function calmPage() {
  await focusContent(gBrowser.selectedBrowser);
  await new Promise((r) => setTimeout(r, 1600));
}

add_task(async function setup() {
  // A question nobody answers ends well before the test's own timeout.
  Services.prefs.setIntPref(ASK_TIMEOUT, 20000);
  BrowserTestUtils.startLoadingURIString(gBrowser.selectedBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser, false, PAGE);
});

// D2, D3: the yes switches this window to the agent workspace with the agent tab selected, the
// notice says how to get back, and ctrl+^ returns to main with its split laid out as it was.
add_task(async function test_show_switches_to_the_agent_tab_and_ctrl_caret_returns() {
  await mcp(true);
  const other = await openAgentTab();
  const tab = await openAgentTab();
  Assert.equal(activeName(), "main", "the window shows main");
  await focusContent(gBrowser.selectedBrowser);
  const page = gBrowser.selectedTab;
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("v");
  const view = PaneViews.get(window);
  await until(() => view.panes && leaves(view.panes).length === 2, "main has two panes");
  const pane = gBrowser.selectedTab;
  Assert.notEqual(pane, page, "the new pane has focus");

  const c = await agentClient("claude-code");
  const r = await show(c, tab);
  Assert.ok(r.ok, `the show ran: ${JSON.stringify(r.error ?? null)}`);
  Assert.deepEqual(r.result, { shown: true }, "and says so");
  Assert.equal(activeName(), agent().name, "the window shows the agent workspace");
  Assert.equal(gBrowser.selectedTab, tab, "with the asked tab selected, not the other one");
  Assert.ok(!tab.hidden && !other.hidden, "the agent workspace's tabs are shown");
  Assert.ok(page.hidden && pane.hidden, "main's split is parked");
  Assert.equal(view.panes, null, "the agent workspace shows one pane");
  await until(
    () => noticeText() === "showing claude-code's tab · ctrl+^ goes back",
    "the notice says how to get back",
  );
  Assert.equal(AgentGate.log[0].tool, "vimma_show", "the show is in :mcp log");
  Assert.equal(AgentGate.log[0].outcome, "yes", "as allowed");

  // A second show while the agent workspace is in front only selects the tab: ctrl+^ still
  // goes back to main, and the notice does not claim the show is what it undoes.
  Assert.ok((await show(c, other)).ok, "a show of the other agent tab");
  Assert.equal(gBrowser.selectedTab, other, "selects it");
  await until(() => noticeText() === "showing claude-code's tab", "with no ctrl+^ in the notice");

  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("^", { ctrlKey: true, shiftKey: true, code: "Digit6" });
  await until(() => activeName() === "main", "ctrl+^ goes back to main");
  Assert.equal(gBrowser.selectedTab, pane, "on the pane that had focus");
  Assert.ok(view.panes && leaves(view.panes).length === 2, "with main's two panes");
  Assert.ok(tab.hidden && other.hidden, "and the agent tabs hidden again");

  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("x");
  await until(() => !view.panes, "back to one pane");
  c.close();
  for (const t of [tab, other, pane]) BrowserTestUtils.removeTab(t);
  await mcp(false);
});

// D4 (M19): a grant of any tool never covers a show, a grant answer to its question is refused
// and leaves it waiting, `x` is a plain no, and the next show asks again.
add_task(async function test_show_always_asks_even_under_a_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // A grant for this connection, which covers every tool but a show (mcp-grants G2).
  const listed = c.request("agent-tabs");
  AgentGate.answer((await question()).id, { kind: "grant", minutes: 10 });
  Assert.ok((await c.response(listed)).ok, "the tab list ran under its grant");
  const [granted] = AgentGate.grants();

  const id = c.request("agent-show", { tab: idOf(tab) });
  const q = await question();
  Assert.equal(q.tool, "vimma_show", "the show asks although the connection holds a grant");
  Assert.equal(AgentGate.answer(q.id, { kind: "grant", minutes: 10 }), null, "no grant for it");
  Assert.equal(AgentGate.waiting[0]?.id, q.id, "the question still waits");
  AgentGate.answer(q.id, { kind: "mute" });
  const r = await c.response(id);
  Assert.equal(r.error?.reason, "user", "x is a plain no");
  Assert.equal(activeName(), "main", "and nothing was shown");
  Assert.deepEqual(
    AgentGate.grants().map((g) => g.until),
    [granted.until],
    "and the grant is the one given before, unchanged",
  );

  Assert.ok((await show(c, tab)).ok, "a yes shows it");
  ww().switchTo({ id: mainId() });
  const again = c.request("agent-show", { tab: idOf(tab) });
  Assert.equal((await question()).tool, "vimma_show", "the next show asks again");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "deny" });
  Assert.equal((await c.response(again)).error?.reason, "user", "and a no denies it");
  Assert.equal(activeName(), "main", "the window stays on main");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// D5: while the user types in a field, the question does not open by itself; it waits behind
// `◇ agent 1?`, and the window keeps its workspace until a `y`.
add_task(async function test_show_waits_while_the_user_types() {
  await mcp(true);
  Services.prefs.setIntPref(ARMING, 100);
  const tab = await openAgentTab();
  const c = await agentClient();
  await calmPage();
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => {
    const input = content.document.createElement("input");
    content.document.body.append(input);
    input.focus();
  });
  const id = c.request("agent-show", { tab: idOf(tab) });
  await question();
  await new Promise((r) => setTimeout(r, 2000));
  Assert.ok(!lineOpen(), "the question does not open over a field");
  Assert.equal(activeName(), "main", "and the window stays on main");
  EventUtils.sendString("yy");
  await new Promise((r) => setTimeout(r, 200));
  Assert.equal(AgentGate.waiting.length, 1, "what is typed in the field answers nothing");
  Assert.equal(activeName(), "main", "still on main");

  // Out of the field: the line opens on ctrl+b shift+a, and its keys are its own.
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], () => {
    content.document.activeElement.blur();
  });
  await calmPage();
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("A", { shiftKey: true });
  await until(lineOpen, "ctrl+b shift+a opens the question");
  await until(() => !!line().querySelector(".vimma-agent-prompt-hint")?.textContent, "armed");
  Assert.ok(line().textContent.includes("y show it · n deny"), "the question offers y and n only");
  EventUtils.synthesizeKey("y");
  Assert.ok((await c.response(id)).ok, "y shows it");
  Assert.equal(activeName(), agent().name, "now the agent workspace is in front");
  c.close();
  ww().switchTo({ id: mainId() });
  BrowserTestUtils.removeTab(tab);
  Services.prefs.clearUserPref(ARMING);
  await mcp(false);
});

// D5, D6 (M19): with a private window in front, the show switches only the normal window that
// holds the tab; the private window keeps its page and stays the active window.
add_task(async function test_show_never_touches_a_private_window() {
  await mcp(true);
  const tab = await openAgentTab();
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privTab = priv.gBrowser.selectedTab;
  await SimpleTest.promiseFocus(priv);
  const c = await agentClient();
  Assert.ok((await show(c, tab)).ok, "the show ran");
  Assert.equal(activeName(), agent().name, "the normal window shows the agent workspace");
  Assert.equal(priv.gBrowser.selectedTab, privTab, "the private window keeps its tab");
  Assert.equal(priv.gBrowser.tabs.length, 1, "and gains none");
  Assert.equal(Services.focus.activeWindow, priv, "and stays the active window");
  c.close();
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  ww().switchTo({ id: mainId() });
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// D6 (M19): an agent tab in a window other than the one in front switches that window only;
// no window is raised or focused, and the notice says where the tab is shown.
add_task(async function test_show_never_focuses_a_window() {
  await mcp(true);
  const tab = await openAgentTab();
  const front = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(front);
  const frontWorkspace = activeName(front);
  const frontTab = front.gBrowser.selectedTab;
  const c = await agentClient("claude-code");
  Assert.ok((await show(c, tab)).ok, "the show ran");
  Assert.equal(activeName(), agent().name, "the window that holds the tab switched");
  Assert.equal(gBrowser.selectedTab, tab, "to the agent tab");
  Assert.equal(activeName(front), frontWorkspace, "the window in front kept its workspace");
  Assert.equal(front.gBrowser.selectedTab, frontTab, "and its tab");
  Assert.equal(Services.focus.activeWindow, front, "and is still the active window");
  await until(
    () =>
      noticeText(front) ===
      "showing claude-code's tab, shown in the other window · ctrl+^ there goes back",
    "the notice in front says the tab is shown in the other window",
  );
  c.close();
  await BrowserTestUtils.closeWindow(front);
  await SimpleTest.promiseFocus(window);
  ww().switchTo({ id: mainId() });
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// D6 (M19): a pane of a split in the agent workspace, in a window behind another one: that
// window switches to the split with the pane selected, and stays behind.
add_task(async function test_show_a_pane_of_an_agent_split_in_a_window_behind() {
  await mcp(true);
  const tab = await openAgentTab();
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent workspace shows its tab");
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("v");
  const view = PaneViews.get(window);
  await until(() => view.panes && leaves(view.panes).length === 2, "the agent split has two panes");
  const pane = gBrowser.selectedTab;
  Assert.notEqual(pane, tab, "the new pane has focus");
  ww().switchTo({ id: mainId() });
  await until(() => !view.panes, "main shows one pane");

  const front = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(front);
  const c = await agentClient("claude-code");
  Assert.ok((await show(c, tab)).ok, "the show ran");
  Assert.equal(activeName(), agent().name, "the window behind shows the agent workspace");
  Assert.equal(gBrowser.selectedTab, tab, "with the asked pane selected");
  Assert.ok(view.panes && leaves(view.panes).length === 2, "in its split");
  Assert.equal(Services.focus.activeWindow, front, "and the window in front stays active");
  c.close();
  await BrowserTestUtils.closeWindow(front);
  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("x");
  await until(() => !view.panes, "back to one pane");
  ww().switchTo({ id: mainId() });
  for (const t of [tab, pane]) if (!t.closing && t.isConnected) BrowserTestUtils.removeTab(t);
  await mcp(false);
});

// D2 (M19): the yes stands for the tab as asked about: one that navigated or closed meanwhile
// is `changed`, nothing is shown, and :mcp log says so.
add_task(async function test_show_refuses_a_tab_changed_after_the_question() {
  await mcp(true);
  const c = await agentClient();
  const moved = await openAgentTab();
  let id = c.request("agent-show", { tab: idOf(moved) });
  let q = await question();
  const next = `${PAGE}?moved`;
  BrowserTestUtils.startLoadingURIString(moved.linkedBrowser, next);
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, next);
  AgentGate.answer(q.id, { kind: "once" });
  let r = await c.response(id);
  Assert.equal(r.error?.reason, "changed", "a tab that navigated is changed");
  Assert.equal(activeName(), "main", "and nothing was shown");
  Assert.equal(AgentGate.log[0].outcome, "changed", ":mcp log says changed");

  const closed = await openAgentTab();
  id = c.request("agent-show", { tab: idOf(closed) });
  q = await question();
  BrowserTestUtils.removeTab(closed);
  AgentGate.answer(q.id, { kind: "once" });
  r = await c.response(id);
  Assert.equal(r.error?.reason, "changed", "a tab that closed is changed");
  Assert.equal(activeName(), "main", "the window stays on main");
  c.close();
  BrowserTestUtils.removeTab(moved);
  await mcp(false);
});

// D2 (M2): only an agent tab can be shown, refused before anything is asked; D7 (M20): 6 shows
// a minute per connection, counted when asked, the 7th `busy` and in :mcp log.
add_task(async function test_show_refuses_other_tabs_and_six_a_minute_is_the_most() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const own = await c.call("agent-show", { tab: idOf(gBrowser.selectedTab) });
  Assert.equal(own.error?.code, "invalid-args", "a tab of main is not the agent's");
  Assert.equal(AgentGate.waiting.length, 0, "and nothing was asked");

  // A no and a yes in turn: three noes in a row would mute the connection (vimma-mcp 18).
  for (let i = 0; i < 6; i++) {
    const id = c.request("agent-show", { tab: idOf(tab) });
    AgentGate.answer((await question()).id, { kind: i % 2 ? "once" : "deny" });
    Assert.equal((await c.response(id)).ok, !!(i % 2), `show ${i + 1} is asked and answered`);
    ww().switchTo({ id: mainId() });
  }
  const r = await c.call("agent-show", { tab: idOf(tab) });
  Assert.equal(r.error?.reason, "busy", "the 7th show in a minute is busy");
  Assert.equal(AgentGate.waiting.length, 0, "and is not asked");
  Assert.equal(AgentGate.log[0].outcome, "busy", "it is in :mcp log as busy");
  Assert.equal(activeName(), "main", "the window stays on main");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
