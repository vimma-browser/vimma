/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one module that touches Firefox's pdf.js viewer (docs/specs/pdf-mode.md decisions 2 and 3;
// docs/security/20-pdf-viewer.md section 20). It runs in the viewer's content process, waives Xrays
// only after the principal check (V1), passes pdf.js only exported functions (V3), keeps only
// primitives from it (V4) and sends at most one state message per 100 ms (V5). Every pdf.js member
// it uses is in PDFJS_CONTRACT, which a mochitest holds to the pdf.js this build ships.

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
import {
  OUTLINE_MAX_DEPTH,
  OUTLINE_MAX_ENTRIES,
  OUTLINE_MAX_TITLE,
  OUTLINE_MAX_URL,
} from "../core/pdfoutline.mjs";

const lazy = /** @type {Lazy<"clearTimeout" | "setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** pdf.js's surfaces in the theme's tokens, and its sidebar hidden (decisions 18 and 20). */
export const PDF_SHEET = "chrome://browser/skin/vimma/firefox-pdf.css";

/** The largest token sheet the child takes (V12); ThemeHost's is a few KiB. */
export const PDF_THEME_MAX = 64 * 1024;

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
  // Delivery PR 4: the outline, read and followed as pdf.js's own outline view does.
  pdfDocument: "object",
  "pdfDocument.getOutline": "function",
  "pdfDocument.cachedPageNumber": "function",
  // Settles once pdf.js has fetched every page, so that cachedPageNumber knows them all (#1424).
  "pdfViewer.pagesPromise": "object",
  "pdfLinkService.goToDestination": "function",
  "pdfLinkService.executeNamedAction": "function",
  "pdfLinkService.executeSetOCGState": "function",
  // Delivery PR 5: marks (the view's position) and the pages internal links go to.
  "pdfViewer.update": "function",
  "pdfViewer._location": "object",
  "pdfViewer._location.pageNumber": "number",
  "pdfViewer._location.left": "number",
  "pdfViewer._location.top": "number",
  "pdfDocument.getDestination": "function",
  // A mark goes to its place as goToDestination does, without its focus (decision 11).
  "pdfHistory.push": "function",
  "pdfViewer.scrollPageIntoView": "function",
});

/**
 * The viewer's elements the adapter measures, through Xrays: the scrolling container and a page,
 * `{n}` standing for its number; and what a page that has finished drawing matches (`state.pdf`,
 * #1006): pdf.js sets `data-loaded` as it starts drawing a page and removes it when it drops the
 * drawing, and keeps `loadingIcon` on it from the start of a drawing to its end
 * (viewer.mjs, PDFPageView's renderingState setter and reset). The contract mochitest finds them
 * too.
 */
export const PDFJS_DOM = Object.freeze({
  container: "#viewerContainer",
  page: '#viewer .page[data-page-number="{n}"]',
  // Any page, and its text layer, which pdf.js adds to the page once its text has rendered.
  anyPage: "#viewer .page",
  textLayer: "#viewer .page > .textLayer",
  drawn: "[data-loaded]:not(.loadingIcon)",
});

/**
 * pdf.js events after which the state is read again: a page that starts and ends drawing among
 * them, for `drawn`.
 */
const EVENTS = [
  "pagesloaded",
  "pagechanging",
  "pagerender",
  "pagerendered",
  "updatefindmatchescount",
  "updatefindcontrolstate",
];

/**
 * The named actions an outline entry may run: pdf.js's navigation ones. Print and SaveAs from an
 * entry with an innocent title follow nothing.
 */
const OUTLINE_ACTIONS = new Set([
  "GoBack",
  "GoForward",
  "NextPage",
  "PrevPage",
  "FirstPage",
  "LastPage",
]);

/** A read the viewer never answers is given up after this long, so Tab works again. */
const OUTLINE_READ_MS = 5000;

/**
 * How long Tab's outline read waits for pdf.js to fetch every page: under the 2 s the parent
 * gives the reply (OUTLINE_WAIT_MS), so that a long PDF still opens its outline on Tab.
 */
const OUTLINE_PAGES_MS = 1000;

/**
 * How long the outline read waits for its named destinations' pages, after the outline: with
 * OUTLINE_PAGES_MS, still under the parent's 2 s (OUTLINE_WAIT_MS).
 */
const OUTLINE_NAMES_MS = 500;

/** A link's page the viewer does not resolve in this long is shown as its URL. */
const LINK_PAGE_MS = 2000;

/** Longer than any fragment pdf.js writes for a link (the hint collector's href limit). */
const MAX_LINK_HASH = 8192;

/**
 * Firefox's own test for the pdf.js viewer (nsContentUtils::IsPDFJS): its scheme and its origin
 * without the container suffix, so it holds in every workspace (V1).
 * @param {nsIPrincipal | null | undefined} principal
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

/**
 * `v` when it is an object (a function too), else null. Only that is checked: the caller casts it
 * to the PdfJs shape it expects (types/pdfjs.d.ts), whose members all stay unknown until read and
 * checked.
 * @param {unknown} v
 * @returns {object | null}
 */
function objectOr(v) {
  return (typeof v === "object" && v !== null) || typeof v === "function" ? v : null;
}

/**
 * Calls the viewer's method `name` of `self` as `self[name](...args)` does, or throws when it is no
 * function, which fails the operation that needed it. The result is the viewer's: unknown (V4).
 * @template {string} K
 * @param {PdfJs.Members<K>} self
 * @param {NoInfer<K>} name
 * @param {...unknown} args
 * @returns {unknown}
 */
function invoke(self, name, ...args) {
  const fn = self[name];
  if (typeof fn !== "function") throw new TypeError(`pdf.js has no ${name}()`);
  return Reflect.apply(fn, self, args);
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

/**
 * An outline entry as the parent gets it (parsePdfOutline): primitives only (V8).
 * @typedef {{ title: string, level: number, page: number, kind: string, collapsed: boolean, url?: string }} OutlineEntry
 */

/**
 * The outline message for the parent (`Vimma:PdfOutline`): primitives only, bounded (V8).
 * @typedef {{ entries: OutlineEntry[], truncated: boolean }} PdfOutlineMessage
 */

/**
 * The state message for the parent (`Vimma:PdfState`): primitives only (parsePdfState).
 * @typedef {ReturnType<PdfView["read"]>} PdfStateMessage
 */

export class PdfView {
  /** @type {PdfJs.App} the viewer's PDFViewerApplication, waived */
  #app;
  /** @type {Document} the viewer's document, through Xrays */
  #doc;
  /** The spread `d` goes back to, and the scroll mode `w` goes back to (decision 8). */
  /** @type {number} */
  #lastSpread = PDF_SPREAD.EVEN;
  /** @type {number} */
  #previousScroll = PDF_SCROLL.VERTICAL;
  /** @type {(state: PdfStateMessage) => void} */
  #send;
  /** @type {(outline: PdfOutlineMessage) => void} */
  #sendOutline;
  /** @type {() => number} how many operations the actor has received from the parent */
  #ops;
  /** @type {(() => void) | null} the window's resize listener */
  #onResize = null;
  /** @type {MutationObserver | null} gives each text layer pdf.js adds a focus that keeps the view */
  #textLayers = null;
  /** @type {Window} the viewer's window, through Xrays: exported functions belong to it */
  #win;
  /**
   * The outline as last read: the message for the parent, and each entry's target, which stays
   * here (V7, V8). null until the user's first Tab.
   * @type {{ message: PdfOutlineMessage, targets: unknown[] } | null}
   */
  #outline = null;
  #readingOutline = false;
  /** @type {(() => void) | null} the read waiting for pdf.js's pages, which a Tab hurries */
  #waitingRead = null;
  /** Counts the documents pdf.js opens in this viewer, so the parent drops an old outline. */
  #generation = 0;
  /** @type {number | null} */
  #timer = null;
  #find = { current: 0, total: 0 };
  /** @type {[string, (event: unknown) => void][]} made with Cu.exportFunction */
  #listeners = [];
  /** The token sheet loaded into the viewer, as a data: URI; "" before the first. */
  #themeUri = "";
  /** PDF_SHEET is loaded (once). */
  #sheetLoaded = false;
  /**
   * The window's CSS size as the last resize event left it (#scale). Until the resize event for
   * a new size or zoom has run, pdf.js has not dropped the pages it drew at the old one, so no
   * report then says drawn.
   */
  #seenScale = "";

  /**
   * The adapter for an actor's document, or null when it is not the top-level pdf.js viewer.
   * @param {JSWindowActorChild} actor   the VimmaChild
   * @param {(state: PdfStateMessage) => void} send
   * @param {(outline: PdfOutlineMessage) => void} [sendOutline]
   * @param {() => number} [ops]  how many operations the actor has received
   * @returns {PdfView | null}
   */
  static attach(actor, send, sendOutline = () => {}, ops = () => 0) {
    // Top level only: a PDF in a web page's frame keeps the page's keys (V2).
    if (actor.browsingContext.parent) return null;
    const doc = actor.document;
    if (!isPdfJsPrincipal(doc?.nodePrincipal)) return null;
    const win = actor.contentWindow;
    if (!win) return null;
    /** @type {unknown} */
    let app;
    try {
      // Waived, the window shows what the viewer's script set on it: unknown until checked.
      const waived = /** @type {{ readonly [name: string]: unknown }} */ (Cu.waiveXrays(win));
      app = waived.PDFViewerApplication;
    } catch {
      return null;
    }
    if (!app || typeof app !== "object") return null;
    return new PdfView(win, /** @type {PdfJs.App} */ (app), send, sendOutline, ops);
  }

  /**
   * @param {Window} win  the viewer's window, through Xrays
   * @param {PdfJs.App} app  waived
   * @param {(state: PdfStateMessage) => void} send
   * @param {(outline: PdfOutlineMessage) => void} sendOutline
   * @param {() => number} ops
   */
  constructor(win, app, send, sendOutline, ops) {
    this.#app = app;
    this.#win = win;
    this.#doc = win.document;
    this.#send = send;
    this.#sendOutline = sendOutline;
    this.#ops = ops;
    // A resize (the outline opening beside the document) redraws the pages at the new size: the
    // report says which size it was made at (`state.pdf`). The window's own event, in Vimma's
    // scope, so nothing of the viewer's script runs.
    this.#seenScale = this.#scale();
    this.#onResize = () => {
      this.#seenScale = this.#scale();
      this.schedule();
    };
    win.addEventListener("resize", this.#onResize);
    this.#keepViewOnTextLayerFocus();
    // pdf.js calls these with its own event objects; Cu.exportFunction keeps the arguments
    // behind Xrays (V3, V4).
    const onState = Cu.exportFunction(() => this.schedule(), win);
    const onCount = Cu.exportFunction((/** @type {unknown} */ evt) => this.#onCount(evt), win);
    // pdf.js can open another PDF in the same viewer: the outline read goes with the old one,
    // and the parent learns of it from the next state message (V11).
    const onDocument = Cu.exportFunction(() => {
      this.#outline = null;
      this.#readingOutline = false;
      this.#generation++;
      this.schedule();
    }, win);
    try {
      invoke(this.#part("eventBus"), "on", "documentloaded", onDocument);
      this.#listeners.push(["documentloaded", onDocument]);
    } catch {
      // no event bus: nothing to forget
    }
    for (const name of EVENTS) {
      const fn = name.startsWith("updatefind") ? onCount : onState;
      try {
        invoke(this.#part("eventBus"), "on", name, fn);
        this.#listeners.push([name, fn]);
      } catch {
        // a viewer without its event bus reports nothing
      }
    }
    this.schedule();
  }

  /**
   * pdf.js's goToDestination (a link, an outline entry, `ctrl+o` back to a link's entry) focuses
   * the page's text layer once the page has rendered, and a focus scrolls an element out of view
   * into it. On a busy viewer that render comes after the next key (a link, then `2G`), which the
   * focus undid: the view went back to the link's page, and the jump list's walk back (decision 9)
   * left from there. Each text layer gets its own `focus`, an exported function (V3) that focuses
   * it as pdf.js asks without scrolling: while the page is in view a focus scrolls nothing anyway.
   * pdf.js adds a text layer to its page when its text has rendered, a microtask before it
   * dispatches `textlayerrendered`, so the observer sees it first. Only the viewer's DOM is read,
   * through Xrays.
   */
  #keepViewOnTextLayerFocus() {
    const win = this.#win;
    const keep = (/** @type {Element} */ layer) => {
      const focus = Cu.exportFunction(() => {
        try {
          /** @type {HTMLElement} */ (layer).focus({ preventScroll: true });
        } catch {
          // the layer went with its page
        }
      }, win);
      // An own property of the element, seen by the viewer's script only: Xrays keep the
      // element's own focus for Vimma. Defined, not assigned: an assignment would run a `focus`
      // setter the viewer put on the prototype, inside this observer (V3).
      try {
        Object.defineProperty(Cu.waiveXrays(layer), "focus", {
          value: focus,
          configurable: true,
          writable: true,
        });
      } catch {
        // a layer the viewer made refuse the property keeps its own focus; the others, in the
        // first scan or in the same batch of records, still get theirs
      }
    };
    try {
      const container = this.#doc.querySelector(PDFJS_DOM.container);
      if (!container) return;
      for (const layer of container.querySelectorAll(PDFJS_DOM.textLayer)) keep(layer);
      this.#textLayers = new win.MutationObserver((records) => {
        for (const record of records) {
          // A text layer is a page's child; a zoom refills one with its text, which needs no look.
          const parent = /** @type {Element} */ (record.target);
          if (parent.nodeType !== 1 || !parent.matches(PDFJS_DOM.anyPage)) continue;
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = /** @type {Element} */ (node);
            if (el.matches(PDFJS_DOM.textLayer)) keep(el);
          }
        }
      });
      this.#textLayers.observe(container, { childList: true, subtree: true });
    } catch {
      // a viewer without its container: its focus stays pdf.js's
    }
  }

  /**
   * One of PDFViewerApplication's parts, waived; throws when the viewer has no such object, which
   * fails the operation that needed it. Its getter is the viewer's, and may throw too.
   * @template {keyof PdfJs.Parts} K
   * @param {K} name
   * @returns {PdfJs.Parts[K]}
   */
  #part(name) {
    const part = objectOr(this.#app[name]);
    if (!part) throw new TypeError(`pdf.js has no ${name}`);
    return /** @type {PdfJs.Parts[K]} */ (part);
  }

  /** @param {unknown} evt  through Xrays: only own data properties are visible */
  #onCount(evt) {
    let current = NaN;
    let total = NaN;
    try {
      const e = /** @type {PdfJs.FindEvent | null} */ (objectOr(evt));
      const m = /** @type {PdfJs.MatchesCount | null} */ (objectOr(e?.matchesCount));
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
   * here. Only primitives go into pdf.js, and a mark's destination and the arguments that go with
   * it are cloned into the viewer (V3); pdf.js's return values are not used, and nothing it
   * returns is awaited (V4).
   * @param {unknown} raw
   * @returns {boolean} whether it reached pdf.js
   */
  run(raw) {
    const msg = parsePdfOp(raw);
    if (!msg) return false;
    const { op, n } = msg;
    const app = this.#app;
    // pdf.js's live values, or nothing happens: a viewer without its document (or a hostile
    // getter) gives no number to compute from. Its parts are read inside the try below: a getter
    // that throws fails this operation, not the report that follows it.
    const page = num(() => app.page);
    const pages = num(() => app.pagesCount);
    const live = (/** @type {number[]} */ ...v) => v.every(Number.isFinite);
    try {
      switch (op) {
        case "next":
        case "prev":
          // In presentation mode, too: one page at a time.
          if (!live(page, pages)) return false;
          app.page = pdfPageTarget(op, n, page, pages);
          return true;
        case "first":
        case "last":
          // A jump: goToPage records it in the history first (decision 9).
          if (!live(page, pages)) return false;
          this.#settle();
          invoke(this.#part("pdfLinkService"), "goToPage", pdfPageTarget(op, n, page, pages));
          return true;
        case "jump":
          // Before a search hit moves the view: ctrl+o comes back here (decision 9).
          this.#settle();
          invoke(this.#part("pdfHistory"), "pushCurrentPosition");
          return true;
        case "page_top":
        case "page_bottom":
          this.#toPageEdge(
            op === "page_top",
            num(() => app.page),
          );
          return true;
        case "screen": {
          const el = this.#doc.querySelector(PDFJS_DOM.container);
          el?.scrollBy({ top: el.clientHeight * (n || 1), behavior: "instant" });
          return true;
        }
        // A zoom keeps the place pdf.js last recorded, which can be a frame old: settled first,
        // a zoom right after a page key (`3J150=`) stays on the new page.
        case "zoom": {
          const viewer = this.#part("pdfViewer");
          const scale = num(() => viewer.currentScale);
          if (!live(scale)) return false;
          this.#settle();
          viewer.currentScale = pdfZoomStep(scale, n || 1);
          return true;
        }
        case "scale":
          this.#settle();
          this.#part("pdfViewer").currentScale = pdfZoomPercent(n);
          return true;
        case "fit_page":
          this.#settle();
          this.#part("pdfViewer").currentScaleValue = "page-fit";
          return true;
        case "fit_width":
          this.#settle();
          this.#part("pdfViewer").currentScaleValue = "page-width";
          return true;
        case "dual":
        case "first_alone": {
          const viewer = this.#part("pdfViewer");
          const next = pdfSpread(
            op === "dual" ? "dual" : "first_alone",
            num(() => viewer.spreadMode),
            this.#lastSpread,
          );
          this.#lastSpread = next.last;
          viewer.spreadMode = next.mode;
          return true;
        }
        case "single": {
          const viewer = this.#part("pdfViewer");
          const next = pdfScrollMode(
            num(() => viewer.scrollMode),
            this.#previousScroll,
          );
          this.#previousScroll = next.previous;
          viewer.scrollMode = next.mode;
          return true;
        }
        case "rotate": {
          const viewer = this.#part("pdfViewer");
          const rotation = num(() => viewer.pagesRotation);
          if (!live(rotation)) return false;
          viewer.pagesRotation = pdfRotation(rotation, n);
          return true;
        }
        case "outline":
          // Only for the user's Tab in the PDF viewer, or once as the PDF opens (V8); n is 1 for
          // the read that waits for every page.
          this.#readOutline(n === 1);
          return true;
        case "follow":
          return this.#follow(n);
        case "go": {
          // A mark (decision 11): an XYZ destination on its page, the jump recorded in the
          // history first (decision 9), as goToDestination does. Not through goToDestination,
          // which also focuses the page's text layer once it has rendered: on a busy viewer that
          // comes after the next key (`'a` then `G`) and scrolls the view back to the mark.
          // Everything is cloned into the viewer (V3).
          const at = msg.at;
          if (!at || !live(pages) || at.page > pages) return false;
          const dest = [at.page - 1, { name: "XYZ" }, at.left, at.top, at.scale];
          const viewer = this.#part("pdfViewer");
          // A viewer without its history scrolls without recording the jump; one whose history
          // is no object fails the mark.
          const raw = app.pdfHistory;
          this.#settle();
          if (raw !== null && raw !== undefined) {
            const history = /** @type {PdfJs.History | null} */ (objectOr(raw));
            if (!history) throw new TypeError("pdf.js has no pdfHistory");
            invoke(history, "pushCurrentPosition");
            invoke(
              history,
              "push",
              Cu.cloneInto({ namedDest: null, explicitDest: dest, pageNumber: at.page }, this.#win),
            );
          }
          // A mark comes back at its zoom (decision 11), whatever pdfjs.ignoreDestinationZoom
          // says for a link.
          invoke(
            viewer,
            "scrollPageIntoView",
            Cu.cloneInto(
              { pageNumber: at.page, destArray: dest, ignoreDestinationZoom: false },
              this.#win,
            ),
          );
          return true;
        }
        case "presentation":
          // Only for the user's own key or :present (V9), which the parent sends in the PDF viewer.
          // A viewer that claims presentation without being full screen gets nothing to exit.
          if (this.presenting()) {
            if (this.#doc.fullscreenElement) this.#doc.exitFullscreen().catch(() => {});
          } else invoke(app, "requestPresentationMode");
          return true;
      }
    } catch (e) {
      // A viewer that is not ready yet (no document), or not pdf.js's: nothing happens.
      console.warn("vimma: pdf operation failed", op, e);
    }
    return false;
  }

  /**
   * Reads the outline and sends it to the parent (decision 10, V8). pdf.js's promises come back
   * only through exported callbacks passed to their `then` through Xrays, never awaited (V4); a
   * second Tab sends the outline already read.
   *
   * pdf.js gives a destination's page (cachedPageNumber) only for a page it has fetched, and it
   * fetches the pages after the first one draws: read before that, every entry past the first
   * page has no page, and the selection of an outline shown beside the document cannot follow
   * the page (#1424). The read waits for pdf.js's `pagesPromise`, all the way with `allPages`,
   * else at most OUTLINE_PAGES_MS.
   * @param {boolean} allPages
   */
  #readOutline(allPages) {
    if (this.#outline) {
      this.#sendOutline(this.#outline.message);
      return;
    }
    if (this.#readingOutline) {
      // Tab while the read as the PDF opens waits for every page: Tab's own bound applies.
      const waiting = this.#waitingRead;
      if (!allPages && waiting) lazy.setTimeout(waiting, OUTLINE_PAGES_MS);
      return;
    }
    this.#readingOutline = true;
    lazy.setTimeout(() => {
      this.#readingOutline = false;
    }, OUTLINE_READ_MS);
    // A read under way when pdf.js opens another PDF is the old document's: dropped (V11).
    const generation = this.#generation;
    const done = Cu.exportFunction((/** @type {unknown} */ items) => {
      if (generation === this.#generation) this.#onOutline(items);
      else this.#readingOutline = false;
    }, this.#win);
    const failed = Cu.exportFunction(() => {
      this.#readingOutline = false;
    }, this.#win);
    let started = false;
    const read = () => {
      if (started) return;
      started = true;
      if (this.#waitingRead === read) this.#waitingRead = null;
      if (generation !== this.#generation) {
        this.#readingOutline = false;
      } else if (this.#outline) {
        // Another read, begun after OUTLINE_READ_MS gave this one up, has finished.
        this.#sendOutline(this.#outline.message);
      } else if (!this.#then(() => invoke(this.#part("pdfDocument"), "getOutline"), done, failed)) {
        this.#readingOutline = false;
      }
    };
    const loaded = Cu.exportFunction(read, this.#win);
    this.#waitingRead = read;
    if (!this.#then(() => this.#part("pdfViewer").pagesPromise, loaded, loaded)) read();
    else if (!allPages) lazy.setTimeout(read, OUTLINE_PAGES_MS);
  }

  /**
   * Calls `read` (a pdf.js method that returns a promise) and passes the callbacks to the
   * promise's own `then`, seen through Xrays: a viewer's object with a `then` of its own is a
   * plain object there, whose functions Xrays do not show.
   * @param {() => unknown} read
   * @param {(value: unknown) => void} done  made with Cu.exportFunction
   * @param {() => void} failed  made with Cu.exportFunction
   * @returns {boolean} whether the callbacks were passed on
   */
  #then(read, done, failed) {
    try {
      const promise = /** @type {PdfJs.Thenable | null} */ (objectOr(Cu.unwaiveXrays(read())));
      if (!promise) return false;
      invoke(promise, "then", done, failed);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The outline tree from pdf.js, read through Xrays (V4): only the fields Vimma shows, as
   * primitives, bounded as the parent bounds them (parsePdfOutline), and each entry's target
   * kept here.
   * @param {unknown} items  through Xrays
   */
  #onOutline(items) {
    const pages = num(() => this.#app.pagesCount);
    /** @type {OutlineEntry[]} */
    const entries = [];
    /** @type {unknown[]} */
    const targets = [];
    /** @type {[number, string][]} entries whose destination is a name, resolved below */
    const named = [];
    let truncated = false;
    // Items visited, not entries kept: a sparse array with a huge length stops here too.
    let visited = 0;
    /** @param {unknown} value  through Xrays @param {number} level */
    const walk = (value, level) => {
      const list =
        /** @type {{ readonly [i: number]: unknown, readonly length: unknown } | null} */ (
          objectOr(value)
        );
      const length = num(() => list?.length);
      for (let i = 0; i < length; i++) {
        if (entries.length >= OUTLINE_MAX_ENTRIES || ++visited > OUTLINE_MAX_ENTRIES) {
          truncated = true;
          return;
        }
        /** @type {unknown} */
        let value;
        try {
          value = list?.[i];
        } catch {
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const item = /** @type {PdfJs.OutlineItem} */ (value);
        const { entry, target } = this.#entry(item, level, pages);
        if (typeof target === "string" && entry.kind === "dest") {
          named.push([entries.length, target]);
        }
        targets.push(target);
        entries.push(entry);
        /** @type {unknown} */
        let children = null;
        try {
          children = item.items;
        } catch {
          // no children
        }
        const kids = /** @type {{ readonly length?: unknown } | null} */ (objectOr(children));
        if (num(() => kids?.length) > 0) {
          if (level >= OUTLINE_MAX_DEPTH) truncated = true;
          else walk(children, level + 1);
        }
      }
    };
    walk(items, 1);
    const generation = this.#generation;
    const finish = () => {
      this.#readingOutline = false;
      if (generation !== this.#generation) return;
      this.#outline = { message: { entries, truncated }, targets };
      this.#sendOutline(this.#outline.message);
    };
    if (!named.length) {
      finish();
      return;
    }
    // Each name resolves through getDestination, as linkPage resolves a link's and pdf.js's own
    // viewer resolves a name (#1433): getDestinations gives a Map, which no own-key lookup
    // matches. Names are asked once each, all at once; one not answered within
    // OUTLINE_NAMES_MS stays 0.
    /** @type {Map<string, number[]>} */
    const byName = new Map();
    for (const [index, name] of named) {
      const indexes = byName.get(name);
      if (indexes) indexes.push(index);
      else byName.set(name, [index]);
    }
    let pending = byName.size;
    let finished = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const settle = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) lazy.clearTimeout(timer);
      finish();
    };
    const answered = () => {
      if (--pending <= 0) settle();
    };
    timer = lazy.setTimeout(settle, OUTLINE_NAMES_MS);
    for (const [name, indexes] of byName) {
      const resolved = Cu.exportFunction((/** @type {unknown} */ dest) => {
        if (!finished) {
          const page = this.#pageOf(dest, pages);
          for (const index of indexes) {
            const entry = entries[index];
            if (entry) entry.page = page;
          }
        }
        answered();
      }, this.#win);
      const failed = Cu.exportFunction(answered, this.#win);
      const read = () => invoke(this.#part("pdfDocument"), "getDestination", name);
      if (!this.#then(read, resolved, failed)) answered();
    }
  }

  /**
   * One outline item, as pdf.js's outline view reads it (`_bindLink`): its kind, by the first of
   * url, action, attachment, layer change and destination it has.
   * @param {PdfJs.OutlineItem} item  through Xrays
   * @param {number} level
   * @param {number} pages
   * @returns {{ entry: OutlineEntry, target: unknown }} the target stays in this process (V8)
   */
  #entry(item, level, pages) {
    /** @param {keyof PdfJs.OutlineItem} key @returns {unknown} */
    const get = (key) => {
      try {
        return item[key];
      } catch {
        return undefined;
      }
    };
    const title = get("title");
    const count = get("count");
    const url = get("url");
    const action = get("action");
    const dest = get("dest");
    /** @type {OutlineEntry} */
    const entry = {
      title: typeof title === "string" ? title.slice(0, OUTLINE_MAX_TITLE) : "",
      level,
      page: 0,
      kind: "none",
      collapsed: typeof count === "number" && count < 0,
    };
    /** @type {unknown} */
    let target = null;
    if (typeof url === "string" && url) {
      // A longer URL is no link Vimma opens (V8): the entry stays, with nothing to follow.
      if (url.length <= OUTLINE_MAX_URL) {
        entry.kind = "url";
        entry.url = url;
      }
    } else if (typeof action === "string" && action) {
      if (OUTLINE_ACTIONS.has(action)) {
        entry.kind = "action";
        target = action;
      }
    } else if (get("attachment") && typeof get("attachment") === "object") {
      entry.kind = "attachment";
    } else if (get("setOCGState") && typeof get("setOCGState") === "object") {
      entry.kind = "ocg";
      target = get("setOCGState");
    } else if (typeof dest === "string" || (dest && typeof dest === "object")) {
      entry.kind = "dest";
      target = dest;
      if (typeof dest !== "string") entry.page = this.#pageOf(dest, pages);
    }
    return { entry, target };
  }

  /**
   * The page an explicit destination points at, as pdf.js resolves its current outline item: a
   * page reference it has seen, or a page index; 0 when it does not resolve.
   * @param {unknown} dest  through Xrays
   * @param {number} pages
   */
  #pageOf(dest, pages) {
    let page = NaN;
    try {
      const ref = /** @type {{ readonly 0?: unknown } | null} */ (objectOr(dest))?.[0];
      if (typeof ref === "number") page = ref + 1;
      else if (ref && typeof ref === "object") {
        page = num(() => invoke(this.#part("pdfDocument"), "cachedPageNumber", ref));
      }
    } catch {
      // not resolved
    }
    return Number.isSafeInteger(page) && page >= 1 && page <= pages ? page : 0;
  }

  /**
   * Follows the outline entry at `index` as pdf.js's outline view does (decision 10): the
   * target never left this process, so the parent names it by its index only (V7).
   * @param {number} index
   * @returns {boolean} whether pdf.js was asked
   */
  #follow(index) {
    const entries = this.#outline?.message.entries;
    const target = this.#outline?.targets[index];
    const kind = entries?.[index]?.kind;
    if (target === undefined || target === null) return false;
    const link = this.#part("pdfLinkService");
    this.#settle();
    // goToDestination records a history entry first (decision 9).
    if (kind === "dest") invoke(link, "goToDestination", target);
    else if (kind === "action") invoke(link, "executeNamedAction", target);
    else if (kind === "ocg") invoke(link, "executeSetOCGState", target);
    else return false;
    return true;
  }

  /**
   * Brings pdf.js's record of the view up to date before a jump or a zoom. pdf.js updates it on
   * the animation frame after a scroll, and its history records where a jump starts from that
   * record: a jump a moment after another (`G` then `'a`), or right after the document loaded,
   * would record a stale start or none, and ctrl+o would come back to the wrong place
   * (decision 9). A zoom scrolls back to that record, so a stale one undid the page key before
   * it.
   */
  #settle() {
    try {
      invoke(this.#part("pdfViewer"), "update");
    } catch {
      // a viewer without its document: nothing to record
    }
  }

  /**
   * Where the view is, for a mark (decision 11): pdf.js's own record of the page and the point
   * of it at the view's top left, and the scale; primitives only (V4), checked by the parent
   * (parsePdfPosition).
   */
  position() {
    /** @type {PdfJs.Viewer | null} */
    let viewer = null;
    /** @type {PdfJs.Location | null} */
    let location = null;
    // A mark set right after a key that scrolled is where the view is now.
    this.#settle();
    try {
      viewer = this.#part("pdfViewer");
      location = /** @type {PdfJs.Location | null} */ (objectOr(viewer._location));
    } catch {
      // no position: the parent drops the record
    }
    return {
      page: num(() => location?.pageNumber),
      left: num(() => location?.left),
      top: num(() => location?.top),
      scale: num(() => viewer?.currentScale),
    };
  }

  /**
   * The page an internal link of pdf.js's annotation layer goes to, for `F` (decision 16): its
   * fragment read as pdf.js's setHash reads it (`page=`, an explicit destination in JSON, or a
   * named destination). `done` gets a page number, or 0 when it does not resolve; a named
   * destination comes back only through an exported callback (V4).
   * @param {Element} el  the link, through Xrays
   * @param {(page: number) => void} done
   */
  linkPage(el, done) {
    let answered = false;
    const answer = (/** @type {number} */ page) => {
      if (answered) return;
      answered = true;
      done(page);
    };
    const pages = num(() => this.#app.pagesCount);
    let hash = "";
    try {
      hash = URL.parse(/** @type {HTMLAnchorElement} */ (el).href)?.hash.slice(1) ?? "";
    } catch {
      // not a link
    }
    if (!hash || hash.length > MAX_LINK_HASH) return answer(0);
    /** @type {unknown} */
    let dest = unescape(hash);
    if (hash.includes("=")) {
      const params = new URLSearchParams(hash);
      if (params.has("nameddest")) dest = params.get("nameddest") ?? "";
      else {
        const page = Number(params.get("page"));
        return answer(Number.isSafeInteger(page) && page >= 1 && page <= pages ? page : 0);
      }
    } else {
      try {
        dest = JSON.parse(/** @type {string} */ (dest));
        // pdf.js reads anything but an array as a destination's name (`#5` names "5").
        if (!Array.isArray(dest)) dest = String(dest);
      } catch {
        // a named destination
      }
    }
    if (Array.isArray(dest)) {
      // pdf.js looks the page reference up in its own cache: a clone it can read (V3).
      return answer(this.#pageOf(Cu.cloneInto(dest, this.#win), pages));
    }
    if (typeof dest !== "string") return answer(0);
    lazy.setTimeout(() => answer(0), LINK_PAGE_MS);
    const resolved = Cu.exportFunction(
      (/** @type {unknown} */ explicit) => answer(this.#pageOf(explicit, pages)),
      this.#win,
    );
    const failed = Cu.exportFunction(() => answer(0), this.#win);
    const name = /** @type {string} */ (dest);
    const read = () => invoke(this.#part("pdfDocument"), "getDestination", name);
    if (!this.#then(read, resolved, failed)) {
      answer(0);
    }
    return undefined;
  }

  /**
   * The viewer's look (decisions 18 and 20, V12): `css`, the theme's token sheet from the parent,
   * and PDF_SHEET, as author sheets of the viewer's document, which its CSP does not apply to.
   * CSS only: nothing runs in the viewer and nothing goes into pdf.js. A new token sheet loads
   * before the old one goes, so no frame is drawn without tokens.
   * @param {unknown} css
   */
  setTheme(css) {
    if (typeof css !== "string" || !css || css.length > PDF_THEME_MAX) return;
    const uri = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
    if (uri === this.#themeUri) return;
    try {
      const utils = this.#win.windowUtils;
      if (!this.#sheetLoaded) {
        utils.loadSheetUsingURIString(PDF_SHEET, utils.AUTHOR_SHEET);
        this.#sheetLoaded = true;
      }
      utils.loadSheetUsingURIString(uri, utils.AUTHOR_SHEET);
      if (this.#themeUri) utils.removeSheetUsingURIString(this.#themeUri, utils.AUTHOR_SHEET);
      this.#themeUri = uri;
    } catch (e) {
      // the document went away
      console.warn("vimma: the PDF viewer's theme was not applied", e);
    }
  }

  /** Whether pdf.js shows its presentation mode (decision 15). */
  presenting() {
    try {
      return this.#part("pdfViewer").isInPresentationMode === true;
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
    /** @type {Record<string, string>} */
    const ops = {
      down: "next",
      half_down: "next",
      right: "next",
      up: "prev",
      half_up: "prev",
      left: "prev",
      top: "first",
      bottom: "last",
    };
    const op = ops[kind];
    if (!op) return false;
    const n = op === "first" || op === "last" ? 0 : Math.max(0, Number(count) || 0);
    return this.run({ op, n });
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
      label: str(() => this.#part("pdfViewer").currentPageLabel).slice(0, PDF_MAX_LABEL + 1),
      find: { current: this.#find.current, total: this.#find.total },
      doc: this.#generation,
      drawn: this.#drawn() && this.#scale() === this.#seenScale,
      ops: this.#ops(),
      ...this.#size(),
    };
  }

  /**
   * The window's CSS size, which a resize and a full-zoom change that changes the page's layout
   * both change. Such a zoom change reaches the viewer's window at once
   * (BrowsingContext::DidSet recomputes its pres context), but pdf.js drops the pages it drew at
   * the old zoom only in its `(resolution: …dppx)` media query listener (viewer.mjs,
   * addWindowResolutionChange, then pdfViewer.refresh) and its resize handler, in the next
   * refresh tick. That tick runs the resize steps, where this listener of Vimma's records the
   * new size, and then the media query changes, before any timer can run; a report timer that
   * fired between the zoom and that tick would have read the old pages as drawn (#1040). Not the
   * pixel ratio: moving the window to a screen of another scale changes it with no resize event,
   * and the parent compares the zoom itself.
   */
  #scale() {
    const win = this.#win;
    return `${win.innerWidth} ${win.innerHeight}`;
  }

  /**
   * The viewer's size in whole device pixels, the one unit the parent can compare it in: a
   * system caller gets the unrounded CSS size (nsGlobalWindowOuter's GetInnerSize), fractional
   * at a fractional desktop scale or full zoom, and the content's scale is the desktop scale
   * times the full zoom snapped to whole app units per device pixel, which the parent does not
   * see. The full zoom goes too, so that the parent can tell a report from before a zoom
   * change, which leaves the size in device pixels as it was (#1040): the browsing context's,
   * the synced value the parent compares it with, exactly.
   */
  #size() {
    const win = this.#win;
    const ratio = win.devicePixelRatio;
    let zoom = 0;
    try {
      zoom = win.browsingContext.fullZoom;
    } catch {
      // the browsing context went with the window: the parent reads the report as not drawn
    }
    return {
      width: Math.round(win.innerWidth * ratio),
      height: Math.round(win.innerHeight * ratio),
      zoom,
    };
  }

  /**
   * Whether every page in the view has finished drawing (`state.pdf`, #1006), read from the
   * viewer's DOM through Xrays: from the current page outward while the pages are in view, so a
   * long document costs no more than the pages shown. False before the pages are laid out.
   */
  #drawn() {
    const doc = this.#doc;
    const page = num(() => this.#app.page);
    const view = doc.querySelector(PDFJS_DOM.container)?.getBoundingClientRect();
    if (!view || !Number.isSafeInteger(page) || page < 1) return false;
    const pageDiv = (/** @type {number} */ n) =>
      doc.querySelector(PDFJS_DOM.page.replace("{n}", String(n)));
    const inView = (/** @type {Element | null} */ div) => {
      const r = div?.getBoundingClientRect();
      return (
        !!r &&
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > view.top &&
        r.top < view.bottom &&
        r.right > view.left &&
        r.left < view.right
      );
    };
    if (!inView(pageDiv(page))) return false;
    for (const step of [-1, 1]) {
      for (let n = page, div = pageDiv(n); inView(div); n += step, div = pageDiv(n)) {
        if (!div?.matches(PDFJS_DOM.drawn)) return false;
      }
    }
    return true;
  }

  /** Sends the state once the burst it is part of is over (V5). */
  schedule() {
    if (this.#timer) return;
    this.#timer = lazy.setTimeout(() => {
      this.#timer = null;
      if (!this.#gone()) this.#send(this.read());
    }, PDF_STATE_MS);
  }

  /**
   * Whether the viewer's window has gone, as it can between the timer's start and the actor's
   * didDestroy (#1040): a window that is no longer current throws NS_ERROR_UNEXPECTED at its
   * sizes (nsGlobalWindowInner, FORWARD_TO_OUTER_OR_THROW) but reads `closed` as true, and a
   * window whose compartment was cut off throws at any access.
   */
  #gone() {
    try {
      return this.#win.closed;
    } catch {
      return true;
    }
  }

  destroy() {
    if (this.#timer) lazy.clearTimeout(this.#timer);
    this.#timer = null;
    this.#textLayers?.disconnect();
    this.#textLayers = null;
    if (this.#onResize) {
      try {
        this.#win.removeEventListener("resize", this.#onResize);
      } catch {
        // the window went with its document
      }
      this.#onResize = null;
    }
    for (const [name, fn] of this.#listeners) {
      try {
        invoke(this.#part("eventBus"), "off", name, fn);
      } catch {
        // the viewer went with its document
      }
    }
    this.#listeners = [];
  }
}
