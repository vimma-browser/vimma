/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Modes the host can report to the dispatcher. `prefix` is not a mode here: the dispatcher
 * tracks a pending prefix itself and the host shows it in the status bar via `pending()`.
 * `element` is a focused text block (docs/specs/element-focus.md): the mode `v` and `y` start from.
 * `index` is the PDF viewer's outline panel (docs/specs/pdf-mode.md decision 10).
 * @typedef {"normal" | "insert" | "visual" | "command" | "hint" | "element" | "help" | "panel"
 *   | "resize" | "index"} Mode
 */

/** @type {readonly Mode[]} */
export const MODES = Object.freeze([
  "normal",
  "insert",
  "visual",
  "command",
  "hint",
  "element",
  "help",
  "panel",
  "resize",
  "index",
]);

/**
 * Keymap contexts (docs/specs/pdf-mode.md decision 4, docs/adr/024-keymap-contexts.md): which
 * bindings normal mode has, by the document the selected tab shows. `pdf` is Firefox's PDF viewer,
 * whose trie is normal's with `[modal.pdf]` merged over it; `page` is every other document. Every
 * other mode has one trie whatever the context.
 * @typedef {"page" | "pdf"} Context
 */

/** @type {readonly Context[]} */
export const CONTEXTS = Object.freeze(["page", "pdf"]);

/**
 * @param {string} context
 * @returns {context is Context}
 */
export function isContext(context) {
  return /** @type {readonly string[]} */ (CONTEXTS).includes(context);
}

/**
 * The names a `[modal.<name>]` table and an `[unbind] <name>` list take: a mode, or a context
 * other than `page` (whose bindings are normal mode's).
 * @param {string} name
 * @returns {name is Mode | "pdf"}
 */
export function isKeymapTable(name) {
  return isMode(name) || (name !== "page" && isContext(name));
}

/**
 * Modes in which leading digits are a count (`3gt`); in the side panel `4j` and `12G`
 * (docs/specs/side-panel-counts.md decision 1).
 */
/** @type {ReadonlySet<Mode>} */
export const COUNT_MODES = new Set(["normal", "visual", "element", "resize", "panel"]);

/**
 * Modes whose own keys a question never takes: a hint label is typed from any `[modal]
 * hint_chars` (the default starts with `a`, the agent question's grant key; a custom one may
 * hold `y` and `n`), and `y` yanks in copy and element mode. A page can raise a
 * permission prompt timed to the mode, and one agent grant releases a whole task's calls, so
 * Firefox's permission prompts, the agent question and the update question stand back in these
 * modes as they do for Vimma's own surfaces; Esc leaves the mode, and then `y` answers.
 * @type {ReadonlySet<Mode>}
 */
export const KEY_KEEPING_MODES = new Set(["hint", "visual", "element"]);

/**
 * @param {string} mode
 * @returns {mode is Mode}
 */
export function isMode(mode) {
  return /** @type {readonly string[]} */ (MODES).includes(mode);
}
