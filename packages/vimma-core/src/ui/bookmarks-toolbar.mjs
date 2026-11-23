/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's Bookmarks Toolbar (spec: docs/specs/bookmarks-toolbar-hidden.md): Vimma's words for
// its three states, the notices, when the one-time migration hides it, and when to say once
// that the hidden toolbar hides it too.

/** @typedef {"shown" | "hidden" | "newtab"} BookmarksToolbarSetting */
/** @typedef {"always" | "never" | "newtab"} BookmarksToolbarVisibility */

/** `[ui] bookmarks_toolbar`, in the order Tab and the errors list them. */
export const BOOKMARKS_TOOLBAR_SETTINGS = Object.freeze(
  /** @type {BookmarksToolbarSetting[]} */ (["shown", "hidden", "newtab"]),
);

/** Firefox's own value of `browser.toolbars.bookmarks.visibility` for each word. */
const VISIBILITY = Object.freeze({ shown: "always", hidden: "never", newtab: "newtab" });

/**
 * @param {BookmarksToolbarSetting} setting
 * @returns {BookmarksToolbarVisibility}
 */
export function visibilityFor(setting) {
  return /** @type {BookmarksToolbarVisibility} */ (VISIBILITY[setting]);
}

/**
 * @param {string} visibility  the pref's value
 * @returns {BookmarksToolbarSetting | null}  null for a value Firefox does not define
 */
export function settingFor(visibility) {
  const found = Object.entries(VISIBILITY).find(([, v]) => v === visibility);
  return found ? /** @type {BookmarksToolbarSetting} */ (found[0]) : null;
}

/** Decision 7: said once, when an upgraded profile's toolbar is hidden. */
export const MIGRATION_NOTICE =
  "bookmarks toolbar hidden: ctrl+b shift+b opens your bookmarks; " +
  ":bookmarkstoolbar show brings it back";

const NOTICES = Object.freeze({
  always: "bookmarks toolbar shown",
  never: "bookmarks toolbar hidden",
  newtab: "bookmarks toolbar shown on new tabs",
});

/**
 * Behaviour 6: what a change made through Vimma says. While config.toml sets the key, the next
 * start applies it again (decision 4), so the notice says the change lasts until then. While
 * Firefox's toolbar is hidden (its default, toolbar-toggle decision 3), the bookmarks toolbar
 * hides with it (decision 8), so a notice that shows it says how to show the toolbar too.
 * @param {string} visibility  the pref's value after the change
 * @param {BookmarksToolbarSetting | null} configured  `[ui] bookmarks_toolbar`, null when unset
 * @param {{ toolbarHidden?: boolean }} [options]  Firefox's toolbar is hidden
 */
export function bookmarksToolbarNotice(visibility, configured, { toolbarHidden = false } = {}) {
  const key = /** @type {BookmarksToolbarVisibility} */ (
    visibility in NOTICES ? visibility : "always"
  );
  const text = NOTICES[key];
  const said = configured ? `${text} (config.toml sets "${configured}"; until restart)` : text;
  return toolbarHidden && key !== "never" ? `${said}; the toolbar is hidden: :toolbar show` : said;
}

/**
 * Decision 7: an upgraded profile that shows the toolbar has it hidden once. A profile without
 * a user value already has the hidden default; with the config key set, the key decides.
 * @param {{ migrated: boolean, configured: BookmarksToolbarSetting | null,
 *   userValue: string | null }} state  `userValue`: the pref's user value, null without one
 */
export function needsMigration({ migrated, configured, userValue }) {
  return !migrated && configured === null && userValue !== null && userValue !== "never";
}

/** Decision 8, changed for issue #1399: said once, when the hidden toolbar hides what config.toml
 * shows. */
export const TOOLBAR_NOTICE =
  "bookmarks toolbar hidden with the toolbar: :toolbar show shows both; " +
  '[ui] toolbar = "shown" in config.toml keeps them';

/**
 * Decision 8, changed for issue #1399: config.toml shows the bookmarks toolbar but leaves
 * `[ui] toolbar` out, so the hidden default (toolbar-toggle decision 3) hides it too. Said once:
 * a `[ui] toolbar` line, either value, is a choice made knowing both.
 * @param {{ noticed: boolean, configured: BookmarksToolbarSetting | null,
 *   toolbarSet: boolean }} state  `configured`: `[ui] bookmarks_toolbar`, null when unset
 */
export function needsToolbarNotice({ noticed, configured, toolbarSet }) {
  return !noticed && !toolbarSet && (configured === "shown" || configured === "newtab");
}
