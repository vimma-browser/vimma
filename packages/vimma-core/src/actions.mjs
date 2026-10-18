/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The closed set of actions. Single source of truth for the dispatcher, config validation,
 * `prefix+?`, the `:` completion list and docs/bindings.md (`npm run gen-docs`).
 *
 * `name` is the config name used in `[keys]` (Herdr style, snake_case); `id` is the dotted
 * identifier the host executes and that `[modal.*]` tables may use. Several names can share an
 * `id` with different `arg`s (select_tab_1..9 → tab.goto with arg 1..9).
 */

/**
 * @typedef {object} ActionDef
 * @property {string} name
 * @property {string} id
 * @property {string} group
 * @property {string} description
 * @property {number} [arg]
 * @property {readonly string[]} [aliases]
 * @property {boolean} [takesChar]  the key after it is its character (`f x`), not a binding
 * @property {string} [line]  a `:` binding's command line (docs/specs/firefox-keys.md decision 5)
 */

/** @type {ActionDef[]} */
const defs = [];

/**
 * @param {string} group
 * @param {Array<[name: string, id: string, description: string, extra?: Partial<ActionDef>]>} rows
 */
function group(group, rows) {
  for (const [name, id, description, extra] of rows) {
    defs.push(Object.freeze({ name, id, group, description, ...extra }));
  }
}

/**
 * @param {string} name
 * @param {string} id
 * @param {(n: number) => string} describe
 * @returns {Array<[string, string, string, Partial<ActionDef>]>}
 */
function numbered(name, id, describe) {
  return Array.from({ length: 9 }, (_, i) => [
    `${name}_${i + 1}`,
    id,
    describe(i + 1),
    { arg: i + 1 },
  ]);
}

group("Help", [
  ["show_keybinds", "help.show", "Show all bindings (filter with /)"],
  ["help_close", "help.close", "Close the bindings overlay"],
  ["help_filter", "help.filter", "Filter the bindings overlay"],
]);

group("Tabs", [
  ["new_tab", "tab.new", "New tab"],
  ["next_tab", "tab.next", "Next tab (with a count: go to tab N)"],
  ["previous_tab", "tab.previous", "Previous tab"],
  ...numbered("select_tab", "tab.goto", (n) => `Jump to tab ${n} in this workspace`),
  ["rename_tab", "tab.rename", "Rename tab"],
  ["close_tab", "tab.close", "Close tab"],
  // docs/specs/firefox-keys.md decision 3: Firefox's tab keys, by name.
  ["select_last_tab", "tab.goto_last", "Jump to the last tab in this workspace"],
  ["move_tab_left", "tab.move_left", "Move the tab left"],
  ["move_tab_right", "tab.move_right", "Move the tab right"],
  ["restore_tab", "tab.restore", "Reopen the last closed tab"],
]);

group("Panes", [
  ["split_vertical", "pane.split_vertical", "Split right"],
  ["split_horizontal", "pane.split_horizontal", "Split down"],
  ["focus_pane_left", "pane.focus_left", "Focus pane to the left"],
  ["focus_pane_down", "pane.focus_down", "Focus pane below"],
  ["focus_pane_up", "pane.focus_up", "Focus pane above"],
  ["focus_pane_right", "pane.focus_right", "Focus pane to the right"],
  ["swap_pane_left", "pane.swap_left", "Swap with pane to the left"],
  ["swap_pane_down", "pane.swap_down", "Swap with pane below"],
  ["swap_pane_up", "pane.swap_up", "Swap with pane above"],
  ["swap_pane_right", "pane.swap_right", "Swap with pane to the right"],
  ["zoom", "pane.zoom", "Zoom pane"],
  ["close_pane", "pane.close", "Close pane; the last pane closes the tab"],
  ["resize_mode", "pane.resize_mode", "Resize mode"],
  ["resize_exit", "pane.resize_exit", "Leave resize mode"],
  ["resize_narrower", "pane.resize_narrower", "Make pane narrower"],
  ["resize_wider", "pane.resize_wider", "Make pane wider"],
  ["resize_taller", "pane.resize_taller", "Make pane taller"],
  ["resize_shorter", "pane.resize_shorter", "Make pane shorter"],
  // docs/specs/tiling-layouts.md
  ["new_pane", "pane.new", "New pane, along the longer side"],
  ["next_layout", "pane.next_layout", "Next layout"],
  ["select_layout", "pane.select_layout", "Apply a layout preset by name (:layout name)"],
  ["layout_even_horizontal", "pane.layout_even_horizontal", "Layout: all side by side"],
  ["layout_even_vertical", "pane.layout_even_vertical", "Layout: all stacked"],
  ["layout_main_vertical", "pane.layout_main_vertical", "Layout: main pane left, rest stacked"],
  ["layout_main_horizontal", "pane.layout_main_horizontal", "Layout: main pane on top, rest below"],
  ["layout_tiled", "pane.layout_tiled", "Layout: a grid"],
  ["layout_dwindle", "pane.layout_dwindle", "Layout: a spiral (dwindle)"],
]);

group("Workspaces", [
  ["next_workspace", "workspace.next", "Next workspace"],
  [
    "previous_workspace",
    "workspace.previous",
    "Previous workspace",
    { aliases: ["prev_workspace"] },
  ],
  [
    "last_workspace",
    "workspace.last",
    "Previous workspace you were in; again toggles back (Vim's ctrl+^)",
  ],
  ["switch_workspace", "workspace.switch", "Switch to a workspace by name or number"],
  ["workspace_picker", "workspace.picker", "Workspace picker"],
  ["new_workspace", "workspace.new", "New workspace"],
  ["rename_workspace", "workspace.rename", "Rename workspace"],
  ["close_workspace", "workspace.close", "Close workspace"],
  [
    "move_to_workspace",
    "workspace.move_tab",
    "Move the tab to another workspace (reopens it there)",
  ],
  [
    "route_rules",
    "workspace.route",
    "Routing rules: list them; :route add [workspace], :route move",
  ],
  // docs/specs/private-workspace.md: Firefox's private window, as a workspace.
  [
    "private_workspace",
    "workspace.private",
    "Private workspace (a private window); again goes back",
  ],
]);

group("Navigation", [
  // docs/specs/tab-search.md: the goto picker is tab search.
  ["goto_picker", "goto.picker", "Tab search: every tab, every window, recently closed"],
  ["toggle_sidebar", "sidebar.toggle", "Open / close the side panel"],
  // docs/specs/toolbar-toggle.md: Firefox's navigation toolbar, in every window.
  ["toggle_toolbar", "toolbar.toggle", "Show / hide the toolbar (URL bar and add-on buttons)"],
  ["show_toolbar", "toolbar.show", "Show the toolbar"],
  ["hide_toolbar", "toolbar.hide", "Hide the toolbar (the address bar shows when focused)"],
  ["scroll_down", "scroll.down", "Scroll down"],
  ["scroll_up", "scroll.up", "Scroll up"],
  ["scroll_left", "scroll.left", "Scroll left"],
  ["scroll_right", "scroll.right", "Scroll right"],
  ["scroll_half_down", "scroll.half_down", "Scroll half a page down"],
  ["scroll_half_up", "scroll.half_up", "Scroll half a page up"],
  ["scroll_top", "scroll.top", "Scroll to top"],
  ["scroll_bottom", "scroll.bottom", "Scroll to bottom"],
  ["history_back", "history.back", "Go back"],
  ["history_forward", "history.forward", "Go forward"],
  ["reload", "page.reload", "Reload page"],
  ["open_url", "page.open", "Open a URL or search in this tab"],
  ["url_up", "page.url_up", "Go up a level in the URL path"],
  ["url_root", "page.url_root", "Go to the site's root"],
  ["focus_urlbar", "urlbar.focus", "Focus the address bar, its text selected"],
]);

group("Page", [
  ["yank_url", "page.yank_url", "Copy the page's URL"],
  ["open_clipboard", "page.open_clipboard", "Open the clipboard's URL or search in this tab"],
  [
    "open_clipboard_tab",
    "page.open_clipboard_new_tab",
    "Open the clipboard's URL or search in a new tab",
  ],
  ["focus_input", "page.focus_input", "Focus the first text field (with a count: the Nth)"],
  ["view_source", "page.view_source", "View the page's source in a new tab"],
]);

// docs/specs/firefox-keys.md decision 3: Firefox's own features on Firefox's keys, each running
// what Firefox's key ran (host/browser-ops.mjs).
group("Browser", [
  ["new_window", "window.new", "New window"],
  ["close_window", "window.close", "Close the window"],
  ["restore_window", "window.restore", "Reopen the last closed window"],
  ["quit", "app.quit", "Quit (asks first)"],
  // docs/specs/m6a-updater.md: no default key; :update.
  ["check_updates", "app.update_check", "Check for a newer Vimma"],
  ["reload_hard", "page.reload_hard", "Reload, bypassing the cache"],
  ["stop_loading", "page.stop", "Stop loading the page"],
  ["firefox_command", "firefox.command", "Run a Firefox command or key by its id (:firefox)"],
  ["go_home", "page.home", "Go to the home page"],
  ["page_zoom_in", "page.zoom_in", "Zoom the page in"],
  ["page_zoom_out", "page.zoom_out", "Zoom the page out"],
  ["page_zoom_reset", "page.zoom_reset", "Reset the page's zoom"],
  ["toggle_fullscreen", "window.fullscreen", "Full screen, or leave it"],
  ["save_page", "page.save", "Save the page"],
  ["print_page", "page.print", "Print the page"],
  ["downloads", "browser.downloads", "Downloads (the Library)"],
  ["addons_manager", "browser.addons", "Add-ons manager (about:addons)"],
  ["history_library", "browser.history", "History (the Library)"],
  ["bookmarks_library", "browser.bookmarks", "Bookmarks (the Library)"],
  ["mute_tab", "tab.mute", "Mute or unmute the tab"],
  ["picture_in_picture", "page.picture_in_picture", "Picture-in-Picture"],
  ["reader_view", "page.reader_view", "Reader View"],
  ["screenshot", "page.screenshot", "Take a screenshot"],
  ["clear_history", "browser.clear_history", "Clear recent history"],
  // docs/specs/firefox-keys.md decision 16: the rest of Firefox's keys, on Firefox's chords.
  ["web_search", "browser.search", "Web search (the address bar's search)"],
  ["about_processes", "browser.processes", "Process manager (about:processes)"],
  ["bookmark_all_tabs", "browser.bookmark_all_tabs", "Bookmark all tabs"],
  ["toggle_bookmarks_toolbar", "browser.bookmarks_toolbar", "Show / hide the bookmarks toolbar"],
  ["ai_chatbot_sidebar", "browser.sidebar_chatbot", "Firefox sidebar: AI chatbot"],
  ["open_tabs_sidebar", "browser.sidebar_tabs", "Firefox sidebar: tabs from other devices"],
  ["toggle_firefox_sidebar", "browser.sidebar", "Show / hide Firefox's sidebar"],
  ["switch_text_direction", "browser.text_direction", "Switch a text field's direction"],
  ["caret_browsing", "browser.caret_browsing", "Caret browsing (asks first)"],
]);

// The DevTools keys, exactly as in Firefox (docs/specs/firefox-keys.md, open question 5).
group("Developer tools", [
  ["devtools", "devtools.toggle", "Open / close the developer tools"],
  ["browser_toolbox", "devtools.browser_toolbox", "Browser Toolbox"],
  ["browser_console", "devtools.browser_console", "Browser Console"],
  ["responsive_design", "devtools.responsive_design", "Responsive Design Mode"],
  ["devtools_inspector", "devtools.inspector", "Developer tools: Inspector"],
  ["devtools_console", "devtools.console", "Developer tools: Web Console"],
  ["devtools_debugger", "devtools.debugger", "Developer tools: Debugger"],
  ["devtools_network", "devtools.network", "Developer tools: Network"],
  ["devtools_style_editor", "devtools.style_editor", "Developer tools: Style Editor"],
  ["devtools_performance", "devtools.performance", "Developer tools: Performance"],
  ["devtools_storage", "devtools.storage", "Developer tools: Storage"],
  ["devtools_accessibility", "devtools.accessibility", "Developer tools: Accessibility"],
  ["devtools_dom", "devtools.dom", "Developer tools: DOM"],
]);

group("Hints", [
  ["follow_link", "hint.follow", "Follow link"],
  ["follow_link_new_tab", "hint.follow_new_tab", "Follow link in new tab"],
  ["hint_cancel", "hint.cancel", "Leave hint mode"],
]);

group("Find", [
  ["find_forward", "find.forward", "Search in page"],
  ["find_backward", "find.backward", "Search backwards in page"],
  ["find_next", "find.next", "Next match"],
  ["find_previous", "find.previous", "Previous match"],
  // docs/specs/live-grep.md: the text of every tab in the workspace, as Telescope's live_grep.
  ["live_grep", "grep.open", "Live grep: search the text of the workspace's tabs"],
  ["grep_next", "grep.next", "Next result of the last live grep"],
  ["grep_previous", "grep.previous", "Previous result of the last live grep"],
  ["grep_resume", "grep.resume", "Live grep again with the last query (:grep)"],
]);

group("Modes", [
  ["normal_mode", "mode.normal", "Back to normal mode"],
  ["insert_mode", "mode.insert", "Insert mode: focus the last-used input"],
  ["copy_mode", "mode.visual", "Copy mode (caret browsing + selection)"],
  ["command_line", "command.open", "Command line"],
  ["command_cancel", "command.cancel", "Close the command line"],
]);

group("Copy mode", [
  ["caret_left", "caret.left", "Move caret left"],
  ["caret_down", "caret.down", "Move caret down"],
  ["caret_up", "caret.up", "Move caret up"],
  ["caret_right", "caret.right", "Move caret right"],
  ["caret_word_forward", "caret.word_forward", "Move caret a word forward"],
  ["caret_word_backward", "caret.word_backward", "Move caret a word back"],
  ["caret_line_start", "caret.line_start", "Move caret to the start of the line"],
  ["caret_line_end", "caret.line_end", "Move caret to the end of the line"],
  ["caret_top", "caret.top", "Move caret to the top of the page"],
  ["caret_bottom", "caret.bottom", "Move caret to the bottom of the page"],
  ["caret_word_end", "caret.word_end", "Move caret to the end of the word"],
  ["caret_prev_word_end", "caret.word_end_backward", "Move caret to the previous word's end"],
  ["caret_bigword_next", "caret.bigword_forward", "Move caret to the next WORD (by spaces)"],
  ["caret_bigword_back", "caret.bigword_backward", "Move caret to the WORD's start"],
  ["caret_bigword_end", "caret.bigword_end", "Move caret to the end of the WORD"],
  ["caret_first_char", "caret.first_nonblank", "Move caret to the line's first non-blank"],
  ["caret_para_back", "caret.paragraph_backward", "Move caret to the paragraph's start"],
  ["caret_para_next", "caret.paragraph_forward", "Move caret to the paragraph's end"],
  [
    "caret_find_forward",
    "caret.find_forward",
    "Find a character forward on the line",
    { takesChar: true },
  ],
  [
    "caret_find_backward",
    "caret.find_backward",
    "Find a character backward on the line",
    { takesChar: true },
  ],
  [
    "caret_till_forward",
    "caret.till_forward",
    "Till a character forward on the line",
    { takesChar: true },
  ],
  [
    "caret_till_backward",
    "caret.till_backward",
    "Till a character backward on the line",
    { takesChar: true },
  ],
  ["caret_find_repeat", "caret.find_repeat", "Repeat the last f, F, t or T"],
  ["caret_find_reverse", "caret.find_repeat_reverse", "Repeat the last find, reversed"],
  ["toggle_selection", "selection.toggle", "Start or drop a selection at the caret"],
  ["line_selection", "selection.line", "Start or drop a line-wise selection"],
  ["swap_selection_ends", "selection.swap", "Swap the selection's ends"],
  ["select_inner_word", "selection.inner_word", "Select the word at the caret"],
  ["select_a_word", "selection.a_word", "Select the word at the caret and its spaces"],
  ["yank_selection", "selection.yank", "Copy selection and leave copy mode"],
  ["yank_lines", "selection.yank_lines", "Copy the selection's whole lines and leave"],
]);

group("Side panel", [
  ...numbered("panel_select", "panel.select", (n) => `Select row ${n}`),
  ["panel_down", "panel.down", "Next row"],
  ["panel_up", "panel.up", "Previous row"],
  [
    "panel_open",
    "panel.open",
    "Apply the marks (the marked tabs become the panes), then go to the selected row",
  ],
  [
    "panel_close",
    "panel.close",
    "End the range, clear or restore the marks, or close the side panel",
  ],
  ["panel_close_tab", "panel.close_tab", "Close the selected tab; the panel stays open"],
  ["panel_mark", "panel.mark", "Mark or unmark the selected tab"],
  ["panel_visual", "panel.visual", "Start a range of rows to mark, or mark it"],
]);

group("Bookmarks", [
  ["toggle_bookmarks", "bookmarks.toggle", "Open / close the bookmarks panel"],
  ["add_bookmark", "bookmark.add", "Bookmark this page (folders/title files it in folders)"],
  ["bookmarks_collapse", "bookmarks.collapse", "Bookmarks: close the folder, or go to its parent"],
  ["bookmarks_expand", "bookmarks.expand", "Bookmarks: open the folder or the bookmark"],
  ["bookmarks_open_tab", "bookmarks.open_tab", "Bookmarks: open in a new background tab"],
  ["bookmarks_vsplit", "bookmarks.open_vsplit", "Bookmarks: open in a split right"],
  ["bookmarks_hsplit", "bookmarks.open_hsplit", "Bookmarks: open in a split below"],
  ["bookmarks_add", "bookmarks.add", "Bookmarks: add this page here (a/b/ makes folders)"],
  ["bookmarks_folder", "bookmarks.add_folder", "Bookmarks: add a folder here"],
  ["bookmarks_rename", "bookmarks.rename", "Bookmarks: rename"],
  ["bookmarks_move", "bookmarks.move", "Bookmarks: move to a folder"],
  ["bookmarks_delete", "bookmarks.delete", "Bookmarks: delete (asks y/N)"],
  ["bookmarks_yank", "bookmarks.yank", "Bookmarks: copy the URL"],
  ["bookmarks_filter", "bookmarks.filter", "Bookmarks: filter"],
]);

group("Config", [
  ["reload_config", "config.reload", "Reload config"],
  ["edit_config", "config.edit", "Open config.toml in a tab"],
  // docs/specs/theme-appearance.md: no default key; `:theme dark|light|system`.
  ["theme_appearance", "theme.appearance", "Built-in theme: dark, light or the system's (:theme)"],
]);

// docs/specs/addon-manager.md
// docs/specs/vimma-mcp.md: local AI agents, confined to the agent workspace. `:mcp on|off|forget`;
// prefix+shift+a answers the waiting question (decision 14); `:control on <minutes>` (29 D).
group("Agents", [
  ["mcp_command", "mcp.command", "Agents (MCP): :mcp on, off or forget"],
  ["agent_prompt", "mcp.answer", "Answer the waiting agent request (none: revoke grants)"],
  ["control_command", "control.command", "Full control for a while: :control on <minutes>, off"],
]);

group("Add-ons", [
  ["addon_picker", "addons.picker", "Add-on picker: popup, options, on/off, remove, update"],
  ["addon_popup", "addons.popup", "Open an add-on's popup by name (:addon name)"],
]);

/** @type {readonly ActionDef[]} */
export const ACTIONS = Object.freeze(defs);

/** @type {Map<string, ActionDef>} */
const byName = new Map();
/** @type {Map<string, ActionDef[]>} */
const byId = new Map();
for (const a of ACTIONS) {
  byName.set(a.name, a);
  for (const alias of a.aliases ?? []) byName.set(alias, a);
  byId.set(a.id, [...(byId.get(a.id) ?? []), a]);
}

/**
 * The one rule for greying out actions the host has not built yet, used by the bindings overlay.
 * Without a set (undefined) every action counts as runnable.
 * @param {string} id action id
 * @param {ReadonlySet<string>} [runnable] ids the host implements
 */
export function isRunnable(id, runnable) {
  return runnable ? runnable.has(id) : true;
}

/**
 * Look up by config name (or alias).
 * @param {string} name
 * @returns {ActionDef | undefined}
 */
export function getAction(name) {
  return byName.get(name);
}

/**
 * Resolve a config value: a config name, an alias, or a dotted id that names exactly one action.
 * @param {string} text
 * @returns {ActionDef | undefined}
 */
export function resolveActionName(text) {
  const named = byName.get(text);
  if (named) return named;
  const ids = byId.get(text);
  return ids && ids.length === 1 ? ids[0] : undefined;
}

/**
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  /** @type {number[]} */
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        /** @type {number} */ (prev[j]) + 1,
        /** @type {number} */ (cur[j - 1]) + 1,
        /** @type {number} */ (prev[j - 1]) + cost,
      );
    }
    prev = cur;
  }
  return /** @type {number} */ (prev[b.length]);
}

/**
 * Closest valid action spelling, in the same style (dotted id vs config name) as the input.
 * @param {string} text
 * @returns {string | undefined}
 */
export function suggestAction(text) {
  return closest(text, text.includes(".") ? [...byId.keys()] : [...byName.keys()]);
}

/**
 * The candidate nearest to `text` by edit distance, if it is near enough to be a likely typo.
 * The length difference is a lower bound on the distance, so a candidate it rules out is never
 * measured: a text far longer than every candidate (a megabyte of hostile config) costs one
 * comparison per candidate, not a text-by-candidate table (#196).
 * @param {string} text
 * @param {Iterable<string>} pool
 * @returns {string | undefined}
 */
export function closest(text, pool) {
  const near = Math.max(2, Math.floor(text.length / 3));
  let best;
  let bestD = Infinity;
  for (const cand of pool) {
    const gap = Math.abs(text.length - cand.length);
    if (gap > near || gap >= bestD) continue;
    const d = editDistance(text, cand);
    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }
  return bestD <= near ? best : undefined;
}

/**
 * The human label of a dispatched action: the description of the action with its id and arg,
 * else the id itself.
 * @param {{ id: string, arg?: number }} action
 * @returns {string}
 */
export function describeAction(action) {
  const def = byId.get(action.id)?.find((a) => a.arg === action.arg);
  return def?.description ?? action.id;
}

/**
 * What the host shows for a bound action it cannot run yet (spec: docs/specs/m2-tab-keys.md).
 * @param {{ id: string, arg?: number }} action
 * @returns {string}
 */
export function notImplementedText(action) {
  return `${describeAction(action)}: not implemented yet`;
}
