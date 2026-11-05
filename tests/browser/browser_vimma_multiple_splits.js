/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md (Delivery 3, behind vimma.feature.multiple_splits). A
// workspace holds several splits, one shown at a time, each in its own Firefox wrapper: marking
// tabs in the side panel on a lone tab makes a new split; selecting a tab of a split shows that
// split whole and suspends the other; the panel labels and stripes each split's rows; a
// workspace switch and a session restore keep every split.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PREF = "vimma.feature.multiple_splits";
const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";

const view = (win = window) => PaneViews.get(win);
const panel = (win = window) => win.document.getElementById(PANEL_ID);
const isOpen = (win = window) =>
  !!panel(win) && !panel(win).hidden && BrowserTestUtils.isVisible(panel(win));
const rows = (win = window) => [...(panel(win)?.querySelectorAll("[role=option]") ?? [])];
const titleOf = (row) => row.querySelector(".vimma-panel-title")?.textContent ?? "";
const rowOf = (name, win = window) => rows(win).find((r) => titleOf(r) === name);
const selected = (win = window) => panel(win).querySelector("[role=option][aria-selected=true]");
const count = (win = window) => panel(win).querySelector(".vimma-panel-count").textContent;
const markedTitles = (win = window) =>
  rows(win)
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map(titleOf);

function notice(win = window) {
  const n = win.document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

function nextFrame(win = window) {
  return new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

/** @type {Map<string, Element>} */
const byName = new Map();
const tab = (name) => /** @type {Element} */ (byName.get(name));
const nameOf = (t) => [...byName].find(([, x]) => x === t)?.[0] ?? t?.label;
const tabOf = (panelId, win = window) => win.gBrowser.tabs.find((t) => t.linkedPanel === panelId);

/** A tree with each leaf named by its tab: `x[a,b]`; none: "". */
function shape(panes, win = window) {
  const walk = (n) =>
    n.type === "leaf"
      ? nameOf(tabOf(n.tab, win))
      : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return panes ? walk(panes.root) : "";
}

/** Every split as `S<n>:<shape>`, and which one shows. */
function splitsOf(win = window) {
  const { splits, shown } = view(win).splits;
  return { all: splits.map((x) => `S${x.number}:${shape(x, win)}`).join(" "), shown };
}

/** A loaded page titled `name` in `win`. */
async function page(name, win = window) {
  const t = BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${name}`);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    content.document.title = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, t);
  return t;
}

/** ctrl+b, then `key`. */
function prefix(key, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, {}, win);
}

async function openPanel(win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  prefix("b", win);
  await until(() => isOpen(win), "ctrl+b b opens the side panel");
}

/** j / k until the highlight is on the row titled `name`. */
async function goTo(name, win = window) {
  const at = rows(win).findIndex((r) => titleOf(r) === name);
  Assert.greaterOrEqual(at, 0, `${name} is listed`);
  for (let i = 0; i < 30 && rows(win).indexOf(selected(win)) !== at; i++) {
    EventUtils.synthesizeKey(rows(win).indexOf(selected(win)) < at ? "j" : "k", {}, win);
  }
  await until(() => titleOf(selected(win)) === name, `the highlight is on ${name}`);
}

/** `space` on each named row. */
async function mark(names, win = window) {
  for (const n of names) {
    await goTo(n, win);
    EventUtils.synthesizeKey(" ", {}, win);
    await until(() => markedTitles(win).includes(n), `${n} is marked`);
  }
}

/** Marks `names` in the panel and presses Enter: a new split on a lone tab. */
async function newSplit(names, win = window) {
  await openPanel(win);
  Assert.deepEqual(markedTitles(win), [], "on a lone tab nothing starts marked");
  await mark(names, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await until(() => !isOpen(win), "Enter closes the panel");
}

/** Selects `t` and waits for its split to settle. */
async function pick(t, win = window) {
  win.gBrowser.selectedTab = t;
  await nextFrame(win);
}

/** The tab's panel is laid out on screen (its rectangle has a size). */
function laidOut(t, win = window) {
  const r = win.document.getElementById(t.linkedPanel).getBoundingClientRect();
  return r.width > 50 && r.height > 50;
}

/** @type {string[]} */
const created = [];
/** @type {Window[]} */
const windows = [];
/** @type {Element[]} */
const opened = [];

registerCleanupFunction(async () => {
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape", {});
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const t of opened.splice(0)) if (!t.closing && t.parentNode) gBrowser.removeTab(t);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  view().maxSplits = 9;
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await WindowWorkspaces.get(window).ready;
  for (const n of ["a", "b", "c", "d", "e", "f"]) opened.push(await page(n));
  await BrowserTestUtils.switchTab(gBrowser, tab("a"));
});

add_task(async function marking_tabs_on_a_lone_tab_makes_a_second_split() {
  Assert.ok(view().showTabs([tab("a"), tab("b")], tab("a")).ok, "S1: a | b");
  await until(() => laidOut(tab("b")), "S1 is laid out");
  Assert.ok(view().resize("wider", 0.1).ok, "a is made wider by hand");
  const s1 = view().panes;
  await pick(tab("e"));
  Assert.ok(view().hidden, "e shows alone, S1 is hidden");

  await openPanel();
  Assert.equal(count(), "split: 2 panes (hidden)", "one hidden split reads as before");
  Assert.equal(rowOf("a").dataset.split, "1", "a's row carries S1");
  Assert.equal(rowOf("a").querySelector(".vimma-panel-split").textContent, "S1", "as text");
  Assert.equal(
    rowOf("a").querySelector(".vimma-panel-split").getAttribute("aria-label"),
    ", split 1",
    "and in its accessible name",
  );
  Assert.ok(!rowOf("e").dataset.split, "e is in no split");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "Esc closes the panel");

  await newSplit(["c", "d"]);
  await until(() => splitsOf().shown === 2, "S2 shows");
  Assert.equal(splitsOf().all, "S1:x[a,b] S2:x[c,d]", "two splits, numbered 1 and 2");
  await until(() => laidOut(tab("c")) && laidOut(tab("d")), "S2 is laid out");
  Assert.ok(tab("c").splitview && tab("a").splitview, "each split is in a wrapper");
  Assert.notEqual(tab("c").splitview, tab("a").splitview, "its own wrapper");
  Assert.ok(!tab("a").linkedBrowser.docShellIsActive, "S1's pages sleep");
  const kept = view().splits.splits.find((x) => x.number === 1);
  Assert.deepEqual(kept.root.ratios, s1.root.ratios, "S1 keeps its sizes");

  await openPanel();
  Assert.equal(count(), "S2: 2 panes · 2 splits", "the header names the shown split");
  Assert.deepEqual(markedTitles(), ["c", "d"], "the shown split's tabs start marked");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "Esc closes the panel");
});

add_task(async function selecting_a_tab_of_a_split_shows_that_split_whole() {
  await pick(tab("b"));
  await until(() => splitsOf().shown === 1, "S1 shows");
  Assert.equal(shape(view().panes), "x[a,b]", "whole");
  Assert.equal(nameOf(tabOf(Panes.leaves(view().panes).at(-1).tab)), "b", "b is its last pane");
  Assert.equal(gBrowser.selectedTab, tab("b"), "focus on b's pane");
  await until(() => laidOut(tab("a")) && laidOut(tab("b")), "S1 is laid out");
  await until(
    () => tab("a").linkedBrowser.docShellIsActive && tab("b").linkedBrowser.docShellIsActive,
    "S1's pages are live",
  );
  Assert.ok(!laidOut(tab("c")), "S2's panels are not on screen");
  Assert.ok(!tab("c").linkedBrowser.docShellIsActive, "S2's pages sleep");
  Assert.equal(gBrowser.splitViews.length, 2, "both wrappers stay");

  await pick(tab("d"));
  await until(() => splitsOf().shown === 2, "picking d shows S2 again");
  Assert.equal(gBrowser.selectedTab, tab("d"), "focus on d's pane");
});

add_task(async function a_lone_tab_hides_both_and_splitting_it_names_the_split() {
  await pick(tab("f"));
  Assert.equal(splitsOf().shown, null, "no split shows");
  Assert.ok(view().hidden, "the current tree is a hidden view");
  await openPanel();
  Assert.equal(count(), "2 splits (none shown)", "the header counts them");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "Esc closes the panel");

  await focusContent(gBrowser.selectedBrowser);
  prefix("v");
  await until(() => notice() !== null, "a notice");
  Assert.equal(
    notice(),
    "split S2 is hidden: select one of its tabs (ctrl+b b) to go back, or mark tabs there for a new split",
    "naming the split shown last",
  );
  Assert.equal(splitsOf().all, "S1:x[a,b] S2:x[c,d]", "nothing changed");
  EventUtils.synthesizeKey("KEY_Escape", {});
});

add_task(async function marking_a_tab_of_another_split_moves_it_and_ends_that_split() {
  await newSplit(["a", "e"]);
  await until(() => splitsOf().shown === 1, "the new split shows");
  Assert.equal(
    splitsOf().all,
    "S1:x[a,e] S2:x[c,d]",
    "a left S1, which ended with one pane; the new split took the free number 1",
  );
  Assert.ok(!tab("b").splitview, "b is in no split");
  Assert.ok(!laidOut(tab("b")), "and not on screen");
  Assert.equal(tab("a").splitview, tab("e").splitview, "a and e share a wrapper");
});

add_task(async function past_max_splits_is_refused_and_nothing_changes() {
  view().maxSplits = 2;
  await pick(tab("f"));
  await openPanel();
  await mark(["b", "f"]);
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => notice() !== null, "a notice");
  Assert.equal(notice(), "new split: at most 2 splits in a workspace", "naming the limit");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.deepEqual(markedTitles(), ["b", "f"], "with its marks");
  Assert.equal(splitsOf().all, "S1:x[a,e] S2:x[c,d]", "nothing changed");
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape", {});
  view().maxSplits = 9;
});

add_task(async function closing_a_tab_of_a_hidden_split_ends_it() {
  await pick(tab("a"));
  await until(() => splitsOf().shown === 1, "S1 shows");
  const gone = await page("g");
  Assert.ok(view().showTabs([tab("a"), tab("e"), gone], tab("a")).ok, "S1: a, e, g");
  await pick(tab("c"));
  await until(() => splitsOf().shown === 2, "S2 shows");
  gBrowser.removeTab(gone);
  await until(() => splitsOf().all === "S1:x[a,e] S2:x[c,d]", "g's pane closes in hidden S1");
  gBrowser.removeTab(tab("e"));
  await until(() => splitsOf().all === "S2:x[c,d]", "S1 ends with one pane");
  await until(() => !tab("a").splitview, "a's wrapper is undone");
  opened.splice(opened.indexOf(tab("e")), 1);
  byName.delete("e");
});

add_task(async function a_workspace_switch_and_a_session_restore_keep_every_split() {
  const A = WorkspaceStore.addWorkspace({ name: "ms-a", color: "blue", icon: "briefcase" });
  const B = WorkspaceStore.addWorkspace({ name: "ms-b", color: "green", icon: "briefcase" });
  created.push(A.id, B.id);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await WindowWorkspaces.get(win).ready;
  await until(() => !!WindowWorkspaces.get(win).model, "the new window has its workspaces");
  WindowWorkspaces.get(win).switchTo({ id: A.id });
  await until(() => win.gBrowser.selectedTab.userContextId === A.userContextId, "A shows");
  const pages = [];
  for (const n of ["p", "q", "r", "s", "t"]) pages.push(await page(n, win));
  Assert.ok(view(win).showTabs([tab("p"), tab("q")], tab("p")).ok, "S1: p | q");
  await pick(tab("t"), win);
  await newSplit(["r", "s"], win);
  await until(() => splitsOf(win).shown === 2, "S2 shows");
  await pick(tab("q"), win);
  await until(() => splitsOf(win).shown === 1, "S1 shows, S2 hidden");

  WindowWorkspaces.get(win).switchTo({ id: B.id });
  await until(() => WindowWorkspaces.get(win).model.active === B.id, "B shows");
  Assert.equal(splitsOf(win).all, "", "B has no split");
  WindowWorkspaces.get(win).switchTo({ id: A.id });
  await until(() => splitsOf(win).shown === 1, "back in A, S1 shows");
  Assert.equal(splitsOf(win).all, "S1:x[p,q] S2:x[r,s]", "both splits came back with A");
  await until(() => laidOut(tab("p"), win) && laidOut(tab("q"), win), "S1 is laid out");

  const uuid = (t) => SessionStore.getCustomTabValue(t, "vimma-tab");
  const ids = new Map(pages.map((t) => [uuid(t), nameOf(t)]));
  await TabStateFlusher.flushWindow(win);
  await TestUtils.waitForTick();
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?t`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(win);

  const w2 = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(w2);
  await WindowWorkspaces.get(w2).ready;
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  for (const t of w2.gBrowser.tabs) if (ids.has(uuid(t))) byName.set(ids.get(uuid(t)), t);
  await until(() => view(w2).splits.splits.length === 2, "both splits are restored");
  Assert.equal(splitsOf(w2).all, "S1:x[p,q] S2:x[r,s]", "with their numbers");
  Assert.equal(splitsOf(w2).shown, 1, "and S1 shown");
  await pick(tab("s"), w2);
  await until(() => splitsOf(w2).shown === 2, "picking s shows S2");
  await until(() => laidOut(tab("r"), w2) && laidOut(tab("s"), w2), "S2 is laid out");
});
