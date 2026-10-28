/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/live-grep.md. ctrl+b f g searches the text of the workspace's tabs as you
// type, lists each match with its tab and line, best next to the prompt at the bottom, beside a
// preview; Enter selects the tab, selects the match and scrolls it to the middle; ]q and [q step
// the results afterwards.

"use strict";

/* global focusContent -- from head.js */
/* global docShell -- in SpecialPowers.spawn's content task scope */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
);
const { GrepMatcher } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/grep-matcher.mjs",
);

const DIR = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "");
const PAGE = `https://example.com${DIR}file_vimma_grep.html`;
const OTHER_SITE = `https://example.org${DIR}file_vimma_grep.html`;
/** The iframe the fixture adds with `frame`: its fixed page on the other site. */
const FRAME_URL = `${OTHER_SITE}?t=${encodeURIComponent("needle in frame")}`;
const GREP_ID = "vimma-grep";
const NOTICE_ID = "vimma-notice";
const OTHER_WS = "grepother";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const ww = () => WindowWorkspaces.get(window);

/** @param {Window} [win] */
const dialog = (win = window) => win.document.getElementById(GREP_ID);
/** @param {Window} [win] */
const isOpen = (win = window) => !!dialog(win)?.open;
/** The result rows, best first (the DOM lists them best first; CSS shows them bottom up). */
/** @param {Window} [win] */
const rows = (win = window) => [...(dialog(win)?.querySelectorAll("[role=option]") ?? [])];
const textOf = (/** @type {Element} */ row) =>
  row.querySelector(".vimma-grep-text")?.textContent ?? "";
/** @param {Window} [win] */
const texts = (win = window) => rows(win).map(textOf);
const selectedRow = () => dialog()?.querySelector("[role=option][aria-selected=true]");
const countText = () => dialog()?.querySelector(".vimma-grep-count")?.textContent ?? "";
const flagsText = () => dialog()?.querySelector(".vimma-grep-flags")?.textContent ?? "";
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
/** The scope box: its title (on its border) and its lines, one per window. */
/** @param {Window} [win] */
const scopeTitle = (win = window) =>
  dialog(win)?.querySelector(".vimma-grep-scope .vimma-grep-title")?.textContent ?? "";
/** @param {Window} [win] */
const scopeLines = (win = window) =>
  [...(dialog(win)?.querySelectorAll(".vimma-grep-scope-line") ?? [])].map((l) => l.textContent);
/** A closed row's title: its text before the URL. */
const closedTitle = (/** @type {Element} */ row) => {
  const text = row.querySelector(".vimma-grep-text");
  const all = text?.textContent ?? "";
  const url = text?.querySelector(".vimma-grep-url")?.textContent;
  return url === undefined ? all : all.slice(0, all.length - url.length - 1);
};

/**
 * Closes a fixture tab of this window with that title, kept by SessionStore.
 * @param {string} title
 */
async function closeTitled(title) {
  const tab = await openFixture({ title, t: "no match in the text" });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
}

/**
 * Opens a normal window on a fixture with that title and closes it, kept by SessionStore.
 * @param {string} title
 */
async function closeWindowTitled(title) {
  const newest = () => SessionStore.getClosedWindowData()[0]?.closedId;
  const before = newest();
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=${encodeURIComponent(title)}`;
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(win.gBrowser.selectedBrowser, false, url);
  await until(() => win.gBrowser.selectedBrowser.contentTitle === title, "titled");
  await TabStateFlusher.flush(win.gBrowser.selectedBrowser);
  await BrowserTestUtils.closeWindow(win);
  await until(() => newest() !== before, "kept as closed");
  await SimpleTest.promiseFocus(window);
}

/** @param {Window} win @param {number} n */
function ctrlS(win = window, n = 1) {
  for (let i = 0; i < n; i++) EventUtils.synthesizeKey("s", { ctrlKey: true }, win);
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * A fixture tab in the current workspace, loaded, with its frames.
 * @param {Record<string, string | number>} params
 * @param {string} [base]
 */
async function openFixture(params, base = PAGE) {
  const url = `${base}?${new URLSearchParams(/** @type {any} */ (params))}`;
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  if (params.frame) {
    await until(
      () =>
        tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec ===
        FRAME_URL,
      "the frame loaded",
    );
  }
  if (params.title) await until(() => tab.linkedBrowser.contentTitle === params.title, "titled");
  return tab;
}

/** Back to one tab in `main`, the picker closed. */
async function reset() {
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape");
  while (PaneViews.get(window)?.panes) PaneViews.get(window).close();
  ww().switchTo({ id: def("main").id });
  for (const tab of gBrowser.tabs.slice(1)) {
    if (tab !== gBrowser.selectedTab) gBrowser.removeTab(tab);
  }
  if (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
}

registerCleanupFunction(async () => {
  await reset();
  const other = def(OTHER_WS);
  if (other) await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
});

/** ctrl+b f g from the selected page; waits for the dialog. */
async function openGrep(win = window) {
  const browser = win.gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  if (win === window) await focusContent(browser);
  else await SimpleTest.promiseFocus(browser);
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey("f", {}, win);
  EventUtils.synthesizeKey("g", {}, win);
  await until(() => isOpen(win), "ctrl+b f g opens live grep");
}

/** @param {string} text @param {Window} [win] */
function type(text, win = window) {
  for (const ch of text) EventUtils.synthesizeKey(ch, {}, win);
}

/** Clears the query word by word (ctrl+u scrolls the preview while it is shown). */
function clearQuery() {
  for (let i = 0; i < 6; i++) EventUtils.synthesizeKey("w", { ctrlKey: true });
}

/** Waits until the list shows `n` rows and the search has settled. */
async function resultsSettle(n, win = window) {
  await until(() => rows(win).length === n && !dialog(win)?.hasAttribute("busy"), `${n} rows`);
}

add_task(async function setup_a_second_workspace() {
  await ww().ready;
  if (!def(OTHER_WS)) WorkspaceStore.newWorkspace(OTHER_WS);
  await until(() => !!ww().model.workspaces.find((w) => w.name === OTHER_WS), "grepother");
  ww().switchTo({ id: def("main").id });
});

add_task(async function lists_matches_in_tab_order_best_at_the_prompt_and_cycles_scope() {
  await reset();
  ww().switchTo({ id: def(OTHER_WS).id });
  await openFixture({ title: "Delta", t: "delta needle" });
  ww().switchTo({ id: def("main").id });
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle" });
  await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);

  await openGrep();
  Assert.equal(VimmaHost.status(window).mode, "help", "a modal picker owns the keys");
  const prompt = dialog().querySelector(".vimma-grep-prompt");
  const results = dialog().querySelector(".vimma-grep-results");
  type("needle");
  await resultsSettle(4);
  Assert.deepEqual(
    texts(),
    ["alpha needle", "bravo needle", "bravo second needle", "charlie needle"],
    "the workspace's matches, in tab order, best first",
  );
  Assert.equal(selectedRow(), rows()[0], "the best result is selected");
  Assert.ok(selectedRow().classList.contains("vimma-grep-selected"), "and marked");
  Assert.equal(selectedRow().querySelector("mark")?.textContent, "needle", "match highlighted");
  Assert.ok(
    rows()[0].getBoundingClientRect().top > rows()[3].getBoundingClientRect().top,
    "the best result is at the bottom of the list",
  );
  Assert.ok(
    prompt.getBoundingClientRect().top >= results.getBoundingClientRect().bottom - 1,
    "the prompt is below the results",
  );
  Assert.ok(rows()[0].querySelector(".vimma-grep-tab").textContent.includes("Alpha"), "its tab");
  Assert.equal(rows()[2].querySelector(".vimma-grep-line").textContent, ":2:", "its line");
  Assert.equal(countText(), "4 / 4", "the count");
  Assert.equal(dialog().querySelector(".vimma-grep-query").textContent, "needle", "the query");

  Assert.equal(scopeTitle(), "Scope: this workspace · ctrl+s", "the scope box names the scope");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(5);
  Assert.equal(texts().at(-1), "delta needle", "window scope adds the other workspace, after");
  Assert.equal(scopeTitle(), "Scope: this window · ctrl+s", "the scope box names the scope");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(5);
  Assert.equal(scopeTitle(), "Scope: all windows · ctrl+s", "all windows: this one alone here");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await until(() => scopeTitle() === "Scope: all windows + closed · ctrl+s", "and closed");
  await until(() => !dialog().hasAttribute("busy"), "settled");

  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(4);
  Assert.equal(scopeTitle(), "Scope: this workspace · ctrl+s", "back to the workspace");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(isOpen(), "the first Esc goes to browse mode");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "the second closes");
});

add_task(async function enter_selects_the_tab_and_the_match_in_the_middle_in_normal_mode() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const b = await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle", pad: 200 });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(3);
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("p", { ctrlKey: true });
  Assert.equal(textOf(selectedRow()), "bravo second needle", "up moves away from the best");
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "Enter closes the picker");
  await until(() => gBrowser.selectedTab === b, "and selects the tab");
  const where = await SpecialPowers.spawn(b.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle",
      "the match is selected",
    );
    const sel = content.getSelection();
    const middle = () => {
      const { top } = sel.getRangeAt(0).getBoundingClientRect();
      return top > content.innerHeight / 3 && top < (content.innerHeight * 2) / 3;
    };
    // Smooth scrolling takes a few frames to get there.
    await ContentTaskUtils.waitForCondition(middle, "scrolled to the middle").catch(() => {});
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const controller = docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
    return {
      line: sel.anchorNode.textContent,
      attention: controller.getDisplaySelection() === Ci.nsISelectionController.SELECTION_ATTENTION,
      top: r.top,
      height: content.innerHeight,
    };
  });
  Assert.equal(where.line, "bravo second needle", "in the chosen line");
  Assert.ok(where.attention, "shown as find shows its match");
  Assert.greater(where.top, where.height / 3, "in the middle third of the view");
  Assert.less(where.top, (where.height * 2) / 3, "in the middle third of the view");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  Assert.equal(document.activeElement, b.linkedBrowser, "the page has focus");

  EventUtils.synthesizeKey("v");
  await until(() => VimmaHost.status(window).mode === "visual", "v enters copy mode");
  const kept = await SpecialPowers.spawn(b.linkedBrowser, [], () =>
    content.getSelection().toString(),
  );
  Assert.equal(kept, "needle", "with the match selected");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "back to normal");
});

add_task(async function the_grep_list_steps_with_bracket_q_and_grep_resumes() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const b = await openFixture({ title: "Bravo", t: "bravo needle|bravo second needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(4);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  type("]q");
  await until(() => gBrowser.selectedTab === b, "]q goes to the next result, in Bravo");
  Assert.equal(noticeText(), "grep 2/4", "the notice says where in the list");
  await focusContent(b.linkedBrowser);
  type("]q");
  await until(() => noticeText() === "grep 3/4", "the next one, in the same tab");
  const second = await SpecialPowers.spawn(b.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().anchorNode?.textContent === "bravo second needle",
      "the second line's match",
    );
    return content.getSelection().toString();
  });
  Assert.equal(second, "needle", "the match is selected");
  type("]q");
  await until(() => gBrowser.selectedTab === c, "then Charlie");
  await focusContent(c.linkedBrowser);
  type("]q");
  await until(() => gBrowser.selectedTab === a, "]q wraps to the first");
  await focusContent(a.linkedBrowser);
  type("[q");
  await until(() => gBrowser.selectedTab === c, "[q wraps back to the last");

  const closed = b.linkedPanel;
  BrowserTestUtils.removeTab(b);
  Assert.ok(
    VimmaHost._grep(window).list.rows.every((r) => r.tabId !== closed),
    "a closed tab's lines leave the grep list",
  );
  await focusContent(c.linkedBrowser);
  type("[q");
  await until(() => gBrowser.selectedTab === a, "a closed tab's results are skipped");

  await focusContent(a.linkedBrowser);
  type(":grep");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => isOpen(), ":grep alone reopens live grep");
  Assert.equal(dialog().querySelector(".vimma-grep-query").textContent, "needle", "last query");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  type(":grep charlie");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => isOpen(), ":grep text opens with that query");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["charlie needle"], "and searches it");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_cross_site_frame_and_shadow_roots_are_searched() {
  await reset();
  const tab = await openFixture({ title: "Framed", t: "top", frame: 1, shadow: 1 });
  await openGrep();
  type("needle in");
  await resultsSettle(3);
  Assert.deepEqual(
    texts(),
    ["needle in open shadow", "needle in closed shadow", "needle in frame"],
    "open and closed shadow roots, then the frame",
  );
  const frameRow = rows()[2];
  Assert.equal(
    frameRow.querySelector(".vimma-grep-frame")?.textContent,
    "↳ example.org",
    "a frame from another site names its host",
  );
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const frame = tab.linkedBrowser.browsingContext.children[0];
  const inFrame = await SpecialPowers.spawn(frame, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle in",
      "the frame's match is selected",
    );
    return content.document.hasFocus();
  });
  Assert.ok(inFrame, "and the frame has focus");

  await focusContent(tab.linkedBrowser);
  await openGrep();
  type("closed shadow");
  await resultsSettle(1);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped into the closed shadow root");
  const inShadow = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().rangeCount > 0,
      "a selection",
    );
    const range = content.getSelection().getRangeAt(0);
    return range.startContainer.textContent.slice(range.startOffset, range.endOffset);
  });
  Assert.equal(inShadow, "closed shadow", "the match in the closed shadow root is selected");
});

add_task(async function smart_case_regular_expressions_and_the_literal_fallback() {
  await reset();
  await openFixture({ title: "Case", t: "Needle upper|needle lower|neeedle long|in c++(x) code" });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  Assert.deepEqual(texts(), ["Needle upper", "needle lower"], "lower case ignores case");
  clearQuery();
  type("Needle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["Needle upper"], "a capital matches case");
  clearQuery();
  type("nee+dle");
  await resultsSettle(3);
  Assert.ok(!flagsText().includes("literal"), "a regular expression");
  clearQuery();
  type("c++(");
  await resultsSettle(1);
  Assert.ok(flagsText().includes("literal"), "an invalid one is literal, and says so");
  Assert.deepEqual(texts(), ["in c++(x) code"], "and finds the literal text");
  Assert.equal(rows()[0].querySelector("mark")?.textContent, "c++(", "the literal is marked");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_lazy_tab_is_listed_not_loaded_and_enter_selects_it() {
  await reset();
  const here = await openFixture({ title: "Loaded", t: "loaded needle" });
  const lazy = gBrowser.addTrustedTab(`${PAGE}?t=needle`, {
    createLazyBrowser: true,
    lazyTabTitle: "Lazy one",
    userContextId: here.userContextId,
  });
  await until(() => !lazy.linkedPanel, "a lazy tab");
  Assert.equal(gBrowser.selectedTab, here, "sanity: the loaded tab is selected");
  await openGrep();
  type("needle");
  await resultsSettle(2);
  const last = rows().at(-1);
  Assert.ok(textOf(last).includes("not loaded"), "listed as not loaded, at the far end");
  Assert.ok(last.querySelector(".vimma-grep-tab").textContent.includes("Lazy one"), "by title");
  Assert.ok(!lazy.linkedPanel, "the search did not load it");
  EventUtils.synthesizeKey("KEY_Escape");
  type("gg");
  Assert.equal(selectedRow()?.id, rows().at(-1).id, "gg goes to the top");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === lazy, "Enter selects it");
});

add_task(async function a_changed_page_takes_the_remaining_match_or_says_it_is_gone() {
  await reset();
  const tab = await openFixture({ title: "Changing", t: "first needle|second needle" });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("p").remove();
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const line = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().toString() === "needle",
      "a match is selected",
    );
    return content.getSelection().anchorNode.textContent;
  });
  Assert.equal(line, "second needle", "the remaining match");

  await openGrep();
  type("second");
  await resultsSettle(1);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("p").textContent = "gone";
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === "match no longer on the page", "the notice says so");
});

add_task(async function enter_on_a_tab_in_a_split_focuses_its_pane() {
  await reset();
  const a = await openFixture({ title: "Left", t: "left text" });
  const b = await openFixture({ title: "Right", t: "right needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  const view = PaneViews.get(window);
  Assert.ok(view.split("vertical", { tab: b }).ok, "split a | b");
  view.focus("left");
  await until(() => gBrowser.selectedTab === a, "the left pane has focus");
  await openGrep();
  type("right needle");
  await resultsSettle(1);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === b, "the right tab is selected");
  const focused = leaves(view.panes).find((l) => l.pane === view.panes.focus)?.tab;
  Assert.equal(focused, b.linkedPanel, "and its pane has focus");
  view.close();
});

add_task(async function the_preview_shows_the_lines_around_and_hides_when_narrow() {
  await reset();
  const lines = Array.from({ length: 30 }, (_, i) => (i === 14 ? "the needle line" : `line ${i}`));
  await openFixture({ title: "Preview", t: lines.join("|") });
  await openGrep();
  type("needle");
  await resultsSettle(1);
  const preview = dialog().querySelector(".vimma-grep-preview");
  Assert.equal(preview.getAttribute("role"), "region", "the preview is a region");
  Assert.equal(preview.getAttribute("aria-label"), "Grep Preview", "named Grep Preview");
  await until(
    () => preview.querySelector(".vimma-grep-preview-match")?.textContent === "the needle line",
    "the matched line is highlighted",
  );
  const shown = [...preview.querySelectorAll(".vimma-grep-preview-line")].map((l) => l.textContent);
  Assert.equal(shown.length, 21, "ten lines before and after");
  Assert.equal(shown[0], "line 4", "starting ten lines above");
  Assert.equal(
    preview.querySelector(".vimma-grep-preview-match mark")?.textContent,
    "needle",
    "with the match marked",
  );
  Assert.ok(BrowserTestUtils.isVisible(preview), "shown in a wide window");

  dialog().style.width = "800px";
  await until(() => !BrowserTestUtils.isVisible(preview), "hidden below 900 pixels");
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  await until(
    () => dialog().querySelector(".vimma-grep-query").textContent === "",
    "ctrl+u clears",
  );
  dialog().style.width = "";
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_jump_that_ends_after_grep_reopens_keeps_the_new_search_frames() {
  await reset();
  await openFixture({ title: "Other", t: "second line" });
  await openFixture({ title: "Jump", t: "first needle" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const { ask, preview: show } = session;
  /** @type {(() => void)[]} */
  const held = [];
  let jumped = false;
  // The jump's frame answers only after grep is open again on the other tab's results, and
  // that search's preview waits for the jump to end: the order a slow content process gives.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[2] !== "Vimma:GrepJump") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply.finally(() => (jumped = true)))));
  };
  type("needle");
  await resultsSettle(1);
  session.preview = async (/** @type {any} */ row) => {
    await TestUtils.waitForCondition(() => jumped, "the jump ends", 10, 500);
    await new Promise((r) => setTimeout(r, 0));
    return show.call(session, row);
  };
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => held.length > 0, "the jump is asked");
  session.ask = ask;
  await openGrep();
  type("second");
  await resultsSettle(1);
  for (const release of held) release();
  const preview = dialog().querySelector(".vimma-grep-preview");
  await until(
    () => preview.querySelector(".vimma-grep-preview-match")?.textContent === "second line",
    "the reopened grep's match is previewed",
  );
  session.preview = show;
  EventUtils.synthesizeKey("KEY_Escape");
});

// #419: on a slow machine a step's jump ended after grep was open again, and the step's GrepEnd
// then stopped that search's query in the frame, which listed nothing.
add_task(async function a_step_that_ends_after_grep_reopens_leaves_the_new_search_alone() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  const session = VimmaHost._grep(window);
  const { ask } = session;
  /** @type {(() => void)[]} */
  const held = [];
  let jumped = false;
  /** @type {Promise<unknown>[]} */
  const endedWhileOpen = [];
  // Charlie's frame answers the step's jump only once grep is open again: the order a slow
  // content process gives.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[2] === "Vimma:GrepEnd" && session.isOpen) endedWhileOpen.push(reply);
    if (args[2] !== "Vimma:GrepJump") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply.finally(() => (jumped = true)))));
  };
  try {
    type("]q");
    await until(() => held.length > 0, "the step asks Charlie's frame to select its match");
    await focusContent(c.linkedBrowser);
    type(":grep charlie");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => isOpen(), ":grep text opens with that query");
    await resultsSettle(1);
    for (const release of held) release();
    await until(() => jumped, "the step's jump ends");
    // What the step sends after its jump has been sent, and answered, by the next task.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all(endedWhileOpen);
    Assert.equal(endedWhileOpen.length, 0, "no frame is told to end while a search is open");
    const frames = await SpecialPowers.spawn(c.linkedBrowser, [], () => {
      const { GrepMatcher } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/actors/grep-matcher.mjs",
      );
      return GrepMatcher.frames.length;
    });
    Assert.equal(frames, 1, "the open search's text stays in Charlie's process");
    Assert.deepEqual(texts(), ["charlie needle"], "and its row stays listed");
  } finally {
    session.ask = ask;
  }
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});

// #419: a step's jump waits for its tab switch (TabSwitchDone, at most 1 second), 300 to 400 ms
// on the macOS runner; grep opened meanwhile must keep its frame and the keyboard. Holding
// TabSwitchDone makes the jump wait the full second.
add_task(async function a_step_whose_tab_switch_ends_after_grep_reopens_stops_there() {
  await reset();
  const a = await openFixture({ title: "Alpha", t: "alpha needle" });
  const c = await openFixture({ title: "Charlie", t: "charlie needle" });
  await BrowserTestUtils.switchTab(gBrowser, a);
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the first result");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  await focusContent(a.linkedBrowser);

  const session = VimmaHost._grep(window);
  const { ask, jump } = session;
  /** @type {string[]} */
  const sentWhileOpen = [];
  let jumped = false;
  session.ask = (/** @type {any[]} */ ...args) => {
    const name = args[2];
    if (session.isOpen && /^Vimma:Grep(Jump|End)$/.test(name)) sentWhileOpen.push(name);
    return ask.apply(session, args);
  };
  session.jump = async (/** @type {any[]} */ ...args) => {
    try {
      return await jump.apply(session, args);
    } finally {
      jumped = true;
    }
  };
  const hold = (/** @type {Event} */ e) => e.stopPropagation();
  window.addEventListener("TabSwitchDone", hold, true);
  try {
    type("]q");
    await until(() => gBrowser.selectedTab === c, "]q selects Charlie");
    await focusContent(c.linkedBrowser);
    type(":grep charlie");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => isOpen(), ":grep text opens with that query");
    await resultsSettle(1);
    await until(() => jumped, "the step's jump stops waiting for the tab switch");
    await new Promise((r) => setTimeout(r, 0));
    Assert.deepEqual(sentWhileOpen, [], "it asks the frame nothing while the search is open");
    Assert.ok(dialog().contains(document.activeElement), "and the keyboard stays in grep");
    const frames = await SpecialPowers.spawn(c.linkedBrowser, [], () => {
      const { GrepMatcher } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/actors/grep-matcher.mjs",
      );
      return GrepMatcher.frames.length;
    });
    Assert.equal(frames, 1, "the open search's text stays in Charlie's process");
  } finally {
    window.removeEventListener("TabSwitchDone", hold, true);
    session.ask = ask;
    session.jump = jump;
  }
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});

add_task(async function replies_to_an_older_query_never_replace_newer_results() {
  await reset();
  await openFixture({ title: "Gen", t: "older match|newer match" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  /** @type {(() => void)[]} */
  const held = [];
  // The first query's frames answer only after the second query's.
  session.ask = (/** @type {any[]} */ ...args) => {
    const reply = ask.apply(session, args);
    if (args[1]?.query !== "older") return reply;
    return new Promise((resolve) => held.push(() => resolve(reply)));
  };
  type("older");
  await until(() => held.length > 0, "the first query is asked");
  clearQuery();
  type("newer");
  await resultsSettle(1);
  for (const release of held) release();
  await new Promise((r) => setTimeout(r, 300));
  Assert.deepEqual(texts(), ["newer match"], "the older query's late replies are dropped");
  session.ask = ask;
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_long_tab_title_is_cut_to_300_characters() {
  await reset();
  const title = `${"t".repeat(400)} end`;
  await openFixture({ title, t: "longtitleneedle" });
  await openGrep();
  type("longtitleneedle");
  await resultsSettle(1);
  const row = VimmaHost._grep(window).state.rows[0];
  Assert.equal(row.title, title.slice(0, 300), "the row holds the first 300 characters");
  Assert.ok(
    rows()[0].getAttribute("aria-label").length < 400,
    "and the option's name is bounded by it",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function results_name_their_tab_and_the_count_is_announced() {
  await reset();
  await openFixture({ title: "Spoken", t: "retry budget is 3" });
  await openGrep();
  const status = dialog().querySelector("[role=status]");
  Assert.equal(status?.getAttribute("aria-live"), "polite", "a polite live region");
  type("zzzz");
  await until(() => status.textContent === "no matches", "no matches is announced");
  clearQuery();
  type("retry");
  await resultsSettle(1);
  await until(() => status.textContent === "1 match in 1 tab", "the count is announced");
  Assert.equal(
    rows()[0].getAttribute("aria-label"),
    "retry budget is 3, Spoken, example.com, main",
    "the option names the line, its tab, its host and its workspace",
  );
  const list = dialog().querySelector("[role=listbox]");
  Assert.equal(list.getAttribute("aria-activedescendant"), rows()[0].id, "the active option");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function private_tabs_never_reach_a_normal_window_and_back() {
  await reset();
  await openFixture({ title: "Normal", t: "normal secretneedle" });
  // Normal closed entries that match: the private window must list none of them.
  await closeTitled("Normal gone secretneedle");
  await closeWindowTitled("Normal window secretneedle");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const url = `${PAGE}?t=${encodeURIComponent("private secretneedle")}`;
  BrowserTestUtils.startLoadingURIString(priv.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(priv.gBrowser.selectedBrowser, false, url);

  // A private tab closed in the private window: SessionStore keeps it for that window only.
  const closing = BrowserTestUtils.addTab(
    priv.gBrowser,
    `${PAGE}?title=${encodeURIComponent("private closed secretneedle")}`,
  );
  await BrowserTestUtils.browserLoaded(closing.linkedBrowser);
  await until(() => closing.linkedBrowser.contentTitle === "private closed secretneedle", "titled");
  await TabStateFlusher.flush(closing.linkedBrowser);
  BrowserTestUtils.removeTab(closing);
  await until(() => SessionStore.getClosedTabCountForWindow(priv) > 0, "kept as closed");

  await openGrep(priv);
  type("secretneedle", priv);
  await resultsSettle(1, priv);
  Assert.deepEqual(texts(priv), ["private secretneedle"], "the private window: its tabs only");
  ctrlS(priv, 2);
  await until(() => scopeTitle(priv).includes("all windows"), "all windows");
  await resultsSettle(1, priv);
  Assert.deepEqual(texts(priv), ["private secretneedle"], "all windows: the private ones only");
  ctrlS(priv);
  await until(() => scopeTitle(priv).includes("closed"), "closed scope");
  await resultsSettle(2, priv);
  Assert.deepEqual(
    rows(priv).map((r) => [
      r.dataset.kind,
      r.dataset.kind === "closed" ? closedTitle(r) : textOf(r),
    ]),
    [
      ["match", "private secretneedle"],
      ["closed", "private closed secretneedle"],
    ],
    "the private window: its own open and closed tabs, no normal closed tab or window",
  );
  Assert.equal(
    scopeLines(priv).at(-1),
    "recently closed: 1 tab, 0 windows · titles and URLs only",
    "it counts only its own recently closed",
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("secretneedle");
  await resultsSettle(1);
  for (const scope of ["this window", "all windows"]) {
    EventUtils.synthesizeKey("s", { ctrlKey: true });
    await until(() => scopeTitle() === `Scope: ${scope} · ctrl+s`, scope);
    await resultsSettle(1);
    Assert.deepEqual(texts(), ["normal secretneedle"], `${scope}: never a private tab`);
    Assert.ok(!scopeLines().some((l) => l.startsWith("w2")), `${scope}: no private window`);
  }
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(3);
  Assert.deepEqual(
    rows().map((r) => (r.dataset.kind === "closed" ? closedTitle(r) : textOf(r))),
    ["normal secretneedle", "Normal gone secretneedle", "Normal window secretneedle"],
    "closed: the normal side only, never the private closed tab",
  );
  Assert.ok(!scopeLines().some((l) => l.startsWith("w2")), "closed: no private window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await BrowserTestUtils.closeWindow(priv);

  // Firefox keeps no closed private window; its tabs never reach recently closed here.
  await openGrep();
  type("secretneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(3);
  Assert.ok(
    rows().every((r) => !closedTitle(r).startsWith("private") && !textOf(r).startsWith("private")),
    "nothing private from a closed window",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function the_scope_box_lists_the_windows_and_tabs_searched() {
  await reset();
  ww().switchTo({ id: def(OTHER_WS).id });
  await openFixture({ title: "Delta", t: "delta scopeneedle" });
  ww().switchTo({ id: def("main").id });
  await openFixture({ title: "Alpha", t: "alpha scopeneedle" });
  await openGrep();
  const mainTabs = ww().model.workspaces.find((w) => w.name === "main").tabs.length;
  Assert.deepEqual(
    scopeLines(),
    [`w1 this window: main · ${mainTabs} tabs`],
    "the workspace, its window and its tabs, before anything is typed",
  );
  type("scopeneedle");
  await resultsSettle(1);
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(2);
  const [line] = scopeLines();
  Assert.ok(line.startsWith("w1 this window: main "), "this window's workspaces by name");
  Assert.ok(new RegExp(`${OTHER_WS} \\d+`).test(line), "with their tab counts");
  const scope = dialog().querySelector(".vimma-grep-scope");
  const results = dialog().querySelector(".vimma-grep-results");
  Assert.ok(
    scope.getBoundingClientRect().bottom <= results.getBoundingClientRect().top + 1,
    "the scope box sits above the results",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function rows_name_their_window_tab_and_host() {
  await reset();
  await openFixture({ title: "Hosted", t: "hostneedle here" });
  await openGrep();
  type("hostneedle");
  await resultsSettle(1);
  const row = rows()[0];
  Assert.equal(row.querySelector(".vimma-grep-win")?.textContent, "w1", "its window");
  Assert.ok(row.querySelector(".vimma-grep-tab").textContent.includes("Hosted"), "its tab");
  Assert.equal(row.querySelector(".vimma-grep-host")?.textContent, "example.com", "its host");
  const where = dialog().querySelector(".vimma-grep-preview .vimma-grep-title");
  await until(() => where.textContent.includes("Hosted"), "the preview names the result's tab");
  Assert.equal(where.textContent.split(" · ").at(-1), "example.com", "and its host, last");
  Assert.ok(where.textContent.includes("w1"), "and its window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function all_windows_searches_the_other_windows_and_enter_goes_there() {
  await reset();
  await openFixture({ title: "Here", t: "farneedle here" });
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=Far&t=${encodeURIComponent("farneedle over there")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  const farTab = other.gBrowser.selectedTab;

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("farneedle");
  await resultsSettle(1);
  ctrlS(window, 2);
  await until(() => scopeTitle() === "Scope: all windows · ctrl+s", "all windows");
  await resultsSettle(2);
  Assert.deepEqual(texts(), ["farneedle here", "farneedle over there"], "this window first");
  Assert.equal(rows()[1].querySelector(".vimma-grep-win").textContent, "w2", "marked w2");
  Assert.ok(
    scopeLines().some((l) => l.startsWith("w2: ")),
    "the scope box lists the window",
  );

  EventUtils.synthesizeKey("KEY_ArrowUp");
  const focused = BrowserTestUtils.waitForEvent(other, "focus");
  EventUtils.synthesizeKey("KEY_Enter");
  await focused;
  await until(() => Services.focus.activeWindow === other, "the other window comes to the front");
  Assert.equal(other.gBrowser.selectedTab, farTab, "its tab is selected");
  // One query at a time: a poll left in flight when the window closes rejects in the next task.
  let sel = "";
  for (let i = 0; i < 100 && sel !== "farneedle"; i++) {
    if (i) await new Promise((r) => setTimeout(r, 50));
    sel = await SpecialPowers.spawn(farTab.linkedBrowser, [], () => String(content.getSelection()));
  }
  Assert.equal(sel, "farneedle", "the match is selected there");
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
});

add_task(async function closed_tabs_and_windows_match_on_title_and_url_and_enter_reopens() {
  await reset();
  const tab = await openFixture({ title: "Zulu closedneedle", t: "the page text is gone" });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=${encodeURIComponent("Yankee closedneedle")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  await TabStateFlusher.flush(other.gBrowser.selectedBrowser);
  await BrowserTestUtils.closeWindow(other);
  await until(() => SessionStore.getClosedWindowCount() > 0, "the window is kept as closed");

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("closedneedle");
  await until(() => !dialog().hasAttribute("busy"), "settled");
  Assert.equal(rows().length, 0, "open tabs only, until the closed scope");
  type("|gone");
  await until(() => !dialog().hasAttribute("busy"), "settled");
  Assert.equal(rows().length, 0, "a closed tab's page text is not searched");
  for (let i = 0; i < 5; i++) EventUtils.synthesizeKey("KEY_Backspace");
  ctrlS(window, 3);
  await until(() => scopeTitle() === "Scope: all windows + closed · ctrl+s", "closed");
  await resultsSettle(2);
  Assert.deepEqual(
    rows().map((r) => r.dataset.kind),
    ["closed", "closed"],
    "the closed tab, then the closed window",
  );
  Assert.equal(countText(), "2 / 2", "closed rows count as matches");
  Assert.ok(textOf(rows()[0]).includes("Zulu closedneedle"), "matched on its title");
  Assert.equal(rows()[0].querySelector("mark")?.textContent, "closedneedle", "marked");
  Assert.equal(rows()[0].querySelector(".vimma-grep-tab").textContent, "closed", "labelled");
  Assert.equal(
    rows()[1].querySelector(".vimma-grep-tab").textContent,
    "closed window",
    "the window labelled",
  );
  Assert.ok(
    scopeLines().some((l) => l.startsWith("recently closed: ")),
    "the scope box says what recently closed holds",
  );
  const body = dialog().querySelector(".vimma-grep-preview-body");
  await until(() => body.textContent.includes("Recently closed tab"), "the closed preview");

  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  // SessionStore labels the tab from its saved state before the page loads; the restore then
  // replaces the browser's first document, and a SpecialPowers.spawn into that one (openGrep's
  // focus check) aborts. Wait for the restore itself, listened for before it can happen.
  const restored = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "SSTabRestored");
  EventUtils.synthesizeKey("KEY_Enter");
  const reopened = (await opened).target;
  Assert.equal((await restored).target, reopened, "the reopened tab is restored");
  await until(() => gBrowser.selectedTab === reopened, "Enter reopens it and goes there");
  await until(() => reopened.label === "Zulu closedneedle", "the closed tab is back");

  await openGrep();
  type("closedneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await until(
    () => rows().some((r) => r.dataset.kind === "closed"),
    "the closed window is still listed",
  );
  const winRow = rows().findIndex((r) => r.dataset.kind === "closed");
  for (let i = 0; i < winRow; i++) EventUtils.synthesizeKey("KEY_ArrowUp");
  const newWin = BrowserTestUtils.waitForNewWindow();
  EventUtils.synthesizeKey("KEY_Enter");
  const back = await newWin;
  Assert.ok(back, "Enter on a closed window reopens it");
  await BrowserTestUtils.closeWindow(back);
  await SimpleTest.promiseFocus(window);
});

add_task(async function a_catastrophic_pattern_on_closed_titles_never_freezes_the_browser() {
  await reset();
  const tab = await openFixture({ title: "a".repeat(30) });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("(a+)+b");
  const started = performance.now();
  await until(() => flagsText().includes("timed out"), "the closed titles' search timed out");
  Assert.less(performance.now() - started, 2500, "stopped within its budget, off the main thread");
  clearQuery();
  type("aaa");
  await until(
    () => rows().some((r) => r.dataset.kind === "closed"),
    "the next query runs in a new worker and finds the title",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function the_closed_titles_have_one_matcher_key_until_close() {
  await reset();
  await closeTitled("Keyed closedkeyneedle");
  const closedKeys = () => GrepMatcher.frames.filter((k) => k.startsWith("closed-"));
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("closedkey");
  await resultsSettle(1);
  Assert.equal(closedKeys().length, 1, "the closed titles are held under one key");
  type("needle");
  await resultsSettle(1);
  Assert.equal(closedKeys().length, 1, "a newer query replaces the older under the same key");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => closedKeys().length === 0, "closing the picker drops them");
});

add_task(async function enter_on_a_closed_row_already_gone_says_so() {
  await reset();
  await closeTitled("Stale staleneedle");
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("staleneedle");
  await resultsSettle(1);
  const closedId = Number(rows()[0].dataset.tabId.split(":")[1]);
  SessionStore.forgetClosedTabById(closedId);
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === "no longer in recently closed", "a notice says why");
  Assert.equal(gBrowser.tabs.length, tabs, "nothing reopened");
});

add_task(async function the_grep_list_drops_a_closed_windows_lines() {
  await reset();
  await openFixture({ title: "Here", t: "winclosedneedle here" });
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=There&t=${encodeURIComponent("winclosedneedle there")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("winclosedneedle");
  ctrlS(window, 2);
  await until(() => scopeTitle() === "Scope: all windows · ctrl+s", "all windows");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const session = VimmaHost._grep(window);
  Assert.equal(session.list.rows.length, 2, "the list reaches both windows");
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
  Assert.equal(session.list.rows.length, 1, "the closed window's lines are gone");
  Assert.equal(session.watched.size, 1, "and the closed window is no longer watched");
  await focusContent(gBrowser.selectedBrowser);
  type("]q");
  await until(() => noticeText() === "grep 1/1", "]q: one result left");
  Assert.equal(Services.focus.activeWindow, window, "and it stays in this window");
});

add_task(async function a_window_sessionstore_does_not_track_is_skipped() {
  await reset();
  await closeWindowTitled("Tracked trackneedle");
  const real = SessionStore.getClosedTabDataForWindow;
  SessionStore.getClosedTabDataForWindow = (/** @type {Window} */ w) => {
    if (w === window) throw new Error("Window is not tracked");
    return real.call(SessionStore, w);
  };
  try {
    await openGrep();
    type("trackneedle");
    ctrlS(window, 3);
    await until(() => scopeTitle().includes("closed"), "closed scope");
    await resultsSettle(1);
    Assert.equal(rows()[0].dataset.kind, "closed", "the closed window is still listed");
  } finally {
    SessionStore.getClosedTabDataForWindow = real;
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
  }
});

add_task(async function the_panel_starts_at_the_page_top_and_follows_the_toolbar() {
  await reset();
  const content = () => gBrowser.tabbox.getBoundingClientRect();
  await openGrep();
  const top = () => dialog().getBoundingClientRect().top;
  Assert.lessOrEqual(Math.abs(top() - content().top), 1, "the panel starts where the page does");
  Assert.lessOrEqual(dialog().getBoundingClientRect().bottom, content().bottom + 1, "and ends");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  const navBar = document.getElementById("nav-bar");
  navBar.setAttribute("collapsed", "true");
  try {
    await until(() => content().top < 10, "without the toolbar the page starts at the top");
    await openGrep();
    Assert.lessOrEqual(Math.abs(top() - content().top), 1, "the panel moves up with the page");
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
  } finally {
    navBar.removeAttribute("collapsed");
  }
});

add_task(async function agent_tabs_only_in_window_scope_marked_and_last() {
  await reset();
  const agent = WorkspaceStore.agent;
  Assert.ok(agent, "the profile has the agent workspace");
  const url = `${PAGE}?t=${encodeURIComponent("agentneedle from an agent")}`;
  const agentTab = gBrowser.addTab(url, {
    userContextId: agent.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(agentTab.linkedBrowser, false, url);
  await until(() => agentTab.hidden, "the agent tab is hidden in its workspace");
  await openFixture({ title: "Mine", t: "agentneedle of mine" });
  await openGrep();
  type("agentneedle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["agentneedle of mine"], "the workspace scope leaves agent tabs out");
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(2);
  Assert.equal(textOf(rows()[1]), "agentneedle from an agent", "window scope: the agent's, last");
  Assert.equal(
    rows()[1].querySelector(".vimma-grep-agent")?.textContent,
    "◇ agent",
    "marked as the agent's",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(agentTab);
});

add_task(async function page_text_with_markup_stays_text() {
  await reset();
  const line = 'needle <img src=x onerror="alert(1)"> <b>bold</b>';
  await openFixture({ title: "<i>Markup</i>", t: line });
  await openGrep();
  type("needle");
  await resultsSettle(1);
  Assert.equal(textOf(rows()[0]), line, "the line shows as text");
  Assert.ok(rows()[0].querySelector(".vimma-grep-tab").textContent.includes("<i>Markup</i>"));
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "no page markup in the picker");
  await until(
    () => !!dialog().querySelector(".vimma-grep-preview-match"),
    "the preview shows the line",
  );
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "nor in the preview");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  // Closed rows, their preview and the preview's title are text too (L3).
  const markup = '<img src=x onerror="alert(1)"><i>gone</i> markneedle';
  await closeTitled(markup);
  await closeWindowTitled(`<b>win</b> ${markup}`);
  await openGrep();
  type("markneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(2);
  Assert.equal(closedTitle(rows()[0]), markup, "a closed title shows as text");
  const body = dialog().querySelector(".vimma-grep-preview-body");
  await until(() => body.textContent.includes(markup), "the closed tab's preview");
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "no markup from a closed tab");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  await until(() => body.textContent.includes("Recently closed window"), "the window's preview");
  Assert.equal(dialog().querySelectorAll("img, b, i").length, 0, "nor from a closed window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function closing_tells_every_searched_frame_to_drop_its_text() {
  await reset();
  await openFixture({ title: "Ends", t: "needle top", frame: 1 });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  const asked = new Set();
  const ended = new Set();
  session.ask = (/** @type {any[]} */ ...args) => {
    const [bc, , name = "Vimma:Grep"] = args;
    if (name === "Vimma:Grep") asked.add(bc.id);
    if (name === "Vimma:GrepEnd") ended.add(bc.id);
    return ask.apply(session, args);
  };
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  session.ask = ask;
  Assert.greaterOrEqual(asked.size, 2, "the page and its frame were searched");
  Assert.ok(
    [...asked].every((id) => ended.has(id)),
    "each searched frame was told to drop its text",
  );
  Assert.equal(session.state, null, "the parent keeps no rows");
});

add_task(async function white_space_the_markup_wraps_matches_one_space() {
  await reset();
  const tab = await openFixture({ title: "Wrapped", t: "wrapped\n      across   lines needle" });
  await openGrep();
  type("wrapped across lines");
  await resultsSettle(1);
  Assert.equal(textOf(rows()[0]), "wrapped across lines needle", "shown as layout shows it");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const selected = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.getSelection().rangeCount > 0 && !content.getSelection().isCollapsed,
      "a selection",
    );
    const range = content.getSelection().getRangeAt(0);
    return range.startContainer.textContent.slice(range.startOffset, range.endOffset);
  });
  Assert.equal(selected, "wrapped\n      across   lines", "the selection covers the source text");
});

add_task(async function a_reply_held_past_close_still_gets_grep_end() {
  await reset();
  await openFixture({ title: "Slow", t: "needle slow" });
  await openGrep();
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  /** @type {(() => void)[]} */
  const held = [];
  const asked = new Set();
  const ended = new Set();
  session.ask = (/** @type {any[]} */ ...args) => {
    const [bc, , name = "Vimma:Grep"] = args;
    if (name === "Vimma:GrepEnd") ended.add(bc.id);
    const reply = ask.apply(session, args);
    if (name !== "Vimma:Grep") return reply;
    asked.add(bc.id);
    // Every frame answers only after the picker has closed.
    return new Promise((resolve) => held.push(() => resolve(reply)));
  };
  type("needle");
  await until(() => held.length >= 2, "the frames were asked");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed before any answer");
  for (const release of held) release();
  await new Promise((r) => setTimeout(r, 300));
  session.ask = ask;
  Assert.ok(
    [...asked].every((id) => ended.has(id)),
    "a frame that had not answered is told to drop its text too",
  );
});

add_task(async function frames_past_the_cap_are_not_searched() {
  await reset();
  const tab = await openFixture({ title: "Many frames", t: "top", frames: 150 });
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children.length === 150 &&
      tab.linkedBrowser.browsingContext.children.every((c) => c.currentWindowGlobal),
    "150 frames",
  );
  await openGrep();
  type("needle frame");
  await until(() => rows().length > 0 && !dialog().hasAttribute("busy"), "results");
  Assert.equal(rows().length, 99, "the page and 99 frames: 100 frames a tab");
  Assert.ok(flagsText().includes("cut"), "the prompt says the search was cut");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function a_jump_never_reaches_a_document_the_frame_navigated_to() {
  await reset();
  const tab = await openFixture({ title: "Moving", t: "needle top", frame: 1 });
  await openGrep();
  type("needle");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped to the top frame's match");
  const frame = tab.linkedBrowser.browsingContext.children[0];
  const before = frame.currentWindowGlobal;
  const next = `${OTHER_SITE}?t=${encodeURIComponent("needle in frame")}&v=2`;
  await SpecialPowers.spawn(tab.linkedBrowser, [next], (url) => {
    content.document.querySelector("iframe").src = url;
  });
  await until(
    () => frame.currentWindowGlobal && frame.currentWindowGlobal !== before,
    "the frame navigated",
  );
  await until(() => !frame.currentWindowGlobal.isInitialDocument, "and loaded");
  await focusContent(tab.linkedBrowser);
  type("]q");
  await until(() => noticeText() === "match no longer on the page", "the jump is refused");
  const selected = await SpecialPowers.spawn(frame, [], () => content.getSelection().toString());
  Assert.equal(selected, "", "nothing is selected in the new document");
});

add_task(async function an_over_long_query_says_so_and_is_not_sent() {
  await reset();
  await openFixture({ title: "Long query", t: "needle" });
  await focusContent(gBrowser.selectedBrowser);
  const session = VimmaHost._grep(window);
  const ask = session.ask;
  let sent = 0;
  session.ask = (/** @type {any[]} */ ...args) => {
    if ((args[2] ?? "Vimma:Grep") === "Vimma:Grep") sent++;
    return ask.apply(session, args);
  };
  session.open("x".repeat(1001));
  await until(() => flagsText().includes("too long"), "the prompt says the query is too long");
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(!flagsText().includes("timed out"), "not a time-out");
  Assert.equal(sent, 0, "no frame was asked");
  session.ask = ask;
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

/** The Vimma actor of `tab`'s top frame, after it dropped any earlier search. */
async function freshActor(tab) {
  const actor = tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor("Vimma");
  await actor.sendQuery("Vimma:GrepEnd", {});
  return actor;
}

/** A reply, or "no answer" after `ms`. */
function within(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("no answer"), ms))]);
}

add_task(async function a_frame_answers_timed_out_within_its_budget() {
  await reset();
  const tab = await openFixture({ title: "Budget", t: "needle here", long: 40 });
  const actor = await freshActor(tab);
  const t0 = performance.now();
  const reply = await within(actor.sendQuery("Vimma:Grep", { query: "(a+)+b", gen: 1 }), 5000);
  const ms = performance.now() - t0;
  Assert.equal(reply?.timedOut, true, "the frame itself says it timed out");
  Assert.less(ms, 1500, "within its 1-second budget, with no other query sent");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function a_frame_drops_an_older_query() {
  await reset();
  const tab = await openFixture({ title: "Older", t: "needle here" });
  const actor = await freshActor(tab);
  const newer = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 10 });
  Assert.equal(newer?.count, 1, "generation 10 is answered");
  const older = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 5 });
  Assert.equal(older, null, "generation 5, older than one it has seen, is dropped");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function grep_end_resets_the_frames_generation() {
  await reset();
  const tab = await openFixture({ title: "Reset", t: "needle here" });
  const actor = await freshActor(tab);
  Assert.equal((await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 10 }))?.count, 1);
  await actor.sendQuery("Vimma:GrepEnd", {});
  const next = await actor.sendQuery("Vimma:Grep", { query: "needle", gen: 1 });
  Assert.equal(next?.count, 1, "after GrepEnd a new session's first generation is answered");
  await actor.sendQuery("Vimma:GrepEnd", {});
});

add_task(async function one_worker_a_process_and_none_for_a_blank_frame() {
  await reset();
  const tab = await openFixture({ title: "Workers", t: "top", frames: 3, blank: 1 });
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children.length === 4 &&
      tab.linkedBrowser.browsingContext.children.every((c) => c.currentWindowGlobal),
    "4 frames",
  );
  await openGrep();
  type("needle frame");
  await resultsSettle(3);
  const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { GrepMatcher } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/actors/grep-matcher.mjs",
    );
    return { workers: GrepMatcher.workers, texts: GrepMatcher.frames.length };
  });
  Assert.equal(seen.workers, 1, "the page's frames share one worker in their process");
  Assert.equal(seen.texts, 4, "it holds the text of the page and its 3 frames, not the blank one");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  const after = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const { GrepMatcher } = ChromeUtils.importESModule(
      "chrome://browser/content/vimma/actors/grep-matcher.mjs",
    );
    await ContentTaskUtils.waitForCondition(() => GrepMatcher.workers === 0, "worker ended");
    return GrepMatcher.frames.length;
  });
  Assert.equal(after, 0, "closing the picker ends the worker and its texts");
});

// Last: before the fix, this pattern froze the page's process for good.
add_task(async function a_catastrophic_pattern_never_freezes_the_page() {
  await reset();
  const tab = await openFixture({ title: "Backtrack", t: "needle here", long: 40 });
  await openGrep();
  type("(a+)+b");
  await until(() => flagsText().includes("timed out"), "the search gives up in time");
  const answered = await Promise.race([
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title),
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  Assert.equal(answered, "Backtrack", "the page's process still answers");
  clearQuery();
  type("needle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["needle here"], "and the next query finds its match");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});
