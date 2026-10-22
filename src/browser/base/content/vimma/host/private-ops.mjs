/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The private workspace (docs/specs/private-workspace.md): Firefox's private window, presented
// as one more workspace. Every guarantee is Firefox's, because it is a private window; this
// module finds, opens, focuses and closes those windows, and switches the normal window when
// a key leaves private. Nothing here is written to disk (decision 8a): the workspace left is
// kept in memory only. Core privatews.mjs holds the rules.

import {
  PRIVATE_NAME,
  PRIVATE_REFUSALS,
  PRIVATE_WORKSPACE_ID,
  closePrivateQuestion,
  cycleFromPrivate,
  movePrivateQuestion,
  privateItem,
  privateNeighbours,
  privateReturn,
  privateToggle,
} from "../core/privatews.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { PrivateSwap, startedUp } from "./private-swap.mjs";
import { workspacePickerItems } from "./workspace-ops.mjs";

/** @import { WorkspaceItem } from "../core/picker.mjs" */
/** @import { Workspaces } from "../core/workspaces.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export { PRIVATE_WORKSPACE_ID };

/** `:private close` (or ctrl+b shift+d in it) with no private window open. */
export const NO_PRIVATE = "no private workspace is open";
/** Leaving private with no normal window to go to. */
const NO_NORMAL = "no normal window is open";

/**
 * The window and workspace private was entered from, in memory only (decision 8a): what
 * `ctrl+^` and the toggle go back to.
 * @type {{ win: WeakRef<Window>, workspace: string | null } | null}
 */
let left = null;

/**
 * Any private window, permanent private browsing too: what Vimma's own diagnostics leave out
 * (about:vimma's window modes and key log; decision 8b).
 * @param {Window} win
 */
export function isPrivateBrowsing(win) {
  return lazy.PrivateBrowsingUtils.isWindowPrivate(win);
}
const isPrivate = isPrivateBrowsing;

/**
 * Whether `win` is (part of) the private workspace: a private window, pop-ups included, unless
 * every window is private (`browser.privatebrowsing.autostart`): then there is no private
 * workspace, and private windows behave as before it existed (decision 3).
 * @param {Window} win
 */
export function isPrivateWorkspace(win) {
  return isPrivate(win) && !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing;
}

/** @param {any} w */
const isBrowserWindow = (w) => !w.closed && w.toolbar?.visible !== false;

/**
 * Every open private browser window, most recent first: together, the private workspace
 * (decision 4).
 * @returns {Window[]}
 */
export function privateWindows() {
  return allPrivateWindows().filter(isBrowserWindow);
}

/**
 * Every open private window, pop-ups included, most recent first. A private pop-up (an OAuth
 * sign-in) holds the private cookie jar as much as a browser window: closing the private
 * workspace closes it too, or Firefox would never discard the data.
 * @returns {Window[]}
 */
function allPrivateWindows() {
  return /** @type {any[]} */ (lazy.BrowserWindowTracker.orderedWindows).filter(
    (w) => !w.closed && isPrivateWorkspace(w),
  );
}

/** The most recent normal browser window, or null. */
function normalWindow() {
  const recent = /** @type {Window | null} */ (
    lazy.BrowserWindowTracker.orderedWindows.find(
      (/** @type {any} */ w) => isBrowserWindow(w) && !isPrivate(w),
    ) ?? null
  );
  return recent;
}

/** Tabs in every private window, pop-ups included. */
export function privateTabCount() {
  return allPrivateWindows().reduce(
    (n, w) =>
      n + /** @type {any} */ (w).gBrowser.tabs.filter((/** @type {any} */ t) => !t.closing).length,
    0,
  );
}

/**
 * The status bar's workspace segment in a private window (decision 6).
 * @param {Window} win
 */
export function privateStatus(win) {
  return isPrivateWorkspace(win) ? { name: PRIVATE_NAME, index: 0, private: true } : null;
}

/** @param {Window} win */
function remember(win) {
  if (isPrivateWorkspace(win)) return;
  left = { win: new WeakRef(win), workspace: WindowWorkspaces.get(win)?.model?.active ?? null };
}

/**
 * Shows workspace `id` in normal window `win` (unless it shows it already) and focuses it. On
 * Hyprland a parked window comes back in the private window's slot instead (private-swap):
 * focusing a parked window would open its special workspace.
 * @param {Window} win
 * @param {string | null} id
 * @returns {string | null} a refusal
 */
function showNormal(win, id) {
  const ww = WindowWorkspaces.get(win);
  /** @type {string | null} */
  let refused = null;
  if (id && ww?.model && ww.model.active !== id) refused = ww.switchTo({ id });
  if (!PrivateSwap.show(win)) win.focus();
  return refused;
}

/**
 * Opens the private workspace: a private window at the current window's size and, where the
 * platform lets a client place its windows (not Wayland), its position (decision 7).
 * @param {Window} from
 * @returns {Window}
 */
function openPrivate(from) {
  remember(from);
  const f = /** @type {any} */ (from);
  const size = [`outerWidth=${f.outerWidth}`, `outerHeight=${f.outerHeight}`];
  const wayland = !!(/** @type {any} */ (Services.appinfo).isWayland);
  if (!wayland) size.push(`screenX=${f.screenX}`, `screenY=${f.screenY}`);
  // Its first tab is Vimma's start page, as a new tab there is (start-page spec), not
  // Firefox's about:privatebrowsing, which OpenBrowserWindow loads without `args`.
  const args = /** @type {any} */ (Cc["@mozilla.org/supports-string;1"]).createInstance(
    Ci.nsISupportsString,
  );
  args.data = f.BROWSER_NEW_TAB_URL;
  // On macOS the swap opens it at the exact (restored) frame, without animation.
  const features = PrivateSwap.openFeatures(from) ?? size.join(",");
  return f.OpenBrowserWindow({ private: true, features, args });
}

/**
 * Going to the private workspace from a normal window: the most recent private window, or a
 * new one. On Hyprland it takes `from`'s place (private-swap); elsewhere it is focused.
 * @param {Window} from
 */
function enterPrivate(from) {
  const [existing] = privateWindows();
  const priv = existing ?? openPrivate(from);
  if (existing) remember(from);
  if (!PrivateSwap.enter(from, priv, !existing) && existing) priv.focus();
  return priv;
}

/** What `workspace.private` and the pickers check first. */
function refusal() {
  const t = privateToggle({
    enabled: lazy.PrivateBrowsingUtils.enabled,
    permanent: lazy.PrivateBrowsingUtils.permanentPrivateBrowsing,
    inPrivate: false,
    open: false,
  });
  return t.kind === "refuse" ? t.text : null;
}

/**
 * `ctrl+^` from private, and the toggle in it: the workspace left, in the window left, else
 * the most recent normal window as it is.
 * @returns {string | null} a refusal
 */
export function leavePrivate() {
  const before = left?.win.deref();
  const win = before && isBrowserWindow(before) ? before : normalWindow();
  if (!win) return NO_NORMAL;
  const order = WindowWorkspaces.get(win)?.model?.workspaces.map((w) => w.id) ?? [];
  const id = win === before ? privateReturn(left?.workspace, order) : null;
  return showNormal(win, id);
}

/**
 * `workspace.private` (ctrl+b shift+p, ctrl+shift+p, `:private`): toggles (decision 2).
 * @param {Window} win
 * @returns {string | null} a refusal
 */
export function togglePrivate(win) {
  const t = privateToggle({
    enabled: lazy.PrivateBrowsingUtils.enabled,
    permanent: lazy.PrivateBrowsingUtils.permanentPrivateBrowsing,
    inPrivate: isPrivateWorkspace(win),
    open: privateWindows().length > 0,
  });
  switch (t.kind) {
    case "refuse":
      return t.text;
    case "back":
      return leavePrivate();
    default:
      enterPrivate(win);
      return null;
  }
}

/**
 * `ctrl+b )` / `ctrl+b (` (and `]w`, `[w`, `:wn`, `:wp`) in private: the first or the last
 * normal workspace, in the most recent normal window (decision 5).
 * @param {"next" | "previous"} dir
 * @returns {string | null} a refusal
 */
export function cycleOutOfPrivate(dir) {
  const win = normalWindow();
  if (!win) return NO_NORMAL;
  // The agent workspace is never a cycle's target (docs/specs/vimma-mcp.md, decision 9).
  const agent = WorkspaceStore.agent?.id;
  const order = (WindowWorkspaces.get(win)?.model?.workspaces ?? [])
    .map((w) => w.id)
    .filter((id) => id !== agent);
  return showNormal(win, cycleFromPrivate(order, dir));
}

/**
 * `:workspace name` in private: that workspace of the most recent normal window.
 * @param {(model: Workspaces) => string | null} pick  the workspace's id, or null for none
 * @param {string} text  as typed, for the refusal
 * @returns {string | null}
 */
export function switchFromPrivate(pick, text) {
  const win = normalWindow();
  if (!win) return NO_NORMAL;
  const model = WindowWorkspaces.get(win)?.model;
  const id = model ? pick(model) : null;
  if (model && !id) return `no workspace "${text}"`;
  return showNormal(win, id);
}

/**
 * Closing the private workspace (decision 3): asks with every private window's tab count, then
 * closes them all; Firefox discards the data when the last private context goes.
 * @param {(question: string, yes: () => void) => void} ask
 * @returns {string | null} a refusal
 */
export function closePrivate(ask) {
  // Permanent private browsing: closing "it" would close every window and quit.
  const refused = refusal();
  if (refused) return refused;
  if (!allPrivateWindows().length) return NO_PRIVATE;
  ask(closePrivateQuestion(privateTabCount()), () => {
    // On Hyprland the parked normal window is shown in the slot first (private-swap decision 7).
    // As a script closes a window, without Firefox's own warnings: the y/N was the question.
    PrivateSwap.beforeClose().then(() => {
      for (const w of allPrivateWindows()) w.close();
    });
  });
  return null;
}

/**
 * The workspace picker's rows (decision 5): the normal workspaces, then the private row. In a
 * private window the normal rows are the most recent normal window's.
 * @param {Window} win
 * @returns {WorkspaceItem[]}
 */
export function pickerItemsWithPrivate(win) {
  const inPrivate = isPrivateWorkspace(win);
  const from = inPrivate ? normalWindow() : win;
  const normal = from ? normalItems(from, inPrivate) : [];
  return [
    ...normal,
    privateItem({ tabCount: privateTabCount(), index: normal.length + 1, active: inPrivate }),
  ];
}

/**
 * @param {Window} win  a normal window
 * @param {boolean} inPrivate  seen from private: no row is the current one
 */
function normalItems(win, inPrivate) {
  const items = workspacePickerItems(win);
  return inPrivate ? items.map((i) => Object.freeze({ ...i, active: false })) : items;
}

/**
 * Enter on a picker row: the private row goes there, a normal row from private switches the
 * most recent normal window.
 * @param {Window} win
 * @param {string} id
 * @returns {string | null | undefined} a refusal; undefined when the row is a normal one seen
 *   from a normal window (the caller switches)
 */
export function pickerSelect(win, id) {
  if (id === PRIVATE_WORKSPACE_ID) {
    if (isPrivateWorkspace(win)) return null;
    const refused = refusal();
    if (refused) return refused;
    enterPrivate(win);
    return null;
  }
  if (!isPrivateWorkspace(win)) return undefined;
  return switchFromPrivate((model) => (model.workspaces.some((w) => w.id === id) ? id : null), id);
}

/**
 * `m` on a picker row. From private every move is refused (decision 5). From a normal window
 * to the private row: after y/N, the tab's URL is reopened in the private workspace and the tab
 * closed (Firefox's "Open Link in New Private Window", as a move).
 * @param {Window} win
 * @param {string} id
 * @param {(question: string, yes: () => void) => void} ask
 * @param {(text: string) => void} say
 * @param {any} [row]  a side-panel row's tab instead of the selected one (moveTabFromPicker)
 * @returns {string | null | undefined} a refusal; undefined for a normal move (the caller's)
 */
export function pickerMove(win, id, ask, say, row) {
  if (isPrivateWorkspace(win)) {
    return id === PRIVATE_WORKSPACE_ID
      ? `already in "${PRIVATE_NAME}"`
      : PRIVATE_REFUSALS["move-out-of-private"];
  }
  if (id !== PRIVATE_WORKSPACE_ID) return undefined;
  const refused = refusal();
  if (refused) return refused;
  const gBrowser = /** @type {any} */ (win).gBrowser;
  const tab = row ?? gBrowser.selectedTab;
  ask(movePrivateQuestion(), () => {
    if (!tab.isConnected || (!row && gBrowser.selectedTab !== tab)) {
      say("move: the tab changed since you were asked; nothing was moved");
      return;
    }
    moveIntoPrivate(win, tab).then(
      (said) => said && say(said),
      (e) => say(`move: ${e?.message ?? e}`),
    );
  });
  return null;
}

/** `:wsmove` in private (decision 5). */
export const MOVE_OUT_REFUSED = PRIVATE_REFUSALS["move-out-of-private"];

/**
 * Reopens `tab`'s page in the private workspace, selected, and closes it here. The principal
 * is the page's own with the private origin attributes (tab-context-menu.js reopenInContainer
 * does the same for a container), so nothing loads with more rights than the page had.
 * @param {Window} win
 * @param {any} tab
 * @returns {Promise<string | null>} a refusal
 */
async function moveIntoPrivate(win, tab) {
  const ssm = /** @type {any} */ (Services.scriptSecurityManager);
  const browser = tab.linkedBrowser;
  const url = browser.currentURI.spec;
  const page = browser.contentPrincipal;
  if (!page) return "this tab's page cannot be reopened";
  const attrs = { privateBrowsingId: 1, userContextId: 0 };
  const principal = page.isContentPrincipal
    ? ssm.principalWithOA(page, attrs)
    : page.isNullPrincipal
      ? ssm.createNullPrincipal(attrs)
      : page;
  const [existing] = privateWindows();
  const priv = /** @type {any} */ (existing ?? openPrivate(win));
  if (!existing) await startedUp(priv);
  if (priv.closed) return "the private workspace closed meanwhile";
  const fresh = priv.gBrowser.addTab(url, { triggeringPrincipal: principal, skipAnimation: true });
  priv.gBrowser.selectedTab = fresh;
  if (!existing) {
    // The new window's own first tab (the start page) gives way to the moved one.
    for (const t of priv.gBrowser.tabs) if (t !== fresh) priv.gBrowser.removeTab(t);
  }
  remember(win);
  const gBrowser = /** @type {any} */ (win).gBrowser;
  // The workspace keeps a tab: a start page, as a workspace left empty gets (WindowWorkspaces).
  // Before the swap: a new tab in a parked window brings it back (private-swap decision 7).
  const others = gBrowser.visibleTabs.filter((/** @type {any} */ t) => t !== tab && !t.pinned);
  if (!others.length) {
    gBrowser.addTrustedTab(/** @type {any} */ (win).BROWSER_NEW_TAB_URL, {
      userContextId: tab.userContextId,
      skipAnimation: true,
    });
  }
  if (tab.isConnected) gBrowser.removeTab(tab, { animate: false });
  if (!PrivateSwap.enter(win, priv, !existing)) priv.focus();
  return null;
}

/**
 * The side panel's model in a private window (decision 6): its tabs, under the private
 * workspace's id and name, and the `ctrl+b (` / `ctrl+b )` targets as its neighbours.
 * @param {Workspaces} model  the window's tabs as one workspace (goto.mjs pickerWorkspaces)
 */
export function privatePanel(model) {
  const [w] = model.workspaces;
  const workspace = { .../** @type {any} */ (w), id: PRIVATE_WORKSPACE_ID, name: PRIVATE_NAME };
  const normal = normalWindow();
  const ww = normal ? WindowWorkspaces.get(normal) : undefined;
  // Past the agent workspace, as cycleOutOfPrivate goes (docs/specs/vimma-mcp.md, decision 9).
  const neighbours = privateNeighbours(ww?.model?.workspaces ?? [], ww?.cycleSkip);
  return {
    model: { ...model, workspaces: [workspace], active: PRIVATE_WORKSPACE_ID },
    options: { private: true, neighbours },
  };
}
