# Spec: m4-split-panes

Status: implemented (sub-specs 1 to 7; key-to-paint timing: `browser_vimma_perf.js`, runbook
"Key-to-paint timings") ·
Milestone: M4 · Area: host
(`src/browser/base/content/vimma/split/`, `host/`), CSS (`browser/themes/shared/vimma/`)

This is the umbrella spec for M4. It records the research, the decision
([ADR-013](../adr/013-split-on-firefox-split-view.md), accepted after the sub-spec 1 spike;
it supersedes ADR-006), the
architecture, the patch list, the test plan and the breakdown into sub-specs. Each sub-spec
(§ Breakdown) is one session, gets its own `docs/specs/m4-split-<name>.md` when it starts, and
links back here.

Sources: the engine tree (Firefox 157.0.1, read-only); zen-browser/desktop at `185e856f`
(2026-10-09, also on 157.0.1); the core pane model on `origin/feat/core-panes-workspaces`
(PR #10, [m3-m4-core-models](m3-m4-core-models.md) once merged).

## User stories

- As a user, `ctrl+b v` splits the current pane to the right and `ctrl+b -` splits it down. The
  new pane opens a new tab and has focus, and both pages stay live and visible.
- As a user, `ctrl+b h/j/k/l` moves focus to the pane that is visually next to me (the most
  recently used one when several touch, as in tmux). The URL bar, the find bar, page zoom,
  `ctrl+l` and every Vimma key then act on that pane.
- As a user, `ctrl+b shift+h/j/k/l` swaps the focused pane with its neighbour, `ctrl+b z` zooms
  the focused pane to the full content area and back, and `ctrl+b x` closes the pane but keeps
  its tab (`ctrl+b shift+x` closes the tab).
- As a user, `ctrl+b r` enters resize mode: `h/j/k/l` (or `<` `>` `+` `-`) move the nearest
  divider in steps of 5 %, and `Esc` leaves.
- As a user, a video that goes fullscreen in one pane fills the screen. When it leaves
  fullscreen, my layout is back exactly as it was.
- As a user, clicking into a pane focuses it, the same as `ctrl+b h/j/k/l`.
- As a user, each workspace keeps its own layout. Switching workspaces with `prefix+)`/`prefix+(`
  shows that workspace's panes, and a restart restores them.
- As a user, a link I open in a new foreground tab from a pane shows in that pane, and the split
  stays (core: activating a tab shows it in the focused pane).
  (Since [side-panel-unsplit](side-panel-unsplit.md) decisions 20–23, 2026-10-12: only a new
  foreground tab does this. Picking an existing tab outside the split shows it alone and keeps the
  split as a hidden view, as Firefox's own split view does; picking one of its tabs brings it back.)
- As the maintainer, a Firefox rebase that changes the split-view behaviour we rely on fails a
  named mochitest. It does not break panes silently.

## Decision

**Build on Firefox 157's own split view and add our layout. Do not vendor Zen.** The evidence
is in [ADR-013](../adr/013-split-on-firefox-split-view.md). In short:

|                                | Firefox 157 split view                                                                                                                                         | Zen split view (vendored, ADR-006)                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where                          | `tabsplitview.mjs` (498 lines), `MozTabpanels` in `tabbox.js`, `Tabbrowser.sys.mjs`, `content-area.css`                                                        | `src/zen/split-view/ZenViewSplitter.mjs` (2,659 lines) plus CSS                                                                                                         |
| Several live browsers          | `showSplitViewPanels`: `docShellIsActive = true` for each tab; `AsyncTabSwitcher` keeps `splitViewBrowsers` active; `xul.css` shows `.split-view-panel-active` | `zenModeActive` through patches to `browser-custom-element.mjs` and `AsyncTabSwitcher`; `xul-css.patch` for `[zen-split]`                                               |
| Panes                          | Any n is permitted, but only 2 is tested upstream; **layout is 2 columns** (CSS `column` 0 and 1, one splitter)                                                | n-ary row/column tree, `MAX_TABS = 4`                                                                                                                                   |
| Focus and URL bar              | Focus or click on a panel selects its tab (`MozTabpanels.handleEvent`); the URL bar follows `selectedBrowser`                                                  | `mousedown` on a container sets `selectedTab`; the same model                                                                                                           |
| Find bar, notifications, hover | Per panel, upstream                                                                                                                                            | Zen code and patches                                                                                                                                                    |
| Fullscreen                     | `:root[inDOMFullscreen]` fills the `deck-selected` panel and hides the others                                                                                  | Zen CSS                                                                                                                                                                 |
| Session restore                | `splitViewId` and `numberOfTabs`, generic over n                                                                                                               | Zen's own SessionStore and TabGroupState patches                                                                                                                        |
| Dependencies                   | Public `gBrowser` API                                                                                                                                          | `nsZenDOMOperatedFeature`, `gZenUIManager`, `gZenGlanceManager`, `gZenWorkspaces`, `gZenPinnedTabManager`, `gZenShareManager`                                           |
| Upstream patches for us        | **0** (1 named contingency)                                                                                                                                    | split-related changes in 20 upstream patch files (`Tabbrowser-sys-mjs.patch` alone is 1,289 lines, 48 of them split-related), mixed with folders, glance and workspaces |
| Tests                          | 18 upstream mochitest files, 93 tasks, plus SessionStore and extension tests                                                                                   | 8 files, about 20 tasks, depending on Zen features                                                                                                                      |
| Churn                          | Moves with the tree we rebase onto                                                                                                                             | `ZenViewSplitter.mjs` had 60 commits in 2026; Zen locks Firefox's split view off                                                                                        |

The hybrid we pick: **Firefox's wrapper decides which browsers are active and which tab is
selected. `vimma-core`'s pane tree decides the geometry.** Our CSS puts each active panel at the
rectangle `layout()` gives for its pane. Zen's `applyGridLayout` (absolute panels positioned with
`inset`) is the reference for that, but we copy no code. If we ever do, the file keeps Zen's
header and ADR-013 gets an addendum.

## Architecture

```
vimma-core (pure)                 host (chrome)                         Firefox 157
───────────────────               ──────────────────────────────        ─────────────────────────────
Workspaces.panes ──withPanes──▶   split/PaneView.mjs                    <tab-split-view-wrapper>
  root/focus/mru/zoom              reconcile(state):                      tabs = leaves' tabs
layout(state, rect) ──rects──▶      1 membership → wrapper              showSplitViewPanels:
                                    2 selection  → gBrowser.selectedTab    docShellIsActive, visible
                                    3 geometry   → CSS vars per panel    MozTabpanels focus → select
                                    4 focus      → selectedBrowser.focus() SessionStore splitViewId
                                  host/VimmaHost: keydown (capture),      content-area.css (2 cols:
                                    TabSelect/TabClose/TabOpen →             overridden by ours)
                                    core ops → reconcile
```

### One wrapper per workspace

- A workspace whose `panes` has one leaf has no wrapper. A workspace with n ≥ 2 leaves has
  exactly one `<tab-split-view-wrapper>` whose tabs are the leaves' tabs, in `leaves()` reading
  order. Workspaces hide each other's tabs with `gBrowser.hideTab`, which hides a whole wrapper
  (`Tabbrowser.sys.mjs`, `hideTab`), so one active wrapper at a time comes for free.
- `PaneView.reconcile(win, workspaceState)` is the only code that touches the wrapper. It is
  idempotent: it compares the wrapper's tabs with the leaves' tabs and acts only on a
  difference.
  - **Join** (split): `wrapper.addTabs([newTab])`, or, for the first split,
    `gBrowser.addTabSplitView([a, b], { insertBefore: a })`.
  - **Leave** (close pane, a tab shown in another pane, a closed tab): **rebuild**.
    `wrapper.unsplitTabs()` then `gBrowser.addTabSplitView(remaining)`, done synchronously in
    one task, so no paint shows the intermediate state. `unsplitTabs` does not deactivate the
    dropped tab's docshell, and its `TabSplitViewDeactivate` arrives from a later microtask
    (the wrapper's `MutationObserver`). The host therefore sets `docShellIsActive = false` on
    the dropped tab itself, and tolerates that late event: `reconcile` ignores it. A rebuild is
    needed because the wrapper's private `#tabs` is not updated when one tab leaves a wrapper of
    three or more: `#observeTabChanges` handles only the two-tab case. The contingency patch
    (`tabsplitview-mjs.patch`, which rebuilds `#tabs` from `this.tabs` in the observer) replaces
    rebuilds if sub-spec 1 shows flicker, lost scroll position, or a docshell going inactive.
  - **Closing a member tab** of a split of three or more (`gBrowser.removeTab`) leaves the
    removed tab in the stale `#tabs`, which reaches `showSplitViewPanels` on the next
    `TabSelect` and may throw. Sub-spec 1 tests exactly this. If it throws, the contingency
    patch is preferred over rebuilds for every leave, not only this one.
  - **Close pane, keep tab**: `hideTab` on any member hides the whole split
    (`Tabbrowser.sys.mjs:7604-7610`), so `reconcile` rebuilds without the tab first and hides
    it after.
  - **Close tab in a pane** (`ctrl+b shift+x`): select the tab that core's `closeTab` focuses
    next, then remove the closed tab, as `replaceTab` does (`tabsplitview.mjs:420-433`). The
    split never briefly suspends to show a non-member.
  - **Replace** (another tab in the focused pane, `setPaneTab`): add the new tab, then select
    it, then rebuild without the old tab. In that order, the `TabSelect` for the new tab finds it
    already in the active wrapper, so Firefox never suspends the split to show the tab alone.
  - **Single pane**: `unsplitTabs()`, after which the wrapper removes itself.
- Pinned tabs cannot join a wrapper (`addTabs` returns at the first pinned tab). Vimma does not
  pin, and `reconcile` unpins before joining. See [limits](../limits.md).
- Tab-strip order: joining a wrapper makes the pane tabs contiguous in `gBrowser.tabs`. Vimma's
  tab numbers (`prefix+1..9`, `tab 2/5`) come from core's `tabs` list, never from
  `gBrowser.tabs`, so the host ignores `TabMove` events caused by split membership (tagged with a
  `reconciling` flag while `reconcile` runs).

### Geometry: our CSS, core's rectangles

- `PaneView` reads the content rectangle from `#tabbrowser-tabpanels`. A `ResizeObserver` on it
  re-applies the layout on window resize, sidebar or side-panel toggle, and find bar changes.
  It calls `layout(panes, { x: 0, y: 0, width, height })` (integer CSS px; core rounds edges so
  neighbours share one edge) and writes four custom properties on each panel element
  (`--vimma-pane-x`, `-y`, `-w`, `-h`). Firefox's own `style.width` writes from its splitter never
  collide with ours, because we only set custom properties.
- `browser/themes/shared/vimma/split.css` (our sheet, loaded as `tabstrip.css` is), scoped to
  `:root:not([inDOMFullscreen]) #tabbrowser-tabpanels[vimma-panes]`:
  - panels with `.split-view-panel-active` are `position: absolute` at the custom properties,
    with `!important` on `width`, `max-width`, `min-width`, `margin` and `order` to override
    `content-area.css`'s two-column rules; a small gap token comes from M5's theme;
  - Firefox's `.split-view-splitter`, `split-view-footer` and `#split-view-button` are
    `display: none`. Dividers are drawn by our own elements in a later sub-spec; mouse-drag
    resize is out of scope (limits);
  - the focused pane is Firefox's `.deck-selected`, which already draws `--focus-outline`; M5
    maps that colour to the theme;
  - the panels' `.browserContainer` has no border, the other panes an inset 1px separator
    outline and the focused one the whole `--focus-outline`, all `!important`: Firefox 158
    (`content-area.css`, Nova) borders every panel's container by 1px, which shrinks each page
    2px inside its rect, and trims the focused panel's outline to 1px. That is Firefox 157's
    drawing, kept (risk "Firefox's two-column CSS leaks through ours");
  - `[vimma-zoomed]` panels (every pane but `zoom`) get `-moz-subtree-hidden-only-visually: 1`,
    as upstream's fullscreen rule does for the other panels, not `display: none`, so their
    frames and scroll positions stay. The zoomed panel gets the full rectangle (core's
    `layout()` of a zoomed state returns one rectangle). The host sets `docShellIsActive` to
    `false` on zoomed-away browsers and back to `true` on unzoom, so they stop painting.
- **Fullscreen.** Our rules do not apply under `:root[inDOMFullscreen]`, so Firefox's own rule
  takes over: the `deck-selected` panel (the focused pane, which had to be focused to get the
  user activation for `requestFullscreen`) fills the screen and the others are hidden. The core
  model is not touched: fullscreen is a transient visual zoom, not `toggleZoom`. Leaving
  fullscreen restores the custom-property layout unchanged. This is how "fullscreen requests
  zoom the pane" (plan §6) is met.

### Keyboard focus model

1. **The active pane is the selected tab.** The invariant is
   `gBrowser.selectedTab === tabOf(panes.focus)` whenever the active workspace has panes.
   `reconcile` sets `gBrowser.selectedTab` and does nothing else to select.
2. **Keys reach the focused browser.** VimmaHost's capturing `keydown` on the chrome window
   (m0-key-capture) sees every key first, whatever is focused, and the event then goes to the
   focused element. For a remote `<browser>` that is its content process. After a pane focus
   change, the host calls `gBrowser.selectedBrowser.focus()` unless a tab-modal dialog is
   showing (`tabDialogShowing`). `_adjustFocusAfterTabSwitch` would otherwise restore the URL
   bar if that tab last had it focused. tmux semantics: moving to a pane focuses its page.
3. **Mode follows the pane.** Insert-mode detection (M1 actor) is per browser. On a pane focus
   change the host asks the new pane's `VimmaChild` for its editable-focus state instead of
   carrying the old pane's mode over. Until M1's actor exists, the M0 rule applies (every page
   is `insert`).
4. **Mouse and other focus changes go back to core.** A click, `focus` in a panel or a
   `TabSelect` from any source (Firefox's own `MozTabpanels.handleEvent`, `ctrl+tab`, an
   extension) is handled by the host's `TabSelect` listener. If `paneOfTab(tab)` exists in the
   active workspace, the host calls `withPanes(s, p => focusPane(p, pane))`. Otherwise it calls
   `selectTab` (core shows the tab in the focused pane) and then `reconcile`. In both cases the
   result is a no-op when it already holds, so the listener cannot loop.
5. **URL bar, find bar, zoom, status panel.** These are upstream behaviours keyed on
   `selectedBrowser`, and on the browser under the pointer for link hovers. No code of ours is
   needed. Mochitests pin each one (contract test).

### Firefox's own split-view entry points

`browser.tabs.splitView.enabled` is set to `false` in
`browser/branding/vimma/pref/firefox-branding.js`. It gates only the tab context menu, the link
context menu and alt-click (`tab.js`, `tab-context-menu.js`, `nsContextMenu.sys.mjs`); the API
keeps working. The remaining entry points are the `Browser:AddTabSplitView` command (no default
key), `splitViewCommands` from the hidden URL bar button, extensions and session restore of a
Firefox-made split. They can still create or reorder a wrapper. The host listens for
`SplitViewCreated`, `SplitViewRemoved` and `SplitViewTabChange` on `gBrowser.tabContainer` and,
outside `reconcile`, **adopts** the DOM: a new wrapper becomes a vertical split of its tabs in
the active workspace's tree, and a dissolved one closes those panes. DOM wins for splits made
outside Vimma, and core wins for everything Vimma does.

### Persistence

Core's snapshot (`toSnapshot`) stores each workspace's pane tree. Firefox's SessionStore
restores the wrapper itself (`splitViewId`, `numberOfTabs`, `createTabsForSessionRestore`). On
startup the M3 host restores core's state, drops tab ids the session did not restore
(`closeTab`), and calls `reconcile` per workspace. That rebuilds any wrapper whose members
differ from the tree. A wrapper that SessionStore restored without a matching tree is adopted
as above.

## Upstream patches

| Patch                                                                              | Status              | Reason                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                                                                               | target              | Everything above uses public `gBrowser` / wrapper API, our CSS, our pref file and DOM events.                                                                                                                                                                          |
| `src/browser/components/tabbrowser/content/tabsplitview-mjs.patch` (one hunk)      | contingency         | Keep `#tabs` equal to the wrapper's children when a tab leaves a wrapper of 3+, so `reconcile` can drop one pane without a rebuild. Used only if sub-spec 1's spike shows the rebuild flickers, loses state or deactivates a docshell. Needs an ADR-003 register line. |
| `src/browser/base/content/browser-xhtml.patch`, `src/browser/base/moz-build.patch` | existing, unchanged | `split/*.mjs` and `split.css` load through our `jar.mn` and `vimma.js`, as `ui/tabstrip.mjs` does.                                                                                                                                                                     |

A runtime wrap of `MozTabSplitViewWrapper` internals is ruled out for the same reason
m0-tabstrip-hidden dropped its wraps. A patch fails loudly at `surfer import`, while a wrap breaks
silently at runtime. The upstream behaviours we use without a patch are pinned by
`browser_vimma_split_contract.js` instead.

## Test plan

The plan §6 gate is two panes of real sites side by side, keyboard only, with mochitests for
every pane op. Every acceptance criterion below is a browser-chrome mochitest
(`tests/browser/browser_vimma_split_*.js`, test names are sentences). Core behaviour stays in
Vitest (PR #10). The host tests assert DOM and `gBrowser` state, never core internals.

**Contract (`browser_vimma_split_contract.js`, sub-spec 1).** It runs on every PR and fails on
the upstream rebase PR if Firefox changes:

- `addTabSplitView([a, b, c])` keeps all three tabs in one wrapper, `showSplitViewPanels` marks
  three panels `.split-view-panel-active`, and every browser has `docShellIsActive`;
- selecting `b` keeps all three active (`AsyncTabSwitcher.shouldDeactivateDocShell`);
- `focus()` on `c`'s browser selects `c`, and so does a synthesized click in its panel;
- `unsplitTabs()` then `addTabSplitView([a, c])` in one task leaves `b` inactive, `a` and `c`
  active, and the selected tab unchanged;
- `hideTab` on one member hides the wrapper; `browser.tabs.splitView.enabled = false` still
  allows `addTabSplitView`;
- the find bar opened in `c` belongs to `c`; a notification in `b` shows in `b`'s panel;
- under `inDOMFullscreen`, only the `deck-selected` panel is visible;
- with a four-tab wrapper, the same activeness, focus and selection checks hold for all four;
- `gBrowser.removeTab(b)` on a three-tab split, then selecting `a`, does not throw (or, if the
  contingency patch is in, `wrapper.tabs` and the active panels are `[a, c]`);
- after a rebuild, the dropped tab is inactive once the host deactivates it. The late
  `TabSplitViewDeactivate` is tolerated, not asserted absent.

The contract test always uses three and four tabs, never only two, so an upstream refactor that
narrows the split view to two fails on the Firefox-update PR.

**Pane ops (one file each, sub-specs 2 to 6):**

- split right / down: `ctrl+b v` gives two visible, active panels side by side, each with the
  rect `layout()` gives (±1 px), with the new pane focused, selected and showing a new tab;
  `ctrl+b -` gives them stacked; three in a row and an L shape (`x[a, y[b, c]]`) are exact.
- refused split: at `MIN_RATIO` the layout is unchanged and the status bar shows the
  `splitRefusal` message.
- close pane: `ctrl+b x` removes the pane, keeps its tab (rebuilt out of the split first, then
  hidden, still in the workspace),
  focuses the absorbing sibling, and leaves the sibling active; closing down to one pane
  dissolves the wrapper.
- close tab in a pane: `ctrl+b shift+x` selects the next focus tab first, then closes the tab;
  the pane follows core's `closeTab` rules, and no non-member is ever the selected tab.
- focus h/j/k/l: the URL bar shows the focused pane's URL, `document.activeElement` is its
  browser, a key typed into a page lands in that pane only, and MRU round trips work.
- click focus: clicking the inactive pane focuses it, and core's focus matches.
- swap: `ctrl+b shift+l` swaps the rects; both pages keep their URL, scroll position and
  docshell; focus stays with the moved page.
- zoom: `ctrl+b z` gives one panel the full rect, the others visually hidden with inactive
  docshells; any focus move unzooms and reactivates them; zoom survives a restart.
- resize mode: `ctrl+b r`, then `l` ×2, gives the ratio `.6`/`.4` and matching rects; `Esc`
  leaves resize mode; the clamp holds at `MIN_RATIO`.
- URL bar: `ctrl+l` in pane 2 edits pane 2's URL; Enter navigates pane 2 only.
- new tab from a link: a `target=_blank` link in pane 2 shows in pane 2 and the split stays
  (rects unchanged after the next flush).
- fullscreen: `requestFullscreen` in pane 2 fills the window with pane 2; exiting restores the
  rects exactly; the core state is unchanged.
- workspaces: two workspaces with different layouts; `prefix+)` shows each one's panes, and the
  other wrapper is hidden.
- restore: restarting (SessionStore plus the state file) restores rects, focus and zoom.
- foreign split: a wrapper created by `Browser:AddTabSplitView` is adopted into the tree.

**e2e (sub-spec 7):** two real sites (served by the harness) side by side, split, focus, swap,
zoom and resize through `send-keys`, with `state` JSON assertions and one screenshot baseline.
It needs `tools/e2e` and the control socket (PR #11).

**Perf:** key to paint for `ctrl+b l` across two live panes is below 5 ms (plan §5), measured in
e2e once the perf gate (issue #17) exists.

## Risks and mitigations

| Risk                                                                                            | Likelihood | Mitigation                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firefox changes its split view (renames, limits it to 2, makes `#activate` reorder panels)      | Medium     | The contract mochitest fails on the upstream PR; the contingency patch; zero runtime wraps.                                                                                                                                                                      |
| A rebuild on leave flickers or briefly deactivates a docshell (lost video, scroll jump)         | Medium     | Do it synchronously in one task, measured in sub-spec 1; else the one-hunk `tabsplitview-mjs.patch`.                                                                                                                                                             |
| Selection storms: `TabSelect` → core → `reconcile` → `selectedTab` → `TabSelect`                | Medium     | Core ops are no-ops by identity when nothing changes; `reconcile` acts only on differences; a `reconciling` guard; a test counts `TabSelect` events per op.                                                                                                      |
| Firefox's two-column CSS leaks through ours (order, max-width, margins)                         | High early | `!important` overrides scoped to `[vimma-panes]`; rect assertions within ±1 px in every pane-op test.                                                                                                                                                            |
| Focus lands in the URL bar or chrome after a pane move (`_adjustFocusAfterTabSwitch`)           | Medium     | An explicit `selectedBrowser.focus()` after each pane focus; tested with `document.activeElement`.                                                                                                                                                               |
| Keys typed fast during a pane switch go to the old pane (async tab switch)                      | Low        | Split browsers are already active, so the switch is synchronous in practice; an e2e test types right after `ctrl+b l`.                                                                                                                                           |
| Extensions and code that assume 2 tabs per split (`ext-tabs.js` `tabs.move`, `TabsList` labels) | Low        | Our tab strip and all-tabs list are hidden; documented in limits; reconcile after any foreign `SplitViewTabChange`.                                                                                                                                              |
| Many live panes cost memory and CPU (every visible pane's docshell is active)                   | Medium     | `MIN_RATIO` alone does not bound it: nesting allows many panes. A host-enforced maximum of live panes per workspace (config `panes.max`, default 4 as Zen's `MAX_TABS`) refuses further splits with a status-bar message; zoomed-away docshells are deactivated. |
| Plan §9: split view destabilises tab selection, focus and the URL bar                           | High       | The selection model is upstream's and tested; one invariant (`selectedTab` = focused pane) asserted after every op; `ctrl+b z` and `ctrl+b x` as escape hatches; sub-specs land one op at a time.                                                                |

## Sub-spec 1 results (`m4-split-contract` spike)

Done in `tests/browser/browser_vimma_split_contract.js` (12 tasks, 234 checks) with a spike
module, `split/spike-layout.mjs` and `browser/themes/shared/vimma/split-spike.css`, both marked
SPIKE and not wired into the host. Local artifact build of Firefox 157.0.1, headless, window
1280 × 800 (content area 1280 × 760). Pane trees come from core's pane ops and
rectangles from core's `layout()`. The numbers are in
[ADR-013 § Spike results](../adr/013-split-on-firefox-split-view.md#spike-results); in short:

| Scope item                                          | Result                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| L shape and 2 × 2 grid, 3 and 4 tabs, ±1 px         | Pass, Δ 0 px for panels and browsers; every member's docshell active whichever member is selected                             |
| DOM fullscreen from one pane, then exit             | Pass: the pane fills the screen (Δ 0), the others stay active and are covered; every rect is back after exit (Δ 0)            |
| Focus outline, find bar (`accel+f`), notification   | Pass: outline on the focused pane only; find bar and notification inside their own pane's panel and rect                      |
| Focus or click selects the tab, URL bar follows     | Pass, for `focus()` and a synthesized click                                                                                   |
| `removeTab` on a 3-split member, next `TabSelect`   | Pass: no exception, no stale panel; the closed tab stays in the private `#tabs` but is skipped                                |
| Rebuild, with and without the host deactivating     | Kept members active at every sample, scroll kept; the dropped tab stays **active** unless the host sets it inactive           |
| Zoom with `-moz-subtree-hidden-only-visually`       | Pass: zoomed pane fills the area, the others are not drawn or hit, keep their scroll; their docshells stay active (CSS alone) |
| Tab-key panel order (3+ panes)                      | Upstream orders panels 0 and 1 only; `moveBefore` in reading order fixes it without reload, deactivation or scroll loss       |
| `browser.tabs.splitView.enabled = false`, `hideTab` | API still works; `hideTab` on one member hides all                                                                            |

Decision: ADR-013 is Accepted; no contingency patch; leaves are rebuilds.

What sub-spec 2 (`m4-split-layout`) takes from this:

- Start from `split-spike.css`: scope to `:root:not([inDOMFullscreen])
#tabbrowser-tabpanels[vimma-panes][splitview]`, give `#tabbrowser-tabpanels`
  `position: relative`, and override `position`, `inset`, `width`, `height`, `min-width`,
  `max-width`, `margin` and `flex` with `!important` (upstream's panel `margin` is
  `--space-xsmall`, so the gap token must be ours). Then delete the spike files.
- `reconcile` also reorders panels with `moveBefore` into `leaves()` order after membership
  changes, and sets the dropped tab's `docShellIsActive = false` on every leave, in the same task
  as the rebuild. It tolerates the late `TabSplitViewDeactivate` whose `detail.tabs` lists the old
  wrapper's members, kept ones included.
- Zoom: the CSS hides; the host must still set `docShellIsActive = false` on zoomed-away
  browsers, since the CSS alone leaves them active. `content-area.css` gives column 0 and the
  deck-selected browserContainer `z-index: 1`, so overlap without the hiding is visible.
- Test notes: `getComputedStyle` does not expose `-moz-subtree-hidden-only-visually` (use a hit
  test with a control); `Assert.deepEqual` treats any two DOM elements as equal (compare ids or
  labels); the unfocused panels' `browserContainer` has a 1 px separator outline, so check the
  outline colour, not its style.
- Not done here, carried to sub-spec 2: `browser.tabs.splitView.enabled = false` in the branding
  prefs (the contract test already shows the API works with it off), hiding
  `#split-view-button`, and the accessible label for a third tab on. Flicker was measured as
  "no state change between synchronous samples"; the e2e screenshot in sub-spec 7 is the visual
  check.

## Sub-spec 2 results (`m4-split-layout`)

Done: `split/PaneView.mjs` (the window's pane tree and `reconcile`), `split/layout.mjs` (CSS
custom properties; replaces `spike-layout.mjs`), `browser/themes/shared/vimma/split.css`
(replaces `split-spike.css`), pref `browser.tabs.splitView.enabled = false`, tested by
`browser_vimma_split_layout.js` (8 tasks) with the contract test kept green.

- **Host API** for sub-spec 3: `PaneViews.get(window)` gives the window's `PaneView`, with
  `split("vertical" | "horizontal", { tab? })`, `close()` and `zoom()`, each returning
  `{ ok: true }` or `{ ok: false, reason }` (core's `splitRefusal` message, e.g. "at most 4
  panes"); `panes` (the tree, `null` for one pane), `max` (config `[panes] max`, default 4) and
  `reconcile()`. `PaneViews.init` runs from `vimma.js`; no change to `VimmaHost`. (Since
  changed: `max` defaults to 8 (#691); `docs/guide.md`, "config.toml".)
- **Reconcile** applies `planSplit` in its documented order: select the focus tab first when it
  is already a member, membership (a rebuild on any leave, `addTabs` or `addTabSplitView` on a
  join), `moveBefore` into reading order, select, show/hide visually, activate/deactivate (never
  the selected tab), geometry, then accessible names for panes 3+. It runs on every tree change,
  on `TabClose` of a member (in a later task, once Firefox has removed it) and after a
  `TabSplitViewActivate` it did not cause (Firefox's `showSplitViewPanels` re-activates every
  member, including zoomed-away ones). The late `TabSplitViewDeactivate` is not listened to.
- **Geometry**: a `ResizeObserver` on `#tabbrowser-tabpanels` re-lays out on any size change.
  `--vimma-pane-gap` (2 px, M5's theme token later) goes on interior edges only, half from each
  side, so panels and browsers sit within 1 px of `layout()`'s rect: measured Δ ≤ 1 px for the
  L shape, after close, after resize (1280 → 1000 px wide and back), and Δ 0 for zoom
  (1280 × 740 content area, headless artifact build).
- **Not here** (later sub-specs): keys and the status-bar refusal message (3); `TabSelect` /
  click focus sync (4); hiding a closed pane's tab and per-workspace trees (6). A split made
  outside Vimma is left alone until adoption (6).

## Sub-spec 3 results (`m4-split-keys`)

Done: `host/pane-ops.mjs` (runners over `PaneViews.get(window)`), `PaneView.focus(direction)`,
`RUNNERS` entries for `pane.split_vertical`, `pane.split_horizontal`, `pane.focus_*`,
`pane.zoom` and `pane.close` (so the overlay stops dimming them), the status bar's `pane n/m`
segment, tested by `browser_vimma_pane_keys.js` (7 tasks).

- **Keys:** `prefix+v` / `prefix+-` (and `:vsplit`, `:split`), `prefix+h/j/k/l`, `prefix+z`,
  `prefix+x` (and `:q`); in normal mode `<C-w>h/j/k/l` and `<C-w>o`. Swap and resize stay
  dimmed (sub-spec 5).
- **Split** opens the new-tab page (the start page) in the new pane, focused, with the URL bar
  selected as after `ctrl+b c`. A refusal (`max-panes`, `no-space`) opens no tab and shows the
  notice "<action>: <core's reason>", e.g. "Split right: at most 4 panes".
- **Focus** moves select the pane's tab and then focus its browser (not after a tab-modal
  dialog); the URL bar follows `selectedBrowser`. No neighbour is a no-op that keeps the zoom,
  so zoomed-away panes stay inactive; a move unzooms (core).
- **Close:** `pane.close` closes the focused pane and keeps its tab (hidden in sub-spec 6); with
  one pane it is `tab.close` (pinned: select the first unpinned tab). `PaneView` now selects
  the remaining tab when a close leaves one pane (it stayed on the closed pane's tab).
- **`<C-w>` vs Firefox's `ctrl+w`:** the `<C-w>` actions are runnable only with two panes or
  more, so with one pane the first `ctrl+w` still passes and closes the tab (plan §2,
  m1-actor-insert-scroll's rule). With a split, normal-mode `ctrl+w` is Vim's window prefix.
  `<C-w>v/s/c` are not added: a split key would make `ctrl+w` ours in every window.
- **Workspaces** (m3 decision 14): the window is still the workspace; `PaneViews.get(window)` is
  the seam a per-workspace tree replaces in sub-spec 6.
- Tests that used `ctrl+b v` / `:vsplit` as the example of an unbuilt action now use `ctrl+b w`
  / `:sidebar`. Test note: a key sent to a pane while its new-tab document is still replacing
  `about:blank` is lost, so the test waits for the start page before moving focus into it.

## Sub-spec 5 results (`m4-split-swap-resize`)

Done: `PaneView.swapPane(direction)` (core `swap`; `swap(from, to)` is the workspace park) and
`PaneView.resize(direction, amount)` (core `resize`, clamped at `MIN_RATIO`); `swapPane` and
`resizePane` in `host/pane-ops.mjs`; the `resize` dispatcher mode
([ADR-014](../adr/014-resize-mode.md)), tested by `browser_vimma_pane_swap_resize.js` (3 tasks)
and `resize-mode.test.mjs`.

- **Keys:** `prefix+shift+h/j/k/l` and `<C-w>H/J/K/L` swap; focus stays with the moved pane and
  its page keeps focus. `prefix+r` enters resize mode (status bar `RESIZE`): `h/l` narrower /
  wider, `j/k` taller / shorter, the arrows and `< > + -` the same, `Esc` / `Enter` / `q` leave
  (`resize_exit`, a new action). `<C-w> < > + -` resize directly in normal mode. Steps of 0.05
  (`RESIZE_STEP`); a count multiplies the step (`3l`, `3<C-w>>`), so no shifted big-step keys.
- **Mode:** window-wide and modal (every key is consumed, as in help and hint mode); it ends by
  itself when the window is down to one pane. One pane: `prefix+r` shows "Resize mode: only one
  pane". The `<C-w>` swap and resize keys are runnable only with two panes, like the others.
- **Contract:** `resize` in `MODES` and `COUNT_MODES`, `[modal.resize]` in config, a `resize`
  status-bar badge (`--vimma-mode-resize`, from `brown`), `vimma-ctl`'s mode list, and Esc's exit
  (`resolveEscape`) returning to the mode resize was entered from.
- Which-key is gone (m2-statusbar-whichkey); the help overlay lists the mode's keys as
  `l [resize]` and no longer dims the swap and resize rows.

## Sub-spec 4 results (`m4-split-focus-sync`)

Done: `PaneView` listens for `TabSelect` on the window, tested by `browser_vimma_pane_focus.js`
(4 tasks).

- **Any selection of a pane's tab focuses that pane:** a click or focus in a panel (Firefox's
  `MozTabpanels.handleEvent` selects the tab; verified on 157.0.1), the `ctrl+b g` picker,
  `ctrl+tab`, `alt+N`, an extension. Core's `focusPane` moves focus and the MRU, then
  `reconcile` runs; the status bar's `pane n/m` and the URL bar follow `TabSelect` and
  `selectedBrowser`. Before this, the next `reconcile` (after Firefox's `TabSplitViewActivate`)
  selected core's stale focus again, so a click or the picker snapped back.
- **Zoom:** selecting a zoomed-away pane's tab unzooms and focuses it, as a pane move does (core's
  `focusPane`; tmux's `select-pane`). Selecting the focused pane's tab changes nothing.
- **No loops:** the listener ignores selections made while `reconcile` runs (re-entry flag) and
  is a no-op when the tab is already the focused pane's, so `reconcile`'s own `selectedTab`
  never feeds back. Measured: one `TabSelect` per click, picker Enter, outside selection and
  keyboard move. While Firefox picks a successor for a closing tab (`previousTab.closing`), the
  `TabClose` reconcile's choice (core's `closePane`) still wins.
- **Keyboard moves** focus the pane's page, not the URL bar that tab last had (sub-spec 3's
  `focusPage`, now pinned by a test).
- **Not here:** a non-member tab selected while split (Firefox suspends the split; core's
  `setPaneTab` and the replace order) and per-pane mode from the M1 actor move to sub-spec 6.

## Sub-spec 6 results (`m4-split-workspaces-restore`, core)

Done: each workspace keeps its own pane layout and focus across switches, a restore brings back
every workspace's layout, and a tab selected from outside the split shows in the focused pane;
tested by `browser_vimma_pane_workspaces.js` (3 tasks).

- **Per-workspace trees stay in `PaneView`**, not in core's `Workspaces.panes`: `swap(from, to)`
  parks the shown tree with its wrapper (m3 2b) and `restore(trees, active)` hands back every
  workspace's tree (m3 3); `WindowWorkspaces` converts to and from uuids only when saving and
  restoring. Moving them into the live core model would add a second copy to keep in step with
  no behaviour gained; the snapshot is where core owns them.
- **Switches:** an L shape in A (left pane focused, not the newest) and a vertical pair in B (lower
  pane focused) each come back with their panes in reading order, the focused pane selected,
  every member's docshell active, the other workspace's wrapper hidden, and rectangles within
  1 px, twice round. New: the focused pane's **page** gets focus after a switch. A split's
  browsers are already active, so Firefox's tab switch completes at once and
  `_adjustFocusAfterTabSwitch` sees the old page still focused and keeps away; hiding that page
  then left focus on the body (keys went nowhere). `WindowWorkspaces.#focusPane` focuses the
  selected browser only when focus is on the body or another page; the URL bar, a tab-modal
  dialog and other chrome focus are left alone.
- **Restore:** both workspaces split, A shown and B parked; after `setWindowState` A's layout and
  focus are adopted at once and B's on the first switch (parked trees were saved and restored
  by m3 3 but never asserted). Nothing new was needed in the code.
- **A non-member selected while split** (sub-spec 4's deferral): `PaneView`'s `TabSelect`
  listener calls core's `setPaneTab` for the focused pane, then `reconcile` rebuilds the wrapper
  around the new tab. Firefox has already suspended the split for the selection, but the rebuild
  runs in the same `TabSelect` dispatch, so no paint sees the suspended state; the test asserts
  the split synchronously after `selectedTab =`. The replaced tab stays open and visible in the
  workspace (not `hideTab`: that would drop it from the tab keys and the switch planner shows it
  again on every switch) and its docshell goes inactive. Not replaced: a pinned tab (cannot
  join a split, is in every workspace: Firefox shows it alone and the tree waits) and, through
  `PaneView.accepts`, any tab while `WindowWorkspaces` switches or restores and any tab of
  another workspace (decision 14: `#onSelect` switches instead, and the tree is parked as is).
  `ctrl+t` and a link in a new foreground tab therefore open in the focused pane (the user
  story). (Changed 2026-10-12 by side-panel-unsplit decision 21: a selected tab that is not new
  shows alone and the tree is kept hidden; only a tab opened in the same task is shown in the
  focused pane.) Sub-spec 3's "its tab is hidden in sub-spec 6" for a closed pane is settled the
  same way: the tab stays visible.
- **Also fixed:** `ui/theme-host.mjs` had a race that failed `browser_vimma_theme.js` in the full
  suite (2 of 7 runs here, with the new test before it): a check in flight when a pref changed
  applied the old theme after `recheck` reset `loaded`, so the next check kept it. A generation
  counter makes such a check apply nothing. Green 10 of 10 under `taskset -c 0,1` load.
- **Red/green:** red before (8 unexpected: the replace and the page focus), green after;
  whole `tests/browser/` suite green (2504). Mutation check: not calling `#focusPane` after a
  switch fails "A's focused page has focus".

**Remaining work of sub-spec 6 (since done):**

- **Adopting foreign splits:** listen for `SplitViewCreated`, `SplitViewRemoved` and
  `SplitViewTabChange` on `gBrowser.tabContainer` outside `reconcile`; a new wrapper becomes a
  vertical split of its tabs in the active workspace's tree, a dissolved one closes those panes.
  Members of another workspace are unsplit with a status-bar notice (m3 decision 14);
  `WindowWorkspaces.#show` still only `console.warn`s `plan.unsplit`. A SessionStore-restored
  wrapper with no tree in the snapshot (a Firefox-made split, or a lost window value) goes the
  same way. Test: `Browser:AddTabSplitView` and an extension-style `addTabSplitView`.
- **Per-pane mode:** `VimmaHost` already keys page mode by `<browser>` (`browserModes`) and reads
  the focused browser's, so a pane move takes the new pane's mode; no test pins it yet (insert in
  pane 1's text field, `ctrl+b l` gives normal, `ctrl+b h` insert again).

**Sub-spec 6 results, the rest (adopting foreign splits):** done, tested by
`browser_vimma_pane_adopt.js` (4 tasks) and core's `createRow` (vitest).

- **Events:** `PaneView` listens for `SplitViewCreated` (Firefox's `addTabSplitView`),
  `SplitViewTabChange` (any membership change; SessionStore builds wrappers with
  `#createTabSplitView` and `addTabs(…, { isSessionRestore })`, which fire no `SplitViewCreated`)
  and `SplitViewRemoved`, outside `reconcile`, and runs `adopt()` then `reconcile()` in its
  scheduled task. Our own rebuilds' events arrive late (the wrapper's `MutationObserver`), so
  `adopt` compares the DOM with the trees and finds nothing to do for them.
- **Adopted:** the shown workspace's split of the selected tab becomes a row (core `createRow`;
  Firefox lays out two columns, so a row is what the user saw), in the wrapper's order, focus on
  the selected tab. Shares: Firefox's splitter stores the first panel's `width` attribute; with
  two tabs that over the content width gives the ratios (clamped at `MIN_RATIO`), else equal.
  Restore keeps no widths, so a restored Firefox split comes back equal. A split of background
  tabs waits until one is selected (`TabSplitViewActivate`); one of a hidden workspace until a
  switch shows it (`WindowWorkspaces.#show` calls `adopt()` after the switch, also after a
  restore, which covers a wrapper restored without a tree in the snapshot).
- **Undone, with a notice** (`WindowWorkspaces`' notify, the status-bar toast): a wrapper whose
  tabs are in different workspaces (m3 decision 14; `plan.unsplit`'s `console.warn` is gone) and
  a second split in a workspace that has one (shown or parked). Tabs stay where they are.
- **The shown tree's wrapper changed outside Vimma:** dissolved (Firefox's "separate tabs"), the
  panes close and the selected tab stays; a tab taken out closes its pane; a tab added joins on
  the right (core `split`, so within `[panes] max`; another workspace's is dropped by reconcile).
  `WindowWorkspaces.moveTab` now closes the moved tab's pane through `PaneView.release(tab)`
  first, instead of unsplitting the whole wrapper (which would read as a dissolve).
- **Contract test:** `browser_vimma_split_contract.js` pins Firefox's split view without Vimma;
  PaneView would now adopt its wrappers, so it removes PaneView's listeners
  (`PANE_VIEW_EVENTS`) for its run and adds them back in cleanup.
- **Per-pane mode:** pinned end to end by the sub-spec 7 e2e scenario (below); no mochitest
  added.
- **Red/green:** the new test red before (4 tasks time out: nothing adopted), green after; 9 of
  9 under `taskset -c 0,1` load; whole `tests/browser/` suite green (2723). Mutation check: not
  showing the notice for a split across workspaces fails "the notice says why".
- **Not done:** Firefox's `about:opentabs` tab in an adopted split closes when the split is
  separated (upstream `unsplitTabs`), including Vimma's own rebuilds and `ctrl+b x` down to one
  pane ([limits](../limits.md)).

## Sub-spec 7 results (`m4-split-gate`)

Done: `tests/e2e/scenarios/m4-split-panes.json` with the fixture `tests/e2e/fixtures/pane.html`
and the baseline `tests/e2e/baselines/m4-split-panes.png` (from CI's Xvfb image). No harness
step, protocol field or product code was needed.

- **Geometry through titles:** `pane.html#<name>` titles itself `"<name> <innerWidth>"` and
  keeps it current on resize, so `state.tabs[].title` checks each pane's width without a new
  protocol field: 639 per half (1280 px, 2 px gap), 1280 zoomed, 767/511 at 60/40.
- **Covered, all keyboard through `send-keys`, asserted on `state.panes` and titles:**
  `prefix+v` and `prefix+-` build an L shape `x[a, y[b, c]]`; `prefix+h/j/k/l` move by
  geometry, and `l` from `a` returns to `c`, not `b` (MRU); each pane keeps its own mode (`b`
  has a focused input: insert there, normal in `a` and `c`; sub-spec 6's open per-pane mode
  item, now pinned end to end); `prefix+z` twice; `prefix+shift+h` swaps `c` with `a`
  (`x[c, y[b, a]]`); `prefix+r`, `l l`, `Esc` gives 767/511; the screenshot; Enter in `b`'s
  input requests DOM fullscreen (`b 1280x800 fs`) and Enter again leaves it with every width and
  the tree unchanged; `prefix+x` closes `b`'s pane and keeps its tab; a second workspace with a
  vertical split keeps it across `prefix+(`/`prefix+)`; a zoomed layout survives `ctrl+q` and a
  start on the same profile (zoom, focus, tree, ratios, then both workspaces again).
- **Prefs:** `browser.startup.page` is Vimma's own (resume), as in `m3-restart-restore`, and
  `full-screen-api.ignore-widgets = true`: Xvfb has no window manager to make the window
  fullscreen, and the window already fills the screen.
- **Stability:** 8 of 8 local runs green (headless artifact build, 3 of them under
  `taskset -c 0,1`), about 3.5 s. Mutation check: expecting `zoomed: false` after the restart
  fails at that step.
- **Screenshot:** the status bar shows the fixture server's URL, whose port changes between
  runs (in the URL bar and the status bar); about ten digits, far inside the 0.5 % tolerance. The
  baseline came from a throwaway branch with a placeholder baseline run through
  `workflow_dispatch`, since `scenario.test.mjs` requires every screenshot step to have a
  committed baseline and fails the e2e job before it would write CI's actual image.
- **Not covered here:** click focus (the harness only sends keys; `browser_vimma_pane_focus.js`
  covers it); key-to-paint timing for `prefix+l` (and m3's 200-tab `prefix+)` measurement) need a
  paint timestamp the control socket does not report; it belongs with the perf gate.

### Firefox 158: the panel border

Firefox 158 changed only the split view's CSS (`browser/themes/shared/tabbrowser/content-area.css`,
under `browser.nova.enabled`, on by default): every split panel's `.browserContainer` gets a
`--border-width` (1px) border in `--chrome-content-separator-color`, the focused one in
`--focus-outline-color` with its outline cut to `--focus-outline-width` minus that border (1px),
where 157 drew an inset 1px outline on the other panels only and the full 2px outline on the
focused one; the splitter's wider margin went from 3px to 2px. The panes' rects were unchanged,
but each page sat 1px inside its rect on every side, so the contract, layout and preset
mochitests failed their ±1 px checks (Δ 2–3 px), and the focused pane's outline was 1px. The
split-view JS (`tabsplitview.mjs`, `splitview/`, `tabbox` panel handling) is unchanged in 158:
order, limits and behaviour are as on 157. `split.css` now sets 157's drawing under
`[vimma-panes]` (Geometry above).

What is left of M4: nothing. The key-to-paint measurement needs the perf gate (issue #17) and
moves there.

## Breakdown into sub-specs

Each sub-spec is one session, ordered by dependencies. "Core" means PR #10 merged.

| #   | Sub-spec                      | Scope                                                                                                                                                                                                                                                                                                                                                                                         | Depends on                             |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | `m4-split-contract`           | Contract mochitest above (3 and 4 tabs); spike proving, at ±1 px against `layout()`, an L shape and a 4-pane grid, fullscreen enter and exit, focus outline, find bar, notification bar, `removeTab` on a 3-split member, docshell states after a rebuild, Tab-key panel order; decides rebuild vs contingency patch and ADR-013's acceptance; pref `browser.tabs.splitView.enabled = false`. | none                                   |
| 2   | `m4-split-layout`             | `split/PaneView.mjs` `reconcile` (membership, selection, geometry), `split.css`, `ResizeObserver`, zoom CSS, fullscreen yielding; driven from a test hook, no keys yet.                                                                                                                                                                                                                       | 1, core                                |
| 3   | `m4-split-keys`               | Host wiring: `split_vertical`, `split_horizontal`, `close_pane`, `focus_pane_*`, `zoom` through `withPanes`/`splitPane`; refusal message; explicit browser focus after a move.                                                                                                                                                                                                                | 2, M2 status bar (else console)        |
| 4   | `m4-split-focus-sync`         | `TabSelect`/`TabOpen`/`TabClose` → core → `reconcile`; click focus; the replace order for a tab shown in the focused pane; per-pane mode from the M1 actor; URL bar, find bar and zoom tests.                                                                                                                                                                                                 | 3, M1 actor for mode                   |
| 5   | `m4-split-swap-resize`        | `swap_pane_*`; the `resize` dispatcher mode (an ADR, since it changes the dispatcher contract) with h/j/k/l and `<>+-` at 0.05; which-key and help for resize mode.                                                                                                                                                                                                                           | 3                                      |
| 6   | `m4-split-workspaces-restore` | One wrapper per workspace across `prefix+)`/`prefix+(`; restore reconciliation with SessionStore; adopting foreign splits (`SplitViewCreated`, extensions).                                                                                                                                                                                                                                   | 4, M3 workspaces host                  |
| 7   | `m4-split-gate`               | e2e happy path with two real sites, screenshot baseline, fullscreen in a pane, key-to-paint timing; update plan.md §1/§3/§6 to ADR-013 if not done already.                                                                                                                                                                                                                                   | 1 to 6, control socket and `tools/e2e` |

Sub-specs 3 and 5 can run in parallel after 2. Sub-spec 6 waits for M3's workspace host.

## Out of scope

Mouse-drag dividers (resize is keyboard-only in M4); drag and drop of tabs or links onto panes
(Zen's drop zones); per-pane tab bars; moving a pane to another workspace or window; more than
one split per workspace; layout presets (Zen's grid/hsep/vsep; since done in
[tiling-layouts](tiling-layouts.md): tmux's presets and dwindle); Firefox's `about:opentabs`
picker for a new pane (ours opens the new-tab page).

## Settled

- **Firefox's split view, not Zen's.** The sub-spec 1 spike met all four of ADR-013's
  acceptance criteria ([ADR-013](../adr/013-split-on-firefox-split-view.md), Accepted).
- **Leaves are rebuilds; no contingency patch.** `removeTab` on a member of three does not
  throw, and a rebuild keeps the kept members active and scrolled (Sub-spec 1 results).
- **The host reorders panels** into reading order with `moveBefore` (Tab-key order).
- **Geometry is core's.** Firefox's two-column CSS is overridden, never patched.
- **Fullscreen does not touch the model.** It is upstream's transient visual zoom of the
  focused pane.
- **The selected tab is the focused pane.** It is the one invariant every pane-op test asserts.
- **DOM wins only for splits made outside Vimma.** Everything Vimma does goes core first, then
  `reconcile`.

## Known two-tab assumptions upstream

Listed with their handling in [ADR-013](../adr/013-split-on-firefox-split-view.md) (Known
two-tab assumptions): `reverseTabs`/`resetRightPanelWidth` (unused), `setSplitViewActive`'s
panel order (sub-spec 1 decides: host reorders or limit), `updateSplitViewAriaLabel` (host sets
the label for a third tab on), `TabsList` drag targets and `tabs.move` (limits), Glean labels
(harmless).

## Open questions

- ~~The default for `panes.max`~~: settled in [m3-m4-core-prep](m3-m4-core-prep.md): config
  `[panes] max`, default 4, 1 to 16, refused by core's `splitRefusal` (`max-panes`).
- Divider appearance and gap size: M5 theme tokens; M4 uses a 2 px gap and Firefox's focus
  outline.
