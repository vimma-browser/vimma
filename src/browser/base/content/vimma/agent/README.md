# `vimma/agent/`

The built-in agent ([ADR-023](../../../../../../docs/adr/023-in-browser-model-client.md)): a model client in the
browser. `AgentChat.sys.mjs` runs conversations and their tool calls through the agent commands;
`AgentCli.sys.mjs` runs installed agent CLIs; `AgentKeys.sys.mjs` keeps API keys in the OS
keyring; `AgentStore.sys.mjs` stores conversations encrypted in the profile.

**Entry points:** `AgentChat` (created, listed and stopped by the chat window and the agent
line, which reach it through `host/host-services.mjs`, where `vimma.js` puts it); `AgentCli`
and `AgentKeys` (setup's CLIs and the API keys in the chat window, which the host hands it from
the same registry; the keys only as `hint`, `set` and `delete`); `AgentCli.init()`, called by
`vimma.js`.

**May import (layer 5, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** everything below it:
`core/`, the layer 1 and 2 folders, `host/`, `config/` and `ctl/`. Its tools act on pages
through `ctl/agent-commands.mjs` (`runAgentCommand`), under the same rules as an MCP agent's.
`AgentChat.sys.mjs` also calls `ctl/AgentGate.sys.mjs` directly: sending a task with `Enter`
in the chat window grants that conversation's connection until the task ends, and it labels
the connection; it uses `ctl/VimmaControl.sys.mjs` for the connection itself. `AgentCli.sys.mjs`
uses `ctl/VimmaControl.sys.mjs` and `ctl/AgentDownloads.sys.mjs` for the CLIs it starts.

**Security:** [docs/security.md](../../../../../../docs/security.md) section 12, "The built-in agent".

**Read more:** [builtin-agent](../../../../../../docs/specs/builtin-agent.md),
[builtin-agent-cli](../../../../../../docs/specs/builtin-agent-cli.md).
