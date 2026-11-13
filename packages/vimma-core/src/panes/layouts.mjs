/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tiling layouts (docs/specs/tiling-layouts.md): tmux's presets (`select-layout`, `next-layout`)
 * and Hyprland's dwindle, as pure builders over the pane tree (panes.mjs). A preset rearranges
 * the leaves it is given, pane ids and tabs untouched, so the host moves panels and never
 * recreates a page.
 */

import {
  MIN_RATIO,
  PaneError,
  closePane,
  createRow,
  focusPane,
  layout,
  leaves,
  makeSplit,
} from "./panes.mjs";

/** @import { Leaf, LayoutRect, PaneNode, Panes, SplitDirection, SplitRefusal } from "./panes.mjs" */
/**
 * @typedef {"even-horizontal" | "even-vertical" | "main-vertical" | "main-horizontal" | "tiled"
 *   | "dwindle"} LayoutName
 */
/**
 * `area`: the content area in px, for dwindle's longer-side choice (default 16∶9).
 * `mainSize`: the main pane's share in main-* (default MAIN_SIZE_DEFAULT).
 * @typedef {{ area?: LayoutRect, mainSize?: number }} ArrangeOptions
 */

/** The presets, in the order `next layout` (`prefix+space`) cycles through them. */
export const LAYOUTS = /** @type {readonly LayoutName[]} */ (
  Object.freeze([
    "even-horizontal",
    "even-vertical",
    "main-vertical",
    "main-horizontal",
    "tiled",
    "dwindle",
  ])
);

/** Default of config `[panes] main_size` (60 %): the main pane's share in main-*. */
export const MAIN_SIZE_DEFAULT = 0.6;

const EPS = 1e-9;
const WIDE = Object.freeze({ x: 0, y: 0, width: 16, height: 9 });

/**
 * @param {unknown} name
 * @returns {name is LayoutName}
 */
export function isLayoutName(name) {
  return typeof name === "string" && /** @type {readonly string[]} */ (LAYOUTS).includes(name);
}

/**
 * The preset an action id applies (`pane.layout_main_vertical` → `main-vertical`), or undefined.
 * @param {string} id
 * @returns {LayoutName | undefined}
 */
export function layoutOfAction(id) {
  if (!id.startsWith("pane.layout_")) return undefined;
  const name = id.slice("pane.layout_".length).replace("_", "-");
  return isLayoutName(name) ? name : undefined;
}

/**
 * The preset after `current` in LAYOUTS, wrapping; the first when there is none (or unknown).
 * @param {string | null | undefined} current
 * @returns {LayoutName}
 */
export function nextLayout(current) {
  const i = isLayoutName(current) ? LAYOUTS.indexOf(current) : -1;
  return /** @type {LayoutName} */ (LAYOUTS[(i + 1) % LAYOUTS.length]);
}

/**
 * Where a pane opened without a direction goes (dwindle): `vertical` (side by side) when the
 * focused pane is at least as wide as tall in `area`, else `horizontal` (stacked). A zoom is
 * ignored: the pane's place in the tree counts.
 * @param {Panes} s
 * @param {LayoutRect} area
 * @returns {SplitDirection}
 */
export function dwindleDirection(s, area) {
  const rects = layout(Object.freeze({ ...s, zoom: null }), area, { round: false });
  const r = /** @type {{ rect: LayoutRect }} */ (rects.find((p) => p.pane === s.focus)).rect;
  return r.width >= r.height ? "vertical" : "horizontal";
}

/**
 * @param {readonly Leaf[]} list
 * @returns {number[]}
 */
const even = (list) => list.map(() => 1 / list.length);

/**
 * @param {"x" | "y"} axis
 * @param {readonly Leaf[]} list
 * @returns {PaneNode}
 */
const row = (axis, list) => makeSplit(axis, list, even(list));

/**
 * @param {readonly Leaf[]} list
 * @param {LayoutRect} rect
 * @returns {PaneNode}
 */
function spiral(list, rect) {
  const [first, ...rest] = list;
  if (!rest.length) return /** @type {Leaf} */ (first);
  const wide = rect.width >= rect.height;
  const other = wide
    ? { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 }
    : { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
  return makeSplit(
    wide ? "x" : "y",
    [/** @type {Leaf} */ (first), spiral(rest, other)],
    [0.5, 0.5],
  );
}

/**
 * The tree of preset `name` over `list` (the order its builder uses).
 * @param {LayoutName} name
 * @param {readonly Leaf[]} list
 * @param {number} main
 * @param {LayoutRect} area
 * @returns {PaneNode}
 */
function build(name, list, main, area) {
  switch (name) {
    case "even-horizontal":
      return row("x", list);
    case "even-vertical":
      return row("y", list);
    case "main-vertical":
    case "main-horizontal": {
      const [first, ...rest] = list;
      const [outer, inner] = name === "main-vertical" ? ["x", "y"] : ["y", "x"];
      return makeSplit(
        /** @type {"x" | "y"} */ (outer),
        [/** @type {Leaf} */ (first), row(/** @type {"x" | "y"} */ (inner), rest)],
        [main, 1 - main],
      );
    }
    case "tiled": {
      const columns = Math.ceil(Math.sqrt(list.length));
      /** @type {PaneNode[]} */
      const rows = [];
      for (let i = 0; i < list.length; i += columns)
        rows.push(row("x", list.slice(i, i + columns)));
      return makeSplit(
        "y",
        rows,
        rows.map(() => 1 / rows.length),
      );
    }
    default:
      return spiral(list, area);
  }
}

/**
 * @param {unknown} name
 * @returns {LayoutName}
 */
function checkName(name) {
  if (!isLayoutName(name)) {
    throw new PaneError("bad-direction", `unknown layout "${String(name)}"`);
  }
  return name;
}

/**
 * @param {unknown} m
 * @returns {number}
 */
function checkMain(m) {
  if (typeof m === "number" && m >= MIN_RATIO - EPS && m <= 1 - MIN_RATIO + EPS) return m;
  throw new PaneError("bad-amount", `main size must be between ${MIN_RATIO} and ${1 - MIN_RATIO}`);
}

/**
 * The leaves in the order preset `name` places them: reading order, the focused pane first for
 * main-* (the main pane).
 * @param {Panes} s
 * @param {LayoutName} name
 */
function ordered(s, name) {
  const list = leaves(s);
  if (!name.startsWith("main-")) return list;
  const focus = /** @type {Leaf} */ (list.find((l) => l.pane === s.focus));
  return [focus, ...list.filter((l) => l !== focus)];
}

/**
 * @param {PaneNode} node
 * @returns {boolean} every share at least MIN_RATIO
 */
function roomy(node) {
  return (
    node.type === "leaf" ||
    (node.ratios.every((r) => r >= MIN_RATIO - EPS) && node.children.every(roomy))
  );
}

/**
 * Why preset `name` cannot arrange `s`, or null: `no-space` when a pane would get less than
 * MIN_RATIO of its split (even-* past 10 panes, main-* past 11).
 * @param {Panes} s
 * @param {LayoutName} name
 * @param {ArrangeOptions} [options]
 * @returns {SplitRefusal | null}
 */
export function layoutRefusal(s, name, { area = WIDE, mainSize = MAIN_SIZE_DEFAULT } = {}) {
  checkName(name);
  const list = ordered(s, name);
  if (list.length < 2 || roomy(build(name, list, checkMain(mainSize), area))) return null;
  return { code: "no-space", message: `no space for ${list.length} panes in ${name}` };
}

/**
 * Rearranges the panes into preset `name`: same panes, same tabs, focus and MRU kept, zoom
 * ended (tmux's select-layout unzooms), `layout` set to `name`. One pane, or a refusal
 * (`layoutRefusal`): the input itself.
 * @param {Panes} s
 * @param {LayoutName} name
 * @param {ArrangeOptions} [options]
 * @returns {Panes}
 */
export function arrange(s, name, { area = WIDE, mainSize = MAIN_SIZE_DEFAULT } = {}) {
  checkName(name);
  const main = checkMain(mainSize);
  const list = ordered(s, name);
  if (list.length < 2) return s;
  const root = build(name, list, main, area);
  if (!roomy(root)) return s;
  return Object.freeze({ ...s, root, zoom: null, layout: name });
}

/**
 * How tabs shown together are arranged (docs/specs/m4-side-panel-multiselect.md decision 8).
 * `preset`: the workspace's stored preset (`Panes.layout`), used when it is one of LAYOUTS.
 * `mode`: config `[panes] layout`, used without one: dwindle, or a row for "manual".
 * `focus`: the tab whose pane gets focus (default, or not listed: the first).
 * `max`: config `[panes] max` (default unbounded).
 * @typedef {ArrangeOptions & { preset?: string, mode?: "dwindle" | "manual", focus?: string,
 *   max?: number }} TogetherOptions
 */

/**
 * The preset tabs shown together take: the stored one, else dwindle, else ("manual") a row,
 * which is even-horizontal's tree.
 * @param {TogetherOptions} options
 * @returns {LayoutName}
 */
function togetherName({ preset, mode = "dwindle" }) {
  if (isLayoutName(preset)) return preset;
  return mode === "manual" ? "even-horizontal" : "dwindle";
}

/**
 * Why `ids` cannot be shown together, or null: `max-panes` past `max`, or `no-space` when the
 * layout would give a pane less than MIN_RATIO.
 * @param {readonly string[]} ids  two tabs or more
 * @param {TogetherOptions} [options]
 * @returns {SplitRefusal | null}
 */
export function togetherRefusal(ids, options = {}) {
  const { max = Infinity } = options;
  if (ids.length > max) {
    return { code: "max-panes", message: `at most ${max} pane${max === 1 ? "" : "s"}` };
  }
  return layoutRefusal(createRow(ids), togetherName(options), options);
}

/**
 * `ids` (two tabs or more, in reading order) as a new pane tree arranged as the workspace's
 * layout: the stored preset, else `[panes] layout`. Built by `arrange` over a row of the tabs,
 * so the trees are exactly the presets'. Focus on `focus`, the MRU in reading order after it, no
 * zoom. The stored preset stays stored; without one none is set. A refusal
 * (`togetherRefusal`, without `max`) throws: check it first.
 * @param {readonly string[]} ids
 * @param {TogetherOptions} [options]
 * @returns {Panes}
 */
export function showTogether(ids, options = {}) {
  if (ids.length < 2) throw new PaneError("bad-tabs", "showing tabs together needs two");
  const refusal = togetherRefusal(ids, { ...options, max: Infinity });
  if (refusal) throw new PaneError("bad-amount", refusal.message);
  // createRow's shares are replaced by arrange's tree: only its leaves, focus and MRU count.
  const row = createRow(ids, { focus: options.focus });
  const { root, focus, mru, zoom, next } = arrange(row, togetherName(options), options);
  const tree = { root, focus, mru, zoom, next };
  return Object.freeze(isLayoutName(options.preset) ? { ...tree, layout: options.preset } : tree);
}

/**
 * Whether `ids` only drops tabs from `s` (or keeps them all): no tab joins.
 * @param {Panes | null} s
 * @param {readonly string[]} ids
 */
function removalsOnly(s, ids) {
  if (!s) return false;
  const shown = new Set(leaves(s).map((l) => l.tab));
  return ids.every((id) => shown.has(id));
}

/**
 * Why the split `s` cannot become `ids`, or null (docs/specs/side-panel-unsplit.md): removals
 * never refuse; with a tab joining, `togetherRefusal` with the stored preset.
 * @param {Panes | null} s
 * @param {readonly string[]} ids  two tabs or more
 * @param {TogetherOptions} [options]
 * @returns {SplitRefusal | null}
 */
export function repaneRefusal(s, ids, options = {}) {
  if (removalsOnly(s, ids)) return null;
  return togetherRefusal(ids, { ...options, preset: options.preset ?? s?.layout });
}

/**
 * The split `s` changed to show `ids` (docs/specs/side-panel-unsplit.md decision 15). When no tab
 * joins, each pane whose tab is not in `ids` closes as `prefix+x` closes it, so the other panes
 * keep their shape and sizes and the stored preset stays; with a tab joining (or no tree) the set
 * is arranged afresh by `showTogether`, with `s`'s stored preset unless `preset` is given. Focus
 * on `focus`'s pane when it is shown. A refusal (`repaneRefusal`) throws: check it first.
 * @param {Panes | null} s
 * @param {readonly string[]} ids  two tabs or more
 * @param {TogetherOptions} [options]
 * @returns {Panes}
 */
export function repane(s, ids, options = {}) {
  if (ids.length < 2) throw new PaneError("bad-tabs", "a split needs two tabs");
  if (!s || !removalsOnly(s, ids)) {
    return showTogether(ids, { ...options, preset: options.preset ?? s?.layout });
  }
  const wanted = new Set(ids);
  let next = s;
  for (const leaf of leaves(s)) if (!wanted.has(leaf.tab)) next = closePane(next, leaf.pane);
  const target = leaves(next).find((l) => l.tab === options.focus);
  return target ? focusPane(next, target.pane) : next;
}
