// Runs e2e scenarios one after another, each in a fresh session, with a per-scenario timeout
// and a total budget (plan §5: suite < 5 min). Pending scenarios are reported, never passed.
import { runSteps } from "./scenario.mjs";

/** @typedef {import("./scenario.mjs").Scenario} Scenario */
/** @typedef {"pass" | "fail" | "timeout" | "pending" | "skipped"} Status */
/** @typedef {{ name: string, status: Status, ms: number, error?: string }} Result */
/**
 * @typedef {{
 *   ctl: import("./scenario.mjs").StepContext["ctl"],
 *   screenshot: (name: string) => Promise<void>,
 *   restart?: (how: "quit" | "kill") => Promise<void>,
 *   control?: import("./scenario.mjs").Control,
 *   profile?: string,
 *   text?: (text: string) => string,
 *   teardown: () => Promise<void>,
 * }} Session
 */

/** Plan §5: the whole suite stays under 5 minutes. */
export const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
export const DEFAULT_SCENARIO_SECONDS = 60;
/** How long a timed-out scenario may take to stop before the runner moves on. */
export const DEFAULT_SETTLE_MS = 10_000;
/**
 * @typedef {(scenario: Scenario, options: { signal: AbortSignal }) => Promise<Session>}
 *   StartSession
 */

/**
 * @param {Scenario[]} scenarios
 * @param {{
 *   startSession: StartSession,
 *   budgetMs?: number,
 *   settleMs?: number,
 *   runPending?: boolean,
 *   pollMs?: number,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<Result[]>}
 */
export async function runScenarios(
  scenarios,
  {
    startSession,
    budgetMs = DEFAULT_BUDGET_MS,
    runPending = false,
    settleMs = DEFAULT_SETTLE_MS,
    pollMs,
    now = Date.now,
    log = () => {},
  },
) {
  const budgetEnd = now() + budgetMs;
  /** @type {Result[]} */
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.pending && !runPending) {
      results.push({ name: scenario.name, status: "pending", ms: 0, error: scenario.pending });
      continue;
    }
    const left = budgetEnd - now();
    if (left <= 0) {
      results.push({
        name: scenario.name,
        status: "skipped",
        ms: 0,
        error: `not started: the ${budgetMs / 1000} s budget is spent`,
      });
      continue;
    }
    const timeoutMs = Math.min((scenario.timeoutSeconds ?? DEFAULT_SCENARIO_SECONDS) * 1000, left);
    log(`RUN     ${scenario.name}`);
    // the settle wait comes out of the budget too, so a hung scenario cannot overrun it
    const settle = Math.min(settleMs, left - timeoutMs);
    results.push(await runOne(scenario, { startSession, timeoutMs, pollMs, settleMs: settle }));
  }
  return results;
}

/**
 * One scenario with a hard timeout: at the deadline its AbortSignal fires,
 * which cancels the launch (Xvfb, browser) and kills a running vimma-ctl; the runner then waits
 * at most `settleMs` for the scenario to notice before it moves on, and a session that only
 * arrives after that is torn down when it does.
 * @param {Scenario} scenario
 * @param {{ startSession: StartSession, timeoutMs: number, pollMs?: number, settleMs: number }} o
 * @returns {Promise<Result>}
 */
async function runOne(scenario, { startSession, timeoutMs, pollMs, settleMs }) {
  const started = Date.now();
  const controller = new AbortController();
  /** @type {Session | null} */
  let session = null;
  let movedOn = false;
  /** @type {Promise<void> | null} */
  let tornDown = null;
  const teardown = (/** @type {Session} */ s) => (tornDown ??= s.teardown());
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const work = (async () => {
    /** @type {Session} */
    let s;
    try {
      s = await startSession(scenario, { signal: controller.signal });
    } catch (e) {
      throw new Error(`launch: ${/** @type {Error} */ (e).message}`, { cause: e });
    }
    session = s;
    if (movedOn) {
      await teardown(s); // arrived after the runner gave up on it
      return;
    }
    if (controller.signal.aborted) return;
    await runSteps(scenario, {
      ctl: s.ctl,
      screenshot: s.screenshot,
      restart: s.restart,
      control: s.control,
      profile: s.profile,
      text: s.text,
      pollMs,
      signal: controller.signal,
    });
  })();
  /** @type {Result} */
  let result;
  try {
    const outcome = await Promise.race([work.then(() => "done"), timedOut]);
    result =
      outcome === "timeout"
        ? {
            name: scenario.name,
            status: "timeout",
            ms: Date.now() - started,
            error: `did not finish within ${timeoutMs / 1000} s`,
          }
        : { name: scenario.name, status: "pass", ms: Date.now() - started };
  } catch (e) {
    result = {
      name: scenario.name,
      status: "fail",
      ms: Date.now() - started,
      error: /** @type {Error} */ (e).message,
    };
  } finally {
    clearTimeout(timer);
  }
  // After a timeout, give the aborted steps or launch a moment to stop, but never wait longer
  // than settleMs: a hard deadline cannot depend on the scenario cooperating.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let settle;
  await Promise.race([
    work.catch(() => {}),
    new Promise((resolve) => (settle = setTimeout(resolve, settleMs))),
  ]);
  clearTimeout(settle);
  movedOn = true;
  const s = /** @type {Session | null} */ (session);
  if (s) {
    try {
      await teardown(s);
    } catch (e) {
      if (result.status === "pass") {
        result = {
          ...result,
          status: "fail",
          error: `teardown: ${/** @type {Error} */ (e).message}`,
        };
      }
    }
  }
  return result;
}

/** @param {Result[]} results */
export function exitCode(results) {
  if (results.length === 0) return 1;
  return results.some(
    (r) => r.status === "fail" || r.status === "timeout" || r.status === "skipped",
  )
    ? 1
    : 0;
}

/** @param {Result[]} results */
export function formatReport(results) {
  const lines = results.map((r) => {
    const label = r.status === "pass" ? "PASS" : r.status.toUpperCase();
    const time =
      r.status === "pending" || r.status === "skipped" ? "" : `  ${(r.ms / 1000).toFixed(1)} s`;
    const why = r.error ? `\n          ${r.error}` : "";
    return `${label.padEnd(8)}${r.name}${time}${why}`;
  });
  /** @param {Status[]} s */
  const count = (...s) => results.filter((r) => s.includes(r.status)).length;
  lines.push(
    "",
    `${count("pass")} passed, ${count("fail", "timeout", "skipped")} failed, ${count("pending")} pending`,
  );
  return lines.join("\n");
}

/**
 * The results for `--report-json` (spec upstream-beta-canary, decision 4): e2e.yml's Beta mode
 * puts the failures into suite-results.json. Failed means what exitCode counts as failed.
 * @param {Result[]} results
 * @returns {{
 *   passed: number,
 *   failed: Array<{ name: string, status: Status, error: string }>,
 *   pending: Array<{ name: string, reason: string }>,
 * }}
 */
export function reportJson(results) {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results
      .filter((r) => r.status === "fail" || r.status === "timeout" || r.status === "skipped")
      .map((r) => ({ name: r.name, status: r.status, error: r.error ?? r.status })),
    pending: results
      .filter((r) => r.status === "pending")
      .map((r) => ({ name: r.name, reason: r.error ?? "" })),
  };
}

/**
 * GitHub Actions workflow commands: an error per failure, a notice per pending scenario.
 * @param {Result[]} results
 */
export function githubAnnotations(results) {
  const clean = (/** @type {string} */ s) => s.replace(/\r?\n/g, " ");
  return results.flatMap((r) => {
    if (r.status === "pending") {
      return [
        `::notice title=e2e pending::${r.name} is pending, not run and not passed: ${clean(r.error ?? "")}`,
      ];
    }
    if (r.status === "pass") return [];
    return [`::error title=e2e ${r.name}::${clean(r.error ?? r.status)}`];
  });
}
