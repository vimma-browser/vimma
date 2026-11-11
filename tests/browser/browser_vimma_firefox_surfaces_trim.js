/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 1 and 2 (prefs), 4a (menus), 4b
// (Settings) and 4c (About dialog, link panel, account panel, typed Firefox pages).

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global gSync, PanelMultiView, PanelUI, gCustomizeMode, gNavToolbox -- browser window globals
   (browser-sync.js, browser.js, panelUI.js, browser-customization.js) */
/* global getHelpLinkURL -- a browser window global (utilityOverlay.js) */

const { SidebarManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sidebar/SidebarManager.sys.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
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
  ["browser.tabs.firefox-view.importHistory.dismissed", true],
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

add_task(async function history_sidebar_has_no_import_promo() {
  // Firefox shows it on profiles under 8 days old (HistoryController.shouldShowImportBanner);
  // the harness profile is new.
  await PlacesUtils.history.insert({ url: "https://example.com/", visits: [{ date: new Date() }] });
  await SidebarController.show("viewHistorySidebar");
  /** @type {any} */
  let history;
  await TestUtils.waitForCondition(() => {
    history = SidebarController.browser.contentDocument?.querySelector("sidebar-history");
    return history?.controller && !history.controller.isHistoryPending;
  }, "the History sidebar loads");
  history.controller.profileAge = 0;
  await history.updateComplete;
  Assert.ok(!history.controller.shouldShowImportBanner, "a new profile gets no import promo");
  Assert.ok(
    !history.shadowRoot.querySelector(".import-history-promo"),
    "the History sidebar shows no import promo",
  );
  SidebarController.hide();
  await PlacesUtils.history.clear();
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

/**
 * macOS draws the menu bar natively from the XUL items' attributes, which CSS does not reach
 * (decision 15), and its popups have no Gecko layout to measure.
 */
const NATIVE_MENUBAR = AppConstants.platform === "macosx";

add_task(async function tools_menu_has_no_firefox_view() {
  if (NATIVE_MENUBAR) {
    Assert.ok(true, "macOS's native menu bar is out of reach of Vimma's CSS");
    return;
  }
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
  if (NATIVE_MENUBAR) {
    Assert.ok(true, "macOS's native menu bar is out of reach of Vimma's CSS");
    return;
  }
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

// Step 4b: Settings hides what controls nothing in Vimma (decisions 2, 3 and 6), also under
// forced colours (decision 7), and looks like Vimma (decision 8).

/**
 * Open a Settings pane and wait for `selector` to be in it.
 * @param {string} pane the hash, such as "home"
 * @param {string} selector
 * @param {(doc: Document, el: HTMLElement) => Promise<void> | void} check
 */
async function inSettingsPane(pane, selector, check) {
  await BrowserTestUtils.withNewTab(`about:preferences#${pane}`, async (browser) => {
    const doc = browser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.querySelector(selector),
      `Settings' ${pane} pane builds ${selector}`,
    );
    await check(doc, /** @type {HTMLElement} */ (doc.querySelector(selector)));
  });
}

/** Each surface decision 6 hides: [pane, selector, what it is]. */
const HIDDEN_IN_SETTINGS = [
  ["home", 'setting-group[groupid="home"]', "the Firefox Home content group"],
  ["privacy", 'setting-group[groupid="dataCollection"]', "the data collection group"],
  ["general", "#setting-control-cfrRecommendations", "the extension recommendations switch"],
  ["general", "#setting-control-cfrRecommendations-features", "the feature recommendations switch"],
  ["general", "#setting-control-supportShareIdeas", "the connect.mozilla.org link"],
];

async function settingsHideWhatControlsNothing(label) {
  for (const [pane, selector, what] of HIDDEN_IN_SETTINGS) {
    await inSettingsPane(pane, selector, (doc, el) => {
      Assert.equal(
        doc.defaultView.getComputedStyle(el).display,
        "none",
        `Settings does not show ${what}${label}`,
      );
    });
  }
  await inSettingsPane("general", "#category-experimental", (doc, labs) => {
    // Firefox shows the Labs button once a Labs recipe is enrolled (firefoxLabs.mjs).
    labs.hidden = false;
    Assert.equal(
      doc.defaultView.getComputedStyle(labs).display,
      "none",
      `Settings' navigation has no Firefox Labs${label}`,
    );
  });
}

add_task(async function settings_hide_what_controls_nothing() {
  await settingsHideWhatControlsNothing("");
});

add_task(async function settings_hide_them_under_forced_colours() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  await settingsHideWhatControlsNothing(" under forced colours");
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_keep_sync_and_support() {
  await inSettingsPane("general", "#setting-control-supportGetHelp", (doc, help) => {
    const sync = /** @type {HTMLElement} */ (doc.getElementById("category-sync"));
    Assert.ok(BrowserTestUtils.isVisible(sync), "Settings' navigation keeps Sync");
    Assert.notEqual(
      doc.defaultView.getComputedStyle(help).display,
      "none",
      "Settings keeps the Vimma support link",
    );
  });
});

add_task(async function settings_show_firefox_home_without_the_start_page() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.startpage.newtab", false]] });
  await inSettingsPane("home", 'setting-group[groupid="home"]', (doc, group) => {
    Assert.notEqual(
      doc.defaultView.getComputedStyle(group).display,
      "none",
      "with Firefox Home as the new tab page, Settings shows its content group",
    );
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_look_like_vimma() {
  await inSettingsPane("general", "setting-group moz-card", (doc, card) => {
    const win = doc.defaultView;
    const radius = (/** @type {Element | null | undefined} */ el) =>
      el ? win.getComputedStyle(el).borderTopLeftRadius : "missing";
    const font = win.getComputedStyle(doc.documentElement).getPropertyValue("--vimma-font").trim();
    Assert.ok(font, `the theme's font token reaches Settings: ${font}`);
    const body = /** @type {HTMLElement} */ (doc.body);
    Assert.equal(win.getComputedStyle(body).fontFamily, font, "Settings' text is the theme's font");
    Assert.equal(radius(card), "0px", "a Settings card is square");
    const nav = doc.querySelector("moz-page-nav-button")?.shadowRoot?.querySelector("a, button");
    Assert.equal(radius(nav), "0px", "a navigation button is square");
    const search = doc.querySelector("moz-input-search")?.shadowRoot?.querySelector("input");
    Assert.equal(radius(search), "0px", "the search field is square");
  });
});

/**
 * A colour custom property as `el` sees it, in the rgb() form getComputedStyle reports.
 * @param {Element} el
 * @param {string} name
 */
function colourVar(el, name) {
  const win = /** @type {Window} */ (el.ownerDocument.defaultView);
  const probe = el.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  probe.style.color = win.getComputedStyle(el).getPropertyValue(name).trim();
  el.ownerDocument.documentElement.append(probe);
  const out = win.getComputedStyle(probe).color;
  probe.remove();
  return out;
}

add_task(async function about_dialog_keeps_the_licence_and_drops_mozilla_links() {
  const win = window.openDialog(
    "chrome://browser/content/aboutDialog.xhtml",
    "",
    "chrome,centerscreen,dependent",
  );
  await BrowserTestUtils.waitForEvent(win, "load");
  const doc = win.document;
  const shown = (/** @type {string} */ selector) => {
    const el = doc.querySelector(selector);
    Assert.ok(el, `the About dialog has ${selector}`);
    return !!el && win.getComputedStyle(el).display !== "none";
  };
  Assert.ok(!shown("#contributeDesc"), "no donate or get-involved paragraph");
  Assert.ok(
    !shown('.bottom-link[href^="https://www.mozilla.org/about/legal/"]'),
    "no Mozilla Terms of Use link",
  );
  Assert.ok(!shown('.bottom-link[href^="https://www.mozilla.org/privacy/"]'), "no Privacy link");
  Assert.ok(shown('.bottom-link[href="about:license"]'), "the licensing information link stays");
  Assert.ok(shown("#communityDesc"), "the community line stays for the attribution (step 5)");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function link_status_panel_follows_the_theme() {
  const label = /** @type {Element} */ (document.getElementById("statuspanel-label"));
  const style = getComputedStyle(label);
  Assert.equal(style.backgroundColor, colourVar(label, "--vimma-bg-dark"), "theme's surface");
  Assert.equal(style.color, colourVar(label, "--vimma-fg"), "theme's text");
  Assert.equal(style.borderTopColor, colourVar(label, "--vimma-muted"), "theme's border");
});

add_task(async function account_panel_sign_in_box_follows_the_theme() {
  // The box lives in the panel's template until the panel first opens (PanelMultiView).
  const fxaView = PanelMultiView.getViewNode(document, "PanelUI-fxa");
  const shownView = BrowserTestUtils.waitForEvent(fxaView, "ViewShown");
  /** @type {HTMLElement} */ (document.getElementById("fxa-toolbar-menu-button")).click();
  await shownView;
  const box = PanelMultiView.getViewNode(document, "PanelUI-fxa-menu-sign-in-promo");
  const style = getComputedStyle(box);
  Assert.equal(style.backgroundColor, colourVar(box, "--vimma-bg"), "theme's surface");
  Assert.equal(style.color, colourVar(box, "--vimma-fg"), "theme's text, not the promo's");
  const hidden = BrowserTestUtils.waitForEvent(document, "popuphidden", true);
  /** @type {any} */ (fxaView.closest("panel")).hidePopup();
  await hidden;
});

const START = "chrome://browser/content/vimma/start/start.html";

/**
 * Types `url` into the URL bar of a new tab and waits for the tab to load `expected`.
 * @param {string} url
 * @param {string} expected
 * @returns {Promise<{ spec: string, loads: number }>} the loaded URL, and how many top-level
 *   document loads the tab started on the way
 */
async function typeInNewTab(url, expected) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  let loads = 0;
  const counter = {
    /** @type {(b: any, progress: any, request: any, flags: number) => void} */
    onStateChange(b, progress, _request, flags) {
      const start = Ci.nsIWebProgressListener.STATE_START;
      const doc = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
      if (b === browser && progress?.isTopLevel && flags & start && flags & doc) loads++;
    },
  };
  gBrowser.addTabsProgressListener(counter);
  try {
    const loaded = BrowserTestUtils.browserLoaded(browser, false, expected);
    gURLBar.focus();
    gURLBar.select();
    EventUtils.sendString(url);
    EventUtils.synthesizeKey("KEY_Enter");
    await loaded;
  } finally {
    gBrowser.removeTabsProgressListener(counter);
  }
  const spec = browser.currentURI.spec;
  BrowserTestUtils.removeTab(tab);
  return { spec, loads };
}

// A load of Firefox's page that is replaced after it starts can lose to that load's own switch to
// another content process, and Firefox's page then stays (#863): the start page has to be the
// only load.
add_task(async function typed_firefox_pages_open_the_start_page() {
  for (const url of ["about:home", "about:newtab", "about:welcome"]) {
    const { spec, loads } = await typeInNewTab(url, START);
    Assert.equal(spec, START, `${url} opens the start page`);
    Assert.equal(loads, 1, `${url} starts no load of Firefox's page`);
  }
});

add_task(async function firefox_new_tab_stays_without_the_start_page() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.startpage.newtab", false]] });
  const { spec } = await typeInNewTab("about:newtab", "about:newtab");
  Assert.equal(spec, "about:newtab", "with the start page off, Firefox's new tab page loads");
  await SpecialPowers.popPrefEnv();
});

add_task(async function firefox_page_from_history_reloads_as_the_start_page() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.startpage.newtab", false]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  let loaded = BrowserTestUtils.browserLoaded(browser, false, "about:newtab");
  BrowserTestUtils.startLoadingURIString(browser, "about:newtab");
  await loaded;
  await SpecialPowers.popPrefEnv();
  loaded = BrowserTestUtils.browserLoaded(browser, false, START);
  browser.reload();
  await loaded;
  Assert.equal(browser.currentURI.spec, START, "the reloaded entry is the start page's URL");
  BrowserTestUtils.removeTab(tab);
});
