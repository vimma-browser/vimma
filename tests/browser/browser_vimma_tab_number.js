/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-cmdline.md (`:tab N`, Since changed) and docs/specs/m2-tab-keys.md (`{N}gt`);
// issue #1302.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";
const INPUT_ID = "vimma-cmdline-input";
/** Enough tabs that tab 10 and above exist, as in issue #1302. */
const TABS = 15;

/** Every tab this file opened is closed again, even when a task fails half-way. */
registerCleanupFunction(() => {
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/**
 * Selects `tab` and focuses its page, so bare keys are normal mode's.
 * @param {MozTabbrowserTab} tab
 */
async function selectPage(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
  await focusContent(tab.linkedBrowser);
  Assert.equal(VimmaHost.status(window).mode, "normal", "sanity: the page is in normal mode");
}

/** Opens pages until the workspace has TABS visible tabs, and returns them in order. */
async function openFifteen() {
  while (gBrowser.visibleTabs.length < TABS) {
    const n = gBrowser.visibleTabs.length;
    await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?tab=${n + 1}`);
  }
  const tabs = [...gBrowser.visibleTabs];
  Assert.equal(tabs.length, TABS, "sanity: fifteen tabs in this workspace");
  return tabs;
}

/** `:line` typed key by key, then Enter. @param {string} line */
function runCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  const input = /** @type {HTMLInputElement} */ (document.getElementById(INPUT_ID));
  Assert.ok(input && !input.closest("[hidden]"), "the command line is open");
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

function noticeText() {
  const n = document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") && BrowserTestUtils.isVisible(n) ? n.textContent : "";
}

add_task(async function tab_n_goes_to_tab_twelve() {
  const tabs = await openFifteen();
  await selectPage(tabs[1]);
  runCommand("tab 12");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tabs[11], ":tab 12");
  Assert.equal(gBrowser.visibleTabs.indexOf(gBrowser.selectedTab), 11, ":tab 12 selects tab 12");

  await selectPage(tabs[2]);
  runCommand("tabnext 14");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tabs[13], ":tabnext 14");
});

add_task(async function count_gt_goes_to_tab_twelve() {
  const tabs = await openFifteen();
  await selectPage(tabs[0]);
  for (const key of ["1", "2", "g", "t"]) EventUtils.synthesizeKey(key);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tabs[11], "12gt");
  Assert.equal(gBrowser.visibleTabs.indexOf(gBrowser.selectedTab), 11, "12gt selects tab 12");
});

add_task(async function count_gt_past_the_last_tab_stays_silent() {
  const tabs = await openFifteen();
  await selectPage(tabs[2]);
  for (const key of ["2", "0", "g", "t"]) EventUtils.synthesizeKey(key);
  // Nothing to wait for: a notice, if any, is shown in the same task as the key.
  await new Promise((resolve) => setTimeout(resolve, 500));
  Assert.equal(gBrowser.selectedTab, tabs[2], "20gt with 15 tabs stays on the tab");
  Assert.equal(noticeText(), "", "and says nothing, as Vim");
});

add_task(async function tab_dollar_goes_to_the_last_tab() {
  const tabs = await openFifteen();
  await selectPage(tabs[3]);
  runCommand("tab $");
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tabs[TABS - 1], ":tab $");
});

add_task(async function out_of_range_says_how_many_tabs_there_are() {
  const tabs = await openFifteen();
  await selectPage(tabs[4]);
  runCommand("tab 20");
  await TestUtils.waitForCondition(() => noticeText() !== "", "a notice for :tab 20");
  Assert.equal(noticeText(), "no tab 20 (this workspace has 15)", "names the tab count");
  Assert.equal(gBrowser.selectedTab, tabs[4], "and stays on the tab it was on");
});

add_task(async function tab_completes_the_tabs_by_number_and_title() {
  const tabs = await openFifteen();
  await selectPage(tabs[0]);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("tab 12");
  const rows = () => [...document.querySelectorAll("#vimma-cmdline [role=option]")];
  await TestUtils.waitForCondition(() => rows().length > 0, "the list shows tab 12");
  const row = /** @type {HTMLElement} */ (rows()[0]);
  Assert.equal(row.dataset.value, "tab 12", "the first candidate is tab 12");
  Assert.equal(
    row.querySelector(".vimma-cmdline-description")?.textContent,
    tabs[11].label,
    "with that tab's title",
  );
  EventUtils.synthesizeKey("KEY_Escape");
});
