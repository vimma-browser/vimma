# ADR-023: The built-in agent is a model client in the browser, through the agent commands

- Status: Accepted; amended by [builtin-agent-cli](../specs/builtin-agent-cli.md) (an agent CLI
  as the model client)
- Date: 2026-10-29

## Context

Agents reach Vimma through `vimma-ctl mcp`, an MCP server over stdio that an agent host (Claude
Code, Codex, opencode) starts and that speaks to the control socket's confined `agent` role
([ADR-019](019-agents-over-mcp.md)). The built-in agent ([builtin-agent](../specs/builtin-agent.md))
is a client of a new kind: Vimma itself sends page text to a model the user picks, a local
server or a hosted API, and runs the tool calls the model makes. Three questions follow: how its
calls reach the gate, where its requests may go, and where an API key is kept.

## Decision

1. **In the browser's process, through `runAgentCommand`.** Each conversation is one gate
   connection with an id of its own (`builtin:<n>`, a string; socket connections have numbers),
   registered after an internal hello. Its tool calls are mapped to the agent commands, checked
   by the control protocol's validator as a socket request is, and run by the same code an MCP
   agent's calls run, so the gate, the grants, the checkpoints, the rates, `:mcp log` and the
   checks after a yes are shared. Results become the text `vimma-ctl mcp` gives an MCP agent,
   from vimma-core's `agent-results.mjs`, whose fixed sentences a test keeps equal to `mcp.rs`.
   It needs no `:mcp on`.
2. **A conversation's grant is made by the user's own send.** Sending a task with `Enter` in
   Vimma's chat window grants the conversation's connection for its lifetime, with no question;
   `ctrl+Enter` ends it. The control socket has no command that sends a task, and the window is
   chrome that page key events never reach.
3. **Each conversation has its own tabs**, kept in memory by tab. MCP agents see only the tabs no
   conversation owns.
4. **Requests go only to the configured endpoint**, from the parent process's `fetch` with
   `credentials: "omit"` and `redirect: "error"`, `https://` unless on a loopback address. The
   model loop and the provider adapters are vimma-core's, written against the HTTP APIs with no
   SDK, and shared with the model bench.
5. **An API key is a login holding the key encrypted with OSKeyStore**, of the origin
   `chrome://vimma-agent`; never a pref or config.toml.

## Rejected

- **Connecting to the control socket like `vimma-ctl mcp`**: it needs `:mcp on`, which serves the
  agent role to every local process, and the token in a file.
- **A separate MCP host process**: one more program to ship and a socket, for no gain in
  confinement.
- **Tools of its own** (a "search the shop" tool): each would need its own threat review and
  would not help MCP agents.
- **Firefox's `OpenAIPipeline`**: it speaks only OpenAI's API, runs in the ML engine's process
  for the Smart Window, and cannot run in the bench.
- **The key in a pref, as the Smart Window keeps its key**, or in config.toml, which users share
  and keep in dotfile repositories; **the key in login storage as it is**, because it would then
  be exported and synced with the passwords in clear.

## Consequences

- Every rule of [docs/security.md](../security.md) §12 covers the built-in agent; its own rules
  are M35-M41 there.
- What the bench measures over `vimma-ctl mcp` is what the built-in agent runs: the same loop,
  tool definitions, system text and result text.
- A key does not move to a new machine with a copied profile when a desktop keyring holds
  OSKeyStore's secret; the user enters it again.
- `:mcp off` does not stop the built-in agent; `ctrl+b shift+a`, `:mcp revoke` and `:mcp log`
  cover it.
- No upstream patch and no new dependency.

## An agent CLI as the model client (amendment, spec builtin-agent-cli)

The model client inside the browser may also be an external agent CLI the user already has,
Claude Code first ([builtin-agent-cli](../specs/builtin-agent-cli.md) C1, C2). Vimma starts it
for one task, with no shell and fixed arguments, and gives it one MCP server, `vimma-ctl mcp`,
which connects to the control socket with a one-time ticket bound to the conversation's gate
connection instead of the token. Its calls therefore run through `runAgentCommand` on the
conversation's connection, as decision 1 says for the model loop: the same gate, grant, tabs,
rates and `:mcp log`, with no `:mcp on`. What changes is where the model's requests go: the
CLI sends them to the model it is set up for, under its own login, so decision 2's endpoint
checks do not apply and `local_only` refuses every CLI. The CLI also keeps its own shell, file
and web tools, outside the gate; the window says so before the first task and lists them in its
header. Rejected for this: the ordinary agent role with the token and `:mcp on`, for the reason
decision 1's alternatives give; an MCP server over HTTP served by Vimma, because it adds a
listener that pages could reach by URL. Its rules are M51-M61 of
[docs/security.md](../security.md) §12, and C2's third exception.
