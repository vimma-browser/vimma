/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tab search (docs/specs/tab-search.md): what the goto picker lists beyond this window's tabs,
// and Enter on a row. Collects every browser window on the same side of the private line
// (decision 5), most recent first, and SessionStore's recently closed tabs and windows; core
// tabsearch.mjs orders, filters and caps them. Nothing here loads a tab or fetches anything.

import { PRIVATE_NAME } from "../core/privatews.mjs";
import { tabSearchItems } from "../core/tabsearch.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { gotoItems, tabById } from "./goto.mjs";
import { isPrivateBrowsing, isPrivateWorkspace } from "./private-ops.mjs";

/** @import { PickerItem } from "../core/picker.mjs" */
/** @import { ClosedTab, ClosedWindow } from "../core/tabsearch.mjs" */

const lazy = /** @type {Lazy<"BrowserWindowTracker" | "SessionStore">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

/** @param {any} w */
const isBrowserWindow = (w) => !w.closed && w.toolbar?.visible !== false && !!w.gBrowser;

/**
 * The windows tab search lists, this one first, then the rest most recent first. Live grep's
 * wider scopes take the same windows (host/grep.mjs).
 * @param {BrowserWindow} win
 * @returns {BrowserWindow[]}
 */
export function windowsFrom(win) {
  const others = /** @type {BrowserWindow[]} */ (lazy.BrowserWindowTracker.orderedWindows).filter(
    (w) => w !== win && isBrowserWindow(w),
  );
  return [win, ...others];
}

/**
 * The URL of a closed tab's saved state: its current history entry.
 * @param {any} state
 */
function closedUrl(state) {
  const entries = state?.entries ?? [];
  const entry = entries[(state?.index ?? entries.length) - 1] ?? entries.at(-1);
  return entry?.url ?? "";
}

/**
 * Recently closed tabs on this side of the private line. SessionStore never keeps a private
 * tab closed in a normal window, and `private` restricts the windows it reads.
 * @param {boolean} inPrivate
 * @returns {ClosedTab[]}
 */
function closedTabs(inPrivate) {
  const defs = WorkspaceStore.definitions.workspaces;
  const agentId = WorkspaceStore.agent?.id ?? null;
  /** @type {any[]} */
  const data = lazy.SessionStore.getClosedTabData({ private: inPrivate });
  return data.map((c) => {
    const ucid = c.state?.userContextId ?? 0;
    const owner = ucid ? defs.find((d) => d.userContextId === ucid) : undefined;
    return {
      closedId: c.closedId,
      title: c.title ?? "",
      url: closedUrl(c.state),
      closedAt: c.closedAt ?? 0,
      private: inPrivate,
      workspaceName: inPrivate ? PRIVATE_NAME : (owner?.name ?? ""),
      ...(owner && owner.id === agentId ? { agent: true } : {}),
    };
  });
}

/**
 * Recently closed windows (never private ones: Firefox keeps none).
 * @returns {ClosedWindow[]}
 */
function closedWindows() {
  /** @type {any[]} */
  const data = lazy.SessionStore.getClosedWindowData();
  return data.map((w) => ({
    closedId: w.closedId,
    title: w.title ?? "",
    tabCount: w.tabs?.length ?? 0,
    closedAt: w.closedAt ?? 0,
  }));
}

/**
 * Everything tab search lists for `win`, and the window each open tab's row belongs to.
 * @param {BrowserWindow} win
 * @returns {{ items: PickerItem[], windowOf: Map<string, BrowserWindow> }}
 */
export function tabSearchList(win) {
  const inPrivate = isPrivateWorkspace(win);
  const agentId = WorkspaceStore.agent?.id ?? null;
  const windows = windowsFrom(win).filter((w) => isPrivateWorkspace(w) === inPrivate);
  /** @type {Map<string, BrowserWindow>} */
  const windowOf = new Map();
  const listed = windows.map((w) => {
    const items = gotoItems(w, { agentId, ...(inPrivate ? { name: PRIVATE_NAME } : {}) });
    for (const item of items) windowOf.set(item.tabId, w);
    return { private: inPrivate, items };
  });
  const items = tabSearchItems({
    private: inPrivate,
    windows: listed,
    closedTabs: closedTabs(isPrivateBrowsing(win)),
    closedWindows: inPrivate ? [] : closedWindows(),
  });
  return { items, windowOf };
}

/**
 * Enter on an open tab's row: that window to the front, if it is another, and the tab selected
 * there; its workspace becomes current as for any selection (WindowWorkspaces' TabSelect).
 * @param {BrowserWindow} win  the window searching
 * @param {BrowserWindow | undefined} target  the row's window
 * @param {string} tabId
 */
export function goToTab(win, target, tabId) {
  const into = target && !target.closed ? target : win;
  const tab = tabById(into, tabId);
  if (!tab) return;
  if (into !== win) into.focus();
  /** @type {any} */ (into).gBrowser.selectedTab = tab;
}

/**
 * Enter on a recently closed row: the tab reopens in this window (its container, so its
 * workspace, comes with its saved state) and is selected; a closed window reopens. Live grep's
 * closed rows reopen the same way (host/grep.mjs).
 * @param {BrowserWindow} win
 * @param {string} id  `closed:<closedId>` or `closedwin:<closedId>`
 * @returns {any} the reopened tab or window; undefined when the entry is gone (restored or
 *   forgotten since it was listed)
 */
export function reopenClosed(win, id) {
  const m = /^closed(win)?:(\d+)$/.exec(id);
  if (!m) return undefined;
  const closedId = Number(m[2]);
  if (m[1]) return lazy.SessionStore.undoCloseById(closedId);
  return lazy.SessionStore.undoCloseById(closedId, isPrivateBrowsing(win), win);
}
