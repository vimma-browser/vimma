/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/search-engines.md, decision 10 (since changed, issue #822)

"use strict";

const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs",
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs",
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs",
);
const { UrlbarShared } = ChromeUtils.importESModule(
  "chrome://browser/content/urlbar/UrlbarShared.mjs",
);
SearchTestUtils.init(this);
UrlbarTestUtils.init(this);

const WORD = "vimmabird";
const ENGINE = "Vimma Suggest Test";
const SUGGEST =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_urlbar_suggest.sjs";
/** Pages the profile knows: history, a bookmark and an open tab, all matching WORD. */
const VISITED = Array.from({ length: 8 }, (_, i) => `https://example.com/vimmabird-${i + 1}`);
/** The most pages listed while the engine has suggestions to show after them. */
const PAGES_MAX = 4;
const BOOKMARKED = "https://example.com/vimmabird-bookmark";
const OPEN = "https://example.org/?vimmabird";

let openTab;
let bookmark;

add_task(async function setup() {
  // Registered before the engine, so it runs first (cleanup runs in order): suggestions are off
  // again before removing the engine makes Firefox's default (Google in CI) the default.
  registerCleanupFunction(async () => {
    await closeList();
    await SpecialPowers.popPrefEnv();
    BrowserTestUtils.removeTab(openTab);
    await PlacesUtils.bookmarks.remove(bookmark);
    await PlacesUtils.history.clear();
  });
  // The test profile turns suggestions off so that no test reaches the network
  // (testing/profiles/unittest-required/user.js); a release profile has them on.
  await SpecialPowers.pushPrefEnv({ set: [["browser.urlbar.suggest.searches", true]] });
  await SearchTestUtils.installSearchExtension(
    {
      name: ENGINE,
      search_url: "https://example.com/",
      search_url_get_params: "s={searchTerms}",
      suggest_url: SUGGEST,
      suggest_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true },
  );
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits(
    VISITED.map((uri, i) => ({ uri, title: `${WORD} page ${i + 1}` })),
  );
  bookmark = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.unfiledGuid,
    url: BOOKMARKED,
    title: `${WORD} bookmark`,
  });
  openTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, OPEN);
  gBrowser.selectedTab = gBrowser.tabs[0];
});

/** The rows the drop-down shows for WORD, in order: { type, url, suggestion, heuristic }. */
async function typed() {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: WORD });
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { type, url, heuristic, searchParams } = await UrlbarTestUtils.getDetailsOfResultAt(
      window,
      i,
    );
    rows.push({ type, url, heuristic, suggestion: searchParams?.suggestion, index: i });
  }
  info(`rows: ${JSON.stringify(rows)}`);
  return rows;
}

/**
 * Closes the list and puts the address back. A selected suggestion leaves its text in the
 * field; left there, a later query would fetch suggestions from whatever engine is the default
 * once this file's engine is removed (in CI, Google: a non-local connection).
 */
async function closeList() {
  if (gURLBar.view.isOpen) await UrlbarTestUtils.promisePopupClose(window);
  gURLBar.handleRevert();
}

const isPage = (r) =>
  !r.heuristic &&
  (r.type === UrlbarShared.RESULT_TYPE.URL || r.type === UrlbarShared.RESULT_TYPE.TAB_SWITCH);
const isSuggestion = (r) => !r.heuristic && r.type === UrlbarShared.RESULT_TYPE.SEARCH;

add_task(async function pages_come_before_search_suggestions() {
  const rows = await typed();
  const pages = rows.filter(isPage);
  const suggestions = rows.filter((r) => isSuggestion(r) && r.suggestion);
  Assert.ok(rows[0].heuristic, "the first row searches or visits what was typed");
  Assert.greaterOrEqual(pages.length, 3, "history, the bookmark and the open tab are listed");
  Assert.greaterOrEqual(suggestions.length, 1, "the engine's suggestions are listed");
  Assert.equal(pages[0].index, 1, "one tab from the input reaches the first page");
  Assert.less(
    pages.at(-1).index,
    suggestions[0].index,
    "every page comes before the first search suggestion",
  );
  const first = UrlbarTestUtils.getRowAt(window, suggestions[0].index);
  await TestUtils.waitForCondition(
    () => first.getAttribute("label") === `${ENGINE} suggestions`,
    "the suggestions, after the pages, are headed with the engine's name",
  );
  await closeList();
});

add_task(async function no_group_is_headed_firefox() {
  const rows = await typed();
  const pages = UrlbarTestUtils.getRowAt(window, rows.find(isPage).index);
  await TestUtils.waitForCondition(() => pages.hasAttribute("label"), "the pages get a heading");
  Assert.equal(pages.getAttribute("label"), "Vimma", "the pages are headed with Vimma's name");
  const labels = rows
    .map((r) => UrlbarTestUtils.getRowAt(window, r.index).getAttribute("label"))
    .filter(Boolean);
  info(`group labels: ${JSON.stringify(labels)}`);
  for (const label of labels) Assert.ok(!/Firefox/.test(label), `"${label}" names no Firefox`);
  await closeList();
});

add_task(async function pages_are_capped_so_the_suggestions_stay_close() {
  const rows = await typed();
  const pages = rows.filter(isPage);
  const suggestions = rows.filter((r) => isSuggestion(r) && r.suggestion);
  Assert.equal(pages.length, PAGES_MAX, "ten pages match, and the list shows four of them");
  Assert.equal(suggestions.length, 5, "the rest of the list is the engine's suggestions");
  Assert.equal(rows.length, 10, "the list keeps Firefox's length (browser.urlbar.maxRichResults)");
  let presses = 0;
  const stops = [];
  while (!gURLBar.view.selectedResult?.payload.suggestion && presses < 30) {
    EventUtils.synthesizeKey("KEY_Tab");
    presses++;
    stops.push(gURLBar.view.selectedElement?.className ?? "none");
  }
  info(`tab presses from the input to the first suggestion: ${presses}, stops: ${stops}`);
  // One stop per page row, then the suggestion: tab skips each row's result-menu button
  // (browser.urlbar.resultMenu.keyboardAccessible false in firefox-branding.js), which made
  // three of the four page rows two stops each (the open tab's row has no menu).
  Assert.deepEqual(
    stops.filter((s) => s.includes("urlbarView-button-menu")),
    [],
    "tab never stops on a row's result-menu button",
  );
  Assert.equal(
    presses,
    PAGES_MAX + 1,
    "the first suggestion is five presses of tab away: one per page, then the suggestion",
  );
  Assert.equal(
    gURLBar.view.selectedResult.payload.suggestion,
    `${WORD} one`,
    "tab reaches the first suggestion",
  );
  await closeList();
});
