/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The private workspace (docs/specs/private-workspace.md): Firefox's private window, presented
 * as one more workspace. Pure rules only: where its keys go, its picker row, its questions and
 * refusals. The host owns the windows (host/private-ops.mjs).
 */

/** @import { WorkspaceItem } from "../ui/picker.mjs" */

/**
 * The private workspace's id in the pickers and the side panel. It has a space, so it is never
 * a valid workspace id (`isWorkspaceId`): no workspace, not even one named "private", can be it.
 */
export const PRIVATE_WORKSPACE_ID = "◆ private";

/** What the status bar, the side panel and the picker call it; ◆ carries it without colour. */
export const PRIVATE_NAME = "private";
export const PRIVATE_GLYPH = "◆";
/** The theme token of its colour (decision 6: the theme's magenta). */
export const PRIVATE_COLOR_TOKEN = "--vimma-text-magenta";

/**
 * @typedef {"move-out-of-private" | "permanent-private" | "policy-disabled"} PrivateRefusal
 */

/** @type {Readonly<Record<PrivateRefusal, string>>} */
export const PRIVATE_REFUSALS = Object.freeze({
  "move-out-of-private": "a private tab cannot leave the private workspace",
  "permanent-private": "every window is private (permanent private browsing)",
  "policy-disabled": "private browsing is turned off by policy",
});

/**
 * Where `ctrl+b )` / `ctrl+b (` go from the private workspace (decision 5): the first or the
 * last normal workspace, in the most recent normal window. Cycling leaves private but never
 * enters it. Null without a normal workspace.
 * @param {readonly string[]} order  the normal workspaces' ids, in workspace order
 * @param {"next" | "previous"} dir
 * @returns {string | null}
 */
export function cycleFromPrivate(order, dir) {
  const id = dir === "next" ? order[0] : order[order.length - 1];
  return id ?? null;
}

/**
 * The side panel's neighbours in the private workspace (decision 6): `[ctrl+b ( target,
 * ctrl+b ) target]`, the names of the last and the first normal workspace (cycleFromPrivate).
 * Workspaces in `skip` (the agent workspace, docs/specs/vimma-mcp.md decision 9) are never a
 * cycle's target, so they are never named.
 * @param {readonly { id: string, name: string }[]} workspaces  the normal window's, in order
 * @param {ReadonlySet<string>} [skip]  workspace ids
 * @returns {readonly [string | null, string | null]}
 */
export function privateNeighbours(workspaces, skip = new Set()) {
  const usable = workspaces.filter((w) => !skip.has(w.id));
  const order = usable.map((w) => w.id);
  const name = (/** @type {string | null} */ id) => usable.find((w) => w.id === id)?.name ?? null;
  return Object.freeze([
    name(cycleFromPrivate(order, "previous")),
    name(cycleFromPrivate(order, "next")),
  ]);
}

/**
 * `ctrl+^` (and the toggle) from the private workspace: the workspace left, while it still
 * exists; null to show the normal window as it is.
 * @param {string | null | undefined} left  the workspace active when private was entered
 * @param {readonly string[]} order  the normal window's workspace ids
 * @returns {string | null}
 */
export function privateReturn(left, order) {
  return left && order.includes(left) ? left : null;
}

/**
 * @typedef {{ kind: "open" } | { kind: "focus" } | { kind: "back" }
 *   | { kind: "refuse", text: string }} PrivateToggle
 */

/**
 * What `workspace.private` does (decisions 2 and 3): outside private it goes there, opening it
 * when no private window is open; inside it goes back. Refused when private browsing is off by
 * policy or every window is private already.
 * @param {{ enabled: boolean, permanent: boolean, inPrivate: boolean, open: boolean }} at
 * @returns {PrivateToggle}
 */
export function privateToggle({ enabled, permanent, inPrivate, open }) {
  if (!enabled) return { kind: "refuse", text: PRIVATE_REFUSALS["policy-disabled"] };
  if (permanent) return { kind: "refuse", text: PRIVATE_REFUSALS["permanent-private"] };
  if (inPrivate) return { kind: "back" };
  return open ? { kind: "focus" } : { kind: "open" };
}

/**
 * @typedef {WorkspaceItem & { private: true, countText: string }} PrivateItem
 */

/**
 * The workspace picker's last row (decision 5): `◆ private · 5 tabs`, or `new` while no private
 * window is open. Never a title or a URL (decision 8b).
 * @param {{ tabCount: number, index: number, active: boolean }} row  `index`: its place, after
 *   the normal workspaces
 * @returns {Readonly<PrivateItem>}
 */
export function privateItem({ tabCount, index, active }) {
  const countText = tabCount ? `${tabCount} ${tabCount === 1 ? "tab" : "tabs"}` : "new";
  return Object.freeze({
    kind: /** @type {const} */ ("workspace"),
    private: /** @type {const} */ (true),
    workspaceId: PRIVATE_WORKSPACE_ID,
    workspaceName: PRIVATE_NAME,
    workspaceIndex: index,
    tabCount,
    foreignCount: 0,
    display: `${PRIVATE_GLYPH} ${PRIVATE_NAME}`,
    active,
    countText,
  });
}

/**
 * Closing it (`ctrl+b shift+d`, `:wd` or `:private close` in it; decision 3).
 * @param {number} tabs  in every private window
 */
export function closePrivateQuestion(tabs) {
  const count = `${tabs} tab${tabs === 1 ? "" : "s"}`;
  return (
    `Close the private workspace (${count})? Its history, cookies and site data are ` +
    "discarded. y/N"
  );
}

/** `m` on the private row from a normal window (decision 5): the tab is reopened there. */
export function movePrivateQuestion() {
  return (
    "Reopen this tab in the private workspace? Its back/forward history and form data are " +
    "lost. y/N"
  );
}

/**
 * `:private [close]`.
 * @param {string | undefined} text
 * @returns {{ kind: "toggle" } | { kind: "close" } | { kind: "refuse", text: string }}
 */
export function parsePrivateCommand(text) {
  const word = (text ?? "").trim().toLowerCase();
  if (!word) return { kind: "toggle" };
  if (word === "close") return { kind: "close" };
  return { kind: "refuse", text: ':private takes "close" or nothing' };
}
