/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's third chapter, Your window (docs/specs/setup-v2.md): the address bar and the tab line
// steps.

"use strict";

/* global ConfigHost, AppConstants, found, configFile -- from head_vimma_setup_chapters.js */
/* global removeConfig, press, openFlow, closeFlow, atStep -- from head_vimma_setup_chapters.js */
/* global current, writes -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
);

/** @param {Document} doc @returns {string[]} the keys the step's text names */
const textKeys = (doc) => [...doc.querySelectorAll("#v2-text kbd")].map((k) => k.textContent ?? "");
/** @param {Document} doc @returns {(string | undefined)[]} each choice's drawing: its toolbar */
const drawnToolbars = (doc) =>
  [...doc.querySelectorAll("#v2-choices li")].map(
    (li) => /** @type {HTMLElement | null} */ (li.querySelector(".window"))?.dataset.toolbar,
  );

/** @param {Document} doc @returns {[string | undefined, number][]} each drawing's tab line */
const drawnTabLines = (doc) =>
  [...doc.querySelectorAll("#v2-choices li .window")].map((w) => [
    /** @type {HTMLElement} */ (w).dataset.tabline,
    w.querySelectorAll(".w-tab").length,
  ]);

/** From the welcome screen straight to the window chapter (behaviour 3). */
async function toAddressBar(/** @type {Document} */ doc) {
  await press(doc, "3");
  await atStep(doc, "address_bar");
}

add_task(async function address_bar_step_names_the_keys_in_force() {
  // A failed assertion must not leave the rebound keys to the tasks after it.
  registerCleanupFunction(removeConfig);
  const { tab, doc } = await openFlow();
  await toAddressBar(doc);
  Assert.ok(found(doc.getElementById("v2-progress")).textContent.includes("The window"));
  // macOS binds meta+l where Linux binds alt+d (defaults.mjs, the mac keymap).
  const second = AppConstants.platform === "macosx" ? "meta+l" : "alt+d";
  Assert.deepEqual(textKeys(doc), ["ctrl+l", second, "I", "ctrl+b u"], "the default keymap");
  Assert.deepEqual(drawnToolbars(doc), ["shown", "hidden"], "a drawing of the window per choice");
  // focus_urlbar rebound without alt+d, toggle_toolbar left without a key: the step, open, draws
  // its text again when the file is read (behaviour 12).
  await IOUtils.writeUTF8(
    configFile(),
    'schema = 2\n[ui]\ntabline = "always"\n[keys]\nfocus_urlbar = ["ctrl+k", "ctrl+l"]\n' +
      "toggle_toolbar = []\n",
  );
  await ConfigHost.reload();
  await TestUtils.waitForCondition(() => textKeys(doc).includes("ctrl+k"), "the rebound key");
  Assert.deepEqual(
    drawnTabLines(doc),
    [
      ["always", 1],
      ["always", 1],
    ],
    "the tab line in force",
  );
  Assert.deepEqual(textKeys(doc), ["ctrl+k", "ctrl+l", "I"], "alt+d unbound is left out");
  Assert.ok(
    [...doc.querySelectorAll("#v2-text code")].some((c) => c.textContent === ":toolbar"),
    "an action with no key is named by its command",
  );
  await closeFlow(tab);
});

// toolbar-toggle decision 3 (changed 19 Nov 2026): a fresh profile, with no config.toml, opens
// the step on Hidden, in force and selected, and enter on it writes nothing.
add_task(async function a_fresh_profile_opens_the_address_bar_step_on_hidden() {
  registerCleanupFunction(removeConfig);
  Assert.ok(!(await IOUtils.exists(configFile())), "no config.toml");
  const { tab, doc } = await openFlow();
  await toAddressBar(doc);
  Assert.equal(current(doc), "Hidden", "hidden is in force and selected without the key");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "KEY_Enter");
  await atStep(doc, "tab_line");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written, no file created");
  Assert.ok(
    Services.prefs.getBoolPref("vimma.ui.toolbar.hidden", false),
    "the toolbar stays hidden",
  );
  await closeFlow(tab);
});

add_task(async function address_bar_step_writes_toolbar_and_applies_live() {
  // A failed assertion must not leave the toolbar shown for the tasks after it.
  registerCleanupFunction(removeConfig);
  const { tab, doc } = await openFlow();
  await toAddressBar(doc);
  Assert.equal(current(doc), "Hidden", "hidden is in force without the key");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "k");
  Assert.equal(writes(doc), 'Writes [ui] toolbar = "shown"');
  await press(doc, "KEY_Enter");
  await atStep(doc, "tab_line");
  // A missing file is written as the commented template with the one key set, and nothing else.
  const { setConfigKeysText } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/core/config.mjs",
  );
  const only = setConfigKeysText(null, [{ table: "ui", key: "toolbar", value: "shown" }], {
    mac: AppConstants.platform === "macosx",
  });
  Assert.ok("text" in only, "the edit applies to the template");
  Assert.equal(
    await IOUtils.readUTF8(configFile()),
    ("text" in only && only.text) || "",
    "[ui] toolbar only",
  );
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref("vimma.ui.toolbar.hidden", true),
    "the toolbar shows at once",
  );
  Assert.ok(!document.documentElement.hasAttribute("vimma-toolbar-hidden"), "in this window too");
  // Back: shown is in force now, and enter on it writes nothing.
  await press(doc, "h");
  await atStep(doc, "address_bar");
  Assert.equal(current(doc), "Shown", "back opens on the value in force");
  Assert.equal(writes(doc), "Writes nothing");
  const before = await IOUtils.readUTF8(configFile());
  await press(doc, "KEY_Enter");
  await atStep(doc, "tab_line");
  Assert.equal(await IOUtils.readUTF8(configFile()), before, "nothing written");
  await closeFlow(tab);
  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref("vimma.ui.toolbar.hidden", false),
    "the toolbar is hidden again once the file is gone",
  );
});

/** Whether this window draws the tab line now. */
const tabLineShown = () => document.documentElement.hasAttribute("vimma-tabline");

add_task(async function tab_line_step_writes_tabline_and_applies_live() {
  // A failed assertion must not leave the tab line drawn for the tasks after it.
  registerCleanupFunction(removeConfig);
  const { tab, doc } = await openFlow();
  await toAddressBar(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "tab_line");
  Assert.ok(found(doc.getElementById("v2-place")).textContent.includes("step 2 of 2"));
  Assert.deepEqual(
    [...doc.querySelectorAll("#v2-choices li .name")].map((n) => n.textContent),
    ["Off", "Always", "Only with two or more tabs"],
  );
  // Always draws the line over a single tab, the third choice only once there are two.
  Assert.deepEqual(drawnTabLines(doc), [
    ["off", 0],
    ["always", 1],
    ["auto", 2],
  ]);
  Assert.ok(
    [...doc.querySelectorAll("#v2-text code")].some((c) => c.textContent === ":tabline"),
    "toggle_tabline has no default key: named by its command",
  );
  // tab-line decision 3 (changed 20 Nov 2026, #1403): auto is the default, in force without the
  // key, and enter on it writes nothing. Two tabs are open, so the line is drawn already.
  Assert.equal(current(doc), "Only with two or more tabs", "auto is in force without the key");
  Assert.equal(writes(doc), "Writes nothing");
  await TestUtils.waitForCondition(tabLineShown, "the default draws the line over two tabs");
  const fresh = await IOUtils.readUTF8(configFile()).catch(() => null);
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()).catch(() => null), fresh, "nothing written");
  await press(doc, "h");
  await atStep(doc, "tab_line");
  const { setConfigKeysText } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/core/config.mjs",
  );
  /** Picks the choice `keys` reach, enters it, and checks the whole file and the window. */
  const choose = async (/** @type {string[]} */ keys, /** @type {string} */ value) => {
    await press(doc, ...keys);
    Assert.equal(writes(doc), `Writes [ui] tabline = ${JSON.stringify(value)}`);
    await press(doc, "KEY_Enter");
    await atStep(doc, "stop");
    // The commented template with only [ui] tabline set, whatever the earlier choice wrote.
    const only = setConfigKeysText(null, [{ table: "ui", key: "tabline", value }], {
      mac: AppConstants.platform === "macosx",
    });
    Assert.equal(
      await IOUtils.readUTF8(configFile()),
      ("text" in only && only.text) || "",
      `[ui] tabline = ${value} only`,
    );
    // Two tabs are open (the first one and the setup page), so auto draws the line too.
    await TestUtils.waitForCondition(
      () => tabLineShown() === (value !== "off"),
      `the tab line follows ${value} at once`,
    );
    await press(doc, "h");
    await atStep(doc, "tab_line");
  };
  await choose(["k"], "always");
  Assert.equal(current(doc), "Always", "back opens on the value in force");
  await choose(["k"], "off");
  await choose(["j", "j"], "auto");
  await choose(["k", "k"], "off");
  // Off is in force now: enter on it writes nothing.
  Assert.equal(current(doc), "Off");
  Assert.equal(writes(doc), "Writes nothing");
  const before = await IOUtils.readUTF8(configFile());
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()), before, "nothing written");
  await closeFlow(tab);
});
