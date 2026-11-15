/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Compile defaults + user config into per-mode tries for the dispatcher.
 * See docs/specs/m0-core-dispatcher.md § Dispatcher contract, § Config input.
 */
import { removedAction, resolveActionName, suggestAction } from "./actions.mjs";
import { parseCommandLine } from "./cmdline.mjs";
import { DEFAULT_CONFIG, defaultKeys } from "../config/defaults.mjs";
import { insertEditCommand } from "./editable.mjs";
import { SUGGESTION_ACTIONS } from "./suggestions.mjs";
import { firefoxShortcuts } from "./firefox-keys.mjs";
import {
  KeyNotationError,
  displayBinding,
  displayKey,
  formatKey,
  parseBinding,
  parseKey,
} from "./keys.mjs";
import { MODES, isKeymapTable } from "./modes.mjs";
import { formatPath } from "../config/toml.mjs";

/** @import { Chord } from "./keys.mjs" */
/** @import { BindingElement } from "./keys.mjs" */
/** @import { ActionDef } from "./actions.mjs" */
/** @import { Mode } from "./modes.mjs" */
/** @import { UserConfig } from "../config/defaults.mjs" */
/** @import { Context } from "./modes.mjs" */

/**
 * A trie the keymap builds: one per mode, and `pdf` for normal mode in the pdf context
 * (docs/adr/024-keymap-contexts.md).
 * @typedef {Mode | "pdf"} KeymapTarget
 */

/** @type {readonly KeymapTarget[]} */
const TARGETS = Object.freeze([...MODES, "pdf"]);

/**
 * The modes whose keys type into a text field: a page's field or the address bar, the `:` line,
 * the help overlay's filter. Vim's text-field keys there are the field's before a default
 * [keys] binding (docs/specs/key-handling-batch.md § 2).
 * @type {readonly KeymapTarget[]}
 */
const TEXT_FIELD_MODES = Object.freeze(["insert", "command", "help"]);

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
 * @property {Set<KeymapTarget>} modes  the modes it is bound in, and `pdf` for normal mode's pdf context
 * @property {boolean} user       written in the user's config, not a default
 * @property {Set<KeymapTarget>} [shadowed]  [keys] only: the modes where a modal binding on the
 *   same sequence hides it; it is that binding's fallback there (keymap `fallback`)
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
  if (a) return a;
  const why = removedAction(text);
  if (why) throw new KeymapError(`action "${text}" was removed: ${why}`, path);
  throw new KeymapError(`unknown action "${text}"`, path, suggestAction(text));
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
 * @param {Mode} mode
 * @param {Context} context
 * @returns {KeymapTarget}
 */
const target = (mode, context) => (mode === "normal" && context === "pdf" ? "pdf" : mode);

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
      /** @type {KeymapTarget[]} */
      const modes = global ? [...TARGETS] : leader ? ["normal", "panel", "pdf"] : ["normal", "pdf"];
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
    if (!isKeymapTable(key)) {
      throw new KeymapError(
        `unknown mode "${key}"`,
        formatPath(["modal", key]),
        TARGETS.find((m) => m[0] === key[0]),
      );
    }
  }
  for (const mode of TARGETS) {
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
        // The prefix layer must work in every mode and context (pdf-mode decision 5).
        if (mode === "pdf" && chords[0] && formatKey(chords[0]) === formatKey(prefix)) {
          throw new KeymapError("[modal.pdf] cannot bind the prefix", path);
        }
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
          // Normal mode's bindings are the pdf context's too, under [modal.pdf].
          modes: new Set(mode === "normal" ? ["normal", "pdf"] : [mode]),
          user: isUser,
        });
      }
    }
    for (const e of bySeq.values()) {
      // A modal binding shadows a [keys] binding with the same sequence in its mode; normal's
      // shadows it in the pdf context too, and [modal.pdf] shadows normal's there.
      for (const k of entries) {
        if (k.seq !== e.seq) continue;
        if (mode === "pdf") k.modes.delete("pdf");
        else if (k.layer === "keys") {
          for (const m of e.modes) {
            if (!k.modes.delete(m)) continue;
            (k.shadowed ??= new Set()).add(m);
          }
        }
      }
      entries.push(e);
    }
  }

  // Vim's text-field keys (docs/specs/key-handling-batch.md § 2, decision on ctrl+j and ctrl+m):
  // a default [keys] binding on one, such as ctrl+m (mute_tab) and ctrl+j (web_search), which
  // carry Firefox's meaning, is not bound in the modes that type into a text field, so the key
  // is the field's there, as in Vim. A binding the user added stays and wins, as for ctrl+w; one
  // that repeats the default (a config.toml copied from defaults.toml) is still the default.
  const insertEditing = userModal.insert_editing ?? defModal.insert_editing;
  if (insertEditing !== false) {
    /** @type {Set<string>} action name and sequence of each default [keys] binding */
    const defaults = new Set();
    for (const [name, value] of Object.entries(defKeys)) {
      if (name === "prefix") continue;
      for (const text of asList(value, formatPath(["keys", name]))) {
        const { chords } = concretise(notation(() => parseBinding(text), name));
        defaults.add(`${name} ${chords.map(formatKey).join(" ")}`);
      }
    }
    for (const e of entries) {
      if (e.layer !== "keys" || !e.chords[0]) continue;
      if (e.user && !defaults.has(`${e.action.name} ${e.seq}`)) continue;
      if (!insertEditCommand(formatKey(e.chords[0]), { mac })) continue;
      for (const m of TEXT_FIELD_MODES) {
        e.modes.delete(m);
        e.shadowed?.delete(m);
      }
    }
  }

  // [unbind]
  for (const [mode, list] of Object.entries(user.unbind ?? {})) {
    const path = formatPath(["unbind", mode]);
    if (!isKeymapTable(mode)) throw new KeymapError(`unknown mode "${mode}"`, path);
    asList(list, path).forEach((text, i) => {
      const els = notation(() => parseBinding(text), formatPath(["unbind", mode, i]));
      const seq = concretise(els).chords.map(formatKey).join(" ");
      for (const e of entries) {
        if (e.seq !== seq || !e.modes.delete(mode)) continue;
        // Unbound in normal mode is unbound in its pdf context too.
        if (mode === "normal") e.modes.delete("pdf");
        overridden.add(e.action.name);
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
      // The suggestion keys count as the chord's own (page-suggestions decision 8): enable asks
      // for the key as Firefox runs it, everywhere.
      if (
        e.layer === "keys" ||
        firefoxActions.has(e.action.name) ||
        SUGGESTION_ACTIONS.has(/** @type {any} */ (e.action.id))
      ) {
        e.modes.clear();
        e.shadowed?.clear();
      }
    }
  });

  // Build one trie per mode and one for the pdf context; detect conflicts within each.
  /** @type {Record<string, TrieNode>} */
  const tries = {};
  /** @type {Record<string, Entry[]>} */
  const perMode = {};
  for (const mode of TARGETS) {
    /** @type {Map<string, Entry>} */
    const seen = new Map();
    for (const e of entries) {
      if (!e.modes.has(mode)) continue;
      const prev = seen.get(e.seq);
      if (prev && prev.action !== e.action) {
        throw new KeymapError(
          `"${e.text}" is already bound to ${prev.action.name} in ${mode === "pdf" ? "the pdf context" : `${mode} mode`}`,
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
      const mode = /** @type {KeymapTarget} */ ([...e.modes][0]);
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
    /**
     * The trie a key is looked up in: the mode's, or the pdf context's in normal mode.
     * @param {Mode} mode
     * @param {Context} [context]
     */
    trie: (mode, context = "page") => /** @type {TrieNode} */ (tries[target(mode, context)]),
    /**
     * @param {Mode} mode
     * @param {Context} [context]
     */
    sequences: (mode, context = "page") =>
      /** @type {Entry[]} */ (perMode[target(mode, context)]).map((e) => ({
        seq: e.seq,
        name: e.action.name,
      })),
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
     * The [keys] binding a modal binding on `seq` hides in `mode`, or null: what a suggestion key
     * runs outside a list (docs/specs/page-suggestions.md decision 6).
     * @param {Mode} mode
     * @param {string} seq  canonical sequence, `ctrl+p`
     * @returns {ActionDef | null}
     */
    fallback: (mode, seq) =>
      entries.find((e) => e.layer === "keys" && e.seq === seq && e.shadowed?.has(mode))?.action ??
      null,
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
