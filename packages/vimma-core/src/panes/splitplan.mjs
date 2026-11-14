/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The M4 reconcile planner (spec m3-m4-core-prep): compares one workspace's pane tree with a
 * plain description of Firefox's split group and returns the operations that make the group
 * match the tree. The host (`PaneView.reconcile`) only applies them, in the documented order.
 */

import { leaves } from "./panes.mjs";

/** @import { Panes } from "./panes.mjs" */

/**
 * Firefox's side, as the host reads it. `members`: the tabs of the workspace's
 * `<tab-split-view-wrapper>` in DOM panel order (`[]` without one). `active`: tabs whose
 * `docShellIsActive` is true (only members, leaves and `hidden` tabs are looked at). `hidden`:
 * tabs whose panel carries the visual hiding of zoom (`-moz-subtree-hidden-only-visually`), so
 * the zoomed pane is the member that is not hidden.
 * @typedef {{ members: readonly string[], active: readonly string[],
 *   hidden: readonly string[] }} SplitGroupState
 */
/**
 * `before: null` moves the panel after the last member.
 * @typedef {{ tab: string, before: string | null }} MoveBefore
 */
/**
 * The host applies, in this order: membership (`leave` non-empty: `unsplitTabs()`, then
 * `addTabSplitView` of the remaining members followed by `join`, when they are at least two;
 * otherwise `join` non-empty: `addTabs(join)`, or `addTabSplitView(join)` with no wrapper), the
 * `order` moveBefore sequence (computed for that membership: remaining members in their order,
 * then `join`), `showVisually` / `hideVisually`, then `activate` / `deactivate` (docShellIsActive).
 * Every list is empty when Firefox already matches the tree.
 * @typedef {{ join: string[], leave: string[], order: MoveBefore[], activate: string[],
 *   deactivate: string[], hideVisually: string[], showVisually: string[] }} SplitPlan
 */

export class PlanError extends Error {
  /**
   * @param {"cross-workspace" | "bad-state" | "unknown-workspace"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

/**
 * @param {readonly string[]} list
 * @param {string} what
 */
function checkUnique(list, what) {
  if (new Set(list).size !== list.length) {
    throw new PlanError("bad-state", `${what} lists a tab twice: ${JSON.stringify(list)}`);
  }
}

/**
 * Positions (in `seq`) of a longest increasing subsequence of `seq`.
 * @param {number[]} seq
 * @returns {Set<number>}
 */
function longestIncreasing(seq) {
  /** @type {number[]} */
  const tails = []; // tails[k]: index in seq of the smallest tail of an increasing run of k + 1
  /** @type {number[]} */
  const prev = [];
  seq.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (/** @type {number} */ (seq[/** @type {number} */ (tails[mid])]) < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? /** @type {number} */ (tails[lo - 1]) : -1;
    tails[lo] = i;
  });
  const keep = new Set();
  for (
    let i = tails.length ? /** @type {number} */ (tails.at(-1)) : -1;
    i >= 0;
    i = /** @type {number} */ (prev[i])
  ) {
    keep.add(i);
  }
  return keep;
}

/**
 * The fewest moveBefore steps that turn `from` into `to` (same tabs): every tab outside a longest
 * run already in order moves, right to left, before its successor in `to`.
 * @param {readonly string[]} from
 * @param {readonly string[]} to
 * @returns {MoveBefore[]}
 */
function moves(from, to) {
  const rank = new Map(to.map((t, i) => [t, i]));
  const seq = from.map((t) => /** @type {number} */ (rank.get(t)));
  const kept = new Set([...longestIncreasing(seq)].map((i) => from[i]));
  /** @type {MoveBefore[]} */
  const out = [];
  for (let i = to.length - 1; i >= 0; i--) {
    const tab = /** @type {string} */ (to[i]);
    if (!kept.has(tab)) out.push({ tab, before: to[i + 1] ?? null });
  }
  return out;
}

/**
 * Plans the reconcile of one workspace's split group. Afterwards the wrapper's members are the
 * tree's leaves in reading order (no wrapper for fewer than two), zoomed-away panes are hidden
 * visually and inactive, every other leaf is active, and tabs that left are inactive.
 * Decision 14 (one split = one workspace): a member of another workspace simply leaves, and a
 * tree showing a tab outside `workspace.tabs` throws `PlanError("cross-workspace")`.
 * @param {{ readonly tabs: readonly string[], readonly panes: Panes | null }} workspace
 * @param {SplitGroupState} current
 * @returns {SplitPlan}
 */
export function planSplit(workspace, current) {
  checkUnique(current.members, "members");
  const shown = workspace.panes ? leaves(workspace.panes) : [];
  const tabs = shown.map((l) => l.tab);
  const own = new Set(workspace.tabs);
  const stray = tabs.filter((t) => !own.has(t));
  if (stray.length) {
    throw new PlanError(
      "cross-workspace",
      `panes show tabs of another workspace: ${stray.join(", ")}`,
    );
  }
  const target = tabs.length >= 2 ? tabs : [];
  const zoom = workspace.panes?.zoom;
  const zoomTab = target.length && zoom ? shown.find((l) => l.pane === zoom)?.tab : undefined;
  const hidden = new Set(zoomTab ? target.filter((t) => t !== zoomTab) : []);
  const live = tabs.filter((t) => !hidden.has(t));

  const inTarget = new Set(target);
  const isMember = new Set(current.members);
  const leave = current.members.filter((t) => !inTarget.has(t));
  const join = target.filter((t) => !isMember.has(t));
  let after = current.members;
  if (leave.length || join.length) {
    after = [...current.members.filter((t) => inTarget.has(t)), ...join];
    if (after.length < 2) after = [];
  }

  const isActive = new Set(current.active);
  const isLive = new Set(live);
  const managed = new Set([...current.members, ...tabs, ...current.hidden]);
  const wasHidden = new Set(current.hidden);
  return {
    join,
    leave,
    order: moves(after, target),
    activate: live.filter((t) => !isActive.has(t)),
    deactivate: [...managed].filter((t) => isActive.has(t) && !isLive.has(t)),
    hideVisually: target.filter((t) => hidden.has(t) && !wasHidden.has(t)),
    showVisually: [...wasHidden].filter((t) => !hidden.has(t)),
  };
}
