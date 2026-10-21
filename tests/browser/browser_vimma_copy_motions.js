/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-copy-mode.md (Vim motions, V, o, iw/aw, Y). Each test puts the caret at a
// known character, enters copy mode and asserts on the selected text.

/* global focusContent -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_copy_motions.html";

/**
 * Opens the fixture with content focus in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(fn) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await focusContent(browser);
    await waitForMode(browser, "normal");
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._browserMode(browser) === "visual") EventUtils.synthesizeKey("KEY_Escape");
      await waitForMode(browser, "normal");
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

/** @param {XULBrowserElement} browser */
function selectionIn(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const sel = content.getSelection();
    return {
      text: sel.toString(),
      collapsed: sel.isCollapsed,
      focusId: sel.focusNode?.parentElement?.id ?? null,
      focusOffset: sel.focusOffset,
      anchorOffset: sel.anchorOffset,
    };
  });
}

/**
 * Waits until the selection matches `want` (a subset of selectionIn's fields), then asserts it.
 * @param {XULBrowserElement} browser
 * @param {object} want
 * @param {string} what
 */
async function waitForSelection(browser, want, what) {
  let last;
  try {
    await TestUtils.waitForCondition(async () => {
      last = await selectionIn(browser);
      return Object.entries(want).every(([k, v]) => last[k] === v);
    }, what);
  } catch {
    // fall through to the assertions, which show what was there
  }
  for (const [k, v] of Object.entries(want)) Assert.equal(last[k], v, `${what}: ${k}`);
  return last;
}

/**
 * Puts the caret in element `id`'s child node `child` at `offset`, then enters copy mode
 * there (`v`); with `select`, a second `v` starts a selection.
 * @param {XULBrowserElement} browser
 * @param {string} id
 * @param {number} child
 * @param {number} offset
 * @param {boolean} [select]
 */
async function caretAt(browser, id, child, offset, select = true) {
  await SpecialPowers.spawn(browser, [id, child, offset], (i, c, o) => {
    const node = content.document.getElementById(i).childNodes[c];
    content.getSelection().collapse(node, o);
  });
  EventUtils.synthesizeKey("v");
  await waitForMode(browser, "visual");
  await waitForSelection(browser, { collapsed: true, focusOffset: offset }, `caret in #${id}`);
  if (select) EventUtils.synthesizeKey("v");
}

/** Types each key of `keys` (a string of single keys). */
function keys(text) {
  for (const k of text) EventUtils.synthesizeKey(k);
}

add_task(async function e_ends_words_and_takes_a_count() {
  await withPage(async (browser) => {
    await caretAt(browser, "words", 0, 0);
    keys("e");
    await waitForSelection(browser, { text: "alpha" }, "e: to the end of alpha");
    keys("e");
    await waitForSelection(browser, { text: "alpha beta" }, "e: to the end of beta");
    keys("e");
    await waitForSelection(browser, { text: "alpha beta." }, "e: punctuation is a word");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await caretAt(browser, "words", 0, 0);
    keys("3e");
    await waitForSelection(browser, { text: "alpha beta." }, "3e: three word ends");
  });
});

add_task(async function ge_goes_back_to_the_previous_word_end() {
  await withPage(async (browser) => {
    await caretAt(browser, "words", 0, 8);
    keys("ge");
    await waitForSelection(browser, { text: " be", focusOffset: 5 }, "ge: back past beta's start");
  });
});

add_task(async function WORD_motions_skip_punctuation() {
  await withPage(async (browser) => {
    await caretAt(browser, "words", 0, 0);
    keys("W");
    await waitForSelection(browser, { text: "alpha " }, "W: before the next WORD");
    keys("W");
    await waitForSelection(
      browser,
      { text: "alpha beta.gamma ", focusOffset: 17 },
      "W: over beta.gamma, before delta",
    );
    keys("B");
    await waitForSelection(browser, { text: "alpha " }, "B: back to its start");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await caretAt(browser, "words", 0, 0);
    keys("EE");
    await waitForSelection(browser, { text: "alpha beta.gamma" }, "E E: two WORD ends");
  });
});

add_task(async function caret_goes_to_the_first_non_blank() {
  await withPage(async (browser) => {
    await caretAt(browser, "pre", 0, 10, false);
    keys("^");
    await waitForSelection(browser, { collapsed: true, focusOffset: 4 }, "^: past the indent");
    keys("0");
    await waitForSelection(browser, { collapsed: true, focusOffset: 0 }, "0: the line start");
    keys("v^");
    await waitForSelection(browser, { text: "    " }, "v^ selects the indent");
  });
});

add_task(async function f_t_F_T_find_on_the_line_and_repeat() {
  await withPage(async (browser) => {
    await caretAt(browser, "find", 0, 0);
    keys("f,");
    await waitForSelection(browser, { text: "one," }, "f, includes the comma");
    keys(";");
    await waitForSelection(browser, { text: "one,two," }, "; finds the next one");
    keys(",");
    await waitForSelection(browser, { text: "one,two" }, ", finds back (F)");
    keys("t;");
    await waitForSelection(browser, { text: "one,two,three" }, "t; stops before it");
    keys("T,");
    await waitForSelection(browser, { text: "one,two," }, "T, stops after the comma");
    keys("fz");
    await waitForSelection(browser, { text: "one,two," }, "no z on the line: no move");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await caretAt(browser, "find", 0, 0);
    keys("2f,");
    await waitForSelection(browser, { text: "one,two," }, "2f, the second comma");
    keys("ff");
    await waitForSelection(browser, { text: "one,two,three;f" }, "f then f: the f is the char");
  });
});

add_task(async function braces_move_by_paragraph() {
  await withPage(async (browser) => {
    await caretAt(browser, "para1", 0, 6);
    keys("}");
    await waitForSelection(browser, { text: "paragraph boldword end." }, "}: the paragraph's end");
    keys("}");
    const two = await waitForSelection(browser, { focusId: "para2" }, "}: the next paragraph");
    Assert.ok(two.text.endsWith("second paragraph here."), `} reaches para2's end: ${two.text}`);
    keys("{");
    await waitForSelection(browser, { focusId: "para2", focusOffset: 0 }, "{: para2's start");
    keys("{");
    await waitForSelection(browser, { text: "first " }, "{: back to para1's start");
  });
});

add_task(async function braces_step_over_a_paragraphs_source_white_space() {
  await withPage(async (browser) => {
    // #intro's text node starts and ends with source white space the page does not draw;
    // Firefox's paragraph edges are the node's edges, past that white space.
    const first = "\n      ".length;
    const last = "\n      a paragraph before a list".length;
    // From the last drawn character, as v leaves it on a focused block: into the list.
    await caretAt(browser, "intro", 0, last);
    keys("}");
    const item = await waitForSelection(browser, { focusId: "item1" }, "}: into the list");
    Assert.ok(item.text.endsWith("first item"), `} reaches the first item's end: ${item.text}`);
    keys("{");
    await waitForSelection(browser, { focusId: "item1", focusOffset: 0 }, "{: the item's start");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    // From the first drawn character: back to the paragraph before.
    await caretAt(browser, "intro", 0, first);
    keys("{");
    const back = await waitForSelection(browser, { focusId: "para2", focusOffset: 0 }, "{: para2");
    Assert.equal(back.text.trim(), "second paragraph here.", `{ reaches para2: ${back.text}`);
  });
});

add_task(async function V_selects_whole_lines_and_extends_by_lines() {
  await withPage(async (browser) => {
    // #lines: "line one", <br>, "line two", <br>, "line three"
    await caretAt(browser, "lines", 2, 3, false);
    keys("V");
    await waitForSelection(browser, { text: "line two" }, "V: the caret's line");
    keys("j");
    await waitForSelection(browser, { text: "line two\nline three" }, "j: and the next");
    keys("kk");
    await waitForSelection(browser, { text: "line one\nline two" }, "k k: above the anchor line");
    keys("l");
    await waitForSelection(browser, { text: "line one\nline two" }, "l stays line-wise");
    await SimpleTest.promiseClipboardChange("line one\nline two", () => keys("y"));
    await waitForMode(browser, "normal");
  });
});

add_task(async function o_swaps_the_ends() {
  await withPage(async (browser) => {
    await caretAt(browser, "words", 0, 0);
    keys("ee");
    await waitForSelection(browser, { text: "alpha beta" }, "selected two words");
    keys("o");
    await waitForSelection(
      browser,
      { text: "alpha beta", focusOffset: 0, anchorOffset: 10 },
      "o: the focus is at the start",
    );
    keys("l");
    await waitForSelection(browser, { text: "lpha beta" }, "motions move the other end");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    // Line-wise: o swaps the anchor and focus lines.
    await caretAt(browser, "lines", 2, 3, false);
    keys("Vj");
    await waitForSelection(browser, { text: "line two\nline three" }, "V j");
    keys("ok");
    await waitForSelection(browser, { text: "line one\nline two\nline three" }, "o k: grows up");
  });
});

add_task(async function iw_and_aw_select_the_word_at_the_caret() {
  await withPage(async (browser) => {
    await caretAt(browser, "words", 0, 7, false);
    keys("iw");
    await waitForSelection(browser, { text: "beta" }, "iw: the word");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    await caretAt(browser, "words", 0, 2, false);
    keys("aw");
    await waitForSelection(browser, { text: "alpha " }, "aw: the word and its space");
    keys("e");
    await waitForSelection(browser, { text: "alpha beta" }, "and motions extend it");
  });
});

add_task(async function Y_yanks_the_whole_lines() {
  await withPage(async (browser) => {
    await caretAt(browser, "lines", 2, 2, false);
    await SimpleTest.promiseClipboardChange("line two", () => keys("Y"));
    await waitForMode(browser, "normal");
    await TestUtils.waitForCondition(
      () => document.getElementById("vimma-notice")?.textContent === "yanked 8 chars",
      "the notice counts the line",
    );
    await caretAt(browser, "lines", 0, 5);
    keys("j");
    await waitForSelection(browser, { text: "one\nline " }, "a selection over two lines");
    await SimpleTest.promiseClipboardChange("line one\nline two", () => keys("Y"));
    await waitForMode(browser, "normal");
  });
});

add_task(async function malformed_find_messages_are_refused() {
  await withPage(async (browser) => {
    const actor = browser.browsingContext.currentWindowGlobal.getActor("Vimma");
    const bad = [
      { op: "find_forward" },
      { op: "find_forward", char: "" },
      { op: "find_forward", char: "ab" },
      { op: "find_forward", char: 3 },
      { op: "right", char: "a" },
    ];
    for (const data of bad) {
      Assert.equal(await actor.sendQuery("Vimma:Caret", data), false, JSON.stringify(data));
    }
  });
});
