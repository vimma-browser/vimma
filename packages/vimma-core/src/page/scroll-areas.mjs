/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Which scroll area the scroll keys move (spec: docs/specs/scroll-area.md): each frame's reply
 * checked, the areas of every frame put in reading order, and the area `gs`, `gS` and a count
 * pick. The content actor finds the areas; the parent merges the frames.
 */

/** @import { Rect } from "./hints.mjs" */
/**
 * One frame's areas, in its viewport's CSS pixels (`viewport`: its size): `current` is the one
 * the scroll keys move in that frame now, `chosen` the one `gs` or a click chose there. `frames`: its visible subframes,
 * by browsing context id, with their viewports.
 * @typedef {{ viewport: Rect, areas: { rect: Rect, current: boolean, chosen: boolean }[],
 *   frames: { id: number, rect: Rect }[] }} ScrollAreasReply
 */

/** An area that shows less than this share of the top viewport is no area. */
export const SCROLL_AREA_MIN_SHARE = 0.1;
/** At most this many areas per frame: ten cover the viewport already. */
export const SCROLL_AREA_MAX_PER_FRAME = 32;
/** At most this many subframes per frame are asked for theirs. */
export const SCROLL_AREA_MAX_FRAMES = 16;

/** @param {unknown} v @returns {v is number} */
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * @param {unknown} v
 * @returns {Rect | null}
 */
function parseRect(v) {
  if (typeof v !== "object" || v === null) return null;
  const { x, y, width, height } = /** @type {Record<string, unknown>} */ (v);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/**
 * A frame's reply to `Vimma:ScrollAreas`, from a content process that may be compromised: a
 * fresh, checked copy, cut to the caps, with at most one area current and one chosen; null
 * when anything in it is malformed.
 * @param {unknown} raw
 * @returns {ScrollAreasReply | null}
 */
export function parseScrollAreasReply(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { viewport, areas, frames } = /** @type {Record<string, unknown>} */ (raw);
  const view = parseRect(viewport);
  if (!view || !Array.isArray(areas) || !Array.isArray(frames)) return null;
  /** @type {ScrollAreasReply} */
  const out = { viewport: view, areas: [], frames: [] };
  let current = false;
  let chosen = false;
  for (const a of areas.slice(0, SCROLL_AREA_MAX_PER_FRAME)) {
    if (typeof a !== "object" || a === null) return null;
    const r = /** @type {Record<string, unknown>} */ (a);
    const rect = parseRect(r.rect);
    if (!rect || typeof r.current !== "boolean" || typeof r.chosen !== "boolean") return null;
    out.areas.push({ rect, current: r.current && !current, chosen: r.chosen && !chosen });
    current ||= r.current;
    chosen ||= r.chosen;
  }
  for (const f of frames.slice(0, SCROLL_AREA_MAX_FRAMES)) {
    if (typeof f !== "object" || f === null) return null;
    const r = /** @type {Record<string, unknown>} */ (f);
    const rect = parseRect(r.rect);
    if (!rect || !Number.isSafeInteger(r.id)) return null;
    out.frames.push({ id: /** @type {number} */ (r.id), rect });
  }
  return out;
}

/**
 * The areas that count, in reading order: left to right, then top to bottom, and an area before
 * the ones inside it. An area counts when the part of it inside the viewport covers at least
 * SCROLL_AREA_MIN_SHARE of the viewport, so a short list or a code block in the text is passed
 * over. Rects are in the top frame's CSS pixels.
 * @template {{ rect: Rect }} T
 * @param {readonly T[]} areas
 * @param {{ width: number, height: number }} viewport
 * @returns {T[]}
 */
export function orderScrollAreas(areas, viewport) {
  const whole = viewport.width * viewport.height;
  /** @param {Rect} r */
  const shown = (r) => {
    const w = Math.min(r.x + r.width, viewport.width) - Math.max(r.x, 0);
    const h = Math.min(r.y + r.height, viewport.height) - Math.max(r.y, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };
  return areas
    .filter((a) => whole > 0 && shown(a.rect) >= SCROLL_AREA_MIN_SHARE * whole)
    .map((a, i) => ({ a, i }))
    .sort(
      (p, q) =>
        Math.round(p.a.rect.x) - Math.round(q.a.rect.x) ||
        Math.round(p.a.rect.y) - Math.round(q.a.rect.y) ||
        q.a.rect.width * q.a.rect.height - p.a.rect.width * p.a.rect.height ||
        p.i - q.i,
    )
    .map((p) => p.a);
}

/**
 * Which of the ordered areas the scroll keys move now: the chosen one, else the current one of
 * the first frame the scroll keys try (`frameOrder`: the focused subframe, then the top frame).
 * @param {readonly { frame: number, current: boolean, chosen: boolean }[]} areas
 * @param {readonly number[]} frameOrder
 * @returns {number} its index, or -1
 */
export function currentScrollArea(areas, frameOrder) {
  const chosen = areas.findIndex((a) => a.chosen);
  if (chosen >= 0) return chosen;
  for (const frame of frameOrder) {
    const i = areas.findIndex((a) => a.frame === frame && a.current);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * The area `gs` (direction 1) or `gS` (-1) goes to: the next or previous one, wrapping, or with
 * a count the Nth from the first, whichever the direction. Null when there is none: no areas,
 * or a count past the last, which leaves the target where it is.
 * @param {{ length: number, current: number, direction: 1 | -1, count?: number | null }} at
 * @returns {number | null}
 */
export function nextScrollArea({ length, current, direction, count = null }) {
  if (!(length > 0)) return null;
  if (count != null) return count >= 1 && count <= length ? count - 1 : null;
  if (current < 0 || current >= length) return direction > 0 ? 0 : length - 1;
  return (current + direction + length) % length;
}
