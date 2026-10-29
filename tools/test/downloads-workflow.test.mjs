import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// #647, docs/runbook.md "Release download counts": the daily snapshot workflow's shape. Text
// checks, like spec-status-workflow.test.mjs: no YAML dependency.
const text = readFileSync(
  new URL("../../.github/workflows/downloads.yml", import.meta.url),
  "utf8",
);

/**
 * @param {string} id a job id
 * @returns {string} that job's YAML block
 */
function job(id) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

/** @param {string} block @returns {string[]} the job's `permissions:` lines, comments dropped */
function permissions(block) {
  const m = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+.*\n)+)/m.exec(block);
  if (!m?.[1]) return [];
  return m[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim());
}

describe("release downloads workflow", () => {
  it("runs once a day and by hand, never on a pull request or a push", () => {
    expect(text).toMatch(/^ {4}- cron: "\d+ \d+ \* \* \*"/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:/m);
    expect(text).not.toMatch(/^ {2}(pull_request\w*|push):/m);
  });

  it("grants nothing by default; reads in collect, writes contents only in record", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(permissions(job("collect"))).toEqual(["contents: read"]);
    expect(permissions(job("record"))).toEqual(["contents: write"]);
  });

  it("collect runs the script without a stored credential", () => {
    const collect = job("collect");
    expect(collect).toContain("persist-credentials: false");
    expect(collect).toMatch(/node tools\/stats\/downloads\.mjs collect /);
    expect(collect).toMatch(/node tools\/stats\/downloads\.mjs merge /);
  });

  it("record runs no repository code and pushes only to the stats branch", () => {
    const record = job("record");
    expect(record).not.toMatch(/\bnode\b|\bnpm\b/);
    expect(record).toMatch(/^ {10}ref: stats$/m);
    expect(record).toMatch(/git push origin HEAD:stats$/m);
    expect(text.match(/git push/g)).toHaveLength(1);
  });

  it("record only appends: the new file must begin with the recorded history", () => {
    expect(job("record")).toMatch(/cmp -s -n "\$size" downloads\.csv "\$new"/);
    expect(job("record")).toMatch(
      /if: \$\{\{ !cancelled\(\) && needs\.collect\.result == 'success' \}\}/,
    );
  });

  it("stays tiny: no npm install, short timeouts, no secret, runs in order", () => {
    expect(text).not.toMatch(/npm (ci|install)/);
    expect(text).not.toContain("secrets.");
    for (const m of text.matchAll(/timeout-minutes: (\d+)/g))
      expect(Number(m[1])).toBeLessThanOrEqual(5);
    expect(text).toMatch(/^concurrency:\n {2}group: downloads\n {2}cancel-in-progress: false$/m);
  });

  it("every action it uses is pinned by a full commit SHA", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
