/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's Bookmarks Toolbar (spec: docs/specs/bookmarks-toolbar-hidden.md). Its state is
// Firefox's own pref, `browser.toolbars.bookmarks.visibility`, hidden ("never") by default in
// firefox-branding.js. This module applies `[ui] bookmarks_toolbar` and `:bookmarkstoolbar`
// words to every window, hides it once in a profile upgraded from before that default, and knows
// what config.toml sets, for the notices. Every change goes through
// CustomizableUI.setToolbarVisibility: open windows read the pref only on a location change.

import { MIGRATION_NOTICE, needsMigration, visibilityFor } from "../core/bookmarks-toolbar.mjs";

/** @import { BookmarksToolbarSetting } from "../core/bookmarks-toolbar.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

export const VISIBILITY_PREF = "browser.toolbars.bookmarks.visibility";
/** Decision 7: set once the upgrade check has run, so a later choice stands. */
export const MIGRATED_PREF = "vimma.ui.bookmarksToolbar.migrated";
const TOOLBAR_ID = "PersonalToolbar";

/** @type {BookmarksToolbarSetting | null} `[ui] bookmarks_toolbar` in force; null when unset */
let configured = null;
/** @type {BookmarksToolbarSetting | null | undefined} the value last applied; undefined: none */
let applied;

export const BookmarksToolbar = {
  /** The pref's value: "always", "never" or "newtab". */
  get visibility() {
    return Services.prefs.getStringPref(VISIBILITY_PREF, "never");
  },

  /** What config.toml sets, for the notice's "until restart"; null when it sets nothing. */
  get configured() {
    return configured;
  },

  /**
   * Shows or hides it in every window, and keeps that for later windows and restarts.
   * @param {BookmarksToolbarSetting} setting
   */
  set(setting) {
    const value = visibilityFor(setting);
    // The pref first: with no window open, setToolbarVisibility persists nothing.
    Services.prefs.setStringPref(VISIBILITY_PREF, value);
    lazy.CustomizableUI.setToolbarVisibility(TOOLBAR_ID, value);
  },

  /**
   * Each config ConfigHost applies (decision 4): the first one runs the upgrade check; the key
   * is applied when it changed from the last config's, so a `:bookmarkstoolbar` lasts until a
   * restart or an edit of that line. Left out, the pref stays as it is.
   * @param {BookmarksToolbarSetting | null} setting
   * @param {(text: string) => void} say  the polite notice
   */
  configure(setting, say) {
    if (applied === undefined) this.migrate(setting, say);
    configured = setting;
    if (setting === applied) return;
    applied = setting;
    if (setting) this.set(setting);
  },

  /**
   * Decision 7: a profile that showed the toolbar before it was hidden by default has it
   * hidden once, with a notice; the pref records that this ran.
   * @param {BookmarksToolbarSetting | null} setting  `[ui] bookmarks_toolbar`
   * @param {(text: string) => void} say
   */
  migrate(setting, say) {
    const migrated = Services.prefs.getBoolPref(MIGRATED_PREF, false);
    const userValue = Services.prefs.prefHasUserValue(VISIBILITY_PREF)
      ? Services.prefs.getStringPref(VISIBILITY_PREF)
      : null;
    if (!migrated) Services.prefs.setBoolPref(MIGRATED_PREF, true);
    if (!needsMigration({ migrated, configured: setting, userValue })) return;
    this.set("hidden");
    say(MIGRATION_NOTICE);
  },
};
