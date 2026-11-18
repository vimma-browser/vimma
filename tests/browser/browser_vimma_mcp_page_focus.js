/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-drive.md D13, issue #1325. A tab the user is using is `in-use` to an
// agent, and insert mode in a shown agent tab counts as using it only when the user's own input
// put it there: a field the page focused by itself (a dialog with autofocus that the agent's own
// click opened) does not, so the agent can fill it. The user's real keys and clicks always win:
// a key or click of theirs in that field, or one shortly before the page focused it, makes the
// tab theirs again (security.md M17, M25).

"use strict";

/* global focusContent -- from head.js */
/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
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

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const DIALOG = `${DIR}file_vimma_agent_dialog.html`;

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const mainId = () =>
  /** @type {string} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.name === "main")?.id
  );

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** The connections the running task opened. @type {Client[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  if (VimmaHost.status(window).mode === "insert") EventUtils.synthesizeKey("KEY_Escape");
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await mcp(false);
}

registerCleanupFunction(async () => {
  await putBack();
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
});

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/**
 * The dialog fixture in an agent tab, shown to the user as vimma_show shows it (the window on
 * the agent workspace, the page focused), and an agent with a grant, so nothing is asked.
 */
async function shownAgentTab() {
  await mcp(true);
  const tab = gBrowser.addTab(DIALOG, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, DIALOG);
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "claude-code" } });
  const id = c.request("agent-elements", { tab: idOf(tab), full: true });
  await until(() => AgentGate.waiting.length > 0, "the first call asks");
  AgentGate.answer(/** @type {AskedQuestion} */ (AgentGate.waiting[0]).id, {
    kind: "grant",
    minutes: 12,
  });
  Assert.ok((await c.response(id)).ok, "vimma_elements runs, and the grant is given");
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost._browserMode(tab.linkedBrowser) === "normal", "in normal mode");
  return { tab, c };
}

/** The list's elements by what they say. @param {Client} c @param {MozTabbrowserTab} tab */
async function labels(c, tab) {
  const r = await c.call("agent-elements", { tab: idOf(tab), full: true });
  Assert.ok(r.ok, "vimma_elements runs under the grant");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/** @param {MozTabbrowserTab} tab */
const dialog = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const d = content.document;
    return {
      open: /** @type {HTMLDialogElement} */ (d.getElementById("dialog")).open,
      focused: d.activeElement?.id ?? "",
      name: /** @type {HTMLInputElement} */ (d.getElementById("name")).value,
    };
  });

/** The agent's click on New channel opens the dialog, whose field takes focus by itself. */
async function agentOpensTheDialog(/** @type {Client} */ c, /** @type {MozTabbrowserTab} */ tab) {
  const by = await labels(c, tab);
  const r = await c.call("agent-activate", { tab: idOf(tab), label: by["New channel"] });
  Assert.ok(r.ok, `the agent's click runs: ${JSON.stringify(r.error ?? null)}`);
  Assert.equal(r.result.stopped, undefined, "and is not stopped as the user's");
  await until(async () => (await dialog(tab)).focused === "name", "the dialog's field has focus");
  await until(
    () => VimmaHost._browserMode(tab.linkedBrowser) === "insert",
    "the page's focus put the tab in insert",
  );
}

/** vimma_fill of the dialog's field. @param {Client} c @param {MozTabbrowserTab} tab */
async function fillName(c, tab) {
  const by = await labels(c, tab);
  Assert.ok(by["Channel name"], "the dialog's field is in the list");
  return c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by["Channel name"], value: "general" }],
  });
}

addTidyTask(async function test_a_field_the_page_focuses_after_the_agents_click_is_not_the_users() {
  const { tab, c } = await shownAgentTab();
  await agentOpensTheDialog(c, tab);
  Assert.ok(!VimmaHost.inUse(tab.linkedBrowser), "the page's own focus is not the user's");
  const r = await fillName(c, tab);
  Assert.ok(r.ok, `the agent fills the field: ${JSON.stringify(r.error ?? null)}`);
  Assert.equal((await dialog(tab)).name, "general", "with its value");
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked under the grant");
});

addTidyTask(async function test_the_users_key_in_that_field_makes_the_tab_theirs() {
  const { tab, c } = await shownAgentTab();
  await agentOpensTheDialog(c, tab);
  EventUtils.sendString("a");
  await until(async () => (await dialog(tab)).name === "a", "the user typed in the field");
  Assert.ok(VimmaHost.inUse(tab.linkedBrowser), "the user's typing makes the tab in use");
  const r = await fillName(c, tab);
  Assert.equal(r.error?.reason, "in-use", "the agent's fill is denied (F27)");
  Assert.equal((await dialog(tab)).name, "a", "and fills nothing");
  const by = await labels(c, tab);
  const a = await c.call("agent-activate", { tab: idOf(tab), label: by.Create });
  Assert.equal(a.error?.reason, "in-use", "as is its click");
  Assert.ok((await dialog(tab)).open, "the dialog stays open");
});

addTidyTask(async function test_the_users_click_in_that_field_makes_the_tab_theirs() {
  const { tab, c } = await shownAgentTab();
  await agentOpensTheDialog(c, tab);
  await BrowserTestUtils.synthesizeMouseAtCenter("#name", {}, tab.linkedBrowser);
  await until(() => VimmaHost.inUse(tab.linkedBrowser), "the user's click makes the tab in use");
  const r = await fillName(c, tab);
  Assert.equal(r.error?.reason, "in-use", "the agent's fill is denied (F27)");
  Assert.equal((await dialog(tab)).name, "", "and fills nothing");
});

addTidyTask(async function test_a_page_focus_just_after_the_users_click_is_theirs() {
  const { tab, c } = await shownAgentTab();
  // The user's own click on a button that opens the dialog a moment later, as a page waiting
  // on its server does: the focus comes from no input handler, yet the dialog is the user's.
  await BrowserTestUtils.synthesizeMouseAtCenter("#later", {}, tab.linkedBrowser);
  await until(async () => (await dialog(tab)).focused === "name", "the dialog's field has focus");
  await until(() => VimmaHost._browserMode(tab.linkedBrowser) === "insert", "the tab is in insert");
  Assert.ok(VimmaHost.inUse(tab.linkedBrowser), "the tab is the user's");
  const r = await fillName(c, tab);
  Assert.equal(r.error?.reason, "in-use", "the agent's fill is denied (F27)");
  Assert.equal((await dialog(tab)).name, "", "and fills nothing");
});

addTidyTask(async function test_a_page_focus_just_after_the_users_key_is_theirs() {
  const { tab, c } = await shownAgentTab();
  // The page's own shortcut, a key Vimma leaves to the page: its dialog opens a moment later.
  EventUtils.synthesizeKey("q");
  await until(async () => (await dialog(tab)).focused === "name", "the dialog's field has focus");
  await until(() => VimmaHost._browserMode(tab.linkedBrowser) === "insert", "the tab is in insert");
  Assert.ok(VimmaHost.inUse(tab.linkedBrowser), "the tab is the user's");
  const r = await fillName(c, tab);
  Assert.equal(r.error?.reason, "in-use", "the agent's fill is denied (F27)");
  Assert.equal((await dialog(tab)).name, "", "and fills nothing");
});

addTidyTask(async function test_a_page_focus_just_after_the_users_hint_click_is_theirs() {
  const { tab, c } = await shownAgentTab();
  // The user's own click through a hint (f and a label: keys Vimma keeps from the page) on the
  // button that opens the dialog a moment later.
  const browser = tab.linkedBrowser;
  EventUtils.synthesizeKey("f");
  await until(() => VimmaHost._hints(window)?.hints.length, "hints are collected");
  const at = await SpecialPowers.spawn(browser, [], () => {
    const r = /** @type {Element} */ (
      content.document.getElementById("later")
    ).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const label = /** @type {HostHints} */ (VimmaHost._hints(window)).hints.find(
    ({ target: { rect: r } }) =>
      at.x >= r.x && at.x <= r.x + r.width && at.y >= r.y && at.y <= r.y + r.height,
  )?.label;
  Assert.ok(label, "the button has a label");
  for (const k of /** @type {string} */ (label)) EventUtils.synthesizeKey(k);
  await until(async () => (await dialog(tab)).focused === "name", "the dialog's field has focus");
  await until(() => VimmaHost._browserMode(browser) === "insert", "the tab is in insert");
  Assert.ok(VimmaHost.inUse(browser), "the tab is the user's");
  const r = await fillName(c, tab);
  Assert.equal(r.error?.reason, "in-use", "the agent's fill is denied (F27)");
  Assert.equal((await dialog(tab)).name, "", "and fills nothing");
});

addTidyTask(async function test_vimmas_own_key_before_a_page_focus_is_not_the_users() {
  const { tab, c } = await shownAgentTab();
  // The user watches the agent and scrolls with Vimma's j, which the page never gets; then the
  // page's script focuses a field by itself.
  EventUtils.synthesizeKey("j");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    /** @type {HTMLDialogElement} */ (content.document.getElementById("dialog")).showModal(),
  );
  await until(() => VimmaHost._browserMode(tab.linkedBrowser) === "insert", "the tab is in insert");
  Assert.ok(!VimmaHost.inUse(tab.linkedBrowser), "watching is not using the tab");
  const r = await fillName(c, tab);
  Assert.ok(r.ok, `the agent fills the field: ${JSON.stringify(r.error ?? null)}`);
  Assert.equal((await dialog(tab)).name, "general", "with its value");
});
