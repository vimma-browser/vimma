# `vimma/ui/`

Vimma's own interface inside the browser window: the status bar, command line, help overlay,
hint overlay, pickers, side panel, bookmarks panel and toolbar, prompts, notices, the PDF
outline, the tab strip, the agent chat window and the theme (`theme-host.mjs`, which applies the
built-in or Omarchy theme to every window and start page).

**Entry points:** one class or object per widget, built by the host for its window (`StatusBar`,
`CommandLine`, `Picker`, `SidePanel` and the others); `ThemeHost`, used by every page that
follows the theme.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only. A widget
renders what it is given and reports through the callbacks it is passed; it does not reach back
into the host. `agent-chat.mjs` reaches `agent/`, `config/` and `host/mcp-ops.mjs` lazily,
listed in `tools/layering/layers.ts` until the host passes those services in.

**Read more:** [Config and theme](../../../../../../docs/architecture/config-and-theme.md); the chrome UI rules
in [docs/security.md](../../../../../../docs/security.md) section 6.
