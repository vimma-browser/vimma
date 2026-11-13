/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The PDF viewer's outline in the side panel's slot (docs/specs/pdf-mode.md decisions 10 and
// 19): Tab asks the viewer for it (pdf-ops.mjs) and shows it, or shows it beside the document by
// itself; Enter on an entry follows it. VimmaHost (focus, tab and outline changes) and runners.mjs
// (Tab, `pdf.outline`) call these with the window's state.

import { BLOCKED_URL_TEXT } from "./tab-ops.mjs";
import { NOT_PDF, PdfOps } from "./pdf-ops.mjs";

/** @import { Mode } from "../core/modes.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */

/**
 * What the outline needs from the host, which imports this module.
 * @typedef {object} OutlineHost
 * @property {(s: WindowState) => Mode} mode  the window's mode
 * @property {(s: WindowState) => any} selectedBrowser  the selected tab's <browser>
 * @property {(s: WindowState) => boolean} surfaceOpen  one of Vimma's own surfaces holds the keys
 */

/**
 * How long Tab waits for the viewer's outline. A reply after it, or after another key, opens
 * nothing: a slow or hostile viewer cannot open the panel under keys meant for something else.
 */
export const OUTLINE_WAIT_MS = 2000;

/**
 * Forgets the outline Tab asked for.
 * @param {WindowState} s
 */
export function dropOutlineAsk(s) {
  if (!s.outlineFor) return;
  s.win.clearTimeout(s.outlineFor.timer);
  s.outlineFor = null;
}

/** What Tab says in a PDF without an outline (docs/specs/pdf-mode.md Behaviour 5). */
export const NO_OUTLINE = "no outline in this PDF";
/** What following an attachment entry says (decisions 10 and 18: pdf.js's sidebar is hidden). */
export const OUTLINE_ATTACHMENT = "the PDF viewer does not open attachments";

/** `[ui] pdf_outline = "hidden"` (docs/specs/pdf-mode.md decision 19), applied by ConfigHost. */
export const PDF_OUTLINE_PREF = "vimma.ui.pdf_outline.hidden";
/**
 * Per tab, the document (PdfOps.documentKey) whose outline the host asked for to show beside it,
 * and the one whose outline the user closed: it stays hidden until the tab shows another.
 * @type {WeakMap<object, string>}
 */
const outlineAsked = new WeakMap();
/** @type {WeakMap<object, string>} */
const outlineHidden = new WeakMap();

/**
 * Shows the selected tab's PDF outline beside the document, without the keys (decision 19):
 * when `[ui] pdf_outline` is "shown", the user has not closed it for this document, the window is
 * in normal mode and no other panel or Vimma surface is open. The outline is asked for once per
 * document (V8); its answer comes back here through the outline subscription. Called again when
 * focus moves, so a PDF opened from the address bar shows it once focus reaches the page.
 * @param {WindowState} s
 * @param {OutlineHost} host
 */
export function showOutlineBeside(s, host) {
  if (Services.prefs.getBoolPref(PDF_OUTLINE_PREF, false)) return;
  const browser = s.win.gBrowser?.selectedBrowser;
  const key = browser && PdfOps.documentKey(browser);
  if (!key || s.outline.isOpen || outlineHidden.get(browser) === key) return;
  if (host.surfaceOpen(s) || s.agentChat.isOpen) return;
  if (host.mode(s) !== "normal") return;
  const outline = PdfOps.outline(browser);
  if (outline) {
    if (outline.entries.length) {
      s.outline.open(browser, outline, PdfOps.state(browser)?.page ?? 1, false);
    }
    return;
  }
  if (outlineAsked.get(browser) === key) return;
  outlineAsked.set(browser, key);
  PdfOps.askOutline(browser);
}

/**
 * Tab in the PDF viewer: the outline read once per document (V8), then shown at once; the
 * other panels in the slot close (one at a time).
 * @param {WindowState} s
 * @param {OutlineHost} host
 */
export function openOutline(s, host) {
  s.notice.hide();
  if (s.outline.isActive) {
    s.outline.hide();
    return;
  }
  const browser = host.selectedBrowser(s);
  if (s.outline.isOpen && s.outline.browser === browser) {
    // Shown beside the document (decision 19): Tab gives it the keys.
    s.outline.focus();
    return;
  }
  const outline = PdfOps.outline(browser);
  if (outline) {
    showOutline(s, browser, outline);
    return;
  }
  dropOutlineAsk(s);
  if (!PdfOps.askOutline(browser)) {
    s.notice.show(NOT_PDF);
    return;
  }
  s.outlineFor = { browser, timer: s.win.setTimeout(() => dropOutlineAsk(s), OUTLINE_WAIT_MS) };
}

/**
 * @param {WindowState} s
 * @param {any} browser
 * @param {import("../core/pdfoutline.mjs").PdfOutline | null} outline  null: malformed
 */
export function showOutline(s, browser, outline) {
  dropOutlineAsk(s);
  if (!outline?.entries.length) {
    s.notice.show(NO_OUTLINE);
    return;
  }
  s.panel.close();
  s.bookmarks.close();
  s.agentChat.close();
  s.outline.open(browser, outline, PdfOps.state(browser)?.page ?? 1);
}

/**
 * Enter on an outline entry (decision 10): the viewer follows a destination, a named action or
 * a layer change by the entry's index (V7); Vimma opens a URL entry under section 4 (http and
 * https only); an attachment is pdf.js's to open.
 * @param {WindowState} s
 * @param {any} browser
 * @param {number} index
 */
export function followOutline(s, browser, index) {
  const entry = PdfOps.outline(browser)?.entries[index];
  if (!entry) return;
  if (entry.kind === "url") {
    if (!PdfOps.openUrl(browser, entry.url ?? "")) s.notice.show(BLOCKED_URL_TEXT, { error: true });
  } else if (entry.kind === "attachment") s.notice.show(OUTLINE_ATTACHMENT);
  else if (entry.kind !== "none") PdfOps.run(browser, "follow", index);
}

/**
 * The user closed the outline of `browser`'s document: it stays hidden until the tab shows
 * another (decision 19).
 * @param {any} browser
 */
export function outlineClosed(browser) {
  const key = PdfOps.documentKey(browser);
  if (key) outlineHidden.set(browser, key);
}
