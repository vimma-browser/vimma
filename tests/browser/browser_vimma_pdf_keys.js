/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 3), docs/security.md section 20 (V7, V9): zathura's
// page, zoom and layout keys in the PDF viewer, presentation mode, and jumps.

/* global add_setup -- the browser-chrome harness (browser-test.js) */

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
      ["vimma.feature.pdf_mode", true],
      // Instant scrolling: the positions below are read right after a key.
      ["general.smoothScroll", false],
    ],
  });
});

/** @param {string} id */
const segment = (id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? "";

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
    const app = content.wrappedJSObject.PDFViewerApplication;
    const v = app.pdfViewer;
    const container = content.document.getElementById("viewerContainer");
    const page = content.document.querySelector(`#viewer .page[data-page-number="${app.page}"]`);
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

/**
 * Waits until pdf.js's view matches `want`.
 * @param {XULBrowserElement} browser
 * @param {object} want
 * @param {string} what
 */
async function until(browser, want, what) {
  /** @type {any} */
  let last = null;
  await TestUtils.waitForCondition(
    async () => {
      last = await view(browser);
      return Object.entries(want).every(([k, v]) =>
        typeof v === "function" ? v(last[k]) : last[k] === v,
      );
    },
    `${what}: want ${JSON.stringify(want, (_k, v) => (typeof v === "function" ? "fn" : v))}`,
  ).catch((e) => {
    Assert.ok(false, `${what}: got ${JSON.stringify(last)}`);
    throw e;
  });
}

/** @param {string} keys  typed one key at a time, as EventUtils.sendString does */
const type = (keys) => EventUtils.sendString(keys);

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
    // H / L / P: the current page's top or bottom at the view's.
    type("L");
    await until(browser, { pageBottom: (b) => Math.abs(b) <= 1 }, "L: the page's bottom");
    const page = (await view(browser)).page;
    type("H");
    await until(browser, { page, pageTop: (t) => Math.abs(t) <= 1 }, "H: the page's top");
    EventUtils.synthesizeKey("j");
    await until(browser, { pageTop: (t) => t < -1 }, "j scrolls off the page's top");
    type("P");
    await until(browser, { page, pageTop: (t) => Math.abs(t) <= 1 }, "P snaps to the page");
    const before = await view(browser);
    EventUtils.synthesizeKey("f", { ctrlKey: true });
    await until(
      browser,
      { scrollTop: (y) => Math.abs(y - before.scrollTop - before.height) <= 1 },
      "ctrl+f scrolls a screen down",
    );
  });
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
    browser.style.maxWidth = "400px";
    try {
      await until(
        browser,
        { scaleValue: "page-width", scale: (s) => s < wide },
        "the fit follows a resize",
      );
    } finally {
      browser.style.maxWidth = "";
    }
  });
});

add_task(async function layout() {
  await withPdf(async (browser) => {
    // pdf.js's SpreadMode NONE 0, ODD 1, EVEN 2; ScrollMode VERTICAL 0, PAGE 3.
    type("d");
    await until(browser, { spread: 2 }, "d shows two pages, the first alone");
    type("D");
    await until(browser, { spread: 1 }, "D pairs the first page");
    type("d");
    await until(browser, { spread: 0 }, "d goes back to one page");
    type("d");
    await until(browser, { spread: 1 }, "d comes back to the last spread");
    type("d");
    await until(browser, { spread: 0 }, "one page again");
    type("w");
    await until(browser, { scroll: 3 }, "w shows one page at a time");
    type("w");
    await until(browser, { scroll: 0 }, "w goes back to scrolling");
    type("r");
    await until(browser, { rotation: 90 }, "r rotates 90 degrees");
    type("2r");
    await until(browser, { rotation: 270 }, "2r rotates twice");
    type("r");
    await until(browser, { rotation: 0 }, "and round");
  });
});

add_task(async function presentation() {
  await withPdf(async (browser) => {
    const full = BrowserTestUtils.waitForEvent(window, "fullscreen");
    EventUtils.synthesizeKey("KEY_F5");
    await until(browser, { presenting: true }, "F5 starts the presentation");
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
    EventUtils.synthesizeKey("KEY_F5");
    await until(browser, { presenting: false }, "F5 leaves the presentation");
    await TestUtils.waitForCondition(() => !window.fullScreen, "and the full screen");
  });
});

add_task(async function presentation_only_on_the_users_key() {
  await withPdf(async (browser) => {
    // The adapter takes operations from the parent only; a message the viewer's own process
    // sends to the parent is not an operation, and the parent sends one only for a key.
    const actor = browser.browsingContext.currentWindowGlobal.getActor("Vimma");
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
    const sent = [];
    const wg = browser.browsingContext.currentWindowGlobal;
    const actor = wg.getActor("Vimma");
    const orig = actor.sendAsyncMessage;
    actor.sendAsyncMessage = function (name, data) {
      if (name === "Vimma:PdfOp") sent.push(data);
      return orig.call(this, name, data);
    };
    try {
      type("3J");
      type("150=");
      type("r");
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
    Assert.ok(!PdfOps.run(browser, "next", /** @type {any} */ ("1")), "text for a number");
    // And the child drops a malformed one without touching pdf.js.
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.PDFViewerApplication.pdfViewer.pagesRotation = 0;
    });
    const child = browser.browsingContext.currentWindowGlobal;
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

add_task(async function keys_on_web_pages_are_unchanged() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  try {
    Assert.equal(PdfOps.context(tab.linkedBrowser), "page", "a web page");
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
