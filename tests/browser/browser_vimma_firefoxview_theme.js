/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-theme.md. Tab Overview (about:firefoxview) follows the theme
// as Firefox's other pages do: its page, its cards, its text and links, and its navigation, whose
// selected item Nova paints as Firefox's violet pill (#912). The History sidebar's import promo,
// once a user turns it back on, leaves Firefox's violet "vibrant" card for the theme's colours.
// Checked in the built-in palette dark and light and in an Omarchy theme that gives only its base
// colours; with high contrast Firefox's own colours stay.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */

const APPEARANCE_PREF = "vimma.theme.appearance";
const IMPORT_DISMISSED_PREF = "browser.tabs.firefox-view.importHistory.dismissed";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-firefoxview-theme-${Date.now()}`);
const XHTML = "http://www.w3.org/1999/xhtml";

/** A base-only Omarchy 4 colors.toml (event-horizon's keys): no surfaces, selection or muted. */
const BASE_ONLY = `accent = "#26bbd9"
cursor = "#fadad1"
foreground = "#fadad1"
background = "#1c1e26"
selection_foreground = "#1c1e26"
selection_background = "#26bbd9"
color0 = "#1c1e26"
color1 = "#e95678"
color2 = "#29d398"
color3 = "#fab795"
color4 = "#26bbd9"
color5 = "#ee64ac"
color6 = "#59e3e3"
color7 = "#fadad1"
color8 = "#6c6f93"
color9 = "#ec6a88"
color10 = "#3fdaa4"
color11 = "#fbc3a7"
color12 = "#3fc4de"
color13 = "#f075b5"
color14 = "#6be4e6"
color15 = "#fadad1"
`;

const style = (/** @type {Element} */ el) =>
  /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el);
const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** A token as a colour, in the form getComputedStyle reports. */
const tokenColour = (/** @type {string} */ name) => rgb(token(name));

/**
 * The colour `value` gives an element placed under `parent` (in its tree, so that its custom
 * properties, colour scheme and currentColor are the ones `parent`'s children see).
 * @param {Element | ShadowRoot} parent
 * @param {string} value
 */
function colourUnder(parent, value) {
  const doc = /** @type {Document} */ (parent.ownerDocument);
  const probe = doc.createElementNS(XHTML, "div");
  probe.style.color = value;
  parent.append(probe);
  const out = style(probe).color;
  probe.remove();
  return out;
}

/**
 * The colour painted at (x, y) of a document, from a snapshot of it.
 * @param {WindowGlobalParent} global
 * @param {number} x
 * @param {number} y
 */
async function pixel(global, x, y) {
  const bitmap = await global.drawSnapshot(new DOMRect(x, y, 1, 1), 1, "rgb(255, 0, 255)");
  const canvas = /** @type {HTMLCanvasElement} */ (document.createElementNS(XHTML, "canvas"));
  canvas.width = 1;
  canvas.height = 1;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * `actual` within 2 per channel of `expected` (both "rgb(r, g, b)"): a snapshot may round.
 * @param {string} actual @param {string} expected @param {string} msg
 */
function nearly(actual, expected, msg) {
  const parse = (/** @type {string} */ s) => (s.match(/\d+/g) ?? []).map(Number);
  const a = parse(actual);
  const e = parse(expected);
  const ok = a.length >= 3 && e.every((v, i) => Math.abs(v - (a[i] ?? -99)) <= 2);
  Assert.ok(ok, `${msg} (${actual}, expected ${expected})`);
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * Waits for `cond` as `until` does, without failing on a timeout: the assertions that follow
 * then report the colours found.
 * @param {() => boolean} cond @param {string} msg
 */
async function settled(cond, msg) {
  try {
    await until(cond, msg);
  } catch (e) {
    info(`${msg}: ${e}`);
  }
}

/** Opens Tab Overview in a tab of its own, as the `:firefox` command or its URL does. */
async function openTabOverview() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:firefoxview");
  const doc = /** @type {Document} */ (tab.linkedBrowser.contentDocument);
  await until(
    () =>
      [...doc.querySelectorAll("moz-page-nav-button")].some(
        (b) => /** @type {any} */ (b).selected && b.shadowRoot?.querySelector("button[selected]"),
      ),
    "Tab Overview selects its first view",
  );
  return { tab, doc };
}

/**
 * The selected navigation item's <button>, in its shadow root.
 * @param {Document} doc
 */
function selectedNavButton(doc) {
  const host = [...doc.querySelectorAll("moz-page-nav-button")].find(
    (b) => /** @type {any} */ (b).selected,
  );
  return /** @type {Element} */ (host?.shadowRoot?.querySelector("button[selected]"));
}

/**
 * Tab Overview in the current theme: its scheme, its page painted, its cards, text and links,
 * and its selected navigation item.
 * @param {string} label
 * @param {{ tab: MozTabbrowserTab, doc: Document }} page
 */
async function assertTabOverview(label, { tab, doc }) {
  const root = /** @type {Element} */ (doc.documentElement);
  const body = /** @type {Element} */ (doc.body);
  // The page follows a theme change once its token sheet is swapped: wait for its surface, and
  // let the assertions below say what is wrong if it never comes.
  await settled(
    () => style(body).backgroundColor === tokenColour("--vimma-bg"),
    `${label}: Tab Overview has the theme`,
  );
  Assert.equal(style(root).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  Assert.equal(
    style(body).backgroundColor,
    tokenColour("--vimma-bg"),
    `${label}: the page is on --vimma-bg`,
  );
  Assert.equal(style(body).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  const browser = tab.linkedBrowser;
  const { width, height } = browser.getBoundingClientRect();
  nearly(
    await pixel(
      /** @type {WindowGlobalParent} */ (browser.browsingContext.currentWindowGlobal),
      width - 4,
      height - 4,
    ),
    tokenColour("--vimma-bg"),
    `${label}: the page paints --vimma-bg`,
  );
  // The cards (card-container.css) and their "View all" links and footers.
  Assert.equal(
    colourUnder(body, "var(--fxview-background-color-secondary)"),
    tokenColour("--vimma-bg-dark"),
    `${label}: its cards are on --vimma-bg-dark`,
  );
  Assert.equal(
    colourUnder(body, "var(--fxview-primary-action-background)"),
    tokenColour("--vimma-text-accent"),
    `${label}: its card links are --vimma-text-accent`,
  );
  /** @type {Element | null | undefined} */
  let card;
  await until(() => {
    card = doc
      .querySelector("view-recentbrowsing view-opentabs")
      ?.shadowRoot?.querySelector("view-opentabs-card")
      ?.shadowRoot?.querySelector("card-container")
      ?.shadowRoot?.querySelector(".card-container");
    return !!card;
  }, `${label}: Recent browsing shows its open tabs card`);
  Assert.equal(
    style(/** @type {Element} */ (card)).backgroundColor,
    tokenColour("--vimma-bg-dark"),
    `${label}: the open tabs card is on --vimma-bg-dark`,
  );
  Assert.equal(
    colourUnder(root, "var(--color-accent-primary)"),
    tokenColour("--vimma-mode-normal"),
    `${label}: its accent is the theme's`,
  );

  const selected = selectedNavButton(doc);
  // The navigation buttons fade their background over 150ms (moz-page-nav-button.css).
  await Promise.all(selected.getAnimations().map((a) => a.finished));
  Assert.equal(
    style(selected).backgroundColor,
    tokenColour("--vimma-mode-normal"),
    `${label}: the selected navigation item is the accent, not Firefox's violet`,
  );
  Assert.equal(
    style(selected).color,
    tokenColour("--vimma-mode-normal-fg"),
    `${label}: with readable text on it`,
  );
  const other = [...doc.querySelectorAll("moz-page-nav-button")]
    .find((b) => !(/** @type {any} */ (b).selected) && !b.hidden)
    ?.shadowRoot?.querySelector("button");
  Assert.equal(
    style(/** @type {Element} */ (other)).color,
    tokenColour("--vimma-fg"),
    `${label}: the other navigation items' text is --vimma-fg`,
  );
  // Hovered and pressed, Nova tints buttons violet (tokens-brand.css): the text colour tinted.
  for (const [state, share] of [
    ["hover", 17],
    ["active", 30],
  ]) {
    Assert.equal(
      colourUnder(body, `var(--button-background-color-${state})`),
      colourUnder(body, `color-mix(in srgb, currentColor ${share}%, transparent)`),
      `${label}: a ${state} button is the text colour tinted`,
    );
  }
}

/** Shows the sidebar's launcher, as its toolbar button does (browser_vimma_sidebar_theme.js). */
function showLauncher() {
  const state = SidebarController._state;
  if ("userLauncherVisible" in state) state.userLauncherVisible = true;
}

/** Opens the History sidebar and returns its import promo's card, once rendered. */
async function openHistoryPromo() {
  showLauncher();
  await SidebarController.show("viewHistorySidebar");
  const browser = SidebarController.browser;
  /** @type {Element | null | undefined} */
  let container;
  await until(() => {
    const doc = browser.contentDocument;
    const promo = doc
      ?.querySelector("sidebar-history")
      ?.shadowRoot?.querySelector("moz-promo.import-history-promo");
    container = promo?.shadowRoot?.querySelector(".container");
    return doc?.readyState === "complete" && !!container;
  }, "the History sidebar shows its import promo");
  return /** @type {Element} */ (container);
}

function closeSidebar() {
  SidebarController.hide();
  if ("userLauncherVisible" in SidebarController._state) {
    SidebarController._state.userLauncherVisible = false;
  }
}

/**
 * The import promo in the current theme: a card on --vimma-bg, bordered --vimma-muted, with the
 * theme's text, instead of Firefox's violet.
 * @param {string} label
 * @param {Element} container  the promo's .container, in its shadow root
 */
async function assertPromo(label, container) {
  await settled(
    () => style(container).color === tokenColour("--vimma-fg"),
    `${label}: the promo has the theme`,
  );
  Assert.equal(
    style(container).backgroundColor,
    tokenColour("--vimma-bg"),
    `${label}: the import promo is on --vimma-bg, not Firefox's violet`,
  );
  Assert.equal(
    style(container).borderTopColor,
    tokenColour("--vimma-muted"),
    `${label}: its border is --vimma-muted`,
  );
  Assert.equal(
    style(container).color,
    tokenColour("--vimma-fg"),
    `${label}: its text is --vimma-fg`,
  );
}

/**
 * Runs `check` in the built-in palette dark and light, then in a base-only Omarchy theme.
 * @param {(label: string) => Promise<void>} check
 */
async function inEachTheme(check) {
  for (const appearance of ["dark", "light"]) {
    Services.prefs.setStringPref(APPEARANCE_PREF, appearance);
    await until(() => token("--vimma-color-scheme") === appearance, `the palette is ${appearance}`);
    await check(`vimma ${appearance}`);
  }
  Services.prefs.clearUserPref(APPEARANCE_PREF);

  await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), BASE_ONLY);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", themeDir],
    ],
  });
  try {
    await until(() => token("--vimma-bg") === "#1c1e26", "the base-only Omarchy theme applies");
    await check("Omarchy, base colours only");
  } finally {
    await SpecialPowers.popPrefEnv();
    // The Omarchy theme is dark too: wait for the built-in palette, so that the next pass does
    // not check its colours.
    await until(() => token("--vimma-bg") !== "#1c1e26", "the built-in palette is back");
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", 100],
      ["browser.nova.enabled", true],
    ],
  });
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function tab_overview_follows_the_theme() {
  const page = await openTabOverview();
  try {
    await inEachTheme((label) => assertTabOverview(label, page));
  } finally {
    BrowserTestUtils.removeTab(page.tab);
  }
});

add_task(async function the_history_import_promo_follows_the_theme() {
  await SpecialPowers.pushPrefEnv({ set: [[IMPORT_DISMISSED_PREF, false]] });
  try {
    const container = await openHistoryPromo();
    await inEachTheme((label) => assertPromo(label, container));
  } finally {
    closeSidebar();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function high_contrast_keeps_firefox_colours() {
  // ui.useAccessibilityTheme is the system's high-contrast setting (nsMediaFeatures.cpp).
  await SpecialPowers.pushPrefEnv({
    set: [
      ["ui.useAccessibilityTheme", 1],
      [IMPORT_DISMISSED_PREF, false],
    ],
  });
  const { tab, doc } = await openTabOverview();
  try {
    await until(
      () => /** @type {Window} */ (doc.defaultView).matchMedia("(prefers-contrast)").matches,
      "high contrast is on in the page",
    );
    Assert.notEqual(
      style(/** @type {Element} */ (doc.body)).backgroundColor,
      tokenColour("--vimma-bg"),
      "Tab Overview keeps Firefox's high-contrast page",
    );
    Assert.notEqual(
      style(selectedNavButton(doc)).backgroundColor,
      tokenColour("--vimma-mode-normal"),
      "its selected navigation item keeps Firefox's high-contrast colour",
    );
    const container = await openHistoryPromo();
    Assert.notEqual(
      style(container).backgroundColor,
      tokenColour("--vimma-bg"),
      "the import promo keeps Firefox's own colours",
    );
  } finally {
    closeSidebar();
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
