// Reads which runner each job of a GitHub Actions workflow targets, for
// self-hosted-runner.test.ts (docs/specs/build-supply-chain.md, decision 7). The workflows are
// parsed as YAML (js-yaml), not matched as text, so quoted keys, flow mappings, anchors and
// duplicate keys mean what they mean to GitHub; js-yaml rejects a duplicate key, which fails the
// test. The YAML 1.2 core schema, without the `!!merge` tag: GitHub does not apply `<<:` merge
// keys, so neither does this, and a runs-on that only a merge key supplies is missing. Every shape
// this does not recognise is reported as a problem: the check fails closed.
import { CORE_SCHEMA, load } from "js-yaml";

/**
 * Triggers that let someone without write access start a run, or that run on behalf of such a
 * run. `workflow_call` is included because a called workflow runs with its caller's trigger.
 */
export const OUTSIDER_TRIGGERS = new Set([
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
  "workflow_run",
  "workflow_call",
]);

/**
 * Standard GitHub-hosted runner images. Larger runners (`-large`, `-xlarge`, custom names) and
 * every other label are excluded: only a self-hosted or a paid larger runner can serve them.
 */
const HOSTED_IMAGE =
  /^(?:ubuntu-(?:latest|\d\d\.\d\d)(?:-arm)?|windows-(?:latest|\d{4}|11-arm)|macos-(?:latest|\d+)(?:-intel)?)$/;

/** A workflow file of this repository: one name in .github/workflows, no other path segment. */
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[\w-]+(?:\.[\w-]+)*\.ya?ml$/;

export const isHostedImage = (label: unknown): boolean =>
  typeof label === "string" && HOSTED_IMAGE.test(label);

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** @param text  a workflow file */
export function parseWorkflow(text: string): Record<string, unknown> {
  const doc = load(text, { schema: CORE_SCHEMA });
  if (!isMap(doc)) throw new Error("a workflow is a mapping");
  return doc;
}

/**
 * @param text  a workflow file
 * @returns the events under its top-level `on:`
 */
export function triggers(text: string): string[] {
  const on = parseWorkflow(text).on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((t) => typeof t === "string")) return on;
  if (isMap(on)) return Object.keys(on);
  throw new Error("`on:` is not an event, a list of events or a mapping of them");
}

/**
 * @param text  a workflow file
 * @returns job id to the job
 */
export function jobs(text: string): Map<string, Record<string, unknown>> {
  const all = parseWorkflow(text).jobs;
  if (!isMap(all)) throw new Error("`jobs:` is not a mapping");
  const out = new Map<string, Record<string, unknown>>();
  for (const [id, job] of Object.entries(all)) {
    if (!isMap(job)) throw new Error(`job ${id} is not a mapping`);
    out.set(id, job);
  }
  return out;
}

export type RunsOn =
  | { kind: "labels"; labels: unknown[] }
  | { kind: "expression"; expression: string }
  | { kind: "object" }
  | { kind: "reusable"; uses: string }
  | { kind: "missing" };

/** @param job  a job from `jobs()` */
export function runsOn(job: Record<string, unknown>): RunsOn {
  const value = job["runs-on"];
  if (value === undefined) {
    return typeof job.uses === "string"
      ? { kind: "reusable", uses: job.uses }
      : { kind: "missing" };
  }
  if (typeof value === "string") {
    return value.includes("${{")
      ? { kind: "expression", expression: value }
      : { kind: "labels", labels: [value] };
  }
  if (Array.isArray(value)) return { kind: "labels", labels: value };
  // `group:` / `labels:`: a runner group, which only self-hosted and larger runners have.
  return { kind: "object" };
}

/**
 * Resolves `${{ matrix.<key> }}` against a literal list of strings in the job's own
 * `strategy.matrix`. Anything else (inputs, vars, event fields, conditionals, a matrix that is
 * itself an expression, or one with `include:`, which can add values the list does not show) is
 * unresolved: its value is not known from the file.
 * @returns every value it can take, or null when it cannot be resolved
 */
export function resolveExpression(
  expression: string,
  job: Record<string, unknown>,
): unknown[] | null {
  const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(expression);
  if (!m?.[1]) return null;
  const strategy = job.strategy;
  const matrix = isMap(strategy) ? strategy.matrix : undefined;
  if (!isMap(matrix) || "include" in matrix) return null;
  const values = matrix[m[1]];
  return Array.isArray(values) && values.length > 0 ? values : null;
}

/**
 * @param job  a job from `jobs()`
 * @returns why the job may not run on a standard GitHub-hosted runner, or null
 */
export function runnerProblem(job: Record<string, unknown>): string | null {
  const r = runsOn(job);
  if (r.kind === "reusable") {
    // A local workflow is a file in .github/workflows and is checked as such; any other is not.
    return LOCAL_WORKFLOW.test(r.uses) ? null : `a reusable workflow elsewhere: ${r.uses}`;
  }
  if (r.kind === "missing") return "no runs-on";
  if (r.kind === "object") return "a runner group";
  if (r.kind === "expression") {
    const values = resolveExpression(r.expression, job);
    if (!values) return `an expression that cannot be resolved: ${r.expression}`;
    const bad = values.filter((v) => !isHostedImage(v));
    return bad.length
      ? `${r.expression} can be ${bad.map((v) => JSON.stringify(v)).join(", ")}`
      : null;
  }
  if (r.labels.length !== 1) return `not one label: ${JSON.stringify(r.labels)}`;
  const [label] = r.labels;
  return isHostedImage(label) ? null : `not a GitHub-hosted image: ${JSON.stringify(label)}`;
}

/**
 * @param text  a workflow file
 * @returns one line per job that may not run on a standard GitHub-hosted runner
 */
export function workflowRunnerProblems(text: string): string[] {
  const out: string[] = [];
  for (const [id, job] of jobs(text)) {
    const problem = runnerProblem(job);
    if (problem) out.push(`${id}: ${problem}`);
  }
  return out;
}
