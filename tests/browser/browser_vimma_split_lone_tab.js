/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/split-from-lone-tab.md (changes multiple-splits behaviour 4). On a tab
// shown alone while the workspace keeps a hidden split, ctrl+b v / - / enter and :vsplit / :split
// make that tab and a new pane a new split with the next free number, the new pane focused; the
// hidden split stays hidden and ]s brings it back. At [panes] max_splits the key is refused, the
// notice stays until the next key and no tab opens. The private workspace behaves the same.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";

/** @param {BrowserWindow} [win] */
const view = (win = window) => /** @type {PaneView} */ (PaneViews.get(win));

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
/** @param {string} name */
const tab = (name) => /** @type {SplitTab} */ (byName.get(name));
/** @param {MozTabbrowserTab | undefined} t */
const nameOf = (t) => [...byName].find(([, x]) => x === t)?.[0] ?? "new";
/**
 * The tab of a tree's id: its panel, or for a lazy tab of a split that is not shown, its uuid.
 * @param {string} id
 * @param {BrowserWindow} [win]
 */
const tabOf = (id, win = window) =>
  win.gBrowser.tabs.find(
    (t) => t.linkedPanel === id || SessionStore.getCustomTabValue(t, "vimma-tab") === id,
  );

/**
 * A tree with each leaf named by its tab, a tab no test named as `new`: `x[a,new]`.
 * @param {Panes} panes
 * @param {BrowserWindow} [win]
 */
function shape(panes, win = window) {
  /** @type {(n: Panes["root"]) => string | undefined} */
  const walk = (n) =>
    n.type === "leaf" ? nameOf(tabOf(n.tab, win)) : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return walk(panes.root);
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
 * The tab of split `number`'s focused pane.
 * @param {number} number
 * @param {BrowserWindow} [win]
 */
function focusedTabOf(number, win = window) {
  const x = view(win).splits.splits.find((y) => y.number === number);
  const id = x && leaves(x).find((l) => l.pane === x.focus)?.tab;
  return id ? tabOf(id, win) : undefined;
}

/** Tabs a split opened, closed at the end. @type {MozTabbrowserTab[]} */
const opened = [];

/**
 * A loaded page titled `name` in `win`.
 * @param {string} name
 * @param {BrowserWindow} [win]
 */
async function page(name, win = window) {
  const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${name}`));
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    content.document.title = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, t);
  opened.push(t);
  return t;
}

/**
 * ctrl+b, then `key`.
 * @param {string} key
 */
function prefix(key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, {});
}

/**
 * Shows `t` alone, every split hidden, with keyboard focus in its page.
 * @param {SplitTab} t
 */
async function showAlone(t) {
  gBrowser.selectedTab = t;
  await until(() => view().hidden, `${nameOf(t)} shows alone, the splits hidden`);
  await nextFrame();
  await focusContent(t.linkedBrowser);
}

/**
 * Runs `split` on the lone tab and waits for split `number` to show; returns the new tab.
 * @param {() => void} split
 * @param {number} number
 */
async function newSplitBy(split, number) {
  const before = new Set(gBrowser.tabs);
  split();
  await until(() => view().splits.shown === number, `S${number} shows`);
  // A tab a split opened, loaded into a pane: it has its panel.
  const fresh = /** @type {SplitTab | undefined} */ (gBrowser.tabs.find((t) => !before.has(t)));
  Assert.ok(fresh, "a new tab opened");
  opened.push(/** @type {SplitTab} */ (fresh));
  Assert.equal(focusedTabOf(number), fresh, "the new pane has focus");
  await until(() => gBrowser.selectedTab === fresh, "and its tab is selected");
  Assert.equal(notice(), null, "nothing is refused");
  return fresh;
}

registerCleanupFunction(async () => {
  view().maxSplits = 9;
  for (const t of opened.splice(0)) if (!t.closing && t.parentNode) gBrowser.removeTab(t);
  await until(() => !view().panes, "no split left");
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function setup_pages_and_a_split() {
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  for (const n of ["a", "b", "c", "d", "e", "f"]) await page(n);
  Assert.ok(view().showTabs([tab("a"), tab("b")], tab("a")).ok, "S1: a | b");
  await until(() => splitsOf().shown === 1, "S1 shows");
});

add_task(async function ctrl_b_v_on_a_lone_tab_starts_a_new_split() {
  await showAlone(tab("c"));
  const fresh = await newSplitBy(() => prefix("v"), 2);
  Assert.equal(splitsOf().all, "S1:x[a,b] S2:x[c,new]", "c and the new pane are S2, side by side");
  Assert.ok(tab("c").splitview && fresh.splitview, "S2 is in a wrapper");
  Assert.strictEqual(tab("c").splitview, fresh.splitview, "c and the new tab share it");
  Assert.notEqual(tab("a").splitview, fresh.splitview, "S1 keeps its own");
  Assert.ok(!tab("a").linkedBrowser.docShellIsActive, "S1 stays hidden: its pages sleep");

  // ]s steps from S2 to S1, the hidden split, wrapping.
  gBrowser.selectedTab = tab("c");
  await until(() => splitsOf().shown === 2, "picking c keeps S2");
  await focusContent(tab("c").linkedBrowser);
  EventUtils.synthesizeKey("]", {});
  EventUtils.synthesizeKey("s", {});
  await until(() => splitsOf().shown === 1, "]s shows S1 again");
  Assert.equal(splitsOf().all, "S1:x[a,b] S2:x[c,new]", "both are kept");
});

add_task(async function ctrl_b_minus_enter_and_the_commands_start_one_each() {
  await showAlone(tab("d"));
  await newSplitBy(() => prefix("-"), 3);
  Assert.equal(splitsOf().all.split(" ")[2], "S3:y[d,new]", "ctrl+b - stacks d and the new pane");

  await showAlone(tab("e"));
  await newSplitBy(() => prefix("KEY_Enter"), 4);
  const s4 = splitsOf().all.split(" ")[3] ?? "";
  Assert.ok(/^S4:[xy]\[e,new\]$/.test(s4), `ctrl+b enter: S4 of e and the new pane, ${s4}`);

  await showAlone(tab("f"));
  await newSplitBy(() => {
    EventUtils.synthesizeKey(":", { shiftKey: true });
    EventUtils.sendString("split");
    EventUtils.synthesizeKey("KEY_Enter", {});
  }, 5);
  Assert.equal(splitsOf().all.split(" ")[4], "S5:y[f,new]", ":split stacks f and the new pane");
  Assert.equal(view().splits.splits.length, 5, "five splits, none lost");
});

add_task(async function at_max_splits_the_key_is_refused_until_the_next_key() {
  const g = await page("g");
  view().maxSplits = 5;
  await showAlone(g);
  const tabs = gBrowser.tabs.length;
  const before = splitsOf().all;
  const want = "new split: at most 5 splits in a workspace";
  for (const key of ["v", "-", "KEY_Enter"]) {
    prefix(key);
    await until(() => notice() === want, `ctrl+b ${key} is refused, naming the limit`);
  }
  // Longer than a plain notice stays (NOTICE_MS, 1500 ms in ui/notice.mjs).
  await new Promise((r) => setTimeout(r, 2000));
  Assert.equal(notice(), want, "still shown after 2 s");
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  Assert.equal(splitsOf().all, before, "no split changed");
  Assert.ok(view().hidden, "and g still shows alone");
  Assert.equal(gBrowser.selectedTab, g, "selected");
  EventUtils.synthesizeKey("j", {});
  await until(() => notice() === null, "the next key hides it");
  view().maxSplits = 9;
});

// Decision 10: the private workspace behaves the same, and its new pane is private too.
add_task(async function the_private_workspace_starts_a_new_split_the_same_way() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const pview = view(priv);
  const tabs = [];
  for (const q of ["pa", "pb", "plone"]) tabs.push(await page(q, priv));
  const [a, b, lone] = tabs;
  Assert.ok(pview.showTabs([a, b], a).ok, "private S1: pa | pb");
  priv.gBrowser.selectedTab = lone;
  await until(() => pview.hidden, "plone shows alone");
  const normal = splitsOf().all;

  const before = new Set(priv.gBrowser.tabs);
  Assert.deepEqual(pview.split("vertical"), { ok: true }, "ctrl+b v's split is not refused");
  await until(() => pview.splits.shown === 2, "private S2 shows");
  const fresh = priv.gBrowser.tabs.find((t) => !before.has(t));
  Assert.ok(fresh, "a new tab opened in the private window");
  Assert.ok(
    PrivateBrowsingUtils.isBrowserPrivate(/** @type {MozTabbrowserTab} */ (fresh).linkedBrowser),
    "and it is private",
  );
  Assert.equal(splitsOf(priv).all, "S1:x[pa,pb] S2:x[plone,new]", "private S1 kept, S2 new");
  Assert.equal(focusedTabOf(2, priv), fresh, "the new pane has focus");
  Assert.equal(splitsOf().all, normal, "the normal window's splits are untouched");
  await BrowserTestUtils.closeWindow(priv);
  for (const t of tabs) opened.splice(opened.indexOf(t), 1);
});

// Behaviour 10 of multiple-splits: a split started from a key is saved and restored like one
// made from the side panel's marks.
add_task(async function a_split_started_from_a_key_survives_a_session_restore() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win)).ready;
  const pages = [];
  for (const q of ["rx", "ry", "rlone"]) pages.push(await page(q, win));
  const [x, y, lone] = pages;
  Assert.ok(view(win).showTabs([x, y], x).ok, "S1: rx | ry");
  win.gBrowser.selectedTab = lone;
  await until(() => view(win).hidden, "rlone shows alone");
  Assert.deepEqual(view(win).split("vertical"), { ok: true }, "S2 from the lone tab");
  await until(() => view(win).splits.shown === 2, "S2 shows");
  Assert.equal(splitsOf(win).all, "S1:x[rx,ry] S2:x[rlone,new]", "before the restore");

  const uuid = (/** @type {MozTabbrowserTab} */ t) =>
    SessionStore.getCustomTabValue(t, "vimma-tab");
  const ids = new Map(pages.map((t) => [uuid(t), nameOf(t)]));
  await TabStateFlusher.flushWindow(win);
  await TestUtils.waitForTick();
  /**
   * SessionStore's state, as much of it as this test reads (SessionStore.sys.mjs's winData,
   * TabState.sys.mjs's tab and SessionHistory.sys.mjs's entries).
   * @type {{ windows: { tabs: { entries: { url: string }[] }[] }[] }}
   */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?rlone`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  for (const t of pages) opened.splice(opened.indexOf(t), 1);
  await BrowserTestUtils.closeWindow(win);

  const w2 = await BrowserTestUtils.openNewBrowserWindow();
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(w2)).ready;
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  for (const t of w2.gBrowser.tabs) {
    // The pages this test named, with their panels once their splits show.
    if (ids.has(uuid(t)))
      byName.set(/** @type {string} */ (ids.get(uuid(t))), /** @type {SplitTab} */ (t));
  }
  await until(() => view(w2).splits.splits.length === 2, "both splits are restored");
  Assert.equal(splitsOf(w2).all, "S1:x[rx,ry] S2:x[rlone,new]", "with their numbers and tabs");
  Assert.equal(splitsOf(w2).shown, 2, "and S2 shown");
  // S1 is not on screen: its tabs stay lazy until it shows (issue #1318).
  Assert.ok(!tab("rx").linkedPanel && !tab("ry").linkedPanel, "S1's tabs are lazy");
  await BrowserTestUtils.closeWindow(w2);
});
