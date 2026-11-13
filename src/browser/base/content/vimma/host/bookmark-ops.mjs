/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bookmarks over Firefox's Places (docs/specs/bookmarks.md, decision 1): reading the tree,
// filing a page under a typed path, renaming, moving and deleting. Paths and the tree's shape
// are core bookmarks.mjs; this only talks to PlacesUtils, and to the workspace store for the
// link between a workspace and its folder in the Bookmarks Toolbar (decision 11).

import {
  PLACES_ROOTS,
  folderPath,
  formatBookmarkPath,
  fromPlaces,
  inTree,
  isOpenable,
  isPendingFolder,
  parseBookmarkPath,
  pendingWorkspaceId,
  resolveFolders,
  splitWorkspacePath,
  workspaceFolderGuid,
  workspaceTree,
} from "../core/bookmarks.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/** @import { BookmarksRoot, BookmarksWorkspace, Folder } from "../core/bookmarks.mjs" */
/** @import { WorkspaceDefinition } from "../core/workspacedefs.mjs" */

/**
 * What a window's bookmark keys work on: `tree` is the panel's (the current workspace's folder,
 * the toolbar or the Menu); `workspaces` every workspace with its folder's tree (workspace root
 * only), for `@name/` paths; `current` the window's workspace there.
 * @typedef {{ tree: Folder, workspaces: (BookmarksWorkspace & { tree: Folder })[],
 *   current: BookmarksWorkspace | null }} Scope
 */

/** `[bookmarks] root` (spec decision 2), for every window: VimmaHost.configure sets it. */
/** @type {BookmarksRoot} */
let root = "workspace";

/**
 * Roots the tree at the workspace's folder, the toolbar or the Menu; paths and quick add follow.
 * @param {BookmarksRoot} next
 */
export function setBookmarksRoot(next) {
  root = next;
}

/** The root in force. */
export function bookmarksRoot() {
  return root;
}

/** @returns {any} PlacesUtils */
function places() {
  return ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
}

/** Places events that change what the panel lists (PlacesEvent.webidl). */
export const BOOKMARK_EVENTS = Object.freeze([
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
]);

/** @param {WorkspaceDefinition} d @returns {BookmarksWorkspace} */
const asWorkspace = (d) => ({ id: d.id, name: d.name, folder: d.bookmarksFolder ?? null });

/**
 * Stores the folder a workspace was found by (its name, for a folder made outside Vimma), so a
 * rename keeps it. A read-only store keeps finding it by name.
 * @param {string} id
 * @param {string | null} guid
 */
function link(id, guid) {
  try {
    WorkspaceStore.setBookmarksFolder(id, guid);
  } catch (e) {
    if (
      /** @type {any} */ (e)?.code !== "read-only" &&
      /** @type {any} */ (e)?.code !== "disabled"
    ) {
      console.error("vimma: bookmarks folder not linked", e);
    }
  }
}

/**
 * The window's scope at the configured root (core fromPlaces, workspaceTree). With the
 * workspace root, a window without workspaces (private, containers off) gets the toolbar.
 * @param {BrowserWindow | null} [win]
 * @returns {Promise<Scope>}
 */
export async function loadScope(win = null) {
  const all = await places().promiseBookmarksTree("");
  const model = win ? WindowWorkspaces.get(win)?.model : null;
  if (root !== "workspace" || !model) {
    return {
      tree: fromPlaces(all, root === "all" ? "all" : "toolbar"),
      workspaces: [],
      current: null,
    };
  }
  const toolbar = fromPlaces(all, "toolbar");
  const workspaces = WorkspaceStore.definitions.workspaces.map((d) => {
    const ws = asWorkspace(d);
    const tree = workspaceTree(toolbar, ws);
    if (!isPendingFolder(tree.guid) && tree.guid !== ws.folder) link(ws.id, tree.guid);
    return { ...ws, tree };
  });
  const current = workspaces.find((w) => w.id === model.active) ?? null;
  if (!current) return { tree: toolbar, workspaces: [], current: null };
  return { tree: current.tree, workspaces, current };
}

/**
 * The panel's tree for `win` (loadScope).
 * @param {BrowserWindow | null} [win]
 * @returns {Promise<Folder>}
 */
export async function loadTree(win = null) {
  return (await loadScope(win)).tree;
}

/**
 * Makes `missing` folders, one inside the next, under `parentGuid`.
 * @param {string} parentGuid
 * @param {readonly string[]} missing
 * @returns {Promise<string>} the guid of the deepest
 */
async function makeFolders(parentGuid, missing) {
  const PU = places();
  let guid = parentGuid;
  for (const title of missing) {
    ({ guid } = await PU.bookmarks.insert({
      parentGuid: guid,
      type: PU.bookmarks.TYPE_FOLDER,
      title,
    }));
  }
  return guid;
}

/**
 * Workspace `id`'s folder, made at the end of the Bookmarks Toolbar on its first bookmark and
 * linked to the workspace.
 * @param {string} id
 * @returns {Promise<string>}
 */
async function makeWorkspaceFolder(id) {
  const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === id);
  if (!def) throw new Error("that workspace is gone");
  const found = workspaceFolderGuid(
    fromPlaces(await places().promiseBookmarksTree(""), "toolbar"),
    asWorkspace(def),
  );
  const guid = found ?? (await makeFolders(PLACES_ROOTS.toolbar, [def.name]));
  link(id, guid);
  return guid;
}

/**
 * The folder `names` lead to from `base`, made where missing (a workspace's own folder too).
 * @param {Folder} tree
 * @param {string} base
 * @param {readonly string[]} names
 */
async function ensureFolders(tree, base, names) {
  let { guid, missing } = resolveFolders(tree, base, names);
  if (isPendingFolder(guid)) guid = await makeWorkspaceFolder(pendingWorkspaceId(guid));
  return makeFolders(guid, missing);
}

/**
 * Where a typed path goes: `@name/rest` in that workspace's folder, else from `base` (by
 * default the top of the window's tree).
 * @param {Scope} scope
 * @param {string} text
 * @param {string} [base]
 * @returns {{ tree: Folder, base: string, folders: string[], leaf: string | null }
 *   | { refused: string }}
 */
function target(scope, text, base) {
  const { workspace, rest } = splitWorkspacePath(text);
  if (workspace === null) {
    return { tree: scope.tree, base: base ?? scope.tree.guid, ...parseBookmarkPath(text) };
  }
  const ws = scope.workspaces.find((w) => w.name === workspace);
  if (!ws) {
    return {
      refused: scope.workspaces.length
        ? `bookmark: no workspace "${workspace}"`
        : `bookmark: @${workspace}/ names a workspace's folder, with [bookmarks] root = "workspace"`,
    };
  }
  return { tree: ws.tree, base: ws.tree.guid, ...parseBookmarkPath(rest) };
}

/**
 * A bookmark's path as the window's prompts write it: from the top of its tree, or `@name/…` in
 * another workspace's folder; null outside them all.
 * @param {Scope} scope
 * @param {string} parentGuid
 * @param {string} title
 */
function pathIn(scope, parentGuid, title) {
  if (inTree(scope.tree, parentGuid)) {
    return formatBookmarkPath([...folderPath(scope.tree, parentGuid), title]);
  }
  const ws = scope.workspaces.find((w) => inTree(w.tree, parentGuid));
  if (!ws) return null;
  return `@${formatBookmarkPath([ws.name, ...folderPath(ws.tree, parentGuid), title])}`;
}

/**
 * The page a key bookmarks: the selected tab's URL and title, when the panel could open it.
 * @param {BrowserWindow} win
 * @returns {{ url: string, title: string } | null}
 */
export function currentPage(win) {
  const browser = win.gBrowser.selectedBrowser;
  const url = browser.currentURI?.spec ?? "";
  if (!isOpenable(url) || url === "about:blank") return null;
  return { url, title: browser.contentTitle || url };
}

/**
 * The most recently changed bookmark of `url`: `path` from the top of the window's tree, or
 * `@name/…` in another workspace's folder, or from the Menu outside them (`outside`); `value`
 * is what the move/rename prompt starts with (outside every folder: its title alone, so Enter
 * files it at the top).
 * @param {BrowserWindow | null} win
 * @param {string} url
 * @returns {Promise<{ guid: string, path: string, value: string, outside: boolean } | null>}
 */
export async function findBookmark(win, url) {
  const bm = await places().bookmarks.fetch({ url });
  if (!bm) return null;
  const scope = await loadScope(win);
  const inside = pathIn(scope, bm.parentGuid, bm.title);
  if (inside !== null) {
    return {
      guid: bm.guid,
      path: inside,
      value: inside,
      outside: !inTree(scope.tree, bm.parentGuid),
    };
  }
  const all = fromPlaces(await places().promiseBookmarksTree(""), "all");
  return {
    guid: bm.guid,
    path: formatBookmarkPath([...folderPath(all, bm.parentGuid), bm.title]),
    value: formatBookmarkPath([bm.title]),
    outside: true,
  };
}

/**
 * Files `page` under `text` from folder `base`, by default the tree's top (spec decision 5);
 * `@name/…` in that workspace's folder. `folderOnly`: a trailing `/` makes the folders and no
 * bookmark (the panel's `a`, neo-tree); else the page goes into them under its own title.
 * @param {BrowserWindow | null} win
 * @param {string} text
 * @param {{ url: string, title: string }} page
 * @param {{ base?: string, folderOnly?: boolean }} [options]
 * @returns {Promise<string>} what to tell the user
 */
export async function addBookmark(win, text, page, { base, folderOnly = false } = {}) {
  const to = target(await loadScope(win), text, base);
  if ("refused" in to) return to.refused;
  const { folders, leaf } = to;
  if (!leaf && !folders.length && !splitWorkspacePath(text).workspace) {
    return "bookmark: empty name";
  }
  const parentGuid = await ensureFolders(to.tree, to.base, folders);
  if (!leaf && folderOnly) return `made ${formatBookmarkPath(folders)}/`;
  const title = leaf ?? page.title;
  await places().bookmarks.insert({ parentGuid, url: page.url, title });
  return `bookmarked: ${pathIn(await loadScope(win), parentGuid, title) ?? title}`;
}

/**
 * A folder named by `text` (its last segment; the ones before are made too) under `base`.
 * @param {BrowserWindow | null} win
 * @param {string} text
 * @param {string} base
 */
export async function addFolder(win, text, base) {
  const to = target(await loadScope(win), text, base);
  if ("refused" in to) return to.refused;
  const names = to.leaf ? [...to.folders, to.leaf] : to.folders;
  if (!names.length) return "folder: empty name";
  await ensureFolders(to.tree, to.base, names);
  return `made ${formatBookmarkPath(names)}/`;
}

/**
 * Moves and renames bookmark `guid` to `text` from the tree's top (the already-bookmarked
 * prompt), or into another workspace's folder (`@name/…`): a trailing `/` keeps its title.
 * @param {BrowserWindow | null} win
 * @param {string} guid
 * @param {string} text
 */
export async function placeBookmark(win, guid, text) {
  const to = target(await loadScope(win), text);
  if ("refused" in to) return to.refused;
  const { folders, leaf } = to;
  if (!leaf && !folders.length && !splitWorkspacePath(text).workspace) {
    return "bookmark: empty name";
  }
  const PU = places();
  const parentGuid = await ensureFolders(to.tree, to.base, folders);
  const bm = await PU.bookmarks.fetch(guid);
  if (!bm) return "bookmark: it is gone";
  const title = leaf ?? bm.title;
  /** @type {Record<string, unknown>} */
  const change = { guid, title };
  if (bm.parentGuid !== parentGuid) {
    change.parentGuid = parentGuid;
    change.index = PU.bookmarks.DEFAULT_INDEX;
  }
  await PU.bookmarks.update(change);
  return `bookmarked: ${pathIn(await loadScope(win), parentGuid, title) ?? title}`;
}

/**
 * @param {string} guid
 * @param {string} title
 */
export async function renameItem(guid, title) {
  const name = title.trim();
  if (!name) return "rename: empty name";
  await places().bookmarks.update({ guid, title: name });
  return null;
}

/**
 * Moves `guid` into the folder `text` names from the tree's top, or in another workspace's
 * folder (`@name/…`), made where missing; never into itself or below itself.
 * @param {BrowserWindow | null} win
 * @param {string} guid
 * @param {string} text
 */
export async function moveItem(win, guid, text) {
  const to = target(await loadScope(win), text);
  if ("refused" in to) return to.refused;
  const names = to.leaf ? [...to.folders, to.leaf] : to.folders;
  // The existing part of the path must not pass through the item itself.
  for (let i = 0; i <= names.length; i++) {
    const at = resolveFolders(to.tree, to.base, names.slice(0, i));
    if (at.missing.length === 0 && at.guid === guid) return "move: not into itself";
  }
  const PU = places();
  const parentGuid = await ensureFolders(to.tree, to.base, names);
  await PU.bookmarks.update({ guid, parentGuid, index: PU.bookmarks.DEFAULT_INDEX });
  return null;
}

/** @param {string} guid */
export async function removeItem(guid) {
  await places().bookmarks.remove(guid);
}

/**
 * Workspace `def`'s folder in the toolbar and how many items are in it (folders included), or
 * null when it has none.
 * @param {WorkspaceDefinition} def
 * @returns {Promise<{ guid: string, count: number } | null>}
 */
export async function workspaceFolder(def) {
  const toolbar = fromPlaces(await places().promiseBookmarksTree(""), "toolbar");
  const tree = workspaceTree(toolbar, asWorkspace(def));
  if (isPendingFolder(tree.guid)) return null;
  /** @param {Folder} f @returns {number} */
  const count = (f) => f.children.reduce((n, c) => n + 1 + (c.kind === "folder" ? count(c) : 0), 0);
  return { guid: tree.guid, count: count(tree) };
}

/**
 * A workspace was renamed: its folder takes the new name (decision 11). The link is by guid, so
 * a folder renamed in the Library stays linked; this only keeps the names alike.
 * @param {WorkspaceDefinition} before  the definition before the rename
 * @param {string} name
 */
export async function renameWorkspaceFolder(before, name) {
  const folder = await workspaceFolder(before);
  if (!folder) return;
  link(before.id, folder.guid);
  await places().bookmarks.update({ guid: folder.guid, title: name });
}

/**
 * Moves everything in folder `from` into workspace `toId`'s folder (made if needed), then
 * removes `from` once it is empty (decision 12).
 * @param {string} from
 * @param {string} toId
 * @returns {Promise<number>} how many items moved
 */
export async function moveWorkspaceBookmarks(from, toId) {
  const PU = places();
  const into = await makeWorkspaceFolder(toId);
  const kids = (await PU.promiseBookmarksTree(from))?.children ?? [];
  for (const k of kids) {
    await PU.bookmarks.update({
      guid: k.guid,
      parentGuid: into,
      index: PU.bookmarks.DEFAULT_INDEX,
    });
  }
  const left = (await PU.promiseBookmarksTree(from))?.children ?? [];
  if (!left.length) await PU.bookmarks.remove(from);
  return kids.length;
}

/**
 * Listens to Places' bookmark events; returns the function that stops listening.
 * @param {() => void} fn
 */
export function observeBookmarks(fn) {
  const PU = places();
  const listener = () => fn();
  PU.observers.addListener([...BOOKMARK_EVENTS], listener);
  return () => PU.observers.removeListener([...BOOKMARK_EVENTS], listener);
}
