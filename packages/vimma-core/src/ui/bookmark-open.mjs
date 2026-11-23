/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `:bookmarkopen [title]` and `:bookmarktab [title]` (docs/specs/bookmark-open.md): every stored
 * bookmark as a picker row, and what a typed title does. The title only chooses among stored
 * bookmarks; the host opens or runs the chosen one by its guid through the bookmarks panel's own
 * path (docs/specs/bookmarklets.md B10), so typed text never becomes a URL or a script.
 */
import { bookmarkKind, formatBookmarkPath } from "./bookmarks.mjs";
import { filterItems } from "./picker.mjs";

/** @import { Folder } from "./bookmarks.mjs" */

/**
 * A row of the bookmark picker. `display` is the title (an untitled web bookmark shows its URL,
 * as the panel does; an untitled bookmarklet never shows its script); `host` the web address's
 * host, matched after the title; `path` the folders it is in (`toolbar/work`), matched last;
 * `detail` the row's right-hand cell; `title` the stored title, "" when it has none, which is
 * all an exact match compares; `listed` its URL when listed, never drawn, so the host can refuse
 * one that changed before it opens (decision 6).
 * @typedef {object} BookmarkItem
 * @property {"bookmark"} kind
 * @property {string} bookmarkId  the Places guid
 * @property {string} title
 * @property {string} listed
 * @property {string} display
 * @property {string} host
 * @property {string} path
 * @property {string} detail
 * @property {boolean} active  never
 */

/** The longest typed title a refusal repeats, in code points. */
export const BOOKMARK_OPEN_QUOTE_MAX = 40;

/** The longest URL an untitled bookmark's row shows as its title, in code points. */
const UNTITLED_URL_MAX = 200;

/** @param {string} text @param {number} max */
function cut(text, max) {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max).join("")}…` : text;
}

/** @param {string} url */
function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]*)/i.exec(url);
  return m?.[1] ?? "";
}

/**
 * What a row says it is after its folders: the host of a web address, `bookmarklet`, or the
 * scheme of one that does not open from Vimma (bookmarks decision 6), so the refusal is no
 * surprise.
 * @param {string} url
 */
function what(url) {
  if (bookmarkKind(url) === "bookmarklet") return "bookmarklet";
  const host = hostOf(url);
  if (host) return host;
  return /^\s*([a-z][a-z0-9+.-]*:)/i.exec(url)?.[1]?.toLowerCase() ?? "";
}

/**
 * Every bookmark of `tree` (core fromPlaces of the whole of Places, `"all"`), in the tree's
 * order, folders left out. The Menu's own bookmarks and folders have paths from `menu`.
 * @param {Folder} tree
 * @returns {BookmarkItem[]}
 */
export function bookmarkOpenItems(tree) {
  /** @type {BookmarkItem[]} */
  const out = [];
  /** @param {Folder} f @param {string[]} names */
  const walk = (f, names) => {
    for (const node of f.children) {
      if (node.kind === "folder") {
        // The Menu's own folders are under `menu/`, so one named `toolbar` is not taken for
        // the toolbar root, which fromPlaces puts in the Menu too.
        const top = !names.length && tree.root === "menu" && !node.root ? ["menu"] : names;
        walk(node, [...top, node.title]);
        continue;
      }
      const script = bookmarkKind(node.url) === "bookmarklet";
      const path = formatBookmarkPath(names.length ? names : ["menu"]);
      const kind = what(node.url);
      out.push(
        Object.freeze({
          kind: /** @type {const} */ ("bookmark"),
          bookmarkId: node.guid,
          title: node.title,
          listed: node.url,
          display:
            node.title || (script ? "(untitled bookmarklet)" : cut(node.url, UNTITLED_URL_MAX)),
          host: script ? "" : hostOf(node.url),
          path,
          detail: kind ? `${path} · ${kind}` : path,
          active: false,
        }),
      );
    }
  };
  walk(tree, []);
  return out;
}

/** @param {string} text */
const fold = (text) => text.normalize("NFC").trim().toLowerCase();

/**
 * What `:bookmarkopen` does with its text: without one, the picker over every bookmark; with
 * one that exactly one bookmark is titled (case and outer spaces aside; an untitled bookmark is
 * never chosen this way, so neither its URL nor a placeholder opens it), that bookmark; with one
 * any bookmark matches, the picker with the text as its query (a trailing space kept), so the
 * user chooses; else a refusal.
 * @param {readonly BookmarkItem[]} items
 * @param {string | undefined} text
 * @returns {{ kind: "open", id: string } | { kind: "pick", query: string }
 *   | { kind: "refuse", text: string }}
 */
export function bookmarkOpenTarget(items, text) {
  if (!items.length) return { kind: "refuse", text: "bookmark: none saved yet" };
  const typed = (text ?? "").trim();
  if (!typed) return { kind: "pick", query: "" };
  const want = fold(typed);
  const exact = items.filter((i) => i.title && fold(i.title) === want);
  if (exact.length === 1) {
    return { kind: "open", id: /** @type {BookmarkItem} */ (exact[0]).bookmarkId };
  }
  // The query keeps a trailing space (quoted in a binding, `:bookmarkopen 'work '`), so the
  // first key typed in the picker starts a new word instead of joining the last one.
  const query = (text ?? "").trimStart();
  if (exact.length > 1 || filterItems(items, typed).length) return { kind: "pick", query };
  return {
    kind: "refuse",
    text: `bookmark: none matches "${cut(typed, BOOKMARK_OPEN_QUOTE_MAX)}"`,
  };
}
