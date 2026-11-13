# Vimma's documentation

Where to read about what. Users start with the guide; contributors with
[CONTRIBUTING.md](../CONTRIBUTING.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

## To understand …, read …

| To understand                                          | Read                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| What Vimma does and how to use it                      | [guide.md](guide.md), and [bindings.md](bindings.md) for every key (generated)                |
| What Vimma does not do yet, or cannot                  | [limits.md](limits.md)                                                                        |
| How the code is organised, and what talks to what      | [ARCHITECTURE.md](../ARCHITECTURE.md)                                                         |
| How one flow runs through the code, step by step       | [architecture/](architecture/): an agent call, a release and update, a Firefox bump           |
| How to build, test and contribute                      | [CONTRIBUTING.md](../CONTRIBUTING.md)                                                         |
| Where the project stands and what comes next           | [roadmap.md](roadmap.md)                                                                      |
| Why a past decision was made                           | [adr/](adr/), the decision records below                                                      |
| How a feature behaves, in detail                       | [specs/](specs/), grouped below; [specs/README.md](specs/README.md) for how a spec is written |
| What each risky component may and must never do        | [security.md](security.md); reporting a vulnerability: [SECURITY.md](../SECURITY.md)          |
| Builds, CI, lanes, releases, signing keys and recovery | [runbook.md](runbook.md)                                                                      |
| Moving Vimma to a new Firefox release                  | [rebase.md](rebase.md)                                                                        |
| What a pull request needs before it merges             | [review-checklist.md](review-checklist.md)                                                    |
| How the built-in agent's models compare                | [agent-bench.md](agent-bench.md)                                                              |
| How the Omarchy theme is read                          | [notes/omarchy-theming.md](notes/omarchy-theming.md)                                          |

## Decision records

| ADR                                                 | Decision                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| [001](adr/001-engine-firefox-surfer.md)             | Engine: Firefox fork built with Surfer                                          |
| [002](adr/002-upstream-release-channel.md)          | Upstream: Firefox release channel                                               |
| [003](adr/003-own-files-minimal-patches.md)         | Our code lives in our own files                                                 |
| [004](adr/004-javascript-jsdoc.md)                  | Language: JavaScript ES modules with JSDoc types (amended by ADR-025)           |
| [005](adr/005-pure-core-package.md)                 | `vimma-core` is a pure ES module package                                        |
| [006](adr/006-vendor-zen-split-view.md)             | Split view is vendored from Zen (superseded by ADR-013)                         |
| [007](adr/007-control-socket.md)                    | Control socket                                                                  |
| [008](adr/008-config-toml.md)                       | Config: one `config.toml`                                                       |
| [009](adr/009-flush-only-ambiguous.md)              | Only an ambiguous pending sequence times out                                    |
| [010](adr/010-pr-artifact-builds.md)                | PRs run the mochitests on a Firefox artifact build, on hosted runners           |
| [011](adr/011-vimma-ctl-rust.md)                    | vimma-ctl is written in Rust                                                    |
| [012](adr/012-toml-parser-smol-toml.md)             | The vendored TOML parser is smol-toml (BSD-3-Clause)                            |
| [013](adr/013-split-on-firefox-split-view.md)       | Split panes build on Firefox's own split view, not on vendored Zen code         |
| [014](adr/014-resize-mode.md)                       | Resize mode is a dispatcher mode                                                |
| [015](adr/015-upstream-autopilot.md)                | The upstream autopilot rebases, tests and opens the bump PR                     |
| [016](adr/016-own-update-channel.md)                | Vimma's own update channel                                                      |
| [017](adr/017-window-manager-ipc.md)                | Vimma talks to the window manager (Hyprland only, over its socket)              |
| [018](adr/018-macos-cross-build.md)                 | macOS is cross-compiled on Linux, arm64 first                                   |
| [019](adr/019-agents-over-mcp.md)                   | Agents reach Vimma over MCP, through a confined control-socket role             |
| [020](adr/020-security-release-without-a-person.md) | A security release needs no person                                              |
| [021](adr/021-mozilla-release-key.md)               | Mozilla's release key is the trust anchor for the Firefox source                |
| [022](adr/022-green-bump-merges-itself.md)          | A green Firefox bump merges itself                                              |
| [023](adr/023-in-browser-model-client.md)           | The built-in agent is a model client in the browser, through the agent commands |
| [024](adr/024-keymap-contexts.md)                   | Keymap contexts: a key's binding can depend on the document                     |
| [025](adr/025-typescript-for-tools.md)              | Node-side tooling under `tools/` is TypeScript that Node runs unbuilt           |

## Specs by area

Spec files keep the names they were written under; an `m0`–`m7` prefix is the milestone that
introduced the feature ([roadmap.md](roadmap.md)).

- **Keys and modes:** [m0-key-capture](specs/m0-key-capture.md),
  [m0-core-dispatcher](specs/m0-core-dispatcher.md), [m1-core-logic](specs/m1-core-logic.md),
  [key-handling-batch](specs/key-handling-batch.md), [firefox-keys](specs/firefox-keys.md),
  [m0-help-overlay](specs/m0-help-overlay.md), [m1-cmdline](specs/m1-cmdline.md),
  [m2-statusbar-whichkey](specs/m2-statusbar-whichkey.md).
- **The page:** [m1-actor-insert-scroll](specs/m1-actor-insert-scroll.md),
  [insert-focus](specs/insert-focus.md), [element-focus](specs/element-focus.md),
  [m1-hints](specs/m1-hints.md), [follow-link-switch](specs/follow-link-switch.md),
  [m1-find](specs/m1-find.md), [live-grep](specs/live-grep.md),
  [m1-copy-mode](specs/m1-copy-mode.md), [page-suggestions](specs/page-suggestions.md),
  [pdf-mode](specs/pdf-mode.md), [popup-blocked](specs/popup-blocked.md),
  [site-permissions](specs/site-permissions.md), [firefox-dialogs](specs/firefox-dialogs.md).
- **Tabs, panes and the side panel:** [m2-core-logic](specs/m2-core-logic.md),
  [m2-tab-keys](specs/m2-tab-keys.md), [m2-picker-rename](specs/m2-picker-rename.md),
  [tab-search](specs/tab-search.md), [m0-tabstrip-hidden](specs/m0-tabstrip-hidden.md),
  [m3-m4-core-prep](specs/m3-m4-core-prep.md), [m3-m4-core-models](specs/m3-m4-core-models.md),
  [m4-split-panes](specs/m4-split-panes.md), [multiple-splits](specs/multiple-splits.md),
  [tiling-layouts](specs/tiling-layouts.md), [pane-focus-highlight](specs/pane-focus-highlight.md),
  [m4-side-panel-multiselect](specs/m4-side-panel-multiselect.md),
  [side-panel-counts](specs/side-panel-counts.md),
  [side-panel-unsplit](specs/side-panel-unsplit.md).
- **Workspaces:** [m3-workspaces](specs/m3-workspaces.md),
  [workspace-routing](specs/workspace-routing.md), [app-routes](specs/app-routes.md),
  [private-workspace](specs/private-workspace.md), [private-swap](specs/private-swap.md),
  [private-swap-macos](specs/private-swap-macos.md).
- **Config, theme and Firefox's own surfaces:** [m5-config-load](specs/m5-config-load.md),
  [m5-core-config-and-theme](specs/m5-core-config-and-theme.md),
  [m5-omarchy-theme](specs/m5-omarchy-theme.md), [theme-appearance](specs/theme-appearance.md),
  [content-color-scheme](specs/content-color-scheme.md),
  [firefox-surfaces-theme](specs/firefox-surfaces-theme.md),
  [firefox-surfaces-trim](specs/firefox-surfaces-trim.md),
  [firefox-sidebar-theme](specs/firefox-sidebar-theme.md),
  [toolbar-toggle](specs/toolbar-toggle.md),
  [bookmarks-toolbar-hidden](specs/bookmarks-toolbar-hidden.md),
  [search-engines](specs/search-engines.md), [m7-a11y](specs/m7-a11y.md).
- **Pages and features of Vimma's own:** [m5-about-vimma](specs/m5-about-vimma.md),
  [start-page](specs/start-page.md), [first-run-setup](specs/first-run-setup.md),
  [bookmarks](specs/bookmarks.md), [downloads](specs/downloads.md),
  [addon-manager](specs/addon-manager.md), [wake-lock](specs/wake-lock.md).
- **Control socket and vimma-ctl:** [m0-control-server](specs/m0-control-server.md),
  [m0-control-protocol-and-vimma-ctl](specs/m0-control-protocol-and-vimma-ctl.md),
  [ship-vimma-ctl](specs/ship-vimma-ctl.md).
- **Agents and MCP:** [vimma-mcp](specs/vimma-mcp.md), [mcp-grants](specs/mcp-grants.md),
  [mcp-session-grants](specs/mcp-session-grants.md), [mcp-checkpoints](specs/mcp-checkpoints.md),
  [mcp-consequence](specs/mcp-consequence.md), [mcp-drive](specs/mcp-drive.md),
  [mcp-forms](specs/mcp-forms.md), [builtin-agent](specs/builtin-agent.md),
  [builtin-agent-cli](specs/builtin-agent-cli.md), [agent-speed](specs/agent-speed.md),
  [agent-modules](specs/agent-modules.md).
- **Firefox under Vimma:** [m0-mozilla-services](specs/m0-mozilla-services.md),
  [m0-user-agent](specs/m0-user-agent.md), [m0-safebrowsing-key](specs/m0-safebrowsing-key.md),
  [firefox-versions](specs/firefox-versions.md), [m0-rebase-playbook](specs/m0-rebase-playbook.md),
  [m7-upstream-autopilot](specs/m7-upstream-autopilot.md),
  [upstream-bump-automation](specs/upstream-bump-automation.md),
  [upstream-beta-canary](specs/upstream-beta-canary.md).
- **Build, CI and tests:** [m0-build-strategy](specs/m0-build-strategy.md),
  [m0-pipeline](specs/m0-pipeline.md), [m0-e2e-harness](specs/m0-e2e-harness.md),
  [ci-quality-gates](specs/ci-quality-gates.md), [m7-fuzzing](specs/m7-fuzzing.md),
  [site-compat](specs/site-compat.md), [build-supply-chain](specs/build-supply-chain.md).
- **Branding, versions, packaging and updates:** [m0-branding](specs/m0-branding.md),
  [m0-app-version](specs/m0-app-version.md), [release-versioning](specs/release-versioning.md),
  [m6-packaging](specs/m6-packaging.md), [rpm-package](specs/rpm-package.md),
  [flatpak](specs/flatpak.md), [macos-build](specs/macos-build.md),
  [macos-homebrew](specs/macos-homebrew.md), [m0-updater](specs/m0-updater.md),
  [m6a-updater](specs/m6a-updater.md), [update-notices](specs/update-notices.md),
  [site-keys-mirror](specs/site-keys-mirror.md).

## The former plan.md

The repository's first planning document, `plan.md`, was split up once its content had moved
into the pages above. Older specs, ADRs and code comments cite it as "plan §N"; this is where each
section's content lives now (the original is in git history):

| plan.md section             | Now                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 Decisions                | [adr/](adr/), listed above                                                                                                                                                                                        |
| §2 Interaction model        | [guide.md](guide.md), [bindings.md](bindings.md), and [ARCHITECTURE.md](../ARCHITECTURE.md), "How a key is handled"                                                                                               |
| §3 Architecture             | [ARCHITECTURE.md](../ARCHITECTURE.md)                                                                                                                                                                             |
| §4 Development life cycle   | [CONTRIBUTING.md](../CONTRIBUTING.md), "Workflow"; [specs/README.md](specs/README.md); [ARCHITECTURE.md](../ARCHITECTURE.md), "Automation and release infrastructure"                                             |
| §5 TDD and the test pyramid | [ARCHITECTURE.md](../ARCHITECTURE.md), "Testing"; [CONTRIBUTING.md](../CONTRIBUTING.md), "Workflow"                                                                                                               |
| §6 Roadmap, §9 Risks        | [roadmap.md](roadmap.md)                                                                                                                                                                                          |
| §7 Versioning and release   | [specs/release-versioning.md](specs/release-versioning.md), [specs/firefox-versions.md](specs/firefox-versions.md), [runbook.md](runbook.md), "Releases"                                                          |
| §8, §10 Coding agents       | <!-- process-wording: names the coding agents' rules file that replaced plan.md §8 --> [AGENTS.md](../AGENTS.md), the rules coding agents follow, and [CONTRIBUTING.md](../CONTRIBUTING.md), "Claude Code plugin" |
