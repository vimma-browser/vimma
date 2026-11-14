# `vimma/host/`

The orchestrator of each browser window: key capture and dispatch in `VimmaHost.sys.mjs`, the
action tables in `runners.mjs`, one area's actions per `*-ops.mjs` module
([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)). `key-log.mjs` keeps the last
key events the host dispatched, which `about:vimma` shows. `host-services.mjs` holds the
commands of higher folders the host runs: the built-in agent's conversations, the agent-download
test and `:route add`'s write to `config.toml`; and what the agent chat window it builds uses of
them (the agent CLIs, the API keys, `config.toml`'s refusal and setup's write to it), which `agent-chat-ops.mjs` hands the window as
`CHAT_SERVICES`. Only `host/` imports the registry, which serves the agent's objects narrowed
to the members used (no key, no CLI start, no ticket).

**Entry points:** `VimmaHost.init(win)` and `VimmaHost.uninit(win)`, called by `vimma.js`;
`runners.mjs`, which takes the host as an argument instead of importing it;
`HostServices.provide`, which `vimma.js`, the window script, calls before the first window's
host starts. Each service is provided once and never replaced; one asked for before that gives
the answer that does the least (every download counts as an agent's, no key is known or stored,
`config.toml` counts as refused, nothing is written).

**May import (layer 3, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, `services/`,
`search/`, `updates/`, `split/`, `ui/`, `workspaces/` and `actors/`. Not `config/`, `ctl/`,
`agent/` or `about/`: the imports of those that remain are listed in
`tools/layering/layers.ts`, each with its reason. To reach a higher folder, take a callback or
an interface object from it, or observe a topic it sends; a command the host runs for a higher
folder comes through `host-services.mjs`.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md),
[Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md).
