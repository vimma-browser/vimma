/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, decision 6 (Since changed, issue #866): Settings
// hides the controls for what Vimma manages itself (its theme, its keymap, its hidden tab strip,
// workspaces as containers) and keeps the ones that work in Vimma.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */

/**
 * Opens a Settings pane and, for each selector, waits for the element Firefox itself shows there:
 * one that matches with nothing above it or on it that Firefox hides: `hidden` on a control whose
 * condition is unmet, `data-hidden-by-setting-group` on a group with no control left to show
 * (setting-group.mjs). A check on such an element would pass whatever Vimma's rules say.
 * @param {string} pane
 * @param {Array<[string, string]>} rows [selector, what it is]
 * @param {(el: HTMLElement, what: string) => void} check
 */
async function inSettingsPane(pane, rows, check) {
  await BrowserTestUtils.withNewTab(`about:preferences#${pane}`, async (browser) => {
    // Settings loads in the parent process, so the browser has its document; a read through a
    // missing one throws, as it did before.
    const doc = /** @type {Document} */ (browser.contentDocument);
    for (const [selector, what] of rows) {
      const shownByFirefox = () =>
        [...doc.querySelectorAll(selector)].find(
          (el) => !el.closest("[hidden], [data-hidden-by-setting-group]"),
        );
      await TestUtils.waitForCondition(shownByFirefox, `Settings' ${pane} pane shows ${selector}`);
      check(/** @type {HTMLElement} */ (shownByFirefox()), what);
    }
  });
}

/**
 * @param {Array<[string, string, string]>} rows [pane, selector, what it is]
 * @param {(el: HTMLElement, what: string) => void} check
 */
async function eachPane(rows, check) {
  for (const pane of new Set(rows.map(([p]) => p))) {
    const inPane = rows.filter(([p]) => p == pane).map(([, sel, what]) => [sel, what]);
    await inSettingsPane(pane, /** @type {Array<[string, string]>} */ (inPane), check);
  }
}

/**
 * Whether `el`, an element of the open Settings page, is laid out. Its document is shown, so it
 * has a window.
 * @param {Element} el
 */
function shown(el) {
  const win = /** @type {Window} */ (el.ownerDocument.defaultView);
  return win.getComputedStyle(el).display !== "none";
}

/** @type {Array<[string, string, string]>} What Vimma manages itself: [pane, selector, what]. */
const MANAGED = [
  ["appearance", 'setting-group[groupid="browserTheme"]', "the Firefox theme group"],
  [
    "appearance",
    "#setting-control-related-settings-tabs-browsing-link",
    "the Customize browser layout link",
  ],
  [
    "tabsBrowsing",
    'setting-group[groupid="browserLayout"]',
    "the horizontal or vertical tabs choice",
  ],
  ["tabsBrowsing", "#setting-control-ctrlTabRecentlyUsedOrder", "Firefox's ctrl+tab order"],
  ["tabsBrowsing", "#setting-control-tabsInteraction", "the Interaction fieldset left empty"],
  ["tabsBrowsing", "#setting-control-tabGroupSuggestions", "the tab group suggestions"],
  ["tabsBrowsing", "#setting-control-tabGroupDragToCreate", "drag to create a tab group"],
  ["tabsBrowsing", "#setting-control-tabPreviewShowThumbnails", "the tab preview images"],
  ["tabsBrowsing", "#setting-control-browserContainersCheckbox", "the container tabs switch"],
  [
    "tabsBrowsing",
    'setting-group[groupid="keyboardShortcuts"]',
    "Tabs and browsing's about:keyboard link",
  ],
  ["tabsBrowsing", "#setting-control-searchStartTyping", "search when you start typing"],
  [
    "accessibility",
    "#setting-control-keyboardCustomkeysLink",
    "Accessibility's about:keyboard link",
  ],
];

/** @type {Array<[string, string, string]>} What works in Vimma and stays, near each hidden one. */
const KEPT = [
  ["appearance", 'setting-group[groupid="appearance"]', "Website appearance"],
  ["appearance", 'setting-group[groupid="windowDensity"]', "window density"],
  ["appearance", "#setting-control-related-settings-accessibility-link", "the Accessibility link"],
  ["appearance", "#setting-control-related-settings-home-link", "the Start Page link"],
  ["tabsBrowsing", "#setting-control-browserContainersSettings", "the containers' settings"],
  ["tabsBrowsing", "#setting-control-switchToNewTabs", "switch to new tabs"],
  ["tabsBrowsing", "#setting-control-useCursorNavigation", "cursor-key navigation"],
  ["accessibility", "#setting-control-addressBarNavigationLink", "the address bar keys link"],
  ["accessibility", 'setting-group[groupid="fonts"]', "fonts"],
];

/** @param {string} label */
async function settingsHideWhatVimmaManages(label) {
  await eachPane(MANAGED, (el, what) => {
    Assert.ok(!shown(el), `Settings does not show ${what}${label}`);
  });
}

add_setup(async function () {
  // Some of these show only with a pref on: the preview images with hover previews, the group
  // suggestions with smart tab groups. Turned on so the rule, not the pref, is what is tested.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.hoverPreview.enabled", true],
      ["browser.tabs.groups.smart.enabled", true],
      ["browser.tabs.groups.smart.userEnabled", true],
    ],
  });
});

add_task(async function settings_hide_what_vimma_manages() {
  await settingsHideWhatVimmaManages("");
});

add_task(async function settings_hide_them_under_forced_colours() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  await settingsHideWhatVimmaManages(" under forced colours");
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_keep_what_works_in_vimma() {
  await eachPane(KEPT, (el, what) => {
    Assert.ok(shown(el), `Settings keeps ${what}`);
  });
});
