/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-drive.md D14 (security.md M23): `:mcp log` lists the last 100 agent calls of
// every tool, asked or under a grant, with the time, the client, the tool, the tab's title, the
// keys or URL and what came of it. In memory only; `:mcp off` clears it.

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

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const LOG_ID = "vimma-mcp-log";

registerCleanupFunction(async () => {
  if (logPicker()?.open) EventUtils.synthesizeKey("KEY_Escape");
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const logPicker = () => /** @type {any} */ (document.getElementById(LOG_ID));
/** Each row's cells, joined as `:mcp log`'s one-line form: time, what was called, outcome. */
const rows = () =>
  [...(logPicker()?.querySelectorAll("[role=option]") ?? [])].map((r) =>
    [...r.children]
      .map((c) => c.textContent)
      .join(" · ")
      .replace(" · ", " ")
      // Without the bidi isolates around agent- and page-chosen text.
      .replace(/[\u2068\u2069]/g, ""),
  );
const emptyRow = () => logPicker()?.querySelector(".vimma-picker-empty")?.textContent ?? null;

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** `:line` Enter, from the selected page in normal mode. */
async function runCommand(line) {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

async function answer(kind, extra = {}) {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  AgentGate.answer(AgentGate.waiting[0].id, { kind, ...extra });
}

add_task(async function test_mcp_log_lists_asked_and_granted_calls() {
  await mcp(true);
  const tab = gBrowser.addTab(PAGE, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "claude-code" } });

  let id = c.request("agent-read", { tab: idOf(tab) });
  await answer("once");
  await c.response(id);
  id = c.request("agent-keys", { tab: idOf(tab), keys: "3j" });
  await answer("deny");
  await c.response(id);
  // A tab that closed after the question: allowed, then denied outside the gate (M23).
  const gone = gBrowser.addTab(PAGE, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(gone.linkedBrowser, false, PAGE);
  id = c.request("agent-keys", { tab: idOf(gone), keys: "k" });
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  BrowserTestUtils.removeTab(gone);
  await answer("once");
  Assert.equal((await c.response(id)).error?.reason, "changed", "denied as changed");
  id = c.request("agent-keys", { tab: idOf(tab), keys: "j" });
  await answer("grant", { minutes: 5 });
  await c.response(id);
  Assert.ok((await c.call("agent-keys", { tab: idOf(tab), keys: "gg" })).ok, "granted, unasked");

  await runCommand("mcp log");
  await until(() => logPicker()?.open, ":mcp log opens the log");
  const all = rows();
  Assert.equal(all.length, 6, "the four calls, and the closed tab's yes and denial");
  Assert.ok(all[2].endsWith("denied (the tab changed)"), "the denial after the yes is listed");
  Assert.ok(all[3].endsWith("allowed"), "after its yes");
  const shown = [all[0], all[1], all[4], all[5]];
  Assert.ok(shown[0].includes("claude-code vimma_keys"), "newest first: the client and tool");
  Assert.ok(shown[0].includes('"Agent fixture"'), "the tab's title");
  Assert.ok(shown[0].includes("gg"), "the keys");
  Assert.ok(shown[0].endsWith("ran under a grant"), "and that it ran under a grant");
  Assert.ok(shown[1].endsWith("allowed"), "a 15a's own call was allowed");
  Assert.ok(shown[2].includes("3j") && shown[2].endsWith("denied"), "a no is listed too");
  Assert.ok(shown[3].includes("vimma_read_page") && shown[3].endsWith("allowed"), "and the read");
  Assert.ok(/^\d\d:\d\d:\d\d /.test(shown[0]), "each row starts with the time");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !logPicker().open, "Esc closes it");

  c.close();
  await mcp(false);
  await mcp(true);
  await runCommand("mcp log");
  await until(() => logPicker()?.open, ":mcp log opens again");
  Assert.deepEqual(rows(), [], ":mcp off cleared the log");
  Assert.ok(emptyRow()?.includes("No agent calls"), "the empty log says so");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !logPicker().open, "closed");
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
