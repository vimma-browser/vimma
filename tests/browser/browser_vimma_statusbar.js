/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m2-statusbar-whichkey.md

/* global focusContent, bindUnbuiltPrefixKey -- from head.js */

"use strict";

// ctrl+b o: a key under the prefix the host has not built (head.js).
bindUnbuiltPrefixKey();

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { DOMFullscreenTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs",
);
DOMFullscreenTestUtils.init(this, window);

const TEST_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const TITLE_PAGE = `${TEST_ROOT}file_vimma_title.html`;
const LONG_TITLE = "Vimma status bar test page with a deliberately long title for width fitting";

const $ = (/** @type {string} */ id) => document.getElementById(id);

function bar() {
  return $("vimma-statusbar");
}

/** @param {string} id segment id from vimma-core's statusSegments */
function seg(id) {
  return bar()?.querySelector(`[data-segment="${id}"]`) ?? null;
}

function segText(id) {
  return seg(id)?.textContent ?? null;
}

function hasSize(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

registerCleanupFunction(() => {
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  const help = $("vimma-help");
  if (help?.open) help.close();
  if (bar()) {
    bar().style.removeProperty("width");
    bar().style.removeProperty("font-size");
    bar().style.removeProperty("padding-inline");
  }
});

add_task(async function bar_is_visible_at_the_window_bottom() {
  const b = bar();
  Assert.ok(b, "#vimma-statusbar exists");
  Assert.ok(hasSize(b), "the bar has a size");
  // Only our zero-height prompt rows (the command line, the rename prompt, the agent question)
  // may sit between.
  let prev = b.previousElementSibling;
  while (prev && ["vimma-cmdline", "vimma-rename", "vimma-agent-prompt"].includes(prev.id)) {
    Assert.equal(prev.getBoundingClientRect().height, 0, `#${prev.id} takes no height`);
    prev = prev.previousElementSibling;
  }
  Assert.equal(prev?.id, "browser", "it follows #browser in the body");
  const browserBox = $("browser").getBoundingClientRect();
  const r = b.getBoundingClientRect();
  Assert.lessOrEqual(Math.abs(r.top - browserBox.bottom), 1, "directly below the browser area");
  Assert.lessOrEqual(
    Math.abs(r.bottom - document.documentElement.getBoundingClientRect().bottom),
    1,
    "at the bottom of the window",
  );
  Assert.ok(hasSize(seg("mode")), "mode badge visible");
});

add_task(async function bar_uses_theme_tokens() {
  // a dark desktop: the built-in vimma palette's dark variant
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 1]] });
  await TestUtils.waitForCondition(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue("--vimma-color-scheme").trim() ===
      "dark",
    "the dark scheme applies",
  );
  const style = getComputedStyle(document.documentElement);
  Assert.equal(
    style.getPropertyValue("--vimma-statusbar-bg").trim(),
    "#050c0d",
    "the built-in vimma tokens are defined on the window root",
  );
  const b = getComputedStyle(bar());
  Assert.equal(b.backgroundColor, "rgb(5, 12, 13)", "the bar's background is the token");
  await SpecialPowers.popPrefEnv();
});

add_task(async function mode_follows_the_host_and_help() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async () => {
    const mode = VimmaHost.status(window).mode;
    await until(() => segText("mode") === mode.toUpperCase(), `mode badge reads ${mode}`);
    // The page's mode (normal, insert in a field) or insert while chrome has focus.
    Assert.ok(["normal", "insert"].includes(mode), `base mode is normal or insert (${mode})`);
    const badgeBg = getComputedStyle(seg("mode")).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue(`--vimma-mode-${mode}`)
      .trim();
    const probe = document.createElement("div");
    probe.style.color = token;
    document.body.append(probe);
    Assert.equal(badgeBg, getComputedStyle(probe).color, `badge uses --vimma-mode-${mode}`);
    probe.remove();

    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("?", { shiftKey: true });
    await until(() => segText("mode") === "HELP", "HELP while the overlay is open");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => segText("mode") === mode.toUpperCase(), "back after Esc");
  });
});

add_task(async function mode_follows_focus_into_a_page_input() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async (browser) => {
    await focusContent(browser);
    await until(() => segText("mode") === "NORMAL", "NORMAL on a page");
    // No key is pressed: only the actor's focus report (VimmaHost.onModeChange) can tell the bar.
    let told = 0;
    const off = VimmaHost.onStateChange(window, () => told++);
    await SpecialPowers.spawn(browser, [], () => content.document.getElementById("field").focus());
    await until(() => VimmaHost.status(window).mode === "insert", "the host is in insert");
    await until(() => told > 0, "the host tells its listeners about the focus report");
    off();
    await until(() => segText("mode") === "INSERT", "INSERT after focusing an input");
    await until(
      () => bar().querySelector("[aria-live=polite]").textContent === "insert mode",
      "the mode change is announced",
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => segText("mode") === "NORMAL", "NORMAL again after Esc");
  });
});

add_task(async function font_change_re_measures_the_column() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async () => {
    const b = bar();
    b.style.width = "600px";
    b.style.paddingInline = "8px"; // padding in ch would resize the content box with the font
    await until(() => segText("title")?.endsWith("…"), "title shortened in a 600px bar");
    const before = segText("title");
    // Same bar size, twice the glyph width: only the probe's ResizeObserver entry sees it.
    b.style.fontSize = "24px";
    await until(() => segText("title") !== before, "the title is fitted again");
    const right = b.getBoundingClientRect().right - parseFloat(getComputedStyle(b).paddingRight);
    for (const s of b.querySelectorAll("[data-segment]")) {
      Assert.lessOrEqual(
        s.getBoundingClientRect().right,
        right + 1,
        `${s.dataset.segment} fits after the font change`,
      );
    }
    b.style.removeProperty("font-size");
    b.style.removeProperty("padding-inline");
    b.style.removeProperty("width");
  });
});

/**
 * Visible and on top: elementFromPoint at its centre lands on it or inside it.
 * @param {Element | null} el
 */
function onTop(el) {
  if (!el || /** @type {HTMLElement} */ (el).hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility !== "visible") return false;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && (top === el || el.contains(top));
}

function noticeShown() {
  const n = $("vimma-notice");
  return !!n?.matches(":popover-open") && getComputedStyle(n).visibility === "visible";
}

/** Everything that could list keys or sit over a list: the overlay, a strip, the toast. */
function lists() {
  const found = [];
  if (onTop($("vimma-help"))) found.push("vimma-help");
  if ($("vimma-whichkey") || document.documentElement.hasAttribute("vimma-whichkey-open")) {
    found.push("vimma-whichkey");
  }
  if (noticeShown()) found.push("vimma-notice");
  return found;
}

/** @param {number} n */
async function afterFrames(n) {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}

add_task(async function notice_sits_above_the_bar() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async (browser) => {
    await focusContent(browser);
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("o"); // history_back: not implemented yet (head.js)
    await until(noticeShown, "ctrl+b o shows the notice");
    Assert.lessOrEqual(
      $("vimma-notice").getBoundingClientRect().bottom,
      bar().getBoundingClientRect().top,
      "the notice is above the status bar",
    );
    $("vimma-notice").hidePopover();
  });
});

// Only prefix+? lists the bindings; there is no which-key strip
// (docs/specs/m2-statusbar-whichkey.md).
add_task(async function prefix_alone_shows_no_list() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async (browser) => {
    await focusContent(browser);
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    await until(() => segText("pending") === "prefix", "the bar shows the pending prefix");
    await afterFrames(3); // time to render a list, were one coming
    Assert.deepEqual(lists(), [], "ctrl+b alone shows no keybinding list");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => segText("pending") === null, "Esc clears the pending segment");
  });
});

add_task(async function prefix_question_shows_exactly_one_list() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async (browser) => {
    await focusContent(browser);
    // A toast from an earlier key must not linger over the overlay.
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("o");
    await until(noticeShown, "ctrl+b o shows the notice");
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("?", { shiftKey: true });
    await until(() => $("vimma-help")?.open, "ctrl+b ? opens the help overlay");
    await afterFrames(2);
    Assert.deepEqual(lists(), ["vimma-help"], "the overlay is the one list on screen");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !$("vimma-help")?.open, "help closed");
  });
});

add_task(async function tab_position_follows_open_and_select() {
  const first = gBrowser.selectedTab;
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  await until(() => segText("tab") === "tab 3/3", "tab 3/3 after opening two tabs");
  gBrowser.selectedTab = first;
  await until(() => segText("tab") === "tab 1/3", "tab 1/3 after selecting the first");
  gBrowser.removeTab(gBrowser.tabs.at(-1));
  await until(() => segText("tab") === "tab 1/2", "tab 1/2 after closing one");
  gBrowser.removeTab(gBrowser.tabs.at(-1));
});

add_task(async function title_and_url_after_load() {
  await BrowserTestUtils.withNewTab("about:blank", async (browser) => {
    BrowserTestUtils.startLoadingURIString(browser, TITLE_PAGE);
    await BrowserTestUtils.browserLoaded(browser);
    await until(() => segText("title") === LONG_TITLE, "the title shows after load");
    const url = TITLE_PAGE.replace(/^https:\/\//, "");
    await until(() => segText("url") === url, "the URL shows without its scheme");
    Assert.ok(segText("url").startsWith("example.com/"), "with the host first");
    // busy goes after the load event, with the network stop.
    await until(() => seg("loading") === null, "no loading indicator once loaded");
  });
});

add_task(async function narrow_bar_drops_url_and_keeps_mode() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async () => {
    await until(() => segText("url") !== null, "URL shown at full width");
    // 40ch: the workspace segment (m3-workspaces 2b) takes nine columns of the old 30.
    bar().style.width = "40ch";
    await until(() => seg("url") === null, "URL dropped in a narrow bar");
    Assert.ok(seg("mode"), "mode badge stays");
    Assert.ok(hasSize(seg("mode")), "and is visible");
    Assert.ok(segText("title")?.endsWith("…"), "the title is shortened to fit, not dropped");
    // Every segment ends inside the bar's content box: fitted, not clipped.
    const box = bar().getBoundingClientRect();
    const right = box.right - parseFloat(getComputedStyle(bar()).paddingRight);
    for (const s of bar().querySelectorAll("[data-segment]")) {
      Assert.lessOrEqual(
        s.getBoundingClientRect().right,
        right + 1,
        `${s.dataset.segment} fits in the narrow bar`,
      );
    }
    bar().style.removeProperty("width");
    await until(() => segText("url") !== null, "URL back at full width");
  });
});

add_task(async function dom_fullscreen_hides_the_bar() {
  await BrowserTestUtils.withNewTab(TITLE_PAGE, async (browser) => {
    const before = $("browser").getBoundingClientRect().height;
    await DOMFullscreenTestUtils.changeFullscreen(browser, true);
    await until(() => !hasSize(bar()), "bar hidden in DOM fullscreen");
    const winBottom = document.documentElement.getBoundingClientRect().bottom;
    await until(
      () => Math.abs($("browser").getBoundingClientRect().bottom - winBottom) <= 1,
      "#browser reaches the window bottom",
    );
    await DOMFullscreenTestUtils.changeFullscreen(browser, false);
    await until(() => hasSize(bar()), "bar back after leaving fullscreen");
    await until(
      () => Math.abs($("browser").getBoundingClientRect().height - before) <= 1,
      "the browser area has its old height again",
    );
  });
});

add_task(async function browser_fullscreen_keeps_the_bar() {
  const entered = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = true;
  await entered;
  await until(() => document.documentElement.hasAttribute("inFullscreen"), "F11 fullscreen");
  Assert.ok(hasSize(bar()), "the bar stays in browser fullscreen");
  const left = BrowserTestUtils.waitForEvent(window, "fullscreen");
  window.fullScreen = false;
  await left;
  await until(() => !document.documentElement.hasAttribute("inFullscreen"), "left fullscreen");
  Assert.ok(hasSize(bar()), "and after it");
});

add_task(async function bar_announces_mode_only() {
  const b = bar();
  Assert.equal(b.getAttribute("role"), "status", "role=status");
  Assert.equal(b.getAttribute("aria-live"), "off", "title and URL changes are not announced");
  const live = b.querySelectorAll("[aria-live=polite]");
  Assert.equal(live.length, 1, "one polite live region");
  Assert.equal(
    live[0].textContent.toLowerCase(),
    `${VimmaHost.status(window).mode} mode`,
    "it holds the mode",
  );
});
