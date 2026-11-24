/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-sleep.md, Behaviour 2 and 7, decision 8: the agent workspace's tabs stay
// loaded while an agent is connected, because agents name tabs by a browser id that a woken
// tab no longer has; with no agent connected they sleep, and the next agent's listing wakes them
// with new ids (vimma-mcp B2).

"use strict";

/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { TabSleep } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/TabSleep.sys.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
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
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const HOUR = 60 * 60_000;
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);
/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const check = () => TabSleep._check(Date.now() + 3 * HOUR);

/** @type {MozTabbrowserTab[]} */
const opened = [];
/** The agent tab's id while the first agent knew it. */
let firstId = "";

registerCleanupFunction(async () => {
  for (const t of opened) if (!t.closing && t.parentNode) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
});

/** A tab in the agent workspace, loaded, hidden while the window shows another workspace. */
async function openAgentTab() {
  const tab = gBrowser.addTab(PAGE, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  opened.push(tab);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** An agent connection, after its agent-hello. */
async function agentClient() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", {
    client: { name: "example-agent" },
    via: "example",
    ctl: AppConstants.MOZ_APP_VERSION_DISPLAY,
  });
  await until(() => AgentGate.connections.length === 1, "the agent is connected");
  return c;
}

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.tabSleep", true]] });
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
});

add_task(async function agent_tabs_stay_loaded_while_an_agent_is_connected_and_sleep_after() {
  const tab = await openAgentTab();
  const user = /** @type {MozTabbrowserTab} */ (BrowserTestUtils.addTab(gBrowser, PAGE));
  opened.push(user);
  await BrowserTestUtils.browserLoaded(user.linkedBrowser, false, PAGE);
  const c = await agentClient();
  const id = idOf(tab);
  firstId = id;
  const slept = await check();
  Assert.ok(slept.includes(user), "a user tab sleeps");
  Assert.ok(!slept.includes(tab) && tab.linkedPanel, "the agent's tab stays loaded");
  Assert.equal(idOf(tab), id, "under the id the agent knows");
  c.close();
  await until(() => AgentGate.connections.length === 0, "the agent has left");
  Assert.ok((await check()).includes(tab), "with no agent connected, it sleeps");
  Assert.ok(!tab.linkedPanel, "it is discarded");
});

add_task(async function an_agent_listing_a_sleeping_agent_tab_wakes_it_with_a_new_id() {
  const tab = /** @type {MozTabbrowserTab} */ (opened[0]);
  Assert.ok(!tab.linkedPanel, "the agent tab the last task put to sleep");
  const c = await agentClient();
  const id = c.request("agent-tabs");
  await until(() => AgentGate.waiting.length > 0, "the listing asks");
  AgentGate.answer(/** @type {AskedQuestion} */ (AgentGate.waiting[0]).id, { kind: "once" });
  const listed = (await c.response(id)).result.tabs;
  Assert.equal(listed.length, 1, "the sleeping tab is listed");
  Assert.ok(tab.linkedPanel, "listing it gave it a browser");
  Assert.equal(listed[0].id, idOf(tab), "under the id its new browser has");
  Assert.notEqual(listed[0].id, firstId, "a new id, not the one the first agent knew");
  c.close();
  await until(() => AgentGate.connections.length === 0, "the agent has left");
});

// The check reads the connections before it flushes each tab; an agent that connects during a
// flush may be handed the tab's id at once, so the discard after it looks again.
add_task(async function an_agent_connecting_during_a_check_keeps_its_tabs_loaded() {
  for (const t of opened.splice(0)) if (!t.closing && t.parentNode) BrowserTestUtils.removeTab(t);
  const tab = await openAgentTab();
  Assert.equal(AgentGate.connections.length, 0, "no agent is connected when the check starts");
  const checking = check();
  // _check runs up to its first flush synchronously: the plan already put the tab to sleep.
  AgentGate.connect("tab-sleep-test", { client: "example-agent" });
  const slept = await checking;
  Assert.ok(!slept.includes(tab) && tab.linkedPanel, "the agent's tab stays loaded");
  AgentGate.disconnect("tab-sleep-test");
});
