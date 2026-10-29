/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #640 (docs/specs/vimma-mcp.md decision 30; security.md M10): a page sent with a
// Cross-Origin-Opener-Policy loads in an agent tab, opened by the built-in agent or by an MCP
// agent, in a new tab or in place of another page, and still opens no pop-up. Firefox turns
// a top-level load whose browsing context has sandbox flags and whose response has an opener
// policy into NS_ERROR_DOM_COOP_FAILED (HttpBaseChannel::ComputeCrossOriginOpenerPolicyMismatch).

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

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const COOP = `${DIR}file_vimma_agent_coop.sjs`;
const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;

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

/** What the tab shows once it has loaded `url`: its document's URI and title, and whether window.open opened anything. */
async function shown(tab, url) {
  await until(
    () =>
      !tab.hasAttribute("busy") &&
      tab.linkedBrowser.currentURI.spec === url &&
      !tab.linkedBrowser.browsingContext.currentWindowGlobal?.isInitialDocument,
    `the tab is done loading ${url}`,
  );
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    // From the page's own script: the sandbox flags are the page's, not SpecialPowers'.
    const script = doc.createElement("script");
    script.textContent =
      "try { document.body.dataset.popup = String(!!window.open('about:blank')) } catch (e) { document.body.dataset.popup = 'threw' }";
    doc.body?.append(script);
    return {
      uri: doc.documentURI,
      title: doc.title,
      popup: doc.body?.dataset.popup ?? "no body",
    };
  });
}

/** @param {any} tab @param {string} policy @param {string} [url] */
async function assertLoaded(tab, policy, url = `${COOP}?${policy.split(",")[0]}`) {
  const page = await shown(tab, url);
  Assert.ok(!page.uri.startsWith("about:neterror"), `${policy}: no network error (${page.uri})`);
  Assert.equal(page.title, "COOP page", `${policy}: the page loaded`);
  Assert.notEqual(page.popup, "true", `${policy}: the page still opens no pop-up`);
  Assert.ok(
    tab.linkedBrowser.browsingContext.sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION,
    `${policy}: the tab stays sandboxed against pop-ups`,
  );
}

add_task(async function test_builtin_agent_opens_coop_pages() {
  const conn = "builtin:coop-test";
  /** @type {any} */
  const state = {};
  builtinHello(conn, state, { client: "COOP test" });
  AgentGate.grantConnection(conn);
  try {
    for (const policy of ["same-origin", "same-origin-allow-popups"]) {
      const r = await runAgentCommand(conn, state, "agent-open", {
        url: `${COOP}?${policy}`,
        elements: true,
      });
      const tab = tabById(r.tab);
      Assert.ok(tab, `${policy}: the tab exists`);
      await assertLoaded(tab, policy);
      // A list of the page, not of an error page: a label listed by an earlier open of this
      // connection comes back as `repeated` (issue #621).
      Assert.equal(r.title, "COOP page", `${policy}: the open names the page`);
      Assert.ok(!("unlisted" in r), `${policy}: and lists it: ${JSON.stringify(r)}`);
      BrowserTestUtils.removeTab(tab);
    }

    // A cacheable page, twice: the second load comes from the agent container's HTTP cache.
    const cached = `${COOP}?same-origin&cached`;
    for (const time of ["first", "second"]) {
      const r = await runAgentCommand(conn, state, "agent-open", { url: cached, elements: true });
      const tab = tabById(r.tab);
      await assertLoaded(tab, `same-origin, cacheable, ${time} load`, cached);
      BrowserTestUtils.removeTab(tab);
    }

    // A page without the policy first, then one with it, in the same tab.
    const first = await runAgentCommand(conn, state, "agent-open", { url: `${COOP}?none` });
    const tab = tabById(first.tab);
    await assertLoaded(tab, "none");
    await runAgentCommand(conn, state, "agent-open", {
      url: `${COOP}?same-origin`,
      tab: first.tab,
      elements: true,
    });
    await until(() => tab.linkedBrowser.currentURI.spec.endsWith("?same-origin"), "navigated");
    await assertLoaded(tab, "same-origin, in place of a page without one");
    BrowserTestUtils.removeTab(tab);
  } finally {
    AgentGate.disconnect(conn);
    forgetAgentConnection(conn);
  }
});

add_task(async function test_mcp_agent_opens_coop_pages() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "coop-agent" }, via: "example" });
  const id = c.request("agent-open", { url: `${COOP}?same-origin`, elements: true });
  await until(() => AgentGate.waiting.length > 0, "the open asks");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "grant" });
  const r = await c.response(id);
  Assert.ok(r.result, `the open succeeds: ${JSON.stringify(r.error)}`);
  const tab = tabById(r.result.tab);
  await assertLoaded(tab, "same-origin, over MCP", `${COOP}?same-origin`);
  c.close();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_another_workspace_keeps_the_policy() {
  const url = `${COOP}?same-origin&coep`;
  const isolated = (/** @type {any} */ tab) =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.crossOriginIsolated);
  const mine = BrowserTestUtils.addTab(gBrowser, url);
  await BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, url);
  Assert.ok(await isolated(mine), "a tab of another workspace keeps its opener policy");
  const theirs = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await assertLoaded(theirs, "same-origin with an embedder policy, in the agent container", url);
  Assert.ok(!(await isolated(theirs)), "an agent tab loads it without (docs/limits.md)");
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(theirs);
});
