/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Default configuration, as the object a TOML parser would produce from defaults.toml.
 * packages/vimma-core/defaults.toml is generated from this (npm run gen-docs).
 */

import { DEFAULT_HINT_CHARS } from "../page/hints.mjs";
import { PANES_MAX_DEFAULT, PANES_MAX_LIMIT } from "../panes/panes.mjs";
import { MAX_SPLITS_DEFAULT, MAX_SPLITS_LIMIT } from "../panes/splits.mjs";
import { MAIN_SIZE_DEFAULT } from "../panes/layouts.mjs";
import { DEFAULT_THEME_NAME } from "./theme.mjs";
import { SCROLL_STEP_DEFAULT, SCROLL_STEP_MAX, SCROLL_STEP_MIN } from "../page/scroll.mjs";
import { SLEEP_AFTER } from "../workspaces/tabsleep.mjs";

/** @typedef {"off" | "always" | "auto"} TabLineSetting */

/** `[ui] tabline`'s words (docs/specs/tab-line.md decision 3). */
export const TABLINE_SETTINGS = Object.freeze(
  /** @type {TabLineSetting[]} */ (["off", "always", "auto"]),
);

/** `[ui] tabline_width`, the columns of one tab's name (docs/specs/tab-line.md decision 4). */
export const TABLINE_WIDTH = Object.freeze({ min: 4, max: 60, default: 14 });

/**
 * @typedef {object} UserConfig
 * @property {Record<string, string | string[]>} [keys]
 * @property {{ leader?: string, timeout_ms?: number } & Record<string, unknown>} [modal]
 * @property {Record<string, string[]>} [unbind]
 * @property {unknown} [schema]  ignored: older files carry it (spec m5-core-config-and-theme)
 * @property {Record<string, WorkspaceInput>} [workspaces]
 * @property {ThemeInput} [theme]
 * @property {{ max?: number, max_splits?: number, layout?: "dwindle" | "manual",
 *   main_size?: number, new_tab?: "alone" | "pane" }} [panes]
 * @property {Record<string, { insert?: import("../keys/editable.mjs").InsertSiteMode,
 *   unbind?: string[], sleep?: boolean }>} [sites]  per-site insert mode, keys the page keeps
 *   (docs/specs/site-unbind.md) and whether its tabs may sleep (docs/specs/tab-sleep.md)
 * @property {{ sleep_after?: number, sleep_on_low_memory?: boolean }} [tabs]  minutes a tab
 *   stays loaded unseen, and whether Firefox unloads tabs when memory runs low
 *   (docs/specs/tab-sleep.md)
 * @property {Record<string, string>[]} [routes]  `[[routes]]` (workspace-routing)
 * @property {{ default_workspace?: string }} [routing]  where links from other programs that no
 *   rule matches open (docs/specs/app-routes.md)
 * @property {{ disable?: "all" | readonly string[], enable?: readonly string[] }} [firefox]
 *   Firefox's own shortcuts that are off (docs/specs/key-handling-batch.md)
 * @property {{ root?: "workspace" | "toolbar" | "all", bookmarklets?: "none" | "user" | "agent",
 *   write_back?: "all" | "vimma" | "none" }}
 *   [bookmarks]  the bookmarks panel's root (docs/specs/bookmarks.md) and who may run
 *   bookmarklets (docs/specs/bookmarklets.md)
 * @property {{ numbers?: "absolute" | "relative" | "hybrid" }} [panel]  the side panel's and
 *   bookmarks panel's row numbers (docs/specs/side-panel-counts.md)
 * @property {{ step?: number }} [scroll]  how far j, k, h and l scroll, in CSS pixels
 *   (docs/specs/m1-actor-insert-scroll.md, "Follow-up: scroll step")
 * @property {{ placement?: "swap" | "window" }} [private]  where the private workspace is shown
 *   (docs/specs/private-swap.md)
 * @property {{ check?: boolean }} [updates]  update checks (docs/specs/m6a-updater.md)
 * @property {{ toolbar?: "shown" | "hidden",
 *   bookmarks_toolbar?: import("../ui/bookmarks-toolbar.mjs").BookmarksToolbarSetting,
 *   pdf_outline?: "shown" | "hidden", tabline?: TabLineSetting,
 *   tabline_width?: number }} [ui]
 *   Firefox's toolbar at startup (docs/specs/toolbar-toggle.md), its Bookmarks Toolbar
 *   (docs/specs/bookmarks-toolbar-hidden.md) and Vimma's outline beside a PDF
 *   (docs/specs/pdf-mode.md decision 19), and the tab line (docs/specs/tab-line.md)
 * @property {{ tab?: boolean }} [statusbar]  whether the status bar keeps its tab and title while
 *   the tab line is drawn (docs/specs/tab-line.md decision 16)
 * @property {{ enabled?: boolean, workspace?: string, ask_timeout?: number,
 *   grant_minutes?: number, grant_max_minutes?: number, max_read_chars?: number,
 *   notify?: boolean, download_dir?: string, download_max_mb?: number,
 *   clamav_max_age_days?: number }} [mcp]  AI agents and the agent workspace (docs/specs/vimma-mcp.md)
 * @property {{ default?: string, aliases?: Record<string, string> }} [search]  the default
 *   search engine and `@alias` keywords (docs/specs/search-engines.md)
 * @property {Record<string, unknown>} [agent]  the built-in agent (docs/specs/builtin-agent.md),
 *   checked field by field by config.mjs before it is resolved
 */

/**
 * @typedef {object} WorkspaceInput
 * @property {string} [color]
 * @property {string} [icon]
 * @property {string} [home]
 * @property {boolean} [autofill]
 */

/**
 * @typedef {object} ThemeInput
 * @property {"omarchy" | "file"} [source]
 * @property {string} [name]   the built-in palette: "vimma"
 * @property {"system" | "dark" | "light"} [appearance]  the built-in palette's variant
 * @property {string} [font]
 * @property {Record<string, string>} [colors]
 */

/**
 * Herdr's default keymap (https://herdr.dev/docs/keyboard/), plus vimma's own global chords and
 * Firefox's own keys as Vimma bindings (docs/specs/firefox-keys.md: the inventory's a and b rows
 * in FIREFOX_SHORTCUTS, which a test keeps in step with this table).
 */
const keys = {
  prefix: "ctrl+b",
  show_keybinds: ["prefix+?"],
  new_tab: ["prefix+c", "ctrl+t"],
  next_tab: ["prefix+n", "ctrl+tab", "ctrl+pagedown"],
  previous_tab: ["prefix+p", "ctrl+shift+tab", "ctrl+pageup"],
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `select_tab_${i + 1}`,
      // Firefox's alt+1..8 (Linux); its alt+9 is the last tab.
      i < 8 ? [`prefix+${i + 1}`, `alt+${i + 1}`] : [`prefix+${i + 1}`],
    ]),
  ),
  rename_tab: ["prefix+shift+t"],
  close_tab: ["prefix+shift+x", "ctrl+f4"],
  select_last_tab: ["alt+9"],
  move_tab_left: ["ctrl+shift+pageup"],
  move_tab_right: ["ctrl+shift+pagedown"],
  restore_tab: ["ctrl+shift+t"],
  split_vertical: ["prefix+v"],
  split_horizontal: ["prefix+minus"],
  focus_pane_left: ["prefix+h"],
  focus_pane_down: ["prefix+j"],
  focus_pane_up: ["prefix+k"],
  focus_pane_right: ["prefix+l"],
  swap_pane_left: ["prefix+shift+h"],
  swap_pane_down: ["prefix+shift+j"],
  swap_pane_up: ["prefix+shift+k"],
  swap_pane_right: ["prefix+shift+l"],
  zoom: ["prefix+z"],
  close_pane: ["prefix+x"],
  resize_mode: ["prefix+r"],
  // docs/specs/tiling-layouts.md: tmux's split-window on enter, next-layout on space.
  new_pane: ["prefix+enter"],
  next_layout: ["prefix+space"],
  // docs/specs/multiple-splits.md decision 13: S for splits, next to w for workspaces.
  split_picker: ["prefix+shift+s"],
  next_workspace: ["prefix+)"],
  previous_workspace: ["prefix+("],
  // tmux's last session; prefix+ctrl+6 for layouts where ^ is a dead key (Finnish, German).
  last_workspace: ["prefix+^", "prefix+ctrl+6"],
  workspace_picker: ["prefix+w"],
  new_workspace: ["prefix+shift+n"],
  rename_workspace: ["prefix+shift+w"],
  close_workspace: ["prefix+shift+d"],
  // docs/specs/private-workspace.md: ctrl+shift+p is Firefox's "New Private Window", done
  // Vimma's way (go to the one private workspace, or open it).
  private_workspace: ["prefix+shift+p", "ctrl+shift+p"],
  goto_picker: ["prefix+g", "ctrl+shift+a"],
  // docs/specs/live-grep.md decision 2: prefix+f is the find group, Telescope's <leader>fg.
  live_grep: ["prefix+f g"],
  toggle_sidebar: ["prefix+b"],
  // docs/specs/toolbar-toggle.md: u for URL bar; tmux leaves it free.
  toggle_toolbar: ["prefix+u"],
  history_back: ["alt+left"],
  history_forward: ["alt+right"],
  reload: ["f5", "ctrl+r"],
  focus_urlbar: ["ctrl+l", "alt+d"],
  find_next: ["ctrl+g", "f3"],
  find_previous: ["ctrl+shift+g", "shift+f3"],
  // docs/specs/page-suggestions.md decision 7: next to prefix+c (new tab); ctrl+n is insert
  // mode's suggestion key, and a window opened while typing is disruptive.
  new_window: ["prefix+shift+c"],
  close_window: ["ctrl+shift+w"],
  restore_window: ["ctrl+shift+n"],
  quit: ["ctrl+q"],
  reload_hard: ["ctrl+f5", "ctrl+shift+r"],
  go_home: ["alt+home"],
  page_zoom_in: ["ctrl+plus", "ctrl+="],
  page_zoom_out: ["ctrl+minus", "ctrl+_"],
  page_zoom_reset: ["ctrl+0"],
  toggle_fullscreen: ["f11"],
  save_page: ["ctrl+s"],
  print_page: ["ctrl+p"],
  downloads: ["ctrl+shift+y"],
  addons_manager: ["ctrl+shift+f"],
  history_library: ["ctrl+shift+h"],
  bookmarks_library: ["ctrl+shift+o"],
  mute_tab: ["ctrl+m"],
  picture_in_picture: ["ctrl+}"],
  reader_view: ["ctrl+alt+r"],
  screenshot: ["ctrl+shift+s"],
  clear_history: ["ctrl+shift+delete"],
  web_search: ["ctrl+j"],
  about_processes: ["shift+esc"],
  bookmark_all_tabs: ["ctrl+shift+d"],
  toggle_bookmarks_toolbar: ["ctrl+shift+b"],
  open_tabs_sidebar: ["ctrl+alt+u"],
  toggle_firefox_sidebar: ["ctrl+alt+z"],
  switch_text_direction: ["ctrl+shift+x"],
  caret_browsing: ["f7"],
  find_forward: ["ctrl+f"],
  devtools: ["ctrl+shift+i", "f12"],
  browser_toolbox: ["ctrl+alt+shift+i"],
  browser_console: ["ctrl+shift+j"],
  responsive_design: ["ctrl+shift+m"],
  devtools_inspector: ["ctrl+shift+c"],
  devtools_console: ["ctrl+shift+k"],
  devtools_debugger: ["ctrl+shift+z"],
  devtools_network: ["ctrl+shift+e"],
  devtools_style_editor: ["shift+f7"],
  devtools_performance: ["shift+f5"],
  devtools_storage: ["shift+f9"],
  devtools_accessibility: ["shift+f12"],
  toggle_bookmarks: ["prefix+shift+b"],
  add_bookmark: ["prefix+a"],
  agent_prompt: ["prefix+shift+a"],
  agent_chat: ["prefix+i"],
  copy_mode: ["prefix+["],
  addon_picker: ["prefix+e"],
  // docs/specs/downloads.md decision 2: the feature's initial, beside the other pickers.
  downloads_picker: ["prefix+d"],
};

/**
 * The default keys that differ on macOS (docs/specs/macos-build.md decision 29): Firefox's macOS
 * chords where Linux's are `alt` chords, since Option types characters on a Mac (Option+1 is
 * `¡`) or moves the caret by word (Option+left), so those keydowns never reach a binding.
 * engine/browser/base/content/browser-sets.inc.xhtml, Firefox 159: goBackKb / goForwardKb are
 * accel+arrow on XP_MACOSX (lines 228-231), goBackKb2 / goForwardKb2 accel+[ and accel+] on
 * XP_UNIX, macOS included (232-235), focusURLBar accel+L without the alt+D twin (146-151), and
 * key_selectTab1..8 / key_selectLastTab accel+1..9 outside XP_GNOME (382-396). goHome stays
 * alt+home (236): Option+Home types nothing. Every other key is Linux's on both.
 * @type {Readonly<Record<string, string[]>>}
 */
export const MAC_KEYS = Object.freeze({
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `select_tab_${i + 1}`,
      [`prefix+${i + 1}`, `meta+${i + 1}`],
    ]),
  ),
  select_last_tab: ["meta+9"],
  history_back: ["meta+left", "meta+["],
  history_forward: ["meta+right", "meta+]"],
  focus_urlbar: ["ctrl+l", "meta+l"],
});

/**
 * The default `[keys]` of a platform: Linux's, with MAC_KEYS on macOS.
 * @param {{ mac?: boolean }} [options]
 * @returns {Readonly<Record<string, string | string[]>>}
 */
export function defaultKeys({ mac = false } = {}) {
  return mac ? MAC_MERGED : keys;
}

/**
 * zathura's keys that the PDF viewer leaves to Vimma's meaning (docs/specs/pdf-mode.md decision
 * 21), as `[modal.pdf]` lines: config.toml shows them commented out, for those who want zathura's.
 * @type {Readonly<Record<string, string>>}
 */
export const ZATHURA_PDF_KEYS = Object.freeze({
  d: "pdf.dual_page",
  r: "pdf.rotate",
  H: "pdf.page_top",
  L: "pdf.page_bottom",
  P: "pdf.page_top",
  F: "hint.show_target",
  "<C-f>": "pdf.screen_down",
  "<F5>": "pdf.presentation",
});

const modal = {
  leader: " ",
  timeout_ms: 800,
  hint_chars: DEFAULT_HINT_CHARS,
  // ctrl+w, ctrl+u, ctrl+h edit text fields as in Vim's insert mode (key-handling-batch).
  insert_editing: true,
  normal: {
    j: "scroll.down",
    k: "scroll.up",
    h: "scroll.left",
    l: "scroll.right",
    d: "scroll.half_down",
    u: "scroll.half_up",
    "<C-d>": "scroll.half_down",
    "<C-u>": "scroll.half_up",
    "<C-e>": "scroll.down",
    "<C-y>": "scroll.up",
    gg: "scroll.top",
    G: "scroll.bottom",
    gs: "scroll.area_next",
    gS: "scroll.area_prev",
    H: "history.back",
    L: "history.forward",
    "<C-o>": "history.back",
    "<C-i>": "history.forward",
    // Firefox's Unix back / forward; in a text field they do nothing (firefox-keys Q2).
    "<C-[>": "history.back",
    "<C-]>": "history.forward",
    // Firefox's stop, after the page had Esc (firefox-keys decision 7): Esc still leaves insert
    // mode, closes dialogs and cancels a pending key first.
    "<Esc>": "page.stop",
    r: "page.reload",
    f: "hint.follow",
    // f follows links and F focuses text blocks; background-tab hints sit beside gf
    // (element-focus decision 2).
    F: "hint.element",
    gF: "hint.follow_new_tab",
    // docs/specs/hover.md decision 14: beside the other g keys, easier to type than ;h.
    gh: "hint.hover",
    "/": "find.forward",
    "?": "find.backward",
    n: "find.next",
    N: "find.previous",
    i: "mode.insert",
    I: "urlbar.focus",
    v: "mode.visual",
    ":": "command.open",
    t: "tab.new",
    x: "tab.close",
    gt: "tab.next",
    gT: "tab.previous",
    // docs/specs/tab-line.md decision 12: Vim's "go to buffer", beside gt.
    gb: "tabline.hint",
    b: "goto.picker",
    // Workspaces as Vim buffers: the alternate (ctrl+6 where ^ is a dead key), unimpaired's ]w.
    "<C-^>": "workspace.last",
    "<C-6>": "workspace.last",
    "]w": "workspace.next",
    "[w": "workspace.previous",
    // unimpaired's quickfix keys over the last live grep's results (live-grep decision 8).
    "]q": "grep.next",
    "[q": "grep.previous",
    // The workspace's splits, as ]w / [w step workspaces (multiple-splits decision 13).
    "]s": "pane.next_split",
    "[s": "pane.previous_split",
    yy: "page.yank_url",
    p: "page.open_clipboard",
    P: "page.open_clipboard_new_tab",
    gi: "page.focus_input",
    gu: "page.url_up",
    gU: "page.url_root",
    gf: "page.view_source",
    "<C-w>h": "pane.focus_left",
    "<C-w>j": "pane.focus_down",
    "<C-w>k": "pane.focus_up",
    "<C-w>l": "pane.focus_right",
    "<C-w>H": "pane.swap_left",
    "<C-w>J": "pane.swap_down",
    "<C-w>K": "pane.swap_up",
    "<C-w>L": "pane.swap_right",
    "<C-w>o": "pane.zoom",
    "<C-w><": "pane.resize_narrower",
    "<C-w>>": "pane.resize_wider",
    "<C-w>+": "pane.resize_taller",
    "<C-w>-": "pane.resize_shorter",
  },
  // docs/specs/pdf-mode.md: zathura's keys in the PDF viewer, only on the keys normal mode leaves
  // free (decision 21), so that every Vimma key does the same in a PDF as on a page. gg and G
  // still go to the top and the bottom; in a PDF their count is a page (decision 6). zathura's
  // d, r, H, L, P, F, ctrl+f and F5 are commands there, and ZATHURA_PDF_KEYS puts them back.
  pdf: {
    J: "pdf.next_page",
    K: "pdf.previous_page",
    gg: "pdf.first_page",
    G: "pdf.last_page",
    "+": "pdf.zoom_in",
    zi: "pdf.zoom_in",
    zI: "pdf.zoom_in",
    "-": "pdf.zoom_out",
    zo: "pdf.zoom_out",
    zO: "pdf.zoom_out",
    "=": "pdf.zoom_set",
    zz: "pdf.zoom_set",
    zZ: "pdf.zoom_set",
    z0: "pdf.zoom_set",
    a: "pdf.fit_page",
    s: "pdf.fit_width",
    D: "pdf.first_page_alone",
    w: "pdf.single_page",
    R: "page.reload",
    Y: "page.yank_url",
    // The outline panel (decision 10); shift+Tab still moves focus through pdf.js's toolbar.
    "<Tab>": "pdf.outline",
    // Marks (decision 11) and zathura's c, which copies a link's target (decision 16).
    m: "pdf.mark_set",
    "'": "pdf.mark_go",
    c: "hint.copy_target",
  },
  // Vim's insert-mode completion keys, in a page's suggestion list (page-suggestions), and
  // ctrl+j and ctrl+k beside them, the keys of most pickers' lists (issue #1261). Outside a list
  // ctrl+j stays the field's Enter and ctrl+k the page's.
  insert: {
    "<Esc>": "mode.normal",
    "<C-n>": "page.suggestion_next",
    "<C-p>": "page.suggestion_prev",
    "<C-j>": "page.suggestion_next",
    "<C-k>": "page.suggestion_prev",
  },
  visual: {
    "<Esc>": "mode.normal",
    h: "caret.left",
    j: "caret.down",
    k: "caret.up",
    l: "caret.right",
    w: "caret.word_forward",
    b: "caret.word_backward",
    0: "caret.line_start",
    $: "caret.line_end",
    gg: "caret.top",
    G: "caret.bottom",
    e: "caret.word_end",
    ge: "caret.word_end_backward",
    W: "caret.bigword_forward",
    B: "caret.bigword_backward",
    E: "caret.bigword_end",
    "^": "caret.first_nonblank",
    "{": "caret.paragraph_backward",
    "}": "caret.paragraph_forward",
    f: "caret.find_forward",
    F: "caret.find_backward",
    t: "caret.till_forward",
    T: "caret.till_backward",
    ";": "caret.find_repeat",
    ",": "caret.find_repeat_reverse",
    v: "selection.toggle",
    V: "selection.line",
    o: "selection.swap",
    iw: "selection.inner_word",
    aw: "selection.a_word",
    ip: "selection.inner_block",
    ap: "selection.a_block",
    y: "selection.yank",
    Y: "selection.yank_lines",
    I: "urlbar.focus",
  },
  command: { "<Esc>": "command.cancel" },
  hint: { "<Esc>": "hint.cancel" },
  // A focused text block (docs/specs/element-focus.md decision 7): v and V select it in copy
  // mode, y copies it, + and - grow and shrink the focus, j and k move it, F picks another.
  element: {
    "<Esc>": "mode.normal",
    v: "element.visual",
    V: "element.visual_line",
    y: "element.yank",
    "+": "element.parent",
    "-": "element.child",
    j: "element.next",
    k: "element.prev",
    F: "hint.element",
  },
  help: { "<Esc>": "help.close", "/": "help.filter", q: "help.close" },
  panel: {
    // A digit is a count (docs/specs/side-panel-counts.md decision 1): `4j`, `12G`, `4 Enter`.
    j: "panel.down",
    k: "panel.up",
    gg: "panel.first",
    G: "panel.last",
    "<C-d>": "panel.half_down",
    "<C-u>": "panel.half_up",
    "<CR>": "panel.open",
    "<Esc>": "panel.close",
    // The selected tab; the panel stays open on the next row (key-handling-batch). The bookmarks
    // panel shares the mode and ignores it (d deletes there).
    x: "panel.close_tab",
    // Marks for Enter to show together (m4-side-panel-multiselect), ranger's keys.
    "<Space>": "panel.mark",
    V: "panel.visual",
    // The row's tab to a workspace chosen in the workspace picker, as `m` there moves the
    // selected tab (m3-workspaces); in the bookmarks panel the bookmark to a folder.
    m: "panel.move",
    // The highlighted tab, or the marked ones, to sleep (docs/specs/tab-sleep.md decision 15):
    // it reads as "zzz". Nothing in the bookmarks panel.
    z: "panel.sleep",
    // Closes the panel, then focuses the address bar (as I does in normal mode).
    I: "urlbar.focus",
    // The bookmarks panel (docs/specs/bookmarks.md), neo-tree's keys; nothing in the tabs panel.
    h: "bookmarks.collapse",
    l: "bookmarks.expand",
    t: "bookmarks.open_tab",
    s: "bookmarks.open_vsplit",
    S: "bookmarks.open_hsplit",
    a: "bookmarks.add",
    A: "bookmarks.add_folder",
    r: "bookmarks.rename",
    d: "bookmarks.delete",
    y: "bookmarks.yank",
    "/": "bookmarks.filter",
  },
  // The PDF viewer's outline panel (docs/specs/pdf-mode.md decision 10): zathura's index keys,
  // and `/` for Vimma's filter, where the arrow keys move. No ctrl chord Vimma leaves to Firefox
  // elsewhere (ctrl+p, ctrl+j, ctrl+c): a chord bound in any mode turns Firefox's key off in every
  // tab (firefox-keys decision 2), and these would stop print and copy.
  index: {
    j: "index.down",
    "<Down>": "index.down",
    k: "index.up",
    "<Up>": "index.up",
    l: "index.expand",
    zo: "index.expand",
    h: "index.collapse",
    zc: "index.collapse",
    zO: "index.expand_subtree",
    zC: "index.collapse_subtree",
    L: "index.expand_all",
    zR: "index.expand_all",
    H: "index.collapse_all",
    zM: "index.collapse_all",
    gg: "index.first",
    G: "index.last",
    "<C-d>": "index.half_down",
    "<C-u>": "index.half_up",
    "<CR>": "index.follow",
    "<Space>": "index.follow",
    "<Tab>": "index.close",
    "<Esc>": "index.close",
    "<C-[>": "index.close",
    q: "index.close",
    "/": "index.filter",
  },
  // ctrl+b r (m4-split-panes sub-spec 5, ADR-014): each key moves the focused pane's divider a
  // step; a count repeats it (3l).
  resize: {
    h: "pane.resize_narrower",
    l: "pane.resize_wider",
    j: "pane.resize_taller",
    k: "pane.resize_shorter",
    "<Left>": "pane.resize_narrower",
    "<Right>": "pane.resize_wider",
    "<Down>": "pane.resize_taller",
    "<Up>": "pane.resize_shorter",
    "<lt>": "pane.resize_narrower",
    ">": "pane.resize_wider",
    "+": "pane.resize_taller",
    "-": "pane.resize_shorter",
    "<Esc>": "pane.resize_exit",
    "<CR>": "pane.resize_exit",
    q: "pane.resize_exit",
  },
};

/** keys with MAC_KEYS over it, in keys' order. */
const MAC_MERGED = Object.freeze({ ...keys, ...MAC_KEYS });

/** Values a `[workspaces.<name>]` table takes for keys it leaves out. */
export const WORKSPACE_DEFAULTS = Object.freeze({ color: "gray", icon: "circle", autofill: true });

const theme = {
  source: /** @type {const} */ ("omarchy"),
  name: DEFAULT_THEME_NAME,
  font: "monospace",
  colors: {},
};

/** @type {Readonly<UserConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  keys,
  modal,
  unbind: {},
  workspaces: {},
  theme,
  panes: {
    max: PANES_MAX_DEFAULT,
    max_splits: MAX_SPLITS_DEFAULT,
    layout: /** @type {const} */ ("dwindle"),
    main_size: MAIN_SIZE_DEFAULT * 100,
    new_tab: /** @type {const} */ ("alone"),
  },
  sites: {},
  firefox: { disable: /** @type {"all"} */ ("all"), enable: [] },
  bookmarks: {
    root: /** @type {const} */ ("workspace"),
    bookmarklets: /** @type {const} */ ("none"),
    write_back: /** @type {const} */ ("all"),
  },
  panel: { numbers: /** @type {const} */ ("absolute") },
  scroll: { step: SCROLL_STEP_DEFAULT },
  private: { placement: /** @type {const} */ ("swap") },
  ui: {
    // Hidden since 19 Nov 2026 (docs/specs/toolbar-toggle.md decision 3): the status bar carries
    // the site and its security cues (decision 12). branding's vimma.ui.toolbar.hidden agrees.
    toolbar: /** @type {const} */ ("hidden"),
    pdf_outline: /** @type {const} */ ("shown"),
    // "auto" since 20 Nov 2026 (docs/specs/tab-line.md decision 3): a lone tab's window keeps
    // its row, and a second tab shows the line. ui/tabline.mjs falls back to it too.
    tabline: /** @type {const} */ ("auto"),
    tabline_width: TABLINE_WIDTH.default,
  },
  statusbar: { tab: true },
  updates: { check: true },
  // docs/specs/vimma-mcp.md, decision 26. No `enabled`: left out, `:mcp on|off` decides.
  mcp: {
    workspace: "agent",
    ask_timeout: 50,
    grant_minutes: 0,
    grant_max_minutes: 480,
    max_read_chars: 200000,
    notify: true,
    download_dir: "~/Downloads/vimma-agent",
    download_max_mb: 200,
    clamav_max_age_days: 7,
  },
});

/** @param {string} s */
const tomlString = (s) => JSON.stringify(s);

/** @param {string} k */
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));

/** @param {unknown} v @returns {string} */
function tomlValue(v) {
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (typeof v === "string") return tomlString(v);
  return String(v);
}

/**
 * One line of the annotated file: a setting written as its default (`code`) with a note on what
 * it takes and what changing it does; a commented example (`example`) for a key with no default;
 * or a note alone (no `code`).
 * @typedef {{ code?: string, note?: string, example?: boolean }} RefLine
 */

/** formatConfigTemplate comments every setting out, so a line of this file may take 98 columns. */
const REF_WIDTH = 98;
/** Notes start here at the latest, so that one long value does not push a table's notes right. */
const NOTE_COLUMN_MAX = 32;

/**
 * `text` in lines of at most `width` characters, broken between words.
 * @param {string} text @param {number} width
 * @returns {string[]}
 */
function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line];
}

/**
 * Lines with their notes after the values, lined up, as people write a config file.
 * @param {RefLine[]} entries
 * @returns {string[]}
 */
function annotate(entries) {
  /** @param {RefLine} e */
  const code = (e) => (e.example ? `# ${e.code}` : `${e.code}`);
  // A setting counts 2 columns more: the template comments it out, and its note keeps its column.
  const widths = entries
    .filter((e) => e.code !== undefined && e.note)
    .map((e) => code(e).length + (e.example ? 0 : 2));
  const column = Math.min(NOTE_COLUMN_MAX, Math.max(0, ...widths) + 2);
  return entries.flatMap((e) => {
    if (e.code === undefined) return wrap(e.note ?? "", REF_WIDTH - 2).map((l) => `# ${l}`);
    if (!e.note) return [code(e)];
    const line = `${code(e).padEnd(Math.max(column, code(e).length + 2))}# ${e.note}`;
    // One short line per setting: a longer note is a mistake here, not something to wrap.
    if (line.length > REF_WIDTH)
      throw new Error(`defaults.toml: over ${REF_WIDTH} columns: ${line}`);
    return [line];
  });
}

/**
 * A setting at its default.
 * @param {string} key @param {unknown} value @param {string} note
 * @returns {RefLine}
 */
const set = (key, value, note) => ({ code: `${key} = ${tomlValue(value)}`, note });

/**
 * A commented example: a key without a default, or a table that is not there by default.
 * @param {string} code @param {string} [note]
 * @returns {RefLine}
 */
const example = (code, note) => ({ code, note, example: true });

/** @param {string} note @returns {RefLine} */
const say = (note) => ({ note });

/**
 * `[keys]` and `[modal]` with every default binding (`full`), or with one of each for the guide.
 * @param {boolean} full
 * @returns {{ keys: string[], modal: string[] }}
 */
function keymapLines(full) {
  const keyLines = [
    "[keys]",
    ...annotate([
      set("prefix", keys.prefix, "the tmux-style prefix: prefix+c means ctrl+b, then c"),
      full
        ? say("Each action's keys, in place of its defaults; ctrl+b ? lists every action by name.")
        : set(
            "new_tab",
            keys.new_tab,
            "an action's keys, in place of its defaults; ctrl+b ? lists all",
          ),
    ]),
  ];
  if (full) {
    for (const [name, value] of Object.entries(keys)) {
      if (name !== "prefix") keyLines.push(`${tomlKey(name)} = ${tomlValue(value)}`);
    }
    keyLines.push(
      "# On macOS these default to Firefox's macOS keys instead, since Option types characters:",
    );
    for (const [name, value] of Object.entries(MAC_KEYS)) {
      keyLines.push(`# ${tomlKey(name)} = ${tomlValue(value)}`);
    }
  }
  const modalLines = [
    "[modal]",
    ...annotate([
      set(
        "leader",
        modal.leader,
        'what <leader> means in bindings such as "<leader>ff" (" " is space)',
      ),
      set(
        "timeout_ms",
        modal.timeout_ms,
        "how long a sequence like gg waits for its next key (0–10000 ms)",
      ),
      set(
        "hint_chars",
        modal.hint_chars,
        "link-hint letters, the first ones most used (2 or more, no capitals)",
      ),
      set(
        "insert_editing",
        modal.insert_editing,
        "in text fields ctrl+w, ctrl+u, ctrl+h delete; ctrl+j, ctrl+m: Enter",
      ),
    ]),
    "",
    "# Bindings by mode, in Vim notation (<C-d> is ctrl+d): normal, insert, visual, command, hint,",
    "# element, help, panel, index, resize and pdf (the PDF viewer).",
  ];
  if (!full) {
    modalLines.push(
      "[modal.normal]",
      ...annotate([
        { code: `"gt" = "tab.next"`, note: "a default: g t goes to the next tab" },
        example(`"<leader>ff" = "goto.picker"`, "one of yours: leader f f opens the goto picker"),
      ]),
    );
    return { keys: keyLines, modal: modalLines };
  }
  let first = true;
  for (const [mode, table] of Object.entries(modal)) {
    if (typeof table !== "object") continue;
    if (!first) modalLines.push("");
    first = false;
    modalLines.push(`[modal.${mode}]`);
    for (const [seq, action] of Object.entries(table)) {
      modalLines.push(`${tomlString(seq)} = ${tomlString(action)}`);
    }
    if (mode === "pdf") {
      modalLines.push(
        "# PDF actions in place of Vimma's d, r, H, L, P, F, ctrl+f and F5, for the PDF viewer:",
      );
      for (const [seq, action] of Object.entries(ZATHURA_PDF_KEYS)) {
        modalLines.push(`# ${tomlString(seq)} = ${tomlString(action)}`);
      }
    }
  }
  return { keys: keyLines, modal: modalLines };
}

/**
 * Every table of defaults.toml, in order, as its lines. The file :config writes and the
 * config.toml reference in docs/guide.md (npm run gen-docs) are both made of these, so they
 * agree: every key config.toml takes, at its default or as a commented example when it has none,
 * with a note on what it takes and what changing it does.
 * @param {{ brief?: boolean }} [opts]  brief: `[keys]` and `[modal.normal]` with one binding each
 * @returns {{ name: string, lines: string[] }[]}
 */
export function configTables({ brief = false } = {}) {
  const c = /** @type {Required<UserConfig>} */ (DEFAULT_CONFIG);
  const panes = /** @type {Required<NonNullable<UserConfig["panes"]>>} */ (c.panes);
  const bookmarks = /** @type {Required<NonNullable<UserConfig["bookmarks"]>>} */ (c.bookmarks);
  const ui = /** @type {Required<NonNullable<UserConfig["ui"]>>} */ (c.ui);
  const m = /** @type {Required<NonNullable<UserConfig["mcp"]>>} */ (c.mcp);
  const keymap = keymapLines(!brief);
  return [
    { name: "keys", lines: keymap.keys },
    { name: "modal", lines: keymap.modal },
    {
      name: "unbind",
      lines: [
        "[unbind]",
        ...annotate([
          set("normal", [], "default bindings removed in normal mode; one such line per mode"),
        ]),
      ],
    },
    {
      name: "firefox",
      lines: [
        "[firefox]",
        ...annotate([
          set(
            "disable",
            c.firefox.disable,
            'Firefox\'s own shortcuts that are off: "all", or a list of keys',
          ),
          set(
            "enable",
            c.firefox.enable,
            'Firefox\'s shortcuts given back as Firefox runs them, such as ["ctrl+j"]',
          ),
        ]),
      ],
    },
    {
      name: "workspaces",
      lines: [
        "# Workspaces in ctrl+b ) order, each a Firefox container. None by default.",
        "# Colours: gray, yellow, orange, red, pink, purple, violet, blue, cyan, green.",
        "# Icons: circle, fingerprint, briefcase, dollar, cart, vacation, gift, food, fruit, pet,",
        "# tree, chill, fence.",
        "[workspaces]",
        ...annotate([
          example("[workspaces.work]", "a workspace named work (1 to 32 characters)"),
          example(
            `color = ${tomlString(WORKSPACE_DEFAULTS.color)}`,
            "the container's colour, from the list above",
          ),
          example(
            `icon = ${tomlString(WORKSPACE_DEFAULTS.icon)}`,
            "the container's icon, from the list above",
          ),
          example(
            'home = "https://intra.example"',
            "opens when you go to the workspace and it has no tab",
          ),
        ]),
      ],
    },
    {
      name: "theme",
      lines: [
        "[theme]",
        ...annotate([
          set(
            "source",
            theme.source,
            '"omarchy" follows Omarchy where installed; "file" always uses name',
          ),
          set(
            "name",
            theme.name,
            'the built-in palette: "vimma", vimma.dev\'s colours, dark and light',
          ),
          example(
            'appearance = "system"',
            '"system", "dark" or "light" variant; unset, :theme sets it',
          ),
          set(
            "font",
            theme.font,
            "the font of Vimma's bars, pickers and overlays (a CSS font list)",
          ),
        ]),
      ],
    },
    {
      name: "theme.colors",
      lines: [
        "[theme.colors]",
        ...annotate([
          example(
            'accent = "#7aa2f7"',
            "one colour over the theme: a colors.toml key, or split_1 to split_9",
          ),
        ]),
      ],
    },
    {
      name: "panes",
      lines: [
        "[panes]",
        ...annotate([
          set(
            "max",
            panes.max,
            `most panes a workspace shows (1–${PANES_MAX_LIMIT}); past it a new split is refused`,
          ),
          set(
            "max_splits",
            panes.max_splits,
            `most splits a workspace keeps (1–${MAX_SPLITS_LIMIT})`,
          ),
          set(
            "layout",
            panes.layout,
            'where ctrl+b enter splits: "dwindle" (longer side) or "manual" (right)',
          ),
          set(
            "main_size",
            panes.main_size,
            "the main pane's share in the main-* layouts, in percent (20–80)",
          ),
          set(
            "new_tab",
            panes.new_tab,
            'a tab opened in a split: "alone" beside it, or "pane" in the focused pane',
          ),
        ]),
      ],
    },
    {
      name: "bookmarks",
      lines: [
        "[bookmarks]",
        ...annotate([
          set(
            "root",
            bookmarks.root,
            'where the bookmarks panel starts: "workspace", "toolbar" or "all"',
          ),
          set(
            "bookmarklets",
            bookmarks.bookmarklets,
            'who may run bookmarklets: "none", "user" (you) or "agent" (asks you)',
          ),
          set(
            "write_back",
            bookmarks.write_back,
            'changes saved to bookmarks.toml: "all", "vimma" (Vimma\'s own), "none"',
          ),
        ]),
      ],
    },
    {
      name: "panel",
      lines: [
        "[panel]",
        ...annotate([
          set(
            "numbers",
            c.panel.numbers,
            'side panel rows: "absolute" (tab numbers), "relative" (for 4j), "hybrid"',
          ),
        ]),
      ],
    },
    {
      name: "scroll",
      lines: [
        "[scroll]",
        ...annotate([
          set(
            "step",
            c.scroll.step,
            `how far j, k, h and l scroll, in CSS pixels (${SCROLL_STEP_MIN}–${SCROLL_STEP_MAX})`,
          ),
        ]),
      ],
    },
    {
      name: "private",
      lines: [
        "[private]",
        ...annotate([
          set(
            "placement",
            c.private.placement,
            '"swap" takes this window\'s place (Hyprland, macOS); "window": beside it',
          ),
        ]),
      ],
    },
    {
      name: "ui",
      lines: [
        "# toolbar, bookmarks_toolbar, pdf_outline and tabline apply at startup and when their line",
        "# changes, so ctrl+b u, ctrl+shift+b and :tabline last until then.",
        "[ui]",
        ...annotate([
          set(
            "toolbar",
            ui.toolbar,
            'Firefox\'s toolbar, address bar included: "hidden" or "shown"',
          ),
          example(
            'bookmarks_toolbar = "shown"',
            '"shown", "hidden" or "newtab"; unset, hidden until ctrl+shift+b',
          ),
          set(
            "pdf_outline",
            ui.pdf_outline,
            'a PDF\'s outline as it opens: "shown", or "hidden" until Tab',
          ),
          set(
            "tabline",
            ui.tabline,
            'the tab line: "auto" (with 2 or more tabs), "always" or "off"',
          ),
          set(
            "tabline_width",
            ui.tabline_width,
            `the width of each tab's name in the tab line, in columns (${TABLINE_WIDTH.min}–${TABLINE_WIDTH.max})`,
          ),
        ]),
      ],
    },
    {
      name: "statusbar",
      lines: [
        "[statusbar]",
        ...annotate([
          set(
            "tab",
            c.statusbar.tab,
            "false drops the status bar's tab number and title while the tab line shows them",
          ),
        ]),
      ],
    },
    {
      name: "tabs",
      // On for everyone since docs/specs/tab-sleep.md's Delivery slice 4.
      lines: [
        "[tabs]",
        ...annotate([
          set(
            "sleep_after",
            SLEEP_AFTER.default,
            `minutes unseen before a tab sleeps (${SLEEP_AFTER.min}–${SLEEP_AFTER.max}); 0: never`,
          ),
          set(
            "sleep_on_low_memory",
            true,
            "false: Firefox never unloads tabs when memory runs low",
          ),
        ]),
      ],
    },
    {
      name: "updates",
      lines: [
        "# Every 12 hours Vimma asks updates.vimma.dev for a newer version, naming only the update",
        "# channel and the platform.",
        "[updates]",
        ...annotate([
          set(
            "check",
            c.updates.check,
            "false stops every update check, even when this file has a mistake",
          ),
        ]),
      ],
    },
    {
      name: "mcp",
      lines: [
        "# AI agents over MCP (Claude Code, Codex, opencode, Copilot), only in the agent workspace.",
        "[mcp]",
        ...annotate([
          example(
            "enabled = false",
            "unset: :mcp on and :mcp off set it; set here, it always wins",
          ),
          set("workspace", m.workspace, 'the agent workspace\'s name; not "private"'),
          set(
            "ask_timeout",
            m.ask_timeout,
            "seconds a request waits for your answer, then is denied (10–300)",
          ),
          set(
            "grant_minutes",
            m.grant_minutes,
            "a bare a: 0 grants until the agent quits, else that many minutes",
          ),
          set(
            "grant_max_minutes",
            m.grant_max_minutes,
            "the longest grant a count before a gives, in minutes (1–1440)",
          ),
          set(
            "max_read_chars",
            m.max_read_chars,
            "the most text one page read returns, in characters (1000–500000)",
          ),
          set(
            "notify",
            m.notify,
            "a desktop notification when an agent asks while Vimma is hidden",
          ),
          set("download_dir", m.download_dir, "where agent downloads are saved; never opened"),
          set(
            "download_max_mb",
            m.download_max_mb,
            "agent downloads larger than this are refused, in MB (1–4096)",
          ),
          set(
            "clamav_max_age_days",
            m.clamav_max_age_days,
            "days before ClamAV definitions stop counting a file clean (1–90)",
          ),
        ]),
      ],
    },
    {
      name: "agent",
      lines: annotate([
        say(
          "Vimma's own agent (ctrl+b i). A model you pick in its window is added here, never a key.",
        ),
        example("[agent]"),
        example(
          'default = "local"',
          "the provider new conversations use (unset: the first one picked)",
        ),
        example("local_only = false", "true refuses every model that is not on this machine"),
        example(`max_running = 3`, "how many tasks run at once (1–10)"),
        example(`max_steps = 100`, "a task stops after this many tool calls (1–1000)"),
        example(`max_tokens = 2000000`, "a task stops after this many tokens (1000–100000000)"),
        example(`max_cost = 2`, "a task stops at this cost, with prices set (above 0, up to 1000)"),
        example(
          "keep_days = 30",
          "delete conversations unused this long (1–3650 days); unset, kept",
        ),
        example("keep_results = 6", "tool results kept whole (0: all); unset, 20 local, 6 hosted"),
        example("[[agent.providers]]", "a model behind an API, one table each; never its key"),
        example('name = "local"', "what default and the model picker call it (1–32 characters)"),
        example(
          'kind = "openai"',
          '"openai" (OpenAI-compatible API) or "anthropic" (Messages API)',
        ),
        example('endpoint = "http://127.0.0.1:11434/v1"', "https://, or http:// on this machine"),
        example('model = "qwen3:14b-ctx32768"', "the model's name at that endpoint"),
        example("vision = false", "true: the model reads images, so the agent gets screenshots"),
        example("price_in = 3", "the price per million input tokens, for max_cost; with price_out"),
        example("price_out = 15", "the price per million output tokens"),
        example(
          "[[agent.providers]]",
          "an agent CLI (Claude Code, Codex, Gemini CLI) on its own login",
        ),
        example('name = "claude"', "the provider's name"),
        example('kind = "cli"', "an agent CLI: no endpoint, the CLI decides where requests go"),
        example('cli = "claude-code"', 'which CLI: "claude-code", "codex" or "gemini"'),
        example('model = "sonnet"', "the CLI's own model option; unset, its default"),
        example("max_minutes = 30", "the longest one task may run, in minutes (1–1440)"),
      ]),
    },
    {
      name: "sites",
      lines: annotate([
        say(
          "Per site: a host covers its subdomains; the most specific table wins. None by default.",
        ),
        example('[sites."docs.google.com"]'),
        example(
          'insert = "always"',
          'text fields take insert mode: "auto" (when detected), "never" or "always"',
        ),
        example(
          'unbind = ["t"]',
          "keys the page gets instead of Vimma; esc and the prefix stay Vimma's",
        ),
        example("sleep = false", "its tabs never go to sleep on their own"),
      ]),
    },
    {
      name: "routes",
      lines: annotate([
        say("Which workspace a link opens in: the first rule that matches wins. None by default."),
        say("A routes.toml beside this file, when it exists, holds them (and [routing]) instead."),
        example("[[routes]]"),
        example(
          'domain = "github.com"',
          'github.com and its subdomains; "*.corp.example": subdomains only',
        ),
        example('app = "slack"', "links that program opens (Linux); with domain, both must match"),
        example('workspace = "work"', "the workspace the link opens in"),
        example("[[routes]]"),
        example(
          'url = "file:///home/me/notes/"',
          "a URL prefix in place of a domain, for file: and about: pages",
        ),
        example('workspace = "work"', "the workspace those pages open in"),
      ]),
    },
    {
      name: "routing",
      lines: annotate([
        example("[routing]"),
        example(
          'default_workspace = "work"',
          "links from programs that no rule matches; unset, Firefox guesses",
        ),
      ]),
    },
    {
      name: "search",
      lines: annotate([
        say("Search engines. None by default."),
        example("[search]"),
        example(
          'default = "DuckDuckGo"',
          'an installed engine\'s name or "@gh" (below); wins at every start',
        ),
        example("[search.aliases]", "typed as @gh before the words: address bar, :open, :tabnew"),
        example('gh = "https://github.com/search?q=%s"', "a URL with one %s becomes an engine"),
        example('w = "Wikipedia (en)"', "an installed engine's name gets this alias"),
      ]),
    },
  ];
}

/**
 * Render DEFAULT_CONFIG as defaults.toml.
 * @returns {string}
 */
export function formatDefaultsToml() {
  return [
    "# vimma default configuration.",
    "# Generated from packages/vimma-core/src/config/defaults.mjs by `npm run gen-docs`; do not edit.",
    "# Copy any line into ~/.config/vimma/config.toml to change it.",
    "",
    configTables()
      .map((t) => t.lines.join("\n"))
      .join("\n\n"),
    "",
  ].join("\n");
}

/** The lines of defaults.toml's header, which the template replaces. */
const DEFAULTS_HEADER = 3;

/**
 * What `:config` writes when config.toml does not exist yet (spec m5-config-load): defaults.toml
 * with every setting commented out, so the file means exactly the defaults until a line is
 * uncommented. Table headers stay, so an uncommented line lands in its table. A setting keeps its
 * note's column: the `# ` it gains comes out of the spaces before the note.
 * @returns {string}
 */
export function formatConfigTemplate() {
  const body = formatDefaultsToml()
    .split("\n")
    .slice(DEFAULTS_HEADER)
    .map((line) =>
      line === "" || /^\s*#/.test(line) || line.startsWith("[")
        ? line
        : `# ${line.replace(/ {2}( {2,}# )/, "$1")}`,
    );
  return [
    "# Vimma config. Every setting is commented out: its default, or an example where it has none.",
    "# To uncomment a setting, remove the first `# ` of its line (and of its [table] if commented).",
    "# A save reloads this file within 2 seconds, :source at once; :config opens this file.",
    "# ctrl+b ? lists every key.",
    "# Reference: https://vimma.dev/docs/config/",
    ...body,
  ].join("\n");
}
