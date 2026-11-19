/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * bookmarks.toml's outside write-back (docs/specs/bookmarks-file.md, Delivery slice 3), pure: the
 * three-way merge (D4) of what Places holds now (a change made in the Library, by Sync, an import
 * or a restore) with the bookmarks file and the base, written as one edit of the file's lines
 * (D10, Behaviour 13). The host (config/BookmarksFile.sys.mjs) writes the edit, saves the base,
 * and then runs the mirror's plan (bookmarks-file.mjs), which brings Places to the merged file.
 *
 * Per item, by its guid in the base: a change on one side only is taken; when both sides changed
 * one bookmark, the file's change wins and Places is put back; a removal on one side and a change
 * on the other keeps the item with the change; an item added in Places is written where Places
 * has it. Folder names, order within a folder, and the workspace's folder itself (Behaviour 20)
 * follow the same rules. A failed or partial merge writes nothing: an item may end up twice, never
 * nowhere. Items the file cannot hold (a `data:` or `place:` URL, a bookmarklet while bookmarklets
 * are off, a path deeper than the file allows) stay in Places as they are (`keep`).
 *
 * Every walk is bounded as the reader's is (docs/security/08-config-toml.md F6): Places is walked
 * without recursion, paths stop at MAX_BOOKMARK_DEPTH, and the edit is checked by reading it back.
 */
import {
  BOOKMARKS_FILE,
  MAX_BOOKMARK_DEPTH,
  lineUrl,
  readBookmarks,
  tableNameProblem,
  uniqueNamer,
} from "./bookmarks-file.mjs";
import { cleanName, editBookmarkLines, scanBookmarkLines, writableUrl } from "./bookmarks-edit.mjs";
import { PLACES_ROOTS } from "../ui/bookmarks.mjs";

/**
 * @import { BaseEntry, BaseTable, BookmarksSource, PlacesNode } from "./bookmarks-file.mjs"
 * @import { LineOp, NewLine, ScanTable } from "./bookmarks-edit.mjs"
 * @import { BookmarkletsSetting } from "../ui/bookmarks.mjs"
 */

/**
 * A node of the merged tree: a bookmark, or a folder with its children in order. `id` is the
 * item's guid in the base (or in Places, for an item only Places had); `line`, the file's line
 * that holds it (a bookmark's, or an empty folder's); `raw`, that line's value as written.
 * @typedef {{ kind: "bookmark" | "folder", name: string, url: string | null, id: string | null,
 *   parent: MNode | null, children: MNode[], fileKids: MNode[], line: number | null,
 *   raw: string | null, hadLines: boolean, fromPlaces: boolean, dropped: boolean,
 *   same: boolean }} MNode
 */

/**
 * An item of a table's folder in Places, named as the file would name it.
 * @typedef {{ kind: "bookmark" | "folder", name: string, url: string | null, parent: string,
 *   real: string, depth: number }} PItem
 */

/**
 * A line of the merged table, in order: `ref` the file's line that holds it, or null for a new
 * one, which gets `id`.
 * @typedef {{ ref: number | null, id?: string, names: string[], folder: boolean, value: string }}
 *   Leaf
 */

/** A folder whose title is empty is written with this name. */
export const UNTITLED_FOLDER = "(untitled)";

const TYPE_BOOKMARK = 1;
const TYPE_FOLDER = 2;

/** A path key: the kind, then the names, joined by a character no checked name holds. */
const keyOf = (/** @type {string} */ kind, /** @type {readonly string[]} */ names) =>
  `${kind}\u0000${names.join("\u0000")}`;

/** @param {readonly string[]} a @param {readonly string[]} b */
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Whether a line's value is `url` as the file reads it, so the line is not rewritten (D5). */
function sameUrl(/** @type {string} */ value, /** @type {string | null} */ url) {
  const u = lineUrl(value);
  return "url" in u && u.url === url;
}

/** A Places URL as an href, as the file's lines are kept. */
function normUrl(/** @type {string | undefined} */ u) {
  try {
    return new URL(u ?? "").href;
  } catch {
    return u ?? "";
  }
}

/**
 * Every node of `tree` with its parent's guid, walked without recursion.
 * @param {PlacesNode} tree
 */
function indexPlaces(tree) {
  /** @type {Map<string, { node: PlacesNode, parent: string | null }>} */
  const map = new Map();
  /** @type {[PlacesNode, string | null][]} */
  const stack = [[tree, null]];
  while (stack.length) {
    const [n, parent] = /** @type {[PlacesNode, string | null]} */ (stack.pop());
    if (n.guid) map.set(n.guid, { node: n, parent });
    for (const c of n.children ?? []) stack.push([c, n.guid ?? null]);
  }
  return map;
}

/**
 * The name the file gives a Places item (Behaviour 15): its title cleaned as the file holds names,
 * the URL for a bookmark without one.
 * @param {PlacesNode} node
 */
function placesTitle(node) {
  const title = cleanName(node.title ?? "");
  if (title) return title;
  return node.typeCode === TYPE_BOOKMARK ? cleanName(normUrl(node.uri)) : UNTITLED_FOLDER;
}

/**
 * A Places folder's bookmarks and folders as the file names them: a second item of one name is
 * `name (2)` (open question 1, answer a). Separators are left out (D16).
 * @param {readonly PlacesNode[]} children
 */
function placesNamed(children) {
  // Linear even for thousands of one title (Sync, an import): slice 4's shared namer.
  const unique = uniqueNamer();
  /** @type {{ node: PlacesNode, kind: "bookmark" | "folder", name: string, url: string | null }[]} */
  const out = [];
  for (const node of children) {
    const kind =
      node.typeCode === TYPE_BOOKMARK
        ? "bookmark"
        : node.typeCode === TYPE_FOLDER
          ? "folder"
          : null;
    if (!kind || !node.guid) continue;
    const name = unique(placesTitle(node), kind);
    out.push({ node, kind, name, url: kind === "bookmark" ? normUrl(node.uri) : null });
  }
  return out;
}

/**
 * @param {"bookmark" | "folder"} kind
 * @param {string} name
 * @param {string | null} url
 * @returns {MNode}
 */
function mk(kind, name, url) {
  return {
    kind,
    name,
    url,
    id: null,
    parent: null,
    children: [],
    fileKids: [],
    line: null,
    raw: null,
    hadLines: false,
    fromPlaces: false,
    dropped: false,
    same: false,
  };
}

/** @param {MNode} parent @param {MNode} node */
function attach(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

/** @param {MNode} node */
function detach(node) {
  const p = node.parent;
  if (p) p.children = p.children.filter((c) => c !== node);
  node.parent = null;
}

/**
 * A table's lines as a tree, in file order: each folder at its first line (D3).
 * @param {ScanTable} t
 */
function fileTree(t) {
  const root = mk("folder", "", null);
  /** @type {Map<string, MNode>} */
  const folders = new Map([["", root]]);
  for (const l of t.lines) {
    const names = l.folder ? l.names : l.names.slice(0, -1);
    let at = root;
    for (let i = 0; i < names.length; i++) {
      const key = names.slice(0, i + 1).join("\0");
      let f = folders.get(key);
      if (!f) {
        f = mk("folder", /** @type {string} */ (names[i]), null);
        at.hadLines = true;
        attach(at, f);
        folders.set(key, f);
      }
      at = f;
    }
    if (l.folder) {
      if (at.line === null) at.line = l.line;
      continue;
    }
    const u = lineUrl(l.value);
    const b = mk("bookmark", /** @type {string} */ (l.names.at(-1)), "url" in u ? u.url : l.value);
    b.line = l.line;
    b.raw = l.value;
    at.hadLines = true;
    attach(at, b);
  }
  /** @type {MNode[]} */
  const stack = [root];
  while (stack.length) {
    const n = /** @type {MNode} */ (stack.pop());
    n.fileKids = [...n.children];
    for (const c of n.children) if (c.kind === "folder") stack.push(c);
  }
  return root;
}

/**
 * Every node under `root` with its path, depth first, in order.
 * @param {MNode} root
 * @returns {{ node: MNode, path: string[] }[]}
 */
function walk(root) {
  /** @type {{ node: MNode, path: string[] }[]} */
  const out = [];
  /** @type {[MNode, string[]][]} */
  const stack = [...root.children]
    .reverse()
    .map((c) => /** @type {[MNode, string[]]} */ ([c, [c.name]]));
  while (stack.length) {
    const [n, path] = /** @type {[MNode, string[]]} */ (stack.pop());
    out.push({ node: n, path });
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = /** @type {MNode} */ (n.children[i]);
      stack.push([c, [...path, c.name]]);
    }
  }
  return out;
}

/**
 * A tree's shape for comparing: names, kinds, URLs and order.
 * @param {MNode} root
 */
function shapeOf(root) {
  return JSON.stringify(
    walk(root).map(({ node, path }) => [node.kind, path, node.kind === "bookmark" ? node.url : ""]),
  );
}

/**
 * The shape of a parsed table, as shapeOf gives a merged one.
 * @param {readonly import("./bookmarks-file.mjs").FileItem[]} items
 */
function parsedShape(items) {
  /** @type {[string, string[], string][]} */
  const out = [];
  /** @type {[import("./bookmarks-file.mjs").FileItem, string[]][]} */
  const stack = [...items].reverse().map((i) => [i, [i.title]]);
  while (stack.length) {
    const [i, path] = /** @type {[import("./bookmarks-file.mjs").FileItem, string[]]} */ (
      stack.pop()
    );
    out.push([i.kind, path, i.kind === "bookmark" ? i.url : ""]);
    if (i.kind === "folder") {
      for (let k = i.children.length - 1; k >= 0; k--) {
        const c = /** @type {import("./bookmarks-file.mjs").FileItem} */ (i.children[k]);
        stack.push([c, [...path, c.title]]);
      }
    }
  }
  return JSON.stringify(out);
}

/**
 * The line numbers of the longest run of `refs` that is already in order: those lines stay, the
 * others move (so a moved bookmark is one line of diff).
 * @param {readonly number[]} refs
 * @returns {Set<number>}
 */
function inOrder(refs) {
  /** @type {number[]} tails[k]: index in refs of the smallest tail of a run of length k + 1 */
  const tails = [];
  /** @type {number[]} */
  const prev = new Array(refs.length).fill(-1);
  for (let i = 0; i < refs.length; i++) {
    const v = /** @type {number} */ (refs[i]);
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (/** @type {number} */ (refs[/** @type {number} */ (tails[mid])]) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = /** @type {number} */ (tails[lo - 1]);
    tails[lo] = i;
  }
  /** @type {Set<number>} */
  const out = new Set();
  for (
    let i = tails.length ? /** @type {number} */ (tails.at(-1)) : -1;
    i >= 0;
    i = /** @type {number} */ (prev[i])
  ) {
    out.add(/** @type {number} */ (refs[i]));
  }
  return out;
}

/**
 * The order of each folder that `seq` makes (each folder at its first line), by path key.
 * @param {readonly Leaf[]} seq
 */
function orderOfLines(seq) {
  /** @type {Map<string, string[]>} folder path → its children as `kind\0name`, in order */
  const order = new Map([["", []]]);
  /** @type {Set<string>} */
  const seen = new Set();
  for (const l of seq) {
    const folders = l.folder ? l.names : l.names.slice(0, -1);
    for (let i = 0; i <= folders.length; i++) {
      const parent = folders.slice(0, i).join("\0");
      const isLeaf = i === folders.length;
      if (isLeaf && l.folder) break;
      const name = isLeaf
        ? /** @type {string} */ (l.names.at(-1))
        : /** @type {string} */ (folders[i]);
      const kind = isLeaf ? "bookmark" : "folder";
      const key = `${parent}\u0001${kind}\0${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let list = order.get(parent);
      if (!list) order.set(parent, (list = []));
      list.push(`${kind}\0${name}`);
      if (kind === "folder" && !order.has(folders.slice(0, i + 1).join("\0"))) {
        order.set(folders.slice(0, i + 1).join("\0"), []);
      }
    }
  }
  return order;
}

/**
 * Merges Places' outside changes into the bookmarks file (Delivery slice 3). Returns the file's
 * new text (null when it needs no change), the base to plan the run with (each item at its new
 * path, with its guid), and what the host says or asks:
 *
 * - `removing`: bookmarks the edit removes per table, for Behaviour 13's question (D14);
 * - `conflicts`: items both sides changed, where the file won and Places is put back;
 * - `putBack`: those items (and changes the file cannot take) by table and guid (Sync keeps it
 *   across devices; `table` for the table's folder), for the loop guard;
 * - `renamed`: Places items written under another name (Behaviour 15);
 * - `keep`: Places items the file does not hold that stay as they are (planMirror's `keep`);
 * - `local`: of `local`, the items still there.
 *
 * `local` lists items made in a private window (Behaviour 12): they stay in Places and out of the
 * file, as everything under them. `putBackGuids` lists items whose Places change is not written
 * (made in a private window) but put back. A table in `hold` (the loop guard) is left as it is.
 * `keepRemovals` (the user answered `n` to Behaviour 13's question, or did not answer): every
 * removal Places made, a workspace folder's included, is put back from the file, while the rest
 * of the change (additions, renames, moves) is still written, so declining a removal never
 * deletes what the same batch added.
 *
 * @param {{ text: string, source: BookmarksSource, base: { tables: BaseTable[] },
 *   places: PlacesNode, bookmarklets: BookmarkletsSetting, hold?: ReadonlySet<string>,
 *   local?: ReadonlySet<string>, putBackGuids?: ReadonlySet<string>,
 *   keepRemovals?: boolean }} input
 * @returns {{ ok: true, text: string | null, base: { tables: BaseTable[] },
 *   removing: { table: string, count: number, had: number }[],
 *   conflicts: { table: string, path: string[], what: "change" | "removal" }[],
 *   putBack: { table: string, id: string }[],
 *   renamed: { table: string, from: string, to: string }[],
 *   keep: string[], local: string[] } | { ok: false, error: string }}
 */
export function mergeOutside(input) {
  const { text, source, base, places, bookmarklets } = input;
  const hold = input.hold ?? new Set();
  const local = input.local ?? new Set();
  const noWrite = input.putBackGuids ?? new Set();
  const keepRemovals = input.keepRemovals === true;
  const s = scanBookmarkLines(text);
  if ("error" in s) return { ok: false, error: `${source}: ${s.error}` };
  const all = indexPlaces(places);
  const toolbar = all.get(PLACES_ROOTS.toolbar)?.node;
  const baseFolders = new Set(base.tables.map((t) => t.folder));
  const fileTables = new Map(s.tables.map((t) => [t.name, t]));

  /** @type {{ table: string, count: number, had: number }[]} */
  const removing = [];
  /** @type {{ table: string, path: string[], what: "change" | "removal" }[]} */
  const conflicts = [];
  /** @type {{ table: string, id: string }[]} */
  const putBack = [];
  /** @type {{ table: string, from: string, to: string }[]} */
  const renamed = [];
  /** @type {string[]} */
  const keep = [];
  /** @type {Set<string>} */
  const localNow = new Set();
  /** @type {LineOp[]} */
  const ops = [];
  /** @type {LineOp[]} renames and removals of tables, after the line edits (they name tables) */
  const tail = [];
  /** @type {Map<string, BaseTable>} table name → its next base, by the base's order */
  const next = new Map();
  /** @type {Map<string, MNode>} final table name → its merged tree, to check the edit against */
  const merged = new Map();
  /** @type {Set<string>} the file's table names once the edit is done */
  const names = new Set(fileTables.keys());

  /**
   * Each base table's folder now (D6): the base's while it is at the toolbar's top, else (a guid
   * Sync's dedupe changed) the one top-level folder of the table's name no other table holds.
   * @type {{ t: BaseTable, folder: string | null, status: "ok" | "held" | "fileGone" | "gone" }[]}
   */
  const resolved = [];
  /** @type {Set<string>} */
  const taken = new Set();
  for (const t of base.tables) {
    if (hold.has(t.name)) {
      resolved.push({ t, folder: t.folder, status: "held" });
      taken.add(t.folder);
    } else if (!fileTables.has(t.name)) {
      resolved.push({ t, folder: t.folder, status: "fileGone" });
      taken.add(t.folder);
    }
  }
  for (const t of base.tables) {
    if (hold.has(t.name) || !fileTables.has(t.name)) continue;
    const at = all.get(t.folder);
    if (at && at.node.typeCode === TYPE_FOLDER && at.parent === PLACES_ROOTS.toolbar) {
      resolved.push({ t, folder: t.folder, status: "ok" });
      taken.add(t.folder);
    } else if (!at) {
      // Only when exactly one such folder is there: a second folder of the name may be the
      // user's own, and reading against it would count every bookmark as removed.
      const candidates = (toolbar?.children ?? []).filter(
        (c) =>
          c.typeCode === TYPE_FOLDER &&
          c.guid &&
          !baseFolders.has(c.guid) &&
          !taken.has(c.guid) &&
          placesTitle(c) === t.name,
      );
      const alias = candidates.length === 1 ? candidates[0] : undefined;
      if (alias?.guid) {
        resolved.push({ t, folder: alias.guid, status: "ok" });
        taken.add(alias.guid);
      } else resolved.push({ t, folder: null, status: "gone" });
    } else resolved.push({ t, folder: null, status: "gone" });
  }

  /** A table's file lines as (kind, path, url) keys: whether the file changed it since the base. */
  const fileChanged = (/** @type {BaseTable} */ t, /** @type {ScanTable} */ ft) => {
    const want = new Set(
      t.entries.map((e) => `${keyOf(e.kind, e.path)}\u0001${e.kind === "bookmark" ? e.url : ""}`),
    );
    const got = new Set(
      walk(fileTree(ft)).map(
        ({ node, path }) =>
          `${keyOf(node.kind, path)}\u0001${node.kind === "bookmark" ? node.url : ""}`,
      ),
    );
    return want.size !== got.size || [...got].some((k) => !want.has(k));
  };

  // Tables whose folder went (Behaviour 20, "all"): a removal of the table, unless the file
  // changed it meanwhile, which keeps it and its folder is made again.
  /** @type {Set<string>} the folders of tables that stay: no other table writes what they hold */
  const tableFolders = new Set();
  for (const r of resolved) {
    if (r.status !== "gone") {
      if (r.folder) tableFolders.add(r.folder);
      continue;
    }
    const ft = /** @type {ScanTable} */ (fileTables.get(r.t.name));
    if (keepRemovals) {
      r.status = "fileGone"; // declined: the run makes its folder again
      tableFolders.add(r.t.folder);
      continue;
    }
    if (fileChanged(r.t, ft)) {
      conflicts.push({ table: r.t.name, path: [], what: "removal" });
      putBack.push({ table: r.t.name, id: "table" });
      r.status = "fileGone"; // kept as it is: the run makes its folder again
      tableFolders.add(r.t.folder);
      continue;
    }
    const had = r.t.entries.filter((e) => e.kind === "bookmark").length;
    removing.push({ table: r.t.name, count: had, had });
    tail.push({ op: "removeTable", name: r.t.name });
    names.delete(r.t.name);
  }

  for (const r of resolved) {
    if (r.status === "held" || r.status === "fileGone") {
      next.set(r.t.name, structuredClone(r.t));
      continue;
    }
    if (r.status !== "ok") continue;
    const t = r.t;
    const ft = /** @type {ScanTable} */ (fileTables.get(t.name));
    const folderNode = /** @type {PlacesNode} */ (all.get(/** @type {string} */ (r.folder))?.node);
    const table = mergeTable(t, ft, /** @type {string} */ (r.folder), folderNode);
    if ("error" in table) return { ok: false, error: table.error };
    // The workspace's folder renamed (Behaviour 20, "all"): the table's header is renamed, when
    // the new name is one a table can have and the file has no table of it.
    let name = t.name;
    const title = placesTitle(folderNode);
    if (title !== t.name) {
      const otherBase = base.tables.some((b) => b !== t && b.name === title);
      if (!tableNameProblem(title) && !names.has(title) && !otherBase && !noWrite.has(t.folder)) {
        tail.push({ op: "renameTable", from: t.name, to: title });
        names.delete(t.name);
        names.add(title);
        name = title;
      } else putBack.push({ table: t.name, id: "table" });
    }
    merged.set(name, table.root);
    next.set(t.name, { name, folder: /** @type {string} */ (r.folder), entries: table.entries });
  }

  /**
   * The merge of one table whose folder is there.
   * @param {BaseTable} t
   * @param {ScanTable} ft
   * @param {string} folder  its folder's guid now
   * @param {PlacesNode} folderNode
   * @returns {{ root: MNode, entries: BaseEntry[] } | { error: string }}
   */
  function mergeTable(t, ft, folder, folderNode) {
    const root = fileTree(ft);
    // The base: each entry by path, by URL, its parent's guid ("" for the folder itself), and each
    // folder's children in the order both sides last agreed on.
    /** @type {Map<string, BaseEntry>} */
    const byPath = new Map();
    /** @type {Map<string, BaseEntry[]>} */
    const byUrl = new Map();
    for (const e of t.entries) {
      byPath.set(keyOf(e.kind, e.path), e);
      if (e.kind === "bookmark" && e.url) {
        const list = byUrl.get(e.url) ?? [];
        list.push(e);
        byUrl.set(e.url, list);
      }
    }
    const baseGuids = new Set(t.entries.map((e) => e.guid));
    /** @param {BaseEntry} e */
    const baseParent = (e) =>
      e.path.length === 1 ? "" : (byPath.get(keyOf("folder", e.path.slice(0, -1)))?.guid ?? null);
    /** @type {Map<string, string[]>} */
    const baseKids = new Map();
    for (const e of t.entries) {
      const p = baseParent(e);
      if (p === null) continue;
      const list = baseKids.get(p) ?? [];
      list.push(e.guid);
      baseKids.set(p, list);
    }

    // The file's lines matched to the base as the plan matches them (D4): by path, else a
    // bookmark by the one base entry of its URL whose path the file no longer has.
    const nodes = walk(root);
    const filePaths = new Set(nodes.map(({ node, path }) => keyOf(node.kind, path)));
    /** @type {Map<string, MNode>} base guid → the file's node */
    const fileOf = new Map();
    for (const { node, path } of nodes) {
      const e = byPath.get(keyOf(node.kind, path));
      if (!e) continue;
      node.id = e.guid;
      node.same = node.kind === "folder" || node.url === e.url;
      fileOf.set(e.guid, node);
    }
    for (const { node } of nodes) {
      if (node.id || node.kind !== "bookmark") continue;
      const list = byUrl.get(/** @type {string} */ (node.url)) ?? [];
      const only = list.length === 1 ? list[0] : undefined;
      if (only && !filePaths.has(keyOf("bookmark", only.path)) && !fileOf.has(only.guid)) {
        node.id = only.guid;
        node.same = false;
        fileOf.set(only.guid, node);
      }
    }

    // Places under the table's folder, each item named as the file would name it, other tables'
    // folders left to them. An item the base does not know that the file will not hold (a URL it
    // refuses, a path deeper than it allows, one made in a private window) stays in Places as it
    // is, with everything in it, and takes no name from the items the file holds.
    /** @type {Map<string, PItem>} Places guid → item */
    const byReal = new Map();
    /** @type {Map<string, string[]>} Places parent ("" the table's folder) → children */
    const realKids = new Map();
    /** @type {string[]} Places folders holding an item that stays: never removed with it */
    const stayIn = [];
    /** @type {[PlacesNode, string, number][]} */
    const stack = [[folderNode, "", 0]];
    while (stack.length) {
      const [n, id, depth] = /** @type {[PlacesNode, string, number]} */ (stack.pop());
      /** @type {PlacesNode[]} */
      const kids = [];
      for (const c of n.children ?? []) {
        if (!c.guid || tableFolders.has(c.guid)) continue;
        if (c.typeCode !== TYPE_BOOKMARK && c.typeCode !== TYPE_FOLDER) continue;
        const own = baseGuids.has(c.guid);
        const isPrivate = !own && (local.has(c.guid) || noWrite.has(c.guid));
        const refused =
          !own &&
          (depth + 1 > MAX_BOOKMARK_DEPTH ||
            (c.typeCode === TYPE_BOOKMARK && "error" in writableUrl(normUrl(c.uri), bookmarklets)));
        if (!isPrivate && !refused) {
          kids.push(c);
          continue;
        }
        if (isPrivate) localNow.add(c.guid);
        else stayIn.push(id);
        /** @type {PlacesNode[]} */
        const under = [c];
        while (under.length) {
          const x = /** @type {PlacesNode} */ (under.pop());
          if (x.guid && (x.typeCode === TYPE_BOOKMARK || x.typeCode === TYPE_FOLDER))
            keep.push(x.guid);
          under.push(...(x.children ?? []));
        }
      }
      /** @type {string[]} */
      const list = [];
      for (const k of placesNamed(kids)) {
        const g = /** @type {string} */ (k.node.guid);
        byReal.set(g, {
          kind: k.kind,
          name: k.name,
          url: k.url,
          parent: id,
          real: g,
          depth: depth + 1,
        });
        list.push(g);
        if (k.kind === "folder") stack.push([k.node, g, depth + 1]);
      }
      realKids.set(id, list);
    }
    /** @param {string} g @returns {string[]} */
    const placesPath = (g) => {
      /** @type {string[]} */
      const out = [];
      for (let at = byReal.get(g); at; at = at.parent ? byReal.get(at.parent) : undefined) {
        out.unshift(at.name);
        if (out.length > MAX_BOOKMARK_DEPTH + 1) break;
      }
      return out;
    };

    // A base item whose guid Sync's dedupe changed is the Places item of the same kind, path and
    // URL that the base does not know.
    /** @type {Map<string, string>} new guid → base guid */
    const aliasOf = new Map();
    /** @type {Map<string, string>} */
    const unknown = new Map();
    for (const [g, p] of byReal) {
      if (!baseGuids.has(g)) unknown.set(`${keyOf(p.kind, placesPath(g))}\u0001${p.url ?? ""}`, g);
    }
    for (const e of t.entries) {
      if (byReal.has(e.guid)) continue;
      const g = unknown.get(`${keyOf(e.kind, e.path)}\u0001${e.kind === "bookmark" ? e.url : ""}`);
      if (g && !aliasOf.has(g)) aliasOf.set(g, e.guid);
    }
    const canon = (/** @type {string} */ g) => aliasOf.get(g) ?? g;
    /** @type {Map<string, PItem>} identity (base guid, else Places guid) → item */
    const P = new Map();
    for (const [g, p] of byReal) P.set(canon(g), { ...p, parent: p.parent ? canon(p.parent) : "" });
    /** @type {Map<string, string[]>} */
    const porder = new Map();
    for (const [parent, list] of realKids) porder.set(parent ? canon(parent) : "", list.map(canon));
    const real = (/** @type {string} */ id) => P.get(id)?.real ?? id;

    /** @param {PItem} p */
    const writable = (p) =>
      p.depth <= MAX_BOOKMARK_DEPTH &&
      (p.kind === "folder" ||
        !("error" in writableUrl(/** @type {string} */ (p.url), bookmarklets)));

    /** @type {Map<string, MNode>} identity → its node in the merged tree */
    const nodeOf = new Map(fileOf);
    /**
     * The file's own items (no base guid) of each folder, by kind, name and URL: an item Places
     * added there too is the same item.
     * @type {Map<MNode, Map<string, MNode>>}
     */
    const fileOnly = new Map();
    /** @param {MNode} folder @param {string} key */
    const takeFileOnly = (folder, key) => {
      let index = fileOnly.get(folder);
      if (!index) {
        index = new Map();
        for (const c of folder.children) {
          const k = `${c.kind}\0${c.name}\0${c.url ?? ""}`;
          if (c.id === null && !index.has(k)) index.set(k, c);
        }
        fileOnly.set(folder, index);
      }
      const n = index.get(key);
      if (n) index.delete(key);
      return n;
    };
    /** @param {string} id @returns {MNode} */
    const ensureFolder = (id) => {
      /** @type {string[]} */
      const chain = [];
      let at = id;
      while (at !== "" && !nodeOf.has(at) && chain.length <= MAX_BOOKMARK_DEPTH + 1) {
        const p = P.get(at);
        if (!p) break;
        chain.push(at);
        at = p.parent;
      }
      let parent = at === "" ? root : (nodeOf.get(at) ?? root);
      for (const c of chain.reverse()) {
        const p = /** @type {PItem} */ (P.get(c));
        // A folder the file added under the same name is the same folder.
        let n = takeFileOnly(parent, `folder\0${p.name}\0`);
        if (n) n.id = c;
        else {
          n = mk("folder", p.name, null);
          n.id = c;
          n.fromPlaces = true;
          attach(parent, n);
        }
        nodeOf.set(c, n);
        parent = n;
      }
      return id === "" ? root : (nodeOf.get(id) ?? root);
    };
    /** @param {MNode} n */
    const pathOf = (n) => {
      /** @type {string[]} */
      const out = [];
      for (let at = /** @type {MNode | null} */ (n); at && at !== root; at = at.parent)
        out.unshift(at.name);
      return out;
    };
    /** @param {MNode} n @param {"change" | "removal"} what */
    const conflict = (n, what) => {
      const path = pathOf(n);
      conflicts.push({ table: t.name, path, what });
      putBack.push({ table: t.name, id: n.id ? `guid\0${n.id}` : keyOf(n.kind, path) });
    };

    // Each base item, by what each side did to it since the base.
    /** @type {string[]} */
    const accepted = [];
    /** @type {string[]} */
    const fromPlaces = [];
    let dropped = 0;
    for (const e of t.entries) {
      const p = P.get(e.guid);
      const f = fileOf.get(e.guid);
      let pState = !p
        ? "removed"
        : p.parent !== baseParent(e) ||
            p.name !== e.path.at(-1) ||
            (e.kind === "bookmark" && p.url !== e.url)
          ? "changed"
          : "same";
      const fState = !f ? "removed" : f.same ? "same" : "changed";
      // A removal the user declined: the file's line stays and Places gets it back.
      if (pState === "removed" && keepRemovals) pState = "same";
      // Made in a private window, or a change the file cannot hold: put back (Behaviour 12, 4).
      if (pState === "changed" && p && (noWrite.has(p.real) || !writable(p))) {
        putBack.push({ table: t.name, id: `guid\0${e.guid}` });
        pState = "same";
      }
      // Both sides made the same change (Sync and git carrying one edit): nothing to do.
      if (pState === "changed" && p && f && fState === "changed") {
        const fParent = f.parent === root ? "" : (f.parent?.id ?? null);
        if (f.name === p.name && f.url === p.url && fParent === p.parent) pState = "same";
      }
      if (pState === "changed") {
        if (fState === "same") accepted.push(e.guid);
        else if (fState === "changed") conflict(/** @type {MNode} */ (f), "change");
        else if (e.kind === "bookmark") fromPlaces.push(e.guid);
      } else if (pState === "removed") {
        if (fState === "same") {
          const n = /** @type {MNode} */ (f);
          if (n.kind === "bookmark") {
            detach(n);
            nodeOf.delete(e.guid);
            dropped++;
          } else n.dropped = true;
        } else if (fState === "changed") conflict(/** @type {MNode} */ (f), "removal");
      }
    }
    // Items only Places has, in Places' order: written where Places has them.
    /** @type {string[]} */
    const added = [];
    /** @type {string[]} */
    const order = [""];
    for (let i = 0; i < order.length; i++) {
      for (const id of porder.get(/** @type {string} */ (order[i])) ?? []) {
        if (P.get(id)?.kind === "folder") order.push(id);
        if (!baseGuids.has(id)) added.push(id);
      }
    }

    for (const id of accepted) {
      const n = /** @type {MNode} */ (nodeOf.get(id));
      const p = /** @type {PItem} */ (P.get(id));
      n.name = p.name;
      n.fromPlaces = true;
      if (n.kind === "bookmark" && n.url !== p.url) {
        n.url = p.url;
        n.raw = null;
      }
      const to = ensureFolder(p.parent);
      if (n.parent !== to) {
        detach(n);
        attach(to, n);
      }
    }
    for (const id of [...fromPlaces, ...added]) {
      const p = /** @type {PItem} */ (P.get(id));
      if (p.kind === "folder") {
        ensureFolder(id);
        continue;
      }
      const to = ensureFolder(p.parent);
      // A bookmark the file added at the same place is the same bookmark.
      const same = takeFileOnly(to, `bookmark\0${p.name}\0${p.url ?? ""}`);
      if (same) {
        same.id = id;
        nodeOf.set(id, same);
        continue;
      }
      const n = mk("bookmark", p.name, p.url);
      n.id = id;
      n.fromPlaces = true;
      nodeOf.set(id, n);
      attach(to, n);
    }
    // The folders above an item that stays in Places stay, so the run never removes it with them.
    for (const id of stayIn) ensureFolder(id ? canon(id) : "");
    // Folders Places removed go once nothing the file keeps is left in them.
    for (let again = true; again;) {
      again = false;
      for (const n of nodeOf.values()) {
        if (n.kind !== "folder" || !n.dropped || !n.parent) continue;
        if (n.children.length) continue;
        detach(n);
        again = true;
      }
    }
    for (const n of nodeOf.values()) {
      if (n.kind === "folder" && n.dropped && n.parent) {
        n.dropped = false;
        conflict(n, "removal");
      }
    }
    if (dropped) {
      removing.push({
        table: t.name,
        count: dropped,
        had: t.entries.filter((e) => e.kind === "bookmark").length,
      });
    }

    // Names and order, folder by folder: a name Places gives that the file already uses is made
    // unique (Behaviour 15); a folder whose order the file did not change takes Places' order,
    // with the file's own new lines after the line they followed.
    /** @type {MNode[]} */
    const folders = [
      root,
      ...walk(root)
        .map((x) => x.node)
        .filter((n) => n.kind === "folder"),
    ];
    for (const d of folders) {
      // The file's own names first (they are unique already), then Places', made unique.
      const unique = uniqueNamer();
      for (const c of d.children) if (!c.fromPlaces) unique(c.name, c.kind);
      for (const c of d.children) {
        if (!c.fromPlaces) continue;
        const from = c.name;
        const name = unique(from, c.kind);
        if (name !== from) {
          c.name = name;
          renamed.push({ table: t.name, from, to: name });
        }
      }
      const pid = d === root ? "" : d.id !== null && P.has(d.id) ? d.id : null;
      if (pid === null) continue;
      const inPlaces = new Set(
        (porder.get(pid) ?? []).map((id) => nodeOf.get(id)).filter((n) => n && n.parent === d),
      );
      const was = baseKids.get(pid) ?? [];
      const wasSet = new Set(was);
      const fileRel = d.fileKids.map((n) => n.id).filter((id) => id !== null && wasSet.has(id));
      const fileSet = new Set(fileRel);
      const baseRel = was.filter((id) => fileSet.has(id));
      if (!samePath(/** @type {string[]} */ (fileRel), baseRel)) continue; // the file's order wins
      /** @type {MNode[]} */
      const result = (porder.get(pid) ?? [])
        .map((id) => /** @type {MNode} */ (nodeOf.get(id)))
        .filter((n) => inPlaces.has(n));
      // The others (the file's own lines) go after the child they follow in the file's order:
      // each run of them hangs on the last placed child before it, or at the front.
      const placed = new Set(result);
      /** @type {Map<MNode | null, MNode[]>} */
      const after = new Map();
      /** @type {MNode | null} */
      let anchor = null;
      for (const o of d.children) {
        if (placed.has(o)) anchor = o;
        else {
          const list = after.get(anchor) ?? [];
          list.push(o);
          after.set(anchor, list);
        }
      }
      d.children = [
        ...(after.get(null) ?? []),
        ...result.flatMap((n) => [n, ...(after.get(n) ?? [])]),
      ];
    }

    // The next base: every merged item at its path, with its guid in Places; a base item the file
    // removed and Places still has stays at its old path, so the run removes it as the file's
    // removal (Behaviour 6).
    /** @type {BaseEntry[]} */
    const entries = [];
    /** @type {Set<string>} */
    const keys = new Set();
    /** @type {Set<string>} */
    const placed = new Set();
    for (const { node, path } of walk(root)) {
      if (node.id === null) continue;
      if (node.kind === "bookmark" && !P.has(node.id) && !baseGuids.has(node.id)) continue;
      const e =
        node.kind === "bookmark"
          ? {
              path,
              kind: /** @type {const} */ ("bookmark"),
              url: /** @type {string} */ (node.url),
              guid: real(node.id),
            }
          : { path, kind: /** @type {const} */ ("folder"), guid: real(node.id) };
      entries.push(e);
      keys.add(keyOf(e.kind, path));
      placed.add(node.id);
    }
    for (const e of t.entries) {
      if (placed.has(e.guid) || !P.has(e.guid) || keys.has(keyOf(e.kind, e.path))) continue;
      entries.push({ ...structuredClone(e), guid: real(e.guid) });
    }

    // The lines: the merged tree depth first; existing lines keep their place and value where they
    // can, new ones go after the line before them, and a folder whose order the lines do not give
    // is laid out again in the merged order.
    /** @type {Leaf[]} */
    const leaves = [];
    for (const { node, path } of walk(root)) {
      if (node.kind === "bookmark") {
        const value =
          node.raw !== null && sameUrl(node.raw, node.url)
            ? node.raw
            : /** @type {string} */ (node.url);
        leaves.push({ ref: node.line, names: path, folder: false, value });
      } else if (!node.children.length || (node.line !== null && node.hadLines)) {
        leaves.push({ ref: node.line, names: path, folder: true, value: "" });
      }
    }
    /** @type {Map<number, Leaf>} */
    const byRef = new Map();
    for (const l of leaves) if (l.ref !== null) byRef.set(l.ref, l);
    /** @type {Map<Leaf | null, Leaf[]>} */
    const runs = new Map();
    /** @type {Leaf | null} */
    let anchor = null;
    let made = 0;
    for (const l of leaves) {
      if (l.ref !== null) anchor = l;
      else {
        l.id = `m${++made}`;
        const list = runs.get(anchor) ?? [];
        list.push(l);
        runs.set(anchor, list);
      }
    }
    /** @type {Leaf[]} */
    let seq = [...(runs.get(null) ?? [])];
    for (const l of ft.lines) {
      const leaf = byRef.get(l.line);
      if (leaf) seq.push(leaf, ...(runs.get(leaf) ?? []));
    }
    /** @type {Map<string, string[]>} folder path → its children, as the merged tree orders them */
    const wantOrder = new Map([["", root.children.map((c) => `${c.kind}\0${c.name}`)]]);
    for (const { node, path } of walk(root)) {
      if (node.kind === "folder")
        wantOrder.set(
          path.join("\0"),
          node.children.map((c) => `${c.kind}\0${c.name}`),
        );
    }
    // Every folder whose order the lines get wrong, found in one pass over the lines; each wrong
    // folder that no wrong folder holds is laid out again in the merged order, all in one pass.
    const wrongFolders = () => {
      const got = orderOfLines(seq);
      /** @type {Set<string>} */
      const out = new Set();
      for (const [path, want] of wantOrder) {
        if (!samePath(got.get(path) ?? [], want)) out.add(path);
      }
      return out;
    };
    for (let tries = 0; ; tries++) {
      const wrong = wrongFolders();
      if (!wrong.size) break;
      if (tries > 2) return { error: "the merged order could not be written" };
      /** The topmost wrong folder a line is in (its own empty-folder line included), or null. */
      const groupOf = (/** @type {Leaf} */ l) => {
        const depth = l.folder ? l.names.length : l.names.length - 1;
        for (let i = 0; i <= depth; i++) {
          const key = l.names.slice(0, i).join("\0");
          if (wrong.has(key)) return key;
        }
        return null;
      };
      /** @type {Map<string, Leaf[]>} each group's lines, in the merged order */
      const groups = new Map();
      for (const l of leaves) {
        const g = groupOf(l);
        if (g === null) continue;
        const list = groups.get(g) ?? [];
        list.push(l);
        groups.set(g, list);
      }
      /** @type {Leaf[]} */
      const next = [];
      /** @type {Set<string>} */
      const laid = new Set();
      for (const l of seq) {
        const g = groupOf(l);
        if (g === null) next.push(l);
        else if (!laid.has(g)) {
          laid.add(g);
          next.push(...(groups.get(g) ?? []));
        }
      }
      seq = next;
    }

    const scanned = new Map(ft.lines.map((l) => [l.line, l]));
    for (const l of ft.lines) if (!byRef.has(l.line)) ops.push({ op: "remove", line: l.line });
    for (const l of leaves) {
      if (l.ref === null) continue;
      const was = /** @type {import("./bookmarks-edit.mjs").ScanLine} */ (scanned.get(l.ref));
      /** @type {Extract<LineOp, { op: "replace" }>} */
      const op = { op: "replace", line: l.ref };
      if (!samePath(was.names, l.names) || was.folder !== l.folder) {
        op.names = l.names;
        op.folder = l.folder;
      }
      if (was.value !== l.value) op.value = l.value;
      if (op.names || op.value !== undefined) ops.push(op);
    }
    const stays = inOrder(seq.flatMap((l) => (l.ref === null ? [] : [l.ref])));
    /** @type {number | string} */
    let prev = 0;
    for (let i = 0; i < seq.length;) {
      const l = /** @type {Leaf} */ (seq[i]);
      if (l.ref === null) {
        /** @type {NewLine[]} */
        const lines = [];
        while (i < seq.length && /** @type {Leaf} */ (seq[i]).ref === null) {
          const n = /** @type {Leaf} */ (seq[i]);
          lines.push({
            names: n.names,
            folder: n.folder,
            value: n.value,
            id: /** @type {string} */ (n.id),
          });
          i++;
        }
        ops.push({ op: "add", table: t.name, after: prev, lines });
        prev = /** @type {string} */ (lines.at(-1)?.id);
        continue;
      }
      if (!stays.has(l.ref)) ops.push({ op: "move", line: l.ref, table: t.name, after: prev });
      prev = l.ref;
      i++;
    }
    return { root, entries };
  }

  /** @type {BaseTable[]} */
  const tables = [];
  for (const t of base.tables) {
    const n = next.get(t.name);
    if (n) tables.push(n);
  }
  const result = {
    base: { tables },
    removing,
    conflicts,
    putBack,
    renamed,
    keep,
    local: [...localNow],
  };
  const edits = [...ops, ...tail];
  if (!edits.length) return { ok: true, text: null, ...result };
  const r = editBookmarkLines(text, edits);
  if (!r.ok) return { ok: false, error: `${source}: ${r.error}` };
  const read =
    source === BOOKMARKS_FILE
      ? readBookmarks({ file: r.text, config: null })
      : readBookmarks({ file: null, config: r.text });
  const [problem] = read.errors;
  if (problem) return { ok: false, error: `${source}:${problem.line}: ${problem.message}` };
  for (const [name, root] of merged) {
    const got = read.tables.find((x) => x.name === name);
    if (!got || parsedShape(got.children) !== shapeOf(root)) {
      return {
        ok: false,
        error: `${source}: the merge would not read back as meant; nothing written`,
      };
    }
  }
  return { ok: true, text: r.text === text ? null : r.text, ...result };
}
