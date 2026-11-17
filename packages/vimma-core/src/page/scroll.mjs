/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The j/k/h/l scroll step (spec: docs/specs/m1-actor-insert-scroll.md, "Follow-up: scroll step"):
 * `[scroll] step` in config.toml, which the parent sends with each scroll and the content actor
 * checks again before it scrolls.
 */

/** In CSS pixels: Vimium's scrollStepSize. */
export const SCROLL_STEP_DEFAULT = 60;
/** A pixel at a time is the finest step there is. */
export const SCROLL_STEP_MIN = 1;
/**
 * About a tall screen's height in CSS pixels: a longer step jumps past text never shown, and
 * `d` and `G` are there for moving by the page.
 */
export const SCROLL_STEP_MAX = 2000;

/**
 * The step to scroll by: `v` when it is an integer that config.toml could set, else the default.
 * @param {unknown} v
 * @returns {number}
 */
export function scrollStep(v) {
  return Number.isInteger(v) &&
    /** @type {number} */ (v) >= SCROLL_STEP_MIN &&
    /** @type {number} */ (v) <= SCROLL_STEP_MAX
    ? /** @type {number} */ (v)
    : SCROLL_STEP_DEFAULT;
}
