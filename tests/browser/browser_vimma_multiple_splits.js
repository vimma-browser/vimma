/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md (Delivery 3, on by default since Delivery 6). A
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

const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";

/**
 * The window's split view, which VimmaHost made when it started the window.
 * @param {BrowserWindow} [win]
 */
const view = (win = window) => /** @type {PaneView} */ (PaneViews.get(win));
/**
 * The window's workspaces, which VimmaHost made when it started the window.
 * @param {BrowserWindow} [win]
 */
const workspaces = (win = window) =>
  /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win));
/**
 * The window's workspaces once their model is built.
 * @param {BrowserWindow} [win]
 */
const live = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
/** @param {Window} [win] */
const panel = (win = window) =>
  /** @type {HTMLElement | null} */ (win.document.getElementById(PANEL_ID));
/**
 * The side panel, which a test reads while it is open.
 * @param {Window} [win]
 */
const shownPanel = (win = window) => /** @type {HTMLElement} */ (panel(win));
/** @param {Window} [win] */
const isOpen = (win = window) =>
  !!panel(win) && !shownPanel(win).hidden && BrowserTestUtils.isVisible(shownPanel(win));
/**
 * The panel's rows (side-panel.mjs makes each an <li>).
 * @param {Window} [win]
 */
const rows = (win = window) => [
  .../** @type {NodeListOf<HTMLElement> | never[]} */ (
    panel(win)?.querySelectorAll("[role=option]") ?? []
  ),
];
/** @param {Element} row */
const titleOf = (row) => row.querySelector(".vimma-panel-title")?.textContent ?? "";
/**
 * @param {string} name
 * @param {Window} [win]
 */
const rowOf = (name, win = window) => rows(win).find((r) => titleOf(r) === name);
/**
 * The listed row titled `name`.
 * @param {string} name
 */
const listedRow = (name) => /** @type {HTMLElement} */ (rowOf(name));
/** @param {Window} [win] */
const selected = (win = window) =>
  /** @type {HTMLElement | null} */ (
    shownPanel(win).querySelector("[role=option][aria-selected=true]")
  );
/** @param {Window} [win] */
const count = (win = window) =>
  /** @type {Element} */ (shownPanel(win).querySelector(".vimma-panel-count")).textContent;
/** @param {Window} [win] */
const markedTitles = (win = window) =>
  rows(win)
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map(titleOf);

/** @param {Window} [win] */
function notice(win = window) {
  const n = win.document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

/**
 * @param {() => unknown} cond
 * @param {string} msg
 */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** @param {Window} [win] */
function nextFrame(win = window) {
  return new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

/** @type {Map<string, SplitTab>} */
const byName = new Map();
/**
 * The tab a test named: page() names each tab it opens.
 * @param {string} name
 */
const tab = (name) => /** @type {SplitTab} */ (byName.get(name));
/** @param {MozTabbrowserTab | undefined} t */
const nameOf = (t) => [...byName].find(([, x]) => x === t)?.[0] ?? t?.label;
/**
 * @param {string} panelId
 * @param {BrowserWindow} [win]
 */
const tabOf = (panelId, win = window) => win.gBrowser.tabs.find((t) => t.linkedPanel === panelId);

/**
 * A tree with each leaf named by its tab: `x[a,b]`; none: "".
 * @param {Panes | null} panes
 * @param {BrowserWindow} [win]
 */
function shape(panes, win = window) {
  /** @type {(n: Panes["root"]) => string | undefined} */
  const walk = (n) =>
    n.type === "leaf" ? nameOf(tabOf(n.tab, win)) : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return panes ? walk(panes.root) : "";
}

/**
 * The ratios of the root of a tree that a test has split.
 * @param {Panes | null | undefined} panes
 * @param {string} what
 */
function rootRatios(panes, what) {
  const root = panes?.root;
  Assert.equal(root?.type, "split", `${what} is split`);
  // A leaf or no tree fails above, then throws here.
  return /** @type {PaneSplit} */ (root).ratios;
}

/**
 * Every split as `S<n>:<shape>`, and which one shows.
 * @param {BrowserWindow} [win]
 */
function splitsOf(win = window) {
  const { splits, shown } = view(win).splits;
  return { all: splits.map((x) => `S${x.number}:${shape(x, win)}`).join(" "), shown };
}

/**
 * A loaded page titled `name` in `win`.
 * @param {string} name
 * @param {BrowserWindow} [win]
 */
async function page(name, win = window) {
  // A loaded tab has its panel.
  const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${name}`));
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    content.document.title = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, t);
  return t;
}

/**
 * ctrl+b, then `key`.
 * @param {string} key
 * @param {Window} [win]
 */
function prefix(key, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, {}, win);
}

/** @param {BrowserWindow} [win] */
async function openPanel(win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  if (win === window) await focusContent(browser);
  else {
    // head.js's focusContent checks the test's own window.
    await SimpleTest.promiseFocus(browser);
    await until(() => win.document.activeElement === browser, "focus is in the content browser");
  }
  prefix("b", win);
  await until(() => isOpen(win), "ctrl+b b opens the side panel");
}

/**
 * The place of the highlighted row; -1 with none, as indexOf of a missing row gives.
 * @param {Window} win
 */
function selectedAt(win) {
  return rows(win).indexOf(/** @type {HTMLElement} */ (selected(win)));
}

/**
 * j / k until the highlight is on the row titled `name`.
 * @param {string} name
 * @param {Window} [win]
 */
async function goTo(name, win = window) {
  const at = rows(win).findIndex((r) => titleOf(r) === name);
  Assert.greaterOrEqual(at, 0, `${name} is listed`);
  for (let i = 0; i < 30 && selectedAt(win) !== at; i++) {
    EventUtils.synthesizeKey(selectedAt(win) < at ? "j" : "k", {}, win);
  }
  // With no highlight, titleOf throws and the wait fails, as before.
  await until(
    () => titleOf(/** @type {HTMLElement} */ (selected(win))) === name,
    `the highlight is on ${name}`,
  );
}

/**
 * `space` on each named row.
 * @param {string[]} names
 * @param {Window} [win]
 */
async function mark(names, win = window) {
  for (const n of names) {
    await goTo(n, win);
    EventUtils.synthesizeKey(" ", {}, win);
    await until(() => markedTitles(win).includes(n), `${n} is marked`);
  }
}

/**
 * Marks `names` in the panel and presses Enter: a new split on a lone tab.
 * @param {string[]} names
 * @param {BrowserWindow} [win]
 */
async function newSplit(names, win = window) {
  await openPanel(win);
  Assert.deepEqual(markedTitles(win), [], "on a lone tab nothing starts marked");
  await mark(names, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await until(() => !isOpen(win), "Enter closes the panel");
}

/**
 * Selects `t` and waits for its split to settle.
 * @param {MozTabbrowserTab} t
 * @param {BrowserWindow} [win]
 */
async function pick(t, win = window) {
  win.gBrowser.selectedTab = t;
  await nextFrame(win);
}

/**
 * The tab's panel is laid out on screen (its rectangle has a size).
 * @param {SplitTab} t
 * @param {Window} [win]
 */
function laidOut(t, win = window) {
  const r = /** @type {Element} */ (
    win.document.getElementById(t.linkedPanel)
  ).getBoundingClientRect();
  return r.width > 50 && r.height > 50;
}

/** @type {string[]} */
const created = [];
/** @type {Window[]} */
const windows = [];
/** @type {SplitTab[]} */
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

add_task(async function setup_six_pages() {
  await workspaces().ready;
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
  Assert.equal(listedRow("a").dataset.split, "1", "a's row carries S1");
  // A row of a split has its label, and its text is checked here.
  const label = /** @type {Element} */ (listedRow("a").querySelector(".vimma-panel-split"));
  Assert.equal(label.textContent, "S1", "as text");
  Assert.equal(label.getAttribute("aria-label"), ", split 1", "and in its accessible name");
  Assert.ok(!listedRow("e").dataset.split, "e is in no split");
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
  Assert.deepEqual(rootRatios(kept, "the kept S1"), rootRatios(s1, "S1"), "S1 keeps its sizes");

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
  // S1 shows, so the view has panes, and a tree has leaves.
  const last = Panes.leaves(/** @type {Panes} */ (view().panes)).at(-1);
  Assert.equal(nameOf(tabOf(/** @type {{ tab: string }} */ (last).tab)), "b", "b is its last pane");
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

/**
 * Runs `fn` while the layers the async tab switcher waits for are held back, then hands them
 * over late, as a slow compositor does (#605): the switcher is still loading the tab selected
 * first when the next one is selected.
 * @param {() => Promise<void>} fn
 */
async function withLayersLate(fn) {
  /** @type {Element[]} */
  const held = [];
  const hold = (/** @type {Event} */ e) => {
    e.stopImmediatePropagation();
    held.push(/** @type {Element} */ (e.originalTarget));
  };
  window.addEventListener("MozLayerTreeReady", hold, true);
  try {
    await fn();
  } finally {
    window.removeEventListener("MozLayerTreeReady", hold, true);
  }
  for (const browser of held) {
    gBrowser._switcher?.handleEvent({ type: "MozLayerTreeReady", originalTarget: browser });
  }
}

/**
 * The compositor has cleared the layers of `tabs`, put to sleep by an earlier switch. A tab still
 * holding layers when it is selected again counts as loaded at once (AsyncTabSwitcher's
 * getTabState and setTabState read `hasLayers`), so the switcher would never load it.
 * @param {SplitTab[]} tabs
 * @param {string} names
 */
function layersCleared(tabs, names) {
  return until(
    () => tabs.every((t) => !t.linkedBrowser.hasLayers),
    `${names}'s layers are cleared`,
  );
}

/**
 * Selects `t` inside withLayersLate and waits until its page has painted, while the switcher,
 * not told yet, still loads it. The switcher gives up on a load after 400 ms
 * (TAB_SWITCH_TIMEOUT), sooner than a slow runner may paint; its timer is stretched so the
 * load stays pending until the held layers are handed over.
 * @param {SplitTab} t
 * @param {string} name
 */
async function pickStillLoading(t, name) {
  gBrowser.selectedTab = t;
  const switcher = gBrowser._switcher;
  Assert.equal(switcher?.loadingTab, t, `the switcher loads ${name}`);
  // It loads t, so it has a switcher and its load timer runs: either missing throws.
  /** @type {nsITimer} */ (/** @type {AsyncTabSwitcher} */ (switcher).loadTimer).delay = 60_000;
  await until(() => t.linkedBrowser.hasLayers, `${name}'s page has painted`);
  Assert.equal(gBrowser._switcher?.loadingTab, t, `${name}'s page is still loading`);
}

/**
 * The switch is done, and `t`'s page is the one painting.
 * @param {SplitTab} t
 * @param {string} name
 */
async function assertShown(t, name) {
  await until(() => !gBrowser._switcher, `the switch to ${name} is done`);
  Assert.ok(t.linkedBrowser.docShellIsActive, `${name}'s page is live`);
  Assert.ok(t.linkedBrowser.renderLayers, `${name}'s page is painted`);
}

add_task(async function a_lone_tab_picked_while_a_split_still_loads_is_shown() {
  await pick(tab("b"));
  await until(() => splitsOf().shown === 1, "S1 shows");
  await until(() => !gBrowser._switcher, "the switch to b is done");
  await layersCleared([tab("c"), tab("d")], "S2");
  await withLayersLate(async () => {
    await pickStillLoading(tab("d"), "d");
    Assert.equal(splitsOf().shown, 2, "picking d shows S2");
    gBrowser.selectedTab = tab("f");
    await until(() => splitsOf().shown === null, "f shows alone");
  });
  await assertShown(tab("f"), "f");
  Assert.ok(!tab("c").linkedBrowser.docShellIsActive, "S2's pages sleep: c");
  Assert.ok(!tab("d").linkedBrowser.docShellIsActive, "and d");
});

add_task(async function a_split_picked_while_another_still_loads_is_shown() {
  await layersCleared([tab("a"), tab("b")], "S1");
  await withLayersLate(async () => {
    await pickStillLoading(tab("b"), "b");
    Assert.equal(splitsOf().shown, 1, "picking b shows S1");
    gBrowser.selectedTab = tab("d");
    await until(() => splitsOf().shown === 2, "picking d shows S2");
  });
  await assertShown(tab("d"), "d");
  await until(() => tab("c").linkedBrowser.docShellIsActive, "S2's other page is live");
  await until(
    () => !tab("a").linkedBrowser.docShellIsActive && !tab("b").linkedBrowser.docShellIsActive,
    "S1's pages sleep",
  );
});

add_task(async function a_lone_tab_picked_before_a_split_paints_ends_the_switch() {
  await pick(tab("b"));
  await until(() => splitsOf().shown === 1, "S1 shows");
  await until(() => !gBrowser._switcher, "the switch to b is done");
  await layersCleared([tab("c"), tab("d")], "S2");
  const number = (/** @type {string} */ name) => gBrowser.visibleTabs.indexOf(tab(name)) + 1;
  for (const name of ["d", "f"]) {
    Assert.ok(number(name) >= 1 && number(name) <= 8, `${name} has a tab number for ctrl+b N`);
  }
  await until(() => tab("b").linkedBrowser.docShellIsActive, "b's page is shown");
  await focusContent(tab("b").linkedBrowser);
  // ctrl+b N to d, then to f, with no refresh tick between them, as keys queued behind a busy
  // main thread arrive: S2's panels are hidden again before they are ever laid out, so d,
  // which the switcher is loading, never paints.
  prefix(String(number("d")));
  Assert.equal(gBrowser.selectedTab, tab("d"), "ctrl+b N picks d");
  Assert.equal(splitsOf().shown, 2, "which shows S2");
  Assert.equal(gBrowser._switcher?.loadingTab, tab("d"), "the switcher loads d");
  prefix(String(number("f")));
  Assert.equal(gBrowser.selectedTab, tab("f"), "ctrl+b N picks f");
  Assert.equal(splitsOf().shown, null, "f shows alone");

  await assertShown(tab("f"), "f");
  Assert.ok(!tab("d").linkedBrowser.docShellIsActive, "S2's page d sleeps");
  Assert.ok(!tab("d").linkedBrowser.renderLayers, "and paints nothing");
  await openPanel();
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "keys reach Vimma on f");

  await pick(tab("e"));
  await assertShown(tab("e"), "e");
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
    "split S2 is hidden: ]s or ctrl+b S to go back, or mark tabs in ctrl+b b for a new split",
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
  // b's panel, a XUL <hbox>, which getElementById types as an HTML element.
  const bPanel = /** @type {XULElement} */ (
    /** @type {Element} */ (document.getElementById(tab("b").linkedPanel))
  );
  Assert.equal(bPanel.style.getPropertyValue("--vimma-pane-w"), "", "b's panel lost S1's size");
  Assert.ok(!bPanel.classList.contains("split-view-panel"), "and its place in a split view");
  Assert.ok(tab("a").splitview, "a is in a wrapper");
  Assert.strictEqual(tab("a").splitview, tab("e").splitview, "a and e share a wrapper");
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

add_task(async function the_shown_split_ending_on_a_close_keeps_the_hidden_ones_at_once() {
  // h: one more tab outside every split.
  opened.push(await page("h"));
  await pick(tab("f"));
  Assert.ok(view().showTabs([tab("b"), tab("f")], tab("f")).ok, "S1: b, f, made on a lone tab");
  await until(() => splitsOf().shown === 1, "S1 shows");
  gBrowser.removeTab(tab("f"));
  // Before the reconcile: a save or a switch in this gap must still see S2.
  Assert.equal(splitsOf().all, "S2:x[c,d]", "S2 is kept the moment S1 ends");
  await until(() => !tab("b").splitview, "S1's wrapper is undone");
  Assert.equal(splitsOf().all, "S2:x[c,d]", "and still kept after the reconcile");
  opened.splice(opened.indexOf(tab("f")), 1);
  byName.delete("f");
});

add_task(async function a_workspace_switch_and_a_session_restore_keep_every_split() {
  const A = WorkspaceStore.addWorkspace({ name: "ms-a", color: "blue", icon: "briefcase" });
  const B = WorkspaceStore.addWorkspace({ name: "ms-b", color: "green", icon: "briefcase" });
  created.push(A.id, B.id);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await workspaces(win).ready;
  await until(() => !!workspaces(win).model, "the new window has its workspaces");
  live(win).switchTo({ id: A.id });
  await until(() => win.gBrowser.selectedTab.userContextId === A.userContextId, "A shows");
  /** @type {SplitTab[]} */
  const pages = [];
  for (const n of ["p", "q", "r", "s", "t"]) pages.push(await page(n, win));
  Assert.ok(view(win).showTabs([tab("p"), tab("q")], tab("p")).ok, "S1: p | q");
  await pick(tab("t"), win);
  await newSplit(["r", "s"], win);
  await until(() => splitsOf(win).shown === 2, "S2 shows");
  await pick(tab("q"), win);
  await until(() => splitsOf(win).shown === 1, "S1 shows, S2 hidden");

  live(win).switchTo({ id: B.id });
  await until(() => live(win).model.active === B.id, "B shows");
  Assert.equal(splitsOf(win).all, "", "B has no split");
  live(win).switchTo({ id: A.id });
  await until(() => splitsOf(win).shown === 1, "back in A, S1 shows");
  Assert.equal(splitsOf(win).all, "S1:x[p,q] S2:x[r,s]", "both splits came back with A");
  await until(() => laidOut(tab("p"), win) && laidOut(tab("q"), win), "S1 is laid out");

  const uuid = (/** @type {MozTabbrowserTab} */ t) =>
    SessionStore.getCustomTabValue(t, "vimma-tab");
  const ids = new Map(pages.map((t) => [uuid(t), nameOf(t)]));
  await TabStateFlusher.flushWindow(win);
  await TestUtils.waitForTick();
  /**
   * SessionStore's state, as much of it as this test reads.
   * It mirrors engine/browser/components/sessionstore: SessionStore.sys.mjs (a window's winData),
   * TabState.sys.mjs (a tab) and SessionHistory.sys.mjs (its entries).
   * @type {{ windows: { tabs: { entries: { url: string }[] }[] }[] }}
   */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?t`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(win);

  const w2 = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(w2);
  await workspaces(w2).ready;
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  // ids has the name of each page the test opened, and their splits give each a panel.
  for (const t of w2.gBrowser.tabs) {
    if (ids.has(uuid(t)))
      byName.set(/** @type {string} */ (ids.get(uuid(t))), /** @type {SplitTab} */ (t));
  }
  await until(() => view(w2).splits.splits.length === 2, "both splits are restored");
  Assert.equal(splitsOf(w2).all, "S1:x[p,q] S2:x[r,s]", "with their numbers");
  Assert.equal(splitsOf(w2).shown, 1, "and S1 shown");
  await pick(tab("s"), w2);
  await until(() => splitsOf(w2).shown === 2, "picking s shows S2");
  await until(() => laidOut(tab("r"), w2) && laidOut(tab("s"), w2), "S2 is laid out");
});
