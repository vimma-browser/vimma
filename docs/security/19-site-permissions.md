## 19. Site permissions (`host/permission-ops.mjs`)

`:site` (or `:permissions`) opens a picker over the selected tab's site permissions, where `a`,
`b`, `r` and `Enter` allow, block, reset or step a permission for that site. It changes what a
site may do (camera, microphone, location, notifications), so these rules keep it to the page
you meant and to Firefox's own rules. Spec: [site-permissions](../specs/site-permissions.md).

**Reach:** only you, with `:site` or a key you bind (it has no default key). No control-socket or
MCP command reaches it, and an agent's keys are a fixed list without it (S7, M16), so neither
`vimma-ctl`'s agent role nor an agent can open it. A `full`-role connection holds your token and
can type `:site` as your keyboard can (§1). It reads only the selected page's permissions,
which Firefox's site information panel shows already, and stores nothing of its own.

- SP1. It **must** refuse in the agent workspace: `:site`, and every key while it is open,
  check the selected tab's container and its page's principal, and refuse when either is the
  agent workspace's, so a permission is never given to a page an agent drives. A picker open
  on another tab closes when an agent's tab is selected.
  [`test_the_agent_workspace_refuses_and_grants_nothing`](../../tests/browser/browser_vimma_site_permissions.js)
- SP2. It **must** act only on the page it was opened for: every key checks that the selected
  tab is the one it opened in and that its principal is the one it listed, and closes the picker
  otherwise; selecting another tab closes it. A page without site permissions (`about:` pages)
  gets no picker.
  [`test_acts_only_on_the_page_it_was_opened_for`](../../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_page_without_site_permissions_says_so`](../../tests/browser/browser_vimma_site_permissions.js)
- SP3. Each row **must** show the state Firefox has for the site, read from `SitePermissions`
  with the tab's browser (temporary and globally blocked permissions included), and the row
  **must** show the new state after a change.
  [`test_lists_every_permission_with_its_real_state`](../../tests/browser/browser_vimma_site_permissions.js),
  [`test_keys_change_it_through_firefox_and_the_row_follows`](../../tests/browser/browser_vimma_site_permissions.js),
  [`one row per permission, by Firefox's label, with its real state`](../../packages/vimma-core/test/sitepermissions.test.mjs)
- SP4. A change **must** go through Firefox's own code paths: one
  `SitePermissions.setForPrincipal` or `SitePermissions.removeFromPrincipal` call, the calls
  Page Info makes, and only in `host/permission-ops.mjs`; no other Vimma code changes a site
  permission, except `ctl/AgentPages.sys.mjs`'s browser-scoped DENY for camera, microphone,
  screen and speaker on each agent tab (M10): one `Services.perms.addFromPrincipalForBrowser`
  call that only denies and never allows. The test pins every permission-manager writer,
  including the `…ForBrowser`, `…Since` and `…ByType` forms. The one direct permission-manager write is a pop-up block for the page's own
  principal (`Services.perms.addFromPrincipal(…, "popup", DENY_ACTION)`, as Firefox's pop-up
  bar writes it), because SitePermissions drops a block that equals the pop-up default; it can
  only take pop-ups away. Only a state Firefox offers for the permission is set, and a
  permission set by policy or decided by a locked pref is read only. The pop-up blocked bar's
  `n` and `:popups`' allow, block and reset rows (`host/popup-ops.mjs`) write only through this
  file's `setSitePopups`, which refuses an agent workspace page and a locked pop-up pref, so a
  block from any of them is the same stored block.
  [`changes a site permission only from the site permissions picker`](../../tools/security/test/chrome-source.test.ts),
  [`test_popups_can_be_allowed_blocked_and_reset`](../../tests/browser/browser_vimma_site_permissions.js),
  [`test_site_and_popups_share_one_popup_permission`](../../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_private_window_keeps_a_popup_block_for_its_session`](../../tests/browser/browser_vimma_site_permissions.js),
  [`a state Firefox does not offer for the permission is refused`](../../packages/vimma-core/test/sitepermissions.test.mjs),
  [`a locked row changes nothing`](../../packages/vimma-core/test/sitepermissions.test.mjs),
  [`test_a_state_firefox_does_not_offer_is_refused`](../../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_locked_default_makes_the_row_read_only`](../../tests/browser/browser_vimma_site_permissions.js)
- SP5. No control, MCP or agent code **must** reach it: nothing under `ctl/` or `agent/` imports
  the picker's ops, and the agent's keys are the spec's fixed list.
  [`changes a site permission only from the site permissions picker`](../../tools/security/test/chrome-source.test.ts),
  [`the whitelist is the spec's table`](../../packages/vimma-core/test/agent-keys.test.mjs)
