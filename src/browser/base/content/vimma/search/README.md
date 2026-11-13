# `vimma/search/`

`config.toml`'s `[search]` applied to Firefox's search engines (`SearchHost.sys.mjs`), and how
the address bar shares its rows between the user's pages and the search suggestions
(`UrlbarRows.sys.mjs`).

**Entry points:** `SearchHost`, which `config/ConfigHost.sys.mjs` hands the validated
`[search]` table; `UrlbarRows`, started by `vimma.js`.

**May import (layer 1, [ADR-026](../../../../../../docs/adr/026-module-layering.md)):** `core/` only.

**Read more:** [search-engines](../../../../../../docs/specs/search-engines.md),
[page-suggestions](../../../../../../docs/specs/page-suggestions.md).
