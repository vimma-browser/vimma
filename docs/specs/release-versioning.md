# Spec: release-versioning

Status: implemented · Area: CI (`release-please-config.json`, `docs/runbook.md` "Releases",
`tools/package/test/release-workflow.test.mjs`). No upstream patch, no app code.

## Goal

Releases count up by the patch version: 0.1.1, 0.1.2, 0.1.3 and so on.

## User stories

- As the maintainer, every release bumps the patch version, whatever its commits are, breaking
  changes included: 0.1.1 → 0.1.2 → 0.1.3. I move to 0.2.0 (or 1.0.0) myself when I choose,
  with one `Release-As` footer; patch bumps go on from there (0.2.1, 0.2.2).
- As the maintainer, merging a release PR before I have daily-driven Vimma publishes nothing:
  release-please makes a **draft** GitHub Release that only collaborators see, and the tag
  `vX.Y.Z`. `release.yml` does not run for a draft. When the release gate opens, I publish the
  draft (or turn drafts off), and the release goes out as before. (Since changed: `release.yml`
  now builds and uploads to the draft, started by `release-please.yml`'s `release-build` job,
  and drafts stay on after the gate opens; docs/runbook.md, "Releases".)
- As the maintainer, no one-off setting pins every future release to one version.

## Research (release-please 17.6.0, bundled in release-please-action v5.0.0, pinned by SHA)

- `"versioning": "always-bump-patch"` (schema: "Versioning strategy"; `customizing.md` lists
  `always-bump-patch`) is in 17.6.0's `versioningTypes`. `AlwaysBumpPatch.determineReleaseType`
  returns a patch bump for any commits, breaking ones too. It replaces the pair below, which it
  would override anyway. A `Release-As` footer still wins: `BaseStrategy.buildNewVersion` checks
  for it before calling the versioning strategy.
- Rejected alternative: `bump-patch-for-minor-pre-major` is in the v17 schema ("Feature changes only
  bump semver patch if version < 1.0.0"). In `DefaultVersioningStrategy.determineReleaseType`:
  breaking → minor when `bump-minor-pre-major` and pre-1.0; else `feat` → patch when
  `bump-patch-for-minor-pre-major` and pre-1.0; else patch. So with both on, `feat` and `fix` bump
  the patch and a breaking change the minor. It was rejected because a breaking change would then
  move to 0.2.0 on its own, while the move to a new minor is meant to be a deliberate choice.
- `release-as` (schema: deprecated) is returned by `buildNewVersion` before any commit is
  looked at, so while it is set every release PR proposes that version again. It goes.
- `draft` ("Create the GitHub release in draft mode") is in the schema. GitHub creates no git tag
  for a draft until it is published. release-please finds its last release through the
  releases API, skipping releases without a tag commit, then through tags; with neither, it bumps
  the manifest version but lists every commit since the start of history. `force-tag-creation`
  (in the schema, and in 17.6.0's `createRelease`: it creates `refs/tags/vX.Y.Z` before the
  release) closes that gap, so it is on with `draft`.
- `release.yml` runs on `release: published` only. GitHub fires no `published` for a draft, and
  no workflow for the `created`/`edited`/`deleted` events of a draft. The tag is created with
  the release-please token through the API; no workflow here runs on tag pushes. (Since changed:
  `release.yml` starts only by `workflow_dispatch`, and `release: published` starts `aur.yml` on
  `main` by `workflow_dispatch`;
  docs/runbook.md, "Release packages".)

## Scope

- `release-please-config.json`: `"versioning": "always-bump-patch"` in place of
  `bump-minor-pre-major`; add `draft` and `force-tag-creation` (both `true`); remove
  `"release-as"`.
- Tests (vitest, `tools/package/test/release-workflow.test.mjs`): the config has those options,
  no `bump-*-pre-major` and no `release-as`; the manifest matches `surfer.json`'s
  `displayVersion`; `release.yml` has only the `published` release type.
- Runbook "Releases": bumps, moving to 0.2.0, drafts, the first release, and how to switch drafts
  off when the gate opens.

## Moving to 0.2.0

A commit on `main` with the footer `Release-As: 0.2.0` (squash merges take the PR body, so it is
the last paragraph of a PR body). It applies once: after the `v0.2.0` tag, release PRs no longer
see that commit. A one-off `"release-as"` in the config would also work, but it pins every later
release PR until a second PR removes it, so the footer is the safer of the two. The footer
depends on the tag existing, which `force-tag-creation` guarantees for drafts too.

## The first release

No `v0.1.0` tag exists. The manifest's `0.1.0` is what every build so far shows, so
release-please treats it as released and the first release is **0.1.1**; its changelog lists
every `feat`/`fix` since the first commit. The release PR #127, opened as
`chore(main): release 0.1.0`, was rewritten on the next push to `main` after this change merged:
`chore(main): release 0.1.1`, same branch and number.

## Decided questions

- Breaking changes bump the patch like everything else, so the move to a new minor is a
  deliberate choice: the maintainer moves to 0.2.0 or 1.0.0 with a `Release-As` footer.
- The first release is 0.1.1, which is what release-please proposes on its own, since the dev
  builds already say 0.1.0. No footer is needed.
