/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Swap and resize (docs/specs/m4-split-panes.md, sub-spec 5; ADR-014): ctrl+b shift+h/j/k/l
// and <C-w>H/J/K/L swap the focused pane with its neighbour; ctrl+b r enters resize mode
// (h/j/k/l, arrows, <>+-, Esc/Enter/q leave); <C-w><>+- resize from normal mode.

"use strict";

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const NOTICE_ID = "vimma-notice";
const TOLERANCE = 1;
const STEP = 0.05;

/** The window's split view, which VimmaHost made when it started the window. */
function view() {
  return /** @type {PaneView} */ (PaneViews.get(window));
}

/** The split's panes, which a test reads while its panes are split. */
function panes() {
  return /** @type {Panes} */ (view().panes);
}

function tabpanels() {
  return /** @type {Element} */ (document.getElementById("tabbrowser-tabpanels"));
}

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * A tab's panel rectangle relative to the content area.
 * @param {SplitTab} tab
 * @returns {Rect}
 */
function rectOf(tab) {
  const o = tabpanels().getBoundingClientRect();
  const r = /** @type {Element} */ (
    document.getElementById(tab.linkedPanel)
  ).getBoundingClientRect();
  return { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height };
}

/**
 * @param {Rect} a
 * @param {Rect} b
 */
function maxDelta(a, b) {
  return Math.max(
    .../** @type {(keyof Rect)[]} */ (["x", "y", "width", "height"]).map((k) =>
      Math.abs(a[k] - b[k]),
    ),
  );
}

/** The tab shown in each pane, in reading order. */
function paneTabs() {
  const p = view().panes;
  if (!p) return [gBrowser.selectedTab];
  return Panes.leaves(p).map((l) => gBrowser.tabs.find((t) => t.linkedPanel === l.tab));
}

function focusedTab() {
  const p = view().panes;
  const leaf = p && Panes.leaves(p).find((l) => l.pane === p.focus);
  return leaf ? gBrowser.tabs.find((t) => t.linkedPanel === leaf.tab) : gBrowser.selectedTab;
}

/** The root split's ratios (two side-by-side panes: [left, right]). */
function ratios() {
  // The tests read it with two panes side by side, whose root is a split.
  return /** @type {PaneSplit} */ (panes().root).ratios;
}

/**
 * @param {string} key
 * @param {object} [mods]
 */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/**
 * @param {string} key
 * @param {object} [mods]
 */
function ctrlW(key, mods = {}) {
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/**
 * @param {() => unknown} cond
 * @param {string} msg
 */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))));
}

/** @param {string} id */
function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

function notice() {
  return document.getElementById(NOTICE_ID);
}

/** @param {string} key */
async function split(key) {
  prefix(key);
  const tab = /** @type {SplitTab} */ (gBrowser.selectedTab);
  await until(
    () =>
      tab.linkedBrowser.currentURI.spec === START &&
      tab.linkedBrowser.contentDocument?.readyState === "complete",
    "the new pane's start page has loaded",
  );
  return tab;
}

/** @param {string} name */
async function openPage(name) {
  const tab = /** @type {SplitTab} */ (
    await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${name}`)
  );
  await recordPageKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/**
 * Back on `tab`'s pane (ctrl+b h `times` times), its page focused and in normal mode.
 * @param {MozTabbrowserTab} tab
 */
async function backTo(tab, times = 1) {
  for (let i = 0; i < times; i++) prefix("h");
  await until(() => document.activeElement === tab.linkedBrowser, "focus is back on the page");
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
}

/** @param {MozTabbrowserTab} tab */
async function pageKeysThenZ(tab) {
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("z");
  await waitForPageKey(tab.linkedBrowser, ["z", "!z"]);
  return pageKeys(tab.linkedBrowser);
}

/**
 * The panel of each listed tab sits at core layout()'s rect, ±1 px.
 * @param {string} what
 */
function assertLayout(what) {
  const o = tabpanels().getBoundingClientRect();
  const area = { x: 0, y: 0, width: Math.round(o.width), height: Math.round(o.height) };
  // Each laid-out pane's tab is a tab of the window, with its panel.
  const byId = new Map(gBrowser.tabs.map((t) => [t.linkedPanel, /** @type {SplitTab} */ (t)]));
  for (const { tab, rect } of Panes.layout(panes(), area)) {
    const shown = /** @type {SplitTab} */ (byId.get(tab));
    const d = maxDelta(rectOf(shown), rect);
    Assert.lessOrEqual(d, TOLERANCE, `${what}: ${shown.label} is at its rect (Δ ${d})`);
  }
}

async function reset() {
  while (view().panes) view().close();
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  notice()?.hidePopover?.();
  await nextFrame();
}

registerCleanupFunction(async () => {
  await reset();
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function shift_l_swaps_the_focused_pane_right_and_focus_moves_with_it() {
  const a = await openPage("a");
  const b = await split("v");
  const c = await split("v");
  Assert.deepEqual(paneTabs(), [a, b, c], "three panes side by side");
  await backTo(a, 2);
  await nextFrame();
  const before = { a: rectOf(a), b: rectOf(b), c: rectOf(c) };

  prefix("L", { shiftKey: true });
  await nextFrame();
  Assert.deepEqual(paneTabs(), [b, a, c], "ctrl+b shift+l swaps a with b");
  Assert.lessOrEqual(maxDelta(rectOf(a), before.b), TOLERANCE, "a now has b's rect");
  Assert.lessOrEqual(maxDelta(rectOf(b), before.a), TOLERANCE, "b now has a's rect");
  Assert.lessOrEqual(maxDelta(rectOf(c), before.c), TOLERANCE, "c did not move");
  Assert.equal(focusedTab(), a, "focus stays with the moved pane");
  Assert.equal(gBrowser.selectedTab, a, "its tab is selected");
  Assert.equal(document.activeElement, a.linkedBrowser, "its page has focus");
  Assert.ok(a.linkedBrowser.docShellIsActive && b.linkedBrowser.docShellIsActive, "both live");
  Assert.ok(a.linkedBrowser.currentURI.spec.startsWith(PAGE), "a kept its page");

  await until(() => VimmaHost.status(window).mode === "normal", "a is in normal mode");
  ctrlW("H", { shiftKey: true });
  await nextFrame();
  Assert.deepEqual(paneTabs(), [a, b, c], "<C-w>H swaps it back");
  Assert.lessOrEqual(maxDelta(rectOf(a), before.a), TOLERANCE, "a is back at its rect");
  Assert.equal(focusedTab(), a, "still focused");

  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the swap keys");
  await reset();
});

add_task(async function r_enters_resize_mode_l_widens_esc_leaves_and_min_ratio_holds() {
  const a = await openPage("a");
  prefix("r");
  Assert.notEqual(VimmaHost.status(window).mode, "resize", "one pane: no resize mode");
  await until(() => notice()?.textContent === "Resize mode: only one pane", "a notice says why");

  await split("v");
  await backTo(a);
  await nextFrame();
  const width = rectOf(a).width;
  const area = tabpanels().getBoundingClientRect().width;

  prefix("r");
  Assert.equal(VimmaHost.status(window).mode, "resize", "ctrl+b r enters resize mode");
  await until(() => segText("mode") === "RESIZE", "the status bar says RESIZE");

  EventUtils.synthesizeKey("l");
  await nextFrame();
  Assert.lessOrEqual(Math.abs(ratios()[0] - 0.55), 1e-9, "l: a's share grows by one step");
  Assert.lessOrEqual(
    Math.abs(rectOf(a).width - (width + STEP * area)),
    TOLERANCE,
    "and its width grows by the step",
  );
  EventUtils.synthesizeKey("l");
  await nextFrame();
  Assert.lessOrEqual(Math.abs(ratios()[0] - 0.6), 1e-9, "l twice: .6 / .4");
  assertLayout("at .6 / .4");
  Assert.equal(VimmaHost.status(window).mode, "resize", "still in resize mode");

  for (let i = 0; i < 15; i++) EventUtils.synthesizeKey("h");
  await nextFrame();
  Assert.lessOrEqual(
    Math.abs(ratios()[0] - Panes.MIN_RATIO),
    1e-9,
    "h past the floor stops at MIN_RATIO",
  );
  assertLayout("at MIN_RATIO");

  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "Esc leaves resize mode");
  await until(() => segText("mode") === "NORMAL", "the status bar says NORMAL");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the resize keys");
  await reset();
});

add_task(async function ctrl_w_greater_than_widens_directly_in_normal_mode() {
  const a = await openPage("a");
  await split("v");
  await backTo(a);
  ctrlW(">", { shiftKey: true });
  await nextFrame();
  Assert.lessOrEqual(Math.abs(ratios()[0] - 0.55), 1e-9, "<C-w>> widens a by one step");
  Assert.notEqual(VimmaHost.status(window).mode, "resize", "without entering resize mode");
  ctrlW("<", { shiftKey: true });
  await nextFrame();
  Assert.lessOrEqual(Math.abs(ratios()[0] - 0.5), 1e-9, "<C-w>< narrows it back");
  assertLayout("after <C-w><");
  Assert.ok(gBrowser.tabs.includes(a), "ctrl+w closed no tab");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the keys");
  await reset();
});

add_task(async function a_restored_pane_tree_swaps_and_resizes() {
  const a = await openPage("a");
  const b = /** @type {SplitTab} */ (BrowserTestUtils.addTab(gBrowser, `${PAGE}?b`));
  await BrowserTestUtils.browserLoaded(b.linkedBrowser);
  // A tree as M3 persistence hands it over (WindowWorkspaces #restorePanes): a | b at .7 / .3,
  // focus on a.
  const one = Panes.createPanes(a.linkedPanel);
  let tree = Panes.split(one, one.focus, "vertical", b.linkedPanel);
  tree = Panes.focusPane(tree, /** @type {string} */ (Panes.paneOfTab(tree, a.linkedPanel)));
  tree = Panes.resize(tree, "wider", 0.2);
  const { WindowWorkspaces } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
  );
  const active = WindowWorkspaces.get(window)?.model?.active ?? "restored";
  view().restore(new Map([[active, tree]]), active);
  view().reconcile();
  await nextFrame();
  Assert.deepEqual(paneTabs(), [a, b], "the restored tree is shown");
  await focusContent(a.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "a is in normal mode");

  prefix("r");
  Assert.equal(VimmaHost.status(window).mode, "resize", "ctrl+b r works on the restored tree");
  EventUtils.synthesizeKey("h");
  EventUtils.synthesizeKey("KEY_Escape");
  await nextFrame();
  Assert.lessOrEqual(Math.abs(ratios()[0] - 0.65), 1e-9, "h narrows a from .7 to .65");
  assertLayout("restored, resized");

  prefix("L", { shiftKey: true });
  await nextFrame();
  Assert.deepEqual(paneTabs(), [b, a], "ctrl+b shift+l swaps the restored panes");
  Assert.equal(focusedTab(), a, "a keeps focus");
  assertLayout("restored, swapped");
  Assert.deepEqual(await pageKeysThenZ(a), ["z"], "a's page saw none of the keys");
  await reset();
});
