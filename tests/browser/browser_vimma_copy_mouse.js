/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-copy-mode.md (mouse selection). A selection made with the mouse in normal
// mode enters copy mode with it; Firefox's own copying (ctrl+c, the context menu, the primary
// selection) keeps working.

/* global focusContent -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_copy_motions.html";
const START = "chrome://browser/content/vimma/start/start.html";

/**
 * Opens the fixture with content focus in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(fn) {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await focusContent(browser);
    await waitForMode(browser, "normal");
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._browserMode(browser) !== "normal") EventUtils.synthesizeKey("KEY_Escape");
      await waitForMode(browser, "normal");
    }
  });
}

/**
 * @param {XULBrowserElement} browser
 * @param {string} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
}

/** @param {XULBrowserElement} browser */
function selectedText(browser) {
  return SpecialPowers.spawn(browser, [], () => content.getSelection().toString());
}

/**
 * Drags the mouse over `selector` from x0 to x1 (CSS pixels from its left), at mid-height.
 * @param {XULBrowserElement} browser
 * @param {string} selector
 * @param {number} x0
 * @param {number} x1
 */
async function drag(browser, selector, x0, x1) {
  const y = 8;
  await BrowserTestUtils.synthesizeMouse(selector, x0, y, { type: "mousedown" }, browser);
  for (const x of [x0 + (x1 - x0) / 3, x0 + ((x1 - x0) * 2) / 3, x1]) {
    await BrowserTestUtils.synthesizeMouse(selector, x, y, { type: "mousemove" }, browser);
  }
  await BrowserTestUtils.synthesizeMouse(selector, x1, y, { type: "mouseup" }, browser);
}

/**
 * Clicks `count` times in a row at (x, 8) in `selector` (2: a double click).
 * @param {XULBrowserElement} browser
 * @param {string} selector
 * @param {number} x
 * @param {number} count
 */
async function clicks(browser, selector, x, count) {
  for (let n = 1; n <= count; n++) {
    await BrowserTestUtils.synthesizeMouse(selector, x, 8, { clickCount: n }, browser);
  }
}

/**
 * Lets every message the page's actors sent so far reach the parent: a round trip on the same
 * window's channel arrives after them.
 * @param {XULBrowserElement} browser
 */
async function settle(browser) {
  await SpecialPowers.spawn(browser, [], () => new Promise((r) => content.setTimeout(r, 0)));
  await SpecialPowers.spawn(browser, [], () => {});
}

add_task(async function a_drag_selection_enters_copy_mode_and_y_copies_it() {
  await withPage(async (browser) => {
    await drag(browser, "#words", 1, 96);
    await waitForMode(browser, "visual");
    Assert.equal(VimmaHost.status(window).mode, "visual", "the status bar says VISUAL");
    const text = await selectedText(browser);
    Assert.ok(text.startsWith("alpha"), `the drag selected text: "${text}"`);
    await SimpleTest.promiseClipboardChange(text, () => EventUtils.synthesizeKey("y"));
    await waitForMode(browser, "normal");
  });
});

add_task(async function a_double_click_selects_a_word_and_motions_extend_it() {
  await withPage(async (browser) => {
    await clicks(browser, "#words", 20, 2);
    await waitForMode(browser, "visual");
    Assert.equal(await selectedText(browser), "alpha", "the double click selected alpha");
    EventUtils.synthesizeKey("e");
    await TestUtils.waitForCondition(
      async () => (await selectedText(browser)) === "alpha beta",
      "e extends the mouse selection",
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    Assert.equal(await selectedText(browser), "", "Esc clears it");
  });
});

add_task(async function a_triple_click_enters_copy_mode_with_the_paragraph() {
  await withPage(async (browser) => {
    await clicks(browser, "#find", 20, 3);
    await waitForMode(browser, "visual");
    Assert.equal(
      (await selectedText(browser)).trim(),
      "one,two,three;four",
      "the paragraph is selected",
    );
  });
});

add_task(async function ctrl_c_and_the_context_menu_copy_a_mouse_selection() {
  await withPage(async (browser) => {
    await clicks(browser, "#words", 20, 2);
    await waitForMode(browser, "visual");
    await SimpleTest.promiseClipboardChange("alpha", () =>
      EventUtils.synthesizeKey("c", { accelKey: true }),
    );
    Assert.equal(VimmaHost._browserMode(browser), "visual", "ctrl+c leaves copy mode on");
    SpecialPowers.clipboardCopyString("something else");
    const menu = document.getElementById("contentAreaContextMenu");
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    await BrowserTestUtils.synthesizeMouse(
      "#words",
      20,
      8,
      { type: "contextmenu", button: 2 },
      browser,
    );
    await shown;
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    await SimpleTest.promiseClipboardChange("alpha", () =>
      menu.activateItem(document.getElementById("context-copy")),
    );
    await hidden;
  });
});

add_task(async function the_primary_selection_holds_a_mouse_selection() {
  const primary = Services.clipboard.kSelectionClipboard;
  // macOS has no primary selection; headless mode's clipboard claims one there all the same.
  if (!Services.clipboard.isClipboardTypeSupported(primary) || AppConstants.platform === "macosx") {
    Assert.ok(true, "no primary selection on this platform");
    return;
  }
  await withPage(async (browser) => {
    await clicks(browser, "#find", 20, 2);
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      () => SpecialPowers.getClipboardData("text/plain", primary) === "one",
      "middle-click pastes what the mouse selected",
    );
  });
});

add_task(async function a_click_without_a_selection_stays_in_normal_mode() {
  await withPage(async (browser) => {
    await clicks(browser, "#words", 20, 1);
    await settle(browser);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "a plain click: normal");
    await clicks(browser, "#link", 10, 1);
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec.endsWith("#linked"),
      "the link was followed",
    );
    await settle(browser);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "a link click: normal");
  });
});

add_task(async function a_page_that_selects_by_itself_does_not_enter_copy_mode() {
  await withPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      content.getSelection().selectAllChildren(content.document.getElementById("words"));
    });
    await settle(browser);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "a script's selection: normal");
    await clicks(browser, "#selectme", 10, 1);
    await TestUtils.waitForCondition(
      async () => (await selectedText(browser)) === "a click selects me",
      "the page selected its paragraph on click",
    );
    await settle(browser);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the page's click handler: normal");
  });
});

add_task(async function selecting_in_a_text_field_is_insert_mode_not_copy_mode() {
  await withPage(async (browser) => {
    await drag(browser, "#field", 4, 60);
    await waitForMode(browser, "insert");
    await settle(browser);
    Assert.equal(VimmaHost._browserMode(browser), "insert", "still insert");
  });
});

add_task(async function mouse_selection_works_in_a_split_pane() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const left = tab.linkedBrowser;
  await focusContent(left);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("v");
  await TestUtils.waitForCondition(
    () =>
      gBrowser.selectedTab !== tab &&
      gBrowser.selectedBrowser.currentURI.spec === START &&
      gBrowser.selectedBrowser.contentDocument?.readyState === "complete",
    "a second pane with the start page",
  );
  const right = gBrowser.selectedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(right, false, PAGE);
  BrowserTestUtils.startLoadingURIString(right, PAGE);
  await loaded;
  await focusContent(right);
  await waitForMode(right, "normal");
  await clicks(right, "#words", 20, 2);
  await waitForMode(right, "visual");
  Assert.equal(VimmaHost._browserMode(left), "normal", "the other pane stays in normal mode");
  await SimpleTest.promiseClipboardChange("alpha", () =>
    EventUtils.synthesizeKey("c", { accelKey: true }),
  );
  await SimpleTest.promiseClipboardChange("alpha", () => {
    SpecialPowers.clipboardCopyString("x");
    EventUtils.synthesizeKey("y");
  });
  await waitForMode(right, "normal");
  while (PaneViews.get(window).panes) PaneViews.get(window).close();
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
});
