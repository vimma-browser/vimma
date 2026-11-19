# `vimma/setup/`

`about:vimma-setup`, the first-run setup: `SetupHost.sys.mjs` registers the page, decides when
to offer it and saves each step to `config.toml`; `setup.html` and `flow.mjs`, which draws the
chapters and takes the keys, are the page.

**Entry points:** `SetupHost.register()`, called by `vimma.js`.

**May import (layer 6, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** every folder below it;
today `core/`, `config/`, `services/` and `ui/`. Not `about/`, `start/` or `omarchy/` (same layer).

**Read more:** [first-run-setup](../../../../../../docs/specs/first-run-setup.md),
[setup-v2](../../../../../../docs/specs/setup-v2.md).
