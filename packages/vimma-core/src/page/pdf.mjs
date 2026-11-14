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
 * @property {number} doc       which document the viewer shows: pdf.js can open another PDF in
 *   the same viewer, with no navigation, and what the parent read from the last one goes (V11)
 * @property {boolean} drawn    pdf.js had finished drawing every page in view (`state.pdf`);
 *   false when the report's drawing fields are missing or out of bounds
 * @property {number} ops       how many operations the viewer's actor had received from Vimma
 * @property {number} width     the viewer's size then, in whole device pixels, so a report
 * @property {number} height    from before a resize is not taken for one after it
 * @property {number} zoom      the tab's full zoom then, as the viewer's browsing context had it,
 *   so a report from before a full-zoom change is not taken for one after it (#1040); 0 when
 *   unusable
 */

/** Larger than any screen, in device pixels. */
const MAX_SIZE = 100000;

/**
 * Bounds of a full zoom: Firefox keeps it within zoom.minPercent and zoom.maxPercent (30% and
 * 500% by default); these leave room for changed prefs and nothing more.
 */
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 100;

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
  if (!intIn(r.doc, 0, Number.MAX_SAFE_INTEGER)) return null;
  return Object.freeze({
    page,
    pages,
    label: stripInvisible(label).trim(),
    find: Object.freeze({ current, total }),
    doc: r.doc,
    ...drawing(r),
  });
}

/**
 * Whether `zoom` can be a full zoom: a finite number from MIN_ZOOM to MAX_ZOOM.
 * @param {unknown} zoom
 * @returns {zoom is number}
 */
const isZoom = (zoom) =>
  typeof zoom === "number" && Number.isFinite(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM;

/**
 * The report's drawing fields, which only `state.pdf` reads (#1006): all five in bounds, else a
 * report that is not drawn. They never cost the record itself, so a size, count or zoom the
 * viewer reports oddly cannot take away the page state PDF mode runs on.
 * @param {Record<string, unknown>} r
 * @returns {{ drawn: boolean, ops: number, width: number, height: number, zoom: number }}
 */
function drawing({ drawn, ops, width, height, zoom }) {
  if (
    typeof drawn !== "boolean" ||
    !intIn(ops, 0, Number.MAX_SAFE_INTEGER) ||
    !intIn(width, 0, MAX_SIZE) ||
    !intIn(height, 0, MAX_SIZE) ||
    !isZoom(zoom)
  ) {
    return { drawn: false, ops: 0, width: 0, height: 0, zoom: 0 };
  }
  return { drawn, ops, width, height, zoom };
}

/**
 * Whether the viewer has drawn every page in view as the tab shows it now (`state.pdf`, #1006):
 * its last report says so, came after every operation Vimma sent it, and was made at the size
 * and the full zoom the tab has now; a report from before a resize (the outline opening beside
 * the document) or a zoom change says nothing of the pages drawn after it. Sizes are in device
 * pixels, the one unit both sides share at any desktop scale and full zoom (the viewer's CSS
 * pixels follow the zoom, snapped by the engine); each side rounds its own, so a pixel apart is
 * the same size. A zoom change leaves that size as it was, so the zoom is compared too, and
 * exactly (#1040): both sides read the same synced BrowsingContext.fullZoom, a float, so the
 * same zoom is the same number on both sides at any desktop scale and zoom level.
 * @param {PdfState | null} state  the last report
 * @param {{ sent: number, width: number, height: number, zoom: number }} now  the operations
 *   sent to the viewer's document, its tab's size in whole device pixels and its tab's full zoom
 */
export function pdfDrawn(state, { sent, width, height, zoom }) {
  if (!state?.drawn || state.ops < sent) return false;
  if (!isZoom(zoom) || state.zoom !== zoom) return false;
  return Math.abs(state.width - width) <= 1 && Math.abs(state.height - height) <= 1;
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
  // Delivery PR 5 (decision 11): go to a mark's position, sent as `at` (parsePdfPosition).
  "go",
]);
const OPS = new Set(PDF_OPS);

/** Larger than any count, page number or percent a key sends. */
const MAX_OP_N = PDF_MAX_PAGES * 10;

/**
 * An operation message, or null unless it is exactly `{ op, n }` with a known name and a bounded
 * integer, or `{ op: "go", n, at }` with a position (V7). The adapter checks every message with
 * it before touching pdf.js.
 * @param {unknown} raw
 * @returns {{ op: string, n: number, at?: PdfPosition } | null}
 */
export function parsePdfOp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const keys = Object.keys(raw);
  const { op, n, at } = /** @type {Record<string, unknown>} */ (raw);
  // `go` alone carries a position: four more numbers, never anything else (V7).
  const want = op === "go" ? 3 : 2;
  if (keys.length !== want || !keys.includes("op") || !keys.includes("n")) return null;
  if (typeof op !== "string" || !OPS.has(op)) return null;
  if (!intIn(n, -MAX_OP_N, MAX_OP_N)) return null;
  if (op !== "go") return { op, n };
  const position = parsePdfPosition(at);
  return position && { op, n, at: position };
}

// Delivery PR 5: marks (decision 11).

/**
 * A place in a document as pdf.js's view reports it: the page, the point of the page at the
 * view's top left in PDF units, and the scale (1 is 100 %).
 * @typedef {{ page: number, left: number, top: number, scale: number }} PdfPosition
 */

/** PDF units past this are on no page: a page is at most 14,400 units a side (ISO 32000). */
const MAX_PDF_UNITS = 1e6;

/** @param {unknown} v @returns {v is number} */
const finiteIn = (v, /** @type {number} */ lo, /** @type {number} */ hi) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * A position from the viewer (where a mark is set) or for it (going back to one), or null
 * unless it is exactly the four bounded numbers.
 * @param {unknown} raw
 * @returns {PdfPosition | null}
 */
export function parsePdfPosition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const keys = Object.keys(raw);
  if (keys.length !== 4) return null;
  const { page, left, top, scale } = /** @type {Record<string, unknown>} */ (raw);
  if (!intIn(page, 1, PDF_MAX_PAGES)) return null;
  if (!finiteIn(left, -MAX_PDF_UNITS, MAX_PDF_UNITS)) return null;
  if (!finiteIn(top, -MAX_PDF_UNITS, MAX_PDF_UNITS)) return null;
  if (!finiteIn(scale, PDF_ZOOM_MIN, PDF_ZOOM_MAX)) return null;
  return { page, left, top, scale };
}

/**
 * Whether `c` names a mark: one ASCII letter or digit, as zathura's marks are.
 * @param {string} c
 */
export function isPdfMarkChar(c) {
  return typeof c === "string" && /^[A-Za-z0-9]$/.test(c);
}

/**
 * The document a mark belongs to: its URL without the fragment, which pdf.js changes as the
 * view moves; null for something that is not a URL.
 * @param {string} url
 * @returns {string | null}
 */
export function pdfDocumentKey(url) {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  parsed.hash = "";
  return parsed.href;
}
