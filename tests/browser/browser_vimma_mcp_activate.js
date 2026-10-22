/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 2: `vimma_activate` (`agent-activate`) clicks an element
// of an agent tab by its label from `vimma_elements`, in the background (F8; security.md M25).
// The click is the child's `click()`, never synthesised input, so the page gets no user
// activation (M26). Fields, selects, file fields, disabled controls and links to another site
// are refused before anything is asked (F9, F10; M29). The result says whether a page loaded
// and which dialog the page opened (F11); a tab the user is typing in is `in-use` (F27); at most
// 30 clicks a connection a minute, each in `:mcp log` (F26, F28; M32).

"use strict";

/* global focusContent -- from head.js */
/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentAct } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentAct.sys.mjs",
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

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const CLICK = `${DIR}file_vimma_agent_click.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const BASKET = `${DIR}file_vimma_agent_basket.html`;
const NOTICE_ID = "vimma-notice";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";

registerCleanupFunction(async () => {
  AgentAct._settleMs = null;
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  await VimmaControl.settled();
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
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
async function openAgentTab(url = CLICK) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  AgentAct._settleMs = 300;
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await mcp(false);
}

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/** The list's elements by what they say. @param {any} c @param {any} tab */
async function labels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_elements runs");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/**
 * `agent-activate` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {string} label @param {object | null} [answer]
 */
async function activate(c, tab, label, answer = { kind: "once" }) {
  const id = c.request("agent-activate", { tab: idOf(tab), label });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_activate", "agent-activate asks as vimma_activate");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-activate" });
    Assert.deepEqual(v.errors, [], "a valid agent-activate result");
  }
  return r;
}

/** @param {any} tab */
const seen = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    items: content.document.querySelectorAll("#list li").length,
    seen: JSON.parse(JSON.stringify(content.wrappedJSObject.seen ?? [])),
    focused: content.document.activeElement?.localName ?? "",
    gesture: content.document.hasValidTransientUserGestureActivation,
    title: content.document.title,
  }));

add_task(async function setup() {
  // The wait for a page a click may start: short here, so a test of many clicks stays quick.
  AgentAct._settleMs = 300;
});

addTidyTask(async function test_activate_clicks_a_button_in_a_background_tab() {
  await mcp(true);
  const tab = await openAgentTab();
  await focusContent(gBrowser.selectedBrowser);
  const before = { workspace: activeName(), selected: gBrowser.selectedTab };
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  const q = await question();
  Assert.deepEqual(
    [q.what.label, q.what.kind, q.what.text],
    [by["Add to list"], "button", "Add to list"],
    "the question names the element",
  );
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_activate runs");
  Assert.deepEqual(
    [r.result.url, r.result.title, r.result.navigated, r.result.loading],
    [CLICK, "Click agent fixture", false, false],
    "the page after the click, which loaded nothing",
  );
  await until(async () => (await seen(tab)).items === 1, "the button was clicked once");
  const page = await seen(tab);
  Assert.equal(page.seen[0].trusted, true, "the page saw a trusted click");
  Assert.notEqual(page.focused, "button", "the button was not focused (M25)");
  Assert.deepEqual(
    { workspace: activeName(), selected: gBrowser.selectedTab },
    before,
    "the window kept its workspace and tab (M25)",
  );
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  Assert.equal(AgentGate.log[0].tool, "vimma_activate", "a row in :mcp log (M32)");
  Assert.equal(
    AgentGate.log[0].detail,
    `${by["Add to list"]} button "Add to list"`,
    "naming the element",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_gives_the_page_no_user_activation() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by["Add to list"]);
  Assert.ok(r.ok, "the click ran");
  await until(async () => (await seen(tab)).seen[0]?.clipboard !== "pending", "the write settled");
  const page = await seen(tab);
  Assert.equal(page.seen[0].active, false, "no transient user activation in the handler (M26)");
  Assert.equal(page.seen[0].beenActive, false, "the page was never activated");
  Assert.equal(page.seen[0].clipboard, "refused", "so it cannot write the clipboard");
  Assert.equal(page.gesture, false, "the document has no valid transient activation");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_refuses_fields_files_disabled_and_other_sites() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const refusals = [
    [by.Field, `label "${by.Field}" is a field: use vimma_fill`],
    [by.Pick, `label "${by.Pick}" is a select: use vimma_fill`],
    [
      by.upload,
      `label "${by.upload}" is a file field; Vimma never clicks it: ask the user to choose the file`,
    ],
    [by.Off, `label "${by.Off}" is disabled`],
    [by["Other site"], "that link goes to another site: follow it with vimma_keys"],
  ];
  for (const [label, message] of refusals) {
    Assert.ok(label, `${message}: the element is listed`);
    const r = await c.call("agent-activate", { tab: idOf(tab), label });
    Assert.equal(r.error?.code, "failed", `${message}: refused`);
    Assert.equal(r.error?.message, message, "naming the label and the reason (M29)");
  }
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked");
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "nothing loaded");
  // A label from no list, and one the agent never got from vimma_elements.
  let r = await c.call("agent-activate", { tab: idOf(tab), label: "kkk" });
  Assert.equal(r.error?.message, 'no element has the label "kkk": call vimma_elements again');
  const keys = c.request("agent-keys", { tab: idOf(tab), keys: "f" });
  AgentGate.answer((await question()).id, { kind: "once" });
  await c.response(keys);
  r = await c.call("agent-activate", { tab: idOf(tab), label: by["Same site"] });
  Assert.equal(
    r.error?.message,
    "labels from f's link list are followed with vimma_keys: call vimma_elements to click",
    "a label of f's list is not clicked (F3)",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_never_follows_a_link_moved_elsewhere_or_an_svg_link() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // An SVG link to another site, around an element of its own.
  Assert.ok(by["Svg go"], "the element inside the SVG link is listed");
  let r = await c.call("agent-activate", { tab: idOf(tab), label: by["Svg go"] });
  Assert.equal(
    r.error?.message,
    "that link goes to another site: follow it with vimma_keys",
    "an SVG link to another site is refused (M29)",
  );
  // A same-site link that points elsewhere once the mouse is down on it.
  r = await activate(c, tab, by["Swap link"]);
  Assert.equal(
    r.error?.message,
    "the element changed as it was clicked; nothing was clicked",
    "the click does not follow a link moved after the question",
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "nothing loaded");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_follows_a_same_site_link_as_an_open() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by["Same site"]);
  Assert.ok(r.ok, "a same-site link is clicked");
  Assert.equal(r.result.navigated, true, "a page loaded");
  Assert.equal(r.result.url, `${PAGE}?clicked`, "the link's page");
  // Its labels are gone with the page.
  const again = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  Assert.equal(again.error?.message, "stale labels: call vimma_elements again");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_reports_a_dialog() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by.Remove);
  Assert.ok(r.ok, "the click ran");
  Assert.deepEqual(
    r.result.dialog,
    {
      type: "confirm",
      text: "<untrusted-web-content>\nRemove this item?\n</untrusted-web-content>",
    },
    "the dialog's type and its text, as untrusted content",
  );
  Assert.ok(tab.hidden, "the dialog waits in the hidden tab for the user");
  // The user answers it.
  const dialogs = gBrowser.getTabDialogBox(tab.linkedBrowser).getContentDialogManager().dialogs;
  Assert.equal(dialogs.length, 1, "one dialog in the tab");
  await dialogs[0]._dialogReady;
  dialogs[0]._frame.contentDocument.getElementById("commonDialog").cancelDialog();
  await until(
    async () =>
      (await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.answer)) ===
      false,
    "the user's answer reached the page",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// #510: a click that loads no page says which parts of it changed in place: the clicked element,
// the other listed elements, the page's text, a dialog of the page; or that nothing did. Fixed
// words only, never the page's text.
addTidyTask(async function test_activate_says_what_changed_in_place() {
  await mcp(true);
  // The real waits: a hidden tab's timers run at most once a second, as the agent's always do.
  AgentAct._settleMs = null;
  const tab = await openAgentTab(BASKET);
  const c = await agentClient();
  const by = await labels(c, tab);
  /** @param {string} text */
  const changedBy = async (text) => {
    Assert.ok(by[text], `"${text}" is listed`);
    const r = await activate(c, tab, by[text]);
    Assert.ok(r.ok, `"${text}" was clicked`);
    Assert.equal(r.result.navigated, false, `"${text}" loaded no page`);
    return r.result.changed;
  };
  Assert.deepEqual(
    await changedBy("Add to basket (0)"),
    ["element", "text"],
    "a button that counts itself and updates the total",
  );
  Assert.deepEqual(await changedBy("Lock"), ["elements"], "a button that disables another");
  Assert.deepEqual(await changedBy("Delivery"), ["dialog"], "a button that opens a dialog");
  Assert.deepEqual(await changedBy("Later"), ["text"], "a total updated a moment later");
  Assert.deepEqual(await changedBy("Nothing"), [], "a style sheet is no text the page shows");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_in_use_while_the_user_types() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("field").focus(),
  );
  await until(() => VimmaHost.status(window).mode === "insert", "the user is in insert mode");
  const r = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  Assert.equal(r.error?.reason, "in-use", "a tab the user types in is denied (F27)");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  Assert.equal((await seen(tab)).items, 0, "nothing was clicked");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_under_a_grant_notice_log_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  let r = await activate(c, tab, by["Add to list"], { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grants vimma_activate");
  r = await activate(c, tab, by.Menu, null);
  Assert.ok(r.ok, "the next click runs unasked");
  await until(
    () =>
      noticeText().startsWith('claude-code clicked button "Menu" in "Click agent fixture" (grant'),
    "with a notice naming the element and the page",
  );
  Assert.equal(AgentGate.log[0].outcome, "grant", "and a row in :mcp log (M32)");
  // 30 a minute, counted when asked (F26): 2 so far.
  let busy = null;
  for (let i = 0; i < 29 && !busy; i++) {
    const x = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 28, "the 31st click in a minute is refused");
  Assert.equal(busy?.x.error.reason, "busy", "as busy");
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
