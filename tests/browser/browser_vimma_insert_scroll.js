/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-actor-insert-scroll.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, contextOf -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_insert_scroll.html";

/** Vimma's j/k step (Vimium's scrollStepSize), in CSS pixels. */
const STEP = 60;

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

/**
 * Opens the fixture in a new tab with content focus, records the page's keydowns and waits
 * for normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 * @param {string} [url]
 */
async function withPage(fn, url = PAGE) {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    await fn(browser);
  });
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/**
 * @param {XULBrowserElement} browser
 * @param {(y: number) => boolean} predicate
 * @param {string} msg
 */
function waitForScroll(browser, predicate, msg) {
  return TestUtils.waitForCondition(async () => predicate(await pageScrollY(browser)), msg);
}

/**
 * @param {XULBrowserElement} browser
 * @param {"normal" | "insert"} mode
 */
function waitForMode(browser, mode) {
  return TestUtils.waitForCondition(
    () => VimmaHost._browserMode(browser) === mode,
    `the tab is in ${mode} mode`,
  );
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
 * Focuses an element in the page by a selector run in its content process.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} how "id" for getElementById, "open"/"closed" for the shadow inputs
 */
function focusIn(target, how) {
  return SpecialPowers.spawn(target, [how], (h) => {
    const doc = content.document;
    if (h === "open") {
      const host = /** @type {HTMLElement} */ (doc.getElementById("open-host"));
      /** @type {HTMLElement} */ (
        /** @type {ShadowRoot} */ (host.shadowRoot).getElementById("shadow")
      ).focus();
    } else if (h === "closed") content.wrappedJSObject.closedRoot.getElementById("closed").focus();
    else /** @type {HTMLElement} */ (doc.getElementById(h)).focus();
  });
}

add_task(async function j_and_k_scroll_and_the_page_sees_neither() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === STEP, `j scrolls down ${STEP}px`);
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === 2 * STEP, "j again");
    EventUtils.synthesizeKey("k");
    await waitForScroll(browser, (y) => y === STEP, "k scrolls up");
    EventUtils.synthesizeKey("3");
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === 4 * STEP, "3j scrolls three steps");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "the page saw no j, k or 3");
  });
});

add_task(async function G_goes_to_the_bottom_and_gg_to_the_top() {
  await withPage(async (browser) => {
    const max = await SpecialPowers.spawn(browser, [], () => content.scrollMaxY);
    Assert.greater(max, 10000, "the page is long");
    EventUtils.synthesizeKey("G", { shiftKey: true });
    await waitForScroll(browser, (y) => y === max, "G goes to the bottom");
    EventUtils.synthesizeKey("g");
    EventUtils.synthesizeKey("g");
    await waitForScroll(browser, (y) => y === 0, "gg goes to the top");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "the page saw no G or g");
  });
});

add_task(async function d_and_u_scroll_half_a_page() {
  await withPage(async (browser) => {
    const half = await SpecialPowers.spawn(
      browser,
      [],
      () => /** @type {Element} */ (content.document.scrollingElement).clientHeight / 2,
    );
    EventUtils.synthesizeKey("d");
    await waitForScroll(browser, (y) => Math.abs(y - half) <= 1, "d scrolls half a viewport");
    EventUtils.synthesizeKey("d");
    await waitForScroll(browser, (y) => Math.abs(y - 2 * half) <= 1, "d again");
    EventUtils.synthesizeKey("u");
    await waitForScroll(browser, (y) => Math.abs(y - half) <= 1, "u scrolls half a viewport up");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "the page saw no d or u");
  });
});

// Vim's scroll keys (docs/specs/key-handling-batch.md) next to Vimium's d / u.
add_task(async function ctrl_d_ctrl_u_ctrl_e_and_ctrl_y_scroll_as_in_vim() {
  await withPage(async (browser) => {
    const half = await SpecialPowers.spawn(
      browser,
      [],
      () => /** @type {Element} */ (content.document.scrollingElement).clientHeight / 2,
    );
    EventUtils.synthesizeKey("d", { ctrlKey: true });
    await waitForScroll(browser, (y) => Math.abs(y - half) <= 1, "ctrl+d scrolls half a viewport");
    EventUtils.synthesizeKey("d", { ctrlKey: true });
    await waitForScroll(browser, (y) => Math.abs(y - 2 * half) <= 1, "ctrl+d again");
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    await waitForScroll(browser, (y) => Math.abs(y - half) <= 1, "ctrl+u scrolls half a page up");
    EventUtils.synthesizeKey("e", { ctrlKey: true });
    await waitForScroll(browser, (y) => Math.abs(y - half - STEP) <= 1, "ctrl+e scrolls a step");
    EventUtils.synthesizeKey("y", { ctrlKey: true });
    await waitForScroll(browser, (y) => Math.abs(y - half) <= 1, "ctrl+y scrolls a step up");
    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      [UNBOUND],
      "the page saw none of ctrl+d, ctrl+u, ctrl+e or ctrl+y",
    );
  });
});

add_task(async function in_insert_mode_ctrl_d_and_ctrl_u_are_the_pages() {
  await withPage(async (browser) => {
    // The page takes its ctrl keys, as an editor would, so Firefox's own ctrl+d (bookmark) and
    // ctrl+u (view source) stay out of the test.
    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLElement} */ (content.document.getElementById("text")).addEventListener(
        "keydown",
        (e) => {
          if (e.ctrlKey) e.preventDefault();
        },
      );
    });
    await focusIn(browser, "text");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("d", { ctrlKey: true });
    EventUtils.synthesizeKey("u", { ctrlKey: true });
    EventUtils.synthesizeKey("x");
    Assert.ok(await waitForPageKey(browser, ["x"]), "the page received x");
    Assert.deepEqual(await pageKeys(browser), ["d", "u", "x"], "and ctrl+d, ctrl+u unprevented");
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {HTMLInputElement} */ (content.document.getElementById("text")).value,
      ),
      "x",
      "x is typed into the input",
    );
    Assert.equal(await pageScrollY(browser), 0, "and nothing scrolls");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "still in insert mode");
  });
});

add_task(async function an_input_enters_insert_and_esc_leaves_it() {
  await withPage(async (browser) => {
    await focusIn(browser, "text");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "the page received j");
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {HTMLInputElement} */ (content.document.getElementById("text")).value,
      ),
      "j",
      "j is typed into the input",
    );
    Assert.equal(await pageScrollY(browser), 0, "and does not scroll");

    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {Element} */ (content.document.activeElement).localName,
      ),
      "body",
      "Esc blurs the input",
    );
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === STEP, "j scrolls again");
    Assert.deepEqual(
      await pageKeysThenUnbound(browser),
      ["j", UNBOUND],
      "the page saw the typed j only, not Esc or the second j",
    );
  });
});

for (const how of ["area", "ce", "aria", "open", "closed"]) {
  add_task(async function editable_enters_insert() {
    info(`editable: ${how}`);
    await withPage(async (browser) => {
      await focusIn(browser, how);
      await waitForMode(browser, "insert");
      EventUtils.synthesizeKey("KEY_Escape");
      await waitForMode(browser, "normal");
      EventUtils.synthesizeKey("j");
      await waitForScroll(browser, (y) => y === STEP, `after ${how}, j scrolls`);
    });
  });
}

add_task(async function an_input_in_a_cross_origin_iframe_enters_insert() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    Assert.ok(frame, "the iframe has a browsing context");
    await focusIn(frame, "framed");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () =>
        (await SpecialPowers.spawn(
          frame,
          [],
          () => /** @type {HTMLInputElement} */ (content.document.getElementById("framed")).value,
        )) === "j",
      "j is typed into the framed input",
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === STEP, "j scrolls the page after Esc");
  });
});

for (const id of ["check", "button"]) {
  add_task(async function a_control_leaves_insert() {
    info(`control: ${id}`);
    await withPage(async (browser) => {
      await focusIn(browser, "text");
      await waitForMode(browser, "insert");
      await focusIn(browser, id);
      await waitForMode(browser, "normal");
      EventUtils.synthesizeKey("j");
      await waitForScroll(browser, (y) => y === STEP, `with the ${id} focused, j scrolls`);
    });
  });
}

add_task(async function i_focuses_the_first_input_and_enters_insert() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => /** @type {Element} */ (content.document.activeElement).id,
      ),
      "text",
      "i focuses the first text input",
    );
  });
});

add_task(async function insert_mode_is_per_tab() {
  await withPage(async (first) => {
    await focusIn(first, "text");
    await waitForMode(first, "insert");
    await BrowserTestUtils.withNewTab(PAGE, async (second) => {
      await focusContent(second);
      await waitForMode(second, "normal");
      Assert.equal(VimmaHost._browserMode(first), "insert", "the first tab stays in insert");
      EventUtils.synthesizeKey("j");
      await waitForScroll(second, (y) => y === STEP, "j scrolls the second tab");

      await BrowserTestUtils.switchTab(
        gBrowser,
        /** @type {MozTabbrowserTab} */ (gBrowser.getTabForBrowser(first)),
      );
      await focusContent(first);
      await waitForMode(first, "insert");
      EventUtils.synthesizeKey("j");
      await TestUtils.waitForCondition(
        async () =>
          (await SpecialPowers.spawn(
            first,
            [],
            () => /** @type {HTMLInputElement} */ (content.document.getElementById("text")).value,
          )) === "j",
        "back in the first tab, j is typed into its input",
      );
      Assert.equal(await pageScrollY(first), 0, "and the first tab did not scroll");
      Assert.equal(VimmaHost._browserMode(second), "normal", "the second tab stays in normal");
    });
  });
});

add_task(async function the_actor_reaches_settings_and_the_pdf_viewer_but_not_data_urls() {
  const { VimmaActors } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
  );
  await BrowserTestUtils.withNewTab("about:preferences", async (browser) => {
    Assert.ok(VimmaActors.has(browser), "Settings (parent process) has the actor");
    await focusContent(browser);
    // Settings focuses its search box on load.
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
  });
  const pdf = PAGE.replace("file_vimma_insert_scroll.html", "file_vimma_test.pdf");
  await BrowserTestUtils.withNewTab(pdf, async (browser) => {
    Assert.ok(VimmaActors.has(browser), "the PDF viewer has the actor");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "and starts in normal");
  });
  await BrowserTestUtils.withNewTab("data:text/html,<p>hi", async (browser) => {
    Assert.ok(!VimmaActors.has(browser), "a data: page has no actor");
    Assert.equal(VimmaHost._browserMode(browser), "insert", "so it stays in insert");
  });
});

/**
 * Resolves after the page's next refresh tick, whose early runners (a pending scroll of the
 * selection into view) run before its animation frame callbacks.
 * @param {XULBrowserElement | BrowsingContext} target
 */
function afterRefreshTick(target) {
  return SpecialPowers.spawn(
    target,
    [],
    () =>
      /** @type {Promise<void>} */ (
        new Promise((resolve) => content.requestAnimationFrame(() => resolve()))
      ),
  );
}

/**
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string} selector
 */
function textOf(target, selector) {
  return SpecialPowers.spawn(
    target,
    [selector],
    (s) => /** @type {Element} */ (content.document.querySelector(s)).textContent,
  );
}

add_task(async function a_design_mode_page_enters_insert_on_click() {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
  await BrowserTestUtils.withNewTab(ROOT + "file_vimma_design.html", async (browser) => {
    await focusContent(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#p", {}, browser);
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await textOf(browser, "#p")).includes("j"),
      "j is typed into the designMode page",
    );
    // Issue #46: typing asks the editor to scroll the caret into view at the next refresh tick
    // (Selection's async ScrollSelectionIntoView, a refresh-driver early runner). On a loaded
    // runner that tick could come after the normal-mode j below and scroll back to the caret
    // (y = 16, measured with the refresh driver paused). Let it run first.
    await afterRefreshTick(browser);
    Assert.equal(await pageScrollY(browser), 0, "and does not scroll");

    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    EventUtils.synthesizeKey("j");
    await waitForScroll(browser, (y) => y === STEP, "after Esc, j scrolls");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "and the page stays in normal");
  });
});

add_task(async function a_cross_origin_design_mode_iframe_enters_insert_on_click() {
  await withPage(async (browser) => {
    const frame = contextOf(browser).children[0];
    await BrowserTestUtils.synthesizeMouseAtCenter("#p", {}, frame);
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await textOf(frame, "#p")).includes("j"),
      "j is typed into the framed designMode document",
    );
    // The editor's caret scroll waits for the frame's next refresh tick (issue #46, above).
    await afterRefreshTick(frame);
    Assert.equal(await pageScrollY(browser), 0, "the page does not scroll");
    Assert.equal(
      await SpecialPowers.spawn(frame, [], () => content.scrollY),
      0,
      "nor does the frame",
    );

    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode(browser, "normal");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () => (await SpecialPowers.spawn(frame, [], () => content.scrollY)) === STEP,
      "after Esc, j scrolls the focused frame",
    );
  }, ROOT + "file_vimma_design_host.html");
});

/**
 * Sends a focus report from a frame's own actor, as a compromised content process could, and
 * resolves once the parent has handled it (a query answers after receiveMessage returns).
 * @param {BrowsingContext} bc
 * @param {unknown} data
 */
function sendReport(bc, data) {
  return SpecialPowers.spawn(bc, [data], async (d) => {
    // A page's window has its global.
    const child = /** @type {WindowGlobalChild} */ (content.windowGlobalChild);
    await child.getActor("Vimma").sendQuery("Vimma:Focus", d);
  });
}

const INPUT_FOCUSIN = { descriptor: { tagName: "input" }, trigger: "focusin" };

add_task(async function only_the_focused_frame_may_report() {
  await withPage(async (browser) => {
    const top = contextOf(browser);
    const frame = top.children[0];
    await sendReport(frame, INPUT_FOCUSIN);
    Assert.equal(
      VimmaHost._browserMode(browser),
      "normal",
      "an unfocused frame cannot enter insert",
    );
    await sendReport(top, INPUT_FOCUSIN);
    Assert.equal(VimmaHost._browserMode(browser), "insert", "the focused frame's report is taken");
    await sendReport(frame, { descriptor: { tagName: "body" }, trigger: "recheck" });
    Assert.equal(VimmaHost._browserMode(browser), "insert", "nor can it leave insert");
  });
});

add_task(async function malformed_descriptors_are_dropped() {
  const long = "x".repeat(257);
  const bad = [
    null,
    { descriptor: { tagName: "input" }, trigger: "bogus" },
    { descriptor: null, trigger: "focusin" },
    { descriptor: { tagName: 5 }, trigger: "focusin" },
    { descriptor: { tagName: long }, trigger: "focusin" },
    { descriptor: { tagName: "input", type: 3 }, trigger: "focusin" },
    { descriptor: { tagName: "input", type: long }, trigger: "focusin" },
    { descriptor: { tagName: "div", isContentEditable: "yes" }, trigger: "focusin" },
    { descriptor: { tagName: "div", contentEditable: true }, trigger: "focusin" },
    { descriptor: { tagName: "div", role: ["textbox"] }, trigger: "focusin" },
    { descriptor: { tagName: "div", designMode: 1 }, trigger: "focusin" },
    { descriptor: { tagName: "div", classes: "ProseMirror" }, trigger: "focusin" },
    { descriptor: { tagName: "div", classes: ["ProseMirror", 1] }, trigger: "focusin" },
    { descriptor: { tagName: "div", classes: ["ProseMirror", long] }, trigger: "focusin" },
    {
      descriptor: { tagName: "div", classes: Array(65).fill("ProseMirror") },
      trigger: "focusin",
    },
  ];
  await withPage(async (browser) => {
    for (const data of bad) {
      await sendReport(contextOf(browser), data);
      Assert.equal(
        VimmaHost._browserMode(browser),
        "normal",
        `dropped: ${JSON.stringify(data)?.slice(0, 120)}`,
      );
    }
    await sendReport(contextOf(browser), {
      descriptor: { tagName: "div", role: null, classes: Array(64).fill("ProseMirror") },
      trigger: "focusin",
    });
    Assert.equal(VimmaHost._browserMode(browser), "insert", "a well-formed report is taken");
  });
});

add_task(async function a_scroll_locked_page_does_not_scroll() {
  await withPage(async (browser) => {
    // A site's modal: overflow hidden on <html>, a scrollable list inside the modal.
    await SpecialPowers.spawn(browser, [], () =>
      content.document.documentElement.classList.add("locked"),
    );
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      async () =>
        (await SpecialPowers.spawn(
          browser,
          [],
          () => /** @type {HTMLElement} */ (content.document.getElementById("list")).scrollTop,
        )) === STEP,
      "j scrolls the modal's list",
    );
    Assert.equal(await pageScrollY(browser), 0, "not the locked page");

    await SpecialPowers.spawn(browser, [], () => {
      /** @type {HTMLElement} */ (content.document.getElementById("list")).style.display = "none";
    });
    EventUtils.synthesizeKey("j");
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "j is still ours");
    Assert.equal(await pageScrollY(browser), 0, "with nothing else to scroll, nothing scrolls");
  }, ROOT + "file_vimma_plain.html");
});

const CONSENT = ROOT + "file_vimma_consent.html";

/**
 * The consent fixture's list and page scroll positions, and what has focus in its banner.
 * @param {XULBrowserElement} browser
 */
function consentState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const root = content.wrappedJSObject.consentRoot;
    return {
      list: root.querySelector("#list").scrollTop,
      page: content.scrollY,
      focused: root.activeElement?.id ?? content.document.activeElement?.id ?? "",
    };
  });
}

// A cookie banner's settings layer (issue #864): a fixed layer over a page that still scrolls,
// whose list of categories scrolls inside it. Focus sits in the layer's header or on its host,
// outside the list, so the focused element's scroller was the page behind the banner.
for (const [shape, focused] of [
  ["region", "tab-details"],
  ["shadow", ""],
  ["header", "close"],
]) {
  add_task(async function j_scrolls_the_cookie_settings_list_not_the_page_behind() {
    await withPage(async (browser) => {
      const before = await consentState(browser);
      if (focused) Assert.equal(before.focused, focused, `${shape}: focus is in the header`);
      EventUtils.synthesizeKey("j");
      await TestUtils.waitForCondition(
        async () => (await consentState(browser)).list === STEP,
        `${shape}: j scrolls the list of categories`,
      );
      EventUtils.synthesizeKey("G", { shiftKey: true });
      await TestUtils.waitForCondition(
        async () => (await consentState(browser)).list > 4 * STEP,
        `${shape}: G goes to the end of the list`,
      );
      Assert.equal((await consentState(browser)).page, 0, `${shape}: the page stays`);
    }, `${CONSENT}?${shape}`);
  });
}

// A fixed element that is no layer over the page's middle (a chat widget in a corner), or a
// layer with nothing to scroll, leaves the keys to the page.
for (const shape of ["corner", "static"]) {
  add_task(async function j_scrolls_the_page_past_a_fixed_element_that_is_no_scrolling_layer() {
    await withPage(async (browser) => {
      EventUtils.synthesizeKey("j");
      await waitForScroll(browser, (y) => y === STEP, `${shape}: j scrolls the page`);
      Assert.equal((await consentState(browser)).list, 0, `${shape}: not the widget's list`);
    }, `${CONSENT}?${shape}`);
  });
}

add_task(async function i_with_no_text_field_lets_keys_through() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("i");
    await waitForMode(browser, "insert");
    EventUtils.synthesizeKey("j");
    Assert.ok(await waitForPageKey(browser, ["j"]), "the page receives j");
    Assert.equal(await pageScrollY(browser), 0, "and nothing scrolls");
  }, ROOT + "file_vimma_plain.html");
});

add_task(async function ctrl_w_in_normal_mode_with_one_pane_passes_to_the_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const browser = tab.linkedBrowser;
  await recordPageKeys(browser);
  await focusContent(browser);
  await waitForMode(browser, "normal");
  // ctrl+w starts only <C-w> pane sequences (M4), none runnable with one pane: the first key
  // passes, to the page now that Firefox's close-tab ctrl+w is off (key-handling-batch § 1).
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  Assert.ok(await waitForPageKey(browser, ["w"]), "the page got ctrl+w");
  Assert.ok(tab.isConnected, "the tab stays open");
  Assert.equal(VimmaHost._browserMode(browser), "normal", "still in normal mode");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function every_mode_change_calls_the_hook_once() {
  await withPage(async (browser) => {
    /** @type {string[]} */
    const seen = [];
    const original = VimmaHost.onModeChange;
    VimmaHost.onModeChange = (b, mode) => b === browser && seen.push(mode);
    try {
      await focusIn(browser, "text");
      await waitForMode(browser, "insert");
      EventUtils.synthesizeKey("KEY_Escape");
      await waitForMode(browser, "normal");
      // The blur's focusout report travels ahead of this reply on the same channel: let it land
      // (no change) before i.
      Assert.equal(
        await SpecialPowers.spawn(
          browser,
          [],
          () => /** @type {Element} */ (content.document.activeElement).localName,
        ),
        "body",
        "Esc blurred the input",
      );
      EventUtils.synthesizeKey("i");
      await waitForMode(browser, "insert");
      await TestUtils.waitForCondition(() => seen.length >= 3, "three changes reported");
      Assert.deepEqual(seen, ["insert", "normal", "insert"], "one call per change, in order");
    } finally {
      VimmaHost.onModeChange = original;
    }
  });
});

add_task(async function g_as_the_first_key_of_gg_is_consumed() {
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("g");
    EventUtils.synthesizeKey("KEY_Escape"); // cancels the pending g, consumed too
    Assert.deepEqual(await pageKeysThenUnbound(browser), [UNBOUND], "the page saw no g or Esc");
  });
});
