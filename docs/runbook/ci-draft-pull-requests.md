### Draft pull requests (issue #443)

A push to a draft pull request skips the three slow required checks: `mochitest (artifact
build)` with the e2e scenarios (e2e.yml), the Semgrep scan and both CodeQL analyses. Each still
reports success, so the ruleset never waits on a check that will not come: e2e.yml and
semgrep.yml skip the job by `if:`, and codeql.yml, a matrix job, skips every step instead,
because a matrix job skipped by its own `if:` reports one check under the unexpanded
`CodeQL (${{ matrix.language }})` and the required names would never appear. CI (`lint,
typecheck, test, commitlint, licences`) and the key guard are cheap and run on drafts too.

Only the `opened` and `synchronize` events of a draft skip. Both bring a head that has had no
run, so a skipped success never replaces a real result. Every other event runs everything:
`reopened` and `ready_for_review` on a draft, pushes to `main`, schedules, manual runs and
`workflow_call` (where `github.event.pull_request` is null). Without that limit, converting a
pull request with a failed mochitest to a draft and closing and reopening it would put newer
skipped successes on the same head. For the same reason, never re-run a draft's run once the
pull request is ready: a re-run keeps the event it started with and skips again.

Marking the pull request ready for review (`gh pr ready <n>`) sends `ready_for_review`, which
ci.yml, e2e.yml, semgrep.yml and codeql.yml list, and runs the skipped checks on the same head.
A draft cannot be merged, and the skipped successes of its draft run cannot let it through
afterwards: CodeQL uploaded no analysis for that head, and the ruleset's code scanning rule
blocks a merge until one exists (seen on draft PR #249, "Docs-only pull requests" above). The
analysis takes minutes, while the same event queues the run's other checks on that head within
seconds, so they are pending, not green, by the time it lands. That margin is timing, not a
rule of GitHub's, so merge by hand only once the new run's checks are green; the automatic
security release waits for them before it sets auto-merge ("Releases" below). Converting a
pull request to a draft (`gh pr ready --undo <n>`) starts no run and leaves its results as
they are.

`tools/ci/tree-covered.mjs` takes no run as a cover when a job other than its guard was
skipped, so a draft's Semgrep run, which scanned nothing, never lets a push to `main` skip its
scan ("Once per tree" below).

The release pull request is the reason (below, "Releases"): release-please rebuilds it after
each merge to `main`, and only the state that is merged is released. Other drafts follow the
same rule: mark one ready to get the mochitests on it. `tools/test/draft-pull-requests.test.mjs`
pins the wiring.
