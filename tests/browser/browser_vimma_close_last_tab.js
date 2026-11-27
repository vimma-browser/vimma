/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/close-last-tab.md. `[tabs] close_last` decides what a user close of a
// window's last tab does: "picker" (the default) opens the workspace picker headed `last tab
// closed` when other workspaces hold tabs, and quits when nothing is left; "new_tab" keeps
// Firefox's new tab; "ask" quits after a y/N; "quit" quits; "keep" refuses. Every quit is
// caught here by a `quit-application-requested` observer that cancels it, so the window keeps
// the new tab Firefox opened (behaviour 9). Windows and the private workspace:
// browser_vimma_close_last_tab_windows.js.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { CloseLastTab } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/close-last-ops.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);

const PAGE = "https://example.com/";
const PICKER_ID = "vimma-workspace-picker";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";

/** @type {string[]} the quit sources asked for, each cancelled */
const quits = [];
const quitObserver = (/** @type {nsISupports} */ subject) => {
  quits.push(
    Cc["@mozilla.org/browser/browserglue;1"].getService(Ci.nsISupports).wrappedJSObject._quitSource,
  );
  subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
};
Services.obs.addObserver(quitObserver, "quit-application-requested");

const def = (/** @type {string} */ name) =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === name,
    )
  );
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const active = () => ww().model.active;
const tabsOf = (/** @type {string} */ id) =>
  /** @type {WorkspaceState} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === id)
  ).tabs;

const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
const pickerOpen = () => !!picker()?.open;
const heading = () => picker()?.querySelector("h1")?.textContent ?? "";
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const rowNames = () =>
  rows().map((r) => /** @type {Element} */ (r.querySelector(".vimma-picker-title")).textContent);
const selectedName = () =>
  picker()?.querySelector("[role=option][aria-selected=true] .vimma-picker-title")?.textContent ??
  "";
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
/** The notice's text, emptied so that the next check sees only what comes after. */
const clearNotice = () => {
  const notice = document.getElementById(NOTICE_ID);
  if (notice) notice.textContent = "";
};
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const promptText = () =>
  (
    document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? ""
  ).trim();

registerCleanupFunction(async () => {
  Services.obs.removeObserver(quitObserver, "quit-application-requested");
  CloseLastTab.configure("picker");
  if (pickerOpen()) EventUtils.synthesizeKey("KEY_Escape");
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: def("main").id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (/** @type {WorkspaceDefinition} */ d) =>
      d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** Runs the event loop until what a key set off has run. */
const settle = () => new Promise((r) => setTimeout(r, 300));

/**
 * Makes `query`'s page the only tab of the shown workspace, loaded and focused for keys.
 * @param {string} query
 */
async function onlyTab(query) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${query}`);
  for (const t of [...gBrowser.visibleTabs]) if (t !== tab) gBrowser.removeTab(t);
  await focusContent(tab.linkedBrowser);
  return tab;
}

/** The new tab Firefox opened in the closed one's place, loaded and focused for keys. */
async function focusNewTab() {
  const browser = gBrowser.selectedBrowser;
  await until(
    () =>
      browser.currentURI?.spec === window.BROWSER_NEW_TAB_URL &&
      !browser.webProgress?.isLoadingDocument,
    "the new tab has loaded",
  );
  await focusContent(browser);
  return gBrowser.selectedTab;
}

/** @param {MozTabbrowserTab} tab */
const isClosed = (tab) => tab.closing || !tab.isConnected;

/**
 * `x` on `tab`, the shown workspace's only tab, then waits for it to close.
 * @param {MozTabbrowserTab} tab
 */
async function closeWithX(tab) {
  EventUtils.synthesizeKey("x");
  await until(() => isClosed(tab), "x closes the last tab");
}

/** The workspace `name` with `n` tabs, made once; the window stays on main. */
async function workspaceWithTabs(/** @type {string} */ name, n = 2) {
  if (!def(name)) WorkspaceStore.newWorkspace(name);
  await until(() => ww().model.workspaces.some((w) => w.name === name), `${name} is listed`);
  const id = def(name).id;
  if (tabsOf(id).length < n) {
    ww().switchTo({ id });
    await until(() => active() === id, `in ${name}`);
    while (tabsOf(id).length < n) {
      await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${name}${tabsOf(id).length}`);
    }
  }
  ww().switchTo({ id: def("main").id });
  await until(() => active() === def("main").id, "back in main");
  return id;
}

/** Closes every tab of workspace `name`, which stays as an empty workspace. */
async function emptyWorkspace(/** @type {string} */ name) {
  const id = def(name)?.id;
  if (!id) return;
  for (const tabId of [...tabsOf(id)]) {
    const tab = ww().tabOf(tabId);
    if (tab) gBrowser.removeTab(tab);
  }
  await until(() => tabsOf(id).length === 0, `${name} has no tabs`);
}

add_task(async function setup() {
  await ww().ready;
  Assert.equal(CloseLastTab.setting, "picker", 'the default is "picker" (decision 2)');
});

// Behaviour 3: the picker lists the window's other workspaces with tabs, then quit Vimma.
add_task(async function picker_lists_the_workspaces_with_tabs_and_enter_switches() {
  const other = await workspaceWithTabs("other", 2);
  if (!def("empty")) WorkspaceStore.newWorkspace("empty");
  await until(() => !!def("empty"), "an empty workspace exists");
  const tab = await onlyTab("picker");
  const main = active();
  await closeWithX(tab);
  await until(pickerOpen, "the workspace picker opens");
  Assert.equal(heading(), "last tab closed", "headed last tab closed");
  Assert.deepEqual(rowNames(), ["other", "quit Vimma"], "only workspaces with tabs, then quit");
  Assert.equal(selectedName(), "other", "the first workspace is selected");
  const otherRow = /** @type {Element} */ (rows()[0]);
  Assert.equal(otherRow.querySelector(".vimma-picker-index")?.textContent, "2", "its number");
  Assert.equal(otherRow.querySelector(".vimma-picker-host")?.textContent, "2 tabs", "its count");
  Assert.equal(active(), main, "still in main, on the new tab");
  Assert.equal(tabsOf(main).length, 1, "main holds the new tab");
  const fresh = gBrowser.selectedTab;

  EventUtils.synthesizeKey("m");
  await settle();
  Assert.ok(pickerOpen(), "m is not offered: the picker stays open");

  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => active() === other, "Enter switches to other");
  await until(() => isClosed(fresh), "and closes the new tab");
  Assert.equal(tabsOf(main).length, 0, "main is left with no tabs");
  Assert.equal(heading(), "Workspaces", "the picker's heading is back for prefix+w");
  Assert.deepEqual(quits, [], "nothing quit");
  ww().switchTo({ id: main });
  await until(() => tabsOf(main).length === 1, "going back to main opens its start page");
});

add_task(async function picker_esc_keeps_the_new_tab_and_the_quit_row_quits() {
  await workspaceWithTabs("other", 2);
  const main = def("main").id;
  const tab = await onlyTab("esc");
  await closeWithX(tab);
  await until(pickerOpen, "the picker opens");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !pickerOpen(), "Esc closes it");
  Assert.equal(active(), main, "still in main");
  Assert.equal(tabsOf(main).length, 1, "the new tab stays");
  Assert.deepEqual(quits, [], "Esc never quits");

  // Closing that new tab again opens the picker again; q closes it as Esc does.
  const fresh = await focusNewTab();
  await closeWithX(fresh);
  await until(pickerOpen, "the picker opens again");
  EventUtils.synthesizeKey("q");
  await until(() => !pickerOpen(), "q closes it");
  Assert.deepEqual(quits, [], "q never quits");

  const again = await focusNewTab();
  await closeWithX(again);
  await until(pickerOpen, "the picker opens a third time");
  EventUtils.synthesizeKey("j");
  Assert.equal(selectedName(), "quit Vimma", "j goes to the quit row");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => quits.length === 1, "Enter on quit Vimma quits");
  Assert.ok(!promptOpen(), "without another question");
  Assert.equal(quits[0], "OS", "not as the shortcut, so Firefox asks nothing more (decision 6)");
  Assert.equal(tabsOf(main).length, 1, "the cancelled quit leaves the new tab (behaviour 9)");
  quits.length = 0;
});

// Behaviour 4: no other tab anywhere, so closing the last one quits.
add_task(async function picker_quits_when_nothing_else_is_open() {
  await emptyWorkspace("other");
  const tab = await onlyTab("alone");
  await closeWithX(tab);
  await until(() => quits.length === 1, "the close quits");
  Assert.ok(!pickerOpen(), "no picker");
  Assert.ok(!promptOpen(), "no question");
  Assert.equal(gBrowser.visibleTabs.length, 1, "the cancelled quit leaves the new tab");
  quits.length = 0;
});

add_task(async function new_tab_is_todays_new_tab() {
  CloseLastTab.configure("new_tab");
  await workspaceWithTabs("other", 2);
  const tab = await onlyTab("newtab");
  await closeWithX(tab);
  await settle();
  Assert.ok(!pickerOpen() && !promptOpen(), "neither picker nor question");
  Assert.deepEqual(quits, [], "nothing quit");
  Assert.equal(gBrowser.visibleTabs.length, 1, "a new tab in its place");
  Assert.equal(active(), def("main").id, "in the same workspace");
  CloseLastTab.configure("picker");
});

// Behaviour 5.
add_task(async function ask_asks_when_other_workspaces_hold_tabs() {
  CloseLastTab.configure("ask");
  await workspaceWithTabs("other", 2);
  const tab = await onlyTab("ask");
  await closeWithX(tab);
  await until(promptOpen, "it asks");
  Assert.equal(
    promptText(),
    "quit Vimma? 2 tabs in 1 other workspace come back at the next start y/N",
    "with the other workspaces' counts",
  );
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers");
  await settle();
  Assert.deepEqual(quits, [], "n does not quit");
  Assert.equal(gBrowser.visibleTabs.length, 1, "and leaves the new tab");

  const fresh = await focusNewTab();
  await closeWithX(fresh);
  await until(promptOpen, "it asks again");
  EventUtils.synthesizeKey("y");
  await until(() => quits.length === 1, "y quits");
  quits.length = 0;

  await emptyWorkspace("other");
  const last = await onlyTab("ask-alone");
  await closeWithX(last);
  await until(() => quits.length === 1, "with nothing else open it quits");
  Assert.ok(!promptOpen(), "without a question");
  quits.length = 0;
  CloseLastTab.configure("picker");
});

// Behaviour 6.
add_task(async function quit_quits_without_a_question() {
  CloseLastTab.configure("quit");
  await workspaceWithTabs("other", 2);
  const tab = await onlyTab("quit");
  await closeWithX(tab);
  await until(() => quits.length === 1, "the close quits");
  Assert.ok(!promptOpen() && !pickerOpen(), "without a question or the picker");
  quits.length = 0;
  CloseLastTab.configure("picker");
});

// Behaviour 7.
add_task(async function keep_refuses_the_last_tab_only() {
  CloseLastTab.configure("keep");
  const tab = await onlyTab("keep");
  EventUtils.synthesizeKey("x");
  await until(() => noticeText() === "last tab: not closed", "the notice says so");
  Assert.ok(!isClosed(tab), "the page stays open");
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?second`);
  await focusContent(second.linkedBrowser);
  await closeWithX(second);
  Assert.ok(!isClosed(tab), "a tab that is not the last closes as always");
  Assert.deepEqual(quits, [], "nothing quit");
  CloseLastTab.configure("picker");
});

// Decision 11: every user close key follows the setting; "keep" shows it without a quit.
add_task(async function every_user_close_follows_the_setting() {
  CloseLastTab.configure("keep");
  const tab = await onlyTab("keys");

  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("x");
  await until(() => noticeText() === "last tab: not closed", "ctrl+b x (pane.close)");
  Assert.ok(!isClosed(tab), "pane.close keeps it");

  clearNotice();
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("q");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === "last tab: not closed", ":q");
  Assert.ok(!isClosed(tab), ":q keeps it");

  clearNotice();
  await focusContent(tab.linkedBrowser);
  VimmaControl._commands["send-keys"]({ keys: "x" });
  await until(() => noticeText() === "last tab: not closed", "the full role's send-keys x");
  Assert.ok(!isClosed(tab), "send-keys keeps it");

  CloseLastTab.configure("picker");
  await workspaceWithTabs("other", 1);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("b");
  await until(() => document.getElementById("vimma-panel")?.hidden === false, "the side panel");
  EventUtils.synthesizeKey("x");
  await until(() => isClosed(tab), "x in the side panel closes the tab");
  await until(pickerOpen, "and opens the picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !pickerOpen(), "Esc");
  if (document.getElementById("vimma-panel")?.hidden === false) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  Assert.deepEqual(quits, [], "nothing quit");
});

// Behaviour 12: a close that is not the user's never quits, opens the picker or is refused.
add_task(async function closes_that_are_not_the_users_keep_firefoxs_behaviour() {
  await emptyWorkspace("other");
  await SpecialPowers.pushPrefEnv({ set: [["dom.allow_scripts_to_close_windows", true]] });
  const tab = await onlyTab("script");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.close());
  await until(() => isClosed(tab), "the page's window.close() closes it");
  await settle();
  Assert.ok(!pickerOpen() && !promptOpen(), "no picker, no question");
  Assert.deepEqual(quits, [], "no quit");
  Assert.equal(gBrowser.visibleTabs.length, 1, "Firefox's new tab");
  await SpecialPowers.popPrefEnv();

  // The tab context menu's Close Tab: not refused by "keep", Firefox's new tab instead.
  CloseLastTab.configure("keep");
  clearNotice();
  const other = await onlyTab("contextmenu");
  const menu = /** @type {{ contextTab: MozTabbrowserTab, closeContextTabs(): void }} */ (
    /** @type {{ TabContextMenu: unknown }} */ (/** @type {unknown} */ (window)).TabContextMenu
  );
  menu.contextTab = other;
  menu.closeContextTabs();
  await until(() => isClosed(other), "the context menu closes it");
  await settle();
  Assert.notEqual(noticeText(), "last tab: not closed", "it is not refused");
  Assert.ok(!pickerOpen(), "no picker");
  Assert.equal(gBrowser.visibleTabs.length, 1, "Firefox's new tab");
  Assert.deepEqual(quits, [], "no quit");
  CloseLastTab.configure("picker");
});
