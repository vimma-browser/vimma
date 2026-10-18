/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The dispatcher: one keydown in, one answer out. Stateful only in its pending buffer.
 * See docs/specs/m0-core-dispatcher.md § Dispatcher contract.
 */
import { formatKey } from "./keys.mjs";
import { COUNT_MODES, isMode } from "./modes.mjs";

/** @import { Chord } from "./keys.mjs" */
/** @import { Mode } from "./modes.mjs" */
/** @import { Keymap } from "./keymap.mjs" */
/** @import { TrieNode } from "./keymap.mjs" */
/** @import { ActionDef } from "./actions.mjs" */

/**
 * `line`: the command line a `:` binding runs (docs/specs/firefox-keys.md decision 5).
 * @typedef {{ id: string, count?: number, arg?: number, char?: string, line?: string }} Action
 */
/**
 * @typedef {{ kind: "action", action: Action, replay?: true }
 *   | { kind: "pending" }
 *   | { kind: "cancel" }
 *   | { kind: "pass" }} DispatchResult
 */

const PENDING = Object.freeze({ kind: /** @type {const} */ ("pending") });
const CANCEL = Object.freeze({ kind: /** @type {const} */ ("cancel") });
const PASS = Object.freeze({ kind: /** @type {const} */ ("pass") });

/** @param {Chord} c */
const isBareDigit = (c) => /^[0-9]$/.test(c.key) && !c.ctrl && !c.alt && !c.meta;

/**
 * The character a chord types, for an action that takes one (`f x`), or null for a named key
 * or a chord with ctrl, alt or meta.
 * @param {Chord} c
 * @returns {string | null}
 */
function typedChar(c) {
  if (c.ctrl || c.alt || c.meta) return null;
  if (c.key === "space") return " ";
  if ([...c.key].length !== 1) return null;
  return c.shift ? c.key.toUpperCase() : c.key;
}

/**
 * @param {Keymap} keymap
 */
export function createDispatcher(keymap) {
  /** @type {Mode | null} */
  let mode = null;
  /** @type {TrieNode | null} */
  let node = null; // non-null while a sequence is pending
  /** @type {string[]} */
  let labels = [];
  let count = "";
  /** @type {ActionDef | null} an action waiting for its character (`f`, then `x`) */
  let wantsChar = null;

  function reset() {
    node = null;
    labels = [];
    count = "";
    wantsChar = null;
  }

  /**
   * @param {ActionDef} def
   * @param {string} [char]
   * @returns {{ kind: "action", action: Action }}
   */
  function emit(def, char) {
    /** @type {Action} */
    const action = { id: def.id };
    if (def.arg !== undefined) action.arg = def.arg;
    if (def.line !== undefined) action.line = def.line;
    if (count) action.count = Number(count);
    if (char !== undefined) action.char = char;
    reset();
    return { kind: "action", action };
  }

  /**
   * @param {Mode} m
   * @param {Chord} chord
   * @returns {DispatchResult}
   */
  function dispatch(m, chord) {
    if (!isMode(m)) throw new Error(`unknown mode "${m}"`);
    if (m !== mode) {
      reset();
      mode = m;
    }
    const busy = node !== null || count !== "" || wantsChar !== null;
    const isEsc = chord.key === "esc" && !chord.ctrl && !chord.alt && !chord.meta && !chord.shift;
    if (busy && isEsc) {
      reset();
      return CANCEL;
    }
    if (wantsChar) {
      // `f` was the last key: this one is its character, whatever it is bound to.
      const char = typedChar(chord);
      if (char === null) {
        reset();
        return CANCEL;
      }
      return emit(wantsChar, char);
    }
    const root = keymap.trie(m);
    const key = formatKey(chord);

    if (
      node === null &&
      COUNT_MODES.has(m) &&
      isBareDigit(chord) &&
      (chord.key !== "0" || count !== "") &&
      !root.children.has(key)
    ) {
      count += chord.key;
      return PENDING;
    }

    const from = node ?? root;
    const next = from.children.get(key);
    if (!next) {
      if (node === null) {
        if (count === "") return PASS;
        reset();
        return CANCEL;
      }
      if (node.action?.takesChar) {
        // A prefix that also takes a character: this key is the character.
        const char = typedChar(chord);
        if (char !== null) return emit(node.action, char);
      } else if (node.action) return { ...emit(node.action), replay: true };
      reset();
      return CANCEL;
    }
    if (next.children.size > 0) {
      node = next;
      labels.push(next.label);
      return PENDING;
    }
    // A leaf always carries an action: compileKeymap only creates nodes along bound sequences.
    const def = /** @type {ActionDef} */ (next.action);
    if (def.takesChar) {
      node = null;
      labels.push(next.label);
      wantsChar = def;
      return PENDING;
    }
    return emit(def);
  }

  /**
   * Resolve a pending sequence after timeout_ms.
   * @returns {DispatchResult | null}
   */
  function flush() {
    if (node === null && count === "" && wantsChar === null) return null;
    if (node?.action && !node.action.takesChar) return emit(node.action);
    reset();
    return CANCEL;
  }

  return {
    dispatch,
    flush,
    reset,
    /**
     * True when the pending buffer is itself a complete binding, i.e. flush() would resolve it to
     * an action. Only then should the host arm the timeout_ms timer; a bare prefix waits for
     * the next key or Esc.
     */
    ambiguous: () => !!node?.action && !node.action.takesChar,
    /** Pending keys for the status bar, e.g. ["prefix"] or ["2", "g"]. */
    pending: () => [...count, ...labels],
    timeoutMs: keymap.timeoutMs,
  };
}
