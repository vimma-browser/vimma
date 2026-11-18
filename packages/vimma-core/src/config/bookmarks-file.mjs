/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * bookmarks.toml (docs/specs/bookmarks-file.md): one `[bookmarks.<workspace>]` table per
 * workspace, one `"path" = "url"` line per bookmark, mirrored into the workspace's folder in
 * Places. Everything here is pure: reading and checking the file (Behaviour 2-5), the model, the
 * stored base (D4) and the plan of Places operations that brings each table's folder to the file
 * (D5, D6, D13, D14, D16). The host (config/BookmarksFile.sys.mjs) reads the files and Places,
 * asks the questions and applies the plan. This is the read-only mirror (Delivery slice 1): the
 * file always wins, and a change made in Places is put back.
 *
 * The file may come from someone else's repository and the plan runs on the parent's main
 * thread, so every walk is bounded: at most 20,000 lines, 32 names deep, keys built one level
 * at a time, and the walks over Places iterative (docs/security/08-config-toml.md F6).
 */
import { BOOKMARKLETS_SETTINGS, formatBookmarkPath, PLACES_ROOTS } from "../ui/bookmarks.mjs";
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
/** The most lines one bookmarks file may hold, all tables together. */
export const MAX_BOOKMARK_LINES = 20_000;
/** The deepest path a line may name, in names (its folders and the bookmark's title). */
export const MAX_BOOKMARK_DEPTH = 32;
/** `[bookmarks]` keys that are config.toml's settings, never a workspace's inline table. */
export const BOOKMARKS_SETTING_NAMES = Object.freeze(["root", "bookmarklets", "write_back"]);
/** The same as config.mjs's MAX_WORKSPACE_NAME; a table is named after a workspace. */
const MAX_TABLE_NAME = 32;
/** A large deletion asks first (D14): more than this many in one run, */
const MAX_SILENT_REMOVALS = 20;
/** or more than half of a table that has at least this many. */
const HALF_FROM = 5;
/** What an error repeats of the file is cut to, so a 64 KiB URL never fills the status bar. */
const ECHO = 80;
/**
 * The schemes a line may hold (docs/security/04: what Vimma opens), and `javascript:`, which
 * reaches Places only behind `[bookmarks] bookmarklets` (D13).
 */
const SCHEMES = Object.freeze(["http:", "https:", "file:", "about:", "javascript:"]);
/**
 * C1 controls, bidirectional controls and invisible format characters: a name that shows as
 * something else in the Library and the panel. U+200D (the zero-width joiner of emoji) stays.
 */
const HIDDEN = /[\u0080-\u009f؜​‌‎‏‪-‮⁠-⁩﻿]/u;

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
 * @typedef {{ version: 1, source: BookmarksSource, tables: BaseTable[] }} Base
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

/** `text` as an error repeats it: JSON-quoted, at most ECHO characters of it. */
const echo = (/** @type {string} */ text) =>
  JSON.stringify(text.length > ECHO ? `${text.slice(0, ECHO)}…` : text);

/**
 * Whether `text` is longer than `limit` bytes in UTF-8, stopping once it is.
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
 * A line's value as the URL Places stores (Behaviour 4: compared by `href`), or why not. Only
 * the schemes Vimma opens, and `javascript:` (D13); `data:` and the rest are errors.
 * @param {string} value
 * @returns {{ url: string } | { error: string }}
 */
function lineUrl(value) {
  if (value.length > MAX_BOOKMARK_URL) {
    return { error: `URL longer than ${MAX_BOOKMARK_URL} characters` };
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `not an absolute URL: ${echo(value)}` };
  }
  // The parsed scheme, so case, spaces and tabs the URL parser strips change nothing.
  if (url.protocol === "data:") return { error: "data: URLs are never added to bookmarks" };
  if (!SCHEMES.includes(url.protocol)) {
    return {
      error: `${url.protocol} URLs are not bookmarked from the file: http, https, file, about and javascript only`,
    };
  }
  return { url: url.href };
}

/** A `javascript:` URL, which the mirror adds only while bookmarklets are allowed (D13). */
const isBookmarklet = (/** @type {string} */ url) => /^\s*javascript:/i.test(url);

/**
 * A key as quick add reads a path (bookmarks decision 5: `/` separates, `\/` and `\\` escape,
 * names trimmed, empty ones dropped), stopping as soon as it names more than `max`: a 4 MiB
 * key of slashes costs one pass, never a list of millions of names.
 * @param {string} text
 * @param {number} max
 * @returns {{ names: string[], leaf: string | null } | null}  null: deeper than `max`
 */
function splitPath(text, max) {
  /** @type {string[]} */
  const names = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\\" && (next === "/" || next === "\\")) {
      cur += next;
      i++;
    } else if (c === "/") {
      const name = cur.trim();
      cur = "";
      if (!name) continue;
      names.push(name);
      if (names.length > max) return null;
    } else {
      cur += c;
    }
  }
  const leaf = cur.trim() || null;
  if (names.length + (leaf ? 1 : 0) > max) return null;
  return { names, leaf };
}

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
  if (HIDDEN.test(name)) {
    return "workspace name must not contain bidirectional, invisible or C1 control characters";
  }
  if (name.trim() !== name) return "workspace name must not start or end with a space";
  return null;
}

/** A path key: the kind, then the names, joined by a character no checked name holds. */
const keyOf = (/** @type {string} */ kind, /** @type {readonly string[]} */ names) =>
  `${kind}\u0000${names.join("\u0000")}`;

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
  /** Each folder's subfolders by name, the table's own too: one level at a time. */
  /** @type {Map<FileTable | FileFolder, Map<string, FileFolder>>} */
  const subfolders = new Map();
  for (const { key, value, line } of lines) {
    if (typeof value !== "string") {
      errors.push({ line, message: `expected a URL string, got ${typeName(value)}` });
      continue;
    }
    const path = splitPath(key, MAX_BOOKMARK_DEPTH);
    if (!path) {
      errors.push({ line, message: `a path deeper than ${MAX_BOOKMARK_DEPTH} folders` });
      continue;
    }
    const { names, leaf } = path;
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
    if (segments.some((s) => hasControl(s) || HIDDEN.test(s))) {
      errors.push({ line, message: "a name with a control or bidirectional character" });
      continue;
    }
    /** @type {string | null} */
    let url = null;
    if (isFolder) {
      if (value !== "") {
        errors.push({ line, message: `a folder line (${echo(key)}) must have the value ""` });
        continue;
      }
    } else {
      if (value === "") {
        errors.push({
          line,
          message: `a bookmark line (${echo(key)}) needs a URL; a folder line ends in /`,
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
    const pathKey = keyOf(isFolder ? "f" : "b", segments);
    const first = seen.get(pathKey);
    if (first !== undefined) {
      const shown = formatBookmarkPath(segments) + (isFolder ? "/" : "");
      errors.push({ line, message: `same path as line ${first}: ${echo(shown)}` });
      continue;
    }
    seen.set(pathKey, line);
    // The folders on the way, each made at the first line that names it.
    /** @type {FileTable | FileFolder} */
    let into = table;
    for (const folderName of names) {
      let level = subfolders.get(into);
      if (!level) subfolders.set(into, (level = new Map()));
      let f = level.get(folderName);
      if (!f) {
        f = { kind: "folder", title: folderName, line, children: [] };
        level.set(folderName, f);
        into.children.push(f);
      }
      into = f;
    }
    if (!isFolder) {
      into.children.push({
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
 * The number of lines in `[bookmarks]`'s tables, counted before any is read.
 * @param {Record<string, unknown>} section
 */
function countLines(section) {
  let n = 0;
  for (const raw of Object.values(section)) if (isTable(raw)) n += Object.keys(raw).length;
  return n;
}

const TOO_MANY = `more than ${MAX_BOOKMARK_LINES} lines; not read`;

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
  const section = parsed.value.bookmarks;
  if (isTable(section) && countLines(section) > MAX_BOOKMARK_LINES) {
    return { tables: [], errors: [{ line: 0, message: TOO_MANY }] };
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
        message: `only [bookmarks.<workspace>] tables belong here, not ${echo(key)}`,
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
          message: `bookmarks.${name.slice(0, ECHO)} is a setting: it is read only from config.toml`,
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
 * config.toml's `[bookmarks]` table when the file declares schema 2 or later, which inline
 * tables need (a schema-1 file with them is a config error already); else null.
 * @param {Record<string, unknown>} raw
 */
function schema2Bookmarks(raw) {
  const schema = raw.schema;
  if (typeof schema !== "bigint" || schema < 2n) return null;
  return isTable(raw.bookmarks) ? raw.bookmarks : null;
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
 * `[bookmarks] bookmarklets` as config.toml's own text says it, `"none"` for anything else: the
 * mirror follows config.toml, never a file `:source <file>` put in force (Behaviour 6, D12).
 * @param {string | null} text
 * @returns {BookmarkletsSetting}
 */
export function configBookmarklets(text) {
  if (text === null) return "none";
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok || !isTable(parsed.value.bookmarks)) return "none";
  const v = parsed.value.bookmarks.bookmarklets;
  return BOOKMARKLETS_SETTINGS.includes(/** @type {BookmarkletsSetting} */ (v))
    ? /** @type {BookmarkletsSetting} */ (v)
    : "none";
}

/**
 * The message for an inline table that config.toml's settings shadow (Behaviour 8).
 * @param {string} name
 */
export const inlineSettingNameMessage = (name) =>
  `a workspace named "${name}" cannot have its table in config.toml: put [bookmarks.${name}] in bookmarks.toml`;

/**
 * Which file is the bookmarks file and what it holds (D1, D2): `bookmarks.toml` when it exists
 * (`file` is its text), else the inline `[bookmarks.<name>]` tables of a schema-2 config.toml.
 * `from` is null when neither has a table. When both exist, config.toml's tables are ignored,
 * each with a warning at its line. config.toml's settings (`root`, `bookmarklets`) are never
 * tables. `from` is "config.toml" with an error when config.toml does not parse and there is no
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
          message: `bookmarks.${t.name.slice(0, ECHO)} ignored: bookmarks.toml is the bookmarks file`,
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
  if (utf8Over(config, MAX_BOOKMARKS_FILE_BYTES)) return none; // config.mjs's to refuse
  const parsed = parseToml(config, { integersAsBigInt: true });
  if (!parsed.ok) {
    return {
      from: "config.toml",
      tables: [],
      errors: [{ file: "config.toml", line: parsed.error.line, message: parsed.error.message }],
      warnings,
    };
  }
  const section = schema2Bookmarks(parsed.value);
  if (!section) return none;
  const lineOf = locateKeys(config);
  /** @type {LineError[]} */
  const errors = [];
  /** @type {FileTable[]} */
  const tables = [];
  if (countLines(section) > MAX_BOOKMARK_LINES) errors.push({ line: 0, message: TOO_MANY });
  else {
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
 * Its folders are trusted only where planMirror finds them (at the toolbar's top, or the
 * workspace's own), never as stored.
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
  if (!isTable(raw) || raw.version !== 1) return null;
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
  return { version: 1, source: raw.source, tables };
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

/** @param {PlacesNode} n */
const kindOf = (n) =>
  n.typeCode === TYPE_FOLDER ? "folder" : n.typeCode === TYPE_BOOKMARK ? "bookmark" : null;

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
    const kind = kindOf(node);
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
 * Every node under `root`, the root included, without recursion.
 * @param {PlacesNode} root
 * @returns {PlacesNode[]}
 */
function subtree(root) {
  /** @type {PlacesNode[]} */
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = /** @type {PlacesNode} */ (stack.pop());
    out.push(n);
    for (const c of n.children ?? []) stack.push(c);
  }
  return out;
}

/**
 * The plan of one run of the read-only mirror (Delivery slice 1): the Places operations that
 * bring each table's folder to the file, keeping guids where the base or the folder already has
 * the item (D4), so that keywords, Sync records and visits stay. A change made in Places is put
 * back from the file. Bookmarks outside the tables' folders are never named (Behaviour 21), and
 * a guid the base names is reused only while it is inside a mirrored folder; separators are
 * never removed or moved, only kept after the item they followed (D16). Every table claims
 * from one set, so one table never removes what another holds.
 *
 * Deletions are counted by cause: `"file"`, a line the file no longer has (the base knew it);
 * `"outside"`, an item added in Places, put back; `"adopt"`, an item of a folder a table takes
 * over without a base (Behaviour 18). Any `"adopt"` removal, or too many removals of any cause
 * (D14), ask first: `ask` is the question and `ops` is empty, unless `approved` (the count a
 * `y` approved) covers them all. `removing` is that count.
 *
 * @param {{ tables: readonly FileTable[], base: { tables: BaseTable[] } | null,
 *   places: PlacesNode,
 *   workspaces: readonly { name: string, folder?: string | null }[],
 *   bookmarklets: BookmarkletsSetting, approved: number | null,
 *   makeGuid: () => string }} input
 *   `places`: the whole tree (promiseBookmarksTree("")); `workspaces`: each workspace's name and
 *   linked folder
 * @returns {{ ops: MirrorOp[], base: { tables: BaseTable[] }, ask: string | null,
 *   removing: number, touched: string[],
 *   removed: { table: string, count: number, cause: "file" | "outside" | "adopt" }[],
 *   skipped: { table: string, line: number }[], links: { name: string, folder: string }[] }}
 */
export function planMirror(input) {
  const { tables, base, places, workspaces, bookmarklets, approved, makeGuid } = input;
  const allowScripts = bookmarklets === "user" || bookmarklets === "agent";
  const all = indexPlaces(places);
  /** @type {Set<string>} */
  const roots = new Set([...Object.values(PLACES_ROOTS), "root________", "tags________"]);
  const toolbar = all.get(PLACES_ROOTS.toolbar)?.node ?? { guid: PLACES_ROOTS.toolbar };
  const topFolders = (toolbar.children ?? []).filter((c) => c.typeCode === TYPE_FOLDER);
  /** @type {Map<string, BaseTable>} */
  const baseTables = new Map((base?.tables ?? []).map((t) => [t.name, t]));
  const isFolderGuid = (/** @type {string | null | undefined} */ g) =>
    !!g && !roots.has(g) && all.get(g)?.node.typeCode === TYPE_FOLDER;
  const atTop = (/** @type {string} */ g) => all.get(g)?.parent === PLACES_ROOTS.toolbar;

  /** @type {MirrorOp[]} */
  const folderInserts = [];
  /** @type {MirrorOp[]} */
  const updates = [];
  /** @type {MirrorOp[]} */
  const bookmarkInserts = [];
  /** @type {MirrorOp[]} */
  const removes = [];
  /** @type {Set<string>} tables whose folder an operation changes */
  const touched = new Set();
  /** @type {Map<string, string>} each folder the run orders → its table */
  const orderTable = new Map();
  /** @type {Map<string, string[]>} folder guid → its children's guids once the run is done */
  const finalOrder = new Map();
  /** @type {{ table: string, count: number, cause: "file" | "outside" | "adopt" }[]} */
  const removed = [];
  /** @type {{ table: string, line: number }[]} */
  const skipped = [];
  /** @type {{ name: string, folder: string }[]} */
  const links = [];
  /** @type {{ removed: number, had: number }[]} */
  const counts = [];
  /** @type {string[]} */
  const removingTables = [];
  let adoptCount = 0;
  /** @type {string[]} */
  const adoptTables = [];

  // The base's folders at the toolbar's top, and whether a base folder is inside one of them
  // (a workspace folder dragged into another's in the Library).
  const baseAtTop = new Set(
    (base?.tables ?? []).map((t) => t.folder).filter((g) => isFolderGuid(g) && atTop(g)),
  );
  const insideBaseFolder = (/** @type {string} */ g) => {
    let p = all.get(g)?.parent ?? null;
    for (let depth = 0; p && depth < 64; depth++) {
      if (baseAtTop.has(p)) return true;
      p = all.get(p)?.parent ?? null;
    }
    return false;
  };

  // D6, for every table before any is filled: the base's folder while it is at the toolbar's
  // top, inside another table's folder there, or the workspace's linked folder (a damaged or
  // edited base names no other), the workspace's linked folder, the first toolbar folder of the
  // name, else a new one.
  /** @type {Set<string>} */
  const usedFolders = new Set();
  /** @type {{ table: FileTable, known: BaseTable | null, folder: string,
   *   node: PlacesNode | null }[]} */
  const resolved = [];
  for (const table of tables) {
    const known = baseTables.get(table.name) ?? null;
    const linked = workspaces.find((w) => w.name === table.name)?.folder ?? null;
    const unused = (/** @type {string | null | undefined} */ g) =>
      isFolderGuid(g) && !usedFolders.has(/** @type {string} */ (g));
    /** @type {string | null} */
    let folderGuid = null;
    if (
      known &&
      unused(known.folder) &&
      (atTop(known.folder) || known.folder === linked || insideBaseFolder(known.folder))
    ) {
      folderGuid = known.folder;
    } else if (linked && unused(linked)) {
      folderGuid = linked;
    } else {
      folderGuid =
        topFolders.find(
          (f) => normTitle(f.title) === table.name && unused(/** @type {string} */ (f.guid)),
        )?.guid ?? null;
    }
    const node = folderGuid ? (all.get(folderGuid)?.node ?? null) : null;
    if (!folderGuid || !node) {
      folderGuid = makeGuid();
      folderInserts.push({
        op: "insert",
        guid: folderGuid,
        parentGuid: PLACES_ROOTS.toolbar,
        kind: "folder",
        title: table.name,
      });
      touched.add(table.name);
    } else {
      // Behaviour 20 (read-only): a renamed folder gets its name back, a moved one goes back to
      // the toolbar's top.
      /** @type {{ title?: string, parentGuid?: string }} */
      const change = {};
      if (normTitle(node.title) !== table.name) change.title = table.name;
      if (!atTop(folderGuid)) change.parentGuid = PLACES_ROOTS.toolbar;
      if (Object.keys(change).length) {
        updates.push({ op: "update", guid: folderGuid, ...change });
        touched.add(table.name);
      }
    }
    usedFolders.add(folderGuid);
    links.push({ name: table.name, folder: folderGuid });
    resolved.push({ table, known, folder: folderGuid, node });
  }

  /** Every guid inside a table's folder now: the only items a run may claim or remove. */
  /** @type {Map<string, string>} guid → the table whose folder holds it */
  const mirroredIn = new Map();
  for (const r of resolved) {
    if (!r.node) continue;
    for (const n of subtree(r.node)) {
      // A table's folder inside another's belongs to its own table.
      if (n.guid && !(usedFolders.has(n.guid) && n !== r.node) && !mirroredIn.has(n.guid)) {
        mirroredIn.set(n.guid, r.table.name);
      }
    }
  }
  for (const r of resolved) if (r.node) mirroredIn.set(r.folder, r.table.name);

  // D13: under "none", a javascript: bookmark in a mirrored folder is never changed or removed,
  // nor any folder above it.
  /** @type {Set<string>} */
  const kept = new Set();
  /** @param {PlacesNode} root */
  const protect = (root) => {
    if (allowScripts) return;
    for (const n of subtree(root)) {
      if (n.typeCode !== TYPE_BOOKMARK || !n.guid || !isBookmarklet(n.uri ?? "")) continue;
      for (let g = /** @type {string | null} */ (n.guid); g && g !== root.guid;) {
        kept.add(g);
        g = all.get(g)?.parent ?? null;
      }
    }
  };
  for (const r of resolved) if (r.node) protect(r.node);

  /** One set for every table: the tables' folders and every item a table placed. */
  /** @type {Set<string>} */
  const claimed = new Set(usedFolders);
  const free = (/** @type {string | undefined} */ g) =>
    !!g && !claimed.has(g) && !kept.has(g) && mirroredIn.has(g);

  /** @type {BaseTable[]} */
  const nextTables = [];
  for (const { table, known, folder: tableFolder, node: folderNode } of resolved) {
    /** @type {Map<string, BaseEntry>} */
    const baseByPath = new Map();
    /** @type {Map<string, BaseEntry[]>} */
    const baseByUrl = new Map();
    for (const e of known?.entries ?? []) {
      baseByPath.set(keyOf(e.kind, e.path), e);
      if (e.kind === "bookmark" && e.url) {
        const list = baseByUrl.get(e.url) ?? [];
        list.push(e);
        baseByUrl.set(e.url, list);
      }
    }
    /** Paths the file has now, so a URL match never takes a line that is still there. */
    /** @type {Set<string>} */
    const filePaths = new Set();
    /** @type {[readonly FileItem[], string[]][]} */
    const pending = [[table.children, []]];
    while (pending.length) {
      const [items, at] = /** @type {[readonly FileItem[], string[]]} */ (pending.pop());
      for (const i of items) {
        const p = [...at, i.title];
        filePaths.add(keyOf(i.kind, p));
        if (i.kind === "folder") pending.push([i.children, p]);
      }
    }

    /** Places' items under the table's folder, by kind and path (duplicates as `title (n)`). */
    /** @type {Map<string, PlacesNode>} */
    const placesByPath = new Map();
    if (folderNode) {
      /** @type {[PlacesNode, string[]][]} */
      const walk = [[folderNode, []]];
      while (walk.length) {
        const [f, at] = /** @type {[PlacesNode, string[]]} */ (walk.pop());
        // Deeper than any line can be: nothing there can match.
        if (at.length >= MAX_BOOKMARK_DEPTH) continue;
        for (const { node, name, kind } of named(f.children ?? [])) {
          const p = [...at, name];
          placesByPath.set(keyOf(kind, p), node);
          if (kind === "folder") walk.push([node, p]);
        }
      }
    }

    /** @type {BaseEntry[]} */
    const entries = [];
    const node = (/** @type {string | undefined} */ g) => (g ? all.get(g)?.node : undefined);

    // The file's tree, depth first; it is at most MAX_BOOKMARK_DEPTH deep.
    /**
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
        const key = keyOf(item.kind, path);
        if (item.kind === "bookmark" && !allowScripts && isBookmarklet(item.url)) {
          skipped.push({ table: table.name, line: item.line });
          continue;
        }
        const wanted = item.kind === "folder" ? TYPE_FOLDER : TYPE_BOOKMARK;
        const fits = (/** @type {string | undefined} */ g) =>
          free(g) && node(g)?.typeCode === wanted;
        /** @type {string | undefined} */
        let guid;
        const byPath = baseByPath.get(key);
        if (byPath && fits(byPath.guid)) guid = byPath.guid;
        if (!guid && item.kind === "bookmark") {
          // D4: same URL, new path is a move or rename, when one base entry has that URL and
          // its old path is gone from the file.
          const same = baseByUrl.get(item.url) ?? [];
          const only = same.length === 1 ? same[0] : undefined;
          if (only && !filePaths.has(keyOf("bookmark", only.path)) && fits(only.guid)) {
            guid = only.guid;
          }
        }
        if (!guid) {
          const p = placesByPath.get(key);
          if (p?.guid && fits(p.guid) && (item.kind === "folder" || normUrl(p.uri) === item.url)) {
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
          if (Object.keys(change).length) {
            updates.push({ op: "update", guid, ...change });
            touched.add(table.name);
          }
        } else {
          guid = makeGuid();
          claimed.add(guid);
          touched.add(table.name);
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
          orderTable.set(guid, table.name);
        } else {
          entries.push({ path, kind: "bookmark", url: item.url, guid });
        }
      }
      return order;
    };
    finalOrder.set(tableFolder, place(table.children, tableFolder, []));
    orderTable.set(tableFolder, table.name);
    nextTables.push({ name: table.name, folder: tableFolder, entries });
  }

  /**
   * Removes what `removable` allows under `root`: the topmost such item of each branch, after
   * the claimed items in it moved out (updates run before removals). Claimed items, kept
   * bookmarklets and other tables' folders stay; a folder that stays is searched instead.
   * Returns the bookmarks removed, by whether the base knew them.
   * @param {PlacesNode} root
   * @param {(guid: string) => boolean} removable
   * @param {ReadonlySet<string>} baseGuids
   */
  const sweep = (root, removable, baseGuids) => {
    let known = 0;
    let other = 0;
    // Reversed onto the stack, so that removals keep Places' order.
    const stack = [...(root.children ?? [])].reverse();
    while (stack.length) {
      const c = /** @type {PlacesNode} */ (stack.pop());
      const g = c.guid;
      if (!g || c.typeCode === TYPE_SEPARATOR || usedFolders.has(g)) continue;
      if (claimed.has(g) || kept.has(g) || !removable(g)) {
        if (c.typeCode === TYPE_FOLDER) stack.push(...[...(c.children ?? [])].reverse());
        continue;
      }
      removes.push({ op: "remove", guid: g });
      for (const n of subtree(c)) {
        if (n.typeCode !== TYPE_BOOKMARK || !n.guid || claimed.has(n.guid)) continue;
        if (baseGuids.has(n.guid)) known++;
        else other++;
      }
    }
    return { known, other };
  };

  for (const { table, known, node: folderNode } of resolved) {
    if (!folderNode) continue;
    const baseGuids = new Set((known?.entries ?? []).map((e) => e.guid));
    const before = removes.length;
    const r = sweep(folderNode, (g) => mirroredIn.get(g) === table.name, baseGuids);
    if (removes.length > before) touched.add(table.name);
    const had = (known?.entries ?? []).filter((e) => e.kind === "bookmark").length;
    if (known) {
      if (r.known) removed.push({ table: table.name, count: r.known, cause: "file" });
      if (r.other) removed.push({ table: table.name, count: r.other, cause: "outside" });
      if (r.known + r.other) {
        counts.push({ removed: r.known + r.other, had });
        removingTables.push(table.name);
      }
    } else if (r.known + r.other) {
      removed.push({ table: table.name, count: r.known + r.other, cause: "adopt" });
      adoptCount += r.known + r.other;
      adoptTables.push(table.name);
    }
  }

  // Tables gone from the file: the bookmarks the base knew in their folder go; the folder stays
  // as the workspace's, and a folder another table now holds is left to it.
  for (const known of base?.tables ?? []) {
    if (tables.some((t) => t.name === known.name)) continue;
    if (usedFolders.has(known.folder) || !isFolderGuid(known.folder)) continue;
    if (!atTop(known.folder)) continue; // a base folder elsewhere is not trusted (above)
    const folderNode = /** @type {PlacesNode} */ (all.get(known.folder)?.node);
    const baseGuids = new Set(known.entries.map((e) => e.guid));
    protect(folderNode);
    const r = sweep(folderNode, (g) => baseGuids.has(g) && !mirroredIn.has(g), baseGuids);
    if (r.known) {
      removed.push({ table: known.name, count: r.known, cause: "file" });
      counts.push({
        removed: r.known,
        had: known.entries.filter((e) => e.kind === "bookmark").length,
      });
      removingTables.push(known.name);
    }
  }

  const removing = counts.reduce((s, t) => s + t.removed, 0) + adoptCount;
  /** @type {string | null} */
  let ask = null;
  // Only a number a `y` gave approves; anything else asks.
  if (typeof approved !== "number" || removing > approved) {
    const names = (/** @type {string[]} */ list) => list.map((n) => JSON.stringify(n)).join(", ");
    const plural = removing === 1 ? "" : "s";
    if (tooManyRemoved(counts) || (adoptCount && counts.length)) {
      const from = names([...removingTables, ...adoptTables]);
      ask = `${BOOKMARKS_FILE} removes ${removing} bookmark${plural} from ${from}: delete them? y/N`;
    } else if (adoptCount) {
      ask = `${BOOKMARKS_FILE} takes over ${names(adoptTables)}: delete its ${adoptCount} bookmark${
        adoptCount === 1 ? "" : "s"
      } the file lacks? y/N`;
    }
  }
  if (ask) {
    return {
      ops: [],
      base: { tables: base?.tables ?? [] },
      ask,
      removing,
      touched: [],
      removed,
      skipped,
      links,
    };
  }

  // D16: the order of each folder lists every child, separators and kept bookmarklets after the
  // item they followed; only a folder whose order the inserts and moves leave wrong is reordered.
  // Each op is indexed once, so the cost is the number of ops plus the folders' children.
  const ops = [...folderInserts, ...updates, ...bookmarkInserts, ...removes];
  const removedGuids = new Set(removes.map((o) => /** @type {{ guid: string }} */ (o).guid));
  /** @type {Map<string, string>} guid → the folder an update moves it to */
  const movedTo = new Map();
  /** @type {Map<string, string[]>} folder → what the run appends to it, in op order */
  const appended = new Map();
  for (const o of ops) {
    if ((o.op === "insert" || o.op === "update") && o.parentGuid !== undefined) {
      if (o.op === "update") movedTo.set(o.guid, o.parentGuid);
      const list = appended.get(o.parentGuid) ?? [];
      list.push(o.guid);
      appended.set(o.parentGuid, list);
    }
  }
  /** @type {MirrorOp[]} */
  const reorders = [];
  for (const [parent, order] of finalOrder) {
    const current = (all.get(parent)?.node.children ?? []).map(
      (c) => /** @type {string} */ (c.guid),
    );
    // What Places will hold: the children that stay where they are, then what the run appends.
    const staying = current.filter((g) => !removedGuids.has(g) && !movedTo.has(g));
    const expected = [...staying, ...(appended.get(parent) ?? [])];
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
    const t = orderTable.get(parent);
    if (t) touched.add(t);
  }

  return {
    ops: [...ops, ...reorders],
    base: { tables: nextTables },
    ask: null,
    removing,
    touched: tables.map((t) => t.name).filter((n) => touched.has(n)),
    removed,
    skipped,
    links,
  };
}
