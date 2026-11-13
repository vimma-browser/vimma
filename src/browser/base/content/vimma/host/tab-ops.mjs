/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Herdr tab keys over plain gBrowser (spec: docs/specs/m2-tab-keys.md). Other workspaces'
// tabs are hidden (m3-workspaces 2b), so `selectableTabs`, Firefox's visible tabs, is the
// current workspace's (and pinned tabs, which every workspace shows).

import { refusedScheme } from "../core/pageurl.mjs";
import { tabTarget } from "../core/tabs.mjs";
import { getTabLabel, setTabLabel } from "../workspaces/tab-labels.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */
/** @import { WindowState } from "./VimmaHost.sys.mjs" */

const lazy = /** @type {Lazy<"UrlbarUtils">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

/**
 * @typedef {object} TabBrowser  the part of gBrowser these keys use
 * @property {Element[]} visibleTabs
 * @property {Element & { pinned?: boolean }} selectedTab
 * @property {number} pinnedTabCount
 * @property {{ selectedIndex: number }} tabContainer
 * @property {(options?: object) => void} removeCurrentTab
 * @property {(tab: object, options?: object) => void} removeTab
 * @property {{ userTriggeredContext: (source: string) => object,
 *   METRIC_SOURCE: { KEYBOARD: string } }} TabMetrics
 */

/** @param {BrowserWindow} win */
function gBrowserOf(win) {
  return /** @type {{ gBrowser: TabBrowser }} */ (/** @type {unknown} */ (win)).gBrowser;
}

/**
 * The tabs prefix+n/p and prefix+1..9 count through, in order. Firefox's visible tabs: hidden
 * tabs (an extension's, or another workspace's from M3) are skipped.
 * @param {BrowserWindow} win
 * @returns {Element[]}
 */
export function selectableTabs(win) {
  return gBrowserOf(win).visibleTabs;
}

/**
 * tab.new: Firefox's own new-tab command (ctrl+t): the new-tab page, the URL bar focused.
 * @param {BrowserWindow} win
 */
export function newTab(win) {
  /** @type {{ BrowserCommands: { openTab: () => void } }} */ (
    /** @type {unknown} */ (win)
  ).BrowserCommands.openTab();
}

/**
 * tab.close: what Firefox's ctrl+w does (BrowserCommands.closeTabOrWindow with a modifier
 * event, browser-commands.js): on a pinned tab it selects the first unpinned tab instead of
 * closing; otherwise it closes the selected tab, and the last tab closes the window unless
 * `browser.tabs.closeWindowWithLastTab` is false (M3 sets it false). Metrics as for ctrl+w.
 * @param {BrowserWindow} win
 */
export function closeTab(win) {
  const gBrowser = gBrowserOf(win);
  if (gBrowser.selectedTab.pinned) {
    if (gBrowser.visibleTabs.length > gBrowser.pinnedTabCount) {
      gBrowser.tabContainer.selectedIndex = gBrowser.pinnedTabCount;
    }
    return;
  }
  const { TabMetrics } = gBrowser;
  gBrowser.removeCurrentTab({
    animate: true,
    metricsContext: TabMetrics.userTriggeredContext(TabMetrics.METRIC_SOURCE.KEYBOARD),
  });
}

/**
 * `x` in the side panel (docs/specs/key-handling-batch.md § 4): closes `tab` as the tab
 * strip's close button would, selected or not. A pinned tab stays (core refuses it first).
 * @param {BrowserWindow} win
 * @param {any} tab
 */
export function closeTabById(win, tab) {
  if (tab.pinned) return;
  const gBrowser = gBrowserOf(win);
  const { TabMetrics } = gBrowser;
  gBrowser.removeTab(tab, {
    animate: true,
    metricsContext: TabMetrics.userTriggeredContext(TabMetrics.METRIC_SOURCE.KEYBOARD),
  });
}

/**
 * `tab.restore` (ctrl+shift+t, in every mode): Firefox's own command for its ctrl+shift+t,
 * which reopens the last closed tab (or window, or the last session).
 * @param {BrowserWindow} win
 */
export function restoreTab(win) {
  /** @type {any} */ (
    win.document.getElementById("History:RestoreLastClosedTabOrWindowOrSession")
  )?.doCommand();
}

/**
 * tab.next, tab.previous, tab.goto.
 * @param {BrowserWindow} win
 * @param {Action} action
 */
export function selectTab(win, action) {
  const gBrowser = gBrowserOf(win);
  const tabs = selectableTabs(win);
  const index = tabTarget(action, tabs.indexOf(gBrowser.selectedTab), tabs.length);
  const tab = index === null ? undefined : tabs[index];
  if (tab && tab !== gBrowser.selectedTab) gBrowser.selectedTab = tab;
}

/**
 * page.open (`:open text`) and `:tabnew text`: load what was typed as the URL bar would, through
 * URIFixup with keyword lookup (`allowThirdPartyFixup`: `example.com` gets a scheme, words go to
 * the default search engine; spec m1-cmdline, Settled). Every Vimma open that loads with the
 * system principal comes through here, so `refusedScheme` (`p`'s check) refuses `javascript:`
 * and `data:` first: Gecko lets a system-principal load put a `data:` page top-level (issue #98).
 * @param {BrowserWindow} win
 * @param {string} text
 * @param {"current" | "tab"} where
 * @returns {boolean} false when refused (a `javascript:` or `data:` URL); nothing is loaded
 */
export function openUrl(win, text, where) {
  if (refusedScheme(text)) return false;
  /** @type {{ openTrustedLinkIn: (url: string, where: string, params: object) => void }} */ (
    /** @type {unknown} */ (win)
  ).openTrustedLinkIn(text, where, { allowThirdPartyFixup: true, inBackground: false });
  return true;
}

/**
 * `:open text` and `:tabnew text` (docs/specs/search-engines.md, decision 5): a search alias
 * (`@gh cats`, Vimma's or Firefox's own `@google`) or a Places bookmark keyword at the start
 * resolves as the URL bar resolves it, with Firefox's own function; anything else goes through
 * `openUrl` as before. The resolved URL is checked again (a keyword bookmarklet is a
 * `javascript:` URL) and loaded without fixup, its POST data passed on. The principal is never
 * inherited (`mayInheritPrincipal` is ignored). `? @gh cats` searches the default engine for
 * the literal text, as URIFixup's `?` prefix does.
 * @param {BrowserWindow} win
 * @param {string} text
 * @param {"current" | "tab"} where
 * @returns {Promise<boolean>} false when refused; nothing is loaded
 */
export async function openTyped(win, text, where) {
  if (refusedScheme(text)) return false;
  // The tab it was typed in, before the lookup yields: a workspace switch meanwhile (into the
  // agent workspace, say) must not send the query, or a POST body, to another tab.
  const gBrowser = win.gBrowser;
  const typedIn = gBrowser.selectedBrowser;
  /** @type {{ url: string, postData: unknown }} */
  const r = await lazy.UrlbarUtils.getShortcutOrURIAndPostData(text);
  const moved = gBrowser.selectedBrowser !== typedIn;
  if (!r.url || r.url === text) {
    if (!moved) return openUrl(win, text, where);
    r.url = text;
  } else if (refusedScheme(r.url)) return false;
  /** @type {Record<string, unknown>} */
  const params = { postData: r.postData, inBackground: false };
  if (r.url === text) params.allowThirdPartyFixup = true;
  if (moved) {
    // Where it was typed: that tab, or a new tab in its container, left in the background.
    if (where === "current") params.targetBrowser = typedIn;
    else {
      params.userContextId = typedIn.browsingContext?.originAttributes.userContextId ?? 0;
      params.inBackground = true;
    }
  }
  /** @type {{ openTrustedLinkIn: (url: string, where: string, params: object) => void }} */ (
    /** @type {unknown} */ (win)
  ).openTrustedLinkIn(r.url, where, params);
  return true;
}

export const BLOCKED_URL_TEXT =
  "blocked: javascript: and data: URLs can't be opened from the command line";

/**
 * `:open` / `:tabnew` text, or the notice saying why not.
 * @param {WindowState} s
 * @param {string} text
 * @param {"current" | "tab"} where
 */
export function openOrSay(s, text, where) {
  const refused = () => s.notice.show(BLOCKED_URL_TEXT, { error: true });
  // Said at once for the text as typed; a keyword resolving to one is known after the lookup.
  if (refusedScheme(text)) {
    refused();
    return;
  }
  openTyped(s.win, text, where)
    .then((opened) => {
      if (!opened) refused();
    })
    .catch((e) => console.error("vimma: cannot open", e));
}

/**
 * `tab.rename`: with a name (`:tabrename foo`) sets the label at once, else opens the prompt.
 * @param {WindowState} s
 * @param {string | undefined} text
 * @param {(s: WindowState) => void} emit  the host's redraw
 */
export function renameTab(s, text, emit) {
  const tab = /** @type {{ gBrowser: { selectedTab: Element } }} */ (/** @type {unknown} */ (s.win))
    .gBrowser.selectedTab;
  if (text) {
    setTabLabel(tab, text);
    emit(s);
  } else {
    s.rename.open(tab, getTabLabel(tab) ?? "");
  }
}
