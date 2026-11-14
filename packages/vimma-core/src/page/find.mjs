/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Find in page (spec m1-find): the pure rules. The host drives Firefox's own finder.
 */

/**
 * @typedef {object} FindStatus  what the status bar shows about the current find
 * @property {string} query
 * @property {boolean} [backward]   started with `?`
 * @property {number} [current]     1-based position of the selected match, 0 if unknown
 * @property {number} [total]       matches in the page and its frames; -1 over `limit`
 * @property {number} [limit]       the finder's count limit
 * @property {boolean} [notFound]
 */

/**
 * Vim's smartcase: a query with any upper-case letter matches case, an all lower-case one
 * does not. The same test as Firefox's find bar in its "auto" case mode.
 * @param {string} query
 */
export function isCaseSensitive(query) {
  return query !== query.toLowerCase();
}

/**
 * `/word [2/5]`, `?word`, `/word [>1000]`, `/zzz not found`.
 * @param {FindStatus} find
 */
export function findStatusText({ query, backward = false, current = 0, total, limit, notFound }) {
  const head = `${backward ? "?" : "/"}${query}`;
  if (notFound) return `${head} not found`;
  const count = findCountText({ current, total, limit });
  return count ? `${head} ${count}` : head;
}

/**
 * The match count as the find bar and the status bar show it: `[2/5]`, `[>1000]` over the
 * finder's limit, "" while unknown.
 * @param {{ current?: number, total?: number, limit?: number }} count
 */
export function findCountText({ current = 0, total, limit }) {
  if (total === -1) return limit ? `[>${limit}]` : "";
  if (!total) return "";
  return `[${current}/${total}]`;
}

/**
 * The top frame's scroll position as its child answered `Vimma:ScrollPosition`: a fresh
 * `{ x, y }` of finite numbers, or null for anything else. The answer comes from a content
 * process, which may be compromised; a caller that compares two positions then sees no position
 * rather than one that never compares equal or always does.
 * @param {unknown} raw
 * @returns {{ x: number, y: number } | null}
 */
export function parseScrollPosition(raw) {
  if (!raw || typeof raw !== "object" || !("x" in raw) || !("y" in raw)) return null;
  const { x, y } = raw;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
