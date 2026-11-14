/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, delivery steps 1 (Settings' Learn more links),
// 4a (Settings > Sync's sign-in) and 4b (Settings keeps Sync and support, Firefox Home's group
// with the start page off, and looks like Vimma). What Settings hides is in
// browser_vimma_firefox_settings_hidden.js.
//
// Moved out of browser_vimma_firefox_surfaces_trim.js (#992): each about:preferences tab builds
// its pane on the parent's main thread, which on a loaded machine takes seconds, and together
// the Settings tests took that file past the harness's 45 s limit. That file clears the harness
// profile's own values for the step 2 prefs (browser.shell.checkDefaultBrowser and
// browser.uitour.url); neither touches what these tests check.

"use strict";

/* global useShippedSupportBase, inSettingsPane -- from head.js */

add_task(async function settings_learn_more_links_open_vimma_dev() {
  const base = await useShippedSupportBase();
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async (browser) => {
    info("Waiting for Settings' privacy pane to give its Learn more links an href");
    const links = await SpecialPowers.spawn(browser, [], async () => {
      // Settings builds some groups after load, so wait for its Learn more links to have an href.
      const selector = 'a[is="moz-support-link"][support-page], moz-support-link[support-page]';
      await ContentTaskUtils.waitForCondition(
        () => [...content.document.querySelectorAll(selector)].some((a) => a.href),
        "Settings' Learn more links",
      );
      return [...content.document.querySelectorAll(selector)]
        .filter((a) => a.href)
        .map((a) => ({ page: a.getAttribute("support-page"), href: a.href }));
    });
    Assert.ok(links.length, `Settings has Learn more links (${links.length})`);
    for (const { page, href } of links) {
      Assert.ok(
        href.startsWith(`${base}${page}`),
        `Settings' Learn more link for ${page} opens vimma.dev: ${href}`,
      );
    }
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function sync_sign_in_stays_in_settings() {
  await BrowserTestUtils.withNewTab("about:preferences#sync", async (browser) => {
    const doc = browser.contentDocument;
    info("Waiting for Settings > Sync to render its sign-in button");
    await TestUtils.waitForCondition(
      () => doc.getElementById("noFxaSignIn"),
      "Settings > Sync renders its sign-in button",
    );
    const button = /** @type {HTMLElement} */ (doc.getElementById("noFxaSignIn"));
    Assert.ok(BrowserTestUtils.isVisible(button), "Settings > Sync offers sign-in");
    Assert.ok(!button.hasAttribute("disabled"), "and it can be pressed");
  });
});

// Step 4b: Settings keeps Sync and support (decision 1) and looks like Vimma (decision 8).

add_task(async function settings_keep_sync_and_support() {
  await inSettingsPane("general", "#setting-control-supportGetHelp", (doc, help) => {
    const sync = /** @type {HTMLElement} */ (doc.getElementById("category-sync"));
    Assert.ok(BrowserTestUtils.isVisible(sync), "Settings' navigation keeps Sync");
    Assert.notEqual(
      doc.defaultView.getComputedStyle(help).display,
      "none",
      "Settings keeps the Vimma support link",
    );
  });
});

add_task(async function settings_show_firefox_home_without_the_start_page() {
  // No preloaded Firefox new tab: once one loads, typed Firefox pages stay Firefox's while its
  // process runs (#950), and later files expect the start page.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.startpage.newtab", false],
      ["browser.newtab.preload", false],
    ],
  });
  await inSettingsPane("home", 'setting-group[groupid="home"]', (doc, group) => {
    Assert.notEqual(
      doc.defaultView.getComputedStyle(group).display,
      "none",
      "with Firefox Home as the new tab page, Settings shows its content group",
    );
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_look_like_vimma() {
  await inSettingsPane("general", "setting-group moz-card", (doc, card) => {
    const win = doc.defaultView;
    const radius = (/** @type {Element | null | undefined} */ el) =>
      el ? win.getComputedStyle(el).borderTopLeftRadius : "missing";
    const font = win.getComputedStyle(doc.documentElement).getPropertyValue("--vimma-font").trim();
    Assert.ok(font, `the theme's font token reaches Settings: ${font}`);
    const body = /** @type {HTMLElement} */ (doc.body);
    Assert.equal(win.getComputedStyle(body).fontFamily, font, "Settings' text is the theme's font");
    Assert.equal(radius(card), "0px", "a Settings card is square");
    const nav = doc.querySelector("moz-page-nav-button")?.shadowRoot?.querySelector("a, button");
    Assert.equal(radius(nav), "0px", "a navigation button is square");
    const search = doc.querySelector("moz-input-search")?.shadowRoot?.querySelector("input");
    Assert.equal(radius(search), "0px", "the search field is square");
  });
});
