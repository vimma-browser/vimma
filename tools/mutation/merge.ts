#!/usr/bin/env node
/**
 * Merges the JSON reports of the mutation run's shards (mutation.yml, tools/mutation/shard.ts)
 * into one, and prints each input's score. Usage:
 *   node tools/mutation/merge.ts [--out merged.json] report.json…
 *
 *   MUTATION_SHARD=k MUTATION_SHARDS=n node tools/mutation/merge.ts --shard --out … report.json…
 *
 * The report job merges this run's shards for tools/mutation/report.ts. Each shard merges the
 * previous run's incremental files with `--shard`, which keeps only the files of its own shard
 * (tools/mutation/shard.ts): it finds their old results even when the split has moved them, and
 * nothing else, since Stryker copies every old result outside `mutate` into its new report, and
 * a stale copy of another shard's file would then reach the merged report. Shards mutate
 * disjoint files, so a file in two inputs is an error. Test files are shared; their tests are
 * joined by id (Stryker's vitest ids are `file#name`, the same in every shard). The score table
 * goes to $GITHUB_STEP_SUMMARY when set, otherwise to stdout. Exit 0, 1 on a file in two inputs,
 * or 2 on an unreadable input.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mutateFor } from "./shard.ts";

type Test = { id: string };
type TestFile = { tests: Test[] } & Record<string, unknown>;
export type ShardReport = {
  files: Record<string, { mutants: { status: string }[] } & Record<string, unknown>>;
  testFiles?: Record<string, TestFile>;
} & Record<string, unknown>;

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/** The reports' union: every file's mutants, and every test file's tests once each. */
export function mergeReports(reports: readonly ShardReport[]): ShardReport {
  const [first] = reports;
  const out: ShardReport = { ...first, files: {} };
  const testFiles: Record<string, TestFile> = {};
  for (const report of reports) {
    for (const [path, file] of Object.entries(report.files)) {
      if (path in out.files) throw new Error(`${path} is in two reports`);
      out.files[path] = file;
    }
    for (const [path, file] of Object.entries(report.testFiles ?? {})) {
      const seen = testFiles[path];
      if (!seen) {
        testFiles[path] = { ...file, tests: [...file.tests] };
        continue;
      }
      const ids = new Set(seen.tests.map((t) => t.id));
      for (const t of file.tests) if (!ids.has(t.id)) seen.tests.push(t);
    }
  }
  if (reports.some((r) => r.testFiles)) out.testFiles = testFiles;
  else delete out.testFiles;
  return out;
}

/** `report` with only the files in `keep`; its test files stay, for Stryker's incremental mode. */
export function onlyFiles(report: ShardReport, keep: readonly string[]): ShardReport {
  const wanted = new Set(keep);
  const files = Object.fromEntries(Object.entries(report.files).filter(([p]) => wanted.has(p)));
  return { ...report, files };
}

/** Mutants, killed (timeouts included), survived (no coverage included), and the score in %. */
export function scoreOf(report: ShardReport) {
  let killed = 0;
  let survived = 0;
  let mutants = 0;
  for (const { mutants: ms } of Object.values(report.files)) {
    for (const m of ms) {
      mutants++;
      if (DETECTED.has(m.status)) killed++;
      else if (UNDETECTED.has(m.status)) survived++;
    }
  }
  const valid = killed + survived;
  return { mutants, killed, survived, score: valid ? (killed / valid) * 100 : 100 };
}

/** A Markdown table of each named report's score, then the total's. */
export function scoreTable(named: readonly [string, ShardReport][], total: ShardReport): string {
  const row = (name: string, r: ShardReport) => {
    const s = scoreOf(r);
    const cells = [name, Object.keys(r.files).length, s.mutants, s.killed, s.survived];
    return `| ${cells.join(" | ")} | ${s.score.toFixed(2)} % |`;
  };
  return [
    "| Report | Files | Mutants | Killed | Survived | Score |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...named.map(([name, r]) => row(name, r)),
    ...(named.length > 1 ? [row("**all**", total)] : []),
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const out = at === -1 ? undefined : args.splice(at, 2)[1];
  const shardAt = args.indexOf("--shard");
  if (shardAt !== -1) args.splice(shardAt, 1);
  const named: [string, ShardReport][] = [];
  try {
    const keep =
      shardAt === -1
        ? undefined
        : mutateFor(fileURLToPath(new URL("../../", import.meta.url)), {
            MUTATION_SHARD: process.env.MUTATION_SHARD ?? "",
            MUTATION_SHARDS: process.env.MUTATION_SHARDS ?? "",
          });
    for (const path of args) {
      const report: ShardReport = JSON.parse(readFileSync(path, "utf8"));
      named.push([path, keep ? onlyFiles(report, keep) : report]);
    }
  } catch (e) {
    console.error(`mutation merge: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  let total: ShardReport;
  try {
    total = mergeReports(named.map(([, r]) => r));
  } catch (e) {
    console.error(`mutation merge: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  if (out) writeFileSync(out, JSON.stringify(total));
  const table = scoreTable(named, total);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  else process.stdout.write(table);
}
