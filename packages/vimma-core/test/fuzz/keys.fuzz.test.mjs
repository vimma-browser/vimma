// Fuzzing key notation (keys.mjs): config.toml bindings, `send-keys` over the control socket,
// keydown events. Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  KeyNotationError,
  NAMED_KEYS,
  chordFromEvent,
  displayBinding,
  formatBinding,
  formatKey,
  parseBinding,
  parseKey,
} from "../../src/keys/keys.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, throwsOnly, within } from "./harness.mjs";

const MODS = ["ctrl", "control", "alt", "opt", "option", "shift", "meta", "cmd", "super", "win"];
/** Pieces key notation is made of, so random joins often come close to valid notation. */
const piece = fc.oneof(
  { weight: 3, arbitrary: nastyString },
  { weight: 3, arbitrary: fc.constantFrom(...MODS, ...NAMED_KEYS, "prefix", "leader", "minus") },
  { weight: 2, arbitrary: fc.constantFrom(...PROTO_NAMES) },
  {
    weight: 2,
    arbitrary: fc.constantFrom("+", "++", "<", ">", "-", "--", " ", "C", "A", "M", "S", "D"),
  },
  { weight: 2, arbitrary: fc.string({ unit: fc.constantFrom(..."aZ?+-<> \t]"), maxLength: 4 }) },
);
const notation = fc
  .array(piece, { maxLength: 8 })
  .chain((parts) =>
    fc.constantFrom(
      parts.join("+"),
      parts.join(""),
      parts.join(" "),
      parts.join("-"),
      `<${parts.join("-")}>`,
    ),
  );

const SOME = 0.25; // share of RUNS for each property; key parsing is fast

describe("key notation fuzzing", () => {
  test(
    "parseKey and parseBinding throw nothing but KeyNotationError, on any text",
    () =>
      fuzz(
        "keys-no-foreign-throw",
        fc.property(fc.oneof(notation, nastyString), (text) => {
          within(1000, () => {
            throwsOnly(() => parseKey(text), KeyNotationError);
            throwsOnly(() => parseBinding(text), KeyNotationError);
          });
        }),
        { weight: 40 * SOME },
      ),
    FUZZ_TIMEOUT,
  );

  // Regression (found by the fuzzer, seed 20261010): the alias and modifier tables were plain
  // objects, so "constructor" found Object and parseKey threw a TypeError, and a config.toml
  // binding of it crashed the reload instead of reporting an error.
  test("a prototype member name is never a key or a modifier: constructor, toString, __proto__", () => {
    for (const name of PROTO_NAMES) {
      for (const text of [name, name.toUpperCase(), `${name}+a`, `ctrl+${name}`]) {
        expect(() => parseKey(text), text).toThrow(KeyNotationError);
      }
      for (const text of [`${name}+a`, `ctrl+${name}`, `<${name}-a>`, `<C-${name}>`]) {
        expect(() => parseBinding(text), text).toThrow(KeyNotationError);
      }
      // Written bare, it is a run of single keys, like `gg`.
      expect(parseBinding(name).length, name).toBe([...name].length);
    }
  });

  test(
    "accepted text round-trips: parse(format(parse(text))) is parse(text)",
    () =>
      fuzz(
        "keys-round-trip",
        fc.property(notation, (text) => {
          /** @type {ReturnType<typeof parseKey> | undefined} */
          let chord;
          try {
            chord = parseKey(text);
          } catch {
            chord = undefined;
          }
          if (chord) expect(parseKey(formatKey(chord))).toEqual(chord);
          let binding;
          try {
            binding = parseBinding(text);
          } catch {
            binding = undefined;
          }
          if (binding) expect(parseBinding(formatBinding(binding))).toEqual(binding);
        }),
        { weight: 40 * SOME },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "displayBinding throws nothing but KeyNotationError on text parseBinding accepts",
    () => {
      const keys = { prefix: parseKey("ctrl+b"), leader: parseKey("space") };
      fuzz(
        "keys-display",
        fc.property(notation, (text) => {
          try {
            parseBinding(text);
          } catch {
            return;
          }
          throwsOnly(() => displayBinding(text, keys), KeyNotationError);
        }),
        { weight: 40 * SOME },
      );
    },
    FUZZ_TIMEOUT,
  );

  test(
    "chordFromEvent never throws, and its chord formats to text parseKey reads back",
    () =>
      fuzz(
        "keys-event",
        fc.property(
          fc.record({
            key: fc.oneof(
              nastyString,
              fc.constantFrom("Escape", "ArrowUp", "Dead", "Unidentified"),
            ),
            code: fc.option(fc.oneof(nastyString, fc.constantFrom("KeyA", "Digit1", "Quote")), {
              nil: undefined,
            }),
            ctrlKey: fc.boolean(),
            altKey: fc.boolean(),
            shiftKey: fc.boolean(),
            metaKey: fc.boolean(),
            altGraph: fc.option(fc.boolean(), { nil: undefined }),
          }),
          ({ altGraph, code, ...e }) => {
            const event = {
              ...e,
              ...(code === undefined ? {} : { code }),
              ...(altGraph === undefined ? {} : { getModifierState: () => altGraph }),
            };
            const chord = chordFromEvent(event);
            if (chord) expect(parseKey(formatKey(chord))).toEqual(chord);
          },
        ),
        { weight: 40 * SOME },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "huge bindings parse in linear time",
    () => {
      for (const unit of ["a", "<C-a>", "ctrl+a ", "+", "<", "<<<>", "prefix+a "]) {
        within(2000, () => throwsOnly(() => parseBinding(unit.repeat(100_000)), KeyNotationError));
      }
    },
    FUZZ_TIMEOUT,
  );
});
