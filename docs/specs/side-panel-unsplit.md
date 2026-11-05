# Spec: side-panel-unsplit

Status: implemented (revised after testing: hidden views, option B) · Milestone: after M4 (builds on
[m4-side-panel-multiselect](m4-side-panel-multiselect.md), [m4-split-panes](m4-split-panes.md) and
[tiling-layouts](tiling-layouts.md)) · Area: `packages/vimma-core/src/sidepanel.mjs`,
`layouts.mjs`, `panes.mjs`, `snapshot.mjs`, `statusbar.mjs`, `actions.mjs`; `ui/side-panel.mjs`,
`split/PaneView.mjs`, `host/pane-ops.mjs`, `host/VimmaHost.sys.mjs`,
`workspaces/WindowWorkspaces.sys.mjs`, `ctl/VimmaControl.sys.mjs`, `side-panel.css`. No upstream
patch.

## Goal

Undo a split from the side panel the same way it was made. When the panel opens on a split, it
shows which tabs are the panes, already marked, and unmarking a pane takes it out of the split,
as marking tabs put them in.

Picking one tab that is not in the split shows that tab alone. The split is not lost: it is kept
in the background as a view, as Firefox's own split view does, and picking any of its tabs brings
it back whole. With three panes marked, `space` on one of them unmarks it so that it leaves the
split, and `Enter` on that row then shows it. A new tab (a link, `ctrl+t`) still opens in the
focused pane; only picking an existing tab outside the view shows it alone. The sections below
call this behaviour option B.

## User stories

- As a user with a split (say editor, docs and chat as three panes), `ctrl+b b` opens the side
  panel with those three tabs already marked, so I can see at a glance which tabs are the panes.
- As a user, `space` on a marked pane row unmarks it, as it does for any mark. Applying the change
  takes that tab out of the split; the tab stays open as an ordinary tab of the workspace, and the
  other panes stay shown together. No page reloads.
- As a user, unmarking until one tab is left and applying ends the split: that tab is shown alone.
- As a user, `space` on a tab that is not a pane marks it, and applying adds it as a pane, within
  `[panes] max`.
- As a user, I can add and remove in one go: unmark one pane, mark another tab, apply once.
- As a user, opening the panel only to jump to a tab (`j`/`k`, `Enter`, or a digit) still works
  while a split exists; the pre-marked panes do not get in the way (decision 12). A tab outside
  the split then shows alone, and the split waits as a hidden view (decision 21).
- As a user with panes A, B and C, I unmark C with `space` and press `Enter` on C: A and B stay a
  view (hidden), and C shows alone in the whole window (decision 25).
- As a user, picking any tab of a hidden view, by any route, brings the whole view back with its
  sizes and its focused pane (decision 23). The status bar tells me a hidden view exists.
- As a user, a link I open in a new foreground tab from a pane, or `ctrl+t`, still opens in that
  pane (decision 22, m4-split-panes' user story).
- As a user, I can back out of my changes without touching the split (decision 13).
- As a screen-reader user, I hear the pane rows as checked when the panel opens on a split, and
  the header tells me how the split will change.

## Research

All references are to `main` at 27972ab.

### How marks work today

- The panel's state is `PanelState` (`packages/vimma-core/src/sidepanel.mjs:30-35`): rows, the
  highlight `selected`, `marked` (tab ids in row order) and `anchor` (an open `V` range).
- `openPanel` always starts with no marks: `marked: Object.freeze([])`, `anchor: null`
  (`sidepanel.mjs:114-115`).
- `space` is `panel.mark` (`packages/vimma-core/src/defaults.mjs:212`): it toggles the
  highlighted row's mark and moves down, refusing a pinned row (`sidepanel.mjs:241-256`). `V` is
  `panel.visual` (`defaults.mjs:213`, `sidepanel.mjs:257-262`); `markRange` adds the range to the
  marks (a union, pinned rows skipped) (`sidepanel.mjs:192-198`).
- `Esc` (`panel.close`) ends a range, then clears every mark, and only then closes the panel
  (`sidepanel.mjs:270-277`).
- A refresh (a tab opened, closed, retitled, moved) keeps the marks on tabs still listed in the
  same workspace; a workspace switch inside the panel (`ctrl+b )`) drops them
  (`sidepanel.mjs:129-140`).
- The UI shows a mark as a `●` in a gutter plus a bar (`ui/side-panel.mjs:226-231`), sets
  `aria-checked` on every row while anything is marked or a range is open
  (`ui/side-panel.mjs:216`, `228`), and the header's `role="status"` count reads "2 marked"
  (`markSummary`, `sidepanel.mjs:178-185`; `ui/side-panel.mjs:208-210`, `265-267`).
- The host routes `panel.mark` / `panel.visual` to the side panel only, never the bookmarks panel
  (`host/VimmaHost.sys.mjs:587-592`). Marks are the side panel's only kind of mark; there is no
  other feature that marks tabs today.

### How a split is made from marks

- `Enter` is `panel.open` (`defaults.mjs:206`). With an open range it marks the range first; with
  marks it calls `openMarked`; without marks it goes to the highlighted row
  (`sidepanel.mjs:236-240`).
- `openMarked` (`sidepanel.mjs:206-213`): one mark is a plain `select` effect (go to that tab);
  two or more are a `together` effect with the ids in row order and the focus on the highlighted
  row when it is marked, else the first marked.
- The UI hands `together` to the host and closes the panel unless the host refuses
  (`ui/side-panel.mjs:134-138`). The host wires it to `showTabs` (`VimmaHost.sys.mjs:980`).
- `showTabs` (`host/pane-ops.mjs:124-138`) gives lazy tabs a browser (`insertBrowser`,
  `pane-ops.mjs:133`) and calls `PaneView.showTabs` (`split/PaneView.mjs:432-449`), which checks
  `togetherRefusal` (`layouts.mjs:265-271`) and replaces the tree with `showTogether`
  (`layouts.mjs:283-292`).
- `showTogether` builds a **new** tree: a row of the tabs re-arranged with the workspace's stored
  preset, else `[panes] layout` (`togetherName`, `layouts.mjs:253-256`). The old tree's shape and
  any manual resizes are not kept. It throws for fewer than two tabs (`layouts.mjs:284`).
- Membership is already a diff (m4-side-panel-multiselect decision 10): tabs of the old split that
  are not marked leave it and stay open; new ones join. `PaneView.#membership`
  (`split/PaneView.mjs:681-705`) rebuilds Firefox's wrapper when a tab leaves
  (`unsplitTabs` + `addTabSplitView`, `PaneView.mjs:692-696`, ADR-013), which moves panels and
  never recreates a `<browser>`.

So "unsplit by unmarking" already half works today, but only if the user re-marks every pane they
want to keep by hand: nothing pre-marks the panes, and one mark does not end the split (below).

### What the side panel shows for tabs that are panes

- Nothing. A row carries `tabId`, `number`, `display`, `host`, `active`, `foreign`, `playing`,
  `pinned` (`sidepanel.mjs:87-98`); there is no pane field.
- The panel's model comes from `pickerWorkspaces` (`VimmaHost.sys.mjs:946-951`), which
  deliberately sets `panes: null` on every workspace (`host/goto.mjs:48`). The workspace model does
  carry each workspace's tree elsewhere (`WorkspaceState.panes`, `workspaces.mjs:26-28`, filled by
  `WindowWorkspaces.sys.mjs:946-958`), but the panel never sees it.
- The only hint of a split is `active`, the workspace's active tab, which during a split is the
  focused pane's tab (`WindowWorkspaces.sys.mjs:957`).
- Pane leaves are keyed by `linkedPanel` (`PaneView.mjs:433`), and the panel's row ids are the
  `linkedPanel` too (a uuid only for a lazy tab, `goto.mjs:41`). A pane always has a panel, so pane
  ids and row ids match directly.

### What closing or removing a pane does today

- `prefix+x` / `:q` is `pane.close` (`defaults.mjs:72`, `actions.mjs:80`) →
  `closePane` in `host/pane-ops.mjs:172-181` → `PaneView.close` (`PaneView.mjs:468-472`) → core
  `closePane` (`panes.mjs:377-392`). It closes the **focused** pane only; its tab stays open.
- Core `closePane` keeps the rest of the tree: the sibling before the closed pane (or after it,
  for the first) absorbs its share (`panes.mjs:385-386`); focus moves to that sibling's first leaf
  when the closed pane had it (`panes.mjs:390`); a zoom ends (`focused`, `panes.mjs:131-134`). The
  stored preset name is kept (`panes.mjs:23-24`, tiling-layouts decision 5), but the tree is not
  re-arranged: a dwindle of four minus one is no longer a dwindle of three.
- `PaneView.#set` (`PaneView.mjs:528-535`): a tree of one leaf is no split; the split is removed
  and the remaining tab is selected.
- Closing a pane's tab (`#onTabClose`, `PaneView.mjs:538-546`) and moving it to another workspace
  (`release`, `PaneView.mjs:259-262`) both close its pane the same way.
- Where a removed tab lands in the tab strip: on a rebuild, Firefox's `unsplitTabs`
  (`engine/browser/components/tabbrowser/content/tabsplitview.mjs:381-414`) moves every member
  right after the wrapper, in order, then `addTabSplitView(kept, { insertBefore: kept[0] })` wraps
  the kept tabs again. Reading the code, the removed tab ends up directly after the new split, so
  it shows as the row after the split's rows in the panel. The mochitest must pin this.
- There is no "unsplit" action, and no tmux `break-pane` or Vim `<C-w>o` ("only"); `<C-w>o` is
  `pane.zoom` in Vimma (`defaults.mjs:155`).

### Why one mark does not unsplit today

`Enter` with one mark is a `select` (`sidepanel.mjs:208-209`); the host sets `selectedTab`
(`VimmaHost.sys.mjs:972-978`). With a split, `PaneView.#onTabSelect` (`PaneView.mjs:558-568`)
then focuses that pane if the tab is a pane, or **replaces the focused pane's tab** with it
(`setPaneTab`, `PaneView.mjs:566`) if it is not. So today the split survives, and
"unmark down to one" needs new behaviour.

## Decisions

Decisions 1–11 follow the goal above. Decisions 12–19 are the answers to the open questions
([Decided questions](#decided-questions)): every recommendation was taken.

1. **Pre-marked panes.** When the panel opens, or lists another workspace after `ctrl+b )`, and
   that workspace has a split, every pane's tab starts marked, with the same marks, gutter `●`,
   bar and `aria-checked` as multiselect. Without a split, the panel opens with no marks, as
   today.
2. **One kind of mark.** `space` and `V` work exactly as today on pre-marked rows: `space` on a
   pane row unmarks it, on any other row marks it. No new mark key.
3. **What applying means.** The marks after editing are the wanted set of panes:
   - two or more marked: those tabs are the panes (tabs no longer marked leave, new ones join);
   - one marked: no split; that tab is shown alone and selected;
   - pages move, never reload (the existing `reconcile` path).
4. **Removed tabs stay open** as ordinary tabs of the workspace, as after `prefix+x`. Nothing is
   closed by unmarking.
5. **Limits and refusals as multiselect.** More than `[panes] max` marked is refused with
   "Show together: at most N panes", nothing changes, and the panel stays open with its marks.
6. **The baseline follows the window.** The core keeps the split's tabs as `panes` in the panel
   state. A refresh recomputes it from the window (a pane closed with `x` meanwhile is no longer a
   pane), keeps the user's edits on rows still listed, and a workspace switch resets marks to that
   workspace's panes.
7. **Pure core.** `openPanel` / `refreshPanel` take the split's tab ids through `PanelOptions`
   (`panes: string[]`), filled by the host from `PaneViews.get(win).panes` (`leaves(...).tab`), so
   `pickerWorkspaces` stays as it is for the pickers. `panelKey` decides the effect from `marked`
   versus `panes`; `vimma-core` imports nothing from Firefox.
8. **New effect for "one left".** Core emits `{ type: "alone", id }` when a split goes down to one
   marked tab, so the host ends the split before selecting (a plain `select` would replace the
   focused pane's tab, see Research). `PaneView` gains `showAlone(tab)`: `#set(null)` then select
   the tab.
9. **One pure function for the new tree.** Core gets `repane(panes, ids, options)` in
   `layouts.mjs`, so the host does not combine `closePane` calls itself: removals only keep the
   shape (`closePane` per removed pane, decision 15), any addition re-arranges with
   `showTogether` (decision 15).
10. **Private workspace.** Works the same: the private window has its own `PaneView`
    (private-workspace.md, "Split view and PaneView"), and its panel model goes through the same
    `SidePanel`.
11. **Help and bindings.** `panel_open`'s and `panel_close`'s help text change to say what they
    now do with a split; `help.test.mjs.snap` and `docs/bindings.md` are regenerated with a
    changelog line. No new default key (decision 12).

12. **Applying is `Enter` (question 1a).** `Enter` applies when the marks differ from the
    split's panes. With the marks unchanged it goes to the highlighted row's tab (a pane: that
    pane gets focus; another tab: it shows alone and the split is hidden, decision 21, replacing
    "it replaces the focused pane's tab"). Digits still go to their row. No new key.
13. **`Esc` (question 2a).** An open range ends first, as today. Then: marks unchanged from the
    split, `Esc` closes the panel at once; changed, the first `Esc` puts the marks back to the
    split's panes and the second closes. Without a split `Esc` is as today (clear, then close).
14. **Zero marks (question 3a).** Unmarking every pane of a split and pressing `Enter` ends the
    split and shows the highlighted row's tab alone (the `alone` effect). One mark left: decision 25.
15. **Layout (question 4).** Removals only: each removed pane closes as `prefix+x` closes it (the
    neighbour takes its space, the other sizes stay, the stored preset name is kept, a zoom ends).
    Any addition, with or without removals: the whole set is re-arranged as multiselect does
    (stored preset, else `[panes] layout`).
16. **What the panel shows (question 5b).** The header reads "split: 3 panes" while the marks
    match the split, "split: 3 → 2" after a change, and "split: 3 → 1 (unsplit)" or
    "split: 3 → 0 (unsplit)" when applying would end it; an open range is added as today
    ("range: 2 · split: 3 → 4"). A pane row that is unmarked shows `○` in the gutter (a pane that
    will leave) instead of a blank; marked rows keep `●`.
17. **Focus (question 6b), revised by decision 25.** After applying, the highlighted row's pane has
    focus when that row is marked; else the pane that had focus, if it is still marked; else the
    first marked row. (The first version put the kept pane before the highlighted row; `Enter` on a
    row is meant to switch the view to it, so the row comes first.)
18. **The removed tab's place (question 7a).** It stays where Firefox's rebuild leaves it, right
    after the split; Vimma moves no tab.
19. **One kind of mark (question 8a).** Pre-marks are ordinary marks; a future feature that uses
    marks decides then how it treats them.

### Revision after testing: hidden views (option B)

20. **A hidden view.** A split can be kept while not shown: its tree (panes, sizes, focused pane,
    zoom, preset) stays, and another tab of the workspace shows alone in the whole window. Core:
    `Panes.hidden: true` (optional, like `layout`; every pane operation keeps it), `hideView`,
    `showView`. This is how Firefox's own split view behaves: selecting a tab outside it suspends
    it (`tabsplitview.mjs` `#suspend`), selecting one of its tabs activates it again with its
    widths (`#activate`). Vimma used to override that (`PaneView.#onTabSelect`'s `setPaneTab`);
    now it follows it for picks.
21. **Picking an existing tab outside the view shows it alone; the view is hidden.** Every route:
    the side panel's `Enter` and digits, the `ctrl+b g` picker, `ctrl+tab`, `alt+1..9`,
    `ctrl+b 1..9`, `ctrl+b n` / `p`, `gt` / `gT`, a click on a tab, the URL bar's switch-to-tab.
    A pinned tab did this already ("the tree waits"); it is now the same hidden state.
22. **A new foreground tab still opens in the focused pane** while the view shows (m4-split-panes'
    user story): `ctrl+t`, `ctrl+b c`, `t`, `:tabnew`, `P`, a link opened in a new foreground tab
    (also `f` on a `target=_blank` link), `vimma-ctl open` and routed links. A new tab is told from
    a pick by its `TabOpen` coming just before its `TabSelect`, in the same task (as
    WindowWorkspaces' `#adopt` already relies on). While the view is hidden a new tab shows alone
    and the view stays hidden.
23. **A hidden view comes back whole** when any of its tabs is selected, by any route: the same
    tree, sizes and zoom, focus on that tab's pane. If something else selects a view's tab while
    it is hidden (Firefox picking the next tab after a close), the view shows again on the next
    reconcile.
24. **Kept across switches and restarts.** A workspace switch parks the tree with its `hidden`
    flag. The session snapshot writes `panes.hidden: true` and the workspace's `alone` (the tab
    shown alone). `activeTab` stays the focused pane's tab, so an older Vimma reading the file
    restores the split shown instead of failing; this Vimma restores the view hidden with `alone`
    selected. (Since changed: a workspace keeps several splits, and the snapshot writes them all
    in `splits` with `shown`, keeping `panes` and `activeTab` for an older Vimma;
    [multiple-splits](multiple-splits.md), decision 15.)
25. **The side panel's `Enter`** (replaces the first version's 3 "one marked: that tab is shown
    alone" and 12 where they differ). It applies the mark changes, then goes to the highlighted
    row:
    - marks unchanged: the highlighted row's tab (decision 12, with 21 and 23);
    - two or more marked: the marked tabs become the view; the highlighted row's pane gets focus
      when it is marked; when the highlighted row is a pane the change just removed
      (`space` on C, `Enter` on C), that tab shows alone and the new view is hidden; any other
      highlighted row: the new view shows, focus per decision 17;
    - one or no mark with a split: the split ends; the highlighted row's tab shows alone when it
      was one of the removed panes or nothing is marked, else the one marked tab;
    - without a split, one mark goes to that tab (multiselect decision 5).

    A simpler rule, "then it goes to the highlighted row" in every case, was rejected. Taken
    literally, multiselect's documented flow (`space` on each of three tabs, `Enter`) would show the
    row below the last mark alone and hide the new view, because `space` moves down; and marking one
    or more panes is meant to create a view. So an unrelated unmarked row under the highlight does
    not hide a view the marks just created or changed. (Since changed: `space` leaves the highlight
    on the row it marks, because the next row to mark may be above or below; docs/guide.md, "Side
    panel".)

26. **The panel and a hidden view.** The panel lists a hidden view's tabs marked, as a shown one's,
    and the header says `split: 3 panes (hidden)` while the marks match it. (Since changed: on a
    tab shown alone nothing starts marked, because marks there start a new split; the header
    still says `split: 3 panes (hidden)` with one split and `3 splits (none shown)` with several;
    [multiple-splits](multiple-splits.md), decision 9 and behaviour 6.)
27. **The status bar** shows `split 3 hidden` where `pane n/m` would be, while the workspace has a
    hidden view (dim, cut first when space is short). (Since changed: with several splits it shows
    `3 splits hidden`, and `S2 pane 1/3` while one shows; [multiple-splits](multiple-splits.md),
    decision 14.)
28. **`vimma-ctl state`** gives `panes.hidden: true` for a hidden view (`false` otherwise; the
    control protocol spec says so). (Since changed: `state.splits` lists every split of the
    workspace; `panes` keeps this meaning; [multiple-splits](multiple-splits.md), "Control
    protocol".)
29. **Pane keys while a view is hidden** act on the tab shown alone as on a single pane: the
    `<C-w>` family is not runnable (so `ctrl+w` passes to Firefox), `ctrl+b x` / `:q` close the
    tab, `ctrl+b space` says "only one pane". `ctrl+b v` / `-` / `enter` are refused with "the
    split is hidden: go to one of its tabs first", so a second split never replaces the hidden
    one. Splitting the shown tab and dropping or merging the hidden view was rejected:
    refusing loses nothing.
    (Since changed: the refusal reads "the split is hidden: select one of its tabs (ctrl+b b) to
    go back" and stays until the next key;
    [multiple-splits](multiple-splits.md), decision 4.) (Since changed again: it names the split
    and the keys back, "split S2 is hidden: ]s or ctrl+b S to go back, or mark tabs in ctrl+b b
    for a new split", and a second split is made from the side panel's marks;
    [multiple-splits](multiple-splits.md), decisions 4 and 5.)

### Behaviour changes (option B)

1. Picking an existing tab outside a split (decision 21's routes) used to show it in the focused
   pane, the split staying on screen and the pane's old tab staying open. Now it shows alone and
   the split is hidden until one of its tabs is selected. There is no longer a way to put an
   existing tab into a pane by picking it; mark it in the side panel instead.
2. A pinned tab selected during a split looks the same as before (alone); the split is now marked
   hidden, so the status bar shows it and a later reconcile (a resize, a closed tab) no longer
   brings the split back on its own.
3. The side panel's `Enter` or digit on an unmarked row with unchanged marks shows that tab alone
   (it used to replace the focused pane's tab).
4. The side panel's `Enter` on a pane just unmarked shows it alone and keeps the rest as a hidden
   view (decision 25); with one mark left and the highlight on a removed pane, the highlighted
   tab shows alone instead of the marked one.
5. Focus after a changed `Enter`: the highlighted row first, then the kept focused pane (decision
   17 revised).
6. New: the status bar's `split N hidden`, the panel's `(hidden)`, `vimma-ctl state`'s
   `panes.hidden`, and the snapshot's `panes.hidden` / `alone`.
7. While a view is hidden, `ctrl+b v` / `-` / `enter` are refused (decision 29); before, the
   pinned-tab case split the hidden tree.
8. The side panel's `Enter` on an unchanged split with the highlight on an unmarked row no
   longer puts that tab in the focused pane (3 above); the multiselect mochitest's last task
   changed with it.

Unchanged: new foreground tabs open in the focused pane (decision 22); new panes (`ctrl+b v`,
`-`, `enter`); a tab of another workspace switches workspaces; the address bar loads into the
focused pane.

## Sub-PRs

1. **core: pre-marks, the split diff and hidden views** (`sidepanel.mjs`, `layouts.mjs`,
   `panes.mjs` `hideView` / `showView` / `pickTab`, `snapshot.mjs`, `statusbar.mjs`,
   `actions.mjs` help text; Vitest only). `PanelState.panes`; `openPanel` / `refreshPanel` with
   `panes`; `panel.open` / `panel.close` per decisions 12–14; the `alone` effect;
   `markSummary` text per decision 16; `repane` per decision 15.
2. **host + UI: show and apply** (`ui/side-panel.mjs`, `side-panel.css`, `PaneView.mjs`,
   `pane-ops.mjs`, `VimmaHost.sys.mjs`; mochitest; guide, README, footer hint). The host passes the
   split's tabs, wires `alone`, and `PaneView.showTabs` keeps or re-arranges the tree per
   decision 15.

Sub-PR 2 depends on 1. If the answers leave the change small, the two can land as one PR.

## Test plan

TDD as in [CONTRIBUTING.md](../../CONTRIBUTING.md): each test is written first, run red, and its red output pasted in the PR.

### Vitest (`packages/vimma-core/test/`)

- `sidepanel.test.mjs`
  - `openPanel` with `panes: [a, c]` marks `a` and `c` (row order), `anchor` null; without
    `panes` (or `[]`) no marks, as today.
  - `space` on a pre-marked row unmarks it and moves down; on another row marks it.
  - `Enter` with marks equal to the panes: go to the highlighted row, the `select` effect
    (decision 12).
  - `Enter` after unmarking one of three: `together` with the two left, in row order, focus per
    decision 17.
  - `Enter` after unmarking two of three: `alone` with the one left.
  - `Enter` after unmarking all: `alone` with the highlighted row (decision 14).
  - `Enter` after marking an extra tab: `together` with four; after unmarking one and marking
    another: `together` with the new set.
  - `Esc` with changed marks / unchanged marks: decision 13.
  - `refreshPanel`: a pane tab closed while open leaves both `panes` and `marked`; a user's unmark
    survives a refresh; a workspace switch resets marks to the new workspace's `panes`.
  - `markSummary` with a split, unchanged and changed, per decision 16.
  - A range (`V`) over pre-marked and unmarked rows unions as today.
- `layouts.test.mjs`: `repane` on a dwindle of four minus one keeps the other ratios and the
  preset name, ends the zoom, moves focus as `closePane`; with an added tab it equals
  `showTogether`.
- Default keys still reach the actions through the dispatcher; snapshots of help and defaults
  regenerated, with a changelog line in the PR.

### Mochitest (`tests/browser/browser_vimma_side_panel_unsplit.js`, new)

- Three panes; `ctrl+b b` shows those three rows with `●` and `aria-checked="true"`, the others
  `aria-checked="false"`, and the header text per decision 16.
- No split: the panel opens with no marks and no `aria-checked`, as
  `browser_vimma_side_panel.js` and the a11y test already expect.
- Unmark one, apply: two panes left, the removed tab still open, not hidden, in the workspace,
  right after the split (decision 18); no reload (same `<browser>`, `outerWindowID`, a JS marker,
  a typed field value and scroll position kept, as `browser_vimma_side_panel_marks.js` measures).
- Unmark down to one, apply: `PaneViews.get(win).panes` is null, that tab is selected and has
  focus, the other tabs are open.
- Mark an extra tab, apply: four panes; past `[panes] max` refused, nothing changed, panel open.
- Remove one and add one in a single apply.
- The layout of the panes that remain, per decision 15 (tree shape and ratios asserted).
- Focus after apply, per decision 17.
- `Esc` and plain `Enter` behaviour with the pre-marks, per decisions 12 and 13.
- `ctrl+b )` inside the panel to a workspace with its own split shows that split's marks.
- The private workspace: one case with two private panes, unmark one, apply.
- Existing suites stay green unchanged: `browser_vimma_side_panel.js`,
  `browser_vimma_side_panel_marks.js`, `browser_vimma_a11y.js`, the pane suites.

### Tests for the revision (hidden views)

- Vitest `panes.test.mjs`: `hideView` / `showView`; `pickTab` for a pane (focus; a hidden view
  shown), an outside pick (hidden), a new tab (replaces the focused pane's tab; while hidden,
  nothing), a pinned tab (hidden); every pane operation keeps `hidden`.
- Vitest `snapshot.test.mjs`: a hidden view round-trips with `alone`; `activeTab` stays the
  focused pane's tab in the file; a file without `alone` or with a bad one restores it shown.
- Vitest `sidepanel.test.mjs`: decision 25's cases, `(hidden)` in the header; `statusbar.test.mjs`:
  `split 3 hidden`.
- Mochitest `browser_vimma_side_panel_unsplit.js`: the unsplit flow (three panes, `space` on C,
  `Enter` on C: C alone, A and B a hidden view), a pick of each route kind (`selectedTab =`, the
  picker, `ctrl+b n`), the view back whole with its ratios and focus, a new foreground tab in the
  focused pane, the status bar marker, the panel's `(hidden)`, a workspace switch and back, and a
  session restore (`setWindowState`) keeping the view hidden.
- `browser_vimma_pane_workspaces.js`'s "selected from outside the split" task follows decision 21.
- e2e: `m4-split-panes` and `m3-crash-restore` open pages with `vimma-ctl open` (new tabs,
  decision 22), so their flows stay; rerun both.

## Docs to update

- `docs/guide.md`'s paragraph on picking a tab during a split (decision 21), and its "Side panel" table (`Enter`, `Esc`, `space` rows) and "Showing tabs together":
  a paragraph on changing or ending a split from the panel, with an example.
- `README.md` feature list, the "Side panel" line: mention that the panel shows the split and can
  shrink or end it.
- The panel's footer hint (`ui/side-panel.mjs:263`) if keys or wording change.
- `actions.mjs` help text for `panel_open` / `panel_close`; regenerate `docs/bindings.md`
  (`npm run gen-docs`).
- `CHANGELOG.md` `[Unreleased]`: added by the maintainer at merge time ([CONTRIBUTING.md](../../CONTRIBUTING.md)), not in the PR.
- This spec's Results section when done.

## Out of scope

- A key or `:` command outside the panel to end or shrink a split (a tmux `break-pane` or Vim
  `<C-w>o` "only"); `prefix+x` already closes one pane.
- Reordering panes from the panel (mark order is row order, as multiselect decision 6).
- Marks across workspaces; marks in the bookmarks panel; mouse selection.
- Keeping marks after the panel closes.
- Showing parked splits of other workspaces anywhere but when the panel lists that workspace.

## Results

Two stacked PRs on this spec: core (pre-marks and the split diff; then `hideView` / `showView` /
`pickTab`, the snapshot's `hidden` / `alone`, the panel's decision 25 and `(hidden)`, the status
bar's `split N hidden`) and host + UI (`PaneView` picks, `#sleep`, `showTabs` with `alone`,
`showAlone`, the panel, `vimma-ctl state`, the workspace snapshot, docs). The help text moved from
the core PR to the host PR, so the only snapshot change sits with its CHANGELOG line.

- **Red/green, first version:** Vitest 26 red, then green; the mochitest
  `browser_vimma_side_panel_unsplit.js` 21 red, then green.
- **Red/green, revision:** Vitest 17 red (`hideView`, `pickTab`, the snapshot's `alone`, the panel's
  decision 25, `split 3 hidden`), green after (2807 passed). Mochitests 15 red (the unsplit flow,
  every route, the restore, the pane_workspaces rewrite), green after; one more red found by the
  screenshot (below), green after. The whole `tests/browser/` suite: 5104 passed, 0 failed.
- **Found by the screenshot:** after the panel's `Enter` on C, the rebuilt wrapper kept A's and B's
  panels active (Firefox's suspend runs on a TabSelect, and C was already selected), so A's blank
  panel covered C's left half. `#sleep` now suspends them as Firefox does
  (`suspendSplitViewPanels`); the mochitest asserts the panels are suspended and C is what shows.
- **Confirmed in the browser:** the removed tab sits right after the split (decision 18); a pick
  hides the view and any of its tabs brings it back at its widths and focus; a new foreground tab
  still lands in the focused pane; the hidden view survives a workspace switch and a session
  restore (`setWindowState`).
- **e2e:** `m4-split-panes` and `m3-crash-restore` needed no change: they open pages with
  `vimma-ctl open`, a new tab (decision 22). Locally their state steps pass; the screenshot steps
  differ by font rendering exactly as on `main` (same percentages), so CI is the reference.
- **Not covered by a mochitest:** the private workspace (same `SidePanel` and `PaneView` code).

## Decided questions

Each of these changes what the user sees. In each case the recommendation was taken (decisions
12–19).

1. **What key applies the change, and what does plain `Enter` do while the panes are pre-marked?**
   Today `Enter` with marks shows the marked tabs together, and without marks goes to the
   highlighted tab. With a split the panel always opens with marks, so `Enter` would always mean
   "apply", and there would be no way to jump to a tab with `Enter`.
   - (a) `Enter` applies when the marks differ from the split; when they are unchanged it goes to
     the highlighted tab as today (a pane: focus that pane; another tab: it replaces the focused
     pane's tab, as today's picker does). Digits keep going to their row.
   - (b) `Enter` always applies the marks; going to a tab needs the digits.
   - (c) A separate key applies (for example `p` for "panes", unbound in `[modal.panel]`; `s`
     is taken by the bookmarks panel's `bookmarks.open_vsplit`, `defaults.mjs:222`); `Enter`
     always goes to the highlighted tab.

   Recommendation: (a). It is the key that made the split, so undoing works the same way, and it
   keeps `Enter` as "go" when the panel was opened only to move.

2. **What does `Esc` do with pre-marked panes?** Today `Esc` clears all marks first and closes the
   panel on a second press, so with a split it would take `Esc Esc` every time.
   - (a) Unchanged marks: `Esc` closes at once. Changed marks: the first `Esc` puts the marks back
     to the split's panes, the second closes.
   - (b) `Esc` always closes and discards any changes.
   - (c) As today: first clears every mark, second closes.

   Recommendation: (a). One `Esc` to leave when nothing changed, and an undo when something did.

3. **Unmarking every pane (zero marks), then applying.** Is that "end the split" too, and which
   tab is then shown?
   - (a) End the split and show the highlighted row's tab alone.
   - (b) End the split and show the focused pane's tab alone.
   - (c) Nothing happens to the split; `Enter` just goes to the highlighted tab (today's
     no-marks `Enter`).

   Recommendation: (a): that row is highlighted when the key is pressed.

4. **The layout of the panes that remain after removing one.**
   - (a) Keep the shape: each removed pane closes as `prefix+x` closes it (its neighbour takes its
     space, the other sizes stay); the stored preset name is kept for `ctrl+b space`.
   - (b) Re-arrange: the remaining panes are laid out fresh in the workspace's layout (stored
     preset, else `[panes] layout`), exactly as multiselect does today; manual resizes are lost.

   When a tab is **added** (with or without removals), the spec assumes the whole set is
   re-arranged as today's multiselect does, rather than going in as a new pane next to the focused
   one, as `prefix+enter` does.

   Recommendation: (a) for removals only, (b) whenever a tab is added. Removing should not undo
   sizes the user set; adding has no obvious place without a layout.

5. **What the panel shows for the split.** The marks are the same `●` as multiselect. The header
   could read:
   - (a) "3 marked" as today, nothing split-specific.
   - (b) "split: 3 panes" when unchanged, "split: 3 → 2" after an unmark, "split: 3 → 1 (unsplit)"
     at one; and an unmarked pane row shows `○` (a pane that will leave) instead of a blank gutter.
   - (c) (b)'s header without the `○`.

   Recommendation: (b). It shows which tabs are panes now and what applying will do, without colour.

6. **Which pane has focus after the change.**
   - (a) As multiselect: the highlighted row if it is marked, else the first marked row.
   - (b) The pane that had focus, if it is still marked; else (a).

   Recommendation: (b). Removing a background pane should not move focus.

7. **Where the removed tab goes in the tab order.**
   - (a) Right after the split, where Firefox's rebuild leaves it (no extra move).
   - (b) Back where it was before it joined the split (Vimma would have to remember that).
   - (c) At the end of the workspace's tabs.

   Recommendation: (a). It needs no extra state, and in the panel the removed tab is the row just
   below the split's rows.

8. **Do split marks mix with marks made for another purpose?** Today the panel's marks exist only
   to make a split, so pre-marked panes and other marks are one set. If a later feature uses
   marks for something else (close the marked tabs, move them to a workspace), the pre-marked
   panes would be in its selection too.
   - (a) One kind of mark: pre-marks are ordinary marks. A future marks feature decides then how
     it treats them.
   - (b) Two kinds now: pane rows get their own indicator (for example a pane number), and
     `space` toggles a separate "keep as pane" state that only the split uses.

   Recommendation: (a). Unsplitting then works the same way as splitting, and there is no other
   mark use today.
