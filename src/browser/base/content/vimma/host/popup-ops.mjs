/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pop-up picker's operations and its status bar cue (docs/specs/popup-blocked.md), over the
// selected browser's pop-up blocker (toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs) and
// the bar's own options (browser/modules/PopupAndRedirectBlockerObserver.sys.mjs), so Firefox's
// logic decides what allowing or opening does. Chrome-only: VimmaHost runs these from keys and
// the command line; no control command or MCP tool reaches them.

import {
  AGENT_REFUSED,
  NOTHING_BLOCKED,
  parsePopupId,
  popupCue,
  popupItems,
} from "../core/popups.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/** @import { PopupItem } from "../core/popups.mjs" */
/** @import { Keymap } from "../core/keymap.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PopupAndRedirectBlockerObserver: "resource:///modules/PopupAndRedirectBlockerObserver.sys.mjs",
});

/** The bar's value (PopupAndRedirectBlockerObserver.showBrowserMessage). */
const BAR = "popup-blocked";
const LOCK_PREF = "dom.disable_open_during_load";
const SHOW_PREF = "privacy.popups.showBrowserMessage";

/**
 * What the picker last listed, per window: the browser it read and Firefox's own records, which
 * a row's id indexes. The picker closes when the tab changes, so these are the selected page's.
 * @type {WeakMap<Window, { browser: any, popups: any[], redirect: any }>}
 */
const listed = new WeakMap();

/** @param {Window} win */
const gBrowserOf = (win) => /** @type {any} */ (win).gBrowser;

/**
 * Whether the selected tab is in the agent workspace, whose pages get no permissions
 * (docs/security.md M10).
 * @param {Window} win
 */
function inAgentTab(win) {
  return WorkspaceStore.isAgentContainer(gBrowserOf(win)?.selectedTab?.userContextId);
}

/**
 * The host the allow row names, as Firefox's options menu names it (onPopupShowing): the
 * principal's display host, else the address itself (about: pages).
 * @param {any} browser
 */
function siteOf(browser) {
  const source = browser.isContentPrincipal ? browser.contentPrincipal : browser.currentURI;
  try {
    return source.asciiHost ? source.displayHost : source.spec;
  } catch {
    return browser.currentURI?.spec ?? "";
  }
}

/**
 * The picker's rows for the selected page, read from its pop-up blocker. Empty when nothing is
 * blocked or the tab is the agent workspace's.
 * @param {Window} win
 * @returns {Promise<PopupItem[]>}
 */
export async function popupPickerItems(win) {
  listed.delete(win);
  if (inAgentTab(win)) return [];
  const browser = gBrowserOf(win)?.selectedBrowser;
  const blocker = browser?.popupAndRedirectBlocker;
  if (!blocker) return [];
  const [popups, redirect] = await Promise.all([
    blocker.getBlockedPopups(),
    blocker.getBlockedRedirect(),
  ]);
  listed.set(win, { browser, popups, redirect });
  return popupItems({
    site: siteOf(browser),
    popups: popups.map((/** @type {any} */ p) => p.popupWindowURISpec),
    redirect: redirect?.redirectURISpec ?? null,
    allowLocked: Services.prefs.prefIsLocked(LOCK_PREF),
    showMessage: Services.prefs.getBoolPref(SHOW_PREF, true),
  });
}

/**
 * Why the picker does not open on this page, or null when it has rows to show.
 * @param {Window} win
 * @param {readonly PopupItem[]} items  popupPickerItems' answer
 * @returns {string | null}
 */
export function popupRefusal(win, items) {
  if (inAgentTab(win)) return AGENT_REFUSED;
  return items.length ? null : NOTHING_BLOCKED;
}

/**
 * Runs the row's bar action on the page it was listed for. The observer's methods read only the
 * event's window, so a stand-in event runs them exactly as the bar's menu does.
 * @param {Window} win
 * @param {string} id
 */
export function runPopupRow(win, id) {
  const op = parsePopupId(id);
  const snapshot = listed.get(win);
  listed.delete(win);
  const gBrowser = gBrowserOf(win);
  if (!op || !snapshot || snapshot.browser !== gBrowser?.selectedBrowser || inAgentTab(win)) {
    return;
  }
  const observer = lazy.PopupAndRedirectBlockerObserver;
  const event = { originalTarget: { documentGlobal: win } };
  const blocker = snapshot.browser.popupAndRedirectBlocker;
  switch (op.op) {
    case "allow":
      observer
        .toggleAllowPopupsForSite(event)
        .catch((/** @type {unknown} */ e) => console.error("vimma: pop-ups", e));
      break;
    case "popup": {
      const p = snapshot.popups[op.index];
      if (p) blocker.unblockPopup(p.browsingContext, p.innerWindowId, p.reportIndex);
      break;
    }
    case "redirect": {
      const r = snapshot.redirect;
      if (r) blocker.unblockRedirect(r.browsingContext, r.innerWindowId, r.redirectURISpec);
      break;
    }
    case "hide":
      observer.dontShowMessage(event);
      break;
    case "settings":
      observer.editPopupSettings(event);
      break;
  }
}

/**
 * The status bar's cue while the selected browser has the bar (each split pane has its own
 * notification box; the focused pane's browser is the selected one), else null.
 * @param {Window} win
 * @param {Keymap | null | undefined} keymap
 * @returns {string | null}
 */
export function popupStatus(win, keymap) {
  const gBrowser = gBrowserOf(win);
  const box = gBrowser?.readNotificationBox?.(gBrowser.selectedBrowser);
  if (!box?.getNotificationWithValue(BAR)) return null;
  return popupCue(keymap?.keysFor("popup_picker") ?? [], { agent: inAgentTab(win) });
}
