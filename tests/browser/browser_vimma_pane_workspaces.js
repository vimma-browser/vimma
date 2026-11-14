/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Panes per workspace and restore (docs/specs/m4-split-panes.md, sub-spec 6): each workspace keeps
// its own pane layout and focused pane across ctrl+b ) / ctrl+b (, and a switch leaves the other
// workspace's layout alone; a session restore brings back every workspace's layout (the shown
// one and the parked ones) and focus. A tab picked from outside the split shows alone and the
// split waits as a hidden view until one of its tabs is picked; a new foreground tab still opens in
// the focused pane (docs/specs/side-panel-unsplit.md decisions 20-24).

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";

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

/**
 * As much of the session's state as the tests read (SessionStore.getBrowserState).
 * @typedef {{ windows: { tabs: { entries: { url: string }[] }[] }[] }} SavedState
 */

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

/**
 * The window's split view, which VimmaHost made when it started the window.
 * @param {BrowserWindow} win
 */
const view = (win) => /** @type {PaneView} */ (PaneViews.get(win));

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
 * Switches `win` to workspace `to` with ctrl+b ) or ctrl+b (, and waits for it.
 * @param {BrowserWindow} win
 * @param {string} key
 * @param {WorkspaceDefinition} to
 */
async function press(win, key, to) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, { shiftKey: true }, win);
  const shown = () => live(win).model.active === to.id;
  await until(shown, `ctrl+b ${key} shows ${to.name}`);
}

/**
 * A loaded background tab of the active workspace; a loaded tab has its panel.
 * @param {BrowserWindow} win
 * @param {string} query
 */
async function page(win, query) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${query}`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return /** @type {SplitTab} */ (tab);
}

/**
 * The window's selected tab once it is in workspace `ws`'s container (a fresh start tab).
 * @param {BrowserWindow} win
 * @param {WorkspaceDefinition} ws
 */
async function startTab(win, ws) {
  await until(() => win.gBrowser.selectedTab.userContextId === ws.userContextId, "a start tab");
  return /** @type {SplitTab} */ (win.gBrowser.selectedTab);
}

/** @typedef {{ left: number, top: number, width: number, height: number }} Rect */

/**
 * The panel rectangle of `tab`.
 * @param {Window} win
 * @param {MozTabbrowserTab} tab
 * @returns {Rect}
 */
function rect(win, tab) {
  const panel = win.document.getElementById(/** @type {string} */ (tab.linkedPanel));
  const r = /** @type {Element} */ (panel).getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** @param {Window} win @param {MozTabbrowserTab[]} tabs */
function rects(win, tabs) {
  return tabs.map((t) => rect(win, t));
}

/**
 * Whether `now` matches `before`, each edge within 1 px.
 * @param {Rect[]} now
 * @param {Rect[]} before
 */
function near(now, before) {
  return now.every((r, i) =>
    /** @type {(keyof Rect)[]} */ (["left", "top", "width", "height"]).every(
      (p) => Math.abs(r[p] - before[i][p]) <= 1,
    ),
  );
}

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
 * Labels for messages: the tabs' URLs' queries.
 * @param {(MozTabbrowserTab | undefined)[]} tabs
 */
function names(tabs) {
  return tabs.map((t) => t?.linkedBrowser.currentURI.spec.split("?")[1] ?? "start").join(",");
}

/**
 * A: an L shape, start | (a1 / a2), with the left pane focused; B: b0 / b1, the lower pane
 * focused. Built in `win`, which ends showing `end`.
 * @param {BrowserWindow} win
 * @param {WorkspaceDefinition} A
 * @param {WorkspaceDefinition} B
 */
async function twoLayouts(win, A, B) {
  const view = /** @type {PaneView} */ (PaneViews.get(win));
  live(win).switchTo({ id: A.id });
  const a0 = await startTab(win, A);
  const a1 = await page(win, "a1");
  const a2 = await page(win, "a2");
  Assert.ok(view.split("vertical", { tab: a1 }).ok, "A: start | a1");
  Assert.ok(view.split("horizontal", { tab: a2 }).ok, "A: a1 / a2");
  view.focus("left");
  Assert.equal(win.gBrowser.selectedTab, a0, "A: the left pane is focused");
  a0.linkedBrowser.focus();
  await until(() => win.document.activeElement === a0.linkedBrowser, "A: its page has focus");

  live(win).switchTo({ id: B.id });
  const b0 = await startTab(win, B);
  const b1 = await page(win, "b1");
  Assert.ok(view.split("horizontal", { tab: b1 }).ok, "B: b0 / b1");
  Assert.equal(win.gBrowser.selectedTab, b1, "B: the lower pane is focused");
  return { a: [a0, a1, a2], b: [b0, b1] };
}

/**
 * Every tab of `tabs` is in one wrapper, active, and laid out (non-empty rects).
 * @param {Window} win
 * @param {MozTabbrowserTab[]} tabs
 * @param {string} what
 */
async function assertLive(win, tabs, what) {
  const wrapper = tabs[0].splitview;
  Assert.ok(wrapper, `${what}: in a split view`);
  Assert.ok(
    tabs.every((t) => t.splitview === wrapper),
    `${what}: one wrapper holds ${names(tabs)}`,
  );
  Assert.equal(wrapper.tabs.length, tabs.length, `${what}: and nothing else`);
  Assert.ok(!wrapper.hidden, `${what}: the wrapper shows`);
  await until(
    () => tabs.every((t) => t.linkedBrowser.docShellIsActive),
    `${what}: every pane's docshell is active`,
  );
}

add_task(async function each_workspace_keeps_its_panes_and_focus_across_switches() {
  const A = workspace("pw-a");
  const B = workspace("pw-b");
  const win = await openWindow();
  const { a, b } = await twoLayouts(win, A, B);
  const [a0] = a;
  const [, b1] = b;
  await until(() => b.every((t) => rect(win, t).width > 100), "B is laid out");
  const bRects = rects(win, b);

  await press(win, "(", A);
  Assert.deepEqual(names(shown(win).tabs), names(a), "A's three panes come back, in order");
  Assert.equal(shown(win).focus, a0, "with A's focused pane");
  Assert.equal(win.gBrowser.selectedTab, a0, "whose tab is selected");
  await assertLive(win, a, "A");
  Assert.ok(
    b.every((t) => t.hidden) && /** @type {MozTabSplitViewWrapper} */ (b[0].splitview).hidden,
    "B's split hides as a whole",
  );
  await until(() => win.document.activeElement === a0.linkedBrowser, "A's focused page has focus");
  await until(() => a.every((t) => rect(win, t).width > 100), "A is laid out");
  const aRects = rects(win, a);
  Assert.ok(
    aRects[0].height > aRects[1].height + 100 && Math.abs(aRects[1].left - aRects[2].left) <= 1,
    "A is an L shape: the start page full height, a1 over a2",
  );

  await press(win, ")", B);
  Assert.deepEqual(names(shown(win).tabs), names(b), "B's two panes are unaffected");
  Assert.equal(shown(win).focus, b1, "and keep their focus");
  Assert.equal(win.gBrowser.selectedTab, b1, "B's focused tab is selected");
  await until(() => win.document.activeElement === b1.linkedBrowser, "B's focused page has focus");
  await assertLive(win, b, "B");
  Assert.ok(
    a.every((t) => t.hidden),
    "A's tabs hide",
  );
  await until(() => near(rects(win, b), bRects), "B's rectangles are back (±1 px)");

  await press(win, "(", A);
  await until(() => near(rects(win, a), aRects), "A's rectangles are back too (±1 px)");
  Assert.equal(win.gBrowser.selectedTab, a0, "and A's focus");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_session_restore_brings_back_every_workspaces_layout_and_focus() {
  const A = workspace("pw-ra");
  const B = workspace("pw-rb");
  const w1 = await openWindow();
  const { a, b } = await twoLayouts(w1, A, B);
  live(w1).switchTo({ id: A.id });
  await until(() => w1.gBrowser.selectedTab === a[0], "A shows, its left pane focused");
  await until(() => a.every((t) => rect(w1, t).width > 100), "A is laid out");
  const aRects = rects(w1, a);
  live(w1).switchTo({ id: B.id });
  await until(() => b.every((t) => rect(w1, t).width > 100), "B is laid out");
  const bRects = rects(w1, b);
  live(w1).switchTo({ id: A.id });
  await until(() => w1.gBrowser.selectedTab === a[0], "A shows again; B is parked");

  const uuid = (/** @type {Element} */ t) => SessionStore.getCustomTabValue(t, "vimma-tab");
  const aIds = a.map(uuid);
  const bIds = b.map(uuid);
  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  /** @type {SavedState} */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?b1`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  const byUuid = (/** @type {string} */ u) => w2.gBrowser.tabs.find((t) => uuid(t) === u);
  // The restore is done (SSWindowRestored): every saved tab is back.
  const ra = /** @type {MozTabbrowserTab[]} */ (aIds.map(byUuid));
  const rb = /** @type {MozTabbrowserTab[]} */ (bIds.map(byUuid));

  Assert.equal(live(w2).model.active, A.id, "A is the shown workspace");
  Assert.deepEqual(names(shown(w2).tabs), names(ra), "A's L shape is adopted");
  Assert.equal(shown(w2).focus, ra[0], "with its left pane focused");
  Assert.equal(w2.gBrowser.selectedTab, ra[0], "and selected");
  await assertLive(w2, ra, "restored A");
  await until(() => near(rects(w2, ra), aRects), "A's rectangles (±1 px)");

  await press(w2, ")", B);
  Assert.deepEqual(names(shown(w2).tabs), names(rb), "B's parked layout is adopted too");
  Assert.equal(shown(w2).focus, rb[1], "with its lower pane focused");
  Assert.equal(w2.gBrowser.selectedTab, rb[1], "and selected");
  await assertLive(w2, rb, "restored B");
  await until(() => near(rects(w2, rb), bRects), "B's rectangles (±1 px)");
  Assert.ok(
    ra.every((t) => t.hidden),
    "A's split is hidden",
  );

  await BrowserTestUtils.closeWindow(w2);
});

/** The view's tree is kept but not shown (side-panel-unsplit decision 20). */
const isHiddenView = (/** @type {BrowserWindow} */ win) => view(win).panes?.hidden === true;

add_task(async function a_tab_picked_from_outside_the_split_shows_alone_and_the_split_waits() {
  const A = workspace("pw-sa");
  const B = workspace("pw-sb");
  const win = await openWindow();
  const view = /** @type {PaneView} */ (PaneViews.get(win));
  const gB = win.gBrowser;
  live(win).switchTo({ id: B.id });
  const b0 = await startTab(win, B);
  live(win).switchTo({ id: A.id });
  const a0 = await startTab(win, A);
  const a1 = await page(win, "a1");
  const a2 = await page(win, "a2");
  Assert.ok(view.split("vertical", { tab: a1 }).ok, "A: start | a1, a1 focused");
  await assertLive(win, [a0, a1], "the split");
  await until(() => rect(win, a1).width > 100, "laid out");
  const before = rects(win, [a0, a1]);

  // As the picker, ctrl+tab or switch-to-tab would: a tab of A that no pane shows.
  gB.selectedTab = a2;
  Assert.ok(isHiddenView(win), "the split is kept as a hidden view");
  Assert.deepEqual(names(shown(win).tabs), names([a0, a1]), "with its panes");
  Assert.equal(shown(win).focus, a1, "and its focused pane");
  Assert.equal(gB.selectedTab, a2, "a2 is selected");
  Assert.ok(!a2.splitview, "a2 joined no split");
  Assert.ok(a1.splitview && a1.splitview === a0.splitview, "the split's tabs stay together");
  await until(
    () => !a0.linkedBrowser.docShellIsActive && !a1.linkedBrowser.docShellIsActive,
    "the hidden panes' docshells go inactive",
  );
  await until(() => rect(win, a2).width > rect(win, a1).width, "a2 fills the content area");

  // Picking a pane's tab brings the whole view back, focused there, at its sizes.
  gB.selectedTab = a0;
  Assert.ok(!isHiddenView(win), "the view shows again");
  Assert.equal(shown(win).focus, a0, "focused on a0's pane");
  await assertLive(win, [a0, a1], "the view back");
  // Across: Firefox shows the bookmarks toolbar over a new-tab page (a0), which moves the top.
  await until(
    () =>
      rects(win, [a0, a1]).every(
        (r, i) =>
          Math.abs(r.left - before[i].left) <= 1 && Math.abs(r.width - before[i].width) <= 1,
      ),
    "at its sizes (±1 px across)",
  );

  // A new foreground tab (a link, ctrl+t) still opens in the focused pane (decision 22).
  const fresh = await BrowserTestUtils.openNewForegroundTab(gB, `${PAGE}?fresh`);
  Assert.ok(!isHiddenView(win), "the view stays shown");
  Assert.deepEqual(names(shown(win).tabs), names([fresh, a1]), "fresh takes a0's pane");
  Assert.ok(!a0.hidden && !a0.closing, "a0 stays a tab of A");
  gB.selectedTab = a0;
  Assert.ok(isHiddenView(win), "picking a0, now outside the view, shows it alone");
  gB.selectedTab = fresh;
  Assert.ok(!isHiddenView(win), "and fresh brings the view back");

  // Another workspace's tab switches workspaces (m3 2b); A's tree is left as it was.
  gB.selectedTab = b0;
  await until(() => live(win).model.active === B.id, "selecting b0 switches to B");
  Assert.equal(view.panes, null, "B shows one pane");
  Assert.ok(!b0.splitview, "b0 joined no split");
  await press(win, "(", A);
  Assert.deepEqual(names(shown(win).tabs), names([fresh, a1]), "A's panes are untouched");
  Assert.ok(!isHiddenView(win), "and shown");

  // A hidden view survives a workspace switch: A comes back with a2 alone, the view hidden.
  gB.selectedTab = a2;
  Assert.ok(isHiddenView(win), "a2 alone, the view hidden");
  await press(win, ")", B);
  await press(win, "(", A);
  Assert.equal(gB.selectedTab, a2, "A comes back on a2");
  Assert.ok(isHiddenView(win), "with its view still hidden");
  gB.selectedTab = a1;
  Assert.ok(!isHiddenView(win), "a1 brings it back");
  await assertLive(win, [fresh, a1], "the view after the switch");

  // A pinned tab is in every workspace and cannot join a split: it shows alone, the view waits.
  const pinned = await page(win, "pinned");
  gB.pinTab(pinned);
  gB.selectedTab = pinned;
  Assert.ok(pinned.pinned && !pinned.splitview, "the pinned tab stays pinned, out of the split");
  Assert.ok(isHiddenView(win), "the view is hidden");
  gB.selectedTab = a1;
  await assertLive(win, [fresh, a1], "selecting a pane again");

  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_session_restore_keeps_a_hidden_view_hidden() {
  const A = workspace("pw-ha");
  const w1 = await openWindow();
  live(w1).switchTo({ id: A.id });
  const a0 = await startTab(w1, A);
  const a1 = await page(w1, "ha1");
  const a2 = await page(w1, "ha2");
  Assert.ok(view(w1).split("vertical", { tab: a1 }).ok, "A: start | ha1");
  await until(() => rect(w1, a1).width > 100, "laid out");
  const before = rects(w1, [a0, a1]);
  w1.gBrowser.selectedTab = a2;
  Assert.ok(isHiddenView(w1), "ha2 alone, the view hidden");

  const uuid = (/** @type {Element} */ t) => SessionStore.getCustomTabValue(t, "vimma-tab");
  const ids = [a0, a1, a2].map(uuid);
  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  /** @type {SavedState} */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?ha2`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  const byUuid = (/** @type {string} */ u) => w2.gBrowser.tabs.find((t) => uuid(t) === u);
  // The restore is done (SSWindowRestored): every saved tab is back.
  const [r0, r1, r2] = /** @type {MozTabbrowserTab[]} */ (ids.map(byUuid));
  await until(() => !!view(w2).panes, "the tree is restored");
  Assert.equal(w2.gBrowser.selectedTab, r2, "ha2 is selected, alone");
  Assert.ok(isHiddenView(w2), "the view is restored hidden");
  Assert.deepEqual(names(shown(w2).tabs), names([r0, r1]), "with its panes");
  w2.gBrowser.selectedTab = r1;
  Assert.ok(!isHiddenView(w2), "picking ha1 shows it");
  await assertLive(w2, [r0, r1], "the restored view");
  await until(
    () =>
      rects(w2, [r0, r1]).every(
        (r, i) =>
          Math.abs(r.left - before[i].left) <= 1 && Math.abs(r.width - before[i].width) <= 1,
      ),
    "at its sizes (±1 px across)",
  );
  await BrowserTestUtils.closeWindow(w2);
});
