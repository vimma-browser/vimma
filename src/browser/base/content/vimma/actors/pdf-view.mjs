/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one module that touches Firefox's pdf.js viewer (docs/specs/pdf-mode.md decisions 2 and 3;
// docs/security.md section 20). It runs in the viewer's content process, waives Xrays only after
// the principal check (V1), passes pdf.js only exported functions (V3), keeps only primitives from
// it (V4) and sends at most one state message per 100 ms (V5). Every pdf.js member it uses is in
// PDFJS_CONTRACT, which a mochitest holds to the pdf.js this build ships.

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

  /** The state record: primitives only, checked again by the parent (parsePdfState). */
  read() {
    const app = this.#app;
    return {
      page: num(() => app.page),
      pages: num(() => app.pagesCount),
      label: str(() => app.pdfViewer.currentPageLabel),
      find: { current: this.#find.current, total: this.#find.total },
    };
  }

  /** Sends the state once the burst it is part of is over (V5). */
  schedule() {
    if (this.#timer) return;
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
