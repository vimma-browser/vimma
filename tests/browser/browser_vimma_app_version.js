/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-app-version.md

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

/**
 * The Firefox version Vimma is built on. For a Firefox release the app version (version.txt)
 * and the Gecko version (config/milestone.txt) are the same string, so upstream bumps need no
 * test change.
 */
const FIREFOX_VERSION = Services.appinfo.platformVersion;

add_task(async function app_version_is_firefox_version() {
  Assert.equal(Services.appinfo.version, FIREFOX_VERSION, "Services.appinfo.version");
  Assert.equal(AppConstants.MOZ_APP_VERSION, FIREFOX_VERSION, "AppConstants.MOZ_APP_VERSION");
});

add_task(async function display_version_is_vimma_version() {
  const display = AppConstants.MOZ_APP_VERSION_DISPLAY;
  // surfer.json brands.vimma.release.displayVersion; plan §7: 0.x until M6.
  Assert.ok(/^0\.\d+\.\d+$/.test(display), `MOZ_APP_VERSION_DISPLAY ${display} is 0.x`);
  Assert.notEqual(display, Services.appinfo.version, "display version is not the Firefox version");
});

add_task(async function remote_settings_filters_see_firefox_version() {
  const { ClientEnvironmentBase } = ChromeUtils.importESModule(
    "resource://gre/modules/components-utils/ClientEnvironment.sys.mjs",
  );
  Assert.equal(ClientEnvironmentBase.version, FIREFOX_VERSION, "ClientEnvironment env.version");
});

add_task(async function targeting_sees_firefox_version() {
  const { TargetingContext } = ChromeUtils.importESModule(
    "resource://messaging-system/targeting/Targeting.sys.mjs",
  );
  const { ASRouterTargeting } = ChromeUtils.importESModule(
    "resource:///modules/asrouter/ASRouterTargeting.sys.mjs",
  );
  Assert.equal(
    await new TargetingContext().evalWithDefault("version"),
    FIREFOX_VERSION,
    "targeting version",
  );
  Assert.equal(
    ASRouterTargeting.Environment.firefoxVersion,
    parseInt(FIREFOX_VERSION, 10),
    "ASRouter firefoxVersion",
  );
});

add_task(async function webcompat_interventions_see_firefox_version() {
  await SpecialPowers.pushPrefEnv({ set: [["extensions.background.idle.timeout", 300000]] });
  const policy = WebExtensionPolicy.getByID("webcompat@mozilla.org");
  Assert.ok(policy, "webcompat add-on is installed");
  await policy.extension.promiseBackgroundStarted();
  // The background has started, so it has its page and the page its browser; spawn throws
  // without one, as the read through it did before.
  const background = /** @type {{ xulBrowser: MozBrowser }} */ (policy.extension.backgroundContext);
  // interventions.js parses this value to gate min_version / max_version.
  const seen = await SpecialPowers.spawn(background.xulBrowser, [], () =>
    content.wrappedJSObject.browser.appConstants.getAppVersion(),
  );
  Assert.equal(seen, FIREFOX_VERSION, "webcompat getAppVersion()");
});

add_task(async function extensions_see_firefox_version() {
  /** @type {ExtensionWrapper} */
  const extension = ExtensionTestUtils.loadExtension({
    async background() {
      // The extension's own global `browser`, which a test file's scope does not have.
      const { browser } = /** @type {typeof globalThis & { browser: WebExtensionApi }} */ (
        globalThis
      );
      const info = await browser.runtime.getBrowserInfo();
      browser.test.sendMessage("info", info);
    },
  });
  await extension.startup();
  // The BrowserInfo the background sent; a read through a missing one throws.
  const info = /** @type {{ version: string }} */ (await extension.awaitMessage("info"));
  await extension.unload();
  Assert.equal(info.version, FIREFOX_VERSION, "runtime.getBrowserInfo().version");
});

add_task(async function about_dialog_shows_vimma_version() {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    undefined,
    (win) => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml",
  );
  openAboutDialog();
  const dialog = await opened;
  try {
    // The About dialog is localized (aboutDialog.xhtml links its .ftl files) and has its version
    // line; getAttributes throws for a missing one.
    const l10n = /** @type {DocumentL10n} */ (dialog.document.l10n);
    const { args } = l10n.getAttributes(
      /** @type {HTMLElement} */ (dialog.document.getElementById("version")),
    );
    Assert.equal(args?.version, AppConstants.MOZ_APP_VERSION_DISPLAY, "About dialog version");
  } finally {
    await BrowserTestUtils.closeWindow(dialog);
  }
});
