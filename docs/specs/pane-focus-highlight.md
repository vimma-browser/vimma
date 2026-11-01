# Spec: pane-focus-highlight

Status: implemented · Area: `src/browser/themes/shared/vimma/split.css`,
`tests/browser/browser_vimma_split_contract.js`, `tests/e2e/` (one scenario and its baselines),
`docs/guide.md` · Upstream patches: none · ADR: none

Issue: [#362](https://github.com/vimma-browser/vimma/issues/362)

Builds on [m4-split-panes](m4-split-panes.md) (sub-spec 2, the CSS that places the panes),
[side-panel-unsplit](side-panel-unsplit.md) (the hidden split) and [m7-a11y](m7-a11y.md)
("Focus colour", the `--vimma-focus` token). Engine references (`engine/…:line`) are Firefox 158.0
as imported by `npm run import`; Vimma file references are to `main`.

## Summary

In a split, the focused pane gets a border in the theme's focus colour, wide enough to find at a
glance, drawn inside its rectangle. A single pane, a zoomed pane, a hidden split and a page in DOM
fullscreen show no border. The pages do not move or reflow when focus changes, and the unfocused
panes look as they do today. The border is 3 px wide, and unfocused panes are not dimmed.

## Problem

- With two or more panes, the only mark of the focused one is Firefox's focus outline on its
  `.browserContainer`: 2 px wide (`--focus-outline-width`,
  `engine/toolkit/themes/shared/design-system/dist/tokens-shared.css:363-367`), drawn outside the
  pane's box, in the 2 px gap between panes (`--vimma-pane-gap`,
  `src/browser/themes/shared/vimma/split.css`). At an interior edge the cue is a 2 px line between
  two full-size pages; nothing on the pane's own surface marks it. In
  `tests/e2e/baselines/m4-split-panes.png` the focused pane `c` is told apart from `a` and `b` by
  that line alone.
- Firefox 158 draws less than that on its own: under Nova (`browser.nova.enabled`, on by default,
  `engine/browser/app/profile/firefox.js:2226`) every panel's container gets a 1 px border and the
  focused panel's outline is reduced by that 1 px
  (`engine/browser/themes/shared/tabbrowser/content-area.css:509-519`). `split.css` restores the
  whole 2 px outline, so the pages fill their rectangles; it does not make the cue any wider.
- The outline's colour is the theme's focus colour (`--vimma-focus`, the accent moved to 3:1 against
  the chrome it touches, [m7-a11y](m7-a11y.md)). Next to a page whose edge is close to that colour,
  or on a light theme where the accent is dark, the line disappears into the page.
- The status bar's `pane 2/3` says which pane is focused by number, not where it is. A user with
  three pages open looks for the pane before typing, and a key sent to the wrong pane scrolls or
  edits the wrong page.

## Behaviour

1. As a Vimma user with two or more panes, the focused pane has a border in the theme's focus
   colour along all four of its edges, inside its rectangle, and the other panes have none beyond
   today's 1 px separator. Moving focus with `ctrl+b h/j/k/l`, a click, or by picking one of the
   split's tabs moves the border to that pane at once, with no animation.
2. As a Vimma user, the pages do not change size, scroll position or layout when the border
   appears or moves: it is painted over the outermost pixels of the focused page.
3. As a Vimma user with one pane, I see no border: the window shows one page, as Firefox does.
4. As a Vimma user who zooms a pane (`ctrl+b z`, `ctrl+w o`), the zoomed pane shows no border
   while zoomed; unzooming brings the border back on the focused pane.
5. As a Vimma user whose split is hidden (`split 3 hidden` in the status bar,
   [Picking a tab during a split](../guide.md#picking-a-tab-during-a-split)), the tab shown alone
   has no border; bringing the split back shows the border on its focused pane.
6. As a Vimma user, a page that goes into DOM fullscreen (a video) fills the screen with no border,
   and leaving fullscreen restores the border on the same pane.
7. As a Vimma user on Omarchy, the border is my Omarchy theme's accent (or the accent moved to
   3:1 where the theme's accent would not stand out against its own chrome), the colour Omarchy
   gives Kitty's active split and Hyprland's focused window border. Anywhere else it is the
   built-in palette's focus colour: mint (`#1bf587`) on vimma dark, deep green (`#056536`) on vimma
   light, blue (`#7aa2f7`) on Tokyo Night. With the system's high-contrast setting on, it is
   Firefox's own high-contrast focus colour. (Since changed: with vimma.dev's "Aqua Split"
   palette the vimma focus colour is aqua (`#2cf5d2`) on vimma dark and deep teal (`#006659`)
   on vimma light.)
8. As a Vimma user, no key, command or `config.toml` key changes with this spec.

## Research

### Firefox 158.0 (`engine/`)

- **The focused panel.** `#tabbrowser-tabpanels[splitview] .split-view-panel.deck-selected > .browserContainer`
  gets `outline: var(--focus-outline)` and `z-index: 1`
  (`browser/themes/shared/tabbrowser/content-area.css:450-454`). `--focus-outline` is
  `var(--focus-outline-width) solid var(--focus-outline-color)` with `--focus-outline-width: 2px`
  (`toolkit/themes/shared/design-system/dist/tokens-shared.css:363-367`); `--border-width` is 1 px
  (`tokens-shared.css:36`). Under Nova every `.split-view-panel > .browserContainer` gets a
  `var(--border-width) solid var(--chrome-content-separator-color)` border, and the focused one's
  border takes the focus colour while its outline shrinks to
  `calc(var(--focus-outline-width) - var(--border-width))` (`content-area.css:504-519`).
- **When `splitview` is on.** `MozTabpanels.setSplitViewActive` toggles the `splitview` attribute
  from whether the selected tab's split view has panels
  (`toolkit/content/widgets/tabbox.js:530-545, 604-607`). While a tab outside the split is selected
  (Vimma's hidden split), the attribute is off and the split's panels are dormant
  (`content-area.css:397-402`).
- **DOM fullscreen.** Under `:root[inDOMFullscreen]` the non-selected panels are hidden
  (`-moz-subtree-hidden-only-visually`) and the selected panel's container loses its border,
  outline and radius (`content-area.css:423-441`).
- **No dimming, no header.** Firefox marks the non-selected panel with a footer
  (`split-view-footer`, `content-area.css:492-499`), which Vimma hides, and changes nothing about
  the page's rendering. The only transition is on a resized panel's width, 50 ms, off under
  `prefers-reduced-motion` (`content-area.css:483-489`).

### Vimma (`main`)

- `split.css` scopes its rules to `:root:not([inDOMFullscreen]) #tabbrowser-tabpanels[vimma-panes][splitview]`.
  `vimma-panes` is set by `split/layout.mjs:58` when a layout of two or more panes is applied and
  removed by `clearLayout` (`layout.mjs:116`) when the split ends. The gap between panes is
  `--vimma-pane-gap: 2px`, split half to each side of an interior edge, and what shows through it
  is the tabpanels' background, `--vimma-muted`. Unfocused panes' containers have an inset 1 px
  outline in `--chrome-content-separator-color`, which `firefox-chrome.css:29` maps to
  `--vimma-muted`; the focused one has the whole `--focus-outline`.
- `focus.css` sets `--focus-outline-color` to `var(--vimma-focus, var(--color-accent-primary))` on
  `:root`, except under `prefers-contrast` or `forced-colors`. `--vimma-focus` is the accent, moved
  toward black or white in 5 % steps until it reaches 3:1 against every surface a focus ring
  touches, the pane gap included (`packages/vimma-core/src/theme.mjs`, `--vimma-focus` in
  `THEME_TOKENS`, `FOCUS_SURFACE_TOKENS`, `readable()`; the values per palette are tabled in
  [m7-a11y](m7-a11y.md), "Focus colour").
- `tests/browser/browser_vimma_split_contract.js`,
  `the_focus_outline_find_bar_and_notifications_belong_to_their_pane`, asserts the focused
  container's `outlineWidth` is `2px` in `--focus-outline-color` and the others' is not.
- Zoom: every panel but the zoomed one gets `vimma-zoomed-away` (`split/layout.mjs:11`), is
  hidden visually and has its docshell deactivated; the zoomed panel carries no attribute and takes
  the whole rectangle ([m4-split-panes](m4-split-panes.md), "Geometry"). The status bar does not
  name the zoomed state.
- The e2e profile pins the built-in palette (`tools/e2e/launcher.mjs:46`,
  `vimma.theme.source = builtin`) and a light theme, so baselines are the vimma light palette; a
  run under the Omarchy theme (`vimma.theme.source = omarchy`, `vimma.theme.omarchyPath`) is for
  looking at screenshots, not for baselines (`docs/runbook.md`, "Baselines").

### Zen Browser (zen-browser/desktop at `185e856f`, `src/zen/split-view/zen-split-view.css`)

The focused panel is `.browserSidebarContainer.deck-selected`, with
`outline: 2px solid var(--zen-active-split-outline-color) !important` while
`#tabbrowser-tabpanels[zen-split-view="true"]` and not under DOM fullscreen (lines 80-84). The
colour is Zen's primary colour, 20 lightness points darker in light mode (line 72). Panels are
separated by a gap (`--zen-element-separation`, 8 px when the window has no padding, lines 92-99).
Zen does not dim unfocused panels: the only opacity changes on browsers are during a drag
(`ZenViewSplitter.mjs:724, 974`). No per-pane header strip is drawn.

### tmux 3.7c (`man tmux`; defaults from `show-options -g` on a fresh server)

`pane-active-border-style` defaults to `fg=green` (yellow while the pane is in a mode, red while
`synchronize-panes` is on) and `pane-border-style` to `default`, so the active pane is told apart
by the colour of its one-cell border alone. `pane-border-indicators` defaults to `colour`: with
exactly two panes, only the active pane's half of the shared border is coloured. `window-style` and
`window-active-style` can give inactive panes another background (how users dim them); both default
to `default`, so no dimming out of the box. `pane-border-status` (a title line per pane) is off by
default.

### Hyprland 0.56.2 under Omarchy 4.0.4 (`hyprctl getoption`; `omarchy-version`; Omarchy's `default/` tree)

`general:border_size` is 2, `col.active_border` a gradient from the theme's
`hyprland_active_border` or, when the theme does not give one, from its `accent`
(`~/.local/share/omarchy/default/themed/hyprland.lua.tpl:1-2`, `hypr_gradient … accent`), and
`col.inactive_border` `rgba(595959aa)`. `decoration:dim_inactive` is `false` (Hyprland's default,
`dim_strength` 0.5 unused), and Omarchy's `looknfeel.lua` does not turn it on. Omarchy also gives
Kitty `active_border_color {{ accent }}` (`default/themed/kitty.conf.tpl:9`): the accent is what
marks the focused window and the focused terminal split on an Omarchy desktop.

### Accessibility

WCAG 2.2 (W3C Recommendation, 2023-10-05) 1.4.11 Non-text Contrast asks 3:1 between a focus
indicator and adjacent colours; 2.4.13 Focus Appearance (AAA) asks an indicator at least as large
as a 2 CSS px thick perimeter of the component and 3:1 between its focused and unfocused states.
`prefers-reduced-motion` does not apply: nothing animates. `prefers-contrast` and `forced-colors`
do: there Firefox's own focus colour stays (`focus.css`).

## Design

The border is CSS only: one rule set in `split.css`, inside its existing scope. No new element,
attribute, actor message or core state, because the focused pane is already `.deck-selected` and
every state the border has to respect (single pane, zoom, hidden split, DOM fullscreen) is already
an attribute or class on the panels or `:root`.

1. **A border in the focus colour, not dimming and not a header.** The focused pane's
   `.browserContainer::after` is a frame, `border: var(--vimma-pane-focus-width) solid var(--focus-outline-color)`,
   absolutely positioned over the container (`inset: 0`, `border-radius: inherit`,
   `pointer-events: none`), and the container's own outline is removed, because a coloured border is
   the cue tmux (`pane-active-border-style`), Hyprland (`col.active_border`) and Zen (its 2 px
   outline) all use, it costs no space, and it leaves the pages' rendering alone. Rejected:
   dimming or desaturating unfocused panes, because pages and video split precisely to be watched
   side by side would look washed out, their text would fall below AA contrast, and tmux and
   Hyprland both ship with it off (decision 12). Rejected: a per-pane title strip, because it costs a
   line of vertical space per pane, needs theming, truncation and title updates of its own, and
   [m4-split-panes](m4-split-panes.md) left headers out; tmux's `pane-border-status` is off by
   default for the same cost.
2. **Inside the pane's rectangle, drawn over the page.** The frame covers the outermost pixels of
   the page, because the 2 px gap between panes is shared with the neighbour's separator and the
   content area's outer edges meet the toolbar and status bar: an outside outline, Firefox's, has
   no room of its own. It is a positioned pseudo-element rather than an inset outline on
   `.browserContainer`, because the container's outline is painted under the remote page: an
   inset outline has the right computed style and never shows on screen. `.browserContainer` is
   already `position: relative` (`content-area.css:171-174`), so the frame needs no new box and
   takes no space. Rejected: shrinking the pane's rectangle by the border, because the page would
   reflow on every focus change, and a video player or a responsive layout would resize each time.
3. **3 px wide, from one token.** `--vimma-pane-focus-width: 3px` is set once at the top of the
   scope, so that the mochitest, the guide and any later key name one number. 3 px is one step up
   from the 2 px of Firefox's ring and Hyprland's `border_size`, because 2 px is the cue the
   problem says is hard to find, and 3 px reads at a glance in a 1280 px window at 1x while
   staying inside the margin most pages leave at their edges. It also exceeds the 2 CSS px
   perimeter WCAG 2.2's 2.4.13 asks of a focus indicator. Rejected: 4 px, because it covers a
   fifth of a 20 px page margin and starts to read as a frame around the page rather than a cue.
4. **Colour: the theme's focus colour, through `--focus-outline-color`.** The border is
   `--focus-outline-color`, which `focus.css` sets to `--vimma-focus`, the theme's focus colour, because it is already the accent moved to 3:1 against the chrome it touches (the pane
   gap in `--vimma-muted` included) and is what the address bar's focus ring and every chrome focus
   ring use, so the cue is consistent and passes 1.4.11 against the chrome without a new
   calculation. On Omarchy that is the theme's `accent` (or its 3:1 adjustment): the colour of
   Omarchy's own Kitty active border and the Hyprland active border fallback, so the pane border
   matches the desktop's focused window. The border reads `--focus-outline-color` rather than
   `--vimma-focus` directly so that under `prefers-contrast` or `forced-colors`, where `focus.css`
   leaves Firefox's own high-contrast colour in that token while `--vimma-focus` keeps the accent,
   the border takes the high-contrast colour, and so that a window without the token sheet still
   gets Firefox's accent. Contrast against the page's
   own edge cannot be promised: the page's colours are unknown.
5. **Unfocused panes unchanged.** Their 1 px inset separator in `--chrome-content-separator-color`
   stays, because the gap already separates them and a second cue on the unfocused side would
   compete with the border. The border's visibility comes from its width and colour, not from
   changing the others.
6. **No border with one pane.** The rule lives inside `[vimma-panes][splitview]`, which
   `layout.mjs` sets only for two or more panes, so a single pane shows no border, because there
   is nothing to tell it apart from and Firefox's own single panel has none.
7. **No border while zoomed.** The rule adds `:not(:has(> [vimma-zoomed-away]))` to the scope
   (`vimma-zoomed-away` is set on every panel but the zoomed one, `split/layout.mjs:11, 89`; no
   attribute marks the zoomed panel itself, so the siblings are the only signal), so a zoomed pane
   draws no border, because one page is visible and the border would cover its edge for no
   information; the status bar's `pane n/m` still says a split exists. Rejected: a border as a zoom reminder, because the first pane key
   unzooms anyway and tmux shows its zoom flag in the status line, not on the pane.
8. **No border while the split is hidden.** Firefox turns `splitview` off while the selected tab
   is outside the split (`tabbox.js:604-607`), so the scope does not match and the tab shown alone
   has no border; nothing to add, and it keeps the hidden split indistinguishable from a single
   pane, which [side-panel-unsplit](side-panel-unsplit.md) made it look like.
9. **No border under DOM fullscreen.** The scope already excludes `:root[inDOMFullscreen]`, and
   Firefox strips the selected container's outline there (`content-area.css:431-441`), so a
   fullscreen video has no coloured frame, as [m4-split-panes](m4-split-panes.md) requires.
10. **No animation.** The border appears and moves at once, because a transition would delay the
    cue the user is waiting for, and Vimma's own UI animates nothing (`docs/guide.md`,
    Accessibility, "Motion"), so `prefers-reduced-motion` has nothing to turn off here either.
11. **No config key.** No `[panes]` key is added, because the width is one value for everyone
    (decision 3) and nothing else about the border is a choice to switch (decision 12).
12. **No dimming of unfocused panes, not even as an option.** Unfocused pages keep their full
    colours and opacity, and no `[panes] dim_unfocused` key is offered, because pages and video are
    split precisely to be watched side by side, dimming lowers their text contrast below WCAG AA,
    and tmux (`window-style`) and Hyprland (`decoration:dim_inactive`) both ship with it off; the
    border alone is the cue. Rejected: an opt-in dimming percentage, because it adds a key, a
    schema entry and tests for a look that works against the reason for splitting, and a later
    spec can add it if the border proves not enough. Rejected: dimming by default, for the same
    reasons and because it changes every split page's rendering.

## Security and privacy

No new surface: a CSS rule in a chrome sheet reads the panel's class and the theme's tokens, and
exposes nothing to pages or to the control socket.

## Tests

- **mochitest** (`tests/browser/browser_vimma_split_contract.js`, the existing task
  `the_focus_outline_find_bar_and_notifications_belong_to_their_pane` changes its assertions from
  Firefox's 2 px outline to the spec's; written first and seen to fail on `main`):
  - `the_focused_pane_has_the_focus_border`: with three panes in an L shape, the focused panel's
    `.browserContainer::after` has a `solid` border of `--vimma-pane-focus-width` on every edge in
    `--focus-outline-color`, `position: absolute`, `inset: 0` and `pointer-events: none`, and the
    container has no outline; the other two have no frame and keep the 1 px separator outline in
    another colour. The window's pixels (`drawSnapshot`, with the remote pages composited) show
    the focus colour 1 px inside the focused pane's edge and not inside the others'. Picking
    another pane's tab, and clicking into a pane, move the border at once.
  - `the_pages_keep_their_size_when_focus_moves`: each `<browser>`'s bounding rectangle is the
    same before and after a focus move, and equals the pane's rectangle from `layout()`.
  - `one_pane_zoom_hidden_split_and_fullscreen_show_no_border`: with one pane the container's
    `outlineStyle` is `none` and it has no frame; zoomed as the host zooms (one rectangle, the
    other panels `vimma-zoomed-away`), the zoomed pane has no border and after unzoom it has; after selecting a tab outside the split none of the panels has one,
    and after going back to a split tab the focused one has; under `requestFullscreen` from the
    focused pane none has, and after `exitFullscreen` the same pane has.
  - `a_theme_colors_accent_override_applies_live` (in
    `tests/browser/browser_vimma_focus_accent.js`, which already checks the focused pane's colour
    per palette, now also its 3 px width): after `[theme.colors] accent` changes in
    `config.toml`, the border's colour is the new `--vimma-focus` without a restart.
- **e2e** (`tests/e2e/scenarios/issue-362-pane-focus-highlight.json`, under Xvfb, the vimma light palette):
  two fixture pages, `ctrl+b v`, `ctrl+b h` (the left pane focused), screenshot
  `issue-362-pane-focus-highlight-2`; `ctrl+b -`, screenshot `issue-362-pane-focus-highlight-3` (the new bottom-left
  pane focused). The existing `m4-split-panes` baseline changes, since its screenshot shows a
  focused pane; it is re-taken from CI's actual image and committed with its own `CHANGELOG.md`
  line (`docs/runbook.md`, "Baselines"). Before the PR merges, the same scenario is run with
  `vimma.theme.source = omarchy` and `vimma.theme.omarchyPath` pointing at the current Omarchy
  theme, and the screenshots are looked at; they are not committed.

## Docs and changelog

- `docs/guide.md`: the `ctrl+b h j k l` row of Keys says the focused pane has a border in the
  theme's focus colour; "Colours and themes" replaces "the outline of the focused pane in a split"
  with the border, and names it on Omarchy as the theme's accent; Accessibility's "Contrast" line
  adds that the pane border reaches 3:1 against the chrome around it.
- `CHANGELOG.md` [Unreleased]: one line for the border (the squash subject) and one for the
  `m4-split-panes` baseline.
- README: no change (Features at a glance already lists split panes).

## Delivery

One PR: `split.css`, the mochitest changes, the e2e scenario with its two new baselines and the
re-taken `m4-split-panes` baseline, the guide and the two changelog lines.
