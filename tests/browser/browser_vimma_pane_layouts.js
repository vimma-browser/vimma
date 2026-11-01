/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tiling layouts (docs/specs/tiling-layouts.md): ctrl+b enter opens a pane along the focused
// pane's longer side (dwindle), ctrl+b space cycles tmux's presets and :layout picks one. A
// preset moves the existing pages, never reloads them; each workspace keeps its arrangement and
// its last preset across a switch and a session restore.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const NOTICE_ID = "vimma-notice";
const WIDTH = 1280;
const HEIGHT = 800;
const TOLERANCE = 1;

/** @type {string[]} */
const created = [];
/** @type {Window[]} */
const windows = [];

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

function nextFrame(win = window) {
  return new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

function view(win = window) {
  return PaneViews.get(win);
}

/** ctrl+b, then `key` (a KEY_ name or a character). */
function prefix(key, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, {}, win);
}

function notice(win = window) {
  const n = win.document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

function tabOf(panel, win = window) {
  return win.gBrowser.tabs.find((t) => t.linkedPanel === panel);
}

/** Test names of tabs: set for new panes; an example.com page is named by its query. */
const names = new WeakMap();

function nameOf(tab) {
  if (names.has(tab)) return names.get(tab);
  // A restored tab may not have loaded yet (about:blank): its session entry has the URL.
  const state = JSON.parse(SessionStore.getTabState(tab));
  const url = state.entries?.[state.index - 1]?.url ?? tab.linkedBrowser.currentURI.spec;
  return url.startsWith(`${PAGE}?`) ? url.slice(PAGE.length + 1).replace(/2$/, "") : url;
}

/** The window's tree with each leaf named by its tab: `x[a,y[b,c]]`; one pane: "". */
function shape(win = window) {
  const p = view(win).panes;
  const walk = (n) =>
    n.type === "leaf" ? nameOf(tabOf(n.tab, win)) : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return p ? walk(p.root) : "";
}

function focusedLabel(win = window) {
  const p = view(win).panes;
  return nameOf(tabOf(Panes.leaves(p).find((l) => l.pane === p.focus).tab, win));
}

function tabpanels(win = window) {
  return win.document.getElementById("tabbrowser-tabpanels");
}

function area(win = window) {
  const r = tabpanels(win).getBoundingClientRect();
  return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) };
}

function relRect(el, win = window) {
  const o = tabpanels(win).getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height };
}

function maxDelta(a, b) {
  return Math.max(...["x", "y", "width", "height"].map((k) => Math.abs(a[k] - b[k])));
}

/**
 * Core's rect less half the pane gap on each interior edge, as split.css draws it (the gap goes
 * on interior edges only, half from each side; m4-split-panes sub-spec 2).
 */
function drawn(rect, a, win) {
  const gap = parseFloat(win.getComputedStyle(tabpanels(win)).getPropertyValue("--vimma-pane-gap"));
  const half = (Number.isFinite(gap) ? gap : 0) / 2;
  const left = rect.x > 0 ? half : 0;
  const top = rect.y > 0 ? half : 0;
  const right = rect.x + rect.width < a.width ? half : 0;
  const bottom = rect.y + rect.height < a.height ? half : 0;
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: rect.width - left - right,
    height: rect.height - top - bottom,
  };
}

/** Every pane's panel and browser sit at core layout()'s rect for the tree, within ±1 px. */
async function assertRects(what, win = window) {
  await nextFrame(win);
  const p = view(win).panes;
  const a = area(win);
  for (const r of Panes.layout(p, a)) {
    const tab = tabOf(r.tab, win);
    const panel = win.document.getElementById(tab.linkedPanel);
    const want = drawn(r.rect, a, win);
    const dp = maxDelta(relRect(panel, win), want);
    const db = maxDelta(relRect(tab.linkedBrowser, win), want);
    Assert.lessOrEqual(dp, TOLERANCE, `${what}: ${nameOf(tab)}'s panel is at its rect (Δ ${dp})`);
    Assert.lessOrEqual(db, TOLERANCE, `${what}: ${nameOf(tab)}'s browser fills it (Δ ${db})`);
    Assert.ok(tab.linkedBrowser.docShellIsActive, `${what}: ${nameOf(tab)} is live`);
  }
}

async function setWindowSize(win = window) {
  if (win.outerWidth !== WIDTH || win.outerHeight !== HEIGHT) {
    const resized = BrowserTestUtils.waitForEvent(win, "resize");
    win.resizeTo(WIDTH, HEIGHT);
    await resized;
  }
  await until(
    () => win.outerWidth === WIDTH && win.outerHeight === HEIGHT,
    "the window has its test size",
  );
}

/** The window is wider than tall, and half of it taller than wide: dwindle's spiral below. */
function assertSpiralArea(win = window) {
  const a = area(win);
  Assert.ok(a.width >= a.height && a.width / 2 < a.height, `content area ${a.width}×${a.height}`);
}

/**
 * A page at ?<name>2 with two history entries and a marker in its window, named `name`.
 * @returns {Promise<Element>}
 */
async function page(name, win = window) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${name}`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, `${PAGE}?${name}2`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?${name}2`);
  await SpecialPowers.spawn(tab.linkedBrowser, [name], (n) => {
    content.wrappedJSObject.vimmaMarker = n;
  });
  names.set(tab, name);
  return tab;
}

/** What a reload or a recreated page would change, per tab. */
function identity(tabs) {
  return tabs.map((t) => {
    const b = t.linkedBrowser;
    return {
      browser: b,
      outerWindowID: b.outerWindowID,
      browsingContext: b.browsingContext.id,
      innerWindowId: b.browsingContext.currentWindowGlobal.innerWindowId,
      history: b.browsingContext.sessionHistory.count,
    };
  });
}

/** No page was reloaded or recreated: same browser, window ids, history and marker. */
async function assertNotReloaded(tabs, before, what) {
  const now = identity(tabs);
  for (const [i, tab] of tabs.entries()) {
    const was = before[i];
    const is = now[i];
    Assert.equal(is.browser, was.browser, `${what}: ${nameOf(tab)} keeps its <browser>`);
    Assert.equal(is.outerWindowID, was.outerWindowID, `${what}: ${nameOf(tab)}'s outerWindowID`);
    Assert.equal(is.browsingContext, was.browsingContext, `${what}: ${nameOf(tab)}'s context`);
    Assert.equal(is.innerWindowId, was.innerWindowId, `${what}: ${nameOf(tab)}'s document`);
    Assert.equal(is.history, was.history, `${what}: ${nameOf(tab)}'s history length`);
    const marker = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.wrappedJSObject.vimmaMarker,
    );
    Assert.equal(marker, nameOf(tab), `${what}: ${nameOf(tab)}'s page state survives`);
  }
}

/** ctrl+b space, and the preset it shows. */
async function nextLayout(want, win = window) {
  prefix(" ", win);
  await until(() => notice(win) === `layout: ${want}`, `the notice says layout: ${want}`);
  Assert.equal(view(win).panes.layout, want, `the tree remembers ${want}`);
}

const opened = [];

async function reset(win = window) {
  while (view(win).panes) view(win).close();
  for (const tab of opened.splice(0)) if (!tab.closing && tab.parentNode) gBrowser.removeTab(tab);
  view(win).mode = "dwindle";
  view(win).max = Panes.PANES_MAX_DEFAULT;
  win.document.getElementById(NOTICE_ID)?.hidePopover?.();
  await nextFrame(win);
}

const startSize = [window.outerWidth, window.outerHeight];
registerCleanupFunction(async () => {
  await reset();
  window.resizeTo(...startSize);
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

/** ctrl+b enter, and the new pane's tab once its start page has loaded. */
async function newPane() {
  const before = gBrowser.selectedTab;
  prefix("KEY_Enter");
  await until(() => gBrowser.selectedTab !== before, "a new pane is focused");
  const tab = gBrowser.selectedTab;
  opened.push(tab);
  await until(
    () =>
      tab.linkedBrowser.currentURI.spec === START &&
      tab.linkedBrowser.contentDocument?.readyState === "complete",
    "the new pane's start page has loaded",
  );
  return tab;
}

add_task(async function ctrl_b_enter_splits_along_the_longer_side_up_to_the_max() {
  await setWindowSize();
  view().max = 4;
  assertSpiralArea();
  const a = await page("a");
  opened.push(a);
  await BrowserTestUtils.switchTab(gBrowser, a);
  await focusContent(a.linkedBrowser);

  const b = await newPane();
  names.set(b, "b");
  Assert.equal(shape(), "x[a,b]", "1 → 2: the wide pane splits side by side");
  Assert.equal(focusedLabel(), "b", "the new pane has focus");
  Assert.equal(gURLBar.value, "", "on the start page, its URL bar ready as after ctrl+b v");
  const c = await newPane();
  names.set(c, "c");
  Assert.equal(shape(), "x[a,y[b,c]]", "2 → 3: the tall pane splits stacked");
  const d = await newPane();
  names.set(d, "d");
  Assert.equal(shape(), "x[a,y[b,x[c,d]]]", "3 → 4: the wide quarter splits side by side");
  await assertRects("dwindle at 4");
  const rect = (t) => relRect(document.getElementById(t.linkedPanel));
  Assert.ok(rect(b).x > rect(a).x && rect(b).y < rect(c).y, "b is above c, right of a");
  Assert.ok(rect(c).x < rect(d).x && Math.abs(rect(c).y - rect(d).y) <= 1, "c | d side by side");

  const tabs = gBrowser.tabs.length;
  prefix("KEY_Enter");
  await until(() => notice() !== null, "a fifth pane is refused with a notice");
  Assert.equal(notice(), "New pane, along the longer side: at most 4 panes", "saying why");
  Assert.equal(gBrowser.tabs.length, tabs, "and opens no tab");
  Assert.equal(shape(), "x[a,y[b,x[c,d]]]", "the tree is unchanged");
  await reset();
});

add_task(async function manual_mode_makes_ctrl_b_enter_split_right() {
  await setWindowSize();
  const a = await page("a");
  opened.push(a);
  await BrowserTestUtils.switchTab(gBrowser, a);
  view().mode = "manual";
  names.set(await newPane(), "b");
  names.set(await newPane(), "c");
  Assert.equal(shape(), "x[a,b,c]", "each new pane goes right, as ctrl+b v");
  await reset();
});

/** Three or four live example.com pages in panes, built with view.split; focus on the last. */
async function panesOf(names) {
  const tabs = [];
  for (const n of names) tabs.push(await page(n));
  opened.push(...tabs);
  await BrowserTestUtils.switchTab(gBrowser, tabs[0]);
  for (const t of tabs.slice(1)) Assert.ok(view().split("vertical", { tab: t }).ok, nameOf(t));
  await focusContent(tabs.at(-1).linkedBrowser);
  return tabs;
}

/** Cycles all six presets with ctrl+b space from even-horizontal, checking each. */
async function cycle(tabs, want) {
  const before = identity(tabs);
  for (const [name, tree] of want) {
    await nextLayout(name);
    Assert.equal(shape(), tree, `${name}: the tree`);
    Assert.equal(focusedLabel(), nameOf(tabs.at(-1)), `${name}: focus stays on its pane`);
    Assert.equal(gBrowser.selectedTab, tabs.at(-1), `${name}: whose tab is selected`);
    await until(
      () => document.activeElement === tabs.at(-1).linkedBrowser,
      `${name}: and its page has keyboard focus`,
    );
    Assert.equal(tabs[0].splitview?.tabs.length, tabs.length, `${name}: one split of all`);
    await assertRects(name);
  }
  await assertNotReloaded(tabs, before, "after six presets");
}

add_task(async function cycling_every_preset_with_three_panes_moves_pages_without_reloads() {
  await setWindowSize();
  assertSpiralArea();
  const tabs = await panesOf(["a", "b", "c"]);
  view().zoom();
  Assert.ok(view().panes.zoom, "zoomed before the first preset");
  await cycle(tabs, [
    ["even-horizontal", "x[a,b,c]"],
    ["even-vertical", "y[a,b,c]"],
    ["main-vertical", "x[c,y[a,b]]"],
    ["main-horizontal", "y[c,x[a,b]]"],
    ["tiled", "y[x[c,a],b]"],
    ["dwindle", "x[c,y[a,b]]"],
  ]);
  Assert.equal(view().panes.zoom, null, "a preset ended the zoom");
  await nextLayout("even-horizontal");
  Assert.equal(shape(), "x[c,a,b]", "and the cycle wraps");
  await reset();
});

add_task(async function cycling_every_preset_with_four_panes_moves_pages_without_reloads() {
  await setWindowSize();
  assertSpiralArea();
  const tabs = await panesOf(["a", "b", "c", "d"]);
  await cycle(tabs, [
    ["even-horizontal", "x[a,b,c,d]"],
    ["even-vertical", "y[a,b,c,d]"],
    ["main-vertical", "x[d,y[a,b,c]]"],
    ["main-horizontal", "y[d,x[a,b,c]]"],
    ["tiled", "y[x[d,a],x[b,c]]"],
    ["dwindle", "x[d,y[a,x[b,c]]]"],
  ]);
  // tiled at 4 is a 2×2 grid on screen
  await nextLayout("even-horizontal");
  await nextLayout("even-vertical");
  await nextLayout("main-vertical");
  await nextLayout("main-horizontal");
  await nextLayout("tiled");
  const r = tabs.map((t) => relRect(document.getElementById(t.linkedPanel)));
  const [ra, rb, rc, rd] = r;
  Assert.ok(
    Math.abs(rd.y - ra.y) <= 1 && Math.abs(rb.y - rc.y) <= 1 && rb.y > rd.y + 100,
    "tiled: two rows of two",
  );
  Assert.ok(Math.abs(rd.x - rb.x) <= 1 && Math.abs(ra.x - rc.x) <= 1, "and two columns");
  await reset();
});

add_task(async function resize_mode_works_after_a_main_preset() {
  await setWindowSize();
  const tabs = await panesOf(["a", "b", "c"]);
  await nextLayout("even-horizontal");
  await nextLayout("even-vertical");
  await nextLayout("main-vertical");
  const main = () => view().panes.root.ratios[0];
  Assert.less(Math.abs(main() - 0.6), 1e-9, "the main pane is 60 %");
  prefix("r");
  await until(() => VimmaHost.status(window).mode === "resize", "resize mode");
  EventUtils.synthesizeKey("l");
  await until(() => Math.abs(main() - 0.65) < 1e-9, "l widens the main pane to 65 %");
  EventUtils.synthesizeKey("KEY_Escape");
  await assertRects("resized main-vertical");
  Assert.equal(view().panes.layout, "main-vertical", "the preset name stays for cycling");
  Assert.equal(tabs.length, 3);
  await reset();
});

add_task(async function layout_command_picks_a_preset_by_name() {
  await setWindowSize();
  const tabs = await panesOf(["a", "b", "c", "d"]);
  await focusContent(tabs.at(-1).linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("layout tiled");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => view().panes.layout === "tiled", ":layout tiled applies it");
  Assert.equal(shape(), "y[x[a,b],x[c,d]]", "a 2×2 grid");
  await assertRects(":layout tiled");
  await reset();
});

// Per workspace (m4 sub-spec 6's trees): the arrangement and the preset name come back after a
// switch and after a session restore; ctrl+b space then goes on from the remembered preset.

function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}

async function openWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await WindowWorkspaces.get(win).ready;
  await until(() => !!WindowWorkspaces.get(win).model, "the new window has its workspaces");
  await setWindowSize(win);
  return win;
}

async function switchTo(win, ws) {
  WindowWorkspaces.get(win).switchTo({ id: ws.id });
  await until(() => WindowWorkspaces.get(win).model.active === ws.id, `${ws.name} shows`);
}

/** A: a | b | c arranged main-horizontal with ctrl+b space; B: one pane. */
async function arrangedA(win, A, B) {
  await switchTo(win, A);
  const tabs = [];
  for (const n of ["a", "b", "c"]) tabs.push(await page(n, win));
  await BrowserTestUtils.switchTab(win.gBrowser, tabs[0]);
  for (const t of tabs.slice(1)) Assert.ok(view(win).split("vertical", { tab: t }).ok);
  for (const name of ["even-horizontal", "even-vertical", "main-vertical", "main-horizontal"]) {
    await nextLayout(name, win);
  }
  Assert.equal(shape(win), "y[c,x[a,b]]", "A is main-horizontal");
  await switchTo(win, B);
  return tabs;
}

add_task(async function a_workspace_keeps_its_preset_across_a_switch() {
  const A = workspace("lay-a");
  const B = workspace("lay-b");
  const win = await openWindow();
  const tabs = await arrangedA(win, A, B);
  Assert.equal(view(win).panes, null, "B has one pane");
  prefix(" ", win);
  await until(() => notice(win) === "Next layout: only one pane", "nothing to arrange in B");

  await switchTo(win, A);
  Assert.equal(shape(win), "y[c,x[a,b]]", "A's arrangement is back");
  Assert.equal(view(win).panes.layout, "main-horizontal", "with its preset name");
  await assertRects("A after the switch", win);
  await nextLayout("tiled", win);
  Assert.equal(shape(win), "y[x[c,a],b]", "ctrl+b space goes on from main-horizontal");
  Assert.equal(tabs.length, 3);
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_session_restore_brings_back_the_preset() {
  const A = workspace("lay-ra");
  const B = workspace("lay-rb");
  const w1 = await openWindow();
  await arrangedA(w1, A, B);
  await switchTo(w1, A);
  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?c2`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  await until(() => view(w2).panes?.layout === "main-horizontal", "the preset name is restored");
  Assert.equal(shape(w2), "y[c,x[a,b]]", "with A's arrangement");
  await nextLayout("tiled", w2);
  await BrowserTestUtils.closeWindow(w2);
});
