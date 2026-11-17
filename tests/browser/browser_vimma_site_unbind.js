/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/site-unbind.md. `[sites."<host>"] unbind` gives keys to the page on that
// site, in normal and insert mode; every other key, and the same key on other sites, stays
// Vimma's, and Esc always does.

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const MAC = AppConstants.platform === "macosx";

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_site_unbind.html";
const OTHER_SITE = PAGE.replace("https://example.com", "https://example.org");

/** Vimma's j step, in CSS pixels. */
const STEP = 60;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  // `t`, `ctrl+l` and `ctrl+w` are the page's on example.com and its subdomains, as
  // config.toml's [sites."example.com"] unbind = ["t", "ctrl+l", "ctrl+w"] makes them.
  VimmaHost.configure({
    keymap: compileKeymap(
      { sites: { "example.com": { unbind: ["t", "ctrl+l", "ctrl+w"] } } },
      { mac: MAC },
    ),
  });
  registerCleanupFunction(() => VimmaHost.configure({ keymap: compileKeymap({}, { mac: MAC }) }));
});

/**
 * Opens `url` in a new tab with content focus in normal mode and records the page's keydowns.
 * @param {string} url
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(url, fn) {
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    await fn(browser);
  });
}

/**
 * @param {XULBrowserElement} browser
 * @param {"normal" | "insert"} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/** @param {XULBrowserElement} browser */
function focusField(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    /** @type {HTMLElement} */ (content.document.getElementById("field")).focus(),
  );
}

add_task(async function a_site_unbound_key_reaches_the_page() {
  await withPage(PAGE, async (browser) => {
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("t");
    Assert.ok(await waitForPageKey(browser, ["t"]), "the page got t, not prevented");
    // j is still Vimma's on the site.
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await pageScrollY(browser)) === STEP,
      "j scrolls",
    );
    Assert.equal(gBrowser.tabs.length, tabs, "t opened no tab");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab stays in normal mode");
  });
});

add_task(async function the_same_key_is_vimmas_on_another_site() {
  await withPage(OTHER_SITE, async (browser) => {
    const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
    EventUtils.synthesizeKey("t");
    const tab = /** @type {MozTabbrowserTab} */ ((await opened).target);
    Assert.ok(!(await pageKeys(browser)).includes("t"), "example.org's page did not get t");
    BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function a_site_unbound_chord_reaches_a_field_in_insert_mode() {
  await withPage(PAGE, async (browser) => {
    await focusField(browser);
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("l", { ctrlKey: true });
    Assert.ok(await waitForPageKey(browser, ["l"]), "the page got ctrl+l, not prevented");
    Assert.equal(document.activeElement, browser, "focus stayed in the page, not the URL bar");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the field keeps insert");
  });
});

add_task(async function esc_still_leaves_insert() {
  await withPage(PAGE, async (browser) => {
    await focusField(browser);
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
  });
});

/** @param {XULBrowserElement} browser */
function fieldValue(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => /** @type {HTMLInputElement} */ (content.document.getElementById("field")).value,
  );
}

// Vimma's text-field keys (ctrl+w deletes the word before the caret) are Vimma acting on the key
// too.
add_task(async function a_site_unbound_edit_key_is_left_to_the_field() {
  await withPage(PAGE, async (browser) => {
    await focusField(browser);
    await waitForMode(browser, "insert");
    EventUtils.sendString("one two");
    await TestUtils.waitForCondition(
      async () => (await fieldValue(browser)) === "one two",
      "typed",
    );
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    Assert.ok(await waitForPageKey(browser, ["w"]), "the page got ctrl+w, not prevented");
    // A key typed after it lands after the edit would have: the field's text tells.
    EventUtils.sendString("!");
    await TestUtils.waitForCondition(async () => (await fieldValue(browser)).endsWith("!"), "!");
    Assert.equal(await fieldValue(browser), "one two!", "Vimma did not delete the word");
  });
});
