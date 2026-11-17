/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/close-active-tab.md. A `[modal.insert]` binding of `tab.close` closes the tab
// from a text field instead of editing it, and only on a key the user pressed: the page's own
// ctrl+w closes nothing. `panel.close_active_tab` in `[modal.panel]` closes the tab the window
// shows, not the highlighted row's, and the side panel stays open with its highlight in place.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const MAC = AppConstants.platform === "macosx";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_close_active_tab.html";

/** The default keys, which every task ends with. */
const defaultKeys = () => VimmaHost.configure({ keymap: compileKeymap({}, { mac: MAC }) });
registerCleanupFunction(defaultKeys);

/**
 * Binds `user`'s keys for the rest of the task.
 * @param {Parameters<typeof compileKeymap>[0]} user
 */
function bind(user) {
  VimmaHost.configure({ keymap: compileKeymap(user, { mac: MAC }) });
}

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * Opens the fixture in a foreground tab with "foo bar" typed in its field, in insert mode.
 * @returns {Promise<MozTabbrowserTab>}
 */
async function openTyping() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  await SpecialPowers.spawn(browser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.focus();
    field.value = "foo bar";
    field.setSelectionRange(7, 7);
  });
  await until(() => VimmaHost._browserMode(browser) === "insert", "insert mode in the field");
  return tab;
}

/** @param {XULBrowserElement} browser */
const fieldValue = (browser) =>
  SpecialPowers.spawn(
    browser,
    [],
    () => /** @type {HTMLInputElement} */ (content.document.getElementById("text")).value,
  );

add_task(async function insert_ctrl_w_bound_to_tab_close_closes_the_tab_not_the_word() {
  bind({ modal: { insert: { "<C-w>": "tab.close" } } });
  const keep = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const tab = await openTyping();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await closed;
  await until(() => !tab.isConnected, "ctrl+w closed the tab the field was in");
  Assert.equal(gBrowser.selectedTab, keep, "and only that tab");
  BrowserTestUtils.removeTab(keep);
});

// docs/security/13-page-modes.md K11: the page's own ctrl+w is untrusted and never Vimma's.
add_task(async function a_ctrl_w_the_page_dispatches_closes_nothing() {
  bind({ modal: { insert: { "<C-w>": "tab.close" } } });
  const tab = await openTyping();
  const browser = tab.linkedBrowser;
  const sent = await SpecialPowers.spawn(browser, [], () => {
    const page = /** @type {any} */ (content.wrappedJSObject);
    page.fakeCtrlW();
    return [...page.sent];
  });
  Assert.deepEqual(sent, ["keydown", "keypress", "keyup"], "the page sent its own ctrl+w");
  // A positive control: a real key after it is typed, so the page's keys have had their turn.
  EventUtils.synthesizeKey("x");
  await until(async () => (await fieldValue(browser)) === "foo barx", "x is typed");
  Assert.ok(tab.isConnected, "the tab is still open");
  Assert.equal(gBrowser.selectedTab, tab, "and selected");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function by_default_ctrl_w_in_a_field_still_deletes_the_word() {
  defaultKeys();
  const tab = await openTyping();
  const browser = tab.linkedBrowser;
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await until(async () => (await fieldValue(browser)) === "foo ", "ctrl+w deletes a word");
  Assert.ok(tab.isConnected, "and closes no tab");
  BrowserTestUtils.removeTab(tab);
});

const PANEL_ID = "vimma-panel";
const panel = () => /** @type {HTMLElement | null} */ (document.getElementById(PANEL_ID));
const isOpen = () => !!panel() && !panel()?.hidden && BrowserTestUtils.isVisible(panel());
const selectedRow = () => panel()?.querySelector("[role=option][aria-selected=true]");
const selectedTitle = () => selectedRow()?.querySelector(".vimma-panel-title")?.textContent ?? "";

/**
 * A foreground tab titled `title`.
 * @param {string} title
 */
async function openTitled(title) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${title}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [title], (t) => {
    content.document.title = t;
  });
  await until(() => tab.linkedBrowser.contentTitle === title, "the page has its title");
  return tab;
}

add_task(async function panel_close_active_tab_closes_the_shown_tab_and_keeps_the_panel() {
  await /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window)).ready;
  bind({ modal: { panel: { "<C-w>": "panel.close_active_tab" } } });
  const one = await openTitled("cat-one");
  const two = await openTitled("cat-two");
  const three = await openTitled("cat-three");
  await focusContent(three.linkedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("b");
  await until(isOpen, "ctrl+b b opens the side panel");
  await until(() => selectedTitle() === "cat-three", "the active tab is highlighted");
  EventUtils.synthesizeKey("k");
  EventUtils.synthesizeKey("k");
  await until(() => selectedTitle() === "cat-one", "k k highlights cat-one");

  const closed = BrowserTestUtils.waitForTabClosing(three);
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await closed;
  await until(() => !three.isConnected, "ctrl+w closed the active tab, cat-three");
  Assert.ok(one.isConnected && two.isConnected, "not the highlighted one");
  await until(() => !panel()?.querySelector(`[data-tab-id="${three.linkedPanel}"]`), "row gone");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.equal(selectedTitle(), "cat-one", "the highlight stays on cat-one");
  // Firefox focuses the next tab's page after the switch; the panel takes focus back
  // (side-panel.mjs, onSwitchDone).
  await until(() => panel()?.contains(document.activeElement), "the panel keeps focus");

  // On the active row the highlight moves on, as x moves it.
  const shown = gBrowser.selectedTab;
  const title = shown.linkedBrowser.contentTitle;
  while (selectedTitle() !== title) {
    const before = selectedTitle();
    EventUtils.synthesizeKey("j");
    await until(() => selectedTitle() !== before, `down from ${before}`);
  }
  const gone = BrowserTestUtils.waitForTabClosing(shown);
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await gone;
  await until(() => selectedTitle() && selectedTitle() !== title, "the highlight moved off it");
  Assert.ok(isOpen(), "still open");

  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes the panel");
  for (const t of [one, two]) if (t.isConnected) BrowserTestUtils.removeTab(t);
});

// Decision 3: without the side panel there is no row to keep, so it is tab.close.
add_task(async function panel_close_active_tab_outside_the_panel_closes_the_shown_tab() {
  bind({ keys: { panel_close_active_tab: "ctrl+alt+w" } });
  const keep = await openTitled("cat-keep");
  const tab = await openTitled("cat-alone");
  await focusContent(tab.linkedBrowser);
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { ctrlKey: true, altKey: true });
  await closed;
  Assert.ok(!isOpen(), "no panel opened");
  Assert.equal(gBrowser.selectedTab, keep, "the shown tab closed in normal mode");
  BrowserTestUtils.removeTab(keep);
});
