/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-actor-insert-scroll.md (view-source: pages get the actor)

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_view_source.html";
/** The page's source, as `gf` and the context menu's View Page Source open it. */
const SOURCE = `view-source:${PAGE}`;

/** Vimma's j/k step (Vimium's scrollStepSize), in CSS pixels. */
const STEP = 60;

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

/**
 * Opens the fixture's source in a new tab with content focus, records the page's keydowns and
 * waits for normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withSource(fn) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(SOURCE, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the source tab is in normal mode",
    );
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
      gBrowser.getCachedFindBar()?.close(true);
    }
  });
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/**
 * @param {XULBrowserElement} browser
 * @param {(y: number) => boolean} predicate
 * @param {string} msg
 */
function waitForScroll(browser, predicate, msg) {
  return TestUtils.waitForCondition(async () => predicate(await pageScrollY(browser)), msg);
}

/** @param {string} text */
function type(text) {
  for (const ch of text) EventUtils.synthesizeKey(ch, ch === "G" ? { shiftKey: true } : {});
}

/**
 * Presses the unbound key and returns every key the page has seen, which ends with it.
 * @param {XULBrowserElement} browser
 */
async function pageKeysThenUnbound(browser) {
  EventUtils.synthesizeKey(UNBOUND);
  Assert.ok(await waitForPageKey(browser, [UNBOUND]), `the page received ${UNBOUND}`);
  return pageKeys(browser);
}

/** The hint labels drawn in chrome, as their text. */
function drawnLabels() {
  const overlay = document.getElementById("vimma-hints");
  if (!overlay) return [];
  return [...overlay.querySelectorAll(".vimma-hint:not([hidden])")].map((el) => el.dataset.label);
}

add_task(async function j_k_G_and_gg_scroll_the_source() {
  await withSource(async (browser) => {
    Assert.equal(VimmaHost.status(window).mode, "normal", "the status bar says normal");
    type("j");
    await waitForScroll(browser, (y) => y === STEP, `j scrolls down ${STEP}px`);
    type("k");
    await waitForScroll(browser, (y) => y === 0, "k scrolls back up");
    const max = await SpecialPowers.spawn(browser, [], () => content.scrollMaxY);
    Assert.greater(max, 1000, "the source is long");
    type("G");
    await waitForScroll(browser, (y) => y === max, "G goes to the bottom");
    type("gg");
    await waitForScroll(browser, (y) => y === 0, "gg goes to the top");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "the page saw no j, k, G, g");
  });
});

add_task(async function slash_finds_text_in_the_source() {
  await withSource(async (browser) => {
    type("/sourceneedle");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      async () =>
        (await SpecialPowers.spawn(browser, [], () => String(content.getSelection()))) ===
        "sourceneedle",
      "/ Enter selects the match in the source",
    );
    await TestUtils.waitForCondition(
      () => VimmaHost.status(window).find?.total === 1,
      "the status counts the one match",
    );
    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND],
      "no key of the search reached the page",
    );
  });
});

add_task(async function f_labels_the_link_in_the_source_and_follows_it() {
  await withSource(async (browser) => {
    type("f");
    await TestUtils.waitForCondition(
      () => VimmaHost._hints(window)?.hints.length && drawnLabels().length,
      "hints are drawn on the source",
    );
    const labels = drawnLabels();
    Assert.equal(labels.length, 1, "the source's one link gets the one label");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, (url) =>
      url.endsWith("?to=target"),
    );
    type(labels[0]);
    await loaded;
    Assert.equal(browser.currentURI.spec, `${SOURCE}?to=target`, "the link opens its source");
  });
});
