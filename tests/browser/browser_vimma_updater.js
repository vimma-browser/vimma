/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Specs: docs/specs/m0-updater.md and m6a-updater.md (decision 8). A source or dev build has no
// app updater, so nothing asks Mozilla's update server (aus5.mozilla.org) for a Firefox build,
// and the About dialog and Settings show no update UI (no button, no error). A build with
// VIMMA_UPDATES=1 (release and nightly) has Firefox's updater, which asks updates.vimma.dev
// instead; neither ever asks aus5. Skipped on artifact builds (browser.toml, ADR-010): they run
// Mozilla's libxul, which has Mozilla's updater. System add-ons: browser_vimma_system_addons.js.
//
// The harness profile turns app updates off for tests (app.update.disabledForTesting,
// app.update.checkInstallTime in testing/profiles/*/user.js), so the tasks undo that first: they
// test what Vimma ships, not what the harness forces.

"use strict";

/* global AUS_HOST, watchUpdateServer -- from head_vimma_aus.js */
Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_aus.js", this);

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const VIMMA_UPDATE_URL =
  "https://updates.vimma.dev/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml";

/** True on a VIMMA_UPDATES=1 build, which has Firefox's updater (m6a-updater decision 8). */
const UPDATER = AppConstants.MOZ_UPDATER;

add_task(function update_url_matches_the_build() {
  info(`MOZ_UPDATER: ${UPDATER}`);
  Assert.strictEqual(
    Services.appinfo.updateURL,
    UPDATER ? VIMMA_UPDATE_URL : "",
    UPDATER ? "[AppUpdate] URL is updates.vimma.dev's" : "application.ini has no [AppUpdate] URL",
  );
});

/**
 * Cancels, before they connect, the checks an updater build's About dialog or Settings may
 * start, since the harness forbids the network; returns the URLs seen.
 */
function holdVimmaUpdateHost() {
  /** @type {string[]} */
  const seen = [];
  const observer = {
    /** @param {nsISupports} subject */
    observe(subject) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.host == "updates.vimma.dev") {
        seen.push(channel.URI.spec);
        channel.cancel(Cr.NS_BINDING_ABORTED);
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-opening-request");
  return { seen, stop: () => Services.obs.removeObserver(observer, "http-on-opening-request") };
}

/**
 * The URL the app update service would ask, or null when it has none or does not exist. A
 * check itself cannot be driven here: it first waits for any other running instance of the app
 * (waitForOtherInstances), which a developer's own browser makes nondeterministic.
 */
async function appUpdateURL() {
  if (!Ci.nsIUpdateChecker || !("@mozilla.org/updates/update-checker;1" in Cc)) {
    return null;
  }
  try {
    const checker = Cc["@mozilla.org/updates/update-checker;1"].getService(Ci.nsIUpdateChecker);
    return await checker.getUpdateURL(Ci.nsIUpdateChecker.BACKGROUND_CHECK);
  } catch (e) {
    info(`update checker unavailable: ${e}`);
    return null;
  }
}

add_task(async function app_update_service_asks_only_vimma() {
  await SpecialPowers.pushPrefEnv({ set: [["app.update.disabledForTesting", false]] });
  try {
    const url = await appUpdateURL();
    if (UPDATER) {
      Assert.equal(
        url,
        "https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml",
        "the update service asks updates.vimma.dev with the platform and channel only",
      );
    } else {
      Assert.equal(url, null, "the update service has no URL to check");
    }
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

const ERROR_PANELS = [
  "checkingFailed",
  "downloadFailed",
  "internalError",
  "policyDisabled",
  "unsupportedSystem",
];

add_task(async function about_dialog_never_asks_mozilla() {
  await SpecialPowers.pushPrefEnv({ set: [["app.update.disabledForTesting", false]] });
  const watch = watchUpdateServer();
  const vimmaHost = holdVimmaUpdateHost();
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    undefined,
    (win) => win.document.documentURI == "chrome://browser/content/aboutDialog.xhtml",
  );
  openAboutDialog();
  const dialog = await opened;
  try {
    const doc = dialog.document;
    Assert.ok(BrowserTestUtils.isVisible(doc.getElementById("version")), "version shown");
    if (UPDATER) {
      // Firefox's update UI is expected on an updater build; only the server it asks matters.
      return;
    }
    const deck = doc.getElementById("updateDeck");
    Assert.equal(deck, null, `no update panel (shown: ${deck?.selectedPanel?.id})`);
    Assert.equal(doc.getElementById("checkForUpdatesButton"), null, "no check-for-updates button");
    for (const id of ERROR_PANELS) {
      const panel = doc.getElementById(id);
      Assert.ok(!panel || !BrowserTestUtils.isVisible(panel), `no ${id} message`);
    }
  } finally {
    await BrowserTestUtils.closeWindow(dialog);
    watch.stop();
    vimmaHost.stop();
    await SpecialPowers.popPrefEnv();
  }
  Assert.deepEqual(watch.seen, [], `About dialog made no request to ${AUS_HOST}`);
  if (!UPDATER) {
    Assert.deepEqual(vimmaHost.seen, [], "a build without the updater asks no update host");
  }
});

add_task(async function settings_never_ask_mozilla() {
  await SpecialPowers.pushPrefEnv({ set: [["app.update.disabledForTesting", false]] });
  const watch = watchUpdateServer();
  const vimmaHost = holdVimmaUpdateHost();
  try {
    await BrowserTestUtils.withNewTab("about:preferences#general", async (browser) => {
      const doc = browser.contentDocument;
      const group = await TestUtils.waitForCondition(
        () => doc.querySelector('setting-group[groupid="updates"]'),
        "updates group rendered",
      );
      // Wait for the group's controls, whichever of the two branches it shows. A setting whose
      // `visible` callback is false renders as a hidden setting-control.
      const shown = (id) => {
        const el = doc.getElementById(`setting-control-${id}`);
        return !!el && !el.hidden;
      };
      await TestUtils.waitForCondition(
        () => shown("updatesManagedByOS") || shown("updateApp"),
        "updates group populated",
      );
      Assert.ok(group, "updates group present");
      if (UPDATER) {
        Assert.ok(shown("updateApp"), "an updater build shows Firefox's update status");
      } else {
        Assert.ok(!shown("updateApp"), "no update status or check-for-updates button");
        Assert.ok(!shown("installationFieldset"), "no automatic-update choice");
      }
    });
  } finally {
    watch.stop();
    vimmaHost.stop();
    await SpecialPowers.popPrefEnv();
  }
  Assert.deepEqual(watch.seen, [], `Settings made no request to ${AUS_HOST}`);
});
