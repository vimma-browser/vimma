/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The workspace desync mochitests' helpers (docs/specs/m3-workspaces.md, sub-spec 3), shared by
// browser_vimma_workspace_desync.js and browser_vimma_workspace_desync_last_window.js, which split
// the suite to keep each file inside the harness's time limit (issue #1566). Loaded with
// Services.scriptloader.loadSubScript into the test's scope.

"use strict";

/* exported WorkspaceDesync */

// One name for every helper: each head file's top-level names are declared to every test's type
// check (tools/gen-mochitest-head.ts), and live grep's head has its own `PAGE` and `until`.
const WorkspaceDesync = (() => {
  /** @type {VimmaModules["chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs"]["WindowWorkspaces"]} */
  const WindowWorkspaces = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
  ).WindowWorkspaces;
  /** @type {VimmaModules["chrome://browser/content/vimma/host/goto.mjs"]["pickerWorkspaces"]} */
  const pickerWorkspaces = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/goto.mjs",
  ).pickerWorkspaces;

  const PAGE = "https://example.com/";

  /** @type {BrowserWindow[]} */
  const windows = [];

  registerCleanupFunction(async () => {
    for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  });

  /** @param {() => unknown} cond @param {string} msg */
  function until(cond, msg) {
    return TestUtils.waitForCondition(cond, msg, 50, 200);
  }

  const system = () => Services.scriptSecurityManager.getSystemPrincipal();

  async function openWindow() {
    const win = await BrowserTestUtils.openNewBrowserWindow();
    windows.push(win);
    await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win)).ready;
    await until(
      () => !!(/** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win)).model),
      "the new window has its workspaces",
    );
    return win;
  }

  /**
   * What is out of step between the window's model and its live tabs; [] when nothing is.
   * @param {BrowserWindow} win
   */
  function outOfStep(win) {
    const ww = /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
    const model = ww.model;
    const problems = [];
    const inModel = new Set(model.workspaces.flatMap((/** @type {WorkspaceState} */ w) => w.tabs));
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
   * @param {BrowserWindow} win
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

  return { PAGE, until, system, openWindow, outOfStep, useWindow };
})();
