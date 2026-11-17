/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmark-open.md. `:bookmarkopen [title]` opens a stored bookmark as the
// bookmarks panel's Enter does, and `:bookmarktab [title]` in a new tab: one exact title opens at
// once, anything else opens a picker with the text typed. A bookmarklet goes through the panel's
// path (bookmarklets B10), so `[bookmarks] bookmarklets` decides whether it runs, and typed
// text never becomes a URL or a script.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_bookmarklet_page.html`;
const SHOPPING = `${PAGE}?shopping`;
const GOOGLE = `${PAGE}?google`;
const SHOWS = `${PAGE}?shows`;
const OTHER = `${PAGE}?other`;
const { toolbarGuid, unfiledGuid } = PlacesUtils.bookmarks;

const RAN = "javascript:void(document.title='ran:'+location.origin+':'+typeof ChromeUtils)";
const RAN_TITLE = "ran:https://example.com:undefined";
const ORIGINAL_TITLE = "bookmarklet page";
const DEFAULT_REFUSAL = "javascript: bookmarks don't open from Vimma";
const PICKER = "vimma-bookmark-picker";

/** @param {"none" | "user" | "agent"} level */
function setLevel(level) {
  VimmaHost.configure({ bookmarklets: level });
}

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER));
const pickerOpen = () => !!picker()?.open;
const pickerRows = () => [
  .../** @type {NodeListOf<HTMLElement> | never[]} */ (
    picker()?.querySelectorAll(".vimma-picker-row") ?? []
  ),
];
const rowTitle = (/** @type {Element | null | undefined} */ row) =>
  row?.querySelector(".vimma-picker-title")?.textContent ?? "";
const selectedRow = () => picker()?.querySelector(".vimma-picker-row[aria-selected=true]");
const pickerQuery = () => picker()?.querySelector(".vimma-picker-query")?.textContent ?? "";
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

/** @param {string} line */
async function runCommand(line) {
  await focusContent(gBrowser.selectedBrowser);
  hideNotice();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

async function closePicker() {
  if (!pickerOpen()) return;
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !pickerOpen(), "Esc closes the picker");
}

/** @param {MozTabbrowserTab} keep */
function closeOthers(keep) {
  for (const t of [...gBrowser.tabs]) if (t !== keep) BrowserTestUtils.removeTab(t);
}

add_task(async function setup() {
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesUtils.bookmarks.insertTree({
    guid: toolbarGuid,
    children: [
      { title: "Google Shopping", url: SHOPPING },
      { title: "Google", url: GOOGLE },
      { title: "Ran", url: RAN },
    ],
  });
  await PlacesUtils.bookmarks.insertTree({
    guid: unfiledGuid,
    children: [
      { title: "goodshows", url: SHOWS },
      { title: "Twin", url: OTHER },
      { title: "twin", url: `${OTHER}2` },
    ],
  });
  registerCleanupFunction(async () => {
    setLevel("none");
    await closePicker();
    await PlacesUtils.bookmarks.eraseEverything();
    await PlacesUtils.history.clear();
  });
});

// Behaviour 1, decision 2: one bookmark with exactly that title opens in this tab, as the
// panel's Enter does, and the bookmarks panel closes.
add_task(async function an_exact_title_opens_in_this_tab() {
  const tab = await openPage();
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("B", { shiftKey: true });
  const panel = () => document.getElementById("vimma-bookmarks");
  await until(() => !!panel() && BrowserTestUtils.isVisible(panel()), "the panel is open");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, SHOPPING);
  // As a binding in [modal.panel] would run it: the parsed line, while the panel is open.
  const host = /** @type {any} */ (VimmaHost);
  host._runCommand(host._state(window), {
    kind: "run",
    command: "bookmarkopen",
    action: { id: "bookmark.open" },
    text: "google shopping",
  });
  await loaded;
  Assert.equal(tab, gBrowser.selectedTab, "the same tab");
  Assert.ok(!pickerOpen(), "no picker for one exact title");
  await until(() => !panel() || !BrowserTestUtils.isVisible(panel()), "the panel closes");
  BrowserTestUtils.removeTab(tab);
});

// Behaviour 1, decision 3: the new-tab variant opens it in a new tab, in front.
add_task(async function bookmarktab_opens_a_new_tab_in_front() {
  const tab = await openPage();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, GOOGLE, true);
  await runCommand('bookmarktab "Google"');
  const added = await opened;
  Assert.equal(gBrowser.selectedTab, added, "the new tab is selected");
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "the first tab is unchanged");
  closeOthers(gBrowser.tabs[0]);
});

// Behaviour 2, decision 2: several matches open a picker with the text typed; Enter opens the
// selected row.
add_task(async function several_matches_open_a_picker() {
  const tab = await openPage();
  await runCommand("bookmarkopen goo");
  await until(pickerOpen, "the bookmark picker opens");
  Assert.equal(pickerQuery(), "/goo", "with the text as its query");
  Assert.deepEqual(
    pickerRows().map(rowTitle).sort(),
    ["Google", "Google Shopping", "goodshows"],
    "the matching bookmarks",
  );
  EventUtils.sendString("dsh");
  await until(() => pickerRows().length === 1, "typing narrows it");
  Assert.equal(rowTitle(selectedRow()), "goodshows");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, SHOWS);
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  Assert.ok(!pickerOpen(), "Enter closes the picker");
  BrowserTestUtils.removeTab(tab);
});

// Behaviour 2, decision 3: Enter in :bookmarktab's picker opens the row in a new tab, in front.
add_task(async function bookmarktab_picker_opens_a_new_tab() {
  const tab = await openPage();
  await runCommand("bookmarktab goodsh");
  await until(pickerOpen, "the picker opens");
  await until(() => rowTitle(selectedRow()) === "goodshows", "goodshows is selected");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, SHOWS, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const added = await opened;
  Assert.equal(gBrowser.selectedTab, added, "the new tab is selected");
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "the first tab is unchanged");
  closeOthers(gBrowser.tabs[0]);
});

// Behaviour 2, decision 2: two bookmarks with the same title are never guessed between.
add_task(async function a_shared_title_asks() {
  const tab = await openPage();
  await runCommand("bookmarkopen twin");
  await until(pickerOpen, "the picker opens");
  Assert.equal(pickerRows().length, 2, "both twins");
  await closePicker();
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "nothing opened");
  BrowserTestUtils.removeTab(tab);
});

// Behaviour 3, decision 4: without a title, every bookmark, typing from the first key.
add_task(async function no_title_lists_every_bookmark() {
  const tab = await openPage();
  await runCommand("bookmarkopen");
  await until(pickerOpen, "the picker opens");
  Assert.equal(pickerRows().length, 6, "every bookmark, no folder");
  EventUtils.sendString("shopping");
  await until(() => rowTitle(selectedRow()) === "Google Shopping", "typed from the first key");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
});

// Behaviour 4, decision 6: nothing matches; the typed text is never opened as a URL or run as
// a script.
add_task(async function typed_text_never_opens_or_runs() {
  setLevel("user");
  const tab = await openPage();
  for (const line of ["bookmarkopen zzzz", "bookmarkopen javascript:void(document.title='x')"]) {
    await runCommand(line);
    await until(() => noticeText().startsWith("bookmark: none matches"), `${line}: refused`);
    Assert.ok(!pickerOpen(), "no picker");
  }
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "nothing loaded");
  setLevel("none");
  BrowserTestUtils.removeTab(tab);
});

// Behaviour 5, decision 5, bookmarklets B10: a bookmarklet follows [bookmarks] bookmarklets as
// in the panel.
add_task(async function a_bookmarklet_follows_the_level() {
  setLevel("none");
  let tab = await openPage();
  await runCommand("bookmarkopen Ran");
  await until(() => noticeText().startsWith(DEFAULT_REFUSAL), "none: refused");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  BrowserTestUtils.removeTab(tab);

  setLevel("user");
  tab = await openPage();
  await runCommand("bookmarkopen Ran");
  await until(() => tab.linkedBrowser.contentTitle === RAN_TITLE, "user: it runs in this page");
  Assert.equal(await titleOf(tab), RAN_TITLE, "in the page's origin, with no chrome globals");
  BrowserTestUtils.removeTab(tab);

  // From the picker too.
  tab = await openPage();
  await runCommand("bookmarkopen ra");
  await until(pickerOpen, "the picker opens");
  await until(() => rowTitle(selectedRow()) === "Ran", "Ran is selected");
  Assert.ok(selectedRow()?.textContent?.includes("bookmarklet"), "the row says bookmarklet");
  Assert.ok(!picker()?.textContent?.includes("ChromeUtils"), "the script is not shown");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => tab.linkedBrowser.contentTitle === RAN_TITLE, "Enter runs it");
  BrowserTestUtils.removeTab(tab);
  setLevel("none");
});

// Behaviour 5, bookmarklets B7: in a new tab the script would run on an empty page: refused.
add_task(async function bookmarktab_refuses_a_bookmarklet() {
  setLevel("user");
  const tab = await openPage();
  const tabs = gBrowser.tabs.length;
  await runCommand("bookmarktab Ran");
  await until(
    () => noticeText().startsWith("a bookmarklet runs in this page: :bookmarkopen runs it"),
    "refused with the command that runs it",
  );
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  setLevel("none");
  BrowserTestUtils.removeTab(tab);
});

// Decision 6: a row is checked again before it opens. A bookmark that became a bookmarklet
// while the picker was open is refused, not run under its old row.
add_task(async function a_row_that_changed_is_refused() {
  setLevel("user");
  const tab = await openPage();
  await runCommand("bookmarkopen goodsh");
  await until(pickerOpen, "the picker opens");
  await until(() => rowTitle(selectedRow()) === "goodshows", "goodshows is selected");
  const bm = /** @type {{ guid: string }} */ (await PlacesUtils.bookmarks.fetch({ url: SHOWS }));
  await PlacesUtils.bookmarks.update({ guid: bm.guid, url: RAN });
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().startsWith("bookmark: it changed"), "refused");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  await PlacesUtils.bookmarks.update({ guid: bm.guid, url: SHOWS });
  setLevel("none");
  BrowserTestUtils.removeTab(tab);
});

// Decision 6: a bookmarklet runs only on the page the user was on when they asked.
add_task(async function a_page_that_changed_runs_nothing() {
  setLevel("user");
  const tab = await openPage();
  await runCommand("bookmarkopen ra");
  await until(pickerOpen, "the picker opens");
  await until(() => rowTitle(selectedRow()) === "Ran", "Ran is selected");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, OTHER);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, OTHER);
  await loaded;
  Assert.ok(pickerOpen(), "the picker is still open");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().startsWith("bookmark: the page changed"), "refused");
  Assert.equal(await titleOf(tab), ORIGINAL_TITLE, "no script ran");
  setLevel("none");
  BrowserTestUtils.removeTab(tab);
});
