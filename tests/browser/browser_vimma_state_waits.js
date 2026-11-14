/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The control socket's `state.grep` and `state.urlbar` (docs/specs/m0-control-protocol-and-
// vimma-ctl.md, "state"; #1006): whether live grep and the address bar's suggestion list have
// drawn all they will for what was typed, so the e2e scenarios wait for that rather than for a
// time. One flag each, read from what the window draws, and null in a private window
// (security.md S9).

"use strict";

/* global focusContent -- from head.js */

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const PAGE = `https://example.com${DIR}file_vimma_grep.html`;

/** The focused window's state, checked against the protocol as the server sends it. */
function state() {
  const result = /** @type {any} */ (VimmaControl._commands.state());
  const v = validateMessage(
    { type: "response", id: 1, ok: true, result },
    { kind: "response", command: "state" },
  );
  Assert.ok(v.valid, `the state follows the protocol: ${v.errors.join("; ")}`);
  return result;
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 20, 250);
}

/** @param {string} text @param {Window} [win] */
function type(text, win = window) {
  for (const ch of text) EventUtils.synthesizeKey(ch, {}, win);
}

/** @param {Window} [win] */
const grepDialog = (win = window) => win.document.getElementById("vimma-grep");

/**
 * ctrl+b f g from the selected page of `win`; waits for the dialog.
 * @param {Window} [win]
 */
async function openGrep(win = window) {
  const browser = /** @type {any} */ (win).gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  if (win === window) await focusContent(browser);
  else await SimpleTest.promiseFocus(browser);
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey("f", {}, win);
  EventUtils.synthesizeKey("g", {}, win);
  await until(() => !!(/** @type {any} */ (grepDialog(win))?.open), "ctrl+b f g opens live grep");
}

/** @param {Record<string, string>} params */
async function openFixture(params) {
  const url = `${PAGE}?${new URLSearchParams(params)}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await until(() => tab.linkedBrowser.contentTitle === params.title, "titled");
  return tab;
}

add_task(async function test_state_reports_live_grep_as_drawn() {
  const tabs = [
    await openFixture({ title: "one", t: "credit one|nothing here|credit again" }),
    await openFixture({ title: "two", t: "credit two" }),
  ];
  Assert.strictEqual(state().grep, null, "closed: null");

  await openGrep();
  Assert.deepEqual(state().grep, { busy: false }, "open with nothing typed: nothing to come");

  type("credit");
  // Read at once: each key reaches the picker as it is typed, and the search waits a debounce.
  Assert.deepEqual(state().grep, { busy: true }, "typed: the search is still to come");
  await until(() => state().grep?.busy === false, "the search and the preview are drawn");
  const dialog = /** @type {Element} */ (grepDialog());
  Assert.equal(dialog.querySelectorAll("[role=option]").length, 3, "every match is listed");
  Assert.ok(!dialog.hasAttribute("busy"), "the list no longer says it is searching");
  Assert.ok(
    dialog.querySelector(".vimma-grep-preview-match"),
    "the selected result's preview is drawn, its line marked",
  );

  // Another result selected: its preview is still to come until it is drawn.
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.deepEqual(state().grep, { busy: true }, "another result: its preview is to come");
  await until(() => state().grep?.busy === false, "its preview is drawn");
  Assert.ok(dialog.querySelector(".vimma-grep-preview-match"), "its line is marked");

  // The first Esc may leave the query's insert for the picker's normal keys; the next closes.
  for (let i = 0; i < 3 && /** @type {any} */ (grepDialog())?.open; i++) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  await until(() => !(/** @type {any} */ (grepDialog())?.open), "Esc closes it");
  Assert.strictEqual(state().grep, null, "closed again: null");

  // A private window's search is part of its browsing: the socket never hears of it.
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const loaded = BrowserTestUtils.browserLoaded(priv.gBrowser.selectedBrowser);
  BrowserTestUtils.startLoadingURIString(
    priv.gBrowser.selectedBrowser,
    `${PAGE}?${new URLSearchParams({ title: "private", t: "credit private" })}`,
  );
  await loaded;
  await openGrep(priv);
  type("credit", priv);
  const hidden = state();
  Assert.strictEqual(hidden.private, true, "sanity: state reads the private window");
  Assert.strictEqual(hidden.grep, null, "a private window's grep stays out of state");
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  for (const tab of tabs) BrowserTestUtils.removeTab(tab);
});

add_task(async function test_state_reports_the_suggestion_list_as_drawn() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.urlbar.suggest.searches", false],
      ["browser.urlbar.suggest.history", false],
      ["browser.urlbar.suggest.bookmark", false],
      ["browser.urlbar.suggest.openpage", false],
      ["browser.urlbar.suggest.topsites", false],
    ],
  });
  Assert.strictEqual(state().urlbar, null, "the list closed: null");

  /** @type {any} UrlbarInput: the harness's type names only what other tests use */
  const bar = gURLBar;
  bar.focus();
  bar.select();
  type("about:blank");
  await until(() => state().urlbar?.settled === true, "the list draws the typed address");
  Assert.ok(bar.view.isOpen, "the list is open");
  const row = bar.view.panel.querySelector(".urlbarView-row[selected] .urlbarView-title");
  Assert.equal(row?.textContent, "about:blank", "its selected row is the address typed in full");

  // One more key: the rows on screen are the previous text's until its results are drawn.
  EventUtils.synthesizeKey("KEY_Backspace");
  Assert.deepEqual(state().urlbar, { settled: false }, "edited: its results are still to come");
  await until(() => state().urlbar?.settled === true, "drawn again");
  Assert.equal(
    bar.view.panel.querySelector(".urlbarView-row[selected] .urlbarView-title")?.textContent,
    "about:blan",
    "for the edited text",
  );

  bar.view.close();
  Assert.strictEqual(state().urlbar, null, "closed again: null");
  bar.handleRevert();
  gBrowser.selectedBrowser.focus();

  // What a private window's address bar suggests is part of its browsing: withheld.
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(priv);
  /** @type {any} */ (priv).gURLBar.focus();
  type("about:blank", priv);
  await until(() => /** @type {any} */ (priv).gURLBar.view.isOpen, "its list opens");
  const hidden = state();
  Assert.strictEqual(hidden.private, true, "sanity: state reads the private window");
  Assert.strictEqual(hidden.urlbar, null, "a private window's suggestions stay out of state");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.popPrefEnv();
});
