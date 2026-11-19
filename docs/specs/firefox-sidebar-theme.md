# Spec: firefox-sidebar-theme

Status: implemented, with a follow-up from screenshots (PR #148) · Milestone: after M5 (builds on [m5-omarchy-theme](m5-omarchy-theme.md) and
the focus colour of [m7-a11y](m7-a11y.md)) · Area: `ui/theme-host.mjs`,
`browser/themes/shared/vimma/firefox-sidebar.css` (new),
`browser/themes/shared/vimma/firefox-sidebar-page.css` (new),
`tests/browser/browser_vimma_sidebar_theme.js` (new). No upstream patch.

## Goal

Both side panels follow the theme colour. "Both" means Vimma's own side panel (`ctrl+b b`, fixed by
PR #146: its scrollbar was the last part not on the theme) and Firefox's own sidebar: the panel
behind the toolbar's sidebar button (history, bookmarks, synced tabs), the new sidebar's launcher
strip, and `#sidebar-box` with its splitter. Today that sidebar is Firefox grey (`#2b2a33`) with a
blue system focus ring, whatever the Vimma theme.

## User stories

- As a user with a dark Omarchy theme, opening Firefox's history or bookmarks sidebar shows it on
  the theme's dark surface (`--vimma-bg-dark`, the same as Vimma's side panel and status bar), its
  text in the theme's foreground, its edge in the theme's muted colour, and its focus rings in the
  theme's focus colour.
- As a user with a light Omarchy theme (or the built-in vimma palette on a light desktop), the
  sidebar is light: surface, text and Firefox's own widgets (cards, buttons, scrollbars) take the
  light scheme.
- As a user, when `omarchy-theme-set` switches the theme, an open sidebar follows within the poll
  interval, without reopening it. A panel opened later starts in the new theme.
- As a user, the launcher strip (the column of sidebar buttons) is on the same surface, with its
  icons in the theme's foreground.

## Research

### Vimma today

- `ui/theme-host.mjs` turns the palette (core `theme.mjs`, `themeStylesheet`) into one data: URI
  stylesheet of `--vimma-*` tokens on `:root`. `ThemeHost.init(win)` loads it into each browser
  window as an author sheet (`windowUtils.loadSheetUsingURIString`), with `focus.css`, and
  `apply()` swaps the sheet in every registered window on a theme change
  (`theme-host.mjs:99-117`, `init` at `:253-268`). Start pages and about:vimma get a `<style>`
  instead (`attachDocument`).
- `focus.css` points Firefox's `--focus-outline-color` (and the URL bar's focus token) at
  `--vimma-focus`, `!important` because a Firefox theme sets them inline on the root
  (`focus.css:13-20`). It is loaded into the main window only.
- Nothing in Vimma touches Firefox's sidebar colours: `grep -rn sidebar src/browser/themes`
  matches only Vimma's own side panel (`side-panel.css`).
- No Zen checkout is available on this machine to compare with.

### Firefox (engine/)

- **Structure** (`browser/base/content/browser-box.inc.xhtml:6-27`): `#sidebar-container` holds
  the launcher (`<sidebar-main>`, a custom element with shadow DOM); `#sidebar-box` holds the
  panel's header and `<browser id="sidebar">` (line 24), a non-remote browser whose documents
  are separate chrome documents (`chrome://browser/content/sidebar/sidebar-history.html`,
  `places/bookmarksSidebar.xhtml`, ...); `#sidebar-splitter` resizes it.
- **The window's colours** are three of Firefox's tokens: `--sidebar-background-color`,
  `--sidebar-text-color` and `--sidebar-border-color`. Defaults in
  `toolkit/themes/shared/design-system/dist/tokens-platform.css:212-215`; a Firefox theme
  (including the built-in dark one) overrides them inline on the root through
  `LightweightThemeConsumer.sys.mjs:599` and `browser/themes/ThemeVariableMap.sys.mjs:116-140`.
  With `sidebar.revamp` (on, `firefox.js:2279`) the panel's paint is the `#sidebar` browser's
  background (`browser/themes/shared/sidebar.css:69-80`); under Nova (`browser.nova.enabled`, on)
  `#sidebar-box` paints it too and draws its edge in `--chrome-content-separator-color`, or
  `--sidebar-border-color` under a theme (`sidebar.css:511-524`). `#sidebar-box`'s
  `color-scheme` comes from the theme's `lwt-sidebar` attribute (`sidebar.css:10-15`).
- **The launcher** has no background of its own: it shows the body's
  `--toolbox-background-color` (`browser-shared.css:251`), or `--sidebar-launcher-surface-color`
  when it expands on hover (`sidebar.css:329-343`). Its buttons are ghost `moz-button`s:
  text `--button-text-color-ghost` (often `inherit`, `tokens-shared.css:152`) and icon fill
  `--toolbarbutton-icon-fill` (`sidebar-main.css:108`).
- **The documents** do not inherit custom properties from the window. Each imports
  `browser-colors.css` again (`browser/components/sidebar/sidebar.css:5-17`, root `color:
var(--sidebar-text-color)`, background transparent; `browser/themes/shared/places/sidebar.css:7-12`
  likewise). A Firefox theme reaches them through `contentTheme.js:72-120`, which the
  `LightweightTheme` actor drives (`DesktopActorRegistry.sys.mjs:624-650` lists the sidebar
  URLs): it sets the same variables inline on the document's root and `lwt-sidebar` for the
  colour scheme. The documents' focus rings use their own `--focus-outline-color`, Firefox's
  accent: the blue ring.
- **CSP**: the revamp documents allow only `default-src resource: chrome:`
  (`sidebar-history.html:9-12`), so a `<link>` or `<style>` with a data: URI would be blocked. An
  author sheet loaded through `windowUtils` is not subject to the page's CSP.
- **Loads**: `SidebarController._show` sets the browser's `src` and waits for `load` with a
  capturing listener on the browser (`browser-sidebar.js:2335-2361`). That is the frame
  element's own `load`, which the frame loader fires on `<browser>` in the window: the documents'
  other events (`DOMContentLoaded`) stay in their own document and never reach the window, as a
  first try at this spec found. The `document-element-inserted` observer topic fires for every
  document in the parent process as soon as it has a root element, before it is styled; the
  document's `browsingContext.embedderElement` is then the `#sidebar` browser.

### Measured before the fix (the new mochitest, dark Omarchy fixture)

The launcher is transparent over the toolbox, text `rgb(251, 251, 254)`; `#sidebar-box` and the
`#sidebar` browser `rgb(43, 42, 51)`; the history document's text `rgb(251, 251, 254)`, its
`color-scheme` `normal`, its `--focus-outline-color` `rgb(0, 96, 223)`. None follows a theme
switch.

## Decisions

1. **Use Firefox's own variables, no upstream patch.** A Vimma sheet sets
   `--sidebar-background-color: var(--vimma-bg-dark)`, `--sidebar-text-color: var(--vimma-fg)`,
   `--sidebar-border-color: var(--vimma-muted)` and the two `--lwt-sidebar-highlight-*` (the places
   tree's selected row: `--vimma-selection`, `--vimma-fg`) on `:root`, `!important` because a
   Firefox theme sets them inline (the same reason as `focus.css`). Everything Firefox draws with
   them (the panel, its edge, the places trees, the synced tabs list) follows without our
   selectors. `--vimma-bg-dark` is the surface Vimma's side panel, pickers and status bar use, so
   the two sidebars match.
2. **Two sheets.** `firefox-sidebar.css` goes into the window with the tokens (ThemeHost.init):
   the variables above, plus the few rules Firefox does not drive from them: the launcher's
   surface, text and icon fill, `#sidebar-box`'s edge colour under Nova, and `color-scheme:
var(--vimma-color-scheme)` on the launcher and the box (instead of `lwt-sidebar`).
   `firefox-sidebar-page.css` goes into each sidebar document: the variables, `color-scheme`, and
   `--text-color` (the design system's text, used by the cards and lists) on its root. It is a
   separate file because `:root` there is the document, and the window's root colour scheme must
   not change.
3. **Every document the `#sidebar` browser loads gets the tokens, `focus.css` and the page sheet**
   as author sheets, from `ThemeHost`: one `document-element-inserted` observer, added with the
   first window, keeps the documents whose embedder is `#sidebar` in a window ThemeHost themes,
   plus the document already there at `init`. They are kept by document, not by window (the
   sidebar's window object outlives its documents), and `apply()` swaps their token sheet with
   the windows', so a theme switch reaches an open panel; a document leaves on `unload`.
   `focus.css` in the document replaces the blue ring with `--vimma-focus`. Extension sidebars
   load `webext-panels.xhtml` into the same browser: its frame takes the surface, the extension's
   own page keeps its own colours.
4. **No high-contrast gate** beyond what `focus.css` already has: Vimma's own surfaces do not
   switch to system colours under `prefers-contrast` either, and forced colours override author
   colours anyway.
5. **Scope:** colours only. Whether the launcher strip should show at all, and the toolbar (which
   Vimma does not theme), are open questions below.

## Test plan

`tests/browser/browser_vimma_sidebar_theme.js` (new, Linux only, as `browser_vimma_theme.js`: it
swaps a symlink as `omarchy-theme-set` does), with its own three Omarchy fixtures (two dark,
one light with `light.mode`). For each case it checks, against the window's current tokens:

- the launcher: visible, background `--vimma-bg-dark`, text `--vimma-fg`, `color-scheme` the
  theme's; the window's `--focus-outline-color` is `--vimma-focus` (the splitter's and the
  launcher's rings);
- `#sidebar-box`: what shows behind it is `--vimma-bg-dark`, its inline-end edge `--vimma-muted`,
  `color-scheme` the theme's;
- the `#sidebar` browser: background `--vimma-bg-dark`, text `--vimma-fg`;
- the panel document: its body's text `--vimma-fg`, what shows behind the body `--vimma-bg-dark`,
  `color-scheme` the theme's, its `--sidebar-background-color` `--vimma-bg-dark`, its
  `--focus-outline-color` `--vimma-focus`.

Cases: the history sidebar under a dark theme; the same open document after a symlink swap to
the second dark theme (runtime switch, no reopen); the bookmarks sidebar (a XUL places document)
opened after the switch; the history sidebar under the light theme.

Also run: `npm test`, `npm run typecheck`, `npm run lint`, `browser_vimma_theme.js`,
`browser_vimma_side_panel.js`, `browser_vimma_focus_rings.js`, `browser_vimma_focus_accent.js`,
and the e2e. No screenshot baseline shows Firefox's sidebar, so none should change.

## Results

### Follow-up: what the first fix missed (screenshots)

Screenshots under two Omarchy themes (Ristretto, dark; Catppuccin Latte, light) found three places
still in Firefox's colours, which the first test did not see because it checked variables, not the
elements that paint:

1. **The search box** (`moz-input-search`, its `<input>` in a shadow root): filled with `Field`
   (`#2b2a33` dark, white light), text `FieldText`, and focused with the UA's `outline: auto`,
   which the non-native theme paints in the input's `accent-color`, `--color-accent-primary`
   (`moz-input-common.css`): the system accent, `#0060df`. Fix (`firefox-sidebar-page.css`):
   `--color-accent-primary` (and its hover and active shades) is `--vimma-focus`;
   `--input-text-background-color` and `--background-color-box` are `--vimma-bg`,
   `--input-text-color` `--vimma-fg`, `--input-text-border-color` `--vimma-muted`, `--icon-color`
   `--vimma-fg` (and, since Firefox 159, `--input-background-color` and `--input-border-color`:
   see "Firefox 159" below). Gecko still draws its 1px halo around the ring in the accent's contrasting
   colour (`Theme.cpp`, `PaintAutoStyleOutline`): white around Latte's dark blue, a dark tint
   around Ristretto's peach. It is derived from the theme's focus colour, not Firefox's palette.
2. **The open panel's launcher button** (`<sidebar-main>`, a pressed non-ghost `moz-button`):
   Nova's `--button-background-color-active` is `AccentColor` at 30% (`#172f55` on Ristretto),
   and Nova borders a non-ghost button in `--color-accent-primary`, which is resolved on the
   window's root, so pointing that variable at a Vimma token on `#sidebar-container` would not
   reach it. Fix (`firefox-sidebar.css`): `--button-background-color-selected` is
   `--vimma-selection` and `--button-text-color-selected` `--vimma-fg-bright`, as Vimma's own
   side panel shows its selected row; the four `--button-border-color*` are transparent; hover and
   press are the text colour at 17% and 30%, as Firefox's ghost buttons are, instead of
   `AccentColor`. The same button variables are set in the panel documents.
3. **The lists' scrollbars**: a white track under both themes. The history list
   (`.sidebar-panel-scrollable-content`) inherits `scrollbar-color`, so the page sheet sets
   `--vimma-muted` on `--vimma-bg-dark` on its root, as `side-panel.css` does. The bookmarks
   `<tree>` draws its own `<scrollbar>` element in its shadow root, which `scrollbars.css` resets
   with `all: initial` (for its style cache), so nothing inherited reaches it, Firefox's own themed
   `.sidebar-panel[lwt-sidebar]` rule included. `ThemeHost` adopts one constructed sheet into each
   tree's shadow root once the document is parsed (`scrollbar { scrollbar-color: var(--vimma-muted)
var(--vimma-bg-dark) }`; custom properties survive `all`, so it follows a theme switch).

The mochitest now checks the rendered values on those elements, under the dark, switched, light
and built-in themes, for history and bookmarks: the focused search field's ring colour
(`accent-color` for `outline: auto`), background, text and border; the pressed launcher button's
background, text and border; the computed `scrollbar-color` of the history list and of the
bookmarks tree's `<scrollbar>`. Red before the fix: 49 failed assertions (seven per
case); then 7 for the launcher's border and 2 for the tree's
scrollbar as those gaps were found; 215 pass after.

Screenshots (a temporary mochitest, not committed; 28 history entries, 40 bookmarks filtered to
overflow the tree, search box focused): before, the ring was `#0060df`, the field `#2b2a33` or
white, the launcher button `#172f55` with a `#0060df` edge, the scrollbar tracks `#ffffff`; after,
on Ristretto the ring is `#f7b5a2` (`--vimma-focus`), the field `#2c2525`, the launcher button
`#403e41`, the tracks `#211b1b` with a `#72696a` thumb, and no Firefox blue, grey or white pixel
is left in the sidebar; on Latte the same with Latte's colours (ring `#1852c4`, tracks `#e3e4e8`).

### Follow-up: the tree's rename field, and the notice

The tree's inline rename field (`html|input.tree-input` in `MozTree`'s shadow root, `tree.js`;
`toolkit/themes/shared/tree/tree.css` gives it `appearance: none`, no border and
`outline: var(--focus-outline)` but no colours) was left on the UA's `Field`/`FieldText`
(`#2b2a33` or white) with its selected text in `Highlight`. No document sheet reaches into the
shadow root and Firefox drives it from no variable, so `ThemeHost` adds its rules to the sheet it
already adopts into each tree's shadow root for the scrollbar (now `TREE_RULES`, `colourTrees`):
the field on `--vimma-bg` with `--vimma-fg` text, as the search box, and its selected text on
`--vimma-selection` in `--vimma-fg-bright`, as a selected row. Its ring was already
`--vimma-focus` (`focus.css` in the document). Firefox's bookmarks sidebar tree is not `editable`
by default (the folder tree in the bookmark dialog, `editBookmark.js`, is), so the field shows
there only once a tree opts in; the test and the screenshots set `editable` to show it. Red before
the fix: 8 failed assertions (surface, text, selection surface and text, bookmarks under the
switched dark and the light theme); green after.

Vimma's own toast (`ui/notice.mjs`, `notice.css`) was the last Vimma surface on `Canvas`/
`CanvasText` ("theme tokens come in M5"). It now uses the tokens the command line and pickers use,
with the same system-colour fallbacks: `--vimma-bg-dark` surface, `--vimma-fg` text, a
`--vimma-muted` border and `color-scheme: var(--vimma-color-scheme)`. `browser_vimma_theme.js`
checks its painted colours under the dark, light and built-in light themes (12 failed assertions
before the fix, green after).

Screenshots (a temporary mochitest, not committed; the bookmarks sidebar renaming a bookmark in
place, a notice showing) under Ristretto, a dark Omarchy theme and Catppuccin Latte: the field is the theme's
background with its text and selection, ringed in the focus colour, and the toast sits on the status
bar's surface with the theme's text and muted edge; no `Field` grey or white is left.
`event-horizon` (an Aether-made `colors.toml`) is rejected by the validator (no `selection`,
`muted`, `dark_background`, ... keys), so it shows the built-in palette.

Not covered: nothing known in the sidebar.

### Firefox 158: the launcher is a tab list

Firefox 158 made the launcher's buttons tabs (`browser/components/sidebar/sidebar-main.mjs`:
`buttonrole="tab"`, `role="presentation"` on the `moz-button`): the open panel's button now
carries `aria-selected="true"` on its inner `<button>` instead of `aria-pressed="true"`.
`moz-button.css` (158) styles `[aria-selected="true"]` with the same `--button-*-selected` tokens
as `[aria-pressed="true"]`, so `firefox-sidebar.css` needed no change of rule, only its comment.
The mochitest found the open panel's button by `aria-pressed` and so timed out waiting for every
panel to load, and found no pressed launcher button after a theme switch; it now looks for
`aria-selected`, with the same assertions. The panel structure (`#sidebar-box`,
`<browser id="sidebar">`, the documents' URLs, `SidebarController.show`) is unchanged in 158;
the other launcher changes (default tool order `opentabs,bookmarks,aichat,history,syncedtabs` in
`SidebarManager.sys.mjs`, the Customize button kept last) do not touch the theme.

### Firefox 159: the input tokens are renamed

Firefox 159 (checked on 159.0b1, against 158.0) renamed the design system's text-input tokens and
dropped the old names: `toolkit/content/widgets/moz-input-text/moz-input-text.css` paints the field
with `background-color: var(--input-background-color)` and `border: var(--input-border)`, where it
used `--input-text-background-color` and `--input-text-border` in 158. The design tokens
(`toolkit/themes/shared/design-system/dist/tokens-shared.css`, `tokens-platform.css`) define
`--input-background-color` (`Field`, or `--background-color-box` under Nova), `--input-border`
and `--input-border-color` (now `--border-color-interactive`, a stronger grey than 158's
`--border-color`), and no `--input-text-background-color`, `--input-text-border*`,
`--input-text-min-height`, `--input-text-icon-size` or `--input-text-opacity-disabled`.
`--input-text-color` keeps its name. The search rules moved from `moz-input-text.css` into a new
`moz-input-search.css` that imports it; the selectors and the focus ring
(`outline: var(--focus-outline)`, `accent-color` from `--color-accent-primary`) are unchanged.

So on 159 the history and bookmarks search field went back to `Field` (`#2b2a33` dark, white
light) with a `#949297` or `#817f84` border: the mochitest failed 14 assertions (background and
border, for history and bookmarks under the dark, switched, light and built-in themes), and
nothing else in the sidebar changed. `firefox-sidebar-page.css` now sets both generations of the
two tokens to the same Vimma tokens (`--input-text-background-color` and
`--input-background-color` to `--vimma-bg`, `--input-text-border-color` and
`--input-border-color` to `--vimma-muted`), so the same sheet works on 158 and 159; the 158 names
can go once Vimma no longer builds on 158. The assertions are unchanged: 232 checks pass on both
158.0 and 159.0b1.

## Open questions

- Should the launcher strip (the sidebar buttons column) show at all in Vimma, or be hidden as
  the tab strip is, leaving the panel only? This spec only colours it.
- Firefox's toolbar (`#nav-bar`) is still on Firefox's colours. Should it follow the theme too?
  That is a larger change (URL bar, buttons, menus) and its own spec.
- Hover and selected rows in the revamp lists (history, synced tabs) use Firefox's translucent
  `currentColor` mixes, which now tint the theme's text. Should they use `--vimma-selection` as
  Vimma's lists do?
