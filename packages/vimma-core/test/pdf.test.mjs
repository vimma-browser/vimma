import { describe, test, expect } from "vitest";
import { parsePdfState, pdfPageText, stripInvisible } from "../src/pdf.mjs";

// docs/specs/pdf-mode.md, docs/security.md section 18 (V6).
const good = { page: 3, pages: 12, label: "", find: { current: 0, total: 0 } };

describe("parsePdfState", () => {
  test("accepts a full record", () => {
    expect(parsePdfState(good)).toEqual(good);
    expect(parsePdfState({ ...good, label: "iv", find: { current: 2, total: 41 } })).toEqual({
      ...good,
      label: "iv",
      find: { current: 2, total: 41 },
    });
  });

  describe("pdf state outside its bounds is dropped", () => {
    test.each([
      ["no record", null],
      ["a string", "page 3"],
      ["a page past the count", { ...good, page: 13 }],
      ["page 0", { ...good, page: 0 }],
      ["a fractional page", { ...good, page: 2.5 }],
      ["no pages", { ...good, pages: 0, page: 0 }],
      ["a page count beyond any document", { ...good, pages: 1e9 }],
      ["a page as a string", { ...good, page: "3" }],
      ["NaN", { ...good, page: NaN }],
      ["a label over 32 characters", { ...good, label: "x".repeat(33) }],
      ["a label that is not a string", { ...good, label: 4 }],
      ["no find count", { ...good, find: undefined }],
      ["a match past the total", { ...good, find: { current: 5, total: 4 } }],
      ["a negative total", { ...good, find: { current: 0, total: -2 } }],
    ])("%s", (_name, raw) => {
      expect(parsePdfState(raw)).toBeNull();
    });
  });

  test("a page label cannot carry bidi or zero-width characters", () => {
    const s = parsePdfState({ ...good, label: "i‮v​\u0007" });
    expect(s?.label).toBe("iv");
    expect(stripInvisible("a⁦b⁩c﻿")).toBe("abc");
  });
});

describe("pdfPageText", () => {
  test("page 3/12, or the label when it is not the number", () => {
    expect(pdfPageText(good)).toBe("page 3/12");
    expect(pdfPageText({ ...good, label: "3" })).toBe("page 3/12");
    expect(pdfPageText({ ...good, page: 4, pages: 120, label: "iv" })).toBe("page iv (4/120)");
  });
});
