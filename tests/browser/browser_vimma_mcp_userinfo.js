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
const UNTITLED = `${DIR}file_vimma_agent_untitled.html`;
const UNTITLED_WITH_USERINFO = UNTITLED.replace("https://", "https://ada:secret@");
const REDIRECT = `${DIR}file_vimma_agent_userinfo_redirect.sjs`.replace(
  "https://",
  "https://ada:secret@",
);
const REDIRECTED = UNTITLED.replace("https://example.com", "https://example.org");
/** A password longer than Firefox's 256-character tab label, which cuts its at sign off. */
const LONG_PASSWORD = `eyJ${"x".repeat(400)}`;
const LONG = UNTITLED.replace("https://", `https://${"ada"}:${LONG_PASSWORD}@`);
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

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/**
 * The commands about one page, each of which answers with the page's `url`.
 * @typedef {"agent-keys" | "agent-elements" | "agent-read" | "agent-console"} AgentPageCommand
 */

/**
 * `command` on an agent connection; the first is answered with a grant, which covers the rest.
 * @template {string} C
 * @param {Client} c @param {C} command @param {object} args @param {boolean} [asks]
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
  Assert.ok(!text.includes(PASSWORD) && !text.includes("eyJx"), `${what}: no password`);
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
  Assert.equal(
    tabs.tabs.find((/** @type {AgentListedTab} */ t) => t.id === id)?.url,
    PAGE,
    "vimma_tabs",
  );
  noUserinfo("vimma_tabs", tabs);

  const keys = await call(c, "agent-keys", { tab: id, keys: "f" });
  Assert.equal(keys.url, PAGE, "vimma_keys' page");
  Assert.ok(keys.links?.includes(`${DIR}file_vimma_agent_page.html?rel`), "the link, without them");
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

  // The lists that come with a step: an open, a fill and a click, each with `elements`. A new
  // connection, so that the first list is given in full (agent-speed S4).
  const c2 = new Client(/** @type {number} */ (VimmaControl.port));
  await c2.handshake({ protocol: 2, role: "agent" });
  await c2.call("agent-hello", { client: { name: "example-agent" } });
  const opened = await call(c2, "agent-open", { url: WITH_USERINFO, elements: true }, true);
  // The page was ready, so the open listed it.
  const listed = /** @type {Extract<typeof opened, { elements: string }>} */ (opened);
  Assert.equal(listed.url, PAGE, "vimma_open's page");
  noUserinfo("vimma_open", opened);
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of listed.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.kind === "field" ? "field" : e.text] = e.label;
  }
  const filled = await call(c2, "agent-fill", {
    tab: opened.tab,
    fields: [{ label: by.field, value: "cats" }],
    elements: true,
  });
  Assert.equal(filled.url, PAGE, "vimma_fill's page");
  noUserinfo("vimma_fill", filled);
  const clicked = await call(c2, "agent-activate", {
    tab: opened.tab,
    label: by["a relative link"],
    elements: true,
  });
  Assert.equal(clicked.navigated, true, "the click followed the link");
  Assert.equal(clicked.url, `${DIR}file_vimma_agent_page.html?rel`, "vimma_activate's page");
  noUserinfo("vimma_activate", clicked);

  c2.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
});

add_task(async function test_a_tab_labelled_with_its_url_gives_no_user_name_and_password() {
  Services.prefs.setIntPref(PHISHY, 255);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  // Before it loads, Firefox labels a tab with the URL it was given, user name and all; a tab
  // restored pending is labelled the same way.
  const lazy = gBrowser.addTab(UNTITLED_WITH_USERINFO, {
    createLazyBrowser: true,
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  Assert.ok(
    lazy.label.includes("ada:secret@"),
    `the unloaded tab's label holds them: ${lazy.label}`,
  );
  // A loaded page with no title is labelled with its URL too.
  const tab = gBrowser.addTab(UNTITLED_WITH_USERINFO, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, UNTITLED_WITH_USERINFO);
  await until(() => tab.hidden && lazy.hidden, "the agent tabs are hidden in their workspace");

  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  const tabs = await call(c, "agent-tabs", {}, true);
  const listed = tabs.tabs.find((/** @type {AgentListedTab} */ t) => t.id === idOf(lazy));
  Assert.ok(listed, "the unloaded tab is listed");
  Assert.ok(
    !listed.title.includes("ada") && listed.title.includes("file_vimma_agent_untitled.html"),
    `its title is its URL without them: ${listed.title}`,
  );
  noUserinfo("vimma_tabs", tabs);
  const id = idOf(tab);
  for (const [command, args] of /** @type {[AgentPageCommand, object][]} */ ([
    ["agent-keys", { tab: id, keys: "f" }],
    ["agent-elements", { tab: id }],
    ["agent-read", { tab: id }],
    ["agent-console", { tab: id }],
  ])) {
    const r = await call(c, command, args);
    Assert.equal(r.url, UNTITLED, `${command}'s page`);
    noUserinfo(command, r);
  }
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
});

add_task(async function test_a_clamped_or_redirected_url_label_gives_no_password() {
  Services.prefs.setIntPref(PHISHY, 1024);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const options = {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  };
  // Firefox clamps a label made of a URL at 256 characters: the at sign is cut off.
  const long = gBrowser.addTab(LONG, { ...options, createLazyBrowser: true });
  Assert.ok(
    long.label.includes("eyJx") && !long.label.includes("@"),
    `the label holds the password and no at sign: ${long.label.length} characters`,
  );
  Assert.equal(long.labelIsContentTitle, false, "a label made of a URL");
  // An untitled page keeps the label of the URL it was opened at after a redirect.
  const moved = gBrowser.addTab(REDIRECT, options);
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, REDIRECTED);
  await until(() => long.hidden && moved.hidden, "the agent tabs are hidden in their workspace");
  info(`the redirected tab's label: ${moved.label}`);
  Assert.equal(moved.labelIsContentTitle, false, "a label made of a URL");

  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  const tabs = await call(c, "agent-tabs", {}, true);
  noUserinfo("vimma_tabs", tabs);
  const titleOf = (/** @type {MozTabbrowserTab} */ t) =>
    tabs.tabs.find((/** @type {AgentListedTab} */ x) => x.id === idOf(t))?.title;
  Assert.equal(
    titleOf(long),
    UNTITLED.replace("https://", ""),
    "the long tab's title is its URL without them",
  );
  Assert.equal(
    titleOf(moved),
    REDIRECTED.replace("https://", ""),
    "the redirected tab's title is the URL it is at",
  );
  for (const [command, args] of /** @type {[AgentPageCommand, object][]} */ ([
    ["agent-keys", { tab: idOf(moved), keys: "f" }],
    ["agent-elements", { tab: idOf(moved) }],
    ["agent-read", { tab: idOf(moved) }],
  ])) {
    const r = await call(c, command, args);
    Assert.equal(r.url, REDIRECTED, `${command}'s page`);
    noUserinfo(command, r);
  }
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
});
