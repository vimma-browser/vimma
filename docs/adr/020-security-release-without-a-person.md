# ADR-020: A security release needs no person

- Status: Accepted
- Date: 2026-10-18

## Context

A Firefox security fix protects nobody until a Vimma release carries it. The upstream autopilot
(ADR-015) opens the bump PR, and a person merges it; release-please (`release-please.yml`) then
keeps a release PR, `chore(main): release X.Y.Z`, that a person merged as a second step. That
second stop adds delay and nothing a person can check that the required checks of the `main`
ruleset have not already checked. Spec [firefox-versions](../specs/firefox-versions.md),
decisions 11 to 15, 17 and 18.

## Decision

- A job `security-release` in `release-please.yml` runs on every push to `main`, after
  `release-please` and `firefox-notes`, and only when the repository variable
  `AUTO_SECURITY_RELEASE` is `true`.
- `tools/release/security-release.mjs` `decide()` sets the open release PR to auto-merge only
  when all of these hold: the run is a push to `refs/heads/main` of `vimma-browser/vimma`; the
  pushed commit's subject starts `upstream: firefox `; the commit belongs to exactly one merged PR
  into `main` from this repository's `upstream/firefox-<version>` branch, labelled `upstream` and
  `security`; exactly one open release PR exists from `release-please--branches--main` into
  `main`, labelled `autorelease: pending`, titled `chore(main): release X.Y.Z` and opened by the
  user `RELEASE_PLEASE_TOKEN` authenticates as; its head contains the pushed commit; and at least
  one GitHub Release already exists. Any other outcome is a notice and a green run, except a
  missing `RELEASE_PLEASE_TOKEN` while the variable is on, which fails the run.
- The merge is `gh pr merge --auto --squash --match-head-commit <head>` with
  `RELEASE_PLEASE_TOKEN`, because a merge made with `GITHUB_TOKEN` starts no workflow, so
  release-please would never tag the release. GitHub merges only once the ruleset is satisfied;
  the job never merges directly. A comment on the bump PR links the release PR.
- The release carries everything on `main`, features included, because releases come only from
  `main`; unfinished features stay behind `vimma.feature.*` prefs that default to `false`.
- The existing fine-grained `RELEASE_PLEASE_TOKEN` makes the merge, because an App installation
  token would add an App, a private key and a token step for one maintainer. Vimma moves to an
  App when a second maintainer joins or the token's expiry first breaks a release.
- This ADR covers the release half only; auto-merging the bump PR itself belongs to spec
  upstream-bump-automation, under its own variable, so the release half can be proven on drafts
  first.

## Alternatives considered

- **Auto-merge in `upstream.yml`**: it runs before the bump is merged.
- **A `workflow_run` chain**: harder to reason about and to test than a job in the run the merge
  already starts.
- **Creating the release without the release PR**: no version bump and no changelog entry.
- **Auto-merging only release PRs that hold nothing but `upstream:` lines**: a security fix would
  wait for a person whenever any feature had merged since the last release.

## Consequences

- With the variable on, a merged security bump becomes a draft release with no person acting;
  publishing the draft stays a person's click while releases are drafts.
- The first release is never merged automatically: the job requires an existing release.
- Turning the variable off, or `gh pr merge --disable-auto <n>`, stops the chain. The guarantees
  are G11 and G12 in `docs/security.md` §10; the switch and its dry run are in `docs/runbook.md`,
  "Releases".
