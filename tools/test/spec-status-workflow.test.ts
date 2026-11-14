import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/specs/README.md, "Keeping statuses current": the daily spec-status workflow's shape.
// Text checks, like patch-audit-workflow.test.ts: no YAML dependency.
const text = readFileSync(
  new URL("../../.github/workflows/spec-status.yml", import.meta.url),
  "utf8",
);

/**
 * @param id a job id
 * @returns that job's YAML block
 */
function job(id: string): string {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

/** @returns the job's `permissions:` lines, comments dropped */
function permissions(block: string): string[] {
  const m = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+.*\n)+)/m.exec(block);
  if (!m?.[1]) return [];
  return m[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim());
}

describe("spec status workflow", () => {
  it("runs daily, when an issue closes or reopens, when specs change on main, and by hand", () => {
    expect(text).toMatch(/^ {4}- cron: "\d+ \d+ \* \* \*"/m);
    expect(text).toMatch(/^ {2}issues:\n {4}types: \[closed, reopened\]/m);
    expect(text).toMatch(/^ {2}push:\n {4}branches: \[main\]\n {4}paths: \["docs\/specs\/\*\*"\]/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:/m);
    expect(text).not.toMatch(/^ {2}pull_request\w*:/m);
  });

  it("grants nothing by default; reads in check, writes issues only in report", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(permissions(job("check"))).toEqual(["contents: read", "issues: read"]);
    expect(permissions(job("report"))).toEqual(["issues: write"]);
  });

  it("the job holding the issue token never checks out or runs repository code", () => {
    const report = job("report");
    expect(report).not.toContain("actions/checkout");
    expect(report).not.toMatch(/\bnode\b/);
    expect(job("check")).toContain("persist-credentials: false");
    expect(job("check")).toMatch(/node tools\/spec-lint\/spec-status\.ts --markdown/);
  });

  it("keeps one issue: updates it while there are findings and closes it when there are none", () => {
    const report = job("report");
    expect(report).toContain("gh label create spec-status");
    expect(report).toMatch(/gh issue create [^\n]*--label spec-status/);
    expect(report).toMatch(/gh issue edit "\$issue" --body-file/);
    expect(report).toMatch(/gh issue close "\$issue"/);
  });

  it("a run that could not check fails and touches no issue", () => {
    expect(job("report")).toMatch(
      /if: \$\{\{ !cancelled\(\) && needs\.check\.result == 'success' \}\}/,
    );
  });

  it("stays tiny: no npm install, short timeouts, no secret", () => {
    expect(text).not.toMatch(/npm (ci|install)/);
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
