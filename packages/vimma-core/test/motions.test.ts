import { describe, test, expect } from "vitest";
import {
  BLOCK,
  textMotion,
  findChar,
  repeatFind,
  wordObject,
  firstNonBlank,
  isFindKind,
} from "../src/page/motions.mjs";

/** @import { FindKind } from "../src/page/motions.mjs" */

// Caret positions are between characters: 0 is before the first, text.length after the last.
// Spec: docs/specs/m1-copy-mode.md § Settled (motions).

const T = "alpha beta.gamma  delta";
//         0    5    10   15   20

describe("e: end of word", () => {
  test.each([
    [0, 5], // inside alpha → after alpha
    [5, 10], // at the end of alpha → after beta
    [10, 11], // before "." → after "." (punctuation is its own word)
    [11, 16], // → after gamma
    [16, 23], // across two spaces → after delta
  ])("from %i lands at %i", (from, to) => {
    expect(textMotion(T, from, "word_end")).toBe(to);
  });

  test("a count repeats it", () => {
    expect(textMotion(T, 0, "word_end", 3)).toBe(11);
  });

  test("at the last word end it stays (null: no move)", () => {
    expect(textMotion(T, 23, "word_end")).toBe(null);
  });

  test("crosses a block boundary as whitespace", () => {
    const t = `one${BLOCK}two`;
    expect(textMotion(t, 3, "word_end")).toBe(7);
  });

  test("letters with marks and digits are word characters", () => {
    expect(textMotion("päivä2_x y", 0, "word_end")).toBe(8);
  });
});

describe("ge: end of the previous word", () => {
  test.each([
    [8, 5], // inside beta → after alpha
    [10, 5], // after beta → after alpha
    [16, 11], // after gamma → after "."
    [23, 16], // after delta → after gamma
  ])("from %i lands at %i", (from, to) => {
    expect(textMotion(T, from, "word_end_backward")).toBe(to);
  });

  test("before the first word end: null", () => {
    expect(textMotion(T, 3, "word_end_backward")).toBe(null);
  });
});

describe("WORD motions (delimited by whitespace)", () => {
  test.each([
    [0, 6, "bigword_forward"], // → before beta.gamma
    [6, 18, "bigword_forward"], // past beta.gamma and two spaces → before delta
    [18, 6, "bigword_backward"],
    [20, 18, "bigword_backward"], // inside delta → its start
    [6, 0, "bigword_backward"],
    [0, 5, "bigword_end"],
    [5, 16, "bigword_end"], // beta.gamma is one WORD
  ])("from %i lands at %i (%s)", (from, to, motion) => {
    expect(textMotion(T, from, motion)).toBe(to);
  });

  test("W at the last WORD: null", () => {
    expect(textMotion(T, 20, "bigword_forward")).toBe(null);
  });

  test("an unknown motion throws", () => {
    expect(() => textMotion(T, 0, "nope")).toThrow(/unknown/);
  });
});

describe("^: first non-blank", () => {
  test("skips spaces and tabs from the line start", () => {
    expect(firstNonBlank("  \tfoo", 0)).toBe(3);
  });
  test("a blank line stays at its start", () => {
    expect(firstNonBlank(`   \nx`, 0)).toBe(0);
    expect(firstNonBlank(`  ${BLOCK}x`, 0)).toBe(0);
  });
  test("already on a non-blank", () => {
    expect(firstNonBlank("foo", 0)).toBe(0);
  });
});

describe("f / F / t / T: find a character on the line", () => {
  const L = "a.b.c\nd.e";
  //         01234 5678
  /** @type {Array<[FindKind, number, number]>} */
  const findChars = [
    ["f", 0, 2], // after the first "."
    ["f", 2, 4], // repeated from there: the next one
    ["t", 0, 1], // before the first "."
    ["t", 1, 3], // t again from before "." moves on to the next
    ["F", 5, 3], // before the last "." on the line
    ["F", 3, 1],
    ["T", 5, 4], // after the last "."
    ["T", 4, 2],
  ];
  test.each(findChars)("%s from %i lands at %i", (kind, from, to) => {
    expect(findChar(L, from, { kind, char: "." })).toBe(to);
  });

  test("does not cross a line break or a block", () => {
    expect(findChar(L, 4, { kind: "f", char: "." })).toBe(null);
    expect(findChar(L, 6, { kind: "F", char: "." })).toBe(null);
    expect(findChar(`a${BLOCK}.`, 0, { kind: "f", char: "." })).toBe(null);
  });

  test("a count finds the Nth", () => {
    expect(findChar(L, 0, { kind: "f", char: "." }, 2)).toBe(4);
    expect(findChar(L, 0, { kind: "f", char: "." }, 3)).toBe(null);
  });

  test("a character outside the BMP", () => {
    expect(findChar("a😀b", 0, { kind: "f", char: "😀" })).toBe(3);
  });

  test("kinds", () => {
    expect(["f", "F", "t", "T"].every(isFindKind)).toBe(true);
    expect(isFindKind("x")).toBe(false);
  });
});

describe("; and , repeat the last find", () => {
  test("; repeats in the same direction", () => {
    expect(repeatFind({ kind: "t", char: "x" }, false)).toEqual({ kind: "t", char: "x" });
  });
  test(", reverses it", () => {
    expect(repeatFind({ kind: "f", char: "x" }, true)).toEqual({ kind: "F", char: "x" });
    expect(repeatFind({ kind: "F", char: "x" }, true)).toEqual({ kind: "f", char: "x" });
    expect(repeatFind({ kind: "t", char: "x" }, true)).toEqual({ kind: "T", char: "x" });
    expect(repeatFind({ kind: "T", char: "x" }, true)).toEqual({ kind: "t", char: "x" });
  });
  test("nothing to repeat", () => {
    expect(repeatFind(null, false)).toBe(null);
  });
});

describe("iw / aw: a word as a text object", () => {
  test.each([
    [2, false, [0, 5]], // inside alpha
    [0, false, [0, 5]],
    [2, true, [0, 6]], // alpha and the space after it
    [5, false, [5, 6]], // on the space: the blank run
    [5, true, [5, 10]], // the space and beta
    [10, false, [10, 11]], // the "."
    [22, true, [16, 23]], // delta, last: no trailing blank, takes the leading ones
  ])("at %i, around=%s → %j", (at, around, range) => {
    expect(wordObject(T, at, around)).toEqual(range);
  });

  test("after the last character it takes the word before", () => {
    expect(wordObject(T, 23, false)).toEqual([18, 23]);
  });

  test("does not cross a line break", () => {
    expect(wordObject("ab\ncd", 2, false)).toEqual([0, 2]);
    expect(wordObject("ab  \ncd", 0, true)).toEqual([0, 4]);
  });

  test("empty text: null", () => {
    expect(wordObject("", 0, false)).toBe(null);
  });
});
