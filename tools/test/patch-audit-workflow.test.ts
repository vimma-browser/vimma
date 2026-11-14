import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/security/10-firefox-updates.md G8, docs/rebase.md "Patch-size audit": the quarterly patch
// audit's workflow shape. Text checks, like upstream-workflow.test.mjs: no YAML dependency.
const text = readFileSync(
  new URL("../../.github/workflows/patch-audit.yml", import.meta.url),
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

describe("quarterly patch audit workflow", () => {
  it("runs on the first day of each quarter, and by hand", () => {
    expect(text).toMatch(/^ {4}- cron: "\d+ \d+ 1 1,4,7,10 \*"/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request\w*):/m);
  });

  it("grants nothing by default; issues: write only in the report job", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(permissions(job("audit"))).toEqual(["contents: read"]);
    expect(permissions(job("report"))).toEqual(["issues: write"]);
  });

  it("the job holding the issue token never checks out or runs repository code", () => {
    const report = job("report");
    expect(report).not.toContain("actions/checkout");
    expect(report).not.toContain("patch-audit.py");
    expect(job("audit")).toContain("persist-credentials: false");
  });

  it("audits register, budgets and review age, and the report opens an upstream audit issue", () => {
    expect(job("audit")).toMatch(/python3 tools\/upstream\/patch-audit\.py .*--markdown/);
    const report = job("report");
    expect(report).toMatch(/gh issue create [^\n]*--label upstream,audit/);
    expect(report).toContain("gh label create upstream");
    expect(report).toContain("gh label create audit");
  });

  it("a failed audit still opens the issue, then fails the run", () => {
    expect(job("report")).toMatch(
      /if: \$\{\{ !cancelled\(\) && needs\.audit\.result == 'success' \}\}/,
    );
    expect(job("report")).toMatch(/exit 1/);
  });

  it("stays tiny: no npm or toolchain install, short timeouts, no secret", () => {
    expect(text).not.toMatch(/npm (ci|install)|setup-node|setup-python|rustup/);
    expect(text).not.toContain("secrets.");
    for (const m of text.matchAll(/timeout-minutes: (\d+)/g))
      expect(Number(m[1])).toBeLessThanOrEqual(5);
  });

  it("every action it uses is pinned by a full commit SHA", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
