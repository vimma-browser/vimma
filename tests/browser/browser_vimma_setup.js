/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The first-run setup page (docs/specs/first-run-setup.md). AMO is pointed at a closed local
// port, so step 1 shows the curated list offline and nothing leaves the machine; XDG_CONFIG_HOME
// is a temporary folder, so config.toml writes never reach the real ~/.config.

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

/* global Client -- from head_vimma_control.js */
Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);

// AMO answered by a local .sjs; the page appends `search/?…`, which the .sjs ignores.
const AMO_LOCAL =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_setup_amo.sjs?";
const UBLOCK = "uBlock0@raymondhill.net";

const SETUP_URL = "about:vimma-setup";
const OFFERED = "vimma.setup.offered";

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

async function openSetup() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SETUP_URL);
  const doc = tab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  tab.linkedBrowser.focus();
  return { tab, doc };
}

/** @param {...string} keys  EventUtils key names */
async function press(doc, ...keys) {
  for (const k of keys) {
    EventUtils.synthesizeKey(k, {}, doc.defaultView);
    await TestUtils.waitForTick();
  }
}

const step = (doc) => doc.documentElement.dataset.step;

add_task(async function automation_and_config_path_skip_setup() {
  Assert.equal(SetupHost.offerBlocked, "automation", "a test harness never gets the setup");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", "/tmp/other.toml"]] });
  Assert.equal(SetupHost.offerBlocked, "path", "a managed config path never gets it");
  await SpecialPowers.popPrefEnv();
});

add_task(async function first_run_shows_welcome_once() {
  Services.prefs.clearUserPref(OFFERED);
  const tabs = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, SETUP_URL, true);
  Assert.ok(SetupHost.offer(window), "offered on a fresh profile");
  const tab = await opened;
  Assert.equal(gBrowser.selectedTab, tab, "the welcome screen is the tab in front");
  const doc = tab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  Assert.equal(step(doc), "welcome");
  Assert.ok(doc.querySelector(".vimma-logo"), "the logo is shown");
  Assert.equal(doc.activeElement?.id, "setup-start", "Set up has focus");
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

add_task(async function welcome_enter_starts_the_setup() {
  const { tab, doc } = await openSetup();
  await press(doc, "KEY_Enter");
  Assert.equal(step(doc), "addons");
  await TestUtils.waitForCondition(() => doc.querySelector("#setup-offline:not([hidden])"));
  Assert.equal(doc.querySelectorAll("#setup-addons li").length, 3, "the curated list, offline");
  await press(doc, "j");
  Assert.ok(doc.querySelectorAll("#setup-addons li")[1].matches("[aria-current]"), "j moves");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function esc_changes_no_pref_engine_or_addon() {
  const engine = (await SearchService.getDefault()).name;
  const addons = (await AddonManager.getAllAddons()).length;
  const { tab, doc } = await openSetup();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Enter", "KEY_Enter", "j", "KEY_Escape");
  await closed;
  Assert.equal((await SearchService.getDefault()).name, engine);
  Assert.equal((await AddonManager.getAllAddons()).length, addons);
  Assert.ok(!(await IOUtils.exists(configFile())));
});

/** Through to the summary choosing the engine `n` rows below the current default. */
async function chooseEngine(doc, n) {
  await press(doc, "KEY_Enter", "KEY_Enter", ...Array(n).fill("j"), "KEY_Enter");
  Assert.equal(step(doc), "summary");
  return doc.querySelector("#setup-engines li[aria-current]")?.dataset.name;
}

add_task(async function summary_creates_a_private_config_toml_when_absent() {
  const { tab, doc } = await openSetup();
  const name = await chooseEngine(doc, 1);
  Assert.ok(name, "an engine was chosen");
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => step(doc) === "done");
  const text = await IOUtils.readUTF8(configFile());
  Assert.ok(text.includes(`[search]\ndefault = ${JSON.stringify(name)}\n`), "[search] default set");
  Assert.equal((await IOUtils.stat(configFile())).permissions, 0o600, "created 0600");
  await TestUtils.waitForCondition(async () => (await SearchService.getDefault()).name === name);
  BrowserTestUtils.removeTab(tab);
  await removeConfig();
});

add_task(async function summary_keeps_comments_and_mode_of_config_toml() {
  const file = configFile();
  const before = '# mine\n[search]\n# keep\ndefault = "x" # why\n';
  await IOUtils.writeUTF8(file, before);
  await IOUtils.setPermissions(file, 0o640);
  const { tab, doc } = await openSetup();
  const name = await chooseEngine(doc, 0);
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => step(doc) === "done");
  Assert.equal(await IOUtils.readUTF8(file), before.replace('"x"', JSON.stringify(name)));
  Assert.equal((await IOUtils.stat(file)).permissions, 0o640, "mode kept");
  BrowserTestUtils.removeTab(tab);
  await removeConfig();
});

add_task(async function summary_writes_nothing_on_a_parse_error() {
  const file = configFile();
  await IOUtils.writeUTF8(file, "[search\n");
  const { tab, doc } = await openSetup();
  await chooseEngine(doc, 0);
  // The summary reads config.toml asynchronously; the notice can land after the step changes.
  await TestUtils.waitForCondition(
    () => doc.querySelector("#setup-config-error:not([hidden])")?.textContent.includes(":1"),
    "names the line",
  );
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => step(doc) === "done");
  Assert.equal(await IOUtils.readUTF8(file), "[search\n", "untouched");
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

/** Step 1 with the local AMO answer, uBlock Origin marked. */
async function markUblock(doc) {
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() =>
    doc.querySelector(`#setup-addons li[data-guid="${UBLOCK}"]:not(.disabled)`),
  );
  await press(doc, " ");
  Assert.equal(
    doc.querySelector(`#setup-addons li[data-guid="${UBLOCK}"]`).getAttribute("aria-selected"),
    "true",
    "marked",
  );
}

add_task(async function install_shows_the_permission_prompt() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", AMO_LOCAL],
      ["xpinstall.signatures.required", false],
    ],
  });
  const stub = await stubInstall();
  const { tab, doc } = await openSetup();
  await markUblock(doc);
  const shown = BrowserTestUtils.waitForEvent(window.PopupNotifications.panel, "popupshown");
  await press(doc, "KEY_Enter", "KEY_Enter");
  Assert.equal(step(doc), "summary");
  await press(doc, "KEY_Enter");
  await shown;
  Assert.deepEqual(stub.asked, ["https://addons.mozilla.org/f/ublock.xpi"], "AMO's file URL");
  const prompt = window.PopupNotifications.getNotification(
    "addon-webext-permissions",
    tab.linkedBrowser,
  );
  Assert.ok(prompt, "Firefox's permission prompt, on the setup page's tab");
  Assert.equal(step(doc), "applying", "the page waits for the user's answer");
  window.PopupNotifications.panel.firstElementChild.secondaryButton.click();
  await TestUtils.waitForCondition(() => step(doc) === "done");
  Assert.equal(doc.querySelector("#setup-results li:last-child")?.className, "declined");
  Assert.equal(await AddonManager.getAddonByID(UBLOCK), null, "declining installs nothing");
  stub.restore();
  await removeConfig();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function closing_before_summary_changes_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.setup.amoApi", AMO_LOCAL]] });
  const stub = await stubInstall();
  const engine = (await SearchService.getDefault()).name;
  const addons = (await AddonManager.getAllAddons()).length;
  const { tab, doc } = await openSetup();
  await markUblock(doc);
  await press(doc, "KEY_Enter", "j");
  Assert.equal(step(doc), "engine", "an add-on marked and another engine under the cursor");
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForTick();
  Assert.equal((await SearchService.getDefault()).name, engine, "the engine is unchanged");
  Assert.equal((await AddonManager.getAllAddons()).length, addons, "no add-on installed");
  Assert.deepEqual(stub.asked, [], "no install started");
  Assert.ok(!(await IOUtils.exists(configFile())), "no config.toml written");
  stub.restore();
  await SpecialPowers.popPrefEnv();
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
  Assert.equal(welcome.role, "agent");
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
  const doc = tab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(() => doc.documentElement.dataset.ready === "true");
  tab.linkedBrowser.focus();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  await press(doc, "KEY_Escape");
  await closed;
  Assert.ok(Services.prefs.getBoolPref(OFFERED), "still recorded after Skip");
  Assert.ok(!SetupHost.offer(window), "a later start does not offer it");
});
