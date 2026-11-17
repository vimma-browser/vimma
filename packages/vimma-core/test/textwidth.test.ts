// Columns of text as a terminal lays it out (text/textwidth.mjs): grapheme clusters, the generated
// East Asian Wide table at every one of its edges, and the zero-width, emoji and flag rules
// (mutation testing, #1119).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { clusterWidth, graphemes, textWidth } from "../src/text/textwidth.mjs";

/**
 * The [first, last] pairs of the module's generated WIDE table, read from its source: the array
 * literal that starts at its first pair, so that it is still found in Stryker's instrumented copy,
 * which wraps the declaration.
 */
function wideRanges(): [number, number][] {
  const src = readFileSync(new URL("../src/text/textwidth.mjs", import.meta.url), "utf8");
  const body = /\[\s*(0x1100,[^\]]*)\]/.exec(src)?.[1] ?? "";
  const nums = body.match(/0x[0-9a-f]+/gi)?.map(Number) ?? [];
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([nums[i]!, nums[i + 1]!]);
  return pairs;
}

describe("graphemes", () => {
  test("splits into clusters with their UTF-16 offsets", () => {
    expect(graphemes("ae\u0301😀b")).toEqual([
      { segment: "a", index: 0 },
      { segment: "e\u0301", index: 1 },
      { segment: "😀", index: 3 },
      { segment: "b", index: 5 },
    ]);
    expect(graphemes("")).toEqual([]);
  });

  test("keeps a flag, a ZWJ sequence and a keycap whole", () => {
    expect(graphemes("🇫🇮👩\u200D💻1\uFE0F\u20E3").map((g) => g.segment)).toEqual([
      "🇫🇮",
      "👩\u200D💻",
      "1\uFE0F\u20E3",
    ]);
  });

  test("a second call reuses the segmenter and gives the same result", () => {
    expect(graphemes("ab")).toEqual(graphemes("ab"));
    expect(graphemes("xy").map((g) => g.index)).toEqual([0, 1]);
  });
});

describe("clusterWidth", () => {
  test("an empty cluster has no width", () => {
    expect(clusterWidth("")).toBe(0);
  });

  test("clusters of only controls, format characters and marks have no width", () => {
    for (const c of ["\x07", "\x7f", "\u200D", "\u200B", "\u0301", "\u0301\u0302", "\u20DD"])
      expect(clusterWidth(c), JSON.stringify(c)).toBe(0);
  });

  test("a mark after or before a base character does not make it zero-width", () => {
    expect(clusterWidth("e\u0301")).toBe(1);
    expect(clusterWidth("\u0301e")).toBe(1);
    expect(clusterWidth("漢\u0301")).toBe(2);
  });

  test("narrow and ambiguous characters take one column", () => {
    for (const c of ["a", "é", "●", "…", "\u00A0", "ab"])
      expect(clusterWidth(c), JSON.stringify(c)).toBe(1);
  });

  test("wide and fullwidth characters and wide emoji take two", () => {
    for (const c of ["漢", "あ", "한", "Ａ", "😀", "\u3000", "\u{20000}"])
      expect(clusterWidth(c), JSON.stringify(c)).toBe(2);
  });

  test("the emoji presentation selector makes a narrow character two columns", () => {
    expect(clusterWidth("\u2764")).toBe(1);
    expect(clusterWidth("\u2764\uFE0F")).toBe(2);
    expect(clusterWidth("1\uFE0F\u20E3")).toBe(2);
  });

  test("a flag (two regional indicators) takes two columns, one indicator one", () => {
    expect(clusterWidth("🇫🇮")).toBe(2);
    expect(clusterWidth("🇫")).toBe(1);
  });

  test("every edge of the generated wide table", () => {
    const ranges = wideRanges();
    expect(ranges.length).toBeGreaterThan(100);
    const inTable = (cp: number) => ranges.some(([a, b]) => a <= cp && cp <= b);
    const zero = /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]+$/u;
    const expected = (cp: number) => {
      const s = String.fromCodePoint(cp);
      if (zero.test(s)) return 0;
      if (s === "\uFE0F") return 2;
      return inTable(cp) ? 2 : 1;
    };
    const points = new Set<number>([0x20, 0xffff, 0x10000, 0x10ffff]);
    for (const [a, b] of ranges) {
      for (const cp of [a - 1, a, a + 1, (a + b) >> 1, b - 1, b, b + 1])
        if (cp >= 0x20 && cp <= 0x10ffff) points.add(cp);
    }
    const wrong = [...points]
      .filter((cp) => clusterWidth(String.fromCodePoint(cp)) !== expected(cp))
      .map((cp) => cp.toString(16));
    expect(wrong).toEqual([]);
  });

  test("the table's first and last ranges, pinned by hand", () => {
    expect(clusterWidth("\u10FF")).toBe(1);
    expect(clusterWidth("\u1100")).toBe(2);
    expect(clusterWidth("\u115F")).toBe(2);
    expect(clusterWidth("\u{2fffd}")).toBe(2);
    expect(clusterWidth("\u{2fffe}")).toBe(1);
    expect(clusterWidth("\u{30000}")).toBe(2);
    expect(clusterWidth("\u{3fffd}")).toBe(2);
    expect(clusterWidth("\u{3fffe}")).toBe(1);
  });
});

describe("textWidth", () => {
  test("sums the columns of each cluster", () => {
    expect(textWidth("")).toBe(0);
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("a漢b")).toBe(4);
    expect(textWidth("e\u0301🇫🇮\u200D")).toBe(3);
    expect(textWidth("👩\u200D💻 ok")).toBe(5);
  });
});
