import { describe, test, expect } from "vitest";
import {
  parseKey,
  formatKey,
  parseBinding,
  formatBinding,
  displayBinding,
  chordFromEvent,
  KeyNotationError,
} from "../src/keys/keys.mjs";

import type { Chord } from "../src/keys/keys.mjs";

/** The chord a keydown makes, failing the test where it makes none. */
const made = (chord: Chord | null): Chord => {
  if (chord === null) throw new Error("the keydown made no chord");
  return chord;
};

const chord = (key: string, mods: Partial<Chord> = {}) => ({
  key,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
});

describe("parseKey", () => {
  test.each([
    ["ctrl+b", chord("b", { ctrl: true })],
    ["c", chord("c")],
    ["shift+t", chord("t", { shift: true })],
    ["T", chord("t", { shift: true })],
    ["?", chord("?")],
    ["shift+?", chord("?")],
    ["ctrl+alt+]", chord("]", { ctrl: true, alt: true })],
    ["minus", chord("-")],
    ["plus", chord("+")],
    ["-", chord("-")],
    ["esc", chord("esc")],
    ["Escape", chord("esc")],
    ["Enter", chord("enter")],
    ["space", chord("space")],
    ["shift+tab", chord("tab", { shift: true })],
    ["F5", chord("f5")],
    ["meta+k", chord("k", { meta: true })],
    ["Ctrl+Shift+X", chord("x", { ctrl: true, shift: true })],
    ["cmd+k", chord("k", { meta: true })],
    ["control+option+k", chord("k", { ctrl: true, alt: true })],
  ])("a chord written %s parses to its canonical chord", (text, expected) => {
    expect(parseKey(text)).toEqual(expected);
  });

  // "İ" (U+0130) lower-cases to "i̇", two code units, which is no longer one key (issue #313).
  test("a capital letter whose lower case is longer than one character keeps its own key", () => {
    expect(parseKey("İ")).toEqual(chord("İ"));
    expect(parseKey("shift+İ")).toEqual(chord("İ"));
    expect(parseKey(formatKey(parseKey("İ")))).toEqual(parseKey("İ"));
    expect(parseBinding(formatBinding(parseBinding("İ")))).toEqual(parseBinding("İ"));
  });

  test.each(["", "ctrl+", "ctrl+foo", "hyper+k", "ctrl+ctrl+k", "ab"])(
    "invalid chord %j throws KeyNotationError",
    (text) => {
      expect(() => parseKey(text)).toThrow(KeyNotationError);
    },
  );
});

describe("formatKey", () => {
  test.each([
    [chord("b", { ctrl: true }), "ctrl+b"],
    [chord("t", { shift: true }), "shift+t"],
    [chord("k", { ctrl: true, alt: true, shift: true, meta: true }), "ctrl+alt+shift+meta+k"],
    [chord("-"), "minus"],
    [chord("+", { ctrl: true }), "ctrl+plus"],
    [chord("space"), "space"],
  ])("formats %j as %s", (c, text) => {
    expect(formatKey(c)).toBe(text);
  });
});

describe("parseBinding", () => {
  test("Herdr prefix notation becomes the symbolic prefix plus a chord", () => {
    expect(parseBinding("prefix+shift+t")).toEqual([
      { special: "prefix" },
      chord("t", { shift: true }),
    ]);
    expect(parseBinding("prefix+minus")).toEqual([{ special: "prefix" }, chord("-")]);
    expect(parseBinding("prefix+?")).toEqual([{ special: "prefix" }, chord("?")]);
  });

  test("space-separated chords form a sequence", () => {
    expect(parseBinding("ctrl+w h")).toEqual([chord("w", { ctrl: true }), chord("h")]);
  });

  test("Vim notation: bare characters are one chord each", () => {
    expect(parseBinding("gt")).toEqual([chord("g"), chord("t")]);
    expect(parseBinding("gT")).toEqual([chord("g"), chord("t", { shift: true })]);
    expect(parseBinding("G")).toEqual([chord("g", { shift: true })]);
  });

  test("Vim angle-bracket notation", () => {
    expect(parseBinding("<leader>ff")).toEqual([{ special: "leader" }, chord("f"), chord("f")]);
    expect(parseBinding("<C-w>h")).toEqual([chord("w", { ctrl: true }), chord("h")]);
    expect(parseBinding("<Esc>")).toEqual([chord("esc")]);
    expect(parseBinding("<S-Tab>")).toEqual([chord("tab", { shift: true })]);
    expect(parseBinding("<C-A-x>")).toEqual([chord("x", { ctrl: true, alt: true })]);
    expect(parseBinding("<M-x>")).toEqual([chord("x", { alt: true })]);
    expect(parseBinding("<D-x>")).toEqual([chord("x", { meta: true })]);
    expect(parseBinding("<Space>")).toEqual([chord("space")]);
    expect(parseBinding("<lt>")).toEqual([chord("<")]);
    expect(parseBinding("<")).toEqual([chord("<")]);
    expect(parseBinding("<C-w><")).toEqual([chord("w", { ctrl: true }), chord("<")]);
  });

  test.each(["", "<leader", "<Foo>", "prefix", "<C-ctrl>", "prefix+prefix+c"])(
    "invalid binding %j throws",
    (text) => {
      expect(() => parseBinding(text)).toThrow(KeyNotationError);
    },
  );
});

describe("formatBinding", () => {
  test.each([
    ["prefix+shift+t", "prefix+shift+t"],
    ["prefix+-", "prefix+minus"],
    ["gt", "g t"],
    ["<leader>ff", "<leader> f f"],
    ["<C-w>h", "ctrl+w h"],
  ])("%s formats canonically as %s", (input, out) => {
    expect(formatBinding(parseBinding(input))).toBe(out);
  });
});

describe("displayBinding", () => {
  const defaults = { prefix: parseKey("ctrl+b"), leader: parseKey("space") };
  test.each([
    ["prefix+b", "ctrl+b b"],
    ["<leader>n", "space n"],
    ["prefix+shift+x", "ctrl+b shift+x"],
    ["prefix+?", "ctrl+b ?"],
    ["prefix+minus", "ctrl+b -"],
    ["prefix+-", "ctrl+b -"],
    ["prefix+1", "ctrl+b 1"],
    ["<C-w>h", "ctrl+w h"],
    ["<C-w><", "ctrl+w <"],
    ["<C-w>-", "ctrl+w -"],
    ["<Esc>", "esc"],
    ["<CR>", "enter"],
    ["<lt>", "<"],
    ["gg", "gg"],
    ["gT", "gT"],
    ["G", "G"],
    ["$", "$"],
    ["ctrl+i", "ctrl+i"],
    ["Ctrl+Alt+c", "ctrl+alt+c"],
    ["<leader>ff", "space ff"],
    ["prefix+g prefix+x", "ctrl+b g ctrl+b x"],
    ["g <leader>x", "g space x"],
  ])("%s shows as %s with the default prefix and leader", (input, out) => {
    expect(displayBinding(input, defaults)).toBe(out);
  });

  test.each([
    ["prefix+b", "ctrl+a b"],
    ["prefix+shift+x", "ctrl+a shift+x"],
    ["<leader>n", ", n"],
    ["<Leader>n", ", n"],
  ])("%s follows a remapped prefix and leader as %s", (input, out) => {
    expect(displayBinding(input, { prefix: parseKey("ctrl+a"), leader: parseKey(",") })).toBe(out);
  });

  test("a minus prefix or leader shows as the character", () => {
    expect(displayBinding("<leader>n", { ...defaults, leader: parseKey("minus") })).toBe("- n");
  });
});

describe("chordFromEvent", () => {
  const ev = (key: string, mods: Partial<Parameters<typeof chordFromEvent>[0]> = {}) => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  test.each([
    [ev("b", { ctrlKey: true }), "ctrl+b"],
    [ev("T", { shiftKey: true }), "shift+t"],
    [ev("?", { shiftKey: true }), "?"],
    [ev(" "), "space"],
    [ev("Escape"), "esc"],
    [ev("ArrowDown"), "down"],
    [ev("PageUp"), "pageup"],
    [ev("Tab", { shiftKey: true }), "shift+tab"],
    [ev("-"), "minus"],
  ])("a keydown %j is the chord %s", (e, text) => {
    expect(formatKey(made(chordFromEvent(e)))).toBe(text);
  });

  test.each(["Shift", "Control", "Alt", "Meta", "Dead", "Unidentified", "Process"])(
    "modifier-only or unusable key %s yields null",
    (key) => {
      expect(chordFromEvent(ev(key))).toBeNull();
    },
  );
});

// docs/specs/key-handling-batch.md § 3: a character typed with Option (macOS) or AltGr (Linux,
// Windows) is that character, as shift is folded for printable characters.
describe("chordFromEvent: Option and AltGr characters", () => {
  const ev = (
    key: string,
    code: string,
    {
      altGraph,
      ...mods
    }: {
      ctrlKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      metaKey?: boolean;
      altGraph?: boolean;
    } = {},
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
  const plain = (key: string, code: string, mods: object) => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  const text = (e: Parameters<typeof chordFromEvent>[0]) => formatKey(made(chordFromEvent(e)));

  test.each([
    // macOS sets AltGraph with every Option press (widget/cocoa nsCocoaUtils.mm), and altKey.
    [
      "Finnish Mac Option+shift+8",
      ev("{", "Digit8", { altKey: true, shiftKey: true, altGraph: true }),
      "{",
    ],
    ["Finnish Mac Option+8", ev("[", "Digit8", { altKey: true, altGraph: true }), "["],
    [
      "Finnish Mac Option+shift+7",
      ev("|", "Digit7", { altKey: true, shiftKey: true, altGraph: true }),
      "|",
    ],
    ["Finnish Mac Option+2", ev("@", "Digit2", { altKey: true, altGraph: true }), "@"],
    // Linux GTK: AltGr is ISO_Level3_Shift, AltGraph without altKey (nsGtkKeyUtils.cpp).
    ["Finnish PC AltGr+7", ev("{", "Digit7", { altGraph: true }), "{"],
    ["Finnish PC AltGr+4", ev("$", "Digit4", { altGraph: true }), "$"],
    ["AltGr+0 with alt reported too", ev("}", "Digit0", { altKey: true, altGraph: true }), "}"],
    // Windows: left ctrl + alt emulates AltGr and arrives as ctrl+alt, AltGraph false.
    ["Windows ctrl+alt as AltGr+7", ev("{", "Digit7", { ctrlKey: true, altKey: true }), "{"],
    ["Windows ctrl+alt as AltGr+4", ev("$", "Digit4", { ctrlKey: true, altKey: true }), "$"],
    ["Windows ctrl+alt as AltGr+Minus", ev("\\", "Minus", { ctrlKey: true, altKey: true }), "\\"],
    ["a composed letter (Option+a)", ev("å", "KeyA", { altKey: true, altGraph: true }), "å"],
    [
      "Mac Option+shift+8 without getModifierState",
      plain("{", "Digit8", { altKey: true, shiftKey: true }),
      "{",
    ],
  ])("%s is the bare character", (_name, e, want) => {
    expect(text(e)).toBe(want);
  });

  test.each([
    ["a real alt+1", ev("1", "Digit1", { altKey: true }), "alt+1"],
    ["alt+1 without getModifierState", plain("1", "Digit1", { altKey: true }), "alt+1"],
    [
      "alt alone, AltGraph up (Finnish Linux alt+plus)",
      ev("+", "Minus", { altKey: true }),
      "alt+plus",
    ],
    [
      "ctrl+alt+] on a US layout",
      ev("]", "BracketRight", { ctrlKey: true, altKey: true }),
      "ctrl+alt+]",
    ],
    [
      "ctrl+alt+shift+4 on a US layout",
      ev("$", "Digit4", { ctrlKey: true, altKey: true, shiftKey: true }),
      "ctrl+alt+$",
    ],
    ["ctrl+w", ev("w", "KeyW", { ctrlKey: true }), "ctrl+w"],
    ["ctrl+shift+t", ev("T", "KeyT", { ctrlKey: true, shiftKey: true }), "ctrl+shift+t"],
    ["ctrl+alt+j", ev("j", "KeyJ", { ctrlKey: true, altKey: true }), "ctrl+alt+j"],
    ["ctrl+[ (no alt)", ev("[", "BracketLeft", { ctrlKey: true }), "ctrl+["],
    [
      "ctrl with AltGraph keeps ctrl",
      ev("{", "Digit7", { ctrlKey: true, altGraph: true }),
      "ctrl+{",
    ],
    [
      "meta is never folded",
      ev("{", "Digit7", { metaKey: true, altKey: true, altGraph: true }),
      "alt+meta+{",
    ],
    [
      "a named key keeps alt",
      ev("ArrowLeft", "ArrowLeft", { altKey: true, altGraph: true }),
      "alt+left",
    ],
    [
      "Option with the key's own character",
      ev("1", "Digit1", { altKey: true, altGraph: true }),
      "alt+1",
    ],
  ])("%s keeps its modifiers", (_name, e, want) => {
    expect(text(e)).toBe(want);
  });
});

// The messages are what a config error shows (keymap.mjs wraps them with the config path).
describe("key notation errors", () => {
  test("KeyNotationError is named as such", () => {
    expect(new KeyNotationError("x").name).toBe("KeyNotationError");
  });

  test.each([
    ["", "empty key"],
    ["ctrl+", 'missing key in "ctrl+"'],
    ["+b", 'unknown modifier "" in "+b"'],
    ["+ctrl++", 'unknown modifier "" in "+ctrl++"'],
    ["hyper+k", 'unknown modifier "hyper" in "hyper+k"'],
    ["ctrl+Control+k", 'modifier "Control" repeated in "ctrl+Control+k"'],
    ["ctrl+foo", 'unknown key "foo" in "ctrl+foo"'],
  ])("parseKey(%j) says %s", (text, message) => {
    expect(() => parseKey(text)).toThrow(new KeyNotationError(message));
  });

  test.each([
    ["", "empty binding"],
    [" \t ", "empty binding"],
    ["prefix", '"prefix" needs a key: prefix+c'],
    ["g<leader", 'unclosed "<" in "g<leader"'],
    ["g<Foo>x", 'unknown key "<Foo>"'],
    ["<C-C-x>", 'unknown key "<C-C-x>"'],
    ["<Q-x>", 'unknown key "<Q-x>"'],
    ["<C->", 'unknown key "<C->"'],
  ])("parseBinding(%j) says %s", (text, message) => {
    expect(() => parseBinding(text)).toThrow(new KeyNotationError(message));
  });
});

describe("the + key", () => {
  test.each([
    ["+", chord("+")],
    ["++", chord("+")],
    ["ctrl++", chord("+", { ctrl: true })],
    ["ctrl+alt++", chord("+", { ctrl: true, alt: true })],
    [" ", chord("space")],
  ])("parseKey(%j) is the chord it names", (text, expected) => {
    expect(parseKey(text)).toEqual(expected);
  });

  test("ctrl+- in Vim notation is <C-->", () => {
    expect(parseBinding("<C-->")).toEqual([chord("-", { ctrl: true })]);
  });

  test("a bare plus shows as the character, and ctrl with it as ctrl+plus", () => {
    const keys = { prefix: parseKey("ctrl+b"), leader: parseKey("space") };
    expect(displayBinding("prefix+plus", keys)).toBe("ctrl+b +");
    expect(displayBinding("ctrl++", keys)).toBe("ctrl+plus");
  });
});

describe("formatKey of non-canonical chords", () => {
  test("shift on a character that carries it is dropped, and a capital is shift+letter", () => {
    expect(formatKey(chord("?", { shift: true }))).toBe("?");
    expect(formatKey(chord("T"))).toBe("shift+t");
  });

  test("a key it cannot name is written as given", () => {
    expect(formatKey(chord("nokey", { ctrl: true }))).toBe("ctrl+nokey");
  });
});

describe("formatBinding of bare specials", () => {
  test("a prefix with no chord after it stays a word of its own", () => {
    expect(formatBinding([{ special: "prefix" }])).toBe("prefix");
    expect(formatBinding([{ special: "prefix" }, { special: "leader" }, chord("x")])).toBe(
      "prefix <leader> x",
    );
  });
});

describe("displayBinding: runs and angle tokens", () => {
  const keys = { prefix: parseKey("ctrl+b"), leader: parseKey("space") };

  test("plain characters before an angle token stay a run of their own", () => {
    expect(displayBinding("g<C-w>", keys)).toBe("g ctrl+w");
    expect(displayBinding("gg<leader>x", keys)).toBe("gg space x");
  });

  test("a > that closes no < is a plain character", () => {
    expect(displayBinding("a>b", keys)).toBe("a>b");
  });

  test("an unknown angle token is a notation error", () => {
    expect(() => displayBinding("g<Foo>", keys)).toThrow(
      new KeyNotationError('unknown key "<Foo>"'),
    );
  });
});

describe("chordFromEvent: events without a code", () => {
  // A synthesized event (a test harness, an extension) may carry no `code`: only letters and
  // digits count as the key's own character.
  const synthetic = (key: string, mods: object) => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  test("alt with a letter or digit is a real alt chord", () => {
    expect(formatKey(made(chordFromEvent(synthetic("a", { altKey: true }))))).toBe("alt+a");
    expect(formatKey(made(chordFromEvent(synthetic("7", { altKey: true }))))).toBe("alt+7");
  });

  test("alt with any other character is a composed character", () => {
    expect(formatKey(made(chordFromEvent(synthetic("@", { altKey: true }))))).toBe("@");
    const altGraph = { getModifierState: (m: string) => m === "AltGraph" };
    expect(formatKey(made(chordFromEvent(synthetic("@", altGraph))))).toBe("@");
  });
});

describe("chordFromEvent: space is never a composed character", () => {
  test("ctrl+alt+space keeps its modifiers", () => {
    const e = {
      key: " ",
      code: "Space",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      getModifierState: () => false,
    };
    expect(formatKey(made(chordFromEvent(e)))).toBe("ctrl+alt+space");
  });
});
