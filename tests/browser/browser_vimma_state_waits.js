/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The control socket's `state.grep`, `state.urlbar` and `state.pdf` (docs/specs/m0-control-
// protocol-and-vimma-ctl.md, "state"; #1006): whether live grep (its search, preview and jump),
// the address bar's suggestion list and the PDF viewer have drawn all they will for what was
// typed, so the e2e scenarios wait for that rather than for a time. One flag each, read from
// what the window draws, and null in a private window (security.md S9).

"use strict";

/* global focusContent -- from head.js */

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs",
);
const { ProvidersManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");
const { PDF_OUTLINE_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/outline-ops.mjs",
);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const PAGE = `https://example.com${DIR}file_vimma_grep.html`;
const PDF = `https://example.com${DIR}file_vimma_outline.pdf`;

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

// A query that has drawn its first results but not finished is not settled, also when the
// watcher starts listening in the middle of it: a window whose address bar took focus before
// Vimma's window init hears no focus before the first `state` read.
add_task(async function test_a_query_under_way_is_not_settled_even_heard_late() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.urlbar.suggest.searches", false],
      ["browser.urlbar.suggest.history", false],
      ["browser.urlbar.suggest.bookmark", false],
      ["browser.urlbar.suggest.openpage", false],
      ["browser.urlbar.suggest.topsites", false],
    ],
  });
  // A provider that holds every query open until released, after the heuristic row is drawn.
  const held = Promise.withResolvers();
  const provider = new UrlbarTestUtils.TestProvider({ delayResultsPromise: held.promise });
  const manager = ProvidersManager.getInstanceForSap("urlbar");
  manager.registerProvider(provider);

  /** @type {any} UrlbarInput: the harness's type names only what other tests use */
  const bar = gURLBar;
  bar.focus();
  bar.select();
  type("about:blank");
  await until(
    () => bar.view.isOpen && bar.view.queryContext?.searchString === "about:blank",
    "the heuristic row of the full address is drawn",
  );
  Assert.deepEqual(state().urlbar, { settled: false }, "heard from the start: still under way");

  // Listening only from now on, as on a window that heard no focus.
  const queries = /** @type {any} */ (VimmaHost._state(window)).urlbarQueries;
  queries.destroy();
  Assert.deepEqual(state().urlbar, { settled: false }, "heard late: still under way");
  await TestUtils.waitForTick();
  Assert.deepEqual(state().urlbar, { settled: false }, "and still after a tick");

  held.resolve(undefined);
  await until(() => state().urlbar?.settled === true, "settled once the query has finished");

  manager.unregisterProvider(provider);
  bar.view.close();
  bar.handleRevert();
  gBrowser.selectedBrowser.focus();
  await SpecialPowers.popPrefEnv();
});

/**
 * Holds live grep's jumps until released: Enter's reply from the frame waits for `release`,
 * which can also stand in for a frame that has gone (null).
 * @param {BrowserWindow} [win]
 */
function holdJumps(win = window) {
  const session = /** @type {any} */ (VimmaHost._state(win)).grep;
  const ask = session.ask;
  /** @type {((reply?: unknown) => void)[]} */
  const waiting = [];
  session.ask = (
    /** @type {unknown} */ bc,
    /** @type {unknown} */ data,
    /** @type {string} */ name,
  ) =>
    name === "Vimma:GrepJump"
      ? new Promise((resolve) => waiting.push(resolve)).then((/** @type {unknown} */ reply) =>
          reply === undefined ? ask.call(session, bc, data, name) : reply,
        )
      : ask.call(session, bc, data, name);
  return {
    held: () => waiting.length,
    /** @param {unknown} [reply]  undefined: the frame's own reply */
    release: (reply) => waiting.splice(0).forEach((resolve) => resolve(reply)),
    restore: () => {
      session.ask = ask;
    },
  };
}

/** @param {Window} [win] */
async function grepCredit(win = window) {
  await openGrep(win);
  type("credit", win);
  if (win === window) await until(() => state().grep?.busy === false, "the results are drawn");
  else await until(() => !grepDialog(win)?.hasAttribute("busy"), "the results are drawn");
}

// Enter on a result closes the picker and jumps: the tab is selected, then its frame selects
// and scrolls to the match. The jump is still to come until the frame has answered, whatever
// it answers; a read right after Enter already sees it under way.
add_task(async function test_state_reports_a_grep_jump_until_it_has_drawn() {
  const tabs = [
    await openFixture({ title: "one", t: "credit one|nothing here|credit again", pad: "60" }),
    await openFixture({ title: "two", t: "nothing here" }),
  ];
  const jumps = holdJumps();
  try {
    await grepCredit();
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.ok(!(/** @type {any} */ (grepDialog())?.open), "Enter closes the picker");
    Assert.deepEqual(state().grep, { busy: true }, "read at once: the jump is under way");
    await until(() => jumps.held() === 1, "the jump asks the frame");
    Assert.equal(gBrowser.selectedTab, tabs[0], "the match's tab is selected");
    Assert.deepEqual(state().grep, { busy: true }, "the frame has not answered yet");
    jumps.release();
    await until(() => state().grep === null, "the jump has drawn");
    const drawn = await SpecialPowers.spawn(tabs[0].linkedBrowser, [], () => {
      const sel = content.getSelection();
      const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return {
        text: sel?.toString(),
        inView: !!rect && rect.top >= 0 && rect.bottom <= content.innerHeight,
      };
    });
    Assert.deepEqual(drawn, { text: "credit", inView: true }, "the match is selected, in view");

    // A frame that has gone answers nothing: the jump has nothing more to draw either.
    await grepCredit();
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.deepEqual(state().grep, { busy: true }, "the next jump is under way");
    await until(() => jumps.held() === 1, "it asks the frame");
    jumps.release(null);
    await until(() => state().grep === null, "a jump that failed is not under way");
  } finally {
    jumps.restore();
  }

  // A private window's jumps are its browsing: the socket never hears of them.
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const loaded = BrowserTestUtils.browserLoaded(priv.gBrowser.selectedBrowser);
  BrowserTestUtils.startLoadingURIString(
    priv.gBrowser.selectedBrowser,
    `${PAGE}?${new URLSearchParams({ title: "private", t: "credit private" })}`,
  );
  await loaded;
  const privJumps = holdJumps(priv);
  try {
    await grepCredit(priv);
    EventUtils.synthesizeKey("KEY_Enter", {}, priv);
    await until(() => privJumps.held() === 1, "the private window's jump asks its frame");
    const hidden = state();
    Assert.strictEqual(hidden.private, true, "sanity: state reads the private window");
    Assert.strictEqual(hidden.grep, null, "a private window's jump stays out of state");
    privJumps.release();
  } finally {
    privJumps.restore();
  }
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  for (const tab of tabs) BrowserTestUtils.removeTab(tab);
});

/**
 * The pages pdf.js shows in its view, and whether each has finished drawing, from the
 * viewer's own DOM.
 * @param {XULBrowserElement} browser
 */
function pagesInView(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const view = content.document.getElementById("viewerContainer")?.getBoundingClientRect();
    if (!view) return [];
    return [...content.document.querySelectorAll("#viewer .page")]
      .filter((div) => {
        const r = div.getBoundingClientRect();
        return r.bottom > view.top && r.top < view.bottom && r.right > view.left;
      })
      .map((div) => ({
        page: Number(div.getAttribute("data-page-number")),
        drawn: div.hasAttribute("data-loaded") && !div.classList.contains("loadingIcon"),
      }));
  });
}

// `state.pdf` says whether the selected tab's PDF viewer has drawn every page in view as the tab
// shows it now: not after an operation Vimma sent it until the viewer has reported since, nor
// after the tab was resized until a report at its new size.
add_task(async function test_state_reports_the_pdf_viewer_as_drawn() {
  // The outline beside the document would resize it at a time of its own.
  await SpecialPowers.pushPrefEnv({ set: [[PDF_OUTLINE_PREF, true]] });
  Assert.strictEqual(state().pdf, null, "a web page: null");
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  // The <browser> element, whose own width the test narrows (a XUL element: it has a style).
  const box = /** @type {ElementCSSInlineStyle} */ (/** @type {unknown} */ (browser));
  try {
    BrowserTestUtils.startLoadingURIString(browser, PDF);
    await until(() => state().pdf?.drawn === true, "the first page is drawn");
    for (const page of await pagesInView(browser)) {
      Assert.ok(page.drawn, `page ${page.page}, in view, has finished drawing`);
    }

    // An operation: the view is not drawn for it until the viewer has reported since.
    Assert.ok(PdfOps.run(browser, "last", 0), "G goes to the last page");
    Assert.deepEqual(state().pdf, { drawn: false }, "read at once: the last page is to come");
    await until(() => state().pdf?.drawn === true, "the last page is drawn");
    const last = await pagesInView(browser);
    Assert.ok(
      last.some((p) => p.page === 6),
      "the last page is in view",
    );
    Assert.ok(
      last.every((p) => p.drawn),
      "every page in view has finished drawing",
    );

    // The tab narrows (as when the outline opens beside it): the viewer draws again at the new
    // width, and a report from before says nothing of that.
    box.style.maxWidth = "520px";
    Assert.deepEqual(state().pdf, { drawn: false }, "resized: the new width is to come");
    await until(() => state().pdf?.drawn === true, "drawn at the new width");
    Assert.ok(
      (await pagesInView(browser)).every((p) => p.drawn),
      "every page in view has finished drawing at the new width",
    );
    box.style.maxWidth = "";
    Assert.deepEqual(state().pdf, { drawn: false }, "wide again: to come again");
    await until(() => state().pdf?.drawn === true, "drawn at the full width");

    BrowserTestUtils.startLoadingURIString(browser, "https://example.com/");
    await BrowserTestUtils.browserLoaded(browser);
    Assert.strictEqual(state().pdf, null, "a web page again: null");
  } finally {
    box.style.maxWidth = "";
    BrowserTestUtils.removeTab(tab);
  }

  // A private window's documents are its browsing: the socket never hears of them.
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const privBrowser = priv.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(privBrowser, PDF);
  await until(() => !!PdfOps.state(privBrowser)?.drawn, "the private window's PDF is drawn");
  const hidden = state();
  Assert.strictEqual(hidden.private, true, "sanity: state reads the private window");
  Assert.strictEqual(hidden.pdf, null, "a private window's PDF stays out of state");
  await BrowserTestUtils.closeWindow(priv);
  await SimpleTest.promiseFocus(window);
  await SpecialPowers.popPrefEnv();
});

// The downloads picker opens only once its rows are read, and draws them as it opens: `mode:
// "help"` is the e2e scenarios' wait for its rows, with `downloads: null` for the `↓` segment
// that opening it clears.
add_task(async function test_the_downloads_picker_opens_with_its_rows() {
  const s = /** @type {any} */ (VimmaHost._state(window));
  const open = s.downloadRows.open;
  /** @type {PromiseWithResolvers<object[]>} */
  const rows = Promise.withResolvers();
  s.downloadRows.open = () => rows.promise;
  try {
    await focusContent(gBrowser.selectedBrowser);
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("d", {});
    await TestUtils.waitForTick();
    Assert.notEqual(state().mode, "help", "its rows not read yet: the picker is not open");
    rows.resolve([
      {
        kind: "download",
        downloadId: "1",
        display: "report.txt",
        state: "done",
        detail: "48 B",
        host: "example.com",
        ended: "12:00",
        workspace: null,
        agent: false,
        section: "recent",
        active: false,
      },
    ]);
    await until(() => state().mode === "help", "the picker opens");
    const picker = /** @type {Element} */ (document.getElementById("vimma-downloads-picker"));
    Assert.ok(picker.textContent?.includes("report.txt"), "open in help mode: its row is drawn");
    Assert.strictEqual(state().downloads, null, "no `↓` segment");
  } finally {
    s.downloadRows.open = open;
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => state().mode !== "help", "Esc closes it");
  }
});
