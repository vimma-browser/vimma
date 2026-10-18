/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The bookmarks panel and quick add (docs/specs/bookmarks.md): paths, the tree as rows, the
 * filter and the panel's keys, as pure functions over a tree the host reads from Places
 * (PlacesUtils.promiseBookmarksTree). The host renders it (ui/bookmarks-panel.mjs).
 */
import { scoreField } from "./picker.mjs";

/** Places' root folder guids (toolkit/components/places/Bookmarks.sys.mjs). */
export const PLACES_ROOTS = Object.freeze({
  menu: "menu________",
  toolbar: "toolbar_____",
  unfiled: "unfiled_____",
  mobile: "mobile______",
});

/** The most rows the panel keeps in the DOM at once (spec decision 9). */
export const RENDER_CAP = 100;

/** Places' item types (nsINavBookmarksService.TYPE_*). */
const TYPE_BOOKMARK = 1;
const TYPE_FOLDER = 2;

/**
 * @typedef {{ readonly guid: string, readonly kind: "bookmark", readonly title: string,
 *   readonly url: string }} Bookmark
 */
/**
 * `root`: one of Places' roots, which cannot be renamed, moved or deleted.
 * @typedef {{ readonly guid: string, readonly kind: "folder", readonly title: string,
 *   readonly root?: "menu" | "toolbar" | "other" | "mobile" | "workspace",
 *   readonly children: readonly Node[] }} Folder
 */
/** @typedef {Bookmark | Folder} Node */
/**
 * One line of the panel. `title` is what it shows (a bookmark without one shows its URL);
 * `parent` the folder it is in; `path` that folder's path (shown by the filter's flat list);
 * `size` a folder's item count.
 * @typedef {{ readonly guid: string, readonly kind: "bookmark" | "folder", readonly title: string,
 *   readonly url: string, readonly depth: number, readonly open: boolean, readonly size: number,
 *   readonly parent: string, readonly path: string, readonly root: boolean }} Row
 */
/**
 * @typedef {{ readonly tree: Folder, readonly expanded: readonly string[], readonly query: string,
 *   readonly rows: readonly Row[], readonly selected: number }} BookmarksState
 */
/**
 * @typedef {{ type: "open", url: string, where: "current" | "tab" | "vertical" | "horizontal" }
 *   | { type: "add" | "add_folder", folder: string }
 *   | { type: "rename", guid: string, title: string }
 *   | { type: "move", guid: string, from: string }
 *   | { type: "delete", guid: string, kind: "bookmark" | "folder", title: string, count: number }
 *   | { type: "yank", url: string }
 *   | { type: "refuse", text: string }
 *   | { type: "filter" } | { type: "close" }} BookmarksEffect
 */

/**
 * A typed path: folders, then the bookmark's title; `leaf` is null after a trailing `/`.
 * Segments are trimmed and empty ones dropped; `\/` is a slash in a name, `\\` a backslash.
 * @param {string} text
 * @returns {{ folders: string[], leaf: string | null }}
 */
export function parseBookmarkPath(text) {
  /** @type {string[]} */
  const parts = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\\" && (next === "/" || next === "\\")) {
      cur += next;
      i++;
    } else if (c === "/") {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  const last = cur.trim();
  const folders = parts.map((p) => p.trim()).filter(Boolean);
  return { folders, leaf: last || null };
}

/**
 * The names as a path parseBookmarkPath reads back.
 * @param {readonly string[]} names
 */
export function formatBookmarkPath(names) {
  return names.map((n) => n.replace(/\\/g, "\\\\").replace(/\//g, "\\/")).join("/");
}

/**
 * @typedef {{ guid?: string, typeCode?: number, title?: string, uri?: string,
 *   children?: PlacesItem[] }} PlacesItem  what promiseBookmarksTree gives
 */

/**
 * @param {PlacesItem} item
 * @returns {Node | null}
 */
function convert(item) {
  if (item.typeCode === TYPE_BOOKMARK && item.uri) {
    return Object.freeze({
      guid: String(item.guid),
      kind: "bookmark",
      title: item.title ?? "",
      url: item.uri,
    });
  }
  if (item.typeCode === TYPE_FOLDER) return folderOf(item);
  return null; // separators
}

/**
 * @param {PlacesItem} item
 * @param {{ title?: string, root?: Folder["root"] }} [extra]
 * @param {Node[]} [before]
 * @returns {Folder}
 */
function folderOf(item, extra = {}, before = []) {
  const children = (item.children ?? []).map(convert).filter((n) => n !== null);
  return Object.freeze({
    guid: String(item.guid),
    kind: "folder",
    title: item.title ?? "",
    ...extra,
    children: Object.freeze([...before, ...children]),
  });
}

/**
 * What the panel is rooted at (config `[bookmarks] root`, spec decisions 2 and 11): the current
 * workspace's folder in the Bookmarks Toolbar, the toolbar's contents, or every bookmark under
 * the Menu.
 * @typedef {"workspace" | "toolbar" | "all"} BookmarksRoot
 */
export const BOOKMARKS_ROOTS = Object.freeze(
  /** @type {const} */ (["workspace", "toolbar", "all"]),
);

/**
 * Our tree from Places' (promiseBookmarksTree of the places root), spec decision 2.
 * `"toolbar"`: the Bookmarks Toolbar folder, its bookmarks and subfolders at the top, with no
 * root folder around them (`"workspace"` too: workspaceTree then picks a folder of it). `"all"`:
 * the Menu, with the toolbar, Other Bookmarks and (when not empty) mobile roots as its first
 * folders.
 * @param {PlacesItem} places
 * @param {BookmarksRoot} [root]
 * @returns {Folder}
 */
export function fromPlaces(places, root = "all") {
  const kids = places.children ?? [];
  const find = (/** @type {string} */ guid) => kids.find((k) => k.guid === guid);
  if (root === "toolbar" || root === "workspace") {
    const bar = find(PLACES_ROOTS.toolbar) ?? { guid: PLACES_ROOTS.toolbar, typeCode: TYPE_FOLDER };
    return folderOf(bar, { title: "", root: "toolbar" });
  }
  /** @type {Folder[]} */
  const roots = [];
  for (const [guid, name] of /** @type {const} */ ([
    [PLACES_ROOTS.toolbar, "toolbar"],
    [PLACES_ROOTS.unfiled, "other"],
    [PLACES_ROOTS.mobile, "mobile"],
  ])) {
    const item = find(guid);
    if (!item) continue;
    if (name === "mobile" && !item.children?.length) continue;
    roots.push(folderOf(item, { title: name, root: name }));
  }
  const menu = find(PLACES_ROOTS.menu) ?? { guid: PLACES_ROOTS.menu, typeCode: TYPE_FOLDER };
  return folderOf(menu, { title: "", root: "menu" }, roots);
}

/**
 * Every node with its parent folder, by guid.
 * @param {Folder} tree
 * @returns {Map<string, { node: Node, parent: Folder | null }>}
 */
function indexOf(tree) {
  /** @type {Map<string, { node: Node, parent: Folder | null }>} */
  const map = new Map([[tree.guid, { node: tree, parent: null }]]);
  /** @param {Folder} f */
  const walk = (f) => {
    for (const c of f.children) {
      map.set(c.guid, { node: c, parent: f });
      if (c.kind === "folder") walk(c);
    }
  };
  walk(tree);
  return map;
}

/** @type {WeakMap<Folder, Map<string, { node: Node, parent: Folder | null }>>} */
const indexes = new WeakMap();

/** @param {Folder} tree */
function index(tree) {
  let i = indexes.get(tree);
  if (!i) indexes.set(tree, (i = indexOf(tree)));
  return i;
}

/**
 * The tree's top folder as prompts name it ("add in bookmarks toolbar/").
 * @param {Folder} tree
 */
export function rootLabel(tree) {
  if (tree.root === "workspace") return `@${formatBookmarkPath([tree.title])}`;
  return tree.root === "toolbar" ? "bookmarks toolbar" : "bookmarks menu";
}

/**
 * A workspace as the bookmarks see it: `folder` is the guid it stored, if any.
 * @typedef {{ readonly id: string, readonly name: string,
 *   readonly folder?: string | null }} BookmarksWorkspace
 */

const PENDING = "vimma-ws:";

/**
 * The guid of workspace `ws`'s folder in the toolbar (`fromPlaces(places, "toolbar")`): the
 * folder it stored when that is still at the toolbar's top, else the first one there named
 * after it (made outside Vimma, or before the link), else null (spec decision 11).
 * @param {Folder} toolbar
 * @param {BookmarksWorkspace} ws
 * @returns {string | null}
 */
export function workspaceFolderGuid(toolbar, ws) {
  const folders = toolbar.children.filter((c) => c.kind === "folder");
  if (ws.folder && folders.some((f) => f.guid === ws.folder)) return ws.folder;
  return folders.find((f) => f.title === ws.name)?.guid ?? null;
}

/** @param {string} guid  a workspaceTree's guid before its folder exists */
export const isPendingFolder = (guid) => guid.startsWith(PENDING);

/** @param {string} guid  a pending guid's workspace id */
export const pendingWorkspaceId = (guid) => guid.slice(PENDING.length);

/**
 * The panel's tree for workspace `ws`: its folder's contents at the top, titled with the
 * workspace's name. Without a folder yet, an empty tree with a pending guid, which the host
 * turns into the folder on the first add.
 * @param {Folder} toolbar
 * @param {BookmarksWorkspace} ws
 * @returns {Folder}
 */
export function workspaceTree(toolbar, ws) {
  const guid = workspaceFolderGuid(toolbar, ws);
  const found = guid ? /** @type {Folder} */ (index(toolbar).get(guid)?.node) : null;
  return Object.freeze({
    guid: guid ?? `${PENDING}${ws.id}`,
    kind: "folder",
    title: ws.name,
    root: "workspace",
    children: found?.children ?? Object.freeze([]),
  });
}

/**
 * A path that starts with `@name/` is in workspace `name`'s folder; `\@` is a plain `@`.
 * @param {string} text
 * @returns {{ workspace: string | null, rest: string }}
 */
export function splitWorkspacePath(text) {
  const { workspace, rest } = splitAt(text);
  return { workspace, rest };
}

/**
 * splitWorkspacePath, and whether the name's `/` was typed.
 * @param {string} text
 */
function splitAt(text) {
  const t = text.trimStart();
  if (t.startsWith("\\@")) return { workspace: null, rest: t.slice(1), slash: false };
  if (!t.startsWith("@")) return { workspace: null, rest: text, slash: false };
  let name = "";
  let i = 1;
  for (; i < t.length; i++) {
    const c = t[i];
    const next = t[i + 1];
    if (c === "\\" && (next === "/" || next === "\\")) {
      name += next;
      i++;
    } else if (c === "/") break;
    else name += c;
  }
  return { workspace: name.trim(), rest: t.slice(i + 1), slash: i < t.length };
}

/**
 * Tab completion for a path from folder `base` of the current workspace's tree, or, after `@`,
 * a workspace's name, then that workspace's folders.
 * @param {{ current: Folder, workspaces: readonly { name: string, tree: Folder }[] }} trees
 * @param {string} base
 * @param {string} text
 * @returns {string[]}
 */
export function completeWorkspacePath(trees, base, text) {
  const { workspace, rest, slash } = splitAt(text);
  if (workspace === null) return completeFolder(trees.current, base, text);
  if (!slash) {
    const lower = workspace.toLowerCase();
    return trees.workspaces
      .filter((w) => w.name.toLowerCase().startsWith(lower))
      .map((w) => `@${formatBookmarkPath([w.name])}/`);
  }
  const target = trees.workspaces.find((w) => w.name === workspace);
  if (!target) return [];
  const head = `@${formatBookmarkPath([target.name])}/`;
  return completeFolder(target.tree, target.tree.guid, rest).map((c) => head + c);
}

/**
 * Whether `guid` is the tree's top folder or anything under it.
 * @param {Folder} tree
 * @param {string} guid
 */
export function inTree(tree, guid) {
  return index(tree).has(guid);
}

/**
 * A folder's names from the top (the top folder itself: []).
 * @param {Folder} tree
 * @param {string} guid
 * @returns {string[]}
 */
export function folderPath(tree, guid) {
  const idx = index(tree);
  /** @type {string[]} */
  const names = [];
  for (let e = idx.get(guid); e?.parent; e = idx.get(e.parent.guid)) names.unshift(e.node.title);
  return names;
}

/**
 * The child folder of `parent` named `name`: exactly, else case-insensitively when only one
 * matches.
 * @param {Folder} parent
 * @param {string} name
 * @returns {Folder | undefined}
 */
function childFolder(parent, name) {
  const folders = /** @type {Folder[]} */ (parent.children.filter((c) => c.kind === "folder"));
  const exact = folders.find((f) => f.title === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const loose = folders.filter((f) => f.title.toLowerCase() === lower);
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * Walks `names` down from folder `base`: the deepest folder that exists, and the names below
 * it still to create.
 * @param {Folder} tree
 * @param {string} base
 * @param {readonly string[]} names
 * @returns {{ guid: string, missing: string[] }}
 */
export function resolveFolders(tree, base, names) {
  const start = index(tree).get(base)?.node;
  let at = start?.kind === "folder" ? start : tree;
  let i = 0;
  for (; i < names.length; i++) {
    const next = childFolder(at, /** @type {string} */ (names[i]));
    if (!next) break;
    at = next;
  }
  return { guid: at.guid, missing: names.slice(i) };
}

/**
 * Tab completion for a path typed relative to folder `base`: the child folders of the folders
 * typed so far whose names start with the last segment, as whole lines ending in `/`.
 * @param {Folder} tree
 * @param {string} base
 * @param {string} text
 * @returns {string[]}
 */
export function completeFolder(tree, base, text) {
  // The last unescaped slash splits the typed folders from the partial name.
  let cut = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "/") cut = i;
  }
  const head = text.slice(0, cut + 1);
  const partial = (parseBookmarkPath(text.slice(cut + 1)).leaf ?? "").toLowerCase();
  const { folders } = parseBookmarkPath(head);
  const { guid, missing } = resolveFolders(tree, base, folders);
  if (missing.length) return [];
  const folder = /** @type {Folder} */ (index(tree).get(guid)?.node);
  return folder.children
    .filter((c) => c.kind === "folder" && c.title.toLowerCase().startsWith(partial))
    .map((c) => `${head}${formatBookmarkPath([c.title])}/`);
}

/**
 * Whether the panel opens this URL (spec decision 6): http(s), file and about: only.
 * @param {string} url
 */
export function isOpenable(url) {
  return /^(https?|file|about):/i.test(url.replace(/[\t\n\r]/g, "").trim());
}

/** @param {Node} node */
const display = (node) => node.title || (node.kind === "bookmark" ? node.url : "(untitled folder)");

/**
 * @param {Node} node
 * @param {number} depth
 * @param {Folder} parent
 * @param {boolean} open
 * @param {string} path
 * @returns {Row}
 */
function rowOf(node, depth, parent, open, path) {
  return Object.freeze({
    guid: node.guid,
    kind: node.kind,
    title: display(node),
    url: node.kind === "bookmark" ? node.url : "",
    depth,
    open,
    size: node.kind === "folder" ? node.children.length : 0,
    parent: parent.guid,
    path,
    root: node.kind === "folder" && !!node.root,
  });
}

/**
 * The tree as rows: the top level, and the children of every expanded folder under it.
 * @param {Folder} tree
 * @param {ReadonlySet<string>} expanded
 * @returns {Row[]}
 */
export function flattenTree(tree, expanded) {
  /** @type {Row[]} */
  const rows = [];
  /**
   * @param {Folder} f
   * @param {number} depth
   */
  const walk = (f, depth) => {
    for (const c of f.children) {
      const open = c.kind === "folder" && expanded.has(c.guid);
      rows.push(rowOf(c, depth, f, open, ""));
      if (open) walk(/** @type {Folder} */ (c), depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/**
 * Every bookmark matching `query` by title, URL or folder path (the pickers' matcher), best
 * first, as a flat list.
 * @param {Folder} tree
 * @param {string} query
 * @returns {Row[]}
 */
export function filterBookmarks(tree, query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  /** @type {Array<{ row: Row, score: number }>} */
  const found = [];
  /**
   * @param {Folder} f
   * @param {string} path
   */
  const walk = (f, path) => {
    for (const c of f.children) {
      if (c.kind === "folder") {
        walk(c, path ? `${path}/${c.title}` : c.title);
        continue;
      }
      let score = 0;
      let ok = true;
      for (const term of terms) {
        const best = Math.max(
          scoreField(display(c), term, "display")?.score ?? -1,
          scoreField(c.url, term, "url")?.score ?? -1,
          scoreField(path, term, "workspace")?.score ?? -1,
        );
        if (best < 0) {
          ok = false;
          break;
        }
        score += best;
      }
      if (ok) found.push({ row: rowOf(c, 0, f, false, path), score });
    }
  };
  walk(tree, "");
  // Stable: ties keep tree order.
  return found.sort((a, b) => b.score - a.score).map((f) => f.row);
}

/**
 * @param {Folder} tree
 * @param {readonly string[]} expanded
 * @param {string} query
 */
function rowsFor(tree, expanded, query) {
  return Object.freeze(
    query.trim() ? filterBookmarks(tree, query) : flattenTree(tree, new Set(expanded)),
  );
}

/**
 * The panel over `tree`, the highlight on `selectedGuid` when listed, else the first row.
 * @param {Folder} tree
 * @param {{ expanded?: readonly string[], selectedGuid?: string | null, query?: string }} [options]
 * @returns {BookmarksState}
 */
export function openBookmarks(tree, { expanded = [], selectedGuid = null, query = "" } = {}) {
  const idx = index(tree);
  const kept = Object.freeze(expanded.filter((g) => idx.get(g)?.node.kind === "folder"));
  const rows = rowsFor(tree, kept, query);
  const at = rows.findIndex((r) => r.guid === selectedGuid);
  return Object.freeze({ tree, expanded: kept, query, rows, selected: Math.max(0, at) });
}

/**
 * The panel after Places changed: expanded folders, the filter and the highlighted item stay;
 * an item gone leaves the highlight at its place.
 * @param {BookmarksState} state
 * @param {Folder} tree
 * @returns {BookmarksState}
 */
export function refreshBookmarks(state, tree) {
  const guid = state.rows[state.selected]?.guid ?? null;
  const next = openBookmarks(tree, {
    expanded: state.expanded,
    selectedGuid: guid,
    query: state.query,
  });
  if (next.rows[next.selected]?.guid === guid) return next;
  return Object.freeze({
    ...next,
    selected: Math.max(0, Math.min(state.selected, next.rows.length - 1)),
  });
}

/**
 * The filter changed (typing after `/`): the highlight goes to the best match.
 * @param {BookmarksState} state
 * @param {string} query
 * @returns {BookmarksState}
 */
export function setBookmarksQuery(state, query) {
  return Object.freeze({
    ...state,
    query,
    rows: rowsFor(state.tree, state.expanded, query),
    selected: 0,
  });
}

/**
 * @param {BookmarksState} state
 * @param {readonly string[]} expanded
 * @param {string} guid  the row to highlight
 * @returns {BookmarksState}
 */
function withExpanded(state, expanded, guid) {
  return openBookmarks(state.tree, { expanded, selectedGuid: guid, query: state.query });
}

/** @param {Row} row */
const refuseRoot = (row) => ({
  type: /** @type {const} */ ("refuse"),
  text: `${row.title} is a root folder: it can't be changed`,
});

/**
 * @param {Row} row
 * @param {"current" | "tab" | "vertical" | "horizontal"} where
 * @returns {BookmarksEffect}
 */
function openEffect(row, where) {
  if (row.kind === "folder") return { type: "refuse", text: `${row.title} is a folder` };
  if (!isOpenable(row.url)) {
    const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(row.url)?.[1]?.toLowerCase() ?? "this";
    return {
      type: "refuse",
      text: `${scheme}: bookmarks don't open from Vimma (only http, https, file, about)`,
    };
  }
  return { type: "open", url: row.url, where };
}

/**
 * Items in a folder and below it, for the delete question.
 * @param {Node} node
 * @returns {number}
 */
function countItems(node) {
  return node.kind === "folder" ? node.children.reduce((n, c) => n + 1 + countItems(c), 0) : 0;
}

/**
 * One panel action: `panel.*` (j, k, Enter, Esc) and `bookmarks.*` (defaults.mjs
 * `[modal.panel]`).
 * @param {BookmarksState} state
 * @param {{ id: string, arg?: number }} action
 * @returns {{ state: BookmarksState, effect: BookmarksEffect | null }}
 */
export function bookmarksKey(state, action) {
  const none = { state, effect: null };
  /** @param {BookmarksEffect} effect */
  const say = (effect) => ({ state, effect });
  if (action.id === "panel.close") {
    if (state.query) return { state: setBookmarksQuery(state, ""), effect: null };
    return say({ type: "close" });
  }
  if (action.id === "bookmarks.filter") return say({ type: "filter" });
  const row = state.rows[state.selected];
  /** @param {number} selected */
  const move = (selected) => ({ state: Object.freeze({ ...state, selected }), effect: null });
  const last = state.rows.length - 1;
  switch (action.id) {
    case "panel.down":
      return move(Math.max(0, Math.min(last, state.selected + 1)));
    case "panel.up":
      return move(Math.max(0, state.selected - 1));
    case "bookmarks.add":
    case "bookmarks.add_folder": {
      const folder = !row ? state.tree.guid : row.kind === "folder" ? row.guid : row.parent;
      return say({ type: action.id === "bookmarks.add" ? "add" : "add_folder", folder });
    }
  }
  if (!row) return none;
  const filtering = !!state.query.trim();
  switch (action.id) {
    case "panel.open":
      if (row.kind === "bookmark") return say(openEffect(row, "current"));
      if (filtering) return none;
      return {
        state: withExpanded(
          state,
          row.open ? state.expanded.filter((g) => g !== row.guid) : [...state.expanded, row.guid],
          row.guid,
        ),
        effect: null,
      };
    case "bookmarks.expand":
      if (row.kind === "bookmark") return say(openEffect(row, "current"));
      if (filtering) return none;
      if (!row.open) {
        return {
          state: withExpanded(state, [...state.expanded, row.guid], row.guid),
          effect: null,
        };
      }
      return row.size ? move(state.selected + 1) : none;
    case "bookmarks.collapse": {
      if (filtering) return none;
      if (row.kind === "folder" && row.open) {
        return {
          state: withExpanded(
            state,
            state.expanded.filter((g) => g !== row.guid),
            row.guid,
          ),
          effect: null,
        };
      }
      if (row.depth === 0) return none;
      return {
        state: withExpanded(
          state,
          state.expanded.filter((g) => g !== row.parent),
          row.parent,
        ),
        effect: null,
      };
    }
    case "bookmarks.open_tab":
      return say(openEffect(row, "tab"));
    case "bookmarks.open_vsplit":
      return say(openEffect(row, "vertical"));
    case "bookmarks.open_hsplit":
      return say(openEffect(row, "horizontal"));
    case "bookmarks.rename":
      if (row.root) return say(refuseRoot(row));
      return say({
        type: "rename",
        guid: row.guid,
        title: index(state.tree).get(row.guid)?.node.title ?? "",
      });
    case "bookmarks.move":
    case "panel.move": // `m`, shared with the side panel
      if (row.root) return say(refuseRoot(row));
      return say({ type: "move", guid: row.guid, from: row.parent });
    case "bookmarks.delete": {
      if (row.root) return say(refuseRoot(row));
      const node = /** @type {Node} */ (index(state.tree).get(row.guid)?.node);
      return say({
        type: "delete",
        guid: row.guid,
        kind: row.kind,
        title: row.title,
        count: countItems(node),
      });
    }
    case "bookmarks.yank":
      if (row.kind === "folder") return say({ type: "refuse", text: `${row.title} is a folder` });
      return say({ type: "yank", url: row.url });
    default:
      return none;
  }
}

/**
 * The first row to render of `count`, at most `cap` at once: the window starting at `start`
 * while it shows `selected`, else one centred on it, within bounds.
 * @param {number} count
 * @param {number} selected
 * @param {number} start
 * @param {number} [cap]
 */
export function renderStart(count, selected, start, cap = RENDER_CAP) {
  if (count <= cap) return 0;
  const max = count - cap;
  if (selected >= start && selected < start + cap && start <= max) return start;
  return Math.max(0, Math.min(max, selected - Math.floor(cap / 2)));
}
