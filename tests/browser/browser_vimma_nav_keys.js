/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page navigation keys in normal mode: H / ctrl+o back, L / ctrl+i forward (with counts), r
// reload (plan §2, M1).
// They act on the focused page's <browser>: in a split, the focused pane's. In insert mode the
// keys are the page's.

"use strict";

/* global focusContent -- from head.js */

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const url = (/** @type {string} */ name) => `https://example.com/?page=${name}`;
/** The window's split view, which VimmaHost made when it started the window. */
const paneView = () => /** @type {PaneView} */ (PaneViews.get(window));

registerCleanupFunction(async () => {
  while (paneView().panes) paneView().close();
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

/**
 * Records the page's keydowns into sessionStorage, which outlives the document across these
 * same-origin navigations, so a key that leaked to a page that is gone is still seen. Installed
 * once per document (a page back from the bfcache keeps its listener).
 * @param {XULBrowserElement} browser
 */
async function recordKeys(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.readyState === "complete");
    if (content.wrappedJSObject.vimmaRecording) return;
    content.wrappedJSObject.vimmaRecording = true;
    content.addEventListener(
      "keydown",
      (e) => {
        const keys = JSON.parse(content.sessionStorage.getItem("vimmaKeys") ?? "[]");
        keys.push(e.defaultPrevented ? `!${e.key}` : e.key);
        content.sessionStorage.setItem("vimmaKeys", JSON.stringify(keys));
      },
      true,
    );
  });
}

/** @param {XULBrowserElement} browser */
function recordedKeys(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    JSON.parse(content.sessionStorage.getItem("vimmaKeys") ?? "[]"),
  );
}

/**
 * Loads `name` in `browser` as a new history entry.
 * @param {XULBrowserElement} browser
 * @param {string} name
 */
async function load(browser, name) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url(name));
  BrowserTestUtils.startLoadingURIString(browser, url(name));
  await loaded;
  await recordKeys(browser);
}

/** A new foreground tab whose history is a, b, …, on the last one. */
async function tabWithHistory(/** @type {string[]} */ names) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url(names[0]));
  await recordKeys(tab.linkedBrowser);
  for (const name of names.slice(1)) await load(tab.linkedBrowser, name);
  return tab;
}

/**
 * Presses `keys` in `browser`'s page and resolves with the location it lands on, or null if it
 * does not change within 5 s (a key that does nothing fails an assertion instead of timing out
 * the file).
 * @param {(string | [string, object])[]} keys a key, or [key, modifiers]
 * @param {MozTabBrowser} [browser]
 */
async function navigateWith(keys, browser = gBrowser.selectedBrowser) {
  await focusContent(browser);
  const before = browser.currentURI.spec;
  for (const key of keys) {
    if (Array.isArray(key)) EventUtils.synthesizeKey(...key);
    else EventUtils.synthesizeKey(key);
  }
  try {
    await TestUtils.waitForCondition(() => browser.currentURI.spec !== before, "location changed");
  } catch {
    return null;
  }
  await recordKeys(browser);
  return browser.currentURI.spec;
}

/**
 * Resolves true once `browser` loads `href` again, false after 5 s.
 * @param {XULBrowserElement} browser
 * @param {string} href
 */
function reloadedWithin5s(browser, href) {
  return Promise.race([
    BrowserTestUtils.browserLoaded(browser, false, href).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
}

/** Sets a flag on the current document, which a reload drops. */
function mark(/** @type {XULBrowserElement} */ browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.vimmaMarker = true;
  });
}

function marked(/** @type {XULBrowserElement} */ browser) {
  return SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.vimmaMarker);
}

add_task(async function h_and_l_walk_history_with_counts() {
  const tab = await tabWithHistory(["a", "b", "c"]);

  Assert.equal(await navigateWith(["H"]), url("b"), "H goes back one page");
  Assert.equal(await navigateWith(["2", "H"]), url("a"), "2H goes back two (clamped to the first)");
  Assert.equal(
    await navigateWith(["5", "L"]),
    url("c"),
    "5L from the first page stops at the last",
  );
  Assert.equal(await navigateWith(["H"]), url("b"), "H again");
  Assert.equal(await navigateWith(["L"]), url("c"), "L goes forward one page");
  Assert.equal(await navigateWith(["2", "H"]), url("a"), "2H from the last page skips one");

  Assert.deepEqual(await recordedKeys(tab.linkedBrowser), [], "no page saw H, L or a count");
  BrowserTestUtils.removeTab(tab);
});

// Vim's jump list keys (docs/specs/key-handling-batch.md): ctrl+o back, ctrl+i forward, in normal mode.
// ctrl+o is Firefox's Open File; in normal mode it is ours, so no file picker opens.
add_task(async function ctrl_o_and_ctrl_i_walk_history_as_in_vim() {
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  const tab = await tabWithHistory(["a", "b", "c"]);
  /** @returns {[string, object]} */
  const ctrl = (/** @type {string} */ key) => [key, { ctrlKey: true }];

  Assert.equal(await navigateWith([ctrl("o")]), url("b"), "ctrl+o goes back one page");
  Assert.equal(await navigateWith(["2", ctrl("o")]), url("a"), "2 ctrl+o goes back two");
  Assert.equal(await navigateWith([ctrl("i")]), url("b"), "ctrl+i goes forward one page");
  Assert.equal(await navigateWith(["H"]), url("a"), "H still goes back");
  Assert.equal(await navigateWith(["L"]), url("b"), "and L forward");

  Assert.ok(!MockFilePicker.shown, "ctrl+o opened no file picker");
  Assert.deepEqual(await recordedKeys(tab.linkedBrowser), [], "no page saw ctrl+o or ctrl+i");
  MockFilePicker.cleanup();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function r_reloads_the_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url("r"));
  const browser = tab.linkedBrowser;
  await recordKeys(browser);
  await mark(browser);
  await focusContent(browser);
  const reloaded = reloadedWithin5s(browser, url("r"));
  EventUtils.synthesizeKey("r");
  Assert.ok(await reloaded, "r loaded the page again");
  await recordKeys(browser);
  Assert.ok(!(await marked(browser)), "r loaded a fresh document");
  Assert.deepEqual(await recordedKeys(browser), [], "the page did not see r");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function in_a_split_the_keys_act_on_the_focused_pane() {
  const left = await tabWithHistory(["la", "lb"]);
  const right = await tabWithHistory(["ra", "rb"]);
  await BrowserTestUtils.switchTab(gBrowser, left);
  const view = paneView();
  Assert.ok(
    view.split("vertical", { tab: /** @type {PaneTab} */ (right) }).ok,
    "split left | right",
  );
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === right, "the right pane focused");
  const [lb, rb] = [left.linkedBrowser, right.linkedBrowser];

  Assert.equal(await navigateWith(["H"], rb), url("ra"), "H goes back in the focused pane");
  Assert.equal(lb.currentURI.spec, url("lb"), "and not in the other pane");
  Assert.equal(await navigateWith(["L"], rb), url("rb"), "L goes forward in the focused pane");

  await mark(lb);
  await mark(rb);
  await focusContent(rb);
  const reloaded = reloadedWithin5s(rb, url("rb"));
  EventUtils.synthesizeKey("r");
  Assert.ok(await reloaded, "r reloads the focused pane");
  await recordKeys(rb);
  Assert.ok(!(await marked(rb)), "with a fresh document");
  Assert.ok(await marked(lb), "the other pane's page was not reloaded");
  Assert.equal(lb.currentURI.spec, url("lb"), "nor moved");

  Assert.deepEqual(await recordedKeys(rb), [], "the focused pane's page saw none of the keys");
  Assert.deepEqual(await recordedKeys(lb), [], "nor did the other pane's");
  view.close();
  BrowserTestUtils.removeTab(right);
  BrowserTestUtils.removeTab(left);
});

add_task(async function in_insert_mode_the_keys_are_the_pages() {
  const tab = await tabWithHistory(["ia", "ib"]);
  const browser = tab.linkedBrowser;
  await mark(browser);
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    content.document.body.append(input);
  });
  await focusContent(browser);
  await SpecialPowers.spawn(browser, [], () =>
    /** @type {HTMLInputElement} */ (content.document.querySelector("input")).focus(),
  );
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === "insert",
    "the field puts the page in insert mode",
  );
  for (const key of ["H", "L", "r"]) EventUtils.synthesizeKey(key);
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [],
        () =>
          /** @type {HTMLInputElement} */ (content.document.querySelector("input")).value.length >=
          3,
      ),
    "the field gets three keys",
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => /** @type {HTMLInputElement} */ (content.document.querySelector("input")).value,
    ),
    "HLr",
    "H, L and r are typed into the field",
  );
  Assert.deepEqual(await recordedKeys(browser), ["H", "L", "r"], "unprevented");
  Assert.equal(browser.currentURI.spec, url("ib"), "no navigation");
  Assert.ok(await marked(browser), "and no reload");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function sanity_an_unbound_key_reaches_the_recorder() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url("z"));
  await recordKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("z");
  await TestUtils.waitForCondition(async () => (await recordedKeys(tab.linkedBrowser)).length);
  Assert.deepEqual(await recordedKeys(tab.linkedBrowser), ["z"], "the recorder sees page keys");
  BrowserTestUtils.removeTab(tab);
});
