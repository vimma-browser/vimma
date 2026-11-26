/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/close-last-tab.md, behaviours 3, 5, 6, 8 and 11 and decisions 7, 9 and 10:
// with several normal windows a value that would quit closes only the window, which reopens with
// its workspaces from ctrl+shift+n; private tabs are asked about before a quit; the private
// workspace's last tab closes the private workspace, never Vimma. Quits are cancelled by a
// `quit-application-requested` observer, as in browser_vimma_close_last_tab.js.

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { CloseLastTab } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/close-last-ops.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

const PAGE = "https://example.com/";
const PICKER_ID = "vimma-workspace-picker";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";

/** @type {number} quits asked for, each cancelled */
let quits = 0;
const quitObserver = (/** @type {nsISupports} */ subject) => {
  quits++;
  subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
};
Services.obs.addObserver(quitObserver, "quit-application-requested");

const def = (/** @type {string} */ name) =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === name,
    )
  );
const ww = (/** @type {BrowserWindow} */ win = window) =>
  /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));

const byId = (/** @type {BrowserWindow} */ win, /** @type {string} */ id) =>
  win.document.getElementById(id);
const picker = (/** @type {BrowserWindow} */ win = window) =>
  /** @type {HTMLDialogElement | null} */ (byId(win, PICKER_ID));
const pickerOpen = (/** @type {BrowserWindow} */ win = window) => !!picker(win)?.open;
const rowNames = (/** @type {BrowserWindow} */ win = window) =>
  [...(picker(win)?.querySelectorAll("[role=option] .vimma-picker-title") ?? [])].map(
    (r) => r.textContent,
  );
const noticeText = (/** @type {BrowserWindow} */ win = window) =>
  byId(win, NOTICE_ID)?.textContent ?? "";
const promptOpen = (/** @type {BrowserWindow} */ win = window) =>
  byId(win, PROMPT_ID)?.hidden === false;
const promptText = (/** @type {BrowserWindow} */ win = window) =>
  (byId(win, PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? "").trim();

function privateWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && PrivateBrowsingUtils.isWindowPrivate(w),
  );
}

registerCleanupFunction(async () => {
  Services.obs.removeObserver(quitObserver, "quit-application-requested");
  CloseLastTab.configure("picker");
  for (const w of [...Services.wm.getEnumerator("navigator:browser")]) {
    if (w !== window && !w.closed) await BrowserTestUtils.closeWindow(w);
  }
  await SimpleTest.promiseFocus(window);
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

const settle = () => new Promise((r) => setTimeout(r, 300));

/**
 * Makes `query`'s page the only shown tab of `win`, focused for keys.
 * @param {BrowserWindow} win @param {string} query
 */
async function onlyTab(win, query) {
  await SimpleTest.promiseFocus(win);
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?${query}`);
  for (const t of [...win.gBrowser.visibleTabs]) if (t !== tab) win.gBrowser.removeTab(t);
  await focusContent(tab.linkedBrowser);
  return tab;
}

/**
 * head.js's focusContent, for a browser in any window.
 * @param {XULBrowserElement} browser
 */
async function focusContent(browser) {
  await SimpleTest.promiseFocus(browser);
  await until(
    () => browser.ownerDocument.activeElement === browser,
    "focus is in the content browser",
  );
  Assert.ok(
    await SpecialPowers.spawn(browser, [], () => content.document.hasFocus()),
    "the page has focus",
  );
}

/**
 * The new tab Firefox opened in `win` in the closed one's place, loaded and focused for keys.
 * @param {BrowserWindow} win
 */
async function focusNewTab(win) {
  const browser = win.gBrowser.selectedBrowser;
  await until(
    () =>
      browser.currentURI?.spec === win.BROWSER_NEW_TAB_URL &&
      !browser.webProgress?.isLoadingDocument,
    "the new tab has loaded",
  );
  await focusContent(browser);
  return win.gBrowser.selectedTab;
}

/**
 * One page in workspace `id` of `win`, which then shows main again: the workspace's start page
 * (an empty workspace opens one) is replaced by the page, so the workspace holds one tab.
 * @param {BrowserWindow} win @param {string} id @param {string} query
 */
async function pageIn(win, id, query) {
  ww(win).switchTo({ id });
  await until(
    () =>
      ww(win).model.active === id &&
      !!ww(win)
        .model.workspaces.find((w) => w.id === id)
        ?.tabs.includes(ww(win).idOf(win.gBrowser.selectedTab)),
    "the workspace is shown, its start page selected",
  );
  const browser = win.gBrowser.selectedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, `${PAGE}?${query}`);
  BrowserTestUtils.startLoadingURIString(browser, `${PAGE}?${query}`);
  await loaded;
  ww(win).switchTo({ id: def("main").id });
  await until(() => ww(win).model.active === def("main").id, "main is shown again");
}

/** @param {MozTabbrowserTab} tab */
const isClosed = (tab) => tab.closing || !tab.isConnected;

/** A second normal window with Vimma's workspaces ready. */
async function secondWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await ww(win).ready;
  return win;
}

/** A private window, the private workspace, with one page. */
async function openPrivate() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await onlyTab(win, "private");
  return win;
}

/** `x` in `win`, waiting for `tab` to close. @param {BrowserWindow} win @param {MozTabbrowserTab} tab */
async function pressX(win, tab) {
  EventUtils.synthesizeKey("x", {}, win);
  await until(() => isClosed(tab), "x closes the last tab");
}

add_task(async function setup() {
  await ww().ready;
  if (!def("other")) WorkspaceStore.newWorkspace("other");
  await until(() => !!def("other"), "a second workspace");
});

// Behaviours 4 and 8: in a window that is not the last normal one, "picker" with nothing else
// in it and "quit" close only that window.
add_task(async function a_window_that_is_not_the_last_closes_and_vimma_stays() {
  for (const value of ["picker", "quit"]) {
    CloseLastTab.configure(/** @type {"picker" | "quit"} */ (value));
    const win = await secondWindow();
    const tab = await onlyTab(win, `close-${value}`);
    const gone = BrowserTestUtils.domWindowClosed(win);
    await pressX(win, tab);
    await gone;
    Assert.equal(quits, 0, `${value}: nothing quit`);
    Assert.ok(!window.closed, `${value}: the first window stays`);
  }
  CloseLastTab.configure("picker");
  await SimpleTest.promiseFocus(window);
});

// Behaviour 3 in another window: the last row closes this window.
add_task(async function picker_in_another_window_offers_close_this_window() {
  const win = await secondWindow();
  await pageIn(win, def("other").id, "other-in-win2");
  const tab = await onlyTab(win, "win2-main");
  await pressX(win, tab);
  await until(() => pickerOpen(win), "the picker opens in win2");
  Assert.deepEqual(rowNames(win), ["other", "close this window"], "the window's rows");
  const gone = BrowserTestUtils.domWindowClosed(win);
  EventUtils.synthesizeKey("j", {}, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await gone;
  Assert.equal(quits, 0, "nothing quit");

  // ctrl+shift+n reopens it with its workspaces (decision 9).
  await SimpleTest.promiseFocus(window);
  await focusContent(gBrowser.selectedBrowser);
  const reopened = BrowserTestUtils.waitForNewWindow();
  EventUtils.synthesizeKey("N", { ctrlKey: true, shiftKey: true });
  const back = /** @type {BrowserWindow} */ (await reopened);
  await ww(back).ready;
  const otherTabs = () =>
    ww(back).model?.workspaces.find((w) => w.id === def("other").id)?.tabs.length ?? 0;
  await until(() => otherTabs() === 1, "the other workspace's tab is back");
  Assert.ok(
    back.gBrowser.tabs.some((t) => t.hidden),
    "hidden, in its workspace, as when the window closed",
  );
  await BrowserTestUtils.closeWindow(back);
  await SimpleTest.promiseFocus(window);
});

// Behaviour 5 in another window.
add_task(async function ask_in_another_window_asks_close_this_window() {
  CloseLastTab.configure("ask");
  const win = await secondWindow();
  await pageIn(win, def("other").id, "ask-other");
  const tab = await onlyTab(win, "ask-win2");
  await pressX(win, tab);
  await until(() => promptOpen(win), "it asks");
  Assert.equal(
    promptText(win),
    "close this window? 1 tab in 1 other workspace goes to the recently closed windows y/N",
  );
  EventUtils.synthesizeKey("n", {}, win);
  await settle();
  Assert.ok(!win.closed, "n keeps the window");
  Assert.equal(win.gBrowser.visibleTabs.length, 1, "with the new tab");

  const fresh = await focusNewTab(win);
  const gone = BrowserTestUtils.domWindowClosed(win);
  await pressX(win, fresh);
  await until(() => promptOpen(win), "it asks again");
  EventUtils.synthesizeKey("y", {}, win);
  await gone;
  Assert.equal(quits, 0, "y closes the window, not Vimma");
  CloseLastTab.configure("picker");
  await SimpleTest.promiseFocus(window);
});

add_task(async function new_tab_and_keep_leave_both_windows_open() {
  for (const value of ["new_tab", "keep"]) {
    CloseLastTab.configure(/** @type {"new_tab" | "keep"} */ (value));
    const win = await secondWindow();
    const tab = await onlyTab(win, `stay-${value}`);
    EventUtils.synthesizeKey("x", {}, win);
    if (value === "new_tab") {
      await until(() => isClosed(tab), "new_tab: the tab closes");
      await until(
        () => win.gBrowser.tabs.length === 1 && !isClosed(win.gBrowser.tabs[0]),
        "a new tab",
      );
    } else {
      await until(() => noticeText(win) === "last tab: not closed", "keep: the notice says so");
      Assert.ok(!isClosed(tab), "keep: the tab stays");
    }
    Assert.ok(!win.closed, `${value}: the window stays`);
    await BrowserTestUtils.closeWindow(win);
  }
  Assert.equal(quits, 0, "nothing quit");
  CloseLastTab.configure("picker");
  await SimpleTest.promiseFocus(window);
});

// Behaviour 9: a window close a page stops (its beforeunload answered "stay", here
// CanCloseWindow's answer) leaves the window with the new tab; a pop-up closes with its last tab.
add_task(async function a_stopped_window_close_keeps_the_new_tab_and_popups_close() {
  CloseLastTab.configure("quit");
  const win = await secondWindow();
  const canClose = win.CanCloseWindow;
  win.CanCloseWindow = () => false;
  const tab = await onlyTab(win, "stopped");
  await pressX(win, tab);
  await until(() => win.gBrowser.tabs.length === 1 && !isClosed(win.gBrowser.tabs[0]), "new tab");
  await settle();
  Assert.ok(!win.closed, "the stopped close keeps the window");
  Assert.equal(quits, 0, "nothing quit");
  win.CanCloseWindow = canClose;
  await BrowserTestUtils.closeWindow(win);

  CloseLastTab.configure("keep");
  await SimpleTest.promiseFocus(window);
  const opener = await onlyTab(window, "opener");
  const popupOpened = BrowserTestUtils.waitForNewWindow();
  await SpecialPowers.pushPrefEnv({ set: [["dom.disable_open_during_load", false]] });
  await SpecialPowers.spawn(opener.linkedBrowser, [`${PAGE}?popup`], (url) => {
    content.open(url, "", "popup,width=400,height=300");
  });
  const popup = /** @type {BrowserWindow} */ (await popupOpened);
  Assert.equal(popup.toolbar.visible, false, "a pop-up without a toolbar");
  await BrowserTestUtils.browserLoaded(popup.gBrowser.selectedBrowser);
  await focusContent(popup.gBrowser.selectedBrowser);
  const gone = BrowserTestUtils.domWindowClosed(popup);
  EventUtils.synthesizeKey("x", {}, popup);
  await gone;
  Assert.ok(popup.closed, '"keep" does not refuse a pop-up\'s close: it closes as in Firefox');
  await SpecialPowers.popPrefEnv();
  CloseLastTab.configure("picker");
  await SimpleTest.promiseFocus(window);
});

// Decision 7: private tabs are asked about before any quit; the private row keeps the new tab.
add_task(async function private_tabs_are_asked_about_and_the_private_row_switches() {
  const priv = await openPrivate();
  const tab = await onlyTab(window, "with-private");
  await pressX(window, tab);
  await until(() => pickerOpen(), "the picker opens: the private tab is the window's other tab");
  Assert.deepEqual(rowNames(), ["◆ private", "quit Vimma"], "the private row, then quit");
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => promptOpen(), "quit Vimma asks first");
  Assert.equal(promptText(), "quit Vimma? 1 private tab is discarded y/N");
  EventUtils.synthesizeKey("y");
  await until(() => quits === 1, "y quits");
  quits = 0;

  const fresh = await focusNewTab(window);
  await pressX(window, fresh);
  await until(() => pickerOpen(), "the picker again");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => Services.focus.activeWindow === priv, "Enter on private goes there");
  Assert.equal(gBrowser.visibleTabs.length, 1, "the normal window keeps the new tab");

  CloseLastTab.configure("quit");
  await SimpleTest.promiseFocus(window);
  const again = await focusNewTab(window);
  await pressX(window, again);
  await until(() => promptOpen(), '"quit" asks when private tabs are open');
  Assert.equal(promptText(), "quit Vimma? 1 private tab is discarded y/N");
  EventUtils.synthesizeKey("n");
  await settle();
  Assert.equal(quits, 0, "n does not quit");
  CloseLastTab.configure("picker");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
});

// Behaviour 11, decision 10.
add_task(async function the_private_workspaces_last_tab_closes_it_not_vimma() {
  CloseLastTab.configure("keep");
  let priv = await openPrivate();
  const kept = priv.gBrowser.selectedTab;
  EventUtils.synthesizeKey("x", {}, priv);
  await until(() => noticeText(priv) === "last tab: not closed", '"keep" refuses in private too');
  Assert.ok(!isClosed(kept), "the private page stays");
  await BrowserTestUtils.closeWindow(priv);

  for (const value of ["picker", "ask", "quit"]) {
    CloseLastTab.configure(/** @type {"picker" | "ask" | "quit"} */ (value));
    priv = await openPrivate();
    const gone = BrowserTestUtils.domWindowClosed(priv);
    await pressX(priv, priv.gBrowser.selectedTab);
    await gone;
    await until(() => privateWindows().length === 0, `${value}: the private workspace closes`);
    Assert.equal(quits, 0, `${value}: Vimma does not quit`);
    Assert.ok(!promptOpen(), `${value}: without a question`);
  }
  CloseLastTab.configure("picker");
  await SimpleTest.promiseFocus(window);
});
