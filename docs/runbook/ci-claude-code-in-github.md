### Claude Code in GitHub (`claude.yml`)

Follows `anthropics/claude-code-action` v1. Until a secret exists every run is green and skips
all work with a notice.

1. Add one secret: `gh secret set ANTHROPIC_API_KEY`, or with a Pro/Max plan run
   `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN`. The Claude GitHub app is
   not needed: the workflow passes the job's own `GITHUB_TOKEN` (`github_token` input).
2. Create the labels: `gh label create spec`, `gh label create claude:go`
   (`bot`, `upstream`, `security`, `nightly-failure` are created by the workflows).
   Tick "Allow GitHub Actions to create and approve pull requests" (see Upstream bumps).
3. Use `@claude` in an issue, comment or review (only from the owner, members or collaborators).
   Claude answers, reviews and comments; it cannot push in this mode.
4. For code: add `claude:go` to a `spec` issue yourself (the job checks that the label was added
   by the maintainer, `MAINTAINER` in `tools/repo.ts`, so a bot or a `@claude` request cannot chain into it). Claude
   implements and commits on a runner with a read-only token; a separate job without Claude
   applies the patch, pushes `claude/spec-<issue>` and opens a draft PR labelled `bot`.
5. CI does not start on that PR by itself (GITHUB_TOKEN PRs trigger no workflows): mark it ready
   for review, or `gh workflow run ci.yml --ref claude/spec-<issue>`. Claude Code never merges.

Tokens: because `github_token: github.token` is passed, each job's `permissions:` block is the
token Claude gets (without it the action would use the Claude app's installation token with
contents, pull-requests and issues write). `mention`: contents read, pull-requests and issues
write, actions read. `spec` (Claude): contents and issues read; tools limited to file edits,
`npm test`/`lint`/`typecheck`/`coverage`/`format`/`gen-docs`/`test:py`, `git add/commit/diff/
log/status`, with no `gh` tool. Claude reads the issue's title and body from a file the job saves
from the label event, never its comments: read the comments before adding `claude:go`, and put
everything Claude should follow in the body. Tests Claude writes still run as code on that
runner, which is why its token is read-only; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps the Claude
credential out of their environment, under bubblewrap, and setup-node saves no npm cache
(docs/security/14-build-and-release-supply-chain.md, B23). `spec-pr` (no Claude): contents and pull-requests write;
GITHUB_TOKEN cannot change `.github/workflows`. No other secret is passed.
Both Claude jobs name a permission mode (`mention` acceptEdits, `spec` default, which the scrub
requires): since action 1.0.273 a session otherwise starts in auto mode, where a safety review
can allow a tool call no allow rule covers.
