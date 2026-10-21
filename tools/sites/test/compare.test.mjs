import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI that sites.yml runs after the suite (docs/specs/site-compat.md, decision 12), on the
// recorded nightly results.json files in fixtures/.
const CLI = fileURLToPath(new URL("../compare.mjs", import.meta.url));
const fixture = (/** @type {string} */ day) =>
  fileURLToPath(new URL(`fixtures/nightly-${day}.json`, import.meta.url));

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs the CLI; returns its outputs (GITHUB_OUTPUT lines) and the files it wrote.
 * @param {{ cur: string, prev?: string | null, prevState?: unknown, args?: string[] }} o
 */
function compare({ cur, prev = null, prevState, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "vimma-compare-"));
  dirs.push(dir);
  const out = join(dir, "out");
  const ghOutput = join(dir, "github-output");
  const summary = join(dir, "summary");
  writeFileSync(ghOutput, "");
  const argv = ["--cur", cur, "--out", out, ...args];
  if (prev !== null) {
    const p = join(dir, "baseline");
    mkdirSync(p);
    if (prev) writeFileSync(join(p, "results.json"), readFileSync(prev));
    if (prevState !== undefined)
      writeFileSync(join(p, "diff.json"), JSON.stringify(prevState, null, 2));
    argv.push("--prev", p);
  }
  const stdout = execFileSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: ghOutput, GITHUB_STEP_SUMMARY: summary },
  });
  const outputs = Object.fromEntries(
    readFileSync(ghOutput, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => /** @type {[string, string]} */ (l.split("=", 2))),
  );
  const read = (/** @type {string} */ f) =>
    existsSync(join(out, f)) ? readFileSync(join(out, f), "utf8") : null;
  return {
    stdout,
    outputs,
    diff: read("diff.md"),
    state: read("diff.json"),
    issue: read("issue.md"),
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : null,
  };
}

/** A copy of the 21st with GitHub PR's hints check failing, written to a temp file. */
function regressedNight() {
  const run = JSON.parse(readFileSync(fixture("2026-10-21"), "utf8"));
  const site = run.sites.find((/** @type {any} */ s) => s.id === "github-pr");
  site.status = "fail";
  site.checks = site.checks.map((/** @type {any} */ c) =>
    c.id === "hints" ? { id: "hints", status: "fail", reason: "no labels @octocat" } : c,
  );
  const dir = mkdtempSync(join(tmpdir(), "vimma-compare-"));
  dirs.push(dir);
  const file = join(dir, "results.json");
  writeFileSync(file, JSON.stringify(run));
  return file;
}

describe("tools/sites/compare.mjs", () => {
  it("compares two recorded nights: a diff in the summary, no issue", () => {
    const r = compare({
      cur: fixture("2026-10-21"),
      prev: fixture("2026-10-20"),
      args: ["--scheduled"],
    });
    expect(r.outputs).toEqual({ action: "none", issue: "" });
    expect(r.diff).toMatch(/no new regression/i);
    expect(r.diff).toContain("npm");
    expect(r.summary).toBe(r.diff);
    expect(r.issue).toBeNull();
    const state = JSON.parse(r.state ?? "");
    expect(state).toMatchObject({
      version: 1,
      startedAt: "2026-10-21T09:31:04.772Z",
      complete: true,
      tracked: [],
    });
    expect(state.known["github-repo/hints"]).toBe("pass");
  });

  it("opens an issue for a scheduled run with a new regression", () => {
    const r = compare({
      cur: regressedNight(),
      prev: fixture("2026-10-20"),
      args: ["--scheduled", "--run-url", "https://github.com/vimma-browser/vimma/actions/runs/9"],
    });
    expect(r.outputs).toEqual({ action: "create", issue: "" });
    expect(r.issue).toContain("GitHub PR");
    expect(r.issue).toContain("`no labels @octocat`");
    expect(r.issue).toContain("https://github.com/vimma-browser/vimma/actions/runs/9");
  });

  it("updates the open issue, and closes it once the regression passes again", () => {
    const failing = regressedNight();
    const first = compare({ cur: failing, prev: fixture("2026-10-20"), args: ["--scheduled"] });
    const state = JSON.parse(first.state ?? "");
    expect(state.tracked).toHaveLength(1);

    const still = compare({
      cur: failing,
      prev: failing,
      prevState: state,
      args: ["--scheduled", "--open-issue", "612"],
    });
    expect(still.outputs).toEqual({ action: "update", issue: "612" });

    const fixed = compare({
      cur: fixture("2026-10-21"),
      prev: failing,
      prevState: state,
      args: ["--scheduled", "--open-issue", "612"],
    });
    expect(fixed.outputs).toEqual({ action: "close", issue: "612" });
    expect(fixed.issue).toMatch(/no regression is left/i);
  });

  it("leaves the issue alone on a run that is not scheduled", () => {
    const r = compare({
      cur: regressedNight(),
      prev: fixture("2026-10-20"),
      args: ["--open-issue", "612"],
    });
    expect(r.outputs).toEqual({ action: "none", issue: "" });
    expect(r.diff).toContain("GitHub PR");
  });

  it("reports no baseline when the previous artifact is missing or malformed", () => {
    const missing = compare({ cur: fixture("2026-10-21"), prev: "", args: ["--scheduled"] });
    expect(missing.diff).toMatch(/no baseline/i);
    expect(missing.outputs.action).toBe("none");

    const dir = mkdtempSync(join(tmpdir(), "vimma-compare-"));
    dirs.push(dir);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    const malformed = compare({ cur: fixture("2026-10-21"), prev: bad, args: ["--scheduled"] });
    expect(malformed.diff).toMatch(/no baseline/i);
    expect(malformed.stdout).toMatch(/not valid JSON/);

    const noPrev = compare({ cur: fixture("2026-10-21"), prev: null });
    expect(noPrev.diff).toMatch(/no baseline/i);
  });

  it("compares a filtered run by hand without error", () => {
    const run = JSON.parse(readFileSync(fixture("2026-10-21"), "utf8"));
    run.filter = "github";
    run.sites = run.sites.filter((/** @type {any} */ s) => s.id.startsWith("github-"));
    const dir = mkdtempSync(join(tmpdir(), "vimma-compare-"));
    dirs.push(dir);
    const file = join(dir, "results.json");
    writeFileSync(file, JSON.stringify(run));
    const r = compare({ cur: file, prev: fixture("2026-10-20") });
    expect(r.outputs.action).toBe("none");
    expect(r.diff).not.toMatch(/removed/i);
  });

  it("carries the tracked list when only diff.json survives, and does not close then", () => {
    const failing = regressedNight();
    const first = compare({ cur: failing, prev: fixture("2026-10-20"), args: ["--scheduled"] });
    const state = JSON.parse(first.state ?? "");
    const lost = compare({
      cur: failing,
      prev: "",
      prevState: state,
      args: ["--scheduled", "--open-issue", "612"],
    });
    const lostState = JSON.parse(lost.state ?? "");
    expect(lostState.tracked).toHaveLength(1);
    expect(lostState.complete).toBe(false);
    // The next night has a baseline again and the check passes, but the chain was broken.
    const next = compare({
      cur: fixture("2026-10-21"),
      prev: failing,
      prevState: lostState,
      args: ["--scheduled", "--open-issue", "612"],
    });
    expect(next.outputs.action).toBe("update");
    expect(next.issue).toMatch(/interrupted/);
  });

  it("does not close the issue after a run the harness stopped early", () => {
    const run = JSON.parse(readFileSync(fixture("2026-10-21"), "utf8"));
    run.harnessError = "Xvfb died";
    run.sites = run.sites.slice(0, 5);
    const dir = mkdtempSync(join(tmpdir(), "vimma-compare-"));
    dirs.push(dir);
    const file = join(dir, "results.json");
    writeFileSync(file, JSON.stringify(run));
    const r = compare({
      cur: file,
      prev: fixture("2026-10-20"),
      prevState: { version: 1, complete: true, known: {}, tracked: [] },
      args: ["--scheduled", "--open-issue", "612"],
    });
    expect(r.outputs.action).toBe("update");
    expect(r.diff).not.toMatch(/removed/i);
  });

  it("rejects an --open-issue that is not a number", () => {
    expect(() =>
      compare({ cur: fixture("2026-10-21"), args: ["--open-issue", "1; rm -rf /"] }),
    ).toThrow();
  });
});
