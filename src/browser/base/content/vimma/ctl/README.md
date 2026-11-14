# `vimma/ctl/`

The control socket (`VimmaControl.sys.mjs`, protocols 1 and 2) and the agent commands
(`agent-commands.mjs` and the `Agent*.sys.mjs` modules), which ask the agent gate,
`host/AgentGate.sys.mjs`, before they act
([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)).

**Entry points:** `VimmaControl.init(window)`, `AgentPages.init()` and `AgentConsole.init()`,
called by `vimma.js`; `runAgentCommand`, which the built-in agent calls too;
`AgentDownloads.isAgentDownload`, which `vimma.js` hands the host through
`host/host-services.mjs` for the downloads picker.

**May import (layer 4, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, the layer 1 and
2 folders, and `host/` (the gate among them). Not `config/` (same layer) or above, with no
exception.

**Security:** this folder is a trust boundary. Read
[docs/security/](../../../../../../docs/security/README.md)
sections 1 and 12 before changing it; a change gets a separate security review, as does one to
the gate in `host/`.

**Read more:** [An agent's call](../../../../../../docs/architecture/agent-call.md),
[ADR-019](../../../../../../docs/adr/019-agents-over-mcp.md), [vimma-mcp](../../../../../../docs/specs/vimma-mcp.md).
