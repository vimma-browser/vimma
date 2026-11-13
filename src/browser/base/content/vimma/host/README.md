# `vimma/host/`

The orchestrator of each browser window: key capture and dispatch in `VimmaHost.sys.mjs`, the
action tables in `runners.mjs`, one area's actions per `*-ops.mjs` module
([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)).

**Entry points:** `VimmaHost.init(win)` and `VimmaHost.uninit(win)`, called by `vimma.js`;
`runners.mjs`, which takes the host as an argument instead of importing it.

**May import (layer 3, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, `services/`,
`search/`, `updates/`, `split/`, `ui/`, `workspaces/` and `actors/`. Not `config/`, `ctl/`,
`agent/` or `about/`: the imports of those that remain are listed in
`tools/layering/layers.ts`, each with its reason. To reach a higher folder, take a callback or
an interface object from it, or observe a topic it sends.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md),
[Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md).
