import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyShard, manifestTests, shardTests } from "../mochitest-shards.ts";

// The macOS mochitest job runs as two shards (issue #1569, docs/runbook/ci-macos-mochitests.md).
// The split is by file, balanced on the measured per-file times in tools/mochitest-times.json.
const MANIFEST = readFileSync(new URL("../../tests/browser/browser.toml", import.meta.url), "utf8");
const TIMES = JSON.parse(
  readFileSync(new URL("../mochitest-times.json", import.meta.url), "utf8"),
) as Record<string, number>;

const toml = `[DEFAULT]
support-files = ["head.js"]

["browser_vimma_a.js"]
support-files = ["file_vimma_a.html"]

["browser_vimma_b.js"]
skip-if = ["os == 'mac'"] # #1

["browser_vimma_c.js"]

["browser_vimma_d.js"]
`;

describe("manifestTests", () => {
  it("lists the manifest's test files in order, without DEFAULT or support files", () => {
    expect(manifestTests(toml)).toEqual([
      "browser_vimma_a.js",
      "browser_vimma_b.js",
      "browser_vimma_c.js",
      "browser_vimma_d.js",
    ]);
  });

  it("finds every browser_*.js section of the real manifest", () => {
    const sections = MANIFEST.match(/^\["browser_[^"]+\.js"\]$/gm) ?? [];
    expect(manifestTests(MANIFEST)).toHaveLength(sections.length);
    expect(sections.length).toBeGreaterThan(100);
  });
});

describe("shardTests", () => {
  it("puts the longest files first on the least loaded shard", () => {
    const times = { "browser_vimma_a.js": 10, "browser_vimma_b.js": 6, "browser_vimma_c.js": 5 };
    const files = manifestTests(toml);
    // d has no time, so it counts as the median, 6. a goes to 1, b to 2, d to 2 (6 < 10), c to 1.
    expect(shardTests(files, times, 1, 2)).toEqual(["browser_vimma_a.js", "browser_vimma_c.js"]);
    expect(shardTests(files, times, 2, 2)).toEqual(["browser_vimma_b.js", "browser_vimma_d.js"]);
  });

  it("splits the real manifest into disjoint shards that cover every file", () => {
    const files = manifestTests(MANIFEST);
    const one = shardTests(files, TIMES, 1, 2);
    const two = shardTests(files, TIMES, 2, 2);
    expect([...one, ...two].sort()).toEqual([...files].sort());
    expect(one.filter((f) => two.includes(f))).toEqual([]);
  });

  it("balances the measured times within 2 %", () => {
    const files = manifestTests(MANIFEST);
    const load = (n: number) =>
      shardTests(files, TIMES, n, 2).reduce((s, f) => s + (TIMES[f] ?? 0), 0);
    const [a, b] = [load(1), load(2)];
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.02);
  });

  it("puts a new file, with no measured time, in exactly one shard", () => {
    const files = [...manifestTests(MANIFEST), "browser_vimma_zz_new.js"];
    const hits = [1, 2].filter((n) =>
      shardTests(files, TIMES, n, 2).includes("browser_vimma_zz_new.js"),
    );
    expect(hits).toHaveLength(1);
  });

  it("is the same split whatever the order of the times table's keys", () => {
    const files = manifestTests(MANIFEST);
    const reversed = Object.fromEntries(Object.entries(TIMES).reverse());
    expect(shardTests(files, reversed, 1, 2)).toEqual(shardTests(files, TIMES, 1, 2));
  });

  it("keeps the manifest's order within a shard", () => {
    const files = manifestTests(MANIFEST);
    const one = shardTests(files, TIMES, 1, 2);
    expect(one).toEqual(files.filter((f) => one.includes(f)));
  });
});

describe("applyShard", () => {
  it("replaces --shard=N/M with the shard's test paths", () => {
    const times = { "browser_vimma_a.js": 10, "browser_vimma_b.js": 6, "browser_vimma_c.js": 5 };
    expect(applyShard(["--artifact", "--shard=2/2", "--verbose"], toml, times)).toEqual([
      "--artifact",
      "--verbose",
      "tests/browser/browser_vimma_b.js",
      "tests/browser/browser_vimma_d.js",
    ]);
  });

  it("leaves arguments without --shard alone", () => {
    expect(applyShard(["--artifact", "tests/browser/"], toml, {})).toEqual([
      "--artifact",
      "tests/browser/",
    ]);
  });

  it("refuses a shard out of range or malformed", () => {
    for (const bad of ["--shard=0/2", "--shard=3/2", "--shard=1", "--shard=a/b", "--shard=1/0"]) {
      expect(() => applyShard([bad], toml, {}), bad).toThrow(/--shard/);
    }
  });

  it("refuses a shard together with test paths", () => {
    expect(() => applyShard(["--shard=1/2", "tests/browser/"], toml, {})).toThrow(/--shard/);
  });
});
