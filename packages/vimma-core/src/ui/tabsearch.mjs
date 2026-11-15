/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tab search (docs/specs/tab-search.md): what the goto picker lists across windows and recently
 * closed tabs and windows, its sections, the private filter, the caps and the accessible names.
 * Pure; the host (host/tab-search.mjs) collects the windows and SessionStore's closed data.
 */
import { AGENT_GLYPH } from "../agent/agent.mjs";
import { markerWords, sectionOf } from "./picker.mjs";
import { displayLabel } from "../workspaces/tablabels.mjs";

/** @import { PickerItem } from "./picker.mjs" */

export { sectionOf };

/** Closed tabs listed, as Firefox's `browser.sessionstore.max_tabs_undo` (decision 3). */
export const CLOSED_TAB_CAP = 25;
/** Closed windows listed, as Firefox's `browser.sessionstore.max_windows_undo`. */
export const CLOSED_WINDOW_CAP = 5;
/** Rows rendered at once; the rest are a "… N more" row (decision 10). */
export const ROW_CAP = 200;

/**
 * A recently closed tab, as the host reads it from SessionStore.
 * @typedef {object} ClosedTab
 * @property {number} closedId
 * @property {string} title
 * @property {string} url        the current entry of its saved history
 * @property {number} closedAt
 * @property {boolean} private   closed in a private window
 * @property {string} workspaceName  the workspace that owns its container, or ""
 * @property {boolean} [agent]   that workspace is the agent workspace
 */
/**
 * A recently closed window.
 * @typedef {{ closedId: number, title: string, tabCount: number, closedAt: number }} ClosedWindow
 */
/**
 * @typedef {object} TabSearchInput
 * @property {boolean} private  the window searching is (part of) the private workspace
 * @property {{ private: boolean, items: PickerItem[] }[]} windows  this window first, then the
 *   others, most recent first
 * @property {ClosedTab[]} closedTabs
 * @property {ClosedWindow[]} closedWindows  never a private one (Firefox keeps none)
 */

/**
 * @param {ClosedTab} c
 * @returns {PickerItem}
 */
export function closedTabItem(c) {
  const markers = markerWords({ agent: c.agent, closed: true });
  return Object.freeze({
    tabId: `closed:${c.closedId}`,
    workspaceId: "",
    workspaceName: c.workspaceName,
    workspaceIndex: 0,
    tabIndex: 0,
    title: c.title,
    url: c.url,
    label: null,
    display: displayLabel({ label: null, title: c.title, url: c.url }),
    active: false,
    markers,
    closed: /** @type {const} */ (true),
    ...(c.agent ? { agent: /** @type {const} */ (true) } : {}),
  });
}

/**
 * @param {ClosedWindow} c
 * @returns {PickerItem}
 */
export function closedWindowItem(c) {
  return Object.freeze({
    tabId: `closedwin:${c.closedId}`,
    workspaceId: "",
    workspaceName: "",
    workspaceIndex: 0,
    tabIndex: 0,
    title: c.title,
    url: "",
    label: null,
    display: c.title || "Closed window",
    active: false,
    markers: "closed window",
    closed: /** @type {const} */ (true),
    closedWindow: /** @type {const} */ (true),
    tabCount: c.tabCount,
  });
}

/**
 * Sorts recently closed tabs or windows newest first. SessionStore stamps `closedAt` in whole
 * milliseconds and keeps entries closed in the same one oldest first, so ties go by `closedId`,
 * which it hands out in closing order.
 * @param {{ closedAt: number, closedId: number }} a
 * @param {{ closedAt: number, closedId: number }} b
 */
export function newestClosedFirst(a, b) {
  return b.closedAt - a.closedAt || b.closedId - a.closedId;
}

/**
 * Everything tab search lists, in order (decision 3): this window's tabs, the other windows',
 * then "Recently closed": closed tabs newest first, then closed windows. A normal window never
 * lists a private tab, open or closed, and a private window lists private ones only (decision 5).
 * @param {TabSearchInput} input
 * @returns {PickerItem[]}
 */
export function tabSearchItems(input) {
  const same = input.windows.filter((w) => w.private === input.private);
  const open = same.flatMap((w, i) =>
    i === 0 ? w.items : w.items.map((item) => Object.freeze({ ...item, window: i + 1 })),
  );
  const tabs = input.closedTabs
    .filter((c) => c.private === input.private)
    .sort(newestClosedFirst)
    .slice(0, CLOSED_TAB_CAP)
    .map(closedTabItem);
  const windows = input.private
    ? []
    : [...input.closedWindows]
        .sort(newestClosedFirst)
        .slice(0, CLOSED_WINDOW_CAP)
        .map(closedWindowItem);
  return [...open, ...tabs, ...windows];
}

/**
 * A section's heading row: `work · 12`, `personal · 40 · w2`, `Recently closed · 9`.
 * @param {PickerItem} item  the section's first item
 * @param {number} count
 */
export function sectionHeading(item, count) {
  if (item.closed) return `Recently closed · ${count}`;
  const name = item.agent ? `${AGENT_GLYPH} ${item.workspaceName}` : item.workspaceName;
  const window = item.window ? ` · w${item.window}` : "";
  return `${name || "tabs"} · ${count}${window}`;
}

/**
 * An option's accessible name (decision 11): the tab, its workspace, its window or "recently
 * closed", and its markers as words. A listbox cannot hold headings, so the section is here.
 * @param {PickerItem} item
 */
export function accessibleName(item) {
  if (item.closedWindow) {
    const n = item.tabCount ?? 0;
    return `${item.display}, closed window, ${n} ${n === 1 ? "tab" : "tabs"}`;
  }
  const parts = [item.display];
  if (item.workspaceName) parts.push(item.workspaceName);
  if (item.window) parts.push(`window ${item.window}`);
  if (item.closed) parts.push("recently closed");
  for (const word of (item.markers ?? "").split(" ")) {
    if (!word || word === "closed") continue;
    // The agent workspace's name usually says it already.
    if (word === "agent" && item.workspaceName === "agent") continue;
    parts.push(word);
  }
  return parts.join(", ");
}

/**
 * What the live region says after the query changes (decision 11).
 * @param {number} n
 */
export function countText(n) {
  if (!n) return "no tabs match";
  return `${n} ${n === 1 ? "tab" : "tabs"}`;
}

/**
 * The rows rendered: at most `cap`, a window that keeps the selection inside it, so `j`/`k` and
 * `Tab` reach every row while hundreds of tabs render as 200 (decision 10).
 * @param {number} total
 * @param {number} selected
 * @param {number} [cap]
 * @returns {{ start: number, end: number }}
 */
export function rowRange(total, selected, cap = ROW_CAP) {
  if (total <= cap) return { start: 0, end: total };
  const start = Math.max(0, Math.min(selected - Math.floor(cap / 2), total - cap));
  return { start, end: start + cap };
}
