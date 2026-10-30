/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m5-config-load.md

"use strict";

/* global focusContent -- from head.js */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { TOKYO_NIGHT, VIMMA_DARK } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/theme.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const NOTICE_ID = "vimma-notice";

const dir = PathUtils.join(PathUtils.tempDir, `vimma-config-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");
const themeDir = PathUtils.join(dir, "omarchy");

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

function noticeText() {
  const n = document.getElementById(NOTICE_ID);
  return n?.matches(":popover-open") ? n.textContent : null;
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const barBackground = () =>
  getComputedStyle(document.getElementById("vimma-statusbar")).backgroundColor;

/**
 * Writes config.toml. Each write gets a size of its own (a trailing comment), so the poll sees a
 * change even when two writes land in the same millisecond.
 */
let writes = 0;
async function writeConfig(text) {
  writes++;
  await IOUtils.writeUTF8(file, `${text}\n${"#".repeat(writes)}\n`);
}

/** ctrl+b, then `key`. */
function prefix(key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key);
}

/** The number of tabs after ctrl+b `key` and a moment for a tab to open. */
async function tabsAfterPrefix(key) {
  const before = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen").then(() => true);
  prefix(key);
  // A key that opens nothing has no event to wait for: a second without a TabOpen means none.
  const timeout = new Promise((r) => setTimeout(() => r(false), 1000));
  const did = await Promise.race([opened, timeout]);
  const after = gBrowser.tabs.length;
  while (gBrowser.tabs.length > before) gBrowser.removeTab(gBrowser.tabs.at(-1));
  return { did, delta: after - before };
}

/** An example.com tab, selected and focused, in normal mode. */
async function openPage(name) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${name}`);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/** Back to the defaults: no config file, nothing reported. */
async function resetConfig() {
  await IOUtils.remove(file, { ignoreAbsent: true });
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "no config file: no errors");
}

add_task(async function setup() {
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", file],
      ["vimma.config.pollMs", 100],
    ],
  });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    // Back to the 2 s poll and the hermetic path before the harness looks for left-over timers.
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await resetConfig();
});

add_task(async function a_remapped_key_applies_after_the_poll() {
  const tab = await openPage("remap");
  Assert.equal((await tabsAfterPrefix("t")).delta, 0, "sanity: prefix+t is unbound by default");

  await writeConfig(`[keys]\nnew_tab = "prefix+t"`);
  await until(() => ConfigHost.config?.keys.new_tab === "prefix+t", "the poll loads the file");
  await focusContent(tab.linkedBrowser);
  Assert.equal((await tabsAfterPrefix("t")).delta, 1, "ctrl+b t opens a tab");
  await focusContent(tab.linkedBrowser);
  Assert.equal((await tabsAfterPrefix("c")).delta, 0, "ctrl+b c no longer does (list replaced)");

  BrowserTestUtils.removeTab(tab);
  await resetConfig();
});

add_task(async function the_help_overlay_marks_and_lists_an_override() {
  const tab = await openPage("help");
  await writeConfig(`[keys]\nnew_tab = "prefix+t"`);
  await until(() => ConfigHost.config?.keys.new_tab === "prefix+t", "the poll loads the file");
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("?", { shiftKey: true });
  const help = () => document.getElementById("vimma-help");
  await until(() => !!help()?.open, "ctrl+b ? opens the overlay");
  const row = (name) => help().querySelector(`[data-action="${name}"]`);
  const part = (name, cls) => row(name).querySelector(`.vimma-help-${cls}`).textContent;
  Assert.equal(part("new_tab", "override"), "*", "the overridden action is marked *");
  Assert.stringContains(part("new_tab", "keys"), "ctrl+b t", "with the file's binding");
  Assert.ok(!part("new_tab", "keys").includes("ctrl+b c"), "not the default one it replaced");
  Assert.equal(part("close_tab", "override"), "", "a default binding is not marked");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !help()?.open, "Esc closes it");
  BrowserTestUtils.removeTab(tab);
  await resetConfig();
});

add_task(async function a_broken_line_keeps_the_old_config_and_shows_file_and_line() {
  const tab = await openPage("broken");
  await writeConfig(`[keys]\nnew_tab = "prefix+t"`);
  await until(() => ConfigHost.config?.keys.new_tab === "prefix+t", "the valid file loads");

  await writeConfig(`[keys]\nnew_tab = "prefix+y"\nnew_tabb = "prefix+u"`);
  await until(() => ConfigHost.errors.length > 0, "the broken file is rejected");
  await until(
    () => segText("error")?.startsWith("config.toml:3:"),
    "the status bar shows config.toml:3:",
  );
  Assert.ok(segText("error").includes('did you mean "new_tab"'), "with the suggestion");
  Assert.equal(ConfigHost.config.keys.new_tab, "prefix+t", "the old config stays active");
  await focusContent(tab.linkedBrowser);
  Assert.equal((await tabsAfterPrefix("t")).delta, 1, "the old mapping still opens a tab");
  await focusContent(tab.linkedBrowser);
  Assert.equal((await tabsAfterPrefix("y")).delta, 0, "the broken file's mapping does not");

  await writeConfig(`[keys]\nnew_tab = "prefix+y"`);
  await until(() => segText("error") === null, "fixing the file clears the error");
  Assert.equal(ConfigHost.config.keys.new_tab, "prefix+y", "and the fixed file is active");

  BrowserTestUtils.removeTab(tab);
  await resetConfig();
});

// A repeating timer leaves the timer list while it fires and comes back after its callback.
// browser-test.js lists the repeating timers once, as the run starts, and reports any timer
// not in that list after each file: a poll firing at that moment was reported as left by the
// first file (browser_vimma_a11y.js on the macOS runner). The poll is a one-shot timer, set
// again at each tick, so the list never depends on that moment.
add_task(async function the_poll_is_not_a_repeating_timer_a_test_could_be_blamed_for() {
  const repeating = () =>
    Cc["@mozilla.org/timer-manager;1"]
      .getService(Ci.nsITimerManager)
      .getTimers()
      .filter(
        (t) =>
          t.type !== Ci.nsITimer.TYPE_ONE_SHOT &&
          t.type !== Ci.nsITimer.TYPE_ONE_SHOT_LOW_PRIORITY &&
          t.name.includes("ConfigHost"),
      )
      .map((t) => `${t.name} ${t.delay}`);
  const busyUntil = Date.now() + 300;
  while (Date.now() < busyUntil) {
    // The poll (every 100 ms here) fires meanwhile; its callback waits for the main thread.
  }
  const listed = repeating();
  await TestUtils.waitForTick();
  await new Promise((r) => setTimeout(r, 150));
  Assert.deepEqual(repeating(), listed, "the harness's list of repeating timers holds");
});

add_task(async function colon_source_reloads_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.pollMs", 600000]] });
  const tab = await openPage("source");
  await writeConfig(`[keys]\nnew_tab = "prefix+t"`);
  Assert.equal(ConfigHost.config?.keys.new_tab, undefined, "not loaded before :source");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("source");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => ConfigHost.config?.keys.new_tab === "prefix+t", ":source loads the file");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await resetConfig();
});

/** Types `:line` and Enter. */
function command(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function colon_source_a_path_replaces_the_config_and_reports_that_file() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.pollMs", 600000]] });
  const tab = await openPage("source-path");
  await writeConfig(`[keys]\nnew_tab = "prefix+t"`);
  await ConfigHost.reload();
  Assert.equal(ConfigHost.config.keys.new_tab, "prefix+t", "sanity: config.toml is in force");

  // Relative: next to config.toml. The file replaces the config, it is not merged into it.
  await IOUtils.writeUTF8(PathUtils.join(dir, "work.toml"), `[keys]\nclose_tab = "prefix+q"\n`);
  command("source work.toml");
  await until(() => ConfigHost.config?.keys.close_tab === "prefix+q", ":source work.toml loads");
  Assert.equal(ConfigHost.config.keys.new_tab, undefined, "config.toml's binding is gone");
  Assert.equal(ConfigHost.path, PathUtils.join(dir, "work.toml"), "the file in force");
  await focusContent(tab.linkedBrowser);
  Assert.equal((await tabsAfterPrefix("t")).delta, 0, "ctrl+b t no longer opens a tab");

  // A missing file: said in the status bar as a config error is, and nothing changes.
  await focusContent(tab.linkedBrowser);
  command("source nope.toml");
  await until(() => segText("error") === "nope.toml: no such file", "a missing file is said");
  Assert.equal(ConfigHost.config.keys.close_tab, "prefix+q", "the config in force stays");

  // A broken file: its own name and line, and nothing changes.
  await IOUtils.writeUTF8(PathUtils.join(dir, "bad.toml"), `[keys]\nnew_tabb = "prefix+u"\n`);
  await focusContent(tab.linkedBrowser);
  command(`source ${PathUtils.join(dir, "bad.toml")}`);
  await until(() => segText("error")?.startsWith("bad.toml:2:"), "bad.toml:2: in the bar");
  Assert.ok(segText("error").includes('did you mean "new_tab"'), "with the suggestion");
  Assert.equal(ConfigHost.config.keys.close_tab, "prefix+q", "the config in force stays");

  // Plain :source goes back to config.toml.
  await focusContent(tab.linkedBrowser);
  command("source");
  await until(() => ConfigHost.config?.keys.new_tab === "prefix+t", ":source reads config.toml");
  Assert.equal(segText("error"), null, "and the error is gone");
  Assert.equal(ConfigHost.path, file, "config.toml is the file in force again");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await resetConfig();
});

add_task(async function colon_config_opens_the_file_and_creates_it_from_the_template() {
  const fresh = PathUtils.join(dir, "fresh", "vimma", "config.toml");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", fresh]] });
  await ConfigHost.reload();
  const tab = await openPage("config");
  const url = `view-source:${PathUtils.toFileURI(fresh)}`;

  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  command("config");
  const shown = await opened;
  Assert.ok(await IOUtils.exists(fresh), "the missing file was created, folders too");
  const text = await IOUtils.readUTF8(fresh);
  Assert.ok(text.startsWith("# Vimma config"), "from the commented template");
  Assert.stringContains(
    text,
    '# new_tab = ["prefix+c", "ctrl+t"]',
    "listing the defaults, commented",
  );
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "the template is a valid config");
  BrowserTestUtils.removeTab(shown);

  // An existing file is opened as it is, never rewritten.
  await IOUtils.writeUTF8(fresh, `[keys]\nnew_tab = "prefix+t"\n`);
  await focusContent(tab.linkedBrowser);
  const again = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  command("config");
  BrowserTestUtils.removeTab(await again);
  Assert.equal(await IOUtils.readUTF8(fresh), `[keys]\nnew_tab = "prefix+t"\n`, "untouched");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await resetConfig();
});

add_task(async function panes_max_refuses_a_third_split() {
  const tab = await openPage("panes");
  await writeConfig(`schema = 2\n[panes]\nmax = 2`);
  await until(() => PaneViews.get(window).max === 2, "[panes] max reaches the pane view");

  prefix("v");
  await until(
    () =>
      gBrowser.selectedTab !== tab &&
      gBrowser.selectedTab.linkedBrowser.currentURI.spec === START &&
      gBrowser.selectedTab.linkedBrowser.contentDocument?.readyState === "complete",
    "the second pane's start page has loaded",
  );
  const view = PaneViews.get(window);
  Assert.equal(leaves(view.panes).length, 2, "two panes");
  const tabs = gBrowser.tabs.length;
  prefix("v");
  await until(() => noticeText()?.includes("at most 2 panes"), "the third split is refused");
  Assert.equal(leaves(view.panes).length, 2, "still two panes");
  Assert.equal(gBrowser.tabs.length, tabs, "and no tab was opened");

  while (view.panes) view.close();
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  document.getElementById(NOTICE_ID)?.hidePopover?.();
  await resetConfig();
  Assert.equal(PaneViews.get(window).max, 4, "the default comes back without the file");
});

add_task(async function theme_source_and_colors_feed_the_theme() {
  // An Omarchy theme with its own status bar colour, followed as by default.
  const palette = { ...TOKYO_NIGHT, dark_background: "#405060" };
  const omarchy = Object.entries(palette)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), omarchy);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", themeDir],
      ["vimma.theme.pollMs", 100],
      // a dark desktop: the built-in vimma palette's dark variant
      ["ui.systemUsesDarkTheme", 1],
    ],
  });
  await until(() => barBackground() === rgb("#405060"), "the Omarchy theme is followed");

  await writeConfig(`[theme]\nsource = "file"`);
  await until(
    () => barBackground() === rgb(VIMMA_DARK.dark_background),
    '"file": the built-in vimma',
  );

  await writeConfig(`schema = 2\n[theme]\nsource = "file"\nname = "tokyo-night"`);
  await until(
    () => barBackground() === rgb(TOKYO_NIGHT.dark_background),
    'name = "tokyo-night": Tokyo Night',
  );

  await writeConfig(`schema = 2\n[theme]\nname = "tokyo-night"`);
  await until(
    () => barBackground() === rgb("#405060"),
    "an Omarchy theme wins over the name: Omarchy users see no change",
  );

  await writeConfig(`[theme]\nsource = "file"\n[theme.colors]\ndark_background = "#203040"`);
  await until(() => barBackground() === rgb("#203040"), "[theme.colors] overrides it");

  await resetConfig();
  await until(() => barBackground() === rgb("#405060"), "no config: Omarchy again");
  await SpecialPowers.popPrefEnv();
});

add_task(async function workspaces_from_the_file_apply_live() {
  const { WorkspaceStore } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
  );
  const { WindowWorkspaces } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
  );
  const def = () => WorkspaceStore.definitions.workspaces.find((w) => w.name === "cfgws");
  await writeConfig(`[workspaces.cfgws]\ncolor = "green"\nicon = "tree"`);
  await until(() => def()?.source === "config", "[workspaces] reaches the store");
  Assert.equal(def().color, "green", "with its colour");
  Assert.ok(def().userContextId > 0, "and a container of its own");
  await until(
    () => WindowWorkspaces.get(window).model.workspaces.some((w) => w.id === def().id),
    "the window has the new workspace",
  );

  await resetConfig();
  await until(() => def()?.source === "runtime", "out of the file it becomes runtime");
  await WorkspaceStore.deleteWorkspace(def().id, { confirmed: true });
});
