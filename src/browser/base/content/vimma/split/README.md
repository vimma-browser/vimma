# `vimma/split/`

Split panes on Firefox's own split view ([ADR-013](../../../../../../docs/adr/013-split-on-firefox-split-view.md)).
`PaneView.mjs` keeps each window's pane tree; `layout.mjs` puts Firefox's split-view panels at
the rectangles vimma-core computes for it.

**Entry points:** `PaneViews.init(window)`, called by `vimma.js`; each window's `PaneView` is driven by
`host/pane-ops.mjs`.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only.

**Read more:** [Workspaces and panes](../../../../../../docs/architecture/workspaces-and-panes.md),
[multiple-splits](../../../../../../docs/specs/multiple-splits.md).
