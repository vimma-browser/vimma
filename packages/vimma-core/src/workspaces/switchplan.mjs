/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The M3 workspace switch planner (spec m3-m4-core-prep): which tabs the host shows, hides and
 * selects so that a window shows exactly one workspace. Visibility is read from Firefox's
 * current tabs, not from the workspace being left, so a plan also repairs drift (a tab of a third
 * workspace left visible, an extension's `tabs.show`).
 */

import { PlanError } from "../panes/splitplan.mjs";
import { activeWorkspace, findWorkspace } from "./workspaces.mjs";

/** @import { Workspaces, WorkspaceRef } from "./workspaces.mjs" */

/**
 * Firefox's tabs in DOM order, as the host reads them: `hidden` (`tab.hidden`), `pinned`, and
 * `group`, an id for the tab's split-view wrapper (null outside one).
 * @typedef {{ id: string, hidden: boolean, pinned: boolean, group: string | null }} TabInfo
 */
/** @typedef {{ tabs: readonly TabInfo[], selected: string | null }} TabsState */
/**
 * The host applies, in this order: select `select` (`gBrowser.selectedTab`; Firefox will not hide
 * the selected tab, and selecting a hidden tab shows it), `showTab` each of `show`, `hideTab` each
 * of `hide`. `select` is the target's active tab, null for an empty workspace: the host then opens
 * its home tab first (which selects it), registers it with `openTab` and plans again. `hide` holds
 * one tab per split group, because `hideTab` on a member hides the whole wrapper. `unsplit` lists
 * tabs of other workspaces sharing a wrapper with the target's tabs (decision 14 broken outside
 * vimma): they are left visible, for the host to take out of the wrapper.
 * @typedef {{ select: string | null, show: string[], hide: string[], unsplit: string[] }} SwitchPlan
 */

/**
 * Plans showing workspace `to` (default: the model's active one) in a window whose tabs are
 * `tabsState`. Pinned tabs are never hidden (they are out of the model, decision 11) and tabs the
 * model does not know are left alone, unless they share a wrapper that is hidden as a whole.
 * Hiding is planned per split group: a group is hidden only when none of its members belongs
 * to the target, so the target's split stays whole.
 * @param {Workspaces} model
 * @param {WorkspaceRef | undefined} to
 * @param {TabsState} tabsState
 * @returns {SwitchPlan}
 */
export function planWorkspaceSwitch(model, to, tabsState) {
  const target = to === undefined ? activeWorkspace(model) : findWorkspace(model, to);
  if (!target) throw new PlanError("unknown-workspace", `no workspace ${JSON.stringify(to)}`);
  const ids = tabsState.tabs.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    throw new PlanError("bad-state", `tabs list a tab twice: ${JSON.stringify(ids)}`);
  }
  const mine = new Set(target.tabs);
  const known = new Set(model.workspaces.flatMap((w) => w.tabs));
  const selected = target.activeTab ?? tabsState.selected;
  /** @type {Map<string, TabInfo[]>} */
  const groups = new Map();
  for (const t of tabsState.tabs) {
    if (t.group !== null) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  }

  /** @type {string[]} */
  const hide = [];
  /** @type {string[]} */
  const unsplit = [];
  const done = new Set();
  for (const t of tabsState.tabs) {
    if (t.pinned || mine.has(t.id)) continue;
    if (t.group === null) {
      if (known.has(t.id) && !t.hidden) hide.push(t.id);
      continue;
    }
    if (done.has(t.group)) continue;
    done.add(t.group);
    const members = /** @type {TabInfo[]} */ (groups.get(t.group));
    if (members.some((m) => mine.has(m.id))) {
      unsplit.push(...members.filter((m) => known.has(m.id) && !mine.has(m.id)).map((m) => m.id));
      continue;
    }
    if (!members.some((m) => known.has(m.id))) continue;
    const visible = members.filter((m) => !m.hidden && !m.pinned);
    const via = visible.find((m) => m.id !== selected) ?? visible[0];
    if (via) hide.push(via.id);
  }
  return {
    select: target.activeTab,
    show: tabsState.tabs.filter((t) => mine.has(t.id) && t.hidden).map((t) => t.id),
    hide,
    unsplit,
  };
}
