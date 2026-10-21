// Checks the concurrency of the workflows that pull requests trigger, for
// workflow-concurrency.test.mjs. A new push to a pull request makes its running checks
// worthless, so each such workflow cancels the superseded run of the same pull request. Required
// checks belong to a commit, so the run of the newest head still reports every one of them. A
// push to main, a schedule, a manual run or a workflow_call never cancels a run in progress: those
// runs are the record of main and of the upstream autopilot, and none supersedes another.
import { parseWorkflow, triggers } from "./workflow-runners.mjs";

/** Events whose runs belong to one pull request. */
export const PR_TRIGGERS = new Set(["pull_request", "pull_request_target"]);

/** The only cancel-in-progress a workflow with other triggers too may use. */
const PR_ONLY_CANCEL = /^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/;

/** A group key that differs between pull requests (refs/pull/<n>/merge, the number, the head). */
const PER_PR_KEY = /\$\{\{[^}]*\bgithub\.(?:ref|head_ref|event\.pull_request\.number)\b[^}]*\}\}/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @param {string} text a workflow file
 * @returns {string | null} the workflow-level concurrency group, or null when there is none
 */
export function concurrencyGroup(text) {
  const c = parseWorkflow(text).concurrency;
  if (typeof c === "string") return c;
  return isMap(c) && typeof c.group === "string" ? c.group : null;
}

/**
 * @param {string} text a workflow file
 * @param {{ keepsRuns?: boolean }} [options] keepsRuns: the workflow may let a superseded pull
 *   request run finish (an allowlisted exception with its reason in the test)
 * @returns {string | null} why the workflow's concurrency breaks the rule, or null
 */
export function prConcurrencyProblem(text, { keepsRuns = false } = {}) {
  const events = triggers(text);
  if (!events.some((e) => PR_TRIGGERS.has(e))) return null;
  const c = parseWorkflow(text).concurrency;
  if (!isMap(c)) return "no workflow-level concurrency mapping (group and cancel-in-progress)";
  if (typeof c.group !== "string") return "concurrency has no group";
  if (!PER_PR_KEY.test(c.group))
    return `group ${JSON.stringify(c.group)} has no per-pull-request key (github.ref)`;
  const cancel = c["cancel-in-progress"];
  if (keepsRuns) return cancel === false ? null : "an allowlisted workflow must keep its runs";
  if (events.every((e) => PR_TRIGGERS.has(e)))
    return cancel === true || (typeof cancel === "string" && PR_ONLY_CANCEL.test(cancel))
      ? null
      : "superseded pull request runs are not cancelled";
  if (typeof cancel === "string" && PR_ONLY_CANCEL.test(cancel)) return null;
  return cancel === true
    ? `cancel-in-progress: true also cancels its ${events.filter((e) => !PR_TRIGGERS.has(e)).join(", ")} runs`
    : "superseded pull request runs are not cancelled";
}
