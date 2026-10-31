/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The pane keys (docs/specs/m4-split-panes.md, sub-spec 3): ctrl+b v / - / x / z / h j k l and
// the normal-mode <C-w> family drive PaneViews.get(window) (sub-spec 2's host API).

"use strict";

const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves, PANES_MAX_DEFAULT } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/panes.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const NOTICE_ID = "vimma-notice";

function view() {
  return PaneViews.get(window);
}

/** Leaves of the window's pane tree (1 without a split). */
function paneCount() {
  return view().panes ? leaves(view().panes).length : 1;
}

/** The tab shown in each pane, in reading order. */
function paneTabs() {
  const p = view().panes;
  if (!p) return [gBrowser.selectedTab];
  return leaves(p).map((l) => gBrowser.tabs.find((t) => t.linkedPanel === l.tab));
}

function focusedTab() {
  const p = view().panes;
  const leaf = p && leaves(p).find((l) => l.pane === p.focus);
  return leaf ? gBrowser.tabs.find((t) => t.linkedPanel === leaf.tab) : gBrowser.selectedTab;
}

/** ctrl+b, then `key` with `mods`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/**
 * ctrl+b `key` (v or -) and the new pane's tab, once its start page has loaded: a key sent to
 * a pane whose document is still being replaced is lost (Firefox's focus, not ours).
 */
async function split(key) {
  prefix(key);
  const tab = gBrowser.selectedTab;
  await until(
    () =>
      tab.linkedBrowser.currentURI.spec === START &&
      tab.linkedBrowser.contentDocument?.readyState === "complete",
    "the new pane's start page has loaded",
  );
  return tab;
}

/** ctrl+w, then `key` (Vim's window commands, normal mode). */
function ctrlW(key, mods = {}) {
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

function notice() {
  return document.getElementById(NOTICE_ID);
}

function noticeShown() {
  const n = notice();
  return !!n && n.matches(":popover-open") && BrowserTestUtils.isVisible(n);
}

function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** An example.com tab, selected and focused, its keys recorded, in normal mode. */
async function openPage(name) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${name}`);
  await recordPageKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/** Presses z (unbound) in `tab`'s page; every key it saw, ending with "z". */
async function pageKeysThenZ(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("z");
  await waitForPageKey(tab.linkedBrowser, ["z", "!z"]);
  return pageKeys(tab.linkedBrowser);
}

/** Focus moved to `tab`'s pane: selected, its browser focused, URL bar and status bar follow. */
async function assertFocused(tab, what) {
  Assert.equal(focusedTab(), tab, `${what}: core's focus is on the pane`);
  Assert.equal(gBrowser.selectedTab, tab, `${what}: its tab is selected`);
  Assert.equal(document.activeElement, tab.linkedBrowser, `${what}: its page has focus`);
  const spec = tab.linkedBrowser.currentURI.spec;
  if (spec.startsWith(PAGE)) {
    Assert.equal(gURLBar.untrimmedValue, spec, `${what}: the URL bar shows its URL`);
  } else {
    Assert.equal(gURLBar.value, "", `${what}: the URL bar is empty on the new-tab page`);
  }
  const n = paneTabs().indexOf(tab) + 1;
  await until(
    () => segText("pane") === `pane ${n}/${paneCount()}`,
    `${what}: the status bar says pane ${n}/${paneCount()}`,
  );
}

async function reset() {
  while (view().panes) view().close();
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  view().max = PANES_MAX_DEFAULT;
  notice()?.hidePopover?.();
  await nextFrame();
}

registerCleanupFunction(async () => {
  await reset();
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function v_and_minus_split_and_hjkl_move_focus_by_geometry_with_mru() {
  const a = await openPage("a");
  const b = await split("v");
  Assert.equal(paneCount(), 2, "ctrl+b v splits right: two panes");
  Assert.notEqual(b, a, "the new pane shows a new tab, selected");
  Assert.equal(focusedTab(), b, "and has focus");
  await until(() => gURLBar.focused, "the new tab's URL bar is focused, as for ctrl+b c");
  const c = await split("-");
  Assert.equal(paneCount(), 3, "ctrl+b - splits down: three panes");
  Assert.deepEqual(
    paneTabs().map((t) => [a, b, c].indexOf(t)),
    [0, 1, 2],
    "a | (b over c), in reading order",
  );
  await nextFrame();

  prefix("h");
  await assertFocused(a, "ctrl+b h from c");
  prefix("l");
  await assertFocused(c, "ctrl+b l from a (b and c touch; c is the most recent)");
  prefix("k");
  await assertFocused(b, "ctrl+b k from c");
  prefix("j");
  await assertFocused(c, "ctrl+b j from b");
  prefix("l");
  await assertFocused(c, "ctrl+b l with no pane to the right changes nothing");
  prefix("h");
  await assertFocused(a, "ctrl+b h back to a");
  Assert.ok(!noticeShown(), "no notice for runnable pane keys");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the pane keys");
  await reset();
});

add_task(async function z_zooms_and_unzooms_and_focus_keys_keep_zoomed_away_panes_asleep() {
  const a = await openPage("a");
  const b = await split("v");
  prefix("h");
  await assertFocused(a, "back on a");
  prefix("z");
  await nextFrame();
  await TestUtils.waitForTick();
  Assert.equal(view().panes.zoom, view().panes.focus, "ctrl+b z zooms the focused pane");
  Assert.ok(a.linkedBrowser.docShellIsActive, "the zoomed pane is live");
  Assert.ok(!b.linkedBrowser.docShellIsActive, "the zoomed-away pane is not");

  prefix("h"); // no pane left of a: nothing moves, the zoom stays
  await nextFrame();
  await TestUtils.waitForTick();
  Assert.equal(view().panes.zoom, view().panes.focus, "a focus key with no target keeps zoom");
  Assert.ok(!b.linkedBrowser.docShellIsActive, "and does not wake the zoomed-away pane");
  Assert.equal(document.activeElement, a.linkedBrowser, "a keeps focus");

  prefix("z");
  await nextFrame();
  Assert.equal(view().panes.zoom, null, "ctrl+b z again unzooms");
  Assert.ok(b.linkedBrowser.docShellIsActive, "both panes are live again");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "the page saw neither ctrl+b nor z");
  await reset();
});

add_task(async function x_closes_the_pane_then_the_last_pane_closes_the_tab() {
  const a = await openPage("a");
  const b = await split("v");
  const c = await split("v");
  Assert.equal(paneCount(), 3, "three panes");
  prefix("x");
  Assert.equal(paneCount(), 2, "ctrl+b x closes the focused pane");
  Assert.ok(c.isConnected && !c.closing, "its tab stays open");
  Assert.deepEqual(paneTabs(), [a, b], "a and b remain");
  await assertFocused(b, "focus goes to the absorbing pane");
  prefix("h");
  await assertFocused(a, "ctrl+b h");
  prefix("x");
  Assert.equal(view().panes, null, "down to one pane: no split");
  Assert.equal(gBrowser.selectedTab, b, "b's pane is the one left");
  Assert.ok(a.isConnected && !a.closing, "a's tab stays open");

  const closing = BrowserTestUtils.waitForTabClosing(b);
  prefix("x");
  await closing;
  Assert.ok(!b.isConnected || b.closing, "ctrl+b x on the last pane closes the tab");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the keys");
  await reset();
});

add_task(async function x_on_the_last_pane_of_a_pinned_tab_follows_tab_close() {
  const a = await openPage("a");
  const pinned = await openPage("pinned");
  // Decision 11 unpins it in a window with workspaces; this checks the guard other windows keep.
  WindowWorkspaces.get(window).unpinsPinnedTabs = false;
  gBrowser.pinTab(pinned);
  Assert.equal(gBrowser.selectedTab, pinned, "sanity: the pinned tab is selected");
  await focusContent(pinned.linkedBrowser);
  const count = gBrowser.tabs.length;
  prefix("x");
  Assert.equal(gBrowser.tabs.length, count, "ctrl+b x on a pinned tab closes nothing");
  Assert.equal(
    gBrowser.selectedTab,
    gBrowser.visibleTabs[gBrowser.pinnedTabCount],
    "and selects the first unpinned tab, as tab.close does",
  );
  gBrowser.unpinTab(pinned);
  WindowWorkspaces.get(window).unpinsPinnedTabs = true;
  Assert.ok(a.isConnected, "sanity");
  await reset();
});

add_task(async function colon_q_closes_the_focused_pane() {
  const a = await openPage("a");
  const b = await split("v");
  prefix("h");
  await assertFocused(a, "back on a");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("q");
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(view().panes, null, ":q closes a's pane");
  Assert.ok(a.isConnected && !a.closing, "a's tab stays open");
  Assert.equal(gBrowser.selectedTab, b, "b's pane is left");
  await reset();
});

add_task(async function a_fifth_split_is_refused_with_a_notice() {
  view().max = 4;
  const a = await openPage("a");
  for (let i = 0; i < 3; i++) await split("v");
  Assert.equal(paneCount(), 4, "four panes");
  const count = gBrowser.tabs.length;
  const selected = gBrowser.selectedTab;
  prefix("v");
  Assert.equal(paneCount(), 4, "a fifth split is refused");
  Assert.equal(gBrowser.tabs.length, count, "and opens no tab");
  Assert.equal(gBrowser.selectedTab, selected, "focus stays");
  Assert.ok(noticeShown(), "a notice says why");
  Assert.equal(notice().textContent, "Split right: at most 4 panes", "with core's reason");
  for (let i = 0; i < 3; i++) prefix("h");
  await assertFocused(a, "three ctrl+b h back to a");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the keys");
  await reset();
});

add_task(async function ctrl_w_family_moves_focus_and_zooms_in_normal_mode_with_panes() {
  const a = await openPage("a");
  const b = await split("v");
  prefix("h");
  await assertFocused(a, "back on a");
  await until(() => VimmaHost.status(window).mode === "normal", "a is in normal mode");
  ctrlW("l");
  await assertFocused(b, "ctrl+w l");
  // b is the new-tab page; back to a with ctrl+b, which works whatever the page.
  prefix("h");
  await assertFocused(a, "ctrl+b h");
  await until(() => VimmaHost.status(window).mode === "normal", "a is in normal mode");
  ctrlW("o");
  Assert.equal(view().panes.zoom, view().panes.focus, "ctrl+w o zooms");
  ctrlW("o");
  Assert.equal(view().panes.zoom, null, "and unzooms");
  Assert.ok(a.isConnected && b.isConnected, "ctrl+w closed no tab");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw neither ctrl+w nor l / o");
  await reset();
});
