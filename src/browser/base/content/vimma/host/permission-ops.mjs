/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The site permissions picker (`:site`, docs/specs/site-permissions.md; docs/security.md §19).
// It reads and changes the selected tab's site permissions only through Firefox's
// SitePermissions, the module behind Page Info's Permissions tab and the identity panel, with
// Page Info's list and Page Info's rules for what is locked. It is the only Vimma code that
// changes a site permission (tools/security chrome-source test), and refuses in the agent
// workspace.

import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { permissionItems, permissionPlan, permissionTitle } from "../core/sitepermissions.mjs";

/** @import { PermissionItem, PermissionOp, PermissionRecord } from "../core/sitepermissions.mjs" */

const lazy = /** @type {any} */ ({});
// types/firefox.d.ts declares only part of Services.
const services = /** @type {any} */ (Services);
ChromeUtils.defineESModuleGetters(lazy, {
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

export const AGENT_REFUSAL = "site permissions are not changed in the agent workspace";
export const UNSUPPORTED = "this page has no site permissions";
export const PAGE_CHANGED = "the page changed: run :site again";

/**
 * The page a window's picker was opened for: its browser and that page's principal. Every key
 * checks the tab still shows it (SP2).
 * @type {WeakMap<Window, { browser: any, principal: any }>}
 */
const opened = new WeakMap();

/** @param {Window} win */
const gBrowserOf = (win) => /** @type {any} */ (win).gBrowser;

/**
 * Whether the selected tab, or the page in it, belongs to the agent workspace (SP1).
 * @param {Window} win
 */
function inAgentWorkspace(win) {
  const g = gBrowserOf(win);
  const tab = g.selectedTab;
  const principal = g.selectedBrowser?.contentPrincipal;
  return (
    WorkspaceStore.isAgentContainer(tab?.userContextId) ||
    WorkspaceStore.isAgentContainer(principal?.originAttributes?.userContextId)
  );
}

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
 * @param {Window} win
 * @returns {PermissionItem[]}
 */
export function sitePermissionItems(win) {
  const page = opened.get(win);
  return page ? permissionItems(readRecords(page.browser, page.principal)) : [];
}

/**
 * `:site`: records the selected page and returns the picker's heading, or a refusal.
 * @param {Window} win
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
 * @param {Window} win
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
  if (plan.type === "set") {
    // Page Info's call: Firefox stores it for the site (for the session in a private window)
    // and removes the entry when the state is the default, with the browser a temporary one too.
    const persistent = lazy.SitePermissions.SCOPE_PERSISTENT;
    lazy.SitePermissions.setForPrincipal(page.principal, id, plan.state, persistent, page.browser);
  } else {
    // With the browser, Firefox also drops a temporary setting for this tab.
    lazy.SitePermissions.removeFromPrincipal(page.principal, id, page.browser);
  }
  return { notice: null, close: false };
}

/** @param {Window} win */
export function forgetSitePermissions(win) {
  opened.delete(win);
}
