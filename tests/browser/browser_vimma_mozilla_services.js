/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-mozilla-services.md

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

/**
 * The harness profile gives several of these prefs user values (testing/profiles/*\/user.js), so
 * we read the default branch: that is what Vimma ships.
 */
const defaults = Services.prefs.getDefaultBranch("");
const AS = "browser.newtabpage.activity-stream.";

/** @type {Array<[string, boolean]>} */
const OFF_BOOL_PREFS = [
  ["app.normandy.enabled", false],
  ["app.shield.optoutstudies.enabled", false],
  ["nimbus.rollouts.enabled", false],
  ["datareporting.healthreport.uploadEnabled", false],
  ["datareporting.usage.uploadEnabled", false],
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["browser.tabs.crashReporting.sendReport", false],
  ["browser.crashReports.unsubmittedCheck.enabled", false],
  ["browser.crashReports.unsubmittedCheck.autoSubmit2", false],
  [`${AS}showSponsored`, false],
  [`${AS}system.showSponsored`, false],
  [`${AS}showSponsoredTopSites`, false],
  [`${AS}feeds.section.topstories`, false],
  ["browser.topsites.contile.enabled", false],
  [`${AS}asrouter.userprefs.cfr.addons`, false],
  [`${AS}asrouter.userprefs.cfr.features`, false],
  ["browser.vpn_promo.enabled", false],
  ["browser.preferences.moreFromMozilla", false],
  ["browser.promo.pin.enabled", false],
  ["browser.promo.relay.enabled", false],
  ["browser.contentblocking.report.show_mobile_app", false],
  ["browser.contentblocking.report.hide_vpn_banner", true],
];

/**
 * Security-critical services that must keep Firefox's defaults. Safe Browsing's prefs depend on
 * the build's Google key: browser_vimma_safebrowsing.js checks them (spec m0-safebrowsing-key).
 */
const KEPT_BOOL_PREFS = [
  "security.remote_settings.crlite_filters.enabled",
  "extensions.blocklist.enabled",
  "identity.fxaccounts.enabled",
  "extensions.update.enabled",
];

/**
 * @param {string} name
 * @returns {boolean | undefined}
 */
function defaultBool(name) {
  return Services.prefs.prefHasDefaultValue(name) ? defaults.getBoolPref(name) : undefined;
}

add_task(function test_studies_crash_and_sponsored_defaults_are_off() {
  for (const [name, expected] of OFF_BOOL_PREFS) {
    Assert.strictEqual(defaultBool(name), expected, `default ${name} is ${expected}`);
  }
  Assert.strictEqual(
    defaults.getStringPref("app.normandy.api_url", "unset"),
    "",
    "no Normandy URL",
  );

  const cfr = JSON.parse(defaults.getStringPref(`${AS}asrouter.providers.cfr`, "null"));
  Assert.equal(cfr?.id, "cfr", "the cfr provider is still declared");
  Assert.strictEqual(cfr?.enabled, false, "the remote cfr message provider is disabled");
});

add_task(function test_no_sponsored_address_bar_suggestions() {
  // Firefox Suggest rewrites this pref's default per region at startup (QuickSuggest.sys.mjs), so
  // Vimma sets it on the user branch, once, unless the user already chose.
  const SPONSORED = "browser.urlbar.suggest.quicksuggest.sponsored";
  const hadUserValue = Services.prefs.prefHasUserValue(SPONSORED);
  const userValue = Services.prefs.getBoolPref(SPONSORED);
  registerCleanupFunction(() => {
    if (hadUserValue) {
      Services.prefs.setBoolPref(SPONSORED, userValue);
    } else {
      Services.prefs.clearUserPref(SPONSORED);
    }
  });
  Assert.strictEqual(
    Services.prefs.getBoolPref(SPONSORED),
    false,
    "sponsored Suggest results are off",
  );

  const { MozillaServices } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/services/MozillaServices.sys.mjs",
  );
  Services.prefs.setBoolPref(SPONSORED, true);
  MozillaServices.applyUserDefaults();
  Assert.strictEqual(Services.prefs.getBoolPref(SPONSORED), true, "the user's choice is kept");

  Services.prefs.clearUserPref(SPONSORED);
  MozillaServices.applyUserDefaults();
  Assert.strictEqual(Services.prefs.getBoolPref(SPONSORED), false, "applied again when unset");
});

add_task(async function test_sponsored_suggestions_survive_suggest_migrations() {
  // A fresh profile runs every Firefox Suggest migration at browser-idle-startup, after our
  // first window. Migration 5 clears the sponsored pref's user value for DE, FR and IT with an
  // English locale; Vimma must set it again.
  const { QuickSuggest } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/QuickSuggest.sys.mjs",
  );
  const { Region } = ChromeUtils.importESModule("resource://gre/modules/Region.sys.mjs");
  const SPONSORED = "browser.urlbar.suggest.quicksuggest.sponsored";
  const MIGRATION = "browser.urlbar.quicksuggest.migrationVersion";
  await QuickSuggest.init();

  const region = Region.home;
  const migration = Services.prefs.getIntPref(MIGRATION, 0);
  registerCleanupFunction(async () => {
    Region._setHomeRegion(region, false);
    Services.prefs.setIntPref(MIGRATION, migration);
    await QuickSuggest._test_reset();
  });

  Region._setHomeRegion("DE", false);
  Assert.equal(Services.locale.appLocaleAsBCP47, "en-US", "migration 5 applies to this locale");
  Services.prefs.setBoolPref(SPONSORED, false); // what Vimma wrote at the first window
  Services.prefs.setIntPref(MIGRATION, 0); // a fresh profile
  await QuickSuggest._test_reset();

  Assert.ok(Services.prefs.getIntPref(MIGRATION) > 0, "the migrations ran");
  Assert.ok(Services.prefs.prefHasUserValue(SPONSORED), "Vimma's value is set again");
  Assert.strictEqual(Services.prefs.getBoolPref(SPONSORED), false, "sponsored Suggest is off");
});

/**
 * Whether the app ships the file behind a resource URL, without loading it: under the test
 * harness, loading a missing one crashes the browser on purpose ("Missing chrome or
 * resource URLs", CheckForBrokenChromeURL in netwerk/base/nsNetUtil.cpp).
 * @param {string} url
 */
function shipsFile(url) {
  const handler = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
    Ci.nsIResProtocolHandler,
  );
  const resolved = Services.io.newURI(handler.resolveURI(Services.io.newURI(url)));
  if (resolved.schemeIs("file")) return resolved.QueryInterface(Ci.nsIFileURL).file.exists();
  // A packaged build: jar:file:///…/omni.ja!/modules/…
  const jar = resolved.QueryInterface(Ci.nsIJARURI);
  const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
  zip.open(jar.JARFile.QueryInterface(Ci.nsIFileURL).file);
  try {
    return zip.hasEntry(jar.JAREntry);
  } finally {
    zip.close();
  }
}

add_task(async function test_normandy_and_nimbus_do_not_run() {
  const recipeRunnerUrl = "resource://normandy/lib/RecipeRunner.sys.mjs";
  // Firefox 162 removes Normandy's recipe runner (Mozilla bug 2059780): nothing is left to run.
  if (!shipsFile(recipeRunnerUrl)) {
    Assert.ok(true, "Firefox has no Normandy recipe runner");
    checkNimbusIsOff();
    return;
  }
  const { RecipeRunner } = ChromeUtils.importESModule(recipeRunnerUrl);
  // Normandy initialises RecipeRunner after the UI is available; wait for its verdict.
  await TestUtils.waitForCondition(
    () => RecipeRunner.enabled !== null,
    "RecipeRunner has checked its prefs",
  );
  Assert.strictEqual(RecipeRunner.enabled, false, "Normandy's recipe runner is disabled");
  checkNimbusIsOff();
});

function checkNimbusIsOff() {
  const { ExperimentAPI } = ChromeUtils.importESModule("resource://nimbus/ExperimentAPI.sys.mjs");
  Assert.strictEqual(ExperimentAPI.studiesEnabled, false, "Nimbus studies are disabled");
  Assert.strictEqual(ExperimentAPI.rolloutsEnabled, false, "Nimbus rollouts are disabled");
}

// The crash-reporter flag is compiled into libxul: browser_vimma_crash_reporter.js, which artifact
// builds skip (ADR-010).
add_task(function test_no_telemetry_upload() {
  // A build with MOZILLA_OFFICIAL turns telemetry upload on; that must not slip in unnoticed.
  Assert.strictEqual(AppConstants.MOZILLA_OFFICIAL, false, "not a MOZILLA_OFFICIAL build");
  Assert.strictEqual(
    AppConstants.MOZ_TELEMETRY_REPORTING,
    false,
    "built without telemetry reporting",
  );
});

add_task(function test_security_services_stay_on() {
  for (const name of KEPT_BOOL_PREFS) {
    Assert.strictEqual(defaultBool(name), true, `default ${name} is still true`);
  }
  Assert.ok(
    !Services.prefs.prefHasDefaultValue("services.settings.server"),
    "no default overrides the Remote Settings server",
  );
  Assert.ok(
    AppConstants.REMOTE_SETTINGS_SERVER_URLS[0].startsWith(
      "https://firefox.settings.services.mozilla.com/",
    ),
    "Remote Settings uses Mozilla's server",
  );
  Assert.ok(
    defaults
      .getStringPref("extensions.getAddons.get.url", "")
      .startsWith("https://services.addons.mozilla.org/"),
    "add-on metadata comes from AMO",
  );
});

/**
 * MOZILLA_OFFICIAL is unset (configs/common/mozconfig), so all.js would give Vimma a local
 * build's devtools defaults; the branding prefs put back release Firefox's. The harness profile
 * sets user values for the dump pair, hence the default branch.
 * @type {Array<[string, boolean]>}
 */
const OFFICIAL_DEVTOOLS_BOOL_PREFS = [
  ["devtools.chrome.enabled", false],
  ["devtools.debugger.remote-enabled", false],
  ["browser.dom.window.dump.enabled", false],
  ["devtools.console.stdout.chrome", false],
];

add_task(function test_devtools_defaults_match_official_firefox() {
  for (const [name, value] of OFFICIAL_DEVTOOLS_BOOL_PREFS) {
    Assert.strictEqual(defaultBool(name), value, `default ${name} is ${value}`);
  }
  // 0 keeps the web console's "allow pasting" guard (upstream's official brand); 5 disarms it.
  Assert.strictEqual(
    defaults.getIntPref("devtools.selfxss.count", -1),
    0,
    "default devtools.selfxss.count is 0",
  );
});
