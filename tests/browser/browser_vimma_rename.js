/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m2-picker-rename.md (tab rename)

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);

const PAGE = "https://example.org/";
const TITLE = "Plain page";
const LABEL_KEY = "vimma.tabLabel";
const PROMPT_ID = "vimma-rename";
const INPUT_ID = "vimma-rename-input";

registerCleanupFunction(() => {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/** @param {string} id */
const $ = (id) => document.getElementById(id);
/** The prompt's field (rename-prompt.mjs makes an <input>), which a test reads while the prompt is open. */
const input = () => /** @type {HTMLInputElement} */ ($(INPUT_ID));
const promptOpen = () => !!$(PROMPT_ID) && !(/** @type {HTMLElement} */ ($(PROMPT_ID)).hidden);
const titleSegment = () =>
  $("vimma-statusbar")?.querySelector('[data-segment="title"]')?.textContent ?? null;
const storedLabel = (tab = gBrowser.selectedTab) => SessionStore.getCustomTabValue(tab, LABEL_KEY);

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** A titled example.org tab, focused, in normal mode. */
async function openTitled(title = TITLE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [title], (t) => {
    content.document.title = t;
  });
  await until(() => browser.contentTitle === title, "the title is set");
  await focusContent(browser);
  await until(() => titleSegment() === title, "the status bar shows the title");
  return tab;
}

function renameKey() {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("T", { shiftKey: true });
}

/**
 * Replaces the prompt's text with `text` and presses Enter.
 * @param {string} text
 */
function submit(text) {
  input().select();
  EventUtils.synthesizeKey("KEY_Backspace");
  if (text) EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** @param {string} line */
function runCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function prefix_shift_t_prompts_and_enter_sets_the_label() {
  const tab = await openTitled();
  renameKey();
  Assert.ok(promptOpen(), "ctrl+b shift+t opens the rename prompt");
  Assert.ok(BrowserTestUtils.isVisible(input()), "its input is visible");
  Assert.equal(document.activeElement, input(), "with focus in it");
  Assert.equal(input().value, "", "empty: no label yet");
  Assert.equal(VimmaHost.status(window).mode, "insert", "a chrome text field: keys type");
  submit("Mail");
  Assert.ok(!promptOpen(), "Enter closes the prompt");
  Assert.equal(storedLabel(tab), "Mail", "the label is stored on the tab");
  await until(() => titleSegment() === "Mail", "the status bar shows the label");
  Assert.equal(document.activeElement, tab.linkedBrowser, "focus is back on the page");

  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("g");
  // picker.mjs makes a <dialog>. A missing picker, row or title throws below, as before.
  const picker = /** @type {HTMLDialogElement} */ ($("vimma-picker"));
  Assert.ok(picker?.open, "the picker opens");
  const row = /** @type {Element} */ (
    picker.querySelector(`[role=option][data-tab-id="${tab.linkedPanel}"]`)
  );
  const title = /** @type {Element} */ (row.querySelector(".vimma-picker-title"));
  Assert.equal(title.textContent, "Mail", "the picker shows it");
  EventUtils.synthesizeKey("KEY_Escape");

  renameKey();
  Assert.equal(input().value, "Mail", "the prompt starts with the current label");
  submit("");
  Assert.equal(storedLabel(tab), "", "an empty name clears the label");
  await until(() => titleSegment() === TITLE, "the title is back");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function esc_cancels_the_prompt() {
  const tab = await openTitled();
  renameKey();
  EventUtils.sendString("Nope");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!promptOpen(), "Esc closes the prompt");
  Assert.equal(storedLabel(tab), "", "and sets nothing");
  Assert.equal(document.activeElement, tab.linkedBrowser, "focus is back on the page");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function bidi_and_format_characters_are_stripped() {
  const tab = await openTitled();
  renameKey();
  input().value = "\u202eevil\u200b  name\u2066";
  EventUtils.synthesizeKey("KEY_Enter");
  Assert.equal(storedLabel(tab), "evil name", "format characters gone, spaces collapsed");
  await until(() => titleSegment() === "evil name", "the status bar shows the clean label");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tabrename_command_sets_it_and_alone_prompts() {
  const tab = await openTitled();
  runCommand("tabrename foo");
  await until(() => storedLabel(tab) === "foo", ":tabrename foo sets the label");
  await until(() => titleSegment() === "foo", "the status bar shows it");
  runCommand("tabrename");
  Assert.ok(promptOpen(), ":tabrename alone opens the prompt");
  Assert.equal(input().value, "foo", "with the current label");
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_label_survives_a_session_restore() {
  const tab = await openTitled();
  runCommand("tabrename Kept");
  await until(() => storedLabel(tab) === "Kept", "sanity: labelled");
  const state = SessionStore.getTabState(tab);
  Assert.equal(JSON.parse(state).extData?.[LABEL_KEY], "Kept", "SessionStore saves the label");
  BrowserTestUtils.removeTab(tab);

  const restored = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const restoring = BrowserTestUtils.waitForEvent(restored, "SSTabRestored");
  SessionStore.setTabState(restored, state);
  gBrowser.selectedTab = restored;
  await restoring;
  Assert.equal(storedLabel(restored), "Kept", "the restored tab has the label");
  await until(() => titleSegment() === "Kept", "and the status bar shows it");
  BrowserTestUtils.removeTab(restored);
});
