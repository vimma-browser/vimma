/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one module that touches Firefox's pdf.js viewer (docs/specs/pdf-mode.md decisions 2 and 3;
// docs/security.md section 20). It runs in the viewer's content process, waives Xrays only after
// the principal check (V1), passes pdf.js only exported functions (V3), keeps only primitives from
// it (V4) and sends at most one state message per 100 ms (V5). Every pdf.js member it uses is in
// PDFJS_CONTRACT, which a mochitest holds to the pdf.js this build ships.

import {
  PDF_MAX_LABEL,
  PDF_SPREAD,
  PDF_SCROLL,
  parsePdfOp,
  pdfPageTarget,
  pdfRotation,
  pdfScrollMode,
  pdfSpread,
  pdfZoomPercent,
  pdfZoomStep,
} from "../core/pdf.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** The pref an unfinished feature sits behind (CONTRIBUTING.md, "Unfinished features"). */
export const PDF_FEATURE_PREF = "vimma.feature.pdf_mode";

/** At most one state message per this many milliseconds (V5). */
export const PDF_STATE_MS = 100;

/**
 * Every pdf.js member the adapter reads or calls, with its `typeof` (decision 3). Paths start at
 * the viewer's `PDFViewerApplication`.
 */
export const PDFJS_CONTRACT = Object.freeze({
  eventBus: "object",
  "eventBus.on": "function",
  "eventBus.off": "function",
  page: "number",
  pagesCount: "number",
  pdfViewer: "object",
  // A string, or null when the document has no page labels.
  "pdfViewer.currentPageLabel": "object|string",
  // Delivery PR 3: the page, zoom and layout keys.
  "pdfViewer.currentScale": "number",
  "pdfViewer.currentScaleValue": "string",
  "pdfViewer.pagesRotation": "number",
  "pdfViewer.spreadMode": "number",
  "pdfViewer.scrollMode": "number",
  "pdfViewer.isInPresentationMode": "boolean",
  "pdfViewer.nextPage": "function",
  "pdfViewer.previousPage": "function",
  pdfLinkService: "object",
  "pdfLinkService.goToPage": "function",
  pdfHistory: "object",
  "pdfHistory.pushCurrentPosition": "function",
  requestPresentationMode: "function",
});

/**
 * The viewer's elements the adapter measures, through Xrays: the scrolling container and a page,
 * `{n}` standing for its number. The contract mochitest finds them too.
 */
export const PDFJS_DOM = Object.freeze({
  container: "#viewerContainer",
  page: '#viewer .page[data-page-number="{n}"]',
});

/** pdf.js events after which the state is read again. */
const EVENTS = ["pagesloaded", "pagechanging", "updatefindmatchescount", "updatefindcontrolstate"];

/**
 * Firefox's own test for the pdf.js viewer (nsContentUtils::IsPDFJS): its scheme and its origin
 * without the container suffix, so it holds in every workspace (V1).
 * @param {any} principal  an nsIPrincipal
 */
export function isPdfJsPrincipal(principal) {
  try {
    return (
      !!principal &&
      principal.schemeIs("resource") &&
      principal.originNoSuffix === "resource://pdf.js"
    );
  } catch {
    return false;
  }
}

/** @param {() => unknown} read @returns {number} NaN unless pdf.js gave a number */
function num(read) {
  try {
    const v = read();
    return typeof v === "number" ? v : NaN;
  } catch {
    return NaN;
  }
}

/** @param {() => unknown} read @returns {string} "" unless pdf.js gave a string */
function str(read) {
  try {
    const v = read();
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export class PdfView {
  /** @type {any} the viewer's PDFViewerApplication, waived */
  #app;
  /** @type {any} the viewer's document, through Xrays */
  #doc;
  /** The spread `d` goes back to, and the scroll mode `w` goes back to (decision 8). */
  /** @type {number} */
  #lastSpread = PDF_SPREAD.EVEN;
  /** @type {number} */
  #previousScroll = PDF_SCROLL.VERTICAL;
  /** @type {(state: object) => void} */
  #send;
  /** @type {any} */
  #timer = null;
  #find = { current: 0, total: 0 };
  /** @type {[string, Function][]} */
  #listeners = [];

  /**
   * The adapter for an actor's document, or null when it is not the top-level pdf.js viewer or
   * the feature is off.
   * @param {any} actor   the VimmaChild
   * @param {(state: object) => void} send
   * @returns {PdfView | null}
   */
  static attach(actor, send) {
    if (!Services.prefs.getBoolPref(PDF_FEATURE_PREF, false)) return null;
    // Top level only: a PDF in a web page's frame keeps the page's keys (V2).
    if (actor.browsingContext.parent) return null;
    const doc = actor.document;
    if (!isPdfJsPrincipal(doc?.nodePrincipal)) return null;
    let app;
    try {
      app = Cu.waiveXrays(actor.contentWindow).PDFViewerApplication;
    } catch {
      return null;
    }
    if (!app || typeof app !== "object") return null;
    return new PdfView(actor.contentWindow, app, send);
  }

  /**
   * @param {Window} win  the viewer's window, through Xrays
   * @param {any} app
   * @param {(state: object) => void} send
   */
  constructor(win, app, send) {
    this.#app = app;
    this.#doc = win.document;
    this.#send = send;
    // pdf.js calls these with its own event objects; Cu.exportFunction keeps the arguments
    // behind Xrays (V3, V4).
    const onState = Cu.exportFunction(() => this.schedule(), win);
    const onCount = Cu.exportFunction((/** @type {any} */ evt) => this.#onCount(evt), win);
    for (const name of EVENTS) {
      const fn = name.startsWith("updatefind") ? onCount : onState;
      try {
        this.#app.eventBus.on(name, fn);
        this.#listeners.push([name, fn]);
      } catch {
        // a viewer without its event bus reports nothing
      }
    }
    this.schedule();
  }

  /** @param {any} evt  through Xrays: only own data properties are visible */
  #onCount(evt) {
    let current = NaN;
    let total = NaN;
    try {
      const m = evt?.matchesCount;
      current = typeof m?.current === "number" ? m.current : NaN;
      total = typeof m?.total === "number" ? m.total : NaN;
    } catch {
      // keep the last count
    }
    if (Number.isSafeInteger(current) && Number.isSafeInteger(total)) {
      this.#find = { current, total };
    }
    this.schedule();
  }

  /**
   * Runs one operation from the parent (V7): a name from PDF_OPS and an integer, checked again
   * here. Only primitives go into pdf.js, so nothing needs Cu.cloneInto (V3); pdf.js's return
   * values are not used, and nothing it returns is awaited (V4).
   * @param {unknown} raw
   */
  run(raw) {
    const msg = parsePdfOp(raw);
    if (!msg) return;
    const { op, n } = msg;
    const app = this.#app;
    const viewer = app.pdfViewer;
    try {
      switch (op) {
        case "next":
        case "prev":
          // In presentation mode, too: one page at a time.
          app.page = pdfPageTarget(
            op,
            n,
            num(() => app.page),
            num(() => app.pagesCount),
          );
          return;
        case "first":
        case "last":
          // A jump: goToPage records it in the history first (decision 9).
          app.pdfLinkService.goToPage(
            pdfPageTarget(
              op,
              n,
              num(() => app.page),
              num(() => app.pagesCount),
            ),
          );
          return;
        case "jump":
          // Before a search hit moves the view: ctrl+o comes back here (decision 9).
          app.pdfHistory.pushCurrentPosition();
          return;
        case "page_top":
        case "page_bottom":
          this.#toPageEdge(
            op === "page_top",
            num(() => app.page),
          );
          return;
        case "screen": {
          const el = this.#doc.querySelector(PDFJS_DOM.container);
          el?.scrollBy({ top: el.clientHeight * (n || 1), behavior: "instant" });
          return;
        }
        case "zoom":
          viewer.currentScale = pdfZoomStep(
            num(() => viewer.currentScale),
            n || 1,
          );
          return;
        case "scale":
          viewer.currentScale = pdfZoomPercent(n);
          return;
        case "fit_page":
          viewer.currentScaleValue = "page-fit";
          return;
        case "fit_width":
          viewer.currentScaleValue = "page-width";
          return;
        case "dual":
        case "first_alone": {
          const next = pdfSpread(
            op === "dual" ? "dual" : "first_alone",
            num(() => viewer.spreadMode),
            this.#lastSpread,
          );
          this.#lastSpread = next.last;
          viewer.spreadMode = next.mode;
          return;
        }
        case "single": {
          const next = pdfScrollMode(
            num(() => viewer.scrollMode),
            this.#previousScroll,
          );
          this.#previousScroll = next.previous;
          viewer.scrollMode = next.mode;
          return;
        }
        case "rotate":
          viewer.pagesRotation = pdfRotation(
            num(() => viewer.pagesRotation),
            n,
          );
          return;
        case "presentation":
          // Only for the user's own key (V9): the parent sends it for a key in the PDF viewer.
          if (this.presenting()) this.#doc.exitFullscreen();
          else app.requestPresentationMode();
      }
    } catch (e) {
      // A viewer that is not ready yet (no document), or not pdf.js's: nothing happens.
      console.warn("vimma: pdf operation failed", op, e);
    }
  }

  /** Whether pdf.js shows its presentation mode (decision 15). */
  presenting() {
    try {
      return this.#app.pdfViewer.isInPresentationMode === true;
    } catch {
      return false;
    }
  }

  /**
   * In presentation mode Vimma's scroll keys turn pages, since pdf.js shows one page at a time
   * there (decision 15).
   * @param {string} kind  the scroll kind
   * @param {number} count
   * @returns {boolean} whether it turned the page (false: scroll as usual)
   */
  turnPage(kind, count) {
    if (!this.presenting()) return false;
    const back = kind === "up" || kind === "half_up" || kind === "left";
    this.run({ op: back ? "prev" : "next", n: Math.max(0, Number(count) || 0) });
    return true;
  }

  /**
   * `H` / `P` and `L`: the current page's top or bottom edge at the view's, measured through
   * Xrays, so nothing of the viewer's script runs.
   * @param {boolean} top
   * @param {number} page
   */
  #toPageEdge(top, page) {
    if (!Number.isSafeInteger(page)) return;
    const el = this.#doc.querySelector(PDFJS_DOM.container);
    const div = this.#doc.querySelector(PDFJS_DOM.page.replace("{n}", String(page)));
    if (!el || !div) return;
    const view = el.getBoundingClientRect();
    const box = div.getBoundingClientRect();
    const by = top ? box.top - view.top : box.bottom - view.bottom;
    el.scrollBy({ top: Math.round(by), behavior: "instant" });
  }

  /** The state record: primitives only, checked again by the parent (parsePdfState). */
  read() {
    const app = this.#app;
    return {
      page: num(() => app.page),
      pages: num(() => app.pagesCount),
      // Bounded here too, so that a hostile viewer cannot push a huge string over IPC (V4).
      label: str(() => app.pdfViewer.currentPageLabel).slice(0, PDF_MAX_LABEL + 1),
      find: { current: this.#find.current, total: this.#find.total },
    };
  }

  /** Sends the state once the burst it is part of is over (V5). */
  schedule() {
    // The pref turned off after attaching: send nothing (the parent drops it anyway).
    if (this.#timer || !Services.prefs.getBoolPref(PDF_FEATURE_PREF, false)) return;
    this.#timer = lazy.setTimeout(() => {
      this.#timer = null;
      this.#send(this.read());
    }, PDF_STATE_MS);
  }

  destroy() {
    if (this.#timer) lazy.clearTimeout(this.#timer);
    this.#timer = null;
    for (const [name, fn] of this.#listeners) {
      try {
        this.#app.eventBus.off(name, fn);
      } catch {
        // the viewer went with its document
      }
    }
    this.#listeners = [];
  }
}
