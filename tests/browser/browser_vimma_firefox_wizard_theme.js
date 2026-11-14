/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-theme.md. Firefox's import wizard (#905), the dialog
// Settings shows for Import browser data, follows the theme as the rest of Settings does: its
// dialog, its text and buttons, and its browser list, a XUL panel in the wizard's shadow root
// that Firefox fills with the system's Menu colour and marks the chosen browser in Firefox's
// violet. Checked in the built-in palette dark and light and in an Omarchy theme that gives only
// its base colours, with the wizard left open across the changes; with high contrast Firefox's
// own colours stay. Apart from browser_vimma_firefox_surfaces_theme.js, which is near the
// harness's time limit for a file on a two-CPU runner.

/* global contextOf -- from head.js */

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const APPEARANCE_PREF = "vimma.theme.appearance";
const PLAIN =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_plain.html";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-wizard-theme-${Date.now()}`);
const XHTML = "http://www.w3.org/1999/xhtml";

/** A base-only Omarchy 4 colors.toml (event-horizon's keys): no surfaces, selection or muted. */
const BASE_ONLY = `accent = "#26bbd9"
cursor = "#fadad1"
foreground = "#fadad1"
background = "#1c1e26"
selection_foreground = "#1c1e26"
selection_background = "#26bbd9"
color0 = "#1c1e26"
color1 = "#e95678"
color2 = "#29d398"
color3 = "#fab795"
color4 = "#26bbd9"
color5 = "#ee64ac"
color6 = "#59e3e3"
color7 = "#fadad1"
color8 = "#6c6f93"
color9 = "#ec6a88"
color10 = "#3fdaa4"
color11 = "#fbc3a7"
color12 = "#3fc4de"
color13 = "#f075b5"
color14 = "#6be4e6"
color15 = "#fadad1"
`;

const style = (/** @type {Element} */ el) =>
  /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el);
const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** A token as a colour, in the form getComputedStyle reports. */
const tokenColour = (/** @type {string} */ name) => rgb(token(name));

/**
 * The background `value` gives an element placed under `parent` (in its tree, so that its
 * custom properties and currentColor are the ones `parent`'s children see).
 * @param {Element} parent
 * @param {string} value
 */
function backgroundUnder(parent, value) {
  const probe = parent.ownerDocument.createElementNS(XHTML, "div");
  probe.style.backgroundColor = value;
  parent.append(probe);
  const out = style(probe).backgroundColor;
  probe.remove();
  return out;
}

/**
 * A colour custom property as `el` sees it, resolved to the rgb() form getComputedStyle
 * reports, in `el`'s own colour scheme (light-dark() follows it); "" when it is not set.
 * @param {Element} el
 * @param {string} name
 */
function colourVar(el, name) {
  const value = style(el).getPropertyValue(name).trim();
  // Without a value the probe would inherit the page's text colour, --vimma-fg in the theme: a
  // property that is not set is "", which equals no colour.
  if (!value) return "";
  const doc = el.ownerDocument;
  const probe = doc.createElementNS(XHTML, "div");
  probe.style.color = value;
  probe.style.colorScheme = style(el).colorScheme;
  doc.documentElement.append(probe);
  const out = /** @type {Window} */ (doc.defaultView).getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/**
 * The colour painted at (x, y) of a document, from a snapshot of it.
 * @param {WindowGlobalParent} global
 * @param {number} x
 * @param {number} y
 */
async function pixel(global, x, y) {
  const bitmap = await global.drawSnapshot(new DOMRect(x, y, 1, 1), 1, "rgb(255, 0, 255)");
  const canvas = /** @type {HTMLCanvasElement} */ (document.createElementNS(XHTML, "canvas"));
  canvas.width = 1;
  canvas.height = 1;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.drawImage(bitmap, 0, 0);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * `actual` within 2 per channel of `expected` (both "rgb(r, g, b)"): a snapshot may round.
 * @param {string} actual @param {string} expected @param {string} msg
 */
function nearly(actual, expected, msg) {
  const parse = (/** @type {string} */ s) => (s.match(/\d+/g) ?? []).map(Number);
  const a = parse(actual);
  const e = parse(expected);
  // Three channels on both sides: a token that is not set gives "rgb(NaN, NaN, NaN)", no number.
  const ok = a.length >= 3 && e.length === 3 && e.every((v, i) => Math.abs(v - (a[i] ?? -99)) <= 2);
  Assert.ok(ok, `${msg} (${actual}, expected ${expected})`);
}

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/**
 * Opens the import wizard as `:firefox cmd_file_importFromAnotherBrowser` does, with only
 * Firefox's test migrator and two of its profiles: the wizard never reads the browsers installed
 * on this machine (browser_vimma_hints_wizard.js).
 */
async function openWizard() {
  const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
  const { InternalTestingProfileMigrator } = ChromeUtils.importESModule(
    "moz-src:///browser/components/migration/InternalTestingProfileMigrator.sys.mjs",
  );
  const { MigrationUtils } = ChromeUtils.importESModule(
    "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
  );
  const proto = InternalTestingProfileMigrator.prototype;
  const resources = proto.getResources;
  const sandbox = sinon.createSandbox();
  // Settings' sync section names this device in a pref when it loads.
  const DEVICE_PREF = "identity.fxaccounts.account.device.name";
  const deviceName = Services.prefs.prefHasUserValue(DEVICE_PREF)
    ? Services.prefs.getStringPref(DEVICE_PREF)
    : null;
  /** @type {MozTabbrowserTab | undefined} */
  let from;
  /** @type {MozTabbrowserTab | undefined} */
  let tab;
  let pushed = false;
  // Also on a failure while opening, so that no later task or file sees the stubs.
  const close = async () => {
    if (tab) BrowserTestUtils.removeTab(tab);
    if (from) BrowserTestUtils.removeTab(from);
    if (pushed) await SpecialPowers.popPrefEnv();
    sandbox.restore();
    if (deviceName === null) Services.prefs.clearUserPref(DEVICE_PREF);
    else Services.prefs.setStringPref(DEVICE_PREF, deviceName);
  };
  try {
    return { ...(await open()), close };
  } catch (e) {
    await close();
    throw e;
  }

  async function open() {
    sandbox
      .stub(MigrationUtils, "availableMigratorKeys")
      .get(() => [InternalTestingProfileMigrator.key]);
    sandbox
      .stub(proto, "getSourceProfiles")
      .resolves([
        InternalTestingProfileMigrator.testProfile,
        { id: "vimma-second", name: "Second" },
      ]);
    sandbox.stub(proto, "getResources").callsFake(
      /** @this {object} the migrator */
      function () {
        return resources.call(this, InternalTestingProfileMigrator.testProfile);
      },
    );
    await SpecialPowers.pushPrefEnv({ set: [["browser.migrate.internal-testing.enabled", true]] });
    pushed = true;
    from = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);
    const ready = BrowserTestUtils.waitForEvent(window, "MigrationWizard:Ready");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) =>
      url.startsWith("about:preferences"),
    );
    /** @type {XULElement} */ (
      /** @type {Element} */ (document.getElementById("cmd_file_importFromAnotherBrowser"))
    ).doCommand();
    tab = await opened;
    await ready;
    const doc = /** @type {Document} */ (tab.linkedBrowser.contentDocument);
    const dialog = /** @type {HTMLDialogElement} */ (doc.getElementById("migrationWizardDialog"));
    const wizard = /** @type {Element} */ (dialog.querySelector("migration-wizard"));
    const shadow = /** @type {ShadowRoot} */ (wizard.openOrClosedShadowRoot);
    const selector = /** @type {MigrationWizardSelector} */ (
      shadow.querySelector("#browser-profile-selector")
    );
    await until(
      () =>
        selector.selectedPanelItem?.profile?.id === InternalTestingProfileMigrator.testProfile.id,
      "the wizard picked the first browser",
    );
    return { tab, doc, dialog, wizard, shadow, selector };
  }
}

/**
 * The wizard's browser list, opened as a press of its button opens it (on mousedown,
 * migration-wizard.mjs handleEvent).
 * @param {MigrationWizardSelector} selector
 * @param {Element} list
 */
async function openList(selector, list) {
  const shown = BrowserTestUtils.waitForEvent(list, "shown");
  const win = /** @type {Window & typeof globalThis} */ (selector.ownerDocument.defaultView);
  // A mousedown event, not a synthesized press: the release a synthesized press sends would
  // close the list again under a window manager that does not hold popups open. Sent from here
  // it is trusted and counts as a pressed button (nsGlobalWindowInner::sMouseDown) until the
  // matching mouseup, which does not close the list.
  selector.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
  try {
    await shown;
  } finally {
    selector.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
  }
}

/**
 * The wizard in the current theme: the dialog, its text, its main button, the tint of its other
 * buttons, its checkboxes, and its browser list with the chosen browser.
 * @param {string} label
 * @param {Awaited<ReturnType<typeof openWizard>>} w
 */
async function assertWizard(label, w) {
  const { tab, dialog, shadow, selector } = w;
  // The page follows a theme change once its token sheet is swapped: wait for its canvas.
  const root = /** @type {Element} */ (dialog.ownerDocument.documentElement);
  await until(
    () => colourVar(root, "--background-color-canvas") === tokenColour("--vimma-bg"),
    `${label}: Settings has the theme`,
  );
  Assert.equal(
    style(dialog).backgroundColor,
    tokenColour("--vimma-bg-dark"),
    `${label}: the wizard's dialog is on --vimma-bg-dark`,
  );
  Assert.equal(style(dialog).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  Assert.equal(
    style(dialog).borderTopColor,
    tokenColour("--vimma-muted"),
    `${label}: its border is --vimma-muted`,
  );
  Assert.equal(style(dialog).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  const box = dialog.getBoundingClientRect();
  nearly(
    await pixel(
      /** @type {WindowGlobalParent} */ (contextOf(tab.linkedBrowser).currentWindowGlobal),
      box.left + 4,
      box.bottom - 4,
    ),
    tokenColour("--vimma-bg-dark"),
    `${label}: the dialog paints --vimma-bg-dark`,
  );

  const header = /** @type {Element} */ (
    shadow.querySelector('div[name="page-selection"] .migration-wizard-header')
  );
  Assert.equal(style(header).color, tokenColour("--vimma-fg"), `${label}: its heading`);
  const primary = /** @type {Element} */ (shadow.querySelector("#import"));
  Assert.equal(
    style(primary).backgroundColor,
    tokenColour("--vimma-mode-normal"),
    `${label}: its Import button is the accent`,
  );
  Assert.equal(
    style(primary).color,
    tokenColour("--vimma-mode-normal-fg"),
    `${label}: with readable text on it`,
  );
  // The other buttons, hovered or pressed, are the text colour tinted, not Firefox's violet
  // (tokens-brand.css under browser.nova.enabled).
  const page = /** @type {Element} */ (shadow.querySelector('div[name="page-selection"]'));
  for (const [state, share] of [
    ["hover", 17],
    ["active", 30],
  ]) {
    Assert.equal(
      backgroundUnder(page, `var(--button-background-color-${state})`),
      backgroundUnder(page, `color-mix(in srgb, currentColor ${share}%, transparent)`),
      `${label}: a ${state} button is the text colour tinted`,
    );
  }
  const checkbox = /** @type {Element} */ (shadow.querySelector(".select-all-checkbox"));
  Assert.equal(
    style(checkbox).accentColor,
    tokenColour("--vimma-mode-normal"),
    `${label}: its checkboxes are the accent`,
  );

  const list = /** @type {Element} */ (shadow.querySelector("panel-list"));
  const panel = /** @type {XULPopupElement} */ (/** @type {Element} */ (list.parentElement));
  await openList(selector, list);
  Assert.equal(panel.state, "open", `${label}: the browser list is open`);
  Assert.equal(
    colourVar(panel, "--panel-background-color"),
    tokenColour("--vimma-bg-dark"),
    `${label}: the browser list is on --vimma-bg-dark`,
  );
  Assert.equal(
    colourVar(panel, "--panel-text-color"),
    tokenColour("--vimma-fg"),
    `${label}: its text is --vimma-fg`,
  );
  Assert.equal(
    colourVar(panel, "--panel-border-color"),
    tokenColour("--vimma-muted"),
    `${label}: its border is --vimma-muted`,
  );
  Assert.equal(style(panel).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  const chosen = /** @type {Element} */ (list.querySelector("panel-item.selected"));
  Assert.equal(
    style(chosen).backgroundColor,
    tokenColour("--vimma-selection"),
    `${label}: the chosen browser is --vimma-selection`,
  );
  Assert.equal(
    style(chosen).color,
    tokenColour("--vimma-fg-bright"),
    `${label}: its text is --vimma-fg-bright`,
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await hidden;
}

add_task(async function import_wizard_follows_the_theme() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.pollMs", 100]] });
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
  });
  const w = await openWizard();
  try {
    for (const appearance of ["dark", "light"]) {
      Services.prefs.setStringPref(APPEARANCE_PREF, appearance);
      await until(
        () => token("--vimma-color-scheme") === appearance,
        `the palette is ${appearance}`,
      );
      await assertWizard(`vimma ${appearance}`, w);
    }
    Services.prefs.clearUserPref(APPEARANCE_PREF);

    await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), BASE_ONLY);
    await SpecialPowers.pushPrefEnv({
      set: [
        ["vimma.theme.source", "omarchy"],
        ["vimma.theme.omarchyPath", themeDir],
      ],
    });
    try {
      await until(() => token("--vimma-bg") === "#1c1e26", "the base-only Omarchy theme applies");
      await assertWizard("Omarchy, base colours only", w);
    } finally {
      await SpecialPowers.popPrefEnv();
    }

    // Settings keeps the wizard for its next opening, which asks for its state again: its shadow
    // root keeps the one sheet, and the list its colours.
    const sheets = w.shadow.adoptedStyleSheets.length;
    w.dialog.close();
    await until(() => !w.dialog.open, "the wizard closed");
    await /** @type {PreferencesWindow} */ (
      w.doc.defaultView
    ).gMainPane.showMigrationWizardDialog();
    await until(() => w.dialog.open, "the wizard opened again");
    Assert.equal(w.shadow.adoptedStyleSheets.length, sheets, "reopened: no second sheet");
    await assertWizard("vimma, reopened", w);
  } finally {
    await w.close();
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function high_contrast_keeps_the_wizards_colours() {
  // ui.useAccessibilityTheme is the system's high-contrast setting (nsMediaFeatures.cpp).
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  const w = await openWizard();
  try {
    await until(
      () => /** @type {Window} */ (w.doc.defaultView).matchMedia("(prefers-contrast)").matches,
      "high contrast is on in the page",
    );
    const body = /** @type {Element} */ (w.doc.body);
    // An unset property makes the probe transparent, which a transparent surface would match.
    const isSet = (/** @type {Element} */ el, /** @type {string} */ name) =>
      Assert.ok(style(el).getPropertyValue(name).trim(), `${name} is set on <${el.localName}>`);
    isSet(body, "--dialog-background-color");
    Assert.equal(
      style(w.dialog).backgroundColor,
      backgroundUnder(body, "var(--dialog-background-color)"),
      "the dialog keeps Settings' dialog colour",
    );
    Assert.equal(
      style(w.dialog).color,
      backgroundUnder(w.dialog, "CanvasText"),
      "and the UA's CanvasText",
    );
    const list = /** @type {Element} */ (w.shadow.querySelector("panel-list"));
    const panel = /** @type {XULPopupElement} */ (/** @type {Element} */ (list.parentElement));
    await openList(w.selector, list);
    isSet(list, "--button-background-color-active");
    isSet(list, "--button-background-color-hover");
    // popup.css: the system's Menu, or none on macOS, where the panel draws natively.
    Assert.equal(
      style(panel).getPropertyValue("--panel-background-color").trim(),
      AppConstants.platform === "macosx" ? "none" : "Menu",
      "the browser list keeps Firefox's own surface (popup.css)",
    );
    Assert.equal(
      style(/** @type {Element} */ (list.querySelector("panel-item.selected"))).backgroundColor,
      backgroundUnder(list, "var(--button-background-color-active)"),
      "the chosen browser keeps Firefox's pressed-button colour (migration-wizard.css)",
    );
    Assert.notEqual(
      backgroundUnder(list, "var(--button-background-color-hover)"),
      backgroundUnder(list, "color-mix(in srgb, currentColor 17%, transparent)"),
      "a hovered button keeps Firefox's high-contrast colour",
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await hidden;
  } finally {
    await w.close();
  }
  await SpecialPowers.popPrefEnv();
});
