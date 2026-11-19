/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md, behaviours 2 and 10 (issue #1333): selecting a tab that
// Firefox unloaded (Unload Tab, the low-memory tab unloader, discardBrowser), of a split that is
// not on screen, shows that split whole with the tab focused, from every way of selecting a tab
// and after a restore. The split's other pane keeps its page, scroll position and typed text, and
// the view settles (no reconcile loop, issue #1332).

"use strict";

/* global focusContent -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
// Eight tasks of two splits each, one with a restore: past the default timeout on a busy runner.
requestLongerTimeout(2);

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { gotoItems } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/goto.mjs");
const { goToTab } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/tab-search.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const LONG = `${ROOT}file_vimma_insert_scroll.html`;
const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const TAB_KEY = "vimma-tab";

/**
 * A window's split view, which VimmaHost made when it started the window.
 * @param {BrowserWindow} [win]
 */
const view = (win = window) => /** @type {PaneView} */ (PaneViews.get(win));
/**
 * A window's workspaces once their model is built.
 * @param {BrowserWindow} win
 */
const live = (win) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** @param {BrowserWindow} [win] */
function nextFrame(win = window) {
  return new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

/** @type {SplitTab[]} */
const opened = [];
/** @type {Window[]} */
const windows = [];
/** @type {string[]} */
const created = [];

/** @param {SplitTab} t */
const winOf = (t) => /** @type {BrowserWindow | null} */ (t.ownerDocument?.defaultView ?? null);

function closeOpened() {
  for (const t of opened.splice(0)) {
    const win = winOf(t);
    if (win && !win.closed && !t.closing && t.parentNode) win.gBrowser.removeTab(t);
  }
}

registerCleanupFunction(async () => {
  closeOpened();
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
});

/**
 * A loaded page titled `name`.
 * @param {string} name
 * @param {BrowserWindow} [win]
 */
async function page(name, win = window) {
  const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${name}`));
  opened.push(t);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    content.document.title = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  return t;
}

/**
 * The long page, scrolled to 1200 with text typed into its field.
 * @param {BrowserWindow} [win]
 */
async function longPage(win = window) {
  const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(win.gBrowser, LONG));
  opened.push(t);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.value = "kept";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
    content.scrollTo(0, 1200);
  });
  return t;
}

/**
 * The long page's scroll position and typed text; null while its document is not the page yet
 * (a restore that still moves it to its content process fails the read).
 * @param {SplitTab} t
 */
async function readLong(t) {
  try {
    return await SpecialPowers.spawn(t.linkedBrowser, [], () => ({
      y: content.scrollY,
      text: /** @type {HTMLInputElement | null} */ (content.document.getElementById("text"))?.value,
    }));
  } catch {
    return null;
  }
}

/**
 * S1 of `a` and the long page, then S2 of `c` and `d` made on a lone tab: S2 is on screen, S1 is
 * not.
 * @param {BrowserWindow} [win]
 */
async function twoSplits(win = window) {
  // A task that failed half-way leaves its tabs.
  if (win === window) closeOpened();
  const a = await page("a", win);
  const long = await longPage(win);
  const c = await page("c", win);
  const d = await page("d", win);
  await BrowserTestUtils.switchTab(win.gBrowser, a);
  Assert.ok(view(win).showTabs([a, long], a).ok, "S1: a | long");
  await until(() => view(win).splits.shown === 1, "S1 shows");
  await BrowserTestUtils.switchTab(win.gBrowser, c);
  await until(() => view(win).hidden, "c shows alone, S1 kept");
  Assert.ok(view(win).showTabs([c, d], c).ok, "S2: c | d");
  await until(() => view(win).splits.shown === 2, "S2 shows");
  await nextFrame(win);
  return { a, long, c, d };
}

/**
 * The tab's panel is laid out on screen (its rectangle has a size).
 * @param {SplitTab} t
 */
function laidOut(t) {
  const doc = t.ownerDocument;
  const panel = t.linkedPanel && doc.getElementById(t.linkedPanel);
  if (!panel) return false;
  const r = panel.getBoundingClientRect();
  return r.width > 50 && r.height > 50;
}

/**
 * The tabs of the split on screen, in pane order.
 * @param {BrowserWindow} win
 */
function shownTabs(win) {
  const panes = view(win).panes;
  return panes ? leaves(panes).map((l) => view(win).tabOf(l.tab)) : [];
}

/**
 * How many times the view reconciles over `ms`: none once it has settled.
 * @param {BrowserWindow} win
 * @param {number} ms
 */
async function reconcilesOver(win, ms) {
  let n = 0;
  const stop = PaneViews.watch(win, () => n++);
  // A quiet period is the point: a reconcile loop shows as calls within it.
  await new Promise((r) => setTimeout(r, ms));
  stop();
  return n;
}

/**
 * After `tab` was selected: S1 shows whole, focused on `tab`, laid out and live; S2 is off screen;
 * the long page keeps its scroll position and typed text; and the view settles.
 * @param {{ a: SplitTab, long: SplitTab, c: SplitTab }} tabs
 * @param {SplitTab} tab
 */
async function assertS1Shows({ a, long, c }, tab) {
  const win = /** @type {BrowserWindow} */ (winOf(tab));
  await until(() => win.gBrowser.selectedTab === tab, "the unloaded tab is selected");
  await until(() => view(win).splits.shown === 1, "its split shows");
  Assert.deepEqual(shownTabs(win), [a, long], "whole");
  Assert.ok(!view(win).hidden, "on screen, not as a hidden view");
  Assert.equal(win.gBrowser.selectedTab, tab, "focus on its pane");
  await until(() => laidOut(a) && laidOut(long), "both panes are laid out");
  await until(
    () => a.linkedBrowser.docShellIsActive && long.linkedBrowser.docShellIsActive,
    "both pages are live",
  );
  Assert.ok(!laidOut(c), "S2 is off screen");
  await until(() => !a.hasAttribute("pending") && !long.hasAttribute("pending"), "both restore");
  await TestUtils.waitForCondition(
    () => readLong(long).then((r) => r?.y === 1200 && r.text === "kept"),
    "the long page is at 1200 with its typed text",
  );
  await nextFrame(win);
  Assert.equal(await reconcilesOver(win, 500), 0, "the view settles: no reconcile loop");
  Assert.equal(win.gBrowser.selectedTab, tab, "and the tab stays selected");
}

/** @param {SplitTab} t */
async function unload(t) {
  const win = /** @type {BrowserWindow} */ (winOf(t));
  // A tab SessionStore is still restoring is not unloaded, or is woken again at once (#1342).
  await until(() => !SessionStore.isTabRestoring(t), "the tab has restored");
  Assert.ok(win.gBrowser.discardBrowser(t, true), "Firefox unloads the tab");
  await until(() => !t.linkedPanel, "the tab is unloaded");
}

/** Focuses the selected page in normal mode, so keys go to Vimma. */
async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
}

/** @param {string} keys */
function type(keys) {
  for (const k of keys) EventUtils.synthesizeKey(k);
}

/** @param {SplitTab} t  its number among the workspace's tabs, as `:tab N` counts */
const numberOf = (t) => gBrowser.visibleTabs.indexOf(t) + 1;

add_task(async function firefox_selecting_an_unloaded_tab_shows_its_split() {
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  const tabs = await twoSplits();
  await unload(tabs.a);
  // The tab strip, ctrl+tab, alt+N and the tab line's click all select this way.
  gBrowser.selectedTab = tabs.a;
  await assertS1Shows(tabs, tabs.a);
});

// SessionStore restores the unloaded tab inside Firefox's selection (insertBrowser), and the end
// of that restore (SSWindowStateReady) rebuilt the workspaces there: with focus on no element,
// that focused the old tab's page, which selected the old tab again (issue #1333).
add_task(async function selecting_it_with_focus_nowhere_shows_its_split() {
  const tabs = await twoSplits();
  await unload(tabs.a);
  Services.focus.clearFocus(window);
  gBrowser.selectedTab = tabs.a;
  Assert.equal(gBrowser.selectedTab, tabs.a, "the unloaded tab is selected at once");
  await assertS1Shows(tabs, tabs.a);
});

add_task(async function unload_tab_then_tab_n_shows_its_split() {
  const tabs = await twoSplits();
  // The tab context menu's Unload Tab.
  await gBrowser.explicitUnloadTabs([tabs.a]);
  await until(() => !tabs.a.linkedPanel, "a is unloaded");
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(`tab ${numberOf(tabs.a)}`);
  EventUtils.synthesizeKey("KEY_Enter");
  await assertS1Shows(tabs, tabs.a);
});

add_task(async function count_gt_on_an_unloaded_tab_shows_its_split() {
  const tabs = await twoSplits();
  await unload(tabs.a);
  await focusPage();
  type(`${numberOf(tabs.a)}gt`);
  await assertS1Shows(tabs, tabs.a);
});

add_task(async function both_panes_unloaded_count_gb_shows_the_split_restored() {
  const tabs = await twoSplits();
  await unload(tabs.a);
  await unload(tabs.long);
  await focusPage();
  type(`${numberOf(tabs.long)}gb`);
  await assertS1Shows(tabs, tabs.long);
});

add_task(async function tab_search_on_an_unloaded_tab_shows_its_split() {
  const tabs = await twoSplits();
  await unload(tabs.a);
  const item = gotoItems(window).find((i) => i.title === "a");
  Assert.ok(item, "tab search lists a, unloaded");
  goToTab(window, window, /** @type {{ tabId: string }} */ (item).tabId);
  await assertS1Shows(tabs, tabs.a);
});

add_task(async function side_panel_enter_on_an_unloaded_tab_shows_its_split() {
  const tabs = await twoSplits();
  await unload(tabs.a);
  await focusPage();
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("b");
  const panel = () => /** @type {HTMLElement | null} */ (document.getElementById(PANEL_ID));
  await until(() => panel() && !panel()?.hidden, "ctrl+b b opens the side panel");
  const rows = () => [
    .../** @type {NodeListOf<HTMLElement>} */ (
      /** @type {HTMLElement} */ (panel()).querySelectorAll("[role=option]")
    ),
  ];
  const title = (/** @type {Element} */ r) =>
    r.querySelector(".vimma-panel-title")?.textContent ?? "";
  const at = rows().findIndex((r) => title(r) === "a");
  Assert.greaterOrEqual(at, 0, "the panel lists a");
  const highlighted = () => rows().findIndex((r) => r.getAttribute("aria-selected") === "true");
  for (let i = 0; i < 30 && highlighted() !== at; i++) type(highlighted() < at ? "j" : "k");
  await until(() => highlighted() === at, "the highlight is on a");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => panel()?.hidden !== false, "Enter closes the panel");
  await assertS1Shows(tabs, tabs.a);
  closeOpened();
});

/** A new window with its workspaces built. */
async function openWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win)).ready;
  await until(() => !!live(win).model, "the new window has its workspaces");
  return win;
}

// The case the issue was found in: after a restore S1 is lazy; shown, then put away again, and
// one of its tabs unloaded (#1332 kept it unloaded), selecting that tab shows S1.
add_task(async function after_a_restore_an_unloaded_tab_of_the_hidden_split_shows_it() {
  const M = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name: "su-m", color: "blue", icon: "briefcase" })
  );
  created.push(M.id);
  const w1 = await openWindow();
  live(w1).switchTo({ id: M.id });
  await until(() => live(w1).model.active === M.id, "M is shown");
  const before = await twoSplits(w1);
  const uuids = [before.a, before.long, before.c].map((t) =>
    SessionStore.getCustomTabValue(t, TAB_KEY),
  );
  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  const winState = JSON.parse(SessionStore.getBrowserState()).windows.find(
    (/** @type {{ tabs: { entries: { url: string }[] }[] }} */ w) =>
      w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?a`)),
  );
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  await until(() => live(w2).model.active === M.id, "M is shown after the restore");
  await until(() => view(w2).splits.shown === 2, "S2 is on screen");
  const [a, long, c] = uuids.map(
    (u) =>
      /** @type {SplitTab} */ (
        w2.gBrowser.tabs.find((t) => SessionStore.getCustomTabValue(t, TAB_KEY) === u)
      ),
  );
  Assert.ok(!a.linkedPanel && !long.linkedPanel, "S1 comes back lazy");
  w2.gBrowser.selectedTab = long;
  await until(() => view(w2).splits.shown === 1, "selecting the long page shows S1");
  await until(
    () =>
      [a, long].every(
        (t) =>
          !t.hasAttribute("pending") &&
          t.linkedBrowser.isRemoteBrowser &&
          !SessionStore.isTabRestoring(t),
      ),
    "S1's pages restore",
  );
  await nextFrame(w2);
  w2.gBrowser.selectedTab = c;
  await until(() => view(w2).splits.shown === 2, "S2 shows again");
  await nextFrame(w2);
  await unload(a);
  w2.gBrowser.selectedTab = a;
  await assertS1Shows({ a, long, c }, a);
  await BrowserTestUtils.closeWindow(w2);
  created.splice(created.indexOf(M.id), 1);
  await WorkspaceStore.deleteWorkspace(M.id, { confirmed: true });
});
