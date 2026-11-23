/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The setup page around its chapters (docs/specs/first-run-setup.md, docs/specs/setup-v2.md):
// when it is offered, how it opens, what reaches it, and the config.toml file a step writes.
// The chapters' own tasks are in the browser_vimma_setup_v2_*.js files. AMO is pointed at a
// closed local port, so the content blocker shows the curated list offline and nothing leaves
// the machine; XDG_CONFIG_HOME is a temporary folder, so config.toml writes never reach the real
// ~/.config.

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

/* global Client -- from head_vimma_control.js */
Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);

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
 * Removes config.toml and reads the config now, so Vimma undoes the `[search] default` a step
 * saved before the next task starts. Left to the 2 s poll, the undo lands in whichever task is
 * running then and changes the default engine under it.
 */
async function removeConfig() {
  await IOUtils.remove(configFile(), { ignoreAbsent: true });
  await ConfigHost.reload();
  await TestUtils.waitForCondition(
    () => !Services.prefs.prefHasUserValue("vimma.search.applied"),
    "the [search] default a step saved is undone",
  );
}

async function openSetup() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SETUP_URL);
  const doc = docOf(tab);
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  tab.linkedBrowser.focus();
  return { tab, doc };
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
 * Waits for the page to show `id`: a step id with its view drawn, or "welcome".
 * @param {Document} doc @param {string} id
 */
function atStep(doc, id) {
  const root = doc.documentElement;
  return TestUtils.waitForCondition(
    () => root.dataset.step === id && (id === "welcome" || root.dataset.viewReady === "true"),
    `at ${id}`,
  );
}

/** @param {Document} doc @returns {string} the choice under the cursor */
const current = (doc) =>
  found(doc.querySelector("#v2-choices li[aria-current] .name")).textContent ?? "";

/** From the welcome screen to the search engine step, past the content blocker with nothing marked. */
async function toEngines(/** @type {Document} */ doc) {
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await press(doc, "KEY_Enter");
  await atStep(doc, "search_engine");
}

add_task(async function automation_and_config_path_skip_setup() {
  Assert.equal(SetupHost.offerBlocked, "automation", "a test harness never gets the setup");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", "/tmp/other.toml"]] });
  Assert.equal(SetupHost.offerBlocked, "path", "a managed config path never gets it");
  await SpecialPowers.popPrefEnv();
});

// The chapters are the only setup (setup-v2, slice 7): the first start opens their welcome.
add_task(async function first_run_shows_the_chapters_welcome_once() {
  Services.prefs.clearUserPref(OFFERED);
  const tabs = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, SETUP_URL, true);
  Assert.ok(SetupHost.offer(window), "offered on a fresh profile");
  const tab = await opened;
  Assert.equal(gBrowser.selectedTab, tab, "the welcome screen is the tab in front");
  const doc = docOf(tab);
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  Assert.equal(step(doc), "welcome");
  Assert.ok(!found(doc.getElementById("v2-welcome")).hidden, "the chapters' welcome is shown");
  Assert.ok(doc.querySelector("#v2-chapters li"), "with its chapter list");
  Assert.ok(doc.querySelector("#v2-welcome .vimma-logo"), "and the logo");
  Assert.ok(!doc.getElementById("summary"), "the summary flow is gone");
  Assert.equal(doc.activeElement?.id, "v2-start", "Set up has focus");
  Assert.ok(Services.prefs.getBoolPref(OFFERED, false), "recorded as offered");
  Assert.ok(!SetupHost.offer(window), "never offered twice");
  BrowserTestUtils.removeTab(tab);
  Assert.equal(gBrowser.tabs.length, tabs);
});

add_task(async function welcome_skip_changes_nothing() {
  const engine = (await SearchService.getDefault()).name;
  const { tab, doc } = await openSetup();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Escape");
  await closed;
  Assert.equal((await SearchService.getDefault()).name, engine, "the engine is unchanged");
  Assert.ok(!(await IOUtils.exists(configFile())), "no config.toml written");
});

add_task(async function welcome_enter_starts_the_first_chapter() {
  const { tab, doc } = await openSetup();
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await TestUtils.waitForCondition(() => doc.querySelector("#v2-offline:not([hidden])"));
  Assert.equal(doc.querySelectorAll("#v2-addons li").length, 3, "the curated list, offline");
  await press(doc, "j");
  Assert.ok(doc.querySelectorAll("#v2-addons li")[1].matches("[aria-current]"), "j moves");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function engine_step_starts_on_the_config_toml_default() {
  const original = await SearchService.getDefault();
  const others = (await SearchService.getVisibleEngines()).filter((e) => e !== original);
  Assert.greaterOrEqual(others.length, 2, "two engines besides the default");
  const [wanted, other] = others;
  // Written in another case: Vimma finds the engine as its [search] apply does.
  await IOUtils.writeUTF8(
    configFile(),
    `[search]\ndefault = ${JSON.stringify(wanted.name.toUpperCase())}\n`,
  );
  await ConfigHost.reload();
  await TestUtils.waitForCondition(
    async () => (await SearchService.getDefault()) === wanted,
    "config.toml's default applied",
  );
  // Changed in Settings since: config.toml still names the engine setup offers as current.
  await SearchService.setDefault(other, SearchService.CHANGE_REASON.USER);
  const { current } = await SetupHost.engines();
  Assert.equal(current, wanted.name, "config.toml's [search] default is the current engine");
  await removeConfig();
  await SearchService.setDefault(original, SearchService.CHANGE_REASON.UNKNOWN);
  Assert.equal((await SetupHost.engines()).current, original.name, "else Firefox's default");
});

add_task(async function a_step_creates_a_private_config_toml_when_absent() {
  const { tab, doc } = await openSetup();
  await toEngines(doc);
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  const text = await IOUtils.readUTF8(configFile());
  Assert.ok(text.includes(`[search]\ndefault = ${JSON.stringify(name)}\n`), "[search] default set");
  Assert.equal((await IOUtils.stat(configFile())).permissions, 0o600, "created 0600");
  await TestUtils.waitForCondition(async () => (await SearchService.getDefault()).name === name);
  BrowserTestUtils.removeTab(tab);
  await removeConfig();
});

add_task(async function a_step_keeps_comments_and_mode_of_config_toml() {
  const file = configFile();
  // An engine that is not installed: the step lists Keep first, and `j` picks a real one.
  const before = '# mine\n[search]\n# keep\ndefault = "x" # why\n';
  await IOUtils.writeUTF8(file, before);
  await IOUtils.setPermissions(file, 0o640);
  await ConfigHost.reload();
  const { tab, doc } = await openSetup();
  await toEngines(doc);
  await press(doc, "j");
  const name = current(doc);
  await press(doc, "KEY_Enter");
  await atStep(doc, "colours");
  Assert.equal(await IOUtils.readUTF8(file), before.replace('"x"', JSON.stringify(name)));
  Assert.equal((await IOUtils.stat(file)).permissions, 0o640, "mode kept");
  BrowserTestUtils.removeTab(tab);
  await removeConfig();
});

// A file that loads but cannot take `[search] default`, here an inline `search` table the writer
// does not edit: the step says so before `enter`, as the writer would refuse it after
// (setup-v2 behaviour 13).
add_task(async function a_step_names_a_key_the_file_cannot_take_before_enter() {
  const file = configFile();
  const before = "search = {}\n";
  await IOUtils.writeUTF8(file, before);
  await ConfigHost.reload();
  const { tab, doc } = await openSetup();
  await toEngines(doc);
  const notice = found(doc.getElementById("v2-notice"));
  Assert.ok(
    !notice.hidden &&
      notice.textContent.includes("config.toml:1: search is not a plain [search] table"),
    notice.textContent,
  );
  await press(doc, "j", "KEY_Enter", "s");
  await atStep(doc, "colours");
  Assert.equal(await IOUtils.readUTF8(file), before, "untouched");
  await removeConfig();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function colon_setup_opens_the_page() {
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, SETUP_URL, true);
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("setup");
  EventUtils.synthesizeKey("KEY_Enter");
  BrowserTestUtils.removeTab(await opened);
});

add_task(async function agent_role_cannot_open_setup() {
  Services.prefs.setBoolPref("vimma.control.enabled", false);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(MCP_ENABLED_PREF);
    Services.prefs.clearUserPref("vimma.control.enabled");
    await VimmaControl.settled();
  });
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  const welcome = await c.handshake({ protocol: 2, role: "agent" });
  Assert.equal(welcome?.role, "agent");
  await c.call("agent-hello", { client: { name: "setup-test" }, via: "test" });
  const tabs = gBrowser.tabs.length;
  for (const url of [SETUP_URL, "chrome://browser/content/vimma/setup/setup.html"]) {
    const r = await c.call("agent-open", { url });
    Assert.equal(r.error?.code, "invalid-args", `${url} is refused`);
  }
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  c.close();
});

/** prefs.js as on disk now: what a start after a crash would read. */
const prefsOnDisk = () =>
  IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "prefs.js")).catch(() => "");
const OFFERED_ON_DISK = `user_pref("${OFFERED}", true);`;

add_task(async function offered_is_on_disk_at_once_and_skip_never_offers_again() {
  Services.prefs.clearUserPref(OFFERED);
  Services.prefs.savePrefFile(null);
  await TestUtils.waitForCondition(
    async () => !(await prefsOnDisk()).includes(OFFERED_ON_DISK),
    "cleared on disk",
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, SETUP_URL, true);
  Assert.ok(SetupHost.offer(window), "offered on a fresh profile");
  // Before Firefox's own delayed write (500 ms after a change): a crash from here on still
  // finds the profile marked as offered.
  await TestUtils.waitForCondition(
    async () => (await prefsOnDisk()).includes(OFFERED_ON_DISK),
    "recorded in prefs.js at once",
    50,
    8,
  );
  const tab = await opened;
  const doc = docOf(tab);
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  tab.linkedBrowser.focus();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Escape");
  await closed;
  Assert.ok(Services.prefs.getBoolPref(OFFERED), "still recorded after Skip");
  Assert.ok(!SetupHost.offer(window), "a later start does not offer it");
});
