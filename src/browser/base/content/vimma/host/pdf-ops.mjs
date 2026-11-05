/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parent's side of the PDF viewer (docs/specs/pdf-mode.md, "The layers"; docs/security.md
// section 20): which tabs are the viewer, decided from the parent's own view of the top document
// (V2), and the state their adapter reports, parsed before anything shows it (V6).

import {
  isPdfMarkChar,
  parsePdfOp,
  parsePdfPosition,
  parsePdfState,
  pdfDocumentKey,
} from "../core/pdf.mjs";
import { outlineUrlAllowed, parsePdfOutline } from "../core/pdfoutline.mjs";
import { PDF_FEATURE_PREF, isPdfJsPrincipal } from "../actors/pdf-view.mjs";

const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

/** @import { PdfPosition, PdfState } from "../core/pdf.mjs" */
/** @import { PdfOutline } from "../core/pdfoutline.mjs" */
/** @import { Context } from "../core/modes.mjs" */
/** @import { FindStatus } from "../core/find.mjs" */

/** @type {WeakMap<object, { windowId: number, state: PdfState }>} by <browser> */
const states = new WeakMap();

/** @type {Set<(browser: any) => void>} */
const listeners = new Set();

/**
 * The parsed outline of a tab's document, kept in memory until the tab navigates or closes
 * (decision 10, V11), and the documents asked for theirs (V8). `doc` is the viewer's count of
 * documents it opened when the outline was read.
 * @type {WeakMap<object, { windowId: number, doc: number, outline: PdfOutline }>}
 */
const outlines = new WeakMap();
/** @type {WeakMap<object, number>} by <browser>: the window global asked for its outline */
const asked = new WeakMap();

/** @type {Set<(browser: any, outline: PdfOutline | null) => void>} */
const outlineListeners = new Set();

/**
 * Marks (decision 11, V11): by document (pdfDocumentKey), then by character, in memory only.
 * A private window's marks are kept apart and go when the last private window closes.
 * @type {{ normal: Map<string, Map<string, PdfPosition>>, private: Map<string, Map<string, PdfPosition>> }}
 */
const marks = { normal: new Map(), private: new Map() };
/** Documents with marks kept at most; the one marked longest ago goes first. */
const MAX_MARKED_DOCUMENTS = 1000;
Services.obs.addObserver(() => marks.private.clear(), "last-pb-context-exited");

/**
 * The marks of `browser`'s kind of window.
 * @param {any} browser
 */
const marksFor = (browser) => {
  const win = browser?.ownerDocument?.defaultView;
  return win && PrivateBrowsingUtils.isWindowPrivate(win) ? marks.private : marks.normal;
};

/**
 * The top document's window global when it is the pdf.js viewer, from the parent's view.
 * @param {any} browser  a tab's <browser>
 */
function viewerGlobal(browser) {
  const wg = browser?.browsingContext?.currentWindowGlobal;
  if (!wg || wg.isInitialDocument || !isPdfJsPrincipal(wg.documentPrincipal)) return null;
  // The viewer keeps the PDF's own URL (PdfStreamConverter sets channel.originalURI). A document
  // that only inherits pdf.js's principal (an about:blank, blob: or data: page the viewer opens)
  // is not the viewer.
  const scheme = wg.documentURI?.scheme ?? "";
  return ["http", "https", "file"].includes(scheme) ? wg : null;
}

/** @param {PdfState} a @param {PdfState} b */
const sameState = (a, b) =>
  a.page === b.page &&
  a.pages === b.pages &&
  a.label === b.label &&
  a.find.current === b.find.current &&
  a.find.total === b.find.total &&
  a.doc === b.doc;

export const PdfOps = {
  /** Whether the PDF mode is on (CONTRIBUTING.md, "Unfinished features"). */
  enabled() {
    return Services.prefs.getBoolPref(PDF_FEATURE_PREF, false);
  },

  /**
   * The keymap context for `browser`: `pdf` while its top document is the pdf.js viewer
   * (ADR-024). Never from a report of the child, and never for a viewer in a frame (V2).
   * @param {any} browser
   * @returns {Context}
   */
  context(browser) {
    return this.enabled() && viewerGlobal(browser) ? "pdf" : "page";
  },

  /**
   * The viewer's last state for `browser`'s current document, or null.
   * @param {any} browser
   * @returns {PdfState | null}
   */
  state(browser) {
    if (!this.enabled()) return null;
    const wg = viewerGlobal(browser);
    const entry = wg && states.get(browser);
    return entry && entry.windowId === wg.innerWindowId ? entry.state : null;
  },

  /**
   * A state message from a VimmaParent. Taken only from the actor of the top document's current
   * window global, when that document is the viewer (V2); a record out of bounds clears the
   * state (V6).
   * @param {any} actor  the VimmaParent
   * @param {unknown} data
   */
  onState(actor, data) {
    if (!this.enabled()) return;
    const bc = actor.browsingContext;
    if (!bc || bc.parent) return;
    const browser = bc.embedderElement;
    const wg = viewerGlobal(browser);
    if (!wg || wg !== actor.manager) return;
    const state = parsePdfState(data);
    const old = states.get(browser);
    // Another document, or another PDF pdf.js opened in the same viewer: the outline read from
    // the last one goes (V11).
    const read = outlines.get(browser);
    if (read && (read.windowId !== wg.innerWindowId || read.doc !== state?.doc)) {
      outlines.delete(browser);
    }
    // Nothing changed: no redraw, so a flood of equal messages costs the parent little.
    if (state && old && old.windowId === wg.innerWindowId && sameState(old.state, state)) return;
    if (!state && !old) return;
    if (state) states.set(browser, { windowId: wg.innerWindowId, state });
    else states.delete(browser);
    for (const fn of listeners) {
      try {
        fn(browser);
      } catch (e) {
        console.error("vimma: pdf state listener failed", e);
      }
    }
  },

  /**
   * Sends the viewer in `browser` one operation (V7): a name and a number, to the actor of the
   * top document only when the parent itself sees the pdf.js viewer there (V2).
   * @param {any} browser
   * @param {string} op  one of PDF_OPS
   * @param {number} [n]
   * @returns {boolean} false when `browser` does not show the PDF viewer
   */
  run(browser, op, n = 0) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const msg = parsePdfOp({ op, n });
    if (!wg || !msg) return false;
    try {
      wg.getActor("Vimma").sendAsyncMessage("Vimma:PdfOp", msg);
      return true;
    } catch {
      // the document is going away
      return false;
    }
  },

  /**
   * The session history index one step from the current entry when that entry is another jump
   * inside the PDF the tab shows (decision 9), or null. pdf.js records its jumps with pushState
   * while Vimma takes the keys in chrome, so the entries carry no user interaction, and goBack /
   * goForward would skip them all (browser.navigation.requireUserInteraction).
   * @param {any} browser
   * @param {number} delta  -1 back, 1 forward; any other step is not a jump
   * @returns {number | null}
   */
  jumpIndex(browser, delta) {
    if (Math.abs(delta) !== 1 || this.context(browser) !== "pdf") return null;
    const history = browser.browsingContext?.sessionHistory;
    if (!history) return null;
    const next = history.index + delta;
    if (next < 0 || next >= history.count) return null;
    try {
      const here = history.getEntryAtIndex(history.index);
      return here.sharesDocumentWith(history.getEntryAtIndex(next)) ? next : null;
    } catch {
      return null;
    }
  },

  /**
   * `m{c}` (decision 11): asks the viewer where its view is and keeps that as mark `c` of the
   * document, in memory only (V11).
   * @param {any} browser
   * @param {string} c  a letter or digit
   * @returns {Promise<boolean>} false when nothing was kept
   */
  async setMark(browser, c) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const key = wg && pdfDocumentKey(wg.documentURI.spec);
    if (!wg || !key || !isPdfMarkChar(c)) return false;
    /** @type {unknown} */
    let raw;
    try {
      raw = await wg.getActor("Vimma").sendQuery("Vimma:PdfWhere");
    } catch {
      return false; // the document went away
    }
    // From the content process: kept only as four bounded numbers (V6, V7).
    const at = parsePdfPosition(raw);
    if (!at || viewerGlobal(browser) !== wg) return false;
    const all = marksFor(browser);
    const mine = all.get(key) ?? new Map();
    // The document marked last goes to the end, so the oldest is dropped first.
    all.delete(key);
    all.set(key, mine.set(c, at));
    if (all.size > MAX_MARKED_DOCUMENTS) all.delete(all.keys().next().value ?? "");
    return true;
  },

  /**
   * `'{c}` (decision 11): sends the viewer mark `c` of its document as an `XYZ` destination,
   * which pdf.js records as a jump (decision 9).
   * @param {any} browser
   * @param {string} c
   * @returns {"went" | "none" | "not-pdf"}
   */
  goToMark(browser, c) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const key = wg && pdfDocumentKey(wg.documentURI.spec);
    if (!wg || !key) return "not-pdf";
    const all = marksFor(browser);
    const mine = all.get(key);
    const at = mine?.get(c);
    const msg = at && parsePdfOp({ op: "go", n: 0, at });
    if (!msg || !mine) return "none";
    // A document read now is the last one dropped.
    all.delete(key);
    all.set(key, mine);
    try {
      wg.getActor("Vimma").sendAsyncMessage("Vimma:PdfOp", msg);
    } catch {
      // the document is going away
    }
    return "went";
  },

  /**
   * The page an internal link of the PDF goes to, for `F` (decision 16): asked of the viewer
   * that labelled it, by the hint's own generation and index, never by its URL (V7); 0 when
   * `target` is not a link of `browser`'s viewer or does not resolve.
   * @param {any} browser
   * @param {{ gen: number, id: number, bc: any, wg: any }} target  a hint target
   * @returns {Promise<number>}
   */
  async linkPage(browser, target) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const pages = this.state(browser)?.pages ?? 0;
    if (!wg || target.wg !== wg || target.bc !== browser.browsingContext) return 0;
    /** @type {unknown} */
    let page;
    try {
      page = await wg
        .getActor("Vimma")
        .sendQuery("Vimma:PdfLinkPage", { gen: target.gen, id: target.id });
    } catch {
      return 0;
    }
    return Number.isSafeInteger(page) && Number(page) >= 1 && Number(page) <= pages
      ? Number(page)
      : 0;
  },

  /**
   * @param {(browser: any) => void} fn  called after a tab's PDF state changes
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * The outline of `browser`'s current document, once read, or null. An outline of a document
   * the tab has left is dropped here (V11).
   * @param {any} browser
   * @returns {PdfOutline | null}
   */
  outline(browser) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const entry = outlines.get(browser);
    if (entry && entry.windowId === wg?.innerWindowId) return entry.outline;
    outlines.delete(browser);
    return null;
  },

  /**
   * Drops `browser`'s outline and any outline asked for: its tab left the document (V11).
   * @param {any} browser
   */
  forget(browser) {
    outlines.delete(browser);
    asked.delete(browser);
  },

  /**
   * Opens an outline entry's URL in `browser` as the viewer's own link would load it
   * (docs/security.md section 20, V8): http and https only, checked against the viewer's
   * principal, which triggers the load, with no referrer and no fixup. A load with the system
   * principal would look typed (no Sec-Fetch-Site, SameSite=Strict cookies sent) and could be
   * routed to another workspace.
   * @param {any} browser
   * @param {string} url
   * @returns {boolean} false when refused
   */
  openUrl(browser, url) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    const parsed = outlineUrlAllowed(url) ? URL.parse(url) : null;
    if (!wg || !parsed) return false;
    const principal = wg.documentPrincipal;
    try {
      Services.scriptSecurityManager.checkLoadURIWithPrincipal(
        principal,
        parsed.URI,
        Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL,
      );
    } catch {
      return false;
    }
    const referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
    referrerInfo.init(Ci.nsIReferrerInfo.NO_REFERRER, false, wg.documentURI);
    browser.loadURI(parsed.URI, { triggeringPrincipal: principal, referrerInfo });
    return true;
  },

  /**
   * Asks the viewer in `browser` for its outline, on the user's key (V8); the answer comes to
   * the outline listeners. An outline already read is not asked for again.
   * @param {any} browser
   * @returns {boolean} false when `browser` does not show the PDF viewer
   */
  askOutline(browser) {
    const wg = this.enabled() ? viewerGlobal(browser) : null;
    if (!wg) return false;
    asked.set(browser, wg.innerWindowId);
    return this.run(browser, "outline");
  },

  /**
   * An outline message from a VimmaParent: taken only from the actor of the top viewer's
   * current document, and only after the parent asked that document for it (V8). It is parsed
   * against the page count the parent holds; an outline outside its bounds is dropped whole,
   * and the listeners hear null.
   * @param {any} actor  the VimmaParent
   * @param {unknown} data
   */
  onOutline(actor, data) {
    if (!this.enabled()) return;
    const bc = actor.browsingContext;
    if (!bc || bc.parent) return;
    const browser = bc.embedderElement;
    const wg = viewerGlobal(browser);
    if (!wg || wg !== actor.manager || asked.get(browser) !== wg.innerWindowId) return;
    asked.delete(browser);
    const state = this.state(browser);
    const outline = state ? parsePdfOutline(data, state.pages) : null;
    if (outline && state)
      outlines.set(browser, { windowId: wg.innerWindowId, doc: state.doc, outline });
    for (const fn of outlineListeners) {
      try {
        fn(browser, outline);
      } catch (e) {
        console.error("vimma: pdf outline listener failed", e);
      }
    }
  },

  /**
   * @param {(browser: any, outline: PdfOutline | null) => void} fn  called with an outline asked
   *   for on the user's key, or null when it was malformed
   * @returns {() => void} unsubscribe
   */
  subscribeOutline(fn) {
    outlineListeners.add(fn);
    return () => outlineListeners.delete(fn);
  },
};

/**
 * The find status with pdf.js's own match count, which it gives only to the find bar
 * (decision 13): capped at the limit Firefox uses for pages.
 * @param {FindStatus | null} find
 * @param {PdfState | null} pdf
 * @returns {FindStatus | null}
 */
export function pdfFindStatus(find, pdf) {
  if (!find || !pdf?.find.total) return find;
  const limit = Services.prefs.getIntPref("accessibility.typeaheadfind.matchesCountLimit", 1000);
  const { current, total } = pdf.find;
  return limit > 0 && total > limit
    ? { ...find, notFound: false, current: 0, total: -1, limit }
    : { ...find, notFound: false, current, total, limit };
}

/** What a PDF key says outside the PDF viewer (`:12` on a web page). */
export const NOT_PDF = "only in the PDF viewer";

/**
 * The PDF viewer's actions (docs/specs/pdf-mode.md delivery PR 3): each sends one operation
 * with the key's count, which the adapter applies to pdf.js's live values.
 * @type {Readonly<Record<string, [op: string, sign?: number]>>}
 */
const PDF_ACTIONS = Object.freeze({
  "pdf.next_page": ["next"],
  "pdf.previous_page": ["prev"],
  "pdf.first_page": ["first"],
  "pdf.last_page": ["last"],
  "pdf.page_top": ["page_top"],
  "pdf.page_bottom": ["page_bottom"],
  "pdf.screen_down": ["screen"],
  "pdf.zoom_in": ["zoom"],
  "pdf.zoom_out": ["zoom", -1],
  "pdf.zoom_set": ["scale"],
  "pdf.fit_page": ["fit_page"],
  "pdf.fit_width": ["fit_width"],
  "pdf.dual_page": ["dual"],
  "pdf.first_page_alone": ["first_alone"],
  "pdf.single_page": ["single"],
  "pdf.rotate": ["rotate"],
  "pdf.presentation": ["presentation"],
});

/** The action ids that exist only while the PDF mode is on (the command line hides the rest). */
export const PDF_ACTION_IDS = Object.freeze([
  ...Object.keys(PDF_ACTIONS),
  "pdf.outline",
  "pdf.mark_set",
  "pdf.mark_go",
  ...[
    "down",
    "up",
    "expand",
    "collapse",
    "expand_subtree",
    "collapse_subtree",
    "expand_all",
    "collapse_all",
    "first",
    "last",
    "half_down",
    "half_up",
    "follow",
    "close",
    "filter",
  ].map((op) => `index.${op}`),
]);

/**
 * The host's runners for the PDF viewer's actions.
 * @param {(browser: any, text: string) => void} notice
 * @returns {Record<string, (browser: any, action: { count?: number }) => void>}
 */
export function pdfRunners(notice) {
  return {
    ...Object.fromEntries(
      Object.entries(PDF_ACTIONS).map(([id, [op, sign = 1]]) => [
        id,
        (/** @type {any} */ browser, /** @type {{ count?: number }} */ action) => {
          // Zoom steps carry their direction; every other count is a count (0 for none).
          const count = action.count ?? 0;
          const n = op === "zoom" ? sign * (count || 1) : count;
          if (!PdfOps.run(browser, op, n)) notice(browser, NOT_PDF);
        },
      ]),
    ),
    // Marks (decision 11): a letter or digit; any other key after m or ' does nothing.
    "pdf.mark_set": (browser, action) => {
      const c = /** @type {{ char?: string }} */ (action).char ?? "";
      if (PdfOps.context(browser) !== "pdf") notice(browser, NOT_PDF);
      else if (isPdfMarkChar(c)) PdfOps.setMark(browser, c);
    },
    "pdf.mark_go": (browser, action) => {
      const c = /** @type {{ char?: string }} */ (action).char ?? "";
      if (!isPdfMarkChar(c)) return;
      const went = PdfOps.goToMark(browser, c);
      if (went === "not-pdf") notice(browser, NOT_PDF);
      else if (went === "none") notice(browser, `no mark '${c}'`);
    },
  };
}
