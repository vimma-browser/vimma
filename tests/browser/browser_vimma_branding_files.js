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
  // The History sidebar's import promo (#897) and the vertical tabs' pinning promo, both Kit.
  ["chrome://browser/skin/sidebar/kit-history-import.svg", EMPTY],
  ["chrome://browser/skin/sidebar/foxy.svg", EMPTY],
  // Tab Overview's empty and error states with browser.nova.enabled off (#912), the History
  // sidebar's too.
  ["chrome://browser/content/firefoxview/history-empty.svg", EMPTY],
  ["chrome://browser/content/firefoxview/synced-tabs-empty.svg", EMPTY],
  ["chrome://browser/content/firefoxview/synced-tabs-error.svg", EMPTY],
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
 * A value the test's own lookup or wait found. It changes nothing at run time: a read through a
 * missing one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

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
    // Each key is a message of the resources; a read through a missing one, or through a message
    // without attributes, throws, as it did before.
    const value = attr
      ? found(found(message).attributes).find((a) => a.name === attr)?.value
      : found(message).value;
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
    // Settings loads in the parent process, so the browser has its document.
    const doc = found(browser.contentDocument);
    // The choice: a menu item or an option, which has its text as `label`.
    /** @type {(Element & { label?: string }) | null | undefined} */
    let option;
    await TestUtils.waitForCondition(() => {
      option = doc.querySelector(
        '#homepageNewTabs [data-l10n-id="home-mode-choice-default-fx"], ' +
          '[data-l10n-id="home-mode-choice-default-fx"]',
      );
      return option?.getAttribute("label") || option?.label;
    }, "the Home pane's default choice is translated");
    // The wait saw it with a label.
    const choice = found(option);
    const label = found(choice.getAttribute("label") || choice.label);
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
      /** @type {HTMLImageElement | null | undefined} */
      let img;
      await ContentTaskUtils.waitForCondition(() => {
        // The illustration is an <img> (aboutLogins.html, login-intro's template).
        img = /** @type {HTMLImageElement | null | undefined} */ (
          intro?.shadowRoot?.querySelector(".illustration")
        );
        return img?.complete;
      }, "the empty state's illustration has loaded");
      // The wait saw it; a content task has none of the file's helpers.
      const seen = /** @type {HTMLImageElement} */ (img);
      return [seen.naturalWidth, seen.naturalHeight];
    });
    Assert.deepEqual(size, [1, 1], "about:logins' empty state shows the empty image, not the fox");
  });
});

add_task(async function history_import_promo_brought_back_shows_no_kit() {
  // Off by default (browser.tabs.firefox-view.importHistory.dismissed, see
  // browser_vimma_firefox_surfaces_trim.js); with Firefox's value it comes back without Kit.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.firefox-view.importHistory.dismissed", false],
      ["browser.migrate.interactions.history", false],
    ],
  });
  registerCleanupFunction(async () => {
    SidebarController.hide();
    await PlacesUtils.history.clear();
  });
  await PlacesUtils.history.insert({ url: "https://example.com/", visits: [{ date: new Date() }] });
  await SidebarController.show("viewHistorySidebar");
  /** @type {SidebarHistoryElement | null | undefined} */
  let history;
  await TestUtils.waitForCondition(() => {
    history = SidebarController.browser.contentDocument?.querySelector("sidebar-history");
    return history?.controller && !history.controller.isHistoryPending;
  }, "the History sidebar loads");
  // The wait saw the sidebar with its controller.
  const sidebar = found(history);
  // The controller also looks the profile's age up itself, and may overwrite this; the harness
  // profile is new, so both are under 8 days.
  found(sidebar.controller).profileAge = 0;
  /** @type {HTMLImageElement | null | undefined} */
  let img;
  await TestUtils.waitForCondition(() => {
    img = /** @type {HTMLImageElement | null | undefined} */ (
      found(sidebar.shadowRoot)
        .querySelector(".import-history-promo")
        ?.shadowRoot?.querySelector(".image-container img")
    );
    return img?.complete;
  }, "the import promo's image has loaded");
  const promo = found(img);
  Assert.deepEqual(
    [promo.naturalWidth, promo.naturalHeight],
    [1, 1],
    "the import promo shows the empty image, not Kit",
  );
  SidebarController.hide();
  await PlacesUtils.history.clear();
  await SpecialPowers.popPrefEnv();
});

/**
 * Every empty state Tab Overview shows, deep in its shadow roots, as [class, image-container's
 * computed display] pairs.
 * @param {MozBrowser} browser
 * @returns {Promise<Array<[string, string]>>}
 */
function emptyStates(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    /** @param {Document | ShadowRoot} root @returns {Element[]} */
    const all = (root) =>
      [...root.querySelectorAll("*")].flatMap((el) => [
        ...(el.localName === "fxview-empty-state" ? [el] : []),
        ...(el.shadowRoot ? all(el.shadowRoot) : []),
      ]);
    /** @type {Element[]} */
    let states = [];
    await ContentTaskUtils.waitForCondition(() => {
      states = all(content.document).filter(
        (s) =>
          /** @type {HTMLImageElement | null | undefined} */ (
            s.shadowRoot?.querySelector(".image-container img")
          )?.complete,
      );
      return states.length >= 1;
    }, "Recent browsing shows its empty states");
    // Each state the filter kept has its shadow root and image container; a content task has
    // none of the file's helpers, so the casts are in place.
    return states.map((s) => [
      s.className,
      content.getComputedStyle(
        /** @type {Element} */ (
          /** @type {ShadowRoot} */ (s.shadowRoot).querySelector(".image-container")
        ),
      ).display,
    ]);
  });
}

add_task(async function tab_overview_empty_states_leave_no_picture_column() {
  // Every picture these empty states load serves the empty image, so its column (150-250px
  // beside the text on Recent browsing's cards) would only push the text off-centre (#912).
  await PlacesUtils.history.clear();
  for (const nova of [true, false]) {
    await SpecialPowers.pushPrefEnv({ set: [["browser.nova.enabled", nova]] });
    await BrowserTestUtils.withNewTab("about:firefoxview#recentbrowsing", async (browser) => {
      const states = await emptyStates(browser);
      for (const [name, display] of states) {
        Assert.equal(display, "none", `nova ${nova}: ${name} shows no picture column`);
      }
    });
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function synced_tabs_sidebar_empty_state_has_no_picture() {
  registerCleanupFunction(() => SidebarController.hide());
  await SidebarController.show("viewTabsSidebar");
  /** @type {Element | null | undefined} */
  let container;
  await TestUtils.waitForCondition(() => {
    const doc = SidebarController.browser.contentDocument;
    const panel = doc?.querySelector("sidebar-syncedtabs");
    container = panel?.shadowRoot
      ?.querySelector("fxview-empty-state")
      ?.shadowRoot?.querySelector(".image-container");
    return container;
  }, "the synced tabs sidebar shows its empty state");
  // The wait saw it, in the sidebar's shown document, which has its window.
  const box = found(container);
  Assert.equal(
    found(box.ownerDocument.defaultView).getComputedStyle(box).display,
    "none",
    "the sidebar's empty state shows no picture",
  );
  SidebarController.hide();
});

add_task(async function web_pages_keep_the_same_markup() {
  // The sheet is loaded into Tab Overview and the sidebar only: a web page with the same markup
  // keeps its layout, so the rule tells no page that it runs in Vimma.
  const markup =
    '<div class="image-container" part="image-container">' +
    '<img part="image" src="chrome://browser/content/firefoxview/history-empty.svg"></div>';
  await BrowserTestUtils.withNewTab(
    "https://example.com/document-builder.sjs?html=" + encodeURIComponent(markup),
    async (browser) => {
      const display = await SpecialPowers.spawn(
        browser,
        [],
        () =>
          // The page's markup has it; getComputedStyle throws without it, as it did before.
          content.getComputedStyle(
            /** @type {Element} */ (content.document.querySelector(".image-container")),
          ).display,
      );
      Assert.equal(display, "block", "a web page's own markup is left alone");
    },
  );
});
