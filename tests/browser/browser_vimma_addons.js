/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/addon-manager.md. ctrl+b e lists the installed extensions (never system or
// hidden ones); Enter opens an add-on's popup with focus inside (Esc closes it, focus returns to
// the page) or runs its button's command; o options, x enable/disable, d remove after y/N with a
// stale-answer guard, u update check, shift+p private windows; :addon <name> with Tab completion.
// Three extensions from inline XPIs: one with a popup, one with options_ui (and a button
// without a popup), one with neither.

"use strict";

/* global focusContent -- from head.js */

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionPermissions } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionPermissions.sys.mjs",
);
const { ExtensionTestCommon } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionTestCommon.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const UPDATES = ROOT + "file_vimma_addon_updates.json";
const PAGE = "https://example.com/";
const PICKER_ID = "vimma-addon-picker";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const INPUT_ID = "vimma-cmdline-input";

const POPUP = { id: "popup@vimma.test", name: "Popup <b>one</b>" };
const OPTIONS = { id: "options@vimma.test", name: "Options two" };
const PLAIN = { id: "plain@vimma.test", name: "Plain three" };

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

// The picker is a modal <dialog> in the chrome document (ui/picker.mjs), its rows HTML elements.
const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
const isOpen = () => !!picker()?.open;
const rows = () =>
  /** @type {HTMLElement[]} */ ([...(picker()?.querySelectorAll("[role=option]") ?? [])]);
/** @param {Element | undefined} row @param {string} name */
const cell = (row, name) => found(found(row).querySelector(`.vimma-picker-${name}`)).textContent;
const names = () => rows().map((r) => cell(r, "title"));
/** @param {string} id */
const rowOf = (id) => rows().find((r) => r.dataset.id === id);
const selected = () =>
  /** @type {HTMLElement | null} */ (
    found(picker()).querySelector("[role=option][aria-selected=true]")
  );
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const promptText = () =>
  (
    document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? ""
  ).trim();
const popupFocused = () =>
  !!document.activeElement?.classList?.contains("webextension-popup-browser");

/**
 * Resolves with the first truthy value of `cond`.
 * @template T
 * @param {() => T} cond
 * @param {string} msg
 */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/**
 * ctrl+b, then `key`.
 * @param {string} key
 * @param {KeyEventOptions} [mods]
 */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** @type {ExtensionWrapper[]} */
const extensions = [];

/** @param {object} manifest @param {Record<string, string>} [files] */
async function install(manifest, files = {}) {
  /** @type {ExtensionWrapper} */
  const ext = ExtensionTestUtils.loadExtension({ useAddonManager: "permanent", manifest, files });
  await ext.startup();
  extensions.push(ext);
  return ext;
}

// The setup task sets these before any other task runs.
/** @type {ExtensionWrapper} */
let popupExt;
/** @type {ExtensionWrapper} */
let optionsExt;
/** @type {MozTabbrowserTab} */
let tab;

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({ set: [["extensions.checkUpdateSecurity", false]] });
  popupExt = await install(
    {
      name: POPUP.name,
      version: "1.0",
      browser_specific_settings: { gecko: { id: POPUP.id, update_url: UPDATES } },
      browser_action: { default_popup: "popup.html" },
    },
    {
      "popup.html": `<!doctype html><meta charset=utf-8><input id=i><script src=popup.js></script>`,
      "popup.js": `browser.test.sendMessage("popup-ready");`,
    },
  );
  optionsExt = await install(
    {
      name: OPTIONS.name,
      version: "2.0",
      browser_specific_settings: { gecko: { id: OPTIONS.id, update_url: UPDATES } },
      options_ui: { page: "options.html" },
      browser_action: {},
      background: { scripts: ["background.js"] },
    },
    {
      "options.html": `<!doctype html><meta charset=utf-8><title>opts</title><p>options`,
      "background.js": `browser.browserAction.onClicked.addListener(() =>
        browser.test.sendMessage("clicked"));`,
    },
  );
  await install({
    name: PLAIN.name,
    version: "3.0",
    browser_specific_settings: { gecko: { id: PLAIN.id } },
  });
  tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
});

registerCleanupFunction(async () => {
  if (isOpen()) EventUtils.synthesizeKey("KEY_Escape");
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  for (const ext of extensions) await ext.unload().catch(() => {});
  for (const id of [POPUP.id, OPTIONS.id, PLAIN.id]) {
    const addon = await AddonManager.getAddonByID(id);
    await addon?.uninstall();
  }
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
});

/** Focuses the test page, so keys reach Vimma in normal mode. */
async function focusPage() {
  if (isOpen()) EventUtils.synthesizeKey("KEY_Escape"); // left open by a failed task
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
}

/** ctrl+b e from the page, waiting for the picker's rows. */
async function openPicker() {
  await focusPage();
  prefix("e");
  await until(isOpen, "ctrl+b e opens the add-on picker");
}

/**
 * Opens the picker and selects the add-on named `query` (/ filter, Esc back to browse).
 * @param {string} query
 * @param {string} id
 */
async function pick(query, id) {
  await openPicker();
  EventUtils.synthesizeKey("/");
  EventUtils.sendString(query);
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => selected()?.dataset.id === id, `"${query}" selects ${id}`);
  Assert.ok(isOpen(), "Esc in the filter keeps the picker open");
}

add_task(async function lists_extensions_but_not_system_ones() {
  await openPicker();
  const listed = names();
  for (const { name } of [POPUP, OPTIONS, PLAIN]) {
    Assert.ok(listed.includes(name), `${name} is listed`);
  }
  // Each is an AddonWrapper (engine/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs).
  const system = (await AddonManager.getAddonsByTypes(["extension"])).filter(
    (/** @type {{ isSystem: boolean, hidden: boolean, isBuiltin: boolean }} */ a) =>
      a.isSystem || a.hidden || a.isBuiltin,
  );
  Assert.greater(system.length, 0, "sanity: the build has system add-ons");
  for (const a of system) {
    Assert.ok(!rows().some((r) => r.dataset.id === a.id), `system add-on ${a.id} is not listed`);
  }
  Assert.equal(cell(rowOf(PLAIN.id), "host"), "3.0 · enabled", "version and state");
  Assert.equal(VimmaHost.status(window).mode, "help", "modal while open");
  EventUtils.synthesizeKey("q");
  await until(() => !isOpen(), "q closes");
  await openPicker();
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes");
  Assert.equal(document.activeElement, tab.linkedBrowser, "focus is back on the page");
});

add_task(async function names_with_html_are_text() {
  await openPicker();
  const title = found(found(rowOf(POPUP.id)).querySelector(".vimma-picker-title"));
  Assert.equal(title.textContent, POPUP.name, "the name as written");
  Assert.strictEqual(title.querySelector("b"), null, "no markup was parsed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
});

add_task(async function enter_opens_the_popup_with_focus_and_esc_returns() {
  await pick("popup", POPUP.id);
  const ready = popupExt.awaitMessage("popup-ready");
  EventUtils.synthesizeKey("KEY_Enter");
  await ready;
  Assert.ok(!isOpen(), "the picker closed");
  await until(popupFocused, "focus is inside the popup");
  const hidden = BrowserTestUtils.waitForEvent(document, "popuphidden", true);
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await until(() => document.activeElement === tab.linkedBrowser, "focus returns to the page");
  Assert.equal(VimmaHost.status(window).mode, "normal", "back in normal mode");
});

add_task(async function enter_runs_a_button_command_or_says_there_is_none() {
  await pick("options", OPTIONS.id);
  const clicked = optionsExt.awaitMessage("clicked");
  EventUtils.synthesizeKey("KEY_Enter");
  await clicked;
  Assert.ok(true, "a button without a popup ran its onClicked command");

  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === `${PLAIN.name}: no popup or button`, "says there is none");
});

add_task(async function o_opens_the_options_or_the_details() {
  await pick("options", OPTIONS.id);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) => url.endsWith("/options.html"));
  EventUtils.synthesizeKey("o");
  const optionsTab = await opened;
  Assert.ok(!isOpen(), "the picker closed");
  Assert.ok(
    optionsTab.linkedBrowser.currentURI.spec.startsWith("moz-extension://"),
    "the add-on's own options page",
  );
  BrowserTestUtils.removeTab(optionsTab);

  await pick("plain", PLAIN.id);
  const details = BrowserTestUtils.waitForNewTab(gBrowser, "about:addons");
  EventUtils.synthesizeKey("o");
  const detailsTab = await details;
  await until(
    () =>
      detailsTab.linkedBrowser.contentDocument?.querySelector(`addon-card[addon-id="${PLAIN.id}"]`),
    "about:addons shows the add-on's details",
  );
  BrowserTestUtils.removeTab(detailsTab);
});

add_task(async function x_toggles_enabled() {
  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("x");
  await until(async () => (await AddonManager.getAddonByID(PLAIN.id)).userDisabled, "disabled");
  await until(() => cell(rowOf(PLAIN.id), "host").includes("disabled"), "the row says disabled");
  Assert.ok(isOpen(), "the picker stays open");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().startsWith(`${PLAIN.name} is disabled`), "Enter refuses");
  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("x");
  await until(async () => !(await AddonManager.getAddonByID(PLAIN.id)).userDisabled, "enabled");
  await until(() => cell(rowOf(PLAIN.id), "host") === "3.0 · enabled", "the row says enabled");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function shift_p_toggles_private_windows() {
  const allowed = async () =>
    (await ExtensionPermissions.get(PLAIN.id)).permissions.includes(
      "internal:privateBrowsingAllowed",
    );
  Assert.ok(!(await allowed()), "sanity: not allowed in private windows");
  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("P", { shiftKey: true });
  await until(allowed, "allowed in private windows");
  await until(() => cell(rowOf(PLAIN.id), "host").includes("private ok"), "the row says so");
  EventUtils.synthesizeKey("P", { shiftKey: true });
  await until(async () => !(await allowed()), "not allowed again");
  await until(() => !cell(rowOf(PLAIN.id), "host").includes("private ok"), "the row too");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function u_reports_the_update_check() {
  await pick("options", OPTIONS.id);
  EventUtils.synthesizeKey("u");
  await until(() => noticeText() === `${OPTIONS.name}: no update`, "no update", 300);
  await pick("popup", POPUP.id);
  EventUtils.synthesizeKey("u");
  await until(() => noticeText().startsWith(`${POPUP.name}: update 9.0 available`), "found", 300);
  await until(() => cell(rowOf(POPUP.id), "host").endsWith("· update"), "the row says update");
  Assert.equal(
    (await AddonManager.getAddonByID(POPUP.id)).version,
    "1.0",
    "the update is not installed by Vimma",
  );
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function colon_addon_opens_a_popup_with_tab_completion() {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("addon popu");
  EventUtils.synthesizeKey("KEY_Tab");
  // The command line's <input>; a read through a missing one throws, as it did before.
  const input = /** @type {HTMLInputElement} */ (document.getElementById(INPUT_ID));
  await until(() => input.value === `addon ${POPUP.name}`, "Tab completes the add-on's name");
  const ready = popupExt.awaitMessage("popup-ready");
  EventUtils.synthesizeKey("KEY_Enter");
  await ready;
  await until(popupFocused, "focus is inside the popup");
  const hidden = BrowserTestUtils.waitForEvent(document, "popuphidden", true);
  EventUtils.synthesizeKey("KEY_Escape");
  await hidden;
  await until(() => document.activeElement === tab.linkedBrowser, "focus returns to the page");

  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("addon zzzz");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === 'no add-on matches "zzzz"', "no match says so");
});

add_task(async function d_removes_after_yes_and_keeps_after_no() {
  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("d");
  await until(promptOpen, "d asks first");
  Assert.ok(!isOpen(), "the picker closed for the question");
  Assert.equal(promptText(), `remove "${PLAIN.name}" 3.0? (y/N)`, "the question");
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers");
  Assert.ok(await AddonManager.getAddonByID(PLAIN.id), "n keeps it");

  await pick("plain", PLAIN.id);
  EventUtils.synthesizeKey("d");
  await until(promptOpen, "d asks again");
  EventUtils.synthesizeKey("y");
  await until(async () => !(await AddonManager.getAddonByID(PLAIN.id)), "y removes it");
  await until(() => noticeText() === `removed "${PLAIN.name}"`, "says so");
});

add_task(async function a_stale_yes_removes_nothing() {
  await pick("options", OPTIONS.id);
  EventUtils.synthesizeKey("d");
  await until(promptOpen, "d asks");
  // While the question is open, the add-on is updated to another version.
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      name: OPTIONS.name,
      version: "2.1",
      browser_specific_settings: { gecko: { id: OPTIONS.id } },
    },
  });
  const upgrade = await AddonManager.getInstallForFile(xpi);
  await upgrade.install();
  Assert.equal((await AddonManager.getAddonByID(OPTIONS.id)).version, "2.1", "sanity: updated");
  EventUtils.synthesizeKey("y");
  await until(() => noticeText().includes("changed since you were asked"), "the guard refuses");
  Assert.ok(await AddonManager.getAddonByID(OPTIONS.id), "nothing was removed");
});
