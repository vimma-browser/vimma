/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 3 (Reconcile): the window's workspace model stays
// in step with its live tabs through the paths SessionStore drives (issue #546): a window
// reopened after the last one closed (macOS keeps the app running), a restore that throws
// partway, lazy tabs getting their browsers, undo close, duplicate, background opens inside a
// restore bracket, and a tab moved to another window. Tab search and the side panel read the
// model; the status bar and `gt` read the tabs, so a model out of step shows as the first two
// listing fewer tabs than the window has.

"use strict";

/* global E10SUtils -- a browser window global */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
);
const { pickerWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/goto.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";

/** @type {Window[]} */
const windows = [];
/** @type {string[]} */
const created = [];

registerCleanupFunction(async () => {
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
});

/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}

/** Restores `winState` into `win`, overwriting its tabs, and waits for SessionStore to finish. */
async function restoreInto(win, winState) {
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  SessionStore.setWindowState(win, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

const system = () => Services.scriptSecurityManager.getSystemPrincipal();

/** Records the SessionStore brackets of every window opened from now on, until `stop()`. */
function watchBrackets() {
  /** @type {string[]} */
  const seen = [];
  const watch = (/** @type {any} */ subject, /** @type {string} */ topic) => {
    if (topic !== "domwindowopened") return;
    for (const type of ["SSWindowStateBusy", "SSWindowStateReady"]) {
      subject.addEventListener(type, () => seen.push(type));
    }
  };
  Services.ww.registerNotification(watch);
  return { seen, stop: () => Services.ww.unregisterNotification(watch) };
}

async function openWindow() {
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await WindowWorkspaces.get(win).ready;
  await until(() => !!WindowWorkspaces.get(win).model, "the new window has its workspaces");
  return win;
}

/**
 * What is out of step between the window's model and its live tabs; [] when nothing is.
 * @param {Window} win
 */
function outOfStep(win) {
  const ww = WindowWorkspaces.get(win);
  const model = ww.model;
  const problems = [];
  const inModel = new Set(model.workspaces.flatMap((w) => w.tabs));
  for (const tab of win.gBrowser.tabs) {
    if (tab.pinned || tab.closing || !tab.isConnected) continue;
    const id = ww.idOf(tab);
    if (!inModel.has(id))
      problems.push(`tab ${win.gBrowser.tabs.indexOf(tab)} (${tab.label}) is in no workspace`);
  }
  for (const id of inModel) {
    if (!ww.tabOf(id)) problems.push(`model id ${id} names no open tab`);
  }
  const selected = win.gBrowser.selectedTab;
  if (!selected.pinned) {
    const listed = pickerWorkspaces(win).workspaces.flatMap((w) => w.tabs);
    const key = selected.linkedPanel || ww.idOf(selected);
    if (!listed.includes(key)) problems.push("tab search does not list the selected tab");
  }
  return problems;
}

/**
 * Opens tabs the way the maintainer's report did: `t` (foreground), `gF` (background) and a
 * link opened in the background.
 * @param {Window} win
 */
async function useWindow(win) {
  await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?t`);
  win.gBrowser.addTab(`${PAGE}?gF`, { triggeringPrincipal: system(), inBackground: true });
  win.gBrowser.addTab(`${PAGE}?link`, {
    triggeringPrincipal: system(),
    inBackground: true,
    relatedToCurrent: true,
  });
  await TestUtils.waitForTick();
}

/**
 * Closes `win` as the last browser window, the way a user does it (the close button, cmd+shift+w):
 * SessionStore is told it is the last one and restores into the next window opened, which on
 * macOS, where the app keeps running, is the next window the user opens. The harness's own window
 * stops counting as a browser window meanwhile, as SessionStore's own tests of this path do
 * (browser_354894_perwindowpb.js).
 * @param {Window} win
 */
async function closeAsLastWindow(win) {
  await TabStateFlusher.flushWindow(win);
  const closed = BrowserTestUtils.windowClosed(win);
  win.BrowserCommands.tryToCloseWindow();
  await closed;
}

/**
 * Opens tabs in the reopened window and checks that its model follows them.
 * @param {Window} win
 */
async function usedInStep(win) {
  await useWindow(win);
  info(`out of step right after use: ${outOfStep(win).join("; ") || "nothing"}`);
  await until(() => outOfStep(win).length === 0, "the model catches up with the live tabs");
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
}

/**
 * Closes a window prepared by `prepare` as the last one, opens another, then runs `then` on it.
 * @param {(first: Window) => Promise<void>} prepare
 * @param {(win: Window) => Promise<void>} [then]
 */
async function lastWindowCase(prepare, then = usedInStep) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.warnOnClose", false],
      ["browser.warnOnQuit", false],
      ["browser.sessionstore.persist_closed_tabs_between_sessions", true],
    ],
  });
  const type = document.documentElement.getAttribute("windowtype");
  document.documentElement.setAttribute("windowtype", "navigator:testrunner");
  const brackets = watchBrackets();
  /** @type {Window | null} */
  let win = null;
  try {
    const first = await openWindow();
    await prepare(first);
    await closeAsLastWindow(first);

    brackets.seen.length = 0;
    win = await openWindow();
    await TestUtils.waitForTick();
    info(`brackets the reopened window got: ${brackets.seen.join(", ") || "none"}`);
    Assert.ok(
      brackets.seen.includes("SSWindowStateBusy"),
      "SessionStore restored the closed window's leftovers into the reopened one",
    );
    await then(win);
  } finally {
    // The next case needs this one to close as the last window again.
    if (win && !win.closed) await BrowserTestUtils.closeWindow(win);
    brackets.stop();
    document.documentElement.setAttribute("windowtype", type);
    await SpecialPowers.popPrefEnv();
  }
}

/** A window with a closed tab and an open one. @param {Window} first */
async function withAClosedTab(first) {
  const gone = await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?closed`);
  BrowserTestUtils.removeTab(gone);
  await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?kept`);
}

add_task(async function a_window_reopened_after_the_last_one_closed_with_a_closed_tab() {
  await lastWindowCase(withAClosedTab);
});

// Once SessionStore's busy count for a window is stuck, a later whole-window restore into it
// sends no SSWindowStateBusy or SSWindowStateReady, only SSWindowRestoring at its start and
// sessionstore-single-window-restored at its end. Its tabs open before their tab values and the
// window value are set, so a model applying them live would save over the restored snapshot.
add_task(async function a_whole_window_restore_into_a_recovered_window_keeps_its_snapshot() {
  const A = workspace("dr-a");
  const B = workspace("dr-b");
  const w0 = await openWindow();
  const ww0 = WindowWorkspaces.get(w0);
  ww0.switchTo({ id: A.id });
  const a1 = await BrowserTestUtils.openNewForegroundTab(w0.gBrowser, `${PAGE}?dr-a1`);
  const a2 = await BrowserTestUtils.openNewForegroundTab(w0.gBrowser, `${PAGE}?dr-a2`);
  w0.gBrowser.selectedTab = a1;
  await until(
    () => ww0.model.workspaces.find((w) => w.id === A.id).activeTab === ww0.idOf(a1),
    "A's selected tab is its first page",
  );
  ww0.switchTo({ id: B.id });
  await until(() => w0.gBrowser.selectedTab.userContextId === B.userContextId, "B's start tab");
  const b1 = await BrowserTestUtils.openNewForegroundTab(w0.gBrowser, `${PAGE}?dr-b1`);
  const uuid = (/** @type {Element} */ t) => SessionStore.getCustomTabValue(t, "vimma-tab");
  const uuids = new Map([a1, a2, b1].map((t) => [t, uuid(t)]));
  await TabStateFlusher.flushWindow(w0);
  await TestUtils.waitForTick();
  const winState = JSON.parse(SessionStore.getBrowserState()).windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?dr-b1`)),
  );
  await BrowserTestUtils.closeWindow(w0);

  await lastWindowCase(withAClosedTab, async (win) => {
    const ww = WindowWorkspaces.get(win);
    const stuck = ww.health().recovered;
    Assert.ok(stuck, "the reopened window's restore never finished");

    // This restore does finish (sessionstore-single-window-restored), only without a Busy or
    // Ready: neither the console nor the report may call it one that never finished.
    /** @type {string[]} */
    const lines = [];
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    const onLog = (/** @type {any} */ m) => lines.push((m.arguments ?? []).map(String).join(" "));
    storage.addLogEventListener(onLog, Services.scriptSecurityManager.getSystemPrincipal());
    try {
      await restoreInto(win, winState);
    } finally {
      storage.removeLogEventListener(onLog);
    }
    Assert.deepEqual(
      lines.filter((l) => l.includes("never finished")),
      [],
      "no warning of a restore that never finished",
    );
    const after = ww.health().recovered;
    Assert.deepEqual(
      [after?.reason, after?.afterMs],
      [stuck.reason, stuck.afterMs],
      "the stuck restore on record is still the first one",
    );
    const report = AboutVimma.report(await AboutVimma.collect(win));
    Assert.equal(report.match(/\n {2}recovered: /g)?.length, 1, "the report names one");
    Assert.ok(!/\n {2}restore pending/.test(report), "and no restore pending");

    const model = ww.model;
    const ws = (/** @type {string} */ id) => model.workspaces.find((w) => w.id === id);
    Assert.deepEqual(
      ws(A.id).tabs.slice(-2),
      [uuids.get(a1), uuids.get(a2)],
      "A's tabs come back with their uuids",
    );
    Assert.equal(ws(A.id).activeTab, uuids.get(a1), "A's selected tab is remembered");
    Assert.equal(ws(B.id).tabs.at(-1), uuids.get(b1), "B's page comes back with its uuid");
    Assert.equal(model.active, B.id, "B is the active workspace");
    Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
  });
});

add_task(async function a_window_reopened_after_the_last_one_closed_with_a_pinned_tab() {
  await lastWindowCase(async (first) => {
    WindowWorkspaces.get(first).unpinsPinnedTabs = false;
    const pinned = await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?pinned`);
    first.gBrowser.pinTab(pinned);
    await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?kept`);
  });
});

// The test-only pref of another type (a string here) must not stop the bound: a throw at the
// Busy, after the window entered pending and before its timer was set, would freeze it again.
add_task(async function a_bound_pref_of_another_type_still_ends_a_stuck_restore() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.workspaces.stuckRestoreMs", "200"]] });
  try {
    await throwingRestore();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function a_restore_that_throws_partway_does_not_stop_the_model() {
  // The test-only bound, short: the timer ends the stuck restore without a real 5 s wait.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.workspaces.stuckRestoreMs", 200]] });
  try {
    await throwingRestore();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

/** A restore that throws partway, then tabs opened; the calling task sets the bound. */
async function throwingRestore() {
  const win = await openWindow();
  const ww = WindowWorkspaces.get(win);
  const gone = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?undo`);
  await TabStateFlusher.flush(gone.linkedBrowser);
  BrowserTestUtils.removeTab(gone);

  // SessionStore's restoreTab raises its window's busy count, then calls tabbrowser.showTab for
  // the tab it restores before lowering it again. Anything that throws in between (here, a stub
  // of that real call) leaves the count raised: SSWindowStateBusy went out, SSWindowStateReady
  // never does.
  const showTab = win.gBrowser.showTab;
  win.gBrowser.showTab = () => {
    throw new Error("injected failure inside restoreTab");
  };
  try {
    Assert.throws(() => SessionStore.undoCloseTab(win, 0), /injected/, "the restore threw");
  } finally {
    win.gBrowser.showTab = showTab;
  }

  await useWindow(win);
  info(`out of step right after use: ${outOfStep(win).join("; ") || "nothing"}`);
  await until(() => outOfStep(win).length === 0, "the model catches up with the live tabs");
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");

  const health = ww.health();
  Assert.equal(health.pending, false, "the window is no longer waiting for the restore");
  Assert.ok(health.recovered, "the stuck restore is on record");
  await BrowserTestUtils.closeWindow(win);
}

add_task(async function lazy_tabs_selected_after_a_restore_stay_in_step() {
  const win = await openWindow();
  const entry = (/** @type {string} */ q) => ({
    entries: [
      { url: `${PAGE}?${q}`, triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL },
    ],
  });
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  SessionStore.setWindowState(
    win,
    JSON.stringify({ windows: [{ tabs: [entry("l1"), entry("l2"), entry("l3")], selected: 1 }] }),
    true,
  );
  await restored;
  await TestUtils.waitForTick();
  for (const tab of [...win.gBrowser.tabs]) {
    win.gBrowser.selectedTab = tab;
    await TestUtils.waitForTick();
  }
  await useWindow(win);
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function undo_close_and_duplicate_stay_in_step() {
  const win = await openWindow();
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?dup`);
  const copy = win.gBrowser.duplicateTab(tab);
  await BrowserTestUtils.waitForEvent(copy, "SSTabRestored");
  const gone = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?x`);
  await TabStateFlusher.flush(gone.linkedBrowser);
  BrowserTestUtils.removeTab(gone);
  const back = SessionStore.undoCloseTab(win, 0);
  await BrowserTestUtils.waitForEvent(back, "SSTabRestored");
  await useWindow(win);
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function background_opens_inside_a_restore_bracket_stay_in_step() {
  const win = await openWindow();
  const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
  const state = {
    windows: [
      {
        tabs: [
          {
            entries: [
              {
                url: `${PAGE}?r`,
                triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
              },
            ],
          },
        ],
      },
    ],
  };
  SessionStore.setWindowState(win, JSON.stringify(state), false);
  // Still inside the bracket: SSWindowStateReady waits for the window's features.
  win.gBrowser.addTab(`${PAGE}?bg`, { triggeringPrincipal: system(), inBackground: true });
  await restored;
  await TestUtils.waitForTick();
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function a_tab_moved_to_another_window_leaves_both_in_step() {
  const from = await openWindow();
  const to = await openWindow();
  const tab = await BrowserTestUtils.openNewForegroundTab(from.gBrowser, `${PAGE}?moved`);
  await BrowserTestUtils.openNewForegroundTab(from.gBrowser, `${PAGE}?stays`);
  const adopted = to.gBrowser.adoptTab(tab, { selectTab: true });
  Assert.ok(adopted, "the tab moved");
  await TestUtils.waitForTick();
  Assert.deepEqual(outOfStep(from), [], "the window it left is in step");
  Assert.deepEqual(outOfStep(to), [], "the window it joined is in step");
  await BrowserTestUtils.closeWindow(from);
  await BrowserTestUtils.closeWindow(to);
});
