import { test, expect } from "vitest";
import fc from "fast-check";
import { parseKey, formatKey, parseBinding, formatBinding, NAMED_KEYS } from "../src/keys/keys.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { MODES } from "../src/keys/modes.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";

const printable = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789[]\\;',./`=?!@#$%^&*()_{}|:\"<>~-+",
);
const keyArb = fc.oneof(printable, fc.constantFrom(...NAMED_KEYS));
const chordArb = fc.record({
  key: keyArb,
  ctrl: fc.boolean(),
  alt: fc.boolean(),
  shift: fc.boolean(),
  meta: fc.boolean(),
});

test("parseKey(formatKey(c)) round-trips for canonical chords", () => {
  fc.assert(
    fc.property(chordArb, (raw) => {
      const c = parseKey(formatKey(raw));
      expect(parseKey(formatKey(c))).toEqual(c);
      expect(formatKey(parseKey(formatKey(c)))).toBe(formatKey(c));
    }),
  );
});

test("parseBinding(formatBinding(b)) round-trips", () => {
  const element = fc.oneof(
    { weight: 1, arbitrary: fc.constant({ special: "leader" }) },
    { weight: 6, arbitrary: chordArb },
  );
  const bindingArb = fc.tuple(fc.boolean(), fc.array(element, { minLength: 1, maxLength: 4 }));
  fc.assert(
    fc.property(bindingArb, ([withPrefix, rest]) => {
      const head =
        rest[0] && "key" in rest[0]
          ? rest
          : [{ key: "a", ctrl: false, alt: false, shift: false, meta: false }, ...rest];
      const b = parseBinding(formatBinding(withPrefix ? [{ special: "prefix" }, ...head] : rest));
      expect(parseBinding(formatBinding(b))).toEqual(b);
    }),
  );
});

test("defaults bind no sequence twice in any mode", () => {
  const km = compileKeymap();
  for (const mode of MODES) {
    const seqs = km.sequences(mode).map((e) => e.seq);
    expect(new Set(seqs).size, mode).toBe(seqs.length);
  }
});

test("defaults contain no ambiguous sequences (none is a proper prefix of another), so no timeout is needed", () => {
  const km = compileKeymap();
  for (const mode of MODES) {
    const seqs = km.sequences(mode).map((e) => e.seq);
    for (const a of seqs) {
      for (const b of seqs) {
        if (a !== b)
          expect(b.startsWith(a + " "), `${mode}: "${a}" is a prefix of "${b}"`).toBe(false);
      }
    }
  }
});

test("user keymaps: any set of distinct single-key modal bindings dispatches each to its action", () => {
  const letters = fc.uniqueArray(fc.constantFrom(..."acemoqrswyz"), { minLength: 1, maxLength: 8 });
  fc.assert(
    fc.property(letters, (ls) => {
      const normal = Object.fromEntries(ls.map((l) => [`<leader>${l}`, "tab.new"]));
      const km = compileKeymap({ modal: { normal } });
      const d = createDispatcher(km);
      for (const l of ls) {
        expect(d.dispatch("normal", parseKey("space"))).toEqual({ kind: "pending" });
        expect(d.dispatch("normal", parseKey(l))).toEqual({
          kind: "action",
          action: { id: "tab.new" },
        });
      }
    }),
  );
});
