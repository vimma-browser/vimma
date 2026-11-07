/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 1 and 2 (prefs).

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global gSync, PanelMultiView -- browser window globals (browser-sync.js, browser.js) */
/* global getHelpLinkURL -- a browser window global (utilityOverlay.js) */

const { SidebarManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sidebar/SidebarManager.sys.mjs",
);
const { FirefoxRelayUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FirefoxRelayUtils.sys.mjs",
);

const defaults = Services.prefs.getDefaultBranch("");
const AS = "browser.newtabpage.activity-stream.";
const RELEASES = "https://github.com/vimma-browser/vimma/releases/latest";

/** Firefox's launcher tools (SidebarManager.sys.mjs, DEFAULT_LAUNCHER_TOOLS) without `aichat`. */
const LAUNCHER_TOOLS = "opentabs,bookmarks,history,syncedtabs,passwords";

/** @type {Array<[string, boolean | string]>} the design table's step 2 rows, as shipped */
const STEP2_PREFS = [
  ["app.feedback.baseURL", "https://github.com/vimma-browser/vimma/discussions"],
  ["identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled", false],
  ["identity.fxaccounts.toolbar.appMenuSignInPromo.dismissed", true],
  ["browser.ml.chat.enabled", false],
  ["browser.ml.linkPreview.enabled", false],
  ["browser.preferences.aiControls", false],
  ["sidebar.main.tools", LAUNCHER_TOOLS],
  ["signon.firefoxRelay.feature", "disabled"],
  ["browser.shell.checkDefaultBrowser", false],
  ["extensions.getAddons.showPane", false],
  ["extensions.htmlaboutaddons.recommendations.enabled", false],
  ["toolkit.datacollection.infoURL", ""],
  ["datareporting.policy.firstRunURL", ""],
  ["browser.uitour.url", ""],
  ["breakpad.reportURL", ""],
  ["browser.backup.template.fallback-download.release", RELEASES],
  ["browser.backup.template.fallback-download.beta", RELEASES],
  ["browser.backup.template.fallback-download.aurora", RELEASES],
  ["browser.backup.template.fallback-download.nightly", RELEASES],
  ["browser.backup.template.fallback-download.esr", RELEASES],
];

/**
 * @param {string} name
 * @returns {boolean | string | undefined}
 */
function defaultValue(name) {
  if (!Services.prefs.prefHasDefaultValue(name)) {
    return undefined;
  }
  return Services.prefs.getPrefType(name) === Services.prefs.PREF_BOOL
    ? defaults.getBoolPref(name)
    : defaults.getStringPref(name);
}

/**
 * The harness profile sets user values on some of these (testing/profiles/*\/user.js sets
 * browser.shell.checkDefaultBrowser false), which would hide what Vimma ships. Clear them for the
 * test and put them back after.
 */
function useShippedDefaults() {
  /** @type {Array<[string, boolean | string]>} */
  const saved = [];
  for (const [name] of STEP2_PREFS) {
    if (Services.prefs.prefHasUserValue(name)) {
      const user =
        Services.prefs.getPrefType(name) === Services.prefs.PREF_BOOL
          ? Services.prefs.getBoolPref(name)
          : Services.prefs.getStringPref(name);
      saved.push([name, user]);
      Services.prefs.clearUserPref(name);
    }
  }
  registerCleanupFunction(() => {
    for (const [name, value] of saved) {
      if (typeof value === "boolean") {
        Services.prefs.setBoolPref(name, value);
      } else {
        Services.prefs.setStringPref(name, value);
      }
    }
  });
}

add_setup(useShippedDefaults);

add_task(async function step2_prefs_ship_vimma_defaults() {
  for (const [name, value] of STEP2_PREFS) {
    Assert.strictEqual(defaultValue(name), value, `${name} defaults to ${JSON.stringify(value)}`);
    Assert.ok(!Services.prefs.prefIsLocked(name), `${name} is a default, not locked`);
  }
  const onboarding = JSON.parse(defaults.getStringPref(`${AS}asrouter.providers.onboarding`));
  Assert.deepEqual(
    onboarding,
    {
      id: "onboarding",
      type: "local",
      localProvider: "OnboardingMessageProvider",
      enabled: false,
      exclude: [],
    },
    "the onboarding provider is upstream's with enabled: false",
  );
});

add_task(async function no_default_browser_prompt() {
  // The gate ShellService.shouldCheckDefaultBrowser reads; its getter also returns false once a
  // window has checked, so it cannot tell the two apart in a running browser.
  Assert.ok(
    !Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser"),
    "startup does not ask to be the default browser",
  );
});

add_task(async function no_relay_mask_offer() {
  Assert.ok(
    !FirefoxRelayUtils.relayIsAvailableOrEnabled(),
    "login forms do not offer Relay email masks",
  );
});

add_task(async function account_panel_has_no_monitor_promo() {
  gSync.updateCTAPanel();
  const monitor = PanelMultiView.getViewNode(document, "PanelUI-fxa-menu-monitor-button");
  Assert.ok(monitor.hidden, "the account panel does not promote Mozilla Monitor");
});

/**
 * Open the content context menu on the page's link and report which items show.
 * @returns {Promise<{askChat: boolean, previewLink: boolean}>}
 */
async function linkContextMenuItems() {
  const menu = document.getElementById("contentAreaContextMenu");
  const html = `<a id="link" href="https://example.com/">a link</a>`;
  return BrowserTestUtils.withNewTab(
    `data:text/html,${encodeURIComponent(html)}`,
    async (browser) => {
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#link",
        { type: "contextmenu", button: 2 },
        browser,
      );
      await shown;
      const items = {
        askChat: !document.getElementById("context-ask-chat").hidden,
        previewLink: !document.getElementById("context-previewlink").hidden,
      };
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.hidePopup();
      await hidden;
      return items;
    },
  );
}

add_task(async function context_menu_has_no_chatbot_or_link_preview() {
  // A new profile's first window fills an empty sidebar.main.tools with Firefox's launcher tools,
  // aichat among them, and the chatbot's page menu shows while aichat is a tool.
  if (!Services.prefs.prefHasUserValue("sidebar.new-sidebar.has-used")) {
    SidebarManager.updateDefaultTools();
    registerCleanupFunction(() => Services.prefs.clearUserPref("sidebar.main.tools"));
  }
  const items = await linkContextMenuItems();
  Assert.ok(!items.askChat, "no Ask an AI Chatbot item");
  Assert.ok(!items.previewLink, "no Preview Link item");
});

add_task(async function chatbot_item_comes_back_with_firefox_values() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.ml.chat.enabled", true],
      ["sidebar.main.tools", "opentabs,bookmarks,aichat,history,syncedtabs,passwords"],
    ],
  });
  const items = await linkContextMenuItems();
  Assert.ok(items.askChat, "Firefox's values bring Ask an AI Chatbot back");
  await SpecialPowers.popPrefEnv();
});

/**
 * A profile that ran before these defaults has Firefox's launcher tools as a user value: the
 * sidebar wrote them at its first window (SidebarManager.updateDefaultTools), and profile
 * migration 153 writes "aichat,syncedtabs,history" (ProfileDataUpgrader.sys.mjs).
 */
const FIREFOX_TOOLS = "opentabs,bookmarks,aichat,history,syncedtabs,passwords";

add_task(async function existing_profile_loses_the_chatbot_tool() {
  const { MozillaServices } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/services/MozillaServices.sys.mjs",
  );
  await SpecialPowers.pushPrefEnv({ set: [["sidebar.main.tools", FIREFOX_TOOLS]] });
  MozillaServices.applyUserDefaults();
  Assert.equal(
    Services.prefs.getStringPref("sidebar.main.tools"),
    "opentabs,bookmarks,history,syncedtabs,passwords",
    "the chatbot leaves the launcher's tools, the user's other tools stay",
  );
  const items = await linkContextMenuItems();
  Assert.ok(!items.askChat, "no Ask an AI Chatbot item in a profile from before");
  await SpecialPowers.popPrefEnv();
});

add_task(async function chatbot_tool_stays_when_the_user_turned_the_chatbot_on() {
  const { MozillaServices } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/services/MozillaServices.sys.mjs",
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.ml.chat.enabled", true],
      ["sidebar.main.tools", FIREFOX_TOOLS],
    ],
  });
  MozillaServices.applyUserDefaults();
  Assert.equal(Services.prefs.getStringPref("sidebar.main.tools"), FIREFOX_TOOLS, "kept");
  await SpecialPowers.popPrefEnv();
});

/**
 * The support base as Vimma ships it, formatted: the harness profile points app.support.baseURL
 * at a dummy server (testing/profiles/unittest-required/user.js), so its user value is cleared.
 */
async function useShippedSupportBase() {
  await SpecialPowers.pushPrefEnv({ clear: [["app.support.baseURL"]] });
  const { version, OS } = Services.appinfo;
  return `https://vimma.dev/support/${version}/${OS}/${Services.locale.appLocaleAsBCP47}/`;
}

add_task(async function support_links_open_vimma_dev() {
  const base = await useShippedSupportBase();
  Assert.equal(
    Services.urlFormatter.formatURLPref("app.support.baseURL"),
    base,
    "the support base is vimma.dev's support path with the version, OS and locale",
  );
  Assert.equal(getHelpLinkURL("x"), `${base}x`, "a help topic is appended to vimma.dev's base");
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_learn_more_links_open_vimma_dev() {
  const base = await useShippedSupportBase();
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async (browser) => {
    const links = await SpecialPowers.spawn(browser, [], async () => {
      // Settings builds some groups after load, so wait for its Learn more links to have an href.
      const selector = 'a[is="moz-support-link"][support-page], moz-support-link[support-page]';
      await ContentTaskUtils.waitForCondition(
        () => [...content.document.querySelectorAll(selector)].some((a) => a.href),
        "Settings' Learn more links",
      );
      return [...content.document.querySelectorAll(selector)]
        .filter((a) => a.href)
        .map((a) => ({ page: a.getAttribute("support-page"), href: a.href }));
    });
    Assert.ok(links.length, `Settings has Learn more links (${links.length})`);
    for (const { page, href } of links) {
      Assert.ok(
        href.startsWith(`${base}${page}`),
        `Settings' Learn more link for ${page} opens vimma.dev: ${href}`,
      );
    }
  });
  await SpecialPowers.popPrefEnv();
});
