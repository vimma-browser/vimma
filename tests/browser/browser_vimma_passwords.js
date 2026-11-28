/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/password-storage.md, behaviours 1 to 4 and decisions 2 and 3. `[passwords]
// save` and `fill_on_load` set Firefox's `signon.rememberSignons` and `signon.autofillForms` on
// the default branch, at each read of config.toml, so that nothing reaches prefs.js and a value
// set in Settings or about:config wins. Filling is Firefox's own (LoginManagerChild.sys.mjs):
// the test watches its "FormProcessed" notice and the form's fields.

"use strict";

/* global focusContent -- from head.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { LoginManagerParent } = ChromeUtils.importESModule(
  "resource://gre/modules/LoginManagerParent.sys.mjs",
);

const SAVE = "signon.rememberSignons";
const FILL = "signon.autofillForms";
const ORIGIN = "https://example.com";
const LOGIN = `${getRootDirectory(gTestPath).replace("chrome://mochitests/content", ORIGIN)}file_vimma_login.html`;
const dir = PathUtils.join(PathUtils.tempDir, `vimma-passwords-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");

/** Writes config.toml and waits until it is in force. @param {string} text */
async function config(text) {
  await IOUtils.writeUTF8(configFile, text);
  await ConfigHost.reload();
}

/** Resolves with the next form Firefox's password manager processed. */
function formProcessed() {
  return new Promise((resolve) => {
    LoginManagerParent.setListenerForTests((/** @type {string} */ msg) => {
      if (msg !== "FormProcessed") return;
      LoginManagerParent.setListenerForTests(null);
      resolve(undefined);
    });
  });
}

/** @param {MozBrowser} browser @returns {Promise<[string, string]>} the form's two fields */
function fields(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    return [
      /** @type {HTMLInputElement} */ (doc.getElementById("user")).value,
      /** @type {HTMLInputElement} */ (doc.getElementById("pass")).value,
    ];
  });
}

/** Opens the login fixture and waits until Firefox has processed its form. */
async function openLogin() {
  const processed = formProcessed();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, LOGIN);
  await processed;
  return tab;
}

add_setup(async function () {
  await IOUtils.makeDirectory(dir);
  await SpecialPowers.pushPrefEnv({
    set: [["vimma.config.path", configFile]],
    // The test profile turns saving off as a user value (testing/profiles/unittest-required/
    // user.js); a user's profile has neither.
    clear: [[SAVE], [FILL]],
  });
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  login.init(ORIGIN, ORIGIN, null, "ada", "secret1", "user", "pass");
  await Services.logins.addLoginAsync(login);
  registerCleanupFunction(async () => {
    LoginManagerParent.setListenerForTests(null);
    await Services.logins.removeAllUserFacingLoginsAsync();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
  await config("");
});

add_task(async function save_false_sets_remember_signons_on_the_default_branch() {
  Assert.equal(Services.prefs.getBoolPref(SAVE), true, "saving is on without the key");
  await config("[passwords]\nsave = false\n");
  Assert.equal(Services.prefs.getBoolPref(SAVE), false, "save = false turns saving off");
  Assert.equal(
    Services.prefs.getDefaultBranch("").getBoolPref(SAVE),
    false,
    "on the default branch",
  );
  Assert.ok(!Services.prefs.prefHasUserValue(SAVE), "nothing is written to prefs.js");
  Assert.equal(Services.prefs.getBoolPref(FILL), true, "fill_on_load is independent of save");
});

add_task(async function removing_the_key_restores_firefoxs_default() {
  await config("[passwords]\nsave = false\nfill_on_load = false\n");
  Assert.equal(Services.prefs.getBoolPref(SAVE), false, "saving is off");
  Assert.equal(Services.prefs.getBoolPref(FILL), false, "filling on load is off");
  await config("");
  Assert.equal(Services.prefs.getBoolPref(SAVE), true, "saving is back on");
  Assert.equal(Services.prefs.getBoolPref(FILL), true, "filling on load is back on");
  Assert.ok(!Services.prefs.prefHasUserValue(SAVE), "no user value for saving");
  Assert.ok(!Services.prefs.prefHasUserValue(FILL), "no user value for filling");
});

add_task(async function a_value_set_in_settings_wins_over_config_toml() {
  await config("[passwords]\nsave = false\n");
  // What ticking the box in Settings → Privacy & Security → Passwords writes.
  Services.prefs.setBoolPref(SAVE, true);
  await config("[passwords]\nsave = false\nfill_on_load = true\n");
  Assert.equal(Services.prefs.getBoolPref(SAVE), true, "the user value stays in force");
  Services.prefs.clearUserPref(SAVE);
  Assert.equal(Services.prefs.getBoolPref(SAVE), false, "config.toml's value is under it");
  await config("");
});

add_task(async function fill_on_load_true_fills_a_saved_login_as_the_page_loads() {
  await config("[passwords]\nfill_on_load = true\n");
  const tab = await openLogin();
  Assert.deepEqual(await fields(tab.linkedBrowser), ["ada", "secret1"], "filled as it loads");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function fill_on_load_false_leaves_a_saved_login_unfilled_until_it_is_picked() {
  await config("[passwords]\nfill_on_load = false\n");
  const tab = await openLogin();
  const browser = tab.linkedBrowser;
  Assert.deepEqual(await fields(browser), ["", ""], "nothing is filled as the page loads");

  const popup = /** @type {Element} */ (document.getElementById("PopupAutoComplete"));
  const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
  await focusContent(browser);
  await SpecialPowers.spawn(browser, [], () =>
    /** @type {HTMLElement} */ (content.document.getElementById("user")).focus(),
  );
  await shown;
  Assert.deepEqual(await fields(browser), ["", ""], "the list opens, and still nothing is filled");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    async () => (await fields(browser))[1] === "secret1",
    "the picked login fills",
  );
  Assert.deepEqual(await fields(browser), ["ada", "secret1"], "the login the user picked");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_config_change_applies_without_a_restart() {
  await config("[passwords]\nfill_on_load = false\n");
  let tab = await openLogin();
  Assert.deepEqual(await fields(tab.linkedBrowser), ["", ""], "not filled while off");
  BrowserTestUtils.removeTab(tab);
  // The poll and :source both end in ConfigHost.reload's read.
  await config("[passwords]\nfill_on_load = true\n");
  tab = await openLogin();
  Assert.deepEqual(await fields(tab.linkedBrowser), ["ada", "secret1"], "filled once on again");
  BrowserTestUtils.removeTab(tab);
  await config("");
});
