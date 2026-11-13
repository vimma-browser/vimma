/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the goto picker lists (spec: docs/specs/m2-picker-rename.md): core pickerItems over the
// window's tabs. Tab ids are `tab.linkedPanel`, or for a lazy tab (no panel until it is first
// selected, as every restored background tab is) the window model's uuid (m3-workspaces 3), or
// in a window without workspaces an id core tabIds keeps for it.

import { pickerItems } from "../core/picker.mjs";
import { tabIds } from "../core/tabs.mjs";
import { getTabLabel } from "../workspaces/tab-labels.mjs";
import { selectableTabs } from "./tab-ops.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";

/** @import { PickerItem } from "../core/picker.mjs" */
/** @import { Workspaces } from "../core/workspaces.mjs" */

/**
 * @typedef {Element & { linkedPanel: string | null, label: string,
 *   linkedBrowser: { contentTitle: string, currentURI: { spec: string } } }} Tab
 * @typedef {{ selectedTab: Tab, tabs: Tab[] }} TabBrowser
 */

/**
 * The ids of a window without workspaces. One set for every window: tab search lists several
 * windows' tabs together, so an id must not repeat across them.
 * @type {ReturnType<typeof tabIds<Tab>>}
 */
const windowTabIds = tabIds();

/** @param {BrowserWindow} win */
function gBrowserOf(win) {
  return /** @type {{ gBrowser: TabBrowser }} */ (/** @type {unknown} */ (win)).gBrowser;
}

/**
 * The workspace model the picker lists: the window's workspaces (m3-workspaces 2b), every
 * workspace's tabs in the window's tab order; selecting one in another workspace switches to it
 * (WindowWorkspaces' TabSelect). A window without workspaces (a private window, a popup, or
 * every window when containers are off) lists its visible tabs.
 * @param {BrowserWindow} win
 * @returns {Workspaces}
 */
export function pickerWorkspaces(win) {
  const ww = WindowWorkspaces.get(win);
  const model = ww?.model;
  if (ww && model) {
    const order = new Map(gBrowserOf(win).tabs.map((t, i) => [ww.idOf(/** @type {any} */ (t)), i]));
    const at = (/** @type {string} */ id) => order.get(id) ?? Infinity;
    const panel = (/** @type {string} */ id) => ww.tabOf(id)?.linkedPanel || id;
    return {
      ...model,
      workspaces: model.workspaces.map((w) => ({
        ...w,
        tabs: [...w.tabs].sort((a, b) => at(a) - at(b)).map(panel),
        activeTab: w.activeTab && panel(w.activeTab),
        panes: null,
      })),
    };
  }
  const tabs = /** @type {Tab[]} */ (selectableTabs(win));
  const workspace = {
    id: "window",
    name: "",
    container: "",
    tabs: tabs.map((t) => windowTabIds.idOf(t)),
    activeTab: selectedTabId(win),
    panes: null,
  };
  return { workspaces: [workspace], active: workspace.id, next: 1 };
}

/**
 * The selected tab's id, as the picker's rows name it: its panel, the same in a window with
 * workspaces or without, since the selected tab is loaded.
 * @param {BrowserWindow} win
 */
export function selectedTabId(win) {
  return windowTabIds.idOf(gBrowserOf(win).selectedTab);
}

/**
 * @param {BrowserWindow} win
 * @param {string} tabId
 * @returns {Tab | undefined}
 */
export function tabById(win, tabId) {
  const tab = windowTabIds.find(gBrowserOf(win).tabs, tabId);
  if (tab) return tab;
  const lazyTab = WindowWorkspaces.get(win)?.tabOf(tabId);
  return /** @type {Tab | undefined} */ (/** @type {unknown} */ (lazyTab));
}

/**
 * Every tab the picker lists, with its title, URL, rename and audio and pinned state. Nothing
 * here loads a lazy tab: its browser answers title and URL from SessionStore (tab-search,
 * decision 9).
 * @param {BrowserWindow} win
 * @param {{ agentId?: string | null, window?: number, name?: string }} [options]  `name`: the
 *   workspace name of a window without workspaces (the private workspace)
 * @returns {PickerItem[]}
 */
export function gotoItems(win, { agentId = null, window, name } = {}) {
  const base = pickerWorkspaces(win);
  const model =
    name === undefined
      ? base
      : { ...base, workspaces: base.workspaces.map((w) => (w.name ? w : { ...w, name })) };
  /** @type {Record<string, string>} */
  const labels = {};
  for (const id of model.workspaces.flatMap((w) => w.tabs)) {
    const tab = tabById(win, id);
    const label = tab && getTabLabel(tab);
    if (label) labels[id] = label;
  }
  return pickerItems(
    model,
    (id) => {
      const tab = tabById(win, id);
      if (!tab) return undefined;
      const browser = tab.linkedBrowser;
      const t = /** @type {any} */ (tab);
      return {
        title: browser.contentTitle || tab.label,
        url: browser.currentURI?.spec ?? "",
        playing: !!t.soundPlaying,
        muted: !!t.muted,
        pinned: !!t.pinned,
      };
    },
    labels,
    { agentId, ...(window !== undefined ? { window } : {}) },
  );
}
