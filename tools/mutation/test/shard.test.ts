import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_MUTATE, coreFiles, mutateFor, partition, type SizedFile } from "../shard.ts";
import { tempDir } from "../../test/temp-dir.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const files = (sizes: number[]): SizedFile[] =>
  sizes.map((size, i) => ({ path: `f${String(i).padStart(2, "0")}.mjs`, size }));

describe("partition", () => {
  it("puts every file in exactly one shard", () => {
    const input = files([5, 1, 9, 3, 3, 7, 2, 8, 4, 6, 1, 1]);
    for (const shards of [1, 2, 3, 5, 12, 20]) {
      const groups = partition(input, shards);
      expect(groups).toHaveLength(shards);
      const all = groups.flat();
      expect([...all].sort()).toEqual(input.map((f) => f.path).sort());
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it("gives the same shards for the same files in any order", () => {
    const input = files([5, 1, 9, 3, 3, 7, 2, 8, 4, 6]);
    expect(partition([...input].reverse(), 4)).toEqual(partition(input, 4));
    expect(partition(input, 4)).toEqual(partition(input, 4));
  });

  it("balances bytes: no shard exceeds the mean by more than the largest file", () => {
    const sizes = [40, 52, 62, 65, 13, 12, 12, 30, 22, 18, 9, 9, 8, 7, 5, 5, 4, 3, 2, 1];
    const input = files(sizes);
    const size = new Map(input.map((f) => [f.path, f.size]));
    for (const shards of [2, 3, 4, 6]) {
      const bytes = partition(input, shards).map((g) =>
        g.reduce((s, p) => s + (size.get(p) ?? 0), 0),
      );
      const mean = sizes.reduce((a, b) => a + b) / shards;
      expect(Math.max(...bytes) - mean).toBeLessThanOrEqual(Math.max(...sizes));
      expect(Math.min(...bytes)).toBeGreaterThan(0);
    }
  });

  it("splits two halves evenly", () => {
    expect(partition(files([4, 3, 2, 1]), 2)).toEqual([
      ["f00.mjs", "f03.mjs"],
      ["f01.mjs", "f02.mjs"],
    ]);
  });

  it("refuses a shard count below 1", () => {
    expect(() => partition(files([1]), 0)).toThrow(/shards must be/);
  });
});

describe("coreFiles and mutateFor", () => {
  it("lists the core's .mjs sources, sorted, without vendor/", () => {
    const dir = tempDir("vimma-shard-");
    const src = join(dir, "packages/vimma-core/src");
    for (const sub of ["keys", "vendor/smol-toml"]) mkdirSync(join(src, sub), { recursive: true });
    writeFileSync(join(src, "keys/b.mjs"), "bb");
    writeFileSync(join(src, "a.mjs"), "a");
    writeFileSync(join(src, "notes.md"), "x");
    writeFileSync(join(src, "vendor/smol-toml/index.mjs"), "v");
    expect(coreFiles(dir)).toEqual([
      { path: "packages/vimma-core/src/a.mjs", size: 1 },
      { path: "packages/vimma-core/src/keys/b.mjs", size: 2 },
    ]);
  });

  it("mutates the whole core without a shard, and its shards cover the same files", () => {
    expect(mutateFor(root, {})).toEqual(CORE_MUTATE);
    const all = coreFiles(root).map((f) => f.path);
    expect(all.length).toBeGreaterThan(50);
    const shards = 20;
    const union = Array.from({ length: shards }, (_, i) =>
      mutateFor(root, { MUTATION_SHARD: String(i + 1), MUTATION_SHARDS: String(shards) }),
    ).flat();
    expect([...union].sort()).toEqual(all);
  });

  it("refuses a shard left without files", () => {
    const dir = tempDir("vimma-shard-");
    mkdirSync(join(dir, "packages/vimma-core/src"), { recursive: true });
    writeFileSync(join(dir, "packages/vimma-core/src/a.mjs"), "a");
    writeFileSync(join(dir, "packages/vimma-core/src/b.mjs"), "b");
    expect(mutateFor(dir, { MUTATION_SHARD: "2", MUTATION_SHARDS: "2" })).toEqual([
      "packages/vimma-core/src/b.mjs",
    ]);
    expect(() => mutateFor(dir, { MUTATION_SHARD: "3", MUTATION_SHARDS: "3" })).toThrow(
      "shard 3 of 3 has no file: too many shards",
    );
  });

  it("refuses a shard outside 1..shards", () => {
    for (const [k, n] of [
      ["0", "4"],
      ["5", "4"],
      ["x", "4"],
      ["1", undefined],
    ]) {
      expect(() => mutateFor(root, { MUTATION_SHARD: k, MUTATION_SHARDS: n })).toThrow(
        /need 1 ≤ shard ≤ shards/,
      );
    }
  });
});
