# `vimma/agent/`

The built-in agent ([ADR-023](../../../../../../docs/adr/023-in-browser-model-client.md)): a model client in the
browser. `AgentChat.sys.mjs` runs conversations and their tool calls through the agent commands;
`AgentCli.sys.mjs` runs installed agent CLIs; `AgentKeys.sys.mjs` keeps API keys in the OS
keyring; `AgentStore.sys.mjs` stores conversations encrypted in the profile.

**Entry points:** `AgentChat` (created, listed and stopped by the chat window and the agent
line); `AgentCli.init()`, called by `vimma.js`.

**May import (layer 5, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** everything below it:
`core/`, the layer 1 and 2 folders, `host/`, `config/` and `ctl/`. It acts on pages only
through `ctl/agent-commands.mjs`, so it meets the agent gate as any agent does.

**Security:** [docs/security.md](../../../../../../docs/security.md) section 12, "The built-in agent".

**Read more:** [builtin-agent](../../../../../../docs/specs/builtin-agent.md),
[builtin-agent-cli](../../../../../../docs/specs/builtin-agent-cli.md).
