/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-search.md. The goto picker is tab search: it opens typing, lists the
// current workspace first under section headings, other windows' tabs (w2) and recently closed
// tabs and windows; Enter goes to a tab or reopens a closed one; lazy tabs stay unloaded; agent
// tabs are marked and last.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.org/";
const PICKER_ID = "vimma-picker";

const created = [];
registerCleanupFunction(async () => {
  for (const win of BrowserWindowTracker.orderedWindows) {
    win.document.getElementById(PICKER_ID)?.close?.();
    if (win !== window) await BrowserTestUtils.closeWindow(win);
  }
  await SimpleTest.promiseFocus(window);
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  if (main) WindowWorkspaces.get(window).switchTo({ id: main.id });
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  forgetClosed();
});

const picker = (win = window) => win.document.getElementById(PICKER_ID);
const isOpen = (win = window) => !!picker(win)?.open;
const options = (win = window) => [...(picker(win)?.querySelectorAll("[role=option]") ?? [])];
const headings = (win = window) =>
  [...(picker(win)?.querySelectorAll(".vimma-picker-heading") ?? [])].map((h) => h.textContent);
const selected = (win = window) =>
  picker(win)?.querySelector("[role=option][aria-selected=true]") ?? null;
const rowFor = (id, win = window) => options(win).find((r) => r.dataset.id === id);
const titleOf = (row) => row.querySelector(".vimma-picker-title").textContent;
const metaOf = (row) => row.querySelector(".vimma-picker-meta")?.textContent ?? "";
const ww = (win = window) => WindowWorkspaces.get(win);
const def = (name) => WorkspaceStore.definitions.workspaces.find((w) => w.name === name);

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** Every recently closed tab and window: each task starts from an empty "Recently closed". */
function forgetClosed() {
  for (const win of BrowserWindowTracker.orderedWindows) {
    while (SessionStore.getClosedTabCountForWindow(win)) SessionStore.forgetClosedTab(win, 0);
  }
  while (SessionStore.getClosedWindowCount()) SessionStore.forgetClosedWindow(0);
}

function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** Types `text` one key at a time. */
function type(text, win = window) {
  for (const ch of text) EventUtils.synthesizeKey(ch, {}, win);
}

/** A tab with `title` in `win`'s current workspace (or `userContextId`), loaded. */
async function openTitled(title, { win = window, userContextId, url } = {}) {
  const gB = win.gBrowser;
  const tab = gB.addTab(url ?? `${PAGE}?${encodeURIComponent(title)}`, {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    ...(userContextId !== undefined ? { userContextId } : {}),
  });
  const browser = tab.linkedBrowser;
  await BrowserTestUtils.browserLoaded(browser);
  await SpecialPowers.spawn(browser, [title], (t) => {
    content.document.title = t;
  });
  await until(() => tab.label === title, `the tab is titled ${title}`);
  return tab;
}

/**
 * Moves the selection to `row` with ctrl+n / ctrl+p (letters type). Rows are rendered anew on
 * every move, so they are compared by id.
 */
function selectRow(row, win = window) {
  const id = row.dataset.id;
  const at = (r) => options(win).findIndex((o) => o.dataset.id === r);
  for (let i = 0; i < 500 && selected(win)?.dataset.id !== id; i++) {
    const down = at(selected(win)?.dataset.id) < at(id);
    EventUtils.synthesizeKey(down ? "n" : "p", { ctrlKey: true }, win);
  }
  Assert.equal(selected(win)?.dataset.id, id, "the row is selected");
}

async function focusPage(win = window) {
  await SimpleTest.promiseFocus(win);
  await focusContent(win.gBrowser.selectedBrowser);
}

add_task(async function setup() {
  await ww().ready;
  forgetClosed();
  if (!def("tsother")) created.push(WorkspaceStore.newWorkspace("tsother").id);
  await until(() => ww().model.workspaces.some((w) => w.name === "tsother"), "tsother exists");
});

add_task(async function the_current_workspace_comes_first_under_headings() {
  const here = await openTitled("Here tab");
  const other = await openTitled("Elsewhere tab", {
    userContextId: def("tsother").userContextId,
  });
  await focusPage();
  prefix("g");
  await until(isOpen, "ctrl+b g opens tab search");
  Assert.equal(picker().getAttribute("aria-label"), "Tabs", "its heading is Tabs");
  const current = ww().model.workspaces.find((w) => w.id === ww().model.active);
  Assert.ok(
    headings()[0].startsWith(`${current.name} · `),
    `the current workspace's heading comes first (${headings()[0]})`,
  );
  Assert.ok(
    headings().some((h) => h.startsWith("tsother · ")),
    "the other workspace has a heading too",
  );
  for (const h of picker().querySelectorAll(".vimma-picker-heading")) {
    Assert.equal(h.getAttribute("role"), "presentation", "a heading is not an option");
  }
  const otherRow = rowFor(other.linkedPanel);
  Assert.ok(otherRow, "the other workspace's tab is listed");
  Assert.stringContains(metaOf(otherRow), "tsother", "its row names its workspace");
  Assert.less(
    options().indexOf(rowFor(here.linkedPanel)),
    options().indexOf(otherRow),
    "this workspace's tab is listed before the other's",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  gBrowser.removeTab(other);
  gBrowser.removeTab(here);
  forgetClosed();
});

add_task(async function it_opens_typing_and_esc_closes_at_once() {
  const jira = await openTitled("Jira 412");
  const docs = await openTitled("Docs page");
  await focusPage();
  prefix("g");
  await until(isOpen, "ctrl+b g opens tab search");
  const query = picker().querySelector(".vimma-picker-query");
  Assert.equal(query.textContent, "/", "typing at once: the prompt is shown");
  type("jira");
  Assert.equal(query.textContent, "/jira", "j and the rest are typed, not moves");
  Assert.equal(titleOf(options()[0]), "Jira 412", "typing filters");
  Assert.ok(!rowFor(docs.linkedPanel), "a non-match is gone");
  EventUtils.synthesizeKey("KEY_Backspace");
  type("xum");
  Assert.equal(query.textContent, "/jirxum", "x, u and m type too: no key manages tabs here");
  Assert.ok(jira.isConnected, "x closed nothing");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "one Esc closes it");
  Assert.equal(VimmaHost.status(window).mode, "normal", "back in normal mode");

  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("tabsearch jira");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":tabsearch opens it");
  Assert.equal(query.textContent, "/jira", "with its text as the query");
  Assert.equal(titleOf(selected()), "Jira 412", "the match is selected");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter closes it");
  Assert.equal(gBrowser.selectedTab, jira, "and goes to the tab");
  gBrowser.removeTab(jira);
  gBrowser.removeTab(docs);
  forgetClosed();
});

add_task(async function another_windows_tab_is_listed_as_w2_and_enter_goes_there() {
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  const far = await openTitled("Far away tab", { win: win2 });
  await focusPage();
  prefix("g");
  await until(isOpen, "tab search is open in window 1");
  const row = rowFor(far.linkedPanel);
  Assert.ok(row, "window 2's tab is listed in window 1");
  Assert.stringContains(metaOf(row), "w2", "marked w2");
  Assert.ok(
    headings().some((h) => h.endsWith(" · w2")),
    "under a heading that names window 2",
  );
  Assert.stringContains(row.getAttribute("aria-label"), "window 2", "its name says window 2");
  selectRow(row);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => Services.focus.activeWindow === win2, "window 2 comes to the front");
  Assert.equal(win2.gBrowser.selectedTab, far, "with that tab selected");
  Assert.ok(!isOpen(), "window 1's tab search closed");
  await BrowserTestUtils.closeWindow(win2);
  await SimpleTest.promiseFocus(window);
  forgetClosed();
});

add_task(async function a_closed_tab_reopens_with_enter_in_its_container_with_its_history() {
  forgetClosed();
  const container = def("tsother").userContextId;
  const first = await openTitled("Closed first");
  const second = await openTitled("Closed second", { userContextId: container });
  // Two history entries, which a reopen keeps.
  BrowserTestUtils.startLoadingURIString(second.linkedBrowser, `${PAGE}?second-b`);
  await BrowserTestUtils.browserLoaded(second.linkedBrowser);
  await SpecialPowers.spawn(second.linkedBrowser, [], () => {
    content.document.title = "Closed second";
  });
  await until(() => second.label === "Closed second", "titled again");
  const third = await openTitled("Closed third");
  for (const tab of [first, second, third]) BrowserTestUtils.removeTab(tab);
  await until(() => SessionStore.getClosedTabCount() >= 3, "three closed tabs");

  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  Assert.ok(
    headings().some((h) => h.startsWith("Recently closed · ")),
    "a Recently closed section",
  );
  for (let i = 0; i < 10 && !selected()?.dataset.id.startsWith("closed:"); i++) {
    EventUtils.synthesizeKey("KEY_Tab");
  }
  Assert.equal(titleOf(selected()), "Closed third", "Tab reaches it; the newest first");
  Assert.equal(picker().querySelector(".vimma-picker-query").textContent, "/", "still typing");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(titleOf(selected()), "Closed second", "Down the next one");
  Assert.stringContains(metaOf(selected()), "closed", "marked closed");
  Assert.stringContains(selected().getAttribute("aria-label"), "recently closed", "and named so");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab.label === "Closed second", "Enter reopens it, there");
  Assert.ok(!isOpen(), "the list closes");
  const reopened = gBrowser.selectedTab;
  Assert.equal(reopened.userContextId, container, "in its workspace's container");
  await until(() => ww().model.active === def("tsother").id, "whose workspace is now current");
  await until(
    () => reopened.linkedBrowser.browsingContext?.sessionHistory?.count === 2,
    "with its back/forward history",
  );
  ww().switchTo({ id: def("main").id });
  gBrowser.removeTab(reopened);
  forgetClosed();
});

add_task(async function a_closed_window_is_one_row_and_enter_reopens_it() {
  forgetClosed();
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await openTitled("Window two tab", { win: win2 });
  await BrowserTestUtils.closeWindow(win2);
  await until(() => SessionStore.getClosedWindowCount() === 1, "one closed window");
  await SimpleTest.promiseFocus(window);
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  const row = options().find((r) => r.dataset.id.startsWith("closedwin:"));
  Assert.ok(row, "the closed window is listed");
  Assert.stringContains(metaOf(row), "closed window", "as a closed window");
  selectRow(row);
  const opened = BrowserTestUtils.waitForNewWindow();
  EventUtils.synthesizeKey("KEY_Enter");
  const back = await opened;
  await until(
    () => back.gBrowser.tabs.some((t) => t.label === "Window two tab"),
    "Enter reopens the window with its tab",
  );
  await BrowserTestUtils.closeWindow(back);
  await SimpleTest.promiseFocus(window);
  forgetClosed();
});

add_task(async function a_lazy_tab_is_listed_and_stays_unloaded() {
  const lazy = gBrowser.addTab(`${PAGE}?lazy`, {
    createLazyBrowser: true,
    lazyTabTitle: "Lazy one",
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  Assert.ok(!lazy.linkedPanel, "sanity: the tab is lazy");
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  const row = options().find((r) => titleOf(r) === "Lazy one");
  Assert.ok(row, "the lazy tab is listed with its title");
  Assert.stringContains(row.textContent, "example.org", "and its host");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!lazy.linkedPanel, "it did not load");
  gBrowser.removeTab(lazy);
  forgetClosed();
});

add_task(async function audio_and_mute_are_marked_and_searchable() {
  const loud = await openTitled("Loud tab");
  const quiet = await openTitled("Quiet tab");
  loud.setAttribute("soundplaying", "true");
  quiet.toggleMuteAudio();
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  Assert.stringContains(metaOf(rowFor(loud.linkedPanel)), "♪", "a playing tab shows ♪");
  Assert.stringContains(metaOf(rowFor(quiet.linkedPanel)), "muted", "a muted tab says muted");
  Assert.stringContains(
    rowFor(loud.linkedPanel).getAttribute("aria-label"),
    "playing",
    "♪ is read as playing",
  );
  type("playing");
  Assert.deepEqual(options().map(titleOf), ["Loud tab"], "playing finds the audible tab");
  EventUtils.synthesizeKey("KEY_Escape");
  loud.removeAttribute("soundplaying");
  gBrowser.removeTab(loud);
  gBrowser.removeTab(quiet);
  forgetClosed();
});

add_task(async function agent_tabs_are_marked_and_last_and_a_closed_one_reopens_there() {
  const agent = WorkspaceStore.agent;
  Assert.ok(agent, "sanity: the agent workspace exists");
  const robot = await openTitled("Robot tab", { userContextId: agent.userContextId });
  const gone = await openTitled("Robot closed", { userContextId: agent.userContextId });
  // Flushed, the close is recorded with its title; an earlier test's closed tab cannot stand in.
  await TabStateFlusher.flush(gone.linkedBrowser);
  BrowserTestUtils.removeTab(gone);
  await until(
    () => SessionStore.getClosedTabDataForWindow(window).some((t) => t.title === "Robot closed"),
    "closed",
  );
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  const robotRow = rowFor(robot.linkedPanel);
  Assert.stringContains(metaOf(robotRow), `◇ ${agent.name}`, "the agent's tab is marked ◇");
  const windowRows = options().filter((r) => !r.dataset.id.startsWith("closed"));
  Assert.equal(windowRows.at(-1), robotRow, "and comes after the user's workspaces");
  const closedRow = options().find((r) => titleOf(r) === "Robot closed");
  Assert.stringContains(metaOf(closedRow), "◇", "a closed agent tab is marked too");
  selectRow(closedRow);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab.label === "Robot closed", "Enter reopens it");
  Assert.equal(gBrowser.selectedTab.userContextId, agent.userContextId, "in the agent container");
  const back = gBrowser.selectedTab;
  ww().switchTo({ id: def("main").id });
  gBrowser.removeTab(back);
  gBrowser.removeTab(robot);
  forgetClosed();
});
