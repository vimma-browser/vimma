/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #1209 (security.md M21, M31, M7): a page loaded with a user name and password in its
// URL gives them to every link and form action it resolves, and to its own URL. No reply an
// agent gets carries them: the tab list, a step's page, a link list, an element list, a read
// page's text and URL, a screenshot's and a console read's page.

"use strict";

/* global Client -- from head_vimma_control.js */

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
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_userinfo.html`;
/** The page with a user name and password, as a user may have typed or a link may have given. */
const WITH_USERINFO = PAGE.replace("https://", "https://ada:secret@");
const NAME = "ada";
const PASSWORD = "secret";
/** Firefox asks before it loads a URL with a user name the server did not ask for. */
const PHISHY = "network.http.phishy-userpass-length";

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(PHISHY);
  await VimmaControl.settled();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/**
 * `command` on an agent connection; the first is answered with a grant, which covers the rest.
 * @param {any} c @param {string} command @param {object} args @param {boolean} [asks]
 */
async function call(c, command, args, asks = false) {
  const id = c.request(command, args);
  if (asks) {
    await until(() => AgentGate.waiting.length > 0, `${command} asks`);
    AgentGate.answer(AgentGate.waiting[0].id, { kind: "grant", minutes: 12 });
  }
  const r = await c.response(id);
  Assert.ok(r.ok, `${command} runs: ${JSON.stringify(r.error)}`);
  const v = validateMessage(r, { command });
  Assert.deepEqual(v.errors, [], `a valid ${command} result`);
  return r.result;
}

/** @param {string} what @param {unknown} result */
function noUserinfo(what, result) {
  const text = JSON.stringify(result);
  Assert.ok(!text.includes(PASSWORD), `${what}: no password`);
  Assert.ok(!text.includes(`${NAME}:`) && !text.includes(`${NAME}@`), `${what}: no user name`);
}

add_task(async function test_no_reply_carries_the_pages_user_name_and_password() {
  Services.prefs.setIntPref(PHISHY, 255);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const tab = gBrowser.addTab(WITH_USERINFO, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, WITH_USERINFO);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  Assert.equal(tab.linkedBrowser.currentURI.spec, WITH_USERINFO, "the page has them in its URL");
  const relative = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => /** @type {HTMLAnchorElement} */ (content.document.getElementById("rel")).href,
  );
  Assert.ok(relative.includes("ada:secret@"), "and so has its relative link, as the page sees it");

  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  const id = idOf(tab);

  const tabs = await call(c, "agent-tabs", {}, true);
  Assert.equal(tabs.tabs.find((/** @type {any} */ t) => t.id === id)?.url, PAGE, "vimma_tabs");
  noUserinfo("vimma_tabs", tabs);

  const keys = await call(c, "agent-keys", { tab: id, keys: "f" });
  Assert.equal(keys.url, PAGE, "vimma_keys' page");
  Assert.ok(keys.links.includes(`${DIR}file_vimma_agent_page.html?rel`), "the link, without them");
  noUserinfo("vimma_keys", keys);

  const elements = await call(c, "agent-elements", { tab: id });
  Assert.equal(elements.url, PAGE, "vimma_elements' page");
  Assert.ok(
    elements.elements.includes(`"href":"${DIR}file_vimma_agent_page.html?rel"`),
    "the link's href, without them",
  );
  Assert.ok(
    elements.elements.includes(`"action":"${DIR}file_vimma_agent_page.html"`),
    "the form's action, without them",
  );
  noUserinfo("vimma_elements", elements);

  const read = await call(c, "agent-read", { tab: id });
  Assert.equal(read.url, PAGE, "vimma_read_page's page");
  Assert.ok(read.text.includes("relative link"), "the page's text was read");
  Assert.ok(
    read.text.includes(`(${DIR}file_vimma_agent_page.html?rel)`),
    `its link, without them: ${read.text}`,
  );
  noUserinfo("vimma_read_page", read);

  const shot = await call(c, "agent-screenshot", { tab: id });
  Assert.equal(shot.url, PAGE, "vimma_screenshot's page");
  noUserinfo("vimma_screenshot", { ...shot, image: "" });

  const console = await call(c, "agent-console", { tab: id });
  Assert.equal(console.url, PAGE, "vimma_console's page");
  noUserinfo("vimma_console", console);

  c.close();
  BrowserTestUtils.removeTab(tab);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
});
