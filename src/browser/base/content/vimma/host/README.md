# `vimma/host/`

The orchestrator of each browser window: key capture and dispatch in `VimmaHost.sys.mjs`, the
action tables in `runners.mjs`, one area's actions per `*-ops.mjs` module
([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)). `key-log.mjs` keeps the last
key events the host dispatched, which `about:vimma` shows. `VimmaParent.sys.mjs` is the parent
side of the JSWindowActor pair `actors/` registers: it checks the page reports (focus, clicks,
mouse selections, text blocks, the PDF viewer's state and outline) and hands them to the host
and `pdf-ops.mjs`. `AgentGate.sys.mjs` is the agent gate: every agent command of `ctl/` and
the built-in agent asks it, and it holds the questions the agent line (`agent-ui.mjs`) shows,
the grants and `:mcp log` (`mcp-ops.mjs`), beside `[mcp]` and full control's state.
`host-services.mjs` holds the
commands of higher folders the host runs: the built-in agent's conversations, the agent-download
test and `:route add`'s write to `config.toml`; and what the agent chat window it builds uses of
them (the agent CLIs, the API keys, `config.toml`'s refusal and setup's write to it), which
`agent-chat-ops.mjs` hands the window as `CHAT_SERVICES`. Only `host/` imports the registry,
which serves the agent's objects narrowed to the members used (no key, no CLI start, no ticket).

**Entry points:** `VimmaHost.init(win)` and `VimmaHost.uninit(win)`, called by `vimma.js`;
`runners.mjs`, which takes the host as an argument instead of importing it; `VimmaParent`,
which Firefox loads from the URL `vimma.js` hands `VimmaActors.register()`;
`HostServices.provide`, which `vimma.js`, the window script, calls before the first window's
host starts. Each service is provided once and never replaced; one asked for before that gives
the answer that does the least (every download counts as an agent's, no key is known or stored,
`config.toml` counts as refused, nothing is written).

**May import (layer 3, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, `services/`,
`search/`, `updates/`, `split/`, `ui/`, `workspaces/` and `actors/`. Not `config/`, `ctl/`,
`agent/` or `about/`, with no exception. To reach a higher folder, take a callback or an
interface object from it, or observe a topic it sends; a command the host runs for a higher
folder comes through `host-services.mjs`.

**Security:** `VimmaParent.sys.mjs` is where content-process messages enter the parent; what it
takes from a page is checked as [docs/security.md](../../../../../../docs/security.md) sections 13
and 20 say. `AgentGate.sys.mjs` decides what an agent may do and asks you (section 12): a change
to it gets a separate security review, as one to `ctl/` does. Only the modules `RESTRICTED` lists
in `tools/layering/layers.ts` may import it (three here, three in `ctl/`, `agent/AgentChat.sys.mjs`),
and `npm run layering` fails on any other, `VimmaParent.sys.mjs` included, and on a module that
re-exports it: a new caller needs a security review, then a line there.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md),
[Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md).
