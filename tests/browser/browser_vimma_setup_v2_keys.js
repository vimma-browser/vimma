/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's fourth chapter, Your keys (docs/specs/setup-v2.md): the prefix and the hint letters
// (behaviours 9, 18, 25 and 26).

"use strict";

/* global SetupHost, ConfigHost, BUILT_STEPS, found -- from head_vimma_setup_chapters.js */
/* global configFile, removeConfig, press, step, openFlow -- from head_vimma_setup_chapters.js */
/* global closeFlow, atStep, current, writes, choiceNote -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

/** @param {Document} doc @returns {string} the step's text as the page shows it */
const stepText = (doc) => found(doc.getElementById("v2-text")).textContent ?? "";

/** @param {Document} doc @returns {string[]} the labels of the step's choices, in list order */
const rowLabels = (doc) =>
  [...doc.querySelectorAll("#v2-choices li .name")].map((n) => n.textContent ?? "");
/** @param {Document} doc @returns {string} the footer's keys */
const footerKeys = (doc) => found(doc.getElementById("v2-keys")).textContent ?? "";
/** @param {Document} doc @returns {string} the key the prefix step shows as pressed */
const recordedKey = (doc) => found(doc.getElementById("v2-record-key")).textContent ?? "";
/** @param {Document} doc @returns {string} the key that lists every key under it */
const recordLists = (doc) => found(doc.getElementById("v2-record-lists")).textContent ?? "";
/** @param {Document} doc @returns {string} why the key pressed cannot be the prefix */
const refusal = (doc) => {
  const p = found(doc.getElementById("v2-record-refused"));
  return p.hidden ? "" : (p.textContent ?? "");
};

/** @param {Document} doc @returns {string[]} the keys drawn under each prefix, in list order */
const prefixRows = (doc) =>
  [...doc.querySelectorAll("#v2-choices li")].map(
    (li) => li.querySelector(".hint")?.textContent ?? "",
  );

/**
 * Keys as a Colemak keyboard sends them: the character with the physical key it sits on.
 * @param {Document} doc @param {[key: string, code: string][]} keys
 */
async function typeOn(doc, keys) {
  for (const [key, code] of keys) {
    EventUtils.synthesizeKey(key, { code }, found(doc.defaultView));
    await TestUtils.waitForTick();
  }
}

add_task(async function prefix_step_offers_ctrl_b_and_a_key_of_your_own() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), "ctrl+b", "the prefix in force first");
  Assert.deepEqual(rowLabels(doc), ["ctrl+b", "Choose your own"]);
  Assert.deepEqual(prefixRows(doc), ["ctrl+b ? lists every key", ""]);
  Assert.ok(stepText(doc).includes("ctrl+b ? lists them now"), stepText(doc));
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "j");
  Assert.equal(writes(doc), "Press enter, then the key combination you want");
  Assert.ok(footerKeys(doc).includes("enter press your key"), footerKeys(doc));
  await closeFlow(tab);
});

add_task(async function prefix_step_records_a_key_and_esc_goes_back_to_the_list() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  Assert.equal(doc.documentElement.dataset.recording, "true", "waiting for a key");
  Assert.ok(found(doc.getElementById("v2-choices")).hidden, "the list makes way");
  Assert.ok(!found(doc.getElementById("v2-record")).hidden);
  Assert.ok(footerKeys(doc).includes("esc back to the list"), footerKeys(doc));
  Assert.ok(!footerKeys(doc).includes("enter"), "nothing to save yet");
  const recent = VimmaHost._lastChords.length;
  // The prefix in force reaches the page as a key, not as Vimma's prefix.
  await press(doc, "b", { ctrlKey: true });
  Assert.equal(recordedKey(doc), "ctrl+b");
  Assert.deepEqual(found(VimmaHost._state(window)).dispatcher.pending(), [], "no prefix pending");
  Assert.equal(writes(doc), "Writes nothing", "the prefix in force writes nothing");
  // tmux's prefix: the line, the key that lists every key, and what Firefox no longer does.
  await press(doc, "a", { ctrlKey: true });
  Assert.equal(recordedKey(doc), "ctrl+a");
  Assert.equal(writes(doc), 'Writes [keys] prefix = "ctrl+a"');
  Assert.equal(recordLists(doc), "ctrl+a ? lists every key");
  // The note follows the platform's inventory of Firefox's keys: select all is ctrl+a on Linux
  // and cmd+a on macOS, where ctrl+a gives nothing up.
  if (Services.appinfo.OS === "Darwin") {
    // Cocoa's own ctrl+a in text fields instead (#1410).
    Assert.ok(choiceNote(doc).includes("start of the line"), choiceNote(doc));
  } else Assert.ok(choiceNote(doc).includes("select all"), choiceNote(doc));
  Assert.ok(footerKeys(doc).includes("enter save and go on"), footerKeys(doc));
  // q, s and h are keys being chosen now: refused, and the page stays.
  await press(doc, "q");
  Assert.equal(recordedKey(doc), "q");
  Assert.ok(refusal(doc).includes("needs ctrl, alt or meta"), refusal(doc));
  Assert.equal(step(doc), "prefix_key", "q did not leave");
  Assert.equal(VimmaHost._lastChords.length, recent, "the keys pressed are not kept by Vimma");
  await press(doc, "KEY_Escape");
  Assert.ok(!doc.documentElement.dataset.recording, "back to the list");
  Assert.equal(current(doc), "Choose your own", "on the same row");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  // The prefix is Vimma's again once the page no longer waits.
  await press(doc, "b", { ctrlKey: true });
  Assert.deepEqual(found(VimmaHost._state(window)).dispatcher.pending(), ["prefix"]);
  await press(doc, "KEY_Escape");
  await closeFlow(tab);
});

add_task(async function waiting_for_a_key_holds_only_on_the_setup_tab() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  Assert.equal(doc.documentElement.dataset.recording, "true");
  // Another tab: the prefix is Vimma's there, while the setup page still waits.
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  EventUtils.synthesizeKey("b", { ctrlKey: true }, window);
  await TestUtils.waitForTick();
  Assert.deepEqual(found(VimmaHost._state(window)).dispatcher.pending(), ["prefix"]);
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForTick();
  Assert.equal(recordedKey(doc), "", "nothing reached the setup page");
  // Closing it selects the setup tab again (its opener).
  BrowserTestUtils.removeTab(other);
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
  await press(doc, "KEY_Escape");
  Assert.ok(!doc.documentElement.dataset.recording, "back to the list");
  await closeFlow(tab);
});

add_task(async function prefix_step_refuses_a_key_the_keymap_uses() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  await press(doc, "l", { ctrlKey: true });
  Assert.equal(recordedKey(doc), "ctrl+l");
  Assert.ok(refusal(doc).includes("already runs focus_urlbar"), refusal(doc));
  Assert.equal(
    found(doc.getElementById("v2-record-ask")).textContent,
    "Press another key combination.",
  );
  Assert.equal(writes(doc), "Writes nothing");
  Assert.ok(!footerKeys(doc).includes("enter save"), footerKeys(doc));
  await press(doc, "KEY_Enter");
  Assert.equal(doc.documentElement.dataset.recording, "true", "enter saves no refused key");
  await press(doc, "KEY_Tab", { altKey: true });
  Assert.ok(refusal(doc).includes("esc, enter and tab"), refusal(doc));
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await press(doc, "KEY_Escape");
  await closeFlow(tab);
});

add_task(async function a_non_latin_alt_key_is_taken_and_keys_nobody_types_say_why() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  if (Services.appinfo.OS !== "Darwin") {
    // A Cyrillic layout's alt+w: alt held, AltGraph up, the key types ц (#1410).
    EventUtils.synthesizeKey("ц", { altKey: true, code: "KeyW" }, found(doc.defaultView));
    await TestUtils.waitForTick();
    Assert.equal(recordedKey(doc), "alt+ц");
    Assert.equal(refusal(doc), "", "the keymap sees alt+ц, so it works as the prefix");
    Assert.equal(writes(doc), 'Writes [keys] prefix = "alt+ц"');
    await press(doc, "KEY_Backspace", { ctrlKey: true });
    Assert.equal(refusal(doc), "");
    Assert.ok(choiceNote(doc).includes("also deletes a word in text fields"), choiceNote(doc));
  }
  await press(doc, "KEY_F2");
  Assert.equal(
    refusal(doc),
    "f2: the prefix works in every mode, so it needs ctrl, alt or meta with it, such as ctrl+a.",
  );
  await press(doc, "KEY_Escape");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

add_task(async function a_pressed_prefix_writes_one_line_and_later_steps_name_it() {
  const text = "# mine\nschema = 2\n";
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  await press(doc, "w", { altKey: true });
  Assert.equal(writes(doc), 'Writes [keys] prefix = "alt+w"');
  await press(doc, "KEY_Enter");
  await atStep(doc, "hint_letters");
  const after = await IOUtils.readUTF8(configFile());
  Assert.ok(after.startsWith(text), after);
  Assert.deepEqual(
    after.slice(text.length).split("\n").filter(Boolean),
    ["[keys]", 'prefix = "alt+w"'],
    "one key, under its table",
  );
  Assert.ok(found(ConfigHost.keymap).keysFor("show_keybinds").includes("alt+w ?"), "applied live");
  Assert.ok(found(doc.getElementById("v2-last")).textContent.includes('prefix = "alt+w"'));
  // Back on the prefix step, the prefix just saved is the second row, in force.
  await press(doc, "h");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), "Your own: alt+w", "the prefix just saved is in force");
  Assert.deepEqual(prefixRows(doc), ["ctrl+b ? lists every key", "alt+w ? lists every key"]);
  Assert.ok(stepText(doc).includes("alt+w ? lists them now"), stepText(doc));
  // Every step drawn from now on names its keys with the new prefix.
  /** @type {string[]} */
  const kbds = [];
  for (const id of BUILT_STEPS) {
    const view = await SetupHost.stepView(tab.linkedBrowser, id);
    for (const part of view?.text ?? []) if (part.tag === "kbd") kbds.push(part.text);
  }
  Assert.ok(kbds.includes("alt+w ?"), kbds.join(", "));
  Assert.ok(!kbds.some((k) => k.startsWith("ctrl+b ")), `no old prefix: ${kbds.join(", ")}`);
  await closeFlow(tab);
  await removeConfig();
});

add_task(async function the_host_judges_the_pressed_prefix_again() {
  // No poll reads config.toml while this task edits it: a read would draw the step again and
  // make the list this task holds stale.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.pollMs", 3_600_000]] });
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  const browser = tab.linkedBrowser;
  const view = found(await SetupHost.stepView(browser, "prefix_key"));
  const save = (/** @type {number} */ index, /** @type {string} */ chord) =>
    SetupHost.saveStep(browser, "prefix_key", index, view.serial, chord);
  // What the page would refuse, the host refuses too: the page only proposes.
  for (const chord of ["ctrl+l", "a", "ctrl+enter", "ctrl+t"]) {
    const r = await save(1, chord);
    Assert.ok("error" in r, `${chord}: ${JSON.stringify(r)}`);
  }
  // Only one chord in Vimma's notation, and only on the row that records one.
  for (const [index, chord] of /** @type {[number, string][]} */ ([
    [1, "ctrl+b ctrl+b"],
    [1, 'ctrl+a"\n[mcp]\nenabled = true'],
    [1, "ctrl+nope"],
    [0, "ctrl+a"],
  ])) {
    const r = await save(index, chord);
    Assert.deepEqual(r, { error: "not a key the prefix step takes" }, JSON.stringify(chord));
  }
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  // Judged against the file as it is at enter: a binding added after the step was drawn wins.
  const bound = 'schema = 2\n\n[keys]\nclose_tab = ["ctrl+alt+y"]\n';
  await IOUtils.writeUTF8(configFile(), bound);
  const late = await save(1, "ctrl+alt+y");
  Assert.ok("error" in late && late.error.includes("already runs close_tab"), JSON.stringify(late));
  Assert.equal(await IOUtils.readUTF8(configFile()), bound, "the file is as it was");
  // Not read again: the list this task holds stays the page's.
  await IOUtils.remove(configFile());
  // The chord is written as Vimma writes it.
  const r = await save(1, "control+a");
  Assert.deepEqual(r, { written: ['[keys] prefix = "ctrl+a"'] });
  await closeFlow(tab);
  await removeConfig();
  await ConfigHost.reload();
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_custom_prefix_and_hint_letters_offer_keep_and_write_nothing() {
  const text =
    '# mine\nschema = 2\n\n[keys]\nprefix = "ctrl+space"\n\n[modal]\nhint_chars = "fjdksla"\n';
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), "Your own: ctrl+space", "the second row, selected");
  Assert.deepEqual(rowLabels(doc), ["ctrl+b", "Your own: ctrl+space"], "no Keep");
  Assert.equal(prefixRows(doc)[1], "ctrl+space ? lists every key", "drawn with its own key");
  Assert.equal(writes(doc), "Writes nothing");
  Assert.ok(footerKeys(doc).includes("space press another"), footerKeys(doc));
  // space waits for another key; esc keeps the one in force.
  await press(doc, " ");
  Assert.equal(doc.documentElement.dataset.recording, "true");
  await press(doc, "KEY_Escape");
  Assert.equal(current(doc), "Your own: ctrl+space");
  // k and j as typed on Colemak, back on the second row: Keep stays selected on the next step
  // for a value the user set.
  await typeOn(doc, [
    ["k", "KeyN"],
    ["j", "KeyY"],
  ]);
  Assert.equal(current(doc), "Your own: ctrl+space");
  await press(doc, "KEY_Enter");
  await atStep(doc, "hint_letters");
  Assert.equal(current(doc), 'Keep "fjdksla"', "Keep first and selected");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()), text, "byte for byte");
  await closeFlow(tab);
});

add_task(async function hint_step_selects_the_layout_typed_on() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  // j, k and s on Colemak: KeyY, KeyN and KeyD.
  await typeOn(doc, [
    ["j", "KeyY"],
    ["k", "KeyN"],
    ["s", "KeyD"],
  ]);
  await atStep(doc, "hint_letters");
  Assert.equal(current(doc), "Colemak: arstdhneio", "the layout typed on first");
  Assert.ok(
    found(doc.querySelector('#v2-choices li[data-index="0"] .meta')).textContent === "in force",
    "QWERTY, the default, is still the one in force",
  );
  const guess = found(doc.getElementById("v2-guess"));
  Assert.ok(!guess.hidden && guess.textContent.includes("Colemak"), guess.textContent);
  Assert.equal(writes(doc), 'Writes [modal] hint_chars = "arstdhneio"');
  Assert.ok(stepText(doc).includes("f labels the links"), stepText(doc));
  // j on the step moves the cursor; the guess, its label and the note stay as they were.
  const note = guess.textContent;
  await typeOn(doc, [["j", "KeyY"]]);
  Assert.equal(current(doc), "Dvorak: aoeuidhtns");
  Assert.equal(guess.textContent, note, "the note is unchanged");
  Assert.ok(doc.querySelector('#v2-choices li[data-index="1"][data-guessed]'), "Colemak's label");
  await typeOn(doc, [["k", "KeyN"]]);
  Assert.equal(current(doc), "Colemak: arstdhneio");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok((await IOUtils.readUTF8(configFile())).includes('hint_chars = "arstdhneio"'));
  Assert.equal(ConfigHost.config?.hintChars, "arstdhneio", "applied live");
  await closeFlow(tab);
  // Nothing of what was typed outlives the page: a new one opens on QWERTY.
  const again = await openFlow();
  await press(again.doc, "4");
  await atStep(again.doc, "prefix_key");
  await press(again.doc, "s");
  await atStep(again.doc, "hint_letters");
  Assert.equal(current(again.doc), "QWERTY: asdfghjkl", "QWERTY without a guess");
  await closeFlow(again.tab);
});
