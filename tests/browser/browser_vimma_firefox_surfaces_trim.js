/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 2 (prefs) and 4a (menus).

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global gSync, PanelMultiView, PanelUI, gCustomizeMode, gNavToolbox -- browser window globals
   (browser-sync.js, browser.js, panelUI.js, browser-customization.js) */

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

// Step 4a: the menus' Mozilla entry points (decision 1 and the design table's menu row).

/** @param {string} id */
const shown = (id) => {
  const el = document.getElementById(id);
  return !!el && BrowserTestUtils.isVisible(el);
};

/**
 * Open a context menu and report, while it is open, which of `ids` show. `open` starts it.
 * @param {Element} menu
 * @param {() => Promise<void> | void} open
 * @param {string[]} ids
 * @returns {Promise<string[]>} the ids that show
 */
async function shownWhileOpen(menu, open, ids) {
  const popupShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await open();
  await popupShown;
  const visible = ids.filter(shown);
  const popupHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  /** @type {any} */ (menu).hidePopup();
  await popupHidden;
  return visible;
}

/** Sync's send-to-device items, which gSync shows whenever Mozilla accounts are on. */
add_task(async function context_menus_have_no_send_to_device() {
  Assert.ok(gSync.FXA_ENABLED, "Mozilla accounts are on, so Firefox would show the items");
  const html = `<p id="text">a page</p><a id="link" href="https://example.com/">a link</a>`;
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await SpecialPowers.spawn(browser, [html], (h) => {
      content.document.body.innerHTML = h;
    });
    const menu = document.getElementById("contentAreaContextMenu");
    const click = (/** @type {string} */ selector) => () =>
      BrowserTestUtils.synthesizeMouseAtCenter(
        selector,
        { type: "contextmenu", button: 2 },
        browser,
      );

    const onPage = await shownWhileOpen(menu, click("#text"), [
      "context-sendpagetodevice",
      "context-sep-sendpagetodevice",
    ]);
    Assert.deepEqual(onPage, [], "the page menu has no Send Page to Device");

    const onLink = await shownWhileOpen(menu, click("#link"), [
      "context-sendlinktodevice",
      "context-sep-sendlinktodevice",
    ]);
    Assert.deepEqual(onLink, [], "the link menu has no Send Link to Device");

    const tabMenu = document.getElementById("tabContextMenu");
    const onTab = await shownWhileOpen(
      tabMenu,
      () => /** @type {any} */ (tabMenu).openPopupAtScreen(100, 100, true),
      ["context_sendTabToDevice", "context_sendTabToDeviceSeparator"],
    );
    Assert.deepEqual(onTab, [], "the tab menu has no Send Tab to Device");
  });
});

add_task(async function tools_menu_has_no_firefox_view() {
  const popup = document.getElementById("menu_ToolsPopup");
  const visible = await shownWhileOpen(
    popup,
    () => /** @type {any} */ (popup).openPopupAtScreen(100, 100, false),
    ["menu_openFirefoxView", "menu_pageInfo"],
  );
  Assert.deepEqual(visible, ["menu_pageInfo"], "Tools keeps its items but Tab Overview");
});

const HIDDEN_HELP = ["helpSwitchDevice", "help_reportBrokenSite"];
const KEPT_HELP = ["menu_openHelp", "feedbackPage", "troubleShooting", "aboutName"];

add_task(async function menubar_help_has_no_mozilla_items() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const popup = document.getElementById("menu_HelpPopup");
    const visible = await shownWhileOpen(
      popup,
      () => /** @type {any} */ (popup).openPopupAtScreen(100, 100, false),
      [...HIDDEN_HELP, ...KEPT_HELP],
    );
    Assert.deepEqual(visible, KEPT_HELP, "Help keeps Get Help and Share Ideas, not the rest");
  });
});

add_task(async function app_menu_help_has_no_mozilla_items() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const appMenu = document.getElementById("appMenu-popup");
    const panelShown = BrowserTestUtils.waitForPopupEvent(appMenu, "shown");
    PanelUI.show();
    await panelShown;
    const helpView = PanelMultiView.getViewNode(document, "PanelUI-helpView");
    const viewShown = BrowserTestUtils.waitForEvent(helpView, "ViewShown");
    PanelMultiView.getViewNode(document, "appMenu-help-button2").click();
    await viewShown;
    const visible = [...HIDDEN_HELP, ...KEPT_HELP, "-nova-switch-device-promo"]
      .map((id) => (id.startsWith("-") ? `appMenu${id}` : `appMenu_${id}`))
      .filter(shown);
    Assert.deepEqual(
      visible,
      KEPT_HELP.map((id) => `appMenu_${id}`),
      "the app menu's Help view keeps Get Help and Share Ideas, not the rest",
    );
    const panelHidden = BrowserTestUtils.waitForPopupEvent(appMenu, "hidden");
    PanelUI.hide();
    await panelHidden;
  });
});

add_task(async function customize_palette_has_no_send_tab_or_firefox_view() {
  const ready = BrowserTestUtils.waitForEvent(gNavToolbox, "customizationready");
  gCustomizeMode.enter();
  await ready;
  for (const id of ["send-tab-button", "firefox-view-button"]) {
    const wrapper = document.getElementById(`wrapper-${id}`);
    Assert.ok(wrapper, `${id} is a widget Firefox offers in customize mode`);
    Assert.ok(!BrowserTestUtils.isVisible(wrapper), `customize mode does not show ${id}`);
  }
  Assert.ok(
    BrowserTestUtils.isVisible(document.getElementById("wrapper-fxa-toolbar-menu-button")),
    "the account button stays: Sync stays (decision 1)",
  );
  const done = BrowserTestUtils.waitForEvent(gNavToolbox, "aftercustomization");
  gCustomizeMode.exit();
  await done;
});

add_task(async function sync_sign_in_stays_in_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#sync", async (browser) => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.getElementById("noFxaSignIn"),
      "Settings > Sync renders its sign-in button",
    );
    const button = /** @type {HTMLElement} */ (doc.getElementById("noFxaSignIn"));
    Assert.ok(BrowserTestUtils.isVisible(button), "Settings > Sync offers sign-in");
    Assert.ok(!button.hasAttribute("disabled"), "and it can be pressed");
  });
});
