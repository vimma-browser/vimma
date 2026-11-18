/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Reader View (issue #1310): the status bar's URL and `yy` name the article's own address, as
// Firefox's address bar shows it (ReaderMode.getOriginalUrlObjectForDisplay), never the encoded
// about:reader?url=… one; `gu` walks up the article's URL. A malformed about:reader address
// stays as it is. Spec: docs/specs/m1-actor-insert-scroll.md, "Follow-up: normal-mode extras";
// docs/specs/m2-statusbar-whichkey.md.

"use strict";

/* global focusContent -- from head.js */

const { gotoItems, selectedTabId } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/goto.mjs",
);
const { currentPage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/bookmark-ops.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const ARTICLE = `${ROOT}file_vimma_reader_article.html`;
const READER = `about:reader?url=${encodeURIComponent(ARTICLE)}`;

registerCleanupFunction(() => {
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/** The status bar's URL segment, or null when it shows none. */
function urlSegment() {
  return document.querySelector('#vimma-statusbar [data-segment="url"]')?.textContent ?? null;
}

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

function press(/** @type {string[]} */ keys) {
  for (const key of keys) EventUtils.synthesizeKey(key);
}

/** Puts `text` on the clipboard and waits until it is there. */
async function copy(/** @type {string} */ text) {
  await SimpleTest.promiseClipboardChange(text, () => SpecialPowers.clipboardCopyString(text));
}

/**
 * A foreground tab on `url` in Reader View, with the article rendered when `ready`, focused.
 * @param {string} url
 * @param {boolean} ready
 */
async function openReader(url, ready) {
  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: url,
    waitForLoad: !ready,
  });
  if (ready) {
    await BrowserTestUtils.waitForContentEvent(tab.linkedBrowser, "AboutReaderContentReady");
  }
  await focusContent(tab.linkedBrowser);
  return tab;
}

add_task(async function reader_view_shows_and_yanks_the_article_url() {
  const tab = await openReader(READER, true);
  Assert.equal(tab.linkedBrowser.currentURI.spec, READER, "the tab is in Reader View");
  const shown = ARTICLE.replace(/^https:\/\//, "");
  await TestUtils.waitForCondition(
    () => urlSegment() === shown,
    `the status bar shows ${shown}, not the about:reader address`,
  );
  await copy("before");
  await SimpleTest.promiseClipboardChange(ARTICLE, () => press(["y", "y"]));
  await noticeSays(`yanked ${ARTICLE}`);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_rows_and_bookmarks_take_the_article_url() {
  const tab = await openReader(READER, true);
  const id = selectedTabId(window);
  const row = gotoItems(window).find((item) => "tabId" in item && item.tabId === id);
  Assert.equal(row?.url, ARTICLE, "the tab search row names the article");
  Assert.equal(currentPage(window)?.url, ARTICLE, "ctrl+b a bookmarks the article");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_hidden_toolbar_shows_no_lock_and_no_warning_for_the_reader() {
  // docs/security/06-chrome-ui-rendering.md C3: the security cue is the reader page's own.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.ui.toolbar.hidden", true]] });
  const tab = await openReader(READER, true);
  const shown = ARTICLE.replace(/^https:\/\//, "");
  await TestUtils.waitForCondition(() => urlSegment() === shown, "the article's address shows");
  const bar = /** @type {Element} */ (document.getElementById("vimma-statusbar"));
  Assert.equal(bar.querySelector('[data-segment="security"]'), null, "no security segment");
  // Whole words: an earlier test's `↓ blocked` download may still show, and is no lock.
  const segments = [...bar.querySelectorAll("[data-segment]")].map((s) => s.textContent ?? "");
  Assert.deepEqual(
    segments.filter((text) => /\bnot secure\b|\block\b|\u{1F512}/iu.test(text)),
    [],
    "no segment shows a lock or says not secure",
  );
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function an_article_with_credentials_shows_and_copies_none() {
  const withUser = ARTICLE.replace("https://", "https://user:secret@");
  const tab = await openReader(`about:reader?url=${encodeURIComponent(withUser)}`, false);
  const shown = ARTICLE.replace(/^https:\/\//, "");
  await TestUtils.waitForCondition(
    () => urlSegment() === shown,
    "the bar shows the article without credentials, its example.com domain first",
  );
  await copy("before");
  await SimpleTest.promiseClipboardChange(ARTICLE, () => press(["y", "y"]));
  await noticeSays(`yanked ${ARTICLE}`);
  const id = selectedTabId(window);
  const row = gotoItems(window).find((item) => "tabId" in item && item.tabId === id);
  Assert.equal(row?.url, ARTICLE, "the tab search row has no credentials either");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function reader_view_gu_walks_up_the_article_url() {
  const tab = await openReader(READER, true);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, ROOT);
  press(["g", "u"]);
  await loaded;
  Assert.equal(tab.linkedBrowser.currentURI.spec, ROOT, "gu goes to the article's folder");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_malformed_reader_address_stays_as_it_is() {
  // The reader opens any url that starts with http://, https:// or file:// (AboutReader's own
  // check, which sends anything else to about:blank), so one that is not a URL stays loaded.
  const raw = `about:reader?url=${encodeURIComponent("http://[")}`;
  const tab = await openReader(raw, false);
  Assert.equal(tab.linkedBrowser.currentURI.spec, raw, "the reader keeps the malformed address");
  await TestUtils.waitForCondition(
    () => urlSegment() === raw,
    "the status bar shows the raw address",
  );
  await copy("before");
  await SimpleTest.promiseClipboardChange(raw, () => press(["y", "y"]));
  await noticeSays(`yanked ${raw}`);
  BrowserTestUtils.removeTab(tab);
});
