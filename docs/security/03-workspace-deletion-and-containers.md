## 3. Workspace deletion and containers (`workspaces/WorkspaceStore.sys.mjs`)

Closing a runtime workspace deletes its container and that container's cookies and site data.
Spec: [m3-workspaces](../specs/m3-workspaces.md). A temporary container is deleted with its data
when its last tab closes (W9 to W12). Spec: [temporary-containers](../specs/temporary-containers.md),
behind `vimma.feature.temporary_containers` until it is finished.

**Reach:** you, by keys, `:wsdelete` or `:tmp`. Extensions and Firefox's Settings can delete
containers.

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
- W8. A tab or window an extension opens at a web page or one of its own pages, with no
  `cookieStoreId` and no opener tab, is in container 0, as in Firefox, so its sign-in shares the
  cookies its background reads (#1221). Vimma never puts it in a workspace's container, the agent
  workspace's included, and in the agent workspace it is `foreign`, so no agent lists or reads it.
  Only an open whose triggering principal is the extension's own (one with an add-on policy)
  does this. A page cannot get there: what a page opens (links, `target=_blank` with
  `rel=noopener`, `window.open` popups, links in an extension page a web page frames) carries the
  page's origin attributes (`BrowserDOMWindow.sys.mjs`, the new tab's `openWindowInfo` in
  `Tabbrowser.sys.mjs`), so its container is set before Vimma's default is asked; what you open
  still takes the workspace's. An about: page, `tabs.create` with no URL (the new tab page) and
  `windows.create` with no URL (the start page) take the workspace's container, as `ctrl+t` and
  `ctrl+n` do; so does `windows.create` with several URLs, which Firefox opens with the system
  principal. The container is chosen when the tab opens: an extension may still open such a tab
  and then load its sign-in page there with `tabs.update`, as it could before. An extension that
  names a container (`cookieStoreId`, which needs its `cookies` permission) or an opener tab gets
  that one, as in Firefox, the agent workspace's included: extensions are trusted with that
  already. A link you click in an extension's popup or page opens in that page's container,
  which is container 0, unchanged by this rule. Container 0 is shared by every workspace, so a
  page an extension opens for you (a tab or bookmark manager that names no container) shares its
  cookies with every other such tab, not with the workspace's: workspace isolation does not
  cover it.
  [`an_extensions_sign_in_tab_shares_the_cookies_its_background_reads`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`what_you_open_still_takes_the_workspaces_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_explicit_container_and_opener_are_kept`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_own_pages_and_windows_are_in_no_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`an_extensions_tab_takes_the_agent_workspaces_container_only_if_it_names_it`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`a_link_clicked_in_an_extensions_popup_opens_in_no_container`](../../tests/browser/browser_vimma_workspace_extension_tabs.js),
  [`a_page_never_opens_in_no_container_through_an_extension`](../../tests/browser/browser_vimma_workspace_extension_tabs.js)
- W9. Only Vimma's own temporary containers are **ever** deleted as temporary: an id Vimma
  recorded when `:tmp` or `:tmp vsplit` / `:tmp split` made it (in memory, and in `vimma-workspaces.json` for the next start)
  whose live container still has the name Vimma gave it (`vimma temporary <hex>`), never a
  workspace's container and never container 0. A recorded container renamed in Settings, reused
  after a `containers.json` reset, or now a workspace's keeps its data (W4). A temporary
  container is deleted without a question, unlike W1, because you opened it to be thrown away;
  the guide says so in its first lines about the feature.
  [`canRemoveTemporary: only Vimma's own temporary containers are ever deleted`](../../packages/vimma-core/test/tempcontainers.test.ts),
  [`planTemporaryCleanup (decisions 5 and 18)`](../../packages/vimma-core/test/tempcontainers.test.ts),
  [`a_renamed_recorded_container_is_kept`](../../tests/browser/browser_vimma_temporary_containers.js)
- W10. When the last tab of a temporary container closes, in any window (a pop-up window its page
  opened included), the container **must** be deleted with its cookies, storage and cache
  through `ContextualIdentityService.remove`, after the closing tabs' content browsers are gone,
  so that SessionStore has their last update before it forgets their closed tabs: undo-close-tab
  cannot bring them back, into the deleted container or any other. The workspace's container
  keeps its data.
  [`closing_the_last_temporary_tab_removes_the_container_and_its_cookies`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_popup_from_a_temporary_tab_shares_its_container`](../../tests/browser/browser_vimma_temporary_containers.js)
- W11. A temporary container a crash or a quit left **must** be deleted at the next start (W9's
  check first), and a tab session restore brings back in it is closed, its data deleted once more
  after its browser is gone (a selected one loaded its page meanwhile), and not left in the
  recently closed tabs. Until then its data is on disk like any container's. The record is
  written with the rest of `vimma-workspaces.json`, after Firefox's short save delay: a crash
  within that delay of `:tmp` leaves an unrecorded container, which W9 keeps, as an ordinary
  container with its data, until it is removed in Firefox's container settings.
  [`a_recorded_container_left_by_a_crash_is_removed_at_startup`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_temporary_tab_restored_into_a_deleted_container_is_closed`](../../tests/browser/browser_vimma_temporary_containers.js)
- W12. A temporary container keeps its cookies and site data apart from the workspace's, both
  ways; it is **not** private browsing: form history, saved logins you choose to save,
  bookmarks, downloads, HSTS entries and session-restore entries are kept as for any tab
  ([temporary-containers](../specs/temporary-containers.md), "Security and privacy"). A tab you
  open from it (`ctrl+t`, `:tabnew`) takes the workspace's container; a tab or pop-up its page
  opens takes its own, as Firefox's opener rule gives it. A link from another app never lands in
  one: Firefox's container guess skips it, and "the current tab" on one becomes a new tab. A
  temporary tab never moves to another workspace, which would reopen it in a signed-in
  container, nor into the private workspace, which would carry its URL there; both are refused
  before the y/N. A temporary pane made by `:tmp vsplit` / `:tmp split` is such a tab: the pane
  beside it keeps the workspace's container, and a split refused (past `[panes] max`, in the
  agent or private workspace) makes no container.
  [`a_cookie_set_in_a_temporary_tab_is_not_seen_by_the_workspace_and_back`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_new_tab_from_a_temporary_tab_takes_the_workspace_container`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`an_external_link_never_lands_in_a_temporary_container`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_temporary_tab_cannot_move_workspace`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_temporary_tab_cannot_move_into_the_private_workspace`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`tmp_vsplit_puts_a_temporary_pane_beside_a_workspace_pane`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`a_refused_tmp_split_makes_no_tab_and_no_container`](../../tests/browser/browser_vimma_temporary_containers.js),
  [`tmp_is_refused_in_the_private_workspace`](../../tests/browser/browser_vimma_temporary_containers.js)
