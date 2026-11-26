/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/copy-link-url.md: gy copies the URL of the link at the caret or in the
// selection (copy mode), of the focused link or the selection on screen (normal mode, after a
// find), and of the focused block (element mode), in a frame, and in the PDF viewer.

/* global focusContent, contextOf, windowGlobalOf -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

"use strict";

// Eighteen tasks, each opening a page or a PDF.
requestLongerTimeout(2);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);
const { PdfOps } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/pdf-ops.mjs");

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_copy_link.html";
const LINKS_PDF = DIR + "file_vimma_pdf_links.pdf";
const FRAME_DIR = DIR.replace("https://example.com", "https://example.org");

/** What the clipboard holds before a key that must not change it. */
const UNCHANGED = "unchanged";

add_task(function use_the_default_keymap() {
  VimmaHost.configure({ keymap: compileKeymap({}, { mac: Services.appinfo.OS === "Darwin" }) });
});

/**
 * Opens the fixture with content focus, in normal mode, then runs `fn`.
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
      if (VimmaHost._element(window)) EventUtils.synthesizeKey("KEY_Escape");
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

/** The status bar's notice. */
const notice = () => document.getElementById("vimma-notice")?.textContent ?? "";

/** @param {string} text @param {string} what */
function waitForNotice(text, what) {
  return TestUtils.waitForCondition(() => notice() === text, `${what}: "${text}"`).catch((e) => {
    Assert.equal(notice(), text, what);
    throw e;
  });
}

/** @param {string} keys */
function type(keys) {
  for (const c of keys) EventUtils.synthesizeKey(c);
}

/**
 * Selects in `target`: from offset `start` of element `id`'s first text node to `end` (the same
 * offset: a caret), or the whole element with `end` "all".
 * @param {BrowsingContext | XULBrowserElement} target
 * @param {string} id
 * @param {number} start
 * @param {number | "all"} [end]
 * @param {string} [endId]  the element the end is in, when not `id`
 */
function select(target, id, start, end = start, endId = id) {
  return SpecialPowers.spawn(target, [id, start, end, endId], (a, s, e, b) => {
    const doc = content.document;
    const sel = /** @type {Selection} */ (content.getSelection());
    const el = /** @type {HTMLElement} */ (doc.getElementById(a));
    if (e === "all") {
      sel.selectAllChildren(el);
      return;
    }
    const first = /** @type {Text} */ (el.firstChild);
    const last = /** @type {Text} */ (
      /** @type {HTMLElement} */ (doc.getElementById(b)).firstChild
    );
    sel.setBaseAndExtent(first, s, last, /** @type {number} */ (e));
  });
}

/**
 * Enters copy mode on what `select` put on screen.
 * @param {XULBrowserElement} browser
 */
async function copyMode(browser) {
  EventUtils.synthesizeKey("v");
  await waitForMode(browser, "visual");
}

/** Puts a known value on the clipboard, which a key that copies nothing must keep. */
async function knownClipboard() {
  await SimpleTest.promiseClipboardChange(UNCHANGED, () =>
    SpecialPowers.clipboardCopyString(UNCHANGED),
  );
}

/** @param {string} what */
function clipboardUnchanged(what) {
  Assert.equal(SpecialPowers.getClipboardData("text/plain"), UNCHANGED, what);
}

/**
 * gy, and waits for `text` on the clipboard and `said` in the status bar.
 * @param {string} text
 * @param {string} said
 */
async function gyCopies(text, said) {
  await SimpleTest.promiseClipboardChange(text, () => type("gy"));
  await waitForNotice(said, "the notice");
}

add_task(async function caret_inside_a_link_copies_its_absolute_url() {
  await withPage(async (browser) => {
    await select(browser, "rel", 3);
    await copyMode(browser);
    const url = "https://example.org/a?b=1";
    await gyCopies(url, `yanked ${url}`);
    await select(browser, "page", 2);
    await copyMode(browser);
    const based = "https://example.org/base/page?x=1";
    await gyCopies(based, `yanked ${based}`);
  });
});

add_task(async function copy_mode_ends_after_copying_and_stays_on_no_link() {
  await withPage(async (browser) => {
    await select(browser, "rel", 3);
    await copyMode(browser);
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
    await waitForMode(browser, "normal");
    const collapsed = await SpecialPowers.spawn(
      browser,
      [],
      () => /** @type {Selection} */ (content.getSelection()).isCollapsed,
    );
    Assert.ok(collapsed, "copy mode left as after y: no selection");
  });
});

add_task(async function caret_outside_any_link_says_no_link_here_and_keeps_the_clipboard() {
  await withPage(async (browser) => {
    await select(browser, "plain", 2);
    await copyMode(browser);
    await knownClipboard();
    type("gy");
    await waitForNotice("no link here", "no link");
    clipboardUnchanged("the clipboard is untouched");
    Assert.equal(VimmaHost._browserMode(browser), "visual", "copy mode stays to move the caret");
    // The caret is still usable: l moves it, and gy on a link then copies.
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
  });
});

add_task(async function selection_inside_one_link_copies_that_link() {
  await withPage(async (browser) => {
    await select(browser, "rel", 0, 8);
    await copyMode(browser);
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
  });
});

add_task(async function selection_over_part_of_a_link_copies_it() {
  await withPage(async (browser) => {
    // From "before" into the link's first word.
    await select(browser, "one", 2, 3, "rel");
    await copyMode(browser);
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
  });
});

add_task(async function selection_over_several_links_copies_them() {
  await withPage(async (browser) => {
    await select(browser, "list", 0, "all");
    await copyMode(browser);
    // Each once, in document order; the javascript: link is left out.
    await gyCopies("https://a.example/one\nhttps://a.example/two", "yanked 2 links");
  });
});

add_task(async function javascript_link_is_not_copied() {
  await withPage(async (browser) => {
    await select(browser, "js", 2);
    await copyMode(browser);
    await knownClipboard();
    type("gy");
    await waitForNotice("link runs a script: not copied", "a script");
    clipboardUnchanged("a javascript: link is not copied");
  });
});

add_task(async function data_url_over_the_cap_is_skipped() {
  await withPage(async (browser) => {
    await select(browser, "big", 2);
    await copyMode(browser);
    await knownClipboard();
    type("gy");
    await waitForNotice("link too long to copy", "over the cap");
    clipboardUnchanged("a data: URL over the cap is not copied");
  });
});

add_task(async function a_count_is_ignored() {
  await withPage(async (browser) => {
    await select(browser, "rel", 3);
    await copyMode(browser);
    await SimpleTest.promiseClipboardChange("https://example.org/a?b=1", () => type("3gy"));
    await waitForNotice("yanked https://example.org/a?b=1", "3gy copies what gy copies");
  });
});

add_task(async function in_a_frame_the_frame_base_resolves_the_url() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    Assert.ok(frame, "the iframe has a browsing context");
    await SpecialPowers.spawn(frame, [], () => content.focus());
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === frame,
      "the frame has focus",
    );
    await select(frame, "flink", 2);
    await copyMode(browser);
    const url = FRAME_DIR + "inner?y=2";
    await gyCopies(url, `yanked ${url}`);
  });
});

add_task(async function after_find_enter_on_a_link_v_then_gy_copies_it() {
  await withPage(async (browser) => {
    type("/relative");
    EventUtils.synthesizeKey("KEY_Enter");
    await waitForMode(browser, "normal");
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(browser, [], () => content.getSelection()?.toString() === "relative"),
      "the match is selected",
    );
    await copyMode(browser);
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
  });
});

add_task(async function normal_mode_gy_after_find_copies_the_focused_link() {
  await withPage(async (browser) => {
    type("/based");
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.activeElement?.id === "page"),
      "find focused the link",
    );
    await waitForMode(browser, "normal");
    const url = "https://example.org/base/page?x=1";
    await gyCopies(url, `yanked ${url}`);
    Assert.equal(VimmaHost._browserMode(browser), "normal", "still in normal mode");
  });
});

add_task(async function normal_mode_gy_copies_only_the_one_link_around_the_selection() {
  await withPage(async (browser) => {
    await select(browser, "rel", 0, 8);
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
    // A selection over several links could be the page's own: normal mode copies none of them.
    await select(browser, "list", 0, "all");
    await knownClipboard();
    type("gy");
    await waitForNotice("no link here", "a selection over several links");
    clipboardUnchanged("normal mode never copies a list of links");
  });
});

add_task(async function normal_mode_gy_with_no_link_says_so() {
  await withPage(async (browser) => {
    await select(browser, "plain", 2);
    await knownClipboard();
    type("gy");
    await waitForNotice("no link here", "nothing focused or selected in a link");
    clipboardUnchanged("the clipboard is untouched");
    Assert.equal(VimmaHost._hints(window), null, "no hints start");
  });
});

/**
 * Focuses block `id` with element hints (F), choosing the label whose block is that element.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function focusBlock(browser, id) {
  EventUtils.synthesizeKey("F");
  await TestUtils.waitForCondition(() => VimmaHost._hints(window)?.hints.length, "block labels");
  const box = await SpecialPowers.spawn(browser, [id], (want) => {
    const r = /** @type {HTMLElement} */ (
      content.document.getElementById(want)
    ).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const near = (/** @type {number} */ u, /** @type {number} */ v) => Math.abs(u - v) <= 1;
  const hint = VimmaHost._hints(window)?.hints.find(
    (h) =>
      h.target.box &&
      near(h.target.box.x, box.x) &&
      near(h.target.box.y, box.y) &&
      near(h.target.box.width, box.width),
  );
  Assert.ok(hint, `${id} has a label`);
  type(hint?.label ?? "");
  await TestUtils.waitForCondition(() => VimmaHost._element(window)?.length, `${id} is focused`);
}

add_task(async function element_mode_copies_the_focused_link_or_the_links_inside_the_block() {
  await withPage(async (browser) => {
    await focusBlock(browser, "one");
    await gyCopies("https://example.org/a?b=1", "yanked https://example.org/a?b=1");
    Assert.equal(VimmaHost._element(window), null, "element mode ends after copying");
    await focusBlock(browser, "list");
    await gyCopies("https://a.example/one\nhttps://a.example/two", "yanked 2 links");
    await focusBlock(browser, "plain");
    await knownClipboard();
    type("gy");
    await waitForNotice("no link here", "a block with no link");
    clipboardUnchanged("the clipboard is untouched");
    Assert.ok(VimmaHost._element(window), "element mode stays when nothing was copied");
  });
});

add_task(async function malformed_link_messages_are_refused() {
  await withPage(async (browser) => {
    const actor = windowGlobalOf(contextOf(browser)).getActor("Vimma");
    for (const bad of [null, "caret", {}, { from: "nothing" }, { from: "__proto__" }]) {
      Assert.strictEqual(
        await actor.sendQuery("Vimma:LinkUrls", bad),
        null,
        `refused: ${JSON.stringify(bad)}`,
      );
    }
    // Copy mode is not on: the caret's links are not read.
    Assert.strictEqual(
      await actor.sendQuery("Vimma:LinkUrls", { from: "caret" }),
      null,
      "copy mode is off",
    );
    // Normal mode with nothing focused or selected: an empty list, not a refusal.
    Assert.deepEqual(
      await actor.sendQuery("Vimma:LinkUrls", { from: "focus" }),
      { urls: [], scripts: 0, long: 0 },
      "no link",
    );
  });
});

/**
 * Opens the PDF with links, focused, in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPdf(fn) {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.ui.pdf_outline.hidden", true]] });
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  try {
    const rendered = BrowserTestUtils.waitForContentEvent(
      browser,
      "annotationlayerrendered",
      false,
      null,
      true,
    );
    BrowserTestUtils.startLoadingURIString(browser, LINKS_PDF);
    await rendered;
    await TestUtils.waitForCondition(() => PdfOps.state(browser), "the viewer reports");
    await SimpleTest.promiseFocus(browser);
    browser.focus();
    await waitForMode(browser, "normal");
    await fn(browser);
  } finally {
    if (VimmaHost._browserMode(browser) === "visual") EventUtils.synthesizeKey("KEY_Escape");
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * Puts the caret at offset 2 of the text layer's span that reads `text`.
 * @param {XULBrowserElement} browser
 * @param {string} text
 */
function caretInPdfText(browser, text) {
  return SpecialPowers.spawn(browser, [text], async (want) => {
    const doc = content.document;
    /** @type {Element | undefined} */
    let span;
    await ContentTaskUtils.waitForCondition(() => {
      span = [...doc.querySelectorAll(".textLayer span")].find((s) => s.textContent === want);
      return !!span;
    }, `the text layer has "${want}"`);
    const node = /** @type {Text} */ (/** @type {Element} */ (span).firstChild);
    /** @type {Selection} */ (content.getSelection()).collapse(node, 2);
  });
}

add_task(async function pdf_external_link_under_the_selection_is_copied() {
  await withPdf(async (browser) => {
    await caretInPdfText(browser, "External link");
    await copyMode(browser);
    await gyCopies("https://example.org/vimma-pdf", "yanked https://example.org/vimma-pdf");
  });
});

add_task(async function pdf_internal_link_copies_the_url_with_its_fragment() {
  await withPdf(async (browser) => {
    await caretInPdfText(browser, "Link to chapter two");
    await copyMode(browser);
    const url = `${LINKS_PDF}#chapter-two`;
    await gyCopies(url, `yanked ${url}`);
  });
});
