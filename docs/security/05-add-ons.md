## 5. Add-ons (`host/addon-ops.mjs`)

The add-on picker lists, enables, disables and removes extensions. Spec:
[addon-manager](../specs/addon-manager.md).

**Reach:** you only (keys and `:addon`); nothing in it is reachable from pages.

- A1. Vimma installs an add-on **only** from the setup page (about:vimma-setup), from
  addons.mozilla.org (an https file there with a sha256 hash), after the user marked it, pressed
  `enter` on the content blocker step (spec [setup-v2](../specs/setup-v2.md), behaviour 19) and
  accepted Firefox's own permission prompt, which Vimma never answers. Only a trusted key or
  click on the page starts it. It never installs an add-on update; an update goes through
  about:addons, where Firefox asks about new permissions.
  [`u_reports_the_update_check`](../../tests/browser/browser_vimma_addons.js),
  [`installs an add-on only from the setup page`](../../tools/security/test/chrome-source.test.ts),
  [`content_blocker_installs_on_enter_with_the_permission_prompt`](../../tests/browser/browser_vimma_setup_v2.js),
  [`an AMO result off addons.mozilla.org or without a sha256 hash is dropped`](../../packages/vimma-core/test/setup.test.ts)
- A2. Removal **must** ask y/N, and a y stands only for the add-on and version asked about.
  [`d_removes_after_yes_and_keeps_after_no`](../../tests/browser/browser_vimma_addons.js),
  [`a_stale_yes_removes_nothing`](../../tests/browser/browser_vimma_addons.js)
- A3. System, built-in and hidden add-ons are **never** listed or acted on, by the picker or by
  `:addon name`.
  [`lists_extensions_but_not_system_ones`](../../tests/browser/browser_vimma_addons.js),
  [`:addon never reaches a hidden or system add-on`](../../packages/vimma-core/test/addons.test.ts)

Allowed without a question, as in about:addons: enable, disable, and private-window access.
