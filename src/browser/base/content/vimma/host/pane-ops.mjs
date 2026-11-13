/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pane keys (docs/specs/m4-split-panes.md, sub-specs 3 and 5) over the window's PaneView
// (split/PaneView.mjs), and the tiling layouts (docs/specs/tiling-layouts.md). Each returns the
// text to show (a refusal, or a layout's name), or null.

import { closest, describeAction } from "../core/actions.mjs";
import { LAYOUTS, isLayoutName, layoutOfAction } from "../core/layouts.mjs";
import { leaves } from "../core/panes.mjs";
import { NO_SPLITS_TO_PICK, splitFocusTab, splitPickerItems, stepSplit } from "../core/splits.mjs";
import { PaneViews, isHiddenRefusal } from "../split/PaneView.mjs";
import { closeTab } from "./tab-ops.mjs";
import { tabById } from "./goto.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */
/** @import { Direction, ResizeDirection } from "../core/panes.mjs" */
/** @import { PaneResult } from "../split/PaneView.mjs" */
/** @import { SplitItem } from "../core/splits.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */

/** One resize key's step: a share of the split (m3-m4-core-models, For the host specs). */
export const RESIZE_STEP = 0.05;

/** The side panel's show-together, as its notices name it (m4-side-panel-multiselect). */
const TOGETHER = "Show together";

/** @param {BrowserWindow} win */
function gBrowserOf(win) {
  return /** @type {{ gBrowser: { selectedBrowser: Element & { focus(): void } } }} */ (
    /** @type {unknown} */ (win)
  ).gBrowser;
}

/**
 * Whether the window shows two panes or more: the <C-w> family is runnable only then, so with
 * one pane the first ctrl+w still passes to Firefox and closes the tab (plan §2).
 * @param {BrowserWindow} win
 */
export function hasPanes(win) {
  return !!shownPanes(win);
}

/**
 * The window's PaneView while it shows two panes or more; null with one pane or while the split
 * is a hidden view (docs/specs/side-panel-unsplit.md decision 20): the pane keys then act on the
 * tab shown alone, as with one pane.
 * @param {BrowserWindow} win
 */
function shownPanes(win) {
  const view = PaneViews.get(win);
  return view?.panes && !view.hidden ? view : null;
}

/**
 * tmux: moving to a pane focuses its page. Firefox's tab switch would otherwise restore the URL
 * bar if that tab last had it, or leave focus where it was. A tab-modal dialog keeps its focus.
 * @param {BrowserWindow} win
 */
function focusPage(win) {
  const browser = gBrowserOf(win).selectedBrowser;
  if (!browser.hasAttribute("tabDialogShowing")) browser.focus();
}

/**
 * @param {Action} action
 * @param {PaneResult | undefined} result
 * @returns {string | null}
 */
function refusal(action, result) {
  if (!result || result.ok) return null;
  // It already says what happened and what to do; the action's name would only lengthen it.
  if (isHiddenRefusal(result.reason)) return result.reason;
  return `${describeAction(action)}: ${result.reason}`;
}

/**
 * pane.split_vertical / pane.split_horizontal: a new pane with a new tab (the start page) right
 * of or below the focused one, focused, its URL bar ready for an address as after ctrl+b c.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function splitPane(win, action) {
  const view = PaneViews.get(win);
  const direction = action.id === "pane.split_vertical" ? "vertical" : "horizontal";
  const result = view?.split(direction);
  if (result?.ok) win.gURLBar?.select();
  return refusal(action, result);
}

/**
 * pane.new (`prefix+enter`, docs/specs/tiling-layouts.md): a new pane without a direction,
 * along the focused pane's longer side (`[panes] layout = "dwindle"`) or right ("manual"); as
 * split_vertical / split_horizontal otherwise.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function newPane(win, action) {
  const result = PaneViews.get(win)?.newPane();
  if (result?.ok) win.gURLBar?.select();
  return refusal(action, result);
}

/**
 * pane.next_layout (`prefix+space`, `:layout`), pane.select_layout (`:layout <name>`) and
 * pane.layout_<preset>: rearranges the panes, focuses the focused pane's page as after a move,
 * and returns what the notice says: `layout: <name>`, or the refusal.
 * @param {BrowserWindow} win
 * @param {Action} action
 * @param {string} [text]  `:layout`'s name
 * @returns {string}
 */
export function layoutPanes(win, action, text) {
  const view = shownPanes(win);
  if (!view?.panes) return `${describeAction(action)}: only one pane`;
  /** @type {import("../core/layouts.mjs").LayoutName | undefined} */
  let name = layoutOfAction(action.id);
  if (action.id === "pane.select_layout") {
    const typed = (text ?? "").trim();
    if (!isLayoutName(typed)) {
      const near = closest(typed, LAYOUTS);
      return `no layout "${typed}"${near ? ` (did you mean "${near}"?)` : ""}`;
    }
    name = typed;
  }
  const result = name ? view.arrange(name) : view.nextLayout();
  if (!result.ok) return /** @type {string} */ (refusal(action, result));
  focusPage(win);
  return `layout: ${view.panes?.layout ?? name}`;
}

/**
 * The side panel's `Enter` with marks (docs/specs/m4-side-panel-multiselect.md): those tabs, in
 * that order, become the panes, focus on `focusId`'s, whose page then has keyboard focus. A tab
 * never selected (lazy) gets its browser first, as Firefox's split view does for its panels.
 * @param {BrowserWindow} win
 * With `aloneId`, that tab then shows by itself and the new split waits as a hidden view
 * (docs/specs/side-panel-unsplit.md decision 25).
 * @param {string[]} tabIds  the panel's row ids (a panel id, or a lazy tab's uuid)
 * @param {string} focusId
 * @param {string} [aloneId]
 * @returns {string | null} the refusal for the notice, or null once shown
 */
export function showTabs(win, tabIds, focusId, aloneId) {
  const view = PaneViews.get(win);
  const gBrowser = /** @type {{ insertBrowser(tab: Element): void }} */ (
    /** @type {unknown} */ (gBrowserOf(win))
  );
  const tabs = tabIds.map((id) => tabById(win, id));
  const focus = tabById(win, focusId);
  const alone = aloneId ? tabById(win, aloneId) : undefined;
  if (!view || !focus || tabs.some((t) => !t) || alone === null) {
    return `${TOGETHER}: a tab is gone`;
  }
  const list = /** @type {any[]} */ (tabs);
  for (const t of list) if (!t.linkedPanel) gBrowser.insertBrowser(t);
  const result = view.showTabs(list, /** @type {any} */ (focus), {
    alone: /** @type {any} */ (alone ?? undefined),
  });
  // A new split's refusal names itself (docs/specs/multiple-splits.md behaviour 5).
  if (!result.ok) {
    return result.reason.startsWith("new split:") ? result.reason : `${TOGETHER}: ${result.reason}`;
  }
  focusPage(win);
  return null;
}

/**
 * The side panel's `Enter` down to one mark or none (docs/specs/side-panel-unsplit.md): the
 * split ends, `tabId`'s tab is shown alone and its page has keyboard focus.
 * @param {BrowserWindow} win
 * @param {string} tabId  the panel's row id
 */
export function showAlone(win, tabId) {
  const view = PaneViews.get(win);
  const tab = tabById(win, tabId);
  if (!view || !tab) return;
  view.showAlone(/** @type {any} */ (tab));
  focusPage(win);
}

/**
 * The split the side panel pre-marks (docs/specs/side-panel-unsplit.md): the shown tree's tabs
 * and its focused pane's tab, as panel ids, and whether it is a hidden view; null without one.
 * With several splits (docs/specs/multiple-splits.md behaviour 6 and decision 9) also every
 * split's number and tabs and the shown one's number; on a lone tab nothing is pre-marked.
 * @param {BrowserWindow} win
 * @returns {{ panes: string[], focus: string | null, hidden: boolean,
 *   splits?: { number: number, tabs: string[] }[], shown?: number | null } | null}
 */
export function shownSplit(win) {
  const view = PaneViews.get(win);
  const panes = view?.panes;
  if (!view || !panes) return null;
  const order = leaves(panes);
  const split = {
    panes: order.map((l) => l.tab),
    focus: order.find((l) => l.pane === panes.focus)?.tab ?? null,
    hidden: panes.hidden === true,
  };
  const { splits, shown } = view.splits;
  return {
    ...(shown === null ? { panes: [], focus: null, hidden: false } : split),
    splits: splits.map((x) => ({ number: x.number, tabs: leaves(x).map((l) => l.tab) })),
    shown,
  };
}

/**
 * The status bar's split fields (docs/specs/multiple-splits.md decision 14): the shown split's
 * number and how many the workspace has; none while a workspace keeps one split.
 * @param {BrowserWindow} win
 * @returns {{ split?: number, splits?: number }}
 */
export function splitStatus(win) {
  const view = PaneViews.get(win);
  if (!view?.panes) return {};
  const { splits, shown, last } = view.splits;
  return { split: shown ?? last ?? undefined, splits: splits.length };
}

/**
 * pane.focus_left / _down / _up / _right: the geometric neighbour (core breaks ties by MRU); no
 * neighbour, or one pane, changes nothing. A move unzooms (core); none keeps the zoom.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function focusPane(win, action) {
  const view = shownPanes(win);
  if (!view?.panes) return null;
  const direction = /** @type {Direction} */ (action.id.slice("pane.focus_".length));
  const result = view.focus(direction);
  if (result.ok) focusPage(win);
  return refusal(action, result);
}

/**
 * pane.zoom: the focused pane fills the content area, or the layout comes back.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function zoomPane(win, action) {
  const view = shownPanes(win);
  if (!view?.panes) return null;
  return refusal(action, view.zoom());
}

/**
 * pane.close (`prefix+x`, `:q`): closes the focused pane, whose tab stays open; the last pane
 * closes the tab, with tab.close's rules (a pinned tab selects the first unpinned one).
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function closePane(win, action) {
  const view = shownPanes(win);
  if (!view?.panes) {
    closeTab(win);
    return null;
  }
  const result = view.close();
  if (result.ok) focusPage(win);
  return refusal(action, result);
}

/**
 * pane.swap_left / _down / _up / _right: the focused pane trades places with its neighbour and
 * keeps focus; no neighbour changes nothing.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function swapPane(win, action) {
  const view = shownPanes(win);
  if (!view?.panes) return null;
  const direction = /** @type {Direction} */ (action.id.slice("pane.swap_".length));
  const result = view.swapPane(direction);
  if (result.ok) focusPage(win);
  return refusal(action, result);
}

/**
 * pane.resize_wider / _narrower / _taller / _shorter (resize mode, <C-w> <>+-): one step per
 * key, `count` steps after a count (3l, 3<C-w>>).
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function resizePane(win, action) {
  const view = shownPanes(win);
  if (!view?.panes) return null;
  const direction = /** @type {ResizeDirection} */ (action.id.slice("pane.resize_".length));
  return refusal(action, view.resize(direction, RESIZE_STEP * (action.count ?? 1)));
}

/**
 * The split picker's rows (behaviour 7): the shown workspace's splits with their tabs' titles,
 * or the notice to show instead when it has none.
 * @param {BrowserWindow} win
 * @returns {{ items: SplitItem[] } | { refused: string }}
 */
export function splitPickerRows(win) {
  const view = PaneViews.get(win);
  const items = view?.panes
    ? splitPickerItems(view.splits, (id) => tabById(win, id)?.label ?? "")
    : [];
  return items.length ? { items } : { refused: NO_SPLITS_TO_PICK };
}

/**
 * Shows split `number` by selecting its focused pane's tab: the window's tab selection then
 * shows the split whole (behaviour 2), and its page gets keyboard focus.
 * @param {BrowserWindow} win
 * @param {number} number
 */
export function showSplit(win, number) {
  const view = PaneViews.get(win);
  const id = view?.panes ? splitFocusTab(view.splits, number) : null;
  const tab = id ? tabById(win, id) : null;
  if (!tab) return;
  /** @type {any} */ (gBrowserOf(win)).selectedTab = tab;
  focusPage(win);
}

/**
 * pane.next_split / pane.previous_split (behaviour 8): the next or previous split by number,
 * wrapping; from a lone tab the split shown last. Returns the refusal (`no splits`), or null.
 * @param {BrowserWindow} win
 * @param {Action} action
 * @returns {string | null}
 */
export function stepSplits(win, action) {
  const view = PaneViews.get(win);
  const by = action.id === "pane.next_split" ? 1 : -1;
  const { splits, refusal: refused } = stepSplit(
    view?.panes ? view.splits : { splits: [], shown: null, last: null },
    by,
  );
  if (refused || splits.shown === null) return refused;
  showSplit(win, splits.shown);
  return null;
}

/**
 * Runs a pane op (above) and shows its refusal, if any, as the notice. The hidden-split
 * refusal stays until the next key (docs/specs/multiple-splits.md, decision 4).
 * @param {(win: BrowserWindow, action: Action) => string | null} op
 * @param {(s: WindowState) => void} emit  the host's redraw
 * @returns {(state: WindowState, action: Action) => void}
 */
export function paneRunner(op, emit) {
  return (s, a) => {
    const refused = op(s.win, a);
    if (refused) s.notice.show(refused, { untilKey: isHiddenRefusal(refused) });
    emit(s);
  };
}

/**
 * A layout preset (`layoutPanes`): its notice is the preset's name or the refusal.
 * @param {(s: WindowState) => void} emit  the host's redraw
 * @returns {(s: WindowState, a: Action, text?: string) => void}
 */
export function layoutRunner(emit) {
  return (s, a, text) => {
    s.notice.show(layoutPanes(s.win, a, text));
    emit(s);
  };
}
