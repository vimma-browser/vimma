# Spec: ci-quality-gates

Status: implemented · Milestone: M0 (pipeline) · Area: CI (`.github/workflows/`,
`tools/bench/`, `tools/mutation/`)

## User story

As the maintainer, I learn weekly which core changes no test would notice, and a PR that makes
key-to-action in core slower by more than 10 % (or over 50 µs) fails CI without flaking.

## Scope

Two rows of plan §5 and issue #17:

- **Unit layer:** "Stryker mutation testing weekly, survivors become issues."
- **Performance:** "Key-to-action latency in core (< 50 µs) … Regression > 10 % fails CI."
  Key-to-paint (< 5 ms) stays with the e2e timers (issue #17, third bullet); not in this spec.

## Tests (written first)

- `tools/bench/test/compare.test.mjs`: median and min-of-medians; combining processes keeps the
  lowest; a suite (geometric mean) > 10 % over the baseline fails, exactly 10 % passes, one case
  at +15 % only notes, one case > 25 % fails; a slower runner with the same ratio passes; any
  case over 50 µs fails even without a baseline; an unknown machine and a new case only advise; a
  baseline case that was not measured fails; the CLI exits 0/1/2.
- `tools/bench/test/cases.test.mjs`: the cases cover a single key, the prefix plus a key and a
  count plus a motion, and each produces the action it names on every run.
- `tools/mutation/test/report.test.mjs`: the score matches Stryker's formula; survivors are listed
  per file, sorted; the body stays under GitHub's 65 536-character limit; the CLI writes `score`
  and `survivors` to `$GITHUB_OUTPUT`.

## Settled (2026-10-09)

- **Stryker's command runner, not `@stryker-mutator/vitest-runner`.** vitest-runner 10.0.0 (the
  latest) predates Vitest 5 and silently under-tests on it: it filters tests with names joined by
  spaces, Vitest 5 matches the filter against names joined by `" > "`, so tests inside
  `describe()` never run and their mutants are reported as survivors (dispatcher.mjs: 32 % with
  it, 85 % with the command runner). The command runner (part of `@stryker-mutator/core`) runs the
  core suite once per mutant (`packages/vimma-core/vitest.config.mjs`, one worker, `--bail 1`).
  Only one dependency added: `@stryker-mutator/core` 10.0.0, Apache-2.0, pinned exactly. Two of
  its transitive packages are outside the allowlist and have reviewed exceptions: `tslib` (0BSD)
  and `caniuse-lite` (CC-BY-4.0, data, dev-only).
- **Incremental mode, results carried as an artifact.** Each run uploads `mutation-report`
  (HTML, JSON, incremental file; 35 days); the next run downloads the last successful one with
  `gh run download` (`actions: read`). The Actions cache was rejected: it evicts entries unused
  for 7 days, exactly the schedule's period. Without per-test coverage, incremental mode only
  re-tests mutants in changed source files, so a survivor killed by a new test would linger; the
  first Sunday of each month (and a manual run with `full`) re-tests everything.
- **Two jobs in mutation.yml.** The job that runs repository code (npm ci, Stryker, tests) has
  `contents: read` and `actions: read`; only the report job, which runs no npm code, has
  `issues: write`. Costs one extra billed minute a week.
- **Bench: own harness, not `vitest bench`.** `tools/bench/bench.mjs` warms up each case, times
  batches of ≥ 100 µs each followed by a batch of a fixed reference workload, and takes per case
  the median ratio (51 samples a round, median over 5 rounds) and the minimum µs; then the lowest
  of each over 15 fresh processes. The old `core.bench.mjs` (mean latency, no baseline) is gone.
- **The 10 % gate is on the suite.** Measured on a laptop pinned to 2 CPUs, 8 whole runs: single
  cases spread up to 14 % (max−min), the geometric mean of all cases 6 %. One process alone spread
  20–30 % (JIT modes), hence the 15 processes. So: fail when the geometric mean of the cases'
  changes exceeds 10 %, or one case exceeds 25 %; always fail over 50 µs.
- **Baseline per runner class.** `packages/vimma-core/bench/baseline.json` holds one entry per
  `CPU model | arch | Node major`. The relative gate applies only on a recorded machine; elsewhere
  only the 50 µs budget applies and the run prints the entry to record. GitHub's hosted pool mixes
  CPU models, and a ratio measured on one microarchitecture is not comparable with another.
  (Since changed: issue [#342](https://github.com/vimma-browser/vimma/issues/342) replaced the
  stored numbers with a baseline _commit_, whose cases every run measures in the same 15 processes
  as the working tree's, sample by sample; see docs/runbook.md, "Bench baseline".)
- **A step in ci.yml, not nightly.** Nightly runs on the self-hosted build runner (not enabled
  yet, and a different machine class); the plan wants the gate on PRs. The step costs seconds and
  no extra job minute. (Since changed: no self-hosted runner is planned; the nightly moves
  to a hosted runner with [#224](https://github.com/vimma-browser/vimma/issues/224).)

## Hardening

- **No silent pass on an unknown runner.** Fall back to the most demanding entry (lowest
  geometric mean of ratios) of the same arch and Node major, limits +40 points (50 % suite, 65 %
  per case), with a `::warning::` and a step-summary line naming it. Budget-only, with a warning,
  only when no such entry exists. Budget is now strict: 50.0 µs fails (plan: < 50 µs). The
  margin was 6 points first; CI then drew a third CPU (EPYC 7763) on which unchanged code
  measured +19 % suite, +30 % per case against the 9V74 entry, and failed. Recorded it too.
  (Since changed: with the baseline measured in the same run (#342) every runner is "recorded";
  the fallback and its wider limits are gone.)
- **Node pinned exactly** in `.nvmrc` (22.23.3, what CI recorded on); the baseline key carries
  the exact version; no Dependabot ecosystem covers `.nvmrc`, so it is bumped by hand
  (docs/runbook.md, "Bench baseline"). (Since changed: the bench no longer keys on Node (#342);
  the pin stays for reproducible CI.)
- **Samples per entry:** `cases` is the per-case median of `samples` (in `baseline.json` now:
  EPYC 7763 30, EPYC 9V74 12, EPYC 9V45 11, Xeon 8573C 5, Xeon 8370C 2). (Since changed: no
  entries since #342; unchanged code read +11.6 % to +12.5 % on every 8370C run against its
  two-sample entry, which is what made the gate flake.)
- mutation.yml reuses results only from main's scheduled or manual runs; `GH_TOKEN` is scoped to
  the download step.

## Security scanning (2026-10-10)

- **Semgrep CE now, CodeQL when the repo is public.** `semgrep.yml` runs on every PR, push to
  `main` and on Mondays. It fails on ERROR findings only and keeps the SARIF as the
  `semgrep-sarif` artifact. `codeql.yml` (`javascript-typescript` and `rust`, `build-mode: none`,
  `security-extended`) is already in the repo but gated with
  `if: github.event.repository.private == false`. It turns on by itself when the repo goes public
  and needs no change then. While the repo is private, a GitHub Code Security licence would be
  needed to upload results, and the CodeQL CLI licence does not cover a private codebase.
- **First scan:** bidirectional and zero-width characters had been written as literal characters
  in three tests (WARNING `contains-bidirectional-characters`). They are now `\u` escapes, and the
  tests are unchanged. Three INFO findings in vimma-ctl are left as they are: `temp_dir()` in two
  test helpers, and `std::env::args` in a CLI that reads its own arguments.
- Details, licences and how to read the SARIF: docs/runbook.md, "Security scanning".

## Follow-up

When the CI log of another runner CPU model prints "no baseline for machine",
record it as in docs/runbook.md "Bench baseline".
