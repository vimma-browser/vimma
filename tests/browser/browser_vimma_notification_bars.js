/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/notification-bars.md (issue #1473). Firefox's notification bars over a page
// other than the pop-up blocked bar (a private window's "Site looks broken? Reload", a crashed
// plugin's, a blocked redirect's) take two keys, with the pop-up bar's guards: `Tab` moves focus
// onto the bar's buttons, where Firefox's own Tab, Enter and Space work, and `Esc` closes the bar.
// Both count only once the bar has been up for security.notification_enable_delay with no key
// pressed in between, never from a field. The bar names its keys in a line beside its buttons.

"use strict";

const PAGE = "https://example.com/";
const BLOCKING =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_popups.html";
const DELAY = 400;
const VALUE = "vimma-test-bar";
const LINE = "Tab buttons · Esc close";

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const box = () => gBrowser.getNotificationBox(gBrowser.selectedBrowser);
const bar = () => box().getNotificationWithValue(VALUE);
/** The keys line inside the bar, the permission prompt's (host/prompt-keys.mjs). */
const line = () => bar()?.querySelector(".vimma-prompt-keys") ?? null;
/** The line says `text` and shows: armed, and visible. @param {string} text */
const lineShows = (text) =>
  line()?.textContent === text &&
  found(line()).hasAttribute("armed") &&
  getComputedStyle(found(line())).visibility === "visible";
/** The bar's buttons: XUL `<button>`s up to Firefox 161, `<moz-button>`s from 162. */
const buttons = () => [
  .../** @type {NodeListOf<HTMLButtonElement>} */ (
    bar()?.querySelectorAll(".notification-button") ?? []
  ),
];

/**
 * Whether the bar was dismissed, as its close button does, with none of its buttons run. Firefox
 * then also sends "removed" and "disconnected", at once when it closes the bar without its slide
 * (prefers-reduced-motion, as on the macOS CI runners) and after the slide otherwise
 * (notificationbox.js, _showNotification), so the check leaves those two out.
 * @param {string[]} ran
 */
const dismissedOnly = (ran) => ran.filter((e) => e !== "removed" && e !== "disconnected");

/**
 * Shows a bar such as Firefox's "Site looks broken?" (ReducedProtectionNotification) over the
 * selected page, and records which of its buttons ran and whether it was dismissed.
 * @param {{ dismissable?: boolean }} [options]
 */
async function showBar({ dismissable = true } = {}) {
  /** @type {string[]} */
  const ran = [];
  await box().appendNotification(
    VALUE,
    {
      label: "Site looks broken? Reload the page.",
      priority: box().PRIORITY_INFO_LOW,
      eventCallback: (/** @type {string} */ event) => ran.push(event),
    },
    [
      { label: "Don’t show again", callback: () => void ran.push("never") },
      { label: "Reload", callback: () => void ran.push("reload") },
    ],
    false,
    dismissable,
  );
  return ran;
}

/** A foreground tab on the test page, focus in the page (normal mode). */
async function pageTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  gBrowser.selectedBrowser.focus();
  return tab;
}

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    // The test profile turns the delay off; the keys' wait is under test.
    set: [
      ["security.notification_enable_delay", DELAY],
      ["dom.disable_open_during_load", true],
      ["privacy.popups.showBrowserMessage", true],
    ],
  });
  registerCleanupFunction(() => {
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
  });
});

add_task(async function tab_moves_focus_onto_the_buttons_where_enter_runs_one() {
  const tab = await pageTab();
  const ran = await showBar();
  await until(() => lineShows(LINE), "the bar names its keys once they count");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[0], "Tab focuses the first button");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[1], "Firefox's Tab goes on to the next");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => ran.includes("reload"), "Enter runs the focused button");
  await until(() => !bar(), "which closes the bar, as a click does");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function enter_waits_while_firefox_restarts_the_bars_own_delay() {
  const tab = await pageTab();
  const ran = await showBar();
  await until(() => lineShows(LINE), "armed");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[0], "Tab focuses the first button");
  // Firefox disables the bar's buttons again when the window regains focus
  // (notificationbox.js, _startClickJackingDelay): Vimma's Enter must not press one then.
  window.dispatchEvent(new FocusEvent("focus"));
  Assert.ok(buttons()[0].disabled, "Firefox restarted the bar's delay");
  EventUtils.synthesizeKey("KEY_Enter");
  await wait(100);
  Assert.ok(bar(), "Enter left the bar up");
  Assert.deepEqual(ran, [], "and pressed no button");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function esc_on_a_focused_button_closes_the_bar() {
  const tab = await pageTab();
  const ran = await showBar();
  await until(() => lineShows(LINE), "armed");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[0], "Tab focuses the first button");
  await until(() => lineShows("Enter press · Esc close"), "the line names the keys there");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !bar(), "Esc closes the bar");
  Assert.deepEqual(dismissedOnly(ran), ["dismissed"], "running no button");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function esc_closes_the_bar_only_once_it_is_armed() {
  const tab = await pageTab();
  const ran = await showBar();
  EventUtils.synthesizeKey("KEY_Escape");
  await wait(100);
  Assert.ok(bar(), "an Esc before the bar is armed stays the page's");
  await until(() => lineShows(LINE), "armed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !bar(), "Esc closes the armed bar");
  Assert.deepEqual(
    dismissedOnly(ran),
    ["dismissed"],
    "as its close button does, running no button",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function keys_typed_in_a_field_are_the_fields() {
  const tab = await pageTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    for (const id of ["a", "b"]) {
      const input = content.document.createElement("input");
      input.id = id;
      content.document.body.append(input);
    }
    /** @type {HTMLInputElement} */ (content.document.getElementById("a")).focus();
  });
  await showBar();
  await until(() => lineShows("Esc, then Tab buttons"), "from a field the line starts with Esc");
  EventUtils.synthesizeKey("KEY_Tab");
  // The page's process can run the spawn's read before the Tab: it handles input events in a
  // queue of their own (input event prioritization), so the read waits for the key to land.
  /** @type {string | undefined} */
  let focused;
  await TestUtils.waitForCondition(
    async () => {
      focused = await SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.activeElement?.id,
      );
      return focused !== "a";
    },
    "the page took the Tab",
    50,
    100,
  );
  Assert.equal(focused, "b", "Tab moved through the page's fields");
  Assert.ok(!buttons().some((b) => b === document.activeElement), "not to the bar");
  EventUtils.synthesizeKey("KEY_Escape");
  await wait(DELAY + 100);
  Assert.ok(bar(), "and Esc left the field, not the bar");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_bar_without_a_close_button_takes_only_tab() {
  const tab = await pageTab();
  await showBar({ dismissable: false });
  await until(() => lineShows("Tab buttons"), "the line names only Tab");
  EventUtils.synthesizeKey("KEY_Escape");
  await wait(100);
  Assert.ok(bar(), "Esc leaves a bar that has no close button");
  // Every key restarts the wait, the Esc too.
  await wait(DELAY + 100);
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[0], "Tab still reaches its buttons");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_waits_while_firefox_restarts_the_bars_own_delay() {
  const tab = await pageTab();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const input = content.document.createElement("input");
    input.id = "first";
    content.document.body.prepend(input);
  });
  await showBar();
  await until(() => lineShows(LINE), "armed");
  // Firefox disables the bar's buttons again when the window regains focus
  // (notificationbox.js, _startClickJackingDelay); a disabled button takes no focus.
  window.dispatchEvent(new FocusEvent("focus"));
  Assert.ok(buttons()[0].disabled, "Firefox restarted the bar's delay");
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => gBrowser.selectedBrowser === document.activeElement, "focus stays in the page");
  const focused = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.activeElement?.id,
  );
  Assert.equal(focused, "first", "so the Tab is the page's, not lost");
  await until(() => !buttons()[0].disabled, "Firefox's delay ends");
  gBrowser.selectedBrowser.focus();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    /** @type {HTMLElement} */ (content.document.activeElement).blur();
  });
  await wait(DELAY + 100);
  EventUtils.synthesizeKey("KEY_Tab");
  await until(() => document.activeElement === buttons()[0], "then Tab reaches the buttons");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_popup_blocked_bar_keeps_its_keys_beside_another_bar() {
  const tab = BrowserTestUtils.addTab(gBrowser, BLOCKING);
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  const popup = () => box().getNotificationWithValue("popup-blocked");
  await until(() => !!popup(), "Firefox shows the pop-up blocked bar");
  gBrowser.selectedBrowser.focus();
  await showBar();
  await until(
    () => popup()?.querySelector(".vimma-prompt-keys")?.hasAttribute("armed") ?? false,
    "the pop-up bar's line arms",
  );
  Assert.ok(!line(), "the other bar gets no line");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !popup(), "Esc closes the pop-up blocked bar first");
  Assert.ok(bar(), "and leaves the other bar");
  BrowserTestUtils.removeTab(tab);
});
