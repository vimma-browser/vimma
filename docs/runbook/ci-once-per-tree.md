### Once per tree (issue #358)

`ci.yml`, `semgrep.yml` and `pkgbuild.yml` run on pull requests and on pushes to `main`. A
squash merge usually gives `main` a commit whose tree is the pull request head's tree, so the
push run would check the same files again. Their first job on a push, `covered`, runs
`tools/ci/tree-covered.mjs`: it reads the pushed commit's tree and the last 50 successful
`pull_request` runs of the same workflow from the Actions API (both public; the job token holds
`actions: read` and `contents: read`, nothing more), and compares each run's head tree. A run
with the same tree counts only if every job but the guard ran (`actions/runs/<id>/jobs`): a
draft's run skips the Semgrep scan and still succeeds. On a match it outputs `skip=true` and a
notice on the run's summary names the covering run; the other jobs then skip by `if:`. Equal trees include `.github/workflows`, so the covering run used the
same workflow definition. When `main` moved after the pull request's last run, the trees differ
and the checks run as before: the ruleset does not require up-to-date branches
(`strict_required_status_checks_policy: false`), so that run is the only check of the merged
combination. Requiring up-to-date branches instead would re-run every open pull request's
checks after each merge, more than the one push run it saves. A guard that cannot reach the API
warns and lets the checks run; a guard without its variables fails before its verdict, which
leaves the output empty, runs the checks and shows a workflow bug. A docs-only pull request's
run counts as a cover although it skipped the code checks: its tree's code equals its base's,
which an earlier run of `main` checked in full or by the same rule.

`ci.yml` still lints the squash commit's message when it skips: that message is new on `main`
and release-please builds the changelog from it ("Releases" below). `codeql.yml` is not
deduplicated: code scanning keeps `main`'s alerts from analyses uploaded for commits of `main`
and compares a pull request's analysis against the latest one of its base, so a push without an
upload would leave both at the previous merge. Semgrep uploads nothing (its SARIF stays an
artifact of the run), so its push run has nothing to add. `e2e.yml` runs on pull requests only,
and `release.yml` builds once per release, so neither was duplicated.

To check a commit by hand:
`GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=vimma-browser/vimma GITHUB_SHA=<sha> node tools/ci/tree-covered.mjs --workflow ci.yml`.
