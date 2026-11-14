## 2. Workspace routing (`workspaces/WorkspaceRouter.sys.mjs`)

Sends a URL to the workspace (container, so cookies) that a `[[routes]]` rule names. Spec:
[workspace-routing](../specs/workspace-routing.md).

**Reach:** you (URL bar, `:open`, bookmarks, `p`); local apps (links they open through
`vimma-open`); pages try to (link clicks, `window.open`) and must fail.

- R1. Routing **must** apply only to opens you or Vimma's chrome started, and to links from other
  apps. [`the_url_bar_routes_to_the_rules_workspace_and_switches`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`shift_p_routes_a_clipboard_url`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`an_external_link_routes_by_the_app_that_opened_it`](../../tests/browser/browser_vimma_workspace_routes.js)
- R2. A page **never** routes what it opens (clicks, `target=_blank`, `window.open`, redirects,
  same-tab navigation): it could open a URL of its choice with another workspace's cookies.
  [`a_page_can_never_route_the_links_it_opens`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`same_tab_navigation_is_never_moved_but_hinted`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_redirect_inside_a_tab_is_never_moved`](../../tests/browser/browser_vimma_workspace_routes.js)
- R3. A private window is **never** routed and gets no container.
  [`private_windows_are_never_routed`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`private_windows_are_untouched`](../../tests/browser/browser_vimma_workspace_routing.js)
- R4. The names (`-vimma-from`, `VIMMA_FROM`) are at most eight tokens of at most 64 characters
  each, and **must** only select a workspace that a rule in config.toml names and that exists;
  a name that is not a token once lower-cased is dropped. Spec: [app-routes](../specs/app-routes.md).
  [`a hint that is not a token never matches`](../../packages/vimma-core/test/routes.test.mjs),
  [`a rule naming a workspace that does not exist is skipped`](../../packages/vimma-core/test/routes.test.mjs),
  [`parseAppList keeps at most eight names, drops non-tokens, keeps the rest`](../../packages/vimma-core/test/routes.test.mjs),
  [`parseAppList returns only tokens, at most eight, never two equal neighbours`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs),
  [`an_app_list_with_a_bad_name_routes_by_the_rest`](../../tests/browser/browser_vimma_workspace_routes.js)
- R5. `VIMMA_FROM` **must** be read once and cleared, so it never reaches a later window or a
  process Vimma starts.
  [`a_new_windows_first_tab_is_routed_with_the_startup_app`](../../tests/browser/browser_vimma_workspace_routes.js)
- R6. A domain rule **never** matches a host outside its domain: not a lookalike
  (`evil-github.com`, `github.com.evil`, letters from another script), nor a disguise
  (`github.com@evil`, a path, query or fragment, `\`, `%2e`, the ideographic full stop).
  [`a domain rule never matches a URL whose host is outside its domain`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs),
  [`a domain rule matches its own host and subdomains, however written`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs)
- R8. A rule naming the agent workspace **never** applies to a link from another program (the
  next rule does), and when its `app` equals one of the link's names, no rule with `app` applies
  to that link, so a prompt-injected agent CLI's link cannot reach the terminal's sign-in rules.
  [`a_rule_after_one_naming_the_agent_workspace_applies`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an_agent_cli_link_skips_every_app_rule_after_an_agent_rule`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_child_named_after_the_terminal_under_an_agent_cli_never_reaches_the_terminals_rule`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an agent workspace rule drops every name: claude,zsh,ghostty never reaches the ghostty rule`](../../packages/vimma-core/test/routes.test.mjs),
  [`the agent cut applies below the first rule without app too`](../../packages/vimma-core/test/routes.test.mjs)
- R9. `[routing] default_workspace` applies **only** to links from other programs that no rule
  matches (a remote command line, or a window opened for one), never to what you type, never to
  the agent workspace, and never in a private window.
  [`the_default_workspace_never_applies_to_the_url_bar`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_cold_start_link_with_no_rule_opens_in_the_default_workspace`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`the_default_workspace_never_applies_in_a_private_window`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_default_workspace_naming_the_agent_workspace_is_passed_over`](../../tests/browser/browser_vimma_agent_outside_opens.js)
- R10. The names of the last link from another program, and of each tab an app rule placed, are
  kept **in memory only**, are shown only in about:vimma and **never** with the link's URL, and
  the `:bug` report keeps only the rule count, because they tell which programs you run. A
  tab's names apply only while it stays on the host it was opened on: once its own navigation
  leaves that host, it is matched as any page is (R2).
  [`about_vimma_shows_the_last_names_without_the_url`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`an_app_routed_tab_is_not_hinted_back_by_a_domain_rule`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`route_move_keeps_an_app_routed_tab_until_it_leaves_the_host`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`an_app_routed_tabs_names_never_pick_the_agent_workspace`](../../tests/browser/browser_vimma_agent_outside_opens.js)
