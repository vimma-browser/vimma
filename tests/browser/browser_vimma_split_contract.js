/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Contract and spike for split panes on Firefox's own split view (docs/specs/m4-split-panes.md,
// sub-spec 1; ADR-013's acceptance criteria). It pins the upstream behaviour we build on with
// wrappers of three and four tabs, never only two, so a Firefox update that narrows the split
// view fails here. The pane trees are built with vimma-core's pane ops and the rectangles come
// from its layout(), as PaneView's are (sub-spec 2).

/* global focusContent -- from head.js */

"use strict";

const { applyLayout, setHidden, clearLayout } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/layout.mjs",
);
const { PaneViews, PANE_VIEW_EVENTS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { DOMFullscreenTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs",
);
DOMFullscreenTestUtils.init(this, window);

const WIDTH = 1280;
const HEIGHT = 800;
const TOLERANCE = 1;
const SCROLL_Y = 600;

const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");

/** Pane trees use each tab's linkedPanel as its tab id. */
function idOf(tab) {
  return tab.linkedPanel;
}

/** x[a, y[b, c]]: split a right, then split the new pane down. */
function lShape([a, b, c]) {
  const s = Panes.split(Panes.createPanes(idOf(a)), "p1", "vertical", idOf(b));
  return Panes.split(s, "p2", "horizontal", idOf(c));
}

/** a | b | c: split right twice (core halves the focused pane, so .5 / .25 / .25). */
function row([a, b, c]) {
  const s = Panes.split(Panes.createPanes(idOf(a)), "p1", "vertical", idOf(b));
  return Panes.split(s, "p2", "vertical", idOf(c));
}

/**
 * x[y[g1, g3], y[g2, g4]], resized to uneven ratios so the edges are rounded
 * (1280 × .37 = 473.6, 760 × .61 = 463.6).
 */
function grid([g1, g2, g3, g4]) {
  let s = Panes.split(Panes.createPanes(idOf(g1)), "p1", "vertical", idOf(g2));
  s = Panes.split(s, "p1", "horizontal", idOf(g3));
  s = Panes.split(s, "p2", "horizontal", idOf(g4));
  s = Panes.focusPane(s, "p1");
  s = Panes.resize(s, "narrower", 0.13);
  s = Panes.resize(s, "shorter", 0.05);
  s = Panes.focusPane(s, "p2");
  return Panes.resize(s, "taller", 0.11);
}

/**
 * core layout() of a pane state over the content area, keyed by tab.
 * @returns {Map<object, {x: number, y: number, width: number, height: number}>}
 */
function rectsOf(state, tabs) {
  const byId = new Map(tabs.map((t) => [idOf(t), t]));
  return new Map(Panes.layout(state, area()).map((r) => [byId.get(r.tab), r.rect]));
}

/**
 * Names for a list of tabs, panels or browsers: Assert.deepEqual compares DOM elements
 * structurally (any two are "equal"), so lists of elements are compared by name.
 */
function names(els) {
  return [...els].map((el) => {
    if (el.localName === "tab") return el.label;
    if (el.localName === "browser") return gBrowser.getTabForBrowser(el).label;
    return el.id;
  });
}

function tabpanels() {
  return document.getElementById("tabbrowser-tabpanels");
}

function panelOf(tab) {
  return document.getElementById(tab.linkedPanel);
}

/** The content area as an integer rect at 0,0, as the host passes it to layout(). */
function area() {
  const r = tabpanels().getBoundingClientRect();
  return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) };
}

/** An element's rect relative to #tabbrowser-tabpanels. */
function relRect(el) {
  const o = tabpanels().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.x - o.x, y: r.y - o.y, width: r.width, height: r.height };
}

function maxDelta(a, b) {
  return Math.max(...["x", "y", "width", "height"].map((k) => Math.abs(a[k] - b[k])));
}

/** Asserts panel and browser of every tab sit at their rect within ±1 px; returns the deltas. */
function assertRects(rects, what) {
  const deltas = [];
  for (const [tab, want] of rects) {
    const label = tab.linkedBrowser.currentURI.spec.match(/<title>(\w+)/)?.[1] ?? tab.label;
    const panel = relRect(panelOf(tab));
    const browser = relRect(tab.linkedBrowser);
    const dp = maxDelta(panel, want);
    const db = maxDelta(browser, want);
    deltas.push(dp, db);
    info(`${what} ${label}: want ${JSON.stringify(want)} panel ${JSON.stringify(panel)}`);
    Assert.lessOrEqual(dp, TOLERANCE, `${what}: ${label}'s panel is at its rect (Δ ${dp} px)`);
    Assert.lessOrEqual(db, TOLERANCE, `${what}: ${label}'s browser fills its rect (Δ ${db} px)`);
  }
  return Math.max(...deltas);
}

function assertActive(tabs, what) {
  for (const tab of tabs) {
    Assert.ok(tab.linkedBrowser.docShellIsActive, `${what}: ${tab.label}'s docshell is active`);
    Assert.ok(
      panelOf(tab).classList.contains("split-view-panel-active"),
      `${what}: ${tab.label}'s panel is a visible split panel`,
    );
  }
}

async function setWindowSize() {
  if (window.outerWidth !== WIDTH || window.outerHeight !== HEIGHT) {
    const resized = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeTo(WIDTH, HEIGHT);
    await resized;
  }
  await TestUtils.waitForCondition(
    () => window.outerWidth === WIDTH && window.outerHeight === HEIGHT,
    "window has its test size",
  );
}

function pageURL(name) {
  return `data:text/html,<title>${name}</title><body style="height:5000px">${name}</body>`;
}

const opened = [];
/** Opens one loaded background tab per name. */
async function openTabs(...names) {
  const tabs = [];
  for (const name of names) {
    const tab = BrowserTestUtils.addTab(gBrowser, pageURL(name));
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tab.label = name;
    tabs.push(tab);
    opened.push(tab);
  }
  return tabs;
}

/** Selects tabs[0], then puts every tab into one split view. */
async function split(tabs) {
  await BrowserTestUtils.switchTab(gBrowser, tabs[0]);
  const activated = BrowserTestUtils.waitForEvent(window, "TabSplitViewActivate");
  const wrapper = gBrowser.addTabSplitView(tabs, { insertBefore: tabs[0] });
  await activated;
  Assert.deepEqual(names(wrapper.tabs), names(tabs), "every tab is in the one wrapper, in order");
  return wrapper;
}

function cleanup(tabs) {
  clearLayout(window, tabs);
  for (const tab of tabs) if (!tab.closing && tab.parentNode) gBrowser.removeTab(tab);
}

async function scrollPage(browser, y) {
  await SpecialPowers.spawn(browser, [y], (top) => {
    content.scrollTo(0, top);
  });
}

function scrollYOf(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/** Console errors (not warnings) while it runs. */
function collectErrors() {
  const errors = [];
  const listener = {
    observe(msg) {
      if (msg instanceof Ci.nsIScriptError && !(msg.flags & Ci.nsIScriptError.warningFlag)) {
        errors.push(`${msg.errorMessage} (${msg.sourceName}:${msg.lineNumber})`);
      }
    },
  };
  Services.console.registerListener(listener);
  return {
    errors,
    stop() {
      Services.console.unregisterListener(listener);
    },
  };
}

/** The computed colour of a CSS colour expression in the chrome document. */
function colourOf(value) {
  const probe = document.createElement("div");
  probe.style.color = value;
  document.documentElement.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** The focused pane's border width, --vimma-pane-focus-width on #tabbrowser-tabpanels. */
function focusWidth() {
  return getComputedStyle(tabpanels()).getPropertyValue("--vimma-pane-focus-width").trim();
}

/** The outline a tab's .browserContainer draws. */
function outlineOf(tab) {
  const style = getComputedStyle(panelOf(tab).querySelector(".browserContainer"));
  return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle };
}

/** The frame a tab's .browserContainer::after draws over its page, or null when it has none. */
function frameOf(tab) {
  const style = getComputedStyle(panelOf(tab).querySelector(".browserContainer"), "::after");
  if (style.content === "none" || style.borderTopStyle === "none") return null;
  const sides = ["Top", "Right", "Bottom", "Left"];
  return {
    widths: [...new Set(sides.map((s) => style[`border${s}Width`]))].join(" "),
    style: style.borderTopStyle,
    color: [...new Set(sides.map((s) => style[`border${s}Color`]))].join(" "),
    position: style.position,
    inset: [style.top, style.right, style.bottom, style.left].join(" "),
    pointerEvents: style.pointerEvents,
  };
}

/** Whether a tab's pane draws the focus border: a 3 px frame in the focus colour. */
function hasBorder(tab) {
  const f = frameOf(tab);
  return !!f && f.widths === "3px" && f.color === colourOf("var(--focus-outline-color)");
}

/**
 * Asserts `focused` has the focus border (docs/specs/pane-focus-highlight.md: 3 px on all four
 * edges, inside its rect, in the theme's focus colour) and every other tab keeps the 1 px
 * separator outline in another colour and no frame.
 */
function assertBorders(tabs, focused, what) {
  const focusColor = colourOf("var(--focus-outline-color)");
  Assert.equal(focusWidth(), "3px", `${what}: --vimma-pane-focus-width is 3px`);
  for (const tab of tabs) {
    const f = frameOf(tab);
    const o = outlineOf(tab);
    info(`${what}: ${tab.label} frame ${JSON.stringify(f)} outline ${JSON.stringify(o)}`);
    if (tab === focused) {
      Assert.ok(f, `${what}: ${tab.label} has a frame`);
      Assert.equal(f?.style, "solid", `${what}: ${tab.label}'s border is solid`);
      Assert.equal(f?.widths, "3px", `${what}: ${tab.label}'s border is 3 px on every edge`);
      Assert.equal(f?.color, focusColor, `${what}: ${tab.label}'s border is the focus colour`);
      Assert.equal(f?.position, "absolute", `${what}: ${tab.label}'s frame takes no space`);
      Assert.equal(f?.inset, "0px 0px 0px 0px", `${what}: ${tab.label}'s frame is inside its rect`);
      Assert.equal(f?.pointerEvents, "none", `${what}: ${tab.label}'s frame takes no clicks`);
      Assert.equal(o.style, "none", `${what}: ${tab.label} draws no outline into the gap`);
    } else {
      Assert.equal(f, null, `${what}: ${tab.label} has no frame`);
      Assert.equal(o.width, "1px", `${what}: ${tab.label} keeps the 1 px separator`);
      Assert.notEqual(
        o.color,
        focusColor,
        `${what}: ${tab.label}'s separator is not the focus colour`,
      );
    }
  }
}

/**
 * The colour painted at a point of the window, in client CSS px, with the pages' remote content
 * composited in: what the user sees, which getComputedStyle cannot tell (a style on the
 * container can be covered by the page).
 */
async function paintedAt(x, y) {
  const bitmap = await window.browsingContext.currentWindowGlobal.drawSnapshot(
    new DOMRect(x, y, 1, 1),
    1,
    "black",
  );
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Asserts the border is painted: 1 px inside the focused pane's left edge, halfway down, the
 * window shows the focus colour, and at the same place in every other pane it does not.
 */
async function assertPaintedBorder(tabs, focused, what) {
  const focusColor = colourOf("var(--focus-outline-color)");
  for (const tab of tabs) {
    const r = panelOf(tab).getBoundingClientRect();
    const painted = await paintedAt(r.x + 1, r.y + r.height / 2);
    info(`${what}: ${tab.label} painted ${painted} at its left edge`);
    if (tab === focused) {
      Assert.equal(painted, focusColor, `${what}: ${tab.label}'s border is painted over its page`);
    } else {
      Assert.notEqual(painted, focusColor, `${what}: ${tab.label} shows no border`);
    }
  }
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// This file pins Firefox's split view on its own. Vimma's PaneView adopts any split made with
// Firefox's API (sub-spec 6), so its listeners are off while this file runs.
const paneView = PaneViews.get(window);
for (const type of PANE_VIEW_EVENTS) window.removeEventListener(type, paneView);

const startSize = [window.outerWidth, window.outerHeight];
registerCleanupFunction(() => {
  for (const type of PANE_VIEW_EVENTS) window.addEventListener(type, paneView);
  window.resizeTo(...startSize);
  // A failed task leaves its tabs: close them so later tasks start from one tab.
  for (const tab of opened) if (!tab.closing && tab.parentNode) gBrowser.removeTab(tab);
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

add_task(async function an_L_shape_of_three_tabs_puts_every_active_panel_at_its_rect() {
  await setWindowSize();
  const [p1, p2, p3] = await openTabs("p1", "p2", "p3");
  await split([p1, p2, p3]);
  const rects = rectsOf(lShape([p1, p2, p3]), [p1, p2, p3]);
  applyLayout(window, rects);
  assertActive([p1, p2, p3], "L shape");
  const delta = assertRects(rects, "L shape");
  info(`L shape: area ${JSON.stringify(area())}, max Δ ${delta} px`);

  gBrowser.selectedTab = p3;
  await nextFrame();
  assertActive([p1, p2, p3], "L shape, p3 selected");
  assertRects(rects, "L shape, p3 selected");
  cleanup([p1, p2, p3]);
});

add_task(async function a_two_by_two_grid_of_four_tabs_puts_every_active_panel_at_its_rect() {
  await setWindowSize();
  const tabs = await openTabs("g1", "g2", "g3", "g4");
  await split(tabs);
  const rects = rectsOf(grid(tabs), tabs);
  applyLayout(window, rects);
  assertActive(tabs, "grid");
  const delta = assertRects(rects, "grid");
  info(`grid: max Δ ${delta} px`);
  for (const tab of tabs) {
    gBrowser.selectedTab = tab;
    await nextFrame();
    assertActive(tabs, `grid, ${tab.label} selected`);
  }
  assertRects(rects, "grid after selecting each pane");
  cleanup(tabs);
});

add_task(async function focusing_or_clicking_a_pane_selects_its_tab_and_the_url_bar_follows() {
  await setWindowSize();
  const tabs = await openTabs("f1", "f2", "f3");
  const [f1, f2, f3] = tabs;
  await split(tabs);
  applyLayout(window, rectsOf(row(tabs), tabs));

  await focusContent(f3.linkedBrowser);
  Assert.equal(gBrowser.selectedTab, f3, "focusing f3's browser selects f3");
  Assert.equal(gURLBar.value, pageURL("f3"), "the URL bar shows f3's URL");

  // A click in f2's page: the parent sees it on the <browser> before content does.
  await EventUtils.synthesizeMouseAtCenter(f2.linkedBrowser, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === f2, "click selects f2");
  Assert.equal(gURLBar.value, pageURL("f2"), "the URL bar shows f2's URL");
  assertActive(tabs, "after focus and click");

  Assert.equal(f1.linkedBrowser.docShellIsActive, true, "the unfocused f1 stays active");
  cleanup(tabs);
});

add_task(async function the_focus_outline_find_bar_and_notifications_belong_to_their_pane() {
  // Opening a find bar sets this pref; pushPrefEnv restores it, so the harness sees no change.
  await SpecialPowers.pushPrefEnv({ set: [["accessibility.typeaheadfind.flashBar", 0]] });
  await setWindowSize();
  const tabs = await openTabs("n1", "n2", "n3");
  const [n1, n2, n3] = tabs;
  await split(tabs);
  const state = lShape(tabs);
  const rects = rectsOf(state, tabs);
  applyLayout(window, rects);

  // Focus border (docs/specs/pane-focus-highlight.md): only the selected (deck-selected)
  // panel's browserContainer draws the border; the others keep the 1 px separator outline.
  await focusContent(n3.linkedBrowser);
  Assert.ok(panelOf(n3).classList.contains("deck-selected"), "n3's panel is deck-selected");
  assertBorders(tabs, n3, "n3 focused");

  // Find bar: the selected tab's find bar, as Firefox's accel+f opens it, is inside n3's panel.
  // Not the key itself: [firefox] disable = "all" turns accel+f off in insert mode
  // (docs/specs/firefox-keys.md decision 16).
  (await gBrowser.getFindBar()).open();
  await TestUtils.waitForCondition(
    () => gBrowser.isFindBarInitialized(n3) && !gBrowser.getCachedFindBar(n3).hidden,
    "n3's find bar opens",
  );
  const findbar = gBrowser.getCachedFindBar(n3);
  Assert.ok(panelOf(n3).contains(findbar), "the find bar is inside n3's panel");
  for (const tab of [n1, n2]) {
    Assert.ok(
      !gBrowser.isFindBarInitialized(tab) || gBrowser.getCachedFindBar(tab).hidden,
      `${tab.label} has no open find bar`,
    );
  }
  await nextFrame();
  const fb = relRect(findbar);
  const want = rects.get(n3);
  Assert.ok(
    fb.x >= want.x - TOLERANCE &&
      fb.y >= want.y - TOLERANCE &&
      fb.x + fb.width <= want.x + want.width + TOLERANCE &&
      fb.y + fb.height <= want.y + want.height + TOLERANCE,
    `the find bar ${JSON.stringify(fb)} is within n3's rect ${JSON.stringify(want)}`,
  );
  Assert.lessOrEqual(maxDelta(relRect(panelOf(n3)), want), TOLERANCE, "n3's panel keeps its rect");
  findbar.close(true);

  // Notification bar: one appended for n2 shows in n2's panel, not in the shared deck.
  const box = gBrowser.getNotificationBox(n2.linkedBrowser);
  await box.appendNotification("vimma-split-test", {
    label: "n2's notification",
    priority: box.PRIORITY_INFO_LOW,
  });
  Assert.equal(
    box._stack.parentNode,
    gBrowser.getBrowserContainer(n2.linkedBrowser),
    "n2's notification box is inside n2's browserContainer",
  );
  await nextFrame();
  const nb = relRect(box._stack);
  const n2rect = rects.get(n2);
  Assert.ok(
    nb.height > 0 &&
      nb.x >= n2rect.x - TOLERANCE &&
      nb.y >= n2rect.y - TOLERANCE &&
      nb.y + nb.height <= n2rect.y + n2rect.height + TOLERANCE,
    `n2's notification ${JSON.stringify(nb)} shows within n2's rect ${JSON.stringify(n2rect)}`,
  );
  cleanup(tabs);
});

add_task(
  async function dom_fullscreen_in_one_pane_fills_the_window_and_exiting_restores_the_rects() {
    await setWindowSize();
    const tabs = await openTabs("s1", "s2", "s3");
    const [s1, s2, s3] = tabs;
    await split(tabs);
    const state = lShape(tabs);
    const rects = rectsOf(state, tabs);
    applyLayout(window, rects);
    await focusContent(s2.linkedBrowser);
    Assert.equal(gBrowser.selectedTab, s2, "s2 is the focused pane");

    await DOMFullscreenTestUtils.changeFullscreen(s2.linkedBrowser, true);
    Assert.ok(document.documentElement.hasAttribute("inDOMFullscreen"), "in DOM fullscreen");
    await nextFrame();
    const panel = panelOf(s2).getBoundingClientRect();
    const full = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    const fsDelta = maxDelta(panel, full);
    info(`fullscreen: s2 panel ${JSON.stringify(panel.toJSON())}, window ${JSON.stringify(full)}`);
    Assert.lessOrEqual(fsDelta, TOLERANCE, `s2's panel fills the window (Δ ${fsDelta} px)`);
    // What the user sees where s3 was: the fullscreen s2. (Upstream hides the other panels with
    // -moz-subtree-hidden-only-visually, which getComputedStyle does not expose.)
    const s3centre = rects.get(s3);
    const o = tabpanels().getBoundingClientRect();
    const hit = document.elementFromPoint(
      o.x + s3centre.x + s3centre.width / 2,
      o.y + s3centre.y + s3centre.height / 2,
    );
    Assert.ok(panelOf(s2).contains(hit), "where s3 was, the fullscreen s2 is hit, not s3");
    for (const tab of [s1, s3]) {
      Assert.ok(tab.linkedBrowser.docShellIsActive, `${tab.label} stays active under fullscreen`);
    }

    await DOMFullscreenTestUtils.changeFullscreen(s2.linkedBrowser, false);
    await TestUtils.waitForCondition(
      () => !document.documentElement.hasAttribute("inDOMFullscreen"),
      "out of DOM fullscreen",
    );
    await setWindowSize();
    await nextFrame();
    const after = rectsOf(state, tabs);
    Assert.deepEqual([...after.values()], [...rects.values()], "the content area is the same size");
    const delta = assertRects(rects, "after fullscreen");
    info(`after fullscreen: max Δ ${delta} px`);
    assertActive(tabs, "after fullscreen");
    cleanup(tabs);
  },
);

add_task(async function zoom_hides_the_other_panes_visually_and_unzoom_restores_them() {
  await setWindowSize();
  const tabs = await openTabs("z1", "z2", "z3");
  const [z1, z2, z3] = tabs;
  await split(tabs);
  const state = lShape(tabs);
  const rects = rectsOf(state, tabs);
  // core's zoomed layout: one rectangle, the whole area.
  const zoomed = rectsOf(Panes.toggleZoom(Panes.focusPane(state, "p3")), tabs);
  Assert.deepEqual(names(zoomed.keys()), ["z3"], "core zooms z3 alone");
  const full = zoomed.get(z3);
  Assert.deepEqual(full, area(), "core gives the zoomed z3 the whole area");
  applyLayout(window, rects);
  await scrollPage(z1.linkedBrowser, SCROLL_Y);
  await scrollPage(z2.linkedBrowser, SCROLL_Y);
  // The CSS is checked on z1: content-area.css gives column 0 (z1) z-index 1, so it paints, and
  // hit-tests, on top of a full-size z3 unless hidden (the control). getComputedStyle does not
  // expose -moz-subtree-hidden-only-visually, so the hit test is the check. z2 is the selected
  // panel here; it is not on top of z3 even unhidden, so the hit test cannot tell for z2.
  gBrowser.selectedTab = z2;
  /** The element at the centre of a tab's unzoomed rect. */
  const hitAt = (tab) => {
    const o = tabpanels().getBoundingClientRect();
    const r = rects.get(tab);
    return document.elementFromPoint(o.x + r.x + r.width / 2, o.y + r.y + r.height / 2);
  };

  // Control: z3 at the full rect without hiding the others, and z1 still wins the hit test.
  applyLayout(window, new Map([[z3, full]]));
  Assert.ok(panelOf(z1).contains(hitAt(z1)), "control: unhidden, z1 is on top of z3");

  for (const tab of [z1, z2]) setHidden(window, tab, true);
  await nextFrame();
  assertRects(new Map([[z3, full]]), "zoomed");
  for (const tab of [z1, z2]) {
    Assert.ok(
      panelOf(z3).contains(hitAt(tab)),
      `zoomed: ${tab.label}'s area hits z3, not ${tab.label}`,
    );
    Assert.ok(
      tab.linkedBrowser.docShellIsActive,
      `${tab.label}'s docshell stays active (CSS alone)`,
    );
  }
  gBrowser.selectedTab = z3;
  await nextFrame();
  assertRects(new Map([[z3, full]]), "zoomed, z3 selected");

  for (const tab of [z1, z2]) setHidden(window, tab, false);
  applyLayout(window, rects);
  await nextFrame();
  assertRects(rects, "unzoomed");
  assertActive(tabs, "unzoomed");
  Assert.equal(
    await scrollYOf(z1.linkedBrowser),
    SCROLL_Y,
    "the zoomed-away z1 keeps its scroll position",
  );
  Assert.equal(
    await scrollYOf(z2.linkedBrowser),
    SCROLL_Y,
    "the zoomed-away z2 keeps its scroll position",
  );
  cleanup(tabs);
});

add_task(async function the_focused_pane_has_the_focus_border() {
  await setWindowSize();
  const tabs = await openTabs("b1", "b2", "b3");
  const [b1, b2, b3] = tabs;
  await split(tabs);
  applyLayout(window, rectsOf(lShape(tabs), tabs));
  await focusContent(b3.linkedBrowser);
  await nextFrame();
  assertBorders(tabs, b3, "b3 focused");
  await assertPaintedBorder(tabs, b3, "b3 focused");

  // Picking another pane's tab moves the border at once (no transition).
  gBrowser.selectedTab = b1;
  await nextFrame();
  assertBorders(tabs, b1, "b1 picked");
  await assertPaintedBorder(tabs, b1, "b1 picked");
  Assert.equal(
    getComputedStyle(panelOf(b1).querySelector(".browserContainer")).transitionDuration,
    "0s",
    "the border does not animate",
  );
  await EventUtils.synthesizeMouseAtCenter(b2.linkedBrowser, {});
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === b2, "click selects b2");
  await nextFrame();
  assertBorders(tabs, b2, "b2 clicked");
  cleanup(tabs);
});

add_task(async function the_pages_keep_their_size_when_focus_moves() {
  await setWindowSize();
  const tabs = await openTabs("k1", "k2", "k3");
  await split(tabs);
  const rects = rectsOf(lShape(tabs), tabs);
  applyLayout(window, rects);
  for (const tab of tabs) {
    gBrowser.selectedTab = tab;
    await nextFrame();
    Assert.ok(hasBorder(tab), `${tab.label} focused has the border`);
    assertRects(rects, `${tab.label} focused`);
  }
  cleanup(tabs);
});

add_task(async function one_pane_zoom_hidden_split_and_fullscreen_show_no_border() {
  await setWindowSize();
  const [solo] = await openTabs("solo");
  await BrowserTestUtils.switchTab(gBrowser, solo);
  await nextFrame();
  Assert.equal(outlineOf(solo).style, "none", "one pane: no outline");
  Assert.equal(frameOf(solo), null, "one pane: no frame");
  Assert.ok(!hasBorder(solo), "one pane: no border");

  const tabs = await openTabs("h1", "h2", "h3");
  const [h1, h2, h3] = tabs;
  await split(tabs);
  const state = lShape(tabs);
  const rects = rectsOf(state, tabs);
  applyLayout(window, rects);
  gBrowser.selectedTab = h3;
  await nextFrame();
  Assert.ok(hasBorder(h3), "split: h3 has the border");

  // Zoom h3 as the host does: one full rect, the other panels zoomed away.
  applyLayout(window, rectsOf(Panes.toggleZoom(Panes.focusPane(state, "p3")), tabs));
  for (const tab of [h1, h2]) setHidden(window, tab, true);
  await nextFrame();
  Assert.ok(!hasBorder(h3), "zoomed: h3 has no border");
  for (const tab of [h1, h2]) setHidden(window, tab, false);
  applyLayout(window, rects);
  await nextFrame();
  Assert.ok(hasBorder(h3), "unzoomed: h3 has the border again");

  // The hidden split: a tab outside it is selected and shown alone.
  await BrowserTestUtils.switchTab(gBrowser, solo);
  await nextFrame();
  for (const tab of [solo, ...tabs]) Assert.ok(!hasBorder(tab), `hidden split: ${tab.label}`);
  await BrowserTestUtils.switchTab(gBrowser, h2);
  await nextFrame();
  Assert.ok(hasBorder(h2), "split back: the focused h2 has the border");

  await DOMFullscreenTestUtils.changeFullscreen(h2.linkedBrowser, true);
  await nextFrame();
  for (const tab of tabs) Assert.ok(!hasBorder(tab), `fullscreen: ${tab.label} has no border`);
  await DOMFullscreenTestUtils.changeFullscreen(h2.linkedBrowser, false);
  await TestUtils.waitForCondition(
    () => !document.documentElement.hasAttribute("inDOMFullscreen"),
    "out of DOM fullscreen",
  );
  await setWindowSize();
  await nextFrame();
  Assert.ok(hasBorder(h2), "after fullscreen: h2 has the border again");
  cleanup(tabs);
  gBrowser.removeTab(solo);
});

add_task(async function removeTab_on_a_member_of_a_three_tab_split_does_not_throw_on_TabSelect() {
  await setWindowSize();
  const tabs = await openTabs("r1", "r2", "r3");
  const [r1, r2, r3] = tabs;
  const wrapper = await split(tabs);
  const errors = collectErrors();

  info("remove r2, an unselected member, then select r3 and r1");
  gBrowser.removeTab(r2, { animate: false });
  await TestUtils.waitForTick();
  Assert.deepEqual(names(wrapper.tabs), names([r1, r3]), "the wrapper's DOM keeps r1 and r3");
  Assert.ok(wrapper.isConnected, "the wrapper of two stays");
  gBrowser.selectedTab = r3;
  gBrowser.selectedTab = r1;
  await nextFrame();
  info(`private #tabs via panels: ${wrapper.panels.map((p) => p.id)}`);
  Assert.equal(wrapper.panels.length, 2, "panels (from #tabs) skips the closed tab's panel");
  const active = [...tabpanels().querySelectorAll(".split-view-panel-active")];
  Assert.deepEqual(
    names(active),
    names([panelOf(r1), panelOf(r3)]),
    "only r1 and r3's panels are active: no stale panel",
  );
  Assert.deepEqual(
    names(gBrowser.splitViewBrowsers),
    names([r1.linkedBrowser, r3.linkedBrowser]),
    "splitViewBrowsers",
  );
  assertActive([r1, r3], "after removing r2");

  info("remove the selected member r1");
  const r4 = (await openTabs("r4"))[0];
  wrapper.addTabs([r4]);
  gBrowser.selectedTab = r1;
  gBrowser.removeTab(r1, { animate: false });
  await TestUtils.waitForTick();
  info(`selected after removing r1: ${gBrowser.selectedTab.label}`);
  Assert.ok(wrapper.tabs.includes(gBrowser.selectedTab), "another member is selected");
  assertActive([r3, r4], "after removing the selected r1");
  await nextFrame();
  errors.stop();
  const ours = errors.errors.filter((e) => /tabsplitview|Tabbrowser|tabbox/.test(e));
  info(`console errors: ${JSON.stringify(errors.errors)}`);
  Assert.deepEqual(ours, [], "no error from the split view code");
  cleanup([r3, r4]);
});

/**
 * Rebuild r[a, b, c] as [a, c] in one task, sampling docshell states, and return the samples.
 * @param {boolean} hostDeactivates  the host sets docShellIsActive = false on the dropped tab
 */
async function rebuild(hostDeactivates) {
  await setWindowSize();
  const tabs = await openTabs("a", "b", "c");
  const [a, b, c] = tabs;
  const wrapper = await split(tabs);
  applyLayout(window, rectsOf(row(tabs), tabs));
  await scrollPage(a.linkedBrowser, SCROLL_Y);
  await scrollPage(c.linkedBrowser, SCROLL_Y);
  gBrowser.selectedTab = c;
  const deactivates = [];
  const onDeactivate = (e) => deactivates.push(e.detail.tabs.map((t) => t.label).join(","));
  window.addEventListener("TabSplitViewDeactivate", onDeactivate);
  const errors = collectErrors();
  const states = () => tabs.map((t) => t.linkedBrowser.docShellIsActive);
  const samples = {};

  wrapper.unsplitTabs();
  samples.afterUnsplit = states();
  const rebuilt = gBrowser.addTabSplitView([a, c], { insertBefore: a });
  if (hostDeactivates) b.linkedBrowser.docShellIsActive = false;
  samples.sync = states();
  await Promise.resolve();
  samples.microtask = states();
  await TestUtils.waitForTick();
  samples.tick = states();
  await nextFrame();
  samples.frames = states();

  window.removeEventListener("TabSplitViewDeactivate", onDeactivate);
  errors.stop();
  info(`rebuild (host deactivates: ${hostDeactivates}) [a, b, c]: ${JSON.stringify(samples)}`);
  info(`TabSplitViewDeactivate events: ${JSON.stringify(deactivates)}; errors ${errors.errors}`);

  Assert.ok(!wrapper.isConnected, "the old wrapper removed itself");
  Assert.deepEqual(names(rebuilt.tabs), names([a, c]), "the new wrapper holds a and c");
  Assert.equal(gBrowser.selectedTab, c, "the selected tab is unchanged");
  for (const [when, [sa, , sc]] of Object.entries(samples)) {
    Assert.ok(sa && sc, `a and c stay active at every sample (${when})`);
  }
  assertActive([a, c], "after rebuild");
  Assert.ok(
    !panelOf(b).classList.contains("split-view-panel-active"),
    "b's panel is no longer a visible split panel",
  );
  Assert.equal(await scrollYOf(a.linkedBrowser), SCROLL_Y, "a keeps its scroll position");
  Assert.equal(await scrollYOf(c.linkedBrowser), SCROLL_Y, "c keeps its scroll position");
  Assert.deepEqual(
    errors.errors.filter((e) => /tabsplitview|Tabbrowser|tabbox/.test(e)),
    [],
    "no errors",
  );
  cleanup([a, b, c]);
  return samples;
}

add_task(
  async function a_rebuild_keeps_the_kept_members_active_and_the_host_deactivates_the_dropped_one() {
    const samples = await rebuild(true);
    Assert.equal(samples.frames[1], false, "b is inactive once the host deactivates it");
  },
);

add_task(async function without_the_host_unsplitTabs_leaves_the_dropped_tab_active() {
  // Measured, not wanted: this is why the host deactivates the dropped tab (spec: Leave).
  const samples = await rebuild(false);
  Assert.equal(samples.frames[1], true, "unsplitTabs alone leaves b's docshell active");
});

add_task(
  async function the_split_view_api_works_with_the_ui_pref_off_and_hideTab_hides_the_whole_split() {
    await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.splitView.enabled", false]] });
    const tabs = await openTabs("h1", "h2", "h3");
    const [h1, h2, h3] = tabs;
    const wrapper = await split(tabs);
    assertActive(tabs, "with browser.tabs.splitView.enabled = false");
    const other = (await openTabs("h4"))[0];
    await BrowserTestUtils.switchTab(gBrowser, other);
    gBrowser.hideTab(h2);
    Assert.ok(
      [h1, h2, h3].every((t) => t.hidden),
      "hideTab on one member hides every member",
    );
    Assert.ok(!wrapper.visible, "the wrapper is not visible");
    gBrowser.showTab(h2);
    cleanup([...tabs, other]);
  },
);

add_task(
  async function panels_after_the_first_two_keep_tab_creation_order_until_the_host_reorders_them() {
    // MozTabpanels.setSplitViewActive only orders panels 0 and 1, so Tab-key focus order across
    // three or more panes is DOM order. Measured here, then the host's fix: moveBefore in
    // reading order, which keeps each page loaded, active and scrolled.
    await setWindowSize();
    const tabs = await openTabs("o1", "o2", "o3");
    const [o1, o2, o3] = tabs;
    for (const tab of tabs) await scrollPage(tab.linkedBrowser, SCROLL_Y);
    for (const tab of tabs) {
      await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
        content.wrappedJSObject.vimmaMarker = true;
      });
    }
    const reading = [o2, o3, o1];
    await split(reading);
    const domOrder = () =>
      [...tabpanels().children].filter((p) => tabs.some((t) => panelOf(t) === p));
    info(`DOM order: ${domOrder().map((p) => tabs.find((t) => panelOf(t) === p).label)}`);
    Assert.notDeepEqual(
      names(domOrder()),
      names(reading.map(panelOf)),
      "upstream leaves the third panel out of reading order",
    );

    // The host: put each panel after the previous one in reading order.
    for (let i = 1; i < reading.length; i++) {
      const prev = panelOf(reading[i - 1]);
      const panel = panelOf(reading[i]);
      if (prev.nextElementSibling !== panel)
        prev.parentNode.moveBefore(panel, prev.nextElementSibling);
    }
    Assert.deepEqual(
      names(domOrder()),
      names(reading.map(panelOf)),
      "after moveBefore, DOM order is reading order",
    );
    assertActive(tabs, "after moveBefore");
    for (const tab of tabs) {
      Assert.equal(
        await scrollYOf(tab.linkedBrowser),
        SCROLL_Y,
        `${tab.label} keeps its scroll position`,
      );
      Assert.ok(
        await SpecialPowers.spawn(
          tab.linkedBrowser,
          [],
          () => !!content.wrappedJSObject.vimmaMarker,
        ),
        `${tab.label}'s page was not reloaded`,
      );
    }
    cleanup(tabs);
  },
);
