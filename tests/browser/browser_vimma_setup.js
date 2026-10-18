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

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs",
);

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

const SETUP_URL = "about:vimma-setup";
const OFFERED = "vimma.setup.offered";

add_task(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", "http://127.0.0.1:1/"],
      ["vimma.config.path", ""],
    ],
  });
  const xdg = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-setup");
  const before = Services.env.exists("XDG_CONFIG_HOME") ? Services.env.get("XDG_CONFIG_HOME") : "";
  Services.env.set("XDG_CONFIG_HOME", xdg);
  registerCleanupFunction(async () => {
    Services.env.set("XDG_CONFIG_HOME", before);
    Services.prefs.clearUserPref(OFFERED);
    await IOUtils.remove(xdg, { recursive: true, ignoreAbsent: true });
  });
});

const configFile = () =>
  PathUtils.join(Services.env.get("XDG_CONFIG_HOME"), "vimma", "config.toml");

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
});

add_task(async function summary_writes_nothing_on_a_parse_error() {
  const file = configFile();
  await IOUtils.writeUTF8(file, "[search\n");
  const { tab, doc } = await openSetup();
  await chooseEngine(doc, 0);
  Assert.ok(
    doc.querySelector("#setup-config-error:not([hidden])")?.textContent.includes(":1"),
    "names the line",
  );
  await press(doc, "KEY_Enter");
  await TestUtils.waitForCondition(() => step(doc) === "done");
  Assert.equal(await IOUtils.readUTF8(file), "[search\n", "untouched");
  await IOUtils.remove(file);
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
