/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Modes the host can report to the dispatcher. `prefix` is not a mode here: the dispatcher
 * tracks a pending prefix itself and the host shows it in the status bar via `pending()`.
 * `element` is a focused text block (docs/specs/element-focus.md): the mode `v` and `y` start from.
 * @typedef {"normal" | "insert" | "visual" | "command" | "hint" | "element" | "help" | "panel"
 *   | "resize"} Mode
 */

/** @type {readonly Mode[]} */
export const MODES = Object.freeze([
  "normal",
  "insert",
  "visual",
  "command",
  "hint",
  "element",
  "help",
  "panel",
  "resize",
]);

/** Modes in which leading digits are a count (`3gt`). */
/** @type {ReadonlySet<Mode>} */
export const COUNT_MODES = new Set(["normal", "visual", "element", "resize"]);

/**
 * @param {string} mode
 * @returns {mode is Mode}
 */
export function isMode(mode) {
  return /** @type {readonly string[]} */ (MODES).includes(mode);
}
