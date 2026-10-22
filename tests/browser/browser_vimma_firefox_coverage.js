/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-keys.md decision 12 (sub-PR 3). Compares the window's real keys with
// the inventory, FIREFOX_SHORTCUTS, so a Firefox upgrade that adds, drops or moves a shortcut
// fails here, in the upgrade PR, with the table row to add or drop (docs/rebase.md step 4). On
// macOS the inventory is FIREFOX_SHORTCUTS_MACOS: accel is cmd, and macOS has keys of its own.

"use strict";

/* global focusContent, recordPageKeys, waitForPageKey -- from head.js */
/* global KeyEvent, todo -- mochitest window globals */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { firefoxShortcuts, xulKeyChord } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/firefox-keys.mjs",
);
const { getAction } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/actions.mjs");
const { makeChordText, parseKey } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keys.mjs",
);
const { ShortcutUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ShortcutUtils.sys.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const MAC = AppConstants.platform == "macosx";
/** This platform's inventory. */
const FIREFOX_SHORTCUTS = firefoxShortcuts({ mac: MAC });

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = ROOT + "file_vimma_plain.html";

/** Rows of `<key>` elements: the main keyset, the DevTools' and the conditional ones. */
const KEYSET_ROWS = FIREFOX_SHORTCUTS.filter((r) => r.source === "main" || r.source === "devtools");

const dir = PathUtils.join(PathUtils.tempDir, `vimma-firefox-coverage-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");
let writes = 0;
/** Writes config.toml and reads it at once. */
async function useConfig(text) {
  writes++;
  await IOUtils.writeUTF8(file, `schema = 2\n${text}\n${"#".repeat(writes)}\n`);
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "config.toml applies");
}

/**
 * Every `<key>` of the window's keysets with its chord, add-ons' own keysets left out (they
 * are the add-on's, set in about:addons).
 */
function windowKeys() {
  return [...document.querySelectorAll('keyset:not([id^="ext-keyset-id-"]) key')].map((el) => ({
    el,
    chord: xulKeyChord(
      {
        key: el.getAttribute("key"),
        keycode: el.getAttribute("keycode"),
        modifiers: el.getAttribute("modifiers"),
      },
      { mac: MAC },
    ),
  }));
}

/** The inventory row for a `<key>`: by its id, or by its chord for Firefox's unnamed keys. */
function rowOf({ el, chord }) {
  return KEYSET_ROWS.find((r) => (el.id ? r.id === el.id : !r.id && r.chord === chord));
}

/**
 * The key and modifiers a US keyboard sends for a chord: Vimma's notation folds shift into
 * symbols (`ctrl+}`) and XUL writes `modifiers="accel,shift"`, so the event has shift on.
 * @param {string} text
 */
function keyEventOf(text) {
  const c = parseKey(text);
  const NAMED = {
    esc: "KEY_Escape",
    tab: "KEY_Tab",
    left: "KEY_ArrowLeft",
    right: "KEY_ArrowRight",
    home: "KEY_Home",
    delete: "KEY_Delete",
    pageup: "KEY_PageUp",
    pagedown: "KEY_PageDown",
    plus: "+",
    minus: "-",
  };
  const fn = /^f(\d+)$/.exec(c.key);
  let key = fn ? `KEY_F${fn[1]}` : (NAMED[c.key] ?? c.key);
  let shiftKey = c.shift;
  if (key.length === 1 && '~!@#$%^&*()_+{}|:"<>?'.includes(key)) shiftKey = true;
  if (key.length === 1 && shiftKey && /[a-z]/.test(key)) key = key.toUpperCase();
  return { key, mods: { ctrlKey: c.ctrl, altKey: c.alt, metaKey: c.meta, shiftKey } };
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", file],
      // A caret-browsing toggle then flips the pref at once instead of asking.
      ["accessibility.warn_on_browsewithcaret", false],
    ],
  });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await ConfigHost.reload();
  // DevTools hook their keyset in after startup, and Fluent fills the letters in after load.
  await TestUtils.waitForCondition(
    () => document.getElementById("devtoolsKeyset"),
    "the DevTools keyset is in",
  );
  await TestUtils.waitForCondition(
    () =>
      windowKeys().every(
        ({ el }) =>
          !el.hasAttribute("data-l10n-id") || el.hasAttribute("key") || el.hasAttribute("keycode"),
      ),
    "Fluent filled every key",
  );
});

add_task(async function every_keyset_key_is_an_inventory_row_and_every_row_a_key() {
  const keys = windowKeys().filter((k) => k.chord);
  for (const k of keys) {
    const row = rowOf(k);
    Assert.ok(
      row,
      `Firefox shortcut ${k.el.id || "(no id)"} (${k.chord}) is new: add it to FIREFOX_SHORTCUTS with a fate`,
    );
    if (row) Assert.equal(k.chord, row.chord, `${row.id || row.chord} keeps its chord`);
  }
  for (const row of KEYSET_ROWS) {
    if (row.conditional) continue;
    Assert.ok(
      keys.some((k) => rowOf(k) === row),
      `${row.id || row.chord} (${row.chord}) is gone upstream: drop its row`,
    );
  }
});

add_task(async function a_b_c_keys_are_disabled_a_b_chords_bound_c_chords_unbound() {
  for (const k of windowKeys().filter((key) => key.chord)) {
    const row = rowOf(k);
    if (!row || row.fate === "d") continue;
    Assert.equal(k.el.getAttribute("disabled"), "true", `${row.id || row.chord} is disabled`);
  }
  const { keymap } = VimmaHost._state(window);
  const bound = (chord) =>
    ["normal", "insert"].some((m) => keymap.trie(m).children.get(chord)?.action);
  for (const row of FIREFOX_SHORTCUTS) {
    if (row.action && !row.unbound) {
      Assert.equal(
        keymap.trie("normal").children.get(row.chord)?.action?.name,
        row.action,
        `${row.chord} runs ${row.action}`,
      );
    }
    // A conditional row's chord can be Vimma's own key (ctrl+alt+r, ctrl+^), and a row whose
    // chord another row's action owns (ctrl+shift+w) is off through that binding.
    const owned = FIREFOX_SHORTCUTS.some((o) => o.chord === row.chord && o.action);
    if (row.fate === "c" && !row.conditional && !owned) {
      Assert.ok(!bound(row.chord), `${row.chord} (${row.id}) is unbound`);
    }
  }
});

add_task(async function firefoxs_out_of_keyset_shortcuts_are_all_inventory_rows() {
  const NAMED = {
    tab: "TAB",
    pageup: "PAGE_UP",
    pagedown: "PAGE_DOWN",
    up: "UP",
    down: "DOWN",
    left: "LEFT",
    right: "RIGHT",
    home: "HOME",
    end: "END",
    esc: "ESCAPE",
    enter: "RETURN",
    space: "SPACE",
    backspace: "BACK_SPACE",
    delete: "DELETE",
    insert: "INSERT",
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
  };
  const chords = new Set(FIREFOX_SHORTCUTS.map((r) => r.chord));
  let swept = 0;
  for (const [name, vk] of Object.entries(NAMED)) {
    for (let bits = 0; bits < 16; bits++) {
      const mods = {
        ctrl: !!(bits & 1),
        shift: !!(bits & 2),
        alt: !!(bits & 4),
        meta: !!(bits & 8),
      };
      const event = new KeyboardEvent("keydown", {
        keyCode: KeyEvent[`DOM_VK_${vk}`],
        ctrlKey: mods.ctrl,
        shiftKey: mods.shift,
        altKey: mods.alt,
        metaKey: mods.meta,
      });
      const action = ShortcutUtils.getSystemActionForEvent(event);
      swept++;
      if (action == null) continue;
      const chord = makeChordText(name, mods);
      Assert.ok(
        chords.has(chord),
        `Firefox shortcut ${chord} (ShortcutUtils ${action}) is new: add it to FIREFOX_SHORTCUTS with a fate`,
      );
    }
  }
  Assert.equal(swept, Object.keys(NAMED).length * 16, "every combination swept");
});

add_task(async function out_of_keyset_keys_unbound_change_nothing() {
  // Every chrome row's action without its Firefox chord, and `'` (fate c) in a page.
  await useConfig(
    [
      "[keys]",
      'next_tab = ["prefix+n"]',
      'previous_tab = ["prefix+p"]',
      'close_tab = ["prefix+shift+x"]',
      "move_tab_left = []",
      "move_tab_right = []",
      "caret_browsing = []",
    ].join("\n"),
  );
  const first = gBrowser.selectedTab;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  const browser = tab.linkedBrowser;
  await recordPageKeys(browser);
  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  const order = () => [...gBrowser.tabs];
  const before = order();
  const chords = [
    ...FIREFOX_SHORTCUTS.filter((r) => r.source === "chrome").map((r) => r.chord),
    ...FIREFOX_SHORTCUTS.filter((r) => r.source === "page" && r.fate === "c").map((r) => r.chord),
  ];
  for (const [i, chord] of chords.entries()) {
    const { key, mods } = keyEventOf(chord);
    EventUtils.synthesizeKey(key, mods);
    // A key the page sees after it: Firefox's chrome handlers for the chord have run by then.
    const marker = String.fromCharCode(0x61 + i);
    EventUtils.synthesizeKey(marker);
    Assert.ok(await waitForPageKey(browser, [marker]), `the page saw the key after ${chord}`);
    Assert.equal(gBrowser.selectedTab, tab, `${chord} selects no other tab`);
    Assert.deepEqual(order(), before, `${chord} moves and closes no tab`);
    Assert.ok(!Services.prefs.getBoolPref("accessibility.browsewithcaret"), `${chord}: no caret`);
    Assert.ok(
      !gBrowser.isFindBarInitialized(tab) || gBrowser.getCachedFindBar(tab).hidden,
      `${chord} opens no find bar`,
    );
  }
  Assert.ok(first.isConnected, "the first tab is still open");
  BrowserTestUtils.removeTab(tab);
  await IOUtils.remove(file);
  await ConfigHost.reload();
});

add_task(async function the_menu_bars_access_keys_stay() {
  if (MAC) {
    // macOS has no menu access keys: Firefox sets ui.key.menuAccessKey to 0 there
    // (modules/libpref/init/StaticPrefList.yaml), so no alt+letter opens a menu.
    Assert.equal(Services.prefs.getIntPref("ui.key.menuAccessKey"), 0, "no menu access key");
    const rows = FIREFOX_SHORTCUTS.filter((r) => r.source === "menubar");
    Assert.deepEqual(rows, [], "so the macOS inventory has no menu bar rows");
    return;
  }
  const menus = [...document.querySelectorAll("#main-menubar > menu")];
  const keys = menus.map((m) => `alt+${m.getAttribute("accesskey")?.toLowerCase()}`);
  const rows = FIREFOX_SHORTCUTS.filter((r) => r.source === "menubar").map((r) => r.chord);
  Assert.deepEqual(keys.toSorted(), rows.toSorted(), "each menu keeps its access key, as listed");
});

/**
 * Chords whose action a real key event does not reach yet, each with its issue. A `todo` fails
 * as an unexpected pass once the issue is fixed, so the entry cannot outlive the bug.
 * @type {Record<string, string>}
 */
const KNOWN_GAPS = {};

add_task(async function real_key_events_for_each_firefox_chord_run_vimmas_action() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  // Records the action instead of running it: new_window, quit and the rest must not happen.
  /** @type {string[]} */
  const ran = [];
  const run = VimmaHost._run;
  VimmaHost._run = (state, result) => {
    if (result?.kind === "action") ran.push(result.action.id);
  };
  registerCleanupFunction(() => (VimmaHost._run = run));
  try {
    for (const row of FIREFOX_SHORTCUTS) {
      if (!row.action || row.unbound || row.when) continue;
      const { key, mods } = keyEventOf(row.chord);
      const count = ran.length;
      EventUtils.synthesizeKey(key, mods);
      if (row.chord in KNOWN_GAPS) {
        // Keypresses settle in order, so the sentinel's action marks that this chord's is done.
        const sentinel = keyEventOf("ctrl+shift+c");
        EventUtils.synthesizeKey(sentinel.key, sentinel.mods);
        await TestUtils.waitForCondition(
          () => ran.slice(count).includes(getAction("devtools_inspector").id),
          "the sentinel ctrl+shift+c runs",
        );
        todo(
          ran.slice(count).includes(getAction(row.action).id),
          `${row.chord} runs ${row.action} (${KNOWN_GAPS[row.chord]})`,
        );
        continue;
      }
      await TestUtils.waitForCondition(
        () => ran.length > count,
        `${row.chord} (${key}) runs an action`,
      );
      Assert.equal(ran.at(-1), getAction(row.action).id, `${row.chord} runs ${row.action}`);
    }
  } finally {
    VimmaHost._run = run;
  }
  BrowserTestUtils.removeTab(tab);
});
