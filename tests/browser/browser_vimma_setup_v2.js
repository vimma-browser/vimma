/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's chapters on the setup page (docs/specs/setup-v2.md), with vimma.feature.setupV2 on
// until its last slice; the summary flow's tasks are in browser_vimma_setup.js. AMO is pointed at
// a closed local port, so the content blocker shows the curated list offline and nothing leaves
// the machine; XDG_CONFIG_HOME is a temporary folder, so config.toml writes never reach the real
// ~/.config. A later slice adds its steps' tasks here.

"use strict";

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

/** Enter on every step, then on the last stop screen, which closes the page. */
async function enterThrough(/** @type {Document} */ doc, /** @type {MozTabbrowserTab} */ tab) {
  await toEngines(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
  await press(doc, "KEY_Enter");
  await atStep(doc, "address_bar");
  await press(doc, "KEY_Enter");
  await atStep(doc, "stop");
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
  const text = '# mine\nschema = 2\n\n[ui]\ntoolbar = "shown" # why\n';
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
    await press(doc, "KEY_Enter");
    await atStep(doc, "address_bar");
    Assert.equal(current(doc), "Shown", "the toolbar in force is selected");
    await press(doc, "KEY_Enter");
    await atStep(doc, "stop");
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
  await press(doc, "s");
  await atStep(doc, "colours");
  await press(doc, "k");
  Assert.equal(current(doc), "Dark");
  const before = /** @type {{ serial: number }} */ (
    await SetupHost.stepView(tab.linkedBrowser, "colours")
  ).serial;
  // Another program sets a dark-only palette: the list gains Keep, first.
  await IOUtils.writeUTF8(configFile(), 'schema = 2\n[theme]\nname = "tokyo-night"\n');
  await ConfigHost.reload();
  await TestUtils.waitForCondition(
    () => doc.querySelector('#v2-choices li[data-keep="true"]'),
    "drawn again with Keep",
  );
  Assert.equal(current(doc), "Dark", "the cursor stays on its row, not its index");
  Assert.deepEqual(
    await SetupHost.saveStep(tab.linkedBrowser, "colours", 1, before),
    { stale: true },
    "an index into the list drawn before is refused",
  );
  Assert.equal(
    await IOUtils.readUTF8(configFile()),
    'schema = 2\n[theme]\nname = "tokyo-night"\n',
    "nothing written",
  );
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

/** @param {Document} doc @returns {string[]} the keys the step's text names */
const textKeys = (doc) => [...doc.querySelectorAll("#v2-text kbd")].map((k) => k.textContent ?? "");
/** @param {Document} doc @returns {(string | undefined)[]} each choice's drawing: its toolbar */
const drawnToolbars = (doc) =>
  [...doc.querySelectorAll("#v2-choices li")].map(
    (li) => /** @type {HTMLElement | null} */ (li.querySelector(".window"))?.dataset.toolbar,
  );

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
    'schema = 2\n[keys]\nfocus_urlbar = ["ctrl+k", "ctrl+l"]\ntoggle_toolbar = []\n',
  );
  await ConfigHost.reload();
  await TestUtils.waitForCondition(() => textKeys(doc).includes("ctrl+k"), "the rebound key");
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
  await atStep(doc, "stop");
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
  await atStep(doc, "stop");
  Assert.equal(await IOUtils.readUTF8(configFile()), before, "nothing written");
  await closeFlow(tab);
  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref("vimma.ui.toolbar.hidden", false),
    "the toolbar is hidden again once the file is gone",
  );
});
