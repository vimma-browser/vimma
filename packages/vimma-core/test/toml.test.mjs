import { describe, test, expect } from "vitest";
import {
  MAX_DEPTH,
  formatPath,
  locateKeys,
  parsePath,
  parseToml,
  setTomlKeys,
} from "../src/toml.mjs";

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
    const deep = (/** @type {number} */ n) => "a.".repeat(n - 1) + "a";
    expect(parseToml(`x = 1\n${deep(MAX_DEPTH)} = 1\n`).ok).toBe(true);
    for (const [text, line] of /** @type {const} */ ([
      [`x = 1\n${deep(MAX_DEPTH + 1)} = 1\n`, 2],
      [`x = 1\n[${deep(MAX_DEPTH + 1)}]\n`, 2],
      [`x = 1\n[[${deep(MAX_DEPTH)}]]\n`, 2],
      [`x = 1\n[${deep(MAX_DEPTH - 1)}]\nb = [[1]]\n`, 3],
    ])) {
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
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
    expect(r.ok).toBe(true);
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
  const lineOf = locateKeys(text);

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
    expect(locateKeys("a = 1\r\n\r\n[b]\r\nc = 2\r\n")(["b", "c"])).toBe(4);
  });
});

describe("config paths", () => {
  test.each([
    ["keys.new_tab[1]", ["keys", "new_tab", 1]],
    ['modal.normal."j"', ["modal", "normal", "j"]],
    ['modal.normal."<C-w>."', ["modal", "normal", "<C-w>."]],
    ["unbind.normal[0]", ["unbind", "normal", 0]],
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

/** @param {string} text */
const parsed = (text) => {
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
    expect(performance.now() - start).toBeLessThan(500);
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

  test("the result parses to the old file plus the new values", () => {
    const edits = [
      { table: "search", key: "default", value: 'Duck "Go"\\' },
      { table: "search", key: "added", value: "x" },
      { table: "ui", key: "flag", value: "y" },
    ];
    const r = setTomlKeys(FILE, edits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = /** @type {any} */ (parsed(FILE));
    expect(parsed(r.text)).toEqual({
      ...before,
      search: { ...before.search, default: 'Duck "Go"\\', added: "x" },
      ui: { flag: "y" },
    });
  });
});
