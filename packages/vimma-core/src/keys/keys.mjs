/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Key notation: chords (`ctrl+b`), bindings (`prefix+shift+t`, `<leader>ff`, `gt`, `ctrl+w h`).
 * See docs/specs/m0-core-dispatcher.md § Key notation.
 */

/**
 * @typedef {object} Chord
 * @property {string} key   lowercase letter, printable character, or a name from NAMED_KEYS
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {boolean} meta
 */

/** @typedef {{ special: "prefix" | "leader" }} Special */
/** @typedef {Chord | Special} BindingElement */

export class KeyNotationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "KeyNotationError";
  }
}

/** Canonical names for non-printable keys. */
export const NAMED_KEYS = Object.freeze([
  "esc",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const NAMED = new Set(NAMED_KEYS);

/**
 * `table[key]` among the table's own entries only. Key text is input (config.toml, the control
 * socket): a plain lookup of "constructor" or "__proto__" would find Object's members.
 * @template T
 * @param {Record<string, T>} table
 * @param {string} key
 * @returns {T | undefined}
 */
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Aliases (lowercase) → canonical key. Includes DOM `KeyboardEvent.key` names. */
/** @type {Record<string, string>} */
const KEY_ALIASES = {
  escape: "esc",
  return: "enter",
  cr: "enter",
  " ": "space",
  bs: "backspace",
  del: "delete",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  minus: "-",
  plus: "+",
  lt: "<",
  bar: "|",
  bslash: "\\",
};

/** Canonical key → name used when formatting, for keys that would be ambiguous as text. */
/** @type {Record<string, string>} */
const FORMAT_NAMES = { "-": "minus", "+": "plus" };

/** @type {Record<string, "ctrl" | "alt" | "shift" | "meta">} */
const MODIFIERS = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  super: "meta",
  win: "meta",
};

/** Vim `<X-...>` modifier letters. */
/** @type {Record<string, "ctrl" | "alt" | "shift" | "meta">} */
const VIM_MODIFIERS = { c: "ctrl", a: "alt", m: "alt", s: "shift", d: "meta" };

const MOD_ORDER = /** @type {const} */ (["ctrl", "alt", "shift", "meta"]);

/**
 * Normalise a key name and fold shift into it where the character already carries it.
 * @param {string} raw
 * @param {boolean} shift
 * @returns {{ key: string, shift: boolean } | null}
 */
function normaliseKey(raw, shift) {
  if (raw.length === 1) {
    if (raw === " ") return { key: "space", shift };
    const lower = raw.toLowerCase();
    // A key is one character, so a letter whose lower case is longer (U+0130 "İ" becomes "i̇",
    // i and a combining dot above, per Unicode SpecialCasing.txt) cannot be stored lowercase. It
    // is kept as typed, like the other printable characters.
    if (lower.length === 1 && lower !== raw.toUpperCase()) {
      // a letter: uppercase means shift
      return { key: lower, shift: shift || raw !== lower };
    }
    // other printable: shift is already part of the character
    return { key: raw, shift: false };
  }
  const lower = raw.toLowerCase();
  const aliased = own(KEY_ALIASES, lower) ?? lower;
  if (aliased.length === 1) return normaliseKey(aliased, shift);
  if (NAMED.has(aliased)) return { key: aliased, shift };
  return null;
}

/**
 * @param {string} key
 * @param {Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>} mods
 * @returns {Chord}
 */
function makeChord(key, mods) {
  return {
    key,
    ctrl: !!mods.ctrl,
    alt: !!mods.alt,
    shift: !!mods.shift,
    meta: !!mods.meta,
  };
}

/**
 * Canonical text for a key and modifiers, as `formatKey` writes it (`+` with ctrl → `ctrl+plus`).
 * @param {string} key  one character or a name from NAMED_KEYS
 * @param {Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>} mods
 * @returns {string}
 */
export function makeChordText(key, mods) {
  return formatKey(makeChord(key, mods));
}

/**
 * Parse one chord in Herdr notation: `ctrl+b`, `shift+t`, `T`, `?`, `minus`, `esc`, `ctrl+alt+]`.
 * @param {string} text
 * @returns {Chord}
 */
export function parseKey(text) {
  if (text === "") throw new KeyNotationError("empty key");
  if (text === " " || text === "+") return makeChord(text === " " ? "space" : "+", {});
  // A trailing "++" means the key is "+" itself: "ctrl++".
  const plusKey = text.endsWith("++");
  const parts = (plusKey ? text.slice(0, -2) : text).split("+");
  const rawKey = plusKey ? "+" : /** @type {string} */ (parts.pop());
  if (rawKey === "") throw new KeyNotationError(`missing key in "${text}"`);
  /** @type {Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>} */
  const mods = {};
  for (const p of plusKey && parts.length === 1 && parts[0] === "" ? [] : parts) {
    const m = own(MODIFIERS, p.toLowerCase());
    if (!m) throw new KeyNotationError(`unknown modifier "${p}" in "${text}"`);
    if (mods[m]) throw new KeyNotationError(`modifier "${p}" repeated in "${text}"`);
    mods[m] = true;
  }
  const norm = normaliseKey(rawKey, !!mods.shift);
  if (!norm) throw new KeyNotationError(`unknown key "${rawKey}" in "${text}"`);
  return makeChord(norm.key, { ...mods, shift: norm.shift });
}

/**
 * Canonical text for a chord. Non-canonical input (e.g. shift on "?") is canonicalised.
 * @param {Chord} chord
 * @returns {string}
 */
export function formatKey(chord) {
  const norm = normaliseKey(chord.key, chord.shift) ?? { key: chord.key, shift: chord.shift };
  const c = { ...chord, ...norm };
  const mods = MOD_ORDER.filter((m) => c[m]);
  return [...mods, own(FORMAT_NAMES, c.key) ?? c.key].join("+");
}

/**
 * Parse a Vim `<...>` token's inner text (without brackets).
 * @param {string} inner
 * @returns {BindingElement | null}
 */
function parseAngle(inner) {
  const lower = inner.toLowerCase();
  if (lower === "leader") return { special: "leader" };
  const parts = inner.split("-");
  // "<C-->" means ctrl+minus
  if (inner.endsWith("--")) parts.splice(-2, 2, "-");
  const rawKey = /** @type {string} */ (parts.pop());
  /** @type {Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>} */
  const mods = {};
  for (const p of parts) {
    const m = own(VIM_MODIFIERS, p.toLowerCase());
    if (!m || mods[m]) return null;
    mods[m] = true;
  }
  if (rawKey === "") return null;
  const norm = normaliseKey(rawKey, !!mods.shift);
  if (!norm) return null;
  return makeChord(norm.key, { ...mods, shift: norm.shift });
}

/**
 * Parse a whitespace-free segment.
 * @param {string} seg
 * @returns {BindingElement[]}
 */
function parseSegment(seg) {
  if (seg.toLowerCase().startsWith("prefix+")) {
    return [{ special: "prefix" }, parseKey(seg.slice("prefix+".length))];
  }
  if (seg.toLowerCase() === "prefix") throw new KeyNotationError(`"prefix" needs a key: prefix+c`);
  if (!seg.startsWith("<") && seg.length > 1 && (seg.includes("+") || normaliseKey(seg, false))) {
    return [parseKey(seg)];
  }
  /** @type {BindingElement[]} */
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = /** @type {string} */ (seg[i]);
    if (ch === "<") {
      const close = seg.indexOf(">", i + 1);
      if (close === -1) {
        if (i === seg.length - 1) {
          out.push(makeChord("<", {}));
          continue;
        }
        throw new KeyNotationError(`unclosed "<" in "${seg}"`);
      }
      const el = parseAngle(seg.slice(i + 1, close));
      if (!el) throw new KeyNotationError(`unknown key "${seg.slice(i, close + 1)}"`);
      out.push(el);
      i = close;
      continue;
    }
    out.push(parseKey(ch));
  }
  return out;
}

/**
 * Parse a binding into a sequence of chords and symbolic `prefix` / `leader` elements.
 * @param {string} text
 * @returns {BindingElement[]}
 */
export function parseBinding(text) {
  const segs = text.trim().split(/\s+/).filter(Boolean);
  if (segs.length === 0) throw new KeyNotationError("empty binding");
  return segs.flatMap(parseSegment);
}

/**
 * A chord as a user reads it: canonical, except that a bare `-` or `+` shows as itself.
 * @param {Chord} chord
 * @returns {string}
 */
export function displayKey(chord) {
  const text = formatKey(chord);
  return text === "minus" ? "-" : text === "plus" ? "+" : text;
}

/**
 * A binding as the keys a user presses, for help and listings (never for config): `prefix+b`
 * shows as `ctrl+b b` and `<leader>n` as `space n` with the given prefix and leader, `<C-w>h`
 * as `ctrl+w h`. Keys are separated by spaces, as the guide writes them, except that a run of
 * plain characters stays as written (`gg`, `gT`, `G`). The binding must be valid notation.
 * @param {string} text
 * @param {{ prefix: Chord, leader: Chord }} keys
 * @returns {string}
 */
export function displayBinding(text, { prefix, leader }) {
  /** @type {string[]} */
  const words = [];
  for (const seg of text.trim().split(/\s+/).filter(Boolean)) {
    if (seg.toLowerCase().startsWith("prefix+")) {
      words.push(displayKey(prefix), displayKey(parseKey(seg.slice("prefix+".length))));
      continue;
    }
    if (!seg.startsWith("<") && seg.length > 1 && (seg.includes("+") || normaliseKey(seg, false))) {
      words.push(displayKey(parseKey(seg)));
      continue;
    }
    let run = "";
    for (let i = 0; i < seg.length; i++) {
      const close = seg[i] === "<" ? seg.indexOf(">", i + 1) : -1;
      if (close === -1) {
        run += seg[i];
        continue;
      }
      const el = parseAngle(seg.slice(i + 1, close));
      if (!el) throw new KeyNotationError(`unknown key "${seg.slice(i, close + 1)}"`);
      if (run) words.push(run);
      run = "";
      words.push(displayKey("special" in el ? leader : el));
      i = close;
    }
    if (run) words.push(run);
  }
  return words.join(" ");
}

/**
 * Canonical, space-separated text for a binding. `prefix` followed by a chord prints as
 * `prefix+<chord>`; `leader` prints as `<leader>`.
 * @param {BindingElement[]} elements
 * @returns {string}
 */
export function formatBinding(elements) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const el = /** @type {BindingElement} */ (elements[i]);
    if ("special" in el) {
      const next = elements[i + 1];
      if (el.special === "prefix" && next && !("special" in next)) {
        out.push(`prefix+${formatKey(next)}`);
        i++;
      } else {
        out.push(el.special === "prefix" ? "prefix" : "<leader>");
      }
    } else {
      out.push(formatKey(el));
    }
  }
  return out.join(" ");
}

/** What each physical key (`KeyboardEvent.code`) types on a US layout: [plain, with shift]. */
/** @type {Record<string, [string, string]>} */
const US_CODES = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  ...Object.fromEntries([..."0123456789"].map((d, i) => [`Digit${d}`, [d, ")!@#$%^&*("[i] ?? ""]])),
};

/**
 * Whether `key`, one character, is what its physical key types without Option/AltGr, judged by
 * a US layout at the same shift state; a letter key typing its own letter. An unknown `code`
 * (a synthesized event) counts only letters and digits as the key's own.
 * @param {string} key
 * @param {string | undefined} code
 * @param {boolean} shift
 */
function ownCharacter(key, code, shift) {
  const letter = code?.match(/^Key([A-Z])$/)?.[1];
  if (letter) return key.toLowerCase() === letter.toLowerCase();
  const us = code ? own(US_CODES, code) : undefined;
  if (us) return key === us[shift ? 1 : 0];
  return /^[a-z0-9]$/i.test(key);
}

/**
 * Translate a DOM-like keydown event into a chord, or null for modifier-only / unusable keys.
 * A character composed with Option (macOS) or AltGr (Linux, Windows) is that character with no
 * alt, as shift is folded for printable characters (docs/specs/key-handling-batch.md § 3): the
 * key is one printable character its physical key does not type by itself, and either
 * `getModifierState("AltGraph")` says so, or ctrl and alt are down together (Windows' ctrl+alt
 * emulation of AltGr), or alt is down and the event cannot say (no `getModifierState`). Ctrl
 * goes too when it came with alt. Alt alone with AltGraph up is a real alt chord.
 * @param {{ key: string, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean,
 *   code?: string, getModifierState?: (key: string) => boolean }} e
 * @returns {Chord | null}
 */
export function chordFromEvent(e) {
  const norm = normaliseKey(e.key, e.shiftKey);
  if (!norm) return null;
  let { ctrlKey: ctrl, altKey: alt } = e;
  const altGraph = e.getModifierState ? e.getModifierState("AltGraph") : alt;
  const printable = [...e.key].length === 1 && e.key !== " ";
  if (
    printable &&
    !e.metaKey &&
    (altGraph || (ctrl && alt)) &&
    !ownCharacter(e.key, e.code, e.shiftKey)
  ) {
    if (alt) ctrl = false;
    alt = false;
  }
  return makeChord(norm.key, {
    ctrl,
    alt,
    meta: e.metaKey,
    shift: norm.shift,
  });
}
