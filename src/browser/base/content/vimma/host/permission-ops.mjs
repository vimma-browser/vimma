/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The site permissions picker (`:site`, docs/specs/site-permissions.md;
// docs/security/19-site-permissions.md §19). It reads and changes the selected tab's site
// permissions through Firefox's SitePermissions, the module behind Page Info's Permissions tab and
// the identity panel, with Page Info's list and Page Info's rules for what is locked; only a pop-up
// block, which SitePermissions cannot store, goes to the permission manager (writePermission). It
// is the only Vimma code that changes a site permission (tools/security chrome-source test): the
// pop-up blocked bar and `:popups` (host/popup-ops.mjs) change the pop-up permission through
// setSitePopups here, so a block from either is the block `:site` shows. Both refuse in the agent
// workspace.

import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { permissionItems, permissionPlan, permissionTitle } from "../core/sitepermissions.mjs";

/** @import { PermissionItem, PermissionOp, PermissionRecord } from "../core/sitepermissions.mjs" */

const lazy = /** @type {Lazy<"SitePermissions">} */ ({});
// types/firefox.d.ts declares only part of Services.
const services = Services;
ChromeUtils.defineESModuleGetters(lazy, {
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

export const AGENT_REFUSAL = "site permissions are not changed in the agent workspace";
export const UNSUPPORTED = "this page has no site permissions";
export const PAGE_CHANGED = "the page changed: run :site again";

/**
 * The page a window's picker was opened for: its browser and that page's principal. Every key
 * checks the tab still shows it (SP2).
 * @type {WeakMap<BrowserWindow, { browser: any, principal: any }>}
 */
const opened = new WeakMap();

/** @param {BrowserWindow} win */
const gBrowserOf = (win) => win.gBrowser;

/**
 * Whether the selected tab, or the page in it, belongs to the agent workspace (SP1).
 * @param {BrowserWindow} win
 */
function inAgentWorkspace(win) {
  const g = gBrowserOf(win);
  const tab = g.selectedTab;
  const principal = g.selectedBrowser?.contentPrincipal;
  return WorkspaceStore.isAgentContainer(tab?.userContextId) || agentPrincipal(principal);
}

/**
 * Whether a principal is in the agent workspace's container.
 * @param {any} principal
 */
const agentPrincipal = (principal) =>
  WorkspaceStore.isAgentContainer(principal?.originAttributes?.userContextId);

/**
 * The pref whose lock makes a permission read only, as Page Info (pageinfo/permissions.js).
 * @param {string} id
 */
function lockedByPref(id) {
  switch (id) {
    case "install":
      return !services.policies.isAllowed("xpinstall");
    case "popup":
      return services.prefs.prefIsLocked("dom.disable_open_during_load");
    case "autoplay-media":
      return services.prefs.prefIsLocked("media.autoplay.default");
    case "cookie":
      return services.prefs.prefIsLocked("network.cookie.cookieBehavior");
    case "geo":
    case "desktop-notification":
    case "camera":
    case "microphone":
    case "xr":
    case "screen":
      return services.prefs.prefIsLocked(`permissions.default.${id}`);
  }
  return false;
}

/**
 * @param {string} id
 * @param {number} state
 */
function stateLabel(id, state) {
  try {
    return lazy.SitePermissions.getMultichoiceStateLabel(id, state) ?? String(state);
  } catch {
    // Firefox throws for a state it has no label for (autoplay's unknown, for one).
    return String(state);
  }
}

/**
 * The real state of every permission Page Info lists, for one page.
 * @param {any} browser
 * @param {any} principal
 * @returns {PermissionRecord[]}
 */
function readRecords(browser, principal) {
  const SP = lazy.SitePermissions;
  /** @type {Record<number | string, PermissionRecord["scope"]>} */
  const scopes = {
    [SP.SCOPE_PERSISTENT]: "persistent",
    [SP.SCOPE_SESSION]: "session",
    [SP.SCOPE_TEMPORARY]: "temporary",
    [SP.SCOPE_POLICY]: "policy",
    [SP.SCOPE_GLOBAL]: "global",
  };
  // Globally blocked permissions (and temporary ones) are only in the browser's list.
  const forBrowser = new Map(SP.getAllForBrowser(browser).map((/** @type {any} */ p) => [p.id, p]));
  return SP.listPermissions()
    .filter(
      (/** @type {string} */ id) => SP.getPermissionLabel(id) && id !== "open-protocol-handler",
    )
    .map((/** @type {string} */ id) => {
      const def = SP.getDefault(id);
      let { state, scope } = SP.getForPrincipal(principal, id, browser);
      const global = forBrowser.get(id);
      if (global?.scope === SP.SCOPE_GLOBAL) ({ state, scope } = global);
      let set = state !== def || scope !== SP.SCOPE_PERSISTENT;
      let label = stateLabel(id, state);
      if (id === "cookie") {
        // Page Info: with no permission for the site, cookies follow Firefox's cookie settings,
        // which no single state describes.
        const own = services.perms.testPermissionFromPrincipal(principal, "cookie");
        set = own !== SP.UNKNOWN;
        if (!set) label = "Firefox's cookie settings";
        else state = own;
      }
      if (id === "popup" && !set) {
        // A stored block reads as the default, Block; only the site's own entry tells them apart.
        set = services.perms.testExactPermissionFromPrincipal(principal, "popup") !== SP.UNKNOWN;
      }
      const s = scopes[scope] ?? "persistent";
      return {
        id,
        label: SP.getPermissionLabel(id),
        state,
        stateLabel: label,
        states: SP.getAvailableStates(id),
        set,
        scope: s,
        locked: s === "policy" || s === "global" || lockedByPref(id),
      };
    });
}

/**
 * The picker's rows for the page it was opened for.
 * @param {BrowserWindow} win
 * @returns {PermissionItem[]}
 */
export function sitePermissionItems(win) {
  const page = opened.get(win);
  return page ? permissionItems(readRecords(page.browser, page.principal)) : [];
}

/**
 * `:site`: records the selected page and returns the picker's heading, or a refusal.
 * @param {BrowserWindow} win
 * @returns {{ title: string } | { refused: string }}
 */
export function openSitePermissions(win) {
  if (inAgentWorkspace(win)) return { refused: AGENT_REFUSAL };
  const browser = gBrowserOf(win).selectedBrowser;
  const principal = browser?.contentPrincipal;
  if (!principal || !lazy.SitePermissions.isSupportedPrincipal(principal)) {
    return { refused: UNSUPPORTED };
  }
  opened.set(win, { browser, principal });
  const site = principal.host || principal.exposablePrePath;
  return { title: permissionTitle({ site, isPrivate: principal.privateBrowsingId > 0 }) };
}

/**
 * A key on a row: applied through SitePermissions when the tab still shows the page the picker
 * was opened for and Firefox allows it. Returns the notice to show, and whether to close.
 * @param {BrowserWindow} win
 * @param {PermissionOp} op
 * @param {string} id
 * @returns {{ notice: string | null, close: boolean }}
 */
export function sitePermissionKey(win, op, id) {
  const page = opened.get(win);
  if (inAgentWorkspace(win)) return { notice: AGENT_REFUSAL, close: true };
  const browser = gBrowserOf(win).selectedBrowser;
  if (!page || browser !== page.browser || !browser.contentPrincipal?.equals(page.principal)) {
    return { notice: PAGE_CHANGED, close: true };
  }
  const record = readRecords(page.browser, page.principal).find((r) => r.id === id);
  if (!record) return { notice: null, close: false };
  const plan = permissionPlan(record, op);
  if (plan.type === "refuse") return { notice: plan.text, close: false };
  writePermission(page.principal, page.browser, id, plan.type === "set" ? plan.state : null);
  return { notice: null, close: false };
}

/**
 * Sets (`state`) or resets (null) one permission for a page, as Page Info does: Firefox stores it
 * for the site (for the session in a private window) and removes the entry when the state is the
 * default; with the browser, a temporary setting for the tab goes too.
 * @param {any} principal
 * @param {any} browser
 * @param {string} id
 * @param {number | null} state
 */
function writePermission(principal, browser, id, state) {
  const SP = lazy.SitePermissions;
  // Firefox's pop-up default is Block (SitePermissions.getDefault) and SitePermissions drops a
  // state equal to the default instead of storing it, so a pop-up block would leave the site
  // nothing to show or for `r` to take back. It is stored in the permission manager instead, as
  // Firefox's own pop-up bar stores its choice (toggleAllowPopupsForSite), which keeps a private
  // principal's for the session only (PermissionManager forces EXPIRE_SESSION).
  const popupBlock = id === "popup" && state === SP.BLOCK;
  if (state !== null && !popupBlock) {
    lazy.SitePermissions.setForPrincipal(principal, id, state, SP.SCOPE_PERSISTENT, browser);
    return;
  }
  lazy.SitePermissions.removeFromPrincipal(principal, id, browser);
  if (popupBlock) services.perms.addFromPrincipal(principal, "popup", services.perms.DENY_ACTION);
}

/**
 * The pop-up blocked bar's and `:popups`' change to a page's pop-up permission
 * (docs/specs/popup-blocked.md), written as `:site` writes it. Nothing changes for a page
 * without site permissions, an agent workspace page, or while a locked
 * `dom.disable_open_during_load` makes the permission read only, as in Page Info.
 * @param {any} browser
 * @param {"allow" | "block" | "reset"} kind
 * @returns {boolean} whether it changed the permission
 */
export function setSitePopups(browser, kind) {
  const principal = browser?.contentPrincipal;
  if (!principal || !lazy.SitePermissions.isSupportedPrincipal(principal)) return false;
  if (agentPrincipal(principal) || lockedByPref("popup")) return false;
  const SP = lazy.SitePermissions;
  writePermission(
    principal,
    browser,
    "popup",
    { allow: SP.ALLOW, block: SP.BLOCK, reset: null }[kind],
  );
  return true;
}

/** @param {BrowserWindow} win */
export function forgetSitePermissions(win) {
  opened.delete(win);
}
