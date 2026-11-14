/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m2-picker-rename.md (the goto picker), which is tab search
// (docs/specs/tab-search.md): it opens typing, and Esc closes it.

"use strict";

/* global focusContent, recordPageKeys, pageKeys -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);

const PAGE = "https://example.org/";
const PICKER_ID = "vimma-picker";
const TITLES = ["Asetukset", "Kalenteri", "Käyttäjät"];

registerCleanupFunction(() => {
  const picker = /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
  if (picker?.open) EventUtils.synthesizeKey("KEY_Escape");
  while (gBrowser.tabs.length > 1)
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
});

const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
/** The picker, which a test reads once it opened it (a missing one fails the read). */
const shown = () => /** @type {HTMLDialogElement} */ (picker());
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const rowTitle = (/** @type {Element} */ row) =>
  /** @type {Element} */ (row.querySelector(".vimma-picker-title")).textContent;
const titles = () => rows().map(rowTitle);
const selected = () =>
  /** @type {Element} */ (shown().querySelector("[role=option][aria-selected=true]"));

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * Selects `tab`; BrowserTestUtils.switchTab never resolves for the tab already selected.
 * @param {MozTabbrowserTab} tab
 */
async function select(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
}

/**
 * One example.org tab per title, each recording its keys; the first focused, normal mode. The
 * tabs earlier tasks closed are forgotten first: tab search lists recently closed tabs too.
 * @param {string[]} [list]
 */
async function openTitled(list = TITLES) {
  /** @type {MozTabbrowserTab[]} */
  const tabs = [];
  for (const [i, title] of list.entries()) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?tab=${i}`);
    const browser = tab.linkedBrowser;
    await SpecialPowers.spawn(browser, [title], (t) => {
      content.document.title = t;
    });
    await until(() => browser.contentTitle === title, `title ${title}`);
    await recordPageKeys(browser);
    tabs.push(tab);
  }
  // By now the previous task's tabs have finished closing.
  while (SessionStore.getClosedTabCountForWindow(window)) SessionStore.forgetClosedTab(window, 0);
  while (SessionStore.getClosedWindowCount()) SessionStore.forgetClosedWindow(0);
  await select(tabs[0]);
  await focusContent(tabs[0].linkedBrowser);
  Assert.equal(VimmaHost.status(window).mode, "normal", "sanity: the page is in normal mode");
  return tabs;
}

/** @param {MozTabbrowserTab[]} tabs */
function closeTabs(tabs) {
  for (const tab of tabs) if (!tab.closing && tab.isConnected) BrowserTestUtils.removeTab(tab);
}

function openPicker() {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("g");
}

/** Keys as formatKey writes them: "/" and letters, one synthesizeKey each. @param {string} text */
function type(text) {
  for (const ch of text) EventUtils.synthesizeKey(ch);
}

add_task(async function prefix_g_lists_every_tab_with_number_label_and_host() {
  const tabs = await openTitled();
  openPicker();
  Assert.ok(isOpen(), "ctrl+b g opens the picker");
  Assert.ok(BrowserTestUtils.isVisible(picker()), "visible");
  Assert.equal(VimmaHost.status(window).mode, "help", "a modal overlay owns the keys");
  const visible = gBrowser.visibleTabs;
  Assert.equal(rows().length, visible.length, "one row per tab of the window");
  const row = rows()[visible.indexOf(tabs[2])];
  Assert.equal(rowTitle(row), "Käyttäjät", "the row shows the title");
  Assert.equal(
    /** @type {Element} */ (row.querySelector(".vimma-picker-index")).textContent,
    String(visible.indexOf(tabs[2]) + 1),
    "and the tab number",
  );
  Assert.equal(
    /** @type {Element} */ (row.querySelector(".vimma-picker-host")).textContent,
    "example.org",
    "and host",
  );
  Assert.strictEqual(selected(), rows()[visible.indexOf(tabs[0])], "the current tab is selected");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "Esc closes it");
  closeTabs(tabs);
});

add_task(async function arrows_and_ctrl_n_p_move_the_selection_and_j_types() {
  const tabs = await openTitled();
  openPicker();
  const at = () => rows().indexOf(selected());
  const start = at();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(at(), start + 1, "Down moves down");
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  Assert.equal(at(), start + 2, "ctrl+n moves down");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(at(), start + 1, "Up moves up");
  EventUtils.synthesizeKey("p", { ctrlKey: true });
  Assert.equal(at(), start, "ctrl+p moves up");
  EventUtils.synthesizeKey("j");
  Assert.equal(
    /** @type {Element} */ (shown().querySelector(".vimma-picker-query")).textContent,
    "/j",
    "j types: the picker opens typing (tab-search decision 2)",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  closeTabs(tabs);
});

add_task(async function finnish_letters_rank_exact_first_and_enter_selects() {
  const tabs = await openTitled();
  const pageBrowser = tabs[0].linkedBrowser;
  openPicker();
  type("kä");
  Assert.equal(
    /** @type {Element} */ (shown().querySelector(".vimma-picker-query")).textContent,
    "/kä",
    "the query shows",
  );
  Assert.equal(titles()[0], "Käyttäjät", "kä ranks Käyttäjät first");
  Assert.equal(
    rows()[0].querySelector(".vimma-picker-title mark")?.textContent,
    "Kä",
    "the match is highlighted",
  );
  Assert.strictEqual(selected(), rows()[0], "the best match is selected");

  EventUtils.synthesizeKey("KEY_Backspace");
  EventUtils.synthesizeKey("KEY_Backspace");
  type("ka");
  const list = titles();
  Assert.ok(list.includes("Käyttäjät"), "ka still finds Käyttäjät");
  Assert.less(
    list.indexOf("Kalenteri"),
    list.indexOf("Käyttäjät"),
    "below the exact-letter match Kalenteri",
  );
  Assert.ok(!list.includes("Asetukset"), "a non-match is filtered out");

  Assert.strictEqual(selected(), rows()[0], "on the best match, Kalenteri");
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  Assert.equal(rowTitle(selected()), "Käyttäjät", "ctrl+n moves to Käyttäjät");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.ok(!isOpen(), "Enter closes the picker");
  Assert.equal(gBrowser.selectedTab, tabs[2], "and selects that tab");
  Assert.deepEqual(await pageKeys(pageBrowser), [], "the page saw none of the picker's keys");
  closeTabs(tabs);
});

add_task(async function esc_closes_and_restores_focus_without_page_keys() {
  const tabs = await openTitled();
  const browser = tabs[0].linkedBrowser;
  openPicker();
  type("jk/xq"); // every letter types, q too
  Assert.equal(
    /** @type {Element} */ (shown().querySelector(".vimma-picker-query")).textContent,
    "/jk/xq",
    "typed",
  );
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  Assert.equal(gBrowser.tabs.includes(tabs[0]), true, "ctrl+w closed no tab");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "one Esc closes");
  Assert.equal(gBrowser.selectedTab, tabs[0], "the tab did not change");
  Assert.equal(document.activeElement, browser, "focus is back on the page");
  Assert.equal(VimmaHost.status(window).mode, "normal", "in normal mode again");
  Assert.deepEqual(await pageKeys(browser), [], "the page received no key");
  closeTabs(tabs);
});

add_task(async function ls_and_b_open_it() {
  const tabs = await openTitled();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("ls");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":ls opens the picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusContent(tabs[0].linkedBrowser);
  EventUtils.synthesizeKey("b");
  Assert.ok(isOpen(), "b in normal mode opens it");
  EventUtils.synthesizeKey("KEY_Escape");
  closeTabs(tabs);
});

add_task(async function a_tab_switch_underneath_closes_it() {
  const tabs = await openTitled();
  openPicker();
  gBrowser.selectedTab = tabs[1];
  Assert.ok(!isOpen(), "a tab switch closes the picker");
  closeTabs(tabs);
});
