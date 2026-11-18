/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bookmarks over Firefox's Places (docs/specs/bookmarks.md, decision 1): reading the tree,
// filing a page under a typed path, renaming, moving and deleting. Paths and the tree's shape
// are core bookmarks.mjs; this only talks to PlacesUtils, and to the workspace store for the
// link between a workspace and its folder in the Bookmarks Toolbar (decision 11).

import {
  BOOKMARKLETS_SETTINGS,
  PLACES_ROOTS,
  bookmarkKind,
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

/**
 * @import { BookmarkletsSetting, BookmarksRoot, BookmarksWorkspace, Folder, PlacesItem }
 *   from "../core/bookmarks.mjs"
 */
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

/**
 * `[bookmarks] bookmarklets` (docs/specs/bookmarklets.md B3): set only by VimmaHost.configure
 * from config.toml. No pref, command or socket message reaches it.
 * @type {BookmarkletsSetting}
 */
let bookmarklets = "none";

/**
 * Who may run bookmarklets from now on; anything but a known level is `"none"`.
 * @param {BookmarkletsSetting} next
 */
export function setBookmarkletsSetting(next) {
  bookmarklets = BOOKMARKLETS_SETTINGS.includes(next) ? next : "none";
}

/** The level in force. */
export function bookmarkletsSetting() {
  return bookmarklets;
}

/**
 * The folders bookmarks.toml mirrors (docs/specs/bookmarks-file.md), set by
 * config/BookmarksFile.sys.mjs after each run. A change in them, or in any folder below, is an
 * edit of the file first and of Places after it (Behaviour 10, D18), through `writer`; with no
 * writer (`write_back = "none"`, a paused file) the keys refuse (Behaviour 11), and in a private
 * window they always do (Behaviour 12).
 * @type {ReadonlySet<string>}
 */
let mirrored = new Set();

/** Why a key changes nothing in a mirrored folder, when nothing more particular applies. */
export const MIRRORED_REFUSAL =
  "bookmarks.toml is read-only: edit the file to change these bookmarks";
/** Behaviour 11. */
export const NONE_REFUSAL = 'bookmarks.toml is read-only (write_back = "none")';
/** Behaviour 12: nothing done in private browsing reaches a file that may be committed. */
export const PRIVATE_REFUSAL = "bookmarks.toml is not written from a private window";

/** What the keys say there now: read-only, or a pause. */
let refusal = MIRRORED_REFUSAL;

/**
 * A change in a mirrored folder, by Places guid, for the mirror to write to the file first:
 * `parent` the deepest folder that exists and `missing` the folders to make below it; `outside`
 * makes and returns a destination outside every mirrored folder; `into` a workspace's folder.
 * @typedef {{ type: "add", parent: string, missing: string[], title: string | null,
 *     url: string | null }
 *   | { type: "move", guid: string, parent: string, missing: string[], title: string | null,
 *     outside: () => Promise<string> }
 *   | { type: "remove", guid: string }
 *   | { type: "renameTable", folder: string, to: string }
 *   | { type: "moveTable", from: string, into: () => Promise<string> }
 *   | { type: "removeTable", folder: string }} FileChange
 * @typedef {{ error: string } | { guid: string | null, path: string[], count: number,
 *   renamed?: { from: string, to: string } }} FileChangeResult
 * @typedef {(change: FileChange) => Promise<FileChangeResult>} FileWriter
 */

/** @type {FileWriter | null} */
let writer = null;

/**
 * @param {ReadonlySet<string>} guids  the tables' folders
 * @param {string} [why]  what a refused key says
 * @param {FileWriter | null} [write]  writes a change to the file and then Places; null refuses
 */
export function setMirroredFolders(guids, why = MIRRORED_REFUSAL, write = null) {
  mirrored = new Set(guids);
  refusal = why;
  writer = write;
}

/** Whether a change in a mirrored folder is written to the file now (`write_back = "vimma"`). */
export function mirrorWritable() {
  return writer !== null;
}

/** What a key refused in a mirrored folder says. */
export function mirroredRefusal() {
  return refusal;
}

/**
 * Whether `guid` is a mirrored folder or anything under one, read from Places now.
 * @param {string | null | undefined} guid
 */
export async function isMirrored(guid) {
  if (!mirrored.size || !guid || isPendingFolder(guid)) return false;
  const PU = places();
  for (let g = /** @type {string | undefined} */ (guid), depth = 0; g && depth < 64; depth++) {
    if (mirrored.has(g)) return true;
    if (/** @type {string[]} */ (Object.values(PLACES_ROOTS)).includes(g)) return false;
    g = (await PU.bookmarks.fetch(g))?.parentGuid;
  }
  return false;
}

/**
 * How a change that touches `guids` goes: null when none is mirrored (Places alone, as before
 * bookmarks.toml), else through the file's writer, or refused.
 * @param {BrowserWindow | null} win  the window the key was typed in
 * @param {...(string | null | undefined)} guids
 * @returns {Promise<{ refused: string } | { write: FileWriter } | null>}
 */
async function routeMirrored(win, ...guids) {
  let any = false;
  for (const g of guids) if (!any && (await isMirrored(g))) any = true;
  if (!any) return null;
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  );
  if (win && PrivateBrowsingUtils.isWindowPrivate(win)) return { refused: PRIVATE_REFUSAL };
  return writer ? { write: writer } : { refused: refusal };
}

/**
 * Why a change touching `guids` would be refused (a mirrored folder that is not written now, or
 * a private window), or null: the panel says it before its prompt opens.
 * @param {BrowserWindow | null} win
 * @param {...(string | null | undefined)} guids
 */
export async function mirroredRefusalFor(win, ...guids) {
  const route = await routeMirrored(win, ...guids);
  return route && "refused" in route ? route.refused : null;
}

/**
 * What a file write's outcome adds to the notice: a duplicate name made unique (Behaviour 15).
 * @param {FileChangeResult} r
 */
const renamedNote = (r) =>
  "renamed" in r && r.renamed
    ? ` (${JSON.stringify(r.renamed.from)} is taken there, so bookmarks.toml has ${JSON.stringify(r.renamed.to)})`
    : "";

/** @returns {PlacesUtilsApi} */
function places() {
  return ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs").PlacesUtils;
}

/** The whole bookmarks tree, from the Places root, which always exists. */
async function placesTree() {
  const all = await places().promiseBookmarksTree("");
  if (!all) throw new Error("bookmarks: no Places root");
  return all;
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
    const code = e !== null && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code !== "read-only" && code !== "disabled") {
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
  const all = await placesTree();
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
 * Every bookmark, whatever the panel's root (core fromPlaces `"all"`), for `:bookmarkopen`
 * (docs/specs/bookmark-open.md decision 1).
 * @returns {Promise<Folder>}
 */
export async function loadAllBookmarks() {
  return fromPlaces(await placesTree(), "all");
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
  const found = workspaceFolderGuid(fromPlaces(await placesTree(), "toolbar"), asWorkspace(def));
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
  const all = fromPlaces(await placesTree(), "all");
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
  const at = resolveFolders(to.tree, to.base, folders);
  const route = await routeMirrored(win, at.guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const onlyFolders = !leaf && folderOnly;
    const r = await route.write({
      type: "add",
      parent: at.guid,
      missing: at.missing,
      title: onlyFolders ? null : (leaf ?? page.title),
      url: onlyFolders ? null : page.url,
    });
    if ("error" in r) return r.error;
    if (onlyFolders) return `made ${formatBookmarkPath(folders)}/`;
    return `bookmarked: ${await shownPath(win, r.guid, r.path)}${renamedNote(r)}`;
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
  const at = resolveFolders(to.tree, to.base, names);
  const route = await routeMirrored(win, at.guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const r = await route.write({
      type: "add",
      parent: at.guid,
      missing: at.missing,
      title: null,
      url: null,
    });
    if ("error" in r) return r.error;
    return `made ${formatBookmarkPath(names)}/`;
  }
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
  const at = resolveFolders(to.tree, to.base, folders);
  const route = await routeMirrored(win, guid, at.guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const r = await route.write({
      type: "move",
      guid,
      parent: at.guid,
      missing: at.missing,
      title: leaf,
      outside: () => ensureFolders(to.tree, to.base, folders),
    });
    if ("error" in r) return r.error;
    return `bookmarked: ${await shownPath(win, guid, r.path)}${renamedNote(r)}`;
  }
  const parentGuid = await ensureFolders(to.tree, to.base, folders);
  const bm = await PU.bookmarks.fetch(guid);
  if (!bm) return "bookmark: it is gone";
  const title = leaf ?? bm.title;
  /** @type {{ guid: string, title: string, parentGuid?: string, index?: number }} */
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
 * @param {BrowserWindow | null} [win]  the window the key was typed in
 * @returns {Promise<string | null>} why not, or what to say
 */
export async function renameItem(guid, title, win = null) {
  const name = title.trim();
  if (!name) return "rename: empty name";
  const route = await routeMirrored(win, guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const bm = await places().bookmarks.fetch(guid);
    if (!bm) return "rename: it is gone";
    const r = await route.write({
      type: "move",
      guid,
      parent: bm.parentGuid,
      missing: [],
      title: name,
      outside: async () => bm.parentGuid,
    });
    if ("error" in r) return r.error;
    return renamedNote(r).trim() || null;
  }
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
  const at = resolveFolders(to.tree, to.base, names);
  const route = await routeMirrored(win, guid, at.guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const r = await route.write({
      type: "move",
      guid,
      parent: at.guid,
      missing: at.missing,
      title: null,
      outside: () => ensureFolders(to.tree, to.base, names),
    });
    if ("error" in r) return r.error;
    return renamedNote(r).trim() || null;
  }
  const PU = places();
  const parentGuid = await ensureFolders(to.tree, to.base, names);
  await PU.bookmarks.update({ guid, parentGuid, index: PU.bookmarks.DEFAULT_INDEX });
  return null;
}

/**
 * @param {string} guid
 * @param {BrowserWindow | null} [win]  the window the key was typed in
 * @returns {Promise<string | null>} why not, or null once removed
 */
export async function removeItem(guid, win = null) {
  const route = await routeMirrored(win, guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const r = await route.write({ type: "remove", guid });
    return "error" in r ? r.error : null;
  }
  await places().bookmarks.remove(guid);
  return null;
}

/**
 * A closed workspace's folder deleted with everything in it (decision 12's `d`): for a mirrored
 * folder its table goes from the file first (Behaviour 10).
 * @param {string} guid
 * @returns {Promise<string | null>} why not, or null once removed
 */
export async function removeWorkspaceFolder(guid) {
  const route = await routeMirrored(null, guid);
  if (route) {
    if ("refused" in route) return route.refused;
    const r = await route.write({ type: "removeTable", folder: guid });
    return "error" in r ? r.error : null;
  }
  await places().bookmarks.remove(guid);
  return null;
}

/**
 * A bookmark's path as the notice shows it, read from Places after the file's write: from the
 * window's tree, `@name/…` in another workspace's folder; else the path the file holds.
 * @param {BrowserWindow | null} win
 * @param {string | null} guid
 * @param {readonly string[]} path
 */
async function shownPath(win, guid, path) {
  const bm = guid ? await places().bookmarks.fetch(guid) : null;
  const shown = bm ? pathIn(await loadScope(win), bm.parentGuid, bm.title) : null;
  return shown ?? formatBookmarkPath([...path]);
}

/**
 * Workspace `def`'s folder in the toolbar and how many items are in it (folders included), or
 * null when it has none.
 * @param {WorkspaceDefinition} def
 * @returns {Promise<{ guid: string, count: number } | null>}
 */
export async function workspaceFolder(def) {
  const toolbar = fromPlaces(await placesTree(), "toolbar");
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
 * @returns {Promise<string | null>} what to tell the user, if anything
 */
export async function renameWorkspaceFolder(before, name) {
  const folder = await workspaceFolder(before);
  if (!folder) return null;
  link(before.id, folder.guid);
  const route = await routeMirrored(null, folder.guid);
  if (route) {
    // Refused (write_back = "none", a pause): the folder keeps its table's name, linked by guid
    // (bookmarks-file Behaviour 11). Else the table's header is renamed first (Behaviour 10).
    if ("refused" in route) return null;
    const r = await route.write({ type: "renameTable", folder: folder.guid, to: name });
    return "error" in r ? `the bookmarks folder kept its name: ${r.error}` : null;
  }
  await places().bookmarks.update({ guid: folder.guid, title: name });
  return null;
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
  const def = WorkspaceStore.definitions.workspaces.find((d) => d.id === toId);
  const target = def
    ? workspaceFolderGuid(fromPlaces(await placesTree(), "toolbar"), asWorkspace(def))
    : null;
  const route = await routeMirrored(null, from, target);
  if (route) {
    if ("refused" in route) throw new Error(route.refused);
    const r = await route.write({ type: "moveTable", from, into: () => makeWorkspaceFolder(toId) });
    if ("error" in r) throw new Error(r.error);
    return r.count;
  }
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

/**
 * A stored bookmark, read afresh from Places by its guid (bookmarklets B10, B15), or null when
 * there is none or it is a folder.
 * @param {string} guid
 * @returns {Promise<{ guid: string, title: string, url: string } | null>}
 */
export async function fetchBookmark(guid) {
  const bm = await places().bookmarks.fetch(guid);
  if (!bm?.url) return null;
  return { guid: bm.guid, title: bm.title ?? "", url: bm.url.href };
}

/**
 * Every bookmarklet among the user's bookmarks whose title is exactly `name` (bookmarklets
 * B12), anywhere in Places, with its folder path for the question.
 * @param {string} name
 * @returns {Promise<{ guid: string, title: string, url: string, path: string }[]>}
 */
export async function bookmarkletsNamed(name) {
  /** @type {{ guid: string, title: string, url: string, path: string }[]} */
  const found = [];
  /** @param {PlacesItem} node @param {string[]} folders */
  const walk = (node, folders) => {
    const url = node.uri;
    if (url !== undefined) {
      if (node.guid && node.title === name && bookmarkKind(url) === "bookmarklet") {
        found.push({
          guid: node.guid,
          title: name,
          url,
          path: formatBookmarkPath([...folders, name]),
        });
      }
      return;
    }
    const inside = node.guid === "root________" ? folders : [...folders, node.title ?? ""];
    for (const child of node.children ?? []) walk(child, inside);
  };
  walk(await placesTree(), []);
  return found;
}

/**
 * Whether `browser` shows a page a bookmarklet may run on (bookmarklets B9): one with an http,
 * https or file content principal. Never a system-principal page, Vimma's own pages, `about:`
 * or an extension's page.
 * @param {MozBrowser} browser
 */
export function bookmarkletPage(browser) {
  const p = browser.contentPrincipal;
  return !!p?.isContentPrincipal && ["http", "https", "file"].some((s) => p.schemeIs(s));
}

/**
 * Runs a stored bookmarklet's URL in `browser`'s page (bookmarklets B8), the load Firefox makes
 * for a picked bookmarklet (PlacesUIUtils._openNodeIn → openTrustedLinkIn with
 * allowInheritPrincipal, engine/browser/components/places/PlacesUIUtils.sys.mjs:959): the system
 * principal triggers it and LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL is left out (as
 * URILoadingHelper's openInCurrentTab does for allowInheritPrincipal), so the engine
 * evaluates the script in the page's own global, with the page's principal, and refuses a
 * system-principal page (engine/dom/jsurl/nsJSProtocolHandler.cpp:396). The browser is loaded
 * directly, not through openTrustedLinkIn, which raises the window (`w.focus()`): an agent's run
 * must not. `popups`: the user's run allows them, as Firefox's does; an agent's does not.
 * Returns the refusal to show, or null once the load is started.
 * @param {MozBrowser} browser
 * @param {string} url  a stored bookmark's URL, unchanged; the caller decided it is a bookmarklet
 * @param {{ popups: boolean }} options
 * @returns {string | null}
 */
export function runBookmarklet(browser, url, { popups }) {
  if (bookmarkKind(url) !== "bookmarklet") return "only a bookmarklet can be run";
  if (!bookmarkletPage(browser)) return "bookmarklets run only on web pages";
  let loadFlags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
  if (popups) loadFlags |= Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_POPUPS;
  browser.loadURI(Services.io.newURI(url), {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    loadFlags,
  });
  return null;
}
