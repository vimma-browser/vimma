### Merging and branch protection

`main` is protected by the repository ruleset "main" (`gh api repos/vimma-browser/vimma/rulesets`):
changes land through a squash-merged pull request only, with no force-push or deletion, and
these status checks must pass:

- `lint, typecheck, test, commitlint, licences` (ci.yml)
- `mochitest (artifact build)` (e2e.yml)
- `semgrep (javascript, typescript, rust, secrets, github-actions)` (semgrep.yml)
- `CodeQL (javascript-typescript)` and `CodeQL (rust)` (codeql.yml)

`mochitest (artifact build, macOS)` (e2e.yml) is deliberately not in this list ("macOS
mochitests" below).

The ruleset also requires CodeQL code scanning results without errors or high-severity alerts.
`vimma-ctl on macOS` (ci.yml, spec macos-build, sub-PR 2) runs vimma-ctl's clippy and tests on
`macos-15` and is informational: it is not in the ruleset, so a red run shows on the pull
request without blocking it.
A required check whose workflow never starts stays pending and blocks the merge, so none of
these workflows has a `paths` filter; a job or step skipped by `if:` reports success instead
(next section).

**Actions settings.** Two repository settings back the workflow tests, which cannot read them
with a workflow token (docs/security/14-build-and-release-supply-chain.md, B5; spec build-supply-chain, decisions 7 and 19):

- Fork pull request approval stays `all_external_contributors`, so a fork's own workflow files run
  only once a person approves the run. Check:
  `gh api repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`.
- `sha_pinning_required` makes GitHub refuse any action not pinned to a full commit SHA, in every
  workflow, a fork's included. Every workflow already pins by SHA. An administrator turns it on
  once:
  `gh api -X PUT repos/vimma-browser/vimma/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true`,
  and checks it with `gh api repos/vimma-browser/vimma/actions/permissions`.
- The Homebrew tap takes the same two settings ("Release packages", step 7).

An organization owner also confirms that the organization has no self-hosted runner:
`gh api orgs/vimma-browser/actions/runners` must report `total_count` 0. A runner registered at
the organization and shared with this repository through a runner group would not show in the
repository's own runner list, and the workflow test only proves no workflow asks for one.

**Residual risk:** any job token with `contents: write` (`spec-pr` in claude.yml, upstream.yml,
nightly.yml, release-please.yml) can push branches and tags; the ruleset has no bypass actors, so
none of them can push to `main` itself. Mitigations: those jobs never run code the agent wrote
with that token (claude.yml's agent job is read-only), the agent runs only for the owner
(`claude:go` added by the owner; `@claude` from owner/member/collaborator), and GitHub Actions
minutes and logs show every push. Check `git log origin/main` if anything looks off.
