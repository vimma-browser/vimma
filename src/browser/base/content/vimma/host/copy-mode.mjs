/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Copy mode's actions on the focused page (spec: docs/specs/m1-copy-mode.md): `v` / `prefix+[`
// enter it (the `visual` mode), the motions move the caret in the focused frame, `v` starts or
// drops a selection, `y` copies it as plain text. VimmaHost spreads these into CONTENT_RUNNERS;
// Esc is its `mode.normal`, which asks the frame to leave copy mode first.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { repeatFind } from "../core/motions.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */
/** @import { Find, FindKind } from "../core/motions.mjs" */

/** Action id → the frame's motion (actors/caret.mjs). */
const MOTIONS = Object.freeze({
  "caret.left": "left",
  "caret.right": "right",
  "caret.up": "up",
  "caret.down": "down",
  "caret.word_forward": "word_forward",
  "caret.word_backward": "word_backward",
  "caret.line_start": "line_start",
  "caret.line_end": "line_end",
  "caret.top": "top",
  "caret.bottom": "bottom",
  "caret.word_end": "word_end",
  "caret.word_end_backward": "word_end_backward",
  "caret.bigword_forward": "bigword_forward",
  "caret.bigword_backward": "bigword_backward",
  "caret.bigword_end": "bigword_end",
  "caret.first_nonblank": "first_nonblank",
  "caret.paragraph_backward": "paragraph_backward",
  "caret.paragraph_forward": "paragraph_forward",
  "selection.line": "line",
  "selection.swap": "swap",
  "selection.inner_word": "inner_word",
  "selection.a_word": "a_word",
  "selection.inner_block": "inner_block",
  "selection.a_block": "a_block",
});

/** Find actions (`f x`) → their Vim kind; the frame's op is FIND_OPS[kind]. */
/** @type {Readonly<Record<string, FindKind>>} */
const FINDS = Object.freeze({
  "caret.find_forward": "f",
  "caret.find_backward": "F",
  "caret.till_forward": "t",
  "caret.till_backward": "T",
});
/** @type {Readonly<Record<FindKind, string>>} */
const FIND_OPS = Object.freeze({
  f: "find_forward",
  F: "find_backward",
  t: "till_forward",
  T: "till_backward",
});

/** Shown when there is no text on screen to put the caret in. */
export const NO_TEXT = "copy mode: no text on screen";
/** Shown after `y` with nothing selected. */
export const NOTHING_TO_YANK = "nothing to yank";

/**
 * @param {string} text
 * @returns {string}
 */
export function yankedText(text) {
  const n = [...text].length;
  return `yanked ${n} ${n === 1 ? "char" : "chars"}`;
}

/**
 * The runners, given how the host sets a tab's page mode and shows a notice in its window.
 * The mode changes before the frame is asked, so the next key is already dispatched in it.
 * @param {(browser: any, mode: "normal" | "visual") => void} setMode
 * @param {(browser: any, text: string) => void} notify
 * @returns {Record<string, (browser: any, action: Action) => void>}
 */
export function copyModeRunners(setMode, notify) {
  /** Copy mode is over in the frame (no text, or it navigated): back to normal, told why. */
  const leave = (/** @type {any} */ b, /** @type {string | null} */ why) => {
    setMode(b, "normal");
    if (why) notify(b, why);
  };
  /**
   * The last f, F, t or T, for `;` and `,` (Vim's is global too).
   * @type {Find | null}
   */
  let lastFind = null;
  /** Runs a find in the focused frame. */
  const find = async (/** @type {any} */ b, /** @type {Find | null} */ f, count = 1) => {
    if (!f) return;
    const op = FIND_OPS[f.kind];
    if (!(await VimmaActors.caret(b, op, count === 1 ? undefined : count, f.char))) leave(b, null);
  };
  /** @type {(b: any, op: "yank" | "yank_lines") => Promise<void>} */
  const yank = async (b, op) => {
    setMode(b, "normal");
    const text = await VimmaActors.caret(b, op);
    if (typeof text !== "string" || !text) {
      notify(b, NOTHING_TO_YANK);
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
    notify(b, yankedText(text));
  };
  /** @type {Record<string, (browser: any, action: Action) => void>} */
  const runners = {
    "mode.visual": async (b) => {
      setMode(b, "visual");
      if (!(await VimmaActors.caret(b, "enter"))) leave(b, NO_TEXT);
    },
    "selection.toggle": async (b) => {
      if (!(await VimmaActors.caret(b, "toggle"))) leave(b, null);
    },
    "selection.yank": (b) => yank(b, "yank"),
    "selection.yank_lines": (b) => yank(b, "yank_lines"),
    "caret.find_repeat": (b, a) => find(b, repeatFind(lastFind, false), a.count),
    "caret.find_repeat_reverse": (b, a) => find(b, repeatFind(lastFind, true), a.count),
  };
  for (const [id, kind] of Object.entries(FINDS)) {
    runners[id] = (b, a) => {
      if (typeof a.char !== "string") return;
      lastFind = { kind, char: a.char };
      return find(b, lastFind, a.count);
    };
  }
  for (const [id, op] of Object.entries(MOTIONS)) {
    runners[id] = async (b, a) => {
      if (!(await VimmaActors.caret(b, op, a.count))) leave(b, null);
    };
  }
  return runners;
}
