import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A declaration carries only the doc comment right above it: two `/** … */` blocks with nothing
// between them leave the first one on the wrong declaration (#1029), and editors and the type
// checker then show the wrong text. A file overview stays apart from the first declaration's
// doc comment by a blank line, so it is not caught.
const tools = fileURLToPath(new URL("..", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "fixtures") return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

/** The 1-based lines where a doc comment starts directly below another doc comment's end. */
function stackedDocComments(text: string): number[] {
  return [...text.matchAll(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\r?\n[ \t]*\/\*\*/g)].map(
    (m) => text.slice(0, m.index + m[0].length).split("\n").length,
  );
}

describe("doc comments in tools/", () => {
  it("finds a doc comment stacked on another", () => {
    expect(stackedDocComments("/** a */\n/** b */\nf();\n")).toEqual([2]);
    expect(stackedDocComments("/** a */\n\n/** b */\nf();\n")).toEqual([]);
    expect(stackedDocComments("x;\n/**\n * a\n */\n/** b */\nf();\n")).toEqual([5]);
    expect(stackedDocComments("/* eslint-disable no-x */\n/** b */\nf();\n")).toEqual([]);
    expect(stackedDocComments("// a\n/** b */\nf();\n")).toEqual([]);
  });

  it("no declaration carries two doc comments", () => {
    const files = tsFiles(tools);
    expect(files.length).toBeGreaterThan(20);
    const stacked = files.flatMap((f) =>
      stackedDocComments(readFileSync(f, "utf8")).map((l) => `${relative(tools, f)}:${l}`),
    );
    expect(stacked).toEqual([]);
  });
});
