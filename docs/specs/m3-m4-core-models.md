# Spec: m3-m4-core-models

Status: implemented (core); the host wiring followed in the milestone's host specs · Milestones: M3 (workspaces), M4 (panes) · Area: `packages/vimma-core`

## User stories

- As the vimma host, I keep one pure model of the window's panes and workspaces in `vimma-core`,
  apply every `pane.*` / `workspace.*` / tab bookkeeping action to it, and then mirror the result
  onto Firefox (split view, containers, hidden tabs). Every rule about what happens next (which
  pane gets focus, which tab becomes active, where a closed workspace's tabs go) lives here, where
  it is tested in milliseconds.
- As a user, `prefix+h/j/k/l` moves to the pane that is visually next to me, as in tmux and Herdr;
  `prefix+v` / `prefix+-` / `prefix+x` / `prefix+z` / resize behave the same every time.
- As a user, restarting vimma restores my workspaces, their tab order and their pane layouts, and a
  state file written by an older vimma is migrated, not dropped.

## Scope

| Module           | Exports                                                                               |
| ---------------- | ------------------------------------------------------------------------------------- |
| `panes.mjs`      | `createPanes`, `split`, `splitRefusal`, `closePane`, `focus`, `focusPane`, `swap`,    |
|                  | `toggleZoom`, `resize`, `setPaneTab`, `layout`, `leaves`, `paneOfTab`, `MIN_RATIO`,   |
|                  | `PaneError`                                                                           |
| `workspaces.mjs` | `createWorkspaces`, `addWorkspace`, `renameWorkspace`, `deleteWorkspace`,             |
|                  | `switchWorkspace`, `nextWorkspace`, `previousWorkspace`, `openTab`, `closeTab`,       |
|                  | `selectTab`, `moveTab`, `splitPane`, `withPanes`, `activeWorkspace`, `findWorkspace`, |
|                  | `workspaceOfTab`, `WorkspaceError`                                                    |
| `snapshot.mjs`   | `SCHEMA_VERSION`, `toSnapshot`, `fromSnapshot`, `migrateSnapshot`, `canWrite`,        |
|                  | `SNAPSHOT_MIGRATIONS`, `SnapshotError`                                                |
| `index.mjs`      | re-exports                                                                            |

(Since changed: `fromSnapshot` is removed, because only its tests called it; `readSnapshot` in
`packages/vimma-core/src/snapshot.mjs` parses, migrates and validates a snapshot and returns its
state with the tab renames, [#956](https://github.com/vimma-browser/vimma/issues/956).)

Contract fixtures: `tests/contract/state/v1/valid.json`, `tests/contract/state/v1/invalid.json`.
Bench: `packages/vimma-core/bench/cases.mjs`, run by `tools/bench/bench.mjs` (Since changed:
`bench.ts`, ADR-025) (`npm run bench`). It is a **core-only smoke test**: dispatcher and model
updates in Node (≈ 1.3 µs per key sequence, ≈ 3 µs pane focus, ≈ 11 µs `withPanes` + `selectTab`,
against plan §5's 50 µs core budget). It is not key-to-action latency in the window. The plan §5
gate (a regression above 10 % fails CI) runs in CI as `npm run bench -- --check` against
`packages/vimma-core/bench/baseline.json` (issue #17).

All state is plain, frozen, JSON-shaped data. Every operation is a pure function
`(state, ...args) → newState`; the input is never mutated. Ids are opaque strings: the host owns
tab ids and container ids; the model mints pane ids (`p1`, `p2`, …) and workspace ids (`w1`, …).

## Pane tree (`panes.mjs`)

```js
/** @typedef {{ type: "leaf", pane: string, tab: string }} Leaf */
/** @typedef {{ type: "split", axis: "x" | "y", children: Node[], ratios: number[] }} Split */
/** @typedef {{ root: Node, focus: string, mru: string[], zoom: string | null, next: number }} Panes */
/** @typedef {"left" | "down" | "up" | "right"} Direction */
```

- `axis: "x"` lays children out left → right, `"y"` top → bottom. A split has ≥ 2 children and one
  ratio per child; no ratio is below `MIN_RATIO` (`0.1`).
- `mru` lists every pane once, most recently focused first (`mru[0] === focus`). Anything that
  moves focus moves that pane to the front; `closePane` drops the pane.
- `createPanes(tabId)` → one leaf `p1` showing `tabId`, focused.
- `split(state, paneId, "vertical" | "horizontal", newTabId)`: `vertical` = split right (`:vsplit`,
  `prefix+v`, axis `x`); `horizontal` = split down (`:split`, `prefix+-`, axis `y`). The new pane
  goes right after `paneId`. If `paneId`'s parent already has that axis, the pane's ratio is halved
  between the two; otherwise the leaf is replaced by a new 50/50 split. Focus moves to the new pane.
  **Refusal** (tmux "no space for new pane"): if halving would leave either pane below
  `MIN_RATIO`, `split` returns the input unchanged and `splitRefusal(state, paneId, direction)`
  returns `{ code: "no-space", message }` for the host's status bar (null when a split is fine).
  Four `prefix+v` in a row give `[.5, .25, .125, .125]`; the fourth is refused, and splitting the
  same pane down still works.
- `closePane(state, paneId)`: removes the leaf; its ratio goes to the previous sibling (the next one
  if it was first). A split left with one child is replaced by that child (sibling promotion), and a
  promoted split with its parent's axis is flattened into the parent, scaling its ratios, unless
  that would push one of its panes below `MIN_RATIO`: then the same-axis split stays nested (the
  one exception to canonical form; it flattens on a later rebuild once it fits). If the
  closed pane had focus, focus goes to the sibling that absorbed its space (the first leaf of it in
  reading order). Closing the last pane throws `PaneError("last-pane")`; the host closes the tab.
- `focus(state, direction)`: geometric neighbour lookup on the exact (unrounded) layout, as in
  tmux: the candidates are the panes whose facing edge touches the focused pane's `direction` edge
  and that overlap it on the other axis; of those, the **most recently used** (first in `mru`)
  wins. So `focus(left)` then `focus(right)` returns to where you were: from `p3` in
  `x[p1, y[p2, p3]]`, left goes to `p1` and right comes back to `p3`, not to `p2`. No neighbour →
  state unchanged (no wrap).
- `focusPane(state, paneId)` focuses a pane directly (picker, mouse).
- `swap(state, direction)`: exchanges the focused leaf with its `focus` neighbour in the tree; the
  focused pane keeps focus and moves with its tab. No neighbour → unchanged.
- `toggleZoom(state)`: zooms the focused pane, or unzooms. `split`, `closePane`, `focus`,
  `focusPane`, `swap` and `resize` clear the zoom when they change something (tmux); when they are
  no-ops (no neighbour, the pane already focused, nothing to resize, a refused split) they return
  the input itself, zoom included. `layout` of a zoomed state returns the zoomed pane alone,
  filling the rect.
- `resize(state, "wider" | "narrower" | "taller" | "shorter", amount)`: on the nearest ancestor split
  with the matching axis (`x` for wider/narrower), the child holding the focused pane grows by
  `amount` (a ratio, e.g. `0.05`), **borrowing from its siblings nearest first** (next, previous,
  then two away, …), each down to `MIN_RATIO`; so a pane can always grow until every sibling is at
  `MIN_RATIO` (at most `1 − (n − 1) · MIN_RATIO`). Shrinking gives to the next sibling (the
  previous one if it is last) and stops at `MIN_RATIO`. The change is clamped, never rejected. No
  such ancestor or nothing to move → unchanged.
- `setPaneTab(state, paneId, tabId)` shows another tab in a pane (tab switching in the focused pane).
- `layout(state, rect, { round = true })` → `[{ pane, tab, rect: { x, y, width, height } }]` in
  reading order. Each split's interior edges are `round(start + size × cumulative ratio)`; the last
  edge is exactly `start + size`. Edges are rounded, not widths, so neighbours share one edge and
  an integer rect tiles exactly in integer CSS pixels. `{ round: false }` gives the exact
  fractional edges (focus uses them).
- `leaves(state)` → leaves in reading order; `paneOfTab(state, tabId)` → pane id or `undefined`.
- Unknown pane id → `PaneError("unknown-pane")`; a tab already shown in another pane →
  `PaneError("tab-shown")` (one `<browser>` per pane); `bad-direction`, `bad-amount` (≤ 0) for
  invalid arguments.

### Invariants (fast-check, over random operation sequences)

1. Every split has ≥ 2 children, `ratios.length === children.length`, ratios ≥ `MIN_RATIO`
   (± 1e-9) and summing to 1 (± 1e-9). No pane ever ends below `MIN_RATIO`.
2. No split has a child split with the same axis, unless flattening it would push a pane below
   `MIN_RATIO`.
3. Every leaf is reachable from the root, pane ids are unique, tab ids are unique.
4. `focus` names an existing leaf; `zoom` is `null` or an existing leaf; `mru` is a permutation of
   the leaves with `mru[0] === focus`.
5. `closePane(split(s, p, d, t), newPane)` equals `s` up to `next` and focus on `p` (tree deep-equal,
   ratios exact); a refused split returns `s` itself.
6. `layout(s, r)` tiles `r`: for an integer `r` every edge is an integer, every rect lies in `r`,
   areas sum exactly to `r`'s area, and every sample point lies in exactly one rect (half-open).
7. `focus(s, d)` lands on the most recently used pane touching the start pane's `d` edge and
   overlapping it on the other axis; it leaves the state unchanged only when no pane does.
8. For any reachable tree and any pane with an ancestor split on an axis, repeated `resize` grows it
   until every sibling in that split is at `MIN_RATIO` (no pane gets stuck).

## Workspaces (`workspaces.mjs`)

```js
/** @typedef {{ id: string, name: string, container: string, tabs: string[],
 *              activeTab: string | null, panes: Panes | null }} WorkspaceState */
/** @typedef {{ workspaces: WorkspaceState[], active: string, next: number }} Workspaces */
/** @typedef {{ id: string } | { index: number } | { name: string }} WorkspaceRef */
```

- A workspace's **index** is its 1-based position in `workspaces` (the workspace order); it is not
  stored. Names are unique, non-empty after trimming, compared case-sensitively.
- `container` is the opaque string the host maps to a `userContextId`. Unique per workspace.
- `createWorkspaces([{ name, container }, …])` (≥ 1; config `[workspaces]` order); first is active.
- `addWorkspace(state, { name, container }, { activate = true })` appends.
- `renameWorkspace(state, ref, name)`.
- `deleteWorkspace(state, ref)` → `{ state, closedTabs }`: Herdr's `close_workspace` closes what
  is in it, so the workspace's tabs are returned for the host to close (moving them would reopen
  them in another container and lose page state anyway, plan §2). Deleting the active workspace
  activates the previous one (the next if it was first). Deleting the last workspace throws
  `WorkspaceError("last-workspace")`. **Host contract**: the host asks the user to confirm before
  deleting a workspace that has tabs (`closedTabs` would be non-empty). A workspace defined in
  config `[workspaces]` is recreated at startup, so deleting it does not stick; the M3 host spec
  decides how (proposal: config-defined workspaces are "pinned" and delete only clears their
  tabs).
- `switchWorkspace(state, ref)`, `nextWorkspace(state)`, `previousWorkspace(state)` (wrap around).
- `openTab(state, tabId, { workspace, after, activate = true })`: into `workspace` (default
  active), after tab `after` (default: at the end, as Firefox does for `ctrl+t`). Activating shows
  it in the focused pane. The first tab of an empty workspace creates its pane layout.
- `closeTab(state, tabId)`: removes it. If it was active, the tab to its right becomes active, else
  the one to its left (Firefox). If it was shown in a pane, that pane shows the new active tab if
  the closed one was focused (if that tab is already shown in another pane, the closed tab's pane
  is closed and that pane gets focus), otherwise the nearest tab not shown in any pane (rightwards
  first); if there is none, the pane is closed. The last tab of a workspace leaves
  `activeTab: null, panes: null`.
- `selectTab(state, tabId)`: switches to the tab's workspace; if a pane shows the tab it gets focus,
  else the focused pane shows it. It becomes `activeTab`.
- `moveTab(state, tabId, ref, { newTabId })`: close-tab bookkeeping in the source, open (not
  activated) at the end of the target. The host reopens the page in the target container and passes
  the new tab id (defaults to `tabId`). Moving into its own workspace is a no-op. **Event order
  does not matter**: if the host's TabOpen handler already registered `newTabId` in the target
  (via `openTab`), `moveTab` keeps it where it is and only removes the old tab. A `newTabId`
  registered in any other workspace is still `duplicate-tab`.
- `splitPane(state, direction, newTabId)`: opens `newTabId` after the active tab in the active
  workspace and splits the focused pane with it.
- `withPanes(state, fn)`: applies a pane operation to the active workspace's layout and sets
  `activeTab` to the focused pane's tab (`withPanes(s, p => focus(p, "left"))`). A result that
  shows a tab not in the workspace's `tabs` is rejected (`unknown-tab`).
- Errors: `WorkspaceError` with `code`: `unknown-workspace`, `duplicate-name`, `empty-name`,
  `duplicate-container`, `empty-container`, `unknown-tab`, `duplicate-tab`, `last-workspace`,
  `no-tab`.

### Invariants (fast-check, over random operation sequences)

The random sequences cover open, close, select, move (same id, new id, and new id registered
first by the host), split, `withPanes` with focus, close, swap, zoom and resize, switch, next,
previous, add, delete and rename.

1. Every tab id belongs to exactly one workspace.
2. `activeTab` is `null` iff `tabs` is empty iff `panes` is `null`; otherwise it is in `tabs` and is
   the focused pane's tab.
3. Every pane's tab is in its workspace's `tabs`.
4. `active` names an existing workspace; names and containers are unique.
5. The pane invariants above hold for every workspace's layout (checked by `fromSnapshot`'s
   validation inside property 6).
6. `fromSnapshot(toSnapshot(s))` deep-equals `s`.

(Since changed: for this list and the next section, `fromSnapshot` is removed; `readSnapshot` in
`packages/vimma-core/src/snapshot.mjs` does its validation, and `readSnapshot(toSnapshot(s)).state`
deep-equals `s`, [#956](https://github.com/vimma-browser/vimma/issues/956).)

## Persistence (`snapshot.mjs`)

`toSnapshot(state)` → `{ schema: 1, active, next, workspaces: [{ id, name, container, tabs,
activeTab, panes: { root, focus, mru, zoom, next } | null }] }`, plain JSON. Names must already be
trimmed (the model trims them); a name with surrounding spaces is rejected. `fromSnapshot(json)` accepts an
object or a string, runs `migrateSnapshot`, validates every field and every invariant above, and
throws `SnapshotError` with a JSON path (`workspaces[1].tabs[0]`) on the first problem.
`migrateSnapshot(raw, migrations = SNAPSHOT_MIGRATIONS)` applies `migrations[n]` (n → n + 1) until
`schema === SCHEMA_VERSION`; a missing step or a newer schema throws (`unsupported-schema`), and a
step that does not return schema n + 1 throws (`bad-migration`) instead of looping. v1 has no
migrations; the hook is tested with an injected v0 → v1 step.

`canWrite(existing)` takes the state file the host found (text, parsed JSON, or null for none) and
returns false only when it was written by a newer vimma (`schema > SCHEMA_VERSION`). The host
checks it before every write, so running an older build never overwrites newer state.

## Tests first (Given / When / Then)

Panes:

- Given one pane `p1`, when `split(p1, vertical, t2)`, then root is `x[p1, p2]` 50/50, focus `p2`.
- Given `x[p1, p2]` focused on `p2`, when `split(p2, vertical, t3)`, then `x[p1, p2, p3]` with
  ratios `[.5, .25, .25]` (same axis: no nesting).
- Given `x[p1, p2]`, when `split(p2, horizontal, t3)`, then `x[p1, y[p2, p3]]`.
- Given `x[p1, y[p2, p3]]`, when `closePane(p3)`, then `x[p1, p2]` (promotion), focus `p2`.
- Given `x[p1, y[p2, x[p3, p4]]]`, when `closePane(p2)`, then `x[p1, p3, p4]` with ratios
  `[.5, .25, .25]` (the promoted split is flattened into its parent).
- Given one pane, when `closePane(p1)`, then `PaneError("last-pane")`.
- Given `x[p1, y[p2, p3]]` focused on `p3`, when `focus(left)`, then `p1`; when `focus(right)`,
  then `p3` again (most recently used of `p2`, `p3`).
- Given `x[p1 .5, p2 .25, p3 .125, p4 .125]`, when `split(p4, vertical)`, then unchanged with
  `splitRefusal` `no-space`; `split(p4, horizontal)` works.
- Given the same, focused on `p4`, when `resize(wider, 0.3)`, then `[.375, .1, .1, .425]` (borrowed
  from `p3`, then `p2`, then `p1`); `resize(wider, 1)` gives `[.1, .1, .1, .7]`.
- Given `x[.5, .25, .25]` in a 101 px rect, then edges are `0, 51, 76` (rounded edges, not widths).
- Given `x[p1, p2]`, when `focus(up)` from `p1`, then unchanged (no wrap).
- Given `x[p1, p2]` focused on `p1`, when `swap(right)`, then `x[p2, p1]`, focus `p1`.
- Given `x[p1, p2]`, when `toggleZoom` then `layout`, then only the focused pane, full rect; when
  `focus(right)`, then zoom is cleared.
- Given `x[p1, p2]` focused on `p1`, when `resize(wider, 0.1)`, then `[.6, .4]`; when
  `resize(wider, 1)`, then `[.9, .1]` (clamped); when `resize(taller, 0.1)`, then unchanged.
- Given `x[p1, p2]` focused on `p2` (last), when `resize(wider, 0.1)`, then `[.4, .6]`.
- Given `x[p1, y[p2, p3]]` 50/50 in `{0, 0, 100, 80}`, then `layout` gives `p1 {0,0,50,80}`,
  `p2 {50,0,50,40}`, `p3 {50,40,50,40}`.
- Properties 1–7 above.

Workspaces:

- Given `[work, personal]`, when `nextWorkspace` twice, then `work` again (wrap); `previousWorkspace`
  from `work` → `personal`.
- Given `work`, when `switchWorkspace({ index: 2 })` / `({ name: "personal" })`, then `personal`.
- Given `work`, when `addWorkspace({ name: "work" })`, then `WorkspaceError("duplicate-name")`.
- Given `work` with tabs `a, b`, when `deleteWorkspace(work)`, then `closedTabs` is `[a, b]` and the
  previous workspace is active; deleting the only workspace → `last-workspace`.
- Given tabs `a, b, c` with `b` active, when `closeTab(b)`, then `c` active; closing `c` then makes
  `a` active; closing `a` leaves `activeTab: null, panes: null`.
- Given `a` active, when `openTab(d, { after: "a" })`, then `a, d, b, c` and `d` active in the
  focused pane.
- Given panes `x[a, b]` with `b` focused, when `closeTab(b)` and no hidden tab, then one pane `a`.
- Given panes `x[a, b]` and hidden tab `c`, when `closeTab(b)` (focused), then the pane shows the new
  active tab (`c`, its right neighbour).
- Given `a` in `work`, when `moveTab(a, personal, { newTabId: "a2" })`, then `work` lacks `a`,
  `personal` ends with `a2`, `work` stays active.
- Given `a2` already opened in `personal` by the host, when `moveTab(a, personal, { newTabId: "a2" })`,
  then only `a` is removed; `a2` registered in a third workspace → `duplicate-tab`.
- Given `a` in `personal` while `work` is active, when `selectTab(a)`, then `personal` is active and
  shows `a` in its focused pane.
- Properties 1–6 above.

Persistence:

- `tests/contract/state/v1/valid.json` parses and round-trips through `toSnapshot`.
- `tests/contract/state/v1/invalid.json` fails with a `SnapshotError` naming the path.
- Given `{ schema: 2 }`, then `unsupported-schema`; given an injected `0 → 1` migration, a v0 file
  loads; a migration that returns schema 0 again → `bad-migration`.
- `canWrite`: no file, a v1 file, an older or unreadable file → true; a schema 2 file → false.

## Actions

No change to `actions.mjs`: every pane and workspace binding of plan §2 (`split_vertical`,
`split_horizontal`, `focus_pane_*`, `swap_pane_*`, `zoom`, `close_pane`, `resize_mode`,
`resize_*`, `next_workspace`, `previous_workspace`, `workspace_picker`, `new_workspace`,
`rename_workspace`, `close_workspace`) already exists from m0-core-dispatcher, so the dispatcher
contract and `docs/bindings.md` are unchanged.

## Out of scope

Everything touching Firefox: containers (`ContextualIdentityService`), `gBrowser.hideTab` /
`showTab`, the vendored split view, SessionStore, the state file on disk, pickers and the side
panel UI, `resize` mode (a new dispatcher mode), `[workspaces]` TOML parsing (M5), the status bar
text. These belong to the host specs (see below).

## For the host specs (M3 / M4)

- Map `pane.split_vertical` → `splitPane(s, "vertical", newTab)` after creating the tab;
  `pane.focus_*` / `pane.swap_*` / `pane.zoom` / `pane.close` / `pane.resize_*` →
  `withPanes(s, p => …)`; resize steps of `0.05`.
- `resize_mode` needs a `resize` mode in `MODES` (a dispatcher contract change: ADR).
  Done in m4-split-panes sub-spec 5, [ADR-014](../adr/014-resize-mode.md).
- Tab ids must survive a restart (e.g. a uuid in `SessionStore.setCustomTabValue`), since Firefox's
  own tab ids do not; the snapshot stores whatever the host passes.
- Before restoring a snapshot, drop tab ids the session did not restore (via `closeTab`).
- Confirm before deleting a non-empty workspace, then close the tabs `deleteWorkspace` returns;
  decide how config-defined workspaces behave on delete (pinned, delete clears).
- For a move, reopen the page in the target container, then call `moveTab` with the new tab's id;
  it is fine if TabOpen registered it first.
- Show `splitRefusal(…).message` in the status bar when a split returns the state unchanged.
- Call `canWrite` on the existing state file before every write.
- Mirror `layout()` onto the split view; hide every tab of non-active workspaces.

## Settled

- **N-ary splits in canonical form**, not a binary tree: three side-by-side panes are one split
  with three ratios, as in tmux; this makes "resize" act on the visible divider. The one exception
  keeps `MIN_RATIO` absolute.
- **`MIN_RATIO` is a floor everywhere**: splits refuse rather than go below it,
  and growing borrows from further siblings, so no pane gets stuck.
- **Focus picks the most recently used neighbour** (tmux), so left/right is a round trip.
- **`layout` rounds edges to integers**, not widths.
- **Splitting halves the pane's own share**, never re-balances siblings (tmux), which makes
  `closePane(split(x))` restore ratios exactly (`r/2 + r/2 === r` in binary floating point).
- **Closing a pane keeps its tab** (Vim `:q` in a window, Zen "unsplit"); `prefix+shift+x` closes
  tabs. Closing the last pane is an error for the host to turn into "close tab".
- **No wrap-around for pane focus** (Herdr); workspaces wrap (`prefix+)` on the last goes to the first).
- **Deleting a workspace closes its tabs** (Herdr `close_workspace`); there is no "move to another
  workspace" because a move reopens every page in another container.
- **Zoom is persisted** (a restart looks the same) and cleared by any change; no-ops keep it.
- **Errors throw** (`PaneError`, `WorkspaceError`, `SnapshotError`, each with `code`) for misuse by
  the host; ordinary no-ops (no neighbour, resize at the clamp) return the state unchanged, so the
  host can compare by identity.
