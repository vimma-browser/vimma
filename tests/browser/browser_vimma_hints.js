/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-hints.md; docs/specs/follow-link-switch.md (gF's upper-case last key)

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_hints.html";
const MANY = DIR + "file_vimma_hints_many.html";
const MENU = DIR + "file_vimma_hints_menu.html";
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);
const { HintOverlay } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/hint-overlay.mjs",
);

/** How long the parent waits for a frame's targets (VimmaActors). */
const FRAME_TIMEOUT_PREF = "vimma.hints.frameTimeoutMs";

/** Elements of file_vimma_hints.html that get a label with `f`; `framed` is in the iframe. */
const TARGETS = [
  ...["home", "l1", "l2", "l3", "field", "button", "role", "listener", "row", "rowcheck"],
  "shadow",
];
/** The links among them and `framed`: the only targets of `F`. */
const LINKS = ["home", "l1", "l2", "l3", "shadow", "framed"];

/** A bare key with no binding in normal mode: it reaches the page and flushes earlier events. */
const UNBOUND = "z";

/**
 * Opens `url` in a new tab with content focus, records the page's keydowns and its DOM
 * mutations, waits for normal mode, then runs `fn`.
 * @param {string} url
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(url, fn) {
  // Generous for the tasks that expect the framed link: a loaded CI runner can be slow to
  // answer. The busy-frame task sets the shipped default back.
  await SpecialPowers.pushPrefEnv({ set: [[FRAME_TIMEOUT_PREF, 5000]] });
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await recordMutations(browser);
    await focusContent(browser);
    await waitForMode(browser, "normal");
    try {
      await fn(browser);
    } finally {
      // Never leave hint mode on for the next task.
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
    }
  });
}

/**
 * A MutationObserver in the page over everything, including attributes and the open shadow
 * root, so the test can tell whether anything Vimma drew is visible to the page.
 * @param {XULBrowserElement} browser
 */
async function recordMutations(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const win = content.wrappedJSObject;
    win.vimmaMutations = [];
    const observer = new content.MutationObserver((records) => {
      for (const r of records) win.vimmaMutations.push(`${r.type} ${r.target.nodeName}`);
    });
    const options = { subtree: true, childList: true, attributes: true, characterData: true };
    observer.observe(content.document, options);
    const host = content.document.getElementById("host");
    if (host?.shadowRoot) observer.observe(host.shadowRoot, options);
    win.vimmaObserver = observer;
  });
}

/** @param {XULBrowserElement} browser */
function mutations(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const win = content.wrappedJSObject;
    win.vimmaObserver.takeRecords().forEach((r) => win.vimmaMutations.push(r.type));
    return [...win.vimmaMutations];
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

/** The labels drawn in chrome, as their text, in document order. */
function drawnLabels() {
  const overlay = document.getElementById("vimma-hints");
  if (!overlay) return [];
  return [...overlay.querySelectorAll(".vimma-hint:not([hidden])")].map((el) => el.dataset.label);
}

/** Presses `f` (or `gF`, or `F`) and waits for the labels. */
async function startHints(key = "f") {
  for (const k of key) EventUtils.synthesizeKey(k, k === "F" ? { shiftKey: true } : {});
  await TestUtils.waitForCondition(
    () => VimmaHost._hints(window)?.hints.length && drawnLabels().length,
    "hints are drawn",
  );
  return VimmaHost._hints(window);
}

/** @param {string} label */
function type(label) {
  for (const c of label) EventUtils.synthesizeKey(c);
}

/**
 * Each element's centre in the top page's CSS pixels, by id; `framed` is inside the iframe.
 * @param {XULBrowserElement} browser
 * @param {string[]} ids
 * @returns {Promise<Record<string, { x: number, y: number }>>}
 */
async function centres(browser, ids) {
  const top = await SpecialPowers.spawn(browser, [ids], (list) => {
    const doc = content.document;
    /** @type {Record<string, { x: number, y: number }>} */
    const out = {};
    for (const id of list) {
      const el = doc.getElementById(id) ?? doc.getElementById("host").shadowRoot.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const f = doc.getElementById("frame").getBoundingClientRect();
    out.frame = { x: f.x, y: f.y };
    return out;
  });
  const frameBC = browser.browsingContext.children[0];
  const inner = await SpecialPowers.spawn(frameBC, [], () => {
    const r = content.document.getElementById("framed").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  top.framed = { x: top.frame.x + inner.x, y: top.frame.y + inner.y };
  return top;
}

/**
 * The label of the innermost hint whose target rect holds the element's centre, or undefined.
 * Innermost: a control inside a clickable row is under both rects.
 * @param {any} hints VimmaHost._hints(window)
 * @param {{ x: number, y: number }} c
 */
function labelAt(hints, c) {
  const area = (/** @type {any} */ h) => h.target.rect.width * h.target.rect.height;
  return hints.hints
    .filter(
      (/** @type {any} */ h) =>
        c.x >= h.target.rect.x &&
        c.x <= h.target.rect.x + h.target.rect.width &&
        c.y >= h.target.rect.y &&
        c.y <= h.target.rect.y + h.target.rect.height,
    )
    .sort((/** @type {any} */ a, /** @type {any} */ b) => area(a) - area(b))[0]?.label;
}

/**
 * The label `f` (or `gF`) gives the element with this id.
 * @param {XULBrowserElement} browser
 * @param {string} id
 * @param {string} [key]
 */
async function labelFor(browser, id, key = "f") {
  const hints = await startHints(key);
  const label = labelAt(hints, (await centres(browser, [id]))[id]);
  Assert.ok(label, `${id} has a label`);
  return /** @type {string} */ (label);
}

add_task(async function f_labels_every_visible_target_and_nothing_else() {
  await withPage(PAGE, async (browser) => {
    const hints = await startHints();
    const all = [...TARGETS, "framed"];
    Assert.equal(hints.hints.length, all.length, `${all.length} targets on screen`);
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "hint", "hint mode");
    const labels = hints.hints.map((/** @type {any} */ h) => h.label);
    Assert.deepEqual(drawnLabels().sort(), [...labels].sort(), "every label is drawn in chrome");
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) Assert.ok(!b.startsWith(a), `${a} is not a prefix of ${b}`);
      }
    }
    const at = await centres(browser, [...all, "covered", "far1", "far2", "plain", "invisible"]);
    for (const id of all) Assert.ok(labelAt(hints, at[id]), `${id} has a label`);
    Assert.equal(new Set(all.map((id) => labelAt(hints, at[id]))).size, all.length, "one each");
    for (const id of ["covered", "far1", "far2", "plain", "invisible"]) {
      Assert.equal(labelAt(hints, at[id]), undefined, `${id} has no label`);
    }
  });
});

add_task(async function a_label_follows_the_link() {
  await withPage(PAGE, async (browser) => {
    const label = await labelFor(browser, "l2");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, (url) => url.endsWith("?to=2"));
    type(label);
    await loaded;
    Assert.ok(browser.currentURI.spec.endsWith("?to=2"), "followed l2");
    Assert.equal(VimmaHost._hints(window), null, "hints are gone");
  });
});

add_task(async function a_label_in_a_shadow_root_and_in_a_cross_origin_frame() {
  await withPage(PAGE, async (browser) => {
    const frameBC = browser.browsingContext.children[0];
    const framed = await labelFor(browser, "framed");
    const frameLoaded = BrowserTestUtils.browserLoaded(browser, true, (u) =>
      u.endsWith("?to=framed"),
    );
    type(framed);
    await frameLoaded;
    Assert.ok(
      frameBC.currentWindowGlobal.documentURI.spec.endsWith("?to=framed"),
      "the frame followed its link",
    );
    Assert.ok(browser.currentURI.spec.endsWith("file_vimma_hints.html"), "the top page did not");

    await focusContent(browser);
    const shadow = await labelFor(browser, "shadow");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, (u) => u.endsWith("?to=shadow"));
    type(shadow);
    await loaded;
  });
});

add_task(async function a_label_clicks_buttons_and_listeners() {
  await withPage(PAGE, async (browser) => {
    type(await labelFor(browser, "button"));
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.buttonClicked),
      "the button got a click",
    );
    type(await labelFor(browser, "listener"));
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => !!content.wrappedJSObject.listenerClicked),
      "the element with a click listener got a click",
    );
    Assert.equal(VimmaHost._browserMode(browser), "normal", "still normal");
  });
});

add_task(async function a_label_on_an_input_focuses_it_and_enters_insert() {
  await withPage(PAGE, async (browser) => {
    type(await labelFor(browser, "field"));
    await waitForMode(browser, "insert");
    Assert.equal(
      await SpecialPowers.spawn(browser, [], () => content.document.activeElement.id),
      "field",
      "the input has focus",
    );
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").value),
      "j types into the field",
    );
  });
});

add_task(async function gF_opens_the_link_in_a_background_tab() {
  await withPage(PAGE, async (browser) => {
    const hints = await startHints("gF");
    Assert.equal(hints.action, "hint.follow_new_tab", "gF is background-tab hints");
    Assert.equal(hints.hints.length, LINKS.length, "gF labels links only");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "cancelled");

    const selected = gBrowser.selectedTab;
    const label = await labelFor(browser, "l3", "gF");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, (u) => u.endsWith("?to=3"), true);
    type(label);
    const tab = await opened;
    Assert.equal(gBrowser.selectedTab, selected, "the new tab opened in the background");
    Assert.equal(tab.userContextId, selected.userContextId, "in the same container");
    Assert.ok(browser.currentURI.spec.endsWith("file_vimma_hints.html"), "this tab stayed");
    BrowserTestUtils.removeTab(tab);
  });
});

/**
 * `label` typed with its last character upper case (with Shift), as a user types `sD`.
 * @param {string} label
 */
function typeUpperLast(label) {
  type(label.slice(0, -1));
  EventUtils.synthesizeKey(label.slice(-1).toUpperCase(), { shiftKey: true });
}

/**
 * Opens l3 from `gF`'s labels (or `key`'s), typed by `typeLabel`; returns the new tab.
 * @param {XULBrowserElement} browser
 * @param {(label: string) => void} typeLabel
 * @param {string} [key]
 */
async function openL3(browser, typeLabel, key = "gF") {
  const label = await labelFor(browser, "l3", key);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, (u) => u.endsWith("?to=3"), true);
  typeLabel(label);
  return opened;
}

add_task(async function gF_with_an_upper_case_last_key_opens_and_selects_the_tab() {
  await withPage(PAGE, async (browser) => {
    const hinted = gBrowser.selectedTab;
    const tab = await openL3(browser, typeUpperLast);
    await TestUtils.waitForCondition(() => gBrowser.selectedTab === tab, "the new tab is selected");
    Assert.equal(tab.userContextId, hinted.userContextId, "in the hinted tab's container");
    Assert.equal(tab.owner, hinted, "the hinted tab owns it");
    const at = (/** @type {any} */ t) => gBrowser.tabs.indexOf(t);
    Assert.greater(at(tab), at(hinted), "after the hinted tab in the strip");
    Assert.ok(browser.currentURI.spec.endsWith("file_vimma_hints.html"), "the hinted tab stayed");
    await focusContent(tab.linkedBrowser);
    await waitForMode(tab.linkedBrowser, "normal");
    const closed = BrowserTestUtils.waitForTabClosing(tab);
    EventUtils.synthesizeKey("x");
    await closed;
    await TestUtils.waitForCondition(() => gBrowser.selectedTab === hinted, "x returns to it");
  });
});

add_task(async function gF_ignores_loadInBackground() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.loadInBackground", false]] });
  await withPage(PAGE, async (browser) => {
    const hinted = gBrowser.selectedTab;
    const tab = await openL3(browser, type);
    Assert.equal(gBrowser.selectedTab, hinted, "lower case: still in the background");
    BrowserTestUtils.removeTab(tab);
  });
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.loadInBackground", true]] });
  await withPage(PAGE, async (browser) => {
    const tab = await openL3(browser, typeUpperLast);
    await TestUtils.waitForCondition(() => gBrowser.selectedTab === tab, "upper case: switched");
    BrowserTestUtils.removeTab(tab);
  });
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function the_switching_action_selects_the_tab_in_either_case() {
  const mac = Services.appinfo.OS === "Darwin";
  VimmaHost.configure({
    keymap: compileKeymap({ modal: { normal: { gl: "hint.follow_new_tab_fg" } } }, { mac }),
  });
  try {
    for (const typeLabel of [type, typeUpperLast]) {
      await withPage(PAGE, async (browser) => {
        const hints = await startHints("gl");
        Assert.equal(hints.action, "hint.follow_new_tab_fg", "the switching action's hints");
        Assert.equal(hints.hints.length, LINKS.length, "it labels links only");
        EventUtils.synthesizeKey("KEY_Escape");
        await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "cancelled");
        const tab = await openL3(browser, typeLabel, "gl");
        await TestUtils.waitForCondition(() => gBrowser.selectedTab === tab, "switched");
        BrowserTestUtils.removeTab(tab);
      });
    }
  } finally {
    VimmaHost.configure({ keymap: compileKeymap({}, { mac }) });
  }
});

add_task(async function the_status_bar_shows_both_outcomes_in_gF() {
  const segment = () =>
    document.querySelector('#vimma-statusbar [data-segment="hint"]')?.textContent ?? null;
  await withPage(PAGE, async () => {
    const hints = await startHints("gF");
    const first = hints.hints[0].label;
    const upper = first.slice(0, -1) + first.slice(-1).toUpperCase();
    await TestUtils.waitForCondition(
      () => segment() === `${first} background · ${upper} go there`,
      "the bar names both outcomes",
    );
    const long = hints.hints.find((/** @type {any} */ h) => h.label.length > 1);
    if (long) {
      const prefix = long.label[0];
      type(prefix);
      const next = hints.hints.find((/** @type {any} */ h) => h.label.startsWith(prefix)).label;
      await TestUtils.waitForCondition(
        () => segment()?.startsWith(`${next} background`),
        "it follows the typed prefix",
      );
    }
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => segment() === null, "gone when hint mode ends");
    await startHints("f");
    Assert.equal(segment(), null, "f has no hint segment");
  });
});

add_task(async function esc_cancels_and_backspace_restores_the_filter() {
  await withPage(PAGE, async (browser) => {
    const hints = await startHints();
    const all = hints.hints.length;
    const long = hints.hints.filter((/** @type {any} */ h) => h.label.length > 1);
    Assert.greater(long.length, 1, "some labels have two keys");
    const first = long[0].label[0];
    type(first);
    await TestUtils.waitForCondition(
      () => drawnLabels().length === long.length,
      `typing ${first} leaves ${long.length} labels`,
    );
    Assert.equal(VimmaHost._hints(window).typed, first, "the filter");
    EventUtils.synthesizeKey("KEY_Backspace");
    await TestUtils.waitForCondition(() => drawnLabels().length === all, "backspace restores all");
    Assert.equal(VimmaHost._hints(window).typed, "", "the filter is empty");

    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "Esc leaves hint mode");
    Assert.deepEqual(drawnLabels(), [], "the labels are gone");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "normal", "back in normal");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "the tab is normal");
    Assert.deepEqual(
      await (async () => {
        EventUtils.synthesizeKey(UNBOUND);
        Assert.ok(await waitForPageKey(browser, [UNBOUND]), `the page received ${UNBOUND}`);
        return pageKeys(browser);
      })(),
      [UNBOUND],
      "the page saw none of f, the label keys, Backspace or Esc",
    );
  });
});

add_task(async function the_status_bar_shows_hint_mode_while_labels_are_up() {
  const badge = () =>
    document.querySelector('#vimma-statusbar [data-segment="mode"]')?.textContent ?? null;
  await withPage(PAGE, async () => {
    await TestUtils.waitForCondition(() => badge() === "NORMAL", "the badge reads NORMAL");
    await startHints();
    await TestUtils.waitForCondition(() => badge() === "HINT", "the badge reads HINT");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => badge() === "NORMAL", "Esc: the badge reads NORMAL");
  });
  // With no targets, hint mode ends when the collection does, with no key to update the bar:
  // a page with nothing to hint but a busy frame, so the collection ends at the frame timeout.
  await withPage(DIR + "file_vimma_hints_frame.html?empty", async (browser) => {
    await SpecialPowers.pushPrefEnv({ clear: [[FRAME_TIMEOUT_PREF]] });
    const frameUrl = PAGE.replace("example.com", "example.org").replace(
      "file_vimma_hints.html",
      "file_vimma_hints_frame.html",
    );
    await SpecialPowers.spawn(browser, [frameUrl], async (url) => {
      const doc = content.document;
      doc.getElementById("framed").remove();
      const frame = doc.createElement("iframe");
      frame.src = url;
      const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
      doc.body.append(frame);
      await loaded;
    });
    await SpecialPowers.spawn(browser.browsingContext.children[0], [], () => {
      content.setTimeout(() => {
        const end = Date.now() + 2000;
        while (Date.now() < end);
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 200));
    await TestUtils.waitForCondition(() => badge() === "NORMAL", "the badge reads NORMAL");
    const runs = VimmaHost._hintRuns;
    EventUtils.synthesizeKey("f");
    await TestUtils.waitForCondition(() => VimmaHost._hintRuns > runs, "the collection finished");
    await TestUtils.waitForCondition(
      () => badge() === "NORMAL",
      "no targets: the badge is back to NORMAL",
      100,
      20,
    );
  });
});

add_task(async function the_page_cannot_observe_the_hints() {
  await withPage(PAGE, async (browser) => {
    const hints = await startHints();
    type(hints.hints.find((/** @type {any} */ h) => h.label.length > 1).label[0]);
    await TestUtils.waitForCondition(() => VimmaHost._hints(window)?.typed, "filtered");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => !VimmaHost._hints(window), "cancelled");
    Assert.deepEqual(await mutations(browser), [], "no DOM mutation in the page");
    Assert.ok(
      !(await SpecialPowers.spawn(browser, [], () =>
        content.document.querySelector("[class*=vimma], [id*=vimma]"),
      )),
      "nothing of Vimma's in the page",
    );
  });
});

add_task(async function no_targets_stays_in_normal() {
  await withPage(DIR + "file_vimma_hints_frame.html?empty", async (browser) => {
    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("framed").remove(),
    );
    const runs = VimmaHost._hintRuns;
    EventUtils.synthesizeKey("f");
    await TestUtils.waitForCondition(() => VimmaHost._hintRuns > runs, "the collection finished");
    EventUtils.synthesizeKey(UNBOUND);
    Assert.ok(await waitForPageKey(browser, [UNBOUND]), "the next key reaches the page");
    Assert.equal(VimmaHost._hints(window), null, "no hint mode");
    Assert.equal(VimmaHost._mode(VimmaHost._state(window)), "normal", "normal");
  });
});

add_task(async function a_busy_frame_does_not_hold_up_the_hints() {
  await withPage(PAGE, async (browser) => {
    await SpecialPowers.pushPrefEnv({ clear: [[FRAME_TIMEOUT_PREF]] });
    const frameBC = browser.browsingContext.children[0];
    // The cross-origin frame's process spins for 3 s, after this reply.
    await SpecialPowers.spawn(frameBC, [], () => {
      content.setTimeout(() => {
        const end = Date.now() + 3000;
        while (Date.now() < end);
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = performance.now();
    const hints = await startHints();
    const waited = performance.now() - t0;
    info(`labels after ${waited.toFixed(0)} ms with a busy frame`);
    Assert.less(waited, 1500, "the labels do not wait for the busy frame");
    const at = await centres(browser, TARGETS);
    Assert.equal(hints.hints.length, TARGETS.length, "every target but the framed link");
    const label = labelAt(hints, at.l1);
    Assert.ok(label, "l1 has a label");
    const loaded = BrowserTestUtils.browserLoaded(browser, false, (u) => u.endsWith("?to=1"));
    type(/** @type {string} */ (label));
    await loaded;
  });
});

add_task(async function labels_sit_on_their_targets_at_150_percent_zoom() {
  await withPage(PAGE, async (browser) => {
    const ratio = await SpecialPowers.spawn(browser, [], () => content.devicePixelRatio);
    browser.fullZoom = 1.5;
    try {
      await TestUtils.waitForCondition(
        () =>
          SpecialPowers.spawn(
            browser,
            [ratio],
            (r) => Math.abs(content.devicePixelRatio - 1.5 * r) < 0.01,
          ),
        "the page is zoomed",
      );
      const hints = await startHints();
      const at = await SpecialPowers.spawn(browser, [["l1", "button", "field"]], (ids) =>
        ids.map((id) => {
          const r = content.document.getElementById(id).getBoundingClientRect();
          return { id, x: r.x, y: r.y, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
        }),
      );
      const box = browser.getBoundingClientRect();
      for (const t of at) {
        const label = labelAt(hints, { x: t.cx, y: t.cy });
        Assert.ok(label, `${t.id} has a label`);
        const el = document.querySelector(`#vimma-hints .vimma-hint[data-label="${label}"]`);
        const r = el.getBoundingClientRect();
        Assert.lessOrEqual(Math.abs(r.left - (box.left + t.x * 1.5)), 1.5, `${t.id}: label left`);
        Assert.lessOrEqual(Math.abs(r.top - (box.top + t.y * 1.5)), 1.5, `${t.id}: label top`);
      }
    } finally {
      browser.fullZoom = 1;
    }
  });
});

add_task(async function a_collection_in_one_window_leaves_another_windows_alone() {
  await withPage(PAGE, async (browser) => {
    const win2 = await BrowserTestUtils.openNewBrowserWindow();
    try {
      const browser2 = win2.gBrowser.selectedBrowser;
      BrowserTestUtils.startLoadingURIString(browser2, PAGE);
      await BrowserTestUtils.browserLoaded(browser2);
      // Both in flight at once: the second window's must not void the first's.
      const [one, two] = await Promise.all([
        VimmaActors.collectHints(browser, "hint.follow"),
        VimmaActors.collectHints(browser2, "hint.follow"),
      ]);
      Assert.equal(one.length, TARGETS.length + 1, "the first window got its targets");
      Assert.equal(two.length, TARGETS.length + 1, "and so did the second");
    } finally {
      await BrowserTestUtils.closeWindow(win2);
      await SimpleTest.promiseFocus(window);
    }
  });
});

add_task(async function collection_of_2000_links_stays_within_budget() {
  // Generous, to catch an order-of-magnitude regression without flaking on a loaded runner
  // (docs/specs/m1-hints.md, Performance, has the measured numbers). A screenful of links
  // must stay fast; 2,000 targets all on screen is the extreme case.
  /** @type {Record<string, number>} */
  const BUDGETS_MS = { "?dense": 1000, "": 250 };
  for (const variant of ["?dense", ""]) {
    const BUDGET_MS = BUDGETS_MS[variant];
    await withPage(MANY + variant, async (browser) => {
      const times = [];
      let count = 0;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const targets = await VimmaActors.collectHints(browser, "hint.follow");
        times.push(performance.now() - t0);
        count = targets.length;
      }
      times.sort((a, b) => a - b);
      const median = times[2];
      const child = VimmaActors._lastCollectMs;
      info(
        `2000 links${variant}: ${count} targets, median ${median.toFixed(1)} ms round trip, ` +
          `child ${child.toFixed(1)} ms; all: ${times.map((t) => t.toFixed(1)).join(", ")}`,
      );
      if (variant) Assert.equal(count, 2000, "all 2000 are on screen");
      else Assert.greater(count, 10, "the first screenful");
      Assert.less(median, BUDGET_MS, `collection under ${BUDGET_MS} ms`);
      const hints = await startHints();
      Assert.equal(drawnLabels().length, count, "every label is drawn");
      const overlay = new HintOverlay(window);
      const t1 = performance.now();
      overlay.show(browser, hints.hints);
      overlay.layer.getBoundingClientRect(); // flush style and layout of the labels
      const drawMs = performance.now() - t1;
      overlay.hide();
      info(`2000 links${variant}: drawing ${count} labels took ${drawMs.toFixed(1)} ms`);
      Assert.less(drawMs, 1000, "drawing under 1000 ms");
      Assert.ok(
        hints.hints.every((/** @type {any} */ h) => h.label.length <= 4),
        "short labels",
      );
    });
  }
});

/** The entries of the open menu in file_vimma_hints_menu.html: every one gets a label. */
const MENU_ENTRIES = ["settings", "language", "help", "upgrade", "learn", "logout"];
/**
 * Its elements that must not get one: the menu's header, a hidden entry and the page under the
 * modal menu. The menu and its item wrapper hold the entries: the label count rules them out.
 */
const MENU_NONE = ["email", "hidden", "chats", "projects", "recent", "account"];

/**
 * Opens the menu fixture and waits for its open animation to end.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
function withMenu(fn) {
  return withPage(MENU, async (browser) => {
    await SpecialPowers.spawn(browser, [], async () => {
      const menu = content.document.getElementById("menu");
      await Promise.all(menu.getAnimations().map((a) => a.finished));
    });
    await fn(browser);
  });
}

/**
 * Each element's centre in the page's CSS pixels, by id.
 * @param {XULBrowserElement} browser
 * @param {string[]} ids
 * @returns {Promise<Record<string, { x: number, y: number }>>}
 */
function pageCentres(browser, ids) {
  return SpecialPowers.spawn(browser, [ids], (list) => {
    /** @type {Record<string, { x: number, y: number }>} */
    const out = {};
    for (const id of list) {
      const r = content.document.getElementById(id).getBoundingClientRect();
      out[id] = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return out;
  });
}

add_task(async function every_entry_of_an_open_dropdown_menu_gets_a_label() {
  await withMenu(async (browser) => {
    const hints = await startHints();
    const at = await pageCentres(browser, [...MENU_ENTRIES, ...MENU_NONE]);
    for (const id of MENU_ENTRIES) Assert.ok(labelAt(hints, at[id]), `${id} has a label`);
    for (const id of MENU_NONE) Assert.equal(labelAt(hints, at[id]), undefined, `${id} has none`);
    Assert.equal(hints.hints.length, MENU_ENTRIES.length, "one label per entry and no other");
  });
});

add_task(async function a_label_clicks_a_menu_entry_with_only_a_listener() {
  await withMenu(async (browser) => {
    const hints = await startHints();
    const label = labelAt(hints, (await pageCentres(browser, ["logout"])).logout);
    Assert.ok(label, "logout has a label");
    type(/** @type {string} */ (label));
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.clicked === "logout"),
      "the entry got a click",
    );
  });
});
