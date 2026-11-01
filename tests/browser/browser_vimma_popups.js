/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/popup-blocked.md. While the selected page has Firefox's "pop-up blocked" bar,
// the status bar says `pop-up blocked · ctrl+b shift+o`; ctrl+b shift+o and :popups open a picker
// over the bar's own options (allow the site, open one pop-up, stop showing the bar, settings),
// run through Firefox's PopupAndRedirectBlockerObserver. Nothing blocked: a notice. In the agent
// workspace the picker refuses and grants nothing (docs/security.md M10).

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const BLOCKING = ROOT + "file_vimma_popups.html";
const PAGE = "https://example.com/";
const PICKER_ID = "vimma-popup-picker";
const NOTICE_ID = "vimma-notice";
const CUE = "pop-up blocked · ctrl+b shift+o";

const picker = () => document.getElementById(PICKER_ID);
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const ids = () => rows().map((r) => r.dataset.id);
const title = (row) => row.querySelector(".vimma-picker-title").textContent;
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const cue = () =>
  document.querySelector('#vimma-statusbar [data-segment="popups"]')?.textContent ?? null;
const bar = (browser = gBrowser.selectedBrowser) =>
  gBrowser.readNotificationBox(browser)?.getNotificationWithValue("popup-blocked") ?? null;

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** ctrl+b, then `key`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

const openPicker = () => prefix("O", { shiftKey: true });

/**
 * The open picker's rows. The dialog keeps its last rows after it closes, so a count alone can
 * pass before the rows load and the picker opens.
 * @param {number} n
 */
const pickerShows = (n) => until(() => isOpen() && rows().length === n, `${n} rows`);

/** A foreground tab on the fixture, once Firefox shows its bar. */
async function blockingTab(options = {}) {
  const tab = BrowserTestUtils.addTab(gBrowser, BLOCKING, options);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await until(() => !!bar(tab.linkedBrowser), "Firefox shows the pop-up blocked bar");
  return tab;
}

/**
 * The pop-up's tab. waitForAnyTab, because without it a waiter takes the first tab that opens,
 * and the two pop-ups open together.
 * @param {string} query
 */
const popupTab = (query) =>
  BrowserTestUtils.waitForNewTab(gBrowser, (url) => url === `${BLOCKING}?${query}`, true, true);

/**
 * Selects `tab`. Closing a pop-up's tab gives the selection back to its opener, and switchTab to
 * the selected tab waits for a TabSwitchDone that never comes.
 */
async function select(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
}

const allowed = (tab) =>
  Services.perms.testPermissionFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup") ===
  Services.perms.ALLOW_ACTION;

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.disable_open_during_load", true],
      ["privacy.popups.showBrowserMessage", true],
      // Pop-ups open in background tabs, so the blocking page stays selected. Selecting it again
      // would bring its bar back: Firefox keeps the blocked list after "allow", and a switch
      // between pages with different counts re-raises the bar (Tabbrowser.sys.mjs,
      // updateCurrentBrowser).
      ["browser.tabs.loadDivertedInBackground", true],
    ],
  });
  registerCleanupFunction(() => {
    for (const perm of Services.perms.all) {
      if (perm.type === "popup") Services.perms.removePermission(perm);
    }
    // Selecting the agent's tab moved the window into the agent workspace; the next test file
    // expects the user's.
    const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
    if (main) WindowWorkspaces.get(window).switchTo({ id: main.id });
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  });
});

add_task(async function nothing_blocked_says_so_and_opens_no_picker() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  Assert.equal(cue(), null, "no cue without the bar");
  openPicker();
  await until(() => noticeText().includes("no pop-ups blocked on this page"), "the notice");
  Assert.ok(!isOpen(), "no picker");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_cue_follows_the_selected_tab() {
  const blocking = await blockingTab();
  await until(() => cue() === CUE, "the status bar names the key");
  const plain = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await until(() => cue() === null, "another tab: no cue");
  await BrowserTestUtils.switchTab(gBrowser, blocking);
  await until(() => cue() === CUE, "back: the cue again");

  // Firefox's own close button on the bar: the cue goes with it.
  bar().shadowRoot.querySelector("moz-button.close").click();
  await until(() => cue() === null, "the bar closed: no cue");
  BrowserTestUtils.removeTab(plain);
  BrowserTestUtils.removeTab(blocking);
});

add_task(async function the_picker_lists_the_bar_options_and_opens_one_popup() {
  const tab = await blockingTab();
  openPicker();
  await until(isOpen, "ctrl+b shift+o opens the picker");
  await pickerShows(5);
  Assert.deepEqual(ids(), ["allow", "popup:0", "popup:1", "hide", "settings"]);
  Assert.equal(title(rows()[0]), "Allow pop-ups for example.com");
  Assert.equal(title(rows()[1]), `Open ${BLOCKING}?a`);
  Assert.equal(title(rows()[2]), `Open ${BLOCKING}?b`);

  const opened = popupTab("a");
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  const a = await opened;
  Assert.ok(!isOpen(), "Enter closes the picker");
  Assert.ok(!allowed(tab), "opening one pop-up grants nothing");
  BrowserTestUtils.removeTab(a);

  // :popups opens the same picker.
  await select(tab);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("popups");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":popups opens the picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function allow_grants_the_site_and_opens_the_blocked_popups() {
  const tab = await blockingTab();
  openPicker();
  await pickerShows(5);
  const a = popupTab("a");
  const b = popupTab("b");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => allowed(tab), "pop-ups are allowed for the site");
  BrowserTestUtils.removeTab(await a);
  BrowserTestUtils.removeTab(await b);
  await select(tab);
  await until(() => !bar() && cue() === null, "the bar and the cue are gone");
  Services.perms.removeFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function hide_turns_the_bar_off_and_settings_opens_preferences() {
  const tab = await blockingTab();
  openPicker();
  await pickerShows(5);
  for (let i = 0; i < 3; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => !Services.prefs.getBoolPref("privacy.popups.showBrowserMessage"),
    "the bar is turned off",
  );
  await until(() => !bar() && cue() === null, "the bar and the cue are gone");

  openPicker();
  await pickerShows(4);
  Assert.deepEqual(ids(), ["allow", "popup:0", "popup:1", "settings"]);
  const prefs = BrowserTestUtils.waitForNewTab(gBrowser, (url) =>
    url.startsWith("about:preferences"),
  );
  for (let i = 0; i < 3; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  BrowserTestUtils.removeTab(await prefs);
  Services.prefs.setBoolPref("privacy.popups.showBrowserMessage", true);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_agent_workspace_refuses_and_grants_nothing() {
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  Assert.ok(agent?.userContextId > 0, "the agent workspace has its container");
  const tab = BrowserTestUtils.addTab(gBrowser, BLOCKING, { userContextId: agent.userContextId });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  openPicker();
  await until(
    () => noticeText().includes("pop-ups stay blocked in the agent workspace"),
    "the refusal",
  );
  Assert.ok(!isOpen(), "no picker");
  Assert.ok(!allowed(tab), "no permission");
  BrowserTestUtils.removeTab(tab);
});
