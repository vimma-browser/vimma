# Spec: m0-pipeline

Status: implemented · Milestone: M0 · Area: CI (`.github/workflows/`)

## User story

As the maintainer, every push is linted, typechecked and tested; nightlies build without me;
new Firefox releases arrive as PRs.

## Scope

- `ci.yml` (push + PR): `npm ci`, `npm run lint`, `npm run typecheck`, `npm run coverage`
  (90 % gate in `vitest.config.mjs`), commitlint over the PR range, licence check of
  `package-lock.json` (allowlist: MIT, ISC, BSD-2/3, Apache-2.0, MPL-2.0, PSF-2.0), and a custom
  commitlint rule: `feat`/`fix` require a non-empty body.
- `e2e.yml` (PR): skeleton job that runs only once the M0 build-strategy ADR picks
  UI-only vs artifact build; until then it is a no-op with a TODO naming the ADR. (ADR-010 and
  m0-build-strategy have since made it the artifact-build mochitest job.)
- `nightly.yml` (03:00 UTC): full Linux x86_64 build via Surfer on a large or self-hosted runner,
  publish rolling `nightly` release; on failure open an issue with logs. (Since changed: the
  nightly keeps its package as a 7-day workflow artifact and publishes no release until the
  release gate; spec build-supply-chain, decision 23.)
- `upstream.yml` (every 6 h): `tools/upstream/check-release.py` polls
  `https://product-details.mozilla.org/1.0/firefox_versions.json` (`LATEST_FIREFOX_VERSION`);
  on change, `bump-surfer-json.py` + PR `chore(upstream): Firefox X.Y`. (Since replaced by the
  upstream autopilot, spec m7-upstream-autopilot: `tools/upstream/detect.mjs` every 4 h.)
- `claude.yml`: `@claude` mentions; `spec` + `claude:go` labelled issues → draft PR. Scoped token.
- `renovate.json`: npm + GitHub Actions; automerge patch/minor after CI. (Since replaced by
  Dependabot: `.github/dependabot.yml` and `dependabot-automerge.yml`.)
- ~~Branch protection on `main`~~: dropped, see Settled.

## Tests (write first)

- `tools/upstream/test_check_release.py`: given a fixture JSON with a newer version, outputs it;
  same version → no output; malformed JSON → non-zero exit. (Removed with `check-release.py` when
  the upstream autopilot replaced it.)
- `bump-surfer-json.py`: fixture `surfer.json` in, expected out.
- A deliberately failing commit message (`feat: x` without body) is rejected by commitlint.

## Settled (2026-10-09)

- **No branch protection while the repository was private**, because GitHub refused it on a free
  private repository (`gh api …/branches/main/protection` → 403 "Upgrade to GitHub Pro"). Since
  the repository became public, the ruleset "main" protects it (`docs/runbook.md`, "Merging and
  branch protection"). No required approvals.
- **nightly.yml runs on a self-hosted runner** labelled `vimma-build` (22 GB `engine/`, 39 min
  build: too big for hosted runners). The schedule is gated by `vars.NIGHTLY_ENABLED == 'true'`;
  `workflow_dispatch` bypasses the gate so the runner can be tested first. `clean: false` keeps
  `engine/` between runs; Firefox is re-downloaded only when `surfer.json` changes. Full e2e on
  the nightly waits for the build-strategy ADR (TODO in the workflow). (Since changed: no self-hosted runner is used or planned; full builds move to GitHub-hosted runners with [#224](https://github.com/vimma-browser/vimma/issues/224), spec build-supply-chain decision 6.)
- **e2e.yml** was a no-op job naming the build-strategy ADR until `docs/adr/010-*` and
  m0-build-strategy.
- **claude.yml** follows anthropics/claude-code-action v1.0.247 (`examples/claude.yml`,
  `docs/setup.md`, `docs/security.md`), hardened as follows:
  - `github_token: github.token` on every job, so the job `permissions:` block is the token Claude
    gets (otherwise the action uses the Claude app's installation token with contents,
    pull-requests and issues write). The Claude app is not needed.
  - `mention` (`@claude`): only when `author_association` is OWNER, MEMBER or COLLABORATOR, on
    top of the action's own write-access check; contents read, so it answers and reviews but
    cannot push.
  - `spec`: only when `claude:go` is added by `github.repository_owner` to a `spec` issue, so a
    bot label (e.g. a `@claude` request to label an issue) cannot chain into it. Claude runs with
    contents read and a tool allowlist (file edits, named npm scripts, `git add/commit/diff/log/
status`, `gh issue view`); no `Bash(git:*)`, `Bash(node:*)`, `Bash(npm:*)`. Its commits leave
    as a patch artifact.
  - `spec-pr` (no Claude): `git am` with hooks off, force-push `claude/spec-<issue>`, draft PR
    labelled `bot`. GITHUB_TOKEN cannot change `.github/workflows`.
  - PRs opened with GITHUB_TOKEN (claude.yml, upstream.yml) do not trigger CI. ci.yml now also
    runs on `ready_for_review` and `workflow_dispatch`: the owner marks the draft ready (or runs
    `gh workflow run ci.yml --ref <branch>`). Accepts `ANTHROPIC_API_KEY` or
    `CLAUDE_CODE_OAUTH_TOKEN`; without either, steps skip and the run is green.
  - **Residual risk** (before the ruleset): with no branch protection, any job token with
    `contents: write` (`spec-pr`, upstream.yml, nightly.yml) could push to `main`. Mitigated by
    owner-only triggers and by never running Claude or Claude-written code with a write token.
    Tests Claude writes do run (`npm test`) on the read-only `spec` runner.
- **upstream.yml** needs no `npm ci` (Python stdlib scripts) to stay cheap. It does not run
  `surfer import` + build: that needs the self-hosted runner; the PR body says to, and the nightly
  does it after merge. It skips only when a PR for `upstream/firefox-X.Y` is open; a leftover
  branch from a failed or closed run is rebuilt and force-pushed, so failures are retried. The
  PR is a draft; marking it ready starts CI (optional `UPSTREAM_PR_TOKEN` secret instead).
- **Licence check is a small script**, not a dependency: `tools/license-check/license-check.mjs`
  (SPDX `AND`/`OR`, spec allowlist). At first, four permissive dev-only packages were outside the
  allowlist and listed with reasons in `tools/license-check/exceptions.json`, pinned to
  `name@version`: argparse (Python-2.0), minimatch (BlueOak-1.0.0), os-shim (MIT in its LICENSE,
  none in the lockfile), pako (MIT AND Zlib); later dependencies added more. Stale exceptions
  fail the check.
- **PSF-2.0 joined the allowlist**, under both its SPDX ids (`PSF-2.0`, and `Python-2.0`, the id
  SPDX retired in its favour). It is a permissive licence with no copyleft: it asks only for the
  copyright notice and a summary of changes in redistributed copies. Every argparse release had
  needed its own exception, although each was the same licence.
- **commitlint rule** `body-required-for-types` lives in `tools/commitlint/body-required.mjs` as
  a local plugin; every commit on `main` passes it. It applies to `feat`, `fix` and `revert`.
  Footers and trailers (`Closes #3`, `BREAKING CHANGE: …`, `Co-Authored-By: …`) do not count as
  a body. commitlint's default ignores skip every `Revert "…"` commit, so they are replaced
  (`defaultIgnores: false`, `ignores: [ignoreCommit]`): a git-style revert is linted unless it
  has a body, merges and fixup!/squash!/amend! stay ignored. Vitest now also runs `tools/**/test/`.
- **CI also runs** `npm run test:py` and `npx surfer license-check` (MPL headers, exits 1 on a
  missing header). Actions are pinned to commit SHAs; Dependabot keeps them pinned.
- **Renovate** (since replaced by Dependabot) used `platformAutomerge: false` so Renovate itself
  waited for green checks (with no branch protection, GitHub auto-merge had nothing to wait on).
  `@zen-browser/surfer`, majors and the whole `github-actions` manager never automerge
  (workflows hold write tokens and the Claude secret); `dependabot-automerge.yml` keeps that
  rule.
- **Self-hosted runner exposure:** any branch can add a workflow with `runs-on: vimma-build`.
  Runner groups (which could restrict it to nightly.yml) exist only for organisations, so the
  runbook said to keep the runner stopped outside the nightly window. (Since changed: no
  runner is registered and none will be, build-supply-chain decisions 6 and 7.)
- Workflow YAML is checked with actionlint v1.7.12 via `go run` (not installed, not a repo
  dependency); `.github/actionlint.yaml` declares the `vimma-build` runner label.

## Out of scope

Release workflow (M6), signing, AUR.
