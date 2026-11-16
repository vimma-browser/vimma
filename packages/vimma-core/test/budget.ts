// Wall-clock budgets in the core's tests. Each one checks that code runs in linear time, not how
// fast it is: a backtracking regex or a quadratic loop over 200,000 characters takes seconds or
// more, the linear code milliseconds. Under Stryker (stryker.config.mjs) the code is instrumented
// and counts every statement it runs for each test, several times slower (toml's 500 ms check
// took 2.1 s in the dry run), so there the budget is STRYKER_SLOWDOWN times longer: the dry run
// passes, and a mutant that makes the code quadratic still fails the test. Tests of a tight speed
// budget (a bench, not a complexity check) carry the tag `timing` instead and stay out of the run.

/** How much longer a budget is while Stryker runs the tests. */
export const STRYKER_SLOWDOWN = 20;

/**
 * The time a test may take, in milliseconds: `ms`, or STRYKER_SLOWDOWN times it under Stryker,
 * whose test runner processes have STRYKER_MUTATOR_WORKER set.
 */
export function budget(ms: number): number {
  return process.env.STRYKER_MUTATOR_WORKER === undefined ? ms : ms * STRYKER_SLOWDOWN;
}
