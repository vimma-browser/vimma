/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The text around the caret as one string, for copy mode's Vim motions (core motions.mjs; spec:
// docs/specs/m1-copy-mode.md § Settled). Each rendered text node is copied in document order with
// its length kept, so a string index maps back to a node and offset; a block boundary adds BLOCK
// and a <br> "\n" between nodes. Collapsible white space (not `pre`) has its line breaks and tabs
// turned into spaces, as layout shows them.

import { BLOCK } from "../core/motions.mjs";

/** NodeFilter values (a system module has no NodeFilter global). */
const SHOW_ELEMENT = 0x1;
const SHOW_TEXT = 0x4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

/** Subtrees whose text is never the page's visible text. */
const SKIP = new Set(["script", "style", "noscript", "template", "select", "textarea", "head"]);

/**
 * A text node's place in the string. `map`, when white space was collapsed in it: the node
 * offset of each character of its part of the string, and of its end.
 * @typedef {{ node: Text, start: number, end: number, map?: Int32Array }} Segment
 */
/** @typedef {{ node: Node, offset: number }} Point */

/**
 * The flattened text and the way back to the DOM.
 * @typedef {object} TextModel
 * @property {string} text
 * @property {number} at  the caret's index in `text`
 * @property {(i: number, after?: boolean) => Point | null} pointAt  a string index as a DOM
 *   point; `after` prefers the end of the node before it over the start of the one after */

/**
 * The text node a caret at (node, offset) sits in or just before, and the offset in it.
 * @param {Document} doc
 * @param {Node} node
 * @param {number} offset
 * @returns {{ text: Text, offset: number } | null}
 */
function textPoint(doc, node, offset) {
  if (node.nodeType === 3) return { text: /** @type {Text} */ (node), offset };
  const walker = doc.createTreeWalker(doc.documentElement, SHOW_TEXT);
  const child = node.childNodes[offset];
  if (child) {
    // The first text node at or after the child, else the last one before it.
    walker.currentNode = child;
    const at = child.nodeType === 3 ? child : walker.nextNode();
    if (at) return { text: /** @type {Text} */ (at), offset: 0 };
    walker.currentNode = child;
  } else {
    // After the last child: the node's last text, else the last one before it.
    let last = node;
    while (last.lastChild) last = last.lastChild;
    walker.currentNode = last;
    if (last.nodeType === 3) {
      const t = /** @type {Text} */ (last);
      return { text: t, offset: t.length };
    }
  }
  const before = walker.previousNode();
  return before
    ? { text: /** @type {Text} */ (before), offset: before.nodeValue?.length ?? 0 }
    : null;
}

/**
 * Builds the model around the caret: about `reach` characters each way.
 * @param {Window} win
 * @param {Node} node  the caret's node
 * @param {number} offset
 * @param {number} reach
 * @returns {TextModel | null}
 */
export function textAround(win, node, offset, reach) {
  const doc = win.document;
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  const start = textPoint(doc, node, offset);
  if (!start) return null;
  const filter = {
    /** @param {Node} n */
    acceptNode(n) {
      if (n.nodeType !== 1) return FILTER_ACCEPT;
      const el = /** @type {Element} */ (n);
      if (SKIP.has(el.localName)) return FILTER_REJECT;
      return el.checkVisibility() ? FILTER_ACCEPT : FILTER_REJECT;
    },
  };
  /** @type {(Text | "br")[]} */
  const after = [];
  /** @type {(Text | "br")[]} */
  const before = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT | SHOW_ELEMENT, filter);
  const collect = (/** @type {(Text | "br")[]} */ into, /** @type {boolean} */ forward) => {
    walker.currentNode = start.text;
    let chars = 0;
    for (let n = forward ? walker.nextNode() : walker.previousNode(); n && chars < reach;) {
      if (n.nodeType === 3) {
        into.push(/** @type {Text} */ (n));
        chars += n.nodeValue?.length ?? 0;
      } else if (/** @type {Element} */ (n).localName === "br") into.push("br");
      n = forward ? walker.nextNode() : walker.previousNode();
    }
  };
  collect(after, true);
  collect(before, false);
  const items = [...before.reverse(), start.text, ...after];

  const { text, segments, pointAt } = build(win, items);
  const own = /** @type {Segment} */ (segments.find((s) => s.node === start.text));
  return { text, at: own.start + Math.min(start.offset, own.end - own.start), pointAt };
}

/**
 * The element a node is rendered in: its flat-tree parent (a slotted node's slot, a shadow
 * root's host), else its parent element.
 * @param {Node} n
 * @returns {Element | null}
 */
function renderedParent(n) {
  const p = /** @type {any} */ (n).flattenedTreeParentNode ?? n.parentElement;
  return p?.nodeType === 1 ? p : null;
}

/**
 * Text nodes and line breaks, in document order, as one string with the way back to the DOM.
 * `collapseRuns`: runs of collapsible white space become one space, and none at a line's start,
 * as layout shows them (live grep: a query with one space finds text the markup wraps).
 * @param {Window} win
 * @param {(Text | "br")[]} items
 * @param {boolean} [collapseRuns]
 * @returns {{ text: string, segments: Segment[],
 *   pointAt: (i: number, after?: boolean) => Point | null }}
 */
function build(win, items, collapseRuns = false) {
  /** @type {Map<Element, boolean>} */
  const blocky = new Map();
  /** @type {(el: Element) => boolean} */
  const isBlock = (el) => {
    let b = blocky.get(el);
    if (b === undefined) {
      const display = win.getComputedStyle(el)?.display ?? "inline";
      b = !(display === "inline" || display === "contents" || display.startsWith("ruby"));
      blocky.set(el, b);
    }
    return b;
  };
  /** @type {(t: Text) => Element | null} */
  const blockOf = (t) => {
    for (let el = renderedParent(t); el; el = renderedParent(el)) if (isBlock(el)) return el;
    return null;
  };
  /** @type {Map<Element, string | undefined>} */
  const collapses = new Map();
  /** @type {(el: Element) => string | undefined} */
  const collapseOf = (el) => {
    if (!collapses.has(el)) collapses.set(el, win.getComputedStyle(el)?.whiteSpaceCollapse);
    return collapses.get(el);
  };
  let text = "";
  /** @type {Segment[]} */
  const segments = [];
  /** @type {Element | null | undefined} */
  let block;
  let pendingBreak = false;
  for (const item of items) {
    if (item === "br") {
      pendingBreak = true;
      continue;
    }
    const b = blockOf(item);
    if (block !== undefined && b !== block) text += BLOCK;
    else if (pendingBreak) text += "\n";
    pendingBreak = false;
    block = b;
    const parent = renderedParent(item);
    const collapse = parent ? collapseOf(parent) : "collapse";
    let value = item.nodeValue ?? "";
    const collapsible = collapse === "collapse" || collapse === undefined;
    if (collapsible && collapseRuns) {
      const raw = value;
      const last = text.charCodeAt(text.length - 1);
      // At a line's start (the string's, after a break) or after a space: no space.
      let afterSpace = !text.length || last === 0x20 || last === 0x0a || last === 0x2029;
      let out = "";
      /** @type {number[]} */
      const map = [];
      for (let k = 0; k < raw.length; k++) {
        const c = /** @type {string} */ (raw[k]);
        const space = c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
        if (space && afterSpace) continue;
        out += space ? " " : c;
        map.push(k);
        afterSpace = space;
      }
      map.push(raw.length);
      const start = text.length;
      /** @type {Segment} */
      const seg = { node: item, start, end: start + out.length };
      if (out.length !== raw.length) seg.map = Int32Array.from(map);
      segments.push(seg);
      text += out;
      continue;
    }
    if (collapsible) value = value.replace(/[\n\r\t]/g, " ");
    else if (collapse === "preserve-breaks") value = value.replace(/\t/g, " ");
    segments.push({ node: item, start: text.length, end: text.length + value.length });
    text += value;
  }
  /** @type {(i: number, preferAfter?: boolean) => Point | null} */
  const pointAt = (i, preferAfter = false) => {
    // Binary search: the first segment that ends at or after i (after `i` for preferAfter).
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = /** @type {Segment} */ (segments[mid]);
      if (preferAfter ? s.end < i : s.end <= i) lo = mid + 1;
      else hi = mid;
    }
    // A position between nodes (at a block boundary): the next node's start, else the end.
    const hit = segments[lo] ?? segments.at(-1);
    if (!hit) return null;
    const k = Math.max(0, Math.min(i, hit.end) - hit.start);
    return { node: hit.node, offset: hit.map ? /** @type {number} */ (hit.map[k]) : k };
  };
  return { text, segments, pointAt };
}

/**
 * The whole rendered text of a document for live grep (docs/specs/live-grep.md decision 12):
 * text nodes in flat-tree order, through open and closed shadow roots and slots, skipping
 * SKIP elements and those that fail checkVisibility(); cut once it reaches `cap` characters.
 * @param {Window} win
 * @param {number} cap
 * @returns {(TextModel & { cut: boolean }) | null}
 */
export function textOfDocument(win, cap) {
  const doc = win.document;
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  /** @type {(Text | "br")[]} */
  const items = [];
  let chars = 0;
  let cut = false;
  /** @type {Node[]} nodes to visit, the next one last */
  const stack = [root];
  while (stack.length) {
    const n = /** @type {Node} */ (stack.pop());
    if (n.nodeType === 3) {
      items.push(/** @type {Text} */ (n));
      chars += n.nodeValue?.length ?? 0;
      if (chars >= cap) {
        cut = true;
        break;
      }
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = /** @type {Element} */ (n);
    if (SKIP.has(el.localName) || !el.checkVisibility()) continue;
    if (el.localName === "br") {
      items.push("br");
      continue;
    }
    const shadow = el.openOrClosedShadowRoot;
    /** @type {ArrayLike<Node>} */
    let kids = shadow ? shadow.childNodes : el.childNodes;
    if (!shadow && el.localName === "slot") {
      const assigned = /** @type {HTMLSlotElement} */ (el).assignedNodes();
      if (assigned.length) kids = assigned;
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(/** @type {Node} */ (kids[i]));
  }
  const { text, pointAt } = build(win, items, true);
  return { text: cut ? text.slice(0, cap) : text, at: 0, pointAt, cut };
}
