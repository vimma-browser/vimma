/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `[tabs] close_last` (docs/specs/close-last-tab.md): what a user close of a window's last tab
 * does, from the setting and what else is open. The host closes the tab first and then carries
 * out the outcome (decision 3), so every rule here is about what happens after the close.
 */

/** @import { WorkspaceItem } from "../ui/picker.mjs" */
/** @typedef {"picker" | "new_tab" | "ask" | "quit" | "keep"} CloseLast */

/** The values `close_last` takes (behaviour 1), in the order the docs list them. */
export const CLOSE_LAST_VALUES = Object.freeze(
  /** @type {CloseLast[]} */ (["picker", "new_tab", "ask", "quit", "keep"]),
);
/** Decision 2. */
export const CLOSE_LAST_DEFAULT = /** @type {CloseLast} */ ("picker");

/** The notice of a refused close (behaviour 7, decision 8). */
export const KEEP_TEXT = "last tab: not closed";
/** The picker's heading (behaviour 3). */
export const LAST_TAB_TITLE = "last tab closed";
/** The id of the picker's last row, which quits Vimma or closes the window. */
export const CLOSE_LAST_QUIT_ID = "vimma-close-last-quit";

/**
 * What is open besides the closing tab, read before it closes.
 * @typedef {object} CloseLastWindow
 * @property {boolean} inPrivate  the window is the private workspace's
 * @property {number} otherTabs  open tabs of the window's other workspaces, the agent
 *   workspace's included (a normal window)
 * @property {number} otherWorkspaces  how many of the window's other workspaces have tabs
 * @property {number} privateTabs  tabs of the private workspace, 0 when it is closed
 * @property {boolean} lastNormalWindow  no other normal window is open
 * @property {number} otherPrivateTabs  in a private window: other private windows' tabs
 */

/**
 * @typedef {{ kind: "new_tab" } | { kind: "keep" } | { kind: "quit" } | { kind: "close_window" }
 *   | { kind: "close_private" }
 *   | { kind: "picker", quitRow: "quit Vimma" | "close this window", privateQuestion: string | null }
 *   | { kind: "ask", question: string } | { kind: "ask_close_window", question: string }}
 *   CloseLastOutcome  `privateQuestion`: what the picker's `quit Vimma` row asks first, when
 *   private tabs would be discarded (decision 7)
 */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * `14 tabs in 3 other workspaces`.
 * @param {number} tabs
 * @param {number} workspaces
 */
const othersText = (tabs, workspaces) =>
  `${count(tabs, "tab", "tabs")} in ${count(workspaces, "other workspace", "other workspaces")}`;

/**
 * Behaviour 5's question before a quit: the other workspaces' tabs come back, private tabs are
 * discarded; either part is left out when it counts nothing.
 * @param {{ otherTabs: number, otherWorkspaces: number, privateTabs: number }} counts
 */
export function quitQuestion({ otherTabs, otherWorkspaces, privateTabs }) {
  const parts = [];
  if (otherTabs > 0) {
    const verb = otherTabs === 1 ? "comes" : "come";
    parts.push(`${othersText(otherTabs, otherWorkspaces)} ${verb} back at the next start`);
  }
  if (privateTabs > 0) {
    const verb = privateTabs === 1 ? "is" : "are";
    parts.push(`${count(privateTabs, "private tab", "private tabs")} ${verb} discarded`);
  }
  return `quit Vimma? ${parts.join("; ")} y/N`;
}

/**
 * Behaviour 5's question before closing a window that is not the last normal one.
 * @param {{ otherTabs: number, otherWorkspaces: number }} counts
 */
export function closeWindowQuestion({ otherTabs, otherWorkspaces }) {
  const verb = otherTabs === 1 ? "goes" : "go";
  return (
    `close this window? ${othersText(otherTabs, otherWorkspaces)} ${verb} to the recently ` +
    "closed windows y/N"
  );
}

/**
 * What a user close of the last tab of a window does (behaviours 2 to 7 and 11). A value that
 * would quit closes only the window unless it is the last normal one (decision 9); private tabs
 * count as the window's other tabs only in the last normal window, the only one whose close
 * discards them.
 * @param {CloseLast} setting
 * @param {CloseLastWindow} w
 * @returns {CloseLastOutcome}
 */
export function closeLastOutcome(setting, w) {
  if (setting === "keep") return { kind: "keep" };
  if (setting === "new_tab") return { kind: "new_tab" };
  if (w.inPrivate) {
    // Decision 10: the private workspace closes, not Vimma; its other windows keep it open.
    return w.otherPrivateTabs > 0 ? { kind: "close_window" } : { kind: "close_private" };
  }
  const last = w.lastNormalWindow;
  const privateTabs = last ? w.privateTabs : 0;
  const hasOthers = w.otherTabs > 0 || privateTabs > 0;
  const ending = /** @type {CloseLastOutcome} */ (
    last ? { kind: "quit" } : { kind: "close_window" }
  );
  const asked = { otherTabs: w.otherTabs, otherWorkspaces: w.otherWorkspaces, privateTabs };
  switch (setting) {
    case "picker":
      if (!hasOthers) return ending;
      return {
        kind: "picker",
        quitRow: last ? "quit Vimma" : "close this window",
        privateQuestion: privateTabs ? quitQuestion({ ...asked, otherTabs: 0 }) : null,
      };
    case "ask":
      if (!last) {
        return w.otherTabs > 0
          ? { kind: "ask_close_window", question: closeWindowQuestion(asked) }
          : ending;
      }
      return hasOthers ? { kind: "ask", question: quitQuestion(asked) } : ending;
    case "quit":
      // Only private tabs, which cannot come back, are asked about (decision 7).
      return privateTabs ? { kind: "ask", question: quitQuestion(asked) } : ending;
    default:
      // A value the config check let through would otherwise quit: keep today's new tab.
      return { kind: "new_tab" };
  }
}

/**
 * The picker's rows after the last tab closed (behaviour 3, decision 4): the window's other
 * workspaces that have tabs, in workspace order, none marked current; the private row when it
 * is among the window's other tabs; and the row that quits or closes the window.
 * @param {readonly WorkspaceItem[]} items  the window's workspace rows (`prefix+w`'s)
 * @param {{ closedWorkspaceId: string | null, quitRow: string, privateRow?: WorkspaceItem }} o
 * @returns {WorkspaceItem[]}
 */
export function lastTabRows(items, { closedWorkspaceId, quitRow, privateRow }) {
  const rows = items
    .filter((i) => i.workspaceId !== closedWorkspaceId && i.tabCount > 0)
    .map((i) => Object.freeze({ ...i, active: false }));
  if (privateRow) rows.push(Object.freeze({ ...privateRow, active: false }));
  rows.push(
    Object.freeze({
      kind: /** @type {const} */ ("workspace"),
      workspaceId: CLOSE_LAST_QUIT_ID,
      workspaceName: quitRow,
      workspaceIndex: 0,
      tabCount: 0,
      foreignCount: 0,
      display: quitRow,
      active: false,
      // Rendered as the private row is: no index, no count.
      countText: "",
    }),
  );
  return rows;
}
