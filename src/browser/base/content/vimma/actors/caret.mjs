/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Copy mode in one frame (spec: docs/specs/m1-copy-mode.md), for VimmaChild. Firefox's caret
// browsing (F7) without its pref: the layout motions are nsISelectionController's, the methods
// F7's key bindings call, and the caret is enabled on this document's PresShell only. Vim's
// text motions (e, W, f, iw…) are computed by core motions.mjs over the text around the caret
// (text-model.mjs) and set through the Selection API.

import { findChar, firstNonBlank, textMotion, wordObject } from "../core/motions.mjs";
import { textAround } from "./text-model.mjs";
import { blockRangeAt } from "./block.mjs";

/** @import { FindKind } from "../core/motions.mjs" */
/** @import { Point } from "./text-model.mjs" */

/**
 * Layout motions: [nsISelectionController method, forward].
 * @type {Readonly<Record<string, ["characterMove" | "lineMove" | "wordMove" | "intraLineMove" | "completeMove" | "paragraphMove", boolean]>>}
 */
const MOVES = Object.freeze({
  left: ["characterMove", false],
  right: ["characterMove", true],
  up: ["lineMove", false],
  down: ["lineMove", true],
  word_forward: ["wordMove", true],
  word_backward: ["wordMove", false],
  line_start: ["intraLineMove", false],
  line_end: ["intraLineMove", true],
  top: ["completeMove", false],
  bottom: ["completeMove", true],
  paragraph_backward: ["paragraphMove", false],
  paragraph_forward: ["paragraphMove", true],
});
/**
 * Text motions (core motions.mjs): whether the target is right after a character (prefer the
 * end of the node before it) or right before one.
 * @type {Readonly<Record<string, boolean>>}
 */
const TEXT_MOVES = Object.freeze({
  word_end: true,
  word_end_backward: true,
  bigword_end: true,
  bigword_forward: false,
  bigword_backward: false,
});
/** Find ops, with their Vim key. They need a `char`. */
/** @type {Readonly<Record<string, FindKind>>} */
const FINDS = Object.freeze({
  find_forward: "f",
  find_backward: "F",
  till_forward: "t",
  till_backward: "T",
});
/** The ops that are not motions. */
const OPS = new Set([
  "enter",
  "toggle",
  "yank",
  "exit",
  "first_nonblank",
  "line",
  "swap",
  "inner_word",
  "a_word",
  "inner_block",
  "a_block",
  "yank_lines",
]);
/** A count above this is cut to it (`9999j`): each step is a layout query. */
const MAX_COUNT = 1000;
/** At most this many text nodes are searched for the first one on screen. */
const SEARCH_LIMIT = 20000;
/** NodeFilter.SHOW_TEXT (a system module has no NodeFilter global). */
const SHOW_TEXT = 0x4;
/** Text motions see this many characters each way, plus REACH_PER_COUNT for each step. */
const REACH = 2000;
const REACH_PER_COUNT = 64;

/**
 * Whether `data` is a well-formed copy-mode message: a known op, a count that is a positive
 * safe integer when present, and for a find op (only) a `char` of one code point.
 * @param {unknown} data
 * @returns {data is { op: string, count?: number, char?: string }}
 */
export function isCaretMessage(data) {
  if (!data || typeof data !== "object") return false;
  const { op, count, char } = /** @type {{ op?: unknown, count?: unknown, char?: unknown }} */ (
    data
  );
  if (typeof op !== "string") return false;
  const known =
    Object.hasOwn(MOVES, op) || Object.hasOwn(TEXT_MOVES, op) || Object.hasOwn(FINDS, op);
  if (!known && !OPS.has(op)) return false;
  if (Object.hasOwn(FINDS, op)) {
    if (typeof char !== "string" || [...char].length !== 1) return false;
  } else if (char !== undefined) return false;
  return count === undefined || (Number.isSafeInteger(count) && /** @type {number} */ (count) > 0);
}

/**
 * The first point of text inside the viewport, in document order: where the caret goes when
 * no selection is on screen.
 * @param {Window} win
 * @returns {{ node: Node, offset: number } | null}
 */
function firstTextOnScreen(win) {
  const doc = win.document;
  if (!doc.body) return null;
  const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
  const range = doc.createRange();
  let node = walker.nextNode();
  for (let i = 0; node && i < SEARCH_LIMIT; i++, node = walker.nextNode()) {
    if (!node.nodeValue?.trim()) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (!(r.height > 0 && r.bottom > 0 && r.top < win.innerHeight)) continue;
    if (r.top >= 0) return { node, offset: 0 };
    // A paragraph that starts above the viewport: its first character on screen.
    const pos = doc.caretPositionFromPoint(Math.max(r.left, 0) + 1, 1);
    return { node, offset: pos?.offsetNode === node ? pos.offset : 0 };
  }
  return null;
}

/**
 * Whether the selection's first range is at least partly on screen (a collapsed one too).
 * @param {Selection} sel
 * @param {Window} win
 */
function selectionOnScreen(sel, win) {
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  return r.height > 0 && r.bottom > 0 && r.top < win.innerHeight;
}

/** @param {Selection} sel */
const focusOf = (sel) => /** @type {Point} */ ({ node: sel.focusNode, offset: sel.focusOffset });
/** @param {Selection} sel */
const anchorOf = (sel) => /** @type {Point} */ ({ node: sel.anchorNode, offset: sel.anchorOffset });

/**
 * Whether point `a` is after point `b` in the document.
 * @param {Document} doc
 * @param {Point} a
 * @param {Point} b
 */
function isAfter(doc, a, b) {
  const r = doc.createRange();
  r.setStart(b.node, b.offset);
  return r.comparePoint(a.node, a.offset) > 0;
}

/** @typedef {{ start: Point, end: Point }} Line */

/** One frame's copy mode. */
export class Caret {
  /** Whether copy mode is on in this document. */
  on = false;
  /** Whether motions extend a selection (`v`) or move a bare caret. */
  selecting = false;
  /**
   * Line-wise selection (`V`): the anchor's line and the focus's line, whole. Null when the
   * selection is character-wise.
   * @type {{ a: Line, f: Line } | null}
   */
  linewise = null;

  /**
   * Runs a checked message. Replies: `enter` and motions true when done, false when copy mode
   * is not on here (the page navigated since) or there is no text on screen; `yank` and
   * `yank_lines` the copied text, "" for none; the others true.
   * @param {Window} win
   * @param {nsISelectionController} selCon  the frame's
   * @param {{ op: string, count?: number, char?: string }} msg
   * @returns {boolean | string}
   */
  run(win, selCon, { op, count = 1, char }) {
    const sel = win.getSelection();
    if (!sel) return false;
    switch (op) {
      case "enter": {
        // Vim's cursor: at the selection still on screen, else the top of the viewport.
        if (!selectionOnScreen(sel, win)) {
          const at = firstTextOnScreen(win);
          if (!at) return false;
          sel.collapse(at.node, at.offset);
        }
        this.on = true;
        this.selecting = !sel.isCollapsed;
        this.linewise = null;
        selCon.setDisplaySelection(Ci.nsISelectionController.SELECTION_ON);
        selCon.setCaretVisibilityDuringSelection(true);
        selCon.setCaretEnabled(true);
        return true;
      }
      case "toggle":
        if (!this.on) return false;
        if (this.linewise) {
          // v in a line-wise selection: the same selection, character-wise (Vim's).
          this.linewise = null;
          return true;
        }
        if (this.selecting && sel.focusNode) sel.collapse(sel.focusNode, sel.focusOffset);
        this.selecting = !this.selecting;
        return true;
      case "yank": {
        const text = this.on ? sel.toString() : "";
        this.exit(sel, selCon);
        return text;
      }
      case "yank_lines": {
        if (!this.on || !sel.rangeCount) return "";
        const doc = win.document;
        const [first, last] = isAfter(doc, anchorOf(sel), focusOf(sel))
          ? [focusOf(sel), anchorOf(sel)]
          : [anchorOf(sel), focusOf(sel)];
        const top = this.#lineOf(sel, selCon, first);
        const bottom = this.#lineOf(sel, selCon, last);
        sel.setBaseAndExtent(top.start.node, top.start.offset, bottom.end.node, bottom.end.offset);
        const text = sel.toString();
        this.exit(sel, selCon);
        return text;
      }
      case "exit":
        this.exit(sel, selCon);
        return true;
    }
    if (!this.on || !sel.rangeCount || !sel.focusNode) return false;
    // A focus change turns the caret off (nsFocusManager::UpdateCaret, pref off): on again.
    selCon.setCaretEnabled(true);
    const n = Math.min(count, MAX_COUNT);
    switch (op) {
      case "line":
        this.#line(win, sel, selCon);
        break;
      case "swap":
        this.#swap(win, sel);
        break;
      case "inner_word":
      case "a_word":
        this.#wordObject(win, sel, op === "a_word");
        break;
      case "inner_block":
      case "a_block":
        this.#blockObject(win, sel, op === "a_block");
        break;
      case "first_nonblank":
        selCon.intraLineMove(false, this.selecting);
        this.#textMove(win, sel, 1, (text, at) => firstNonBlank(text, at), false);
        break;
      default:
        if (Object.hasOwn(MOVES, op)) this.#layoutMove(sel, selCon, op, n);
        else if (Object.hasOwn(TEXT_MOVES, op)) {
          const after = TEXT_MOVES[op] === true;
          this.#textMove(win, sel, n, (text, at) => textMotion(text, at, op, n), after);
        } else {
          const kind = /** @type {FindKind} */ (FINDS[op]);
          const find = { kind, char: /** @type {string} */ (char) };
          this.#textMove(
            win,
            sel,
            n,
            (text, at) => findChar(text, at, find, n),
            kind === "f" || kind === "T",
          );
        }
        if (this.linewise) this.#snapLines(win, sel, selCon);
    }
    // A move scrolls only its nearest scrollable; the view follows the caret everywhere.
    selCon.scrollSelectionIntoView(
      Ci.nsISelectionController.SELECTION_NORMAL,
      Ci.nsISelectionController.SELECTION_FOCUS_REGION,
      Ci.nsISelectionController.SCROLL_SYNCHRONOUS,
    );
    return true;
  }

  /**
   * A layout motion `n` times. `{` and `}` from a paragraph's edge first step over it, so they
   * reach the next paragraph instead of staying put.
   * @param {Selection} sel
   * @param {nsISelectionController} selCon
   * @param {string} op
   * @param {number} n
   */
  #layoutMove(sel, selCon, op, n) {
    const [method, forward] = /** @type {(typeof MOVES)[string]} */ (MOVES[op]);
    for (let i = 0; i < n; i++) {
      const before = focusOf(sel);
      try {
        selCon[method](forward, this.selecting);
        const same = sel.focusNode === before.node && sel.focusOffset === before.offset;
        if (same && method === "paragraphMove") {
          selCon.characterMove(forward, this.selecting);
          selCon.paragraphMove(forward, this.selecting);
        }
      } catch {
        break; // nowhere further to go
      }
    }
  }

  /**
   * A text motion: `target` gets the text around the caret and the caret's index in it, and
   * returns where the caret goes (null: it stays).
   * @param {Window} win
   * @param {Selection} sel
   * @param {number} n  the count, for how much text to look at
   * @param {(text: string, at: number) => number | null} target
   * @param {boolean} afterChar  the target follows a character (e, f): it ends that node
   */
  #textMove(win, sel, n, target, afterChar) {
    const reach = REACH + n * REACH_PER_COUNT;
    const model = textAround(win, /** @type {Node} */ (sel.focusNode), sel.focusOffset, reach);
    if (!model) return;
    const to = target(model.text, model.at);
    if (to === null || to === model.at) return;
    const p = model.pointAt(to, afterChar);
    if (!p) return;
    if (this.selecting) sel.extend(p.node, p.offset);
    else sel.collapse(p.node, p.offset);
  }

  /**
   * The visual line through `p`, by Firefox's line motions; the selection is left collapsed at
   * the line's end.
   * @param {Selection} sel
   * @param {nsISelectionController} selCon
   * @param {Point} p
   * @returns {Line}
   */
  #lineOf(sel, selCon, p) {
    sel.collapse(p.node, p.offset);
    selCon.intraLineMove(false, false);
    const start = focusOf(sel);
    selCon.intraLineMove(true, false);
    return { start, end: focusOf(sel) };
  }

  /**
   * Sets the line-wise selection from the anchor line through the focus line.
   * @param {Window} win
   * @param {Selection} sel
   */
  #applyLines(win, sel) {
    const lw = /** @type {{ a: Line, f: Line }} */ (this.linewise);
    const down = !isAfter(win.document, lw.a.start, lw.f.start);
    const [base, extent] = down ? [lw.a.start, lw.f.end] : [lw.a.end, lw.f.start];
    sel.setBaseAndExtent(base.node, base.offset, extent.node, extent.offset);
  }

  /**
   * After a motion in a line-wise selection: the focus's whole line joins it.
   * @param {Window} win
   * @param {Selection} sel
   * @param {nsISelectionController} selCon
   */
  #snapLines(win, sel, selCon) {
    const lw = /** @type {{ a: Line, f: Line }} */ (this.linewise);
    lw.f = this.#lineOf(sel, selCon, focusOf(sel));
    this.#applyLines(win, sel);
  }

  /**
   * `V`: a line-wise selection over the lines of the caret or of the current selection; `V` in
   * one drops it, as `v` drops a character-wise one.
   * @param {Window} win
   * @param {Selection} sel
   * @param {nsISelectionController} selCon
   */
  #line(win, sel, selCon) {
    if (this.linewise) {
      this.linewise = null;
      this.selecting = false;
      sel.collapse(/** @type {Node} */ (sel.focusNode), sel.focusOffset);
      return;
    }
    const anchor = anchorOf(sel);
    const focus = focusOf(sel);
    const a = this.#lineOf(sel, selCon, this.selecting ? anchor : focus);
    const f = this.selecting ? this.#lineOf(sel, selCon, focus) : a;
    this.linewise = { a, f };
    this.selecting = true;
    this.#applyLines(win, sel);
  }

  /**
   * `o`: the anchor becomes the focus, so motions move the other end.
   * @param {Window} win
   * @param {Selection} sel
   */
  #swap(win, sel) {
    if (this.linewise) {
      const { a, f } = this.linewise;
      this.linewise = { a: f, f: a };
      this.#applyLines(win, sel);
      return;
    }
    const a = anchorOf(sel);
    const f = focusOf(sel);
    sel.setBaseAndExtent(f.node, f.offset, a.node, a.offset);
  }

  /**
   * `iw` / `aw`: selects the word at the caret (core wordObject), character-wise.
   * @param {Window} win
   * @param {Selection} sel
   * @param {boolean} around
   */
  #wordObject(win, sel, around) {
    const model = textAround(win, /** @type {Node} */ (sel.focusNode), sel.focusOffset, REACH);
    const range = model && wordObject(model.text, model.at, around);
    if (!model || !range) return;
    const start = model.pointAt(range[0], false);
    const end = model.pointAt(range[1], true);
    if (!start || !end) return;
    sel.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    this.selecting = true;
    this.linewise = null;
  }

  /**
   * `ip` / `ap` (element-focus decision 11): selects the text block around the caret as `v` from
   * element focus would, character-wise, anchor at its start; `ap` on a selection that already
   * holds that block takes its parent block instead.
   * @param {Window} win
   * @param {Selection} sel
   * @param {boolean} around
   */
  #blockObject(win, sel, around) {
    const selected = this.selecting && sel.rangeCount ? sel.getRangeAt(0) : null;
    const range = blockRangeAt(/** @type {Node} */ (sel.focusNode), win, around, selected);
    if (!range) return;
    sel.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    );
    this.selecting = true;
    this.linewise = null;
  }

  /**
   * Leaves copy mode: the selection collapses to the caret (where a later `v` or `/` starts)
   * and the caret is hidden again.
   * @param {Selection} sel
   * @param {nsISelectionController} selCon
   */
  exit(sel, selCon) {
    if (!this.on) return;
    this.on = false;
    this.selecting = false;
    this.linewise = null;
    if (sel.focusNode) sel.collapse(sel.focusNode, sel.focusOffset);
    selCon.setCaretEnabled(false);
  }
}
