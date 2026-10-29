/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-drive.md, sub-PR 2: `agent-keys` (`vimma_keys`) runs Vimma's own page keys
// in an agent tab, in the background, through a fixed whitelist (D8-D11; security.md M16, M17):
// the window keeps its workspace, tab, focus, mode and find bar; keys never reach the page as key
// events; a tab the user is typing in is `in-use` (D13); the call stops when the tab leaves the
// agent workspace (D13); under a grant each call shows a notice, and 30 a minute is the most
// (D14, D15; M20, M23).

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
const { AgentDrive } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentDrive.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const LONG = `${DIR}file_vimma_agent_long.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const NOTICE_ID = "vimma-notice";

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  AgentDrive._onStep = null;
  await VimmaControl.settled();
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  // A workspace a move left empty got its home tab.
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => WindowWorkspaces.get(window);
const activeName = () => ww().model.workspaces.find((w) => w.id === ww().model.active)?.name;
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = LONG) {
  const tab = gBrowser.addTab(url, {
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
  // As vimma-ctl of this Vimma's version says it in its hello: a rate refusal's retryAfter
  // goes only to a client that new (issue #592).
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs",
  );
  await c.call("agent-hello", { client: { name }, ctl: AppConstants.MOZ_APP_VERSION_DISPLAY });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/**
 * `agent-keys` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {string} keys @param {object | null} [answer]
 */
async function keys(c, tab, keys, answer = { kind: "once" }) {
  const id = c.request("agent-keys", { tab: idOf(tab), keys });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_keys", "agent-keys asks as vimma_keys");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-keys" });
    Assert.deepEqual(v.errors, [], `${keys}: a valid agent-keys result`);
  }
  return r;
}

/** The agent tab's page: scroll position, selection, keys its listeners saw. */
function pageOf(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    y: content.scrollY,
    max: content.scrollMaxY,
    selection: String(content.getSelection()),
    keysSeen: content.wrappedJSObject.keysSeen,
    active: content.document.activeElement?.localName ?? null,
  }));
}

/** What the user's window looks like, for "nothing changed" (M17). */
function windowState() {
  return {
    workspace: activeName(),
    selected: gBrowser.selectedTab,
    focused: Services.focus.focusedElement,
    mode: VimmaHost.status(window).mode,
    pending: VimmaHost.status(window).pending.join(" "),
  };
}

add_task(async function test_keys_scroll_a_background_tab_without_touching_the_window() {
  await mcp(true);
  const tab = await openAgentTab();
  await focusContent(gBrowser.selectedBrowser);
  const before = windowState();
  const c = await agentClient();

  const id = c.request("agent-keys", { tab: idOf(tab), keys: "3j" });
  const q = await question();
  Assert.equal(q.what.keys, "3j", "the question shows the keys as they will run");
  Assert.equal(q.what.title, "Long agent fixture", "and the tab");
  AgentGate.answer(q.id, { kind: "once" });
  let r = await c.response(id);
  Assert.ok(r.ok, "3j runs");
  Assert.deepEqual(
    r.result.steps,
    [{ keys: "3j", action: "scroll.down", ok: true }],
    "one step, scroll.down with its count",
  );
  Assert.equal(r.result.url, LONG, "the result names the page");
  Assert.equal(r.result.title, "Long agent fixture", "and its title");
  Assert.equal(r.result.loading, false, "loaded");
  let page = await pageOf(tab);
  Assert.greater(page.y, 0, "the hidden agent tab scrolled, at once (no smooth scroll)");
  Assert.ok(
    Math.abs(r.result.scroll.y - page.y / page.max) < 0.01,
    "scroll.y is the page's position as a fraction",
  );

  r = await keys(c, tab, "G");
  Assert.greater(r.result.scroll.y, 0.99, "G goes to the bottom");
  r = await keys(c, tab, "gg");
  Assert.equal(r.result.scroll.y, 0, "gg to the top");
  r = await keys(c, tab, "<C-d> d");
  page = await pageOf(tab);
  Assert.greater(page.y, 0, "half pages down");
  Assert.equal(r.result.steps.length, 2, "two steps");

  page = await pageOf(tab);
  Assert.equal(page.keysSeen, 0, "the page never saw a key event (M16)");
  Assert.equal(page.active, "body", "and no field took focus");
  Assert.deepEqual(windowState(), before, "the window kept its workspace, tab, focus and mode");
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_find_uses_the_tabs_finder() {
  await mcp(true);
  const tab = await openAgentTab();
  // The user's own search, in the window's find bar of their tab.
  const findbar = await gBrowser.getFindBar(gBrowser.selectedTab);
  findbar.open();
  findbar._findField.value = "user query";
  const c = await agentClient();

  let r = await keys(c, tab, "/pricing<CR>");
  Assert.deepEqual(
    r.result.find,
    { query: "pricing", found: true, wrapped: false },
    "the find found the word",
  );
  Assert.deepEqual(r.result.steps[0], {
    keys: '/"pricing"⏎',
    action: "find.forward",
    ok: true,
  });
  let page = await pageOf(tab);
  Assert.equal(page.selection, "pricing", "the match is the agent tab's selection");
  Assert.greater(page.y, 0, "and scrolled into view in the hidden tab");

  r = await keys(c, tab, "/nowhere at all<CR>");
  Assert.equal(r.result.find.found, false, "a word not on the page is not found");
  Assert.equal(r.result.steps[0].ok, false, "and its step says so");

  r = await keys(c, tab, "/Plans<CR>n");
  Assert.equal(r.result.steps[1].action, "find.next", "n is the call's last query again");
  Assert.equal(r.result.find.query, "Plans", "with that query");
  Assert.equal(r.result.find.found, true, "found");
  Assert.equal(r.result.find.wrapped, true, "wrapping around, as there is one match");

  Assert.equal(findbar._findField.value, "user query", "the user's find bar kept its query");
  Assert.ok(!findbar.hidden, "and stayed open");
  page = await pageOf(tab);
  Assert.equal(page.keysSeen, 0, "the page saw no key events");
  findbar.close(true);
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_back_and_forward_stay_in_the_tab() {
  await mcp(true);
  const tab = await openAgentTab(`${PAGE}?a`);
  const b = `${PAGE}?b`;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, b);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, b);
  const before = windowState();
  const c = await agentClient();

  let r = await keys(c, tab, "H");
  Assert.equal(r.result.url, `${PAGE}?a`, "H goes back in the tab's own history");
  Assert.equal(r.result.loading, false, "and waits for the page");
  r = await keys(c, tab, "L");
  Assert.equal(r.result.url, b, "L goes forward");
  r = await keys(c, tab, "gu");
  Assert.equal(r.result.url, DIR, "gu goes a level up, in the same tab");
  r = await keys(c, tab, "H");
  Assert.equal(r.result.url, b, "back again");
  r = await keys(c, tab, "L L");
  Assert.equal(r.result.steps[1].ok, false, "a forward with nowhere to go is not ok");
  Assert.ok(r.result.steps[1].note, "and says why");
  Assert.deepEqual(windowState(), before, "the window did not change");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_refuses_a_non_agent_tab() {
  await mcp(true);
  const tab = await openAgentTab();
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?mine`);
  const c = await agentClient();
  let r = await c.call("agent-keys", { tab: idOf(mine), keys: "j" });
  Assert.equal(r.error?.code, "invalid-args", "a tab of another workspace is unknown (M2)");
  r = await c.call("agent-keys", { tab: idOf(tab), keys: "3j t" });
  Assert.equal(r.error?.code, "invalid-args", "a refused key is invalid-args");
  Assert.ok(r.error.message.includes('key "t"'), "naming the key");
  r = await c.call("agent-keys", { tab: idOf(tab), keys: "j".repeat(33) });
  Assert.equal(r.error?.code, "invalid-args", "33 actions are refused (M20)");
  Assert.equal(AgentGate.waiting.length, 0, "and nothing was asked");
  Assert.equal((await pageOf(tab)).y, 0, "nothing ran");
  c.close();
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_in_use_while_the_user_types_in_the_tab() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // The user looks at the agent tab and types in its field.
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("field").focus(),
  );
  await until(() => VimmaHost.status(window).mode === "insert", "the user is in insert mode");

  let r = await c.call("agent-keys", { tab: idOf(tab), keys: "j" });
  Assert.equal(r.error?.code, "denied", "a tab the user types in is denied");
  Assert.equal(r.error?.reason, "in-use", "as in-use");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");

  // Back in normal mode, watching is fine: the agent scrolls under the user's eyes.
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  r = await keys(c, tab, "j");
  Assert.ok(r.ok, "in normal mode the call runs");
  Assert.notEqual((await pageOf(tab)).active, "input", "and never focuses a field");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_stop_when_the_tab_leaves() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // After the first step the tab leaves the agent workspace.
  AgentDrive._onStep = (/** @type {number} */ n) => {
    if (n === 1) ww().moveTab(tab, { id: mainId() });
  };
  const r = await keys(c, tab, "j j j");
  AgentDrive._onStep = null;
  Assert.equal(r.result.stopped, "changed", "the call stops with changed");
  Assert.equal(r.result.steps.length, 1, "after the step done");
  // The move reopened it in main and closed this one.
  for (const t of gBrowser.tabs.filter((t) => t.linkedBrowser.currentURI.spec === LONG)) {
    BrowserTestUtils.removeTab(t);
  }

  const gone = await openAgentTab();
  const id = c.request("agent-keys", { tab: idOf(gone), keys: "j" });
  const q = await question();
  BrowserTestUtils.removeTab(gone);
  AgentGate.answer(q.id, { kind: "once" });
  const after = await c.response(id);
  Assert.equal(after.error?.reason, "changed", "a tab closed while asked: changed, nothing ran");
  c.close();
  await mcp(false);
});

add_task(async function test_keys_under_a_grant_notice_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  let r = await keys(c, tab, "j", { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "15a grants vimma_keys");
  r = await keys(c, tab, "2j", null);
  Assert.ok(r.ok, "the next call runs unasked");
  await until(
    () => noticeText().startsWith('claude-code pressed 2j in "Long agent fixture" (grant,'),
    "with a notice naming the keys and the tab",
  );
  // The grant covers reads too (mcp-grants G1).
  Assert.ok((await c.call("agent-read", { tab: idOf(tab) })).ok, "a read runs under it");
  // 30 a minute, counted when asked (M20): 2 so far.
  let busy = null;
  for (let i = 0; i < 29 && !busy; i++) {
    const x = await c.call("agent-keys", { tab: idOf(tab), keys: "k" });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 28, "the 31st call in a minute is refused");
  Assert.equal(busy?.x.error.reason, "busy", "as busy");
  // Issue #592: it names the limit and when the next call is allowed.
  Assert.equal(
    busy?.x.error.message,
    "too many vimma_keys calls from this agent in the last minute (at most 30)",
    "naming the limit it hit",
  );
  const wait = busy?.x.error.retryAfter;
  Assert.ok(wait >= 1 && wait <= 60_000, `and the wait for the next call: ${wait} ms`);
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_keys_stop_when_the_user_starts_using_the_tab() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // After the first step the user switches to the tab and types in its field.
  AgentDrive._onStep = async (/** @type {number} */ n) => {
    if (n !== 1) return;
    ww().switchTo({ id: agent().id });
    await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
    await focusContent(tab.linkedBrowser);
    await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      content.document.getElementById("field").focus(),
    );
    await until(() => VimmaHost.status(window).mode === "insert", "the user types there");
  };
  const r = await keys(c, tab, "j j j");
  AgentDrive._onStep = null;
  Assert.equal(r.result.stopped, "in-use", "the call stops with in-use");
  Assert.equal(r.result.steps.length, 1, "after the step done");
  EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_a_find_never_focuses_a_field_of_the_tab_the_user_is_in() {
  await mcp(true);
  const tab = await openAgentTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const field = content.document.getElementById("field");
    field.value = "a pricing field";
    content.wrappedJSObject.focused = 0;
    field.addEventListener("focus", () => content.wrappedJSObject.focused++);
  });
  const c = await agentClient();
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the user watches in normal mode");
  const r = await keys(c, tab, "/field<CR>");
  Assert.equal(r.result.steps[0].ok, false, "a find in the tab the user is in does not run");
  Assert.ok(r.result.steps[0].note.includes("focus"), "and says why");
  const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    focused: content.wrappedJSObject.focused,
    active: content.document.activeElement?.localName,
  }));
  Assert.deepEqual(seen, { focused: 0, active: "body" }, "the field never had focus (M16)");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_loads_count_towards_the_open_rate() {
  await mcp(true);
  const tab = await openAgentTab(`${PAGE}?a`);
  const b = `${PAGE}?b`;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, b);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, b);
  const c = await agentClient();
  // Ten opens, the most a minute (M3), under a grant.
  let id = c.request("agent-open", { url: `${PAGE}?1`, tab: idOf(tab) });
  AgentGate.answer((await question()).id, { kind: "grant", minutes: 5 });
  await c.response(id);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?1`);
  for (let i = 2; i <= 10; i++) {
    Assert.ok((await c.call("agent-open", { url: `${PAGE}?x${i}` })).ok, `open ${i}`);
  }
  // The open's grant covers keys too (mcp-grants G1).
  let r = await keys(c, tab, "gu", null);
  Assert.equal(r.result.stopped, "denied", "gu needs a slot of the open rate (M20)");
  Assert.equal(r.result.url, `${PAGE}?1`, "and loads nothing");
  r = await keys(c, tab, "H", null);
  Assert.equal(r.result.stopped, "denied", "so does a history load");
  Assert.equal(r.result.url, `${PAGE}?1`, "which does not run");
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await mcp(false);
});
