# Spec: firefox-keys

Status: implemented · Milestone: after M5 (builds on
[key-handling-batch](key-handling-batch.md) § 1, [m0-help-overlay](m0-help-overlay.md),
[m5-config-load](m5-config-load.md) and [m1-cmdline](m1-cmdline.md)) · Area:
`packages/vimma-core/src/firefox-keys.mjs`, `actions.mjs`, `defaults.mjs`, `keymap.mjs`,
`config.mjs`, `cmdline.mjs`, `help.mjs`; `host/firefox-keys.mjs`, `host/browser-ops.mjs` (new),
`host/VimmaHost.sys.mjs`, `ui/help-overlay.mjs`, `about/AboutVimma.sys.mjs`,
`branding/vimma/pref/firefox-branding.js`. No upstream patch.

Issues: [#234](https://github.com/vimma-browser/vimma/issues/234),
[#235](https://github.com/vimma-browser/vimma/issues/235)

Checked against main on 2026-10-13 (after the private workspace #142, the private swap
#151/#160, unsplit #150, bindings.json #154, find #167 and the restore focus fix #168). File:line
references below are to that main.

**This changes the default keymap. It lands as its own keymap PRs, one at a time (no other
keymap PR open at the same time). [toolbar-toggle](toolbar-toggle.md) (spec #136, key `ctrl+b u`)
is specced but not built yet; nothing here binds `ctrl+b u` or any other prefix key, so the two do
not clash and either may land first. Whichever lands second merges main and re-runs the other's
tests.**

## Goal

- Every key that does something, including going back and forward in history, shows up in the
  `ctrl+b ?` overlay.
- Firefox's own shortcuts are off, and every shortcut is configurable through Vimma. Vimma's
  defaults are Firefox's own keys, so a Firefox user keeps every shortcut they know.
- DevTools keys stay exactly as they are in Firefox, and can still be changed in config.toml.

## User stories

- As a user, `ctrl+b ?` answers "how do I go back": `H`, `ctrl+o`, `alt+left` and `ctrl+[` under
  "Go back"; `L`, `ctrl+i`, `alt+right` and `ctrl+]` under "Go forward". Today `alt+left` works
  but no list shows it.
- As a user, every key that does something in the window is in `ctrl+b ?`, `:map` and
  [bindings.md](../bindings.md): Vimma's own keys and the Firefox keys I already know (`ctrl+t`,
  `ctrl+shift+t`, `ctrl+l`, `F5`, `ctrl+plus`, `alt+1..9`, `F12`). No key does
  something the overlay does not list.
- As a user, I can rebind or remove any of them in `[keys]` / `[modal.*]` like any Vimma key:
  `keys.new_tab = ["prefix+c", "t"]` takes `ctrl+t` away from "New tab"; `unbind` removes one.
- As a user who has used Firefox for years, nothing I rely on stops working on the day this
  lands: the common Firefox keys are Vimma's defaults, and they do what Firefox did.
- As a user on Google Docs, Figma or a web terminal, a page that takes `ctrl+f`, `ctrl+s` or
  `ctrl+plus` for itself still gets it, as in Firefox. `ctrl+t`, `ctrl+n`, `ctrl+tab` and the
  `ctrl+b` prefix stay the browser's, as in Firefox and Vimma today.
- As a user typing in a text field or the address bar, `ctrl+t` still opens a tab, and
  `ctrl+z`, `ctrl+shift+z`, `ctrl+c`, `ctrl+v`, `ctrl+a` still edit the text.
- As a user who needs a Firefox feature Vimma has no named action for, `:firefox Tools:Downloads`
  runs it, and `"<C-S-y>" = ":firefox Tools:Downloads"` in `[modal.normal]` binds it.
- As a user who wants a Firefox shortcut back exactly as Firefox runs it, `[firefox] enable =
["ctrl+j"]` gives it back, and `ctrl+b ?` lists it under "Firefox (on in config.toml)".
- As a maintainer, when a Firefox release adds a shortcut, a mochitest fails and names it, so the
  overlay can never silently fall behind the browser.

## Research

### Vimma today (confirmed in the code)

- **`[firefox]`** (key-handling-batch § 1; `core/firefox-keys.mjs`, `host/firefox-keys.mjs`,
  `config.mjs:563` `resolveFirefox`, guide § "Firefox's own shortcuts"). Schema 2. Default
  `disable` is `OVERLAP_CHORDS` (`ctrl+b d e h i k o u w y`, `core/firefox-keys.mjs:18-29`;
  `defaults.mjs:278`), `enable = []`. The host sets `disabled="true"` (and a `vimma-disabled`
  mark) on matching `<key>` elements of **`#mainKeyset` only** (`host/firefox-keys.mjs:15-17`); a
  MutationObserver re-applies when Fluent or Firefox changes a key. `GlobalKeyListener.cpp` reads
  `disabled` at key time (`CanHandle` → `KeyElementIsDisabled`), so a disabled key neither runs nor
  is reserved and the page gets the chord.
- **`disable = "all"`** (`planFirefoxKeys`, `core/firefox-keys.mjs:119-131`): every
  `#mainKeyset` key whose chord has ctrl, alt or meta (`isModified`), except
  `ALL_KEEP = ["ctrl+q"]` (`cmd+q` on macOS) and `internal` keys
  (undo, redo, cut, copy, paste, select all). It leaves: plain keys and function keys without a
  modifier (`F5`, `F11`, `F3`, `shift+F3`, `Esc` stop, `shift+Esc`, `Delete`, `Backspace`) —
  `isModified` ignores shift; keys without a nameable chord yet; and everything outside
  `#mainKeyset`: tabbrowser / tabbox / ctrlTab's keydown handlers (`ctrl+tab`,
  `ctrl+shift+tab`, `ctrl+pageup/down`, `ctrl+shift+pageup/down`, `ctrl+F4`, `F7`), the
  `#devtoolsKeyset`, the menu bar (`alt`, `F10`, `alt+f` …) and content-side quick find (`'`).
  On Linux `alt+1..9` is tab N (`XP_GNOME`, `NUM_SELECT_TAB_MODIFIER alt`); `ctrl+1..9` is not
  bound at all, so "all" does turn off `alt+1..9`.
- **`enable`**: chords that stay Firefox's whatever `disable` says; a Firefox shortcut enabled on a
  text-field key (`ctrl+w`) wins over Vimma's editing key (`FirefoxKeys.fires`,
  `host/firefox-keys.mjs:153`; `_editCommand`, `VimmaHost.sys.mjs:1433-1439`).
  Validation: a chord must have ctrl, alt or meta or be a function key (`isShortcutChord`,
  `core/firefox-keys.mjs:89-91`).
- **Key capture** (`VimmaHost._onKeyDown`, `VimmaHost.sys.mjs:1321-1360`; `_dispatch`,
  `:1369-1425`): one capture-phase `keydown` listener on the window sees every key first
  (`:1000`). A key that completes a runnable binding is consumed (`consume`, `:825-828`:
  `preventDefault` + `stopPropagation`); `preventDefault` from chrome also stops the forward to a
  remote page (`WidgetEvent::PreventDefault` → `StopCrossProcessForwarding`). Unbound keys pass.
  Before any binding, an open picker (goto, workspace, add-on) takes every key (`:1342-1348`),
  and a `/` search takes Enter, Esc and keys typed before its input exists (`:1349-1353`, m1-find).
  Mode (`_mode`, `:1267-1280`): `insert` when focus is in chrome (URL bar, find bar) or a text
  field, `panel` while the side panel or bookmarks panel is open; `[keys]` bindings whose first
  chord has ctrl/alt/meta (or the prefix) are in **every** mode (`compileKeymap`: `global`,
  `keymap.mjs:156-163`); plain `[keys]` bindings are normal-mode only. Today one default `[keys]`
  binding is a bare chord: `ctrl+shift+p` → `private_workspace` (`defaults.mjs:87-89`,
  private-workspace decision 2), which Vimma consumes on keydown, so Firefox's reserved
  `key_privatebrowsing` (`browser-sets.inc.xhtml:350-351`) never runs although `[firefox]` does
  not list it. Every other default `[keys]` binding is `prefix+…`.
- **Page first, already built once:** Vim's editing keys (`ctrl+w/u/h` in insert mode) wait for
  the page: `requestReplyFromRemoteContent()` for a remote page, a system-group bubble listener
  (`_onKeyDownAfter`, `VimmaHost.sys.mjs:1003`, `:1476-1486`; `editAfterPage`, `:785`) for a
  parent-process page, and run only if the page did not `preventDefault` (`_editKey`,
  `:1452-1468`). This spec reuses that path.
- **Actions with arguments**: an action's `arg` is a fixed number per config name
  (`select_tab_1..9` → `tab.goto` arg 1..9, `actions.mjs:63`). Free text reaches an action only
  through the `:` line (`textAction`, `cmdline.mjs:20-21`: `:layout tiled` →
  `pane.select_layout`, `cmdline.mjs:76-77`; `:addon name` → `addons.popup`). Presets are both:
  named actions (`layout_tiled`) for keys, a text action for the line. No binding can carry text
  today.
- **Help**: `bindingTable` (`help.mjs:31-37`) makes one row per `ACTIONS` entry with the keys
  `keymap.keysFor` returns (`keymap.mjs:316`); the overlay, `:map`, `docs/bindings.md` and, since
  #154, `docs/bindings.json` (`bindingsJson`, `help.mjs:76-110`; vimma.dev mirrors it through
  `.github/workflows/site-dispatch.yml`) all render it. `tools/gen-docs.mjs` writes
  `defaults.toml`, bindings.md and bindings.json; `defaults.test.mjs:16-19` fails when the
  committed bindings.json is stale. Firefox's keys are in none of them. Groups today, in order
  (`actions.mjs`): Help, Tabs, Panes, Workspaces (`private_workspace` there), Navigation
  (`history_back`, `history_forward`, `reload`, `focus_urlbar` at `:146-152`), Page, Hints,
  Find, Modes, Copy mode, Side panel, Bookmarks, Config, Add-ons. `restore_tab`
  (`tab.restore`) sits in "Side panel" (`actions.mjs:259`) because its only key is the panel's
  `<C-S-t>` (`defaults.mjs:216-217`; runner `VimmaHost.sys.mjs:595-596`).
- **Config file**: `:config` / first run writes `formatConfigTemplate()` (`defaults.mjs:395-413`),
  every setting commented out (`# disable = [...]` under `[firefox]`, `defaults.mjs:328-332`); an
  existing file is never rewritten (`ConfigHost.sys.mjs:257` `createFromTemplate`).
  `CONFIG_SCHEMA_VERSION = 2` (`config.mjs:80`); `MIGRATIONS` steps 0→1→2 only add keys
  (`config.mjs:86-92`).
- **about:vimma** shows "Firefox shortcuts off" (`about/about.html:61`,
  `AboutVimma.sys.mjs:295`) and the unmatched `disable` chords (`about/about.mjs:263-265`).

### Firefox (engine/, Firefox 157, Linux, en-US)

Where Firefox handles a key, and how Vimma can stop it:

| Source                                                                                                                                                                                 | Handled                                                                                        | How Vimma turns it off                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `#mainKeyset` (`browser/base/content/browser-sets.inc.xhtml`, letters `browserSets.ftl`)                                                                                               | `GlobalKeyListener` on keypress, after the page unless `reserved="true"`                       | `disabled="true"` (today's mechanism)                               |
| `#devtoolsKeyset` (`devtools/startup/DevToolsStartup.sys.mjs` `KeyShortcuts`, inserted before `#mainKeyset` by `hookKeyShortcuts`; letters `key-shortcuts.ftl`)                        | same                                                                                           | `disabled="true"`: watch every `<keyset>` of the window, not one id |
| `#gfxDebugKeyset` (`browser-graphics-utils.js`, only with WebRender capture on), `key_quickRestart` (`browser-development-helpers.js`, dev builds), `key_windowRecordingCmd` (Nightly) | same                                                                                           | same                                                                |
| `Tabbrowser.on_keydown` / `on_keypress`, `tabbox.js`, `browser-ctrlTab.js` (`ShortcutUtils.getSystemActionForEvent`), chrome system group                                              | in chrome before the page; each returns on `defaultPrevented`; `F7` waits for the page's reply | consume the keydown (as Firefox, the page never had these keys)     |
| `MenuBarListener.cpp` (`alt` tap shows the menu bar: `ui.key.menuAccessKeyFocuses` true on GTK; `F10`; menu `accesskey`s `alt+f e v s b t h`)                                          | chrome                                                                                         | pref off for the `alt` tap; menu `accesskey`s and `F10` kept        |
| `FindBarChild.sys.mjs` (`'` and `/` quick find when `accessibility.typeaheadfind.manual`)                                                                                              | in the page process, keypress                                                                  | pref `accessibility.typeaheadfind.manual = false`                   |
| `EventStateManager::PostHandleKeyboardEvent` (`Tab`, `F6`, `ctrl+Tab` fallback; hardware zoom keys)                                                                                    | default action                                                                                 | kept (focus navigation, a11y)                                       |
| `AppCommand` (`HandleAppCommandEvent`, browser.js: hardware Back, Forward, Reload, Search, … and mouse side buttons)                                                                   | chrome                                                                                         | kept (not keyboard shortcuts)                                       |
| Editor / native key bindings (`ShortcutKeyDefinitions.cpp`, GTK key themes): text editing, page scrolling (`space`, `pageup`, arrows)                                                  | default action in the focused field / document                                                 | kept (the field's and the page's own keys)                          |

Reserved keys (`reserved="true"`): `ctrl+n`, `ctrl+t`, `ctrl+w`, `ctrl+shift+w`, `ctrl+shift+p`,
`ctrl+q`, and `F11` while in full screen (`key_exitFullScreen`). Every other key element defaults
to `reserved="pref"`: the page goes first unless the site permission "Override keyboard
shortcuts" (`permissions.default.shortcuts`) blocks it (`nsContentUtils::ShouldBlockReservedKeys`).
With the fullscreen Keyboard Lock API on, reserved keys go to the page too, except
`View:FullScreen` (`GlobalKeyListener::IsReservedKey`). A reserved key whose chord is a native
edit command in a focused editable is not reserved (same function).

`ctrl+q` quits through `goQuitApplication(event)`, which counts it as `"shortcut"` because
`event.ctrlKey` is set; `BrowserGlue` then asks first when `browser.warnOnQuitShortcut` (true on
Linux) is on.

### The inventory

Every key that does something in a Linux browser window today, with its fate:

- **(a)** bound by default to an existing Vimma action;
- **(b)** bound by default to a new named action (Decisions 3–4);
- **(c)** left unbound and off by default: keys that exist only in some builds or settings, and
  the two that clash with Vimma's modal keys (`'`, the `alt` tap); listed in the guide and
  reachable with `:firefox` (Decision 5);
- **(d)** not a window shortcut, or the menu bar's own access keys: stays as it is.

Fates a and b both mean a Vimma binding whose default key is Firefox's own key (Decision 16).

"First" is who gets the key first (Decision 6): **V** Vimma (Firefox reserves the chord, or it is
one of Vimma's keys since key-handling-batch), **P** the page (Firefox lets the page override it).
Modes: **all** is every mode (a `[keys]` binding); **n** normal mode only; **i** insert.

Chords are written as Vimma canonicalises them: `shift` folds into the character, so Firefox's
`accel,shift` + `]` is `ctrl+}` on a US layout and `accel` + `+` is `ctrl+plus`.

**`#mainKeyset` (78 key elements with a chord):**

| Key                        | Firefox id → command                                   | What it does                             | Fate | Vimma action (modes)                                                      | First |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------- | ---- | ------------------------------------------------------------------------- | ----- |
| `ctrl+n`                   | `key_newNavigator` → `cmd_newNavigator`                | new window                               | b    | `new_window` (all)                                                        | V     |
| `ctrl+t`                   | `key_newNavigatorTab` → `cmd_newNavigatorTabNoEvent`   | new tab                                  | a    | `new_tab` (all)                                                           | V     |
| `ctrl+l`                   | `focusURLBar` → `Browser:OpenLocation`                 | focus the address bar                    | a    | `focus_urlbar` (all)                                                      | P     |
| `alt+d`                    | `focusURLBar2` → `Browser:OpenLocation`                | focus the address bar                    | a    | `focus_urlbar` (all)                                                      | P     |
| `ctrl+k`                   | `key_search` → `Tools:Search`                          | web search                               | a    | Vimma's since key-handling-batch: none in normal, readline kill in fields | V     |
| `ctrl+j`                   | `key_search2` → `Tools:Search`                         | web search (Linux's second key)          | b    | `web_search` (all)                                                        | P     |
| `ctrl+shift+y`             | `key_openDownloads` → `Tools:Downloads`                | Library: downloads                       | b    | `downloads` (all)                                                         | P     |
| `ctrl+shift+a`             | `key_openAddons` → `Tools:Addons`                      | about:addons                             | b    | `addons_manager` (all)                                                    | P     |
| `ctrl+o`                   | `openFileKb` → `Browser:OpenFile`                      | open a file                              | a    | `history_back` (n), since key-handling-batch                              | V     |
| `ctrl+s`                   | `key_savePage` → `Browser:SavePage`                    | save page                                | b    | `save_page` (all)                                                         | P     |
| `ctrl+p`                   | `printKb` → `cmd_print`                                | print                                    | b    | `print_page` (all)                                                        | P     |
| `ctrl+w`                   | `key_close` → `cmd_close`                              | close tab                                | a    | pane keys (n) / delete word (i), since key-handling-batch                 | V     |
| `ctrl+shift+w`             | `key_closeWindow` → `cmd_closeWindow`                  | close window                             | b    | `close_window` (all)                                                      | V     |
| `ctrl+m`                   | `key_toggleMute` → `cmd_toggleMute`                    | mute the tab                             | b    | `mute_tab` (all)                                                          | P     |
| `ctrl+z`                   | `key_undo` (internal)                                  | undo in a field                          | d    | the editor's                                                              | —     |
| `ctrl+shift+z`             | `key_redo` (internal)                                  | redo in a field                          | d    | the editor's                                                              | —     |
| `ctrl+x`                   | `key_cut` (internal)                                   | cut                                      | d    | the editor's                                                              | —     |
| `ctrl+c`                   | `key_copy` (internal)                                  | copy                                     | d    | the editor's                                                              | —     |
| `ctrl+v`                   | `key_paste` (internal)                                 | paste                                    | d    | the editor's                                                              | —     |
| `ctrl+a`                   | `key_selectAll` (internal)                             | select all                               | d    | the editor's                                                              | —     |
| `delete`                   | `key_delete` → `cmd_delete` (`reserved="false"`)       | delete in chrome fields                  | d    | the editor's                                                              | —     |
| `backspace`                | → `cmd_handleBackspace`                                | nothing (`browser.backspace_action` = 2) | d    | the editor's                                                              | —     |
| `shift+backspace`          | → `cmd_handleShiftBackspace`                           | nothing (same pref)                      | d    | the editor's                                                              | —     |
| `alt+left`                 | `goBackKb` → `Browser:Back`                            | back                                     | a    | `history_back` (all)                                                      | P     |
| `alt+right`                | `goForwardKb` → `Browser:Forward`                      | forward                                  | a    | `history_forward` (all)                                                   | P     |
| `ctrl+[`                   | `goBackKb2` → `Browser:Back`                           | back (Unix)                              | a    | `history_back` (n); nothing in a text field (Q2)                          | P     |
| `ctrl+]`                   | `goForwardKb2` → `Browser:Forward`                     | forward (Unix)                           | a    | `history_forward` (n)                                                     | P     |
| `alt+home`                 | `goHome` (browser-sets.js)                             | home page                                | b    | `go_home` (all)                                                           | P     |
| `f5`                       | `key_reload2` → `Browser:Reload`                       | reload                                   | a    | `reload` (all)                                                            | P     |
| `ctrl+shift+h`             | `showAllHistoryKb` → `Browser:ShowAllHistory`          | Library: history                         | b    | `history_library` (all)                                                   | P     |
| `ctrl+f5`                  | `key_reload_skip_cache2` → `Browser:ReloadSkipCache`   | reload, bypass cache                     | b    | `reload_hard` (all)                                                       | P     |
| `f11`                      | `key_enterFullScreen` → `View:FullScreen`              | full screen                              | b    | `toggle_fullscreen` (all)                                                 | P     |
| `f11` (in full screen)     | `key_exitFullScreen` (reserved)                        | leave full screen                        | b    | `toggle_fullscreen` (all)                                                 | V     |
| `ctrl+alt+r`               | `key_toggleReaderMode` → `View:ReaderView`             | Reader View (enabled on readable pages)  | b    | `reader_view` (all)                                                       | P     |
| `ctrl+}`                   | `key_togglePictureInPicture` → `View:PictureInPicture` | Picture-in-Picture                       | b    | `picture_in_picture` (all)                                                | P     |
| `ctrl+}` (alt letter)      | unnamed → `View:PictureInPicture`                      | the same on layouts where `}` differs    | b    | `picture_in_picture` (all)                                                | P     |
| `ctrl+r`                   | `key_reload` → `Browser:Reload`                        | reload                                   | a    | `reload` (all)                                                            | P     |
| `ctrl+shift+r`             | `key_reload_skip_cache` → `Browser:ReloadSkipCache`    | reload, bypass cache                     | b    | `reload_hard` (all)                                                       | P     |
| `shift+esc`                | `key_aboutProcesses` → `View:AboutProcesses`           | about:processes                          | b    | `about_processes` (normal)                                                | P     |
| `ctrl+u`                   | `key_viewSource` → `View:PageSource`                   | view source                              | a    | half page up (n) / delete to line start (i); source is `gf`               | V     |
| `ctrl+i`                   | `key_viewInfo` → `View:PageInfo`                       | Page Info                                | a    | `history_forward` (n)                                                     | V     |
| `ctrl+f`                   | `key_find` → `cmd_find`                                | find in page                             | a    | `find_forward` (all)                                                      | P     |
| `ctrl+g`                   | `key_findAgain` → `cmd_findAgain`                      | next match                               | a    | `find_next` (all)                                                         | P     |
| `ctrl+shift+g`             | `key_findPrevious` → `cmd_findPrevious`                | previous match                           | a    | `find_previous` (all)                                                     | P     |
| `f3`                       | `key_findAgain2` → `cmd_findAgain`                     | next match                               | a    | `find_next` (all)                                                         | P     |
| `shift+f3`                 | `key_findPrevious2` → `cmd_findPrevious`               | previous match                           | a    | `find_previous` (all)                                                     | P     |
| `ctrl+d`                   | `addBookmarkAsKb` → `Browser:AddBookmarkAs`            | bookmark the page                        | a    | half page down (n); bookmarking is `ctrl+b a`                             | V     |
| `ctrl+shift+d`             | `bookmarkAllTabsKb`                                    | bookmark all tabs                        | b    | `bookmark_all_tabs` (all)                                                 | P     |
| `ctrl+shift+o`             | `manBookmarkKb` → `Browser:ShowAllBookmarks`           | Library: bookmarks                       | b    | `bookmarks_library` (all)                                                 | P     |
| `ctrl+b`                   | `viewBookmarksSidebarKb`                               | bookmarks sidebar                        | a    | the prefix                                                                | V     |
| `ctrl+shift+b`             | `viewBookmarksToolbarKb`                               | show/hide the bookmarks toolbar          | b    | `toggle_bookmarks_toolbar` (all)                                          | P     |
| `esc`                      | `key_stop` → `Browser:Stop`                            | stop loading                             | b    | `stop_loading` (n)                                                        | P     |
| `ctrl+alt+x`               | `viewGenaiChatSidebarKb`                               | AI chatbot sidebar                       | b    | `ai_chatbot_sidebar` (all)                                                | P     |
| `ctrl+alt+u`               | `viewOpenTabsSidebarKb`                                | open-tabs sidebar                        | b    | `open_tabs_sidebar` (all)                                                 | P     |
| `ctrl+alt+z`               | `toggleSidebarKb`                                      | toggle the sidebar                       | b    | `toggle_firefox_sidebar` (all)                                            | P     |
| `ctrl+h`                   | `key_gotoHistory`                                      | history sidebar                          | a    | backspace in fields (i), since key-handling-batch                         | V     |
| `ctrl+minus`               | `key_fullZoomReduce` → `cmd_fullZoomReduce`            | zoom out                                 | b    | `page_zoom_out` (all)                                                     | P     |
| `ctrl+_`                   | unnamed → `cmd_fullZoomReduce`                         | zoom out                                 | b    | `page_zoom_out` (all)                                                     | P     |
| `ctrl+plus`                | `key_fullZoomEnlarge` → `cmd_fullZoomEnlarge`          | zoom in                                  | b    | `page_zoom_in` (all)                                                      | P     |
| `ctrl+=`                   | unnamed → `cmd_fullZoomEnlarge`                        | zoom in                                  | b    | `page_zoom_in` (all)                                                      | P     |
| `ctrl+0`                   | `key_fullZoomReset` → `cmd_fullZoomReset`              | reset zoom                               | b    | `page_zoom_reset` (all)                                                   | P     |
| `ctrl+shift+tab`           | `key_showAllTabs` (ctrlTab runs it)                    | previous tab                             | a    | `previous_tab` (all)                                                      | V     |
| `ctrl+shift+x`             | `key_switchTextDirection` → `cmd_switchTextDirection`  | flip text direction in a field           | b    | `switch_text_direction` (all)                                             | P     |
| `ctrl+shift+p`             | `key_privatebrowsing` → `Tools:PrivateBrowsing`        | new private window                       | a    | `private_workspace` (all), since private-workspace                        | V     |
| `ctrl+shift+s`             | `key_screenshot` → `Browser:Screenshot`                | screenshot                               | b    | `screenshot` (all)                                                        | P     |
| `ctrl+shift+delete`        | `key_sanitize` → `Tools:Sanitize`                      | clear recent history                     | b    | `clear_history` (all)                                                     | P     |
| `ctrl+q`                   | `key_quitApplication` → `cmd_quitApplication`          | quit (asks first)                        | b    | `quit` (all)                                                              | V     |
| `ctrl+shift+t`             | `key_restoreLastClosedTabOrWindowOrSession`            | reopen closed tab                        | a    | `restore_tab` (all)                                                       | P     |
| `ctrl+shift+n`             | `key_undoCloseWindow` → `History:UndoCloseWindow`      | reopen closed window                     | b    | `restore_window` (all)                                                    | P     |
| `alt+1` … `alt+8` (8 keys) | `key_selectTab1..8`                                    | tab N                                    | a    | `select_tab_1..8` (all)                                                   | P     |
| `alt+9`                    | `key_selectLastTab`                                    | last tab                                 | b    | `select_last_tab` (all)                                                   | P     |

Three zoom keys have an empty letter in en-US (`full-zoom-reduce-shortcut-alt-b`,
`…-enlarge-shortcut-alt2`, `…-reset-shortcut-alt`: `.key = {""}`), and `key_addTabSplitView`,
`key_separateTabSplitView`, `key_duplicateTab` have no letter at all: none is active, so none is
counted. Other locales may fill them; the coverage test (Decision 11) reads the live elements.

**Conditional keys** (only in some builds or settings; all **c**): `ctrl+alt+r`
`key_quickRestart` (developer helpers; it would clash with Reader View), `ctrl+#` and `ctrl+^`
(`#gfxDebugKeyset`, WebRender capture on; `ctrl+^` is Vimma's alternate workspace in normal mode),
`ctrl+$` (`key_windowRecordingCmd`, Nightly).

**`#devtoolsKeyset`** (DevToolsStartup `KeyShortcuts`; `modifiers` = `accel,shift` on Linux):

| Key                | Firefox id                 | What it does                           | Fate | Vimma action                                                           | First |
| ------------------ | -------------------------- | -------------------------------------- | ---- | ---------------------------------------------------------------------- | ----- |
| `ctrl+shift+i`     | `key_toggleToolbox`        | toggle the toolbox                     | b    | `devtools` (all)                                                       | P     |
| `f12`              | `key_toggleToolboxF12`     | toggle the toolbox                     | b    | `devtools` (all)                                                       | P     |
| `ctrl+alt+shift+i` | `key_browserToolbox`       | Browser Toolbox                        | b    | `browser_toolbox` (all)                                                | P     |
| `ctrl+shift+j`     | `key_browserConsole`       | Browser Console                        | b    | `browser_console` (all)                                                | P     |
| `ctrl+shift+m`     | `key_responsiveDesignMode` | Responsive Design Mode                 | b    | `responsive_design` (all)                                              | P     |
| `ctrl+shift+c`     | `key_inspector`            | Inspector                              | b    | `devtools_inspector` (all)                                             | P     |
| `ctrl+shift+k`     | `key_webconsole`           | Web Console                            | b    | `devtools_console` (all)                                               | P     |
| `ctrl+shift+z`     | `key_jsdebugger`           | Debugger (redo in a field: Decision 6) | b    | `devtools_debugger` (all)                                              | P     |
| `ctrl+shift+e`     | `key_netmonitor`           | Network                                | b    | `devtools_network` (all)                                               | P     |
| `shift+f7`         | `key_styleeditor`          | Style Editor                           | b    | `devtools_style_editor` (all)                                          | P     |
| `shift+f5`         | `key_performance`          | Performance                            | b    | `devtools_performance` (all)                                           | P     |
| `shift+f9`         | `key_storage`              | Storage                                | b    | `devtools_storage` (all)                                               | P     |
| `ctrl+shift+w`     | `key_dom`                  | DOM panel                              | b    | `devtools_dom`, no default key (the chord is `close_window`, reserved) | —     |
| `shift+f12`        | `key_accessibility`        | Accessibility panel                    | b    | `devtools_accessibility` (all)                                         | P     |

Conditional (**c**): the profiler's `ctrl+shift+1`, `ctrl+shift+2`, `ctrl+alt+shift+1`,
`ctrl+alt+shift+2` (only with the profiler button in the toolbar) and `ctrl+shift+5`
(`devtools.command-button-jstracer.enabled`).

**Outside the keysets:**

| Key                                                                                                                | Where                                                                      | What it does                                | Fate | Vimma action / handling                                              | First |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------- | ---- | -------------------------------------------------------------------- | ----- |
| `ctrl+tab`                                                                                                         | tabbox.js / browser-ctrlTab.js (`CYCLE_TABS`)                              | next tab (or the recent-tabs panel)         | a    | `next_tab` (all)                                                     | V     |
| `ctrl+pagedown`                                                                                                    | tabbox.js (`NEXT_TAB`)                                                     | next tab                                    | a    | `next_tab` (all)                                                     | V     |
| `ctrl+pageup`                                                                                                      | tabbox.js (`PREVIOUS_TAB`)                                                 | previous tab                                | a    | `previous_tab` (all)                                                 | V     |
| `ctrl+shift+pagedown`                                                                                              | Tabbrowser `on_keydown` (`MOVE_TAB_FORWARD`)                               | move the tab right                          | b    | `move_tab_right` (all)                                               | V     |
| `ctrl+shift+pageup`                                                                                                | Tabbrowser `on_keydown` (`MOVE_TAB_BACKWARD`)                              | move the tab left                           | b    | `move_tab_left` (all)                                                | V     |
| `ctrl+f4`                                                                                                          | Tabbrowser `on_keydown` (`CLOSE_TAB`)                                      | close the tab (not pinned)                  | a    | `close_tab` (all)                                                    | V     |
| `f7`                                                                                                               | Tabbrowser `on_keypress` (`TOGGLE_CARET_BROWSING`, after the page's reply) | caret browsing (asks first)                 | b    | `caret_browsing` (all)                                               | P     |
| `alt` (tap)                                                                                                        | MenuBarListener                                                            | shows the menu bar                          | c    | off: `ui.key.menuAccessKeyFocuses = false`, Q3                       | —     |
| `alt+f`, `alt+e`, `alt+v`, `alt+s`, `alt+b`, `alt+t`, `alt+h` (7 keys)                                             | menu bar accesskeys (`menubar.ftl`)                                        | open a menu                                 | d    | kept: the menu bar's own access keys (Decision 16)                   | —     |
| `'`                                                                                                                | FindBarChild (quick find, links only)                                      | quick find links                            | c    | off: `accessibility.typeaheadfind.manual = false`; `f` hints instead | —     |
| `/`                                                                                                                | FindBarChild (quick find)                                                  | quick find                                  | a    | `find_forward` (n) already; off in fields by the same pref           | V     |
| `f10`, `shift+f10`, context-menu key                                                                               | MenuBarListener / widget                                                   | menu bar, context menu                      | d    | platform accessibility keys                                          | —     |
| `f6`, `shift+f6`                                                                                                   | EventStateManager (`MOVEFOCUS_*DOC`)                                       | cycle focus: address bar ↔ page             | d    | focus navigation                                                     | —     |
| `tab`, `shift+tab`                                                                                                 | EventStateManager                                                          | move focus                                  | d    | focus navigation                                                     | —     |
| `esc` in DOM full screen, dialogs, doorhangers, menus                                                              | PresShell / the dialog                                                     | leave / close                               | d    | theirs                                                               | —     |
| hardware keys and mouse side buttons                                                                               | `AppCommand`                                                               | back, forward, reload, …                    | d    | not keyboard shortcuts                                               | —     |
| address bar keys (`alt+enter`, `ctrl+enter`, `shift+enter`, `alt+up/down`, `f4`, `shift+delete`)                   | UrlbarInput / UrlbarController                                             | open in a tab, engines, delete a suggestion | d    | the field's own keys                                                 | —     |
| find bar keys (`enter`, `shift+enter`, `esc`)                                                                      | findbar                                                                    | next / previous / close                     | d    | the field's (Vimma's in a `/` search, m1-find)                       | —     |
| text editing and page scrolling (`ctrl+left`, `ctrl+backspace`, `shift+arrows`, `space`, `pageup`, `home`, arrows) | editor / ShortcutKeyDefinitions.cpp                                        | edit, scroll                                | d    | the field's / page's own keys                                        | —     |

`F1`, `F2`, `F8` and `F9` do nothing in Firefox on Linux.

**Counts.** 130 Firefox shortcuts: 78 in `#mainKeyset`, 4 conditional keyset keys, 14 in
`#devtoolsKeyset` plus 5 conditional, and 29 outside the keysets. Each of `alt+1..8` and the 7
menu accesskeys counts as a key; each `d` row of a field's or the platform's own keys (address
bar, find bar, editing and scrolling, hardware keys, `Esc` in dialogs) counts as one. By fate:

| Fate                 | Keys                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| (a) existing action  | 39 (10 of them Vimma's keys already: `ctrl+k o w u i d b h` and `/` since key-handling-batch, `ctrl+shift+p` since private-workspace) |
| (b) new named action | 43                                                                                                                                    |
| (c) unbound, off     | 27                                                                                                                                    |
| (d) stays as it is   | 21                                                                                                                                    |

(Since changed: Decision 16 moves ten c keys to b, `ctrl+f` from c to a, and the 7 menu access
keys from c to d. Fate c keeps the conditional keys, `'` and the `alt` tap.)

## Decisions

1. **Nothing is Firefox's by default.** Every key in the inventory with fate a, b or c is off as a
   Firefox shortcut; fates a and b are Vimma bindings on Firefox's own keys (Decision 16). A key
   in the window either runs a Vimma binding, is a text field's or page's own key (fate d), or
   does nothing. So `ctrl+b ?`, `:map` and bindings.md list every active key.
2. **Bound means off.** Whatever `[firefox]` says, the host disables every Firefox key whose chord
   Vimma binds in any mode, so a Vimma binding and a Firefox shortcut can never both run on one
   key (a page-first binding and Firefox's key would otherwise both fire on the same keypress).
   `[firefox]` only decides what happens to chords Vimma does not bind.
3. **Named actions for the common features**, so the overlay reads well and each is rebindable by
   name. New "Browser" group (after "Page"): `new_window` (`window.new`), `close_window`
   (`window.close`), `restore_window` (`window.restore`),
   `quit` (`app.quit`), `reload_hard` (`page.reload_hard`), `stop_loading` (`page.stop`),
   `go_home` (`page.home`), `page_zoom_in` / `page_zoom_out` / `page_zoom_reset`
   (`page.zoom_in` …; `page_` so they do not read as the pane's `zoom`), `toggle_fullscreen`
   (`window.fullscreen`), `save_page` (`page.save`), `print_page` (`page.print`), `downloads`
   (`browser.downloads`), `addons_manager` (`browser.addons`), `history_library`
   (`browser.history`), `bookmarks_library` (`browser.bookmarks`), `mute_tab` (`tab.mute`),
   `picture_in_picture` (`page.picture_in_picture`), `reader_view` (`page.reader_view`),
   `screenshot` (`page.screenshot`), `clear_history` (`browser.clear_history`), and the escape
   hatch `firefox_command` (`firefox.command`, Decision 5). "Tabs" gains `select_last_tab`
   (`tab.goto_last`), `move_tab_left` (`tab.move_left`), `move_tab_right` (`tab.move_right`). New
   "Developer tools" group: `devtools`, `browser_toolbox`, `browser_console`,
   `responsive_design`, `devtools_inspector`, `devtools_console`, `devtools_debugger`,
   `devtools_network`, `devtools_style_editor`, `devtools_performance`, `devtools_storage`,
   `devtools_accessibility` (ids `devtools.*`). 38 new actions. Decision 16 adds ten more for
   the keys that were fate c: "Browser" gains `web_search` (`browser.search`, Firefox's
   `Tools:Search`), `about_processes` (`browser.processes`), `bookmark_all_tabs`
   (`browser.bookmark_all_tabs`), `toggle_bookmarks_toolbar` (`browser.bookmarks_toolbar`),
   `ai_chatbot_sidebar` (`browser.sidebar_chatbot`), `open_tabs_sidebar`
   (`browser.sidebar_tabs`), `toggle_firefox_sidebar` (`browser.sidebar`),
   `switch_text_direction` (`browser.text_direction`) and `caret_browsing`
   (`browser.caret_browsing`); "Developer tools" gains `devtools_dom` (`devtools.dom`).
   - **No `new_private_window`.** Firefox's `ctrl+shift+p` is already Vimma's `private_workspace`
     (`workspace.private`, `defaults.mjs:89`, group "Workspaces"): go to the private workspace, or
     open it. A second action that opens one more private window per press would undo
     private-workspace decision 2 (one private workspace), so there is none; its inventory row is
     fate a with no new binding, as the private-workspace spec requires. The rare need for a bare
     private window is `:firefox Tools:PrivateBrowsing` (Decision 5), and that window still joins
     the private workspace (private-workspace decision 4).
   - **`restore_tab` moves** from "Side panel" (`actions.mjs:259`) to "Tabs", since its key
     `ctrl+shift+t` becomes global (Decision 7) and is no longer a panel-only key.
4. **Each runs exactly what Firefox's key ran**, through a new `host/browser-ops.mjs`: the key's
   `<command>` (`doCommand()` on `cmd_newNavigator`, `Browser:ReloadSkipCache`,
   `cmd_fullZoomEnlarge`, `View:PictureInPicture`, …) or, for keys with no `<command>` (`goHome`,
   the devtools keys), a `command` event on the key element itself, which is what
   `GlobalKeyListener` sends (the sub-PR checks it reaches a `disabled` key's listener; if not, the
   runner re-enables the element for that one dispatch). `caret_browsing` cannot do either:
   Firefox's F7 runs the private `Tabbrowser#toggleCaretBrowsing`
   (`browser/components/tabbrowser/Tabbrowser.sys.mjs:9197`, Firefox 157), which no command or
   key reaches, so its runner repeats those steps: nothing when
   `accessibility.browsewithcaret_shortcut.enabled` is false, the same confirmation (the
   `tabbrowser-confirm-caretbrowsing-*` strings) when `accessibility.warn_on_browsewithcaret` is
   true, then it flips `accessibility.browsewithcaret`. Page commands act on the selected tab,
   which is the focused pane's. `quit` calls `goQuitApplication` with an event whose `ctrlKey`
   (meta on macOS) is set, so the source is `"shortcut"` and Firefox still asks first
   (`browser.warnOnQuitShortcut`). Tab moves and `select_last_tab` count the workspace's visible
   tabs, as `select_tab_N` does. `toggle_fullscreen` from a page in DOM full screen leaves it,
   as `key_exitFullScreen` does.
5. **The generic escape hatch** follows the presets' pattern (a named action for keys, free text
   on the line): `:firefox <id>` runs a `<command>` of the window by id, or a `<key>` by id (as if
   pressed, so the devtools tool keys and keys with only a listener work); Tab completes the
   window's ids; an unknown id says "no Firefox command <id>" and does nothing. To bind it, a
   `[modal.<mode>]` value that starts with `:` is a command line run as if typed and entered
   (Vim's `:map x :cmd<CR>`): `"<C-S-y>" = ":firefox Tools:Downloads"`. Any `:` command works
   (`":open https://…"`, `":layout tiled"`). The keymap checks the command word at load
   (unknown: an error at its line, with a suggestion). The overlay lists such bindings in a
   "Commands" group, one row per binding, the command line as its description. `[keys]` stays
   name → keys; a `:` binding is per mode, which is enough for an escape hatch.
6. **Who goes first: the page where Firefox let it.** A binding on a chord marked **P** in the
   inventory waits for the page, exactly as Firefox's keyset does: Vimma does not consume the
   keydown; it acts on the **keypress** after the page had it (the event the keyset itself
   handles), through the page's reply (`requestReplyFromRemoteContent` + `stopPropagation`, so no
   other chrome handler runs) for a remote page, or a system-group bubble `keypress` listener for
   a parent-process page (about:preferences) and for chrome fields (the address bar), and only if
   nothing called `preventDefault`. Keypress, not keydown, so a field's own edit command wins:
   `ctrl+shift+z` in a field redoes and does not open the Debugger, and `alt+left` in a field
   whose GTK key theme maps it moves the caret. Chords marked **V** (Firefox's reserved keys, the
   tab-switching keys Firefox handles before the page, and Vimma's own keys) are consumed on
   keydown as today. As Firefox does: with the site permission "Override keyboard shortcuts" set
   to Block, P chords count as V; with the fullscreen Keyboard Lock on, V chords other than
   `toggle_fullscreen` go to the page. The P/V mark belongs to the chord, not the action: a user
   who binds `ctrl+s` to something else still lets the page have `ctrl+s` first; a chord outside
   the inventory (`alt+j`) is V, as every Vimma binding is today. Prefix sequences are always V.
   Modal modes (help, panel, hint, resize, command) have no page, so they run at once.
7. **Modes.** The Firefox keys go in `[keys]`, which makes a ctrl/alt/meta chord global: `ctrl+t`
   opens a tab from normal mode, a text field, the address bar, the side panel and the overlay.
   `[keys]` also makes a function-key chord (`f5`, `shift+f12`) global from now on, as Firefox's
   are (today a plain `[keys]` binding is normal-only; no default uses one). `esc` (stop loading)
   is `[modal.normal]` only, so `Esc` keeps leaving insert mode, closing dialogs and doorhangers,
   and cancelling a pending key; it stops a load only when the page did not take it (P).
   `ctrl+[` / `ctrl+]` are `[modal.normal]` (Q2). The Vim keys stay where they are (`H`/`L`,
   `ctrl+o`/`ctrl+i` normal only); the new keys are added next to them, so "Go back" lists `H`,
   `ctrl+o`, `alt+left`, `ctrl+[`. The `[modal.panel]` `<C-S-t>` entry (`defaults.mjs:216-217`)
   goes: the global `restore_tab` binding covers the panel. An open picker (goto, workspace,
   add-on) keeps taking every key before any binding (`VimmaHost.sys.mjs:1342-1348`), so
   `ctrl+t` does nothing while one is open, as today; the help overlay is not a picker and runs
   global bindings.
8. **Default bindings** are the inventory's a and b rows. No new binding clashes with an existing
   default (checked against main's `defaults.mjs` on 2026-10-13):
   - `[keys]` (`defaults.mjs:52-96`) has one bare chord, `ctrl+shift+p` (`private_workspace`),
     which the inventory keeps as is (fate a); every other new `[keys]` chord is free. Prefix keys
     do not change: `prefix+enter`, `prefix+space` (tiling-layouts), `prefix+shift+p`
     (private-workspace), `prefix+^` / `prefix+ctrl+6` are untouched, and `ctrl+b u`
     (toolbar-toggle) stays free for that spec.
   - `[modal.normal]` (`:104-162`): `ctrl+o`, `ctrl+i`, `ctrl+d`, `ctrl+u`, `ctrl+e`, `ctrl+y`,
     the `ctrl+w` pane keys, `ctrl+^` and `ctrl+6` keep their Vimma meanings; `]w` / `[w` are
     plain-key sequences, not `ctrl+]` / `ctrl+[`; normal mode has no `<Esc>` binding yet, and a
     pending sequence's `Esc` still cancels first (`dispatcher.mjs:94-98`).
   - `[modal.panel]` (`:202-233`, with unsplit's marks `<Space>` and `V` from #149/#150) binds
     only plain keys besides `<C-S-t>`, which goes (Decision 7). `[modal.resize]`,
     `[modal.help]`, `[modal.hint]`, `[modal.visual]`, `[modal.insert]` and `[modal.command]` bind
     only plain keys and `<Esc>`/arrows, so the new global chords do not shadow any of them.
   - The `/` search (#167) handles only Enter, Esc and plain keys before the keymap, so
     `ctrl+g` / `f3` (`find_next`) reach the dispatcher and step Firefox's finder as `n` does.

   toolbar-toggle relies on `ctrl+l`, `alt+d` and `F6` giving a focused address bar: `ctrl+l`
   and `alt+d` run `focus_urlbar` (`Browser:OpenLocation`, the path toolbar-toggle hooks), `F6`
   is d.

9. **`[firefox]` from now on.** Default `disable = "all"`, and "all" means the whole inventory
   except fate d: plain and function keys (`F5`, `F11`, `Esc`, `shift+Esc`, `F3`), every keyset
   of the window (`#mainKeyset`, `#devtoolsKeyset`, the conditional ones), and the out-of-keyset
   handlers, which the host stops by consuming the keydown of an unbound, not-enabled chord (V:
   the page never had these keys in Firefox either; `F7`, the one P key there, goes to the page
   first and Vimma consumes its reply). The menu bar's access keys stay (Decision 16), and two
   prefs are set in Vimma's branding prefs: `ui.key.menuAccessKeyFocuses = false`,
   `accessibility.typeaheadfind.manual = false`. `ALL_KEEP` goes: `ctrl+q` is now `quit`, a Vimma
   binding with Firefox's confirmation (Decision 4). Editing keys (`internal`, `key_delete`,
   Backspace) are d and never touched.
   - **`enable`** is the escape hatch for a key exactly as Firefox runs it (its own reserved-ness,
     its own UI such as the ctrl+tab panel): the chord's Vimma default bindings are dropped and
     Firefox's key stays on. Enabling a chord the user's own `[keys]` / `[modal.*]` binds is an
     error at the `enable` line ("ctrl+t is bound to new_tab in [keys]; unbind it or drop it
     here"). Validation widens from "ctrl, alt, meta or a function key" to "a chord in the
     inventory or with ctrl, alt, meta, or a function key", so `enable = ["esc"]` (Firefox's stop)
     is valid.
   - **A `disable` list** keeps its meaning: those chords off, the other unbound ones Firefox's.
     Since Vimma binds every Firefox key but the c keys, a list only matters for those.
10. **Migration: none needed, no schema bump.** `[firefox]` keeps its schema-2 shape; only the
    default changes. A file without `[firefox]` (or with the template's commented lines) gets
    `"all"` with the next start. A file that sets `disable = [...]` keeps it (Decision 9); about:vimma
    says "[firefox] disable lists N keys: Firefox's other shortcuts stay on (see ctrl+b ?)", and
    the overlay's "Firefox (on in config.toml)" group shows each one, so nothing is hidden. Files
    are never rewritten (ConfigHost): the template gains `# disable = "all"` and a new comment
    (below); an old file's stale comment above its commented-out list is harmless, and the guide
    says so. The template comment: `# Firefox's own shortcuts are off; Vimma binds them on the same
keys (ctrl+b ? lists them). enable = ["ctrl+j"] gives one back exactly as Firefox runs it.`
11. **The overlay is complete.** With the defaults every active key is a binding, so the overlay
    is complete by construction. For keys a user turns back on, `bindingTable` gains a
    "Firefox (on in config.toml)" group from the host's `FirefoxKeys.status()`: one row per live
    Firefox key that is on and unbound (chord, Firefox's label from the menu item or the
    inventory, id), filterable like the rest. It is empty, so not shown, with the defaults.
    about:vimma's "Firefox shortcuts off" becomes "Firefox shortcuts on" (the short list).
12. **A coverage test guards upgrades** (`browser_vimma_firefox_coverage.js`), driven by the
    inventory as data: a core table `FIREFOX_SHORTCUTS` in `core/firefox-keys.mjs` (chord,
    source, id, command, fate, action, first), the single source for the plan, the P/V rule, the
    guide's table (gen-docs writes it into bindings.md, below) and the test. With the default
    config, after the devtools keys are hooked and Fluent has filled every letter:
    - every `<key>` in every `<keyset>` of the window with a chord is a table row (else: "Firefox
      shortcut <id> (<chord>) is new: add it to FIREFOX_SHORTCUTS with a fate"), and every keyset
      row exists (else: "<id> is gone upstream: drop its row");
    - every a/b/c key element is `disabled`; every a/b row's chord is bound by the default keymap
      to its action; every c row's chord is unbound;
    - `ShortcutUtils.getSystemActionForEvent` over every ctrl/shift/alt/meta combination of the
      named keys and F-keys returns an action only for table rows (new out-of-keyset keys fail);
    - each out-of-keyset c/a key, synthesised with a keymap that unbinds it, changes nothing
      (selected tab, tab order, caret browsing pref, find bar);
    - the menu bar's access keys (`#main-menubar > menu`) keep their `accesskey` (fate d);
    - real key events (`EventUtils.synthesizeKey`) for each a/b chord run Vimma's action, so the
      shift-folding between XUL `modifiers` and Vimma's notation is checked, not assumed.
      (Since changed: decision 16 binds every keyset key, so the c rows are the conditional
      keys, `'` and the out-of-keyset `ctrl`/`alt`/`meta`+`f7` variants, which
      `getSystemActionForEvent` also maps to caret browsing in Firefox 158 and which stay
      unbound because Vimma binds `f7` alone. The first run also added the conditional
      `alt+p` row for Firefox 158's `#profiles-menu`, and made `xulKeyChord` fold shift into a
      digit or symbol's US shifted character (`]` with `accel,shift` is `ctrl+}`), because
      Firefox matches the typed character. A chord whose real key event cannot reach its
      action yet is a `todo` naming its issue: `ctrl+shift+z`, prevented by content's native
      `cmd_redo` handler, [#371](https://github.com/vimma-browser/vimma/issues/371).
      Since #371: a remote page's reply counts as taking a page-first key only when page script
      prevented it, or a field has focus, because Firefox 158's root key listener runs
      `cmd_redo` (`KeyEventHandler::DispatchXBLCommand` prevents the event before it looks for
      a controller) on every page, so no `todo` remains.)
      The upstream autopilot ([m7-upstream-autopilot](m7-upstream-autopilot.md)) already runs
      `npm run mochitest -- tests/browser/` on its bump branch; the sub-PR names this test in
      `docs/rebase.md` step 4 as the one to read first when a bump fails, and its failure message
      says which table row to add or drop.
13. **Must never be lost** (each has a mochitest): `ctrl+q` asks before quitting; `Esc` closes
    dialogs, doorhangers, menus and DOM full screen; about:preferences' own keys (`ctrl+f` there
    focuses its search: P); the PDF viewer's own keys (pdf.js takes `ctrl+plus`, `ctrl+f`: P);
    the DevTools toolbox's own keys (`ctrl+[` / `ctrl+]` switch panels, `ctrl+f` searches a
    panel: focus inside a docked toolbox counts as a page for the P/V rule, and a toolbox in its
    own window has no VimmaHost); pages with their own ctrl keys (Google Docs, Figma: P, and
    `[sites]` insert rules as today); `F6`, `Tab`, `F10`, `shift+F10` and the context-menu key
    (d); the editing keys in every field (d).
14. **Platform: Linux first.** The inventory is Linux's (`XP_GNOME`: `alt+1..9`, `ctrl+shift+y`,
    `ctrl+j`, `ctrl+[`). `xulKeyChord` already maps `accel` to meta on macOS, so the mechanism
    works there, but macOS rows (`cmd+…`, `cmd+alt+i`, `cmd+{`) are not in the table and the
    coverage test runs on Linux CI only; a macOS table is out of scope until Vimma ships there.
    (Since changed: `FIREFOX_SHORTCUTS_MACOS` is the macOS table, the Linux rows with macOS's
    chords and macOS's own keys, and the coverage test reads it on a Mac;
    [macos-build](macos-build.md) "Keys: accel", issue
    [#384](https://github.com/vimma-browser/vimma/issues/384).)
15. **No upstream patch.** Everything is our code: disabling `<key>` elements (as today),
    consuming keydowns, DOM attributes on the menu bar, and two prefs in Vimma's branding prefs
    file. No ADR line is needed.

16. **Firefox's own keys are the defaults.** Every Firefox shortcut is a Vimma binding whose
    default key is Firefox's own key, so users keep their Firefox habits while every key is
    listed in `ctrl+b ?` and can be rebound in one place, Vimma's keymap. The keys that were fate
    c become fate b (new actions, Decision 3) on their Firefox chords, and `ctrl+f` becomes a
    second key for `find_forward` (fate a), because Vimma's `/` search already drives Firefox's
    finder. Three exceptions, each with its reason:
    - **`'` (quick find, links only) and the `alt` tap stay off**, because they clash with
      Vimma's modal keys: `'` is a plain key that normal mode owns, and an `alt` tap moves focus
      to the menu bar, away from the page whose keys normal mode handles.
    - **The 7 menu bar access keys (`alt+f e v s b t h`) are fate d**, left to Firefox's menu
      bar while it exists, because they are attributes of its menus rather than shortcuts Vimma
      can rebind, and dropping them would leave the menu bar without a keyboard path.
    - **`ctrl+shift+w` stays `close_window`.** Firefox's reserved close-window key wins over the
      DevTools' DOM panel key on the same chord, so `devtools_dom` gets no default key; it can
      be bound by name.

    The conditional keys stay fate c, because they exist only in developer builds or with
    settings Vimma does not change, and two of their chords (`ctrl+alt+r`, `ctrl+^`) are already
    Vimma's. Fate d is unchanged apart from the menu access keys. Sub-PR 1 left these keys
    unbound; sub-PR 2 binds them.

17. **`shift+esc` is a normal-mode key.** `about_processes` keeps Firefox's `shift+esc`, but only
    in normal mode, because the chord has no `ctrl`, `alt` or `meta` and Vimma's keymap makes
    only such chords and the F-keys global (`keymap.mjs`). In a text field `shift+esc` stays with
    the field, as every other unmodified key there does, and leaving the field with `esc` first
    still gives the process manager.

    (Since changed: Firefox 159 moved Add-ons to `ctrl+shift+f` (`cmd+shift+e` on macOS) and
    gave `ctrl+shift+a` to a new `key_searchTabs` (`Browser:SearchTabs`, the address bar's tabs
    mode). Following decision 16, `addons_manager` moves to `ctrl+shift+f`, and
    `ctrl+shift+a` is fate a, a second key for `goto_picker`: Vimma's tab search
    ([tab-search](tab-search.md)) already searches tabs, across workspaces and windows, and
    keeps private tabs out of a normal window, which the address bar's tabs mode does not know
    about.)

## Sub-PRs

Each is its own keymap PR, in this order, one open at a time:

1. **Firefox's keys are Vimma bindings.** `FIREFOX_SHORTCUTS` table in `core/firefox-keys.mjs`
   (every inventory row, `ctrl+shift+p` as fate a → `private_workspace` with no new binding); the
   37 new actions of Decision 3 except `firefox_command`, and their runners in a new
   `host/browser-ops.mjs`; `restore_tab` moved to "Tabs"; the a/b default bindings in
   `defaults.mjs` (`[keys]`, plus `esc`, `ctrl+[`, `ctrl+]` in `[modal.normal]`) and the panel's
   `<C-S-t>` removed; F-keys global in `[keys]` (`keymap.mjs`); the P/V rule (keypress after the
   page, reply handling; Decision 6); "bound means off" in `planFirefoxKeys` over every keyset of
   the window (`host/firefox-keys.mjs` watches all `<keyset>`s, not `#mainKeyset` only); the
   "Browser" and "Developer tools" groups; gen-docs (`defaults.toml`, bindings.md with a new
   "Firefox's shortcuts" section, bindings.json with the new rows); the snapshots; guide,
   README, and toolbar-toggle.md's "`alt` still shows it" line (Q3). `[firefox]` keeps today's
   default `disable` (`OVERLAP_CHORDS`) here, so unbound Firefox keys are as before.
2. **Firefox's own shortcuts off.** Default `disable = "all"` with the wider "all"; consuming the
   out-of-keyset handlers; the two prefs; the ten actions of Decision 16 with their default keys
   (`ctrl+f` added to `find_forward`); `enable` dropping default
   bindings and its new error; `firefox_command`, `:firefox` and `:` bindings with the "Commands"
   group; the "Firefox (on in config.toml)" group; about:vimma; the template comment.
3. **The coverage test** (Decision 12) and its `docs/rebase.md` line.

**Sub-PR 1, as built.**

- **"Bound"** is the first chord of every binding in any mode (`boundChords`), so `ctrl+w`
  (Vimma's `ctrl+w h`) counts. Bound means off unless `[firefox] enable` lists the chord: then
  Firefox's key stays on and Vimma's binding takes the key first (V) where it binds it, so the
  two never both run (`enable = ["ctrl+u"]` still gives view source in a text field). Sub-PR 2's
  "enable drops the default bindings" replaces this.
- **P only where the inventory binds it:** a row bound in normal mode only (`esc`, `ctrl+[`,
  `ctrl+]`) is page-first in normal mode only (`pageFirst(chord, { mode })`); `Esc` leaving
  insert or copy mode stays Vimma's first (the copy-mode, find and insert mochitests caught it).
- **Page-first keys queue** (`state.pageFirst`, oldest first, at most 16): keys typed fast or
  held down each wait for their own reply.
- **Off the page:** `history.back` / `forward`, `page.reload`, `find.next` / `previous` run on the
  selected tab's page when no page of ours has focus (`alt+left`, `F5`, `ctrl+g` from the address
  bar, as Firefox's did).
- **Find:** with Firefox's own find bar open (`ctrl+f` is still Firefox's here), `ctrl+g`, `F3`
  and `n` step its search (`onFindAgainCommand`).
- **Keysets:** the host watches every `<keyset>` of the window and where keysets are added (the
  body, the root), so `#devtoolsKeyset` is covered once DevTools hook in. `runKey` dispatches the
  command on a disabled key by lifting `disabled` for that one call (needed for `goHome` and the
  DevTools keys; checked in `browser_vimma_browser_keys.js`).
- Not covered by a test yet: `F11` (headless full screen), the PDF viewer's own `ctrl+plus`,
  `about:preferences`' `ctrl+f` (unbound here anyway).

## Test plan

- **Vitest** (core, red first):
  - `firefox-keys.test.mjs`: `FIREFOX_SHORTCUTS` is well formed (chords canonical, fates a–d,
    a/b rows name an existing action, no chord twice with different actions); every a/b chord is
    bound by the default keymap to its action in the listed modes; every c chord is unbound;
    `planFirefoxKeys`: bound chords are off whatever the setting, `"all"` covers plain and
    function keys and every keyset but no d row, `enable` keeps a chord on and drops its default
    binding, an explicit list keeps its meaning; `pageFirst(chord)` per row, V for an unknown
    chord and for prefix sequences.
  - `keymap.test.mjs`: an `f5` / `shift+f12` `[keys]` binding is global; a `:` value compiles to a
    command binding, an unknown command word is an error at its line with a suggestion;
    `enable` on a user-bound chord is an error at the `enable` line.
  - `config.test.mjs` (+ `config-v2`, fuzz arbitrary): the new `enable` validation (`"esc"`
    valid, `"x"` not); the default resolves to `"all"`; no migration step was added.
  - `cmdline.test.mjs`: `:firefox <id>` parses to `firefox.command` with its text; completion
    over the ids the host supplies.
  - `help.test.mjs`: the new groups and rows; the "Commands" and "Firefox (on in config.toml)"
    groups from supplied rows, empty and hidden by default.
  - Snapshots re-recorded with a line each: `help.test.mjs.snap` (the new rows and keys),
    `defaults.test.mjs.snap` (the new `[keys]` entries, `[firefox] disable = "all"`, the panel's
    `<C-S-t>` gone); `defaults.toml`, `docs/bindings.md` and `docs/bindings.json` regenerated
    (`defaults.test.mjs` fails on a stale bindings.json).
  - `help.test.mjs` `bindingsJson`: the new groups appear in bindings.json in the overlay's
    order, and its `version` stays 1 (the shape does not change; the "Firefox's shortcuts"
    inventory is bindings.md only).
- **Mochitests:**
  - `browser_vimma_firefox_keys.js` is rewritten, because its premise changes on purpose (it
    asserts `ctrl+t`, `ctrl+l`, `ctrl+tab` "stay Firefox's"): now they run Vimma's actions and
    Firefox's elements are disabled; `disable = [...]` and `enable` as in Decision 9; about:vimma.
  - `browser_vimma_browser_keys.js` (new): each b action does what Firefox's key did (a window
    opens, zoom changes and resets, full screen toggles, a slow page stops on `Esc` in normal
    mode, `ctrl+q` shows the quit prompt and cancelling it keeps the browser, `alt+9` selects the
    workspace's last tab, `ctrl+shift+p` goes to the private workspace and its disabled
    `key_privatebrowsing` opens no second private window, `ctrl+shift+pagedown` moves the tab);
    `alt+left` goes back in normal and insert mode and from the address bar; a page that calls
    `preventDefault` on `ctrl+f`, `ctrl+s` and `ctrl+plus` keeps them and Vimma does nothing;
    the same page cannot keep
    `ctrl+t` or `ctrl+tab`; `ctrl+shift+z` in a field redoes and opens no toolbox; a Block
    "shortcuts" permission makes `ctrl+s` Vimma's first; about:preferences keeps its `ctrl+f`;
    the PDF viewer zooms its own way on `ctrl+plus`.
  - `browser_vimma_firefox_coverage.js` (new, sub-PR 3): Decision 12.
  - `browser_vimma_help_overlay.js`: "Go back" lists `H`, `ctrl+o`, `alt+left`, `ctrl+[`; the
    "Firefox (on in config.toml)" group appears with `enable = ["ctrl+j"]`; a `:` binding shows in
    "Commands".
  - `browser_vimma_edit_keys.js`, `_key_capture.js`, `_nav_keys.js`, `_tab_keys.js`,
    `_pane_keys.js`, `_workspace_buffer_keys.js`, `_a11y.js`, `_find.js`,
    `_side_panel_unsplit.js`, `_private_workspace.js` and
    `_private_swap.js` run unchanged and stay green, as do toolbar-toggle's tests once it is
    built.
- **e2e:** `m0-happy-path-help.png` shows the overlay, whose Tabs rows gain `ctrl+t`, `ctrl+tab`,
  `alt+1` …, so it is expected to change. Re-record it only if it does, with the changelog line
  "the bindings overlay lists Firefox's keys (ctrl+t, alt+1..9, ctrl+tab …) next to Vimma's".
  `m4-split-panes.png` shows no overlay and is not expected to change.

## Docs the implementation must update

- **guide.md**: "Every key is yours" (Firefox's keys are bindings too, and how to take one away);
  "Keys" (the table's last row, "Firefox's own keys … unchanged", is replaced by the Browser and
  Developer tools keys; "Page zoom has no Vimma keys" goes); "Firefox's own shortcuts" rewritten:
  default `"all"`, what "all" covers, the inventory's c keys and how to get each (`:firefox`,
  `enable`), `enable` and its error, the P/V rule in one paragraph, the stale-comment note;
  "Firefox behaviour Vimma changes" (the `alt` tap and quick-find prefs); `config.toml` (`[firefox]`
  default, `:` bindings in `[modal.*]`); "The command line" (`:firefox`).
- **README**: the "Every key is yours" feature line says Firefox's own shortcuts are Vimma
  bindings too.
- **bindings.md** via `npm run gen-docs`: the new rows, and a generated "Firefox's shortcuts"
  section (the inventory: key, what Firefox did, Vimma's action or "off").
- **bindings.json** via the same `npm run gen-docs`: the new groups and rows, same shape
  (`version: 1`). Merging it runs `site-dispatch.yml`, which opens the vimma.dev mirror PR.
- **defaults.toml** via `npm run gen-docs`.
- **toolbar-toggle.md**: "`alt` still shows it" becomes "`alt` does not (firefox-keys Q3); `F10`
  does" (sub-PR 1).
- **CHANGELOG.md** is the maintainer's at merge time (CONTRIBUTING.md), not these PRs'.

## Out of scope

A macOS inventory; DevTools' own in-toolbox keys and a toolbox in its own window; extension
keyboard shortcuts (`commands` in a manifest: they are the extension's, set in about:addons);
remapping keys inside the address bar's or find bar's own handling; a Vimma action for every
Firefox `<command>` (the c keys stay reachable through `:firefox`).

## Decided questions

1. **`ctrl+f`:** a second default key for `find_forward`, after the page (P), so a page that
   handles it still gets it (Decision 16).
2. **`ctrl+[` in a text field:** in insert mode and text fields it does nothing. In normal mode it
   is still back, as listed under "Go back".
3. **The `alt` tap that shows the menu bar:** off (`ui.key.menuAccessKeyFocuses = false`, and `F10`
   still opens the menus). This replaces toolbar-toggle's "`alt` still shows it", and sub-PR 1
   updates that spec.
4. **`F7`:** `caret_browsing`, Firefox's caret browsing toggle with its confirmation
   (Decisions 4 and 16). `copy_mode` keeps its Vimma keys.
5. **DevTools keys:** exactly as in Firefox, so a developer's habits keep working. All 12 actions
   are bound by default on Firefox's chords, and each one can be rebound or unbound by name in
   `[keys]` in config.toml, like any other action. The DOM panel's `ctrl+shift+w` stays
   `close_window`, as it is in Firefox, where the reserved close-window key wins; `devtools_dom`
   has no default key (Decision 16). The profiler and tracer keys stay conditional and can be
   reached through `:firefox`.
