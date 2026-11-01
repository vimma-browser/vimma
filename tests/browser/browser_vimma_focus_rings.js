/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vimma's own focus rings are the theme's (docs/specs/m7-a11y.md, "Focus rings in Vimma's UI"):
// every part of Vimma's UI that takes focus draws a 2px --vimma-focus ring on :focus-visible, or,
// for the one-line command line and prompts, which exist only while focused, no ring at all and a
// prompt that reaches 3:1. None of them falls through to the UA's `outline: 1px auto`, which
// Firefox paints natively in the system accent (a blue), whatever --focus-outline-color says.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VIMMA_DARK, contrastRatio } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/theme.mjs",
);

const PAGE = "https://example.com/";

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** "rgb(r, g, b)" → "#rrggbb". */
function hex(css) {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  Assert.ok(m, `an opaque colour: ${css}`);
  return `#${m
    .slice(1)
    .map((c) => Number(c).toString(16).padStart(2, "0"))
    .join("")}`;
}

const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Opens a page in a new tab and focuses it, in normal mode. */
async function openPage(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode on the page");
  return tab;
}

/** Waits for focus to land on `el()`, keyboard focus, so :focus-visible applies. */
async function focusedOn(el, what) {
  await until(() => el() && document.activeElement === el(), `${what} takes focus`);
  const node = /** @type {Element} */ (el());
  Assert.ok(node.matches(":focus-visible"), `${what}: keyboard focus (:focus-visible)`);
  return node;
}

/**
 * `node`'s ring: a solid 2px --vimma-focus outline, never the UA's `auto` (painted in the system
 * accent, not in outline-color).
 */
function expectAquaRing(node, what) {
  const style = getComputedStyle(node);
  Assert.notEqual(style.outlineStyle, "auto", `${what}: not the UA's native (blue) focus ring`);
  Assert.equal(style.outlineStyle, "solid", `${what}: a solid ring`);
  Assert.equal(style.outlineWidth, "2px", `${what}: 2px wide`);
  Assert.equal(style.outlineColor, rgb(VIMMA_DARK.accent), `${what}: in --vimma-focus (aqua)`);
}

/**
 * The one-line command line and prompts: no ring (the line exists only while focused), and the
 * prompt in front of the caret marks it at 3:1 or better.
 */
function expectNoRingAndAPrompt(input, row, what) {
  const style = getComputedStyle(input);
  Assert.equal(style.outlineStyle, "none", `${what}: no ring, and so no native (blue) one`);
  const prompt = /** @type {Element} */ (row.querySelector(".vimma-cmdline-prompt"));
  const panel = /** @type {Element} */ (row.closest(".vimma-cmdline-panel"));
  const ratio = contrastRatio(
    hex(getComputedStyle(prompt).color),
    hex(getComputedStyle(panel).backgroundColor),
  );
  info(`${what}: prompt on the line ${ratio.toFixed(2)}:1`);
  Assert.greaterOrEqual(ratio, 3, `${what}: the prompt marks the focused line at 3:1`);
}

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 1]] });
  await until(() => token("--vimma-color-scheme") === "dark", "vimma dark");
  Assert.equal(token("--vimma-focus"), VIMMA_DARK.accent, "--vimma-focus is vimma dark's aqua");
  registerCleanupFunction(async () => {
    for (const id of [
      "vimma-help",
      "vimma-picker",
      "vimma-workspace-picker",
      "vimma-addon-picker",
    ]) {
      document.getElementById(id)?.close?.();
    }
    const ww = WindowWorkspaces.get(window);
    const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
    if (ww && main) ww.switchTo({ id: main.id });
    for (const w of WorkspaceStore.definitions.workspaces.filter(
      (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
    )) {
      await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
    }
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await SpecialPowers.popPrefEnv();
  });
});

add_task(async function side_panel_list_has_a_aqua_ring() {
  const tab = await openPage();
  prefix("b");
  const list = await focusedOn(
    () => document.querySelector("#vimma-panel:not([hidden]) [role=listbox]"),
    "the side panel's list",
  );
  expectAquaRing(list, "side panel list");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === tab.linkedBrowser, "the panel closes");
  gBrowser.removeTab(tab);
});

add_task(async function bookmarks_tree_and_filter_have_aqua_rings() {
  const model = WindowWorkspaces.get(window).model;
  const active = model.workspaces.find((w) => w.id === model.active).name;
  const [folder] = await PlacesUtils.bookmarks.insertTree({
    guid: PlacesUtils.bookmarks.toolbarGuid,
    children: [
      {
        title: active,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        children: [{ title: "focus ring", url: `${PAGE}?ring` }],
      },
    ],
  });
  registerCleanupFunction(() => PlacesUtils.bookmarks.remove(folder.guid).catch(() => {}));
  const tab = await openPage();
  prefix("B", { shiftKey: true });
  const tree = await focusedOn(
    () => document.querySelector("#vimma-bookmarks:not([hidden]) [role=tree]"),
    "the bookmarks tree",
  );
  await until(() => tree.querySelector("[role=treeitem]"), "the tree has loaded");
  expectAquaRing(tree, "bookmarks tree");
  EventUtils.synthesizeKey("/");
  const filter = await focusedOn(
    () => document.getElementById("vimma-bookmarks-filter"),
    "the bookmarks filter",
  );
  expectAquaRing(filter, "bookmarks filter");
  const box = /** @type {Element} */ (document.getElementById("vimma-bookmarks"));
  while (!box.hidden) {
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => box.hidden || filter.hidden, "Esc clears the filter, then closes");
  }
  await until(() => document.activeElement === tab.linkedBrowser, "the panel closes");
  gBrowser.removeTab(tab);
});

/** A picker opened by prefix+`key`: its focused list. */
async function expectPickerRing(key, id, what) {
  const tab = await openPage();
  prefix(key);
  const list = await focusedOn(() => {
    const d = /** @type {HTMLDialogElement | null} */ (document.getElementById(id));
    return d?.open ? d.querySelector("[role=listbox]") : null;
  }, `the ${what}'s list`);
  expectAquaRing(list, what);
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === tab.linkedBrowser, `the ${what} closes`);
  gBrowser.removeTab(tab);
}

add_task(async function goto_picker_list_has_a_aqua_ring() {
  await expectPickerRing("g", "vimma-picker", "goto picker");
});

add_task(async function workspace_picker_list_has_a_aqua_ring() {
  await expectPickerRing("w", "vimma-workspace-picker", "workspace picker");
});

add_task(async function addon_picker_list_has_a_aqua_ring() {
  await expectPickerRing("e", "vimma-addon-picker", "add-on picker");
});

add_task(async function help_overlay_and_its_filter_have_aqua_rings() {
  const tab = await openPage();
  prefix("?", { shiftKey: true });
  const dialog = await focusedOn(() => {
    const d = /** @type {HTMLDialogElement | null} */ (document.getElementById("vimma-help"));
    return d?.open ? d : null;
  }, "the help overlay");
  expectAquaRing(dialog, "help overlay");
  EventUtils.synthesizeKey("/");
  const input = await focusedOn(
    () => document.querySelector("#vimma-help input"),
    "the help overlay's filter",
  );
  expectAquaRing(input, "help filter");
  EventUtils.synthesizeKey("KEY_Escape");
  if (document.getElementById("vimma-help")?.open) EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === tab.linkedBrowser, "the overlay closes");
  gBrowser.removeTab(tab);
});

add_task(async function command_line_has_no_ring_and_a_prompt_that_marks_it() {
  const tab = await openPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  const input = await focusedOn(
    () => document.getElementById("vimma-cmdline-input"),
    "the command line",
  );
  expectNoRingAndAPrompt(input, input.closest(".vimma-cmdline-row"), "command line");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === tab.linkedBrowser, "the line closes");
  gBrowser.removeTab(tab);
});

add_task(async function rename_prompt_has_no_ring_and_a_prompt_that_marks_it() {
  const tab = await openPage();
  prefix("T", { shiftKey: true });
  const input = await focusedOn(
    () => document.getElementById("vimma-rename-input"),
    "the rename prompt",
  );
  expectNoRingAndAPrompt(input, input.closest(".vimma-cmdline-row"), "rename prompt");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === tab.linkedBrowser, "the prompt closes");
  gBrowser.removeTab(tab);
});

add_task(async function yes_no_question_has_no_ring_and_a_prompt_that_marks_it() {
  await openPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("wsnew rings");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => WorkspaceStore.definitions.workspaces.some((w) => w.name === "rings"),
    "a second workspace, so closing one asks",
  );
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "its home tab has loaded");
  await focusContent(browser);
  prefix("D", { shiftKey: true });
  const input = await focusedOn(
    () => document.getElementById("vimma-rename-input"),
    "the y/N question",
  );
  const row = input.closest(".vimma-cmdline-row");
  Assert.stringContains(row.textContent, "y/N", "sanity: a y/N question");
  expectNoRingAndAPrompt(input, row, "y/N question");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => document.activeElement === browser, "the question closes");
});
