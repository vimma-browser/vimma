# Spec: m0-build-strategy

Status: implemented · Milestone: M0 · Area: CI (`.github/workflows/e2e.yml`,
`tools/artifact-build/`) · Decision: ADR-010

## User story

As the maintainer, every PR that changes the browser runs `npm run mochitest -- tests/browser/`
against a real Vimma build, within the Actions budget, and stays safe to run on pull requests
from forks once the repo is public.

## Scope

- `tools/artifact-build/artifact-build.mjs`: artifact build in `engine/obj-artifact` (ADR-010).
  Writes `engine/mozconfig.artifact` from `engine/mozconfig`, runs `mach build` with
  `MOZ_ARTIFACT_REVISION` from `engine/sourcestamp.txt`, links `dist/bin/<binaryName>` to the
  `firefox` launcher, writes `dist/bin/browser/application.ini` (ours plus `UAName`).
- `tools/mochitest.mjs --artifact`: `MOZCONFIG=engine/mozconfig.artifact` and
  `--setenv=XUL_APP_FILE=…/obj-artifact/dist/bin/browser/application.ini`.
- `e2e.yml`: one job on `ubuntu-24.04`, `pull_request` (+ `ready_for_review`, manual), no paths
  filter (a `changes` job skips docs-only PRs with `if:`), read-only token, no secrets, actions
  pinned to SHAs, cancel superseded runs.
- `nightly.yml`: runs the suite on the full build. It would cover the `skip-if = ["artifact"]`
  tests, but no runner is registered yet: until then they run only locally (see Settled).
- `browser_vimma_crash_reporter.js`: the `MOZ_CRASHREPORTER` assertion moved out of
  `browser_vimma_mozilla_services.js` unchanged, `skip-if = ["artifact"]`.

## Tests (write first)

- `tools/artifact-build/test/artifact-build.test.mjs`: dropped options (`--enable-optimize`,
  `--enable-hardening`, `--disable-crashreporter`, `--with-ccache`) and the kept ones; artifact
  options and objdir; refuses an already-artifact mozconfig; `sourceRevision` reads the
  40-hex revision and throws on empty, missing or short; `uaName` from `moz.configure`;
  `appIniForArtifact` adds/replaces `UAName` in `[App]`, no-op for null, throws without `[App]`.
- `tools/test/mochitest.test.mjs`: default suite headless; path mapping; `--headed`; `--artifact`.
- Further tests: `candidateTree` (release for 0.x and `-nightly.*`; b/a/esr elsewhere),
  `indexNamespace`, `indexTask` on fixture responses (found, 404, expired, HTTP 500, malformed),
  `refreshAppIni` rewriting the copy after a rebuild (temp dir).
- The mochitest suite itself, on both builds (below).

## Research and measurements (2026-10-09, Firefox 157.0.1, dev box: 16 threads, ~1 MB/s link)

**Artifact builds and release tarballs.** `python/mozbuild/mozbuild/artifacts.py`:
`install_from` takes `MOZ_ARTIFACT_FILE`, `MOZ_ARTIFACT_URL`, `MOZ_ARTIFACT_REVISION`, then
`MOZ_ARTIFACT_TASK`, else `install_from_recent`, which walks VCS history. Surfer's `engine/.git`
is one commit ("Firefox 157.0.1", 03eb9afb…), so `install_from_recent` searched the index for that
local hash: "Tried 1 pushheads, no built artifacts found". A mozconfig `export
MOZ_ARTIFACT_REVISION` does not reach the artifact step; it must be in the environment of `mach`.

The tarball's `sourcestamp.txt` is `20261005135250` + `https://hg.mozilla.org/releases/
mozilla-release/rev/737ec77d…afd19`; the candidates' `firefox-157.0.1.json` has the same
`moz_source_stamp`. With a 40-hex revision unknown to git, `install_from_revset` uses it as is;
`select_candidate_trees` picks `releases/mozilla-release` (our `MOZ_APP_VERSION_DISPLAY` 0.1.0 has
no a/b/esr). Index `gecko.v2.mozilla-release.shippable.revision.737ec…firefox.linux64-opt` →
task `KpoROUtgTjWRzky1Y6nIAg`, expires 2027-10-05. Its artifacts include `target.tar.xz`,
`target.common.tests.tar.zst`, `target.mochitest.tests.tar.zst`. archive.mozilla.org's release and
candidates directories have the package but no tests archives.

| Step (local)                                               | Result                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Artifact download                                          | 163 MB: `target.tar.xz` 89 MB, `common.tests` 74 MB, `xpt_artifacts` 0.3 MB |
| Cold `mach build` (fresh `MOZBUILD_STATE_PATH`)            | 250 s, CPU 7 %: download-bound on this link                                 |
| Warm rebuild, objdir removed                               | 23 s                                                                        |
| `engine/obj-artifact`                                      | 586 MB; `~/.mozbuild` cold state 429 MB (incl. the artifact cache)          |
| Unpacked tree without `.git` (`CI_SKIP_INIT=1`)            | 4.7 GB (7.6 GB with Surfer's `git init`)                                    |
| `npm run import` on that tree (after `git init -q engine`) | 1 s; 6 patches apply                                                        |
| Suite on the artifact build                                | 158 passed, 0 failed, 2 todo, crash-reporter file skipped; 15 s             |
| Suite on the full build                                    | 159 passed, 0 failed, 2 todo; 20 s                                          |

How each build-config patch fared (ADR-010 has the adaptation table):

| Attempt                                                                         | Outcome                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full mozconfig + `--enable-artifact-builds`                                     | configure: `--enable-optimize`, then `--enable-hardening` "not available"                                                                                                    |
| … with `--disable-crashreporter` kept                                           | main process aborts: "Missing chrome or resource URLs: resource://gre/modules/CrashService.sys.mjs"                                                                          |
| Crash reporter on, no `XUL_APP_FILE`                                            | 156/159: `appinfo.name` "Firefox", `appinfo.vendor` "Mozilla" (launcher's compiled `kStaticAppData`), `MOZ_CRASHREPORTER` true. UA passes only because the name is "Firefox" |
| `XUL_APP_FILE=dist/bin/application.ini`                                         | aborts: missing `resource:///modules/BrowserContentHandler.sys.mjs` (app dir becomes `dist/bin`)                                                                             |
| `XUL_APP_FILE=dist/bin/browser/application.ini`                                 | 152/159: branding passes; the 6 UA checks fail (`… Vimma/157.0.1`: libxul's `MOZ_APP_UA_NAME` is `""`, so `nsHttpHandler` falls back to `appinfo.name`) + crash reporter     |
| … plus `UAName=Firefox` in that file (`CreateAppData.cpp` reads `[App] UAName`) | 158/159: only `MOZ_CRASHREPORTER`                                                                                                                                            |

Vendor and version files are not compiled into libxul on Linux (`MOZ_APP_VENDOR` is used in C++
only by Windows' default-browser agent and updater tests), so they need no adaptation.

**Hosted runners** (docs.github.com, "GitHub-hosted runners", 2026-10-09): `ubuntu-latest` has
14 GB SSD; 2 CPU / 8 GB RAM for private repos (billed minutes), 4 CPU / 16 GB for public repos,
where standard runners are free and unlimited. The cache is 10 GB per repo.

**GitHub run** (PR #8, run 37931452787, `ubuntu-24.04`, private repo so 2 CPU): green on the
first attempt, **5 min 27 s** wall (billed 6 min).

| Step                                 | Time  | Notes                                                                                                         |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------- |
| checkout, setup-node, `npm ci`       | 12 s  |                                                                                                               |
| `surfer download` (`CI_SKIP_INIT=1`) | 71 s  | download 4 s, unpack 66 s                                                                                     |
| `npm run import`                     | 2 s   |                                                                                                               |
| artifact build                       | 198 s | the 163 MB of artifacts take ~3 s; the rest is configure and the front-end build, CPU-bound (86 % of 2 cores) |
| mochitests                           | 43 s  | suite 27 s: 158 passed, 0 failed, 2 todo; crash-reporter file `SKIP (skip-if: artifact)`                      |

Disk on `/` (72 GB, image uses 65 GB): 7.5 GB free after unpacking, 6.3 GB free at the end;
`engine/` 5.7 GB incl. `obj-artifact`, `~/.mozbuild` 403 MB. The workflow then deletes the
0.8 GB tarball after unpacking. If the image shrinks further, removing preinstalled SDKs
(`/usr/local/lib/android`, ~9 GB) is the next lever. A cache would not shorten the run: the
downloads are already seconds, the build is CPU.

## Settled (2026-10-09)

- **Artifact build on a hosted runner** (ADR-010), not a cached engine, a self-hosted runner or a
  nightly package overlay; reasons in the ADR's "Alternatives rejected".
- **Nothing needs the maintainer** for PR tests: no runner, no secret, no variable.
- **No cache** for the Firefox tarball or `~/.mozbuild`: both download in seconds on a hosted
  runner (4 s and ~3 s above) and a cache would cost ~1 GB of the 10 GB limit and a restore step.
- **Paths filter** while the repo was private: docs-only and CI-tooling-only PRs skipped e2e.
  Since `mochitest (artifact build)` became a required check on `main`, the paths filter is gone;
  a `changes` job (`tools/ci/docs-only.mjs`) skips docs-only PRs with `if:`, which GitHub reports
  as success.
- **`skip-if = ["artifact"]`** is for assertions about compiled-in build config only, each with a
  reason comment. **Until the nightly runner is live, they and every compiled-in difference
  (ADR-010 "Known gaps": `--version`/`MOZ_APP_VERSION_DISPLAY` in C++, `MOZ_APP_NAME`, the crash
  reporter) run only on local full builds.** Rule: a PR touching `*.patch`, `configs/`,
  `moz.configure` or branding reports `npm run mochitest -- tests/browser/` on the full build
  (`.github/pull_request_template.md`).
- **Preflight**: the tool queries the Taskcluster index before building and fails with
  the revision, expiry and a remedy; it refuses a display version that would make mach search
  beta, central or ESR (`select_candidate_trees`). **Disk guards** in e2e.yml: ≥ 8 GB before the
  download (job uses ~6 GB), ≥ 3 GB before the build (uses 1.2 GB). The XUL_APP_FILE copy is
  rewritten on every `--artifact` run, so a bare `./mach build` cannot leave it stale.
- **`MOZ_USER_DIR` is not a gap**: `"mozilla"` in both builds; our mozconfig export of it has no
  effect (full build's `mozilla-config.h`).
- **Required checks:** a path-filtered job cannot be required, or docs-only PRs hang; hence the
  `changes` job above.
- **Fork PRs:** same job, read-only `GITHUB_TOKEN`, no secrets; the repository requires approval
  for workflow runs from all outside contributors. Nothing here runs on `vimma-build`.

## Out of scope

Socket-driven e2e and screenshot diffs (they join this job when `tools/e2e` exists), the
self-hosted runner itself (nightly.yml, docs/runbook/), aarch64/macOS. (Since changed: no
self-hosted runner is used or planned; full builds move to GitHub-hosted runners with
[#224](https://github.com/vimma-browser/vimma/issues/224), spec build-supply-chain decision 6.)
