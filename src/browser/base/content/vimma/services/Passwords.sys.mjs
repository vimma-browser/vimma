/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `[passwords]` in config.toml (docs/specs/password-storage.md): Firefox's own password saving
// and fill on page load, one pref each. Set on the default branch (decision 2), as
// `[tabs] sleep_on_low_memory` is (TabSleep.sys.mjs): nothing is written to the signon prefs'
// user values, removing the key brings back Firefox's default, and a value set in Settings or
// about:config is a user value that wins. LoginHelper adds an observer for the whole `signon.`
// branch in its init (LoginHelper.sys.mjs:434), so the next form follows without a restart
// (decision 3).
//
// The default branch is not saved between starts and config.toml is read asynchronously, so a
// restored tab could show a login form under Firefox's defaults before the file applies. The
// values in force are therefore remembered in Vimma's own prefs and set again as the first window
// opens, before it loads a page; the same values stay when a file with errors leaves only the built-in defaults to stand
// in for it, as a broken file keeps the last good config (docs/security/08-config-toml.md F2).

/** Saving, filling and listing saved logins (LoginHelper.enabled). */
export const SAVE_PREF = "signon.rememberSignons";
/** Filling a saved login as its form appears (LoginHelper.autofillForms). */
export const FILL_PREF = "signon.autofillForms";
/** The last `save` applied, for the next start. */
export const LAST_SAVE_PREF = "vimma.passwords.lastSave";
/** The last `fill_on_load` applied, for the next start. */
export const LAST_FILL_PREF = "vimma.passwords.lastFillOnLoad";

let started = false;

/** @param {string} name @param {boolean} value */
function setDefault(name, value) {
  const defaults = Services.prefs.getDefaultBranch("");
  if (defaults.getBoolPref(name, !value) !== value) defaults.setBoolPref(name, value);
}

/** @param {boolean} save @param {boolean} fillOnLoad */
function set(save, fillOnLoad) {
  setDefault(SAVE_PREF, save);
  setDefault(FILL_PREF, fillOnLoad);
}

export const Passwords = {
  /**
   * Once per process, from the first window's first script (vimma.js), before it loads a page;
   * later calls change nothing. Firefox's defaults (true) on a profile that never applied
   * `[passwords]`.
   * @param {{ again?: boolean }} [options]  `again`: run once more (tests, for a new start)
   */
  init({ again = false } = {}) {
    if (started && !again) return;
    started = true;
    set(
      Services.prefs.getBoolPref(LAST_SAVE_PREF, true),
      Services.prefs.getBoolPref(LAST_FILL_PREF, true),
    );
  },

  /**
   * Applies the resolved `[passwords]`, at startup and after each read of config.toml
   * (ConfigHost's apply), and remembers it for the next start.
   * @param {{ save: boolean, fillOnLoad: boolean } | null} passwords  null when the built-in
   *   defaults stand in for a file with errors or one that cannot be read: the values in force
   *   stay
   */
  configure(passwords) {
    if (!passwords) return;
    const { save, fillOnLoad } = passwords;
    set(save, fillOnLoad);
    Services.prefs.setBoolPref(LAST_SAVE_PREF, save);
    Services.prefs.setBoolPref(LAST_FILL_PREF, fillOnLoad);
  },
};
