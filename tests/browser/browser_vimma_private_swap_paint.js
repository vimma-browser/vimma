/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/private-swap-macos.md, the mechanism's (Since changed) note on #773. A window
// the macOS swap shows at another size than it was hidden at is shown only once the page in it
// has painted at the new size, or after a short timeout. The page's resize reaches its content
// process after the window's own layout, so a window shown at once drew its page at the old
// size until the content process painted. Headless, so the backend is forced by a test hook,
// and the test slows the page's paint after a resize to tell the two orders apart.

"use strict";

const { NativeSwap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/native-swap.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = ROOT + "file_vimma_plain.html";
/** The normal window's frame before any switch, and the private window's smaller one. */
const FRAME = { x: 40, y: 60, width: 900, height: 700 };
const SMALL = { x: 120, y: 100, width: 700, height: 560 };
/** How long the page takes to paint after its resize: far more than a swap takes without it. */
const SLOW_PAINT_MS = 1500;

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 25, 400);
}

function privateWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && PrivateBrowsingUtils.isWindowPrivate(w),
  );
}

/** ctrl+b, then shift+p, in `win`. @param {Window} win */
function togglePrivate(win) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey("P", { shiftKey: true }, win);
}

/** @param {Window} win */
const frameOf = (win) => ({
  x: win.screenX,
  y: win.screenY,
  width: win.outerWidth,
  height: win.outerHeight,
});

/** @param {BrowserWindow} win */
const hidden = (win) => NativeSwap._windowForTests(win).hidden;

/** @param {Window} win @param {{ x: number, y: number, width: number, height: number }} f */
async function place(win, f) {
  win.moveTo(f.x, f.y);
  win.resizeTo(f.width, f.height);
  await until(
    () => JSON.stringify(frameOf(win)) === JSON.stringify(f),
    `the window is at ${JSON.stringify(f)}`,
  );
}

/** When each window was shown, by the clock content uses too. */
/** @type {Map<Window, number>} */
const shownAt = new Map();
/** @type {{ win: BrowserWindow, visible: boolean }[]} */
const log = [];
log.push = function (/** @type {{ win: BrowserWindow, visible: boolean }} */ e) {
  if (e.visible) shownAt.set(e.win, Date.now());
  return Array.prototype.push.call(this, e);
};

const startFrame = frameOf(window);
const FRAME_ATTRS = ["screenX", "screenY", "width", "height"];
const startAttrs = FRAME_ATTRS.map((a) => document.documentElement.getAttribute(a));

async function teardown() {
  NativeSwap._resetForTests({ force: true, log: [] });
  for (const w of privateWindows()) await BrowserTestUtils.closeWindow(w);
  NativeSwap._resetForTests();
  await SimpleTest.promiseFocus(window);
}

registerCleanupFunction(async () => {
  await teardown();
  await place(window, startFrame);
  FRAME_ATTRS.forEach((a, i) => {
    const v = startAttrs[i];
    if (v === null) document.documentElement.removeAttribute(a);
    else document.documentElement.setAttribute(a, v);
  });
});

/**
 * From the next resize on, `browser`'s page paints only `SLOW_PAINT_MS` later, and records when
 * it first painted at a new size, as `data-painted` on its root.
 * @param {MozBrowser} browser
 */
function slowNextPaint(browser) {
  return SpecialPowers.spawn(browser, [SLOW_PAINT_MS], (ms) => {
    const root = content.document.documentElement;
    const width = content.innerWidth;
    delete root.dataset.painted;
    content.addEventListener(
      "resize",
      () => {
        // The resize event runs in the refresh tick before its paint: the paint waits for it.
        const t = Date.now();
        while (Date.now() - t < ms);
      },
      { once: true },
    );
    content.addEventListener("MozAfterPaint", function onPaint() {
      if (content.innerWidth === width) return;
      root.dataset.painted = String(Date.now());
      content.removeEventListener("MozAfterPaint", onPaint);
    });
  });
}

/** When `browser`'s page first painted at its new size. @param {MozBrowser} browser */
function paintedAt(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const root = content.document.documentElement;
    await ContentTaskUtils.waitForCondition(() => root.dataset.painted, "painted", 25, 400);
    return Number(root.dataset.painted);
  });
}

/**
 * The normal window with `PLAIN` selected, in the private workspace, hidden at FRAME while the
 * private window shows at SMALL; a swap waits at most `paintTimeout` ms for a page to paint.
 */
async function enterThenShrink(paintTimeout = 30_000) {
  NativeSwap._resetForTests({ force: true, log, paintTimeout });
  await place(window, FRAME);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  togglePrivate(window);
  const priv = await opened;
  await until(() => hidden(window) && !hidden(priv), "private is shown in the normal place");
  await place(priv, SMALL);
  return { tab, priv };
}

add_task(async function setup() {
  // MozAfterPaint reaches the page's own listeners, where the test times the page's paints.
  await SpecialPowers.pushPrefEnv({ set: [["dom.send_after_paint_to_content", true]] });
});

add_task(async function a_window_shown_at_a_new_size_waits_for_its_page_to_paint_there() {
  const { tab, priv } = await enterThenShrink();
  try {
    await slowNextPaint(tab.linkedBrowser);
    shownAt.clear();
    await SimpleTest.promiseFocus(priv);
    togglePrivate(priv);
    await until(() => hidden(priv) && !hidden(window), "back to the normal window");
    Assert.deepEqual(frameOf(window), SMALL, "the normal window is at the private window's frame");
    const painted = await paintedAt(tab.linkedBrowser);
    const shown = shownAt.get(window) ?? 0;
    Assert.greaterOrEqual(
      shown,
      painted,
      `the normal window is shown after its page painted at its new size (shown ${
        shown - painted
      } ms after it)`,
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    await teardown();
  }
});

add_task(async function a_page_that_does_not_paint_in_time_does_not_hold_the_swap() {
  const { tab, priv } = await enterThenShrink(100);
  try {
    await slowNextPaint(tab.linkedBrowser);
    shownAt.clear();
    await SimpleTest.promiseFocus(priv);
    togglePrivate(priv);
    await until(() => hidden(priv) && !hidden(window), "back to the normal window");
    const painted = await paintedAt(tab.linkedBrowser);
    const shown = shownAt.get(window) ?? Infinity;
    Assert.less(shown, painted, "shown after the timeout, before the slow page painted");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await teardown();
  }
});

add_task(async function a_window_shown_at_its_own_size_does_not_wait() {
  // Same size: the page needs no new paint, and the swap stays synchronous.
  NativeSwap._resetForTests({ force: true, log, paintTimeout: 30_000 });
  await place(window, FRAME);
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  togglePrivate(window);
  const priv = await opened;
  try {
    await until(() => hidden(window) && !hidden(priv), "private is shown in the normal place");
    await SimpleTest.promiseFocus(priv);
    togglePrivate(priv);
    Assert.ok(hidden(priv) && !hidden(window), "back to the normal window at once");
  } finally {
    await teardown();
  }
});
