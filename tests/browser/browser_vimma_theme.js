/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m5-omarchy-theme.md

"use strict";

/* global BrowserCommands -- browser window global (browser.js) */
/* global focusContent -- from head.js */

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const START = "chrome://browser/content/vimma/start/start.html";
const POLL_MS = 100;
/** The built-in vimma palette's dark_background: its status bar colour, dark and light. */
const VIMMA_STATUSBAR = "#050c0d";
const VIMMA_LIGHT_STATUSBAR = "#e7ecea";

/**
 * A colors.toml in Omarchy 4's format (as in tests/contract/theme/), written by hand: keys in
 * Omarchy's order, with `bg` and `darkBg` varied so each theme is told apart by the status bar.
 * @param {{ bg: string, darkBg: string, mode?: string | null }} p  mode null: no mode key
 */
function colorsToml({ bg, darkBg, mode = "dark" }) {
  return `${mode === null ? "" : `mode = "${mode}"\n`}
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "${bg}"
dark_background = "${darkBg}"
darker_background = "#0e0e14"
lighter_background = "#24283b"

foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"

red = "#f7768e"
yellow = "#e0af68"
orange = "#ff9e64"
green = "#9ece6a"
cyan = "#7dcfff"
blue = "#7aa2f7"
magenta = "#bb9af7"
brown = "#db4b4b"

bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#7dcfff"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"

hyprland_active_border = "rgba(7aa2f7ee) rgba(bb9af7ee) 45deg"
`;
}

/** Light: Catppuccin Latte surfaces, dark text; no mode key, so light.mode decides. */
function lightToml() {
  return colorsToml({ bg: "#eff1f5", darkBg: "#e6e9ef", mode: null })
    .replace('foreground = "#a9b1d6"', 'foreground = "#4c4f69"')
    .replace('dark_foreground = "#565f89"', 'dark_foreground = "#6c6f85"')
    .replace('selection = "#292e42"', 'selection = "#ccd0da"');
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const barBackground = () =>
  getComputedStyle(document.getElementById("vimma-statusbar")).backgroundColor;

/** Waits until the status bar shows `hex` as its background. */
function waitForBar(hex, msg) {
  return TestUtils.waitForCondition(() => barBackground() === rgb(hex), msg, 50, 100);
}

/**
 * Opens each overlay and prompt in turn (ctrl+b ?, ctrl+b g, `:`, ctrl+b T) and checks that its
 * surface and text are the current theme's tokens: --vimma-bg-dark and --vimma-fg.
 * @param {string} label  which theme, for the messages
 */
async function assertSurfacesFollowTheTheme(label) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await focusContent(tab.linkedBrowser);
  const surface = rgb(token("--vimma-bg-dark"));
  const text = rgb(token("--vimma-fg"));
  const $ = (/** @type {string} */ id) => document.getElementById(id);
  const shown = (/** @type {Element | null | undefined} */ el) =>
    !!el && BrowserTestUtils.isVisible(el);
  const surfaces = [
    {
      what: "the ctrl+b ? help overlay",
      prefix: true,
      open: () => EventUtils.synthesizeKey("?", { shiftKey: true }),
      el: () => $("vimma-help"),
    },
    {
      what: "the ctrl+b g picker",
      prefix: true,
      open: () => EventUtils.synthesizeKey("g"),
      el: () => $("vimma-picker"),
    },
    {
      what: "the : command line",
      prefix: false,
      open: () => EventUtils.synthesizeKey(":", { shiftKey: true }),
      el: () => $("vimma-cmdline")?.querySelector(".vimma-cmdline-panel"),
    },
    {
      what: "the ctrl+b T rename prompt",
      prefix: true,
      open: () => EventUtils.synthesizeKey("T", { shiftKey: true }),
      el: () => $("vimma-rename")?.querySelector(".vimma-cmdline-panel"),
    },
  ];
  for (const s of surfaces) {
    if (s.prefix) EventUtils.synthesizeKey("b", { ctrlKey: true });
    s.open();
    await TestUtils.waitForCondition(() => shown(s.el()), `${label}: ${s.what} opens`);
    const style = getComputedStyle(/** @type {Element} */ (s.el()));
    Assert.equal(style.backgroundColor, surface, `${label}: ${s.what} is on --vimma-bg-dark`);
    Assert.equal(style.color, text, `${label}: ${s.what} text is --vimma-fg`);
    if (s.el()?.id === "vimma-help") {
      const help = /** @type {Element} */ (s.el());
      const part = (/** @type {string} */ sel) =>
        getComputedStyle(/** @type {Element} */ (help.querySelector(sel)));
      Assert.equal(part("header").backgroundColor, surface, `${label}: the help header too`);
      Assert.equal(part("input").color, text, `${label}: the help filter's text is --vimma-fg`);
    }
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !shown(s.el()), `${label}: ${s.what} closes`);
  }
  await assertSidePanelFollowsTheTheme(label);
  assertNoticeFollowsTheTheme(label);
  BrowserTestUtils.removeTab(tab);
}

/**
 * Shows the toast (ui/notice.mjs) and checks what it paints, not its variables: its surface,
 * text and border are the tokens Vimma's other surfaces use, not the system's Canvas colours.
 * @param {string} label  which theme, for the messages
 */
function assertNoticeFollowsTheTheme(label) {
  VimmaHost.say(window, `${label}: a notice`);
  const toast = /** @type {Element} */ (document.getElementById("vimma-notice"));
  Assert.ok(toast?.matches(":popover-open"), `${label}: the notice shows`);
  const style = getComputedStyle(toast);
  const t = (/** @type {string} */ name) => rgb(token(name));
  Assert.equal(style.backgroundColor, t("--vimma-bg-dark"), `${label}: notice surface`);
  Assert.equal(style.color, t("--vimma-fg"), `${label}: notice text`);
  Assert.equal(style.borderTopColor, t("--vimma-muted"), `${label}: notice border`);
  Assert.equal(style.colorScheme, token("--vimma-color-scheme"), `${label}: notice scheme`);
  /** @type {any} */ (toast).hidePopover();
}

/**
 * Opens the side panel (ctrl+b b) and checks every part of it against the current tokens:
 * surface, text, border, header, selected row, active number, key hint and the list's scrollbar.
 * @param {string} label  which theme, for the messages
 */
async function assertSidePanelFollowsTheTheme(label) {
  const panel = () => document.getElementById("vimma-panel");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("b");
  await TestUtils.waitForCondition(
    () => !!panel() && BrowserTestUtils.isVisible(panel()),
    `${label}: the side panel opens`,
  );
  const box = /** @type {Element} */ (panel());
  const style = (/** @type {string} */ sel) =>
    getComputedStyle(/** @type {Element} */ (sel ? box.querySelector(sel) : box));
  const t = (/** @type {string} */ name) => rgb(token(name));
  const panelStyle = style("");
  Assert.equal(panelStyle.backgroundColor, t("--vimma-bg-dark"), `${label}: panel surface`);
  Assert.equal(panelStyle.color, t("--vimma-fg"), `${label}: panel text`);
  Assert.equal(panelStyle.borderInlineEndColor, t("--vimma-muted"), `${label}: panel border`);
  Assert.equal(style(".vimma-panel-name").color, t("--vimma-fg"), `${label}: header name`);
  Assert.equal(style(".vimma-panel-hint").color, t("--vimma-fg-dim"), `${label}: key hint`);
  const row = style("[role=option][aria-selected=true]");
  Assert.equal(row.backgroundColor, t("--vimma-selection"), `${label}: selected row surface`);
  Assert.equal(row.color, t("--vimma-fg-bright"), `${label}: selected row text`);
  Assert.equal(
    style(".vimma-panel-active .vimma-panel-number").color,
    t("--vimma-text-accent"),
    `${label}: the active tab's number`,
  );
  Assert.equal(
    style("ul").scrollbarColor,
    `${t("--vimma-muted")} ${t("--vimma-bg-dark")}`,
    `${label}: the list's scrollbar is the theme's, not the toolkit's`,
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !BrowserTestUtils.isVisible(box),
    `${label}: the side panel closes`,
  );
}

async function ln(target, link) {
  const command = await Subprocess.pathSearch("ln");
  const proc = await Subprocess.call({ command, arguments: ["-sfn", target, link] });
  const { exitCode } = await proc.wait();
  Assert.equal(exitCode, 0, `ln -sfn ${target} ${link}`);
}

const root = PathUtils.join(PathUtils.tempDir, `vimma-theme-${Date.now()}`);
const dir = (/** @type {string} */ name) => PathUtils.join(root, "themes", name);
const current = PathUtils.join(root, "current");
const currentTheme = PathUtils.join(current, "theme");

add_task(async function setup() {
  await IOUtils.makeDirectory(dir("one"), { createAncestors: true });
  await IOUtils.writeUTF8(
    PathUtils.join(dir("one"), "colors.toml"),
    colorsToml({ bg: "#202020", darkBg: "#101820" }),
  );
  await IOUtils.makeDirectory(dir("two"), { createAncestors: true });
  await IOUtils.writeUTF8(
    PathUtils.join(dir("two"), "colors.toml"),
    colorsToml({ bg: "#2a1a2a", darkBg: "#301030" }),
  );
  await IOUtils.makeDirectory(dir("light"), { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(dir("light"), "colors.toml"), lightToml());
  await IOUtils.writeUTF8(PathUtils.join(dir("light"), "light.mode"), "");
  await IOUtils.makeDirectory(current, { createAncestors: true });
  await ln(dir("one"), currentTheme);

  // browser.toml pins vimma.theme.source=builtin for every other test; this one opts in.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", POLL_MS],
      ["vimma.theme.omarchyPath", currentTheme],
      ["vimma.theme.source", "omarchy"],
      // A dark desktop, so the built-in vimma palette shows its dark variant until a task
      // switches the scheme (prefers-color-scheme follows this in chrome without a theme).
      ["ui.systemUsesDarkTheme", 1],
    ],
  });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await SpecialPowers.popPrefEnv();
    await IOUtils.remove(root, { recursive: true });
  });
});

add_task(async function status_bar_takes_the_omarchy_background() {
  await waitForBar("#101820", "the status bar's background is the fixture's dark_background");
  Assert.equal(token("--vimma-bg"), "#202020", "--vimma-bg is the fixture's background");
  Assert.equal(token("--vimma-color-scheme"), "dark", "a dark theme");
});

add_task(async function start_page_takes_the_theme_and_follows_it() {
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, START, true);
  BrowserCommands.openTab();
  const tab = await loaded;
  const pageBg = () =>
    SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.getComputedStyle(content.document.documentElement).backgroundColor,
    );
  await TestUtils.waitForCondition(
    async () => (await pageBg()) === rgb("#202020"),
    "the start page's background is the fixture's background",
  );
  await IOUtils.writeUTF8(
    PathUtils.join(dir("one"), "colors.toml"),
    colorsToml({ bg: "#283028", darkBg: "#101820" }),
  );
  await TestUtils.waitForCondition(
    async () => (await pageBg()) === rgb("#283028"),
    "an open start page follows the change",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function rewriting_the_file_updates_within_the_poll() {
  await IOUtils.writeUTF8(
    PathUtils.join(dir("one"), "colors.toml"),
    colorsToml({ bg: "#303030", darkBg: "#183018" }),
  );
  const started = Date.now();
  await waitForBar("#183018", "the rewritten file's colours");
  Assert.less(Date.now() - started, 20 * POLL_MS, "within a few poll intervals");
});

add_task(async function broken_file_keeps_the_previous_colours() {
  const failed = TestUtils.topicObserved("vimma-theme-error");
  await IOUtils.writeUTF8(
    PathUtils.join(dir("one"), "colors.toml"),
    colorsToml({ bg: "#303030", darkBg: "not a colour" }),
  );
  await failed;
  Assert.equal(barBackground(), rgb("#183018"), "the last good theme stays");
  // A further poll of the same broken file neither re-reports nor changes anything.
  await new Promise((r) => setTimeout(r, 3 * POLL_MS));
  Assert.equal(barBackground(), rgb("#183018"), "still the last good theme");
});

add_task(async function swapping_the_symlink_follows_the_new_theme() {
  await ln(dir("two"), currentTheme);
  await waitForBar("#301030", "omarchy-theme-set's swap: theme two");
  Assert.equal(token("--vimma-bg"), "#2a1a2a", "and its background token");
});

add_task(async function overlays_and_prompts_follow_a_dark_theme() {
  Assert.equal(token("--vimma-bg-dark"), "#301030", "theme two is current");
  await assertSurfacesFollowTheTheme("dark");
});

add_task(async function light_mode_file_switches_to_light_tokens() {
  await ln(dir("light"), currentTheme);
  await waitForBar("#e6e9ef", "the light theme");
  Assert.equal(token("--vimma-color-scheme"), "light", "light.mode makes the tokens light");
});

add_task(async function overlays_and_prompts_follow_a_light_theme() {
  Assert.equal(token("--vimma-fg"), "#4c4f69", "the light theme's dark text is current");
  await assertSurfacesFollowTheTheme("light");
});

add_task(async function no_omarchy_dir_means_the_builtin_vimma() {
  await SpecialPowers.pushPrefEnv({
    set: [["vimma.theme.omarchyPath", PathUtils.join(root, "nowhere", "theme")]],
  });
  await waitForBar(VIMMA_STATUSBAR, "no Omarchy theme: the built-in vimma palette");
  await SpecialPowers.popPrefEnv();
  await waitForBar("#e6e9ef", "the Omarchy theme again");
});

// Issue #66: a check that was reading the old path when the path changed went on to apply that
// theme (and mark it loaded), so the new path's missing theme never brought the built-in back.
add_task(async function a_path_change_during_a_check_is_not_undone_by_it() {
  await waitForBar("#e6e9ef", "sanity: the light Omarchy theme");
  // No timer tick in flight: only the pref changes below start checks.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", 600000],
      ["vimma.theme.omarchyPath", currentTheme],
    ],
  });
  await TestUtils.waitForTick();
  // The same theme by another path: a check starts and awaits the file's stat...
  Services.prefs.setStringPref("vimma.theme.omarchyPath", dir("light"));
  for (let i = 0; i < 3; i++) await Promise.resolve();
  // ...when the path moves to a missing theme.
  Services.prefs.setStringPref("vimma.theme.omarchyPath", PathUtils.join(root, "nowhere"));
  await waitForBar(VIMMA_STATUSBAR, "the last path wins: no Omarchy theme, the built-in");
  await SpecialPowers.popPrefEnv();
  await waitForBar("#e6e9ef", "the Omarchy theme again");
});

add_task(async function builtin_source_ignores_omarchy() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.source", "builtin"]] });
  await waitForBar(VIMMA_STATUSBAR, "vimma.theme.source=builtin forces the built-in vimma");
  await SpecialPowers.popPrefEnv();
});

add_task(async function builtin_vimma_follows_the_colour_scheme_live() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.source", "builtin"]] });
  await waitForBar(VIMMA_STATUSBAR, "a dark desktop: vimma dark");
  Assert.equal(token("--vimma-color-scheme"), "dark", "dark tokens");
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, START, true);
  BrowserCommands.openTab();
  const tab = await loaded;
  const pageBg = () =>
    SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.getComputedStyle(content.document.documentElement).backgroundColor,
    );
  await TestUtils.waitForCondition(
    async () => (await pageBg()) === rgb("#071011"),
    "the start page is vimma dark",
  );

  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  await waitForBar(VIMMA_LIGHT_STATUSBAR, "a light desktop: vimma light, without a reload");
  Assert.equal(token("--vimma-color-scheme"), "light", "light tokens");
  Assert.equal(token("--vimma-hint-bg"), "#b0226f", "the hints are the light magenta");
  await TestUtils.waitForCondition(
    async () => (await pageBg()) === rgb("#f3f6f4"),
    "the open start page turns light too",
  );
  await assertSurfacesFollowTheTheme("vimma light");

  await SpecialPowers.popPrefEnv();
  await waitForBar(VIMMA_STATUSBAR, "dark again");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
