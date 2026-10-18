# ADR-015: The upstream autopilot rebases, tests and opens the bump PR

- Status: Accepted
- Date: 2026-10-10

## Context

ADR-002 tracks Firefox release and wants security dot releases shipped within 7 days,
unattended. Until now `upstream.yml` only opened a draft PR with a patch dry run; the import,
the builds and the suites were manual (docs/rebase.md), nothing said whether a release fixed
security bugs, and nothing noticed when Vimma fell behind. Vimma is only as safe as the Firefox
under it.

## Decision

`upstream.yml` becomes the upstream autopilot (spec m7-upstream-autopilot):

- every 4 h it reads product-details and Mozilla's MFSA index, classifies the newest release
  (major or dot; security when an advisory names it) and opens a tracking issue labelled
  `upstream`, plus `security`;
- once per release it verifies the source tarball, dry-runs our patches, and runs the PR suites
  (`e2e.yml` as a reusable workflow: import, artifact build, `tests/browser/`, `tests/e2e/`) on
  the new version, then opens `upstream: firefox X.Y.Z` with the results, or a draft naming the
  conflicting hunks, or, when Actions may not open PRs, a compare link on the issue;
- it fails, and opens a `security` issue for the owner, once `main` is more than 3 days behind a
  security dot release (7 for a major, 14 for a dot release without an advisory).

A person still reviews and merges every bump. ADR-002's 7-day target becomes 3 days for security
dot releases, enforced by the drift check (docs/security.md, G2).

## Reasoning

Mechanical steps that a machine can verify should not wait for a person: the PR arrives with the
suites already run, so the human decision is the review. The drift check turns "should" into a
red run. Reusing `e2e.yml` keeps one definition of "the suites pass".

## Alternatives rejected

- **Auto-merge green security bumps**: removes the last human check on a Firefox-sized change
  before Vimma has been daily-driven; revisit with M6.
- **Full builds in CI**: a full build takes about 2 hours on a hosted runner (spec
  build-supply-chain, R15), too long for every bump PR; the hosted nightly does it after merge.
- **A drift check in `ci.yml`**: would turn every unrelated PR red and need the network in CI.

## Consequences

About 270 Actions minutes a month while the repo was private (spec); free since it is public. The owner enables "Allow
GitHub Actions to create and approve pull requests" (runbook). Bumps use the `upstream` commit
type so release-please lists them and cuts a release PR. A merged bump labelled `security` sets
that release PR to auto-merge when `AUTO_SECURITY_RELEASE` is on ([ADR-020](020-security-release-without-a-person.md)).
