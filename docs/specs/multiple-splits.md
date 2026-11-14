# Spec: multiple-splits

Status: implemented (sub-PRs 1 to 6; the pref of decision 17 is removed) · Area:
core (`packages/vimma-core/src/panes.mjs`, `splits.mjs` new, `sidepanel.mjs`, `snapshot.mjs`,
`statusbar.mjs`, `workspaces.mjs`, `theme.mjs`, `config.mjs`, `picker.mjs`, `actions.mjs`,
`defaults.mjs`), host (`split/PaneView.mjs`, `host/pane-ops.mjs`, `host/VimmaHost.sys.mjs`,
`workspaces/WindowWorkspaces.sys.mjs`, `ctl/VimmaControl.sys.mjs`), UI (`ui/side-panel.mjs`,
`ui/notice.mjs`, `ui/picker.mjs`, `side-panel.css`), `tools/vimma-ctl` (`protocol.rs`) · Upstream
patches: none · ADR: none

Issue: [#682](https://github.com/vimma-browser/vimma/issues/682)

## Summary

A workspace can hold several splits, up to `[panes] max_splits` (9), one shown at a time. Each
split has a number and a colour from the theme, which the side panel shows on its tabs, so the
splits of a workspace can be told apart at a glance. A split picker on `ctrl+b S` and `]s` / `[s`
move between them. Splitting a tab that is shown alone is still refused, with a message that
stays until the next key and names the way back; a second split is made by marking its tabs in
the side panel.

## Problem

A workspace holds one split at most. Picking a tab outside the split shows that tab alone and
keeps the split as a hidden view ([side-panel-unsplit](side-panel-unsplit.md), decisions 20-29).
Two problems follow:

- Starting a second piece of side-by-side work in the same workspace means going back to the
  hidden split and breaking it up first, because there is room for one tree only.
- On the lone tab, `ctrl+b v`, `ctrl+b -` and `ctrl+b enter` are refused with "the split is
  hidden: go to one of its tabs first" (side-panel-unsplit decision 29). The message is a notice
  that hides after 1.5 s (`NOTICE_MS`, `ui/notice.mjs:17`), so it is easily missed, and it does
  not say how to get back.

For example: a workspace "thesis" has an editor and a PDF side by side. The user opens a search
result alone to read it, then wants that page next to a reference page. Today the user must first
go back to the editor split and unmark its panes; afterwards the editor split is gone.

## Behaviour

1. **Several splits.** A workspace holds up to `[panes] max_splits` splits (default 9, accepted
   1 to 9). One is shown at a time, or none while a tab outside every split is shown alone.
2. **A tab is in one split at most.** Selecting a tab of a split, by any route of
   side-panel-unsplit decision 21, shows that split whole (its tree, sizes, zoom and focused pane,
   focus moving to that tab's pane), and every other split of the workspace is hidden. Selecting a
   tab that is in no split shows it alone and hides the shown split.
3. **Numbers and colours.** Each split has a number from 1 to 9, kept while it exists, and the
   colour of that number from the theme (`--vimma-split-1` to `--vimma-split-9`).
4. **Splitting the lone tab is refused, visibly.** While a tab outside every split is shown alone
   and the workspace has at least one split, `ctrl+b v`, `ctrl+b -` and `ctrl+b enter` are
   refused. The notice stays until the next key and says
   `split S2 is hidden: ]s or ctrl+b S to go back, or mark tabs in ctrl+b b for a new split`,
   naming the split shown last. With no split in the workspace, these keys split the tab as today.
5. **Starting another split.** In the side panel (`ctrl+b b`), marking two or more tabs with
   `space` or `V` and pressing `Enter` makes them a new split with the next free number, shown at
   once; the split shown before becomes hidden. A marked tab that belongs to another split leaves
   that split, which closes the pane as `ctrl+b x` does, and a split left with one pane ends.
   With `max_splits` splits already, the change is refused with
   `new split: at most 9 splits in a workspace`, nothing changes and the panel stays open.
6. **The side panel.** The rows of a split's tabs carry the split's colour as a stripe and its
   label (`S1` to `S9`) as text, so the split is told by more than colour. The shown split's tabs
   start marked, as today (side-panel-unsplit decision 1); hidden splits' tabs do not. The
   header reads, for a workspace with three splits and S2 shown, `S2: 3 panes · 3 splits`, and
   `3 splits (none shown)` on a lone tab; with one split it reads as today.
7. **The split picker.** `ctrl+b S` opens a picker listing the workspace's splits in number order:
   label, colour, pane count and the titles of the panes' tabs. `Enter` or the digit `1`-`9`
   shows that split; typing filters by title. With no split the picker says `no splits in this
workspace` and does not open.
8. **Stepping.** `]s` shows the next split by number, wrapping; `[s` the previous one. On a lone
   tab, both show the split shown last first. With no split they say `no splits` in a notice.
9. **The status bar.** While a split shows in a workspace with more than one, the pane segment
   reads `S2 pane 1/3`; with one split it reads `pane 1/3` as today. On a lone tab it reads
   `split 3 hidden` with one hidden split, as today, and `3 splits hidden` with several.
10. **Workspaces, restarts and the private workspace.** A workspace switch parks every split with
    its number; the session snapshot keeps them all, which one shows and the tab shown alone. The
    private workspace and the agent workspace behave the same.
11. **`vimma-ctl state`** lists every split of the window's workspace in a new `splits` field.
    `panes` keeps its meaning for older clients.
12. **Behind a pref until finished.** While `vimma.feature.multiple_splits` is `false` (the
    default until the last PR), Vimma behaves as today: one split, hidden or shown. Behaviour 4's
    notice is the exception: it ships first, alone, because it fixes today's missed message. The
    last PR removes the pref, and several splits are always on.
13. **A split made by Firefox's own commands** (its tab context menu, an extension) in a workspace
    that already has a split is still undone, as before, and the notice says how to make another
    one: `split undone: mark tabs in ctrl+b b for another split`.

## Research

All references are to `main` at aac585a5, Firefox 157.

- **The hidden view.** `Panes.hidden` marks a tree kept but not shown
  (`packages/vimma-core/src/panes.mjs:25-29`); `hideView` and `showView` set and clear it
  (`panes.mjs:641-656`), and `pickTab` decides what a selection does (`panes.mjs:659`). A
  workspace keeps one tree, `WorkspaceState.panes` (`workspaces.mjs:28`). The host keeps one
  tree per window in `PaneView` and refuses a split while it is hidden with `HIDDEN_REASON`
  (`split/PaneView.mjs:96`, used at `PaneView.mjs:402` and `427`).
- **Firefox's split view** wraps the tabs of one split in a `tab-split-view-wrapper`, and several
  wrappers can exist in one window: `addTabSplitView` creates one per call, and selecting a tab
  outside a wrapper suspends it (`#suspend`) and selecting one of its tabs activates it again
  (`#activate`) (`engine/browser/components/tabbrowser/content/tabsplitview.mjs`, Firefox 157).
  Several hidden Vimma splits therefore map to several suspended wrappers, without a patch;
  PaneView already rebuilds one wrapper per split (ADR-013).
- **The notice** hides after `NOTICE_MS` (1500 ms) unless given another time
  (`ui/notice.mjs:17`, `46-60`); it has no "until the next key" mode. The host shows pane
  refusals through it (`host/VimmaHost.sys.mjs:354-361`).
- **The snapshot** writes a hidden view as `panes.hidden: true` and the tab shown alone as
  `alone`, keeping `activeTab` on the focused pane's tab so an older Vimma restores the split
  shown (`snapshot.mjs:112-125`); it reads `alone` leniently (`snapshot.mjs:348-360`).
- **`state.panes`** is the window's tree or `null` (`ctl/VimmaControl.sys.mjs:288-312`);
  vimma-ctl requires the key to be present (`tools/vimma-ctl/src/protocol.rs:543-545`) and
  ignores fields it does not know. The field's shape is described in
  [m0-control-protocol-and-vimma-ctl](m0-control-protocol-and-vimma-ctl.md), "`state`".
- **Keys.** `prefix+shift+s`, `]s` and `[s` are unbound in `packages/vimma-core/src/defaults.mjs`
  (checked by grep). Normal mode already uses unimpaired-style pairs: `]w` / `[w` for workspaces
  and `]q` / `[q` for live grep results (`defaults.mjs:262-266`).
- **Theme.** Theme tokens come from the palette keys of an Omarchy 4 `colors.toml`
  (`theme.mjs`, `PALETTE_KEYS`). `--vimma-focus` is the accent moved toward black or white just
  far enough to reach 3:1 against every surface (`MIN_FOCUS_CONTRAST`, WCAG 2.x 1.4.11), the
  rule a non-text indicator such as a split stripe needs.
- **Agents.** The agent's `vimma_keys` runs an allowlist; every `pane.*` action is refused
  (`packages/vimma-core/src/agent-keys.mjs:114`, [mcp-drive](mcp-drive.md)). The agent role
  never reaches `state` ([security.md](../security/01-control-socket.md) S12).

## Design

### Decisions

1. **A list of splits per workspace.** `WorkspaceState` holds `splits: Split[]` and
   `shown: number | null` in place of one `panes` tree with a `hidden` flag, because a flag on
   one tree cannot say which of several trees shows. A `Split` is today's `Panes` tree plus its
   `number`. The pure functions live in a new `packages/vimma-core/src/splits.mjs`, because the
   pane operations in `panes.mjs` act on one tree and stay unchanged. Rejected: several `Panes`
   with `hidden: true` and one without, because "exactly one is not hidden" would be a rule every
   caller must keep instead of a shape. `WorkspaceState` also holds `last`, the split shown last,
   because behaviour 8 and the snapshot's `panes` both go back to it once none shows. The three
   fields are optional and `panes` stays beside them until the host keeps several splits
   (Delivery 3), because the host builds and saves `panes` today; `splitsOf` reads a workspace
   without them as its one tree, number 1.
2. **A tab belongs to one split at most**, so selecting a tab has exactly one answer and the side
   panel's labels are never ambiguous. Rejected: a tab in several splits, because selecting it
   would need a rule to pick a split the user cannot see.
3. **Splitting the lone tab stays refused**, because `ctrl+b v` on a tab shown alone is most often
   pressed by someone who expects their hidden split to still be on screen; starting a new split
   silently would hide that one further. The refusal costs nothing: no page, tab or split changes.
4. **The refusal notice stays until the next key and names the way back**, because the 1.5 s
   notice is missed and a refusal that does not say what to do instead leaves the user stuck.
   `Notice.show` gains `{ untilKey: true }`: the host hides it on the next keydown it sees, and a
   later notice replaces it. The text names the split shown last, the keys back (`]s`,
   `ctrl+b S`) and the way to a new split. Before the keys exist (behaviour 12) it reads
   `the split is hidden: select one of its tabs (ctrl+b b) to go back`.
5. **A second split is started from the side panel's marks**, because marking tabs and pressing
   `Enter` already makes a split ([m4-side-panel-multiselect](m4-side-panel-multiselect.md)), it
   needs no new key, and it is a deliberate act that cannot happen by the slip decision 3 guards
   against. The panel opens with no marks on a lone tab (behaviour 6), so marking starts from
   nothing. The cost is that the lone tab cannot be split with a fresh empty tab in one step.
   Rejected: a "new split" entry in the split picker, because the picker would then hold an
   action as well as a list (it can follow later without changing this decision); a dedicated
   key such as `ctrl+b V`, because it is one more default key to learn and to keep apart from
   `ctrl+b v`; and confirming with a second `ctrl+b v` while the refusal shows, because a quick
   double press would defeat the refusal's purpose.
6. **Marking a tab of another split moves it**, because the marks state the wanted panes
   (side-panel-unsplit decision 3) and the tab's label shows where it came from. Its pane closes
   in the old split as `ctrl+b x` closes it (side-panel-unsplit decision 15), so the other sizes
   stay; a split left with one pane ends and frees its number. Rejected: refusing the mark,
   because moving one page into a new comparison is a common reason to make a second split.
7. **`[panes] max_splits`, default 9, accepted 1 to 9**, so the picker's digits reach every split
   and the palette has a colour for each. `1` gives today's single split. A tenth split is
   refused with `new split: at most 9 splits in a workspace`, as `[panes] max` refuses a pane.
8. **Numbers are kept and reused lowest-first.** A split keeps its number while it exists; a new
   one takes the lowest free number, because a colour and label that changed when another split
   ended would point at the wrong split. Reusing keeps the numbers at most `max_splits`.
9. **The side panel's marks stay the shown split's.** Pre-marks are the shown split's panes, and
   on a lone tab there are none, because marks are the edit of one split (side-panel-unsplit
   decision 7) and pre-marking several splits at once would mix their edits. A hidden split is
   changed by showing it first (`]s`, the picker, or any of its tabs). This replaces
   side-panel-unsplit decision 26 for a lone tab.
10. **Colour plus label in the panel.** A split's rows get a 3 px stripe in `--vimma-split-N`
    beside the mark gutter and the label `S1`-`S9` in `--vimma-fg-dim`, because colour alone does
    not reach colour-blind users or screen readers. Each row's accessible name ends with
    `, split 2`, so a screen reader hears it without the colour.
11. **Split colours are a fixed palette in the theme.** Tokens `--vimma-split-1` to
    `--vimma-split-9` come from the palette keys `blue`, `green`, `magenta`, `yellow`, `cyan`,
    `orange`, `bright_blue`, `bright_green` and `bright_magenta`, in that order, so every Omarchy
    theme supplies them from its own `colors.toml` and every built-in theme from its palette.
    `red` is left out because Vimma uses it for errors. Each token is moved toward black or white
    just far enough to reach 3:1 against the side panel's and the picker's surfaces, as
    `--vimma-focus` is, so the contrast is checkable by the same code and test. `[theme.colors]`
    accepts `split_1` to `split_9` to override one, adjusted the same way. Rejected: hue rotation
    of the accent, because its output cannot be checked against a theme's own colours in advance
    and drifts from the theme's look.
12. **The split picker reuses the picker** (`ui/picker.mjs`, as the goto and tab-search pickers
    do), because filtering, digits, `Esc` and theming already work there. A row shows the colour
    swatch, `S2`, `3 panes` and the panes' tab titles joined with `·`, filtered by title. The
    filter starts with `/`, as in the workspace picker, because the bare keys are the picker's
    own: the digits, `j` / `k` and `q`.
13. **Keys: `ctrl+b S` for the picker, `]s` / `[s` to step**, because `S` reads as "splits" next
    to `ctrl+b w` for workspaces, and `]s` / `[s` follow `]w` / `[w` and `]q` / `[q`. On a lone
    tab both first show the split shown last, because going back is the common case. The actions
    are `pane.split_picker`, `pane.next_split` and `pane.previous_split`, under `pane.` so the
    agent's key filter refuses them with the rest of the layout keys. Vim's `]s` (next misspelled
    word) has no meaning on a web page, so nothing a Vim user expects is lost.
14. **Status bar.** `S2 pane 1/3` while a split shows in a workspace with several, else as today,
    and `3 splits hidden` (dim, cut first when space is short) on a lone tab with several, because
    the segment should say which split the user is in without growing for workspaces that have
    one.
15. **Snapshot: a list, with the old fields kept.** A workspace writes `splits` (each tree with
    its `number`), `shown` and `alone`, and also today's `panes` (the shown split, else the split
    shown last with `hidden: true`) and `activeTab`, so an older Vimma reading the file restores
    one split instead of failing. A file without `splits` reads `panes` as a one-item list with
    number 1. A `splits` entry that is malformed, repeats a number, or shares a tab with an
    earlier entry is dropped, so a damaged file never puts one tab in two splits. On reading,
    the shown split is the one holding the tab `activeTab` and `alone` name, and the split shown
    last the one holding the written `activeTab`, because an older Vimma that rewrites the file
    keeps those two fields current but not `shown`. A workspace without the new fields writes no
    `splits`, so a file is unchanged until the host keeps several splits.
16. **One Firefox wrapper per split.** PaneView keeps a wrapper for each split and lets Firefox
    suspend the hidden ones, because that is how Firefox's split view handles a selection outside
    a wrapper already (Research), and it needs no patch.
17. **A feature pref**, `vimma.feature.multiple_splits` (default `false`), because the feature
    lands over several pull requests and `main` must stay releasable
    ([CONTRIBUTING.md](../../CONTRIBUTING.md), "Unfinished features"). With it off, `max_splits`
    is treated as 1, the new `state` field is absent and the panel shows no labels. The last
    sub-PR removes the pref and every read of it, so `state.splits` is always present.
18. **A second split from Firefox's own commands is still undone** (behaviour 13), as
    [m4-split-panes](m4-split-panes.md) sub-spec 6 undoes it, because decision 5 makes the side
    panel's marks the one way to start another split: adopting Firefox's wrapper as a new split
    would need decision 7's limit and decision 8's numbering on an event path that cannot refuse
    with a message the user is looking at. The notice changes from `one split per workspace`,
    which is no longer true, to the way that works. Adopting such a split can follow in a later
    change without changing the model.

### Control protocol

`state` gains `splits`, added without a version bump because clients ignore fields they do not
know (the rule `panes` and `loading` were added under):

```json
"panes": { "focus": "12", "zoomed": false, "hidden": false, "root": { "tab": "12", "index": 0 } },
"splits": [
  { "number": 1, "shown": false, "focus": "7", "zoomed": false, "root": { "axis": "x", "ratios": [0.5, 0.5], "children": [ … ] } },
  { "number": 2, "shown": true, "focus": "12", "zoomed": false, "root": { … } }
]
```

- `splits`: the workspace's splits in number order, `[]` when it has none. Each has the shape of
  `panes` with `number` and `shown` in place of `hidden`. It lists tab ids and their places only,
  as `panes` does, so a private window's entry names no URL or title.
- `panes` keeps its meaning: the shown split, else the split shown last with `hidden: true`, else
  `null`, so a client written for side-panel-unsplit sees what it saw before.
- Read-only, like the rest of `state`. No new command: a split is shown by selecting one of its
  tabs or by `send-keys`.
- vimma-ctl's validator accepts `splits` when present and checks it is an array of objects with
  an integer `number` from 1 to 9 and a boolean `shown`; it stays optional, so vimma-ctl works
  with a Vimma that predates it.

## Security and privacy

- **The control socket (security-relevant).** `state` grows by one read-only field over tabs the
  window already lists. [security.md](../security/01-control-socket.md) S9 changes from "and the pane structure"
  to "and the pane structure of every split", with tests that `state` stays read-only with
  several splits and that a private window's `splits` carries no URL or title. S11's fuzzing of
  the validator covers the new field. The agent role still never reaches `state` (S12), so an
  agent learns nothing about the user's splits.
- **Agent keys.** The three new actions are `pane.*`, which `agent-keys.mjs` refuses; the test
  list of refused keys gains `]s`, `[s` and `ctrl+b S`. A pane of an agent split shown by
  `vimma_show` (security.md M19) shows its whole split, as today; `ctrl+^` returns to the split the
  user was in, because a workspace switch parks every split.
- **Snapshot.** The session file holds tab ids and tree shapes only, as today; decision 15's
  checks keep a damaged or edited file from putting a tab in two splits.
- **Theme.** `[theme.colors] split_N` values are validated as hex colours like every other
  colour key before they become CSS (`theme.mjs`), so they add no new injection path.

These changes go through a fresh security review in the PR that changes `state` (Delivery 3).

## Tests

Each test is written first and seen to fail.

### Vitest (`packages/vimma-core/test/`)

- `splits.test.mjs` (new): a new split takes the lowest free number; a split ending frees it;
  selecting a tab of split 2 shows 2 and hides 1; selecting a tab in no split hides all;
  marking a tab of split 1 into a new split moves it and closes its pane as `closePane`; split 1
  left with one pane ends; the tenth split is refused with behaviour 5's text; `max_splits = 1`
  gives today's single split; `]s` / `[s` order, wrapping, and the last-shown split first from a
  lone tab.
- `sidepanel.test.mjs`: pre-marks are the shown split's only; none on a lone tab; `Enter` with
  two marks on a lone tab gives a `together` effect for a new split; header texts of behaviour 6;
  row labels and accessible names (decision 10).
- `statusbar.test.mjs`: `S2 pane 1/3`, `pane 1/3` with one split, `split 3 hidden`,
  `3 splits hidden`.
- `snapshot.test.mjs`: several splits round-trip with numbers, `shown` and `alone`; the written
  `panes` is what an older reader expects; a file with only `panes` reads as one split; a
  repeated number or a shared tab is dropped.
- `theme.test.mjs`: every built-in theme and every Omarchy fixture theme gives nine split tokens
  at 3:1 or more on the panel and picker surfaces; a `split_3` override is used and adjusted; an
  invalid one is an error.
- `config-v2.test.mjs`: `max_splits` accepts 1 to 9 and refuses 0, 10 and non-integers.
- `control.test.mjs` and `fuzz/control.fuzz.test.mjs`: `state` with `splits` validates; a bad
  `splits` entry is refused.
- `agent-keys.test.mjs`: `]s`, `[s` and `ctrl+b S` are refused.
- Help and bindings snapshots regenerate with each keymap PR.

### Mochitest (`tests/browser/`)

- `browser_vimma_multiple_splits.js` (new, pref on): two splits in one workspace from the side
  panel; selecting a tab of each shows that split whole with its ratios and focus, the other's
  wrapper suspended; a lone tab hides both; moving a tab from split 1 into a new split; the tenth
  split refused; a workspace switch and back keeps both; a session restore (`setWindowState`)
  keeps both and the shown one; the private workspace with two splits.
- `browser_vimma_side_panel_unsplit.js`: the refusal notice stays after 2 s and hides on the next
  key (behaviour 4); everything else unchanged with the pref off.
- `browser_vimma_split_picker.js` (new): the picker lists splits with label, count and titles;
  digit and `Enter` show a split; the empty-workspace notice.
- `browser_vimma_control.js`: `state.splits` with two splits; `panes` as before.
- `browser_vimma_security_invariants.js`: `state` stays read-only with several splits;
  `browser_vimma_private_workspace.js`: private `splits` carry no URL or title.
- `tools/vimma-ctl` (`cargo test`): `state` with and without `splits` parses; a malformed one is
  refused.

### e2e (`tests/e2e/`)

- A scenario with two splits, `]s` between them, with a screenshot baseline of the side panel's
  colours and labels in a stock theme.

## Docs and changelog

- `docs/guide.md`: "Showing tabs together" gains "Several splits" (making a second one from the
  panel, `]s` / `[s`, `ctrl+b S`, `max_splits`); the "Side panel" section describes the labels
  and stripes; the pane keys table gains the three keys.
- `README.md`: the feature line on split panes mentions several splits per workspace.
- `defaults.toml` and `docs/bindings.md` regenerate (`npm run gen-docs`).
- [side-panel-unsplit](side-panel-unsplit.md): `(Since changed: …)` notes on decisions 24, 26,
  27, 28 and 29, pointing here, in the PR that changes each.
- [m0-control-protocol-and-vimma-ctl](m0-control-protocol-and-vimma-ctl.md): a "Since
  multiple-splits" sentence on `splits`, as decision 28 of side-panel-unsplit added `hidden`.
- `docs/security/01-control-socket.md`: S9 as in Security and privacy.
- `CHANGELOG.md` comes from the commit subjects (release-please).

## Delivery

Each PR is independently mergeable and tested; 2 to 4 sit behind `vimma.feature.multiple_splits`.
The keymap PRs come one at a time, because each regenerates the bindings docs and the help
snapshot.

1. **fix(panes): keep the hidden-split refusal on screen until the next key.** `Notice`'s
   `untilKey`, decision 4's text for today's single split. No pref, merges when green: a small
   user-visible fix.
2. **feat(panes): several splits per workspace in core.** `splits.mjs`, `WorkspaceState`,
   snapshot (decision 15), status bar text, theme tokens and `split_N` overrides, `max_splits`
   parsing. Vitest only; merges when green, nothing user-visible.
3. **feat(panes): several splits in the window, behind a pref.** PaneView with one wrapper per
   split, `WindowWorkspaces`, the side panel's labels, stripes, header and new-split flow, the
   refusal text naming the split, `state.splits` and vimma-ctl's validator,
   `docs/security/01-control-socket.md` S9, the control protocol note. Security-relevant (the
   control socket): a fresh review before merging; merges when green, since the pref is off.
4. **feat(panes): the split picker and the step actions, unbound, behind the pref.** The actions
   in `actions.mjs` without default keys, the picker. Merges when green.
5. **feat(keys): ctrl+b S opens the split picker.** Keymap change; stops at ready.
6. **feat(keys): ]s and [s step between splits; enable multiple splits.** Keymap change, removes
   the pref and its reads, adds the guide, README and `defaults.toml` text and the `Since changed`
   notes, the e2e scenario, behaviour 13's notice, sets this spec `implemented`. A default-key
   change and a big feature: stops at ready.

## Open questions

None: issue #682's question 1 is answered by decision 5.
