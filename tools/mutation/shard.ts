#!/usr/bin/env node
/**
 * Splits Stryker's `mutate` list into shards, so the weekly mutation run (mutation.yml) runs as a
 * matrix of jobs that each fit the 180-minute job limit (#975). stryker.config.mjs calls
 * `mutateFor` with MUTATION_SHARD (1-based) and MUTATION_SHARDS from the environment; without
 * them it mutates the whole core.
 *
 * The split is deterministic and balanced by file size, a stand-in for the mutant count (about
 * one mutant per 35 bytes in the core): files go largest first, ties by path, each to the shard
 * with the fewest bytes so far, ties to the lowest shard. The same tree always gives the same
 * shards; a new or grown file can move others, which costs only incremental reuse, since each
 * shard reads the results of every shard of the previous run (tools/mutation/merge.ts).
 *
 *   node tools/mutation/shard.ts 24   # print each shard's files and size
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What Stryker mutates: the core's sources, not the vendored smol-toml. */
export const CORE_SRC = "packages/vimma-core/src";
export const CORE_MUTATE = [`${CORE_SRC}/**/*.mjs`, `!${CORE_SRC}/vendor/**`];

export type SizedFile = { path: string; size: number };

/** Every file `CORE_MUTATE` matches under `root`, repository-relative, with its size in bytes. */
export function coreFiles(root: string): SizedFile[] {
  const out: SizedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, CORE_SRC, "vendor")) walk(path);
      } else if (entry.name.endsWith(".mjs")) {
        out.push({ path: relative(root, path).split(sep).join("/"), size: statSync(path).size });
      }
    }
  };
  walk(join(root, CORE_SRC));
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `files` in `shards` groups of about equal total size; each group sorted by path. */
export function partition(files: readonly SizedFile[], shards: number): string[][] {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be ≥ 1: ${shards}`);
  const order = [...files].sort(
    (a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const groups = Array.from({ length: shards }, () => ({ bytes: 0, paths: [] as string[] }));
  for (const file of order) {
    let least = groups[0];
    for (const g of groups) if (g.bytes < (least?.bytes ?? 0)) least = g;
    least?.paths.push(file.path);
    if (least) least.bytes += file.size;
  }
  return groups.map((g) => g.paths.sort());
}

/**
 * Stryker's `mutate` for this job: one shard's files when `env` names a shard
 * (MUTATION_SHARD=k of MUTATION_SHARDS=n, 1 ≤ k ≤ n), otherwise the whole core. Throws on a
 * shard without files (more shards than files).
 */
export function mutateFor(root: string, env: Record<string, string | undefined>): string[] {
  const { MUTATION_SHARD: k, MUTATION_SHARDS: n } = env;
  if (k === undefined && n === undefined) return CORE_MUTATE;
  const shard = Number(k);
  const shards = Number(n);
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 1 || shard > shards) {
    throw new Error(`MUTATION_SHARD=${k} MUTATION_SHARDS=${n}: need 1 ≤ shard ≤ shards`);
  }
  const files = partition(coreFiles(root), shards)[shard - 1] ?? [];
  // Stryker given an empty `mutate` tests nothing and still passes: fail instead.
  if (!files.length) throw new Error(`shard ${shard} of ${shards} has no file: too many shards`);
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shards = Number(process.argv[2] ?? "1");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = coreFiles(root);
  const size = new Map(files.map((f) => [f.path, f.size]));
  partition(files, shards).forEach((paths, i) => {
    const bytes = paths.reduce((s, p) => s + (size.get(p) ?? 0), 0);
    console.log(`shard ${i + 1}/${shards}: ${paths.length} files, ${bytes} bytes`);
    for (const p of paths) console.log(`  ${p}`);
  });
}
