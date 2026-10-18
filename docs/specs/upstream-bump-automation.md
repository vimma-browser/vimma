# Spec: upstream-bump-automation

Status: implemented · Area: `.github/workflows/upstream.yml`, `.github/workflows/e2e.yml`,
`tools/upstream/source-check.sh`,
`tools/upstream/patch-check.py`, `tools/upstream/upstream-prefs.mjs`,
`tools/upstream/autopilot-body.mjs`, `tools/upstream/bump-diff.mjs` (new),
`tools/upstream/reexport.py` (new), `docs/rebase.md`, `docs/runbook.md`, `docs/security.md`,
`docs/limits.md` · Upstream patches: none · ADR: ADR-022 (new, "A green Firefox bump merges
itself"), which amends [ADR-015](../adr/015-upstream-autopilot.md)

Issue: [#259](https://github.com/vimma-browser/vimma/issues/259)

## Summary

The upstream autopilot (spec [m7-upstream-autopilot](m7-upstream-autopilot.md), ADR-015) turns
a Firefox release into a tested bump pull request, but a person still merges it, pastes refreshed
pref copies into it and re-exports any patch that no longer applies. This spec closes those three
gaps: the autopilot writes refreshed pref copies into the bump itself, re-exports patches that
only lost context, opens a triage issue that lists the hunks of patches whose lines changed, and
sets a green bump whose diff is limited to the expected lines to merge through GitHub's
auto-merge, behind the same required checks as every other pull request. Releasing the merged
bump is out of scope ([#220](https://github.com/vimma-browser/vimma/issues/220)).

## Problem

Plan §6 sets the M7 exit criterion "two consecutive Firefox releases rebased and shipped with
zero manual steps". Today, for Firefox 158.0 (the version `surfer.json` pins on `main`):

- **Merging.** The autopilot's `publish` job opens `upstream: firefox X.Y.Z` and stops. No
  workflow merges it. `UPSTREAM_PR_TOKEN` is not set in the repository (`gh secret list`,
  checked against `vimma-browser/vimma`), so the PR is opened with `GITHUB_TOKEN`, as a draft, and the
  required checks do not run until a person marks it ready.
- **Pref copies.** `src/browser/branding/vimma/pref/firefox-branding.js` copies three upstream
  prefs: the cfr provider (`browser.newtabpage.activity-stream.asrouter.providers.cfr`, with
  `"enabled":false`) and the Safe Browsing lists
  (`browser.safebrowsing.provider.google4.lists` and `….google5.lists`, minus the two lists only
  Mozilla's key may fetch). When upstream changes one, `tools/upstream/upstream-prefs.mjs` fails
  the `mochitest (artifact build)` job and prints the line to paste; the bump becomes a draft and
  waits for a person.
- **Patches.** A patch that needs fuzz (applies only with less context) or fails (its lines are
  gone) makes the bump a draft listing the hunks. A person re-exports the patch by hand
  (`docs/rebase.md`, steps 2 and 3) or comments `@claude` on the PR. The `@claude` job in
  `claude.yml` has a read-only token and cannot push, and no Claude secret is set, so it does not
  run at all.

A Firefox security dot release therefore reaches `main` only when the maintainer acts, and the
drift check (docs/security.md, G2) fails the scheduled run after 3 days.

## Behaviour

1. **Pref refresh.** When the new release changes the upstream value of a copied pref, the bump
   commit also updates that pref's line in `firefox-branding.js` to the value derived from the new
   release, and the PR body lists each refreshed pref with its old and new value. The suites in
   the autopilot's `test` job run with the refreshed lines.
2. **Pref refresh limits.** When a copied pref is missing upstream (renamed or removed), nothing
   is refreshed for it; the PR is a draft and names the pref, as today.
3. **Fuzz re-export.** When a patch applies only with fuzz and none fails, the bump branch gets a
   second commit, `upstream: re-export <patch> for firefox X.Y.Z`, with each such patch
   re-exported against the new release. Its added and removed lines are unchanged; only context
   and line numbers move. The PR body lists each re-exported patch.
4. **Failing patches.** When a patch fails, the PR stays a draft as before, and the autopilot
   opens a GitHub issue titled `Firefox X.Y.Z: patches do not apply`, labelled `upstream` and
   `triage`, that lists each failing patch with its failing hunks and links the bump PR and the
   run. A later run for the same version updates that issue instead of opening another. A person,
   or GitHub Copilot coding agent assigned to the issue, re-exports the patches on the bump branch.
5. **Auto-merge.** A bump PR is set to auto-merge (squash, the subject `upstream: firefox X.Y.Z
(#N)`) only when all of these hold: the repository variable `AUTO_MERGE_UPSTREAM` allows the
   release kind (`dot` allows dot releases, `all` also majors; unset or anything else allows none);
   `UPSTREAM_PR_TOKEN` is set; the PR is not a draft; every patch applied clean or with an offset,
   Mozilla's artifacts existed and the autopilot's suites passed; and its diff against `main`
   changes only the `version.version` value in `surfer.json` and copied-pref lines in
   `firefox-branding.js`. GitHub then merges it once every check the `main` ruleset requires is
   green.
6. **No auto-merge with changed patches.** A bump with re-exported (3) or failing (4) patches is
   never set to auto-merge; it is marked ready for review and mentions the owner.
7. **Explained outcome.** The PR body's table gains a row "Auto-merge" that says "on" or names the
   first condition of 5 that did not hold.
8. **Rebuilds.** `gh workflow run upstream.yml -f rebuild=true` turns auto-merge off on the open
   bump PR before it replaces the branch, then decides again for the new head.

## Research

Checked on 2026-10-15 against `main` at 1e77af6 (Firefox 158.0 pinned), GitHub CLI 2.102.0 and
GitHub's documentation as published that day.

- **Repository settings** (`gh api repos/vimma-browser/vimma`): `allow_auto_merge: true`, squash only,
  `delete_branch_on_merge: true`. Actions workflow permissions (`…/actions/permissions/workflow`):
  default `read`, `can_approve_pull_request_reviews: true`, so the autopilot may open PRs.
- **Ruleset `main`** (`gh api repos/vimma-browser/vimma/rulesets/…`): pull requests only, squash, 0
  approvals, no bypass actors; required checks `lint, typecheck, test, commitlint, licences`,
  `semgrep (javascript, typescript, rust, secrets, github-actions)`,
  `CodeQL (javascript-typescript)`, `CodeQL (rust)` and `mochitest (artifact build)`; the CodeQL
  code-scanning gate. It also sets `require_extra_approval_for_unattributed_changes: true`, whose
  effect on an auto-merged PR has not been verified (spec firefox-versions, Research, notes the
  same); sub-PR 2's dry run checks it.
- **Secrets** (`gh secret list`): only `SAFEBROWSING_API_KEY`. Neither `UPSTREAM_PR_TOKEN` nor
  `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` is set.
- **`GITHUB_TOKEN` events** (GitHub Actions documentation, "Triggering a workflow"): events caused
  by `GITHUB_TOKEN` create no workflow run, except `workflow_dispatch` and `repository_dispatch`;
  a PR opened or updated with it creates runs in an approval-required state. So a bump opened,
  pushed or merged with `GITHUB_TOKEN` gets no required checks without a person, and its merge
  would not start the `push` workflows on `main` (`release-please.yml` among them).
- **Auto-merge** (GitHub documentation, "Automatically merging a pull request"): "Auto-merge is
  disabled if someone without write permissions pushes new changes to the head branch or switches
  the base branch." A push by an account with write access keeps it on. The documentation does
  not say whether auto-merge can be enabled on a draft, so the autopilot checks `isDraft` itself.
  `gh pr merge --auto --squash --match-head-commit <sha>` (GitHub CLI 2.102.0) enables it only
  when the PR's head is that commit.
- **Fine-grained personal access tokens** (GitHub documentation, "Permissions required for
  fine-grained personal access tokens"): pushing a change under `.github/workflows/` needs the
  separate "Workflows" permission. A token with only Contents and Pull requests (read and write)
  cannot change a workflow. Not tested with a token in this repository.
- **Patch format.** Every `src/**/*.patch` is `git diff` output from `surfer export` (header
  `diff --git a/… b/…`, an `index` line, three lines of context), for example
  `src/browser/modules/URILoadingHelper-sys-mjs.patch`. `tools/upstream/patch-check.py` already
  extracts the patched files from the streamed tarball and checks each hunk with `git apply
--check -C2`/`-C1` for fuzz.
- **Patches that the artifact build cannot test.** `src/toolkit/xre/nsAppRunner-cpp.patch` (C++),
  `src/moz-build.patch`, `src/browser/moz-configure.patch` and `src/browser/base/moz-build.patch`
  change compiled code or the build. PR CI's artifact build reuses Mozilla's compiled binaries, so
  it does not exercise them ([ADR-010](../adr/010-pr-artifact-builds.md), Known gaps), and
  `docs/limits.md` ("Build and CI") requires a full-build run for any PR that touches patches.
- **Existing auto-merge.** `.github/workflows/dependabot-automerge.yml` enables auto-merge for some
  Dependabot PRs with `GITHUB_TOKEN`; spec firefox-versions (decision 18) makes the release PR's
  merge with the fine-grained `RELEASE_PLEASE_TOKEN`, so the push to `main` starts release-please.
- **Claude in Actions.** `claude.yml` runs `anthropics/claude-code-action` v1.0.248 (pinned by SHA)
  with `github_token: github.token`, so the job's `permissions:` block is all Claude gets, and
  skips every step when neither Claude secret is set. Its `spec` job commits with a read-only token
  and a separate job without Claude pushes the commits. This spec does not use it (decision 16).

## Design

### Pref refresh (sub-PR 1)

`patch-check.py` gains `--extract PATH` (repeatable): the named files are extracted from the same
stream as the patched files. `source-check.sh` extracts `browser/app/profile/firefox.js` and
`modules/libpref/init/all.js`, and after the SHA-512 check passes runs
`upstream-prefs.mjs --firefox-js … --all-js … --write-diff prefs-refresh.patch`. That writes a
`git diff` of `firefox-branding.js` with each stale line replaced by `prefLine()` of the derived
value, and sets the step output `prefs` to `current`, `refreshed` or `unresolved` (a pref missing
upstream). The patch goes into the `patch-check` artifact. `e2e.yml` gets a `workflow_call` input
`prefs-patch-artifact`; when the autopilot passes it, the job applies the patch before the
upstream-prefs check. `publish` applies the same patch before its commit.

1. **The refresh is computed once, in `patch-check`, from the verified tarball**, because that job
   always runs (also when Mozilla's artifacts are missing and the suites are skipped) and already
   holds the SHA-512-checked stream (G4). Rejected: computing it in `e2e.yml` after `npm run
import`, because no refresh would exist when the suites are skipped, and `publish` would need a
   second source of truth.
2. **The suites test the refreshed lines**, so that a green `test` job means the bump as it will be
   committed passed. Rejected: refreshing only in `publish`, because the suites would run on the
   stale lines and fail.
3. **PR CI keeps the strict check.** On a pull request `e2e.yml` never writes prefs, so a bump
   branch that lacks the refresh still fails `mochitest (artifact build)`. The input exists only
   on `workflow_call`, so no pull request can turn the check into a rewrite.
4. **One commit.** The refreshed lines join the `upstream: firefox X.Y.Z` commit, and its body
   lists them, because the squash merge keeps one subject either way and a reader of `main` sees
   the bump and its pref changes together.
5. **A missing upstream pref is not guessed.** `unresolved` makes the PR a draft as today, because
   a renamed pref needs a person to find its new name.

### Auto-merge (sub-PR 2)

After `publish` has opened or updated the PR, a step runs `tools/upstream/bump-diff.mjs`, which
reads `git diff --unified=0 origin/main...HEAD` and accepts it only when the changed files are
`surfer.json` and optionally `firefox-branding.js`; `surfer.json` re-parses to the same object as
`main`'s except `version.version`; and every changed line of `firefox-branding.js` is a
`pref("<copied pref>", …);` line for one of the three copied prefs. When this and every condition
of Behaviour 5 hold, the step runs `gh pr merge --auto --squash --match-head-commit <sha>
--subject "upstream: firefox X.Y.Z (#N)" --body <the bump commit's body>` with
`UPSTREAM_PR_TOKEN`.

6. **GitHub's auto-merge, not a merge call**, because GitHub merges only once every required check
   of the `main` ruleset is green, so nothing in this workflow decides that the checks passed or
   can skip one. Rejected: `gh pr merge` after polling the checks, because it would re-implement
   the ruleset and race with it.
7. **`UPSTREAM_PR_TOKEN` opens, pushes and enables auto-merge**, because a `GITHUB_TOKEN` PR gets
   its required checks only after a person approves the runs, and a merge made with
   `GITHUB_TOKEN` would not start the `push` workflows on `main`, which the security release path
   of spec firefox-versions relies on. The token is fine-grained, limited to this repository, with
   Contents and Pull requests read and write and nothing else, so it cannot change a workflow
   file. It follows spec firefox-versions decision 18: a personal token for one maintainer, a
   GitHub App when a second maintainer joins or an expiry first breaks a bump. Rejected:
   dispatching `ci.yml`, `e2e.yml`, `semgrep.yml` and `codeql.yml` with `workflow_dispatch` on the
   branch, because whether those runs satisfy the ruleset's code-scanning gate for a PR is not
   documented, and the merge would still not start `push` workflows.
8. **A diff allowlist, checked line by line**, so that a defect in the autopilot (a wrong file in
   the commit, a stray edit from the pref refresh) cannot merge without a person. It is checked
   on the branch as pushed, not on what `publish` meant to push.
9. **`--match-head-commit`**, so that auto-merge applies only to the commit the allowlist checked.
   A later push by a person with write access keeps auto-merge on (Research); that person is a
   maintainer, who can merge anyway.
10. **Off until the maintainer turns it on.** `AUTO_MERGE_UPSTREAM` is a repository variable,
    unset by default, with `dot` and `all` as its values, because ADR-015 rejected auto-merge
    "before Vimma has been daily-driven", and a variable lets the maintainer choose the moment and
    the release kinds without another code change. ADR-022 records the change to ADR-015.
11. **A draft is never auto-merged**, checked from `gh pr view --json isDraft`, because the draft
    state is how the autopilot marks a bump that needs a person (G5), and GitHub does not document
    whether it refuses auto-merge on a draft.
12. **A failing required check leaves the PR open**, with auto-merge pending. No retry or comment
    is added, because the drift check (G2) already fails the scheduled run and opens a `security`
    issue at the deadline.
13. **Rebuild turns auto-merge off first** (`gh pr merge --disable-auto`), so that a branch
    replaced by `-f rebuild=true` is never merged on the strength of a decision about its previous
    head.

### Patch re-export (sub-PR 3)

`tools/upstream/reexport.py` takes the patch-check report and the extracted upstream files. For
each `fuzz` patch it applies the patch with the context it needed (`git apply -C<n>` and Surfer's
whitespace flags) to a scratch git repository holding the pristine files, then writes `git diff`
of the result in `surfer export`'s format. It refuses a result whose added and removed lines
differ from the original patch's. `source-check.sh` runs it after the SHA-512 check;
`publish` commits the re-exported patches as a second commit.

14. **Fuzz is re-exported without a model**, because a fuzz hunk applies with less context and the
    re-export only moves context and line numbers; the added and removed lines are compared, so a
    re-export that changed them is refused, not committed.
15. **No auto-merge when any patch changed**, because the artifact build does not compile C++, the
    build files or configure (Research), and `docs/limits.md` requires a full-build run for any PR
    that touches patches. The PR is marked ready and mentions the owner. When the hosted full
    build of [#224](https://github.com/vimma-browser/vimma/issues/224) can run on a pull request, this
    decision is revisited in that spec.

### Issue for failing patches (sub-PR 4)

A job `patch-issue` in `upstream.yml` runs after `publish` when the patch check's result is
`fail`. It renders the issue body with `autopilot-body.mjs patch-issue` from the `patch-check`
artifact (the same conflicts list the PR body carries), finds an open issue with the exact title
`Firefox X.Y.Z: patches do not apply`, and edits its body, or creates it with the labels
`upstream` and `triage`.

16. **No model runs in CI**, because the re-export of a patch whose lines changed needs a
    judgement about Vimma's change, and an issue lets a person or GitHub Copilot coding agent make
    it outside the autopilot, with the same review as any other pull request. No AI secret is
    added to the repository. Rejected: running Claude in a workflow on the failing patches,
    because it adds a secret, sends source to a third-party API from CI, and needs a second job
    to validate and push what the model wrote.
17. **`GITHUB_TOKEN` with `issues: write` (and `contents: read` for a credential-free checkout
    of `tools/upstream`), on that job alone**, because opening or editing an issue is all it does; `UPSTREAM_PR_TOKEN` and every other secret stay out of it.
18. **One issue per Firefox version, found by its exact title**, so that a rebuild or a later
    run updates the list instead of adding a duplicate.
19. **Hunks come only from the verified tarball's patch check**, rendered by the code that
    renders the PR body: every outside string is escaped or fenced (G4), and none reaches a shell
    command, because the body is written to a file and passed with `--body-file`.
20. **Labelled `triage`**, so that the issue appears in the maintainer's triage queue and can be
    assigned to a person or to Copilot coding agent from there.
21. **A bump with failing patches never auto-merges**, because the PR is a draft (decision 11)
    and its fix changes patches (decision 15).

### Rollout

22. **Auto-merge covers dot and major releases once `AUTO_MERGE_UPSTREAM` is `all`**, because
    Vimma is daily-driven on `main`, so a major that passes every required check is reviewed in
    use, and a held-back major would delay the M7 exit criterion. The variable stays the switch
    (unset means off), so auto-merge starts only when it is set deliberately; `dot` remains
    available to hold majors back again. Merging to `main` publishes nothing, since releases are
    gated separately (spec release-versioning). Rejected: `dot` first, because it keeps a manual
    step for every major with no check a person adds that the required checks lack.
23. **Failing patches go to an issue, not to a model in CI** (decision 16). Rejected: Claude in
    CI with `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, for the reasons in decision 16.

## Security and privacy

The change adds write paths, so `docs/security.md` section 10 gains guarantees (numbered after
the existing G1 to G10) with their tests:

- Auto-merge is enabled only by `publish` on `main`'s code, only for a non-draft PR whose diff
  passes `bump-diff.mjs`, only with `--match-head-commit`, and only when `AUTO_MERGE_UPSTREAM`
  allows it. The `main` ruleset's required checks and code-scanning gate still decide the merge.
- `UPSTREAM_PR_TOKEN` reaches only `publish`; it is
  fine-grained (this repository, Contents and Pull requests), so it cannot edit workflows. A
  leaked token could open and merge PRs that pass the required checks, the same reach as the
  maintainer's own account minus workflows; it is revoked in the token settings.
- The failing-patches issue is written by `patch-issue` with `GITHUB_TOKEN` and `issues: write`
  only; no secret reaches it, and no model runs in any job.
- No job runs on `pull_request_target` or `workflow_run`. Every action stays pinned by a full commit SHA.
- `SAFEBROWSING_API_KEY` reaches no job of the autopilot, as before.

These workflows hold write tokens and secrets, so sub-PRs 1, 2 and 4 get an independent security
review before merging ([docs/review-checklist.md](../review-checklist.md)).

## Tests

Written first, each seen to fail.

- `tools/upstream/test/upstream-prefs.test.mjs`: `writes the derived cfr line when upstream adds a
field`; `writes both Safe Browsing lists without the Mozilla-key lists`; `leaves a current file
byte-identical`; `reports unresolved and writes nothing for a pref missing upstream`; `the diff
touches only the three copied pref lines`.
- `tools/upstream/test_patch_check.py`: `test_extract_writes_requested_files_from_the_stream`.
- `tools/upstream/test/bump-diff.test.mjs`: `accepts a surfer.json version bump`; `accepts a bump
with refreshed pref lines`; `refuses another surfer.json key`; `refuses another file`; `refuses
another line in firefox-branding.js`; `refuses a re-exported patch`.
- `tools/upstream/test/autopilot.test.mjs`: the Auto-merge row for each condition of Behaviour 5;
  `lists refreshed prefs with old and new values`; `lists re-exported patches`.
- `tools/upstream/test_reexport.py`: `test_fuzz_patch_is_reexported_and_applies_clean`;
  `test_reexport_keeps_added_and_removed_lines`; `test_failed_patch_is_not_reexported`.
- `tools/test/upstream-workflow.test.mjs`: `auto-merge only with the variable, the token, a ready
PR and the allowlist`; `auto-merge uses --match-head-commit`; `rebuild disables auto-merge
before the push`; `the e2e call passes the prefs patch and no secret`.
- `tools/upstream/test/autopilot.test.mjs`: the failing-patches issue lists each failing hunk and
  links the PR and run.
- `tools/test/upstream-workflow.test.mjs`: `patch-issue runs only on a failed patch check, with
issues: write and no secret`; `patch-issue updates the open issue with the same title`.
- `tools/test/upstream-workflow.test.mjs` also covers `e2e.yml`: `a pull request run never writes
prefs`.
- actionlint (with shellcheck) on every changed workflow.
- Dry runs, one per sub-PR, with `gh workflow run upstream.yml -f rebuild=true` against a scratch
  pin (`surfer.json` one release behind, on a branch), recorded in the PR: the refreshed lines,
  the Auto-merge row, the merge made by GitHub, and the effect of
  `require_extra_approval_for_unattributed_changes`.

## Docs and changelog

- `docs/rebase.md`: section 1 (the new commits and the auto-merge step), the "Decide" list, and the
  "At a glance" table, where step 8 becomes automatic for an allowlisted bump.
- `docs/runbook.md`: owner setup (the token's exact permissions, `AUTO_MERGE_UPSTREAM`), and how to turn auto-merge off (unset the variable, or `gh pr merge --disable-auto`).
- `docs/security.md` section 10: the guarantees above.
- `docs/limits.md` ("Build and CI"): the gaps this closes come out; what remains (patch changes wait
  for a person until #224) stays.
- `plan.md` §6, M7 status: updated when the last sub-PR merges.
- `CHANGELOG.md`: none of this changes the browser, so no user-facing line; each sub-PR's commit
  subject is a `ci` or `feat(upstream)` line.

## Delivery

1. **Pref refresh** (Behaviour 1, 2): `patch-check.py --extract`, `upstream-prefs.mjs
--write-diff`, `source-check.sh`, the `e2e.yml` input, `publish`, PR body.
2. **Auto-merge** (Behaviour 5, 7, 8): `bump-diff.mjs`, the `publish` step, ADR-022,
   `docs/security.md`, runbook setup. Needs `UPSTREAM_PR_TOKEN` for its dry run.
3. **Fuzz re-export** (Behaviour 3, 6): `reexport.py`, `source-check.sh`, `publish`.
4. **Issue for failing patches** (Behaviour 4): the `patch-issue` job, its texts and tests,
   `docs/security.md`.

Each sub-PR is merged before the next starts. Sub-PRs 1, 2 and 4 change workflows that hold write
tokens or secrets and get a fresh security review.

## Open questions

None. The rollout questions are answered in Design, decisions 22 and 23.
