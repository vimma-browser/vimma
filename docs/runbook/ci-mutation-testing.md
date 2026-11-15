### Mutation testing (`mutation.yml`)

Stryker mutates `packages/vimma-core/src` (not `vendor/`) every Sunday and runs the core's
tests against each mutant. A mutant that no test fails on **survived**: the tests would not notice
that change to the code. Survivors never fail the workflow; they go into one open issue labelled
`mutation`, which each run rewrites (and closes when none are left). Only a broken run is red.

Reading the issue and the report:

- The issue lists survivors per file as `L<line>:<col> <mutator> → <replacement>`. The HTML report
  (artifact `mutation-report-<shard>` on the run, or `reports/mutation/mutation.html` locally)
  shows each one in the source, which is easier for more than a handful. The run's summary page
  has each shard's score and the total.
- `NoCoverage` means no test runs that code at all (rare: the coverage gate is 90 %).
- `Timeout` counts as killed: the mutant made the tests hang (usually a loop condition). Under
  heavy local parallelism a slow survivor can time out instead; CI's two workers are the reference.
- For each survivor: write a test that fails on the mutant, red first, naming the
  behaviour, not the mutant. If the mutant cannot change behaviour (an equivalent mutant, e.g. a
  redundant guard or a log message), mark it in the source with
  `// Stryker disable next-line <Mutator>: <why it is equivalent>`; the reason is required.
- Do not chase 100 %: string-literal mutants in error messages, for example, are fine to leave
  when no caller depends on the text.

Locally: `npm run mutation` (the first full run takes many hours; later runs reuse
`reports/mutation/stryker-incremental.json` and re-test only changed files, `npx stryker run --force`
to redo everything);
`npx stryker run --mutate packages/vimma-core/src/page/pageurl.mjs` for one file (148 mutants,
under a minute).

How it runs, and why: `@stryker-mutator/vitest-runner` runs the core's tests
(`packages/vimma-core/vitest.config.mjs`) with per-test coverage: the dry run records which tests
reach each mutant, and each mutant then runs only those tests. Before #975 Stryker's `command`
runner ran the whole suite (about 30 s) once per mutant, because vitest-runner 10.0.0 skipped every
test inside a `describe()` on Vitest 5; with about 38,000 mutants that run could not finish in the
job's 180 minutes, and most of its mutants ended as timeouts. vitest-runner 10.1.1 fixed the
Vitest 5 test names. Static mutants (in code that runs once, when a module loads) are left out
(`ignoreStatic`): each reruns every test in a fresh module environment, and in a sample of three
files they were 46 % of the mutants and 98 % of the time. The cost, accepted by the maintainer:
about half of all mutants, those in module-level tables, constants and keymaps, are never tested,
their survivors never reach the issue, and scores are not comparable with runs before #975.

Shards: the run is a matrix of 10 jobs (`fail-fast` off, so one shard's failure or timeout
does not cancel the others). Each mutates one shard of the core's files, `MUTATION_SHARD=k` of
`MUTATION_SHARDS=10`. `tools/mutation/shard.ts` splits the files by size, largest first, each to
the smallest shard so far, so the same tree always gives the same split (about 132 KB of source
and 3,800 mutants a shard). `node tools/mutation/shard.ts 10` prints the split, and
`MUTATION_SHARD=8 MUTATION_SHARDS=10 npx stryker run` runs one shard locally. Measured locally
on 4 runners of a 12-core machine at load 20: shard 8 of 10 (toml.mjs and 8 more files,
3,996 mutants) took 47 minutes, and keys.mjs with 4 more files (2,087 mutants) took 22. A
shard job is estimated at 30 to 60 minutes of Stryker plus about 5 of setup, well inside the
180-minute limit. Each job's summary has its shard's score. The report job merges the shards'
`mutation.json` (`tools/mutation/merge.ts`), adds every shard's score and the total to the run
summary, and writes the issue. It runs only when every shard passed. To change the count, edit
the matrix, the job name and `MUTATION_SHARDS` in `mutation.yml` together.

Each shard uploads its results. The next week's shards download every shard's results
(`actions: read`), and each keeps only its own files (`merge.ts --shard`), so a file the split
moved keeps its old results. Each re-tests only the mutants in changed files. Stryker copies any
old result outside `mutate` into its new report, so a shard given other shards' files would
report stale copies of them; `merge.ts` fails on a file that two shards report. Incremental mode
cannot see new tests, so the first Sunday of the month (or
`gh workflow run mutation.yml -f full=true`) re-tests everything. The jobs running Stryker have no
write token; the separate report job alone has `issues: write`.

Stryker runs the tests in a copy of the repository without `stryker.config.mjs`'s
`ignorePatterns` (the engine, `src/`, mochitests, git-ignored output). A core test that reads or
imports a file there passes `npm test` and fails Stryker's dry run, so the run is red and tests no
mutant. `tools/mutation/test/sandbox.test.ts` fails in every pull request on such a read that it
can see: a path written in a core test or in a module the test imports. A path built at run time
shows only in the dry run. Tests that assert a tight speed budget carry the Vitest tag `timing`,
which the mutation run leaves out: Stryker's instrumented code runs several times slower.
Linear-time checks (a 200,000-character input under 500 ms) stay in and take their limit from
`budget()` in `packages/vimma-core/test/budget.mjs`, which is 20 times longer under Stryker, so
a mutant that makes the code quadratic still fails them. To check the setup without testing any
mutant: `npx stryker run --dryRunOnly` (about 5 minutes: the whole suite once, instrumented).
