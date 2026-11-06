/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Versioned JSON for the workspace + pane state (spec m3-m4-core-models). The host writes
 * `toSnapshot(state)` to its state file and restores with `fromSnapshot`, which migrates older
 * schemas and validates every invariant, failing with the JSON path of the first problem.
 * Contract fixtures: tests/contract/state/v<n>/.
 */

/** @import { Workspaces } from "./workspaces.mjs" */
/** @import { WorkspaceState } from "./workspaces.mjs" */
/** @import { Panes } from "./panes.mjs" */
/** @import { PaneNode } from "./panes.mjs" */
/** @import { TabLabels, TabLabelWarning } from "./tablabels.mjs" */
/** @import { NumberedSplit, Splits } from "./splits.mjs" */
/** @typedef {(raw: any) => any} SnapshotMigration a step from schema n to n + 1 */

import { MIN_RATIO } from "./panes.mjs";
import { isLayoutName } from "./layouts.mjs";
import { isWorkspaceId, splitsOf } from "./workspaces.mjs";
import { MAX_SPLITS_LIMIT } from "./splits.mjs";
import { pruneTabLabels, readTabLabels, writeTabLabels } from "./tablabels.mjs";

export const SCHEMA_VERSION = 1;

/**
 * `SNAPSHOT_MIGRATIONS[n]` upgrades a schema-n snapshot to n + 1. Schema 1 is the first.
 * @type {Readonly<Record<number, SnapshotMigration>>}
 */
export const SNAPSHOT_MIGRATIONS = Object.freeze({});

export class SnapshotError extends Error {
  /**
   * @param {"invalid" | "bad-json" | "unsupported-schema" | "bad-migration"} code
   * @param {string} path JSON path of the offending value, "" for the whole document
   * @param {string} message
   */
  constructor(code, path, message) {
    super(`${path || "<root>"}: ${message}`);
    this.name = "SnapshotError";
    this.code = code;
    this.path = path;
  }
}

/**
 * @param {string} path
 * @param {string} message
 * @param {"invalid" | "bad-json" | "unsupported-schema" | "bad-migration"} [code]
 * @returns {never}
 */
function fail(path, message, code = "invalid") {
  throw new SnapshotError(code, path, message);
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isId(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * `next` must be above every minted id (`<prefix><n>`) so new ids never collide.
 * @param {unknown} next
 * @param {Iterable<string>} ids
 * @param {string} prefix
 * @param {string} path
 */
function checkNext(next, ids, prefix, path) {
  let max = 0;
  for (const id of ids) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (!Number.isInteger(next) || /** @type {number} */ (next) <= max) {
    fail(path, `must be an integer above ${max}`);
  }
}

/**
 * Plain JSON for persistence. `tabLabels` (tab renames, spec m2-core-logic) is written as the
 * optional `tabLabels` field, only for tabs that are still open and only when there are any, so
 * a snapshot without renames is plain v1. The alternate workspace (`ctrl+^`) is the optional
 * `alternate` field, likewise only when there is one. A workspace that keeps a list of splits
 * writes it as `splits` and `shown` (docs/specs/multiple-splits.md decision 15), and `panes` as
 * an older Vimma reads it: the shown split, else the split shown last as a hidden view.
 * @param {Workspaces} s
 * @param {{ tabLabels?: TabLabels }} [options]
 */
export function toSnapshot(s, { tabLabels } = {}) {
  const labels =
    tabLabels &&
    writeTabLabels(
      pruneTabLabels(
        tabLabels,
        s.workspaces.flatMap((w) => w.tabs),
      ),
    );
  return {
    schema: SCHEMA_VERSION,
    active: s.active,
    next: s.next,
    workspaces: s.workspaces.map((w) => {
      const own = w.splits === undefined ? null : splitsOf(w);
      const view = own?.splits.length ? olderView(own) : w.panes;
      // A hidden view (side-panel-unsplit decision 24): the file keeps activeTab on the focused
      // pane's tab, so an older Vimma restores the split shown; `alone` is the tab shown alone.
      const alone =
        view?.hidden && w.activeTab !== null && !hasTab(view, w.activeTab) ? w.activeTab : null;
      return {
        id: w.id,
        name: w.name,
        container: w.container,
        tabs: w.tabs.slice(),
        activeTab: alone && view ? findTab(view.root, view.focus) : w.activeTab,
        panes: view && JSON.parse(JSON.stringify(view)),
        ...(alone ? { alone } : {}),
        ...(own ? { splits: JSON.parse(JSON.stringify(own.splits)), shown: own.shown } : {}),
      };
    }),
    ...(s.alternate !== undefined ? { alternate: s.alternate } : {}),
    ...(labels ? { tabLabels: labels } : {}),
  };
}

/**
 * The one tree an older Vimma reads from a list of splits: the shown split, else the split shown
 * last (else the first) as a hidden view, without its number.
 * @param {Splits} own  at least one split
 * @returns {Panes}
 */
function olderView(own) {
  const pick =
    own.splits.find((x) => x.number === (own.shown ?? own.last)) ??
    /** @type {NumberedSplit} */ (own.splits[0]);
  /** @type {Record<string, unknown>} */
  const tree = { ...pick };
  delete tree.number;
  if (own.shown === null) tree.hidden = true;
  return /** @type {Panes} */ (/** @type {unknown} */ (tree));
}

/**
 * Upgrades `raw` step by step to SCHEMA_VERSION; returns `raw` itself when it is current.
 * @param {unknown} raw
 * @param {Readonly<Record<number, SnapshotMigration>>} [migrations]
 * @returns {Record<string, any>}
 */
export function migrateSnapshot(raw, migrations = SNAPSHOT_MIGRATIONS) {
  let doc = raw;
  for (;;) {
    if (!isObject(doc)) return fail("", "a snapshot must be a JSON object");
    const schema = doc.schema;
    if (!Number.isInteger(schema)) return fail("schema", "missing or not an integer");
    if (schema === SCHEMA_VERSION) return doc;
    const step = migrations[schema];
    if (schema > SCHEMA_VERSION || !step) {
      return fail("schema", `schema ${schema} is not supported`, "unsupported-schema");
    }
    doc = step(doc);
    if (!isObject(doc) || doc.schema !== schema + 1) {
      return fail(
        "schema",
        `the migration from schema ${schema} did not produce ${schema + 1}`,
        "bad-migration",
      );
    }
  }
}

/**
 * Whether the host may overwrite the state file it found: false only for a file written by a
 * newer vimma (schema above SCHEMA_VERSION), whose data this version would silently drop.
 * Missing (null) or unreadable files may be overwritten.
 * @param {unknown} existing the file's text, its parsed JSON, or null when there is no file
 * @returns {boolean}
 */
export function canWrite(existing) {
  let doc = existing;
  if (typeof existing === "string") {
    try {
      doc = JSON.parse(existing);
    } catch {
      return true;
    }
  }
  const schema = isObject(doc) ? doc.schema : undefined;
  return !(Number.isInteger(schema) && /** @type {number} */ (schema) > SCHEMA_VERSION);
}

/**
 * @param {any} node
 * @param {string} path
 * @param {{ axis: string, share: number } | null} parent
 * @param {{ panes: Set<string>, shown: Set<string>, tabs: Set<string> }} ctx
 * @returns {PaneNode}
 */
function readNode(node, path, parent, ctx) {
  if (!isObject(node)) return fail(path, "a pane node must be an object");
  if (node.type === "leaf") {
    if (!isId(node.pane) || ctx.panes.has(node.pane)) fail(`${path}.pane`, "missing or duplicate");
    if (!isId(node.tab) || !ctx.tabs.has(node.tab))
      fail(`${path}.tab`, "not a tab of this workspace");
    if (ctx.shown.has(node.tab)) fail(`${path}.tab`, "tab shown in two panes");
    ctx.panes.add(node.pane);
    ctx.shown.add(node.tab);
    return Object.freeze({ type: "leaf", pane: node.pane, tab: node.tab });
  }
  if (node.type !== "split") return fail(`${path}.type`, `must be "leaf" or "split"`);
  const axis = node.axis;
  if (axis !== "x" && axis !== "y") fail(`${path}.axis`, `must be "x" or "y"`);
  const { children, ratios } = node;
  if (!Array.isArray(children) || children.length < 2) {
    fail(`${path}.children`, "a split needs at least two children");
  }
  if (
    !Array.isArray(ratios) ||
    ratios.length !== children.length ||
    !ratios.every((r) => typeof r === "number" && Number.isFinite(r) && r > 0) ||
    Math.abs(ratios.reduce((a, b) => a + b, 0) - 1) > 1e-6
  ) {
    fail(`${path}.ratios`, "one positive ratio per child, summing to 1");
  }
  // the model keeps a same-axis child split only when flattening would squeeze a pane too far
  if (
    parent &&
    parent.axis === axis &&
    ratios.every((/** @type {number} */ r) => r * parent.share >= MIN_RATIO - 1e-9)
  ) {
    fail(`${path}.axis`, "same axis as the parent split");
  }
  const kids = children.map((c, i) =>
    readNode(c, `${path}.children[${i}]`, { axis, share: ratios[i] }, ctx),
  );
  return Object.freeze({
    type: "split",
    axis,
    children: Object.freeze(kids),
    ratios: Object.freeze(ratios.slice()),
  });
}

/**
 * @param {any} raw
 * @param {string} path
 * @param {Set<string>} tabs
 * @returns {Panes}
 */
function readPanes(raw, path, tabs) {
  if (!isObject(raw)) return fail(path, "must be an object or null");
  const ctx = { panes: new Set(), shown: new Set(), tabs };
  const root = readNode(raw.root, `${path}.root`, null, ctx);
  if (!ctx.panes.has(raw.focus)) fail(`${path}.focus`, "must name a pane");
  const mru = raw.mru;
  if (
    !Array.isArray(mru) ||
    mru.length !== ctx.panes.size ||
    new Set(mru).size !== mru.length ||
    !mru.every((p) => ctx.panes.has(p)) ||
    mru[0] !== raw.focus
  ) {
    fail(`${path}.mru`, "every pane once, most recently focused first, starting with focus");
  }
  if (raw.zoom !== null && !ctx.panes.has(raw.zoom)) fail(`${path}.zoom`, "must be null or a pane");
  checkNext(raw.next, ctx.panes, "p", `${path}.next`);
  return Object.freeze({
    root,
    focus: raw.focus,
    mru: Object.freeze(mru.slice()),
    zoom: raw.zoom,
    next: raw.next,
    // The last preset (tiling-layouts): optional, read leniently. An unknown name (a newer
    // vimma's preset) is dropped; cycling then starts from the first preset.
    ...(isLayoutName(raw.layout) ? { layout: raw.layout } : {}),
  });
}

/**
 * A workspace's `splits`, read leniently (docs/specs/multiple-splits.md decision 15): an entry
 * that is malformed, has fewer than two panes, a number outside 1 to MAX_SPLITS_LIMIT or one
 * already read, or a tab of an earlier entry is dropped, so a damaged file never puts one tab in
 * two splits and never fails the restore. Not an array: no splits.
 * @param {unknown} raw
 * @param {string} path
 * @param {Set<string>} tabs  the workspace's
 * @returns {readonly NumberedSplit[]}
 */
function readSplits(raw, path, tabs) {
  if (!Array.isArray(raw)) return Object.freeze([]);
  /** @type {NumberedSplit[]} */
  const out = [];
  const taken = new Set();
  raw.forEach((entry, i) => {
    if (!isObject(entry)) return;
    const n = entry.number;
    if (!Number.isInteger(n) || n < 1 || n > MAX_SPLITS_LIMIT) return;
    if (out.some((x) => x.number === n)) return;
    let panes;
    try {
      panes = readPanes(entry, `${path}[${i}]`, tabs);
    } catch (e) {
      if (e instanceof SnapshotError) return;
      throw e;
    }
    if (panes.root.type !== "split") return;
    const tree = panes;
    const shown = [...tabs].filter((t) => hasTab(tree, t));
    if (shown.some((t) => taken.has(t))) return;
    for (const t of shown) taken.add(t);
    out.push(Object.freeze({ ...panes, number: n }));
  });
  return Object.freeze(out.sort((a, b) => a.number - b.number));
}

/**
 * Whether a tree shows `tabId` in one of its panes.
 * @param {Panes} panes
 * @param {string | null} tabId
 */
function hasTab(panes, tabId) {
  /** @param {PaneNode} n @returns {boolean} */
  const walk = (n) => (n.type === "leaf" ? n.tab === tabId : n.children.some(walk));
  return walk(panes.root);
}

/**
 * Parses, migrates and validates a snapshot (object or JSON text).
 * @param {unknown} input
 * @param {{ migrations?: Readonly<Record<number, SnapshotMigration>> }} [options]
 * @returns {Workspaces}
 */
export function fromSnapshot(input, options) {
  return readSnapshot(input, options).state;
}

/**
 * `fromSnapshot` plus the tab renames. The workspace state is validated strictly (a broken file
 * throws `SnapshotError`); the optional `tabLabels` field is read leniently: stale or invalid
 * entries are dropped with a warning, so one bad label never fails a restore. The optional
 * `alternate` is kept only when it names a workspace other than `active`, else dropped.
 * @param {unknown} input
 * @param {{ migrations?: Readonly<Record<number, SnapshotMigration>> }} [options]
 * @returns {{ state: Workspaces, tabLabels: TabLabels, warnings: TabLabelWarning[] }}
 */
export function readSnapshot(input, { migrations } = {}) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      fail("", `not JSON: ${/** @type {Error} */ (e).message}`, "bad-json");
    }
  }
  const doc = migrateSnapshot(raw, migrations);
  const list = doc.workspaces;
  if (!Array.isArray(list) || list.length === 0) {
    fail("workspaces", "need at least one workspace");
  }
  const ids = new Set();
  const names = new Set();
  const containers = new Set();
  const allTabs = new Set();
  /** @type {WorkspaceState[]} */
  const workspaces = list.map((w, k) => {
    const at = `workspaces[${k}]`;
    if (!isObject(w)) return fail(at, "must be an object");
    if (!isWorkspaceId(w.id) || ids.has(w.id)) fail(`${at}.id`, "missing, malformed or duplicate");
    if (typeof w.name !== "string" || !w.name || w.name !== w.name.trim() || names.has(w.name)) {
      fail(`${at}.name`, "empty, duplicate or with surrounding spaces");
    }
    if (!isId(w.container) || containers.has(w.container)) {
      fail(`${at}.container`, "empty or duplicate");
    }
    if (!Array.isArray(w.tabs)) fail(`${at}.tabs`, "must be an array");
    w.tabs.forEach((/** @type {unknown} */ t, i) => {
      if (!isId(t) || allTabs.has(t)) fail(`${at}.tabs[${i}]`, "empty or already open");
      allTabs.add(t);
    });
    ids.add(w.id);
    names.add(w.name);
    containers.add(w.container);
    /** @type {Panes | null} */
    let panes = null;
    if (w.tabs.length === 0) {
      if (w.activeTab !== null) fail(`${at}.activeTab`, "must be null without tabs");
      if (w.panes !== null) fail(`${at}.panes`, "must be null without tabs");
    } else {
      if (!w.tabs.includes(w.activeTab)) fail(`${at}.activeTab`, "must be one of the tabs");
      if (w.panes === null) fail(`${at}.panes`, "a workspace with tabs needs a layout");
      panes = readPanes(w.panes, `${at}.panes`, new Set(w.tabs));
      if (findTab(panes.root, panes.focus) !== w.activeTab) {
        fail(`${at}.activeTab`, "must be the focused pane's tab");
      }
    }
    // A hidden view (side-panel-unsplit decision 24), read leniently: kept hidden only with a
    // split and an `alone` tab of the workspace outside it, else the split reads as shown.
    let activeTab = w.activeTab;
    if (
      panes &&
      w.panes.hidden === true &&
      panes.root.type === "split" &&
      typeof w.alone === "string" &&
      w.tabs.includes(w.alone) &&
      !hasTab(panes, w.alone)
    ) {
      panes = Object.freeze({ ...panes, hidden: /** @type {const} */ (true) });
      activeTab = w.alone;
    }
    // Several splits (multiple-splits decision 15). Which one shows, and which showed last, come
    // from activeTab and alone, the fields an older Vimma keeps up to date too, so a file it
    // rewrote never names a shown split that is not on screen; `shown` is written for readers.
    /** @type {Partial<Splits>} */
    let own = {};
    if (w.splits !== undefined) {
      const splits = readSplits(w.splits, `${at}.splits`, new Set(w.tabs));
      const of = (/** @type {unknown} */ tab) => splits.find((x) => hasTab(x, String(tab)));
      const shown = of(activeTab)?.number ?? null;
      own = { splits, shown, last: shown ?? of(w.activeTab)?.number ?? null };
    }
    return Object.freeze({
      id: w.id,
      name: w.name,
      container: w.container,
      tabs: Object.freeze(w.tabs.slice()),
      activeTab,
      panes,
      ...own,
    });
  });
  if (!ids.has(doc.active)) fail("active", "must name a workspace");
  checkNext(doc.next, ids, "w", "next");
  const alternate =
    typeof doc.alternate === "string" && doc.alternate !== doc.active && ids.has(doc.alternate)
      ? doc.alternate
      : undefined;
  const state = Object.freeze({
    workspaces: Object.freeze(workspaces),
    active: doc.active,
    next: doc.next,
    ...(alternate !== undefined ? { alternate } : {}),
  });
  const { labels, warnings } = readTabLabels(doc.tabLabels, allTabs);
  return { state, tabLabels: labels, warnings };
}

/**
 * @param {PaneNode} node
 * @param {string} pane
 * @returns {string | undefined}
 */
function findTab(node, pane) {
  if (node.type === "leaf") return node.pane === pane ? node.tab : undefined;
  return node.children.map((c) => findTab(c, pane)).find((t) => t !== undefined);
}
