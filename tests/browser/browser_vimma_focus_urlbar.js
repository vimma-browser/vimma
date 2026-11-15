/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `I` (shift+i) focuses the address bar and selects its text, as ctrl+l does (Firefox's
// Browser:OpenLocation command), from normal and copy mode on every page Vimma's keys reach:
// web pages, about: pages, Settings, the PDF viewer, the start page, a focused frame, a split's
// focused pane, and with the side panel or bookmarks panel open (it closes them first). In
// insert mode `I` is a typed capital I.

"use strict";

/* global focusContent, recordPageKeys, pageKeys, contextOf -- from head.js */
/* global BrowserCommands -- browser window global (browser.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = DIR + "file_vimma_plain.html";
const FRAMED = DIR + "file_vimma_insert_scroll.html";
const PDF = DIR + "file_vimma_test.pdf";
const START = "chrome://browser/content/vimma/start/start.html";

registerCleanupFunction(async () => {
  const view = PaneViews.get(window);
  while (view?.panes) view.close();
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

/**
 * ctrl+b, then `key`.
 * @param {string} key
 * @param {KeyEventOptions} [mods]
 */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** @param {XULBrowserElement} browser @param {string} mode */
function waitForMode(browser, mode) {
  return until(() => VimmaHost._browserMode(browser) === mode, `the tab is in ${mode} mode`);
}

/** Closes the results view ctrl+l may open, then leaves the URL bar the way it found it. */
async function leaveUrlbar() {
  if (gURLBar.view.isOpen) {
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !gURLBar.view.isOpen, "Esc closes the URL bar's results");
  }
  gURLBar.blur();
}

/**
 * Presses I and checks the result: the URL bar has focus with all of its text selected, it shows
 * the selected tab's address, the status bar says INSERT, and `browser`'s page never saw the I.
 * @param {MozTabBrowser} browser  the page I was pressed on: a tab's browser
 * @param {string} what
 */
async function pressIAndExpectUrlbar(browser, what) {
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused, `${what}: I focuses the URL bar`);
  Assert.equal(gURLBar.selectionStart, 0, `${what}: the selection starts at 0`);
  Assert.equal(gURLBar.selectionEnd, gURLBar.value.length, `${what}: and covers the whole address`);
  Assert.equal(gBrowser.selectedBrowser, browser, `${what}: the URL bar is this page's`);
  Assert.equal(VimmaHost.status(window).mode, "insert", `${what}: the status bar says insert`);
}

add_task(async function on_a_web_page_i_selects_the_address_and_esc_returns_to_the_page() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    await pressIAndExpectUrlbar(browser, "web page");
    Assert.equal(gURLBar.value.length > 0, true, "the URL bar holds the address");
    Assert.ok(!(await pageKeys(browser)).includes("I"), "the page never sees the I");
    // Firefox's own Esc (browser.urlbar.focusContentDocumentOnEsc): the first closes the results
    // ctrl+l may open, the next, with the address unchanged, moves focus back into the page.
    if (gURLBar.view.isOpen) {
      EventUtils.synthesizeKey("KEY_Escape");
      await until(() => !gURLBar.view.isOpen, "Esc closes the results");
    }
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => document.activeElement === browser, "Esc returns focus to the page");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "in normal mode");
  });
});

add_task(async function about_pages_settings_and_the_start_page() {
  await BrowserTestUtils.withNewTab("about:robots", async (browser) => {
    Assert.ok(VimmaActors.has(browser), "sanity: about:robots has the actor");
    await focusContent(browser);
    await waitForMode(browser, "normal");
    await pressIAndExpectUrlbar(browser, "about:robots");
    Assert.equal(gURLBar.value, "about:robots", "the URL bar holds about:robots");
    await leaveUrlbar();
  });
  await BrowserTestUtils.withNewTab("about:preferences", async (browser) => {
    await focusContent(browser);
    // Settings focuses its search box on load: Esc first, as the guide says.
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await pressIAndExpectUrlbar(browser, "about:preferences");
    await leaveUrlbar();
  });
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, START, true);
  BrowserCommands.openTab();
  const start = await loaded;
  const browser = start.linkedBrowser;
  await focusContent(browser);
  await waitForMode(browser, "normal");
  await pressIAndExpectUrlbar(browser, "start page");
  await leaveUrlbar();
  BrowserTestUtils.removeTab(start);
});

add_task(async function the_pdf_viewer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  const rendered = BrowserTestUtils.waitForContentEvent(
    browser,
    "textlayerrendered",
    false,
    null,
    true,
  );
  BrowserTestUtils.startLoadingURIString(browser, PDF);
  await rendered;
  Assert.ok(VimmaActors.has(browser), "sanity: the PDF viewer has the actor");
  await focusContent(browser);
  await waitForMode(browser, "normal");
  await pressIAndExpectUrlbar(browser, "PDF viewer");
  Assert.stringContains(gURLBar.value, "file_vimma_test.pdf", "the URL bar holds the PDF's URL");
  await leaveUrlbar();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function with_focus_in_a_frame() {
  await BrowserTestUtils.withNewTab(FRAMED, async (browser) => {
    await focusContent(browser);
    const frame = contextOf(browser).children[0];
    await SpecialPowers.spawn(frame, [], () => {
      content.focus();
      return ContentTaskUtils.waitForCondition(() => content.document.hasFocus(), "frame focus");
    });
    await waitForMode(browser, "normal");
    Assert.ok(
      await SpecialPowers.spawn(frame, [], () => content.document.hasFocus()),
      "sanity: the frame has focus",
    );
    await pressIAndExpectUrlbar(browser, "frame");
    Assert.equal(gURLBar.untrimmedValue, FRAMED, "the top page's address");
    await leaveUrlbar();
  });
});

add_task(async function in_copy_mode_i_leaves_it_and_focuses_the_url_bar() {
  await BrowserTestUtils.withNewTab(FRAMED, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await pressIAndExpectUrlbar(browser, "copy mode");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "copy mode has ended");
    Assert.ok(!(await pageKeys(browser)).includes("I"), "the page never sees the I");
    await leaveUrlbar();
  });
});

add_task(async function in_insert_mode_i_is_a_typed_capital_i() {
  await BrowserTestUtils.withNewTab(FRAMED, async (browser) => {
    await focusContent(browser);
    await SpecialPowers.spawn(browser, [], () =>
      /** @type {HTMLElement} */ (content.document.getElementById("text")).focus(),
    );
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("I", { shiftKey: true });
    await until(() => VimmaHost.status(window).mode === "insert", "still insert");
    const value = () =>
      SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {HTMLInputElement} */ (content.document.getElementById("text")).value,
      );
    await TestUtils.waitForCondition(async () => (await value()) === "I", "I is typed");
    Assert.ok(!gURLBar.focused, "the URL bar does not take focus");
    Assert.equal(document.activeElement, browser, "focus stays in the page");
  });
});

add_task(async function in_a_split_the_focused_panes_url_bar() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PLAIN}?left`);
  const b = /** @type {SplitTab} */ (
    await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PLAIN}?right`)
  );
  await BrowserTestUtils.switchTab(gBrowser, a);
  // Every browser window has its pane view; a read through a missing one throws.
  const view = /** @type {PaneView} */ (PaneViews.get(window));
  Assert.ok(view.split("vertical", { tab: b }).ok, "split left | right");
  await until(() => gBrowser.selectedTab === b, "the new right pane has focus");
  await focusContent(b.linkedBrowser);
  await waitForMode(b.linkedBrowser, "normal");
  await pressIAndExpectUrlbar(b.linkedBrowser, "right pane");
  Assert.stringContains(gURLBar.value, "?right", "the right pane's address");
  await leaveUrlbar();

  view.focus("left");
  await until(() => gBrowser.selectedTab === a, "the left pane has focus");
  await focusContent(a.linkedBrowser);
  await waitForMode(a.linkedBrowser, "normal");
  await pressIAndExpectUrlbar(a.linkedBrowser, "left pane");
  Assert.stringContains(gURLBar.value, "?left", "the left pane's address");
  await leaveUrlbar();
  while (view.panes) view.close();
  BrowserTestUtils.removeTab(a);
  if (b.isConnected) BrowserTestUtils.removeTab(b);
});

add_task(async function with_the_bookmarks_panel_open_i_closes_it_first() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    await focusContent(browser);
    await waitForMode(browser, "normal");
    const state = found(VimmaHost._state(window));
    prefix("B", { shiftKey: true });
    await until(() => state.bookmarks.isOpen, "ctrl+b shift+b opens the bookmarks panel");
    Assert.equal(VimmaHost.status(window).mode, "panel", "sanity: in panel mode");
    await pressIAndExpectUrlbar(browser, "bookmarks panel");
    Assert.ok(!state.bookmarks.isOpen, "the bookmarks panel is closed");
    await leaveUrlbar();
  });
});

add_task(async function with_the_side_panel_open_i_closes_it_first() {
  await found(WindowWorkspaces.get(window)).ready;
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    await focusContent(browser);
    await waitForMode(browser, "normal");
    const state = found(VimmaHost._state(window));
    prefix("b");
    await until(() => state.panel.isOpen, "ctrl+b b opens the side panel");
    Assert.equal(VimmaHost.status(window).mode, "panel", "sanity: in panel mode");
    await pressIAndExpectUrlbar(browser, "side panel");
    Assert.ok(!state.panel.isOpen, "the side panel is closed");
    await leaveUrlbar();
  });
});
