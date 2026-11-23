/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's shared mochitest helpers (docs/specs/setup-v2.md), loaded with
// Services.scriptloader.loadSubScript by each browser_vimma_setup_v2_*.js file, one file per
// chapter so each stays well inside the harness's time limit for a file and a failure names its
// chapter. The page's offering and its config.toml file checks are in browser_vimma_setup.js.
// AMO is pointed at a closed local port, so the content blocker shows the curated list offline
// and nothing leaves the machine; XDG_CONFIG_HOME is a temporary folder, so config.toml writes
// never reach the real ~/.config.

"use strict";

/* exported SetupHost, ConfigHost, SearchService, AppConstants, BUILT_STEPS, McpHost, found */
/* exported CHAPTERS_PREF, shell, configFile, removeConfig, press, step, openFlow */
/* exported closeFlow, atStep, current, writes, notice, toEngines, choiceNote */

/** @type {VimmaModules["chrome://browser/content/vimma/setup/SetupHost.sys.mjs"]["SetupHost"]} */
const SetupHost = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/setup/SetupHost.sys.mjs",
).SetupHost;
/** @type {VimmaModules["chrome://browser/content/vimma/config/ConfigHost.sys.mjs"]["ConfigHost"]} */
const ConfigHost = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
).ConfigHost;
/** @type {VimmaModules["moz-src:///toolkit/components/search/SearchService.sys.mjs"]["SearchService"]} */
const SearchService = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs",
).SearchService;
/** @type {VimmaModules["resource://gre/modules/AppConstants.sys.mjs"]["AppConstants"]} */
const AppConstants = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs",
).AppConstants;
/** @type {VimmaModules["chrome://browser/content/vimma/core/setup.mjs"]["BUILT_STEPS"]} */
const BUILT_STEPS = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/setup.mjs",
).BUILT_STEPS;
/** @type {VimmaModules["chrome://browser/content/vimma/host/mcp-ops.mjs"]["McpHost"]} */
const McpHost = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
).McpHost;
/** @type {VimmaModules["moz-src:///browser/components/shell/ShellService.sys.mjs"]["ShellService"]} */
const ShellService = ChromeUtils.importESModule(
  "moz-src:///browser/components/shell/ShellService.sys.mjs",
).ShellService;
/** @type {VimmaModules["moz-src:///browser/components/migration/MigrationUtils.sys.mjs"]["MigrationUtils"]} */
const MigrationUtils = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
).MigrationUtils;
/** @type {VimmaModules["moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs"]["InternalTestingProfileMigrator"]} */
const InternalTestingProfileMigrator = ChromeUtils.importESModule(
  "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs",
).InternalTestingProfileMigrator;
/** @type {VimmaModules["resource://testing-common/Sinon.sys.mjs"]["sinon"]} */
const sinon = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs").sinon;
/** @type {VimmaModules["chrome://browser/content/vimma/services/AppLauncher.sys.mjs"]["AppLauncher"]} */
const AppLauncher = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/AppLauncher.sys.mjs",
).AppLauncher;

const SETUP_URL = "about:vimma-setup";
const OFFERED = "vimma.setup.offered";
/** The chapters finished on an earlier run, which every file's walks record. */
const CHAPTERS_PREF = "vimma.setup.chapters";

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

// XDG_CONFIG_HOME first: the vimma.config.path change reloads the config at once, and would
// otherwise read the developer's own ~/.config/vimma/config.toml.
// The folder XDG_CONFIG_HOME points at while this file runs. configFile() reads it here, not
// from the variable: the cleanup below puts the variable back first (empty on macOS), and the
// tasks' own cleanups, which run after it, still remove the right file (#1396).
let configHome = "";

add_task(async () => {
  const xdg = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-setup");
  configHome = xdg;
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
    Services.prefs.clearUserPref(CHAPTERS_PREF);
    await IOUtils.remove(xdg, { recursive: true, ignoreAbsent: true });
  });
});

const configFile = () => PathUtils.join(configHome, "vimma", "config.toml");

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

/**
 * @param {Document} doc
 * @param {...(string | { ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean })} keys
 *   EventUtils key names, each followed by its modifiers when it has any
 */
async function press(doc, ...keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof k !== "string") continue;
    // A key followed by its modifiers: `press(doc, "a", { ctrlKey: true })`.
    const next = keys[i + 1];
    EventUtils.synthesizeKey(k, typeof next === "object" ? next : {}, found(doc.defaultView));
    await TestUtils.waitForTick();
  }
}

/** @param {Document} doc */
const step = (doc) => doc.documentElement.dataset.step;

// browser.toml sets vimma.theme.source=builtin, so no Omarchy theme is found unless a task
// points the theme at a folder of its own.

/** @param {BrowserWindow} [win] */
async function openFlow(win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, SETUP_URL);
  const doc = docOf(tab);
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true", "ready");
  tab.linkedBrowser.focus();
  return { tab, doc };
}

/** @param {MozTabbrowserTab} tab */
async function closeFlow(tab) {
  if (tab.linkedBrowser && !tab.closing) BrowserTestUtils.removeTab(tab);
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

/** @param {Document} doc */
const choiceNote = (doc) => {
  const note = found(doc.getElementById("v2-choice-note"));
  return note.hidden ? "" : note.textContent;
};
