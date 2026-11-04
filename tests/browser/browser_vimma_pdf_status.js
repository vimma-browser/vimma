/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 2), docs/security.md section 20: the PDF viewer's
// adapter, the pdf context, and the page and match count in the status bar.

/* global add_setup -- the browser-chrome harness (browser-test.js) */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");
const { PDFJS_CONTRACT } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/pdf-view.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PDF = ROOT + "file_vimma_outline.pdf";

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.pdf_mode", true]] });
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

/**
 * @param {(browser: XULBrowserElement, tab: Element) => Promise<void>} fn
 * @param {{ url?: string, userContextId?: number }} [options]
 */
async function withPdf(fn, { url = PDF, userContextId } = {}) {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { userContextId });
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, url);
    await fn(browser, tab);
  } finally {
    gBrowser.getCachedFindBar(tab)?.close(true);
    BrowserTestUtils.removeTab(tab);
  }
}

/** @param {XULBrowserElement} browser @param {number} page */
function goToPage(browser, page) {
  return SpecialPowers.spawn(browser, [page], (p) => {
    content.wrappedJSObject.PDFViewerApplication.page = p;
  });
}

add_task(async function the_adapter_matches_the_shipped_pdfjs() {
  await withPdf(async (browser) => {
    const found = await SpecialPowers.spawn(browser, [PDFJS_CONTRACT], (contract) => {
      const app = content.wrappedJSObject.PDFViewerApplication;
      /** @type {Record<string, string>} */
      const out = {};
      for (const path of Object.keys(contract)) {
        let v = app;
        for (const k of path.split(".")) v = v == null ? undefined : v[k];
        out[path] = v === null ? "object" : typeof v;
      }
      return out;
    });
    for (const [path, type] of Object.entries(PDFJS_CONTRACT)) {
      Assert.ok(
        type.split("|").includes(found[path]),
        `PDFViewerApplication.${path} is ${type} (got ${found[path]})`,
      );
    }
  });
});

add_task(async function the_status_bar_shows_the_page_and_its_label() {
  await withPdf(async (browser) => {
    Assert.equal(PdfOps.context(browser), "pdf", "the PDF viewer is the pdf context");
    await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "page i (1/6)");
    await goToPage(browser, 4);
    await TestUtils.waitForCondition(() => segment("page") === "page 2 (4/6)", "page 2 (4/6)");
    BrowserTestUtils.startLoadingURIString(browser, "https://example.com/");
    await BrowserTestUtils.browserLoaded(browser);
    Assert.equal(PdfOps.context(browser), "page", "a web page is the page context");
    await TestUtils.waitForCondition(() => segment("page") === "", "no page segment on a page");
  });
});

add_task(async function find_count() {
  await withPdf(async (browser) => {
    await SimpleTest.promiseFocus(browser);
    browser.focus();
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the PDF viewer is in normal mode",
    );
    EventUtils.sendString("/Vimma");
    await TestUtils.waitForCondition(
      () => segment("find").endsWith("[1/6]"),
      `the find segment counts pdf.js's matches (${segment("find")})`,
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () => VimmaHost.status(window).mode === "normal",
      "Esc leaves the search",
    );
    // Enter at once: pdf.js runs the new query from the top (host/find.mjs accept).
    EventUtils.sendString("/Vimma");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => VimmaHost.status(window).mode === "normal" && segment("find").endsWith("[1/6]"),
      `Enter keeps the count in the status bar (${segment("find")})`,
    );
    EventUtils.synthesizeKey("n");
    await TestUtils.waitForCondition(
      () => segment("find").endsWith("[2/6]"),
      `n moves the count on (${segment("find")})`,
    );
    EventUtils.synthesizeKey("N", { shiftKey: true });
    await TestUtils.waitForCondition(
      () => segment("find").endsWith("[1/6]"),
      `N moves it back (${segment("find")})`,
    );
  });
});

add_task(async function pdf_keys_work_in_a_workspace_container() {
  await withPdf(
    async (browser) => {
      Assert.equal(PdfOps.context(browser), "pdf", "the pdf context in a container");
      await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
    },
    { userContextId: 1 },
  );
});

add_task(async function a_page_that_defines_PDFViewerApplication_gets_no_pdf_keys() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  const browser = tab.linkedBrowser;
  try {
    const seen = [];
    const orig = PdfOps.onState;
    PdfOps.onState = (...args) => {
      seen.push(args);
      return orig.apply(PdfOps, args);
    };
    try {
      await SpecialPowers.spawn(browser, [], () => {
        content.wrappedJSObject.eval(`window.PDFViewerApplication = {
          page: 3, pagesCount: 9,
          pdfViewer: { currentPageLabel: "x" },
          eventBus: { on() {}, off() {} },
        };`);
        content.dispatchEvent(new content.CustomEvent("pagesloaded", { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 300));
      Assert.equal(seen.length, 0, "no state from a web page");
      Assert.equal(PdfOps.context(browser), "page", "the page context");
      Assert.equal(segment("page"), "", "no page segment");
    } finally {
      PdfOps.onState = orig;
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_pdf_in_a_frame_gets_no_pdf_context() {
  for (const tag of ["iframe", "embed"]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    const browser = tab.linkedBrowser;
    try {
      await SpecialPowers.spawn(browser, [PDF, tag], (url, t) => {
        const el = content.document.createElement(t);
        el.src = url;
        el.style.cssText = "width:600px;height:600px";
        content.document.body.append(el);
      });
      // The framed viewer exists and has a principal the parent recognises.
      const frame = await TestUtils.waitForCondition(() =>
        browser.browsingContext.children.find((bc) =>
          bc.currentWindowGlobal?.documentPrincipal?.originNoSuffix?.startsWith("resource://pdf"),
        ),
      );
      Assert.equal(PdfOps.context(browser), "page", `a PDF in an ${tag} keeps the page context`);
      // A state message from the frame's actor is dropped.
      const actor = frame.currentWindowGlobal.getActor("Vimma");
      actor.receiveMessage({
        name: "Vimma:PdfState",
        data: { page: 1, pages: 2, label: "", find: { current: 0, total: 0 } },
      });
      await new Promise((r) => setTimeout(r, 300));
      Assert.equal(PdfOps.state(browser), null, `no state from an ${tag}`);
      Assert.equal(segment("page"), "", "no page segment");
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

/**
 * Runs `fn` while recording every state message the parent receives.
 * @param {(seen: object[]) => Promise<void>} fn
 */
async function recordingState(fn) {
  /** @type {object[]} */
  const seen = [];
  const orig = PdfOps.onState;
  PdfOps.onState = (actor, data) => {
    seen.push(data);
    return orig.call(PdfOps, actor, data);
  };
  try {
    await fn(seen);
  } finally {
    PdfOps.onState = orig;
  }
}

add_task(async function a_hostile_viewer_gets_only_primitives_through() {
  await withPdf(async (browser) => {
    await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
    await recordingState(async (seen) => {
      await SpecialPowers.spawn(browser, [], () => {
        const w = content.wrappedJSObject;
        const app = w.PDFViewerApplication;
        const fn = (/** @type {Function} */ f) => Cu.exportFunction(f, content);
        const obj = (/** @type {object} */ o) => Cu.cloneInto(o, content, { cloneFunctions: true });
        // Getters that hand back objects: a thenable with valueOf, one with toString.
        Object.defineProperty(app, "pagesCount", {
          configurable: true,
          get: fn(() => obj({ valueOf: () => 6, then: (r) => r(6) })),
        });
        Object.defineProperty(app.pdfViewer, "currentPageLabel", {
          configurable: true,
          get: fn(() => obj({ toString: () => "evil" })),
        });
        // A count whose fields are a getter and an object.
        const count = new w.Object();
        Object.defineProperty(count, "current", { get: fn(() => 1), enumerable: true });
        count.total = obj({ valueOf: () => 2 });
        const evt = new w.Object();
        evt.matchesCount = count;
        app.eventBus.dispatch("updatefindmatchescount", evt);
      });
      await TestUtils.waitForCondition(
        () => seen.length > 0 && PdfOps.state(browser) === null,
        "a page count that is not a number drops the state",
      );
      for (const data of seen) {
        for (const [k, v] of Object.entries(data)) {
          if (k === "find") {
            for (const n of Object.values(v)) Assert.equal(typeof n, "number", "find counts");
          } else {
            Assert.ok(["number", "string", "boolean"].includes(typeof v), `${k} is a primitive`);
          }
        }
        Assert.ok(Number.isNaN(data.pages), "the thenable page count reached the parent as NaN");
        Assert.equal(data.label, "", "the object label reached the parent as nothing");
        Assert.deepEqual(data.find, { current: 0, total: 0 }, "a count of objects is not taken");
      }
      await TestUtils.waitForCondition(() => segment("page") === "", "and the page segment");
    });
  });
});

add_task(async function a_flood_of_pagesloaded_is_coalesced() {
  await withPdf(async (browser) => {
    await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
    await recordingState(async (seen) => {
      // pdf.js's own event bus, and the chrome-only event the viewer can send at will.
      await SpecialPowers.spawn(browser, [], () => {
        const app = content.wrappedJSObject.PDFViewerApplication;
        for (let i = 0; i < 1000; i++) {
          app.eventBus.dispatch("pagesloaded", Cu.cloneInto({ pagesCount: i }, content));
          content.document.dispatchEvent(new content.CustomEvent("pagesloaded", { bubbles: true }));
        }
      });
      await TestUtils.waitForCondition(() => seen.length > 0, "the burst sent state");
      // Long enough for a second and third message, were the burst not coalesced (100 ms).
      await new Promise((r) => setTimeout(r, 300));
      Assert.lessOrEqual(seen.length, 2, `two thousand events, ${seen.length} messages`);
    });
  });
});

add_task(async function the_feature_pref_off_shows_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.pdf_mode", false]] });
  try {
    await withPdf(async (browser) => {
      Assert.equal(PdfOps.context(browser), "page", "no pdf context with the feature off");
      await new Promise((r) => setTimeout(r, 300));
      Assert.equal(segment("page"), "", "no page segment");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
