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
import {
  OUTLINE_MAX_DEPTH,
  OUTLINE_MAX_ENTRIES,
  OUTLINE_MAX_TITLE,
  OUTLINE_MAX_URL,
} from "../core/pdfoutline.mjs";

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
  // Delivery PR 4: the outline, read and followed as pdf.js's own outline view does.
  pdfDocument: "object",
  "pdfDocument.getOutline": "function",
  "pdfDocument.getDestinations": "function",
  "pdfDocument.cachedPageNumber": "function",
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

/** A link's page the viewer does not resolve in this long is shown as its URL. */
const LINK_PAGE_MS = 2000;

/** Longer than any fragment pdf.js writes for a link (the hint collector's href limit). */
const MAX_LINK_HASH = 8192;

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
  /** @type {(outline: object) => void} */
  #sendOutline;
  /** @type {Window} the viewer's window, through Xrays: exported functions belong to it */
  #win;
  /**
   * The outline as last read: the message for the parent, and each entry's target, which stays
   * here (V7, V8). null until the user's first Tab.
   * @type {{ message: { entries: object[], truncated: boolean }, targets: any[] } | null}
   */
  #outline = null;
  #readingOutline = false;
  /** Counts the documents pdf.js opens in this viewer, so the parent drops an old outline. */
  #generation = 0;
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
   * @param {(outline: object) => void} [sendOutline]
   * @returns {PdfView | null}
   */
  static attach(actor, send, sendOutline = () => {}) {
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
    return new PdfView(actor.contentWindow, app, send, sendOutline);
  }

  /**
   * @param {Window} win  the viewer's window, through Xrays
   * @param {any} app
   * @param {(state: object) => void} send
   * @param {(outline: object) => void} sendOutline
   */
  constructor(win, app, send, sendOutline) {
    this.#app = app;
    this.#win = win;
    this.#doc = win.document;
    this.#send = send;
    this.#sendOutline = sendOutline;
    // pdf.js calls these with its own event objects; Cu.exportFunction keeps the arguments
    // behind Xrays (V3, V4).
    const onState = Cu.exportFunction(() => this.schedule(), win);
    const onCount = Cu.exportFunction((/** @type {any} */ evt) => this.#onCount(evt), win);
    // pdf.js can open another PDF in the same viewer: the outline read goes with the old one,
    // and the parent learns of it from the next state message (V11).
    const onDocument = Cu.exportFunction(() => {
      this.#outline = null;
      this.#generation++;
      this.schedule();
    }, win);
    try {
      this.#app.eventBus.on("documentloaded", onDocument);
      this.#listeners.push(["documentloaded", onDocument]);
    } catch {
      // no event bus: nothing to forget
    }
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
   * @returns {boolean} whether it reached pdf.js
   */
  run(raw) {
    const msg = parsePdfOp(raw);
    if (!msg) return false;
    const { op, n } = msg;
    const app = this.#app;
    const viewer = app.pdfViewer;
    // pdf.js's live values, or nothing happens: a viewer without its document (or a hostile
    // getter) gives no number to compute from.
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
          app.pdfLinkService.goToPage(pdfPageTarget(op, n, page, pages));
          return true;
        case "jump":
          // Before a search hit moves the view: ctrl+o comes back here (decision 9).
          this.#settle();
          app.pdfHistory.pushCurrentPosition();
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
        case "zoom": {
          const scale = num(() => viewer.currentScale);
          if (!live(scale)) return false;
          viewer.currentScale = pdfZoomStep(scale, n || 1);
          return true;
        }
        case "scale":
          viewer.currentScale = pdfZoomPercent(n);
          return true;
        case "fit_page":
          viewer.currentScaleValue = "page-fit";
          return true;
        case "fit_width":
          viewer.currentScaleValue = "page-width";
          return true;
        case "dual":
        case "first_alone": {
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
          const next = pdfScrollMode(
            num(() => viewer.scrollMode),
            this.#previousScroll,
          );
          this.#previousScroll = next.previous;
          viewer.scrollMode = next.mode;
          return true;
        }
        case "rotate": {
          const rotation = num(() => viewer.pagesRotation);
          if (!live(rotation)) return false;
          viewer.pagesRotation = pdfRotation(rotation, n);
          return true;
        }
        case "outline":
          // Only for the user's Tab in the PDF viewer (V8): the parent sends it for that key.
          this.#readOutline();
          return true;
        case "follow":
          return this.#follow(n);
        case "go": {
          // A mark (decision 11): an XYZ destination on its page, through goToDestination,
          // which records the jump in the history first (decision 9). The array is cloned into
          // the viewer (V3); the promise goToDestination returns is not used (V4).
          const at = msg.at;
          if (!at || !live(pages) || at.page > pages) return false;
          const dest = [at.page - 1, { name: "XYZ" }, at.left, at.top, at.scale];
          this.#settle();
          app.pdfLinkService.goToDestination(Cu.cloneInto(dest, this.#win));
          return true;
        }
        case "presentation":
          // Only for the user's own key (V9): the parent sends it for a key in the PDF viewer.
          // A viewer that claims presentation without being full screen gets nothing to exit.
          if (this.presenting()) {
            if (this.#doc.fullscreenElement) this.#doc.exitFullscreen().catch(() => {});
          } else app.requestPresentationMode();
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
   */
  #readOutline() {
    if (this.#outline) {
      this.#sendOutline(this.#outline.message);
      return;
    }
    if (this.#readingOutline) return;
    this.#readingOutline = true;
    lazy.setTimeout(() => {
      this.#readingOutline = false;
    }, OUTLINE_READ_MS);
    const done = Cu.exportFunction((/** @type {any} */ items) => this.#onOutline(items), this.#win);
    const failed = Cu.exportFunction(() => {
      this.#readingOutline = false;
    }, this.#win);
    if (!this.#then(() => this.#app.pdfDocument.getOutline(), done, failed)) {
      this.#readingOutline = false;
    }
  }

  /**
   * Calls `read` (a pdf.js method that returns a promise) and passes the callbacks to the
   * promise's own `then`, seen through Xrays: a viewer's object with a `then` of its own is a
   * plain object there, whose functions Xrays do not show.
   * @param {() => any} read
   * @param {Function} done  made with Cu.exportFunction
   * @param {Function} failed
   * @returns {boolean} whether the callbacks were passed on
   */
  #then(read, done, failed) {
    try {
      const promise = Cu.unwaiveXrays(read());
      if (typeof promise?.then !== "function") return false;
      promise.then(done, failed);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The outline tree from pdf.js, read through Xrays (V4): only the fields Vimma shows, as
   * primitives, bounded as the parent bounds them (parsePdfOutline), and each entry's target
   * kept here.
   * @param {any} items
   */
  #onOutline(items) {
    const pages = num(() => this.#app.pagesCount);
    /** @type {{ title: string, level: number, page: number, kind: string, collapsed: boolean, url?: string }[]} */
    const entries = [];
    /** @type {any[]} */
    const targets = [];
    /** @type {[number, string][]} entries whose destination is a name, resolved below */
    const named = [];
    let truncated = false;
    // Items visited, not entries kept: a sparse array with a huge length stops here too.
    let visited = 0;
    /** @param {any} list @param {number} level */
    const walk = (list, level) => {
      const length = num(() => list?.length);
      for (let i = 0; i < length; i++) {
        if (entries.length >= OUTLINE_MAX_ENTRIES || ++visited > OUTLINE_MAX_ENTRIES) {
          truncated = true;
          return;
        }
        let item;
        try {
          item = list[i];
        } catch {
          continue;
        }
        if (!item || typeof item !== "object") continue;
        const entry = this.#entry(item, level, pages);
        if (typeof entry.target === "string" && entry.kind === "dest") {
          named.push([entries.length, entry.target]);
        }
        targets.push(entry.target);
        delete entry.target;
        entries.push(entry);
        let children;
        try {
          children = item.items;
        } catch {
          children = null;
        }
        if (num(() => children?.length) > 0) {
          if (level >= OUTLINE_MAX_DEPTH) truncated = true;
          else walk(children, level + 1);
        }
      }
    };
    walk(items, 1);
    const finish = () => {
      this.#readingOutline = false;
      this.#outline = { message: { entries, truncated }, targets };
      this.#sendOutline(this.#outline.message);
    };
    if (!named.length) {
      finish();
      return;
    }
    // Named destinations resolve to pages through the document's table, in one call.
    const resolved = Cu.exportFunction((/** @type {any} */ dests) => {
      for (const [index, name] of named) {
        try {
          const dest = dests && Object.hasOwn(dests, name) ? dests[name] : null;
          /** @type {any} */ (entries[index]).page = this.#pageOf(dest, pages);
        } catch {
          // stays 0: not resolved
        }
      }
      finish();
    }, this.#win);
    const failed = Cu.exportFunction(finish, this.#win);
    if (!this.#then(() => this.#app.pdfDocument.getDestinations(), resolved, failed)) finish();
  }

  /**
   * One outline item, as pdf.js's outline view reads it (`_bindLink`): its kind, by the first of
   * url, action, attachment, layer change and destination it has.
   * @param {any} item  through Xrays
   * @param {number} level
   * @param {number} pages
   */
  #entry(item, level, pages) {
    /** @param {string} key */
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
    /** @type {{ title: string, level: number, page: number, kind: string, collapsed: boolean, url?: string, target?: any }} */
    const entry = {
      title: typeof title === "string" ? title.slice(0, OUTLINE_MAX_TITLE) : "",
      level,
      page: 0,
      kind: "none",
      collapsed: typeof count === "number" && count < 0,
      target: null,
    };
    if (typeof url === "string" && url) {
      // A longer URL is no link Vimma opens (V8): the entry stays, with nothing to follow.
      if (url.length <= OUTLINE_MAX_URL) {
        entry.kind = "url";
        entry.url = url;
      }
    } else if (typeof action === "string" && action) {
      if (OUTLINE_ACTIONS.has(action)) {
        entry.kind = "action";
        entry.target = action;
      }
    } else if (get("attachment") && typeof get("attachment") === "object") {
      entry.kind = "attachment";
    } else if (get("setOCGState") && typeof get("setOCGState") === "object") {
      entry.kind = "ocg";
      entry.target = get("setOCGState");
    } else if (typeof dest === "string" || (dest && typeof dest === "object")) {
      entry.kind = "dest";
      entry.target = dest;
      if (typeof dest !== "string") entry.page = this.#pageOf(dest, pages);
    }
    return entry;
  }

  /**
   * The page an explicit destination points at, as pdf.js resolves its current outline item: a
   * page reference it has seen, or a page index; 0 when it does not resolve.
   * @param {any} dest  through Xrays
   * @param {number} pages
   */
  #pageOf(dest, pages) {
    let page = NaN;
    try {
      const ref = dest?.[0];
      if (typeof ref === "number") page = ref + 1;
      else if (ref && typeof ref === "object") {
        page = num(() => this.#app.pdfDocument.cachedPageNumber(ref));
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
    const kind = /** @type {any} */ (entries?.[index])?.kind;
    if (target === undefined || target === null) return false;
    const link = this.#app.pdfLinkService;
    this.#settle();
    // goToDestination records a history entry first (decision 9).
    if (kind === "dest") link.goToDestination(target);
    else if (kind === "action") link.executeNamedAction(target);
    else if (kind === "ocg") link.executeSetOCGState(target);
    else return false;
    return true;
  }

  /**
   * Brings pdf.js's record of the view up to date before a jump. pdf.js updates it on the
   * animation frame after a scroll, and its history records where a jump starts from that
   * record: a jump a moment after another (`G` then `'a`), or right after the document loaded,
   * would record a stale start or none, and ctrl+o would come back to the wrong place
   * (decision 9).
   */
  #settle() {
    try {
      this.#app.pdfViewer.update();
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
    const viewer = this.#app.pdfViewer;
    let location = null;
    // A mark set right after a key that scrolled is where the view is now.
    this.#settle();
    try {
      location = viewer._location;
    } catch {
      // no position: the parent drops the record
    }
    return {
      page: num(() => location?.pageNumber),
      left: num(() => location?.left),
      top: num(() => location?.top),
      scale: num(() => viewer.currentScale),
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
    if (hash.includes("=")) {
      const page = Number(new URLSearchParams(hash).get("page"));
      return answer(Number.isSafeInteger(page) && page >= 1 && page <= pages ? page : 0);
    }
    /** @type {unknown} */
    let dest = unescape(hash);
    try {
      dest = JSON.parse(/** @type {string} */ (dest));
    } catch {
      // a named destination
    }
    if (Array.isArray(dest)) {
      // pdf.js looks the page reference up in its own cache: a clone it can read (V3).
      return answer(this.#pageOf(Cu.cloneInto(dest, this.#win), pages));
    }
    if (typeof dest !== "string") return answer(0);
    lazy.setTimeout(() => answer(0), LINK_PAGE_MS);
    const resolved = Cu.exportFunction(
      (/** @type {any} */ explicit) => answer(this.#pageOf(explicit, pages)),
      this.#win,
    );
    const failed = Cu.exportFunction(() => answer(0), this.#win);
    const name = /** @type {string} */ (dest);
    if (!this.#then(() => this.#app.pdfDocument.getDestination(name), resolved, failed)) {
      answer(0);
    }
    return undefined;
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
      label: str(() => app.pdfViewer.currentPageLabel).slice(0, PDF_MAX_LABEL + 1),
      find: { current: this.#find.current, total: this.#find.total },
      doc: this.#generation,
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
