/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's permission prompts (doorhangers) from the keyboard (docs/specs/toolbar-toggle.md
// decision 11a). The agent question line is the model (agent-prompt.mjs): `y` and `n`, counted
// only once the prompt is armed, and never from a field. Esc stays Firefox's: the prompt runs
// its own Esc action (PopupNotifications, `escAction`, the secondary one unless it says
// otherwise).

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
 */

/**
 * @typedef {{ kind: "pass" } | { kind: "wait" } | { kind: "allow" } | { kind: "block" }
 *   | { kind: "focus" }} DoorhangerKey
 * `pass`: not the prompt's key; `wait`: swallowed, and the arming delay starts again (a key
 * typed on through the prompt never answers it); `allow` / `block`: the prompt's main or
 * secondary button; `focus`: focus moves into the prompt, onto its first button.
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
  if (key !== "y" && key !== "n") return { kind: "pass" };
  if (!s.armed || s.repeat) return { kind: "wait" };
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
 * prompt open. The same holds in hint, copy and element mode, which keep the keys too.
 * @param {{ main: string, secondary: string, inField?: boolean }} labels
 */
export function doorhangerHint({ main, secondary, inField = false }) {
  const parts = [`y ${hintLabel(main)}`];
  if (secondary.trim()) parts.push(`n ${hintLabel(secondary)}`);
  // From a field, Tab is the field's; leaving `Tab buttons` out keeps the line on one row.
  if (inField) return `Esc, then ${parts.join(" · ")}`;
  parts.push("Tab buttons");
  return parts.join(" · ");
}
