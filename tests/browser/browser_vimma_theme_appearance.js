/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/theme-appearance.md. A: Vimma looks for Omarchy once, under HOME, and without
// it never polls, never looks for Omarchy's hooks and shows the built-in palette. B: `:theme`
// picks the built-in palette's appearance (dark, light, the system's), live, kept in a pref, and
// config.toml's `[theme] appearance` wins over it.

"use strict";

/* global BrowserCommands -- browser window global (browser.js) */
/* global focusContent -- from head.js */

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { OmarchyHook } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/omarchy/OmarchyHook.sys.mjs",
);

const { TOKYO_NIGHT } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/index.mjs");

const START = "chrome://browser/content/vimma/start/start.html";
/** The Omarchy fixture's dark_background: its status bar. */
const OMARCHY_BAR = "#302010";
const APPEARANCE_PREF = "vimma.theme.appearance";
/** The built-in vimma palette's dark_background (the status bar), dark and light. */
const VIMMA_DARK_BAR = "#050c0d";
const VIMMA_LIGHT_BAR = "#e7ecea";
const DEFAULT_THEME = { source: "omarchy", name: "vimma", font: "monospace", colors: {} };

const root = PathUtils.join(PathUtils.tempDir, `vimma-appearance-${Date.now()}`);
/** A HOME without Omarchy, and one with it (an Omarchy 4 install's ~/.local/share/omarchy). */
const plainHome = PathUtils.join(root, "plain");
const omarchyHome = PathUtils.join(root, "omarchy");
const realHome = Services.dirsvc.get("Home", Ci.nsIFile).path;

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const barBackground = () =>
  getComputedStyle(document.getElementById("vimma-statusbar")).backgroundColor;
const notice = () => document.getElementById("vimma-notice")?.textContent ?? "";

function waitForBar(/** @type {string} */ hex, /** @type {string} */ msg) {
  return TestUtils.waitForCondition(() => barBackground() === rgb(hex), msg, 50, 100);
}

/** `:`, the line, Enter, then the notice it shows. */
async function runCommand(/** @type {string} */ line, /** @type {string} */ expected) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(() => notice() === expected, `:${line} says "${expected}"`);
}

add_task(async function setup() {
  await IOUtils.makeDirectory(plainHome, { createAncestors: true });
  await IOUtils.makeDirectory(PathUtils.join(omarchyHome, ".local", "share", "omarchy"), {
    createAncestors: true,
  });
  // browser.toml pins source=builtin for other tests; here the default source, and no explicit
  // Omarchy path (an explicit path is an opt-in, decision A1), so only detection decides.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.pollMs", 100],
      ["ui.systemUsesDarkTheme", 1],
    ],
    clear: [["vimma.theme.omarchyPath"], [APPEARANCE_PREF]],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  await focusContent(tab.linkedBrowser);
  registerCleanupFunction(async () => {
    ThemeHost.setConfig(DEFAULT_THEME);
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await ThemeHost.detectOmarchy(realHome);
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await SpecialPowers.popPrefEnv();
    await IOUtils.remove(root, { recursive: true });
  });
});

add_task(async function without_omarchy_nothing_polls_and_the_builtin_shows() {
  Assert.equal(await ThemeHost.detectOmarchy(plainHome), false, "no Omarchy under this HOME");
  await waitForBar(VIMMA_DARK_BAR, "the built-in vimma palette");
  const s = ThemeHost.status;
  Assert.equal(s.omarchy, false, "Omarchy is not installed");
  Assert.equal(s.polling, false, "no poll timer runs");
  Assert.equal(s.source, "builtin", "the source is the built-in palette");
  Assert.equal(s.state, "builtin", "and nothing was looked for");
  Assert.deepEqual(s.warnings, [], "nothing to warn about");
  Assert.equal(await ThemeHost.followsOmarchy(), false, "the start page gets the :theme tip");
});

add_task(async function with_omarchy_the_poll_runs_under_that_home() {
  Assert.equal(await ThemeHost.detectOmarchy(omarchyHome), true, "~/.local/share/omarchy");
  await TestUtils.waitForCondition(() => ThemeHost.status.state === "missing", "checked");
  Assert.equal(ThemeHost.status.polling, true, "the poll runs");
  Assert.equal(ThemeHost.status.source, "omarchy", "following Omarchy");
  Assert.equal(
    ThemeHost.status.path,
    PathUtils.join(omarchyHome, ".local", "state", "omarchy", "current", "theme"),
    "the default theme path is under that HOME",
  );
  Assert.equal(await ThemeHost.followsOmarchy(), true, "no :theme tip on Omarchy");
  await ThemeHost.detectOmarchy(plainHome);
  Assert.equal(ThemeHost.status.polling, false, "no Omarchy again: the poll stops");
});

add_task(async function the_hook_is_not_looked_for_without_omarchy() {
  const hooks = PathUtils.join(plainHome, ".config", "omarchy", "hooks");
  await IOUtils.makeDirectory(hooks, { createAncestors: true });
  try {
    Assert.equal(
      await OmarchyHook.syncIfInstalled(plainHome, false),
      "no-omarchy",
      "Omarchy not detected: the hooks directory is not even read",
    );
    Assert.ok(!(await IOUtils.exists(PathUtils.join(hooks, "theme-set.d"))), "nothing was written");
    Assert.equal(await OmarchyHook.syncIfInstalled(plainHome, true), "installed", "detected");
  } finally {
    Services.prefs.clearUserPref("vimma.theme.omarchyHookInstalled");
    await IOUtils.remove(PathUtils.join(plainHome, ".config"), { recursive: true });
  }
});

add_task(async function theme_switches_the_builtin_palette_live_and_keeps_it() {
  await ThemeHost.detectOmarchy(plainHome);
  await waitForBar(VIMMA_DARK_BAR, "a dark desktop: vimma dark");

  await runCommand("theme light", "theme: light");
  await waitForBar(VIMMA_LIGHT_BAR, ":theme light turns the bar light at once");
  Assert.equal(Services.prefs.getStringPref(APPEARANCE_PREF, ""), "light", "kept in the pref");
  Assert.ok(!ThemeHost.css.includes("@media"), "one block: the system no longer decides");

  await runCommand("theme", "theme: dark");
  await waitForBar(VIMMA_DARK_BAR, "bare :theme switches to the other one");
  Assert.equal(Services.prefs.getStringPref(APPEARANCE_PREF, ""), "dark", "kept");

  await runCommand("theme system", "theme: system (dark now)");
  Assert.ok(!Services.prefs.prefHasUserValue(APPEARANCE_PREF), "system is the default again");
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  await waitForBar(VIMMA_LIGHT_BAR, "following the system again: a light desktop is light");
  await SpecialPowers.popPrefEnv();
  await waitForBar(VIMMA_DARK_BAR, "and dark again");

  await runCommand("theme blue", 'theme: "blue" is not dark, light or system');
  Assert.ok(!Services.prefs.prefHasUserValue(APPEARANCE_PREF), "a bad word changes nothing");
});

add_task(async function on_omarchy_theme_keeps_the_omarchy_colours_and_says_so() {
  const dir = PathUtils.join(omarchyHome, ".local", "state", "omarchy", "current", "theme");
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  const palette = { ...TOKYO_NIGHT, dark_background: OMARCHY_BAR };
  const toml = Object.entries(palette).map(([k, v]) => `${k} = "${v}"`);
  await IOUtils.writeUTF8(PathUtils.join(dir, "colors.toml"), toml.join("\n"));
  try {
    await ThemeHost.detectOmarchy(omarchyHome);
    await waitForBar(OMARCHY_BAR, "the Omarchy theme");
    await runCommand(
      "theme light",
      "theme: light; your Omarchy theme is shown, this is for the built-in one",
    );
    Assert.equal(Services.prefs.getStringPref(APPEARANCE_PREF, ""), "light", "still kept");
    // Three polls: the Omarchy colours stay.
    await new Promise((r) => setTimeout(r, 300));
    Assert.equal(barBackground(), rgb(OMARCHY_BAR), "Omarchy wins");
  } finally {
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(PathUtils.join(omarchyHome, ".local", "state"), { recursive: true });
    await ThemeHost.detectOmarchy(plainHome);
  }
});

add_task(async function config_toml_wins_over_theme() {
  await ThemeHost.detectOmarchy(plainHome);
  ThemeHost.setConfig({ ...DEFAULT_THEME, appearance: "light" });
  await waitForBar(VIMMA_LIGHT_BAR, "[theme] appearance = light, on a dark desktop");
  await runCommand(
    "theme dark",
    'theme: config.toml sets [theme] appearance = "light"; change it there',
  );
  Assert.ok(!Services.prefs.prefHasUserValue(APPEARANCE_PREF), "the pref is left alone");
  // Three polls: nothing may change.
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(barBackground(), rgb(VIMMA_LIGHT_BAR), "still light");
  ThemeHost.setConfig(DEFAULT_THEME);
  await waitForBar(VIMMA_DARK_BAR, "without it, the system's dark");
});

add_task(async function the_start_page_shows_the_tip_only_off_omarchy() {
  const tip = async () => {
    const loaded = BrowserTestUtils.waitForNewTab(gBrowser, START, true);
    BrowserCommands.openTab();
    const tab = await loaded;
    let shown;
    await TestUtils.waitForCondition(async () => {
      shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        const el = content.document.getElementById("vimma-theme-tip");
        return el?.dataset.ready === "true" ? !el.hidden : undefined;
      });
      return shown !== undefined;
    }, "the tip is decided");
    BrowserTestUtils.removeTab(tab);
    return shown;
  };
  await ThemeHost.detectOmarchy(plainHome);
  Assert.equal(await tip(), true, "without Omarchy the start page says :theme");
  await ThemeHost.detectOmarchy(omarchyHome);
  Assert.equal(await tip(), false, "on Omarchy it does not");
});

add_task(async function about_vimma_says_built_in_and_how_to_change_it() {
  await ThemeHost.detectOmarchy(plainHome);
  const open = async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma");
    const browser = tab.linkedBrowser;
    await TestUtils.waitForCondition(
      () => browser.contentDocument?.documentElement?.dataset.ready === "true",
      "about:vimma rendered",
    );
    const text = browser.contentDocument.getElementById("theme")?.textContent ?? "";
    BrowserTestUtils.removeTab(tab);
    return text;
  };
  let theme = await open();
  Assert.stringContains(theme, "built in", "the source is the built-in palette");
  Assert.ok(!/omarchy|colors\.toml/i.test(theme), `no Omarchy wording: ${theme}`);
  Assert.stringContains(theme, "system (the default; :theme dark, :theme light or :theme system)");

  Services.prefs.setStringPref(APPEARANCE_PREF, "light");
  theme = await open();
  Assert.stringContains(theme, "light (:theme;", "a :theme choice says so");
  Services.prefs.clearUserPref(APPEARANCE_PREF);

  ThemeHost.setConfig({ ...DEFAULT_THEME, appearance: "dark" });
  theme = await open();
  Assert.stringContains(theme, "dark (config.toml; change [theme] appearance in config.toml)");
  ThemeHost.setConfig(DEFAULT_THEME);

  await ThemeHost.detectOmarchy(omarchyHome);
  theme = await open();
  Assert.stringContains(theme, "Omarchy path", "on Omarchy the Omarchy rows are back");
});
