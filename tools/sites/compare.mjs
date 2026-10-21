#!/usr/bin/env node
/**
 * Compares a site-compatibility run with the previous scheduled run (docs/specs/site-compat.md,
 * decision 12). sites.yml runs it after `npm run sites`, with the previous run's artifact
 * downloaded into a directory.
 *
 *   node tools/sites/compare.mjs --cur site-compat-output/results.json --out site-compat-output
 *     [--prev baseline/]        the previous run's artifact (results.json, diff.json)
 *     [--scheduled]             a scheduled run: may open, update or close the issue
 *     [--open-issue N]          the open site-compat issue, if any (empty: none)
 *     [--run-url URL]           this run, linked from the issue
 *
 * Writes diff.md (also appended to the job summary), diff.json (the tracked regressions, for the
 * next night) and, when the issue changes, issue.md; writes `action` and `issue` to
 * GITHUB_OUTPUT. A missing or malformed baseline is reported and compared as none. Exit 0 when
 * it wrote the diff, 1 when the current results cannot be read, 2 on usage errors.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  compareRuns,
  diffState,
  issueAction,
  parseRun,
  parseState,
  renderDiff,
  renderIssue,
} from "./diff.mjs";

/** @param {string} message */
function note(message) {
  console.log(
    process.env.GITHUB_ACTIONS ? `::warning::compare: ${message}` : `compare: ${message}`,
  );
}

/**
 * @param {string} file
 * @returns {{ value?: unknown, problem?: string }}
 */
function readJson(file) {
  if (!existsSync(file)) return { problem: `${file} does not exist` };
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { problem: `${file} is not valid JSON` };
  }
}

/** @param {string} dir */
function readBaseline(dir) {
  const results = readJson(join(dir, "results.json"));
  if (results.problem) {
    note(`no baseline: ${results.problem}`);
    return { prev: null, tracked: [] };
  }
  const { run, problems } = parseRun(results.value);
  if (!run) {
    note(`no baseline: the previous results.json: ${problems.join("; ")}`);
    return { prev: null, tracked: [] };
  }
  const statePath = join(dir, "diff.json");
  if (!existsSync(statePath)) return { prev: run, tracked: [] };
  const state = readJson(statePath);
  const parsed = state.problem
    ? { tracked: [], problems: [state.problem] }
    : parseState(state.value);
  if (parsed.problems.length) note(`nothing tracked carried over: ${parsed.problems.join("; ")}`);
  return { prev: run, tracked: parsed.tracked };
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        cur: { type: "string" },
        out: { type: "string" },
        prev: { type: "string" },
        scheduled: { type: "boolean", default: false },
        "open-issue": { type: "string", default: "" },
        "run-url": { type: "string", default: "" },
      },
    }));
  } catch (e) {
    process.stderr.write(`compare: ${/** @type {Error} */ (e).message}\n`);
    return 2;
  }
  const openText = values["open-issue"].trim();
  if (!values.cur || !values.out || (openText && !/^[1-9]\d*$/.test(openText))) {
    process.stderr.write(
      "compare: wants --cur FILE --out DIR, and --open-issue a number or empty\n",
    );
    return 2;
  }
  const openIssue = openText ? Number(openText) : null;

  const curJson = readJson(values.cur);
  const { run: cur, problems } = curJson.problem
    ? { run: null, problems: [curJson.problem] }
    : parseRun(curJson.value, { baseline: false });
  if (!cur) {
    process.stderr.write(`compare: the current results: ${problems.join("; ")}\n`);
    return 1;
  }
  const { prev, tracked } = values.prev ? readBaseline(values.prev) : { prev: null, tracked: [] };

  const diff = compareRuns(prev, cur, tracked);
  const action = issueAction(diff, { scheduled: values.scheduled, openIssue });
  mkdirSync(values.out, { recursive: true });
  const md = renderDiff(diff, cur);
  writeFileSync(join(values.out, "diff.md"), md);
  writeFileSync(
    join(values.out, "diff.json"),
    `${JSON.stringify(diffState(diff, cur), null, 2)}\n`,
  );
  if (action !== "none")
    writeFileSync(
      join(values.out, "issue.md"),
      renderIssue(diff, { action, runUrl: values["run-url"], cur }),
    );
  console.log(
    `${md}\ncompare: ${diff.regressions.length} new, ${diff.tracked.length} tracked; ` +
      `issue: ${action}`,
  );
  const issue = action === "update" || action === "close" ? String(openIssue) : "";
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `action=${action}\nissue=${issue}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
