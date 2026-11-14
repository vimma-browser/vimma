import { describe, test, expect } from "vitest";
import {
  PDF_SCROLL,
  PDF_SPREAD,
  isPdfMarkChar,
  parsePdfOp,
  parsePdfPosition,
  parsePdfState,
  pdfDocumentKey,
  pdfDrawn,
  pdfPageText,
  pdfPageTarget,
  pdfRotation,
  pdfScrollMode,
  pdfSpread,
  pdfZoomPercent,
  pdfZoomStep,
  stripInvisible,
} from "../src/page/pdf.mjs";

// docs/specs/pdf-mode.md, docs/security.md section 18 (V6).
// `doc` counts the documents pdf.js has opened in this viewer (V11).
// `drawn`, `ops`, `width` and `height` say what the viewer had drawn when it reported (#1006).
const good = {
  page: 3,
  pages: 12,
  label: "",
  find: { current: 0, total: 0 },
  doc: 1,
  drawn: true,
  ops: 0,
  width: 1040,
  height: 700,
};

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
      ["no document count", { ...good, doc: undefined }],
      ["a document count that is not a count", { ...good, doc: -1 }],
      ["a document count as a string", { ...good, doc: "1" }],
    ])("%s", (_name, raw) => {
      expect(parsePdfState(raw)).toBeNull();
    });
  });

  // The fields only `state.pdf` reads (#1006) can never take away the page state PDF mode
  // needs (the status bar's page, find, the outline, marks, `F`): unusable ones only make the
  // report not drawn.
  describe("a report whose drawing fields are unusable keeps its page and is not drawn", () => {
    test.each([
      ["no drawn flag", { ...good, drawn: undefined }],
      ["a drawn flag that is not a boolean", { ...good, drawn: 1 }],
      ["no count of operations", { ...good, ops: undefined }],
      ["a count of operations that is not a count", { ...good, ops: -1 }],
      ["a fractional width", { ...good, width: 1040.5 }],
      ["a width beyond any screen", { ...good, width: 1e9 }],
      ["no height", { ...good, height: undefined }],
      ["none of them", { page: 3, pages: 12, label: "", find: { current: 0, total: 0 }, doc: 1 }],
    ])("%s", (_name, raw) => {
      const s = parsePdfState(raw);
      expect(s).toMatchObject({ page: 3, pages: 12, label: "", doc: 1, drawn: false });
      expect(pdfDrawn(s, { sent: 0, width: 1040, height: 700 })).toBe(false);
    });
  });

  test("a page label cannot carry bidi or zero-width characters", () => {
    const s = parsePdfState({ ...good, label: "i\u202Ev\u200B\u0007" });
    expect(s?.label).toBe("iv");
    expect(stripInvisible("a\u2066b\u2069c\uFEFF")).toBe("abc");
    expect(stripInvisible("i v\u2028x\u2029\u3000")).toBe("i vx");
  });
});

// `state.pdf` (#1006): the viewer's last report says every page in view was drawn, it came after
// every operation Vimma sent it, and the viewer then had the size its tab has now.
describe("pdfDrawn", () => {
  const now = { sent: 2, width: 1040, height: 700 };
  test("drawn once the report answers every operation sent, at the tab's size", () => {
    expect(pdfDrawn({ ...good, ops: 2 }, now)).toBe(true);
    expect(pdfDrawn({ ...good, ops: 3 }, now)).toBe(true);
  });
  test.each([
    ["no report yet", null],
    ["a page in view still to draw", { ...good, ops: 2, drawn: false }],
    ["an operation sent after the report", { ...good, ops: 1 }],
    ["a report from before the tab was resized", { ...good, ops: 2, width: 1280 }],
    ["a report from before the tab grew taller", { ...good, ops: 2, height: 760 }],
  ])("not drawn: %s", (_name, s) => {
    expect(pdfDrawn(s, now)).toBe(false);
  });
  test("a size within a pixel's rounding is the same size", () => {
    expect(pdfDrawn({ ...good, ops: 2, width: 1041, height: 699 }, now)).toBe(true);
  });
});

describe("pdfPageText", () => {
  test("page 3/12, or the label when it is not the number", () => {
    expect(pdfPageText(good)).toBe("page 3/12");
    expect(pdfPageText({ ...good, label: "3" })).toBe("page 3/12");
    expect(pdfPageText({ ...good, page: 4, pages: 120, label: "iv" })).toBe("page iv (4/120)");
  });
});

// Delivery PR 3: zathura's page, zoom and layout keys (decisions 6 to 8; security.md V7).
describe("pdfPageTarget", () => {
  /**
   * @param {Parameters<typeof pdfPageTarget>[0]} op
   * @param {number} count
   */
  const at = (op, count, page = 3, pages = 12) => pdfPageTarget(op, count, page, pages);
  test("G and gg go to the last and first page, with a count to that page", () => {
    expect(at("last", 0)).toBe(12);
    expect(at("first", 0)).toBe(1);
    expect(at("last", 5)).toBe(5);
    expect(at("first", 5)).toBe(5);
  });
  test("a count past the last page goes to the last page", () => {
    expect(at("last", 99)).toBe(12);
    expect(at("first", 99)).toBe(12);
  });
  test("J and K step by the count, stopping at the ends", () => {
    expect(at("next", 0)).toBe(4);
    expect(at("next", 3, 11)).toBe(12);
    expect(at("prev", 2)).toBe(1);
    expect(at("prev", 0, 1)).toBe(1);
  });
});

describe("pdf zoom", () => {
  test("steps by pdf.js's 10 % with its rounding, a count of steps at once", () => {
    expect(pdfZoomStep(1, 1)).toBe(1.1);
    expect(pdfZoomStep(1, -1)).toBe(0.9);
    expect(pdfZoomStep(1, 2)).toBe(1.3);
  });
  test("clamps to pdf.js's 10 % to 2500 %", () => {
    expect(pdfZoomStep(24, 5)).toBe(25);
    expect(pdfZoomStep(0.1, -3)).toBe(0.1);
  });
  test("= sets 100 %, 150= sets 150 %, clamped", () => {
    expect(pdfZoomPercent(0)).toBe(1);
    expect(pdfZoomPercent(150)).toBe(1.5);
    expect(pdfZoomPercent(9999)).toBe(25);
  });
});

describe("pdf layout", () => {
  const { NONE, ODD, EVEN } = PDF_SPREAD;
  test("d toggles one page and the last spread, the first page alone the first time", () => {
    expect(pdfSpread("dual", NONE, EVEN)).toEqual({ mode: EVEN, last: EVEN });
    expect(pdfSpread("dual", EVEN, EVEN)).toEqual({ mode: NONE, last: EVEN });
    expect(pdfSpread("dual", ODD, EVEN)).toEqual({ mode: NONE, last: ODD });
    expect(pdfSpread("dual", NONE, ODD)).toEqual({ mode: ODD, last: ODD });
  });
  test("D toggles whether the first page stands alone, showing two pages", () => {
    expect(pdfSpread("first_alone", EVEN, EVEN)).toEqual({ mode: ODD, last: ODD });
    expect(pdfSpread("first_alone", ODD, ODD)).toEqual({ mode: EVEN, last: EVEN });
    expect(pdfSpread("first_alone", NONE, EVEN)).toEqual({ mode: ODD, last: ODD });
  });
  test("w toggles one page at a time and the previous scroll mode", () => {
    const { VERTICAL, WRAPPED, PAGE } = PDF_SCROLL;
    expect(pdfScrollMode(VERTICAL, VERTICAL)).toEqual({ mode: PAGE, previous: VERTICAL });
    expect(pdfScrollMode(PAGE, WRAPPED)).toEqual({ mode: WRAPPED, previous: PAGE });
    expect(pdfScrollMode(PAGE, PAGE)).toEqual({ mode: VERTICAL, previous: PAGE });
  });
  test("r rotates 90 degrees clockwise per count", () => {
    expect(pdfRotation(0, 0)).toBe(90);
    expect(pdfRotation(270, 1)).toBe(0);
    expect(pdfRotation(0, 6)).toBe(180);
  });
});

describe("the parent sends only operations and numbers", () => {
  test("a known operation with a bounded integer passes", () => {
    expect(parsePdfOp({ op: "next", n: 3 })).toEqual({ op: "next", n: 3 });
    expect(parsePdfOp({ op: "zoom", n: -2 })).toEqual({ op: "zoom", n: -2 });
  });
  test.each([
    ["no message", null],
    ["an unknown operation", { op: "eval", n: 0 }],
    ["a prototype name", { op: "constructor", n: 0 }],
    ["text for a number", { op: "next", n: "3" }],
    ["a fraction", { op: "next", n: 1.5 }],
    ["a huge number", { op: "next", n: 1e9 }],
    ["an extra field", { op: "next", n: 1, css: "x" }],
  ])("%s is dropped", (_, raw) => {
    expect(parsePdfOp(raw)).toBeNull();
  });
});

// Delivery PR 5: marks (decision 11). A mark is a position the parent keeps; going back to it
// sends the viewer that position's four numbers (V7).
describe("pdf marks", () => {
  const at = { page: 3, left: 12.5, top: 700, scale: 1.25 };
  test("a letter or a digit names a mark", () => {
    for (const c of ["a", "Z", "0", "9"]) expect(isPdfMarkChar(c)).toBe(true);
    for (const c of ["", "ab", "'", " ", "<Esc>", "ä", undefined]) {
      expect(isPdfMarkChar(/** @type {any} */ (c))).toBe(false);
    }
  });
  test("marks are kept per document, without the fragment", () => {
    expect(pdfDocumentKey("https://a.example/x.pdf#page=3")).toBe("https://a.example/x.pdf");
    expect(pdfDocumentKey("https://a.example/x.pdf?v=1")).toBe("https://a.example/x.pdf?v=1");
    expect(pdfDocumentKey("not a url")).toBeNull();
  });
  test("a position in bounds passes", () => {
    expect(parsePdfPosition(at)).toEqual(at);
    expect(parsePdfPosition({ ...at, left: -40 })).toEqual({ ...at, left: -40 });
  });
  test.each([
    ["no record", null],
    ["page 0", { ...at, page: 0 }],
    ["a fractional page", { ...at, page: 1.5 }],
    ["text for a number", { ...at, top: "700" }],
    ["an infinite offset", { ...at, left: Infinity }],
    ["a huge offset", { ...at, top: 1e9 }],
    ["a scale past pdf.js's limit", { ...at, scale: 30 }],
    ["a missing field", { page: 3, left: 0, top: 0 }],
    ["an extra field", { ...at, css: "x" }],
  ])("%s is dropped", (_, raw) => {
    expect(parsePdfPosition(raw)).toBeNull();
  });
  test("going to a mark sends its position and nothing else", () => {
    expect(parsePdfOp({ op: "go", n: 0, at })).toEqual({ op: "go", n: 0, at });
    expect(parsePdfOp({ op: "go", n: 0 })).toBeNull();
    expect(parsePdfOp({ op: "go", n: 0, at: { ...at, page: -1 } })).toBeNull();
    expect(parsePdfOp({ op: "next", n: 0, at })).toBeNull();
  });
});
