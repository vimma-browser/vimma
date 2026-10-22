/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Firefox's own shortcuts (docs/specs/key-handling-batch.md § 1, docs/specs/firefox-keys.md):
 * every key Firefox handles in a Linux browser window (FIREFOX_SHORTCUTS), which `<key>`
 * elements of the window's keysets Vimma turns off, and who goes first on a chord, the page or
 * Vimma. The host reads each element's chord with xulKeyChord and disables what
 * planFirefoxKeys returns. macOS has its own inventory, FIREFOX_SHORTCUTS_MACOS
 * (docs/specs/macos-build.md decision 22).
 */
import { formatKey, makeChordText, parseKey } from "./keys.mjs";
import { MODES } from "./modes.mjs";

/** @import { Chord } from "./keys.mjs" */

/**
 * The default `[firefox] disable`: the chords Vimma's keymap or Vim's text-field keys use. On
 * Linux, Firefox 157 binds all but ctrl+e and ctrl+y (`key_search2` is ctrl+j there).
 */
export const OVERLAP_CHORDS = Object.freeze([
  "ctrl+b",
  "ctrl+d",
  "ctrl+e",
  "ctrl+h",
  "ctrl+i",
  "ctrl+k",
  "ctrl+o",
  "ctrl+u",
  "ctrl+w",
  "ctrl+y",
]);

/**
 * One Firefox shortcut and its fate (docs/specs/firefox-keys.md § The inventory).
 * @typedef {object} FirefoxShortcut
 * @property {string} chord     canonical, as Vimma writes it (`ctrl+}`, `ctrl+plus`)
 * @property {"main" | "devtools" | "chrome" | "menubar" | "page" | "field" | "platform"} source
 *   `main` / `devtools`: a `<key>` of #mainKeyset / #devtoolsKeyset (or a conditional keyset);
 *   `chrome`: Firefox's keydown handlers (Tabbrowser, tabbox, ctrlTab); `menubar`: the menu
 *   bar; `page`: the page process (quick find); `field`: an address bar, find bar or text
 *   field's own key; `platform`: focus navigation and accessibility keys
 * @property {string} id        Firefox's `<key>` id, or the handler (empty: an unnamed key)
 * @property {string} command   the `<command>` it runs, or empty
 * @property {string} does      what Firefox does with it
 * @property {"a" | "b" | "c" | "d"} fate  a: an existing Vimma action; b: a new named action;
 *   c: unbound and off; d: not a window shortcut, stays as it is
 * @property {string} [action]  the Vimma action bound to the chord by default (a, b)
 * @property {"all" | "normal"} [modes]  where that binding works
 * @property {"P" | "V"} [first]  a and b: who has the key first, the page (P) or Vimma (V)
 * @property {boolean} [conditional]  only in some builds or settings
 * @property {boolean} [unbound]  the action has no default key on this chord (another row's
 *   action owns it)
 * @property {"fullscreen"} [when]  only then (Firefox's reserved F11 that leaves full screen)
 */

/**
 * @param {FirefoxShortcut["source"]} source
 * @param {Array<[chord: string, id: string, command: string, does: string, fate: string,
 *   action?: string | null, modes?: string | null, first?: string | null,
 *   extra?: Partial<FirefoxShortcut>]>} rows
 * @returns {FirefoxShortcut[]}
 */
function rowsOf(source, rows) {
  return rows.map(([chord, id, command, does, fate, action, modes, first, extra]) => {
    /** @type {Record<string, unknown>} */
    const row = { chord, source, id, command, does, fate };
    if (action) row.action = action;
    if (modes) row.modes = modes;
    if (first) row.first = first;
    return /** @type {FirefoxShortcut} */ (Object.freeze({ ...row, ...extra }));
  });
}

/**
 * Every key that does something in a Linux browser window (Firefox 157, en-US), with its fate:
 * the single source for the default bindings' check, who goes first (pageFirst) and
 * bindings.md's "Firefox's shortcuts". docs/specs/firefox-keys.md § The inventory.
 * @type {readonly FirefoxShortcut[]}
 */
export const FIREFOX_SHORTCUTS = Object.freeze([
  ...rowsOf("main", [
    ["ctrl+n", "key_newNavigator", "cmd_newNavigator", "new window", "b", "new_window", "all", "V"],
    [
      "ctrl+t",
      "key_newNavigatorTab",
      "cmd_newNavigatorTabNoEvent",
      "new tab",
      "a",
      "new_tab",
      "all",
      "V",
    ],
    [
      "ctrl+l",
      "focusURLBar",
      "Browser:OpenLocation",
      "focus the address bar",
      "a",
      "focus_urlbar",
      "all",
      "P",
    ],
    [
      "alt+d",
      "focusURLBar2",
      "Browser:OpenLocation",
      "focus the address bar",
      "a",
      "focus_urlbar",
      "all",
      "P",
    ],
    ["ctrl+k", "key_search", "Tools:Search", "web search", "a", null, null, "V"],
    ["ctrl+j", "key_search2", "Tools:Search", "web search", "b", "web_search", "all", "P"],
    [
      "ctrl+shift+y",
      "key_openDownloads",
      "Tools:Downloads",
      "Library: downloads",
      "b",
      "downloads",
      "all",
      "P",
    ],
    [
      "ctrl+shift+a",
      "key_openAddons",
      "Tools:Addons",
      "add-ons manager",
      "b",
      "addons_manager",
      "all",
      "P",
    ],
    ["ctrl+o", "openFileKb", "Browser:OpenFile", "open a file", "a", "history_back", "normal", "V"],
    ["ctrl+s", "key_savePage", "Browser:SavePage", "save page", "b", "save_page", "all", "P"],
    ["ctrl+p", "printKb", "cmd_print", "print", "b", "print_page", "all", "P"],
    ["ctrl+w", "key_close", "cmd_close", "close tab", "a", null, null, "V"],
    [
      "ctrl+shift+w",
      "key_closeWindow",
      "cmd_closeWindow",
      "close window",
      "b",
      "close_window",
      "all",
      "V",
    ],
    ["ctrl+m", "key_toggleMute", "cmd_toggleMute", "mute the tab", "b", "mute_tab", "all", "P"],
    ["ctrl+z", "key_undo", "", "undo in a field", "d"],
    ["ctrl+shift+z", "key_redo", "", "redo in a field", "d"],
    ["ctrl+x", "key_cut", "", "cut", "d"],
    ["ctrl+c", "key_copy", "", "copy", "d"],
    ["ctrl+v", "key_paste", "", "paste", "d"],
    ["ctrl+a", "key_selectAll", "", "select all", "d"],
    ["delete", "key_delete", "cmd_delete", "delete in chrome fields", "d"],
    ["backspace", "", "cmd_handleBackspace", "nothing (browser.backspace_action = 2)", "d"],
    [
      "shift+backspace",
      "",
      "cmd_handleShiftBackspace",
      "nothing (browser.backspace_action = 2)",
      "d",
    ],
    ["alt+left", "goBackKb", "Browser:Back", "back", "a", "history_back", "all", "P"],
    ["alt+right", "goForwardKb", "Browser:Forward", "forward", "a", "history_forward", "all", "P"],
    ["ctrl+[", "goBackKb2", "Browser:Back", "back", "a", "history_back", "normal", "P"],
    ["ctrl+]", "goForwardKb2", "Browser:Forward", "forward", "a", "history_forward", "normal", "P"],
    ["alt+home", "goHome", "", "home page", "b", "go_home", "all", "P"],
    ["f5", "key_reload2", "Browser:Reload", "reload", "a", "reload", "all", "P"],
    [
      "ctrl+shift+h",
      "showAllHistoryKb",
      "Browser:ShowAllHistory",
      "Library: history",
      "b",
      "history_library",
      "all",
      "P",
    ],
    [
      "ctrl+f5",
      "key_reload_skip_cache2",
      "Browser:ReloadSkipCache",
      "reload, bypassing the cache",
      "b",
      "reload_hard",
      "all",
      "P",
    ],
    [
      "f11",
      "key_enterFullScreen",
      "View:FullScreen",
      "full screen",
      "b",
      "toggle_fullscreen",
      "all",
      "P",
    ],
    [
      "f11",
      "key_exitFullScreen",
      "View:FullScreen",
      "leave full screen",
      "b",
      "toggle_fullscreen",
      "all",
      "V",
      { when: "fullscreen" },
    ],
    [
      "ctrl+alt+r",
      "key_toggleReaderMode",
      "View:ReaderView",
      "Reader View",
      "b",
      "reader_view",
      "all",
      "P",
    ],
    [
      "ctrl+}",
      "key_togglePictureInPicture",
      "View:PictureInPicture",
      "Picture-in-Picture",
      "b",
      "picture_in_picture",
      "all",
      "P",
    ],
    [
      "ctrl+}",
      "",
      "View:PictureInPicture",
      "Picture-in-Picture (where } is another key)",
      "b",
      "picture_in_picture",
      "all",
      "P",
    ],
    ["ctrl+r", "key_reload", "Browser:Reload", "reload", "a", "reload", "all", "P"],
    [
      "ctrl+shift+r",
      "key_reload_skip_cache",
      "Browser:ReloadSkipCache",
      "reload, bypassing the cache",
      "b",
      "reload_hard",
      "all",
      "P",
    ],
    [
      "shift+esc",
      "key_aboutProcesses",
      "View:AboutProcesses",
      "about:processes",
      "b",
      "about_processes",
      // Bare shift+esc has no ctrl/alt/meta, so it is a normal-mode key: in a text field it stays
      // with the field (docs/specs/firefox-keys.md decision 17).
      "normal",
      "P",
    ],
    [
      "ctrl+u",
      "key_viewSource",
      "View:PageSource",
      "view source",
      "a",
      "scroll_half_up",
      "normal",
      "V",
    ],
    ["ctrl+i", "key_viewInfo", "View:PageInfo", "Page Info", "a", "history_forward", "normal", "V"],
    ["ctrl+f", "key_find", "cmd_find", "find in page", "a", "find_forward", "all", "P"],
    ["ctrl+g", "key_findAgain", "cmd_findAgain", "next match", "a", "find_next", "all", "P"],
    [
      "ctrl+shift+g",
      "key_findPrevious",
      "cmd_findPrevious",
      "previous match",
      "a",
      "find_previous",
      "all",
      "P",
    ],
    ["f3", "key_findAgain2", "cmd_findAgain", "next match", "a", "find_next", "all", "P"],
    [
      "shift+f3",
      "key_findPrevious2",
      "cmd_findPrevious",
      "previous match",
      "a",
      "find_previous",
      "all",
      "P",
    ],
    [
      "ctrl+d",
      "addBookmarkAsKb",
      "Browser:AddBookmarkAs",
      "bookmark the page",
      "a",
      "scroll_half_down",
      "normal",
      "V",
    ],
    [
      "ctrl+shift+d",
      "bookmarkAllTabsKb",
      "",
      "bookmark all tabs",
      "b",
      "bookmark_all_tabs",
      "all",
      "P",
    ],
    [
      "ctrl+shift+o",
      "manBookmarkKb",
      "Browser:ShowAllBookmarks",
      "Library: bookmarks",
      "b",
      "bookmarks_library",
      "all",
      "P",
    ],
    ["ctrl+b", "viewBookmarksSidebarKb", "", "bookmarks sidebar", "a", null, null, "V"],
    [
      "ctrl+shift+b",
      "viewBookmarksToolbarKb",
      "",
      "show or hide the bookmarks toolbar",
      "b",
      "toggle_bookmarks_toolbar",
      "all",
      "P",
    ],
    ["esc", "key_stop", "Browser:Stop", "stop loading", "b", "stop_loading", "normal", "P"],
    [
      "ctrl+alt+x",
      "viewGenaiChatSidebarKb",
      "",
      "AI chatbot sidebar",
      "b",
      "ai_chatbot_sidebar",
      "all",
      "P",
    ],
    [
      "ctrl+alt+u",
      "viewOpenTabsSidebarKb",
      "",
      "open-tabs sidebar",
      "b",
      "open_tabs_sidebar",
      "all",
      "P",
    ],
    [
      "ctrl+alt+z",
      "toggleSidebarKb",
      "",
      "toggle the sidebar",
      "b",
      "toggle_firefox_sidebar",
      "all",
      "P",
    ],
    ["ctrl+h", "key_gotoHistory", "", "history sidebar", "a", null, null, "V"],
    [
      "ctrl+minus",
      "key_fullZoomReduce",
      "cmd_fullZoomReduce",
      "zoom out",
      "b",
      "page_zoom_out",
      "all",
      "P",
    ],
    ["ctrl+_", "", "cmd_fullZoomReduce", "zoom out", "b", "page_zoom_out", "all", "P"],
    [
      "ctrl+plus",
      "key_fullZoomEnlarge",
      "cmd_fullZoomEnlarge",
      "zoom in",
      "b",
      "page_zoom_in",
      "all",
      "P",
    ],
    ["ctrl+=", "", "cmd_fullZoomEnlarge", "zoom in", "b", "page_zoom_in", "all", "P"],
    [
      "ctrl+0",
      "key_fullZoomReset",
      "cmd_fullZoomReset",
      "reset zoom",
      "b",
      "page_zoom_reset",
      "all",
      "P",
    ],
    ["ctrl+shift+tab", "key_showAllTabs", "", "previous tab", "a", "previous_tab", "all", "V"],
    [
      "ctrl+shift+x",
      "key_switchTextDirection",
      "cmd_switchTextDirection",
      "flip a field's text direction",
      "b",
      "switch_text_direction",
      "all",
      "P",
    ],
    [
      "ctrl+shift+p",
      "key_privatebrowsing",
      "Tools:PrivateBrowsing",
      "new private window",
      "a",
      "private_workspace",
      "all",
      "V",
    ],
    [
      "ctrl+shift+s",
      "key_screenshot",
      "Browser:Screenshot",
      "screenshot",
      "b",
      "screenshot",
      "all",
      "P",
    ],
    [
      "ctrl+shift+delete",
      "key_sanitize",
      "Tools:Sanitize",
      "clear recent history",
      "b",
      "clear_history",
      "all",
      "P",
    ],
    [
      "ctrl+q",
      "key_quitApplication",
      "cmd_quitApplication",
      "quit (asks first)",
      "b",
      "quit",
      "all",
      "V",
    ],
    [
      "ctrl+shift+t",
      "key_restoreLastClosedTabOrWindowOrSession",
      "History:RestoreLastClosedTabOrWindowOrSession",
      "reopen the closed tab",
      "a",
      "restore_tab",
      "all",
      "P",
    ],
    [
      "ctrl+shift+n",
      "key_undoCloseWindow",
      "History:UndoCloseWindow",
      "reopen the closed window",
      "b",
      "restore_window",
      "all",
      "P",
    ],
    .../** @type {const} */ ([1, 2, 3, 4, 5, 6, 7, 8]).map(
      (n) =>
        /** @type {[string, string, string, string, string, string, string, string]} */ ([
          `alt+${n}`,
          `key_selectTab${n}`,
          "",
          `tab ${n}`,
          "a",
          `select_tab_${n}`,
          "all",
          "P",
        ]),
    ),
    ["alt+9", "key_selectLastTab", "", "last tab", "b", "select_last_tab", "all", "P"],
    // Conditional keys: only in some builds or settings.
    [
      "ctrl+alt+r",
      "key_quickRestart",
      "",
      "restart (developer builds)",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+#",
      "key_wrCaptureCmd",
      "wrCaptureCmd",
      "WebRender capture",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+^",
      "key_wrToggleCaptureSequenceCmd",
      "wrToggleCaptureSequenceCmd",
      "WebRender capture sequence",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+$",
      "key_windowRecordingCmd",
      "windowRecordingCmd",
      "window recording (Nightly)",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
  ]),
  ...rowsOf("devtools", [
    ["ctrl+shift+i", "key_toggleToolbox", "", "toggle the toolbox", "b", "devtools", "all", "P"],
    ["f12", "key_toggleToolboxF12", "", "toggle the toolbox", "b", "devtools", "all", "P"],
    [
      "ctrl+alt+shift+i",
      "key_browserToolbox",
      "",
      "Browser Toolbox",
      "b",
      "browser_toolbox",
      "all",
      "P",
    ],
    [
      "ctrl+shift+j",
      "key_browserConsole",
      "",
      "Browser Console",
      "b",
      "browser_console",
      "all",
      "P",
    ],
    [
      "ctrl+shift+m",
      "key_responsiveDesignMode",
      "",
      "Responsive Design Mode",
      "b",
      "responsive_design",
      "all",
      "P",
    ],
    ["ctrl+shift+c", "key_inspector", "", "Inspector", "b", "devtools_inspector", "all", "P"],
    ["ctrl+shift+k", "key_webconsole", "", "Web Console", "b", "devtools_console", "all", "P"],
    [
      "ctrl+shift+z",
      "key_jsdebugger",
      "",
      "Debugger (redo in a field)",
      "b",
      "devtools_debugger",
      "all",
      "P",
    ],
    ["ctrl+shift+e", "key_netmonitor", "", "Network", "b", "devtools_network", "all", "P"],
    ["shift+f7", "key_styleeditor", "", "Style Editor", "b", "devtools_style_editor", "all", "P"],
    ["shift+f5", "key_performance", "", "Performance", "b", "devtools_performance", "all", "P"],
    ["shift+f9", "key_storage", "", "Storage", "b", "devtools_storage", "all", "P"],
    // Firefox's reserved close-window key wins on this chord, so devtools_dom has no default key.
    [
      "ctrl+shift+w",
      "key_dom",
      "",
      "DOM panel (close window wins)",
      "b",
      "devtools_dom",
      "all",
      "P",
      { unbound: true },
    ],
    [
      "shift+f12",
      "key_accessibility",
      "",
      "Accessibility panel",
      "b",
      "devtools_accessibility",
      "all",
      "P",
    ],
    [
      "ctrl+!",
      "key_profilerStartStop",
      "",
      "start or stop the profiler",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+@",
      "key_profilerCapture",
      "",
      "capture a profile",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+alt+!",
      "key_profilerStartStopAlternate",
      "",
      "start or stop the profiler",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+alt+@",
      "key_profilerCaptureAlternate",
      "",
      "capture a profile",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
    [
      "ctrl+%",
      "key_javascriptTracingToggle",
      "",
      "JavaScript tracer",
      "c",
      null,
      null,
      null,
      { conditional: true },
    ],
  ]),
  ...rowsOf("chrome", [
    [
      "ctrl+tab",
      "browser-ctrlTab.js",
      "",
      "next tab (or the recent-tabs panel)",
      "a",
      "next_tab",
      "all",
      "V",
    ],
    ["ctrl+pagedown", "tabbox.js", "", "next tab", "a", "next_tab", "all", "V"],
    ["ctrl+pageup", "tabbox.js", "", "previous tab", "a", "previous_tab", "all", "V"],
    [
      "ctrl+shift+pagedown",
      "Tabbrowser",
      "",
      "move the tab right",
      "b",
      "move_tab_right",
      "all",
      "V",
    ],
    ["ctrl+shift+pageup", "Tabbrowser", "", "move the tab left", "b", "move_tab_left", "all", "V"],
    ["ctrl+f4", "Tabbrowser", "", "close the tab", "a", "close_tab", "all", "V"],
    ["f7", "Tabbrowser", "", "caret browsing (asks first)", "b", "caret_browsing", "all", "P"],
    // ShortcutUtils.getSystemActionForEvent rejects only shift on F7, so ctrl, alt and meta
    // toggle caret browsing too; Vimma binds F7 alone.
    ...["ctrl", "alt", "ctrl+alt", "meta", "ctrl+meta", "alt+meta", "ctrl+alt+meta"].map(
      (m) =>
        /** @type {[string, string, string, string, string]} */ ([
          `${m}+f7`,
          "Tabbrowser",
          "",
          "caret browsing (asks first)",
          "c",
        ]),
    ),
  ]),
  ...rowsOf(
    "menubar",
    [..."fevsbth"].map((letter) => [`alt+${letter}`, "#main-menubar", "", "open a menu", "d"]),
  ),
  ...rowsOf("menubar", [
    [
      "alt+p",
      "#profiles-menu",
      "",
      "open the Profiles menu",
      "d",
      null,
      null,
      null,
      { conditional: true },
    ],
  ]),
  ...rowsOf("page", [
    ["'", "FindBarChild", "", "quick find, links only", "c"],
    ["/", "FindBarChild", "", "quick find", "a", "find_forward", "normal", "V"],
  ]),
  ...rowsOf("platform", [
    ["f10", "MenuBarListener", "", "the menu bar", "d"],
    ["shift+f10", "widget", "", "the context menu", "d"],
    ["f6", "EventStateManager", "", "focus: address bar and page", "d"],
    ["shift+f6", "EventStateManager", "", "focus: address bar and page", "d"],
    ["tab", "EventStateManager", "", "move focus", "d"],
    ["shift+tab", "EventStateManager", "", "move focus", "d"],
  ]),
  ...rowsOf("field", [
    ["alt+enter", "UrlbarInput", "", "address bar: open in a new tab", "d"],
    ["ctrl+enter", "UrlbarInput", "", "address bar: complete .com", "d"],
    ["shift+enter", "UrlbarInput", "", "address bar: complete .net", "d"],
    ["alt+up", "UrlbarController", "", "address bar: search engines", "d"],
    ["alt+down", "UrlbarController", "", "address bar: search engines", "d"],
    ["f4", "UrlbarController", "", "address bar: open the results", "d"],
    ["shift+delete", "UrlbarController", "", "address bar: delete a suggestion", "d"],
    ["enter", "findbar", "", "find bar: next match", "d"],
    ["ctrl+left", "editor", "", "text editing and page scrolling", "d"],
  ]),
]);

/**
 * How a Linux row reads on macOS: its chord there (a string), a row replaced in full (an object
 * with `chord` and what else differs), or null when the key does not exist on macOS. A Linux
 * row without an entry is the same on macOS. Rows are named by their `<key>` id; an unnamed key
 * and a handler's row by its Linux chord.
 * @typedef {string | null | (Partial<FirefoxShortcut> & { chord: string })} MacChange
 */

/**
 * Firefox 158's macOS differences (en-US; engine paths, checked against 158.0):
 * browser/base/content/browser-sets.inc.xhtml `#mainKeyset` (accel is cmd, and the `XP_MACOSX`
 * branches), devtools/startup/DevToolsStartup.sys.mjs:90-262 (`accel,alt` for the toolbox
 * keys), browser-development-helpers.js:24-36, dom/xul/MenuBarListener.cpp:207 (F10 is not a
 * menu key on macOS), modules/libpref/init/StaticPrefList.yaml `ui.key.menuAccessKey` (0 on
 * macOS: no menu access keys), UrlbarChildController.mjs:779 (cmd+enter completes .com) and
 * widget/cocoa/NativeKeyBindings.mm:586-591 (alt+left moves by word).
 * @type {Record<string, MacChange>}
 */
const MAC_CHANGES = {
  key_newNavigator: "meta+n",
  key_newNavigatorTab: "meta+t",
  focusURLBar: "meta+l",
  focusURLBar2: null,
  key_search: "meta+k",
  // XP_MACOSX: accel,alt with find-shortcut's F.
  key_search2: "alt+meta+f",
  // downloads-shortcut is J outside Linux, and accel without shift outside XP_GNOME.
  key_openDownloads: "meta+j",
  key_openAddons: "shift+meta+a",
  openFileKb: "meta+o",
  key_savePage: "meta+s",
  printKb: "meta+p",
  key_close: "meta+w",
  key_closeWindow: "shift+meta+w",
  key_undo: "meta+z",
  key_redo: "shift+meta+z",
  key_cut: "meta+x",
  key_copy: "meta+c",
  key_paste: "meta+v",
  key_selectAll: "meta+a",
  goBackKb: "meta+left",
  goForwardKb: "meta+right",
  goBackKb2: "meta+[",
  goForwardKb2: "meta+]",
  showAllHistoryKb: "meta+y",
  key_reload_skip_cache2: null,
  key_enterFullScreen: "ctrl+meta+f",
  key_exitFullScreen: "ctrl+meta+f",
  key_toggleReaderMode: "alt+meta+r",
  key_togglePictureInPicture: "alt+meta+}",
  "ctrl+}": "alt+meta+}",
  key_reload: "meta+r",
  key_reload_skip_cache: "shift+meta+r",
  key_viewSource: "meta+u",
  key_viewInfo: "meta+i",
  key_find: "meta+f",
  key_findAgain: "meta+g",
  key_findPrevious: "shift+meta+g",
  addBookmarkAsKb: "meta+d",
  bookmarkAllTabsKb: "shift+meta+d",
  manBookmarkKb: "shift+meta+o",
  viewBookmarksSidebarKb: "meta+b",
  viewBookmarksToolbarKb: "shift+meta+b",
  // The three sidebar keys are control+<letter> on macOS.
  viewGenaiChatSidebarKb: "ctrl+x",
  // ctrl+u is Vimma's half-page scroll, as on Linux (key_viewSource's chord there).
  viewOpenTabsSidebarKb: {
    chord: "ctrl+u",
    fate: "a",
    action: "scroll_half_up",
    modes: "normal",
    first: "V",
  },
  toggleSidebarKb: "ctrl+z",
  key_gotoHistory: "shift+meta+h",
  key_fullZoomReduce: "meta+minus",
  "ctrl+_": "meta+_",
  key_fullZoomEnlarge: "meta+plus",
  "ctrl+=": "meta+=",
  key_fullZoomReset: "meta+0",
  key_switchTextDirection: "shift+meta+x",
  key_privatebrowsing: "shift+meta+p",
  key_screenshot: "shift+meta+s",
  key_sanitize: "shift+meta+delete",
  // `internal` on macOS: Cocoa's application menu quits, so the key is never Vimma's to turn off
  // (docs/specs/macos-build.md behaviour 4).
  key_quitApplication: { chord: "meta+q", fate: "d", does: "quit (macOS's own key)" },
  key_restoreLastClosedTabOrWindowOrSession: "shift+meta+t",
  key_undoCloseWindow: "shift+meta+n",
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`key_selectTab${n}`, `meta+${n}`])),
  key_selectLastTab: "meta+9",
  key_quickRestart: "alt+meta+r",
  key_toggleToolbox: "alt+meta+i",
  key_browserToolbox: "alt+shift+meta+i",
  key_browserConsole: "shift+meta+j",
  key_responsiveDesignMode: "alt+meta+m",
  key_inspector: "alt+meta+c",
  key_webconsole: "alt+meta+k",
  key_jsdebugger: { chord: "alt+meta+z", does: "Debugger" },
  key_netmonitor: "alt+meta+e",
  key_dom: { chord: "alt+meta+w", does: "DOM panel" },
  // ShortcutUtils.getSystemActionForEvent: ctrl+F4 closes a tab everywhere but macOS.
  "ctrl+f4": null,
  "alt+f": null,
  "alt+e": null,
  "alt+v": null,
  "alt+s": null,
  "alt+b": null,
  "alt+t": null,
  "alt+h": null,
  "alt+p": null,
  f10: null,
  "ctrl+enter": "meta+enter",
  "ctrl+left": "alt+left",
};

/**
 * The rows only macOS has, by source (the files of MAC_CHANGES).
 * @type {Partial<Record<FirefoxShortcut["source"], FirefoxShortcut[]>>}
 */
const MAC_ONLY = {
  main: rowsOf("main", [
    [
      "shift+meta+f",
      "key_enterFullScreen_old",
      "View:FullScreen",
      "full screen (the old key)",
      "c",
    ],
    [
      "f11",
      "key_enterFullScreen_compat",
      "View:FullScreen",
      "full screen",
      "b",
      "toggle_fullscreen",
      "all",
      "P",
    ],
    [
      "shift+meta+f",
      "key_exitFullScreen_old",
      "View:FullScreen",
      "leave full screen (the old key)",
      "c",
      null,
      null,
      null,
      { when: "fullscreen" },
    ],
    [
      "f11",
      "key_exitFullScreen_compat",
      "View:FullScreen",
      "leave full screen",
      "b",
      "toggle_fullscreen",
      "all",
      "V",
      { when: "fullscreen" },
    ],
    ["alt+meta+u", "key_viewSourceSafari", "View:PageSource", "view source (Safari's key)", "c"],
    ["meta+e", "key_findSelection", "cmd_findSelection", "find the selection", "c"],
    ["meta+.", "key_stop_mac", "Browser:Stop", "stop loading", "c"],
    ["shift+meta+backspace", "key_sanitize_mac", "Tools:Sanitize", "clear recent history", "c"],
    ["meta+m", "key_minimizeWindow", "cmd_minimizeWindow", "minimize (macOS's own key)", "d"],
    ["meta+,", "key_preferencesCmdMac", "", "settings (the application menu)", "d"],
    ["meta+h", "key_hideThisAppCmdMac", "", "hide Vimma (the application menu)", "d"],
    ["alt+meta+h", "key_hideOtherAppsCmdMac", "", "hide the others (the application menu)", "d"],
  ]),
  devtools: rowsOf("devtools", [["shift+meta+c", "key_inspectorMac", "", "Inspector", "c"]]),
  // ShortcutUtils.getSystemActionForEvent (toolkit/modules/ShortcutUtils.sys.mjs:380-445):
  // cmd+alt+arrow in tabbox.js, cmd+{ and cmd+} in Tabbrowser's keypress handler, which reads
  // the charCode and ignores ctrl, so ctrl+cmd+{ and ctrl+cmd+} switch tabs too.
  chrome: rowsOf("chrome", [
    ["alt+meta+left", "tabbox.js", "", "previous tab", "c"],
    ["alt+meta+up", "tabbox.js", "", "previous tab", "c"],
    ["alt+meta+right", "tabbox.js", "", "next tab", "c"],
    ["alt+meta+down", "tabbox.js", "", "next tab", "c"],
    ["meta+{", "Tabbrowser", "", "previous tab", "c"],
    ["meta+}", "Tabbrowser", "", "next tab", "c"],
    ["ctrl+meta+{", "Tabbrowser", "", "previous tab", "c"],
    ["ctrl+meta+}", "Tabbrowser", "", "next tab", "c"],
  ]),
};

/**
 * A Linux row as macOS has it. A key that moves to a chord Vimma does not bind is unbound and
 * off there (fate c), since Vimma's keymap is the same on both; a fate d key stays d.
 * @param {FirefoxShortcut} row
 * @returns {FirefoxShortcut | null}
 */
function macRow(row) {
  const name = (row.source === "main" || row.source === "devtools") && row.id ? row.id : row.chord;
  const change = MAC_CHANGES[name];
  if (change === undefined) return row;
  if (change === null) return null;
  // A moved key loses the Linux row's binding: the keymap binds the Linux chord, not this one.
  /** @type {Partial<FirefoxShortcut>} */
  const rest = { ...row };
  for (const k of /** @type {const} */ (["action", "modes", "first", "unbound"])) delete rest[k];
  /** @type {Partial<FirefoxShortcut>} */
  const mac =
    typeof change === "object"
      ? { ...rest, fate: "c", ...change }
      : { ...rest, chord: change, fate: row.fate === "d" ? "d" : "c" };
  return /** @type {FirefoxShortcut} */ (Object.freeze(mac));
}

/**
 * Every key that does something in a macOS browser window (Firefox 158, en-US), with its fate:
 * the Linux inventory with macOS's chords (MAC_CHANGES) and macOS's own keys (MAC_ONLY), in the
 * same order. The host reads it on macOS for what "all" turns off and which out-of-keyset
 * handlers it stops; Vimma's keymap, pageFirst and bindings.md stay on FIREFOX_SHORTCUTS.
 * @type {readonly FirefoxShortcut[]}
 */
export const FIREFOX_SHORTCUTS_MACOS = Object.freeze(
  (() => {
    /** @type {FirefoxShortcut[]} */
    const rows = [];
    /** @type {FirefoxShortcut["source"] | null} */
    let source = null;
    const done = new Set();
    const flush = () => {
      if (source && !done.has(source)) rows.push(...(MAC_ONLY[source] ?? []));
      done.add(source);
    };
    for (const row of FIREFOX_SHORTCUTS) {
      if (row.source !== source) {
        flush();
        source = row.source;
      }
      const mac = macRow(row);
      if (mac) rows.push(mac);
    }
    flush();
    return rows;
  })(),
);

/**
 * The inventory of the platform Vimma runs on.
 * @param {{ mac?: boolean }} [options]
 * @returns {readonly FirefoxShortcut[]}
 */
export function firefoxShortcuts({ mac = false } = {}) {
  return mac ? FIREFOX_SHORTCUTS_MACOS : FIREFOX_SHORTCUTS;
}

/**
 * Whether the page has `chord` before Vimma (docs/specs/firefox-keys.md decision 6): Firefox let
 * the page override it (P in the inventory). Firefox's reserved keys, its tab keys and Vimma's
 * own keys (V), and any chord outside the inventory, are Vimma's first. As in Firefox, the
 * fullscreen Keyboard Lock gives the page every key of the inventory but the one that leaves
 * full screen.
 * @param {string} chord  canonical
 * A row Vimma binds in normal mode only counts there: Esc stops a load after the page in normal
 * mode, but leaves insert mode at once.
 * @param {{ fullScreen?: boolean, keyboardLock?: boolean, mode?: string }} [state]  the window
 *   is in full screen (F11 is reserved then); a page holds the fullscreen Keyboard Lock; the
 *   mode the key is dispatched in (normal by default)
 */
export function pageFirst(
  chord,
  { fullScreen = false, keyboardLock = false, mode = "normal" } = {},
) {
  const rows = FIREFOX_SHORTCUTS.filter(
    (r) =>
      r.chord === chord &&
      r.first &&
      (!r.when || fullScreen) &&
      (r.modes !== "normal" || mode === "normal"),
  );
  if (rows.length === 0) return false;
  if (keyboardLock) return !rows.some((r) => r.action === "toggle_fullscreen");
  return rows.every((r) => r.first === "P");
}

/**
 * The chords Vimma binds, as the first key of a binding in any mode: Firefox's keys on them are
 * off (docs/specs/firefox-keys.md decision 2, "bound means off").
 * @param {{ sequences: (mode: import("./modes.mjs").Mode) => { seq: string }[] }} keymap
 * @returns {Set<string>}
 */
export function boundChords(keymap) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const mode of MODES) {
    for (const { seq } of keymap.sequences(mode))
      out.add(/** @type {string} */ (seq.split(" ")[0]));
  }
  return out;
}

/** XUL `keycode` names (nsIDOMKeyEvent DOM_VK_*) → our named keys. */
/** @type {Record<string, string>} */
const KEYCODES = {
  VK_ESCAPE: "esc",
  VK_RETURN: "enter",
  VK_TAB: "tab",
  VK_SPACE: "space",
  VK_BACK: "backspace",
  VK_DELETE: "delete",
  VK_UP: "up",
  VK_DOWN: "down",
  VK_LEFT: "left",
  VK_RIGHT: "right",
  VK_HOME: "home",
  VK_END: "end",
  VK_PAGE_UP: "pageup",
  VK_PAGE_DOWN: "pagedown",
  VK_INSERT: "insert",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`VK_F${i + 1}`, `f${i + 1}`])),
};

/**
 * A US keyboard's shifted digits and symbols, as Firefox's en-US keys assume.
 * @type {Record<string, string>}
 */
const US_SHIFTED = Object.fromEntries(
  [..."1234567890-=[]\\;',./`"].map((k, i) => [k, [...'!@#$%^&*()_+{}|:"<>?~'][i] ?? k]),
);

/**
 * The chord a `<key>` element answers to, from its own attributes, or null when it has none
 * yet (Fluent fills `key` in after load) or none we can name.
 * @param {{ key?: string | null, keycode?: string | null, modifiers?: string | null }} el
 * @param {{ mac?: boolean }} [options]  `accel` is cmd (meta) on macOS, else ctrl
 * @returns {string | null}
 */
export function xulKeyChord(el, { mac = false } = {}) {
  /** @type {Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>} */
  const mods = {};
  for (const m of (el.modifiers ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (m === "accel") mods[mac ? "meta" : "ctrl"] = true;
    else if (m === "control") mods.ctrl = true;
    else if (m === "alt") mods.alt = true;
    else if (m === "shift") mods.shift = true;
    else if (m === "meta" || m === "os") mods.meta = true;
  }
  let key = null;
  if (el.key && [...el.key].length === 1) key = el.key.toLowerCase();
  // GlobalKeyListener matches a shifted key by the character the keyboard types (a US layout
  // gives `}` for shift+`]`), and Vimma's notation folds shift into that character.
  if (key && mods.shift && key in US_SHIFTED) {
    key = US_SHIFTED[key];
    delete mods.shift;
  } else if (!el.key && el.keycode) key = KEYCODES[el.keycode] ?? null;
  if (!key) return null;
  return makeChordText(key, mods);
}

/**
 * Per platform: the chords "all" turns off although they have no ctrl, alt or meta (`f5`, `esc`,
 * `shift+esc`), and the chords that stay Firefox's or the field's (fate d), whatever "all" says.
 * @param {readonly FirefoxShortcut[]} rows
 */
const fates = (rows) => ({
  inventoryOff: new Set(rows.filter((r) => r.fate !== "d").map((r) => r.chord)),
  fateD: new Set(rows.filter((r) => r.fate === "d").map((r) => r.chord)),
});
const FATES = { linux: fates(FIREFOX_SHORTCUTS), mac: fates(FIREFOX_SHORTCUTS_MACOS) };

/** @param {string} chord canonical */
const isModified = (chord) => {
  const c = /** @type {Chord} */ (parseKey(chord));
  return c.ctrl || c.alt || c.meta;
};

/**
 * Whether a chord can name a Firefox shortcut: it has ctrl, alt or meta, or is a function key.
 * @param {Chord} c
 */
export function isShortcutChord(c) {
  return c.ctrl || c.alt || c.meta || /^f\d+$/.test(c.key);
}

/**
 * The canonical text of a chord as written in `[firefox]` (`control+W` → `ctrl+shift+w`).
 * @param {string} text
 * @returns {string}
 * @throws {import("./keys.mjs").KeyNotationError}
 */
export function canonicalChord(text) {
  return formatKey(parseKey(text));
}

/**
 * @template {{ chord: string | null, internal?: boolean }} K
 * @typedef {{ off: K[], unmatched: string[] }} FirefoxKeyPlan
 */

/**
 * Which keys to turn off. `disable = "all"`: every inventory key but fate d, plain and function
 * keys included, and any other key with ctrl, alt or meta (decision 9; ctrl+q is Vimma's `quit`);
 * a list: the keys with those chords. `enable` keeps its chords on either way. A key Firefox
 * runs elsewhere (`internal`: copy, paste, undo) or without a chord yet is never touched.
 * `unmatched`: chords of a `disable` list that no key has (ctrl+e on Linux), for about:vimma.
 * `bound`: the chords Vimma binds (boundChords), off whatever `disable` says unless `enable`
 * lists them (docs/specs/firefox-keys.md decision 2). `mac`: the fates are macOS's inventory's
 * (FIREFOX_SHORTCUTS_MACOS), so "all" keeps cmd+q there.
 * @template {{ chord: string | null, internal?: boolean }} K
 * @param {readonly K[]} keys  in document order
 * @param {{ disable: "all" | readonly string[], enable: readonly string[] }} setting  canonical
 * @param {{ bound?: ReadonlySet<string>, mac?: boolean }} [options]
 * @returns {FirefoxKeyPlan<K>}
 */
export function planFirefoxKeys(keys, setting, { bound = new Set(), mac = false } = {}) {
  const { inventoryOff, fateD } = mac ? FATES.mac : FATES.linux;
  const enable = new Set(setting.enable);
  const all = setting.disable === "all";
  const listed = new Set(all ? [] : setting.disable);
  const off = keys.filter((k) => {
    if (!k.chord || k.internal || enable.has(k.chord)) return false;
    if (bound.has(k.chord)) return true;
    if (!all) return listed.has(k.chord);
    return !fateD.has(k.chord) && (isModified(k.chord) || inventoryOff.has(k.chord));
  });
  const matched = new Set(
    off
      .filter(
        (k) =>
          !bound.has(/** @type {string} */ (k.chord)) ||
          listed.has(/** @type {string} */ (k.chord)),
      )
      .map((k) => k.chord),
  );
  const unmatched = [...listed].filter((c) => !matched.has(c) && !enable.has(c));
  return { off, unmatched };
}
