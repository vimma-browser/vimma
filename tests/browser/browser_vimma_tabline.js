/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-line.md. `[ui] tabline` draws a row at the top of the window, above the
// address bar, listing the current workspace's tabs as the side panel numbers them; `ctrl+b u`
// takes only the address bar away under it. `gb` labels every tab, a label key goes there and
// any other key cancels; `{N}gb` goes to tab N. `:tabline` toggles it in every window;
// `[statusbar] tab = false` drops the status bar's tab and title while it shows. A private window
// and the agent workspace list only their own tabs. It never takes focus.

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
requestLongerTimeout(4);

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { DEFAULT_HINT_CHARS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/hints.mjs",
);

const PREF = "vimma.ui.tabline";
const TOOLBAR_PREF = "vimma.ui.toolbar.hidden";
const PAGE = "https://example.com/";
const dir = PathUtils.join(PathUtils.tempDir, `vimma-tabline-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** @param {Window} [win] */
const line = (win = window) =>
  /** @type {HTMLElement} */ (win.document.getElementById("vimma-tabline"));
/** @param {Window} [win] */
const drawn = (win = window) => !!line(win) && !line(win).hidden && line(win).clientHeight > 0;
/** @param {Window} [win] */
const entries = (win = window) => [
  .../** @type {NodeListOf<HTMLElement>} */ (line(win).querySelectorAll(".vimma-tabline-tab")),
];
/** @param {Window} [win] */
const numbers = (win = window) => entries(win).map((e) => Number(e.dataset.number));
/** @param {Window} [win] */
const names = (win = window) =>
  entries(win).map((e) => e.querySelector(".vimma-tabline-name")?.textContent ?? "");
/** @param {Window} [win] */
const current = (win = window) => entries(win).find((e) => e.hasAttribute("current"));
/** @param {"before" | "after"} side */
const hidden = (side) =>
  Number(
    line()
      .querySelector(`.vimma-tabline-more[data-side="${side}"]`)
      ?.textContent?.replace(/[‹›]/g, "") ?? 0,
  );
const labels = () => [
  .../** @type {NodeListOf<HTMLElement>} */ (line().querySelectorAll(".vimma-tabline-label")),
];
/** @param {BrowserWindow} [win] */
const mode = (win = window) => VimmaHost.status(win).mode;
/** @param {string} id */
const segText = (id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? null;
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const liveText = () =>
  document.getElementById("vimma-statusbar")?.querySelector(".vimma-sb-live")?.textContent ?? "";
/**
 * The side panel's rows for this window: the line's source.
 * @param {BrowserWindow} [win]
 */
const panelRows = (win = window) => VimmaHost._state(win)?.panel.snapshot()?.rows ?? [];
/** @param {Element} el */
const rect = (el) => el.getBoundingClientRect();
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));

/**
 * Opens `${PAGE}?<title>` selected, titled `title`.
 * @param {string} title
 * @param {BrowserWindow} [win]
 */
async function openPage(title, win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE}?${title}`);
  await SpecialPowers.spawn(tab.linkedBrowser, [title], (t) => {
    content.document.title = t;
  });
  await until(() => tab.linkedBrowser.contentTitle === title, "the page has its title");
  return tab;
}

/**
 * Leaves only the first tab of the window.
 * @param {BrowserWindow} [win]
 */
function closeOthers(win = window) {
  while (win.gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (win.gBrowser.tabs.at(-1)));
  }
}

/** @param {BrowserWindow} [win] */
async function focusPage(win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
  await until(() => mode(win) === "normal", "normal mode");
}

/** @param {string} keys */
function type(keys) {
  for (const k of keys) EventUtils.synthesizeKey(k);
}

/** @param {string} text */
async function runCommand(text) {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(PREF);
  Services.prefs.clearUserPref(TOOLBAR_PREF);
  closeOthers();
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
});

add_task(async function off_draws_nothing() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "off"]] });
  await openPage("one");
  await openPage("two");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  Assert.ok(line(), "the row is built");
  Assert.ok(!drawn(), "off: not drawn");
  Assert.ok(!document.documentElement.hasAttribute("vimma-tabline"), "nor marked on the root");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function always_draws_the_workspace_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("mail");
  await openPage("vimma pulls");
  await until(drawn, "always: drawn");
  await until(() => entries().length === panelRows().length, "every tab of the workspace");
  Assert.deepEqual(
    numbers(),
    panelRows().map((r) => r.number),
    "numbered as the side panel numbers them",
  );
  // The title arrives after the tab: drawn on the frame after it (TabAttrModified).
  await until(() => names().slice(-2).join("|") === "mail|vimma pulls", "in tab order, by title");
  Assert.equal(current()?.dataset.number, String(panelRows().length), "the current tab marked");
  const cur = /** @type {HTMLElement} */ (current());
  Assert.notEqual(
    getComputedStyle(cur).backgroundColor,
    getComputedStyle(line()).backgroundColor,
    "drawn reversed",
  );
  Assert.equal(
    getComputedStyle(line()).backgroundColor,
    getComputedStyle(/** @type {Element} */ (document.getElementById("vimma-statusbar")))
      .backgroundColor,
    "in the status bar's colours",
  );
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function line_sits_above_the_address_bar() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("a");
  await until(drawn, "drawn");
  const navBar = /** @type {Element} */ (document.getElementById("nav-bar"));
  const browser = /** @type {Element} */ (document.getElementById("browser"));
  // The toolbar is hidden by default (toolbar-toggle decision 3): ctrl+b u shows it first.
  Services.prefs.setBoolPref(TOOLBAR_PREF, false);
  await until(() => navBar.checkVisibility({ visibilityProperty: true }), "ctrl+b u shows it");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const top = rect(line()).top;
  Assert.lessOrEqual(rect(line()).bottom, rect(navBar).top + 0.5, "above the address bar");
  Assert.lessOrEqual(rect(navBar).bottom, rect(browser).top + 0.5, "the page under both");

  Services.prefs.setBoolPref(TOOLBAR_PREF, true);
  await until(() => !navBar.checkVisibility({ visibilityProperty: true }), "ctrl+b u hides it");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  Assert.ok(drawn(), "the line stays");
  Assert.equal(rect(line()).top, top, "where it was");
  Assert.lessOrEqual(
    Math.abs(rect(browser).top - rect(line()).bottom),
    1,
    "the page starts right under it",
  );
  Services.prefs.setBoolPref(TOOLBAR_PREF, false);
  await until(() => navBar.checkVisibility({ visibilityProperty: true }), "shown again");
  Assert.equal(rect(line()).top, top, "and the line never moved");
  Services.prefs.clearUserPref(TOOLBAR_PREF);
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function auto_needs_two_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "auto"]] });
  closeOthers();
  await until(() => panelRows().length === 1, "one tab");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  Assert.ok(!drawn(), "auto with one tab: not drawn");
  const tab = await openPage("second");
  await until(drawn, "a second tab draws it");
  BrowserTestUtils.removeTab(tab);
  await until(() => !drawn(), "closing it hides it again");
  await SpecialPowers.popPrefEnv();
});

add_task(async function config_reload_applies() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["vimma.config.pollMs", 100],
    ],
  });
  let n = 0;
  const write = (/** @type {string} */ text) =>
    IOUtils.writeUTF8(configFile, `schema = 2\n${text}\n${"#".repeat(++n)}\n`);
  await openPage("a long title for the cut");
  await write(`[ui]\ntabline = "always"\ntabline_width = 6`);
  await until(() => ConfigHost.config?.ui.tabline === "always", "the poll reads the file");
  await until(drawn, "[ui] tabline draws it");
  await until(() => names().at(-1) === "a lon…", "cut to tabline_width");
  Assert.ok(segText("tab"), "the status bar keeps its tab by default");

  await write(`[ui]\ntabline = "always"\ntabline_width = 6\n[statusbar]\ntab = false`);
  await until(() => segText("tab") === null, "[statusbar] tab = false drops it");
  Assert.equal(segText("title"), null, "and the title");
  Assert.ok(segText("url"), "never the URL");

  await write(`[ui]\ntabline = "off"\n[statusbar]\ntab = false`);
  await until(() => !drawn(), "off hides it");
  await until(() => segText("tab") !== null, "with no line, the status bar has its tab again");

  await IOUtils.remove(configFile);
  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  await until(() => ConfigHost.config?.ui.tabline === "off", "no config: the defaults");
  closeOthers();
});

add_task(async function tabline_command_toggles() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("one");
  const other = await BrowserTestUtils.openNewBrowserWindow();
  await until(() => drawn() && drawn(other), "drawn in both windows");
  await SimpleTest.promiseFocus(window);
  await runCommand("tabline");
  await until(() => !drawn() && !drawn(other), ":tabline hides it in every window");
  await runCommand("tabline");
  await until(() => drawn() && drawn(other), "and shows it again");
  await BrowserTestUtils.closeWindow(other);
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function gb_labels_and_jumps() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  const first = gBrowser.selectedTab;
  await openPage("two");
  await openPage("three");
  await until(drawn, "drawn");
  await focusPage();
  type("gb");
  await until(() => labels().length === entries().length, "a label on every tab");
  Assert.deepEqual(
    labels().map((l) => l.dataset.label),
    [...DEFAULT_HINT_CHARS].slice(0, entries().length),
    "from the hint alphabet, in tab order",
  );
  Assert.equal(mode(), "hint", "HINT meanwhile");
  // Shift (or Caps Lock) types the same letter, as for link hints.
  EventUtils.synthesizeKey(DEFAULT_HINT_CHARS[0].toUpperCase(), { shiftKey: true });
  await until(() => gBrowser.selectedTab === first, "a label goes to its tab");
  await until(() => !labels().length, "the labels go");
  await until(() => liveText().includes("tab 1 of 3"), "a screen reader hears the new place");
  await until(() => mode() !== "hint", "and HINT ends");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function gb_cancels_on_another_key() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("two");
  const tabs = gBrowser.tabs.length;
  const selected = gBrowser.selectedTab;
  await until(drawn, "drawn");
  await focusPage();
  type("gb");
  await until(() => labels().length > 0, "labels");
  type("x");
  await until(() => !labels().length, "x cancels");
  Assert.equal(gBrowser.tabs.length, tabs, "and closes no tab");
  Assert.equal(gBrowser.selectedTab, selected, "nor switches");
  type("gb");
  await until(() => labels().length > 0, "labels again");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !labels().length, "Esc cancels");
  type("gb");
  await until(() => labels().length > 0, "labels again");
  EventUtils.synthesizeKey("KEY_Backspace");
  await until(() => !labels().length, "Backspace with nothing typed cancels");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function count_gb_jumps() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("two");
  await openPage("three");
  await openPage("four");
  await focusPage();
  type("2gb");
  await until(() => gBrowser.selectedTab === gBrowser.visibleTabs[1], "2gb goes to tab 2");
  Assert.equal(labels().length, 0, "with no labels");
  await focusPage();
  type("9gb");
  await until(
    () => noticeText() === "no tab 9: this workspace has 4 tabs",
    "past the last tab: a notice says how many there are",
  );
  Assert.equal(gBrowser.selectedTab, gBrowser.visibleTabs[1], "and nothing moves");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function gb_with_the_line_off() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "off"]] });
  await openPage("two");
  await focusPage();
  Assert.ok(!drawn(), "off");
  type("gb");
  await until(() => drawn() && labels().length === 2, "gb shows the line with its labels");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !drawn(), "and it goes with them");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

/**
 * Fills the workspace up to `n` tabs, fast (unloaded pages).
 * @param {number} n
 */
async function fillTo(n) {
  for (let i = gBrowser.visibleTabs.length + 1; i <= n; i++) {
    BrowserTestUtils.addTab(gBrowser, `about:blank?${i}`, { skipAnimation: true });
  }
  await until(() => panelRows().length === n, `${n} tabs`);
}

// Ten tabs and more: two- and three-digit numbers in the line and its overflow, {N}gb past 9,
// and gb labels of several letters reaching tabs scrolled out of view.
for (const n of [30, 120]) {
  add_task(async function overflow_keeps_the_current_tab() {
    await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
    await fillTo(n);
    gBrowser.selectedTab = /** @type {MozTabbrowserTab} */ (gBrowser.visibleTabs[14]);
    await until(() => current()?.dataset.number === "15", `${n}: the current tab is in view`);
    Assert.equal(hidden("before") + entries().length + hidden("after"), n, "the counts add up");
    Assert.greater(hidden("before"), 0, "tabs hidden before it");
    Assert.greater(hidden("after"), 0, "and after it");
    Assert.deepEqual(
      numbers(),
      numbers().map((_, i) => (numbers()[0] ?? 0) + i),
      "two-digit numbers drawn whole, in order",
    );
    gBrowser.selectedTab = /** @type {MozTabbrowserTab} */ (gBrowser.visibleTabs[n - 1]);
    await until(() => current()?.dataset.number === String(n), "the last tab in view");
    Assert.equal(hidden("after"), 0, "nothing after it");
    Assert.equal(hidden("before"), n - entries().length, "the rest before it");
    Assert.lessOrEqual(
      rect(/** @type {HTMLElement} */ (current())).right,
      rect(line()).right + 0.5,
      "the last entry is not cut off",
    );

    // {N}gb past 9.
    gBrowser.selectedTab = /** @type {MozTabbrowserTab} */ (gBrowser.visibleTabs[0]);
    await focusPage();
    type("12gb");
    await until(() => gBrowser.selectedTab === gBrowser.visibleTabs[11], "12gb goes to tab 12");

    // gb: a label for every tab, the hidden ones too, and a label reaches a hidden tab.
    await focusPage();
    type("gb");
    await until(() => labels().length > 0, "labels");
    const session = /** @type {{ labels: readonly { tabId: string, label: string }[] }} */ (
      VimmaHost._state(window)?.tabLabels
    );
    Assert.equal(session.labels.length, n, "a label for each of the tabs");
    Assert.equal(new Set(session.labels.map((l) => l.label)).size, n, "all different");
    const target = session.labels[n - 2];
    const { label, tabId } = /** @type {{ label: string, tabId: string }} */ (target);
    Assert.greater(label.length, 1, "several letters, as link hints have them");
    Assert.ok(
      !entries().some((e) => e.dataset.number === String(n - 1)),
      "tab n-1 starts out of view",
    );
    Assert.ok(
      entries().every((e) => e.querySelector(".vimma-tabline-number")),
      "each label keeps its tab's number",
    );
    type(label.slice(0, -1));
    await until(
      () => labels().some((l) => l.dataset.label === label),
      "typing its first letters scrolls it into view",
    );
    type(label.slice(-1));
    await until(
      () => gBrowser.selectedTab === gBrowser.visibleTabs[n - 2],
      "and its last letter goes there",
    );
    Assert.equal(panelRows()[n - 2]?.tabId, tabId, "the labelled tab");
    await until(() => !labels().length, "the labels go");
    await SpecialPowers.popPrefEnv();
    closeOthers();
  });
}

add_task(async function private_and_agent_workspaces_list_their_own() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("main two");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await openPage("secret", priv);
  await until(() => drawn(priv), "drawn in the private window");
  await until(() => entries(priv).length === priv.gBrowser.visibleTabs.length, "its own tabs");
  Assert.ok(!names(priv).includes("main two"), "none of the other window's");
  Assert.ok(!names().includes("secret"), "and the other window none of its");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);

  await ww().ready;
  const agent = WorkspaceStore.agent;
  Assert.ok(agent, "the agent workspace exists");
  const home = ww().model.active;
  ww().switchTo({ id: /** @type {{ id: string }} */ (agent).id });
  await until(() => ww().model.active === agent?.id, "in the agent workspace");
  const agentTab = await openPage("agent page");
  await until(() => names().includes("agent page"), "its tab is listed");
  Assert.ok(!names().includes("main two"), "the main workspace's is not");
  Assert.equal(entries().length, panelRows().length, "only its own tabs");
  // Back home with the agent's tab still open: the line lists none of the agent's tabs.
  ww().switchTo({ id: home });
  await until(() => ww().model.active === home, "back");
  Assert.ok(!agentTab.closing, "the agent's tab is still open");
  await until(() => names().includes("main two"), "the home workspace's tabs again");
  Assert.ok(!names().includes("agent page"), "and not the agent's");
  Assert.equal(entries().length, panelRows().length, "only home's tabs");
  for (const t of gBrowser.tabs.filter((x) => x.userContextId === agent?.userContextId)) {
    BrowserTestUtils.removeTab(t);
  }
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

// A title is page text: drawn as text, never as markup (docs/specs/tab-line.md, Security).
add_task(async function a_title_is_text_never_markup() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  const title = '<img src=x onerror="alert(1)"><b>x</b>';
  await openPage(title);
  await until(() => names().at(-1)?.startsWith("<img src=x"), "the title is listed");
  const name = /** @type {Element} */ (entries().at(-1)?.querySelector(".vimma-tabline-name"));
  Assert.equal(name.textContent, `${title.slice(0, 13)}…`, "the raw text, cut");
  Assert.equal(name.childElementCount, 0, "no element made from it");
  Assert.equal(line().querySelectorAll("img, b").length, 0, "nor anywhere in the line");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function split_marks_pane_tabs() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  const a = await openPage("left");
  const b = await openPage("right");
  await openPage("alone");
  const view = /** @type {PaneView} */ (PaneViews.get(window));
  Assert.ok(
    view.showTabs(/** @type {PaneTab[]} */ ([a, b]), /** @type {PaneTab} */ (a)).ok,
    "a and b shown together",
  );
  await until(
    () =>
      entries().filter((e) => e.querySelector(".vimma-tabline-glyph")?.textContent === "▪")
        .length === 2,
    "both pane tabs carry ▪",
  );
  const marked = entries()
    .filter((e) => e.textContent?.includes("▪"))
    .map((e) => e.querySelector(".vimma-tabline-name")?.textContent);
  Assert.deepEqual(marked, ["left", "right"], "the split's tabs, not the others");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});

add_task(async function never_takes_focus() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, "always"]] });
  await openPage("two");
  await until(drawn, "drawn");
  await focusPage();
  const browser = gBrowser.selectedBrowser;
  Assert.equal(document.activeElement, browser, "the page has focus");
  type("gb");
  await until(() => labels().length > 0, "labels");
  Assert.equal(document.activeElement, browser, "labelling keeps it there");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !labels().length, "cancelled");
  EventUtils.synthesizeMouseAtCenter(line(), {});
  // The click's own events have run once two frames have passed.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  Assert.equal(document.activeElement, browser, "a click on the line does not take it");
  Assert.equal(line().tabIndex, -1, "the line has no tab stop");
  Assert.equal(gBrowser.tabs.length, 2, "and the click did nothing");
  await SpecialPowers.popPrefEnv();
  closeOthers();
});
