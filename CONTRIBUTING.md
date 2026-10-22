# Developing Vimma

How to build, run and test Vimma, and how changes get in. For why Vimma exists, see the
[README](README.md); for what it does and how to use it, the [user guide](docs/guide.md).

## Requirements

- Linux x86_64 (the only platform with a full build so far; macOS on Apple Silicon runs the
  front-end tests on an artifact build, see "Building on macOS").
- About 35 GB of free disk space, as measured on one machine: `engine/` 27 GB (source and the
  full build), the sccache compiler cache 6.8 GB, toolchains in `~/.mozbuild` 3.1 GB and the
  Firefox source download in `.surfer/` 0.8 GB.
- Node.js 20.19 or later in the 20 line, or 22.12 or later; git.
- Python 3.10 to 3.14: the range `engine/mach` declares it supports. A newer Python breaks mach in
  places; Python 3.15 cannot parse the test manifests.
- Time: the first full build took 39 min on a 16-thread Ryzen with 58 GB RAM. The Firefox source
  download took 12.5 min. See [docs/runbook.md](docs/runbook.md).

## Reporting bugs and requesting features

- **Use the forms.** [New issue](https://github.com/vimma-browser/vimma/issues/new/choose)
  offers a bug report and a feature request form; blank issues are turned off. A bug report needs
  the Vimma version from `about:vimma`, the install type and the steps to reproduce.
- **Security goes private.** Report a vulnerability through
  [private vulnerability reporting](https://github.com/vimma-browser/vimma/security/advisories/new),
  as [SECURITY.md](SECURITY.md) describes, never in a public issue.
- **Questions go to Discussions.** How something works, or an idea that is not yet a concrete
  request, goes to [Discussions](https://github.com/vimma-browser/vimma/discussions).

**Triage.** Every new issue carries `needs-triage` until the maintainer has read it. Triage
reproduces a bug or asks for what is missing, closes duplicates and requests outside Vimma's
scope with a reason, and removes `needs-triage`. An issue moves onto the
[roadmap](https://github.com/orgs/vimma-browser/projects/1) in three steps:

1. **Triage:** the issue is read and kept, labelled `bug` or `enhancement`.
2. **Accepted:** the maintainer decides Vimma should have it. A bug fix is accepted as it is; a
   feature gets a draft spec ([docs/specs/README.md](docs/specs/README.md)) and the label
   `spec:draft`, then `spec:accepted` once its questions are answered.
3. **Planned:** it gets the label `planned` and a card in the board's Planned column; the card
   moves to In progress when work starts, and to Done when the last pull request closes it.

Labels are set by the maintainer only: a reporter's issue gets the form's labels and nothing
more, and no workflow reads labels from an issue's title or text.

## Build and run

```sh
npm ci                  # dev tools, including Surfer
npx surfer download     # Firefox source for the version in surfer.json, into engine/
npm run verify-source   # that tarball against Mozilla's signed SHA512SUMS (needs gpgv);
                        # npm run import refuses an engine/ it has not verified
npx surfer bootstrap    # Mozilla's toolchains into ~/.mozbuild (once)
npm run import          # apply Vimma's files and patches, select the vimma brand
npm run build           # full build (npx surfer build under a supported Python)
```

`npm run build` runs `npx surfer build` with a Python inside the range `engine/mach` declares,
chosen as `npm run mochitest` chooses one (see [Testing](#testing)), so a newer `python3` first
on `PATH`, for example 3.15 from mise, does not break the build. It stops with the range and the
interpreters it found when none fits. `npm run build -- --ui` rebuilds only the front end,
`npm run build -- --mach` runs `./mach build` (after a `moz.build` change), and
`npm run build -- --dry-run` prints the command and the Python it would use. It also adds
`~/.mozbuild/sccache`, where `npx surfer bootstrap` puts sccache, to the end of `PATH`, so
configure finds the compiler cache the mozconfig names.

Google Safe Browsing (phishing and malware protection) needs an API key, which is not in this
repository. A build without one works but shows the protection as off. To turn it on, get a free
key from Google and save it as `~/.config/vimma/keys/safebrowsing` before building
([runbook](docs/runbook.md#google-safe-browsing-key-spec-m0-safebrowsing-key)). Release packages
are built with a key.

Run it, then press `ctrl+b ?` to see every binding:

```sh
npm start               # full build if present, else the artifact build; ~/.cache/vimma-dev-profile
npm start -- --fresh    # a throwaway profile instead
npm start -- --import   # run `npm run import` first
npm start -- --profile DIR -- --jsconsole   # another profile; after the second -- browser flags
```

`npm start` (`tools/start.mjs`) passes its own profile, so it never touches your Firefox profile
(remoting is keyed by app name and profile: a `vimma` command line never reaches Firefox), and refuses to start a second instance on the same profile. It adds
one line to the profile's `user.js` (other lines are kept):
`security.sandbox.content.read_path_whitelist` set to this checkout's `src/`. A local build's
front-end files are symlinks into `src/`, outside the Firefox tree, and without that pref the
content sandbox refuses them, so Vimma's page actor never loads (packaged builds copy the files
and do not need it). `npx surfer run` uses a scratch profile without it.

After editing JavaScript or CSS under `src/`, run `npm run import && npm run build -- --ui`.
That rebuilds only the front end. Changes to branding, `configs/` or `moz.configure` need a full
`npm run build`.

`npm run import` first restores the upstream files our `.patch` files touch
(`tools/import/restore-patched.mjs`, the `+++ b/` paths, `--dry-run` to list them), so an edited
patch re-applies cleanly instead of failing on its old version; nothing else in `engine/` is
reset. After moving the checkout to another path, run
`node tools/import/relocate-checkout.mjs --from <old path>` before importing: it retargets
`engine/`'s absolute symlinks and rewrites the old path in the objdir
([runbook](docs/runbook.md#moving-the-checkout)).

## Testing

```sh
npm test                 # Vitest: vimma-core and tools (fast, no browser)
npm run typecheck        # tsc --checkJs
npm run lint             # eslint + prettier --check + no process wording in Markdown
npm run mochitest -- tests/browser/                       # browser tests on your full build
npm run mochitest -- tests/browser/browser_vimma_tabstrip.js
npm run sites -- --filter github                          # live sites, a report (docs/runbook.md)
npm run sites -- --offline --artifact                     # recorded pages, no network: the PR gate
```

`npm run mochitest` runs mach with the first `python3`, then `python3.N`, on `PATH` whose
version is inside the range `engine/mach` declares, and says which one it chose when it skipped
another. It stops with the interpreters it found when none fits. Set `VIMMA_MACH_PYTHON` to an
interpreter's path to choose one yourself.

A test that needs a temp dir makes it with `tempDir(prefix)` from `tools/test/temp-dir.mjs`,
which removes it when the test ends, also when it fails. `npm test` runs with a `TMPDIR` of its
own and fails if a test leaves anything in it. A mochitest removes its temp files in
`registerCleanupFunction`, and a Rust test drops its temp dir guard.

You can also test the front end without a full build. An artifact build puts our front end on
top of Mozilla's compiled binaries for the same release, and is what PR CI uses
([ADR-010](docs/adr/010-pr-artifact-builds.md)):

```sh
npm run import
node tools/artifact-build/artifact-build.mjs    # ~25 s warm; first run downloads 163 MB
npm run mochitest -- --artifact tests/browser/
```

An artifact build cannot check compiled-in settings (the `--version` string, the crash reporter
flag). A PR that touches patches, `configs/`, `moz.configure` or branding must report a
mochitest run on a full build.

### Building on macOS

macOS support is in progress ([spec macos-build](docs/specs/macos-build.md)). On a Mac, Vimma's
front end runs on an artifact build only, and only on Apple Silicon: the tool fetches Mozilla's
macOS arm64 build of the release in `surfer.json`. A full build on a Mac is not supported.

- **Tools.** Xcode's command line tools (`xcode-select --install`), Python 3 and
  `brew install gnu-tar gnupg`: Surfer unpacks the Firefox source with GNU tar (`gtar`) on macOS,
  and the source check needs `gpgv`.
- **Node.js** 20.19 or later in the 20 line, or 22.12 or later: the native binding of rolldown,
  which Vitest uses, refuses older versions. `.nvmrc` pins the version CI uses.

```sh
npm ci
tools/upstream/firefox-source.sh                # download, verify, unpack into engine/
npm run import
node tools/artifact-build/artifact-build.mjs    # Mozilla's macosx64-aarch64 build
npm run mochitest -- --artifact tests/browser/  # headless
```

`tools/upstream/firefox-source.sh` deletes `engine/` without asking, objdir included; in an
existing checkout use `npx surfer download` and `npm run verify-source` instead, as in "Build and
run". The artifact build's app is `engine/obj-artifact/dist/Vimma.app`.

Pull requests run the same steps on a hosted Mac (`mochitest (artifact build, macOS)` in
`e2e.yml`); that check is informational and does not block a merge
([runbook](docs/runbook.md#macos-mochitests-e2eyml-spec-macos-build)).

## Project layout

| Path                              | What                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/vimma-core/`            | Pure ES modules with no Firefox imports: key notation, actions, keymap, dispatcher, config and theme. Tested with Vitest.                        |
| `src/browser/base/content/vimma/` | Our browser code: the key host, actors, UI, workspaces, split panes, config and the control socket. `core/` is copied in by `npm run sync-core`. |
| `src/**/*.patch`                  | The small upstream patches, each listed in [ADR-003](docs/adr/003-own-files-minimal-patches.md).                                                 |
| `configs/`                        | mozconfigs and branding inputs.                                                                                                                  |
| `tests/browser/`                  | Mochitests (`browser_vimma_*.js`).                                                                                                               |
| `tools/`                          | Build, upstream-bump, licence and commitlint helpers.                                                                                            |
| `docs/`                           | [User guide](docs/guide.md), [bindings](docs/bindings.md), [limits](docs/limits.md), specs, ADRs, [runbook](docs/runbook.md).                    |

## How Vimma is built

Vimma is built with AI coding agents. Features start as written specs, are built test-first by
the agents, reviewed, and checked by CI and by the security model in
[docs/security.md](docs/security.md). The author tries each change in daily use before it goes
into a release.

## Workflow

Vimma follows a spec-first, test-first loop ([plan.md](plan.md) §4–§5):

- **Issues.** Every planned feature has one GitHub issue (label `planned`) with a short reason,
  a link to its spec and the spec's open questions. The issues are the backlog; the
  [Vimma roadmap](https://github.com/orgs/vimma-browser/projects/1) board tracks them, and
  [plan.md](plan.md) §6 keeps only the milestones and their order.
- **Specs.** Every feature starts as `docs/specs/<feature>.md`, written to
  [docs/specs/README.md](docs/specs/README.md). A spec merges to `main` at once as a draft with
  its open questions; the maintainer answers them in the feature's issue, each answer is a small
  edit merged at once, and the spec is accepted when nothing is open (the "Lifecycle" section of
  that page). Boundary changes and new upstream patches need an ADR in `docs/adr/`. Every
  Markdown file states decisions with their reasons, never who asked for them or when;
  `npm run lint` (`tools/md-wording`) fails on that kind of wording.
- **Comments.** A comment says why: a constraint, a Firefox quirk with its source path, a
  decision with its spec or `docs/security.md` rule. It does not restate the code or record who
  asked or which review found it; `npm run lint` (`npm run comment-wording`) checks the wording.
- **Pull requests.** A pull request is only for work that is ready to merge. Work that waits on a
  decision is a question in its issue, not an open pull request.
- **Unfinished features.** `main` is always releasable, because a merged Firefox security bump
  can release it with no person in the loop
  ([docs/specs/firefox-versions.md](docs/specs/firefox-versions.md), decision 16). A feature that
  lands over several pull requests therefore goes behind a pref that defaults off:
  - Add `pref("vimma.feature.<name>", false);` to
    `src/browser/branding/vimma/pref/firefox-branding.js`, with a comment naming the spec.
  - Read it with `Services.prefs.getBoolPref("vimma.feature.<name>", false)`. While it is off,
    nothing of the feature shows: no key, command, panel or status bar segment.
  - Tests turn it on: `SpecialPowers.pushPrefEnv({ set: [["vimma.feature.<name>", true]] })` in a
    mochitest, the `prefs` of an e2e scenario.
  - The pull request that finishes the feature removes the pref, every read of it and the test
    setup that turns it on, and adds the docs and changelog line a user-visible change needs.
  - Try an unfinished feature by setting the pref to `true` in `about:config`.

  `tools/test/feature-prefs.test.mjs` fails when a `vimma.feature.*` default is not `false`, or
  when code reads one with a `true` fallback. A feature that fits in one pull request needs no
  pref.

- **TDD.** Write the failing test and run it, then implement until it passes. Never loosen a test.
- **Commits.** Use Conventional Commits with a body: the subject is the changelog line; the body
  explains why.
  `npx commitlint --from origin/main` checks this, and CI rejects `feat`, `fix` and `revert`
  commits without a body.
- **Changelog.** A user-visible change gets a line in `CHANGELOG.md` `[Unreleased]`. The
  maintainer adds it at merge time, so parallel pull requests do not conflict; a pull request that
  changes a baseline or snapshot adds its own line (next item).
- **Screenshot baselines and snapshots.** Never change one without a changelog line that says
  why it changed: an updated baseline is a visible change, and the line is how a reviewer knows it
  was meant. `npm run e2e -- --update-baselines` writes new baselines and reminds you of this.
- **Docs.** A user-visible change updates [docs/guide.md](docs/guide.md) (its "Features at a
  glance" too when it changes what works), and the README's status line if it changes that. See
  [docs/review-checklist.md](docs/review-checklist.md).
- **Agents.** [CLAUDE.md](CLAUDE.md) sets the rules for AI coding agents. They apply to human
  contributors too. <!-- process-wording: points at the coding agents' rules file -->

Before pushing, run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:py`,
`npm run license-check` and `npx surfer license-check`.

## Branch policy

A ruleset protects `main`:

- **Pull requests only.** Nobody pushes to `main` directly. PRs are squash-merged, so history
  stays linear and each PR is one commit whose subject is the PR's changelog line.
- **Required checks.** A PR merges only when these pass: "lint, typecheck, test, commitlint,
  licences" (`ci.yml`), "mochitest (artifact build)" (`e2e.yml`), the Semgrep check
  (`semgrep.yml`), "CodeQL (javascript-typescript)" and "CodeQL (rust)". A PR that changes only
  prose Markdown skips the build and the tests, and those checks still pass; prettier,
  commitlint, the Markdown checks, Semgrep and CodeQL run on every PR
  ([runbook](docs/runbook.md#docs-only-pull-requests-issue-245)).
- **Code scanning gate.** A PR that adds a code-scanning alert of severity high or above
  cannot merge. Fix the alert; a false positive is dismissed on GitHub with a reason, never
  silenced in the code.
- **No force-push or deletion** of `main`.
- **Branches are deleted on merge.** Start new work from a fresh `origin/main`.
- **Auto-merge is available.** Turn it on for a PR and it squash-merges once the checks pass.

## Dependency updates

Dependabot ([.github/dependabot.yml](.github/dependabot.yml)) keeps npm, the vimma-ctl crate,
its Rust toolchain and the GitHub Actions current:

- **Weekly, grouped.** On Monday mornings (Helsinki) it opens one PR per ecosystem with every
  minor and patch update, and one PR per major update. A release must be three days old first.
  Titles read `build(deps): bump …` (older Dependabot versions wrote `Bump`). Dependabot's
  casing, title length and long release-note lines are not configurable, so commitlint skips its
  commits and their squashes (`tools/commitlint`).
- **Security fixes come at once.** A Dependabot alert gets its fix PR as soon as there is one,
  outside the schedule. When a parent package pins the vulnerable version, add an `overrides`
  entry to the root `package.json` instead (as for `sharp` and `qs`) and say why in the PR.
- **Auto-merge when green.** [dependabot-automerge.yml](.github/workflows/dependabot-automerge.yml)
  turns on auto-merge for security, patch and minor updates. They merge only once every
  required check above passes, licences included: a new licence or a new version of a package
  with a licence exception fails `npm run license-check` until a person reviews it.
- **Majors need review.** Major updates and every GitHub Actions update (workflows hold write
  tokens) get a comment and wait for a person to read the changelog, fix what breaks and merge.
- **The release path is always reviewed.** The release build runs `@zen-browser/surfer` and
  `ajv`, and with them every package they depend on (about 220, listed by
  `node tools/deps/release-path.mjs`). Surfer is pinned to an exact version, and no change to any
  release-path package auto-merges, security updates and transitive bumps in grouped updates
  included: the workflow's `classify` job compares the two lockfiles and holds the PR. Surfer and
  `ajv` come in their own `release-path` group, so a held update does not hold the others.
- **Reading the held PR.** Its comment links the run. The `classify` job's summary lists each
  changed release-path package with its old and new version, then the published diff
  (`npm diff --diff=<name>@<old> --diff=<name>@<new>`), the code that will run in the build. A
  summary is cut at about 1 MB; the full diff is the run's `release-path-diff` artifact (30
  days). Read it for new network calls, `child_process`, obfuscated code and files unrelated to
  the release notes, then merge.
- **No install scripts.** `.npmrc` sets `ignore-scripts=true`, so `npm ci` and `npm install` run
  no package's install scripts (`npm run` still runs ours). A new dependency that needs one is a
  security decision for its PR, not a reason to drop the setting.
- **By hand.** Node in `.nvmrc` (see the bench baseline in [docs/runbook.md](docs/runbook.md))
  and the Semgrep image digest in `semgrep.yml` are not covered; bump them in their own PR.

## Known build and CI limits

User-facing limits are in [docs/limits.md](docs/limits.md); these concern building and testing
Vimma.

- The macOS build (Apple Silicon) is cross-compiled on Linux by `macos.yml`, weekly, by hand and
  on pull requests that touch `configs/macos/` or its scripts; a hosted Mac only runs the result
  ([ADR-018](docs/adr/018-macos-cross-build.md),
  [runbook](docs/runbook.md#macos-build-macosyml)). To try it locally, run
  `SURFER_PLATFORM=darwin npx surfer build` on Linux, then `tools/package/macos-dmg.sh` on the
  `.dmg` from `./mach package`.

- PR CI runs the mochitests on an artifact build, which cannot see compiled-in config: the C++
  `--version` string, `MOZ_APP_NAME` and the crash-reporter flag
  ([ADR-010](docs/adr/010-pr-artifact-builds.md), Known gaps). PR CI's builds also have no Google
  Safe Browsing key, so Safe Browsing is off in them.
- The nightly full build is not live: `nightly.yml` builds on GitHub-hosted runners (about 2
  hours), but stays switched off until `NIGHTLY_ENABLED` is set
  ([runbook](docs/runbook.md#full-builds-nightlyyml-releaseyml)). Until then
  `skip-if = ["artifact"]` tests run only on local full builds. `RELEASE_ENABLED` is set, but each
  release is a draft that runs no build until the maintainer publishes it
  ([runbook](docs/runbook.md#releases-release-pleaseyml)). PRs that touch patches, `configs/`,
  `moz.configure` or branding must report a full-build run
  ([ADR-010](docs/adr/010-pr-artifact-builds.md), [runbook](docs/runbook.md)).
- Nightly builds are not published as a release before the first release: each one is a
  workflow artifact of its run, kept 7 days, with no release page or stable link. It is not
  private: the repository is public, so anyone signed in to GitHub can download it for those 7
  days ([runbook](docs/runbook.md#full-builds-nightlyyml-releaseyml);
  [build-supply-chain](docs/specs/build-supply-chain.md), decision 23).
- Artifact builds depend on Mozilla's Taskcluster index for the pinned release, which expires
  after a year ([ADR-010](docs/adr/010-pr-artifact-builds.md)).
- PRs opened by `GITHUB_TOKEN` (upstream bumps, Claude, release-please) do not trigger CI by
  themselves ([runbook](docs/runbook.md)).
- Firefox bumps are meant to need no manual step: the upstream autopilot detects a release,
  dry-runs every patch, runs the suites and opens the bump PR
  ([rebase playbook](docs/rebase.md), [m7-upstream-autopilot](docs/specs/m7-upstream-autopilot.md)).
  Gaps that still need a person: merging a green bump PR, pasting a refreshed pref copy that
  `upstream-prefs.mjs` reports, and re-exporting a patch that no longer applies
  ([#259](https://github.com/vimma-browser/vimma/issues/259)); releasing the merged bump
  ([#220](https://github.com/vimma-browser/vimma/issues/220),
  [#224](https://github.com/vimma-browser/vimma/issues/224)).
- The ASRouter `cfr` provider pref is a copy of upstream's value. The bump PR's suites fail when
  it is stale, but the refreshed line is pasted by hand
  ([runbook](docs/runbook.md#upstream-bumps-upstreamyml-the-upstream-autopilot);
  [#259](https://github.com/vimma-browser/vimma/issues/259)).
- Mozilla's signature on `SHA512SUMS` proves Mozilla built and signed the tarball, not that it is
  the release: a superseded build candidate (`candidates/X-candidates/buildN/`) lists the same
  file name in a `SHA512SUMS` signed by the same key, so someone who controls the connection to
  archive.mozilla.org could serve an abandoned respin of the version `surfer.json` names
  ([ADR-021](docs/adr/021-mozilla-release-key.md)).
- `surfer import` stops at the first patch that fails, and `git apply` has no fuzz: a hunk whose
  context drifted fails like one whose code is gone. `tools/upstream/patch-check.py` reports
  every patch and hunk, and tells the two apart
  ([m0-rebase-playbook](docs/specs/m0-rebase-playbook.md)).
- A change to build config needs a full rebuild of 15–30 min on 16 threads: 927 s
  ([m0-app-version](docs/specs/m0-app-version.md)), 977 s
  ([m0-branding](docs/specs/m0-branding.md)), 1763 s
  ([m0-mozilla-services](docs/specs/m0-mozilla-services.md)) and 1805 s (`m0-updater`, PR #15).
  The first full build took 39 min ([runbook](docs/runbook.md)).
- Builds from before the app-version change report `0.1.0` instead of the Firefox version as
  their app version, so they see newer profiles as a downgrade and refuse them. Use a separate
  `--profile` or `--allow-downgrade` ([runbook](docs/runbook.md#smoke-check)).
- `vimma-ctl` checks the discovery file's permissions on Unix only; on Windows `check_mode` does
  nothing (ACLs, not mode bits)
  ([m0-control-protocol-and-vimma-ctl](docs/specs/m0-control-protocol-and-vimma-ctl.md)).
- Packaged installs carry `is-packaged-app`, which turns off Firefox's warning about missing
  unprivileged user namespaces (`security/sandbox/common/SandboxUtils.sys.mjs:25`) and its
  `about:support` flag (`toolkit/content/aboutSupport.js:1551`; Firefox 158.0); the user-facing
  effect is in [docs/limits.md](docs/limits.md#platforms-and-packaging).

## More

- [docs/runbook.md](docs/runbook.md): builds, CI, e2e tests, parallel browser lanes and releases.
- [docs/rebase.md](docs/rebase.md): moving to a new Firefox release.
- [docs/review-checklist.md](docs/review-checklist.md): what a PR needs before merge.
- [docs/security.md](docs/security.md): the security model, a rule per risky component with the
  tests that enforce it. A change that touches one of those components keeps its rules true
  and its test links valid (CI checks them); vulnerabilities are reported as
  [SECURITY.md](SECURITY.md) says.
- [docs/adr/](docs/adr/) and [docs/specs/](docs/specs/): decisions and feature specs.
- [plan.md](plan.md): the roadmap.
