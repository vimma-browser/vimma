# `vimma/actors/`

The bridge between the browser window and its pages: the JSWindowActor pair. `VimmaChild` runs in
each page's process and does what needs the page's DOM (scrolling, hints, the caret and text
model, text blocks, live grep's matcher and worker, the PDF viewer adapter, the fields an agent
reads and fills). `VimmaParent` receives its reports in the parent process.

**Entry points:** `VimmaActors.sys.mjs`: `VimmaActors.register()` (called by `vimma.js`) and
the functions the host and the agent commands use to send a request to a page and await its
answer.

**May import (layer 2, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` and the layer 1
folders. `VimmaParent.sys.mjs` imports `host/`, a listed exception until the parent actor,
which only forwards reports to the host, moves to `host/`.

**Security:** pages are untrusted; what the actors take from them is checked as
[docs/security.md](../../../../../../docs/security.md) sections 13, 15 and 20 say.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md), from "The actor pair"
on.
