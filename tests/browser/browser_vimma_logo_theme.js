/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/start-page.md, "Logo colours". The logo on the start page and on about:vimma
// is painted through two masks: the window+V mark in the theme's accent, the "imma" wordmark
// white under a dark theme and the theme's text colour under a light one. Both follow a theme
// change live, without a reload.

"use strict";

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);

const START = "chrome://browser/content/vimma/start/start.html";
const BASE = {
  source: /** @type {const} */ ("omarchy"),
  name: "vimma",
  font: "monospace",
  colors: {},
};
/** Two themes with colours no built-in palette has, so a match cannot be a coincidence. */
const DARK = {
  ...BASE,
  appearance: "dark",
  colors: { accent: "#ff7f11", foreground: "#d0c8b0" },
};
const LIGHT = {
  ...BASE,
  appearance: "light",
  colors: { accent: "#7b2fbe", foreground: "#1a1c2a" },
};
const WHITE = "rgb(255, 255, 255)";

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

registerCleanupFunction(() => {
  ThemeHost.setConfig(BASE);
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/**
 * The logo's parts in `browser`'s page, with the page's own tokens to compare them with.
 * @param {MozBrowser} browser
 */
function logoState(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(
      () => doc.querySelector(".vimma-logo"),
      "the page has the logo",
    );
    const style = (/** @type {Element} */ el) => content.getComputedStyle(el);
    // The wait above found it; a read through a missing one throws.
    const logo = /** @type {Element} */ (doc.querySelector(".vimma-logo"));
    const mark = logo.querySelector(".vimma-logo-mark");
    const wordmark = logo.querySelector(".vimma-logo-wordmark");
    // A probe resolves the tokens to rgb() the way the logo's colours compute.
    const probe = doc.createElement("span");
    doc.body.append(probe);
    probe.style.color = "var(--vimma-accent)";
    const accent = style(probe).color;
    probe.style.color = "var(--vimma-fg)";
    const fg = style(probe).color;
    probe.remove();
    const box = logo.getBoundingClientRect();
    return {
      role: logo.getAttribute("role"),
      label: logo.getAttribute("aria-label"),
      hidden: [mark?.getAttribute("aria-hidden"), wordmark?.getAttribute("aria-hidden")],
      mark: mark && style(mark).backgroundColor,
      wordmark: wordmark && style(wordmark).backgroundColor,
      markMask: mark && style(mark).maskImage,
      wordmarkMask: wordmark && style(wordmark).maskImage,
      scheme: style(doc.documentElement).getPropertyValue("--vimma-color-scheme").trim(),
      accent,
      fg,
      size: [box.width, box.height],
    };
  });
}

/**
 * Sets `theme` and waits until `browser`'s logo shows its colours.
 * @param {MozBrowser} browser
 * @param {typeof DARK} theme
 * @param {string} what
 */
async function applyTheme(browser, theme, what) {
  ThemeHost.setConfig(theme);
  const accent = rgb(theme.colors.accent);
  /** @type {Awaited<ReturnType<typeof logoState>> | undefined} */
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await logoState(browser);
    return state.accent === accent && state.mark === accent;
  }, `${what}: the mark turns the accent`);
  // The wait resolved, so its condition set it.
  return /** @type {Awaited<ReturnType<typeof logoState>>} */ (state);
}

/**
 * Checks a page's logo under the dark theme, then live under the light one.
 * @param {string} url
 */
async function checkLogo(url) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  const browser = tab.linkedBrowser;

  const dark = await applyTheme(browser, DARK, `${url}, dark`);
  Assert.equal(dark.role, "img", "the logo is one image to assistive technology");
  Assert.equal(dark.label, "Vimma", "named Vimma");
  Assert.deepEqual(dark.hidden, ["true", "true"], "its two painted parts are hidden from it");
  Assert.stringContains(
    dark.markMask ?? "",
    "vimma-logo-mark.png",
    "the mark is painted through a mask",
  );
  Assert.stringContains(
    dark.wordmarkMask ?? "",
    "vimma-logo-wordmark.png",
    "and so is the wordmark",
  );
  Assert.ok(dark.size[0] > 0 && dark.size[1] > 0, "the logo takes up room");
  Assert.equal(dark.scheme, "dark", "the dark theme is shown");
  Assert.equal(dark.mark, rgb(DARK.colors.accent), "the mark is the dark theme's accent");
  Assert.equal(dark.mark, dark.accent, "the page's --vimma-accent");
  Assert.equal(dark.wordmark, WHITE, "the wordmark is white under a dark theme");

  const light = await applyTheme(browser, LIGHT, `${url}, light`);
  Assert.equal(light.scheme, "light", "the light theme is shown, without a reload");
  Assert.equal(light.mark, rgb(LIGHT.colors.accent), "the mark is the light theme's accent");
  Assert.equal(light.mark, light.accent, "the page's --vimma-accent");
  Assert.equal(light.wordmark, rgb(LIGHT.colors.foreground), "the wordmark is the text colour");
  Assert.equal(light.wordmark, light.fg, "the page's --vimma-fg");

  const back = await applyTheme(browser, DARK, `${url}, dark again`);
  Assert.equal(back.wordmark, WHITE, "white again when the theme turns dark");
  BrowserTestUtils.removeTab(tab);
}

add_task(async function the_start_page_logo_follows_the_theme() {
  await checkLogo(START);
});

add_task(async function the_about_vimma_logo_follows_the_theme() {
  await checkLogo("about:vimma");
});

add_task(async function forced_colours_paint_both_parts_in_the_text_colour() {
  ThemeHost.setConfig(DARK);
  await SpecialPowers.pushPrefEnv({ set: [["browser.display.document_color_use", 2]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, START);
  const state = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const style = (/** @type {Element} */ el) => content.getComputedStyle(el);
    const probe = doc.createElement("span");
    probe.style.color = "CanvasText";
    doc.body.append(probe);
    return {
      forced: content.matchMedia("(forced-colors: active)").matches,
      text: style(probe).color,
      // getComputedStyle throws for a part the page does not have.
      mark: style(/** @type {Element} */ (doc.querySelector(".vimma-logo-mark"))).backgroundColor,
      wordmark: style(/** @type {Element} */ (doc.querySelector(".vimma-logo-wordmark")))
        .backgroundColor,
    };
  });
  Assert.ok(state.forced, "forced colours are on");
  Assert.equal(state.mark, state.text, "the mark is CanvasText, readable on Canvas");
  Assert.equal(state.wordmark, state.text, "so is the wordmark");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
