/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parent's side of the PDF viewer (docs/specs/pdf-mode.md, "The layers"; docs/security.md
// section 20): which tabs are the viewer, decided from the parent's own view of the top document
// (V2), and the state their adapter reports, parsed before anything shows it (V6).

import { parsePdfOp, parsePdfState } from "../core/pdf.mjs";
import { parsePdfOutline } from "../core/pdfoutline.mjs";
import { PDF_FEATURE_PREF, isPdfJsPrincipal } from "../actors/pdf-view.mjs";

/** @import { PdfState } from "../core/pdf.mjs" */
/** @import { PdfOutline } from "../core/pdfoutline.mjs" */
/** @import { Context } from "../core/modes.mjs" */
/** @import { FindStatus } from "../core/find.mjs" */

/** @type {WeakMap<object, { windowId: number, state: PdfState }>} by <browser> */
const states = new WeakMap();

/** @type {Set<(browser: any) => void>} */
const listeners = new Set();

/**
 * The parsed outline of a tab's document, kept in memory until the tab navigates or closes
 * (decision 10, V11), and the documents asked for theirs (V8).
 * @type {WeakMap<object, { windowId: number, outline: PdfOutline }>}
 */
const outlines = new WeakMap();
/** @type {WeakMap<object, number>} by <browser>: the window global asked for its outline */
const asked = new WeakMap();

/** @type {Set<(browser: any, outline: PdfOutline | null) => void>} */
const outlineListeners = new Set();

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
  a.find.total === b.find.total;

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
    // Another document: the outline read from the last one goes (V11).
    if (outlines.get(browser)?.windowId !== wg.innerWindowId) outlines.delete(browser);
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
    const pages = this.state(browser)?.pages;
    const outline = pages ? parsePdfOutline(data, pages) : null;
    if (outline) outlines.set(browser, { windowId: wg.innerWindowId, outline });
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
  return Object.fromEntries(
    Object.entries(PDF_ACTIONS).map(([id, [op, sign = 1]]) => [
      id,
      (browser, action) => {
        // Zoom steps carry their direction; every other count is a count (0 for none).
        const count = action.count ?? 0;
        const n = op === "zoom" ? sign * (count || 1) : count;
        if (!PdfOps.run(browser, op, n)) notice(browser, NOT_PDF);
      },
    ]),
  );
}
