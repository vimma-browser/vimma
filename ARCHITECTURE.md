# Architecture

This page is the map of Vimma's code: what Vimma adds on top of Firefox, which processes take
part when it runs, what each folder holds, how the folders depend on each other today, and where
the trust boundaries are. It is written for someone who has not worked on Vimma before. It names
folders and roles, not line numbers; the feature specs in [docs/specs/](docs/specs/) and the
decisions in [docs/adr/](docs/adr/) hold the detail, and [docs/README.md](docs/README.md) says
which page to read for what. The walkthroughs in [docs/architecture/](docs/architecture/) follow
one flow each through the code, step by step.

## What Vimma adds to Firefox

Vimma is Firefox with a keyboard layer, workspaces, split panes, a status bar and local AI agent
access added to its browser window. Gecko (page rendering, networking, the sandbox) is Firefox's,
unchanged. Firefox's browser window is itself written in JavaScript, CSS and XHTML, so nearly
everything Vimma adds is front-end code that runs in the browser's own privileged ("chrome")
context ([ADR-001](docs/adr/001-engine-firefox-surfer.md)).

The fork is built with [Surfer](https://github.com/zen-browser/surfer), the toolchain Zen Browser
uses:

- `surfer.json` pins the Firefox release Vimma is built on. `npx surfer download` fetches that
  release's source into `engine/` (git-ignored, never edited by hand); `npm run import` refuses
  an `engine/` whose source was not checked against Mozilla's signature
  (`tools/upstream/verify-source.sh`, [ADR-021](docs/adr/021-mozilla-release-key.md)), then
  lays `src/` over it.
- `src/` mirrors Firefox's source tree. Whole files are Vimma's own and are linked into `engine/`
  at the same path; `*.patch` files are small edits to upstream files, applied by Surfer.
- Vimma's code lives in its own files under `src/browser/base/content/vimma/`; an upstream file is
  patched only to load them, in the smallest hunk possible
  ([ADR-003](docs/adr/003-own-files-minimal-patches.md), which keeps the register of every
  patch). The one that matters most is `src/browser/base/content/browser-xhtml.patch`: it adds a
  `<script>` tag that loads `vimma/vimma.js` into every browser window. About 25 patches exist
  today: 10 change user-facing strings, the other 15 wire Vimma in or adjust one Firefox
  behaviour. `patch-audit.yml` reviews them every quarter.
- `packages/vimma-core` is Vimma's logic with no Firefox in it
  ([ADR-005](docs/adr/005-pure-core-package.md)). `npm run sync-core` copies it into
  `src/browser/base/content/vimma/core/` (git-ignored), where the chrome code imports it.
- Code is JavaScript ES modules with JSDoc types, checked by `tsc --checkJs`
  ([ADR-004](docs/adr/004-javascript-jsdoc.md)); `tools/vimma-ctl` is Rust
  ([ADR-011](docs/adr/011-vimma-ctl-rust.md)).

There are two ways to build. A **full build** compiles all of Firefox (about 40 minutes) and is
what releases, the nightly and macOS ship. An **artifact build** puts Vimma's front end on top of
Mozilla's own compiled binaries for the same release, takes under a minute when warm, and is what
pull requests test ([ADR-010](docs/adr/010-pr-artifact-builds.md)). A change to a `.patch`
file, C++, `moz.build`, `configs/` or branding needs a full build to verify. Commands:
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/runbook.md](docs/runbook.md).

## The running system

```mermaid
flowchart LR
  subgraph vimma["Vimma (one app)"]
    subgraph parent["Parent process: browser windows"]
      chrome["vimma.js, then host/, ui/, workspaces/,<br/>split/, config/ ... with core/"]
      ctl["ctl/: control socket server<br/>and AgentGate"]
      agent["agent/: built-in agent"]
    end
    subgraph content["Content processes (sandboxed)"]
      child["actors/: VimmaChild,<br/>one per frame"]
    end
    chrome <-- "JSWindowActor messages" --> child
    chrome --- ctl
    agent -- "same gate as MCP agents" --> ctl
  end
  cli["vimma-ctl (CLI)"] -- "TCP 127.0.0.1, token" --> ctl
  mcp["vimma-ctl mcp"] -- "TCP 127.0.0.1, agent role" --> ctl
  host["AI agent host<br/>(MCP client)"] -- "MCP over stdio" --> mcp
  e2e["tools/e2e harness"] -- "TCP 127.0.0.1" --> ctl
  agent -- "HTTPS, or HTTP to a local server" --> models["Model providers<br/>(Anthropic API, OpenAI-compatible, local)"]
  agent -- "subprocess, one-time ticket" --> clis["Agent CLIs<br/>(Claude Code, Codex, Gemini CLI)"]
  clis --> mcp
  chrome -- "HTTPS, signed manifest" --> updates["updates.vimma.dev"]
  files["config.toml,<br/>Omarchy colors.toml"] -- "polled" --> chrome
  omarchy["Omarchy theme-set hook"] -- "-vimma-reload-theme<br/>(command-line remoting)" --> chrome
  chrome -- "Hyprland IPC socket" --> hypr["Hyprland"]
```

- **Parent process.** Firefox runs every browser window in one privileged process. `vimma.js` runs
  in each window and starts Vimma's modules there; most of them are one per app (the module is
  shared by every window), some keep state per window. All of Vimma's own UI (status bar, command
  line, pickers, side panel, help overlay, agent prompt) is HTML and CSS in this process.
- **Content processes.** Web pages run in sandboxed processes. Vimma reaches them only through
  one JSWindowActor pair: `VimmaChild` runs in every frame and reports focus changes, scrolls,
  collects link hints, drives the caret, searches text; `VimmaParent` hands its reports to the
  host, and the host sends commands through `actors/VimmaActors.sys.mjs`.
- **The control socket.** Off by default. A local TCP server on 127.0.0.1 and a random port,
  speaking JSON lines; a client proves it holds the token in `<profile>/vimma-control.json`
  (mode 0600) before any command ([ADR-007](docs/adr/007-control-socket.md),
  [spec](docs/specs/m0-control-protocol-and-vimma-ctl.md)). Protocol 2 has two roles: `full`
  (keys, state, open, theme; the pref `vimma.control.enabled`) and `agent` (only the agent
  commands, confined to the agent workspace and asked of the user; `[mcp] enabled` or `:mcp on`,
  [spec](docs/specs/vimma-mcp.md), [ADR-019](docs/adr/019-agents-over-mcp.md)). One call's way
  through it: [The life of an agent call](docs/architecture/agent-call.md).
- **vimma-ctl.** One Rust binary, shipped next to the browser: `vimma-ctl <command>` is the
  scripting client, and `vimma-ctl mcp` is an MCP server over stdio that an AI agent host starts,
  which connects to the browser as the `agent` role.
- **The built-in agent.** A chat window inside Vimma. Its model calls go straight to the
  provider's HTTP API; its tool calls go through the same gate, grants and log as an outside
  agent's, in process. It can also run an agent CLI as a subprocess, whose only MCP server is
  `vimma-ctl mcp` with a one-time ticket ([builtin-agent](docs/specs/builtin-agent.md),
  [builtin-agent-cli](docs/specs/builtin-agent-cli.md)).
- **Outside the browser.** The update check reads a signed manifest from updates.vimma.dev
  ([m6a-updater](docs/specs/m6a-updater.md), [ADR-016](docs/adr/016-own-update-channel.md)).
  `config.toml` and the Omarchy theme file are polled every 2 s, because Firefox has no portable
  file watcher. Omarchy's theme-set hook makes the theme reload at once through Firefox's
  command-line remoting. On Hyprland, the private workspace can swap in place of the window
  through Hyprland's IPC socket ([ADR-017](docs/adr/017-window-manager-ipc.md)).

## How a key is handled

1. `host/VimmaHost.sys.mjs` listens for `keydown` on the browser window in the capture phase, so
   it sees a key before the address bar, Firefox's own pages, the PDF viewer and the page. The
   one exception is a page-first binding: its key goes to the page first, and Vimma acts only if
   the page left it alone ([firefox-keys](docs/specs/firefox-keys.md), decision 6).
2. It turns the event into a chord (`ctrl+b`, `shift+t`) and asks vimma-core's dispatcher what it
   means in the current mode. The modes are `normal`, `insert`, `visual`, `command`, `hint`,
   `element`, `help`, `panel`, `resize` and `index`; a pending `ctrl+b` prefix is tracked by the
   dispatcher itself (`packages/vimma-core/src/modes.mjs`).
3. The dispatcher answers with an action, "pending" (more keys may follow), "cancel" (a pending
   sequence ends with no action, such as an unknown key after `ctrl+b`) or "pass". A key that
   passes reaches Firefox and the page untouched.
4. An action is a name from the closed list in `packages/vimma-core/src/actions.mjs`. The host
   runs it in the browser window (tab, pane, workspace, picker and other chrome actions, in
   `VimmaHost.sys.mjs` and the `host/*-ops.mjs` modules) or sends it to the focused page through
   the actor (scroll, hints, caret, find).
5. The status bar, help overlay and pickers redraw from the same state. `ctrl+b ?` renders the
   binding table the dispatcher uses, so the help cannot drift from the keys.

The keymap is vimma-core's defaults (`defaults.mjs`) merged with the user's `config.toml`; every
key, the prefix and the leader can be remapped. `npm run gen-docs` writes
[docs/bindings.md](docs/bindings.md) from the same tables. Which keys Vimma takes from Firefox and
from pages: [docs/specs/firefox-keys.md](docs/specs/firefox-keys.md) and
[ADR-024](docs/adr/024-keymap-contexts.md).

## Module map

### `src/browser/base/content/vimma/`

`vimma.js` is the entry point. It starts the modules in a fixed order, each step commented with
its reason: the process-wide services (the app launcher first, before anything starts Firefox's
shell service), the start page, `about:vimma`, the address bar's rows, the actors, the theme and
the Omarchy hook, the host, workspaces, split panes, `config.toml`, the first-run setup, the
update check, the control server, the agent modules and the private-workspace swap. `jar.mn` lists
every file that ships; `moz.build` adds the folder to the build.

| Folder              | Role                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vimma/host/`       | `VimmaHost.sys.mjs`: key capture, dispatch through vimma-core, modes, and the action runners. The `*-ops.mjs` files apply one area's actions to Firefox (tabs, panes, workspaces, bookmarks, downloads, permissions, PDF, MCP). `hypr/HyprIpc.sys.mjs` talks to Hyprland's IPC sockets, checked against core's whitelist ([ADR-017](docs/adr/017-window-manager-ipc.md)). |
| `vimma/actors/`     | The JSWindowActor pair (`VimmaParent`, `VimmaChild`) and what runs in the page: hint collection, caret and text model, Enter key, the PDF viewer, live grep's matcher and its worker.                                                                                                                                                                                     |
| `vimma/ui/`         | Vimma's own UI in the browser window: status bar, command line, help overlay, hints overlay, pickers, side panel, bookmarks panel, prompts, notices, the agent chat window, the theme (`theme-host.mjs`).                                                                                                                                                                 |
| `vimma/workspaces/` | Workspaces as Firefox containers: the app's workspace definitions and their file, each window's tab membership and hidden tabs, and the `[[routes]]` rules that send a URL to a workspace.                                                                                                                                                                                |
| `vimma/split/`      | Split panes on Firefox's own split view ([ADR-013](docs/adr/013-split-on-firefox-split-view.md)): the window's pane tree and the CSS geometry.                                                                                                                                                                                                                            |
| `vimma/config/`     | `ConfigHost.sys.mjs`: reads and polls `config.toml`, hands each validated part to the module that uses it, keeps the last good config on an error.                                                                                                                                                                                                                        |
| `vimma/ctl/`        | The control socket server (`VimmaControl.sys.mjs`), the agent gate (`AgentGate.sys.mjs`) and the agent commands: open, read, keys, elements, fill, activate, screenshot, console, downloads, page limits.                                                                                                                                                                 |
| `vimma/agent/`      | The built-in agent: conversations, agent CLI runs, API keys in the OS keyring, encrypted stored conversations.                                                                                                                                                                                                                                                            |
| `vimma/updates/`    | The update check and the AppImage's self-update ([m6a-updater](docs/specs/m6a-updater.md)).                                                                                                                                                                                                                                                                               |
| `vimma/search/`     | `config.toml`'s `[search]` applied to Firefox's search engines, and how the address bar shares its rows.                                                                                                                                                                                                                                                                  |
| `vimma/omarchy/`    | The Omarchy theme-set hook script and the command-line handler that reloads the theme.                                                                                                                                                                                                                                                                                    |
| `vimma/services/`   | Process-wide adjustments to Firefox: the app launcher name, Mozilla service defaults, the wake lock for video, downloads that open in a tab.                                                                                                                                                                                                                              |
| `vimma/about/`      | `about:vimma`: mode, recent keys, config errors, versions, patch count, a redacted bug report.                                                                                                                                                                                                                                                                            |
| `vimma/setup/`      | `about:vimma-setup`, the first-run setup page and its privileged half.                                                                                                                                                                                                                                                                                                    |
| `vimma/start/`      | The start page used as the home and new-tab page.                                                                                                                                                                                                                                                                                                                         |
| `vimma/licence/`    | Vimma's parts of `about:license`, which the build merges into Firefox's licence page.                                                                                                                                                                                                                                                                                     |

### `packages/vimma-core`

Pure ES modules, about 80 of them in one flat `src/` folder, tested with Vitest in Node. No Firefox
API and no Node built-in may be imported there; eslint enforces it. The areas:

- **Keys and modes:** key notation (`keys.mjs`), the action list (`actions.mjs`), default
  bindings (`defaults.mjs`), keymap merge (`keymap.mjs`), the dispatcher, modes, Escape, the
  command line, Firefox's own shortcuts, help.
- **Browser model:** tabs, tab labels, workspaces and their definitions, panes and split plans,
  layouts, the side panel, pickers, the status bar text, routing rules, private workspace rules.
- **Page modes:** editable detection, hints, find, live grep, text blocks, motions, PDF.
- **Config and theme:** the TOML parser (vendored smol-toml,
  [ADR-012](docs/adr/012-toml-parser-smol-toml.md)), config validation and migrations, theme tokens, search engines, site permissions.
- **Control and agents:** the control protocol validator, the agent gate's queue and grants, the
  agent's tools, prompts, model providers and loop, agent CLIs, stored conversations.
- **Updates and setup:** manifest checks and pinned update keys, update notices, the first-run
  setup, add-ons.

`index.mjs` re-exports the public part. Generated files: `agent-tools-data.mjs`
(`npm run gen-agent-tools`) and `update-keys.mjs` (`npm run gen-update-keys`).

### The rest of `src/`, and `configs/`

- `src/browser/themes/shared/vimma/`: the CSS of Vimma's UI and of the Firefox surfaces it
  restyles.
- `src/browser/branding/vimma/`: default prefs (`firefox-branding.js`, where unfinished features'
  `vimma.feature.*` prefs live), brand strings. `configs/branding/` holds the icons.
- `src/**/*.patch`: the upstream edits, each listed in ADR-003.
- `configs/`: mozconfigs per platform and the updater's certificates.

### `tests/`

- `tests/browser/`: mochitests (`browser_vimma_*.js`), Firefox's browser test framework, run on a
  real build.
- `tests/e2e/`: scenarios driven through the control socket, with screenshot baselines.
- `tests/contract/`: fixtures for each version of the control protocol, the config, the state
  file and the workspace file, and sample Omarchy themes; vimma-core's tests read them all, and
  vimma-ctl's the protocol ones.

### `tools/`

| Folder                      | Role                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tools/vimma-ctl/`          | The Rust control-socket client and `vimma-ctl mcp`, the MCP server.                                         |
| `tools/e2e/`                | The end-to-end harness: launches a build with a throwaway profile under Xvfb and drives it by socket.       |
| `tools/artifact-build/`     | The artifact build that pull requests test.                                                                 |
| `tools/import/`             | Helpers for `npm run import`: restoring patched files, linking the update certificates.                     |
| `tools/lanes/`              | Parallel browser lanes: a worktree with its own copy of `engine/`.                                          |
| `tools/upstream/`           | The upstream autopilot and Beta canary: detecting Firefox releases, verifying source, bumping, patch audit. |
| `tools/release/`            | Release notes, the version line, build ids, and the self-releasing security bump.                           |
| `tools/package/`            | Release packages: tarball, AppImage, `.deb`, `.rpm`, PKGBUILD, Flatpak, macOS app and dmg, SBOM.            |
| `tools/update/`             | The update manifest, MAR files and signing certificates.                                                    |
| `tools/version-files/`      | The app version files the build reads.                                                                      |
| `tools/branding/`           | Generated brand strings and icon rendering.                                                                 |
| `tools/sites/`              | The site-compatibility suite, live and from recorded pages.                                                 |
| `tools/bench/`              | The key-to-action benchmark and its regression gate.                                                        |
| `tools/agent-bench/`        | The built-in agent's model bench against a local test shop ([docs/agent-bench.md](docs/agent-bench.md)).    |
| `tools/mutation/`           | The report of Stryker mutation testing.                                                                     |
| `tools/spec-lint/`          | Checks of spec and ADR headers, decision reasons, and spec statuses against their issues.                   |
| `tools/md-wording/`         | Checks that Markdown and comments are written for outside readers.                                          |
| `tools/arch-lint/`          | Checks that this page names every folder and workflow ("Keeping it current" below).                         |
| `tools/security/`           | Checks that every test link in [docs/security.md](docs/security.md) resolves.                               |
| `tools/license-check/`      | Licence checks of npm packages and Rust crates.                                                             |
| `tools/deps/`               | Which npm packages the release build runs, so their updates wait for a person.                              |
| `tools/commitlint/`         | The commitlint rule that a feature or fix commit has a body.                                                |
| `tools/ci/`                 | CI helpers: docs-only pull requests, trees a pull request already passed, the release-key guard.            |
| `tools/test/`               | Tests of the workflows, the build scripts and repository-wide rules.                                        |
| `tools/omarchy/`            | Tests of the Omarchy theme-set hook script.                                                                 |
| `tools/stats/`              | Daily release download counts.                                                                              |
| `tools/promo/`              | Recording the screenshots and clips used to present Vimma.                                                  |
| `tools/unicode/`            | Generates the wide-character table vimma-core uses to measure text.                                         |
| `tools/safebrowsing-smoke/` | A manual check that a build's Safe Browsing key fetches lists.                                              |
| `tools/claude-plugin/`      | The Claude Code plugin whose hooks enforce the repository's contributor rules.                              |

The scripts at the top of `tools/` are the `npm run` entry points (`build.mjs`, `start.mjs`,
`mochitest.mjs`, `sync-core.mjs`, `gen-docs.mjs` and others).

## Dependency direction, as it is today

One rule is enforced: **vimma-core depends on nothing.** `eslint.config.mjs` fails on any
`chrome://`, `resource://` or Node import, and on Firefox globals, in `packages/vimma-core/src/`.
Most folders under `vimma/` import core.

Among the chrome folders there is no enforced layering. `vimma.js` imports them all. Some
folders are leaves: `services/`, `search/`, `updates/` and `split/` import only core, `omarchy/`
and `start/` only `ui/`, and `setup/` core, `config/` and `ui/`. The host is the hub, and the
imports around it run both ways today:

```text
  leaves:  services/ search/ updates/ split/ ──▶ core
           omarchy/ start/ ──▶ ui/          setup/ ──▶ core, config/, ui/

  host/  ──imports──▶  actors/ agent/ ctl/ config/ ui/ workspaces/ about/ split/ search/ updates/
  host/  ◀──imports──  actors/ agent/ ctl/ config/ ui/ workspaces/ about/

  also both ways:  config/ ⇄ ui/;  longer loops such as ui/ → agent/ → host/ → ui/
```

So `ctl/`, `workspaces/`, `actors/`, `agent/`, `config/`, `ui/` and `about/` each import a module of
`host/`, and `host/` imports each of them back: the folders form cycles rather than layers. These
are static ES module imports in one process, so they work, but a change to the host can reach
almost every folder. Issue [#936](https://github.com/vimma-browser/vimma/issues/936) tracks
breaking these cycles; until it lands, do not read the folder list as a layering.

## State and where it lives

| State                                           | Where                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Keymap, workspaces, theme, `[mcp]` and the rest | `$XDG_CONFIG_HOME/vimma/config.toml`; Vimma writes it only when asked (first-run setup, `:config` on a missing file, `:route add`) |
| Workspace definitions                           | `<profile>/vimma-workspaces.json`                                                                                                  |
| Tab membership, labels, pane trees per window   | Firefox SessionStore values on tabs and windows                                                                                    |
| Control socket port and token                   | `<profile>/vimma-control.json`, mode 0600, written when the server starts                                                          |
| Agent gate, grants, `:mcp log`                  | Memory only; a restart ends them                                                                                                   |
| Built-in agent's conversations and API keys     | `<profile>/vimma/agent/`, encrypted with the OS keyring; keys in Firefox's login store under the same encryption                   |
| Switches and small settings                     | Prefs (`vimma.*`), default values in `firefox-branding.js`                                                                         |

Persisted formats carry a version and have fixtures in `tests/contract/`; the specs
([m3-workspaces](docs/specs/m3-workspaces.md), [m5-config-load](docs/specs/m5-config-load.md))
give the schemas.

## Trust boundaries

[docs/security.md](docs/security.md) is the contract: one rule per risky component, each with the
tests that enforce it. In short:

- **Pages** are untrusted. Vimma reaches them only through the actor pair, and what it takes from
  a page (a link, a title, text) is shown or opened under the rules of security.md §4, §6 and
  §13.
- **Local programs** reach Vimma through the control socket, which is off by default, bound to
  127.0.0.1, and needs the token; the `agent` role reaches only the agent workspace, and every
  request waits for the user's answer or a grant they gave (§1, §12). The other way in is the
  command line (`vimma <url>`, or `vimma-open` from a desktop entry): Firefox's own flags, plus
  Vimma's `-vimma-from` for routing and `-vimma-reload-theme` (§2, §7).
- **AI agents** are bounded inside Vimma, not outside it: what an agent does with its own shell is
  out of scope (§11, §12).
- **`config.toml`, routing rules and theme files** are parsed by vimma-core with strict
  validation and fuzzed (§2, §8).
- **Updates** are accepted only with a signature against keys pinned in the build (§16).
- **The build and release pipeline** verifies or pins every input and keeps its signing and
  publishing secrets out of pull request runs (§10, §14).

## Testing

| Layer       | Covers                                                                 | Where and gate                                                                                   |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit        | vimma-core and `tools/`                                                | Vitest (`npm test`); 90 % line, branch and function coverage of vimma-core (`vitest.config.mjs`) |
| Property    | Parsers of outside input                                               | fast-check: a fixed seed on every pull request, a random seed nightly (`fuzz.yml`)               |
| Contract    | Control protocol, config, state and workspace files                    | `tests/contract/`, read by vimma-core's tests; the protocol fixtures by vimma-ctl's too          |
| Rust        | vimma-ctl                                                              | `cargo test`, `cargo clippy -- -D warnings`                                                      |
| Browser     | The host on a real build: keys, actions, UI, actors, workspaces, panes | Mochitests on an artifact build, every pull request (`e2e.yml`)                                  |
| End to end  | A real build driven through the socket, with screenshots               | `tools/e2e`; 0.5 % pixel tolerance, the suite under 5 minutes                                    |
| Performance | Key-to-action in core; key-to-paint in the window                      | `tools/bench`: under 50 µs per key and no regression above 10 %; `browser_vimma_perf.js`         |
| Mutation    | Whether core's tests catch changes                                     | Stryker weekly (`mutation.yml`); survivors go to one tracking issue                              |
| Sites       | Real websites                                                          | Recorded pages on every pull request; live sites nightly, as a report (`sites.yml`)              |

Tests are written before the code they test, and a baseline or snapshot changes only with a
reason in the commit body ([CONTRIBUTING.md](CONTRIBUTING.md), "Workflow"). CI never retries a
test: a flaky one gets an issue and a fix for its cause ([docs/runbook.md](docs/runbook.md),
"Testing").

## Automation and release infrastructure

Every workflow in `.github/workflows/`. Setup, secrets and recovery for each are in
[docs/runbook.md](docs/runbook.md), "CI and automation"; the security rules for those that hold
secrets are in security.md §10 and §14.

| Workflow                   | Runs on                     | What it does                                                                                                                          |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                   | Pull requests, `main`       | Lint, typecheck, Vitest with coverage, the bench gate, commitlint, licences, vimma-ctl tests.                                         |
| `e2e.yml`                  | Pull requests               | Artifact build, mochitests (Linux and macOS), e2e scenarios, the recorded-site gate.                                                  |
| `key-guard.yml`            | Pull requests               | Holds a change to Mozilla's pinned release key until a maintainer labels it.                                                          |
| `pkgbuild.yml`             | Packaging changes           | Builds and installs the Arch package, the `.rpm` and the Homebrew cask from a stub.                                                   |
| `flatpak.yml`              | Packaging changes, releases | Builds and runs the Flatpak.                                                                                                          |
| `macos.yml`                | Weekly, macOS changes       | Cross-compiles the macOS build on Linux and smoke-tests it on a Mac.                                                                  |
| `semgrep.yml`              | Pull requests, weekly       | Static analysis.                                                                                                                      |
| `codeql.yml`               | Pull requests, weekly       | CodeQL code scanning.                                                                                                                 |
| `nightly.yml`              | Daily                       | Full Linux build and mochitests; a nightly package, and nightly update files.                                                         |
| `fuzz.yml`                 | Daily                       | Property tests with a random seed; failures open an issue.                                                                            |
| `sites.yml`                | Daily                       | The live site-compatibility report.                                                                                                   |
| `mutation.yml`             | Weekly                      | Stryker mutation testing of vimma-core.                                                                                               |
| `patch-audit.yml`          | Quarterly                   | Reviews every upstream patch against ADR-003's register and budgets.                                                                  |
| `spec-status.yml`          | Daily, issue events         | Compares spec statuses with their issues.                                                                                             |
| `downloads.yml`            | Daily                       | Records release download counts on the `stats` branch.                                                                                |
| `upstream.yml`             | Every 4 hours               | The upstream autopilot: a new Firefox release becomes a rebased, tested pull request ([ADR-015](docs/adr/015-upstream-autopilot.md)). |
| `upstream-beta.yml`        | Every 6 hours               | Tests `main` against each Firefox Beta.                                                                                               |
| `upstream-merge.yml`       | After the bump's checks     | Sets a green Firefox bump to merge itself ([ADR-022](docs/adr/022-green-bump-merges-itself.md)).                                      |
| `release-please.yml`       | `main`                      | Keeps the release pull request; on merge, tags and starts the release; auto-merges it after a security bump.                          |
| `release.yml`              | Started by release-please   | Full builds for Linux and macOS, packages, signatures, SBOM, upload to the draft release.                                             |
| `update-publish.yml`       | A published release         | Signs the update manifest and publishes it to updates.vimma.dev.                                                                      |
| `aur.yml`                  | A published release         | Pushes `vimma-bin` to the AUR; skipped until the `AUR_SSH_KEY` secret exists.                                                         |
| `homebrew.yml`             | A published release         | Pushes the cask to the Homebrew tap.                                                                                                  |
| `site-dispatch.yml`        | Bindings change, releases   | Tells vimma.dev to sync the key list or the latest release.                                                                           |
| `dependabot-automerge.yml` | Dependabot pull requests    | Lets patch and minor updates merge once green, except Actions and the release path.                                                   |
| `claude.yml`               | Issue and review comments   | Claude Code answering `@claude` in issues and pull requests.                                                                          |

How a release flows: release-please keeps a release pull request open; merging it tags the
version and creates a draft release; `release.yml` builds, signs and uploads the packages; a
maintainer publishes the draft, which starts `update-publish.yml`, `aur.yml` and `homebrew.yml`.
With `AUTO_SECURITY_RELEASE` on, a merged Firefox security bump becomes a draft release with no
person acting; publishing the draft stays a person's click
([ADR-020](docs/adr/020-security-release-without-a-person.md)). Step by step:
[From a release tag to an offered update](docs/architecture/updates-and-release.md) and
[From a Firefox release to a merged bump](docs/architecture/upstream-autopilot.md).

## Keeping it current

`npm run arch-lint` (part of `npm run lint`, and a step of its own in `ci.yml`, docs-only pull
requests included) runs `tools/arch-lint/arch-lint.ts`, which fails when a folder under
`src/browser/base/content/vimma/`, a folder under `tools/` or a workflow is not named here, or
when this page names one that no longer exists. A name counts in a code span written as
`` `vimma/<folder>/` ``, `` `tools/<folder>/` `` or `` `<workflow>.yml` `` (or `.yaml`). Adding a folder or a
workflow therefore means adding its line here in the same pull request.
