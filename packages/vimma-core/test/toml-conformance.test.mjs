// Conformance cases for the vendored smol-toml (TOML 1.0, spec examples from https://toml.io).
// We own the vendored copy (ADR-008), so we test it like our own code: one valid and one invalid
// document per feature, in the spirit of toml-lang/toml-test.
import { describe, test, expect } from "vitest";
import { parseToml } from "../src/toml.mjs";

/** @param {string} text */
const value = (text) => {
  const r = parseToml(text);
  if (!r.ok) throw new Error(`unexpected TOML error: ${r.error.message} at ${r.error.line}`);
  return r.value;
};

describe("valid TOML 1.0", () => {
  test.each([
    // strings
    ['s = "a\\tb\\n\\"q\\" \\\\ \\u00e9 \\U0001F600 \\b\\f\\r"', { s: 'a\tb\n"q" \\ é 😀 \b\f\r' }],
    ["s = 'C:\\Users\\nodejs'", { s: "C:\\Users\\nodejs" }],
    ['s = """\nRoses\nViolets"""', { s: "Roses\nViolets" }],
    ['s = """\\\n   The quick \\\n   fox."""', { s: "The quick fox." }],
    ['s = """a ""quoted"" b"""', { s: 'a ""quoted"" b' }],
    ['s = """ends with quotes"""""', { s: 'ends with quotes""' }],
    ["s = '''\nraw \\n line\n'''", { s: "raw \\n line\n" }],
    ["s = '''it''s'''''", { s: "it''s''" }],
    ['s = ""', { s: "" }],
    ['s = "\\e"', { s: "\x1b" }],
    ['s = "\\x41"', { s: "A" }],
    // integers
    ["i = +99", { i: 99 }],
    ["i = -17", { i: -17 }],
    ["i = 0", { i: 0 }],
    ["i = 1_000_000", { i: 1000000 }],
    ["i = 0xDEAD_beef", { i: 0xdeadbeef }],
    ["i = 0o755", { i: 0o755 }],
    ["i = 0b1101_0110", { i: 0b11010110 }],
    // floats
    ["f = +1.0", { f: 1 }],
    ["f = 3.1415", { f: 3.1415 }],
    ["f = -0.01", { f: -0.01 }],
    ["f = 5e+22", { f: 5e22 }],
    ["f = 1e06", { f: 1e6 }],
    ["f = -2E-2", { f: -0.02 }],
    ["f = 6.626e-34", { f: 6.626e-34 }],
    ["f = 224_617.445_991", { f: 224617.445991 }],
    ["f = inf", { f: Infinity }],
    ["f = -inf", { f: -Infinity }],
    ["f = +inf", { f: Infinity }],
    ["f = -0.0", { f: -0 }],
    // booleans
    ["b = true\nc = false", { b: true, c: false }],
    // arrays
    ["a = [ 1, 2, 3 ]", { a: [1, 2, 3] }],
    [
      'a = [ [ 1, 2 ], ["a", "b"] ]',
      {
        a: [
          [1, 2],
          ["a", "b"],
        ],
      },
    ],
    ["a = [\n  1,\n  2, # comment\n]", { a: [1, 2] }],
    ['a = [ { x = 1 }, { y = "z" } ]', { a: [{ x: 1 }, { y: "z" }] }],
    ["a = []", { a: [] }],
    // tables
    ["[a]\nb = 1\n[a.c]\nd = 2", { a: { b: 1, c: { d: 2 } } }],
    ["[ j . \"ʞ\" . 'l' ]\nx = 1", { j: { ʞ: { l: { x: 1 } } } }],
    ["[x.y.z.w]\n[x]\nv = 1", { x: { y: { z: { w: {} } }, v: 1 } }],
    ["a.b.c = 1\na.d = 2", { a: { b: { c: 1 }, d: 2 } }],
    [
      "\"quoted key\" = 1\n'literal key' = 2\n1234 = 3",
      { "quoted key": 1, "literal key": 2, 1234: 3 },
    ],
    [
      'name = { first = "Tom", last = "Preston-Werner" }',
      { name: { first: "Tom", last: "Preston-Werner" } },
    ],
    ["p = { x.y = 1, z = [1] }", { p: { x: { y: 1 }, z: [1] } }],
    ["e = {}", { e: {} }],
    // TOML 1.1, which smol-toml implements: trailing comma and newlines in inline tables
    ["x = { y = [1,] , }", { x: { y: [1] } }],
    ["x = {\n  y = 1,\n}", { x: { y: 1 } }],
    // arrays of tables
    ['[[p]]\nn = "a"\n[[p]]\n[[p]]\nn = "c"', { p: [{ n: "a" }, {}, { n: "c" }] }],
    [
      '[[fruits]]\nname = "apple"\n[fruits.physical]\ncolor = "red"\n[[fruits.varieties]]\nname = "red delicious"',
      {
        fruits: [
          { name: "apple", physical: { color: "red" }, varieties: [{ name: "red delicious" }] },
        ],
      },
    ],
    // whitespace, comments, line endings
    ["# only a comment\n\n\t\n", {}],
    ["a = 1\r\nb = 2\r\n", { a: 1, b: 2 }],
    ["\ufeffa = 1", { a: 1 }],
    ["a = 1 # comment\r\nb = 2 # \u00e9\t", { a: 1, b: 2 }],
    ["i = 1979\nj = 12", { i: 1979, j: 12 }],
    ["i = -0\nj = +0", { i: 0, j: 0 }],
    ["a = [1979, 12, 0x1F]", { a: [1979, 12, 31] }],
  ])("%s", (text, expected) => {
    expect(value(text)).toEqual(expected);
  });

  test("nan parses as NaN", () => {
    expect(value("f = nan").f).toBeNaN();
    expect(value("f = -nan").f).toBeNaN();
  });

  /** @type {Array<[string, string, { dateTime?: boolean, date?: boolean, time?: boolean, local: boolean }]>} */
  const dates = [
    ["1979-05-27T07:32:00Z", "1979-05-27T07:32:00.000Z", { dateTime: true, local: false }],
    [
      "1979-05-27T00:32:00-07:00",
      "1979-05-27T00:32:00.000-07:00",
      { dateTime: true, local: false },
    ],
    [
      "1979-05-27T00:32:00.999999+05:30",
      "1979-05-27T00:32:00.999+05:30",
      { dateTime: true, local: false },
    ],
    ["1979-05-27 07:32:00Z", "1979-05-27T07:32:00.000Z", { dateTime: true, local: false }],
    ["1979-05-27T07:32:00", "1979-05-27T07:32:00.000", { dateTime: true, local: true }],
    ["1979-05-27", "1979-05-27", { date: true, local: true }],
    ["07:32:00", "07:32:00.000", { time: true, local: true }],
    ["00:32:00.5", "00:32:00.500", { time: true, local: true }],
    ["1979-05-27t07:32:00z", "1979-05-27T07:32:00.000Z", { dateTime: true, local: false }],
    ["1979-05-27 07:32:00", "1979-05-27T07:32:00.000", { dateTime: true, local: true }],
    // TOML 1.1: seconds may be left out
    ["1979-05-27T07:32Z", "1979-05-27T07:32:00.000Z", { dateTime: true, local: false }],
    ["07:32", "07:32:00.000", { time: true, local: true }],
  ];
  test.each(dates)("date %s", (text, iso, kind) => {
    const d = /** @type {any} */ (value(`d = ${text}`).d);
    expect(d).toBeInstanceOf(Date);
    expect(d.isValid()).toBe(true);
    expect(d.toISOString()).toBe(iso);
    expect(d.isDateTime()).toBe(!!kind.dateTime);
    expect(d.isDate()).toBe(!!kind.date);
    expect(d.isTime()).toBe(!!kind.time);
    expect(d.isLocal()).toBe(kind.local);
  });

  test("dates inside arrays and inline tables", () => {
    const v = /** @type {any} */ (
      value("a = [1979-05-27, 07:32:00]\nt = { d = 1979-05-27T07:32:00 }")
    );
    expect(v.a).toHaveLength(2);
    expect(v.t.d.isDateTime()).toBe(true);
  });

  test("parsed tables have no prototype, so a __proto__ key cannot pollute one", () => {
    expect(Object.getPrototypeOf(value("a = 1"))).toBeNull();
  });
});

describe("invalid TOML 1.0 is rejected with a line", () => {
  test.each([
    ["key = # no value", 1],
    ["key", 1],
    ["= 1", 1],
    ["a = 1 b = 2", 1],
    ["a = 1\na = 2", 2],
    ["[t]\n[t]", 2],
    ["[t]\nx = 1\n[t.x]", 3],
    ["a.b = 1\na = 2", 2],
    ["a = { b = 1 }\n[a]", 2],
    ["[[a]]\n[a]", 2],
    ["a = []\n[[a]]", 2],
    ["[a\nb = 1", 1],
    ["[]", 1],
    ["[a]]", 1],
    ['s = "unterminated', 1],
    ['s = "bad \\q escape"', 1],
    ['s = "\\uD800"', 1],
    ['s = "\\u00"', 1],
    ['s = "line\nbreak"', 1],
    ["s = 'line\nbreak'", 1],
    ['s = """unterminated', 1],
    ["s = '''unterminated", 1],
    ['s = "tab\u0001control"', 1],
    ["i = 01", 1],
    ["i = 1__0", 1],
    ["i = _1", 1],
    ["i = 1_", 1],
    ["i = 0xG", 1],
    ["i = 0b2", 1],
    ["i = 0o8", 1],
    ["i = +0x1", 1],
    ["i = 99999999999999999999", 1],
    ["f = 1.", 1],
    ["f = .1", 1],
    ["f = 1e", 1],
    ["f = 1.e5", 1],
    ["f = 03.14", 1],
    ["f = infinity", 1],
    ["b = True", 1],
    ["b = tru", 1],
    ["d = 1979-05-27T", 1],
    ["d = 1979-13-27", 1],
    ["d = 1979-05-27T25:00:00", 1],
    ["d = 1979-05-27T07:32:00+25:00", 1],
    ["d = 07:60:00", 1],
    ["a = [1, 2", 1],
    ["a = [1,,2]", 1],
    ["a = [,]", 1],
    ["t = { a = 1,, b = 2 }", 1],
    ["t = { a = 1, a = 2 }", 1],
    ["t = { a = 1", 1],
    ["t = { a.b = 1, a = 2 }", 1],
    ["t = { a = 1 }\nt.b = 2", 2],
    ["a = 1 # ok\nb = \u0007", 2],
    ["x = [[1]\n", 2],
    ["# bad \u0001 comment", 1],
    ["a = 1 # bad \u007f", 1],
    ["i = 0x", 1],
    ["f = 1e+", 1],
    ["f = 1.5_", 1],
    ["d = 1979-05-27T07", 1],
    ["d = 1979-05-27T07:32:00+05", 1],
    ["d = 1979-05-27X07:32:00", 1],
    ["d = 1979-5-27", 1],
    ["d = 1979-02-30T25:00:00Z", 1],
    ["t = 7:32:00", 1],
    ["t = 24:00:00", 1], // unterminated: reported where the parser notices, at the end
  ])("%j fails on line %i", (text, line) => {
    const r = parseToml(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBe(line);
      expect(r.error.message).not.toBe("");
    }
  });

  test("nesting deeper than the limit is an error, not a stack overflow", () => {
    const r = parseToml(`a = ${"[".repeat(2000)}${"]".repeat(2000)}`);
    expect(r.ok).toBe(false);
  });
});
