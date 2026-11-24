/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Setup v2's first chapter, Essentials (docs/specs/setup-v2.md): the content blocker and the
// search engine steps.

"use strict";

/* global SetupHost, ConfigHost, SearchService, found -- from head_vimma_setup_chapters.js */
/* global configFile, press, step, openFlow, closeFlow -- from head_vimma_setup_chapters.js */
/* global atStep, current, writes, notice, toEngines -- from head_vimma_setup_chapters.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_setup_chapters.js",
  this,
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

// The prompt anchors to the page's browser; without one (browserFor found none, as after a
// process switch) the add-on is reported failed and the step still goes on, rather than handing
// Firefox a null anchor.
add_task(async function install_without_the_pages_browser_fails_and_finishes() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.setup.amoApi", AMO_LOCAL],
      ["xpinstall.signatures.required", false],
    ],
  });
  const stub = await stubInstall();
  const realInstall = SetupHost.install;
  SetupHost.install = (_browser, guid) => realInstall.call(SetupHost, null, guid);
  registerCleanupFunction(() => (SetupHost.install = realInstall));
  const { tab, doc } = await openFlow();
  await press(doc, "KEY_Enter");
  await atStep(doc, "content_blocker");
  await TestUtils.waitForCondition(() =>
    doc.querySelector(`#v2-addons li[data-guid="${UBLOCK}"]:not(.disabled)`),
  );
  await press(doc, " ");
  await press(doc, "KEY_Enter");
  await atStep(doc, "search_engine");
  SetupHost.install = realInstall;
  Assert.ok(
    found(doc.getElementById("v2-last")).textContent.includes("uBlock Origin failed"),
    "reported failed",
  );
  Assert.deepEqual(stub.asked, [], "AMO never asked: install fails before AddonManager");
  Assert.strictEqual(await AddonManager.getAddonByID(UBLOCK), null, "nothing installed");
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
