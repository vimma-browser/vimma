/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Which tab a tab-selection action lands on (spec: docs/specs/m2-tab-keys.md). Indices are into
 * the tabs the user can select: today Firefox's visible tabs, from M3 the workspace's.
 */

/** @import { Action } from "./dispatcher.mjs" */

/**
 * @param {Action} action  tab.next, tab.previous or tab.goto
 * @param {number} current  index of the selected tab, -1 when it is not among them
 * @param {number} length  how many tabs there are
 * @returns {number | null}  the index to select, or null for nothing to do
 */
export function tabTarget(action, current, length) {
  if (length <= 0 || current < 0 || current >= length) return null;
  /** @param {number} n  1-based; Herdr ignores a tab number past the last tab */
  const nth = (n) => (n >= 1 && n <= length ? n - 1 : null);
  switch (action.id) {
    case "tab.goto":
      return action.arg === undefined ? null : nth(action.arg);
    // Firefox's alt+9 (docs/specs/firefox-keys.md).
    case "tab.goto_last":
      return length - 1;
    case "tab.next":
      // Vim: `3gt` goes to tab 3, `gt` to the next one.
      return action.count === undefined ? (current + 1) % length : nth(action.count);
    case "tab.previous": {
      // Vim: `3gT` goes back three tabs. Herdr wraps (rem_euclid), and so does Vim.
      const back = action.count ?? 1;
      return (((current - back) % length) + length) % length;
    }
    default:
      return null;
  }
}

/**
 * Ids for the tabs of a window without workspaces (a private window, a popup, or every window
 * when containers are off), which has no workspace model to give its tabs uuids. A loaded tab's id is its panel, as in a window with workspaces; an
 * unloaded tab has no panel (Firefox's "Unload Tab" and every restored background tab), so it
 * gets an id of its own, kept for as long as the tab lives, and `find` still takes that id once
 * the tab has loaded: a row listed while the tab was unloaded selects it.
 * @template {{ linkedPanel: string | null }} T
 * @param {string} [prefix]  sets these ids apart from panels and workspace uuids
 */
export function tabIds(prefix = "lazy-") {
  /** @type {WeakMap<T, string>} */
  const unloaded = new WeakMap();
  let next = 0;
  return {
    /** @param {T} tab */
    idOf(tab) {
      if (tab.linkedPanel) return tab.linkedPanel;
      let id = unloaded.get(tab);
      if (!id) unloaded.set(tab, (id = `${prefix}${++next}`));
      return id;
    },
    /**
     * @param {readonly T[]} tabs
     * @param {string} id  never empty; a missing one names no tab (an unloaded tab's panel is
     *   null, and a tab never listed has no unloaded id)
     * @returns {T | undefined}
     */
    find(tabs, id) {
      if (!id) return undefined;
      return tabs.find((t) => t.linkedPanel === id || unloaded.get(t) === id);
    },
  };
}
