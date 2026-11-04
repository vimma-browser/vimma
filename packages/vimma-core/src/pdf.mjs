/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The PDF viewer's state as Vimma's content actor reports it (docs/specs/pdf-mode.md), checked
 * before the host believes it: the viewer parses untrusted files, and a pdf.js bug can let a
 * PDF run script there (docs/security.md section 20, V6).
 */

/** pdf.js shows at most this many pages in practice; more is not a real document. */
export const PDF_MAX_PAGES = 100000;
/** A page label longer than this is dropped with its record (V6). */
export const PDF_MAX_LABEL = 32;
/** Find match counts above this are not a real count. */
const MAX_MATCHES = 10_000_000;

/**
 * @typedef {object} PdfState
 * @property {number} page      the current page, 1-based
 * @property {number} pages     the page count
 * @property {string} label     the current page's label, "" when it has none
 * @property {{ current: number, total: number }} find  the find controller's count, 0/0 for none
 */

/**
 * Control (Cc) and format (Cf) characters: bidi overrides and isolates, zero-width marks; and
 * separators other than a plain space (line and paragraph separators, wide spaces), which
 * could break or stretch the status bar.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]|(?! )\p{Z}/gu;

/**
 * Text from a PDF made safe to show: no control or format characters (V6, V8).
 * @param {string} text
 */
export function stripInvisible(text) {
  return text.replace(INVISIBLE, "");
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @returns {v is number}
 */
const intIn = (v, min, max) =>
  Number.isSafeInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max;

/**
 * The state record from the content actor, or null when any field is missing or out of bounds.
 * @param {unknown} raw
 * @returns {PdfState | null}
 */
export function parsePdfState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const { pages, page, label } = r;
  if (!intIn(pages, 1, PDF_MAX_PAGES) || !intIn(page, 1, pages)) return null;
  if (typeof label !== "string" || label.length > PDF_MAX_LABEL) return null;
  const find = r.find;
  if (!find || typeof find !== "object") return null;
  const { current, total } = /** @type {Record<string, unknown>} */ (find);
  if (!intIn(total, 0, MAX_MATCHES) || !intIn(current, 0, total)) return null;
  return Object.freeze({
    page,
    pages,
    label: stripInvisible(label).trim(),
    find: Object.freeze({ current, total }),
  });
}

/**
 * The status bar's page segment: `page 3/12`, or `page iv (4/120)` when the page's label is not
 * its number.
 * @param {PdfState} s
 */
export function pdfPageText({ page, pages, label }) {
  return label && label !== String(page)
    ? `page ${label} (${page}/${pages})`
    : `page ${page}/${pages}`;
}
