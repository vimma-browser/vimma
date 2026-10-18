/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The side panel (docs/specs/m3-workspaces.md, sub-spec 6): what it lists and what its keys do,
 * as pure functions over the workspace model. The host renders it (ui/side-panel.mjs).
 */
import { activeWorkspace, nextWorkspace, previousWorkspace } from "./workspaces.mjs";
import { displayLabel } from "./tablabels.mjs";

/** @import { Workspaces } from "./workspaces.mjs" */

/**
 * What the host knows of a tab; undefined for one it no longer has.
 * @typedef {{ title?: string, url?: string, label?: string | null, foreign?: boolean,
 *   playing?: boolean, pinned?: boolean }} PanelTabInfo
 */
/**
 * @typedef {{ readonly tabId: string, readonly number: number, readonly display: string,
 *   readonly host: string, readonly active: boolean, readonly foreign: boolean,
 *   readonly playing: boolean, readonly pinned: boolean }} PanelRow
 */
/**
 * `previous` / `next`: the workspaces ctrl+b ( / ctrl+b ) go to, null with one workspace.
 * `marked`: the marked rows' tabs, in row order; `anchor`: the tab an open `V` range started on,
 * else null (docs/specs/m4-side-panel-multiselect.md).
 * `panes`: the split's tabs in row order, [] without a split; they start marked, and `Enter` applies
 * a change to them; `paneFocus`: the focused pane's tab (docs/specs/side-panel-unsplit.md).
 * `workspace.private`: the private workspace (docs/specs/private-workspace.md decision 6), whose
 * neighbours are the host's (the first and last normal workspaces), not the model's.
 * @typedef {{ readonly workspace: { id: string, name: string, index: number, color?: string,
 *     private?: boolean },
 *   readonly previous: string | null, readonly next: string | null,
 *   readonly rows: readonly PanelRow[], readonly selected: number,
 *   readonly marked: readonly string[], readonly anchor: string | null,
 *   readonly panes: readonly string[], readonly paneFocus: string | null,
 *   readonly hidden: boolean }} PanelState
 */
/**
 * `closeTab`: close that tab and keep the panel open (`x`, docs/specs/key-handling-batch.md).
 * `together`: show `ids` (row order) as the workspace's panes, focus on `focus`
 * (docs/specs/m4-side-panel-multiselect.md).
 * `move`: ask which workspace gets that tab (`m`, m3-workspaces "Settled: moving a background
 * tab from the side panel").
 * `alone`: end the workspace's split and show `id` alone (docs/specs/side-panel-unsplit.md).
 * `together` with `alone`: make `ids` the view, then show the `alone` tab by itself with the view
 * kept hidden (side-panel-unsplit decision 25).
 * @typedef {{ type: "select", id: string } | { type: "close" }
 *   | { type: "refuse", text: string } | { type: "closeTab", id: string }
 *   | { type: "together", ids: string[], focus: string, alone?: string }
 *   | { type: "alone", id: string } | { type: "move", id: string }} PanelEffect
 */

/**
 * `color`: the workspace's colour name. `private` and `neighbours` (`[previous, next]`): the
 * private workspace, whose ctrl+b ( / ctrl+b ) targets the host knows (private-workspace).
 * `panes` / `paneFocus`: the active workspace's split, its tabs and its focused pane's tab
 * (side-panel-unsplit); none or [] without a split. `paneHidden`: the split is a hidden view.
 * `skip`: workspace ids the cycle passes over (the agent workspace, docs/specs/vimma-mcp.md
 * decision 9), so the header never names one as a neighbour.
 * @typedef {{ color?: string, private?: boolean,
 *   neighbours?: readonly [string | null, string | null], skip?: ReadonlySet<string>,
 *   panes?: readonly string[], paneFocus?: string | null, paneHidden?: boolean }} PanelOptions
 */

/** What `x` says on a pinned tab. */
export const PINNED_TEXT = "pinned tab: unpin it to close it";
/** What `m` says on a pinned tab. */
export const PINNED_MOVE_TEXT = "pinned tab: unpin it to move it";
/** What `space` says on a pinned tab. */
export const PINNED_MARK_TEXT = "pinned tab: unpin it to show it in a split";

/**
 * The host of a URL, or the URL itself when it has none (about:, data:).
 * @param {string} url
 */
function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The panel for the model's active workspace: its tabs in the model's order (the host passes
 * them in window order), the highlight on `selectedId` when listed, else on the active tab.
 * @param {Workspaces} model
 * @param {(tabId: string) => PanelTabInfo | undefined} info
 * @param {PanelOptions & { selectedId?: string | null }} [options]
 * @returns {PanelState}
 */
export function openPanel(
  model,
  info,
  {
    color,
    selectedId = null,
    panes = [],
    paneFocus = null,
    paneHidden = false,
    skip,
    ...where
  } = {},
) {
  const w = activeWorkspace(model);
  const at = model.workspaces.indexOf(w);
  // The ctrl+b ( / ctrl+b ) targets, as the cycle finds them: none when it stays put.
  const neighbour = (/** @type {number} */ step) => {
    if (where.neighbours) return where.neighbours[step < 0 ? 0 : 1];
    const to = (step < 0 ? previousWorkspace : nextWorkspace)(model, skip);
    return to.active === model.active ? null : activeWorkspace(to).name;
  };
  const rows = w.tabs.map((tabId, i) => {
    const t = info(tabId) ?? {};
    return Object.freeze({
      tabId,
      number: i + 1,
      display: displayLabel(t),
      host: t.url ? hostOf(t.url) : "",
      active: tabId === w.activeTab,
      foreign: !!t.foreign,
      playing: !!t.playing,
      pinned: !!t.pinned,
    });
  });
  const find = (/** @type {string | null} */ id) => rows.findIndex((r) => r.tabId === id);
  const selected = find(selectedId) >= 0 ? find(selectedId) : Math.max(0, find(w.activeTab));
  const wanted = new Set(panes);
  const split = Object.freeze(rows.filter((r) => wanted.has(r.tabId)).map((r) => r.tabId));
  return Object.freeze({
    workspace: Object.freeze({
      id: w.id,
      name: w.name,
      index: at + 1,
      ...(color ? { color } : {}),
      ...(where.private ? { private: true } : {}),
    }),
    previous: neighbour(-1),
    next: neighbour(1),
    rows: Object.freeze(rows),
    selected,
    marked: split,
    anchor: null,
    panes: split,
    paneFocus: paneFocus && split.includes(paneFocus) ? paneFocus : null,
    hidden: paneHidden && split.length > 1,
  });
}

/**
 * The panel again after the model changed (a tab opened or closed, ctrl+b )): the highlight stays
 * on its tab while that is listed in the same workspace, and so do the marks and an open range
 * (in the new row order); another workspace starts without them. Marks still equal to the split
 * follow the split as it is now; changed ones are kept (side-panel-unsplit decision 6).
 * @param {PanelState} state
 * @param {Workspaces} model
 * @param {(tabId: string) => PanelTabInfo | undefined} info
 * @param {PanelOptions} [options]
 * @returns {PanelState}
 */
export function refreshPanel(state, model, info, options = {}) {
  const same = activeWorkspace(model).id === state.workspace.id;
  const selectedId = same ? (state.rows[state.selected]?.tabId ?? null) : null;
  const next = openPanel(model, info, { ...options, selectedId });
  if (!same) return next;
  const listed = new Set(next.rows.map((r) => r.tabId));
  return Object.freeze({
    ...next,
    marked: changed(state) ? inRowOrder(next, new Set(state.marked)) : next.marked,
    anchor: state.anchor && listed.has(state.anchor) ? state.anchor : null,
  });
}

/**
 * The listed tabs of `ids`, in row order.
 * @param {PanelState} state
 * @param {ReadonlySet<string>} ids
 * @returns {readonly string[]}
 */
function inRowOrder(state, ids) {
  return Object.freeze(state.rows.filter((r) => ids.has(r.tabId)).map((r) => r.tabId));
}

/**
 * Whether the marks differ from the split's panes (side-panel-unsplit); with no split, whether
 * anything is marked.
 * @param {PanelState} state
 */
export function changed(state) {
  if (state.marked.length !== state.panes.length) return true;
  const panes = new Set(state.panes);
  return state.marked.some((id) => !panes.has(id));
}

/**
 * Row `i`'s gutter: `●` marked, `○` a pane that leaves the split on `Enter`, `│` in an open
 * range, else blank (side-panel-unsplit decision 16).
 * @param {PanelState} state
 * @param {number} i
 */
export function gutterOf(state, i) {
  const id = state.rows[i]?.tabId;
  if (id === undefined) return "";
  if (state.marked.includes(id)) return "●";
  if (state.panes.includes(id)) return "○";
  return inRange(state, i) ? "│" : "";
}

/**
 * Whether row `i` is inside the open `V` range (anchor to highlight, either way).
 * @param {PanelState} state
 * @param {number} i
 */
export function inRange(state, i) {
  if (state.anchor === null) return false;
  const a = state.rows.findIndex((r) => r.tabId === state.anchor);
  if (a < 0) return false;
  return i >= Math.min(a, state.selected) && i <= Math.max(a, state.selected);
}

/**
 * The marked rows, in row order.
 * @param {PanelState} state
 * @returns {PanelRow[]}
 */
export function markedRows(state) {
  const marked = new Set(state.marked);
  return state.rows.filter((r) => marked.has(r.tabId));
}

/**
 * The header's count: "2 marked", "range: 3", "range: 3 · 2 marked", or "" with neither. With a
 * split: "split: 3 panes" while the marks match it, "split: 3 → 2" after a change, and
 * "(unsplit)" when Enter would end it (side-panel-unsplit decision 16).
 * @param {PanelState} state
 */
export function markSummary(state) {
  const range = state.rows.filter((_, i) => inRange(state, i)).length;
  const n = state.panes.length;
  const m = state.marked.length;
  const split = changed(state)
    ? `split: ${n} → ${m}${m < 2 ? " (unsplit)" : ""}`
    : `split: ${n} panes${state.hidden ? " (hidden)" : ""}`;
  const parts = [
    ...(range ? [`range: ${range}`] : []),
    ...(n ? [split] : m ? [`${m} marked`] : []),
  ];
  return parts.join(" · ");
}

/**
 * Ends an open range, marking its rows (pinned ones skipped) on top of the marks.
 * @param {PanelState} state
 * @returns {PanelState}
 */
function markRange(state) {
  const ids = new Set(state.marked);
  state.rows.forEach((r, i) => {
    if (inRange(state, i) && !r.pinned) ids.add(r.tabId);
  });
  return Object.freeze({ ...state, marked: inRowOrder(state, ids), anchor: null });
}

/**
 * Enter with changed marks (after a range is marked): the marks are applied, then Enter goes to
 * the highlighted row (side-panel-unsplit decision 25). Without a split one mark goes to its tab.
 * With a split, one mark or none ends it: the highlighted row's tab shows alone when it was a
 * pane just unmarked or nothing is marked, else the marked one. Two or more are the view: the
 * highlighted row's pane has focus when it is marked; a pane just unmarked under the highlight
 * shows alone over the view, now hidden ("space on C, Enter on C"); any other row leaves the view
 * shown, focus on the kept focused pane, else the first marked (decision 17).
 * @param {PanelState} state
 * @returns {{ state: PanelState, effect: PanelEffect | null }}
 */
function openMarked(state) {
  const ids = [...state.marked];
  const here = state.rows[state.selected]?.tabId;
  const removed = !!here && state.panes.includes(here) && !ids.includes(here);
  if (ids.length < 2 && state.panes.length) {
    const id = removed || !ids.length ? here : ids[0];
    return { state, effect: id ? { type: "alone", id } : null };
  }
  if (ids.length === 1)
    return { state, effect: { type: "select", id: /** @type {string} */ (ids[0]) } };
  const kept = state.paneFocus && ids.includes(state.paneFocus) ? state.paneFocus : null;
  const focus = here && ids.includes(here) ? here : (kept ?? /** @type {string} */ (ids[0]));
  /** @type {PanelEffect} */
  const effect = { type: "together", ids, focus };
  return { state, effect: removed && here ? { ...effect, alone: here } : effect };
}

/**
 * One panel action (defaults.mjs `[modal.panel]`).
 * @param {PanelState} state
 * @param {{ id: string, arg?: number }} action
 * @returns {{ state: PanelState, effect: PanelEffect | null }}
 */
export function panelKey(state, action) {
  const last = state.rows.length - 1;
  /** @param {number} selected */
  const move = (selected) =>
    Object.freeze({ state: Object.freeze({ ...state, selected }), effect: null });
  /** @param {PanelRow | undefined} row */
  const select = (row) => ({
    state,
    effect: row ? /** @type {PanelEffect} */ ({ type: "select", id: row.tabId }) : null,
  });
  switch (action.id) {
    case "panel.down":
      return move(Math.max(0, Math.min(last, state.selected + 1)));
    case "panel.up":
      return move(Math.max(0, state.selected - 1));
    case "panel.open": {
      const ready = state.anchor === null ? state : markRange(state);
      if (changed(ready)) return openMarked(ready);
      return { ...select(state.rows[state.selected]), state: ready };
    }
    case "panel.mark": {
      if (state.anchor !== null) return { state: markRange(state), effect: null };
      const row = state.rows[state.selected];
      if (!row) return { state, effect: null };
      if (row.pinned) return { state, effect: { type: "refuse", text: PINNED_MARK_TEXT } };
      const ids = new Set(state.marked);
      if (!ids.delete(row.tabId)) ids.add(row.tabId);
      // The highlight stays on the row: the next mark may be above or below, so j / k choose.
      return { state: Object.freeze({ ...state, marked: inRowOrder(state, ids) }), effect: null };
    }
    case "panel.visual": {
      if (state.anchor !== null) return { state: markRange(state), effect: null };
      const row = state.rows[state.selected];
      if (!row) return { state, effect: null };
      return { state: Object.freeze({ ...state, anchor: row.tabId }), effect: null };
    }
    case "panel.select": {
      const n = action.arg ?? 0;
      const row = state.rows[n - 1];
      if (row) return select(row);
      return { state, effect: { type: "refuse", text: `no tab ${n} in ${state.workspace.name}` } };
    }
    // Esc: the range first, then the marks (back to the split's panes, side-panel-unsplit
    // decision 13), then the panel (Vim leaves visual mode first).
    case "panel.close":
      if (state.anchor !== null) {
        return { state: Object.freeze({ ...state, anchor: null }), effect: null };
      }
      if (changed(state)) {
        return { state: Object.freeze({ ...state, marked: state.panes }), effect: null };
      }
      return { state, effect: { type: "close" } };
    case "panel.close_tab": {
      // The highlight goes to the next row (the one before, at the end), so the refresh after
      // the tab closes keeps it there and the next `x` closes that one.
      const row = state.rows[state.selected];
      if (!row) return { state, effect: null };
      if (row.pinned) return { state, effect: { type: "refuse", text: PINNED_TEXT } };
      const next = state.selected < last ? state.selected + 1 : Math.max(0, state.selected - 1);
      return {
        state: Object.freeze({ ...state, selected: next }),
        effect: { type: "closeTab", id: row.tabId },
      };
    }
    // The highlighted row's tab, which need not be the selected one: a background tab moves
    // without being selected first. The panel closes for the picker that asks where.
    case "panel.move": {
      const row = state.rows[state.selected];
      if (!row) return { state, effect: null };
      if (row.pinned) return { state, effect: { type: "refuse", text: PINNED_MOVE_TEXT } };
      return { state, effect: { type: "move", id: row.tabId } };
    }
    default:
      return { state, effect: null };
  }
}
