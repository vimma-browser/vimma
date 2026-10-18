# Spec: firefox-versions

Status: implemented · Area: `tools/release/` (new: `version-line.mjs`, `firefox-notes.mjs`,
`security-release.mjs`), `.github/workflows/release-please.yml`, `nightly.yml`, `release.yml`,
`tools/upstream/autopilot-body.mjs`, `src/browser/branding/vimma/pref/firefox-branding.js`,
`docs/runbook.md`, `docs/security.md`, `docs/review-checklist.md`, `CONTRIBUTING.md` · Upstream
patches: `src/toolkit/xre/nsAppRunner-cpp.patch` (new; ADR-003 register line: "1 hunk, 11 lines:
`DumpVersion` prints `Vimma <version> · Firefox <version>` instead of `<vendor> <name> <version>`
(firefox-versions)") · ADR: ADR-020 (new, "A security release needs no person"), ADR-015 and
ADR-003 (register line)

Issues: [#220](https://github.com/vimma-browser/vimma/issues/220)

## Summary

Vimma keeps one SemVer version of its own and shows the Firefox version it is built on beside it,
in the same form everywhere: `Vimma 0.5.2 · Firefox 158.0`. This spec puts that line into
`vimma --version`, the GitHub Release title and the `CHANGELOG.md` heading, links each Firefox
bump to its Mozilla security advisory, and lets a merged Firefox security bump become a release
with no person in the loop. It also makes "`main` is always releasable" a tested rule, because an
automatic security release ships whatever else is on `main`.

## Problem

- Firefox ships a major version every four weeks and dot releases in between. A reader of a
  Vimma release cannot tell which Firefox it carries: the release is titled `v0.1.1`, the
  changelog heading is `## [0.1.1](…) (2026-10-13)` (release PR #127), and the Firefox bump's
  changelog line would read `firefox 158.0`, with no advisory.
- `vimma --version` prints `Vimma Vimma 0.1.0`: Firefox's `<vendor> <name> <version>` format with
  vendor and name both `Vimma` (m0-branding, Settled; `docs/limits.md`). It names no Firefox
  version, and the doubled name reads as a bug.
- A Firefox security release stops twice for a person: once to merge the bump PR and once to
  merge the release PR. `docs/security.md` G2 gives three days from Mozilla's release to a
  security dot release on `main`, but nothing gets it from `main` to users. The second stop adds
  delay and nothing a person can check that CI has not.
- A release cut from `main` while a feature is half-merged ships the half feature. With releases
  cut by hand this is avoided by timing; an automatic security release cannot wait.

## Behaviour

1. `vimma --version` (and `-v`) prints exactly one line, `Vimma <vimma> · Firefox <firefox>`,
   where `<vimma>` is `surfer.json` `brands.vimma.release.displayVersion` and `<firefox>` is
   `surfer.json` `version.version`. Example: `Vimma 0.5.2 · Firefox 158.0`. The separator is
   U+00B7 MIDDLE DOT with one space on each side.
2. The start page footer and `about:vimma`'s Version section keep showing both versions as they do
   today (start page: `Vimma 0.5.2 · Firefox 158.0`; about:vimma: a `Vimma` row and a `Firefox`
   row). Vimma has no status-bar version line, and this spec adds none.
3. Each GitHub Release is titled `Vimma <vimma> · Firefox <firefox>`, with `<firefox>` read from
   `surfer.json` at the release tag. Its tag stays `v<vimma>`.
4. Each release's `CHANGELOG.md` heading, and the same heading at the top of the GitHub Release
   notes, is `## [<vimma>](<compare link>) · Firefox <firefox> (<date>)`.
5. A Firefox bump is listed under **Changed** as `Firefox 158.0 (MFSA 2026-106)`, the advisory ID
   linked to Mozilla's advisory page. A bump with several advisories lists them all; a dot release
   without an advisory is `Firefox 157.0.2`.
6. The version never encodes Firefox's: every release bumps the patch version
   (`always-bump-patch`, spec release-versioning), a Firefox major included. The maintainer moves to
   `0.2.0` or `1.0.0` with a `Release-As` footer. This spec changes no bump rule.
7. When a pull request from the upstream autopilot labelled `security` is merged into `main`, and
   the repository variable `AUTO_SECURITY_RELEASE` is `true`, the open release PR is set to
   auto-merge. GitHub merges it when every required check is green; release-please then tags the
   release and creates it. No person acts between the bump's merge and the release.
8. Only that release PR is ever set to auto-merge by this mechanism, and only in the run started by
   the security bump's merge. No other PR, branch or event leads to an automatic merge.
9. While releases are drafts (the release gate, spec release-versioning), the automatic path
   produces a draft release and nothing public. The first release, which the runbook has a person
   edit by hand, is never merged automatically.
10. An unfinished feature lands behind a `vimma.feature.<name>` pref whose default is `false`; the
    sub-PR that finishes it removes the pref. Every `vimma.feature.*` default in
    `firefox-branding.js` is `false`.

## Research

Versions checked: Firefox 157.0.1 (the tree in `engine/`, `config/milestone.txt`);
release-please-action v5.0.0 at commit `45996ed1f6d02564a971a2fa1b5860e934307cf7` (the SHA
`release-please.yml` pins), whose `package-lock.json` locks release-please **17.6.0**;
release-please read at tag `v17.6.0` of `googleapis/release-please`; GitHub CLI 2.102.0; the repository's
settings and the `main` ruleset read through the GitHub API.

### Where both versions are shown today

| Surface                  | Shows                                      | Code                                                    | Test that pins it                                                                                    |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `vimma --version`        | `Vimma Vimma 0.1.0`                        | `nsAppRunner.cpp` `DumpVersion`                         | shell string checks only: `nightly.yml` Smoke check; `release.yml` `build` and `package` smoke steps |
| Start page footer        | `Vimma 0.1.0 · Firefox 157.0.1`            | `vimma/start/start.mjs`                                 | `browser_vimma_start_page.js` (`state.footer`)                                                       |
| about:vimma, Version     | `Vimma` and `Firefox` rows, build, channel | `vimma/about/AboutVimma.sys.mjs` `collect`, `about.mjs` | `browser_vimma_about.js`                                                                             |
| About dialog             | `0.1.0`                                    | Firefox's `aboutDialog.js`                              | `browser_vimma_app_version.js`                                                                       |
| Control socket `welcome` | `version: "0.1.0"`                         | `ctl/VimmaControl.sys.mjs`                              | `browser_vimma_control.js`                                                                           |
| Status bar               | no version                                 | (none: `vimma/ui/` has no version string)               | none                                                                                                 |
| GitHub Release title     | `v0.1.1`                                   | release-please `BaseStrategy.buildRelease`              | none                                                                                                 |

`tools/package/test/package.test.mjs` uses `Vimma Vimma 0.1.0` only as the output of a fake
binary. `docs/rebase.md` §4, `docs/runbook.md` "Smoke check", `docs/limits.md` and ADR-010's table
quote the same string.

### `--version` in Firefox 157.0.1

- `toolkit/xre/nsAppRunner.cpp:4480`: `CheckArg("v") || CheckArg("version")` calls `DumpVersion()`
  and exits, before profile selection and remoting.
- `toolkit/xre/nsAppRunner.cpp:2255-2269`: `DumpVersion` prints `gAppData->vendor` (if set),
  `gAppData->name`, then `MOZ_STRINGIFY(MOZ_APP_VERSION_DISPLAY)`, then `, <copyright>` if set.
  `DumpFullVersion` (`:2271`, `--full-version`) prints the same three plus both build IDs.
- `toolkit/xre/moz.build:198-207` defines `MOZ_APP_VERSION` for every file in `toolkit/xre` as a
  quoted string; `:233` defines `MOZ_APP_VERSION_DISPLAY` unquoted (hence `MOZ_STRINGIFY`).
- Spec m0-app-version makes `MOZ_APP_VERSION` the Firefox version (`surfer.json`
  `version.version`, through `--with-version-file-path`) and `MOZ_APP_VERSION_DISPLAY` Vimma's.
  `browser_vimma_app_version.js` checks that `appinfo.version` equals Gecko's
  `platformVersion`, so `MOZ_APP_VERSION` is the Firefox version of the tree being built.
- The vendor cannot simply be emptied: vendor and name form the Linux profile path (m0-branding,
  Settled), so an empty vendor would move every profile.
- ADR-010: an artifact build runs Mozilla's prebuilt `firefox` binary, so a C++ change is not in
  the PR mochitest build; `--version` there prints `Vimma Vimma 157.0.1` or `Mozilla Firefox …`.

### release-please 17.6.0

- **Release title.** `BaseStrategy.buildRelease` (`src/strategies/base.ts:708-714`) sets the
  release name to `v<version>` (or `<component>: v<version>`). The only option that touches it is
  `include-v-in-release-name`. Nothing puts other text in it.
- **`release-label`** (`src/manifest.ts:1423`, applied at `:1305-1316`) is the list of labels put
  on the merged release PR once tagged (default `autorelease: tagged`). It does not reach the
  release or its title.
- **`pull-request-title-pattern`** (`src/util/pull-request-title.ts`) knows `${scope}`,
  `${component}`, `${version}` and `${branch}` only. Its match pattern turns `${version}` into
  `v?(?<version>[0-9].*)`, which runs to the end of the title, so any text after the version is
  read back as part of it. It changes only the PR title, which is also the squash commit subject.
- **Changelog notes types.** `src/factories/changelog-notes-factory.ts` registers `default` and
  `github` only. The `default` notes take `headerPartial`/`mainTemplate` from the strategy
  options, and only the `ruby-yoshi` strategy sets them (`src/strategies/ruby-yoshi.ts:51-59`); no
  config key reaches them. A custom type needs `registerChangelogNotes`, a library call that the
  action does not expose.
- **`pull-request-header` / `pull-request-footer`** are fixed strings.
- **Release notes** come from the merged release PR's body (`src/util/pull-request-body.ts`,
  `extractSingleRelease`), whose first line is the heading, matched by
  `/^#{2,} \[?(?<version>\d+\.\d+\.\d+[^\]]*)\]?/`. A heading `## [0.5.2](…) · Firefox 158.0 (…)`
  still yields `0.5.2`.
- **`CHANGELOG.md`** is updated by `src/updaters/changelog.ts`, which inserts the new entry before
  the first match of `\n###? v?[0-9[]`. `## [0.5.2](…) · Firefox 158.0 (…)` still matches, so a
  rewritten heading does not disturb the next entry.
- **Finding the last release** (`src/manifest.ts:553-583`) parses `release.tagName` only, never
  the release name, so a renamed release is still found.
- **Updating the release PR.** `Manifest.maybeUpdateExistingPullRequest` (`src/manifest.ts:1091`)
  pushes nothing when the PR body is unchanged; otherwise `GitHub.updatePullRequest`
  (`src/github.ts:770-813`) rebuilds the branch from `main` and pushes it with `force: true`,
  dropping any commit added to the branch since.
- **Action outputs** (`release-please-action` `src/index.ts:180-224`): `release_created`,
  `tag_name`, `body` and the other release fields when a release was created; `prs_created` and
  `pr` only when a PR was created or updated in that run.
- `release-please-config.json`'s `$schema` points at the v17.11.2 schema while the action runs
  17.6.0. Every option in the file exists in both; the mismatch is noted, not changed here.

### Commit subjects and the advisory

- `tools/upstream/autopilot-body.mjs` `prTitle` gives bump PRs the title `upstream: firefox
<version>` (#186: `upstream: firefox 158.0`). A squash merge makes the title the commit subject,
  which is the changelog line (CONTRIBUTING.md).
- `commitlint` 21.2.3 with `@commitlint/config-conventional` rejects `upstream: Firefox 158.0 (MFSA
2026-106)` (subject-case) and accepts `upstream: firefox 158.0 (MFSA 2026-106)` (checked with
  `npx commitlint`). A Markdown link in the subject would pass 100 characters with one advisory.
- `tools/upstream/releases.mjs` already reads each advisory's ID and URL
  (`https://www.mozilla.org/en-US/security/advisories/mfsaYYYY-N/`) from Mozilla's MFSA index.

### GitHub

- Repository settings (API, `GET /repos/vimma-browser/vimma`): `allow_auto_merge` true, squash only.
- `main` ruleset 24842084: PR required with 0 approvals, squash only, required checks `lint,
typecheck, test, commitlint, licences`, `semgrep (…)`, `CodeQL (javascript-typescript)`,
  `CodeQL (rust)`, `mochitest (artifact build)`; CodeQL code-scanning gate; no bypass actors. It
  also has `require_extra_approval_for_unattributed_changes: true`, whose effect on an
  auto-merged PR was not verified; sub-PR 4 checks it in its dry run.
- Events caused by `GITHUB_TOKEN` start no workflow runs (GitHub Actions documentation, "Triggering
  a workflow from a workflow"; `docs/runbook.md` "Releases" relies on it today). So a release PR
  merged with `GITHUB_TOKEN` would not start `release-please.yml` on `main`, no release would be
  created, and a commit pushed to the release branch with it would get no required checks.
- `gh pr merge --auto --squash --match-head-commit <sha>` (GitHub CLI 2.102.0) enables auto-merge
  only if the PR's head is that commit.
- The repository already enables auto-merge for some Dependabot PRs
  (`.github/workflows/dependabot-automerge.yml`), behind the same required checks.

## Design

### The version line

1. **`--version` comes from a one-hunk patch to `DumpVersion`**, which prints
   `printf("%s %s \xC2\xB7 Firefox %s", gAppData->name, MOZ_STRINGIFY(MOZ_APP_VERSION_DISPLAY),
MOZ_APP_VERSION)` and keeps the copyright suffix. Both macros are already defined for the file,
   so no `moz.build` change follows. The middle dot is written as its UTF-8 bytes so the output
   does not depend on the compiler's execution character set. Rejected: an empty vendor (moves
   profiles); putting Firefox's version into `MOZ_APP_VERSION_DISPLAY` (it would reach the About
   dialog, package metadata and Glean, and `tools/version-files` requires SemVer there); a
   launcher script (the tarball and the AppImage run the binary directly). `--full-version` keeps
   Firefox's format, because it exists for build forensics and a second hunk would double the
   patch; `docs/limits.md` says so.
2. **`MOZ_APP_VERSION` is the Firefox number**, not `GRE_MILESTONE`, so `--version` agrees with
   `Services.appinfo.version`, which the start page and about:vimma show. The two are equal on a
   Firefox release (m0-app-version's test).
3. **One function writes the line for scripts.** `tools/release/version-line.mjs` exports
   `versionLine(surferJson)` → `Vimma 0.5.2 · Firefox 158.0`, throwing on a missing or malformed
   version (it reuses `tools/version-files`' patterns). `nightly.yml` and `release.yml` compare the
   binary's output with it; the release title uses it. The string is defined once in JavaScript
   and once in C++, and the full-build mochitest holds the two together.
4. **No status-bar version line is added.** The status bar shows state that changes while
   browsing; the version is one keypress away in about:vimma. The About dialog keeps Vimma's
   version only (m0-app-version, Out of scope), because Firefox's dialog has a single version
   slot and changing it needs a hunk in `aboutDialog.js`.

### Release title, changelog heading and advisory links

5. **release-please cannot do this through configuration** (Research): the release name is fixed
   to `v<version>`, and the heading template is not configurable. A post-step in
   `release-please.yml` does it, with the action left as it is. Rejected: running release-please
   as a library with a registered notes type (replaces a pinned action with our own runner holding
   a write token); `pull-request-title-pattern` (only the PR title, and the parser would swallow
   any suffix); a fork of the action.
6. **One pure module, two callers.** `tools/release/firefox-notes.mjs` exports
   `firefoxNotes(markdown, { firefox })`, which (a) inserts ` · Firefox <firefox>` after the
   compare link of the first `## [x.y.z]` heading, unless it is already there, and (b) rewrites
   `upstream` lines of the form `firefox <v> (MFSA a, MFSA b)` into `Firefox <v> ([MFSA a](url),
[MFSA b](url))`. It is idempotent: applied twice, it changes nothing the second time. It touches
   nothing outside the newest entry.
7. **The release PR side** (job `firefox-notes`, after `release-please`, whenever a release PR is
   open): it reads `CHANGELOG.md` and `surfer.json` from the release branch
   `release-please--branches--main` as data, applies `firefoxNotes`, and, when that changes the
   file, pushes one commit, `chore(release): firefox <firefox> in the changelog heading`, with
   `RELEASE_PLEASE_TOKEN`. The PR body is left alone, so release-please's body comparison still
   finds it unchanged and does not force-push again until `main` changes the notes; then the job
   re-applies the edit in the same run. Without `RELEASE_PLEASE_TOKEN` the job does nothing and
   logs a notice, because a `GITHUB_TOKEN` push would leave the new head without required checks.
8. **The release side** (job `release-title`, when `release_created` is true): it checks out the
   tag, computes `versionLine` from that `surfer.json`, reads the release body, applies
   `firefoxNotes`, and sets the name and body with `PATCH /repos/{owner}/{repo}/releases/{id}`
   (`gh api`) with `GITHUB_TOKEN` (`contents: write`). The ID is the action's `id` output, so the
   edit reaches exactly the release release-please created; the job first checks that its tag is
   `tag_name` and that the title starts with `Vimma <tag version> · `. Editing fires `release: edited`, which starts nothing. It transforms the
   body that is there rather than writing a fresh one, so it never removes text another job added.
   `release.yml`'s `publish` job, which appends the third-party notice the same way, starts after a
   build of 40 minutes or more, long after this job's few seconds.
9. **Bump subjects carry the advisories.** `prTitle` becomes `upstream: firefox <version>` followed
   by ` (MFSA a, MFSA b)` when the detection lists advisories. The subject stays lowercase for
   commitlint; `firefoxNotes` writes the capital and the links. A bump whose advisories could not be
   read (G3) has no MFSA in its title and is still labelled `security`.
10. **Heading format.** `## [0.5.2](compare) · Firefox 158.0 (2026-10-20)` keeps release-please's
    compare link and date, which readers of the entries so far already see; the Firefox version
    sits between them, where it reads as part of the version.

### Security releases without a person

11. **The trigger is the bump's merge into `main`.** `release-please.yml` already runs on every
    push to `main`, so a new job `security-release` runs after `release-please` and
    `firefox-notes` in that same run. Rejected: auto-merging in `upstream.yml` (it runs before the
    merge); `workflow_run` chains (harder to reason about and to test); creating a release without
    the release PR (no version bump, no changelog).
12. **What it checks, all of which must hold** (pure function `decide()` in
    `tools/release/security-release.mjs`, given the API responses):
    - the variable `AUTO_SECURITY_RELEASE` is `true`, the repository is `vimma-browser/vimma`, the event
      is `push` and the ref `refs/heads/main`;
    - the pushed commit's subject starts `upstream: firefox ` and the commit belongs to exactly one
      merged PR (`GET /repos/{repo}/commits/{sha}/pulls`) whose base is `main`, whose head branch is
      `upstream/firefox-<version>` in this repository, and which carries the labels `upstream` and
      `security`;
    - exactly one open PR has head `release-please--branches--main`, base `main`, the label
      `autorelease: pending`, a title matching `^chore\(main\): release \d+\.\d+\.\d+$` and the
      author that `RELEASE_PLEASE_TOKEN` authenticates as;
    - that PR's head contains the pushed commit (the compare API reports `ahead` or `identical`);
    - at least one GitHub Release already exists, draft or published, so the first release, which
      `docs/runbook.md` has a person edit before merging, is never merged automatically.
13. **What it does.** `gh pr merge <n> --auto --squash --match-head-commit <head>` with
    `RELEASE_PLEASE_TOKEN`, then a comment on the bump PR linking the release PR. The merge is made
    as the token's user, so the push to `main` starts `release-please.yml`, which tags and creates
    the release; once drafts are off, the release's `published` event starts `release.yml`
    (runbook "Release packages"). Required checks still gate the merge. If any check above fails,
    the job exits green with a notice naming the check, except a missing `RELEASE_PLEASE_TOKEN`
    while the variable is on, which fails the job.
14. **The release carries what is on `main`.** Commits merged after the bump and before the checks
    finish are included, because release-please rebuilds the PR and the token's pushes keep
    auto-merge on. This is the intended behaviour (decision 16), not a race to close.
15. **The switch.** `AUTO_SECURITY_RELEASE` stays unset until the first release (0.1.1) has been
    cut by hand as a draft; it is turned on then, so the next Firefox security release proves the
    chain on drafts. Turning it on before the release gate opens is safe, because releases are
    still drafts (behaviour 9) and the path publishes nothing, and the exit test is then met
    before anyone depends on it. Rejected: waiting for the release gate (the chain would first run
    on a public release). Turning it off, or `gh pr merge --disable-auto <n>`, stops the chain.

### `main` stays releasable

16. Releases come from `main` only: `release-please.yml` runs on `main`, and every job in
    `release.yml` already requires a release event or `main`. A feature that spans several PRs
    lands behind `pref("vimma.feature.<name>", false)` in `firefox-branding.js`; its tests turn the
    pref on; the sub-PR that completes it removes the pref and the checks of it. A vitest fails
    when any `vimma.feature.*` default is not `false`. `docs/review-checklist.md` and
    `CONTRIBUTING.md` state the rule. Rejected: maintenance branches before `1.0.0` (one more line
    to bump on every Firefox release, for no user who needs it yet).

### Ownership and credentials

17. **This spec owns the release half; spec upstream-bump-automation owns the bump half.** The
    job in decisions 11 to 15 releases whatever is on `main` after a merged security bump.
    Auto-merging a green bump PR belongs to upstream-bump-automation, under its variable
    `AUTO_MERGE_UPSTREAM`; m6a-updater adds no auto-merge rule of its own (its decision 3).
    Releasing whatever is on `main` follows from releasing from `main` only
    (decision 16). Separate variables let the release half be proven on drafts before bumps merge
    themselves. Rejected: m6a-updater owning both halves and auto-merging the release PR only
    when every entry in it is an `upstream:` line (a security fix would wait for a person
    whenever any feature had merged since the last release).
18. **The existing `RELEASE_PLEASE_TOKEN` makes the merge.** It is a fine-grained personal token,
    so merges appear as the maintainer and it expires. Vimma moves to a GitHub App installation
    token (short-lived, belonging to no person) when a second maintainer joins or the token's
    expiry first breaks a release. Rejected for now: an App today (an App, its private key as a
    secret and a token step, for one maintainer).
19. **G2 keeps measuring the Firefox on `main` while releases are drafts.** Once drafts are turned
    off, what users run is the latest release, and G2's deadline is measured against it. That
    change is a follow-up to m7-upstream-autopilot, not part of this spec, because before then
    every security bump would fail the drift check: drafts are not releases users get.

### What is not changed

- Bump rules: `always-bump-patch` and `Release-As` stay as spec release-versioning has them.
- The update manifest (spec m6a-updater, PR #143) already carries both versions: `appVersion` is
  Firefox's and `displayVersion` Vimma's, and its `vimmaUrgency="security"` comes from the same
  `security` classification. This spec adds nothing to it.
- The control protocol's `welcome` keeps one `version` field (a protocol change for no client
  need).

## Security and privacy

- **New capability.** A merged PR can now cause a release without a person. Only pushes to `main`
  can start it, and `main` accepts only squash merges of PRs that pass the required checks
  (ruleset 24842084). Anyone who can merge to `main` can already have it released, so the job
  removes a wait, not a check.
- **Spoofing the trigger.** Labels can be set only by collaborators with triage access or more;
  the job also requires the autopilot's branch name in this repository and the `upstream: firefox`
  subject. A fork cannot push to `main` or start this workflow with secrets.
- **Nothing else is auto-merged.** The target PR is identified by branch, base, label, title
  pattern and author, and pinned to the head commit that contains the bump (decision 12). The job
  never merges directly; GitHub merges only when the ruleset is satisfied.
- **Tokens.** `RELEASE_PLEASE_TOKEN` is the existing fine-grained token (this repository only;
  Contents, Pull requests and Issues read/write); no new scope. It is passed only to the steps
  that call `gh` or push the changelog commit. The jobs run code only from the pushed `main`
  commit, never from a PR branch; the release branch is read as data. `release-title` uses
  `GITHUB_TOKEN` with `contents: write` and nothing else. Every job grants nothing by default
  (`permissions: {}`), and every action stays pinned by SHA.
- **What ships.** A security release can carry features merged since the last release; decision 16
  keeps unfinished ones off by default. Signing, SBOM and smoke checks in `release.yml` are
  unchanged.
- **Privacy.** No new data leaves anyone's machine. `--version` reads compiled-in constants.

New guarantees for `docs/security.md` §10 (Since changed: numbered G11 and G12 there, because
G9 and G10 were taken by the Beta canary before this spec's sub-PR 4 merged):

- G9. A merged `upstream` PR labelled `security` **must** set the release PR to auto-merge in the
  same `release-please.yml` run when `AUTO_SECURITY_RELEASE` is on, and **never** any other PR.
- G10. The automatic path **must never** merge the first release PR, and **must** stop when the
  variable is unset.

## Tests

Written first and seen to fail.

**vitest, `tools/release/test/version-line.test.mjs`**

- `versionLine gives "Vimma 0.5.2 · Firefox 158.0" from surfer.json`
- `versionLine throws on a missing or non-SemVer display version or a malformed Firefox version`

**vitest, `tools/release/test/firefox-notes.test.mjs`**

- `adds the Firefox version after the compare link of the newest heading`
- `leaves older headings and [Unreleased] alone`
- `is idempotent: a second pass changes nothing`
- `links each MFSA ID in an upstream line and capitalises Firefox`
- `leaves a bump without an advisory as "Firefox 157.0.2"`
- `keeps text appended below the notes (the third-party notice)`
- `the rewritten heading still matches release-please 17.6.0's heading patterns` (both regexes,
  copied with their source line)

**vitest, `tools/release/test/security-release.test.mjs`** (`decide()` on recorded API fixtures)

- `auto-merges the release PR after a merged security bump`
- `does nothing when AUTO_SECURITY_RELEASE is off`
- `does nothing for an upstream bump without the security label`
- `does nothing for a security-labelled PR from another branch or a fork`
- `does nothing for a commit whose subject is not an upstream bump`
- `refuses a release PR with another author, branch, base, label or title`
- `refuses when the release PR does not contain the bump commit`
- `refuses before the first release exists`
- `pins the merge to the release PR's head commit`
- `fails when the variable is on and RELEASE_PLEASE_TOKEN is missing`

**vitest, workflow tests** (`tools/package/test/release-workflow.test.mjs`)

- `release-please.yml grants nothing by default and each job only what it needs`
- `only release-title holds contents: write from GITHUB_TOKEN besides release-please` (the
  release-please job keeps the scopes it has today)
- `security-release runs only on a push to main of vimma-browser/vimma`
- `no job runs on pull_request or pull_request_target`
- `nightly and release smoke checks compare --version with versionLine`
- `every action is pinned by a full commit SHA`

**vitest, `tools/upstream/test/autopilot.test.mjs`**

- `the PR title lists the advisories: "upstream: firefox 158.0 (MFSA 2026-106)"`
- `the PR title passes commitlint with zero, one and three advisories`

**vitest, `tools/test/feature-prefs.test.mjs`**

- `every vimma.feature.* pref defaults to false`

**mochitest, `tests/browser/browser_vimma_version_line.js`** (`skip-if = ["artifact"]`: the C++
patch is only in a full build, ADR-010)

- `test_version_flag_prints_vimma_and_firefox`: runs the app binary with `--version` through
  `Subprocess.sys.mjs` and expects `Vimma ${MOZ_APP_VERSION_DISPLAY} · Firefox
${Services.appinfo.version}\n`.

**Workflow smoke checks** (`nightly.yml` Smoke check; `release.yml` `build` and `package`): the
expected string becomes `versionLine(surfer.json)` instead of `Vimma Vimma <version>`.

**Dry run** (sub-PR 4, recorded in its PR): with the variable on and drafts on, a throwaway
`upstream/firefox-*` PR labelled `security` that changes only a comment is merged; the release PR
gets auto-merge, merges when green, and a draft release titled `Vimma 0.1.x · Firefox 157.0.1`
appears. The draft and its tag are deleted afterwards, and the version moves on.

## Docs and changelog

- `docs/guide.md` "Privacy defaults": `vimma --version` prints `Vimma 0.5.2 · Firefox 158.0`;
  "Installing": release titles name both versions.
- `docs/runbook.md`: "Smoke check" (the new line); "Releases" (the `firefox-notes` and
  `release-title` jobs, `AUTO_SECURITY_RELEASE`, when to turn it on and off, and that
  `RELEASE_PLEASE_TOKEN` is required for it); "Upstream bumps" (the bump title with advisories).
- `docs/rebase.md` §4: the expected `--version` output.
- `docs/limits.md`: drop the `Vimma Vimma` line; add that `--full-version` keeps Firefox's
  `<vendor> <name> <version>` format.
- `docs/security.md` §10: G9 and G10 with their tests; the "a person reviews and merges" paragraph
  says a person still merges every bump, and a security bump's release follows on its own.
- `docs/adr/020-security-release-without-a-person.md` (decisions 11 to 15, 17 and 18) and
  ADR-015's Consequences pointing to it; ADR-003 register: the new patch's line.
- `docs/review-checklist.md`, `CONTRIBUTING.md`: the `vimma.feature.*` rule.
- README: no feature-list change.
- `CHANGELOG.md` [Unreleased], Changed: "`vimma --version` prints `Vimma 0.1.0 · Firefox
157.0.1`, Vimma's version and the Firefox release it is built on, instead of `Vimma Vimma
0.1.0`." The [Unreleased] Added line that quotes `Vimma Vimma 0.1.0` is updated with it.

## Delivery

1. `fix(branding): vimma --version names vimma once and the firefox it is built on`:
   `nsAppRunner-cpp.patch`, ADR-003 register line, `version-line.mjs` and its tests, the
   full-build mochitest, the three smoke checks, the docs that quote `--version`.
2. `ci(release): firefox version in release titles and changelog headings`: `firefox-notes.mjs`,
   the `firefox-notes` and `release-title` jobs, the bump title with advisories, their tests,
   runbook.
3. `docs(contributing): unfinished features land behind a pref that defaults off`: the
   `vimma.feature.*` rule, its vitest, the review checklist.
4. `ci(release): a merged firefox security bump releases itself`: `security-release.mjs`, the job
   (variable unset), ADR-020, G9 and G10, runbook, the dry run.

Each is independently mergeable; 4 depends on 2 only for the job order in `release-please.yml`.

## Open questions

None.
