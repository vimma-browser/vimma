/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 3 and 4c (branding
// files and images).

"use strict";

/* global Localization -- a chrome-window global (DOM Localization) */

const VIMMA_GLYPH = "chrome://browser/skin/vimma/vimma-glyph.svg";
const EMPTY = "chrome://browser/skin/vimma/empty.svg";
const ACCOUNT = "chrome://browser/skin/fxa/avatar-empty.svg";

/** @type {Array<[string, string]>} each overridden chrome URL and the file it must serve */
const OVERRIDES = [
  ["chrome://browser/skin/sidebar/firefox.svg", VIMMA_GLYPH],
  ["chrome://browser/skin/preferences/mozilla-logo.svg", ACCOUNT],
  ["chrome://browser/content/kit-signed-out.svg", EMPTY],
  ["chrome://browser/skin/sidebar/kit-page-history.svg", EMPTY],
  ["chrome://browser/skin/sidebar/kit-tabs-devices.svg", EMPTY],
  ["chrome://browser/skin/sidebar/kit-tabs-devices-error.svg", EMPTY],
  ["chrome://browser/skin/sidebar/kit-qr-tabs-devices-empty.svg", EMPTY],
  ["chrome://browser/skin/privatebrowsing/kit-pbw.svg", EMPTY],
  ["chrome://browser/skin/privatebrowsing/fox-tail.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-concerned.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-confetti.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-happy.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-in-circle.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-holding-lock.svg", EMPTY],
  ["chrome://global/skin/illustrations/kit-sympathetic.svg", EMPTY],
  ["chrome://mozapps/skin/extensions/kit-addons.svg", EMPTY],
  ["chrome://mozapps/skin/extensions/kit-themes.svg", EMPTY],
  // Step 4c: the error pages' fox and the certificate viewer's error mascot.
  ["chrome://global/skin/illustrations/error-malformed-url.svg", EMPTY],
  ["chrome://global/skin/illustrations/no-connection.svg", EMPTY],
  ["chrome://global/skin/illustrations/security-error.svg", EMPTY],
  // The fox on a chest in about:logins' and the Passwords sidebar's empty state.
  ["chrome://global/content/megalist/icons/cpm-fox-illustration.svg", EMPTY],
];

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function text(url) {
  const response = await fetch(url);
  return response.text();
}

/**
 * Formats messages through a Localization over the given resources, without Fluent's
 * isolation marks.
 *
 * @param {string[]} resources
 * @param {Array<{id: string, attr?: string}>} keys
 * @returns {Promise<string[]>}
 */
async function format(resources, keys) {
  const l10n = new Localization(resources, true);
  const messages = await l10n.formatMessages(keys.map(({ id }) => ({ id })));
  return messages.map((message, i) => {
    const attr = keys[i].attr;
    const value = attr ? message.attributes.find((a) => a.name === attr)?.value : message.value;
    return String(value).replace(/[⁨⁩]/g, "");
  });
}

add_task(async function brand_shortcut_name_resolves() {
  const [entry, shortcut] = await format(
    ["branding/brand.ftl", "browser/linuxDesktopEntry.ftl", "browser/browser.ftl"],
    [{ id: "desktop-entry-name" }, { id: "private-browsing-shortcut-text-2" }],
  );
  Assert.equal(entry, "Vimma", "desktop-entry-name");
  Assert.equal(shortcut, "Vimma Private Browsing", "private-browsing-shortcut-text-2");
});

add_task(async function product_names_are_neutral() {
  const resources = [
    "branding/brand.ftl",
    "toolkit/branding/brandings.ftl",
    "browser/browser.ftl",
    "browser/preferences/preferences.ftl",
    "browser/firefoxView.ftl",
  ];
  const got = await format(resources, [
    { id: "addressbar-header-firefox-suggest-2", attr: "label" },
    { id: "urlbar-result-menu-manage-firefox-suggest2" },
    { id: "home-mode-choice-default-fx", attr: "label" },
    { id: "firefoxview-page-title" },
    { id: "quickactions-labs" },
    { id: "fx-translate-web-pages" },
  ]);
  Assert.deepEqual(got, [
    "Address Bar Suggestions",
    "Manage Address Bar Suggestions",
    "Start Page (Default)",
    "Tab Overview",
    "Open Labs",
    "Translations",
  ]);
});

add_task(async function settings_home_menu_offers_the_start_page() {
  await BrowserTestUtils.withNewTab("about:preferences#home", async (browser) => {
    const doc = browser.contentDocument;
    let option;
    await TestUtils.waitForCondition(() => {
      option = doc.querySelector(
        '#homepageNewTabs [data-l10n-id="home-mode-choice-default-fx"], ' +
          '[data-l10n-id="home-mode-choice-default-fx"]',
      );
      return option?.getAttribute("label") || option?.label;
    }, "the Home pane's default choice is translated");
    const label = option.getAttribute("label") || option.label;
    Assert.equal(label.replace(/[⁨⁩]/g, ""), "Start Page (Default)");
  });
});

add_task(async function logos_and_mascots_serve_vimma_files() {
  for (const [url, target] of OVERRIDES) {
    Assert.equal(await text(url), await text(target), `${url} serves ${target}`);
  }
  Assert.ok((await text(VIMMA_GLYPH)).includes("context-fill"), "the glyph follows the theme");
  // about:logins' breach and vulnerable-password alerts are security information: their icons
  // stay Firefox's.
  for (const icon of ["breached-website.svg", "vulnerable-password.svg"]) {
    const url = `chrome://browser/content/aboutlogins/icons/${icon}`;
    Assert.notEqual(await text(url), await text(EMPTY), `${url} keeps its picture`);
  }
});

add_task(async function logins_empty_state_shows_no_fox() {
  await BrowserTestUtils.withNewTab("about:logins", async (browser) => {
    const size = await SpecialPowers.spawn(browser, [], async () => {
      const intro = content.document.querySelector("login-intro");
      let img;
      await ContentTaskUtils.waitForCondition(() => {
        img = intro?.shadowRoot?.querySelector(".illustration");
        return img?.complete;
      }, "the empty state's illustration has loaded");
      return [img.naturalWidth, img.naturalHeight];
    });
    Assert.deepEqual(size, [1, 1], "about:logins' empty state shows the empty image, not the fox");
  });
});
