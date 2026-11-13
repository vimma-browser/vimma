# `vimma/start/`

The start page, used as the home page and the new-tab page, and as the stand-in for
`about:home`, `about:newtab` and `about:welcome`. `StartPage.sys.mjs` registers it;
`start.mjs` and `start.html` are the page, with its logo images.

**Entry points:** `StartPage.init(window)`, called by `vimma.js`.

**May import (layer 6, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** every folder below it;
today `core/` and `ui/theme-host.mjs`. Not `about/`, `setup/` or `omarchy/` (same layer).

**Read more:** [start-page](../../../../../../docs/specs/start-page.md).
