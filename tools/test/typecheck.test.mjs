import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// `npm run typecheck` (ci.yml's "Typecheck" step) checks two programs under the same strict
// options (issue #945): the browser code without Node's types, and tools/ with them.
/** @param {string} path */
const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("npm run typecheck", () => {
  const root = json("tsconfig.json");
  const tools = json("tools/tsconfig.json");

  it("checks the browser code and tools/, each with its own tsconfig", () => {
    const script = json("package.json").scripts.typecheck;
    expect(script).toMatch(/\btsc -p tsconfig\.json\b/);
    expect(script).toMatch(/\btsc -p tools\/tsconfig\.json\b/);
  });

  it("keeps Node's types out of the browser code's check", () => {
    expect(root.compilerOptions.types).toEqual([]);
    for (const glob of root.include) expect(glob).not.toMatch(/^tools\//);
  });

  it("checks tools/ with the root's strict options plus Node's types", () => {
    expect(tools.extends).toBe("../tsconfig.json");
    expect(tools.compilerOptions).toEqual({ types: ["node"] });
    expect(tools.include).toContain("**/*.mjs");
    // Rust, and the tests (a follow-up issue), are not in it.
    expect(tools.exclude).toEqual(expect.arrayContaining(["**/test/**", "vimma-ctl/"]));
  });

  it("pins @types/node to the Node major in .nvmrc", () => {
    const major = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").split(".")[0];
    const range = json("package.json").devDependencies["@types/node"];
    expect(range).toMatch(new RegExp(`^[~^]${major}\\.`));
  });
});
