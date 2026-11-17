import { describe, test, expect } from "vitest";
import { compileKeymap, KeymapError } from "../src/keys/keymap.mjs";
import { chordFromEvent, formatKey, parseKey, KeyNotationError } from "../src/keys/keys.mjs";
import { completeCommandLine } from "../src/keys/cmdline.mjs";

// Issue #1175: what the mutation tests of keys/ left unpinned.

const ev = (
  key: string,
  code: string,
  { altGraph, ...mods }: Partial<Record<string, boolean>> = {},
) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
  getModifierState: (m: string) => m === "AltGraph" && !!altGraph,
});
const ctrlAlt = { ctrlKey: true, altKey: true };
const ctrlAltShift = { ctrlKey: true, altKey: true, shiftKey: true };
const text = (e: Parameters<typeof chordFromEvent>[0]) => {
  const c = chordFromEvent(e);
  if (!c) throw new Error("no chord");
  return formatKey(c);
};

// docs/specs/key-handling-batch.md § 3: "every ctrl+letter chord keep their modifiers", on any
// layout. A layout moves letters between keys, onto punctuation keys too (Dvorak's z is on
// Slash), so a letter is not judged by the US character of the key it is on.
describe("chordFromEvent: ctrl+alt+letter on non-US layouts", () => {
  test.each([
    ["AZERTY ctrl+alt+a (KeyQ)", ev("a", "KeyQ", { ctrlKey: true, altKey: true }), "ctrl+alt+a"],
    ["AZERTY ctrl+alt+z (KeyW)", ev("z", "KeyW", { ctrlKey: true, altKey: true }), "ctrl+alt+z"],
    ["QWERTZ ctrl+alt+z (KeyY)", ev("z", "KeyY", { ctrlKey: true, altKey: true }), "ctrl+alt+z"],
    ["Dvorak ctrl+alt+r (KeyO)", ev("r", "KeyO", { ctrlKey: true, altKey: true }), "ctrl+alt+r"],
    [
      "AZERTY ctrl+alt+shift+a (KeyQ)",
      ev("A", "KeyQ", { ctrlKey: true, altKey: true, shiftKey: true }),
      "ctrl+alt+shift+a",
    ],
    ["Dvorak ctrl+alt+z (Slash)", ev("z", "Slash", ctrlAlt), "ctrl+alt+z"],
    ["Dvorak ctrl+alt+s (Semicolon)", ev("s", "Semicolon", ctrlAlt), "ctrl+alt+s"],
    ["Dvorak ctrl+alt+w (Comma)", ev("w", "Comma", ctrlAlt), "ctrl+alt+w"],
    ["Dvorak ctrl+alt+v (Period)", ev("v", "Period", ctrlAlt), "ctrl+alt+v"],
    ["Dvorak ctrl+alt+u (KeyF)", ev("u", "KeyF", ctrlAlt), "ctrl+alt+u"],
    ["Dvorak ctrl+alt+shift+i (KeyG)", ev("I", "KeyG", ctrlAltShift), "ctrl+alt+shift+i"],
    ["AZERTY ctrl+alt+m (Semicolon)", ev("m", "Semicolon", ctrlAlt), "ctrl+alt+m"],
    ["Colemak ctrl+alt+shift+i (KeyL)", ev("I", "KeyL", ctrlAltShift), "ctrl+alt+shift+i"],
    ["Colemak ctrl+alt+o (Semicolon)", ev("o", "Semicolon", ctrlAlt), "ctrl+alt+o"],
    [
      "Mac AZERTY ctrl+Option+a (AltGraph set)",
      ev("a", "KeyQ", { ...ctrlAlt, altGraph: true }),
      "ctrl+alt+a",
    ],
  ])("%s keeps its modifiers", (_name, e, want) => {
    expect(text(e)).toBe(want);
  });

  test.each([
    // Windows ctrl+alt as AltGr on a letter key still composes: French AltGr+e is €.
    ["Windows ctrl+alt as AltGr+e (€)", ev("€", "KeyE", { ctrlKey: true, altKey: true }), "€"],
    ["AltGr on a letter key (Linux @)", ev("@", "KeyQ", { ctrlKey: true, altKey: true }), "@"],
  ])("%s is the bare character", (_name, e, want) => {
    expect(text(e)).toBe(want);
  });
});

describe("parseKey: a <...> token with no key", () => {
  test.each(["<>", "<C->", "<C-S->"])("%s is not a key", (t) => {
    expect(() => parseKey(t)).toThrow(KeyNotationError);
  });
});

describe("compileKeymap: a conflict names normal mode, never the pdf context", () => {
  test("two [keys] actions on one plain key", () => {
    let err: unknown;
    try {
      compileKeymap({ keys: { reload: ["q"], close_tab: ["q"] } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    expect((err as Error).message).toMatch(/already bound to \w+ in normal mode$/);
  });
});

describe("completeCommandLine: ties keep their order", () => {
  test("argument candidates with equal scores keep the order given", () => {
    const names = ["work b", "work a", "work c"];
    const got = completeCommandLine("workspace work", { args: { workspace: names } });
    expect(got.candidates.map((c) => c.value)).toEqual(names.map((n) => `workspace ${n}`));
  });
});
