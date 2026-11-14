/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Focus sync (docs/specs/m4-split-panes.md, sub-spec 4): a click in a pane, or a TabSelect of a
// pane's tab from anywhere (the picker, ctrl+tab, an extension), moves core's focus and MRU to
// that pane; the status bar and URL bar follow; no loop between TabSelect and reconcile.

"use strict";

/* global focusContent, recordPageKeys -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE = "https://example.com/";
const TITLES = ["Alpha", "Bravo", "Charlie"];

/** The window's split view, which VimmaHost made when it started the window. */
function view() {
  return /** @type {PaneView} */ (PaneViews.get(window));
}

/** The split's panes, which a test reads while its panes are split. */
function panes() {
  return /** @type {Panes} */ (view().panes);
}

/** @param {string} pane */
function tabOfPane(pane) {
  const leaf = leaves(panes()).find((l) => l.pane === pane);
  return gBrowser.tabs.find((t) => t.linkedPanel === leaf?.tab);
}

function focusedTab() {
  return tabOfPane(panes().focus);
}

/** @param {string} id */
function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

/**
 * @param {() => unknown} cond
 * @param {string} msg
 */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** Lets any late TabSelect or reconcile land before events are counted. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))),
    );
    await TestUtils.waitForTick();
  }
}

/** TabSelect events from now on, by tab. */
function countSelects() {
  /** @type {(EventTarget | null)[]} */
  const seen = [];
  const listener = (/** @type {Event} */ e) => seen.push(e.target);
  gBrowser.tabContainer.addEventListener("TabSelect", listener);
  registerCleanupFunction(() => gBrowser.tabContainer.removeEventListener("TabSelect", listener));
  return {
    seen,
    stop: () => gBrowser.tabContainer.removeEventListener("TabSelect", listener),
  };
}

/**
 * @param {string} key
 * @param {KeyEventOptions} [mods]
 */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** Three example.com panes side by side, titled Alpha | Bravo | Charlie; Alpha focused. */
async function threePanes() {
  await reset(); // a failed task leaves its panes behind
  /** @type {SplitTab[]} */
  const tabs = [];
  for (const [i, title] of TITLES.entries()) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${i}`);
    await SpecialPowers.spawn(tab.linkedBrowser, [title], (t) => {
      content.document.title = t;
    });
    await until(() => tab.linkedBrowser.contentTitle === title, `title ${title}`);
    tabs.push(/** @type {SplitTab} */ (tab));
  }
  const [a, b, c] = tabs;
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.ok(view().split("vertical", { tab: b }).ok, "split a | b");
  Assert.ok(view().split("vertical", { tab: c }).ok, "split b | c");
  view().focus("left");
  view().focus("left");
  await focusContent(a.linkedBrowser);
  await recordPageKeys(a.linkedBrowser);
  await settle();
  Assert.equal(focusedTab(), a, "sanity: Alpha's pane has focus");
  Assert.equal(gBrowser.selectedTab, a, "sanity: and its tab is selected");
  await until(() => segText("pane") === "pane 1/3", "sanity: the status bar says pane 1/3");
  return tabs;
}

/**
 * Core, Firefox, the URL bar and the status bar agree that `tab`'s pane (n of 3) has focus.
 * @param {MozTabbrowserTab} tab
 * @param {number} n
 * @param {string} what
 */
async function assertFocused(tab, n, what) {
  Assert.equal(focusedTab(), tab, `${what}: core's focus is on the pane`);
  Assert.equal(panes().mru[0], panes().focus, `${what}: it heads the MRU`);
  Assert.equal(gBrowser.selectedTab, tab, `${what}: its tab is selected`);
  Assert.equal(gURLBar.untrimmedValue, tab.linkedBrowser.currentURI.spec, `${what}: URL bar`);
  await until(() => segText("pane") === `pane ${n}/3`, `${what}: the status bar says pane ${n}/3`);
}

async function reset() {
  while (view().panes) view().close();
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  await settle();
}

registerCleanupFunction(async () => {
  await reset();
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function a_click_in_pane_3_focuses_it_in_core_firefox_and_the_bars() {
  const [, , c] = await threePanes();
  const selects = countSelects();
  await EventUtils.synthesizeMouseAtCenter(c.linkedBrowser, {});
  await until(() => gBrowser.selectedTab === c, "the click selects Charlie's tab");
  await settle();
  await assertFocused(c, 3, "click in pane 3");
  Assert.equal(document.activeElement, c.linkedBrowser, "its page has focus");
  selects.stop();
  Assert.deepEqual(selects.seen, [c], "one TabSelect, for Charlie: no loop");
  await reset();
});

add_task(async function the_picker_selecting_pane_2s_tab_focuses_pane_2() {
  const [, b] = await threePanes();
  const selects = countSelects();
  prefix("g");
  await until(
    () => /** @type {HTMLDialogElement | null} */ (document.getElementById("vimma-picker"))?.open,
    "the picker opens",
  );
  for (const ch of "bravo") EventUtils.synthesizeKey(ch); // typing at once (tab-search)
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === b, "Enter selects Bravo's tab");
  await settle();
  await assertFocused(b, 2, "picker to pane 2");
  selects.stop();
  Assert.deepEqual(selects.seen, [b], "one TabSelect, for Bravo: no loop");
  await reset();
});

add_task(async function selecting_a_zoomed_away_panes_tab_unzooms_and_focuses_it() {
  const [a, b, c] = await threePanes();
  prefix("z");
  await settle();
  Assert.equal(panes().zoom, panes().focus, "sanity: Alpha's pane is zoomed");
  Assert.ok(!c.linkedBrowser.docShellIsActive, "sanity: Charlie's pane is asleep");

  const selects = countSelects();
  gBrowser.selectedTab = c; // ctrl+tab, alt+3, an extension: any selection outside Vimma
  await settle();
  await assertFocused(c, 3, "selecting a zoomed-away pane's tab");
  Assert.equal(panes().zoom, null, "the zoom ends, as for a pane move");
  for (const t of [a, b, c]) Assert.ok(t.linkedBrowser.docShellIsActive, "every pane is live");
  selects.stop();
  Assert.deepEqual(selects.seen, [c], "one TabSelect, for Charlie: no loop");

  // Selecting the focused pane's own tab again changes nothing, the zoom included.
  prefix("z");
  await settle();
  const zoomed = view().panes;
  const again = countSelects();
  gBrowser.selectedTab = c;
  await settle();
  again.stop();
  Assert.equal(view().panes, zoomed, "the tree is untouched");
  Assert.deepEqual(again.seen, [], "and nothing is selected");
  await reset();
});

add_task(async function keyboard_moves_focus_the_page_not_a_url_bar_it_last_had() {
  const [a, b] = await threePanes();
  prefix("l");
  await assertFocused(b, 2, "ctrl+b l");
  gURLBar.focus();
  await until(() => gURLBar.focused, "sanity: Bravo's URL bar has focus");
  const selects = countSelects();
  prefix("h");
  await assertFocused(a, 1, "ctrl+b h");
  prefix("l");
  await assertFocused(b, 2, "ctrl+b l back");
  await settle();
  Assert.equal(document.activeElement, b.linkedBrowser, "Bravo's page has focus");
  Assert.ok(!gURLBar.focused, "not the URL bar it had when left");
  selects.stop();
  Assert.deepEqual(selects.seen, [a, b], "one TabSelect per move");
  Assert.equal(VimmaHost.status(window).pane?.index, 2, "the host's status agrees");
  await reset();
});
