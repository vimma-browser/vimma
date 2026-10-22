# Vimma — implementation plan

Vimma is a keyboard-first browser built as a Firefox fork: Neovim-style modal control of the page, a tmux-style prefix keymap (`ctrl+b`) for tabs, panes and workspaces, `prefix+?` discoverability from the first build, workspaces as isolated containers, an on-demand side panel, an always-visible status bar, and an Omarchy-native look. Built by one person with AI coding agents, no deadline, with a pipeline that tests, rebases on upstream and releases without anyone watching.

This file is the contract between you and the coding agents. Specs, ADRs, tests and the changelog in the repo refine it; nothing in a chat transcript overrides it.

---

## 1. Decisions (ADR-001 … ADR-008)

Each is a file in `docs/adr/`. Summaries here; the ADR holds the reasoning and the alternatives rejected. Later decisions (ADR-009 onwards) are only in `docs/adr/`.

| ADR | Decision | One-line reason |
| --- | --- | --- |
| 001 | **Engine: Firefox, as a fork built with Surfer** (Zen's toolchain), not Chromium/CEF, not an extension. | Firefox's browser UI is JS/CSS/XHTML, so split panes, a status bar and total keyboard ownership are front-end work; Zen proved one person can ship exactly this feature set and track upstream. CEF would lose all extensions; an extension cannot own keys outside page content or do real panes. |
| 002 | **Upstream: Firefox release channel**, rebased on every major release (every two weeks since 154.0) and on dot releases, tracked by an automated PR. | Release is what Zen tracks and what users expect; ESR would delay web platform features by a year. |
| 003 | **Our code lives in our own files** under `src/browser/base/content/vimma/`; upstream files are touched only to inject them. | Keeps the patch set small so monthly rebases are mechanical. Same discipline as Zen's `zen-components`. |
| 004 | **Language: JavaScript ES modules (`.sys.mjs` / `.mjs`) with JSDoc types, type-checked by `tsc --checkJs`.** No TypeScript compile step inside the Firefox tree. | The fork's UI runs inside Firefox's chrome; a transpile step complicates patching and debugging. Type safety comes from JSDoc + tsc in CI. The engine underneath is already C++ and Rust. |
| 005 | **`vimma-core` is a pure ES module package** (dispatcher, key notation, keymap merge, state tree) with zero Firefox imports, tested with Vitest in Node in milliseconds. | 80 % of behaviour becomes testable without a browser; the same module could run in an extension or another host. |
| 006 | ~~**Split view is vendored from Zen**~~ Superseded by **ADR-013: split panes build on Firefox's own split view**; our CSS places its panels at the core pane tree's rectangles. | Firefox 157 ships, tests and maintains split view in the tree we rebase onto; Zen's needs split-related hunks in 20 upstream patch files. The sub-spec 1 spike proved 3 and 4 panes at exact rectangles. |
| 007 | **Control socket**: a local TCP server (localhost, random port, token in a file under the profile) speaking JSON lines: `send-keys`, `state`, `open <url>`, `reload-theme` (`list-tabs`, `screenshot` and `reload-config` are reserved names). | A scripting API for users and the backbone of end-to-end tests, so tests never depend on window-manager key injection. |
| 008 | **Config: one `config.toml`**, a `[keys]` table (`action = [chords]`) for the prefix layer, per-mode tables for the modal layer, `[workspaces]`, `[theme]`; schema versioned with migrations; TOML parser vendored (smol-toml, BSD-3-Clause: ADR-012). | One file to read and diff; Firefox ships no TOML parser. |

Explicitly rejected: Chromium fork (C++ UI, multi-hour builds, monthly rebases of a 30 M-line tree); CEF + Rust (no extensions); WebExtension only (no keys in URL bar / about: pages / PDF viewer, no real panes, no real status bar). Forking Zen itself was considered: rejected for v1 because tracking two fast-moving upstreams doubles rebase work; revisit if we end up re-implementing most of Zen.

---

## 2. Interaction model

Two layers, one dispatcher. The **modal layer** (Neovim) decides what a bare key means in the page; the **prefix layer** (tmux-style) handles anything after `ctrl+b`, in every mode. A single capturing `keydown` listener on the chrome window feeds `vimma-core`:

```js
/** @returns {{kind:'action', action:Action} | {kind:'pending'} | {kind:'pass'}} */
dispatch(mode, keyEvent)
```

`prefix+?` renders from the same binding table the dispatcher uses, so help cannot drift from behaviour.

**Modes:** `normal` (default), `insert` (focus in an editable element, reported by the content actor; `Esc` leaves), `visual` / `copy` (caret browsing + selection), `command` (`:` line), `hint` (link hints), `prefix` (transient after `ctrl+b`, exits after one command or `Esc`), `help` (`prefix+?` overlay, `/` filters, `Esc` closes), `panel` (side panel open: `1-9`, `j/k`, Enter, `Esc`).

**Default bindings.** The prefix layer is tmux-style: `ctrl+b`, tmux's default prefix, then a key. Every key, the prefix and the leader can be remapped; `docs/bindings.md` is the current list.

| Action | Prefix layer (prefix = `ctrl+b`) | Neovim-style |
| --- | --- | --- |
| Show all bindings (filter with `/`) | `prefix+?` | `:map` |
| New tab | `prefix+c` | `:tabnew`, `t` |
| Jump to tab 1–9 (within workspace) | `prefix+1..9` | `3gt` |
| Next / previous tab | `prefix+n` / `prefix+p` | `gt` / `gT` |
| Rename tab | `prefix+shift+t` | `:tabrename name` |
| Close tab | `prefix+shift+x` | `:q`, `x` |
| Split right / down | `prefix+v` / `prefix+-` | `:vsplit` / `:split` |
| Move between panes | `prefix+h/j/k/l` | `Ctrl-w h/j/k/l` |
| Swap panes | `prefix+shift+h/j/k/l` | `Ctrl-w H/J/K/L` |
| Zoom pane | `prefix+z` | `Ctrl-w o` |
| Close pane | `prefix+x` | `:q` in a pane |
| Resize mode | `prefix+r` | `Ctrl-w <>+-` |
| Next / previous workspace | `prefix+)` / `prefix+(` | `:wsnext` / `:wsprev` |
| Workspace picker | `prefix+w` | `:workspace name` |
| New / rename / close workspace | `prefix+shift+n` / `shift+w` / `shift+d` | — |
| Goto picker (every tab, all workspaces, `/` search) | `prefix+g` | `:ls`, `b` |
| Open / close side panel | `prefix+b` | `:sidebar` |
| Copy mode | `prefix+[` | `v` |
| Scroll | — | `j k h l gg G`, half page `d` / `u` |
| Follow link / in new tab | — | `f` / `F` |
| Search in page | — | `/ ? n N` |
| Command line | — | `:` |
| Reload config | — | `:source` |

Half-page scroll is `d`/`u` (Vimium) and Vim's `ctrl+d`/`ctrl+u`; `ctrl+o`/`ctrl+i` walk history; close-tab is `x`. The leader (`space`) has no default bindings; it is there for the user's own. Firefox's shortcuts on Vimma's keys (`ctrl+w`, `ctrl+u`, `ctrl+d`, `ctrl+b`, …) are off; the rest keep Firefox's meaning (`docs/guide.md`, "Firefox's own shortcuts").

**Side panel:** closed by default. `prefix+b` opens a panel on the left headed by the current workspace (name, colour, neighbour hints `prefix+(` / `prefix+)`) listing that workspace's tabs as numbered rows. `1-9`, `j/k`, Enter select; `prefix+b` / `Esc` close. Workspaces are never a permanent list on screen.

**Status bar:** one line at the window foot, always visible: mode badge, pending prefix, workspace dot + name, `tab 2/5`, `pane 1/2`, config error indicator, blocklist/update hints.

**Workspaces = containers.** Each workspace maps to a Firefox container (`userContextId`); new tabs in a workspace open in its container; tabs of other workspaces are hidden (`gBrowser.hideTab`). Moving a tab between workspaces reopens it in the target container (page state is lost; the picker warns).

**Config file:**

```toml
# ~/.config/vimma/config.toml
schema = 2

[keys]                                  # action = [chords]
prefix = "ctrl+b"
new_tab = ["prefix+c", "ctrl+alt+c"]
split_vertical = ["prefix+v"]
show_keybinds = ["prefix+?"]
next_workspace = ["prefix+)"]
previous_workspace = ["prefix+("]
toggle_sidebar = ["prefix+b", "<leader>n"]   # the leader has no defaults; this adds one

[workspaces]                            # order = prefix+) order; each is a Firefox container
work     = { color = "blue",  home = "https://intranet.example" }
admin    = { color = "red",   autofill = false }
personal = { color = "green" }

[modal]
leader = " "
timeout_ms = 800

[modal.normal]
"j" = "scroll.down"
"d" = "scroll.half_down"
"u" = "scroll.half_up"
"gt" = "tab.next"
"<leader>ff" = "goto.picker"

[theme]
source = "omarchy"                      # "omarchy" follows ~/.local/state/omarchy/current/theme/colors.toml; "file" uses [theme.colors]
font = "CaskaydiaMono Nerd Font"

[unbind]
normal = []
```

Rules the config engine enforces: actions are a closed set generated from `actions.mjs` (single source of truth; the bindings table in the docs is generated from it); unknown action or key notation fails with file, line and a suggestion; user overrides are marked in `prefix+?`; reload is atomic (parse + validate fully, then swap); schema version with migrations.

---

## 3. Architecture

```
┌──────────────────────────── Firefox (Gecko, C++/Rust) ────────────────────────────┐
│ browser.xhtml  ──injects──▶  src/browser/base/content/vimma/                       │
│                              ├─ core/          vimma-core: dispatcher, keymap,     │
│                              │                 key notation, actions, state tree   │
│                              │                 (pure ESM, no Firefox imports)      │
│                              ├─ host/          VimmaHost.sys.mjs: window keydown   │
│                              │                 capture, applies actions to gBrowser│
│                              ├─ actors/        VimmaParent/Child JSWindowActors:   │
│                              │                 focus/insert detection, scroll,      │
│                              │                 hints, caret/copy, find helpers     │
│                              ├─ ui/            status bar, help                    │
│                              │                 overlay, command line, side panel,  │
│                              │                 pickers (HTML + CSS in chrome)      │
│                              ├─ workspaces/    containers model, hide/show tabs,   │
│                              │                 SessionStore persistence            │
│                              ├─ split/         layout over Firefox's split view    │
│                              ├─ config/        TOML load/validate/migrate, poll-   │
│                              │                 based reload, theme tokens,          │
│                              │                 Omarchy adapter                      │
│                              └─ ctl/           control socket (nsIServerSocket)    │
└───────────────────────────────────────────────────────────────────────────────────┘
          ▲ config.toml, theme files            ▲ vimma-ctl (Rust CLI, ADR-011) and the e2e harness
```

Key mechanics:

- **Key capture:** `window.addEventListener('keydown', handler, true)` in the chrome window sees keys before the URL bar, sidebar, about: pages and the PDF viewer. Keys the dispatcher returns `pass` for continue untouched.
- **Content side:** a `JSWindowActor` pair. The child reports focus changes (insert mode), executes scroll/hint/caret commands, and returns hint targets; the parent is the only thing that talks to it. This is the one Firefox-specific concept to learn properly in M1.
- **Panes:** a pane tree in `vimma-core` (`split`, `zoom`, `swap`, `focus`, `close`) mirrored onto Firefox's split view, laid out by our CSS (ADR-013). One `<browser>` per pane; the active pane owns the URL bar.
- **Workspaces:** model in core; host maps to containers and hidden tabs; persisted through `SessionStore.setCustomTabValue` (tab → workspace) plus a JSON file for workspace definitions; per-window state and pane layouts in a SessionStore window value (`docs/specs/m3-workspaces.md`); restored on startup.
- **Theme:** tokens → CSS custom properties on the chrome document. Omarchy adapter polls `~/.local/state/omarchy/current/theme/colors.toml` and remaps on change (see `docs/notes/omarchy-theming.md`).
- **Config reload:** poll the file's mtime every 2 s (Firefox has no portable fs watcher); `:source` forces it.

Repository layout (Surfer convention: `src/` mirrors the Firefox tree; `.patch` files for upstream edits, whole files for ours):

<!-- process-wording: the layout lists the coding agents' rules file -->
```
vimma/
  surfer.json                     # upstream Firefox version, branding, build options
  CLAUDE.md                       # rules coding agents read every session
  CHANGELOG.md
  package.json                    # surfer, vitest, tsc, eslint, prettier, commitlint
  tsconfig.json                   # checkJs over src/**/vimma/** and packages/**
  packages/
    vimma-core/                   # ESM package, Vitest tests, published into src/ by `npm run sync-core`
  src/
    **/*.patch                                     # the small upstream patches (register: ADR-003)
    browser/base/content/vimma/                    # all our code (see tree above)
    browser/themes/shared/vimma/                   # CSS for Vimma's UI (Tokyo Night tokens: theme.mjs)
    browser/branding/vimma/                        # default prefs (name and icons: configs/branding)
  configs/                        # mozconfigs (common, linux, macos, windows) and branding inputs
  tools/
    vimma-ctl/                    # Rust CLI client for the control socket (ADR-011)
    e2e/                          # harness: launch build with temp profile, drive via socket
    upstream/                     # detect.mjs (autopilot), bump-surfer-json.py, patch-check.py, rebase helpers
  tests/
    browser/                      # mochitest browser-chrome: browser_vimma_*.js
    e2e/                          # socket-driven scenarios + screenshot baselines (plain blobs)
  docs/
    guide.md  bindings.md  limits.md  security.md  review-checklist.md  rebase.md  runbook.md
    adr/  specs/  notes/
  .github/workflows/              # ci, e2e, nightly, upstream, upstream-beta, claude, release-please,
                                  # release, mutation, fuzz, patch-audit, sites, site-dispatch,
                                  # dependabot-automerge, semgrep, codeql
```

---

## 4. Development life cycle

Loop: spec → failing tests → implement → review → changelog → merge → dogfood. You decide and review; machines do the rest.

1. **Discovery (M0).** Read Surfer docs and Zen's `desktop` repo structure, `tabbrowser.js`, `browser.js`, Zen's split view and workspaces components, Tridactyl's hint algorithm, tmux's keymap. Output: ADR-001…008, `docs/limits.md`, `actions.mjs`.
2. **Specification (per feature).** `docs/specs/<feature>.md`: user story, default bindings, config keys, socket commands, acceptance criteria as Given/When/Then, out of scope. One agent session in size. Merged to `main` at once as a draft, with its open questions; the feature's GitHub issue (label `planned`) asks them (`docs/specs/README.md`, "Lifecycle").
3. **Design (boundary changes).** ADR for anything touching the dispatcher contract, config schema, socket protocol, state file, or a new upstream patch. Numbered, never edited after acceptance.
4. **Implementation (TDD, §5).** Branch `feat/<slug>`, Conventional Commits with a body. The `claude.yml` agent may open the PR itself when the issue carries `claude:go` (a label only you add).
5. **Review.** CI + e2e green before merging (no approving review is required); `main` is protected by the repository ruleset "main": pull requests only, squash merge, required checks (`docs/runbook.md`). A fresh agent session reviews first with the spec open and posts the checklist from `docs/review-checklist.md`: tests prove the behaviour, no test weakened, no new action without a docs line, config change has a migration, no new upstream `.patch` without an ADR line, no new dependency without licence check.
6. **Release.** release-plz-style automation (JS equivalent: `release-please`) keeps a release PR with version + changelog; merging tags; the release workflow builds, signs, publishes.
7. **Operate.** `about:vimma` shows mode, last 20 key events, active overrides, config errors, upstream Firefox version and patch count; `:bug` copies a redacted report. Weekly maintenance run below.

**What runs without you** (the target; `docs/limits.md` "Build and CI" lists what is not built or not switched on yet, such as the nightly and auto-merged bumps; `maintenance.yml` is not written yet):

| Trigger | Job | Green | Red |
| --- | --- | --- | --- |
| Every push / PR | `ci.yml`: eslint, prettier, `tsc --checkJs`, Vitest for `vimma-core` with coverage gate (90 %), commitlint, licence check | Merge allowed | Blocked; the authoring agent is asked to fix it |
| Every PR | `e2e.yml`: UI-only build (`surfer build --ui` on a cached engine, or artifact build; decided in M0), mochitest browser-chrome suite, socket-driven e2e under Xvfb, screenshot diffs (0.5 % tolerance) | Merge allowed | Blocked; flaky test quarantined after 2 unexplained failures + issue |
| Nightly 03:00 | `nightly.yml`: full build Linux x86_64 (+ aarch64, macOS when enabled), full e2e on the build, publish rolling `nightly` release | Nightly updated | Issue with logs + failing test, assigned to a coding agent |
| Every 4 h | `upstream.yml`: poll `product-details.mozilla.org`; on a new Firefox release or dot release open `upstream: update to Firefox X.Y` PR bumping `surfer.json`, run `surfer import`, build, test | Auto-merge if patches applied cleanly and e2e green; release PR follows | A coding agent attempts conflict resolution (≤3 pushes), else you get a summary with the failing hunks |
| Weekly | Dependabot: npm deps, Cargo crates, GitHub Actions versions | Patch/minor auto-merged after CI (never GitHub Actions) | PR stays open |
| Sunday | `maintenance.yml` (coding agent, bounded): triage issues, re-run quarantined tests, refresh `docs/limits.md`, review patch sizes and propose moving code out of `.patch` files, write `docs/weekly.md` | PRs waiting Monday | Report lists what it could not do |
| Tag `v*` | `release.yml`: tarball, AppImage, `.deb`, macOS `.dmg` when enabled; cosign signatures, SBOM; AUR `vimma-bin` push; update manifest for the in-app updater; GitHub Release notes from changelog | Users update | Tag deleted, issue opened |
| Firefox security dot release | Same as upstream job, flagged `security`; release PR auto-approved and merged if e2e green → release within 7 days without you | | |

**Definition of done:** spec exists; tests written first and green; lint + typecheck clean; changelog entry via commit subject; docs regenerated (`npm run gen-docs` rebuilds the bindings table from `actions.mjs`); nightly used for a day.

---

## 5. TDD policy and test pyramid

Tests first; implementation only to make them pass. The author writes the failing test, runs it, pastes the red output, implements, pastes the green, refactors. PRs with tests written after code or assertions loosened to pass are rejected.

| Layer | Covers | Tooling | Gate |
| --- | --- | --- | --- |
| Unit | Dispatcher, key notation (`ctrl+b`, `<leader>ff`, `prefix+shift+t`), keymap merge, config validation + migrations, pane tree ops, workspace model | Vitest in Node; table-driven `test.each`; `fast-check` property tests (parse/format round-trip; no two bindings share a prefix unless `timeout_ms` resolves it); snapshot tests for `prefix+?` output and `defaults.toml` | 90 % lines on `packages/vimma-core`, hard gate; Stryker mutation testing weekly, survivors become issues |
| Contract | Socket protocol, config schema versions, state file | JSON fixtures, one valid + one invalid per version | New version = new fixture pair + migration test |
| Browser-chrome | Host wiring: key capture reaches dispatcher, actions hit `gBrowser`, side panel focus, status bar text, actor messages, container routing, split layout | Firefox mochitest `browser_vimma_*.js` (same framework Zen uses) | One per spec acceptance criterion |
| End-to-end | Real build + temp profile: open tabs in two workspaces, `prefix+2`, rename, `prefix+)`, `prefix+b`, split, reload config, restart and restore | `tools/e2e`: launch under Xvfb, drive via control socket, assert on `state` JSON + screenshots | One happy path per milestone + regression test per bug (issue number in test name); suite < 5 min |
| Performance | Key-to-action latency in core (< 50 µs), key-to-paint in the window (< 5 ms), startup to first paint | Vitest bench for core; e2e timers | Regression > 10 % fails CI |
| Rebase | Patch set applies to the new upstream; UI smoke after rebase | `surfer import` in `upstream.yml` + the e2e happy paths | Any failure blocks the upstream PR |

Rules: test names are sentences from the spec; `vimma-core` imports nothing from Firefox (enforced by an eslint rule); no retries in CI, flaky = quarantine + issue same day; nobody edits a screenshot baseline or snapshot without a changelog line; a bug fix starts with a failing test at the lowest layer that can reproduce it.

---

## 6. Roadmap

Weeks are evenings-and-weekends ordering estimates, not dates. Each milestone ends with a nightly you use daily. Order from here: M7's security work first, then M6a, then M6 once Vimma has been daily-driven; macOS comes later, and Windows is not planned.

The backlog is GitHub issues, one per planned feature: [`label:planned`](https://github.com/vimma-browser/vimma/issues?q=is%3Aissue+is%3Aopen+label%3Aplanned), tracked on the [Vimma roadmap](https://github.com/orgs/vimma-browser/projects/1) board (Planned, In progress, Done). Each issue links its spec and lists the spec's open questions; `docs/specs/README.md` describes the lifecycle. This section keeps the milestones and the order only.

| | Milestone | Status | Scope | Gate |
| --- | --- | --- | --- | --- |
| M0 | **Fork boots + pipeline** (3 wks) | Done | `surfer setup-project` on current Firefox release; branding; CI with Vitest, tsc, eslint, mochitest skeleton; e2e harness launching the build under Xvfb; nightly build; `upstream.yml`; agent workflows (`claude.yml`); `vimma-core` dispatcher + key notation with tests; `VimmaHost` capturing keys; `prefix+?` overlay from the binding table; native tab strip hidden by CSS | Your build runs; `ctrl+b ?` shows the bindings over any page **including `about:preferences` and the PDF viewer**; CI green on a trivial PR |
| M1 | **Modal page layer** (4 wks) | Done | JSWindowActor pair; insert-mode detection; scrolling; `hints.js` + hint mode; find via `gBrowser.finder`; `:` command line with completion from `actions.mjs`; copy mode (caret browsing + selection); `Esc` semantics | A day of browsing without the mouse on ordinary sites |
| M2 | **Tabs, status bar** (3 wks) | Done | Prefix tab keys over `gBrowser`; tab rename (label override persisted); status bar; ~~which-key strip while prefix pending~~ (dropped: only `prefix+?` lists bindings); `prefix+g` basic picker | The keys to learn first (`prefix+c`, `prefix+v`/`-`, `prefix+h/j/k/l`, `prefix+w`) all work (minus panes); screenshot baselines recorded |
| M3 | **Workspaces + side panel** (4 wks) | Done | Container-backed workspaces; hidden tabs; `prefix+)`/`prefix+(`; `prefix+w` picker; `prefix+b` side panel with `panel` mode; SessionStore persistence + restore; `[workspaces]` config | Login in `work` invisible in `personal`; restart restores workspaces, tabs, scroll positions |
| M4 | **Split panes** (5 wks) | Done | Firefox's split view with our layout (ADR-013); pane tree in core; `prefix+v`/`-`/`x`/`z`/`h j k l`; swap; resize mode; URL bar follows active pane; fullscreen requests zoom the pane | Two panes of real sites side by side, keyboard only; mochitests for every pane op |
| M5 | **Config + theme** (3 wks) | Done | `config.toml` load/validate/migrate; polling reload; `:source`; errors in status bar + `about:vimma`; theme tokens; Tokyo Night default; Omarchy adapter; `about:vimma` | `omarchy-theme-set` changes vimma colours live; a broken config line shows file:line in the status bar and the old config stays active |
| M7 | **Security hardening** (ongoing) | Done, with gaps: merging and releasing a bump still need a person ([#259](https://github.com/vimma-browser/vimma/issues/259), [#220](https://github.com/vimma-browser/vimma/issues/220), [#224](https://github.com/vimma-browser/vimma/issues/224)) | Automatic Firefox security updates (detect a release, rebase, test, open a PR with no manual steps); fuzzing of the control protocol, `config.toml` and routing parsers; accessibility pass on Vimma's own UI; a scheduled quarterly patch audit; security release SLA proven twice | Two consecutive Firefox releases rebased and shipped with zero manual steps |
| M6a | **Updater** (top priority) | Next: spec draft, [#217](https://github.com/vimma-browser/vimma/issues/217) | Updates reach every user without them noticing: a signed update manifest on vimma.dev per channel (release, nightly), security releases marked urgent; Firefox's updater back on (it is compiled out by m0-updater) for the tarball and AppImage, pointed at our manifest, verifying MARs against Vimma's own key, never calling Mozilla's update server; AUR and `.deb` left to pacman/apt with a status-bar hint; `release.yml` and every upstream security bump build, sign and publish MARs and the manifest with no manual steps | e2e: install N, serve N+1 from a local server, the update applies on restart and the profile survives; a Firefox security release reaches an installed Vimma with no manual step |
| M6 | **Daily driver + release** (4 wks) | After M6a: [#228](https://github.com/vimma-browser/vimma/issues/228) | Quickmarks + history in `prefix+g`; per-workspace autofill stance; download/permission UX reviewed for keyboard use; tarball/AppImage/`.deb`; cosign + SBOM; AUR `vimma-bin`; opt-in crash reporting. The packaging tooling exists and is switched off (`docs/specs/m6-packaging.md`) | Firefox (stock) uninstalled for a week; a stranger installs from AUR and updates |
| Later | **More platforms** | Later | macOS build + notarisation ([#238](https://github.com/vimma-browser/vimma/issues/238), `docs/specs/macos-build.md`); Homebrew install and the Vimma app icon ([#393](https://github.com/vimma-browser/vimma/issues/393), `docs/specs/macos-homebrew.md`); the private workspace swapped in place on macOS ([#415](https://github.com/vimma-browser/vimma/issues/415), `docs/specs/private-swap-macos.md`); aarch64; Windows is not planned | Same gates as Linux |

Work between milestones, in order. The issues hold the scope, the spec and the open questions.

1. Build supply chain sub-PR 1 ([#221](https://github.com/vimma-browser/vimma/issues/221)), first because the gap it closes is live today.
2. Remaining sub-PRs of Firefox versions ([#219](https://github.com/vimma-browser/vimma/issues/219), [#220](https://github.com/vimma-browser/vimma/issues/220)) and the Beta canary ([#218](https://github.com/vimma-browser/vimma/issues/218)).
3. The Markdown pass and history cleanup ([#226](https://github.com/vimma-browser/vimma/issues/226)).
4. Build supply chain sub-PRs 2 to 5 ([#222](https://github.com/vimma-browser/vimma/issues/222), [#223](https://github.com/vimma-browser/vimma/issues/223), [#224](https://github.com/vimma-browser/vimma/issues/224), [#225](https://github.com/vimma-browser/vimma/issues/225)).
5. M6a, the updater ([#217](https://github.com/vimma-browser/vimma/issues/217)). Implementation starts once its signing-key questions are answered.
6. Vimma MCP, remaining sub-PRs ([#229](https://github.com/vimma-browser/vimma/issues/229), [#230](https://github.com/vimma-browser/vimma/issues/230), [#231](https://github.com/vimma-browser/vimma/issues/231)), the follow-up [#232](https://github.com/vimma-browser/vimma/issues/232), and showing and moving around pages in the agent workspace ([#252](https://github.com/vimma-browser/vimma/issues/252)), before #231. Then one grant per task ([#507](https://github.com/vimma-browser/vimma/issues/507), `docs/specs/mcp-grants.md`) and the payment and form checkpoints ([#508](https://github.com/vimma-browser/vimma/issues/508), `docs/specs/mcp-checkpoints.md`).
7. Independent of the keymap: the Firefox panels audit ([#227](https://github.com/vimma-browser/vimma/issues/227)), search engines ([#233](https://github.com/vimma-browser/vimma/issues/233)), the
   bookmarks toolbar hidden by default ([#214](https://github.com/vimma-browser/vimma/issues/214)), the focused pane's highlight in a split ([#362](https://github.com/vimma-browser/vimma/issues/362)), and macOS sub-PRs 1 and 2 if [#238](https://github.com/vimma-browser/vimma/issues/238) decides so.
8. Keymap changes, one PR at a time (each regenerates the bindings docs and the help snapshot):
   Firefox keys ([#234](https://github.com/vimma-browser/vimma/issues/234), [#235](https://github.com/vimma-browser/vimma/issues/235)), toolbar toggle ([#216](https://github.com/vimma-browser/vimma/issues/216)), element focus ([#213](https://github.com/vimma-browser/vimma/issues/213)), tab search
   ([#215](https://github.com/vimma-browser/vimma/issues/215)), the bookmarks toolbar's key ([#214](https://github.com/vimma-browser/vimma/issues/214)) and PDF mode's keys ([#487](https://github.com/vimma-browser/vimma/issues/487), `docs/specs/pdf-mode.md`).
9. M6 ([#228](https://github.com/vimma-browser/vimma/issues/228)), once Vimma has been daily-driven.

Maintenance: [#204](https://github.com/vimma-browser/vimma/issues/204), [#236](https://github.com/vimma-browser/vimma/issues/236), [#237](https://github.com/vimma-browser/vimma/issues/237).

Recurring with every Firefox release from M0: the upstream rebase. Budget half a day for the first three, then it should be automatic.

---

## 7. Changelog, versioning, release

`CHANGELOG.md` follows Keep a Changelog; versions follow SemVer; `release-please` derives both from Conventional Commits on `main` and keeps a release PR current. Merging it is the release. Config schema and socket protocol carry their own integer versions with migrations.

Commit types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `deps`, `upstream`, `ci`, `build`, `revert`; `!` or `BREAKING CHANGE:` for changed defaults, config keys, socket protocol. CI rejects `feat`/`fix`/`revert` with an empty body (the subject is the changelog line; the body explains why).

Versioning: `0.x` until M6's gate; breaking default-binding or config changes bump minor and ship a migration + deprecation note kept for two releases; `1.0.0` after M6. Nightlies: `0.x.y-nightly.<date>` on a rolling tag. Version string shows the upstream Firefox version too (`Vimma 0.4.0 · Firefox 152.0.1`).

Vimma and Firefox versions. Vimma's version describes Vimma; Firefox's version is shown beside it, never encoded in it:

- **One SemVer line, independent of Firefox.** Firefox ships a major every two weeks, so a Firefox-based number (LibreWolf's `158.0-1`) would say nothing about what changed in Vimma. `--version`, `about:vimma`, the status bar's version line, release titles and the update manifest show both (`Vimma 0.5.2 · Firefox 158.0`).
- **Every release bumps patch**, whatever it contains: a Firefox bump, fixes, features or a breaking change (`always-bump-patch`, [release-versioning](docs/specs/release-versioning.md)). The maintainer moves to `0.2.0` or `1.0.0` with a `Release-As` footer when a release deserves it. A Firefox major is never a reason on its own: the browser under Vimma changed, Vimma's interface did not. A breaking change still ships its migration and deprecation note. The changelog lists a Firefox bump under Changed as `Firefox 158.0 (MFSA 2026-106)`, linked to the advisory.
- **Security releases go out at once** (once releases are public: nothing is published before the release gate, M6). An `upstream:` bump labelled `security` is released as soon as it merges, within the G2 deadline, and its manifest entry is marked urgent (M6a). Feature releases have no fixed cadence: release when a batch is worth it, at least one patch release per Firefox release.
- **Release from `main` only.** A security release carries whatever else is on `main`, so `main` stays releasable: unfinished features sit behind a pref that defaults off, and the one-PR-in-flight rule keeps the batch small. No maintenance branches before `1.0.0`; after it, a `release/1.x` branch for cherry-picked security bumps only if a release ever has to skip what is on `main`.
- **Implementation** ([firefox-versions](docs/specs/firefox-versions.md)): the Firefox version in the release title and the changelog heading (`## [0.5.2] · Firefox 158.0`); a release workflow that cuts the release on a merged `security` bump without waiting for a person; a test that the version line shows both numbers. release-please's bump rules stay as they are.

Release checklist (`release.yml`, automated; `docs/runbook.md` "Release packages" is the human fallback):

- [ ] Full builds per target via Surfer; `surfer package`
- [ ] Smoke: install in a clean container, start under Xvfb, run the M0 gate
- [ ] SBOM + cosign keyless signatures on every artifact
- [ ] AUR `vimma-bin` pushed; update manifest regenerated and published
- [ ] GitHub Release with changelog section; `nightly` tag moved
- [ ] Any failure deletes the tag and opens an issue assigned to a coding agent

---

## 8. Working with coding agents

<!-- process-wording: this section is about coding agents and names their rules file -->
The repo holds the memory. `CLAUDE.md`, specs, ADRs, tests and the changelog are what every fresh session reads, local or headless.

**Plan-first, one spec per session.** Plan mode → plan saved to `docs/specs/<feature>.md` listing tests to write, files to touch, upstream patches needed (ideally none), ADR check → approve → run. Every spec follows `docs/specs/README.md`: the template, verified facts, and professional prose with no record of who asked for what. Drift past the spec means stop and split.

**When to clear context (`/clear` or new session):**

- After a spec is merged — always. The next feature starts from files, not conversation.
- Before a review — always. Review in a fresh session reads the diff, not intentions.
- After three failed attempts at one bug: write what was learned into the issue or `docs/notes/`, clear, restart with the note plus the failing test. Doubly so for `tabbrowser` focus bugs.
- When switching area: `vimma-core` ↔ host/actors ↔ UI/CSS ↔ CI/Surfer. Different files, different rules.
- When context passes roughly half: `/compact` with a focus phrase ("keep test names and the actor message schema"); clear if the summary would lose the thread.
- Never mid-task without a commit/stash and a note in the PR description on where the work stands.

**Unattended runs (`claude.yml`):**

- `@claude` in an issue/PR comment answers and reviews (read-only contents). Issue with `spec` + `claude:go` → implemented in a worktree, draft PR. Only you add `claude:go`.
- Failed nightly, failed upstream rebase, failed Dependabot PR → bounded fix: ≤ 3 pushes, each must add or change a test; never edits workflows, baselines, lint config or `surfer.json` pins to get green.
- Sunday maintenance: fixed checklist, token budget, opens PRs, never merges.
- Its PRs carry `bot`; auto-merge only for Dependabot and clean upstream bumps, never for agent PRs.
- Scoped token: the agent itself gets read-only contents; a separate job without the agent pushes its branch and opens the PR (contents + pull-requests write); no release, AUR, signing or update-server secrets.

**Practices that pay off here:**

- Subagents for exploration ("read how Zen's split view hooks `tabbrowser` and summarise the entry points") so research never fills the main context.
- Git worktrees per spec; the headless runner does the same.
- Hooks: `PostToolUse` runs prettier + the Vitest file for the touched core module; after edits under `src/**/vimma/ui/**` it runs `surfer build --ui` and the matching mochitest; `Stop` refuses to end if `vimma-core` gained an export without a test or if `src/` changed without a Conventional Commit body.
- Small, verifiable asks: "make `prefix+shift+t` rename the tab; tests in `dispatcher.test.mjs` and `browser_vimma_tab_rename.js`".
- Make the agent prove it: every "tests pass" is pasted output; CI is the arbiter.
- Keep the UI loop fast: `surfer build --ui && surfer run` under a minute locally, or both of you will skip it.
- Re-read `CLAUDE.md` monthly; delete rules that no longer bite.
  <!-- process-wording: the coding agents' rules file, in the section about agents -->
- Treat agent output as a confident junior's PR, especially around `tabbrowser` and SessionStore: Firefox's own source and Zen's components are the tiebreak, not memory.

---

## 9. Risks and open questions

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Rebase pain: upstream front-end files churn and our `.patch` hunks stop applying | High, monthly | ADR-003 (own files, minimal injection); `upstream.yml` tries first; patch-size audit in the Sunday run; `docs/rebase.md` playbook |
| Full Firefox build too slow/expensive for CI | High | PR jobs use artifact builds on hosted runners (ADR-010); full builds (nightly and release) run on GitHub-hosted runners too, never a self-hosted one ([#224](https://github.com/vimma-browser/vimma/issues/224), spec `build-supply-chain`) |
| Split view destabilises tab selection, focus, URL bar | High | Build on Firefox's tested split view (ADR-013), a contract mochitest, mochitest every pane op, `prefix+z` as escape hatch |
| Insert-mode detection wrong on complex editors (Google Docs, Monaco) | Medium | Actor heuristics + per-site overrides in config; Tridactyl's rules as reference |
| Firefox's updater needs an update server | Medium | Serve a static update XML from GitHub Pages/Releases as Zen does; M6 |
| Surfer is a small project | Medium | It is a thin Node CLI over `mach`; fork it into `tools/` if it stalls |
| Scope creep toward "Zen with vim keys" | Medium | Specs gate everything; anything not in M0–M6 waits as a `planned` issue |
| Hidden-tab performance with hundreds of tabs across workspaces | Low | Firefox handles hidden tabs well; measure in e2e with 200 tabs |

Open questions to settle in M0 (each becomes an ADR or a line in `docs/limits.md`):

- [x] PR build strategy: `surfer build --ui` on a cached engine vs Firefox artifact builds — which works with release tarballs? Artifact builds, on hosted runners (ADR-010).
- [x] Side panel: custom box in the window layout or Firefox's sidebar framework (`SidebarController`)? Our own box, inserted from JS (`docs/specs/m3-workspaces.md`).
- [x] Where does the control socket's auth token live, and should it be off by default in release builds? In `<profile>/vimma-control.json` (0600); off by default in all builds, pref `vimma.control.enabled` (spec m0-control-protocol-and-vimma-ctl).
- [x] Omarchy adapter: neither; read the theme's `colors.toml`, which every Omarchy 4 theme ships (`docs/notes/omarchy-theming.md`).
- [x] Starter workspaces (work/admin/personal) created on first run, or only shipped as the commented example? Commented example; first run creates one `main` (`docs/specs/m3-workspaces.md`).
- [ ] Flatpak alongside AUR from M6, or later?

---

## 10. Where the rest went

The first-session checklist that was here is done (M0), and the starter `CLAUDE.md` that was appendix A grew into the repository's [`CLAUDE.md`](CLAUDE.md), which is the version to read.
<!-- process-wording: points at the coding agents' rules file that replaced the appendix -->
