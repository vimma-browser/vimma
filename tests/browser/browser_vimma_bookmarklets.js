/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarklets.md. `[bookmarks] bookmarklets` decides who may run a
// `javascript:` bookmark: nobody ("none", the default), the user from the bookmarks panel
// ("user"), or also an agent, asked every time ("agent"). A run is the page's own script, never
// chrome's; data: bookmarks, typed text and keyword bookmarklets never run at any level.
// security.md U3, U8, M63.

"use strict";

/* global focusContent -- from head.js */
/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
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
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_bookmarklet_page.html`;
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const { toolbarGuid, unfiledGuid } = PlacesUtils.bookmarks;

// The script reports where it ran: the page's origin, and whether it could reach chrome-only
// globals (a web page cannot).
const RAN = "javascript:void(document.title='ran:'+location.origin+':'+typeof ChromeUtils)";
const RAN_TITLE = "ran:https://example.com:undefined";
const ORIGINAL_TITLE = "bookmarklet page";
const DEFAULT_REFUSAL = "javascript: bookmarks don't open from Vimma";
const BLOCKED = "blocked: javascript: and data: URLs can't be opened from the command line";
const AGENTS_OFF =
  'bookmarklets are off for agents: [bookmarks] bookmarklets = "agent" in config.toml allows them';

/** @typedef {"none" | "user" | "agent"} Level */
/** @type {Level[]} */
const LEVELS = ["none", "user", "agent"];

/**
 * `[bookmarks] bookmarklets`, as config.toml sets it (ConfigHost calls configure).
 * @param {Level} level
 */
function setLevel(level) {
  VimmaHost.configure({ bookmarklets: level });
}

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

const panel = () => /** @type {HTMLElement | null} */ (document.getElementById("vimma-bookmarks"));
const isOpen = () => !!panel() && !panel()?.hidden && BrowserTestUtils.isVisible(panel());
const rows = () => [
  .../** @type {NodeListOf<HTMLElement> | never[]} */ (
    panel()?.querySelectorAll("[role=treeitem]") ?? []
  ),
];
/** @param {Element | null | undefined} row */
const rowTitle = (row) => row?.querySelector(".vimma-panel-title")?.textContent ?? "";
const selected = () => panel()?.querySelector("[role=treeitem][aria-selected=true]") ?? null;
const noticeText = () => {
  const n = document.getElementById("vimma-notice");
  return n?.matches(":popover-open") ? (n.textContent ?? "") : "";
};
const hideNotice = () => document.getElementById("vimma-notice")?.hidePopover?.();

/** @param {MozTabbrowserTab} tab */
const titleOf = (tab) => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title);

/** The fixture page in a new foreground tab, focused in normal mode. */
async function openPage(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  return tab;
}

async function openPanel() {
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("B", { shiftKey: true });
  await until(() => isOpen() && rows().length > 0, "ctrl+b shift+b opens the bookmarks panel");
}

async function closePanel() {
  while (isOpen()) {
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !isOpen(), "Esc closes the panel");
  }
}

/** @param {string} name */
async function highlight(name) {
  await until(() => rows().some((r) => rowTitle(r) === name), `${name} is listed`);
  const target = rows().findIndex((r) => rowTitle(r) === name);
  const now = rows().indexOf(/** @type {HTMLElement} */ (selected()));
  const key = target > now ? "j" : "k";
  for (let i = 0; i < Math.abs(target - now); i++) EventUtils.synthesizeKey(key);
  await until(() => rowTitle(selected()) === name, `${name} is highlighted`);
}

/**
 * Presses `key` on the bookmark `name` in the panel and waits for the notice.
 * @param {string} name @param {string} key @param {string} notice  its start
 */
async function pressRefused(name, key, notice) {
  await openPanel();
  await highlight(name);
  hideNotice();
  EventUtils.synthesizeKey(key, key === "S" ? { shiftKey: true } : {});
  await until(() => noticeText().startsWith(notice), `${key} on ${name}: "${notice}"`);
}

/** @param {string} line */
function runCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

// Each task turns MCP on before it reads the agent workspace, which then has its container.
const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A loaded tab of the agent workspace, hidden while the window shows `main`. */
async function openAgentTab(url = PAGE) {
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
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  return c;
}

async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return /** @type {AskedQuestion} */ (AgentGate.waiting[0]);
}

add_task(async function setup() {
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  Services.prefs.setIntPref(ASK_TIMEOUT, 20000);
  VimmaHost.configure({ bookmarksRoot: "toolbar" });
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      { title: "Ran", url: RAN },
      { title: "Data", url: "data:text/html,<title>data ran</title>" },
      { title: "Twin", url: "javascript:void(document.title='twin one')" },
    ],
  });
  await PlacesUtils.bookmarks.insert({
    parentGuid: unfiledGuid,
    title: "Twin",
    url: "javascript:void(document.title='twin two')",
  });
  registerCleanupFunction(async () => {
    setLevel("none");
    VimmaHost.configure({ bookmarksRoot: "workspace" });
    await closePanel();
    for (const pref of [MCP_ENABLED_PREF, ASK_TIMEOUT]) Services.prefs.clearUserPref(pref);
    AgentGate.revoke();
    await VimmaControl.settled();
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
    await PlacesUtils.keywords.remove("vjk").catch(() => {});
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
    const bookmarks = /** @type {HostState} */ (VimmaHost._state(window)).bookmarks;
    bookmarks.expanded = [];
    bookmarks.lastGuid = null;
  });
});

// B2, decision 6 of bookmarks: by default a bookmarklet is listed and refused, every key.
add_task(async function none_refuses_from_the_panel() {
  setLevel("none");
  const tab = await openPage();
  for (const key of ["KEY_Enter", "l", "t", "s"]) {
    await pressRefused("Ran", key, DEFAULT_REFUSAL);
    await closePanel();
  }
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "the page did not change");
  BrowserTestUtils.removeTab(tab);
});

// B7, B8: at "user" (and "agent"), Enter and l run it in this page, with the page's own
// principal, and close the panel.
add_task(async function user_runs_from_the_panel_in_the_pages_principal() {
  for (const [level, key] of /** @type {[Level, string][]} */ ([
    ["user", "KEY_Enter"],
    ["user", "l"],
    ["agent", "KEY_Enter"],
  ])) {
    setLevel(level);
    const tab = await openPage();
    await openPanel();
    await highlight("Ran");
    EventUtils.synthesizeKey(key);
    await until(() => tab.linkedBrowser.contentTitle === RAN_TITLE, `${level}: ${key} runs it`);
    Assert.equal(await titleOf(tab), RAN_TITLE, "in the page's origin, with no chrome globals");
    Assert.ok(!isOpen(), "the panel closes");
    Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "the page is still the same page");
    BrowserTestUtils.removeTab(tab);
  }
});

// B7: in a new tab or pane the script would run on an empty page, so t, s and S refuse.
add_task(async function user_t_s_and_S_refuse() {
  setLevel("user");
  const tab = await openPage();
  const tabs = gBrowser.tabs.length;
  for (const key of ["t", "s", "S"]) {
    await pressRefused("Ran", key, "a bookmarklet runs in this page: Enter runs it");
    await closePanel();
  }
  Assert.equal(gBrowser.tabs.length, tabs, "no tab or pane opened");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  BrowserTestUtils.removeTab(tab);
});

// B9: only on an http, https or file page.
add_task(async function user_runs_only_on_web_pages() {
  setLevel("user");
  const tab = await openPage("about:robots");
  await pressRefused("Ran", "KEY_Enter", "bookmarklets run only on web pages");
  await closePanel();
  Assert.equal(tab.linkedBrowser.currentURI.spec, "about:robots", "nothing loaded");
  BrowserTestUtils.removeTab(tab);
});

// B5: a data: bookmark refuses at every level.
add_task(async function data_bookmarks_refuse_at_every_level() {
  const tab = await openPage();
  for (const level of LEVELS) {
    setLevel(level);
    await pressRefused("Data", "KEY_Enter", "data: bookmarks don't open from Vimma");
    await closePanel();
  }
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "nothing loaded");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  BrowserTestUtils.removeTab(tab);
});

// B17, U4: typed text and keyword bookmarklets never run, at any level.
add_task(async function typed_and_keyword_bookmarklets_refuse_at_every_level() {
  // A keyword fills its %s with the typed words, which would make them part of the script.
  const KEYWORDED = "javascript:void(document.title='ran-%s')";
  await PlacesUtils.bookmarks.insert({
    parentGuid: unfiledGuid,
    title: "Keyworded",
    url: KEYWORDED,
  });
  await PlacesUtils.keywords.insert({ keyword: "vjk", url: KEYWORDED });
  const tab = await openPage();
  for (const level of LEVELS) {
    setLevel(level);
    for (const line of ["open vjk 1", `open ${RAN}`]) {
      await focusContent(tab.linkedBrowser);
      hideNotice();
      runCommand(line);
      await until(() => noticeText() === BLOCKED, `${level}: :${line} is refused`);
      await TestUtils.waitForTick();
      Assert.equal(await titleOf(tab), ORIGINAL_TITLE, `${level}: :${line} ran nothing`);
    }
  }
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "nothing loaded");
  await PlacesUtils.keywords.remove("vjk");
  BrowserTestUtils.removeTab(tab);
});

// B13: below "agent", an agent's call is refused before anything is asked.
add_task(async function agent_is_refused_below_agent_without_a_question() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  for (const level of /** @type {Level[]} */ (["none", "user"])) {
    setLevel(level);
    const res = await c.call("agent-bookmarklet", { tab: idOf(tab), name: "Ran" });
    Assert.ok(!res.ok, `${level}: refused`);
    Assert.equal(res.error?.code, "failed", `${level}: as failed`);
    Assert.equal(res.error?.message, AGENTS_OFF, `${level}: naming the setting`);
    Assert.equal(AgentGate.waiting.length, 0, `${level}: nothing was asked`);
  }
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

/**
 * `agent-bookmarklet` request; its response once answered.
 * @param {Client} c @param {MozTabbrowserTab} tab @param {string} name
 */
function runRequest(c, tab, name) {
  return c.request("agent-bookmarklet", { tab: idOf(tab), name });
}

// B14, B15, B16: at "agent" it asks every time, under a grant too, names the bookmarklet, and
// runs it in the agent tab only after a yes.
add_task(async function agent_asks_every_time_and_runs_on_yes() {
  setLevel("agent");
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // A grant for this connection, which covers every tool but the always-asked ones.
  const listed = c.request("agent-tabs");
  AgentGate.answer((await question()).id, { kind: "grant", minutes: 10 });
  Assert.ok((await c.response(listed)).ok, "the tab list ran under its grant");

  const id = runRequest(c, tab, "Ran");
  const q = await question();
  Assert.equal(q.tool, "vimma_bookmarklet", "it asks although the connection holds a grant");
  Assert.ok(JSON.stringify(q).includes("Ran"), "the question names the bookmarklet");
  Assert.equal(AgentGate.answer(q.id, { kind: "grant", minutes: 10 }), null, "no grant for it");
  AgentGate.answer(q.id, { kind: "deny" });
  const no = await c.response(id);
  Assert.equal(no.error?.reason, "user", "n denies it");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "and nothing ran");

  const again = runRequest(c, tab, "Ran");
  Assert.equal((await question()).tool, "vimma_bookmarklet", "the next call asks again");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "once" });
  const yes = await c.response(again);
  Assert.ok(yes.ok, `y runs it: ${JSON.stringify(yes.error ?? null)}`);
  Assert.deepEqual(yes.result, { ran: true }, "and says so, with nothing of the script's");
  Assert.deepEqual(validateMessage(yes, { command: "agent-bookmarklet" }).errors, [], "valid");
  await until(() => tab.linkedBrowser.contentTitle === RAN_TITLE, "in the agent tab's page");
  Assert.ok(tab.hidden, "the agent tab stays in the background");
  Assert.equal(AgentGate.log[0].tool, "vimma_bookmarklet", "the run is in :mcp log");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// B12: only a bookmarklet the user stored, by its exact title, and only one.
add_task(async function agent_names_exactly_one_stored_bookmarklet() {
  setLevel("agent");
  await mcp(true);
  const tab = await openAgentTab();
  const user = await openPage();
  const c = await agentClient();
  // One refusal for none and for several (B16): the agent learns nothing more than that.
  const NOT_ONE =
    "no single bookmarklet has that title: check it is one you saved, and that no other bookmarklet shares it";
  for (const [name, message] of [
    ["ran", NOT_ONE],
    [RAN, NOT_ONE],
    ["Data", NOT_ONE],
    ["Twin", NOT_ONE],
  ]) {
    const r = await c.response(runRequest(c, tab, name));
    Assert.equal(r.error?.code, "failed", `${name}: refused`);
    Assert.equal(r.error?.message, message, `${name}: says why`);
    Assert.equal(AgentGate.waiting.length, 0, `${name}: nothing was asked`);
  }
  // The user's own tab is no agent tab (M2).
  const mine = await c.response(runRequest(c, user, "Ran"));
  Assert.ok(!mine.ok, "a tab outside the agent workspace is refused");
  Assert.equal(AgentGate.waiting.length, 0, "with no question");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "nothing ran in the agent tab");
  Assert.equal(await titleOf(user), ORIGINAL_TITLE, "nor in the user's");
  c.close();
  BrowserTestUtils.removeTab(user);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// B15: after the yes, the tab must still show the page asked about.
add_task(async function agent_runs_nothing_when_the_tab_changed_after_the_question() {
  setLevel("agent");
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const id = runRequest(c, tab, "Ran");
  const q = await question();
  const moved = `${PAGE}?moved`;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, moved);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, moved);
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.equal(r.error?.reason, "changed", "the run is refused as changed");
  await TestUtils.waitForTick();
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "nothing ran on the new page");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// B15: the stored bookmark is read again after the yes; a URL changed while the question waited
// runs nothing.
add_task(async function agent_runs_nothing_when_the_bookmark_changed_after_the_question() {
  setLevel("agent");
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const id = runRequest(c, tab, "Ran");
  const q = await question();
  const ran = /** @type {{ guid: string }} */ (await PlacesUtils.bookmarks.fetch({ url: RAN }));
  await PlacesUtils.bookmarks.update({
    guid: ran.guid,
    url: "javascript:void(document.title='swapped')",
  });
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.equal(r.error?.reason, "changed", "the run is refused as changed");
  await TestUtils.waitForTick();
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "neither script ran");
  await PlacesUtils.bookmarks.update({ guid: ran.guid, url: RAN });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// B13, B15: the level is decided again after the yes; dropped to "user" meanwhile, it refuses.
add_task(async function agent_runs_nothing_when_the_level_dropped_during_the_question() {
  setLevel("agent");
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const id = runRequest(c, tab, "Ran");
  const q = await question();
  setLevel("user");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.equal(r.error?.code, "failed", "refused");
  Assert.equal(r.error?.message, AGENTS_OFF, "naming the setting");
  await TestUtils.waitForTick();
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "nothing ran");
  setLevel("none");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
