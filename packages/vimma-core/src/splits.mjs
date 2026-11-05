/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Several splits per workspace (docs/specs/multiple-splits.md): a list of pane trees, each with a
 * number from 1 to 9, at most one of them shown. The operations on one tree stay in panes.mjs;
 * these choose which tree a tab, a selection or a step reaches. Every operation is pure and
 * returns a new frozen state; a no-op returns the input itself.
 */

import { closePane, createRow, focusPane, leaves, paneOfTab, showView } from "./panes.mjs";

/** @import { Panes } from "./panes.mjs" */
/**
 * A split: a pane tree of two panes or more, and its number (decision 8). It never carries
 * `hidden`: which split shows is `Splits.shown`.
 * @typedef {Panes & { readonly number: number }} NumberedSplit
 */
/**
 * `splits` in number order; `shown`, the number of the split on screen (null while a tab in no
 * split shows alone); `last`, the split shown last, which `]s` and `[s` go back to from a lone
 * tab (behaviour 8). Both name a split of the list, or are null.
 * @typedef {{ readonly splits: readonly NumberedSplit[], readonly shown: number | null,
 *   readonly last: number | null }} Splits
 */
/**
 * `max`: config `[panes] max_splits` (MAX_SPLITS_DEFAULT when not given).
 * @typedef {{ max?: number }} SplitsOptions
 */

/** Default of config `[panes] max_splits` (decision 7): the picker's digits reach every split. */
export const MAX_SPLITS_DEFAULT = 9;
/** Largest `[panes] max_splits`: one palette colour per split number (decision 11). */
export const MAX_SPLITS_LIMIT = 9;

export class SplitsError extends Error {
  /**
   * @param {"bad-max" | "unknown-split" | "bad-tabs"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "SplitsError";
    this.code = code;
  }
}

/** @type {Splits} */
const EMPTY = Object.freeze({ splits: Object.freeze([]), shown: null, last: null });

/** A workspace without splits. */
export function createSplits() {
  return EMPTY;
}

/**
 * The label a split goes by in the side panel, the picker and the status bar: `S1` to `S9`.
 * @param {number} number
 */
export function splitLabel(number) {
  return `S${number}`;
}

/**
 * @param {unknown} max
 * @returns {number}
 */
function checkMax(max) {
  if (Number.isInteger(max) && /** @type {number} */ (max) >= 1) {
    if (/** @type {number} */ (max) <= MAX_SPLITS_LIMIT) return /** @type {number} */ (max);
  }
  throw new SplitsError(
    "bad-max",
    `max splits must be an integer from 1 to ${MAX_SPLITS_LIMIT}, got ${String(max)}`,
  );
}

/**
 * @param {readonly NumberedSplit[]} splits
 * @param {number | null} shown
 * @param {number | null} last
 * @returns {Splits}
 */
function make(splits, shown, last) {
  const list = Object.freeze(splits.slice().sort((a, b) => a.number - b.number));
  const has = (/** @type {number | null} */ n) => n !== null && list.some((x) => x.number === n);
  return Object.freeze({
    splits: list,
    shown: has(shown) ? shown : null,
    last: has(last) ? last : null,
  });
}

/**
 * A tree as split `number`, without a `hidden` flag.
 * @param {Panes} panes
 * @param {number} number
 * @returns {NumberedSplit}
 */
function numbered(panes, number) {
  return Object.freeze({ ...showView(panes), number });
}

/**
 * @param {Splits} s
 * @param {number} number
 * @returns {NumberedSplit}
 */
function mustSplit(s, number) {
  const found = s.splits.find((x) => x.number === number);
  if (!found) throw new SplitsError("unknown-split", `no split ${number}`);
  return found;
}

/**
 * The split that shows `tabId` in one of its panes.
 * @param {Splits} s
 * @param {string} tabId
 * @returns {NumberedSplit | undefined}
 */
export function splitOfTab(s, tabId) {
  return s.splits.find((x) => paneOfTab(x, tabId) !== undefined);
}

/**
 * The split on screen, if any.
 * @param {Splits} s
 * @returns {NumberedSplit | undefined}
 */
export function shownSplit(s) {
  return s.shown === null ? undefined : s.splits.find((x) => x.number === s.shown);
}

/**
 * A workspace's one pane tree as splits (decision 15: a snapshot or a model from before several
 * splits). A tree of two panes or more is split 1, shown unless it is a hidden view; one pane, or
 * none, is no split.
 * @param {Panes | null | undefined} panes
 * @returns {Splits}
 */
export function splitsFromPanes(panes) {
  if (!panes || panes.root.type !== "split") return EMPTY;
  return make([numbered(panes, 1)], panes.hidden === true ? null : 1, 1);
}

/**
 * Split `number` with tree `panes`. A tree left with fewer than two panes ends the split; one
 * showing a tab of another split is an error (decision 2).
 * @param {Splits} s
 * @param {number} number
 * @param {Panes} panes
 * @returns {Splits}
 */
export function updateSplit(s, number, panes) {
  const old = mustSplit(s, number);
  if (leaves(panes).length < 2) return endSplit(s, number);
  for (const l of leaves(panes)) {
    const owner = splitOfTab(s, l.tab);
    if (owner && owner.number !== number) {
      throw new SplitsError("bad-tabs", `tab "${l.tab}" is in split ${owner.number}`);
    }
  }
  const next = numbered(panes, number);
  const splits = s.splits.map((x) => (x === old ? next : x));
  return make(splits, s.shown, s.last);
}

/**
 * Ends split `number`: its tabs stay open, in no split, and its number is free again.
 * @param {Splits} s
 * @param {number} number
 * @returns {Splits}
 */
export function endSplit(s, number) {
  const old = mustSplit(s, number);
  return make(
    s.splits.filter((x) => x !== old),
    s.shown,
    s.last,
  );
}

/**
 * A closed tab leaves its split: its pane closes as `ctrl+b x` closes it, and a split left with
 * one pane ends. A tab in no split changes nothing.
 * @param {Splits} s
 * @param {string} tabId
 * @returns {Splits}
 */
export function removeSplitTab(s, tabId) {
  const owner = splitOfTab(s, tabId);
  if (!owner) return s;
  if (leaves(owner).length <= 2) return endSplit(s, owner.number);
  const pane = /** @type {string} */ (paneOfTab(owner, tabId));
  return updateSplit(s, owner.number, closePane(owner, pane));
}

/**
 * Shows split `number` as it was (tree, sizes, zoom and focused pane); every other split is
 * hidden (behaviour 2).
 * @param {Splits} s
 * @param {number} number
 * @returns {Splits}
 */
export function showSplit(s, number) {
  mustSplit(s, number);
  return s.shown === number && s.last === number ? s : make(s.splits, number, number);
}

/**
 * What selecting `tabId` does (behaviour 2). A tab of a split shows that split with focus on the
 * tab's pane ("show"), or only moves the focus when it already shows ("focus", "none"). A tab in
 * no split shows alone: the shown split is hidden and remembered as the last ("hide").
 * @param {Splits} s
 * @param {string} tabId
 * @returns {{ splits: Splits, change: "none" | "focus" | "show" | "hide" }}
 */
export function selectSplitTab(s, tabId) {
  const owner = splitOfTab(s, tabId);
  if (!owner) {
    if (s.shown === null) return { splits: s, change: "none" };
    return { splits: make(s.splits, null, s.shown), change: "hide" };
  }
  const pane = /** @type {string} */ (paneOfTab(owner, tabId));
  const focused = /** @type {NumberedSplit} */ (focusPane(owner, pane));
  const splits = focused === owner ? s.splits : s.splits.map((x) => (x === owner ? focused : x));
  if (s.shown === owner.number) {
    if (focused === owner) return { splits: s, change: "none" };
    return { splits: make(splits, s.shown, s.last), change: "focus" };
  }
  return { splits: make(splits, owner.number, owner.number), change: "show" };
}

/**
 * Behaviour 5's refusal at `max` splits.
 * @param {number} max
 */
function maxRefusal(max) {
  return `new split: at most ${max} split${max === 1 ? "" : "s"} in a workspace`;
}

/**
 * A new split of `tabIds` side by side (the side panel's marks, decision 5), numbered with the
 * lowest free number and shown at once. A tab of another split moves (decision 6): its pane
 * closes there, and a split left with one pane ends. With `max` splits after those moves, the
 * change is refused and `splits` is the input itself; at `max` 1 the new split replaces the old
 * one instead, as a workspace held one split before (decision 7).
 * @param {Splits} s
 * @param {readonly string[]} tabIds
 * @param {SplitsOptions & { focus?: string }} [options]
 * @returns {{ splits: Splits, refusal: string | null }}
 */
export function newSplit(s, tabIds, { max = MAX_SPLITS_DEFAULT, focus } = {}) {
  const limit = checkMax(max);
  if (tabIds.length < 2 || new Set(tabIds).size !== tabIds.length) {
    throw new SplitsError("bad-tabs", "a new split needs two different tabs or more");
  }
  let rest = s;
  for (const t of tabIds) rest = removeSplitTab(rest, t);
  if (limit === 1) rest = EMPTY;
  if (rest.splits.length >= limit) return { splits: s, refusal: maxRefusal(limit) };
  const used = new Set(rest.splits.map((x) => x.number));
  let number = 1;
  while (used.has(number)) number++;
  const tree = numbered(createRow(tabIds, focus === undefined ? {} : { focus }), number);
  return { splits: make([...rest.splits, tree], number, number), refusal: null };
}

/**
 * `]s` (`by` 1) and `[s` (`by` -1): the next or previous split by number, wrapping (behaviour 8).
 * From a lone tab both first show the split shown last, else the first one in that direction.
 * Without splits: refused with `no splits`.
 * @param {Splits} s
 * @param {1 | -1} by
 * @returns {{ splits: Splits, refusal: string | null }}
 */
export function stepSplit(s, by) {
  const n = s.splits.length;
  if (!n) return { splits: s, refusal: "no splits" };
  /** @type {number} */
  let number;
  if (s.shown === null) {
    const first = /** @type {NumberedSplit} */ (s.splits[by > 0 ? 0 : n - 1]);
    number = s.last ?? first.number;
  } else {
    const at = s.splits.findIndex((x) => x.number === s.shown);
    number = /** @type {NumberedSplit} */ (s.splits[(((at + by) % n) + n) % n]).number;
  }
  return { splits: showSplit(s, number), refusal: null };
}
