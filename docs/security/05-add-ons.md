## 5. Add-ons (`host/addon-ops.mjs`)

The add-on picker lists, enables, disables and removes extensions. Spec:
[addon-manager](../specs/addon-manager.md).

**Reach:** you only (keys and `:addon`); nothing in it is reachable from pages.

- A1. Vimma installs an add-on **only** from the setup page (about:vimma-setup), from
  addons.mozilla.org (an https file there with a sha256 hash), after the user marked it,
  confirmed the summary and accepted Firefox's own permission prompt, which Vimma never answers
  (spec [first-run-setup](../specs/first-run-setup.md)). It never installs an add-on update; an
  update goes through about:addons, where Firefox asks about new permissions.
  [`u_reports_the_update_check`](../../tests/browser/browser_vimma_addons.js),
  [`installs an add-on only from the setup page`](../../tools/security/test/chrome-source.test.ts),
  [`an AMO result off addons.mozilla.org or without a sha256 hash is dropped`](../../packages/vimma-core/test/setup.test.mjs)
- A2. Removal **must** ask y/N, and a y stands only for the add-on and version asked about.
  [`d_removes_after_yes_and_keeps_after_no`](../../tests/browser/browser_vimma_addons.js),
  [`a_stale_yes_removes_nothing`](../../tests/browser/browser_vimma_addons.js)
- A3. System, built-in and hidden add-ons are **never** listed or acted on, by the picker or by
  `:addon name`.
  [`lists_extensions_but_not_system_ones`](../../tests/browser/browser_vimma_addons.js),
  [`:addon never reaches a hidden or system add-on`](../../packages/vimma-core/test/addons.test.mjs)

Allowed without a question, as in about:addons: enable, disable, and private-window access.
