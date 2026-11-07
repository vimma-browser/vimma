/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Defaults for Mozilla services that a prefs file cannot set (spec:
// docs/specs/m0-mozilla-services.md). Everything else lives in the branding prefs file.

/**
 * Firefox Suggest rewrites this pref's default-branch value per home region on every startup
 * (QuickSuggest.sys.mjs, `intendedDefaultPrefs`), so a default in a prefs file loses. The pref is
 * sticky: a user value survives even when it equals the default, and Settings writes one when
 * the user ticks "Suggestions from sponsors".
 */
const SPONSORED_SUGGESTIONS = "browser.urlbar.suggest.quicksuggest.sponsored";

/**
 * Suggest's pref migrations run at browser-idle-startup, after our first window, and can clear
 * the user value (migration 5, for DE/FR/IT with an English locale). They end by writing this
 * pref, so a change to it means "re-apply".
 */
const SUGGEST_MIGRATION_VERSION = "browser.urlbar.quicksuggest.migrationVersion";

/**
 * The sidebar launcher's tools. Firefox writes them as a user value (SidebarManager.sys.mjs,
 * updateDefaultTools, at a profile's first window; ProfileDataUpgrader.sys.mjs, migration 153), so
 * a profile from before Vimma's default (firefox-branding.js) keeps `aichat`, and the chatbot's
 * page menu shows while `aichat` is a tool, even with the chatbot off (GenAI.sys.mjs,
 * canShowAskChat). docs/specs/firefox-surfaces-trim.md, decision 5.
 */
const SIDEBAR_TOOLS = "sidebar.main.tools";
const CHAT_ENABLED = "browser.ml.chat.enabled";
const CHAT_TOOL = "aichat";

/**
 * Without a Google key the build fetches no Safe Browsing lists (SafeBrowsing.sys.mjs,
 * `checkGoogleSafeBrowsingKey`). These are the "Block dangerous and deceptive content" switches;
 * keyless, Vimma defaults them to false so Settings shows the protection off (spec
 * docs/specs/m0-safebrowsing-key.md). The remote download check is off in every build (prefs).
 */
const KEY_GATED_SAFEBROWSING_PREFS = [
  "browser.safebrowsing.phishing.enabled",
  "browser.safebrowsing.malware.enabled",
];

/** configure's value when the build has no `--with-google-safebrowsing-api-keyfile`. */
const NO_SAFEBROWSING_KEY = "no-google-safebrowsing-api-key";

let started = false;

/** @returns {string} */
function buildSafeBrowsingKey() {
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs",
  );
  return AppConstants.MOZ_GOOGLE_SAFEBROWSING_API_KEY;
}

export const MozillaServices = {
  /** Apply now, and again after Suggest has initialised or migrated. Once per process. */
  init() {
    this.applySafeBrowsingDefaults();
    this.applyUserDefaults();
    if (started) {
      return;
    }
    started = true;
    Services.prefs.addObserver(SUGGEST_MIGRATION_VERSION, () => this.applyUserDefaults());
    const { QuickSuggest } = ChromeUtils.importESModule(
      "moz-src:///browser/components/urlbar/QuickSuggest.sys.mjs",
    );
    QuickSuggest.initPromise.then(() => this.applyUserDefaults());
  },

  /**
   * Keyless builds: Safe Browsing off on the default branch, so no user value is written and the
   * same profile in a keyed build gets Firefox's defaults back. Keyed builds: nothing changes.
   * Idempotent; the default branch is not saved, so this runs at every startup.
   * @param {string} [key] the build's key; AppConstants' when omitted
   */
  applySafeBrowsingDefaults(key = buildSafeBrowsingKey()) {
    if (key && key.trim() && key !== NO_SAFEBROWSING_KEY) {
      return;
    }
    const defaults = Services.prefs.getDefaultBranch("");
    for (const name of KEY_GATED_SAFEBROWSING_PREFS) {
      defaults.setBoolPref(name, false);
    }
  },

  /**
   * Turn sponsored address-bar suggestions off unless the user has chosen, and take the chatbot
   * out of the sidebar launcher while it is off, as Firefox's own migration 152 does for a
   * profile with the chatbot off. Idempotent.
   */
  applyUserDefaults() {
    if (!Services.prefs.prefHasUserValue(SPONSORED_SUGGESTIONS)) {
      Services.prefs.setBoolPref(SPONSORED_SUGGESTIONS, false);
    }
    if (
      !Services.prefs.getBoolPref(CHAT_ENABLED, false) &&
      Services.prefs.prefHasUserValue(SIDEBAR_TOOLS)
    ) {
      const tools = Services.prefs.getStringPref(SIDEBAR_TOOLS).split(",");
      if (tools.includes(CHAT_TOOL)) {
        Services.prefs.setStringPref(
          SIDEBAR_TOOLS,
          tools.filter((tool) => tool !== CHAT_TOOL).join(","),
        );
      }
    }
  },
};
