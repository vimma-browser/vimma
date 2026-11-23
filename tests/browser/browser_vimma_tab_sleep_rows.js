/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-sleep.md, behaviour 14 and decisions 16, 17 and 20 (Delivery slice 3). A
// tab without a loaded page is drawn muted in the tab line and the side panel, and described
// "asleep"; nothing else about its row changes, and waking it takes the mark away.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const FEATURE = "vimma.feature.tabSleep";
const TABLINE = "vimma.ui.tabline";
const PAGE = "https://example.com/";

/** @typedef {MozTabbrowserTab} Tab */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

const panel = () => /** @type {HostState} */ (VimmaHost._state(window)).panel;
const line = () => /** @type {HTMLElement} */ (document.getElementById("vimma-tabline"));
/** The tab line's entry for tab number `n`. @param {number} n */
const entry = (n) =>
  /** @type {HTMLElement | null} */ (
    line().querySelector(`.vimma-tabline-tab[data-number="${n}"]`)
  );
/** The side panel's row for `tab`. @param {Tab} tab */
const row = (tab) =>
  [
    .../** @type {NodeListOf<HTMLElement>} */ (
      document.querySelectorAll("#vimma-panel .vimma-panel-row")
    ),
  ].find((r) => r.dataset.tabId === panelId(tab)) ?? null;
/** @param {Tab} tab */
const panelId = (tab) =>
  /** @type {string} */ (
    VimmaHost._state(window)
      ?.panel.snapshot()
      ?.rows.find((r) => r.display === tab.label)?.tabId
  );
/** @param {Tab} tab */
const numberOf = (tab) => gBrowser.visibleTabs.indexOf(tab) + 1;
/** The theme's readable muted text colour, as computed. */
function dimColour() {
  const probe = document.createElement("span");
  probe.style.color = "var(--vimma-fg-dim)";
  line().append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}
/** @param {Element | null | undefined} el */
const colour = (el) => (el ? getComputedStyle(el).color : "");
/** @param {HTMLElement | null} el */
const box = (el) => {
  const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
  return { left: r.left, width: r.width, height: r.height };
};

/** A background tab, loaded and titled `title`. @param {string} title */
async function background(title) {
  const url = `${PAGE}?${title}`;
  const t = /** @type {Tab} */ (BrowserTestUtils.addTab(gBrowser, url));
  await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
  await SpecialPowers.spawn(t.linkedBrowser, [title], (name) => {
    content.document.title = name;
  });
  await until(() => t.label === title && !t.hasAttribute("busy"), "the tab has its title");
  return t;
}

/** @param {Tab} t */
async function sleep(t) {
  await gBrowser.prepareDiscardBrowser(t);
  Assert.ok(gBrowser.discardBrowser(t, false), "Firefox discards the tab");
  Assert.ok(!t.linkedPanel, "it has no loaded page");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[TABLINE, "always"]] });
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
  registerCleanupFunction(() => {
    panel()?.close();
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(/** @type {Tab} */ (gBrowser.tabs.at(-1)));
  });
});

add_task(async function a_sleeping_tab_is_muted_and_described_asleep_until_it_wakes() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, true]] });
  const a = await background("alpha");
  const b = await background("bravo");
  Assert.ok(panel().open(), "the side panel opens");
  await until(() => entry(numberOf(b)) && row(b), "both lists show the tab");
  const awake = {
    line: box(entry(numberOf(b))),
    row: box(row(b)),
    name: colour(entry(numberOf(b))?.querySelector(".vimma-tabline-name")),
    title: colour(row(b)?.querySelector(".vimma-panel-title")),
  };
  Assert.notEqual(awake.name, dimColour(), "an awake tab's name is not muted");

  await sleep(b);
  await until(
    () => entry(numberOf(b))?.hasAttribute("asleep") && row(b)?.hasAttribute("asleep"),
    "the tab line and the side panel mark the sleeping tab",
  );
  const lineEntry = /** @type {HTMLElement} */ (entry(numberOf(b)));
  const panelRow = /** @type {HTMLElement} */ (row(b));
  const dim = dimColour();
  Assert.equal(colour(lineEntry.querySelector(".vimma-tabline-name")), dim, "its name is muted");
  Assert.equal(colour(panelRow.querySelector(".vimma-panel-title")), dim, "its title is muted");
  Assert.equal(panelRow.getAttribute("aria-description"), "asleep", "the row is described asleep");
  Assert.ok(
    [...lineEntry.querySelectorAll(".vimma-tabline-sr")].some((s) => s.textContent === " asleep"),
    "the tab line says asleep in words",
  );
  Assert.deepEqual(box(lineEntry), awake.line, "the tab line's entry keeps its place and size");
  Assert.deepEqual(box(panelRow), awake.row, "the panel's row keeps its place and size");
  Assert.ok(!entry(numberOf(a))?.hasAttribute("asleep"), "an awake tab is not marked");
  Assert.ok(!row(a)?.hasAttribute("aria-description"), "nor described");
  Assert.ok(!b.linkedPanel, "drawing the rows did not wake the tab");

  await BrowserTestUtils.switchTab(gBrowser, b);
  await until(
    () =>
      !entry(numberOf(b))?.hasAttribute("asleep") &&
      !row(b)?.hasAttribute("asleep") &&
      !b.hasAttribute("pending"),
    "waking the tab takes the mark away",
  );
  Assert.ok(!row(b)?.hasAttribute("aria-description"), "and the description");
  panel().close();
  gBrowser.removeTab(a);
  gBrowser.removeTab(b);
  await SpecialPowers.popPrefEnv();
});

add_task(async function with_the_feature_pref_off_no_row_is_marked() {
  const t = await background("charlie");
  await sleep(t);
  Assert.ok(panel().open(), "the side panel opens");
  await until(() => entry(numberOf(t)) && row(t), "both lists show the tab");
  Assert.ok(!entry(numberOf(t))?.hasAttribute("asleep"), "the tab line marks nothing");
  Assert.ok(!row(t)?.hasAttribute("asleep"), "nor does the side panel");
  panel().close();
  gBrowser.removeTab(t);
});
