# `vimma/about/`

`about:vimma`: the current mode, the last keys and what they did, config errors, versions, the
patch count, the control socket and MCP state, and a redacted bug report.
`AboutVimma.sys.mjs` registers the page and gathers its data; `about.mjs` and `about.html` are
the page. The last key events come from `host/key-log.mjs`, which the host writes.

**Entry points:** `AboutVimma.register()`, called by `vimma.js`.

**May import (layer 6, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** every folder below it,
since it reports on all of them. Not `setup/`, `start/` or `omarchy/` (same layer).

**Read more:** [m5-about-vimma](../../../../../../docs/specs/m5-about-vimma.md).
