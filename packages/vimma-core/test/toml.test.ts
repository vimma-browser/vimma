import { describe, test, expect } from "vitest";
import {
  MAX_DEPTH,
  formatPath,
  locateKeys,
  parsePath,
  parseToml,
  sameTomlValue,
  setTomlKeys,
  tomlLiteral,
} from "../src/config/toml.mjs";
import { TomlError, parse } from "../src/vendor/smol-toml/smol-toml.mjs";
import { budget } from "./budget.ts";

describe("parseToml", () => {
  test("parses a TOML 1.0 document into plain values", () => {
    const r = parseToml('schema = 1\n[keys]\nnew_tab = ["prefix+c"]\n[ws]\nw = { a = true }\n');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({
      schema: 1,
      keys: { new_tab: ["prefix+c"] },
      ws: { w: { a: true } },
    });
  });

  test("a syntax error carries its line, column and a message without the code block", () => {
    const r = parseToml('a = 1\n\n[keys]\nnew_tab = ["x"\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.line).toBe(5);
    expect(r.error.column).toBeGreaterThan(0);
    expect(r.error.message).not.toMatch(/Invalid TOML document|\n/);
    expect(r.error.message.length).toBeGreaterThan(0);
  });

  test("nesting deeper than MAX_DEPTH, by dotted keys, headers or values, is refused at its line", () => {
    const deep = (n: number) => "a.".repeat(n - 1) + "a";
    expect(parseToml(`x = 1\n${deep(MAX_DEPTH)} = 1\n`).ok).toBe(true);
    for (const [text, line] of [
      [`x = 1\n${deep(MAX_DEPTH + 1)} = 1\n`, 2],
      [`x = 1\n[${deep(MAX_DEPTH + 1)}]\n`, 2],
      [`x = 1\n[[${deep(MAX_DEPTH)}]]\n`, 2],
      [`x = 1\n[${deep(MAX_DEPTH - 1)}]\nb = [[1]]\n`, 3],
    ] as const) {
      const r = parseToml(text);
      expect(r.ok, text).toBe(false);
      expect(!r.ok && r.error).toMatchObject({ line, message: expect.stringMatching(/deeper/) });
    }
    const inline = parseToml(`a = ${"[".repeat(MAX_DEPTH + 2)}${"]".repeat(MAX_DEPTH + 2)}`);
    expect(inline.ok).toBe(false);
  });

  test("a duplicate key is a syntax error at the duplicate's line", () => {
    const r = parseToml("a = 1\na = 2\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.line).toBe(2);
  });

  test("a __proto__ key does not pollute prototypes", () => {
    const r = parseToml('[__proto__]\npolluted = "yes"\n');
    expect(({} as any).polluted).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  test("the message is the first line of smol-toml's, without its prefix", () => {
    const text = "a = 1 1\n";
    let raw = "";
    try {
      parse(text);
    } catch (e) {
      expect(e).toBeInstanceOf(TomlError);
      raw = (e as Error).message;
    }
    expect(raw).toMatch(/^Invalid TOML document: [^\n]{10,}\n/);
    const r = parseToml(text);
    expect(!r.ok && r.error.message).toBe(
      raw.split("\n")[0]?.slice("Invalid TOML document: ".length),
    );
  });

  test("an error that is not a TOML syntax error is thrown, not reported as one", () => {
    expect(() => parseToml(5 as unknown as string)).toThrow(TypeError);
  });

  test("the depth error is at the line of the first value too deep", () => {
    // [a × 31] holds b (depth 32), whose c.d (34) goes past MAX_DEPTH: b's line, not the header's.
    const header = Array.from({ length: MAX_DEPTH - 1 }, () => "a").join(".");
    const r = parseToml(`x = 1\n[${header}]\nb.c.d = 1\n`);
    expect(!r.ok && r.error).toMatchObject({ line: 3, message: expect.stringMatching(/deeper/) });
  });
});

describe("locateKeys", () => {
  const text = [
    "# comment", // 1
    "schema = 1", // 2
    "", // 3
    "[keys]", // 4
    'new_tab = ["prefix+c", "ctrl+alt+c"]', // 5
    "close_tab = [", // 6
    '  "prefix+x",', // 7
    "  # a comment inside an array", // 8
    '  "ctrl+bogus",', // 9
    "]", // 10
    "", // 11
    "[modal.normal]", // 12
    '"j" = "scroll.down"', // 13
    "'k' = 'scroll.up'", // 14
    "", // 15
    "[workspaces]", // 16
    'work = { color = "blue", home = "https://x.example/#a" }', // 17
    '"my space" . color = "red"', // 18
    "", // 19
    "[theme]", // 20
    'font = """', // 21
    "x = 1", // 22
    '"""', // 23
    "source = 'file' # trailing", // 24
    "[[arr]]", // 25
    "n = 1.5e3", // 26
  ].join("\n");
  // Built inside each test, so per-test coverage (Stryker) sees the scan.
  const lineOf = (path: (string | number)[]) => locateKeys(text)(path);

  test.each([
    [["schema"], 2],
    [["keys"], 4],
    [["keys", "new_tab"], 5],
    [["keys", "new_tab", 1], 5],
    [["keys", "close_tab"], 6],
    [["keys", "close_tab", 0], 7],
    [["keys", "close_tab", 1], 9],
    [["modal", "normal"], 12],
    [["modal", "normal", "j"], 13],
    [["modal", "normal", "k"], 14],
    [["workspaces", "work"], 17],
    [["workspaces", "work", "home"], 17],
    [["workspaces", "my space", "color"], 18],
    [["theme", "font"], 21],
    [["theme", "source"], 24],
    [["arr", 0], 25],
    [["arr", 0, "n"], 26],
  ])("%j is on line %i", (path, line) => {
    expect(lineOf(path)).toBe(line);
  });

  test("a multi-line string's content is not taken for keys", () => {
    expect(lineOf(["theme", "x"])).toBe(20);
  });

  test("a missing path falls back to its nearest ancestor", () => {
    expect(lineOf(["keys", "next_tab"])).toBe(4);
    expect(lineOf(["modal", "normal", "zz"])).toBe(12);
  });

  test("a path with no located ancestor has no line", () => {
    expect(lineOf(["nowhere", "x"])).toBeUndefined();
    expect(lineOf([])).toBeUndefined();
  });

  test("escapes in quoted keys are decoded", () => {
    const where = locateKeys('[t]\n"caf\\u00e9" = 1\n"\\U0001F600\\t\\x41" = 2\n');
    expect(where(["t", "café"])).toBe(2);
    expect(where(["t", "😀\tA"])).toBe(3);
  });

  test("CRLF line endings count lines the same", () => {
    const where = locateKeys("a = 1\r\n\r\n[b]\r\nc = 2\r\n");
    expect(where(["b", "c"])).toBe(4);
    expect(where([""])).toBeUndefined(); // no key read from a "\r"
  });

  test("a comment at the end of the file, without a line break, ends the scan", () => {
    expect(locateKeys("a = 1\nb = 2 # c")(["b"])).toBe(2);
  });

  test("the end of the file is no key", () => {
    expect(locateKeys("a = 1\n")([""])).toBeUndefined();
  });

  test("a long dotted key takes linear time", () => {
    const text = `${"a.".repeat(50_000)}a = 1\n`;
    const start = performance.now();
    expect(locateKeys(text)(["a", "a"])).toBe(1);
    expect(performance.now() - start).toBeLessThan(budget(500));
  });
});

describe("config paths", () => {
  test.each([
    ["keys.new_tab[1]", ["keys", "new_tab", 1]],
    ['modal.normal."j"', ["modal", "normal", "j"]],
    ['modal.normal."<C-w>."', ["modal", "normal", "<C-w>."]],
    ["unbind.normal[0]", ["unbind", "normal", 0]],
    ["keys.new_tab[12]", ["keys", "new_tab", 12]],
    ["schema", ["schema"]],
    ["", []],
  ])("parsePath(%j)", (text, segs) => {
    expect(parsePath(text)).toEqual(segs);
  });

  // Not formatPath's output, but parsePath must still end: an unclosed `[` used to loop until
  // the array overflowed (issue #134).
  test.each([
    ["keys.c[mmand", ["keys", "c", "[mmand"]],
    ['keys."abc', ["keys", '"abc']],
    ["a[b.c[1]", ["a", "[b", "c", 1]],
    ["a. b", ["a", " b"]],
    // No JSON string at the `"`: a backslash before a line break escapes nothing JSON knows.
    ['"a\\\n"b"', ['"a\\\n"b"']],
  ])("parsePath(%j) ends on text formatPath does not write", (text, segs) => {
    expect(parsePath(text)).toEqual(segs);
  });

  test.each([
    [["keys", "new_tab", 1], "keys.new_tab[1]"],
    [["modal", "normal", "j"], "modal.normal.j"],
    [["modal", "normal", "<C-w>h"], 'modal.normal."<C-w>h"'],
    [["workspaces", "my space"], 'workspaces."my space"'],
    [[], ""],
  ])("formatPath(%j)", (segs, text) => {
    expect(formatPath(segs)).toBe(text);
    expect(parsePath(text)).toEqual(segs);
  });
});
const FILE = `# Vimma config
schema = 1

[search]
# the engine new searches use
default = "Google" # picked by hand
suggest = true

[keys]
new_tab = ["prefix+c"]
`;

const parsed = (text: string) => {
  const r = parseToml(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("setTomlKeys", () => {
  test("replaces only the value of an existing key, keeping comments and order", () => {
    const r = setTomlKeys(FILE, [{ table: "search", key: "default", value: "DuckDuckGo" }]);
    expect(r).toEqual({ ok: true, text: FILE.replace('"Google"', '"DuckDuckGo"') });
  });

  test("a long line of spaces after an open bracket takes linear time", () => {
    // CodeQL js/polynomial-redos: the table-header match must not backtrack per start position.
    const text = `x = """\n[a${" ".repeat(200_000)}\n"""\n`;
    const start = performance.now();
    expect(setTomlKeys(text, [{ table: "search", key: "default", value: "x" }]).ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(budget(500));
  });

  test("a trailing comment on the edited line is kept", () => {
    const r = setTomlKeys(FILE, [{ table: "search", key: "default", value: "Bing" }]);
    expect(r.ok && r.text.split("\n")[5]).toBe('default = "Bing" # picked by hand');
  });

  test("adds a missing key after the last key of its table", () => {
    const r = setTomlKeys(FILE, [{ table: "search", key: "region", value: "FI" }]);
    expect(r.ok && r.text).toBe(
      FILE.replace("suggest = true\n", 'suggest = true\nregion = "FI"\n'),
    );
  });

  test("appends a missing table at the end", () => {
    const text = "schema = 1\n[keys]\nnew_tab = []";
    const r = setTomlKeys(text, [{ table: "search", key: "default", value: "DuckDuckGo" }]);
    expect(r.ok && r.text).toBe(`${text}\n\n[search]\ndefault = "DuckDuckGo"\n`);
  });

  test("a parse error returns an error and no text", () => {
    const r = setTomlKeys("[search\ndefault = 1\n", [
      { table: "search", key: "default", value: "X" },
    ]);
    expect(r.ok).toBe(false);
    expect("text" in r).toBe(false);
    expect(!r.ok && r.error.line).toBe(1);
  });

  test("a dotted key, inline table or multi-line value is an error", () => {
    const edit = [{ table: "search", key: "default", value: "X" }];
    for (const text of [
      'search.default = "Google"\n',
      'search = { default = "Google" }\n',
      '[search]\ndefault = """\nGoogle"""\n',
      '[search]\ndefault.name = "Google"\n',
    ]) {
      const r = setTomlKeys(text, edit);
      expect(r.ok, text).toBe(false);
    }
  });

  test("a header line inside a multi-line string is not the table: an error, not a throw", () => {
    const text = 'note = """\n[search]\n"""\n';
    const r = setTomlKeys(text, [{ table: "search", key: "default", value: "X" }]);
    expect(r).toEqual({
      ok: false,
      error: { line: 2, column: 1, message: "search is not a plain [search] table" },
    });
  });

  test("the result parses to the old file plus the new values", () => {
    const edits = [
      { table: "search", key: "default", value: 'Duck "Go"\\' },
      { table: "search", key: "added", value: "x" },
      { table: "ui", key: "flag", value: "y" },
    ];
    const r = setTomlKeys(FILE, edits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = parsed(FILE) as any;
    expect(parsed(r.text)).toEqual({
      ...before,
      search: { ...before.search, default: 'Duck "Go"\\', added: "x" },
      ui: { flag: "y" },
    });
  });
});

describe("parseToml: the unclosed-bracket hint", () => {
  // The parser reports an unterminated array where it notices; the hint names where it opened,
  // skipping brackets inside comments and strings, and only for brackets opened on earlier lines.
  // The parser's own wording and columns are smol-toml's: only Vimma's hint is pinned here.
  const syntaxError = (text: string) => {
    const r = parseToml(text);
    if (r.ok) throw new Error(`parsed: ${text}`);
    expect(r.error.column).toBeGreaterThan(0);
    return r.error;
  };

  test.each([
    ["a = [\n1,\n[t]\n", 3, '(unclosed "[" opened at line 1?)'],
    ["x = 1\na = [\n1,\n[t]\n", 4, '(unclosed "[" opened at line 2?)'],
    ["a = [\n[\n[t]\n", 3, '(unclosed "[" opened at line 2?)'],
    ["a = [[1], \n[t]\n", 2, '(unclosed "[" opened at line 1?)'],
    ["a = { b = [1] \n[t]\n", 2, '(unclosed "{" opened at line 1?)'],
    ["a = [ # [ {\n1,\n[t]\n", 3, '(unclosed "[" opened at line 1?)'],
    ["a = [ \"[\" , '{',\n1,\n[t]\n", 3, '(unclosed "[" opened at line 1?)'],
    ['a = [ "x\\"[",\n1,\n[t]\n', 3, '(unclosed "[" opened at line 1?)'],
    ['a = [ """\n[\n""",\n1,\n[t]\n', 5, '(unclosed "[" opened at line 1?)'],
    ["a = [ '''\n[\n''',\n1,\n[t]\n", 5, '(unclosed "[" opened at line 1?)'],
    ['a = """\nx\n"""\nb = [\n[t]\n', 5, '(unclosed "[" opened at line 4?)'],
    ["a = [\n1 1 ]\n", 2, '(unclosed "[" opened at line 1?)'],
    ["a = [ #x\n1 1\n", 2, '(unclosed "[" opened at line 1?)'],
    ["a = [ \r\n1 1\n", 2, '(unclosed "[" opened at line 1?)'],
    ["x = 1 # c\na = [\n1,\n[t]\n", 4, '(unclosed "[" opened at line 2?)'],
    // The parser points at the `}`: the scan stops before it.
    ["a = [\n1 }\n", 2, '(unclosed "[" opened at line 1?)'],
    ['a = [\n"abc', 2, '(unclosed "[" opened at line 1?)'],
    // Only a backslash skips the next character: the string ends at its quote, before the `{`.
    ['a = [ "abc", "{",\n1,\n[t]\n', 3, '(unclosed "[" opened at line 1?)'],
    // A backslash escapes nothing in a literal string: 'a\' ends at its second quote.
    ["a = [ 'a\\', '{',\n1,\n[t]\n", 3, '(unclosed "[" opened at line 1?)'],
  ])("%j fails at line %i, ending %s", (text, line, hint) => {
    const error = syntaxError(text);
    expect(error.line).toBe(line);
    expect(error.message.endsWith(` ${hint}`)).toBe(true);
    expect(error.message.indexOf("(unclosed")).toBe(error.message.length - hint.length);
  });

  test.each([
    "# [\nb = 1 1\n",
    'a = "["\nb = 1 1\n',
    "a = '['\nb = 1 1\n",
    'a = "\\"["\nb = 1 1\n',
    'a = """\n[\n"""\nb = 1 1\n',
    "a = '''\n[\n'''\nb = 1 1\n",
    "a = [1]\nb = 1 1\n",
    "a = {b = 1}\nb = 1 1\n",
    // A bracket opened on the error's own line.
    "a = [1 1]\n",
    // Closed on the error's line, before the error.
    "a = [\n1]  x\n",
  ])("%j: brackets in comments, strings, closed or on the error's line give no hint", (text) => {
    const error = syntaxError(text);
    expect(error.line).toBe(text.split("\n").length - 1);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toContain("(unclosed");
  });
});

describe("locateKeys: whitespace, comments, strings and nesting", () => {
  const text = [
    "\ufeffa = [", // 1, after a byte order mark
    "  1", // 2
    "]", // 3
    "\tb\t=\t2\t# tab", // 4
    "c . d = 3", // 5
    'e = """x\\"""', // 6
    'y\\\\"""', // 7
    "f = '''z''''' # five quotes end it", // 8
    "g = [ # c", // 9
    "  { h = 1 }, # c", // 10
    "  [ 2 ,", // 11
    "3 ],", // 12
    "]", // 13
    "[ t . u ]", // 14
    "[[ arr ]]", // 15
    "[[arr]]", // 16
    "v = 'lit\\' # x", // 17
    'w = "s#" # x', // 18
    "z = 1", // 19
  ].join("\n");
  // Built inside each test, so per-test coverage (Stryker) sees the scan.
  const lineOf = (path: (string | number)[]) => locateKeys(text)(path);

  test("the fixture parses", () => {
    expect(parseToml(text)).toMatchObject({
      ok: true,
      value: { e: 'x"""\ny\\', f: "z''", g: [{ h: 1 }, [2, 3]], arr: [{}, { z: 1 }] },
    });
  });

  test.each([
    [["a"], 1],
    [["a", 0], 2],
    [["b"], 4],
    [["c"], 5],
    [["c", "d"], 5],
    [["e"], 6],
    [["f"], 8],
    [["g"], 9],
    [["g", 0], 10],
    [["g", 0, "h"], 10],
    [["g", 1], 11],
    [["g", 1, 0], 11],
    [["g", 1, 1], 12],
    [["t"], 14],
    [["t", "u"], 14],
    [["arr", 0], 15],
    [["arr", 1], 16],
    [["arr", 1, "v"], 17],
    [["arr", 1, "w"], 18],
    [["arr", 1, "z"], 19],
  ])("%j is on line %i", (path, line) => {
    expect(lineOf(path)).toBe(line);
  });

  test("a multi-line string's content and its closing quotes are no keys", () => {
    expect(lineOf(["y"])).toBeUndefined(); // line 7, inside e's string
    expect(lineOf([""])).toBeUndefined(); // the two extra quotes ending f
    // A backslash escapes nothing in a literal string.
    expect(locateKeys("k = '''a\\'''\nz = 1\n")(["z"])).toBe(2);
  });

  test("blanks and line breaks around array elements and inline-table members", () => {
    expect(locateKeys('a = [\n"x"\n,\n"y"]\n')(["a", 1])).toBe(4);
    const inline = locateKeys('w = {\n a = "x"\n , b = 1\n}\nt = { }\nz = 1\n');
    expect(inline(["w", "a"])).toBe(2);
    expect(inline(["w", "b"])).toBe(3);
    expect(inline(["t", ""])).toBe(5); // t itself: no member
    expect(inline(["z"])).toBe(6);
  });

  test("a value ending a line is on that line", () => {
    expect(locateKeys("a = [\n1\n,2]\n")(["a", 0])).toBe(2);
    expect(locateKeys("a = [\n1\n,2]\n")(["a", 1])).toBe(3);
  });

  test("a path deeper than MAX_DEPTH + 1 is located by its prefix", () => {
    const deep = Array.from({ length: MAX_DEPTH + 3 }, () => "a");
    const where = locateKeys(`x = 1\n${deep.join(".")} = 1\n`);
    expect(where(deep)).toBe(2);
    expect(where(deep.slice(0, MAX_DEPTH + 1))).toBe(2);
    const header = locateKeys(`x = 1\n[${deep.join(".")}]\n`);
    expect(header(deep)).toBe(2);
  });
});

describe("setTomlKeys: what a line edit may change", () => {
  const set = (text: string, table: string, key: string, value: string | boolean | number) =>
    setTomlKeys(text, [{ table, key, value }]);
  const fails = (line: number, message: string) => ({
    ok: false,
    error: { line, column: 1, message },
  });

  test.each([
    ['search.default = "Google"\n', 1, "search is not a plain [search] table"],
    ['x = 1\nsearch = { default = "Google" }\n', 2, "search is not a plain [search] table"],
    ["x = 1\n[[search]]\nx = 1\n", 2, "search is not a plain [search] table"],
    ["[search.sub]\nx = 1\n", 1, "search is not a plain [search] table"],
    ['x = 1\n[search]\ndefault = """\nGoogle"""\n', 3, "search.default is not a one-line value"],
    ["x = 1\n[search]\ndefault = '''G'''\n", 3, "search.default is not a one-line value"],
    ["x = 1\n[search]\ndefault = [1]\n", 3, "search.default is not a one-line value"],
    ["[search]\nx = 1\ndefault = [1]\n", 3, "search.default is not a one-line value"],
    ["x = 1\n[search]\ndefault = {a=1}\n", 3, "search.default is not a one-line value"],
    [
      'x = 1\n[search]\ndefault.name = "Google"\n',
      3,
      "search.default is not a plain key = value line",
    ],
    // A `[search]` line inside a string, with the real search an inline table over several lines:
    // the lines after the fake header are no plain key = value lines either.
    [
      'note = """\n[search]\n"""\nsearch = { a = \'\'\'\ndefault = "abc\'\'\', default = 1 }\n',
      5,
      "search.default is not a one-line value",
    ],
    [
      'note = """\n[search]\n"""\nsearch = { a = """\ndefault = \'abc""", default = 1 }\n',
      5,
      "search.default is not a one-line value",
    ],
    [
      'search = {\ndefault = 1, note = """\n[search]\n"""}\n',
      2,
      "search.default is not a plain key = value line",
    ],
  ])("%j: line %i, %s", (text, line, message) => {
    expect(set(text, "search", "default", "X")).toEqual(fails(line, message));
  });

  test("a table or key that is not bare is refused before any edit", () => {
    expect(set("a = 1\n", "se arch", "default", 1)).toEqual(fails(1, "not a bare key"));
    expect(set("a = 1\n", "search", "de.fault", 1)).toEqual(fails(1, "not a bare key"));
  });

  test.each([
    ['[search]\ndefault = "a\\"b" # c\n', "X", '[search]\ndefault = "X" # c\n'],
    ["[search]\ndefault = 'a\\' # c\n", "X", '[search]\ndefault = "X" # c\n'],
    ["[search]\ndefault = 12 \t# c\n", 3, "[search]\ndefault = 3 \t# c\n"],
    ["[search]\ndefault = 12\n", 3, "[search]\ndefault = 3\n"],
    ["[search]\ndefault = 12", 3, "[search]\ndefault = 3"],
    ['[search]\ndefault = 12 # "c"\n', 3, '[search]\ndefault = 3 # "c"\n'],
    ["[search]\ndefault = true\r\nx = 1\r\n", false, "[search]\ndefault = false\r\nx = 1\r\n"],
    ["  [ search ]  # hdr\n\tdefault = 1\n", 2, "  [ search ]  # hdr\n\tdefault = 2\n"],
    ["[search]\t\r\n default = 1\r\n", 2, "[search]\t\r\n default = 2\r\n"],
    ["[search]\n# default = 1\ndefault = 1\n", 2, "[search]\n# default = 1\ndefault = 2\n"],
    [
      "[search]\ndefault = 1\n[search.sub]\nx = 1\n",
      2,
      "[search]\ndefault = 2\n[search.sub]\nx = 1\n",
    ],
  ])("%j: the value alone is replaced", (text, value, out) => {
    expect(set(text, "search", "default", value)).toEqual({ ok: true, text: out });
  });

  test.each([
    ["[search]\r\nx = 1\r\n", "[search]\r\nx = 1\r\ndefault = 2\r\n"],
    [
      "[search]\nx = 1\n\n# trailing\n\n[other]\ny = 2\n",
      "[search]\nx = 1\ndefault = 2\n\n# trailing\n\n[other]\ny = 2\n",
    ],
    ["[search]\nx = 1\n  [other]\ny = 2\n", "[search]\nx = 1\ndefault = 2\n  [other]\ny = 2\n"],
    ["[search]\n[search.sub]\nx = 1\n", "[search]\ndefault = 2\n[search.sub]\nx = 1\n"],
    ["[search]\ndefaultx = 1\n", "[search]\ndefaultx = 1\ndefault = 2\n"],
    ["[other]\n[search]\n", "[other]\n[search]\ndefault = 2\n"],
  ])("%j: a missing key goes after the table's last key", (text, out) => {
    expect(set(text, "search", "default", 2)).toEqual({ ok: true, text: out });
  });

  test.each([
    ["", '[search]\ndefault = "é\\u007F"\n'],
    ["a = 1", 'a = 1\n\n[search]\ndefault = "é\\u007F"\n'],
    ["a = 1\n", 'a = 1\n\n[search]\ndefault = "é\\u007F"\n'],
    ["a = 1\r\n", 'a = 1\r\n\r\n[search]\r\ndefault = "é\\u007F"\r\n'],
  ])("%j: a missing table is appended in the file's line endings", (text, out) => {
    expect(set(text, "search", "default", "é\x7f")).toEqual({ ok: true, text: out });
  });

  test("a later edit sees an earlier one, and other tables keep their keys", () => {
    const r = setTomlKeys("[a]\nx = 1\n[b]\ny = 2\n", [
      { table: "a", key: "x", value: 3 },
      { table: "a", key: "z", value: true },
      { table: "b", key: "y", value: "s" },
    ]);
    expect(r).toEqual({ ok: true, text: '[a]\nx = 3\nz = true\n[b]\ny = "s"\n' });
  });

  test("a syntax error is returned as the parser reports it", () => {
    const parsed = parseToml("[bad\n");
    expect(parsed.ok).toBe(false);
    expect(set("[bad\n", "search", "default", 1)).toEqual(parsed);
  });

  test("a syntax error comes before a key that is not bare", () => {
    expect(set("[bad\n", "se arch", "default", 1)).toEqual(parseToml("[bad\n"));
  });

  test.each([
    ['[search]\ndefault = "a#b" # c\n', "[search]\ndefault = 2 # c\n"],
    ["[search]\ndefault = 'a#b' # c\n", "[search]\ndefault = 2 # c\n"],
    ["[\tsearch\t]\ndefault = 1\n", "[\tsearch\t]\ndefault = 2\n"],
  ])("%j: a `#` inside a string, or tabs in the header, are no end", (text, out) => {
    expect(set(text, "search", "default", 2)).toEqual({ ok: true, text: out });
  });

  test.each([
    // A key = value line inside a multi-line string is no key: the key is added after it.
    [
      '[search]\nnote = """\ndefault = 1\n"""\n',
      '[search]\nnote = """\ndefault = 1\n"""\ndefault = 2\n',
    ],
    // Blank lines with blanks, and indented comments, end the table's keys.
    [
      "[search]\nx = 1\n  \n  # note\n[other]\n",
      "[search]\nx = 1\ndefault = 2\n  \n  # note\n[other]\n",
    ],
    // Lines in a multi-line string that only look like a header are none.
    ['note = """\nXsearch]\n"""\n', 'note = """\nXsearch]\n"""\n\n[search]\ndefault = 2\n'],
    ['note = """\n[search] x\n"""\n', 'note = """\n[search] x\n"""\n\n[search]\ndefault = 2\n'],
  ])("%j: only real keys and headers count", (text, out) => {
    expect(set(text, "search", "default", 2)).toEqual({ ok: true, text: out });
  });

  // A `[` starting a line inside a value ends the table's lines for the scan, which then adds
  // the key in the wrong place. The result is parsed again, so that is an error, not the file.
  test("an added key that would change another value is an error", () => {
    expect(set('[search]\nnote = """\n[x]\n"""\n', "search", "default", 2)).toEqual(
      fails(1, "the edit would change other keys"),
    );
  });

  test("an added key that breaks the file is the parser's error, and stops later edits", () => {
    const text = "[search]\nd = [\n[1],\n]\n";
    const broken = parseToml("[search]\nd = [\ndefault = 2\n[1],\n]\n");
    expect(broken.ok).toBe(false);
    expect(set(text, "search", "default", 2)).toEqual(broken);
    const two = setTomlKeys(text, [
      { table: "search", key: "default", value: 2 },
      { table: "search", key: "x", value: 1 },
    ]);
    expect(two).toEqual(broken);
  });
});

describe("tomlLiteral", () => {
  test.each([
    ['a"b\\c\x7f', '"a\\"b\\\\c\\u007F"'],
    [true, "true"],
    [false, "false"],
    [42, "42"],
    [-7, "-7"],
  ] as const)("%j is %s", (value, literal) => {
    expect(tomlLiteral(value)).toBe(literal);
    expect(parseToml(`v = ${literal}`)).toEqual({ ok: true, value: { v: value } });
  });
});

describe("sameTomlValue", () => {
  const date = (s: string) => new Date(s);
  test.each([
    [1, 1],
    ["a", "a"],
    [Number.NaN, Number.NaN],
    [date("1979-05-27T07:32:00Z"), date("1979-05-27T07:32:00Z")],
    [
      [1, [2]],
      [1, [2]],
    ],
    [
      { a: 1, b: { c: [true] } },
      { b: { c: [true] }, a: 1 },
    ],
  ])("%j equals %j", (a, b) => {
    expect(sameTomlValue(a, b)).toBe(true);
  });

  test.each([
    [1, 2],
    [0, -0],
    [{}, 1],
    [1, {}],
    [null, {}],
    [{}, null],
    [[], {}],
    [{}, []],
    [date("1979-05-27T07:32:00Z"), date("1979-05-28T07:32:00Z")],
    [date("1979-05-27T07:32:00Z"), {}],
    [{}, date("1979-05-27T07:32:00Z")],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: 2 }, { a: 1 }],
    [
      { a: 1, b: 2 },
      { a: 1, b: 3 },
    ],
    [{ a: 1 }, { b: 1 }],
  ])("%j differs from %j", (a, b) => {
    expect(sameTomlValue(a, b)).toBe(false);
  });
});
