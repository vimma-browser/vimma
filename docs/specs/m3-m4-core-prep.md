# Spec: m3-m4-core-prep

Status: implemented (core) · Milestones: M3 (workspaces), M4 (panes) · Area:
`packages/vimma-core`

The core pieces the M3 workspace host and the M4 split-pane host need, so that their specs are
mostly wiring: explicit workspace ids, a pane maximum, config schema 2, and two pure planners
that turn the model into the operations the host applies to Firefox. Sources:
[m3-workspaces](m3-workspaces.md) (decisions 10, 11, 14 and the core change it asks for),
[m4-split-panes](m4-split-panes.md) and [ADR-013](../adr/013-split-on-firefox-split-view.md)
(reconcile: rebuild on leave, `moveBefore`, deactivate dropped and zoomed-away docshells,
`panes.max`), [m3-m4-core-models](m3-m4-core-models.md), [m5-core-config-and-theme](m5-core-config-and-theme.md)
and the planned schema 2 of [m1-core-logic](m1-core-logic.md).

## User stories

- As the M3 host, I pass each workspace's global id (`ws-<uuid>` from the definitions file) into
  every window's model, so that the same workspace has the same id in every window.
- As the M4 host, I refuse a split past `[panes] max` with a status-bar message, and my
  `PaneView.reconcile` only applies a list of operations computed and tested in core.
- As the M3 host, a workspace switch is a select, show and hide list that already respects
  pinned tabs, the selected tab and split groups.
- As a user, I can set `[panes] max`, `[modal] hint_chars` and `[sites."<host>"] insert` in
  `config.toml` with `schema = 2`, and a mistake is reported with its line and a suggestion.

## API

| Module           | Change                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaces.mjs` | `WorkspaceDef.id?`, `MAX_WORKSPACE_ID` (128), `isWorkspaceId`; codes `bad-id`, `duplicate-id`; `splitPane(s, dir, tab, { max })`                   |
| `panes.mjs`      | `split(…, { max })`, `splitRefusal(…, { max })`, `PANES_MAX_DEFAULT` (4), `PANES_MAX_LIMIT` (16); refusal code `max-panes`; `PaneError("bad-max")` |
| `snapshot.mjs`   | workspace ids checked with `isWorkspaceId` (schema stays 1)                                                                                        |
| `config.mjs`     | `CONFIG_SCHEMA_VERSION = 2`, `MIGRATIONS[1]`; resolved `panes`, `hintChars`, `sites`; `mergeWithDefaults(user, workspaceOrder?, siteOrder?)`       |
| `defaults.mjs`   | `DEFAULT_CONFIG.panes`, `.sites`, `.modal.hint_chars`; `defaults.toml` is schema 2                                                                 |
| `toml.mjs`       | `locateKeys` records implicit parent tables at their first header                                                                                  |
| `splitplan.mjs`  | `planSplit(workspace, current)`, `PlanError`                                                                                                       |
| `switchplan.mjs` | `planWorkspaceSwitch(model, to, tabsState)`                                                                                                        |

### Explicit workspace ids

`createWorkspaces([{ name, container, id? }, …])` and `addWorkspace(s, { name, container, id? })`
keep an explicit id. It must be a string of 1 to 128 UTF-16 code units without whitespace or
control characters (`bad-id`) and unused (`duplicate-id`). Without one, ids are minted `w<next>`
as before. An explicit id shaped like a minted one (`w7`) moves `next` past it, so minting never
collides and the snapshot's `next` rule holds. Snapshot schema 1 is unchanged: it always stored
an arbitrary string id; `fromSnapshot` now applies the same `isWorkspaceId` check (every id an
older vimma wrote, `w<n>`, passes).

### `panes.max`

`splitRefusal(s, paneId, direction, { max = Infinity })` returns
`{ code: "max-panes", message: "at most N panes" }` when the tree already has `max` leaves,
checked before `no-space`; `split` and `splitPane` return their input when refused.
`max` must be a positive integer or `Infinity` (`PaneError("bad-max")`). Core is unbounded
unless the host passes `config.panes.max`. `splitPane` now returns the state itself on any
refusal and registers no tab, so the host checks `splitRefusal` before it creates the tab
(before, a `no-space` refusal registered the tab and made it active without showing it).

### Config schema 2

| Key                       | Type    | Default       | Validation                                                                                                                                                                                                                            |
| ------------------------- | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                  | integer | absent = 0    | `0 ≤ schema ≤ 2`                                                                                                                                                                                                                      |
| `[panes] max`             | integer | `4`           | `1 ≤ max ≤ 16`; unknown keys suggest `max`                                                                                                                                                                                            |
| `[modal] hint_chars`      | string  | `"asdfghjkl"` | `hintLabels`' charset rule: ≥ 2 distinct characters, none uppercase or whitespace                                                                                                                                                     |
| `[sites."<host>"]`        | table   | none          | host as `URL.hostname` gives it (domain, IPv4, IPv6 with or without brackets, optional trailing dot); no scheme, port, path or `*` (suggestion: the hostname); the same host twice (case, trailing dot, brackets ignored) is an error |
| `[sites."<host>"] insert` | string  | `"auto"`      | `auto`, `never` or `always` (suggestion)                                                                                                                                                                                              |
| `[theme] name`            | string  | `"vimma"`     | `"vimma"` or `"tokyo-night"` (suggestion): the built-in palette (added later, as `[bookmarks]` was)                                                                                                                                   |

(Since changed: `[panes] max` defaults to 8 (#691).)

Resolved config gains `panes: { max }`, `hintChars` and `sites: [{ match, insert }]` in file
order (`match` as written; `matchSiteRule` normalises). `modal` stays as written, so it may hold
`hint_chars`, which `compileKeymap` skips.

**Why a bump, not additive v1.** Schema 1 rejects unknown keys. Adding `[panes]` to v1 would
make an older vimma fail on a newer file with `unknown key "panes"`, which reads as the user's
mistake. With schema 2 the older vimma says the file is from a newer vimma, which is the
truth. A newer vimma reading a v1 file is unaffected either way. So:

- `MIGRATIONS[1]` is the identity plus `schema = 2`; v1 files load with `migratedFrom: 1`.
- Schema-2 keys (`panes`, `sites`, `modal.hint_chars`) are accepted only when the file
  declares `schema = 2`; otherwise each is one error, `is new in schema 2: put schema = 2 at
the top of the file`, at its line. That keeps the declared schema honest, which is what makes
  the older-vimma message correct.
- The m1 spec's planned keys (`[sites."<host>"] insert`, `[modal] hint_chars`) are in the same
  bump, so there is one.

Contract fixtures: `tests/contract/config/v2/` (valid, invalid-schema, invalid-old-schema,
invalid-newer with schema 3). The v1 "newer schema" fixture moved there: `schema = 2` is no
longer newer. The contract test now also checks that each older version's `valid.toml` still
loads, migrated.

### `planSplit(workspace, current)` (M4 reconcile)

```js
/** @typedef {{ members: string[], active: string[], hidden: string[] }} SplitGroupState */
/** @typedef {{ join: string[], leave: string[], order: { tab: string, before: string | null }[],
 *   activate: string[], deactivate: string[], hideVisually: string[], showVisually: string[] }} SplitPlan */
```

- Input: a workspace `{ tabs, panes }` (a `WorkspaceState`) and Firefox's group:
  `members` (the wrapper's tabs in DOM panel order, `[]` without one), `active` (tabs whose
  `docShellIsActive` is true), `hidden` (panels hidden visually for zoom; the zoomed pane is
  the member that is not hidden).
- Target: members = the leaves' tabs in reading order when there are at least two, else none;
  with a zoom, every member but the zoomed one is hidden visually and inactive; every other leaf
  is active; tabs that leave (and any stale hidden panel) are inactive and shown again.
- Host order: membership (`leave` non-empty: `unsplitTabs()` then `addTabSplitView(remaining
++ join)` when ≥ 2; else `join` non-empty: `addTabs(join)`, or `addTabSplitView(join)` with no
  wrapper), then `order` (moveBefore, `before: null` = after the last member, computed for
  remaining ++ join), then `showVisually`/`hideVisually`, then `activate`/`deactivate`. If
  Firefox orders a rebuilt wrapper differently, the host plans again: `planSplit` is idempotent.
- `order` is minimal: the longest run already in reading order stays; every other panel moves,
  right to left, before its successor.
- Decision 14: a member outside `workspace.tabs` simply leaves (adoption of a wrapper made
  outside vimma); a tree showing a tab outside `workspace.tabs` throws
  `PlanError("cross-workspace")`. A `members` list with a duplicate is `bad-state`.

### `planWorkspaceSwitch(model, to, tabsState)` (M3 switch)

```js
/** @typedef {{ id: string, hidden: boolean, pinned: boolean, group: string | null }} TabInfo */
/** @typedef {{ tabs: TabInfo[], selected: string | null }} TabsState */
/** @typedef {{ select: string | null, show: string[], hide: string[], unsplit: string[] }} SwitchPlan */
```

- `to` is a `WorkspaceRef`, or `undefined` for the model's active workspace (the usual call
  after `switchWorkspace`). `tabsState.tabs` is in DOM order; `group` identifies the tab's
  split-view wrapper.
- `select` is the target's `activeTab`; `show` every hidden tab of the target; `hide` every
  visible model tab of another workspace, per split group: a group is hidden through one
  visible member (preferring one that is not selected) and only when none of its members is in
  the target. Pinned tabs are never hidden; tabs the model does not know are left alone unless
  their wrapper is hidden as a whole.
- `unsplit`: tabs of other workspaces in a wrapper with target tabs. They stay visible; the
  host takes them out of the wrapper (decision 14).
- Host order: select, show, hide (Firefox will not hide the selected tab). For an empty target
  `select` is null: the host opens its home tab first, registers it and plans again.
- Unknown target → `PlanError("unknown-workspace")`; a tab listed twice → `bad-state`.

## Tests

Vitest, red then green, in `workspaces.test.mjs`, `panes.test.mjs`, `snapshot.test.mjs`,
`config-v2.test.mjs`, `contract.test.mjs`, `splitplan.test.mjs`, `switchplan.test.mjs`.
Properties (fast-check):

- Workspaces: the random operation sequences now add workspaces with explicit ids (some shaped
  `w<n>`) and split with a random `max`; all existing invariants and the snapshot round trip
  hold.
- Panes: for any `max` in 1..6 and any operation sequence, the leaf count never exceeds `max`,
  and `split` refuses exactly when `splitRefusal` says so (`max-panes` whenever the tree is full).
- Config: an integer `[panes] max` is accepted iff it is within 1..16.
- `planSplit`, over random trees (splits, closes, swaps, focus, zoom, tab replacement) and
  arbitrary group states (foreign members, any flags), with a simulator of the host's order:
  applying the plan yields the target members, reading order, hidden set and docshell flags;
  planning again after applying gives an empty plan, and a group already at the target gives an
  empty plan; lists are duplicate-free and disjoint; `order` has fewer moves than members.
- `planWorkspaceSwitch`, over random models (three workspaces) and Firefox states (pinned and
  unknown tabs, random hidden flags, random and mixed split groups), with a simulator of
  `hideTab`'s rules: afterwards exactly the target's tabs are visible besides pinned, unknown and
  mixed-group ones; mixed-group foreign tabs are in `unsplit`; groups end uniformly hidden or
  shown; `hide` never names a pinned or target tab or two members of one group; planning again
  shows and hides nothing.

## Out of scope

All Firefox wiring (`PaneView.reconcile`, `WindowWorkspaces`), the status-bar text for a
refusal, reading `[panes]`/`[sites]`/`hint_chars` in the host, `workspacedefs.mjs` (M3 sub-spec 1).

## Settled

- **Explicit ids are validated, minted ids unchanged**; `w<n>` explicit ids bump `next`.
- **Snapshot stays schema 1**: the id field was already a free string.
- **`max` lives in core's `splitRefusal`** (m4 open question), unbounded by default, 4 in config
  (Zen's `MAX_TABS`, the size ADR-013's spike tested), 16 at most. (Since changed: the default is 8, because four panes leave a large screen half used (#691); `docs/guide.md`, "config.toml".)
- **Config schema 2, not additive v1**, with schema-2 keys gated on `schema = 2`, and the m1
  keys in the same bump.
- **`planSplit` takes the workspace**, not the bare tree: decision 14 needs its tab list.
- **`showVisually` added** to the planned plan shape: unzooming and dropping a zoomed-away tab
  must clear the hiding, and a declarative set would not be empty when nothing changes.
- **`planWorkspaceSwitch` has no `from`**: visibility is read from `tabsState`, so a plan also
  repairs tabs of a third workspace left visible; `to` defaults to the active workspace.
- **`unsplit` added** to the switch plan, for decision 14 violations it must not hide through.
- **A refused `splitPane` registers nothing.**
