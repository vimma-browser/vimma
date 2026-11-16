// The core's tests alone, for Stryker (stryker.config.mjs). `npm test` uses the root config, which
// also runs tools/ tests; those spawn processes and do not exercise packages/vimma-core/src.
// The fuzz properties (test/fuzz, spec m7-fuzzing) are left out: Stryker runs this suite once per
// mutant, and their megabyte inputs would add hours to a full run; the unit tests kill mutants.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.mjs", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/fuzz/**"],
    // `timing`: a test that asserts a tight speed budget (a bench). Stryker's instrumented copy of
    // the code runs several times slower, so the budget would fail the dry run; this config, which
    // Stryker's vitest runner reads (it takes no command line), leaves them out. Linear-time
    // checks stay in, with a budget that grows under Stryker (test/budget.mjs). The instrumented
    // code also runs the slowest property tests (about 2 s each on the real code) past Vitest's
    // 5 s default, hence the 60 s; a mutant that hangs still ends at Stryker's own timeout.
    tagsFilter: ["!timing"],
    testTimeout: 60_000,
    tags: [
      { name: "timing", description: "Asserts a speed budget of the real, uninstrumented code" },
    ],
  },
});
