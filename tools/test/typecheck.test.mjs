import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// `npm run typecheck` (ci.yml's "Typecheck" step) checks three programs under the same strict
// options: the browser code without Node's types (issue #945), tools/ with them, tests included
// (issue #947), and the core's tests with them (issue #959).
/** @param {string} path */
const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("npm run typecheck", () => {
  const root = json("tsconfig.json");
  const tools = json("tools/tsconfig.json");
  const coreTests = json("packages/vimma-core/test/tsconfig.json");

  it("checks the browser code, tools/ and the core's tests, each with its own tsconfig", () => {
    const script = json("package.json").scripts.typecheck;
    expect(script).toMatch(/\btsc -p tsconfig\.json\b/);
    expect(script).toMatch(/\btsc -p tools\/tsconfig\.json\b/);
    expect(script).toMatch(/\btsc -p packages\/vimma-core\/test\/tsconfig\.json\b/);
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
    // The whole list is pinned, so no other glob (a folder, "**/*.test.mjs") can drop tests.
    expect(tools.exclude).toEqual([
      "vimma-ctl/",
      "**/node_modules/**",
      "ci/test/key-guard.test.mjs",
    ]);
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

  // The core's tests read files and spawn nothing in the browser, so they get Node's types; the
  // core itself stays in the root program, without them (ADR-005).
  it("checks the core's tests and bench with the root's strict options plus Node's types", () => {
    expect(coreTests.extends).toBe("../../../tsconfig.json");
    expect(coreTests.compilerOptions.types).toEqual(["node"]);
    expect(coreTests.include).toEqual(expect.arrayContaining(["**/*.mjs", "../bench/**/*.mjs"]));
    expect(root.include.some((/** @type {string} */ g) => g.includes("/test/"))).toBe(false);
  });

  // Every core test file is checked: a new one is in the program as soon as it exists, and none
  // may be left out (issue #959).
  it("leaves no core test file out", () => {
    expect(coreTests.exclude ?? []).toEqual([]);
  });

  it("pins @types/node to the Node major in .nvmrc", () => {
    const major = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").split(".")[0];
    const range = json("package.json").devDependencies["@types/node"];
    expect(range).toMatch(new RegExp(`^[~^]${major}\\.`));
  });
});
