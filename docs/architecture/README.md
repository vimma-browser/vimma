# Architecture walkthroughs

[ARCHITECTURE.md](../../ARCHITECTURE.md) is the map: processes, folders, dependencies and trust
boundaries. The pages here are the next level of detail. Each follows one thing through the code
from start to end, in order, with a sequence diagram, the real file and function names, what can
refuse or fail at each step, and where that is tested. They link to the specs, decision records,
[docs/security.md](../security.md) and [docs/runbook.md](../runbook.md) for the rules and the
procedures rather than repeating them.

| Page                                                              | Follows                                                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [The life of an agent call](agent-call.md)                        | An MCP tool call: `vimma-ctl mcp`, the control socket, the agent gate, the page, and back |
| [From a release tag to an offered update](updates-and-release.md) | A Vimma release: release-please, `release.yml`, signing, the manifest, the client's check |
| [From a Firefox release to a merged bump](upstream-autopilot.md)  | A Firefox release: detection, source verification, the patch check, the suites, the merge |

Planned pages ([#932](https://github.com/vimma-browser/vimma/issues/932)):

- The life of a keypress: `keydown`, the dispatcher, the action runners, the actor.
- Workspaces and panes: vimma-core's model, the window's mirror of it, and SessionStore.
- Config and theme: `config.toml`, validation, theme tokens, CSS, and the Omarchy adapter.
- The test pyramid: Vitest, contract fixtures, mochitests, e2e scenarios and the site suites.
