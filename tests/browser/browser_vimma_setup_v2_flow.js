/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's walk through the chapters (docs/specs/setup-v2.md): what a step writes, skip, back,
// leaving, the safeguards around config.toml, and the layout of every step and stop screen.

"use strict";

/* global SetupHost, ConfigHost, SearchService, AppConstants -- from head_vimma_setup_chapters.js */
/* global BUILT_STEPS, McpHost, found, configFile, press -- from head_vimma_setup_chapters.js */
/* global step, openFlow, closeFlow, atStep, current, writes -- from head_vimma_setup_chapters.js */
/* global notice, toEngines, CHAPTERS_PREF -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
);

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { STEPS } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/setup-steps.mjs");

add_task(async function welcome_says_q_leaves_and_finished_steps_are_saved() {
  const { tab, doc } = await openFlow();
  Assert.equal(step(doc), "welcome");
  const promise = found(doc.getElementById("v2-promise")).textContent.replace(/\s+/g, " ");
  for (const words of ["optional", "q", "esc", "saved to config.toml", ":setup"]) {
    Assert.ok(promise.includes(words), `the promise says ${words}`);
  }
  const chapter = found(doc.querySelector('#v2-chapters li[data-chapter="essentials"]'));
  Assert.ok(chapter.textContent.includes("Content blocker, Search engine, Colours"), "its steps");
  Assert.ok(!doc.getElementById("summary"), "and no summary flow");
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "q");
  await closed;
  Assert.ok(!(await IOUtils.exists(configFile())), "q changed nothing");
  await closeFlow(tab);
});

add_task(async function a_step_shows_the_line_it_will_write() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  const inForce = current(doc);
  Assert.equal(inForce, (await SearchService.getDefault()).name, "the engine in force first");
  Assert.equal(writes(doc), "Writes nothing", "the value in force writes nothing");
  await press(doc, "j");
  Assert.equal(writes(doc), `Writes [search] default = ${JSON.stringify(current(doc))}`);
  const keys = found(doc.getElementById("v2-keys")).textContent;
  for (const k of ["save and go on", "skip", "back", "leave"]) Assert.ok(keys.includes(k), k);
  Assert.ok(found(doc.getElementById("v2-place")).textContent.includes("step 2 of 3"));
  await closeFlow(tab);
});

add_task(async function enter_on_a_step_writes_its_key_and_applies_live() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  Assert.ok(
    (await IOUtils.readUTF8(configFile())).includes(`[search]\ndefault = ${JSON.stringify(name)}`),
    "[search] default written at enter",
  );
  await TestUtils.waitForCondition(async () => (await SearchService.getDefault()).name === name);
  Assert.ok(found(doc.getElementById("v2-last")).textContent.includes("[search] default"));
  // No Omarchy theme: light, dark, follow the system; the last is in force.
  Assert.equal(current(doc), "Vimma, following the system");
  await press(doc, "k", "k");
  Assert.equal(writes(doc), 'Writes [theme] appearance = "light"');
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok((await IOUtils.readUTF8(configFile())).includes('appearance = "light"'));
  Assert.equal(ThemeHost.status.appearance.value, "light", "the colours apply at once");
  const saved = found(doc.getElementById("v2-stop-saved")).textContent;
  Assert.ok(saved.includes("[search] default") && saved.includes("[theme] appearance"));
  await closeFlow(tab);
});

add_task(async function skip_writes_nothing() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j", "s");
  await atStep(doc, "colours");
  await press(doc, "k", "s");
  await atStep(doc, "stop");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

add_task(async function leaving_mid_chapter_keeps_finished_steps() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  const saved = await IOUtils.readUTF8(configFile());
  await press(doc, "k");
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Escape");
  await closed;
  const text = await IOUtils.readUTF8(configFile());
  Assert.ok(text.includes(`default = ${JSON.stringify(name)}`), "the saved step stays saved");
  Assert.equal(text, saved, "nothing for the open step");
  await closeFlow(tab);
});

add_task(async function closing_the_tab_keeps_finished_steps_and_writes_nothing_else() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "colours");
  const before = await IOUtils.readUTF8(configFile());
  await press(doc, "k");
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForTick();
  Assert.equal(await IOUtils.readUTF8(configFile()), before, "only the finished step");
  await closeFlow(tab);
});

/** Enter on the steps of Your keys, from the stop screen before them, to the last stop screen. */
async function enterThroughKeys(/** @type {Document} */ doc) {
  await press(doc, "KEY_Enter");
  await atStep(doc, "prefix_key");
  await press(doc, "KEY_Enter");
  await atStep(doc, "hint_letters");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
}

/** Enter on every step, then on the last stop screen, which closes the page. */
async function enterThrough(/** @type {Document} */ doc, /** @type {MozTabbrowserTab} */ tab) {
  await toEngines(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  // Moving in acts and saves nothing: "not now" on both of its steps.
  await press(doc, "KEY_Enter");
  await atStep(doc, "default_browser");
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "bring_your_data");
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "stop");
  await press(doc, "KEY_Enter");
  await atStep(doc, "address_bar");
  await press(doc, "KEY_Enter");
  await atStep(doc, "tab_line");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  await enterThroughKeys(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "updates");
  await press(doc, "KEY_Enter");
  await atStep(doc, "agents");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(!McpHost.state.enabled, "plain enter never turns agents on");
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Enter");
  await closed;
}

add_task(async function enter_through_every_step_leaves_config_toml_unchanged() {
  // No file: none is created.
  let { tab, doc } = await openFlow();
  await enterThrough(doc, tab);
  Assert.ok(!(await IOUtils.exists(configFile())), "no file created");
  await closeFlow(tab);
  // A file of the user's, without an Omarchy theme and then with one.
  const text = '# mine\nschema = 2\n\n[ui]\ntoolbar = "shown" # why\ntabline = "auto"\n';
  const omarchy = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-omarchy");
  /** @type {[string, string][][]} */
  const runs = [
    [],
    [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", omarchy],
    ],
  ];
  for (const prefs of runs) {
    await IOUtils.writeUTF8(configFile(), text);
    await ConfigHost.reload();
    await SpecialPowers.pushPrefEnv({ set: prefs });
    ({ tab, doc } = await openFlow());
    await toEngines(doc);
    await press(doc, "KEY_Enter");
    await atStep(doc, "colours");
    Assert.equal(
      current(doc),
      prefs.length ? "The Omarchy theme" : "Vimma, following the system",
      "the effect in force is selected",
    );
    await press(doc, "KEY_Enter");
    await atStep(doc, "stop");
    await press(doc, "3");
    await atStep(doc, "address_bar");
    Assert.equal(current(doc), "Shown", "the toolbar in force is selected");
    await press(doc, "KEY_Enter");
    await atStep(doc, "tab_line");
    Assert.equal(current(doc), "Only with two or more tabs", "the tab line in force is selected");
    await press(doc, "KEY_Enter");
    await atStep(doc, "stop");
    await enterThroughKeys(doc);
    Assert.equal(await IOUtils.readUTF8(configFile()), text, "byte for byte");
    Assert.ok(
      found(doc.getElementById("v2-stop-saved")).textContent.includes("Nothing was written"),
    );
    await closeFlow(tab);
    await SpecialPowers.popPrefEnv();
  }
  await IOUtils.remove(omarchy, { recursive: true });
});

add_task(async function back_overwrites_one_key() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j");
  const first = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  await press(doc, "h");
  await atStep(doc, "search_engine");
  Assert.equal(current(doc), first, "back opens on the value in force, the one just saved");
  await press(doc, "j");
  const second = current(doc);
  Assert.notEqual(second, first);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  const text = await IOUtils.readUTF8(configFile());
  Assert.equal(text.match(/^default = /gm)?.length, 1, "one key");
  Assert.ok(text.includes(`default = ${JSON.stringify(second)}`), "overwritten");
  await closeFlow(tab);
});

add_task(async function an_edit_made_while_a_step_is_open_is_kept() {
  await IOUtils.writeUTF8(configFile(), "schema = 2\n");
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  // Another program edits the file while the step is open.
  await IOUtils.writeUTF8(configFile(), "schema = 2\n\n[statusbar]\ntab = false\n");
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  const text = await IOUtils.readUTF8(configFile());
  Assert.ok(text.includes("[statusbar]\ntab = false"), "the other edit is kept");
  Assert.ok(text.includes(`default = ${JSON.stringify(name)}`), "and the step's key set");
  await closeFlow(tab);
});

add_task(async function a_failed_write_keeps_the_file_and_the_step_open() {
  const text = "schema = 2\n";
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  const dir = found(PathUtils.parent(configFile()));
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  // No temporary file can be made beside config.toml now.
  await IOUtils.setPermissions(dir, 0o500);
  registerCleanupFunction(() => IOUtils.setPermissions(dir, 0o700).catch(() => {}));
  await press(doc, "j", "KEY_Enter");
  await TestUtils.waitForCondition(() => !notice(doc).hidden, "the reason is shown");
  Assert.ok(notice(doc).textContent.startsWith("Not saved:"), notice(doc).textContent);
  Assert.equal(step(doc), "search_engine", "the step stays open");
  await IOUtils.setPermissions(dir, 0o700);
  Assert.equal(await IOUtils.readUTF8(configFile()), text, "the file as it was");
  await closeFlow(tab);
});

add_task(async function a_parse_error_writes_nothing_and_action_steps_still_work() {
  await IOUtils.writeUTF8(configFile(), "[search\n");
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  const error = found(doc.getElementById("v2-config-error"));
  Assert.ok(!error.hidden && error.textContent.includes("config.toml:1"), error.textContent);
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await press(doc, "KEY_Enter");
  await atStep(doc, "search_engine");
  Assert.ok(!notice(doc).hidden && notice(doc).textContent.includes(":1"), "the step says why");
  await press(doc, "j", "KEY_Enter");
  await TestUtils.waitForTick();
  Assert.equal(step(doc), "search_engine", "enter cannot save");
  await press(doc, "s");
  await atStep(doc, "colours");
  Assert.equal(await IOUtils.readUTF8(configFile()), "[search\n", "untouched");
  await closeFlow(tab);
});

add_task(async function a_symlinked_config_toml_stays_a_link() {
  if (AppConstants.platform !== "linux") return;
  const real = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-dotfiles");
  const target = PathUtils.join(real, "config.toml");
  await IOUtils.writeUTF8(target, "schema = 2\n");
  await IOUtils.remove(configFile(), { ignoreAbsent: true });
  await IOUtils.makeDirectory(found(PathUtils.parent(configFile())), { ignoreExisting: true });
  const ln = await Subprocess.call({
    command: "/usr/bin/ln",
    arguments: ["-s", target, configFile()],
  });
  Assert.equal((await ln.wait()).exitCode, 0, "symlink made");
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  const link = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  link.initWithPath(configFile());
  Assert.ok(link.isSymlink(), "still a link");
  Assert.ok((await IOUtils.readUTF8(target)).includes(`default = ${JSON.stringify(name)}`));
  await closeFlow(tab);
  await IOUtils.remove(real, { recursive: true });
});

add_task(async function a_private_window_saves_nothing() {
  Services.prefs.clearUserPref(CHAPTERS_PREF);
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const { tab, doc } = await openFlow(win);
  const error = found(doc.getElementById("v2-config-error"));
  Assert.ok(!error.hidden && error.textContent.includes("private window"), error.textContent);
  await toEngines(doc);
  Assert.ok(notice(doc).textContent.includes("private window"), "the step says so");
  await press(doc, "j", "KEY_Enter");
  await TestUtils.waitForTick();
  Assert.equal(step(doc), "search_engine", "enter cannot save");
  Assert.deepEqual(
    await SetupHost.saveStep(tab.linkedBrowser, "search_engine", 1),
    { error: "a private window saves nothing" },
    "nor can the host be asked",
  );
  await press(doc, "s");
  await atStep(doc, "colours");
  await press(doc, "s");
  await atStep(doc, "stop");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  Assert.ok(!Services.prefs.prefHasUserValue(CHAPTERS_PREF), "the chapter is not recorded");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function the_page_cannot_name_a_key_or_value() {
  const { tab, doc } = await openFlow();
  const b = tab.linkedBrowser;
  Assert.deepEqual(
    await SetupHost.saveStep(b, "search_engine", 0),
    { error: "no such choice" },
    "no step's choices were sent yet",
  );
  await toEngines(doc);
  // A step whose slice has not landed is refused, whichever steps are still to come.
  const unbuilt = STEPS.filter((s) => s.kind === "setting" && !BUILT_STEPS.includes(s.id));
  for (const [id, index] of /** @type {[string, number][]} */ ([
    ...unbuilt.map((s) => [s.id, 0]),
    ["content_blocker", 0],
    ["no_such_step", 0],
  ])) {
    Assert.deepEqual(
      await SetupHost.saveStep(b, id, index),
      { error: "not a step that saves" },
      id,
    );
  }
  for (const index of [999, -1, 1.5, "length", "0"]) {
    Assert.deepEqual(
      await SetupHost.saveStep(
        b,
        "search_engine",
        /** @type {number} */ (/** @type {unknown} */ (index)),
      ),
      { error: "no such choice" },
      `index ${JSON.stringify(index)}`,
    );
  }
  Assert.deepEqual(await SetupHost.saveStep(null, "search_engine", 1), {
    error: "not a step that saves",
  });
  // The agents step's "on" before the page was shown that step: no list, so no consent.
  Assert.deepEqual(await SetupHost.saveStep(b, "agents", 1), { error: "no such choice" });
  Assert.ok(!McpHost.state.enabled, "agents stay off");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

add_task(async function finished_chapters_are_ticked_on_the_next_run() {
  Services.prefs.clearUserPref(CHAPTERS_PREF);
  registerCleanupFunction(() => Services.prefs.clearUserPref(CHAPTERS_PREF));
  let { tab, doc } = await openFlow();
  Assert.ok(!doc.querySelector("#v2-chapters li[data-finished]"), "nothing ticked yet");
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await press(doc, "s");
  await atStep(doc, "search_engine");
  await press(doc, "s");
  await atStep(doc, "colours");
  await press(doc, "s");
  await atStep(doc, "stop");
  Assert.equal(Services.prefs.getStringPref(CHAPTERS_PREF), "essentials");
  await closeFlow(tab);
  ({ tab, doc } = await openFlow());
  Assert.ok(doc.querySelector('#v2-chapters li[data-chapter="essentials"][data-finished]'));
  await closeFlow(tab);
});

add_task(async function enter_before_a_step_is_drawn_writes_nothing() {
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  await press(doc, "s");
  await atStep(doc, "colours");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  // Back to the colours step and enter at once, before its list is drawn again: the list the
  // page was sent on the first visit must not stand in for it.
  const real = SetupHost.saveStep;
  /** @type {unknown[][]} */
  const asked = [];
  SetupHost.saveStep = (...args) => {
    asked.push(args.slice(1));
    return real.apply(SetupHost, args);
  };
  registerCleanupFunction(() => (SetupHost.saveStep = real));
  const win = found(doc.defaultView);
  EventUtils.synthesizeKey("h", {}, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await atStep(doc, "colours");
  await TestUtils.waitForTick();
  SetupHost.saveStep = real;
  Assert.deepEqual(asked, [], "the page asked for no save");
  Assert.equal(step(doc), "colours", "enter did not save");
  Assert.ok(!doc.documentElement.dataset.failed, "and reported no failure");
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

/** @param {Element | null} e */
const rectOf = (e) => found(e).getBoundingClientRect();

/**
 * Resizes the window to `w`×`h` and waits for the page to see a new size.
 * @param {Document} doc @param {number} w @param {number} h
 */
async function resizeWindow(doc, w, h) {
  const view = found(doc.defaultView);
  const was = `${view.innerWidth}x${view.innerHeight}`;
  window.resizeTo(w, h);
  await TestUtils.waitForCondition(
    () => `${view.innerWidth}x${view.innerHeight}` !== was,
    `the page is resized to ${w}x${h}`,
  );
  await TestUtils.waitForTick();
}

/**
 * The page's footer stays below the list it follows and inside the window (setup-v2 "Page
 * layout"); a window too short for the step scrolls the step, not under the footer.
 * @param {Document} doc @param {string} list  the list's id @param {string} what
 */
function assertFooterClear(doc, list, what) {
  const footer = rectOf(doc.getElementById("v2-footer"));
  const items = rectOf(doc.getElementById(list));
  Assert.greaterOrEqual(
    Math.round(footer.top),
    Math.round(items.bottom),
    `${what}: the footer (top ${footer.top}) does not overlap the list (bottom ${items.bottom})`,
  );
  Assert.lessOrEqual(
    Math.round(footer.bottom),
    found(doc.defaultView).innerHeight,
    `${what}: the footer is inside the window`,
  );
}

add_task(async function every_step_and_stop_screen_starts_at_the_same_height() {
  const { tab, doc } = await openFlow();
  const startSize = [window.outerWidth, window.outerHeight];
  registerCleanupFunction(() => window.resizeTo(startSize[0], startSize[1]));
  const progress = () => rectOf(doc.getElementById("v2-progress")).top;
  const question = () => rectOf(doc.getElementById("v2-question")).top;
  /** How tall the step's content is, its lists unscrolled. */
  const length = () =>
    found(doc.getElementById("v2-step")).scrollHeight +
    found(doc.getElementById("v2-choices")).scrollHeight +
    found(doc.getElementById("v2-addons")).scrollHeight;

  // The welcome screen stays centred.
  const welcome = rectOf(doc.getElementById("v2-welcome"));
  Assert.lessOrEqual(
    Math.abs((welcome.top + welcome.bottom) / 2 - found(doc.defaultView).innerHeight / 2),
    4,
    `the welcome screen is centred (${welcome.top}..${welcome.bottom})`,
  );
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  const top = progress();
  const asked = question();
  const lengths = [length()];
  assertFooterClear(doc, "v2-addons", "content blocker");
  await press(doc, "s");
  await atStep(doc, "search_engine");
  const engines = doc.querySelectorAll("#v2-choices li").length;
  lengths.push(length());
  Assert.equal(progress(), top, "the search engine step starts where the content blocker does");
  Assert.equal(question(), asked, "and asks its question at the same height");
  assertFooterClear(doc, "v2-choices", "search engine");
  await press(doc, "s");
  await atStep(doc, "colours");
  lengths.push(length());
  Assert.greater(new Set(lengths).size, 1, `the steps differ in length (${lengths})`);
  Assert.equal(progress(), top, "the colours step starts there too");
  Assert.equal(question(), asked);
  assertFooterClear(doc, "v2-choices", "colours");
  await press(doc, "s");
  await atStep(doc, "stop");
  Assert.equal(
    rectOf(doc.querySelector("#v2-stop header")).top,
    top,
    "the stop screen's heading starts at the steps' progress line",
  );
  assertFooterClear(doc, "v2-stop-saved", "stop screen");

  // A small window: the list scrolls under a header that stays put, clear of the footer.
  await resizeWindow(doc, 800, 600);
  await press(doc, "h");
  await atStep(doc, "colours");
  const small = progress();
  assertFooterClear(doc, "v2-choices", "colours, small window");
  await press(doc, "h");
  await atStep(doc, "search_engine");
  Assert.equal(progress(), small, "the search engine step starts there in a small window too");
  assertFooterClear(doc, "v2-choices", "search engine, small window");
  // A short window keeps about two and a half add-ons in view, not one, even with the notice
  // that addons.mozilla.org is not answering, and without scrolling the step under the list.
  await press(doc, "h");
  await atStep(doc, "content_blocker");
  const offline = found(doc.getElementById("v2-offline"));
  await TestUtils.waitForCondition(() => !offline.hidden, "the not answering notice is shown");
  const stepBox = found(doc.getElementById("v2-step"));
  const addons = found(doc.getElementById("v2-addons"));
  const row = rectOf(addons.querySelector("li")).height;
  const box = rectOf(addons);
  const seen = Math.min(box.bottom, rectOf(stepBox).bottom) - box.top;
  Assert.greaterOrEqual(
    seen + 1,
    Math.min(addons.scrollHeight, 2.5 * row),
    `the add-on list shows two and a half rows at 800x600 (${seen} px seen, rows ${row})`,
  );
  Assert.lessOrEqual(
    stepBox.scrollHeight,
    stepBox.clientHeight + 1,
    "the step itself does not scroll, so the list is the only scrolling box",
  );
  // Smaller still, the engines overflow: the list scrolls under a header that stays put.
  await resizeWindow(doc, 800, 480);
  await press(doc, "s");
  await atStep(doc, "search_engine");
  Assert.equal(progress(), small, "the search engine step starts there in a smaller window too");
  const engineList = found(doc.getElementById("v2-choices"));
  Assert.greater(
    engineList.scrollHeight,
    engineList.clientHeight,
    "the engine list overflows its box at 800x480",
  );
  for (let i = 1; i < engines; i++) await press(doc, "j");
  Assert.equal(progress(), small, "moving down the list leaves the header where it is");
  const cursor = rectOf(doc.querySelector("#v2-choices li[aria-current]"));
  const list = rectOf(doc.getElementById("v2-choices"));
  Assert.ok(
    cursor.top >= list.top - 1 && cursor.bottom <= list.bottom + 1,
    `the last engine is scrolled into view (${cursor.top}..${cursor.bottom} in ${list.top}..${list.bottom})`,
  );
  assertFooterClear(doc, "v2-choices", "search engine at its last row, smaller window");
  window.resizeTo(startSize[0], startSize[1]);
  await closeFlow(tab);
});
