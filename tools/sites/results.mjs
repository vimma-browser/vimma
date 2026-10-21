// Results of a site-compatibility run (docs/specs/site-compat.md, decisions 5 and 7). Pure: the
// checks record CheckResults; this orders them, derives each site's status and the run's
// summary and exit code.

/**
 * The checks, in the order they run (decision 5).
 */
export const CHECKS = /** @type {const} */ ([
  "load",
  "scroll",
  "find",
  "yank",
  "insert",
  "prefix",
  "shortcuts",
  "hints",
  "errors",
  "statusbar",
]);

/** @typedef {(typeof CHECKS)[number]} CheckId */
/** @typedef {"pass" | "fail" | "skip" | "info"} CheckStatus */
/**
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {CheckStatus} status
 * @property {string} [reason]   why it failed or was skipped, or the info text
 * @property {Record<string, unknown>} [details]
 */
/** @typedef {"ok" | "fail" | "blocked" | "consent" | "error"} SiteStatus */
/** @typedef {{ kind: "bot-check" | "consent", reason: string }} Block */
/**
 * @typedef {object} ModeStep
 * @property {string} step
 * @property {string} expected
 * @property {string | null} state      vimma-ctl state's mode
 * @property {string | null} statusbar  the status bar's mode segment text
 */
/**
 * @typedef {object} SiteResult
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} [finalUrl]
 * @property {string} [title]
 * @property {SiteStatus} status
 * @property {Block} [block]
 * @property {CheckResult[]} checks
 * @property {number} [loadMs]
 * @property {Record<string, number>} latency  key → ms (j, f, yy, follow)
 * @property {Array<{ label: string, file: string }>} screenshots
 * @property {ModeStep[]} [steps]
 * @property {number} durationMs
 * @property {string} [error]
 * @property {{ status: SiteStatus, block?: Block }} [retry]  the first visit, when this is a retry
 */
/**
 * @typedef {object} Run
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {"local" | "github-hosted"} network
 * @property {string} build
 * @property {string | null} commit
 * @property {string | null} [filter]  the --filter, when only some sites ran
 * @property {SiteResult[]} sites
 * @property {string | null} harnessError
 */

/**
 * The checks in CHECKS order, each once (the first recorded wins); the ones never recorded are
 * skipped with `reason` (the site was blocked, or the harness stopped early).
 * @param {CheckResult[]} checks
 * @param {string} reason
 * @returns {CheckResult[]}
 */
export function completeChecks(checks, reason) {
  return CHECKS.map(
    (id) =>
      checks.find((c) => c.id === id) ?? { id, status: /** @type {const} */ ("skip"), reason },
  );
}

/**
 * @param {{ checks: CheckResult[], block?: Block, error?: string }} site
 * @returns {SiteStatus}
 */
export function siteStatus({ checks, block, error }) {
  if (error) return "error";
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (block) return block.kind === "bot-check" ? "blocked" : "consent";
  return "ok";
}

/**
 * The `statusbar` check from the mode recorded after each step.
 * @param {ModeStep[]} steps
 * @returns {CheckResult}
 */
export function statusbarCheck(steps) {
  if (!steps.length) return { id: "statusbar", status: "skip", reason: "no steps ran" };
  const bad = steps.filter(
    (s) => s.state !== s.expected || s.statusbar !== s.expected.toUpperCase(),
  );
  if (!bad.length) return { id: "statusbar", status: "pass", details: { steps: steps.length } };
  return {
    id: "statusbar",
    status: "fail",
    reason: bad
      .map((s) => `${s.step}: expected ${s.expected}, state ${s.state}, bar ${s.statusbar}`)
      .join("; "),
  };
}

/** @returns {Record<CheckStatus, number>} */
const zeroChecks = () => ({ pass: 0, fail: 0, skip: 0, info: 0 });

/**
 * @param {SiteResult[]} sites
 */
export function summarize(sites) {
  const bySite = { total: sites.length, ok: 0, fail: 0, blocked: 0, consent: 0, error: 0 };
  const checks = zeroChecks();
  /** @type {Record<string, Record<CheckStatus, number>>} */
  const byCheck = Object.fromEntries(CHECKS.map((id) => [id, zeroChecks()]));
  for (const site of sites) {
    bySite[site.status]++;
    for (const c of site.checks) {
      checks[c.status]++;
      const row = byCheck[c.id];
      if (row) row[c.status]++;
    }
  }
  return { sites: bySite, checks, byCheck };
}

/**
 * 0 whenever a report was produced (a report, not a gate: decision 7); 1 when the harness
 * itself failed.
 * @param {{ sites: unknown[], harnessError: string | null }} run
 */
export function exitCode(run) {
  return run.harnessError ? 1 : 0;
}

/**
 * The sites to load once more at the end of the run (decision 11): those a bot check blocked.
 * A consent wall does not go away on its own, and a failure or harness error is a result.
 * @template {{ status: SiteStatus }} T
 * @param {T[]} sites
 * @returns {T[]}
 */
export function retryTargets(sites) {
  return sites.filter((s) => s.status === "blocked");
}

/**
 * The retry's result in place of the first visit, which it keeps under `retry`, with both
 * visits' screenshots and time.
 * @param {SiteResult} first
 * @param {SiteResult} second
 * @returns {SiteResult}
 */
export function mergeRetry(first, second) {
  return {
    ...second,
    retry: { status: first.status, ...(first.block ? { block: first.block } : {}) },
    screenshots: [...first.screenshots, ...second.screenshots],
    durationMs: first.durationMs + second.durationMs,
  };
}
