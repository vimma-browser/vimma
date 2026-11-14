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

/** @type {string[]} */
const created = [];
registerCleanupFunction(async () => {
  for (const win of BrowserWindowTracker.orderedWindows) {
    win.document.getElementById(PICKER_ID)?.close?.();
    if (win !== window) await BrowserTestUtils.closeWindow(win);
  }
  await SimpleTest.promiseFocus(window);
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  if (main) /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window)).switchTo({ id: main.id });
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  while (gBrowser.tabs.length > 1)
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  forgetClosed();
});

/**
 * An option of the picker: ui/picker.mjs gives each its item's id.
 * @typedef {HTMLElement & { dataset: DOMStringMap & { id: string } }} PickerRow
 */

/** @param {Window} [win] */
const picker = (win = window) =>
  /** @type {HTMLDialogElement | null} */ (win.document.getElementById(PICKER_ID));
/** The picker, which a test reads once it opened it (a missing one fails the read). */
const shown = () => /** @type {HTMLDialogElement} */ (picker());
/** @param {Window} [win] */
const isOpen = (win = window) => !!picker(win)?.open;
/** @param {Window} [win] */
const options = (win = window) =>
  /** @type {PickerRow[]} */ ([...(picker(win)?.querySelectorAll("[role=option]") ?? [])]);
/** @param {Window} [win] */
const headings = (win = window) =>
  [...(picker(win)?.querySelectorAll(".vimma-picker-heading") ?? [])].map((h) => h.textContent);
/** @param {Window} [win] */
const selected = (win = window) =>
  /** @type {PickerRow | null} */ (
    picker(win)?.querySelector("[role=option][aria-selected=true]") ?? null
  );
/** @param {string | null} id @param {Window} [win] */
const rowFor = (id, win = window) => options(win).find((r) => r.dataset.id === id);
const titleOf = (/** @type {Element} */ row) =>
  /** @type {Element} */ (row.querySelector(".vimma-picker-title")).textContent;
const metaOf = (/** @type {Element} */ row) =>
  row.querySelector(".vimma-picker-meta")?.textContent ?? "";
/** @param {BrowserWindow} [win] */
const ww = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);

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

/** @param {string} key @param {KeyEventOptions} [mods] @param {Window} [win] */
function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** Types `text` one key at a time. @param {string} text @param {Window} [win] */
function type(text, win = window) {
  for (const ch of text) EventUtils.synthesizeKey(ch, {}, win);
}

/**
 * A tab with `title` in `win`'s current workspace (or `userContextId`), loaded.
 * @param {string} title
 * @param {{ win?: BrowserWindow, userContextId?: number, url?: string }} [opts]
 */
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
 * @param {PickerRow} row
 * @param {Window} [win]
 */
function selectRow(row, win = window) {
  const id = row.dataset.id;
  const at = (/** @type {string | undefined} */ r) =>
    options(win).findIndex((o) => o.dataset.id === r);
  for (let i = 0; i < 500 && selected(win)?.dataset.id !== id; i++) {
    const down = at(selected(win)?.dataset.id) < at(id);
    EventUtils.synthesizeKey(down ? "n" : "p", { ctrlKey: true }, win);
  }
  Assert.equal(selected(win)?.dataset.id, id, "the row is selected");
}

/** @param {BrowserWindow} [win] */
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
    userContextId: /** @type {ContainedWorkspace} */ (def("tsother")).userContextId,
  });
  await focusPage();
  prefix("g");
  await until(isOpen, "ctrl+b g opens tab search");
  Assert.equal(shown().getAttribute("aria-label"), "Tabs", "its heading is Tabs");
  const current = /** @type {WorkspaceState} */ (
    ww().model.workspaces.find((w) => w.id === ww().model.active)
  );
  Assert.ok(
    headings()[0].startsWith(`${current.name} · `),
    `the current workspace's heading comes first (${headings()[0]})`,
  );
  Assert.ok(
    headings().some((h) => h.startsWith("tsother · ")),
    "the other workspace has a heading too",
  );
  for (const h of shown().querySelectorAll(".vimma-picker-heading")) {
    Assert.equal(h.getAttribute("role"), "presentation", "a heading is not an option");
  }
  const otherRow = rowFor(other.linkedPanel);
  Assert.ok(otherRow, "the other workspace's tab is listed");
  Assert.stringContains(metaOf(otherRow), "tsother", "its row names its workspace");
  const hereRow = rowFor(here.linkedPanel);
  Assert.ok(hereRow, "this workspace's tab is listed");
  Assert.less(
    options().indexOf(hereRow),
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
  const query = /** @type {Element} */ (shown().querySelector(".vimma-picker-query"));
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
  Assert.equal(titleOf(/** @type {PickerRow} */ (selected())), "Jira 412", "the match is selected");
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
  Assert.stringContains(
    /** @type {string} */ (row.getAttribute("aria-label")),
    "window 2",
    "its name says window 2",
  );
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
  const container = /** @type {ContainedWorkspace} */ (def("tsother")).userContextId;
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
  Assert.equal(
    titleOf(/** @type {PickerRow} */ (selected())),
    "Closed third",
    "Tab reaches it; the newest first",
  );
  Assert.equal(
    /** @type {Element} */ (shown().querySelector(".vimma-picker-query")).textContent,
    "/",
    "still typing",
  );
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    titleOf(/** @type {PickerRow} */ (selected())),
    "Closed second",
    "Down the next one",
  );
  Assert.stringContains(metaOf(/** @type {PickerRow} */ (selected())), "closed", "marked closed");
  Assert.stringContains(
    /** @type {string} */ (/** @type {PickerRow} */ (selected()).getAttribute("aria-label")),
    "recently closed",
    "and named so",
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab.label === "Closed second", "Enter reopens it, there");
  Assert.ok(!isOpen(), "the list closes");
  const reopened = gBrowser.selectedTab;
  Assert.equal(reopened.userContextId, container, "in its workspace's container");
  await until(
    () => ww().model.active === /** @type {WorkspaceDefinition} */ (def("tsother")).id,
    "whose workspace is now current",
  );
  await until(
    () => reopened.linkedBrowser.browsingContext?.sessionHistory?.count === 2,
    "with its back/forward history",
  );
  ww().switchTo({ id: /** @type {WorkspaceDefinition} */ (def("main")).id });
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

// A window without workspaces (private) keys its tabs by their panel, which an unloaded tab has
// none of: each unloaded tab still gets a row of its own, and Enter selects that tab (#958).
add_task(async function unloaded_private_tabs_are_listed_apart_and_enter_selects_each() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const titles = ["Private one", "Private two", "Private three"];
  /** @type {MozTabbrowserTab[]} */
  const tabs = [];
  for (const title of titles) tabs.push(await openTitled(title, { win: priv }));
  priv.gBrowser.selectedTab = tabs[0];
  // Firefox's "Unload Tab" (tab context menu): the browser goes lazy, its panel is gone.
  await priv.gBrowser.explicitUnloadTabs([tabs[1], tabs[2]]);
  await until(() => !tabs[1].linkedPanel && !tabs[2].linkedPanel, "two tabs unloaded");
  // focusContent checks this window's focus; the private window is another.
  await SimpleTest.promiseFocus(priv.gBrowser.selectedBrowser);
  prefix("g", {}, priv);
  await until(() => isOpen(priv), "open");
  const listed = options(priv).filter((r) => titles.includes(titleOf(r)));
  Assert.deepEqual(listed.map(titleOf), titles, "each tab is listed with its own title");
  Assert.deepEqual(
    listed.map((r) => r.querySelector(".vimma-picker-host")?.textContent),
    ["example.org", "example.org", "example.org"],
    "and its host",
  );
  const ids = options(priv).map((r) => r.dataset.id);
  Assert.equal(new Set(ids).size, ids.length, "every row has an id of its own");
  selectRow(listed[2], priv);
  EventUtils.synthesizeKey("KEY_Enter", {}, priv);
  await until(() => priv.gBrowser.selectedTab === tabs[2], "Enter selects the third tab");
  Assert.ok(!tabs[1].linkedPanel, "the second stays unloaded");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
});

// Tab search lists both private windows together and keys its rows by tab id: an unloaded tab's
// id never repeats in the other window, Enter on the other window's unloaded tab selects that
// tab there, and the search opens on this window's selected tab (#938).
add_task(async function two_private_windows_list_their_unloaded_tabs_apart() {
  const first = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const second = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const firstTitles = ["First one", "First two", "First three"];
  const secondTitles = ["Second one", "Second two", "Second three"];
  /** @type {MozTabbrowserTab[]} */
  const firstTabs = [];
  for (const title of firstTitles) firstTabs.push(await openTitled(title, { win: first }));
  /** @type {MozTabbrowserTab[]} */
  const secondTabs = [];
  for (const title of secondTitles) secondTabs.push(await openTitled(title, { win: second }));
  first.gBrowser.selectedTab = firstTabs[2];
  second.gBrowser.selectedTab = secondTabs[0];
  // Firefox's "Unload Tab" (tab context menu): the browser goes lazy, its panel is gone.
  await first.gBrowser.explicitUnloadTabs([firstTabs[0], firstTabs[1]]);
  await second.gBrowser.explicitUnloadTabs([secondTabs[1], secondTabs[2]]);
  await until(
    () => [firstTabs[0], firstTabs[1], secondTabs[1], secondTabs[2]].every((t) => !t.linkedPanel),
    "two tabs unloaded in each window",
  );
  await SimpleTest.promiseFocus(first.gBrowser.selectedBrowser);
  prefix("g", {}, first);
  await until(() => isOpen(first), "open");
  const all = [...firstTitles, ...secondTitles];
  const listed = options(first).filter((r) => all.includes(titleOf(r)));
  Assert.deepEqual(listed.map(titleOf).sort(), [...all].sort(), "each tab is listed once");
  const ids = options(first).map((r) => r.dataset.id);
  Assert.equal(new Set(ids).size, ids.length, "no id repeats across the two windows");
  Assert.equal(
    titleOf(/** @type {PickerRow} */ (selected(first))),
    "First three",
    "it opens on this window's tab",
  );
  Assert.notEqual(
    options(first)[0],
    /** @type {PickerRow} */ (selected(first)),
    "which is not merely the first row",
  );
  selectRow(/** @type {PickerRow} */ (listed.find((r) => titleOf(r) === "Second three")), first);
  EventUtils.synthesizeKey("KEY_Enter", {}, first);
  await until(
    () => second.gBrowser.selectedTab === secondTabs[2],
    "Enter selects the other window's third tab",
  );
  Assert.ok(!secondTabs[1].linkedPanel, "its second stays unloaded");
  Assert.equal(first.gBrowser.selectedTab, firstTabs[2], "this window's selection is unchanged");
  await BrowserTestUtils.closeWindow(second);
  await BrowserTestUtils.closeWindow(first);
  await SimpleTest.promiseFocus(window);
});

// The search opens on the selected tab in a window with workspaces too (#938).
add_task(async function tab_search_opens_on_the_selected_tab() {
  const here = await openTitled("Selected here");
  const after = await openTitled("After it");
  gBrowser.selectedTab = here;
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  Assert.equal(
    titleOf(/** @type {PickerRow} */ (selected())),
    "Selected here",
    "the selected tab's row is selected",
  );
  Assert.notEqual(
    options()[0],
    /** @type {PickerRow} */ (selected()),
    "which is not merely the first row",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  gBrowser.removeTab(after);
  gBrowser.removeTab(here);
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
  Assert.stringContains(
    metaOf(/** @type {PickerRow} */ (rowFor(loud.linkedPanel))),
    "♪",
    "a playing tab shows ♪",
  );
  Assert.stringContains(
    metaOf(/** @type {PickerRow} */ (rowFor(quiet.linkedPanel))),
    "muted",
    "a muted tab says muted",
  );
  Assert.stringContains(
    /** @type {string} */ (
      /** @type {PickerRow} */ (rowFor(loud.linkedPanel)).getAttribute("aria-label")
    ),
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
  const agent = /** @type {ContainedWorkspace | null} */ (WorkspaceStore.agent);
  Assert.ok(agent, "sanity: the agent workspace exists");
  const robot = await openTitled("Robot tab", { userContextId: agent.userContextId });
  const gone = await openTitled("Robot closed", { userContextId: agent.userContextId });
  // Flushed, the close is recorded with its title; an earlier test's closed tab cannot stand in.
  await TabStateFlusher.flush(gone.linkedBrowser);
  BrowserTestUtils.removeTab(gone);
  await until(
    () =>
      SessionStore.getClosedTabDataForWindow(window).some(
        (/** @type {{ title: string }} */ t) => t.title === "Robot closed",
      ),
    "closed",
  );
  await focusPage();
  prefix("g");
  await until(isOpen, "open");
  const robotRow = /** @type {PickerRow} */ (rowFor(robot.linkedPanel));
  Assert.stringContains(metaOf(robotRow), `◇ ${agent.name}`, "the agent's tab is marked ◇");
  const windowRows = options().filter((r) => !r.dataset.id.startsWith("closed"));
  Assert.equal(windowRows.at(-1), robotRow, "and comes after the user's workspaces");
  const closedRow = /** @type {PickerRow} */ (options().find((r) => titleOf(r) === "Robot closed"));
  Assert.stringContains(metaOf(closedRow), "◇", "a closed agent tab is marked too");
  selectRow(closedRow);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab.label === "Robot closed", "Enter reopens it");
  Assert.equal(gBrowser.selectedTab.userContextId, agent.userContextId, "in the agent container");
  const back = gBrowser.selectedTab;
  ww().switchTo({ id: /** @type {WorkspaceDefinition} */ (def("main")).id });
  gBrowser.removeTab(back);
  gBrowser.removeTab(robot);
  forgetClosed();
});
