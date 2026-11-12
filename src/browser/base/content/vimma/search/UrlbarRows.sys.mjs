/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How the address bar shares its rows between the user's pages and the search suggestions
// (docs/specs/search-engines.md, decision 10, since changed; issue #822).

/**
 * With the pages first (`browser.urlbar.showSearchSuggestionsFirst` false, Vimma's default), they
 * get 4 of the 9 rows under the heuristic and the search suggestions 5, so the suggestions stay a
 * few keys away. These are flex values: either side still fills the rows the other leaves empty.
 * Firefox's are 2:1.
 */
const PAGES_FLEX = 4;
const SUGGESTIONS_FLEX = 5;
const FIREFOX_PAGES_FLEX = 2;
const FIREFOX_SUGGESTIONS_FLEX = 1;

/** The `group` of the pages' half of the main group (UrlbarShared.RESULT_GROUP.GENERAL_PARENT). */
const GENERAL_PARENT = "generalParent";

let started = false;

/**
 * @typedef {object} ResultGroup
 * @property {string} [group]
 * @property {number} [flex]
 * @property {boolean} [flexChildren]
 * @property {ResultGroup[]} [children]
 */

/**
 * Gives the pages 4 and the suggestions 5 when the address bar's groups put the pages first with
 * Firefox's 2:1. Any other layout is left alone: suggestions first, the search bar's, and
 * Firefox 161's zero-prefix layout for temporal suggestions (7:6). The groups are built in code
 * (UrlbarPrefs.sys.mjs, makeDefaultResultGroups) and no pref sets a group's share. Idempotent:
 * Firefox caches the groups it returns, so the same object can come back here.
 * @param {ResultGroup} rootGroup
 * @returns {ResultGroup}
 */
export function pagesFirstFlex(rootGroup) {
  const main = rootGroup?.children?.at(-1);
  const [pages, suggestions, ...more] = main?.children ?? [];
  if (
    main?.flexChildren &&
    pages &&
    suggestions &&
    !more.length &&
    pages.group === GENERAL_PARENT &&
    pages.flex === FIREFOX_PAGES_FLEX &&
    suggestions.flex === FIREFOX_SUGGESTIONS_FLEX
  ) {
    pages.flex = PAGES_FLEX;
    suggestions.flex = SUGGESTIONS_FLEX;
  }
  return rootGroup;
}

export const UrlbarRows = {
  /**
   * Wraps `UrlbarPrefs.getResultGroups` for the address bar (sap "urlbar") instead of patching
   * makeDefaultResultGroups: its body changes between Firefox releases (161 added a branch around
   * the flex lines), and a wrapper works on each. Once per process.
   */
  init() {
    if (started) {
      return;
    }
    started = true;
    const { UrlbarPrefs } = ChromeUtils.importESModule(
      "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
    );
    const firefoxGetResultGroups = UrlbarPrefs.getResultGroups;
    /** @param {{ context: { sapName: string } }} options the one argument on 160 and 161 */
    UrlbarPrefs.getResultGroups = function (options) {
      const rootGroup = firefoxGetResultGroups.call(this, options);
      return options?.context?.sapName === "urlbar" ? pagesFirstFlex(rootGroup) : rootGroup;
    };
  },
};
