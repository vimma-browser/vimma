/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/content-color-scheme.md. Web pages see the colour scheme Vimma shows: the
// system's while the built-in palette follows it, the fixed one after `:theme dark` or
// `:theme light` (or `[theme] appearance`), and the Omarchy theme's mode on Omarchy. Firefox's
// Settings → Website appearance (layout.css.prefers-color-scheme.content-override) wins.

"use strict";

/* global focusContent -- from head.js */

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const { TOKYO_NIGHT } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/index.mjs");

const APPEARANCE_PREF = "vimma.theme.appearance";
const CONTENT_OVERRIDE_PREF = "layout.css.prefers-color-scheme.content-override";
const DEFAULT_THEME = {
  source: /** @type {const} */ ("omarchy"),
  name: "vimma",
  font: "monospace",
  colors: {},
};
/** A page that styles itself by prefers-color-scheme, as most sites with a dark mode do. */
const PAGE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent(
    "<style>body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000}}</style>" +
      "<p>colour scheme</p>",
  );

const root = PathUtils.join(PathUtils.tempDir, `vimma-content-scheme-${Date.now()}`);
/** A HOME without Omarchy: the built-in palette shows unless a theme path is set. */
const plainHome = PathUtils.join(root, "plain");
const omarchyDark = PathUtils.join(root, "omarchy-dark");
const omarchyLight = PathUtils.join(root, "omarchy-light");
const realHome = Services.dirsvc.get("Home", Ci.nsIFile).path;

/** The page's tab, which the setup task opens. @type {MozTabbrowserTab | undefined} */
let tab;

/**
 * What the page in `browser` (the setup task's tab without one) reports for
 * prefers-color-scheme: "dark" or "light".
 * @param {XULBrowserElement} [browser]
 */
function pageScheme(browser = /** @type {MozTabbrowserTab} */ (tab).linkedBrowser) {
  return SpecialPowers.spawn(browser, [], () => {
    const dark = content.matchMedia("(prefers-color-scheme: dark)").matches;
    const bg = content.getComputedStyle(content.document.body).backgroundColor;
    return `${dark ? "dark" : "light"}:${bg === "rgb(0, 0, 0)" ? "dark" : "light"}`;
  });
}

/** Waits until the page sees `scheme`, in matchMedia and in its own CSS. */
async function expectPage(/** @type {"dark" | "light"} */ scheme, /** @type {string} */ msg) {
  let seen = "";
  await TestUtils.waitForCondition(
    async () => (seen = await pageScheme()) === `${scheme}:${scheme}`,
    msg,
    50,
    100,
  ).catch(() => {});
  Assert.equal(seen, `${scheme}:${scheme}`, msg);
}

/** Sets the system's colour scheme as Firefox sees it (no desktop portal under Xvfb). */
async function system(/** @type {"dark" | "light"} */ scheme) {
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", scheme === "dark" ? 1 : 0]] });
}

add_task(async function setup() {
  await IOUtils.makeDirectory(plainHome, { createAncestors: true });
  const toml = Object.entries(TOKYO_NIGHT)
    .filter(([k]) => k !== "mode")
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");
  await IOUtils.makeDirectory(omarchyDark, { createAncestors: true });
  await IOUtils.writeUTF8(PathUtils.join(omarchyDark, "colors.toml"), `mode = "dark"\n${toml}`);
  await IOUtils.makeDirectory(omarchyLight, { createAncestors: true });
  // An Omarchy light theme: no mode key, light.mode next to colors.toml.
  await IOUtils.writeUTF8(PathUtils.join(omarchyLight, "colors.toml"), toml);
  await IOUtils.writeUTF8(PathUtils.join(omarchyLight, "light.mode"), "");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.pollMs", 100],
    ],
    clear: [["vimma.theme.omarchyPath"], [APPEARANCE_PREF], [CONTENT_OVERRIDE_PREF]],
  });
  await ThemeHost.detectOmarchy(plainHome);
  tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(tab.linkedBrowser);
  registerCleanupFunction(async () => {
    ThemeHost.setConfig(DEFAULT_THEME);
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await ThemeHost.detectOmarchy(realHome);
    while (gBrowser.tabs.length > 1) {
      gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
    await SpecialPowers.popPrefEnv();
    await IOUtils.remove(root, { recursive: true });
  });
});

add_task(async function the_builtin_palette_on_system_passes_the_system_scheme_through() {
  await system("dark");
  await expectPage("dark", "a dark system: the page is dark");
  await SpecialPowers.popPrefEnv();
  await system("light");
  await expectPage("light", "a light system: the page is light, live");
  await SpecialPowers.popPrefEnv();
});

add_task(async function theme_light_and_dark_reach_web_pages() {
  await system("dark");
  Services.prefs.setStringPref(APPEARANCE_PREF, "light");
  await expectPage("light", ":theme light on a dark system: the page is light");
  const second = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  Assert.equal(await pageScheme(second.linkedBrowser), "light:light", "and so is a new tab");
  BrowserTestUtils.removeTab(second);
  await SpecialPowers.popPrefEnv();

  await system("light");
  Services.prefs.setStringPref(APPEARANCE_PREF, "dark");
  await expectPage("dark", ":theme dark on a light system: the page is dark");
  Services.prefs.clearUserPref(APPEARANCE_PREF);
  await expectPage("light", ":theme system: the system's light again");
  await SpecialPowers.popPrefEnv();
});

add_task(async function config_toml_appearance_reaches_web_pages() {
  await system("dark");
  ThemeHost.setConfig({ ...DEFAULT_THEME, appearance: "light" });
  await expectPage("light", "[theme] appearance = light on a dark system: the page is light");
  ThemeHost.setConfig(DEFAULT_THEME);
  await expectPage("dark", "without it, the system's dark");
  await SpecialPowers.popPrefEnv();
});

add_task(async function the_omarchy_themes_mode_reaches_web_pages() {
  await system("light");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.omarchyPath", omarchyDark]] });
  await expectPage("dark", "a dark Omarchy theme on a light system: the page is dark");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();

  await system("dark");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.omarchyPath", omarchyLight]] });
  await expectPage("light", "a light Omarchy theme (light.mode) on a dark system: light");
  await SpecialPowers.popPrefEnv();
  await expectPage("dark", "no Omarchy theme: the system's dark again");
  await SpecialPowers.popPrefEnv();
});

add_task(async function firefox_website_appearance_wins() {
  await system("dark");
  Services.prefs.setStringPref(APPEARANCE_PREF, "dark");
  await SpecialPowers.pushPrefEnv({ set: [[CONTENT_OVERRIDE_PREF, 1]] });
  await expectPage("light", "Settings → Website appearance: Light wins over :theme dark");
  await SpecialPowers.popPrefEnv();
  await expectPage("dark", "back to Automatic: :theme dark again");

  Services.prefs.setStringPref(APPEARANCE_PREF, "light");
  await SpecialPowers.pushPrefEnv({ set: [[CONTENT_OVERRIDE_PREF, 0]] });
  await expectPage("dark", "Website appearance: Dark wins over :theme light");
  await SpecialPowers.popPrefEnv();
  await expectPage("light", "Automatic: :theme light again");
  Services.prefs.clearUserPref(APPEARANCE_PREF);
  await SpecialPowers.popPrefEnv();
});
