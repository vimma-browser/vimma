/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/cmdline-arrow-completion.md (#1222): Up / Down in the completion list.

"use strict";

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { completeCommandLine } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/cmdline.mjs",
);

const PAGE = "https://example.org/";

const input = () =>
  /** @type {HTMLInputElement} */ (document.getElementById("vimma-cmdline-input"));
const isOpen = () => {
  const el = document.getElementById("vimma-cmdline");
  return !!el && !el.hidden;
};
const options = () => [...document.querySelectorAll("#vimma-cmdline [role=option]")];
const selectedValue = () =>
  /** @type {HTMLElement | null} */ (
    document.querySelector("#vimma-cmdline [role=option][aria-selected=true]")
  )?.dataset.value ?? null;

/** @param {string} key */
const press = (key) => EventUtils.synthesizeKey(key);

/** A page in normal mode that records its keys. */
async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await recordPageKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  Assert.equal(VimmaHost.status(window).mode, "normal", "sanity: the page is in normal mode");
  return tab;
}

/** `:` then `line`, key by key. @param {string} line */
function typeCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  Assert.ok(isOpen(), "the command line is open");
  EventUtils.sendString(line);
}

/** z in the page: everything it saw, so a test can check that no line key reached it. */
async function pageKeysThenZ(/** @type {MozTabbrowserTab} */ tab) {
  await focusContent(tab.linkedBrowser);
  press("z");
  await waitForPageKey(tab.linkedBrowser, ["z", "!z"]);
  return pageKeys(tab.linkedBrowser);
}

add_task(async function down_enters_the_list_and_arrows_move_in_it() {
  const tab = await openPage();
  const expected = completeCommandLine("move_tab").candidates.map((c) => c.value);
  Assert.greater(expected.length, 2, "sanity: several candidates for move_tab");

  typeCommand("move_tab");
  Assert.equal(options().length, expected.length, "the list follows the typed text");
  Assert.equal(selectedValue(), null, "no row is selected yet");

  press("KEY_ArrowDown");
  Assert.equal(input().value, expected[0], "Down selects the first match, as Tab");
  Assert.equal(selectedValue(), expected[0], "the list marks it");
  Assert.equal(document.activeElement, input(), "focus stays in the line");
  press("KEY_ArrowDown");
  Assert.equal(input().value, expected[1], "Down again moves to the next match");
  press("KEY_ArrowUp");
  Assert.equal(input().value, expected[0], "Up moves back");
  press("KEY_ArrowUp");
  Assert.equal(input().value, "move_tab", "Up on the first row goes back to the typed text");
  Assert.equal(selectedValue(), null, "and leaves the list");
  Assert.equal(options().length, expected.length, "which still shows the matches");

  press("KEY_ArrowUp");
  press("KEY_ArrowDown");
  press("KEY_ArrowDown");
  Assert.equal(
    input().value,
    expected[1],
    "Up from the typed text finds no history; Down enters the list again",
  );

  for (let i = 2; i < expected.length; i++) press("KEY_ArrowDown");
  Assert.equal(input().value, expected[expected.length - 1], "Down reaches the last match");
  press("KEY_ArrowDown");
  Assert.equal(input().value, expected[0], "and wraps to the first, as Tab");

  press("KEY_Escape");
  Assert.ok(!isOpen(), "Esc closes the line");
  Assert.deepEqual(await pageKeysThenZ(tab), ["z"], "the page saw none of the line's keys");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function typing_after_down_refines_the_list() {
  const tab = await openPage();
  typeCommand("tab");
  press("KEY_ArrowDown");
  Assert.equal(selectedValue(), input().value, "Down entered the list");
  EventUtils.sendString("x");
  const refined = completeCommandLine(input().value).candidates.map((c) => c.value);
  Assert.deepEqual(
    options().map((o) => /** @type {HTMLElement} */ (o).dataset.value),
    refined,
    "typing ends the selection and the list follows the new text",
  );
  Assert.equal(selectedValue(), null, "with no row selected");
  press("KEY_Escape");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function history_keeps_up_and_down_on_an_empty_line_and_while_recalled() {
  const tab = await openPage();
  typeCommand("scroll_top");
  press("KEY_Enter");
  Assert.ok(!isOpen(), "sanity: it ran and closed");
  await focusContent(tab.linkedBrowser);

  typeCommand("");
  press("KEY_ArrowUp");
  Assert.equal(input().value, "scroll_top", "Up on an empty line recalls the last command");
  Assert.ok(options().length > 0, "sanity: the recalled line shows its matches");
  press("KEY_ArrowDown");
  Assert.equal(input().value, "", "Down walks history back to the empty line, not into the list");
  press("KEY_Escape");

  await focusContent(tab.linkedBrowser);
  typeCommand("scr");
  press("KEY_ArrowUp");
  Assert.equal(input().value, "scroll_top", "Up with typed text is still the prefix search");
  press("KEY_ArrowDown");
  Assert.equal(input().value, "scr", "and Down returns to the typed text");
  press("KEY_Escape");

  await focusContent(tab.linkedBrowser);
  typeCommand("qqqqqq");
  Assert.equal(options().length, 0, "sanity: no matches");
  press("KEY_ArrowDown");
  Assert.equal(input().value, "qqqqqq", "Down with no matches changes nothing");
  press("KEY_Escape");
  BrowserTestUtils.removeTab(tab);
});
