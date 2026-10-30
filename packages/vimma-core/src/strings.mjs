/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Linear-time string edits that stand in for regular expressions a backtracking engine runs in
 * quadratic time on long runs of one character (CodeQL js/polynomial-redos). Each one's doc
 * names the expression it replaces; test/fuzz/strings.fuzz.test.mjs checks them against it.
 */

/** @param {string} c  one UTF-16 code unit */
const isSpace = (c) => /\s/.test(c);

/** @param {string} c */
const isBlank = (c) => c === " " || c === "\t";

/**
 * `s` without the leading and trailing spaces and tabs: `s.replace(/^[ \t]+|[ \t]+$/g, "")`.
 * @param {string} s
 */
export function trimBlanks(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isBlank(/** @type {string} */ (s[start]))) start++;
  while (end > start && isBlank(/** @type {string} */ (s[end - 1]))) end--;
  return s.slice(start, end);
}

/**
 * `s` without its trailing run of `ch`: `s.replace(/ch+$/, "")`.
 * @param {string} s
 * @param {string} ch  one UTF-16 code unit
 */
export function trimTrailing(s, ch) {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

/**
 * Vim's insert-mode ctrl-w on the end of `s`: the trailing whitespace and the word before it go,
 * as `s.replace(/\S*\s*$/, "")`.
 * @param {string} s
 */
export function deleteWordBackward(s) {
  let end = s.length;
  while (end > 0 && isSpace(/** @type {string} */ (s[end - 1]))) end--;
  while (end > 0 && !isSpace(/** @type {string} */ (s[end - 1]))) end--;
  return s.slice(0, end);
}

/**
 * Whether `s` holds a C0 control character (tab and line feed included) or DEL: the rule for
 * text that `config.toml` gives and for an agent CLI's model wherever it is taken.
 * @param {string} s
 */
export const hasControl = (s) =>
  [...s].some((ch) => /** @type {number} */ (ch.codePointAt(0)) < 0x20 || ch === "\x7f");
