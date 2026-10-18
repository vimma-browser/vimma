/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m2-tab-keys.md

"use strict";

const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, bindUnbuiltPrefixKey -- from head.js */

// ctrl+b o: a key under the prefix the host has not built (head.js).
const UNBUILT = bindUnbuiltPrefixKey();

const NOTICE_ID = "vimma-notice";
const PAGE = "https://example.com/";

/** Every tab this file opened is closed again, even when a task fails half-way. */
registerCleanupFunction(() => {
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
});

// Page keys: recordPageKeys and focusContent are awaited before any key is pressed (head.js,
// issues #14, #18).

/** Selects `tab`; BrowserTestUtils.switchTab never resolves for the tab already selected. */
async function select(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
}

/**
 * The next TabOpen. Not BrowserTestUtils.waitForNewTab: it waits for a location other than
 * about:blank, which is what the new-tab page is under the test harness's prefs.
 */
function tabOpened() {
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  // Bounded, so a key that opens nothing fails an assertion instead of timing out the file.
  return Promise.race([
    opened.then((e) => e.target),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
}

/**
 * Selects `tab`, presses z (unbound, so never ours outside help; not j, which scrolls in normal
 * mode) in its page and returns every key the page saw, ending with "z". Content events arrive
 * in order, so a leaked chord key would be listed before the z.
 */
async function pageKeysThenZ(tab) {
  await select(tab);
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  EventUtils.synthesizeKey("z");
  await waitForPageKey(browser, ["z", "!z"]);
  return pageKeys(browser);
}

/** Opens `n` example.com tabs, each recording its keys, and selects the first of them. */
async function openTabs(n) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?tab=${i}`);
    await recordPageKeys(tab.linkedBrowser);
    tabs.push(tab);
  }
  await select(tabs[0]);
  await focusContent(tabs[0].linkedBrowser);
  return tabs;
}

function closeTabs(tabs) {
  for (const tab of tabs) if (!tab.closing && tab.isConnected) BrowserTestUtils.removeTab(tab);
}

/** ctrl+b, then `key` with `mods`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

function visibleIndex(tab = gBrowser.selectedTab) {
  return gBrowser.visibleTabs.indexOf(tab);
}

function notice() {
  return document.getElementById(NOTICE_ID);
}

function noticeShown() {
  const n = notice();
  return !!n && n.matches(":popover-open") && BrowserTestUtils.isVisible(n);
}

add_task(async function prefix_c_opens_a_new_tab() {
  const tabs = await openTabs(1);
  const count = gBrowser.tabs.length;
  const opened = tabOpened();
  prefix("c");
  const tab = await opened;
  Assert.ok(tab, "a tab opened");
  Assert.equal(gBrowser.tabs.length, count + 1, "ctrl+b c adds a tab");
  Assert.equal(gBrowser.selectedTab, tab, "and selects it");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw neither ctrl+b nor c");
  closeTabs([...tabs, tab]);
});

add_task(async function prefix_n_and_p_cycle_through_visible_tabs_and_wrap() {
  const tabs = await openTabs(3);
  const n = gBrowser.visibleTabs.length;
  const start = visibleIndex();

  prefix("n");
  Assert.equal(visibleIndex(), (start + 1) % n, "ctrl+b n selects the next tab");
  prefix("p");
  Assert.equal(visibleIndex(), start, "ctrl+b p selects the previous tab");

  await select(gBrowser.visibleTabs.at(-1));
  prefix("n");
  Assert.equal(visibleIndex(), 0, "ctrl+b n on the last tab wraps to the first");
  prefix("p");
  Assert.equal(visibleIndex(), n - 1, "ctrl+b p on the first tab wraps to the last");

  for (const tab of tabs) {
    Assert.deepEqual(await pageKeysThenZ(tab), ["z"], "no page saw a chord key");
  }
  closeTabs(tabs);
});

add_task(async function prefix_n_skips_hidden_tabs() {
  const tabs = await openTabs(3);
  gBrowser.hideTab(tabs[1]);
  Assert.ok(tabs[1].hidden, "sanity: the middle tab is hidden");
  prefix("n");
  Assert.equal(gBrowser.selectedTab, tabs[2], "ctrl+b n skips the hidden tab");
  prefix("p");
  Assert.equal(gBrowser.selectedTab, tabs[0], "ctrl+b p skips it too");
  gBrowser.showTab(tabs[1]);
  closeTabs(tabs);
});

add_task(async function prefix_digit_selects_tab_n() {
  const tabs = await openTabs(3);
  prefix("3");
  Assert.equal(gBrowser.selectedTab, gBrowser.visibleTabs[2], "ctrl+b 3 selects tab 3");
  prefix("1");
  Assert.equal(gBrowser.selectedTab, gBrowser.visibleTabs[0], "ctrl+b 1 selects tab 1");
  prefix("2");
  Assert.equal(gBrowser.selectedTab, gBrowser.visibleTabs[1], "ctrl+b 2 selects tab 2");
  Assert.ok(!noticeShown(), "no notice for a runnable action");
  for (const tab of tabs) {
    Assert.deepEqual(await pageKeysThenZ(tab), ["z"], "no page saw a chord key");
  }
  closeTabs(tabs);
});

add_task(async function prefix_digit_past_the_last_tab_does_nothing() {
  const tabs = await openTabs(1);
  Assert.less(gBrowser.visibleTabs.length, 9, "sanity: fewer than 9 tabs");
  const selected = gBrowser.selectedTab;
  prefix("9");
  Assert.equal(gBrowser.selectedTab, selected, "ctrl+b 9 with fewer tabs keeps the selection");
  Assert.ok(!noticeShown(), "and shows no notice (Herdr: a silent no-op)");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw neither key");
  closeTabs(tabs);
});

add_task(async function prefix_shift_x_closes_the_selected_tab() {
  const tabs = await openTabs(2);
  const count = gBrowser.tabs.length;
  const closed = BrowserTestUtils.waitForTabClosing(tabs[0]);
  prefix("X", { shiftKey: true });
  await closed;
  Assert.ok(tabs[0].closing, "ctrl+b shift+x closes the selected tab");
  await TestUtils.waitForCondition(() => !tabs[0].isConnected, "the closed tab is removed");
  Assert.equal(gBrowser.tabs.length, count - 1, "and only that one");
  Assert.deepEqual(await pageKeysThenZ(tabs[1]), ["z"], "the next page saw no stray X");
  closeTabs(tabs);
});

add_task(async function tab_keys_work_from_the_url_bar() {
  const tabs = await openTabs(2);
  gURLBar.focus();
  gURLBar.value = "typed";
  prefix("9");
  Assert.equal(gURLBar.value, "typed", "ctrl+b 9 types nothing into the URL bar");
  Assert.equal(gBrowser.selectedTab, tabs[0], "and changes nothing");
  prefix("n");
  Assert.equal(gBrowser.selectedTab, tabs[1], "ctrl+b n from the URL bar selects the next tab");
  closeTabs(tabs);
});

add_task(async function tab_keys_work_from_about_preferences() {
  const tabs = await openTabs(1);
  const prefs = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences");
  await SimpleTest.promiseFocus(prefs.linkedBrowser.contentWindow);
  prefix("p");
  Assert.equal(gBrowser.selectedTab, tabs[0], "ctrl+b p from about:preferences");
  await select(prefs);
  await SimpleTest.promiseFocus(prefs.linkedBrowser.contentWindow);
  const opened = tabOpened();
  prefix("c");
  const tab = await opened;
  Assert.ok(tab, "a tab opened");
  Assert.equal(gBrowser.selectedTab, tab, "ctrl+b c from about:preferences");
  await select(prefs);
  await SimpleTest.promiseFocus(prefs.linkedBrowser.contentWindow);
  const closed = BrowserTestUtils.waitForTabClosing(prefs);
  prefix("X", { shiftKey: true });
  await closed;
  Assert.ok(!prefs.isConnected || prefs.closing, "ctrl+b shift+x closes about:preferences");
  closeTabs([...tabs, tab]);
});

add_task(async function unimplemented_prefix_action_shows_a_notice_that_hides() {
  const tabs = await openTabs(1);
  const count = gBrowser.tabs.length;
  prefix("o"); // history_back: withheld (head.js)
  Assert.ok(noticeShown(), "ctrl+b o shows a notice");
  Assert.equal(notice().textContent, UNBUILT, "naming the action");
  // Through the notice's polite live region; the toast itself is aria-hidden (spec m7-a11y).
  const live = document.getElementById("vimma-notice-live");
  Assert.equal(live?.getAttribute("role"), "status", "announced politely");
  await TestUtils.waitForCondition(() => live.textContent === UNBUILT, "the region says it");
  Assert.equal(document.activeElement, tabs[0].linkedBrowser, "the notice takes no focus");
  Assert.equal(gBrowser.tabs.length, count, "and nothing else happens");
  const shownAt = Date.now();
  await TestUtils.waitForCondition(() => !noticeShown(), "the notice hides by itself", 100, 50);
  const shownFor = Date.now() - shownAt;
  Assert.greater(shownFor, 1000, `it stays up long enough to read (${shownFor} ms)`);
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw neither ctrl+b nor w");
  closeTabs(tabs);
});

add_task(async function passed_through_single_key_shows_no_notice() {
  const tabs = await openTabs(1);
  EventUtils.synthesizeKey("H", { shiftKey: true }); // history.back: withheld (head.js), so the page's
  EventUtils.synthesizeKey("KEY_Escape"); // unbound in normal mode
  Assert.deepEqual(
    await pageKeysThenZ(tabs[0]),
    ["H", "Escape", "z"],
    "H and Esc reach the page, not default-prevented",
  );
  Assert.ok(!noticeShown(), "and show no notice");
  closeTabs(tabs);
});

add_task(async function a_count_before_an_unbuilt_key_shows_the_notice() {
  const tabs = await openTabs(1);
  EventUtils.synthesizeKey("3");
  EventUtils.synthesizeKey("H", { shiftKey: true }); // history.back: withheld (head.js)
  Assert.ok(noticeShown(), "3H shows a notice instead of vanishing");
  Assert.equal(notice().textContent, "Go back: not implemented yet", "naming the action");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw neither 3 nor H");
  notice().hidePopover();
  closeTabs(tabs);
});

add_task(async function no_notice_over_dom_fullscreen() {
  const tabs = await openTabs(1);
  const root = document.documentElement;
  root.setAttribute("inDOMFullscreen", "true"); // as browser-fullScreenAndPointerLock.js does
  try {
    prefix("o");
    Assert.ok(!noticeShown(), "no notice over a fullscreen video");
  } finally {
    root.removeAttribute("inDOMFullscreen");
  }
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "ctrl+b o is still consumed");
  closeTabs(tabs);
});

/** Like pdfjs/test/head.js waitForPdfJS: resolves once the text layer has rendered. */
function loadPdf(browser, url) {
  const rendered = BrowserTestUtils.waitForContentEvent(
    browser,
    "textlayerrendered",
    false,
    null,
    true,
  );
  BrowserTestUtils.startLoadingURIString(browser, url);
  return rendered;
}

add_task(async function tab_keys_work_from_the_pdf_viewer() {
  const tabs = await openTabs(1);
  const pdf = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const root = getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com",
  );
  await loadPdf(pdf.linkedBrowser, root + "file_vimma_test.pdf");
  await SimpleTest.promiseFocus(pdf.linkedBrowser);
  prefix("p");
  Assert.equal(gBrowser.selectedTab, tabs[0], "ctrl+b p from the PDF viewer");
  await select(pdf);
  await SimpleTest.promiseFocus(pdf.linkedBrowser);
  const opened = tabOpened();
  prefix("c");
  const tab = await opened;
  Assert.ok(tab, "ctrl+b c from the PDF viewer opens a tab");
  closeTabs([...tabs, pdf, tab]);
});

add_task(async function pinned_tabs_count_first_and_are_not_closed() {
  const tabs = await openTabs(3);
  // Decision 11 unpins it in a window with workspaces; this checks the guard other windows keep.
  WindowWorkspaces.get(window).unpinsPinnedTabs = false;
  gBrowser.pinTab(tabs[2]);
  Assert.equal(gBrowser.visibleTabs[0], tabs[2], "sanity: a pinned tab moves to the front");
  prefix("1");
  Assert.equal(gBrowser.selectedTab, tabs[2], "ctrl+b 1 selects the pinned tab");
  prefix("p");
  Assert.equal(gBrowser.selectedTab, gBrowser.visibleTabs.at(-1), "ctrl+b p wraps to the last");
  prefix("n");
  Assert.equal(gBrowser.selectedTab, tabs[2], "ctrl+b n wraps back to the pinned tab");

  const count = gBrowser.tabs.length;
  prefix("X", { shiftKey: true });
  Assert.equal(gBrowser.tabs.length, count, "ctrl+b shift+x on a pinned tab closes nothing");
  Assert.equal(
    gBrowser.selectedTab,
    gBrowser.tabs[gBrowser.pinnedTabCount],
    "and selects the first unpinned tab, as ctrl+w does",
  );

  await select(tabs[2]);
  await focusContent(tabs[2].linkedBrowser);
  EventUtils.synthesizeKey("x");
  Assert.equal(gBrowser.tabs.length, count, "x on a pinned tab closes nothing either");
  Assert.equal(gBrowser.selectedTab, gBrowser.tabs[gBrowser.pinnedTabCount], "it moves on");
  gBrowser.unpinTab(tabs[2]);
  WindowWorkspaces.get(window).unpinsPinnedTabs = true;
  closeTabs(tabs);
});

add_task(async function normal_mode_t_x_gt_gT() {
  const tabs = await openTabs(2);
  const count = gBrowser.tabs.length;

  const opened = tabOpened();
  EventUtils.synthesizeKey("t");
  const tab = await opened;
  Assert.ok(tab, "t opens a tab");
  Assert.equal(gBrowser.tabs.length, count + 1, "one tab more");

  // The new tab's URL bar has focus (insert): go back to a page in normal mode for bare keys.
  await select(tabs[1]);
  await focusContent(tabs[1].linkedBrowser);
  const last = gBrowser.visibleTabs.at(-1);
  Assert.equal(last, tab, "sanity: the new tab is last");
  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("t");
  Assert.equal(gBrowser.selectedTab, tab, "gt selects the next tab");

  await select(tabs[0]);
  await focusContent(tabs[0].linkedBrowser);
  const before = visibleIndex();
  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("T", { shiftKey: true });
  Assert.equal(
    visibleIndex(),
    (before - 1 + gBrowser.visibleTabs.length) % gBrowser.visibleTabs.length,
    "gT selects the previous tab",
  );

  await select(tabs[1]);
  await focusContent(tabs[1].linkedBrowser);
  const closed = BrowserTestUtils.waitForTabClosing(tabs[1]);
  EventUtils.synthesizeKey("x");
  await closed;
  Assert.ok(tabs[1].closing, "x closes the selected tab");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "no page saw g, t, T or x");
  closeTabs([...tabs, tab]);
});

/** A new window with one example.com tab, focused, its page in normal mode. */
async function windowWithOneTab() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  await BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SimpleTest.promiseFocus(win);
  await SimpleTest.promiseFocus(browser);
  Assert.equal(win.gBrowser.tabs.length, 1, "sanity: one tab");
  return win;
}

add_task(async function closing_the_last_tab_closes_the_window() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.closeWindowWithLastTab", true]] });
  const win = await windowWithOneTab();
  const closed = BrowserTestUtils.domWindowClosed(win);
  EventUtils.synthesizeKey("x", {}, win);
  await closed;
  Assert.ok(win.closed, "x on the last tab closes the window, as ctrl+w does");
  await SpecialPowers.popPrefEnv();
});

add_task(async function closing_the_last_tab_keeps_the_window_when_firefox_says_so() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.closeWindowWithLastTab", false]] });
  const win = await windowWithOneTab();
  const first = win.gBrowser.selectedTab;
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey("X", { shiftKey: true }, win);
  await TestUtils.waitForCondition(() => !first.isConnected, "the tab is closed");
  Assert.ok(!win.closed, "the window stays (closeWindowWithLastTab = false; M3's setting)");
  Assert.equal(win.gBrowser.tabs.length, 1, "with a fresh tab");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
