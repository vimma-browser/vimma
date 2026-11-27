/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `[tabs] close_last` (docs/specs/close-last-tab.md): what a user close of a window's last tab
// does. tab-ops.mjs asks `before` ahead of the close and runs what it returns once the tab has
// closed; core closelast.mjs holds the rules. Only the close keys' runners pass this rule, so a
// page's window.close(), an agent's close, the tab context menu and Firefox's own ctrl+w keep
// Firefox's behaviour (behaviour 12, decision 12).

import {
  CLOSE_LAST_DEFAULT,
  CLOSE_LAST_QUIT_ID,
  KEEP_TEXT,
  closeLastOutcome,
  lastTabRows,
} from "../core/closelast.mjs";
import { privateItem } from "../core/privatews.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { isBrowserWindow } from "./private-swap.mjs";
import {
  PRIVATE_WORKSPACE_ID,
  closePrivate,
  isPrivateWorkspace,
  pickerSelect,
  privateTabCount,
  privateWindows,
} from "./private-ops.mjs";
import { workspacePickerItems } from "./workspace-ops.mjs";

/** @import { CloseLast, CloseLastOutcome, CloseLastWindow } from "../core/closelast.mjs" */
/** @import { WorkspaceItem } from "../core/picker.mjs" */

/**
 * The parts of a window's state the rule shows things with.
 * @typedef {object} LastTabUi
 * @property {BrowserWindow} win
 * @property {{ show(text: string): void }} notice
 * @property {{ ask(question: string, yes: () => void): unknown }} rename  a y/N question
 * @property {{ openLastTab(rows: WorkspaceItem[], choose: (id: string) => void): void }} wsPicker
 */

/**
 * What tab-ops.mjs's removeTab runs around a user close: `before` is null when the tab is not
 * the window's last or the close goes on as Firefox's (a new tab); `keep` refuses the close.
 * @typedef {{ before(tab: MozTabbrowserTab): { keep: true } | { after(): void } | null }}
 *   LastTabRule
 */

/** @type {CloseLast} */
let setting = CLOSE_LAST_DEFAULT;

export const CloseLastTab = {
  /**
   * `[tabs] close_last` of the config just read (behaviour 1: from the next close on).
   * @param {CloseLast} value
   */
  configure(value) {
    setting = value;
  },

  get setting() {
    return setting;
  },
};

/**
 * Firefox's own test (Tabbrowser `#isLastTabInWindow`): no other open tab is shown, so other
 * workspaces' hidden tabs do not count, and a pinned tab does.
 * @param {BrowserWindow} win
 * @param {MozTabbrowserTab} tab
 */
function isLastTabInWindow(win, tab) {
  return !win.gBrowser.tabs.some((t) => t !== tab && !t.closing && !t.hidden);
}

/** @param {BrowserWindow} win */
const openTabs = (win) => win.gBrowser.tabs.filter((t) => !t.closing).length;

/**
 * Tabs of the private workspace's other browser windows. Its pop-ups (a sign-in) do not keep it
 * open: closing the private workspace closes them too (private-ops.mjs, closePrivate).
 * @param {BrowserWindow} win
 */
const otherPrivateTabs = (win) =>
  privateWindows()
    .filter((w) => w !== win)
    .reduce((n, w) => n + openTabs(w), 0);

/**
 * What else is open, read while the closing tab is still open.
 * @param {BrowserWindow} win
 * @returns {CloseLastWindow}
 */
function windowFacts(win) {
  const inPrivate = isPrivateWorkspace(win);
  const model = inPrivate ? null : WindowWorkspaces.get(win)?.model;
  const others = model?.workspaces.filter((w) => w.id !== model.active && w.tabs.length) ?? [];
  let lastNormalWindow = true;
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    const other = /** @type {BrowserWindow} */ (w);
    if (other !== win && isBrowserWindow(other) && !isPrivateWorkspace(other)) {
      lastNormalWindow = false;
    }
  }
  const privateTabs = privateTabCount();
  return {
    inPrivate,
    otherTabs: others.reduce((n, w) => n + w.tabs.length, 0),
    otherWorkspaces: others.length,
    privateTabs: inPrivate ? 0 : privateTabs,
    lastNormalWindow,
    otherPrivateTabs: inPrivate ? otherPrivateTabs(win) : 0,
  };
}

/**
 * Firefox's quit, with a source other than the shortcut so that `browser.warnOnQuitShortcut`
 * asks nothing after Vimma's own question (decision 6); pages that ask before they are left and
 * downloads in progress can still stop it (behaviour 9).
 * @param {BrowserWindow} win
 */
function quit(win) {
  win.goQuitApplication({});
}

/**
 * The window close ctrl+shift+w runs (WindowIsClosing, browser.js), without its warning about
 * closing several tabs (decision 6): the window goes to the recently closed windows, and a page
 * that asks before it is left can keep it open (behaviour 9).
 * @param {BrowserWindow} win
 */
function closeWindow(win) {
  if (!win.closeWindow(false) || !win.CanCloseWindow()) return;
  win.skipNextCanClose = true;
  win.close();
}

/**
 * The private workspace closes as `:private close` closes it, without its question: the tab
 * just closed was its only one (behaviour 11, decision 10).
 * @param {LastTabUi} ui
 */
function closePrivateWorkspace(ui) {
  const refused = closePrivate((_question, yes) => yes());
  if (refused) ui.notice.show(refused);
}

/**
 * Enter on a row of the `last tab closed` picker (behaviour 3).
 * @param {LastTabUi} ui
 * @param {Extract<CloseLastOutcome, { kind: "picker" }>} outcome
 * @param {MozTabbrowserTab} fresh  the new tab Firefox opened in the closed tab's place
 * @param {string} id  the row's
 */
function choose(ui, outcome, fresh, id) {
  const { win } = ui;
  if (id === CLOSE_LAST_QUIT_ID) {
    if (outcome.quitRow !== "quit Vimma") closeWindow(win);
    else if (outcome.privateQuestion) ui.rename.ask(outcome.privateQuestion, () => quit(win));
    else quit(win);
    return;
  }
  // The private workspace is a window of its own: the new tab stays, or this window would be
  // left without a tab.
  if (id === PRIVATE_WORKSPACE_ID) {
    const refused = pickerSelect(win, id);
    if (refused) ui.notice.show(refused);
    return;
  }
  const refused = WindowWorkspaces.get(win)?.switchTo({ id });
  if (refused) {
    ui.notice.show(refused);
    return;
  }
  // The closed tab's workspace is left with no tabs, as any empty workspace.
  if (fresh.isConnected && !fresh.closing && fresh !== win.gBrowser.selectedTab) {
    win.gBrowser.removeTab(fresh);
  }
}

/**
 * The picker's rows: the window's other workspaces with tabs, the private workspace in the last
 * normal window when it has tabs, and the row that quits or closes the window.
 * @param {BrowserWindow} win
 * @param {Extract<CloseLastOutcome, { kind: "picker" }>} outcome
 * @param {string | null} closedWorkspaceId
 */
function pickerRows(win, outcome, closedWorkspaceId) {
  const items = workspacePickerItems(win);
  const privateTabs = outcome.quitRow === "quit Vimma" ? privateTabCount() : 0;
  const privateRow = privateTabs
    ? privateItem({ tabCount: privateTabs, index: items.length + 1, active: false })
    : undefined;
  return lastTabRows(items, {
    closedWorkspaceId,
    quitRow: outcome.quitRow,
    ...(privateRow ? { privateRow } : {}),
  });
}

/**
 * Carries out an outcome once the tab has closed and Firefox's new tab is selected.
 * @param {LastTabUi} ui
 * @param {CloseLastOutcome} outcome
 * @param {string | null} closedWorkspaceId
 */
function after(ui, outcome, closedWorkspaceId) {
  const { win } = ui;
  switch (outcome.kind) {
    case "quit":
      return quit(win);
    case "close_window":
      return closeWindow(win);
    case "close_private":
      return closePrivateWorkspace(ui);
    case "ask":
      // Any answer but y leaves the new tab, as "new_tab" would (behaviour 5).
      return void ui.rename.ask(outcome.question, () => quit(win));
    case "ask_close_window":
      return void ui.rename.ask(outcome.question, () => closeWindow(win));
    case "picker": {
      const fresh = win.gBrowser.selectedTab;
      const rows = pickerRows(win, outcome, closedWorkspaceId);
      return ui.wsPicker.openLastTab(rows, (id) => choose(ui, outcome, fresh, id));
    }
  }
}

/**
 * The rule for one window's user closes (behaviours 2 to 11).
 * @param {LastTabUi} ui
 * @returns {LastTabRule}
 */
export function lastTabRule(ui) {
  return {
    before(tab) {
      const { win } = ui;
      // A pop-up (no toolbar) closes with its last tab, as in Firefox.
      if (!isBrowserWindow(win) || !isLastTabInWindow(win, tab)) return null;
      const outcome = closeLastOutcome(setting, windowFacts(win));
      if (outcome.kind === "keep") {
        ui.notice.show(KEEP_TEXT);
        return { keep: true };
      }
      if (outcome.kind === "new_tab") return null;
      const closedWorkspaceId = WindowWorkspaces.get(win)?.model?.active ?? null;
      return { after: () => after(ui, outcome, closedWorkspaceId) };
    },
  };
}
