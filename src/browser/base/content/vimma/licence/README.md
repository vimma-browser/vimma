# `vimma/licence/`

Vimma's parts of `about:license`: the product name, the list entry and the licence text of the
code Vimma adds (vimma-core's vendored TOML parser among it). The build merges these HTML
fragments into Firefox's licence page (`browser/base/moz-build.patch`).

**Entry points:** none; these are page fragments, not modules.

**May import ([ADR-026](../../../../../../docs/adr/026-module-layering.md)):** nothing. It holds no module, so it
has no layer.

**Read more:** [m6-packaging](../../../../../../docs/specs/m6-packaging.md); `npm run license-check` in
`CONTRIBUTING.md`.
