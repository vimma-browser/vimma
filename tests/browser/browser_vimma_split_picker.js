/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/multiple-splits.md (Delivery 4 to 6). The split picker lists the workspace's
// splits with label, pane count and titles; a digit or Enter shows one. ]s and [s show the next
// or previous split, wrapping, and from a lone tab the split shown last. Without splits both say
// so. ctrl+b S opens the picker; the help overlay lists the three keys.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const PICKER_ID = "vimma-split-picker";
const NOTICE_ID = "vimma-notice";
const CMDLINE_ERROR = ".vimma-cmdline-error";
const HELP_ID = "vimma-help";

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

/** `keys` typed on the page in normal mode. */
async function normal(keys) {
  const browser = gBrowser.selectedBrowser;
  // A split just shown may still have its panels suspended; focusing an inactive browser never
  // settles on macOS (SpecialPowers' EnsureFocus waits on it until the test times out).
  await until(
    () => !browser.webProgress?.isLoadingDocument && browser.docShellIsActive,
    "the selected page has loaded and is shown",
  );
  await nextFrame();
  await focusContent(browser);
  EventUtils.sendString(keys);
}

add_task(async function without_splits_the_picker_and_steps_say_so() {
  await WindowWorkspaces.get(window).ready;
  for (const n of ["a", "b", "c", "d", "e", "f"]) opened.push(await page(n));
  await pick(tab("f"));
  await runCommand("split_picker");
  await until(() => notice() === "no splits in this workspace", "the picker's notice");
  Assert.ok(!isOpen(), "the picker does not open");
  Assert.ok(
    !document.querySelector(CMDLINE_ERROR)?.textContent.includes("split_picker"),
    "the command exists",
  );
  await normal("]s");
  await until(() => notice() === "no splits", "]s says so");
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
  await normal("]s");
  await until(() => shown() === 1, "]s from S2 wraps to S1");
  await normal("]s");
  await until(() => shown() === 2, "]s from S1 is S2");
  await normal("[s");
  await until(() => shown() === 1, "[s from S2 is S1");
  await runCommand("next_split");
  await until(() => shown() === 2, ":next_split runs the same step");

  await pick(tab("f"));
  Assert.equal(shown(), null, "f shows alone");
  await normal("[s");
  await until(() => shown() === 2, "from a lone tab, the split shown last comes back");
  Assert.equal(gBrowser.selectedTab, tab("c"), "with its focus");
});

/** ctrl+b S from the page. */
async function prefixShiftS() {
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("S", { shiftKey: true });
}

add_task(async function ctrl_b_shift_s_opens_the_picker() {
  await prefixShiftS();
  await until(isOpen, "ctrl+b S opens the split picker");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "Esc closes it");
});

add_task(async function the_help_overlay_lists_the_split_keys() {
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("?", { shiftKey: true });
  const help = () => document.getElementById(HELP_ID);
  await until(() => !!help()?.open, "ctrl+b ? opens the help overlay");
  for (const name of ["split_picker", "next_split", "previous_split"]) {
    const row = help().querySelector(`[data-action="${name}"]`);
    Assert.ok(row && BrowserTestUtils.isVisible(row), `the overlay lists ${name}`);
  }
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !help()?.open, "Esc closes it");
});
