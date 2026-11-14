/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 3, decision 21), docs/security/20-pdf-viewer.md section
// 20 (V7, V9): zathura's page, zoom and layout keys in the PDF viewer, presentation mode, and
// jumps.

/* global add_setup -- the browser-chrome harness (browser-test.js) */

/* global contextOf, windowGlobalOf, historyOf -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PDF = ROOT + "file_vimma_outline.pdf";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Instant scrolling: the positions below are read right after a key.
      ["general.smoothScroll", false],
      // The outline shown beside a PDF (pdf-mode decision 19) narrows the viewer as it opens,
      // which pdf.js answers with a relayout of its own; these tests read positions and pages
      // right after keys pressed as the PDF opens. browser_vimma_pdf_outline.js covers it.
      ["vimma.ui.pdf_outline.hidden", true],
    ],
  });
});

/** @param {string} id */
const segment = (id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? "";

/**
 * Like pdfjs/test/head.js waitForPdfJS: resolves once the text layer has rendered.
 * @param {XULBrowserElement} browser
 * @param {string} url
 */
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

/** @param {XULBrowserElement} browser */
async function focusNormal(browser) {
  await SimpleTest.promiseFocus(browser);
  browser.focus();
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === "normal",
    "the PDF viewer is in normal mode",
  );
}

/** @param {(browser: XULBrowserElement) => Promise<void>} fn */
async function withPdf(fn) {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, PDF);
    await TestUtils.waitForCondition(() => segment("page").startsWith("page"), "the page");
    await focusNormal(browser);
    await fn(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * pdf.js's view, read in the content process.
 * @param {XULBrowserElement} browser
 */
function view(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
    // Each of the three is there once a page has rendered; a read of a missing one throws.
    const v = /** @type {PdfJsViewer} */ (app.pdfViewer);
    const container = /** @type {HTMLElement} */ (
      content.document.getElementById("viewerContainer")
    );
    const page = /** @type {Element} */ (
      content.document.querySelector(`#viewer .page[data-page-number="${app.page}"]`)
    );
    const box = page.getBoundingClientRect();
    const port = container.getBoundingClientRect();
    return {
      page: app.page,
      scale: v.currentScale,
      scaleValue: v.currentScaleValue,
      rotation: v.pagesRotation,
      spread: v.spreadMode,
      scroll: v.scrollMode,
      presenting: v.isInPresentationMode,
      scrollTop: container.scrollTop,
      height: container.clientHeight,
      pageTop: Math.round(box.top - port.top),
      pageBottom: Math.round(box.bottom - port.bottom),
    };
  });
}

/** @typedef {Awaited<ReturnType<typeof view>>} View */
/**
 * The wanted fields of the view: each a value, or a test of the value.
 * @typedef {{ [K in keyof View]?: View[K] | ((value: View[K]) => boolean) }} Want
 */

/**
 * Waits until pdf.js's view matches `want`.
 * @param {XULBrowserElement} browser
 * @param {Want} want
 * @param {string} what
 */
async function until(browser, want, what) {
  /** @type {View | null} */
  let last = null;
  await TestUtils.waitForCondition(
    async () => {
      const now = await view(browser);
      last = now;
      return Object.entries(want).every(([k, v]) => {
        const got = now[/** @type {keyof View} */ (k)];
        return typeof v === "function"
          ? /** @type {(value: unknown) => boolean} */ (v)(got)
          : got === v;
      });
    },
    `${what}: want ${JSON.stringify(want, (_k, v) => (typeof v === "function" ? "fn" : v))}`,
  ).catch((e) => {
    Assert.ok(false, `${what}: got ${JSON.stringify(last)}`);
    throw e;
  });
}

/** @param {string} keys  typed one key at a time, as EventUtils.sendString does */
const type = (keys) => EventUtils.sendString(keys);

/**
 * Runs `:name` from the command line and waits for normal mode again.
 * @param {XULBrowserElement} browser
 * @param {string} name
 */
async function command(browser, name) {
  type(`:${name}`);
  EventUtils.synthesizeKey("KEY_Enter");
  await focusNormal(browser);
}

add_task(async function pages() {
  await withPdf(async (browser) => {
    type("J");
    await until(browser, { page: 2 }, "J goes to the next page");
    type("3J");
    await until(browser, { page: 5 }, "3J goes three pages on");
    type("K");
    await until(browser, { page: 4 }, "K goes back a page");
    type("G");
    await until(browser, { page: 6 }, "G goes to the last page");
    type("gg");
    await until(browser, { page: 1 }, "gg goes to the first page");
    type("2G");
    await until(browser, { page: 2 }, "2G goes to page 2");
    await TestUtils.waitForCondition(() => segment("page") === "page ii (2/6)", "the bar follows");
    type("5gg");
    await until(browser, { page: 5 }, "5gg goes to page 5");
    type("99G");
    await until(browser, { page: 6 }, "99G goes to the last page");
    type(":3");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(browser, { page: 3 }, ":3 goes to page 3");
    await focusNormal(browser);
    // zathura's H / L / P are commands (decision 21): the current page's top or bottom.
    await command(browser, "pdf_page_bottom");
    await until(browser, { pageBottom: (b) => Math.abs(b) <= 1 }, ":pdf_page_bottom");
    const page = (await view(browser)).page;
    await command(browser, "pdf_page_top");
    await until(browser, { page, pageTop: (t) => Math.abs(t) <= 1 }, ":pdf_page_top");
  });
});

// Decision 21: Vimma's keys mean in the PDF viewer what they mean on every page, and zathura's
// meanings for them are commands.
add_task(async function vimmas_keys_keep_their_meaning_in_the_pdf_viewer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, PDF);
    await TestUtils.waitForCondition(() => segment("page").startsWith("page"), "the page");
    await focusNormal(browser);
    const before = await view(browser);
    type("d");
    await until(
      browser,
      { scrollTop: (y) => y > before.scrollTop && y < before.scrollTop + before.height },
      "d scrolls half a screen down",
    );
    Assert.equal((await view(browser)).spread, 0, "d leaves the layout alone");
    EventUtils.synthesizeKey("f", { ctrlKey: true });
    await TestUtils.waitForCondition(
      () => gBrowser.getCachedFindBar()?.hidden === false,
      "ctrl+f opens find",
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await focusNormal(browser);
    for (const key of ["r", "KEY_F5"]) {
      const reloaded = BrowserTestUtils.waitForContentEvent(
        browser,
        "textlayerrendered",
        false,
        null,
        true,
      );
      if (key.startsWith("KEY_")) EventUtils.synthesizeKey(key);
      else type(key);
      await reloaded;
      const after = await view(browser);
      Assert.equal(after.rotation, 0, `${key} reloads, and rotates nothing`);
      Assert.equal(after.presenting, false, `${key} starts no presentation`);
      await TestUtils.waitForCondition(() => segment("page").startsWith("page"), "the page");
      await focusNormal(browser);
    }
    type("H");
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec === "https://example.com/",
      "H goes back in history",
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function zoom_and_fit() {
  await withPdf(async (browser) => {
    type("=");
    await until(browser, { scale: 1 }, "= sets 100 %");
    type("+");
    await until(browser, { scale: 1.1 }, "+ zooms in 10 %");
    type("-");
    await until(browser, { scale: 1 }, "- zooms back out");
    type("2+");
    await until(browser, { scale: 1.3 }, "2+ zooms two steps");
    type("zO");
    await until(browser, { scale: 1.1 }, "zO zooms out");
    type("zI");
    await until(browser, { scale: 1.3 }, "zI zooms in");
    type("zZ");
    await until(browser, { scale: 1 }, "zZ sets 100 %");
    type("150=");
    await until(browser, { scale: 1.5 }, "150= sets 150 %");
    type("a");
    await until(browser, { scaleValue: "page-fit" }, "a fits the page");
    type("s");
    await until(browser, { scaleValue: "page-width" }, "s fits the width");
    // pdf.js keeps a named fit across resizes, as zathura keeps its adjust mode.
    const wide = (await view(browser)).scale;
    const { style } = /** @type {XULElement} */ (/** @type {Element} */ (browser));
    style.maxWidth = "400px";
    try {
      await until(
        browser,
        { scaleValue: "page-width", scale: (s) => s < wide },
        "the fit follows a resize",
      );
    } finally {
      style.maxWidth = "";
    }
  });
});

add_task(async function layout() {
  await withPdf(async (browser) => {
    // pdf.js's SpreadMode NONE 0, ODD 1, EVEN 2; ScrollMode VERTICAL 0, PAGE 3.
    // zathura's d and r are :dual and :rotate (decision 21).
    await command(browser, "dual");
    await until(browser, { spread: 2 }, ":dual shows two pages, the first alone");
    type("D");
    await until(browser, { spread: 1 }, "D pairs the first page");
    await command(browser, "dual");
    await until(browser, { spread: 0 }, ":dual goes back to one page");
    await command(browser, "dual");
    await until(browser, { spread: 1 }, ":dual comes back to the last spread");
    await command(browser, "dual");
    await until(browser, { spread: 0 }, "one page again");
    type("D");
    await until(browser, { spread: 2 }, "D from one page shows two");
    await command(browser, "dual");
    await until(browser, { spread: 0 }, "and :dual one again");
    type("w");
    await until(browser, { scroll: 3 }, "w shows one page at a time");
    type("w");
    await until(browser, { scroll: 0 }, "w goes back to scrolling");
    await command(browser, "rotate");
    await until(browser, { rotation: 90 }, ":rotate rotates 90 degrees");
    await command(browser, "rotate");
    await command(browser, "rotate");
    await until(browser, { rotation: 270 }, "twice more");
    await command(browser, "rotate");
    await until(browser, { rotation: 0 }, "and round");
  });
});

add_task(async function presentation() {
  await withPdf(async (browser) => {
    const full = BrowserTestUtils.waitForEvent(window, "fullscreen");
    // zathura's F5 is :present (decision 21); F5 reloads, as on every page.
    type(":present");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(browser, { presenting: true }, ":present starts the presentation");
    await full;
    await TestUtils.waitForCondition(
      () => document.getElementById("fullscreen-warning")?.hasAttribute("onscreen"),
      "Firefox's full-screen warning shows (V9)",
    );
    const page = (await view(browser)).page;
    EventUtils.synthesizeKey("j");
    await until(browser, { page: page + 1 }, "j turns the page");
    EventUtils.synthesizeKey("k");
    await until(browser, { page }, "k turns it back");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(browser, { presenting: false }, "Esc leaves the presentation");
    await TestUtils.waitForCondition(() => !window.fullScreen, "and the full screen");
  });
});

add_task(async function presentation_only_on_the_users_key() {
  await withPdf(async (browser) => {
    // The adapter takes operations from the parent only; a message the viewer's own process
    // sends to the parent is not an operation, and the parent sends one only for a key.
    const actor = windowGlobalOf(contextOf(browser)).getActor("Vimma");
    actor.receiveMessage({ name: "Vimma:PdfOp", data: { op: "presentation", n: 0 } });
    // An F5 the page itself dispatches is untrusted: Vimma's keys never see it.
    await SpecialPowers.spawn(browser, [], () => {
      const init = { key: "F5", code: "F5", bubbles: true, cancelable: true };
      content.document.dispatchEvent(new content.KeyboardEvent("keydown", init));
    });
    // A positive control: a real key after them runs, so they have had their turn.
    type("J");
    await until(browser, { page: 2 }, "the next key runs");
    Assert.equal((await view(browser)).presenting, false, "no presentation from them");
    Assert.ok(!window.fullScreen, "no full screen");
  });
});

add_task(async function the_parent_sends_only_operations_and_numbers() {
  await withPdf(async (browser) => {
    /** @type {unknown[]} */
    const sent = [];
    /** @type {WindowGlobalParent} */
    const wg = windowGlobalOf(contextOf(browser));
    const actor = wg.getActor("Vimma");
    const orig = actor.sendAsyncMessage;
    actor.sendAsyncMessage = function (name, data) {
      if (name === "Vimma:PdfOp") sent.push(data);
      return orig.call(this, name, data);
    };
    try {
      type("3J");
      type("150=");
      await command(browser, "rotate");
      await until(browser, { page: 4, scale: 1.5, rotation: 90 }, "the keys ran");
    } finally {
      actor.sendAsyncMessage = orig;
    }
    Assert.deepEqual(
      sent,
      [
        { op: "next", n: 3 },
        { op: "scale", n: 150 },
        { op: "rotate", n: 0 },
      ],
      "an operation name and a number per key",
    );
    // PdfOps refuses anything else before it reaches the child.
    Assert.ok(!PdfOps.run(browser, "eval", 0), "an unknown operation is not sent");
    Assert.ok(
      !PdfOps.run(browser, "next", /** @type {number} */ (/** @type {unknown} */ ("1"))),
      "text for a number",
    );
    // And the child drops a malformed one without touching pdf.js.
    await SpecialPowers.spawn(browser, [], () => {
      const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
      /** @type {PdfJsViewer} */ (app.pdfViewer).pagesRotation = 0;
    });
    const child = windowGlobalOf(contextOf(browser));
    for (const data of [
      { op: "rotate", n: "1" },
      { op: "rotate", n: 1, x: 1 },
      { op: "toString" },
    ]) {
      child.getActor("Vimma").sendAsyncMessage("Vimma:PdfOp", data);
    }
    await new Promise((r) => setTimeout(r, 300));
    Assert.equal((await view(browser)).rotation, 0, "malformed operations do nothing");
  });
});

// pdf.js learns where its view is from a scroll handler that waits for the viewer's next
// animation frame, and a zoom keeps that recorded place: a zoom right after a page key, before
// the frame, went back to the page the view had left. The viewer's refresh driver is held here
// so the frame cannot come between the keys, as on a loaded machine.
add_task(async function a_zoom_right_after_a_page_key_keeps_the_new_page() {
  await withPdf(async (browser) => {
    for (const [keys, want] of /** @type {[string, number][]} */ ([
      ["3J", 4],
      ["G", 6],
    ])) {
      await SpecialPowers.spawn(browser, [], () => content.windowUtils.advanceTimeAndRefresh(0));
      try {
        type(keys);
        await until(browser, { page: want }, `${keys} moves the view`);
        type("150=");
        await until(browser, { scale: 1.5 }, "150= zooms before the viewer's next frame");
      } finally {
        await SpecialPowers.spawn(browser, [], () => content.windowUtils.restoreNormalRefresh());
      }
      await until(browser, { page: want }, `the zoom after ${keys} stays on page ${want}`);
      type("=");
      await until(browser, { scale: 1 }, "back to 100 %");
      type("gg");
      await until(browser, { page: 1 }, "gg goes back to the first page");
    }
  });
});

add_task(async function jumps() {
  await withPdf(async (browser) => {
    type("4G");
    await until(browser, { page: 4 }, "4G");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 1 }, "ctrl+o comes back from a page jump");
    EventUtils.synthesizeKey("i", { ctrlKey: true });
    await until(browser, { page: 4 }, "ctrl+i goes forward again");
    type("gg");
    await until(browser, { page: 1 }, "gg");
    // A search hit on another page is a jump too (decision 9). "Vimma" is on page 1 and later.
    type("/Vimma");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => segment("find").endsWith("[1/6]"), "the first hit");
    for (let i = 0; i < 5; i++) type("n");
    await TestUtils.waitForCondition(() => segment("find").endsWith("[6/6]"), "the last hit");
    const far = (await view(browser)).page;
    Assert.greater(far, 1, "the last hit is past the first page");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: (p) => p < far }, "ctrl+o comes back from a search hit");
  });
});

// Decision 9: ctrl+o walks back through the jumps inside the PDF one at a time, then leaves it.
// pdf.js's history entries carry no user interaction (Vimma takes the keys in chrome), which
// Firefox's goBack skips (browser.navigation.requireUserInteraction).
add_task(async function jumps_walk_back_one_at_a_time() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, PDF);
    await TestUtils.waitForCondition(() => segment("page").startsWith("page"), "the page");
    await focusNormal(browser);
    type("2G");
    await until(browser, { page: 2 }, "2G");
    type("5G");
    await until(browser, { page: 5 }, "5G");
    // pdf.js's two history entries have reached the parent's session history.
    const sh = historyOf(browser);
    await TestUtils.waitForCondition(() => sh.count === 4 && sh.index === 3, "two jumps");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 2 }, "the first ctrl+o comes back to the last jump's start");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 1 }, "the second ctrl+o comes back to the first page");
    EventUtils.synthesizeKey("i", { ctrlKey: true });
    await until(browser, { page: 2 }, "ctrl+i goes forward one jump");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 1 }, "ctrl+o again");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec === "https://example.com/",
      "the next ctrl+o leaves the PDF for the page before it",
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function keys_on_web_pages_are_unchanged() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    Assert.equal(PdfOps.context(tab.linkedBrowser), "page", "a web page");
    /** @type {string[]} */
    const notices = [];
    const orig = PdfOps.run;
    PdfOps.run = (...args) => {
      notices.push(args[1]);
      return orig.apply(PdfOps, args);
    };
    try {
      await focusNormal(tab.linkedBrowser);
      type("J");
      type("w");
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      PdfOps.run = orig;
    }
    Assert.deepEqual(notices, [], "J and w send no PDF operation on a web page");
    // :12 says it works only in the PDF viewer.
    type(":12");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => {
      const n = document.getElementById("vimma-notice");
      return n?.matches(":popover-open") && n.textContent === "only in the PDF viewer";
    }, ":12 outside a PDF says so");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
