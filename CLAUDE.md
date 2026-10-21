# Vimma

Keyboard-first Firefox fork (Surfer). Neovim modal layer + tmux-style prefix keymap (ctrl+b),
workspaces as containers, on-demand side panel, always-visible status bar, Omarchy theming,
local AI agents (MCP, in progress) confined to an agent workspace. Linux first, macOS next.
Read plan.md once per milestone; read docs/specs/<current>.md every session.

## Commands

- npm test # Vitest for packages/vimma-core (fast, run constantly)
- npm run typecheck # tsc --checkJs over src/**/vimma/** and packages/**
- npm run lint # eslint, prettier, the Markdown and comment wording checks (tools/md-wording), spec-lint
- npm run gen-docs # regenerate docs/bindings.md, docs/bindings.json, defaults.toml from actions.mjs
- npm run import # sync-core + surfer import: symlink src/ and tests/ into engine/; rerun after editing packages/vimma-core
- npm run build -- --ui # surfer build under a Python mach supports; --ui rebuilds our UI only,
  --mach runs ./mach build (after a moz.build change); it adds ~/.mozbuild/sccache to PATH.
  surfer build exits 0 even when make fails: grep the log for errors (`grep ' E '`)
- npm start # launch the dev build with its own profile (sets the prefs a dev build needs)
- npm run mochitest -- tests/browser/browser_vimma_<name>.js (add --artifact for an artifact build)
- npm run e2e -- --filter <name> # socket-driven e2e under Xvfb (--xvfb --scenarios/--baselines/--out for throwaway runs)
- npm run lane:setup / lane:teardown # a worktree's own artifact engine, for browser tests outside the main checkout
- cargo test, cargo clippy -- -D warnings # in tools/vimma-ctl (Rust)
- npm run security-links # every test link in docs/security.md resolves
- npm run sites # live site-compat suite: nightly CI only; run locally, it gets the developer's IP bot-blocked

## Rules

- Specs and every other Markdown file are professional documentation for outside readers. New and
  edited specs follow docs/specs/README.md. State decisions with their reasons; never record who
  asked, when, quoted chat or agent notes.
- A PR is only for merge-ready work; anything waiting on a decision is an issue; specs merge as
  drafts (docs/specs/README.md, "Lifecycle").
- TDD: write the failing test, run it, paste red output; implement; paste green. Never loosen a test.
  This includes mochitests: a test written after the code does not count as red.
- packages/vimma-core imports nothing from Firefox. Enforced by eslint; do not disable the rule.
  src/.../vimma/core/ is a git-ignored copy made by sync-core: edit packages/vimma-core instead.
- Our code lives in src/browser/base/content/vimma/. Touch upstream files only to inject ours,
  in the smallest hunk possible. A new .patch needs a line in the ADR for it.
- Never edit screenshot baselines or snapshots without a changelog line explaining the change.
- Conventional Commits with a body; the subject is the changelog line; the body explains why.
  commitlint: lower-case subject, body lines ≤ 100 columns. Squash bodies go through `npx commitlint`
  before the merge, chained with `&&` so a failure blocks it.
- User-visible change → update docs/guide.md (and the guide's Features at a glance, or the README status,
  if it changes what works).
- User-visible change → a line in CHANGELOG.md [Unreleased] (the maintainer adds it at merge time, so
  parallel PRs do not conflict). Exception: a PR that changes a snapshot or baseline adds its own line.
- Keymap changes (actions.mjs, defaults.mjs) go one PR at a time: each regenerates bindings docs and
  the help snapshot. Screenshot the `ctrl+b ?` overlay.
- Security-sensitive changes (the control socket, MCP and the agent gate, content actors, workflows
  with secrets, release) update docs/security.md and get a review by a fresh agent before merging.
- No new dependency without a licence check and a PR line. No #[allow]-style suppressions
  (eslint-disable) without a reason comment.
- Never disable a workflow, pin, or lint rule to get green. Stop and report instead.
- Git: never force-push or rewrite pushed history; update a branch with `git merge origin/main`
  and git's default message. Check `git status` before `git worktree remove --force`.
- Processes: never `pkill -f <pattern>` (it matches the tool's own shell); kill by exact PID.
- When unsure how Firefox's front end does something: grep the engine tree and Zen's
  components; do not guess from memory.

## Layout

- packages/vimma-core: dispatcher, key notation, actions.mjs, keymap, config, theme, control
  protocol validator, agent gate logic, state tree (pure)
- src/.../vimma/host: VimmaHost.sys.mjs (key capture, applies actions to gBrowser) and *-ops.mjs
- src/.../vimma/actors: JSWindowActor parent/child (focus, scroll, hints, caret, page reads)
- src/.../vimma/ui: status bar, help overlay, command line, side panel, pickers, prompts, agent line
- src/.../vimma/ctl: control socket server (protocol 2, full and agent roles), AgentGate, agent pages
- src/.../vimma/workspaces, split, config, omarchy, services, about, start
- tools/vimma-ctl: Rust CLI for the control socket, and `vimma-ctl mcp` (an MCP server over stdio)
- tools/: e2e harness, artifact builds, upstream autopilot, packaging, lanes, bench, sites
- tests/browser: mochitests; tests/e2e: socket scenarios + baselines; tests/contract: protocol fixtures
- docs: guide.md (users), security.md, limits.md, runbook.md, rebase.md, adr/, specs/

## Context hygiene

- One spec or PR per agent: a coordinator session hands each PR or issue to a fresh agent in its
  own git worktree (never the main checkout, which the maintainer's dev build reads), and keeps
  only its report. Reviews run in another fresh agent.
- Clear after merge, before review, after 3 failed attempts, when switching area.
- Before clearing mid-task: commit or stash, and write a handover paragraph into the PR description.
  <!-- process-wording: these lines instruct the agents that do the work -->
