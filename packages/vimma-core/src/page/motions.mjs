/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Copy mode's Vim text motions over a flat string (spec: docs/specs/m1-copy-mode.md,
 * § Settled). The actor flattens the text around the caret into one string (actors/text-model.mjs)
 * with BLOCK between blocks and "\n" for a line break, asks here for a target, and maps it back
 * into the DOM. Positions are caret positions, between characters: 0 is before the first.
 *
 * Vim's cursor sits on a character and its visual selection includes it; a caret sits between
 * two. A motion that Vim ends ON a character (e, E, ge, f, T backwards) ends here AFTER it, so
 * `v e y` yanks the whole word as Vim's does; one that Vim ends before a character (w, W, B, t,
 * F) ends here before it.
 */

/** Stands for a block boundary (U+2029 PARAGRAPH SEPARATOR): blank, and ends a line. */
export const BLOCK = " ";

/** @typedef {"f" | "F" | "t" | "T"} FindKind */
/** @typedef {{ kind: FindKind, char: string }} Find */
/**
 * @typedef {"word_end" | "word_end_backward" | "bigword_forward" | "bigword_backward"
 *   | "bigword_end"} TextMotion
 */

/** The motions `textMotion` knows. */
export const TEXT_MOTIONS = Object.freeze([
  "word_end",
  "word_end_backward",
  "bigword_forward",
  "bigword_backward",
  "bigword_end",
]);

const BLANK = /\s/u;
const WORD = /[\p{L}\p{M}\p{N}_]/u;
/** Ends a line for f/t, iw/aw and ^. */
const isBreak = (/** @type {string | undefined} */ c) => c === "\n" || c === "\r" || c === BLOCK;

/**
 * Vim's character classes: 0 blank, 1 punctuation, 2 word. A WORD (big) has only blank and
 * non-blank.
 * @param {string | undefined} c
 * @param {boolean} big
 */
function cls(c, big) {
  if (c === undefined || BLANK.test(c)) return 0;
  if (big) return 1;
  return WORD.test(c) ? 2 : 1;
}

/**
 * Whether a word (or WORD) ends at caret position j: the character before it is not blank and
 * the one after is of another class (or there is none).
 * @param {string} text
 * @param {number} j
 * @param {boolean} big
 */
function isEnd(text, j, big) {
  if (j <= 0) return false;
  const before = cls(text[j - 1], big);
  return before !== 0 && (j >= text.length || cls(text[j], big) !== before);
}

/**
 * Whether a word (or WORD) starts at caret position j.
 * @param {string} text
 * @param {number} j
 * @param {boolean} big
 */
function isStart(text, j, big) {
  if (j >= text.length) return false;
  const here = cls(text[j], big);
  return here !== 0 && (j === 0 || cls(text[j - 1], big) !== here);
}

/**
 * The next caret position after (or before) `i` where `test` holds, or null.
 * @param {string} text
 * @param {number} i
 * @param {1 | -1} step
 * @param {(j: number) => boolean} test
 */
function scan(text, i, step, test) {
  for (let j = i + step; j >= 0 && j <= text.length; j += step) if (test(j)) return j;
  return null;
}

/**
 * Where a word motion takes the caret from `i`, `count` times; null when it cannot move at
 * all. A count that runs out of text stops at the last target found (Vim's does too).
 * @param {string} text
 * @param {number} i
 * @param {string} motion  one of TEXT_MOTIONS
 * @param {number} [count]
 * @returns {number | null}
 */
export function textMotion(text, i, motion, count = 1) {
  /** @type {(j: number) => number | null} */
  let step;
  switch (motion) {
    case "word_end":
      step = (j) => scan(text, j, 1, (k) => isEnd(text, k, false));
      break;
    case "word_end_backward":
      step = (j) => scan(text, j, -1, (k) => isEnd(text, k, false));
      break;
    case "bigword_end":
      step = (j) => scan(text, j, 1, (k) => isEnd(text, k, true));
      break;
    case "bigword_forward":
      step = (j) => scan(text, j, 1, (k) => isStart(text, k, true));
      break;
    case "bigword_backward":
      step = (j) => scan(text, j, -1, (k) => isStart(text, k, true));
      break;
    default:
      throw new Error(`unknown text motion "${motion}"`);
  }
  /** @type {number | null} */
  let at = null;
  for (let n = 0, from = i; n < count; n++) {
    const next = step(from);
    if (next === null) break;
    at = from = next;
  }
  return at;
}

/**
 * `^`: the first non-blank character at or after a line start; a blank line stays put.
 * @param {string} text
 * @param {number} lineStart
 * @returns {number}
 */
export function firstNonBlank(text, lineStart) {
  for (let j = lineStart; j < text.length && !isBreak(text[j]); j++) {
    if (!BLANK.test(/** @type {string} */ (text[j]))) return j;
  }
  return lineStart;
}

/**
 * @param {unknown} k
 * @returns {k is FindKind}
 */
export function isFindKind(k) {
  return k === "f" || k === "F" || k === "t" || k === "T";
}

/**
 * `f`, `F`, `t`, `T`: the `count`th `char` on the caret's line (between line breaks), or null.
 * f ends after the character and t before it (forward); F before it and T after it (back).
 * t and T skip a match right next to the caret, so `;` after them moves on.
 * @param {string} text
 * @param {number} i
 * @param {Find} find
 * @param {number} [count]
 * @returns {number | null}
 */
export function findChar(text, i, { kind, char }, count = 1) {
  const forward = kind === "f" || kind === "t";
  const len = char.length;
  let at = i;
  for (let n = 0; n < count; n++) {
    // The index of the match's first code unit, searched from `from` within the line.
    let from = forward ? at + (kind === "t" ? 1 : 0) : at - len - (kind === "T" ? 1 : 0);
    let hit = -1;
    for (; from >= 0 && from + len <= text.length; from += forward ? 1 : -1) {
      if (isBreak(text[forward ? from : from + len - 1])) break;
      if (text.startsWith(char, from)) {
        hit = from;
        break;
      }
    }
    if (hit < 0) return null;
    at = kind === "f" || kind === "T" ? hit + len : hit;
  }
  return at;
}

/** `,` runs the last find the other way. */
const REVERSED = Object.freeze({ f: "F", F: "f", t: "T", T: "t" });

/**
 * `;` (same direction) and `,` (reversed): the find to run again, or null when there was none.
 * @param {Find | null} last
 * @param {boolean} reverse
 * @returns {Find | null}
 */
export function repeatFind(last, reverse) {
  if (!last) return null;
  return {
    kind: reverse ? /** @type {FindKind} */ (REVERSED[last.kind]) : last.kind,
    char: last.char,
  };
}

/**
 * `iw` / `aw`: the word at the caret as [start, end]: the run of one class (word,
 * punctuation or blanks) that the character after the caret belongs to (the one before it at a
 * line's end). `aw` adds the blanks after a word, or before it when none follow, and the word
 * after a run of blanks. Never crosses a line break; null for no text.
 * @param {string} text
 * @param {number} i
 * @param {boolean} around
 * @returns {[number, number] | null}
 */
export function wordObject(text, i, around) {
  let c = i;
  if (c >= text.length || isBreak(text[c])) c--;
  if (c < 0 || isBreak(text[c])) return null;
  const run = (/** @type {number} */ at) => {
    const k = cls(text[at], false);
    let s = at;
    let e = at + 1;
    while (s > 0 && !isBreak(text[s - 1]) && cls(text[s - 1], false) === k) s--;
    while (e < text.length && !isBreak(text[e]) && cls(text[e], false) === k) e++;
    return /** @type {[number, number]} */ ([s, e]);
  };
  const [s, e] = run(c);
  if (!around) return [s, e];
  const blank = (/** @type {number} */ at) =>
    at >= 0 && at < text.length && !isBreak(text[at]) && cls(text[at], false) === 0;
  if (cls(text[c], false) === 0) {
    // Blanks: and the word after them.
    return e < text.length && !isBreak(text[e]) ? [s, run(e)[1]] : [s, e];
  }
  if (blank(e)) return [s, run(e)[1]];
  if (blank(s - 1)) return [run(s - 1)[0], e];
  return [s, e];
}
