/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-surfaces-trim.md, decision 8 (Since changed, #1617), and
// docs/specs/firefox-surfaces-theme.md, behaviour 4 (Since changed, #1617). The dialogs Settings
// opens (here Change Primary Password, and the web page languages with their list and drop-down)
// and a page's prompt over a tab look like Settings: square corners and the theme's font, with
// the buttons that are not the main one bordered --vimma-muted, as a prompt in a window of its
// own draws them, and a disabled main button the accent dimmed instead of Firefox's violet.

"use strict";

const PLAIN =
  getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") +
  "file_vimma_plain.html";

const style = (/** @type {Element} */ el) =>
  /** @type {Window} */ (el.ownerDocument.defaultView).getComputedStyle(el);
const token = (/** @type {string} */ name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * Settings' gSubDialog (engine/toolkit/modules/SubDialog.sys.mjs, SubDialogManager): the tests
 * open a dialog, wait for its top one to be ready and close it.
 * @typedef {object} SubDialogManager
 * @property {(url: string) => void} open
 * @property {SubDialog & { _dialogReady: Promise<void>, close(): void }} _topDialog
 */

/**
 * Opens `url` as a dialog of Settings and hands its document to `check`.
 * @param {string} url
 * @param {(doc: Document) => void | Promise<void>} check
 */
async function withSettingsDialog(url, check) {
  await BrowserTestUtils.withNewTab("about:preferences#privacy", async (browser) => {
    const win = /** @type {{ gSubDialog: SubDialogManager }} */ (
      /** @type {unknown} */ (browser.contentWindow)
    );
    info(`Opening ${url} over Settings`);
    win.gSubDialog.open(url);
    const dialog = win.gSubDialog._topDialog;
    await dialog._dialogReady;
    const doc = /** @type {Document} */ (dialog._frame.contentDocument);
    await TestUtils.waitForCondition(
      () => doc.documentElement.hasAttribute("subdialog"),
      "the dialog is marked as a subdialog",
    );
    try {
      await check(doc);
    } finally {
      dialog.close();
    }
  });
}

/**
 * The theme's font on the document's text and on `fields`, square corners on `square`.
 * @param {string} label
 * @param {Document} doc
 * @param {Element[]} fields
 * @param {Element[]} square
 */
function assertLook(label, doc, fields, square) {
  const name = (/** @type {Element} */ el) =>
    `${el.localName}#${el.id || el.getAttribute("dlgtype")}`;
  // A moz-input-* field draws its <input> in its shadow root.
  const inner = (/** @type {Element} */ el) => el.shadowRoot?.querySelector("input") ?? el;
  const font = token("--vimma-font");
  Assert.ok(font, `the theme's font token is set: ${font}`);
  Assert.equal(
    style(doc.documentElement).fontFamily,
    font,
    `${label}: its text is the theme's font`,
  );
  for (const el of fields) {
    Assert.equal(style(inner(el)).fontFamily, font, `${label}: ${name(el)} has the font`);
  }
  for (const el of square) {
    Assert.equal(style(inner(el)).borderTopLeftRadius, "0px", `${label}: ${name(el)} is square`);
  }
}

add_task(async function settings_primary_password_dialog_looks_like_vimma() {
  await withSettingsDialog("chrome://mozapps/content/preferences/changemp.xhtml", (doc) => {
    const label = "Change Primary Password";
    const fields = /** @type {Element[]} */ ([
      doc.getElementById("oldpw"),
      doc.getElementById("pw1"),
      doc.getElementById("pw2"),
    ]);
    Assert.ok(fields.every(Boolean), `${label}: has its three password fields`);
    const dialog = /** @type {MozDialogElement} */ (
      /** @type {unknown} */ (doc.querySelector("dialog"))
    );
    const accept = dialog.getButton("accept");
    const cancel = dialog.getButton("cancel");
    assertLook(label, doc, [...fields, accept], [...fields, accept, cancel]);

    Assert.equal(
      style(cancel).borderTopColor,
      rgb(token("--vimma-muted")),
      `${label}: the button that is not the main one is bordered --vimma-muted`,
    );
    // OK waits for a password: the accent, dimmed by the disabled opacity, not Firefox's violet.
    Assert.ok(accept.disabled, `${label}: OK is disabled while the fields are empty`);
    Assert.equal(
      style(accept).backgroundColor,
      rgb(token("--vimma-mode-normal")),
      `${label}: the disabled main button is the accent`,
    );
  });
});

add_task(async function settings_list_dialog_looks_like_vimma() {
  await withSettingsDialog("chrome://browser/content/preferences/dialogs/languages.xhtml", (d) => {
    const list = /** @type {Element} */ (d.getElementById("activeLanguages"));
    const menu = /** @type {Element} */ (d.getElementById("availableLanguages"));
    const add = /** @type {Element} */ (d.getElementById("addButton"));
    assertLook("Languages", d, [menu, add], [list, menu, add]);
  });
});

add_task(async function tab_prompt_looks_like_vimma() {
  await BrowserTestUtils.withNewTab(PLAIN, async (browser) => {
    const loaded = TestUtils.topicObserved("common-dialog-loaded");
    await SpecialPowers.spawn(browser, [], () => {
      content.setTimeout(() => content.prompt("a prompt over the tab", "text"), 0);
    });
    const [win] = /** @type {[Window]} */ (/** @type {unknown} */ (await loaded));
    const doc = win.document;
    const field = /** @type {Element} */ (doc.getElementById("loginTextbox"));
    const dialog = /** @type {MozDialogElement} */ (
      /** @type {unknown} */ (doc.querySelector("dialog"))
    );
    const accept = dialog.getButton("accept");
    assertLook(
      "A page's prompt",
      doc,
      [field, accept],
      [field, accept, dialog.getButton("cancel")],
    );
    dialog.acceptDialog();
  });
});
