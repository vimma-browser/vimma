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

// Six Settings tabs (Home, Privacy and General, twice), each building its pane on the parent's
// main thread: under 11 s on a quiet CI runner, but up to 50 s at a load average of 8 to 16
// (#992).
// Each wait still fails on its own, within TestUtils.waitForCondition's 50 polls.
requestLongerTimeout(2);

/**
 * Each surface decision 6 hides: [pane, selector, what it is].
 * @type {Array<[string, string, string]>}
 */
const HIDDEN_IN_SETTINGS = [
  ["home", 'setting-group[groupid="home"]', "the Firefox Home content group"],
  ["privacy", 'setting-group[groupid="dataCollection"]', "the data collection group"],
  ["general", "#setting-control-cfrRecommendations", "the extension recommendations switch"],
  ["general", "#setting-control-cfrRecommendations-features", "the feature recommendations switch"],
  ["general", "#setting-control-supportShareIdeas", "the connect.mozilla.org link"],
];

/** Settings' Firefox Labs button, checked in the General pane. */
const LABS = "#category-experimental";

/** @param {string} label */
async function settingsHideWhatControlsNothing(label) {
  for (const pane of new Set(HIDDEN_IN_SETTINGS.map(([p]) => p))) {
    const rows = HIDDEN_IN_SETTINGS.filter(([p]) => p === pane);
    const selectors = rows.map(([, selector]) => selector);
    await openSettingsPane(pane, pane === "general" ? [...selectors, LABS] : selectors, (doc) => {
      const win = /** @type {Window} */ (doc.defaultView);
      for (const [, selector, what] of rows) {
        Assert.equal(
          win.getComputedStyle(/** @type {Element} */ (doc.querySelector(selector))).display,
          "none",
          `Settings does not show ${what}${label}`,
        );
      }
      if (pane !== "general") {
        return;
      }
      const labs = /** @type {HTMLElement} */ (doc.querySelector(LABS));
      // Firefox shows the Labs button once a Labs recipe is enrolled (firefoxLabs.mjs).
      labs.hidden = false;
      Assert.equal(
        win.getComputedStyle(labs).display,
        "none",
        `Settings' navigation has no Firefox Labs${label}`,
      );
    });
  }
}

add_task(async function settings_hide_what_controls_nothing() {
  await settingsHideWhatControlsNothing("");
});

add_task(async function settings_hide_them_under_forced_colours() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  await settingsHideWhatControlsNothing(" under forced colours");
  await SpecialPowers.popPrefEnv();
});
