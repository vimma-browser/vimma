# Spec: m7-upstream-autopilot

Status: implemented · Milestone: M7 · Area: upstream (`tools/upstream/`,
`.github/workflows/upstream.yml`, `.github/workflows/e2e.yml`, `docs/rebase.md`) · ADR-015

## User story

As the maintainer, when Firefox ships a release, and above all a security release, I get within
hours a PR that has already rebased Vimma onto it and run the whole suite, with the advisory and
its severity, so all I do is review and merge. If I do not, a check fails loudly and an issue
mentions me, so drift cannot go unnoticed.

## What was there (m0-pipeline, m0-rebase-playbook)

`upstream.yml` every 6 h: `check-release.py` read `LATEST_FIREFOX_VERSION`; a newer one streamed
the source tarball through `patch-check.py` with its SHA-512 checked against `SHA512SUMS`; a
write job pushed `upstream/firefox-X.Y` and opened a draft PR with the patch summary. Everything
after that (import, artifact build, the suites, the prefs checks) was manual (docs/rebase.md,
steps 2–8). No security classification, no drift check, and the PR job failed outright because
"Allow GitHub Actions to create and approve pull requests" is off.

## Design

One workflow, six jobs; the heavy ones run once per release (`upstream.yml` has the map).

1. **Detect** (`detect`, every 4 h at :17, read-only, < 1 billed minute). `tools/upstream/detect.mjs`
   (Node built-ins, the runner's own Node, no `npm ci`) reads three public feeds:
   - `firefox_versions.json` (product-details): `LATEST_FIREFOX_VERSION`;
   - `firefox.json` (product-details): every release with category and date;
   - the MFSA index, `https://www.mozilla.org/en-US/security/advisories/`. Mozilla publishes no
     Atom/RSS feed of it (`…/advisories/feed/` is a 404), so `releases.mjs` parses its links:
     `<span class="level high">MFSA 2026-97</span> Security Vulnerabilities fixed in Firefox 157`.
     Only "fixed in Firefox N" counts: Thunderbird, ESR and Firefox for iOS/Android are skipped.

   **Classification.** `kind`: `major` (X.0) or `dot` (X.Y.Z). `security`: an advisory names the
   exact version (`Firefox 157` = 157.0). Unreadable advisories give `security: null` (unknown),
   which counts as security everywhere (G3). product-details' own `is_security_driven` flag is
   not used: it has been false for every release since Firefox 59.

   The job also looks up what is already done: the branch `upstream/firefox-X.Y.Z` exists → the
   release was handled (no heavy job; `-f rebuild=true` overrides); the tracking issue exists and
   is labelled right → no `track` job.

2. **Track** (`track`, `issues: write`). A tracking issue "Firefox X.Y.Z released", labelled
   `upstream`, plus `security` unless the release has no advisory, with the advisories, severity
   and the drift deadline; a security release mentions the owner. An advisory that Mozilla
   publishes after the release adds the label later and a comment that mentions the owner.

3. **Rebase and test.**
   - `patch-check` (read-only): stream the tarball, verify its SHA-512 (as before), dry-run every
     `src/**/*.patch` (`patch-check.py`, now also reporting the tarball's revision),
     `patch-audit.py`, then the artifact preflight (`artifact-preflight.mjs`, the same Taskcluster
     lookup as `tools/artifact-build`).
   - `test`: `e2e.yml` as a reusable workflow (`workflow_call`, input `firefox-version`), only when
     every patch applies and Mozilla's artifacts exist. It bumps `surfer.json` in its own
     checkout, then does exactly what PR CI does: `surfer download`, now with a SHA-512 check of
     that tarball too, `npm run import`, branding prefs, the new upstream-prefs check (cfr
     provider and Safe Browsing lists, `upstream-prefs.mjs`), artifact build, `tests/browser/`,
     `tests/e2e/`. No second copy of the build steps.
   - **No artifacts** (404 or expired in the index): the suites are skipped and the PR says so.
     The full-build path is the build machine: `npx surfer build` and
     `npm run mochitest -- tests/browser/` (docs/rebase.md, step 4), and after merge the nightly.
     A hosted runner cannot do a full build (22 GB, 39 min on 16 threads; ADR-010). (Since
     changed: the full-build path is a developer's machine, and the nightly moves to a
     GitHub-hosted runner with [#224](https://github.com/vimma-browser/vimma/issues/224); spec build-supply-chain, decision 6, and its
     research R9-R10 show the build fits one.)
   - `publish` (`contents`/`pull-requests`/`issues: write`): bump `surfer.json`, commit
     `upstream: firefox X.Y.Z`, push the branch, open the PR with `autopilot-body.mjs`'s body:
     a table (tarball, patches clean/offset/fuzz/failed, register, artifacts, suites), the
     advisories, for conflicts the upstream files and each failing hunk (the full patch check,
     hunks included, collapsed below), and what the human does. A **draft** unless every patch
     applies, the suites passed and `UPSTREAM_PR_TOKEN` is set (a PR opened with `GITHUB_TOKEN`
     starts no CI; marking it ready does). It closes the tracking issue on merge and supersedes
     older bump PRs and tracking issues.
   - **Fallback** when Actions may not open PRs (`gh pr create` fails with "not permitted to
     create or approve pull requests"): the branch stays pushed and the tracking issue gets the
     same summary plus a compare link with the title and `Closes #N` filled in.

4. **Escalate** (`drift`). `drift()` in `releases.mjs` lists every release-channel release newer
   than `surfer.json` on `main`, each with a deadline: release date (00:00 UTC) + 3 days for a
   security dot release, 7 for a major (they always carry an MFSA), 14 for a dot release without
   an advisory. Past the earliest deadline the job opens one `security` issue mentioning the owner
   and fails, every run, until `main` moves. GitHub mails the owner about failed scheduled runs;
   no other service.

### Choices

- **N = 3 days** for security dot releases: Mozilla's dot releases are a few backported fixes and
  our patches nearly always stay clean, so 3 days covers a weekend. Majors get 7 (a real rebase,
  4-weekly, predictable from `NEXT_RELEASE_DATE`). ADR-002's "within 7 days" target for security
  releases tightens to 3 for dot releases.
- **Every 4 h**: 6 runs a day. A release has a PR within ≈ 4 h 30 min (worst case, plus GitHub's
  cron delay), inside G1's 6 hours. Every 2 h would cost 360 min a month for at most 2 h earlier.
- **Commit type `upstream:`**, not `chore(upstream):`: release-please hides `chore`
  (`release-please-config.json`), so a Firefox security bump would neither appear in the
  changelog nor trigger a release PR. `upstream` is a listed commitlint type shown under "Changed".
- **Node, not Python**, for the new logic: tests in Vitest beside the other tools, and the
  runner's Node needs no setup. `check-release.py` and its tests are gone (`detect.mjs` replaces
  them); the Python tools for patches and hashes stay.
- **Secrets:** none for detection, the patch check or the suites; `UPSTREAM_PR_TOKEN` is optional
  (the PR's own CI). The Safe Browsing key is only for the nightly and release builds: the
  artifact build is keyless by design (`e2e.yml`, spec m0-safebrowsing-key), and no autopilot job
  sees it.

## Actions minutes (private repo, ≈ 2,000 a month)

| What                                                        | Billed minutes                                |
| ----------------------------------------------------------- | --------------------------------------------- |
| `detect`, nothing new (6 a day)                             | 1 each → **≈ 180 a month**                    |
| A release: detect 1, track 1, patch-check 2                 | 4                                             |
| `test` (e2e.yml: vimma-ctl, import, artifact build, suites) | ≈ 11 (10 min 21 s in a measured e2e run)      |
| `publish`                                                   | 1                                             |
| **Per release**                                             | **≈ 16** (+ ≈ 14 when marked ready: ci + e2e) |
| `drift` while overdue                                       | +1 per run                                    |

About 3 releases a month (one major, one or two dot releases): ≈ 180 + 3 × 30 = **≈ 270 a
month**, 14 % of the budget (was ≈ 130). Once the repo is public, hosted minutes are free.
(Since changed: the repository is public, so these minutes cost nothing;
`docs/runbook/ci-actions-minutes-budget.md`, "Actions minutes budget".)

## Tests (written first)

- `tools/upstream/test/releases.test.mjs`: version order and kinds, the three feeds from real
  fixtures of 2026-10-10 (`test/fixtures/`, no network), classification (157.0.1 security, 156.0.1
  not, `Firefox 157` = 157.0, unknown), severity order, drift limits and deadlines, the earliest
  deadline winning, the fallback date.
- `tools/upstream/test/autopilot.test.mjs`: `detect()` on a simulated 157.0.2 with MFSA 2026-105,
  its step outputs and heredocs, the CLI on fixtures; PR body, draft decision, conflict list,
  size limit, fallback compare link, tracking and drift issues.
- `tools/upstream/test/upstream-prefs.test.mjs`, `artifact-preflight.test.mjs`.
- `tools/test/upstream-workflow.test.mjs`: schedule, per-job permissions, no secrets, no
  `pull_request_target`, SHA pins, the SHA-512 check before import, the fallback and the drift
  failure.
- `test_patch_check.py`: the report's `revision`.
- actionlint (with shellcheck) on both workflows.

## Dry run (2026-10-10, live feeds)

`node tools/upstream/detect.mjs`: shipped 157.0.1, latest 157.0.1 (2026-10-06, security dot
release, MFSA 2026-104, moderate), drift **current**. Vimma is not behind. With a pin of 156.0.1
it reports 157.0.1 as newer and drift overdue (157.0 of 2026-09-29, MFSA 2026-97, past its 7
days). The artifact preflight finds Mozilla's build of 157.0.1 indexed until 2027-10-05.

## Owner setup

1. Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and
   approve pull requests". Without it the autopilot comments a compare link on the tracking issue.
2. Optional: `UPSTREAM_PR_TOKEN` (fine-grained, this repo, Contents + Pull requests read/write),
   so the PR's CI runs and an all-green bump opens ready for review. (Since changed: the GitHub
   App `vimma-upstream-autopilot` replaces the token; docs/runbook/ci-upstream-bumps.md, "Upstream
   App".)

## Dependencies

Another change reworks how `npm run import` restores patched upstream files. The autopilot only
calls `npm run import` through `e2e.yml`, unchanged, so it builds on whatever that change lands.

## Not in scope

Auto-merge (the human reviews and merges; plan §4's auto-approval stays out until Vimma is
daily-driven), publishing a release (release gate), GPG verification of `SHA512SUMS`, the full
build on a hosted runner.
