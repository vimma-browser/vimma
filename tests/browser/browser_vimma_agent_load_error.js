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
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { builtinHello, forgetAgentConnection, runAgentCommand } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/agent-commands.mjs",
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

const FAILING = "http://127.0.0.1:9/";

/** The agent workspace, with its container (containers are on in the browser tests). */
const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

/** The tab an open just named. */
const tabById = (/** @type {string} */ id) =>
  found(gBrowser.tabs.find((t) => String(t.linkedBrowser.browserId) === id));

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
  /** @type {Parameters<typeof builtinHello>[1]} */
  const state = {};
  builtinHello(conn, state, { client: "load error test" });
  AgentGate.grantConnection(conn);
  try {
    const r = await runAgentCommand(conn, state, "agent-open", { url: FAILING, elements: true });
    const tab = tabById(r.tab);
    Assert.ok(tab, "the tab stays open");
    // The page it shows: a loaded tab's browser has its document.
    const shown = found(tab.linkedBrowser.documentURI).spec;
    Assert.ok(
      shown.startsWith("about:neterror?e=deniedPortAccess"),
      `the load ended on Firefox's error page: ${shown}`,
    );
    // An open that listed its page, or names none, fails here, as the reads below would.
    if (!("unlisted" in r)) throw new Error(`the open lists a page: ${JSON.stringify(r)}`);
    Assert.equal(r.unlisted, "error", `the open says the page did not load: ${JSON.stringify(r)}`);
    Assert.equal(r.loadError, "deniedPortAccess", "and names Firefox's error");
    Assert.equal(r.url, FAILING, "with the address it tried");

    // vimma_elements on the same tab: a refusal in the same words.
    await Assert.rejects(
      runAgentCommand(conn, state, "agent-elements", { tab: r.tab }),
      (/** @type {{ code?: string, message?: string }} */ e) =>
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
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "grant", minutes: null });
  const r = await c.response(id);
  Assert.ok(r.result, `the open answers: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.unlisted, "error", JSON.stringify(r.result));
  Assert.equal(r.result.loadError, "deniedPortAccess");
  c.close();
  BrowserTestUtils.removeTab(tabById(r.result.tab));
});

// The top window global's document URI comes first; a window global that has none yet (its
// documentURI is nullable in WindowGlobalActors.webidl) leaves the browser's copy to say.
add_task(async function test_a_window_global_without_a_document_uri_falls_back() {
  const error = Services.io.newURI("about:neterror?e=deniedPortAccess&u=http%3A//127.0.0.1%3A9/");
  const standIn = (/** @type {nsIURI | null} */ wgUri) =>
    /** @type {MozBrowser} */ (
      /** @type {unknown} */ ({
        browsingContext: { currentWindowGlobal: { documentURI: wgUri } },
        documentURI: error,
      })
    );
  Assert.equal(AgentAct.loadError(standIn(null)), "deniedPortAccess", "the browser's URI says");
  const page = Services.io.newURI("https://example.com/");
  Assert.equal(AgentAct.loadError(standIn(page)), null, "the window global's URI comes first");
});
