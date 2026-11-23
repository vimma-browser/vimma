/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-hints.md (Limits, the "Since changed" note on scrolling; issues #1308 and
// #1337). Labels drawn while a smooth scroll runs go where the targets are once it ends: `d f`
// finishes the scroll that `d` started before collecting, and a wheel scroll while labels show
// draws them again where that scroll ends. A target the scroll took off screen gets no label.
// A scroll the page's own script runs elsewhere (a carousel) neither ends nor holds that wait,
// and a wheel that moved nothing keeps the labels and the keys typed toward them.

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
/** 600 links down the page, and a strip in a corner that the page scrolls every frame. */
const CAROUSEL = DIR + "file_vimma_hints_scroll.html?carousel";
/** SNAP with that strip. */
const SNAP_CAROUSEL = DIR + "file_vimma_hints_scroll.html?snap&carousel";
/** 600 links down a page that takes every wheel for itself (a map, a canvas app). */
const CONSUME = DIR + "file_vimma_hints_scroll.html?consume";
/** 40 links in a frame that the page moves up by 100 px for each wheel down, never scrolling. */
const GLIDE = DIR + "file_vimma_hints_scroll.html?glide";

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
 * Wheels over a point of the page, the middle by default.
 * @param {XULBrowserElement} browser
 * @param {number} deltaY
 * @param {{ x: number, y: number }} [at]  in the page's CSS pixels
 */
function wheel(browser, deltaY, at) {
  const box = browser.getBoundingClientRect();
  const zoom = browser.fullZoom;
  const x = at ? at.x * zoom : box.width / 2;
  const y = at ? at.y * zoom : box.height / 2;
  EventUtils.synthesizeWheel(browser, x, y, { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY });
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

add_task(async function a_snapped_scroll_slow_to_start_is_waited_for() {
  await shippedSmoothScroll();
  await withPage(SNAP, async (browser) => {
    // APZ runs a smooth scroll: it learns of it at the page's next paint, and the page sees its
    // first scroll event only after APZ has moved it. Holding the refresh driver holds both, as
    // a busy runner did for longer than the wait's quiet time (issue #1400). The labels must
    // wait for the snapped scroll, not take the page where it is before the scroll starts.
    await SpecialPowers.spawn(browser, [], () => content.windowUtils.advanceTimeAndRefresh(0));
    EventUtils.synthesizeKey("j");
    const runs = VimmaHost._hintRuns;
    EventUtils.synthesizeKey("f");
    // Held past the quiet time (SETTLE_QUIET_MS) and well within the wait's limit
    // (SETTLE_MAX_MS), so that the scroll has time to run once it is let go.
    await SpecialPowers.spawn(
      browser,
      [],
      () => new Promise((resolve) => content.setTimeout(resolve, 400)),
    );
    await SpecialPowers.spawn(browser, [], () => content.windowUtils.restoreNormalRefresh());
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn",
    );
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

add_task(async function a_carousel_does_not_end_the_wait_for_a_wheel_s_scroll() {
  await slowSmoothScroll();
  await withPage(CAROUSEL, async (browser) => {
    await pressFAndWait();
    const runs = VimmaHost._hintRuns;
    // The strip's scrollend comes every frame: were it the wheel's, the labels would be drawn
    // where the page is while the wheel's scroll still runs.
    wheel(browser, 300);
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn again after the wheel",
    );
    Assert.greater(await settledScroll(browser), 0, "the wheel scrolled the page");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_carousel_does_not_end_the_wait_for_a_snapped_scroll() {
  await shippedSmoothScroll();
  await withPage(SNAP_CAROUSEL, async (browser) => {
    EventUtils.synthesizeKey("j");
    await pressFAndWait();
    Assert.equal(await settledScroll(browser), 500, "the page is at the next snap point");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_over_an_inner_scroller_draws_the_labels_where_it_ends() {
  await slowSmoothScroll();
  await withPage(INNER, async (browser) => {
    await pressFAndWait();
    const box = await SpecialPowers.spawn(browser, [], () => {
      const r = content.document.getElementById("box")?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    Assert.ok(box, "the fixture has its inner scroller");
    const runs = VimmaHost._hintRuns;
    wheel(browser, 300, box ?? undefined);
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn again after the wheel",
    );
    Assert.greater(await settledScroll(browser), 0, "the wheel scrolled the inner scroller");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_forward_during_d_is_not_overridden_by_f() {
  await shippedSmoothScroll();
  await withPage(LONG, async (browser) => {
    const start = 3000;
    const half = await SpecialPowers.spawn(browser, [start], (y) => {
      content.scrollTo({ top: y, behavior: "instant" });
      const win = content.wrappedJSObject;
      win.wheeled = false;
      content.addEventListener("wheel", () => (win.wheeled = true), { passive: true });
      return Math.round(content.document.documentElement.clientHeight / 2);
    });
    EventUtils.synthesizeKey("d");
    await TestUtils.waitForCondition(
      async () => (await scrollPos(browser)) > start + 10,
      "d's scroll is under way",
    );
    // A short wheel the same way takes the scroll over: APZ carries it on past d's end by the
    // wheel's delta, where no step back shows that it is no longer d's.
    wheel(browser, 40);
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.wheeled),
      "the page got the wheel",
    );
    await pressFAndWait();
    const y = await settledScroll(browser);
    Assert.greater(
      Math.abs(y - (start + half)),
      20,
      `the wheel's scroll stays: the page is at ${y}, not at d's end ${start + half}`,
    );
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_d_cancelled_before_it_moved_is_not_jumped_to_its_end() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    const start = 3000;
    await SpecialPowers.spawn(browser, [start], (y) => {
      content.scrollTo({ top: y, behavior: "instant" });
    });
    await settledScroll(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const win = content.wrappedJSObject;
      win.ended = false;
      content.document.addEventListener("scrollend", () => (win.ended = true));
      content.windowUtils.advanceTimeAndRefresh(0);
    });
    EventUtils.synthesizeKey("d");
    // The page's own instant scroll to where it is cancels d's scroll before it moved; its
    // scrollend comes at the next refresh.
    await SpecialPowers.spawn(browser, [], () => {
      content.scrollTo({ top: content.scrollY, behavior: "instant" });
      content.windowUtils.restoreNormalRefresh();
    });
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.ended),
      "the cancel's scrollend came",
    );
    await pressFAndWait();
    Assert.equal(await settledScroll(browser), start, "d's scroll was cancelled and stays so");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_the_page_takes_keeps_the_labels_and_the_keys_typed() {
  await slowSmoothScroll();
  await withPage(CONSUME, async (browser) => {
    await pressFAndWait();
    const hint = /** @type {HostHints} */ (VimmaHost._hints(window)).hints.find(
      (h) => h.label.length === 2,
    );
    Assert.ok(hint, "some label takes two keys");
    if (!hint) return;
    const want = new URL(hint.target.href ?? "about:blank").hash;
    EventUtils.synthesizeKey(hint.label[0]);
    await TestUtils.waitForCondition(
      () => VimmaHost._hints(window)?.typed === hint.label[0],
      "the first key narrowed the labels",
    );
    const runs = VimmaHost._hintRuns;
    const wheels = VimmaHost._hintWheels ?? 0;
    const wheeled = BrowserTestUtils.waitForEvent(window, "wheel", true);
    wheel(browser, 300);
    await wheeled;
    // Typed while Vimma still looks whether the wheel moved the page: kept for the labels it
    // keeps.
    EventUtils.synthesizeKey(hint.label[1]);
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs || (VimmaHost._hintWheels ?? 0) > wheels,
      "the wheel was looked at",
    );
    Assert.equal(VimmaHost._hintRuns, runs, "the labels were not collected again");
    Assert.ok(!VimmaHost._hints(window), "the label typed across the wheel was followed");
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.location.hash),
      "the link was followed",
    );
    Assert.equal(
      await SpecialPowers.spawn(browser, [], () => content.location.hash),
      want,
      "the link under the label typed was followed",
    );
    Assert.equal(await scrollPos(browser), 0, "the page did not scroll");
  });
});

add_task(async function keys_typed_while_a_wheel_moves_the_page_are_not_sent_to_new_labels() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    await pressFAndWait();
    const runs = VimmaHost._hintRuns;
    const wheeled = BrowserTestUtils.waitForEvent(window, "wheel", true);
    wheel(browser, 300);
    await wheeled;
    // Typed blind, toward a label that was hidden: after the scroll that label is another link's.
    EventUtils.synthesizeKey("a");
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn again after the wheel",
    );
    const hints = VimmaHost._hints(window);
    Assert.ok(hints, "still in hint mode: no link was followed");
    Assert.equal(hints?.typed, "", "the key typed during the wheel was dropped");
    Assert.equal(
      await SpecialPowers.spawn(browser, [], () => content.location.hash),
      "",
      "no link was followed",
    );
  });
});

add_task(async function a_wheel_before_the_first_labels_draws_them_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withPage(LONG, async (browser) => {
    await warmUp();
    // Hold the page busy so that the collection `f` asks for waits behind the wheel.
    const busy = SpecialPowers.spawn(browser, [], () => {
      const end = Date.now() + 300;
      while (Date.now() < end);
    });
    EventUtils.synthesizeKey("f");
    const wheeled = BrowserTestUtils.waitForEvent(window, "wheel", true);
    wheel(browser, 300);
    await wheeled;
    Assert.equal(VimmaHost._hints(window)?.hints.length, 0, "the wheel came before the labels");
    await busy;
    await TestUtils.waitForCondition(() => drawnLabels().size > 0, "labels are drawn");
    Assert.greater(await settledScroll(browser), 0, "the wheel scrolled the page");
    await TestUtils.waitForCondition(() => drawnLabels().size > 0, "labels are drawn");
    await assertLabelsOnTargets(browser);
  });
});

add_task(async function a_wheel_that_moves_a_frame_without_scrolling_draws_the_labels_again() {
  await slowSmoothScroll();
  await withPage(GLIDE, async (browser) => {
    await pressFAndWait();
    const first = /** @type {HostHints} */ (VimmaHost._hints(window)).hints[0];
    Assert.ok(first, "the frame's links have labels");
    if (!first) return;
    const hash = new URL(first.target.href ?? "about:blank").hash;
    const before = first.target.rect.y;
    const runs = VimmaHost._hintRuns;
    const wheels = VimmaHost._hintWheels ?? 0;
    // Over the page beside the frame: the page moves the frame up 100 px.
    wheel(browser, 300, { x: 600, y: 100 });
    await TestUtils.waitForCondition(
      () =>
        (VimmaHost._hintWheels ?? 0) > wheels &&
        drawnLabels().size > 0 &&
        (VimmaHost._hints(window)?.hints.length ?? 0) > 0,
      "the labels are back after the wheel",
    );
    Assert.greater(VimmaHost._hintRuns, runs, "the labels were collected again");
    const now = /** @type {HostHints} */ (VimmaHost._hints(window)).hints.find(
      (h) => new URL(h.target.href ?? "about:blank").hash === hash,
    );
    Assert.ok(now, `${hash} still has a label`);
    Assert.less(
      Math.abs((now?.target.rect.y ?? 0) - (before - 100)),
      2,
      `${hash}'s label moved up with its frame`,
    );
  });
});
