# Spec: upstream-bump-automation

Status: accepted (sub-PR 1 implemented; sub-PRs 2-4: #259) · Area: `.github/workflows/upstream.yml`, `.github/workflows/e2e.yml`,
`.github/workflows/upstream-resolve.yml` (new), `tools/upstream/source-check.sh`,
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
only lost context, asks Claude to re-export patches whose lines changed (at most three attempts),
and sets a green bump whose diff is limited to the expected lines to merge through GitHub's
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
4. **Conflict resolution.** When a patch fails, the autopilot asks Claude to re-export it. Each
   attempt that produces a patch set that applies is pushed to the bump branch as one commit; the
   PR's own CI then runs. A failed attempt (no change, a patch that still does not apply, or
   failed required checks after the push) starts the next one. After the third attempt, or when no
   Claude secret is set, the PR stays a draft and a comment mentions the owner with the hunks that
   still fail.
5. **Auto-merge.** A bump PR is set to auto-merge (squash, the subject `upstream: firefox X.Y.Z
(#N)`) only when all of these hold: the repository variable `AUTO_MERGE_UPSTREAM` allows the
   release kind (`dot` allows dot releases, `all` also majors; unset or anything else allows none);
   `UPSTREAM_PR_TOKEN` is set; the PR is not a draft; every patch applied clean or with an offset,
   Mozilla's artifacts existed and the autopilot's suites passed; and its diff against `main`
   changes only the `version.version` value in `surfer.json` and copied-pref lines in
   `firefox-branding.js`. GitHub then merges it once every check the `main` ruleset requires is
   green.
6. **No auto-merge with changed patches.** A bump with re-exported patches (3 or 4) is never set to
   auto-merge; it is marked ready for review and mentions the owner.
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
  skips every step when neither Claude secret is set. Its `spec` job shows the pattern this spec
  reuses: Claude commits with a read-only token, the commits leave the job as a patch artifact,
  and a separate job without Claude pushes them.

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

### Conflict resolution with Claude (sub-PR 4)

A new workflow, `upstream-resolve.yml`, runs on `workflow_dispatch` with the inputs `version` and
`attempt`. `publish` dispatches it (a `GITHUB_TOKEN` `workflow_dispatch` creates a run) when a
patch failed. It has two jobs:

- `resolve` (`contents: read`; the Claude secret; no other secret): checks out the bump branch,
  downloads the `patch-check` artifact of the run that produced it (the pristine upstream copies of
  the patched files and the failing hunks), and runs `anthropics/claude-code-action` with
  `github_token: github.token` and a fixed prompt: re-export each failing patch so it applies to
  the pristine files and keeps the change's intent, edit only `src/**/*.patch`, and check the
  result with `patch-check.py --tree <pristine files>`. The tool allowlist is `Read`, `Edit`,
  `Write`, `Glob`, `Grep`, the patch check and `git diff`/`git add`/`git commit`. The commits leave
  as a patch artifact.
- `push` (`contents: write` with `UPSTREAM_PR_TOKEN`; no Claude): applies the patch, refuses it
  unless every changed path is one of the failing `src/**/*.patch` files and `patch-check.py`
  reports every patch `clean` or `offset`, commits `upstream: re-export <patches> for firefox
X.Y.Z (attempt N of 3)` and pushes, so PR CI runs.

A later attempt starts from a `workflow_run` trigger on `e2e.yml` and `ci.yml` completing with a
failure on an `upstream/firefox-*` branch of this repository whose head commit is an attempt
commit, or from `resolve` itself when its result still does not apply. The attempt number is
read from the branch's commits, not from an input, so a rerun cannot exceed three.

16. **At most three attempts, each one push**, because plan §4 bounds conflict resolution at three
    pushes, and each push costs a full PR CI run.
17. **Claude never holds a write token**, so that a prompt that went wrong, or text in Firefox's
    source that reads as instructions, can at worst produce a patch that the `push` job checks
    and refuses. The `push` job runs no model and accepts only the failing patch files.
18. **Only patches that fail go to Claude**, not failing suites, because a suite failure on a clean
    rebase is a change in Firefox's behaviour that needs a decision about Vimma, not a mechanical
    re-export.
19. **Without a Claude secret the workflow is skipped** and the PR keeps today's instructions, as
    `claude.yml` does, so the autopilot works in a fork or before the secret is set.
20. **`workflow_run` only for this repository's own branches** (`head_repository.full_name ==
github.repository` and `head_branch` starting with `upstream/firefox-`), because
    `workflow_run` runs with the base repository's secrets and must never act on a fork's branch.
21. **A resolved bump waits for the maintainer**, because it changes patches (decision 15) and a
    model wrote the change; the PR body names each patch Claude changed with a link to its diff.

### Rollout

22. **Auto-merge starts with dot releases only**: `AUTO_MERGE_UPSTREAM` is set to `dot` once
    sub-PR 2 merges, and to `all` once Vimma has been daily-driven, because security dot releases
    then reach `main` within hours while majors, which change more of Firefox, still get the
    maintainer's review (the Firefox 158.0 bump, #186, needed a patch re-export and four
    front-end fixes beyond the version). Merging to `main` publishes nothing, since releases are
    gated separately (spec release-versioning). Rejected: `all` at once, because a major would
    land on the maintainer's dev build unreviewed; leaving the variable unset until daily-driving,
    because nothing would change in practice until then.
23. **CI gives patches that fail to Claude, authenticated with `CLAUDE_CODE_OAUTH_TOKEN`** (the
    maintainer's subscription, from `claude setup-token`), and sub-PR 4 is built last, so that the
    earlier sub-PRs do not wait for it. The run sends Vimma's patches and the affected Firefox
    source to Anthropic's API; both are public. Rejected: an `ANTHROPIC_API_KEY` with a spend
    limit, because it adds per-use billing for a job that runs a few times a year; no Claude in
    CI, because a failing patch would then always wait for a person even when its re-export is
    mechanical.

## Security and privacy

The change adds write paths, so `docs/security.md` section 10 gains guarantees (numbered after
the existing G1 to G10) with their tests:

- Auto-merge is enabled only by `publish` on `main`'s code, only for a non-draft PR whose diff
  passes `bump-diff.mjs`, only with `--match-head-commit`, and only when `AUTO_MERGE_UPSTREAM`
  allows it. The `main` ruleset's required checks and code-scanning gate still decide the merge.
- `UPSTREAM_PR_TOKEN` reaches only `publish` and `upstream-resolve.yml`'s `push` job; it is
  fine-grained (this repository, Contents and Pull requests), so it cannot edit workflows. A
  leaked token could open and merge PRs that pass the required checks, the same reach as the
  maintainer's own account minus workflows; it is revoked in the token settings.
- The Claude secret reaches only the `resolve` job, which has a read-only `GITHUB_TOKEN` and no
  other secret. Its input is Vimma's repository and Firefox source whose SHA-512 matched Mozilla's
  `SHA512SUMS` (G4). Its output is checked by a job without a model before anything is pushed.
- No job runs on `pull_request_target`; `workflow_run` acts only on this repository's
  `upstream/firefox-*` branches. Every action stays pinned by a full commit SHA.
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
- `tools/test/upstream-resolve-workflow.test.mjs` (new): `grants nothing by default`; `only the
resolve job sees the Claude secret, with contents: read`; `only the push job writes, without
Claude`; `workflow_run acts only on this repository's upstream/firefox-* branches`; `at most
three attempts, counted from the branch`; `no pull_request_target`; `every action pinned by
SHA`.
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
- `docs/runbook.md`: owner setup (the token's exact permissions, `AUTO_MERGE_UPSTREAM`, the Claude
  secret), and how to turn auto-merge off (unset the variable, or `gh pr merge --disable-auto`).
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
4. **Conflict resolution with Claude** (Behaviour 4): `upstream-resolve.yml`, its tests and
   `docs/security.md`. Needs a Claude secret for its dry run.

Each sub-PR is merged before the next starts. Sub-PRs 1, 2 and 4 change workflows that hold write
tokens or secrets and get a fresh security review.

## Open questions

None. The rollout questions are answered in Design, decisions 22 and 23.
