/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Live grep (docs/specs/live-grep.md): the pure rules. The query and ripgrep's smart case, the
 * per-line matching each frame runs on its text model, the checks the parent applies to a
 * content process's reply, the merged rows, the picker's keys and the grep list for `]q`/`[q`.
 */
import { AGENT_GLYPH } from "../agent/agent.mjs";
import { scoreField, typedChar } from "./picker.mjs";
import { deleteWordBackward } from "../text/strings.mjs";
import { newestClosedFirst } from "./tabsearch.mjs";

/**
 * The limits of decision 14: matches listed and counted per frame, rows in the list, a row's
 * context, the preview's lines each side and their width, and a frame's text model.
 */
export const GREP_CAPS = Object.freeze({
  listed: 100,
  counted: 1000,
  rows: 2000,
  context: 160,
  before: 60,
  previewLines: 10,
  previewWidth: 300,
  modelChars: 1_000_000,
  /** frames searched in one tab, and the longest query sent to a frame */
  frames: 100,
  query: 1000,
});

const ELLIPSIS = "…";
/** A line with something on it; white space between blocks makes blank lines, not lines. */
const NOT_BLANK = /\S/;
/** Line ends: a line break, a carriage return, a block boundary (motions.mjs BLOCK). */
const LINE_END = /[\n\r\u2029]/g;

/**
 * @typedef {object} GrepQuery
 * @property {string} source  what was typed
 * @property {RegExp} regex  global, with the `u` flag; `i` when case is ignored
 * @property {boolean} literal  the query did not compile and is matched as typed
 * @property {boolean} caseSensitive
 */
/**
 * @typedef {object} GrepMatch  one match in a frame's text
 * @property {number} start  index in the frame's text
 * @property {number} end
 * @property {number} line  1-based, in the frame
 * @property {number} ordinal  0-based, among the frame's matches
 * @property {string} context  the line, cut to GREP_CAPS.context around the match
 * @property {[number, number]} at  the match in `context`
 */
/**
 * A frame's answer. `timedOut`: its matching ran out of time and was stopped; `cut`: its text
 * was longer than the model holds.
 * @typedef {{ gen?: number, count: number, matches: GrepMatch[], timedOut?: boolean,
 *   cut?: boolean }} GrepReply
 */
/**
 * @typedef {object} GrepPreview  the lines around a match
 * @property {number} first  the line number of `lines[0]`
 * @property {number} line  the matched line's index in `lines`
 * @property {[number, number]} at  the match in that line
 * @property {string[]} lines
 */

/** @param {string} c */
const isUpper = (c) => c !== c.toLowerCase();

/**
 * Whether the pattern has a literal character, and an upper-case one, as ripgrep's smart case
 * reads a pattern (grep-regex's AstAnalysis): escapes such as `\w`, `\b` and `\p{Lu}`, group
 * syntax and counted repetition are not literals; an escaped character and the characters of a
 * bracketed class are.
 * @param {string} source
 */
function literals(source) {
  let any = false;
  let upper = false;
  /** @param {string} c */
  const lit = (c) => {
    any = true;
    if (isUpper(c)) upper = true;
  };
  let inClass = false;
  for (let i = 0; i < source.length;) {
    const c = /** @type {string} */ (source[i]);
    const rest = source.slice(i);
    if (c === "\\") {
      const n = source[i + 1];
      if (n === undefined) break;
      /** @type {RegExpExecArray | null} */
      let m;
      if ((m = /^\\[pP]\{[^}]*\}/.exec(rest))) i += m[0].length;
      else if (
        (m = /^\\u\{([0-9a-fA-F]+)\}|^\\u([0-9a-fA-F]{4})|^\\x([0-9a-fA-F]{2})/.exec(rest))
      ) {
        const cp = parseInt(/** @type {string} */ (m[1] ?? m[2] ?? m[3]), 16);
        if (cp <= 0x10ffff) lit(String.fromCodePoint(cp));
        i += m[0].length;
      } else if ((m = /^\\k<[^>]*>|^\\[1-9]\d*|^\\c[a-zA-Z]/.exec(rest))) {
        if (n === "c") any = true;
        i += m[0].length;
      } else if ("dDwWsSbB".includes(n)) i += 2;
      else if ("nrtfv0".includes(n)) {
        any = true;
        i += 2;
      } else {
        lit(n);
        i += 2;
      }
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (!(c === "^" && source[i - 1] === "[")) lit(c);
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(" && source[i + 1] === "?") {
      const m = /^\(\?(?::|=|!|<=|<!|<[^>]*>)/.exec(rest);
      i += m ? m[0].length : 2;
      continue;
    }
    if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(rest);
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    if (".^$|()*+?".includes(c)) {
      i++;
      continue;
    }
    const cp = String.fromCodePoint(/** @type {number} */ (source.codePointAt(i)));
    lit(cp);
    i += cp.length;
  }
  return { any, upper };
}

/**
 * The query as a regular expression (decision 3): JavaScript syntax with the `u` flag, case
 * ignored when it has a literal character and no upper-case one (ripgrep's `--smart-case`).
 * One that does not compile is matched literally, flagged `literal`. An empty query is none.
 * @param {string} query
 * @returns {GrepQuery | null}
 */
export function parseQuery(query) {
  if (!query) return null;
  /** @param {string} source @param {boolean} ignore */
  const compile = (source, ignore) => new RegExp(source, ignore ? "giu" : "gu");
  const { any, upper } = literals(query);
  try {
    const caseSensitive = !(any && !upper);
    return { source: query, regex: compile(query, !caseSensitive), literal: false, caseSensitive };
  } catch {
    const caseSensitive = [...query].some(isUpper);
    const escaped = query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
    return { source: query, regex: compile(escaped, !caseSensitive), literal: true, caseSensitive };
  }
}

/**
 * Moves a cut off the inside of a surrogate pair.
 * @param {string} s
 * @param {number} i
 * @param {1 | -1} dir
 */
function onCodePoint(s, i, dir) {
  const c = s.charCodeAt(i);
  return i > 0 && i < s.length && c >= 0xdc00 && c <= 0xdfff ? i + dir : i;
}

/**
 * A line cut to `width` around [s, e] with at most `before` characters before it, an ellipsis
 * where cut.
 * @param {string} line
 * @param {number} s
 * @param {number} e
 * @param {number} width
 * @param {number} before
 * @returns {{ text: string, at: [number, number] }}
 */
function cutAround(line, s, e, width, before) {
  if (line.length <= width) return { text: line, at: [s, e] };
  let from = Math.max(0, s - before);
  let to = Math.min(line.length, from + width);
  if (to - from < width) from = Math.max(0, to - width);
  from = onCodePoint(line, from, 1);
  to = onCodePoint(line, to, -1);
  const pre = from > 0 ? ELLIPSIS : "";
  const post = to < line.length ? ELLIPSIS : "";
  const clip = (/** @type {number} */ x) => Math.min(Math.max(x, from), to) - from + pre.length;
  return { text: pre + line.slice(from, to) + post, at: [clip(s), clip(e)] };
}

/**
 * Index after an empty match at `i`: the next code point.
 * @param {string} s
 * @param {number} i
 */
function stepOver(s, i) {
  const cp = s.codePointAt(i);
  return i + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

/**
 * Matches the query against a frame's text, line by line (decision 4): every non-empty match
 * up to `counted`, the first `listed` with their line of context.
 * @param {string} text  the frame's text model
 * @param {GrepQuery} query
 * @param {{ listed: number, counted: number, context: number, before: number,
 *   firstPerLine?: boolean }} [caps]  `firstPerLine`: one match a line, so that one long line
 *   cannot use up the count (recently closed titles and URLs, one a line)
 * @returns {{ matches: GrepMatch[], count: number }}
 */
export function grepText(text, query, caps = GREP_CAPS) {
  const re = new RegExp(query.regex.source, query.regex.flags);
  const ends = new RegExp(LINE_END.source, "g");
  /** @type {GrepMatch[]} */
  const matches = [];
  let count = 0;
  let line = 0;
  for (let pos = 0; pos <= text.length && count < caps.counted;) {
    ends.lastIndex = pos;
    const brk = ends.exec(text);
    const end = brk ? brk.index : text.length;
    const s = end > pos ? text.slice(pos, end) : "";
    if (NOT_BLANK.test(s)) {
      line++;
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (!m[0].length) {
          re.lastIndex = stepOver(s, re.lastIndex);
          continue;
        }
        if (matches.length < caps.listed) {
          const { text: context, at } = cutAround(
            s,
            m.index,
            m.index + m[0].length,
            caps.context,
            caps.before,
          );
          matches.push({
            start: pos + m.index,
            end: pos + m.index + m[0].length,
            line,
            ordinal: count,
            context,
            at,
          });
        }
        if (++count >= caps.counted || caps.firstPerLine) break;
      }
    }
    if (!brk) break;
    pos = end + 1;
  }
  return { matches, count };
}

/**
 * The lines around a match for the preview (decision 6): `n` lines each side of the matched
 * line, fewer at the ends of the text, each cut to `width`. Blank lines are left out, as
 * grepText leaves them out of its numbering.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} [n]
 * @param {number} [width]
 * @returns {GrepPreview}
 */
export function previewLines(
  text,
  start,
  end,
  n = GREP_CAPS.previewLines,
  width = GREP_CAPS.previewWidth,
) {
  const ends = new RegExp(LINE_END.source, "g");
  /** @type {[number, number][]} the non-blank lines seen, [start, end) */
  const lines = [];
  let at = -1;
  for (let pos = 0; pos <= text.length;) {
    ends.lastIndex = pos;
    const brk = ends.exec(text);
    const stop = brk ? brk.index : text.length;
    const isMatch = at < 0 && start >= pos && start <= stop;
    if (isMatch || NOT_BLANK.test(text.slice(pos, stop))) {
      if (isMatch) at = lines.length;
      lines.push([pos, stop]);
    }
    if (!brk || (at >= 0 && lines.length > at + n)) break;
    pos = stop + 1;
  }
  if (at < 0) at = Math.max(0, lines.length - 1);
  const lo = Math.max(0, at - n);
  const hi = Math.min(lines.length - 1, at + n);
  /** @type {string[]} */
  const out = [];
  /** @type {[number, number]} */
  let range = [0, 0];
  for (let i = lo; i <= hi; i++) {
    const [from, to] = /** @type {[number, number]} */ (lines[i]);
    const line = text.slice(from, to);
    if (i === at) {
      const cut = cutAround(line, start - from, Math.min(end, to) - from, width, GREP_CAPS.before);
      out.push(cut.text);
      range = cut.at;
    } else {
      out.push(cutAround(line, 0, 0, width, 0).text);
    }
  }
  return { first: lo + 1, line: at - lo, at: range, lines: out };
}

/**
 * @param {unknown} n
 * @returns {n is number}
 */
const isIndex = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * @param {unknown} at
 * @returns {at is [number, number]}
 */
const isRange = (at) =>
  Array.isArray(at) && at.length === 2 && isIndex(at[0]) && isIndex(at[1]) && at[0] <= at[1];

/**
 * @param {string} s
 * @param {number} max
 */
const cutText = (s, max) => (s.length > max ? s.slice(0, max) : s);

/**
 * A frame's reply to `Vimma:Grep`, from a content process that may be compromised: a fresh,
 * checked copy, cut to the caps, or null.
 * @param {unknown} raw
 * @returns {GrepReply | null}
 */
export function parseGrepReply(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r.gen !== undefined && !isIndex(r.gen)) return null;
  if (!isIndex(r.count) || !Array.isArray(r.matches)) return null;
  for (const flag of ["timedOut", "cut"]) {
    if (r[flag] !== undefined && typeof r[flag] !== "boolean") return null;
  }
  /** @type {GrepMatch[]} */
  const matches = [];
  const max = GREP_CAPS.context + 2;
  for (const m of r.matches.slice(0, GREP_CAPS.listed)) {
    if (!m || typeof m !== "object") return null;
    const { start, end, line, ordinal, context, at } = /** @type {Record<string, unknown>} */ (m);
    if (!isIndex(start) || !isIndex(end) || end < start || !isIndex(line) || !isIndex(ordinal)) {
      return null;
    }
    if (typeof context !== "string" || !isRange(at)) return null;
    const text = cutText(context, max);
    const clip = (/** @type {number} */ x) => Math.min(x, text.length);
    matches.push({ start, end, line, ordinal, context: text, at: [clip(at[0]), clip(at[1])] });
  }
  return {
    ...(r.gen !== undefined ? { gen: /** @type {number} */ (r.gen) } : {}),
    count: Math.min(r.count, GREP_CAPS.counted),
    matches,
    ...(r.timedOut !== undefined ? { timedOut: /** @type {boolean} */ (r.timedOut) } : {}),
    ...(r.cut !== undefined ? { cut: /** @type {boolean} */ (r.cut) } : {}),
  };
}

/**
 * A frame's reply to `Vimma:GrepPreview`, checked as parseGrepReply checks.
 * @param {unknown} raw
 * @returns {GrepPreview | null}
 */
export function parsePreviewReply(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { first, line, at, lines } = /** @type {Record<string, unknown>} */ (raw);
  if (!isIndex(first) || !isIndex(line) || !isRange(at) || !Array.isArray(lines)) return null;
  if (!lines.every((l) => typeof l === "string")) return null;
  const kept = lines
    .slice(0, 2 * GREP_CAPS.previewLines + 1)
    .map((l) => cutText(/** @type {string} */ (l), GREP_CAPS.previewWidth + 2));
  if (line >= kept.length) return null;
  const length = /** @type {string} */ (kept[line]).length;
  return { first, line, at: [Math.min(at[0], length), Math.min(at[1], length)], lines: kept };
}

/**
 * A tab in the search's scope, in the order the list shows tabs.
 * @typedef {object} GrepTab
 * @property {string} tabId
 * @property {number} index  its number in its workspace (`ctrl+b 1..9`)
 * @property {string} title
 * @property {string} host
 * @property {string} workspace
 * @property {boolean} agent  in the agent workspace
 * @property {boolean} loaded  has a document to search
 * @property {number} window  its window's mark: 1 for the window searching, then 2, 3… most
 *   recently used first (`w2`, as tab search marks windows)
 */
/**
 * A frame's reply, with the frame's key (stable for the search) and its host when the frame
 * is from another site than its tab's page.
 * @typedef {{ key: string, host: string | null, reply: GrepReply }} GrepFrame
 */
/**
 * @typedef {object} GrepMatchRow
 * @property {"match"} kind
 * @property {string} id
 * @property {string} tabId
 * @property {number} tabIndex
 * @property {string} title
 * @property {string} host  the tab's host
 * @property {number} window
 * @property {string} workspace
 * @property {boolean} agent
 * @property {string} frameKey
 * @property {string | null} frameHost
 * @property {number} line
 * @property {string} context
 * @property {[number, number]} at
 * @property {number} start
 * @property {number} end
 * @property {number} ordinal
 */
/**
 * @typedef {object} GrepUnloadedRow
 * @property {"unloaded"} kind
 * @property {string} id
 * @property {string} tabId
 * @property {number} tabIndex
 * @property {string} title
 * @property {string} host
 * @property {number} window
 * @property {string} workspace
 * @property {boolean} agent
 */
/**
 * A recently closed tab or window whose title or URL matches (decision 10): Firefox keeps no
 * page text for it, so only those are searched.
 * @typedef {object} GrepClosedRow
 * @property {"closed"} kind
 * @property {string} id  `closed:<closedId>` for a tab, `closedwin:<closedId>` for a window
 * @property {string} tabId  the same as `id`
 * @property {number} closedId  SessionStore's
 * @property {boolean} closedWindow
 * @property {number} tabIndex  0: a closed tab has no number
 * @property {number} window  the open window it was closed from, 0 for a closed window
 * @property {string} title  the tab's title (a closed window: the first of its tabs that matches)
 * @property {[number, number] | null} titleAt  the match in `title`
 * @property {string} url
 * @property {[number, number] | null} urlAt  the match in `url`
 * @property {string} host
 * @property {string} workspace
 * @property {boolean} agent
 * @property {number} tabCount  a closed window's tabs (1 for a tab)
 * @property {{ title: string, url: string }[]} tabs  a closed window's first tabs, for the preview
 */
/** @typedef {GrepMatchRow | GrepUnloadedRow | GrepClosedRow} GrepRow */

/**
 * The rows of the list, best first (decision 5): matches in tab order, the agent workspace's
 * tabs last, each tab's frames in order and their matches in document order; then a row per
 * tab that is not loaded (decision 11). Recently closed matches (core grepClosed) come between
 * the two: they matched, but on their title and URL only. At most `rows` rows.
 * @param {readonly GrepTab[]} tabs
 * @param {ReadonlyMap<string, readonly GrepFrame[]>} frames  replies so far, by tab id
 * @param {{ rows: number }} [caps]
 * @param {readonly GrepClosedRow[]} [closed]
 * @returns {{ rows: GrepRow[], count: number, tabsWithMatches: number }}
 */
export function grepRows(tabs, frames, caps = GREP_CAPS, closed = []) {
  const ordered = [...tabs.filter((t) => !t.agent), ...tabs.filter((t) => t.agent)];
  /** @type {GrepRow[]} */
  const rows = [];
  let count = 0;
  let tabsWithMatches = 0;
  for (const t of ordered) {
    if (!t.loaded) continue;
    let tabCount = 0;
    for (const f of frames.get(t.tabId) ?? []) {
      tabCount += f.reply.count;
      for (const m of f.reply.matches) {
        if (rows.length >= caps.rows) break;
        rows.push({
          kind: "match",
          id: `${t.tabId}:${f.key}:${m.ordinal}`,
          tabId: t.tabId,
          tabIndex: t.index,
          title: t.title,
          host: t.host,
          window: t.window,
          workspace: t.workspace,
          agent: t.agent,
          frameKey: f.key,
          frameHost: f.host,
          line: m.line,
          context: m.context,
          at: m.at,
          start: m.start,
          end: m.end,
          ordinal: m.ordinal,
        });
      }
    }
    count += tabCount;
    if (tabCount) tabsWithMatches++;
  }
  for (const c of closed) {
    if (rows.length >= caps.rows) break;
    rows.push(c);
  }
  count += closed.length;
  tabsWithMatches += closed.length;
  for (const t of ordered) {
    if (t.loaded || rows.length >= caps.rows) continue;
    rows.push({
      kind: "unloaded",
      id: `unloaded:${t.tabId}`,
      tabId: t.tabId,
      tabIndex: t.index,
      title: t.title,
      host: t.host,
      window: t.window,
      workspace: t.workspace,
      agent: t.agent,
    });
  }
  return { rows, count, tabsWithMatches };
}

/**
 * How closed titles and URLs are matched: every line may be listed, and only its first match,
 * so that each entry can match whatever another's title holds.
 */
export const CLOSED_MATCH_CAPS = Object.freeze({
  ...GREP_CAPS,
  listed: GREP_CAPS.counted,
  firstPerLine: true,
});

/** Recently closed tabs and windows searched, Firefox's `max_tabs_undo` and `max_windows_undo`. */
export const GREP_CLOSED_CAPS = Object.freeze({
  tabs: 25,
  windows: 5,
  windowTabs: 20,
  field: 1000,
});

/**
 * A recently closed tab or window, as the host reads it from SessionStore: its title and the
 * URL of its current history entry, which is all Firefox keeps that can be searched.
 * @typedef {object} GrepClosedEntry
 * @property {number} closedId
 * @property {boolean} closedWindow
 * @property {string} title
 * @property {string} url
 * @property {number} closedAt
 * @property {number} window  the open window it was closed from, 0 for a closed window
 * @property {string} workspace
 * @property {boolean} agent
 * @property {{ title: string, url: string, workspace?: string, agent?: boolean }[]} tabs  a
 *   closed window's tabs, each with the workspace its container belongs to
 */
/**
 * The text the closed entries are matched in: one line per title and per URL, so that the same
 * matcher as page text (grepText, in a worker) finds them and a match never spans two fields.
 * @typedef {object} GrepClosedText
 * @property {string} text
 * @property {GrepClosedEntry[]} entries  newest first, capped, the agent's last
 * @property {{ start: number, entry: number, tab: number, field: "title" | "url" }[]} fields
 */

/** The longest host a row shows; a real host name is far shorter. */
const HOST_WIDTH = 64;

/**
 * A URL's host for a row, the preview title and an option's name: "" for a URL without one
 * (`about:`, `data:`, `file:`), never the URL itself, which a page can make a megabyte long;
 * cut to 64 characters.
 * @param {string} url
 */
export function grepHost(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return "";
  }
  return host.length > HOST_WIDTH ? `${host.slice(0, HOST_WIDTH - 1)}${ELLIPSIS}` : host;
}

/**
 * @param {string} s
 * @param {number} max
 */
const oneLine = (s, max) => s.slice(0, max).replace(/[\n\r\u2029]/g, " ");

/**
 * The closed entries searched and the text to match them in.
 * @param {readonly GrepClosedEntry[]} entries
 * @param {typeof GREP_CLOSED_CAPS} [caps]
 * @returns {GrepClosedText}
 */
export function closedSearchText(entries, caps = GREP_CLOSED_CAPS) {
  const newest = (/** @type {boolean} */ win, /** @type {number} */ cap) =>
    entries
      .filter((e) => e.closedWindow === win)
      .sort(newestClosedFirst)
      .slice(0, cap);
  const picked = [...newest(false, caps.tabs), ...newest(true, caps.windows)];
  const ordered = [...picked.filter((e) => !e.agent), ...picked.filter((e) => e.agent)];
  /** @type {GrepClosedText["fields"]} */
  const fields = [];
  let text = "";
  ordered.forEach((e, entry) => {
    const tabs = e.closedWindow ? e.tabs.slice(0, caps.windowTabs) : [e];
    tabs.forEach((t, tab) => {
      for (const field of /** @type {const} */ (["title", "url"])) {
        fields.push({ start: text.length, entry, tab, field });
        text += `${oneLine(t[field] ?? "", caps.field)}\n`;
      }
    });
  });
  return { text, entries: ordered, fields };
}

/**
 * The closed rows from the matches grepText found in closedSearchText's text: one row per entry
 * with a match, showing the first of its tabs that matches, each field's first match marked.
 * @param {GrepClosedText} closed
 * @param {readonly { start: number, end: number }[]} matches  in text order
 * @returns {GrepClosedRow[]}
 */
export function closedRows(closed, matches) {
  /** @type {Map<number, { tab: number, title: [number, number] | null, url: [number, number] | null }>} */
  const hits = new Map();
  let f = 0;
  for (const m of matches) {
    while (
      f + 1 < closed.fields.length &&
      /** @type {any} */ (closed.fields[f + 1]).start <= m.start
    )
      f++;
    const field = closed.fields[f];
    if (!field) continue;
    const hit = hits.get(field.entry) ?? { tab: field.tab, title: null, url: null };
    if (!hits.has(field.entry)) hits.set(field.entry, hit);
    if (hit.tab !== field.tab || hit[field.field]) continue;
    hit[field.field] = [m.start - field.start, m.end - field.start];
  }
  /** @type {GrepClosedRow[]} */
  const rows = [];
  closed.entries.forEach((e, i) => {
    const hit = hits.get(i);
    if (!hit) return;
    const shown = e.closedWindow ? e.tabs[hit.tab] : e;
    const cut = (/** @type {string} */ s, /** @type {[number, number] | null} */ at) => {
      const line = oneLine(s, GREP_CLOSED_CAPS.field);
      if (!at) return { text: cutAround(line, 0, 0, GREP_CAPS.context, 0).text, at: null };
      const c = cutAround(line, at[0], at[1], GREP_CAPS.context, GREP_CAPS.before);
      return { text: c.text, at: c.at };
    };
    const title = cut(shown?.title ?? "", hit.title);
    const url = cut(shown?.url ?? "", hit.url);
    // A closed window's row is the agent's when the tab it shows is (decision 13).
    const tab = e.closedWindow ? e.tabs[hit.tab] : undefined;
    const id = `${e.closedWindow ? "closedwin" : "closed"}:${e.closedId}`;
    rows.push({
      kind: "closed",
      id,
      tabId: id,
      closedId: e.closedId,
      closedWindow: e.closedWindow,
      tabIndex: 0,
      window: e.window,
      title: title.text,
      titleAt: title.at,
      url: url.text,
      urlAt: url.at,
      host: grepHost(oneLine(shown?.url ?? "", GREP_CLOSED_CAPS.field)),
      workspace: tab?.workspace ?? e.workspace,
      agent: tab?.agent ?? e.agent,
      tabCount: e.closedWindow ? e.tabs.length : 1,
      tabs: e.closedWindow
        ? e.tabs.slice(0, GREP_CAPS.previewLines).map((t) => ({
            title: cutAround(
              oneLine(t.title ?? "", GREP_CLOSED_CAPS.field),
              0,
              0,
              GREP_CAPS.context,
              0,
            ).text,
            url: cutAround(oneLine(t.url ?? "", GREP_CLOSED_CAPS.field), 0, 0, GREP_CAPS.context, 0)
              .text,
          }))
        : [],
    });
  });
  return [...rows.filter((row) => !row.agent), ...rows.filter((row) => row.agent)];
}

/**
 * Recently closed tabs and windows whose title or URL matches the query (decision 10), newest
 * first, tabs before windows, the agent workspace's last. The host runs the same steps with the
 * matching in a worker; this is them in one call.
 * @param {readonly GrepClosedEntry[]} entries
 * @param {GrepQuery} query
 * @returns {GrepClosedRow[]}
 */
export function grepClosed(entries, query) {
  const closed = closedSearchText(entries);
  const { matches } = grepText(closed.text, query, CLOSED_MATCH_CAPS);
  return closedRows(closed, matches);
}

/**
 * The preview of a closed row: what it is, its title and URL, what Enter does. Built in chrome
 * from the row, since a closed tab has no page to ask.
 * @param {GrepClosedRow} row
 * @returns {GrepPreview}
 */
export function closedPreview(row) {
  const at = row.titleAt ?? [0, 0];
  if (!row.closedWindow) {
    return {
      first: 1,
      line: 1,
      at,
      lines: [
        "Recently closed tab",
        row.title,
        row.url,
        "Only its title and URL are searched.",
        "Enter reopens it.",
      ],
    };
  }
  const n = row.tabCount;
  return {
    first: 1,
    line: 1,
    at,
    lines: [
      `Recently closed window, ${n} ${n === 1 ? "tab" : "tabs"}`,
      row.title,
      row.url,
      ...row.tabs.map((t) => `${t.title}  ${t.url}`),
      "Only their titles and URLs are searched.",
      "Enter reopens the window.",
    ],
  };
}

/** Windows the scope box lists one by one; the rest are one line (decision 10). */
const SCOPE_WINDOWS = 5;

/**
 * @param {number} n
 * @param {string} word
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The scope box (decision 10): its title names the scope, and a line per window says what is
 * searched there, workspace by workspace, so a search never runs out of sight.
 * @param {GrepScope} scope
 * @param {readonly GrepTab[]} tabs  the tabs in scope
 * @param {{ tabs: number, windows: number } | null} closed  what recently closed holds
 * @returns {{ title: string, lines: string[] }}
 */
export function grepScopeText(scope, tabs, closed) {
  /** @type {Map<number, GrepTab[]>} */
  const byWindow = new Map();
  for (const t of tabs) byWindow.set(t.window, [...(byWindow.get(t.window) ?? []), t]);
  const totals = (/** @type {readonly GrepTab[]} */ ts) => {
    const unloaded = ts.filter((t) => !t.loaded).length;
    return `${plural(ts.length, "tab")}${unloaded ? `, ${unloaded} not loaded` : ""}`;
  };
  /** @type {string[]} */
  const lines = [];
  const windows = [...byWindow.keys()].sort((a, b) => a - b);
  for (const w of windows.slice(0, SCOPE_WINDOWS)) {
    const ts = /** @type {GrepTab[]} */ (byWindow.get(w));
    /** @type {Map<string, { n: number, agent: boolean }>} */
    const spaces = new Map();
    for (const t of ts) {
      const s = spaces.get(t.workspace) ?? { n: 0, agent: t.agent };
      s.n++;
      spaces.set(t.workspace, s);
    }
    const name = (/** @type {string} */ ws, /** @type {boolean} */ agent) =>
      `${agent ? `${AGENT_GLYPH} ` : ""}${ws || "tabs"}`;
    const names =
      spaces.size === 1
        ? [...spaces].map(([ws, s]) => name(ws, s.agent))
        : [...spaces].map(([ws, s]) => `${name(ws, s.agent)} ${s.n}`);
    const mark = w === 1 ? "w1 this window" : `w${w}`;
    lines.push(`${mark}: ${names.join(", ")} · ${totals(ts)}`);
  }
  const rest = windows.slice(SCOPE_WINDOWS);
  if (rest.length) {
    const n = rest.reduce((sum, w) => sum + (byWindow.get(w)?.length ?? 0), 0);
    lines.push(`… ${plural(rest.length, "more window")} · ${plural(n, "tab")}`);
  }
  if (!lines.length) lines.push("no tabs");
  if (closed) {
    lines.push(
      `recently closed: ${plural(closed.tabs, "tab")}, ${plural(closed.windows, "window")} · titles and URLs only`,
    );
  }
  return { title: `Scope: ${GREP_SCOPE_NAMES[scope]} · ctrl+s`, lines };
}

/**
 * The replies as the parent keeps them (decision 14): the matches of the best-ranked replies,
 * at most `rows` in all, and only the counts of the rest, since the list shows at most `rows`
 * rows best first. A reply is ranked by its tab's place in the list, then its frame's; among
 * equal ranks the earlier reply is better. The reply that fits only in part keeps its first
 * matches, so exactly `rows` are held. The array keeps its order.
 * @template {{ rank: number, reply: GrepReply }} T
 * @param {readonly T[]} entries
 * @param {{ rows: number }} [caps]
 * @returns {T[]}
 */
export function holdReplies(entries, caps = GREP_CAPS) {
  const total = entries.reduce((n, e) => n + e.reply.matches.length, 0);
  if (total <= caps.rows) return [...entries];
  const order = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.reply.matches.length)
    .sort((a, b) => a.e.rank - b.e.rank || a.i - b.i);
  let room = caps.rows;
  /** @type {Map<number, number>} matches kept, by entry */
  const keep = new Map();
  for (const { e, i } of order) {
    const n = Math.min(e.reply.matches.length, room);
    keep.set(i, n);
    room -= n;
    if (!room) break;
  }
  return entries.map((e, i) => {
    const n = keep.get(i) ?? 0;
    if (n === e.reply.matches.length) return e;
    return { ...e, reply: { ...e.reply, matches: e.reply.matches.slice(0, n) } };
  });
}

/**
 * What the live region says once results settle (decision 15).
 * @param {number} listed  match rows in the list
 * @param {number} count  matches found
 * @param {number} tabs  tabs with a match
 */
export function grepCountText(listed, count, tabs) {
  if (!count) return "no matches";
  const head = `${count} ${count === 1 ? "match" : "matches"} in ${tabs} ${tabs === 1 ? "tab" : "tabs"}`;
  return listed < count ? `${head}, ${listed} listed` : head;
}

/**
 * The window's grep list after a jump (decision 8).
 * @typedef {{ query: string, rows: readonly GrepRow[], index: number }} GrepList
 */

/**
 * The next (`1`) or previous (`-1`) result whose tab is still open, wrapping; null when none is.
 * @param {GrepList} list
 * @param {1 | -1} dir
 * @param {(tabId: string) => boolean} alive
 * @returns {GrepList | null}
 */
export function stepGrepList(list, dir, alive) {
  const n = list.rows.length;
  // Index -1 is "before row 0" (pruneGrepList): `]q` goes to row 0, `[q` to the last row.
  const from = list.index < 0 && dir < 0 ? 0 : list.index;
  for (let k = 1; k <= n; k++) {
    const index = (((from + dir * k) % n) + n) % n;
    const row = /** @type {GrepRow} */ (list.rows[index]);
    if (alive(row.tabId)) return { ...list, index };
  }
  return null;
}

/**
 * The grep list without the rows of tabs that have closed; the index stays on its row, or
 * just before where it was, so the next step goes on from there. Null when no row is left.
 * @param {GrepList} list
 * @param {(tabId: string) => boolean} alive
 * @returns {GrepList | null}
 */
export function pruneGrepList(list, alive) {
  const rows = list.rows.filter((r) => alive(r.tabId));
  if (!rows.length) return null;
  const before = list.rows.slice(0, list.index).filter((r) => alive(r.tabId)).length;
  const current = list.rows[list.index];
  const index = current && alive(current.tabId) ? before : before - 1;
  return { ...list, rows, index };
}

/** @param {GrepList} list */
export function grepListText(list) {
  return `grep ${list.index + 1}/${list.rows.length}`;
}

/** @typedef {"workspace" | "window" | "windows" | "closed"} GrepScope */
/** @type {readonly GrepScope[]} `ctrl+s` cycles them in this order (decision 10). */
const SCOPES = ["workspace", "window", "windows", "closed"];
/** @type {Readonly<Record<GrepScope, string>>} */
export const GREP_SCOPE_NAMES = Object.freeze({
  workspace: "this workspace",
  window: "this window",
  windows: "all windows",
  closed: "all windows + closed",
});

/**
 * @typedef {object} GrepPickerState
 * @property {string} query  the grep query
 * @property {"search" | "browse"} mode
 * @property {GrepScope} scope
 * @property {readonly GrepRow[]} all  the search's rows, best first
 * @property {readonly GrepRow[]} rows  the rows shown: `all`, or refine's filtered rows
 * @property {number} selected  index into `rows`; 0 is the best, next to the prompt
 * @property {{ query: string, base: readonly GrepRow[] } | null} refine  `ctrl+space`
 * @property {boolean} preview  the preview is shown (ctrl+d/ctrl+u scroll it)
 * @property {boolean} g  a `g` waits for the second of `gg`
 */
/**
 * @typedef {null | { type: "query", query: string } | { type: "scope", scope: GrepScope }
 *   | { type: "preview", by: 1 | -1 } | { type: "select", row: GrepRow }
 *   | { type: "close" }} GrepEffect
 */

/**
 * @param {GrepPickerState} s
 * @param {Partial<GrepPickerState>} changes
 * @returns {GrepPickerState}
 */
const update = (s, changes) => Object.freeze({ ...s, ...changes });

/**
 * @param {string} query
 * @param {{ preview?: boolean }} [options]
 * @returns {GrepPickerState}
 */
export function openGrepPicker(query, { preview = false } = {}) {
  return Object.freeze({
    query,
    mode: "search",
    scope: "workspace",
    all: [],
    rows: [],
    selected: 0,
    refine: null,
    preview,
    g: false,
  });
}

/**
 * Refine's fuzzy filter over a row's line (a not-loaded row: its title), best score first.
 * @param {readonly GrepRow[]} rows
 * @param {string} query
 * @returns {GrepRow[]}
 */
function refineRows(rows, query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...rows];
  /** @type {{ row: GrepRow, score: number }[]} */
  const kept = [];
  for (const row of rows) {
    const text =
      row.kind === "match"
        ? row.context
        : row.kind === "closed"
          ? `${row.title} ${row.url}`
          : row.title;
    let score = 0;
    let ok = true;
    for (const term of terms) {
      const m = scoreField(text, term);
      if (!m) {
        ok = false;
        break;
      }
      score += m.score;
    }
    if (ok) kept.push({ row, score });
  }
  return kept.sort((a, b) => b.score - a.score).map((k) => k.row);
}

/**
 * Rows shown with the selected row kept, if it is still there.
 * @param {GrepPickerState} s
 * @param {readonly GrepRow[]} rows
 */
function show(s, rows) {
  const id = s.rows[s.selected]?.id;
  const at = rows.findIndex((r) => r.id === id);
  return { rows, selected: at >= 0 ? at : 0 };
}

/**
 * New rows from the search; the selected result stays selected while it is listed.
 * @param {GrepPickerState} state
 * @param {readonly GrepRow[]} rows
 * @returns {GrepPickerState}
 */
export function setGrepRows(state, rows) {
  if (state.refine) return update(state, { all: rows });
  // Untouched, the selection is the best result, whichever that is once more tabs answer.
  if (state.selected === 0) return update(state, { all: rows, rows });
  return update(state, { all: rows, ...show(state, rows) });
}

/**
 * @param {GrepPickerState} s
 * @param {number} to
 */
function select(s, to) {
  const i = Math.max(0, Math.min(to, s.rows.length - 1));
  return i === s.selected || !s.rows.length ? s : update(s, { selected: i });
}

/**
 * The first row of the next (`1`) tab, or of this or the previous (`-1`) one.
 * @param {GrepPickerState} s
 * @param {1 | -1} dir
 */
function jumpTab(s, dir) {
  const tab = (/** @type {number} */ i) => s.rows[i]?.tabId;
  const startOf = (/** @type {number} */ i) => {
    while (i > 0 && tab(i - 1) === tab(i)) i--;
    return i;
  };
  if (dir > 0) {
    let i = s.selected;
    while (i < s.rows.length && tab(i) === tab(s.selected)) i++;
    return i < s.rows.length ? select(s, i) : s;
  }
  const here = startOf(s.selected);
  if (s.selected > here) return select(s, here);
  return here > 0 ? select(s, startOf(here - 1)) : s;
}

/**
 * A new text in the prompt: refine filters at once; the grep query asks for a search.
 * @param {GrepPickerState} s
 * @param {string} text
 * @returns {{ state: GrepPickerState, effect: GrepEffect }}
 */
function edit(s, text) {
  if (s.refine) {
    if (text === s.refine.query) return { state: s, effect: null };
    const rows = refineRows(s.refine.base, text);
    return {
      state: update(s, { refine: { ...s.refine, query: text }, rows, selected: 0 }),
      effect: null,
    };
  }
  if (text === s.query) return { state: s, effect: null };
  return { state: update(s, { query: text, selected: 0 }), effect: { type: "query", query: text } };
}

/**
 * One key (formatKey text) in the grep picker (decision 9). Moving keys follow the screen:
 * the best result is at the bottom, next to the prompt, so down moves toward it.
 * @param {GrepPickerState} state
 * @param {string} key
 * @returns {{ state: GrepPickerState, effect: GrepEffect }}
 */
export function grepPickerKey(state, key) {
  const s = state.g && key !== "g" ? update(state, { g: false }) : state;
  /** @param {GrepPickerState} next @param {GrepEffect} [effect] */
  const done = (next, effect = null) => ({ state: next, effect });
  switch (key) {
    case "down":
    case "ctrl+n":
      return done(select(s, s.selected - 1));
    case "up":
    case "ctrl+p":
      return done(select(s, s.selected + 1));
    case "tab":
      return done(jumpTab(s, 1));
    case "shift+tab":
      return done(jumpTab(s, -1));
    case "enter": {
      const row = s.rows[s.selected];
      return done(s, row ? { type: "select", row } : null);
    }
    case "ctrl+s": {
      const scope = /** @type {GrepScope} */ (
        SCOPES[(SCOPES.indexOf(s.scope) + 1) % SCOPES.length]
      );
      return done(update(s, { scope, selected: 0 }), { type: "scope", scope });
    }
    case "ctrl+space":
      if (s.refine) return done(s);
      return done(update(s, { refine: { query: "", base: s.all }, mode: "search" }));
    case "ctrl+d":
      return done(s, s.preview ? { type: "preview", by: 1 } : null);
    case "ctrl+u":
      if (s.preview) return done(s, { type: "preview", by: -1 });
      if (s.mode === "search") return edit(s, "");
      return done(s);
  }
  if (s.mode === "browse") {
    switch (key) {
      case "j":
        return done(select(s, s.selected - 1));
      case "k":
        return done(select(s, s.selected + 1));
      case "g":
        return s.g
          ? done(update(select(s, s.rows.length - 1), { g: false }))
          : done(update(s, { g: true }));
      case "shift+g":
        return done(select(s, 0));
      case "/":
      case "i":
        return done(update(s, { mode: "search" }));
      case "esc":
      case "q":
        return done(s, { type: "close" });
    }
    return done(s);
  }
  const text = s.refine ? s.refine.query : s.query;
  switch (key) {
    case "esc":
      if (s.refine) return done(update(s, { refine: null, ...show(s, s.all) }));
      return done(update(s, { mode: "browse" }));
    case "backspace":
      return edit(s, [...text].slice(0, -1).join(""));
    case "ctrl+w":
      return edit(s, deleteWordBackward(text));
  }
  const ch = typedChar(key);
  return ch === null ? done(s) : edit(s, text + ch);
}
