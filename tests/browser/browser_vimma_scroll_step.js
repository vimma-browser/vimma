/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-actor-insert-scroll.md, "Follow-up: scroll step" (issue #1074).

/* global focusContent, contextOf, windowGlobalOf -- from head.js */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_insert_scroll.html";

/** The default step (Vimium's scrollStepSize), in CSS pixels. */
const DEFAULT_STEP = 60;

const dir = PathUtils.join(PathUtils.tempDir, `vimma-scroll-step-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");
let writes = 0;

/**
 * Writes config.toml and reads it at once (`:source`).
 * @param {string} text
 */
async function useConfig(text) {
  writes++;
  await IOUtils.writeUTF8(file, `schema = 2\n${text}\n${"#".repeat(writes)}\n`);
  await ConfigHost.reload();
  Assert.deepEqual(ConfigHost.errors, [], "config.toml applies");
}

/**
 * Opens the long fixture with content focus in normal mode, then runs `fn`.
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(fn) {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the tab is in normal mode",
    );
    await fn(browser);
  });
}

/** @param {XULBrowserElement} browser */
function pageScrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

/**
 * @param {XULBrowserElement} browser
 * @param {number} y
 * @param {string} msg
 */
function waitForScrollY(browser, y, msg) {
  return TestUtils.waitForCondition(async () => (await pageScrollY(browser)) === y, msg);
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", file],
      ["general.smoothScroll", false],
    ],
  });
  registerCleanupFunction(async () => {
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
  });
});

add_task(async function j_and_k_scroll_by_the_configured_step() {
  await useConfig("[scroll]\nstep = 150");
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("j");
    await waitForScrollY(browser, 150, "j scrolls down 150px");
    EventUtils.synthesizeKey("3");
    EventUtils.synthesizeKey("j");
    await waitForScrollY(browser, 600, "3j scrolls three steps of 150px");
    EventUtils.synthesizeKey("k");
    await waitForScrollY(browser, 450, "k scrolls up 150px");
  });
});

add_task(async function a_reloaded_config_applies_to_the_next_scroll() {
  await useConfig("[scroll]\nstep = 150");
  await withPage(async (browser) => {
    EventUtils.synthesizeKey("j");
    await waitForScrollY(browser, 150, "j scrolls down 150px");
    await useConfig("[scroll]\nstep = 25");
    EventUtils.synthesizeKey("j");
    await waitForScrollY(browser, 175, "the open page's next j scrolls 25px");
    await useConfig("");
    EventUtils.synthesizeKey("j");
    await waitForScrollY(browser, 175 + DEFAULT_STEP, "without [scroll], j scrolls 60px again");
  });
});

// The child checks the step the parent sends as config.toml does, so a step no file could set
// scrolls by the default instead.
add_task(async function the_child_ignores_a_step_config_toml_could_not_set() {
  await useConfig("");
  const bad = [0, -60, 2001, 1e9, 60.5, NaN, "150", null, { step: 150 }];
  await withPage(async (browser) => {
    const actor = windowGlobalOf(contextOf(browser)).getActor("Vimma");
    let y = 0;
    for (const step of bad) {
      const moved = await actor.sendQuery("Vimma:Scroll", {
        kind: "down",
        count: 1,
        instant: true,
        step,
      });
      Assert.ok(moved, `a scroll with step ${JSON.stringify(step)} ran`);
      y += DEFAULT_STEP;
      await waitForScrollY(browser, y, `step ${JSON.stringify(step)} scrolls the default 60px`);
    }
    await actor.sendQuery("Vimma:Scroll", { kind: "down", count: 1, instant: true, step: 7 });
    await waitForScrollY(browser, y + 7, "a step in range is taken");
  });
});
