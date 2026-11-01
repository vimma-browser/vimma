/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pop-up blocked bar's answers (y, n, Esc), the pop-up picker's operations and the bar's
// status bar cue (docs/specs/popup-blocked.md), over the selected browser's pop-up blocker
// (toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs) and the bar's own options
// (browser/modules/PopupAndRedirectBlockerObserver.sys.mjs), so Firefox's logic decides what
// allowing or opening does. Chrome-only: VimmaHost runs these from keys and the command line; no
// control command or MCP tool reaches them.

import {
  AGENT_REFUSED,
  NOTHING_BLOCKED,
  parsePopupId,
  popupCue,
  popupItems,
} from "../core/popups.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";

/** @import { PopupItem } from "../core/popups.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PopupAndRedirectBlockerObserver: "resource:///modules/PopupAndRedirectBlockerObserver.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

/** The bar's value (PopupAndRedirectBlockerObserver.showBrowserMessage). */
const BAR = "popup-blocked";
const LOCK_PREF = "dom.disable_open_during_load";
const SHOW_PREF = "privacy.popups.showBrowserMessage";

/**
 * What the picker last listed, per window: the browser it read, its page's principal and
 * Firefox's own records, which a row's id indexes. The picker closes when the tab changes but not
 * when the page navigates, so a row runs only while the principal is the one listed.
 * @type {WeakMap<Window, { browser: any, principal: any, popups: any[], redirect: any }>}
 */
const listed = new WeakMap();

/** The permission manager, which types/firefox.d.ts does not describe. */
const perms = () => /** @type {any} */ (Services).perms;

/**
 * Whether `dom.disable_open_during_load` is locked (enterprise policy): Firefox's options menu
 * then hides "Allow pop-ups for <site>" and toggleAllowPopupsForSite does nothing, so no Vimma
 * path changes the site's pop-up permission either.
 */
export const popupLocked = () => Services.prefs.prefIsLocked(LOCK_PREF);

/** @param {Window} win */
const gBrowserOf = (win) => /** @type {any} */ (win).gBrowser;

/**
 * Whether the selected tab is in the agent workspace, whose pages get no permissions
 * (docs/security.md M10).
 * @param {Window} win
 */
export function inAgentTab(win) {
  return WorkspaceStore.isAgentContainer(gBrowserOf(win)?.selectedTab?.userContextId);
}

/**
 * The site's own pop-up permission, if it has one. Read exactly: SitePermissions reports a site
 * without one as blocked, Firefox's default for pop-ups.
 * @param {any} browser
 * @returns {"allow" | "block" | null}
 */
function sitePermission(browser) {
  const principal = browser?.contentPrincipal;
  if (!principal?.isContentPrincipal) return null;
  const action = perms().testExactPermissionFromPrincipal(principal, "popup");
  if (action === perms().ALLOW_ACTION) return "allow";
  return action === perms().DENY_ACTION ? "block" : null;
}

/**
 * Records a block in the site's pop-up permission. SitePermissions cannot: it treats a block as
 * the pop-up default and removes the site's permission instead (SitePermissions.setForPrincipal),
 * which would leave a mistaken `n` nothing to show or undo. So this writes the permission
 * manager as Firefox's own "Allow pop-ups for <site>" does (toggleAllowPopupsForSite), with
 * Firefox's block action; SitePermissions and Page Info read it as Block.
 * @param {any} browser
 */
function blockSite(browser) {
  if (popupLocked()) return;
  perms().addFromPrincipal(browser.contentPrincipal, "popup", perms().DENY_ACTION);
}

/**
 * Allows the site's pop-ups without the bar, as the bar's allow does: the permission, then what
 * was blocked opens. The bar's own path (toggleAllowPopupsForSite) needs the bar to remove.
 * @param {any} browser
 */
function allowSite(browser) {
  if (popupLocked()) return;
  const { SitePermissions } = lazy;
  SitePermissions.setForPrincipal(
    browser.contentPrincipal,
    "popup",
    SitePermissions.ALLOW,
    SitePermissions.SCOPE_PERSISTENT,
    browser,
  );
  const blocker = browser.popupAndRedirectBlocker;
  blocker
    ?.unblockAllPopups()
    .then(() => blocker.unblockFirstRedirect())
    .catch((/** @type {unknown} */ e) => console.error("vimma: pop-ups", e));
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
  const principal = browser.contentPrincipal;
  const [popups, redirect] = await Promise.all([
    blocker.getBlockedPopups(),
    blocker.getBlockedRedirect(),
  ]);
  // The page navigated while Firefox answered: these records are no longer its own.
  if (!browser.contentPrincipal?.equals(principal)) return [];
  listed.set(win, { browser, principal, popups, redirect });
  return popupItems({
    site: siteOf(browser),
    popups: popups.map((/** @type {any} */ p) => p.popupWindowURISpec),
    redirect: redirect?.redirectURISpec ?? null,
    allowLocked: popupLocked(),
    showMessage: Services.prefs.getBoolPref(SHOW_PREF, true),
    permission: sitePermission(browser),
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
 * Runs the row's bar action on the page it was listed for, and nothing once the tab or its page's
 * principal changed (a navigation under the open picker must not land Allow on another site) or
 * in the agent workspace. The observer's methods read only the event's window, so a stand-in
 * event runs them exactly as the bar's menu does.
 * @param {Window} win
 * @param {string} id
 */
export function runPopupRow(win, id) {
  const op = parsePopupId(id);
  const snapshot = listed.get(win);
  listed.delete(win);
  const gBrowser = gBrowserOf(win);
  if (
    !op ||
    !snapshot ||
    snapshot.browser !== gBrowser?.selectedBrowser ||
    !snapshot.browser.contentPrincipal?.equals(snapshot.principal) ||
    inAgentTab(win)
  ) {
    return;
  }
  const observer = lazy.PopupAndRedirectBlockerObserver;
  const event = { originalTarget: { documentGlobal: win } };
  const blocker = snapshot.browser.popupAndRedirectBlocker;
  switch (op.op) {
    case "allow":
      if (popupBar(win)) answerPopupBar(win, "allow");
      else allowSite(snapshot.browser);
      break;
    case "block":
      blockSite(snapshot.browser);
      break;
    case "reset":
      if (popupLocked()) break;
      lazy.SitePermissions.removeFromPrincipal(
        snapshot.browser.contentPrincipal,
        "popup",
        snapshot.browser,
      );
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
 * The selected browser's pop-up blocked bar, or null (each split pane has its own notification
 * box; the focused pane's browser is the selected one).
 * @param {Window} win
 * @returns {any}
 */
export function popupBar(win) {
  const gBrowser = gBrowserOf(win);
  const box = gBrowser?.readNotificationBox?.(gBrowser.selectedBrowser);
  return box?.getNotificationWithValue(BAR) ?? null;
}

/**
 * Answers the selected page's bar as its own controls do. `allow` is the options menu's "Allow
 * pop-ups for <site>", which also opens what was blocked and closes the bar. `block` records the
 * block in the site's permission, then closes the bar. `close` is the bar's close button: no permission changes, and Firefox does not
 * show the bar again for this page. `block` is recorded as the picker's block row records it
 * (blockSite), so `:popups` can undo it.
 * @param {Window} win
 * @param {"allow" | "block" | "close"} kind
 */
export function answerPopupBar(win, kind) {
  const bar = popupBar(win);
  if (!bar || inAgentTab(win)) return;
  if (kind === "allow") {
    lazy.PopupAndRedirectBlockerObserver.toggleAllowPopupsForSite({
      originalTarget: { documentGlobal: win },
    }).catch((/** @type {unknown} */ e) => console.error("vimma: pop-ups", e));
    return;
  }
  if (kind === "block") blockSite(gBrowserOf(win).selectedBrowser);
  bar.dismiss();
}

/**
 * The status bar's cue for the selected page: the bar's, or the way to undo a block.
 * @param {Window} win
 * @param {string | null} hint  the bar's keys line once armed (PromptKeys.popupHint)
 * @returns {string | null}
 */
export function popupStatus(win, hint) {
  return popupCue({
    bar: !!popupBar(win),
    hint,
    siteBlocked: sitePermission(gBrowserOf(win)?.selectedBrowser) === "block",
    agent: inAgentTab(win),
  });
}
