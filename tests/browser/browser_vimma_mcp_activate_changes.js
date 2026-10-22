/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #510: a `vimma_activate` click that loads no page says which parts of the page changed
// in place (docs/specs/mcp-forms.md F11; security.md M26): the clicked element, the other listed
// elements, the frame's text outside scripts and styles, a dialog of the page; or that nothing
// did. Fixed words only, never the page's text. A file of its own: its clicks use the real
// waits, which would push browser_vimma_mcp_activate.js past the harness's time limit.

"use strict";

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
const BASKET = `${DIR}file_vimma_agent_basket.html`;

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => WindowWorkspaces.get(window);
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  AgentAct._settleMs = null;
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
}

registerCleanupFunction(putBack);

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = BASKET) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** An agent connection, after its agent-hello. */
async function agentClient() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
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

/** `agent-activate` on `tab`, answered once. @param {any} c @param {any} tab @param {string} label */
async function activate(c, tab, label) {
  const id = c.request("agent-activate", { tab: idOf(tab), label });
  AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-activate" });
    Assert.deepEqual(v.errors, [], "a valid agent-activate result");
  }
  return r;
}

addTidyTask(async function test_activate_says_what_changed_in_place() {
  await mcp(true);
  // The real waits: a hidden tab's timers run at most once a second, as the agent's always do.
  AgentAct._settleMs = null;
  const tab = await openAgentTab();
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
});
