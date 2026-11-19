## 3. Workspace deletion and containers (`workspaces/WorkspaceStore.sys.mjs`)

Closing a runtime workspace deletes its container and that container's cookies and site data.
Spec: [m3-workspaces](../specs/m3-workspaces.md).

**Reach:** you, by keys or `:wsdelete`. Extensions and Firefox's Settings can delete containers.

- W1. Site data **never** goes without a y to a y/N question; n keeps everything.
  [`closing_asks_n_keeps_y_deletes_the_container_and_its_cookies`](../../tests/browser/browser_vimma_workspace_ops.js),
  [`a_confirmed_delete_removes_the_container_and_its_cookies`](../../tests/browser/browser_vimma_workspace_store.js)
- W2. A y **must** stand only for the workspace as asked: after a rename or a config reload in
  between, nothing is closed.
  [`a_stale_answer_closes_nothing`](../../tests/browser/browser_vimma_workspace_store.js)
- W3. A delete **must** clear only that workspace's container; other containers keep their data.
  [`a_confirmed_delete_removes_the_container_and_its_cookies`](../../tests/browser/browser_vimma_workspace_store.js)
- W4. A container that is no longer recognisably the workspace's (renamed in Settings, reused)
  **must** be kept with its data.
  [`a_container_no_longer_ours_is_kept_and_the_notice_says_so`](../../tests/browser/browser_vimma_workspace_ops.js),
  [`reconcile_adopts_and_never_deletes_silently`](../../tests/browser/browser_vimma_workspace_store.js)
- W5. Container 0 (the default, shared by everything outside a workspace) is **never** a
  workspace's, so it is never closed or cleared.
  [`container 0 is never a workspace's: a stored id of 0 or below is refused`](../../packages/vimma-core/test/workspacedefs.test.ts)
- W6. Closing a config workspace **must** close its tabs only, never its data; the last
  workspace is never closed.
  [`closing_a_config_workspace_closes_its_tabs_only`](../../tests/browser/browser_vimma_workspace_ops.js),
  [`the_last_workspace_cannot_be_closed`](../../tests/browser/browser_vimma_workspace_ops.js)
- W7. A container deleted outside Vimma **must** be replaced at once, so new tabs never fall
  into the default container.
  [`a_container_deleted_by_an_extension_is_replaced_at_once`](../../tests/browser/browser_vimma_workspace_edges.js),
  [`a_container_deleted_in_settings_is_replaced_and_ext_stays_usable`](../../tests/browser/browser_vimma_workspace_edges.js)
- W8. A tab or window an extension opens with no `cookieStoreId` and no opener tab is in
  container 0, as in Firefox, so its sign-in shares the cookies its background reads (#1221);
  Vimma never puts it in a workspace's container, the agent workspace's included, and in the
  agent workspace it is `foreign`, so no agent lists or reads it. Only an extension's own
  triggering principal (one with an add-on policy) does this: what you open and what a page
  opens (`target=_blank`, `rel=noopener` included) still take the workspace's or the page's
  container, and a page's principal never has an add-on policy. An about: page or a window with
  no URL (the start page) an extension opens has that page's principal, so it takes the
  workspace's container, as `ctrl+t` and `ctrl+n` do. An extension that names a container
  (`cookieStoreId`, which needs its `cookies` permission) or an opener tab gets that one, as in
  Firefox, the agent workspace's included: extensions are trusted with that already. A link you
  click in an extension's popup or page opens in that page's container, which is container 0,
  unchanged by this rule.
  [`an_extensions_sign_in_tab_shares_the_cookies_its_background_reads`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`what_you_open_still_takes_the_workspaces_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_explicit_container_and_opener_are_kept`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_own_pages_and_windows_are_in_no_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_tab_takes_the_agent_workspaces_container_only_if_it_names_it`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`a_link_clicked_in_an_extensions_popup_opens_in_no_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js)
