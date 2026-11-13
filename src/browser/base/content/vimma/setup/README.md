# `vimma/setup/`

`about:vimma-setup`, the first-run setup: `SetupHost.sys.mjs` registers the page, decides when
to offer it and writes the chosen `config.toml`; `setup.mjs` and `setup.html` are the page.

**Entry points:** `SetupHost.register()`, called by `vimma.js`.

**May import (layer 6, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** every folder below it;
today `core/`, `config/` and `ui/`. Not `about/`, `start/` or `omarchy/` (same layer).

**Read more:** [first-run-setup](../../../../../../docs/specs/first-run-setup.md).
