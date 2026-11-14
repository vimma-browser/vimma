### Releases (`release-please.yml`)

[release-please](https://github.com/googleapis/release-please-action) (v5.0.0, pinned
by SHA) keeps one release PR open, `chore(main): release X.Y.Z`, updated on every push to `main`.
It holds the next version and that release's `CHANGELOG.md` entry, and opens as a draft
(`"draft-pull-request": true`). **Merging it is the release**:
release-please tags `vX.Y.Z` and creates the GitHub Release with the same notes, **as a draft**
(below). Its `release-build` job then starts `release.yml`, which builds, signs and uploads the
packages to that draft (below, "Release packages"). Publishing the finished draft is the
maintainer's one click.

- **Releasing, step by step:** mark the release PR ready for review (`gh pr ready <n>`, or
  "Ready for review" on the PR); that runs the mochitests, Semgrep and CodeQL, which its draft
  rebuilds skipped ("Draft pull requests" above). Merge it once every required check is green;
  the code scanning rule keeps it blocked until CodeQL has analyzed the final head. If `main`
  gets another merge first, release-please rebuilds the PR, which stays ready, and the full
  checks run again on the new head. release-please opens only new release PRs as drafts: to
  turn the open one into a draft, run `gh pr ready --undo <n>` (no run starts, and the results
  on its head stay as they are).
- **Version source:** `surfer.json` `brands.vimma.release.displayVersion`, the version
  `vimma --version` and the About dialog show (spec m0-app-version), and `vimma-ctl --version`
  too, since `tools/vimma-ctl/build.rs` reads it (spec ship-vimma-ctl). The release
  PR bumps it through `extra-files` (jsonpath `$.brands.vimma.release.displayVersion`), plus
  `.release-please-manifest.json`, which must always match it (tested in
  `tools/package/test/release-workflow.test.mjs`). The Firefox pin `version.version` is never
  touched; `upstream.yml` owns it. Release type `simple`: there is no root `version.txt`, so
  nothing else is written.
- **Bumps** (`release-please-config.json`, spec release-versioning): every release bumps the
  patch, whatever its commits are, breaking changes included (`"versioning":
"always-bump-patch"`): 0.1.1 → 0.1.2 → 0.1.3. The maintainer decides when to move to 0.2.0 or
  1.0.0 (below). Changelog sections: `feat` → Added, `fix` → Fixed; `perf`, `deps`, `upstream`
  and `revert` → Changed; `docs`, `test`, `build`, `ci`, `chore` and `refactor` are left out. A
  breaking change still gets its "BREAKING CHANGES" heading in the notes.
- **Moving to 0.2.0 (or 1.0.0), when you decide:** merge a PR whose squash commit ends with the
  footer `Release-As: 0.2.0`. Squash merges use the PR body as the commit body, so make that line
  the last paragraph of the PR body, on its own line, after the generated-by lines (any PR will
  do, such as the next small docs fix). release-please reads the footer before the versioning strategy, so the
  open release PR becomes `chore(main): release 0.2.0`; merge that. The footer applies once: the
  next release PR starts after the `v0.2.0` tag (which `force-tag-creation` creates even for a
  draft), so it no longer sees that commit, and patch bumps go on: 0.2.1, 0.2.2. **Use the
  footer, not `"release-as"` in the config.** The config option is applied before any commit is
  read, so it pins every later release PR to 0.2.0 until a second PR removes it; forget that,
  and every later release PR proposes 0.2.0 again. If the footer was not picked up (the release
  PR still shows the old next version), look at the squash commit's message on `main`:
  `Release-As:` must be in its last paragraph.
- **Every release starts as a draft.** `"draft": true` makes each GitHub Release a draft: only
  collaborators see it, and its download URLs answer 404 to everyone else. `release.yml` fills
  it with the packages while it is a draft, so a failed build is found before anything is public,
  and publishing it is one click on a release that already has its files. GitHub creates no tag
  for a draft, so `"force-tag-creation": true` makes release-please create `vX.Y.Z` first;
  without the tag, the next release PR would not find this release and would list every commit
  since the first one, and `release.yml` would have nothing to build. To ship a draft once its
  build is green: Releases → the draft → Edit → "Publish release". Publishing builds nothing;
  it starts `aur.yml`, which pushes the AUR package (below, "Release packages").
- **Keep drafts on, also once the release gate opens** (no public release until the maintainer
  has daily-driven Vimma). The gate is the click on "Publish release", not the config. Without
  `"draft"`, release-please would create a published release two hours before its files exist,
  and `aur.yml`, started by that publish, would fail on the missing files. A test keeps `draft`
  and `force-tag-creation` on.
- **The changelog line is the commit subject; the body explains why** (CONTRIBUTING.md). release-please
  writes subjects only. Firefox bumps are `upstream: firefox X.Y.Z (MFSA YYYY-N)` (upstream.yml),
  so a security dot release alone still produces a release PR (ADR-015: merged within 3 days).
- **A release shows the hand-written lines first, then release-please's list** (issue #529).
  `CHANGELOG.md` on `main` starts with `## [Unreleased]`, whose `- ` items under `### Added`,
  `### Changed`, `### Fixed` (or another Keep a Changelog heading) say what users see.
  release-please puts its new entry above that heading, so `tools/release/changelog.mjs` moves
  the items in two places:
  - `move`, in the `firefox-notes` job, on every rebuild of the release PR: each item goes into
    the same section of the new entry, above release-please's `* ` items (a section release-please
    did not write is added after its own), and an empty `## [Unreleased]` stays at the top. It is
    part of that job's one `chore(release)` commit, with the Firefox edit below.
    `"always-update": true` in `release-please-config.json` makes release-please rebuild the branch
    from `main` on every run, not only when its own notes change: without it, a merge that adds
    only a changelog line would leave the release PR with the old lines and a conflict with `main`
    on `CHANGELOG.md`.
  - `notes`, in the `release-title` job, when the release is created: release-please writes a
    release's notes from the release PR's body, which holds only its own list, so the job adds
    the hand-written items of that version's entry in the tag's `CHANGELOG.md`, above the list.
    The update steps and third-party notice `release.yml` adds later go around them.

  `npm run changelog-lint` (part of `npm run lint`) fails when `## [Unreleased]` is not the first
  `## ` heading, appears twice, or holds anything but those headings and `- ` items (an item may
  continue on lines indented by two spaces), since `move` refuses what it cannot carry whole.
  Check by hand: `node tools/release/changelog.mjs move CHANGELOG.md` on the release branch's file
  prints the edited file. The release PR's head without the `firefox-notes` commit fails CI's
  `changelog-lint` step, so it cannot be merged by hand or by auto-merge. If the job failed (a
  `move` error, or a 409 because release-please rebuilt the branch meanwhile), fix `[Unreleased]`
  on `main` if `move` named a line, then run release-please again: `gh workflow run
release-please.yml`. If `release-title` warns that a release's notes lack the hand-written
  lines, add them by hand: `node tools/release/changelog.mjs notes <notes.md> --changelog
CHANGELOG.md --version X.Y.Z` on the tag's checkout prints the notes to paste.

- **The Firefox version in titles and headings** (spec firefox-versions). release-please can only
  title a release `vX.Y.Z` and head its entry `## [X.Y.Z](compare) (date)`, so two jobs after it
  edit both with `tools/release/firefox-notes.mjs` (idempotent: a second pass changes nothing):
  - `firefox-notes`, on every run while the release PR is open: reads `CHANGELOG.md` and
    `surfer.json` from `release-please--branches--main` through the API, and when the newest
    heading lacks it, pushes one `chore(release)` commit that makes it
    `## [X.Y.Z](compare) · Firefox <version> (date)` and turns each bump line into
    `Firefox <version> ([MFSA YYYY-N](advisory))`. The push uses `RELEASE_PLEASE_TOKEN` (a
    `GITHUB_TOKEN` push would leave the release PR without required checks); without the token the
    job logs a notice and does nothing. release-please rebuilds the branch (dropping the commit)
    on every run, and the job then adds it back in the same run. The PR body keeps
    release-please's heading.
  - `release-title`, when a release was created: checks out its tag, titles it with
    `node tools/release/version-line.mjs` (`Vimma X.Y.Z · Firefox <version>`, which must start
    with the tag's version) and applies the same edit to its notes, through `GITHUB_TOKEN`
    (`contents: write`). It changes only the name and the notes; a draft stays a draft. The
    edit resends the tag it verified (`tag_name`): GitHub detaches a draft from its tag when an
    edit leaves `tag_name` out (it becomes `untagged-…`), and publishing that draft would create
    a new tag on `main`'s head and build that commit. The job fails if the edited release names
    any other tag. To reattach a detached draft (`gh release edit` cannot find it by tag), find
    its id with `gh api repos/vimma-browser/vimma/releases --jq '.[] | [.id, .tag_name]'` and run
    `gh api --method PATCH repos/vimma-browser/vimma/releases/<id> -f tag_name=vX.Y.Z`.

  Check either by hand: `node tools/release/firefox-notes.mjs CHANGELOG.md --surfer surfer.json`
  prints the edited file, and `node tools/release/version-line.mjs` the title.

- **First release (one-time).** No `v0.1.0` tag exists, and the manifest's `0.1.0` (what every
  build so far shows) counts as released, so the first release is **0.1.1**: the release PR
  `chore(main): release 0.1.1` on branch `release-please--branches--main` lists every
  `feat`/`fix` since the first commit and puts its entry above the hand-written
  `## [Unreleased]` section. Just before merging it, edit `CHANGELOG.md` on that branch: replace
  the generated `0.1.1` list with the `[Unreleased]` sections and delete that heading. The
  generated list also has a false "BREAKING CHANGES" item (cd70146's body has a line starting
  `BREAKING CHANGE:`). release-please rewrites the branch on every push to `main`, so make the
  edit last, on top of the `firefox-notes` commit (pull the branch first; keep the
  `· Firefox <version>` in the `0.1.1` heading). From then on every entry is generated.
- **A merged security bump releases itself** (`security-release`, spec firefox-versions,
  ADR-020), once `AUTO_SECURITY_RELEASE` is `true`. After a push to `main` that is the squash
  merge of the autopilot's `upstream/firefox-<version>` PR labelled `upstream` and `security`,
  `tools/release/security-release.mjs` sets the open release PR to auto-merge with
  `RELEASE_PLEASE_TOKEN`, pinned to its head commit (`--match-head-commit`), and comments on the
  bump PR. A draft release PR is first marked ready for review through the same token, since
  GitHub never merges a draft; that starts the full checks the draft skipped, and the job sets
  auto-merge only once the newest mochitest and Semgrep checks on the head are no longer the
  draft's skips (it polls the head's check runs for up to 3 minutes, and fails without setting
  auto-merge if they do not start; a person then merges the ready PR). GitHub merges it
  when the required checks pass; that merge's push starts this workflow again, which tags and
  creates the draft release and starts `release.yml`. Publishing the draft stays a click. Any other push logs a notice naming the check that did not hold (the run's
  summary), and the job never merges the first release PR (it requires an existing release).
  Commits merged after the bump and before the checks finish ship in the same release.
  `RELEASE_PLEASE_TOKEN` is required: with the variable on and no token, the job fails.
- **Names.** `include-component-in-tag` is off, so tags are `vX.Y.Z`, the branch is
  `release-please--branches--main` and the PR title `chore(main): release X.Y.Z`.

One-time setup:

1. Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create and
   approve pull requests" (the same setting as for upstream bumps).
2. Optional: the release PR, opened with `GITHUB_TOKEN`, triggers no CI until it is marked
   ready for review (by a person, so the event starts the workflows). Run
   `gh workflow run ci.yml --ref release-please--branches--main` before merging, or store a
   fine-grained token for this repo only (Contents, Pull requests and Issues: read/write) as
   `gh secret set RELEASE_PLEASE_TOKEN`; the workflow uses it when present.
3. Nothing more for the release build: tags and releases created with `GITHUB_TOKEN` trigger no
   workflows, but `release-build` starts `release.yml` with a `workflow_dispatch`, which
   `GITHUB_TOKEN` may send ([GitHub Docs, "Triggering a workflow from a
   workflow"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)),
   so `RELEASE_PLEASE_TOKEN` is not needed for it.

The release-please job's token has `contents`, `pull-requests` and `issues: write` (labels go
through the issues API); it runs no repository code. `firefox-notes` reads with `contents` and
`pull-requests: read` and writes only through `RELEASE_PLEASE_TOKEN`; `release-title` has
`contents: write` and nothing else. Both run only `main`'s `tools/release/` (the tag is a commit
on `main`), never code from the release branch, and keep no token in their checkout.
`security-release` has `contents: read` (it checks out `main`) and reads and merges only through
`RELEASE_PLEASE_TOKEN`.
`release-build` has `actions: write` and nothing else, runs no repository code, and only sends
the `workflow_dispatch` for `release.yml` on `main` with the new tag; it runs only when a release
was created and `RELEASE_ENABLED` is `true`.

Turning on security releases (`AUTO_SECURITY_RELEASE`), once, while releases are still drafts:

1. Check that `RELEASE_PLEASE_TOKEN` is set and unexpired (`gh secret list`), and that
   Settings → General → "Allow auto-merge" is on (`gh api repos/vimma-browser/vimma --jq
.allow_auto_merge` prints `true`).
2. `gh variable set AUTO_SECURITY_RELEASE --body true`.
3. Dry run, while `"draft": true` keeps everything private: open a PR from a branch named
   `upstream/firefox-<the version on main>` that changes only a comment, titled
   `upstream: firefox <that version>`, labelled `upstream` and `security`, and merge it. In that
   merge's `release-please` run, `security-release` should report the release PR set to
   auto-merge and comment on the PR; the release PR should then merge on its own once green,
   and a draft titled `Vimma 0.1.x · Firefox <version>` should appear. If the release PR waits
   for an approval instead (the ruleset's `require_extra_approval_for_unattributed_changes`),
   record it and turn the variable off until that is resolved. Afterwards delete the draft and
   its tag (`gh release delete v0.1.x --cleanup-tag`); the version moves on.
4. To stop the chain: `gh variable delete AUTO_SECURITY_RELEASE`, or for one release PR
   `gh pr merge --disable-auto <n>`.
