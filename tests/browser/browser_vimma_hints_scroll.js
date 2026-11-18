/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-hints.md (Limits, the "Since changed" note on scrolling; issue #1308).
// Labels drawn while a smooth scroll runs go where the targets are once it ends: `d f` finishes
// the scroll that `d` started before collecting, and a wheel scroll while labels show draws them
// again where that scroll ends. A target the scroll took off screen gets no label.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
/** 2,000 links down a long page, one per line. */
const LONG = DIR + "file_vimma_hints_many.html";
/** Sections of links 500 px tall, with mandatory snap points at their tops. */
const SNAP = DIR + "file_vimma_hints_scroll.html?snap";
/** 300 links in an inner scroller (`#box`), focused, so that the scroll keys move it. */
const INNER = DIR + "file_vimma_hints_scroll.html?inner";

/** The labels drawn in chrome, by label. */
function drawnLabels() {
  const overlay = document.getElementById("vimma-hints");
  if (!overlay) return new Map();
  const shown = /** @type {HTMLElement[]} */ ([
    ...overlay.querySelectorAll(".vimma-hint:not([hidden])"),
  ]);
  return new Map(shown.map((el) => [el.dataset.label, el]));
}

/**
 * Smooth scrolling on and slow, so that a scroll is still running when the next key arrives,
 * also on a fast machine.
 */
async function slowSmoothScroll() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["general.smoothScroll", true],
      // scrollBy({ behavior: "smooth" }) runs on a spring (ScrollAnimationMSDPhysics.cpp):
      // 250 by default settles in about half a second, 10 in about three.
      ["layout.css.scroll-snap.spring-constant", 10],
      ["general.smoothScroll.msdPhysics.enabled", false],
      ["general.smoothScroll.mouseWheel.durationMinMS", 600],
      ["general.smoothScroll.mouseWheel.durationMaxMS", 600],
    ],
  });
}

/**
 * Opens `url` with content focus in normal mode, then runs `fn`.
 * @param {string} url
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(url, fn) {
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "normal mode",
    );
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
    }
  });
}

/**
 * Where the scroller the keys move is scrolled to: the fixture's `#box` if it has one, else
 * the page.
 * @param {XULBrowserElement} browser
 * @returns {Promise<number>}
 */
function scrollPos(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const box = content.document.getElementById("box");
    return box ? box.scrollTop : content.scrollY;
  });
}

/**
 * Waits until the scroll position (scrollPos) holds still over a few frames.
 * @param {XULBrowserElement} browser
 * @returns {Promise<number>} the settled position
 */
async function settledScroll(browser) {
  /** @type {number} */
  let y = -1;
  await TestUtils.waitForCondition(async () => {
    const [a, b] = await SpecialPowers.spawn(browser, [], async () => {
      const frame = () => new Promise((r) => content.requestAnimationFrame(r));
      const box = content.document.getElementById("box");
      const pos = () => (box ? box.scrollTop : content.scrollY);
      const first = pos();
      for (let i = 0; i < 6; i++) await frame();
      return [first, pos()];
    });
    y = b;
    return a === b;
  }, "the scroll has ended");
  return y;
}

/**
 * The hints shown now, each with its label's rect in the page's CSS pixels and its link's
 * rect where the page is now, after the scroll ended.
 * @param {XULBrowserElement} browser
 */
async function labelsAndTargets(browser) {
  const hints = /** @type {HostHints} */ (VimmaHost._hints(window)).hints;
  const drawn = drawnLabels();
  const box = browser.getBoundingClientRect();
  const zoom = browser.fullZoom;
  const hashes = hints.map((h) => new URL(h.target.href ?? "about:blank").hash);
  const page = await SpecialPowers.spawn(browser, [hashes], (list) => {
    const doc = content.document;
    return {
      vw: doc.documentElement.clientWidth,
      vh: doc.documentElement.clientHeight,
      rects: list.map((hash) => {
        const el = doc.querySelector(`a[href="${hash}"]`);
        const r = el?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      }),
    };
  });
  return hints.map((h, i) => {
    const el = drawn.get(h.label);
    const r = el?.getBoundingClientRect();
    return {
      label: h.label,
      hash: hashes[i],
      labelRect: r
        ? {
            x: (r.left - box.left) / zoom,
            y: (r.top - box.top) / zoom,
            width: r.width / zoom,
            height: r.height / zoom,
          }
        : null,
      target: page.rects[i],
      vw: page.vw,
      vh: page.vh,
    };
  });
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Every label shown sits on its link where the link is now, and every labelled link is on
 * screen now.
 * @param {XULBrowserElement} browser
 */
async function assertLabelsOnTargets(browser) {
  const rows = await labelsAndTargets(browser);
  Assert.greater(rows.length, 10, "a screenful of links has labels");
  let wrong = 0;
  for (const row of rows) {
    const { target, labelRect } = row;
    Assert.ok(target && labelRect, `${row.label} (${row.hash}): its link and label exist`);
    if (!target || !labelRect) continue;
    const view = { x: 0, y: 0, width: row.vw, height: row.vh };
    const onScreen = overlaps(target, view);
    const onTarget = overlaps(labelRect, target);
    if (!onScreen || !onTarget) {
      wrong++;
      // One line per wrong label, not one assertion per label: a page of them is unreadable.
      if (wrong <= 5) {
        info(
          `${row.label} (${row.hash}): link at y ${target.y.toFixed(1)}, ` +
            `label at y ${labelRect.y.toFixed(1)}, viewport ${row.vh}`,
        );
      }
    }
    if (!onScreen) Assert.ok(false, `${row.hash} is off screen after the scroll, has no label`);
  }
  Assert.equal(wrong, 0, "every label sits on its link where the scroll ended");
}

/**
 * Presses `f` and waits for its labels.
 * @returns {Promise<number>} ms from the key to the labels
 */
async function pressFAndWait() {
  const runs = VimmaHost._hintRuns;
  const t0 = performance.now();
  EventUtils.synthesizeKey("f");
  await TestUtils.waitForCondition(
    () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
    "labels are drawn",
    5,
    2000,
  );
  return performance.now() - t0;
}

/**
 * Presses `f`, then `Esc` once the labels are up: the first collection in a tab loads what
 * later ones reuse, so latency is measured after it.
 */
async function warmUp() {
  await pressFAndWait();
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "hints are gone");
}

/**
 * Wheels over the middle of the page.
 * @param {XULBrowserElement} browser
 * @param {number} deltaY
 */
function wheel(browser, deltaY) {
  const box = browser.getBoundingClientRect();
  EventUtils.synthesizeWheel(browser, box.width / 2, box.height / 2, {
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    deltaY,
  });
}

add_task(async function d_then_f_labels_the_targets_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    await warmUp();
    // At rest: the baseline for the latency of `f`.
    const idleMs = await pressFAndWait();
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "hints are gone");

    EventUtils.synthesizeKey("d");
    const scrollingMs = await pressFAndWait();
    info(`f to labels: ${idleMs.toFixed(1)} ms at rest, ${scrollingMs.toFixed(1)} ms after d`);
    const y = await settledScroll(browser);
    Assert.greater(y, 0, "d scrolled the page");
    await assertLabelsOnTargets(browser);
    // Generous, against an order-of-magnitude regression: waiting out a three-second scroll is
    // not the fix.
    Assert.less(scrollingMs, 1000, "labels come up without waiting for the scroll");
  });
});

add_task(async function j_j_j_then_f_labels_the_targets_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    for (const k of "jjj") EventUtils.synthesizeKey(k);
    await pressFAndWait();
    Assert.greater(await settledScroll(browser), 0, "j scrolled the page");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function an_earlier_scroll_s_scrollend_does_not_end_d() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    // An instant scroll's scroll and scrollend come at the next refresh. Holding the refresh
    // driver makes them arrive after d has started, as they did on a busy runner: that
    // scrollend is not d's, and f must still end d's scroll before collecting.
    await SpecialPowers.spawn(browser, [], () => {
      content.windowUtils.advanceTimeAndRefresh(0);
      content.scrollTo({ top: 3000, behavior: "instant" });
    });
    EventUtils.synthesizeKey("d");
    await SpecialPowers.spawn(browser, [], () => content.windowUtils.restoreNormalRefresh());
    await TestUtils.waitForCondition(
      async () => (await scrollPos(browser)) > 3010,
      "d's scroll is under way",
    );
    await pressFAndWait();
    Assert.greater(await settledScroll(browser), 3000, "d scrolled the page");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function d_then_f_in_an_inner_scroller_labels_where_it_ends() {
  await slowSmoothScroll();
  await withPage(INNER, async (browser) => {
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("box")?.focus());
    EventUtils.synthesizeKey("d");
    await pressFAndWait();
    Assert.greater(await settledScroll(browser), 0, "d scrolled the inner scroller");
    await assertLabelsOnTargets(browser);
  });
});

/**
 * Smooth scrolling on, with the shipped spring (about half a second): for the cases where the
 * collection waits for the scroll to end, which it does for at most a second.
 */
async function shippedSmoothScroll() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["general.smoothScroll", true],
      ["layout.css.scroll-snap.spring-constant", 250],
    ],
  });
}

add_task(async function j_then_f_on_a_snapping_page_keeps_the_snapped_scroll() {
  await shippedSmoothScroll();
  await withPage(SNAP, async (browser) => {
    // j is far less than a section: snapping takes the scroll on to the next snap point. Ending
    // it must not snap it back to where it started.
    EventUtils.synthesizeKey("j");
    const ms = await pressFAndWait();
    info(`f to labels after j on a snapping page: ${ms.toFixed(1)} ms`);
    Assert.equal(await settledScroll(browser), 500, "the page is at the next snap point");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_back_during_d_is_not_undone_by_f() {
  await shippedSmoothScroll();
  await withPage(LONG, async (browser) => {
    const start = 3000;
    const half = await SpecialPowers.spawn(browser, [start], (y) => {
      content.scrollTo({ top: y, behavior: "instant" });
      return Math.round(content.document.documentElement.clientHeight / 2);
    });
    EventUtils.synthesizeKey("d");
    await TestUtils.waitForCondition(
      async () => (await scrollPos(browser)) > start + 10,
      "d's scroll is under way",
    );
    const before = await scrollPos(browser);
    wheel(browser, -300);
    await TestUtils.waitForCondition(
      async () => (await scrollPos(browser)) < before - 10,
      "the wheel scrolls back",
    );
    await pressFAndWait();
    const y = await settledScroll(browser);
    Assert.less(y, start + half - 50, `the wheel's scroll stays (d went to ${start + half})`);
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_while_labels_show_draws_them_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    await pressFAndWait();
    const runs = VimmaHost._hintRuns;
    const t0 = performance.now();
    wheel(browser, 300);
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn again after the wheel",
    );
    info(`wheel to labels drawn again: ${(performance.now() - t0).toFixed(1)} ms`);
    Assert.ok(VimmaHost._hints(window), "still in hint mode");
    const y = await settledScroll(browser);
    Assert.greater(y, 0, "the wheel scrolled the page");
    await assertLabelsOnTargets(browser);
  });
});
