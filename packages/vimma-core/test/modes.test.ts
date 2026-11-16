// Issue #495: the modes whose own keys a question must never take. Firefox's permission prompts,
// the agent question and the update question answer `y` and `n`; a hint label (from any
// `[modal] hint_chars`), copy mode's yank and element mode's yank type the same letters.
import { describe, test, expect } from "vitest";
import { MODES, KEY_KEEPING_MODES, isKeymapTable } from "../src/keys/modes.mjs";

describe("KEY_KEEPING_MODES", () => {
  test("hint, copy (visual) and element mode keep their keys from a question", () => {
    expect([...KEY_KEEPING_MODES].sort()).toEqual(["element", "hint", "visual"]);
  });

  test("normal and resize mode leave y and n to an open question", () => {
    expect(KEY_KEEPING_MODES.has("normal")).toBe(false);
    expect(KEY_KEEPING_MODES.has("resize")).toBe(false);
  });

  test("every one is a mode", () => {
    for (const mode of KEY_KEEPING_MODES) expect(MODES).toContain(mode);
  });
});

describe("isKeymapTable", () => {
  test("a mode or the pdf context names a table; page, the default context, does not", () => {
    expect(isKeymapTable("normal")).toBe(true);
    expect(isKeymapTable("pdf")).toBe(true);
    expect(isKeymapTable("page")).toBe(false);
    expect(isKeymapTable("nope")).toBe(false);
  });
});
