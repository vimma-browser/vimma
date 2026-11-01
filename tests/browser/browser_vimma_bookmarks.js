/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks.md. `ctrl+b shift+b` toggles a bookmarks panel in the
// side panel's slot, over Firefox's Places bookmarks, with neo-tree's keys; `ctrl+b a` and
// `:bookmark` file the page under typed folders. By default the panel shows the Bookmarks
// Toolbar's contents (docs/specs/bookmarks.md); `[bookmarks] root = "all"` the whole tree.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves, PANES_MAX_DEFAULT } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/panes.mjs",
);
const { RENDER_CAP } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/bookmarks.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const { menuGuid, toolbarGuid, unfiledGuid } = PlacesUtils.bookmarks;

const panel = (win = window) => win.document.getElementById("vimma-bookmarks");
const isOpen = (win = window) =>
  !!panel(win) && !panel(win).hidden && BrowserTestUtils.isVisible(panel(win));
const sidePanel = () => document.getElementById("vimma-panel");
const sideOpen = () => !!sidePanel() && !sidePanel().hidden;
const rows = (win = window) => [...(panel(win)?.querySelectorAll("[role=treeitem]") ?? [])];
const title = (row) => row?.querySelector(".vimma-panel-title")?.textContent ?? "";
const titles = (win = window) => rows(win).map(title);
const selected = (win = window) =>
  panel(win)?.querySelector("[role=treeitem][aria-selected=true]") ?? null;
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const promptEl = () => document.getElementById("vimma-rename");
const promptInput = () => document.getElementById("vimma-rename-input");
const promptOpen = () => !!promptEl() && !promptEl().hidden;
const promptLabel = () => promptEl().querySelector(".vimma-cmdline-prompt").textContent;
const filterInput = () => document.getElementById("vimma-bookmarks-filter");
const main = () => WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
const paneCount = () =>
  PaneViews.get(window).panes ? leaves(PaneViews.get(window).panes).length : 1;

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** Opens `${PAGE}?<query>`, titled `query`, focused in normal mode. */
async function openPage(query) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${query}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [query], (t) => {
    content.document.title = t;
  });
  await until(() => tab.linkedBrowser.contentTitle === query, "the page has its title");
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  return tab;
}

async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
}

async function openPanel() {
  await focusPage();
  prefix("B", { shiftKey: true });
  await until(() => isOpen() && rows().length > 0, "ctrl+b shift+b opens the bookmarks panel");
}

const emptyState = () => panel()?.querySelector(".vimma-bookmarks-empty") ?? null;
const header = () => panel()?.querySelector(".vimma-panel-name")?.textContent ?? "";

/** `[bookmarks] root`, as config.toml sets it (ConfigHost calls configure). */
function setRoot(root) {
  VimmaHost.configure({ bookmarksRoot: root });
}

async function closePanel() {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  while (isOpen()) {
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !isOpen() || !filterInput() || filterInput().hidden, "Esc");
  }
}

/** j / k until the highlighted row is `name`. */
async function highlight(name) {
  await until(() => titles().includes(name), `${name} is listed`);
  const target = titles().indexOf(name);
  const now = rows().indexOf(selected());
  const key = target > now ? "j" : "k";
  for (let i = 0; i < Math.abs(target - now); i++) EventUtils.synthesizeKey(key);
  await until(() => title(selected()) === name, `${name} is highlighted`);
}

/** Replaces the prompt's text and presses Enter. */
function answer(text) {
  promptInput().select();
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** The bookmark for `url` with its folder names from the menu, or null. */
async function placeOf(url) {
  const bm = await PlacesUtils.bookmarks.fetch({ url }, null, { includePath: true });
  if (!bm) return null;
  return { ...bm, folders: bm.path.map((p) => p.title) };
}

const JIRA = `${PAGE}?jira`;
const MDN = `${PAGE}?mdn`;
const MENU = `${PAGE}?menu`;
const OTHER = `${PAGE}?other`;

// The panel's fixture is in the Bookmarks Toolbar, its default root; the menu and Other
// Bookmarks each hold one more, which the toolbar view leaves out.
async function seed() {
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      {
        title: "work",
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [
          {
            title: "docs",
            type: PlacesUtils.bookmarks.TYPE_FOLDER,
            children: [{ title: "MDN", url: MDN }],
          },
          { title: "Jira", url: JIRA },
        ],
      },
      { title: "Bookmarklet", url: "javascript:document.title='pwned'" },
      { title: "<img src=x onerror=alert(1)>", url: `${PAGE}?html` },
    ],
  });
  await PlacesUtils.bookmarks.insert({ parentGuid: toolbarGuid, title: "Bar", url: `${PAGE}?bar` });
  await PlacesUtils.bookmarks.insert({ parentGuid: menuGuid, title: "In the menu", url: MENU });
  await PlacesUtils.bookmarks.insert({ parentGuid: unfiledGuid, title: "In other", url: OTHER });
}

registerCleanupFunction(async () => {
  setRoot("workspace"); // the default
  await closePanel();
  while (PaneViews.get(window).panes) PaneViews.get(window).close();
  PaneViews.get(window).max = PANES_MAX_DEFAULT;
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.history.clear();
  // The panel keeps its open folders for the window's session; the next run starts afresh.
  const bookmarks = VimmaHost._state(window).bookmarks;
  bookmarks.expanded = [];
  bookmarks.lastGuid = null;
});

add_task(async function setup_bookmarks() {
  await WindowWorkspaces.get(window).ready;
  // This file is the whole-toolbar view (root = "toolbar"); the default, a folder per
  // workspace, is browser_vimma_bookmarks_workspaces.js.
  setRoot("toolbar");
  await seed();
});

add_task(async function toggles_in_the_side_panels_slot_one_panel_at_a_time() {
  await openPage("toggle");
  Assert.ok(!isOpen(), "closed at start");
  await openPanel();
  Assert.equal(VimmaHost.status(window).mode, "panel", "panel mode");
  Assert.ok(panel().contains(document.activeElement), "focus is in the panel");
  Assert.lessOrEqual(
    panel().getBoundingClientRect().right,
    document.getElementById("tabbrowser-tabbox").getBoundingClientRect().left,
    "on the left, the pages to its right",
  );
  Assert.deepEqual(
    titles(),
    ["work", "Bookmarklet", "<img src=x onerror=alert(1)>", "Bar"],
    "only the Bookmarks Toolbar's contents, at the top",
  );
  Assert.deepEqual(
    rows().map((r) => r.dataset.guid),
    (await PlacesUtils.promiseBookmarksTree(toolbarGuid)).children.map((c) => c.guid),
    "the first rows are the toolbar's own children, in order",
  );
  Assert.ok(
    rows().every(
      (r) => ![toolbarGuid, menuGuid, unfiledGuid].includes(r.dataset.guid) && r.dataset.guid,
    ),
    "no row is the toolbar folder itself, nor the menu or other",
  );
  Assert.ok(
    !titles().some((t) =>
      ["toolbar", "menu", "other", "mobile", "In the menu", "In other"].includes(t),
    ),
    "no wrapper folders, nothing from the menu or Other Bookmarks",
  );
  Assert.ok(
    rows().every(
      (r) =>
        r.getAttribute("aria-level") === "1" &&
        getComputedStyle(r).getPropertyValue("--vimma-depth").trim() === "0",
    ),
    "every top row at depth 0, aria-level 1",
  );
  Assert.equal(header(), "Bookmarks Toolbar", "the header names the toolbar");
  Assert.equal(panel().querySelector("img"), null, "a title is text, never HTML");
  prefix("B", { shiftKey: true });
  await until(() => !isOpen(), "ctrl+b shift+b closes it");
  await focusPage();
  prefix("B", { shiftKey: true });
  await until(isOpen, "ctrl+b shift+b opens it");
  prefix("b");
  await until(() => sideOpen() && !isOpen(), "ctrl+b b swaps to the side panel");
  prefix("B", { shiftKey: true });
  await until(() => isOpen() && !sideOpen(), "and ctrl+b shift+b back");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes it");
  await until(() => document.activeElement === gBrowser.selectedBrowser, "focus is on the page");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("bookmarks");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":bookmarks opens it");
  await closePanel();
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// docs/specs/key-handling-batch.md § 4: x is the tabs panel's; here it does nothing (d deletes).
add_task(async function x_does_nothing_in_the_bookmarks_panel() {
  const tab = await openPage("x-bookmarks");
  const tabs = gBrowser.tabs.length;
  await openPanel();
  const before = titles();
  EventUtils.synthesizeKey("x");
  EventUtils.synthesizeKey("j");
  await until(() => rows().indexOf(selected()) === 1, "the key after x still moves");
  Assert.ok(isOpen(), "the bookmarks panel stays open");
  Assert.ok(tab.isConnected, "no tab closed");
  Assert.equal(gBrowser.tabs.length, tabs, "the tabs are as they were");
  Assert.deepEqual(titles(), before, "no bookmark changed");
  Assert.ok(!promptOpen(), "and nothing asks y/N");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function quick_add_files_under_typed_folders_with_completion() {
  const url = `${PAGE}?Quick`;
  const tab = await openPage("Quick");
  prefix("a");
  await until(promptOpen, "ctrl+b a opens the prompt");
  Assert.equal(promptInput().value, "Quick", "prefilled with the page title");
  Assert.equal(promptInput().selectionStart, 0, "the caret at the start, to type folders");
  EventUtils.sendString("work/do");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "work/docs/Quick", "Tab completes the folder name");
  EventUtils.sendString("new/deeper/");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !promptOpen(), "Enter saves");
  await until(async () => !!(await placeOf(url)), "bookmarked");
  const bm = await placeOf(url);
  Assert.deepEqual(
    bm.folders,
    ["toolbar", "work", "docs", "new", "deeper"],
    "missing folders made, under the toolbar",
  );
  Assert.equal(bm.title, "Quick", "titled as typed");

  await focusPage();
  prefix("a");
  await until(promptOpen, "again");
  await until(
    () => noticeText().includes("already bookmarked: work/docs/new/deeper/Quick"),
    "it says the page is bookmarked, where",
  );
  Assert.stringContains(promptLabel(), "move/rename", "and offers to move or rename it");
  Assert.equal(promptInput().value, "work/docs/new/deeper/Quick", "from where it is");
  answer("misc/Renamed");
  await until(async () => (await placeOf(url))?.title === "Renamed", "renamed");
  Assert.deepEqual((await placeOf(url)).folders, ["toolbar", "misc"], "and moved to toolbar/misc");
  const all = [];
  await PlacesUtils.bookmarks.fetch({ url }, (b) => all.push(b));
  Assert.equal(all.length, 1, "no duplicate");

  await focusPage();
  prefix("a");
  await until(promptOpen, "once more");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !promptOpen(), "Esc cancels");
  Assert.equal((await placeOf(url)).title, "Renamed", "nothing changed");

  // :bookmark with a path skips the prompt; the path is from the toolbar.
  const other = await openPage("Cmd");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("bookmark work/docs/Cmd page");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => !!(await placeOf(`${PAGE}?Cmd`)), ":bookmark path adds at once");
  Assert.deepEqual(
    (await placeOf(`${PAGE}?Cmd`)).folders,
    ["toolbar", "work", "docs"],
    "in toolbar/work/docs",
  );

  // A page bookmarked in the menu is outside the toolbar: offered at the top, by its title.
  const menuPage = await openPage("menu");
  prefix("a");
  await until(promptOpen, "ctrl+b a on a menu bookmark");
  await until(
    () => noticeText() === "already bookmarked outside the bookmarks toolbar: In the menu",
    "it says the bookmark is outside the toolbar",
  );
  Assert.equal(promptInput().value, "In the menu", "the prompt offers its title, at the top");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => (await placeOf(MENU))?.parentGuid === toolbarGuid, "moved in");
  BrowserTestUtils.removeTab(menuPage);
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
  await seed();
});

add_task(async function h_l_enter_fold_and_open_in_this_tab() {
  const tab = await openPage("fold");
  await openPanel();
  await highlight("work");
  EventUtils.synthesizeKey("l");
  await until(() => titles().includes("Jira"), "l opens the folder");
  EventUtils.synthesizeKey("l");
  await until(() => title(selected()) === "docs", "l again goes to its first item");
  EventUtils.synthesizeKey("l");
  await until(() => titles().includes("MDN"), "and opens docs");
  EventUtils.synthesizeKey("h");
  await until(() => !titles().includes("MDN"), "h closes docs");
  EventUtils.synthesizeKey("h");
  await until(
    () => title(selected()) === "work" && !titles().includes("docs"),
    "h goes up, closes",
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => titles().includes("Jira"), "Enter on a folder opens it");
  await highlight("Jira");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter on a bookmark closes the panel");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, JIRA);
  Assert.equal(gBrowser.selectedTab, tab, "in this tab");
  Assert.equal(tab.userContextId, main().userContextId, "in the workspace's container");
  await openPanel();
  Assert.ok(titles().includes("Jira"), "expanded folders stay expanded");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function t_opens_a_background_tab_in_the_workspaces_container() {
  const tab = await openPage("t");
  const count = gBrowser.tabs.length;
  await openPanel();
  await highlight("Jira");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, JIRA, true);
  EventUtils.synthesizeKey("t");
  const fresh = await opened;
  Assert.equal(gBrowser.tabs.length, count + 1, "one new tab");
  Assert.equal(gBrowser.selectedTab, tab, "in the background");
  Assert.ok(isOpen(), "the panel stays open for more");
  Assert.ok(main().userContextId > 0, "main has a container");
  Assert.equal(fresh.userContextId, main().userContextId, "the tab is in main's container");
  await closePanel();
  BrowserTestUtils.removeTab(fresh);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function javascript_and_data_bookmarks_refuse_with_a_notice() {
  const tab = await openPage("js");
  await openPanel();
  await highlight("Bookmarklet");
  for (const key of ["KEY_Enter", "l", "t", "s"]) {
    document.getElementById("vimma-notice")?.hidePopover?.();
    EventUtils.synthesizeKey(key);
    await until(
      () => noticeText().startsWith("javascript: bookmarks don't open"),
      `${key} refuses`,
    );
  }
  Assert.ok(isOpen(), "the panel stays open");
  Assert.equal(tab.linkedBrowser.currentURI.spec, `${PAGE}?js`, "the page did not change");
  Assert.equal(tab.linkedBrowser.contentTitle, "js", "and no script ran");
  Assert.equal(paneCount(), 1, "no split");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function s_and_S_open_in_splits_up_to_the_pane_max() {
  PaneViews.get(window).max = 4;
  const tab = await openPage("split");
  await openPanel();
  await highlight("Jira");
  EventUtils.synthesizeKey("s");
  await until(() => paneCount() === 2, "s splits right");
  await until(() => gBrowser.selectedBrowser.currentURI.spec === JIRA, "the new pane loads it");
  Assert.notEqual(gBrowser.selectedTab, tab, "in a new tab");
  Assert.ok(!isOpen(), "the panel closes");
  await openPanel();
  await highlight("Jira");
  EventUtils.synthesizeKey("S", { shiftKey: true });
  await until(() => paneCount() === 3, "S splits below");
  await openPanel();
  await highlight("Jira");
  EventUtils.synthesizeKey("s");
  await until(() => paneCount() === 4, "four panes");
  await openPanel();
  await highlight("Jira");
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeKey("s");
  await until(() => noticeText() === "Split right: at most 4 panes", "a fifth is refused");
  Assert.equal(paneCount(), 4, "still four");
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  await closePanel();
  while (PaneViews.get(window).panes) PaneViews.get(window).close();
  PaneViews.get(window).max = PANES_MAX_DEFAULT;
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

add_task(async function a_A_r_m_d_y_edit_like_neo_tree() {
  const url = `${PAGE}?Here`;
  const tab = await openPage("Here");
  await openPanel();
  await highlight("work");

  // a: the page, here, with folders.
  EventUtils.synthesizeKey("a");
  await until(promptOpen, "a asks");
  Assert.stringContains(promptLabel(), "work/", "in the highlighted folder");
  Assert.equal(promptInput().value, "Here", "prefilled with the page title");
  EventUtils.sendString("sub/");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => !!(await placeOf(url)), "added");
  Assert.deepEqual((await placeOf(url)).folders, ["toolbar", "work", "sub"], "under work/sub");
  await until(() => panel().contains(document.activeElement), "focus is back in the panel");
  Assert.equal(VimmaHost.status(window).mode, "panel", "in panel mode");

  // a with a trailing slash: folders only (neo-tree).
  EventUtils.synthesizeKey("a");
  await until(promptOpen, "a again");
  answer("only/folders/");
  await until(async () => {
    const kids = (await PlacesUtils.promiseBookmarksTree(toolbarGuid)).children[0].children;
    return kids.some((c) => c.title === "only" && c.children?.[0]?.title === "folders");
  }, "a trailing slash makes folders");
  let count = 0;
  await PlacesUtils.bookmarks.fetch({ url }, () => count++);
  Assert.equal(count, 1, "and no bookmark");

  // A: a folder.
  EventUtils.synthesizeKey("A", { shiftKey: true });
  await until(promptOpen, "A asks for a folder");
  answer("Archive");
  await until(() => titles().includes("Archive"), "the folder shows up (live)");

  // r: rename.
  await highlight("Jira");
  EventUtils.synthesizeKey("r");
  await until(promptOpen, "r asks");
  Assert.equal(promptInput().value, "Jira", "prefilled with the title");
  answer("Jira 2");
  await until(() => titles().includes("Jira 2"), "renamed");
  Assert.equal((await placeOf(JIRA)).title, "Jira 2", "in Places");

  // m: move, with completion.
  await highlight("Jira 2");
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m asks");
  Assert.equal(promptInput().value, "work/", "from its folder");
  EventUtils.synthesizeKey("a", { accelKey: true });
  EventUtils.sendString("work/on");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "work/only/", "Tab completes a toolbar folder");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    async () => (await placeOf(JIRA)).folders.join("/") === "toolbar/work/only",
    "moved to work/only",
  );
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m on the toolbar's top");
  EventUtils.synthesizeKey("a", { accelKey: true });
  EventUtils.sendString("too");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(promptInput().value, "too", "no toolbar alias to complete within the toolbar");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !promptOpen(), "Esc");

  // y: copy the URL.
  await highlight("Bar");
  await SimpleTest.promiseClipboardChange(`${PAGE}?bar`, () => EventUtils.synthesizeKey("y"));

  // d: delete after y/N; N keeps it.
  EventUtils.synthesizeKey("d");
  await until(promptOpen, "d asks");
  Assert.stringContains(promptLabel(), "y/N", "a y/N question");
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers no");
  Assert.ok(await placeOf(`${PAGE}?bar`), "kept");
  EventUtils.synthesizeKey("d");
  await until(promptOpen, "d asks again");
  EventUtils.synthesizeKey("y");
  await until(async () => !(await placeOf(`${PAGE}?bar`)), "y deletes it");
  await until(() => !titles().includes("Bar"), "and the row goes");

  await closePanel();
  BrowserTestUtils.removeTab(tab);
  await seed();
});

add_task(async function slash_filters_fuzzily_and_esc_clears_then_closes() {
  const tab = await openPage("filter");
  await openPanel();
  EventUtils.synthesizeKey("/");
  await until(
    () => filterInput() && document.activeElement === filterInput(),
    "/ focuses the filter",
  );
  EventUtils.sendString("mdn");
  await until(() => titles().length === 1 && titles()[0] === "MDN", "fuzzy over every bookmark");
  Assert.equal(
    rows()[0].querySelector(".vimma-panel-host").textContent,
    "work/docs",
    "with its folder path",
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => panel().contains(document.activeElement) && document.activeElement !== filterInput(),
    "Enter returns the keys to the list",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => titles().includes("work"), "Esc clears the filter");
  Assert.ok(isOpen(), "and keeps the panel open");
  EventUtils.synthesizeKey("/");
  await until(() => document.activeElement === filterInput(), "/ again");
  EventUtils.sendString("jira");
  await until(() => titles()[0] === "Jira", "Jira");
  EventUtils.synthesizeKey("KEY_Enter");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter opens the match");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, JIRA);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function places_changes_show_live_and_the_observer_goes_on_close() {
  const tab = await openPage("live");
  await openPanel();
  const state = VimmaHost._state(window);
  Assert.ok(state.bookmarks.observing, "listening while open");
  await PlacesUtils.bookmarks.insert({ parentGuid: menuGuid, title: "Menu only", url: MENU });
  const added = await PlacesUtils.bookmarks.insert({
    parentGuid: toolbarGuid,
    title: "From the Library",
    url: `${PAGE}?library`,
  });
  await until(() => titles().includes("From the Library"), "an insert elsewhere shows up");
  Assert.ok(!titles().includes("Menu only"), "one outside the toolbar does not");
  const docs = (await PlacesUtils.promiseBookmarksTree(toolbarGuid)).children[0].children[0];
  await PlacesUtils.bookmarks.update({ guid: added.guid, parentGuid: docs.guid, index: 0 });
  await until(() => !titles().includes("From the Library"), "a move within the toolbar shows");
  await PlacesUtils.bookmarks.update({
    guid: added.guid,
    parentGuid: toolbarGuid,
    index: PlacesUtils.bookmarks.DEFAULT_INDEX,
  });
  await until(() => titles().includes("From the Library"), "and back to the top");
  await PlacesUtils.bookmarks.update({ guid: added.guid, title: "Renamed elsewhere" });
  await until(() => titles().includes("Renamed elsewhere"), "a rename too");
  await PlacesUtils.bookmarks.remove(added.guid);
  await until(() => !titles().includes("Renamed elsewhere"), "and a removal");
  await closePanel();
  Assert.ok(!state.bookmarks.observing, "the observer is removed on close");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_private_windows_load_leaves_no_history() {
  const url = `${PAGE}?private`;
  await PlacesUtils.bookmarks.insert({ parentGuid: toolbarGuid, title: "Private", url });
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, `${PAGE}?start`);
  await BrowserTestUtils.browserLoaded(browser);
  await SimpleTest.promiseFocus(win);
  await SimpleTest.promiseFocus(browser);
  prefix("B", { shiftKey: true }, win);
  await until(
    () => isOpen(win) && titles(win).includes("Private"),
    "the panel in the private window",
  );
  const target = titles(win).indexOf("Private");
  for (let i = rows(win).indexOf(selected(win)); i < target; i++) {
    EventUtils.synthesizeKey("j", {}, win);
  }
  await until(() => title(selected(win)) === "Private", "highlighted");
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await BrowserTestUtils.browserLoaded(browser, false, url);
  Assert.ok(!isOpen(win), "closed");
  Assert.ok(!(await PlacesUtils.history.hasVisits(url)), "no history entry");
  Assert.ok(!isOpen(), "the main window's panel never opened");
  await BrowserTestUtils.closeWindow(win);
  await SimpleTest.promiseFocus(window);
  await seed();
});

add_task(async function two_thousand_bookmarks_stay_fast() {
  const children = Array.from({ length: 2000 }, (_, i) => ({
    title: `item ${i}`,
    url: `${PAGE}?item${i}`,
  }));
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [{ title: "big", type: PlacesUtils.bookmarks.TYPE_FOLDER, children }],
  });
  const tab = await openPage("perf");
  let t0 = performance.now();
  await openPanel();
  const openMs = performance.now() - t0;
  await highlight("big");
  t0 = performance.now();
  EventUtils.synthesizeKey("l");
  await until(() => titles().includes("item 0"), "the folder opens");
  const expandMs = performance.now() - t0;
  Assert.lessOrEqual(rows().length, RENDER_CAP, `at most ${RENDER_CAP} rows in the DOM`);
  Assert.ok(panel().textContent.includes("more"), "with a 'more' marker for the rest");
  t0 = performance.now();
  for (let i = 0; i < 150; i++) EventUtils.synthesizeKey("j");
  await until(() => title(selected()) === "item 149", "j walks past the rendered window");
  const moveMs = performance.now() - t0;
  Assert.lessOrEqual(rows().length, RENDER_CAP, "still capped");
  EventUtils.synthesizeKey("/");
  await until(() => document.activeElement === filterInput(), "filter");
  t0 = performance.now();
  EventUtils.sendString("item 1999");
  await until(() => titles()[0] === "item 1999", "the best match first");
  const filterMs = performance.now() - t0;
  info(
    `open ${openMs | 0} ms, expand ${expandMs | 0} ms, 150×j ${moveMs | 0} ms, filter ${filterMs | 0} ms`,
  );
  // Generous for a busy 2-CPU runner; the DOM cap above is the real guard.
  Assert.less(expandMs, 2000, "expanding 2,000 items is quick");
  Assert.less(moveMs, 3000, "moving through them is quick");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
  await seed();
});

// `[bookmarks] root = "all"`: the tree as it was before the toolbar default, from the Menu, with
// toolbar and other as its first folders, the root aliases and root folders that refuse.
add_task(async function root_all_shows_the_whole_tree_from_the_menu() {
  const tab = await openPage("all");
  setRoot("all");
  await openPanel();
  Assert.deepEqual(
    titles(),
    ["toolbar", "other", "In the menu"],
    "rooted at the Menu, toolbar and other first",
  );
  Assert.equal(header(), "Bookmarks", "the header says Bookmarks");
  await highlight("toolbar");
  EventUtils.synthesizeKey("l");
  await until(() => titles().includes("work"), "the toolbar opens as a folder");
  await highlight("toolbar");
  EventUtils.synthesizeKey("d");
  await until(() => noticeText() === "toolbar is a root folder: it can't be changed", "refused");
  Assert.ok(!promptOpen(), "no question");
  await closePanel();

  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("bookmark other/All page");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => !!(await placeOf(`${PAGE}?all`)), ":bookmark with the other alias");
  Assert.equal((await placeOf(`${PAGE}?all`)).parentGuid, unfiledGuid, "in Other Bookmarks");

  // Switching back while open re-reads at the toolbar.
  await openPanel();
  setRoot("toolbar");
  await until(() => titles()[0] === "work", "back to the toolbar's contents");
  Assert.ok(!titles().includes("toolbar"), "no toolbar row");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
  await seed();
});

add_task(async function an_empty_toolbar_says_what_the_panel_shows() {
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.bookmarks.insert({ parentGuid: menuGuid, title: "In the menu", url: MENU });
  const tab = await openPage("Empty");
  await focusPage();
  prefix("B", { shiftKey: true });
  await until(() => isOpen() && emptyState(), "the empty state shows");
  Assert.equal(rows().length, 0, "no rows");
  const text = emptyState().textContent;
  Assert.stringContains(text, "This panel shows the Bookmarks Toolbar", "says what it shows");
  Assert.stringContains(text, "Press a to add the current page", "how to add");
  Assert.stringContains(text, 'root = "all"', "how to list every bookmark");
  Assert.stringContains(text, "[bookmarks]", "and where");
  Assert.equal(emptyState().querySelector("kbd")?.textContent, "a", "the key stands out");

  EventUtils.synthesizeKey("a");
  await until(promptOpen, "a asks");
  Assert.stringContains(promptLabel(), "bookmarks toolbar/", "to add at the toolbar's top");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(async () => (await placeOf(`${PAGE}?Empty`))?.parentGuid === toolbarGuid, "added");
  await until(() => !emptyState() && titles().includes("Empty"), "the panel lists it, live");
  await PlacesUtils.bookmarks.eraseEverything();
  await until(emptyState, "emptied elsewhere, the empty state is back");

  setRoot("all");
  await until(() => !emptyState() && titles()[0] === "toolbar", "root all: no empty state");
  setRoot("toolbar");
  await until(emptyState, "and back");
  await closePanel();
  BrowserTestUtils.removeTab(tab);
  await seed();
});
