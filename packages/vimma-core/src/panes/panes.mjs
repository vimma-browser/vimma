/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The pane tree (spec m3-m4-core-models): an immutable tree of splits and leaves that the host
 * mirrors onto the split view, one `<browser>` per leaf. Every operation is pure and returns a new
 * frozen state; a no-op returns the input state itself (zoom included).
 */

/** @typedef {{ readonly type: "leaf", readonly pane: string, readonly tab: string }} Leaf */
/**
 * `axis: "x"` lays children out left → right, `"y"` top → bottom. ≥ 2 children, one ratio each,
 * ratios ≥ MIN_RATIO summing to 1, and no child split has its parent's axis (canonical form)
 * unless flattening it would push a pane below MIN_RATIO.
 * @typedef {{ readonly type: "split", readonly axis: Axis, readonly children: readonly PaneNode[],
 *   readonly ratios: readonly number[] }} Split
 */
/** @typedef {Leaf | Split} PaneNode */
/** @typedef {"x" | "y"} Axis */
/**
 * `mru` lists every pane, most recently focused first (`mru[0] === focus`); `next` mints pane ids.
 * `layout`, when set, is the last preset applied (layouts.mjs, docs/specs/tiling-layouts.md);
 * every operation here keeps it, as tmux keeps a window's last layout across manual changes.
 * `hidden`, when true, keeps the tree as a view that is not shown: another tab of the workspace
 * shows alone (docs/specs/side-panel-unsplit.md decision 20); every operation keeps it too.
 * @typedef {{ readonly root: PaneNode, readonly focus: string, readonly mru: readonly string[],
 *   readonly zoom: string | null, readonly next: number, readonly layout?: string,
 *   readonly hidden?: true }} Panes
 */
/** @typedef {"left" | "down" | "up" | "right"} Direction */
/** @typedef {"vertical" | "horizontal"} SplitDirection */
/** @typedef {"wider" | "narrower" | "taller" | "shorter"} ResizeDirection */
/** @typedef {{ x: number, y: number, width: number, height: number }} LayoutRect */
/** @typedef {{ pane: string, tab: string, rect: LayoutRect }} PaneRect */
/** @typedef {{ code: "no-space" | "max-panes", message: string }} SplitRefusal */
/**
 * `max`: the most live panes (leaves) a tree may have; a split past it is refused. Unbounded by
 * default; the host passes config `[panes] max` (default PANES_MAX_DEFAULT).
 * @typedef {{ max?: number }} SplitOptions
 */

/** Smallest share of a split a pane can have: splits and resizes never go below it. */
export const MIN_RATIO = 0.1;

/**
 * Default of config `[panes] max`. Eight, because four (Zen's `MAX_TABS`) leaves a large screen
 * half used; a small screen lowers it in config.toml.
 */
export const PANES_MAX_DEFAULT = 8;
/** Largest `[panes] max` the config accepts. */
export const PANES_MAX_LIMIT = 16;

export class PaneError extends Error {
  /**
   * @param {"unknown-pane" | "tab-shown" | "last-pane" | "bad-direction" | "bad-amount" |
   *   "bad-max" | "bad-tabs"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PaneError";
    this.code = code;
  }
}

/** @type {Record<SplitDirection, Axis>} */
const SPLIT_AXIS = { vertical: "x", horizontal: "y" };
/** @type {Record<ResizeDirection, [Axis, 1 | -1]>} */
const RESIZE = { wider: ["x", 1], narrower: ["x", -1], taller: ["y", 1], shorter: ["y", -1] };
const DIRECTIONS = ["left", "down", "up", "right"];
const EPS = 1e-9;
const UNIT = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

/**
 * @param {string} pane
 * @param {string} tab
 * @returns {Leaf}
 */
function leafNode(pane, tab) {
  return Object.freeze({ type: "leaf", pane, tab });
}

/**
 * Builds a split in canonical form: a single child is returned as is (sibling promotion) and
 * child splits on the same axis are flattened into this one, scaling their ratios, unless that
 * would push one of their panes below MIN_RATIO.
 * @param {Axis} axis
 * @param {readonly PaneNode[]} children
 * @param {readonly number[]} ratios
 * @returns {PaneNode}
 */
export function makeSplit(axis, children, ratios) {
  if (children.length === 1) return /** @type {PaneNode} */ (children[0]);
  /** @type {PaneNode[]} */
  const kids = [];
  /** @type {number[]} */
  const rs = [];
  children.forEach((c, i) => {
    const r = /** @type {number} */ (ratios[i]);
    if (
      c.type === "split" &&
      c.axis === axis &&
      c.ratios.every((cr) => cr * r >= MIN_RATIO - EPS)
    ) {
      kids.push(...c.children);
      rs.push(...c.ratios.map((cr) => cr * r));
    } else {
      kids.push(c);
      rs.push(r);
    }
  });
  return Object.freeze({
    type: "split",
    axis,
    children: Object.freeze(kids),
    ratios: Object.freeze(rs),
  });
}

/**
 * @param {Panes} s
 * @param {Partial<Panes>} changes
 * @returns {Panes}
 */
function update(s, changes) {
  return Object.freeze({ ...s, ...changes });
}

/**
 * Focuses `paneId` (moving it to the front of the MRU order) and clears the zoom.
 * @param {Panes} s
 * @param {string} paneId
 * @param {Partial<Panes>} [changes]
 * @returns {Panes}
 */
function focused(s, paneId, changes = {}) {
  const mru = Object.freeze([paneId, ...(changes.mru ?? s.mru).filter((p) => p !== paneId)]);
  return update(s, { ...changes, focus: paneId, mru, zoom: null });
}

/**
 * Child indices from the root to the leaf showing `paneId`, or null.
 * @param {PaneNode} node
 * @param {string} paneId
 * @returns {number[] | null}
 */
function pathTo(node, paneId) {
  if (node.type === "leaf") return node.pane === paneId ? [] : null;
  for (let i = 0; i < node.children.length; i++) {
    const p = pathTo(/** @type {PaneNode} */ (node.children[i]), paneId);
    if (p) return [i, ...p];
  }
  return null;
}

/**
 * @param {Panes} s
 * @param {string} paneId
 * @returns {number[]}
 */
function mustPath(s, paneId) {
  const p = pathTo(s.root, paneId);
  if (!p) throw new PaneError("unknown-pane", `no pane "${paneId}"`);
  return p;
}

/**
 * @param {PaneNode} node
 * @param {readonly number[]} path
 * @returns {PaneNode}
 */
function nodeAt(node, path) {
  let n = node;
  for (const i of path) n = /** @type {PaneNode} */ (/** @type {Split} */ (n).children[i]);
  return n;
}

/**
 * Replaces the node at `path`, rebuilding (and re-canonicalising) every ancestor.
 * @param {PaneNode} node
 * @param {readonly number[]} path
 * @param {PaneNode} replacement
 * @returns {PaneNode}
 */
function replaceAt(node, path, replacement) {
  if (path.length === 0) return replacement;
  const split = /** @type {Split} */ (node);
  const [i, ...rest] = path;
  const children = split.children.slice();
  children[/** @type {number} */ (i)] = replaceAt(
    /** @type {PaneNode} */ (children[/** @type {number} */ (i)]),
    rest,
    replacement,
  );
  return makeSplit(split.axis, children, split.ratios);
}

/**
 * @param {PaneNode} node
 * @returns {Leaf}
 */
function firstLeaf(node) {
  return node.type === "leaf" ? node : firstLeaf(/** @type {PaneNode} */ (node.children[0]));
}

/**
 * One pane, `p1`, showing `tabId`.
 * @param {string} tabId
 * @returns {Panes}
 */
export function createPanes(tabId) {
  return Object.freeze({
    root: leafNode("p1", tabId),
    focus: "p1",
    mru: Object.freeze(["p1"]),
    zoom: null,
    next: 2,
  });
}

/**
 * Shares for a row of `n` panes: `ratios` normalised to sum 1, any below MIN_RATIO raised to it
 * and the rest scaled down to make room; equal shares when `ratios` is missing or unusable.
 * @param {number} n
 * @param {readonly number[] | undefined} ratios
 * @returns {number[]}
 */
function rowShares(n, ratios) {
  const equal = Array.from({ length: n }, () => 1 / n);
  if (!ratios || ratios.length !== n || !ratios.every((r) => Number.isFinite(r) && r > 0)) {
    return equal;
  }
  const sum = ratios.reduce((a, b) => a + b, 0);
  let shares = ratios.map((r) => r / sum);
  // Each pass fixes at least one more share at MIN_RATIO, so n passes settle it.
  for (let pass = 0; pass < n; pass++) {
    const low = shares.map((r) => r < MIN_RATIO - EPS);
    if (!low.some(Boolean)) break;
    const free = shares.reduce((a, r, i) => (low[i] ? a : a + r), 0);
    const room = 1 - MIN_RATIO * low.filter(Boolean).length;
    shares = shares.map((r, i) => (low[i] ? MIN_RATIO : (r * room) / free));
  }
  return shares;
}

/**
 * Panes side by side, left → right, one per tab in `tabIds`: a split made outside Vimma (Firefox's
 * own split view lays its tabs out in a row) adopted as a tree. `ratios`: each pane's share, in
 * any unit (normalised, clamped at MIN_RATIO; unusable: equal shares). `focus`: the tab whose pane
 * has focus (default, or not in the row: the first).
 * @param {readonly string[]} tabIds
 * @param {{ ratios?: readonly number[], focus?: string }} [options]
 * @returns {Panes}
 */
export function createRow(tabIds, { ratios, focus: focusTab } = {}) {
  if (!tabIds.length) throw new PaneError("bad-tabs", "a row needs at least one tab");
  if (new Set(tabIds).size !== tabIds.length) {
    throw new PaneError("tab-shown", "a tab can be shown in one pane only");
  }
  if (tabIds.length === 1) return createPanes(/** @type {string} */ (tabIds[0]));
  const kids = tabIds.map((t, i) => leafNode(`p${i + 1}`, t));
  const root = makeSplit("x", kids, rowShares(kids.length, ratios));
  const focus = `p${Math.max(0, tabIds.indexOf(focusTab ?? "")) + 1}`;
  const mru = Object.freeze([focus, ...kids.map((k) => k.pane).filter((p) => p !== focus)]);
  return Object.freeze({ root, focus, mru, zoom: null, next: kids.length + 1 });
}

/**
 * Leaves in reading order.
 * @param {Panes} s
 * @returns {Leaf[]}
 */
export function leaves(s) {
  /** @type {Leaf[]} */
  const out = [];
  /** @param {PaneNode} n */
  const walk = (n) => (n.type === "leaf" ? out.push(n) : n.children.forEach(walk));
  walk(s.root);
  return out;
}

/**
 * @param {Panes} s
 * @param {string} tabId
 * @returns {string | undefined}
 */
export function paneOfTab(s, tabId) {
  return leaves(s).find((l) => l.tab === tabId)?.pane;
}

/**
 * @param {SplitDirection} direction
 * @returns {Axis}
 */
function splitAxis(direction) {
  const axis = SPLIT_AXIS[direction];
  if (!axis) throw new PaneError("bad-direction", `bad split direction "${direction}"`);
  return axis;
}

/**
 * @param {unknown} max
 * @returns {number}
 */
function checkMax(max) {
  if (max === Infinity || (Number.isInteger(max) && /** @type {number} */ (max) >= 1)) {
    return /** @type {number} */ (max);
  }
  throw new PaneError("bad-max", `max panes must be a positive integer, got ${String(max)}`);
}

/**
 * Why `split` would refuse, or null when it would not: `max-panes` when the tree already has
 * `max` leaves (checked first), `no-space` (tmux: "no space for new pane") when splitting along
 * the parent's axis would halve the pane's share below MIN_RATIO.
 * @param {Panes} s
 * @param {string} paneId
 * @param {SplitDirection} direction
 * @param {SplitOptions} [options]
 * @returns {SplitRefusal | null}
 */
export function splitRefusal(s, paneId, direction, { max = Infinity } = {}) {
  const axis = splitAxis(direction);
  const path = mustPath(s, paneId);
  const limit = checkMax(max);
  if (leaves(s).length >= limit) {
    return { code: "max-panes", message: `at most ${limit} pane${limit === 1 ? "" : "s"}` };
  }
  if (path.length === 0) return null;
  const parent = /** @type {Split} */ (nodeAt(s.root, path.slice(0, -1)));
  const share = /** @type {number} */ (parent.ratios[/** @type {number} */ (path.at(-1))]);
  return parent.axis === axis && share / 2 < MIN_RATIO - EPS
    ? { code: "no-space", message: `no space for a new pane next to ${paneId}` }
    : null;
}

/**
 * Splits `paneId`; the new pane shows `newTabId`, goes right after it and gets focus.
 * `vertical` = split right (`:vsplit`), `horizontal` = split down (`:split`). Returns the input
 * unchanged when `splitRefusal` gives a reason (`max` live panes, or no space).
 * @param {Panes} s
 * @param {string} paneId
 * @param {SplitDirection} direction
 * @param {string} newTabId
 * @param {SplitOptions} [options]
 * @returns {Panes}
 */
export function split(s, paneId, direction, newTabId, options = {}) {
  const axis = splitAxis(direction);
  const path = mustPath(s, paneId);
  if (paneOfTab(s, newTabId) !== undefined) {
    throw new PaneError("tab-shown", `tab "${newTabId}" is already shown in a pane`);
  }
  if (splitRefusal(s, paneId, direction, options)) return s;
  const id = `p${s.next}`;
  const fresh = leafNode(id, newTabId);
  const leaf = nodeAt(s.root, path);
  const parentPath = path.slice(0, -1);
  const parent = path.length ? /** @type {Split} */ (nodeAt(s.root, parentPath)) : null;
  let root;
  if (parent && parent.axis === axis) {
    const i = /** @type {number} */ (path[path.length - 1]);
    const half = /** @type {number} */ (parent.ratios[i]) / 2;
    const children = parent.children.slice();
    const ratios = parent.ratios.slice();
    children.splice(i + 1, 0, fresh);
    ratios.splice(i, 1, half, half);
    root = replaceAt(s.root, parentPath, makeSplit(axis, children, ratios));
  } else {
    root = replaceAt(s.root, path, makeSplit(axis, [leaf, fresh], [0.5, 0.5]));
  }
  return focused(s, id, { root, next: s.next + 1 });
}

/**
 * Removes a pane; its share goes to the previous sibling (the next one if it was first). A split
 * left with one child is replaced by it. Focus, if it was here, goes to the absorbing sibling.
 * @param {Panes} s
 * @param {string} paneId
 * @returns {Panes}
 */
export function closePane(s, paneId) {
  const path = mustPath(s, paneId);
  if (path.length === 0) throw new PaneError("last-pane", "cannot close the last pane");
  const parentPath = path.slice(0, -1);
  const parent = /** @type {Split} */ (nodeAt(s.root, parentPath));
  const i = /** @type {number} */ (path[path.length - 1]);
  const children = parent.children.filter((_, k) => k !== i);
  const ratios = parent.ratios.filter((_, k) => k !== i);
  const j = i > 0 ? i - 1 : 0;
  ratios[j] = /** @type {number} */ (ratios[j]) + /** @type {number} */ (parent.ratios[i]);
  const absorber = /** @type {PaneNode} */ (children[j]);
  const root = replaceAt(s.root, parentPath, makeSplit(parent.axis, children, ratios));
  const mru = s.mru.filter((p) => p !== paneId);
  const focus = s.focus === paneId ? firstLeaf(absorber).pane : s.focus;
  return focused(s, focus, { root, mru });
}

/**
 * @param {PaneNode} node
 * @param {LayoutRect} rect
 * @param {boolean} round
 * @param {PaneRect[]} out
 */
function layoutNode(node, rect, round, out) {
  if (node.type === "leaf") {
    out.push({ pane: node.pane, tab: node.tab, rect });
    return;
  }
  const horizontal = node.axis === "x";
  const start = horizontal ? rect.x : rect.y;
  const size = horizontal ? rect.width : rect.height;
  const n = node.children.length;
  const edges = [start];
  let cum = 0;
  for (let i = 0; i < n - 1; i++) {
    cum += /** @type {number} */ (node.ratios[i]);
    const edge = start + size * cum;
    edges.push(round ? Math.round(edge) : edge);
  }
  edges.push(start + size);
  node.children.forEach((child, i) => {
    const a = /** @type {number} */ (edges[i]);
    const b = /** @type {number} */ (edges[i + 1]);
    layoutNode(
      child,
      horizontal
        ? { x: a, y: rect.y, width: b - a, height: rect.height }
        : { x: rect.x, y: a, width: rect.width, height: b - a },
      round,
      out,
    );
  });
}

/**
 * Pane rectangles inside `rect`, in reading order. A zoomed state yields the zoomed pane alone.
 * Interior edges are rounded to whole pixels (edges, not widths, so neighbours share one edge and
 * integer input tiles exactly); `{ round: false }` gives the exact fractional edges.
 * @param {Panes} s
 * @param {LayoutRect} rect
 * @param {{ round?: boolean }} [options]
 * @returns {PaneRect[]}
 */
export function layout(s, rect, { round = true } = {}) {
  const r = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (s.zoom !== null) {
    const leaf = /** @type {Leaf} */ (nodeAt(s.root, mustPath(s, s.zoom)));
    return [{ pane: leaf.pane, tab: leaf.tab, rect: r }];
  }
  /** @type {PaneRect[]} */
  const out = [];
  layoutNode(s.root, r, round, out);
  return out;
}

/**
 * The pane across the focused pane's `direction` edge, as tmux picks it: of all panes touching
 * that edge and overlapping the focused pane, the most recently used. Undefined at the window edge.
 * @param {Panes} s
 * @param {Direction} direction
 * @returns {string | undefined}
 */
function neighbour(s, direction) {
  if (!DIRECTIONS.includes(direction)) {
    throw new PaneError("bad-direction", `bad direction "${direction}"`);
  }
  const rects = layout(update(s, { zoom: null }), UNIT, { round: false });
  const a = /** @type {PaneRect} */ (rects.find((r) => r.pane === s.focus)).rect;
  const across = direction === "left" || direction === "right";
  /** @param {LayoutRect} b */
  const touches = (b) => {
    switch (direction) {
      case "left":
        return Math.abs(b.x + b.width - a.x) < EPS;
      case "right":
        return Math.abs(a.x + a.width - b.x) < EPS;
      case "up":
        return Math.abs(b.y + b.height - a.y) < EPS;
      default:
        return Math.abs(a.y + a.height - b.y) < EPS;
    }
  };
  /** @param {LayoutRect} b */
  const overlaps = (b) =>
    across
      ? Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > EPS
      : Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > EPS;
  const candidates = new Set(
    rects
      .filter((r) => r.pane !== s.focus && touches(r.rect) && overlaps(r.rect))
      .map((r) => r.pane),
  );
  return s.mru.find((p) => candidates.has(p));
}

/**
 * Moves focus to the geometric neighbour; no neighbour (no wrap) → unchanged.
 * @param {Panes} s
 * @param {Direction} direction
 * @returns {Panes}
 */
export function focus(s, direction) {
  const target = neighbour(s, direction);
  return target === undefined ? s : focused(s, target);
}

/**
 * @param {Panes} s
 * @param {string} paneId
 * @returns {Panes}
 */
export function focusPane(s, paneId) {
  mustPath(s, paneId);
  return s.focus === paneId ? s : focused(s, paneId);
}

/**
 * Exchanges the focused leaf with its neighbour; focus stays on the (moved) pane.
 * @param {Panes} s
 * @param {Direction} direction
 * @returns {Panes}
 */
export function swap(s, direction) {
  const other = neighbour(s, direction);
  if (other === undefined) return s;
  const pa = mustPath(s, s.focus);
  const pb = mustPath(s, other);
  const a = nodeAt(s.root, pa);
  const b = nodeAt(s.root, pb);
  const root = replaceAt(replaceAt(s.root, pa, b), pb, a);
  return update(s, { root, zoom: null });
}

/**
 * Zooms the focused pane, or unzooms.
 * @param {Panes} s
 * @returns {Panes}
 */
export function toggleZoom(s) {
  return update(s, { zoom: s.zoom === null ? s.focus : null });
}

/**
 * Indices of a split's other children, nearest to `i` first (the next one before the previous).
 * @param {number} i
 * @param {number} n
 */
function nearestFirst(i, n) {
  const out = [];
  for (let d = 1; d < n; d++) {
    if (i + d < n) out.push(i + d);
    if (i - d >= 0) out.push(i - d);
  }
  return out;
}

/**
 * Grows or shrinks the focused pane's share of its nearest ancestor split on the matching axis.
 * Growing takes from the siblings nearest first, each down to MIN_RATIO; shrinking gives to the
 * next sibling (previous if last) and stops at MIN_RATIO. Clamped, never rejected.
 * @param {Panes} s
 * @param {ResizeDirection} direction
 * @param {number} amount a share of the split, e.g. 0.05
 * @returns {Panes}
 */
export function resize(s, direction, amount) {
  const spec = RESIZE[direction];
  if (!spec) throw new PaneError("bad-direction", `bad resize direction "${direction}"`);
  if (!(amount > 0 && Number.isFinite(amount))) {
    throw new PaneError("bad-amount", `resize amount must be positive, got ${amount}`);
  }
  const [axis, sign] = spec;
  const path = mustPath(s, s.focus);
  for (let k = path.length - 1; k >= 0; k--) {
    const at = path.slice(0, k);
    const node = /** @type {Split} */ (nodeAt(s.root, at));
    if (node.axis !== axis) continue;
    const i = /** @type {number} */ (path[k]);
    const n = node.ratios.length;
    const ratios = node.ratios.slice();
    /**
     * Moves up to `want` from `from` (not below MIN_RATIO) to `to`; returns what moved.
     * @param {number} from @param {number} to @param {number} want
     */
    const move = (from, to, want) => {
      const spare = /** @type {number} */ (ratios[from]) - MIN_RATIO;
      if (spare <= 0) return 0;
      const give = Math.min(want, spare);
      ratios[from] = give === spare ? MIN_RATIO : /** @type {number} */ (ratios[from]) - give;
      ratios[to] = /** @type {number} */ (ratios[to]) + give;
      return give;
    };
    let moved = 0;
    if (sign > 0) {
      for (const j of nearestFirst(i, n)) {
        moved += move(j, i, amount - moved);
        if (moved >= amount) break;
      }
    } else {
      moved = move(i, i < n - 1 ? i + 1 : i - 1, amount);
    }
    if (moved <= 0) return s;
    const root = replaceAt(s.root, at, makeSplit(axis, node.children, ratios));
    return update(s, { root, zoom: null });
  }
  return s;
}

/**
 * Shows another tab in a pane (switching tabs in the focused pane).
 * @param {Panes} s
 * @param {string} paneId
 * @param {string} tabId
 * @returns {Panes}
 */
export function setPaneTab(s, paneId, tabId) {
  const path = mustPath(s, paneId);
  const leaf = /** @type {Leaf} */ (nodeAt(s.root, path));
  if (leaf.tab === tabId) return s;
  if (paneOfTab(s, tabId) !== undefined) {
    throw new PaneError("tab-shown", `tab "${tabId}" is already shown in a pane`);
  }
  return update(s, { root: replaceAt(s.root, path, leafNode(paneId, tabId)) });
}

/**
 * Whether `s` is a hidden view (docs/specs/side-panel-unsplit.md decision 20).
 * @param {Panes} s
 */
export function isHidden(s) {
  return s.hidden === true;
}

/**
 * The same tree kept as a view that is not shown: panes, sizes, focus, zoom and preset stay.
 * @param {Panes} s
 * @returns {Panes}
 */
export function hideView(s) {
  return isHidden(s) ? s : Object.freeze({ ...s, hidden: /** @type {const} */ (true) });
}

/**
 * The view shown again, as it was.
 * @param {Panes} s
 * @returns {Panes}
 */
export function showView(s) {
  if (!isHidden(s)) return s;
  const shown = { ...s };
  delete shown.hidden;
  return Object.freeze(shown);
}

/**
 * What selecting `tabId` does to the view (docs/specs/side-panel-unsplit.md decisions 21-23).
 * A pane's tab: that pane gets focus, and a hidden view shows again ("show"). Any other tab: a
 * new foreground tab (`opened`) that may join takes the focused pane's place while the view
 * shows ("replace", m4-split-panes' user story); anything else hides the view ("hide") and shows
 * alone. Outside a hidden view nothing changes.
 * @param {Panes} s
 * @param {string} tabId
 * @param {{ opened?: boolean, canJoin?: boolean }} [options]
 * @returns {{ panes: Panes, change: "none" | "focus" | "show" | "replace" | "hide" }}
 */
export function pickTab(s, tabId, { opened = false, canJoin = true } = {}) {
  const pane = paneOfTab(s, tabId);
  if (pane !== undefined) {
    if (isHidden(s)) return { panes: focusPane(showView(s), pane), change: "show" };
    if (pane === s.focus) return { panes: s, change: "none" };
    return { panes: focusPane(s, pane), change: "focus" };
  }
  if (isHidden(s)) return { panes: s, change: "none" };
  if (opened && canJoin) return { panes: setPaneTab(s, s.focus, tabId), change: "replace" };
  return { panes: hideView(s), change: "hide" };
}
