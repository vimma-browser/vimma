/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 3 (m3-workspace-persistence), Restoring: the split
// of a workspace that is not shown after a restore stays lazy until the workspace is first shown,
// like its other tabs, and keeps its saved scroll position and form data meanwhile (issue #1305).
// The other restore tests are in browser_vimma_workspace_restore.js.

"use strict";

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
const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
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
add_task(async function a_hidden_workspaces_split_stays_lazy_and_keeps_its_scroll() {
  const E = workspace("rs-g");
  const F = workspace("rs-h");
  const w1 = await openWindow();
  const ww1 = live(w1);

  // E: a long page scrolled to 1200 with a typed field, split with a page on the right.
  ww1.switchTo({ id: E.id });
  const e1 = await openIn(w1, LONG);
  await SpecialPowers.spawn(e1.linkedBrowser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.value = "kept";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
    content.scrollTo(0, 1200);
  });
  const e2 = /** @type {SplitTab} */ (BrowserTestUtils.addTab(w1.gBrowser, `${PAGE}?e2`));
  await BrowserTestUtils.browserLoaded(e2.linkedBrowser);
  Assert.ok(view(w1).split("vertical", { tab: e2 }).ok, "E is split");
  const uuids = [e1, e2].map((t) => SessionStore.getCustomTabValue(t, TAB_KEY));
  ww1.switchTo({ id: F.id });
  await until(() => ww1.model.active === F.id, "F is shown");
  const first = await saved(w1, LONG);
  Assert.equal(first.tab.scroll?.scroll, "0,1200", "the long page is saved scrolled");
  Assert.equal(first.tab.formdata?.id?.text, "kept", "with its typed text");
  await BrowserTestUtils.closeWindow(w1);

  // First restart: F is shown, E is not visited.
  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === F.id, "F is shown after the restore");
  const byUuid = (/** @type {BrowserWindow} */ win, /** @type {string} */ u) =>
    /** @type {MozTabbrowserTab} */ (
      win.gBrowser.tabs.find((t) => SessionStore.getCustomTabValue(t, TAB_KEY) === u)
    );
  const [r1, r2] = uuids.map((u) => byUuid(w2, u));
  Assert.ok(r1 && r2, "E's split tabs come back");
  Assert.ok(!r1.linkedPanel && !r2.linkedPanel, "E's split tabs stay lazy");
  Assert.ok(
    !SessionStore.isTabRestoring(r1) && !SessionStore.isTabRestoring(r2),
    "and are not restored in the background",
  );
  const second = await saved(w2, LONG);
  Assert.equal(second.tab.scroll?.scroll, "0,1200", "the next save keeps the scroll position");
  Assert.equal(second.tab.formdata?.id?.text, "kept", "and the typed text");
  await BrowserTestUtils.closeWindow(w2);

  // Second restart: E, shown, is split as it was, at the saved position.
  const w3 = await openWindow();
  await restoreInto(w3, second.winState);
  const ww3 = live(w3);
  await until(() => ww3.model.active === F.id, "F is shown after the second restore");
  ww3.switchTo({ id: E.id });
  await until(() => ww3.model.active === E.id, "E is shown");
  const [s1, s2] = uuids.map((u) => byUuid(w3, u));
  const panes = view(w3).panes;
  Assert.deepEqual(
    panes ? leaves(panes).map((l) => l.tab) : [],
    [s1?.linkedPanel ?? "", s2?.linkedPanel ?? ""],
    "E's split comes back when E is shown",
  );
  await until(() => !s1.hasAttribute("pending"), "the long page restores");
  const read = () =>
    SpecialPowers.spawn(s1.linkedBrowser, [], () => ({
      y: content.scrollY,
      // Null until the page has replaced about:blank.
      text: /** @type {HTMLInputElement | null} */ (content.document.getElementById("text"))?.value,
    }));
  await TestUtils.waitForCondition(async () => (await read()).y === 1200, "scroll restores");
  Assert.equal((await read()).text, "kept", "the typed text comes back");
  await BrowserTestUtils.closeWindow(w3);
});

// Issue #1305: a hidden workspace's split, kept in uuids until the workspace is shown, loses a tab
// that closes meanwhile: about:vimma counts the panes left, the next save writes them, and the
// workspace shows them. A split left with one pane ends.
add_task(async function a_hidden_split_that_loses_a_tab_before_its_visit_keeps_the_rest() {
  const G = workspace("rs-i");
  const K = workspace("rs-k");
  const H = workspace("rs-j");
  const w1 = await openWindow();
  const ww1 = live(w1);
  /** The uuid of each tab opened below, by name. */
  const uuids = new Map();
  /** Opens `names` in `ws` and splits them into one row, left to right. */
  const splitIn = async (/** @type {ContainedWorkspace} */ ws, /** @type {string[]} */ names) => {
    ww1.switchTo({ id: ws.id });
    await until(() => ww1.model.active === ws.id, `${ws.name} is shown`);
    const first = await openIn(w1, `${PAGE}?${names[0]}`);
    uuids.set(names[0], SessionStore.getCustomTabValue(first, TAB_KEY));
    for (const name of names.slice(1)) {
      const t = /** @type {SplitTab} */ (BrowserTestUtils.addTab(w1.gBrowser, `${PAGE}?${name}`));
      await BrowserTestUtils.browserLoaded(t.linkedBrowser);
      uuids.set(name, SessionStore.getCustomTabValue(t, TAB_KEY));
      Assert.ok(view(w1).split("vertical", { tab: t }).ok, `${name} joins ${ws.name}'s split`);
    }
    const panes = view(w1).panes;
    Assert.equal(panes ? leaves(panes).length : 0, names.length, `${ws.name} is split`);
  };
  await splitIn(G, ["g1", "g2", "g3"]);
  await splitIn(K, ["k1", "k2"]);
  ww1.switchTo({ id: H.id });
  await until(() => ww1.model.active === H.id, "H is shown");
  const first = await saved(w1, `${PAGE}?g1`);
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await openWindow();
  await restoreInto(w2, first.winState);
  const ww2 = live(w2);
  await until(() => ww2.model.active === H.id, "H is shown after the restore");
  const byName = (/** @type {BrowserWindow} */ win, /** @type {string} */ name) =>
    /** @type {MozTabbrowserTab} */ (
      win.gBrowser.tabs.find((t) => SessionStore.getCustomTabValue(t, TAB_KEY) === uuids.get(name))
    );
  /** about:vimma's pane count of a workspace of `win`. */
  const aboutPanes = async (/** @type {BrowserWindow} */ win, /** @type {string} */ name) => {
    const info = await AboutVimma.collect(win);
    return info.workspaces.window.find((w) => w.name === name)?.panes;
  };
  Assert.equal(await aboutPanes(w2, G.name), 3, "about:vimma counts G's three panes");
  Assert.equal(await aboutPanes(w2, K.name), 2, "and K's two");
  const g2 = byName(w2, "g2");
  const k2 = byName(w2, "k2");
  Assert.ok(!g2.linkedPanel && !k2.linkedPanel, "the hidden splits' tabs are lazy");
  BrowserTestUtils.removeTab(g2);
  BrowserTestUtils.removeTab(k2);
  await until(
    () => !workspaceIn(ww2.model, G.id).tabs.includes(uuids.get("g2")),
    "the closed tab leaves G",
  );
  Assert.equal(await aboutPanes(w2, G.name), 2, "about:vimma counts the two panes left");
  Assert.equal(await aboutPanes(w2, K.name), 1, "K's split, left with one pane, ends");
  const second = await saved(w2, `${PAGE}?g1`);
  const snapshot = readSnapshot(/** @type {string} */ (second.winState.extData?.[WINDOW_KEY]));
  const splitsIn = (/** @type {string} */ id) =>
    splitsOf(
      /** @type {WorkspaceState} */ (snapshot.state.workspaces.find((w) => w.id === id)),
    ).splits.map((x) => leaves(x).length);
  Assert.deepEqual(splitsIn(G.id), [2], "the save has G's split with its two panes left");
  Assert.deepEqual(splitsIn(K.id), [], "and no split in K");
  ww2.switchTo({ id: G.id });
  await until(() => ww2.model.active === G.id, "G is shown");
  const panes = view(w2).panes;
  Assert.deepEqual(
    panes ? leaves(panes).map((l) => l.tab) : [],
    ["g1", "g3"].map((n) => byName(w2, n)?.linkedPanel ?? ""),
    "G shows the two panes left",
  );
  await BrowserTestUtils.closeWindow(w2);
});
