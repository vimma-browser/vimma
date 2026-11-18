/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * bookmarks.toml (docs/specs/bookmarks-file.md): one `[bookmarks.<workspace>]` table per
 * workspace, one `"path" = "url"` line per bookmark, mirrored into the workspace's folder in
 * Places. Everything here is pure: reading and checking the file (Behaviour 2-5), the model, the
 * stored base (D4) and the plan of Places operations that brings a table's folder to the file
 * (D5, D6, D13, D14, D16). The host (config/BookmarksFile.sys.mjs) reads the files and Places,
 * asks the questions and applies the plan. This is the read-only mirror (Delivery slice 1): the
 * file always wins, and a change made in Places is put back.
 */
import { formatBookmarkPath, parseBookmarkPath, PLACES_ROOTS } from "../ui/bookmarks.mjs";
import { hasControl } from "../text/strings.mjs";
import { locateKeys, parseToml } from "./toml.mjs";

/** @import { BookmarkletsSetting } from "../ui/bookmarks.mjs" */
/** @import { Path } from "./toml.mjs" */

export const BOOKMARKS_FILE = "bookmarks.toml";
/** A larger file is refused before it is parsed (Behaviour 4). */
export const MAX_BOOKMARKS_FILE_BYTES = 4 * 1024 * 1024;
/** Places' title limit, DB_TITLE_LENGTH_MAX (toolkit/components/places/PlacesUtils.sys.mjs). */
export const MAX_BOOKMARK_TITLE = 4096;
/** The longest URL a line may hold (Behaviour 4). */
export const MAX_BOOKMARK_URL = 65536;
/** `[bookmarks]` keys that are config.toml's settings, never a workspace's inline table. */
export const BOOKMARKS_SETTING_NAMES = Object.freeze(["root", "bookmarklets", "write_back"]);
/** The same as config.mjs's MAX_WORKSPACE_NAME; a table is named after a workspace. */
const MAX_TABLE_NAME = 32;
/** A large deletion asks first (D14): more than this many in one run, */
const MAX_SILENT_REMOVALS = 20;
/** or more than half of a table that has at least this many. */
const HALF_FROM = 5;

const TYPE_BOOKMARK = 1;
const TYPE_FOLDER = 2;
const TYPE_SEPARATOR = 3;

/**
 * @typedef {{ kind: "bookmark", title: string, url: string, line: number }} FileBookmark
 * @typedef {{ kind: "folder", title: string, line: number, children: FileItem[] }} FileFolder
 * @typedef {FileBookmark | FileFolder} FileItem
 * @typedef {{ name: string, line: number, children: FileItem[] }} FileTable
 * @typedef {{ line: number, message: string }} LineError  `line` 0: the file as a whole
 * @typedef {{ file: string, line: number, message: string }} BookmarksFileError
 * @typedef {"bookmarks.toml" | "config.toml"} BookmarksSource
 */

/**
 * The base (D4): what the file and Places last agreed on, with each item's Places guid.
 * @typedef {{ path: string[], kind: "bookmark" | "folder", url?: string, guid: string }} BaseEntry
 * @typedef {{ name: string, folder: string, entries: BaseEntry[] }} BaseTable
 * @typedef {{ version: 1, source: BookmarksSource, hash: string, tables: BaseTable[] }} Base
 */

/**
 * A node of PlacesUtils.promiseBookmarksTree: the fields the plan reads.
 * @typedef {{ guid?: string, typeCode?: number, title?: string, uri?: string,
 *   children?: PlacesNode[] }} PlacesNode
 */

/**
 * One Places write, in the order the host applies them. An insert and a move append (the
 * host passes DEFAULT_INDEX); a reorder lists every child of the folder.
 * @typedef {{ op: "insert", guid: string, parentGuid: string, kind: "folder", title: string }
 *   | { op: "insert", guid: string, parentGuid: string, kind: "bookmark", title: string,
 *       url: string }
 *   | { op: "update", guid: string, title?: string, url?: string, parentGuid?: string }
 *   | { op: "remove", guid: string }
 *   | { op: "reorder", parentGuid: string, guids: string[] }} MirrorOp
 */

/** @param {unknown} v */
function typeName(v) {
  if (Array.isArray(v)) return "an array";
  if (v instanceof Date) return "a date";
  if (typeof v === "object" && v !== null) return "a table";
  if (typeof v === "bigint") return "an integer";
  if (typeof v === "number") return "a float";
  return typeof v === "string" ? "a string" : "a boolean";
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isTable = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * The UTF-8 length of `text`, stopping once it passes `limit`.
 * @param {string} text
 * @param {number} limit
 */
function utf8Over(text, limit) {
  if (text.length > limit) return true;
  if (text.length * 3 <= limit) return false;
  let n = 0;
  for (const ch of text) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (n > limit) return true;
  }
  return false;
}

/**
 * A line's value as the URL Places stores (Behaviour 4: compared by `href`), or why not.
 * @param {string} value
 * @returns {{ url: string } | { error: string }}
 */
function lineUrl(value) {
  if (value.length > MAX_BOOKMARK_URL)
    return { error: `URL longer than ${MAX_BOOKMARK_URL} characters` };
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `not an absolute URL: ${JSON.stringify(value)}` };
  }
  // D13: never data:, in any case and behind any spaces the URL parser strips.
  if (url.protocol === "data:") return { error: "data: URLs are never added to bookmarks" };
  return { url: url.href };
}

/** A `javascript:` URL, which the mirror adds only while bookmarklets are allowed (D13). */
const isBookmarklet = (/** @type {string} */ url) => /^javascript:/i.test(url);

/**
 * A path key as the user reads it in an error: folders end in `/`.
 * @param {readonly string[]} names
 * @param {boolean} isFolder
 */
const showPath = (names, isFolder) => formatBookmarkPath(names) + (isFolder ? "/" : "");

/**
 * Checks a table name, a workspace name (config.mjs, `[workspaces.<name>]`).
 * @param {string} name
 * @returns {string | null}
 */
function tableNameProblem(name) {
  const length = [...name].length;
  if (length < 1 || length > MAX_TABLE_NAME) {
    return `workspace name must be 1 to ${MAX_TABLE_NAME} characters`;
  }
  if (hasControl(name)) return "workspace name must not contain control characters";
  return null;
}

/**
 * One table's lines as its tree, in file order (D3): each folder at its first line, its contents
 * together under it. Order comes from the lines, never from the object, whose integer-like keys
 * JavaScript lists first.
 * @param {string} name
 * @param {Record<string, unknown>} raw
 * @param {(path: Path) => number | undefined} lineOf
 * @param {LineError[]} errors
 * @returns {FileTable}
 */
function readTable(name, raw, lineOf, errors) {
  const headerLine = lineOf(["bookmarks", name]) ?? 0;
  /** @type {FileTable} */
  const table = { name, line: headerLine, children: [] };
  const nameProblem = tableNameProblem(name);
  if (nameProblem) {
    errors.push({ line: headerLine, message: nameProblem });
    return table;
  }
  const lines = Object.entries(raw)
    .map(([key, value]) => ({ key, value, line: lineOf(["bookmarks", name, key]) ?? headerLine }))
    .sort((a, b) => a.line - b.line);
  /** @type {Map<string, number>} path key → the line that first named it */
  const seen = new Map();
  /** @type {Map<string, FileFolder>} folder path key → folder */
  const folders = new Map();
  for (const { key, value, line } of lines) {
    if (typeof value !== "string") {
      errors.push({ line, message: `expected a URL string, got ${typeName(value)}` });
      continue;
    }
    const { folders: names, leaf } = parseBookmarkPath(key);
    const isFolder = leaf === null;
    const segments = isFolder ? names : [...names, leaf];
    if (!segments.length) {
      errors.push({ line, message: "empty path" });
      continue;
    }
    if (segments.some((s) => s.length > MAX_BOOKMARK_TITLE)) {
      errors.push({ line, message: `a name longer than ${MAX_BOOKMARK_TITLE} characters` });
      continue;
    }
    /** @type {string | null} */
    let url = null;
    if (isFolder) {
      if (value !== "") {
        errors.push({
          line,
          message: `a folder line (${JSON.stringify(key)}) must have the value ""`,
        });
        continue;
      }
    } else {
      if (value === "") {
        errors.push({
          line,
          message: `a bookmark line (${JSON.stringify(key)}) needs a URL; a folder line ends in /`,
        });
        continue;
      }
      const u = lineUrl(value);
      if ("error" in u) {
        errors.push({ line, message: u.error });
        continue;
      }
      url = u.url;
    }
    const pathKey = JSON.stringify([isFolder ? "f" : "b", ...segments]);
    const first = seen.get(pathKey);
    if (first !== undefined) {
      errors.push({
        line,
        message: `same path as line ${first}: "${showPath(segments, isFolder)}"`,
      });
      continue;
    }
    seen.set(pathKey, line);
    // The folders on the way, each made at the first line that names it.
    /** @type {FileItem[]} */
    let into = table.children;
    for (let i = 0; i < names.length; i++) {
      const k = JSON.stringify(names.slice(0, i + 1));
      let f = folders.get(k);
      if (!f) {
        f = { kind: "folder", title: /** @type {string} */ (names[i]), line, children: [] };
        folders.set(k, f);
        into.push(f);
      }
      into = f.children;
    }
    if (!isFolder) {
      into.push({
        kind: "bookmark",
        title: /** @type {string} */ (leaf),
        url: /** @type {string} */ (url),
        line,
      });
    }
  }
  return table;
}

/**
 * Reads `bookmarks.toml` (Behaviour 2-4, D12): only `[bookmarks.<name>]` tables, each line a
 * bookmark or an empty folder. Every problem is reported with its line; a file with any is not
 * applied at all (D9).
 * @param {string} text
 * @returns {{ tables: FileTable[], errors: LineError[] }}
 */
export function parseBookmarksFile(text) {
  if (utf8Over(text, MAX_BOOKMARKS_FILE_BYTES)) {
    return { tables: [], errors: [{ line: 0, message: "larger than 4 MiB; not read" }] };
  }
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) {
    return { tables: [], errors: [{ line: parsed.error.line, message: parsed.error.message }] };
  }
  const lineOf = locateKeys(text);
  /** @type {LineError[]} */
  const errors = [];
  /** @type {FileTable[]} */
  const tables = [];
  for (const [key, value] of Object.entries(parsed.value)) {
    if (key !== "bookmarks") {
      errors.push({
        line: lineOf([key]) ?? 0,
        message: `only [bookmarks.<workspace>] tables belong here, not ${JSON.stringify(key)}`,
      });
      continue;
    }
    if (!isTable(value)) {
      errors.push({
        line: lineOf([key]) ?? 0,
        message: `expected [bookmarks.<workspace>] tables, got ${typeName(value)}`,
      });
      continue;
    }
    for (const [name, raw] of Object.entries(value)) {
      if (!isTable(raw)) {
        // D12: a bookmarks file from someone else cannot change a setting.
        errors.push({
          line: lineOf(["bookmarks", name]) ?? 0,
          message: `bookmarks.${name} is a setting: it is read only from config.toml`,
        });
        continue;
      }
      tables.push(readTable(name, raw, lineOf, errors));
    }
  }
  tables.sort((a, b) => a.line - b.line);
  errors.sort((a, b) => a.line - b.line);
  return { tables, errors };
}

/**
 * The inline `[bookmarks.<name>]` tables of config.toml's text, by name and line; [] when it
 * does not parse.
 * @param {string} text
 * @returns {{ name: string, line: number }[]}
 */
export function inlineBookmarkTables(text) {
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok || !isTable(parsed.value.bookmarks)) return [];
  const lineOf = locateKeys(text);
  return Object.entries(parsed.value.bookmarks)
    .filter(([, v]) => isTable(v))
    .map(([name]) => ({ name, line: lineOf(["bookmarks", name]) ?? 0 }))
    .sort((a, b) => a.line - b.line);
}

/**
 * The message for an inline table that config.toml's settings shadow (Behaviour 8).
 * @param {string} name
 */
export const inlineSettingNameMessage = (name) =>
  `a workspace named "${name}" cannot have its table in config.toml: put [bookmarks.${name}] in bookmarks.toml`;

/**
 * Which file is the bookmarks file and what it holds (D1, D2): `bookmarks.toml` when it exists
 * (`file` is its text), else the inline `[bookmarks.<name>]` tables of config.toml. `from` is
 * null when neither has a table. When both exist, config.toml's tables are ignored, each with a
 * warning at its line. config.toml's settings (`root`, `bookmarklets`) are never tables.
 * `from` is "config.toml" with an error when config.toml does not parse and there is no
 * bookmarks.toml: whether it has tables cannot be told.
 * @param {{ file: string | null, config: string | null }} texts
 * @returns {{ from: BookmarksSource | null, tables: FileTable[], errors: BookmarksFileError[],
 *   warnings: BookmarksFileError[] }}
 */
export function readBookmarks({ file, config }) {
  /** @type {BookmarksFileError[]} */
  const warnings = [];
  if (file !== null) {
    if (config !== null) {
      for (const t of inlineBookmarkTables(config)) {
        warnings.push({
          file: "config.toml",
          line: t.line,
          message: `bookmarks.${t.name} ignored: bookmarks.toml is the bookmarks file`,
        });
      }
    }
    const r = parseBookmarksFile(file);
    return {
      from: "bookmarks.toml",
      tables: r.tables,
      errors: r.errors.map((e) => ({ file: BOOKMARKS_FILE, ...e })),
      warnings,
    };
  }
  const none = { from: null, tables: [], errors: [], warnings };
  if (config === null) return none;
  const parsed = parseToml(config, { integersAsBigInt: true });
  if (!parsed.ok) {
    return {
      from: "config.toml",
      tables: [],
      errors: [{ file: "config.toml", line: parsed.error.line, message: parsed.error.message }],
      warnings,
    };
  }
  const section = parsed.value.bookmarks;
  if (!isTable(section)) return none;
  const lineOf = locateKeys(config);
  /** @type {LineError[]} */
  const errors = [];
  /** @type {FileTable[]} */
  const tables = [];
  for (const [name, raw] of Object.entries(section)) {
    if (!isTable(raw)) continue; // a setting, config.mjs's to check
    if (BOOKMARKS_SETTING_NAMES.includes(name)) {
      errors.push({
        line: lineOf(["bookmarks", name]) ?? 0,
        message: inlineSettingNameMessage(name),
      });
      continue;
    }
    tables.push(readTable(name, raw, lineOf, errors));
  }
  if (!tables.length && !errors.length) return none;
  tables.sort((a, b) => a.line - b.line);
  errors.sort((a, b) => a.line - b.line);
  return {
    from: "config.toml",
    tables,
    errors: errors.map((e) => ({ file: "config.toml", ...e })),
    warnings,
  };
}

/**
 * `bookmarks.toml:<line>: <message>`, as config.toml's errors read (Behaviour 4).
 * @param {BookmarksFileError} e
 */
export function formatBookmarksFileError(e) {
  return e.line > 0 ? `${e.file}:${e.line}: ${e.message}` : `${e.file}: ${e.message}`;
}

/**
 * Whether one run removes enough to ask first (D14): more than 20 bookmarks in all, or more
 * than half of a table that had at least 5.
 * @param {readonly { removed: number, had: number }[]} tables
 */
export function tooManyRemoved(tables) {
  const total = tables.reduce((n, t) => n + t.removed, 0);
  if (total > MAX_SILENT_REMOVALS) return true;
  return tables.some((t) => t.had >= HALF_FROM && t.removed > t.had / 2);
}

/** @param {unknown} v @returns {v is string[]} */
const isPath = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string");

/**
 * The base as stored in `<profile>/vimma-bookmarks.json`, or null for anything else (a
 * missing, damaged or newer file): the next run then matches Places by path, as a first load.
 * @param {string} text
 * @returns {Base | null}
 */
export function parseBase(text) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isTable(raw) || raw.version !== 1 || typeof raw.hash !== "string") return null;
  if (raw.source !== "bookmarks.toml" && raw.source !== "config.toml") return null;
  if (!Array.isArray(raw.tables)) return null;
  /** @type {BaseTable[]} */
  const tables = [];
  for (const t of raw.tables) {
    if (!isTable(t) || typeof t.name !== "string" || typeof t.folder !== "string") return null;
    if (!Array.isArray(t.entries)) return null;
    /** @type {BaseEntry[]} */
    const entries = [];
    for (const e of t.entries) {
      if (!isTable(e) || !isPath(e.path) || typeof e.guid !== "string") return null;
      if (e.kind === "folder") entries.push({ path: [...e.path], kind: "folder", guid: e.guid });
      else if (e.kind === "bookmark" && typeof e.url === "string") {
        entries.push({ path: [...e.path], kind: "bookmark", url: e.url, guid: e.guid });
      } else return null;
    }
    tables.push({ name: t.name, folder: t.folder, entries });
  }
  return { version: 1, source: raw.source, hash: raw.hash, tables };
}

/** @param {Base} base */
export function formatBase(base) {
  return JSON.stringify(base);
}

/** A title as Places keeps it, for comparing (D5): trimmed, cut to Places' limit. */
const normTitle = (/** @type {string | undefined} */ t) =>
  (t ?? "").trim().slice(0, MAX_BOOKMARK_TITLE);

/** A Places URL as an href, as the file's lines are kept. */
function normUrl(/** @type {string | undefined} */ u) {
  try {
    return new URL(u ?? "").href;
  } catch {
    return u ?? "";
  }
}

/**
 * A Places folder's children as the file would name them: a second item of one title in one
 * folder is `title (2)`, then `(3)` (open question 1, answer a). Separators are left out.
 * @param {readonly PlacesNode[]} children
 * @returns {{ node: PlacesNode, name: string, kind: "bookmark" | "folder" }[]}
 */
function named(children) {
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {{ node: PlacesNode, name: string, kind: "bookmark" | "folder" }[]} */
  const out = [];
  for (const node of children) {
    const kind =
      node.typeCode === TYPE_FOLDER
        ? "folder"
        : node.typeCode === TYPE_BOOKMARK
          ? "bookmark"
          : null;
    if (!kind) continue;
    const title = normTitle(node.title);
    let name = title;
    for (let n = 2; used.has(`${kind}\0${name}`); n++) name = `${title} (${n})`;
    used.add(`${kind}\0${name}`);
    out.push({ node, name, kind });
  }
  return out;
}

/**
 * Every node of `tree` with its parent's guid.
 * @param {PlacesNode} tree
 */
function indexPlaces(tree) {
  /** @type {Map<string, { node: PlacesNode, parent: string | null }>} */
  const map = new Map();
  /** @param {PlacesNode} n @param {string | null} parent */
  const walk = (n, parent) => {
    if (n.guid) map.set(n.guid, { node: n, parent });
    for (const c of n.children ?? []) walk(c, n.guid ?? null);
  };
  walk(tree, null);
  return map;
}

/**
 * The number of bookmarks in a Places subtree.
 * @param {PlacesNode} n
 * @returns {number}
 */
function countBookmarks(n) {
  if (n.typeCode === TYPE_BOOKMARK) return 1;
  return (n.children ?? []).reduce((s, c) => s + countBookmarks(c), 0);
}

/**
 * The plan of one run of the read-only mirror (Delivery slice 1): the Places operations that
 * bring each table's folder to the file, keeping guids where the base or the folder already has
 * the item (D4), so that keywords, Sync records and visits stay. A change made in Places is put
 * back from the file. Bookmarks outside the tables' folders are never named (Behaviour 21);
 * separators are never removed or moved, only kept after the item they followed (D16).
 *
 * Deletions are counted by cause: `"file"`, a line the file no longer has (the base knew it);
 * `"outside"`, an item added in Places, put back; `"adopt"`, an item of a folder a table takes
 * over for the first time (Behaviour 18). Too many `"file"` removals (D14), or any `"adopt"`
 * removal, need `confirmed`: without it, `ask` is the question and `ops` is empty. `fresh` (a
 * new Places database at this start, D17) takes the file as it is, without the question.
 *
 * @param {{ tables: readonly FileTable[], base: { tables: BaseTable[] } | null,
 *   places: PlacesNode,
 *   workspaces: readonly { name: string, folder?: string | null }[],
 *   bookmarklets: BookmarkletsSetting, confirmed: boolean, fresh: boolean,
 *   makeGuid: () => string }} input
 *   `places`: the whole tree (promiseBookmarksTree("")); `workspaces`: each workspace's name and
 *   linked folder
 * @returns {{ ops: MirrorOp[], base: { tables: BaseTable[] }, ask: string | null,
 *   removed: { table: string, count: number, cause: "file" | "outside" | "adopt" }[],
 *   skipped: { table: string, line: number }[], links: { name: string, folder: string }[] }}
 */
export function planMirror(input) {
  const { tables, places, workspaces, bookmarklets, confirmed, makeGuid } = input;
  const base = input.fresh ? null : input.base;
  const allowScripts = bookmarklets === "user" || bookmarklets === "agent";
  const all = indexPlaces(places);
  const toolbar = all.get(PLACES_ROOTS.toolbar)?.node ?? {
    guid: PLACES_ROOTS.toolbar,
    children: [],
  };
  const topFolders = (toolbar.children ?? []).filter((c) => c.typeCode === TYPE_FOLDER);
  /** @type {Map<string, BaseTable>} */
  const baseTables = new Map((base?.tables ?? []).map((t) => [t.name, t]));

  /** @type {MirrorOp[]} */
  const folderInserts = [];
  /** @type {MirrorOp[]} */
  const updates = [];
  /** @type {MirrorOp[]} */
  const bookmarkInserts = [];
  /** @type {MirrorOp[]} */
  const removes = [];
  /** @type {Map<string, string[]>} folder guid → its children's guids once the run is done */
  const finalOrder = new Map();
  /** @type {BaseTable[]} */
  const nextTables = [];
  /** @type {{ table: string, count: number, cause: "file" | "outside" | "adopt" }[]} */
  const removed = [];
  /** @type {{ table: string, line: number }[]} */
  const skipped = [];
  /** @type {{ name: string, folder: string }[]} */
  const links = [];
  /** @type {{ removed: number, had: number }[]} */
  const fileCounts = [];
  /** @type {string[]} */
  const fileTables = [];
  let adoptCount = 0;
  /** @type {string[]} */
  const adoptTables = [];
  /** Folder guids already given to a table. */
  /** @type {Set<string>} */
  const usedFolders = new Set();

  for (const table of tables) {
    const known = baseTables.get(table.name) ?? null;
    // D6: the base's folder wherever it is, the workspace's linked folder, the first toolbar
    // folder of the name, else a new one at the end of the toolbar.
    const ws = workspaces.find((w) => w.name === table.name);
    /** @type {string | null | undefined} */
    let folderGuid;
    if (
      known &&
      all.get(known.folder)?.node.typeCode === TYPE_FOLDER &&
      !usedFolders.has(known.folder)
    ) {
      folderGuid = known.folder;
    } else if (
      ws?.folder &&
      topFolders.some((f) => f.guid === ws.folder) &&
      !usedFolders.has(ws.folder)
    ) {
      folderGuid = ws.folder;
    } else {
      folderGuid =
        topFolders.find(
          (f) =>
            normTitle(f.title) === table.name && !usedFolders.has(/** @type {string} */ (f.guid)),
        )?.guid ?? null;
    }
    /** @type {PlacesNode | null} */
    let folderNode = folderGuid ? (all.get(folderGuid)?.node ?? null) : null;
    if (!folderGuid || !folderNode) {
      folderGuid = makeGuid();
      folderNode = null;
      folderInserts.push({
        op: "insert",
        guid: folderGuid,
        parentGuid: PLACES_ROOTS.toolbar,
        kind: "folder",
        title: table.name,
      });
    } else {
      // Behaviour 20 (read-only): a renamed folder gets its name back, a moved one goes back to
      // the toolbar's top.
      /** @type {{ title?: string, parentGuid?: string }} */
      const change = {};
      if (normTitle(folderNode.title) !== table.name) change.title = table.name;
      if (all.get(folderGuid)?.parent !== PLACES_ROOTS.toolbar)
        change.parentGuid = PLACES_ROOTS.toolbar;
      if (Object.keys(change).length) updates.push({ op: "update", guid: folderGuid, ...change });
    }
    usedFolders.add(folderGuid);
    links.push({ name: table.name, folder: folderGuid });
    const tableFolder = folderGuid;

    /** @type {Map<string, BaseEntry>} */
    const baseByPath = new Map();
    /** @type {Map<string, BaseEntry[]>} */
    const baseByUrl = new Map();
    for (const e of known?.entries ?? []) {
      baseByPath.set(JSON.stringify([e.kind, ...e.path]), e);
      if (e.kind === "bookmark" && e.url) {
        const list = baseByUrl.get(e.url) ?? [];
        list.push(e);
        baseByUrl.set(e.url, list);
      }
    }
    /** Paths the file has now, so a URL match never takes a line that is still there. */
    /** @type {Set<string>} */
    const filePaths = new Set();
    /** @param {readonly FileItem[]} items @param {string[]} at */
    const collect = (items, at) => {
      for (const i of items) {
        const p = [...at, i.title];
        filePaths.add(JSON.stringify([i.kind, ...p]));
        if (i.kind === "folder") collect(i.children, p);
      }
    };
    collect(table.children, []);

    /** Places' items under the table's folder, by kind and path (duplicates as `title (n)`). */
    /** @type {Map<string, PlacesNode>} */
    const placesByPath = new Map();
    /** @param {PlacesNode} f @param {string[]} at */
    const walkPlaces = (f, at) => {
      for (const { node, name, kind } of named(f.children ?? [])) {
        const p = [...at, name];
        placesByPath.set(JSON.stringify([kind, ...p]), node);
        if (kind === "folder") walkPlaces(node, p);
      }
    };
    if (folderNode) walkPlaces(folderNode, []);

    /** @type {Set<string>} */
    const claimed = new Set([tableFolder]);
    /** Protected bookmarklets (D13) and the folders above them, which stay as they are. */
    /** @type {Set<string>} */
    const kept = new Set();
    if (!allowScripts && folderNode) {
      /** @param {PlacesNode} n @returns {boolean} */
      const protect = (n) => {
        let any = false;
        for (const c of n.children ?? []) {
          if (c.typeCode === TYPE_BOOKMARK && isBookmarklet(c.uri ?? "")) {
            kept.add(/** @type {string} */ (c.guid));
            any = true;
          } else if (c.typeCode === TYPE_FOLDER && protect(c)) any = true;
        }
        return any;
      };
      protect(folderNode);
    }
    /** @param {string | undefined} guid */
    const free = (guid) => !!guid && !claimed.has(guid) && !kept.has(guid) && all.has(guid);

    /** @type {BaseEntry[]} */
    const entries = [];

    /**
     * Places `items` in folder `parentGuid` (null: a folder this run inserts), returning the
     * guids in file order.
     * @param {readonly FileItem[]} items
     * @param {string} parentGuid
     * @param {string[]} at
     * @returns {string[]}
     */
    const place = (items, parentGuid, at) => {
      /** @type {string[]} */
      const order = [];
      for (const item of items) {
        const path = [...at, item.title];
        const key = JSON.stringify([item.kind, ...path]);
        if (item.kind === "bookmark" && !allowScripts && isBookmarklet(item.url)) {
          skipped.push({ table: table.name, line: item.line });
          continue;
        }
        /** @type {string | undefined} */
        let guid;
        const byPath = baseByPath.get(key);
        const node = (/** @type {string | undefined} */ g) => (g ? all.get(g)?.node : undefined);
        const kindOk = (/** @type {string | undefined} */ g) =>
          node(g)?.typeCode === (item.kind === "folder" ? TYPE_FOLDER : TYPE_BOOKMARK);
        if (byPath && free(byPath.guid) && kindOk(byPath.guid)) guid = byPath.guid;
        if (!guid && item.kind === "bookmark") {
          // D4: same URL, new path is a move or rename, when one base entry has that URL and
          // its old path is gone from the file.
          const same = baseByUrl.get(item.url) ?? [];
          const only = same.length === 1 ? same[0] : undefined;
          if (
            only &&
            !filePaths.has(JSON.stringify(["bookmark", ...only.path])) &&
            free(only.guid) &&
            kindOk(only.guid)
          ) {
            guid = only.guid;
          }
        }
        if (!guid) {
          const p = placesByPath.get(key);
          if (p?.guid && free(p.guid) && (item.kind === "folder" || normUrl(p.uri) === item.url)) {
            guid = p.guid;
          }
        }
        if (guid) {
          claimed.add(guid);
          const n = /** @type {PlacesNode} */ (node(guid));
          /** @type {{ title?: string, url?: string, parentGuid?: string }} */
          const change = {};
          if (normTitle(n.title) !== item.title) change.title = item.title;
          if (item.kind === "bookmark" && normUrl(n.uri) !== item.url) change.url = item.url;
          if (all.get(guid)?.parent !== parentGuid) change.parentGuid = parentGuid;
          if (Object.keys(change).length) updates.push({ op: "update", guid, ...change });
        } else {
          guid = makeGuid();
          if (item.kind === "folder") {
            folderInserts.push({
              op: "insert",
              guid,
              parentGuid,
              kind: "folder",
              title: item.title,
            });
          } else {
            bookmarkInserts.push({
              op: "insert",
              guid,
              parentGuid,
              kind: "bookmark",
              title: item.title,
              url: item.url,
            });
          }
        }
        order.push(guid);
        if (item.kind === "folder") {
          entries.push({ path, kind: "folder", guid });
          finalOrder.set(guid, place(item.children, guid, path));
        } else {
          entries.push({ path, kind: "bookmark", url: item.url, guid });
        }
      }
      return order;
    };
    finalOrder.set(tableFolder, place(table.children, tableFolder, []));

    // What the file does not have: removed, the topmost unclaimed item of each branch.
    let fromFile = 0;
    let outside = 0;
    const baseGuids = new Set((known?.entries ?? []).map((e) => e.guid));
    if (folderNode) {
      /** @param {PlacesNode} f */
      const sweep = (f) => {
        for (const c of f.children ?? []) {
          const g = c.guid;
          if (!g || c.typeCode === TYPE_SEPARATOR || kept.has(g)) {
            if (g && kept.has(g) && c.typeCode === TYPE_FOLDER) sweep(c);
            continue;
          }
          if (claimed.has(g)) {
            if (c.typeCode === TYPE_FOLDER) sweep(c);
            continue;
          }
          // Its claimed descendants move out first (updates run before removals); the rest goes.
          /** @param {PlacesNode} n @returns {number} */
          const lost = (n) =>
            n.typeCode === TYPE_BOOKMARK
              ? claimed.has(/** @type {string} */ (n.guid)) ||
                kept.has(/** @type {string} */ (n.guid))
                ? 0
                : 1
              : (n.children ?? []).reduce((s, k) => s + lost(k), 0);
          /** @param {PlacesNode} n @returns {boolean} */
          const holdsKept = (n) =>
            (n.children ?? []).some(
              (k) => kept.has(/** @type {string} */ (k.guid)) || holdsKept(k),
            );
          if (holdsKept(c)) {
            sweep(c);
            continue;
          }
          removes.push({ op: "remove", guid: g });
          /** @param {PlacesNode} n @returns {number} */
          const known1 = (n) =>
            n.typeCode === TYPE_BOOKMARK
              ? !claimed.has(/** @type {string} */ (n.guid)) &&
                baseGuids.has(/** @type {string} */ (n.guid))
                ? 1
                : 0
              : (n.children ?? []).reduce((s, k) => s + known1(k), 0);
          const total = lost(c);
          const fileOnes = known ? known1(c) : 0;
          fromFile += fileOnes;
          outside += total - fileOnes;
        }
      };
      sweep(folderNode);
    }
    // A base item moved out of the folder in Places and dropped from the file is left where it
    // is: outside the mirrored folders it is the user's (Behaviour 21).
    const had = (known?.entries ?? []).filter((e) => e.kind === "bookmark").length;
    if (known || input.fresh) {
      if (fromFile) {
        removed.push({ table: table.name, count: fromFile, cause: "file" });
        fileCounts.push({ removed: fromFile, had });
        fileTables.push(table.name);
      }
      if (outside)
        removed.push({
          table: table.name,
          count: outside,
          cause: input.fresh ? "file" : "outside",
        });
    } else if (outside) {
      removed.push({ table: table.name, count: outside, cause: "adopt" });
      adoptCount += outside;
      adoptTables.push(table.name);
    }
    nextTables.push({ name: table.name, folder: tableFolder, entries });
  }

  // Tables gone from the file: their bookmarks go, the folder stays as the workspace's.
  for (const known of base?.tables ?? []) {
    if (tables.some((t) => t.name === known.name)) continue;
    const folderNode = all.get(known.folder)?.node;
    if (!folderNode) continue;
    let count = 0;
    for (const c of folderNode.children ?? []) {
      const g = c.guid;
      if (!g || !known.entries.some((e) => e.guid === g)) continue;
      if (c.typeCode === TYPE_BOOKMARK && !allowScripts && isBookmarklet(c.uri ?? "")) continue;
      if (c.typeCode !== TYPE_BOOKMARK && c.typeCode !== TYPE_FOLDER) continue;
      removes.push({ op: "remove", guid: g });
      count += countBookmarks(c);
    }
    if (count) {
      removed.push({ table: known.name, count, cause: "file" });
      fileCounts.push({
        removed: count,
        had: known.entries.filter((e) => e.kind === "bookmark").length,
      });
      fileTables.push(known.name);
    }
  }

  /** @type {string | null} */
  let ask = null;
  if (!confirmed && !input.fresh) {
    if (tooManyRemoved(fileCounts)) {
      const n = fileCounts.reduce((s, t) => s + t.removed, 0) + adoptCount;
      ask = `${BOOKMARKS_FILE} removes ${n} bookmark${n === 1 ? "" : "s"} from ${[
        ...fileTables,
        ...adoptTables,
      ].join(", ")}: delete them? y/N`;
    } else if (adoptCount) {
      ask = `${BOOKMARKS_FILE} takes over ${adoptTables.join(", ")}: delete its ${adoptCount} bookmark${
        adoptCount === 1 ? "" : "s"
      } the file lacks? y/N`;
    }
  }
  if (ask) {
    return {
      ops: [],
      base: { tables: input.base?.tables ?? [] },
      ask,
      removed,
      skipped,
      links,
    };
  }

  // D16: the order of each folder lists every child, separators and kept bookmarklets after the
  // item they followed; only a folder whose order the inserts and moves leave wrong is reordered.
  const ops = [...folderInserts, ...updates, ...bookmarkInserts, ...removes];
  /** @type {MirrorOp[]} */
  const reorders = [];
  const removedGuids = new Set(removes.map((o) => /** @type {{ guid: string }} */ (o).guid));
  for (const [parent, order] of finalOrder) {
    const node = all.get(parent)?.node;
    const current = (node?.children ?? []).map((c) => /** @type {string} */ (c.guid));
    const movedAway = new Set(
      updates
        .filter((o) => o.op === "update" && o.parentGuid !== undefined && o.parentGuid !== parent)
        .map((o) => /** @type {{ guid: string }} */ (o).guid),
    );
    // What Places will hold: the children that stay, then what the run appends, in op order.
    const staying = current.filter((g) => !removedGuids.has(g) && !movedAway.has(g));
    const appended = ops
      .filter(
        (o) =>
          (o.op === "insert" && o.parentGuid === parent) ||
          (o.op === "update" && o.parentGuid === parent),
      )
      .map((o) => /** @type {{ guid: string }} */ (o).guid);
    const expected = [...staying, ...appended];
    // The final order: the file's, with separators and kept items after what they followed.
    const inOrder = new Set(order);
    /** @type {Map<string | null, string[]>} */
    const anchored = new Map();
    let anchor = /** @type {string | null} */ (null);
    for (const g of staying) {
      if (inOrder.has(g)) anchor = g;
      else {
        const list = anchored.get(anchor) ?? [];
        list.push(g);
        anchored.set(anchor, list);
      }
    }
    const final = [...(anchored.get(null) ?? [])];
    for (const g of order) final.push(g, ...(anchored.get(g) ?? []));
    if (final.length === expected.length && final.every((g, i) => g === expected[i])) continue;
    reorders.push({ op: "reorder", parentGuid: parent, guids: final });
  }

  return {
    ops: [...ops, ...reorders],
    base: { tables: nextTables },
    ask: null,
    removed,
    skipped,
    links,
  };
}
