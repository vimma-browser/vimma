/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 1 and 2 (prefs), 4a (menus) and 4c
// (About dialog, link panel, account panel, typed Firefox pages). The tests that open Settings
// are in browser_vimma_firefox_settings_trim.js (#992).

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global gSync, PanelMultiView, PanelUI, gCustomizeMode, gNavToolbox -- browser window globals
   (browser-sync.js, browser.js, panelUI.js, browser-customization.js) */
/* global getHelpLinkURL -- a browser window global (utilityOverlay.js) */
/* global useShippedSupportBase -- from head.js */

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
  // the harness profile is new. Pin its other conditions so that the dismissed pref is what hides it.
  await SpecialPowers.pushPrefEnv({ set: [["browser.migrate.interactions.history", false]] });
  registerCleanupFunction(async () => {
    SidebarController.hide();
    await PlacesUtils.history.clear();
  });
  Assert.ok(Services.policies.isAllowed("profileImport"), "importing is allowed");
  await PlacesUtils.history.insert({ url: "https://example.com/", visits: [{ date: new Date() }] });
  await SidebarController.show("viewHistorySidebar");
  /**
   * The History sidebar's <sidebar-history>, a Lit element
   * (engine/browser/components/sidebar/sidebar-history.mjs), with the members of its
   * HistoryController that the test uses
   * (engine/browser/components/firefoxview/HistoryController.sys.mjs).
   * @typedef {HTMLElement & {
   *   controller: { profileAge: number, readonly shouldShowImportBanner: boolean, readonly isHistoryPending: boolean },
   *   updateComplete: Promise<unknown>,
   * }} SidebarHistory
   */
  // The wait resolves with the loaded element.
  const history = /** @type {SidebarHistory} */ (
    await TestUtils.waitForCondition(() => {
      /** @type {SidebarHistory | null | undefined} */
      const h = SidebarController.browser.contentDocument?.querySelector("sidebar-history");
      return h?.controller && !h.controller.isHistoryPending && h;
    }, "the History sidebar loads")
  );
  history.controller.profileAge = 0;
  await history.updateComplete;
  Assert.ok(!history.controller.shouldShowImportBanner, "a new profile gets no import promo");
  Assert.ok(
    // A Lit element renders into its shadow root; without one this read throws, as before.
    !(/** @type {ShadowRoot} */ (history.shadowRoot).querySelector(".import-history-promo")),
    "the History sidebar shows no import promo",
  );
  SidebarController.hide();
  await PlacesUtils.history.clear();
  await SpecialPowers.popPrefEnv();
});

/**
 * A <menupopup> or <panel> of browser.xhtml. A missing one throws where the test first uses it
 * (BrowserTestUtils.waitForPopupEvent adds a listener to it), as it did before.
 * @param {string} id
 */
const popupById = (id) =>
  /** @type {XULPopupElement} */ (/** @type {Element} */ (document.getElementById(id)));

/**
 * A XUL element of browser.xhtml the test reads; a missing one throws on that read, as before.
 * @param {string} id
 */
const xulById = (id) =>
  /** @type {XULElement} */ (/** @type {Element} */ (document.getElementById(id)));

/**
 * Open the content context menu on the page's link and report which items show.
 * @returns {Promise<{askChat: boolean, previewLink: boolean}>}
 */
async function linkContextMenuItems() {
  const menu = popupById("contentAreaContextMenu");
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
        askChat: !xulById("context-ask-chat").hidden,
        previewLink: !xulById("context-previewlink").hidden,
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

// Step 4a: the menus' Mozilla entry points (decision 1 and the design table's menu row).

/** @param {string} id */
const shown = (id) => {
  const el = document.getElementById(id);
  return !!el && BrowserTestUtils.isVisible(el);
};

/**
 * Open a context menu and report, while it is open, which of `ids` show. `open` starts it.
 * @param {XULPopupElement} menu
 * @param {() => unknown} open
 * @param {string[]} ids
 * @returns {Promise<string[]>} the ids that show
 */
async function shownWhileOpen(menu, open, ids) {
  const popupShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await open();
  await popupShown;
  // An item Firefox no longer has does not show either: each is in the open menu first.
  for (const id of ids) {
    Assert.ok(menu.contains(document.getElementById(id)), `${id} is an item of the open menu`);
  }
  const visible = ids.filter(shown);
  const popupHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
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
    const menu = popupById("contentAreaContextMenu");
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

    const tabMenu = popupById("tabContextMenu");
    const onTab = await shownWhileOpen(tabMenu, () => tabMenu.openPopupAtScreen(100, 100, true), [
      "context_sendTabToDevice",
      "context_sendTabToDeviceSeparator",
    ]);
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
  const popup = popupById("menu_ToolsPopup");
  const visible = await shownWhileOpen(popup, () => popup.openPopupAtScreen(100, 100, false), [
    "menu_openFirefoxView",
    "menu_pageInfo",
  ]);
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
    const popup = popupById("menu_HelpPopup");
    const visible = await shownWhileOpen(popup, () => popup.openPopupAtScreen(100, 100, false), [
      ...HIDDEN_HELP,
      ...KEPT_HELP,
    ]);
    Assert.deepEqual(visible, KEPT_HELP, "Help keeps Get Help and Share Ideas, not the rest");
  });
});

// The app menu's Help view has one Switch Device item or the other (panelUI.js,
// _onHelpViewShow): with browser.nova.enabled, on by default, Firefox replaces the copy of the
// menu bar's Switch Device item with a promo; without it the copy stays. The pref is read each
// time the view opens and a user can turn it off, so both are hidden, and each is made here
// so that the rule hiding it is what keeps it out of sight.
for (const [name, nova, item] of /** @type {[string, boolean, string][]} */ ([
  ["app_menu_help_has_no_mozilla_items_with_nova", true, "appMenu-nova-switch-device-promo"],
  ["app_menu_help_has_no_mozilla_items_without_nova", false, "appMenu_helpSwitchDevice"],
])) {
  // A named function per run, so that the log tells the two apart.
  const task = {
    async [name]() {
      await SpecialPowers.pushPrefEnv({ set: [["browser.nova.enabled", nova]] });
      try {
        await BrowserTestUtils.withNewTab("https://example.com/", async () => {
          const appMenu = popupById("appMenu-popup");
          const panelShown = BrowserTestUtils.waitForPopupEvent(appMenu, "shown");
          PanelUI.show();
          await panelShown;
          const helpView = PanelMultiView.getViewNode(document, "PanelUI-helpView");
          const viewShown = BrowserTestUtils.waitForEvent(helpView, "ViewShown");
          PanelMultiView.getViewNode(document, "appMenu-help-button2").click();
          await viewShown;
          const ids = [...HIDDEN_HELP, ...KEPT_HELP, "-nova-switch-device-promo"].map((id) =>
            id.startsWith("-") ? `appMenu${id}` : `appMenu_${id}`,
          );
          Assert.ok(
            helpView.querySelector(`#${item}`),
            `${item} is in the Help view with browser.nova.enabled ${nova}`,
          );
          // The view copies only the Help menu's items that are not `hidden`, so another id here
          // may have no element: menubar_help_has_no_mozilla_items checks that Firefox still has
          // each item.
          const visible = ids.filter(shown);
          Assert.deepEqual(
            visible,
            KEPT_HELP.map((id) => `appMenu_${id}`),
            `the app menu's Help view keeps Get Help and Share Ideas, not the rest (nova ${nova})`,
          );
          const panelHidden = BrowserTestUtils.waitForPopupEvent(appMenu, "hidden");
          PanelUI.hide();
          await panelHidden;
        });
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    },
  }[name];
  add_task(task);
}

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

/**
 * A colour custom property as `el` sees it, in the rgb() form getComputedStyle reports.
 * @param {Element} el
 * @param {string} name
 */
function colourVar(el, name) {
  const win = /** @type {Window} */ (el.ownerDocument.defaultView);
  const probe = el.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  const value = win.getComputedStyle(el).getPropertyValue(name).trim();
  // Without the property the probe inherits its colour, which `el` may have inherited too.
  Assert.ok(value, `${name} is set`);
  probe.style.color = value;
  el.ownerDocument.documentElement.append(probe);
  const out = win.getComputedStyle(probe).color;
  probe.remove();
  return out;
}

add_task(async function about_dialog_keeps_the_licence_and_drops_mozilla_links() {
  // A window that did not open throws on the next line, as before.
  const win = /** @type {Window} */ (
    window.openDialog(
      "chrome://browser/content/aboutDialog.xhtml",
      "",
      "chrome,centerscreen,dependent",
    )
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
  xulById("fxa-toolbar-menu-button").click();
  await shownView;
  const box = PanelMultiView.getViewNode(document, "PanelUI-fxa-menu-sign-in-promo");
  const style = getComputedStyle(box);
  Assert.equal(style.backgroundColor, colourVar(box, "--vimma-bg"), "theme's surface");
  Assert.equal(style.color, colourVar(box, "--vimma-fg"), "theme's text, not the promo's");
  const hidden = BrowserTestUtils.waitForEvent(document, "popuphidden", true);
  /** @type {XULPopupElement} */ (fxaView.closest("panel")).hidePopup();
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
    /** @type {(b: MozBrowser, progress: nsIWebProgress | null, request: unknown, flags: number) => void} */
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
