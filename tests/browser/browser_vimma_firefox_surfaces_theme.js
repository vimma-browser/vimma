/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-theme.md. The Firefox surfaces Vimma shows besides the
// toolbar take Vimma's theme tokens: the find bar, the menu bar and every menu, tab-modal and
// window-modal dialogs, and the in-content pages (Settings, Add-ons, Downloads, Troubleshooting,
// about:config). Checked in the built-in palette dark and light, and in an Omarchy theme that
// gives only its base colours; with forced colours Firefox's own colours stay.

/* global windowGlobalOf -- from head.js */

"use strict";

/* global setToolbarVisibility -- browser window global (browser.js) */

const { openPrompt } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/find-bar.mjs",
);

const APPEARANCE_PREF = "vimma.theme.appearance";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = DIR + "file_vimma_plain.html";
const themeDir = PathUtils.join(PathUtils.tempDir, `vimma-surfaces-theme-${Date.now()}`);
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

/** The in-content pages checked: Firefox's own pages, which run in the parent process. */
const PAGES = [
  "about:preferences",
  "about:addons",
  "about:downloads",
  "about:support",
  "about:config",
];

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
 * A colour custom property as `el` sees it, resolved to the rgb() form getComputedStyle
 * reports, in `el`'s own document (light-dark() follows its colour scheme).
 * @param {Element} el
 * @param {string} name
 */
function colourVar(el, name) {
  const value = style(el).getPropertyValue(name).trim();
  // Without a value the probe would inherit its colour, as the element's text may.
  Assert.ok(value, `${name} is set on <${el.localName}>`);
  const doc = el.ownerDocument;
  const probe = doc.createElementNS(XHTML, "div");
  probe.style.color = value;
  probe.style.colorScheme = style(el).colorScheme;
  doc.documentElement.append(probe);
  const out = /** @type {Window} */ (doc.defaultView).getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** The colour that shows behind `el`: its own background or the first opaque ancestor's. */
function backdrop(/** @type {Element} */ el) {
  /** @type {Element | null} */
  let node = el;
  while (node) {
    const bg = style(node).backgroundColor;
    if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    // A shadow root has its host; a document, the root of anything else here, has none.
    node = node.parentElement ?? /** @type {ShadowRoot} */ (node.getRootNode()).host ?? null;
  }
  return "none";
}

/**
 * The colour painted at (x, y) of a document, from a snapshot of it: what shows, whatever set
 * it.
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
 * A tab's find bar, made on first use. It changes nothing at run time: getFindBar resolves with
 * null only for a tab that closed meanwhile, and the reads that follow throw on that.
 * @param {MozTabbrowserTab} tab
 */
async function findBarOf(tab) {
  return /** @type {MozFindbar} */ (await gBrowser.getFindBar(tab));
}

/**
 * The window's own document as the parent process draws it; the test fails here without one, as
 * a read through a missing global did.
 * @param {{ readonly browsingContext: CanonicalBrowsingContext | null }} owner  a window or a
 *   <browser>
 */
function globalOf(owner) {
  return windowGlobalOf(owner.browsingContext);
}

/**
 * The find bar: its surface, its field and its text, painted.
 * @param {string} label
 * @param {MozTabbrowserTab} tab
 */
async function assertFindBar(label, tab) {
  const findbar = await findBarOf(tab);
  findbar.setAttribute("noanim", "true");
  findbar.open();
  await until(() => !findbar.hidden && findbar.getBoundingClientRect().height > 20, "find bar");
  const surface = tokenColour("--vimma-bg-dark");
  Assert.equal(backdrop(findbar), surface, `${label}: the find bar is on --vimma-bg-dark`);
  Assert.equal(style(findbar).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  Assert.equal(style(findbar).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  const field = findbar._findField;
  Assert.equal(
    style(field).backgroundColor,
    tokenColour("--vimma-bg"),
    `${label}: the find field is --vimma-bg`,
  );
  Assert.equal(style(field).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  const box = findbar.getBoundingClientRect();
  nearly(
    await pixel(globalOf(window), box.right - 120, box.top + 4),
    surface,
    `${label}: the find bar paints --vimma-bg-dark`,
  );
  findbar.close(true);

  // The same bar as `/` opens it: a floating prompt framed like a picker (picker.css).
  openPrompt(findbar);
  await until(() => !findbar.hidden && findbar.getBoundingClientRect().height > 20, "prompt");
  for (const side of ["top", "right", "bottom", "left"]) {
    Assert.equal(
      style(findbar).getPropertyValue(`border-${side}-color`),
      tokenColour("--vimma-muted"),
      `${label}: the prompt's ${side} border is --vimma-muted`,
    );
    Assert.equal(
      style(findbar).getPropertyValue(`border-${side}-width`),
      "1px",
      `${label}: 1px on the ${side}`,
    );
  }
  Assert.equal(backdrop(findbar), surface, `${label}: the prompt is on --vimma-bg-dark`);
  const prompt = findbar.getBoundingClientRect();
  nearly(
    await pixel(globalOf(window), prompt.right - 120, prompt.top + 4),
    surface,
    `${label}: the prompt paints --vimma-bg-dark`,
  );
  findbar.close(true);
  findbar.removeAttribute("noanim");
}

/**
 * A menu (the same menupopup as the context menus and the menu bar's menus), a selected item in
 * it, and the menu bar.
 * @param {string} label
 */
async function assertMenus(label) {
  const menu = /** @type {XULPopupElement} */ (document.createXULElement("menupopup"));
  for (const text of ["One", "Two"]) {
    const item = document.createXULElement("menuitem");
    item.setAttribute("label", text);
    menu.append(item);
  }
  /** @type {Element} */ (document.getElementById("mainPopupSet")).append(menu);
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopupAtScreen(window.screenX + 100, window.screenY + 100, false);
  await shown;
  Assert.equal(
    colourVar(menu, "--panel-background-color"),
    tokenColour("--vimma-bg-dark"),
    `${label}: the context menu is on --vimma-bg-dark`,
  );
  Assert.equal(
    colourVar(menu, "--panel-text-color"),
    tokenColour("--vimma-fg"),
    `${label}: its text is --vimma-fg`,
  );
  Assert.equal(
    colourVar(menu, "--panel-border-color"),
    tokenColour("--vimma-muted"),
    `${label}: its border is --vimma-muted`,
  );
  Assert.equal(style(menu).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  const item = /** @type {Element} */ (menu.firstElementChild);
  item.setAttribute("_moz-menuactive", "true");
  Assert.equal(
    style(item).backgroundColor,
    tokenColour("--vimma-selection"),
    `${label}: the active item is --vimma-selection`,
  );
  Assert.equal(
    style(item).color,
    tokenColour("--vimma-fg-bright"),
    `${label}: its text is --vimma-fg-bright`,
  );
  item.removeAttribute("_moz-menuactive");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
  menu.remove();

  const menubar = /** @type {Element} */ (document.getElementById("toolbar-menubar"));
  setToolbarVisibility(menubar, true, false, false);
  await until(() => menubar.checkVisibility(), `${label}: the menu bar shows`);
  Assert.equal(
    backdrop(menubar),
    tokenColour("--vimma-bg-dark"),
    `${label}: the menu bar is on --vimma-bg-dark`,
  );
  Assert.equal(style(menubar).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  setToolbarVisibility(menubar, false, false, false);
}

/**
 * A prompt's XUL <dialog> (commonDialog.xhtml). It changes nothing at run time: a read through
 * a missing one throws.
 * @param {Window} win  the dialog's window
 */
function dialogOf(win) {
  const dialog = /** @type {Element | null} */ (win.document.querySelector("dialog"));
  return /** @type {MozDialogElement} */ (dialog);
}

/**
 * A prompt's dialog document: the surface, the text and the main button.
 * @param {string} label
 * @param {Window} win  the dialog's window
 */
function assertDialog(label, win) {
  const root = /** @type {Element} */ (win.document.documentElement);
  const dialog = dialogOf(win);
  Assert.equal(backdrop(dialog), tokenColour("--vimma-bg-dark"), `${label}: on --vimma-bg-dark`);
  Assert.equal(style(dialog).color, tokenColour("--vimma-fg"), `${label}: its text is --vimma-fg`);
  Assert.equal(style(root).colorScheme, token("--vimma-color-scheme"), `${label}: its scheme`);
  const accept = dialog.getButton("accept");
  Assert.equal(
    style(accept).backgroundColor,
    tokenColour("--vimma-mode-normal"),
    `${label}: its main button is the accent`,
  );
  Assert.equal(
    style(accept).color,
    tokenColour("--vimma-mode-normal-fg"),
    `${label}: with readable text on it`,
  );
}

/**
 * A page's alert() (tab-modal) and a window-modal alert.
 * @param {string} label
 * @param {MozTabbrowserTab} tab
 */
async function assertDialogs(label, tab) {
  // common-dialog-loaded: a prompt's window, once its dialog is built (PromptTestUtils).
  let loaded = TestUtils.topicObserved("common-dialog-loaded");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.setTimeout(() => content.alert("tab-modal"), 0);
  });
  let [win] = /** @type {[Window]} */ (/** @type {unknown} */ (await loaded));
  Assert.ok(win.docShell.chromeEventHandler, `${label}: the alert is in the tab`);
  assertDialog(`${label}: the tab-modal alert`, win);
  dialogOf(win).acceptDialog();

  loaded = TestUtils.topicObserved("common-dialog-loaded");
  // alertBC spins until the prompt closes: off this task, so the task can check and close it.
  setTimeout(() => {
    Services.prompt.alertBC(
      window.browsingContext,
      Ci.nsIPrompt.MODAL_TYPE_WINDOW,
      "window-modal",
      "a window-modal alert",
    );
  }, 0);
  [win] = /** @type {[Window]} */ (/** @type {unknown} */ (await loaded));
  Assert.ok(!win.docShell.chromeEventHandler, `${label}: the alert is a window of its own`);
  assertDialog(`${label}: the window-modal alert`, win);
  const closed = BrowserTestUtils.domWindowClosed(win);
  dialogOf(win).acceptDialog();
  await closed;
}

/**
 * The in-content pages: their surface painted, their cards, text, links and accent.
 * @param {string} label
 */
async function assertPages(label) {
  for (const url of PAGES) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
    const browser = tab.linkedBrowser;
    const doc = /** @type {Document} */ (browser.contentDocument);
    const root = /** @type {Element} */ (doc.documentElement);
    const what = `${label}: ${url}`;
    Assert.equal(style(root).colorScheme, token("--vimma-color-scheme"), `${what}: its scheme`);
    Assert.equal(
      colourVar(root, "--background-color-canvas"),
      tokenColour("--vimma-bg"),
      `${what}: its canvas is --vimma-bg`,
    );
    Assert.equal(
      colourVar(root, "--background-color-box"),
      tokenColour("--vimma-bg-dark"),
      `${what}: its boxes are --vimma-bg-dark`,
    );
    Assert.equal(
      colourVar(root, "--text-color"),
      tokenColour("--vimma-fg"),
      `${what}: its text is --vimma-fg`,
    );
    Assert.equal(
      colourVar(root, "--link-color"),
      tokenColour("--vimma-text-accent"),
      `${what}: its links are --vimma-text-accent`,
    );
    Assert.equal(
      colourVar(root, "--color-accent-primary"),
      tokenColour("--vimma-mode-normal"),
      `${what}: its accent is the theme's`,
    );
    Assert.equal(
      style(/** @type {Element} */ (doc.body ?? root)).color,
      tokenColour("--vimma-fg"),
      `${what}: its body text is --vimma-fg`,
    );
    const { width, height } = browser.getBoundingClientRect();
    nearly(
      await pixel(globalOf(browser), width - 4, height - 4),
      tokenColour("--vimma-bg"),
      `${what}: paints --vimma-bg`,
    );
    if (url === "about:preferences") {
      // The default-browser card's illustration is Firefox's mascot (decision 6).
      for (const promo of doc.querySelectorAll("moz-promo")) {
        const img = promo.shadowRoot?.querySelector(".image-container");
        if (!/\/illustrations\/kit-/.test(promo.getAttribute("imagesrc") ?? "")) continue;
        Assert.equal(img?.getBoundingClientRect().width, 0, `${what}: no Firefox illustration`);
      }
    }
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * @param {string} label
 * @param {MozTabbrowserTab} tab
 */
async function assertSurfacesFollowTheTheme(label, tab) {
  await assertFindBar(label, tab);
  await assertMenus(label);
  await assertDialogs(label, tab);
  await assertPages(label);
}

add_task(async function firefox_surfaces_follow_the_theme() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.theme.pollMs", 100]] });
  await IOUtils.makeDirectory(themeDir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(APPEARANCE_PREF);
    await IOUtils.remove(themeDir, { recursive: true, ignoreAbsent: true });
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN);

  for (const appearance of ["dark", "light"]) {
    Services.prefs.setStringPref(APPEARANCE_PREF, appearance);
    await until(() => token("--vimma-color-scheme") === appearance, `the palette is ${appearance}`);
    await assertSurfacesFollowTheTheme(`vimma ${appearance}`, tab);
  }
  Services.prefs.clearUserPref(APPEARANCE_PREF);

  await IOUtils.writeUTF8(PathUtils.join(themeDir, "colors.toml"), BASE_ONLY);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.theme.source", "omarchy"],
      ["vimma.theme.omarchyPath", themeDir],
    ],
  });
  await until(() => token("--vimma-bg") === "#1c1e26", "the base-only Omarchy theme applies");
  await assertSurfacesFollowTheTheme("Omarchy, base colours only", tab);
  await SpecialPowers.popPrefEnv();

  gBrowser.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function high_contrast_keeps_firefox_colours() {
  // ui.useAccessibilityTheme is the system's high-contrast setting: the window and Firefox's own
  // pages then match prefers-contrast (nsMediaFeatures.cpp, Gecko_MediaFeatures_PrefersContrast).
  await SpecialPowers.pushPrefEnv({ set: [["ui.useAccessibilityTheme", 1]] });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences");
  const doc = /** @type {Document} */ (tab.linkedBrowser.contentDocument);
  await until(
    () =>
      matchMedia("(prefers-contrast)").matches &&
      /** @type {Window} */ (doc.defaultView).matchMedia("(prefers-contrast)").matches,
    "high contrast is on in the window and the page",
  );
  // The two tokens the checks below compare with: a token that is not set equals no colour.
  for (const name of ["--vimma-bg", "--vimma-bg-dark"]) {
    Assert.ok(/^#[0-9a-f]{6}$/i.test(token(name)), `${name} is a colour`);
  }
  Assert.notEqual(
    colourVar(/** @type {Element} */ (doc.documentElement), "--background-color-canvas"),
    tokenColour("--vimma-bg"),
    "a page keeps Firefox's high-contrast canvas",
  );
  const findbar = await findBarOf(tab);
  findbar.setAttribute("noanim", "true");
  findbar.open();
  await until(() => !findbar.hidden, "find bar");
  Assert.notEqual(
    backdrop(findbar),
    tokenColour("--vimma-bg-dark"),
    "the find bar keeps Firefox's high-contrast colours",
  );
  findbar.close(true);
  findbar.removeAttribute("noanim");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
