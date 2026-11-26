/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 3 (Reconcile): the window's workspace model stays
// in step with its live tabs through the paths SessionStore drives (issue #546): a restore that
// throws partway, lazy tabs getting their browsers, undo close, duplicate, background opens inside
// a restore bracket, and a tab moved to another window. Tab search and the side panel read the
// model; the status bar and `gt` read the tabs, so a model out of step shows as the first two
// listing fewer tabs than the window has. A window reopened after the last one closed is in
// browser_vimma_workspace_desync_last_window.js; the shared helpers are in
// head_vimma_workspace_desync.js.

"use strict";

/* global E10SUtils -- a browser window global */
/* global WorkspaceDesync -- from head_vimma_workspace_desync.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_workspace_desync.js",
  this,
);
const { PAGE, until, system, openWindow, outOfStep, useWindow } = WorkspaceDesync;

const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const { WindowWorkspaces, STUCK_RESTORE_MS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

// The test-only pref of another type (a string here) must not stop the bound: a throw at the
// Busy, after the window entered pending and before its timer was set, would freeze it again.
// The pref is ignored, so the bound in effect is the real one, STUCK_RESTORE_MS; the test checks
// that its timer is set and ends the restore, without spending those 5 s of wall-clock time.
// The timer then fires before the tabs open; tabs opened while pending, then reconciled by the
// timer, are the next task's case.
add_task(async function a_bound_pref_of_another_type_still_ends_a_stuck_restore() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.workspaces.stuckRestoreMs", "200"]] });
  try {
    await throwingRestore({ expectedBound: STUCK_RESTORE_MS });
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

/**
 * A restore that throws partway, then tabs opened; the calling task sets the bound. With
 * `expectedBound`, the stuck-restore timer must be set at that bound.
 * @param {{ expectedBound?: number }} [options]
 */
async function throwingRestore({ expectedBound } = {}) {
  const win = await openWindow();
  const ww = /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
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
  // The bound's timer is set on the window (WindowWorkspaces' SSWindowStateBusy handler) inside
  // this synchronous call. With `expectedBound`, a timer at that bound is recorded and run at
  // once: waiting it out would only test the window's setTimeout, and at the real 5 s bound it was
  // a third of this file's time (issue #1509).
  const realSetTimeout = win.setTimeout;
  /** @type {number[]} */
  const delays = [];
  if (expectedBound !== undefined) {
    win.setTimeout = /** @type {typeof win.setTimeout} */ (
      (/** @type {TimerHandler} */ fn, ms = 0, /** @type {unknown[]} */ ...args) => {
        delays.push(ms);
        return realSetTimeout.call(win, fn, ms === expectedBound ? 0 : ms, ...args);
      }
    );
  }
  try {
    Assert.throws(() => SessionStore.undoCloseTab(win, 0), /injected/, "the restore threw");
  } finally {
    win.gBrowser.showTab = showTab;
    win.setTimeout = realSetTimeout;
  }
  if (expectedBound !== undefined) {
    Assert.equal(
      delays.filter((ms) => ms === expectedBound).length,
      1,
      `the stuck-restore timer is set at ${expectedBound} ms`,
    );
  }

  await useWindow(win);
  info(`out of step right after use: ${outOfStep(win).join("; ") || "nothing"}`);
  await until(() => outOfStep(win).length === 0, "the model catches up with the live tabs");
  Assert.deepEqual(outOfStep(win), [], "every live tab is in the model, and back");

  const health = ww.health();
  Assert.equal(health.pending, false, "the window is no longer waiting for the restore");
  Assert.ok(health.recovered, "the stuck restore is on record");
  if (expectedBound !== undefined) {
    const recovered = /** @type {{ reason: string, afterMs: number }} */ (health.recovered);
    Assert.equal(recovered.reason, "no SSWindowStateReady", "the bound's timer ended it");
    Assert.less(recovered.afterMs, expectedBound, "without the bound's wall-clock wait");
  }
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
