## 2. Workspace routing (`workspaces/WorkspaceRouter.sys.mjs`)

Sends a URL to the workspace (container, so cookies) that a `[[routes]]` rule names, from
routes.toml when it exists, else config.toml. Specs:
[workspace-routing](../specs/workspace-routing.md), [routes-file](../specs/routes-file.md).

**Reach:** local apps (links they open, through `vimma-open` or `vimma <url>`, and a cold start
from a link), and local programs on macOS (the Apple Event's sender); pages try to (link clicks, `window.open`) and must fail. What you open inside Vimma
(URL bar, `:open`, bookmarks, `p`) is never routed.

- R1. Routing **must** apply only to links from other apps: the remote command line, a cold start
  from a link, and such a link opened as a window. What you or Vimma's chrome open inside the
  browser stays in the active workspace's container (workspace-routing, decision 9).
  [`an_external_link_routes_by_the_app_that_opened_it`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`only_a_window_opened_for_another_programs_link_is_routed`](../../tests/browser/browser_vimma_workspace_routes_windows.js),
  [`the_url_bar_opens_a_routed_site_in_the_shown_workspace`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`tabnew_and_shift_p_open_a_routed_site_in_the_shown_workspace`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_bookmark_or_a_new_window_opens_a_routed_site_in_the_shown_workspace`](../../tests/browser/browser_vimma_workspace_routes.js)
- R2. A page **never** routes what it opens (clicks, `target=_blank`, `window.open`, redirects,
  same-tab navigation): it could open a URL of its choice with another workspace's cookies.
  [`a_page_can_never_route_the_links_it_opens`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`same_tab_navigation_is_never_moved_but_hinted`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_redirect_inside_a_tab_is_never_moved`](../../tests/browser/browser_vimma_workspace_routes.js)
- R3. A private window is **never** routed and gets no container.
  [`private_windows_are_never_routed`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`private_windows_are_untouched`](../../tests/browser/browser_vimma_workspace_routing.js)
- R4. The names (`-vimma-from`, `VIMMA_FROM`) are at most eight tokens of at most 64 characters
  each, and **must** only select a workspace that a rule in the routes file (routes.toml when it
  exists, else config.toml) names and that exists;
  a name that is not a token once lower-cased is dropped. Spec: [app-routes](../specs/app-routes.md).
  [`a hint that is not a token never matches`](../../packages/vimma-core/test/routes.test.ts),
  [`a rule naming a workspace that does not exist is skipped`](../../packages/vimma-core/test/routes.test.ts),
  [`parseAppList keeps at most eight names, drops non-tokens, keeps the rest`](../../packages/vimma-core/test/routes.test.ts),
  [`parseAppList returns only tokens, at most eight, never two equal neighbours`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.ts),
  [`an_app_list_with_a_bad_name_routes_by_the_rest`](../../tests/browser/browser_vimma_workspace_routes_external.js)
- R5. `VIMMA_FROM` **must** be read once and cleared, so it never reaches a later window or a
  process Vimma starts.
  [`a_new_windows_first_tab_is_routed_with_the_startup_app`](../../tests/browser/browser_vimma_workspace_routes_windows.js)
- R6. A domain rule **never** matches a host outside its domain: not a lookalike
  (`evil-github.com`, `github.com.evil`, letters from another script), nor a disguise
  (`github.com@evil`, a path, query or fragment, `\`, `%2e`, the ideographic full stop).
  [`a domain rule never matches a URL whose host is outside its domain`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.ts),
  [`a domain rule matches its own host and subdomains, however written`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.ts)
- R7. On macOS, a link that arrives as an Apple Event (`kAEGetURL`) **must** be named only by
  its sender, and only when that is a running app with a bundle: its bundle identifier and
  executable name, lower-cased tokens, or only the bundle identifier when the sender is
  sandboxed. Both are self-declared in the app's `Info.plist` and bundle, unchecked against its
  signature, so any app can claim another's; only an App Store app's bundle identifier is
  registered to one developer team. A sender that is not an app (`open`, `osascript`), a process
  outside an app bundle, or one that has exited names nothing, and an inherited `VIMMA_FROM`
  **never** names such a link: at a cold start the patch sets it from the start's first event
  only, and unsets it when that event has no names or another event follows
  (`MacApplicationDelegate-mm.patch`).
  Any launch whose URL is an argument trusts `VIMMA_FROM`, since Vimma cannot tell `vimma-open`
  from another launcher, and a value set with `launchctl setenv` reaches every such launch until
  logout. The pid is the sender the system reports, which may be an overridden one, and a pid
  reused between the event and its handling could name another app: the names stay a hint (R4).
  Spec: [app-routes](../specs/app-routes.md), decision 11. CI's macOS smoke
  ([tools/e2e/macos-app-routes.ts](../../tools/e2e/macos-app-routes.ts), run by `macos.yml`) has a
  helper app open links with Vimma running and from a cold start, the same helper outside a
  bundle, and a link opened by `open` with `VIMMA_FROM` set (step "Links from other apps name
  the app").
  [`routes the opener's bundle identifier to work and its executable name to dev`](../../tools/e2e/test/macos-app-routes.test.ts),
  [`routes the unbundled opener's executable name to dev, so a link it names would show`](../../tools/e2e/test/macos-app-routes.test.ts),
  [`routes a link with no names, or other names, to admin by the domain rule`](../../tools/e2e/test/macos-app-routes.test.ts),
  [`refuses a name with a trailing newline`](../../tools/package/test/mac-sender-names.test.ts),
  [`names nothing for no event, an event with no sender, or one that is not kAEGetURL`](../../tools/package/test/mac-sender-names.test.ts),
  [`at a cold start, a second event leaves VIMMA_FROM unset, whatever it names`](../../tools/package/test/mac-sender-names.test.ts),
  [`a_mac_apps_link_routes_by_its_bundle_identifier_or_executable`](../../tests/browser/browser_vimma_workspace_routes_external.js)
- R8. A rule naming the agent workspace **never** applies to a link from another program (the
  next rule does), and when its `app` equals one of the link's names, no rule with `app` applies
  to that link, so a prompt-injected agent CLI's link cannot reach the terminal's sign-in rules.
  As nothing but such links is routed (R1), such a rule routes nothing, and the hint,
  `:route move` and about:vimma pass over it too: `:route move` would otherwise reopen a typed
  URL, with any token in it, in the agent's container.
  [`a_rule_naming_the_agent_workspace_gives_no_hint_and_no_move`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`a_rule_after_one_naming_the_agent_workspace_applies`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_routes_toml_rule_naming_the_agent_workspace_is_not_followed_from_outside`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an_agent_cli_link_skips_every_app_rule_after_an_agent_rule`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_child_named_after_the_terminal_under_an_agent_cli_never_reaches_the_terminals_rule`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an agent workspace rule drops every name: claude,zsh,ghostty never reaches the ghostty rule`](../../packages/vimma-core/test/routes.test.ts),
  [`the agent cut applies below the first rule without app too`](../../packages/vimma-core/test/routes.test.ts)
- R9. `[routing] default_workspace`, from the routes file (routes.toml when it exists, else
  config.toml), applies
  **only** to links from other programs that no rule matches (a remote command line, or a window
  opened for one), never to what you type, never to the agent workspace, and never in a private
  window.
  [`the_default_workspace_never_applies_to_the_url_bar`](../../tests/browser/browser_vimma_workspace_routes_windows.js),
  [`a_cold_start_link_with_no_rule_opens_in_the_default_workspace`](../../tests/browser/browser_vimma_workspace_routes_windows.js),
  [`the_default_workspace_never_applies_in_a_private_window`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`a_default_workspace_naming_the_agent_workspace_is_passed_over`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_routes_toml_default_workspace_naming_the_agent_workspace_is_passed_over`](../../tests/browser/browser_vimma_agent_outside_opens.js),
  [`routes.toml owns [routing]: config.toml's default_workspace never applies`](../../packages/vimma-core/test/routes-file.test.ts)
- R10. The names of the last link from another program, and of each tab an app rule placed, are
  kept **in memory only**, are shown only in about:vimma and **never** with the link's URL, and
  the `:bug` report keeps only the rule count, because they tell which programs you run. A
  tab's names apply only while it stays on the host it was opened on: once its own navigation
  leaves that host, it is matched as any page is (R2).
  [`about_vimma_shows_the_last_names_without_the_url`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`an_app_routed_tab_is_not_hinted_back_by_a_domain_rule`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`route_move_keeps_an_app_routed_tab_until_it_leaves_the_host`](../../tests/browser/browser_vimma_workspace_routes_external.js),
  [`an_app_routed_tabs_names_never_pick_the_agent_workspace`](../../tests/browser/browser_vimma_agent_outside_opens.js)
