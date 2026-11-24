# Spec: m0-tabstrip-hidden

Status: implemented · Milestone: M0 · Area: UI (`src/browser/base/content/vimma/ui/`,
`src/browser/themes/shared/vimma/`)

## User story

As a Vimma user, I don't see Firefox's tab strip: the window starts with the nav bar and URL bar
at the top, like Vimma will look once M2 brings its own status bar and tab picker. Until then I
still open, close and switch tabs with Firefox's own keys, the window controls are still
there when the browser draws its own titlebar (GNOME/KDE with CSD), and I can bring the strip
back from about:config without restarting.

## Scope

- **Pref `vimma.ui.tabstrip.hidden`** (bool, default `true`, in our default pref file
  `browser/branding/vimma/pref/firefox-branding.js`). Read and observed per window: flipping it
  shows or hides the strip live, with no restart.
- **Mechanism.** `ui/tabstrip.mjs` (a `TabStrip` per window, started by `VimmaHost.init` after
  the key listener, in a `try`/`catch`: a failure there must never cost the Vimma keys):
  - sets the attribute `vimma-tabstrip-hidden` on the window root (`<html>`) from the pref;
  - loads `chrome://browser/skin/vimma/tabstrip.css` (author sheet, registered in our `jar.mn`
    from `browser/themes/shared/vimma/tabstrip.css`, as in m0-help-overlay), which keys off it:
    `#TabsToolbar` gets `visibility: collapse` (zero height, as Firefox's own `collapsed`), and
    with vertical tabs (`sidebar.verticalTabs`) the tab list `#vertical-tabs` is `display: none`.
    Popups and taskbar tabs (`[popup-window]`, `[taskbartab]`) are excluded;
  - re-runs `TabBarVisibility.update(true)` when the pref flips or customize mode starts or ends.
- **One upstream patch**, `src/browser/components/tabbrowser/content/tab-bar-visibility-js.patch`
  (one hunk): `TabBarVisibility.update()` treats the root attribute like its own hidden cases for
  `tabs-hidden` on `#navigator-toolbox` and the nav bar's `browser-titlebar` class, so Firefox's
  titlebar handling applies (see Settled). `TabsToolbar.collapsed` and the File menu are untouched.
  (Since changed: Firefox 162 turned `tab-bar-visibility.js` into the module
  `tab-bar-visibility.mjs` (Mozilla bug 2080285), so the patch is now
  `tab-bar-visibility-mjs.patch`, with the same hunk.)
- **"List all tabs" is unavailable while the strip is hidden** (until M2's picker): Firefox opens
  it only when `#alltabs-button` (inside the strip) has a size, and itself hides View > List All
  Tabs and the ctrl+tab "show all" button when it cannot.
- **Customize mode** shows the strip while customizing (`:root[customizing]`), so its widgets can
  still be moved; it hides again on leaving.
- No build-config change: the patch is chrome JS, so `npm run import` + `npx surfer build --ui`.

## Tests (write first)

`tests/browser/browser_vimma_tabstrip.js`:

- Given default prefs, then `vimma.ui.tabstrip.hidden` is `true`, the root has
  `vimma-tabstrip-hidden`, `#TabsToolbar` and `#tabbrowser-tabs` have zero height, and `#nav-bar`
  and the URL bar are visible; `ctrl+l` focuses the URL bar.
- Given the strip hidden, when the pref is set to `false`, then `#TabsToolbar` is visible again
  without a restart; when it is set back to `true`, it is hidden again.
- Given the strip hidden, when `ctrl+t`, then a new tab is selected; `ctrl+w` closes it. After
  each, with no manual update, `#navigator-toolbox[tabs-hidden]` and the nav bar's
  `browser-titlebar` class are set (the test clears both first and simulates `customtitlebar`).
- Given three tabs and the strip hidden, `ctrl+tab` and `ctrl+pagedown` select the next tab,
  `ctrl+shift+tab` the previous one, and the tab-number key (`ctrl+2`; `alt+2` on Linux)
  the second tab.
- Given the strip hidden, then `gTabsPanel.canOpen` is false; with the pref `false`,
  `Browser:ShowAllTabs` opens the all-tabs panel listing every tab.
- Given a popup window, when it gets a second tab, then its `#TabsToolbar` is visible (Firefox's
  "prevent tabs being lost").
- Given the strip hidden and a titlebar drawn by the browser (`customtitlebar`), then the window
  controls are in `#nav-bar` and visible, `#nav-bar` is a drag region (`browser-titlebar`), and
  none are left in `#TabsToolbar`. When the system cannot draw one (headless, tiling WMs), the
  test sets the attribute itself, as `CustomTitlebar` would.
- Given fullscreen, the strip stays hidden and the nav bar is still in the toolbox.
- Given customize mode, the strip is visible; after leaving it, hidden again.
- Given vertical tabs (`sidebar.revamp`, `sidebar.verticalTabs`), the vertical tab list has no
  size; with the pref `false` it is visible.
- Given the strip hidden, when `ctrl+b` `?`, then the help overlay opens.
- Given `TabStrip.init` throws, when the host starts, then `ctrl+b` `?` still opens help.

## Out of scope

Vimma's own tab UI and keys (`prefix+c`, `prefix+1..9`, `prefix+n/p`), the status bar's
`tab 2/5` and the `prefix+g` picker (M2); hiding the sidebar launcher (M3 side panel); theme
tokens (M5); a settings UI for the pref.

## Settled (2026-10-09, from the engine tree)

- **Element ids** (`browser/base/content/navigator-toolbox.inc.xhtml`): the horizontal strip is
  `toolbar#TabsToolbar` (contains `#tabbrowser-tabs`, `#new-tab-button`, `#alltabs-button`, the
  private-browsing indicator and a copy of `titlebar-items.inc.xhtml`, the window controls).
  Vertical tabs live in `#vertical-tabs`, the `tabstrip` slot of `<sidebar-main>` in
  `browser-box.inc.xhtml`, under `#sidebar-container`.
- **Window controls.** Firefox 157 includes the window controls (`.titlebar-buttonbox-container`)
  in `#toolbar-menubar`, `#TabsToolbar` and `#nav-bar`; `browser-shared.css` shows them in the
  first visible toolbar only, keyed on `#navigator-toolbox[tabs-hidden]`, which
  `tab-bar-visibility.js` sets for popups and vertical tabs. Its `update()` recomputes that
  attribute on every call (tab open/close, titlebar pref, customize mode), so the patch adds our
  root attribute to its condition. This reuses upstream's maintained path rather than copying
  its CSS conditions (menubar shown permanently, fullscreen, CSD button order, spacers, inactive
  opacity, private-browsing indicator). Under Hyprland there is no `customtitlebar` and no
  controls anywhere, as in Firefox; nothing to replace. `menu_closeWindow` and the File menu's
  "Close Tab" label stay as Firefox computes them (we do not hide the strip from Firefox's model,
  only from view).
- **`visibility: collapse`, not `display: none`**, for `#TabsToolbar`: the same as Firefox's
  `collapsed`, which popups and vertical tabs use, so the tab strip's frames and the tabbrowser's
  layout code behave as in a tested state.
- **Vertical tabs:** only `#vertical-tabs` is hidden; the sidebar launcher's tool buttons are not
  a tab strip and stay (M3 replaces them with the side panel). `@media -moz-pref(...)` as
  `sidebar-main.css` does.
- **List all tabs.** `gTabsPanel.canOpen` is `isElementVisible(#alltabs-button)`, false while the
  strip is hidden, so Firefox hides View > List All Tabs and the ctrl+tab panel's "show all";
  `ctrl+shift+tab` with `browser.ctrlTab.sortByRecentlyUsed` (default `false` in Firefox 157)
  does nothing. Accepted until M2. A user who moves `#alltabs-button` to the nav bar keeps it.
  With default prefs `ctrl+shift+tab` is "previous tab".
- **Zen** (`src/zen/tabs/zen-tabs/vertical-tabs.css`, `zen-browser-ui.css`) replaces the strip:
  it reparents `#TabsToolbar` into its own sidebar, moves the window controls into its sidebar
  top buttons and hides `#alltabs-button` outside customize mode. Nothing to vendor for M0.
- **Fullscreen / kiosk / popups:** the toolbox's fullscreen auto-hide still works on the nav bar
  (`fullscreentoolbar="true"`); with `tabs-hidden` the nav bar shows the window controls in
  fullscreen, as with vertical tabs. Popups and taskbar tabs are Firefox's `isSingleTabWindow`
  (`!window.toolbar.visible`, the root's `popup-window`; `taskbartab`): the CSS and the patch
  leave them alone, so a popup with a second tab shows its strip.
- **`ctrl+1..9` is `alt+1..9` on Linux** (`NUM_SELECT_TAB_MODIFIER` is `alt` under `XP_GNOME`
  in `browser-sets.inc.xhtml`); the test reads the modifier from `#key_selectTab2`.
- **Verified:** red run 13 passed / 21 failed; green 31/0; full suite 151/0. Mutation: making
  `fallbackAnchor()` return `null` while hidden fails "gTabsPanel.canOpen with the strip hidden"
  (reverted). Headless has no CSD, so the window-controls test sets `customtitlebar` itself.
- **Hardening:** the runtime wraps of `TabBarVisibility.update` and
  `gTabsPanel` are gone. A one-hunk patch fails loudly at `surfer import` on a rebase (the
  nightly catches it); a wrap of upstream internals would break silently at runtime. List All
  Tabs while hidden is dropped on purpose. Popups keep Firefox's strip; the host starts
  `TabStrip` after its keys, in a `try`. Red 36 passed / 4 failed (List All Tabs available,
  two-tab popup strip hidden, init error kills the host); green 39/0. Mutation: `vimmaHidden`
  forced `false` fails 11 assertions, including the ctrl+t/ctrl+w ones (reverted).
- **Open for M2:** Vimma's tab keys and the `prefix+g` picker replace "List all tabs". The pref
  has no Settings UI. Hyprland users get no window controls (none needed); check the nav bar's
  drag region on GNOME by hand once.
