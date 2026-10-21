/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Element focus in one frame (spec: docs/specs/element-focus.md), for VimmaChild: the text
// block a label chose, the walks of `+`, `-`, `j` and `k`, `v`'s selection and `y`'s text, and
// the reports that keep the outline in the parent on the block. Nothing here changes the page
// until `v`: the block is kept in this actor, and the scroll and resize listeners are in the
// system group (`mozSystemGroup`), which the page cannot see or stop.

import {
  adjacentBlock,
  blockObject,
  childBlock,
  classifyBlock,
  needsBlockText,
  parentBlock,
} from "../core/blocks.mjs";
import { frameViewport, parentOf } from "./hint-collect.mjs";

/** @import { BlockDescriptor, BlockKind } from "../core/blocks.mjs" */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** A count above this is cut to it: each step walks the document. */
const MAX_COUNT = 100;
/** A `j` / `k` that lands on a block the page does not render tries again this often. */
const MAX_HIDDEN_RETRIES = 64;
/** NodeFilter.SHOW_TEXT (a system module has no NodeFilter global). */
const SHOW_TEXT = 0x4;
/** Range.START_TO_START and END_TO_END (a system module has no Range global). */
const START_TO_START = 0;
const END_TO_END = 2;
/** Listeners the page cannot see or stop: Gecko's system event group. */
const SYSTEM = /** @type {AddEventListenerOptions} */ ({ mozSystemGroup: true });
const SYSTEM_CAPTURE = /** @type {AddEventListenerOptions} */ ({
  mozSystemGroup: true,
  capture: true,
});
/** nsIDocumentEncoder flags: what Selection.toString skips, with LF line breaks. */
const ENCODER_FLAGS =
  Ci.nsIDocumentEncoder.SkipInvisibleContent | Ci.nsIDocumentEncoder.OutputLFLineBreak;

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/** A visible character. */
const VISIBLE = /\S/;

/**
 * One element as core blocks.mjs reads it (hint-collect.mjs's describe, without the viewport).
 * @param {Element} el
 * @param {Window} win
 * @param {{ display?: boolean, rendered?: boolean }} [read]  `display`: always read the
 *   computed display; `rendered`: say whether the page renders the element, as `onScreen`
 * @returns {BlockDescriptor}
 */
function describe(el, win, read = {}) {
  const role = el.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase() || undefined;
  /** @type {BlockDescriptor} */
  const d = {
    parent: -1,
    tag: el.localName,
    role,
    hidden: el.hasAttribute("hidden"),
    ariaHidden: el.getAttribute("aria-hidden") === "true",
    editable: /** @type {HTMLElement} */ (el).isContentEditable === true,
    host: el.parentNode?.nodeType === 11,
    directText: hasDirectText(el),
  };
  const candidate = needsBlockText(d) || d.directText;
  if (candidate) d.text = d.directText || hasText(el);
  if (read.display || d.directText || role === "code") {
    d.display = win.getComputedStyle(el)?.display;
  }
  if (read.rendered) d.onScreen = candidate;
  return d;
}

/** @param {Element} el */
function hasDirectText(el) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && VISIBLE.test(/** @type {Text} */ (n).data)) return true;
  }
  return false;
}

/** @param {Element} el */
function hasText(el) {
  const walker = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (VISIBLE.test(/** @type {Text} */ (n).data)) return true;
  }
  return false;
}

/**
 * The element's children in the flat tree: a shadow host's shadow root's, a slot's assigned
 * elements, else its own. Open and closed shadow roots alike (the actor is privileged).
 * @param {Element} el
 * @returns {Iterable<Element>}
 */
function flatChildren(el) {
  const root = /** @type {any} */ (el).openOrClosedShadowRoot;
  if (root) return root.children;
  if (el.localName === "slot") {
    const assigned = /** @type {HTMLSlotElement} */ (el).assignedElements();
    if (assigned.length) return assigned;
  }
  return el.children;
}

/**
 * How many characters of text the element holds, its shadow trees included: what `+` compares.
 * @param {Element} el
 */
function textLength(el) {
  let n = 0;
  const stack = [el];
  while (stack.length) {
    const e = /** @type {Element} */ (stack.pop());
    const root = /** @type {any} */ (e).openOrClosedShadowRoot;
    for (let c = (root ?? e).firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) n += /** @type {Text} */ (c).data.trim().length;
      else if (c.nodeType === 1) stack.push(/** @type {Element} */ (c));
    }
  }
  return n;
}

/**
 * Descriptors for a list of elements in document order, ancestors first, with parent links.
 * @param {Element[]} elements
 * @param {(el: Element) => BlockDescriptor} read
 * @param {(el: Element) => Element | null} up
 */
function descriptors(elements, read, up) {
  /** @type {Map<Element, number>} */
  const index = new Map();
  return elements.map((el, i) => {
    const d = read(el);
    const p = up(el);
    d.parent = p ? (index.get(p) ?? -1) : -1;
    index.set(el, i);
    return d;
  });
}

/**
 * The flat tree under `root` in document order (each element before its children), with each
 * element's flat-tree parent.
 * @param {Element} root
 */
function flatTree(root) {
  /** @type {Element[]} */
  const out = [];
  /** @type {Map<Element, Element>} */
  const parents = new Map();
  /** @type {Element[]} */
  const stack = [root];
  while (stack.length) {
    const el = /** @type {Element} */ (stack.pop());
    out.push(el);
    const children = [...flatChildren(el)];
    for (let i = children.length - 1; i >= 0; i--) {
      const c = /** @type {Element} */ (children[i]);
      parents.set(c, el);
      stack.push(c);
    }
  }
  return { elements: out, parentOf: (/** @type {Element} */ el) => parents.get(el) ?? null };
}

/**
 * The block's kind, as its label said; an element `+` reached that is no block by itself
 * (a list, a section) is a "block".
 * @param {Element} el
 * @param {Window} win
 * @returns {BlockKind}
 */
function kindOf(el, win) {
  return classifyBlock(describe(el, win)) ?? "block";
}

/**
 * Where white space in a text node's element is shown as typed: in `pre` and code blocks it is
 * part of the text, elsewhere it collapses and is not.
 * @param {Text} node
 * @param {Window} win
 * @returns {"collapse" | "breaks" | "preserve"}
 */
function whiteSpace(node, win) {
  const parent = node.parentElement;
  const value = parent ? win.getComputedStyle(parent)?.whiteSpaceCollapse : "collapse";
  if (value === "preserve-breaks") return "breaks";
  return !value || value === "collapse" ? "collapse" : "preserve";
}

/**
 * Whether any text between two points shows on the page: white space the page collapses (the
 * line breaks and indentation of a page's source around a paragraph's text) does not.
 * @param {{ node: Node, offset: number }} a
 * @param {{ node: Node, offset: number }} b
 * @param {Window} win
 */
export function drawnBetween(a, b, win) {
  const doc = a.node.ownerDocument;
  if (!doc) return false;
  const range = doc.createRange();
  range.setStart(a.node, a.offset);
  if (range.comparePoint(b.node, b.offset) < 0) range.setStart(b.node, b.offset);
  else range.setEnd(b.node, b.offset);
  if (range.collapsed) return false;
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let n = root.nodeType === 3 ? root : walker.nextNode(); n; n = walker.nextNode()) {
    const node = /** @type {Text} */ (n);
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    const part = node.data.slice(start, end);
    const ws = whiteSpace(node, win);
    if (ws === "preserve" ? part.length > 0 : (ws === "breaks" ? /[^ \t]/ : VISIBLE).test(part)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a text node is drawn and the page lets it be selected: a range that starts or ends
 * in a `user-select: none` part (a line-number gutter) would carry that part into the copy, as
 * the encoder serializes a boundary node whole.
 * @param {Text} node
 * @param {Element} block
 * @param {Window} win
 */
function selectableText(node, block, win) {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  if (!range.getClientRects().length) return false;
  for (let e = node.parentElement; e; e = e.parentElement) {
    if (win.getComputedStyle(e)?.userSelect === "none") return false;
    if (e === block) break;
  }
  return true;
}

/**
 * The block's text from its first to its last rendered character (decision 8): a range from
 * `selectNodeContents`, with the collapsed white space at both ends left out, so the caret does
 * not sit in it, and, where white space shows as typed, only the one newline that ends the
 * block. Its ends are in text the page lets be selected. `v` selects this range and `y`
 * serializes it, so both give the same text.
 * @param {Element} el
 * @param {Window} win
 */
export function blockRange(el, win) {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(el);
  /** @type {Text[]} */
  const texts = [];
  const walker = doc.createTreeWalker(el, SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(/** @type {Text} */ (n));
  for (const node of texts) {
    if (!node.data || !selectableText(node, el, win)) continue;
    const ws = whiteSpace(node, win);
    const at = ws === "preserve" ? 0 : node.data.search(ws === "breaks" ? /[^ \t]/ : VISIBLE);
    if (at < 0) continue;
    range.setStart(node, at);
    break;
  }
  // Only the one newline that ends a preformatted block, however its text nodes are split.
  let newline = true;
  for (let i = texts.length - 1; i >= 0; i--) {
    const node = /** @type {Text} */ (texts[i]);
    if (!node.data || !selectableText(node, el, win)) continue;
    const ws = whiteSpace(node, win);
    let end = node.data.length;
    if (ws === "preserve") {
      if (newline && node.data.endsWith("\n")) end -= 1;
      newline = false;
    } else {
      const keep = ws === "breaks" ? /[^ \t]/ : VISIBLE;
      while (end > 0 && !keep.test(/** @type {string} */ (node.data[end - 1]))) end--;
    }
    if (end === 0) continue;
    if (range.comparePoint(node, end) < 0) break;
    range.setEnd(node, end);
    break;
  }
  return range;
}

/**
 * The block's text as `y` copies it (decision 9): the range serialized by the plain-text
 * encoder Selection.toString uses, so `user-select: none` parts (a code block's line numbers)
 * are left out and code keeps its white space. A block the page marks unselectable as a whole
 * copies its rendered text anyway: the reader chose it with a key. `format` is the encoder's
 * type, so a Markdown flavour later is one argument (decision 10).
 * @param {Range} range
 * @param {Element} el  the block
 * @param {string} [format]
 * @returns {{ text: string, unselectable: boolean }}
 */
export function blockText(range, el, format = "text/plain") {
  const encoder = Cu.createDocumentEncoder(format);
  encoder.init(el.ownerDocument, format, ENCODER_FLAGS);
  encoder.setRange(range);
  const text = encoder.encodeToString();
  if (text) return { text, unselectable: false };
  const shown = /** @type {HTMLElement} */ (el).innerText?.trim() ?? "";
  return { text: shown, unselectable: shown !== "" };
}

/**
 * `el` and its ancestors up to the root, stepping out of shadow roots, described for `+` and
 * `ip` / `ap`: root first, `el` last.
 * @param {Element} el
 * @param {Window} win
 */
function ancestry(el, win) {
  /** @type {Element[]} */
  const chain = [];
  for (let e = /** @type {Element | null} */ (el); e; e = parentOf(e)) chain.unshift(e);
  const descs = descriptors(
    chain,
    (e) => {
      const d = describe(e, win, { display: true });
      if (e.localName !== "body" && e.localName !== "html") d.textLength = textLength(e);
      return d;
    },
    parentOf,
  );
  return { chain, descs };
}

/**
 * `ip` / `ap` in copy mode (decision 11): the range `v` from element focus would select for the
 * block around `node`, the selection's focus; with `around`, grown to the parent block while
 * `selected` already holds all of it (core blockObject). Null where no block is around it.
 * @param {Node} node
 * @param {Window} win
 * @param {boolean} around
 * @param {Range | null} selected  the selection's range
 * @returns {Range | null}
 */
export function blockRangeAt(node, win, around, selected) {
  const el = node.nodeType === 1 ? /** @type {Element} */ (node) : parentOf(node);
  if (!el) return null;
  const { chain, descs } = ancestry(el, win);
  /** @type {Map<number, Range>} */
  const ranges = new Map();
  const rangeOf = (/** @type {number} */ i) => {
    let r = ranges.get(i);
    if (!r) ranges.set(i, (r = blockRange(/** @type {Element} */ (chain[i]), win)));
    return r;
  };
  const covers = (/** @type {number} */ i) => {
    if (!selected) return false;
    const r = rangeOf(i);
    try {
      return (
        selected.compareBoundaryPoints(START_TO_START, r) <= 0 &&
        selected.compareBoundaryPoints(END_TO_END, r) >= 0
      );
    } catch {
      return false; // the ends are in different trees (a shadow root): not the same block
    }
  };
  const block = blockObject(descs, chain.length - 1, around, covers);
  return block < 0 ? null : rangeOf(block);
}

/** @param {Element} el */
function boxOf(el) {
  const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** @param {Element} el */
function onScreen(el) {
  const win = el.ownerGlobal;
  const b = el.getBoundingClientRect();
  return !!win && b.bottom > 0 && b.top < win.innerHeight && b.width > 0 && b.height > 0;
}

/**
 * The context VimmaChild gives an op.
 * @typedef {object} BlockContext
 * @property {(gen: number, id: number) => Element | null} take  a target of the last hint
 *   collection, by its generation and id; the collection is spent
 * @property {(line: boolean) => boolean} enterCopyMode  copy mode with the selection as it is,
 *   line-wise for `V`
 * @property {(name: string, data: object) => void} send  a message to the parent
 */

/** One frame's element focus. */
export class BlockFocus {
  /**
   * The focused block of this frame and the generation it was chosen in; `trail`: the blocks
   * `+` came from, for `-`.
   * @type {{ gen: number, el: WeakRef<Element>, trail: WeakRef<Element>[] } | null}
   */
  #block = null;
  /** @type {{ gen: number, win: Window, listener: (e: Event) => void, frame: number } | null} */
  #track = null;

  /**
   * Runs a `Vimma:Block` message; null for anything malformed, stale or not this frame's.
   * The replies are checked in the parent (core parseBlockReply).
   * @param {Window} win
   * @param {any} data
   * @param {BlockContext} ctx
   * @returns {object | null}
   */
  run(win, data, ctx) {
    const gen = data?.gen;
    const op = data?.op;
    if (!isIndex(gen) || typeof op !== "string") return null;
    const count = isIndex(data.count) && data.count > 0 ? Math.min(data.count, MAX_COUNT) : 1;
    switch (op) {
      case "focus": {
        if (!isIndex(data.id)) return null;
        const el = ctx.take(gen, data.id);
        if (!el?.isConnected) return null;
        this.#block = { gen, el: new WeakRef(el), trail: [] };
        this.#watch(win, gen, ctx);
        return this.#moved(el, win);
      }
      case "track":
        this.#watch(win, gen, ctx);
        return null;
      case "blur":
        if (this.#track?.gen === gen) this.#unwatch();
        if (this.#block?.gen === gen) this.#block = null;
        return null;
      case "frame":
        return this.#track?.gen === gen ? this.#frameRect(win, data.id) : null;
    }
    const block = this.#block;
    const el = block?.gen === gen ? block.el.deref() : undefined;
    if (!block || !el?.isConnected) return null;
    switch (op) {
      case "rect":
        return { box: boxOf(el) };
      case "parent":
      case "child":
      case "next":
      case "prev": {
        let at = el;
        for (let i = 0; i < count; i++) {
          const next = this.#step(op, at, win, block.trail);
          if (!next) break;
          at = next;
        }
        if (at === el) return null;
        if (op === "next" || op === "prev") {
          block.trail = [];
          at.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        }
        block.el = new WeakRef(at);
        return this.#moved(at, win);
      }
      case "yank":
        return blockText(blockRange(el, win), el);
      case "select":
        return this.#select(el, win, data.line === true, ctx);
    }
    return null;
  }

  /**
   * @param {Element} el
   * @param {Window} win
   */
  #moved(el, win) {
    const { text } = blockText(blockRange(el, win), el);
    return { kind: kindOf(el, win), length: [...text].length, box: boxOf(el) };
  }

  /**
   * One step of `+`, `-`, `j` or `k` from `el`, or null where there is none.
   * @param {string} op
   * @param {Element} el
   * @param {Window} win
   * @param {WeakRef<Element>[]} trail
   * @returns {Element | null}
   */
  #step(op, el, win, trail) {
    if (op === "parent") {
      const { chain, descs } = ancestry(el, win);
      const up = parentBlock(descs, chain.length - 1);
      if (up < 0) return null;
      trail.push(new WeakRef(el));
      return chain[up] ?? null;
    }
    if (op === "child") {
      const back = trail.pop()?.deref();
      if (back?.isConnected && el.contains(back)) return back;
      const { elements, parentOf: up } = flatTree(el);
      const descs = descriptors(elements, (e) => describe(e, win), up);
      const down = childBlock(descs, 0);
      return down > 0 ? (elements[down] ?? null) : null;
    }
    const root = el.ownerDocument.documentElement;
    if (!root) return null;
    const { elements, parentOf: up } = flatTree(root);
    const descs = descriptors(elements, (e) => describe(e, win, { rendered: true }), up);
    const from = elements.indexOf(el);
    // `onScreen` is "could be rendered" until a block is picked; one the page hides is marked
    // and stepped over.
    for (let i = 0; i < MAX_HIDDEN_RETRIES; i++) {
      const to = adjacentBlock(descs, from, op === "next" ? 1 : -1);
      const found = to >= 0 ? elements[to] : undefined;
      if (!found) return null;
      if (found.checkVisibility({ visibilityProperty: true })) return found;
      /** @type {BlockDescriptor} */ (descs[to]).onScreen = false;
    }
    return null;
  }

  /**
   * `v` / `V`: the block's text selected, anchor at its start and focus at its end, then copy
   * mode with that selection. In a frame, the frame takes focus first: copy mode lives in the
   * focused frame.
   * @param {Element} el
   * @param {Window} win
   * @param {boolean} line
   * @param {BlockContext} ctx
   */
  #select(el, win, line, ctx) {
    if (!onScreen(el)) el.scrollIntoView({ block: "nearest", behavior: "instant" });
    if (win !== win.top) win.focus();
    const range = blockRange(el, win);
    const sel = win.getSelection();
    if (!sel) return null;
    sel.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    );
    const unselectable = !sel.toString() && blockText(range, el).unselectable;
    if (!ctx.enterCopyMode(line)) return null;
    return { unselectable };
  }

  /**
   * The viewport of this document's subframe `id`, in this frame's CSS pixels.
   * @param {Window} win
   * @param {unknown} id
   */
  #frameRect(win, id) {
    if (!isIndex(id)) return null;
    const child = BrowsingContext.get(id);
    const el = child?.embedderElement;
    if (!el || el.ownerDocument !== win.document) return null;
    const rect = frameViewport(win, el);
    return rect ? { rect } : null;
  }

  /**
   * Reports this window's scrolls and resizes, at most once per frame, while the block (or a
   * block in a subframe of it) is focused; and the page going away.
   * @param {Window} win
   * @param {number} gen
   * @param {BlockContext} ctx
   */
  #watch(win, gen, ctx) {
    if (this.#track?.gen === gen && this.#track.win === win) return;
    this.#unwatch();
    /** @type {(e: Event) => void} */
    const listener = (e) => {
      const track = this.#track;
      if (!track || track.listener !== listener) return;
      if (e.type === "pagehide") {
        this.#unwatch();
        this.#block = null;
        ctx.send("Vimma:BlockGone", { gen });
        return;
      }
      if (track.frame) return;
      track.frame = win.requestAnimationFrame(() => {
        if (this.#track !== track) return;
        track.frame = 0;
        ctx.send("Vimma:BlockMoved", { gen });
      });
    };
    // Capture, so a scroller inside the page is heard too (scroll does not bubble).
    win.addEventListener("scroll", listener, SYSTEM_CAPTURE);
    win.addEventListener("resize", listener, SYSTEM);
    win.addEventListener("pagehide", listener, SYSTEM);
    this.#track = { gen, win, listener, frame: 0 };
  }

  #unwatch() {
    const track = this.#track;
    if (!track) return;
    this.#track = null;
    try {
      if (track.frame) track.win.cancelAnimationFrame(track.frame);
      track.win.removeEventListener("scroll", track.listener, SYSTEM_CAPTURE);
      track.win.removeEventListener("resize", track.listener, SYSTEM);
      track.win.removeEventListener("pagehide", track.listener, SYSTEM);
    } catch {
      // the window is gone with its listeners
    }
  }

  /** The actor is going away. */
  destroy() {
    this.#unwatch();
    this.#block = null;
  }
}
