/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The private workspace swapped in place on macOS (docs/specs/private-swap-macos.md), without a
 * window manager: the browser hides and shows its own windows. Pure: the plan for "show X in
 * Y's place" from two plain frame records (decision 13). The host reads and applies frames
 * (host/native-swap.mjs); the pair's state machine is privatepair.mjs.
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * A window's frame as the host reads it. Position in desktop pixels, size in CSS pixels
 * (decision 2). `sizemode` is Firefox's `windowState` as a word; `restored` is a zoomed
 * window's un-zoomed frame from its root element's persisted attributes, or null.
 * @typedef {object} Frame
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {"normal" | "maximized" | "minimized" | "fullscreen"} sizemode
 * @property {Rect | null} restored
 */

/**
 * `swap`: put X at `frame` (restoring it first if `restoreFirst`), zoom it if `zoom`, show it,
 * hide Y. `fullscreen`: Y is in a native fullscreen Space and is never hidden (decision 7).
 * `refuse`: no swap; the window is shown as a window of its own.
 * @typedef {{ kind: "swap", frame: Rect, restoreFirst: boolean, zoom: boolean }
 *   | { kind: "fullscreen" }
 *   | { kind: "refuse", reason: string }} NativePlan
 */

const SIZEMODES = new Set(["normal", "maximized", "minimized", "fullscreen"]);
/** Larger than any desktop; a coordinate past it is a broken read. */
const MAX_COORD = 1e6;
/** Rounding between desktop and CSS pixels on a scaled screen. */
const TOLERANCE = 1;

/** @param {unknown} v */
const isCoord = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < MAX_COORD;
/** @param {unknown} v */
const isSize = (v) => isCoord(v) && /** @type {number} */ (v) >= 1;

/** @param {unknown} r @returns {r is Rect} */
function isRect(r) {
  if (!r || typeof r !== "object") return false;
  const { x, y, width, height } = /** @type {Record<string, unknown>} */ (r);
  return isCoord(x) && isCoord(y) && isSize(width) && isSize(height);
}

/** @param {unknown} f @returns {f is Frame} */
const isFrame = (f) => isRect(f) && SIZEMODES.has(/** @type {any} */ (f).sizemode);

/** @param {Rect} r @returns {Rect} */
const rectOf = ({ x, y, width, height }) => ({ x, y, width, height });

/**
 * The frame a window put in `place`'s slot gets before any zoom: a zoomed window's restored
 * frame when it is usable, so that un-zooming goes to a real smaller frame, else the frame
 * itself (decision 2).
 * @param {Frame} place
 */
const slotRect = (place) =>
  place.sizemode === "maximized" && isRect(place.restored) ? rectOf(place.restored) : rectOf(place);

/**
 * Show `show` exactly where `place` is (Design: the mechanism).
 * @param {Frame} show
 * @param {Frame} place
 * @returns {NativePlan}
 */
export function planNativeShow(show, place) {
  if (!isFrame(show) || !isFrame(place)) return { kind: "refuse", reason: "a bad frame" };
  if (show.sizemode === "minimized" || place.sizemode === "minimized") {
    return { kind: "refuse", reason: "the window is minimized" };
  }
  if (place.sizemode === "fullscreen") return { kind: "fullscreen" };
  if (show.sizemode === "fullscreen") {
    return { kind: "refuse", reason: "the window is in full screen" };
  }
  return {
    kind: "swap",
    frame: slotRect(place),
    restoreFirst: show.sizemode === "maximized",
    zoom: place.sizemode === "maximized",
  };
}

/**
 * Where a new private window opens to take `from`'s place: its frame, or its restored frame
 * when zoomed. Null for a window it will not replace (full screen, minimized, a bad frame).
 * @param {Frame} from
 * @returns {Rect | null}
 */
export function openFrame(from) {
  if (!isFrame(from) || from.sizemode === "fullscreen" || from.sizemode === "minimized") {
    return null;
  }
  return slotRect(from);
}

/**
 * Whether the shown window reports the frame a swap gave it (decision 9): the same frame to a
 * pixel of rounding, or zoomed when the plan zoomed it.
 * @param {Extract<NativePlan, { kind: "swap" }>} plan
 * @param {Frame} actual
 */
export function frameApplied(plan, actual) {
  if (!isFrame(actual)) return false;
  if (plan.zoom) return actual.sizemode === "maximized";
  if (actual.sizemode !== "normal") return false;
  const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) <= TOLERANCE;
  const f = plan.frame;
  return (
    near(actual.x, f.x) &&
    near(actual.y, f.y) &&
    near(actual.width, f.width) &&
    near(actual.height, f.height)
  );
}
