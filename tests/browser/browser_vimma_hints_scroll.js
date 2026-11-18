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
 * Opens the long page with content focus in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withLongPage(fn) {
  await BrowserTestUtils.withNewTab(LONG, async (browser) => {
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
 * Waits until the page's scroll position holds still over a few frames.
 * @param {XULBrowserElement} browser
 * @returns {Promise<number>} the settled scrollY
 */
async function settledScroll(browser) {
  /** @type {number} */
  let y = -1;
  await TestUtils.waitForCondition(async () => {
    const [a, b] = await SpecialPowers.spawn(browser, [], async () => {
      const frame = () => new Promise((r) => content.requestAnimationFrame(r));
      const first = content.scrollY;
      for (let i = 0; i < 6; i++) await frame();
      return [first, content.scrollY];
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

add_task(async function d_then_f_labels_the_targets_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withLongPage(async (browser) => {
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
    // Generous, against an order-of-magnitude regression: waiting out a three-second scroll is not
    // the fix.
    Assert.less(scrollingMs, 1000, "labels come up without waiting for the scroll");
  });
});

add_task(async function a_wheel_while_labels_show_draws_them_where_the_scroll_ends() {
  await slowSmoothScroll();
  await withLongPage(async (browser) => {
    await pressFAndWait();
    const runs = VimmaHost._hintRuns;
    const box = browser.getBoundingClientRect();
    EventUtils.synthesizeWheel(browser, box.width / 2, box.height / 2, {
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 300,
    });
    await TestUtils.waitForCondition(
      () => VimmaHost._hintRuns > runs && drawnLabels().size > 0,
      "labels are drawn again after the wheel",
    );
    Assert.ok(VimmaHost._hints(window), "still in hint mode");
    const y = await settledScroll(browser);
    Assert.greater(y, 0, "the wheel scrolled the page");
    await assertLabelsOnTargets(browser);
  });
});
