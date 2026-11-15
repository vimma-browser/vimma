### Actions minutes budget

The repo is public (since 2026-10-10), so standard GitHub-hosted runners cost nothing and have
no monthly cap: minutes are no longer a reason to skip a job. What still matters is wall time
(a PR waits for its slowest required check) and the concurrency limit on hosted runners (20
jobs at once on the free plan), so keep jobs lean all the same. Rough wall time per PR push: CI ≈ 3–4
min, e2e ≈ 13 min, Semgrep ≈ 1 min, CodeQL ≈ 1 min (JavaScript) plus 2 min (Rust).
A push to `main` repeats only CodeQL and, when the merged tree differs from the pull request
head's, the rest ("Once per tree" above).

The release pull request is rebuilt by release-please after every merge to `main`
(`"always-update"`, so that it carries `main`'s hand-written `[Unreleased]` lines, "Releases"
below). It is opened as a draft, so a rebuild runs only CI and the key guard (about 4
min) and skips the mochitests, Semgrep and CodeQL ("Draft pull requests" above). Marking it
ready for review runs them once on the final state, `browser_vimma_app_version.js` included,
which checks the display version the build carries; the docs-only path never applies, because
the version in `surfer.json` changes. With `RELEASE_PLEASE_TOKEN` set, a rebuild pushes twice
(release-please, then the `firefox-notes` commit), and the second push cancels the first run;
without it, the release PR's pushes start no runs. Once the release PR is ready for review (by
hand, or by `security-release`), every merge to `main` runs its slow checks again too, so mark
it ready only when you mean to release.

e2e.yml has no paths filter: "mochitest (artifact build)" is a required check, so the workflow
starts on every PR, and on a docs-only one the job skips by `if:` in seconds (above). The upstream autopilot runs 6 × 1 min a day, plus ≈ 16 min (issue, patch check, the
e2e suites, PR) when a release is found (spec m7-upstream-autopilot); claude.yml only when
triggered. `nightly.yml` and `release.yml` run their full builds on GitHub-hosted runners too:
about 124 min per nightly and 117 min per release, free on a standard runner, and off until
their variables are set ("Full builds" below). Usage is listed in Settings → Billing → Usage.

The bench step adds about 45 seconds to each CI run. `mutation.yml` is the largest scheduled
cost: a full run (first Sunday of the month) is estimated at 60–90 min on the 2-CPU runner
(4 916 mutants; 22 min with 12 workers locally, about 0.6 s per mutant per CPU), an incremental
week a few minutes plus one for the report job: roughly 100 min a month, free now. If the full
run gets too slow, narrow `mutate` in `stryker.config.mjs` or drop the monthly full run.

`sites.yml` (spec site-compat) runs one job a night at 04:30 UTC, and by hand: about 3.6 min of
setup (e2e.yml's steps up to the artifact build) plus the site list, about 15-20 min in all
(≈ 600 min a month, free on a standard runner). It never runs on pull requests and is not a
required check. A blocked site's retry adds about 30 s each, and the diff and the issue job
under a minute. To make it lighter, shorten `tools/sites/sites.json` or move its `cron` to fewer
nights.

`fuzz.yml` runs one job of about 5 min a night (≈ 150 min a month), plus a one-minute report job
on a failure. To halve it, run it on fewer nights (its `cron`) or lower `VIMMA_FUZZ_TIME_MS`.
The seeded fuzz properties add a few seconds to each CI run, and compiling proptest about 10 s.

`patch-audit.yml` (the quarterly patch audit, docs/rebase.md "Patch-size audit") runs two
one-minute jobs four times a year: no npm or toolchain install, only the runner's `python3`.

`upstream-beta.yml` (the Beta canary) checks for a new Firefox Beta build every 6 hours, under a
minute each time (about 2 hours a month). Each Beta build is tested once, about 16 minutes (the
patch check 2, `e2e.yml` 12, render and report 1): five builds per two-week cycle, about 11
tested builds and 3 hours a month. One run uses one hosted runner at a time.
