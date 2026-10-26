/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What Esc does, as a pure function of the mode and what is pending (plan §2).
 * See docs/specs/m1-core-logic.md § Esc.
 */
import { isMode } from "./modes.mjs";

/** @import { Mode } from "./modes.mjs" */

/**
 * @typedef {{ kind: "pass" }
 *   | { kind: "cancel", mode: Mode }
 *   | { kind: "action", action: { id: string }, mode: Mode, blur?: true,
 *       collapseSelection?: true, afterPage?: true }} EscapeResult
 */

/** Per mode: the action Esc runs, and whether it returns to the mode an overlay came from. */
/** @type {Record<Exclude<Mode, "normal">, { id: string, back?: true, extra?: object }>} */
const EXITS = {
  insert: { id: "mode.normal", extra: { blur: true } },
  visual: { id: "mode.normal", extra: { collapseSelection: true } },
  command: { id: "command.cancel" },
  hint: { id: "hint.cancel" },
  // Leaves a focused text block with nothing selected (docs/specs/element-focus.md decision 7).
  element: { id: "mode.normal" },
  help: { id: "help.close", back: true },
  panel: { id: "panel.close", back: true },
  resize: { id: "pane.resize_exit", back: true },
};

/**
 * @param {{ mode: Mode, pending?: boolean, previous?: Mode }} state
 *   `pending`: a prefix, key sequence or count is pending; `previous`: the mode an overlay
 *   (help, panel, resize) was opened from
 * @returns {EscapeResult}
 */
export function resolveEscape({ mode, pending = false, previous = "normal" }) {
  for (const m of [mode, previous]) if (!isMode(m)) throw new Error(`unknown mode "${m}"`);
  if (pending) return Object.freeze({ kind: "cancel", mode });
  // Firefox's stop, once the page has had Esc and left it alone (docs/specs/firefox-keys.md
  // decisions 6 and 7).
  if (mode === "normal") {
    return Object.freeze({
      kind: "action",
      action: Object.freeze({ id: "page.stop" }),
      mode,
      afterPage: true,
    });
  }
  const exit = EXITS[mode];
  return Object.freeze({
    kind: "action",
    action: Object.freeze({ id: exit.id }),
    mode: exit.back ? previous : "normal",
    ...exit.extra,
  });
}
