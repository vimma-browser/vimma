/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The workspace model (spec m3-m4-core-models). Each workspace maps to a Firefox container
 * (`container` is opaque here), owns an ordered list of tab ids and a pane layout. The host applies
 * the result: shows the active workspace's tabs, hides the others, mirrors the layout.
 * Every operation is pure; a no-op returns the input state itself.
 */

import {
  closePane,
  createPanes,
  focusPane,
  leaves,
  paneOfTab,
  setPaneTab,
  split,
} from "../panes/panes.mjs";
import { removeSplitTab, splitsFromPanes } from "../panes/splits.mjs";

/** @import { Panes } from "../panes/panes.mjs" */
/** @import { SplitDirection, SplitOptions } from "../panes/panes.mjs" */
/** @import { Leaf } from "../panes/panes.mjs" */
/** @import { NumberedSplit, Splits } from "../panes/splits.mjs" */
/**
 * `splits`, `shown` and `last` (docs/specs/multiple-splits.md decision 1, `Splits`) are the
 * workspace's splits once its host keeps several; without them, `panes` is the workspace's one
 * tree, read as splits by `splitsOf`. `panes` stays the view as before, which an older snapshot
 * reader understands (decision 15).
 * @typedef {{ readonly id: string, readonly name: string, readonly container: string,
 *   readonly tabs: readonly string[], readonly activeTab: string | null,
 *   readonly panes: Panes | null, readonly splits?: readonly NumberedSplit[],
 *   readonly shown?: number | null, readonly last?: number | null }} WorkspaceState
 */
/**
 * `next` mints workspace ids (`w<next>`). A workspace's index is its 1-based position.
 * `alternate`, when present, is the workspace that was active before `active` (Vim's alternate
 * buffer, `ctrl+^`): always another workspace of the list, never `active` itself.
 * @typedef {{ readonly workspaces: readonly WorkspaceState[], readonly active: string,
 *   readonly next: number, readonly alternate?: string }} Workspaces
 */
/** @typedef {{ id: string } | { index: number } | { name: string }} WorkspaceRef */
/**
 * `id` is optional: the M3 host passes the global id from its definitions file so that ids agree
 * across windows; without one the model mints `w<next>`.
 * @typedef {{ name: string, container: string, id?: string }} WorkspaceDef
 */

/** Longest explicit workspace id, in UTF-16 code units (a `ws-<uuid>` is 39). */
export const MAX_WORKSPACE_ID = 128;

/**
 * A valid workspace id: a string of 1 to MAX_WORKSPACE_ID characters without whitespace or
 * control characters. Minted ids (`w<n>`) are valid ids.
 * @param {unknown} id
 * @returns {id is string}
 */
export function isWorkspaceId(id) {
  return typeof id === "string" && id.length <= MAX_WORKSPACE_ID && /^[^\s\p{Cc}]+$/u.test(id);
}

export class WorkspaceError extends Error {
  /**
   * @param {"unknown-workspace" | "duplicate-name" | "empty-name" | "duplicate-container" |
   *   "empty-container" | "unknown-tab" | "duplicate-tab" | "last-workspace" | "no-tab" |
   *   "bad-id" | "duplicate-id"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/**
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @returns {number} array position, or -1
 */
function indexOf(s, ref) {
  if ("id" in ref) return s.workspaces.findIndex((w) => w.id === ref.id);
  if ("name" in ref) return s.workspaces.findIndex((w) => w.name === ref.name);
  return Number.isInteger(ref.index) && ref.index >= 1 && ref.index <= s.workspaces.length
    ? ref.index - 1
    : -1;
}

/**
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @returns {number}
 */
function mustIndex(s, ref) {
  const i = indexOf(s, ref);
  if (i < 0) throw new WorkspaceError("unknown-workspace", `no workspace ${JSON.stringify(ref)}`);
  return i;
}

/**
 * @param {Workspaces} s
 * @param {string} tabId
 * @returns {number}
 */
function indexOfTab(s, tabId) {
  const i = s.workspaces.findIndex((w) => w.tabs.includes(tabId));
  if (i < 0) throw new WorkspaceError("unknown-tab", `no tab "${tabId}"`);
  return i;
}

/** @param {Workspaces} s */
function activeIndex(s) {
  return s.workspaces.findIndex((w) => w.id === s.active);
}

/**
 * @param {WorkspaceState} w
 * @param {Partial<WorkspaceState>} changes
 * @returns {WorkspaceState}
 */
function updateWs(w, changes) {
  const next = { ...w, ...changes };
  return Object.freeze({ ...next, tabs: Object.freeze(next.tabs.slice()) });
}

/**
 * A copy of `s` without its `alternate`.
 * @template {{ alternate?: string }} T
 * @param {T} s
 * @returns {Omit<T, "alternate">}
 */
function withoutAlternate(s) {
  const copy = { ...s };
  delete copy.alternate;
  return copy;
}

/**
 * A change of `active` remembers the workspace left (if it is still there) as the alternate; an
 * alternate that is gone or has become active is dropped.
 * @param {Workspaces} s
 * @param {{ workspaces?: readonly WorkspaceState[], active?: string, next?: number }} changes
 * @returns {Workspaces}
 */
function updateState(s, changes) {
  const next = withoutAlternate({ ...s, ...changes });
  const left = next.active !== s.active && next.workspaces.some((w) => w.id === s.active);
  const alternate = left ? s.active : s.alternate;
  const keep =
    alternate !== undefined &&
    alternate !== next.active &&
    next.workspaces.some((w) => w.id === alternate);
  return Object.freeze({
    ...next,
    workspaces: Object.freeze(next.workspaces.slice()),
    ...(keep ? { alternate } : {}),
  });
}

/**
 * @param {Workspaces} s
 * @param {number} i
 * @param {WorkspaceState} w
 * @param {{ active?: string }} [extra]
 * @returns {Workspaces}
 */
function replaceWs(s, i, w, extra = {}) {
  const workspaces = s.workspaces.slice();
  workspaces[i] = w;
  return updateState(s, { workspaces, ...extra });
}

/**
 * @param {Workspaces} s
 * @param {string} name
 * @param {string | null} self id of the workspace being renamed
 */
function checkName(s, name, self) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new WorkspaceError("empty-name", "workspace name is empty");
  if (s.workspaces.some((w) => w.name === trimmed && w.id !== self)) {
    throw new WorkspaceError("duplicate-name", `workspace "${trimmed}" already exists`);
  }
  return trimmed;
}

/**
 * @param {Workspaces} s
 * @param {string} tabId
 * @param {string} [except]
 */
function checkNewTab(s, tabId, except) {
  if (tabId !== except && s.workspaces.some((w) => w.tabs.includes(tabId))) {
    throw new WorkspaceError("duplicate-tab", `tab "${tabId}" is already open`);
  }
}

/**
 * Makes `tabId` (already in `w.tabs`) the active tab: focus its pane, or show it in the focused one.
 * @param {WorkspaceState} w
 * @param {string} tabId
 * @returns {WorkspaceState}
 */
function showTab(w, tabId) {
  const panes = /** @type {Panes} */ (w.panes);
  const shownIn = paneOfTab(panes, tabId);
  const next = shownIn ? focusPane(panes, shownIn) : setPaneTab(panes, panes.focus, tabId);
  return next === panes && w.activeTab === tabId
    ? w
    : updateWs(w, { panes: next, activeTab: tabId });
}

/**
 * Workspaces in `[workspaces]` order; the first is active.
 * @param {WorkspaceDef[]} defs
 * @returns {Workspaces}
 */
export function createWorkspaces(defs) {
  if (!defs.length) throw new WorkspaceError("last-workspace", "need at least one workspace");
  /** @type {Workspaces} */
  let s = Object.freeze({ workspaces: Object.freeze([]), active: "", next: 1 });
  defs.forEach((d, i) => {
    s = addWorkspace(s, d, { activate: i === 0 });
  });
  return s;
}

/**
 * @param {Workspaces} s
 * @returns {WorkspaceState}
 */
export function activeWorkspace(s) {
  return /** @type {WorkspaceState} */ (s.workspaces[activeIndex(s)]);
}

/**
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @returns {WorkspaceState | undefined}
 */
export function findWorkspace(s, ref) {
  return s.workspaces[indexOf(s, ref)];
}

/**
 * A workspace's splits: its own list, or its one tree read as split 1 (`splitsFromPanes`).
 * @param {WorkspaceState} w
 * @returns {Splits}
 */
export function splitsOf(w) {
  if (w.splits === undefined) return splitsFromPanes(w.panes);
  return Object.freeze({ splits: w.splits, shown: w.shown ?? null, last: w.last ?? null });
}

/**
 * @param {Workspaces} s
 * @param {string} tabId
 * @returns {WorkspaceState | undefined}
 */
export function workspaceOfTab(s, tabId) {
  return s.workspaces.find((w) => w.tabs.includes(tabId));
}

/**
 * Appends a workspace, with `def.id` when given (`bad-id`, `duplicate-id`); with `before`, the
 * id of a workspace, just ahead of that one (the agent workspace sorts last, vimma-mcp 9).
 * @param {Workspaces} s
 * @param {WorkspaceDef} def
 * @param {{ activate?: boolean, before?: string }} [options]
 * @returns {Workspaces}
 */
export function addWorkspace(s, def, { activate = true, before } = {}) {
  const name = checkName(s, def.name, null);
  if (typeof def.container !== "string" || !def.container) {
    throw new WorkspaceError("empty-container", `workspace "${name}" needs a container`);
  }
  if (s.workspaces.some((w) => w.container === def.container)) {
    throw new WorkspaceError("duplicate-container", `container "${def.container}" is in use`);
  }
  let id = `w${s.next}`;
  let next = s.next + 1;
  if (def.id !== undefined) {
    if (!isWorkspaceId(def.id)) {
      throw new WorkspaceError("bad-id", `bad workspace id ${JSON.stringify(def.id)}`);
    }
    if (s.workspaces.some((w) => w.id === def.id)) {
      throw new WorkspaceError("duplicate-id", `workspace id "${def.id}" is in use`);
    }
    id = def.id;
    // Minted ids must never collide with an explicit one shaped like them (snapshot `next` rule).
    const minted = /^w(\d+)$/.exec(id);
    next = minted ? Math.max(s.next, Number(minted[1]) + 1) : s.next;
  }
  const w = updateWs(
    { id, name, container: def.container, tabs: [], activeTab: null, panes: null },
    {},
  );
  const workspaces = [...s.workspaces];
  const at = before === undefined ? -1 : workspaces.findIndex((x) => x.id === before);
  workspaces.splice(at < 0 ? workspaces.length : at, 0, w);
  return updateState(s, {
    workspaces,
    active: activate ? id : s.active,
    next,
  });
}

/**
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @param {string} name
 * @returns {Workspaces}
 */
export function renameWorkspace(s, ref, name) {
  const i = mustIndex(s, ref);
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  const trimmed = checkName(s, name, w.id);
  return trimmed === w.name ? s : replaceWs(s, i, updateWs(w, { name: trimmed }));
}

/**
 * Gives a workspace another container (its own was deleted outside Vimma and replaced); its
 * tabs, selection and panes stay. `duplicate-container`, `empty-container`.
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @param {string} container
 * @returns {Workspaces}
 */
export function setWorkspaceContainer(s, ref, container) {
  const i = mustIndex(s, ref);
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  if (typeof container !== "string" || !container) {
    throw new WorkspaceError("empty-container", `workspace "${w.name}" needs a container`);
  }
  if (container === w.container) return s;
  if (s.workspaces.some((o) => o.container === container)) {
    throw new WorkspaceError("duplicate-container", `container "${container}" is in use`);
  }
  return replaceWs(s, i, updateWs(w, { container }));
}

/**
 * What the user typed as a workspace (`:workspace 2`, `:wsmove 2`): a workspace of exactly that
 * name first (config.toml accepts names of digits), else digits are a place in workspace order,
 * else a name. Without a model, digits are a place.
 * @param {Workspaces | null | undefined} s
 * @param {string} text
 * @returns {WorkspaceRef}
 */
export function workspaceRefFor(s, text) {
  if (s?.workspaces.some((w) => w.name === text)) return { name: text };
  return /^\d+$/.test(text) ? { index: Number(text) } : { name: text };
}

/**
 * Deletes a workspace; its tabs are returned for the host to close (Herdr `close_workspace`).
 * The previous workspace (the next, if it was first) becomes active if this one was.
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @returns {{ state: Workspaces, closedTabs: string[] }}
 */
export function deleteWorkspace(s, ref) {
  const i = mustIndex(s, ref);
  if (s.workspaces.length === 1) {
    throw new WorkspaceError("last-workspace", "cannot delete the last workspace");
  }
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  const workspaces = s.workspaces.filter((_, k) => k !== i);
  const active =
    s.active === w.id
      ? /** @type {WorkspaceState} */ (workspaces[Math.max(0, i - 1)]).id
      : s.active;
  return { state: updateState(s, { workspaces, active }), closedTabs: w.tabs.slice() };
}

/**
 * @param {Workspaces} s
 * @param {WorkspaceRef} ref
 * @returns {Workspaces}
 */
export function switchWorkspace(s, ref) {
  const w = /** @type {WorkspaceState} */ (s.workspaces[mustIndex(s, ref)]);
  return w.id === s.active ? s : updateState(s, { active: w.id });
}

/** @type {ReadonlySet<string>} */
const NONE = new Set();

/**
 * The alternate workspace: the one active before this one (Vim's `#`), or undefined. One in
 * `skip` (the agent workspace, docs/specs/vimma-mcp.md decision 9) is never the alternate of a
 * workspace outside it; from inside it, the alternate is where you came from.
 * @param {Workspaces} s
 * @param {ReadonlySet<string>} [skip]  workspace ids
 * @returns {WorkspaceState | undefined}
 */
export function alternateWorkspace(s, skip = NONE) {
  if (s.alternate === undefined) return undefined;
  if (skip.has(s.alternate) && !skip.has(s.active)) return undefined;
  return findWorkspace(s, { id: s.alternate });
}

/**
 * `ctrl+^` / `ctrl+b ^`: back to the alternate workspace, which makes the one left the
 * alternate, so a second press toggles back. Without an alternate, the input itself.
 * @param {Workspaces} s
 * @param {ReadonlySet<string>} [skip]  workspace ids (alternateWorkspace)
 * @returns {Workspaces}
 */
export function lastWorkspace(s, skip = NONE) {
  const w = alternateWorkspace(s, skip);
  return w ? switchWorkspace(s, { id: w.id }) : s;
}

/**
 * After a switch (`prev` to `next`) out of a workspace in `skip`, the alternate is the one
 * before it, not the skipped one: the `ctrl+^` of another workspace never lands in the agent
 * workspace (vimma-mcp decision 9). Any other switch returns `next` itself.
 * @param {Workspaces} prev
 * @param {Workspaces} next
 * @param {ReadonlySet<string>} skip  workspace ids
 * @returns {Workspaces}
 */
export function leaveSkipped(prev, next, skip) {
  if (next.active === prev.active || !skip.has(prev.active) || skip.has(next.active)) return next;
  if (next.alternate !== prev.active) return next;
  return setAlternate(next, prev.alternate);
}

/**
 * Sets the alternate workspace (a restore): `id` when it names a workspace other than the
 * active one, else none. The input itself when nothing changes.
 * @param {Workspaces} s
 * @param {string | undefined} id
 * @returns {Workspaces}
 */
export function setAlternate(s, id) {
  const usable = id !== undefined && id !== s.active && s.workspaces.some((w) => w.id === id);
  const alternate = usable ? id : undefined;
  if (alternate === s.alternate) return s;
  const rest = withoutAlternate(s);
  return Object.freeze(alternate === undefined ? rest : { ...rest, alternate });
}

/**
 * The next workspace `step` away that is not in `skip`; none (only skipped ones besides the
 * active one): the input itself.
 * @param {Workspaces} s
 * @param {number} step
 * @param {ReadonlySet<string>} skip
 */
function cycle(s, step, skip) {
  const n = s.workspaces.length;
  const from = activeIndex(s);
  for (let k = 1; k < n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
    if (!skip.has(w.id)) return switchWorkspace(s, { id: w.id });
  }
  return s;
}

/**
 * `ctrl+b )`; wraps around, past the workspaces in `skip` (vimma-mcp decision 9).
 * @param {Workspaces} s
 * @param {ReadonlySet<string>} [skip]  workspace ids
 * @returns {Workspaces}
 */
export function nextWorkspace(s, skip = NONE) {
  return cycle(s, 1, skip);
}

/**
 * `ctrl+b (`; wraps around, past the workspaces in `skip`.
 * @param {Workspaces} s
 * @param {ReadonlySet<string>} [skip]  workspace ids
 * @returns {Workspaces}
 */
export function previousWorkspace(s, skip = NONE) {
  return cycle(s, -1, skip);
}

/**
 * Opens a tab into a workspace (default: the active one), after `after` or at the end. `activate`
 * makes it that workspace's active tab, shown in its focused pane; it never switches workspace.
 * The first tab of an empty workspace is always active.
 * @param {Workspaces} s
 * @param {string} tabId
 * @param {{ workspace?: WorkspaceRef, after?: string, activate?: boolean }} [options]
 * @returns {Workspaces}
 */
export function openTab(s, tabId, { workspace, after, activate = true } = {}) {
  checkNewTab(s, tabId);
  const i = workspace ? mustIndex(s, workspace) : activeIndex(s);
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  const tabs = w.tabs.slice();
  if (after === undefined) tabs.push(tabId);
  else {
    const k = tabs.indexOf(after);
    if (k < 0) throw new WorkspaceError("unknown-tab", `no tab "${after}" in "${w.name}"`);
    tabs.splice(k + 1, 0, tabId);
  }
  let next = updateWs(w, { tabs });
  if (!w.panes) next = updateWs(next, { panes: createPanes(tabId), activeTab: tabId });
  else if (activate) next = showTab(next, tabId);
  return replaceWs(s, i, next);
}

/**
 * Closes a tab. The active tab passes to its right neighbour, else its left (Firefox). A pane that
 * showed the tab shows the new active tab (focused pane) or a hidden tab, else it is closed.
 * @param {Workspaces} s
 * @param {string} tabId
 * @returns {Workspaces}
 */
export function closeTab(s, tabId) {
  const i = indexOfTab(s, tabId);
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  const at = w.tabs.indexOf(tabId);
  const tabs = w.tabs.filter((t) => t !== tabId);
  // A split never names a closed tab (docs/specs/multiple-splits.md decision 2).
  const kept = w.splits === undefined ? {} : removeSplitTab(splitsOf(w), tabId);
  if (!tabs.length) {
    return replaceWs(s, i, updateWs(w, { ...kept, tabs, activeTab: null, panes: null }));
  }
  let panes = /** @type {Panes} */ (w.panes);
  let activeTab = /** @type {string} */ (w.activeTab);
  const pane = paneOfTab(panes, tabId);
  if (activeTab === tabId) {
    activeTab = /** @type {string} */ (tabs[at] ?? tabs[at - 1]);
    const shownIn = paneOfTab(panes, activeTab);
    panes = shownIn
      ? focusPane(closePane(panes, panes.focus), shownIn)
      : setPaneTab(panes, panes.focus, activeTab);
  } else if (pane) {
    const shown = new Set(leaves(panes).map((l) => l.tab));
    const order = [...tabs.slice(at), ...tabs.slice(0, at).reverse()];
    const hidden = order.find((t) => !shown.has(t));
    panes = hidden ? setPaneTab(panes, pane, hidden) : closePane(panes, pane);
  }
  return replaceWs(s, i, updateWs(w, { ...kept, tabs, activeTab, panes }));
}

/**
 * Activates a tab anywhere: switches to its workspace, focuses its pane or shows it in the
 * focused one (goto picker, side panel, `prefix+1..9`).
 * @param {Workspaces} s
 * @param {string} tabId
 * @returns {Workspaces}
 */
export function selectTab(s, tabId) {
  const i = indexOfTab(s, tabId);
  const w = /** @type {WorkspaceState} */ (s.workspaces[i]);
  const next = showTab(w, tabId);
  if (next === w && w.id === s.active) return s;
  return replaceWs(s, i, next, { active: w.id });
}

/**
 * Moves a tab to the end of another workspace, not activated. The host reopens the page in the
 * target container and passes the new tab's id (default: the same id). If the host's TabOpen
 * handler already registered the new tab in the target, it stays where it is and only the old
 * tab is removed, so the order of the two host events does not matter.
 * @param {Workspaces} s
 * @param {string} tabId
 * @param {WorkspaceRef} ref
 * @param {{ newTabId?: string }} [options]
 * @returns {Workspaces}
 */
export function moveTab(s, tabId, ref, { newTabId = tabId } = {}) {
  const from = indexOfTab(s, tabId);
  const to = mustIndex(s, ref);
  if (from === to) return s;
  const target = /** @type {WorkspaceState} */ (s.workspaces[to]);
  if (newTabId !== tabId && target.tabs.includes(newTabId)) return closeTab(s, tabId);
  checkNewTab(s, newTabId, tabId);
  return openTab(closeTab(s, tabId), newTabId, { workspace: { id: target.id }, activate: false });
}

/**
 * `prefix+v` / `prefix+-`: opens `newTabId` after the active tab and splits the focused pane with
 * it. In an empty workspace the tab simply becomes its only pane. A refused split (`max` panes,
 * no space: `splitRefusal`) returns the input itself and registers no tab, so the host checks
 * `splitRefusal` before creating the tab.
 * @param {Workspaces} s
 * @param {SplitDirection} direction
 * @param {string} newTabId
 * @param {SplitOptions} [options]
 * @returns {Workspaces}
 */
export function splitPane(s, direction, newTabId, options = {}) {
  const w = activeWorkspace(s);
  if (!w.panes) return openTab(s, newTabId);
  checkNewTab(s, newTabId);
  const panes = split(w.panes, w.panes.focus, direction, newTabId, options);
  if (panes === w.panes) return s;
  const tabs = w.tabs.slice();
  tabs.splice(tabs.indexOf(/** @type {string} */ (w.activeTab)) + 1, 0, newTabId);
  return replaceWs(s, activeIndex(s), updateWs(w, { tabs, panes, activeTab: newTabId }));
}

/**
 * Applies a pane operation to the active workspace's layout; the focused pane's tab becomes the
 * active tab.
 * @param {Workspaces} s
 * @param {(panes: Panes) => Panes} fn
 * @returns {Workspaces}
 */
export function withPanes(s, fn) {
  const w = activeWorkspace(s);
  if (!w.panes) throw new WorkspaceError("no-tab", `workspace "${w.name}" has no tabs`);
  const panes = fn(w.panes);
  if (panes === w.panes) return s;
  const shown = leaves(panes);
  for (const l of shown) {
    if (!w.tabs.includes(l.tab)) {
      throw new WorkspaceError("unknown-tab", `pane shows "${l.tab}", not a tab of "${w.name}"`);
    }
  }
  const activeTab = /** @type {string} */ (paneTab(shown, panes.focus));
  return replaceWs(s, activeIndex(s), updateWs(w, { panes, activeTab }));
}

/**
 * @param {Leaf[]} shown
 * @param {string} pane
 */
function paneTab(shown, pane) {
  return shown.find((l) => l.pane === pane)?.tab;
}
