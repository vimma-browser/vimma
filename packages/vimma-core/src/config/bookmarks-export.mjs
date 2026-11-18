/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `:bookmarks export` (docs/specs/bookmarks-file.md Behaviour 17, Delivery slice 4), pure: the
 * workspace folders of Places' tree written as a new bookmarks.toml, one table per workspace in
 * the order given, each folder's contents in Places order.
 *
 * Only lines the mirror reads back as the same bookmarks are written: names are cleaned and made
 * unique per folder as the mirror names Places' items (Behaviour 15), URLs go through the file's
 * own check (`data:` and the schemes it refuses are left out and counted), and the text is parsed
 * again and must hold exactly the tables and items meant, or nothing is written. A `javascript:`
 * bookmark is written whatever `bookmarklets` says, because it is the user's own (Behaviour 17);
 * the mirror still adds none from the file while bookmarklets are off (D13).
 */
import { bookmarkKey, cleanName, tableKey } from "./bookmarks-edit.mjs";
import {
  BOOKMARKS_FILE,
  MAX_BOOKMARKS_FILE_BYTES,
  MAX_BOOKMARK_DEPTH,
  MAX_BOOKMARK_LINES,
  MAX_BOOKMARK_TITLE,
  lineUrl,
  parseBookmarksFile,
  tableNameProblem,
  utf8Over,
} from "./bookmarks-file.mjs";
import { tomlLiteral } from "./toml.mjs";

/** @import { FileItem, PlacesNode } from "./bookmarks-file.mjs" */

const TYPE_BOOKMARK = 1;
const TYPE_FOLDER = 2;
/** Places' tags root: tags are bookmarks of their own there, never the user's (D16). */
const TAGS_ROOT = "tags________";
/** The name of a folder Places holds without a title, which the file cannot hold. */
const UNTITLED = "untitled";

/** The comment an exported file starts with. */
export const EXPORT_HEADER = [
  "# Vimma's bookmarks: one [bookmarks.<workspace>] table per workspace, one",
  '# "folder/title" = "URL" line per bookmark. Every URL here goes wherever this file goes.',
].join("\n");

/**
 * What an export leaves out: `outside`, bookmarks outside the exported folders (Behaviour 17);
 * `data`, `data:` bookmarks; `unholdable`, other URLs the file refuses (Behaviour 4); `deep`,
 * bookmarks below the file's 32 folders.
 * @typedef {{ outside: number, data: number, unholdable: number, deep: number }} LeftOut
 */

/**
 * A title as the mirror compares it (D5): trimmed, cut to Places' limit.
 * @param {string | undefined} t
 */
const normTitle = (t) => (t ?? "").trim().slice(0, MAX_BOOKMARK_TITLE);

/** A `data:` URL, by its parsed scheme as the file's check reads it. */
function isData(/** @type {string} */ url) {
  try {
    return new URL(url).protocol === "data:";
  } catch {
    return false;
  }
}

/**
 * The bookmarks below `node`, itself included, without recursion.
 * @param {PlacesNode} node
 */
function countBookmarks(node) {
  let n = 0;
  const stack = [node];
  while (stack.length) {
    const x = /** @type {PlacesNode} */ (stack.pop());
    if (x.typeCode === TYPE_BOOKMARK) n++;
    for (const c of x.children ?? []) stack.push(c);
  }
  return n;
}

/**
 * Every folder of `tree` by guid, without recursion.
 * @param {PlacesNode} tree
 */
function foldersOf(tree) {
  /** @type {Map<string, PlacesNode>} */
  const map = new Map();
  const stack = [tree];
  while (stack.length) {
    const x = /** @type {PlacesNode} */ (stack.pop());
    if (x.guid && x.typeCode === TYPE_FOLDER) map.set(x.guid, x);
    for (const c of x.children ?? []) stack.push(c);
  }
  return map;
}

/**
 * Writes the workspace folders `tables` of Places' tree `places` as a new bookmarks.toml.
 * `renames` lists the items whose name in the file is not their title in Places (an empty title,
 * hidden characters, a second item of one name), so that Places can take the written name and
 * the mirror's first run finds both sides alike (Behaviour 15).
 * @param {{ places: PlacesNode, tables: readonly { name: string, folder: string }[] }} input
 *   `places`: the whole tree (promiseBookmarksTree("")); `tables`: each workspace's name and
 *   folder, in the order the file lists them; a name the file refuses, a name or folder given
 *   twice, and a folder Places lacks are skipped
 * @returns {{ ok: true, text: string, bookmarks: number,
 *   tables: { name: string, bookmarks: number }[], leftOut: LeftOut,
 *   renames: { guid: string, title: string }[] } | { ok: false, error: string }}
 */
export function exportBookmarks({ places, tables }) {
  const folders = foldersOf(places);
  /** @type {LeftOut} */
  const leftOut = { outside: 0, data: 0, unholdable: 0, deep: 0 };
  /** @type {{ guid: string, title: string }[]} */
  const renames = [];
  /** @type {{ name: string, bookmarks: number }[]} */
  const written = [];
  /** @type {{ name: string, children: FileItem[] }[]} */
  const expected = [];
  /** @type {string[]} */
  const out = [EXPORT_HEADER];
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const used = new Set();
  let budget = MAX_BOOKMARK_LINES;
  let total = 0;

  for (const t of tables) {
    const node = folders.get(t.folder);
    if (!node || names.has(t.name) || used.has(t.folder) || tableNameProblem(t.name)) continue;
    names.add(t.name);
    used.add(t.folder);
    /** @type {FileItem[]} */
    const top = [];
    /** @type {string[]} */
    const lines = [];
    let count = 0;
    /**
     * The folders being walked, depth first, so each folder's lines follow its place (D3).
     * @type {{ kids: readonly PlacesNode[], i: number, path: string[], into: FileItem[],
     *   taken: Set<string>, wrote: number }[]}
     */
    const walk = [
      { kids: node.children ?? [], i: 0, path: [], into: top, taken: new Set(), wrote: 0 },
    ];
    while (walk.length) {
      const w = /** @type {(typeof walk)[number]} */ (walk.at(-1));
      const c = w.kids[w.i++];
      if (!c) {
        walk.pop();
        // A folder (not the table) with nothing written keeps an empty folder's line (decision 4).
        if (w.path.length && !w.wrote) lines.push(`${bookmarkKey(w.path, true)} = ""`);
        continue;
      }
      const kind =
        c.typeCode === TYPE_FOLDER ? "folder" : c.typeCode === TYPE_BOOKMARK ? "bookmark" : null;
      if (!kind) continue; // a separator (D16)
      /** @param {string} name */
      const unique = (name) => {
        let n = name;
        for (let i = 2; w.taken.has(`${kind}\0${n}`); i++) n = `${name} (${i})`;
        w.taken.add(`${kind}\0${n}`);
        return n;
      };
      if (w.path.length + 1 > MAX_BOOKMARK_DEPTH) {
        leftOut.deep += countBookmarks(c);
        unique(normTitle(c.title));
        continue;
      }
      /** @type {string | null} */
      let url = null;
      if (kind === "bookmark") {
        const u = lineUrl(c.uri ?? "");
        if ("error" in u) {
          if (isData(c.uri ?? "")) leftOut.data++;
          else leftOut.unholdable++;
          // The mirror names it as Places holds it, so a written item of its name comes after.
          unique(normTitle(c.title));
          continue;
        }
        url = u.url;
      }
      const name = unique(cleanName(c.title ?? "") || (url !== null ? cleanName(url) : UNTITLED));
      if (c.guid && name !== normTitle(c.title)) renames.push({ guid: c.guid, title: name });
      if (--budget < 0) {
        return {
          ok: false,
          error: `more than ${MAX_BOOKMARK_LINES} bookmarks and folders: ${BOOKMARKS_FILE} cannot hold them; nothing written`,
        };
      }
      w.wrote++;
      const path = [...w.path, name];
      if (url !== null) {
        lines.push(`${bookmarkKey(path, false)} = ${tomlLiteral(url)}`);
        w.into.push({ kind: "bookmark", title: name, url, line: 0 });
        count++;
      } else {
        /** @type {FileItem[]} */
        const children = [];
        w.into.push({ kind: "folder", title: name, line: 0, children });
        walk.push({
          kids: c.children ?? [],
          i: 0,
          path,
          into: children,
          taken: new Set(),
          wrote: 0,
        });
      }
    }
    expected.push({ name: t.name, children: top });
    written.push({ name: t.name, bookmarks: count });
    total += count;
    out.push("", `[bookmarks.${tableKey(t.name)}]`, ...lines);
  }

  // Bookmarks outside every exported folder, tags aside (Behaviour 17).
  /** @type {PlacesNode[]} */
  const stack = [places];
  while (stack.length) {
    const x = /** @type {PlacesNode} */ (stack.pop());
    if (x.guid === TAGS_ROOT || (x.guid && used.has(x.guid))) continue;
    if (x.typeCode === TYPE_BOOKMARK) leftOut.outside++;
    for (const c of x.children ?? []) stack.push(c);
  }

  const text = `${out.join("\n")}\n`;
  if (utf8Over(text, MAX_BOOKMARKS_FILE_BYTES)) {
    return {
      ok: false,
      error: `larger than 4 MiB: ${BOOKMARKS_FILE} cannot hold it; nothing written`,
    };
  }
  // The file must read back as exactly what was meant (D10's check, for a whole file).
  const back = parseBookmarksFile(text);
  if (back.errors.length || !sameItems(back.tables, expected)) {
    return { ok: false, error: `${BOOKMARKS_FILE} export did not read back; nothing written` };
  }
  return { ok: true, text, bookmarks: total, tables: written, leftOut, renames };
}

/**
 * Whether parsed tables hold exactly the expected tables and items, in order.
 * @param {readonly { name: string, children: readonly FileItem[] }[]} a
 * @param {readonly { name: string, children: readonly FileItem[] }[]} b
 */
function sameItems(a, b) {
  /** @param {readonly FileItem[]} items @returns {unknown[]} */
  const shape = (items) =>
    items.map((i) =>
      i.kind === "folder" ? ["f", i.title, shape(i.children)] : ["b", i.title, i.url],
    );
  return (
    JSON.stringify(a.map((t) => [t.name, shape(t.children)])) ===
    JSON.stringify(b.map((t) => [t.name, shape(t.children)]))
  );
}

/**
 * What an existing bookmarks.toml holds, as the refusal and the question of `:bookmarks export`
 * say it (`12 bookmarks in "work", "home"`), so that the user knows what `!` replaces.
 * @param {string} text
 */
export function describeBookmarksFile(text) {
  const r = parseBookmarksFile(text);
  const [first] = r.errors;
  if (first) {
    const at = first.line ? `line ${first.line}: ` : "";
    return `a file that does not read (${at}${first.message})`;
  }
  if (!r.tables.length) return "no bookmarks";
  let n = 0;
  /** @type {FileItem[]} */
  const stack = r.tables.flatMap((t) => t.children);
  while (stack.length) {
    const i = /** @type {FileItem} */ (stack.pop());
    if (i.kind === "bookmark") n++;
    else stack.push(...i.children);
  }
  const shown = r.tables.slice(0, 3).map((t) => JSON.stringify(t.name));
  const more = r.tables.length > 3 ? ` and ${r.tables.length - 3} more` : "";
  return `${n} bookmark${n === 1 ? "" : "s"} in ${shown.join(", ")}${more}`;
}
