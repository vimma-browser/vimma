/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, decision 8 (Since changed, #1617). The controls
// Settings draws in shadow roots that its document sheets do not reach take the theme's font too:
// a visual picker's item (Website appearance's Automatic, Light and Dark), whose labels sit inside
// its <button>, and a checkbox's input without a font of its own (the backup dialog's), which the
// UA gives the system's field font.

"use strict";

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global openSettingsPane -- from head.js */

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
const DEFAULT_THEME = {
  source: /** @type {const} */ ("omarchy"),
  name: "vimma",
  font: "monospace",
  colors: {},
};
// A font no system font is called, so a control left with the system's font cannot pass by
// chance, as it can against monospace (a field's system font in a headless build).
const FONT = "Vimma Test Mono";

add_setup(async function () {
  ThemeHost.setConfig({ ...DEFAULT_THEME, font: FONT });
  registerCleanupFunction(() => ThemeHost.setConfig(DEFAULT_THEME));
  await TestUtils.waitForCondition(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--vimma-font").includes(FONT),
    "the theme's font token takes config.toml's font",
  );
});

/**
 * The element `selector` matches in `host`'s shadow root.
 * @param {Element | null} host
 * @param {string} selector
 */
function inner(host, selector) {
  return /** @type {Element} */ (host?.shadowRoot?.querySelector(selector));
}

/**
 * The first element `selector` matches in `root` or in any shadow root under it.
 * @param {Document | ShadowRoot} root
 * @param {string} selector
 * @returns {Element | null}
 */
function deep(root, selector) {
  const found = root.querySelector(selector);
  if (found) return found;
  for (const el of root.querySelectorAll("*")) {
    const inShadow = el.shadowRoot && deep(el.shadowRoot, selector);
    if (inShadow) return inShadow;
  }
  return null;
}

add_task(async function settings_controls_have_the_theme_font() {
  await openSettingsPane(
    "appearance",
    "#web-appearance-chooser moz-visual-picker-item",
    async (doc) => {
      const win = /** @type {Window} */ (doc.defaultView);
      await TestUtils.waitForCondition(
        () => win.getComputedStyle(doc.documentElement).fontFamily.includes(FONT),
        "Settings' text takes config.toml's font",
      );
      const font = win.getComputedStyle(doc.documentElement).fontFamily;
      const item = doc.querySelector("#web-appearance-chooser moz-visual-picker-item");
      await TestUtils.waitForCondition(
        () => inner(item, "#picker-item"),
        "the visual picker's item renders its button",
      );
      const label = /** @type {Element} */ (inner(item, ".label"));
      Assert.equal(
        win.getComputedStyle(inner(item, "#picker-item")).fontFamily,
        font,
        "a visual picker's item has the theme's font",
      );
      Assert.ok(label, "the visual picker's item has its label");
      Assert.equal(
        win.getComputedStyle(label).fontFamily,
        font,
        "a visual picker's label has the theme's font",
      );
      // The backup dialog's checkbox (backup-settings > turn-on-scheduled-backups, each in the
      // other's shadow root) has no font of its own, where moz-checkbox's inherits.
      const selector = "turn-on-scheduled-backups";
      await TestUtils.waitForCondition(
        () => inner(deep(doc, selector), 'input[type="checkbox"]'),
        "the backup dialog renders its checkbox",
      );
      const backup = deep(doc, selector);
      Assert.equal(
        win.getComputedStyle(inner(backup, 'input[type="checkbox"]')).fontFamily,
        font,
        "a checkbox's input has the theme's font",
      );
    },
  );
});
