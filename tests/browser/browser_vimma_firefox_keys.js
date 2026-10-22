/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/key-handling-batch.md § 1, docs/specs/firefox-keys.md (sub-PR 1). Firefox's
// own shortcuts on Vimma's keys are off: ctrl+w, ctrl+u, ctrl+h, ctrl+d, ctrl+o, ctrl+i, ctrl+k,
// ctrl+b never run Firefox's action, in any mode. ctrl+t, ctrl+l and ctrl+tab are Vimma
// bindings now, with Firefox's meaning, and every Firefox key on a chord Vimma binds is off
// (bound means off). [firefox] disable / enable in config.toml change the rest; about:vimma
// lists it. On macOS Firefox's accel is cmd: its keys are the macOS inventory's
// (FIREFOX_SHORTCUTS_MACOS), and disable = "all" keeps cmd+q (docs/specs/macos-build.md).

"use strict";

/* global focusContent, recordPageKeys, waitForPageKey -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
);
const { xulKeyChord } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/firefox-keys.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

/** Firefox's accel is cmd on macOS, where its keys move off Vimma's ctrl chords. */
const MAC = AppConstants.platform == "macosx";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = ROOT + "file_vimma_plain.html";

/** Vimma's ctrl keys that Firefox binds on Linux. */
const LETTERS = ["w", "u", "h", "d", "o", "i", "k", "b"];
/**
 * The overlapping Firefox shortcuts, by chord: `<key>` id. Linux (Firefox 157) has one on each
 * of LETTERS; macOS (Firefox 158) only ctrl+u, the open-tabs sidebar.
 */
const OVERLAP = MAC
  ? { u: "viewOpenTabsSidebarKb" }
  : {
      w: "key_close",
      u: "key_viewSource",
      h: "key_gotoHistory",
      d: "addBookmarkAsKb",
      o: "openFileKb",
      i: "key_viewInfo",
      k: "key_search",
      b: "viewBookmarksSidebarKb",
    };

const dir = PathUtils.join(PathUtils.tempDir, `vimma-firefox-keys-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");
let writes = 0;
/** Writes config.toml and reads it at once (`:source`). */
async function useConfig(text) {
  writes++;
  await IOUtils.writeUTF8(file, `schema = 2\n${text}\n${"#".repeat(writes)}\n`);
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "config.toml applies");
}

/**
 * Counts the command events that reach the `<key>` element itself (not its <command>): what
 * GlobalKeyListener sends when Firefox's shortcut runs. Vimma's actions run the <command>
 * directly, so this counts Firefox's key only.
 * @param {string} id
 */
function spyKeyElement(id) {
  const key = document.getElementById(id);
  Assert.ok(key, `#${id} exists`);
  const spy = { count: 0 };
  const listener = () => spy.count++;
  key.addEventListener("command", listener, true);
  registerCleanupFunction(() => key.removeEventListener("command", listener, true));
  return spy;
}

/**
 * Counts the commands a `<key>` runs: a `command` event on the key, or on its <command>.
 * @param {string} id
 */
function spyKey(id) {
  const key = document.getElementById(id);
  Assert.ok(key, `#${id} exists`);
  const targets = [key, document.getElementById(key.getAttribute("command") ?? "")].filter(Boolean);
  const spy = { count: 0 };
  const listener = () => spy.count++;
  for (const t of targets) t.addEventListener("command", listener, true);
  registerCleanupFunction(() => {
    for (const t of targets) t.removeEventListener("command", listener, true);
  });
  return spy;
}

/** A plain page, focused, with its keys recorded, in insert mode (`i`: no text field). */
async function insertModePage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  const browser = tab.linkedBrowser;
  await recordPageKeys(browser);
  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  return tab;
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await ConfigHost.reload();
});

add_task(async function the_overlapping_and_the_bound_keys_are_disabled_the_others_not() {
  for (const id of Object.values(OVERLAP)) {
    Assert.equal(document.getElementById(id).getAttribute("disabled"), "true", `#${id} is off`);
  }
  // Bound means off (firefox-keys decision 2): Vimma binds these chords, in every keyset. On
  // macOS they are cmd chords, off under the default "all", and cmd+q stays (the macOS task).
  for (const id of [
    "key_newNavigatorTab",
    "focusURLBar",
    ...(MAC ? [] : ["key_quitApplication"]),
    "goBackKb",
    "key_reload2",
    "key_fullZoomEnlarge",
    "key_privatebrowsing",
    "key_restoreLastClosedTabOrWindowOrSession",
  ]) {
    Assert.equal(document.getElementById(id).getAttribute("disabled"), "true", `#${id} is off`);
  }
  await TestUtils.waitForCondition(
    () => document.getElementById("key_toggleToolbox"),
    "the DevTools keys are hooked in",
  );
  await TestUtils.waitForCondition(
    () => document.getElementById("key_toggleToolbox").getAttribute("disabled") === "true",
    "the DevTools' keyset is watched too: ctrl+shift+i is Vimma's devtools",
  );
  // Decision 16: these are Vimma bindings on Firefox's own keys now, so Firefox's are off.
  for (const id of ["key_find", "key_search2", "viewBookmarksToolbarKb"]) {
    Assert.equal(document.getElementById(id).getAttribute("disabled"), "true", `#${id} is off`);
  }
});

add_task(async function no_overlapping_shortcut_fires_and_the_page_gets_the_key() {
  const tab = await insertModePage();
  const browser = tab.linkedBrowser;
  const tabs = gBrowser.tabs.length;
  for (const letter of LETTERS) {
    const id = OVERLAP[letter];
    const spy = id ? spyKey(id) : { count: 0 };
    EventUtils.synthesizeKey(letter, { ctrlKey: true });
    if (letter === "b") {
      // Vimma's prefix in every mode: it waits for the next key, which Esc cancels.
      EventUtils.synthesizeKey("KEY_Escape");
      EventUtils.synthesizeKey("z");
      Assert.ok(await waitForPageKey(browser, ["z"]), "the key after ctrl+b Esc reached the page");
    } else {
      Assert.ok(
        await waitForPageKey(browser, [letter, `!${letter}`]),
        `the page got ctrl+${letter}`,
      );
    }
    Assert.equal(spy.count, 0, `ctrl+${letter} did not run #${id ?? "a Firefox key"}`);
  }
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened or closed (ctrl+w, ctrl+u)");
  Assert.equal(gBrowser.selectedTab, tab, "the page's tab is still selected");
  Assert.ok(!SidebarController.isOpen, "no sidebar opened (ctrl+h, ctrl+b)");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ctrl_w_in_normal_mode_with_one_pane_closes_nothing() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  const browser = tab.linkedBrowser;
  await recordPageKeys(browser);
  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  // <C-w> pane keys need two panes: with one, ctrl+w is the page's, never Firefox's close.
  Assert.ok(await waitForPageKey(browser, ["w", "!w"]), "the page got ctrl+w");
  Assert.ok(tab.isConnected, "the tab is still open");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ctrl_t_ctrl_l_and_ctrl_tab_are_vimmas_with_firefoxs_meaning() {
  const first = gBrowser.selectedTab;
  const tab = await insertModePage();
  const spies = ["key_newNavigatorTab", "focusURLBar"].map(spyKeyElement);
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const { target: fresh } = await opened;
  Assert.ok(fresh, "ctrl+t opened a tab");
  BrowserTestUtils.removeTab(fresh);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tab, "back on the page");
  await focusContent(tab.linkedBrowser);

  EventUtils.synthesizeKey("l", { ctrlKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "ctrl+l focuses the URL bar");

  gBrowser.selectedBrowser.focus();
  const selected = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabSelect");
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  await selected;
  Assert.notEqual(gBrowser.selectedTab, tab, "ctrl+tab switched tabs");
  Assert.deepEqual(
    spies.map((s) => s.count),
    [0, 0],
    "Vimma's bindings ran, not Firefox's keys",
  );
  gBrowser.selectedTab = first;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function about_vimma_lists_what_is_off() {
  // A list names chords no key has (ctrl+e, ctrl+y on Linux; on macOS all but ctrl+u); "all",
  // the default, names none.
  const list = [...LETTERS, "e", "y"].map((l) => `"ctrl+${l}"`).join(", ");
  await useConfig(`[firefox]\ndisable = [${list}]`);
  const data = await AboutVimma.collect(window);
  const off = Object.fromEntries(data.firefoxKeys.off.map((k) => [k.chord, k.id]));
  for (const [letter, id] of Object.entries(OVERLAP)) {
    Assert.equal(off[`ctrl+${letter}`], id, `about:vimma lists ctrl+${letter} (#${id})`);
  }
  const unmatched = [...LETTERS.filter((l) => !(l in OVERLAP)), "e", "y"].map((l) => `ctrl+${l}`);
  Assert.deepEqual(data.firefoxKeys.unmatched, unmatched, "no Firefox key on these");
  Assert.stringContains(AboutVimma.report(data), "Firefox shortcuts on: ", "the report says so");
});

add_task(async function disable_all_turns_off_the_unbound_ones_and_enable_keeps_one() {
  // Firefox's new-tab key is accel+t, cmd+t on macOS. Enabling ctrl+t there would only drop
  // Vimma's ctrl+t binding and leave no key to open the tab.
  const newTab = MAC ? "meta+t" : "ctrl+t";
  await useConfig(`[firefox]\ndisable = "all"\nenable = ["${newTab}"]`);
  Assert.equal(document.getElementById("focusURLBar").getAttribute("disabled"), "true");
  Assert.equal(document.getElementById("key_find").getAttribute("disabled"), "true");
  if (!MAC) {
    Assert.equal(
      document.getElementById("key_quitApplication").getAttribute("disabled"),
      "true",
      "ctrl+q is Vimma's quit now",
    );
  }
  Assert.ok(!document.getElementById("key_newNavigatorTab").hasAttribute("disabled"), "enabled");

  const tab = await insertModePage();
  const spy = spyKeyElement("key_find");
  EventUtils.synthesizeKey("f", { accelKey: true });
  Assert.ok(await waitForPageKey(tab.linkedBrowser, ["f", "!f"]), "the page got accel+f");
  Assert.equal(spy.count, 0, "accel+f no longer opens Firefox's find bar");

  // accel+t: Firefox's key is on. On Linux Vimma binds ctrl+t too and takes the keydown; on
  // macOS Vimma does not bind cmd+t. Either way exactly one tab opens.
  const tabs = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { accelKey: true });
  const { target: fresh } = await opened;
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(gBrowser.tabs.length, tabs + 1, "one tab, not two");
  BrowserTestUtils.removeTab(fresh);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function enable_gives_one_back_and_a_list_replaces_the_default() {
  if (MAC) {
    await enableAndListOnMacos();
    return;
  }
  // ctrl+j unbound and not on the list: Firefox's again, as the list replaces "all".
  await useConfig(`[keys]\nweb_search = []\n[firefox]\ndisable = ["ctrl+u"]\nenable = []`);
  Assert.ok(!document.getElementById("key_search2").hasAttribute("disabled"), "all is undone");
  Assert.equal(document.getElementById("key_find").getAttribute("disabled"), "true", "bound");
  Assert.equal(
    document.getElementById("key_close").getAttribute("disabled"),
    "true",
    "ctrl+w starts Vimma's ctrl+w h: bound, so off whatever the list says",
  );
  Assert.equal(document.getElementById("focusURLBar").getAttribute("disabled"), "true", "bound");
  Assert.equal(document.getElementById("key_viewSource").getAttribute("disabled"), "true");

  await useConfig(`[firefox]\nenable = ["ctrl+w"]`);
  Assert.ok(!document.getElementById("key_close").hasAttribute("disabled"), "ctrl+w enabled");
  Assert.equal(document.getElementById("key_gotoHistory").getAttribute("disabled"), "true");
  const tab = await insertModePage();
  const closing = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await closing;
  await TestUtils.waitForCondition(() => !tab.isConnected, "an enabled ctrl+w closes the tab");

  await IOUtils.remove(file);
  await ConfigHost.reload();
  Assert.equal(document.getElementById("key_close").getAttribute("disabled"), "true", "default");
});

/**
 * The macOS form of the task above: Firefox's keys there are cmd chords Vimma does not bind, so
 * a list turns off what it names and leaves the rest Firefox's, but for the keys on chords Vimma
 * binds (ctrl+u, F5).
 */
async function enableAndListOnMacos() {
  await useConfig(`[firefox]\ndisable = ["meta+u"]\nenable = []`);
  const off = (id) => document.getElementById(id).getAttribute("disabled") === "true";
  Assert.ok(off("key_viewSource"), "cmd+u is on the list");
  Assert.ok(!off("key_search2"), "all is undone: cmd+alt+f is Firefox's");
  Assert.ok(!off("key_find"), "cmd+f, unbound and not listed, is Firefox's");
  Assert.ok(!off("key_close"), "cmd+w, unbound and not listed, is Firefox's");
  Assert.ok(off("viewOpenTabsSidebarKb"), "ctrl+u is Vimma's: bound, so off");
  Assert.ok(off("key_reload2"), "F5 is Vimma's reload: bound, so off");

  await useConfig(`[firefox]\nenable = ["meta+w"]`);
  Assert.ok(!off("key_close"), "cmd+w enabled");
  Assert.ok(off("key_gotoHistory"), "all turns cmd+shift+h off");
  const tab = await insertModePage();
  const closing = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { metaKey: true });
  await closing;
  await TestUtils.waitForCondition(() => !tab.isConnected, "an enabled cmd+w closes the tab");

  await IOUtils.remove(file);
  await ConfigHost.reload();
  Assert.ok(off("key_close"), "default: all turns cmd+w off");
}

add_task(async function a_key_firefox_re_enables_is_turned_off_again() {
  const key = document.getElementById("key_viewSource");
  key.removeAttribute("disabled");
  await TestUtils.waitForCondition(
    () => key.getAttribute("disabled") === "true",
    "the observer disables it again",
  );
});

// Sub-PR 2 (docs/specs/firefox-keys.md decisions 5, 9, 11).
add_task(async function the_branding_prefs_turn_off_the_alt_tap_and_quick_find() {
  Assert.equal(Services.prefs.getBoolPref("ui.key.menuAccessKeyFocuses"), false, "alt tap");
  Assert.equal(Services.prefs.getBoolPref("accessibility.typeaheadfind.manual"), false, "'");
});

add_task(async function the_default_turns_off_plain_and_function_keys_too() {
  await IOUtils.remove(file, { ignoreAbsent: true });
  await ConfigHost.reload();
  for (const id of ["key_search2", "key_reload", "key_aboutProcesses"]) {
    Assert.equal(document.getElementById(id)?.getAttribute("disabled"), "true", `#${id} off`);
  }
  const data = await AboutVimma.collect(window);
  Assert.deepEqual(data.firefoxKeys.on, [], "about:vimma: no Firefox shortcut on");
});

add_task(async function enable_gives_ctrl_j_back_and_the_overlay_and_about_vimma_list_it() {
  // key_search2 is cmd+alt+f on macOS.
  const search2 = MAC ? "alt+meta+f" : "ctrl+j";
  await useConfig(`[firefox]\nenable = ["${search2}"]`);
  Assert.ok(!document.getElementById("key_search2").hasAttribute("disabled"), `${search2} on`);
  const data = await AboutVimma.collect(window);
  Assert.ok(
    data.firefoxKeys.on.some((k) => k.chord === search2 && k.id === "key_search2"),
    `about:vimma lists ${search2} as on`,
  );
  const state = VimmaHost._state(window);
  state.help.open();
  const row = document.querySelector('#vimma-help [data-action="key_search2"]');
  Assert.ok(row, "the overlay has a row for Firefox's ctrl+j");
  Assert.equal(
    row.closest("section").querySelector("h2").textContent,
    "Firefox (on in config.toml)",
  );
  state.help.close();
});

// docs/specs/macos-build.md behaviour 4 and its Tests section.
add_task(async function accel_is_cmd_and_disable_all_keeps_cmd_q_on_macos() {
  if (!MAC) {
    Assert.ok(true, "macOS only");
    return;
  }
  await useConfig(`[firefox]\ndisable = "all"`);
  const chord = (id) => {
    const el = document.getElementById(id);
    const [key, keycode, modifiers] = ["key", "keycode", "modifiers"].map((a) =>
      el.getAttribute(a),
    );
    return xulKeyChord({ key, keycode, modifiers }, { mac: true });
  };
  Assert.equal(chord("key_newNavigatorTab"), "meta+t", "accel is cmd");
  Assert.equal(chord("key_quitApplication"), "meta+q");
  const quit = document.getElementById("key_quitApplication");
  Assert.ok(!quit.hasAttribute("disabled"), "all keeps cmd+q");
  const data = await AboutVimma.collect(window);
  const off = data.firefoxKeys.off.map((k) => `${k.chord} ${k.id}`);
  for (const k of ["meta+t key_newNavigatorTab", "meta+w key_close", "meta+l focusURLBar"]) {
    Assert.ok(off.includes(k), `about:vimma lists ${k} as off`);
  }
  Assert.ok(!off.some((k) => k.endsWith(" key_quitApplication")), "cmd+q is not listed as off");
});

add_task(async function enabling_a_chord_the_user_binds_is_an_error() {
  writes++;
  await IOUtils.writeUTF8(
    file,
    `schema = 2\n[keys]\nnew_tab = ["ctrl+t"]\n[firefox]\nenable = ["ctrl+t"]\n${"#".repeat(writes)}\n`,
  );
  await ConfigHost.reload();
  Assert.deepEqual(
    ConfigHost.errors.map((e) => e.message),
    ["ctrl+t is bound to new_tab in [keys]; unbind it or drop it here"],
  );
});

add_task(async function a_colon_binding_runs_firefox_by_id_and_shows_in_commands() {
  await useConfig(`[modal.normal]\n"<C-S-y>" = ":firefox cmd_newNavigatorTab"`);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  await focusContent(tab.linkedBrowser);
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("y", { ctrlKey: true, shiftKey: true });
  const { target: fresh } = await opened;
  Assert.ok(fresh, ":firefox cmd_newNavigatorTab opened a tab");
  BrowserTestUtils.removeTab(fresh);

  const state = VimmaHost._state(window);
  state.help.open();
  const row = [...document.querySelectorAll("#vimma-help .vimma-help-row")].find((r) =>
    r.textContent.includes(":firefox cmd_newNavigatorTab"),
  );
  Assert.ok(row, "the overlay lists the : binding");
  Assert.equal(row.closest("section").querySelector("h2").textContent, "Commands");
  state.help.close();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function an_unbound_tab_key_firefox_handles_outside_its_keysets_does_nothing() {
  await useConfig(`[keys]\nnext_tab = ["ctrl+b n"]`);
  const first = gBrowser.selectedTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  gBrowser.selectedTab = first;
  await focusContent(first.linkedBrowser);
  EventUtils.synthesizeKey("KEY_PageDown", { ctrlKey: true });
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(gBrowser.selectedTab, first, "ctrl+pagedown, unbound, selects no other tab");
  BrowserTestUtils.removeTab(tab);
  await IOUtils.remove(file);
  await ConfigHost.reload();
});

add_task(async function an_add_ons_own_shortcut_stays_on() {
  // Extension shortcuts are the add-on's, set in about:addons (docs/specs/firefox-keys.md,
  // out of scope): ExtensionShortcuts puts them in a keyset of their own.
  const ext = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      browser_specific_settings: { gecko: { id: "fk-shortcut@vimma.test" } },
      browser_action: {},
      commands: { _execute_browser_action: { suggested_key: { default: "Alt+Shift+U" } } },
    },
  });
  await ext.startup();
  await ConfigHost.reload();
  const keys = [...document.querySelectorAll('keyset[id^="ext-keyset-id-"] key')];
  Assert.ok(keys.length, "the add-on's keyset is there");
  for (const key of keys) Assert.ok(!key.hasAttribute("disabled"), "its shortcut is on");
  await ext.unload();
});
