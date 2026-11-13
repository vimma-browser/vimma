# `vimma/workspaces/`

Workspaces as Firefox containers. `WorkspaceStore.sys.mjs` holds the app's workspace
definitions and their file (`<profile>/vimma-workspaces.json`); `WindowWorkspaces.sys.mjs`
keeps each window's tab membership, hidden tabs and snapshot; `WorkspaceRouter.sys.mjs` applies
the `[[routes]]` rules that send a URL to a workspace, and the `-vimma-from` command line.

**Entry points:** `WorkspaceStore` (one per app), `WindowWorkspaces.get(win)` (one per window),
`WorkspaceRouter`. `vimma.js` starts them.

**May import (layer 2, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` and the layer 1
folders (`split/` for the pane trees). `WindowWorkspaces.sys.mjs` imports
`host/tab-labels.mjs`, a listed exception until the labels move here. Changes go up as the
`CHANGED_TOPIC` observer topic.

**Read more:** [Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md); routing and
deletion rules in [docs/security.md](../../../../../../docs/security.md) sections 2 and 3.
