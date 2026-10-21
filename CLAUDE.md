@AGENTS.md
<!-- process-wording: Claude Code's instruction file loads the shared rules for coding agents -->

## Claude Code

- Subagents: hand each pull request or issue to a fresh subagent in its own worktree under
  `.claude/worktrees/`, and keep only its report. Reviews run in another fresh subagent.
- `claude.yml` runs Claude Code in GitHub Actions (`@claude` mentions, and `claude:go` on a spec
  issue); its security model is in the workflow's header and `docs/runbook.md`.
