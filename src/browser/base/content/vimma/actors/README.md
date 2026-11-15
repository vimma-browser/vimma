# `vimma/actors/`

The bridge between the browser window and its pages: the JSWindowActor pair. `VimmaChild` runs in
each page's process and does what needs the page's DOM (scrolling, hints, the caret and text
model, text blocks, live grep's matcher and worker, the PDF viewer adapter, the fields an agent
reads and fills). `VimmaParent`, in `host/`, receives its reports in the parent process.

**Entry points:** `VimmaActors.sys.mjs`: `VimmaActors.register(parentURI)` (called by `vimma.js`
with the parent actor's URL) and
the functions the host and the agent commands use to send a request to a page and await its
answer.

**May import (layer 2, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` and the layer 1
folders. Nothing here names a `host/` module, not even in a string: the parent actor, which
only forwards reports to the host, is `host/VimmaParent.sys.mjs`, and `vimma.js` passes its URL
to `register()`.

**Security:** pages are untrusted; what the actors take from them is checked as
[docs/security/](../../../../../../docs/security/README.md) sections 13, 15 and 20 say.

**Read more:** [The life of a keypress](../../../../../../docs/architecture/keypress.md), from "The actor pair"
on.
