# `vimma/omarchy/`

The Omarchy theme hook: `vimma-theme-reload.sh` is the script Omarchy's theme-set hook runs, and
`OmarchyHook.sys.mjs` installs it and handles the `-vimma-reload-theme` command line, which
reloads the theme in every window.

**Entry points:** `OmarchyHook.init()`, called by `vimma.js`.

**May import (layer 6, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** every folder below it;
today `core/` and `ui/theme-host.mjs`. Not `about/`, `setup/` or `start/` (same layer).

**Security:** [docs/security.md](../../../../../../docs/security.md) section 7.

**Read more:** [m5-omarchy-theme](../../../../../../docs/specs/m5-omarchy-theme.md),
[Config and theme](../../../../../../docs/architecture/config-and-theme.md).
