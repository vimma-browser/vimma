/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-find.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_find.html";
/** A search box that holds the query (#164). */
const FIELD_PAGE = ROOT + "file_vimma_find_field.html";

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

/**
 * Opens the fixture with content focus in normal mode, recording the page's keydowns.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 * @param {string} [page]
 */
async function withPage(fn, page = PAGE) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(page, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the tab is in normal mode",
    );
    try {
      await fn(browser);
    } finally {
      gBrowser.getCachedFindBar()?.close(true);
    }
  });
}

/** Types `text`, a key per character, as fast as the harness can. */
function type(text) {
  for (const ch of text) EventUtils.synthesizeKey(ch);
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/**
 * Scrolls the page so `id`'s top sits `offset` px below the viewport top.
 * @param {XULBrowserElement} browser
 * @param {string} id
 * @param {number} offset
 */
function scrollToElement(browser, id, offset) {
  return SpecialPowers.spawn(browser, [id, offset], (eid, off) => {
    const el = content.document.getElementById(eid);
    content.scrollTo(0, el.getBoundingClientRect().top + content.scrollY - off);
    return content.scrollY;
  });
}

/**
 * The page's selection as `<id of its element>:<text>`, or "" when there is none.
 * @param {XULBrowserElement | BrowsingContext} target
 */
function selection(target) {
  return SpecialPowers.spawn(target, [], () => {
    const sel = content.getSelection();
    if (!sel || sel.isCollapsed) return "";
    return `${sel.anchorNode.parentElement?.id}:${sel.toString()}`;
  });
}

/**
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} expected
 * @param {string} msg
 */
async function waitForSelection(target, expected, msg) {
  let last = "";
  try {
    await TestUtils.waitForCondition(async () => {
      last = await selection(target);
      return last === expected;
    }, msg);
  } catch {
    // fall through to a readable failure
  }
  Assert.equal(last, expected, msg);
}

function findStatus() {
  return VimmaHost.status(window).find ?? null;
}

function findBarHidden() {
  return gBrowser.getCachedFindBar()?.hidden ?? true;
}

/** @param {XULBrowserElement} browser */
async function assertBackInNormal(browser, what) {
  await TestUtils.waitForCondition(
    () => gBrowser.getCachedFindBar()?.hidden,
    `${what}: the find bar opened and closed`,
  );
  await TestUtils.waitForCondition(
    () => document.activeElement === browser,
    `${what}: focus is back on the page`,
  );
  Assert.equal(VimmaHost.status(window).mode, "normal", `${what}: normal mode`);
}

/**
 * Presses the unbound key and returns every key the page has seen, which ends with it.
 * @param {XULBrowserElement} browser
 */
async function pageKeysThenUnbound(browser) {
  EventUtils.synthesizeKey(UNBOUND);
  Assert.ok(await waitForPageKey(browser, [UNBOUND]), `the page received ${UNBOUND}`);
  return pageKeys(browser);
}

/**
 * The frame whose document URL contains `marker`.
 * @param {XULBrowserElement} browser
 * @param {string} marker
 */
function frameWith(browser, marker) {
  return browser.browsingContext.children.find((bc) =>
    bc.currentWindowGlobal?.documentURI?.spec.includes(marker),
  );
}

add_task(async function slash_finds_from_the_viewport_top_and_n_N_cycle_and_wrap() {
  await withPage(async (browser) => {
    // The first "word" is above the viewport: the search starts at its top.
    await scrollToElement(browser, "w2", 40);
    type("/word");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForSelection(browser, "w2:word", "/word Enter selects the first match below the top");
    await assertBackInNormal(browser, "Enter");
    await TestUtils.waitForCondition(() => findStatus()?.total === 4, "4 matches counted");
    Assert.equal(findStatus()?.query, "word", "the status has the query");

    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "w3:Word", "n: the next match (lower-case query ignores case)");
    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "w4:word", "n: the next match");
    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "w1:word", "n at the last match wraps to the first");
    EventUtils.synthesizeKey("N");
    await waitForSelection(browser, "w4:word", "N wraps back to the last");
    EventUtils.synthesizeKey("N");
    await waitForSelection(browser, "w3:Word", "N: the previous match");
    Assert.ok(findBarHidden(), "n and N leave the find bar closed");

    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND],
      "no key of /word, Enter, n or N reached the page",
    );
  });
});

add_task(async function question_mark_finds_backward_from_the_viewport_top() {
  await withPage(async (browser) => {
    await scrollToElement(browser, "w3", 0);
    type("?word");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForSelection(browser, "w2:word", "?word Enter: the last match above the top");
    await assertBackInNormal(browser, "?word Enter");
    Assert.ok(findStatus()?.backward, "the status shows ?");
    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "w1:word", "n after ? goes on backward");
    EventUtils.synthesizeKey("N");
    await waitForSelection(browser, "w2:word", "N after ? goes forward");
  });
});

add_task(async function smartcase() {
  await withPage(async (browser) => {
    type("/Word");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForSelection(browser, "w3:Word", "/Word skips the lower-case words");
    await assertBackInNormal(browser, "/Word Enter");
    await TestUtils.waitForCondition(() => findStatus()?.total === 1, "/Word: 1 match");
    EventUtils.synthesizeKey("n");
    await TestUtils.waitForCondition(() => findStatus()?.current === 1, "n stays on it");
    await waitForSelection(browser, "w3:Word", "n: /Word has no other match");

    await scrollToElement(browser, "w1", 0);
    type("/word");
    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "/word Enter");
    await TestUtils.waitForCondition(
      () => findStatus()?.query === "word" && findStatus()?.total === 4,
      "/word matches word and Word: 4",
    );
  });
});

add_task(async function esc_cancels_and_returns_to_where_it_was() {
  await withPage(async (browser) => {
    const before = await pageScrollY(browser);
    Assert.equal(before, 0, "at the top");
    type("/delta");
    await TestUtils.waitForCondition(
      async () => (await pageScrollY(browser)) > 1000,
      "the incremental find scrolls to the match",
    );
    Assert.equal(VimmaHost.status(window).mode, "command", "typing a search: command mode");
    EventUtils.synthesizeKey("KEY_Escape");
    await assertBackInNormal(browser, "Esc");
    await TestUtils.waitForCondition(
      async () => (await pageScrollY(browser)) === before,
      "Esc scrolls back to where the find started",
    );
    Assert.equal(await selection(browser), "", "Esc leaves no match selected");
    Assert.equal(findStatus(), null, "a cancelled find leaves nothing in the status bar");
    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND],
      "no key typed into the find input, nor Esc, reached the page",
    );
  });
});

add_task(async function matches_in_same_and_cross_origin_frames() {
  await withPage(async (browser) => {
    type("/mango");
    EventUtils.synthesizeKey("KEY_Enter");
    const cross = frameWith(browser, "?mango");
    Assert.ok(cross, "the cross-origin frame is there");
    await waitForSelection(cross, "text:mango", "a match in the cross-origin frame");
    await assertBackInNormal(browser, "/mango Enter");

    type("/kiwi");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForSelection(frameWith(browser, "?kiwi"), "text:kiwi", "the same-origin frame");
    await TestUtils.waitForCondition(() => findStatus()?.total === 1, "kiwi: 1 match");
  });
});

add_task(async function not_found_shows_and_n_N_are_harmless() {
  await withPage(async (browser) => {
    await scrollToElement(browser, "w2", 40);
    const y = await pageScrollY(browser);
    type("/zzzqqq");
    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "a failed find");
    await TestUtils.waitForCondition(() => findStatus()?.notFound, "the status says not found");
    const segment = () => document.querySelector('#vimma-statusbar [data-segment="find"]');
    await TestUtils.waitForCondition(() => segment(), "the find segment is rendered");
    Assert.equal(segment()?.textContent, "/zzzqqq not found", "the status bar shows it");
    Assert.equal(await pageScrollY(browser), y, "a failed find does not move the page");

    EventUtils.synthesizeKey("n");
    EventUtils.synthesizeKey("N");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "n and N are ours");
    Assert.ok(findBarHidden(), "n and N do not reopen the find bar");
    Assert.equal(document.activeElement, browser, "focus stays on the page");
    Assert.equal(await pageScrollY(browser), y, "n and N do not move the page");
    Assert.equal(await selection(browser), "", "nor select anything");
    Assert.ok(findStatus()?.notFound, "still not found");
  });
});

/** Like pdfjs/test/head.js waitForPdfJS: resolves once the text layer has rendered. */
function loadPdf(browser, url) {
  const rendered = BrowserTestUtils.waitForContentEvent(
    browser,
    "textlayerrendered",
    false,
    null,
    true,
  );
  BrowserTestUtils.startLoadingURIString(browser, url);
  return rendered;
}

/** @param {XULBrowserElement} browser */
function pdfSelected(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const fc = content.wrappedJSObject.PDFViewerApplication.findController;
    return fc.selected.matchIdx;
  });
}

add_task(async function slash_and_n_in_the_pdf_viewer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, ROOT + "file_vimma_test.pdf");
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the PDF viewer is in normal mode",
    );
    // "Vimma help overlay test": three e's.
    type("/e");
    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "/e Enter in a PDF");
    await TestUtils.waitForCondition(
      async () => (await pdfSelected(browser)) === 0,
      "pdf.js selects the first match",
    );
    EventUtils.synthesizeKey("n");
    await TestUtils.waitForCondition(
      async () => (await pdfSelected(browser)) === 1,
      "n moves pdf.js to the next match",
    );
    EventUtils.synthesizeKey("N");
    await TestUtils.waitForCondition(
      async () => (await pdfSelected(browser)) === 0,
      "N moves it back",
    );
    Assert.ok(findBarHidden(), "the find bar stays closed");
  } finally {
    gBrowser.getCachedFindBar(tab)?.close(true);
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * The fixture's search box: its value, whether it has focus, its selected text, and how many
 * times it lost the focus since the last countBoxBlurs.
 * @param {XULBrowserElement} browser
 */
function box(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("box");
    return {
      value: el.value,
      focused: content.document.activeElement === el,
      selected: el.value.slice(el.selectionStart, el.selectionEnd),
      display: el.editor?.selectionController.getDisplaySelection(),
      blurs: Number(el.dataset.blurs ?? 0),
    };
  });
}

/**
 * Counts the search box's blurs from zero, in its data-blurs attribute. Closing the find bar
 * on a match in the box focuses it (Finder.focusContent), and the tab gives the focus back a
 * task later (VimmaChild #unfocusFindMatch): only that blur shows the hand-off is over. Before
 * it the box can show the match selected while not yet focused, or hold the focus, and a key
 * sent then types into it (#282).
 * @param {XULBrowserElement} browser
 */
function countBoxBlurs(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("box");
    if (el.dataset.blurs === undefined) {
      el.addEventListener("blur", () => {
        el.dataset.blurs = String(Number(el.dataset.blurs) + 1);
      });
    }
    el.dataset.blurs = "0";
  });
}

/**
 * Waits until the find has put its match in the search box, and checks the box let the focus
 * go and the tab stayed in normal mode (#164).
 * @param {XULBrowserElement} browser
 * @param {string} what
 * @param {{ focused?: boolean }} [how] focused: the find focused the box (countBoxBlurs before
 *   it), so the wait is for the box to lose that focus again; else for the match's selection
 */
async function assertMatchInBox(browser, what, { focused = true } = {}) {
  await TestUtils.waitForCondition(async () => {
    const now = await box(browser);
    return focused ? now.blurs > 0 : now.selected === "needle";
  }, `${what}: the find reached the search box`);
  // Focus reports follow the selection: the unbound key flushes them (and must not land in
  // the box).
  await pageKeysThenUnbound(browser);
  const now = await box(browser);
  Assert.equal(VimmaHost.status(window).mode, "normal", `${what}: still normal mode`);
  Assert.ok(!now.focused, `${what}: the box does not keep the focus`);
  Assert.equal(now.selected, "needle", `${what}: the match stays selected`);
  Assert.equal(now.value, "needle", `${what}: nothing was typed into the box`);
  // The blurred box draws its match the way the find bar does (#264).
  Assert.equal(
    now.display,
    Ci.nsISelectionController.SELECTION_ATTENTION,
    `${what}: the match shows as the find's attention highlight`,
  );
}

add_task(async function a_match_in_a_text_field_stays_in_normal_mode() {
  await withPage(async (browser) => {
    await countBoxBlurs(browser);
    type("/needle");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => findBarHidden(), "Enter closes the find bar");
    await assertMatchInBox(browser, "/needle Enter");

    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "p1:needle", "n steps from the box to the next match");
    EventUtils.synthesizeKey("n");
    await waitForSelection(browser, "p2:needle", "n: the next match");
    // From the page back into the box: the finder selects the match there and, in this test,
    // leaves the focus where it is (no focus or blur event reaches the box).
    EventUtils.synthesizeKey("n");
    await assertMatchInBox(browser, "n wrapping into the box", { focused: false });
    EventUtils.synthesizeKey("N");
    await waitForSelection(browser, "p2:needle", "N steps back out of the box");

    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND, UNBOUND, UNBOUND],
      "no key of /needle, Enter, n or N reached the page",
    );
  }, FIELD_PAGE);
});

add_task(async function the_text_field_a_find_matched_still_takes_i_and_a_click() {
  await withPage(async (browser) => {
    await countBoxBlurs(browser);
    type("/needle");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(() => findBarHidden(), "Enter closes the find bar");
    await assertMatchInBox(browser, "/needle Enter");

    EventUtils.synthesizeKey("i");
    await TestUtils.waitForCondition(
      async () => VimmaHost.status(window).mode === "insert" && (await box(browser)).focused,
      "i focuses the box in insert mode",
    );
    // And keeps it: a key typed now goes into the box.
    EventUtils.synthesizeKey(UNBOUND);
    await TestUtils.waitForCondition(
      async () => (await box(browser)).value.includes(UNBOUND),
      "a key after i is typed into the box",
    );
    Assert.ok((await box(browser)).focused, "the box keeps the focus i gave it");
    Assert.equal(VimmaHost.status(window).mode, "insert", "still insert mode");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      async () => VimmaHost.status(window).mode === "normal" && !(await box(browser)).focused,
      "Esc: back to normal",
    );

    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await TestUtils.waitForCondition(
      async () => VimmaHost.status(window).mode === "insert" && (await box(browser)).focused,
      "a click into the box enters insert mode",
    );
  }, FIELD_PAGE);
});

add_task(async function a_tab_closed_while_finding_leaves_no_find_behind() {
  // The find bar sends no findbarclose when its tab goes away, so the session has to end with it.
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(tab.linkedBrowser) === "normal",
    "the tab is in normal mode",
  );
  EventUtils.synthesizeKey("/");
  await TestUtils.waitForCondition(() => !findBarHidden(), "/ opens the find bar");
  BrowserTestUtils.removeTab(tab);
  await withPage(async () => {
    EventUtils.synthesizeKey("/");
    await TestUtils.waitForCondition(() => !findBarHidden(), "/ opens the next tab's find bar");
  });
});
