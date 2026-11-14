## 10. Firefox updates (the upstream autopilot, `upstream.yml`; the Beta canary, `upstream-beta.yml`)

Vimma is only as safe as the Firefox release under it. The autopilot finds each new release,
rebases our patches onto it, runs the suites and opens the PR; a person reviews and merges a
bump unless `AUTO_MERGE_UPSTREAM` lets GitHub's auto-merge take a green, version-only bump (G13). A merged bump labelled `security` then releases on its own when `AUTO_SECURITY_RELEASE` is
on ([ADR-020](../adr/020-security-release-without-a-person.md), G11 and G12). Spec:
[m7-upstream-autopilot](../specs/m7-upstream-autopilot.md), [ADR-015](../adr/015-upstream-autopilot.md),
playbook: [docs/rebase.md](../rebase.md). The Beta canary tests `main` on each Firefox Beta build and
reports in an issue, so a release's breakage is known before its deadline (spec
[upstream-beta-canary](../specs/upstream-beta-canary.md)).

**Reach:** Mozilla's public feeds (product-details, the MFSA index, archive.mozilla.org, the
Taskcluster index) and this repository. Nothing here runs code from a pull request.

- G1. A newer Firefox release **must** produce a tested bump PR within 6 hours of
  product-details listing it (detection every 4 h, the rebase and suites ≈ 25 min), or, when
  Actions may not open PRs, a pushed branch and a prefilled compare link on its tracking issue.
  [`detects every 4 hours, so a release has a PR within 6 hours`](../../tools/test/upstream-workflow.test.mjs),
  [`finds 157.0.2 as a critical security dot release, 3 days to merge`](../../tools/upstream/test/autopilot.test.mjs),
  [`falls back to a compare link when Actions may not open PRs`](../../tools/test/upstream-workflow.test.mjs),
  [`the fallback comment links a prefilled compare page and keeps the summary`](../../tools/upstream/test/autopilot.test.mjs)
- G2. `upstream.yml` **must** fail, and open a `security` issue that mentions the owner, once the
  Firefox on `main` is more than 3 days behind a security dot release (7 days for a major
  release, 14 for a dot release without an advisory), counted from the release date.
  [`limits: 3 days for a security dot release, 7 for a major, 14 otherwise`](../../tools/upstream/test/releases.test.mjs),
  [`a security dot release is behind for 3 days, then overdue`](../../tools/upstream/test/releases.test.mjs),
  [`the earliest deadline wins: a skipped security release still counts`](../../tools/upstream/test/releases.test.mjs),
  [`the drift job fails the run`](../../tools/test/upstream-workflow.test.mjs),
  [`the drift issue tables every unshipped release and mentions the owner`](../../tools/upstream/test/autopilot.test.mjs)
- G3. A release whose advisories cannot be read **must** count as a security release (label and
  limit), never as one without.
  [`unreadable advisories make security unknown (null), never false`](../../tools/upstream/test/releases.test.mjs),
  [`unknown security status (advisories unreadable) uses the security limit`](../../tools/upstream/test/releases.test.mjs),
  [`an unreachable advisories page: security unknown, labelled security, a warning`](../../tools/upstream/test/autopilot.test.mjs)
- G4. Nothing is **ever** reported on or built from a Firefox source tarball whose SHA-512
  differs from a signed `SHA512SUMS` (B1), a run artifact included: the patch-check report is
  uploaded only after the source check verified the tarball.
  [`nothing is built from a tarball whose SHA-512 Mozilla did not publish`](../../tools/test/upstream-workflow.test.mjs),
  [`test_good_signature_but_a_different_hash_fails_naming_expected_and_actual`](../../tools/upstream/test_verify_sha512.py),
  [`the source check fails on a SHA512SUMS whose signature is not good`](../../tools/upstream/test/source-check.test.mjs),
  [`a report on a tarball that failed verification is never uploaded`](../../tools/test/upstream-workflow.test.mjs),
  [`a tampered tarball already on disk fails like a downloaded one`](../../tools/upstream/test/firefox-source.test.mjs),
  [`no workflow runs surfer download itself`](../../tools/test/full-build-workflows.test.mjs)
- G5. A bump PR is **never** opened ready for review unless every patch applies and the suites
  passed on the new release; otherwise it is a draft that names the conflicting files and hunks.
  [`a ready PR only when patches apply, suites pass and a token starts CI`](../../tools/upstream/test/autopilot.test.mjs),
  [`a conflicting bump is a draft that lists the conflicts`](../../tools/upstream/test/autopilot.test.mjs),
  [`lists the conflicting files and hunks, fuzz included`](../../tools/upstream/test/autopilot.test.mjs)
- G6. The autopilot's jobs **must** run with least privilege: nothing by default, write access
  only in the job that publishes, no secret in detection, the patch check or the suites, no
  `pull_request_target`, every action pinned by commit SHA. The Beta canary's issues reach the
  bump PR through `detect`'s existing `issues: read`; only their numbers and states reach its
  body, so no issue text is rendered there.
  [`grants nothing by default and each job only what it needs`](../../tools/test/upstream-workflow.test.mjs),
  [`detect finds the canary's issues for the release's major, open and closed`](../../tools/test/upstream-workflow.test.mjs),
  [`reads the issue list from upstream.yml and keeps only issue numbers and states`](../../tools/upstream/test/autopilot.test.mjs),
  [`no secret reaches detection, the patch check or the suites`](../../tools/test/upstream-workflow.test.mjs),
  [`no workflow runs on pull_request_target`](../../tools/test/upstream-workflow.test.mjs),
  [`every action it uses is pinned by a full commit SHA`](../../tools/test/upstream-workflow.test.mjs)
- G7. The prefs we copy from upstream (the cfr provider, the Safe Browsing lists) **must** match
  the release under test, or the suites fail with the line to paste. The autopilot refreshes a
  stale copy only from the verified tarball (G4), only in `firefox-branding.js`'s three copied
  lines, and only through the `workflow_call` input of `e2e.yml`, so a pull request run never
  rewrites prefs; a pref gone upstream is never guessed and keeps the PR a draft. No new token or
  secret: `publish` commits the refresh with its existing `contents: write`.
  Patches that need only fuzz are re-exported (`reexport.py`) from the same verified files;
  a result whose added or removed lines differ is refused, `publish` copies in only
  `src/**/*.patch` paths as a second commit, and such a PR waits for the owner.
  [`test_reexport_keeps_added_and_removed_lines`](../../tools/upstream/test_reexport.py),
  [`test_a_report_label_outside_src_is_refused`](../../tools/upstream/test_reexport.py),
  [`publish commits re-exported patches as a second commit, only under src/`](../../tools/test/upstream-workflow.test.mjs),
  [`writes the derived cfr line when upstream adds a field`](../../tools/upstream/test/upstream-prefs.test.mjs),
  [`the diff touches only the three copied pref lines`](../../tools/upstream/test/upstream-prefs.test.mjs),
  [`reports unresolved and writes nothing for a pref missing upstream`](../../tools/upstream/test/upstream-prefs.test.mjs),
  [`source-check computes the refresh only after the SHA-512 check passed`](../../tools/test/upstream-workflow.test.mjs),
  [`a pull request run never writes prefs`](../../tools/test/upstream-workflow.test.mjs),
  [`a pref gone upstream makes the PR a draft that names it`](../../tools/upstream/test/autopilot.test.mjs),
  [`our branding prefs match Firefox 157.0.1's`](../../tools/upstream/test/upstream-prefs.test.mjs),
  [`a new upstream cfr field is reported with the line to paste`](../../tools/upstream/test/upstream-prefs.test.mjs),
  [`a pref upstream renamed or removed is its own problem, not a silent pass`](../../tools/upstream/test/upstream-prefs.test.mjs)
- G8. Every upstream file Vimma patches **must** have a line in the ADR-003 register with a hunk
  and line budget it stays within, and a person **must** review each patch at least once a
  quarter: `patch-audit.yml` opens an `upstream` `audit` issue on the first day of each quarter,
  listing reviews over 92 days old, with `issues: write` only in the job that runs no repository
  code.
  [`test_a_patch_over_its_hunk_or_line_budget_fails_the_audit`](../../tools/upstream/test_patch_audit.py),
  [`test_a_register_line_without_a_budget_or_review_date_fails_the_audit`](../../tools/upstream/test_patch_audit.py),
  [`test_within_budget_passes_and_reviews_over_92_days_old_are_due`](../../tools/upstream/test_patch_audit.py),
  [`test_every_patch_has_a_budget_and_review_date_and_stays_within_it`](../../tools/upstream/test_patch_audit.py),
  [`runs on the first day of each quarter, and by hand`](../../tools/test/patch-audit-workflow.test.mjs),
  [`grants nothing by default; issues: write only in the report job`](../../tools/test/patch-audit-workflow.test.mjs),
  [`the job holding the issue token never checks out or runs repository code`](../../tools/test/patch-audit-workflow.test.mjs)
- G9. The Beta canary **must never** write anything but issues: nothing granted by default,
  `issues: write` only in the report job, which checks out and runs no repository code and runs
  only on `main`; no secret, no push, no commit, no pull request, no change to the Firefox pin,
  no `pull_request_target`; every job skipped in a fork. A new issue mentions the owner; an update,
  a comment or a close never does, and test output is fenced so it cannot mention or link.
  [`grants nothing by default and no job more than issues: write`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`the job with issues: write checks out and runs no repository code`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`the report job runs only on main`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`no job pushes, commits or opens a pull request`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`no secret reaches any job, and the e2e call passes none`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`every job is skipped outside vimma-browser/vimma`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`every action is pinned by a full commit SHA`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`mentions the owner only when it opens an issue`](../../tools/upstream/test/canary.test.mjs),
  [`fences test output and cuts the body to 60,000 characters`](../../tools/upstream/test/canary.test.mjs),
  [`surfer.json on main pins a Firefox release, never a beta`](../../tools/test/surfer-pin.test.mjs)
- G10. The Beta canary **must never** build from or report on a Beta source tarball whose SHA-512
  differs from that Beta's signed `SHA512SUMS` (B1): the source check fails the run before the
  suites or the issue (G4 for Betas).
  [`nothing is built from a tarball whose SHA-512 Mozilla did not publish`](../../tools/test/upstream-beta-workflow.test.mjs),
  [`test_good_signature_but_a_different_hash_fails_naming_expected_and_actual`](../../tools/upstream/test_verify_sha512.py),
  [`a report on a tarball that failed verification is never uploaded`](../../tools/test/upstream-workflow.test.mjs)
- G11. A merged `upstream` PR labelled `security` **must** set the release PR to auto-merge in the
  same `release-please.yml` run when `AUTO_SECURITY_RELEASE` is on, pinned to the release PR's
  head commit, and **never** any other PR. The merge goes through `RELEASE_PLEASE_TOKEN` and
  GitHub's auto-merge, so the `main` ruleset's required checks still gate it. The release PR
  opens as a draft, whose rebuilds skip the mochitests, Semgrep and CodeQL while still reporting
  every required check (docs/runbook/ci-draft-pull-requests.md, "Draft pull requests"); the job marks it ready for review
  through the same token, which starts those checks on the pinned head, and sets auto-merge only
  once the newest mochitest and Semgrep checks there are not the draft's skips. No CodeQL
  analysis exists for a draft's head, so the code scanning rule also holds the merge until the
  run after "ready for review" has uploaded one. Only `opened` and `synchronize` skip, so no
  skipped success ever replaces a real result on a head, and a run whose checks were skipped
  never covers a push to `main` (`tools/ci/tree-covered.mjs`). release-please rebuilds the
  release PR from `main` on every push (`"always-update"`), and the one other commit on it, the
  `firefox-notes` job's `CHANGELOG.md` edit (the hand-written `[Unreleased]` lines and the Firefox
  version), is made by `main`'s code from the release branch's files read as data, names the blob
  it replaces so that a rebuild in between makes it fail rather than overwrite, and is pushed
  before this job pins the head. The pin is checked when auto-merge is set: a later push to
  `main` rebuilds the release PR, and auto-merge then merges the newest head once its required
  checks pass. A head that release-please pushed without the `firefox-notes` commit fails CI's
  `changelog-lint` step (its `[Unreleased]` is not the first heading), so it cannot merge.
  [`fails when [Unreleased] is not the first version heading`](../../tools/release/test/changelog.test.mjs),
  [`firefox-notes reads the release branch as data and does nothing without the token`](../../tools/package/test/release-workflow.test.mjs),
  [`firefox-notes moves [Unreleased] into the new entry before naming the Firefox version`](../../tools/package/test/release-workflow.test.mjs),
  [`sets auto-merge only once the slow checks of the ready run have replaced the draft's`](../../tools/release/test/security-release.test.mjs),
  [`finds no cover in a run whose checks were skipped, such as a draft's`](../../tools/ci/test/tree-covered.test.mjs),
  [`marks a draft release PR ready for review, then sets it to auto-merge`](../../tools/release/test/security-release.test.mjs),
  [`the mochitests, Semgrep and CodeQL skip a draft and still report their required checks`](../../tools/test/draft-pull-requests.test.mjs),
  [`CodeQL still uploads an analysis for every pull request that is not a draft`](../../tools/test/draft-pull-requests.test.mjs),
  [`auto-merges the release PR after a merged security bump`](../../tools/release/test/security-release.test.mjs),
  [`does nothing for an upstream bump without the security label`](../../tools/release/test/security-release.test.mjs),
  [`does nothing for a security-labelled PR from another branch or a fork`](../../tools/release/test/security-release.test.mjs),
  [`does nothing for a commit whose subject is not an upstream bump`](../../tools/release/test/security-release.test.mjs),
  [`refuses a release PR with another author, branch, base, label or title`](../../tools/release/test/security-release.test.mjs),
  [`refuses when the release PR does not contain the bump commit`](../../tools/release/test/security-release.test.mjs),
  [`pins the merge to the release PR's head commit`](../../tools/release/test/security-release.test.mjs),
  [`security-release runs only on a push to main of vimma-browser/vimma`](../../tools/package/test/release-workflow.test.mjs),
  [`RELEASE_PLEASE_TOKEN reaches only release-please, the changelog push and the auto-merge`](../../tools/package/test/release-workflow.test.mjs),
  [`release-please.yml grants nothing by default and each job only what it needs`](../../tools/package/test/release-workflow.test.mjs)
- G12. The automatic path **must never** merge the first release PR, and **must** stop when the
  variable is unset; with the variable on and no `RELEASE_PLEASE_TOKEN` it fails the run.
  [`refuses before the first release exists`](../../tools/release/test/security-release.test.mjs),
  [`does nothing when AUTO_SECURITY_RELEASE is off`](../../tools/release/test/security-release.test.mjs),
  [`asks the API nothing while the variable is off or outside main`](../../tools/release/test/security-release.test.mjs),
  [`fails when the variable is on and RELEASE_PLEASE_TOKEN is missing`](../../tools/release/test/security-release.test.mjs)

- G13. An upstream bump PR **must** be allowed to auto-merge only by `publish` run on `main`, only
  when `AUTO_MERGE_UPSTREAM` allows its release kind, only for a non-draft PR whose every patch
  applied clean or with an offset and whose diff changes nothing but `version.version` in
  `surfer.json` and the copied pref lines, and only for the head commit that diff was read from,
  which `publish` records in a hidden marker in the PR body. `upstream-merge.yml`, run from
  `main` (`workflow_run`) each time a workflow on the PR completes, **must** set auto-merge only
  on a PR opened by the App from a branch of this repository, at the marked head, and only once
  every workflow run the PR started on that head finished green or skipped and no check on it
  failed: the macOS mochitests and package checks that the ruleset does not require hold the
  merge too. GitHub's auto-merge then still waits for every required check of the `main` ruleset
  (spec [upstream-bump-automation](../specs/upstream-bump-automation.md), ADR-022). The marker
  grants nothing on its own: a person who can edit the body can already merge.
  [`auto-merge only with the variable, the token, a ready PR and the allowlist`](../../tools/test/upstream-workflow.test.mjs),
  [`publish never sets auto-merge: upstream-merge.yml does, once every check is green`](../../tools/test/upstream-workflow.test.mjs),
  [`reads every run and check of the head, and merges that head only, with the bump's subject`](../../tools/test/upstream-merge-workflow.test.mjs),
  [`runs when any workflow a pull request starts completes, and on nothing else`](../../tools/test/upstream-merge-workflow.test.mjs),
  [`acts only on this repository's upstream branches, with the App set up`](../../tools/test/upstream-merge-workflow.test.mjs),
  [`refuses a failed, cancelled, timed-out or unapproved run or check`](../../tools/upstream/test/merge-ready.test.mjs),
  [`only for the App's own non-draft PR at the head the autopilot allowed`](../../tools/upstream/test/merge-ready.test.mjs),
  [`the allowlist reads the branch as pushed`](../../tools/test/upstream-workflow.test.mjs),
  [`rebuild disables auto-merge before the push`](../../tools/test/upstream-workflow.test.mjs),
  [`dot allows dot releases only; unset or anything else allows none`](../../tools/upstream/test/autopilot.test.mjs),
  [`names the first condition that did not hold`](../../tools/upstream/test/autopilot.test.mjs),
  [`never with patches that needed fuzz, were re-exported or are applied already`](../../tools/upstream/test/autopilot.test.mjs),
  [`refuses another line in firefox-branding.js`](../../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a re-exported patch`](../../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a new, deleted, renamed or mode-changed file`](../../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a file header it does not recognise instead of folding it into the last file`](../../tools/upstream/test/bump-diff.test.mjs)
- G14. The private key of the org's GitHub App `vimma-upstream-autopilot`, the secret
  `UPSTREAM_APP_KEY` of the `upstream-autopilot` environment, **must** reach only the `publish`
  job and `upstream-merge.yml`'s `merge` job (which mints a token with Contents and Pull requests
  write only, and runs main's code), and that environment's only deployment policy is the branch `main`, so a workflow edited
  on another branch cannot read it. Each run mints a one-hour token for this repository alone with
  Contents, Pull requests and Issues read and write and no Workflows, so it cannot change a
  workflow file. Without the App (the variable `UPSTREAM_APP_ID` unset), bumps open as drafts with
  `GITHUB_TOKEN` and are never set to auto-merge. A leaked key could open pull requests and set
  auto-merge on any that pass the required checks; revoke it on the App's page.
  [`the App's key reaches only publish, which deploys to upstream-autopilot`](../../tools/test/upstream-workflow.test.mjs),
  [`mints the App token for this repository alone, before the checkout`](../../tools/test/upstream-workflow.test.mjs),
  [`publish pushes and opens the PR with the App token, else GITHUB_TOKEN`](../../tools/test/upstream-workflow.test.mjs),
  [`asks for contents, pull requests and issues, and nothing else`](../../tools/upstream/test/create-app.test.mjs),
  [`names every deployment policy other than the branch main`](../../tools/upstream/test/create-app.test.mjs),
  [`grants nothing by default and each job only what it needs`](../../tools/test/upstream-workflow.test.mjs)
- G15. The `patch-issue` job (patches that do not apply) **must** use only `GITHUB_TOKEN` with
  `contents: read` and `issues: write`, check out without persisted credentials, and pass the
  issue text to `gh` only through `--body-file`. No workflow holds an AI secret: no model runs in
  CI on a failing bump.
  [`patch-issue runs only on a failed patch check, with issues: write and no secret`](../../tools/test/upstream-workflow.test.mjs),
  [`patch-issue updates the open issue with the same title`](../../tools/test/upstream-workflow.test.mjs),
  [`no workflow holds an AI secret`](../../tools/test/upstream-workflow.test.mjs)
