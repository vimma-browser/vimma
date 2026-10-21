/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/toolbar-toggle.md decision 11a. Firefox's "Save password?" prompt answers the
// prompt keys as the permission prompts do: `y` saves and `n` is "Not now", once armed. A login
// form that keeps the page (a single-page app's) leaves focus in its password field: what is
// typed there stays the field's, the keys line says to press Esc first, and Esc leaves the field
// without closing the prompt. In the prompt's own username and password fields every key is the
// field's.

"use strict";

/* global focusContent -- from head.js */
/* global PopupNotifications -- browser window global (browser.js) */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const LOGIN = DIR + "file_vimma_login.html";
const DELAY = 400;
const VISIBLE = { visibilityProperty: true };

/** @param {() => boolean | Promise<boolean>} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const panel = () => PopupNotifications.panel;
const hintOf = (n) => n.querySelector(".vimma-prompt-keys");
const shows = (el) => !!el?.checkVisibility(VISIBLE);
const mode = () => VimmaHost.status(window).mode;
const usernames = async () => (await Services.logins.getAllLogins()).map((l) => l.username).sort();

/** The keys line of `n` once it is armed. */
async function armedHint(n) {
  await until(() => shows(hintOf(n)), "the keys line shows once the prompt is armed");
  return hintOf(n).textContent;
}

/**
 * Logs in on the fixture as `user`, typing as a user would, and resolves with the password prompt
 * once it shows. `stay`: the form posts into a frame and the page stays.
 */
async function logIn(user, { stay = false } = {}) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LOGIN + (stay ? "?stay" : ""));
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  await SpecialPowers.spawn(browser, [], () => content.document.getElementById("user").focus());
  await until(() => mode() === "insert", "insert mode in the username field");
  EventUtils.sendString(user);
  EventUtils.synthesizeKey("KEY_Tab");
  EventUtils.sendString("secret1");
  const shown = BrowserTestUtils.waitForEvent(panel(), "popupshown");
  EventUtils.synthesizeKey("KEY_Enter");
  await shown;
  const n = /** @type {any} */ (panel().firstElementChild);
  Assert.equal(n.id, "password-notification", "the save password prompt is up");
  return { tab, browser, n };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["security.notification_enable_delay", DELAY],
      ["signon.rememberSignons", true],
    ],
  });
  registerCleanupFunction(() => Services.logins.removeAllUserFacingLoginsAsync());
});

// The page navigates after the login: focus is on the new page, in normal mode.
add_task(async function y_saves_and_n_is_not_now() {
  let { tab, n } = await logIn("alice");
  await until(() => mode() === "normal", "the new page is in normal mode");
  Assert.equal(await armedHint(n), "y save · n not now · Tab buttons", "the keys line");
  let hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  EventUtils.synthesizeKey("y");
  await hidden;
  await until(async () => (await usernames()).includes("alice"), "y saves the login");
  gBrowser.removeTab(tab);

  ({ tab, n } = await logIn("bob"));
  await until(() => mode() === "normal", "normal mode");
  await armedHint(n);
  hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  EventUtils.synthesizeKey("n");
  await hidden;
  await wait(DELAY);
  Assert.deepEqual(await usernames(), ["alice"], "n saves nothing");
  gBrowser.removeTab(tab);
  await Services.logins.removeAllUserFacingLoginsAsync();
});

// The page stays: focus is still in its password field, in insert mode.
add_task(async function from_a_page_field_esc_comes_first() {
  const { tab, browser, n } = await logIn("carol", { stay: true });
  Assert.equal(mode(), "insert", "focus is still in the page's password field");
  Assert.equal(
    await armedHint(n),
    "Esc, then y save · n not now",
    "the keys line says to leave the field first",
  );
  EventUtils.synthesizeKey("y");
  EventUtils.synthesizeKey("n");
  await wait(DELAY);
  Assert.equal(panel().state, "open", "y and n typed in the page's field answer nothing");
  const value = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("pass").value,
  );
  Assert.equal(value, "secret1yn", "they went into the field");

  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => mode() === "normal", "Esc leaves the field");
  await wait(DELAY / 2);
  Assert.equal(panel().state, "open", "and leaves the prompt open");
  Assert.equal(await armedHint(n), "y save · n not now · Tab buttons", "the keys line");
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  EventUtils.synthesizeKey("y");
  await hidden;
  await until(async () => (await usernames()).includes("carol"), "y saves the login");
  gBrowser.removeTab(tab);
  await Services.logins.removeAllUserFacingLoginsAsync();
});

// The prompt's own fields: a username with a y or an n in it is typed, not an answer.
add_task(async function the_prompts_own_fields_take_their_keys() {
  const { tab, n } = await logIn("dave");
  await until(() => mode() === "normal", "normal mode");
  await armedHint(n);
  const username = /** @type {any} */ (document.getElementById("password-notification-username"));
  username.focus();
  await until(() => !!username.shadowRoot?.activeElement, "focus in the prompt's username");
  EventUtils.synthesizeKey("KEY_End");
  for (const key of ["y", "n", "y"]) EventUtils.synthesizeKey(key);
  await wait(DELAY * 2);
  Assert.equal(panel().state, "open", "y and n typed in the prompt's field answer nothing");
  Assert.equal(username.value, "daveyny", "they went into the field");

  // On the prompt's buttons, y answers again, and saves the username as edited.
  // Leaving the field closes its suggestions, which may resize the panel and restart Firefox's
  // delay a tick later; the line hides then, so wait that out before looking at it.
  n.button.focus();
  await wait(DELAY);
  await armedHint(n);
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  EventUtils.synthesizeKey("y");
  await hidden;
  await until(async () => (await usernames()).includes("daveyny"), "saved as edited");
  gBrowser.removeTab(tab);
  await Services.logins.removeAllUserFacingLoginsAsync();
});
