import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// `npm run typecheck` (ci.yml's "Typecheck" step) checks two programs under the same strict
// options (issue #945): the browser code without Node's types, and tools/ with them, tests
// included (issue #947).
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
    expect(tools.compilerOptions.types).toEqual(["node"]);
    expect(tools.include).toContain("**/*.mjs");
    // Rust is not in it; the tests are, .mjs and .ts alike (issue #947), except the key guard's
    // own test: editing it needs the key-rotation-approved label (docs/security.md B1).
    expect(tools.exclude).toContain("vimma-ctl/");
    expect(
      tools.exclude.filter((/** @type {string} */ glob) => /(?:^|\/)test\//.test(glob)),
    ).toEqual(["ci/test/key-guard.test.mjs"]);
  });

  // ADR-025: Node runs tools/**/*.ts as they are, by erasing the types; nothing compiles them.
  it("checks tools/**/*.ts, tests included, as Node runs them", () => {
    expect(tools.include).toContain("**/*.ts");
    for (const glob of tools.exclude) expect(glob).not.toMatch(/(?:^|\/)test\/\*\*$|\.ts$/);
    expect(tools.compilerOptions).toEqual({
      types: ["node"],
      // Only syntax Node can erase: no enums, namespaces, parameter properties or `import =`.
      erasableSyntaxOnly: true,
      // Type-only imports say so, since Node removes them without looking at what they import.
      verbatimModuleSyntax: true,
      // Imports name the file Node loads: `./x.ts`.
      allowImportingTsExtensions: true,
    });
    expect(root.compilerOptions.noEmit).toBe(true);
  });

  it("pins @types/node to the Node major in .nvmrc", () => {
    const major = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").split(".")[0];
    const range = json("package.json").devDependencies["@types/node"];
    expect(range).toMatch(new RegExp(`^[~^]${major}\\.`));
  });
});
