/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md, behaviour 10, and docs/specs/m3-workspaces.md, sub-spec 3,
// Restoring: after a restore, a split that is not on screen names its lazy tabs by their uuids and
// keeps them lazy until it shows, with their saved scroll position and form data (issue #1318).
// A hidden workspace's split: browser_vimma_workspace_restore_splits.js.

"use strict";

/* global unloadTab -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
// Six tasks, most with two restarts: past the default timeout on a busy runner.
requestLongerTimeout(2);

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
const { readSnapshot } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/snapshot.mjs",
);
const { splitsOf } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/workspaces.mjs",
);
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
const WINDOW_KEY = "vimma-workspaces";
const TAB_KEY = "vimma-tab";

/** @type {string[]} */
const created = [];
/** @type {Window[]} */
const windows = [];

registerCleanupFunction(async () => {
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
});

/**
 * A new workspace, with its container: containers are on in the browser tests.
 * @param {string} name
 */
function workspace(name) {
  const w = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" })
  );
  created.push(w.id);
  return w;
}

/**
 * A window's workspaces, which VimmaHost made when it started the window.
 * @param {BrowserWindow} win
 */
const workspaces = (win) => /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win));
/**
 * A window's workspaces once their model is built, as openWindow waits for.
 * @param {BrowserWindow} win
 */
const live = (win) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
/**
 * A window's split view, which VimmaHost made when it started the window.
 * @param {BrowserWindow} win
 */
const view = (win) => /** @type {PaneView} */ (PaneViews.get(win));

/**
 * The model's workspace with this id, one the test made.
 * @param {LiveWorkspaces["model"]} model
 * @param {string} id
 */
function workspaceIn(model, id) {
  return /** @type {WorkspaceState} */ (model.workspaces.find((w) => w.id === id));
}

/**
 * SessionStore's state, as much of it as these tests read or write.
 * It mirrors engine/browser/components/sessionstore: SessionStore.sys.mjs (a window's winData),
 * TabState.sys.mjs (a tab) and SessionHistory.sys.mjs (its entries).
 * @typedef {{ url: string, triggeringPrincipal_base64?: string }} SessionEntry
 * @typedef {{ entries: SessionEntry[], userContextId?: number,
 *   extData?: Record<string, string> }} SessionTab
 * @typedef {{ tabs: SessionTab[], selected?: number,
 *   extData?: Record<string, string> }} SessionWindow
 */

/** @returns {{ windows: SessionWindow[] }} */
function browserState() {
  return JSON.parse(SessionStore.getBrowserState());
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

async function openWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await workspaces(win).ready;
  await until(() => !!workspaces(win).model, "the new window has its workspaces");
  return win;
}

/** @param {BrowserWindow} win @param {string} url */
async function openIn(win, url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, url);
  return tab;
}

/**
 * Restores `winState` into `win`, overwriting its tabs, and waits for SessionStore to finish.
 * @param {BrowserWindow} win
 * @param {SessionWindow} winState
 */
async function restoreInto(win, winState) {
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  SessionStore.setWindowState(win, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
}

/**
 * Flushes `win` and returns its saved window state, and the saved tab whose page is `url`.
 * @param {BrowserWindow} win
 * @param {string} url
 */
async function saved(win, url) {
  await TabStateFlusher.flushWindow(win);
  await TestUtils.waitForTick();
  const has = (/** @type {SessionTab} */ t) => t.entries.some((e) => e.url === url);
  const winState = /** @type {SessionWindow} */ (
    browserState().windows.find((w) => w.tabs.some(has))
  );
  const tab =
    /** @type {SessionTab & { scroll?: { scroll?: string },
     *   formdata?: { id?: Record<string, string> } }} */ (winState.tabs.find(has));
  return { winState, tab };
}

// Issue #1305: a split in a workspace that is not shown after a restore stays lazy until it is
// first shown, like every other tab of that workspace (guide, "A restart restores them"). Its
// tabs used to get their browsers at the restore, which made SessionStore restore them in the
// background, and the next save wrote them without their scroll position and form data, so a
// second restart lost both.
// Issue #1318: in the shown workspace, a split that is not on screen (docs/specs/multiple-splits.md)
// stays lazy after a restore until it is shown, and keeps its saved scroll position and form data
// meanwhile, as a hidden workspace's split does (#1305).
add_task(async function a_split_not_on_screen_stays_lazy_and_keeps_its_scroll() {
  const M = workspace("rs-m");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: M.id });
  await until(() => ww1.model.active === M.id, "M is shown");
  const m1 = /** @type {SplitTab} */ (await openIn(w1, LONG));
  await SpecialPowers.spawn(m1.linkedBrowser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.value = "kept";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
    content.scrollTo(0, 1200);
  });
  /** @type {SplitTab[]} */
  const more = [];
  for (const n of ["m2", "m3", "m4"]) {
    const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(w1.gBrowser, `${PAGE}?${n}`));
    await BrowserTestUtils.browserLoaded(t.linkedBrowser);
    more.push(t);
  }
  const [m2, m3, m4] = more;
  // S1: the long page and m2; then S2 on the lone m3: S1 is no longer on screen.
  Assert.ok(view(w1).showTabs([m1, m2], m1).ok, "S1: m1 | m2");
  w1.gBrowser.selectedTab = m3;
  await until(() => view(w1).hidden, "m3 shows alone, S1 kept");
  Assert.ok(view(w1).showTabs([m3, m4], m3).ok, "S2: m3 | m4");
  await until(() => view(w1).splits.splits.length === 2, "M has two splits");
  Assert.equal(view(w1).splits.shown, 2, "S2 is on screen");
  const uuids = [m1, m2, m3, m4].map((t) => SessionStore.getCustomTabValue(t, TAB_KEY));
  const first = await saved(w1, LONG);
  Assert.equal(first.tab.scroll?.scroll, "0,1200", "the long page is saved scrolled");
  Assert.equal(first.tab.formdata?.id?.text, "kept", "with its typed text");
  await BrowserTestUtils.closeWindow(w1);

  const byUuid = (/** @type {BrowserWindow} */ win, /** @type {string} */ u) =>
    /** @type {SplitTab} */ (
      win.gBrowser.tabs.find((t) => SessionStore.getCustomTabValue(t, TAB_KEY) === u)
    );
  // First restart: S2 is on screen, S1 is not shown.
  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === M.id, "M is shown after the restore");
  await until(() => view(w2).splits.shown === 2, "S2 is on screen");
  const [r1, r2] = uuids.map((u) => byUuid(w2, u));
  Assert.ok(r1 && r2, "S1's tabs come back");
  Assert.ok(!r1.linkedPanel && !r2.linkedPanel, "S1's tabs stay lazy");
  const offScreen = view(w2).splits.splits.find((x) => x.number === 1);
  Assert.deepEqual(
    offScreen ? leaves(offScreen).map((l) => view(w2).tabOf(l.tab)) : [],
    [r1, r2],
    "S1 names them by their uuids",
  );
  Assert.ok(
    !SessionStore.isTabRestoring(r1) && !SessionStore.isTabRestoring(r2),
    "and are not restored in the background",
  );
  const second = await saved(w2, LONG);
  Assert.equal(second.tab.scroll?.scroll, "0,1200", "the next save keeps the scroll position");
  Assert.equal(second.tab.formdata?.id?.text, "kept", "and the typed text");
  const snapshot = readSnapshot(/** @type {string} */ (second.winState.extData?.[WINDOW_KEY]));
  const own = splitsOf(
    /** @type {WorkspaceState} */ (snapshot.state.workspaces.find((w) => w.id === M.id)),
  );
  Assert.deepEqual(
    own.splits.map((x) => leaves(x).map((l) => l.tab)),
    [uuids.slice(0, 2), uuids.slice(2)],
    "and both splits",
  );
  Assert.equal(own.shown, 2, "with S2 on screen");
  await BrowserTestUtils.closeWindow(w2);

  // Second restart: picking the long page shows S1, at the saved position.
  const w3 = await openWindow();
  await restoreInto(w3, second.winState);
  const ww3 = live(w3);
  await until(() => ww3.model.active === M.id, "M is shown after the second restore");
  await until(() => view(w3).splits.shown === 2, "S2 is on screen again");
  const [s1, s2] = uuids.map((u) => byUuid(w3, u));
  w3.gBrowser.selectedTab = s1;
  await until(() => view(w3).splits.shown === 1, "selecting the long page shows S1");
  const panes = view(w3).panes;
  Assert.deepEqual(
    panes ? leaves(panes).map((l) => l.tab) : [],
    [s1?.linkedPanel ?? "", s2?.linkedPanel ?? ""],
    "S1 comes back whole",
  );
  await until(() => !s1.hasAttribute("pending"), "the long page restores");
  const read = () =>
    SpecialPowers.spawn(s1.linkedBrowser, [], () => ({
      y: content.scrollY,
      // Null until the page has replaced about:blank.
      text: /** @type {HTMLInputElement | null} */ (content.document.getElementById("text"))?.value,
    }));
  // The restore may still move the page to its content process: a read that reaches the old
  // one fails (its actor is destroyed) and is tried again.
  await TestUtils.waitForCondition(
    () =>
      read().then(
        (r) => r.y === 1200,
        () => false,
      ),
    "scroll restores",
  );
  Assert.equal((await read()).text, "kept", "the typed text comes back");
  await BrowserTestUtils.closeWindow(w3);
});

/**
 * Opens a loaded page for each name in `win`, the first selected; returns them and their uuids.
 * @param {BrowserWindow} win
 * @param {string[]} names
 */
async function pages(win, names) {
  /** @type {Map<string, SplitTab>} */
  const tabs = new Map();
  for (const [i, n] of names.entries()) {
    const t = /** @type {SplitTab} */ (
      i === 0
        ? await openIn(win, `${PAGE}?${n}`)
        : BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${n}`)
    );
    if (i > 0) await BrowserTestUtils.browserLoaded(t.linkedBrowser);
    tabs.set(n, t);
  }
  const uuids = new Map([...tabs].map(([n, t]) => [n, SessionStore.getCustomTabValue(t, TAB_KEY)]));
  return { tabs, uuids };
}

/**
 * Makes S1 of `first` and then S2 of `second` (on a lone tab) in `win`'s shown workspace: S2 is
 * on screen, S1 is not.
 * @param {BrowserWindow} win
 * @param {SplitTab[]} first
 * @param {SplitTab[]} second
 */
async function twoSplits(win, first, second) {
  Assert.ok(view(win).showTabs(first, first[0]).ok, "S1 is made");
  win.gBrowser.selectedTab = second[0];
  await until(() => view(win).hidden, "S2's first tab shows alone, S1 kept");
  Assert.ok(view(win).showTabs(second, second[0]).ok, "S2 is made");
  await until(() => view(win).splits.splits.length === 2, "two splits");
  Assert.equal(view(win).splits.shown, 2, "S2 is on screen");
}

/**
 * Each split of `win`'s shown workspace as the names of its tabs, by `names` (uuid or panel).
 * @param {BrowserWindow} win
 * @param {Map<string, string>} uuids  name to uuid
 */
function namedSplits(win, uuids) {
  const nameOf = (/** @type {string} */ id) => {
    const tab = view(win).tabOf(id);
    const uuid = tab && SessionStore.getCustomTabValue(tab, TAB_KEY);
    return [...uuids].find(([, u]) => u === uuid)?.[0] ?? "?";
  };
  return view(win)
    .splits.splits.map(
      (x) =>
        `S${x.number}:${leaves(x)
          .map((l) => nameOf(l.tab))
          .join(",")}`,
    )
    .join(" ");
}

/**
 * The saved splits of workspace `id` in `winState`, as names.
 * @param {SessionWindow} winState
 * @param {string} id
 * @param {Map<string, string>} uuids
 */
function savedSplits(winState, id, uuids) {
  const snapshot = readSnapshot(/** @type {string} */ (winState.extData?.[WINDOW_KEY]));
  const own = splitsOf(
    /** @type {WorkspaceState} */ (snapshot.state.workspaces.find((w) => w.id === id)),
  );
  const nameOf = (/** @type {string} */ u) => [...uuids].find(([, x]) => x === u)?.[0] ?? "?";
  return own.splits
    .map(
      (x) =>
        `S${x.number}:${leaves(x)
          .map((l) => nameOf(l.tab))
          .join(",")}`,
    )
    .join(" ");
}

// Issue #1318: a hidden workspace whose split on screen ends before its first visit (a tab of
// it closed) shows its other split on that visit, which then gets its tabs' browsers, and keeps
// it in the next save. PaneView makes that split current, so it must not keep naming lazy tabs
// by uuid there: the current tree is laid out from panels.
add_task(async function a_hidden_workspaces_other_split_survives_when_its_shown_one_ends() {
  const P = workspace("rs-p");
  const Q = workspace("rs-q");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: P.id });
  await until(() => ww1.model.active === P.id, "P is shown");
  const { tabs, uuids } = await pages(w1, ["pa", "pb", "pc", "pd"]);
  const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
  await twoSplits(w1, [t("pa"), t("pb")], [t("pc"), t("pd")]);
  ww1.switchTo({ id: Q.id });
  await until(() => ww1.model.active === Q.id, "Q is shown");
  const first = await saved(w1, `${PAGE}?pa`);
  Assert.equal(savedSplits(first.winState, P.id, uuids), "S1:pa,pb S2:pc,pd", "P's two splits");
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === Q.id, "Q is shown after the restore");
  const byUuid = (/** @type {string} */ name) =>
    /** @type {MozTabbrowserTab} */ (
      w2.gBrowser.tabs.find((x) => SessionStore.getCustomTabValue(x, TAB_KEY) === uuids.get(name))
    );
  BrowserTestUtils.removeTab(byUuid("pc"));
  await until(
    () => !workspaceIn(ww2.model, P.id).tabs.includes(/** @type {string} */ (uuids.get("pc"))),
    "the closed tab leaves P",
  );
  ww2.switchTo({ id: P.id });
  await until(() => ww2.model.active === P.id, "P is shown");
  await TestUtils.waitForTick();
  Assert.equal(namedSplits(w2, uuids), "S1:pa,pb", "P keeps S1, S2 ended");
  const second = await saved(w2, `${PAGE}?pa`);
  Assert.equal(savedSplits(second.winState, P.id, uuids), "S1:pa,pb", "and the save has S1");
  await BrowserTestUtils.closeWindow(w2);
});

// Issue #1318: a lazy tab of a split that is not on screen is named by its uuid; closing it,
// taking it out of the split (a move), Firefox's restored wrapper for its split, and unloading a
// tab of such a split all keep the split right.
add_task(async function an_off_screen_splits_lazy_tabs_close_leave_and_unload_by_uuid() {
  const N = workspace("rs-n");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: N.id });
  await until(() => ww1.model.active === N.id, "N is shown");
  const { tabs, uuids } = await pages(w1, ["na", "nb", "nc", "nf", "nd", "ne"]);
  const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
  await twoSplits(w1, [t("na"), t("nb"), t("nc"), t("nf")], [t("nd"), t("ne")]);
  const first = await saved(w1, `${PAGE}?na`);
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === N.id, "N is shown after the restore");
  await until(() => view(w2).splits.shown === 2, "S2 is on screen");
  const r = (/** @type {string} */ name) =>
    /** @type {SplitTab} */ (
      w2.gBrowser.tabs.find((x) => SessionStore.getCustomTabValue(x, TAB_KEY) === uuids.get(name))
    );
  Assert.equal(namedSplits(w2, uuids), "S1:na,nb,nc,nf S2:nd,ne", "both splits come back");
  Assert.ok(
    ["na", "nb", "nc", "nf"].every((n) => !r(n).linkedPanel),
    "S1's tabs are lazy",
  );
  // Firefox restored S1's wrapper around the lazy tabs: it is S1's, not a second split to undo.
  Assert.ok(r("na").splitview, "Firefox restored S1's wrapper");
  view(w2).adopt();
  view(w2).reconcile();
  Assert.ok(r("na").splitview, "adopting leaves it");
  Assert.equal(namedSplits(w2, uuids), "S1:na,nb,nc,nf S2:nd,ne", "and both splits");

  BrowserTestUtils.removeTab(r("nf"));
  await until(() => namedSplits(w2, uuids) === "S1:na,nb,nc S2:nd,ne", "closing nf shrinks S1");
  view(w2).release(r("nc"));
  Assert.equal(namedSplits(w2, uuids), "S1:na,nb S2:nd,ne", "nc leaves S1");
  Assert.ok(!r("na").linkedPanel && !r("nb").linkedPanel, "S1's tabs are still lazy");

  // Shown once, S1's tabs have panels; unloading one while S1 is off screen names it by its
  // uuid again, so S1 keeps it.
  w2.gBrowser.selectedTab = r("na");
  await until(() => view(w2).splits.shown === 1, "selecting na shows S1");
  await until(() => !r("na").hasAttribute("pending"), "na restores");
  // Unloaded while SessionStore still restores it, the tab can get its browser back from that
  // restore ("Given tab is not restoring"), whatever its split does.
  await until(() => !SessionStore.isTabRestoring(r("na")), "na has restored");
  w2.gBrowser.selectedTab = r("nd");
  await until(() => view(w2).splits.shown === 2, "selecting nd shows S2");
  Assert.ok(await unloadTab(r("na")), "na is unloaded");
  Assert.ok(!r("na").linkedPanel, "na has no panel");
  Assert.equal(namedSplits(w2, uuids), "S1:na,nb S2:nd,ne", "S1 still has na");
  const second = await saved(w2, `${PAGE}?nd`);
  Assert.equal(
    savedSplits(second.winState, N.id, uuids),
    "S1:na,nb S2:nd,ne",
    "and so does a save",
  );
  Assert.deepEqual(
    leaves(/** @type {Panes} */ (view(w2).splits.splits[0])).map((l) => l.tab),
    [uuids.get("na") ?? "", r("nb").linkedPanel],
    "S1 names the unloaded tab by its uuid, the loaded one by its panel",
  );
  await BrowserTestUtils.closeWindow(w2);
});

/**
 * Resolves after the next reconcile of `win`'s view (the one a tab close schedules).
 * @param {BrowserWindow} win
 * @returns {Promise<void>}
 */
function reconciled(win) {
  return new Promise((resolve) => {
    const stop = PaneViews.watch(win, () => {
      stop();
      resolve();
    });
  });
}

/**
 * Types into the long page's field and scrolls it to 1200.
 * @param {SplitTab} tab
 */
async function scrollAndType(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.value = "kept";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
    content.scrollTo(0, 1200);
  });
}

/**
 * Selects `tab`, the long page, and waits until it has restored its scroll position; returns
 * its field's text.
 * @param {SplitTab} tab
 */
async function restoredLongPage(tab) {
  await until(() => !tab.hasAttribute("pending"), "the long page restores");
  const read = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
      y: content.scrollY,
      // Null until the page has replaced about:blank.
      text: /** @type {HTMLInputElement | null} */ (content.document.getElementById("text"))?.value,
    }));
  // The restore may still move the page to its content process: a read that reaches the old
  // one fails (its actor is destroyed) and is tried again.
  await TestUtils.waitForCondition(
    () =>
      read().then(
        (r) => r.y === 1200,
        () => false,
      ),
    "scroll restores",
  );
  return (await read()).text;
}

// Issue #1332: a split that becomes the current one while it is not on screen keeps its lazy tabs
// lazy until it shows. Here the split on screen ends (a tab of it closed), so the other one
// becomes current as the split shown last, kept hidden (#promote); a restart then restores it as
// that hidden view. Both used to give its tabs browsers at once, and the next save lost the long
// page's scroll position and typed text.
add_task(async function a_split_made_current_off_screen_stays_lazy_across_restarts() {
  const K = workspace("rs-k");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: K.id });
  await until(() => ww1.model.active === K.id, "K is shown");
  const k1 = /** @type {SplitTab} */ (await openIn(w1, LONG));
  await scrollAndType(k1);
  const { tabs, uuids } = await pages(w1, ["k2", "k3", "k4"]);
  const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
  uuids.set("k1", SessionStore.getCustomTabValue(k1, TAB_KEY));
  await twoSplits(w1, [k1, t("k2")], [t("k3"), t("k4")]);
  const first = await saved(w1, LONG);
  Assert.equal(first.tab.scroll?.scroll, "0,1200", "the long page is saved scrolled");
  await BrowserTestUtils.closeWindow(w1);

  // First restart: S2 on screen, S1 lazy. Closing k4 ends S2, so S1 becomes current, hidden.
  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === K.id, "K is shown after the restore");
  await until(() => view(w2).splits.shown === 2, "S2 is on screen");
  const r = (/** @type {BrowserWindow} */ win, /** @type {string} */ name) =>
    /** @type {SplitTab} */ (
      win.gBrowser.tabs.find((x) => SessionStore.getCustomTabValue(x, TAB_KEY) === uuids.get(name))
    );
  Assert.ok(!r(w2, "k1").linkedPanel && !r(w2, "k2").linkedPanel, "S1's tabs are lazy");
  w2.gBrowser.selectedTab = r(w2, "k3");
  const settled = reconciled(w2);
  BrowserTestUtils.removeTab(r(w2, "k4"));
  await until(() => view(w2).splits.splits.length === 1, "S2 ends with k4");
  await until(() => view(w2).hidden, "S1 is current, kept hidden while k3 shows alone");
  await settled;
  Assert.equal(namedSplits(w2, uuids), "S1:k1,k2", "S1 is the split left");
  Assert.ok(
    !r(w2, "k1").linkedPanel && !r(w2, "k2").linkedPanel,
    "made current off screen, S1's tabs stay lazy",
  );
  Assert.ok(!SessionStore.isTabRestoring(r(w2, "k1")), "and are not restored in the background");
  const second = await saved(w2, LONG);
  Assert.equal(second.tab.scroll?.scroll, "0,1200", "the next save keeps the scroll position");
  Assert.equal(second.tab.formdata?.id?.text, "kept", "and the typed text");
  Assert.equal(savedSplits(second.winState, K.id, uuids), "S1:k1,k2", "and S1");
  await BrowserTestUtils.closeWindow(w2);

  // Second restart: S1 comes back as the current split, a hidden view, and stays lazy.
  const w3 = await openWindow();
  await restoreInto(w3, second.winState);
  const ww3 = live(w3);
  await until(() => ww3.model.active === K.id, "K is shown after the second restore");
  await until(() => view(w3).hidden, "S1 is a hidden view, k3 shows alone");
  await TestUtils.waitForTick();
  Assert.equal(namedSplits(w3, uuids), "S1:k1,k2", "S1 comes back");
  Assert.ok(
    !r(w3, "k1").linkedPanel && !r(w3, "k2").linkedPanel,
    "a restored hidden view's tabs stay lazy",
  );
  Assert.deepEqual(
    leaves(/** @type {Panes} */ (view(w3).panes)).map((l) => l.tab),
    [uuids.get("k1") ?? "", uuids.get("k2") ?? ""],
    "the current tree names them by their uuids",
  );
  const third = await saved(w3, LONG);
  Assert.equal(third.tab.scroll?.scroll, "0,1200", "the save after it keeps the scroll position");
  Assert.equal(third.tab.formdata?.id?.text, "kept", "and the typed text");

  // Picking the long page shows S1 whole, at the saved position, with the text.
  w3.gBrowser.selectedTab = r(w3, "k1");
  await until(() => view(w3).splits.shown === 1 && !view(w3).hidden, "picking k1 shows S1");
  const panes = view(w3).panes;
  Assert.deepEqual(
    panes ? leaves(panes).map((l) => l.tab) : [],
    [r(w3, "k1").linkedPanel, r(w3, "k2").linkedPanel],
    "S1 comes back whole, with panels",
  );
  Assert.ok(
    r(w3, "k2").splitview && r(w3, "k2").splitview === r(w3, "k1").splitview,
    "in one wrapper",
  );
  Assert.equal(await restoredLongPage(r(w3, "k1")), "kept", "the typed text comes back");
  await BrowserTestUtils.closeWindow(w3);
});

// Issue #1332: unloading a pane's tab of the current split (the tab menu's Unload Tab, which first
// selects a tab outside the split, so the split is kept hidden) leaves the tab unloaded until the
// split shows again; it used to get a browser back at once, which restored it in the background.
add_task(async function unloading_a_pane_of_the_current_split_keeps_it_unloaded() {
  const U = workspace("rs-u");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: U.id });
  await until(() => ww1.model.active === U.id, "U is shown");
  const { tabs, uuids } = await pages(w1, ["ua", "ub", "uc"]);
  const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
  Assert.ok(view(w1).showTabs([t("ua"), t("ub")], t("ua")).ok, "S1: ua | ub");
  await until(() => t("ua").selected && !view(w1).hidden, "S1 shows");
  await w1.gBrowser.explicitUnloadTabs([t("ub")]);
  await until(() => !t("ub").linkedPanel, "ub is unloaded");
  Assert.ok(view(w1).hidden, "a tab outside S1 shows, S1 is kept hidden");
  await TestUtils.waitForTick();
  await TestUtils.waitForTick();
  Assert.ok(!t("ub").linkedPanel, "ub stays unloaded");
  Assert.deepEqual(
    leaves(/** @type {Panes} */ (view(w1).panes)).map((l) => l.tab),
    [t("ua").linkedPanel, uuids.get("ub") ?? ""],
    "S1 names ub by its uuid",
  );

  w1.gBrowser.selectedTab = t("ua");
  await until(() => !view(w1).hidden, "selecting ua shows S1");
  Assert.ok(t("ub").linkedPanel, "ub gets its browser as S1 shows");
  Assert.deepEqual(
    leaves(/** @type {Panes} */ (view(w1).panes)).map((l) => l.tab),
    [t("ua").linkedPanel, t("ub").linkedPanel],
    "S1 is whole",
  );
  await BrowserTestUtils.closeWindow(w1);
});

// Issue #1332: a tab whose browser was there before PaneView started listening (its
// TabBrowserInserted came earlier) is still renamed to its uuid when Firefox unloads it, so its
// split keeps it.
add_task(async function a_tab_loaded_before_the_view_started_keeps_its_split_when_unloaded() {
  const V = workspace("rs-v");
  const w1 = await openWindow();
  const ww1 = live(w1);
  ww1.switchTo({ id: V.id });
  await until(() => ww1.model.active === V.id, "V is shown");
  const { tabs, uuids } = await pages(w1, ["va", "vb", "vc", "vd"]);
  const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
  await twoSplits(w1, [t("va"), t("vb")], [t("vc"), t("vd")]);
  // A fresh PaneView over the same window, given the splits as a restore would: it never saw
  // these tabs' browsers come.
  const old = view(w1);
  const { adoption, accepts, onChange } = old;
  const splits = old.splits;
  PaneViews.uninit(w1);
  PaneViews.init(w1);
  const fresh = view(w1);
  Object.assign(fresh, { adoption, accepts, onChange });
  fresh.restore(new Map([[V.id, splits]]), V.id);
  Assert.ok(await unloadTab(t("va")), "va is unloaded");
  Assert.equal(namedSplits(w1, uuids), "S1:va,vb S2:vc,vd", "S1 still has va");
  Assert.equal(
    leaves(/** @type {Panes} */ (fresh.splits.splits[0]))[0]?.tab,
    uuids.get("va") ?? "",
    "named by its uuid",
  );
  await BrowserTestUtils.closeWindow(w1);
});

// Issue #1332: pinning an unloaded tab of the current split while it is kept hidden takes the tab
// out of the split, as for a loaded one. With workspaces Vimma unpins it again at once (decision
// 11), out of the wrapper; kept pinned, Firefox's wrapper cannot hold it (tabsplitview.mjs addTabs
// stops at a pinned tab). Either way a tree that kept it rebuilt the wrapper around it, and a
// wrapper that cannot take it rebuilt on every reconcile, each rebuild scheduling the next.
add_task(async function pinning_an_unloaded_tab_of_a_hidden_split_takes_it_out() {
  for (const keepPinned of [false, true]) {
    const Z = workspace(`rs-z${keepPinned ? "p" : ""}`);
    const w1 = await openWindow();
    const ww1 = live(w1);
    workspaces(w1).unpinsPinnedTabs = !keepPinned;
    ww1.switchTo({ id: Z.id });
    await until(() => ww1.model.active === Z.id, "Z is shown");
    const { tabs, uuids } = await pages(w1, ["za", "zb", "zc", "zd"]);
    const t = (/** @type {string} */ n) => /** @type {SplitTab} */ (tabs.get(n));
    Assert.ok(view(w1).showTabs([t("za"), t("zb"), t("zc")], t("za")).ok, "S1: za | zb | zc");
    await until(() => t("za").selected && !view(w1).hidden, "S1 shows");
    await w1.gBrowser.explicitUnloadTabs([t("zb")]);
    await until(() => !t("zb").linkedPanel && view(w1).hidden, "zb is unloaded, S1 kept hidden");
    Assert.equal(
      leaves(/** @type {Panes} */ (view(w1).panes))[1]?.tab,
      uuids.get("zb") ?? "",
      "S1 names zb by its uuid",
    );

    let rounds = 0;
    const stop = PaneViews.watch(w1, () => rounds++);
    const paneCount = () => {
      const panes = view(w1).panes;
      return panes ? leaves(panes).length : 0;
    };
    w1.gBrowser.pinTab(t("zb"));
    await until(() => paneCount() === 2, `pinned (kept: ${keepPinned}), zb leaves S1`);
    for (let i = 0; i < 5; i++) await new Promise((r) => w1.setTimeout(r, 0));
    const before = rounds;
    for (let i = 0; i < 20; i++) await new Promise((r) => w1.setTimeout(r, 0));
    stop();
    Assert.equal(rounds, before, "and the view settles: no reconcile after it");
    Assert.deepEqual(
      leaves(/** @type {Panes} */ (view(w1).panes)).map((l) => view(w1).tabOf(l.tab)),
      [t("za"), t("zc")],
      "S1 is za | zc",
    );
    Assert.ok(view(w1).hidden, "still hidden");
    Assert.equal(t("zb").pinned, keepPinned, "zb is pinned as the window wants");
    Assert.ok(!t("zb").linkedPanel, "zb stays unloaded");
    Assert.ok(
      t("za").splitview && t("za").splitview === t("zc").splitview && !t("zb").splitview,
      "one wrapper holds za and zc",
    );
    if (t("zb").pinned) w1.gBrowser.unpinTab(t("zb"));
    await BrowserTestUtils.closeWindow(w1);
  }
});
