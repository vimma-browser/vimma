// Spec ci-quality-gates: weekly mutation testing of vimma-core (plan §5, unit layer). Survivors
// become one tracking issue (.github/workflows/mutation.yml); they never fail a build, so there is
// no `thresholds.break`. Local run: `npm run mutation`; reading the report: docs/runbook.md.
//
// Test runner: Stryker's built-in `command` runner, which runs the core's Vitest suite once per
// mutant with the mutant chosen by environment variable. @stryker-mutator/vitest-runner 10.0.0
// does not work with Vitest 5: it filters tests by a name joined with spaces, Vitest 5 matches the
// filter against names joined with " > ", so tests inside a describe() never run and every mutant
// they would kill is reported as survived. Revisit when a vitest-runner release supports Vitest 5;
// it would add per-test coverage, which makes runs faster.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: {
    // The core's tests alone (tools/ tests do not import packages/vimma-core/src); stop at the
    // first failure, since one failing test already kills the mutant. Tests tagged `timing` stay
    // out: they assert speed budgets that the instrumented code cannot meet
    // (packages/vimma-core/vitest.config.mjs).
    command:
      "node node_modules/vitest/vitest.mjs run --config packages/vimma-core/vitest.config.mjs --bail 1 --pool threads --no-isolate --maxWorkers 1 --tagsFilter '!timing'",
  },
  coverageAnalysis: "off",
  mutate: [
    "packages/vimma-core/src/**/*.mjs",
    // Vendored smol-toml: third-party code we do not change (same exclusion as coverage).
    "!packages/vimma-core/src/vendor/**",
  ],
  // Kept out of the sandbox copy: the engine, the browser sources, mochitests and old reports,
  // which the core's tests never read. docs/ and tsconfig.json stay in: core tests check docs
  // against code, and Vitest transforms the tools/*.ts they import under tools/tsconfig.json,
  // which extends the root one. tools/mutation/test/sandbox.test.ts fails when a core test reaches
  // a file listed here.
  ignorePatterns: ["/engine", "/.surfer", "/src", "/tests/browser", "/reports"],
  // Stryker rewrites the `extends` and `references` of this file and its parents with
  // TypeScript's JS API, which TypeScript 7 (native) no longer has. Naming a file that does not
  // exist skips that; it would change nothing anyway, since the sandbox copies the whole tree
  // and no tsconfig points outside it.
  tsconfigFile: "stryker-does-not-rewrite-tsconfig.json",
  // Incremental mode: mutation.yml downloads this file from the last main run's artifact (not the
  // Actions cache, which evicts after 7 days), so a week in which a few core files changed
  // re-tests only the mutants in those files; a monthly full run catches newly added tests.
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
