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

// A wall-clock budget fails on a loaded machine: with the whole suite running in parallel at load
// 15, a linear merge of 16,000 bookmarks took over 5 s against a 3 s budget. growth() compares the
// code with itself instead: eight times the input takes 7 to 10 times as long when the code is
// linear, 64 times when a quadratic part leads, and about 15 to 30 already when a quadratic part
// adds a second or two to the large size (a lookup by scan instead of by Map). Load and Stryker slow both sizes of a pair
// alike, so LINEAR_GROWTH needs no budget(); a test that uses growth() does several times the
// work, so its timeout does.

/** The most `growth()` may give for code that runs in linear time. */
export const LINEAR_GROWTH = 12;

/**
 * How many times longer `run(size)` takes than `run(size / 8)`. `run` builds its input outside
 * the clock and returns the milliseconds of the code under test alone. One pair warms the JIT up
 * (without it the first small run is the slow one), then three pairs run back to back; the
 * smallest ratio counts, so one pair that load spared is enough, while a quadratic part is slow
 * in every pair. `ratios` lists them all, for the failure message.
 */
export function growth(run: (size: number) => number, size: number) {
  const small = Math.round(size / 8);
  run(small);
  run(size);
  const ratios: number[] = [];
  for (let pair = 0; pair < 3; pair++) {
    const before = run(small);
    ratios.push(run(size) / before);
  }
  return {
    smallest: Math.min(...ratios),
    ratios: `ratios of ${size} to ${small}: ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
  };
}
