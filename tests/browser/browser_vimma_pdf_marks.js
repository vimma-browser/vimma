/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 5, decisions 9, 11 and 16),
// docs/security/20-pdf-viewer.md section 20 (V7, V11): marks with m and ', and the link keys F and
// c in the PDF viewer. file_vimma_pdf_links.pdf has 4 pages; page 1 has three links:
// https://example.org/vimma-pdf, an explicit destination on page 3, and the named destination
// chapter-two on page 4.

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
const LINKS = ROOT + "file_vimma_pdf_links.pdf";
const EXTERNAL = "https://example.org/vimma-pdf";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    // The outline shown beside a PDF narrows the viewer as it opens (pdf-mode decision 19), and
    // marks are positions: browser_vimma_pdf_outline.js covers the outline.
    set: [
      ["general.smoothScroll", false],
      ["vimma.ui.pdf_outline.hidden", true],
    ],
  });
});

/** @param {Window} [win] */
const noticeText = (win = window) => win.document.getElementById("vimma-notice")?.textContent ?? "";

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

/**
 * @param {(browser: MozTabBrowser) => Promise<void>} fn
 * @param {string} [url]
 * @param {BrowserWindow} [win]
 */
async function withPdf(fn, url = PDF, win = window) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, "about:blank");
  win.gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, url);
    await TestUtils.waitForCondition(() => PdfOps.state(browser), "the viewer reports");
    await focusNormal(browser);
    await fn(browser);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/** @param {XULBrowserElement} browser */
function view(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
    // Both are there once a page has rendered; a read of a missing one throws.
    const viewer = /** @type {PdfJsViewer} */ (app.pdfViewer);
    const container = /** @type {HTMLElement} */ (
      content.document.getElementById("viewerContainer")
    );
    return { page: app.page, scale: viewer.currentScale, scrollTop: container.scrollTop };
  });
}

/** @typedef {Awaited<ReturnType<typeof view>>} View */
/**
 * The wanted fields of the view: each a value, or a test of the value.
 * @typedef {{ [K in keyof View]?: View[K] | ((value: View[K]) => boolean) }} Want
 */

/**
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

/** @param {string} keys @param {Window} [win] */
const type = (keys, win = window) => EventUtils.sendString(keys, win);

/**
 * Types a key that jumps, and waits for the page and for the parent's session history to have
 * the jump's entry, which comes from the content process after pdf.js moved the view.
 * @param {XULBrowserElement} browser
 * @param {string} keys
 * @param {number} page
 * @param {string} what
 */
async function jump(browser, keys, page, what) {
  const sh = browser.browsingContext.sessionHistory;
  const before = sh.index;
  type(keys);
  await until(browser, { page }, what);
  await TestUtils.waitForCondition(() => sh.index === before + 1, `${what} is in the history`);
}

/** @param {string} text @param {string} what @param {Window} [win] */
const untilNotice = (text, what, win = window) =>
  TestUtils.waitForCondition(() => noticeText(win) === text, what).catch((e) => {
    Assert.ok(false, `${what}: got ${noticeText(win)}`);
    throw e;
  });

add_task(async function marks() {
  await withPdf(async (browser) => {
    type("3G");
    await until(browser, { page: 3 }, "3G");
    type("jj");
    await until(browser, { scrollTop: (t) => t > 0 }, "a little down page 3");
    const at = await view(browser);
    info(`ma at ${JSON.stringify(at)}`);
    type("ma");
    type("150=");
    await until(browser, { scale: 1.5 }, "150=");
    type("mb");
    type("=");
    type("G");
    await until(browser, { page: 6, scale: 1 }, "G at 100 %");
    type("'a");
    await until(
      browser,
      { page: 3, scale: at.scale, scrollTop: (t) => Math.abs(t - at.scrollTop) <= 2 },
      "'a goes back to the place and the zoom of ma",
    );
    type("'b");
    await until(browser, { page: 3, scale: 1.5 }, "'b comes back at 150 %");
    type("'c");
    await untilNotice("no mark 'c'", "an unset mark says so");
    // A mark is a jump (decision 9): ctrl+o comes back from it.
    type("'a");
    await until(browser, { scale: at.scale }, "'a");
    await jump(browser, "G", 6, "G");
    await jump(browser, "'a", 3, "'a from the last page");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 6 }, "ctrl+o comes back from the mark");
  });
});

// pdf.js renders a page over several animation frames, and goToDestination focuses the page's
// text layer once it has rendered, which scrolls the page back into view. A key that moves on
// before that render (`'a` then `G` while the viewer is busy, as on a slow machine) must not be
// undone by it.
add_task(async function a_key_right_after_a_mark_is_not_undone_by_its_page_rendering() {
  await withPdf(async (browser) => {
    type("3G");
    await until(browser, { page: 3 }, "3G");
    const marked = await view(browser);
    type("ma");
    type("150=");
    await until(browser, { scale: 1.5 }, "150=");
    type("G");
    await until(browser, { page: 6 }, "G");
    // Page 3 at the mark's zoom renders only once the viewer's frames run again.
    const rendered = BrowserTestUtils.waitForContentEvent(
      browser,
      "textlayerrendered",
      false,
      // Sent to the content process as source, where the event is pdf.js's CustomEvent.
      (e) => /** @type {CustomEvent<{ pageNumber?: number }>} */ (e).detail?.pageNumber === 3,
      true,
    );
    await SpecialPowers.spawn(browser, [], () => content.windowUtils.advanceTimeAndRefresh(0));
    let last;
    try {
      type("'a");
      await until(browser, { page: 3, scale: marked.scale }, "'a");
      await jump(browser, "G", 6, "G before page 3 has rendered");
      last = await view(browser);
    } finally {
      await SpecialPowers.spawn(browser, [], () => content.windowUtils.restoreNormalRefresh());
    }
    await rendered;
    // The scroll position, which a focus moves at once; pdf.js updates its page a frame later.
    const at = await view(browser);
    Assert.equal(
      at.scrollTop,
      last.scrollTop,
      `page 3's rendering leaves the view on the last page: ${JSON.stringify(at)}`,
    );
  });
});

add_task(async function marks_are_kept_per_document() {
  await withPdf(async (browser) => {
    type("4G");
    await until(browser, { page: 4 }, "4G");
    type("md");
  });
  // Another tab of the same PDF, at another fragment, has the mark.
  await withPdf(async (browser) => {
    type("'d");
    await until(browser, { page: 4 }, "'d in another tab of the PDF");
  }, PDF + "#page=2");
  // Another PDF does not.
  await withPdf(async () => {
    type("'d");
    await untilNotice("no mark 'd'", "another PDF has its own marks");
  }, LINKS);
});

// pdf_marks_and_outlines_are_not_written (V11): marks stay in memory; a private window's marks
// go with the private windows.
add_task(async function private_marks_go_with_the_private_windows() {
  const first = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await withPdf(
    async (browser) => {
      type("2G", first);
      await until(browser, { page: 2 }, "2G");
      type("mp", first);
      type("G", first);
      await until(browser, { page: 6 }, "G");
      type("'p", first);
      await until(browser, { page: 2 }, "'p in the private window");
    },
    PDF,
    first,
  );
  // The private marks go once Firefox says the last private context has gone.
  const gone = TestUtils.topicObserved("last-pb-context-exited");
  await BrowserTestUtils.closeWindow(first);
  await gone;
  const second = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    await withPdf(
      async () => {
        type("'p", second);
        await untilNotice("no mark 'p'", "the private mark went with its windows", second);
      },
      PDF,
      second,
    );
  } finally {
    await BrowserTestUtils.closeWindow(second);
  }
  // Nor does a normal window see it.
  await withPdf(async () => {
    type("'p");
    await untilNotice("no mark 'p'", "a normal window never had it");
  });
});

/**
 * Starts hints with `key` (a `:` command is typed and run) and returns the label of the link.
 * @param {string} key
 * @param {(href: string) => boolean} which
 */
async function labelOf(key, which) {
  if (key.startsWith(":")) {
    EventUtils.sendString(key);
    EventUtils.synthesizeKey("KEY_Enter");
  } else EventUtils.synthesizeKey(key, key === key.toUpperCase() ? { shiftKey: true } : {});
  await TestUtils.waitForCondition(() => VimmaHost._hints(window)?.hints.length, "hints");
  // The wait above saw them; a read of missing hints throws.
  const hints = /** @type {HostHints} */ (VimmaHost._hints(window)).hints;
  const hit = hints.find((h) => which(h.target.href ?? ""));
  Assert.ok(hit, "a label on the link");
  return hit.label;
}

add_task(async function links() {
  await withPdf(async (browser) => {
    // f labels the external link and the internal ones (decision 16's check).
    EventUtils.synthesizeKey("f");
    await TestUtils.waitForCondition(() => VimmaHost._hints(window)?.hints.length, "f labels");
    // pdf.js's toolbar buttons get labels too, without an href.
    const hrefs = /** @type {HostHints} */ (VimmaHost._hints(window)).hints.map(
      (h) => h.target.href ?? "",
    );
    Assert.ok(
      hrefs.some((h) => h === EXTERNAL),
      "the external link",
    );
    Assert.equal(hrefs.filter((h) => h.startsWith(LINKS + "#")).length, 2, "two internal ones");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "hints end");

    // :show_link_target shows a target without following it; F stays the text-block hints
    // (decision 21).
    type(await labelOf(":show_link_target", (h) => h === EXTERNAL));
    await untilNotice(EXTERNAL, ":show_link_target shows the external link's URL");
    Assert.equal(browser.currentURI.spec, LINKS, "and stays");
    type(await labelOf(":show_link_target", (h) => h.startsWith(LINKS + "#") && h.includes("%5B")));
    await untilNotice("page 3", "it shows an explicit destination's page");
    type(await labelOf(":show_link_target", (h) => h.endsWith("#chapter-two")));
    await untilNotice("page 4", "and a named destination's page");
    Assert.equal((await view(browser)).page, 1, "it follows nothing");

    // c copies a target.
    SpecialPowers.clipboardCopyString("before");
    type(await labelOf("c", (h) => h === EXTERNAL));
    await untilNotice(`yanked ${EXTERNAL}`, "c says what it copied");
    Assert.equal(SpecialPowers.getClipboardData("text/plain"), EXTERNAL, "c copies the URL");
    type(await labelOf("c", (h) => h.endsWith("#chapter-two")));
    await untilNotice(`yanked ${LINKS}#chapter-two`, "c copies an internal link's URL");
    Assert.equal((await view(browser)).page, 1, "c follows nothing");
  }, LINKS);
});

// Decision 9 with a link and a mark: ctrl+o walks back through each jump, then leaves the PDF.
add_task(async function jumps() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, LINKS);
    await TestUtils.waitForCondition(() => PdfOps.state(browser), "the viewer reports");
    await focusNormal(browser);
    type("mz");
    await jump(browser, await labelOf("f", (h) => h.endsWith("#chapter-two")), 4, "a link");
    await jump(browser, "2G", 2, "2G");
    await jump(browser, "'z", 1, "'z");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 2 }, "ctrl+o after the mark");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 4 }, "ctrl+o after 2G");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await until(browser, { page: 1 }, "ctrl+o after the link");
    EventUtils.synthesizeKey("o", { ctrlKey: true });
    await TestUtils.waitForCondition(
      () => browser.currentURI.spec === "https://example.com/",
      "then ctrl+o leaves the PDF",
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
