/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/toolbar-toggle.md decision 21. Firefox's navigation toolbar, its URL field,
// the suggestions under it, the site's identity and the prompts and panels that hang from the
// bar take Vimma's theme tokens: the built-in palette dark and light, and an Omarchy theme that
// gives only its base colours (no dark_background, selection or muted of its own).

"use strict";

/* global PopupNotifications, SitePermissions -- browser window globals (browser.js) */
/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const PREF = "vimma.ui.toolbar.hidden";
const APPEARANCE_PREF = "vimma.theme.appearance";
const VISIBLE = { visibilityProperty: true };
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = DIR + "file_vimma_plain.html";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-toolbar-theme-${Date.now()}`);

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

const $ = (/** @type {string} */ id) => /** @type {Element} */ (document.getElementById(id));
const style = (/** @type {Element} */ el) => el.ownerDocument.defaultView.getComputedStyle(el);
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
 * A colour custom property as `el` sees it, resolved to the rgb() form getComputedStyle
 * reports.
 * @param {Element} el
 * @param {string} name
 */
function colourVar(el, name) {
  const value = style(el).getPropertyValue(name).trim();
  const probe = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  probe.style.color = value;
  document.documentElement.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/**
 * The colour that shows behind `el`: its own background or the first opaque ancestor's. The
 * suggestions' backdrop is not an ancestor: the view is a popover that paints its rows over a
 * child of its own, `.urlbarView-background` (z-index -1, urlbar.css), so a view counts that
 * child's background as its own (#893).
 */
function backdrop(/** @type {Element} */ el) {
  /** @type {Element | null} */
  let node = el;
  while (node) {
    const layer = node.classList.contains("urlbarView")
      ? node.querySelector(":scope > .urlbarView-background")
      : null;
    const bg = style(layer ?? node).backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    node = node.parentElement ?? /** @type {any} */ (node.getRootNode()).host ?? null;
  }
  return "none";
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * The bar, the field, the suggestions, the identity and a permission prompt are in the theme.
 * @param {string} label  which theme
 * @param {MozTabbrowserTab} tab
 */
async function assertToolbarFollowsTheTheme(label, tab) {
  const surface = tokenColour("--vimma-bg-dark");
  const field = tokenColour("--vimma-bg");
  const text = tokenColour("--vimma-fg");
  const selection = tokenColour("--vimma-selection");
  const scheme = token("--vimma-color-scheme");

  // The toolbar, shown.
  const navBar = $("nav-bar");
  Assert.equal(backdrop(navBar), surface, `${label}: the toolbar is on --vimma-bg-dark`);
  Assert.equal(style(navBar).color, text, `${label}: its text and icons are --vimma-fg`);
  Assert.equal(style(navBar).colorScheme, scheme, `${label}: its colour scheme`);
  const fieldBox = /** @type {Element} */ (gURLBar.querySelector(".urlbar-background"));
  Assert.equal(style(fieldBox).backgroundColor, field, `${label}: the URL field is --vimma-bg`);
  Assert.equal(style(gURLBar.inputField).color, text, `${label}: its text is --vimma-fg`);
  const identity = [$("trust-icon-container"), $("identity-icon-box")].find((el) =>
    el.checkVisibility(VISIBLE),
  );
  Assert.ok(identity, `${label}: the site's identity shows`);
  Assert.equal(style(identity).color, text, `${label}: the identity's icon is --vimma-fg`);

  // Hidden: the minimal bar while typing, and the suggestions under it.
  Services.prefs.setBoolPref(PREF, true);
  await until(() => !navBar.checkVisibility(VISIBLE), `${label}: hidden`);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await until(() => gURLBar.focused, `${label}: I`);
  EventUtils.sendString("about:");
  // The heuristic row comes first, selected; the about: pages come in later. Wait for one, so
  // the plain-row checks below always run (#893).
  await until(
    () =>
      gURLBar.view.isOpen &&
      !!gURLBar.querySelector(".urlbarView-row[selected]") &&
      !!gURLBar.querySelector(".urlbarView-row:not([selected])"),
    `${label}: the suggestions open, the first selected, more under it`,
  );
  Assert.equal(backdrop(navBar), surface, `${label}: the minimal bar is on --vimma-bg-dark`);
  Assert.equal(style(fieldBox).backgroundColor, field, `${label}: the open field is --vimma-bg`);
  const rows = gURLBar.querySelectorAll(".urlbarView-row");
  const plain = /** @type {Element} */ ([...rows].find((r) => !r.hasAttribute("selected")));
  const selected = /** @type {Element} */ (gURLBar.querySelector(".urlbarView-row[selected]"));
  Assert.equal(backdrop(plain), field, `${label}: a suggestion is on --vimma-bg`);
  Assert.equal(style(plain).color, text, `${label}: its text is --vimma-fg`);
  Assert.equal(
    style(selected).backgroundColor,
    selection,
    `${label}: the selected suggestion is --vimma-selection`,
  );
  Assert.equal(
    style(selected).color,
    tokenColour("--vimma-fg-bright"),
    `${label}: its text is --vimma-fg-bright`,
  );
  for (let i = 0; i < 4 && gURLBar.focused; i++) {
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise((r) => requestAnimationFrame(r));
  }
  await until(() => !gURLBar.focused, `${label}: Esc leaves the URL bar`);

  // A permission prompt, its panel and its buttons.
  const panel = PopupNotifications.panel;
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
    );
  });
  await shown;
  const n = /** @type {any} */ (panel.firstElementChild);
  Assert.equal(
    colourVar(panel, "--panel-background-color"),
    surface,
    `${label}: the prompt is on --vimma-bg-dark`,
  );
  Assert.equal(colourVar(panel, "--panel-text-color"), text, `${label}: its text is --vimma-fg`);
  Assert.equal(
    colourVar(panel, "--panel-border-color"),
    tokenColour("--vimma-muted"),
    `${label}: its border is --vimma-muted`,
  );
  Assert.equal(style(panel).colorScheme, scheme, `${label}: its colour scheme`);
  Assert.equal(
    colourVar(n.button, "--button-background-color-primary"),
    tokenColour("--vimma-mode-normal"),
    `${label}: its main button is the accent`,
  );
  Assert.equal(
    colourVar(n.button, "--button-text-color-primary"),
    tokenColour("--vimma-mode-normal-fg"),
    `${label}: with readable text on it`,
  );
  Assert.ok(
    colourVar(n.button, "--focus-outline-color") === tokenColour("--vimma-focus"),
    `${label}: a focused button's ring is --vimma-focus`,
  );
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  n.secondaryButton.click();
  await hidden;
  SitePermissions.removeFromPrincipal(tab.linkedBrowser.contentPrincipal, "geo", tab.linkedBrowser);
  Services.prefs.setBoolPref(PREF, false);
  await until(() => navBar.checkVisibility(VISIBLE), `${label}: shown again`);
}

add_task(async function the_toolbar_follows_the_theme() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.pollMs", 100],
      ["browser.urlbar.suggest.searches", false],
      ["security.notification_enable_delay", 0],
    ],
  });
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(PREF);
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");

  for (const appearance of ["dark", "light"]) {
    Services.prefs.setStringPref(APPEARANCE_PREF, appearance);
    await until(() => token("--vimma-color-scheme") === appearance, `the palette is ${appearance}`);
    await assertToolbarFollowsTheTheme(`vimma ${appearance}`, tab);
  }
  Services.prefs.clearUserPref(APPEARANCE_PREF);

  await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), BASE_ONLY);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", themeDir],
    ],
  });
  await until(() => token("--vimma-bg") === "#1c1e26", "the base-only Omarchy theme applies");
  await assertToolbarFollowsTheTheme("Omarchy, base colours only", tab);
  await SpecialPowers.popPrefEnv();

  gBrowser.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
