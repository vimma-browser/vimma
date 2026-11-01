/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/popup-blocked.md. Firefox's "pop-up blocked" bar is answered as Vimma's other
// browser questions are: `y` allows the site, `n` blocks it, Esc closes the bar, with the
// permission prompt's guards (armed after security.notification_enable_delay with no key in
// between, never from a field or the command line). The status bar names the keys. :popups opens
// a picker over the bar's other options (open one pop-up, stop showing the bar, settings), run
// through Firefox's PopupAndRedirectBlockerObserver. Nothing blocked: a notice. In the agent
// workspace no key answers the bar and the picker refuses: nothing is granted (docs/security.md
// M10). A mistaken n is undone from :popups, without the bar: allow the site, or reset it.

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
const DELAY = 400;
const UNARMED = "pop-up blocked";
const CUE = "pop-up blocked · y allow · n block · Esc close";
const FIELD_CUE = "pop-up blocked · Esc, then y allow · n block";
const UNDO_CUE = "pop-ups blocked · :popups to allow";

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

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const openPicker = () => {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("popups");
  EventUtils.synthesizeKey("KEY_Enter");
};

const cmdlineOpen = () => {
  const el = document.getElementById("vimma-cmdline");
  return !!el && !el.hidden;
};

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

const permission = (tab) =>
  Services.perms.testPermissionFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup");
const allowed = (tab) => permission(tab) === Services.perms.ALLOW_ACTION;
const forget = (tab) =>
  Services.perms.removeFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup");

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
      // The test profile turns the delay off; the keys' wait is under test.
      ["security.notification_enable_delay", DELAY],
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
  await until(() => cue() === CUE, "the status bar names the keys");
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
  await until(isOpen, ":popups opens the picker");
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

  await select(tab);
  openPicker();
  await until(isOpen, "it opens again");
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
  forget(tab);
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

add_task(async function y_answers_only_once_the_bar_is_armed_and_allows_the_site() {
  const tab = await blockingTab();
  await until(() => cue() === UNARMED, "no keys named before the bar is armed");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 4);
  Assert.ok(bar() && !allowed(tab), "y before the bar is armed answers nothing");
  await until(() => cue() === CUE, "the keys are named once it is armed");
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("y");
  await wait(DELAY / 4);
  Assert.ok(bar() && !allowed(tab), "a key typed on through the bar starts the wait again");
  await until(() => cue() === CUE, "armed again");

  const a = popupTab("a");
  const b = popupTab("b");
  EventUtils.synthesizeKey("y");
  await until(() => allowed(tab), "y allows pop-ups for the site");
  BrowserTestUtils.removeTab(await a);
  BrowserTestUtils.removeTab(await b);
  await select(tab);
  await until(() => !bar() && cue() === null, "Firefox opened them and closed the bar");
  forget(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function n_blocks_the_site_and_esc_only_closes_the_bar() {
  let tab = await blockingTab();
  await until(() => cue() === CUE, "armed");
  EventUtils.synthesizeKey("n");
  await until(() => !bar() && cue() === null, "n closes the bar");
  Assert.equal(permission(tab), Services.perms.DENY_ACTION, "and blocks pop-ups for the site");
  forget(tab);
  BrowserTestUtils.removeTab(tab);

  tab = await blockingTab();
  await until(() => cue() === CUE, "armed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !bar() && cue() === null, "Esc closes the bar");
  Assert.equal(permission(tab), Services.perms.UNKNOWN_ACTION, "and changes no permission");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function keys_typed_in_a_field_or_the_command_line_are_theirs() {
  const tab = await blockingTab();
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.id = "vimma-popups-field";
    content.document.body.append(input);
    input.focus();
  });
  await until(() => cue() === FIELD_CUE, "from a field the keys line starts with the way out");
  EventUtils.synthesizeKey("y");
  EventUtils.synthesizeKey("n");
  EventUtils.synthesizeKey("KEY_Escape");
  const typed = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("vimma-popups-field").value,
  );
  Assert.equal(typed, "yn", "y and n were typed in the field");
  Assert.ok(bar(), "and Esc left the field, not the bar");
  Assert.equal(permission(tab), Services.perms.UNKNOWN_ACTION, "nothing decided");

  // The command line, once the bar is armed: its keys are its own.
  await until(() => cue() === CUE, "armed outside the field");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await until(cmdlineOpen, "the command line opens");
  EventUtils.sendString("yn");
  await wait(DELAY + 100);
  Assert.equal(document.getElementById("vimma-cmdline-input").value, "yn", "typed there");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !cmdlineOpen(), "Esc closes the command line");
  Assert.ok(bar(), "and not the bar");
  Assert.equal(permission(tab), Services.perms.UNKNOWN_ACTION, "nothing decided");

  await until(() => cue() === CUE, "armed again");
  const a = popupTab("a");
  const b = popupTab("b");
  EventUtils.synthesizeKey("y");
  await until(() => allowed(tab), "y in normal mode allows the site");
  BrowserTestUtils.removeTab(await a);
  BrowserTestUtils.removeTab(await b);
  forget(tab);
  await select(tab);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function popups_undoes_n_without_the_bar() {
  const blocking = await blockingTab();
  await until(() => cue() === CUE, "armed");
  EventUtils.synthesizeKey("n");
  await until(() => !bar(), "n closes the bar");
  await until(() => cue() === UNDO_CUE, "the status bar says how to undo it");
  BrowserTestUtils.removeTab(blocking);

  // The same site, nothing blocked and no bar: :popups opens for the site's permission.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await until(() => cue() === UNDO_CUE, "the site's block shows on its other pages");
  openPicker();
  await pickerShows(3);
  Assert.deepEqual(ids(), ["allow", "reset", "settings"]);
  Assert.equal(title(rows()[0]), "Allow pop-ups for example.com");
  Assert.equal(title(rows()[1]), "Reset pop-ups for example.com to default");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => allowed(tab), "allowed again");
  await until(() => cue() === null, "no cue for an allowed site");

  openPicker();
  await pickerShows(2);
  Assert.deepEqual(ids(), ["block", "settings"]);
  Assert.equal(title(rows()[0]), "Block pop-ups for example.com");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => permission(tab) === Services.perms.DENY_ACTION, "blocked again");
  await until(() => cue() === UNDO_CUE, "and the way to undo it");

  openPicker();
  await pickerShows(3);
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => permission(tab) === Services.perms.UNKNOWN_ACTION,
    "reset removes the site's permission",
  );
  await until(() => cue() === null, "back to the default: no cue");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_agent_workspace_refuses_and_grants_nothing() {
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  Assert.ok(agent?.userContextId > 0, "the agent workspace has its container");
  const tab = BrowserTestUtils.addTab(gBrowser, BLOCKING, { userContextId: agent.userContextId });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  await until(() => !!bar(), "Firefox shows the bar");
  // A block on the agent's site: nothing here may turn it into an allow, or reset it.
  const DENY = Services.perms.DENY_ACTION;
  Services.perms.addFromPrincipal(tab.linkedBrowser.contentPrincipal, "popup", DENY);
  await until(() => cue() === UNARMED, "the cue names no key");
  await wait(DELAY + 100);
  for (const key of ["y", "KEY_Escape", "n", "KEY_Escape"]) {
    EventUtils.synthesizeKey(key);
    await wait(DELAY + 100);
  }
  Assert.ok(bar(), "no key answers the bar");
  Assert.equal(permission(tab), DENY, "y and n decide nothing");
  openPicker();
  await until(
    () => noticeText().includes("pop-ups stay blocked in the agent workspace"),
    "the refusal",
  );
  Assert.ok(!isOpen(), "no picker, so no row to allow or reset the site");
  Assert.equal(permission(tab), DENY, "the permission is as it was");
  bar().dismiss();
  await until(() => !bar(), "the bar closed");
  Assert.equal(cue(), null, "no way to allow is named in the agent workspace");
  openPicker();
  await wait(DELAY);
  Assert.ok(!isOpen(), "still no picker without the bar");
  Assert.equal(permission(tab), DENY, "nothing granted");
  BrowserTestUtils.removeTab(tab);
});
