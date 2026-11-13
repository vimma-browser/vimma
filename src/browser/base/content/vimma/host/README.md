# `vimma/host/`

The orchestrator of each browser window. `VimmaHost.sys.mjs` captures keys in the chrome window,
asks vimma-core's dispatcher what they mean, keeps the window's mode and state, and runs the
action. `runners.mjs` holds the action tables; each `*-ops.mjs` module applies one area's
actions to Firefox (tabs, panes, workspaces, bookmarks, downloads, permissions, the PDF viewer,
MCP and the private workspace). `hypr/HyprIpc.sys.mjs` talks to Hyprland's sockets (ADR-017).

**Entry points:** `VimmaHost.init(win)` and `VimmaHost.uninit(win)`, called by `vimma.js`;
`runners.mjs`, which takes the host as an argument instead of importing it.

**May import (layer 3, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, `services/`,
`search/`, `updates/`, `split/`, `ui/`, `workspaces/` and `actors/`. Not `config/`, `ctl/`,
`agent/` or `about/`: the imports of those that remain are listed in
`tools/layering/layers.ts`, each with its reason. To reach a higher folder, take a callback or
an interface object from it, or observe a topic it sends.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md),
[Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md).
