/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/hover.md (sub-PR 1: the user's hover, `gh`).

/* global focusContent, contextOf, windowGlobalOf -- from head.js */
/* global XULBrowserWindow -- a browser window global (browser.js) */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global InspectorUtils -- chrome-only, in the content task's scope too */

"use strict";

requestLongerTimeout(3);

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { compileKeymap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/keymap.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_hover.html";
const OTHER = DIR + "file_vimma_hover_other.html";

/** hint.hover's default key in normal mode (decision 14). */
const KEY = "gh";

const hostState = () => /** @type {HostState} */ (VimmaHost._state(window));

/** The selected tab's hover as the status bar has it, or null. */
const hoverStatus = () => VimmaHost.status(window).hover ?? null;

/** The status bar's hover segment, as drawn. */
const hoverSegment = () =>
  document.getElementById("vimma-statusbar")?.querySelector('[data-segment="hover"]')
    ?.textContent ?? "";

add_task(function use_the_default_keymap() {
  VimmaHost.configure({ keymap: compileKeymap({}, { mac: Services.appinfo.OS === "Darwin" }) });
});

/**
 * Opens the fixture with content focus in normal mode, then runs `fn`; the hover is let go
 * after.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 * @param {string} [url]
 */
async function withPage(fn, url = PAGE) {
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal");
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
      run("hover.release");
    }
  });
}

/** @param {string} id */
function run(id) {
  VimmaHost._run(hostState(), { kind: "action", action: { id } });
}

/** The labels drawn in chrome. */
function drawnLabels() {
  const overlay = document.getElementById("vimma-hints");
  if (!overlay) return [];
  return [...overlay.querySelectorAll(".vimma-hint:not([hidden])")].map(
    (el) => /** @type {HTMLElement} */ (el).dataset.label,
  );
}

/** Starts hover hints and waits for the labels. */
async function startHoverHints() {
  for (const k of KEY) EventUtils.synthesizeKey(k);
  await TestUtils.waitForCondition(
    () => VimmaHost._hints(window)?.hints.length && drawnLabels().length,
    "hover labels are drawn",
  );
  const hints = /** @type {HostHints} */ (VimmaHost._hints(window));
  Assert.equal(hints.action, "hint.hover", "gh starts hover hints");
  return hints;
}

/**
 * An element's centre in the top page's CSS pixels: an id in the page, in its shadow root
 * (`#host`), or in its frame (`f:` before the id).
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function centreOf(browser, id) {
  const inFrame = id.startsWith("f:");
  const top = await SpecialPowers.spawn(browser, [inFrame ? "frame" : id], (want) => {
    const doc = content.document;
    const root = /** @type {ShadowRoot} */ (doc.getElementById("host")?.shadowRoot);
    const el = doc.getElementById(want) ?? root.getElementById(want);
    const box = /** @type {Element} */ (el).getBoundingClientRect();
    // A text block's label sits on its first line: the centre of that line's box.
    const range = doc.createRange();
    range.selectNodeContents(/** @type {Element} */ (el));
    const line = [...range.getClientRects()].find((r) => r.width >= 1 && r.height >= 1);
    const r = line && !/^(button|label|a)$/.test(el?.localName ?? "") ? line : box;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: box.x, top: box.y };
  });
  if (!inFrame) return top;
  const inner = await SpecialPowers.spawn(contextOf(browser).children[0], [id.slice(2)], (want) => {
    const r = /** @type {Element} */ (
      content.document.getElementById(want)
    ).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  // The frame's border is 1 px.
  return { x: top.left + 1 + inner.x, y: top.top + 1 + inner.y };
}

/**
 * The label of the innermost hint whose target holds the point.
 * @param {HostHints} hints
 * @param {{ x: number, y: number }} c
 */
function labelAt(hints, c) {
  const area = (/** @type {HostHint} */ h) => h.target.rect.width * h.target.rect.height;
  return hints.hints
    .filter(
      (h) =>
        c.x >= h.target.rect.x &&
        c.x <= h.target.rect.x + h.target.rect.width &&
        c.y >= h.target.rect.y &&
        c.y <= h.target.rect.y + h.target.rect.height,
    )
    .sort((a, b) => area(a) - area(b))[0]?.label;
}

/**
 * Hovers the element with this id through `gh` and its label, and waits for the status bar.
 * @param {XULBrowserElement} browser
 * @param {string} id
 */
async function hover(browser, id) {
  const before = hoverStatus()?.seq ?? -1;
  const hints = await startHoverHints();
  const label = labelAt(hints, await centreOf(browser, id));
  Assert.ok(label, `${id} has a hover label`);
  for (const c of /** @type {string} */ (label)) EventUtils.synthesizeKey(c);
  await TestUtils.waitForCondition(() => (hoverStatus()?.seq ?? -1) !== before, `${id} is hovered`);
}

/**
 * What the page says of these elements: whether each matches `:hover`, has a lock, and shows.
 * @param {XULBrowserElement | BrowsingContext} target
 * @param {string[]} ids
 */
function states(target, ids) {
  return SpecialPowers.spawn(target, [ids], (list) => {
    const doc = content.document;
    /** @type {Record<string, { hover: boolean, locked: boolean, shown: boolean }>} */
    const out = {};
    for (const id of list) {
      const el =
        doc.getElementById(id) ??
        /** @type {ShadowRoot} */ (doc.getElementById("host")?.shadowRoot)?.getElementById(id);
      if (!el) continue;
      out[id] = {
        hover: el.matches(":hover"),
        locked: InspectorUtils.hasPseudoClassLock(el, ":hover"),
        shown: el.checkVisibility(),
      };
    }
    return out;
  });
}

/**
 * What the fixture logged of one event.
 * @typedef {{ type: string, id: string, trusted: boolean, x: number, y: number,
 *   pointerType: string | null, isPrimary: boolean | null, related: string | null }} LogEntry
 */

/**
 * @param {XULBrowserElement} browser
 * @returns {Promise<LogEntry[]>}
 */
function takeLog(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const log = content.wrappedJSObject.vimmaLog;
    const out = JSON.parse(JSON.stringify(log));
    log.length = 0;
    return out;
  });
}

/**
 * Waits until the tab holds no hover, and its segment is gone.
 * @param {string} what
 */
async function released(what) {
  await TestUtils.waitForCondition(() => !hoverStatus(), `${what}: the hover is released`);
  // The bar redraws on its next frame.
  await TestUtils.waitForCondition(() => hoverSegment() === "", `${what}: no hover segment`);
}

add_task(async function test_hover_reveals_css_hover_controls() {
  await withPage(async (browser) => {
    let s = await states(browser, ["gear1"]);
    Assert.ok(!s.gear1.shown, "the gear shows only on hover");
    await hover(browser, "name1");
    s = await states(browser, ["name1", "row1", "gear1", "row2", "gear2"]);
    Assert.ok(s.name1.hover && s.row1.hover, "the text and its row match :hover");
    Assert.ok(s.row1.locked, "the row is locked, as a real pointer hovers its ancestors");
    Assert.ok(s.gear1.shown, "the row's CSS :hover rule shows the gear");
    Assert.ok(!s.row2.hover && !s.gear2.shown, "the other row is not hovered");
    Assert.equal(hoverStatus()?.text, "General", "the status names the element");
    await TestUtils.waitForCondition(() => hoverSegment() === "hover · General", "the segment");
    Assert.equal(VimmaHost._browserMode(browser), "normal", "normal mode stays (decision 7)");
  });
});

add_task(async function test_hover_runs_script_menus() {
  await withPage(async (browser) => {
    await takeLog(browser);
    await hover(browser, "name1");
    const log = await takeLog(browser);
    const centre = await centreOf(browser, "name1");
    Assert.deepEqual(
      log.map((e) => `${e.type}@${e.id}`),
      [
        "pointerover@name1",
        "pointerenter@row1",
        "pointerenter@name1",
        "pointermove@name1",
        "mouseover@name1",
        "mouseenter@row1",
        "mouseenter@name1",
        "mousemove@name1",
      ],
      "the events of a pointer entering the text, in order",
    );
    for (const e of log) {
      Assert.ok(e.trusted, `${e.type} is trusted, as the user's`);
      Assert.equal(e.x, Math.round(centre.x), `${e.type} at the element's centre`);
      if (e.type.startsWith("pointer")) {
        Assert.equal(e.pointerType, "mouse", `${e.type} is a mouse pointer's`);
        Assert.ok(e.isPrimary, `${e.type} is the primary pointer's`);
      }
    }
    // A hover again of the same element: a move within it, no enter or leave.
    await hover(browser, "name1");
    const again = await takeLog(browser);
    Assert.deepEqual(
      again.map((e) => e.type),
      ["pointermove", "mousemove"],
      "the same element again sends only the moves",
    );
    // Moving to the other row: the old one gets the leave events, the new one is entered.
    await hover(browser, "name2");
    const moved = await takeLog(browser);
    const types = moved.map((e) => `${e.type}@${e.id}`);
    for (const t of ["pointerout@name1", "pointerleave@row1", "mouseleave@name1"]) {
      Assert.ok(types.includes(t), `${t} on the move`);
    }
    const over = moved.find((e) => e.type === "mouseover" && e.id === "name2");
    Assert.equal(over?.related, "name1", "relatedTarget is the previous hover target");

    // Script menus: mouseenter, a React-style mouseover and a pointermove of type mouse.
    for (const [id, menu] of [
      ["trigger", "menu"],
      ["react", "react-menu"],
      ["nested", "sub"],
    ]) {
      await hover(browser, id);
      const s = await states(browser, [menu]);
      Assert.ok(s[menu].shown, `${id}'s menu opened`);
    }
  });
});

add_task(async function test_hover_then_f_follows_a_revealed_control() {
  await withPage(async (browser) => {
    await hover(browser, "name1");
    EventUtils.synthesizeKey("f");
    await TestUtils.waitForCondition(
      () => VimmaHost._hints(window)?.hints.length && drawnLabels().length,
      "f labels are drawn",
    );
    const hints = /** @type {HostHints} */ (VimmaHost._hints(window));
    const label = labelAt(hints, await centreOf(browser, "gear1"));
    Assert.ok(label, "f labels the revealed gear");
    for (const c of /** @type {string} */ (label)) EventUtils.synthesizeKey(c);
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(browser, [], () =>
          content.wrappedJSObject.vimmaClicks.includes("gear1"),
        ),
      "the gear is clicked",
    );
    const s = await states(browser, ["row1", "gear1"]);
    Assert.ok(s.row1.hover && s.gear1.shown, "the click does not release the hover (decision 5)");
    Assert.ok(hoverStatus(), "the status still shows the hover");
  });
});

add_task(async function test_hover_holds_while_scrolling() {
  await withPage(async (browser) => {
    // The real pointer rests over the page, away from the rows.
    await BrowserTestUtils.synthesizeMouse(null, 300, 600, { type: "mousemove" }, browser);
    await hover(browser, "name1");
    EventUtils.synthesizeKey("j");
    await TestUtils.waitForCondition(
      () => SpecialPowers.spawn(browser, [], () => content.scrollY > 0),
      "j scrolled the page",
    );
    // A reflow under the resting pointer.
    await SpecialPowers.spawn(browser, [], () => {
      const p = content.document.createElement("p");
      p.textContent = "inserted";
      content.document.getElementById("spacer")?.before(p);
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = await states(browser, ["row1", "gear1"]);
    Assert.ok(s.row1.hover && s.gear1.shown, "scrolling and reflows keep the hover");
    Assert.ok(hoverStatus(), "still held");
  });
});

add_task(async function test_hover_release() {
  // Esc, once the page left it alone.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    EventUtils.synthesizeKey("KEY_Escape");
    await released("Esc");
    const s = await states(browser, ["row1", "name1", "gear1"]);
    Assert.ok(!s.row1.hover && !s.row1.locked && !s.name1.locked, "no lock is left");
    Assert.ok(!s.gear1.shown, "the gear hides again");
    const log = await takeLog(browser);
    const types = log.map((e) => `${e.type}@${e.id}`);
    for (const t of [
      "pointerout@name1",
      "pointerleave@row1",
      "mouseout@name1",
      "mouseleave@row1",
    ]) {
      Assert.ok(types.includes(t), `Esc sent ${t}`);
    }
  });
  // A page that takes Esc keeps the hover; the next Esc it leaves alone releases it.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.vimmaEatEsc = true;
    });
    EventUtils.synthesizeKey("KEY_Escape");
    await SpecialPowers.spawn(browser, [], () => {});
    await new Promise((r) => setTimeout(r, 200));
    Assert.ok(hoverStatus(), "a page that takes Esc keeps the hover");
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.vimmaEatEsc = false;
    });
    EventUtils.synthesizeKey("KEY_Escape");
    await released("the second Esc");
  });
  // :hover_release.
  await withPage(async () => {
    const browser = gBrowser.selectedBrowser;
    await hover(browser, "name1");
    run("hover.release");
    await released("hover.release");
  });
  // A navigation.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    BrowserTestUtils.startLoadingURIString(browser, OTHER);
    await BrowserTestUtils.browserLoaded(browser, false, OTHER);
    await released("a navigation");
  });
  // A tab switch, and the tab coming back unhovered.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, OTHER);
    await released("a tab switch");
    BrowserTestUtils.removeTab(other);
    await TestUtils.waitForCondition(() => gBrowser.selectedBrowser === browser);
    const s = await states(browser, ["row1"]);
    Assert.ok(!s.row1.hover && !s.row1.locked, "the old tab's row is let go");
  });
  // A real mouse move.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    await BrowserTestUtils.synthesizeMouse(null, 300, 700, { type: "mousemove" }, browser);
    await released("a real mouse move");
    const s = await states(browser, ["row1"]);
    Assert.ok(!s.row1.locked, "no lock left after the mouse moved");
  });
});

add_task(async function test_hover_bfcache() {
  await withPage(async (browser) => {
    await hover(browser, "name1");
    BrowserTestUtils.startLoadingURIString(browser, OTHER);
    await BrowserTestUtils.browserLoaded(browser, false, OTHER);
    await released("leaving into the back-forward cache");
    const shown = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
    browser.goBack();
    await shown;
    const persisted = await SpecialPowers.spawn(
      browser,
      [],
      () => !!content.document.getElementById("row1"),
    );
    Assert.ok(persisted, "back on the fixture");
    const s = await states(browser, ["row1", "name1"]);
    Assert.ok(!s.row1.hover && !s.row1.locked && !s.name1.locked, "no lock came back");
    Assert.ok(!hoverStatus(), "no hover in the status bar");
  });
});

add_task(async function test_hover_target_leaves() {
  await withPage(async (browser) => {
    await hover(browser, "name1");
    // The page replaces the hovered text, as a framework re-render does.
    await SpecialPowers.spawn(browser, [], () => {
      const old = /** @type {Element} */ (content.document.getElementById("name1"));
      const fresh = content.document.createElement("span");
      fresh.id = "name1b";
      fresh.textContent = "General";
      old.replaceWith(fresh);
      content.wrappedJSObject.vimmaOld = old;
    });
    await released("the element replaced");
    const s = await states(browser, ["row1"]);
    Assert.ok(!s.row1.locked, "its row is unlocked");
    const oldLocked = await SpecialPowers.spawn(browser, [], () =>
      InspectorUtils.hasPseudoClassLock(content.wrappedJSObject.vimmaOld, ":hover"),
    );
    Assert.ok(!oldLocked, "the removed element keeps no lock");
  });
  // Moved under another parent.
  await withPage(async (browser) => {
    await hover(browser, "name1");
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      doc.getElementById("row2")?.append(/** @type {Element} */ (doc.getElementById("name1")));
    });
    await released("the element moved");
    const s = await states(browser, ["row1", "row2"]);
    Assert.ok(!s.row1.locked && !s.row2.locked, "neither row keeps a lock");
  });
});

add_task(async function test_hover_changes_nothing_else() {
  await withPage(async (browser) => {
    const before = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.activeElement?.id ?? "",
    );
    await hover(browser, "name1");
    const after = await SpecialPowers.spawn(browser, [], () => ({
      focus: content.document.activeElement?.id ?? "",
      selection: String(content.getSelection()),
      clicks: [...content.wrappedJSObject.vimmaClicks],
      active: content.navigator.userActivation.hasBeenActive,
    }));
    Assert.equal(after.focus, before, "no focus moved");
    Assert.equal(after.selection, "", "nothing selected");
    Assert.deepEqual(after.clicks, [], "nothing clicked");
    Assert.ok(!after.active, "no user activation");
  });
});

add_task(async function test_hover_keeps_devtools_locks() {
  await withPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      InspectorUtils.addPseudoClassLock(
        /** @type {Element} */ (content.document.getElementById("row1")),
        ":hover",
      );
    });
    await hover(browser, "name1");
    run("hover.release");
    await released("hover.release");
    const s = await states(browser, ["row1", "name1"]);
    Assert.ok(s.row1.locked, "the lock DevTools set before the hover stays");
    Assert.ok(!s.name1.locked, "Vimma's own lock is gone");
  });
});

add_task(async function test_hover_link_preview() {
  await withPage(async (browser) => {
    await hover(browser, "link");
    await TestUtils.waitForCondition(
      () => XULBrowserWindow.overLink.includes("example.com/docs"),
      "the link preview shows the hovered link",
    );
    run("hover.release");
    await released("hover.release");
    await TestUtils.waitForCondition(() => XULBrowserWindow.overLink === "", "preview cleared");
  });
});

add_task(async function test_hover_targets() {
  await withPage(async (browser) => {
    const hints = await startHoverHints();
    const at = async (/** @type {string} */ id) => labelAt(hints, await centreOf(browser, id));
    Assert.ok(await at("plain"), "a paragraph with nothing inside is a hover target");
    const link = await at("link");
    const paraRect = await centreOf(browser, "para");
    const paraLabels = hints.hints.filter((h) => {
      const r = h.target.rect;
      return paraRect.y >= r.y && paraRect.y <= r.y + r.height && h.label !== link;
    });
    Assert.deepEqual(
      paraLabels.map((h) => h.target.kind),
      [],
      "a paragraph holding a link gets no label of its own (innermost wins)",
    );
    EventUtils.synthesizeKey("KEY_Escape");
  });
});

add_task(async function test_hover_shadow_dom_and_labels() {
  await withPage(async (browser) => {
    await hover(browser, "inner");
    let s = await states(browser, ["host", "inner"]);
    Assert.ok(s.inner.hover && s.host.hover, "the shadow host is hovered with its content");
    await hover(browser, "lab");
    s = await states(browser, ["lab", "field"]);
    Assert.ok(s.lab.hover && s.field.hover, "a hovered label hovers its control");
    Assert.ok(!(await states(browser, ["host"])).host.hover, "the move let the host go");
  });
});

add_task(async function test_hover_in_frames() {
  await withPage(async (browser) => {
    const frameBC = contextOf(browser).children[0];
    await SpecialPowers.spawn(frameBC, [], async () => {
      if (content.document.readyState !== "complete") {
        await new Promise((r) => content.addEventListener("load", r, { once: true }));
      }
    });
    await hover(browser, "f:fname");
    const inner = await states(frameBC, ["frow", "fgear"]);
    Assert.ok(inner.frow.hover && inner.fgear.shown, "the frame's row is hovered");
    let outer = await states(browser, ["frame"]);
    Assert.ok(outer.frame.hover && outer.frame.locked, "the <iframe> element is hovered too");
    run("hover.release");
    await released("hover.release in a frame");
    await TestUtils.waitForCondition(
      async () => !(await states(browser, ["frame"])).frame.locked,
      "the <iframe> element is let go",
    );
    outer = await states(browser, ["frame"]);
    Assert.ok(!outer.frame.hover, "no hover left on the <iframe>");
    // Removing the <iframe> ends a hover inside it, and its chain's locks.
    await hover(browser, "f:fname");
    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("frame")?.remove(),
    );
    await released("the frame removed");
    const body = await SpecialPowers.spawn(browser, [], () =>
      InspectorUtils.hasPseudoClassLock(content.document.body, ":hover"),
    );
    Assert.ok(!body, "the body keeps no lock");
  });
});

add_task(async function test_hover_malformed_messages() {
  await withPage(async (browser) => {
    const actor = windowGlobalOf(contextOf(browser)).getActor("Vimma");
    for (const data of [
      null,
      { op: "nope" },
      { op: "hover", gen: 99999, id: 0 },
      { op: "hover", gen: -1, id: 0 },
      { op: "hover", gen: "1", id: 0 },
    ]) {
      const reply = await actor.sendQuery("Vimma:Hover", data);
      Assert.deepEqual(reply, { hovered: false }, `refused: ${JSON.stringify(data)}`);
    }
    // An embedder lock naming a frame that is not this document's child.
    actor.sendAsyncMessage("Vimma:HoverEmbedder", {
      op: "lock",
      frame: contextOf(browser).id,
    });
    actor.sendAsyncMessage("Vimma:HoverEmbedder", { op: "lock", frame: 1e12 });
    await SpecialPowers.spawn(browser, [], () => {});
    const s = await states(browser, ["frame"]);
    Assert.ok(!s.frame.locked, "no lock for a frame that is not the receiver's child");
    const any = await SpecialPowers.spawn(browser, [], () =>
      [...content.document.querySelectorAll("*")].some((e) =>
        InspectorUtils.hasPseudoClassLock(e, ":hover"),
      ),
    );
    Assert.ok(!any, "no element was locked");
  });
});

add_task(async function test_hover_released_while_asked() {
  await withPage(async (browser) => {
    await SpecialPowers.spawn(browser, [], () => {
      content.wrappedJSObject.vimmaSpin = 800;
    });
    const hints = await startHoverHints();
    const label = labelAt(hints, await centreOf(browser, "name1"));
    Assert.ok(label, "name1 has a hover label");
    for (const c of /** @type {string} */ (label)) EventUtils.synthesizeKey(c);
    // The frame is still in the page's mouseover: the release comes before its answer.
    run("hover.release");
    await SpecialPowers.spawn(browser, [], () => {});
    await new Promise((r) => setTimeout(r, 300));
    Assert.ok(!hoverStatus(), "no hover is shown");
    const s = await states(browser, ["row1", "name1"]);
    Assert.ok(!s.row1.locked && !s.name1.locked, "the frame let the late hover go");
  });
});

add_task(async function test_hover_move_onto_a_removed_element() {
  await withPage(async (browser) => {
    await hover(browser, "name1");
    const hints = await startHoverHints();
    const label = labelAt(hints, await centreOf(browser, "name2"));
    Assert.ok(label, "name2 has a hover label");
    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("name2")?.remove(),
    );
    for (const c of /** @type {string} */ (label)) EventUtils.synthesizeKey(c);
    await released("a move onto a removed element");
    await TestUtils.waitForCondition(
      async () => !(await states(browser, ["row1"])).row1.locked,
      "the old hover is let go, not left behind",
    );
  });
});
