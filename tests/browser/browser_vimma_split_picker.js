/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md (Delivery 4, behind vimma.feature.multiple_splits). The
// split picker lists the workspace's splits with label, pane count and titles; a digit or Enter
// shows one. The step actions show the next or previous split, wrapping, and from a lone tab the
// split shown last. Without splits both say so. The actions have no default key yet, so the
// test runs them by name on the command line; with the pref off those commands do not exist.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PREF = "vimma.feature.multiple_splits";
const PAGE = "https://example.com/";
const PICKER_ID = "vimma-split-picker";
const NOTICE_ID = "vimma-notice";
const CMDLINE_ERROR = ".vimma-cmdline-error";

const view = () => PaneViews.get(window);
const picker = () => document.getElementById(PICKER_ID);
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const cells = (row) =>
  [".vimma-picker-index", ".vimma-picker-title", ".vimma-picker-host"].map(
    (c) => row.querySelector(c)?.textContent ?? "",
  );
const selectedRow = () => picker()?.querySelector("[role=option][aria-selected=true]");

function notice() {
  const n = document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** @type {Map<string, Element>} */
const byName = new Map();
const tab = (name) => /** @type {Element} */ (byName.get(name));
const shown = () => view().splits.shown;

/** A loaded page titled `name`. */
async function page(name) {
  const t = BrowserTestUtils.addTab(gBrowser, `${PAGE}?${name}`);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    content.document.title = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, t);
  return t;
}

/** Selects `t` and waits for its split to settle. */
async function pick(t) {
  gBrowser.selectedTab = t;
  await nextFrame();
}

/** `:line` on the command line, from the page. */
async function runCommand(line) {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** @type {Element[]} */
const opened = [];

registerCleanupFunction(async () => {
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape", {});
  for (const t of opened.splice(0)) if (!t.closing && t.parentNode) gBrowser.removeTab(t);
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function with_the_pref_off_the_commands_do_not_exist() {
  await WindowWorkspaces.get(window).ready;
  for (const n of ["a", "b", "c", "d", "e", "f"]) opened.push(await page(n));
  await pick(tab("f"));
  await runCommand("split_picker");
  await until(
    () => document.querySelector(CMDLINE_ERROR)?.textContent.includes("split_picker"),
    "the command line says the command is unknown",
  );
  Assert.ok(!isOpen(), "no picker");
  EventUtils.synthesizeKey("KEY_Escape", {});
});

add_task(async function without_splits_the_picker_and_steps_say_so() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await pick(tab("f"));
  await runCommand("split_picker");
  await until(() => notice() === "no splits in this workspace", "the picker's notice");
  Assert.ok(!isOpen(), "the picker does not open");
  await runCommand("next_split");
  await until(() => notice() === "no splits", "the step's notice");
});

add_task(async function the_picker_lists_the_splits_and_a_digit_shows_one() {
  Assert.ok(view().showTabs([tab("a"), tab("b")], tab("b")).ok, "S1: a | b, focus on b");
  await pick(tab("f"));
  Assert.ok(view().showTabs([tab("c"), tab("d"), tab("e")], tab("c")).ok, "S2: c | d | e");
  await until(() => shown() === 2, "S2 shows");

  await runCommand("split_picker");
  await until(isOpen, "the split picker opens");
  Assert.deepEqual(
    rows().map(cells),
    [
      ["S1", "a · b", "2 panes"],
      ["S2", "c · d · e", "3 panes · shown"],
    ],
    "one row per split: label, the panes' titles, the pane count",
  );
  Assert.equal(cells(selectedRow())[0], "S2", "the shown split is selected");
  Assert.equal(
    rows()[0].style.getPropertyValue("--vimma-picker-swatch"),
    "var(--vimma-split-1)",
    "S1's row carries its colour",
  );

  EventUtils.synthesizeKey("1", {});
  await until(() => !isOpen(), "the digit closes the picker");
  await until(() => shown() === 1, "and shows S1");
  Assert.equal(gBrowser.selectedTab, tab("b"), "with focus on its focused pane, b");
});

add_task(async function enter_shows_the_selected_split_and_slash_filters_by_title() {
  await runCommand("split_picker");
  await until(isOpen, "the split picker opens");
  EventUtils.synthesizeKey("/", {});
  EventUtils.sendString("d");
  await until(() => rows().length === 1, "typing filters the rows by the titles");
  Assert.equal(cells(rows()[0])[0], "S2", "S2 holds d");
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => !isOpen() && shown() === 2, "Enter shows S2");
  Assert.equal(gBrowser.selectedTab, tab("c"), "focus on its focused pane, c");
});

add_task(async function the_steps_wrap_and_go_back_from_a_lone_tab() {
  await runCommand("next_split");
  await until(() => shown() === 1, "next from S2 wraps to S1");
  await runCommand("next_split");
  await until(() => shown() === 2, "next from S1 is S2");
  await runCommand("previous_split");
  await until(() => shown() === 1, "previous from S2 is S1");

  await pick(tab("f"));
  Assert.equal(shown(), null, "f shows alone");
  await runCommand("previous_split");
  await until(() => shown() === 1, "from a lone tab, the split shown last comes back");
  Assert.equal(gBrowser.selectedTab, tab("b"), "with its focus");
});
