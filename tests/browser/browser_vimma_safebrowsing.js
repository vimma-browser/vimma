/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-safebrowsing-key.md
//
// The key is a secret: never pass it, or a URL that holds it, to an assertion or to info().
// Only booleans, lengths and URL hosts leave this file.

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { SafeBrowsing } = ChromeUtils.importESModule("resource://gre/modules/SafeBrowsing.sys.mjs");
const { MozillaServices } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/MozillaServices.sys.mjs",
);

/** configure's value without `--with-google-safebrowsing-api-keyfile` (keyfiles.configure). */
const NO_KEY = "no-google-safebrowsing-api-key";
const KEY = AppConstants.MOZ_GOOGLE_SAFEBROWSING_API_KEY;
const HAS_KEY = typeof KEY === "string" && KEY.trim() !== "" && KEY !== NO_KEY;

/** The prefs Vimma turns off by default in a keyless build; Firefox's defaults are true. */
const KEY_GATED_PREFS = [
  "browser.safebrowsing.phishing.enabled",
  "browser.safebrowsing.malware.enabled",
];

/**
 * Google serves these only to Mozilla's key: ours gets 404 (v5 `mwb-4b`, `csdda-32b`) or 403 (v4
 * MALICIOUS_BINARY), and one refused list fails the whole batch, so no list would update.
 */
const MOZILLA_ONLY_TABLES = ["goog-badbinurl-proto", "goog-downloadwhite-proto"];
/** The lists our key fetches: phishing (unofficial builds use googpub-), malware, unwanted. */
const FETCHED_TABLES = ["googpub-phish-proto", "goog-malware-proto", "goog-unwanted-proto"];

const defaults = Services.prefs.getDefaultBranch("");

/** @param {string} name */
function defaultBool(name) {
  return Services.prefs.prefHasDefaultValue(name) ? defaults.getBoolPref(name) : undefined;
}

add_task(async function wait_for_safebrowsing_init() {
  await TestUtils.waitForCondition(() => SafeBrowsing.initialized, "SafeBrowsing initialised");
});

add_task(function test_build_has_the_expected_key() {
  // tools/mochitest.ts sets this from the key file; the nightly sets 1.
  const expected = Services.env.get("VIMMA_EXPECT_SAFEBROWSING_KEY");
  if (expected === "") {
    info(`No expectation set; this build is ${HAS_KEY ? "keyed" : "keyless"}`);
    Assert.ok(true, "nothing to compare");
    return;
  }
  Assert.strictEqual(HAS_KEY, expected === "1", `build has a Safe Browsing key: ${HAS_KEY}`);
});

add_task(function test_providers_ask_only_for_lists_our_key_gets() {
  for (const provider of ["google4", "google5"]) {
    const lists = defaults
      .getCharPref(`browser.safebrowsing.provider.${provider}.lists`)
      .split(",");
    for (const table of MOZILLA_ONLY_TABLES) {
      Assert.ok(!lists.includes(table), `${provider} does not ask for ${table}`);
    }
    for (const table of FETCHED_TABLES) {
      Assert.ok(lists.includes(table), `${provider} still asks for ${table}`);
    }
  }
  // Google's remote download check answers our key 403 (and the placeholder 400).
  Assert.strictEqual(
    defaultBool("browser.safebrowsing.downloads.remote.enabled"),
    false,
    "no remote download checks",
  );
});

add_task(async function test_keyed_build_fetches_google_lists() {
  if (!HAS_KEY) {
    Assert.ok(true, "keyless build: see test_keyless_build_is_honestly_off");
    return;
  }
  Assert.greater(KEY.length, 0, "the key is not empty");
  for (const provider of ["google4", "google5"]) {
    Assert.ok(
      SafeBrowsing.checkGoogleSafeBrowsingKey(provider),
      `${provider} passes the key check`,
    );
    const url = new URL(
      Services.urlFormatter.formatURL(
        defaults.getCharPref(`browser.safebrowsing.provider.${provider}.updateURL`),
      ),
    );
    Assert.equal(url.host, "safebrowsing.googleapis.com", `${provider} updates from Google`);
    Assert.ok(!url.href.includes("%GOOGLE_SAFEBROWSING_API_KEY%"), `${provider} key resolved`);
    const param = url.searchParams.get("key") ?? "";
    Assert.ok(param.length > 0 && param !== NO_KEY, `${provider} URL carries a real key`);
  }
  // The harness points the provider URLs at a local dummy (testing/profiles/unittest-required),
  // so only whether SafeBrowsing kept them is meaningful here.
  Assert.ok(SafeBrowsing.providers.google4.updateURL !== "", "SafeBrowsing kept google4's URL");
  for (const table of FETCHED_TABLES) {
    Assert.equal(SafeBrowsing.listToProvider[table], "google5", `${table} updates from google5`);
  }
  for (const name of KEY_GATED_PREFS) {
    Assert.strictEqual(defaultBool(name), true, `default ${name} is Firefox's true`);
  }
});

add_task(async function test_keyless_build_is_honestly_off() {
  if (HAS_KEY) {
    Assert.ok(true, "keyed build: see test_keyed_build_fetches_google_lists");
    return;
  }
  for (const name of KEY_GATED_PREFS) {
    Assert.strictEqual(defaultBool(name), false, `default ${name} is false without a key`);
    Assert.ok(!Services.prefs.prefHasUserValue(name), `${name} has no user value`);
  }
  for (const provider of ["google4", "google5"]) {
    Assert.equal(
      SafeBrowsing.providers[provider]?.updateURL ?? "",
      "",
      `${provider} fetches nothing without a key`,
    );
  }

  await BrowserTestUtils.withNewTab("about:preferences#privacy", async (browser) => {
    const doc = browser.contentDocument;
    const box = await TestUtils.waitForCondition(
      () => doc.getElementById("enableSafeBrowsing"),
      "the Safe Browsing checkbox is rendered",
    );
    await box.updateComplete;
    Assert.strictEqual(box.checked, false, "Settings shows Safe Browsing off");
  });
});

add_task(function test_defaults_follow_the_key() {
  const before = KEY_GATED_PREFS.map((name) => [name, defaultBool(name)]);
  registerCleanupFunction(() => {
    for (const [name, value] of before) {
      defaults.setBoolPref(/** @type {string} */ (name), /** @type {boolean} */ (value));
    }
  });

  for (const name of KEY_GATED_PREFS) defaults.setBoolPref(name, true);
  MozillaServices.applySafeBrowsingDefaults("a-fake-key-for-this-test");
  for (const name of KEY_GATED_PREFS) {
    Assert.strictEqual(defaultBool(name), true, `with a key, default ${name} is left alone`);
  }

  for (const placeholder of [NO_KEY, ""]) {
    for (const name of KEY_GATED_PREFS) defaults.setBoolPref(name, true);
    MozillaServices.applySafeBrowsingDefaults(placeholder);
    for (const name of KEY_GATED_PREFS) {
      Assert.strictEqual(
        defaultBool(name),
        false,
        `keyless (${placeholder || "empty"}): default ${name} is false`,
      );
      Assert.ok(!Services.prefs.prefHasUserValue(name), `${name} got no user value`);
    }
  }
});
