/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 6 (m3-side-panel): `prefix+b` /
// `:sidebar` open a panel on the left headed by the current workspace and its ctrl+b ( / ctrl+b )
// neighbours, listing its tabs as numbered rows. In `panel` mode j/k move, Enter or a digit
// selects a tab and closes, Esc / `prefix+b` close; ctrl+b ) re-renders it.

"use strict";

/* global focusContent, recordPageKeys, pageKeys -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);

const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const ww = () => WindowWorkspaces.get(window);
const active = () => ww().model.active;
const tabsIn = (/** @type {string} */ name) =>
  ww().model.workspaces.find((w) => w.id === def(name).id).tabs;

const panel = () => document.getElementById(PANEL_ID);
const isOpen = () => !!panel() && !panel().hidden && BrowserTestUtils.isVisible(panel());
const rows = () => [...(panel()?.querySelectorAll("[role=option]") ?? [])];
const text = (el, name) => el.querySelector(`.vimma-panel-${name}`)?.textContent ?? "";
const titles = () => rows().map((r) => text(r, "title"));
const selected = () => panel().querySelector("[role=option][aria-selected=true]");
const header = () => panel().querySelector(".vimma-panel-header");
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

registerCleanupFunction(async () => {
  if (isOpen()) EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: def("main").id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** `prefix+b`: ctrl+b, b. */
function toggleKey() {
  prefix("b");
}

/** Focuses the selected page, once it has loaded, so keys reach it in normal mode. */
async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
}

/** `ctrl+b b` from the selected page, waiting for the panel. */
async function openPanel() {
  await focusPage();
  toggleKey();
  await until(isOpen, "ctrl+b b opens the side panel");
}

/** Opens `${PAGE}?<query>` in the shown workspace, selected, titled `query`. */
async function openPage(query) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?${query}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [query], (t) => {
    content.document.title = t;
  });
  await until(() => tab.linkedBrowser.contentTitle === query, "the page has its title");
  return tab;
}

/** Every visible child of #browser, left to right. */
function browserBoxOrder() {
  return [...document.getElementById("browser").children]
    .filter((el) => BrowserTestUtils.isVisible(el) && el.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
}

add_task(async function setup_two_workspaces() {
  await ww().ready;
  if (!def("alpha")) WorkspaceStore.newWorkspace("alpha");
  // docs/specs/vimma-mcp.md decision 8: the agent workspace too, last.
  await until(() => ww().model.workspaces.length === 3, "main, alpha and agent");
  ww().switchTo({ id: def("alpha").id });
  await openPage("alpha-one");
  ww().switchTo({ id: def("main").id });
  await until(() => active() === def("main").id, "back in main");
  await openPage("main-two");
  await openPage("main-three");
});

add_task(async function hidden_by_default_and_prefix_b_opens_it_on_the_left() {
  Assert.ok(!isOpen(), "the panel is closed at start");
  await openPanel();
  Assert.equal(browserBoxOrder()[0], panel(), "it is the leftmost box of the window");
  Assert.ok(
    panel().getBoundingClientRect().right <=
      document.getElementById("tabbrowser-tabbox").getBoundingClientRect().left,
    "the pages sit to its right",
  );
  Assert.stringContains(text(header(), "name"), "1:main", "headed by the current workspace");
  Assert.stringContains(text(header(), "neighbours"), "alpha", "and its ctrl+b ) neighbour");
  const n = tabsIn("main").length;
  Assert.deepEqual(
    titles().slice(-2),
    ["main-two", "main-three"],
    "the workspace's tabs, in order",
  );
  Assert.equal(rows().length, n, "only main's tabs, not alpha's");
  Assert.ok(!titles().includes("alpha-one"), "alpha's tab is not listed");
  Assert.deepEqual(
    rows().map((r) => text(r, "number")),
    Array.from({ length: n }, (_, i) => String(i + 1)),
    "numbered rows",
  );
  Assert.equal(text(rows().at(-1), "host"), "example.com", "with the host");
  Assert.equal(text(selected(), "title"), "main-three", "the highlight starts on the active tab");
  Assert.ok(selected().classList.contains("vimma-panel-active"), "which is marked active");
  Assert.ok(panel().contains(document.activeElement), "focus is in the panel");
  Assert.equal(VimmaHost.status(window).mode, "panel", "the window is in panel mode");

  // Theme tokens, as the pickers: the panel takes --vimma-bg-dark.
  const bg = getComputedStyle(panel()).backgroundColor;
  document.documentElement.style.setProperty("--vimma-bg-dark", "rgb(1, 2, 3)");
  await until(() => getComputedStyle(panel()).backgroundColor === "rgb(1, 2, 3)", "themed");
  document.documentElement.style.removeProperty("--vimma-bg-dark");
  await until(() => getComputedStyle(panel()).backgroundColor === bg, "and back");

  toggleKey();
  await until(() => !isOpen(), "ctrl+b b closes it again");
  Assert.equal(document.activeElement, gBrowser.selectedBrowser, "focus returns to the page");
});

add_task(async function space_n_does_not_open_it_by_default() {
  // The leader has no default bindings; config.toml can add one.
  await focusPage();
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("n");
  // Then a key that does open it: had space n opened the panel, it would close it again.
  toggleKey();
  await until(isOpen, "ctrl+b b opens the side panel");
  Assert.equal(VimmaHost.status(window).mode, "panel", "space n left it closed");
  toggleKey();
  await until(() => !isOpen(), "ctrl+b b closes it");
});

add_task(async function j_k_and_enter_select_a_tab_and_close() {
  const main = [...ww().model.workspaces[0].tabs];
  await openPanel();
  const n = rows().length;
  EventUtils.synthesizeKey("j");
  Assert.equal(selected(), rows()[n - 1], "j stops at the last row");
  for (let i = 0; i <= n; i++) EventUtils.synthesizeKey("k");
  Assert.equal(selected(), rows()[0], "k moves up and stops at the first row");
  for (let i = 0; i < n - 2; i++) EventUtils.synthesizeKey("j");
  Assert.equal(text(selected(), "title"), "main-two", "j moves down");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter closes the panel");
  Assert.equal(gBrowser.selectedTab.label, "main-two", "and selects the highlighted tab");
  // A tab switch ends asynchronously (AsyncTabSwitcher), and focus may move again then.
  await until(() => document.activeElement === gBrowser.selectedBrowser, "focus is on its page");
  Assert.deepEqual(ww().model.workspaces[0].tabs, main, "no tab moved or closed");
});

add_task(async function a_digit_selects_that_row_and_a_missing_one_says_so() {
  await openPanel();
  EventUtils.synthesizeKey("9");
  await until(() => noticeText() === "no tab 9 in main", "a row that is not there is refused");
  Assert.ok(isOpen(), "and the panel stays open");
  EventUtils.synthesizeKey(String(rows().length));
  await until(() => !isOpen(), "a digit closes the panel");
  Assert.equal(gBrowser.selectedTab.label, "main-three", "and selects that row's tab");
  document.getElementById(NOTICE_ID)?.hidePopover();
});

add_task(async function esc_and_prefix_b_close_and_keys_never_reach_the_page() {
  const browser = gBrowser.selectedBrowser;
  const count = gBrowser.tabs.length;
  await recordPageKeys(browser);
  await openPanel();
  EventUtils.synthesizeKey("q"); // unbound in panel mode: the panel's, not the page's
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes the panel");
  await focusPage();
  prefix("b");
  await until(isOpen, "prefix+b opens it");
  prefix("b");
  await until(() => !isOpen(), "prefix+b closes it");
  await focusPage();
  EventUtils.synthesizeKey("z");
  await until(async () => (await pageKeys(browser)).includes("z"), "z reaches the page");
  Assert.deepEqual(await pageKeys(browser), ["z"], "the page saw none of the panel's keys");
  Assert.equal(gBrowser.tabs.length, count, "q closed no tab");
});

add_task(async function next_workspace_re_renders_the_panel_for_the_next_workspace() {
  await openPanel();
  prefix(")", { shiftKey: true });
  await until(() => active() === def("alpha").id, "ctrl+b ) switches to alpha");
  await until(() => text(header(), "name").includes("2:alpha"), "the header follows");
  Assert.ok(isOpen(), "the panel stays open");
  await until(() => titles().includes("alpha-one"), "and lists alpha's tabs");
  Assert.equal(rows().length, tabsIn("alpha").length, "only alpha's");
  Assert.stringContains(text(header(), "neighbours"), "main", "its neighbour is main");
  prefix("(", { shiftKey: true });
  await until(() => active() === def("main").id, "ctrl+b ( goes back");
  await until(() => titles().includes("main-two"), "and main's rows come back");
  await until(() => panel().contains(document.activeElement), "focus stays in the panel");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes it");
});

add_task(async function a_tab_opened_while_open_gets_a_row() {
  await openPanel();
  const n = rows().length;
  prefix("c");
  await until(() => rows().length === n + 1, "a new tab shows up as a row");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.ok(rows()[n].classList.contains("vimma-panel-active"), "the new tab is the active one");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

add_task(async function it_stays_leftmost_when_firefox_moves_its_sidebar_right() {
  await SpecialPowers.pushPrefEnv({ set: [["sidebar.position_start", false]] });
  await openPanel();
  Assert.equal(browserBoxOrder()[0], panel(), "still the leftmost box");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  await SpecialPowers.popPrefEnv();
});

// docs/specs/key-handling-batch.md § 4
add_task(async function x_closes_the_selected_tab_and_the_panel_stays_open_on_the_next_row() {
  const opened = [];
  for (const q of ["x-one", "x-two", "x-three", "x-four"]) opened.push(await openPage(q));
  // SessionStore caches a page's history on a 15 s timer. A tab closed before then is put on
  // the closed list only when its final state arrives from its content process, and those can
  // arrive out of order: ctrl+shift+t below would reopen x-three. Flushed, each close is listed
  // at once, in the order of the x presses.
  await Promise.all(opened.map((t) => TabStateFlusher.flush(t.linkedBrowser)));
  await openPanel();
  const at = (/** @type {string} */ t) => titles().indexOf(t);
  // From the active row (x-four, the last), up to x-two.
  EventUtils.synthesizeKey("k");
  EventUtils.synthesizeKey("k");
  await until(() => text(selected(), "title") === "x-two", "x-two is highlighted");
  const n = rows().length;
  EventUtils.synthesizeKey("x");
  await until(() => !opened[1].isConnected, "x closed x-two's tab");
  await until(() => rows().length === n - 1, "its row is gone");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.equal(at("x-two"), -1, "x-two is not listed");
  Assert.equal(text(selected(), "title"), "x-three", "the highlight is on the next row");
  Assert.ok(panel().contains(document.activeElement), "the panel keeps focus");

  EventUtils.synthesizeKey("x");
  await until(() => !opened[2].isConnected, "a second x closes x-three");
  await until(() => text(selected(), "title") === "x-four", "the highlight moves on to x-four");
  EventUtils.synthesizeKey("x");
  await until(() => !opened[3].isConnected, "a third x closes the last row's tab, x-four");
  await until(() => text(selected(), "title") === "x-one", "the highlight goes back a row");
  Assert.ok(isOpen(), "still open");

  // ctrl+shift+t: Firefox's reopen, which panel mode would otherwise consume.
  // SessionStore's event once the page is back: a busy runner takes seconds to get there.
  const restored = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "SSTabRestored");
  EventUtils.synthesizeKey("t", { ctrlKey: true, shiftKey: true });
  const { target: back } = await restored;
  Assert.stringContains(back.linkedBrowser.currentURI.spec, "x-four", "x-four reopens");
  // Its title was set by the test's script before; the reloaded page has its own.
  await until(
    () => rows().some((r) => r.dataset.tabId === back.linkedPanel),
    "and gets its row back",
  );
  Assert.ok(isOpen(), "the panel is still open");

  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  BrowserTestUtils.removeTab(back);
  BrowserTestUtils.removeTab(opened[0]);
});

// "Settled: moving a background tab from the side panel": m on a row opens the workspace
// picker; the workspace chosen there gets the row's tab, not the selected one.
const PICKER_ID = "vimma-workspace-picker";
const PROMPT_ID = "vimma-rename";
const picker = () => document.getElementById(PICKER_ID);
const pickerOpen = () => !!picker()?.open;
const pickerSelected = () =>
  picker().querySelector("[role=option][aria-selected=true] .vimma-picker-title")?.textContent;
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const promptText = () =>
  document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? "";

/** m on the row titled `title`: the panel closes and the workspace picker opens. */
async function moveFromPanel(title) {
  await openPanel();
  while (text(selected(), "title") !== title) {
    const before = text(selected(), "title");
    EventUtils.synthesizeKey("k");
    await until(() => text(selected(), "title") !== before, `up from ${before}`);
  }
  EventUtils.synthesizeKey("m");
  await until(pickerOpen, "m opens the workspace picker");
  Assert.ok(!isOpen(), "the side panel has closed");
  Assert.stringContains(picker().querySelector("h1").textContent, title, "naming the tab");
}

add_task(async function m_moves_the_highlighted_background_tab_to_the_workspace_picked() {
  const bg = await openPage("m-background");
  const front = await openPage("m-front");
  const main = active();

  // Esc in the picker moves nothing.
  await moveFromPanel("m-background");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !pickerOpen(), "Esc closes the picker");
  Assert.ok(bg.isConnected, "the tab stays");
  Assert.ok(tabsIn("main").includes(ww().idOf(bg)), "in main");

  // The tab's own workspace is refused without asking.
  await moveFromPanel("m-background");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => /already in "main"/.test(noticeText()), "already there");
  Assert.ok(!promptOpen(), "nothing to confirm");

  await moveFromPanel("m-background");
  while (pickerSelected() !== "alpha") EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(promptOpen, "Enter asks first");
  Assert.ok(/"alpha"/.test(promptText()), "naming the target");
  Assert.ok(/history/.test(promptText()), "warning that the history stays behind");
  EventUtils.synthesizeKey("y");
  await until(() => !bg.isConnected, "y moves it: the original closes");
  await until(
    () =>
      tabsIn("alpha").some(
        (id) => ww().tabOf(id)?.linkedBrowser.currentURI.spec === `${PAGE}?m-background`,
      ),
    "the page reopens in alpha",
  );
  Assert.equal(active(), main, "the window stays in main");
  Assert.equal(gBrowser.selectedTab, front, "the selected tab stays selected");
  await until(() => /moved to "alpha"/.test(noticeText()), "the notice says where");
  BrowserTestUtils.removeTab(front);
});

add_task(async function a_stale_answer_moves_nothing_from_the_side_panel() {
  const bg = await openPage("m-stale");
  await openPage("m-stale-front");
  await moveFromPanel("m-stale");
  while (pickerSelected() !== "alpha") EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(promptOpen, "Enter asks");
  // The tab goes before the answer: the y stood for it.
  BrowserTestUtils.removeTab(bg);
  EventUtils.synthesizeKey("y");
  await until(() => /nothing was moved/.test(noticeText()), "the answer is refused");
  Assert.ok(
    !tabsIn("alpha").some(
      (id) => ww().tabOf(id)?.linkedBrowser.currentURI.spec === `${PAGE}?m-stale`,
    ),
    "nothing reopened in alpha",
  );
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

add_task(async function x_never_closes_a_pinned_tab() {
  // Pinned tabs belong to no workspace (docs/guide.md, "Workspaces"), so the panel never lists them.
  const pinned = await openPage("x-pinned");
  // Decision 11 unpins it in a window with workspaces; this checks the guard other windows keep.
  WindowWorkspaces.get(window).unpinsPinnedTabs = false;
  gBrowser.pinTab(pinned);
  const other = await openPage("x-unpinned");
  await openPanel();
  Assert.ok(!titles().includes("x-pinned"), "the pinned tab has no row");
  await until(() => text(selected(), "title") === "x-unpinned", "the active row is highlighted");
  EventUtils.synthesizeKey("x");
  await until(() => !other.isConnected, "x closes the highlighted tab");
  Assert.ok(pinned.isConnected, "the pinned tab stays");

  // A row whose tab was pinned since the last render: refused with a notice, nothing closed.
  const sidePanel = VimmaHost._state(window).panel;
  sidePanel.state = {
    ...sidePanel.state,
    rows: sidePanel.state.rows.map((r) => ({ ...r, pinned: true })),
  };
  const n = gBrowser.tabs.length;
  EventUtils.synthesizeKey("x");
  await until(() => noticeText() === "pinned tab: unpin it to close it", "a notice says why");
  Assert.equal(gBrowser.tabs.length, n, "no tab closed");
  Assert.ok(isOpen(), "the panel stays open");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  gBrowser.unpinTab(pinned);
  WindowWorkspaces.get(window).unpinsPinnedTabs = true;
  BrowserTestUtils.removeTab(pinned);
});

add_task(async function sidebar_command_opens_it() {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("sidebar");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":sidebar opens the panel");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});
