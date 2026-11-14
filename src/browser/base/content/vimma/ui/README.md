# `vimma/ui/`

Vimma's own interface in the browser window: status bar, command line, overlays, pickers, panels,
prompts and the theme ([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)).

**Entry points:** one class or object per widget, built by the host for its window (`StatusBar`,
`CommandLine`, `Picker`, `SidePanel` and the others); `ThemeHost`, used by every page that
follows the theme.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only. A widget
renders what it is given and reports through the callbacks it is passed; it does not reach back
into the host. The agent chat window (`agent-chat.mjs`) is passed the agent's services by the
host that builds it (`AgentChatServices`: the conversations, the agent CLIs, the API keys,
`config.toml`'s refusal and setup's write to it, the `[agent]` providers); it imports nothing
from `agent/`, `config/` or `host/`, and not `host/host-services.mjs` either.

**Read more:** [Config and theme](../../../../../../docs/architecture/config-and-theme.md); the chrome UI rules
in
[docs/security/06-chrome-ui-rendering.md](../../../../../../docs/security/06-chrome-ui-rendering.md)
section 6.
