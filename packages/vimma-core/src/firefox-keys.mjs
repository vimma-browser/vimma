/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Firefox's own shortcuts (docs/specs/key-handling-batch.md § 1, docs/specs/firefox-keys.md):
 * every key Firefox handles in a Linux browser window (FIREFOX_SHORTCUTS), which `<key>`
 * elements of the window's keysets Vimma turns off, and who goes first on a chord, the page or
 * Vimma. The host reads each element's chord with xulKeyChord and disables what
 * planFirefoxKeys returns.
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

/** Chords "all" turns off although they have no ctrl, alt or meta (`f5`, `esc`, `shift+esc`). */
const INVENTORY_OFF = new Set(FIREFOX_SHORTCUTS.filter((r) => r.fate !== "d").map((r) => r.chord));
/** Chords that stay Firefox's or the field's (fate d), whatever "all" says. */
const FATE_D = new Set(FIREFOX_SHORTCUTS.filter((r) => r.fate === "d").map((r) => r.chord));

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
 * lists them (docs/specs/firefox-keys.md decision 2).
 * @template {{ chord: string | null, internal?: boolean }} K
 * @param {readonly K[]} keys  in document order
 * @param {{ disable: "all" | readonly string[], enable: readonly string[] }} setting  canonical
 * @param {{ bound?: ReadonlySet<string> }} [options]
 * @returns {FirefoxKeyPlan<K>}
 */
export function planFirefoxKeys(keys, setting, { bound = new Set() } = {}) {
  const enable = new Set(setting.enable);
  const all = setting.disable === "all";
  const listed = new Set(all ? [] : setting.disable);
  const off = keys.filter((k) => {
    if (!k.chord || k.internal || enable.has(k.chord)) return false;
    if (bound.has(k.chord)) return true;
    if (!all) return listed.has(k.chord);
    return !FATE_D.has(k.chord) && (isModified(k.chord) || INVENTORY_OFF.has(k.chord));
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
