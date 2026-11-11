/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's permission prompts (doorhangers) from the keyboard (docs/specs/toolbar-toggle.md
// decision 11a). The agent question line is the model (agent-prompt.mjs): `y` and `n`, counted
// only once the prompt is armed, and never from a field. Esc stays Firefox's: the prompt runs
// its own Esc action (PopupNotifications, `escAction`, the secondary one unless it says
// otherwise). The notice after an add-on install takes them too, with `p` for its checkbox
// ("Pin extension to toolbar", issue #868).

/**
 * @typedef {object} DoorhangerState
 * @property {boolean} open  a prompt is open in this window
 * @property {boolean} armed  it has shown for the arming delay with no key in between
 * @property {boolean} inField  focus is in an editable field (insert mode)
 * @property {boolean} inPrompt  focus is inside the prompt itself
 * @property {boolean} [promptField]  focus is in a text field of the prompt's own (the password
 * prompt's username and password)
 * @property {boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {boolean} [repeat]  the key is held down
 * @property {boolean} [toggle]  the prompt shows a checkbox that `p` toggles (the post-install
 * notice's "Pin extension to toolbar")
 */

/**
 * @typedef {{ kind: "pass" } | { kind: "wait" } | { kind: "allow" } | { kind: "block" }
 *   | { kind: "focus" } | { kind: "toggle" }} DoorhangerKey
 * `pass`: not the prompt's key; `wait`: swallowed, and the arming delay starts again (a key
 * typed on through the prompt never answers it); `allow` / `block`: the prompt's main or
 * secondary button; `focus`: focus moves into the prompt, onto its first button (or its
 * checkbox); `toggle`: the prompt's checkbox.
 */

/**
 * What `key` (formatKey's notation) does while a prompt may be open.
 * @param {string} key
 * @param {DoorhangerState} s
 * @returns {DoorhangerKey}
 */
export function doorhangerKey(key, s) {
  if (!s.open || s.pending) return { kind: "pass" };
  // Typing in a field is never an answer, in the page, in the chrome or in the prompt's own
  // fields. Elsewhere in the prompt, focus is on its buttons or its checkbox, where a letter
  // types nothing.
  if ((s.inField && !s.inPrompt) || s.promptField) return { kind: "pass" };
  if (key === "tab") return s.inPrompt ? { kind: "pass" } : { kind: "focus" };
  if (key !== "y" && key !== "n" && !(key === "p" && s.toggle)) return { kind: "pass" };
  if (!s.armed || s.repeat) return { kind: "wait" };
  if (key === "p") return { kind: "toggle" };
  return { kind: key === "y" ? "allow" : "block" };
}

/** A button's label in the hint: one line, short. */
const HINT_LABEL_MAX = 24;

/** @param {string} label */
function hintLabel(label) {
  const text = label.trim().replace(/\s+/g, " ").toLowerCase();
  return text.length > HINT_LABEL_MAX ? `${text.slice(0, HINT_LABEL_MAX - 1)}…` : text;
}

/**
 * The keys line shown inside an armed prompt, named after its own buttons. With focus in a field
 * outside the prompt (a login form that keeps the page leaves it in the password field), the keys
 * are the field's text, so the line starts with the way out: Esc leaves the field and keeps the
 * prompt open. The same holds in hint, copy and element mode, which keep the keys too. A prompt
 * with a checkbox `p` toggles names it after the checkbox's label.
 * @param {{ main: string, secondary: string, toggle?: string, inField?: boolean }} labels
 */
export function doorhangerHint({ main, secondary, toggle = "", inField = false }) {
  const parts = [`y ${hintLabel(main)}`];
  if (secondary.trim()) parts.push(`n ${hintLabel(secondary)}`);
  if (toggle.trim()) parts.push(`p ${hintLabel(toggle)}`);
  // From a field, Tab is the field's; leaving `Tab buttons` out keeps the line on one row.
  if (inField) return `Esc, then ${parts.join(" · ")}`;
  parts.push("Tab buttons");
  return parts.join(" · ");
}

/**
 * @typedef {object} PopupBarState
 * @property {boolean} open  the selected page shows Firefox's pop-up blocked bar
 * @property {boolean} armed  it has shown for the arming delay with no key in between
 * @property {boolean} inField  focus is in an editable field (insert mode)
 * @property {boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {boolean} [repeat]  the key is held down
 * @property {boolean} [agent]  the page is in the agent workspace, whose pages get no permissions
 * @property {boolean} [locked]  `dom.disable_open_during_load` is locked: the site's permission
 *   is not the user's to change, as Firefox's options menu has it, so only Esc answers
 */

/**
 * What `key` does while the pop-up blocked bar may show (docs/specs/popup-blocked.md): the
 * permission prompt's keys and guards, with Esc to close the bar, since the bar has no Esc of its
 * own. Tab never moves focus onto the bar, whose own controls stay the mouse's. An Esc before the
 * bar is armed stays the page's: a page can raise the bar just as Esc is pressed.
 * @param {string} key
 * @param {PopupBarState} s
 * @returns {{ kind: "pass" | "wait" | "allow" | "block" | "close" }}
 */
export function popupBarKey(key, s) {
  if (!s.open || s.pending || s.inField || s.agent) return { kind: "pass" };
  if (key === "esc") return s.armed && !s.repeat ? { kind: "close" } : { kind: "pass" };
  if ((key !== "y" && key !== "n") || s.locked) return { kind: "pass" };
  if (!s.armed || s.repeat) return { kind: "wait" };
  return { kind: key === "y" ? "allow" : "block" };
}

/**
 * The pop-up blocked bar's keys line, the permission prompt's (doorhangerHint) with Esc to close.
 * From a field, or in hint, copy and element mode, it starts with the way out. With the pop-up
 * pref locked only Esc answers (popupBarKey).
 * @param {{ inField?: boolean, locked?: boolean }} s
 */
export function popupBarHint({ inField = false, locked = false }) {
  if (locked) return inField ? "Esc, then Esc close" : "Esc close";
  return inField ? "Esc, then y allow · n block" : "y allow · n block · Esc close";
}

/**
 * @typedef {object} DialogState
 * @property {boolean} armed  it has shown for the arming delay with no key in between
 * @property {boolean} inField  focus is in one of the dialog's text fields
 * @property {boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {boolean} accept  the dialog shows its main button
 * @property {boolean} cancel  the dialog shows its cancel button, the one Esc runs
 * @property {boolean} [repeat]  the key is held down
 */

/**
 * What `key` does in one of Firefox's dialogs over a tab or the window (docs/specs/
 * firefox-dialogs.md): the permission prompt's keys and guards. `y` runs the main button and `n`
 * the cancel button, the one Esc already runs and the safe choice ("Stay on page", "Cancel").
 * Esc, Enter and Tab stay Firefox's. A dialog's text field types the letters.
 * @param {string} key
 * @param {DialogState} s
 * @returns {{ kind: "pass" | "wait" | "accept" | "cancel" }}
 */
export function dialogKey(key, s) {
  if (s.pending || s.inField) return { kind: "pass" };
  if (!(key === "y" && s.accept) && !(key === "n" && s.cancel)) return { kind: "pass" };
  if (!s.armed || s.repeat) return { kind: "wait" };
  return { kind: key === "y" ? "accept" : "cancel" };
}

/**
 * The keys line inside a dialog, named after its own buttons. With a text field (a page's
 * prompt(), a sign-in) the letters type, and the line names Enter and Esc, which Firefox gives
 * the dialog.
 * @param {{ accept: string, cancel: string, field?: boolean }} labels
 */
export function dialogHint({ accept, cancel, field = false }) {
  const [yes, no] = field ? ["Enter", "Esc"] : ["y", "n"];
  const parts = [`${yes} ${hintLabel(accept)}`];
  if (cancel.trim()) parts.push(`${no} ${hintLabel(cancel)}`);
  return parts.join(" · ");
}
