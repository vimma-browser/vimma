# `vimma/config/`

`config.toml`: `ConfigHost.sys.mjs` reads, validates and applies it, and writes it only when
asked. `BookmarksFile.sys.mjs` mirrors `bookmarks.toml`, beside it, into Places; ConfigHost
starts it, polls it and hands it config.toml's text
([bookmarks-file](../../../../../../docs/specs/bookmarks-file.md)) ([ARCHITECTURE.md](../../../../../../ARCHITECTURE.md#module-map)).

**Entry points:** `ConfigHost.init(window)`, called by `vimma.js`; a reload is announced with
`CONFIG_RELOAD_TOPIC`; `ConfigHost.addRoute`, `ConfigHost.addAgentProvider` and
`ConfigHost.refused()`, which `vimma.js` hands the host through `host/host-services.mjs` for
`:route add` and for the agent chat window's setup and its "no model" text.

**May import (layer 4, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/`, the layer 1
and 2 folders, and `host/`. Not `ctl/` (same layer) or above.

**Security:** [docs/security/08-config-toml.md](../../../../../../docs/security/08-config-toml.md)
section 8 (F6: `bookmarks.toml`).

**Read more:** [Config and theme](../../../../../../docs/architecture/config-and-theme.md),
[m5-config-load](../../../../../../docs/specs/m5-config-load.md).
