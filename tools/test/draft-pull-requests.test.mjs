import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { jobs, parseWorkflow } from "./workflow-runners.mjs";

// Issue #443: release-please opens its release pull request as a draft, and the heavy required
// checks (the artifact build with the mochitests, Semgrep, CodeQL) skip a draft pull request, so
// the rebuilds after each merge to main cost minutes instead of a full run each. Marking the pull
// request ready for review runs them once (docs/runbook.md, "Draft pull requests"). Every required
// check still reports on a draft, and CodeQL uploads no results for one, so the ruleset's code
// scanning rule keeps the pull request blocked until the run after "ready for review".
const ROOT = new URL("../../", import.meta.url);
const dir = new URL(".github/workflows/", ROOT);
/** @param {string} name */
const read = (name) => readFileSync(new URL(name, dir), "utf8");

/** The `main` ruleset's required checks (ruleset 24842084, rule required_status_checks). */
const REQUIRED = [
  "lint, typecheck, test, commitlint, licences",
  "semgrep (javascript, typescript, rust, secrets, github-actions)",
  "CodeQL (javascript-typescript)",
  "CodeQL (rust)",
  "mochitest (artifact build)",
  "Mozilla release key unchanged or approved",
];

/**
 * When a draft skips: only on `opened` and `synchronize`, the two events that bring a new head,
 * which has no earlier run, so no real result is replaced by a skipped success. `reopened` and
 * `ready_for_review` on a draft, and a re-run of such a run, run everything: converting a pull
 * request to a draft and reopening it must not turn a failed check green on the same head. On an
 * event that is not a pull request, `github.event.pull_request` is null and everything runs.
 */
const SKIP =
  "github.event.pull_request.draft == true && " +
  "(github.event.action == 'opened' || github.event.action == 'synchronize')";
const RUNS = `!(${SKIP})`;

/**
 * The jobs that skip a draft, with how: `job` skips the whole job by its `if:` (a skipped job
 * reports success under its name), `steps` skips every step and lets the job report success.
 * A matrix job must use `steps`: skipped by its own `if:`, it reports one check named with the
 * unexpanded `${{ matrix.language }}`, and the required names would never report.
 * @type {{ file: string, job: string, skip: "job" | "steps", checks: string[] }[]}
 */
const HEAVY = [
  { file: "e2e.yml", job: "mochitest", skip: "job", checks: ["mochitest (artifact build)"] },
  {
    file: "semgrep.yml",
    job: "scan",
    skip: "job",
    checks: ["semgrep (javascript, typescript, rust, secrets, github-actions)"],
  },
  {
    file: "codeql.yml",
    job: "analyze",
    skip: "steps",
    checks: ["CodeQL (javascript-typescript)", "CodeQL (rust)"],
  },
];

/**
 * @param {Record<string, unknown>} job
 * @returns {string[]} the check names the job reports
 */
function checkNames(job) {
  const name = String(job.name ?? "");
  const m = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/.exec(name);
  if (!m?.[1]) return [name];
  const matrix = /** @type {any} */ (job.strategy)?.matrix;
  const values = matrix?.[m[1]];
  if (!Array.isArray(values)) throw new Error(`job ${name}: matrix.${m[1]} is not a list`);
  return values.map((v) => name.replace(m[0], String(v)));
}

/** @param {unknown} cond */
const condition = (cond) => String(cond ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "");

describe("draft pull requests", () => {
  it("release-please opens the release pull request as a draft", () => {
    const config = JSON.parse(readFileSync(new URL("release-please-config.json", ROOT), "utf8"));
    expect(config["draft-pull-request"]).toBe(true);
  });

  it("every required check is reported by exactly one job", () => {
    /** @type {string[]} */
    const reported = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      for (const job of jobs(read(file)).values()) {
        reported.push(...checkNames(job).filter((n) => REQUIRED.includes(n)));
      }
    }
    expect(reported.sort()).toEqual([...REQUIRED].sort());
  });

  it("the mochitests, Semgrep and CodeQL skip a draft and still report their required checks", () => {
    for (const heavy of HEAVY) skipsDraft(heavy);
  });

  /** @param {(typeof HEAVY)[number]} heavy */
  function skipsDraft(heavy) {
    const job = /** @type {Record<string, any>} */ (jobs(read(heavy.file)).get(heavy.job));
    expect(checkNames(job)).toEqual(heavy.checks);
    const steps = /** @type {Record<string, unknown>[]} */ (job.steps);
    if (heavy.skip === "job") {
      expect(job.strategy, "a matrix job skipped by its if: reports no required name").toBe(
        undefined,
      );
      expect(condition(job.if).endsWith(` && ${RUNS}`), condition(job.if)).toBe(true);
      for (const step of steps) expect(String(step.if ?? "")).not.toContain("draft");
    } else {
      expect(String(job.if ?? "")).not.toContain("draft");
      // Every step skips on a draft except the notice that says why, which runs only there.
      const notice = steps.filter((s) => condition(s.if) === SKIP);
      expect(notice).toHaveLength(1);
      expect(String(notice[0]?.run)).toContain("::notice::");
      for (const step of steps.filter((s) => !notice.includes(s))) {
        expect(condition(step.if), String(step.uses ?? step.name)).toBe(RUNS);
      }
    }
  }

  it("each runs on every pull request push and when a draft is marked ready", () => {
    for (const heavy of HEAVY) {
      const on = /** @type {Record<string, any>} */ (parseWorkflow(read(heavy.file)).on);
      expect(on.pull_request.types, heavy.file).toEqual(
        expect.arrayContaining(["opened", "synchronize", "reopened", "ready_for_review"]),
      );
    }
  });

  it("CodeQL still uploads an analysis for every pull request that is not a draft", () => {
    const job = /** @type {Record<string, any>} */ (jobs(read("codeql.yml")).get("analyze"));
    const uses = job.steps.map((/** @type {any} */ s) => [String(s.uses ?? ""), condition(s.if)]);
    expect(uses).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^github\/codeql-action\/init@/), RUNS],
        [expect.stringMatching(/^github\/codeql-action\/analyze@/), RUNS],
      ]),
    );
    expect(Object.keys(parseWorkflow(read("codeql.yml")).on ?? {})).toEqual(
      expect.arrayContaining(["push", "pull_request"]),
    );
  });

  it("no other job reads the draft flag, so the cheap required checks run on drafts", () => {
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      for (const [id, job] of jobs(read(file))) {
        if (HEAVY.some((h) => h.file === file && h.job === id)) continue;
        expect(JSON.stringify(job), `${file} ${id}`).not.toContain("pull_request.draft");
      }
    }
  });
});
