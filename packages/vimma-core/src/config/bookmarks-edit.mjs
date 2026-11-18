/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * bookmarks.toml's write-back (docs/specs/bookmarks-file.md, Delivery slice 2), pure: the line
 * writer `editBookmarkLines` (D10), the edits Vimma's keys make through it (`editBookmarks`,
 * Behaviour 10 and 15), the base kept in step with an edit (D4), the put-back loop guard (open
 * question 2) and the queue every edit and apply runs in (D11).
 *
 * The line writer keeps every byte it does not change: other lines, comments on their own lines,
 * blank lines and line ends. After each edit the text is read again and must hold exactly the
 * tables and lines the edit meant, in that order, with every other key of the file unchanged;
 * else the edit is refused and nothing is written. `editBookmarks` then reads the result as the
 * mirror would and refuses it on any error, so that Vimma never writes a file it would not read
 * (a `data:` URL, a scheme the file refuses, a bookmarklet the settings do not allow, a file over
 * a limit).
 */
import {
  BOOKMARKS_FILE,
  HIDDEN,
  MAX_BOOKMARK_DEPTH,
  MAX_BOOKMARK_TITLE,
  formatBookmarksFileError,
  isBookmarklet,
  isTable,
  lineUrl,
  readBookmarks,
  splitPath,
  tableNameProblem,
} from "./bookmarks-file.mjs";
import { parseToml, locateKeys, sameTomlValue, tomlLiteral, valueEnd } from "./toml.mjs";

/**
 * @import { Base, BaseEntry, BookmarksSource } from "./bookmarks-file.mjs"
 * @import { BookmarkletsSetting } from "../ui/bookmarks.mjs"
 */

/**
 * One line of a table, as the file holds it: `line` its first line, `end` its last (a value in
 * a multi-line string spans several), the path's names, whether it is an empty folder's line.
 * @typedef {{ line: number, end: number, names: string[], folder: boolean, value: string }}
 *   ScanLine
 * @typedef {{ name: string, header: number, lines: ScanLine[] }} ScanTable
 */

/**
 * A line the writer adds or a key it sets: the path's names, and whether it is a folder's line;
 * `keep`, the line (of the text as given) whose trailing comment it carries, for a moved line.
 * @typedef {{ names: string[], folder: boolean, value: string, keep?: number }} NewLine
 */

/**
 * The line writer's operations (D10). `line` is a line number of the text as given.
 * @typedef {{ op: "add", table: string, after?: number, lines: NewLine[] }
 *   | { op: "remove", line: number }
 *   | { op: "replace", line: number, names?: string[], folder?: boolean, value?: string,
 *     keep?: number, bare?: boolean }
 *   | { op: "move", line: number, table: string, after?: number }
 *   | { op: "addTable", name: string }
 *   | { op: "renameTable", from: string, to: string }
 *   | { op: "removeTable", name: string }} LineOp
 */

/**
 * A Places item to write into the file (a bookmark, or a folder with its children).
 * @typedef {{ guid?: string, title: string, url?: string, children?: TreeNode[] }} TreeNode
 */

/**
 * What Vimma's keys ask of the file, by table and path.
 * @typedef {{ op: "add", table: string, folders: string[], title: string | null,
 *     url: string | null }
 *   | { op: "move", table: string, kind: "bookmark" | "folder", path: string[], toTable: string,
 *     toFolders: string[], toTitle: string }
 *   | { op: "remove", table: string, kind: "bookmark" | "folder", path: string[] }
 *   | { op: "renameTable", from: string, to: string }
 *   | { op: "mergeTable", from: string, to: string }
 *   | { op: "removeTable", name: string }
 *   | { op: "addTree", table: string, folders: string[], node: TreeNode }
 *   | { op: "addTrees", table: string, folders: string[], nodes: TreeNode[] }
 *   | { op: "append", table: string,
 *     items: { names: string[], url: string | null, from?: string }[] }}
 *   BookmarkChange
 */

/**
 * A move of an item (and, for a folder, everything in it) to a new path, maybe in another table.
 * @typedef {{ table: string, kind: "bookmark" | "folder", from: string[], toTable: string,
 *   to: string[] }} PathMove
 */

const BARE = /^[A-Za-z0-9_-]+$/;

/** @param {string} error @returns {{ ok: false, error: string }} */
const fail = (error) => ({ ok: false, error });

/** @param {readonly string[]} a @param {readonly string[]} b */
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** @param {readonly string[]} names @param {readonly string[]} prefix */
const startsWith = (names, prefix) =>
  names.length >= prefix.length && prefix.every((s, i) => s === names[i]);

/** A path as an error shows it. */
const shown = (/** @type {readonly string[]} */ names) => JSON.stringify(names.join("/"));

/**
 * A path as a TOML key (D3): always a quoted basic string, `/` in a name as `\/` and `\` as
 * `\\` (quick add's escapes), a folder's with a trailing `/`; then TOML's own escapes, DEL
 * included.
 * @param {readonly string[]} names
 * @param {boolean} folder
 */
export function bookmarkKey(names, folder) {
  const text = names.map((n) => n.replace(/[\\/]/g, (c) => `\\${c}`)).join("/");
  return tomlLiteral(folder ? `${text}/` : text);
}

/** A table's name as its header writes it: bare when it can be, else quoted. */
const tableKey = (/** @type {string} */ name) => (BARE.test(name) ? name : tomlLiteral(name));

/**
 * Where a key that starts at `row[i]` ends, or -1: a basic or literal string, or a bare key.
 * A dotted key is not one: its table is not a header of its own.
 * @param {string} row
 * @param {number} i
 */
function keyEnd(row, i) {
  let k = i;
  if (row[k] === '"') {
    for (k++; k < row.length; k++) {
      if (row[k] === "\\") k++;
      else if (row[k] === '"') break;
    }
    if (k >= row.length) return -1;
    k++;
  } else if (row[k] === "'") {
    k = row.indexOf("'", k + 1);
    if (k < 0) return -1;
    k++;
  } else {
    while (k < row.length && /[A-Za-z0-9_-]/.test(/** @type {string} */ (row[k]))) k++;
    if (k === i) return -1;
  }
  let j = k;
  while (row[j] === " " || row[j] === "\t") j++;
  return row[j] === "=" ? k : -1;
}

/** Where the value of the `key = value` line `row` starts, or -1. */
function valueStart(/** @type {string} */ row) {
  const ks = row.length - row.trimStart().length;
  const ke = keyEnd(row, ks);
  if (ke < 0) return -1;
  let j = ke;
  while (row[j] === " " || row[j] === "\t") j++;
  j++; // the `=`
  while (row[j] === " " || row[j] === "\t") j++;
  return j;
}

/**
 * The names of a `[a.b."c"]` header line and where it ends, or null.
 * @param {string} row
 * @returns {{ names: string[], start: number, end: number } | null}
 */
function readHeader(row) {
  const start = row.length - row.trimStart().length;
  if (row[start] !== "[" || row[start + 1] === "[") return null;
  /** @type {string[]} */
  const names = [];
  let k = start + 1;
  for (;;) {
    while (row[k] === " " || row[k] === "\t") k++;
    if (row[k] === '"') {
      let j = k + 1;
      for (; j < row.length && row[j] !== '"'; j++) if (row[j] === "\\") j++;
      if (j >= row.length) return null;
      /** @type {unknown} */
      let name;
      try {
        name = JSON.parse(row.slice(k, j + 1));
      } catch {
        return null; // TOML escapes JSON lacks (\e, \U): not a header this writer rewrites
      }
      names.push(/** @type {string} */ (name));
      k = j + 1;
    } else if (row[k] === "'") {
      const j = row.indexOf("'", k + 1);
      if (j < 0) return null;
      names.push(row.slice(k + 1, j));
      k = j + 1;
    } else {
      const j = k;
      while (k < row.length && /[A-Za-z0-9_-]/.test(/** @type {string} */ (row[k]))) k++;
      if (k === j) return null;
      names.push(row.slice(j, k));
    }
    while (row[k] === " " || row[k] === "\t") k++;
    if (row[k] === ".") k++;
    else if (row[k] === "]") return { names, start, end: k + 1 };
    else return null;
  }
}

/**
 * The bookmarks tables of `text` (bookmarks.toml, or config.toml's inline tables) line by line,
 * or why the line writer cannot edit them: the text does not parse, a table is not a header
 * line of its own, or a line is not a plain `"path" = "url"` line.
 * @param {string} text
 * @returns {{ tables: ScanTable[], value: Record<string, unknown> } | { error: string }}
 */
function scan(text) {
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) return { error: `line ${parsed.error.line}: ${parsed.error.message}` };
  const rows = text.split("\n");
  const lineOf = locateKeys(text);
  /** @type {ScanTable[]} */
  const tables = [];
  const section = parsed.value.bookmarks;
  if (isTable(section)) {
    for (const [name, raw] of Object.entries(section)) {
      if (!isTable(raw)) continue; // a setting of config.toml
      const header = lineOf(["bookmarks", name]) ?? 0;
      const h = readHeader(rows[header - 1] ?? "");
      if (!h || !samePath(h.names, ["bookmarks", name])) {
        return {
          error: `line ${header}: [bookmarks.${name.slice(0, 80)}] is not a table header of its own; write-back edits only those`,
        };
      }
      /** @type {ScanLine[]} */
      const lines = [];
      for (const [key, value] of Object.entries(raw)) {
        const at = lineOf(["bookmarks", name, key]) ?? 0;
        const row = rows[at - 1] ?? "";
        const vs = typeof value === "string" && at > header ? valueStart(row) : -1;
        const path = splitPath(key, MAX_BOOKMARK_DEPTH);
        if (vs < 0 || !path) return { error: `line ${at}: not a "path" = "URL" line` };
        let end = at;
        const delim = row.slice(vs, vs + 3);
        if ((delim === '"""' || delim === "'''") && row.indexOf(delim, vs + 3) < 0) {
          while (end < rows.length && !(rows[end] ?? "").includes(delim)) end++;
          end++;
        }
        lines.push({
          line: at,
          end,
          names: path.leaf === null ? path.names : [...path.names, path.leaf],
          folder: path.leaf === null,
          value: /** @type {string} */ (value),
        });
      }
      lines.sort((a, b) => a.line - b.line);
      tables.push({ name, header, lines });
    }
  }
  tables.sort((a, b) => a.header - b.header);
  return { tables, value: parsed.value };
}

/**
 * A parsed document without its bookmarks tables: what an edit must leave alone. A `bookmarks`
 * table left empty counts as none, since removing the last table leaves no `bookmarks` key.
 */
function rest(/** @type {Record<string, unknown>} */ value) {
  const out = { ...value };
  if (isTable(out.bookmarks)) {
    const settings = Object.entries(out.bookmarks).filter(([, v]) => !isTable(v));
    if (settings.length) out.bookmarks = Object.fromEntries(settings);
    else delete out.bookmarks;
  }
  return out;
}

/**
 * Edits the bookmarks tables of `text` line by line (D10): every other line, comment and blank
 * line stays byte for byte, line ends are kept (CRLF too), keys are written as quoted basic
 * strings. A removed line takes its trailing comment with it; comments on their own lines stay
 * where they are, a removed table's too. The result is read again and must hold exactly the
 * tables and lines the operations meant, in order, and every other key unchanged; else nothing
 * is edited.
 * @param {string} text
 * @param {readonly LineOp[]} ops
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function editBookmarkLines(text, ops) {
  const before = scan(text);
  if ("error" in before) return fail(before.error);
  const cr = text.includes("\r\n") ? "\r" : "";
  const rows = text.split("\n");

  /**
   * The text as records: a header, an entry (all the rows of one line's value) or any other
   * row. `ref` names an entry: its line number, or a new one's own id.
   * @typedef {{ text: string, kind: "header" | "entry" | "other", table?: string,
   *   ref?: number | string }} Rec
   */
  /** @type {Map<number, string>} */
  const headers = new Map(before.tables.map((t) => [t.header, t.name]));
  /** @type {Map<number, { table: string, end: number }>} */
  const entries = new Map();
  for (const t of before.tables) {
    for (const l of t.lines) entries.set(l.line, { table: t.name, end: l.end });
  }
  /** @type {Rec[]} */
  const recs = [];
  for (let n = 1; n <= rows.length;) {
    const h = headers.get(n);
    const e = entries.get(n);
    if (h !== undefined) {
      recs.push({ text: /** @type {string} */ (rows[n - 1]), kind: "header", table: h });
      n++;
    } else if (e) {
      recs.push({
        text: rows.slice(n - 1, e.end).join("\n"),
        kind: "entry",
        table: e.table,
        ref: n,
      });
      n = e.end + 1;
    } else {
      recs.push({ text: /** @type {string} */ (rows[n - 1]), kind: "other" });
      n++;
    }
  }

  /** The expected model: each table's lines in order. */
  /** @type {{ name: string, lines: (NewLine & { ref: number | string })[] }[]} */
  const model = before.tables.map((t) => ({
    name: t.name,
    lines: t.lines.map((l) => ({ ref: l.line, names: l.names, folder: l.folder, value: l.value })),
  }));
  let made = 0;
  const modelTable = (/** @type {string} */ name) => model.find((t) => t.name === name);
  const entryIndex = (/** @type {number} */ line) =>
    recs.findIndex((r) => r.kind === "entry" && r.ref === line);
  /** @param {number} line */
  const modelLine = (line) => {
    for (const t of model) {
      const i = t.lines.findIndex((l) => l.ref === line);
      if (i >= 0) return { t, i };
    }
    return null;
  };
  /**
   * Where lines go in `table`: after line `after`, else after the table's last line (or its
   * header).
   * @param {string} table
   * @param {number | undefined} after
   * @returns {{ rec: number, line: number } | null}  record index and model index to insert at
   */
  const insertAt = (table, after) => {
    const t = modelTable(table);
    if (!t) return null;
    if (after !== undefined) {
      const at = modelLine(after);
      const r = entryIndex(after);
      if (!at || at.t !== t || r < 0) return null;
      return { rec: r + 1, line: at.i + 1 };
    }
    let r = recs.findIndex((x) => x.kind === "header" && x.table === table);
    for (let k = r + 1; k < recs.length; k++) {
      const x = /** @type {Rec} */ (recs[k]);
      if (x.kind === "header") break;
      if (x.kind === "entry" && x.table === table) r = k;
    }
    return { rec: r + 1, line: t.lines.length };
  };
  /** The trailing text (spaces and a comment) after line `n`'s one-line value, without its CR. */
  const tailOf = (/** @type {number} */ n) => {
    const row = rows[n - 1] ?? "";
    const vs = valueStart(row);
    const stop = vs < 0 ? -1 : valueEnd(row, vs);
    return stop < 0 ? "" : row.slice(stop).replace(/\r$/, "");
  };
  const lineText = (/** @type {NewLine} */ l) =>
    `${bookmarkKey(l.names, l.folder)} = ${tomlLiteral(l.value)}${l.keep ? tailOf(l.keep) : ""}${cr}`;
  // Without a line break at its end, the file's last row gets one when a line goes after it.
  const lastRow = text.endsWith("\n") ? null : recs.at(-1);

  for (const op of ops) {
    if (op.op === "add") {
      const at = insertAt(op.table, op.after);
      if (!at) return fail(`no place for the new lines in [bookmarks.${op.table}]`);
      const t = /** @type {NonNullable<ReturnType<typeof modelTable>>} */ (modelTable(op.table));
      const newRecs = op.lines.map((l) => {
        const ref = `new${++made}`;
        return {
          rec: { text: lineText(l), kind: /** @type {const} */ ("entry"), table: op.table, ref },
          line: { ...l, ref },
        };
      });
      recs.splice(at.rec, 0, ...newRecs.map((x) => x.rec));
      t.lines.splice(at.line, 0, ...newRecs.map((x) => x.line));
    } else if (op.op === "remove" || op.op === "move") {
      const r = entryIndex(op.line);
      const m = modelLine(op.line);
      if (r < 0 || !m) return fail(`line ${op.line} is not a bookmark's line`);
      const [rec] = recs.splice(r, 1);
      const [line] = m.t.lines.splice(m.i, 1);
      if (op.op === "move") {
        const at = insertAt(op.table, op.after);
        if (!at) return fail(`no place for line ${op.line} in [bookmarks.${op.table}]`);
        recs.splice(at.rec, 0, { .../** @type {Rec} */ (rec), table: op.table });
        /** @type {NonNullable<ReturnType<typeof modelTable>>} */ (
          modelTable(op.table)
        ).lines.splice(at.line, 0, /** @type {NewLine & { ref: number | string }} */ (line));
      }
    } else if (op.op === "replace") {
      const r = entryIndex(op.line);
      const m = modelLine(op.line);
      if (r < 0 || !m) return fail(`line ${op.line} is not a bookmark's line`);
      const rec = /** @type {Rec} */ (recs[r]);
      const line = /** @type {NewLine} */ (m.t.lines[m.i]);
      const [first, ...more] = rec.text.split("\n");
      let row = /** @type {string} */ (first);
      if (op.value !== undefined) {
        const vs = valueStart(row);
        const stop = vs < 0 ? -1 : valueEnd(row, vs);
        if (stop < 0) return fail(`line ${op.line}: not a one-line value`);
        row = `${row.slice(0, vs)}${tomlLiteral(op.value)}${row.slice(stop)}`;
        line.value = op.value;
      }
      if (op.names !== undefined || op.folder !== undefined) {
        const ks = row.length - row.trimStart().length;
        const ke = keyEnd(row, ks);
        if (ke < 0) return fail(`line ${op.line}: not a "path" = "URL" line`);
        line.names = op.names ?? line.names;
        line.folder = op.folder ?? line.folder;
        row = `${row.slice(0, ks)}${bookmarkKey(line.names, line.folder)}${row.slice(ke)}`;
      }
      if (op.keep !== undefined || op.bare) {
        const vs = valueStart(row);
        const stop = vs < 0 ? -1 : valueEnd(row, vs);
        if (stop < 0) return fail(`line ${op.line}: not a one-line value`);
        const end = row.endsWith("\r") ? "\r" : "";
        row = `${row.slice(0, stop)}${op.keep !== undefined ? tailOf(op.keep) : ""}${end}`;
      }
      rec.text = [row, ...more].join("\n");
    } else if (op.op === "addTable") {
      if (modelTable(op.name)) return fail(`[bookmarks.${op.name}] is there already`);
      // Before the empty string after the file's last line break, so the file still ends in one.
      let at = recs.length;
      const last = recs[at - 1];
      if (last && last.kind === "other" && last.text === "") at--;
      const prev = recs[at - 1];
      const add = [];
      if (prev && prev.text.trim() !== "")
        add.push({ text: cr, kind: /** @type {const} */ ("other") });
      add.push({
        text: `[bookmarks.${tableKey(op.name)}]${cr}`,
        kind: /** @type {const} */ ("header"),
        table: op.name,
      });
      if (at === recs.length) add.push({ text: "", kind: /** @type {const} */ ("other") });
      recs.splice(at, 0, ...add);
      model.push({ name: op.name, lines: [] });
    } else if (op.op === "renameTable") {
      const r = recs.findIndex((x) => x.kind === "header" && x.table === op.from);
      const t = modelTable(op.from);
      if (r < 0 || !t) return fail(`no [bookmarks.${op.from}]`);
      if (modelTable(op.to)) return fail(`[bookmarks.${op.to}] is there already`);
      const rec = /** @type {Rec} */ (recs[r]);
      const h = /** @type {NonNullable<ReturnType<typeof readHeader>>} */ (readHeader(rec.text));
      rec.text = `${rec.text.slice(0, h.start)}[bookmarks.${tableKey(op.to)}]${rec.text.slice(h.end)}`;
      for (const x of recs) if (x.table === op.from) x.table = op.to;
      t.name = op.to;
    } else if (op.op === "removeTable") {
      const t = modelTable(op.name);
      if (!t) return fail(`no [bookmarks.${op.name}]`);
      for (let k = recs.length - 1; k >= 0; k--) {
        const x = /** @type {Rec} */ (recs[k]);
        if (x.table === op.name && x.kind !== "other") recs.splice(k, 1);
      }
      model.splice(model.indexOf(t), 1);
    }
  }

  if (lastRow && recs.at(-1) !== lastRow) {
    if (cr && recs.includes(lastRow) && !lastRow.text.endsWith(cr)) lastRow.text += cr;
    const end = /** @type {Rec} */ (recs.at(-1));
    end.text = end.text.replace(/\r$/, "");
  }
  const out = recs.map((r) => r.text).join("\n");
  const after = scan(out);
  if ("error" in after) return fail(`the edit would not read back: ${after.error}`);
  const want = JSON.stringify(
    model.map((t) => [t.name, t.lines.map((l) => [l.names, l.folder, l.value])]),
  );
  const got = JSON.stringify(
    after.tables.map((t) => [t.name, t.lines.map((l) => [l.names, l.folder, l.value])]),
  );
  if (want !== got) return fail("the edit would not read back as meant; nothing written");
  if (!sameTomlValue(rest(before.value), rest(after.value))) {
    return fail("the edit would change other keys; nothing written");
  }
  return { ok: true, text: out };
}

/**
 * A name as the file may hold it (Behaviour 4, 15): control characters become spaces,
 * bidirectional and invisible ones go, spaces at either end are trimmed, and it is cut to
 * Places' 4,096 characters without splitting a character.
 * @param {string} name
 */
export function cleanName(name) {
  let out = "";
  for (const ch of name) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    if (c < 0x20 || c === 0x7f) out += " ";
    // A lone surrogate (a DOM title may hold one) cannot be written as UTF-8 or a TOML escape.
    else if (c >= 0xd800 && c <= 0xdfff) out += "\ufffd";
    else if (!HIDDEN.test(ch)) out += ch;
  }
  out = out.trim();
  if (out.length > MAX_BOOKMARK_TITLE) {
    out = out.slice(0, MAX_BOOKMARK_TITLE);
    if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out;
}

/**
 * A URL as a line holds it, or why it cannot be written: the file's own rules (Behaviour 4: no
 * `data:`, only the schemes it allows) and bookmarklets only while they are allowed (D13).
 * @param {string} url
 * @param {BookmarkletsSetting} bookmarklets
 * @returns {{ url: string } | { error: string }}
 */
function writableUrl(url, bookmarklets) {
  const u = lineUrl(url);
  if ("error" in u) return { error: `${BOOKMARKS_FILE} cannot hold it: ${u.error}` };
  if (isBookmarklet(u.url) && bookmarklets !== "user" && bookmarklets !== "agent") {
    return {
      error: `a bookmarklet is written to ${BOOKMARKS_FILE} only with [bookmarks] bookmarklets = "user" or "agent"`,
    };
  }
  return u;
}

/**
 * The lines of a table at or below folder `path` (its own empty-folder line included).
 * @param {ScanTable} t
 * @param {readonly string[]} path
 */
const inside = (t, path) =>
  t.lines.filter((l) => startsWith(l.names, path) && (l.names.length > path.length || l.folder));

/** The kind of a line's name at depth `d`: a folder when a deeper name follows, or it is one. */
const kindAt = (/** @type {ScanLine} */ l, /** @type {number} */ d) =>
  l.names.length > d + 1 || l.folder ? "folder" : "bookmark";

/**
 * The names folder `path` holds, as `kind\0name`, leaving out the lines in `skip`.
 * @param {ScanTable} t
 * @param {readonly string[]} path
 * @param {ReadonlySet<number>} [skip]
 */
function childNames(t, path, skip = new Set()) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const l of t.lines) {
    if (skip.has(l.line) || l.names.length <= path.length || !startsWith(l.names, path)) continue;
    names.add(`${kindAt(l, path.length)}\0${l.names[path.length]}`);
  }
  return names;
}

/**
 * `name`, or `name (2)`, `(3)`, … when folder already holds that name (Behaviour 15; open
 * question 1, answer a): a TOML table cannot hold one key twice.
 * @param {string} name
 * @param {"bookmark" | "folder"} kind
 * @param {Set<string>} taken  updated with the name returned
 */
function unique(name, kind, taken) {
  let out = name;
  for (let n = 2; taken.has(`${kind}\0${out}`); n++) out = `${name} (${n})`;
  taken.add(`${kind}\0${out}`);
  return out;
}

/**
 * The operations that put `lines` into folder `folders` of table `t` (Behaviour 10): in place of
 * the empty-folder line of that folder or one above it (D4's empty folders are written only
 * while empty), else after the folder's last line, else (a new folder) at the table's end.
 * Lines in `skip` (being moved away) are no anchor.
 * @param {ScanTable} t
 * @param {readonly string[]} folders
 * @param {NewLine[]} lines
 * @param {ReadonlySet<number>} skip
 * @returns {LineOp[]}
 */
function place(t, folders, lines, skip) {
  if (!lines.length) return [];
  const empties = t.lines
    .filter((l) => l.folder && !skip.has(l.line) && startsWith(folders, l.names))
    .sort((a, b) => b.names.length - a.names.length);
  if (empties.length) {
    const [deepest, ...others] = /** @type {[ScanLine, ...ScanLine[]]} */ (empties);
    const [first, ...more] = /** @type {[NewLine, ...NewLine[]]} */ (lines);
    /** @type {LineOp[]} */
    const ops = [{ op: "replace", line: deepest.line, ...first }];
    if (more.length) ops.push({ op: "add", table: t.name, after: deepest.line, lines: more });
    for (const l of others) ops.push({ op: "remove", line: l.line });
    return ops;
  }
  const there = folders.length ? inside(t, folders).filter((l) => !skip.has(l.line)) : [];
  const last = there.at(-1);
  return [{ op: "add", table: t.name, ...(last ? { after: last.line } : {}), lines }];
}

/**
 * The lines of an item being moved or removed: a bookmark's own line, or every line at or below
 * a folder.
 * @param {ScanTable} t
 * @param {"bookmark" | "folder"} kind
 * @param {readonly string[]} path
 */
const sourceLines = (t, kind, path) =>
  kind === "bookmark"
    ? t.lines.filter((l) => !l.folder && samePath(l.names, path))
    : inside(t, path);

/**
 * Takes `lines` out of table `t`; when that leaves their folder (not the table itself) with
 * nothing, the first becomes that folder's empty line, so the folder stays as it does in Places.
 * @param {ScanTable} t
 * @param {ScanLine[]} lines
 * @param {readonly string[]} parent
 * @returns {LineOp[]}
 */
function takeOut(t, lines, parent) {
  const skip = new Set(lines.map((l) => l.line));
  const emptied = parent.length > 0 && !inside(t, parent).some((l) => !skip.has(l.line));
  const [first, ...others] = /** @type {[ScanLine, ...ScanLine[]]} */ (lines);
  /** @type {LineOp[]} */
  const ops = emptied
    ? [
        // The folder's line, without the moved line's comment.
        {
          op: "replace",
          line: first.line,
          names: [...parent],
          folder: true,
          value: "",
          bare: true,
        },
      ]
    : [{ op: "remove", line: first.line }];
  for (const l of others) ops.push({ op: "remove", line: l.line });
  return ops;
}

/**
 * The lines of a Places subtree written as folder `top` (its children's names made unique per
 * folder, as `named` does in the plan), with the base entries of every item that has a guid.
 * @param {TreeNode} node
 * @param {string[]} top
 * @param {BookmarkletsSetting} bookmarklets
 * @returns {{ lines: NewLine[], entries: BaseEntry[] } | { error: string }}
 */
function treeLines(node, top, bookmarklets) {
  /** @type {NewLine[]} */
  const lines = [];
  /** @type {BaseEntry[]} */
  const entries = [];
  /** @type {[TreeNode, string[]][]} */
  const stack = [[node, top]];
  while (stack.length) {
    const [n, path] = /** @type {[TreeNode, string[]]} */ (stack.pop());
    if (path.length > MAX_BOOKMARK_DEPTH)
      return { error: `deeper than ${MAX_BOOKMARK_DEPTH} folders` };
    if (n.url !== undefined) {
      const u = writableUrl(n.url, bookmarklets);
      if ("error" in u) return { error: `${shown(path)}: ${u.error}` };
      lines.push({ names: path, folder: false, value: u.url });
      if (n.guid) entries.push({ path, kind: "bookmark", url: u.url, guid: n.guid });
      continue;
    }
    if (n.guid) entries.push({ path, kind: "folder", guid: n.guid });
    const kids = n.children ?? [];
    if (!kids.length) lines.push({ names: path, folder: true, value: "" });
    /** @type {Set<string>} */
    const taken = new Set();
    /** @type {[TreeNode, string[]][]} */
    const next = [];
    for (const c of kids) {
      const kind = c.url !== undefined ? "bookmark" : "folder";
      const title = cleanName(c.title) || (c.url !== undefined ? cleanName(c.url) : "");
      if (!title) return { error: `${shown(path)}: a folder without a name` };
      next.push([c, [...path, unique(title, kind, taken)]]);
    }
    // Reversed onto the stack, so the lines keep Places' order.
    stack.push(...next.reverse());
  }
  return { lines, entries };
}

/**
 * The edit of the bookmarks file (`text`, bookmarks.toml or config.toml) that one of Vimma's
 * bookmark changes makes (Behaviour 10, 15; D10). Names are cleaned and made unique in their
 * folder (`renamed` says when); URLs are checked as the file reads them. The edited text must
 * read back as the mirror reads it, without an error, or the edit is refused.
 *
 * `path`: where an added or moved item ended up; `moves`: the paths that changed, for the base;
 * `entries`: the base entries of a subtree written from Places; `removed`: bookmarks removed;
 * `written`: lines an `append` wrote (it skips what the file cannot hold); `unchanged`: there was
 * nothing to write.
 * @param {string} text
 * @param {BookmarksSource} source
 * @param {BookmarkChange} change
 * @param {{ bookmarklets: BookmarkletsSetting }} options
 * @returns {{ ok: true, text: string, path: string[], moves: PathMove[], entries: BaseEntry[],
 *   removed: number, written: number, unchanged: boolean,
 *   renamed?: { from: string, to: string } } | { ok: false, error: string }}
 */
export function editBookmarks(text, source, change, { bookmarklets }) {
  const s = scan(text);
  if ("error" in s) return fail(`${source}: ${s.error}`);
  const table = (/** @type {string} */ name) => s.tables.find((t) => t.name === name);
  const missing = (/** @type {string} */ name) =>
    fail(`${source} has no [bookmarks.${name.slice(0, 80)}]`);
  /** @type {LineOp[]} */
  let ops = [];
  /** @type {string[]} */
  let path = [];
  /** @type {PathMove[]} */
  const moves = [];
  /** @type {BaseEntry[]} */
  let entries = [];
  let removed = 0;
  let written = 0;
  /** @type {{ from: string, to: string } | undefined} */
  let renamed;
  /** @param {readonly string[]} names */
  const cleanAll = (names) => {
    const out = names.map(cleanName);
    return out.some((n) => !n) ? null : out;
  };

  switch (change.op) {
    case "add": {
      const t = table(change.table);
      if (!t) return missing(change.table);
      const folders = cleanAll(change.folders);
      if (!folders) return fail("bookmark: empty folder name");
      if (change.url === null) {
        const title = change.title === null ? null : cleanName(change.title);
        path = title ? [...folders, title] : folders;
        if (!path.length) return fail("folder: empty name");
        if (inside(t, path).length) {
          return { ok: true, text, path, moves, entries, removed, written, unchanged: true };
        }
        ops = place(t, path, [{ names: path, folder: true, value: "" }], new Set());
        break;
      }
      const u = writableUrl(change.url, bookmarklets);
      if ("error" in u) return fail(u.error);
      const title = cleanName(change.title ?? "") || cleanName(u.url);
      const name = unique(title, "bookmark", childNames(t, folders));
      if (name !== title) renamed = { from: title, to: name };
      path = [...folders, name];
      ops = place(t, folders, [{ names: path, folder: false, value: u.url }], new Set());
      break;
    }
    case "move": {
      const from = table(change.table);
      const to = table(change.toTable);
      if (!from) return missing(change.table);
      if (!to) return missing(change.toTable);
      const src = sourceLines(from, change.kind, change.path);
      if (!src.length) return fail(`${shown(change.path)} is not in ${source}`);
      const folders = cleanAll(change.toFolders);
      if (!folders) return fail("move: empty folder name");
      if (change.kind === "folder" && from === to && startsWith(folders, change.path)) {
        return fail("move: not into itself");
      }
      const first = /** @type {ScanLine} */ (src[0]);
      const title =
        cleanName(change.toTitle) || (change.kind === "bookmark" ? cleanName(first.value) : "");
      if (!title) return fail("rename: empty name");
      const skip = new Set(src.map((l) => l.line));
      const name = unique(title, change.kind, childNames(to, folders, skip));
      if (name !== title) renamed = { from: title, to: name };
      path = [...folders, name];
      if (from === to && samePath(path, change.path)) {
        return { ok: true, text, path, moves, entries, removed, written, unchanged: true };
      }
      const depth = change.path.length;
      /** @type {(l: ScanLine) => NewLine} */
      const moved = (l) => ({
        names: [...path, ...l.names.slice(depth)],
        folder: l.folder,
        value: l.value,
        keep: l.line,
      });
      const parent = change.path.slice(0, -1);
      if (from === to && samePath(parent, folders)) {
        ops = src.map((l) => ({ op: "replace", line: l.line, names: moved(l).names }));
      } else {
        ops = [...takeOut(from, src, parent), ...place(to, folders, src.map(moved), skip)];
      }
      moves.push({
        table: change.table,
        kind: change.kind,
        from: [...change.path],
        toTable: change.toTable,
        to: path,
      });
      break;
    }
    case "remove": {
      const t = table(change.table);
      if (!t) return missing(change.table);
      const src = sourceLines(t, change.kind, change.path);
      if (!src.length) return fail(`${shown(change.path)} is not in ${source}`);
      ops = takeOut(t, src, change.path.slice(0, -1));
      removed = src.filter((l) => !l.folder).length;
      path = [...change.path];
      break;
    }
    case "renameTable": {
      if (!table(change.from)) return missing(change.from);
      if (table(change.to))
        return fail(`${source} already has [bookmarks.${change.to.slice(0, 80)}]`);
      const problem = tableNameProblem(change.to);
      if (problem) return fail(`[bookmarks.${change.to.slice(0, 80)}]: ${problem}`);
      ops = [{ op: "renameTable", from: change.from, to: change.to }];
      break;
    }
    case "mergeTable": {
      const from = table(change.from);
      const to = table(change.to);
      if (!from) return missing(change.from);
      if (!to) return missing(change.to);
      const taken = childNames(to, []);
      /** @type {Map<string, string>} each top-level item of `from` → its name in `to` */
      const names = new Map();
      /** @type {NewLine[]} */
      const lines = [];
      for (const l of from.lines) {
        const kind = kindAt(l, 0);
        const key = `${kind}\0${l.names[0]}`;
        let name = names.get(key);
        if (name === undefined) {
          name = unique(/** @type {string} */ (l.names[0]), kind, taken);
          names.set(key, name);
          moves.push({
            table: change.from,
            kind,
            from: [/** @type {string} */ (l.names[0])],
            toTable: change.to,
            to: [name],
          });
        }
        lines.push({ names: [name, ...l.names.slice(1)], folder: l.folder, value: l.value });
      }
      ops = [...place(to, [], lines, new Set()), { op: "removeTable", name: change.from }];
      break;
    }
    case "removeTable": {
      const t = table(change.name);
      if (!t) return missing(change.name);
      removed = t.lines.filter((l) => !l.folder).length;
      ops = [{ op: "removeTable", name: change.name }];
      break;
    }
    case "addTree":
    case "addTrees": {
      // Several subtrees (:wsdelete's m of a whole folder) are one edit: the file is read and
      // checked once, not once per item.
      const t = table(change.table);
      if (!t) return missing(change.table);
      const folders = cleanAll(change.folders);
      if (!folders) return fail("move: empty folder name");
      const nodes = change.op === "addTree" ? [change.node] : change.nodes;
      const taken = childNames(t, folders);
      /** @type {NewLine[]} */
      const lines = [];
      for (const node of nodes) {
        const kind = node.url !== undefined ? "bookmark" : "folder";
        const title = cleanName(node.title) || (node.url !== undefined ? cleanName(node.url) : "");
        if (!title) return fail("move: empty name");
        const name = unique(title, kind, taken);
        if (name !== title && !renamed) renamed = { from: title, to: name };
        if (!path.length) path = [...folders, name];
        const tree = treeLines(node, [...folders, name], bookmarklets);
        if ("error" in tree) return fail(tree.error);
        entries.push(...tree.entries);
        lines.push(...tree.lines);
      }
      ops = place(t, folders, lines, new Set());
      break;
    }
    case "append": {
      const t = table(change.table);
      if (!t) return missing(change.table);
      /** @type {Set<string>} */
      const have = new Set(t.lines.map((l) => `${l.folder}\0${l.names.join("\0")}`));
      /** @type {NewLine[]} */
      const lines = [];
      /** @type {Set<number>} */
      const gone = new Set();
      for (const item of change.items) {
        const names = item.names;
        // Only names the file holds as they are: else the plan could not match them again.
        if (!names.length || names.length > MAX_BOOKMARK_DEPTH) continue;
        if (names.some((n) => cleanName(n) !== n || !n)) continue;
        /** @type {string} */
        let value = "";
        if (item.url !== null) {
          const u = writableUrl(item.url, bookmarklets);
          if ("error" in u) continue;
          value = u.url;
        }
        const key = `${item.url === null}\0${names.join("\0")}`;
        if (have.has(key)) continue;
        have.add(key);
        lines.push({ names, folder: item.url === null, value });
        // An empty folder's line above it is no longer empty.
        for (const l of t.lines) {
          if (l.folder && l.names.length < names.length && startsWith(names, l.names))
            gone.add(l.line);
        }
      }
      written = lines.length;
      if (!lines.length)
        return { ok: true, text, path, moves, entries, removed, written, unchanged: true };
      ops = [
        ...[...gone].map((line) => /** @type {LineOp} */ ({ op: "remove", line })),
        { op: "add", table: change.table, lines },
      ];
      break;
    }
  }

  const r = editBookmarkLines(text, ops);
  if (!r.ok) return fail(`${source}: ${r.error}`);
  const read =
    source === BOOKMARKS_FILE
      ? readBookmarks({ file: r.text, config: null })
      : readBookmarks({ file: null, config: r.text });
  const [problem] = read.errors;
  if (problem) return fail(`not written: ${formatBookmarksFileError(problem)}`);
  return {
    ok: true,
    text: r.text,
    path,
    moves,
    entries,
    removed,
    written,
    unchanged: false,
    ...(renamed ? { renamed } : {}),
  };
}

/**
 * Where `guid` is in the base: a table's folder (`kind: "table"`), or an item by its table and
 * path; null when the base does not know it.
 * @param {{ tables: Base["tables"] } | null} base
 * @param {string} guid
 * @returns {{ table: string, kind: "table", path: string[] }
 *   | { table: string, kind: "bookmark" | "folder", path: string[] } | null}
 */
export function locateInBase(base, guid) {
  for (const t of base?.tables ?? []) {
    if (t.folder === guid) return { table: t.name, kind: "table", path: [] };
    const e = t.entries.find((x) => x.guid === guid);
    if (e) return { table: t.name, kind: e.kind, path: [...e.path] };
  }
  return null;
}

/**
 * Whether base entry `e` is the item at `path` (a bookmark's own entry), or at or below folder
 * `path`.
 * @param {BaseEntry} e
 * @param {"bookmark" | "folder"} kind
 * @param {readonly string[]} path
 */
const covers = (e, kind, path) =>
  kind === "bookmark"
    ? e.kind === "bookmark" && samePath(e.path, path)
    : startsWith(e.path, path) && (e.path.length > path.length || e.kind === "folder");

/**
 * The base after one of Vimma's edits (D4), so that the run that follows finds each moved item
 * by its guid at its new path, even where a URL alone would not tell two bookmarks apart: a
 * table renamed, items moved (into another table too), dropped (moved out of the file), added
 * (moved in from Places, with their guids), a table removed.
 * @template {{ tables: Base["tables"] }} B
 * @param {B} base
 * @param {{ renameTable?: { from: string, to: string }, moves?: readonly PathMove[],
 *   drop?: readonly { table: string, kind: "bookmark" | "folder", path: string[] }[],
 *   add?: readonly { table: string, entries: readonly BaseEntry[] }[],
 *   removeTable?: string }} edit
 * @returns {B}
 */
export function baseAfterEdit(base, edit) {
  const next = structuredClone(base);
  const table = (/** @type {string} */ name) => next.tables.find((t) => t.name === name);
  if (edit.renameTable) {
    const t = table(edit.renameTable.from);
    if (t) t.name = edit.renameTable.to;
  }
  for (const m of edit.moves ?? []) {
    const from = table(m.table);
    if (!from) continue;
    const to = table(m.toTable);
    const moving = from.entries.filter((e) => covers(e, m.kind, m.from));
    from.entries = from.entries.filter((e) => !moving.includes(e));
    // A table the base does not know: the run matches them again by path and URL.
    if (!to) continue;
    for (const e of moving)
      to.entries.push({ ...e, path: [...m.to, ...e.path.slice(m.from.length)] });
  }
  for (const d of edit.drop ?? []) {
    const t = table(d.table);
    if (t) t.entries = t.entries.filter((e) => !covers(e, d.kind, d.path));
  }
  for (const a of edit.add ?? []) {
    const t = table(a.table);
    if (t) t.entries.push(...structuredClone(/** @type {BaseEntry[]} */ (a.entries)));
  }
  if (edit.removeTable !== undefined) {
    next.tables = next.tables.filter((t) => t.name !== edit.removeTable);
  }
  return next;
}

/** Put back this many times… */
export const PUT_BACK_TIMES = 3;
/** …within this long, and the table pauses (open question 2, answer b). */
export const PUT_BACK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Records the put-backs of one run (open question 2, answer b): `items` are the bookmarks the run
 * put back, by table and an id the host gives each (its path in the file, or the guid of an
 * item the run removed). Returns the tables in which one bookmark has now been put back three
 * times within ten minutes: two devices with different files are putting each other's changes
 * back, and the host pauses those tables both ways.
 * @param {Map<string, number[]>} history  each item's put-back times, kept by the caller
 * @param {readonly { table: string, id: string }[]} items
 * @param {number} now
 * @returns {string[]}
 */
export function notePutBacks(history, items, now) {
  /** @type {Set<string>} */
  const tripped = new Set();
  /** @type {Set<string>} */
  const seen = new Set();
  for (const { table, id } of items) {
    const key = `${table}\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const times = (history.get(key) ?? []).filter((t) => now - t < PUT_BACK_WINDOW_MS);
    times.push(now);
    history.set(key, times);
    if (times.length >= PUT_BACK_TIMES) tripped.add(table);
  }
  for (const [key, times] of history) {
    if (times.every((t) => now - t >= PUT_BACK_WINDOW_MS)) history.delete(key);
  }
  return [...tripped];
}

/**
 * The one queue every edit of config.toml and of the bookmarks file, and every apply to Places,
 * runs in (D11): tasks run one at a time, in the order queued, and a failed task does not stop
 * the next. A task must not wait for a task it queues itself (it would wait for its own end):
 * an edit's re-read is queued after the edit's task, not awaited inside it.
 */
export function serialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return {
    /**
     * @template T
     * @param {() => Promise<T> | T} task
     * @returns {Promise<T>}
     */
    run(task) {
      const run = tail.then(() => task());
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    /** Settles once every task queued so far, and every task they queued, has ended. */
    async idle() {
      /** @type {Promise<unknown>} */
      let seen;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
}
