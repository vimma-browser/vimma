import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeReports, onlyFiles, scoreOf, scoreTable, type ShardReport } from "../merge.ts";
import { coreFiles, partition } from "../shard.ts";
import { tempDir } from "../../test/temp-dir.mjs";

const script = fileURLToPath(new URL("../merge.ts", import.meta.url));

const file = (...statuses: string[]) => ({
  language: "javascript",
  source: "",
  mutants: statuses.map((status, i) => ({ id: `${i}`, status })),
});
const tests = (...ids: string[]) => ({ source: "", tests: ids.map((id) => ({ id, name: id })) });

const shard1: ShardReport = {
  schemaVersion: "2",
  thresholds: { high: 80, low: 60 },
  files: { "src/a.mjs": file("Killed", "Survived", "Timeout", "Ignored") },
  testFiles: { "test/a.test.mjs": tests("a#one", "a#two"), "test/c.test.mjs": tests("c#x") },
};
const shard2: ShardReport = {
  schemaVersion: "2",
  thresholds: { high: 80, low: 60 },
  files: { "src/b.mjs": file("Killed", "NoCoverage") },
  testFiles: { "test/a.test.mjs": tests("a#two", "a#three") },
};

describe("mergeReports", () => {
  it("keeps every shard's files and joins shared test files by test id", () => {
    const merged = mergeReports([shard1, shard2]);
    expect(Object.keys(merged.files).sort()).toEqual(["src/a.mjs", "src/b.mjs"]);
    expect(merged.schemaVersion).toBe("2");
    expect(merged.testFiles?.["test/a.test.mjs"]?.tests.map((t) => t.id)).toEqual([
      "a#one",
      "a#two",
      "a#three",
    ]);
    expect(merged.testFiles?.["test/c.test.mjs"]?.tests).toHaveLength(1);
  });

  it("does not change its inputs", () => {
    const before = JSON.stringify([shard1, shard2]);
    mergeReports([shard1, shard2]);
    expect(JSON.stringify([shard1, shard2])).toBe(before);
  });

  it("refuses a file that two reports both have", () => {
    expect(() => mergeReports([shard1, shard1])).toThrow("src/a.mjs is in two reports");
  });

  it("keeps only the named files, and every test file, with onlyFiles", () => {
    const kept = onlyFiles(mergeReports([shard1, shard2]), ["src/b.mjs", "src/gone.mjs"]);
    expect(Object.keys(kept.files)).toEqual(["src/b.mjs"]);
    expect(Object.keys(kept.testFiles ?? {}).sort()).toEqual([
      "test/a.test.mjs",
      "test/c.test.mjs",
    ]);
  });

  it("leaves testFiles out when no input has them", () => {
    expect(mergeReports([{ files: shard2.files }])).toEqual({ files: shard2.files });
  });
});

describe("scoreOf and scoreTable", () => {
  it("counts timeouts as killed, no coverage as survived, and ignored as neither", () => {
    expect(scoreOf(shard1)).toEqual({ mutants: 4, killed: 2, survived: 1, score: (2 / 3) * 100 });
    expect(scoreOf(mergeReports([shard1, shard2]))).toMatchObject({ killed: 3, survived: 2 });
    expect(scoreOf({ files: {} }).score).toBe(100);
  });

  it("lists each shard and the total", () => {
    const table = scoreTable(
      [
        ["shard 1", shard1],
        ["shard 2", shard2],
      ],
      mergeReports([shard1, shard2]),
    );
    expect(table).toContain("| shard 1 | 1 | 4 | 2 | 1 | 66.67 % |");
    expect(table).toContain("| shard 2 | 1 | 2 | 1 | 1 | 50.00 % |");
    expect(table).toContain("| **all** | 2 | 6 | 3 | 2 | 60.00 % |");
  });
});

describe("the command line", () => {
  it("writes the merged report and the table to the step summary", () => {
    const dir = tempDir("vimma-merge-");
    const [a, b, out, summary] = ["1.json", "2.json", "out.json", "summary.md"].map((f) =>
      join(dir, f),
    );
    writeFileSync(a!, JSON.stringify(shard1));
    writeFileSync(b!, JSON.stringify(shard2));
    writeFileSync(summary!, "");
    const r = spawnSync(process.execPath, [script, "--out", out!, a!, b!], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(Object.keys(JSON.parse(readFileSync(out!, "utf8")).files)).toHaveLength(2);
    expect(readFileSync(summary!, "utf8")).toContain("| **all** | 2 | 6 | 3 | 2 | 60.00 % |");
  });

  it("keeps only this shard's files with --shard", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const [mine = [], other = []] = partition(coreFiles(root), 2);
    const previous = {
      files: Object.fromEntries([mine[0], other[0]].map((p) => [p, file("Killed")])),
    };
    const dir = tempDir("vimma-merge-");
    const [input, out] = ["in.json", "out.json"].map((f) => join(dir, f));
    writeFileSync(input!, JSON.stringify(previous));
    const r = spawnSync(process.execPath, [script, "--shard", "--out", out!, input!], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", MUTATION_SHARD: "1", MUTATION_SHARDS: "2" },
    });
    expect(r.stderr).toBe("");
    expect(Object.keys(JSON.parse(readFileSync(out!, "utf8")).files)).toEqual([mine[0]]);
    const bad = spawnSync(process.execPath, [script, "--shard", input!], {
      encoding: "utf8",
      env: { ...process.env, MUTATION_SHARD: "", MUTATION_SHARDS: "" },
    });
    expect(bad.status).toBe(2);
  });

  it("exits 1 when two reports have the same file", () => {
    const dir = tempDir("vimma-merge-");
    const a = join(dir, "a.json");
    writeFileSync(a, JSON.stringify(shard1));
    const r = spawnSync(process.execPath, [script, a, a], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/src\/a\.mjs is in two reports/);
  });

  it("exits 2 on an unreadable report", () => {
    const r = spawnSync(process.execPath, [script, "/nonexistent/report.json"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/mutation merge:/);
  });
});
