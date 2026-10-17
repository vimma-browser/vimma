/**
 * Bench regression gate (spec ci-quality-gates, plan §5 "Performance", issues #17 and #342).
 * Compares the working tree's cases with the baseline commit's cases, both measured by
 * tools/bench/bench.mjs in the same processes, sample by sample. It fails when
 *   - any case of the working tree takes BUDGET_US or more (plan: key-to-action in core < 50 µs);
 *   - the geometric mean of the cases' changes is more than THRESHOLD (10 %) above the baseline
 *     commit's, or one case is more than CASE_THRESHOLD (25 %) above it, or a case of the
 *     baseline commit was not measured. A change is the case's ratio (its time over the reference
 *     workload's, sampled in pairs) against the same case's ratio in the baseline commit.
 */
export const BUDGET_US = 50;
/** Plan §5: a regression over 10 % fails, measured on the suite (geometric mean of the cases). */
export const THRESHOLD = 0.1;
/**
 * One case alone fails only past 25 %: a single sub-microsecond case moves more than the suite's
 * mean of five, which averages the noise of its cases (docs/runbook.md).
 */
export const CASE_THRESHOLD = 0.25;
/** Floating-point slack, so a change of exactly the limit passes. */
const EPSILON = 1e-9;

/**
 * @typedef {{ us: number, ratio: number }} CaseResult µs per key-to-action, and that over the
 *   reference workload's µs (min of per-round medians, both)
 * @typedef {{ machine: string, referenceUs: number, cases: Record<string, CaseResult> }} Result
 * @typedef {Record<string, { change: number, why: string }>} Accepted costs the baseline accepts
 *   on top of the baseline commit, per case: a change meant to cost time cannot name its own
 *   commit before it is merged, so it states the cost here and the next move of the commit
 *   folds it in (docs/runbook.md, "Bench baseline")
 * @typedef {{ name: string, us: number, ratio: number, base: number | null,
 *   change: number | null }} Row
 */

/** @param {number[]} xs */
export function median(xs) {
  if (xs.length === 0) throw new RangeError("median of an empty sample");
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? /** @type {number} */ (s[mid]) : (Number(s[mid - 1]) + Number(s[mid])) / 2;
}

/**
 * Noise on a shared machine only ever adds time, so the quietest round is the best estimate.
 * @param {number[][]} rounds samples per round
 */
export function minOfMedians(rounds) {
  return Math.min(...rounds.map(median));
}

/**
 * One result from several bench processes (each with its own fixed hash seed, bench.mjs).
 *   - µs, for the budget: the lowest over the processes, since noise only adds time.
 *   - ratio, for the regression gate: the median over the processes. Not the lowest: noise in
 *     the reference's time lowers a ratio, so the lowest ratio picks the process whose reference
 *     ran slowest, and the gate then compares that outlier with the next run's (issue #125).
 * `referenceSpread` is (slowest − fastest) / fastest of the processes' reference times, printed so
 * a reference that stops being steady shows in the log.
 * @param {Result[]} results
 * @returns {Result & { processes: number, referenceSpread: number }}
 */
export function combine(results) {
  const [first] = results;
  if (!first) throw new RangeError("combine: no results");
  const names = Object.keys(first.cases).sort();
  for (const r of results) {
    if (r.machine !== first.machine) throw new Error("combine: results from another machine");
    if (Object.keys(r.cases).sort().join("\n") !== names.join("\n")) {
      throw new Error("combine: results with different cases");
    }
  }
  /** @type {Record<string, CaseResult>} */
  const cases = {};
  for (const name of Object.keys(first.cases)) {
    const of = results.map((r) => /** @type {CaseResult} */ (r.cases[name]));
    cases[name] = {
      us: Math.min(...of.map((c) => c.us)),
      ratio: median(of.map((c) => c.ratio)),
    };
  }
  const refs = results.map((r) => r.referenceUs);
  const referenceUs = Math.min(...refs);
  return {
    machine: first.machine,
    referenceUs,
    referenceSpread: Math.max(...refs) / referenceUs - 1,
    processes: results.length,
    cases,
  };
}

/** @param {number} x */
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} %`;

/**
 * @param {Result} result the working tree's cases
 * @param {Result} base the baseline commit's cases, measured in the same processes
 * @param {{ threshold?: number, caseThreshold?: number, budgetUs?: number,
 *   accepted?: Accepted }} [opts]
 */
export function compare(
  result,
  base,
  {
    threshold = THRESHOLD,
    caseThreshold = CASE_THRESHOLD,
    budgetUs = BUDGET_US,
    accepted = {},
  } = {},
) {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Row[]} */
  const rows = [];
  let logSum = 0;
  let compared = 0;
  for (const [name, { us, ratio }] of Object.entries(result.cases)) {
    if (us >= budgetUs) {
      failures.push(`${name}: ${us.toFixed(2)} µs is not under the ${budgetUs} µs budget`);
    }
    const measured = base.cases[name]?.ratio ?? null;
    const allowance = accepted[name];
    const was = measured === null ? null : measured * (1 + (allowance?.change ?? 0));
    const change = was === null ? null : ratio / was - 1;
    rows.push({ name, us, ratio, base: was, change });
    if (change === null) {
      notes.push(`${name}: no baseline for this case yet (not in the baseline commit)`);
      continue;
    }
    if (allowance) {
      notes.push(`${name}: ${pct(allowance.change)} accepted by the baseline (${allowance.why})`);
    }
    logSum += Math.log1p(change);
    compared++;
    const vs = `against the baseline (ratio ${ratio.toFixed(3)} vs ${Number(was).toFixed(3)})`;
    if (change > caseThreshold + EPSILON) {
      failures.push(`${name}: ${pct(change)} ${vs}, over the ${pct(caseThreshold)} limit`);
    } else if (change > threshold + EPSILON) {
      notes.push(`${name}: ${pct(change)} ${vs}; the suite gate decides`);
    }
  }
  const suiteChange = compared ? Math.expm1(logSum / compared) : null;
  if (suiteChange !== null && suiteChange > threshold + EPSILON) {
    failures.unshift(
      `suite: ${pct(suiteChange)} against the baseline (geometric mean over ${compared} cases), ` +
        `over the ${pct(threshold)} limit`,
    );
  }
  for (const name of Object.keys(base.cases)) {
    if (!(name in result.cases)) {
      failures.push(
        `${name}: in the baseline commit but not measured; move the baseline to a commit ` +
          `without it (docs/runbook.md, "Bench baseline")`,
      );
    }
  }
  return { ok: failures.length === 0, failures, notes, rows, suiteChange };
}

/** @param {ReturnType<typeof compare>} r */
export function formatTable(r) {
  const width = Math.max(4, ...r.rows.map((row) => row.name.length));
  const lines = [`${"case".padEnd(width)}  ${"µs".padStart(8)}  ratio  baseline  change`];
  for (const { name, us, ratio, base, change } of r.rows) {
    lines.push(
      `${name.padEnd(width)}  ${`${us.toFixed(2)} µs`.padStart(8)}  ${ratio.toFixed(3)}  ` +
        `${base === null ? "—".padStart(8) : base.toFixed(3).padStart(8)}  ` +
        `${change === null ? "—" : pct(change)}`,
    );
  }
  if (r.suiteChange !== null) {
    lines.push(`suite (geometric mean of the changes): ${pct(r.suiteChange)}`);
  }
  return lines.join("\n");
}
