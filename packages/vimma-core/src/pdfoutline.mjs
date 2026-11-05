/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The PDF outline (docs/specs/pdf-mode.md decision 10): the parser that bounds the outline the
 * content actor reads from pdf.js before chrome shows it (docs/security.md section 20, V8), and
 * the outline panel's state and `index` mode keys.
 */

import { PDF_MAX_PAGES, stripInvisible } from "./pdf.mjs";
import { scoreField } from "./picker.mjs";

/** The child stops reading here, as the hint reply does (HINT_REPLY_MAX_TARGETS). */
export const OUTLINE_MAX_ENTRIES = 5000;
/** The deepest level the child reads; the top level is 1. */
export const OUTLINE_MAX_DEPTH = 32;
/** As HINT_REPLY_MAX_TEXT. */
export const OUTLINE_MAX_TITLE = 512;
/** As HINT_REPLY_MAX_HREF. */
export const OUTLINE_MAX_URL = 8192;
/** The row after a truncated outline's last entry. */
export const OUTLINE_TRUNCATED_TEXT = `outline truncated at ${OUTLINE_MAX_ENTRIES} entries`;

/**
 * What an entry does when followed: a destination, a URL, a named action (`NextPage`), an
 * attachment, a layer change (`ocg`), or nothing (an entry pdf.js gives no target, such as a
 * `javascript:` link it refused).
 */
export const OUTLINE_KINDS = Object.freeze(["dest", "url", "action", "attachment", "ocg", "none"]);
const KINDS = new Set(OUTLINE_KINDS);

/**
 * @typedef {object} OutlineEntry
 * @property {string} title
 * @property {number} level      1 at the top
 * @property {number} page       the page its destination resolves to, 0 when it does not
 * @property {string} kind       one of OUTLINE_KINDS
 * @property {boolean} collapsed the document starts it collapsed (a negative /Count)
 * @property {string} [url]      a URL entry's URL
 */

/** @typedef {{ entries: readonly OutlineEntry[], truncated: boolean }} PdfOutline */

const FIELDS = new Set(["title", "level", "page", "kind", "collapsed", "url"]);

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @returns {v is number}
 */
const intIn = (v, min, max) =>
  Number.isSafeInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max;

/**
 * The outline message from the content actor, or null when any bound fails (V8): the whole
 * message goes, so a hostile viewer gets no partial outline into chrome.
 * @param {unknown} raw
 * @param {number} pages  the document's page count, as the parent last saw it
 * @returns {PdfOutline | null}
 */
export function parsePdfOutline(raw, pages) {
  if (!raw || typeof raw !== "object") return null;
  const { entries, truncated } = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(entries) || typeof truncated !== "boolean") return null;
  if (entries.length > OUTLINE_MAX_ENTRIES || !intIn(pages, 0, PDF_MAX_PAGES)) return null;
  /** @type {OutlineEntry[]} */
  const out = [];
  let previous = 0;
  for (const item of entries) {
    if (!item || typeof item !== "object") return null;
    const r = /** @type {Record<string, unknown>} */ (item);
    if (Object.keys(r).some((k) => !FIELDS.has(k))) return null;
    const { title, level, page, kind, collapsed, url } = r;
    if (typeof title !== "string" || title.length > OUTLINE_MAX_TITLE) return null;
    if (!intIn(level, 1, Math.min(OUTLINE_MAX_DEPTH, previous + 1))) return null;
    if (!intIn(page, 0, pages)) return null;
    if (typeof kind !== "string" || !KINDS.has(kind)) return null;
    if (typeof collapsed !== "boolean") return null;
    if (kind === "url") {
      if (typeof url !== "string" || url.length > OUTLINE_MAX_URL) return null;
    } else if (url !== undefined) return null;
    previous = level;
    /** @type {OutlineEntry} */
    const entry = {
      title: stripInvisible(title).replace(/\s+/g, " ").trim(),
      level,
      page,
      kind,
      collapsed,
    };
    if (kind === "url") entry.url = /** @type {string} */ (url);
    out.push(Object.freeze(entry));
  }
  return Object.freeze({ entries: Object.freeze(out), truncated });
}

/**
 * Whether the parent may open an outline entry's URL (docs/security.md section 4): http and
 * https only, as pdf.js itself links them; never `javascript:`, `data:` or a local file a remote
 * PDF names.
 * @param {string} url
 */
export function outlineUrlAllowed(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The entry for `page`, as pdf.js finds its current outline item: the deepest of the last
 * entries whose page is at or before it; the first entry when none is.
 * @param {PdfOutline} outline
 * @param {number} page
 * @returns {number} an entry index, -1 for an empty outline
 */
export function currentEntry(outline, page) {
  let best = -1;
  let bestPage = 0;
  let bestLevel = 0;
  outline.entries.forEach((e, i) => {
    if (e.page < 1 || e.page > page) return;
    if (e.page > bestPage || (e.page === bestPage && e.level > bestLevel)) {
      best = i;
      bestPage = e.page;
      bestLevel = e.level;
    }
  });
  return best >= 0 ? best : outline.entries.length ? 0 : -1;
}

/**
 * @typedef {object} OutlineMatch
 * @property {number} index  the entry
 * @property {number} score
 * @property {[number, number][]} ranges  the title's matched ranges
 */

/**
 * @typedef {object} OutlineState
 * @property {PdfOutline} outline
 * @property {readonly number[]} parents   each entry's parent index, -1 at the top
 * @property {readonly boolean[]} hasChildren
 * @property {readonly boolean[]} expanded
 * @property {number} selected             the selected entry in the tree
 * @property {string | null} query          the filter's text, null outside the filter
 * @property {readonly OutlineMatch[]} matches
 * @property {number} match                the selected match
 */

/**
 * The panel's state on opening: the entry for `page` selected with the path to it expanded,
 * the rest expanded or collapsed as the document says.
 * @param {PdfOutline} outline
 * @param {number} page
 * @returns {OutlineState}
 */
export function openOutline(outline, page) {
  const { entries } = outline;
  /** @type {number[]} */
  const parents = [];
  /** @type {number[]} */
  const stack = [];
  const hasChildren = entries.map(() => false);
  entries.forEach((e, i) => {
    stack.length = e.level - 1;
    const parent = stack.length ? /** @type {number} */ (stack.at(-1)) : -1;
    parents.push(parent);
    if (parent >= 0) hasChildren[parent] = true;
    stack.push(i);
  });
  const expanded = entries.map((e) => !e.collapsed);
  const selected = currentEntry(outline, page);
  for (let p = selected >= 0 ? parents[selected] : -1; p !== undefined && p >= 0; p = parents[p]) {
    expanded[p] = true;
  }
  return Object.freeze({
    outline,
    parents: Object.freeze(parents),
    hasChildren: Object.freeze(hasChildren),
    expanded: Object.freeze(expanded),
    selected,
    query: null,
    matches: Object.freeze([]),
    match: 0,
  });
}

/**
 * The outline shown beside the document follows its page (docs/specs/pdf-mode.md decision 19):
 * the entry for `page` selected and the path to it expanded, the rest as the user left it. A
 * filtered outline stays as typed. The same state when nothing changes.
 * @param {OutlineState} s
 * @param {number} page
 * @returns {OutlineState}
 */
export function selectOutlinePage(s, page) {
  if (s.query !== null) return s;
  const selected = currentEntry(s.outline, page);
  if (selected === s.selected) return s;
  const expanded = [...s.expanded];
  for (
    let p = selected >= 0 ? s.parents[selected] : -1;
    p !== undefined && p >= 0;
    p = s.parents[p]
  ) {
    expanded[p] = true;
  }
  return Object.freeze({ ...s, selected, expanded: Object.freeze(expanded) });
}

/**
 * The entries shown in the tree: those whose ancestors are all expanded.
 * @param {OutlineState} s
 * @returns {number[]}
 */
function visible(s) {
  /** @type {number[]} */
  const out = [];
  const shown = s.outline.entries.map(() => false);
  s.outline.entries.forEach((_e, i) => {
    const p = /** @type {number} */ (s.parents[i]);
    shown[i] = p < 0 || (!!shown[p] && !!s.expanded[p]);
    if (shown[i]) out.push(i);
  });
  return out;
}

/**
 * The titles of the entries above `index`, outermost first.
 * @param {OutlineState} s
 * @param {number} index
 */
function pathOf(s, index) {
  /** @type {string[]} */
  const titles = [];
  for (
    let p = /** @type {number} */ (s.parents[index]);
    p >= 0;
    p = /** @type {number} */ (s.parents[p])
  ) {
    titles.unshift(/** @type {OutlineEntry} */ (s.outline.entries[p]).title);
  }
  return titles.join(" › ");
}

/**
 * @typedef {object} OutlineRow
 * @property {number} index      the entry
 * @property {string} title
 * @property {number} depth      0 at the top (the tree); 0 for every match
 * @property {boolean} parent    it has entries under it
 * @property {boolean} open
 * @property {boolean} selected
 * @property {number} page
 * @property {string} kind
 * @property {string} path       the titles above it, in the filter
 * @property {[number, number][]} ranges  the filter's matched ranges in the title
 */

/**
 * The rows the panel shows: the tree, or the filter's matches, best first.
 * @param {OutlineState} s
 * @returns {OutlineRow[]}
 */
export function outlineRows(s) {
  /** @param {number} index @param {Partial<OutlineRow>} more @returns {OutlineRow} */
  const row = (index, more) => {
    const e = /** @type {OutlineEntry} */ (s.outline.entries[index]);
    return {
      index,
      title: e.title,
      depth: e.level - 1,
      parent: !!s.hasChildren[index],
      open: !!s.expanded[index],
      selected: false,
      page: e.page,
      kind: e.kind,
      path: "",
      ranges: [],
      ...more,
    };
  };
  if (s.query !== null) {
    return s.matches.map((m, i) =>
      row(m.index, {
        depth: 0,
        selected: i === s.match,
        path: pathOf(s, m.index),
        ranges: m.ranges,
      }),
    );
  }
  return visible(s).map((i) => row(i, { selected: i === s.selected }));
}

/**
 * Every whitespace-separated term must match the title; the pickers' fuzzy matching and scores.
 * @param {string} title
 * @param {string[]} terms
 * @returns {{ score: number, ranges: [number, number][] } | null}
 */
function matchTitle(title, terms) {
  let score = 0;
  /** @type {[number, number][]} */
  const ranges = [];
  for (const term of terms) {
    const m = scoreField(title, term);
    if (!m) return null;
    score += m.score;
    ranges.push(...m.ranges);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { score, ranges: merged };
}

/**
 * The filter's text: the entries that match it, best first, ties in document order; every
 * entry while it is blank.
 * @param {OutlineState} s
 * @param {string} query
 * @returns {OutlineState}
 */
export function setOutlineQuery(s, query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  /** @type {OutlineMatch[]} */
  const matches = [];
  s.outline.entries.forEach((e, index) => {
    if (!terms.length) {
      matches.push({ index, score: 0, ranges: [] });
      return;
    }
    const m = matchTitle(e.title, terms);
    if (m) matches.push({ index, ...m });
  });
  matches.sort((a, b) => b.score - a.score || a.index - b.index);
  return Object.freeze({ ...s, query, matches: Object.freeze(matches), match: 0 });
}

/**
 * @typedef {{ type: "close" } | { type: "filter" } | { type: "follow", index: number }}
 *   OutlineEffect
 */

/**
 * @param {OutlineState} s
 * @param {Partial<OutlineState>} more
 * @returns {OutlineState}
 */
const next = (s, more) => Object.freeze({ ...s, ...more });

/**
 * @param {OutlineState} s
 * @param {number} index
 * @param {boolean} open
 * @param {boolean} subtree  the entry's descendants too
 */
function setOpen(s, index, open, subtree) {
  const expanded = [...s.expanded];
  expanded[index] = open;
  if (subtree) {
    const level = /** @type {OutlineEntry} */ (s.outline.entries[index]).level;
    for (let i = index + 1; i < s.outline.entries.length; i++) {
      if (/** @type {OutlineEntry} */ (s.outline.entries[i]).level <= level) break;
      expanded[i] = open;
    }
  }
  return next(s, { expanded: Object.freeze(expanded) });
}

/**
 * One `[modal.index]` action. `page` is the number of rows the panel shows (ctrl+d, ctrl+u).
 * @param {OutlineState} s
 * @param {{ id: string, page?: number }} action
 * @returns {{ state: OutlineState, effect: OutlineEffect | null }}
 */
export function outlineKey(s, { id, page = 10 }) {
  const half = Math.max(1, Math.floor(page / 2));
  const keep = { state: s, effect: null };
  if (s.query !== null) {
    const last = s.matches.length - 1;
    /** @param {number} m */
    const to = (m) => ({ state: next(s, { match: Math.max(0, Math.min(last, m)) }), effect: null });
    switch (id) {
      case "index.down":
        return to(s.match + 1);
      case "index.up":
        return to(s.match - 1);
      case "index.first":
        return to(0);
      case "index.last":
        return to(last);
      case "index.half_down":
        return to(s.match + half);
      case "index.half_up":
        return to(s.match - half);
      case "index.follow": {
        const m = s.matches[s.match];
        return m ? { state: s, effect: { type: "follow", index: m.index } } : keep;
      }
      case "index.close":
        // Back to the whole outline, where it was before `/`.
        return {
          state: next(s, { query: null, matches: Object.freeze([]), match: 0 }),
          effect: null,
        };
      case "index.filter":
        return { state: s, effect: { type: "filter" } };
      default:
        return keep;
    }
  }
  if (id === "index.close") return { state: s, effect: { type: "close" } };
  if (s.selected < 0) return keep;
  const rows = visible(s);
  const at = Math.max(0, rows.indexOf(s.selected));
  /** @param {number} r */
  const to = (r) => ({
    state: next(s, {
      selected: /** @type {number} */ (rows[Math.max(0, Math.min(rows.length - 1, r))]),
    }),
    effect: null,
  });
  const sel = s.selected;
  const parent = /** @type {number} */ (s.parents[sel]);
  switch (id) {
    case "index.down":
      return to(at + 1);
    case "index.up":
      return to(at - 1);
    case "index.first":
      return to(0);
    case "index.last":
      return to(rows.length - 1);
    case "index.half_down":
      return to(at + half);
    case "index.half_up":
      return to(at - half);
    case "index.expand":
      return s.hasChildren[sel] ? { state: setOpen(s, sel, true, false), effect: null } : keep;
    case "index.collapse":
      // As in the bookmarks panel: close it, or go to its parent.
      if (s.hasChildren[sel] && s.expanded[sel]) {
        return { state: setOpen(s, sel, false, false), effect: null };
      }
      return parent >= 0 ? { state: next(s, { selected: parent }), effect: null } : keep;
    case "index.expand_subtree":
    case "index.collapse_subtree":
      return s.hasChildren[sel]
        ? { state: setOpen(s, sel, id === "index.expand_subtree", true), effect: null }
        : keep;
    case "index.expand_all":
      return {
        state: next(s, { expanded: Object.freeze(s.expanded.map(() => true)) }),
        effect: null,
      };
    case "index.collapse_all": {
      let top = sel;
      while (/** @type {number} */ (s.parents[top]) >= 0)
        top = /** @type {number} */ (s.parents[top]);
      return {
        state: next(s, { expanded: Object.freeze(s.expanded.map(() => false)), selected: top }),
        effect: null,
      };
    }
    case "index.follow":
      return { state: s, effect: { type: "follow", index: sel } };
    case "index.filter":
      return { state: setOutlineQuery(s, ""), effect: { type: "filter" } };
    default:
      return keep;
  }
}
