/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 5 (m3-workspace-picker): prefix+w lists the
// workspaces with their tab counts, the current one marked; `/` filters, Enter switches, `m`
// moves the current tab there after a y/N warning that its history stays behind. A tab opened
// in the background in another workspace says where it went.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const PICKER_ID = "vimma-workspace-picker";
const GOTO_ID = "vimma-picker";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find(
    (/** @type {WorkspaceDefinition} */ w) => w.name === name,
  );
const ww = () => WindowWorkspaces.get(window);
const active = () => ww().model.active;
const tabsIn = (/** @type {string} */ id) =>
  ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === id).tabs;

const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const cell = (/** @type {Element} */ row, /** @type {string} */ name) =>
  /** @type {Element} */ (row.querySelector(`.vimma-picker-${name}`)).textContent;
const names = () => rows().map((r) => cell(r, "title"));
/** The selected row; a use while the picker is shut throws, which fails the test. */
const selected = () =>
  /** @type {Element} */ (
    /** @type {HTMLDialogElement} */ (picker()).querySelector("[role=option][aria-selected=true]")
  );
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const promptText = () =>
  (
    document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? ""
  ).trim();

registerCleanupFunction(async () => {
  if (isOpen()) EventUtils.synthesizeKey("KEY_Escape");
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: def("main").id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (/** @type {WorkspaceDefinition} */ d) =>
      d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. @param {string} key @param {KeyEventOptions} [mods] */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** Focuses the selected page, once it has loaded, so keys reach it in normal mode. */
async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
}

/** prefix+w from the selected page, waiting for the picker. */
async function openPicker() {
  await focusPage();
  prefix("w");
  await until(isOpen, "prefix+w opens the workspace picker");
}

/** Opens a page in the shown workspace and selects it. @param {string} query */
async function openPage(query) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${query}`);
  return tab;
}

add_task(async function setup_three_workspaces() {
  await ww().ready;
  for (const name of ["alpha", "beta"]) {
    if (!def(name)) WorkspaceStore.newWorkspace(name);
  }
  // docs/specs/vimma-mcp.md decision 8: every profile has the agent workspace, which sorts last.
  await until(() => ww().model.workspaces.length === 4, "main, alpha, beta and agent");
  ww().switchTo({ id: def("main").id });
});

add_task(async function prefix_w_lists_workspaces_with_counts_and_switches() {
  const a = def("alpha");
  ww().switchTo({ id: a.id });
  await openPage("a1");
  ww().switchTo({ id: def("main").id });
  await until(() => active() === def("main").id, "back in main");

  await openPicker();
  // docs/specs/private-workspace.md decision 5: the private workspace is the last row; the agent
  // workspace (docs/specs/vimma-mcp.md decision 9) the last of the normal ones, as `◇ agent`.
  Assert.deepEqual(
    names(),
    ["main", "alpha", "beta", "◇ agent", "◆ private"],
    "every workspace, in ctrl+i order, the agent's last, then the private workspace",
  );
  Assert.equal(cell(rows()[3], "index"), "4", "the agent workspace keeps its place");
  Assert.equal(cell(rows()[3], "host"), "0 tabs", "and its tab count");
  Assert.equal(cell(rows()[4], "host"), "new", "the private one says new while it is not open");
  const counts = rows().map((r) => cell(r, "host"));
  Assert.ok(counts[0].startsWith(`${tabsIn(def("main").id).length} tab`), "main's tab count");
  Assert.ok(counts[0].includes("current"), "main is marked as current");
  Assert.ok(counts[1].startsWith(`${tabsIn(a.id).length} tabs`), "alpha's tab count");
  Assert.ok(!counts[1].includes("current"), "alpha is not");
  Assert.equal(cell(selected(), "title"), "main", "it opens on the current workspace");
  Assert.ok(rows()[0].classList.contains("vimma-picker-active"), "the current row is marked");
  Assert.equal(cell(rows()[1], "index"), "2", "rows are numbered by place");
  Assert.ok(
    !(/** @type {HTMLDialogElement | null} */ (document.getElementById(GOTO_ID))?.open),
    "the goto picker stays shut",
  );

  // Theme tokens, as the goto picker: the dialog takes --vimma-bg-dark.
  const bg = getComputedStyle(/** @type {HTMLDialogElement} */ (picker())).backgroundColor;
  document.documentElement.style.setProperty("--vimma-bg-dark", "rgb(1, 2, 3)");
  await until(
    () =>
      getComputedStyle(/** @type {HTMLDialogElement} */ (picker())).backgroundColor ===
      "rgb(1, 2, 3)",
    "themed",
  );
  document.documentElement.style.removeProperty("--vimma-bg-dark");
  await until(
    () => getComputedStyle(/** @type {HTMLDialogElement} */ (picker())).backgroundColor === bg,
    "and back",
  );

  EventUtils.synthesizeKey("/");
  EventUtils.sendString("alp");
  await until(() => names().join() === "alpha", "typing filters by name");
  Assert.equal(selected().querySelector("mark")?.textContent, "alp", "the match is highlighted");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter closes the picker");
  await until(() => active() === a.id, "and switches to alpha");

  await openPicker();
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes it");
  Assert.equal(active(), a.id, "without switching");
  ww().switchTo({ id: def("main").id });
});

add_task(async function workspace_without_a_name_opens_the_picker() {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("workspace");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":workspace opens the picker");
  EventUtils.synthesizeKey("q");
  await until(() => !isOpen(), "q closes it");
});

add_task(async function m_warns_then_moves_the_current_tab() {
  const b = def("beta");
  const tab = await openPage("moving");
  const from = active();

  await openPicker();
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  await openPicker();
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("j");
  Assert.equal(cell(selected(), "title"), "beta", "beta selected");
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m asks first");
  Assert.ok(!isOpen(), "the picker has closed");
  Assert.ok(/"beta"/.test(promptText()), "naming the target");
  Assert.ok(/history/.test(promptText()), "warning that the history stays behind");
  Assert.ok(/y\/N$/.test(promptText()), "as a y/N question");
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers");
  Assert.ok(tab.isConnected, "n keeps the tab where it was");
  Assert.ok(tabsIn(from).includes(ww().idOf(tab)), "in its workspace");

  await openPicker();
  EventUtils.synthesizeKey("/");
  EventUtils.sendString("bet");
  EventUtils.synthesizeKey("KEY_Escape"); // back to browse, the filter kept
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m asks again");
  EventUtils.synthesizeKey("y");
  await until(() => !tab.isConnected, "y moves it: the original closes");
  await until(
    () =>
      tabsIn(b.id).some(
        (/** @type {string} */ id) =>
          ww().tabOf(id)?.linkedBrowser.currentURI.spec === `${PAGE}?moving`,
      ),
    "the page reopens in beta",
  );
  Assert.equal(active(), from, "the window stays where it was");
  await until(() => /moved to "beta"/.test(noticeText()), "the notice says where");
});

add_task(async function a_stale_answer_moves_nothing() {
  const tab = await openPage("stale");
  const from = active();
  await openPicker();
  EventUtils.synthesizeKey("/");
  EventUtils.sendString("bet");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("m");
  await until(promptOpen, "m asks");
  // The target changes before the answer: the y stood for "beta", not "gamma".
  WorkspaceStore.renameWorkspace(def("beta").id, "gamma");
  await until(
    () => ww().model.workspaces.some((/** @type {WorkspaceState} */ w) => w.name === "gamma"),
    "renamed",
  );
  EventUtils.synthesizeKey("y");
  await until(() => /nothing was moved/.test(noticeText()), "the answer is refused");
  Assert.ok(tab.isConnected, "the tab stays");
  Assert.ok(tabsIn(from).includes(ww().idOf(tab)), "in its workspace");
  WorkspaceStore.renameWorkspace(def("gamma").id, "beta");
});

add_task(async function moving_to_the_tabs_own_workspace_is_refused_without_asking() {
  await openPage("home");
  await openPicker();
  Assert.equal(cell(selected(), "title"), "main", "on the current workspace");
  EventUtils.synthesizeKey("m");
  await until(() => /already in "main"/.test(noticeText()), "already there");
  Assert.ok(!promptOpen(), "nothing to confirm");
});

add_task(async function a_background_open_in_another_workspace_says_where() {
  const a = def("alpha");
  const tab = BrowserTestUtils.addTab(gBrowser, `${PAGE}?bg`, { userContextId: a.userContextId });
  await until(() => tab.hidden, "it joins alpha, hidden");
  Assert.notEqual(active(), a.id, "no switch");
  await until(() => noticeText() === 'opened in "alpha"', "the notice says where it went");
});
