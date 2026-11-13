# `vimma/config/`

`config.toml`: `ConfigHost.sys.mjs` reads and polls the file, has vimma-core parse and validate
it, hands each valid part to the module that uses it (keymap, theme, workspaces and routes,
search engines, toolbar, private workspace, MCP and agent settings, updates), keeps the last good
config on an error, and writes the file only when asked (first-run setup, `:config` on a missing
file, `:route add`).

**Entry points:** `ConfigHost.init(window)`, called by `vimma.js`; a reload is announced with
`CONFIG_RELOAD_TOPIC`.

**May import (layer 4, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, the layer 1
and 2 folders, and `host/`. Not `ctl/` (same layer) or above.

**Security:** [docs/security.md](../../../../../../docs/security.md) section 8.

**Read more:** [Config and theme](../../../../../../docs/architecture/config-and-theme.md),
[m5-config-load](../../../../../../docs/specs/m5-config-load.md).
