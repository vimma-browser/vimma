# ADR-012: The vendored TOML parser is smol-toml (BSD-3-Clause)

- Status: Accepted
- Date: 2026-10-09
- Amends: ADR-008 ("a small MIT-licensed JS TOML parser is vendored")

## Context

ADR-008 called for vendoring a small MIT-licensed TOML parser. When the parser was chosen
(spec m5-core-config-and-theme), the best candidate was BSD-3-Clause, not MIT.

## Decision

The vendored parser is **smol-toml 1.9.0, BSD-3-Clause**, in
`packages/vimma-core/src/vendor/smol-toml/`. It is generated as one ES module by
`tools/vendor-smol-toml.mjs` (Since changed: `vendor-smol-toml.ts`, ADR-025). ADR-008's requirement
becomes "a small, permissively licensed (MIT, BSD or ISC) parser".

## Reasoning

- smol-toml is about 45 KB of ES modules with no dependencies and is maintained. It passes the
  full toml-test suite and reports a line and a column for each error.
- The MIT options were worse. `toml` 5.0.0 is 113 KB of generated CommonJS. `@iarna/toml` is ISC,
  has been unmaintained since 2020, and implements only TOML 1.0.0-rc.1.
- BSD-3-Clause is on our licence allowlist and is compatible with MPL-2.0. Its only extra
  condition over MIT is the no-endorsement clause, which costs us nothing.

## Consequences

- We keep the BSD notice: the header in `smol-toml.mjs` and the `LICENSE` file next to it.
- Binary releases must include the notice in their third-party licences: it is in
  `about:license` (issue #16), through the product-specific blocks Firefox's `license.html`
  already has for non-Firefox apps. `src/browser/base/moz-build.patch` passes
  `src/browser/base/content/vimma/licence/` to them (extra inputs of the generated `license.html`
  since Firefox 158; the `APP_LICENSE_{PRODUCT_NAME,LIST_BLOCK,BODY_BLOCK}` DEFINES before),
  whose `body.html` carries `LICENSE` verbatim and says the copy is modified (the modules joined
  into one file; `smol-toml.mjs`'s header says so too). `about:license` is in `omni.ja`, so every
  release artefact has it; `tools/package/test/licence-notices.test.mjs` and
  `browser_vimma_licence.js` check it. A new vendored component adds its entry there.
