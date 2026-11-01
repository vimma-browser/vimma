import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { findCountText, findStatusText, isCaseSensitive } from "../src/find.mjs";
import { statusSegments } from "../src/statusbar.mjs";

describe("smartcase", () => {
  test.each([
    ["word", false],
    ["Word", true],
    ["wORD", true],
    ["", false],
    ["123 -", false],
    ["straße", false],
    ["Ärger", true],
    ["ÉTÉ", true],
  ])("%j is case-sensitive: %s", (query, sensitive) => {
    expect(isCaseSensitive(query)).toBe(sensitive);
  });

  test("a lower-cased query is never case-sensitive", () => {
    fc.assert(fc.property(fc.string(), (s) => !isCaseSensitive(s.toLowerCase())));
  });
});

describe("find status text", () => {
  test("query with position and count, / or ? as typed", () => {
    expect(findStatusText({ query: "word", backward: false, current: 2, total: 5 })).toBe(
      "/word [2/5]",
    );
    expect(findStatusText({ query: "word", backward: true, current: 1, total: 3 })).toBe(
      "?word [1/3]",
    );
  });

  test("count unknown yet: query only", () => {
    expect(findStatusText({ query: "w", backward: false })).toBe("/w");
  });

  test("count over the finder's limit", () => {
    expect(
      findStatusText({ query: "e", backward: false, current: 0, total: -1, limit: 1000 }),
    ).toBe("/e [>1000]");
  });

  test("not found", () => {
    expect(findStatusText({ query: "zzz", backward: false, notFound: true })).toBe(
      "/zzz not found",
    );
  });
});

describe("find bar count", () => {
  test("position and count in brackets, as the status bar shows them", () => {
    expect(findCountText({ current: 2, total: 5 })).toBe("[2/5]");
  });

  test("over the finder's limit", () => {
    expect(findCountText({ current: 0, total: -1, limit: 1000 })).toBe("[>1000]");
  });

  test("nothing while the count is unknown or zero", () => {
    expect(findCountText({})).toBe("");
    expect(findCountText({ current: 0, total: 0 })).toBe("");
    expect(findCountText({ total: -1 })).toBe("");
  });
});

describe("status bar find segment", () => {
  test("absent without a find", () => {
    expect(statusSegments({ mode: "normal" }).map((s) => s.id)).toEqual(["mode"]);
  });

  test("on the right, before the URL; error colour when not found", () => {
    const segs = statusSegments({
      mode: "normal",
      tab: { index: 1, count: 1, title: "t", url: "https://example.com/" },
      find: { query: "word", backward: false, current: 2, total: 5 },
    });
    expect(segs.map((s) => [s.id, s.side])).toEqual([
      ["mode", "left"],
      ["tab", "left"],
      ["title", "left"],
      ["find", "right"],
      ["url", "right"],
    ]);
    expect(segs.find((s) => s.id === "find")).toMatchObject({
      text: "/word [2/5]",
      fg: "--vimma-fg-bright",
    });
    const nf = statusSegments({ mode: "normal", find: { query: "x", notFound: true } });
    expect(nf.find((s) => s.id === "find")).toMatchObject({
      text: "/x not found",
      fg: "--vimma-text-error",
    });
  });
});
