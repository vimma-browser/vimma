/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep's mochitest helpers (docs/specs/live-grep.md), shared by browser_vimma_live_grep.js
// and browser_vimma_live_grep_windows.js, which split the suite to keep each file under the
// harness's time limit. Loaded with Services.scriptloader.loadSubScript into the test's scope.

"use strict";

/* global focusContent -- from head.js */
/* exported VimmaHost, WorkspaceStore, PaneViews, leaves, SessionStore, TabStateFlusher */
/* exported GrepMatcher, PAGE, OTHER_SITE, OTHER_WS, def, ww, dialog, isOpen, rows, textOf */
/* exported texts, selectedRow, countText, flagsText, noticeText, scopeTitle, scopeLines */
/* exported closedTitle, closeTitled, closeWindowTitled, ctrlS, until, openFixture, reset */
/* exported openGrep, type, clearQuery, resultsSettle, setupSecondWorkspace */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);
const { GrepMatcher } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/grep-matcher.mjs",
);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const PAGE = `https://example.com${DIR}file_vimma_grep.html`;
const OTHER_SITE = `https://example.org${DIR}file_vimma_grep.html`;
/** The iframe the fixture adds with `frame`: its fixed page on the other site. */
const FRAME_URL = `${OTHER_SITE}?t=${encodeURIComponent("needle in frame")}`;
const GREP_ID = "vimma-grep";
const NOTICE_ID = "vimma-notice";
const OTHER_WS = "grepother";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const ww = () => WindowWorkspaces.get(window);

/** @param {Window} [win] */
const dialog = (win = window) => win.document.getElementById(GREP_ID);
/** @param {Window} [win] */
const isOpen = (win = window) => !!dialog(win)?.open;
/** The result rows, best first (the DOM lists them best first; CSS shows them bottom up). */
/** @param {Window} [win] */
const rows = (win = window) => [...(dialog(win)?.querySelectorAll("[role=option]") ?? [])];
const textOf = (/** @type {Element} */ row) =>
  row.querySelector(".vimma-grep-text")?.textContent ?? "";
/** @param {Window} [win] */
const texts = (win = window) => rows(win).map(textOf);
const selectedRow = () => dialog()?.querySelector("[role=option][aria-selected=true]");
const countText = () => dialog()?.querySelector(".vimma-grep-count")?.textContent ?? "";
const flagsText = () => dialog()?.querySelector(".vimma-grep-flags")?.textContent ?? "";
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
/** The scope box: its title (on its border) and its lines, one per window. */
/** @param {Window} [win] */
const scopeTitle = (win = window) =>
  dialog(win)?.querySelector(".vimma-grep-scope .vimma-grep-title")?.textContent ?? "";
/** @param {Window} [win] */
const scopeLines = (win = window) =>
  [...(dialog(win)?.querySelectorAll(".vimma-grep-scope-line") ?? [])].map((l) => l.textContent);
/** A closed row's title: its text before the URL. */
const closedTitle = (/** @type {Element} */ row) => {
  const text = row.querySelector(".vimma-grep-text");
  const all = text?.textContent ?? "";
  const url = text?.querySelector(".vimma-grep-url")?.textContent;
  return url === undefined ? all : all.slice(0, all.length - url.length - 1);
};

/**
 * Closes a fixture tab of this window with that title, kept by SessionStore.
 * @param {string} title
 */
async function closeTitled(title) {
  const tab = await openFixture({ title, t: "no match in the text" });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
}

/**
 * Opens a normal window on a fixture with that title and closes it, kept by SessionStore.
 * @param {string} title
 */
async function closeWindowTitled(title) {
  const newest = () => SessionStore.getClosedWindowData()[0]?.closedId;
  const before = newest();
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=${encodeURIComponent(title)}`;
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, url);
  await until(() => win.gBrowser.selectedBrowser.contentTitle === title, "titled");
  await TabStateFlusher.flush(win.gBrowser.selectedBrowser);
  await BrowserTestUtils.closeWindow(win);
  await until(() => newest() !== before, "kept as closed");
  await SimpleTest.promiseFocus(window);
}

/** @param {Window} win @param {number} n */
function ctrlS(win = window, n = 1) {
  for (let i = 0; i < n; i++) EventUtils.synthesizeKey("s", { ctrlKey: true }, win);
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * A fixture tab in the current workspace, loaded, with its frames.
 * @param {Record<string, string | number>} params
 * @param {string} [base]
 */
async function openFixture(params, base = PAGE) {
  const url = `${base}?${new URLSearchParams(/** @type {any} */ (params))}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (params.frame) {
    await until(
      () =>
        tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec ===
        FRAME_URL,
      "the frame loaded",
    );
  }
  if (params.title) await until(() => tab.linkedBrowser.contentTitle === params.title, "titled");
  return tab;
}

/** Back to one tab in `main`, the picker closed. */
async function reset() {
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape");
  while (PaneViews.get(window)?.panes) PaneViews.get(window).close();
  ww().switchTo({ id: def("main").id });
  for (const tab of gBrowser.tabs.slice(1)) {
    if (tab !== gBrowser.selectedTab) gBrowser.removeTab(tab);
  }
  if (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
}

registerCleanupFunction(async () => {
  await reset();
  const other = def(OTHER_WS);
  if (other) await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
});

/** ctrl+b f g from the selected page; waits for the dialog. */
async function openGrep(win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  if (win === window) await focusContent(browser);
  else await SimpleTest.promiseFocus(browser);
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey("f", {}, win);
  EventUtils.synthesizeKey("g", {}, win);
  await until(() => isOpen(win), "ctrl+b f g opens live grep");
}

/** @param {string} text @param {Window} [win] */
function type(text, win = window) {
  for (const ch of text) EventUtils.synthesizeKey(ch, {}, win);
}

/** Clears the query word by word (ctrl+u scrolls the preview while it is shown). */
function clearQuery() {
  for (let i = 0; i < 6; i++) EventUtils.synthesizeKey("w", { ctrlKey: true });
}

/** Waits until the list shows `n` rows and the search has settled. */
async function resultsSettle(n, win = window) {
  await until(() => rows(win).length === n && !dialog(win)?.hasAttribute("busy"), `${n} rows`);
}

/** A second workspace, for the scopes past `workspace`; the cleanup deletes it. */
async function setupSecondWorkspace() {
  await ww().ready;
  if (!def(OTHER_WS)) WorkspaceStore.newWorkspace(OTHER_WS);
  await until(() => !!ww().model.workspaces.find((w) => w.name === OTHER_WS), "grepother");
  ww().switchTo({ id: def("main").id });
}
