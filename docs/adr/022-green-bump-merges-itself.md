# ADR-022: A green Firefox bump merges itself

- Status: Accepted
- Date: 2026-10-18

## Context

ADR-015 made the upstream autopilot open a tested bump pull request and left the merge to a
person, rejecting auto-merge until Vimma had been daily-driven. Vimma is now daily-driven on
`main`, and plan §6 sets the M7 exit criterion of Firefox releases reaching `main` with no manual
step. Spec [upstream-bump-automation](../specs/upstream-bump-automation.md) designs the change.

## Decision

- The `publish` job sets a bump pull request to GitHub's auto-merge (squash, pinned with
  `--match-head-commit`) when the repository variable `AUTO_MERGE_UPSTREAM` allows the release
  kind (`all`: dot and major releases; `dot`: dot releases; unset: none), `UPSTREAM_PR_TOKEN` is
  set, the PR is not a draft, every patch applied clean or with an offset, Mozilla's artifacts
  existed, the suites passed, and `tools/upstream/bump-diff.mjs` finds only the version and the
  copied pref lines changed.
- The `main` ruleset's required checks still decide the merge.
- A bump that changes patches (re-exported, or failing and fixed later) never auto-merges.

This amends [ADR-015](015-upstream-autopilot.md)'s "a person merges every bump", because the required
checks of the `main` ruleset and the diff allowlist leave a person nothing to check for a
version-only bump that is not already checked.

## Consequences

- A green dot or major bump reaches `main` without a person once the variable is set.
- A defect in the autopilot that touches any other line or file cannot merge without a person.
- The fine-grained `UPSTREAM_PR_TOKEN` is a credential to renew; when it lapses, bumps fall back
  to drafts that a person marks ready.
