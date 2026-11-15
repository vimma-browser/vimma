/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ctrl+n and ctrl+p in a page's suggestion list (docs/specs/page-suggestions.md). The content
 * actor describes the focused field as plain data; these decide whether a list is open and which
 * arrow key the parent presses.
 */

/**
 * An element a field's `aria-controls` or `aria-owns` names.
 * @typedef {object} PopupSnapshot
 * @property {string} role
 * @property {boolean} rendered  it has a layout box
 * @property {boolean} visible  checkVisibility()
 * @property {boolean} hasOption  it holds a `role="option"`
 */

/**
 * @typedef {object} FieldSnapshot
 * @property {string} role
 * @property {string} expanded  the `aria-expanded` attribute, or ""
 * @property {PopupSnapshot[]} popups  the elements its aria-controls and aria-owns name
 */

/**
 * @typedef {object} SuggestionSnapshot
 * @property {FieldSnapshot | null} focused  the focused element
 * @property {FieldSnapshot | null} combobox  its nearest `role="combobox"` ancestor
 * @property {boolean} autocompletePopup  the frame's AutoComplete actor has its popup open
 */

/** @typedef {"page.suggestion_next" | "page.suggestion_prev"} SuggestionAction */

/** The two action ids, page-first in insert mode (decision 3). */
export const SUGGESTION_ACTIONS = Object.freeze(
  new Set(/** @type {SuggestionAction[]} */ (["page.suggestion_next", "page.suggestion_prev"])),
);

/** @param {PopupSnapshot} p */
const shown = (p) => p.rendered && p.visible;

/**
 * An expanded combobox. Its popup's role is not checked: the combobox pattern defines ArrowDown
 * for every popup kind. A named popup must show, because sites often leave aria-expanded="true"
 * on a field whose list they hid.
 * @param {FieldSnapshot | null} f
 */
function expandedCombobox(f) {
  if (!f || f.role !== "combobox" || f.expanded !== "true") return false;
  return f.popups.length === 0 || f.popups.some(shown);
}

/**
 * Whether the focused field's suggestion list is open (decision 4).
 * @param {SuggestionSnapshot} s
 */
export function suggestionListOpen(s) {
  if (s.autocompletePopup) return true;
  if (expandedCombobox(s.focused) || expandedCombobox(s.combobox)) return true;
  // A field that says it is collapsed is, whatever its listbox shows.
  if (!s.focused || s.focused.expanded === "false") return false;
  return s.focused.popups.some((p) => p.role === "listbox" && p.hasOption && shown(p));
}

/**
 * What a suggestion key does: press an arrow key in the field, or fall back to the chord's
 * `[keys]` binding (decision 6).
 * @param {string} actionId
 * @param {boolean} listOpen
 * @returns {{ kind: "press", key: "ArrowDown" | "ArrowUp" } | { kind: "fallback" }}
 */
export function suggestionStep(actionId, listOpen) {
  if (!listOpen) return { kind: "fallback" };
  return { kind: "press", key: actionId === "page.suggestion_prev" ? "ArrowUp" : "ArrowDown" };
}
