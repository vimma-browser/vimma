/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-copy-mode.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */
/* global docShell -- in SpecialPowers.spawn's content task scope */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_copy.html";

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

/**
 * Opens the fixture with content focus and recorded page keys, in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(fn) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._browserMode(browser) === "visual") EventUtils.synthesizeKey("KEY_Escape");
    }
  });
}

/**
 * @param {XULBrowserElement} browser
 * @param {string} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
}

/**
 * The frame's selection: the id of the element holding its focus, the offsets, its text, and
 * whether the frame's caret is enabled and showing.
 * @param {BrowsingContext | XULBrowserElement} target
 */
function selectionIn(target) {
  return SpecialPowers.spawn(target, [], () => {
    // A window with a document has a selection; were it missing, the reads below would throw.
    const sel = /** @type {Selection} */ (content.getSelection());
    const selCon = docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
    return {
      ranges: sel.rangeCount,
      focusId: sel.focusNode?.parentElement?.id ?? null,
      anchorOffset: sel.anchorOffset,
      focusOffset: sel.focusOffset,
      collapsed: sel.isCollapsed,
      text: sel.toString(),
      caret: selCon.getCaretEnabled(),
      scrollY: content.scrollY,
    };
  });
}

/** @typedef {Awaited<ReturnType<typeof selectionIn>>} SelectionState */

/**
 * Waits until the selection in `target` matches `want` (a subset of selectionIn's fields).
 * @param {BrowsingContext | XULBrowserElement} target
 * @param {Partial<SelectionState>} want
 * @param {string} what
 */
async function waitForSelection(target, want, what) {
  /** @type {SelectionState | undefined} */
  let last;
  try {
    await TestUtils.waitForCondition(async () => {
      const read = await selectionIn(target);
      last = read;
      return Object.entries(want).every(
        ([k, v]) => read[/** @type {keyof SelectionState} */ (k)] === v,
      );
    }, what);
  } catch {
    // fall through to the assertion, which shows what was there
  }
  if (!last) throw new Error(`${what}: the selection was never read`);
  for (const [k, v] of Object.entries(want)) {
    Assert.equal(last[/** @type {keyof SelectionState} */ (k)], v, `${what}: ${k}`);
  }
  return last;
}

/** ctrl+b, then `key`. */
function prefix(/** @type {string} */ key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key);
}

/** The status bar's notice, which Vimma's chrome always has. */
function notice() {
  return /** @type {HTMLElement} */ (document.getElementById("vimma-notice"));
}

add_task(async function v_places_a_visible_caret_at_the_top_of_the_viewport() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await waitForSelection(
      browser,
      { focusId: "first", focusOffset: 0, collapsed: true, caret: true },
      "a caret at the first visible character",
    );
    Assert.equal(VimmaHost.status(window).mode, "visual", "the badge says VISUAL");
  });
});

add_task(async function motions_move_the_caret() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusId: "first", focusOffset: 0 }, "caret placed");
    EventUtils.synthesizeKey("l");
    await waitForSelection(browser, { focusOffset: 1, collapsed: true }, "l: one character");
    EventUtils.synthesizeKey("h");
    await waitForSelection(browser, { focusOffset: 0 }, "h: back one");
    EventUtils.synthesizeKey("w");
    // Firefox's word motion (layout.word_select.*): on Linux it stops at the end of the word.
    await waitForSelection(browser, { focusId: "first", focusOffset: 5 }, "w: past alpha");
    EventUtils.synthesizeKey("$");
    await waitForSelection(browser, { focusId: "first", focusOffset: 16 }, "$: end of line");
    EventUtils.synthesizeKey("0");
    await waitForSelection(browser, { focusId: "first", focusOffset: 0 }, "0: line start");
    EventUtils.synthesizeKey("j");
    await waitForSelection(browser, { focusId: "second", collapsed: true }, "j: next line");
    EventUtils.synthesizeKey("k");
    await waitForSelection(browser, { focusId: "first" }, "k: back up");
  });
});

add_task(async function the_view_follows_the_caret() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusId: "first" }, "caret placed");
    EventUtils.synthesizeKey("G");
    const at = await waitForSelection(browser, { focusId: "last" }, "G: last line");
    Assert.greater(at.scrollY, 1000, "the page scrolled down to the caret");
    EventUtils.synthesizeKey("g");
    EventUtils.synthesizeKey("g");
    const back = await waitForSelection(browser, { focusId: "first" }, "gg: back to the top");
    // The caret's line is scrolled into view, give or take its line gap.
    Assert.less(back.scrollY, 20, "the page scrolled back up to the caret");
  });
});

add_task(async function v_then_motions_select_and_y_yanks_exactly_that() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusId: "first", focusOffset: 0 }, "caret placed");
    EventUtils.synthesizeKey("v");
    EventUtils.synthesizeKey("w");
    EventUtils.synthesizeKey("l");
    await waitForSelection(browser, { text: "alpha ", collapsed: false }, "v w l selects");
    await SimpleTest.promiseClipboardChange("alpha ", () => EventUtils.synthesizeKey("y"));
    await waitForMode(browser, "normal");
    Assert.equal(notice().textContent, "yanked 6 chars", "the notice counts the characters");
    await waitForSelection(browser, { collapsed: true, caret: false }, "the selection is gone");
  });
});

add_task(async function v_again_drops_the_selection_and_keeps_the_caret() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusOffset: 0 }, "caret placed");
    EventUtils.synthesizeKey("v");
    EventUtils.synthesizeKey("l");
    await waitForSelection(browser, { text: "a" }, "selecting");
    EventUtils.synthesizeKey("v");
    EventUtils.synthesizeKey("l");
    await waitForSelection(browser, { collapsed: true, focusOffset: 2 }, "moving again");
    Assert.equal(VimmaHost._browserMode(browser), "visual", "still in copy mode");
  });
});

add_task(async function esc_clears_the_selection_and_leaves() {
  await withPage(async (browser) => {
    prefix("[");
    await waitForMode(browser, "visual");
    await waitForSelection(browser, { focusId: "first" }, "prefix+[ places the caret");
    EventUtils.synthesizeKey("v");
    EventUtils.synthesizeKey("w");
    await waitForSelection(browser, { text: "alpha" }, "selecting");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await waitForSelection(browser, { text: "", caret: false }, "Esc clears");
  });
});

add_task(async function y_with_nothing_selected_copies_nothing() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusOffset: 0 }, "caret placed");
    await SimpleTest.promiseClipboardChange("unchanged", () => {
      // A known value first: `y` must leave it alone.
      SpecialPowers.clipboardCopyString("unchanged");
    });
    EventUtils.synthesizeKey("y");
    await waitForMode(browser, "normal");
    await TestUtils.waitForCondition(
      () => notice().textContent === "nothing to yank",
      "says so instead",
    );
    Assert.equal(
      SpecialPowers.getClipboardData("text/plain"),
      "unchanged",
      "the clipboard is untouched",
    );
  });
});

add_task(async function the_page_gets_no_keys_in_copy_mode() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("v");
    await waitForSelection(browser, { focusOffset: 0 }, "caret placed");
    for (const key of ["l", "x", UNBOUND, "q"]) EventUtils.synthesizeKey(key);
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    EventUtils.synthesizeKey(UNBOUND);
    Assert.ok(await waitForPageKey(browser, [UNBOUND]), "the page gets keys again in normal");
    Assert.deepEqual(await pageKeys(browser), [UNBOUND], "and none from copy mode");
  });
});

add_task(async function copy_mode_works_in_a_focused_cross_origin_frame() {
  await withPage(async (browser) => {
    const frame = browser.browsingContext.children[0];
    Assert.ok(frame, "the iframe has a browsing context");
    await SpecialPowers.spawn(frame, [], () => content.focus());
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === frame,
      "the frame has focus",
    );
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await waitForSelection(frame, { focusId: "framed", focusOffset: 0 }, "caret in the frame");
    EventUtils.synthesizeKey("v");
    EventUtils.synthesizeKey("w");
    await waitForSelection(frame, { text: "framed" }, "selecting in the frame");
    await SimpleTest.promiseClipboardChange("framed", () => EventUtils.synthesizeKey("y"));
    await waitForMode(browser, "normal");
    const top = await selectionIn(browser);
    Assert.equal(top.text, "", "the top frame's selection is untouched");
  });
});

add_task(async function malformed_or_unfocused_caret_messages_are_refused() {
  await withPage(async (browser) => {
    const actor = browser.browsingContext.currentWindowGlobal.getActor("Vimma");
    const bad = [
      null,
      "enter",
      {},
      { op: "constructor" },
      { op: "__proto__" },
      { op: "enter", count: 0 },
      { op: "right", count: 1.5 },
      { op: "right", count: "2" },
    ];
    for (const data of bad) {
      Assert.equal(await actor.sendQuery("Vimma:Caret", data), false, JSON.stringify(data));
    }
    Assert.equal((await selectionIn(browser)).caret, false, "no caret from them");
    // The frame does not have focus: it takes no caret.
    const frame = browser.browsingContext.children[0];
    const frameActor = frame.currentWindowGlobal.getActor("Vimma");
    Assert.equal(await frameActor.sendQuery("Vimma:Caret", { op: "enter" }), false, "unfocused");
    Assert.equal(await actor.sendQuery("Vimma:Caret", { op: "enter" }), true, "focused: entered");
    Assert.equal(await actor.sendQuery("Vimma:Caret", { op: "exit" }), true, "and left");
  });
});
