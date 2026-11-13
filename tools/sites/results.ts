// Results of a site-compatibility run (docs/specs/site-compat.md, decisions 5 and 7). Pure: the
// checks record CheckResults; this orders them, derives each site's status and the run's
// summary and exit code.

/**
 * The checks, in the order they run (decision 5).
 */
export const CHECKS = [
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
] as const;

export type CheckId = (typeof CHECKS)[number];
export type CheckStatus = "pass" | "fail" | "skip" | "info";
export interface CheckResult {
  id: string;
  status: CheckStatus;
  /** why it failed or was skipped, or the info text */
  reason?: string;
  details?: Record<string, unknown>;
}
export type SiteStatus = "ok" | "fail" | "blocked" | "consent" | "error";
export type Block = { kind: "bot-check" | "consent"; reason: string };
export interface ModeStep {
  step: string;
  expected: string;
  /** vimma-ctl state's mode */
  state: string | null;
  /** the status bar's mode segment text */
  statusbar: string | null;
}
export interface SiteResult {
  id: string;
  name: string;
  url: string;
  finalUrl?: string;
  title?: string;
  status: SiteStatus;
  block?: Block;
  checks: CheckResult[];
  loadMs?: number;
  /** key → ms (j, f, yy, follow) */
  latency: Record<string, number>;
  screenshots: Array<{ label: string; file: string }>;
  steps?: ModeStep[];
  durationMs: number;
  error?: string;
  /** the first visit, when this is a retry */
  retry?: { status: SiteStatus; block?: Block };
}
export interface Run {
  startedAt: string;
  finishedAt: string;
  network: "local" | "github-hosted";
  build: string;
  commit: string | null;
  /** the --filter, when only some sites ran */
  filter?: string | null;
  /** the snapshots were replayed (--offline), not the live sites */
  offline?: boolean;
  sites: SiteResult[];
  harnessError: string | null;
}

/**
 * The checks in CHECKS order, each once (the first recorded wins); the ones never recorded are
 * skipped with `reason` (the site was blocked, or the harness stopped early).
 */
export function completeChecks(checks: CheckResult[], reason: string): CheckResult[] {
  return CHECKS.map(
    (id) => checks.find((c) => c.id === id) ?? { id, status: "skip" as const, reason },
  );
}

export function siteStatus({
  checks,
  block,
  error,
}: {
  checks: CheckResult[];
  block?: Block;
  error?: string;
}): SiteStatus {
  if (error) return "error";
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (block) return block.kind === "bot-check" ? "blocked" : "consent";
  return "ok";
}

/** The `statusbar` check from the mode recorded after each step. */
export function statusbarCheck(steps: ModeStep[]): CheckResult {
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

const zeroChecks = (): Record<CheckStatus, number> => ({ pass: 0, fail: 0, skip: 0, info: 0 });

export function summarize(sites: SiteResult[]) {
  const bySite = { total: sites.length, ok: 0, fail: 0, blocked: 0, consent: 0, error: 0 };
  const checks = zeroChecks();
  const byCheck: Record<string, Record<CheckStatus, number>> = Object.fromEntries(
    CHECKS.map((id) => [id, zeroChecks()]),
  );
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
 */
export function exitCode(run: { sites: unknown[]; harnessError: string | null }) {
  return run.harnessError ? 1 : 0;
}

/**
 * The sites to load once more at the end of the run (decision 11): those a bot check blocked.
 * A consent wall does not go away on its own, and a failure or harness error is a result.
 */
export function retryTargets<T extends { status: SiteStatus }>(sites: T[]): T[] {
  return sites.filter((s) => s.status === "blocked");
}

/**
 * The retry's result in place of the first visit, which it keeps under `retry`, with both
 * visits' screenshots and time.
 */
export function mergeRetry(first: SiteResult, second: SiteResult): SiteResult {
  return {
    ...second,
    retry: { status: first.status, ...(first.block ? { block: first.block } : {}) },
    screenshots: [...first.screenshots, ...second.screenshots],
    durationMs: first.durationMs + second.durationMs,
  };
}
