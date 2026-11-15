/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "amaro";
import { ESLint } from "eslint";
import * as espree from "espree";
import vitestConfig from "../../vitest.config.ts";

// ADR-025: tools/ may be TypeScript that Node runs as it is, by erasing the types. These pin what
// that needs from Node, Vitest and eslint; tools/test/typecheck.test.mjs pins tsc's side.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/ts-run/main.ts", import.meta.url));
const ROOT_TS_CONFIGS = ["commitlint.config.ts", "vitest.config.ts"];
// vimma-core's tests (ADR-025 decision 6, since changed; #1114): Vitest alone loads them, and
// sync-core copies only the package's src/, which stays JavaScript.
const CORE_TESTS = "packages/vimma-core/test/";

/**
 * The TypeScript files outside the places ADR-025 allows it: tools/, the root configs, and
 * vimma-core's tests (as `.ts` only, the one extension their tsconfig, eslint and Vitest read).
 * @param {string[]} paths
 */
function outsideTypeScriptHomes(paths) {
  return paths.filter(
    (p) =>
      !p.startsWith("tools/") &&
      !(p.startsWith(CORE_TESTS) && p.endsWith(".ts")) &&
      !ROOT_TS_CONFIGS.includes(p),
  );
}

/**
 * The modules a .ts file loads when Node runs it: its import and export declarations and its
 * import() calls with a string, read from the program Node runs (types stripped as Node strips
 * them), so a module path in a string or a comment is not one. A type-only import is erased.
 * @param {string} code
 * @returns {string[]}
 */
function importSpecifiers(code) {
  const program = espree.parse(transformSync(code, { mode: "strip-only" }).code, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  /** @type {string[]} */
  const found = [];
  /** @param {unknown} node */
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    /** @typedef {{ type: string, value?: unknown, expressions?: unknown[],
     *   quasis?: { value: { cooked: string } }[] }} Source */
    const n = /** @type {{ type?: string, source?: Source }} */ (node);
    const source = n.source;
    // import(`./x.ts`) without substitutions names its module as plainly as a string does
    const spec =
      source?.type === "Literal"
        ? source.value
        : source?.type === "TemplateLiteral" && source.expressions?.length === 0
          ? source.quasis?.[0]?.value.cooked
          : undefined;
    if (
      (n.type === "ImportDeclaration" ||
        n.type === "ExportNamedDeclaration" ||
        n.type === "ExportAllDeclaration" ||
        n.type === "ImportExpression") &&
      typeof spec === "string"
    )
      found.push(spec);
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  visit(program);
  return found;
}

describe("TypeScript under tools/ (ADR-025)", () => {
  it("Node runs a .ts file with no flag, and writes nothing to stderr", () => {
    const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
    // Tools' tests compare stderr, so an ExperimentalWarning there would break them.
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("doubled 4\n");
    expect(run.status).toBe(0);
  });

  it("package.json asks for a Node that does that: 22.18 or later in 22, 24.3 or later", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    // 22.17 and 23.0-23.5 cannot run .ts without a flag; 23.6-24.2 print an ExperimentalWarning.
    expect(pkg.engines.node).toBe("^22.18.0 || >=24.3.0");
    const [major = 0, minor = 0] = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8")
      .split(".")
      .map(Number);
    expect(major > 22 || (major === 22 && minor >= 18)).toBe(true);
  });

  it("Vitest runs tools/**/test/**/*.test.ts and vimma-core's .ts tests", () => {
    expect(vitestConfig.test?.include).toContain("tools/**/test/**/*.test.ts");
    expect(vitestConfig.test?.include).toContain(`${CORE_TESTS}**/*.test.ts`);
  });

  describe("eslint", () => {
    const eslint = new ESLint({ cwd: ROOT });
    /** @param {string} code @param {string} [path] */
    const lint = async (code, path = "tools/test/fixtures/ts-run/sample.ts") =>
      (await eslint.lintText(code, { filePath: `${ROOT}${path}` }))[0]?.messages ?? [];

    it("lints a .ts file under tools/ with the rules a .mjs file gets", async () => {
      const code = [
        "export function f(n: number): number {",
        "  const unused: string = 'x';",
        "  return n + notDefined;",
        "}",
        "",
      ].join("\n");
      const messages = await lint(code);
      expect(messages.filter((m) => m.fatal)).toEqual([]);
      expect(messages.map((m) => [m.ruleId, m.line, m.column])).toEqual([
        ["no-unused-vars", 2, 9],
        ["no-undef", 3, 14],
      ]);
      // The same code without its types gets the same findings in a .mjs file.
      const plain = code.replace(": number): number", ")").replace(": string", "");
      const mjs = await lint(plain, "tools/test/fixtures/ts-run/sample.mjs");
      expect(mjs.map((m) => m.ruleId)).toEqual(["no-unused-vars", "no-undef"]);
    });

    it("lints Node's globals as defined, and a typed clean file as clean", async () => {
      const code = "export const cwd: string = process.cwd();\n";
      expect(await lint(code)).toEqual([]);
    });

    it("lints a vimma-core test written as .ts as it lints tools/", async () => {
      const code = "const unused: string = process.cwd();\nexport const n: number = 1;\n";
      const messages = await lint(code, `${CORE_TESTS}sample.test.ts`);
      expect(messages.map((m) => [m.ruleId, m.fatal ?? false])).toEqual([
        ["no-unused-vars", false],
      ]);
    });

    it("fails on syntax Node cannot erase, at its line and column", async () => {
      const messages = await lint("const a = 1;\nexport enum E {\n  A,\n}\nexport { a };\n");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        fatal: true,
        line: 2,
        column: 8,
        message: expect.stringMatching(/enum is not supported in strip-only mode/),
      });
    });
  });

  it("imports each relative module by the name of a file that exists, as Node needs", () => {
    // tsc accepts `./x.js` for x.ts and Vitest resolves it, but Node does not.
    // The root configs too: commitlint.config.ts imports from tools/.
    const files = execFileSync(
      "git",
      ["ls-files", "-z", "tools/**/*.ts", `${CORE_TESTS}**/*.ts`, ...ROOT_TS_CONFIGS],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\0")
      .filter((p) => p && !p.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.flatMap((file) =>
      importSpecifiers(readFileSync(join(ROOT, file), "utf8"))
        .filter((spec) => /^\.{1,2}\//.test(spec))
        .filter((spec) => !existsSync(join(ROOT, dirname(file), spec)))
        .map((spec) => `${file}: ${spec}`),
    );
    expect(missing).toEqual([]);
  });

  it("reads the imports from the program, not from strings or comments", () => {
    const code = [
      'import type { T } from "./types.ts";',
      'import { a } from "./a.ts";',
      'export { b } from "./b.ts";',
      'const c = await import("./c.ts");',
      "const e = await import(`./e.ts`);",
      '// from "./comment.mjs"',
      "const text = 'import { d } from \"./string.mjs\";';",
      "export const x: T = [a, c, e, text];",
      "",
    ].join("\n");
    expect(importSpecifiers(code)).toEqual(["./a.ts", "./b.ts", "./c.ts", "./e.ts"]);
  });

  it("keeps TypeScript in tools/ and vimma-core's tests: Firefox loads the rest unbuilt", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "*.ts", "*.mts", "*.cts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => p && !/\.d\.[mc]?ts$/.test(p));
    // The root configs whose tool loads TypeScript itself (Vite bundles vitest.config.ts,
    // commitlint loads its config through jiti) are Node-side tooling too (ADR-025).
    expect(outsideTypeScriptHomes(tracked)).toEqual([]);
  });

  it("lets only .ts through in vimma-core's tests: .mts and .cts escape tsconfig, eslint and Vitest", () => {
    const sample = [
      "tools/a/b.mts",
      `${CORE_TESTS}keys.test.ts`,
      `${CORE_TESTS}keys.test.mts`,
      `${CORE_TESTS}fuzz/harness.cts`,
    ];
    expect(outsideTypeScriptHomes(sample)).toEqual([
      `${CORE_TESTS}keys.test.mts`,
      `${CORE_TESTS}fuzz/harness.cts`,
    ]);
  });
});
