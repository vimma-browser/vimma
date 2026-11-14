# ADR-010: PRs run the mochitests on a Firefox artifact build, on hosted runners

- Status: Accepted
- Date: 2026-10-09

## Context

Plan §9 left open how PRs get a browser to test: `surfer build --ui` on a cached engine, or a
Firefox artifact build, and which works with the release source tarballs Surfer uses (ADR-002).
Until now `e2e.yml` was a no-op and every mochitest had run only on the maintainer's machine.
A full build is 22 GB of `engine/` and 39 min on 16 threads, far beyond a hosted runner (14 GB
disk). The repo becomes public (MPL-2.0); until then Actions minutes are limited. (Since changed:
the repository is public, and a standard hosted runner has about 86 GB free in practice. A cold
full build there takes 113 min and fits with a 16 GB swap file, so the nightly and release
builds run on hosted runners: spec build-supply-chain, R9, R10 and R15;
docs/runbook/ci-full-builds.md, "Full
builds". PRs still use artifact builds: a full build per push would make every PR wait 2 hours.)

## Decision

`e2e.yml` runs on `ubuntu-24.04` (GitHub-hosted) for every PR that is not docs-only:
`CI_SKIP_INIT=1 surfer download` (release tarball, no history) → `git init` of an empty
`engine/.git` → `npm run import` → `node tools/artifact-build/artifact-build.mjs` →
`npm run mochitest -- --artifact tests/browser/`.

`tools/artifact-build` derives `engine/mozconfig.artifact` from `engine/mozconfig` and builds in
`engine/obj-artifact`, with `MOZ_ARTIFACT_REVISION` read from the tarball's
`engine/sourcestamp.txt`. `mach` then fetches Mozilla's own shippable build of that release
(`gecko.v2.mozilla-release.shippable.revision.<rev>.firefox.linux64-opt`: `target.tar.xz`,
`target.common.tests.tar.zst`) and builds our front end on top.

Tests that only a full build can pass carry `skip-if = ["artifact"]` in `browser.toml`.
**Until the hosted nightly is switched on (`NIGHTLY_ENABLED` is unset), those
tests and all compiled-in build-config behaviour run only on local full builds.** A PR that
touches `*.patch`, `configs/`, `moz.configure` or branding must therefore report a local
`npm run mochitest -- tests/browser/` on the full build (PR template checkbox). Once the nightly
runs, it also runs the whole suite on the full build. (Since changed: `NIGHTLY_ENABLED` is set,
so `nightly.yml` runs the whole suite on a full build of `main` every night. The PR checkbox
stays, because the nightly sees a change only after it has merged.)

## Reasoning

Measured on Firefox 157.0.1 (docs/specs/m0-build-strategy.md has the numbers):

- **Artifact builds work from a release tarball.** `artifacts.py` normally walks VCS history to
  find pushheads, which a tarball lacks, but `MOZ_ARTIFACT_REVISION=<40-hex>` skips that, and
  `sourcestamp.txt` holds exactly the mozilla-release revision Mozilla's release build used.
  Our version display (0.x) selects the `mozilla-release` tree (`select_candidate_trees` reads
  `MOZ_APP_VERSION_DISPLAY`; mach has no switch to force it, so the tool refuses a display
  version that would steer it to beta, central or ESR). Release tasks are indexed for a year;
  the tool checks the index first and prints the expiry.
- **Fits a hosted runner.** 163 MB of artifacts; `obj-artifact` 0.6 GB; tree 4.7 GB unpacked.
  On `ubuntu-24.04` (2 CPU, private) the whole job is 5 min 27 s: unpack 66 s, artifact build
  198 s (CPU-bound front-end build), suite 27 s, with 7.1 GB disk left at the end. Locally a
  warm rebuild is 23 s.
- **Faithful for front-end code.** Everything we write (chrome JS, CSS, FTL, prefs, branding,
  patches to front-end files, `application.ini`, `AppConstants`) is built from our tree. 158 of
  159 assertions pass unchanged; the one left (`MOZ_CRASHREPORTER`) is compiled into libxul.
  Compiled-in values are not ours, though: see the gaps below.
- **Safe once public.** Hosted runner, read-only token, no secrets, `pull_request` (not
  `pull_request_target`): a fork PR can run code only on GitHub's disposable VM.
- **Free once public.** Standard hosted runners are unlimited for public repos.

What an artifact build cannot carry, and how the tool adapts (each in `artifact-build.mjs`):

| Full-build setting                              | In an artifact build                                                                     | Adaptation                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `--enable-optimize`, `--enable-hardening`       | configure: "not available in this configuration"                                         | dropped                                                                                       |
| `--disable-crashreporter`                       | configures, then Mozilla's libxul aborts at startup: missing `CrashService.sys.mjs`      | dropped; `browser_vimma_crash_reporter.js` is `skip-if = ["artifact"]`                        |
| `--disable-updater`                             | configures, then Mozilla's libxul aborts at startup: missing `UpdateServiceStub.sys.mjs` | dropped; `browser_vimma_updater.js` is `skip-if = ["artifact"]`                               |
| `--with-ccache`                                 | nothing to compile                                                                       | dropped                                                                                       |
| Binary `vimma`                                  | the launcher is `firefox`                                                                | `dist/bin/vimma` → `firefox` symlink                                                          |
| App data (`Name`, `Vendor`)                     | the launcher's compiled-in data is Mozilla's (`Firefox`, `Mozilla`)                      | tests run with `XUL_APP_FILE=dist/bin/browser/application.ini` (ours)                         |
| `MOZ_APP_UA_NAME=Firefox` (moz-configure.patch) | Mozilla's libxul has `""`, so the UA would end `Vimma/157.0.1`                           | that `application.ini` gets `UAName=Firefox`, the runtime field `nsHttpHandler` falls back to |

**Known gaps** (not adapted; Mozilla's values are compiled into libxul, so PRs cannot see a
regression here, only a local full build or the nightly can):

| Define                    | Used in                                                                                                           | Artifact build                                                                                                         | Full build                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `MOZ_APP_VERSION_DISPLAY` | `nsAppRunner.cpp` `DumpVersion` (`--version`) and the `-v` path; `xpcom/FOG.cpp` (Glean's app display version)    | `vimma --version` prints `… 157.0.1` (measured: `Mozilla Firefox 157.0.1`, or `Vimma Vimma 157.0.1` with our app file) | `Vimma 0.1.0 · Firefox 157.0.1`                       |
| `MOZ_APP_NAME`            | `widget/gtk` (window class, sound, D-Bus names), `nsGNOMEShellService.cpp`                                        | `firefox`                                                                                                              | `vimma`                                               |
| `MOZ_CRASHREPORTER`       | libxul                                                                                                            | on                                                                                                                     | off (`browser_vimma_crash_reporter.js`, skipped here) |
| `MOZ_UPDATER`             | libxul (update service, `nsUpdateDriver`); the flag is dropped (above), so also `AppConstants`, `application.ini` | on: `[AppUpdate] URL` is aus5.mozilla.org, About and Settings show update UI                                           | off (`browser_vimma_updater.js`, skipped here)        |

Not a gap: `MOZ_USER_DIR` (`nsXREDirProvider.cpp`, the legacy profile-root fallback) is
`"mozilla"` in both builds (configure sets it from `--with-user-appdir`, never from the
environment); the dead `export MOZ_USER_DIR` line has left `configs/common/mozconfig` (spec
m0-branding). The profile path itself comes from the app data's vendor and name, which tests take
from our `application.ini`.

`AppConstants.MOZ_APP_VERSION_DISPLAY` (JS) is ours in both builds, which is why
`browser_vimma_app_version.js` passes; the C++ copy is the gap. `MOZ_APP_VENDOR` reaches the
runtime only through `application.ini` on Linux (its C++ uses are Windows-only).

## Alternatives rejected

- **`surfer build --ui` on a cached engine (hosted).** The objdir is 20 GB, the repo cache limit
  10 GB, the runner disk 14 GB. A `--ui` build needs the whole objdir (backend, `dist/`, libxul);
  `dist/` alone cannot rebuild. Not possible.
- **Self-hosted runner for PR mochitests.** Runs PR code on the maintainer's machine. Acceptable
  only for same-repo PRs, never for forks once public; needs the machine online for every PR and
  a runner not yet registered; personal repos have no runner groups to fence it to one workflow.
  It would test the real build, but the artifact build already passes all but one assertion;
  the compiled-in gaps are covered by the full-build checkbox (and the nightly once live).
- **Prebuilt package plus test package from the nightly.** A PR would have to overlay changed
  chrome files into `omni.ja`: our files go through `jar.mn`, the preprocessor, chrome manifests
  and the startup cache, i.e. the build system we would be re-implementing, plus a packaged
  `runtests.py` harness outside mach. It also depends on the nightly runner. More moving parts
  for the same fidelity as Mozilla's own artifact mode.
- **Artifact build with `MOZ_ARTIFACT_URL` to archive.mozilla.org.** The release directory has
  the package but no `common.tests` archive (the harness binaries: `certutil`, `xpcshell`,
  `ssltunnel`…); those exist only on Taskcluster, which the revision lookup reaches anyway.

## Consequences

- Every PR runs the browser-chrome suite except a docs-only PR, which skips the job with `if:`
  (`tools/ci/docs-only.mjs`, issue #245).
- A test that needs a compiled-in define marks itself `skip-if = ["artifact"]` with a reason
  comment. It runs only on full builds: locally (PR template checkbox) and, once live, in the
  nightly. Keep that list short; review it in the patch audit.
- Depends on Mozilla's Taskcluster index for the release in `surfer.json`. Release tasks expire
  after a year, far longer than we stay on a release (ADR-002). The tool queries the index
  before building and fails with the revision, the expiry and a remedy; it never falls back to
  a different revision.
- A patch to C++ or to compiled-in build config is not exercised by PRs, only by local full
  builds (and the nightly once live). Such a patch needs an ADR line anyway (ADR-003).
- The job is a required status check on `main`, so it has no `paths` filter: a docs-only PR skips
  it with `if:`, which GitHub reports as success (issue #245).
- `engine/obj-artifact` also works locally, next to the full objdir: a front-end check in about
  half a minute instead of a full rebuild.

## Beta tarballs (amendment, spec upstream-beta-canary)

The Firefox Beta canary ([upstream-beta-canary](../specs/upstream-beta-canary.md)) runs the same
artifact build on a Firefox Beta source tarball, in its own CI checkout; `main` still pins a
release. `tools/artifact-build/artifact-build.mjs` and `tools/upstream/artifact-preflight.mjs`
read the tree from `sourcestamp.txt` and accept only `releases/mozilla-release` and
`releases/mozilla-beta`. A release is unchanged (`MOZ_ARTIFACT_REVISION`). For a Beta the tool
looks up `gecko.v2.mozilla-beta.shippable.revision.<rev>.firefox.linux64-opt` and passes the task
id as `MOZ_ARTIFACT_TASK` with `MOZ_ARTIFACT_REVISION` unset, because mach's revision search
picks its trees from Vimma's `0.x` display version and so never reaches mozilla-beta
(`select_candidate_trees` and `install_from` in `python/mozbuild/mozbuild/artifacts.py`,
Firefox 157.0.1). `version.txt` gets Mozilla's Beta value (`159.0` for `159.0b1`).

Measured on 2026-10-14 on 159.0b1 (mozilla-beta `c0c03f3f8990`, task `ILGA8D1vQYmtIo0RJKNABg`),
with the patch set re-exported for Firefox 158 (#186), because the `moz-build.patch` then on
`main` (for 157.0.1) does not apply to 159: the SHA-512 matched `SHA512SUMS`, `npm run import`
applied every patch, the artifact build took 34 s with a warm `~/.mozbuild`, and `tests/browser/`
ran in 7 min 10 s with 6,128 passed and 16 failed. Fourteen failures are in
`browser_vimma_sidebar_theme.js` (the history and bookmarks sidebars' search field no longer
takes `--vimma-bg` and `--vimma-muted`), a Firefox 159 change of the kind the canary exists to
report; two are `browser_vimma_perf.js` medians 0.5 to 1.7 ms over the 25 ms budget on a busy
local machine. `browser_vimma_app_version.js` passed with `version.txt` at `159.0`.
