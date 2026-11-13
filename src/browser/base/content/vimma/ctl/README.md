# `vimma/ctl/`

The control socket and what agents may do through it. `VimmaControl.sys.mjs` is the server
(protocol 2, full and agent roles); `AgentGate.sys.mjs` asks the user and keeps the grants and
the log; `agent-commands.mjs` runs the agent commands (open, read, keys, elements, fill,
activate, screenshot, console, downloads) in the agent workspace, through the `Agent*.sys.mjs`
modules beside it.

**Entry points:** `VimmaControl.init(window)`, `AgentPages.init()` and `AgentConsole.init()`,
called by `vimma.js`; `runAgentCommand`, which the built-in agent calls too.

**May import (layer 4, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, the layer 1 and
2 folders, and `host/`. Not `config/` (same layer) or above.

**Security:** this folder is a trust boundary. Read [docs/security.md](../../../../../../docs/security.md)
sections 1 and 12 before changing it; a change gets a separate security review.

**Read more:** [An agent's call](../../../../../../docs/architecture/agent-call.md),
[ADR-019](../../../../../../docs/adr/019-agents-over-mcp.md), [vimma-mcp](../../../../../../docs/specs/vimma-mcp.md).
