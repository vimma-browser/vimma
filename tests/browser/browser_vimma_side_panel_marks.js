/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m4-side-panel-multiselect.md. In the side panel `space` marks a row and leaves
// the highlight on it (only `j` / `k` move it), `V` starts a range that `space` / `V` marks, `Esc` ends the range, then clears the marks,
// then closes; `Enter` with marks shows the marked tabs together as the workspace's panes, in the
// workspace's layout, without reloading a page. Past `[panes] max` it is refused.
// With a split the panel opens with its panes marked (docs/specs/side-panel-unsplit.md, tested in
// browser_vimma_side_panel_unsplit.js); these tasks unmark them first to choose a whole new set.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";
const WIDTH = 1280;
const HEIGHT = 800;

const view = () => PaneViews.get(window);
const panel = () => document.getElementById(PANEL_ID);
const isOpen = () => !!panel() && !panel().hidden && BrowserTestUtils.isVisible(panel());
const list = () => panel().querySelector("[role=listbox]");
const rows = () => [...(panel()?.querySelectorAll("[role=option]") ?? [])];
const titleOf = (row) => row.querySelector(".vimma-panel-title")?.textContent ?? "";
const selected = () => panel().querySelector("[role=option][aria-selected=true]");
const count = () => panel().querySelector(".vimma-panel-count");
const markedTitles = () =>
  rows()
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map(titleOf);

function notice() {
  const n = document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** @type {Map<string, Element>} */
const byName = new Map();
const nameOf = (tab) => [...byName].find(([, t]) => t === tab)?.[0] ?? tab.label;
const tabOf = (panelId) => gBrowser.tabs.find((t) => t.linkedPanel === panelId);

/** The shown tree with each leaf named by its tab: `x[a,y[b,c]]`; one pane: "". */
function shape() {
  const p = view().panes;
  const walk = (n) =>
    n.type === "leaf" ? nameOf(tabOf(n.tab)) : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return p ? walk(p.root) : "";
}

function focusedName() {
  const p = view().panes;
  return nameOf(tabOf(Panes.leaves(p).find((l) => l.pane === p.focus).tab));
}

/** A page titled `name` with a tall body, a text field, history of two, and a JS marker. */
async function page(name) {
  const tab = BrowserTestUtils.addTab(gBrowser, `${PAGE}?${name}`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, `${PAGE}?${name}2`);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?${name}2`);
  await SpecialPowers.spawn(tab.linkedBrowser, [name], (n) => {
    const doc = content.document;
    doc.title = n;
    const input = doc.createElement("input");
    input.id = "field";
    input.value = `typed in ${n}`;
    const tall = doc.createElement("div");
    tall.style.height = "5000px";
    doc.body.prepend(input, tall);
    content.scrollTo(0, 1234);
    content.wrappedJSObject.vimmaMarker = n;
  });
  await until(() => tab.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, tab);
  return tab;
}

/** What a reload or a recreated page would change. */
function identity(tabs) {
  return tabs.map((t) => {
    const b = t.linkedBrowser;
    return {
      browser: b,
      outerWindowID: b.outerWindowID,
      innerWindowId: b.browsingContext.currentWindowGlobal.innerWindowId,
      history: b.browsingContext.sessionHistory.count,
    };
  });
}

/** No page reloaded: same browser and document, history, marker, scroll and typed text. */
async function assertNotReloaded(tabs, before, what) {
  const now = identity(tabs);
  for (const [i, tab] of tabs.entries()) {
    const n = nameOf(tab);
    Assert.equal(now[i].browser, before[i].browser, `${what}: ${n} keeps its <browser>`);
    Assert.equal(now[i].outerWindowID, before[i].outerWindowID, `${what}: ${n}'s window`);
    Assert.equal(now[i].innerWindowId, before[i].innerWindowId, `${what}: ${n}'s document`);
    Assert.equal(now[i].history, before[i].history, `${what}: ${n}'s history length`);
    const state = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
      marker: content.wrappedJSObject.vimmaMarker,
      field: content.document.getElementById("field")?.value,
      scrolled: content.scrollY,
    }));
    Assert.equal(state.marker, n, `${what}: ${n}'s page state survives`);
    Assert.equal(state.field, `typed in ${n}`, `${what}: ${n}'s typed text survives`);
    Assert.equal(state.scrolled, 1234, `${what}: ${n}'s scroll position survives`);
  }
}

/** ctrl+b, then `key`. */
function prefix(key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, {});
}

async function openPanel() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  prefix("b");
  await until(isOpen, "ctrl+b b opens the side panel");
}

/** j / k until the highlight is on the row titled `name`. */
async function goTo(name) {
  const at = rows().findIndex((r) => titleOf(r) === name);
  Assert.greaterOrEqual(at, 0, `${name} is listed`);
  for (let i = 0; i < 20 && rows().indexOf(selected()) !== at; i++) {
    EventUtils.synthesizeKey(rows().indexOf(selected()) < at ? "j" : "k", {});
  }
  await until(() => titleOf(selected()) === name, `the highlight is on ${name}`);
}

/** Marks each named row with space. */
async function mark(...names) {
  for (const n of names) {
    await goTo(n);
    EventUtils.synthesizeKey(" ", {});
    await until(() => markedTitles().includes(n), `${n} is marked`);
    Assert.equal(titleOf(selected()), n, `the highlight stays on ${n}`);
  }
}

/**
 * Unmarks the split's panes, which the panel marks as it opens (docs/specs/side-panel-unsplit.md),
 * so the marks that follow are the whole new set, as these tasks were written.
 */
async function unmarkPanes() {
  for (const n of markedTitles()) {
    await goTo(n);
    EventUtils.synthesizeKey(" ", {});
    await until(() => !markedTitles().includes(n), `${n} is unmarked`);
    Assert.equal(titleOf(selected()), n, `the highlight stays on ${n}`);
  }
}

async function enter() {
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => !isOpen(), "Enter closes the panel");
}

/** @type {Element[]} */
const opened = [];
const startSize = [window.outerWidth, window.outerHeight];

async function reset() {
  if (isOpen()) {
    for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape", {});
  }
  while (view().panes) view().close();
  view().max = Panes.PANES_MAX_DEFAULT;
  view().mode = "dwindle";
  document.getElementById(NOTICE_ID)?.hidePopover?.();
  await nextFrame();
}

registerCleanupFunction(async () => {
  await reset();
  for (const tab of opened.splice(0)) if (!tab.closing && tab.parentNode) gBrowser.removeTab(tab);
  window.resizeTo(...startSize);
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

add_task(async function setup_five_pages() {
  await WindowWorkspaces.get(window).ready;
  if (window.outerWidth !== WIDTH || window.outerHeight !== HEIGHT) {
    const resized = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeTo(WIDTH, HEIGHT);
    await resized;
  }
  for (const n of ["a", "b", "c", "d", "e"]) opened.push(await page(n));
  await BrowserTestUtils.switchTab(gBrowser, byName.get("a"));
});

add_task(async function space_marks_in_place_with_a_marker_not_only_colour() {
  await openPanel();
  Assert.equal(list().getAttribute("aria-multiselectable"), null, "still single-select");
  Assert.ok(!rows().some((r) => r.hasAttribute("aria-checked")), "no checked state unmarked");
  Assert.equal(count().textContent, "", "no count");
  Assert.equal(count().getAttribute("role"), "status", "the count is a status, read out");

  await goTo("b");
  EventUtils.synthesizeKey(" ", {});
  await until(() => markedTitles().length === 1, "space marks b");
  Assert.deepEqual(markedTitles(), ["b"], "b is aria-checked");
  Assert.equal(titleOf(selected()), "b", "and the highlight stays on b");
  EventUtils.synthesizeKey("j", {});
  await until(() => titleOf(selected()) === "c", "j moves the highlight down to c");
  Assert.equal(selected().getAttribute("aria-checked"), "false", "c is checkable, unchecked");
  EventUtils.synthesizeKey("k", {});
  await until(() => titleOf(selected()) === "b", "k moves it back up to b");
  EventUtils.synthesizeKey("k", {});
  await until(() => titleOf(selected()) === "a", "and k again to a, above the mark");
  Assert.deepEqual(markedTitles(), ["b"], "moving changes no mark");
  const b = rows().find((r) => titleOf(r) === "b");
  const gutter = b.querySelector(".vimma-panel-mark");
  Assert.equal(gutter?.textContent, "●", "a ● in the gutter, readable without colour");
  Assert.equal(gutter.getAttribute("aria-hidden"), "true", "the glyph itself is not read");
  Assert.ok(b.classList.contains("vimma-panel-marked"), "the row carries the marked class");
  Assert.notEqual(
    getComputedStyle(b).borderInlineStartStyle,
    "none",
    "and a bar on its leading edge",
  );
  Assert.equal(
    rows()
      .find((r) => titleOf(r) === "c")
      .querySelector(".vimma-panel-mark")?.textContent ?? "",
    "",
    "an unmarked row has an empty gutter",
  );
  Assert.equal(count().textContent, "1 marked", "the header counts it");

  await goTo("b");
  EventUtils.synthesizeKey(" ", {});
  await until(() => markedTitles().length === 0, "space on b again unmarks it");
  Assert.equal(titleOf(selected()), "b", "the highlight stays on b");
  Assert.ok(!rows().some((r) => r.hasAttribute("aria-checked")), "no checked state again");
  Assert.equal(VimmaHost.status(window).mode, "panel", "still in panel mode");
});

add_task(async function v_marks_a_range_and_esc_unwinds_range_marks_then_panel() {
  await goTo("a");
  EventUtils.synthesizeKey("V", {});
  EventUtils.synthesizeKey("j", {});
  EventUtils.synthesizeKey("j", {});
  await until(() => count().textContent === "range: 3", "the range covers a, b, c");
  Assert.equal(
    rows().filter((r) => r.classList.contains("vimma-panel-in-range")).length,
    3,
    "three rows show they are in the range",
  );
  EventUtils.synthesizeKey("V", {});
  await until(() => markedTitles().length === 3, "V again marks the range");
  Assert.deepEqual(markedTitles(), ["a", "b", "c"], "a, b and c");
  Assert.equal(count().textContent, "3 marked");

  EventUtils.synthesizeKey("V", {});
  EventUtils.synthesizeKey("j", {});
  await until(() => count().textContent === "range: 2 · 3 marked", "a range on top of marks");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => count().textContent === "3 marked", "Esc ends the range first");
  Assert.ok(isOpen(), "the panel stays open");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => markedTitles().length === 0, "Esc then clears the marks");
  Assert.ok(isOpen(), "the panel still stays open");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "a third Esc closes it");
});

add_task(async function enter_with_two_marks_shows_them_side_by_side_without_reloading() {
  const tabs = ["b", "d"].map((n) => byName.get(n));
  const before = identity(tabs);
  await openPanel();
  await mark("b", "d");
  await goTo("d");
  await enter();
  await until(() => shape() === "x[b,d]", "b and d side by side, in tab order");
  Assert.equal(focusedName(), "d", "the highlighted marked row has focus");
  Assert.equal(gBrowser.selectedTab, byName.get("d"), "its tab is selected");
  await until(
    () => document.activeElement === byName.get("d").linkedBrowser,
    "and its page has keyboard focus",
  );
  await assertNotReloaded(tabs, before, "two together");
  for (const t of tabs) Assert.ok(t.linkedBrowser.docShellIsActive, `${nameOf(t)} is live`);
});

add_task(async function three_marks_replace_the_split_and_the_unmarked_tab_stays_open() {
  const tabs = ["a", "c", "e"].map((n) => byName.get(n));
  const before = identity(tabs);
  await openPanel();
  await unmarkPanes();
  await mark("a", "c", "e");
  await goTo("b");
  await enter();
  await until(() => shape() === "x[a,y[c,e]]", "a dwindle of a, c and e");
  Assert.equal(focusedName(), "a", "the highlight was unmarked: the first marked has focus");
  for (const n of ["b", "d"]) {
    const t = byName.get(n);
    Assert.ok(t.isConnected && !t.closing, `${n}, in the old split, is still open`);
    Assert.ok(!t.splitview, `${n} left the split`);
  }
  await assertNotReloaded(tabs, before, "three together");
});

add_task(async function four_marks_make_the_dwindle_spiral() {
  const tabs = ["a", "b", "c", "d"].map((n) => byName.get(n));
  const before = identity(tabs);
  await openPanel();
  await unmarkPanes();
  await mark("a", "b", "c", "d");
  // Row order is tab order, and Firefox's split view keeps a split's tabs together in the tab
  // strip: the last split (a, c, e) moved c before b.
  const [p, q, r, s] = markedTitles();
  Assert.deepEqual([p, q, r, s], ["a", "c", "b", "d"], "the marked rows, in today's tab order");
  await enter();
  const want = `x[${p},y[${q},x[${r},${s}]]]`;
  await until(() => shape() === want, `a dwindle spiral of four, in row order: ${want}`);
  await assertNotReloaded(tabs, before, "four together");
  Assert.equal(view().panes.layout, undefined, "no preset is stored by the dwindle default");
});

add_task(async function five_marks_past_the_max_are_refused_and_nothing_changes() {
  view().max = 4;
  const was = shape();
  const selectedTab = gBrowser.selectedTab;
  await openPanel();
  await unmarkPanes();
  await mark("a", "b", "c", "d", "e");
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => notice() !== null, "a notice");
  Assert.equal(notice(), "Show together: at most 4 panes", "naming the limit");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.equal(markedTitles().length, 5, "with its marks");
  Assert.equal(shape(), was, "the panes are unchanged");
  Assert.equal(gBrowser.selectedTab, selectedTab, "and so is the selected tab");
  await reset();
});

add_task(async function a_stored_preset_arranges_them_and_enter_on_another_row_shows_it_alone() {
  if (gBrowser.selectedTab !== byName.get("a")) {
    await BrowserTestUtils.switchTab(gBrowser, byName.get("a"));
  }
  Assert.ok(view().split("vertical", { tab: byName.get("b") }).ok, "a | b");
  Assert.ok(view().arrange("main-horizontal").ok, "main-horizontal stored");
  await openPanel();
  await unmarkPanes();
  await mark("c", "d", "e");
  await goTo("d");
  await enter();
  await until(() => shape() === "y[d,x[c,e]]", "main-horizontal, the focused d as main");
  Assert.equal(view().panes.layout, "main-horizontal", "the preset stays stored");

  // With the split's marks unchanged, Enter goes to the row (side-panel-unsplit decision 12): a
  // tab outside the split shows alone, the split kept as a hidden view (decision 21).
  await openPanel();
  await goTo("b");
  await enter();
  await until(() => gBrowser.selectedTab === byName.get("b"), "Enter goes to that tab");
  Assert.equal(view().panes.hidden, true, "shown alone, the split hidden");
  Assert.equal(shape(), "y[d,x[c,e]]", "the split itself is unchanged");
  await reset();
});
