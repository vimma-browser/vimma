/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-sleep.md, Behaviour 9-13 and decisions 14 and 15 (Delivery slice 2):
// `:sleep`, `:sleep all`, `:sleep N` and the side panel's `z` put tabs to sleep at once, under
// the same rules as the check without its time limit, and say what they did.

"use strict";

/* global add_setup, requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
// A second window, a private one and a second workspace: past the default on a busy runner.
requestLongerTimeout(2);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);

const PAGE = "https://example.com/";
const OTHER_WS = "sleepother";

/** @typedef {MozTabbrowserTab} Tab */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** @param {Tab} t */
const asleep = (t) => !t.linkedPanel || t.hasAttribute("pending");

/** The notice's text, "" without one. @param {BrowserWindow} [win] */
const notice = (win = window) => win.document.getElementById("vimma-notice")?.textContent ?? "";

/** @param {BrowserWindow} [win] */
const ww = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));

/** @type {Tab[]} */
const opened = [];

/**
 * A background tab on `PAGE?name`, loaded and titled `name`.
 * @param {string} name
 * @param {{ win?: BrowserWindow, userContextId?: number }} [options]
 */
async function background(name, { win = window, userContextId } = {}) {
  const url = `${PAGE}?${name}`;
  const t = /** @type {Tab} */ (
    BrowserTestUtils.addTab(win.gBrowser, url, userContextId ? { userContextId } : {})
  );
  opened.push(t);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (title) => {
    content.document.title = title;
  });
  await until(() => t.label === name && !t.hasAttribute("busy"), `${name} is loaded and titled`);
  return t;
}

/**
 * `:line` Enter, typed in `win`, then the notice it leaves, which must be `says`.
 * @param {string} line @param {string} says @param {BrowserWindow} [win]
 */
async function run(line, says, win = window) {
  await SimpleTest.promiseFocus(win);
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
  await until(() => VimmaHost.status(win).mode === "command", "the : line is open");
  EventUtils.sendString(line, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await until(() => notice(win) === says, `:${line} says "${says}"`).catch(() => {});
  Assert.equal(notice(win), says, `:${line} says what it did`);
}

/** @param {Tab} t */
const windowOf = (t) => /** @type {BrowserWindow | null} */ (t.ownerDocument?.defaultView ?? null);

/** The number `{N}gt` gives `t` in this window. @param {Tab} t */
const numberOf = (t) => gBrowser.visibleTabs.indexOf(t) + 1;

function closeOpened() {
  for (const t of opened.splice(0)) {
    const win = windowOf(t);
    if (win && !win.closed && !t.closing && t.parentNode) {
      if (t.pinned) win.gBrowser.unpinTab(t);
      win.gBrowser.removeTab(t);
    }
  }
}

add_setup(async function () {
  await ww().ready;
  registerCleanupFunction(async () => {
    VimmaHost._state(window)?.panel.close();
    closeOpened();
    const other = WorkspaceStore.definitions.workspaces.find((w) => w.name === OTHER_WS);
    if (other) await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
  });
});

add_task(async function sleep_puts_the_workspaces_other_tabs_to_sleep_and_reports_a_reason() {
  const shown = await background("shown");
  await BrowserTestUtils.switchTab(gBrowser, shown);
  const b1 = await background("b1");
  const b2 = await background("b2");
  // Two pages that are not web pages, so that their reason is the most common one.
  for (const url of ["about:robots", "about:mozilla"]) {
    const t = /** @type {Tab} */ (BrowserTestUtils.addTab(gBrowser, url));
    opened.push(t);
    await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
  }
  // Another workspace's tab: not this workspace's, so `:sleep` leaves it.
  if (!WorkspaceStore.definitions.workspaces.some((w) => w.name === OTHER_WS)) {
    WorkspaceStore.newWorkspace(OTHER_WS);
  }
  await until(() => ww().model?.workspaces.some((w) => w.name === OTHER_WS), "a second workspace");
  const def = WorkspaceStore.definitions.workspaces.find((w) => w.name === OTHER_WS);
  const elsewhere = await background("elsewhere", {
    userContextId: /** @type {{ userContextId: number }} */ (def).userContextId,
  });
  await until(() => elsewhere.hidden, "the other workspace's tab is hidden");

  // Every other tab is the shown one or not a web page (the about: pages, the window's first).
  const awake = gBrowser.visibleTabs.length - 2;
  await run("sleep", `2 tabs asleep; ${awake} stay awake: not a web page`);
  Assert.ok(asleep(b1) && asleep(b2), "the background tabs sleep, however recently seen");
  Assert.ok(!asleep(shown), "the shown tab stays loaded");
  Assert.ok(!asleep(elsewhere), "another workspace's tab stays loaded");
  Assert.equal(gBrowser.selectedTab, shown, "the selection did not move");

  // Nothing left to put to sleep: the tabs asleep already are not counted again.
  await run("sleep", `0 tabs asleep; ${awake} stay awake: not a web page`);
  closeOpened();
});

add_task(async function sleep_all_reaches_every_workspace_of_every_window() {
  const shown = await background("all-shown");
  await BrowserTestUtils.switchTab(gBrowser, shown);
  const here = await background("all-here");
  if (!WorkspaceStore.definitions.workspaces.some((w) => w.name === OTHER_WS)) {
    WorkspaceStore.newWorkspace(OTHER_WS);
  }
  await until(() => ww().model?.workspaces.some((w) => w.name === OTHER_WS), "a second workspace");
  const def = WorkspaceStore.definitions.workspaces.find((w) => w.name === OTHER_WS);
  const elsewhere = await background("all-elsewhere", {
    userContextId: /** @type {{ userContextId: number }} */ (def).userContextId,
  });
  const second = await BrowserTestUtils.openNewBrowserWindow();
  await ww(second).ready;
  const there = await background("all-there", { win: second });
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privTab = await background("all-private", { win: priv });

  await SimpleTest.promiseFocus(window);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await until(() => VimmaHost.status(window).mode === "command", "the : line is open");
  EventUtils.sendString("sleep all");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => /^\d+ tabs asleep/.test(notice()), ":sleep all reports");
  Assert.ok(asleep(here), "this workspace's background tab sleeps");
  Assert.ok(asleep(elsewhere), "another workspace's tab sleeps");
  Assert.ok(asleep(there), "another window's background tab sleeps");
  Assert.ok(!asleep(shown), "this window's shown tab stays");
  Assert.ok(!asleep(/** @type {Tab} */ (second.gBrowser.selectedTab)), "so does the other's");
  Assert.ok(!asleep(privTab), "a private window is left alone");

  await BrowserTestUtils.closeWindow(priv);
  await BrowserTestUtils.closeWindow(second);
  closeOpened();
});

// A pinned tab named by its number sleeps too (decision 14): planSleep's "named" mode, in
// tabsleep.test.ts; Vimma unpins a tab pinned while there are several workspaces.
add_task(async function sleep_n_sleeps_that_tab_and_refuses_the_tab_on_screen() {
  const shown = await background("n-shown");
  await BrowserTestUtils.switchTab(gBrowser, shown);
  const named = await background("n-named");
  const n = numberOf(named);
  await run(`sleep ${n}`, `Tab ${n} asleep`);
  Assert.ok(asleep(named), "the tab named by its number sleeps");
  await run(`sleep ${n}`, `Tab ${n} is asleep already`);

  const s = numberOf(shown);
  await run(`sleep ${s}`, `Tab ${s} is on screen`);
  Assert.ok(!asleep(shown), "the tab on screen stays loaded");
  Assert.equal(gBrowser.selectedTab, shown, "and stays selected");

  const count = gBrowser.visibleTabs.length;
  await run("sleep 99", `no tab 99 (this workspace has ${count})`);
  closeOpened();
});

add_task(async function panel_sleep_sleeps_the_highlighted_or_the_marked_tabs() {
  const shown = await background("z-shown");
  await BrowserTestUtils.switchTab(gBrowser, shown);
  const a = await background("z-a");
  const b = await background("z-b");
  const c = await background("z-c");
  const panel = /** @type {HostState} */ (VimmaHost._state(window)).panel;
  /** `t`'s row in the panel, by its title. @param {Tab} t */
  const rowOf = (t) => panel.state?.rows.find((r) => r.display === t.label);
  /** The highlight on `t`'s row, by `j` / `k` from where it is. @param {Tab} t */
  const highlight = async (t) => {
    const want = panel.state?.rows.findIndex((r) => r.display === t.label) ?? -1;
    Assert.greater(want, -1, `the panel lists ${t.label}`);
    const at = () => panel.state?.selected ?? -1;
    while (at() !== want) {
      const from = at();
      EventUtils.synthesizeKey(from < want ? "j" : "k");
      await until(() => at() !== from, "the highlight moved");
    }
  };

  Assert.ok(panel.open(), "the side panel opens");
  await until(() => VimmaHost.status(window).mode === "panel", "panel mode");
  await highlight(a);
  const number = rowOf(a)?.number;
  EventUtils.synthesizeKey("z");
  await until(() => notice() === `Tab ${number} asleep`, "z says the tab is asleep, by its row");
  Assert.ok(asleep(a), "z puts the highlighted tab to sleep");
  Assert.ok(panel.isOpen, "the panel stays open");
  await until(() => rowOf(a)?.asleep, "its row is drawn asleep");
  Assert.equal(
    panel.state?.rows[panel.state.selected]?.display,
    a.label,
    "the highlight stays on it",
  );

  await highlight(b);
  EventUtils.synthesizeKey(" ");
  await highlight(shown);
  EventUtils.synthesizeKey(" ");
  await highlight(c);
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("z");
  await until(
    () => notice() === "2 tabs asleep; 1 stays awake: on screen",
    "z on marks reports them as :sleep does",
  );
  Assert.ok(asleep(b) && asleep(c), "the marked background tabs sleep");
  Assert.ok(!asleep(shown), "the marked tab on screen stays");
  Assert.deepEqual(panel.state?.marked, [], "the marks are spent");
  panel.close();
  closeOpened();
});

add_task(async function sleep_in_a_private_window_says_private_tabs_do_not_sleep() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const t = await background("private", { win: priv });
  await BrowserTestUtils.switchTab(priv.gBrowser, t);
  await SimpleTest.promiseFocus(priv);
  t.linkedBrowser.focus();
  await run("sleep", "Private tabs do not sleep", priv);
  Assert.ok(!asleep(t), "the private tab stays loaded");
  await run("sleep 2", "Private tabs do not sleep", priv);
  Assert.ok(!asleep(t), "named, too");
  await BrowserTestUtils.closeWindow(priv);
});
