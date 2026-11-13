/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import vitestConfig from "../../vitest.config.mjs";

// ADR-025: tools/ may be TypeScript that Node runs as it is, by erasing the types. These pin what
// that needs from Node, Vitest and eslint; tools/test/typecheck.test.mjs pins tsc's side.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/ts-run/main.ts", import.meta.url));

describe("TypeScript under tools/ (ADR-025)", () => {
  it("Node runs a .ts file with no flag, and writes nothing to stderr", () => {
    const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
    // Tools' tests compare stderr, so an ExperimentalWarning there would break them.
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("doubled 4\n");
    expect(run.status).toBe(0);
  });

  it("package.json asks for a Node that does that: 22.18 or later", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.engines.node).toBe(">=22.18");
    const [major = 0, minor = 0] = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8")
      .split(".")
      .map(Number);
    expect(major > 22 || (major === 22 && minor >= 18)).toBe(true);
  });

  it("Vitest runs tools/**/test/**/*.test.ts", () => {
    expect(vitestConfig.test?.include).toContain("tools/**/test/**/*.test.ts");
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

    it("fails on syntax Node cannot erase", async () => {
      const messages = await lint("export enum E {\n  A,\n}\n");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.fatal).toBe(true);
    });
  });

  it("imports each relative module by the name of a file that exists, as Node needs", () => {
    // tsc accepts `./x.js` for x.ts and Vitest resolves it, but Node does not.
    const files = execFileSync("git", ["ls-files", "-z", "tools/**/*.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => p && !p.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(0);
    const missing = files.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), "utf8");
      const specs = [...text.matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)];
      return specs
        .map((m) => m[1] ?? "")
        .filter((spec) => !existsSync(join(ROOT, dirname(file), spec)))
        .map((spec) => `${file}: ${spec}`);
    });
    expect(missing).toEqual([]);
  });

  it("keeps TypeScript in tools/: Firefox and vimma-core load their files unbuilt", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "*.ts", "*.mts", "*.cts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter((p) => p && !/\.d\.[mc]?ts$/.test(p));
    expect(tracked.filter((p) => !p.startsWith("tools/"))).toEqual([]);
  });
});
