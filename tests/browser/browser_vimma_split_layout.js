/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Split layout and reconcile (docs/specs/m4-split-panes.md, sub-spec 2): the host API
// (PaneViews.get(window).split / close / zoom) mirrors the window's pane tree onto one Firefox
// split view and puts every panel at core layout()'s rectangle. The keys (sub-spec 3) are in
// browser_vimma_pane_keys.js.

"use strict";

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");

const WIDTH = 1280;
const HEIGHT = 800;
const TOLERANCE = 1;

function view() {
  return PaneViews.get(window);
}

function tabpanels() {
  return document.getElementById("tabbrowser-tabpanels");
}

function panelOf(tab) {
  return document.getElementById(tab.linkedPanel);
}

function area() {
  const r = tabpanels().getBoundingClientRect();
  return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) };
}

function relRect(el) {
  const o = tabpanels().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height };
}

function maxDelta(a, b) {
  return Math.max(...["x", "y", "width", "height"].map((k) => Math.abs(a[k] - b[k])));
}

/** core layout() of `state` over the content area, as [tab, rect] in reading order. */
function expected(state, tabs) {
  const byId = new Map(tabs.map((t) => [t.linkedPanel, t]));
  return Panes.layout(state, area()).map((r) => [byId.get(r.tab), r.rect]);
}

/** Every listed tab's panel and browser sit at core's rect, within ±1 px. Returns the max Δ. */
function assertRects(rects, what) {
  let worst = 0;
  for (const [tab, want] of rects) {
    const dp = maxDelta(relRect(panelOf(tab)), want);
    const db = maxDelta(relRect(tab.linkedBrowser), want);
    worst = Math.max(worst, dp, db);
    Assert.lessOrEqual(dp, TOLERANCE, `${what}: ${tab.label}'s panel is at its rect (Δ ${dp})`);
    Assert.lessOrEqual(db, TOLERANCE, `${what}: ${tab.label}'s browser fills it (Δ ${db})`);
  }
  info(`${what}: max Δ ${worst} px`);
  return worst;
}

function assertLive(tabs, what) {
  for (const tab of tabs) {
    Assert.ok(tab.linkedBrowser.docShellIsActive, `${what}: ${tab.label}'s docshell is active`);
    Assert.ok(
      panelOf(tab).classList.contains("split-view-panel-active"),
      `${what}: ${tab.label}'s panel is a visible split panel`,
    );
  }
}

/** Labels of the split panels in DOM order (Tab-key order). */
function domOrder(tabs) {
  return [...tabpanels().children]
    .map((p) => tabs.find((t) => panelOf(t) === p))
    .filter(Boolean)
    .map((t) => t.label);
}

/** The element at the centre of a rect of the content area. */
function hitAt(rect) {
  const o = tabpanels().getBoundingClientRect();
  return document.elementFromPoint(o.x + rect.x + rect.width / 2, o.y + rect.y + rect.height / 2);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function setWindowSize(width = WIDTH, height = HEIGHT) {
  if (window.outerWidth !== width || window.outerHeight !== height) {
    const resized = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeTo(width, height);
    await resized;
  }
  await TestUtils.waitForCondition(
    () => window.outerWidth === width && window.outerHeight === height,
    "window has its test size",
  );
}

const opened = [];
async function openTabs(...names) {
  const tabs = [];
  for (const name of names) {
    const url = `data:text/html,<title>${name}</title><body style="height:5000px">${name}</body>`;
    const tab = BrowserTestUtils.addTab(gBrowser, url);
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tab.label = name;
    tabs.push(tab);
    opened.push(tab);
  }
  return tabs;
}

/** a, then split right to b, then split b down to c: x[a, y[b, c]]. */
async function lShape() {
  const tabs = await openTabs("a", "b", "c");
  const [a, b, c] = tabs;
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.deepEqual(view().split("vertical", { tab: b }), { ok: true }, "split right");
  Assert.deepEqual(view().split("horizontal", { tab: c }), { ok: true }, "then down");
  await nextFrame();
  let s = Panes.split(Panes.createPanes(a.linkedPanel), "p1", "vertical", b.linkedPanel);
  s = Panes.split(s, "p2", "horizontal", c.linkedPanel);
  return { tabs, state: s };
}

async function reset() {
  while (view().panes) view().close();
  for (const tab of opened.splice(0)) if (!tab.closing && tab.parentNode) gBrowser.removeTab(tab);
  view().max = Panes.PANES_MAX_DEFAULT;
  await nextFrame();
}

const startSize = [window.outerWidth, window.outerHeight];
registerCleanupFunction(async () => {
  await reset();
  window.resizeTo(...startSize);
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

add_task(async function split_right_then_down_puts_three_live_panes_at_core_rects_in_order() {
  await setWindowSize();
  const { tabs, state } = await lShape();
  const [a, b, c] = tabs;
  const wrapper = a.splitview;
  Assert.ok(wrapper, "a is in a split view");
  Assert.deepEqual(
    wrapper.tabs.map((t) => t.label).sort(),
    ["a", "b", "c"],
    "one wrapper holds all three",
  );
  Assert.ok(tabpanels().hasAttribute("vimma-panes"), "our layout is on");
  // m5-omarchy-theme: the gaps between panes show the theme's --vimma-muted (builtin here: the
  // vimma palette, its light variant when the window's colour scheme is light).
  const light = window.matchMedia("(prefers-color-scheme: light)").matches;
  Assert.equal(
    getComputedStyle(tabpanels()).backgroundColor,
    light ? "rgb(163, 176, 169)" : "rgb(42, 61, 54)",
    "the pane border is the theme's muted colour",
  );
  assertRects(expected(state, tabs), "L shape");
  assertLive(tabs, "L shape");
  Assert.deepEqual(domOrder(tabs), ["a", "b", "c"], "panels are in reading order");
  Assert.equal(gBrowser.selectedTab, c, "the new pane's tab is selected");
  Assert.equal(view().panes.focus, "p3", "and focused in the tree");
  Assert.equal(c.getAttribute("aria-label"), "c, pane 3 of 3", "the third pane has a name");
  Assert.ok(!b.hasAttribute("vimma-pane-label"), "the first two keep Firefox's names");
  await reset();
});

add_task(async function closing_a_pane_relays_out_the_rest_and_deactivates_its_tab() {
  await setWindowSize();
  const { tabs, state } = await lShape();
  const [a, b, c] = tabs;
  Assert.deepEqual(view().close(), { ok: true }, "close the focused pane, c");
  await nextFrame();
  await TestUtils.waitForTick(); // the old wrapper's late TabSplitViewDeactivate
  assertRects(expected(Panes.closePane(state, "p3"), tabs), "after close");
  assertLive([a, b], "after close");
  Assert.ok(!c.closing && c.parentNode, "c's tab stays open");
  Assert.ok(!c.linkedBrowser.docShellIsActive, "c's docshell is inactive");
  Assert.ok(!panelOf(c).classList.contains("split-view-panel-active"), "c's panel is not shown");
  Assert.equal(gBrowser.selectedTab, b, "focus went to the absorbing pane, b");
  Assert.deepEqual(a.splitview.tabs.map((t) => t.label).sort(), ["a", "b"], "a and b remain");
  Assert.ok(!c.hasAttribute("aria-label"), "c's pane name is gone");

  view().close();
  await nextFrame();
  Assert.equal(view().panes, null, "one pane left: no split");
  Assert.ok(!a.splitview, "the wrapper dissolved");
  Assert.ok(!tabpanels().hasAttribute("vimma-panes"), "our layout is off");
  await reset();
});

add_task(async function zoom_fills_the_area_with_one_pane_and_unzoom_restores_the_layout() {
  await setWindowSize();
  const { tabs, state } = await lShape();
  const [a, b, c] = tabs;
  const rects = expected(state, tabs);
  Assert.deepEqual(view().zoom(), { ok: true }, "zoom c");
  await nextFrame();
  await TestUtils.waitForTick();
  assertRects([[c, area()]], "zoomed");
  for (const [tab, rect] of rects.slice(0, 2)) {
    Assert.ok(panelOf(c).contains(hitAt(rect)), `${tab.label}'s area shows c`);
    Assert.ok(
      panelOf(tab).classList.contains("split-view-panel-active"),
      `${tab.label} stays a split member`,
    );
    Assert.ok(!tab.linkedBrowser.docShellIsActive, `${tab.label}'s docshell is inactive`);
  }
  Assert.ok(c.linkedBrowser.docShellIsActive, "c's docshell is active");
  Assert.equal(gBrowser.selectedTab, c, "c stays selected");

  view().zoom();
  await nextFrame();
  assertRects(rects, "unzoomed");
  assertLive([a, b, c], "unzoomed");
  Assert.ok(panelOf(a).contains(hitAt(rects[0][1])), "a is hit again");
  await reset();
});

add_task(async function a_window_resize_lays_the_panes_out_again() {
  await setWindowSize();
  const { tabs, state } = await lShape();
  await setWindowSize(1000, 700);
  await nextFrame();
  const after = expected(state, tabs);
  Assert.less(after[0][1].width + after[1][1].width, WIDTH, "the area did shrink");
  assertRects(after, "after resize");
  await setWindowSize();
  await nextFrame();
  assertRects(expected(state, tabs), "after resizing back");
  await reset();
});

add_task(async function a_fifth_split_is_refused_at_max_four_with_a_reason() {
  await setWindowSize();
  Assert.equal(view().max, 8, "panes.max defaults to 8");
  view().max = 4;
  const tabs = await openTabs("m1", "m2", "m3", "m4", "m5");
  await BrowserTestUtils.switchTab(gBrowser, tabs[0]);
  for (const tab of tabs.slice(1, 4)) view().split("vertical", { tab });
  await nextFrame();
  const before = view().panes;
  const count = gBrowser.tabs.length;
  const result = view().split("horizontal", { tab: tabs[4] });
  Assert.deepEqual(result, { ok: false, reason: "at most 4 panes" }, "refused with core's reason");
  Assert.equal(view().panes, before, "the tree is unchanged");
  Assert.deepEqual(view().split("vertical"), result, "refused without a tab too");
  Assert.equal(gBrowser.tabs.length, count, "a refused split opens no tab");
  Assert.ok(!tabs[4].splitview, "m5 did not join");
  assertLive(tabs.slice(0, 4), "four panes");
  Assert.equal(tabs[3].getAttribute("aria-label"), "m4, pane 4 of 4", "the fourth pane's name");
  await reset();
});

add_task(async function a_split_without_a_tab_opens_a_new_tab_in_the_new_pane() {
  await setWindowSize();
  const [a] = await openTabs("n1");
  await BrowserTestUtils.switchTab(gBrowser, a);
  const opening = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  view().split("vertical");
  const fresh = (await opening).target;
  opened.push(fresh);
  await nextFrame();
  Assert.equal(gBrowser.selectedTab, fresh, "the new tab is selected");
  Assert.ok(fresh.splitview && fresh.splitview === a.splitview, "and shares a's split");
  assertLive([a, fresh], "two panes");
  await reset();
});

add_task(async function closing_a_member_tab_drops_its_pane() {
  await setWindowSize();
  const { tabs, state } = await lShape();
  const [a, b, c] = tabs;
  gBrowser.removeTab(b);
  await TestUtils.waitForCondition(() => view().panes && view().panes.mru.length === 2);
  await nextFrame();
  assertRects(expected(Panes.closePane(state, "p2"), [a, c]), "after closing b's tab");
  assertLive([a, c], "after closing b's tab");
  await reset();
});

add_task(async function firefox_split_view_ui_is_hidden() {
  Assert.equal(
    Services.prefs.getBoolPref("browser.tabs.splitView.enabled"),
    false,
    "branding turns Firefox's split-view menu items off",
  );
  const button = document.getElementById("split-view-button");
  button.hidden = false;
  Assert.equal(getComputedStyle(button).display, "none", "the URL bar button never shows");
  button.hidden = true;
});
