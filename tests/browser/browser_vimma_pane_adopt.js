/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adopting splits made outside Vimma (docs/specs/m4-split-panes.md, sub-spec 6): a split made
// with Firefox's own API (its Browser:AddTabSplitView command, an extension's addTabSplitView, a
// session restore of a Firefox split) becomes the workspace's pane tree: a row in the wrapper's
// order, the shares Firefox's splitter left, focus on the selected tab. The pane keys then work
// on it and it is kept per workspace. A dissolved one closes its panes; a second split in a
// workspace and a split across workspaces (m3-workspaces decision 14) are unsplit, with a notice.

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces, WINDOW_KEY } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves, workspaceOfTab } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";

/** @type {string[]} */
const created = [];
/** @type {Window[]} */
const windows = [];

registerCleanupFunction(async () => {
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/**
 * A browser window's workspaces once they are built, which openWindow waits for.
 * @param {BrowserWindow} win
 */
const live = (win) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));

async function openWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  // VimmaHost starts every new browser window's workspaces.
  const workspaces = () => /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win));
  await workspaces().ready;
  await until(() => !!workspaces().model, "the new window has its workspaces");
  return win;
}

/**
 * Shows workspace `ws` in `win` and returns its selected tab once it is in its container.
 * @param {BrowserWindow} win
 * @param {WorkspaceDefinition} ws
 */
async function show(win, ws) {
  live(win).switchTo({ id: ws.id });
  await until(() => live(win).model.active === ws.id, `${ws.name} shows`);
  await until(() => win.gBrowser.selectedTab.userContextId === ws.userContextId, "its tab");
  return win.gBrowser.selectedTab;
}

/**
 * A loaded background tab of the shown workspace.
 * @param {BrowserWindow} win
 * @param {string} query
 */
async function page(win, query) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${query}`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

/**
 * ctrl+b, then `key`, in `win`.
 * @param {Window} win
 * @param {string} key
 */
function prefix(win, key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, {}, win);
}

/**
 * The window's split view, which VimmaHost made when it started the window.
 * @param {BrowserWindow} win
 */
const view = (win) => /** @type {PaneView} */ (PaneViews.get(win));

/**
 * The window's panes, which a test reads while they are split.
 * @param {BrowserWindow} win
 */
const panesOf = (win) => /** @type {Panes} */ (view(win).panes);

/**
 * The shown tree's tabs in reading order, and the focused pane's tab.
 * @param {BrowserWindow} win
 */
function shown(win) {
  const panes = view(win).panes;
  if (!panes) return { tabs: [], focus: null };
  const order = leaves(panes);
  const byPanel = (/** @type {string} */ id) => win.gBrowser.tabs.find((t) => t.linkedPanel === id);
  return {
    tabs: order.map((l) => byPanel(l.tab)),
    focus: byPanel(order.find((l) => l.pane === panes.focus)?.tab ?? ""),
  };
}

/**
 * The panel rectangle of `tab`, a loaded tab, which has its panel.
 * @param {Window} win
 * @param {MozTabbrowserTab} tab
 */
function rect(win, tab) {
  const panel = win.document.getElementById(/** @type {string} */ (tab.linkedPanel));
  return /** @type {Element} */ (panel).getBoundingClientRect();
}

/** @param {Window} win */
function contentWidth(win) {
  const panels = /** @type {Element} */ (win.document.getElementById("tabbrowser-tabpanels"));
  return panels.getBoundingClientRect().width;
}

/**
 * The notice's text while it shows, else null.
 * @param {Window} win
 */
function notice(win) {
  const n = win.document.getElementById(NOTICE_ID);
  return n?.matches(":popover-open") ? n.textContent : null;
}

/**
 * The workspace (id) of `tab` in `win`'s model.
 * @param {BrowserWindow} win
 * @param {MozTabbrowserTab} tab
 */
function workspaceOf(win, tab) {
  const uuid = SessionStore.getCustomTabValue(tab, "vimma-tab");
  return workspaceOfTab(live(win).model, uuid)?.id;
}

/**
 * Every tab of `tabs` is in one wrapper of just them, and their docshells are active.
 * @param {Window} win
 * @param {MozTabbrowserTab[]} tabs
 * @param {string} what
 */
async function assertLive(win, tabs, what) {
  const wrapper = tabs[0].splitview;
  Assert.ok(
    wrapper && tabs.every((t) => t.splitview === wrapper),
    `${what}: one wrapper holds them`,
  );
  Assert.equal(wrapper?.tabs.length, tabs.length, `${what}: and nothing else`);
  await until(
    () => tabs.every((t) => t.linkedBrowser.docShellIsActive),
    `${what}: every pane's docshell is active`,
  );
}

add_task(async function a_split_made_by_firefox_becomes_panes_the_keys_work_on() {
  const A = workspace("pa-a");
  const B = workspace("pa-b");
  const win = await openWindow();
  await show(win, A);
  const a1 = await page(win, "a1");
  win.gBrowser.selectedTab = a1;

  // Firefox's own entry point (its keyboard shortcut and the URL-bar button run it).
  // A XUL <command>, which getElementById types as an HTML element.
  /** @type {XULElement} */ (
    /** @type {Element} */ (win.document.getElementById("Browser:AddTabSplitView"))
  ).doCommand();
  const other = win.gBrowser.selectedTab;
  Assert.notEqual(other, a1, "Firefox opened and selected its second tab");
  await until(() => shown(win).tabs.length === 2, "the split is adopted");
  Assert.deepEqual(shown(win).tabs, [a1, other], "its tabs side by side, in its order");
  Assert.equal(/** @type {PaneSplit} */ (panesOf(win).root).axis, "x", "as a row");
  Assert.equal(shown(win).focus, other, "focus on the selected tab");
  await assertLive(win, [a1, other], "adopted");
  const half = contentWidth(win) / 2;
  await until(
    () =>
      Math.abs(rect(win, a1).width - half) <= 2 &&
      Math.abs(rect(win, other).width - half) <= 2 &&
      rect(win, a1).right <= rect(win, other).left + 1,
    "laid out by Vimma: two halves, left and right",
  );

  prefix(win, "h");
  await until(() => win.gBrowser.selectedTab === a1, "ctrl+b h selects the left pane");
  Assert.equal(shown(win).focus, a1, "and focuses it");
  prefix(win, "z");
  await until(() => !!panesOf(win).zoom, "ctrl+b z zooms it");
  await until(() => Math.abs(rect(win, a1).width - 2 * half) <= 2, "to the whole width");
  prefix(win, "z");
  await until(() => !panesOf(win).zoom, "and back");

  await show(win, B);
  Assert.equal(view(win).panes, null, "B has no panes");
  await show(win, A);
  Assert.deepEqual(shown(win).tabs, [a1, other], "A's adopted split is kept across switches");
  Assert.equal(shown(win).focus, a1, "with its focus");
  await assertLive(win, [a1, other], "after the switch");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function an_extensions_split_keeps_its_shares_one_per_workspace_and_can_dissolve() {
  const A = workspace("pa-ea");
  const win = await openWindow();
  const gBrowser = win.gBrowser;
  await show(win, A);
  const [t1, t2, t3, t4] = [
    await page(win, "t1"),
    await page(win, "t2"),
    await page(win, "t3"),
    await page(win, "t4"),
  ];
  gBrowser.selectedTab = t2;

  // As an extension would: the public API, and the share Firefox's splitter stores.
  const wrapper = gBrowser.addTabSplitView([t1, t2], { insertBefore: t1 });
  const width = contentWidth(win);
  const panel = /** @type {Element} */ (
    win.document.getElementById(/** @type {string} */ (t1.linkedPanel))
  );
  panel.setAttribute("width", String(Math.round(width * 0.6)));
  await until(() => shown(win).tabs.length === 2, "the extension's split is adopted");
  Assert.equal(t1.splitview, wrapper, "into the same wrapper");
  Assert.deepEqual(shown(win).tabs, [t1, t2], "in its order");
  Assert.equal(shown(win).focus, t2, "focus on the selected tab");
  const ratios = /** @type {PaneSplit} */ (panesOf(win).root).ratios;
  Assert.ok(Math.abs(ratios[0] - 0.6) < 0.01, `the left share is the splitter's (${ratios[0]})`);
  await until(
    () => Math.abs(rect(win, t1).width - rect(win, t2).width * 1.5) <= 3,
    "laid out at 60/40",
  );

  gBrowser.addTabSplitView([t3, t4], { insertBefore: t3 });
  await until(() => !t3.splitview && !t4.splitview, "a second split in the workspace is undone");
  Assert.equal(
    notice(win),
    "split undone: mark tabs in ctrl+b b for another split",
    "the notice says how to make another split",
  );
  Assert.deepEqual(shown(win).tabs, [t1, t2], "the first split is left as it was");
  Assert.equal(gBrowser.selectedTab, t2, "and still shows");

  // Firefox's "separate tabs" (its tab context menu and footer run this).
  /** @type {MozTabSplitViewWrapper} */ (t2.splitview).unsplitTabs("menu_separate");
  await until(() => view(win).panes === null, "a dissolved split closes its panes");
  await until(() => !t1.splitview && !t2.splitview, "and stays dissolved");
  Assert.equal(gBrowser.selectedTab, t2, "the selected tab stays");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_split_across_workspaces_is_undone_with_a_notice() {
  const A = workspace("pa-xa");
  const B = workspace("pa-xb");
  const win = await openWindow();
  const gBrowser = win.gBrowser;
  await show(win, B);
  const b1 = await page(win, "b1");
  await show(win, A);
  const a1 = await page(win, "a1");
  gBrowser.selectedTab = a1;
  Assert.ok(b1.hidden, "B's tab is hidden");

  gBrowser.addTabSplitView([a1, b1], { insertBefore: a1 });
  await until(() => !a1.splitview && !b1.splitview, "the split across workspaces is undone");
  Assert.ok(notice(win)?.includes("different workspaces"), "the notice says why");
  Assert.equal(view(win).panes, null, "no panes");
  Assert.equal(workspaceOf(win, a1), A.id, "a1 stays in A");
  Assert.equal(workspaceOf(win, b1), B.id, "b1 stays in B");
  Assert.ok(b1.hidden && !a1.hidden, "B's tab stays hidden, A's shows");
  Assert.equal(gBrowser.selectedTab, a1, "and selected");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_restored_firefox_split_with_no_saved_panes_is_adopted() {
  const A = workspace("pa-ra");
  const w1 = await openWindow();
  await show(w1, A);
  const r1 = await page(w1, "r1");
  const r2 = await page(w1, "r2");
  w1.gBrowser.selectedTab = r2;
  w1.gBrowser.addTabSplitView([r1, r2], { insertBefore: r1 });
  await until(() => shown(w1).tabs.length === 2, "adopted before the restart");

  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  /**
   * As much of the session's state as the test reads.
   * @type {{ windows: { tabs: { entries: { url: string }[], splitViewId?: number }[],
   *   extData: Record<string, string> }[] }}
   */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?r2`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  Assert.ok(
    winState.tabs.filter((t) => t.splitViewId).length === 2,
    "Firefox saved the split itself",
  );
  // A split Vimma never saw: Firefox's, from a session without Vimma's window value.
  delete winState.extData[WINDOW_KEY];
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  const byQuery = (/** @type {string} */ q) =>
    w2.gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === `${PAGE}?${q}`);
  await until(() => !!byQuery("r1") && !!byQuery("r2"), "both tabs are back");
  // Both found: the wait above saw them.
  const [s1, s2] = /** @type {MozTabbrowserTab[]} */ ([byQuery("r1"), byQuery("r2")]);
  await until(() => shown(w2).tabs.length === 2, "the restored split is adopted");
  Assert.deepEqual(shown(w2).tabs, [s1, s2], "in its order");
  Assert.equal(shown(w2).focus, s2, "focus on the selected tab");
  Assert.equal(w2.gBrowser.selectedTab, s2, "which stays selected");
  await assertLive(w2, [s1, s2], "restored");
  prefix(w2, "h");
  await until(() => w2.gBrowser.selectedTab === s1, "ctrl+b h works on it");
  await BrowserTestUtils.closeWindow(w2);
});
