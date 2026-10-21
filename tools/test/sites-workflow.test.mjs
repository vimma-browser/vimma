import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/specs/site-compat.md, decision 1: the live site suite's workflow. It must never run on a
// pull request or gate a merge, must stay on a free standard runner, and holds no secret. Text
// checks, like patch-audit-workflow.test.mjs: no YAML dependency.
const text = readFileSync(new URL("../../.github/workflows/sites.yml", import.meta.url), "utf8");
const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));

/** The text of one job under `jobs:`, up to the next job. @param {string} name */
function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** A job's `permissions:` block as name → level. @param {string} jobText */
function permissionsOf(jobText) {
  const block = /\n {4}permissions:\n((?: {6}[\w-]+: \w+.*\n)+)/.exec(jobText)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/^ {6}([\w-]+): (\w+)/gm)].map((m) => [m[1], m[2]]));
}

describe("site-compat workflow (sites.yml)", () => {
  it("runs nightly and by hand, never on a pull request or a push", () => {
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \*"/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(text).not.toMatch(
      /^\s*(pull_request\w*|push|issue_comment|workflow_run|workflow_call):/m,
    );
  });

  it("uses a standard GitHub-hosted runner, never a self-hosted or larger one", () => {
    const runsOn = [...text.matchAll(/runs-on: (.+)/g)].map((m) => m[1]?.trim());
    expect(runsOn).toEqual(["ubuntu-24.04", "ubuntu-24.04", "ubuntu-24.04"]);
  });

  it("has no secrets, and no permission at the top level", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).not.toContain("secrets.");
    expect(text).toContain("persist-credentials: false");
  });

  // Decision 12: the job that runs the browser on live pages only reads; the one that writes the
  // issue runs no repository code and sees page text only as a file it hands to gh.
  it("the browser job only reads the repository, and holds no token in any step", () => {
    expect(permissionsOf(job("sites"))).toEqual({ contents: "read" });
    expect(job("sites")).not.toContain("GH_TOKEN");
  });

  // A page that escaped the browser could rewrite files on the browser job's runner; the diff and
  // the issue text are therefore made on a fresh runner, from results.json alone.
  it("the compare job only reads, and works from the browser job's results.json alone", () => {
    const compare = job("compare");
    expect(permissionsOf(compare)).toEqual({ contents: "read", actions: "read", issues: "read" });
    expect(compare).toMatch(/needs: sites/);
    expect(compare).toContain("persist-credentials: false");
    expect(compare).toMatch(/cp \S*results\.json current\//);
    expect(compare).not.toMatch(/npm (ci|run|install)/);
  });

  it("stops workflow commands while the suite logs page text", () => {
    expect(job("sites")).toMatch(/::stop-commands::\$\{?token/);
  });

  it("issues: write is only in the report job, which checks out and runs no repository code", () => {
    expect([...text.matchAll(/: write\b/g)]).toHaveLength(1);
    const report = job("report");
    expect(permissionsOf(report)).toEqual({ issues: "write" });
    expect(report).not.toMatch(/actions\/checkout|setup-node|\bnpm\b|\bnode\b|\.mjs|\.sh\b/);
    expect(report).toContain("--body-file");
    // No expression expands inside a shell script: values come in through env and are checked.
    const scripts = [...report.matchAll(/run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
    expect(report).toMatch(/\^\[0-9\]\+\$/);
  });

  it("checks the Firefox tarball against Mozilla's SHA512SUMS before building", () => {
    // firefox-source.sh verifies the tarball before Surfer unpacks it (firefox-source.test.mjs).
    expect(text).toContain("tools/upstream/firefox-source.sh");
    expect(text.indexOf("firefox-source.sh")).toBeLessThan(text.indexOf("artifact-build.mjs"));
  });

  it("runs the suite on the artifact build and uploads the report even when it fails", () => {
    expect(text).toMatch(/npm run sites -- --artifact/);
    const upload = text.slice(text.indexOf("actions/upload-artifact"));
    expect(text.slice(0, text.indexOf("actions/upload-artifact"))).toMatch(
      /if: always\(\)\n\s*uses: $/,
    );
    expect(upload).toContain("path: site-compat-output/");
  });

  it("retries blocked sites on the nightly runner, not in local runs", () => {
    expect(job("sites")).toMatch(/npm run sites -- --artifact --retry-blocked/);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.sites).not.toContain("retry");
  });

  it("compares with the previous scheduled run and touches the issue on schedule only", () => {
    const compare = job("compare");
    expect(compare).toMatch(/gh run list --workflow sites\.yml --event schedule --branch main/);
    expect(compare).toContain("node tools/sites/compare.mjs");
    expect(compare).toContain("site-compat:results.json site-compat-diff:diff.json");
    expect(compare.indexOf("tools/sites/compare.mjs")).toBeLessThan(
      compare.indexOf("actions/upload-artifact"),
    );
    expect(compare).toMatch(/github\.event_name == 'schedule'/);
    expect(job("report")).toMatch(/needs: compare/);
  });

  it("every action it uses is pinned by a full commit SHA", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
