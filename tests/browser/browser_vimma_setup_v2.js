/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's chapters on the setup page (docs/specs/setup-v2.md), with vimma.feature.setupV2 on
// until its last slice; the summary flow's tasks are in browser_vimma_setup.js. AMO is pointed at
// a closed local port, so the content blocker shows the curated list offline and nothing leaves
// the machine; XDG_CONFIG_HOME is a temporary folder, so config.toml writes never reach the real
// ~/.config. A later slice adds its steps' tasks here.

"use strict";

// Every chapter of the setup in one file: about 26 s on an idle developer machine and 80 s on a
// loaded one, against the harness's 45 s for a file.
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
requestLongerTimeout(3);

const { SetupHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
);

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs",
);

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionTestCommon } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionTestCommon.sys.mjs",
);

// AMO answered by a local .sjs; the page appends `search/?…`, which the .sjs ignores.
const AMO_LOCAL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_setup_amo.sjs?";
const UBLOCK = "uBlock0@raymondhill.net";

const SETUP_URL = "about:vimma-setup";
const OFFERED = "vimma.setup.offered";

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

/**
 * The setup page's document. about:vimma-setup loads in the parent process (SetupHost.sys.mjs's
 * getURIFlags has no URI_MUST_LOAD_IN_CHILD), so the browser has it; contentDocument is null only
 * for a remote page, where a read through it throws.
 * @param {MozTabbrowserTab} tab
 */
const docOf = (tab) => found(tab.linkedBrowser.contentDocument);

const { ShellService } = ChromeUtils.importESModule(
  "moz-src:///browser/components/shell/ShellService.sys.mjs",
);
const { MigrationUtils } = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
);
const { InternalTestingProfileMigrator } = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs",
);
const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
const { AppLauncher } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/AppLauncher.sys.mjs",
);

/**
 * What the replaced shell service answers, for every task (Moving in, behaviour 22), and the
 * arguments of each Make Default it was asked. No task changes this machine's default browser.
 */
const shell = {
  isDefault: false,
  setFails: false,
  flatpak: false,
  /** @type {unknown[][]} */
  calls: [],
};

// The shell service's two methods are replaced on its internal object, where AppLauncher's
// wrapper also lives (browser_vimma_setup_moving_in.js), and the import wizard lists only
// Firefox's test migrator, so it never reads the browsers installed on this machine.
add_task(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["browser.migrate.internal-testing.enabled", true]] });
  const sandbox = sinon.createSandbox();
  sandbox
    .stub(MigrationUtils, "availableMigratorKeys")
    .get(() => [InternalTestingProfileMigrator.key]);
  sandbox.stub(AppLauncher, "underFlatpak").callsFake(() => shell.flatpak);
  const isDefault = ShellService.isDefaultBrowser;
  const setDefault = ShellService.setDefaultBrowser;
  ShellService.isDefaultBrowser = () => shell.isDefault;
  ShellService.setDefaultBrowser = async (/** @type {unknown[]} */ ...args) => {
    shell.calls.push(args);
    if (shell.setFails) throw new Error("no handler database");
    shell.isDefault = true;
  };
  registerCleanupFunction(async () => {
    ShellService.isDefaultBrowser = isDefault;
    ShellService.setDefaultBrowser = setDefault;
    sandbox.restore();
    await SpecialPowers.popPrefEnv();
  });
});

/** @param {Partial<typeof shell>} state  for one task; the rest back to another default */
function shellAnswers(state = {}) {
  Object.assign(shell, { isDefault: false, setFails: false, flatpak: false, calls: [] }, state);
}

// XDG_CONFIG_HOME first: the vimma.config.path change reloads the config at once, and would
// otherwise read the developer's own ~/.config/vimma/config.toml.
add_task(async () => {
  const xdg = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-setup");
  const before = Services.env.exists("XDG_CONFIG_HOME") ? Services.env.get("XDG_CONFIG_HOME") : "";
  Services.env.set("XDG_CONFIG_HOME", xdg);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", "http://127.0.0.1:1/"],
      ["vimma.config.path", ""],
    ],
  });
  await ConfigHost.reload();
  registerCleanupFunction(async () => {
    await removeConfig();
    await SpecialPowers.popPrefEnv();
    Services.env.set("XDG_CONFIG_HOME", before);
    await ConfigHost.reload();
    Services.prefs.clearUserPref(OFFERED);
    await IOUtils.remove(xdg, { recursive: true, ignoreAbsent: true });
  });
});

const configFile = () =>
  PathUtils.join(Services.env.get("XDG_CONFIG_HOME"), "vimma", "config.toml");

/**
 * Removes config.toml and reads the config now, so Vimma undoes the `[search] default` a summary
 * applied before the next task starts. Left to the 2 s poll, the undo lands in whichever task is
 * running then and changes the default engine under it.
 */
async function removeConfig() {
  await IOUtils.remove(configFile(), { ignoreAbsent: true });
  await ConfigHost.reload();
  await TestUtils.waitForCondition(
    () => !Services.prefs.prefHasUserValue("vimma.search.applied"),
    "the [search] default the summary applied is undone",
  );
}

/** @param {Document} doc @param {...string} keys  EventUtils key names */
async function press(doc, ...keys) {
  for (const k of keys) {
    EventUtils.synthesizeKey(k, {}, found(doc.defaultView));
    await TestUtils.waitForTick();
  }
}

/** @param {Document} doc */
const step = (doc) => doc.documentElement.dataset.step;

/**
 * Replaces SetupHost.installFor with an install of a local unsigned XPI that has
 * uBlock Origin's GUID, because the AMO file URL cannot be fetched under test. Everything after
 * it (installAddonFromAOM, the prompt) is Firefox's own path. Returns the URLs it was asked for.
 */
async function stubInstall() {
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      name: "uBlock Origin (test)",
      browser_specific_settings: { gecko: { id: UBLOCK } },
      permissions: ["tabs"],
    },
  });
  registerCleanupFunction(() => IOUtils.remove(xpi.path, { ignoreAbsent: true }));
  const real = SetupHost.installFor;
  /** @type {string[]} */
  const asked = [];
  SetupHost.installFor = async (entry) => {
    asked.push(entry.url);
    return AddonManager.getInstallForFile(xpi);
  };
  registerCleanupFunction(() => (SetupHost.installFor = real));
  return { asked, restore: () => (SetupHost.installFor = real) };
}

// browser.toml sets vimma.theme.source=builtin, so no Omarchy theme is found unless a task
// points the theme at a folder of its own.

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const { BUILT_STEPS } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/setup.mjs");

const V2 = "vimma.feature.setupV2";
const CHAPTERS_PREF = "vimma.setup.chapters";

/** @param {BrowserWindow} [win] */
async function openFlow(win = window) {
  await SpecialPowers.pushPrefEnv({ set: [[V2, true]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, SETUP_URL);
  const doc = docOf(tab);
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true", "ready");
  tab.linkedBrowser.focus();
  return { tab, doc };
}

/** @param {MozTabbrowserTab} tab */
async function closeFlow(tab) {
  if (tab.linkedBrowser && !tab.closing) BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await removeConfig();
}

/**
 * Waits for the page to show `id`: a step id with its view drawn, "welcome" or "stop".
 * @param {Document} doc @param {string} id
 */
function atStep(doc, id) {
  const root = doc.documentElement;
  return TestUtils.waitForCondition(
    () =>
      root.dataset.step === id &&
      (id === "welcome" || id === "stop" || root.dataset.viewReady === "true"),
    `at ${id}`,
  );
}

/** @param {Document} doc @returns {string} the choice under the cursor */
const current = (doc) =>
  found(doc.querySelector("#v2-choices li[aria-current] .name")).textContent ?? "";
/** @param {Document} doc */
const writes = (doc) => found(doc.getElementById("v2-writes")).textContent;
/** @param {Document} doc */
const notice = (doc) => found(doc.getElementById("v2-notice"));

/** From the welcome screen to the search engine step, past the content blocker with nothing marked. */
async function toEngines(/** @type {Document} */ doc) {
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await press(doc, "KEY_Enter");
  await atStep(doc, "search_engine");
}

add_task(async function welcome_says_q_leaves_and_finished_steps_are_saved() {
  const { tab, doc } = await openFlow();
  Assert.equal(step(doc), "welcome");
  const promise = found(doc.getElementById("v2-promise")).textContent.replace(/\s+/g, " ");
  for (const words of ["optional", "q", "esc", "saved to config.toml", ":setup"]) {
    Assert.ok(promise.includes(words), `the promise says ${words}`);
  }
  const chapter = found(doc.querySelector('#v2-chapters li[data-chapter="essentials"]'));
  Assert.ok(chapter.textContent.includes("Content blocker, Search engine, Colours"), "its steps");
  Assert.ok(found(doc.getElementById("welcome")).hidden, "the summary flow's welcome is hidden");
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
  Assert.equal(current(doc), "Follow the system");
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
      prefs.length ? "The Omarchy theme" : "Follow the system",
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
  await SpecialPowers.popPrefEnv();
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
  for (const [id, index] of /** @type {[string, number][]} */ ([
    ["agents", 1],
    ["updates", 1],
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
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

add_task(async function an_engine_removed_before_enter_is_not_written() {
  const real = SetupHost.engines;
  const gone = "Vimma Test Engine That Went Away";
  SetupHost.engines = async () => {
    const r = await real.call(SetupHost);
    return { ...r, names: [...r.names, gone] };
  };
  registerCleanupFunction(() => (SetupHost.engines = real));
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  const rows = doc.querySelectorAll("#v2-choices li").length;
  await press(doc, ...Array(rows).fill("j"));
  Assert.equal(current(doc), gone);
  SetupHost.engines = real;
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(
    () => notice(doc).textContent.includes("no longer installed"),
    "says so",
  );
  Assert.equal(step(doc), "search_engine");
  Assert.ok(
    ![...doc.querySelectorAll("#v2-choices .name")].some((n) => n.textContent === gone),
    "drawn with the current list",
  );
  Assert.ok(!(await IOUtils.exists(configFile())), "nothing written");
  await closeFlow(tab);
});

add_task(async function content_blocker_installs_on_enter_with_the_permission_prompt() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", AMO_LOCAL],
      ["xpinstall.signatures.required", false],
    ],
  });
  const stub = await stubInstall();
  const { tab, doc } = await openFlow();
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await TestUtils.waitForCondition(() =>
    doc.querySelector(`#v2-addons li[data-guid="${UBLOCK}"]:not(.disabled)`),
  );
  await press(doc, " ");
  const shown = BrowserTestUtils.waitForEvent(window.PopupNotifications.panel, "popupshown");
  await press(doc, "KEY_Enter");
  await shown;
  Assert.deepEqual(stub.asked, ["https://addons.mozilla.org/f/ublock.xpi"], "installs on enter");
  Assert.ok(
    window.PopupNotifications.getNotification("addon-webext-permissions", tab.linkedBrowser),
    "Firefox's permission prompt, on the setup page's tab",
  );
  Assert.equal(step(doc), "content_blocker", "the step waits for the answer");
  found(
    /** @type {MozPopupNotification | null} */ (window.PopupNotifications.panel.firstElementChild),
  ).secondaryButton.click();
  await atStep(doc, "search_engine");
  Assert.ok(
    found(doc.getElementById("v2-last")).textContent.includes("uBlock Origin declined"),
    "the result is reported",
  );
  Assert.strictEqual(await AddonManager.getAddonByID(UBLOCK), null, "declining installs nothing");
  stub.restore();
  await closeFlow(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function esc_in_the_search_field_leaves_the_field_first() {
  const { tab, doc } = await openFlow();
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await press(doc, "/");
  const field = found(doc.getElementById("v2-search"));
  Assert.equal(doc.activeElement, field, "/ focuses the search field");
  await press(doc, "q");
  Assert.equal(/** @type {HTMLInputElement} */ (field).value, "q", "q is typed there");
  await press(doc, "KEY_Escape");
  Assert.notEqual(doc.activeElement, field, "the first esc leaves the field");
  Assert.equal(step(doc), "content_blocker", "and keeps the page");
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Escape");
  await closed;
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

add_task(async function a_list_drawn_again_keeps_the_row_and_an_old_index_is_stale() {
  await IOUtils.writeUTF8(configFile(), "schema = 2\n");
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  const row = current(doc);
  Assert.ok(row, "the cursor is on an engine");
  const before = /** @type {{ serial: number }} */ (
    await SetupHost.stepView(tab.linkedBrowser, "search_engine")
  ).serial;
  // Another program names an engine that is not installed: the list gains Keep, first.
  const gone = 'schema = 2\n[search]\ndefault = "Gone"\n';
  await IOUtils.writeUTF8(configFile(), gone);
  await ConfigHost.reload();
  await TestUtils.waitForCondition(
    () => doc.querySelector('#v2-choices li[data-keep="true"]'),
    "drawn again with Keep",
  );
  Assert.equal(current(doc), row, "the cursor stays on its row, not its index");
  Assert.deepEqual(
    await SetupHost.saveStep(tab.linkedBrowser, "search_engine", 1, before),
    { stale: true },
    "an index into the list drawn before is refused",
  );
  Assert.equal(await IOUtils.readUTF8(configFile()), gone, "nothing written");
  await closeFlow(tab);
});

add_task(async function an_engine_named_in_another_case_is_the_one_in_force() {
  const engines = (await SearchService.getVisibleEngines()).map((e) => e.name);
  const name = found(engines.find((n) => n !== n.toLowerCase()));
  const text = `schema = 2\n[search]\ndefault = ${JSON.stringify(name.toLowerCase())}\n`;
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await toEngines(doc);
  Assert.equal(current(doc), name, "selected as the installed engine");
  Assert.ok(!doc.querySelector('#v2-choices li[data-keep="true"]'), "no Keep row");
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  Assert.equal(await IOUtils.readUTF8(configFile()), text, "enter wrote nothing");
  await closeFlow(tab);
});

// Your keys (chapter 4): the prefix and the hint letters (behaviours 9, 18, 25 and 26).

/** @param {Document} doc @returns {string} the step's text as the page shows it */
const stepText = (doc) => found(doc.getElementById("v2-text")).textContent ?? "";

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

add_task(async function prefix_step_draws_show_keybinds_with_each_prefix() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), "ctrl+b", "the prefix in force first");
  Assert.deepEqual(prefixRows(doc), ["ctrl+b ? lists every key", "ctrl+a ? lists every key"]);
  Assert.ok(stepText(doc).includes("ctrl+b ? lists them now"), stepText(doc));
  Assert.equal(writes(doc), "Writes nothing");
  await press(doc, "j");
  Assert.equal(writes(doc), 'Writes [keys] prefix = "ctrl+a"');
  await closeFlow(tab);
});

add_task(async function prefix_step_changes_later_steps_hints() {
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "hint_letters");
  Assert.ok(
    (await IOUtils.readUTF8(configFile())).includes('[keys]\nprefix = "ctrl+a"'),
    "[keys] prefix written at enter",
  );
  Assert.ok(found(ConfigHost.keymap).keysFor("show_keybinds").includes("ctrl+a ?"), "applied live");
  // Back on the prefix step, its text and the value in force follow the new prefix.
  await press(doc, "h");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), "ctrl+a", "the prefix just saved is in force");
  Assert.ok(stepText(doc).includes("ctrl+a ? lists them now"), stepText(doc));
  // Every step drawn from now on names its keys with the new prefix.
  /** @type {string[]} */
  const kbds = [];
  for (const id of BUILT_STEPS) {
    const view = await SetupHost.stepView(tab.linkedBrowser, id);
    for (const part of view?.text ?? []) if (part.tag === "kbd") kbds.push(part.text);
  }
  Assert.ok(kbds.includes("ctrl+a ?"), kbds.join(", "));
  Assert.ok(!kbds.some((k) => k.startsWith("ctrl+b ")), `no old prefix: ${kbds.join(", ")}`);
  await closeFlow(tab);
});

add_task(async function a_custom_prefix_and_hint_letters_offer_keep_and_write_nothing() {
  const text =
    '# mine\nschema = 2\n\n[keys]\nprefix = "ctrl+space"\n\n[modal]\nhint_chars = "fjdksla"\n';
  await IOUtils.writeUTF8(configFile(), text);
  await ConfigHost.reload();
  const { tab, doc } = await openFlow();
  await press(doc, "4");
  await atStep(doc, "prefix_key");
  Assert.equal(current(doc), 'Keep "ctrl+space"', "Keep first and selected");
  Assert.equal(prefixRows(doc)[0], "ctrl+space ? lists every key", "drawn with the prefix kept");
  Assert.equal(writes(doc), "Writes nothing");
  // j and k as typed on Colemak: Keep stays selected for a value the user set.
  await typeOn(doc, [
    ["j", "KeyY"],
    ["k", "KeyN"],
  ]);
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
  Assert.deepEqual(textKeys(doc), ["ctrl+l", "alt+d", "I", "ctrl+b u"], "the default keymap");
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
  await atStep(doc, "stop");
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

/** @param {Document} doc @returns {string[]} the labels of the open step's choices */
const choices = (doc) =>
  [...doc.querySelectorAll("#v2-choices li .name")].map((n) => n.textContent ?? "");
/** @param {Document} doc */
const statusLine = (doc) => found(doc.getElementById("v2-status"));
/** @param {Document} doc */
const keysText = (doc) => found(doc.getElementById("v2-keys")).textContent;

/** @param {Document} doc */
const footerText = (doc) =>
  `${found(doc.getElementById("v2-last")).textContent} | ${found(doc.getElementById("v2-saved")).textContent}`;

/** From the welcome screen straight to Moving in (behaviour 3). */
async function toDefaultBrowser(/** @type {Document} */ doc) {
  await press(doc, "2");
  await atStep(doc, "default_browser");
}

add_task(async function default_browser_step_calls_the_shell_service() {
  shellAnswers();
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(found(doc.getElementById("v2-progress")).textContent.includes("Moving in"));
  Assert.ok(
    statusLine(doc).textContent.includes("not your default browser"),
    "says it is not, now",
  );
  Assert.deepEqual(choices(doc), ["Make Vimma the default browser", "Not now"]);
  Assert.equal(current(doc), "Make Vimma the default browser");
  Assert.ok(
    !found(doc.getElementById("v2-choices")).textContent.includes("in force"),
    "an action has no value in force",
  );
  Assert.ok(found(doc.getElementById("v2-writes-row")).hidden, "an action writes no line");
  Assert.ok(keysText(doc).includes("enter do it and go on"), keysText(doc));
  await press(doc, "j");
  Assert.ok(keysText(doc).includes("enter go on"), `not now does nothing: ${keysText(doc)}`);
  await press(doc, "k", "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [[false]], "Make Default for this user, as Settings asks");
  const footer = footerText(doc);
  Assert.ok(footer.includes("Vimma is now the default browser"), footer);
  Assert.ok(footer.includes("made the default browser"), `saved this run: ${footer}`);
  Assert.ok(!footer.includes("nothing written"), footer);
  // Back, and on with "Go on": what Make Default did cannot be undone, so it stays listed.
  await press(doc, "h");
  await atStep(doc, "default_browser");
  Assert.deepEqual(choices(doc), ["Go on"], "Vimma is the default now");
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.ok(footerText(doc).includes("made the default browser"), footerText(doc));
  await press(doc, "s");
  await atStep(doc, "stop");
  const saved = found(doc.getElementById("v2-stop-saved")).textContent;
  Assert.ok(saved.includes("made the default browser"), saved);
  Assert.ok(!(await IOUtils.exists(configFile())), "config.toml is not written");
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_when_vimma_already_is_the_default() {
  shellAnswers({ isDefault: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(statusLine(doc).textContent.includes("already your default browser"));
  Assert.deepEqual(choices(doc), ["Go on"], "nothing to ask");
  Assert.ok(keysText(doc).includes("enter go on"), keysText(doc));
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [], "the shell service is not asked");
  Assert.ok(footerText(doc).includes("already the default browser"), footerText(doc));
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_why_it_cannot_make_vimma_the_default() {
  shellAnswers({ flatpak: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  Assert.ok(statusLine(doc).textContent.includes("Flatpak"), statusLine(doc).textContent);
  Assert.deepEqual(choices(doc), ["Go on"], "only moves on");
  await press(doc, "KEY_Enter");
  await atStep(doc, "bring_your_data");
  Assert.deepEqual(shell.calls, [], "Flatpak can neither set nor detect the default browser");
  await closeFlow(tab);
});

add_task(async function default_browser_step_says_when_a_locked_pref_hides_make_default() {
  shellAnswers();
  const pref = "pref.general.disable_button.default_browser";
  await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
  Services.prefs.lockPref(pref);
  try {
    const { tab, doc } = await openFlow();
    await toDefaultBrowser(doc);
    Assert.ok(
      statusLine(doc).textContent.includes("locked preference"),
      statusLine(doc).textContent,
    );
    Assert.deepEqual(choices(doc), ["Go on"], "only moves on");
    await press(doc, "KEY_Enter");
    await atStep(doc, "bring_your_data");
    Assert.deepEqual(shell.calls, [], "the shell service is not asked");
    Assert.ok(footerText(doc).includes("left as it is"), footerText(doc));
    await closeFlow(tab);
  } finally {
    Services.prefs.unlockPref(pref);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function a_failed_make_default_keeps_the_step_open() {
  shellAnswers({ setFails: true });
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => !notice(doc).hidden, "the step says so");
  Assert.ok(notice(doc).textContent.includes("did not make Vimma"), notice(doc).textContent);
  Assert.equal(step(doc), "default_browser", "the step stays open");
  Assert.equal(shell.calls.length, 1);
  await press(doc, "s");
  await atStep(doc, "bring_your_data");
  await closeFlow(tab);
});

add_task(async function import_step_names_sync_for_firefox() {
  shellAnswers();
  const { tab, doc } = await openFlow();
  await toDefaultBrowser(doc);
  await press(doc, "s");
  await atStep(doc, "bring_your_data");
  const text = found(doc.getElementById("v2-text")).textContent;
  Assert.ok(text.includes("A Firefox profile is not in it") && text.includes("Firefox Sync"));
  Assert.ok(
    [...doc.querySelectorAll("#v2-text code")].some((c) => c.textContent === ":settings sync"),
  );
  Assert.deepEqual(choices(doc), ["Open the import wizard", "Not now"]);
  await press(doc, "j", "KEY_Enter");
  await atStep(doc, "stop");
  Assert.ok(footerText(doc).includes("not now"), footerText(doc));
  await closeFlow(tab);
});

add_task(
  async function import_step_opens_the_wizard_over_the_setup_tab_and_moves_on_when_it_closes() {
    shellAnswers();
    const { tab, doc } = await openFlow();
    const browser = tab.linkedBrowser;
    await toDefaultBrowser(doc);
    await press(doc, "s");
    await atStep(doc, "bring_your_data");
    // The wizard fills its list after it opens; closed before then, its actor writes to a dead
    // window (browser_vimma_setup_moving_in.js).
    const ready = BrowserTestUtils.waitForEvent(window, "MigrationWizard:Ready");
    await press(doc, "KEY_Enter");
    const dialogs = () => gBrowser.getTabDialogBox(browser).getContentDialogManager().dialogs;
    await TestUtils.waitForCondition(() => dialogs().length === 1, "the wizard opens");
    const dialog = dialogs()[0];
    await dialog._dialogReady;
    await ready;
    Assert.ok(gBrowser.selectedTab === tab, "over the setup tab");
    // Square corners and the theme's font, as Settings (firefox-pages.css).
    const wizardDoc = dialog._frame.contentDocument;
    const wizard = found(wizardDoc.querySelector("migration-wizard"));
    // A button of the page the wizard shows: the others are not rendered and have no style.
    const button = found(
      [...found(wizard.shadowRoot).querySelectorAll("button.cancel-close")].find((b) =>
        b.checkVisibility(),
      ),
    );
    const style = found(wizardDoc.defaultView).getComputedStyle(button);
    Assert.equal(style.borderTopLeftRadius, "0px", "a square button");
    const font = found(wizardDoc.defaultView)
      .getComputedStyle(wizardDoc.documentElement)
      .getPropertyValue("--vimma-font")
      .trim();
    Assert.ok(font, "the theme's font is set");
    Assert.equal(style.fontFamily, font, "the theme's font");
    Assert.equal(step(doc), "bring_your_data", "the step waits for the wizard");
    dialog._frame.contentWindow.close();
    await atStep(doc, "stop");
    Assert.equal(dialogs().length, 0);
    const saved = found(doc.getElementById("v2-stop-saved")).textContent;
    Assert.ok(saved.includes("import wizard closed"), saved);
    await TestUtils.waitForCondition(() => doc.hasFocus(), "the setup page has the focus back");
    Assert.ok(Services.focus.focusedWindow === doc.defaultView, "its own window");
    await closeFlow(tab);
  },
);

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
  Assert.equal(current(doc), "Off", "off is in force without the key");
  Assert.equal(writes(doc), "Writes nothing");
  Assert.ok(!tabLineShown(), "no tab line yet");
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
  await choose(["j"], "always");
  Assert.equal(current(doc), "Always", "back opens on the value in force");
  await choose(["j"], "auto");
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
