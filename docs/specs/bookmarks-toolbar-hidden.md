# Spec: bookmarks-toolbar-hidden

Status: implemented · Area: `src/browser/branding/vimma/pref/firefox-branding.js`,
`packages/vimma-core/src/bookmarks-toolbar.mjs` (new), `config.mjs`, `cmdline.mjs`,
`defaults.mjs`; `src/browser/base/content/vimma/ui/bookmarks-toolbar.mjs` (new),
`config/ConfigHost.sys.mjs`,
`host/VimmaHost.sys.mjs`, `start/start.html` · Upstream patches:
`src/browser/components/places/PlacesUIUtils-sys-mjs.patch` (new, decision 6), with its ADR-003
register line: budget 1 hunk, 4 lines, "`maybeToggleBookmarkToolbarVisibility` returns early while
`browser.toolbars.bookmarks.visibility` is `"never"`, so importing bookmarks into the toolbar
folder does not show the toolbar Vimma hides by default (bookmarks-toolbar-hidden)" · ADR:
[ADR-003](../adr/003-own-files-minimal-patches.md) (register line only)

Issue: [#214](https://github.com/vimma-browser/vimma/issues/214)

Builds on [bookmarks](bookmarks.md), [m5-config-load](m5-config-load.md) and
[start-page](start-page.md); coordinates with [toolbar-toggle](toolbar-toggle.md) and
[firefox-keys](firefox-keys.md). Engine references (`engine/…:line`) are Firefox 158.0 as
imported by `npm run import`; Vimma file references are to `main`.

## Summary

Firefox's Bookmarks Toolbar is hidden by default in Vimma, on the start page and new tabs
included, and stays hidden after a bookmarks import. Vimma's bookmarks panel (`ctrl+b shift+b`)
is the default way to bookmarks. A Vimma user who wants the toolbar turns it on with
`:bookmarkstoolbar show`, Firefox's own View → Toolbars menu, or `[ui] bookmarks_toolbar` in
`config.toml`, and that choice persists. Hiding the toolbar hides a view only; no bookmark data
changes.

## Problem

- With Firefox's default (`"newtab"`), the Bookmarks Toolbar shows on every new tab. Vimma's start
  page is the new-tab page, so a fresh Vimma profile shows the toolbar, with Firefox's empty-state
  text ("For quick access, place your bookmarks here…") and, on a first-run profile, an "Import
  bookmarks…" button, above Vimma's own start page.
- It disappears as soon as a page loads, so the window's layout jumps between the start page and
  every other page.
- Importing bookmarks from another browser forces the toolbar to `"always"`, even over a user's
  explicit "never".
- Vimma already has a keyboard-first bookmarks panel; the toolbar duplicates it with a
  mouse-first view.

## Behaviour

1. **Fresh profile.** As a new Vimma user, I never see Firefox's Bookmarks Toolbar: not on the
   start page, not on a new tab, not in a private window, not after I import bookmarks. The start
   page's key hint names `ctrl+b shift+b` for bookmarks.
2. **Existing profile.** As a Vimma user whose profile showed the toolbar before this change, it is
   hidden after the update, once, and a notice says how to open bookmarks and how to bring the
   toolbar back.
3. **Turning it on.** As a Vimma user who likes the toolbar, `:bookmarkstoolbar show`,
   `ctrl+shift+b`, Firefox's View → Toolbars → Bookmarks Toolbar, or the toolbar context menu
   shows it, and it stays shown
   across restarts. `:bookmarkstoolbar newtab` shows it on new tabs only; `:bookmarkstoolbar hide`
   hides it; bare `:bookmarkstoolbar` toggles between shown and hidden.
4. **Config.** As a Vimma user who keeps settings in a file, `[ui] bookmarks_toolbar = "shown"`
   in `config.toml` shows it in every window from the next start, or from the next reload where
   that line changed, whatever was toggled before.
5. **Data unchanged.** As a Vimma user, the bookmarks in Vimma's per-workspace folders are the same
   whether the toolbar is shown or hidden: the panel, quick add (`ctrl+b a`), import, export, the
   Library and Sync keep working.
6. **Notices.** Each change made through Vimma says `bookmarks toolbar shown`,
   `bookmarks toolbar hidden` or `bookmarks toolbar shown on new tabs` in the polite live region;
   while `config.toml` sets the key, it adds `(config.toml sets "<value>"; until restart)`.

## Research

### Firefox 158.0 (`engine/`)

- **The toolbar** is `<toolbar id="PersonalToolbar">` in `#navigator-toolbox`
  (`browser/base/content/navigator-toolbox.inc.xhtml:546–552`, `customizable="true"`,
  `toolbarname` from `bookmarks-toolbar`). Its empty state is `#personal-toolbar-empty`
  (`navigator-toolbox.inc.xhtml:555–560`), the string `bookmarks-toolbar-empty-message`
  (`browser/locales/en-US/browser/browser.ftl:525`), managed by
  `BookmarkingUI.updateEmptyToolbarMessage()` (`browser/base/content/browser-places.js:1649–1700`).
  On a first-run profile with fewer than 3 bookmarks in the toolbar folder Firefox adds an "Import
  bookmarks…" button to it (`browser/components/places/PlacesBrowserStartup.sys.mjs:330–356` →
  `PlacesUIUtils.maybeAddImportButton`, `PlacesUIUtils.sys.mjs:1613–1644`; skipped under
  `Cu.isInAutomation`).
- **Visibility is one pref**, `browser.toolbars.bookmarks.visibility`, default `"newtab"`
  (`browser/app/profile/firefox.js:3097–3100`: `"newtab"` shows it on the New Tab page,
  `"always"`, `"never"`). Every window reads it through the lazy getter
  `gBookmarksToolbarVisibility` (`browser/base/content/browser.js:572–577`), which has no change
  callback: setting the pref alone does not update open windows.
- **Applying it.** `updateBookmarkToolbarVisibility()` (`browser.js:810–818`) runs at
  `onBeforeInitialXULLayout` (`browser/base/content/browser-init.js:119`) and on every
  non-same-document location change (`browser.js:2341–2344`). It calls
  `window.setToolbarVisibility(toolbar, value, false)` (`browser.js:3054–3144`): for the bookmarks
  toolbar, a string value is written to the pref when `persist` is true (lines 3075–3086), and
  `"newtab"` resolves per window to `BookmarkingUI.isOnNewTabPage(currentURI)` (lines 3097–3117).
  `CustomizableUI.setToolbarVisibility(id, value)`
  (`browser/components/customizableui/CustomizableUI.sys.mjs:5243–5253`) calls it in every
  window, persisting once. That is the call that updates open windows.
- **"New tab page" includes Vimma's start page.** `isOnNewTabPage` (`browser-places.js:1531–1564`)
  matches `AboutNewTab.newTabURL`, `about:home`, `chrome://browser/content/blanktab.html`,
  `about:privatebrowsing` in a private window, and a Smart Window's new tab
  (`AIWindow.isAIWindowNewTabPage`). Vimma's `start/StartPage.sys.mjs:25–34` sets
  `AboutNewTab.newTabURL` to the start page while `vimma.startpage.newtab` is on, so with
  Firefox's default every Vimma user sees the toolbar on the start page and on each new tab.
- **What changes the pref:**
  - **Firefox's menus.** View → Toolbars → Bookmarks Toolbar and the toolbar context menu offer
    always / only on new tab / never (`BookmarkingUI.buildBookmarksToolbarSubmenu`,
    `browser-places.js:1576–1641`) and run `onViewToolbarCommand` (`browser.js:3032–3052`), which
    writes the pref and calls `CustomizableUI.setToolbarVisibility`.
  - **The toggle.** `ctrl+shift+b` (`viewBookmarksToolbarKb`,
    `browser/base/content/browser-sets.inc.xhtml:294–296`, →
    `BookmarkingUI.toggleBookmarksToolbar("shortcut")`, `browser-sets.js:351–353`), the bookmarks
    menu button's item (`BMB_viewBookmarksToolbar`, `navigator-toolbox.js:94–96`) and the app
    menu's bookmarks view (`panelMenu_viewBookmarksToolbar`, `browser-places.js:2115`). The toggle
    (`browser-places.js:1515–1529`) flips between `"always"` and `"never"` only, writes the pref,
    then calls `CustomizableUI.setToolbarVisibility(id, newState, false)`.
  - **Import.** `MigrationUtils.insertManyBookmarksWrapper` inserting into the toolbar folder
    calls `PlacesUIUtils.maybeToggleBookmarkToolbarVisibility(true /* aForceVisible */)`
    (`browser/components/migration/MigrationUtils.sys.mjs:829–833`), which notifies
    `browser-set-toolbar-visibility` (`PlacesUIUtils.sys.mjs:1293–1328`). `CustomizableUI`'s
    observer handles it with `CustomizableUI.setToolbarVisibility(…, true)`
    (`CustomizableUI.sys.mjs:5297–5300`), so the pref becomes `"always"`, even over `"never"`.
    It is the only caller outside tests (grep of `browser/` and `toolkit/`).
  - **The star panel.** Bookmarking a page into a toolbar folder shows the toolbar for the moment,
    without persisting, unless the pref is `"never"`
    (`browser/components/places/content/editBookmark.js:994–1013`,
    `_autoshowBookmarksToolbar`). The star's default folder is the toolbar
    (`browser.bookmarks.defaultLocation`, `firefox.js:1306`).
  - **Customize → Restore Defaults.** `reset()` (`CustomizableUI.sys.mjs:4671–4681`) rebuilds the
    areas with the toolbar area's hard-coded `defaultCollapsed: "newtab"` (lines 436–443, applied
    by `_rebuildRegisteredAreas`, 4786–4810, with persist), so it writes `"newtab"` as a user
    value. The "is in default state" check for this area is `prefHasUserValue` on the pref (lines
    5120–5131), so the Restore Defaults button stays disabled while the pref has no user value,
    whatever the default is.
  - **Profile upgrade.** `ProfileDataUpgrader` (data version < 103,
    `browser/components/ProfileDataUpgrader.sys.mjs:272–296`) moved an old xulstore
    `collapsed=false` to `"always"`. A profile carried over from an old Firefox may hold
    `"always"` from it.
  - **Sync** does not carry it: `firefox.js` has no `services.sync.prefs.sync.browser.toolbars.*`
    line (grep), so only a user who adds that pref syncs it.
- **Related, unchanged here.** `browser.toolbars.bookmarks.showOtherBookmarks` (`firefox.js:3104`)
  only decides whether "Other Bookmarks" sits at the toolbar's end. Firefox's `ctrl+b` is the
  bookmarks sidebar (`viewBookmarksSidebarKb`, `browser-sets.inc.xhtml:291–293`,
  `browser-sets.js:345–347`); in Vimma it is the prefix. Firefox's `ctrl+shift+o` (the Library) is
  already Vimma's `bookmarks_library` (`packages/vimma-core/src/defaults.mjs:129`).

### Vimma on main

- **Bookmarks panel** (`ui/bookmarks-panel.mjs`, spec [bookmarks](bookmarks.md)): `toggle_bookmarks`
  on `ctrl+b shift+b` (`defaults.mjs:147`), `:bookmarks`, quick add `ctrl+b a`. Its default root
  is `"workspace"` (bookmarks decision 11): a folder per workspace at the top of the Bookmarks
  Toolbar folder (`toolbar_____`). The toolbar folder is the store; the toolbar widget is one view
  of it. The bookmarks spec lists "the bookmarks toolbar's visibility" as out of scope
  (`bookmarks.md:149`); this spec is that item.
- **`ctrl+shift+b`.** Since firefox-keys made Firefox's own keys the defaults for every shortcut
  (`docs/specs/firefox-keys.md:232`), `ctrl+shift+b` is the Vimma action
  `toggle_bookmarks_toolbar` (id `browser.bookmarks_toolbar`, `actions.mjs:210`,
  `defaults.mjs:147`), page first, which runs Firefox's `viewBookmarksToolbarKb`
  (`host/browser-ops.mjs:59`). It is named in `ctrl+b ?` and rebindable.
- **Defaults** are Firefox prefs in `src/browser/branding/vimma/pref/firefox-branding.js`, checked
  by `tools/branding/test/branding-prefs.test.mjs` (Vitest). They are defaults, never locked, so
  the user's own value wins.
- **Config.** [toolbar-toggle](toolbar-toggle.md) (implemented) added the `[ui]` table with
  `[ui] toolbar = "shown" | "hidden"` (decision 3, schema 2, `config.mjs:220–224`), held in
  `vimma.ui.toolbar.hidden`, written by `ConfigHost` at startup and on a reload only when that
  value changed; a toggle lasts until the next restart or edit of that line (decision 4). Its
  decision 5 hides `#PersonalToolbar` with `#nav-bar`; its minimal bar never shows the bookmarks
  toolbar (decision 7a), and its full reveal shows `#PersonalToolbar` "as when shown" (decision
  7). [theme-appearance](theme-appearance.md) B4 is the other precedent: without the config key a
  pref stores the runtime choice; with it, config wins.
- **Start page.** The key hint is static markup (`start/start.html:25–31`: `ctrl+b ?` keys, `:`
  commands, `f` hints, and the `:theme` tip that `start.mjs` shows or hides).
- **Precedent.** [m0-tabstrip-hidden](m0-tabstrip-hidden.md) hid Firefox's tab strip by default
  with a pref, CSS and one patch. For the bookmarks toolbar Firefox already has the switch and a
  `"never"` state, so no CSS is needed.
- **e2e** already runs with `browser.toolbars.bookmarks.visibility = "never"`
  (`tools/e2e/launcher.mjs:107`), as Mozilla's web-platform test profile does
  (`engine/testing/profiles/web-platform/user.js:21`). No baseline shows the toolbar.
- **Theme.** Vimma themes its own UI, Firefox's sidebar and the focus colour
  (`ui/theme-host.mjs:26–31`); the nav bar and the bookmarks toolbar follow Firefox's own theme
  (`browser.theme.toolbar-theme`, `theme-host.mjs:13`), so a shown bookmarks toolbar looks like the
  nav bar above it.
- **Control socket.** `vimma-ctl` has no command for prefs or ex commands (`CONTROL_COMMANDS`,
  `packages/vimma-core/src/control.mjs:24`); it reaches `:bookmarkstoolbar` only by `send-keys`,
  which the `agent` role of protocol 2 cannot use ([vimma-mcp](vimma-mcp.md)).

## Design

`ui/bookmarks-toolbar.mjs` owns the feature in the chrome: it applies a value to every window,
runs the one-time migration and knows what config.toml sets. Core adds the config key, the
command, the words, the notices and the migration rule (`bookmarks-toolbar.mjs`). The host runs
the action and posts the notices. The branding file adds the default; one patch stops the
import's forced reveal.

### Decisions

1. **Hidden by default: `"never"`.** `firefox-branding.js` gains
   `pref("browser.toolbars.bookmarks.visibility", "never");`, a default, not locked. A fresh
   profile never shows the toolbar, on the start page included. Firefox's menus, the context menu
   and the toggle keep working and still write the pref, so a choice persists across restarts as
   in Firefox. No CSS and no DOM change: `"never"` is a state Firefox ships and tests. It also
   turns off the star panel's momentary autoshow (`editBookmark.js:994–1003`). Rejected: CSS
   `visibility: collapse` as for the tab strip, because it would fight Firefox's own menus instead
   of using them.
2. **The bookmarks panel is the default way in.** The start page's hint line gains
   `<kbd>ctrl+b shift+b</kbd> bookmarks`, static like the other items in it. No first-run notice
   for a fresh profile: it has never seen the toolbar. Firefox's empty-state text and "Import
   bookmarks…" button are left as they are: they live inside the hidden toolbar and show only to a
   user who turns it on. Rejected: rendering the hint from the keymap for this one item, because
   the rest of the line is static and a keymap-driven hint is a change for the whole line.
3. **Config: `[ui] bookmarks_toolbar = "hidden" | "shown" | "newtab"`.** In the `[ui]` table of
   toolbar-toggle (schema 2), with its words: `"hidden"` is `"never"`, `"shown"` is `"always"`,
   `"newtab"` is Firefox's "only on new tab" (Vimma's start page, a new tab, a private window's
   `about:privatebrowsing`). Anything else is an error with the closest value, and the last good
   config stays; Firefox's own words `"always"` and `"never"` suggest `"shown"` and `"hidden"`.
   The words are toolbar-toggle's, so one `[ui]` table reads the same for both toolbars; the
   resolved config keeps the word (`ui.bookmarksToolbar`, null when unset) and core's
   `visibilityFor` maps it to Firefox's value. It is not written in `defaults.toml` (a comment
   only), as `[theme] appearance`: left out, the setting is the pref of decision 1, so a choice
   made in Firefox's menus is not overridden by a default line. `"newtab"` is offered because it
   is Firefox's own third state, already in its View menu: without it `:bookmarkstoolbar` and
   `[ui]` could not express what the menu can, and it shows the toolbar only on Vimma's start
   page, the one place a row of shortcuts helps.
4. **Config wins, at the moments config applies.**
   - Without the key, the pref is the setting. Firefox's menus, `:bookmarkstoolbar` and the toggle
     change it for good.
   - With the key, `ConfigHost` applies it at every start and on a reload where that line changed
     from the last good config. A runtime change works and lasts until the next start or edit of
     that line, as toolbar-toggle's `ctrl+b u` does; the notice says so (Behaviour 6).
   - Applying always goes through `CustomizableUI.setToolbarVisibility("PersonalToolbar", value)`,
     never the pref alone, because the pref has no change callback in open windows (Research).
5. **The action keeps Firefox's key; a command sets a state.** `toggle_bookmarks_toolbar` (id
   `browser.bookmarks_toolbar`) on `ctrl+shift+b`, page first, as firefox-keys gives every
   Firefox key with a named Vimma equivalent (Research): Firefox's muscle memory stays, and the
   key is named in `ctrl+b ?` and rebindable. It runs exactly Firefox's `viewBookmarksToolbarKb`
   (`BookmarkingUI.toggleBookmarksToolbar("shortcut")`), as firefox-keys decision 4 has every
   Firefox-derived action run what Firefox's key ran, so it flips between `"always"` and
   `"never"`; the host adds the notice (Behaviour 6). `:bookmarkstoolbar` runs the same action;
   `:bookmarkstoolbar show|hide|newtab` sets a known state (Tab completes the three words; an
   unknown word is refused with the closest), so a user or a `:` binding can reach a state
   without knowing the current one, as `:toolbar show|hide` does.
6. **Import does not show it while it is `"never"`.** A one-hunk patch to
   `PlacesUIUtils.maybeToggleBookmarkToolbarVisibility` (`PlacesUIUtils.sys.mjs:1293`) returns
   early when `browser.toolbars.bookmarks.visibility` is `"never"`, the rule `editBookmark.js`
   already applies to its own autoshow. Imported bookmarks still land in the toolbar folder; only
   the forced reveal and its write of `"always"` are skipped. With `"newtab"` or `"always"` the
   import behaves as in Firefox. A patch, not a runtime wrap of the method or a second observer of
   `browser-set-toolbar-visibility`: a one-hunk patch fails loudly when `npm run import` applies it
   on a rebase (and in the Beta canary's patch dry-run, [upstream-beta-canary](upstream-beta-canary.md)
   B4), a wrap of upstream internals breaks silently at runtime, and the order of observers of
   one topic is not a contract. This is the reasoning m0-tabstrip-hidden applied to its patch.
   ADR-003 gains the register line in the header. Rejected: leaving the import as in Firefox,
   because the first import would override the hidden default to `"always"`; and undoing it
   afterwards from an observer, because that relies on observer order and flashes the toolbar.
7. **Existing profiles: hidden once on upgrade.** At the first start with this change, when
   `[ui] bookmarks_toolbar` is not set and the pref has a user value other than `"never"`
   (`"always"` from an import or an old Firefox profile, `"newtab"` from Restore Defaults), Vimma
   sets `"never"` once and says, in the polite region, "bookmarks toolbar hidden: ctrl+b shift+b
   opens your bookmarks; :bookmarkstoolbar show brings it back". The bool pref
   `vimma.ui.bookmarksToolbar.migrated` records it, so it never runs again and a later choice
   stands. A profile with no user value needs nothing: decision 1's default hides it. With the
   config key set, the key decides and the migration only records itself. One bool pref and one
   test cover profiles that an earlier import or Restore Defaults left showing the toolbar, so
   the default means the same in every profile; a later choice stands because the pref is set
   whether or not anything was hidden.
8. **With toolbar-toggle.** When the nav bar is hidden (`ctrl+b u`, `[ui] toolbar = "hidden"`), the
   bookmarks toolbar is hidden with it (toolbar-toggle decision 5), whatever this setting says; the
   minimal URL bar never shows it (7a); the full reveal on hover or for an add-on popup shows it
   only when this setting would (shown, or newtab on a new tab). The two settings stay
   independent: neither writes the other's pref, because each is its own config key and command
   and a user can want either without the other. This spec, built second, adds the combined
   mochitest (Tests, mochitest 10).
9. **Private workspace.** The pref is per profile, so private windows follow it. With `"newtab"`,
   a private window's `about:privatebrowsing` counts as a new tab (Firefox's rule). A private
   window's bookmarks panel shows the toolbar folder (bookmarks decision 11); nothing else
   changes.
10. **Theme and keyboard when shown.** Unchanged from Firefox, because theming the toolbar is out
    of scope and Firefox's own navigation already reaches it: the toolbar takes the nav bar's look
    (Research → Theme); keyboard reach is Firefox's toolbar navigation (its `toolbartabstop`,
    `navigator-toolbox.inc.xhtml:553`, and arrow keys within, `browser.toolbars.keyboard_navigation`,
    `firefox.js:3094`). Vimma's panel stays the keyboard way to bookmarks.
11. **Customize → Restore Defaults writes Firefox's `"newtab"`.** Accepted, not patched: it is an
    explicit "Firefox's defaults" action, rare, and the next start's config (when set) corrects it.
    The guide says so. Because Firefox 158 checks this area's default state with
    `prefHasUserValue` (Research), a fresh Vimma profile's Restore Defaults button stays disabled
    with the branding default, so no patch of `defaultCollapsed` is needed.

### Not in scope

- Theming the bookmarks toolbar (or the nav bar) with Vimma's tokens.
- Changing where Firefox's star files bookmarks (the toolbar root, outside the workspace folders);
  Vimma's `ctrl+b a` files into the workspace's folder.
- Firefox's bookmarks sidebar and the Library.
- `browser.toolbars.bookmarks.showOtherBookmarks`.
- A per-window or per-workspace toolbar state.

## Security and privacy

No new surface. The change adds a default pref, a config key, an action and an ex command that
change a view of data Vimma already shows; it reads or sends nothing. The patch only skips a
reveal and a pref write, so it narrows Firefox's behaviour. The command is reachable from the
control socket only through `send-keys`, which the `agent` role cannot use, so a confined agent
cannot change the browser-wide pref.

## Tests

Written first and seen to fail (red, then green, per CONTRIBUTING.md).

- **Vitest**
  - `tools/branding/test/branding-prefs.test.mjs`: given the branding pref file, then
    `browser.toolbars.bookmarks.visibility` is `"never"` and not locked.
  - `config.test.mjs` / `config-v2.test.mjs`: given `schema = 2` and
    `[ui] bookmarks_toolbar = "shown"`, then it parses to `"shown"` (and `"hidden"`,
    `"newtab"` to themselves); given `"always"` (Firefox's word), then an error suggesting
    `"shown"`; given `[ui]` in a schema-1 file, then the "new in schema 2" error; given no key,
    then the parsed config has none (the pref decides); given an unknown `[ui]` key, then an error
    with the closest name.
  - `bookmarks-toolbar.test.mjs`: each word maps to Firefox's value and back; the three notices
    and their "until restart" suffix; the migration runs only for an unmigrated profile with a
    user value other than `"never"` and no config key.
  - `cmdline.test.mjs`: `:bookmarkstoolbar` → `browser.bookmarks_toolbar`, with the word as its
    text; `show`, `hide`, `newtab` parse to the setting; Tab completes the three; Tab after
    `:bookmarkstoolbar sho` gives `show`; `:bookmarkstoolbar blue` is refused with the closest.
  - `defaults.test.mjs`: the `defaults.toml` snapshot gains the commented
    `[ui] bookmarks_toolbar` line (regenerated by `npm run gen-docs`, not hand-edited). No
    binding changes, so `help.test.mjs.snap` does not.
- **Mochitest `tests/browser/browser_vimma_bookmarks_toolbar.js`**
  1. Fresh profile: given default prefs and no user value, when a window opens on the start page,
     then `#PersonalToolbar` is collapsed; when a new tab opens, then still collapsed; in a private
     window on `about:privatebrowsing`, collapsed.
  2. Start page hint: given the start page, then its hint line has `ctrl+b shift+b` and
     "bookmarks".
  3. Existing profile, shown: given the user value `"always"` and
     `vimma.ui.bookmarksToolbar.migrated` unset, when the host starts, then the pref is `"never"`,
     every window's toolbar is collapsed, the notice says `bookmarks toolbar hidden: …`, and the
     migrated pref is `true`; when the pref is then set to `"always"` and the host runs its startup
     path again, then it stays `"always"` with no notice. The same for a user value `"newtab"`.
  4. Existing profile with config: given `"always"` and `[ui] bookmarks_toolbar = "shown"`, then no
     migration notice and the toolbar shows.
  5. Import: given `"never"`, when `MigrationUtils.insertManyBookmarksWrapper` inserts 5 bookmarks
     into the toolbar folder, then they are in Places, the pref is still `"never"` and the toolbar
     is collapsed; given `"newtab"`, then the import shows the toolbar as in Firefox (`"always"`).
  6. Star panel: given `"never"`, when a page is bookmarked into the toolbar folder through the
     star panel, then the toolbar does not show.
     (Mochitest 7 also checks `ctrl+shift+b`: Firefox's toggle in every window, with a notice.)
  7. Action and command: `:bookmarkstoolbar` shows it in two windows at once and the pref is
     `"always"`; again hides it; `:bookmarkstoolbar newtab` shows it on a new tab and not on a
     loaded page; each notice reaches the polite region.
  8. Config wins: given `[ui] bookmarks_toolbar = "shown"` written after start, when the reload
     reads it, then it shows in every open window (not only after a location change); when
     `:bookmarkstoolbar hide`, then hidden and the notice says "until restart"; when the config is
     reloaded unchanged, then still hidden; when the line changes to `"hidden"` and back to
     `"shown"`, then shown.
  9. Firefox's own controls: View → Toolbars' "Always show" item (`onViewToolbarCommand`) shows
     it and writes `"always"`, with no Vimma interference.
  10. With toolbar-toggle: given `"shown"` and the nav bar hidden, then `#PersonalToolbar` is
      collapsed and the minimal URL bar does not show it; on the full reveal it shows, and with
      `"never"` it does not.
  11. Workspace folders: `browser_vimma_bookmarks.js` and `browser_vimma_bookmarks_workspaces.js`
      run on the hidden default unchanged: `ctrl+b shift+b` lists the workspace's folder and
      `ctrl+b a` files into it.
- **e2e:** no existing baseline changes from the hidden toolbar: the e2e profile already sets
  `"never"` (`tools/e2e/launcher.mjs:107`). That line stays, so the e2e profile does not depend on
  the branding default. A baseline that shows the start page's hint line changes with decision 2
  and gets its changelog line. The start page and the shown toolbar are screenshot-verified under
  Xvfb with the built-in and an Omarchy theme before merge.
- **Mutation check:** without the patch's early return, mochitest 5 fails (`"always"`); without
  the migrated pref, mochitest 3 fails (startup recorded nothing).

## Docs and changelog

- **`docs/guide.md`:** the Bookmarks section gains "Firefox's Bookmarks Toolbar": hidden by
  default; your bookmarks are in the panel (`ctrl+b shift+b`) and in the toolbar folder either
  way; `:bookmarkstoolbar [show|hide|newtab]`; `[ui] bookmarks_toolbar`; View → Toolbars still
  works; config wins at start; Restore Defaults brings back Firefox's `"newtab"`. The start page
  section mentions the new hint; the `config.toml` reference gains the key.
- **`docs/bindings.md`**, `docs/bindings.json`, `defaults.toml`: `npm run gen-docs`.
- **README:** no feature-list change (the bookmarks panel is already listed).
- **`CHANGELOG.md` `[Unreleased]`** (added by the maintainer at merge time). Suggested: "Changed:
  Firefox's Bookmarks Toolbar is hidden by default, also on the start page and after an import;
  `ctrl+b shift+b` opens your bookmarks, and `:bookmarkstoolbar show` or `[ui] bookmarks_toolbar`
  brings the toolbar back." `ctrl+shift+b` already shows or hides it, from firefox-keys.
- **`docs/adr/003-own-files-minimal-patches.md`:** the register line in the header.

## Delivery

1. **`feat(bookmarks): firefox's bookmarks toolbar hidden by default`**: decisions 1–11: the
   branding default, `[ui] bookmarks_toolbar`, `:bookmarkstoolbar`, the notice on
   `ctrl+shift+b`, `ui/bookmarks-toolbar.mjs` (apply, migrate once), the `PlacesUIUtils` patch
   and its ADR-003 line, the start page's hint, mochitest 10 with toolbar-toggle, gen-docs and the
   guide. No binding changes: `ctrl+shift+b` became `toggle_bookmarks_toolbar` with firefox-keys,
   which delivered the default key this spec first planned as a second pull request.
