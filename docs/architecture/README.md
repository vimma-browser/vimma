# Architecture walkthroughs

[ARCHITECTURE.md](../../ARCHITECTURE.md) is the map: processes, folders, dependencies and trust
boundaries. The pages here are the next level of detail. Each follows one thing through the code
from start to end, in order, with a sequence diagram, the real file and function names, what can
refuse or fail at each step, and where that is tested. They link to the specs, decision records,
[docs/security/](../security/README.md) and [docs/runbook/](../runbook/README.md) for the rules and
the
procedures rather than repeating them.

| Page                                                              | Follows                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [The life of a keypress](keypress.md)                             | A key: capture, the dispatcher, the runner tables, the actor pair, the page, and insert mode back  |
| [Workspaces and panes](workspaces-and-panes.md)                   | A workspace switch and a split: the core models, the window's mirror, saving and the restore       |
| [Config and theme](config-and-theme.md)                           | `config.toml` and the theme: the poll, parsing and checks, applying, the tokens, the Omarchy hook  |
| [The life of an agent call](agent-call.md)                        | An MCP tool call: `vimma-ctl mcp`, the control socket, the agent gate, the page, and back          |
| [From a release tag to an offered update](updates-and-release.md) | A Vimma release: release-please, `release.yml`, signing, the manifest, the client's check          |
| [From a Firefox release to a merged bump](upstream-autopilot.md)  | A Firefox release: detection, source verification, the patch check, the suites, the merge          |
| [Testing](testing.md)                                             | A pull request's checks and the scheduled runs: each layer, where it runs, and what is not covered |
