import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkAll, checkFile, docFiles, markdownLinks, testNames } from "../check-doc-links.ts";

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
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vimma-doc-links-"));
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "a.js"), "add_task(async function real_task() {});\n");
    writeFileSync(join(dir, "tests", "b.test.mjs"), 'test("real test", () => {});\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const check = (md: string) => {
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

describe("docFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vimma-doc-files-"));
    mkdirSync(join(dir, "security", "deeper"), { recursive: true });
    for (const name of ["README.md", "02-b.md", "01-a.md", "notes.txt", "deeper/03-c.md"])
      writeFileSync(join(dir, "security", name), "x\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a folder gives every Markdown file under it, sorted", () => {
    expect(docFiles(join(dir, "security"))).toEqual(
      ["01-a.md", "02-b.md", "README.md", "deeper/03-c.md"].map((f) => join(dir, "security", f)),
    );
  });

  test("a file gives itself", () => {
    expect(docFiles(join(dir, "security", "01-a.md"))).toEqual([join(dir, "security", "01-a.md")]);
  });
});

describe("checkAll", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vimma-doc-all-"));
    mkdirSync(join(dir, "docs", "security"), { recursive: true });
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "a.js"), "add_task(async function real_task() {});\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, md: string) =>
    writeFileSync(join(dir, "docs", "security", name), md);

  test("a folder passes when its files' links resolve, one of them without a test link", () => {
    write("README.md", "[rules](01-a.md)\n");
    write("01-a.md", "[`real_task`](../../tests/a.js)\n");
    const r = checkAll([join(dir, "docs", "security")]);
    expect(r).toMatchObject({ failed: false, errors: [], tests: 1 });
    expect(r.lines.at(-1)).toMatch(/security: 1 test links resolve in 2 files$/);
  });

  test("a folder with no test link at all fails: the check would be vacuous", () => {
    write("README.md", "[rules](01-a.md)\n");
    write("01-a.md", "no links\n");
    const r = checkAll([join(dir, "docs", "security")]);
    expect(r.failed).toBe(true);
    expect(r.errors.join("\n")).toMatch(/no test links found/);
  });

  test("a file named on its own still needs a test link", () => {
    write("README.md", "[rules](01-a.md)\n");
    write("01-a.md", "[`real_task`](../../tests/a.js)\n");
    expect(checkAll([join(dir, "docs", "security", "README.md")]).failed).toBe(true);
    expect(checkAll([join(dir, "docs", "security", "01-a.md")]).failed).toBe(false);
  });

  test("a broken link in any file of the folder fails", () => {
    write("README.md", "[rules](02-gone.md)\n");
    write("01-a.md", "[`real_task`](../../tests/a.js)\n");
    const r = checkAll([join(dir, "docs", "security")]);
    expect(r.failed).toBe(true);
    expect(r.errors.join("\n")).toMatch(/README\.md:1: 02-gone\.md does not exist/);
  });
});

// The path is a literal `new URL` of a Markdown file so that tools/ci/docs-only.mjs's check finds
// this file among the tests a docs-only pull request runs.
test("docs/security/: every test link of every section file resolves", () => {
  const index = fileURLToPath(new URL("../../../docs/security/README.md", import.meta.url));
  const files = docFiles(dirname(index));
  expect(files).toContain(index);
  expect(files.length).toBeGreaterThan(20);
  let total = 0;
  for (const file of files) {
    const { problems, tests } = checkFile(file);
    expect(problems).toEqual([]);
    total += tests;
  }
  // One file's worth of links would pass a low floor: the whole folder has to be read.
  expect(total).toBeGreaterThan(1000);
});
