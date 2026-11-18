/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-hints.md (decision 12: the user's hint is the user's gesture);
// docs/specs/mcp-forms.md F8 and docs/security/12-agents-mcp.md M26 (an agent's click is not).
// A label the user types gives the page their transient user activation, as a click would: a
// link to a new tab opens it, a button's window.open opens, full screen is granted and a select
// opens its list. The agent's click on the same button, through the same child, gets none.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);
const { AgentActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/AgentActors.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = DIR + "file_vimma_hints_activation.html";

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      // The test profile turns the pop-up blocker and full screen's gesture check off; a user's
      // profile has both on.
      ["dom.disable_open_during_load", true],
      ["full-screen-api.allow-trusted-requests-only", true],
      ["full-screen-api.transition-duration.enter", "0 0"],
      ["full-screen-api.transition-duration.leave", "0 0"],
      ["full-screen-api.warning.timeout", 0],
    ],
  });
});

/**
 * Opens the fixture in a new tab with content focus in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(fn) {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the tab is in normal mode",
    );
    try {
      await fn(browser);
    } finally {
      if (VimmaHost._hints(window)) EventUtils.synthesizeKey("KEY_Escape");
    }
  });
}

/**
 * The centre of the element with this id, in the page's CSS pixels.
 * @param {XULBrowserElement} browser @param {string} id
 * @returns {Promise<{ x: number, y: number }>}
 */
function centre(browser, id) {
  return SpecialPowers.spawn(browser, [id], (elId) => {
    const el = /** @type {Element} */ (content.document.getElementById(elId));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/**
 * The target among `targets` whose box holds `c`.
 * @template {{ rect: { x: number, y: number, width: number, height: number } }} T
 * @param {T[]} targets @param {{ x: number, y: number }} c
 * @returns {T | undefined}
 */
function targetAt(targets, c) {
  return targets.find(
    (t) =>
      c.x >= t.rect.x &&
      c.x <= t.rect.x + t.rect.width &&
      c.y >= t.rect.y &&
      c.y <= t.rect.y + t.rect.height,
  );
}

/**
 * Presses `f` and types the label of the element with this id, as the user does.
 * @param {XULBrowserElement} browser @param {string} id
 */
async function hint(browser, id) {
  EventUtils.synthesizeKey("f");
  await TestUtils.waitForCondition(
    () => VimmaHost._hints(window)?.hints.length,
    "hints are collected",
  );
  const hints = /** @type {HostHints} */ (VimmaHost._hints(window)).hints;
  const at = await centre(browser, id);
  const label = hints.find((h) => targetAt([h.target], at))?.label;
  Assert.ok(label, `${id} has a label`);
  for (const c of /** @type {string} */ (label)) EventUtils.synthesizeKey(c);
}

/**
 * What the page saw of its buttons' clicks.
 * @param {XULBrowserElement} browser
 * @returns {Promise<Record<string, { active: boolean, opened?: boolean, result?: string }>>}
 */
const seen = (browser) =>
  SpecialPowers.spawn(browser, [], () => JSON.parse(JSON.stringify(content.wrappedJSObject.seen)));

const blockedBar = (/** @type {XULBrowserElement} */ browser) =>
  gBrowser.getNotificationBox(browser).getNotificationWithValue("popup-blocked");

add_task(async function a_hint_on_a_target_blank_link_opens_a_new_tab() {
  await withPage(async (browser) => {
    const isNew = (/** @type {MozTabbrowserTab} */ t) =>
      !!t.linkedBrowser.currentURI?.spec.endsWith("?blank");
    await hint(browser, "blank");
    // Blocked, the bar shows and no tab comes.
    await TestUtils.waitForCondition(
      () => gBrowser.tabs.some(isNew) || blockedBar(browser),
      "a tab opened or the pop-up was blocked",
    );
    Assert.ok(!blockedBar(browser), "no pop-up blocked bar");
    const tab = gBrowser.tabs.find(isNew);
    Assert.ok(tab, "the link opened in a new tab");
    if (tab) BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function a_hint_on_a_window_open_button_opens_it() {
  await withPage(async (browser) => {
    // With width and height, window.open opens a window of its own.
    const opened = BrowserTestUtils.waitForNewWindow({ url: PAGE + "?opened" });
    await hint(browser, "opener");
    await TestUtils.waitForCondition(async () => (await seen(browser)).opener, "it clicked");
    const page = await seen(browser);
    Assert.equal(page.opener.active, true, "the click handler ran with user activation");
    Assert.equal(page.opener.opened, true, "window.open returned a window");
    Assert.ok(!blockedBar(browser), "no pop-up blocked bar");
    if (page.opener.opened) await BrowserTestUtils.closeWindow(await opened);
  });
});

add_task(async function a_hint_on_a_fullscreen_button_enters_full_screen() {
  await withPage(async (browser) => {
    await hint(browser, "fs");
    await TestUtils.waitForCondition(
      async () => (await seen(browser)).fs?.result !== "pending" && (await seen(browser)).fs,
      "the request settled",
    );
    const page = await seen(browser);
    Assert.equal(page.fs.result, "entered", "the page went full screen");
    if (page.fs.result !== "entered") return;
    await SpecialPowers.spawn(browser, [], () => content.document.exitFullscreen());
    await TestUtils.waitForCondition(
      () => !document.documentElement.hasAttribute("inDOMFullscreen"),
      "full screen ended",
    );
  });
});

add_task(async function a_hint_on_a_select_opens_its_list() {
  await withPage(async (browser) => {
    await hint(browser, "sel");
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(browser, [], () => {
          const { SelectContentHelper } = ChromeUtils.importESModule(
            "moz-src:///toolkit/actors/SelectChild.sys.mjs",
          );
          return SelectContentHelper.open;
        }),
      "the select's list is open",
    );
    const dropdown = /** @type {{ menupopup?: { hidePopup(): void } } | null} */ (
      /** @type {unknown} */ (document.getElementById("ContentSelectDropdown"))
    );
    const popup = dropdown?.menupopup;
    popup?.hidePopup();
  });
});

add_task(async function an_agent_click_on_the_same_button_gets_no_activation() {
  await withPage(async (browser) => {
    // The agent's click goes through the same child and the same press as the user's hint
    // (mcp-forms F8), in a tab of the user's here, where no sandbox flag blocks a pop-up: only
    // the missing activation can.
    const targets = await VimmaActors.collectHints(browser, "hint.follow", {
      agent: true,
      elements: true,
    });
    const target = targetAt(targets, await centre(browser, "opener"));
    Assert.ok(target, "the agent's list has the button");
    const reply = await AgentActors.agentActivate(/** @type {HintTarget} */ (target), {
      submit: null,
      href: null,
      until: Date.now() + 10000,
    });
    Assert.equal(reply, "ok", "the child took the click");
    await TestUtils.waitForCondition(async () => (await seen(browser)).opener, "it clicked");
    const page = await seen(browser);
    Assert.equal(page.opener.active, false, "no user activation in the handler (M26)");
    Assert.equal(page.opener.opened, false, "window.open was blocked");
    const gesture = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.hasBeenUserGestureActivated,
    );
    Assert.equal(gesture, false, "the document was never activated");
  });
});
