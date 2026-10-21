/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Text blocks for element focus (docs/specs/element-focus.md, decision 3): which elements are
 * paragraphs, headings, list items, quotes, code blocks, cells and captions, which of them get a
 * label, and the walks of `+` and `-`. The content child describes elements; this module
 * decides, so the rules are tested without Firefox.
 */

/**
 * One element as the child sees it. `parent` is the index of its parent element's descriptor
 * in the same list (-1 for none); the list is in document order, ancestors first.
 * @typedef {object} BlockDescriptor
 * @property {number} parent
 * @property {string} tag  localName
 * @property {string} [role]  the `role` attribute
 * @property {string} [display]  computed `display`, where `needsBlockText` asked for it
 * @property {boolean} [hidden]  the `hidden` attribute
 * @property {boolean} [ariaHidden]  `aria-hidden="true"`
 * @property {boolean} [editable]  inside or the host of a contenteditable region
 * @property {boolean} [directText]  a direct text child with a visible character
 * @property {boolean} [text]  visible text anywhere inside
 * @property {boolean} [host]  the step to `parent` leaves a shadow root for its host
 * @property {boolean} [onScreen]  has a box in the viewport: only these get labels
 * @property {number} [textLength]  for the walks: the length of its text
 */

/** @typedef {"paragraph" | "heading" | "list item" | "quote" | "code" | "cell" | "caption" | "block"} BlockKind */

/** @type {readonly BlockKind[]} */
export const BLOCK_KINDS = Object.freeze([
  "paragraph",
  "heading",
  "list item",
  "quote",
  "code",
  "cell",
  "caption",
  "block",
]);

/** @type {ReadonlyMap<string, BlockKind>} */
const BY_TAG = new Map([
  ["p", "paragraph"],
  ...["h1", "h2", "h3", "h4", "h5", "h6"].map(
    (h) => /** @type {[string, BlockKind]} */ ([h, "heading"]),
  ),
  ["li", "list item"],
  ["dt", "list item"],
  ["dd", "list item"],
  ["blockquote", "quote"],
  ["pre", "code"],
  ["figcaption", "caption"],
  ["caption", "caption"],
  ["td", "cell"],
  ["th", "cell"],
  ["summary", "block"],
  ["address", "block"],
]);

/** @type {ReadonlyMap<string, BlockKind>} */
const BY_ROLE = new Map([
  ["paragraph", "paragraph"],
  ["heading", "heading"],
  ["listitem", "list item"],
  ["blockquote", "quote"],
  ["code", "code"],
  ["cell", "cell"],
  ["gridcell", "cell"],
  ["rowheader", "cell"],
  ["columnheader", "cell"],
  ["caption", "caption"],
  ["note", "block"],
]);

/**
 * Never a block, and nothing inside them is one: controls and fields have text of their own
 * (insert mode and ctrl+c cover it), a frame's document is asked as a frame, and the others
 * hold no reading text.
 */
const NEVER_INSIDE = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "input",
  "select",
  "button",
  "option",
  "svg",
  "canvas",
  "iframe",
  "frame",
]);

/** Never a block themselves, but blocks may be inside them. Rows: one label per cell is many. */
const NEVER_SELF = new Set([
  "html",
  "body",
  "head",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "colgroup",
  "col",
]);

/** The text model's notion of a block (actors/text-model.mjs): not inline, contents or ruby. */
/** @param {string | undefined} display */
const blockLevel = (display) =>
  typeof display === "string" &&
  display !== "" &&
  display !== "inline" &&
  display !== "contents" &&
  display !== "none" &&
  !display.startsWith("ruby");

/** @param {BlockDescriptor} d */
const excludes = (d) =>
  NEVER_INSIDE.has(d.tag) || d.hidden === true || d.ariaHidden === true || d.editable === true;

/**
 * Whether the child has to read this element's text and display before `classifyBlock` can
 * decide: a tag or role block. A generic element needs `directText` first, and its display
 * only when it has one.
 * @param {BlockDescriptor} d
 */
export function needsBlockText(d) {
  if (excludes(d) || NEVER_SELF.has(d.tag)) return false;
  return BY_TAG.has(d.tag) || (d.role !== undefined && BY_ROLE.has(d.role));
}

/**
 * The kind of block this element is on its own, or null. Ancestors (exclusion, atomic code)
 * and descendants (innermost wins) are `pickBlocks`' part.
 * @param {BlockDescriptor} d
 * @returns {BlockKind | null}
 */
export function classifyBlock(d) {
  if (excludes(d) || NEVER_SELF.has(d.tag)) return null;
  const byTag = BY_TAG.get(d.tag);
  if (byTag) return d.text ? byTag : null;
  const byRole = d.role === undefined ? undefined : BY_ROLE.get(d.role);
  if (byRole) {
    // An inline role=code is a code span in a sentence, not a code block.
    if (byRole === "code" && !blockLevel(d.display)) return null;
    return d.text ? byRole : null;
  }
  if (d.directText && blockLevel(d.display)) return d.tag === "code" ? "code" : "block";
  return null;
}

/**
 * Code blocks and table captions are one block however they are built: a highlighter's
 * per-line `div`s give one label for the block, not one per line.
 * @param {BlockDescriptor} d
 * @param {BlockKind | null} kind
 */
const atomic = (d, kind) =>
  kind !== null && (kind === "code" || d.tag === "caption" || d.role === "caption");

/**
 * The blocks that get a label: on screen, not inside an excluded element or an atomic block,
 * and with no other such block inside them (innermost wins: an `li` holding two `p` gets two
 * labels, not three). In descriptor order.
 * @param {readonly BlockDescriptor[]} descs
 * @returns {{ index: number, kind: BlockKind }[]}
 */
export function pickBlocks(descs) {
  const n = descs.length;
  /** @type {(BlockKind | null)[]} */
  const kinds = new Array(n).fill(null);
  /** Excluded, or inside an excluded element or an atomic block. */
  const shut = new Array(n).fill(false);
  /** A valid parent link: earlier in the list, so no descriptor list can make a loop. */
  /** @param {number} i */
  const parentOf = (i) => {
    const p = /** @type {BlockDescriptor} */ (descs[i]).parent;
    return Number.isInteger(p) && p >= 0 && p < i ? p : -1;
  };
  for (let i = 0; i < n; i++) {
    const d = /** @type {BlockDescriptor} */ (descs[i]);
    const p = parentOf(i);
    const sealed =
      p >= 0 && (shut[p] || atomic(/** @type {BlockDescriptor} */ (descs[p]), kinds[p] ?? null));
    shut[i] = sealed || excludes(d);
    kinds[i] = sealed ? null : classifyBlock(d);
  }
  const eligible = (/** @type {number} */ i) =>
    kinds[i] !== null && !shut[i] && descs[i]?.onScreen === true;
  const hasInner = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!eligible(i)) continue;
    for (let p = parentOf(i); p >= 0 && !hasInner[p]; p = parentOf(p)) hasInner[p] = true;
  }
  /** @type {{ index: number, kind: BlockKind }[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    if (eligible(i) && !hasInner[i])
      out.push({ index: i, kind: /** @type {BlockKind} */ (kinds[i]) });
  }
  return out;
}

/**
 * `+`: the nearest block-level ancestor that holds more text than `index`, below `body`. A
 * shadow host is crossed only when it is block-level itself; `body` ends the walk, so in a
 * frame `+` never climbs into the parent document.
 * @param {readonly BlockDescriptor[]} descs
 * @param {number} index
 * @returns {number} the ancestor's index, or -1
 */
export function parentBlock(descs, index) {
  const start = descs[index];
  if (!start) return -1;
  const length = start.textLength ?? 0;
  let child = start;
  // A bound on the steps: a list from a content process could link in a circle.
  for (let steps = 0; steps < descs.length; steps++) {
    const p = child.parent;
    const up = p >= 0 ? descs[p] : undefined;
    if (!up || up.tag === "body" || up.tag === "html") return -1;
    const block = blockLevel(up.display) && !excludes(up);
    if (child.host && !block) return -1;
    if (block && (up.textLength ?? 0) > length) return p;
    child = up;
  }
  return -1;
}

/**
 * `-` when `+` left no way back: the first block inside `index`, in document order.
 * @param {readonly BlockDescriptor[]} descs
 * @param {number} index
 * @returns {number} the block's index, or -1
 */
export function childBlock(descs, index) {
  for (let i = index + 1; i < descs.length; i++) {
    if (!within(descs, i, index)) continue;
    if (classifyBlock(/** @type {BlockDescriptor} */ (descs[i])) !== null) return i;
  }
  return -1;
}

/**
 * @param {readonly BlockDescriptor[]} descs
 * @param {number} i
 * @param {number} ancestor
 */
function within(descs, i, ancestor) {
  for (let p = descs[i]?.parent ?? -1, steps = 0; p >= 0 && steps < descs.length; steps++) {
    if (p === ancestor) return true;
    p = descs[p]?.parent ?? -1;
  }
  return false;
}
