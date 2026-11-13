# Spec: tiling-layouts

Status: implemented · Milestone: after M4 (m4-split-panes listed "layout presets" as out of
scope) · Area: `packages/vimma-core/src/layouts.mjs` (new), `panes.mjs`, `snapshot.mjs`,
`config.mjs`, `defaults.mjs`, `actions.mjs`, `cmdline.mjs`; `split/PaneView.mjs`,
`host/pane-ops.mjs`, `host/VimmaHost.sys.mjs`, `config/ConfigHost.sys.mjs`. No upstream patch.

Tiling layouts offer **both** tmux-style presets and Hyprland-style dwindle. The spec builds
on [m4-split-panes](m4-split-panes.md) (the pane tree, `[panes] max`, `PaneView.reconcile`,
ADR-013's split view with our CSS positioning, ADR-014's resize mode) and its per-workspace
trees (sub-spec 6).

## User stories

- As a user, `ctrl+b enter` opens a new pane without my choosing a direction: it splits the
  focused pane along its longer side (a wide pane side by side, a tall one stacked), as
  Hyprland's dwindle does. The new pane shows the start page and has focus. Past `[panes] max`
  it is refused with the usual notice. `ctrl+b v` / `ctrl+b -` still split right / down.
- As a user, `ctrl+b space` cycles the panes through tmux's presets, and the status bar briefly
  names the one I got: `even-horizontal`, `even-vertical`, `main-vertical`, `main-horizontal`,
  `tiled`, `dwindle`. My pages are not reloaded; each keeps its scroll, form state and history.
- As a user, `:layout tiled` picks one by name (Tab completes the names), and each preset is an
  action I can bind in `config.toml` (`layout_tiled = ["prefix+alt+5"]`).
- As a user, `[panes] layout = "manual"` makes `ctrl+b enter` split right like `ctrl+b v`, and
  `[panes] main_size = 70` makes the main-* presets' big pane 70 %.
- As a user, each workspace keeps its own arrangement and remembers its last preset across a
  switch and a restart, so `ctrl+b space` continues from there.

## Research

- **tmux** (`layout-set.c`, 3.4): `next-layout` (`prefix space`) cycles `even-horizontal`,
  `even-vertical`, `main-horizontal`, `main-vertical`, `tiled` from the window's last layout
  (`w->lastlayout`), which manual splits and resizes leave alone. `select-layout` unzooms first.
  `main-*` use the window's first pane as the main one, sized by `main-pane-width` /
  `main-pane-height` (also a percentage). `tiled` fills rows first with `columns = ceil(√n)`,
  `rows = ceil(n / columns)`; the last row's panes take its whole width.
- **Hyprland dwindle** (`DwindleLayout.cpp`): a new window splits the focused node; the split is
  side by side when the node is wider than tall (`preserve_split` off, `split_width_multiplier`
  1), else stacked. Repeated, this makes the spiral. Ratios are even (`default_split_ratio` 1).
- **Vimma today:** core's tree (`panes.mjs`) keeps ratios per split in canonical form; PaneView's
  reconcile turns any tree into Firefox's one wrapper, reordering panels with `moveBefore` (an
  atomic move that keeps the `<browser>` and its document), and rebuilds the wrapper only when a
  tab leaves it. A preset changes neither membership nor tabs, so reconcile only reorders and
  re-lays out: no rebuild, no reload.

## Decisions

1. **Core module `layouts.mjs`, pure.** `LAYOUTS` (the cycle order above),
   `nextLayout(current)`, `dwindleDirection(panes, area)`, `layoutRefusal(panes, name)` and
   `arrange(panes, name, { area, mainSize })`. Builders take the panes' leaves (pane ids and tabs
   kept, so the host's tabs and browsers stay) and return a new canonical tree through
   `panes.mjs`'s `makeSplit`, now exported.
2. **The trees** (n leaves, `o` = reading order):
   - `even-horizontal`: `x[o…]`, each `1/n`; `even-vertical`: `y[o…]`.
   - `main-vertical`: `x[main, y[rest…]]`, ratios `[m, 1 − m]` (`rest` even; one rest pane is a
     leaf); `main-horizontal`: the same with `y` over `x`.
   - `tiled`: `columns = ceil(√n)`, `rows = ceil(n / columns)`; `y` of rows, each row `x` of up
     to `columns` panes in reading order, all even; the last row's panes share its width (2×2 at
     4, `y[x[a, b], c]` at 3, `x[a, b]` at 2).
   - `dwindle`: the first pane takes half of the area along its longer side, the rest recurse
     into the other half (`x[a, y[b, x[c, d]]]` on a wide window). `area` defaults to 16∶9.
3. **The main pane is the focused one** (tmux uses the first). It is the one being looked at, so
   "make this big" is one key away; the other panes keep their reading order after it. Applying
   a preset twice gives the same tree (idempotent), so `:layout main-vertical` again is a no-op.
4. **Focus and zoom:** the focused pane keeps focus (same pane, same tab), its page gets keyboard
   focus as after a pane move, and the MRU order is unchanged. A preset ends a zoom (tmux's
   `select-layout` unzooms). With one pane there is nothing to arrange: the notice says
   "Next layout: only one pane" and nothing changes.
5. **Cycling and the stored name:** `Panes.layout` (optional) is the last preset applied.
   `ctrl+b space` applies `nextLayout(layout)`: the one after it in `LAYOUTS`, wrapping, or the
   first without one. Like tmux, manual changes (split, close, swap, resize) keep the name, so
   cycling goes on from the last preset; core's spread-based updates keep it for free.
6. **No space:** a preset that would give a pane less than `MIN_RATIO` (10 %) of its split is
   refused with core's reason (only even-* past 10 panes and main-* past 11, with
   `[panes] max` up to 16): "Next layout: no space for 12 panes in even-horizontal".
7. **Dwindle for new panes:** `pane.new` (`ctrl+b enter`) splits the focused pane `vertical` when
   its rectangle (core's `layout` of the unzoomed tree in the content area's pixels) is at least
   as wide as tall, else `horizontal`, then runs exactly as `ctrl+b v` / `ctrl+b -` (same refusal,
   same new tab, same URL-bar focus). With one pane the rectangle is the content area.
8. **`[panes] layout = "dwindle" | "manual"`** (schema 2, default `"dwindle"`): what `pane.new`
   does. `"manual"`: `pane.new` splits right, as `ctrl+b v`, so the tree changes only the way you
   say. Explicit keys (`ctrl+b v`, `ctrl+b -`, the bookmarks panel's `s` / `S`) are never
   affected, and neither are presets. Adopting a split made outside Vimma stays a row (DOM wins).
9. **`[panes] main_size`** (schema 2, integer percent 20–80, default 60): the main pane's share in
   `main-*`. Read live like `max`.
10. **Actions:** `new_pane` (`pane.new`, `prefix+enter`), `next_layout` (`pane.next_layout`,
    `prefix+space`), `select_layout` (`pane.select_layout`, unbound: a key opens `:layout `), and
    one per preset, unbound: `layout_even_horizontal` … `layout_dwindle`
    (`pane.layout_even_horizontal` …). `prefix+enter` and `prefix+space` were free (defaults,
    Firefox's chords and `[modal.*]` checked).
11. **`:layout [name]`:** without a name it is `next_layout`; with one, `select_layout` (an
    unknown name says so, with the closest name). Tab completes the six names (core supplies them;
    `ARGUMENT_KINDS` gains fixed name lists, no host list needed).
12. **Status bar:** the notice (the status-bar toast, 1.5 s) shows the preset's name, e.g.
    `layout: tiled`.
13. **Persistence:** the snapshot already stores each workspace's tree; `layout` rides along as an
    optional field of `panes` (`toSnapshot` copies the tree). `fromSnapshot` keeps it when it is
    one of `LAYOUTS` and drops anything else without failing the restore. (Since changed:
    `fromSnapshot` is removed; `readSnapshot` in `snapshot.mjs` does this,
    [#956](https://github.com/vimma-browser/vimma/issues/956).) **No schema bump:** the
    shape only gains an optional field that schema-1 readers already ignore (`readPanes` reads
    named fields), as `alternate` and `tabLabels` did, so no migration is needed and an older
    build reads a newer file unchanged.
14. **Resizing after a preset:** the result is an ordinary tree, so resize mode and
    `ctrl+w < > + -` work on it; ratios start even except main-*'s `m`.

## Test plan

- **Vitest** (`layouts.test.mjs`): every preset at 1–4 panes (tree shape and ratios), tiled at 5–
  9, dwindle on wide and tall areas, focus and MRU kept, zoom cleared, `layout` set, idempotence,
  cycling order and wrap, round trips (any preset then any other keeps the same panes and tabs;
  six presses return to the first tree), `dwindleDirection` on wide, tall and square panes,
  refusals past `MIN_RATIO`, a fast-check property (any tree from random splits, any preset:
  same leaves, canonical, snapshot round trip). Snapshot: `layout` round trip and an unknown name
  dropped. Config: `layout` and `main_size` parse, defaults, errors. Cmdline: `:layout`,
  `:layout tiled`, completion. Actions/defaults: the new bindings.
- **Mochitest** `browser_vimma_pane_layouts.js`: `ctrl+b enter` from 1 to 4 panes checks each
  split's axis (side by side, stacked, side by side) and the refusal at 5; cycling every preset
  with 3 and 4 panes checks the tree and the on-screen rectangles against core's `layout()`
  (±1 px), the notice's text, and that no page reloaded (each `<browser>` is the same element,
  its `outerWindowID` and `browsingContext.id` unchanged, and `sessionHistory.count` unchanged);
  the preset name and arrangement survive a workspace switch and come back; resize mode still
  moves a divider after `main-vertical`; `:layout tiled` applies it.
- e2e: the m4 gate is unchanged (its keys and baseline still hold); the restore of `layout`
  is covered by the snapshot round trip and the mochitest's switch.

## Out of scope

Re-applying a preset automatically after a split (Hyprland's dwindle only governs where the new
pane goes; tmux applies presets on demand); a `[panes] layout` default preset applied at start;
mouse dividers; preserving ratios across presets.

## Results

Done: `layouts.mjs` (core), `PaneView.newPane` / `arrange` / `nextLayout`, `pane-ops.mjs`'s
`newPane` and `layoutPanes`, nine actions, `:layout`, `[panes] layout` and `main_size`, the
snapshot's optional `panes.layout`; tested by `layouts.test.mjs` (Vitest, including a fast-check
property over random trees) and `browser_vimma_pane_layouts.js` (8 tasks).

- **No reloads, measured:** after all six presets with 3 and with 4 panes, every pane's
  `<browser>` is the same element, with the same `outerWindowID`, `browsingContext.id`, window
  global (`innerWindowId`), session history length (2) and a JS marker set in its page before.
  Reconcile only reorders panels (`moveBefore`) and writes new rectangles; membership is unchanged.
- **Geometry:** each panel and browser sits at core `layout()`'s rectangle less half the pane gap
  on interior edges, within 1 px (1280 × 740 content area, headless artifact build).
- **Persistence:** main-horizontal and its name come back after a workspace switch and after a
  `SessionStore.setWindowState` restore; `ctrl+b space` then continues with `tiled`.
- **Red/green:** Vitest red (no `layouts.mjs`, then the snapshot's `layout`, then the actions,
  `:layout` and `[panes]` keys), green after (2320 tests). The mochitest red before the host code
  (17 unexpected: no `pane.new`, no notice), green after (348 checks); 14 of 14 repeats green
  under `taskset -c 0,1` load once a restore race in the test's own tab naming was fixed (a
  restored tab is `about:blank` until it loads; names now come from its session entry). Whole
  `tests/browser/` suite green (4176 checks).
- **Mutation check:** dropping `layout` in `readPanes` fails "the preset name is restored".
- **Snapshots:** `help.test.mjs.snap` (the name column widens for `layout_main_horizontal`, and
  the nine new rows) and `defaults.test.mjs.snap` (the two new keys, `[panes] layout` and
  `main_size`) were re-recorded; no e2e baseline changed (the help overlay's first screen ends
  before the new rows).
- **e2e:** the m4 gate is unchanged; its non-screenshot steps pass locally with the new keys.
