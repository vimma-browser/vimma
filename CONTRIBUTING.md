# Developing Vimma

How to build, run and test Vimma, and how changes get in. For why Vimma exists, see the
[README](README.md); for what it does and how to use it, the [user guide](docs/guide.md).

## Requirements

- Linux x86_64 for a full build. Releases ship for Linux x86_64 and for macOS on Apple Silicon;
  the macOS build is cross-compiled on Linux, and a Mac runs the front-end tests on an artifact
  build (see "Building on macOS").
- About 35 GB of free disk space, as measured on one machine: `engine/` 27 GB (source and the
  full build), the sccache compiler cache 6.8 GB, toolchains in `~/.mozbuild` 3.1 GB and the
  Firefox source download in `.surfer/` 0.8 GB.
- Node.js 22.18 or later, which runs the TypeScript tools under `tools/` without a flag
  ([ADR-025](docs/adr/025-typescript-for-tools.md)); `.nvmrc` pins the version CI uses. git.
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
these lines to the profile's `user.js` (other lines are kept):
`security.sandbox.content.read_path_whitelist` set to this checkout's `src/`, and
`vimma.config.path` set to `<profile>/vimma/config.toml`, so a dev build reads and writes a
`config.toml` of its own and never the installed Vimma's `~/.config/vimma/config.toml` (a setting
only the dev build knows would break that release). Copy your own file there to try it with your
settings; a `vimma.config.path` the `user.js` already sets is kept. A local build's
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

### vimma-ctl from source

Every release package ships `vimma-ctl` (spec [ship-vimma-ctl](docs/specs/ship-vimma-ctl.md)).
To build it yourself, for a source build of Vimma or while changing it (Rust, no dependencies;
`rust-toolchain.toml` pins the toolchain):

```sh
cd tools/vimma-ctl
cargo build --release --locked   # → target/release/vimma-ctl
```

Its version is Vimma's, read from `surfer.json`'s `displayVersion` by `build.rs`, so a client
and a browser built from one checkout match and the agent notice for an older `vimma-ctl` stays
quiet. Release builds are static Linux binaries (`--target x86_64-unknown-linux-musl`) and
native arm64 ones on macOS; `release.yml`'s `ctl` and `macos-ctl` jobs build them, and
`tools/package/ctl-notices.mjs` gathers the notices of what the toolchain links into them (Rust's
standard library, and musl and LLVM's libunwind on Linux) from that toolchain, for the packages,
and the SBOM entry. A Rust update that brings a new musl stops that step until the new musl's
`COPYRIGHT` is in `tools/package/notices/` (`tools/package/vendor/README.md`).

## Testing

```sh
npm test                 # Vitest: vimma-core and tools (fast, no browser)
npm run typecheck        # tsc --checkJs: browser code and packages, then tools/
npm run lint             # eslint, prettier, wording, spec, architecture and changelog checks
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

Vimma ships for macOS 15 or later on Apple Silicon
([spec macos-build](docs/specs/macos-build.md)). The release build is cross-compiled on Linux
(see "Known build and CI limits"), so on a Mac Vimma's front end runs on an artifact build only:
the tool fetches Mozilla's macOS arm64 build of the release in `surfer.json`. A full build on a
Mac is not supported.

- **Tools.** Xcode's command line tools (`xcode-select --install`), Python 3 and
  `brew install gnu-tar gnupg`: Surfer unpacks the Firefox source with GNU tar (`gtar`) on macOS,
  and the source check needs `gpgv`.
- **Node.js** 22.18 or later: the first Node 22 that runs the `.ts` tools without a flag
  ([ADR-025](docs/adr/025-typescript-for-tools.md)). `.nvmrc` pins the version CI uses.

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

[ARCHITECTURE.md](ARCHITECTURE.md) is the map of the code: what Vimma adds to Firefox, the
processes and how they talk, a line for every folder, the dependencies between them and the trust
boundaries. [docs/README.md](docs/README.md) says which document covers what. The top level:

| Path                              | What                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/vimma-core/`            | Pure ES modules with no Firefox imports: keys, actions, keymap, dispatcher, config, theme, the browser model, the agent logic. Vitest.                    |
| `src/browser/base/content/vimma/` | Our browser code: key host, actors, UI, workspaces, split panes, config, control socket, agents. `core/` is copied in by `sync-core`.                     |
| `src/**/*.patch`                  | The small upstream patches, each listed in [ADR-003](docs/adr/003-own-files-minimal-patches.md).                                                          |
| `configs/`                        | mozconfigs, branding inputs and the updater's certificates.                                                                                               |
| `tests/`                          | Mochitests (`browser/`), socket-driven e2e scenarios (`e2e/`) and contract fixtures (`contract/`).                                                        |
| `tools/`                          | vimma-ctl (Rust), the e2e harness, builds and packaging, the upstream autopilot, release and update tooling, and the lints.                               |
| `.github/workflows/`              | CI, nightly and scheduled checks, the upstream autopilot, release and publishing.                                                                         |
| `docs/`                           | [User guide](docs/guide.md), [bindings](docs/bindings.md), [limits](docs/limits.md), [roadmap](docs/roadmap.md), specs, ADRs, [runbook](docs/runbook.md). |

## TypeScript in tools/

Code Firefox loads (`src/`) and `packages/vimma-core` are JavaScript with JSDoc types
([ADR-004](docs/adr/004-javascript-jsdoc.md)). The Node-side tools under `tools/` move to
TypeScript that Node runs as it is ([ADR-025](docs/adr/025-typescript-for-tools.md)), one area (a
folder of `tools/`) per pull request. `npm run typecheck`, `npm run lint` and `npm test` treat a
`.ts` file as they treat a `.mjs` one, and also type-check `.ts` tests. Write only syntax Node can
erase (`tsc` rejects the rest), `import type` for a type-only import, and the real file name in a
relative import: `./x.ts`.

Moving an area, in a pull request that does only this (`Part of #946`):

1. **Callers first.** Search for every path to the area's files before renaming:
   `git grep -nE 'tools/<area>/|\.\./<area>/|tools\\/<area>\\/'` and each file's bare name. Count
   them in `package.json` scripts, workflows, docs, other tools' imports, and tests that read a
   workflow or a tool as text (they match paths with escaped slashes).
2. **Check the workflows that run it.** An area a workflow runs on the runner's own Node (no
   `actions/setup-node` with `.nvmrc`) needs that step first, in its own pull request. A workflow
   that runs the base branch's copy of a tool (`git show "$BASE:tools/…"`) first learns to look
   for the `.ts` name and fall back to the `.mjs` one. An area that a workflow holding secrets
   calls goes last, with a security review by a fresh session that did not write it.
3. **Record the tests.** `npx vitest run tools/<area> --reporter=json --outputFile=before.json`,
   and the output of each command-line tool on the real tree.
4. **Rename alone,** in its own commit, so that the review sees the move and the conversion
   apart: `git mv tools/<area>/x.mjs tools/<area>/x.ts`, tests included.
5. **Types to syntax, nothing else.** `@param`/`@returns` types become annotations, `@typedef`
   an exported `type` or `interface`, `/** @type {T} */ (x)` becomes `x as T`, and
   `import("./x.mjs").T` an `import type`. Comments keep their words; logic does not change.
6. **Update every caller** from step 1. An implemented spec that names a renamed file gets a
   `(Since changed: …)` note, not a rewrite.
7. **Prove it.** The same test names and count as in step 3 (diff the two lists); the
   typecheck, lint and test scripts green; each command-line tool printing the same output
   through its npm script; and no path to a renamed `.mjs` file left in `git grep`.

## How Vimma is built

Features start as written specs, are built test-first, reviewed, and checked by CI and by the
security model in [docs/security.md](docs/security.md). The author tries each change in daily
use before it goes into a release.

## Workflow

Vimma follows a spec-first, test-first loop:

- **Issues.** Every planned feature has one GitHub issue (label `planned`) with a short reason,
  a link to its spec and the spec's open questions. The issues are the backlog; the
  [Vimma roadmap](https://github.com/orgs/vimma-browser/projects/1) board tracks them, and
  [docs/roadmap.md](docs/roadmap.md) keeps only the milestones and their order.
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
  A bug fix starts with a failing test at the lowest layer that can reproduce it: vimma-core's
  Vitest before a mochitest, a mochitest before an e2e scenario.
- **Versioned formats.** A change to the config schema, the control protocol or a state file
  raises its version and adds valid and invalid fixtures for the new version in
  `tests/contract/`; a config schema change also adds a migration step (`MIGRATIONS` in
  `packages/vimma-core/src/config.mjs`), so older files keep loading.
- **Commits.** Use Conventional Commits with a body: the subject is the changelog line; the body
  explains why.
  `npx commitlint --from origin/main` checks this, and CI rejects `feat`, `fix` and `revert`
  commits without a body.
- **Changelog.** release-please writes `CHANGELOG.md` from the Conventional Commits on `main`
  ([docs/runbook.md](docs/runbook.md), Releases), so the squash commit's subject is the changelog
  line; do not edit the file by hand.
- **Screenshot baselines and snapshots.** Never change one without a commit body that says why
  it changed: an updated baseline is a visible change, and the body is how a reviewer knows it
  was meant. `npm run e2e -- --update-baselines` writes new baselines and reminds you of this.
- **Docs.** A user-visible change updates [docs/guide.md](docs/guide.md) (its "Features at a
  glance" too when it changes what works), and the README's status line if it changes that. See
  [docs/review-checklist.md](docs/review-checklist.md).
- **Agents.** [AGENTS.md](AGENTS.md) sets the rules for AI coding agents (Claude Code loads it
  through [CLAUDE.md](CLAUDE.md)). They apply to human contributors too. <!-- process-wording: points at the coding agents' rules file -->

Before pushing, run `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:py`,
`npm run license-check` and `npx surfer license-check`.

### Claude Code plugin

The repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with one
plugin, `vimma-guardrails` (`tools/claude-plugin/`). Its hooks turn the costliest rules for coding
agents into checks that block the command before it runs, with a reason that says what to do
instead, because a written rule is only as good as the memory of whoever follows it. It also
ships the `vimma-pr` agent, which takes one pull request or issue to merge in its own worktree
and ends with a fixed report. <!-- process-wording: describes the plugin for coding agents -->

Install it from GitHub with auto-update on, so new and fixed hooks arrive without a reinstall. In
Claude Code, run `/plugin marketplace add vimma-browser/vimma`, then
`/plugin install vimma-guardrails@vimma`, and turn on auto-update under `/plugin` > Marketplaces >
`vimma` > Enable auto-update. The same setup as settings, for a checkout in `.claude/settings.json`
(git-ignored, so each checkout opts in) or for every project in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "vimma": {
      "source": { "source": "github", "repo": "vimma-browser/vimma" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "vimma-guardrails@vimma": true }
}
```

The plugin's manifest has no `version` field on purpose: Claude Code caches a plugin from a git
marketplace under its version and falls back to the commit SHA when none is set, so every commit
on `main` is a new version that auto-update picks up. A pinned version would keep everyone on the
cached copy until someone remembered to bump it.

To work on the plugin itself, point the marketplace at a local checkout instead:
`"source": { "source": "directory", "path": "/absolute/path/to/vimma" }`. A directory marketplace
is read in place, not copied to the cache, so `/reload-plugins` applies edits at once.
`claude plugin validate tools/claude-plugin` checks the manifests, and `npm test` runs the hooks'
tests (`tools/claude-plugin/test/`).

GitHub Copilot CLI installs the same plugin from the same marketplace: it reads
`.claude-plugin/marketplace.json` and `plugin.json`, runs Claude-format `PreToolUse` hooks with
Claude's tool names, and offers the agent as `vimma-guardrails:vimma-pr`. Install it with
`copilot plugin marketplace add vimma-browser/vimma` and
`copilot plugin install vimma-guardrails@vimma`, then turn on auto-update in
`~/.copilot/settings.json`. Copilot CLI honours `autoUpdate` only from user settings, not from a
repository's, and applies it at the start of each session in a trusted folder:

```json
{
  "extraKnownMarketplaces": {
    "vimma": {
      "source": { "source": "github", "repo": "vimma-browser/vimma" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "vimma-guardrails@vimma": true }
}
```

Copilot CLI records an install by a hash of its files, so here too every change on `main` is an
update without a version bump. `copilot plugin update vimma-guardrails@vimma` pulls one at once,
and `copilot --plugin-dir tools/claude-plugin` loads a local checkout's copy for one session.

What the hooks block, on every Bash command (including those inside `bash -c`, `eval`, `$(...)`
and pipelines, but not text that only mentions them, such as a commit message or a heredoc):

- **`gh pr merge`** without `--subject` and `--body-file <file>`, or with a body file that is
  missing or empty, or with a message that fails `npx commitlint`. The hook lints the exact
  squash message itself, so a merge can no longer run after a failed check: a command chained
  with `;` once merged a pull request with an empty message (#278), and unwrapped squash bodies
  turned `main` red. Merges through `gh api .../pulls/N/merge` are blocked too. Write the body
  file in an earlier command: the hook reads it before the command runs.
- **`pkill -f`**, **`pgrep -f ... | xargs kill`** and **`kill $(pgrep -f ...)`**: a pattern
  matched against whole command lines also matches the shell that runs it. Kill by exact PID.
- **Force pushes**: `--force`, `-f`, `--force-with-lease` and `+refspec`. Pushed history is never
  rewritten; update a branch with `git merge origin/main`.
- **Dismissing code-scanning, secret-scanning or Dependabot alerts** (`gh api` writes to
  `.../alerts/...`, and the same request through `curl`), and **`gh workflow disable`**: a check
  is made green by fixing the finding, never by switching it off.

And on Edit, Write and NotebookEdit: a **subagent** may not change files in a repository's
primary checkout (a working tree whose `.git` is a directory), because a dev build runs from it.
It works in a linked worktree under `.claude/worktrees/` instead. The main session is not
affected (Claude Code marks hook input from a subagent with `agent_id`), nor are the git-ignored
notes `TESTING.md`, `CURRENT-STATE.md` and `.claude/`. Bash commands that write files are not
checked: a shell command's targets cannot be read reliably without running it. Set
`VIMMA_GUARD_ALLOW_MAIN_CHECKOUT=1` in Claude Code's environment to turn this check off.

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
- **By hand.** Node in `.nvmrc` (see the bench baseline in [docs/runbook.md](docs/runbook.md)),
  with `@types/node`'s major, which follows it (Dependabot updates only its minor and patch),
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
- The nightly full build is live: `nightly.yml` builds `main` on a GitHub-hosted runner at
  03:00 UTC (about 2 hours) and runs the whole mochitest suite on it, `skip-if = ["artifact"]`
  tests included ([runbook](docs/runbook.md#full-builds-nightlyyml-releaseyml)). It sees a
  change only after the change has merged. `RELEASE_ENABLED` is set, but each
  release is a draft that runs no build until the maintainer publishes it
  ([runbook](docs/runbook.md#releases-release-pleaseyml)). PRs that touch patches, `configs/`,
  `moz.configure` or branding must report a full-build run
  ([ADR-010](docs/adr/010-pr-artifact-builds.md), [runbook](docs/runbook.md)).
- Nightly builds are not published as a release until the repository variable
  `NIGHTLY_RELEASE_ENABLED` is set: each one is a workflow artifact of its run, kept 7 days,
  with no release page or stable link. It is not private: the repository is public, so anyone
  signed in to GitHub can download it for those 7 days
  ([runbook](docs/runbook.md#full-builds-nightlyyml-releaseyml);
  [build-supply-chain](docs/specs/build-supply-chain.md), decision 23). With the variable set,
  each nightly also goes to the rolling `nightly` pre-release with a signed MAR and update
  manifest ([m6a-updater](docs/specs/m6a-updater.md), decisions 42 and 43).
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
- [ARCHITECTURE.md](ARCHITECTURE.md): how the code fits together.
- [docs/roadmap.md](docs/roadmap.md): the milestones and the risks.
- [docs/README.md](docs/README.md): the index of every document.
