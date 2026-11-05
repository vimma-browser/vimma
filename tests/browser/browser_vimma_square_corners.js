/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vimma's chrome draws square corners, as the command line, the status bar and the side panel
// always have, and as Omarchy's tiling windows do: Vimma's own surfaces (the pickers, live grep,
// the help overlay, notices, the find prompt, hint labels) and the Firefox chrome around them
// (the URL bar and its suggestions, menus, the app menu and the other arrow panels). Web pages
// and Firefox's in-content pages keep their own corners.

"use strict";

/* global PanelUI -- browser window global (browser.js) */

const { openPrompt } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/find-bar.mjs",
);

const XHTML = "http://www.w3.org/1999/xhtml";
const SHEETS = ["picker", "grep", "help-overlay", "notice", "hints"].map(
  (name) => `chrome://browser/skin/vimma/${name}.css`,
);
const CORNERS = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
];

/**
 * @param {Element} el
 * @param {string} label
 */
function assertSquare(el, label) {
  const cs = /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el);
  for (const corner of CORNERS) {
    Assert.equal(cs[/** @type {any} */ (corner)], "0px", `${label}: ${corner} is square`);
  }
}

/** A XUL popup's drawn box: the part its shadow root paints the border and background on. */
function popupContent(/** @type {Element} */ popup) {
  const root = /** @type {any} */ (popup).openOrClosedShadowRoot;
  return root.querySelector('[part~="content"]');
}

add_task(async function vimma_surfaces_are_square() {
  // A window of its own: the sheets are loaded into it here, and go with it.
  const win = await BrowserTestUtils.openNewBrowserWindow();
  registerCleanupFunction(() => BrowserTestUtils.closeWindow(win));
  const doc = win.document;
  for (const sheet of SHEETS) {
    win.windowUtils.loadSheetUsingURIString(sheet, win.windowUtils.AUTHOR_SHEET);
  }
  const el = (/** @type {string} */ tag, /** @type {Record<string, string>} */ attrs = {}) => {
    const node = doc.createElementNS(XHTML, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const picker = el("dialog", { class: "vimma-picker" });
  const grep = el("dialog", { class: "vimma-grep" });
  const grepBox = el("div", { class: "vimma-grep-box" });
  grep.append(grepBox);
  const help = el("dialog", { id: "vimma-help" });
  const helpInput = el("input");
  help.append(helpInput);
  const notice = el("div", { id: "vimma-notice" });
  const hints = el("div", { id: "vimma-hints" });
  const hint = el("span", { class: "vimma-hint" });
  const ring = el("div", { class: "vimma-element-ring" });
  hints.append(hint, ring);
  doc.documentElement.append(picker, grep, help, notice, hints);

  assertSquare(picker, "picker");
  assertSquare(grep, "live grep");
  assertSquare(grepBox, "live grep box");
  assertSquare(help, "help overlay");
  assertSquare(helpInput, "help filter");
  assertSquare(notice, "notice");
  assertSquare(hint, "hint label");
  for (const node of [picker, grep, help, notice, hints]) node.remove();

  const findbar = await win.gBrowser.getFindBar();
  openPrompt(findbar);
  await TestUtils.waitForCondition(() => !findbar.hidden, "the find prompt opens");
  assertSquare(findbar, "find prompt");
});

add_task(async function firefox_chrome_is_square() {
  // The URL bar, closed and open with its suggestions.
  assertSquare(gURLBar.querySelector(".urlbar-background"), "URL bar");
  assertSquare(document.getElementById("urlbar"), "URL bar frame");
  // The workspace's container chip at the field's end: a label on a tint, not a round icon.
  const chip = /** @type {Element} */ (document.getElementById("userContext-icons"));
  Assert.greater(chip.getBoundingClientRect().width, 0, "the workspace chip shows");
  assertSquare(chip, "workspace chip");
  gURLBar.focus();
  gURLBar.search("corners");
  await TestUtils.waitForCondition(() => gURLBar.view.isOpen, "the suggestions open");
  assertSquare(gURLBar.querySelector(".urlbar-background"), "URL bar with its suggestions");
  gURLBar.view.close();
  gURLBar.blur();

  // Menus: a context menu and an item in it, and the app menu (an arrow panel) and a button in
  // it. Without a compositor (Xvfb) Firefox already draws every popup square (popup.css), so
  // the items are what tells the two looks apart there.
  const menu = /** @type {any} */ (document.getElementById("tabContextMenu"));
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopupAtScreen(100, 100, true);
  await shown;
  assertSquare(popupContent(menu), "context menu");
  assertSquare(menu.querySelector("menuitem:not([hidden])"), "context menu item");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  const appMenu = /** @type {any} */ (document.getElementById("appMenu-popup"));
  const panelShown = BrowserTestUtils.waitForPopupEvent(appMenu, "shown");
  PanelUI.show();
  await panelShown;
  assertSquare(popupContent(appMenu), "app menu");
  const button = [...appMenu.querySelectorAll("#appMenu-mainView .subviewbutton")].find(
    (b) => b.getBoundingClientRect().height > 0,
  );
  assertSquare(button, "app menu button");
  const panelHidden = BrowserTestUtils.waitForPopupEvent(appMenu, "hidden");
  PanelUI.hide();
  await panelHidden;
});
