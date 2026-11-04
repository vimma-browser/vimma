/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parent's side of the PDF viewer (docs/specs/pdf-mode.md, "The layers"; docs/security.md
// section 20): which tabs are the viewer, decided from the parent's own view of the top document
// (V2), and the state their adapter reports, parsed before anything shows it (V6).

import { parsePdfState } from "../core/pdf.mjs";
import { PDF_FEATURE_PREF, isPdfJsPrincipal } from "../actors/pdf-view.mjs";

/** @import { PdfState } from "../core/pdf.mjs" */
/** @import { Context } from "../core/modes.mjs" */
/** @import { FindStatus } from "../core/find.mjs" */

/** @type {WeakMap<object, { windowId: number, state: PdfState }>} by <browser> */
const states = new WeakMap();

/** @type {Set<(browser: any) => void>} */
const listeners = new Set();

/**
 * The top document's window global when it is the pdf.js viewer, from the parent's view.
 * @param {any} browser  a tab's <browser>
 */
function viewerGlobal(browser) {
  const wg = browser?.browsingContext?.currentWindowGlobal;
  return wg && isPdfJsPrincipal(wg.documentPrincipal) ? wg : null;
}

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
   * @param {(browser: any) => void} fn  called after a tab's PDF state changes
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
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
