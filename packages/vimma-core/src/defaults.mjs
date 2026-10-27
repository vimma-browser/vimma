/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Default configuration, as the object a TOML parser would produce from defaults.toml.
 * packages/vimma-core/defaults.toml is generated from this (npm run gen-docs).
 */

import { DEFAULT_HINT_CHARS } from "./hints.mjs";
import { PANES_MAX_DEFAULT } from "./panes.mjs";
import { MAIN_SIZE_DEFAULT } from "./layouts.mjs";
import { DEFAULT_THEME_NAME } from "./theme.mjs";

/**
 * @typedef {object} UserConfig
 * @property {Record<string, string | string[]>} [keys]
 * @property {{ leader?: string, timeout_ms?: number } & Record<string, unknown>} [modal]
 * @property {Record<string, string[]>} [unbind]
 * @property {number} [schema]
 * @property {Record<string, WorkspaceInput>} [workspaces]
 * @property {ThemeInput} [theme]
 * @property {{ max?: number, layout?: "dwindle" | "manual", main_size?: number }} [panes]
 * @property {Record<string, { insert?: import("./editable.mjs").InsertSiteMode }>} [sites]
 * @property {Record<string, string>[]} [routes]  `[[routes]]` (workspace-routing)
 * @property {{ disable?: "all" | readonly string[], enable?: readonly string[] }} [firefox]
 *   Firefox's own shortcuts that are off (docs/specs/key-handling-batch.md)
 * @property {{ root?: "workspace" | "toolbar" | "all" }} [bookmarks]  the bookmarks panel's root
 *   (docs/specs/bookmarks.md)
 * @property {{ placement?: "swap" | "window" }} [private]  where the private workspace is shown
 *   (docs/specs/private-swap.md)
 * @property {{ check?: boolean }} [updates]  update checks (docs/specs/m6a-updater.md)
 * @property {{ toolbar?: "shown" | "hidden",
 *   bookmarks_toolbar?: import("./bookmarks-toolbar.mjs").BookmarksToolbarSetting }} [ui]
 *   Firefox's toolbar at startup (docs/specs/toolbar-toggle.md) and its Bookmarks Toolbar
 *   (docs/specs/bookmarks-toolbar-hidden.md)
 * @property {{ enabled?: boolean, workspace?: string, ask_timeout?: number,
 *   grant_minutes?: number, grant_max_minutes?: number, max_read_chars?: number,
 *   notify?: boolean, download_dir?: string, download_max_mb?: number,
 *   clamav_max_age_days?: number }} [mcp]  local AI agents and the agent workspace (docs/specs/vimma-mcp.md)
 * @property {{ default?: string, aliases?: Record<string, string> }} [search]  the default
 *   search engine and `@alias` keywords (docs/specs/search-engines.md)
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
 * @property {string} [name]   a built-in palette: "vimma" or "tokyo-night" (schema 2)
 * @property {"system" | "dark" | "light"} [appearance]  the built-in palette's variant (schema 2)
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
  new_window: ["ctrl+n"],
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
  ai_chatbot_sidebar: ["ctrl+alt+x"],
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
  copy_mode: ["prefix+["],
  addon_picker: ["prefix+e"],
};

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
    b: "goto.picker",
    // Workspaces as Vim buffers: the alternate (ctrl+6 where ^ is a dead key), unimpaired's ]w.
    "<C-^>": "workspace.last",
    "<C-6>": "workspace.last",
    "]w": "workspace.next",
    "[w": "workspace.previous",
    // unimpaired's quickfix keys over the last live grep's results (live-grep decision 8).
    "]q": "grep.next",
    "[q": "grep.previous",
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
  insert: { "<Esc>": "mode.normal" },
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
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`${i + 1}`, `panel_select_${i + 1}`]),
    ),
    j: "panel.down",
    k: "panel.up",
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
    layout: /** @type {const} */ ("dwindle"),
    main_size: MAIN_SIZE_DEFAULT * 100,
  },
  sites: {},
  firefox: { disable: /** @type {"all"} */ ("all"), enable: [] },
  bookmarks: { root: /** @type {const} */ ("workspace") },
  private: { placement: /** @type {const} */ ("swap") },
  ui: { toolbar: /** @type {const} */ ("shown") },
  updates: { check: true },
  // docs/specs/vimma-mcp.md, decision 26. No `enabled`: left out, `:mcp on|off` decides.
  mcp: {
    workspace: "agent",
    ask_timeout: 50,
    grant_minutes: 10,
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

/**
 * Render DEFAULT_CONFIG as defaults.toml.
 * @returns {string}
 */
export function formatDefaultsToml() {
  const lines = [
    "# vimma default configuration.",
    "# Generated from packages/vimma-core/src/defaults.mjs by `npm run gen-docs`; do not edit.",
    "# Copy any line into ~/.config/vimma/config.toml to change it.",
    "schema = 2",
    "",
    "[keys]",
  ];
  for (const [name, value] of Object.entries(keys)) {
    const v = Array.isArray(value) ? `[${value.map(tomlString).join(", ")}]` : tomlString(value);
    lines.push(`${tomlKey(name)} = ${v}`);
  }
  lines.push(
    "",
    "[modal]",
    `leader = ${tomlString(modal.leader)}`,
    `timeout_ms = ${modal.timeout_ms}`,
    "# Hint labels are made of these characters, the first ones most often.",
    `hint_chars = ${tomlString(modal.hint_chars)}`,
    "# In text fields ctrl+w deletes a word, ctrl+u to the line's start, ctrl+h a character.",
    `insert_editing = ${modal.insert_editing}`,
  );
  for (const [mode, table] of Object.entries(modal)) {
    if (typeof table !== "object") continue;
    lines.push("", `[modal.${mode}]`);
    for (const [seq, action] of Object.entries(table)) {
      lines.push(`${tomlString(seq)} = ${tomlString(action)}`);
    }
  }
  lines.push(
    "",
    "[unbind]",
    "normal = []",
    "",
    "# Firefox's own shortcuts are off; Vimma binds them on the same keys (ctrl+b ? lists them).",
    '# enable = ["ctrl+j"] gives one back exactly as Firefox runs it.',
    "[firefox]",
    'disable = "all"',
    "enable = []",
    "",
    "# Order here is the order ctrl+b ) goes in; each workspace is a Firefox container. None by default.",
    `# Left-out keys: color = ${tomlString(WORKSPACE_DEFAULTS.color)}, icon = ${tomlString(WORKSPACE_DEFAULTS.icon)}, autofill = ${WORKSPACE_DEFAULTS.autofill}.`,
    "[workspaces]",
    '# work = { color = "blue", icon = "briefcase", home = "https://intranet.example" }',
    "",
    '# The built-in palette `name`: "vimma" (vimma.dev\'s colours, dark or light) or "tokyo-night"',
    '# (dark). "omarchy" follows your Omarchy theme where Omarchy is installed and uses `name`',
    '# elsewhere; "file" always uses `name`.',
    "[theme]",
    `source = ${tomlString(theme.source)}`,
    `name = ${tomlString(theme.name)}`,
    '# The built-in palette "dark", "light", or "system" (as the system or Firefox is, live).',
    "# Left out, :theme dark|light|system sets it and remembers it; set here, it always wins.",
    '# appearance = "system"',
    `font = ${tomlString(theme.font)}`,
    "",
    "# Overrides on top of the palette, with the keys of Omarchy's colors.toml.",
    "[theme.colors]",
    '# accent = "#7aa2f7"',
    "",
    "# The most panes (live pages) one workspace shows at once, 1 to 16.",
    "[panes]",
    `max = ${PANES_MAX_DEFAULT}`,
    '# Where ctrl+b enter puts a new pane: "dwindle" splits the focused pane along its longer side,',
    '# "manual" splits right as ctrl+b v. ctrl+b v and ctrl+b - always keep their direction.',
    'layout = "dwindle"',
    "# The main pane's size in the main-vertical and main-horizontal layouts, 20 to 80 percent.",
    `main_size = ${MAIN_SIZE_DEFAULT * 100}`,
    "",
    '# The bookmarks panel (ctrl+b shift+b) and ctrl+b a: "workspace" is the current workspace\'s',
    '# folder in the Bookmarks Toolbar; "toolbar" the whole toolbar; "all" every bookmark.',
    "[bookmarks]",
    `root = ${tomlString(DEFAULT_CONFIG.bookmarks?.root ?? "workspace")}`,
    "",
    '# The private workspace (ctrl+b shift+p): "swap" shows it in place of the Vimma window on',
    '# Hyprland and macOS, which hide the other one until you switch back; "window" opens it as',
    "# a window of its own beside it, as on every other system.",
    "[private]",
    `placement = ${tomlString(DEFAULT_CONFIG.private?.placement ?? "swap")}`,
    "",
    '# Firefox\'s toolbar (the URL bar and add-on buttons) in every window: "shown" or "hidden".',
    "# Hidden, focusing the address bar shows it; ctrl+b u and :toolbar toggle it until restart.",
    "[ui]",
    `toolbar = ${tomlString(DEFAULT_CONFIG.ui?.toolbar ?? "shown")}`,
    "# Firefox's Bookmarks Toolbar, hidden by default (your bookmarks: ctrl+b shift+b):",
    '# "shown", "hidden" or "newtab" (on the start page and new tabs only). Left out,',
    "# ctrl+shift+b, :bookmarkstoolbar and Firefox's View > Toolbars menu set it for good.",
    '# bookmarks_toolbar = "shown"',
    "",
    "# Every 12 hours Vimma asks updates.vimma.dev whether a newer version exists. The request",
    "# names only the update channel and the platform. false stops every check.",
    "[updates]",
    `check = ${DEFAULT_CONFIG.updates?.check === false ? "false" : "true"}`,
    "",
    ...mcpLines(),
    "",
    "# Per-site insert mode: auto (detect text fields), never (keys stay vimma's), always.",
    "# A host also covers its subdomains. None by default.",
    '# [sites."docs.google.com"]',
    '# insert = "always"',
    "",
    "# Which workspace a link opens in: by domain (and its subdomains), url prefix, or the app",
    "# that opened it (vimma-open). The first matching rule wins. None by default.",
    "# [[routes]]",
    '# domain = "github.com"',
    '# workspace = "work"',
    "",
    "# Search engines. default: an installed engine's name (as in Settings > Search), or",
    '# "@alias" of a URL below. Each alias is typed as @alias before the words, in the URL bar',
    "# and in :open and :tabnew. A URL with one %s becomes an engine; a name gives that engine",
    "# the alias. Set here, the default wins at every start; delete the line to choose it in",
    "# Settings. None by default.",
    "# [search]",
    '# default = "DuckDuckGo"',
    "# [search.aliases]",
    '# gh = "https://github.com/search?q=%s"',
    '# w = "Wikipedia (en)"',
    "",
  );
  return lines.join("\n");
}

/** `[mcp]` in defaults.toml (docs/specs/vimma-mcp.md, decision 26). */
function mcpLines() {
  const m = /** @type {Required<NonNullable<UserConfig["mcp"]>>} */ (DEFAULT_CONFIG.mcp);
  return [
    "# Local AI agents (Claude Code, Codex, opencode, Copilot) reach only the agent workspace, and",
    "# every request asks you first. Left out, :mcp on|off sets enabled and remembers it; set",
    "# here, it always wins. ask_timeout: seconds a request waits for you (10 to 300); a bare `a`",
    "# grants grant_minutes, a count before it up to grant_max_minutes (at most 1440).",
    "[mcp]",
    "# enabled = false",
    `workspace = ${tomlString(m.workspace)}`,
    `ask_timeout = ${m.ask_timeout}`,
    `grant_minutes = ${m.grant_minutes}`,
    `grant_max_minutes = ${m.grant_max_minutes}`,
    `max_read_chars = ${m.max_read_chars}`,
    `notify = ${m.notify}`,
    "# Downloads from the agent workspace ask first, are saved only here (never your Downloads",
    "# folder itself), never opened, and refused over download_max_mb (1 to 4096).",
    `download_dir = ${tomlString(m.download_dir)}`,
    `download_max_mb = ${m.download_max_mb}`,
    "# A ClamAV scan with definitions older than this many days (1 to 90) is never reported",
    "# clean: keeping the file is asked, as for one ClamAV could not fully scan.",
    `clamav_max_age_days = ${m.clamav_max_age_days}`,
  ];
}

/** The lines of defaults.toml's header, which the template replaces. */
const DEFAULTS_HEADER = 3;

/**
 * What `:config` writes when config.toml does not exist yet (spec m5-config-load): defaults.toml
 * with every setting commented out, so the file means exactly the defaults until a line is
 * uncommented. Table headers stay, so an uncommented line lands in its table.
 * @returns {string}
 */
export function formatConfigTemplate() {
  const body = formatDefaultsToml()
    .split("\n")
    .slice(DEFAULTS_HEADER)
    .map((line) =>
      line === "" || line.startsWith("#") || line.startsWith("[") || line.startsWith("schema =")
        ? line
        : `# ${line}`,
    );
  return [
    "# Vimma config. Every line below is a default, commented out, so this file changes nothing.",
    "# To change a setting, uncomment its line (remove the `# `) and edit the value; the table",
    "# header above it ([keys], [modal], ...) stays as it is. Delete lines you do not need.",
    "# Vimma reloads this file within 2 seconds of a save, in every window; :source reads it at",
    "# once. In Vimma, :config opens this file, and ctrl+b ? lists every key with its name here.",
    "# Reference: the user guide's config.toml section (docs/guide.md).",
    ...body,
  ].join("\n");
}
