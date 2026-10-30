/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #643 (docs/specs/mcp-forms.md F4): an agent's open that ends on Firefox's error page
// says so, with the error's code from Vimma's fixed list, instead of a page it could not list;
// vimma_elements on that tab says the same. Port 9 is on Firefox's banned port list
// (netwerk/base/nsIOService.cpp, gBadPortList), so the load ends on about:neterror with
// e=deniedPortAccess without reaching the network.

"use strict";

/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { builtinHello, forgetAgentConnection, runAgentCommand } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/agent-commands.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);

const FAILING = "http://127.0.0.1:9/";

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const tabById = (/** @type {string} */ id) =>
  gBrowser.tabs.find((t) => String(t.linkedBrowser.browserId) === id);

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

add_task(async function setup() {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  registerCleanupFunction(async () => {
    for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
    Services.prefs.clearUserPref(MCP_ENABLED_PREF);
    await VimmaControl.settled();
  });
});

add_task(async function test_builtin_open_names_the_error_page() {
  const conn = "builtin:load-error-test";
  /** @type {any} */
  const state = {};
  builtinHello(conn, state, { client: "load error test" });
  AgentGate.grantConnection(conn);
  try {
    const r = await runAgentCommand(conn, state, "agent-open", { url: FAILING, elements: true });
    const tab = tabById(r.tab);
    Assert.ok(tab, "the tab stays open");
    Assert.ok(
      tab.linkedBrowser.documentURI.spec.startsWith("about:neterror?e=deniedPortAccess"),
      `the load ended on Firefox's error page: ${tab.linkedBrowser.documentURI.spec}`,
    );
    Assert.equal(r.unlisted, "error", `the open says the page did not load: ${JSON.stringify(r)}`);
    Assert.equal(r.loadError, "deniedPortAccess", "and names Firefox's error");
    Assert.equal(r.url, FAILING, "with the address it tried");

    // vimma_elements on the same tab: a refusal in the same words.
    await Assert.rejects(
      runAgentCommand(conn, state, "agent-elements", { tab: r.tab }),
      (/** @type {any} */ e) =>
        e.code === "failed" &&
        e.message ===
          "the page did not load: Firefox showed its error page, the address uses a port the " +
            "browser blocks (deniedPortAccess)",
      "vimma_elements says the page did not load",
    );
    BrowserTestUtils.removeTab(tab);
  } finally {
    AgentGate.disconnect(conn);
    forgetAgentConnection(conn);
  }
});

add_task(async function test_mcp_open_names_the_error_page() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "load-error-agent" }, via: "example" });
  const id = c.request("agent-open", { url: FAILING, elements: true });
  await until(() => AgentGate.waiting.length > 0, "the open asks");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "grant" });
  const r = await c.response(id);
  Assert.ok(r.result, `the open answers: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.unlisted, "error", JSON.stringify(r.result));
  Assert.equal(r.result.loadError, "deniedPortAccess");
  c.close();
  BrowserTestUtils.removeTab(tabById(r.result.tab));
});
