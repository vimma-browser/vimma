/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/element-focus.md (sub-PR 1: text blocks as hint targets; sub-PR 2: the
// ELEMENT mode, v, y, +, -, j, k)

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */
/* global docShell -- in SpecialPowers.spawn's content task scope */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_element.html";
const MANY = DIR + "file_vimma_element_many.html";

const FRAME_TIMEOUT_PREF = "vimma.hints.frameTimeoutMs";

/**
 * hint.element has no default key until its keymap sub-PR; the tests bind it to `e`, free in
 * normal mode, as a config.toml would.
 */
const KEY = "e";

/** The blocks of file_vimma_element.html that get a label, with their kinds. */
const BLOCKS = {
  header: "block",
  h: "heading",
  p1: "paragraph",
  p2: "paragraph",
  p3: "paragraph",
  lp1: "paragraph",
  lp2: "paragraph",
  q: "quote",
  pre: "code",
  c11: "cell",
  c12: "cell",
  c21: "cell",
  c22: "cell",
  cap: "caption",
  chat: "block",
  unsel: "paragraph",
  sopen: "paragraph",
  sclosed: "paragraph",
  framed: "paragraph",
};

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

add_task(function bind_element_focus_to_a_key() {
  VimmaHost.configure({ keymap: compileKeymap({ modal: { normal: { [KEY]: "hint.element" } } }) });
  registerCleanupFunction(() => VimmaHost.configure({ keymap: compileKeymap() }));
});

/**
 * Opens `url` with content focus, records the page's keys, mutations, focus and selection
 * events, then runs `fn`.
 * @param {string} url
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(url, fn) {
  await SpecialPowers.pushPrefEnv({ set: [[FRAME_TIMEOUT_PREF, 5000]] });
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const win = content.wrappedJSObject;
      win.vimmaSeen = [];
      const observer = new content.MutationObserver((records) => {
        for (const r of records) win.vimmaSeen.push(`${r.type} ${r.target.nodeName}`);
      });
      const options = { subtree: true, childList: true, attributes: true, characterData: true };
      observer.observe(content.document, options);
      win.vimmaObserver = observer;
      for (const type of ["selectstart", "selectionchange", "focusin"]) {
        content.document.addEventListener(type, () => win.vimmaSeen.push(type), true);
      }
    });
    await focusContent(browser);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal");
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.vimmaSeen.length = 0;
    });
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._hints(window) || VimmaHost._element(window)) {
        EventUtils.synthesizeKey("KEY_Escape");
      }
      if (VimmaHost._browserMode(browser) === "visual") EventUtils.synthesizeKey("KEY_Escape");
    }
  });
}

/** @param {XULBrowserElement} browser */
function seen(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const win = content.wrappedJSObject;
    for (const r of win.vimmaObserver.takeRecords()) win.vimmaSeen.push(r.type);
    return [...win.vimmaSeen];
  });
}

/** The labels drawn in chrome. */
function drawnLabels() {
  const overlay = document.getElementById("vimma-hints");
  if (!overlay) return [];
  return [...overlay.querySelectorAll(".vimma-hint:not([hidden])")].map((el) => el.dataset.label);
}

/** Starts element hints and waits for the labels. */
async function startElementHints() {
  EventUtils.synthesizeKey(KEY);
  await TestUtils.waitForCondition(
    () => VimmaHost._hints(window)?.hints.length && drawnLabels().length,
    "block labels are drawn",
  );
  return VimmaHost._hints(window);
}

/** @param {string} label */
function type(label) {
  for (const c of label) EventUtils.synthesizeKey(c);
}

/**
 * Each block's border box in the top page's CSS pixels, by id: in the page, its open and
 * closed shadow roots, and `framed` in the cross-origin frame.
 * @param {XULBrowserElement} browser
 * @returns {Promise<Record<string, { x: number, y: number, width: number, height: number }>>}
 */
async function boxes(browser) {
  const ids = Object.keys(BLOCKS).filter((id) => id !== "framed");
  const top = await SpecialPowers.spawn(browser, [ids], (list) => {
    const doc = content.document;
    const roots = [
      doc,
      ...["open", "closed"].map((h) => doc.getElementById(h).openOrClosedShadowRoot),
    ];
    /** @type {Record<string, any>} */
    const out = {};
    for (const id of [...list, "covered", "far", "ariahidden", "edit"]) {
      const el = roots.map((r) => r.getElementById(id)).find(Boolean);
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    const f = doc.getElementById("frame").getBoundingClientRect();
    out.frame = { x: f.x, y: f.y };
    return out;
  });
  const inner = await SpecialPowers.spawn(browser.browsingContext.children[0], [], () => {
    const r = content.document.getElementById("framed").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  top.framed = { ...inner, x: top.frame.x + inner.x, y: top.frame.y + inner.y };
  return top;
}

/**
 * The hint whose block box is this element's border box (within a pixel), or undefined.
 * @param {any} hints
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
function hintFor(hints, b) {
  const near = (/** @type {number} */ u, /** @type {number} */ v) => Math.abs(u - v) <= 1;
  return hints.hints.find(
    (/** @type {any} */ h) =>
      h.target.box &&
      near(h.target.box.x, Math.max(b.x, 0)) &&
      near(h.target.box.y, Math.max(b.y, 0)) &&
      near(h.target.box.x + h.target.box.width, b.x + b.width) &&
      near(h.target.box.y + h.target.box.height, b.y + b.height),
  );
}

add_task(async function element_hints_label_every_visible_text_block_and_nothing_else() {
  await withPage(PAGE, async (browser) => {
    const hints = await startElementHints();
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "hint", "hint mode");
    Assert.equal(hints.action, "hint.element", "element hints");
    const at = await boxes(browser);
    const ids = Object.keys(BLOCKS);
    for (const id of ids) {
      const h = hintFor(hints, at[id]);
      Assert.ok(h, `${id} has a label`);
      Assert.equal(h?.target.kind, "block", `${id} is a block target`);
      Assert.equal(
        h?.target.blockKind,
        BLOCKS[/** @type {keyof typeof BLOCKS} */ (id)],
        `${id}'s kind`,
      );
      // The label sits on the block's first line, inside its box.
      Assert.ok(
        h &&
          h.target.rect.x >= h.target.box.x - 1 &&
          h.target.rect.y >= h.target.box.y - 1 &&
          h.target.rect.y + h.target.rect.height <= h.target.box.y + h.target.box.height + 1,
        `${id}'s label is on its first line`,
      );
    }
    for (const id of ["covered", "far", "ariahidden", "edit"]) {
      Assert.equal(hintFor(hints, at[id]), undefined, `${id} has no label`);
    }
    Assert.equal(hints.hints.length, ids.length, `exactly ${ids.length} blocks`);
    Assert.deepEqual(
      drawnLabels().sort(),
      hints.hints.map((/** @type {any} */ h) => h.label).sort(),
      "every label is drawn in chrome",
    );
    Assert.ok(
      hints.hints.every((/** @type {any} */ h) =>
        [...h.label].every((c) => "asdfghjkl".includes(c)),
      ),
      "the hint charset",
    );
  });
});

add_task(async function a_label_outlines_its_block_in_chrome_until_esc() {
  await withPage(PAGE, async (browser) => {
    const hints = await startElementHints();
    const at = await boxes(browser);
    const h = hintFor(hints, at.p2);
    type(h.label);
    await TestUtils.waitForCondition(() => document.getElementById("vimma-element"), "outlined");
    Assert.deepEqual(drawnLabels(), [], "the labels are gone");
    Assert.equal(VimmaHost._element(window)?.kind, "paragraph", "p2 is focused");
    const ring = document.getElementById("vimma-element").firstElementChild;
    const r = ring.getBoundingClientRect();
    const b = browser.getBoundingClientRect();
    const zoom = browser.fullZoom;
    // The ring is drawn outside the block's border box.
    Assert.lessOrEqual(r.left, b.left + at.p2.x * zoom, "ring left");
    Assert.lessOrEqual(r.top, b.top + at.p2.y * zoom, "ring top");
    Assert.greaterOrEqual(r.right, b.left + (at.p2.x + at.p2.width) * zoom, "ring right");
    Assert.greaterOrEqual(r.bottom, b.top + (at.p2.y + at.p2.height) * zoom, "ring bottom");
    Assert.lessOrEqual(r.left, b.left + at.p2.x * zoom, "ring left");
    Assert.less(at.p2.x * zoom - (r.left - b.left), 6, "ring hugs the block");

    type("asdf"); // keys with no binding in ELEMENT mode do nothing
    Assert.ok(document.getElementById("vimma-element"), "still outlined");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !document.getElementById("vimma-element"), "Esc");
    Assert.equal(VimmaHost._element(window), null, "focus is over");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "normal", "back in normal");
    Assert.deepEqual(await seen(browser), [], "the page saw no mutation, selection or focus");
    EventUtils.synthesizeKey(UNBOUND);
    Assert.ok(await waitForPageKey(browser, [UNBOUND]), `the page received ${UNBOUND}`);
    Assert.deepEqual(await pageKeys(browser), [UNBOUND], "the page saw none of Vimma's keys");
  });
});

add_task(async function the_outline_sits_on_its_block_at_150_percent_zoom() {
  await withPage(PAGE, async (browser) => {
    const ratio = await SpecialPowers.spawn(browser, [], () => content.devicePixelRatio);
    browser.fullZoom = 1.5;
    try {
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(
            browser,
            [ratio],
            (dpr) => Math.abs(content.devicePixelRatio - 1.5 * dpr) < 0.01,
          ),
        "the page is zoomed",
      );
      const hints = await startElementHints();
      const at = await boxes(browser);
      type(hintFor(hints, at.q).label);
      await TestUtils.waitForCondition(() => document.getElementById("vimma-element"), "outlined");
      const r = document.getElementById("vimma-element").firstElementChild.getBoundingClientRect();
      const b = browser.getBoundingClientRect();
      Assert.lessOrEqual(Math.abs(r.left + 2 - (b.left + at.q.x * 1.5)), 2, "left at 150 %");
      Assert.lessOrEqual(Math.abs(r.top + 2 - (b.top + at.q.y * 1.5)), 2, "top at 150 %");
      Assert.lessOrEqual(Math.abs(r.width - 4 - at.q.width * 1.5), 3, "width at 150 %");
    } finally {
      browser.fullZoom = 1;
    }
  });
});

add_task(async function element_hints_feel_like_f() {
  await withPage(PAGE, async (browser) => {
    const hints = await startElementHints();
    const all = hints.hints.length;
    const long = hints.hints.filter((/** @type {any} */ h) => h.label.length > 1);
    Assert.greater(long.length, 1, "some labels have two keys");
    const first = long[0].label[0];
    type(first);
    const narrowed = long.filter((/** @type {any} */ h) => h.label.startsWith(first)).length;
    await TestUtils.waitForCondition(() => drawnLabels().length === narrowed, "narrowed");
    EventUtils.synthesizeKey("KEY_Backspace");
    await TestUtils.waitForCondition(() => drawnLabels().length === all, "backspace restores");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "Esc leaves hint mode");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is normal");

    // Keys typed before the labels show are replayed: the key and a whole label at once.
    const label = hints.hints[0].label;
    EventUtils.synthesizeKey(KEY);
    type(label);
    await TestUtils.waitForCondition(
      () => document.getElementById("vimma-element"),
      "the buffered label focused its block",
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._element(window), "Esc");

    EventUtils.synthesizeKey(UNBOUND);
    Assert.ok(await waitForPageKey(browser, [UNBOUND]), `the page received ${UNBOUND}`);
    Assert.deepEqual(await pageKeys(browser), [UNBOUND], "the page saw none of Vimma's keys");
    Assert.deepEqual(await seen(browser), [], "nothing of it was visible to the page");
  });
});

add_task(async function another_binding_or_a_tab_switch_leaves_the_focus() {
  await withPage(PAGE, async (browser) => {
    const hints = await startElementHints();
    type(hints.hints[0].label);
    await TestUtils.waitForCondition(() => document.getElementById("vimma-element"), "outlined");
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    await TestUtils.waitForCondition(() => !document.getElementById("vimma-element"), "switch");
    Assert.equal(VimmaHost._element(window), null, "focus is over");
    BrowserTestUtils.removeTab(tab);
    await focusContent(browser);
  });
});

add_task(async function collection_of_2000_paragraphs_stays_within_budget() {
  // Generous, to catch an order-of-magnitude regression without flaking on a loaded runner
  // (docs/specs/element-focus.md, decision 15).
  await withPage(MANY, async (browser) => {
    /** @param {number} budget */
    const measure = async (budget) => {
      const times = [];
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        count = (await VimmaActors.collectHints(browser, "hint.element")).length;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      info(
        `2000 paragraphs: ${count} blocks, median ${times[2].toFixed(1)} ms, child ` +
          `${VimmaActors._lastCollectMs.toFixed(1)} ms`,
      );
      Assert.greater(count, 5, "a screenful of blocks");
      Assert.less(times[2], budget, `collection under ${budget} ms`);
    };
    await measure(1000);
    await SpecialPowers.spawn(browser, [], () => {
      content.scrollTo(0, content.document.documentElement.scrollHeight / 2);
    });
    await measure(250);
  });
});

// Sub-PR 2: the ELEMENT mode (docs/specs/element-focus.md decisions 5 to 9, 12, 13, 16).

/** The fixture's texts, as copied. */
const TEXT = {
  p1: "The first paragraph, with a link and emphasis inline.",
  p2: "The second paragraph.",
  p3: "The third paragraph.",
  framed: "A paragraph in a frame.",
  sopen: "In an open shadow root.",
  sclosed: "In a closed shadow root.",
  unsel: "The page marks this paragraph unselectable.",
  // Tabs, indentation and the blank line as shown; the gutter's numbers left out.
  pre: "function f() {\n\treturn 1;\n\n    // four spaces in\n}",
};

/** The outline's ring, if drawn and shown. */
function ring() {
  return document.querySelector("#vimma-element .vimma-element-ring:not([hidden])");
}

/**
 * The ring's box back in the top page's CSS pixels: the block's border box it is drawn on.
 * @param {XULBrowserElement} browser
 */
function ringBox(browser) {
  const r = /** @type {Element} */ (ring()).getBoundingClientRect();
  const b = browser.getBoundingClientRect();
  const z = browser.fullZoom;
  return {
    x: (r.left + 2 - b.left) / z,
    y: (r.top + 2 - b.top) / z,
    width: (r.width - 4) / z,
    height: (r.height - 4) / z,
  };
}

/**
 * Whether two boxes are the same within `tolerance` CSS pixels.
 * @param {any} a
 * @param {any} b
 */
function same(a, b, tolerance = 2) {
  return ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) <= tolerance);
}

/**
 * One element's border box in the top page's CSS pixels, by id: in the page or one of its
 * shadow roots.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
function boxOf(browser, id) {
  return SpecialPowers.spawn(browser, [id], (want) => {
    const doc = content.document;
    const roots = [
      doc,
      ...["open", "closed"].map((h) => doc.getElementById(h).openOrClosedShadowRoot),
    ];
    const r = roots
      .map((root) => root.getElementById(want))
      .find(Boolean)
      .getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/**
 * Waits until the outline is on element `id` (by default in the top page).
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function waitForRingOn(browser, id) {
  let want = null;
  await TestUtils.waitForCondition(async () => {
    want = id === "framed" ? (await boxes(browser)).framed : await boxOf(browser, id);
    return ring() && same(ringBox(browser), want);
  }, `the outline is on ${id}`).catch(() => {});
  Assert.ok(ring() && same(ringBox(browser), want), `the outline is on ${id}`);
}

/**
 * Focuses block `id` with its label; resolves once the frame has answered.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function focusBlock(browser, id) {
  const hints = await startElementHints();
  const at = await boxes(browser);
  const h = hintFor(hints, at[id]);
  Assert.ok(h, `${id} has a label`);
  type(h.label);
  await TestUtils.waitForCondition(
    () => VimmaHost._element(window)?.length && ring(),
    `${id} is focused`,
  );
  return /** @type {any} */ (VimmaHost._element(window));
}

/** @param {string} id */
function segment(id) {
  return document.querySelector(`#vimma-statusbar [data-segment="${id}"]`)?.textContent ?? null;
}

function notice() {
  return document.getElementById("vimma-notice")?.textContent ?? "";
}

/**
 * @param {XULBrowserElement} browser
 * @param {string} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._mode(VimmaHost._state(window)) === mode,
    `${mode} mode`,
  );
}

/**
 * The selection in a frame: its text, whether it is collapsed, and whether the caret is on.
 * @param {BrowsingContext | XULBrowserElement} target
 */
function selectionIn(target) {
  return SpecialPowers.spawn(target, [], () => {
    const sel = content.getSelection();
    const selCon = docShell
      .QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsISelectionDisplay)
      .QueryInterface(Ci.nsISelectionController);
    return {
      text: sel.toString(),
      collapsed: sel.isCollapsed,
      ranges: sel.rangeCount,
      caret: selCon.getCaretEnabled(),
      focusId: sel.focusNode?.parentElement?.id ?? null,
      anchorId: sel.anchorNode?.parentElement?.id ?? null,
    };
  });
}

add_task(async function a_label_enters_element_mode_and_the_status_bar_names_the_block() {
  await withPage(PAGE, async (browser) => {
    const el = await focusBlock(browser, "p2");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "element", "ELEMENT mode");
    Assert.deepEqual(
      { kind: el.kind, length: el.length },
      { kind: "paragraph", length: TEXT.p2.length },
      "the frame says the block's kind and length",
    );
    await TestUtils.waitForCondition(() => segment("mode") === "ELEMENT", "the ELEMENT badge");
    Assert.equal(segment("element"), "paragraph · 21 chars", "the kind and length segment");
    const live = document.querySelector("#vimma-statusbar .vimma-sb-live");
    Assert.equal(
      live?.textContent,
      "element mode. paragraph, 21 characters",
      "the live region says the block's kind and length",
    );
    await waitForRingOn(browser, "p2");
    Assert.deepEqual(await seen(browser), [], "the page saw no mutation, selection or focus");
  });
});

add_task(async function v_selects_the_block_in_copy_mode_and_y_copies_it() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "p1");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    Assert.equal(ring(), null, "the outline is gone");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text === TEXT.p1,
      "the block's text is selected",
    );
    const sel = await selectionIn(browser);
    Assert.ok(sel.caret, "the caret is on");
    Assert.equal(VimmaHost.status(window).mode, "visual", "the badge says VISUAL");
    await SimpleTest.promiseClipboardChange(TEXT.p1, () => EventUtils.synthesizeKey("y"));
    await waitForMode(browser, "normal");
    Assert.equal(notice(), `yanked ${TEXT.p1.length} chars`, "copy mode's notice");

    // The selection is copy mode's: } extends it to the next paragraph, o swaps its ends.
    await focusBlock(browser, "p2");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text === TEXT.p2,
      "p2 is selected",
    );
    EventUtils.synthesizeKey("}");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text.includes(TEXT.p3),
      "} extends the selection over p3",
    );
    EventUtils.synthesizeKey("o");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).focusId === "p2",
      "o puts the focus back at p2's start",
    );
    Assert.ok((await selectionIn(browser)).text.startsWith(TEXT.p2), "still from p2");
  });
});

add_task(async function shift_v_selects_the_block_line_wise() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "p3");
    EventUtils.synthesizeKey("V");
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text.includes(TEXT.p3),
      "the block's line is selected",
    );
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text.includes("The first item"),
      "j extends by a whole line",
    );
  });
});

add_task(async function y_copies_the_block_without_selecting_it() {
  await withPage(PAGE, async (browser) => {
    const before = await selectionIn(browser);
    await focusBlock(browser, "p3");
    await SimpleTest.promiseClipboardChange(TEXT.p3, () => EventUtils.synthesizeKey("y"));
    await waitForMode(browser, "normal");
    Assert.equal(notice(), `yanked ${TEXT.p3.length} chars`, "the notice counts the characters");
    Assert.equal(ring(), null, "the outline is gone");
    const after = await selectionIn(browser);
    Assert.deepEqual(
      { text: after.text, collapsed: after.collapsed, ranges: after.ranges },
      { text: before.text, collapsed: before.collapsed, ranges: before.ranges },
      "the page's selection is unchanged",
    );
    Assert.deepEqual(await seen(browser), [], "no selectstart, selectionchange or mutation");
  });
});

add_task(async function a_code_block_copies_exactly_as_shown() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "pre");
    await SimpleTest.promiseClipboardChange(TEXT.pre, () => EventUtils.synthesizeKey("y"));
    Assert.equal(notice(), `yanked ${TEXT.pre.length} chars`, "y from ELEMENT");
    await focusBlock(browser, "pre");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await SimpleTest.promiseClipboardChange(TEXT.pre, () => EventUtils.synthesizeKey("y"));
  });
});

add_task(async function an_unselectable_block_copies_its_rendered_text_and_says_so() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "unsel");
    await SimpleTest.promiseClipboardChange(TEXT.unsel, () => EventUtils.synthesizeKey("y"));
    Assert.equal(
      notice(),
      `yanked ${TEXT.unsel.length} chars (the page marks it unselectable)`,
      "the notice says why the page would not have let it be selected",
    );
    await focusBlock(browser, "unsel");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      () => notice() === "no highlight: the page marks this block unselectable",
      "v says there is no highlight",
    );
  });
});

add_task(async function plus_minus_j_and_k_move_the_focus() {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "lp1");
    EventUtils.synthesizeKey("+");
    await TestUtils.waitForCondition(() => VimmaHost._element(window)?.kind === "list item", "+");
    await waitForRingOn(browser, "li1");
    Assert.equal(segment("element")?.startsWith("list item · "), true, "the segment follows");
    EventUtils.synthesizeKey("+");
    await waitForRingOn(browser, "ul");
    Assert.equal(VimmaHost._element(window)?.kind, "block", "a list is a block");
    EventUtils.synthesizeKey("-");
    await waitForRingOn(browser, "li1");
    EventUtils.synthesizeKey("-");
    await waitForRingOn(browser, "lp1");
    EventUtils.synthesizeKey("2");
    EventUtils.synthesizeKey("+");
    await waitForRingOn(browser, "ul");
    EventUtils.synthesizeKey("-");
    await waitForRingOn(browser, "li1");

    EventUtils.synthesizeKey("j");
    await waitForRingOn(browser, "lp2");
    EventUtils.synthesizeKey("k");
    await waitForRingOn(browser, "lp1");
    EventUtils.synthesizeKey("k");
    await waitForRingOn(browser, "p3");
    EventUtils.synthesizeKey("4");
    EventUtils.synthesizeKey("j");
    await waitForRingOn(browser, "pre");
    Assert.equal(VimmaHost._element(window)?.kind, "code", "j landed on the code block");

    // Past the last block on screen: j scrolls the next one into view. F in ELEMENT mode
    // picks another block.
    EventUtils.synthesizeKey("F");
    await TestUtils.waitForCondition(() => drawnLabels().length, "F draws the labels again");
    const hints = VimmaHost._hints(window);
    type(hintFor(hints, await boxOf(browser, "sclosed")).label);
    await TestUtils.waitForCondition(() => ring(), "sclosed focused");
    EventUtils.synthesizeKey("j");
    await waitForRingOn(browser, "far");
    const scrollY = await SpecialPowers.spawn(browser, [], () => content.scrollY);
    Assert.greater(scrollY, 1000, "the page scrolled to the block");
    Assert.deepEqual(await seen(browser), [], "nothing but the scroll reached the page");
  });
});

add_task(async function the_outline_follows_a_scroll_and_a_resize() {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await withPage(PAGE, async (browser) => {
    // A page that stops every scroll and resize event before anyone else hears it does not
    // stop the outline: its listeners are in the system group.
    await SpecialPowers.spawn(browser, [], () => {
      const stop = (/** @type {Event} */ e) => e.stopImmediatePropagation();
      content.addEventListener("scroll", stop, true);
      content.addEventListener("resize", stop, true);
    });
    await focusBlock(browser, "q");
    await waitForRingOn(browser, "q");
    const before = ringBox(browser);
    await SpecialPowers.spawn(browser, [], () => content.scrollBy(0, 200));
    await TestUtils.waitForCondition(
      () => Math.abs(ringBox(browser).y - (before.y - 200)) <= 1,
      "the outline moved up 200 px with the page",
    );
    await SpecialPowers.spawn(browser, [], () => content.scrollTo(0, 0));
    await waitForRingOn(browser, "q");

    const { outerWidth: w, outerHeight: h } = window;
    const width = () => SpecialPowers.spawn(browser, [], () => content.innerWidth);
    const was = await width();
    window.resizeTo(w - 200, h);
    try {
      await TestUtils.waitForCondition(async () => (await width()) < was, "the window resized");
      const moved = await boxOf(browser, "q");
      Assert.notEqual(Math.round(moved.x), Math.round(before.x), "the quote moved");
      await waitForRingOn(browser, "q");
      Assert.ok(VimmaHost._element(window), "a resize keeps the focus");
    } finally {
      window.resizeTo(w, h);
    }
  });
});

add_task(async function blocks_in_open_and_closed_shadow_roots() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "sclosed");
    await SimpleTest.promiseClipboardChange(TEXT.sclosed, () => EventUtils.synthesizeKey("y"));
    await focusBlock(browser, "sopen");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      async () => (await selectionIn(browser)).text === TEXT.sopen,
      "v selects the text inside the shadow tree",
    );
    await SimpleTest.promiseClipboardChange(TEXT.sopen, () => EventUtils.synthesizeKey("y"));
  });
});

add_task(async function a_block_in_a_cross_origin_frame() {
  await withPage(PAGE, async (browser) => {
    const frame = browser.browsingContext.children[0];
    await focusBlock(browser, "framed");
    await waitForRingOn(browser, "framed");
    EventUtils.synthesizeKey("+");
    // + stops at the frame's body: it never climbs into the page around it. A second + after
    // the key's, awaited, is answered after it.
    await VimmaHost._state(window).element.move("parent");
    Assert.equal(VimmaHost._element(window)?.kind, "paragraph", "+ stays in the frame");
    await waitForRingOn(browser, "framed");
    await SimpleTest.promiseClipboardChange(TEXT.framed, () => EventUtils.synthesizeKey("y"));
    Assert.equal(
      Services.focus.focusedContentBrowsingContext,
      browser.browsingContext,
      "y needs no focus in the frame",
    );

    await focusBlock(browser, "framed");
    EventUtils.synthesizeKey("v");
    await waitForMode(browser, "visual");
    await TestUtils.waitForCondition(
      () => Services.focus.focusedContentBrowsingContext === frame,
      "v focuses the frame, where copy mode runs",
    );
    await TestUtils.waitForCondition(
      async () => (await selectionIn(frame)).text === TEXT.framed,
      "the frame's block is selected",
    );
    Assert.ok((await selectionIn(frame)).caret, "the frame's caret is on");
    await SimpleTest.promiseClipboardChange(TEXT.framed, () => EventUtils.synthesizeKey("y"));
  });
});

add_task(async function navigation_a_click_in_chrome_and_a_prefix_key_leave_the_focus() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "p1");
    EventUtils.synthesizeMouseAtCenter(document.getElementById("vimma-statusbar"), {});
    await TestUtils.waitForCondition(() => !VimmaHost._element(window), "a click in chrome");
    Assert.equal(ring(), null, "the outline is gone");
    await focusContent(browser);

    await focusBlock(browser, "p1");
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("c");
    await TestUtils.waitForCondition(() => gBrowser.tabs.length === tabs + 1, "ctrl+b c");
    Assert.equal(VimmaHost._element(window), null, "ctrl+b c left ELEMENT mode");
    Assert.equal(ring(), null, "and the outline");
    BrowserTestUtils.removeTab(gBrowser.selectedTab);
    await focusContent(browser);

    await focusBlock(browser, "p1");
    const loaded = BrowserTestUtils.browserLoaded(browser);
    BrowserTestUtils.startLoadingURIString(browser, PAGE + "?again");
    await loaded;
    await TestUtils.waitForCondition(() => !VimmaHost._element(window), "a navigation");
    Assert.equal(ring(), null, "the outline is gone");
  });
});

add_task(async function a_text_field_taking_focus_leaves_the_focus() {
  await withPage(PAGE, async (browser) => {
    await focusBlock(browser, "p1");
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("edit").focus());
    await TestUtils.waitForCondition(() => !VimmaHost._element(window), "the field took focus");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "insert", "its keys are the field's");
    Assert.equal(ring(), null, "the outline is gone");
  });
});

add_task(async function no_element_hints_in_the_pdf_viewer() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  try {
    const browser = tab.linkedBrowser;
    const rendered = BrowserTestUtils.waitForContentEvent(
      browser,
      "textlayerrendered",
      false,
      null,
      true,
    );
    BrowserTestUtils.startLoadingURIString(browser, DIR + "file_vimma_test.pdf");
    await rendered;
    await focusContent(browser);
    EventUtils.synthesizeKey(KEY);
    await TestUtils.waitForCondition(
      () => notice() === "no text blocks here (PDF: use v)",
      "the notice points to copy mode",
    );
    Assert.equal(VimmaHost._hints(window), null, "no labels");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "normal", "still normal mode");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function malformed_block_messages_are_refused() {
  await withPage(PAGE, async (browser) => {
    const top = browser.browsingContext.currentWindowGlobal.getActor("Vimma");
    const inner = browser.browsingContext.children[0].currentWindowGlobal.getActor("Vimma");
    for (const data of [
      null,
      "focus",
      { op: "click", gen: 0 },
      { op: "focus", gen: -1, id: 0 },
      { op: "focus", gen: 0, id: "0" },
      { op: "yank", gen: 0 },
    ]) {
      Assert.equal(await top.sendQuery("Vimma:Block", data), null, JSON.stringify(data));
    }
    const el = await focusBlock(browser, "p2");
    const gen = el.target.gen;
    Assert.equal(await top.sendQuery("Vimma:Block", { op: "yank", gen: gen + 1 }), null, "stale");
    Assert.equal(
      await inner.sendQuery("Vimma:Block", { op: "yank", gen }),
      null,
      "a frame that was not asked has no block",
    );
    Assert.equal(
      await top.sendQuery("Vimma:Block", { op: "focus", gen, id: 0 }),
      null,
      "a collection is spent once a label is chosen",
    );
    // A report from the block's own frame for another collection is not heard.
    await SpecialPowers.spawn(browser, [gen], (g) => {
      content.windowGlobalChild.getActor("Vimma").sendAsyncMessage("Vimma:BlockGone", {
        gen: g + 1,
      });
    });
    // A report from a frame that is not the block's is not heard.
    await SpecialPowers.spawn(browser.browsingContext.children[0], [gen], (g) => {
      content.windowGlobalChild.getActor("Vimma").sendAsyncMessage("Vimma:BlockGone", { gen: g });
    });
    // Nor one from the same page in another tab, opened in the background.
    const other = BrowserTestUtils.addTab(gBrowser, PAGE);
    try {
      await BrowserTestUtils.browserLoaded(other.linkedBrowser);
      await SpecialPowers.spawn(other.linkedBrowser, [gen], (g) => {
        content.windowGlobalChild.getActor("Vimma").sendAsyncMessage("Vimma:BlockGone", { gen: g });
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      BrowserTestUtils.removeTab(other);
    }
    Assert.ok(VimmaHost._element(window), "the focus stays");
    await waitForRingOn(browser, "p2");
  });
});

add_task(async function j_on_2000_paragraphs_stays_within_budget() {
  await withPage(MANY, async () => {
    const hints = await startElementHints();
    type(hints.hints[0].label);
    await TestUtils.waitForCondition(() => ring(), "focused");
    const times = [];
    for (let i = 0; i < 5; i++) {
      const before = VimmaHost._element(window)?.target;
      const t0 = performance.now();
      await VimmaHost._state(window).element.move("next");
      times.push(performance.now() - t0);
      Assert.ok(VimmaHost._element(window)?.target === before, "the same focus, moved");
    }
    times.sort((a, b) => a - b);
    info(`j on 2000 paragraphs: median ${times[2].toFixed(1)} ms`);
    Assert.less(times[2], 1000, "j under 1000 ms");
  });
});
