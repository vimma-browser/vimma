/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The private workspace's pair, whichever backend swaps it in place (docs/specs/private-swap.md
 * decisions 6 and 7, docs/specs/private-swap-macos.md decision 3): the normal window private was
 * entered from and the private window shown in its place, at most one of them hidden. Window
 * identifiers are opaque strings: Hyprland addresses for hyprswap.mjs, a per-window counter for
 * the native backend. Pure; in memory only.
 */

/**
 * @typedef {{ normal: string, private: string, parked: "normal" | "private" } | null} Pair
 */

/**
 * `unparked`: the hidden window was shown by someone other than Vimma (the user moved it out of
 * Hyprland's special workspace).
 * @typedef {{ type: "enter", normal: string, private: string }
 *   | { type: "leave" }
 *   | { type: "closing", window: string }
 *   | { type: "activated", window: string }
 *   | { type: "unparked", window: string }
 *   | { type: "failed" }} PairEvent
 */

/** @typedef {{ show: string, place: string }} ShowOp */

/** @param {Pair} pair @returns {string | null} the hidden window's identifier */
export function parkedWindow(pair) {
  if (!pair) return null;
  return pair.parked === "normal" ? pair.normal : pair.private;
}

/** @param {NonNullable<Pair>} pair @param {string} w */
const otherOf = (pair, w) => (w === pair.normal ? pair.private : pair.normal);

/**
 * The pair's state machine: what to show where, in order, and the next state.
 * @param {Pair} pair
 * @param {PairEvent} event
 * @returns {{ state: Pair, ops: ShowOp[] }}
 */
export function pairStep(pair, event) {
  const parked = parkedWindow(pair);
  switch (event.type) {
    case "enter": {
      const next = /** @type {Pair} */ ({
        normal: event.normal,
        private: event.private,
        parked: "normal",
      });
      if (pair?.parked === "normal") {
        if (pair.normal === event.normal && pair.private === event.private) {
          return { state: pair, ops: [] };
        }
        // Another normal window, or another private one: the hidden window comes back first.
        return {
          state: next,
          ops: [
            { show: pair.normal, place: pair.private },
            { show: event.private, place: event.normal },
          ],
        };
      }
      return { state: next, ops: [{ show: event.private, place: event.normal }] };
    }
    case "leave":
      if (pair?.parked !== "normal") return { state: pair, ops: [] };
      return {
        state: { ...pair, parked: "private" },
        ops: [{ show: pair.normal, place: pair.private }],
      };
    case "closing": {
      if (!pair || (event.window !== pair.normal && event.window !== pair.private)) {
        return { state: pair, ops: [] };
      }
      const other = otherOf(pair, event.window);
      return { state: null, ops: other === parked ? [{ show: other, place: event.window }] : [] };
    }
    case "activated":
      if (!pair || event.window !== parked) return { state: pair, ops: [] };
      return {
        state: { ...pair, parked: pair.parked === "normal" ? "private" : "normal" },
        ops: [{ show: event.window, place: otherOf(pair, event.window) }],
      };
    case "unparked":
      if (!pair || event.window !== parked) return { state: pair, ops: [] };
      return { state: null, ops: [] };
    default:
      return { state: null, ops: [] };
  }
}
