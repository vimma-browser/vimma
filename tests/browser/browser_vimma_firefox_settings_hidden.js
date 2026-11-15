/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery step 4b: Settings hides what controls
// nothing in Vimma (decisions 2, 3 and 6), also under forced colours (decision 7).
//
// Moved out of browser_vimma_firefox_surfaces_trim.js with the other Settings tests
// (browser_vimma_firefox_settings_trim.js, #992).

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global openSettingsPane -- from head.js */

// Eight Settings tabs (four panes, twice), each building its pane on the parent's main thread:
// about 11 s locally at a load average of 8 to 16 (#997), but the six tabs this file opened
// before took up to 50 s on a loaded machine (#992).
// Each wait still fails on its own, within TestUtils.waitForCondition's 50 polls.
requestLongerTimeout(2);

/**
 * Each surface decision 6 hides: [pane, selector, what it is]. The pane is the one Firefox shows
 * it in: with the settings redesign, data collection is under Permissions and data, the
 * recommendation switches under Tabs and browsing, the connect.mozilla.org link under About.
 * @type {Array<[string, string, string]>}
 */
const HIDDEN_IN_SETTINGS = [
  ["home", 'setting-group[groupid="home"]', "the Firefox Home content group"],
  ["permissionsData", 'setting-group[groupid="dataCollection"]', "the data collection group"],
  ["tabsBrowsing", "#setting-control-cfrRecommendations", "the extension recommendations switch"],
  [
    "tabsBrowsing",
    "#setting-control-cfrRecommendations-features",
    "the feature recommendations switch",
  ],
  ["about", "#setting-control-supportShareIdeas", "the connect.mozilla.org link"],
];

/** Settings' Firefox Labs button, in the navigation of every pane: checked in the last one. */
const LABS = "#category-experimental";

/** The sheet theme-host.mjs gives Firefox's pages, which holds Vimma's hiding rules. */
const PAGES_SHEET = "chrome://browser/skin/vimma/firefox-pages.css";

/**
 * Asserts that Vimma's sheet, not Firefox, is what hides `what`: with firefox-pages.css taken off
 * the page, Firefox shows a match of `selector` (no `hidden` on it or above it, no group emptied
 * by `data-hidden-by-setting-group`, no pane or filter of Firefox's hiding it); with the sheet
 * back, that element is `display: none`. A bare `display: none` check would pass whatever
 * Vimma's rules say once Firefox hides the element itself (#997).
 *
 * The sheet goes back last in the page's author sheets, which only reorders Vimma's own sheets
 * for the rest of this tab.
 * @param {Document} doc
 * @param {string} selector
 * @param {string} what
 * @param {string} label
 */
async function assertVimmaHides(doc, selector, what, label) {
  const win = /** @type {Window} */ (doc.defaultView);
  const utils = win.windowUtils;
  /** @type {Element | undefined} */
  let shown;
  utils.removeSheetUsingURIString(PAGES_SHEET, utils.AUTHOR_SHEET);
  try {
    info(`Waiting for Settings to show ${what} without Vimma's sheet${label}`);
    await TestUtils.waitForCondition(
      () =>
        (shown = [...doc.querySelectorAll(selector)].find((el) =>
          // visibility: hidden on an ancestor counts as Firefox hiding it, as display: none does.
          el.checkVisibility({ visibilityProperty: true }),
        )),
      `Firefox shows ${what} (${selector}) when Vimma's sheet is off${label}`,
    );
  } finally {
    utils.loadSheetUsingURIString(PAGES_SHEET, utils.AUTHOR_SHEET);
  }
  Assert.equal(
    win.getComputedStyle(/** @type {Element} */ (shown)).display,
    "none",
    `Settings does not show ${what}${label}`,
  );
}

/** @param {string} label */
async function settingsHideWhatControlsNothing(label) {
  const panes = [...new Set(HIDDEN_IN_SETTINGS.map(([p]) => p))];
  const last = panes[panes.length - 1];
  for (const pane of panes) {
    const rows = HIDDEN_IN_SETTINGS.filter(([p]) => p === pane);
    const selectors = rows.map(([, selector]) => selector);
    await openSettingsPane(pane, pane === last ? [...selectors, LABS] : selectors, async (doc) => {
      for (const [, selector, what] of rows) {
        await assertVimmaHides(doc, selector, what, label);
      }
      if (pane !== last) {
        return;
      }
      // Firefox shows the Labs button once a Labs recipe is enrolled (firefoxLabs.mjs); unenrolled,
      // it is `hidden`, so the test un-hides it first, as an enrolment would, after the checks
      // above.
      /** @type {HTMLElement} */ (doc.querySelector(LABS)).hidden = false;
      await assertVimmaHides(doc, LABS, "Firefox Labs in Settings' navigation", label);
    });
  }
}

add_task(async function settings_hide_what_controls_nothing() {
  await settingsHideWhatControlsNothing("");
});

add_task(async function settings_hide_them_under_forced_colours() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  try {
    await settingsHideWhatControlsNothing(" under forced colours");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});
