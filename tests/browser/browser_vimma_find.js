/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-find.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, contextOf -- from head.js */

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

/** Types `text`, a key per character, as fast as the harness can. @param {string} text */
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
    const el = /** @type {HTMLElement} */ (content.document.getElementById(eid));
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
    return `${/** @type {Node} */ (sel.anchorNode).parentElement?.id}:${sel.toString()}`;
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

/** @param {XULBrowserElement} browser @param {string} what */
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

/** @param {any} node */
function describeNode(node) {
  if (!node) return "null";
  if (node === window) return "window";
  if (node === document) return "document";
  const id = node.id ? `#${node.id}` : "";
  const cls = node.className && typeof node.className === "string" ? `.${node.className}` : "";
  return `${node.localName ?? node.nodeName}${id}${cls}`.slice(0, 80);
}

/**
 * Records the chrome window's focus, key and mouse events from now on, so a wait that times out
 * can show what happened. `? after a click` failed once in CI and never locally (#731): this
 * puts the cause in the log of the next failure.
 * @param {XULBrowserElement} browser
 */
function traceFocus(browser) {
  const t0 = performance.now();
  /** @type {string[]} */
  const events = [];
  const types = ["focus", "blur", "keydown", "mousedown", "mouseup", "findbarclose"];
  /** @param {Event} e */
  const record = (e) => {
    const key = e.type === "keydown" ? ` key=${/** @type {KeyboardEvent} */ (e).key}` : "";
    const target = describeNode(e.composedTarget ?? e.target);
    events.push(`${(performance.now() - t0).toFixed(1)}ms ${e.type} ${target}${key}`);
  };
  for (const type of types) window.addEventListener(type, record, true);
  return {
    /**
     * TestUtils.waitForCondition, and on a timeout an info() dump of the trace and the state.
     * @param {() => any} condition
     * @param {string} msg
     */
    async waitFor(condition, msg) {
      try {
        await TestUtils.waitForCondition(condition, msg);
      } catch (e) {
        await dumpFindState(browser, events, msg);
        throw e;
      } finally {
        for (const type of types) window.removeEventListener(type, record, true);
      }
    },
  };
}

/**
 * @param {XULBrowserElement} browser
 * @param {string[]} events
 * @param {string} msg
 */
async function dumpFindState(browser, events, msg) {
  const state = VimmaHost._state(window);
  const s = state?.find.session;
  const lines = [
    `#731 diagnostics, "${msg}" timed out`,
    `activeElement: ${describeNode(document.activeElement)}`,
    `focusManager: element ${describeNode(Services.focus.focusedElement)}, ` +
      `window ${Services.focus.focusedWindow === window ? "this chrome window" : "other"}`,
    `mode: ${VimmaHost.status(window).mode}, page mode: ${VimmaHost._browserMode(browser)}`,
    `pending keys: ${JSON.stringify(state?.dispatcher.pending() ?? null)}`,
    s
      ? `find session: same tab ${s.browser === browser}, findbar ${!!s.findbar}, ` +
        `hidden ${s.findbar?.hidden}, accepting ${JSON.stringify(s.accepting)}, ` +
        `backward ${s.backward}, field "${s.findbar?._findField.value ?? s.buffer}"`
      : "find session: none",
    `cached findbar hidden: ${findBarHidden()}`,
    ...events.map((line) => `event ${line}`),
  ];
  try {
    lines.push(`page keys: ${JSON.stringify(await pageKeys(browser))}`);
  } catch (e) {
    lines.push(`page keys: unavailable (${e})`);
  }
  for (const line of lines) info(line);
}

/**
 * The frame whose document URL contains `marker`.
 * @param {XULBrowserElement} browser
 * @param {string} marker
 */
function frameWith(browser, marker) {
  return contextOf(browser).children.find((/** @type {CanonicalBrowsingContext} */ bc) =>
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

add_task(async function a_click_outside_the_prompt_closes_it_as_esc_does() {
  await withPage(async (browser) => {
    type("/delta");
    await TestUtils.waitForCondition(
      () => document.activeElement === gBrowser.getCachedFindBar()?._findField,
      "/ focuses the find field",
    );
    const findbar = /** @type {MozFindbar} */ (gBrowser.getCachedFindBar());
    await TestUtils.waitForCondition(
      async () => (await pageScrollY(browser)) > 1000,
      "the incremental find scrolls to the match",
    );
    const atMatch = await pageScrollY(browser);

    // A click in the prompt is the prompt's own: it stays open.
    EventUtils.synthesizeMouseAtCenter(findbar._findField, {});
    Assert.ok(!findBarHidden(), "a click in the prompt leaves it open");
    Assert.equal(document.activeElement, findbar._findField, "and in the field");

    // A click on the page ends the search as Esc does, but where the click is.
    const trace = traceFocus(browser);
    EventUtils.synthesizeMouseAtCenter(browser, {});
    await TestUtils.waitForCondition(findBarHidden, "a click on the page closes the prompt");
    await TestUtils.waitForCondition(
      () => document.activeElement === browser,
      "the click focuses the page",
    );
    Assert.equal(VimmaHost.status(window).mode, "normal", "the page has the keys: normal mode");
    Assert.equal(findStatus(), null, "a cancelled find leaves nothing in the status bar");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "no find key reached the page");
    Assert.equal(await pageScrollY(browser), atMatch, "the page stays where it was clicked");

    // The next ? is a new search (#731: ? right after a click on the page).
    EventUtils.synthesizeKey("?");
    await trace.waitFor(
      () => document.activeElement === findbar._findField,
      "? after the click opens a new search",
    );
    Assert.equal(findbar._findField.value, "", "a new search starts empty");
    Assert.ok(findStatus()?.backward, "and backward");
    type("word");
    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "Enter after the click");
    Assert.equal(findStatus()?.query, "word", "the new query is the search");

    // A click on Vimma's chrome (the status bar) closes it too. Not a tab: a press on the tab
    // strip left the page a pixel shorter for later files (browser_vimma_mcp_screenshot.js).
    type("/delta");
    await TestUtils.waitForCondition(
      () => document.activeElement === findbar._findField,
      "/ opens the prompt again",
    );
    EventUtils.synthesizeMouseAtCenter(
      /** @type {HTMLElement} */ (document.getElementById("vimma-statusbar")),
      {},
    );
    await TestUtils.waitForCondition(findBarHidden, "a click on the status bar closes the prompt");
    Assert.equal(findStatus(), null, "and cancels the search");
  });
});

add_task(async function slash_when_the_focus_left_the_open_search_goes_back_into_it() {
  await withPage(async (browser) => {
    type("/delta");
    await TestUtils.waitForCondition(
      () => document.activeElement === gBrowser.getCachedFindBar()?._findField,
      "/ focuses the find field",
    );
    const findbar = /** @type {MozFindbar} */ (gBrowser.getCachedFindBar());
    const field = findbar._findField;
    // The focus leaves the field without a click (a page or Firefox moving it): the prompt
    // stays open.
    browser.focus();
    await TestUtils.waitForCondition(
      () => VimmaHost.status(window).mode === "normal",
      "the page has the keys: normal mode",
    );
    Assert.ok(!findBarHidden(), "the find bar is still open");

    EventUtils.synthesizeKey("/");
    await TestUtils.waitForCondition(
      () => document.activeElement === field,
      "/ again focuses the find field",
    );
    Assert.equal(field.value, "delta", "the query is kept");
    Assert.deepEqual(
      [field.selectionStart, field.selectionEnd],
      [0, "delta".length],
      "and selected, so typing replaces it",
    );
    Assert.equal(VimmaHost.status(window).mode, "command", "typing a search again: command mode");

    const trace = traceFocus(browser);
    browser.focus();
    await TestUtils.waitForCondition(() => document.activeElement === browser, "page again");
    EventUtils.synthesizeKey("?");
    await trace.waitFor(() => document.activeElement === field, "? focuses the find field too");
    Assert.ok(findStatus()?.backward, "? makes the open search a backward one");
    type("word");
    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "Enter after going back into the search");
    Assert.equal(findStatus()?.query, "word", "the retyped query is the search");
    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND],
      "neither / nor ? reached the page",
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
    const same = frameWith(browser, "?kiwi");
    Assert.ok(same, "the same-origin frame is there");
    await waitForSelection(same, "text:kiwi", "the same-origin frame");
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
    // The bar renders on the next animation frame, after the status: typing already rendered
    // the segment as "/zzzqqq", so wait for the frame that adds "not found".
    await TestUtils.waitForCondition(
      () => segment()?.textContent === "/zzzqqq not found",
      "the find segment is rendered",
    ).catch(() => {});
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
/** @param {XULBrowserElement} browser @param {string} url */
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
    Assert.ok(findBarHidden(), "n leaves the find bar closed");
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
    const el = /** @type {HTMLInputElement} */ (content.document.getElementById("box"));
    return {
      value: el.value,
      focused: content.document.activeElement === el,
      // A text field has a selection: its ends are null only for a type without one.
      selected: el.value.slice(
        /** @type {number} */ (el.selectionStart),
        /** @type {number} */ (el.selectionEnd),
      ),
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
    const el = /** @type {HTMLInputElement} */ (content.document.getElementById("box"));
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

/** Search fields shaped like YouTube's, Google's and DuckDuckGo's, and one in a shadow root. */
const SITE_FIELDS_PAGE = ROOT + "file_vimma_find_site_fields.html";

/**
 * The fixture's field `id` (`inner` is in #host's shadow root): whether it has the focus, and
 * its blurs counted from zero since `count` was last true.
 * @param {XULBrowserElement} browser
 * @param {string} id
 * @param {{ count?: boolean, focus?: boolean }} [what] count: start counting blurs; focus: the
 *   page's script focuses the field
 */
function siteField(browser, id, { count = false, focus = false } = {}) {
  return SpecialPowers.spawn(browser, [id, count, focus], (fid, start, doFocus) => {
    const doc = content.document;
    const el = /** @type {HTMLElement} */ (
      fid === "inner"
        ? /** @type {ShadowRoot} */ (
            /** @type {HTMLElement} */ (doc.getElementById("host")).shadowRoot
          ).getElementById(fid)
        : doc.getElementById(fid)
    );
    if (start) {
      if (el.dataset.blurs === undefined) {
        el.addEventListener("blur", () => {
          el.dataset.blurs = String(Number(el.dataset.blurs) + 1);
        });
      }
      el.dataset.blurs = "0";
    }
    if (doFocus) el.focus();
    const root = /** @type {Document | ShadowRoot} */ (el.getRootNode());
    return { focused: root.activeElement === el, blurs: Number(el.dataset.blurs ?? 0) };
  });
}

add_task(async function a_field_a_find_matched_enters_insert_when_the_page_focuses_it() {
  // #442: the find gave the field's focus back, and the finder still names the field as its
  // match. A later focus the page's own script makes there is the page's, not the find's.
  for (const [id, word] of [
    ["yt", "kestrel"],
    ["g", "osprey"],
    ["ddg", "plover"],
    ["inner", "merlin"],
  ]) {
    await withPage(async (browser) => {
      await siteField(browser, id, { count: true });
      type(`/${word}`);
      EventUtils.synthesizeKey("KEY_Enter");
      await TestUtils.waitForCondition(() => findBarHidden(), `${id}: Enter closes the find bar`);
      await TestUtils.waitForCondition(
        async () => (await siteField(browser, id)).blurs > 0,
        `${id}: the find reached the field and gave its focus back`,
      );
      await pageKeysThenUnbound(browser);
      Assert.equal(VimmaHost.status(window).mode, "normal", `${id}: the find left normal mode`);

      Assert.ok((await siteField(browser, id, { focus: true })).focused, `${id}: focused`);
      await TestUtils.waitForCondition(
        () => VimmaHost.status(window).mode === "insert",
        `${id}: the page's focus on the field enters insert mode`,
      );
      Assert.ok((await siteField(browser, id)).focused, `${id}: the field keeps the focus`);
    }, SITE_FIELDS_PAGE);
  }
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

/** @param {Element} el */
function shown(el) {
  return el.checkVisibility();
}

/** The open find bar of the selected tab, once it has laid out. */
async function openFindBar() {
  /** @type {any} */
  let findbar = null;
  await TestUtils.waitForCondition(() => {
    findbar = gBrowser.getCachedFindBar();
    return findbar && !findbar.hidden && findbar.getBoundingClientRect().height > 0;
  }, "the find bar is open");
  return findbar;
}

/**
 * @param {any} findbar
 * @param {string} expected
 * @param {string} msg
 */
async function assertCount(findbar, expected, msg) {
  const count = () => findbar.querySelector(".vimma-find-count");
  await TestUtils.waitForCondition(() => count()?.textContent === expected, msg).catch(() => {});
  Assert.equal(count()?.textContent, expected, msg);
}

add_task(async function the_find_bar_floats_over_the_page_in_the_pickers_style() {
  await withPage(async (browser) => {
    const page = browser.getBoundingClientRect();
    type("/word");
    const findbar = await openFindBar();

    const bar = findbar.getBoundingClientRect();
    const after = browser.getBoundingClientRect();
    Assert.equal(after.height, page.height, "the page keeps its height: the bar floats over it");
    Assert.ok(
      bar.top >= after.top && bar.bottom <= after.bottom,
      `the bar sits on the page (${bar.top}-${bar.bottom} in ${after.top}-${after.bottom})`,
    );
    Assert.ok(bar.width < after.width, "the bar is narrower than the page");
    Assert.lessOrEqual(
      Math.abs(bar.left - after.left - (after.right - bar.right)),
      1,
      "and centred over it",
    );

    for (const sel of [
      ".findbar-find-previous",
      ".findbar-find-next",
      ".findbar-closebutton",
      ".findbar-highlight",
      ".findbar-case-sensitive",
      ".findbar-match-diacritics",
      ".findbar-entire-word",
    ]) {
      Assert.ok(!shown(findbar.querySelector(sel)), `${sel} is not shown`);
    }
    Assert.ok(shown(findbar._findField), "the field is shown");

    await assertCount(findbar, "[1/4]", "the bar shows the count as [1/4]");
    const count = findbar.querySelector(".vimma-find-count");
    Assert.equal(count.getAttribute("aria-hidden"), "true", "screen readers skip [1/4]");
    const field = findbar._findField.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    Assert.lessOrEqual(
      Math.abs(countBox.top + countBox.height / 2 - (field.top + field.height / 2)),
      1,
      "the count is centred on the field",
    );
    Assert.less(countBox.height, field.height, "the count is not stretched to the field");
    // Firefox's own "1 of 4 matches" stays for screen readers, out of sight.
    const label = findbar.querySelector(".found-matches");
    Assert.ok(!label.hidden, "Firefox's count label is kept");
    Assert.lessOrEqual(label.getBoundingClientRect().width, 1, "but not shown");

    EventUtils.synthesizeKey("KEY_Enter");
    await assertBackInNormal(browser, "Enter");
    Assert.ok(!shown(findbar), "a closed bar is not shown at all (no slide below the page)");

    type("/zzzqqq");
    await openFindBar();
    await TestUtils.waitForCondition(
      () => findbar._findField.getAttribute("status") === "notfound",
      "the bar knows it is not found",
    );
    await assertCount(findbar, "", "no count for a search that found nothing");
    EventUtils.synthesizeKey("KEY_Escape");
    await assertBackInNormal(browser, "Esc");
    Assert.ok(!shown(findbar), "Esc leaves no bar shown");
  });
});

add_task(async function the_pdf_viewers_count_shows_in_the_bar_too() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  try {
    await loadPdf(browser, ROOT + "file_vimma_test.pdf");
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the PDF viewer is in normal mode",
    );
    // "Vimma help overlay test": three e's. pdf.js counts for the find bar only.
    type("/e");
    await assertCount(await openFindBar(), "[1/3]", "pdf.js's count shows as [1/3]");
    EventUtils.synthesizeKey("KEY_Escape");
    await assertBackInNormal(browser, "Esc in a PDF");
  } finally {
    gBrowser.getCachedFindBar(tab)?.close(true);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function firefoxs_find_in_page_keeps_its_own_find_bar() {
  await withPage(async (browser) => {
    type("/word");
    const findbar = await openFindBar();
    EventUtils.synthesizeKey("KEY_Escape");
    await assertBackInNormal(browser, "Esc");

    // As Firefox's Find in Page (the Edit menu) opens it, after `/` used the same bar.
    const page = browser.getBoundingClientRect();
    findbar.setAttribute("noanim", "true");
    findbar.open();
    try {
      await openFindBar();
      await TestUtils.waitForCondition(
        () => browser.getBoundingClientRect().height < page.height,
        "Firefox's bar is a row under the page",
      );
      for (const sel of [".findbar-find-next", ".findbar-closebutton", ".findbar-highlight"]) {
        Assert.ok(shown(findbar.querySelector(sel)), `${sel} is shown`);
      }
      Assert.ok(!shown(findbar.querySelector(".vimma-find-count")), "with Firefox's own count");
    } finally {
      findbar.close(true);
      findbar.removeAttribute("noanim");
    }
  });
});
