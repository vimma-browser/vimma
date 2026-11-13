import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkFile, markdownLinks, testNames } from "../check-doc-links.mjs";

describe("testNames", () => {
  test("mochitest tasks, sync and async", () => {
    const src = `add_task(async function test_a() {});\nadd_task(function b_c() {});`;
    expect([...testNames(src, "x.js")]).toEqual(["test_a", "b_c"]);
  });

  test("mochitest tasks added through a file's own add...Task wrapper", () => {
    const src = `addTidyTask(async function test_a() {});\nreaddTask(function not_a_task() {});`;
    expect([...testNames(src, "x.js")]).toEqual(["test_a"]);
  });

  test("Vitest test, it, describe and test.each titles", () => {
    const src = [
      `describe("group", () => {`,
      `  test("one thing", () => {});`,
      `  it('another', () => {});`,
      "  test(`third`, () => {});",
      `  test.each([[1, 2]])("each %s", () => {});`,
      `});`,
    ].join("\n");
    expect([...testNames(src, "x.test.mjs")].sort()).toEqual(
      ["another", "each %s", "group", "one thing", "third"].sort(),
    );
  });

  test("Rust #[test] functions, also with attributes between", () => {
    const src = `#[test]\nfn a_b() {}\n#[test]\n#[cfg(unix)]\nfn c() {}\nfn not_a_test() {}`;
    expect([...testNames(src, "x.rs")]).toEqual(["a_b", "c"]);
  });

  test("a helper call is not a test", () => {
    expect(testNames(`latest("x"); attest("y");`, "x.js").size).toBe(0);
  });
});

describe("markdownLinks", () => {
  test("finds links with code-span text, skipping fenced code", () => {
    const md = ["[`t_a`](a.js) and [doc](b.md)", "```", "[`no`](c.js)", "```", "[x](d.md)"];
    expect(markdownLinks(md.join("\n"))).toEqual([
      { text: "`t_a`", target: "a.js", line: 1 },
      { text: "doc", target: "b.md", line: 1 },
      { text: "x", target: "d.md", line: 5 },
    ]);
  });

  test("a line of unclosed brackets and backtick pairs is read in linear time (js/redos)", () => {
    const line = `[${"``".repeat(40)} [${"`".repeat(100_000)}`;
    const start = performance.now();
    expect(markdownLinks(`${line}\n[\`t\`](a.js)`)).toEqual([
      { text: "`t`", target: "a.js", line: 2 },
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("a ] inside a code span does not end the link text; a lone backtick is text", () => {
    expect(markdownLinks("[`a]b` c](x.js) [d ` e](y.md) [f](g h) [](z.md)")).toEqual([
      { text: "`a]b` c", target: "x.js", line: 1 },
      { text: "d ` e", target: "y.md", line: 1 },
      { text: "", target: "z.md", line: 1 },
    ]);
  });
});

describe("checkFile", () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vimma-doc-links-"));
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "a.js"), "add_task(async function real_task() {});\n");
    writeFileSync(join(dir, "tests", "b.test.mjs"), 'test("real test", () => {});\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** @param {string} md */
  const check = (md) => {
    writeFileSync(join(dir, "docs", "s.md"), md);
    return checkFile(join(dir, "docs", "s.md"));
  };

  test("links to existing tests pass and are counted", () => {
    const r = check("[`real_task`](../tests/a.js), [`real test`](../tests/b.test.mjs)\n");
    expect(r).toEqual({ problems: [], tests: 2 });
  });

  test("a renamed task fails, naming the line", () => {
    const { problems } = check("one\n[`gone_task`](../tests/a.js)\n");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/s\.md:2: \.\.\/tests\/a\.js has no test named "gone_task"/);
  });

  test("a missing file fails, test link or not", () => {
    const { problems } = check("[`t`](../tests/nope.js) [guide](../nope.md)\n");
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("does not exist"))).toBe(true);
  });

  test("web links and anchors are not checked", () => {
    expect(check("[x](https://example.com/a) [y](#rules)\n")).toEqual({ problems: [], tests: 0 });
  });
});

test("docs/security.md: every test link resolves", () => {
  const doc = fileURLToPath(new URL("../../../docs/security.md", import.meta.url));
  const { problems, tests } = checkFile(doc);
  expect(problems).toEqual([]);
  expect(tests).toBeGreaterThan(20);
});
