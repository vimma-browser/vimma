### Mutation testing (`mutation.yml`)

Stryker mutates `packages/vimma-core/src` (not `vendor/`) every Sunday and runs the core's
tests against each mutant. A mutant that no test fails on **survived**: the tests would not notice
that change to the code. Survivors never fail the workflow; they go into one open issue labelled
`mutation`, which each run rewrites (and closes when none are left). Only a broken run is red.

Reading the issue and the report:

- The issue lists survivors per file as `L<line>:<col> <mutator> → <replacement>`. The HTML report
  (artifact `mutation-report` on the run, or `reports/mutation/mutation.html` locally) shows each
  one in the source, which is easier for more than a handful.
- `NoCoverage` means no test runs that code at all (rare: the coverage gate is 90 %).
- `Timeout` counts as killed: the mutant made the tests hang (usually a loop condition). Under
  heavy local parallelism a slow survivor can time out instead; CI's two workers are the reference.
- For each survivor: write a test that fails on the mutant, red first, naming the
  behaviour, not the mutant. If the mutant cannot change behaviour (an equivalent mutant, e.g. a
  redundant guard or a log message), mark it in the source with
  `// Stryker disable next-line <Mutator>: <why it is equivalent>`; the reason is required.
- Do not chase 100 %: string-literal mutants in error messages, for example, are fine to leave
  when no caller depends on the text.

Locally: `npm run mutation` (full run the first time, about 20 min on 12 cores; later runs reuse
`reports/mutation/stryker-incremental.json` and re-test only changed files, `npx stryker run --force`
to redo everything); `npx stryker run --mutate packages/vimma-core/src/keys/keys.mjs` for one file.

How it runs, and why: Stryker's `command` runner runs `vitest run` on the core's tests once per
mutant (`packages/vimma-core/vitest.config.mjs`, one worker, `--bail 1`). The dedicated
`@stryker-mutator/vitest-runner` 10.0.0 is not used: with Vitest 5 it skips every test inside a
`describe()` and reports their mutants as survivors (spec ci-quality-gates). Each run uploads its
results; the next week's run downloads them (`actions: read`) and re-tests only the mutants in
changed files. Because that cannot see new tests, the first Sunday of the month (or
`gh workflow run mutation.yml -f full=true`) re-tests everything. The job running Stryker has no
write token; the separate report job alone has `issues: write`.

Stryker runs the tests in a copy of the repository without `stryker.config.mjs`'s
`ignorePatterns` (the engine, `src/`, mochitests, git-ignored output). A core test that reads or
imports a file there passes `npm test` and fails Stryker's dry run, so the run is red and tests no
mutant. `tools/mutation/test/sandbox.test.ts` fails in every pull request on such a read that it
can see: a path written in a core test or in a module the test imports. A path built at run time
shows only in the dry run. Tests that assert a tight speed budget carry the Vitest tag `timing`,
which the mutation run leaves out: Stryker's instrumented code runs several times slower. To
check the setup without testing any mutant: `npx stryker run --dryRunOnly` (about a minute).
