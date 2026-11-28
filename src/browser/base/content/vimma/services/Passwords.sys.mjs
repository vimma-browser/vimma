/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `[passwords]` in config.toml (docs/specs/password-storage.md): Firefox's own password saving
// and fill on page load, one pref each. Set on the default branch (decision 2), as
// `[tabs] sleep_on_low_memory` is (TabSleep.sys.mjs): nothing is written to prefs.js, removing
// the key brings back Firefox's default, and a value set in Settings or about:config is a user
// value that wins. LoginHelper observes the whole `signon.` branch (LoginHelper.sys.mjs,
// `observe`), so the next form follows without a restart (decision 3).

/** Saving, filling and listing saved logins (LoginHelper.enabled). */
export const SAVE_PREF = "signon.rememberSignons";
/** Filling a saved login as its form appears (LoginHelper.autofillForms). */
export const FILL_PREF = "signon.autofillForms";

/** @param {string} name @param {boolean} value */
function setDefault(name, value) {
  const defaults = Services.prefs.getDefaultBranch("");
  if (defaults.getBoolPref(name, !value) !== value) defaults.setBoolPref(name, value);
}

export const Passwords = {
  /**
   * Applies the resolved `[passwords]`, at startup and after each read of config.toml
   * (ConfigHost's apply).
   * @param {{ save: boolean, fillOnLoad: boolean }} passwords
   */
  configure({ save, fillOnLoad }) {
    setDefault(SAVE_PREF, save);
    setDefault(FILL_PREF, fillOnLoad);
  },
};
