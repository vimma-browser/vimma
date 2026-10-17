/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's own features as Vimma actions (spec: docs/specs/firefox-keys.md decision 4). Each
// runs exactly what Firefox's key ran: the key's <command> (`doCommand()`), or, for a key with
// no <command> (`goHome`, the DevTools keys), a command event on the key element itself, which
// is what GlobalKeyListener sends. Page commands act on the selected tab, which is the focused
// pane's.

/** @import { Action } from "../core/dispatcher.mjs" */

/** Action id → the `<command>` id Firefox's key runs. */
export const BROWSER_COMMANDS = Object.freeze({
  "window.new": "cmd_newNavigator",
  "window.close": "cmd_closeWindow",
  "window.restore": "History:UndoCloseWindow",
  "page.reload_hard": "Browser:ReloadSkipCache",
  "page.stop": "Browser:Stop",
  "page.zoom_in": "cmd_fullZoomEnlarge",
  "page.zoom_out": "cmd_fullZoomReduce",
  "page.zoom_reset": "cmd_fullZoomReset",
  // Leaves DOM full screen too, as key_exitFullScreen (the same command) does.
  "window.fullscreen": "View:FullScreen",
  "page.save": "Browser:SavePage",
  "page.print": "cmd_print",
  "browser.downloads": "Tools:Downloads",
  "browser.addons": "Tools:Addons",
  "browser.history": "Browser:ShowAllHistory",
  "browser.bookmarks": "Browser:ShowAllBookmarks",
  "tab.mute": "cmd_toggleMute",
  "page.picture_in_picture": "View:PictureInPicture",
  "page.reader_view": "View:ReaderView",
  "page.screenshot": "Browser:Screenshot",
  "browser.clear_history": "Tools:Sanitize",
  "browser.search": "Tools:Search",
  "browser.processes": "View:AboutProcesses",
  "browser.text_direction": "cmd_switchTextDirection",
});

/** Action id → the `<key>` id whose own command listener Firefox's key runs. */
export const BROWSER_KEYS = Object.freeze({
  "page.home": "goHome",
  "devtools.toggle": "key_toggleToolbox",
  "devtools.browser_toolbox": "key_browserToolbox",
  "devtools.browser_console": "key_browserConsole",
  "devtools.responsive_design": "key_responsiveDesignMode",
  "devtools.inspector": "key_inspector",
  "devtools.console": "key_webconsole",
  "devtools.debugger": "key_jsdebugger",
  "devtools.network": "key_netmonitor",
  "devtools.style_editor": "key_styleeditor",
  "devtools.performance": "key_performance",
  "devtools.storage": "key_storage",
  "devtools.accessibility": "key_accessibility",
  "devtools.dom": "key_dom",
  // No <command>: browser-sets.js handles these by the key's id.
  "browser.bookmark_all_tabs": "bookmarkAllTabsKb",
  "browser.bookmarks_toolbar": "viewBookmarksToolbarKb",
  "browser.sidebar_chatbot": "viewGenaiChatSidebarKb",
  "browser.sidebar_tabs": "viewOpenTabsSidebarKb",
  "browser.sidebar": "toggleSidebarKb",
});

/** What a DevTools action says when the window has no DevTools keys (a policy turned them off). */
export const NO_DEVTOOLS = "Developer tools are off in this browser";

/**
 * Runs the window's `<command>` `id` as Firefox's key would: nothing when it is disabled
 * (Reader View on a page that has none, Stop with nothing loading).
 * @param {Window} win
 * @param {string} id
 * @returns {boolean} whether it ran
 */
export function runCommand(win, id) {
  const el = /** @type {any} */ (win.document.getElementById(id));
  if (!el || el.getAttribute("disabled") === "true") return false;
  el.doCommand();
  return true;
}

/**
 * Sends the `<key>` `id` the command event its listener runs on, as GlobalKeyListener does. The
 * key is usually one Vimma turned off (bound means off): it is on for this one dispatch.
 * @param {Window} win
 * @param {string} id
 * @returns {boolean} false when the window has no such key
 */
export function runKey(win, id) {
  const el = /** @type {any} */ (win.document.getElementById(id));
  if (!el) return false;
  const disabled = el.getAttribute("disabled");
  if (disabled !== null) el.removeAttribute("disabled");
  try {
    el.doCommand();
  } finally {
    if (disabled !== null) el.setAttribute("disabled", disabled);
  }
  return true;
}

/**
 * Firefox's quit (ctrl+q): `goQuitApplication` with an event whose shortcut modifier is down,
 * so Firefox counts it as the shortcut and asks first (`browser.warnOnQuitShortcut`).
 * @param {Window} win
 */
export function quit(win) {
  /** @type {any} */ (win).goQuitApplication({ ctrlKey: true, metaKey: true });
}

/** Prompts in flight per window: a second F7 while one is open does nothing, as in Firefox. */
const caretPrompts = new WeakSet();

/**
 * Firefox's F7. Its handler is the private Tabbrowser#toggleCaretBrowsing
 * (browser/components/tabbrowser/Tabbrowser.sys.mjs:9197, Firefox 157), which no command or key
 * reaches, so this repeats its steps: the shortcut pref, the same confirmation, then the toggle.
 * @param {Window} win
 */
export function toggleCaretBrowsing(win) {
  const SHORTCUT = "accessibility.browsewithcaret_shortcut.enabled";
  const WARN = "accessibility.warn_on_browsewithcaret";
  const ON = "accessibility.browsewithcaret";
  const { Services } = /** @type {any} */ (globalThis);
  if (!Services.prefs.getBoolPref(SHORTCUT, true) || caretPrompts.has(win)) return;
  const on = Services.prefs.getBoolPref(ON, false);
  if (Services.prefs.getBoolPref(WARN, true) && !on) {
    const check = { value: false };
    const prompt = Services.prompt;
    let pressed;
    try {
      caretPrompts.add(win);
      const [title, message, checkbox] = /** @type {any} */ (
        win
      ).gBrowser.tabLocalization.formatValuesSync([
        "tabbrowser-confirm-caretbrowsing-title",
        "tabbrowser-confirm-caretbrowsing-message",
        "tabbrowser-confirm-caretbrowsing-checkbox",
      ]);
      pressed = prompt.confirmEx(
        win,
        title,
        message,
        prompt.STD_YES_NO_BUTTONS | prompt.BUTTON_POS_1_DEFAULT,
        null,
        null,
        null,
        checkbox,
        check,
      );
    } catch {
      return;
    } finally {
      caretPrompts.delete(win);
    }
    if (pressed !== 0) {
      if (check.value) Services.prefs.setBoolPref(SHORTCUT, false);
      return;
    }
    if (check.value) Services.prefs.setBoolPref(WARN, false);
  }
  Services.prefs.setBoolPref(ON, !on);
}

/**
 * Firefox's ctrl+shift+pageup / pagedown: moves the selected tab past the next visible one
 * (another workspace's hidden tabs are skipped), as Tabbrowser's keydown handler does.
 * @param {Window} win
 * @param {"left" | "right"} way
 */
export function moveTab(win, way) {
  const gBrowser = /** @type {any} */ (win).gBrowser;
  const metricsContext = gBrowser.TabMetrics.userTriggeredContext(
    gBrowser.TabMetrics.METRIC_SOURCE.KEYBOARD,
  );
  if (way === "left") gBrowser.moveTabBackward({ metricsContext });
  else gBrowser.moveTabForward({ metricsContext });
}

/**
 * The runners for the Browser and Developer tools actions, keyed by action id.
 * @param {(win: Window, text: string) => void} say  shows a notice
 * @returns {Record<string, (s: { win: Window }, a: Action) => void>}
 */
export function browserRunners(say) {
  /** @type {Record<string, (s: { win: Window }, a: Action) => void>} */
  const out = {};
  for (const [action, command] of Object.entries(BROWSER_COMMANDS)) {
    out[action] = (s) => void runCommand(s.win, command);
  }
  for (const [action, key] of Object.entries(BROWSER_KEYS)) {
    out[action] = (s) => {
      if (!runKey(s.win, key) && action.startsWith("devtools.")) say(s.win, NO_DEVTOOLS);
    };
  }
  out["app.quit"] = (s) => quit(s.win);
  out["browser.caret_browsing"] = (s) => toggleCaretBrowsing(s.win);
  out["tab.move_left"] = (s) => moveTab(s.win, "left");
  out["tab.move_right"] = (s) => moveTab(s.win, "right");
  return out;
}
