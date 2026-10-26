/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-branding.md

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const BRAND = "Vimma";

/**
 * Formats Fluent terms from the branding bundle through throw-away test messages.
 *
 * @param {string[]} terms term ids without the leading "-"
 * @returns {Record<string, string>}
 */
function formatBrandTerms(terms) {
  const bundles = L10nRegistry.getInstance().generateBundlesSync(["en-US"], ["branding/brand.ftl"]);
  const bundle = bundles.next().value;
  Assert.ok(bundle, "branding/brand.ftl is registered");
  const source = terms.map((t) => `vimma-test-${t} = { -${t} }`).join("\n");
  bundle.addResource(new FluentResource(source));
  /** @type {Record<string, string>} */
  const out = {};
  for (const t of terms) {
    const msg = bundle.getMessage(`vimma-test-${t}`);
    // Strip Unicode isolation marks Fluent wraps placeables in.
    out[t] = bundle.formatPattern(msg.value).replace(/[\u2068\u2069]/g, "");
  }
  return out;
}

add_task(async function app_name_and_vendor_are_vimma() {
  Assert.equal(Services.appinfo.name, BRAND, "Services.appinfo.name");
  Assert.equal(Services.appinfo.vendor, BRAND, "Services.appinfo.vendor");
  // surfer.json brands.vimma.release.displayVersion; Surfer falls back to 1.0.0 if it is lost.
  // Plan §7: 0.x until M6. Vimma's product version is the display version; appinfo.version is
  // the Firefox version (spec m0-app-version, browser_vimma_app_version.js).
  const display = AppConstants.MOZ_APP_VERSION_DISPLAY;
  Assert.ok(/^0\.\d+\.\d+$/.test(display), `MOZ_APP_VERSION_DISPLAY ${display} is 0.x`);
});

add_task(async function brand_strings_are_vimma() {
  const terms = formatBrandTerms([
    "brand-shorter-name",
    "brand-short-name",
    "brand-full-name",
    "brand-product-name",
    "vendor-short-name",
  ]);
  for (const [term, value] of Object.entries(terms)) {
    Assert.equal(value, BRAND, `-${term} in branding/brand.ftl`);
  }

  const props = Services.strings.createBundle("chrome://branding/locale/brand.properties");
  Assert.equal(props.GetStringFromName("brandShortName"), BRAND, "brand.properties brandShortName");
});

add_task(async function window_title_names_vimma() {
  const defaultTitle = await document.l10n.formatValue("browser-main-window-default-title");
  Assert.equal(defaultTitle, BRAND, "default window title");

  await BrowserTestUtils.withNewTab("data:text/html,<title>vimma-page</title>", async () => {
    await TestUtils.waitForCondition(
      () => document.title.includes("vimma-page"),
      "window title follows the page",
    );
    if (AppConstants.platform === "macosx") {
      // Firefox's macOS window titles are the page's title alone; the menu bar names the app.
      Assert.equal(document.title, "vimma-page", "window title is the page's title on macOS");
    } else {
      Assert.ok(document.title.endsWith(BRAND), `window title "${document.title}" ends with Vimma`);
    }
    Assert.ok(!/Nightly|Firefox/.test(document.title), "window title has no Nightly/Firefox");
  });
});

add_task(async function about_logo_is_ours() {
  const res = await fetch("chrome://branding/content/about-logo.svg");
  const text = await res.text();
  Assert.ok(text.includes("vimma-mark"), "about-logo.svg is the Vimma mark");
});

add_task(async function default_bookmarks_import_succeeds() {
  const { PlacesBrowserStartup } = ChromeUtils.importESModule(
    "moz-src:///browser/components/places/PlacesBrowserStartup.sys.mjs",
  );
  /** @type {string[]} */
  const seen = [];
  const observer = (/** @type {unknown} */ _s, /** @type {string} */ topic) => seen.push(topic);
  const topics = ["bookmarks-restore-success", "bookmarks-restore-failed"];
  topics.forEach((t) => Services.obs.addObserver(observer, t));
  registerCleanupFunction(() => {
    topics.forEach((t) => Services.obs.removeObserver(observer, t));
    Services.prefs.clearUserPref("browser.bookmarks.restore_default_bookmarks");
  });

  // Same route as upstream's browser_bookmarks_checkDefaultBookmarks.js: a fresh profile's import.
  await PlacesUtils.bookmarks.eraseEverything();
  Services.prefs.setBoolPref("browser.bookmarks.restore_default_bookmarks", true);
  PlacesBrowserStartup._placesInitialized = false;
  const done = TestUtils.topicObserved("places-browser-init-complete");
  PlacesBrowserStartup.initPlaces();
  await done;

  Assert.deepEqual(seen, ["bookmarks-restore-success"], "default bookmarks imported without error");
  const menu = await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.menuGuid);
  Assert.ok(menu.children?.length, "bookmarks menu is not empty");
});

// Every pref the stock brands (engine/browser/branding/{unofficial,official,nightly,aurora}/pref/
// firefox-branding.js) define. Firefox reads them with getIntPref/getCharPref and no fallback, so a
// brand without one throws (tools/branding/test/branding-prefs.test.mjs compares against the
// unofficial brand file itself).
const STOCK_BRAND_PREFS = [
  "startup.homepage_override_url",
  "startup.homepage_welcome_url",
  "startup.homepage_welcome_url.additional",
  "app.update.interval",
  "app.update.promptWaitTime",
  "app.update.url.manual",
  "app.update.url.details",
  "app.update.checkInstallTime.days",
  "app.update.badgeWaitTime",
  "app.releaseNotesURL",
  "app.releaseNotesURL.aboutDialog",
  "app.releaseNotesURL.prompt",
  "devtools.selfxss.count",
];

add_task(async function stock_brand_prefs_have_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  for (const name of STOCK_BRAND_PREFS) {
    Assert.notEqual(
      defaults.getPrefType(name),
      Services.prefs.PREF_INVALID,
      `${name} has a default`,
    );
  }
  for (const name of ["app.update.checkInstallTime.days", "app.update.badgeWaitTime"]) {
    Assert.equal(typeof defaults.getIntPref(name), "number", `${name} is an int default`);
  }
});

add_task(async function old_build_update_check_does_not_throw() {
  // BrowserGlue._onFirstWindowLoaded calls this before the browser-first-window-ready category
  // (AboutNewTab.init, which maps resource://newtab/). A throw here skipped all of that, and
  // about:home logged NS_ERROR_NOT_AVAILABLE from AboutNewTabRedirector. The harness turns
  // app.update.checkInstallTime off (testing/profiles/common/user.js); Firefox's default is on.
  // Any update check it starts is a no-op under app.update.disabledForTesting.
  const glue = Cc["@mozilla.org/browser/browserglue;1"].getService().wrappedJSObject;
  await SpecialPowers.pushPrefEnv({ set: [["app.update.checkInstallTime", true]] });
  try {
    glue._checkForOldBuildUpdates();
    Assert.ok(true, "_checkForOldBuildUpdates ran without throwing");
  } catch (e) {
    Assert.ok(false, `_checkForOldBuildUpdates threw: ${e}`);
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function about_home_and_newtab_render() {
  /** @type {string[]} */
  const errors = [];
  const listener = {
    /** @param {nsIConsoleMessage} msg */
    observe(msg) {
      if (msg.message.includes("AboutNewTabRedirector")) {
        errors.push(msg.message);
      }
    },
  };
  Services.console.registerListener(listener);
  registerCleanupFunction(() => Services.console.unregisterListener(listener));

  // A preloaded about:newtab is swapped in without a load event, which withNewTab waits for.
  await SpecialPowers.pushPrefEnv({ set: [["browser.newtab.preload", false]] });
  NewTabPagePreloading.removePreloadedBrowser(window);
  for (const url of ["about:home", "about:newtab"]) {
    await BrowserTestUtils.withNewTab({ gBrowser, url }, async (browser) => {
      const rendered = await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector("body.activity-stream"),
          "activity-stream body",
        );
        return true;
      });
      Assert.ok(rendered, `${url} renders the new-tab page`);
    });
  }
  await SpecialPowers.popPrefEnv();
  Assert.deepEqual(errors, [], "no AboutNewTabRedirector errors");
});
