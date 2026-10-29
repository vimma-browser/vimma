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

const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
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

registerCleanupFunction(async () => {
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
});

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

async function lastWindowCase(prepare) {
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
    await useWindow(win);
    info(`out of step right after use: ${outOfStep(win).join("; ") || "nothing"}`);
    await until(() => outOfStep(win).length === 0, "the model catches up with the live tabs");
    Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");
  } finally {
    // The next case needs this one to close as the last window again.
    if (win && !win.closed) await BrowserTestUtils.closeWindow(win);
    brackets.stop();
    document.documentElement.setAttribute("windowtype", type);
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function a_window_reopened_after_the_last_one_closed_with_a_closed_tab() {
  await lastWindowCase(async (first) => {
    const gone = await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?closed`);
    BrowserTestUtils.removeTab(gone);
    await BrowserTestUtils.openNewForegroundTab(first.gBrowser, `${PAGE}?kept`);
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

add_task(async function a_restore_that_throws_partway_does_not_stop_the_model() {
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
});

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
