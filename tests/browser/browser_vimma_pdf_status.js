/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/pdf-mode.md (delivery PR 2), docs/security.md section 20: the PDF viewer's
// adapter, the pdf context, and the page and match count in the status bar.

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");
const { PDFJS_CONTRACT, PDFJS_DOM } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/pdf-view.mjs",
);
const { PDF_MAX_LABEL } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/pdf.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PDF = ROOT + "file_vimma_outline.pdf";

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
    /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication.page = p;
  });
}

add_task(async function the_adapter_matches_the_shipped_pdfjs() {
  await withPdf(async (browser) => {
    const found = await SpecialPowers.spawn(browser, [PDFJS_CONTRACT], (contract) => {
      /** @type {unknown} */
      const app = content.wrappedJSObject.PDFViewerApplication;
      /** @type {Record<string, string>} */
      const out = {};
      for (const path of Object.keys(contract)) {
        let v = app;
        for (const k of path.split(".")) {
          v = v == null ? undefined : /** @type {Record<string, unknown>} */ (v)[k];
        }
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
    // The elements the adapter measures for H, L, P and ctrl+f, and what a page that has
    // finished drawing matches, for `state.pdf` (#1006).
    const dom = await SpecialPowers.spawn(browser, [PDFJS_DOM], async (sel) => {
      const page = content.document.querySelector(sel.page.replace("{n}", "1"));
      await ContentTaskUtils.waitForCondition(
        () => page?.matches(sel.drawn),
        "the first page has finished drawing",
      );
      return {
        container: (content.document.querySelector(sel.container)?.scrollHeight ?? 0) > 0,
        page: !!page,
        drawn: !!page?.matches(sel.drawn),
        canvas: !!page?.querySelector("canvas"),
      };
    });
    Assert.deepEqual(
      dom,
      { container: true, page: true, drawn: true, canvas: true },
      "the viewer's container and pages, and a drawn page with its canvas",
    );
    // A page drawing again (a zoom) does not match `drawn` until it is done: pdf.js marks it
    // with both `data-loaded` and `loadingIcon` meanwhile, so neither name can change unseen.
    const midway = await SpecialPowers.spawn(browser, [PDFJS_DOM], async (sel) => {
      const page = content.document.querySelector(sel.page.replace("{n}", "1"));
      /** @type {boolean[]} whether the page matched `drawn` while marked as drawing */
      const seen = [];
      const watch = new content.MutationObserver(() => {
        if (page?.hasAttribute("data-loaded") && page.classList.contains("loadingIcon")) {
          seen.push(!!page.matches(sel.drawn));
        }
      });
      if (page)
        watch.observe(page, { attributes: true, attributeFilter: ["class", "data-loaded"] });
      const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
      /** @type {PdfJsViewer} */ (app.pdfViewer).currentScaleValue = "2";
      await ContentTaskUtils.waitForCondition(
        () => seen.length > 0 && page?.matches(sel.drawn),
        "the page draws again at the new zoom",
      );
      watch.disconnect();
      return seen;
    });
    Assert.ok(midway.length > 0, "the page was marked as drawing with data-loaded and loadingIcon");
    Assert.ok(
      midway.every((drawn) => !drawn),
      "a page marked as drawing does not match drawn",
    );
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
    /** @type {unknown[]} */
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
        };
        window.dispatchEvent(new CustomEvent("pagesloaded", { bubbles: true }));`);
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

/**
 * Runs `fn` while recording every state message the parent receives.
 * @param {(seen: unknown[]) => Promise<void>} fn
 */
async function recordingState(fn) {
  /** @type {unknown[]} */
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

add_task(async function a_pdf_in_a_frame_gets_no_pdf_context() {
  for (const tag of ["iframe", "embed"]) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
    const browser = tab.linkedBrowser;
    try {
      // The framed viewer's own actor sends nothing (pdf-view.mjs checks for a top document).
      /** @type {CanonicalBrowsingContext | undefined} */
      let frame;
      let fromFrame = 0;
      await recordingState(async (seen) => {
        await SpecialPowers.spawn(browser, [PDF, tag], (url, t) => {
          const el = /** @type {HTMLIFrameElement | HTMLEmbedElement} */ (
            content.document.createElement(t)
          );
          el.src = url;
          el.style.cssText = "width:600px;height:600px";
          content.document.body.append(el);
        });
        // The framed viewer exists and has a principal the parent recognises.
        frame = await TestUtils.waitForCondition(() =>
          browser.browsingContext.children.find((/** @type {CanonicalBrowsingContext} */ bc) =>
            bc.currentWindowGlobal?.documentPrincipal?.originNoSuffix?.startsWith("resource://pdf"),
          ),
        );
        // pdf.js lays out its pages in the frame; a top viewer would have reported by now.
        await SpecialPowers.spawn(frame, [], () =>
          ContentTaskUtils.waitForCondition(() => {
            // The frame's window has no viewer yet while its document loads.
            const w = /** @type {Partial<PdfJsWindow>} */ (content.wrappedJSObject);
            return (w.PDFViewerApplication?.pagesCount ?? 0) > 0;
          }, "the framed viewer has its pages"),
        );
        await new Promise((r) => setTimeout(r, 300));
        fromFrame = seen.length;
      });
      Assert.equal(fromFrame, 0, `no state message from the ${tag}'s viewer`);
      Assert.equal(PdfOps.context(browser), "page", `a PDF in an ${tag} keeps the page context`);
      // A state message from the frame's actor is dropped.
      Assert.ok(frame, `the ${tag}'s viewer has a browsing context`);
      const actor =
        /** @type {import("../../src/browser/base/content/vimma/host/VimmaParent.sys.mjs").VimmaParent} */ (
          /** @type {WindowGlobalParent} */ (frame.currentWindowGlobal).getActor("Vimma")
        );
      actor.receiveMessage({
        name: "Vimma:PdfState",
        data: { page: 1, pages: 2, label: "", find: { current: 0, total: 0 } },
      });
      await new Promise((r) => setTimeout(r, 300));
      Assert.strictEqual(PdfOps.state(browser), null, `no state from an ${tag}`);
      Assert.equal(segment("page"), "", "no page segment");
    } finally {
      BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function a_hostile_viewer_gets_only_primitives_through() {
  await withPdf(async (browser) => {
    await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
    await recordingState(async (seen) => {
      // A state message the adapter read before the viewer turns hostile can reach the parent
      // after recording starts (its 100 ms timer fires on its own schedule): make one do so.
      await SpecialPowers.spawn(browser, [], () => {
        // Well formed, as pdf.js's own listeners run before the adapter's.
        const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
        /** @type {PdfJsEventBus} */ (app.eventBus).dispatch(
          "pagechanging",
          Cu.cloneInto({ source: null, pageNumber: 1, pageLabel: "i", previous: 1 }, content),
        );
      });
      await TestUtils.waitForCondition(() => seen.length > 0, "a state read before the change");
      await SpecialPowers.spawn(browser, [], () => {
        /** @type {PdfJsWindow} */
        const w = content.wrappedJSObject;
        const app = w.PDFViewerApplication;
        const fn = (/** @type {() => unknown} */ f) => Cu.exportFunction(f, content);
        const obj = (/** @type {object} */ o) => Cu.cloneInto(o, content, { cloneFunctions: true });
        // Getters that hand back objects: a thenable with valueOf, one with toString.
        Object.defineProperty(app, "pagesCount", {
          configurable: true,
          get: fn(() =>
            obj({ valueOf: () => 6, then: (/** @type {(n: number) => void} */ r) => r(6) }),
          ),
        });
        Object.defineProperty(/** @type {PdfJsViewer} */ (app.pdfViewer), "currentPageLabel", {
          configurable: true,
          get: fn(() => "x".repeat(1e6)),
        });
        // A count whose fields are a getter and an object.
        const count = /** @type {{ total?: object }} */ (new w.Object());
        Object.defineProperty(count, "current", { get: fn(() => 1), enumerable: true });
        count.total = obj({ valueOf: () => 2 });
        const evt = /** @type {{ matchesCount?: object }} */ (new w.Object());
        evt.matchesCount = count;
        /** @type {PdfJsEventBus} */ (app.eventBus).dispatch("updatefindmatchescount", evt);
      });
      await TestUtils.waitForCondition(
        () => seen.length > 0 && PdfOps.state(browser) === null,
        "a page count that is not a number drops the state",
      );
      // The getters are all replaced within one content task and read() runs within one timer
      // callback, so a message saw either none of the change (the viewer's own label, "i") or
      // all of it (the "x" label): each kind is checked for what it can carry, and at least one
      // read after the change came through.
      let after = 0;
      // Each message as the child sent it; the loop holds every field to a primitive.
      const states = /** @type {{ label: string, pages: number, find: object }[]} */ (seen);
      for (const data of states) {
        for (const [k, v] of Object.entries(data)) {
          if (k === "find") {
            for (const n of Object.values(data.find)) {
              Assert.equal(typeof n, "number", "find counts");
            }
          } else {
            Assert.ok(["number", "string", "boolean"].includes(typeof v), `${k} is a primitive`);
          }
        }
        if (data.label === "i") {
          Assert.equal(data.pages, 6, "a state read before the change has the real page count");
          continue;
        }
        after++;
        Assert.ok(Number.isNaN(data.pages), "the thenable page count reached the parent as NaN");
        Assert.equal(data.label, "x".repeat(PDF_MAX_LABEL + 1), "a huge label is cut in the child");
        Assert.deepEqual(data.find, { current: 0, total: 0 }, "a count of objects is not taken");
      }
      Assert.greater(after, 0, "a state read after the change reached the parent");
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
        const app = /** @type {PdfJsWindow} */ (content.wrappedJSObject).PDFViewerApplication;
        const bus = /** @type {PdfJsEventBus} */ (app.eventBus);
        for (let i = 0; i < 1000; i++) {
          bus.dispatch("pagesloaded", Cu.cloneInto({ pagesCount: i }, content));
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

add_task(async function pdf_mode_is_on_with_no_pref_set() {
  // PDF mode is on in every profile: no pref turns it on or off.
  Assert.equal(
    Services.prefs.getPrefType("vimma.feature.pdf_mode"),
    Services.prefs.PREF_INVALID,
    "no vimma.feature.pdf_mode pref exists",
  );
  await withPdf(async (browser) => {
    Assert.equal(PdfOps.context(browser), "pdf", "the pdf context with no pref set");
    await TestUtils.waitForCondition(() => segment("page") !== "", "the page segment shows");
    Assert.equal(segment("page"), "page i (1/6)", "page segment");
  });
});

add_task(async function pdf_mode_writes_no_pdfjs_prefs() {
  // docs/specs/pdf-mode.md decision 17: the "PDFs just got easier" bar never covers a document.
  Assert.equal(
    Services.prefs.getIntPref("pdfjs.featuresNotificationImpressionLimit"),
    0,
    "the features notification has no impressions to show",
  );
  // Decision 18: pdf.js's sidebar opens on no view by itself (Vimma's outline is the outline).
  Assert.equal(
    Services.prefs.getIntPref("pdfjs.sidebarViewOnLoad"),
    0,
    "pdf.js's sidebar opens on no view by itself",
  );
  const before = Services.prefs
    .getChildList("pdfjs.")
    .filter((name) => Services.prefs.prefHasUserValue(name));
  await withPdf(async (browser) => {
    await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
    const box = gBrowser.getNotificationBox(browser);
    Assert.ok(
      !box.allNotifications.some((n) => /pdf/i.test(String(n.getAttribute("value") ?? ""))),
      "no PDF features notification on the viewer",
    );
  });
  const after = Services.prefs
    .getChildList("pdfjs.")
    .filter((name) => Services.prefs.prefHasUserValue(name));
  Assert.deepEqual(after, before, "opening a PDF in the PDF mode writes no pdfjs.* pref");
});

/**
 * The tab's size in whole device pixels, as PdfOps.drawn reads it.
 * @param {XULBrowserElement} browser
 */
function deviceSize(browser) {
  const box = browser.getBoundingClientRect();
  return [box.width, box.height].map((v) => Math.round(v * window.devicePixelRatio));
}

/**
 * Makes the tab's size in device pixels other than a multiple of 5 in at least one direction,
 * so that at devPixelsPerPx 1.5 and full zoom 1.1 the viewer's size is not whole CSS pixels.
 * The chrome has round(60 / 1.5) = 40 app units per device pixel, the page round(40 / 1.1) =
 * round(36.36) = 36 (nsDeviceContext::ApplyFullZoomToAPD), and a CSS pixel is 60 app units: the
 * viewer's size is 36 / 60 = 3 / 5 of its size in device pixels, whole exactly when that is a
 * multiple of 5. No zoom or scale avoids this for every window size (any whole number of app
 * units makes some sizes whole), so the window is sized instead: one chrome pixel narrower is
 * 1 or 2 device pixels narrower (1.5, rounded), and a multiple of 5 minus 1 or 2 is not one.
 * @param {XULBrowserElement} browser
 * @returns {Promise<() => Promise<void>>} puts the window's width back
 */
async function offWholePixels(browser) {
  const [width, height] = deviceSize(browser);
  if (width % 5 || height % 5) return async () => {};
  const resize = async (/** @type {number} */ by) => {
    const resized = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeBy(by, 0);
    await resized;
  };
  await resize(-1);
  const [now] = deviceSize(browser);
  Assert.ok(now < width && now % 5 !== 0, `the tab is ${now} device pixels wide, not ${width}`);
  return () => resize(1);
}

// At a fractional desktop scale and a full zoom other than 100 %, the viewer's size is not a
// whole number of CSS pixels: PDF mode keeps its page state (the status bar's page, the
// outline, `G`) and `state.pdf` still turns drawn (#1006).
add_task(async function pdf_mode_at_a_fractional_size() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.ui.pdf_outline.hidden", true],
      ["layout.css.devPixelsPerPx", "1.5"],
    ],
  });
  try {
    await withPdf(async (browser) => {
      const restore = await offWholePixels(browser);
      try {
        browser.fullZoom = 1.1;
        const size = await SpecialPowers.spawn(browser, [], () => [
          content.innerWidth,
          content.innerHeight,
        ]);
        Assert.ok(
          size.some((v) => !Number.isInteger(v)),
          `the viewer's size is not whole CSS pixels (${size})`,
        );
        await TestUtils.waitForCondition(() => segment("page") === "page i (1/6)", "the page");
        Assert.ok(PdfOps.state(browser), "the viewer's state is kept");
        await TestUtils.waitForCondition(
          () => PdfOps.drawn(browser)?.drawn === true,
          "the first page is drawn",
        );
        Assert.ok(PdfOps.askOutline(browser), "the outline is asked for");
        await TestUtils.waitForCondition(
          () => !!PdfOps.outline(browser)?.entries.length,
          "the outline is read",
        );
        Assert.ok(PdfOps.run(browser, "last", 0), "G goes to the last page");
        Assert.deepEqual(PdfOps.drawn(browser), { drawn: false }, "the last page is to come");
        await TestUtils.waitForCondition(() => segment("page").includes("6/6"), "the last page");
        await TestUtils.waitForCondition(
          () => PdfOps.drawn(browser)?.drawn === true,
          "the last page is drawn",
        );
      } finally {
        await restore();
      }
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
