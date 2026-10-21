/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/element-focus.md (sub-PR 1: text blocks as hint targets)

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

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
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
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
    Assert.equal(VimmaHost._hints(window)?.focused?.blockKind, "paragraph", "p2 is focused");
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

    type("asdf"); // other keys do nothing while focused
    Assert.ok(document.getElementById("vimma-element"), "still outlined");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !document.getElementById("vimma-element"), "Esc");
    Assert.equal(VimmaHost._hints(window), null, "focus is over");
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
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "Esc");

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
    Assert.equal(VimmaHost._hints(window), null, "focus is over");
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
