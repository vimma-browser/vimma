/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's focus colour follows the theme (docs/specs/m7-a11y.md, "Focus colour"): the address
// bar's focus ring and the focused pane's outline in a split are --vimma-focus, the theme accent
// (moved just far enough to reach 3:1 where it would not), for the built-in vimma dark and light,
// Tokyo Night, and live after a `[theme.colors] accent` override in config.toml.

"use strict";

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { TOKYO_NIGHT, VIMMA_DARK, contrastRatio } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/theme.mjs",
);

const dir = PathUtils.join(PathUtils.tempDir, `vimma-focus-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** "rgb(r, g, b)" → "#rrggbb"; null for a colour with alpha. */
function hex(css) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (!m) return null;
  return `#${m
    .slice(1)
    .map((c) => Number(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let writes = 0;
/** config.toml, with a unique trailer so the poll sees every write. */
async function writeConfig(text) {
  writes++;
  await IOUtils.writeUTF8(file, `schema = 2\n${text}\n${"#".repeat(writes)}\n`);
  await ConfigHost.reload();
}

/** The address bar focused, its results closed: its ring is the focused border. */
async function focusedUrlbarRing() {
  gURLBar.focus();
  gURLBar.view.close();
  await until(
    () => gURLBar.hasAttribute("focused") && !gURLBar.hasAttribute("suppress-focus-border"),
    "the address bar is focused, with its focus ring",
  );
  const bg = /** @type {Element} */ (gURLBar.querySelector(".urlbar-background"));
  const style = getComputedStyle(bg);
  return { color: style.borderTopColor, background: style.backgroundColor };
}

/** The selected (focused) pane's border colour, in a three-pane split. */
function focusedPaneOutline() {
  const panel = document.getElementById(gBrowser.selectedTab.linkedPanel);
  Assert.ok(panel.classList.contains("deck-selected"), "the focused pane is the deck's");
  const container = /** @type {Element} */ (panel.querySelector(".browserContainer"));
  const style = getComputedStyle(container, "::after");
  Assert.notEqual(style.borderTopStyle, "none", "the focused pane has its border");
  Assert.equal(style.borderTopWidth, "3px", "it is the 3 px pane focus border");
  return style.borderTopColor;
}

/**
 * Both rings are --vimma-focus, which is `expected`.
 * @param {string} label @param {string} expected  #rrggbb
 */
async function assertFocusColour(label, expected) {
  await until(() => token("--vimma-focus") === expected, `${label}: --vimma-focus is ${expected}`);
  const ring = await focusedUrlbarRing();
  Assert.equal(ring.color, rgb(expected), `${label}: the address bar's focus ring`);
  const bg = hex(ring.background);
  if (bg) {
    const ratio = contrastRatio(expected, bg);
    info(`${label}: ring on the focused address bar (${bg}): ${ratio.toFixed(2)}:1`);
    Assert.greaterOrEqual(ratio, 3, `${label}: the ring reaches 3:1 on the address bar`);
  }
  Assert.equal(focusedPaneOutline(), rgb(expected), `${label}: the focused pane's outline`);
  gBrowser.selectedBrowser.focus();
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", file],
      // A dark desktop: Firefox's dark chrome and the built-in vimma's dark variant.
      ["ui.systemUsesDarkTheme", 1],
    ],
  });
  const tabs = [];
  for (const name of ["a", "b", "c"]) {
    const url = `data:text/html,<title>${name}</title>${name}`;
    const tab = BrowserTestUtils.addTab(gBrowser, url);
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    tabs.push(tab);
  }
  gBrowser.selectedTab = tabs[0];
  const view = PaneViews.get(window);
  Assert.deepEqual(view.split("vertical", { tab: tabs[1] }), { ok: true }, "split right");
  Assert.deepEqual(view.split("horizontal", { tab: tabs[2] }), { ok: true }, "then down");
  registerCleanupFunction(async () => {
    while (view.panes) view.close();
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
});

add_task(async function vimma_dark_rings_are_the_aqua_accent() {
  await writeConfig(`[theme]\nsource = "file"`);
  Assert.equal(token("--vimma-accent"), VIMMA_DARK.accent, "vimma dark");
  await assertFocusColour("vimma dark", VIMMA_DARK.accent);
});

add_task(async function vimma_light_rings_are_its_accent_at_three_to_one() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  await until(() => token("--vimma-color-scheme") === "light", "vimma light");
  // #006b5e is 2.93:1 on the light pane gap; one 5% step toward black reaches 3:1.
  Assert.equal(token("--vimma-accent"), "#006b5e", "vimma light's accent");
  await assertFocusColour("vimma light", "#006659");
  await SpecialPowers.popPrefEnv();
  await until(() => token("--vimma-color-scheme") === "dark", "dark again");
});

add_task(async function tokyo_night_rings_are_its_blue_accent() {
  await writeConfig(`[theme]\nsource = "file"\nname = "tokyo-night"`);
  await assertFocusColour("Tokyo Night", TOKYO_NIGHT.accent);
});

add_task(async function a_theme_colors_accent_override_applies_live() {
  await writeConfig(`[theme]\nsource = "file"\n[theme.colors]\naccent = "#ff79c6"`);
  await assertFocusColour("[theme.colors] accent", "#ff79c6");
  await writeConfig(`[theme]\nsource = "file"`);
  await assertFocusColour("the override removed", VIMMA_DARK.accent);
});
