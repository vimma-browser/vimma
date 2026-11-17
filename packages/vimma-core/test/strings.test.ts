// The linear-time string edits of text/strings.mjs, case by case. test/fuzz/strings.fuzz.test.ts
// checks them against the regular expressions they replaced, but Stryker's suite leaves the fuzz
// properties out (vitest.config.mjs), so these examples are what kills their mutants (#1119).
import { describe, expect, test } from "vitest";
import { deleteWordBackward, hasControl, trimBlanks, trimTrailing } from "../src/text/strings.mjs";

describe("trimBlanks", () => {
  test("drops leading and trailing spaces and tabs, keeps inner ones", () => {
    expect(trimBlanks(" \t a \t b\t ")).toBe("a \t b");
    expect(trimBlanks("ab")).toBe("ab");
    expect(trimBlanks("")).toBe("");
  });

  test("a string of only blanks becomes empty", () => {
    expect(trimBlanks(" \t \t")).toBe("");
  });

  test("only a space or a tab is a blank: line breaks and other spaces stay", () => {
    expect(trimBlanks("\na\n")).toBe("\na\n");
    expect(trimBlanks("\u00A0a\u3000")).toBe("\u00A0a\u3000");
    expect(trimBlanks("\ra\v")).toBe("\ra\v");
  });

  test("each side is trimmed on its own", () => {
    expect(trimBlanks("  a")).toBe("a");
    expect(trimBlanks("a\t\t")).toBe("a");
    expect(trimBlanks("\ta")).toBe("a");
    expect(trimBlanks("a ")).toBe("a");
  });
});

describe("trimTrailing", () => {
  test("drops the whole trailing run of the character and nothing else", () => {
    expect(trimTrailing("/home/user///", "/")).toBe("/home/user");
    expect(trimTrailing("//a/b", "/")).toBe("//a/b");
    expect(trimTrailing("a/b/", "/")).toBe("a/b");
  });

  test("a string of only that character becomes empty; an empty one stays empty", () => {
    expect(trimTrailing("///", "/")).toBe("");
    expect(trimTrailing("", "/")).toBe("");
  });

  test("another character ends the run", () => {
    expect(trimTrailing("a//b", "/")).toBe("a//b");
    expect(trimTrailing("ab  ", "/")).toBe("ab  ");
    expect(trimTrailing("ab  ", " ")).toBe("ab");
  });
});

describe("deleteWordBackward", () => {
  test("drops the trailing whitespace and the word before it", () => {
    expect(deleteWordBackward("open foo bar  ")).toBe("open foo ");
    expect(deleteWordBackward("open foo")).toBe("open ");
    expect(deleteWordBackward("a\tb\n")).toBe("a\t");
  });

  test("a single word, or only whitespace, goes entirely", () => {
    expect(deleteWordBackward("word")).toBe("");
    expect(deleteWordBackward("word  ")).toBe("");
    expect(deleteWordBackward("   ")).toBe("");
    expect(deleteWordBackward("")).toBe("");
  });

  test("any whitespace separates words, punctuation does not", () => {
    expect(deleteWordBackward("a\u3000b")).toBe("a\u3000");
    expect(deleteWordBackward("a\u00A0b")).toBe("a\u00A0");
    expect(deleteWordBackward("x foo.bar/baz")).toBe("x ");
  });
});

describe("hasControl", () => {
  test("finds a C0 control character anywhere, tab and line feed included", () => {
    for (const c of ["\x00", "\x01", "\t", "\n", "\r", "\x1b", "\x1f"]) {
      expect(hasControl(c), JSON.stringify(c)).toBe(true);
      expect(hasControl(`ab${c}`), JSON.stringify(c)).toBe(true);
      expect(hasControl(`${c}ab`), JSON.stringify(c)).toBe(true);
    }
  });

  test("finds DEL", () => {
    expect(hasControl("\x7f")).toBe(true);
    expect(hasControl("model\x7f")).toBe(true);
  });

  test("a space, printable ASCII, C1 and other characters are not control characters", () => {
    expect(hasControl("")).toBe(false);
    expect(hasControl(" ")).toBe(false);
    expect(hasControl("claude-opus ~/x")).toBe(false);
    expect(hasControl("\x7e\x80\x9f\u00A0é漢😀")).toBe(false);
  });
});
