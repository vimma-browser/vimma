/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-help-overlay.md

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, bindUnbuiltPrefixKey -- from head.js */

"use strict";

// ctrl+b o: a key under the prefix the host has not built (head.js).
bindUnbuiltPrefixKey();

const { DEFAULT_CONFIG, bindingTable, compileKeymap, filterBindings, keyLegend } =
  ChromeUtils.importESModule("chrome://browser/content/vimma/core/index.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { HelpOverlay } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/help-overlay.mjs",
);

const OVERLAY_ID = "vimma-help";
const TEST_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);

registerCleanupFunction(() => {
  // If a test fails half-way, do not leave the modal overlay over the next test file.
  overlay()?.close();
  SidebarController.hide();
});

function overlay() {
  return /** @type {HTMLDialogElement | null} */ (document.getElementById(OVERLAY_ID));
}

function isShown() {
  const o = overlay();
  return !!o && o.open && BrowserTestUtils.isVisible(o);
}

function filterInput() {
  return overlay().querySelector("input");
}

/** Action names of the rows a user can see. */
function visibleNames() {
  return [...overlay().querySelectorAll("[data-action]")]
    .filter((row) => BrowserTestUtils.isVisible(row))
    .map((row) => row.dataset.action);
}

function pressPrefixQuestionMark() {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("?", { shiftKey: true });
}

async function openHelp() {
  pressPrefixQuestionMark();
  await TestUtils.waitForCondition(isShown, "help overlay opens on ctrl+b ?");
}

async function closeHelp() {
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !isShown(), "help overlay closes on Esc");
}

/** Like pdfjs/test/head.js waitForPdfJS: resolves once the text layer has rendered. */
function loadPdf(browser, url) {
  const rendered = BrowserTestUtils.waitForContentEvent(
    browser,
    "textlayerrendered",
    false,
    null,
    true,
  );
  BrowserTestUtils.startLoadingURIString(browser, url);
  return rendered;
}

add_task(async function shows_bindings_over_about_preferences() {
  await BrowserTestUtils.withNewTab("about:preferences", async (browser) => {
    await SimpleTest.promiseFocus(browser.contentWindow);
    await openHelp();
    Assert.ok(visibleNames().includes("new_tab"), "overlay lists new_tab");
    Assert.ok(
      overlay().querySelector('[data-action="new_tab"]').textContent.includes("ctrl+b c"),
      "new_tab row shows its binding",
    );
    await closeHelp();
  });
});

add_task(async function shows_bindings_over_the_pdf_viewer() {
  await BrowserTestUtils.withNewTab("about:blank", async (browser) => {
    await loadPdf(browser, TEST_ROOT + "file_vimma_test.pdf");
    const isPdfJs = await SpecialPowers.spawn(
      browser,
      [],
      () => !!content.document.querySelector("div#viewer"),
    );
    Assert.ok(isPdfJs, "the PDF is open in pdf.js");
    browser.focus();
    await openHelp();
    Assert.ok(visibleNames().includes("new_tab"), "overlay lists new_tab over pdf.js");
    await closeHelp();
  });
});

add_task(async function slash_filters_the_rows() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await openHelp();
    EventUtils.synthesizeKey("/");
    Assert.equal(document.activeElement, filterInput(), "/ focuses the filter input");
    EventUtils.sendString("rename");
    Assert.equal(filterInput().value, "rename", "typed text lands in the filter, without the /");

    const expected = filterBindings(bindingTable(compileKeymap()), "rename").map((r) => r.name);
    Assert.ok(expected.includes("rename_tab"), "sanity: rename_tab matches rename");
    Assert.deepEqual(visibleNames(), expected, "only rows matching rename are shown");
    Assert.ok(!visibleNames().includes("new_tab"), "new_tab is filtered out");

    await closeHelp();
    Assert.equal(document.activeElement, browser, "Esc from the filter returns focus to content");
  });
});

/** The text of a row's keys column. */
function keysOf(dialog, name) {
  return dialog.querySelector(`[data-action="${name}"] .vimma-help-keys`).textContent;
}

add_task(async function rows_show_the_keys_to_press_under_a_legend() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await openHelp();
    const legend = overlay().querySelector(".vimma-help-key-legend");
    Assert.ok(legend && BrowserTestUtils.isVisible(legend), "a legend heads the overlay");
    Assert.equal(legend.textContent, keyLegend(compileKeymap()), "the legend of the live keymap");
    Assert.equal(
      legend.textContent,
      "prefix = ctrl+b",
      "the prefix; no default binding uses the leader",
    );
    Assert.equal(
      overlay().querySelector("header").nextElementSibling,
      legend,
      "the legend comes right under the header",
    );
    Assert.ok(keysOf(overlay(), "toggle_sidebar").startsWith("ctrl+b b"), "the sidebar keys");
    Assert.equal(keysOf(overlay(), "close_tab"), "ctrl+b shift+x, ctrl+f4, x", "close_tab's keys");
    // docs/specs/firefox-keys.md: Firefox's keys are listed next to Vimma's (history_back is
    // rebound in this file: bindUnbuiltPrefixKey), Firefox's macOS keys on macOS (macos-build
    // decision 29).
    Assert.equal(
      keysOf(overlay(), "history_forward"),
      Services.appinfo.OS === "Darwin"
        ? "meta+right, meta+], L, ctrl+i, ctrl+]"
        : "alt+right, L, ctrl+i, ctrl+]",
      "Go forward lists every key that goes forward",
    );
    Assert.ok(!overlay().textContent.includes("prefix+"), "no prefix+ notation anywhere");
    Assert.ok(!overlay().textContent.includes("<leader>"), "no <leader> notation anywhere");

    for (const query of ["ctrl+b b", "sidebar"]) {
      EventUtils.synthesizeKey("/");
      filterInput().value = "";
      EventUtils.sendString(query);
      Assert.ok(visibleNames().includes("toggle_sidebar"), `"${query}" finds toggle_sidebar`);
    }
    Assert.ok(!visibleNames().includes("new_tab"), "and filters new_tab out");
    await closeHelp();
  });
});

add_task(async function a_remapped_prefix_and_leader_show_in_the_rows_and_legend() {
  const km = compileKeymap({
    keys: { prefix: "ctrl+a", toggle_sidebar: ["prefix+b", "<leader>n"] },
    modal: { leader: "," },
  });
  const help = new HelpOverlay(window, compileKeymap());
  help.setKeymap(km);
  gBrowser.selectedBrowser.focus();
  help.open();
  try {
    Assert.equal(keysOf(help.dialog, "toggle_sidebar"), "ctrl+a b, , n", "the remapped keys");
    Assert.equal(
      help.dialog.querySelector(".vimma-help-key-legend").textContent,
      "prefix = ctrl+a · leader = ,",
    );
  } finally {
    help.close();
    help.destroy();
  }
});

add_task(async function the_legend_leaves_out_a_leader_nothing_uses() {
  // Every default list without its leader bindings, so no binding uses the leader.
  const keys = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG.keys)
      .filter(([, v]) => [v].flat().some((b) => /<leader>/i.test(b)))
      .map(([k, v]) => [k, [v].flat().filter((b) => !/<leader>/i.test(b))]),
  );
  const help = new HelpOverlay(window, compileKeymap({ keys }));
  gBrowser.selectedBrowser.focus();
  help.open();
  try {
    Assert.equal(keysOf(help.dialog, "toggle_sidebar"), "ctrl+b b", "only the prefix binding");
    Assert.equal(
      help.dialog.querySelector(".vimma-help-key-legend").textContent,
      "prefix = ctrl+b",
    );
  } finally {
    help.close();
    help.destroy();
  }
});

add_task(async function esc_closes_and_restores_focus() {
  await BrowserTestUtils.withNewTab("about:preferences", async (browser) => {
    await SimpleTest.promiseFocus(browser.contentWindow);
    const searchInput = browser.contentDocument.getElementById("searchInput");
    searchInput.focus();
    const before = Services.focus.focusedElement;
    Assert.ok(
      before && (before === searchInput || searchInput.shadowRoot?.contains(before)),
      `focus starts in the preferences search box (got ${before?.localName})`,
    );

    await openHelp();
    Assert.ok(overlay().contains(Services.focus.focusedElement), "the overlay has focus");

    await closeHelp();
    Assert.equal(Services.focus.focusedElement, before, "focus returns to the search box");
  });
});

add_task(async function help_show_while_open_closes_it() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await openHelp();
    pressPrefixQuestionMark();
    await TestUtils.waitForCondition(() => !isShown(), "ctrl+b ? toggles the overlay");
    Assert.equal(document.activeElement, browser, "focus returns to content");
  });
});

/**
 * Presses z (unbound, so never ours outside help) and returns the page's keys (recordPageKeys),
 * ending with "z". A key that is not ours proves the listener works and flushes any in-flight
 * events. Gives up after 5 s, so a swallowed z fails the assertion instead of timing out the
 * whole file. (Not j: since M1 it scrolls in normal mode.)
 */
async function pageKeysThenZ(browser) {
  EventUtils.synthesizeKey("z");
  await waitForPageKey(browser, ["z", "!z"]);
  return pageKeys(browser);
}

add_task(async function page_receives_no_keydown_for_the_chord() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await openHelp();
    await closeHelp();
    Assert.deepEqual(
      await pageKeysThenZ(browser),
      ["z"],
      "the page saw neither ctrl+b nor ? (nor Esc)",
    );
    Assert.ok(!SidebarController.isOpen, "ctrl+b no longer toggles the bookmarks sidebar");
  });
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

add_task(async function bare_prefix_does_not_time_out() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    await wait(compileKeymap().timeoutMs + 400);
    EventUtils.synthesizeKey("?", { shiftKey: true });
    await TestUtils.waitForCondition(isShown, "ctrl+b, a pause, then ? still opens help");
    await closeHelp();
    Assert.deepEqual(await pageKeysThenZ(browser), ["z"], "the page saw neither key");
  });
});

add_task(async function esc_in_normal_mode_reaches_the_page() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    // Esc is bound only in the other modes (escape.mjs: normal with nothing pending passes).
    EventUtils.synthesizeKey("KEY_Escape");
    Assert.deepEqual(
      await pageKeysThenZ(browser),
      ["Escape", "z"],
      "Esc reaches the page, not default-prevented",
    );
  });
});

add_task(async function unrunnable_key_inside_a_prefix_sequence_is_consumed() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    const tabs = gBrowser.tabs.length;
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    EventUtils.synthesizeKey("o"); // history_back: not runnable yet (head.js)
    Assert.deepEqual(await pageKeysThenZ(browser), ["z"], "ctrl+b o leaks no o to the page");
    Assert.equal(gBrowser.tabs.length, tabs, "and does nothing else yet");
  });
});

add_task(async function tab_select_resets_a_pending_prefix() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    const tab = gBrowser.selectedTab;
    EventUtils.synthesizeKey("b", { ctrlKey: true });
    await BrowserTestUtils.switchTab(gBrowser, gBrowser.tabs[0]);
    await BrowserTestUtils.switchTab(gBrowser, tab);
    await focusContent(browser);
    // `?` is normal mode's backward find since m1-find: it opens the find bar, not help.
    EventUtils.synthesizeKey("?", { shiftKey: true });
    await TestUtils.waitForCondition(
      () => gBrowser.getCachedFindBar()?.hidden === false,
      "after a tab switch ? is normal mode's ?, not ctrl+b ?",
    );
    Assert.ok(!isShown(), "help did not open");
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(() => document.activeElement === browser, "find cancelled");
    Assert.deepEqual(await pageKeysThenZ(browser), ["z"], "neither ? nor Esc reached the page");
  });
});

add_task(async function q_closes_the_overlay() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await openHelp();
    EventUtils.synthesizeKey("q");
    await TestUtils.waitForCondition(() => !isShown(), "q closes the overlay");
    Assert.equal(document.activeElement, browser, "focus returns to content");
  });
});

add_task(async function help_mode_consumes_unbound_chords() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    const tabs = gBrowser.tabs.length;
    await openHelp();
    EventUtils.synthesizeKey("w", { ctrlKey: true });
    await wait(500); // tab closing is asynchronous; give a leaked ctrl+w time to land
    Assert.equal(gBrowser.tabs.length, tabs, "ctrl+w does not close the tab under the overlay");
    Assert.ok(isShown(), "the overlay stays open");
    await closeHelp();
    Assert.equal(document.activeElement, browser, "focus returns to content");
  });
});

add_task(async function closing_the_tab_underneath_closes_help_and_refocuses() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/");
  tab.linkedBrowser.focus();
  await openHelp();
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(() => !isShown(), "help closes with its tab");
  Assert.equal(
    document.activeElement,
    gBrowser.selectedBrowser,
    "focus lands on the now-selected browser",
  );
});

add_task(async function reinit_leaves_one_overlay() {
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    browser.focus();
    await openHelp();
    await closeHelp();
    VimmaHost.uninit(window);
    Assert.equal(document.querySelectorAll(`#${OVERLAY_ID}`).length, 0, "uninit removes it");
    VimmaHost.init(window);
    await openHelp();
    Assert.equal(
      document.querySelectorAll(`#${OVERLAY_ID}`).length,
      1,
      "one overlay after re-init",
    );
    await closeHelp();
  });
});

add_task(async function overrides_are_marked() {
  const help = new HelpOverlay(window, compileKeymap({ keys: { new_tab: ["ctrl+alt+c"] } }));
  gBrowser.selectedBrowser.focus();
  help.open();
  try {
    const marker = (name) =>
      help.dialog.querySelector(`[data-action="${name}"] .vimma-help-override`).textContent;
    Assert.equal(marker("new_tab"), "*", "an overridden action is marked *");
    Assert.equal(marker("close_tab"), "", "a default one is not");
  } finally {
    help.close();
    help.destroy();
  }
});

add_task(async function rows_mark_what_the_host_can_run() {
  await BrowserTestUtils.withNewTab("about:preferences", async (browser) => {
    await SimpleTest.promiseFocus(browser.contentWindow);
    await openHelp();
    const row = (name) => overlay().querySelector(`[data-action="${name}"]`);
    // Host actions and page actions (scroll, Esc/i) alike: the overlay is not about focus.
    for (const name of [
      "show_keybinds",
      "new_tab",
      "next_tab",
      "select_tab_3",
      "close_tab",
      "split_vertical",
      "focus_pane_left",
      "zoom",
      "close_pane",
      "next_workspace",
      "new_workspace",
      "rename_workspace",
      "close_workspace",
      "scroll_down",
      "scroll_top",
      "normal_mode",
      "insert_mode",
      "workspace_picker",
      "toggle_sidebar",
    ]) {
      Assert.equal(row(name).dataset.runnable, "true", `${name} is marked implemented`);
    }
    for (const name of ["history_back"]) {
      Assert.equal(row(name).dataset.runnable, "false", `${name} is marked not yet`);
    }
    // Dimmed by colour, never by opacity, so the text keeps its contrast (spec m7-a11y).
    const keys = (name) => getComputedStyle(row(name).querySelector(".vimma-help-keys")).color;
    const opacity = (name) => Number(getComputedStyle(row(name)).opacity);
    Assert.equal(opacity("new_tab"), 1, "an implemented row is not dimmed");
    Assert.equal(opacity("history_back"), 1, "a not-yet row keeps full opacity");
    Assert.notEqual(keys("history_back"), keys("new_tab"), "a not-yet row is dimmed");
    const legend = overlay().querySelector(".vimma-help-legend");
    Assert.ok(legend && BrowserTestUtils.isVisible(legend), "a legend explains the dimming");
    Assert.stringContains(legend.textContent, "not implemented yet");
    await closeHelp();
  });
});

add_task(async function a_given_runnable_set_decides_the_marks() {
  const help = new HelpOverlay(window, compileKeymap(), new Set(["tab.rename"]));
  gBrowser.selectedBrowser.focus();
  help.open();
  try {
    const mark = (name) => help.dialog.querySelector(`[data-action="${name}"]`).dataset.runnable;
    Assert.equal(mark("rename_tab"), "true", "an id in the set is implemented");
    Assert.equal(mark("new_tab"), "false", "an id outside it is not");
  } finally {
    help.close();
    help.destroy();
  }
});
