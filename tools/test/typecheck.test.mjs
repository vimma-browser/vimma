import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// `npm run typecheck` (ci.yml's "Typecheck" step) checks four programs under the same strict
// options: the browser code without Node's types (issue #945), tools/ with them, tests included
// (issue #947), the core's tests with them (issue #959), and the browser tests under tests/
// with the mochitest harness's declarations (issue #959).
/** @param {string} path */
const json = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("npm run typecheck", () => {
  const root = json("tsconfig.json");
  const tools = json("tools/tsconfig.json");
  const coreTests = json("packages/vimma-core/test/tsconfig.json");
  const browserTests = json("tests/tsconfig.json");

  it("checks the browser code, tools/ and the core's tests, each with its own tsconfig", () => {
    const script = json("package.json").scripts.typecheck;
    expect(script).toMatch(/\btsc -p tsconfig\.json\b/);
    expect(script).toMatch(/\btsc -p tools\/tsconfig\.json\b/);
    expect(script).toMatch(/\btsc -p packages\/vimma-core\/test\/tsconfig\.json\b/);
    // tests/tsconfig.json, through the ratchet of tools/test/mochitest-allowlist.txt.
    expect(script).toMatch(/\bnode tools\/mochitest-typecheck\.ts\b/);
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
    // own test: editing it needs the key-rotation-approved label
    // (docs/security/14-build-and-release-supply-chain.md B1). The whole list is pinned, so no
    // other glob (a folder, "**/*.test.mjs") can drop tests.
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

  // The browser tests run in Firefox, not Node: no Node types, the harness's globals from
  // types/mochitest/ instead, and every file under tests/ that is JavaScript, so a new test is
  // checked from its first commit. The ratchet list, not an exclude, holds back the files not
  // fixed yet (tools/mochitest-typecheck.ts).
  it("checks every JavaScript file under tests/ with the mochitest harness's declarations", () => {
    expect(browserTests.extends).toBe("../tsconfig.json");
    expect(browserTests.include).toEqual([
      "browser/**/*.js",
      "e2e/**/*.js",
      "../types/*.d.ts",
      "../types/mochitest/*.d.ts",
    ]);
    expect(browserTests.exclude).toEqual([]);
    // The harness's declarations stay out of the browser code's check.
    expect(root.include).toContain("types/*.d.ts");
    expect(root.include.some((/** @type {string} */ g) => g.includes("mochitest"))).toBe(false);
  });

  // Each relaxed or added option has its reason; nothing else of the root's may change.
  it("relaxes only what a mochitest needs, and says why", () => {
    expect(browserTests.compilerOptions).toEqual({
      types: [],
      // findLast and findLastIndex (ES2023), which the Firefox that runs the tests has.
      target: "es2024",
      // Each test file runs in a scope of its own, with head.js loaded into it: a file's
      // top-level names are its own, as a module's are.
      moduleDetection: "force",
      // `gBrowser.tabs[1]` and the like: a missing entry throws at its use and fails the test,
      // so it cannot pass by accident, and a guard at each of the thousands of such reads would
      // say nothing more.
      noUncheckedIndexedAccess: false,
      // The root skips the declaration files, but here they are the types/mochitest/*.d.ts
      // that name the product's types for the tests: an error in one (a wrong import path, a
      // member read off a nullable type) would make its type `any` and every test annotation
      // naming it would check nothing, with no error shown.
      skipLibCheck: false,
    });
  });

  it("pins @types/node to the Node major in .nvmrc", () => {
    const major = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").split(".")[0];
    const range = json("package.json").devDependencies["@types/node"];
    expect(range).toMatch(new RegExp(`^[~^]${major}\\.`));
  });
});
