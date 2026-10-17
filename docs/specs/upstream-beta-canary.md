# Spec: upstream-beta-canary

Status: implemented · Area: `.github/workflows/upstream-beta.yml` (new), `.github/workflows/e2e.yml`,
`.github/workflows/upstream.yml` (one step moves into a shared script),
`tools/upstream/canary.mjs` (new), `tools/upstream/source-check.sh` (new),
`tools/upstream/patch-check.py`, `tools/upstream/artifact-preflight.mjs`,
`tools/upstream/bump-surfer-json.py`, `tools/artifact-build/artifact-build.mjs`,
`tools/version-files/version-files.mjs`, `tools/e2e/e2e.mjs`, `docs/rebase.md`,
`docs/security.md`, `docs/runbook.md` · Upstream patches: none · ADR: amends
[ADR-002](../adr/002-upstream-release-channel.md) and
[ADR-010](../adr/010-pr-artifact-builds.md) (one paragraph each); no new ADR

Issue: [#218](https://github.com/vimma-browser/vimma/issues/218)

## Summary

A scheduled workflow, `upstream-beta.yml`, tests Vimma's `main` against the current Firefox
Beta: it downloads the Beta source, checks its SHA-512, dry-runs Vimma's patches, makes an
artifact build and runs the mochitests and the e2e scenarios. When something fails it opens, or
updates, one issue for that Firefox version, labelled `upstream-beta`. It never opens a pull
request, never pushes, never blocks `main` CI and never produces a build anyone runs. Vimma still
ships on the Firefox release channel (ADR-002); the canary only moves the discovery of breakage
from release day to the Beta, while there is no security deadline.

## Problem

The upstream autopilot (ADR-015, [m7-upstream-autopilot](m7-upstream-autopilot.md)) sees a
Firefox version for the first time on the day it is released. That release is nearly always a
security release, so every incompatibility it brings is found under the drift deadline of
`docs/security.md` G2 (7 days for a major release, 3 for a security dot release).

The Firefox 158.0 bump, [#186](https://github.com/vimma-browser/vimma/pull/186), is the concrete case.
On release day the autopilot reported that `src/browser/base/moz-build.patch` no longer applied,
and once it was re-exported the artifact-build suite failed with 116 failed assertions against
5,811 passed (e2e.yml run 38527244253). The causes were four separate upstream changes:

1. Firefox 158 removed `nsIComponentManager.getClassObject`, so the agent-page wrappers for the
   external-protocol chooser and the download dialog threw for every tab.
2. `content-area.css` gives every split-view panel's `.browserContainer` a border (before, an
   outline on non-selected panels only) and narrows the splitter margins from 3 px to 2 px, which
   breaks `browser_vimma_split_contract.js` and the split layout tests.
3. The sidebar was refactored (`sidebar-main`, `SidebarManager`, the history and bookmarks
   panels), so the sidebar theme tests no longer find the panels or the launcher button.
4. The private workspace and the private-window swap no longer find their windows, with a change
   to `BrowserWindowTracker.getTopWindow` as a candidate cause.

Each of these was present in Firefox 158's Beta builds, the first of which was published on
2026-09-28, fifteen days before the release (Research, R1). A run of the existing suites on that
Beta would have reported all four with two weeks to fix them on `main`, outside any deadline.

## Behaviour

The canary is a CI workflow; its observable behaviour is what it runs, what it writes and what
it never does.

1. **B1. Finds the current Beta.** Each scheduled run reads `LATEST_FIREFOX_DEVEL_VERSION` from
   product-details. It does nothing further when that value is not a Beta version (`N.0bM`), or
   when Firefox `N` is already released (`LATEST_FIREFOX_VERSION` has major `N` or higher).
2. **B2. Tests each Beta build once.** The heavy jobs run when that Beta build has not been tested
   in the last 7 days. A Beta build tested less than 7 days ago is skipped. A manual run
   (`workflow_dispatch`) may name a Beta version and always tests it.
3. **B3. Verifies the source.** The workflow must not report on or build from a Beta source
   tarball whose SHA-512 differs from the entry in that version's `SHA512SUMS`. A mismatch fails
   the run and opens no issue (the same rule as G4 for releases).
4. **B4. Runs what PR CI runs.** On the verified tarball it dry-runs every `src/**/*.patch`. When
   every patch applies and Mozilla's Beta build of that revision is in the Taskcluster index, it
   runs `e2e.yml` on that Beta: import, branding and upstream-prefs checks, artifact build,
   `tests/browser/`, `tests/e2e/`.
5. **B5. Reports failures in one issue per Firefox version.** When a patch does not apply, Mozilla's
   artifacts are missing, or a check or test fails, the workflow opens an issue titled
   `Firefox N beta: canary findings`, labelled `upstream-beta`, or updates the open one for that
   `N`. The issue lists the Beta build, the `main` commit tested, the run link, the patches that
   do not apply with their hunks, and the failed checks and tests with their messages. A newly
   opened issue mentions the repository owner; an update, a comment and a close never do.
6. **B6. Tracks progress on the issue.** A later run on the same Firefox version replaces the
   issue body with the latest results. When the results differ from the previous run's, it also
   adds a comment listing what is new and what is fixed; when they do not, it adds no comment.
7. **B7. Closes the issue when the work is done.** A run that passes completely on Firefox `N`'s
   Beta closes that issue with a comment. Once Firefox `N` is released, the next run closes any
   open `upstream-beta` issue for `N` or lower with a comment that links the autopilot's tracking
   issue, `Firefox N.0 released`, when it exists.
8. **B8. Stays out of the release path.** The workflow must not push a branch, commit, open or
   edit a pull request, change `surfer.json` on any branch, or publish a release or artifact
   other than its own report. Its failures must never be a required check of `main`.
9. **B9. A red run means the canary is broken.** Findings about Vimma go to the issue and the run
   stays green. The run fails only when the canary cannot do its job: product-details or
   archive.mozilla.org unreadable, a checksum mismatch, a tool crash.
10. **B10. Runs only in Vimma's repository.** Every job is skipped in a fork.

## Research

**R1. Firefox's release and Beta cadence.** product-details, read on 2026-10-14
(`firefox_history_major_releases.json`, `firefox_history_development_releases.json`):

| Version | First Beta (b1) | Last Beta | Release    | b1 before release |
| ------- | --------------- | --------- | ---------- | ----------------- |
| 155     | 2026-08-17      | b5 08-26  | 2026-09-01 | 15 days           |
| 156     | 2026-08-31      | b5 09-09  | 2026-09-15 | 15 days           |
| 157     | 2026-09-14      | b5 09-23  | 2026-09-29 | 15 days           |
| 158     | 2026-09-28      | b5 10-07  | 2026-10-13 | 15 days           |
| 159     | 2026-10-12      | (current) |            |                   |

Major releases moved from four weeks (152.0 on 2026-06-16, 153.0 on 2026-07-21) to two weeks
from 154.0 (2026-08-18) on. Each cycle now has five Beta builds, two or three days apart, and the
first Beta of `N+1` appears a day before `N` is released. A Beta therefore precedes its release
by about 15 days, not the four weeks ADR-002 assumed. A weekly canary would see a new Beta up to
7 days late, about 8 days before release; to report breakage two weeks ahead, the canary must
test b1 within a day of its publication. This is why B2 tests every Beta build rather than
running once a week.

**R2. Finding the current Beta.** `https://product-details.mozilla.org/1.0/firefox_versions.json`,
read on 2026-10-14, has `"LATEST_FIREFOX_DEVEL_VERSION": "159.0b1"`,
`"FIREFOX_DEVEDITION": "159.0b1"`, `"LATEST_FIREFOX_RELEASED_DEVEL_VERSION": "159.0b1"`,
`"LATEST_FIREFOX_VERSION": "158.0"` and `"FIREFOX_NIGHTLY": "160.0a1"`. Surfer uses
`LATEST_FIREFOX_DEVEL_VERSION` for its `firefox-beta` product
(`node_modules/@zen-browser/surfer/dist/utils/version.js:15-21`, Surfer 1.14.9), and so does the
canary. The autopilot already reads this file for `LATEST_FIREFOX_VERSION`
(`tools/upstream/releases.mjs`, `VERSIONS_URL`). Not verified: what product-details reports
during the days between the last Beta and the release; B1's "already released" rule makes the
canary safe either way.

**R3. Beta source on archive.mozilla.org.** Checked for 159.0b1 on 2026-10-14:

- The source is at `https://archive.mozilla.org/pub/firefox/releases/159.0b1/source/firefox-159.0b1.source.tar.xz`
  (817,824,656 bytes), with `.asc` beside it. A release has the same layout under
  `releases/<version>/`.
- `releases/159.0b1/SHA512SUMS` lists it as `source/firefox-159.0b1.source.tar.xz`, the same
  form `tools/upstream/verify-sha512.py` already matches for releases. Streaming the tarball
  through `sha512sum` took 37 s on the maintainer's machine and produced exactly that hash.
- The tarball's top directory is `firefox-159.0/`, not `firefox-159.0b1/`. Surfer unpacks with
  `--strip-components=1` (`dist/commands/download/firefox.js:77-85`) and `patch-check.py`'s
  `extract_from_tarball` drops the first path component, so neither depends on the name.
- Inside, `sourcestamp.txt` is
  `https://hg.mozilla.org/releases/mozilla-beta/rev/c0c03f3f899017ae4b7e56c0713f1ada51173c41`,
  `config/milestone.txt` and `browser/config/version.txt` are `159.0`, and
  `browser/config/version_display.txt` is `159.0b1`.

**R4. Surfer can download a Beta.** In Surfer 1.14.9, `downloadFirefoxSource`
(`dist/commands/download/firefox.js:88-114`) builds
`https://archive.mozilla.org/pub/firefox/releases/${version}/source/firefox-${version}.source.tar.xz`
from `surfer.json`'s `version.version` with no check of its form. The only validation of the pin
is that `version.product` is one of the supported products (`dist/utils/config.js:132`). The
product is used only by `surfer update` and the update-check notice (`dist/commands/update.js`,
`dist/middleware/update-check.js`), not by `download` or `import`. So `npx surfer download` with
`version.version` set to `159.0b1` fetches the Beta tarball; `product` can stay `firefox`. Surfer
does not check the download's hash, which is why `e2e.yml` already checks it against
`SHA512SUMS` after the download.

**R5. Vimma's own version handling.** Before sub-PR 1, three places assumed a release:

- `tools/upstream/bump-surfer-json.py` accepted only `\d+(?:\.\d+)*`, so it refused `159.0b1`.
- `tools/version-files/version-files.mjs` accepted `bN` but wrote the whole value into
  `version.txt`, which becomes `MOZ_APP_VERSION`. Mozilla's Beta has `159.0` there (R3), and
  `tests/browser/browser_vimma_app_version.js` asserts that `Services.appinfo.version` equals
  `Services.appinfo.platformVersion`; with `159.0b1` that assertion would fail on every Beta run
  for a reason that is not a Firefox change.
- `tools/artifact-build/artifact-build.mjs` looked Mozilla's build up only under
  `gecko.v2.mozilla-release.shippable.revision.<rev>.firefox.linux64-opt` (`indexNamespace`)
  and passed the revision to mach as `MOZ_ARTIFACT_REVISION`.

**R6. Artifact builds of a Beta.** Checked against Firefox 157.0.1's
`python/mozbuild/mozbuild/artifacts.py` and the live Taskcluster index on 2026-10-14:

- Mozilla indexes Beta builds like release builds. `gecko.v2.mozilla-beta.shippable.revision.c0c03f3f899017ae4b7e56c0713f1ada51173c41.firefox.linux64-opt`
  (159.0b1) resolves to task `ILGA8D1vQYmtIo0RJKNABg` (`build-linux64-shippable/opt`), indexed
  until 2027-10-12. Its artifacts include `public/build/target.tar.xz` and
  `public/build/target.common.tests.tar.zst`, the two files an artifact build needs (ADR-010).
  The same revision under `mozilla-release` is a 404.
- mach cannot find it from the revision alone. `install_from` (artifacts.py:1899-1910) tries
  `MOZ_ARTIFACT_REVISION` first, and that path searches only `candidate_trees` plus `try`
  (artifacts.py:1845-1858). `select_candidate_trees` (artifacts.py:548-559) chooses the trees from
  `MOZ_APP_VERSION_DISPLAY`, which in Vimma is its own `0.x` version, so it always returns
  `releases/mozilla-release` (artifacts.py:93-102). The Beta tree is chosen only for a display
  version ending in `bN`, and Vimma must not take Firefox's display version.
- `MOZ_ARTIFACT_TASK=<taskId>` bypasses the tree search: `install_from_task`
  (artifacts.py:1862-1878) lists that task's artifacts and installs the same candidates
  (`find_candidate_artifacts`, artifacts.py:247) as the revision path. It is read only when
  `MOZ_ARTIFACT_REVISION` is unset.

Conclusion: an artifact build of a Beta works when the tool reads the tree from
`sourcestamp.txt`, looks the task up in that tree's index itself and passes `MOZ_ARTIFACT_TASK`.
This was confirmed end to end on 159.0b1 on 2026-10-14 (ADR-010, "Beta tarballs"): mach installed
task `ILGA8D1vQYmtIo0RJKNABg` through `MOZ_ARTIFACT_TASK` and the mochitests ran on the result.
If Mozilla's Beta build is missing or expired,
the preflight reports `artifacts=no`, the suites are skipped and the issue says so (B5); the
patch check still runs.

**R7. What the existing workflows give.**

- `upstream.yml` (ADR-015): its `patch-check` job streams a release tarball once through
  `sha512sum` and `patch-check.py`, verifies the hash, runs `patch-audit.py` and the artifact
  preflight. All of it worked on a Beta URL except the preflight's fixed `mozilla-release`
  namespace (R5). It calls `e2e.yml` through `workflow_call` with `firefox-version`, so the suites
  have one definition.
- `e2e.yml` (ADR-010): `contents: read`, no secrets, `ubuntu-24.04`, 45-minute limit. The
  `mochitest (artifact build)` job took 11 min 54 s on run 38527244253 (Firefox 158.0). It stops
  at the first failed step, so after a mochitest failure the e2e scenarios do not run.
- `nightly.yml`: a full build on a self-hosted runner that does nothing until `NIGHTLY_ENABLED`
  is set; it is not live. A full build does not fit a hosted runner (ADR-010: 22 GB, 39 min on 16
  threads), so the canary, like PR CI, cannot exercise compiled-in build configuration. (Since
  changed: spec build-supply-chain, R9-R10, finds a full build fits a standard hosted runner,
  and [#224](https://github.com/vimma-browser/vimma/issues/224) moves the nightly there; the canary still runs artifact builds only.)
- `patch-audit.yml`: the pattern for a scheduled report. The job that holds `issues: write`
  checks out and runs no repository code; it only calls `gh` with files an earlier read-only job
  produced.

**R8. Would the canary have caught #186?** Yes for all four failures: each was reported by the
artifact-build mochitests in run 38527244253 (the `getClassObject` removal through libxul, which
the artifact build takes from Mozilla). Changes the artifact build cannot see are the ADR-010
known gaps (compiled-in defines); none of #186's failures was one.

**R9. Cost.** The repository is public, so hosted runner minutes are free and uncapped
(`docs/runbook.md`, "Actions minutes budget"). Per tested Beta build: detect < 1 min, patch check
about 2 min, `e2e.yml` about 12 min, report < 1 min, about 16 min in all. Five Beta builds per
two-week cycle are about 11 runs a month, about 3 hours of runner time; the detect-only runs add
about 2 hours. One run occupies one hosted runner at a time, of the 20 the free plan allows.

## Design

`upstream-beta.yml` is a new workflow with five jobs. It reuses the autopilot's tools and
`e2e.yml`, and adds one script for its own logic.

```
detect ──► source-check ──► test (e2e.yml) ──► render ──► report
(read)      (read)           (read)            (read)     (issues: write, no checkout)
```

1. **detect** (`contents: read`, `actions: read`). `node tools/upstream/canary.mjs detect` reads
   `firefox_versions.json` and decides B1, then asks the Actions API whether an artifact named
   `upstream-beta-<version>` younger than 7 days exists (B2). Outputs: `version`, `major`,
   `run` (true or false), `reason`, `released-majors` for B7 (the highest released major: issues
   for it and lower are closed), and `previous-artifact` and `previous-run`, the newest result of
   `main` for the same Firefox version (any Beta build), which detect downloads with its
   `actions: read` and hands to render as the artifact `canary-previous` for B6. Only artifacts
   of runs on `main` of this repository count, so a manual run on a branch never delays `main`'s.
2. **source-check** (`contents: read`). `tools/upstream/source-check.sh <version>` streams the
   tarball through `sha512sum` and `patch-check.py`, verifies the hash against `SHA512SUMS`
   (failing on a mismatch, B3), then runs `patch-audit.py` and `artifact-preflight.mjs`.
   `upstream.yml`'s `patch-check` step calls the same script, so the release and Beta checks
   cannot drift apart. `patch-check.py`'s report gains `tree` (from `sourcestamp.txt`) next to
   `revision`.
3. **test** (`contents: read`). `uses: ./.github/workflows/e2e.yml` with
   `firefox-version: <version>`, only when every patch applies and the preflight found Mozilla's
   build. A version with `bN` turns on Beta mode in `e2e.yml` (decision 4).
4. **render** (`contents: read`). Always runs after the jobs above unless the run was cancelled
   or the source check failed. It downloads their reports and runs
   `node tools/upstream/canary.mjs render`, which writes `issue.json`: the action (`open`,
   `update`, `close`, `none`), the issue title, body and comment. It uploads `issue.json`, the
   reports and a `state.json` (version, `main` SHA, results) as the artifact
   `upstream-beta-<version>`, retained 30 days, which is also B2's record of a tested build.
5. **report** (`issues: write` only; `if: github.ref == 'refs/heads/main'`). No checkout. It
   downloads `issue.json` and applies it with `gh issue create|edit|comment|close` and
   `gh label create upstream-beta --force`, finding the open issue by exact title and label. It
   also closes open `upstream-beta` issues whose major is in `released-majors` (B7), looking up
   the `Firefox N.0 released` tracking issue by title to link it.

### Decisions

1. **A separate workflow, not a mode of `upstream.yml`.** `upstream.yml`'s `publish` job holds
   `contents: write` and `pull-requests: write`, and its jobs key on `upstream/firefox-X.Y.Z`
   branches and `upstream`-labelled issues. Keeping the canary in its own file keeps write access
   to the repository out of it entirely (B8) and lets its tests assert that no job ever has more
   than `issues: write`. Rejected: a Beta input on `upstream.yml`, which would put the canary next
   to a job that can push.
2. **Every Beta build, checked every 6 hours (`41 */6 * * *`), not once a week.** R1: a Beta now
   precedes its release by 15 days, and a weekly run would first see it about 8 days before
   release. Detection costs under a minute; the suites run once per Beta build (about every two
   or three days), and again only when a build stays current for more than 7 days, so fixes on
   `main` are re-tested. Later Betas matter as well as b1, because changes are uplifted to Beta
   during the cycle. The extra runs add no noise to the issue, because a run comments only when
   its results differ from the previous run's (B6), and runner minutes are free for a public
   repository (R9). Rejected: once a week, as `plan.md` first described the canary (too late:
   under the two-week cycle it cannot report two weeks ahead); once per Firefox version on b1 only
   (misses uplifts).
3. **The tested-build record is the run's own artifact.** The detect job asks the Actions API for
   an artifact named `upstream-beta-<version>`, which needs only `actions: read`. Rejected: a
   marker in the issue body (there is no issue when the run passes), a cache entry (evicted
   unpredictably), a file committed to the repository (needs `contents: write`).
4. **`e2e.yml` gets a Beta mode, keyed on the version.** When `firefox-version` matches
   `^\d+\.0b\d+$`:
   - `bump-surfer-json.py --allow-beta` writes it into the job's own checkout (the flag is
     required, so no release path can pin a Beta by accident);
   - the check and suite steps (branding prefs, upstream prefs, mochitests, e2e) run with
     `continue-on-error`, so each one runs and is reported. The mochitests also write mozlog's
     TBPL log (`--log-tbpl=<file>`), because `mach mochitest` prints mach's own format, which has
     no `TEST-UNEXPECTED-*` lines (seen on e2e.yml run 38559217112); the e2e harness writes its
     results with its new `--report-json` option;
   - a final step (`tools/upstream/suite-results.mjs`) writes `suite-results.json` (each step's
     outcome, the `TEST-UNEXPECTED-* | test | message` lines of that TBPL log,
     `testing/mozbase/mozlog/mozlog/formatters/tbplformatter.py:242` in Firefox 157.0.1, and the
     e2e harness's failed scenarios), uploads it with the e2e report, and then fails the job if
     any step failed, so the run is red once every suite has reported. It does not run on a
     cancelled run.
   - A `workflow_call` input `fail-on-findings` (default `true`) lets the canary keep the job
     green after recording findings (B9): with `false`, the final step exits 0 when
     `suite-results.mjs` reports findings (exit 1) and still fails on a usage error. A failed
     import or artifact build fails the job in every mode.
   - The run's concurrency group is the ref and the version, so a manual run of a Beta on a
     branch never cancels the canary's run of it on `main`.

   For a release version, including PR CI and the autopilot, `e2e.yml` behaves exactly as today:
   the first failure fails the job. Reason: one definition of "the suites" (ADR-015), and a Beta
   report needs every failure, not the first.

5. **`version.txt` gets Mozilla's value for a Beta.** `version-files.mjs` writes `159.0` for a pin
   of `159.0b1` (the version without `bN`, as in Mozilla's own Beta tree, R3), so
   `Services.appinfo.version` equals `platformVersion` and `browser_vimma_app_version.js` tests
   Firefox, not the pin's spelling. Vimma's display version is unchanged.
6. **The artifact build takes the tree from `sourcestamp.txt`.** `artifact-build.mjs` and
   `artifact-preflight.mjs` read the tree from the `https://hg.mozilla.org/<tree>/rev/<rev>` line
   and accept exactly `releases/mozilla-release` and `releases/mozilla-beta`; anything else is an
   error. For a release nothing changes (`MOZ_ARTIFACT_REVISION`). For a Beta the tool looks up
   `gecko.v2.mozilla-beta.shippable.revision.<rev>.firefox.linux64-opt` itself and passes the
   task id as `MOZ_ARTIFACT_TASK`, leaving `MOZ_ARTIFACT_REVISION` unset (R6). The display-version
   check stays. Rejected: giving Vimma a `bN` display version in Beta mode so mach picks the Beta
   tree (it would change what the tests see, and the display version is Vimma's own, plan §7);
   `MOZ_ARTIFACT_URL` to archive.mozilla.org (no `common.tests` archive there, ADR-010).
7. **One issue per Firefox version, not per Beta build.** Every Beta build of Firefox `N` targets
   the same release and the same fixes, so the title is `Firefox N beta: canary findings`. Its
   body always shows the latest run; a comment per run gives the change (B6). Five builds a cycle
   would otherwise be five issues for the same work.
8. **Its own label, `upstream-beta`, and not `upstream`.** `upstream.yml` lists and closes issues
   labelled `upstream` whose titles match `^Firefox [0-9.]+ released$`, and `patch-audit.yml` uses
   `upstream` with `audit`. A separate label keeps each workflow's queries from touching the
   other's issues, and lets the maintainer filter the canary's issues.
9. **Findings keep the run green; only a broken canary is red (B9).** GitHub mails the owner about
   every failed scheduled run, and the issue already notifies. A red run would then mean two
   different things. Rejected: failing on findings, as `patch-audit.yml` does; that workflow runs
   four times a year, the canary several times a week.
10. **Fixes land on `main` against the release.** The canary tests `main` as it is; `surfer.json`
    on `main` keeps the release. A front-end fix for a Beta change must work on both the release
    on `main` and the Beta, as the `getClassObject` fix in #186 does (it constructs upstream's
    classes from their modules, on 157 and 158 alike). A patch whose hunk no longer applies cannot
    be fixed on `main` ahead of time, because a patch applies to one tree; for those the issue
    gives the hunk and its new upstream context, so the re-export on release day is a known,
    prepared change.
11. **The autopilot's bump PR links the canary's issue.** `autopilot-body.mjs` adds a line naming
    the `upstream-beta` issues for the release's major, if any exist, so the release-day
    reviewer sees what was already known. The lookup runs in `upstream.yml`'s `detect` job, which
    already holds `issues: read`; no job gains a permission. It lists open and closed issues,
    because the canary closes the issue for `N` once `N` is released (B7) and may run before the
    autopilot does, and because an issue closed after a passing run shows what was fixed on
    `main`. The line appears only when the release starts a new major, because a dot release's
    major was named by the bump to `N.0`. Only issue numbers and states reach the PR body, so no
    issue text is rendered there, and a failed lookup leaves the line out instead of stopping a
    security bump.
12. **A new issue mentions the owner; nothing else does.** The `open` body ends with a line
    mentioning the repository owner (`github.repository_owner`), so a new finding reaches someone
    the day it is found instead of waiting in the label's list. Updated bodies, progress comments
    and close comments carry no mention, because a cycle has up to five Beta builds and each
    mention would be one more notification about work that is already known. A green run that
    opens nothing mentions no one. Rejected: no mention at all (a finding can sit unread for the
    whole two weeks it was meant to buy); a mention on every update (notification noise).
13. **Beta only, not Nightly.** Nightly (`FIREFOX_NIGHTLY`, `160.0a1` in R2) would give about two
    more weeks of notice, but its builds are indexed on `mozilla-central` with shorter retention,
    and it changes every day, so most findings would be churn that never reaches a release: the
    reason ADR-002 rejects tracking Nightly. A Beta change is, with rare backouts, the change the
    release ships. Nightly can be added later if Beta findings regularly arrive too late to fix.
14. **An open canary issue does not block or warn on merges to `main`.** Blocking, or a warning
    check on pull requests while an `upstream-beta` issue is open, would make the canary part of
    the release path, which B8 excludes, and would hold unrelated work behind a Firefox change
    that may take the whole cycle to fix. The issue and the bump-PR link (decision 11) are how a
    finding reaches the people who fix it.

### Beta to release

Firefox `N` is released while its last Beta is still the newest Beta for about a day, then
`LATEST_FIREFOX_DEVEL_VERSION` moves to `N+1.0b1` (R1). From the moment `LATEST_FIREFOX_VERSION`
reaches `N`, the canary no longer tests `N` (B1); its next run closes the `N` issue with a link to
the autopilot's tracking issue (B7). From then on `upstream.yml` owns version `N`; the canary
moves to `N+1`.

## Security and privacy

The canary reads public Mozilla data and the repository, and writes only issues.

- **Least privilege.** `permissions: {}` at the top. `detect`: `contents: read`,
  `actions: read`. `source-check`, `test`, `render`: `contents: read`. `report`: `issues: write`
  only, no checkout, no repository code, no `npm ci`; it runs `gh` on `issue.json`. No job has
  `contents: write`, `pull-requests`, `actions: write`, `id-token` or `packages`. Every
  `actions/checkout` uses `persist-credentials: false`.
- **No secrets.** No job references `secrets.`, and the `uses: ./.github/workflows/e2e.yml` call
  passes none (`secrets: inherit` is forbidden). `GITHUB_TOKEN` is the only token. The Safe
  Browsing key stays in the nightly and release builds (spec m0-safebrowsing-key).
- **Triggers.** `schedule` and `workflow_dispatch` only, never `pull_request_target`, so no pull
  request's code runs with any token. A manual run on a branch runs that branch's code read-only;
  its `report` job is skipped, so a branch cannot write issues (`github.ref == 'refs/heads/main'`).
  Every job is skipped unless `github.repository == 'vimma-browser/vimma'` (B10).
- **Untrusted input.** The tarball, its test output and product-details are Mozilla's data.
  The tarball is built from only after its SHA-512 matches `SHA512SUMS` (B3); the version from
  product-details must match `^\d+\.0b\d+$` before it reaches a URL, a shell argument or an
  artifact name; the revision must be 40 hex digits before it reaches the index URL (as
  `artifact-preflight.mjs` already checks). Test messages go into the issue inside fenced code
  blocks, so they cannot mention users or render links, and the body is cut to 60,000
  characters with a pointer to the run's artifact (GitHub's limit is 65,536).
- **Supply chain.** Actions are pinned by commit SHA, as in every Vimma workflow. No new
  dependency: `canary.mjs` uses Node built-ins on the runner's Node, like `detect.mjs`.
- **Release path.** The Beta pin exists only in the `test` job's own checkout and is never
  committed. A vitest asserts that `surfer.json` on `main` pins a release (`^\d+\.\d+(\.\d+)?$`),
  and `bump-surfer-json.py` refuses a Beta without `--allow-beta`, which only `e2e.yml`'s Beta
  mode passes.

`docs/security.md` §10 gains rules for the canary: G9 (no write access beyond issues, no secrets,
no PR, no push) and G10 (no report from an unverified Beta tarball), each linked to its tests.

## Tests

Written first and seen to fail.

Vitest, `tools/upstream/test/canary.test.mjs` (fixtures of real product-details responses, no
network):

- `finds 159.0b1 as the current beta of an unreleased Firefox 159`
- `does nothing when the devel version is not a beta` (`160.0a1`, empty, malformed)
- `does nothing for a beta whose major is already released`
- `tests a beta build not tested in the last 7 days, skips one tested 2 days ago`
- `a manual run with a version always tests it, and rejects a non-beta version`
- `opens an issue titled "Firefox 159 beta: canary findings" when a patch fails`
- `lists failed patches with hunks, failed checks, mochitest and e2e failures`
- `updates the open issue and comments what is new and what is fixed`
- `adds no comment when the results are unchanged`
- `mentions the owner only when it opens an issue`
- `closes the issue when every patch, check and test passes`
- `closes issues of released versions and links the tracking issue`
- `says the suites did not run when Mozilla's beta build is not indexed`
- `fences test output and cuts the body to 60,000 characters`

Vitest, `tools/test/upstream-beta-workflow.test.mjs` (text checks of the workflow, as
`upstream-workflow.test.mjs` does):

- `runs every 6 hours and by hand, never on pull_request_target`
- `grants nothing by default and no job more than issues: write`
- `the job with issues: write checks out and runs no repository code`
- `the report job runs only on main`
- `no job pushes, commits or opens a pull request`
- `no secret reaches any job, and the e2e call passes none`
- `every job is skipped outside vimma-browser/vimma`
- `nothing is built from a tarball whose SHA-512 Mozilla did not publish`
- `every action is pinned by a full commit SHA`

Vitest, existing files:

- `tools/test/upstream-workflow.test.mjs`: `upstream.yml checks the source through source-check.sh`;
  `e2e.yml continues after a failed suite only in beta mode`;
  `detect finds the canary's issues for the release's major, open and closed`;
  `a failed lookup never stops the bump: no issues, a warning`;
  `the bump PR's body gets the canary's issues from detect`.
- `tools/upstream/test/autopilot.test.mjs`:
  `the PR body names the Beta canary's issues for a new major, open and closed`;
  `no canary issue, or a release within the major Vimma ships: no Beta canary line`;
  `reads the issue list from upstream.yml and keeps only issue numbers and states`.
- `tools/artifact-build/test`:
  - `reads the tree from sourcestamp.txt`
  - `a beta tarball uses the mozilla-beta index and MOZ_ARTIFACT_TASK, not MOZ_ARTIFACT_REVISION`
  - `refuses a tree other than mozilla-release or mozilla-beta`
- `tools/upstream/test/artifact-preflight.test.mjs`:
  `finds Mozilla's 159.0b1 build in the mozilla-beta index` (fixture of the 2026-10-14 response).
- `tools/version-files/test/version-files.test.mjs`: `a beta pin writes 159.0 to version.txt`.
- `tools/test/surfer-pin.test.mjs`: `surfer.json on main pins a Firefox release, never a beta`.
- `tools/e2e/test`: `--report-json writes each failed scenario with its error`.

Python:

- `test_bump_surfer_json.py`: `test_refuses_a_beta_without_allow_beta`,
  `test_allow_beta_pins_159_0b1`.
- `test_patch_check.py`: `test_report_names_the_mozilla_beta_tree`.

Workflow: actionlint (with shellcheck) on `upstream-beta.yml`, `upstream.yml` and `e2e.yml`.
Live: one `workflow_dispatch` run on the current Beta before the schedule is enabled, its issue
and artifact checked by hand.

## Docs and changelog

- `docs/rebase.md`: a section "Before the release: the Beta canary" (what the issue means, how to
  fix on `main` for both versions, how to prepare a patch re-export). Section 5's "pins a real
  release (not a candidate, beta or ESR)" stays true for `main` and gains the Beta mode exception.
- `docs/security.md` §10: G9 and G10 (Security and privacy).
- `docs/runbook.md`: the canary's schedule, minutes (R9) and how to run it by hand
  (`gh workflow run upstream-beta.yml -f version=159.0b2`).
- ADR-002: an "Amended by" paragraph. Vimma still tracks and ships the release channel; it tests
  the Beta channel without tracking it, because Firefox's two-week cycle (R1) leaves too little
  time between a release and its drift deadline to find breakage there. The rejection of
  "Beta/Nightly" as the tracked channel is unchanged.
- ADR-010: one section, added with sub-PR 1. The artifact build also accepts a Beta tarball
  (tree from `sourcestamp.txt`, `MOZ_ARTIFACT_TASK`), used only by the canary, with the measured
  run.
- `plan.md`: the Q-UP row gets "every Beta build" instead of "weekly" and the two-week figure.
- `docs/guide.md`, README: no change; nothing a Vimma user sees changes.
- `CHANGELOG.md`: none. The change is CI only (`ci:` and `docs:` commits), types that
  `release-please-config.json` hides from the changelog.

## Delivery

1. **Beta-capable tools** (`ci(upstream):`). `source-check.sh` extracted from `upstream.yml`
   (behaviour unchanged, its test updated); `patch-check.py` reports `tree`; the artifact build
   and preflight read the tree and use `MOZ_ARTIFACT_TASK` for a Beta;
   `bump-surfer-json.py --allow-beta`; `version-files.mjs` for Beta pins; the `surfer.json` pin
   test; the ADR-010 section with the measured run. Verified by a local `npm run import` and
   artifact build on the current Beta with the mochitests run.
2. **e2e.yml Beta mode** (`ci(e2e):`). `continue-on-error` in Beta mode, `suite-results.json`, the
   e2e harness's `--report-json`. A `workflow_dispatch` of `e2e.yml` on the current Beta shows the
   report; PR CI is unchanged (a release run still fails on the first failure).
3. **The canary** (`ci(upstream):`). `upstream-beta.yml`, `canary.mjs`, their tests, the docs and
   the ADR-002 amendment. Merged with the schedule in place; a manual run on the current Beta is
   checked before the first scheduled one.
4. **Bump PR link** (`ci(upstream):`). `autopilot-body.mjs` names the `upstream-beta` issues
   (decision 11). Independent of 3 once 3 has merged.

Each sub-PR is mergeable alone and leaves PR CI and `upstream.yml` working as before.

## Open questions

None.
