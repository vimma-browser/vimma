// Spec ci-quality-gates: weekly mutation testing of vimma-core (the unit layer of
// docs/architecture/testing.md). Survivors become one tracking issue
// (.github/workflows/mutation.yml); they never fail a build, so there is no `thresholds.break`.
// Local run: `npm run mutation`; reading the report: docs/runbook/.
//
// Test runner: @stryker-mutator/vitest-runner with per-test coverage, so each mutant runs only the
// tests that reach it. The command runner used before ran the whole core suite (about 30 s) once
// per mutant: with 38,000 mutants a run could never finish in the job's 180 minutes, and its
// timeout (taken from the dry run) ended most mutants as "timed out" rather than killed or
// survived. vitest-runner 10.0.0 did not work with Vitest 5 (it joined test names with spaces
// where Vitest 5 matches " > ", so no test inside a describe() ran); 10.1.1 fixed that.
// The suite is the core's alone (packages/vimma-core/vitest.config.mjs, which also leaves out the
// tests tagged `timing` and raises the test timeout: Stryker's runner takes no command line).
import { fileURLToPath } from "node:url";
import { mutateFor } from "./tools/mutation/shard.ts";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "packages/vimma-core/vitest.config.mjs" },
  coverageAnalysis: "perTest",
  // The dry run runs the whole suite once, instrumented and counting coverage per test: about
  // 6 minutes on one loaded local core, past Stryker's 5-minute default.
  dryRunTimeoutMinutes: 30,
  // The core's sources, not the vendored smol-toml (third-party code we do not change; same
  // exclusion as coverage). mutation.yml runs it as a matrix of shards: MUTATION_SHARD=k of
  // MUTATION_SHARDS=n mutates only shard k's files (tools/mutation/shard.ts).
  mutate: mutateFor(fileURLToPath(new URL(".", import.meta.url)), process.env),
  // Static mutants (in code that runs once, when a module loads: tables, constants) need every
  // test rerun in a fresh module environment. In a sample of three core files they were 46 % of
  // the mutants and 98 % of the time, so they are left out; the report counts them as ignored.
  ignoreStatic: true,
  // Kept out of the sandbox copy: the engine, the browser sources, mochitests and old reports,
  // which the core's tests never read, and the git-ignored build output, worktrees and Firefox
  // downloads (Stryker does not read .gitignore, so a local run would copy them). docs/ and
  // tsconfig.json stay in: core tests check docs against code, and Vitest transforms the
  // tools/*.ts they import under tools/tsconfig.json, which extends the root one.
  // tools/mutation/test/sandbox.test.ts fails when a core test reaches a path listed here.
  ignorePatterns: [
    "/engine",
    "/.surfer",
    "/src",
    "/tests/browser",
    "/reports",
    "/.claude",
    "/.dotbuild",
    "/firefox-*",
    "/tools/vimma-ctl/target",
    "/coverage",
    "/dist",
    "/e2e-output",
    "/site-compat-output",
    "/site-compat-offline",
  ],
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
