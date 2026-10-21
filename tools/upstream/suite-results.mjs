#!/usr/bin/env node
/**
 * suite-results.json for e2e.yml's Beta mode (spec upstream-beta-canary, decision 4). In Beta
 * mode the checks and suites run with continue-on-error, so every one of them runs; this records
 * what each step did and what failed, for the Beta canary's issue.
 *
 *   STEPS='${{ toJSON(steps) }}' node tools/upstream/suite-results.mjs --version 159.0b1 \
 *     --mochitest-log mochitest.tbpl.log --e2e-report e2e-report.json --out suite-results.json
 *
 * The mochitest failures are the `TEST-UNEXPECTED-* | test | message` lines of the TBPL log
 * mozlog writes for --log-tbpl (testing/mozbase/mozlog/mozlog/formatters/tbplformatter.py; mach
 * prints its own format to the console, without them); the e2e failures come
 * from the harness's --report-json. A missing log or report is recorded, not an error: the step
 * that writes it may not have run. Prints a summary; exits 1 when any step did not succeed, so
 * the run shows the failure after every suite has reported, 2 on usage errors.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The step ids e2e.yml gives the build, the checks and the suites, in order. */
export const STEPS = [
  "import",
  "branding",
  "upstream-prefs",
  "artifact-build",
  "mochitest",
  "e2e",
  "sites-offline",
];

/** @typedef {{ status: string, test: string, message: string }} MochitestFailure */
/**
 * @typedef {{
 *   passed: number,
 *   failed: Array<{ name: string, status: string, error: string }>,
 *   pending: Array<{ name: string, reason: string }>,
 * }} E2eReport
 */

// eslint-disable-next-line no-control-regex -- a log copied from a terminal carries colour escapes
const ANSI = /\u001b\[[0-9;]*m/g;
const UNEXPECTED = /(TEST-UNEXPECTED-[A-Z-]+) \| (.+?) \| (.*)$/;

/**
 * @param {string} log a mochitest run's TBPL log
 * @returns {MochitestFailure[]} each unexpected result once, in order
 */
export function mochitestFailures(log) {
  /** @type {Map<string, MochitestFailure>} */
  const seen = new Map();
  for (const raw of log.split("\n")) {
    const m = UNEXPECTED.exec(raw.replace(ANSI, ""));
    if (!m) continue;
    const failure = { status: m[1] ?? "", test: (m[2] ?? "").trim(), message: (m[3] ?? "").trim() };
    const key = `${failure.status}|${failure.test}|${failure.message}`;
    if (!seen.has(key)) seen.set(key, failure);
  }
  return [...seen.values()];
}

/**
 * @param {{
 *   version: string,
 *   steps: Record<string, { outcome?: string | null }>,
 *   mochitestLog: string | null,
 *   e2eReport: E2eReport | null,
 * }} input `steps` is GitHub's steps context; a step that did not run is not in it
 */
export function suiteResults({ version, steps, mochitestLog, e2eReport }) {
  /** @type {Record<string, string>} */
  const outcomes = {};
  for (const id of STEPS) outcomes[id] = steps[id]?.outcome || "skipped";
  return {
    version,
    ok: Object.values(outcomes).every((o) => o === "success"),
    steps: outcomes,
    mochitest: {
      log: mochitestLog !== null,
      failures: mochitestLog === null ? [] : mochitestFailures(mochitestLog),
    },
    e2e: e2eReport,
  };
}

/** @param {string} message */
function usage(message) {
  process.stderr.write(`suite-results: ${message}\n`);
  return 2;
}

/** @param {string} path @returns {string | null} */
const readIf = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        version: { type: "string" },
        "mochitest-log": { type: "string" },
        "e2e-report": { type: "string" },
        out: { type: "string" },
      },
    }));
  } catch (e) {
    return usage(/** @type {Error} */ (e).message);
  }
  const { version, out } = values;
  const log = values["mochitest-log"];
  const report = values["e2e-report"];
  if (!version || !out || !log || !report) {
    return usage("--version, --mochitest-log, --e2e-report and --out are required");
  }
  let steps;
  try {
    steps = JSON.parse(process.env.STEPS ?? "");
  } catch {
    return usage("STEPS must hold the steps context as JSON (${{ toJSON(steps) }})");
  }
  const reportText = readIf(report);
  /** @type {E2eReport | null} */
  let e2eReport = null;
  try {
    e2eReport = reportText === null ? null : JSON.parse(reportText);
  } catch (e) {
    process.stderr.write(
      `suite-results: ${report} is not JSON: ${/** @type {Error} */ (e).message}\n`,
    );
  }
  const results = suiteResults({ version, steps, mochitestLog: readIf(log), e2eReport });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);

  console.log(`Firefox ${version}: ${results.ok ? "every step succeeded" : "failures"}`);
  for (const [id, outcome] of Object.entries(results.steps)) {
    let extra = "";
    if (id === "mochitest") {
      extra = results.mochitest.log
        ? `, ${results.mochitest.failures.length} unexpected`
        : ", no log";
    }
    if (id === "e2e") extra = e2eReport ? `, ${e2eReport.failed.length} failed` : ", no report";
    console.log(`  ${id}: ${outcome}${extra}`);
  }
  for (const f of results.mochitest.failures) console.log(`${f.status} | ${f.test} | ${f.message}`);
  for (const f of e2eReport?.failed ?? []) console.log(`e2e ${f.status} | ${f.name} | ${f.error}`);
  return results.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
