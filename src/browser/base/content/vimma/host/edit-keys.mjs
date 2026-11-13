/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vim's text-field keys in chrome (spec: docs/specs/key-handling-batch.md § 2): ctrl+w, ctrl+u,
// ctrl+h in the URL bar, the `:` line, the help and bookmark filters, the find bar and prompts
// run the editor's own command, so undo works; ctrl+j and ctrl+m press Enter. Pages get theirs
// from the content actor (VimmaChild, Vimma:Edit) after the page has had the key.

import { INSERT_ENTER, isEditable } from "../core/editable.mjs";
import { pressKeyLater } from "../actors/enter-key.mjs";

/** @import { EditableDescriptor } from "../core/editable.mjs" */

/**
 * The focused element of a chrome document, through shadow roots (the find bar's input).
 * @param {Document} doc
 * @returns {Element | null}
 */
function deepActiveElement(doc) {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * The editable chrome element with focus, or null (a page, a button, the panel box).
 * @param {BrowserWindow} win
 * @returns {Element | null}
 */
export function focusedChromeField(win) {
  const el = deepActiveElement(win.document);
  if (!el || el.localName === "browser") return null;
  const html = /** @type {HTMLInputElement} */ (el);
  /** @type {EditableDescriptor} */
  const d = { tagName: el.localName, disabled: el.matches(":disabled") };
  if (el.localName === "input") d.type = html.type;
  if (el.localName === "input" || el.localName === "textarea") d.readOnly = html.readOnly;
  if (typeof html.isContentEditable === "boolean") d.isContentEditable = html.isContentEditable;
  // Only real text: an ARIA textbox or a <select> has no editor to run a command in.
  if (el.localName === "select") return null;
  return isEditable(d).editable ? el : null;
}

/**
 * Runs an editor command on the focused chrome field, as its own key binding would; for
 * INSERT_ENTER, presses Enter there.
 * @param {BrowserWindow} win
 * @param {string} command  cmd_deleteWordBackward and the like, or INSERT_ENTER
 * @returns {boolean} whether a controller took it, or the Enter was queued
 */
export function runChromeEdit(win, command) {
  if (command === INSERT_ENTER) {
    const field = focusedChromeField(win);
    pressKeyLater(win, "Enter", () => focusedChromeField(win) === field);
    return true;
  }
  const dispatcher = win.document.commandDispatcher;
  const controller = dispatcher?.getControllerForCommand(command);
  if (!controller?.isCommandEnabled(command)) return false;
  controller.doCommand(command);
  return true;
}
