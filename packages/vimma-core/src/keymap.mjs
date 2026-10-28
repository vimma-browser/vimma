/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Compile defaults + user config into per-mode tries for the dispatcher.
 * See docs/specs/m0-core-dispatcher.md § Dispatcher contract, § Config input.
 */
import { resolveActionName, suggestAction } from "./actions.mjs";
import { parseCommandLine } from "./cmdline.mjs";
import { DEFAULT_CONFIG, defaultKeys } from "./defaults.mjs";
import { firefoxShortcuts } from "./firefox-keys.mjs";
import {
  KeyNotationError,
  displayBinding,
  displayKey,
  formatKey,
  parseBinding,
  parseKey,
} from "./keys.mjs";
import { MODES, isMode } from "./modes.mjs";
import { formatPath } from "./toml.mjs";

/** @import { Chord } from "./keys.mjs" */
/** @import { BindingElement } from "./keys.mjs" */
/** @import { ActionDef } from "./actions.mjs" */
/** @import { Mode } from "./modes.mjs" */
/** @import { UserConfig } from "./defaults.mjs" */

/**
 * @typedef {object} TrieNode
 * @property {Map<string, TrieNode>} children   keyed by formatKey(chord)
 * @property {ActionDef} [action]
 * @property {string} label                     display text for pending() ("prefix", "g", ...)
 */

/**
 * @typedef {object} Entry
 * @property {string} text        as written in config
 * @property {ActionDef} action
 * @property {string} seq         canonical concrete sequence, e.g. "ctrl+b c"
 * @property {Chord[]} chords
 * @property {string[]} labels
 * @property {"keys" | "modal"} layer
 * @property {Set<Mode>} modes
 * @property {boolean} user       written in the user's config, not a default
 */

export class KeymapError extends Error {
  /**
   * @param {string} message
   * @param {string} path         config path, e.g. keys.new_tab[1]
   * @param {string} [suggestion]
   */
  constructor(message, path, suggestion) {
    super(`${path}: ${message}${suggestion ? ` (did you mean "${suggestion}"?)` : ""}`);
    this.name = "KeymapError";
    /** The message without path and suggestion, for callers that format those themselves. */
    this.detail = message;
    this.path = path;
    this.suggestion = suggestion;
  }
}

/**
 * @param {string} text
 * @param {string} path
 * @returns {ActionDef}
 */
function resolveOrThrow(text, path) {
  const a = resolveActionName(text);
  if (!a) throw new KeymapError(`unknown action "${text}"`, path, suggestAction(text));
  return a;
}

/**
 * The binding a `:` value stands for (docs/specs/firefox-keys.md decision 5): it runs the rest
 * as a command line. One definition per line, so the same line bound in two modes is one row.
 * @param {string} text   as written, `:firefox Tools:Downloads`
 * @param {string} path
 * @param {Map<string, ActionDef>} cache
 * @returns {ActionDef}
 */
function commandOrThrow(text, path, cache) {
  const line = text.replace(/^[\s:]+/, "").trim();
  const parsed = parseCommandLine(line);
  if (parsed.kind === "empty") throw new KeymapError("expected a command after :", path);
  if (parsed.kind === "error") {
    throw new KeymapError(parsed.error.message, path, parsed.error.suggestions[0]);
  }
  const shown = `:${line}`;
  let def = cache.get(shown);
  if (!def) {
    def = { name: shown, id: "cmdline.run", line, group: "Commands", description: shown };
    cache.set(shown, def);
  }
  return def;
}

/**
 * @template T
 * @param {() => T} fn
 * @param {string} path
 * @returns {T}
 */
function notation(fn, path) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof KeyNotationError) throw new KeymapError(e.message, path);
    /* c8 ignore next */
    throw e;
  }
}

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {string[]}
 */
function asList(v, path) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw new KeymapError("expected a key string or a list of key strings", path);
}

/**
 * @param {UserConfig} [user]
 * @param {{ mac?: boolean }} [options]  macOS's default keys (defaults.mjs MAC_KEYS) and inventory
 */
export function compileKeymap(user = {}, { mac = false } = {}) {
  const defKeys = defaultKeys({ mac });
  const defModal = /** @type {Record<string, unknown>} */ (DEFAULT_CONFIG.modal);
  const userKeys = user.keys ?? {};
  const userModal = /** @type {Record<string, unknown>} */ (user.modal ?? {});
  const userKeyNames = new Set(Object.keys(userKeys));
  /** @type {Map<string, ActionDef>} */
  const commandDefs = new Map();
  /** @type {Set<string>} */
  const overridden = new Set();

  const prefix = notation(
    () => parseKey(/** @type {string} */ (userKeys.prefix ?? defKeys.prefix)),
    "keys.prefix",
  );
  const leaderText = /** @type {string} */ (userModal.leader ?? defModal.leader);
  const leader = notation(() => parseKey(leaderText), "modal.leader");
  const timeoutMs = userModal.timeout_ms ?? defModal.timeout_ms;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new KeymapError("must be a non-negative number of milliseconds", "modal.timeout_ms");
  }

  /**
   * @param {BindingElement[]} els
   * @returns {{ chords: Chord[], labels: string[] }}
   */
  const concretise = (els) => {
    const chords = els.map((e) =>
      "special" in e ? (e.special === "prefix" ? prefix : leader) : e,
    );
    const labels = els.map((e) => ("special" in e ? e.special : formatKey(e)));
    return { chords, labels };
  };

  /** @type {Entry[]} */
  const entries = [];

  // [keys] layer: user lists replace default lists per action (Herdr semantics).
  /** @type {Record<string, string | string[]>} */
  const keyTable = { ...defKeys };
  for (const [name, value] of Object.entries(userKeys)) {
    if (name === "prefix") continue;
    const path = formatPath(["keys", name]);
    const action = resolveOrThrow(name, path);
    asList(value, path);
    delete keyTable[action.name];
    keyTable[name] = value;
    overridden.add(action.name);
  }
  for (const [name, value] of Object.entries(keyTable)) {
    if (name === "prefix") continue;
    const action = resolveOrThrow(name, formatPath(["keys", name]));
    asList(value, formatPath(["keys", name])).forEach((text, i) => {
      const path = formatPath(Array.isArray(value) ? ["keys", name, i] : ["keys", name]);
      const els = notation(() => parseBinding(text), path);
      const first = els[0];
      // A chord with ctrl, alt or meta, or a function key (firefox-keys decision 7), works in
      // every mode, as Firefox's own keys do.
      const global =
        !!first &&
        ("special" in first
          ? first.special === "prefix"
          : first.ctrl || first.alt || first.meta || /^f\d+$/.test(first.key));
      // A leader binding works in the side panel too: `<leader>n` closes what it opened
      // (m3-workspaces 6). The panel takes plain keys itself, so a leader there types nothing.
      const leader = !!first && "special" in first && first.special === "leader";
      /** @type {Mode[]} */
      const modes = global ? [...MODES] : leader ? ["normal", "panel"] : ["normal"];
      const { chords, labels } = concretise(els);
      entries.push({
        text,
        action,
        seq: chords.map(formatKey).join(" "),
        chords,
        labels,
        layer: "keys",
        modes: new Set(modes),
        user: userKeyNames.has(name),
      });
    });
  }

  // [modal.<mode>] layer: user entries are merged over default entries per sequence.
  for (const key of Object.keys(userModal)) {
    if (["leader", "timeout_ms", "hint_chars", "insert_editing"].includes(key)) continue;
    if (!isMode(key)) {
      throw new KeymapError(
        `unknown mode "${key}"`,
        formatPath(["modal", key]),
        MODES.find((m) => m[0] === key[0]),
      );
    }
  }
  for (const mode of MODES) {
    /** @type {Map<string, Entry>} */
    const bySeq = new Map();
    const tables = [
      [/** @type {Record<string, unknown>} */ (defModal[mode] ?? {}), false],
      [/** @type {Record<string, unknown>} */ (userModal[mode] ?? {}), true],
    ];
    for (const [table, isUser] of /** @type {[Record<string, unknown>, boolean][]} */ (tables)) {
      for (const [text, value] of Object.entries(table)) {
        const path = `modal.${mode}.${JSON.stringify(text)}`;
        if (typeof value !== "string") throw new KeymapError("expected an action name", path);
        const action = value.startsWith(":")
          ? commandOrThrow(value, path, commandDefs)
          : resolveOrThrow(value, path);
        const { chords, labels } = concretise(notation(() => parseBinding(text), path));
        const seq = chords.map(formatKey).join(" ");
        const prev = bySeq.get(seq);
        if (isUser) {
          overridden.add(action.name);
          if (prev) overridden.add(prev.action.name);
        } else if (prev && prev.action !== action) {
          throw new KeymapError(`"${text}" is already bound to ${prev.action.name}`, path);
        }
        bySeq.set(seq, {
          text,
          action,
          seq,
          chords,
          labels,
          layer: "modal",
          modes: new Set([mode]),
          user: isUser,
        });
      }
    }
    for (const e of bySeq.values()) {
      // A modal binding shadows a [keys] binding with the same sequence in its mode.
      for (const k of entries) if (k.layer === "keys" && k.seq === e.seq) k.modes.delete(mode);
      entries.push(e);
    }
  }

  // [unbind]
  for (const [mode, list] of Object.entries(user.unbind ?? {})) {
    const path = formatPath(["unbind", mode]);
    if (!isMode(mode)) throw new KeymapError(`unknown mode "${mode}"`, path);
    asList(list, path).forEach((text, i) => {
      const els = notation(() => parseBinding(text), formatPath(["unbind", mode, i]));
      const seq = concretise(els).chords.map(formatKey).join(" ");
      for (const e of entries) {
        if (e.seq === seq && e.modes.delete(mode)) overridden.add(e.action.name);
      }
    });
  }

  // [firefox] enable gives a chord back to Firefox (docs/specs/firefox-keys.md decision 9): the
  // default bindings on it go, in every mode. A modal default goes only when it is that Firefox
  // key's own action (normal-mode esc is stop_loading); the side panel's esc stays the panel's.
  // A binding the user wrote cannot be dropped silently, so it is an error at the enable line.
  asList(user.firefox?.enable ?? [], "firefox.enable").forEach((text, i) => {
    const path = formatPath(["firefox", "enable", i]);
    const chord = formatKey(notation(() => parseKey(text), path));
    const firefoxActions = new Set(
      firefoxShortcuts({ mac })
        .filter((r) => r.chord === chord && r.action)
        .map((r) => r.action),
    );
    for (const e of entries) {
      if (e.modes.size === 0 || formatKey(/** @type {Chord} */ (e.chords[0])) !== chord) continue;
      if (e.user) {
        const table = e.layer === "keys" ? "keys" : `modal.${[...e.modes][0]}`;
        throw new KeymapError(
          `${chord} is bound to ${e.action.name} in [${table}]; unbind it or drop it here`,
          path,
        );
      }
      if (e.layer === "keys" || firefoxActions.has(e.action.name)) e.modes.clear();
    }
  });

  // Build one trie per mode; detect conflicts within a mode.
  /** @type {Record<string, TrieNode>} */
  const tries = {};
  /** @type {Record<string, Entry[]>} */
  const perMode = {};
  for (const mode of MODES) {
    /** @type {Map<string, Entry>} */
    const seen = new Map();
    for (const e of entries) {
      if (!e.modes.has(mode)) continue;
      const prev = seen.get(e.seq);
      if (prev && prev.action !== e.action) {
        throw new KeymapError(
          `"${e.text}" is already bound to ${prev.action.name} in ${mode} mode`,
          `keys.${e.action.name}`,
        );
      }
      if (!prev) seen.set(e.seq, e);
    }
    /** @type {TrieNode} */
    const root = { children: new Map(), label: "" };
    for (const e of seen.values()) {
      let node = root;
      e.chords.forEach((c, i) => {
        const k = formatKey(c);
        let next = node.children.get(k);
        if (!next) {
          next = { children: new Map(), label: /** @type {string} */ (e.labels[i]) };
          node.children.set(k, next);
        }
        node = next;
      });
      node.action = e.action;
    }
    tries[mode] = root;
    perMode[mode] = [...seen.values()];
  }

  /**
   * @param {string} name
   * @param {(text: string) => string} show
   * @returns {string[]}
   */
  const listBindings = (name, show) => {
    /** @type {string[]} */
    const out = [];
    for (const e of entries) {
      if (e.action.name !== name || e.modes.size === 0) continue;
      const mode = /** @type {Mode} */ ([...e.modes][0]);
      const keys = show(e.text);
      const text = e.layer === "modal" && mode !== "normal" ? `${keys} [${mode}]` : keys;
      if (!out.includes(text)) out.push(text);
    }
    return out;
  };

  return {
    prefix,
    leader,
    timeoutMs,
    /** @param {Mode} mode */
    trie: (mode) => /** @type {TrieNode} */ (tries[mode]),
    /** @param {Mode} mode */
    sequences: (mode) =>
      /** @type {Entry[]} */ (perMode[mode]).map((e) => ({ seq: e.seq, name: e.action.name })),
    /**
     * Binding texts as written in config. Modal bindings outside normal mode carry their mode.
     * @param {string} name
     */
    bindingsFor: (name) => listBindings(name, (text) => text),
    /**
     * The keys a user presses for each binding, for help and listings: `prefix+b` shows as
     * `ctrl+b b` with this keymap's prefix and leader (displayBinding). Modal bindings outside
     * normal mode carry their mode: `esc [panel]`.
     * @param {string} name
     */
    keysFor: (name) => listBindings(name, (text) => displayBinding(text, { prefix, leader })),
    /**
     * What prefix and leader stand for, e.g. `prefix = ctrl+b · leader = space`. The leader is
     * named only when a live binding uses it: none of the defaults do.
     */
    legend: () =>
      entries.some((e) => e.modes.size > 0 && e.labels.includes("leader"))
        ? `prefix = ${displayKey(prefix)} · leader = ${displayKey(leader)}`
        : `prefix = ${displayKey(prefix)}`,
    /** @param {string} name */
    isOverridden: (name) => overridden.has(name),
    /**
     * The `:` bindings, one per command line, in config order: the overlay's Commands group.
     * @returns {{ line: string, bindings: string[], name: string }[]}
     */
    commands: () =>
      [...commandDefs.values()]
        .map((d) => ({
          line: d.description,
          bindings: listBindings(d.name, (t) => displayBinding(t, { prefix, leader })),
          name: d.name,
        }))
        .filter((c) => c.bindings.length > 0),
  };
}

/** @typedef {ReturnType<typeof compileKeymap>} Keymap */
