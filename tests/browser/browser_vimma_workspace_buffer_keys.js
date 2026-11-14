/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, "Settled: workspaces as Vim buffers": ctrl+^ / ctrl+6 (and
// ctrl+b ^ / ctrl+b ctrl+6 in every mode) go back to the window's previous workspace and toggle;
// ]w / [w step like ctrl+b ) / (; :ws, :wn, :wp, :wd, :wa and :workspaces are the buffer
// commands' workspace twins; the previous workspace is saved with the window's session.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces, WINDOW_KEY } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const PICKER_ID = "vimma-workspace-picker";
const INPUT_ID = "vimma-cmdline-input";
const NO_PREVIOUS = "no previous workspace in this window";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
/** The main workspace, which is always there. */
const main = () => /** @type {WorkspaceDefinition} */ (def("main"));
/**
 * A window's workspaces, which VimmaHost made when it started the window.
 * @param {BrowserWindow} [win]
 */
const ww = (win = window) => /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(win));
/**
 * A window's workspaces once their model is built.
 * @param {BrowserWindow} [win]
 */
const live = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
/** @param {BrowserWindow} [win] */
const active = (win = window) => live(win).model.active;
/** @param {BrowserWindow} [win] */
const alternate = (win = window) => live(win).model.alternate;
/**
 * The workspace picker, a <dialog> (ui/picker.mjs), or null when it was never opened.
 * @param {Window} [win]
 */
const picker = (win = window) =>
  /** @type {HTMLDialogElement | null} */ (win.document.getElementById(PICKER_ID));

/** @type {Window[]} */
const windows = [];

registerCleanupFunction(async () => {
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  if (document.getElementById(PROMPT_ID)?.hidden === false) EventUtils.synthesizeKey("KEY_Escape");
  if (picker()?.open) EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: main().id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** @param {string} name */
function workspace(name) {
  return WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
}

/** @param {Window} [win] */
const noticeText = (win = window) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const pickerOpen = () => !!picker()?.open;
const modeText = () =>
  document.querySelector('#vimma-statusbar [data-segment="mode"]')?.textContent ?? null;

/**
 * Focuses `win`'s selected page, once it has loaded, so keys reach Vimma in normal mode
 * (head.js's focusContent checks this window's focus only).
 * @param {BrowserWindow} [win]
 */
async function focusPage(win = window) {
  const tab = win.gBrowser.selectedTab;
  const browser = tab.linkedBrowser;
  await until(
    () => !tab.hasAttribute("pending") && !browser.webProgress?.isLoadingDocument,
    "the selected page has loaded",
  );
  if (win === window) {
    await focusContent(browser);
    return;
  }
  await SimpleTest.promiseFocus(browser);
  await until(() => win.document.activeElement === browser, "focus is in the content browser");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.document.hasFocus()),
    "the page has focus",
  );
}

/**
 * `:line` Enter, from the selected page in normal mode.
 * @param {string} line
 */
async function runCommand(line) {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/**
 * Shows workspace `w` (by API), waiting for the window to be in it.
 * @param {{ id: string, name: string }} w
 * @param {BrowserWindow} [win]
 */
async function show(w, win = window) {
  Assert.equal(ww(win).switchTo({ id: w.id }), null, `switched to ${w.name}`);
  await until(() => active(win) === w.id, `the window shows ${w.name}`);
}

/**
 * Workspaces A and B besides main, the window in main, then A, then B: B is shown and A is the
 * previous workspace.
 * @param {string} a
 * @param {string} b
 */
async function aThenB(a, b) {
  const A = workspace(a);
  const B = workspace(b);
  await show(main());
  await show(A);
  await show(B);
  Assert.equal(alternate(), A.id, `${a} is the previous workspace`);
  return { A, B };
}

add_task(async function ctrl_caret_toggles_between_two_workspaces_and_back() {
  const { A, B } = await aThenB("caret-a", "caret-b");
  await focusPage();
  // US layout: ctrl+shift+6 types "^".
  EventUtils.synthesizeKey("^", { ctrlKey: true, shiftKey: true, code: "Digit6" });
  await until(() => active() === A.id, "ctrl+^ goes back to A");
  Assert.equal(alternate(), B.id, "and B becomes the previous one");
  await focusPage();
  EventUtils.synthesizeKey("^", { ctrlKey: true, shiftKey: true, code: "Digit6" });
  await until(() => active() === B.id, "ctrl+^ again toggles back to B");
  Assert.equal(alternate(), A.id, "A is the previous one again");
});

add_task(async function ctrl_6_works_where_caret_is_a_dead_key() {
  const { A, B } = await aThenB("six-a", "six-b");
  await focusPage();
  EventUtils.synthesizeKey("6", { ctrlKey: true, code: "Digit6" });
  await until(() => active() === A.id, "ctrl+6 goes back to A");
  await focusPage();
  EventUtils.synthesizeKey("6", { ctrlKey: true, code: "Digit6" });
  await until(() => active() === B.id, "ctrl+6 toggles back to B");
});

add_task(async function prefix_caret_works_from_insert_mode() {
  const { A, B } = await aThenB("ins-a", "ins-b");
  await focusPage();
  EventUtils.synthesizeKey("i");
  await until(() => modeText() === "INSERT", "i enters insert mode");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("^", { shiftKey: true, code: "Digit6" });
  await until(() => active() === A.id, "ctrl+b ^ in insert mode goes back to A");
  await focusPage();
  EventUtils.synthesizeKey("i");
  await until(() => modeText() === "INSERT", "insert mode again");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("6", { ctrlKey: true, code: "Digit6" });
  await until(() => active() === B.id, "ctrl+b ctrl+6 in insert mode toggles back to B");
  await focusPage();
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => modeText() === "NORMAL", "back to normal mode");
});

add_task(async function a_new_window_has_no_previous_workspace_and_says_so() {
  workspace("fresh-a");
  const win = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(win);
  await ww(win).ready;
  await until(() => !!ww(win).model, "the new window has its workspaces");
  Assert.equal(alternate(win), undefined, "no previous workspace yet");
  const before = active(win);
  await focusPage(win);
  EventUtils.synthesizeKey("6", { ctrlKey: true, code: "Digit6" }, win);
  await until(() => noticeText(win) === NO_PREVIOUS, "the notice says there is none");
  Assert.equal(active(win), before, "and the window stays where it was");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function bracket_w_steps_through_the_workspaces() {
  const A = workspace("br-a");
  const B = workspace("br-b");
  await show(A);
  const order = () => WorkspaceStore.definitions.workspaces.map((d) => d.id);
  const after = (/** @type {string} */ id) => order()[(order().indexOf(id) + 1) % order().length];
  Assert.equal(after(A.id), B.id, "sanity: B follows A");
  await focusPage();
  EventUtils.synthesizeKey("]");
  EventUtils.synthesizeKey("w");
  await until(() => active() === B.id, "]w goes to the next workspace");
  await focusPage();
  EventUtils.synthesizeKey("[");
  EventUtils.synthesizeKey("w");
  await until(() => active() === A.id, "[w goes to the previous one");
  // Finnish layout: ] is AltGr+9, [ is AltGr+8 (key-handling-batch § 3).
  await focusPage();
  EventUtils.synthesizeKey("]", { altGraphKey: true, code: "Digit9" });
  EventUtils.synthesizeKey("w");
  await until(() => active() === B.id, "AltGr+9 w is ]w");
  await focusPage();
  EventUtils.synthesizeKey("[", { altGraphKey: true, code: "Digit8" });
  EventUtils.synthesizeKey("w");
  await until(() => active() === A.id, "AltGr+8 w is [w");
});

add_task(async function short_commands_work_like_vims_buffer_commands() {
  const A = workspace("cmd-a");
  const B = workspace("cmd-b");
  await show(A);
  const index = (/** @type {{ id: string }} */ w) =>
    WorkspaceStore.definitions.workspaces.findIndex((d) => d.id === w.id) + 1;

  await runCommand("ws cmd-b");
  await until(() => active() === B.id, ":ws name switches");
  await runCommand(`ws ${index(A)}`);
  await until(() => active() === A.id, ":ws N switches by place");
  await runCommand("ws #");
  await until(() => active() === B.id, ":ws # goes to the previous workspace");

  await runCommand("wp");
  await until(() => active() === A.id, ":wp is :wsprev");
  await runCommand("wn");
  await until(() => active() === B.id, ":wn is :wsnext");
  await runCommand("wsn");
  await until(() => active() !== B.id, ":wsn is still :wsnext");
  await show(B);

  await runCommand("workspaces");
  await until(pickerOpen, ":workspaces opens the workspace picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !pickerOpen(), "Esc closes it");

  await runCommand("wa cmd-c");
  await until(() => {
    const made = def("cmd-c");
    return !!made && active() === made.id;
  }, ":wa name is :wsnew");

  await runCommand("wd cmd-b");
  await until(promptOpen, ":wd name asks, as :wsdelete does");
  EventUtils.synthesizeKey("y");
  await until(() => !def("cmd-b"), "and y closes the named workspace");
});

add_task(async function tab_completes_workspace_names_after_ws_and_wd() {
  const A = workspace("tab-alpha");
  await show(main());
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("ws tab-al");
  EventUtils.synthesizeKey("KEY_Tab");
  // The command line's <input>, which `:` has shown.
  const input = /** @type {HTMLInputElement} */ (document.getElementById(INPUT_ID));
  await until(() => input.value === "ws tab-alpha", "Tab completes the workspace's name");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => active() === A.id, "and Enter switches to it");

  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("wd tab-al");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => input.value === "wd tab-alpha", ":wd completes names too");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function the_previous_workspace_survives_a_restore() {
  const A = workspace("rs-prev-a");
  const B = workspace("rs-prev-b");
  const M = main();
  const w1 = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(w1);
  await ww(w1).ready;
  await until(() => !!ww(w1).model, "the window has its workspaces");
  await show(A, w1);
  await BrowserTestUtils.openNewForegroundTab(w1.gBrowser, `${PAGE}?prev-a`);
  await show(B, w1);
  await BrowserTestUtils.openNewForegroundTab(w1.gBrowser, `${PAGE}?prev-b`);
  // main, then B: main is the previous one. A restore rebuilding the model in workspace order
  // (main, A, B) would land on A by itself, so main shows the saved value is used.
  await show(M, w1);
  await show(B, w1);
  Assert.equal(alternate(w1), M.id, "main is the previous workspace");
  await TabStateFlusher.flushWindow(w1);
  await TestUtils.waitForTick();
  const saved = () => JSON.parse(SessionStore.getCustomWindowValue(w1, WINDOW_KEY) || "{}");
  await until(() => saved().alternate === M.id, "the window value saves it");
  /**
   * SessionStore's state, as much of it as this test reads.
   * It mirrors engine/browser/components/sessionstore: SessionStore.sys.mjs (a window's winData),
   * TabState.sys.mjs (a tab) and SessionHistory.sys.mjs (its entries).
   * @type {{ windows: { tabs: { entries: { url: string }[] }[] }[] }}
   */
  const state = JSON.parse(SessionStore.getBrowserState());
  const winState = state.windows.find((w) =>
    w.tabs.some((t) => t.entries.some((e) => e.url === `${PAGE}?prev-b`)),
  );
  Assert.ok(winState, "the window is in the browser state");
  await BrowserTestUtils.closeWindow(w1);

  const w2 = await BrowserTestUtils.openNewBrowserWindow();
  windows.push(w2);
  await ww(w2).ready;
  await until(() => !!ww(w2).model, "the second window has its workspaces");
  const restored = BrowserTestUtils.waitForEvent(w2, "SSWindowRestored");
  // The restored page loads in a new content process, and the browser has the page's URI while
  // it still holds the about:blank that load replaces: a spawn into that document fails with
  // "Actor 'SpecialPowers' destroyed". Focus the page once SessionStore says the restore is done.
  const pageBack = BrowserTestUtils.waitForEvent(
    w2.gBrowser.tabContainer,
    "SSTabRestored",
    false,
    // SSTabRestored's target is the restored tab.
    (/** @type {Event} */ e) =>
      /** @type {MozTabbrowserTab} */ (e.target).linkedBrowser.currentURI.spec === `${PAGE}?prev-b`,
  );
  SessionStore.setWindowState(w2, JSON.stringify({ windows: [winState] }), true);
  await restored;
  await TestUtils.waitForTick();
  await until(() => active(w2) === B.id, "B is active after the restore");
  Assert.equal(alternate(w2), M.id, "and main is still the previous workspace");
  const { target: back } = await pageBack;
  await until(() => w2.gBrowser.selectedTab === back, "the selected tab has its page back");
  await focusPage(w2);
  EventUtils.synthesizeKey("6", { ctrlKey: true, code: "Digit6" }, w2);
  await until(() => active(w2) === M.id, "ctrl+6 goes back to main in the restored window");
  await BrowserTestUtils.closeWindow(w2);
});
