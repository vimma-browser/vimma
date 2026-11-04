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

// Delivery PR 3: zathura's page, zoom and layout keys (docs/specs/pdf-mode.md decisions 6 to 8).
// The adapter applies these to pdf.js's live values, so a burst of keys never works from a
// state report that is up to 100 ms old.

/** pdf.js's zoom step and limits (viewer.mjs DEFAULT_SCALE_DELTA, MIN_SCALE, MAX_SCALE). */
export const PDF_ZOOM_STEP = 1.1;
export const PDF_ZOOM_MIN = 0.1;
export const PDF_ZOOM_MAX = 25;

/** pdf.js's SpreadMode and ScrollMode values (viewer.mjs). */
export const PDF_SPREAD = Object.freeze({ NONE: 0, ODD: 1, EVEN: 2 });
export const PDF_SCROLL = Object.freeze({ VERTICAL: 0, HORIZONTAL: 1, WRAPPED: 2, PAGE: 3 });

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The page a page key goes to. A count is a physical page for `G` / `gg` (`12G`) and a number of
 * pages for `J` / `K`; 0 is no count. A page past the end is the last page, as Vim's `G` is.
 * @param {"next" | "prev" | "first" | "last"} op
 * @param {number} count
 * @param {number} page   the current page, 1-based
 * @param {number} pages  the page count
 */
export function pdfPageTarget(op, count, page, pages) {
  const n = Math.max(0, count);
  switch (op) {
    case "next":
      return clamp(page + (n || 1), 1, pages);
    case "prev":
      return clamp(page - (n || 1), 1, pages);
    case "first":
      return clamp(n || 1, 1, pages);
    default:
      return clamp(n || pages, 1, pages);
  }
}

/**
 * The scale after `steps` zoom steps (negative zooms out), rounded as pdf.js's own zoom buttons
 * round (PDFViewer.updateScale), so that `+` then `-` comes back to the same scale.
 * @param {number} scale
 * @param {number} steps
 */
export function pdfZoomStep(scale, steps) {
  const delta = steps > 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP;
  const round = steps > 0 ? Math.ceil : Math.floor;
  let s = scale;
  for (let i = 0; i < Math.min(Math.abs(steps), 100); i++) {
    s = round(Number((s * delta).toFixed(2)) * 10) / 10;
  }
  return clamp(s, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
}

/**
 * The scale `{n}=` sets: n percent, or 100 % without a count.
 * @param {number} count
 */
export function pdfZoomPercent(count) {
  return clamp(count > 0 ? count / 100 : 1, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
}

/**
 * Dual page (decision 8). `dual` (`d`) toggles one page and the last spread; `first_alone` (`D`)
 * swaps the spread that puts the first page alone (`EVEN`, zathura's first-page-column "1:2")
 * and the one that pairs it with the second (`ODD`), and shows two pages, so the change is seen.
 * @param {"dual" | "first_alone"} op
 * @param {number} mode  pdf.js's spreadMode now
 * @param {number} last  the spread `d` returns to
 * @returns {{ mode: number, last: number }}
 */
export function pdfSpread(op, mode, last) {
  const { NONE, ODD, EVEN } = PDF_SPREAD;
  const two = mode === ODD || mode === EVEN ? mode : NONE;
  const back = last === ODD ? ODD : EVEN;
  if (op === "dual") return two === NONE ? { mode: back, last: back } : { mode: NONE, last: two };
  const other = (two === NONE ? back : two) === EVEN ? ODD : EVEN;
  return { mode: other, last: other };
}

/**
 * `w`: one page at a time (pdf.js's `PAGE` scroll mode), or back to the mode before it.
 * @param {number} mode      pdf.js's scrollMode now
 * @param {number} previous  the mode `w` returns to
 * @returns {{ mode: number, previous: number }}
 */
export function pdfScrollMode(mode, previous) {
  const { VERTICAL, PAGE } = PDF_SCROLL;
  if (mode !== PAGE) return { mode: PAGE, previous: mode };
  const known = /** @type {number[]} */ (Object.values(PDF_SCROLL)).includes(previous);
  return { mode: known && previous !== PAGE ? previous : VERTICAL, previous: PAGE };
}

/**
 * `r`: the rotation after turning the pages 90 degrees clockwise `count` times (0 is once).
 * @param {number} rotation
 * @param {number} count
 */
export function pdfRotation(rotation, count) {
  return (((rotation + 90 * (count > 0 ? count : 1)) % 360) + 360) % 360;
}

/**
 * The operations the parent may ask of the adapter (V7): a name from this list and one integer.
 * `n` is a count (0 for none), a number of steps (negative zooms out) or a percent.
 */
export const PDF_OPS = Object.freeze([
  "next",
  "prev",
  "first",
  "last",
  "page_top",
  "page_bottom",
  "screen",
  "zoom",
  "scale",
  "fit_page",
  "fit_width",
  "dual",
  "first_alone",
  "single",
  "rotate",
  "presentation",
  "jump",
  // Delivery PR 4 (decision 10): read the outline, and follow an entry by its index.
  "outline",
  "follow",
]);
const OPS = new Set(PDF_OPS);

/** Larger than any count, page number or percent a key sends. */
const MAX_OP_N = PDF_MAX_PAGES * 10;

/**
 * An operation message, or null unless it is exactly `{ op, n }` with a known name and a bounded
 * integer (V7). The adapter checks every message with it before touching pdf.js.
 * @param {unknown} raw
 * @returns {{ op: string, n: number } | null}
 */
export function parsePdfOp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes("op") || !keys.includes("n")) return null;
  const { op, n } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof op !== "string" || !OPS.has(op)) return null;
  if (!intIn(n, -MAX_OP_N, MAX_OP_N)) return null;
  return { op, n };
}
