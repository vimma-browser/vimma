import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOTS, classify, releasePath } from "../release-path.mjs";
import { jobs } from "../../test/workflow-runners.mjs";

// docs/specs/build-supply-chain.md, decisions 13 to 15; docs/security.md, B3. Every package the
// release build runs is computed from package-lock.json, and a Dependabot change to any of them
// waits for a person.
const root = new URL("../../../", import.meta.url);
/** @param {string} path */
const read = (path) => readFileSync(new URL(path, root), "utf8");
const cli = new URL("../release-path.mjs", import.meta.url).pathname;

/**
 * @param {string} name
 * @param {string} version
 * @param {Record<string, unknown>} [extra]
 */
const entry = (name, version, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  ...extra,
});

/** A small lockfile: Surfer and ajv with transitive, nested and optional packages, and others. */
const fixture = () => ({
  name: "fixture",
  lockfileVersion: 3,
  packages: {
    "": {
      devDependencies: { "@zen-browser/surfer": "1.14.9", ajv: "^8", vitest: "^5" },
    },
    "node_modules/@zen-browser/surfer": entry("@zen-browser/surfer", "1.14.9", {
      dependencies: { chalk: "^4", tar: "^6" },
      optionalDependencies: { fsevents: "^2" },
    }),
    "node_modules/chalk": entry("chalk", "4.1.2", { dependencies: { "ansi-styles": "^4" } }),
    "node_modules/ansi-styles": entry("ansi-styles", "4.3.0"),
    "node_modules/tar": entry("tar", "6.2.1", { dependencies: { minipass: "^5" } }),
    // Nested: tar gets its own minipass, the top-level one belongs to vitest.
    "node_modules/tar/node_modules/minipass": entry("minipass", "5.0.0"),
    "node_modules/minipass": entry("minipass", "7.1.2"),
    "node_modules/ajv": entry("ajv", "8.20.0", { dependencies: { "fast-uri": "^3" } }),
    "node_modules/fast-uri": entry("fast-uri", "3.0.6"),
    "node_modules/vitest": entry("vitest", "5.0.3", {
      dependencies: { minipass: "^7", "ansi-styles": "^4" },
    }),
  },
});

/**
 * @param {ReturnType<typeof fixture>} lock
 * @param {string} key
 * @param {Record<string, unknown>} change
 */
const bump = (lock, key, change) => {
  const next = structuredClone(lock);
  next.packages[key] = { ...next.packages[key], ...change };
  return next;
};

describe("release path", () => {
  it("the release path is Surfer, ajv and everything they depend on", () => {
    expect(ROOTS).toEqual(["@zen-browser/surfer", "ajv"]);
    expect([...releasePath(fixture())].sort()).toEqual([
      "node_modules/@zen-browser/surfer",
      "node_modules/ajv",
      "node_modules/ansi-styles",
      "node_modules/chalk",
      "node_modules/fast-uri",
      "node_modules/tar",
      "node_modules/tar/node_modules/minipass",
    ]);
    // An optional dependency that is installed is on the path too.
    const withOptional = structuredClone(fixture());
    withOptional.packages["node_modules/fsevents"] = entry("fsevents", "2.3.3", { optional: true });
    expect(releasePath(withOptional)).toContain("node_modules/fsevents");
    // A missing required dependency means the lockfile is not what it seems: refuse.
    const broken = structuredClone(fixture());
    delete broken.packages["node_modules/fast-uri"];
    expect(() => releasePath(broken)).toThrow(/fast-uri/);

    // The real lockfile: Surfer's own closure is in, the test tools are out.
    const real = releasePath(JSON.parse(read("package-lock.json")));
    expect(real).toContain("node_modules/@zen-browser/surfer");
    expect(real).toContain("node_modules/ajv");
    expect(real).not.toContain("node_modules/vitest");
    expect(real).not.toContain("node_modules/eslint");
    expect(real.size).toBeGreaterThan(100);
  });

  it("the roots cover every package the release build job imports", () => {
    const lock = JSON.parse(read("package-lock.json"));
    /** @type {Map<string, string>} executable name -> top-level package */
    const bins = new Map();
    for (const [key, value] of Object.entries(lock.packages)) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m?.[1] && value.bin) for (const bin of Object.keys(value.bin)) bins.set(bin, m[1]);
    }
    const scripts = JSON.parse(read("package.json")).scripts;
    const steps = jobs(read(".github/workflows/release.yml")).get("build")?.steps;
    if (!Array.isArray(steps)) throw new Error("release.yml: the build job has no steps");

    /** @type {Set<string>} */
    const packages = new Set();
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {{ shell: boolean, text: string }[]} */
    const texts = steps.map((step) => ({
      shell: true,
      text: typeof step.run === "string" ? step.run : "",
    }));
    while (texts.length > 0) {
      const next = texts.pop();
      const text = String(next?.text).replace(/(^|\s)#.*$/gm, "$1");
      // Executables from node_modules/.bin, in shell text (steps, npm scripts, .sh files).
      if (next?.shell) {
        for (const m of text.matchAll(/(?:^|[\s;&|(`])([\w@.-]+)(?=\s|$)/gm)) {
          const pkg = m[1] && bins.get(m[1]);
          if (pkg) packages.add(pkg);
        }
      }
      for (const m of next?.shell ? text.matchAll(/\bnpm run ([\w:-]+)/g) : []) {
        const name = m[1] ?? "";
        if (!seen.has(`script:${name}`)) {
          seen.add(`script:${name}`);
          expect(scripts[name], `npm run ${name}`).toBeTypeOf("string");
          texts.push({ shell: true, text: scripts[name] });
        }
      }
      // Our own scripts and modules, followed through their relative imports.
      for (const m of text.matchAll(/(?:\.\/|\b)(tools\/[\w/.-]+\.(?:mjs|js|sh))\b/g)) {
        const path = m[1] ?? "";
        if (!seen.has(path) && existsSync(new URL(path, root))) {
          seen.add(path);
          texts.push({ shell: path.endsWith(".sh"), text: read(path) });
        }
      }
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        const spec = m[1] ?? "";
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) {
          packages.add(/^(@[^/]+\/)?[^/]+/.exec(spec)?.[0] ?? spec);
        }
      }
    }
    // Relative imports resolve against the importing file, so walk them from each module.
    /** @type {string[]} */
    const modules = [...seen].filter((p) => /\.m?js$/.test(p));
    while (modules.length > 0) {
      const path = String(modules.pop());
      for (const m of read(path).matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)) {
        const target = new URL(m[1] ?? "", new URL(path, root)).pathname.slice(
          new URL(root).pathname.length,
        );
        if (seen.has(target)) continue;
        seen.add(target);
        modules.push(target);
        for (const b of read(target).matchAll(/(?:from|import)\s*\(?\s*"([^".][^"]*)"/g)) {
          const spec = b[1] ?? "";
          if (!spec.startsWith("node:")) packages.add(/^(@[^/]+\/)?[^/]+/.exec(spec)?.[0] ?? spec);
        }
      }
    }
    // Surfer through npx and npm run import, ajv through validate-sbom.mjs.
    expect(packages).toContain("@zen-browser/surfer");
    expect(packages).toContain("ajv");
    expect([...packages].filter((p) => !ROOTS.includes(p))).toEqual([]);
  });

  it("a changed release-path package needs review, security updates included", () => {
    const base = fixture();
    for (const change of [
      { version: "1.14.10" },
      { resolved: "https://example.com/surfer.tgz" },
      { integrity: "sha512-other" },
    ]) {
      const result = classify(base, bump(base, "node_modules/@zen-browser/surfer", change));
      expect(result.decision, JSON.stringify(change)).toBe("review");
      expect(result.packages.map((p) => p.name)).toEqual(["@zen-browser/surfer"]);
    }
    const ajv = classify(base, bump(base, "node_modules/ajv", { version: "8.20.1" }));
    expect(ajv.decision).toBe("review");
    expect(ajv.packages).toEqual([
      { name: "ajv", key: "node_modules/ajv", old: "8.20.0", new: "8.20.1", diff: true },
    ]);
  });

  it("a change only outside the release path may auto-merge", () => {
    const base = fixture();
    expect(classify(base, structuredClone(base))).toEqual({ decision: "merge", packages: [] });
    const head = bump(base, "node_modules/vitest", { version: "5.0.4" });
    head.packages["node_modules/minipass"] = entry("minipass", "7.1.3");
    expect(classify(base, head)).toEqual({ decision: "merge", packages: [] });
  });

  it("a transitive release-path package bumped in a grouped update needs review", () => {
    const base = fixture();
    // A grouped update that names only vitest also moves a package Surfer depends on.
    let head = bump(base, "node_modules/vitest", { version: "5.0.4" });
    head = bump(head, "node_modules/tar/node_modules/minipass", { version: "5.0.1" });
    expect(classify(base, head)).toEqual({
      decision: "review",
      packages: [
        {
          name: "minipass",
          key: "node_modules/tar/node_modules/minipass",
          old: "5.0.0",
          new: "5.0.1",
          diff: true,
        },
      ],
    });
    // A package new to the release path in the head lockfile counts too, with nothing to diff.
    const added = structuredClone(base);
    added.packages["node_modules/chalk"].dependencies = { "ansi-styles": "^4", "has-flag": "^4" };
    added.packages["node_modules/has-flag"] = entry("has-flag", "4.0.0");
    expect(classify(base, added)).toEqual({
      decision: "review",
      packages: [
        { name: "has-flag", key: "node_modules/has-flag", old: null, new: "4.0.0", diff: false },
      ],
    });
  });

  it("only registry names and exact versions are handed to npm diff", () => {
    const base = fixture();
    for (const version of ["file:../evil", "git+https://example.com/x.git", "1.0.0 --x", "^1"]) {
      const result = classify(base, bump(base, "node_modules/ajv", { version }));
      expect(result.decision).toBe("review");
      expect(result.packages[0]?.diff, version).toBe(false);
    }
    const aliased = structuredClone(base);
    aliased.packages["node_modules/ajv"] = entry("ajv", "8.20.1", { name: "--registry=x" });
    expect(classify(base, aliased).packages[0]).toMatchObject({
      name: "--registry=x",
      diff: false,
    });
  });

  it("the CLI prints the decision for two lockfiles", () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-release-path-"));
    try {
      const base = fixture();
      writeFileSync(join(dir, "base.json"), JSON.stringify(base));
      writeFileSync(
        join(dir, "head.json"),
        JSON.stringify(bump(base, "node_modules/ajv", { version: "8.20.1" })),
      );
      const out = execFileSync(
        "node",
        [cli, "--diff", join(dir, "base.json"), join(dir, "head.json")],
        { encoding: "utf8" },
      );
      expect(JSON.parse(out)).toMatchObject({ decision: "review", packages: [{ name: "ajv" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
