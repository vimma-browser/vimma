// Stryker runs the core's tests in a sandbox copy of the repository that leaves out
// stryker.config.mjs's ignorePatterns. A core test that reads or imports a file in one of them
// passes under `npm test` and fails Stryker's dry run, which breaks the weekly mutation run
// (#975). This test finds the repository files the core's tests reach and fails on any that the
// sandbox leaves out, so that breakage shows on the pull request that adds the read.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../../stryker.config.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const coreTests = join(root, "packages/vimma-core/test");
// packages/vimma-core/vitest.config.mjs, the suite Stryker runs, leaves the fuzz properties out.
const skippedDirs = new Set([join(coreTests, "fuzz")]);
const topLevel = new Set(readdirSync(root).filter((name) => name !== "node_modules"));

/** Repository-relative path with forward slashes. */
const rel = (abs: string) => relative(root, abs).split(sep).join("/");

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skippedDirs.has(path) ? [] : testFiles(path);
    return entry.name.endsWith(".mjs") ? [path] : [];
  });
}

/** Every string literal in `source`; a template literal counts up to its first `${`. */
function literals(source: string): { text: string; partial: boolean }[] {
  return [...source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(([, , text = ""]) => ({
    text: text.split("${")[0] ?? "",
    partial: text.includes("${"),
  }));
}

/** Import specifiers only: what a module loads when a test imports it. */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)(["'])([^"'\n]+)\1/g)].map(
    ([, , spec]) => spec ?? "",
  );
}

/**
 * The repository path a literal in `file` names, or null. A relative literal resolves against the
 * file's folder, one starting with a top-level folder of the repository against the root (as
 * `new URL("tools/…", root)` does) when it names something inside that folder. A template
 * literal's fixed part names its folder, so its path is cut back to the last `/`. Only existing
 * paths count. Both rules leave out test data such as `"../evil.txt"`, `"docs/a.pdf"` or `"docs/"`.
 */
function repoPath(file: string, literal: string, partial = false): string | null {
  let base: string;
  if (literal.startsWith("./") || literal.startsWith("../")) base = dirname(file);
  else if (topLevel.has(literal.split("/")[0] ?? "") && (partial || /\/./.test(literal))) {
    base = root;
  } else return null;
  const path = resolve(base, partial ? literal.replace(/[^/]*$/, "") : literal);
  if (!existsSync(path) || !path.startsWith(root) || path === resolve(root)) return null;
  return path;
}

/** The tsconfig.json files a `.ts` file is transformed under: the nearest, then its `extends`. */
function tsconfigChain(file: string): string[] {
  let dir = dirname(file);
  while (dir.startsWith(root) && !existsSync(join(dir, "tsconfig.json"))) dir = dirname(dir);
  const chain: string[] = [];
  let tsconfig: string | null = join(dir, "tsconfig.json");
  while (tsconfig && existsSync(tsconfig) && !chain.includes(tsconfig)) {
    chain.push(tsconfig);
    const { extends: parent } = JSON.parse(readFileSync(tsconfig, "utf8")) as { extends?: unknown };
    tsconfig = typeof parent === "string" ? resolve(dirname(tsconfig), parent) : null;
  }
  // A missing parent is reached too: Vitest fails on it the same way.
  if (tsconfig && !chain.includes(tsconfig)) chain.push(tsconfig);
  return chain;
}

/** Each repository path the core's tests reach, with the test file that reaches it. */
function reachedPaths(): Map<string, Set<string>> {
  const reached = new Map<string, Set<string>>();
  const queue: [string, string][] = [];
  const add = (path: string, from: string) => {
    const froms = reached.get(path) ?? new Set();
    if (froms.has(from)) return;
    reached.set(path, froms.add(from));
    if (/\.(m?js|ts)$/.test(path) && statSync(path).isFile()) queue.push([path, from]);
    if (path.endsWith(".ts")) for (const tsconfig of tsconfigChain(path)) add(tsconfig, from);
  };
  for (const file of testFiles(coreTests)) {
    const from = rel(file);
    for (const { text, partial } of literals(readFileSync(file, "utf8"))) {
      const path = repoPath(file, text, partial);
      if (path && !path.startsWith(coreTests + sep)) add(path, from);
    }
  }
  // Modules the tests import load their own relative imports in the sandbox too.
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [module, from] = next;
    if (module.startsWith(coreTests + sep)) continue;
    for (const spec of importSpecifiers(readFileSync(module, "utf8"))) {
      const path = spec.startsWith(".") ? repoPath(module, spec) : null;
      if (path) add(path, from);
    }
  }
  return reached;
}

/** The ignore pattern that keeps `path` out of the sandbox, or null. */
function ignoredBy(path: string, patterns: string[]): string | null {
  const relPath = rel(path);
  return (
    patterns.find((pattern) => {
      const anchored = pattern.slice(1);
      return relPath === anchored || relPath.startsWith(`${anchored}/`);
    }) ?? null
  );
}

describe("Stryker's sandbox (stryker.config.mjs)", () => {
  const patterns = (config.ignorePatterns ?? []).filter((p): p is string => p !== undefined);

  it("ignores only root-anchored paths, the only form this test reads", () => {
    for (const pattern of patterns) expect(pattern).toMatch(/^\/[\w.-]+(\/[\w.-]+)*$/);
  });

  it("names no tsconfig for Stryker to rewrite, which needs TypeScript's missing JS API", () => {
    expect(existsSync(join(root, config.tsconfigFile ?? "tsconfig.json"))).toBe(false);
  });

  it("finds the repository files the core's tests read and import", () => {
    const reached = [...reachedPaths().keys()].map(rel);
    expect(reached).toContain("tests/contract/control/v1");
    expect(reached).toContain("tools/vimma-ctl/src/mcp/instructions.rs");
    expect(reached).toContain("tools/gen-agent-tools.ts");
    expect(reached).toContain("tools/tsconfig.json");
  });

  it("copies every repository file the core's tests read or import", () => {
    const missing = [...reachedPaths()].flatMap(([path, froms]) => {
      const pattern = ignoredBy(path, patterns);
      return pattern
        ? [...froms].map((from) => `${from} reaches ${rel(path)}, ignored by ${pattern}`)
        : [];
    });
    expect(missing).toEqual([]);
  });
});
