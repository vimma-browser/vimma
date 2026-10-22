# Spec: toolbar-toggle

Status: implemented · Area: `packages/vimma-core/src/actions.mjs`, `defaults.mjs`,
`config.mjs`, `cmdline.mjs`, `statusbar.mjs`, `prompt-keys.mjs` (new); `ui/toolbar.mjs` (new),
`ui/statusbar.mjs`, `ui/theme-host.mjs`, `host/VimmaHost.sys.mjs`, `host/addon-ops.mjs`,
`host/prompt-keys.mjs` (new), `config/ConfigHost.sys.mjs`,
`browser/themes/shared/vimma/toolbar.css` (new), `firefox-toolbar.css` (new) · Upstream patches:
none · ADR: none

Issue: [#216](https://github.com/vimma-browser/vimma/issues/216)

Builds on [m0-tabstrip-hidden](m0-tabstrip-hidden.md), the status bar of
[m2-statusbar-whichkey](m2-statusbar-whichkey.md) and the config of
[m5-config-load](m5-config-load.md). Firefox facts were checked against the Firefox 158.0 engine
tree (`engine/`) unless a line says otherwise.

## Summary

`ctrl+b u` hides Firefox's navigation toolbar (the URL bar and the add-on buttons) in every
window, so the window is the page and Vimma's status bar. Focusing the address bar shows a minimal
bar with only the URL field. A permission prompt or the site's identity panel shows the prompt bar
(the whole address bar, with the site's identity and the prompt's icon), and the full toolbar
comes back while an add-on popup or a panel hanging from a toolbar button is open. The status bar
takes over the security and private-browsing cues the hidden bar carried. Shown or hidden, the
toolbar, the URL field and its suggestions and the panels hanging from the bar take Vimma's theme,
and a permission prompt answers `y` and `n`. Separately, the account panel loses Firefox's "Get
Vimma for Android or iOS" row, which advertises an app that does not exist.

## Problem

- Vimma already hides the tab strip and shows the page's URL in its status bar. The navigation
  toolbar is the last row of Firefox chrome above the page, and a keyboard user rarely needs its
  buttons: back, forward and reload have keys, add-ons have the `ctrl+b e` picker.
- Firefox has no way to hide it. `#nav-bar` has no `toolbarname`, so no menu offers to collapse
  it, and collapsing it naively breaks typing an address, permission prompts (they would open
  unanchored at the window's top-left) and add-on popups.
- The account button's panel offers "Get Vimma for Android or iOS": Firefox's mobile promo with
  Vimma's brand name substituted. There is no Vimma mobile app.

## Behaviour

1. `ctrl+b u` hides the toolbar in every window. `ctrl+b u` again brings it back. The notice says
   "toolbar hidden" or "toolbar shown", and a screen reader hears it.
2. With the toolbar hidden, `I`, `ctrl+l`, `alt+d`, `F6`, `t`, `ctrl+t`, `ctrl+b c`, a new pane and
   the start page all still give a focused address bar. A minimal bar appears over the top of the
   page: only the URL field, with the typed text and Firefox's suggestions below it. No site
   identity or permission icons (the status bar names the site), no back, forward or reload, no
   add-on buttons, no bookmarks toolbar, no window controls. The page does not move.
3. `Enter` in the minimal bar loads the page, focuses it and hides the bar. `Esc` gives up and
   hides it too.
4. `ctrl+b u` brings the whole toolbar back, for its buttons and the window controls. The pointer
   at the window's top edge does not reveal it.
5. `[ui] toolbar = "hidden"` in `config.toml` starts every window with the toolbar hidden.
6. `:toolbar` toggles it, and `:toolbar show` / `:toolbar hide` set it, so `vimma-ctl` scripts can
   set a known state.
7. `ctrl+b e` → `Enter` on an add-on still opens its popup under its button. The whole toolbar
   shows while the popup is open.
8. A permission prompt (camera, location, notifications) while the toolbar is hidden shows the
   prompt bar: the whole address bar, without the toolbar's buttons. The prompt points at the
   address bar's icon, next to the site's identity, exactly as with the toolbar shown. It never
   appears unattributed in a corner.
9. With the toolbar hidden, the status bar says `not secure` for a page not served over a secure
   connection, and `private` in a private window.
10. The account panel has no "Get Vimma for Android or iOS" row, whether the toolbar is shown or
    hidden. Sign-in, Sync and devices stay.
11. A permission prompt answers the keyboard, with the toolbar shown or hidden. Once it has shown
    for Firefox's security delay with no key in between, `y` runs its main button (Allow) and `n`
    its secondary one (Block). `Tab` moves focus onto its buttons with a visible focus ring, where
    `Enter` and `Space` run the focused button and the arrow keys move between them. `Esc` stays
    Firefox's. A line in the prompt names the keys once it is armed. Keys typed in a field never
    answer it.
12. The navigation toolbar, the minimal and prompt bars, the URL field, its suggestions, the site's
    identity and the panels hanging from the bar (permission prompts, the identity panel, the
    frame of an add-on's popup, the extensions menu) follow Vimma's theme, dark or light, from the
    built-in palette or an Omarchy theme, including one that gives only its base colours.

Out of scope: hiding the status bar; a per-window or per-workspace toolbar state; a floating,
centred URL bar (Zen's `floating-on-type`) or a minimal bar at the bottom; a minimal bar shorter
than the URL field; moving the tab strip pref into `[ui]`; changing `Esc` in the URL bar while the
toolbar is shown; the rest of Firefox's panels (a separate Firefox panels audit in plan.md); the
content of an add-on's popup, which is the add-on's own page; menus (context menus, the menu bar).

## Research

### Vimma today

- **The tab strip** is hidden by `ui/tabstrip.mjs` and `tabstrip.css`. The pref
  `vimma.ui.tabstrip.hidden` is observed live in every window and sets the root attribute
  `vimma-tabstrip-hidden`. The CSS gives `#TabsToolbar` `visibility: collapse`, as Firefox's own
  `collapsed` does. It excludes `[customizing]`, `[popup-window]` and `[taskbartab]`.
  `tab-bar-visibility-js.patch` makes `TabBarVisibility.update()` treat the strip as hidden.
  The nav bar then gets the `browser-titlebar` class, and with a custom (CSD) titlebar it holds
  the window controls and the drag area.
- **Toggles:** `ctrl+b b` (`sidebar.toggle`, `:sidebar`) and `ctrl+b z` are per window or per
  workspace. The panel's open state is not persisted. Zoom rides in the workspace snapshot. No
  chrome visibility setting is in `config.toml` yet. Its top-level tables (`config.mjs`
  `TOP_KEYS`) are `schema`, `keys`, `modal`, `unbind`, `workspaces`, `theme`, `panes`, `sites`,
  `routes`, `firefox`, `bookmarks`, `private` and `mcp`. Newer keys are gated on `schema = 2`, as
  `[bookmarks]` was.
- **Free prefix keys** (`defaults.mjs` `keys`, `docs/bindings.md`):
  - Bound: `? c n p 1–9 T X v - h j k l H J K L z x r enter space ) ( ctrl+6 w N W D P A g b B a [ e`.
    `P` is the private workspace and `A` the agent workspace ([vimma-mcp](vimma-mcp.md)).
  - `T` is `rename_tab`, so the suggested `ctrl+b T` is taken.
  - `t` is free, but two mochitest files use it as the "unbound by default" key
    (`browser_vimma_config.js:124` and on, `browser_vimma_config_first_run.js:108`), and so does the guide's `config.toml` example
    (`new_tab = ["prefix+t"]`).
  - `u` is free. tmux does not bind it, and the only test use is a typo key (`new_tabb = "prefix+u"`)
    that does not depend on `u` being unbound.
  - A second key after the prefix never reaches Firefox, so it cannot clash with Firefox's own
    chords.
- **URL bar paths:**
  - `I`, `ctrl+l` and `alt+d` run `focus_urlbar` (`urlbar.focus`; `ctrl+l` and `alt+d` are
    Vimma bindings since [firefox-keys](firefox-keys.md)). It runs `Browser:OpenLocation`
    (`host/VimmaHost.sys.mjs`, `focusUrlbar`), which calls `gURLBar.select()` and opens the
    results.
  - `tab.new` runs `BrowserCommands.openTab` (the start page, URL bar focused).
  - A split runs `gURLBar.select()` (`host/pane-ops.mjs`).
  - All of these go through `UrlbarInputBase.focus()` / `select()`. `F6` is expected to as well; the mochitest
    checks it rather than assuming.
- **Status bar** (core `statusbar.mjs`): the `url` segment shows `displayUrl(url)`, which drops
  `http://` and `https://` alike. It has priority 8, so it is the first segment dropped, and it is
  left out when the title is the URL. No segment shows security or private browsing.
- **Add-on popups** (`addon-ops.mjs` `openAddonPopup`): `gUnifiedExtensions.browserActionFor(policy)
.triggerAction(win)`. A pinned button anchors its popup to itself. A button in the extensions
  menu opens that menu first, and the popup anchors to `#unified-extensions-button`. Both are in
  `#nav-bar`.
- **Notices** go to a persistent polite live region (m7-a11y decision 3). The status bar is
  `aria-live=off`.

### Firefox (engine/, Firefox 158.0)

- **Structure** (`navigator-toolbox.inc.xhtml`): `#navigator-toolbox` holds `#toolbar-menubar`,
  `#TabsToolbar`, `#nav-bar`, `#PersonalToolbar` and `#notifications-toolbar`. The last one
  holds the global notification bars (`gNotificationBox`, `browser.js:419`) and the per-tab
  notification deck. With the tab strip hidden, the private-browsing indicator and the titlebar
  buttons are those in `#nav-bar` (lines 541–543).
- **Collapsing a toolbar:**
  - `window.setToolbarVisibility` / `CustomizableUI.setToolbarVisibility` toggles `collapsed`,
    persists it in xulstore and fires `toolbarvisibilitychange`.
  - `#nav-bar` has no `toolbarname`, so Firefox offers no menu item to collapse it.
  - `browser-addons.js` `onToolbarVisibilityChange` moves extension buttons off a collapsed
    toolbar into the extensions menu, and anchors their popups to `#unified-extensions-button`.
    That button is itself in `#nav-bar`.
- **F11 fullscreen** (`browser-fullScreenAndPointerLock.js`) is the closest prior art for "hidden
  until needed":
  - `hideNavToolbox` uses a negative `margin-top`, not collapse, so the content moves up.
  - The `gURLBar` getter (`browser.js:378–415`) listens for `beforefocus` / `beforeselect` on
    `#urlbar` and calls `FullScreen.showNavToolbox()` before focus lands. `UrlbarInputBase.focus()`
    and `select()` dispatch these events (`UrlbarInputBase.mjs:854–890`), and they can be
    cancelled.
  - It keeps the toolbox shown while a chrome popup is open (`_setPopupOpen`, on document
    `popupshown` / `popuphidden`).
  - It refuses to hide while a chrome `<input>` is focused.
  - `Esc` and `F6` are handled by `_keyToggleCallback`.
  - A 1 px `#fullscr-toggler` at the top shows the toolbox on hover.
- **DOM fullscreen** collapses `#navigator-toolbox`. Unless the site may stay fullscreen, it
  removes pending permission prompts on entry, and a permission prompt that shows later exits
  DOM fullscreen (`_handlePermPromptShow`).
- **Doorhangers** (`PopupNotifications.sys.mjs`, set up in `browser.js:440–506`):
  1. `getVisibleAnchorElement` (`browser.js:469`) first dispatches the bubbling event `PopupNotificationsBeforeAnchor`
     on the anchor (line 474). Firefox's own `browser-addons.js` (line 2388) uses it to unhide the auto-hidden
     extensions button before a prompt anchors to it.
  2. It then checks `checkVisibility({ visibilityProperty: true })`, which fails for
     `visibility: collapse` and for no frame, and passes for zero size or opacity 0.
  3. Its fallbacks (`#trust-icon-container`, `#identity-icon`, …) are all in `#nav-bar`.
  4. `_showPanel` then falls back to `gBrowser.selectedTab`. That is hidden too in Vimma (the tab
     strip), so it falls back to null, which shows the prompt at the window's top-left with no
     anchor ("entirely chromeless environment").
  5. `shouldSuppress` already hides doorhangers while the URL bar is focused and edited.
  6. `UpdatePopupNotificationsVisibility()` re-evaluates anchors. The URL bar calls it on focus
     and blur.
- **Arrow panels follow their anchor:** `nsMenuPopupFrame::CheckForAnchorChange`
  (`layout/xul/nsMenuPopupFrame.cpp:2453`) runs every
  refresh tick and hides a popup whose anchor lost its frame or became invisible. Hiding the bar
  under an open doorhanger therefore closes it. A non-persistent prompt then counts as dismissed.
  Opening a panel on a frameless anchor positions it against the whole window. A null anchor
  puts it at the top-left.
- **Panels with no fallback** (they need the bar shown before they open):
  - the identity panel (`gIdentityHandler._openPopup`, `browser-siteIdentity.js:1294`);
  - the permission panel and the protections panel;
  - the app menu (`PanelUI`);
  - `PanelUI.showSubView`'s widget panel, which hosts browserAction popups;
  - the extensions menu.

  PanelMultiView and `ViewPopup.attach` pass the anchor through unchecked. `ext-browserAction.js`
  `openPopup` / `triggerAction` never check the button's visibility.

- **What `#nav-bar` holds** (`navigator-toolbox.inc.xhtml` 109–544):
  - outside the customizable target: the taskbar-tab favicon, titlebar spacers, the overflow
    button, `#PanelUI-button` (app menu), the private-browsing indicator and the titlebar
    buttons;
  - in `#nav-bar-customization-target`: back, forward, stop/reload, `#urlbar-container`,
    downloads, `#unified-extensions-button`, and whatever the user customised in;
  - inside `#urlbar` (and so inside `#urlbar-container`): `#identity-box` (lock, "not secure",
    site name), `#trust-icon-container`, `#notification-popup-box` (every permission prompt's
    anchor icon, `#geo-notification-icon` and the rest), the blocked-permission icons and
    `#page-action-buttons` (star, reader view).
- **The URL field's layout in this engine:**
  - `#urlbar-container` is `flex: 400 0 auto` (`urlbar.css:734`) with a
    `--urlbar-container-min-width` of 140–310 px (`urlbar.css` 14–89).
  - There is no `breakout-extend` any more (Zen still has it). The results view is a top-layer
    popover (`popover="manual"`), placed with CSS anchor positioning (`position-anchor:
--urlbar-anchor; position-area: block-end center`, `urlbar.css` 600–603), so it always
    opens below the field, with no flip.
  - `UrlbarInputBase` allows the popover only when the field is inside a toolbar
    (`#popoverAllowed = … !!this.closest("toolbar")`, `UrlbarInputBase.mjs:583–590`). Moving
    `#urlbar` out of
    `#nav-bar` would leave it without a suggestions view.
- **Overflow:** `OverflowableToolbar` (`CustomizableUI.sys.mjs` 7621 on) re-measures the nav bar
  only on window `resize` (`#onResize`, 8493), summing children's `getBoundingClientRect` widths
  and skipping `display: none` and positioned ones (`#getOverflowInfo`, 8135 on). Items hidden
  with `visibility: hidden` keep their box, so the measurement does not change. Collapsed or
  `display: none` items would let a resize pull overflowed buttons back, and those would then
  overflow the bar when it is shown in full again.
- **The toolbox's stacking and clip:** `#navigator-toolbox` has `overflow: clip` and
  `z-index: var(--browser-area-z-index-toolbox)` (0), below the tabbox's
  `--browser-area-z-index-tabbox` (2) (`browser-shared.css` 113–120). A bar drawn outside the
  toolbox's own box is therefore clipped, and the page is above it for painting and for the
  mouse. Firefox's level for a toolbox floating over the content is
  `--browser-area-z-index-toolbox-while-animating` (4).
- **A collapsed nav bar measures no width:** with `visibility: collapse` on `#nav-bar`, its
  `getBoundingClientRect().width` is 1 px and its customization target's 0 (measured in a
  mochitest on 158.0), so a window `resize` while hidden makes `OverflowableToolbar` move items
  (the flexible spaces among them) into the overflow menu.
- **The site identity button:** with `browser.urlbar.trustPanel.featureGate` on (158's default),
  a web page's identity button is `#trust-icon-container` and its panel `#trustpanel-popup`
  (`browser-trustPanel.js`); `#identity-icon-box` shows only for internal and add-on pages.
- **`Esc` in the URL bar** (`UrlbarChildController.mjs` 435–465): with the results closed and
  the address not edited (`pageproxystate` valid, or an empty field on a blank page), Firefox
  focuses the selected browser, as `browser.urlbar.focusContentDocumentOnEsc` (default true)
  asks.
- **`F6`** moves focus between the page and the chrome through the focus manager
  (`EventStateManager.cpp` 4036), which skips an element that cannot take focus and fires no
  `beforefocus`.
- **Popup windows** (`window.open` with `chromehidden`) keep `#nav-bar` with a read-only URL bar,
  for anti-spoofing (`browser-init.js:342–349`). Extension popup windows and chromeless windows
  hide `#nav-bar` with `display: none` (`browser-shared.css:505–506`), and their prompts
  open at the top-left. Prior art, not a model.

- **Account panel:** the account button opens `PanelUI-fxa`. Its row
  `PanelUI-fxa-menu-get-firefox-mobile` (`browser/base/content/appmenu-viewcache.inc.xhtml:739`)
  carries the label `fxa-menu-get-firefox-mobile` = "Get { -brand-product-name } for Android or
  iOS" (`browser/locales/en-US/browser/appmenu.ftl:181–182`). `browser-sync.js` shows the row and
  handles its click (lines 1816 and 1921; `openGetFirefoxMobile` at 3837). With Vimma's branding
  the label reads "Get Vimma for Android or iOS".

- **The trust panel's anchor:** `gTrustPanelHandler.showPopup` anchors to the first of
  `#trust-icon-container` and `#identity-icon-box` that passes `checkVisibility`, and opens with
  no anchor when neither does (`browser-trustPanel.js` 351–383, 585–593). With the toolbar hidden
  the site's identity panel therefore opens from a visible identity button only.

### Firefox's prompts and the keyboard (engine/, Firefox 158.0)

- `#notification-popup`, the panel every doorhanger shows in, has `noautofocus="true"`
  (`browser/base/content/popup-notifications.inc.xhtml` 7–14). A prompt takes focus only when its
  options ask for `autofocus` (`PopupNotifications.sys.mjs` 531, 707–711); permission prompts do
  not, so they need a click.
- `Esc` with focus in the page or in the prompt runs the prompt's `escAction`, the secondary
  button unless the prompt names the main one (`PopupNotifications.sys.mjs` 294–330, 679–686;
  `PermissionUI.sys.mjs` 2374 sets the secondary one).
- A click on the main or secondary button goes through `_onButtonEvent`, which ignores it while
  the window is inactive or before `security.notification_enable_delay` (500 ms by default) has
  passed since the prompt showed, unless the action opts out (`PopupNotifications.sys.mjs`
  1966–2075).
- The buttons are `moz-button`s in a `moz-button-group`: the secondary one first (a split button),
  then the main one (`type="primary"`). With focus on one, the arrow keys move between them
  (`toolkit/content/widgets/popupnotification.js` 100–105, 245–290). The prompt carries its
  labels in the `buttonlabel` and `secondarybuttonlabel` attributes.

### Firefox's toolbar colours (engine/, Firefox 158.0)

- The bar, its buttons and the URL field take their colours from tokens: `--toolbar-*`,
  `--toolbarbutton-*` and `--toolbox-*` (`toolkit/themes/shared/design-system/dist/tokens-shared.css`
  512–563), `--urlbar-*` (`browser/themes/shared/urlbar/urlbar.tokens.css`) and `--urlbarview-*`
  for the suggestions (`urlbarview.tokens.css`). The URL field's background is `.urlbar-background`
  and the suggestions' `.urlbarView-background`, both from `--urlbar-background-color(-focus)`
  (`urlbar.css` 323–345, 619–630).
- Arrow panels paint `--panel-background-color`, `--panel-text-color` and `--panel-border-color`
  (`toolkit/themes/shared/popup.css` 13–80). Their buttons are `moz-button`s, coloured by the
  `--button-*` tokens.
- A Firefox theme sets these tokens inline on the root (`LightweightThemeConsumer`), and
  `:root[lwtheme]` sets the suggestions' selected row again (`urlbar/view-proton.css` 71–75).
- A `.browser-toolbar` that is also `.browser-titlebar` has a transparent background
  (`browser-shared.css` 375–386): with the tab strip hidden the nav bar is the titlebar and shows
  the toolbox's colour.

### Zen's compact mode

Read from an installed Zen's `omni.ja` (`zen-components/ZenCompactMode.mjs`,
`zen-styles/zen-compact-mode.css`, `zen-omnibox.css`). The Zen version was not recorded when it
was read; the findings are prior art, and nothing in the design depends on Zen's code.

- **Hiding:** the mode is `zen-compact-mode="true"` on `:root`. The navbar wrapper is clipped to
  a few pixels of height (`overflow: clip`) and given `opacity: 0`. It is never collapsed, so the
  URL bar stays focusable and anchors stay measurable.
- **Revealing:**
  - The wrapper gets `zen-compact-mode-active` while it matches
    `:where([panelopen], [open], #urlbar:focus-within, [breakout-extend])`. Zen watches this with
    a MutationObserver polyfill for `:has`.
  - `has-popup-menu` is set from document `popupshowing` / `popuphidden` when the trigger is
    inside the bar.
  - `zen-has-hover` is set on hover, and when the pointer crosses the top window edge, with a
    1000 ms hide delay (`zen.view.compact.toolbar-hide-after-hover.duration`).
- **Content:** a negative `margin-top` on `.browserContainer` lets the revealed bar cover the
  page instead of pushing it down.
- **Doorhangers:** no special handling. They are covered only because anchors in the URL bar get
  `[open]`, and an opacity-0 bar passes `checkVisibility`. While it is still hidden, a prompt
  anchors to an invisible icon.
- **Floating URL bar** (`zen-omnibox.css` 482–520, `zen.urlbar.behavior = "floating-on-type"`):
  on typing, `#urlbar[open][zen-floating-urlbar]` is positioned in place (`left: 50%`, a fixed
  width, `z-index: 1000`) without moving it in the DOM. Zen still has `breakout-extend`; this
  engine has the popover view instead, so Zen's styling does not carry over, but its principle
  does: restyle the field where it lives, never re-parent it.
- **Other:** `Esc` blurs the floating URL bar to the page. The toggle is `Accel+S`. In DOM
  fullscreen the wrapper is collapsed.

## Design

Numbered decisions, each with its reason and the alternatives rejected.

1. **Key: `ctrl+b u`** (`prefix+u`, mnemonic "URL bar"). It runs `toggle_toolbar`
   (`toolbar.toggle`, "Show / hide the toolbar (URL bar and add-on buttons)") in the "Navigation"
   group, next to `toggle_sidebar`.
   - `T` is `rename_tab`.
   - `t` is free but is the tests' and the guide's stand-in for an unbound key. Taking it would
     mean editing two test files and the guide's example. That is not loosening a test, but it
     is churn for a mnemonic.
   - `u` is free, unused by tmux, and nothing depends on it being unbound.
   - Also added: `show_toolbar` (`toolbar.show`) and `hide_toolbar` (`toolbar.hide`), unbound.
2. **`:toolbar [show|hide]`.** Without an argument it is `toolbar.toggle`. With one it is
   `toolbar.show` or `toolbar.hide`.
   - Tab completes `show` and `hide`. These are core-supplied fixed names, as for `:layout`.
   - An unknown word is refused with the closest name.
   - `:sidebar` / `:bookmarks` are the model, plus arguments so `vimma-ctl` can set a known state
     rather than flip an unknown one.
3. **Config: `[ui] toolbar = "shown" | "hidden"`.** This is a new top-level table, gated on
   `schema = 2` like `[bookmarks]`. The default is `"shown"`.
   - Anything else is an error with the closest value, and the last good config stays.
   - `[ui]` is the home for later chrome-visibility settings; the tab strip pref could move there.
   - Default shown: a new user gets Firefox's familiar address bar. Hiding is opt-in, because it
     moves security information into the status bar (decision 12).
4. **One state for all windows, held in a pref.**
   - `vimma.ui.toolbar.hidden` (bool, default `false`) is observed live in every window, as the
     tab strip pref is.
   - The toggle, `:toolbar` and `vimma-ctl` write it.
   - `ConfigHost` writes it from `[ui] toolbar` at startup, and on a reload only when that value
     changed from the last good config. A toggle therefore lasts until the next restart or the
     next edit of that line, as a tmux `set` lasts until `.tmux.conf` is sourced.
   - A restart starts from the config. That is the safe direction: a broken or missing config
     means `"shown"`.
   - Not per window: it is a look you choose for the browser, as Zen's compact mode is. A
     per-window toggle would make new windows guess.
5. **What hides:**
   - **Hidden:** `#nav-bar`, and `#PersonalToolbar` (the bookmarks toolbar would otherwise float
     alone at the top).
   - **Untouched:**
     - `#notifications-toolbar`: notification bars ("this site was prevented from opening a
       popup", crash and update bars) stay where they are and move to the top edge.
     - The menu bar: `alt` does not show it ([firefox-keys](firefox-keys.md) turns the `alt` tap off); `F10` does.
     - The tab strip, which keeps its own pref.
   - **Excluded:** like `tabstrip.css`, the rules do not apply to:
     - customize mode (`[customizing]`);
     - popup windows (`[popup-window]`): their read-only URL bar is anti-spoofing and must stay;
     - taskbar tabs (`[taskbartab]`);
     - F11 fullscreen (`[inFullscreen]`) and DOM fullscreen (`[inDOMFullscreen]`). Firefox's own
       toolbox handling owns those, with its own reveal on hover, `F6` and URL bar focus.
6. **Hidden means hidden, out of the flow.**
   - `ui/toolbar.mjs` sets the root attribute `vimma-toolbar-hidden` from the pref. While it is
     set, `toolbar.css` takes `#nav-bar` and `#PersonalToolbar` out of the flow (absolutely
     positioned at their own place, the bookmarks toolbar anchored below the nav bar) and gives
     them `visibility: hidden`.
   - A hidden bar:
     - takes no space and is not painted;
     - is out of the tab order and the accessibility tree;
     - honestly fails `checkVisibility`, so nothing anchors to an invisible icon;
     - keeps its full width, so the overflow measurement sees the bar as it is when shown.
   - Not `visibility: collapse`, the tab strip's mechanism: a collapsed nav bar measures no width
     (Research → A collapsed nav bar), and a resize while hidden would move buttons into the
     overflow menu.
   - Not Zen's opacity and clip: Zen's bar stays "visible" to Firefox while invisible to the user.
     A prompt could then point at a hidden icon, and a screen reader could still browse into the
     bar.
   - The toolbox becomes the bar's containing block, unclipped and at Firefox's level for a
     toolbox over the content (Research → The toolbox's stacking and clip), so the revealed bar
     is painted above the page and takes the mouse.
   - The cost: focus and anchoring need the bar shown first. Decisions 7 and 8 do that before
     either happens, synchronously.
7. **Reveal, as an overlay, in three sizes.**
   - While any reason in the window's reveal set holds, the root gets `vimma-toolbar-revealed`
     and the bar shows. Each reason asks for one of three sizes, and the largest asked for wins,
     so that each moment shows no more chrome than it needs:
     - **minimal** (root attribute `vimma-toolbar-minimal` as well): only the URL field
       (decision 7a below), to type an address;
     - **prompt** (`vimma-toolbar-minimal` and `vimma-toolbar-prompt`): the whole address bar,
       with the site's identity and the prompts' icons, without the toolbar's buttons (decision
       7b), for a prompt or a panel hanging from those icons;
     - **full**: `#nav-bar` and `#PersonalToolbar` as they are when shown.
   - Either size shows over the top of the content area, as Zen and the F11 toolbox do. Pages are
     not resized: no reflow, no `resize` event in the page, no jump. Zen's negative `margin-top`
     on the content is the reference technique. The mochitest's "page height unchanged" check
     (Tests) is the contract, not the technique.
   - Reasons, and the size each asks for:
     - **a. URL bar → minimal:** `beforefocus` / `beforeselect` on `#urlbar`, the same hook
       Firefox uses for F11. This adds the reason synchronously, before `focus()` runs, so focus
       lands on a laid-out field. Every path in Research → URL bar paths, and the start page, goes
       through it, with nothing to list or keep in sync. The reason holds while `#urlbar` has
       focus (`gURLBar.focused`) or its results view is open.
     - **b. Focus inside the bar → the size that shows it:** `focusin` on `#nav-bar`. The URL
       field and its suggestions ask for minimal, the rest of `#urlbar` (the identity and the
       prompts' icons) for prompt, the toolbar's buttons for full, so that focus never sits on a
       hidden element.
     - **c. Doorhangers → minimal or full by anchor:** `PopupNotificationsBeforeAnchor` bubbling
       up to `#nav-bar` adds the reason before `getVisibleAnchorElement` checks the anchor (the
       pattern Firefox uses for its own extensions button). An anchor inside `#urlbar` asks for
       prompt: every permission prompt (`#notification-popup-box`'s icons) and `#identity-icon`.
       Any other anchor asks for full: `#unified-extensions-button` for add-on install and
       permission prompts, `#PanelUI-menu-button` for the app menu's update doorhangers. The
       reason holds until `PopupNotifications.panel` fires `popuphidden`.
     - **d. Panels anchored in the bar → minimal or full by anchor:** a capture-phase
       `popupshowing` whose `anchorNode` or `triggerNode` is inside `#nav-bar` adds the reason,
       held until that popup's `popuphidden`, as F11's `_setPopupOpen` does. Inside `#urlbar`
       (the identity, permission and protections panels, page actions) asks for prompt; inside
       the URL field or its suggestions (a suggestion's menu) for minimal.
       Elsewhere asks for full: downloads, the extensions menu, the app menu, browserAction
       popups (including an add-on's own `_execute_action` shortcut). `popupshowing` fires before
       the popup is positioned; the mochitest proves the popup lands under its button, and the
       picker path (decision 10) reveals before opening in any case.
     - **e. None for hover:** the pointer reveals nothing (decision 9).
     - **f. Add-on picker → full:** see decision 10.
     - **g. `F6` → minimal:** a `keydown` of `F6` or `shift+F6` while the URL bar is not focused
       reveals the minimal bar before the focus manager looks for the URL bar (Research →
       `F6`), as F11's `_keyToggleCallback` does. It holds until focus next moves, or 1 s.
     - **h. A mouse button held on the bar → its size:** a press on the revealed bar holds the
       size it shows until the button is up. A press on the site's identity or a prompt's icon
       takes focus from the field or closes the prompt hanging from it before the click lands,
       so without this the bar would hide under the pointer; the panel the click opens then
       holds the bar (reason d).
   - A switch from minimal to a larger size while the field is focused (an add-on's shortcut
     while typing, say) keeps focus, the typed text and the open suggestions: the URL field's
     box does not move (decision 7a).
   - On every change to the set or the size, the host calls
     `UpdatePopupNotificationsVisibility()`, so doorhanger anchors are re-evaluated.

7a. **The minimal bar.**

- **What shows:** the URL field itself (`.urlbar-input-box`): the typed text and Firefox's
  suggestions view below it. While a search engine is chosen for the typed text
  (`#urlbar[searchmode]`), its button and the search mode indicator show too, because they are
  part of what is typed.
- **What does not:**
  - inside `#urlbar`: the identity box, the trust, tracking-protection and remote-control icons,
    the permission icons, page actions, the revert and go buttons, and the search engine button
    outside search mode;
  - `#PersonalToolbar`, and every other item of `#nav-bar` and its customization target: back,
    forward, stop/reload, home, downloads, `#unified-extensions-button`, the overflow button,
    `#PanelUI-button`, anything the user customised in, the private-browsing indicator, the
    titlebar buttons and spacers.
- **Why only the field:** the minimal bar is for typing an address. While the toolbar is hidden
  the status bar already shows the page's address with its registrable domain, `not secure`,
  `private` and the devices in use (decision 12, `docs/security.md` C3), so the identity chrome
  around the field would repeat it. A prompt or a panel hanging from those icons asks for the
  prompt bar (7b), where they show.
- **How:**
  - The items of `#nav-bar` outside `#urlbar-container` get `visibility: hidden`, not collapse
    or `display: none`: they keep their boxes, so `#urlbar-container` sits exactly where it sits
    in the full toolbar and at the same width, the urlbar's width-dependent layout
    (`--urlbar-container-min-width`) is untouched, and `OverflowableToolbar`'s measurement
    (Research → Overflow) stays the same, so a reveal never pulls a button out of the overflow
    menu or pushes one in.
  - Inside the field (`#urlbar > .urlbar-input-container`), the items other than the input box
    get `display: none`, so the text starts at the field's edge instead of after an empty gap
    where the icons were. The field's own box keeps its place and width.
  - Hidden items are not painted, cannot take focus, are out of the accessibility tree and fail
    `checkVisibility({ visibilityProperty: true })`. Nothing anchors to them while the bar is
    minimal: a reason that needs one asks for a larger size first (7c, 7d).
  - No CustomizableUI call and no DOM move. `#urlbar` stays inside `#nav-bar`, which its
    suggestions popover needs (`#popoverAllowed` needs `closest("toolbar")`).
  - **Rejected:**
    - Moving or re-parenting `#urlbar` into a bar of our own. It would lose the popover view and
      the anchors' place, and break the assumptions of every Firefox urlbar test.
    - Collapsing the other items of `#nav-bar` so the field takes the whole width. The field
      would jump on a switch to full, and the overflow measurement would drift (see Research).
    - `visibility: hidden` inside the field too: the empty gap where the icons were reads as a
      broken bar.
- **Look:** the nav bar's own height, in the theme's colours (decision 21). It spans the window's
  full width, as the toolbar does.
  - Not the status bar's height: shrinking the field would shrink the prompt bar's identity and
    permission icons, which are the prompts' anchors and the site's attribution.
- **Place: the top**, where the URL bar always is. Not at the bottom by the status bar, like the
  `:` command line:
  - **Anti-spoofing:** the site's identity and the address are where Firefox users expect them.
    Firefox's own permission prompts hang down from their icon. A page cannot draw over the chrome
    above the content area.
  - **Suggestions:** the view opens downward (`position-area: block-end`) with no fallback, so a
    bar at the bottom would push its suggestions off the window.
  - **One bar:** the prompt bar and the full toolbar appear in the same place, so the sizes are
    one bar.

7b. **The prompt bar.**

- **What shows:** the whole `#urlbar`, as with the toolbar shown: the site's identity
  (`#trust-icon-container`, `#identity-box`), the prompts' icons in `#notification-popup-box`,
  the address and page actions. Not the toolbar's buttons, which stay as in the minimal bar.
- **When:** a doorhanger or a panel anchored inside `#urlbar` outside the field (reasons c, d),
  focus on one of those icons (b), and a press on the bar while it shows (h).
- **Why:** a prompt must hang from its icon next to the site's identity and address, as in
  Firefox (decision 11, `docs/security.md` C3), so the bar shows that attribution exactly while a
  prompt or the identity panel is up.
- **Rejected:** the full toolbar for prompts, because a prompt needs none of its buttons and a
  larger reveal is a larger target for a page that times one (Security and privacy).

8. **Hide.** When the last reason ends, the overlay goes. There is no timer.
   - **After `Enter`:** Firefox focuses the loading page on `Enter` (`UrlbarInputBase #loadURL`;
     the browser is focused parent-side). The URL bar's blur then ends reason (a), at the moment
     the load starts.
   - **No "hide on load commit" rule:** a focused URL bar is never hidden. Hiding it would leave
     focus inside a hidden element.
   - **`Esc`:**
     - Firefox's own `Esc` runs: it closes the results, then reverts typed text.
     - An `Esc` with nothing left to do (results closed, value not edited, `pageproxystate`
       valid) focuses the selected browser: Firefox does this itself (Research → `Esc` in the URL
       bar), so Vimma adds no `Esc` handling.
     - Reason (a) then ends, and the bar hides.
     - With the toolbar shown, `Esc` behaves exactly as in Firefox; this spec changes nothing
       there.
   - **Never under an open panel:** an open doorhanger or panel anchored in the bar keeps it
     shown at the size it asked for (decision 7c/d). When a larger reason ends while a smaller
     one still holds, the bar shrinks to that size, not to hidden. The bar is never hidden under an open arrow panel, so
     `CheckForAnchorChange` never closes or dismisses a prompt because of us.
9. **No hover reveal.** The pointer at the window's top edge reveals nothing, because a bar that
   appears under the pointer covers the page's top strip at moments the user did not choose: on
   a tiling window manager (Omarchy) the window's top edge is crossed whenever the pointer moves
   to the window above, and a click meant for the page then lands on the bar.
   - The minimal and prompt bars show for typing and prompts, the full toolbar for add-on popups
     and panels from its buttons (decisions 7, 10). `ctrl+b u` or `:toolbar show` brings the
     whole toolbar back for its buttons and the window controls (decision 17), and `ctrl+b u`
     hides it again.
   - Rejected: a 2 px strip at the top edge with a 150 ms delay, as F11's `#fullscr-toggler`
     (it still shows the bar whenever the pointer crosses the window's top edge, the case
     above); hover behind a pref (no pref is added before there is a use for it).
10. **Add-on popups show the full toolbar.**
    - `openAddonPopup` adds a full-size "popup" reason before `triggerAction`, held until the popup or the
      extensions menu closes.
    - The popup therefore opens under its own button, or in the extensions menu, as with the
      toolbar shown, and the user sees which add-on it is.
    - The minimal bar would not do: those anchors are outside `#urlbar`.
    - No fallback anchor is invented. Firefox's extension popups are built to hang from their
      button.
    - Decision 7d covers the paths Vimma does not run (an add-on's own shortcut,
      `browserAction.openPopup()`).
11. **Permission prompts and security.**
    - Decision 7c is the security decision. A prompt always shows anchored to its icon in the URL
      bar, with the identity box (lock, site) beside it and the page's address in the field. That
      is exactly the attribution Firefox gives with the toolbar shown.
    - The prompt bar is enough: every permission prompt's anchor and the identity box are inside
      `#urlbar`.
    - Without it, Vimma's hidden tab strip would send the prompt to the top-left with no anchor.
    - Nothing is suppressed or delayed by us. Firefox's `security.notification_enable_delay` and
      its `shouldSuppress` (URL bar focused and edited) still apply.
    - DOM fullscreen keeps Firefox's rules (decision 5): a permission prompt exits it.
      11a. **Permission prompts from the keyboard.** Firefox's prompts take no focus by themselves
      and need a click (Research → Firefox's prompts and the keyboard), so a keyboard user cannot
      answer one. Vimma answers them as it answers its own agent question line
      ([vimma-mcp](vimma-mcp.md) decision 13), with the toolbar shown or hidden:
    - **`y`** clicks the prompt's main button, **`n`** its secondary one. Only lower-case
      letters count, so that the shifted keys stay free for bindings. A prompt without a secondary
      button ignores `n`.
    - **Armed first.** A key counts only once the prompt has shown for
      `security.notification_enable_delay` (Firefox's own delay for these buttons) with no key in
      the window in between; any key restarts the delay, and `y` or `n` before it is swallowed.
      A page that raises a prompt while the user is typing for the page therefore never gets an
      answer from that typing. Firefox's own check in `_onButtonEvent` still applies on top.
      (Since changed: the delay counts from Firefox's `notification.timeShown`, which Firefox
      restarts when the panel moves or resizes or the window is activated, and the keys line
      keeps its place while hidden so that showing it does not resize the panel; see
      `host/prompt-keys.mjs` and docs/security.md.)
    - **Never from a field.** In insert mode (focus in a page's or the chrome's text field) the
      keys are the field's.
      (Since changed: a prompt Firefox opens with focus on its own panel, the add-on install
      prompt with ExtensionsUI's `autofocus`, takes the keys from there, because no field has
      focus then and the keys were otherwise lost; see `host/prompt-keys.mjs`. The fields inside
      a prompt, the password prompt's username and password, are fields too: their keys are
      theirs, because a username with a `y` in it could not be typed otherwise; issue #423.)
      (Since changed: nor while one of Vimma's own surfaces holds the keyboard. The permission
      prompt keys, the agent question and the update question stand back for one shared list of
      them (`vimmaSurfaceOpen` in `host/VimmaHost.sys.mjs`), so that a surface added later
      reaches all three; live grep and a search being typed were missing from the prompt keys'
      list, and `y` typed into live grep allowed the prompt; issue #485.)
    - **`Tab`** (focus in the page, not in a field) moves focus onto the prompt's first button,
      the secondary one, with Vimma's focus ring (`--vimma-focus`, focus.css). From there
      Firefox's own keys work: the arrow keys move between the buttons, `Enter` and `Space` run
      the focused one. The secondary button comes first, so `Tab` then `Enter` never allows.
    - **`Esc`** is Firefox's: it runs the prompt's `escAction` (the secondary button for
      permission prompts).
    - **A keys line** in the prompt, built from its own button labels (`y allow · n block · Tab
buttons`), shows once the prompt is armed and hides while it is not, as the agent line's
      hint does. It is `aria-hidden`, because the buttons are the accessible controls.
      (Since changed: with focus in a field outside the prompt, the line starts with
      `Esc, then`, because a login form that keeps the page leaves focus in its password field,
      where `y` and `n` are text, and `Esc` leaves the field with the prompt still open; issue
      #423 and the user guide.)
    - It applies to every prompt in Firefox's doorhanger panel (permissions, add-on installs,
      saving a password), because they share the panel and its buttons; the topmost prompt is the
      one answered, as for Firefox's `Esc`.
    - Rejected: moving focus into the prompt when it opens, because a page can raise prompts at
      will and would take the keys the user is typing (Firefox sets `noautofocus` for the same
      reason); `Enter` as an answer while focus is in the page, because there `Enter` belongs to
      the page (following a focused link).
12. **The status bar carries what the hidden bar did.** Only while the toolbar is hidden:
    - **`not secure`:** a new right-side segment in `--vimma-text-error`, priority 2 (as config
      errors), never dropped before the URL. It shows when the selected browser's
      `securityUI.state` is insecure (an `http:` page), broken (a certificate exception, mixed
      active content), or `gIdentityHandler` would show the "not secure" icon. The host passes a
      `security: "secure" | "insecure" | "neutral"` input:
      - `neutral` is `about:`, `file:`, the start page and similar;
      - `secure` shows nothing, as Firefox's lock is quiet.

      The host reads the level from the browser's own state, as `browser-siteIdentity.js` does:
      the `STATE_IS_SECURE`, `STATE_IS_BROKEN` and `STATE_CERT_USER_OVERRIDDEN` bits of
      `browser.securityUI.state`, a certificate or HTTPS-Only error page (`documentURI`), and
      whether the page is a secure context (http on localhost is). Not from the identity box's
      classes: those would turn the warning off silently if Firefox renamed one, and an unsent
      edit in the hidden address bar (its `pageproxystate` invalid) would clear it.

      Text, not only colour, so it reads without colour vision (m7-a11y).

    - **`private`:** a new segment in a private window, as the toolbar's indicator did, unless
      the workspace segment already says `◆ private` (the private workspace,
      [private-workspace](private-workspace.md)): one word, not two.
    - **The URL is the origin indicator.** With the toolbar hidden, only the status bar says
      which site the page is, so:
      - **The registrable domain is never cut.** The host passes the host and its registrable
        domain (eTLD+1 from `Services.eTLD`, counted in labels and taken from the display form so
        an IDN host keeps its Unicode; an IP address is its own). In a narrow bar the path and
        query go first, then the scheme with the leftmost labels of the host, whole labels at a
        time, as Firefox's address bar keeps the base domain in view
        (`_ensureFormattedHostVisible`). Middle truncation could show
        `accounts.google.com.secure-login…mail.google.com` and hide the real site.
      - **Addresses without a host.** A `blob:` page carries its creator's origin and a
        `view-source:` one its inner URL's; the host takes the origin from those (the inner URI,
        else the page's document principal), since such a URL has no host of its own
        (`nsSimpleURI` throws on `host`). An address with no host at all is cut at its end,
        never in the middle, while the toolbar is hidden.
      - **A title never stands in for the URL.** A page that titles itself with an address does
        not suppress the `url` segment.
      - **Never dropped.** The `url` segment's priority rises from 8 to 4.9, just above the
        title's 5, so the title gives way first (on equal priorities the fitter drops the later
        segment first, and the URL comes after the title). The segment is also kept: it is cut to
        `…<domain>…` while the tab position, workspace and others give way, and takes back the
        room they free. It takes room only from less important segments: the mode's one-column
        short form and the error, `not secure`, `private` and in-use cues (priority 2; `private`
        rises from 3 for this) outrank it, so against them it is cut further, its domain's end as
        the last resort, and the mode's full word gives way before it. An attacker chooses the
        domain's length (up to 63 characters a label), so a long one must not push the cues off.
      - **An about:blank a page controls is named.** Firefox's address bar shows an initial page
        (about:blank, the start page) as empty only when `BrowserUIUtils.checkEmptyPageOrigin`
        passes; otherwise it shows `about:blank`. The status bar does the same, and adds the
        origin of the page that wrote it, from the tab's own document principal (never the
        opener's current one, which may have navigated since): `about:blank from evil.example`. (A page written with
        `document.write` takes its opener's address, which the bar shows as it is.)
    - **What the page uses:** a `using camera, mic` segment (camera, mic, screen, location, XR,
      serial; `paused` where Firefox says so: camera and microphone are
      `nsIMediaManagerService` states, 1 capturing and 2 paused), priority 2, in
      `--vimma-text-error`. Only the selected tab is read: background tabs, the other pane of a
      split and Firefox's grace period after a stream ends are not shown (docs/security.md C3). Firefox
      marks these on the address bar's sharing icons and on the tab; Vimma hides both the tab
      strip and, here, the address bar. Read from the tab's sharing state
      (`browser._sharingState`), as `gPermissionPanel.updateSharingIndicator` reads it. `http://` is no longer dropped by `displayUrl` for an `http:`
      page: the scheme is part of the warning.
    - **Toolbar shown:** the bar is exactly as today, with the same inputs and no new segments.
      This keeps every existing screenshot baseline unchanged.
13. **Never unable to type an address.**
    - Reason (a) reveals before focus.
    - As a safety net, if after the reveal the URL bar still fails `checkVisibility` when a focus
      or select runs, the host:
      - cancels nothing;
      - writes the pref back to shown;
      - says "toolbar shown: the address bar could not be revealed";
      - logs to `about:vimma`'s key log.

      A user is never left with keys that go nowhere. This should never happen, and a test forces
      it.

    - **Prompts too:** if a doorhanger's anchor is still not visible after its reveal (reason
      c), the same happens before Firefox picks a fallback anchor ("toolbar shown: a prompt's
      icon could not be revealed"). With the tab strip hidden, that fallback would be no anchor
      at all, the prompt at the window's top-left.
    - **Customize mode** shows the toolbar (decision 5).
14. **Hiding with focus inside the bar.** `ctrl+b u` (or `:toolbar hide`) while focus is in the
    URL bar or a toolbar button first focuses the selected browser, then hides. Focus never
    stays in a hidden element.
15. **Split panes:** the URL bar is the selected tab's, which is the focused pane's, as today.
    - The overlay, minimal or full, spans the window's width, as the bar does.
    - The focused pane's accent outline says which pane it belongs to.
    - A new pane (`ctrl+b v`, `ctrl+b enter`) focuses the URL bar through `gURLBar.select()`, so
      reason (a) covers it.
16. **The find bar** is per browser, at the bottom of the content. It is unaffected and never
    covered by the overlay.
17. **Window controls (CSD):** hidden with the bar, in the minimal and prompt bars too, and
    shown with the whole toolbar (`ctrl+b u`, decision 9), because they are toolbar items like
    the buttons. The guide says so. On Omarchy, with server-side or no decorations, nothing
    changes.
18. **Accessibility** (m7-a11y):
    - The toggle's notice ("toolbar hidden" / "toolbar shown") is announced through the polite
      live region.
    - A hidden bar is out of the accessibility tree.
    - A reveal for focus is not announced, at any size. The focused URL bar is announced by the screen reader
      as usual.
    - Focus is never lost:
      - decision 14 moves focus out before hiding;
      - reason (a) reveals before focusing;
      - `Esc` returns focus to the page.
    - The status bar segments of decision 12 are text, and are read with "read status bar".
19. **No upstream patch.**
    - Firefox's own events (`beforefocus`, `beforeselect`, `PopupNotificationsBeforeAnchor`,
      `popupshowing`) and its `UpdatePopupNotificationsVisibility()` are enough.
    - The CSS is ours, loaded as an author sheet like `tabstrip.css`.
    - `TabBarVisibility` is not touched. The nav bar keeps its `browser-titlebar` class whether
      hidden or not.

20. **No mobile-app promo in the account panel.** The row
    `PanelUI-fxa-menu-get-firefox-mobile` (Research → Account panel) advertises, under Vimma's
    brand name, a mobile app that does not exist. It is hidden with `display: none` in
    `toolbar.css`, the stylesheet this spec adds for the nav bar and the panels it opens.
    - The rule applies whether the toolbar is shown or hidden.
    - No upstream patch and no string change: hiding the row is enough, and a CSS rule survives
      Firefox's string and markup churn better than a patch to `appmenu-viewcache.inc.xhtml`.
    - The rest of the account panel (sign-in, Sync, devices) stays, because Vimma keeps Sync
      ([m0-mozilla-services](m0-mozilla-services.md)).
    - Other Firefox panels are out of scope; they are the queued Firefox panels audit in
      plan.md.

21. **The toolbar follows the theme.** `firefox-toolbar.css`, loaded by `ui/theme-host.mjs` into
    every window next to the token sheet (as `firefox-sidebar.css` is), points Firefox's own
    colour tokens (Research → Firefox's toolbar colours) at Vimma's, shown or hidden:
    - the bar: `--vimma-bg-dark`, its text and icons `--vimma-fg`, its colour scheme
      `--vimma-color-scheme`: one surface with the status bar and the command line;
    - the URL field and the suggestions: `--vimma-bg`; a selected suggestion `--vimma-selection`
      with `--vimma-fg-bright`, as a selected row in Vimma's lists; secondary text
      `--vimma-fg-dim`; the field's focus ring `--vimma-focus` (focus.css);
    - the boxes inside the field (the site's identity, the search engine) and the buttons' hover:
      the text colour, tinted, as Firefox's own;
    - every arrow panel (`panel[type="arrow"]`: permission prompts, the identity, permission and
      protection panels, add-on popups' frames, the extensions menu, the app menu, downloads):
      `--vimma-bg-dark` bordered `--vimma-muted`, as Vimma's pickers; a main button in the accent
      with its readable text (the normal-mode badge's pair, `--vimma-mode-normal` and
      `--vimma-mode-normal-fg`, whose contrast the theme checks).
    - Why tokens, not restyled elements: Firefox paints the bar, the field, the suggestions and
      the panels from these tokens, so the layout, icons and states stay Firefox's and survive
      its markup changes. `!important`, because a Firefox theme sets the same tokens inline on
      the root.
    - Why every arrow panel and not only the prompts: they all hang from the same bar, and one in
      Firefox's colours under a themed bar is the clash this decision removes. Menus (context
      menus, the menu bar) are not arrow panels and stay out of scope.
    - It follows the token sheet live: a theme change, light or dark, or an Omarchy theme that
      gives only its base colours (core `theme.mjs` derives the surfaces from them) needs nothing
      more. Under `prefers-contrast` and forced colours Firefox's own high-contrast tokens stay
      ([m7-a11y](m7-a11y.md)).
    - Rejected: generating a Firefox theme (an add-on) from the tokens, because it would replace
      the Firefox theme in use and would have to be rewritten and reinstalled on every
      Omarchy theme change, where the token sheet is swapped in place.

## Security and privacy

- **Site attribution.** Hiding the toolbar must not weaken anti-spoofing. Decision 7c reveals the
  minimal bar before any permission prompt anchors, so a prompt always hangs from its icon next
  to the identity box and the page's address, as in stock Firefox. Decision 6 hides the bar
  rather than making it transparent, so nothing anchors to an invisible icon, and decision 13
  brings the toolbar back if a prompt's icon could still not be revealed. Popup windows keep
  their read-only URL bar (decision 5).
- **The status bar is the origin indicator.** While the bar is hidden, nothing else on screen
  says which site the page is: the page reaches the window's top edge, where it can draw a fake
  address bar, so there is no line of death. The status bar therefore always shows the real
  address with its registrable domain whole, never replaced by a title, an opener-controlled
  about:blank by name, `not secure` from the browser's own security state, `private`, and
  the devices the page uses (decision 12). Hiding the toolbar is opt-in for this reason.
- **A page can time a reveal (accepted, low).** A page can make the bar appear at a moment it
  chooses, by asking for a permission (the minimal bar) or starting a download (the downloads
  panel, the full toolbar), so a click meant for the page's top strip can land on the address
  field, an icon or a toolbar button. Doorhanger buttons keep Firefox's
  `security.notification_enable_delay`, and everything else a stray click reaches opens a panel
  or focuses the field, so the risk is accepted. A prompt shows the prompt bar, not the full
  toolbar (decision 7b), and there is no hover reveal (decision 9).
- **Prompt keys.** `y` and `n` count only once the prompt has shown for Firefox's delay with no
  key in between, never from a field, and Firefox's own click delay still applies; the prompt
  never takes focus by itself, and `Tab` puts focus on the secondary button first, so a key
  typed for the page never allows (decision 11a).
- **The minimal bar shows no identity.** While typing, the status bar names the site (decision
  12); every prompt and the identity panel still show the site's identity next to their icon in
  the prompt bar (decisions 7b, 11).
- **Security state.** While the bar is hidden, the status bar shows `not secure`, `private` and
  the devices in use in text (decision 12), so the cues the toolbar carried stay visible.
- **No suppression.** Vimma delays or suppresses no prompt; Firefox's
  `security.notification_enable_delay` and `shouldSuppress` still apply (decision 11).
- **Pages cannot reach it.** All of it is chrome CSS and chrome event listeners; a page sees no
  new API, and the overlay never resizes the content area, so a page cannot detect the toggle
  through `resize` events.
- **No new data.** The state is one boolean pref; nothing is sent anywhere.

## Tests

Write first; paste red, then green (CONTRIBUTING.md, "TDD").

- **Vitest:**
  - `actions.test.mjs` / `defaults.test.mjs`: `toggle_toolbar` on `prefix+u` reaches
    `toolbar.toggle` through the dispatcher; `show_toolbar` / `hide_toolbar` are unbound; no
    default key collides.
  - `config.test.mjs`:
    - `[ui] toolbar` parses `"shown"` and `"hidden"`;
    - a wrong value is an error with the closest value;
    - `[ui]` in a schema-1 file gets the "new in schema 2" error;
    - an unknown `[ui]` key is an error;
    - the default is `"shown"`.
  - `cmdline.test.mjs`: `:toolbar`, `:toolbar show`, `:toolbar hide`, the completion of the two
    words, and an unknown word refused.
  - `prompt-keys.test.mjs` (decision 11a): `y` and `n` answer an armed prompt and are swallowed
    before; a held key never answers; only the lower-case letters count; `Tab` focuses the prompt
    from outside it and is Firefox's inside; `Esc` is Firefox's; keys in a field never answer;
    the keys line names the prompt's buttons.
  - `statusbar.test.mjs`:
    - with the toolbar hidden, `not secure` for `insecure` and none for `secure` and `neutral`;
    - `private` in a private window;
    - the URL's raised priority, so it outlasts the title in a narrow fit;
    - `http://` kept for an `http:` page;
    - with the toolbar shown, segments identical to today's for the same input (a property over
      the existing fixtures).
  - Snapshots:
    - `help.test.mjs.snap` gains three rows;
    - `defaults.test.mjs.snap` gains the key and `[ui]`;
    - `defaults.toml` is regenerated.
- **Mochitest `tests/browser/browser_vimma_toolbar.js`:**
  1. `ctrl+b u` hides `#nav-bar` and `#PersonalToolbar` in two windows. The notice says
     "toolbar hidden", and `#notifications-toolbar` is still shown. Then `ctrl+b u` restores the
     bar.
  2. The minimal bar on focus:
     - for each of `I`, `ctrl+l`, `F6`, `t`, `ctrl+b c` and `ctrl+b v`, the URL bar is focused,
       `checkVisibility()` is true, and the root has `vimma-toolbar-minimal`;
     - only the URL field shows:
       - the input and `#urlbar-container` pass `checkVisibility`;
       - `#identity-box`, `#trust-icon-container`, `#page-action-buttons`, the search engine and
         go buttons, `#back-button`, `#stop-reload-button`, `#unified-extensions-button`,
         `#PanelUI-button`, the titlebar buttons and `#PersonalToolbar` fail it;
     - typing shows in the field (`gURLBar.value`);
     - the suggestions view opens below the field (`:popover-open`, its top at or below the
       field's bottom); `Down` selects a row, and `Enter` on it loads that row's page;
     - `#urlbar-container`'s rectangle is the same as with the full toolbar shown (no jump);
     - the selected browser's height and `innerHeight` are unchanged (overlay, no resize event in
       the page).
  3. `Enter` on a typed address: the page loads, focus is in the page, and the bar is hidden
     again.
  4. `Esc`:
     - after typing, the first `Esc` reverts, as in Firefox, and the bar stays;
     - the next `Esc` focuses the page and the bar hides.
  5. Permission prompt while hidden:
     - a test page requests geolocation;
     - the bar is the prompt bar (`vimma-toolbar-prompt`), not full: no toolbar buttons;
     - the prompt's `anchorNode` is `#geo-notification-icon` (not null, not the tab), and that
       node and `#identity-icon` pass `checkVisibility`;
     - the bar stays revealed while the prompt is open;
     - after "Block", the bar hides;
     - the prompt is never dismissed by the reveal or the hide.
       5a. Prompt keys (decision 11a), with a 400 ms delay: `y` before the prompt is armed answers
       nothing and the keys line is hidden; once armed the line shows; a key typed on disarms it
       again; `n` blocks; `y` and `n` typed in a page field go into the field; `Tab` focuses the
       Block button with a visible ring and `Enter` runs it; `Esc` blocks; `y` allows.
  6. Identity panel while hidden: a mouse click on the site identity button
     (`#trust-icon-container`, or `#identity-icon-box` where the trust panel is off) in a prompt's
     prompt bar opens it anchored there, and the prompt bar stays until it closes.
  7. Add-on popup while hidden:
     - a test extension with a browserAction popup, pinned to the toolbar, then in the extensions
       menu;
     - `ctrl+b e` → `Enter` shows the full toolbar (no `vimma-toolbar-minimal`) and opens the
       popup anchored to its button, then to `#unified-extensions-button`;
     - the full bar stays shown while it is open;
     - `Esc` closes it and the bar hides;
     - also via the add-on's own shortcut, `_execute_action` (`_execute_browser_action` in a
       Manifest V2 add-on) (decision 7d).
  8. Hiding with focus in the URL bar moves focus to the page first (decision 14).
  9. Safety net (decision 13): stub the reveal to fail. Focusing the URL bar writes the pref back
     to shown, the notice says so, and the URL bar is focused.
  10. Exclusions: a `window.open` popup window keeps its URL bar; customize mode shows the bar;
      F11 fullscreen uses Firefox's own toolbox; DOM fullscreen is unaffected.
  11. Status bar:
      - with the bar hidden, an `http:` test page shows `not secure` and an `https:` one does not;
      - a private window shows `private`;
      - with the bar shown, neither appears.
  12. Config: `[ui] toolbar = "hidden"` hides it after the poll. A toggle then lasts until that
      line changes.
  13. a11y: with the bar hidden, the hidden `#urlbar` has no accessible. The notice reaches the
      polite region.
  14. No hover: there is no edge strip, and the pointer at `y = 0` and `y = 1` reveals nothing.
  15. Overflow: with enough buttons customised in to overflow, revealing minimal and then full
      leaves the same items in the overflow menu as before.
  16. Mixed sizes: a minimal reason (URL bar focused) and a full one (downloads panel) together
      show full. Closing the panel leaves the minimal bar, not a hidden one.
  17. Account panel (decision 20): opening `PanelUI-fxa` shows no
      `PanelUI-fxa-menu-get-firefox-mobile` (`checkVisibility()` false), while the sign-in and
      Sync rows still pass `checkVisibility()`; with the toolbar shown and hidden.
- **Mochitest `tests/browser/browser_vimma_toolbar_theme.js`** (decision 21): for the built-in
  palette dark and light and for an Omarchy theme with only base colours, the shown bar, the
  minimal bar, the URL field, a suggestion and the selected one, the site's identity, and a
  permission prompt's panel, border, colour scheme, main button and focus ring have the theme's
  colours.
- **e2e:**
  - The baselines that show the toolbar (`m0-happy-path-help.png`, `m0-mcp-stdio-question.png`, `m0-mcp-stdio-grant.png`,
    `m3-private-workspace.png`, `m4-split-panes.png`) change once, because the toolbar takes the
    theme's colours (decision 21); the status bar in them is unchanged (decision 12).
  - Add a scenario `tests/e2e/scenarios/toolbar-hidden.json`:
    - `ctrl+b u`;
    - a screenshot baseline `tests/e2e/baselines/toolbar-hidden.png`: the page reaching the top
      edge and the status bar below;
    - `I` and a typed address;
    - a second baseline, `tests/e2e/baselines/toolbar-minimal.png`: the minimal bar with the
      typed text (suggestions off in the e2e profile, so the shot is stable);
    - `Enter`.
  - The new baselines need their changelog line (see below).

## Docs and changelog

- **`docs/guide.md`:**
  - a "Hiding the toolbar" section covering:
    - `ctrl+b u`, `:toolbar` and `[ui] toolbar`;
    - the minimal bar on URL bar focus: what it shows and what it does not;
    - the full toolbar for add-on popups and toolbar-button panels, and `ctrl+b u` for the rest;
    - `Esc`;
    - permission prompts showing the prompt bar, and their keys;
    - the toolbar in the theme's colours;
    - the `not secure` and `private` status bar segments;
    - window controls under CSD;
  - the `config.toml` reference gains `[ui]`;
  - the Add-ons "Popups" paragraph notes that the full toolbar shows while a popup is open.
- **`docs/bindings.md`** and `packages/vimma-core/defaults.toml`: `npm run gen-docs`.
- **README feature list:** one line ("hide the toolbar; it comes back when you need the address
  bar").
- **CHANGELOG `[Unreleased]`:** added by the maintainer at merge time, per CONTRIBUTING.md. Suggested
  lines:
  - "Added: `ctrl+b u` and `[ui] toolbar` hide the toolbar; typing an address shows a minimal
    bar with only the URL field, a permission prompt shows the address bar, and the full toolbar
    comes back for add-on popups."
  - "Added: permission prompts answer `y` and `n` once armed, and `Tab` moves onto their
    buttons."
  - "Changed: Firefox's toolbar, URL field, suggestions and the panels hanging from the bar
    follow Vimma's theme; e2e baselines `m0-happy-path-help.png`, `m0-mcp-stdio-question.png`,
    `m0-mcp-stdio-grant.png`,
    `m3-private-workspace.png`, `m4-split-panes.png` and `toolbar-minimal.png` show the themed
    toolbar."
  - "Added: e2e baselines `toolbar-hidden.png` and `toolbar-minimal.png` for the hidden toolbar
    and its minimal URL bar."
  - "Removed: the account panel's "Get Vimma for Android or iOS" row; there is no Vimma mobile
    app."

## Delivery

1. **Account panel row** (decision 20, test 17): adds `toolbar.css` with the rule, loaded by a
   new `ui/toolbar.mjs` as `tabstrip.mjs` loads `tabstrip.css`. No keymap change, so it does not
   wait for the keymap queue.
2. **The toolbar toggle** (decisions 1–19, 21): the action, `:toolbar`, `[ui] toolbar`, the reveal
   logic, the status bar segments, the mochitest and the two e2e baselines. It changes the
   default keymap, so it lands as its own keymap PR, when no other keymap PR is open.

## Open questions

None.
