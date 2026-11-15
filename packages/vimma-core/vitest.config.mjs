// The core's tests alone, for Stryker (stryker.config.mjs). `npm test` uses the root config, which
// also runs tools/ tests; those spawn processes and do not exercise packages/vimma-core/src.
// The fuzz properties (test/fuzz, spec m7-fuzzing) are left out: Stryker runs this suite once per
// mutant, and their megabyte inputs would add hours to a full run; the unit tests kill mutants.
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.mjs"],
    exclude: [...configDefaults.exclude, "test/fuzz/**"],
    // `timing`: a test that asserts a tight speed budget. Stryker's command leaves these out
    // (`--tagsFilter '!timing'`): its instrumented copy of the code runs several times slower, so
    // the budget would fail the dry run and count every mutant of the file as killed.
    tags: [
      { name: "timing", description: "Asserts a speed budget of the real, uninstrumented code" },
    ],
  },
});
