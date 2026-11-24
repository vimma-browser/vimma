/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/scroll-area.md (issue #1526). Which scroll area the scroll keys move: `gs`
// and `gS` cycle it, a count picks one, a click picks the one under it, and a new document
// starts again from the default rule (docs/specs/m1-actor-insert-scroll.md).

/* global focusContent -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_scroll_area.html";

/** Vimma's j/k step, in CSS pixels. */
const STEP = 60;

/**
 * Opens the two-panel fixture in a new tab with content focus and waits for normal mode.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 * @param {string} [url]
 */
async function withPage(fn, url = PAGE) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the tab is in normal mode",
    );
    await fn(browser);
  });
}

/**
 * Where each panel is scrolled to.
 * @param {XULBrowserElement} browser
 * @returns {Promise<{ tree: number, main: number }>}
 */
function panels(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    tree: /** @type {HTMLElement} */ (content.document.getElementById("tree")).scrollTop,
    main: /** @type {HTMLElement} */ (content.document.getElementById("main")).scrollTop,
  }));
}

/**
 * @param {XULBrowserElement} browser
 * @param {{ tree: number, main: number }} want
 * @param {string} msg
 */
async function waitForPanels(browser, want, msg) {
  await TestUtils.waitForCondition(async () => {
    const now = await panels(browser);
    return now.tree === want.tree && now.main === want.main;
  }, msg).catch(() => {});
  // On a timeout, the assertion says where the panels were instead.
  Assert.deepEqual(await panels(browser), want, msg);
}

/** @param {string[]} keys */
function press(...keys) {
  for (const k of keys) EventUtils.synthesizeKey(k);
}

/**
 * The scroll-area marker the selected tab's status bar shows.
 * @returns {boolean}
 */
function marked() {
  return !!(/** @type {{ scrollArea?: boolean }} */ (VimmaHost.status(window)).scrollArea);
}

add_task(async function j_scrolls_the_larger_panel_and_gs_moves_it_to_the_other() {
  await withPage(async (browser) => {
    press("j");
    await waitForPanels(browser, { tree: 0, main: STEP }, "j scrolls the larger panel");
    press("g", "s");
    await TestUtils.waitForCondition(marked, "the status bar marks the chosen area");
    press("j");
    await waitForPanels(browser, { tree: STEP, main: STEP }, "after gs, j scrolls the tree");
    press("g", "s");
    await TestUtils.waitForCondition(() => !marked(), "back on the page's own area: no marker");
    press("j");
    await waitForPanels(browser, { tree: STEP, main: 2 * STEP }, "gs again: back to the page");
  });
});

add_task(async function gS_goes_back_and_a_count_picks_the_nth_area() {
  await withPage(async (browser) => {
    press("g", "S");
    press("j");
    await waitForPanels(browser, { tree: STEP, main: 0 }, "gS from the page wraps to the tree");
    press("2", "g", "s");
    press("j");
    await waitForPanels(browser, { tree: STEP, main: STEP }, "2gs picks the second area");
    press("1", "g", "s");
    press("j");
    await waitForPanels(browser, { tree: 2 * STEP, main: STEP }, "1gs picks the first area");
    press("3", "g", "s");
    press("j");
    await waitForPanels(browser, { tree: 3 * STEP, main: STEP }, "3gs, with two areas, keeps it");
  });
});

add_task(async function every_scroll_key_follows_the_chosen_area() {
  await withPage(async (browser) => {
    press("g", "s");
    press("G");
    const max = await SpecialPowers.spawn(browser, [], () => {
      const tree = /** @type {HTMLElement} */ (content.document.getElementById("tree"));
      return tree.scrollHeight - tree.clientHeight;
    });
    await waitForPanels(browser, { tree: max, main: 0 }, "G goes to the tree's end");
    press("g", "g");
    await waitForPanels(browser, { tree: 0, main: 0 }, "gg to the tree's top");
    press("d");
    const half = await SpecialPowers.spawn(browser, [], () =>
      Math.round(
        /** @type {HTMLElement} */ (content.document.getElementById("tree")).clientHeight / 2,
      ),
    );
    await waitForPanels(browser, { tree: half, main: 0 }, "d scrolls half the tree");
  });
});

add_task(async function a_click_in_a_panel_makes_it_the_target() {
  await withPage(async (browser) => {
    await BrowserTestUtils.synthesizeMouseAtCenter("#tree-text", {}, browser);
    await TestUtils.waitForCondition(marked, "the click marks the tree as chosen");
    press("j");
    await waitForPanels(
      browser,
      { tree: STEP, main: 0 },
      "after a click in the tree, j scrolls it",
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#main-text", {}, browser);
    await TestUtils.waitForCondition(() => !marked(), "a click in the page clears the marker");
    press("j");
    await waitForPanels(browser, { tree: STEP, main: STEP }, "a click in the page: j scrolls it");
  });
});

add_task(async function a_click_the_page_dispatches_does_not_move_the_target() {
  await withPage(async (browser) => {
    // An agent's press is dispatched as the page's own script would (VimmaChild #press), so
    // its events are untrusted, like these. Events this test's own code dispatched would be
    // trusted (system principal), so the page's script dispatches them.
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {{ pageClick: (id: string) => void }} */ (
        /** @type {unknown} */ (content.wrappedJSObject)
      ).pageClick("tree-text");
    });
    press("j");
    await waitForPanels(browser, { tree: 0, main: STEP }, "j still scrolls the page");
    Assert.ok(!marked(), "no marker");
  });
});

add_task(async function a_new_document_starts_from_the_default_rule() {
  await withPage(async (browser) => {
    press("g", "s");
    await TestUtils.waitForCondition(marked, "the tree is chosen");
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await reloaded;
    await focusContent(browser);
    await TestUtils.waitForCondition(() => !marked(), "no marker on the new document");
    press("j");
    await waitForPanels(browser, { tree: 0, main: STEP }, "j scrolls the page panel again");
  });
});

add_task(async function gs_outlines_the_chosen_area_briefly_in_chrome() {
  await withPage(async (browser) => {
    press("g", "s");
    const ring = () => document.querySelector("#vimma-scroll-area .vimma-scroll-area-ring");
    await TestUtils.waitForCondition(() => !!ring(), "gs draws an outline over the page");
    const box = /** @type {Element} */ (ring()).getBoundingClientRect();
    const page = browser.getBoundingClientRect();
    const tree = await SpecialPowers.spawn(browser, [], () => {
      const r = /** @type {HTMLElement} */ (
        content.document.getElementById("tree")
      ).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    Assert.lessOrEqual(Math.abs(box.left - page.left - tree.x), 3, "on the tree's left edge");
    Assert.lessOrEqual(Math.abs(box.top - page.top - tree.y), 3, "on its top edge");
    Assert.lessOrEqual(Math.abs(box.width - tree.width), 5, "as wide as the tree");
    await TestUtils.waitForCondition(
      () => !document.querySelector("#vimma-scroll-area"),
      "the outline goes after a moment",
    );
  });
});

add_task(async function gs_reaches_a_cross_origin_frames_document_and_focuses_it() {
  await withPage(async (browser) => {
    const top = /** @type {BrowsingContext} */ (browser.browsingContext);
    const frame = /** @type {BrowsingContext} */ (top.children[0]);
    Assert.ok(frame, "the page panel is a frame");
    await SpecialPowers.spawn(frame, [], () =>
      ContentTaskUtils.waitForCondition(
        () => content.document.readyState === "complete",
        "the frame has loaded",
      ),
    );
    const frameY = () => SpecialPowers.spawn(frame, [], () => content.scrollY);
    const treeY = () =>
      SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {HTMLElement} */ (content.document.getElementById("tree")).scrollTop,
      );
    // The top document does not scroll and the frame element itself does not either: the tree
    // is the largest scroller there, so j moves it.
    press("j");
    await TestUtils.waitForCondition(async () => (await treeY()) === STEP, "j scrolls the tree");
    press("g", "s");
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === frame,
      "gs moves focus into the frame",
    );
    press("j");
    await TestUtils.waitForCondition(async () => (await frameY()) === STEP, "j scrolls the frame");
    Assert.equal(await treeY(), STEP, "the tree stays");
    press("g", "s");
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === top,
      "gs again takes focus back to the top document",
    );
    press("j");
    await TestUtils.waitForCondition(
      async () => (await treeY()) === 2 * STEP,
      "j scrolls the tree again",
    );
    Assert.equal(await frameY(), STEP, "the frame stays");
  }, PAGE + "?frame");
});
