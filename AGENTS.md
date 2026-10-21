# Working on Vimma

Instructions for coding agents (Claude Code, Codex, Copilot, Cursor, Gemini CLI and others) and
for people working the same way. They apply to human contributors too; `CONTRIBUTING.md` is the
longer guide for people.

Vimma is a keyboard-first Firefox fork built with Surfer: a Neovim-style modal layer, a tmux-style
prefix (`ctrl+b`), workspaces as containers, an on-demand side panel, an always-visible status
bar, Omarchy theming, and local AI agents over MCP confined to an agent workspace. Linux first,
macOS next; Windows is not a target. The site, vimma.dev, lives in `vimma-browser/vimma-site`.

## Read first

- `docs/specs/<feature>.md` for the feature you touch, and `docs/specs/README.md` for how specs
  are written and move from draft to implemented.
- `docs/security.md` before touching the control socket, MCP and the agent gate, content actors,
  the updater, workflows with secrets, or release.
- `docs/runbook.md` for builds, lanes, CI, releases and the update signing chain.
- `plan.md` once per milestone, for the architecture and the roadmap behind the specs.
- `docs/review-checklist.md` before opening a pull request.

## Commands

- `npm test`: Vitest for `packages/vimma-core` and `tools/` (fast, run constantly).
- `npm run typecheck`: `tsc --checkJs` over `src/**/vimma/**` and `packages/**`.
- `npm run lint`: eslint, prettier, the Markdown and comment wording checks (`tools/md-wording`)
  and spec-lint.
- `npm run gen-docs`: regenerate `docs/bindings.md`, `docs/bindings.json` and `defaults.toml`
  after changing `actions.mjs` or `defaults.mjs`.
- `npm run import`: sync-core plus surfer import (symlinks `src/` and `tests/` into `engine/`);
  rerun after editing `packages/vimma-core`.
- `npx surfer build --ui`: rebuild the UI only; plain `./mach build` in `engine/` after a
  `moz.build` change. It exits 0 even when make fails: grep the log for `E`.
- `npm start`: launch the dev build with its own profile and the prefs a dev build needs.
- `npm run mochitest -- tests/browser/browser_vimma_<name>.js` (add `--artifact` on an artifact
  build).
- `npm run e2e -- --filter <name>`: socket-driven e2e under Xvfb (`--xvfb --scenarios`,
  `--baselines`, `--out` for throwaway runs).
- `npm run lane:setup` / `npm run lane:teardown`: a worktree's own artifact engine for browser
  tests. If setup fails on `verify-source --require`, run `npm run verify-source` in that worktree.
- `cargo test` and `cargo clippy -- -D warnings` in `tools/vimma-ctl` (Rust).
- `npm run security-links`: every test link in `docs/security.md` resolves.
- `npm run test:py`, `npm run license-check`, `npx surfer license-check`: also run before pushing.
- Do not run `npm run sites` locally: the live site-compat suite runs in nightly CI, and run from a
  developer machine it gets that machine's IP address blocked by the sites' bot protection.

## Rules

- **TDD.** Write the failing test, run it and keep the red output; implement; keep the green
  output; put both in the pull request. Never loosen a test. A test written after the code,
  mochitests included, does not count as red. A flaky test gets a root-cause fix, never a retry,
  sleep or skip; without evidence of a cause, record the findings on its issue and leave it open.
- **Core stays pure.** `packages/vimma-core` imports nothing from Firefox (enforced by eslint; do
  not disable the rule). `src/browser/base/content/vimma/core/` is a git-ignored copy made by
  sync-core: edit `packages/vimma-core` instead.
- **Upstream files.** Vimma's code lives in `src/browser/base/content/vimma/`. Touch upstream
  files only to inject Vimma's, in the smallest hunk possible; a new `.patch` needs a line in
  ADR-003's patch register.
- **Markdown is professional documentation for outside readers.** Specs follow
  `docs/specs/README.md`. State decisions with their reasons; never record who asked, when, quoted
  chat or agent notes (`npm run lint` checks the wording). An implemented spec is frozen: add a
  `(Since changed: …)` note instead of rewriting it. Notes for the next session belong in the pull
  request description or the issue, not in the repository.
- **Comments** explain why (a constraint, a Firefox quirk with its source, a non-obvious decision),
  never what the code plainly does, and never cite who asked or a process note.
- **Commits.** Conventional Commits with a body: the subject is the changelog line (lower case),
  the body says why, lines at most 100 columns. release-please writes `CHANGELOG.md` from these
  commits, so do not edit it by hand. Run a squash message through `npx commitlint` before merging.
- **User-visible change** → update `docs/guide.md` (and its "Features at a glance", or the
  README's status line, when it changes what works).
- **Keymap changes** (`actions.mjs`, `defaults.mjs`) go one pull request at a time: each
  regenerates the bindings docs and the help snapshot. Screenshot the `ctrl+b ?` overlay.
- **Baselines and snapshots.** Never change a screenshot baseline or snapshot without saying why
  in the commit body.
- **Security-sensitive changes** (the control socket, MCP and the agent gate, content actors, the
  updater, workflows with secrets, release) update `docs/security.md` and get a review by a
  separate, fresh session with no stake in the change before merging; fix its findings first.
- **Dependencies.** No new dependency without a licence check (`npm run license-check`) and a line
  in the pull request. No `eslint-disable` or `#[allow]` without a reason comment.
- **Never disable a workflow, pin or lint rule to get green.** Stop and report instead.
- **Git.** Never force-push or rewrite pushed history; update a branch with
  `git merge origin/main` and git's default message. Check `git status` before
  `git worktree remove --force`.
- **Processes.** Never `pkill -f <pattern>` (it matches the agent's own shell); kill only
  processes you started, by exact PID.
- When unsure how Firefox's front end does something, grep the engine tree (`engine/`) and Zen's
  components; do not guess from memory.

## Layout

- `packages/vimma-core`: dispatcher, key notation, `actions.mjs`, keymap, config, theme, control
  protocol validator, agent gate logic, state tree (pure).
- `src/browser/base/content/vimma/`:
  - `host/`: `VimmaHost.sys.mjs` (key capture, applies actions to `gBrowser`) and `*-ops.mjs`.
  - `actors/`: JSWindowActor parent/child (focus, scroll, hints, caret, page reads).
  - `ui/`: status bar, help overlay, command line, side panel, pickers, prompts, agent line.
  - `ctl/`: control socket server (protocol 2, full and agent roles), `AgentGate`, agent pages.
  - `workspaces/`, `split/`, `config/`, `omarchy/`, `services/`, `about/`, `start/`.
- `tools/vimma-ctl`: Rust CLI for the control socket, and `vimma-ctl mcp` (an MCP server over
  stdio).
- `tools/`: e2e harness, artifact builds, upstream autopilot, packaging, lanes, bench, sites.
- `tests/browser`: mochitests; `tests/e2e`: socket scenarios and baselines; `tests/contract`:
  protocol fixtures.
- `docs/`: `guide.md` (users), `security.md`, `limits.md`, `runbook.md`, `rebase.md`, `adr/`,
  `specs/`.

## Where to work

- **Work in a git worktree, never in the primary checkout**: a dev build may be running from it.
  `git worktree add .claude/worktrees/<item> -b <branch> origin/main` (the directory is
  git-ignored), then `npm ci` and, for browser tests, `npm run lane:setup` there.
- Never touch a running Vimma, the dev profile (`~/.cache/vimma-dev-profile`) or an installed
  profile (`~/.config/vimma/`). Use throwaway profiles (`--profile "$(mktemp -d)"`).
- Keep scratch files (logs, commit messages, screenshots) in a folder of your own outside the
  repository; when several agents share a scratch area, use a subfolder named after your item.
- Do not touch other open pull requests' branches.

## Working in parallel

- One item (a pull request or an issue) per session or agent, each in its own worktree. At most
  three run at once.
- Start a fresh session after a merge, before a review, after three failed attempts at the same
  problem, and when switching area. Before stopping mid-task, commit (or push a draft) and write
  the state of the work into the pull request description.
- Reviews, security reviews above all, run in a fresh session that did not write the change.

## Specs and issues

- A pull request is only for work that is ready to merge. Anything waiting on a decision is a
  question in its GitHub issue, never an open pull request.
- A spec merges as `Status: draft` with its open questions inside it, and its GitHub issue (labels
  `planned` and `spec:draft`) lists the questions as a checklist with options and a
  recommendation. Each answer is a small merged edit (`docs/specs/README.md`, "Lifecycle").
- A pull request that implements part of a spec updates that spec's `Status:` line and `Issue:`
  line in the same change, and switches the issue's `spec:*` label when the status changes. Every
  new decision states its reason ("X, because Y").
- A feature that lands over several pull requests sits behind `vimma.feature.<name>` defaulting to
  `false` (`CONTRIBUTING.md`, "Unfinished features"): `main` must stay releasable.
- A pull request that completes an issue says `Closes #N` in its body and in the squash body; one
  that does part of it says `Part of #N`. After merging, check that the issue closed.

## Landing a pull request

1. One item per branch. Start from the latest `origin/main`.
2. Red test, fix, green test (keep both outputs). Docs and the spec change in the same branch.
3. **Verify in a real build**: the lane's artifact build, or a full build when patches, C++ or
   `moz.build` change. Use the change as a user would; unit tests and CI alone are not enough. UI
   changes get screenshots, and every image is looked at, with the Omarchy theme
   (`vimma.theme.source=omarchy`, `vimma.theme.omarchyPath=~/.local/state/omarchy/current/theme`)
   and also in a light theme if colours change. Throwaway e2e scenarios:
   `npm run e2e -- --xvfb --scenarios <dir>/scen --baselines <dir>/shots --out <dir>/out
--update-baselines`. Chrome UI that keys cannot reach: a temporary mochitest that saves
   `drawSnapshot` PNGs, removed afterwards with its `browser.toml` line and engine symlink.
4. `npm run lint`, `npm run typecheck`, `npm test` (and `npm run security-links` after editing
   `docs/security.md`).
5. Security-sensitive: get the fresh review and fix its findings.
6. Open the pull request: why, how it was tested (with the red and green output), `Closes #N` or
   `Part of #N`, and a dependency's licence line when one was added.
7. Wait for green: `gh pr checks <N> --watch`. Re-run a failed job at most once, only for a known
   flake, and say so. A real failure: fix it, or stop and report.
8. Squash-merge with a checked message in one unbroken `&&` chain, so that any failure blocks the
   merge (a `;` once merged a pull request with an empty message):
   `test -s msg.txt && npx commitlint < msg.txt && gh pr merge <N> --squash --subject
"<type(scope): subject> (#N)" --body "$(tail -n +3 msg.txt)"`.
9. Clean up: `npm run lane:teardown`, `git worktree remove`, delete the local branch.

Merge rights are the maintainer's, and agents working for them merge only within these limits:

- **Merge when green and verified:** fixes, CI and tooling, docs, and small user-visible tweaks.
- **Stop at ready:** big user-facing features (a new capability or workflow on the scale of the
  agent workspace or MCP) and changes to default keys. Mark the pull request ready, write in its
  body how to try it (build, prefs, keys, what to look for), and leave the merge to the
  maintainer. When unsure whether a change counts as big, treat it as big.
- Never merge the release pull request unasked.

## Reporting back

End each item with a short report: the item; the outcome (merged as #N at a commit, or stopped
and why); red and green test evidence; the screenshots looked at; CI re-runs; anything only the
maintainer can do or decide; the cleanup done.

## Releases (short)

release-please keeps a `chore(main): release X.Y.Z` pull request open. Merging it creates the tag
and a draft release, and `release.yml` builds, signs and uploads it (about 2 h 15 min). The
maintainer publishes the draft; `update-publish.yml` then signs the update manifest and pushes it
to `vimma-updates`, served at `updates.vimma.dev`. vimma.dev follows the latest release through
its daily `release-sync` workflow. Details: `docs/runbook.md`, "Releases".

## Tool notes

- **Claude Code** reads `CLAUDE.md`, which imports this file and adds what only Claude Code uses.
- **Codex, Cursor, Copilot** (VS Code and the coding agent) and **Zed** read this file directly.
  Copilot code review reads `.github/copilot-instructions.md`, which points here.
- **Gemini CLI** reads this file through `.gemini/settings.json` (`context.fileName`).
- Other tools: load this file as the project instructions (for Aider, `--read AGENTS.md`).
- Machine-local notes, when present, live in git-ignored files (such as `CURRENT-STATE.md` and
  `TESTING.md` in the primary checkout); read them if they exist, and never commit them.
  <!-- process-wording: tool notes name the instruction files each coding agent loads -->
