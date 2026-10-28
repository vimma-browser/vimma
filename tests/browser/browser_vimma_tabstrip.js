/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-tabstrip-hidden.md

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const PREF = "vimma.ui.tabstrip.hidden";
const ROOT_ATTR = "vimma-tabstrip-hidden";

const $ = (/** @type {string} */ id) => document.getElementById(id);

/** Non-zero size, like Firefox's isElementVisible (what gTabsPanel.canOpen uses). */
function hasSize(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function stripShown() {
  return hasSize($("TabsToolbar"));
}

async function setPref(value) {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, value]] });
}

async function openTabs(n) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"));
  }
  return tabs;
}

function closeAllButFirst() {
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
}

registerCleanupFunction(() => {
  closeAllButFirst();
  // ctrlTab records its first use; not ours to keep.
  Services.prefs.clearUserPref("browser.engagement.ctrlTab.has-used");
});

add_task(async function strip_is_hidden_by_default_and_nav_bar_stays() {
  Assert.strictEqual(
    Services.prefs.getDefaultBranch("").getBoolPref(PREF, false),
    true,
    `${PREF} defaults to true`,
  );
  Assert.ok(document.documentElement.hasAttribute(ROOT_ATTR), `root has ${ROOT_ATTR}`);
  Assert.ok(!stripShown(), "#TabsToolbar has no size");
  Assert.ok(!hasSize($("tabbrowser-tabs")), "#tabbrowser-tabs has no size");
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), "Firefox knows the strip is hidden");
  Assert.ok(hasSize($("nav-bar")), "#nav-bar is visible");
  Assert.ok(hasSize($("urlbar")), "the URL bar is visible");

  await SimpleTest.promiseFocus(window);
  gBrowser.selectedBrowser.focus();
  // ctrl+l is Vimma's focus_urlbar on every platform. cmd+l is too on macOS, but it goes to the
  // page first, and pressed this soon after startup it missed in about 1 of 10 macOS runs.
  EventUtils.synthesizeKey("l", { ctrlKey: true });
  await TestUtils.waitForCondition(() => gURLBar.focused, "ctrl+l focuses the URL bar");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function pref_toggles_the_strip_live() {
  await setPref(false);
  await TestUtils.waitForCondition(stripShown, "strip shows when the pref is false");
  Assert.ok(!document.documentElement.hasAttribute(ROOT_ATTR), `root loses ${ROOT_ATTR}`);
  Assert.ok(hasSize($("tabbrowser-tabs")), "the tabs are visible");
  Assert.ok(!window.gNavToolbox.hasAttribute("tabs-hidden"), "toolbox back to Firefox's state");

  await setPref(true);
  await TestUtils.waitForCondition(() => !stripShown(), "strip hides when the pref is true");
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), "tabs-hidden is set again");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

/**
 * Runs `fn` as if the browser draws the titlebar (GNOME/KDE with CSD). Headless and tiling WMs
 * have none, so set what CustomTitlebar sets; Firefox's own code paths then do the rest.
 * @param {() => Promise<void>} fn
 */
async function withCustomTitlebar(fn) {
  const root = document.documentElement;
  const simulated = !root.hasAttribute("customtitlebar");
  if (simulated) {
    info("no browser-drawn titlebar here: simulating customtitlebar");
    root.setAttribute("customtitlebar", "true");
  }
  try {
    await fn();
  } finally {
    if (simulated) root.removeAttribute("customtitlebar");
    window.TabBarVisibility.update(true);
  }
}

/** Forget what the last TabBarVisibility.update() decided, so the next one has to redo it. */
function clearToolboxState() {
  window.gNavToolbox.removeAttribute("tabs-hidden");
  $("nav-bar").classList.remove("browser-titlebar");
}

function assertToolboxHidden(label) {
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), `${label}: toolbox has tabs-hidden`);
  Assert.ok($("nav-bar").classList.contains("browser-titlebar"), `${label}: nav bar is titlebar`);
}

// ctrl+w is no longer Firefox's close tab (docs/specs/key-handling-batch.md): Vimma's
// ctrl+b shift+x closes it, which must re-run TabBarVisibility the same way.
add_task(async function ctrl_t_and_closing_the_tab_still_work() {
  await withCustomTitlebar(async () => {
    gBrowser.selectedBrowser.focus();
    const before = gBrowser.tabs.length;
    clearToolboxState();
    const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
    // ctrl+t is Vimma's new_tab on every platform; cmd+t, accel on a Mac, is off there (#385).
    EventUtils.synthesizeKey("t", { ctrlKey: true });
    const { target: tab } = await opened;
    await TestUtils.waitForCondition(() => gBrowser.selectedTab === tab, "new tab is selected");
    Assert.equal(gBrowser.tabs.length, before + 1, "ctrl+t opened a tab");
    Assert.ok(!stripShown(), "the strip stays hidden with two tabs");
    assertToolboxHidden("after ctrl+t");

    clearToolboxState();
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("X", { shiftKey: true });
    await TestUtils.waitForCondition(
      () => gBrowser.tabs.length === before,
      "ctrl+b shift+x closed it",
    );
    Assert.ok(!tab.isConnected, "the new tab is gone");
    await TestUtils.waitForCondition(
      () => window.gNavToolbox.hasAttribute("tabs-hidden"),
      "tab close re-runs TabBarVisibility",
    );
    assertToolboxHidden("after ctrl+b shift+x");
  });
});

add_task(async function ctrl_tab_pagedown_and_digits_switch_tabs() {
  closeAllButFirst();
  const [, second, third] = [gBrowser.tabs[0], ...(await openTabs(2))];
  const first = gBrowser.tabs[0];
  await BrowserTestUtils.switchTab(gBrowser, first);
  gBrowser.selectedBrowser.focus();

  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === second, "ctrl+tab: next tab");

  EventUtils.synthesizeKey("KEY_PageDown", { ctrlKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === third, "ctrl+pagedown: next");

  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === second, "ctrl+shift+tab: prev");

  // Firefox's tab 2 key: alt+2 on Linux (XP_GNOME in browser-sets.inc.xhtml), cmd+2 on macOS,
  // where Vimma binds select_tab_2 to it (defaults.mjs MAC_KEYS) since Option+2 types a character.
  const modifier = $("key_selectTab2").getAttribute("modifiers");
  Assert.equal(modifier, AppConstants.platform == "macosx" ? "accel" : "alt", "key_selectTab2");
  await BrowserTestUtils.switchTab(gBrowser, first);
  EventUtils.synthesizeKey("2", modifier === "alt" ? { altKey: true } : { accelKey: true });
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === second, `${modifier}+2: 2nd tab`);
  closeAllButFirst();
});

add_task(async function list_all_tabs_waits_for_m2_while_hidden() {
  // Intended: Firefox's panel needs #alltabs-button, which is in the hidden strip. Firefox then
  // hides View > List All Tabs and the ctrl+tab "show all" button itself; M2's picker replaces it.
  await openTabs(2);
  Assert.ok(!window.gTabsPanel.canOpen, "List All Tabs is unavailable while the strip is hidden");

  await setPref(false);
  await TestUtils.waitForCondition(stripShown, "strip shows when the pref is false");
  Assert.ok(window.gTabsPanel.canOpen, "List All Tabs is back with the strip");
  window.gTabsPanel.initElements();
  const view = $("allTabsMenu-allTabsView");
  const shown = BrowserTestUtils.waitForEvent(view, "ViewShown");
  $("Browser:ShowAllTabs").doCommand();
  await shown;
  const rows = $("allTabsMenu-allTabsView-tabs").querySelectorAll(
    ".all-tabs-item:not(.all-tabs-group-item)",
  );
  Assert.equal(rows.length, gBrowser.tabs.length, "the panel lists every tab");
  const hidden = BrowserTestUtils.waitForEvent(view.closest("panel"), "popuphidden");
  window.gTabsPanel.hideAllTabsPanel();
  await hidden;
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => !stripShown(), "strip hidden again");
  closeAllButFirst();
});

add_task(async function popup_with_two_tabs_shows_its_strip() {
  // Firefox shows a popup's strip once it has a second tab, "to prevent tabs being lost".
  await SpecialPowers.pushPrefEnv({ set: [["dom.disable_open_during_load", false]] });
  const popupOpened = BrowserTestUtils.waitForNewWindow({ url: "about:blank" });
  const opener = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<script>open('about:blank','','width=300,height=200')</script>",
  );
  const popup = await popupOpened;
  const strip = popup.document.getElementById("TabsToolbar");
  Assert.ok(popup.document.documentElement.hasAttribute("popup-window"), "it is a popup");
  Assert.ok(!hasSize(strip), "a one-tab popup has no strip (Firefox)");

  await BrowserTestUtils.openNewForegroundTab(popup.gBrowser, "about:blank");
  await TestUtils.waitForCondition(() => hasSize(strip), "a two-tab popup shows its strip");
  Assert.ok(!popup.gNavToolbox.hasAttribute("tabs-hidden"), "popup toolbox as Firefox has it");

  await BrowserTestUtils.closeWindow(popup);
  BrowserTestUtils.removeTab(opener);
  await SpecialPowers.popPrefEnv();
});

add_task(async function window_controls_move_to_the_nav_bar() {
  await withCustomTitlebar(async () => {
    window.TabBarVisibility.update(true);
    const navControls = $("nav-bar").querySelector(".titlebar-buttonbox-container");
    const tabsControls = $("TabsToolbar").querySelector(".titlebar-buttonbox-container");
    Assert.notEqual(getComputedStyle(navControls).display, "none", "nav bar shows the controls");
    Assert.ok(hasSize(navControls), "the nav bar's window controls have a size");
    Assert.ok(!hasSize(tabsControls), "no window controls left in the hidden strip");
    Assert.ok($("nav-bar").classList.contains("browser-titlebar"), "nav bar is a drag region");
  });
});

add_task(async function fullscreen_keeps_the_strip_hidden() {
  const entered = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = true;
  await entered;
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("inFullscreen"),
    "window is fullscreen",
  );
  Assert.ok(!stripShown(), "strip stays hidden in fullscreen");
  Assert.ok(window.gNavToolbox.contains($("nav-bar")), "nav bar still in the toolbox");
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), "tabs-hidden in fullscreen");

  const left = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = false;
  await left;
  await TestUtils.waitForCondition(
    () => !document.documentElement.hasAttribute("inFullscreen"),
    "window left fullscreen",
  );
  Assert.ok(!stripShown(), "strip still hidden after fullscreen");
});

add_task(async function customize_mode_shows_the_strip() {
  const ready = BrowserTestUtils.waitForEvent(window.gNavToolbox, "customizationready");
  window.gCustomizeMode.enter();
  await ready;
  Assert.ok(stripShown(), "strip is visible while customizing");

  const done = BrowserTestUtils.waitForEvent(window.gNavToolbox, "aftercustomization");
  window.gCustomizeMode.exit();
  await done;
  await TestUtils.waitForCondition(() => !stripShown(), "strip hidden after customize mode");
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), "tabs-hidden after customize mode");
});

add_task(async function vertical_tabs_are_hidden_too() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.revamp", true],
      ["sidebar.verticalTabs", true],
    ],
  });
  await TestUtils.waitForCondition(
    () => gBrowser.tabContainer.verticalMode,
    "tabs moved to the vertical strip",
  );
  Assert.ok(!hasSize($("vertical-tabs")), "vertical tab list has no size");
  Assert.ok(!hasSize($("tabbrowser-tabs")), "tabs have no size");
  Assert.ok(hasSize($("urlbar")), "URL bar visible with vertical tabs");

  await setPref(false);
  await TestUtils.waitForCondition(() => hasSize($("tabbrowser-tabs")), "vertical tabs back");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => !gBrowser.tabContainer.verticalMode,
    "tabs back in the horizontal strip",
  );
  await TestUtils.waitForCondition(() => !stripShown(), "horizontal strip hidden again");
});

add_task(async function help_overlay_still_opens() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("?", { shiftKey: true });
    const dialog = () => /** @type {HTMLDialogElement | null} */ ($("vimma-help"));
    await TestUtils.waitForCondition(() => !!dialog()?.open, "ctrl+b ? opens the help overlay");
    Assert.ok(BrowserTestUtils.isVisible(dialog()), "overlay is visible");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !dialog().open, "Esc closes it");
  });
});

add_task(async function vimma_keys_survive_a_failing_tab_strip() {
  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  const { TabStrip } = ChromeUtils.importESModule("chrome://browser/content/vimma/ui/tabstrip.mjs");
  const init = TabStrip.prototype.init;
  TabStrip.prototype.init = () => {
    throw new Error("simulated upstream change in tab code");
  };
  try {
    VimmaHost.uninit(window);
    VimmaHost.init(window);
  } finally {
    TabStrip.prototype.init = init;
  }
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("?", { shiftKey: true });
    const dialog = () => /** @type {HTMLDialogElement | null} */ ($("vimma-help"));
    await TestUtils.waitForCondition(() => !!dialog()?.open, "ctrl+b ? opens help anyway");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !dialog().open, "Esc closes it");
  });
  VimmaHost.uninit(window);
  VimmaHost.init(window);
  await TestUtils.waitForCondition(() => !stripShown(), "strip hidden again after re-init");
  Assert.ok(window.gNavToolbox.hasAttribute("tabs-hidden"), "re-init re-runs TabBarVisibility");
});
