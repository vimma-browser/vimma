/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Normal-mode extras (spec: docs/specs/m1-actor-insert-scroll.md, "Follow-up: normal-mode
// extras"): yy copies the page's URL, p / P open the clipboard (a URL, else a search; never a
// javascript: or data: URL), gi focuses the Nth text field, gu / gU go up the URL, gf views the
// source. They act on the focused pane; in insert mode the keys are the page's.

"use strict";

/* global focusContent, recordPageKeys, pageKeys -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs",
);
SearchTestUtils.init(this);

/** Text fields after ones gi skips (hidden, not displayed, not text). Served over https: a
 * data: page has no actor. */
const FIELDS = `https://example.com/document-builder.sjs?html=${encodeURIComponent(
  `<input type="hidden" value="h"><input id="gone" style="display:none">
  <input type="checkbox" id="box"><input id="a"><textarea id="b"></textarea>
  <input type="search" id="c">`,
)}`;

/** This window's pane view, which PaneViews made when the window opened. */
const paneView = () => /** @type {PaneView} */ (PaneViews.get(window));

registerCleanupFunction(async () => {
  while (paneView().panes) paneView().close();
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

function notice() {
  return document.getElementById("vimma-notice");
}

/** Waits for the notice to say `text`. */
async function noticeSays(/** @type {string} */ text) {
  await TestUtils.waitForCondition(
    () => notice()?.textContent === text && notice()?.matches(":popover-open") === true,
    `the notice says ${JSON.stringify(text)}`,
  );
}

/**
 * A foreground tab on `url`, focused, recording its page's keys.
 * @param {string} url
 */
async function openPage(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await recordPageKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  return tab;
}

function press(/** @type {string[]} */ keys) {
  for (const key of keys) EventUtils.synthesizeKey(key);
}

/**
 * Presses `keys` in the focused page and resolves with where `browser` loads next, or null if
 * it does not load `url` within 5 s (a key that does nothing fails an assertion instead of
 * timing out the file).
 * @param {MozTabBrowser} browser
 * @param {string[]} keys
 * @param {string} url
 */
async function loadsAfter(browser, keys, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url, true).then(() => true);
  press(keys);
  const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
  return (await Promise.race([loaded, timedOut])) ? browser.currentURI.spec : null;
}

/** Puts `text` on the clipboard and waits until it is there. */
async function copy(/** @type {string} */ text) {
  await SimpleTest.promiseClipboardChange(text, () => SpecialPowers.clipboardCopyString(text));
}

add_task(async function yy_copies_the_page_url() {
  const url = "https://example.com/a/b?x=1#frag";
  const tab = await openPage(url);
  await copy("before");
  await SimpleTest.promiseClipboardChange(url, () => press(["y", "y"]));
  await noticeSays(`yanked ${url}`);
  Assert.deepEqual(await pageKeys(tab.linkedBrowser), [], "the page saw neither y");
  Assert.equal(VimmaHost._browserMode(tab.linkedBrowser), "normal", "still in normal mode");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function p_opens_a_clipboard_url_in_this_tab() {
  const tab = await openPage("https://example.com/?from");
  const tabs = gBrowser.tabs.length;
  await copy("  https://example.com/?pasted \n");
  Assert.equal(
    await loadsAfter(tab.linkedBrowser, ["p"], "https://example.com/?pasted"),
    "https://example.com/?pasted",
    "p loads the trimmed URL in this tab",
  );
  Assert.equal(gBrowser.tabs.length, tabs, "and opens no tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function shift_p_opens_a_clipboard_url_in_a_new_tab() {
  const tab = await openPage("https://example.com/?from");
  await copy("https://example.com/?newtab");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/?newtab", true);
  press(["P"]);
  const fresh = await opened;
  Assert.equal(gBrowser.selectedTab, fresh, "P selects the new tab");
  Assert.equal(tab.linkedBrowser.currentURI.spec, "https://example.com/?from", "this tab stays");
  BrowserTestUtils.removeTab(fresh);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function p_searches_words_with_the_default_engine() {
  await SearchTestUtils.installSearchExtension(
    {
      name: "VimmaTest",
      search_url: "https://example.com/search",
      search_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true },
  );
  const tab = await openPage("https://example.com/?from");
  await copy("vimma test\nwords");
  const want = "https://example.com/search?q=vimma+test+words";
  Assert.equal(
    await loadsAfter(tab.linkedBrowser, ["p"], want),
    want,
    "words (newlines collapsed) go to the default search engine",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function p_and_shift_p_refuse_javascript_and_data_urls() {
  const url = "https://example.com/?safe";
  const tab = await openPage(url);
  const tabs = gBrowser.tabs.length;
  const title = () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title);
  const before = await title();
  for (const [text, says] of [
    ["javascript:document.title='pwned'", "blocked: javascript: URL from the clipboard"],
    [" JAVA\nSCRIPT:void(0)", "blocked: javascript: URL from the clipboard"],
    ["data:text/html,<h1>x</h1>", "blocked: data: URL from the clipboard"],
    ["view-source:javascript:1", "blocked: javascript: URL from the clipboard"],
    [`https://example.com/${"a".repeat(9000)}`, "blocked: over 8192 characters from the clipboard"],
  ]) {
    await copy(text);
    for (const key of ["p", "P"]) {
      notice()?.hidePopover();
      press([key]);
      await noticeSays(says);
      Assert.equal(gBrowser.tabs.length, tabs, `${key} opens no tab for ${text.slice(0, 30)}`);
      Assert.equal(gBrowser.selectedTab, tab, "and stays on this tab");
      Assert.equal(tab.linkedBrowser.currentURI.spec, url, "which does not navigate");
    }
  }
  Assert.equal(await title(), before, "no script ran in the page");
  await copy(" \n ");
  press(["p"]);
  await noticeSays("the clipboard is empty");
  Assert.equal(tab.linkedBrowser.currentURI.spec, url, "an empty clipboard opens nothing");
  BrowserTestUtils.removeTab(tab);
});

/** The id of the focused element in `browser`'s page. */
function focusedId(/** @type {XULBrowserElement} */ browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.activeElement?.id ?? "");
}

add_task(async function gi_focuses_the_first_text_field_and_enters_insert() {
  const tab = await openPage(FIELDS);
  const browser = tab.linkedBrowser;
  Assert.equal(VimmaHost._browserMode(browser), "normal", "starts in normal mode");

  press(["g", "i"]);
  await TestUtils.waitForCondition(async () => (await focusedId(browser)) === "a", "gi: #a");
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");

  for (const [count, id] of [
    ["2", "b"],
    ["3", "c"],
    ["9", "c"],
    ["1", "a"],
  ]) {
    press(["KEY_Escape"]);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "Esc");
    press([count, "g", "i"]);
    await TestUtils.waitForCondition(
      async () => (await focusedId(browser)) === id,
      `${count}gi focuses #${id}`,
    );
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  }
  Assert.deepEqual(
    (await pageKeys(browser)).filter((k) => k !== "Escape"),
    [],
    "the page saw no g, i or count",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function gi_without_a_text_field_says_so_and_stays_normal() {
  const tab = await openPage("https://example.com/?nofields");
  press(["g", "i"]);
  await noticeSays("no text field on this page");
  Assert.equal(VimmaHost._browserMode(tab.linkedBrowser), "normal", "still normal");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function gu_and_shift_gu_walk_up_the_url() {
  const tab = await openPage("https://example.com/a/b/c?x=1#h");
  const browser = tab.linkedBrowser;
  const up = (/** @type {string[]} */ keys, /** @type {string} */ want) =>
    loadsAfter(browser, keys, want).then(async (got) => {
      await recordPageKeys(browser);
      await focusContent(browser);
      return got;
    });
  Assert.equal(
    await up(["g", "u"], "https://example.com/a/b/"),
    "https://example.com/a/b/",
    "gu drops the query, hash and last segment",
  );
  Assert.equal(await up(["g", "u"], "https://example.com/a/"), "https://example.com/a/", "gu");
  BrowserTestUtils.startLoadingURIString(browser, "https://example.com/a/b/c/d");
  await BrowserTestUtils.browserLoaded(browser, false, "https://example.com/a/b/c/d");
  await recordPageKeys(browser);
  await focusContent(browser);
  Assert.equal(
    await up(["2", "g", "u"], "https://example.com/a/b/"),
    "https://example.com/a/b/",
    "2gu goes up two levels",
  );
  Assert.equal(
    await up(["g", "U"], "https://example.com/"),
    "https://example.com/",
    "gU goes to the root",
  );
  press(["g", "u"]);
  await noticeSays("already at the top");
  press(["g", "U"]);
  await noticeSays("already at the top");
  Assert.equal(browser.currentURI.spec, "https://example.com/", "nothing above the root");
  Assert.deepEqual(await pageKeys(browser), [], "the page saw no g, u or U");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function gf_views_the_source_in_a_new_tab() {
  const url = "https://example.com/?source";
  const tab = await openPage(url);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, `view-source:${url}`, true);
  press(["g", "f"]);
  const fresh = await opened;
  Assert.equal(fresh.linkedBrowser.currentURI.spec, `view-source:${url}`, "gf shows the source");
  Assert.equal(tab.linkedBrowser.currentURI.spec, url, "the page stays");
  BrowserTestUtils.removeTab(fresh);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function in_a_split_the_keys_act_on_the_focused_pane() {
  const leftUrl = "https://example.com/left/page";
  const rightUrl = "https://example.com/right/page";
  const left = await openPage(leftUrl);
  const right = await openPage(rightUrl);
  await BrowserTestUtils.switchTab(gBrowser, left);
  const view = paneView();
  Assert.ok(
    view.split("vertical", { tab: /** @type {SplitTab} */ (right) }).ok,
    "split left | right",
  );
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === right, "the right pane focused");
  const [lb, rb] = [left.linkedBrowser, right.linkedBrowser];
  await recordPageKeys(lb);
  await recordPageKeys(rb);
  await focusContent(rb);

  await SimpleTest.promiseClipboardChange(rightUrl, () => press(["y", "y"]));
  Assert.equal(
    await loadsAfter(rb, ["g", "u"], "https://example.com/right/"),
    "https://example.com/right/",
    "gu goes up in the focused pane",
  );
  Assert.equal(lb.currentURI.spec, leftUrl, "the other pane stays");

  await recordPageKeys(rb);
  await focusContent(rb);
  await copy("https://example.com/?into-right");
  Assert.equal(
    await loadsAfter(rb, ["p"], "https://example.com/?into-right"),
    "https://example.com/?into-right",
    "p loads into the focused pane",
  );
  Assert.equal(lb.currentURI.spec, leftUrl, "and not the other");
  Assert.deepEqual(await pageKeys(lb), [], "the other pane's page saw no keys");
  view.close();
  BrowserTestUtils.removeTab(right);
  BrowserTestUtils.removeTab(left);
});

add_task(async function in_insert_mode_the_keys_are_typed() {
  const url = "https://example.com/a/b";
  const tab = await openPage(url);
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.document.body.append(content.document.createElement("input"));
  });
  await SpecialPowers.spawn(browser, [], () =>
    /** @type {HTMLInputElement} */ (content.document.querySelector("input")).focus(),
  );
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === "insert",
    "the field puts the page in insert mode",
  );
  await copy("https://example.com/?not-opened");
  const tabs = gBrowser.tabs.length;
  const typed = ["y", "y", "p", "P", "g", "i", "g", "u", "g", "U", "g", "f"];
  press(typed);
  const value = () =>
    SpecialPowers.spawn(
      browser,
      [],
      () => /** @type {HTMLInputElement} */ (content.document.querySelector("input")).value,
    );
  await TestUtils.waitForCondition(
    async () => (await value()).length >= typed.length,
    "the field gets every key",
  );
  Assert.equal(await value(), typed.join(""), "the keys are typed into the field");
  Assert.deepEqual(await pageKeys(browser), typed, "unprevented");
  Assert.equal(browser.currentURI.spec, url, "no navigation");
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    "https://example.com/?not-opened",
    "the clipboard is untouched",
  );
  BrowserTestUtils.removeTab(tab);
});
