/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/start-page-commands.md (issue #1271)

"use strict";

/* global BrowserCommands -- browser window global (browser.js) */

const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs",
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs",
);
SearchTestUtils.init(this);
UrlbarTestUtils.init(this);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const START = "chrome://browser/content/vimma/start/start.html";
const CMDLINE_ID = "vimma-cmdline";
const INPUT_ID = "vimma-cmdline-input";
/** The test engine's search and suggestion URLs both carry this, to find them in `requested`. */
const MARK = "vimma1271";
const SUGGEST =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_urlbar_suggest.sjs";

/** Every URL the parent opened an http(s) channel for, while this file runs. */
const requested = /** @type {string[]} */ ([]);
const observer = {
  /** @param {nsISupports} subject */
  observe(subject) {
    requested.push(subject.QueryInterface(Ci.nsIChannel).URI.spec);
  },
};

/** The requests that reached the test engine (a search or a suggestion fetch). */
const engineRequests = () => requested.filter((url) => url.includes(MARK));

add_task(async function setup() {
  registerCleanupFunction(async () => {
    Services.obs.removeObserver(observer, "http-on-modify-request");
    while (gBrowser.tabs.length > 1) {
      gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
    gURLBar.handleRevert();
    await SpecialPowers.popPrefEnv();
  });
  // The test profile turns suggestions off so that no test reaches the network; a release
  // profile has them on, and a `:` line must not reach the engine's suggestions either.
  await SpecialPowers.pushPrefEnv({ set: [["browser.urlbar.suggest.searches", true]] });
  await SearchTestUtils.installSearchExtension(
    {
      name: "Vimma Colon Test",
      search_url: "https://example.com/",
      search_url_get_params: `${MARK}={searchTerms}`,
      suggest_url: SUGGEST,
      suggest_url_get_params: `${MARK}=1&q={searchTerms}`,
    },
    { setAsDefault: true },
  );
  Services.obs.addObserver(observer, "http-on-modify-request");
});

/** Opens a new tab the way ctrl+t does, on the start page with its address bar focused. */
async function openStartTab() {
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, START, true);
  BrowserCommands.openTab();
  const tab = await loaded;
  await TestUtils.waitForCondition(() => gURLBar.focused, "the address bar is focused");
  Assert.equal(gURLBar.value, "", "the address bar is empty");
  return tab;
}

/**
 * Types `text` into the focused address bar and waits for the drop-down's query to end.
 * @param {string} text
 */
async function typeInBar(text) {
  EventUtils.sendString(text);
  await gURLBar.lastQueryContextPromise;
  Assert.equal(gURLBar.value, text, "the text is in the address bar");
}

const cmdline = () => /** @type {HTMLElement | null} */ (document.getElementById(CMDLINE_ID));
const cmdlineOpen = () => !!cmdline() && !(/** @type {HTMLElement} */ (cmdline()).hidden);
const cmdlineText = () => /** @type {HTMLInputElement} */ (document.getElementById(INPUT_ID)).value;

async function closeCmdline() {
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !cmdlineOpen(), "Esc closes the command line");
}

/** Closes every tab but the first. */
function closeOtherTabs() {
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
}

add_task(async function a_colon_line_runs_as_a_command() {
  requested.length = 0;
  const tab = await openStartTab();
  const tabs = gBrowser.tabs.length;

  await typeInBar(":tabnew");
  Assert.deepEqual(engineRequests(), [], "the engine was not asked for suggestions");
  Assert.equal(
    gURLBar.view.isOpen ? UrlbarTestUtils.getResultCount(window) : 0,
    0,
    "the drop-down offers no search for the line",
  );

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === tabs + 1,
    "Enter ran :tabnew: a new tab opened",
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, START, "the start page did not navigate");
  Assert.ok(!cmdlineOpen(), "the command line closed after running the line");
  Assert.deepEqual(engineRequests(), [], "nothing was sent to the search engine");

  // The line went into the command line's history, as one typed after `:` does.
  gBrowser.selectedTab = tab;
  // A tab switch may give the address bar focus back: move it to the page first.
  tab.linkedBrowser.focus();
  await SimpleTest.promiseFocus(tab.linkedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await TestUtils.waitForCondition(cmdlineOpen, ": opens the command line on the page");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(cmdlineText(), "tabnew", "Up recalls the line run from the address bar");
  await closeCmdline();
  Assert.equal(gURLBar.value, "", "the address bar is empty again");
  closeOtherTabs();
});

add_task(async function shift_enter_runs_the_line_too() {
  requested.length = 0;
  await openStartTab();
  const tabs = gBrowser.tabs.length;
  await typeInBar(":tabnew");
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === tabs + 1,
    "shift+Enter ran :tabnew, as on the command line",
  );
  Assert.deepEqual(engineRequests(), [], "nothing was sent to the search engine");
  closeOtherTabs();
});

add_task(async function an_unknown_command_shows_its_error() {
  requested.length = 0;
  const tab = await openStartTab();
  await typeInBar(":tabnwe");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(cmdlineOpen, "the command line opens with the line");
  Assert.equal(cmdlineText(), "tabnwe", "the line is on the command line, to fix");
  const error = /** @type {HTMLElement} */ (cmdline()).querySelector(".vimma-cmdline-error");
  Assert.stringContains(error?.textContent ?? "", "not a command", "its error shows");
  await closeCmdline();
  Assert.equal(tab.linkedBrowser.currentURI.spec, START, "the start page did not navigate");
  Assert.deepEqual(engineRequests(), [], "nothing was sent to the search engine");
  closeOtherTabs();
});

add_task(async function other_enters_and_paste_and_go_only_fill_the_command_line() {
  requested.length = 0;
  const tab = await openStartTab();
  const tabs = gBrowser.tabs.length;

  for (const modifiers of [{ altKey: true }, { ctrlKey: true }]) {
    await typeInBar(":tabnew");
    EventUtils.synthesizeKey("KEY_Enter", modifiers);
    await TestUtils.waitForCondition(
      cmdlineOpen,
      `${JSON.stringify(modifiers)} Enter opens the command line`,
    );
    Assert.equal(cmdlineText(), "tabnew", "with the line on it");
    Assert.equal(gBrowser.tabs.length, tabs, "and does not run it");
    await closeCmdline();
    gURLBar.focus();
  }

  // The go button: a click, not an Enter. It is in the shown toolbar only: the minimal bar of
  // the hidden one, the default (toolbar-toggle decisions 3 and 7a), has none to click.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.ui.toolbar.hidden", false]] });
  gURLBar.focus();
  await typeInBar(":tabnew");
  EventUtils.synthesizeMouseAtCenter(gURLBar.goButton, {});
  await TestUtils.waitForCondition(cmdlineOpen, "the go button opens the command line");
  Assert.equal(cmdlineText(), "tabnew", "with the line on it");
  Assert.equal(gBrowser.tabs.length, tabs, "and does not run it");
  await closeCmdline();
  await SpecialPowers.popPrefEnv();
  gURLBar.focus();

  // Paste & Go (the address bar's context menu): what it runs after pasting, with no event,
  // since the clipboard may hold text a page put there.
  await typeInBar(":tabnew");
  gURLBar.handleCommand();
  await TestUtils.waitForCondition(cmdlineOpen, "Paste & Go opens the command line");
  Assert.equal(cmdlineText(), "tabnew", "with the line on it");
  Assert.equal(gBrowser.tabs.length, tabs, "and does not run it");
  await closeCmdline();

  // A drop on the address bar (text a page may have dragged) goes straight to navigation.
  gURLBar.focus();
  await typeInBar(":tabnew");
  gURLBar.handleNavigation({
    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
  });
  await TestUtils.waitForCondition(cmdlineOpen, "a dropped line opens the command line");
  Assert.equal(gBrowser.tabs.length, tabs, "and does not run it");
  await closeCmdline();

  Assert.equal(tab.linkedBrowser.currentURI.spec, START, "the start page did not navigate");
  Assert.deepEqual(engineRequests(), [], "nothing was sent to the search engine");
  closeOtherTabs();
});

add_task(async function a_line_left_open_is_replaced() {
  const tab = await openStartTab();
  const tabs = gBrowser.tabs.length;
  const cmd = /** @type {HostState} */ (VimmaHost._state(window)).cmdline;
  // A line put on the command line and left open (the window lost focus, so it stayed).
  cmd.open("tabclose");
  Assert.ok(cmdlineOpen(), "a line is open");
  cmd.enter("tabnew", { run: true });
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === tabs + 1,
    "the line handed over ran, not the one left open",
  );
  Assert.ok(tab.isConnected, "the start page's tab was not closed");
  closeOtherTabs();
});

add_task(async function the_start_page_url_is_the_same() {
  const { START_PAGE_URL } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/start/StartPage.sys.mjs",
  );
  const commands = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/urlbar-commands.mjs",
  );
  Assert.equal(commands.START_PAGE_URL, START_PAGE_URL, "urlbar-commands.mjs's copy agrees");
});

add_task(async function searches_and_addresses_still_work_on_the_start_page() {
  requested.length = 0;
  let tab = await openStartTab();
  let loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    `https://example.com/?${MARK}=vimmabird`,
  );
  await typeInBar("vimmabird");
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  Assert.ok(true, "words still search the default engine");

  tab = await openStartTab();
  loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "https://example.org/");
  await typeInBar("https://example.org/");
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  Assert.ok(true, "an address still loads");
  closeOtherTabs();
});

add_task(async function other_pages_keep_the_address_bar_as_it_was() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/");
  gURLBar.focus();
  gURLBar.select();
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    `https://example.com/?${MARK}=%3Atabnew`,
  );
  await typeInBar(":tabnew");
  EventUtils.synthesizeKey("KEY_Enter");
  await loaded;
  Assert.ok(true, "away from the start page a `:` line is a search, as in Firefox");
  closeOtherTabs();
});
