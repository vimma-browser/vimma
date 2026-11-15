/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep in one frame (docs/specs/live-grep.md, security.md section 15): the text model of the
// frame's document, its query in the process's matcher, the preview and the jump. VimmaChild owns
// one per actor and hands it the `Vimma:Grep*` messages; it reads only the actor's document and
// window.

import { GREP_CAPS, parseQuery, previewLines } from "../core/grep.mjs";
import { textOfDocument } from "./text-model.mjs";
import { GrepMatcher } from "./grep-matcher.mjs";

/** nsISelectionController.SELECTION_NORMAL */
const SELECTION_NORMAL = 1;

/** nsISelectionController values for live grep's jump (docs/specs/live-grep.md decision 7). */
const DISPLAY_ATTENTION = 4;
const WHOLE_SELECTION = 2;
const SCROLL_SYNCHRONOUS = 1 << 1;
const SCROLL_VERTICAL_CENTER = 1 << 5;
/** The longest query a frame accepts (the parent sends none longer). */
const GREP_QUERY_MAX = GREP_CAPS.query;
/** Text with something to find: a blank frame is answered without the worker. */
const NOT_BLANK = /\S/;

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * @typedef {object} GrepPageHooks  what the helper needs of the child's private parts
 * @property {() => Element | null} activeElement  the focused element, through shadow roots
 * @property {(el: Element) => boolean} editable  whether the element keeps the tab in insert
 * @property {() => nsISelectionController | null} selCon  the frame's selection controller
 */

export class GrepPage {
  /** @type {JSWindowActorChild} */
  #actor;
  /** @type {GrepPageHooks} */
  #hooks;
  /**
   * Live grep (docs/specs/live-grep.md decision 14): this document's text model while the
   * picker is open, marked stale by any change to the document until the next query rebuilds it.
   * @type {{ model: ReturnType<typeof textOfDocument>, stale: boolean,
   *   observer: MutationObserver | null }}
   */
  #grep = { model: null, stale: true, observer: null };
  /** This frame's key in the process's matcher, and the newest search generation it saw. */
  #matcher = { key: GrepMatcher.newKey(), gen: -1 };

  /**
   * @param {JSWindowActorChild} actor  the VimmaChild: its document, window and browsing context
   *   are read
   * @param {GrepPageHooks} hooks
   */
  constructor(actor, hooks) {
    this.#actor = actor;
    this.#hooks = hooks;
  }

  /** The text model, rebuilt when the document changed since it was built. */
  #grepModel() {
    const win = this.#actor.contentWindow;
    if (!win) return null;
    if (this.#grep.model && !this.#grep.stale) return this.#grep.model;
    if (!this.#grep.observer) {
      const observer = new win.MutationObserver(() => {
        this.#grep.stale = true;
      });
      observer.observe(this.#actor.document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      this.#grep.observer = observer;
    }
    this.#grep.model = textOfDocument(win, GREP_CAPS.modelChars);
    this.#grep.stale = false;
    return this.#grep.model;
  }

  /** Drops the text model when the picker closes: no page text outlives the search. */
  end() {
    this.#grep.observer?.disconnect();
    this.#grep = { model: null, stale: true, observer: null };
    // The next search may come from another window, whose generations start again.
    this.#matcher.gen = -1;
    GrepMatcher.drop(this.#matcher.key);
  }

  /**
   * @param {unknown} query
   * @returns {query is string}
   */
  #isQuery(query) {
    return typeof query === "string" && query.length > 0 && query.length <= GREP_QUERY_MAX;
  }

  /**
   * Live grep's query against this document (docs/specs/live-grep.md): its matches with their
   * line of context. The parent checks the reply (core parseGrepReply).
   * @param {{ query: string, gen: number }} data
   */
  async search(data) {
    if (!this.#isQuery(data?.query) || !isIndex(data.gen)) return null;
    // An older search that was queued behind a newer one is dropped unrun.
    if (data.gen < this.#matcher.gen) return null;
    this.#matcher.gen = data.gen;
    const parsed = parseQuery(data.query);
    const model = this.#grepModel();
    if (!parsed || !model) return { count: 0, matches: [] };
    if (!NOT_BLANK.test(model.text)) return { count: 0, matches: [], cut: model.cut };
    const result = await GrepMatcher.match(this.#matcher.key, model, data.query, false);
    if (result === "timeout") return { count: 0, matches: [], timedOut: true, cut: model.cut };
    if (!result) return null;
    return { ...result, cut: model.cut };
  }

  /**
   * The lines around a match of the last search, for the preview (decision 6).
   * @param {{ start: number, end: number }} data
   */
  preview(data) {
    const model = this.#grep.model ?? this.#grepModel();
    if (!model || !isIndex(data?.start) || !isIndex(data?.end)) return null;
    const { start, end } = data;
    if (end < start || end > model.text.length) return null;
    return previewLines(model.text, start, end);
  }

  /**
   * Selects a match and scrolls it to the middle as find does (decision 7). When the document
   * changed since the search, the query runs again and the match with the same ordinal and
   * text is taken, else the nearest one with the same text.
   * @param {{ query: string, start: number, end: number, ordinal: number, text: string }} data
   * @returns {Promise<boolean>} whether a match is selected
   */
  async jump(data) {
    const win = this.#actor.contentWindow;
    if (!win || !this.#isQuery(data?.query) || typeof data.text !== "string") return false;
    if (!isIndex(data.start) || !isIndex(data.end) || !isIndex(data.ordinal)) return false;
    const parsed = parseQuery(data.query);
    if (!parsed) return false;
    const fresh = !!this.#grep.model && !this.#grep.stale;
    const model = this.#grepModel();
    if (!model) return false;
    let { start, end } = data;
    if (!fresh || model.text.slice(start, end) !== data.text) {
      const result = await GrepMatcher.match(this.#matcher.key, model, data.query, true);
      if (!result || result === "timeout") return false;
      /** @type {{ start: number, end: number, ordinal: number }[]} */
      const all = result.matches.filter(
        (/** @type {{ start: number, end: number }} */ m) =>
          model.text.slice(m.start, m.end) === data.text,
      );
      const same = all.find((m) => m.ordinal === data.ordinal);
      const near = all.reduce(
        (best, m) =>
          !best || Math.abs(m.ordinal - data.ordinal) < Math.abs(best.ordinal - data.ordinal)
            ? m
            : best,
        /** @type {(typeof all)[number] | null} */ (null),
      );
      const pick = same ?? near;
      if (!pick) return false;
      ({ start, end } = pick);
    }
    const a = model.pointAt(start);
    const b = model.pointAt(end, true);
    if (!a || !b) return false;
    const doc = this.#actor.document;
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    // Normal mode after the jump: a focused text field would keep the tab in insert.
    const active = this.#hooks.activeElement();
    if (active && active !== doc.body && this.#hooks.editable(active)) {
      /** @type {HTMLElement} */ (active).blur();
    }
    if (this.#actor.browsingContext.parent) win.focus();
    const sel = win.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    const selCon = this.#hooks.selCon();
    if (!selCon) return false;
    selCon.setDisplaySelection(DISPLAY_ATTENTION);
    selCon.repaintSelection(SELECTION_NORMAL);
    // After the next frame: a tab just selected gets its viewport's size first.
    await new Promise((resolve) => {
      const timer = win.setTimeout(resolve, 100);
      win.requestAnimationFrame(() => {
        win.clearTimeout(timer);
        resolve(undefined);
      });
    });
    if (!sel.rangeCount) return false;
    selCon.scrollSelectionIntoView(
      SELECTION_NORMAL,
      WHOLE_SELECTION,
      SCROLL_VERTICAL_CENTER | SCROLL_SYNCHRONOUS,
    );
    return true;
  }
}
