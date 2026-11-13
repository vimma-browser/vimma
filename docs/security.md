# Security model

What each risky part of Vimma may do, what it must never do, who can reach it, and the test that
holds it to that. It is a page of rules, not code: review it like a contract. Reporting a
vulnerability: [SECURITY.md](../SECURITY.md).

**How to read it.** Each rule is one "must" or "never" sentence, followed by the tests that
enforce it, as `test name` links into the test file. CI fails if a link stops resolving
(`tools/security/check-doc-links.ts`), so a renamed or deleted test cannot leave a rule
unguarded. **⚠ gap** marks a rule the code does not meet yet, with its issue.

**Fuzzing.** Every parser of outside input (the control protocol, vimma-ctl's JSON, `config.toml`,
routing rules, key notation, the command line, a theme's `colors.toml`) is fuzzed with
property-based tests: a fixed seed on every PR, a random seed and many more cases nightly
(`.github/workflows/fuzz.yml`, spec [m7-fuzzing](specs/m7-fuzzing.md)). Rules S11, U7, R6, F5 and
O7 rest on them.
[`parseKey and parseBinding throw nothing but KeyNotationError, on any text`](../packages/vimma-core/test/fuzz/keys.fuzz.test.mjs),
[`json_parse_never_panics`](../tools/vimma-ctl/tests/protocol_props.rs),
[`decoders_never_panic_and_accept_only_the_schema`](../tools/vimma-ctl/tests/protocol_props.rs)

**Who can reach what.** _You_ means the local user Vimma runs as. _Other local users_ are other
accounts on the same machine. _Pages_ are web content, which runs in sandboxed content
processes. _Extensions_ are installed WebExtensions. _Local apps_ are other programs running as
you.

## 1. Control socket (`ctl/VimmaControl.sys.mjs`)

Lets `vimma-ctl` and scripts drive Vimma: send keys, read state, open a URL, reload the theme.
Since protocol 2 it also lets local AI agents use the agent workspace (the `agent` role, §12).
Specs: [m0-control-server](specs/m0-control-server.md),
[m0-control-protocol-and-vimma-ctl](specs/m0-control-protocol-and-vimma-ctl.md),
[vimma-mcp](specs/vimma-mcp.md), [ADR-007](adr/007-control-socket.md),
[ADR-019](adr/019-agents-over-mcp.md).

**Reach:** any local process can connect to the port; only one that can read the token file
(you, or root) gets past the handshake. Pages and extensions cannot speak the protocol (an HTTP
request is refused). A connection's hello picks its role. With the `full` role, whoever holds the
token is treated as you: `send-keys` can do anything your keyboard can. The `agent` role reaches
only the agent workspace, and every request asks you first (§12).

- S1. The socket **must** be off by default and start or stop only with the pref
  `vimma.control.enabled` or `vimma.mcp.enabled` (`:mcp on`, `[mcp] enabled`). Either one starts
  it, and it stops when both are off. The one exception is an agent CLI's one-time ticket (M51):
  while a ticket is live the socket **may** listen with both switches off, and then **must**
  take only a hello that names a live ticket, write no discovery file, and stop when the last
  ticket ends.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js),
  [`test_agent_role_has_its_own_switch`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../tests/browser/browser_vimma_agent_cli.js)
- S2. It **must** listen on 127.0.0.1 only, never on another interface.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js)
- S3. The token file **must** be mode 0600 from its first byte, and `vimma-ctl` **must** refuse
  one that others can read.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js),
  [`refuses_a_file_others_can_read`](../tools/vimma-ctl/src/discovery.rs),
  [`refuses_an_insecure_discovery_file`](../tools/vimma-ctl/tests/cli.rs)
- S4. No command **must** run before the HMAC handshake; a wrong token is refused and the
  connection closed; the token is never sent before the server proved it knows it. A ticket's
  handshake is the same with the ticket as the key: its hello names the ticket only by its id,
  HMAC-SHA256(ticket, `vimma-ticket` NUL), and the ticket is sent only after the server's proof;
  an auth carries a token or a ticket, never both.
  [`test_handshake`](../tests/browser/browser_vimma_control.js),
  [`challenge.valid's proof is HMAC-SHA256(token, vimma-server NUL nonce)`](../packages/vimma-core/test/control.test.mjs),
  [`a_squatter_gets_neither_the_token_nor_a_command`](../tools/vimma-ctl/tests/cli.rs),
  [`an agent hello with a ticket validates; a ticket and a token together do not`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a_ticket_handshake_proves_the_server_first`](../tools/vimma-ctl/tests/mcp.rs)
- S5. It **must** cap connections (8 open, of which at most 4 agents; 2 waiting for a hello),
  line length (1 MiB) and handshake and idle time. A ticket's connection counts toward the 8
  but not the 4 agents, so MCP agents cannot keep out a task Vimma started; a ticket has one
  connection at a time (M51).
  [`test_limits`](../tests/browser/browser_vimma_control.js),
  [`test_agents_cannot_take_every_connection`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_mcp_agents_cannot_keep_out_a_ticket`](../tests/browser/browser_vimma_agent_cli.js)
- S6. A token file left by a crash **must** be removed at start; a symlink or directory in its
  place is never followed. [`test_stale_discovery_file_removed_at_start`](../tests/browser/browser_vimma_control.js)
- S7. Only the commands of the connection's role **must** run (`full`: the four of protocol 1;
  `agent`: the seven agent commands); anything else, and any unknown argument, is refused.
  [`test_handshake`](../tests/browser/browser_vimma_control.js),
  [`protocol version 1 with the commands of ADR-007`](../packages/vimma-core/test/control.test.mjs),
  [`protocols 1 and 2, two roles, the agent commands apart from v1's`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_each_role_runs_only_its_commands`](../tests/browser/browser_vimma_mcp_agent.js)
- S8. `reload-theme` **never** takes an argument; it reads only the theme folder Vimma's own
  prefs name. [`test_reload_theme`](../tests/browser/browser_vimma_control.js),
  [`takes no args`](../packages/vimma-core/test/control.test.mjs)
- S9. `state` **must** be read-only: it changes no tab, selection, mode or workspace, and never
  gives an unloaded tab its browser. In a private window it **never** reports a tab's URL or
  title; it keeps each tab's id, place, selection, pinning and whether its page is still loading,
  and the pane structure of every split (`panes` and `splits`, tab ids and places only). Its
  `update` field is an allow-list of the update check's result (whether checks are on, the
  install type, the outcome and its time, the offered version and build ID, how far the update
  got) and **never** carries the reason of a refusal, the manifest's serial or key, a URL or an
  advisory; reading it starts no check and no download.
  [`control_state_is_read_only`](../tests/browser/browser_vimma_security_invariants.js),
  [`test_state_splits`](../tests/browser/browser_vimma_control.js),
  [`test_state_update`](../tests/browser/browser_vimma_control.js),
  [`controlUpdateState keeps only the fields the protocol names (m6a-updater 41)`](../packages/vimma-core/test/control.test.mjs),
  [`the_private_workspace_keeps_two_splits_and_state_names_no_page`](../tests/browser/browser_vimma_private_workspace.js),
  [`control_state_never_inserts_a_lazy_tab`](../tests/browser/browser_vimma_security_invariants.js),
  [`vimma_ctl_state_withholds_private_urls_and_titles`](../tests/browser/browser_vimma_private_workspace.js),
  [`vimma_ctl_state_says_whether_a_private_tab_is_loading`](../tests/browser/browser_vimma_private_workspace.js)
- S10. `open` **must** load only http, https, file and about URLs of at most 64 KiB, checked by
  the server itself, never only by the client.
  [`test_server_checks_the_scheme_itself`](../tests/browser/browser_vimma_control.js),
  [`test_open`](../tests/browser/browser_vimma_control.js)
- S11. Whatever bytes a client sends, the server's framing and validator **never** throw, hang
  or change a built-in prototype; the framing gives back exactly the lines sent and refuses a
  line over 1 MiB, and a message outside the protocol is refused.
  [`LineFramer gives back the lines sent, however the bytes are chunked`](../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`any line a client sends, decoded as the server does, validates without throwing`](../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`every valid message validates; one changed or added field makes it invalid`](../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`send-keys passes only keys the server can parse; open only short http(s), file and about URLs`](../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`a type that is not a string is an error, never a throw`](../packages/vimma-core/test/control.test.mjs),
  [`agent-open passes only short http(s) URLs; agent labels never carry control or bidi characters`](../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`test_handshake`](../tests/browser/browser_vimma_control.js)
- S12. The `full` role **must** run only with `vimma.control.enabled`, and the `agent` role only
  with MCP on; a hello for a role that is off is refused (`role-off`) and closed, and turning a
  switch off closes that role's connections. An agent connection **never** reaches `send-keys`,
  `state` or protocol 1's `open`. A ticket's connection is the agent role whatever the
  switches say, is not closed by a switch, and ends with its ticket (M51-M54).
  [`test_agent_role_has_its_own_switch`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_each_role_runs_only_its_commands`](../tests/browser/browser_vimma_mcp_agent.js),
  [`says_the_control_socket_is_off_when_only_mcp_is_on`](../tools/vimma-ctl/tests/cli.rs),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../tests/browser/browser_vimma_agent_cli.js)
- S13. While MCP is on, a new `full` connection **must** get its welcome only after the user's
  `y` in the agent question line (no grant covers it, one waits at a time, three noes mute the
  question for a minute); a no, a timeout or a closed connection refuses it (`denied`). An agent
  with a shell can read the token, so the token alone **never** gives it keys in your window.
  With MCP off nothing asks. While MCP is on, `vimma-ctl` sends a 4-character code in its auth
  and only then prints it, so a process reading your terminal learns it too late to race it in,
  and the question shows it (`vimma-ctl with code 7F3K wants full control`; a client
  without one is "a client with no code"), so a racing client's question is told from the one
  the user ran; the question also says what it reaches (M22). `:control on <minutes>` **must**
  turn full control off when its time is up, also across a restart, and **must** fail closed: an end time that is not a time ahead within 1441
  minutes turns it off.
  [`test_full_control_asks_only_while_mcp_is_on`](../tests/browser/browser_vimma_mcp_control.js),
  [`prints_and_sends_a_code_while_mcp_is_on`](../tools/vimma-ctl/tests/cli.rs),
  [`the_code_is_shown_only_after_its_auth_was_sent`](../tools/vimma-ctl/src/client.rs),
  [`a time ahead, within 1440 minutes and a minute: control stays on until then`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_control_on_minutes_turns_itself_off`](../tests/browser/browser_vimma_mcp_control.js),
  [`waits_for_the_users_answer_while_mcp_is_on`](../tools/vimma-ctl/tests/cli.rs),
  [`reports_refused_full_control_with_exit_4`](../tools/vimma-ctl/tests/cli.rs)
- S14. Without `--profile` or `VIMMA_PROFILE`, `vimma-ctl` **must** read the discovery file only
  from the default profile in the `profiles.ini` where Firefox keeps it on that platform:
  `~/Library/Application Support/Vimma/` on macOS, where `XDG_CONFIG_HOME` does not move it, and
  `$XDG_CONFIG_HOME/vimma/vimma/` (or `~/.config/vimma/vimma/`, or the legacy `~/.vimma/vimma/`)
  on Linux. Its check that the file's pid still runs (`/proc` on Linux, `/bin/ps` on macOS) is
  only a hint: a reused pid passes it, and S4's handshake is what keeps the token from a process
  on the port. `vimma-ctl` runs `/bin/ps` by absolute path, never through `PATH`, and the
  caller's name it takes from it (`vimma-ctl mcp`) is a label, never proof (§12).
  [`profiles_root_finds_application_support_vimma_on_macos`](../tools/vimma-ctl/src/discovery.rs),
  [`xdg_config_home_does_not_move_the_macos_profile_root`](../tools/vimma-ctl/src/discovery.rs),
  [`a_discovery_file_whose_pid_has_exited_is_stale_on_every_unix`](../tools/vimma-ctl/src/discovery.rs),
  [`ps_tells_a_running_pid_from_an_exited_one`](../tools/vimma-ctl/src/discovery.rs),
  [`name_from_ps_keeps_the_executable_name`](../tools/vimma-ctl/src/mcp_serve.rs)

## 2. Workspace routing (`workspaces/WorkspaceRouter.sys.mjs`)

Sends a URL to the workspace (container, so cookies) that a `[[routes]]` rule names. Spec:
[workspace-routing](specs/workspace-routing.md).

**Reach:** you (URL bar, `:open`, bookmarks, `p`); local apps (links they open through
`vimma-open`); pages try to (link clicks, `window.open`) and must fail.

- R1. Routing **must** apply only to opens you or Vimma's chrome started, and to links from other
  apps. [`the_url_bar_routes_to_the_rules_workspace_and_switches`](../tests/browser/browser_vimma_workspace_routes.js),
  [`shift_p_routes_a_clipboard_url`](../tests/browser/browser_vimma_workspace_routes.js),
  [`an_external_link_routes_by_the_app_that_opened_it`](../tests/browser/browser_vimma_workspace_routes.js)
- R2. A page **never** routes what it opens (clicks, `target=_blank`, `window.open`, redirects,
  same-tab navigation): it could open a URL of its choice with another workspace's cookies.
  [`a_page_can_never_route_the_links_it_opens`](../tests/browser/browser_vimma_workspace_routes.js),
  [`same_tab_navigation_is_never_moved_but_hinted`](../tests/browser/browser_vimma_workspace_routes.js),
  [`a_redirect_inside_a_tab_is_never_moved`](../tests/browser/browser_vimma_workspace_routes.js)
- R3. A private window is **never** routed and gets no container.
  [`private_windows_are_never_routed`](../tests/browser/browser_vimma_workspace_routes.js),
  [`private_windows_are_untouched`](../tests/browser/browser_vimma_workspace_routing.js)
- R4. The names (`-vimma-from`, `VIMMA_FROM`) are at most eight tokens of at most 64 characters
  each, and **must** only select a workspace that a rule in config.toml names and that exists;
  a name that is not a token once lower-cased is dropped. Spec: [app-routes](specs/app-routes.md).
  [`a hint that is not a token never matches`](../packages/vimma-core/test/routes.test.mjs),
  [`a rule naming a workspace that does not exist is skipped`](../packages/vimma-core/test/routes.test.mjs),
  [`parseAppList keeps at most eight names, drops non-tokens, keeps the rest`](../packages/vimma-core/test/routes.test.mjs),
  [`parseAppList returns only tokens, at most eight, never two equal neighbours`](../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs),
  [`an_app_list_with_a_bad_name_routes_by_the_rest`](../tests/browser/browser_vimma_workspace_routes.js)
- R5. `VIMMA_FROM` **must** be read once and cleared, so it never reaches a later window or a
  process Vimma starts.
  [`a_new_windows_first_tab_is_routed_with_the_startup_app`](../tests/browser/browser_vimma_workspace_routes.js)
- R6. A domain rule **never** matches a host outside its domain: not a lookalike
  (`evil-github.com`, `github.com.evil`, letters from another script), nor a disguise
  (`github.com@evil`, a path, query or fragment, `\`, `%2e`, the ideographic full stop).
  [`a domain rule never matches a URL whose host is outside its domain`](../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs),
  [`a domain rule matches its own host and subdomains, however written`](../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs)
- R8. A rule naming the agent workspace **never** applies to a link from another program (the
  next rule does), and when its `app` equals one of the link's names, no rule with `app` applies
  to that link, so a prompt-injected agent CLI's link cannot reach the terminal's sign-in rules.
  [`a_rule_after_one_naming_the_agent_workspace_applies`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an_agent_cli_link_skips_every_app_rule_after_an_agent_rule`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_child_named_after_the_terminal_under_an_agent_cli_never_reaches_the_terminals_rule`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`an agent workspace rule drops every name: claude,zsh,ghostty never reaches the ghostty rule`](../packages/vimma-core/test/routes.test.mjs),
  [`the agent cut applies below the first rule without app too`](../packages/vimma-core/test/routes.test.mjs)
- R9. `[routing] default_workspace` applies **only** to links from other programs that no rule
  matches (a remote command line, or a window opened for one), never to what you type, never to
  the agent workspace, and never in a private window.
  [`the_default_workspace_never_applies_to_the_url_bar`](../tests/browser/browser_vimma_workspace_routes.js),
  [`a_cold_start_link_with_no_rule_opens_in_the_default_workspace`](../tests/browser/browser_vimma_workspace_routes.js),
  [`the_default_workspace_never_applies_in_a_private_window`](../tests/browser/browser_vimma_workspace_routes.js),
  [`a_default_workspace_naming_the_agent_workspace_is_passed_over`](../tests/browser/browser_vimma_agent_outside_opens.js)
- R10. The names of the last link from another program, and of each tab an app rule placed, are
  kept **in memory only**, are shown only in about:vimma and **never** with the link's URL, and
  the `:bug` report keeps only the rule count, because they tell which programs you run. A
  tab's names apply only while it stays on the host it was opened on: once its own navigation
  leaves that host, it is matched as any page is (R2).
  [`about_vimma_shows_the_last_names_without_the_url`](../tests/browser/browser_vimma_workspace_routes.js),
  [`an_app_routed_tab_is_not_hinted_back_by_a_domain_rule`](../tests/browser/browser_vimma_workspace_routes.js),
  [`route_move_keeps_an_app_routed_tab_until_it_leaves_the_host`](../tests/browser/browser_vimma_workspace_routes.js),
  [`an_app_routed_tabs_names_never_pick_the_agent_workspace`](../tests/browser/browser_vimma_agent_outside_opens.js)

## 3. Workspace deletion and containers (`workspaces/WorkspaceStore.sys.mjs`)

Closing a runtime workspace deletes its container and that container's cookies and site data.
Spec: [m3-workspaces](specs/m3-workspaces.md).

**Reach:** you, by keys or `:wsdelete`. Extensions and Firefox's Settings can delete containers.

- W1. Site data **never** goes without a y to a y/N question; n keeps everything.
  [`closing_asks_n_keeps_y_deletes_the_container_and_its_cookies`](../tests/browser/browser_vimma_workspace_ops.js),
  [`a_confirmed_delete_removes_the_container_and_its_cookies`](../tests/browser/browser_vimma_workspace_store.js)
- W2. A y **must** stand only for the workspace as asked: after a rename or a config reload in
  between, nothing is closed.
  [`a_stale_answer_closes_nothing`](../tests/browser/browser_vimma_workspace_store.js)
- W3. A delete **must** clear only that workspace's container; other containers keep their data.
  [`a_confirmed_delete_removes_the_container_and_its_cookies`](../tests/browser/browser_vimma_workspace_store.js)
- W4. A container that is no longer recognisably the workspace's (renamed in Settings, reused)
  **must** be kept with its data.
  [`a_container_no_longer_ours_is_kept_and_the_notice_says_so`](../tests/browser/browser_vimma_workspace_ops.js),
  [`reconcile_adopts_and_never_deletes_silently`](../tests/browser/browser_vimma_workspace_store.js)
- W5. Container 0 (the default, shared by everything outside a workspace) is **never** a
  workspace's, so it is never closed or cleared.
  [`container 0 is never a workspace's: a stored id of 0 or below is refused`](../packages/vimma-core/test/workspacedefs.test.mjs)
- W6. Closing a config workspace **must** close its tabs only, never its data; the last
  workspace is never closed.
  [`closing_a_config_workspace_closes_its_tabs_only`](../tests/browser/browser_vimma_workspace_ops.js),
  [`the_last_workspace_cannot_be_closed`](../tests/browser/browser_vimma_workspace_ops.js)
- W7. A container deleted outside Vimma **must** be replaced at once, so new tabs never fall
  into the default container.
  [`a_container_deleted_by_an_extension_is_replaced_at_once`](../tests/browser/browser_vimma_workspace_edges.js),
  [`a_container_deleted_in_settings_is_replaced_and_ext_stays_usable`](../tests/browser/browser_vimma_workspace_edges.js)

## 4. Opening URLs from untrusted text

The clipboard, bookmarks and the command line can hold text someone else wrote. Pages also send
link targets for hints, which chrome must treat as untrusted.

- U1. `p`/`P` **never** open `javascript:` or `data:` URLs, however disguised (case, tabs,
  newlines, `view-source:`).
  [`p_and_shift_p_refuse_javascript_and_data_urls`](../tests/browser/browser_vimma_normal_extras.js),
  [`refuses %j`](../packages/vimma-core/test/pageurl.test.mjs)
- U2. Clipboard text over 8,192 characters **must** be refused, not truncated.
  [`text over the cap is refused, not truncated`](../packages/vimma-core/test/pageurl.test.mjs)
- U3. Bookmarks **must** open only http, https, file and about URLs (bookmarklets are listed but
  never run).
  [`javascript_and_data_bookmarks_refuse_with_a_notice`](../tests/browser/browser_vimma_bookmarks.js),
  [`a javascript: bookmark is listed but refuses to open`](../packages/vimma-core/test/bookmarks.test.mjs)
- U4. `:open` and `:tabnew` **never** open `javascript:` or `data:` URLs, however disguised (case,
  tabs, newlines, leading controls, `view-source:`)
  ([#98](https://github.com/vimma-browser/vimma/issues/98)). No length cap applies to text typed there.
  A search alias or bookmark keyword at the start resolves as the URL bar resolves it
  (`UrlbarUtils.getShortcutOrURIAndPostData`), and the URL it resolves to is checked again, so a
  keyword bookmarklet is refused; the bookmark's principal is never inherited. Other schemes a
  keyword resolves to (`file:`, `about:`) load as they would if typed: there is no allowlist like
  the bookmarks panel's. The query goes to the tab it was typed in (or a new tab in its
  container), even when the workspace changes while the keyword is looked up.
  [`javascript_urls_are_blocked_with_a_notice`](../tests/browser/browser_vimma_cmdline.js),
  [`data_urls_are_blocked_with_a_notice`](../tests/browser/browser_vimma_cmdline.js),
  [`bookmark_keywords_work_and_refused_ones_never_run`](../tests/browser/browser_vimma_search.js),
  [`a_keyword_page_never_inherits_the_current_page`](../tests/browser/browser_vimma_search.js),
  [`a_workspace_switch_during_the_lookup_keeps_the_query_where_it_was_typed`](../tests/browser/browser_vimma_search.js)
- U5. Every Vimma open of text with the system principal (`p`, `P`, `:open`, `:tabnew`) **must**
  refuse those schemes through one shared check (`refusedScheme`, `core/pageurl.mjs`); bookmarks
  and the socket's `open` go further and allow only http, https, file and about.
  [`refuses %j as %s`](../packages/vimma-core/test/pageurl.test.mjs),
  [`lets %j through`](../packages/vimma-core/test/pageurl.test.mjs)
- U6. Hint replies from a page **must** be capped (5,000 targets, 64 frames, 8 KiB links) and
  copied field by field before chrome uses them.
  [`the caps are 5,000 targets, 64 frames and 8 KiB hrefs`](../packages/vimma-core/test/hints.test.mjs),
  [`a well-formed reply → a fresh copy with only the known fields`](../packages/vimma-core/test/hints.test.mjs)
  A text block target ([element-focus](specs/element-focus.md)) **must** carry a kind from the
  closed list and a finite, bounded, non-empty box, and no link. A reply **must** hold only the
  kind of target its collection asked for: a block in an `f`, `gF` or `hint.follow_new_tab_fg` reply, or a link or control in
  an element-focus reply, refuses the whole reply, so a block is never followed.
  [`a block target needs a kind from the closed list and a finite box`](../packages/vimma-core/test/hints.test.mjs),
  [`only a block target carries a blockKind or a box`](../packages/vimma-core/test/hints.test.mjs),
  [`a reply holds only the kind of target its collection asked for`](../packages/vimma-core/test/hints.test.mjs)
  A focused block stays in its frame's actor: each `Vimma:Block` op is answered only for the
  collection the block came from and only by the frame that holds it, except `frame`, which the
  frames around it answer with the viewport of the next frame in (a rect that only places the
  outline, which is clipped to the browser). Each reply **must** be
  checked field by field before chrome uses it (a kind from the closed list, a bounded length and
  box, at most 16 Mi characters of text for `y`, which goes to the clipboard and nowhere else).
  The scroll reports that move the outline are heard only from the block's frame and the frames
  around it, with the documents they had when the block was chosen.
  [`%s: a kind from the closed list, a length and a box`](../packages/vimma-core/test/hints.test.mjs),
  [`yank: the text, and whether the page marks it unselectable`](../packages/vimma-core/test/hints.test.mjs),
  [`malformed_block_messages_are_refused`](../tests/browser/browser_vimma_element.js)
- U7. Text pasted on the command line **must** be read in bounded time: a megabyte never
  freezes the window.
  [`a pasted megabyte is parsed and completed in bounded time`](../packages/vimma-core/test/fuzz/cmdline.fuzz.test.mjs),
  [`parseCommandLine never throws, and a run names a real action`](../packages/vimma-core/test/fuzz/cmdline.fuzz.test.mjs)

## 5. Add-ons (`host/addon-ops.mjs`)

The add-on picker lists, enables, disables and removes extensions. Spec:
[addon-manager](specs/addon-manager.md).

**Reach:** you only (keys and `:addon`); nothing in it is reachable from pages.

- A1. Vimma installs an add-on **only** from the setup page (about:vimma-setup), from
  addons.mozilla.org (an https file there with a sha256 hash), after the user marked it,
  confirmed the summary and accepted Firefox's own permission prompt, which Vimma never answers
  (spec [first-run-setup](specs/first-run-setup.md)). It never installs an add-on update; an
  update goes through about:addons, where Firefox asks about new permissions.
  [`u_reports_the_update_check`](../tests/browser/browser_vimma_addons.js),
  [`installs an add-on only from the setup page`](../tools/security/test/chrome-source.test.ts),
  [`an AMO result off addons.mozilla.org or without a sha256 hash is dropped`](../packages/vimma-core/test/setup.test.mjs)
- A2. Removal **must** ask y/N, and a y stands only for the add-on and version asked about.
  [`d_removes_after_yes_and_keeps_after_no`](../tests/browser/browser_vimma_addons.js),
  [`a_stale_yes_removes_nothing`](../tests/browser/browser_vimma_addons.js)
- A3. System, built-in and hidden add-ons are **never** listed or acted on, by the picker or by
  `:addon name`.
  [`lists_extensions_but_not_system_ones`](../tests/browser/browser_vimma_addons.js),
  [`:addon never reaches a hidden or system add-on`](../packages/vimma-core/test/addons.test.mjs)

Allowed without a question, as in about:addons: enable, disable, and private-window access.

## 6. Chrome UI rendering

Vimma's status bar, pickers, side panel and overlays run with full browser privileges and show
text that pages, add-ons and bookmarks choose.

- C1. Page titles, add-on names, bookmark titles and the downloads picker's file names, hosts,
  verdicts and paths (D1) **must** be set as text (`textContent`), **never** parsed as HTML.
  [`page_titles_with_html_stay_text`](../tests/browser/browser_vimma_security_invariants.js),
  [`names_with_html_are_text`](../tests/browser/browser_vimma_addons.js),
  [`test_names_with_html_stay_text`](../tests/browser/browser_vimma_downloads.js),
  [`toggles_in_the_side_panels_slot_one_panel_at_a_time`](../tests/browser/browser_vimma_bookmarks.js),
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../tools/security/test/chrome-source.test.ts)
- C2. Chrome code **never** builds code from text (`eval`, `Function`) and **never** starts a
  process, with three exceptions. First, the system's ClamAV scanners, `clamscan` (only
  `/usr/bin/clamscan` or `/usr/local/bin/clamscan`) and `clamdscan` (only `/usr/bin/clamdscan`
  or `/usr/local/bin/clamdscan`), never from a `PATH` search, and only a regular file another
  user (root) owns that the user cannot write, in a folder the user cannot write. They run in
  one call with arguments from three fixed builders (the scan, clamd's scan with `--fdpass`, and
  `--version`), the path after `--` and no shell, on an agent download in the quarantine folder
  (M13; [vimma-mcp](specs/vimma-mcp.md) decisions 31 g, 43-45). Second, an AppImage's restart
  (UP11): `/bin/sh` (an absolute path) with one fixed script that waits for Vimma's own process
  to exit and then runs `$APPIMAGE` with no arguments, the process id and the path passed as
  positional parameters the script **never** reads as shell text, started from one call site
  only once a quit can no longer be cancelled. Third, an agent CLI the built-in agent runs
  (M55; [builtin-agent-cli](specs/builtin-agent-cli.md) C2, C4): only the program at the path
  picked in setup, checked before each run, with arguments from one fixed builder
  per CLI, the task on its standard input, no shell, and only when the user sends a task in the
  chat window; its `--version` is the only other call, with that fixed argument, while setup
  lists what a search of `PATH` found, and, for a CLI that has no flag to leave out its other
  MCP servers (Codex), one fixed listing of them (`codex mcp list --json`) right before the
  run, from the same checked path, with no shell and no standard input. Opening a download or
  showing it in its folder hands a file to the OS too: chrome code **must** ask Firefox for it
  only through `DownloadsCommon.openDownload` and `Download.showContainingDirectory`, only from
  `host/download-ops.mjs`, and only on a key the user pressed in the downloads picker (§21), so
  Firefox's executable prompt and Vimma's agent-download rule (M12, the `launchDownload`
  override) are always on the way; it **never** calls `nsIFile.launch`, `nsIFile.reveal`,
  `DownloadUIHelper.loadFileIn`, `launchFile`, the external protocol service or
  `DownloadIntegration.launchDownload` itself, but the agent override's delegation to Firefox's
  own. Chrome code **never** calls
  native code, with one exception: the owner and mode of a file, read through js-ctypes for
  clamd's socket (M13) and for the agent CLI's checks (M55: the program, `vimma-ctl`, the run
  folder and every folder above each), read with `statx(2)` from `libc.so.6` on Linux and `lstat(2)` from
  `/usr/lib/libSystem.B.dylib` on macOS (`lstat` on arm64, `lstat$INODE64` on x86_64, the same
  144-byte `struct stat`), neither following a symlink, and one link's target for those
  checks, read with `readlink(2)` from the same library, because nsIFile follows a chain of links
  to its end and hides the links between. libSystem is opened by its absolute path,
  which dyld resolves from its shared cache, because for a bare name dyld also searches the
  working directory of a process without the hardened runtime, so a library planted where Vimma
  starts would be loaded. Any other system or architecture, a failed call or a struct of
  another size gives no owner, so clamd is not used and an agent CLI is refused. [`never builds code from text: no eval, Function or sandbox evaluation`](../tools/security/test/chrome-source.test.ts),
  [`never starts a process, but ClamAV, an AppImage's restart and an agent CLI`](../tools/security/test/chrome-source.test.ts),
  [`starts an agent CLI only from its checked path, with fixed arguments and no shell`](../tools/security/test/chrome-source.test.ts),
  [`restarts an AppImage through one fixed script, with its path never shell text`](../tools/security/test/chrome-source.test.ts),
  [`/bin/sh runs a fixed script; the pid and the path are arguments, never script text`](../packages/vimma-core/test/restart.test.mjs),
  [`starts the AppImage only once the old process has exited, with no arguments`](../packages/vimma-core/test/restart.test.mjs),
  [`never calls native code, but statx, lstat or readlink for a file's owner, mode or link`](../tools/security/test/chrome-source.test.ts),
  [`opens and reveals downloads only through Firefox's Download, from download-ops`](../tools/security/test/chrome-source.test.ts),
  [`test_enter_and_o_open_through_launchDownload`](../tests/browser/browser_vimma_downloads.js),
  [`test_an_executable_asks_firefoxs_prompt_first`](../tests/browser/browser_vimma_downloads.js)
- C3. With Firefox's toolbar hidden ([toolbar-toggle](specs/toolbar-toggle.md)), the status bar
  is the only origin indicator: the page reaches the window's top, so there is no line of death.
  - The status bar **must** always show the selected page's real address with its registrable
    domain whole: truncation **never** cuts inside it (the path, then the leftmost labels go
    first), also for a `blob:` or `view-source:` address (the origin it carries), and **never**
    in the middle of an address without a host. A page title **never** takes the address's
    place. The bar's order is: the mode's one-column short form, then the error, `not secure`,
    `private` and in-use cues, then the address, then the rest (the mode's full word, the title,
    the tab position, the workspace). The address takes room only from what comes after it: it
    is cut to `…<domain>…` while the rest gives way, and cut further, its domain's end as the
    last resort, rather than push a cue or the mode's short form off the bar. An about:blank a page opened or controls **must** read
    `about:blank from <the origin that wrote it>`, never nothing.
    [`the URL keeps its registrable domain while the toolbar is hidden`](../packages/vimma-core/test/statusbar.test.mjs),
    [`the_status_bar_keeps_the_registrable_domain`](../tests/browser/browser_vimma_toolbar.js),
    [`an_about_blank_a_page_wrote_says_so`](../tests/browser/browser_vimma_toolbar.js),
    [`a_blob_page_shows_its_origin`](../tests/browser/browser_vimma_toolbar.js),
    [`an_about_blank_names_its_writer_after_the_opener_leaves`](../tests/browser/browser_vimma_toolbar.js),
    [`the security cues outrank the kept URL`](../packages/vimma-core/test/statusbar.test.mjs)
  - It **must** say `not secure` wherever Firefox's address bar would warn (plain http, a
    certificate error page or exception, mixed content), read from the browser's security state,
    never from the hidden address bar, and `private` in a private window.
    [`securityFromState`](../packages/vimma-core/test/statusbar.test.mjs),
    [`not_secure_comes_from_the_browser_state`](../tests/browser/browser_vimma_toolbar.js),
    [`the_status_bar_says_not_secure_and_private`](../tests/browser/browser_vimma_toolbar.js)
  - It **must** say which devices the selected page uses (camera, microphone, screen, location,
    XR, serial; `paused` where Firefox says so), the cues the hidden address bar and tab strip
    carried. It does not cover background tabs or the other pane of a split (only the selected
    tab is read, and the tab strip is hidden), nor Firefox's camera and microphone grace period
    after a stream ends; on Linux the desktop's global WebRTC indicator still shows background
    capture.
    [`sharing: devices in use while the toolbar is hidden`](../packages/vimma-core/test/statusbar.test.mjs),
    [`the_status_bar_shows_camera_and_mic_in_use`](../tests/browser/browser_vimma_toolbar.js)
  - A permission prompt **must** hang from its own icon in the address bar, next to the site's
    identity and address, as with the toolbar shown (the prompt bar), and **never** open
    unanchored: if its icon cannot be revealed, the toolbar comes back first. The minimal bar for
    typing an address shows no identity; the status bar above is the origin indicator then. Pop-up
    windows **must** keep their read-only address bar.
    [`a_permission_prompt_hangs_from_its_icon`](../tests/browser/browser_vimma_toolbar.js),
    [`the_identity_panel_shows_the_site_identity`](../tests/browser/browser_vimma_toolbar.js),
    [`a_failed_reveal_for_a_prompt_shows_the_toolbar`](../tests/browser/browser_vimma_toolbar.js),
    [`exclusions`](../tests/browser/browser_vimma_toolbar.js)
  - Vimma's keys for a permission prompt (`y`, `n`, `Tab`; toolbar shown or hidden) **must
    not** answer it before it has shown for `security.notification_enable_delay` with no key in
    between (any key restarts the wait), **never** from a text field (the page's, the chrome's,
    or the prompt's own, such as the password prompt's username), **never** while one of
    Vimma's own surfaces holds the keyboard (a picker, live grep, the command line, a search being
    typed, the other prompts), **never** in hint, copy or element mode (a label typed from any
    `[modal] hint_chars`, the yank: a page can time a prompt to the mode; `Esc` leaves it, and
    then `y` answers), nor while link labels or a focused block are still on screen after a
    prompt took focus (the next key ends them), so `y` and `n` answer a prompt only in normal and
    resize mode or with focus on the prompt itself, and go through Firefox's own buttons, so
    Firefox's click delay still applies. The wait counts from Firefox's own time for the prompt (`timeShown`), which Firefox moves later on its own (for example when the panel
    moves or resizes, the window is activated or another prompt takes the panel), so an armed key
    never meets a button Firefox's delay still refuses. Vimma **never** gives the prompt focus;
    `Tab` focuses the secondary (Block) button first. A prompt Firefox itself opens with focus on
    its panel (the add-on install prompt, `autofocus` in ExtensionsUI) takes the keys from there,
    under the same delay; no text field has focus then.
    The notice after an add-on install ("<name> was added", Firefox's app menu notification)
    takes `y` (OK) and `p` (its "Pin extension to toolbar" checkbox) under the same rules, and
    `Tab` focuses that checkbox; `n` stays Vimma's, since the notice has no second button.
    Firefox gives that notice no delay of its own, so the wait counts from when Vimma sees it
    shown, filled with another add-on's notice in place, or the window activated, or from the
    last key, and it starts again when the checkbox appears or goes and when a permission prompt
    over it closes. A page cannot raise the notice: it follows only an add-on install or enable
    answered in Firefox's own install prompt or add-ons manager. It grants nothing: `p` moves the
    add-on's button between the toolbar and the extensions menu, and private-window access is
    asked in the install prompt, not here. No other notice of that panel takes the keys (the
    update notices' main button restarts the browser).
    [`doorhangerKey`](../packages/vimma-core/test/prompt-keys.test.mjs),
    [`permission_prompts_answer_y_and_n`](../tests/browser/browser_vimma_toolbar.js),
    [`prompt_keys_arm_on_firefoxs_own_delay`](../tests/browser/browser_vimma_toolbar.js),
    [`prompt_keys_leave_live_grep_and_find_their_keys`](../tests/browser/browser_vimma_toolbar.js),
    [`KEY_KEEPING_MODES`](../packages/vimma-core/test/modes.test.mjs),
    [`prompt_keys_leave_hint_copy_and_element_mode_their_keys`](../tests/browser/browser_vimma_toolbar.js),
    [`the_addon_install_prompt_answers_y_and_n`](../tests/browser/browser_vimma_toolbar.js),
    [`the_addon_installed_notice_answers_p_and_y`](../tests/browser/browser_vimma_toolbar.js),
    [`the_prompts_own_fields_take_their_keys`](../tests/browser/browser_vimma_password_prompt.js)
  - Firefox's pop-up blocked bar takes the same keys (`y` allows the site, `n` blocks it, `Esc`
    closes the bar; docs/specs/popup-blocked.md) under the same rules. They count only from the
    later of the moment Vimma first sees the bar and the last key pressed in the window, plus
    `security.notification_enable_delay` (0.5 s by default), so any key restarts the wait, and a
    held (repeated) key never answers. They **never** answer from a text field, while a picker,
    the command line or a search holds the keyboard, or in hint, copy or element mode, and
    **never** while a permission prompt or the add-on installed notice is open, whose keys come
    first; Vimma never moves focus onto the bar. In the agent workspace no key answers the bar and `:popups` refuses, and
    `runPopupRow` checks again when a row runs, so neither the keys nor any row (allow, block,
    reset, open, redirect, hide, settings) does anything there (M10). A row runs only on the
    page it was listed for: the picker keeps the page's principal when it opens and refuses a row
    once the tab's principal differs, so a navigation under the open picker cannot land Allow on
    another site. With `dom.disable_open_during_load` locked, `y` and `n` stay the page's and no
    Vimma path writes the site's permission (the keys, the rows and `setSitePopups`, the site
    permissions picker's writer, §19), as Firefox's own menu hides its allow. Allow goes through Firefox's own
    `toggleAllowPopupsForSite` or `SitePermissions`; Block is stored with Firefox's own
    `Services.perms.addFromPrincipal` (SitePermissions removes a block instead of recording it),
    which keeps it for the private session only in a private window (PermissionManager forces
    `EXPIRE_SESSION` for private principals).
    [`popupBarKey`](../packages/vimma-core/test/prompt-keys.test.mjs),
    [`y_answers_only_once_the_bar_is_armed_and_allows_the_site`](../tests/browser/browser_vimma_popups.js),
    [`n_blocks_the_site_and_esc_only_closes_the_bar`](../tests/browser/browser_vimma_popups.js),
    [`keys_typed_in_a_field_or_the_command_line_are_theirs`](../tests/browser/browser_vimma_popups.js),
    [`a_row_never_lands_on_a_site_the_page_navigated_to`](../tests/browser/browser_vimma_popups.js),
    [`a_locked_popup_pref_leaves_the_site_permission_alone`](../tests/browser/browser_vimma_popups.js),
    [`the_agent_workspace_refuses_and_grants_nothing`](../tests/browser/browser_vimma_popups.js)
  - Firefox's dialogs over a tab or the window (`commonDialog.xhtml`: leave page, a page's
    `alert`, `confirm` and `prompt`, a sign-in; docs/specs/firefox-dialogs.md) take `y` (the
    main button) and `n` (the button `Esc` runs) under the same wait: from the later of the
    moment the dialog's frame loaded and the last key typed in it, plus
    `security.notification_enable_delay`; a key before then, or held, is swallowed and answers
    nothing. They **never** answer from the dialog's own text fields, and press Firefox's own
    buttons, so a button Firefox keeps disabled stays so. A page can open a dialog under a typing
    hand; the wait is what keeps that typing from answering it.
    [`dialogKey`](../packages/vimma-core/test/prompt-keys.test.mjs),
    [`leave_page_n_stays_y_leaves`](../tests/browser/browser_vimma_dialog_keys.js),
    [`prompt_field_types`](../tests/browser/browser_vimma_dialog_keys.js)
  - The external protocol questions over a tab (`permissionDialog.xhtml`, "Allow this site to
    open the link with ...?", and `appChooser.xhtml`, the application list) take the same keys
    under the same wait: `y` opens another application, so a page that follows a link under a
    typing hand must not get that typing as an answer. The wait for every one of these dialogs
    starts again when `SubDialog` shows the frame (`dialogopen`), so it counts only time on
    screen. `y` **also** waits for Firefox's own guard where Firefox applies it (the permission
    question always; the application list when the permission question was skipped), the main
    button it keeps disabled until the dialog's window has had focus for
    `security.dialog_enable_delay` (`EnableDelayHelper`): it is swallowed, never queued, while the
    button is disabled. Only `SubDialog` frames (`.dialogFrame`) are taken. `n` (Cancel) opens nothing. A checkbox ("Always allow") is not a text
    field, so the keys answer from it, and the box's state is the user's, never changed by them.
    [`protocol_permission_n_cancels_y_opens`](../tests/browser/browser_vimma_dialog_keys.js),
    [`protocol_app_chooser`](../tests/browser/browser_vimma_dialog_keys.js)
  - The download question (`unknownContentType.xhtml`, a window of its own opened over the
    browser window) takes the same keys under the same wait, from the window's `load` and again
    each time it becomes the active window: `y`
    presses OK, which saves the file or opens it with an application, so it **also** waits for
    the OK button Firefox keeps disabled (`EnableDelayHelper`), and `n` cancels the download.
    Only a window whose opener is the browser window and whose document is the download question
    is taken; its keys are read in that window, never from a page.
    [`download_n_cancels_y_saves`](../tests/browser/browser_vimma_dialog_keys.js)
  - Accepted, low: a page can time a reveal under the pointer (a permission request shows the
    prompt bar, a download the full toolbar); there is no hover reveal. See the spec's Security
    section.
- C4. Vimma's start page stands in for Firefox's `about:home`, `about:newtab` and `about:welcome`
  modules in the parent process (`start/StartPage.sys.mjs`): while `vimma.startpage.newtab` is
  on, these loads are the chrome start page in the parent, and the stand-in's flags have no
  `URI_SAFE_FOR_UNTRUSTED_CONTENT`, child-process or `MAKE_LINKABLE` flag, so the web can neither
  load nor link to it. Turned off, it hands loads to Firefox's module and its flags. Once it has
  handed out Firefox's page, it **keeps** Firefox's module and flags while any privilegedabout
  process runs, whatever the pref: the parent checks every principal that process sends against
  the about: module's flags of that moment and kills the process on a mismatch (#950). The
  stand-in only ever falls back to Firefox's own module, never the other way round while
  Firefox's page may live.
  [`typed_firefox_pages_open_the_start_page`](../tests/browser/browser_vimma_firefox_surfaces_trim.js),
  [`turning_the_start_page_on_keeps_firefox_new_tab_alive`](../tests/browser/browser_vimma_firefox_surfaces_trim.js)

## 7. Omarchy hook and the `vimma-open` launcher

The hook (`omarchy/vimma-theme-reload.sh`) runs when you change your Omarchy theme. Vimma
writes it into `~/.config/omarchy/hooks/theme-set.d/`. `vimma-open` (`tools/package/`) is the
desktop entry's launcher (`Exec=/usr/lib/vimma/vimma-open %u`, `/opt/vimma/vimma-open %u` in
the PKGBUILD: by its installed path) and the
command `BROWSER=vimma-open` runs: it names the programs that opened a link, nearest first, for
routing (spec [app-routes](specs/app-routes.md), decisions 6 to 10), and hands the link to
`vimma` in its own session.

**Reach:** the hook gets the theme name, which comes from a theme anyone can publish.
`vimma-open` gets a URL and its arguments from any local program, reads `/proc` for the names
of its parent processes, and reads `TERM_PROGRAM`, which any program can set.

- O1. The hook **must** only ask running Vimmas to reload their theme (D-Bus, else
  `vimma-ctl reload-theme`) and **never** start a Vimma.
  [`asks every running Vimma, over Firefox's D-Bus remoting, to reload its theme`](../tools/omarchy/test/theme-hook.test.ts),
  [`never starts Vimma: with none running it does nothing and says nothing`](../tools/omarchy/test/theme-hook.test.ts)
- O2. The hook **never** passes its arguments (the theme name) on to Vimma or `vimma-ctl`.
  [`never passes its arguments on: a hostile theme name changes nothing`](../tools/omarchy/test/theme-hook.test.ts)
- O3. `-vimma-reload-theme` **must** open no window or tab.
  [`test_remote_reload_theme`](../tests/browser/browser_vimma_omarchy_hook.js)
- O4. Vimma **must** write the hook only where none is, or over its own unedited copy; an edited
  copy is yours and never touched. [`test_installer`](../tests/browser/browser_vimma_omarchy_hook.js)
- O5. `vimma-open` **never** passes a single argument that starts with `-`, so a crafted link
  cannot become a browser flag (`-profile`, `--remote-debugging-port`).
  [`refuses a single argument that is a flag: %u must never smuggle one in`](../tools/package/test/vimma-open.test.mjs)
- O6. The names **must** be at most eight lower-case tokens of at most 64 characters each,
  separated by commas (the seven nearest and the farthest); a name that is not a token is
  passed over, never passed on, so a child that renames itself cannot hide an agent CLI's name
  above it (R8), and an inherited `VIMMA_FROM` is **never** passed on. `TERM_PROGRAM` is added
  only when the walk could not see the terminal (it passed a name that is not a token, or hit
  the 32-step limit), so a job an agent CLI left behind, reparented to pid 1, does not take the
  terminal's name.
  [`never passes a name that is not a simple token, and keeps the names before it`](../tools/package/test/vimma-open.test.mjs),
  [`refuses a name with a newline in it`](../tools/package/test/vimma-open.test.mjs),
  [`never passes a VIMMA_FROM it did not set`](../tools/package/test/vimma-open.test.mjs),
  [`keeps the seven nearest names and the farthest past eight`](../tools/package/test/vimma-open.test.mjs),
  [`a_detached_child_under_an_agent_cli_gets_no_TERM_PROGRAM_name`](../tools/package/test/vimma-open.test.mjs),
  [`stops at the compositor without naming it`](../tools/package/test/vimma-open.test.mjs),
  [`a name that is not a token never hides the names beyond it`](../tools/package/test/vimma-open.test.mjs)
- O7. A theme's `colors.toml` (anyone can publish a theme) **must** give only `#rrggbb` colours
  and one CSS rule, and be read in bounded time however deep or large it is.
  [`parseOmarchyColors never throws; a palette has every key, as #rrggbb or a mode`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs),
  [`any theme file and any accepted font give CSS that tokensToCss accepts`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs),
  [`a hostile theme file is read in bounded time: deep, huge, many keys`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs)
- O8. `--from` **must** take exactly one app token and one URL that does not start with `-`
  (else exit 64): it names a program, never a workspace, so the choice stays with config.toml.
  [`--from refuses a name that is not a token`](../tools/package/test/vimma-open.test.mjs),
  [`--from refuses a URL that is a flag`](../tools/package/test/vimma-open.test.mjs),
  [`--from names the app and skips the walk`](../tools/package/test/vimma-open.test.mjs)
- O9. `vimma-open` **never** runs a command of a multiplexer it passes (`tmux`, `herdr`,
  `zellij`): asking a server for its client would run your tmux hooks on every link, and could
  name the wrong terminal. Its server ends the list instead.
  [`never runs tmux or herdr`](../tools/package/test/vimma-open.test.mjs),
  [`a daemonised tmux server ends the list at tmux, whatever its clients`](../tools/package/test/vimma-open.test.mjs)

- O10. Settings' Make default button **must** register only the package's own desktop entry,
  never a command another program chose. On Linux, the first window's first script
  (`services/AppLauncher.sys.mjs`) starts Firefox's shell service with `MOZ_APP_LAUNCHER` set to
  the `vimma-open` next to the binary, replacing any value inherited from the caller, and then
  sets it to empty, so no program Vimma starts inherits it (a Firefox started from one would take
  `vimma-open` as itself, bug 1494436). An AppImage, known by its own `is-packaged-app` marker
  and never by the caller's `APPDIR`, keeps `AppRun`'s value (the `.AppImage`); without a
  `vimma-open` next to the binary (the tarball, a build from source) nothing is set. **⚠ limit:**
  when something starts the shell service first (the profile service making a dedicated default
  profile on a first start, `vimma -setDefaultBrowser`), that session keeps Firefox's behaviour,
  which Vimma reports in the console. A program that can write `~/.local/share/applications` or
  `mimeapps.list` can choose the default browser itself, so a desktop entry there that also runs
  `vimma-open` is outside this boundary (§11). On Omarchy, where GIO names Omarchy's router
  (`omarchy-browser.desktop`) as the http and https handler, Vimma also counts itself the
  default when the entry the router opens (the first installed one past it in the
  `mimeapps.list` files, as `omarchy-cmd-default-browser` reads them) runs exactly the absolute
  command the shell service took as Vimma's own, read line by line exactly as Omarchy's launcher
  reads it, so a relative or quoted command, or a line Omarchy skips, never matches. This
  changes only what Firefox's default-browser check reports (Settings, the startup prompt,
  messaging targeting), never which program opens a link, and nothing is read unless GIO names
  the router.
  [`test_omarchy_s_router_to_vimma_counts_as_default`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_without_omarchy_s_router_nothing_is_read`](../tests/browser/browser_vimma_app_launcher.js),
  [`a quoted Exec never counts, since Omarchy's launcher cannot run it`](../packages/vimma-core/test/default-browser.test.mjs),
  [`matches the program by its exact absolute path, never by name or a relative one`](../packages/vimma-core/test/default-browser.test.mjs),
  [`test_the_shell_service_starts_with_the_launcher_next_to_the_binary`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_inherited_value_never_picks_another_program`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_inherited_appdir_never_keeps_another_program`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_a_shell_service_already_running_is_reported_and_the_value_emptied`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_startup_named_the_launcher_before_anything_else_started_the_service`](../tests/browser/browser_vimma_app_launcher.js),
  [`test_an_appimage_keeps_apprun_s_value`](../tests/browser/browser_vimma_app_launcher.js),
  [`names each package's installed vimma-open by its absolute path in the desktop entry`](../tools/package/test/package.test.mjs)

Allowed: two or more arguments (other than `--from`) pass through unchanged; a local app that
runs `vimma-open` with its own flags could run `vimma` with them directly. Any local program can
also name itself as any program, by `--from`, by the name of its executable or by a chain it
forges (a renamed, detached process): the names are a hint that only selects a workspace a rule
already routes to (R4), the boundary §11 accepts for programs running as you. For the same
reason `VIMMA_BIN`, `VIMMA_OPEN_PROC` and `VIMMA_OPEN_PPID`, which the tests use, are honoured:
they give the caller no more than `--from`, and what they point at comes out only as token names.
[`passes anything but one URL through unchanged`](../tools/package/test/vimma-open.test.mjs)

## 8. `config.toml` (`config/ConfigHost.sys.mjs`)

A local file you trust and edit. Spec: [m5-config-load](specs/m5-config-load.md),
[ADR-008](adr/008-config-toml.md).

- F1. A config.toml Vimma creates **must** be mode 0600 in a 0700 folder. Vimma changes an
  existing file only from `:route add` (an append) and the setup summary (`[search] default`,
  edited in place by `setTomlKeys`), never on a parse error, atomically through a renamed
  temporary file, keeping the file's mode.
  [`a_missing_folder_is_created_private`](../tests/browser/browser_vimma_config_first_run.js),
  [`an_existing_file_is_never_touched`](../tests/browser/browser_vimma_config_first_run.js),
  [`route_add_creates_a_private_config_toml`](../tests/browser/browser_vimma_security_invariants.js),
  [`summary_keeps_comments_and_mode_of_config_toml`](../tests/browser/browser_vimma_setup.js),
  [`summary_writes_nothing_on_a_parse_error`](../tests/browser/browser_vimma_setup.js)
- F2. Every value **must** be validated; a broken file keeps the last good config and a bad
  value (such as a `javascript:` home page) is an error.
  [`broken text keeps the previous config active, unchanged`](../packages/vimma-core/test/config.test.mjs),
  [`workspace %s is an error`](../packages/vimma-core/test/config.test.mjs)
- F3. The config is **never** executed: no value is evaluated as code or run as a command. An
  agent CLI provider names only which supported CLI it is and its model; a `command`, `path`,
  `args` or `env` key in one is an error (M60).
  [`never builds code from text: no eval, Function or sandbox evaluation`](../tools/security/test/chrome-source.test.ts),
  [`command, path, args and env in a cli provider are errors with their line`](../packages/vimma-core/test/config-agent.test.mjs)
- F4. `:route add` **must** write each value as one escaped TOML string, and write nothing when
  the result would not parse.
  [`appendRouteText quotes a workspace name as a TOML string`](../packages/vimma-core/test/routes.test.mjs),
  [`appendRouteText refuses what would not parse, and says why`](../packages/vimma-core/test/routes.test.mjs),
  [`route_add_creates_a_private_config_toml`](../tests/browser/browser_vimma_security_invariants.js)
- F5. Reading `config.toml` **never** throws, hangs or changes a built-in prototype; nesting
  deeper than 32 levels is refused; a key, colour or modifier named like an `Object` member
  (`constructor`, `__proto__`) is unknown, never looked up; an accepted config holds only values
  its schema allows.
  [`parseConfig never throws, on any text, and its result is well-formed`](../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`an accepted config holds only what the schema allows`](../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`huge and deeply nested files are refused or read in bounded time`](../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`a workspace colour named after an Object member is an error, not a value`](../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`a prototype member name is never a key or a modifier: constructor, toString, __proto__`](../packages/vimma-core/test/fuzz/keys.fuzz.test.mjs),
  [`nesting deeper than MAX_DEPTH, by dotted keys, headers or values, is refused at its line`](../packages/vimma-core/test/toml.test.mjs)

## 9. Privacy defaults

Spec: [m0-mozilla-services](specs/m0-mozilla-services.md),
[m0-safebrowsing-key](specs/m0-safebrowsing-key.md).

- P1. Vimma **must** be built without telemetry reporting and upload nothing.
  [`test_no_telemetry_upload`](../tests/browser/browser_vimma_mozilla_services.js)
- P2. Studies and experiments (Normandy, Nimbus) **never** run.
  [`test_normandy_and_nimbus_do_not_run`](../tests/browser/browser_vimma_mozilla_services.js),
  [`test_studies_crash_and_sponsored_defaults_are_off`](../tests/browser/browser_vimma_mozilla_services.js)
- P3. Sponsored content and suggestions are **never** shown by default.
  [`test_no_sponsored_address_bar_suggestions`](../tests/browser/browser_vimma_mozilla_services.js),
  [`test_sponsored_suggestions_survive_suggest_migrations`](../tests/browser/browser_vimma_mozilla_services.js)
- P4. Crash reports are **never** sent. [`test_no_crash_reporter`](../tests/browser/browser_vimma_crash_reporter.js)
- P5. Security services (add-on blocklist, CRLite, add-on updates) **must** keep Firefox's
  defaults. [`test_security_services_stay_on`](../tests/browser/browser_vimma_mozilla_services.js)
- P6. Safe Browsing **must** be on in a build with a Google key, and honestly off (Settings
  says so) in one without.
  [`test_keyed_build_fetches_google_lists`](../tests/browser/browser_vimma_safebrowsing.js),
  [`test_keyless_build_is_honestly_off`](../tests/browser/browser_vimma_safebrowsing.js)
- P7. Site permissions (camera, location, notifications …) **must** be kept per container, so
  per workspace (`permissions.isolateBy.userContext`;
  [vimma-mcp](specs/vimma-mcp.md) decision 30): one given in one workspace never applies to the
  same site in another, the agent workspace included.
  [`test_site_permissions_are_per_workspace`](../tests/browser/browser_vimma_mcp_agent_pages.js)
- P8. A shipped build **must** have release Firefox's developer-tools defaults, although
  `MOZILLA_OFFICIAL` is unset (it would turn telemetry upload on, P1): no chrome-privileged
  Browser Console or Browser Toolbox (`devtools.chrome.enabled`), no remote debugging
  (`devtools.debugger.remote-enabled`, so `--start-debugger-server` is ignored), no `dump()` or
  chrome console output on stdout (`browser.dom.window.dump.enabled`,
  `devtools.console.stdout.chrome`), and the web console's paste guard on
  (`devtools.selfxss.count` = 0). The branding prefs set them. Only the dev harnesses' own
  profiles turn devtools back on: `npm start`'s `user.js` the first four, the site suite's
  (`tools/sites`) chrome and remote debugging. A console opened while `devtools.chrome.enabled`
  is true writes `devtools.selfxss.count` = 5 as a user value (upstream), so the guide says to
  reset it after turning the tools off.
  [`test_devtools_defaults_match_official_firefox`](../tests/browser/browser_vimma_mozilla_services.js),
  [`startPrefs`](../tools/test/start.test.mjs)

## 10. Firefox updates (the upstream autopilot, `upstream.yml`; the Beta canary, `upstream-beta.yml`)

Vimma is only as safe as the Firefox release under it. The autopilot finds each new release,
rebases our patches onto it, runs the suites and opens the PR; a person reviews and merges a
bump unless `AUTO_MERGE_UPSTREAM` lets GitHub's auto-merge take a green, version-only bump (G13). A merged bump labelled `security` then releases on its own when `AUTO_SECURITY_RELEASE` is
on ([ADR-020](adr/020-security-release-without-a-person.md), G11 and G12). Spec:
[m7-upstream-autopilot](specs/m7-upstream-autopilot.md), [ADR-015](adr/015-upstream-autopilot.md),
playbook: [docs/rebase.md](rebase.md). The Beta canary tests `main` on each Firefox Beta build and
reports in an issue, so a release's breakage is known before its deadline (spec
[upstream-beta-canary](specs/upstream-beta-canary.md)).

**Reach:** Mozilla's public feeds (product-details, the MFSA index, archive.mozilla.org, the
Taskcluster index) and this repository. Nothing here runs code from a pull request.

- G1. A newer Firefox release **must** produce a tested bump PR within 6 hours of
  product-details listing it (detection every 4 h, the rebase and suites ≈ 25 min), or, when
  Actions may not open PRs, a pushed branch and a prefilled compare link on its tracking issue.
  [`detects every 4 hours, so a release has a PR within 6 hours`](../tools/test/upstream-workflow.test.mjs),
  [`finds 157.0.2 as a critical security dot release, 3 days to merge`](../tools/upstream/test/autopilot.test.mjs),
  [`falls back to a compare link when Actions may not open PRs`](../tools/test/upstream-workflow.test.mjs),
  [`the fallback comment links a prefilled compare page and keeps the summary`](../tools/upstream/test/autopilot.test.mjs)
- G2. `upstream.yml` **must** fail, and open a `security` issue that mentions the owner, once the
  Firefox on `main` is more than 3 days behind a security dot release (7 days for a major
  release, 14 for a dot release without an advisory), counted from the release date.
  [`limits: 3 days for a security dot release, 7 for a major, 14 otherwise`](../tools/upstream/test/releases.test.mjs),
  [`a security dot release is behind for 3 days, then overdue`](../tools/upstream/test/releases.test.mjs),
  [`the earliest deadline wins: a skipped security release still counts`](../tools/upstream/test/releases.test.mjs),
  [`the drift job fails the run`](../tools/test/upstream-workflow.test.mjs),
  [`the drift issue tables every unshipped release and mentions the owner`](../tools/upstream/test/autopilot.test.mjs)
- G3. A release whose advisories cannot be read **must** count as a security release (label and
  limit), never as one without.
  [`unreadable advisories make security unknown (null), never false`](../tools/upstream/test/releases.test.mjs),
  [`unknown security status (advisories unreadable) uses the security limit`](../tools/upstream/test/releases.test.mjs),
  [`an unreachable advisories page: security unknown, labelled security, a warning`](../tools/upstream/test/autopilot.test.mjs)
- G4. Nothing is **ever** reported on or built from a Firefox source tarball whose SHA-512
  differs from a signed `SHA512SUMS` (B1), a run artifact included: the patch-check report is
  uploaded only after the source check verified the tarball.
  [`nothing is built from a tarball whose SHA-512 Mozilla did not publish`](../tools/test/upstream-workflow.test.mjs),
  [`test_good_signature_but_a_different_hash_fails_naming_expected_and_actual`](../tools/upstream/test_verify_sha512.py),
  [`the source check fails on a SHA512SUMS whose signature is not good`](../tools/upstream/test/source-check.test.mjs),
  [`a report on a tarball that failed verification is never uploaded`](../tools/test/upstream-workflow.test.mjs),
  [`a tampered tarball already on disk fails like a downloaded one`](../tools/upstream/test/firefox-source.test.mjs),
  [`no workflow runs surfer download itself`](../tools/test/full-build-workflows.test.mjs)
- G5. A bump PR is **never** opened ready for review unless every patch applies and the suites
  passed on the new release; otherwise it is a draft that names the conflicting files and hunks.
  [`a ready PR only when patches apply, suites pass and a token starts CI`](../tools/upstream/test/autopilot.test.mjs),
  [`a conflicting bump is a draft that lists the conflicts`](../tools/upstream/test/autopilot.test.mjs),
  [`lists the conflicting files and hunks, fuzz included`](../tools/upstream/test/autopilot.test.mjs)
- G6. The autopilot's jobs **must** run with least privilege: nothing by default, write access
  only in the job that publishes, no secret in detection, the patch check or the suites, no
  `pull_request_target`, every action pinned by commit SHA. The Beta canary's issues reach the
  bump PR through `detect`'s existing `issues: read`; only their numbers and states reach its
  body, so no issue text is rendered there.
  [`grants nothing by default and each job only what it needs`](../tools/test/upstream-workflow.test.mjs),
  [`detect finds the canary's issues for the release's major, open and closed`](../tools/test/upstream-workflow.test.mjs),
  [`reads the issue list from upstream.yml and keeps only issue numbers and states`](../tools/upstream/test/autopilot.test.mjs),
  [`no secret reaches detection, the patch check or the suites`](../tools/test/upstream-workflow.test.mjs),
  [`no workflow runs on pull_request_target`](../tools/test/upstream-workflow.test.mjs),
  [`every action it uses is pinned by a full commit SHA`](../tools/test/upstream-workflow.test.mjs)
- G7. The prefs we copy from upstream (the cfr provider, the Safe Browsing lists) **must** match
  the release under test, or the suites fail with the line to paste. The autopilot refreshes a
  stale copy only from the verified tarball (G4), only in `firefox-branding.js`'s three copied
  lines, and only through the `workflow_call` input of `e2e.yml`, so a pull request run never
  rewrites prefs; a pref gone upstream is never guessed and keeps the PR a draft. No new token or
  secret: `publish` commits the refresh with its existing `contents: write`.
  Patches that need only fuzz are re-exported (`reexport.py`) from the same verified files;
  a result whose added or removed lines differ is refused, `publish` copies in only
  `src/**/*.patch` paths as a second commit, and such a PR waits for the owner.
  [`test_reexport_keeps_added_and_removed_lines`](../tools/upstream/test_reexport.py),
  [`test_a_report_label_outside_src_is_refused`](../tools/upstream/test_reexport.py),
  [`publish commits re-exported patches as a second commit, only under src/`](../tools/test/upstream-workflow.test.mjs),
  [`writes the derived cfr line when upstream adds a field`](../tools/upstream/test/upstream-prefs.test.mjs),
  [`the diff touches only the three copied pref lines`](../tools/upstream/test/upstream-prefs.test.mjs),
  [`reports unresolved and writes nothing for a pref missing upstream`](../tools/upstream/test/upstream-prefs.test.mjs),
  [`source-check computes the refresh only after the SHA-512 check passed`](../tools/test/upstream-workflow.test.mjs),
  [`a pull request run never writes prefs`](../tools/test/upstream-workflow.test.mjs),
  [`a pref gone upstream makes the PR a draft that names it`](../tools/upstream/test/autopilot.test.mjs),
  [`our branding prefs match Firefox 157.0.1's`](../tools/upstream/test/upstream-prefs.test.mjs),
  [`a new upstream cfr field is reported with the line to paste`](../tools/upstream/test/upstream-prefs.test.mjs),
  [`a pref upstream renamed or removed is its own problem, not a silent pass`](../tools/upstream/test/upstream-prefs.test.mjs)
- G8. Every upstream file Vimma patches **must** have a line in the ADR-003 register with a hunk
  and line budget it stays within, and a person **must** review each patch at least once a
  quarter: `patch-audit.yml` opens an `upstream` `audit` issue on the first day of each quarter,
  listing reviews over 92 days old, with `issues: write` only in the job that runs no repository
  code.
  [`test_a_patch_over_its_hunk_or_line_budget_fails_the_audit`](../tools/upstream/test_patch_audit.py),
  [`test_a_register_line_without_a_budget_or_review_date_fails_the_audit`](../tools/upstream/test_patch_audit.py),
  [`test_within_budget_passes_and_reviews_over_92_days_old_are_due`](../tools/upstream/test_patch_audit.py),
  [`test_every_patch_has_a_budget_and_review_date_and_stays_within_it`](../tools/upstream/test_patch_audit.py),
  [`runs on the first day of each quarter, and by hand`](../tools/test/patch-audit-workflow.test.mjs),
  [`grants nothing by default; issues: write only in the report job`](../tools/test/patch-audit-workflow.test.mjs),
  [`the job holding the issue token never checks out or runs repository code`](../tools/test/patch-audit-workflow.test.mjs)
- G9. The Beta canary **must never** write anything but issues: nothing granted by default,
  `issues: write` only in the report job, which checks out and runs no repository code and runs
  only on `main`; no secret, no push, no commit, no pull request, no change to the Firefox pin,
  no `pull_request_target`; every job skipped in a fork. A new issue mentions the owner; an update,
  a comment or a close never does, and test output is fenced so it cannot mention or link.
  [`grants nothing by default and no job more than issues: write`](../tools/test/upstream-beta-workflow.test.mjs),
  [`the job with issues: write checks out and runs no repository code`](../tools/test/upstream-beta-workflow.test.mjs),
  [`the report job runs only on main`](../tools/test/upstream-beta-workflow.test.mjs),
  [`no job pushes, commits or opens a pull request`](../tools/test/upstream-beta-workflow.test.mjs),
  [`no secret reaches any job, and the e2e call passes none`](../tools/test/upstream-beta-workflow.test.mjs),
  [`every job is skipped outside vimma-browser/vimma`](../tools/test/upstream-beta-workflow.test.mjs),
  [`every action is pinned by a full commit SHA`](../tools/test/upstream-beta-workflow.test.mjs),
  [`mentions the owner only when it opens an issue`](../tools/upstream/test/canary.test.mjs),
  [`fences test output and cuts the body to 60,000 characters`](../tools/upstream/test/canary.test.mjs),
  [`surfer.json on main pins a Firefox release, never a beta`](../tools/test/surfer-pin.test.mjs)
- G10. The Beta canary **must never** build from or report on a Beta source tarball whose SHA-512
  differs from that Beta's signed `SHA512SUMS` (B1): the source check fails the run before the
  suites or the issue (G4 for Betas).
  [`nothing is built from a tarball whose SHA-512 Mozilla did not publish`](../tools/test/upstream-beta-workflow.test.mjs),
  [`test_good_signature_but_a_different_hash_fails_naming_expected_and_actual`](../tools/upstream/test_verify_sha512.py),
  [`a report on a tarball that failed verification is never uploaded`](../tools/test/upstream-workflow.test.mjs)
- G11. A merged `upstream` PR labelled `security` **must** set the release PR to auto-merge in the
  same `release-please.yml` run when `AUTO_SECURITY_RELEASE` is on, pinned to the release PR's
  head commit, and **never** any other PR. The merge goes through `RELEASE_PLEASE_TOKEN` and
  GitHub's auto-merge, so the `main` ruleset's required checks still gate it. The release PR
  opens as a draft, whose rebuilds skip the mochitests, Semgrep and CodeQL while still reporting
  every required check (docs/runbook.md, "Draft pull requests"); the job marks it ready for review
  through the same token, which starts those checks on the pinned head, and sets auto-merge only
  once the newest mochitest and Semgrep checks there are not the draft's skips. No CodeQL
  analysis exists for a draft's head, so the code scanning rule also holds the merge until the
  run after "ready for review" has uploaded one. Only `opened` and `synchronize` skip, so no
  skipped success ever replaces a real result on a head, and a run whose checks were skipped
  never covers a push to `main` (`tools/ci/tree-covered.mjs`). release-please rebuilds the
  release PR from `main` on every push (`"always-update"`), and the one other commit on it, the
  `firefox-notes` job's `CHANGELOG.md` edit (the hand-written `[Unreleased]` lines and the Firefox
  version), is made by `main`'s code from the release branch's files read as data, names the blob
  it replaces so that a rebuild in between makes it fail rather than overwrite, and is pushed
  before this job pins the head. The pin is checked when auto-merge is set: a later push to
  `main` rebuilds the release PR, and auto-merge then merges the newest head once its required
  checks pass. A head that release-please pushed without the `firefox-notes` commit fails CI's
  `changelog-lint` step (its `[Unreleased]` is not the first heading), so it cannot merge.
  [`fails when [Unreleased] is not the first version heading`](../tools/release/test/changelog.test.mjs),
  [`firefox-notes reads the release branch as data and does nothing without the token`](../tools/package/test/release-workflow.test.mjs),
  [`firefox-notes moves [Unreleased] into the new entry before naming the Firefox version`](../tools/package/test/release-workflow.test.mjs),
  [`sets auto-merge only once the slow checks of the ready run have replaced the draft's`](../tools/release/test/security-release.test.mjs),
  [`finds no cover in a run whose checks were skipped, such as a draft's`](../tools/ci/test/tree-covered.test.mjs),
  [`marks a draft release PR ready for review, then sets it to auto-merge`](../tools/release/test/security-release.test.mjs),
  [`the mochitests, Semgrep and CodeQL skip a draft and still report their required checks`](../tools/test/draft-pull-requests.test.mjs),
  [`CodeQL still uploads an analysis for every pull request that is not a draft`](../tools/test/draft-pull-requests.test.mjs),
  [`auto-merges the release PR after a merged security bump`](../tools/release/test/security-release.test.mjs),
  [`does nothing for an upstream bump without the security label`](../tools/release/test/security-release.test.mjs),
  [`does nothing for a security-labelled PR from another branch or a fork`](../tools/release/test/security-release.test.mjs),
  [`does nothing for a commit whose subject is not an upstream bump`](../tools/release/test/security-release.test.mjs),
  [`refuses a release PR with another author, branch, base, label or title`](../tools/release/test/security-release.test.mjs),
  [`refuses when the release PR does not contain the bump commit`](../tools/release/test/security-release.test.mjs),
  [`pins the merge to the release PR's head commit`](../tools/release/test/security-release.test.mjs),
  [`security-release runs only on a push to main of vimma-browser/vimma`](../tools/package/test/release-workflow.test.mjs),
  [`RELEASE_PLEASE_TOKEN reaches only release-please, the changelog push and the auto-merge`](../tools/package/test/release-workflow.test.mjs),
  [`release-please.yml grants nothing by default and each job only what it needs`](../tools/package/test/release-workflow.test.mjs)
- G12. The automatic path **must never** merge the first release PR, and **must** stop when the
  variable is unset; with the variable on and no `RELEASE_PLEASE_TOKEN` it fails the run.
  [`refuses before the first release exists`](../tools/release/test/security-release.test.mjs),
  [`does nothing when AUTO_SECURITY_RELEASE is off`](../tools/release/test/security-release.test.mjs),
  [`asks the API nothing while the variable is off or outside main`](../tools/release/test/security-release.test.mjs),
  [`fails when the variable is on and RELEASE_PLEASE_TOKEN is missing`](../tools/release/test/security-release.test.mjs)

- G13. An upstream bump PR **must** be allowed to auto-merge only by `publish` run on `main`, only
  when `AUTO_MERGE_UPSTREAM` allows its release kind, only for a non-draft PR whose every patch
  applied clean or with an offset and whose diff changes nothing but `version.version` in
  `surfer.json` and the copied pref lines, and only for the head commit that diff was read from,
  which `publish` records in a hidden marker in the PR body. `upstream-merge.yml`, run from
  `main` (`workflow_run`) each time a workflow on the PR completes, **must** set auto-merge only
  on a PR opened by the App from a branch of this repository, at the marked head, and only once
  every workflow run the PR started on that head finished green or skipped and no check on it
  failed: the macOS mochitests and package checks that the ruleset does not require hold the
  merge too. GitHub's auto-merge then still waits for every required check of the `main` ruleset
  (spec [upstream-bump-automation](specs/upstream-bump-automation.md), ADR-022). The marker
  grants nothing on its own: a person who can edit the body can already merge.
  [`auto-merge only with the variable, the token, a ready PR and the allowlist`](../tools/test/upstream-workflow.test.mjs),
  [`publish never sets auto-merge: upstream-merge.yml does, once every check is green`](../tools/test/upstream-workflow.test.mjs),
  [`reads every run and check of the head, and merges that head only, with the bump's subject`](../tools/test/upstream-merge-workflow.test.mjs),
  [`runs when any workflow a pull request starts completes, and on nothing else`](../tools/test/upstream-merge-workflow.test.mjs),
  [`acts only on this repository's upstream branches, with the App set up`](../tools/test/upstream-merge-workflow.test.mjs),
  [`refuses a failed, cancelled, timed-out or unapproved run or check`](../tools/upstream/test/merge-ready.test.mjs),
  [`only for the App's own non-draft PR at the head the autopilot allowed`](../tools/upstream/test/merge-ready.test.mjs),
  [`the allowlist reads the branch as pushed`](../tools/test/upstream-workflow.test.mjs),
  [`rebuild disables auto-merge before the push`](../tools/test/upstream-workflow.test.mjs),
  [`dot allows dot releases only; unset or anything else allows none`](../tools/upstream/test/autopilot.test.mjs),
  [`names the first condition that did not hold`](../tools/upstream/test/autopilot.test.mjs),
  [`never with patches that needed fuzz, were re-exported or are applied already`](../tools/upstream/test/autopilot.test.mjs),
  [`refuses another line in firefox-branding.js`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a re-exported patch`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a new, deleted, renamed or mode-changed file`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a file header it does not recognise instead of folding it into the last file`](../tools/upstream/test/bump-diff.test.mjs)
- G14. The private key of the org's GitHub App `vimma-upstream-autopilot`, the secret
  `UPSTREAM_APP_KEY` of the `upstream-autopilot` environment, **must** reach only the `publish`
  job and `upstream-merge.yml`'s `merge` job (which mints a token with Contents and Pull requests
  write only, and runs main's code), and that environment's only deployment policy is the branch `main`, so a workflow edited
  on another branch cannot read it. Each run mints a one-hour token for this repository alone with
  Contents, Pull requests and Issues read and write and no Workflows, so it cannot change a
  workflow file. Without the App (the variable `UPSTREAM_APP_ID` unset), bumps open as drafts with
  `GITHUB_TOKEN` and are never set to auto-merge. A leaked key could open pull requests and set
  auto-merge on any that pass the required checks; revoke it on the App's page.
  [`the App's key reaches only publish, which deploys to upstream-autopilot`](../tools/test/upstream-workflow.test.mjs),
  [`mints the App token for this repository alone, before the checkout`](../tools/test/upstream-workflow.test.mjs),
  [`publish pushes and opens the PR with the App token, else GITHUB_TOKEN`](../tools/test/upstream-workflow.test.mjs),
  [`asks for contents, pull requests and issues, and nothing else`](../tools/upstream/test/create-app.test.mjs),
  [`names every deployment policy other than the branch main`](../tools/upstream/test/create-app.test.mjs),
  [`grants nothing by default and each job only what it needs`](../tools/test/upstream-workflow.test.mjs)
- G15. The `patch-issue` job (patches that do not apply) **must** use only `GITHUB_TOKEN` with
  `contents: read` and `issues: write`, check out without persisted credentials, and pass the
  issue text to `gh` only through `--body-file`. No workflow holds an AI secret: no model runs in
  CI on a failing bump.
  [`patch-issue runs only on a failed patch check, with issues: write and no secret`](../tools/test/upstream-workflow.test.mjs),
  [`patch-issue updates the open issue with the same title`](../tools/test/upstream-workflow.test.mjs),
  [`no workflow holds an AI secret`](../tools/test/upstream-workflow.test.mjs)

## 11. Out of scope and trust boundaries

- **Gecko itself.** Page isolation, the sandbox, TLS and the JavaScript engine are Firefox's.
  Vimma is only as safe as the Firefox release under it, so security comes from shipping each
  Firefox release, and each security dot release, quickly: §10 above and
  [docs/rebase.md](rebase.md) ("Security dot release: the fast path"). Source and dev builds
  have no built-in updater, and release builds will carry Firefox's updater pointed at
  updates.vimma.dev only (UP12,
  [`update_url_matches_the_build`](../tests/browser/browser_vimma_updater.js)); until then
  updates come with your package or Vimma's update check (§16).
- **Malware running as you.** It can read your profile, cookies, the control token and
  config.toml, and drive any app you run. Vimma does not defend against it; file modes keep out
  other local users, not your own processes.
- **Root and physical access** are out of scope.
- **What agents do outside Vimma.** Vimma bounds what a local AI agent can do _through Vimma_
  (§12): the agent workspace only, each request asked. It cannot bound what the agent does with
  its own shell, files and network, or what its host lets it do unasked; that is the agent
  host's matter. A prompt-injected agent with a shell can also read the control token like any
  process of yours, which is why the `full` role is a separate switch to keep off.
- **Build infrastructure.** Trusted: GitHub's hosted runner image and the Actions service,
  Mozilla's release key, and the toolchains Mozilla's build fetches. Everything else that
  reaches a build is verified or pinned: Firefox source (B1), Vimma's code (the release tag or
  `main`, written only through reviewed pull requests), npm packages (lockfile integrity, B3,
  B4) and actions (commit SHAs). A cosign signature on a release attests "built by
  `release.yml` at this tag on a GitHub-hosted runner from these verified inputs"; it does not
  attest that the binary is reproducible, or anything about a compromised runner image or
  Actions service (spec [build-supply-chain](specs/build-supply-chain.md), decision 20).
- **What you type.** Commands you type yourself (`:open`, `:source`, the control socket with your
  token) act with your authority; the rules above stop text from others from doing the same.

## 12. Agents (MCP) (`ctl/AgentGate.sys.mjs`, `ctl/agent-commands.mjs`)

Lets local AI agents (Claude Code, Codex, opencode, Copilot) list, read, open and close tabs of
one workspace, **agent**, through the control socket's `agent` role. Spec:
[vimma-mcp](specs/vimma-mcp.md), [ADR-019](adr/019-agents-over-mcp.md).

**Reach:** any local process that can read the token file, an agent's own shell included,
while MCP is on (`:mcp on`). Every check runs in the browser, never in the client: an agent with
a shell can run `vimma-ctl` itself, or speak the protocol directly.

[mcp-drive](specs/mcp-drive.md) adds `vimma_keys` (Vimma's own page keys in an agent tab: M16, M17,
M20, M23), following its links by hint label (M18, M21), `vimma_show` (the agent workspace brought
to the front with one agent tab selected: M19, M20) and full control's wording while MCP is on
(M22), all in force. [mcp-forms](specs/mcp-forms.md) adds `vimma_elements` (an agent tab's buttons,
fields and links listed with hint labels, sensitive values left out: M25, M31, M32),
`vimma_activate` (a click on one of them, with no user activation, a form submission asked without a
grant, and under one when it pays, sends text, personal details, a secret or a file, or Vimma cannot
tell what it sends: M25, M26, M28, M29, M32) and `vimma_fill` (fields set as form autofill sets
them, never a password, payment card, one-time-code or file field: M25, M27, M28, M32),
`vimma_screenshot` (an image of an agent tab's viewport, refused while a password or payment card
field on screen has a value: M25, M31, M32) and `vimma_console` (an agent tab's script errors,
console errors and warnings and failed requests, read without running page code: M25, M30, M31,
M32), in force. Since [#584](https://github.com/vimma-browser/vimma/issues/584), `vimma_open`,
`vimma_activate` and `vimma_fill` can return the page's element list in their result, made and
limited as a `vimma_elements` call (M31, M32), and a screenshot is smaller unless the agent asks for
it at full size (M31).

[mcp-grants](specs/mcp-grants.md) makes a grant cover every agent tool of its connection: a grant
given in answer to any question, a read included, lets that agent open URLs, follow links, press
keys, click buttons that do not submit a form, fill fields, take screenshots and download (not
dangerous or unscanned files) without asking until it ends. An open can carry in its URL what the
agent read, so a grant is a grant to fetch any http or https address from the agent workspace. What
limits it: the agent workspace's container holds none of your other logins (vimma-mcp decision 7),
so what an agent can read is what the agent workspace holds; every call under a grant shows a notice
(an open names its host) and is a `:mcp log` row with its whole URL (M23); at most 10 opens a minute
(M3); `ctrl+b shift+a` ends every grant at once; and an agent with a shell can send what it read
over its own network without Vimma anyway. A step that may pay, a form submission that sends text,
personal details, a secret or a file ([mcp-consequence](specs/mcp-consequence.md)), a show, a
dangerous or unscanned download and a page's own download still ask under any grant (M11, M13, M19,
M28, M33). [mcp-checkpoints](specs/mcp-checkpoints.md) makes sending a form and paying checkpoints:
one `y` or `n` (and, on a form that is not a payment, sends no secret or file and whose fields Vimma
read in time and in full number, `a` for that button on that site until the grant ends) that shows
what the step sends or spends and leaves the grant as it was (M28, M33). The question's hint names
only the keys (`a until it quits`, or `10a 10 min`), so that the question fits one line; the guide's
key table says that `a` covers every tool, and the grant's notice, shown the moment it is made, says
so and names what still asks and the key that ends it.

Under [agent-speed](specs/agent-speed.md) S2, the agent instructions (vimma-ctl's `INSTRUCTIONS`,
which are also the built-in agent's system text) tell an agent to search a site by opening its
search results by URL with `elements: true` rather than by filling the search field and sending the
form, and to do so only for a search. Such a search is a load, not a form submission: it gives no
new reach, since any URL could already be opened under a grant, and it is under the same rules as
every other open (M6, the open rate of M3, the notice and the `:mcp log` row of M23). It skips only
the form question; the words of the search are what the agent puts in the URL, the same risk as any
open (mcp-grants, above). A form sent through the page, a search included, is still a form
submission under M28: asked without a grant, and under one when it is consequential (for a search:
its words typed into a text field rather than `type=search`) or sent by a fill (mcp-consequence K4).

Under [agent-speed](specs/agent-speed.md) S6, the same instructions tell an agent that steps that
do not depend on each other's results go as several tool calls in one turn, and that each call is
still asked and limited as if it came alone. This changes no rule of the gate: the built-in
agent's loop runs a turn's calls one after another, each checked, rated and logged on its own, so
a checkpoint in the middle of a turn holds back every later call of it until the user answers;
an MCP client that sends a turn's calls at once has them queued, asked and rated one by one as
any other calls (M3's queue and rates).

[mcp-session-grants](specs/mcp-session-grants.md) makes a bare `a` last the agent's whole
session by default (`[mcp] grant_minutes = 0`): the grant has no time limit and ends when the
agent's connection closes, on `ctrl+b shift+a`, `:mcp revoke` or `:mcp off`, or when Vimma quits.
A count before `a` (`10a`), or `grant_minutes` above 0, still gives a timed grant. One answer
therefore lets an agent act for as long as it runs, possibly hours, rather than ten minutes: the
notices, the status bar's `◇ agent granted`, `:mcp log`, the rate limits and the checkpoints are
what bound it, and the guide advises a grant only for a task you are watching. A `vimma-ctl mcp`
process sends a random 256-bit session id in its `agent-hello`; if its link drops, its grant
waits for a connection with the same id for two minutes and then ends (M5). The id is not a
credential beyond the token: it is sent only over the authenticated socket, and a process that
can read it out of `vimma-ctl`'s memory runs as the user and can read the token as well (§11).

- M1. Every agent command but `agent-hello`, `agent-ping` and `agent-cancel` **must** wait for
  your yes, or run under an unexpired grant of that connection, which covers every tool but those
  that always ask (M11, M13, M19, M28, M33); another connection's grant **never** covers it. A
  waiting call a grant releases **must** be logged as run under the grant, and the grant's
  notice **must** count it, since the user never saw it asked.
  [`test_one_grant_covers_every_tool_of_its_connection`](../tests/browser/browser_vimma_mcp_agent.js),
  [`a grant covers every tool of its connection, not another connection's`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a grant lets the connection's queued calls of every tool run, not an always-ask one`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_queued_calls_a_grant_releases_show_as_granted`](../tests/browser/browser_vimma_mcp_agent.js)
- M2. Agent commands **must** see only tabs of the agent workspace in its container, checked
  when each command runs; **never** another workspace's tab, a foreign or pinned tab, or a
  private window's.
  [`test_agent_sees_only_the_agent_workspace`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_confinement_edges`](../tests/browser/browser_vimma_mcp_agent.js)
- M3. No answer within `[mcp] ask_timeout`, a full queue (4 per connection, 16 in all), more
  than 4 requests of one connection waiting or running at once (grants included), more than 10
  opens of one connection in a minute (grants included) and a muted connection (three noes in a
  row, for 60 s; `x`, until it reconnects) **must** deny. A `vimma_open` is refused for the open
  rate before its question as well as after it, so an open over the rate is never asked (issue
  #693); opens asked at once for the last slot can still be refused after a yes, since only the
  count after the question takes the slot.
  [`test_denials_timeouts_queue_and_mute`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_used_up_open_rate_refuses_before_asking`](../tests/browser/browser_vimma_mcp_agent.js),
  [`two connections sending 5 each: 4 of each wait in order, the 5th of each is busy`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`three denials in a row mute a connection for 60 s, without asking`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`no sequence of events breaks the queue's limits or resolves a request twice`](../packages/vimma-core/test/fuzz/agent.fuzz.test.mjs),
  [`test_grants_cannot_flood`](../tests/browser/browser_vimma_mcp_agent.js),
  [`at most OPEN_RATE.max opens per connection in any OPEN_RATE.ms window`](../packages/vimma-core/test/agent-gate.test.mjs)
- M4. The question **never** opens by itself while you type, are in a field, or have another
  prompt open, never takes focus, is armed only after `security.dialog_enable_delay` (1 s), a
  held key **never** counts, and no key but `y` or a count with `a` allows; any other key
  neither allows nor denies. It **must** arm again whenever its window is activated or
  deactivated, focused or blurred, hidden or shown, and when a key arrives before it is armed,
  so a window brought to the front (by the user, or by a process that can focus windows) never
  takes a key meant for another; a just-focused window counts as one being typed in. With a
  prompt, picker, panel or the command line open over it, in hint, copy or element mode (whose
  labels and yank type letters: `y` allows, and with the default `hint_chars` a label can start
  with `a`, which grants a whole task), and for
  the rest of a key sequence, the keys are theirs, and the question **never** opens by itself.
  Text an agent or a page chooses (the client name, which is the agent's own claim and proves
  nothing, and titles) is drawn as a bidi isolate (`<bdi>`), URLs as
  left-to-right isolates. A window not in front gets the urgency hint and a notification with no
  URL, no title and no buttons.
  [`test_the_line_opens_arms_and_ignores_stray_keys`](../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_focus_changes_and_early_keys_rearm_the_line`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_other_ui_opened_over_the_line_gets_the_keys`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_hint_and_copy_mode_keep_their_keys`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_names_titles_and_urls_are_bidi_isolates`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_typing_in_a_field_waits_for_ctrl_b_shift_a`](../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_a_window_not_in_front_gets_attention_and_a_notification`](../tests/browser/browser_vimma_mcp_control.js),
  [`any other key neither allows nor denies`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a hostile title of 300 characters is literal text cut at 60 columns`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M5. Grants **must** be per connection, at most one each, held in memory only, and end on
  `:mcp revoke`, on `ctrl+b shift+a` with no question waiting (one key, no second question), when
  their connection closes and no reconnect of its session claims the grant within 2 minutes, on
  `:mcp off` and, for a timed grant (a count, capped at `[mcp] grant_max_minutes`, or
  `grant_minutes` above 0), at expiry. A grant of a connection that closed **must** be given back
  only to a connection whose `agent-hello` carries the same session id (32 to 128 lowercase hex
  characters), within 2 minutes of the close, once, and never while another open connection holds
  that id; **never** when the connection was muted (`x`); and never for a connection that said
  hello or closed after `:mcp off`, until MCP is on again. `:mcp revoke`, `ctrl+b shift+a` and
  `:mcp off` **must** end such a waiting grant too.
  [`a muted connection's grant is not kept for a reconnect`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`while MCP is off no session is taken or parked, until it is on again`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`keeps its grant within RECONNECT_MS`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`asks again after RECONNECT_MS`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`another session, or none, gets nothing, and the parked grant stays for its own`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a second connection claiming a live session gets nothing`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`revoke ends a parked grant too`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`turning MCP off ends the parked grants and those of the open connections`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`agent-hello: a session id of 32 to 128 lowercase hex characters`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_a_reconnect_of_the_same_session_keeps_its_grant`](../tests/browser/browser_vimma_mcp_agent.js),
  [`grant_minutes 0: a bare a lasts the whole connection, a count is still minutes`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`grants end on revoke and on disconnect, and are listed shortest first`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a connection holds at most one grant`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`the length: a count, or the default for a bare a, capped at grant_max_minutes`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_one_grant_covers_every_tool_of_its_connection`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_count_and_a_grant_minutes_shown_in_the_status_bar`](../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_agent_role_has_its_own_switch`](../tests/browser/browser_vimma_mcp_agent.js)
- M6. `agent-open` **must** load only http and https, in the agent container, never routed and
  never in the foreground: your window keeps its workspace, selected tab and focus. From an
  agent's request naming an agent tab until its reply, including while Vimma waits for your
  answer, that tab's content process runs at foreground priority (`nsIRemoteTab.priorityHint`).
  This schedules the whole process, which holds only tabs of the agent container, and neither
  shows nor renders anything.
  [`test_agent_open_is_background_and_checked`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_a_command_runs_its_tab_at_foreground_priority`](../tests/browser/browser_vimma_mcp_agent.js),
  [`agent-open: only http and https, at most 65536 characters, an optional tab`](../packages/vimma-core/test/control-v2.test.mjs)
- M7. Page text and the page's selection **must** be capped (`[mcp] max_read_chars`, and the
  1 MiB line), well-formed Unicode, and returned inside the untrusted-content delimiters, which
  the page cannot close early, not even with a look-alike tag (other spacing or separators,
  full-width letters, attributes; matched after NFKC).
  [`test_agent_read_returns_marked_text_of_a_hidden_tab`](../tests/browser/browser_vimma_mcp_agent.js),
  [`any page text comes out with exactly one opening and one closing delimiter`](../packages/vimma-core/test/fuzz/agent.fuzz.test.mjs),
  [`test_the_selection_is_marked_and_fits_the_line`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_replies_are_well_formed_unicode`](../tests/browser/browser_vimma_mcp_agent.js)
- M8. A yes **must** stand only for the tab and URL asked about: if the tab left the agent
  workspace or navigated since, the request is denied (`changed`) and nothing is read, loaded
  or closed; a read checks again after collecting everything, just before it replies.
  [`test_the_yes_stands_for_what_was_asked`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_the_read_checks_last`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_confinement_edges`](../tests/browser/browser_vimma_mcp_agent.js)
- M10. Pages in the agent container **must** get no permission prompt and no permission given
  elsewhere: site permissions are kept per container (`permissions.isolateBy.userContext`,
  [vimma-mcp](specs/vimma-mcp.md) decision 30), every `nsIContentPermissionPrompt` request from
  the agent container is cancelled, and camera, microphone and screen are denied per agent tab (a
  browser-scoped DENY, set on each HTTP response and when each document's window global is
  created, so a page a service worker serves is covered). They **must** open no new window or
  tab (`SANDBOXED_AUXILIARY_NAVIGATION` on every agent tab, which is reloaded if it had loaded
  without it; a top-level document it loads over HTTP loses its `Cross-Origin-Opener-Policy`,
  which Firefox refuses in a sandboxed tab, since an agent tab has no opener and opens no window)
  and launch no other app through an external protocol (Firefox's chooser is wrapped for the
  agent container). Their downloads follow M11-M13. A tab of another workspace
  still asks, opens pop-ups and downloads as before.
  [`test_the_agent_container_asks_for_nothing`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_another_workspace_still_asks`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_tabs_open_no_popups`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_site_permissions_are_per_workspace`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_page_from_a_service_worker_is_denied_too`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_sweep_reloads_agent_tabs_that_loaded_unsandboxed`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_pages_launch_no_app`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_builtin_agent_opens_coop_pages`](../tests/browser/browser_vimma_agent_coop.js),
  [`test_mcp_agent_opens_coop_pages`](../tests/browser/browser_vimma_agent_coop.js)
- M11. A download from the agent workspace (by its container, its tab's container, or being written
  to the quarantine folder) **must** ask in the question line first (its name, size, type and host,
  **never** the URL). It is the `vimma_download` of an agent connection only when it is the very
  load that connection's `agent-open` started (its URL before redirects, within a minute, once, and
  never after the tab showed a page); anything else, a page's own download under a grant included,
  asks as "a page in the agent workspace" (no grant, `x` a plain no). Only `https:` is downloaded,
  nothing over `[mcp] download_max_mb` (refused when the size is known, stopped and deleted once it
  grows past it), and a refused download leaves no file. The user's own Save Page, Save Link As and
  Save Image As are the user's (an agent cannot press them) and ask nothing. Another workspace's
  downloads are untouched.
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_no_saves_nothing`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_http_is_refused`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_size_cap`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_an_agents_download_is_its_and_a_grant_covers_it`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_a_grant_never_covers_the_pages_own_downloads`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_classified_by_tab_and_by_place_too`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_dialog_the_launch_path_a_frame_and_a_blob`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_users_save_page_in_an_agent_tab_is_the_users`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_another_workspace_downloads_as_before`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`name, size, type and extension, and the host in bold; no URL`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M12. An agent download **must** be written only to the quarantine folder (`[mcp] download_dir`,
  never home, `/`, the Downloads folder itself, a hidden folder of home, `/tmp`, `/var/tmp` or
  `/dev/shm`; made if missing and chmod 0700, which fails on a folder that is not the user's:
  then, or with any other problem, every agent download is refused with a notice, and the tab's
  bytes go to the profile's own refusal folder), as its `.part` and under its name
  (the agent tab's `downloadFolderOverride`, and Firefox's download dialog wrapped so it never
  offers "open with"), saved with mode 0600 (no exec bit), and **never** opened by Vimma, then or
  later from the downloads list.
  [`test_agent_tabs_may_download_again`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`download_dir is ~ or absolute, never home, / or the Downloads folder itself`](../packages/vimma-core/test/config-v2.test.mjs),
  [`download_dir is never in a hidden folder of home or in /tmp, /var/tmp, /dev/shm`](../packages/vimma-core/test/config-v2.test.mjs),
  [`test_a_folder_that_is_not_private_is_refused`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`[mcp] download_dir and download_max_mb are refused or a quarantine folder in bounds`](../packages/vimma-core/test/fuzz/config.fuzz.test.mjs)
- M13. A dangerous file (an executable or library by name, type or first bytes; a script, a `#!`
  line, an installer or package; Firefox's executable list; an archive Vimma cannot list; a zip
  whose central directory names one of these, or holds an entry with an exec bit, a symbolic
  link or a path that leaves its folder) **must** be allowed only by `!` for that one file: no
  grant covers it and `y` does nothing. Found only in the finished `.part`, and of another kind
  than the one a `!` allowed, it asks again before the file gets its name, and a no deletes it.
  With the system's `clamscan` (C2) the `.part` is scanned before it gets its name
  (`--alert-encrypted=yes --alert-exceeds-max=yes`), and deleted when ClamAV flags it; when
  ClamAV fails, takes over five minutes, or could not look inside (encrypted, over its limits),
  keeping the file unscanned is asked (y/N, no grant), and a no deletes it. The notice says
  scanned, not fully scanned or not scanned. A clean scan by definitions older than
  `[mcp] clamav_max_age_days` (7 days by default), or with no date in `--version`, is **never**
  reported clean: keeping the file is asked the same way, and a yes says "scanned with outdated
  definitions". `clamdscan` is used only when it passes clamscan's checks, the system's
  clamd.conf passes them too and sets a local socket, no TCP socket and both alerts, and the
  socket is a socket (not a symlink) owned by root or `clamav`, on Linux and macOS alike (C2);
  on any failure the file is scanned by `clamscan`. Vimma has no download reputation service of its
  own: Firefox's Safe Browsing checks downloads only in a build with a Google key (P6), so in a
  keyless build these checks and ClamAV are all there is.
  [`test_a_dangerous_file_needs_bang_for_that_one_file`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_dangerous_content_asks_again_and_no_deletes_it`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_a_different_danger_in_the_bytes_asks_again`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`an entry with an exec bit is an executable, whatever its name`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`a symbolic link is dangerous`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`encrypted or over ClamAV's limits: not fully scanned, not infected`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`the arguments: fixed, alerting on what it cannot open, the path after --`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`test_clamav_clean_infected_error_and_missing`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_clamav_stale_definitions_and_clamd`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`stale past the set age, or with no date; never otherwise`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`clamd.conf: a local socket, no TCP, alerting as clamscan is asked to`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`the socket: a socket owned by root or clamav, never by the user or anyone else`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`a grant does not run it, whatever was asked: it waits`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`! allows a dangerous one; y, a and counts do nothing there`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a dangerous name inside makes the zip dangerous, and says which`](../packages/vimma-core/test/agent-downloads.test.mjs),
  [`any bytes: the zip lister and the magic check never throw, and stay inside the file`](../packages/vimma-core/test/fuzz/agent-downloads.fuzz.test.mjs)
- M9. `vimma-ctl mcp`'s JSON-RPC parsing **never** panics, and its standard output carries
  **only** whole JSON-RPC messages, one per line (logs go to standard error); a line over 1 MiB
  is answered with an error and never kept.
  [`any_line_gets_one_message_or_none`](../tools/vimma-ctl/tests/mcp_props.rs),
  [`any_outcome_is_one_tool_result`](../tools/vimma-ctl/tests/mcp_props.rs),
  [`stdout_carries_only_json_rpc_messages`](../tools/vimma-ctl/tests/mcp.rs),
  [`decoders_never_panic_and_accept_only_the_schema`](../tools/vimma-ctl/tests/protocol_props.rs)
- M14. `agent-cancel` (MCP's `notifications/cancelled`) **must** withdraw only a question its own
  connection is still waiting on, and **never** asks or counts towards the connection's limit
  of 4 requests at once. [`test_agent_cancel_withdraws_one_waiting_question`](../tests/browser/browser_vimma_mcp_agent.js),
  [`a_cancelled_call_withdraws_its_question_and_gets_no_response`](../tools/vimma-ctl/tests/mcp.rs)
- M15. `vimma-ctl mcp` **must** connect only with the `agent` role, take the token only from the
  discovery file, and refuse a tool's bad arguments (a non-http(s) URL, a URL over 65,536
  characters, a tab that is not 1 to 20 digits, an unknown argument) before anything reaches
  Vimma. This is defence in depth: the browser checks all of it again (M2, M6, S7), since an
  agent with a shell can run its own client.
  [`a_read_reaches_vimma_as_the_agent_role`](../tools/vimma-ctl/tests/mcp.rs),
  [`the_token_never_leaves_the_handshake`](../tools/vimma-ctl/tests/mcp.rs),
  [`bad_arguments_never_reach_vimma`](../tools/vimma-ctl/tests/mcp.rs),
  [`bad_arguments_are_tool_errors_and_never_reach_vimma`](../tools/vimma-ctl/src/mcp/args.rs)
- M16. `agent-keys` **must** run only the whitelisted action ids of mcp-drive D9, parsed with a
  dispatcher of its own over Vimma's default keymap, never the user's; the whitelist is checked
  on the action ids the dispatcher returns. It **never** sends a key event to the page and
  **never** focuses a field: the prefix, `:`, tab, workspace, window, clipboard, insert, copy
  mode and agent actions (`mcp.answer` among them) are refused before anything is asked. A find
  does not run in a tab that has the user's focus, where the finder would focus a text field.
  Keys with control, bidirectional or invisible characters are refused, so the question shows
  what runs.
  [`each refused group is invalid-args naming the key (M16)`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`a user keymap that binds j to tab.close does not change the agent's j (D10)`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`any text parses to whitelisted actions within the limits, or is refused`](../packages/vimma-core/test/fuzz/agent-keys.fuzz.test.mjs),
  [`agent_keys_never_reach_the_prefix_the_command_line_or_mcp_answer`](../tests/browser/browser_vimma_security_invariants.js),
  [`test_keys_scroll_a_background_tab_without_touching_the_window`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_a_find_never_focuses_a_field_of_the_tab_the_user_is_in`](../tests/browser/browser_vimma_mcp_keys.js)
- M17. `agent-keys` **must** act only on an agent tab (M2), checked before the question, after
  the yes and before each step, in the background: it **never** selects, shows or focuses the
  tab, and **never** changes the window's workspace, mode, find bar or hint mode (finds use the
  tab's own finder, history moves stay in the tab's own session history). A tab the user is
  typing in, in copy or hint mode, a key sequence or its own find bar, is denied `in-use`; a call
  already running stops there.
  [`test_keys_scroll_a_background_tab_without_touching_the_window`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_find_uses_the_tabs_finder`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_back_and_forward_stay_in_the_tab`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_refuses_a_non_agent_tab`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_in_use_while_the_user_types_in_the_tab`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_stop_when_the_tab_leaves`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_keys_stop_when_the_user_starts_using_the_tab`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_agent_hints_leave_the_users_hint_mode_alone`](../tests/browser/browser_vimma_mcp_follow.js)
- M18. A follow (`f<label>`, mcp-drive D12) **must** load only an http or https href the page
  could link to (`checkLoadURIWithPrincipal` with the page's own principal), from an http or
  https page, in the same tab, as a load with no referrer: no click, mousedown or other event
  fires on the link, so no click handler runs (a link to a fragment of the same page fires its
  `hashchange`, as any navigation there would). `f` lists nothing on a page that is not on the
  web (a file, about: or the start page in a tab moved into the agent workspace), whose
  principal may load anything. Its label **must** be from this connection's last `f` on that
  tab, of the top document still shown at the same URL and, for a link in a frame, of that
  frame's document still shown, no older than 120 s; otherwise the step is refused with `stale
labels: send f again`. The 120 s bound `f`'s own list because the child keeps none of its
  links, so nothing else ends a label of a link the page has since replaced; a `vimma_elements`
  list's labels are held by element instead (M25). The label names the href captured when `f` ran, so a frame that
  changed its URL without a new document cannot change where a follow goes. A follow to another site (another
  registrable domain, eTLD+1) **must** be asked as a `vimma_open` of its whole URL, unless the
  connection holds a grant, and a no stops the call (`stopped: "denied"`); it is
  not asked when the open rate has no slot left, and the question is withdrawn when the call's
  60 s run out. Labels
  are over Vimma's default hint characters, never the user's, and the agent's collection is
  keyed by its tab, so it never cancels the user's hint mode in the same window, nor theirs the
  agent's, nor does it take the user's targets from the page's child. Buttons, fields and
  elements clickable only through script are never listed.
  [`test_follow_loads_the_href_without_a_click`](../tests/browser/browser_vimma_mcp_follow.js),
  [`test_follow_refuses_javascript_and_data_hrefs`](../tests/browser/browser_vimma_mcp_follow.js),
  [`test_stale_labels_are_refused`](../tests/browser/browser_vimma_mcp_follow.js),
  [`test_cross_site_follow_asks_as_vimma_open`](../tests/browser/browser_vimma_mcp_follow.js),
  [`test_agent_hints_leave_the_users_hint_mode_alone`](../tests/browser/browser_vimma_mcp_follow.js),
  [`test_links_only_on_web_pages`](../tests/browser/browser_vimma_mcp_follow.js),
  [`f at the end lists the links; f<label> follows one`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`a collection for an agent carries each link's text, capped, and only links`](../packages/vimma-core/test/hints.test.mjs)
- M19. `agent-show` (mcp-drive D2-D7) **must** always ask: no grant covers it, a
  grant given as its answer is refused and `x` is a plain no, so no grant of `vimma_show` ever
  exists (core's `ALWAYS_ASK`, whatever the caller passes). It **must** name only an agent tab
  (M2), checked before the question and again after the yes with the URL asked about, and switch
  only the normal window that holds that tab, only to the agent workspace, through the ordinary
  workspace switch, so `ctrl+^` returns to the workspace and split the user was in. It **never**
  changes a private window and **never** raises or activates a window (in the window that
  switches, the shown tab has the keyboard as after any tab switch): a tab in a window other than
  the one in front switches that window, a pane of an agent split included, and the notice says
  `shown in the other window`. A yes whose window cannot switch is a `failed` row in `:mcp log`.
  Its question opens by itself only while the user is not typing or in a field (vimma-mcp
  decision 14), so the switch never lands mid-typing. Showing a page changes what the user sees,
  so a grant would let an agent switch the view at any moment.
  [`test_show_switches_to_the_agent_tab_and_ctrl_caret_returns`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_always_asks_even_under_a_grant`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_waits_while_the_user_types`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_never_touches_a_private_window`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_never_focuses_a_window`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_a_pane_of_an_agent_split_in_a_window_behind`](../tests/browser/browser_vimma_mcp_show.js),
  [`test_show_refuses_a_tab_changed_after_the_question`](../tests/browser/browser_vimma_mcp_show.js),
  [`it waits even when asked without always, and a grant answer allows it once only`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`no grant: a, counts and x do not grant or mute`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`agent-show: a tab and no other field`](../packages/vimma-core/test/control-v2.test.mjs)
- M20. `agent-keys`' limits (mcp-drive D15) **must** deny: keys over 512 characters or with
  control characters, more than 32 actions, a count over 99 and a find query over 256 characters
  are `invalid-args` before anything is asked; more than 30 calls of one connection a minute,
  counted when asked and before anything else, are `busy`; a `gu`, `gU` or history step that
  loads a page, and each follow, takes a slot of the 10 opens a minute; a label longer than
  200 links need (3 characters) and a count before `f` are `invalid-args`; a call stops 60 s
  after the yes, and no query to the page holds it longer than 5 s. `vimma-ctl mcp` checks the
  size and characters, the find queries and the counts it can see first; the browser checks all
  of it again. More than 6 `agent-show` calls of one connection a minute (mcp-drive D7), counted
  when asked and before the question, are `busy`, so a refused show cannot be retried in a loop.
  A `busy` denial for a used-up rate (M20's keys and shows, M3's opens and M32's lists, clicks,
  fills, screenshots and console reads) names the limit and, to a vimma-ctl at least as new as
  Vimma or a built-in conversation, carries `retryAfter`, the milliseconds from 1 to 60000 until
  the next call is allowed, so an agent waits for the rate rather than for a question that is
  not there (issue #592); the validators take `retryAfter` on a `busy` denial only. It is learnt
  from the connection's own calls alone, and the refusal still comes before anything else is
  learnt. The built-in agent's runner waits out such a refusal once (at most 60 s, ended by
  stopping the task) and runs the call again, through every check and the rate again, so the
  rate paces the agent and bounds it as before (agent-speed S7, issue #601). `vimma-ctl mcp`
  keeps at most 4 requests of a connection unanswered at once, as many as Vimma takes in flight;
  the rest of its 16 wait in vimma-ctl, so a model's parallel calls are not refused as `busy`.
  It counts what Vimma counts: a call withdrawn or past its deadline stays counted until Vimma
  answers it, an `agent-ping` is counted until its answer and is not sent while 4 are
  unanswered (Vimma's idle limit does not close a connection with a request in flight), and
  `agent-cancel` is not counted (issue #693); a withdrawal that cannot be sent ends the connection, and every call waiting on it fails as on any dropped connection, so no call waits on an id a new connection numbers again. Its 16 is a bound on the calls the client waits
  for; a withdrawn call Vimma never answers holds its place in flight, and the held calls then
  end at their own deadlines.
  [`a_withdrawn_call_counts_in_flight_until_vimma_answers_it`](../tools/vimma-ctl/tests/mcp.rs),
  [`an_expired_call_counts_in_flight_until_vimma_answers_it`](../tools/vimma-ctl/tests/mcp.rs),
  [`an_unanswered_ping_counts_in_flight`](../tools/vimma-ctl/tests/mcp.rs),
  [`a_cancelled_held_call_never_reaches_vimma`](../tools/vimma-ctl/tests/mcp.rs),
  [`a_held_call_ends_at_its_deadline`](../tools/vimma-ctl/tests/mcp.rs),
  [`sixteen_calls_wait_at_most_sent_and_held_together`](../tools/vimma-ctl/tests/mcp.rs),
  [`a count of 100, 33 actions, 513 characters and a 257-character query are refused`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-keys: a tab and 1 to 512 characters of keys, no control characters`](../packages/vimma-core/test/control-v2.test.mjs),
  [`at most 30 agent-keys per connection a minute, in OpenRate's class`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_keys_under_a_grant_notice_and_rate`](../tests/browser/browser_vimma_mcp_keys.js),
  [`the refusal names the calls, the limit and the wait`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`retryAfter: 1 to 60000 whole milliseconds, on a busy denial only`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a_rate_limit_names_the_limit_and_the_wait`](../tools/vimma-ctl/src/mcp/render.rs),
  [`a_busy_denial_with_retry_after_is_a_rate_limit`](../tools/vimma-ctl/src/mcp_serve.rs),
  [`a used-up rate`](../packages/vimma-core/test/agent-results.test.mjs),
  [`test_a_used_up_rate_is_waited_out_not_reported_as_questions`](../tests/browser/browser_vimma_agent_chat.js),
  [`calls_past_vimmas_four_in_flight_wait_here_and_all_run`](../tools/vimma-ctl/tests/mcp.rs),
  [`test_loads_count_towards_the_open_rate`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_follows_count_towards_the_open_rate`](../tests/browser/browser_vimma_mcp_follow.js),
  [`a label is lowercase hint characters, at most the longest label of 200 links`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`bad_keys_are_tool_errors_and_never_reach_vimma`](../tools/vimma-ctl/src/mcp/args.rs),
  [`at most 6 agent-show per connection a minute`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_show_refuses_other_tabs_and_six_a_minute_is_the_most`](../tests/browser/browser_vimma_mcp_show.js)
- M21. `f`'s link list **must** be one string inside the untrusted-content delimiters, wrapped
  by the browser with look-alike delimiters broken (M7), and `vimma-ctl mcp` and the protocol
  validator **must** refuse a list that is not, or that holds a second delimiter, so the model
  never sees link texts or URLs outside them. At most 200 links, in reading order, and no more
  than fit 768 KiB of the reply line; each link's text and href are NFKC-normalised before they
  are quoted (a fullwidth quote cannot end the text's JSON string), with control,
  bidirectional and invisible characters (tag characters and variation selectors among them)
  dropped, the text one line cut at 80 characters, the href cut at 2,048; the rest are dropped
  and counted. No page text beyond link texts is returned.
  [`test_f_lists_links_with_labels_marked_untrusted`](../tests/browser/browser_vimma_mcp_follow.js),
  [`at most 200 links; the rest are dropped and counted`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`one line per link: the label, the text as JSON cut at 80, the href cut at 2,048`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`text is one line: whitespace collapsed, bidi and control characters dropped`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`links past the byte budget are left out and counted`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-keys: a link list inside the untrusted delimiters, and how many were dropped`](../packages/vimma-core/test/control-v2.test.mjs),
  [`keys_list_links_as_untrusted_content`](../tools/vimma-ctl/src/mcp/render.rs)
- M22. While MCP is on, `:control on`'s question **must** say that full control reaches every
  workspace and tab, not only the agent workspace, and that any local AI agent with a shell can
  use it, and a yes given after MCP went on or off **never** turns it on; each new full
  connection's question (S13) **must** say `wants full control (every workspace, not only
"agent")` in its text and accessible name, naming the agent workspace, and its desktop
  notification **must** say `(every workspace)`. `vimma-ctl mcp`'s instructions **must** tell the
  model never to ask for full control or `vimma-ctl send-keys`. An agent that wants keys in the
  user's window has to talk the user into full control, so the questions state what a yes gives
  away. [`test_control_on_says_it_reaches_beyond_agent_while_mcp_is_on`](../tests/browser/browser_vimma_mcp_control.js),
  [`test_full_control_asks_only_while_mcp_is_on`](../tests/browser/browser_vimma_mcp_control.js),
  [`while MCP is on, the question says full control reaches beyond the agent workspace`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`full control names the agent workspace it reaches beyond`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`the desktop notification names the client and the kind of request, never a URL`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`the_instructions_advise_against_full_control`](../tools/vimma-ctl/src/mcp/instructions.rs)
- M23. Every agent request that is answered, runs under a grant or is denied (by the gate, or
  after it: `in-use`, `changed`, the keys and show rates) **must** be in `:mcp log`, as must a `vimma_keys`
  call that stopped early (the last 100, in memory only, cleared by `:mcp off`). Each row's
  agent name, title and keys or URL is its own bidi run. Every call under a grant
  **must** show a notice; a `vimma_keys` notice names the keys and the tab, and a follow under a
  grant names the host it loaded. Every follow that loads, asked or under a grant, **must** be a
  row of its own naming the URL it loaded. Grants run calls
  unasked and notices last seconds, so the log is how the user checks afterwards.
  [`test_mcp_log_lists_asked_and_granted_calls`](../tests/browser/browser_vimma_mcp_log.js),
  [`keeps the last 100, newest first`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_keys_under_a_grant_notice_and_rate`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_cross_site_follow_asks_as_vimma_open`](../tests/browser/browser_vimma_mcp_follow.js),
  [`a call under a grant shows what it did and the time left`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M24. A tab you did not open inside the agent workspace **never** takes its container: a link from
  another app (the remote command line, `vimma-open`, Firefox's container guess, a `[[routes]]`
  rule), the control socket's `open`, a tab sent from another device, a new window's first tab, the
  other URLs of its command line and the container cached for the next start. It opens in the last
  workspace used that is not the agent's (else the first one), and the window switches to it; "the
  current tab" on an agent tab becomes a new tab there. A login link clicked in a mail app is then
  never readable by an agent. What you open from inside the agent workspace (ctrl+t, `:open`, the
  URL bar) stays there.
  [`an_external_link_opens_in_the_last_normal_workspace_and_switches`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`browser_dom_window_external_opens_skip_the_agent_container`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`tabs_loaded_from_outside_skip_the_agent_container`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_guess_for_another_workspace_still_counts`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_route_rule_naming_the_agent_workspace_is_not_followed_from_outside`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_tab_sent_from_another_device_skips_the_agent_container`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`the_agent_workspace_is_known_before_config_toml_names_it`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`config_toml_naming_the_agent_workspace_retires_the_recorded_one`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_control_socket_open_skips_the_agent_container`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`a_new_windows_first_tab_and_the_startup_cache_skip_the_agent`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`with_no_normal_workspace_used_yet_the_first_one_is_taken`](../tests/browser/browser_vimma_agent_outside_opens.js),
  [`never the agent workspace, even when it is all there is with a container`](../packages/vimma-core/test/workspacedefs.test.mjs)
- M25. `agent-elements` (mcp-forms F2-F4) **must** act only on an agent tab (M2), checked before
  the question, after the yes and again once the list is made, with the URL asked about, and in
  the background: it **never** selects, shows or focuses the tab or an element in it, and changes
  nothing on the page (no click, no focus, no event). It lists nothing on a page that is not http
  or https. Each frame's child keeps the agent's elements apart from the user's hint targets, so
  a list never cancels the user's hint mode in the same window and never takes the user's targets
  from the page; its labels replace the connection's last `f` on that tab and are bound as M18's
  are, to this connection, that tab, the top document still shown at the same URL and, for an
  element in a frame, that frame's document still shown, but with no time limit: a label lasts
  until the page navigates, its document changes, a new list or `f` replaces it, or its element
  leaves the page, each of which refuses it (`stale labels` or `that element is gone`). An
  element counts as on the page only while it is connected and still belongs to the document
  it was listed in, so one the page adopts into another document (a frame of its own) is gone
  too. The child holds each listed element by reference, so a label can only ever name the
  element the agent was shown. A time limit added nothing to that, since a page can change an
  element's text within any lifetime, and it refused most clicks of a model that takes 90 s a
  step. What a click or a fill then does is asked and checked at that moment, from the element
  as it is then and never from the list (M26-M28, M33). `f<label>` follows only a link from the
  list, as a load of the href the list showed (M18), and only while the link is still in its
  document. `agent-activate`
  (F8-F11) is held the same way: it clicks only
  an element of the connection's current `vimma_elements` list, on an http or https page, with
  the tab never selected and the element never focused, and it is denied as `in-use` while you
  are using the tab, before the question and after the yes. `agent-fill` (F12) is held the same
  way, and also before each field: it sets only fields of that list, never focusing them, and
  stops when you start using the tab or the tab leaves the agent workspace. `agent-screenshot`
  (F18) is held the same way, checked before the question, after the yes and once the image is
  made: the tab's own top window global draws its viewport with `drawSnapshot`, frames of other
  sites included and **never** the browser's chrome, the status bar or another tab, and a tab in
  the background draws its current page, so the tab is never selected or shown. It captures
  only an http or https page, checked before and after the drawing, never a privileged about:
  page, the start page or a local file a tab moved into the agent workspace may show. It changes
  nothing on the page, so it runs while you use the tab. `agent-console` (F22) is held the same
  way, checked before the question, after the yes and once its lists are made, and like
  `agent-screenshot` reads only an http or https page and runs while you use the tab: it reads
  Firefox's caches and Vimma's request log and touches nothing in the tab.
  [`test_elements_lists_kinds_fields_and_forms`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_only_on_web_pages_and_agent_tabs`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_agent_labels_leave_the_users_hint_mode_alone`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_f_follows_only_links_from_an_elements_list`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_labels_of_a_gone_element_are_refused`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_element_labels_last_while_their_element_is_there`](../tests/browser/browser_vimma_mcp_activate.js),
  [`test_screenshot_draws_labels`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`an element list's labels last as long as their page, however slow the agent`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-elements: a tab and no other field`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_activate_clicks_a_button_in_a_background_tab`](../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_in_use_while_the_user_types`](../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_follows_a_same_site_link_as_an_open`](../tests/browser/browser_vimma_mcp_activate.js),
  [`agent-activate: a tab and a label of hint characters, nothing else`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_fill_never_focuses_the_field`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fill_in_use_while_the_user_types`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fills_take_labels_only_from_elements_and_share_the_click_rate`](../tests/browser/browser_vimma_mcp_fill.js),
  [`agent-fill: a tab, fields by label and value, an optional submit`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_screenshot_of_a_background_tab_shows_its_page`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_only_of_agent_tabs`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`agent-screenshot: a tab and an optional labels flag, nothing else`](../packages/vimma-core/test/control-v2.test.mjs),
  [`test_console_returns_uncaught_errors_and_console_errors`](../tests/browser/browser_vimma_mcp_console.js),
  [`test_console_only_of_agent_tabs_and_web_pages`](../tests/browser/browser_vimma_mcp_console.js)
- M26. An agent's click (`agent-activate`, mcp-forms F8) **must** be the frame's child calling
  the element's `click()` after the same untrusted `mouseover`, `mousedown` and `mouseup` your
  `f` hints send, with no event through `nsIDOMWindowUtils` or the widget, so the page gets no
  transient user activation: it cannot write or read the clipboard, use credentials or passkeys,
  or start anything else that needs a real gesture. Vimma **never** gives an agent tab's
  document user activation. A trusted `click()` still runs the page's click listeners in
  Firefox's older "handling user input" state, which some checks accept (audible autoplay,
  pointer lock, a pop-up); pop-ups are refused in agent tabs by their sandbox flags (M10).
  Before the click the child checks again that the element is still the one asked about (not a
  field, not disabled, a submit only if asked as one and to the same method and destination,
  the same link), and once more after the mouse events, which the page can handle; a changed
  element is not clicked and the call says so. It answers before it clicks, so a dialog the
  click opens never holds the call; a request that answers after the call stopped waiting
  clicks nothing. A dialog's text reaches the agent only inside the untrusted-content
  delimiters, and no tool answers a page dialog. After a click that loaded no page, the result
  says which parts of the page changed in place (`changed`: the clicked element, the other
  listed elements, the frame's text outside scripts and styles, a visible dialog element), as
  fixed words from a list that both the browser and `vimma-ctl mcp` check; the comparison runs in
  the clicked element's frame's child, which keeps only a hash of the text, sends no page text
  and reads no sensitive field's value, as in `vimma_elements` (M31). That check runs once the
  clicked element's frame has settled (M28), after the submission allowance of M28 is closed,
  so it opens nothing; a submission the page tries during the call is still stopped and named.
  [`test_activate_gives_the_page_no_user_activation`](../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_says_what_changed_in_place`](../tests/browser/browser_vimma_mcp_activate_changes.js),
  [`activate_says_what_changed_in_place`](../tools/vimma-ctl/src/mcp/render.rs),
  [`agent-activate: what changed in place, from a fixed list`](../packages/vimma-core/test/control-v2.test.mjs),
  [`agent_clicks_never_synthesise_input_or_user_activation`](../tests/browser/browser_vimma_security_invariants.js),
  [`test_activate_reports_a_dialog`](../tests/browser/browser_vimma_mcp_activate.js),
  [`agent-activate: the page after the click, a dialog, a stopped submission`](../packages/vimma-core/test/control-v2.test.mjs),
  [`activate_says_what_the_click_did`](../tools/vimma-ctl/src/mcp/render.rs)
- M27. `agent-fill` (mcp-forms F12, F13) **must never** set a sensitive field: one that is or
  ever was a password field, one the page draws as dots (`-webkit-text-security`), one whose
  autocomplete field name is `current-password`, `new-password`, `one-time-code` or any `cc-*`,
  or one form autofill's heuristics take for a payment card field (every field of its group when
  they fail). Nor a file field, a hidden, disabled or read-only field, an editable root, or a
  value a field does not take (a line break outside a text area, an option a select does not
  have or only in a disabled group, a date, number or range that does not parse or is out of
  bounds). These are refused before anything is asked, and the parent counts a password input
  and a sensitive autocomplete name whatever the child says. In the field's own
  frame the child checks again, when the yes comes and once more just before the set, that the
  field is still set the same way, of the same type and not sensitive; a field that changed
  stops the call, says how many fields were filled, and is not set. The one call of
  `setUserInput` (text fields and text areas) sits behind those checks, and no code the agent
  role reaches gives an input a file. A select is set to its option alone (a multiple select
  loses its other options) and ends the choice as its popup does (`userFinishedInteracting`); a checkbox or radio is clicked, with no user
  activation (M26). Nothing is focused and no key event is sent. At most 32 fields a call, each
  value at most 1,024 characters with no control character but a line break and no character
  that draws nothing (format, zero-width, bidirectional and tag characters, variation
  selectors, fillers), which could hide text from the question; checked in `vimma-ctl mcp` and
  again in the browser. The question shows each field's label, name and value, cut with `…` to
  fit and the fields it leaves out counted; a fill that submits is refused unless its question
  shows every name and value whole. `:mcp log` keeps the values of the calls asked or run in
  full, in memory; a call refused before its question is logged with its labels. A child
  request that runs after the parent stopped waiting sets nothing.
  [`test_fill_refuses_password_card_otp_and_file_fields`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fill_stops_when_a_field_turns_sensitive`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fill_sets_values_and_fires_input_and_change`](../tests/browser/browser_vimma_mcp_fill.js),
  [`agent_fills_never_set_a_file`](../tests/browser/browser_vimma_security_invariants.js),
  [`password, payment card and one-time-code fields are never filled`](../packages/vimma-core/test/agent-act.test.mjs),
  [`file fields, rich text editors, hidden, disabled and read-only fields are refused`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a value of the wrong kind, a line break in one line, a value that does not parse`](../packages/vimma-core/test/agent-act.test.mjs),
  [`fill_limits_are_tool_errors`](../tools/vimma-ctl/src/mcp/args.rs),
  [`fill_values_with_invisible_characters_are_tool_errors`](../tools/vimma-ctl/src/mcp/args.rs),
  [`vimma_fill: each field and value in the question, how many in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M28. A click that submits a form (a submit button or a submit or image input in a form whose
  method is not `dialog`, the element itself, the button it is in or its label's control)
  **must** ask every time without a grant, and under a grant when it is consequential
  ([mcp-consequence](specs/mcp-consequence.md) K2, K3): a payment step (M33); a form that sends
  a password, payment card, one-time-code or file field, an identity field (an autocomplete
  name of a person's name, contact, address, birth date, username or organisation, one form
  autofill's address heuristics infer, or `type=email` or `tel`; a failure of the heuristics
  marks every field), or free text (a textarea or a text-like input other than `type=search`
  whose value is not empty and not a quantity of at most three ASCII digits, read on the raw
  value so digits of other scripts or forms never pass); or a form whose fields the page did not say
  in time, that sends more than the 64 fields besides hidden ones the child reads, or one of whose
  values is longer than the child reads of it. It asks with only `y` and `n`, naming the form's
  method, destination and each field it sends by name and value (hidden fields counted, a file field
  by its name), **never** a password, payment card or one-time-code field's value, only its name and
  `•••`, or the number of fields when the page did not say in time; its yes **never** makes or ends
  a grant, and its `x` is a plain no. Under a grant, a submission that is none of the above runs
  unasked, with the grant's notice and a `:mcp log` row naming its method and destination (M23), and
  the guard below lets that one submission through as after a yes. Because another call (a fill) may
  change the form between that judgement and the click, the child judges the form again just before
  it presses the button, after the page's handlers of the pressing ran, and skips the click when it
  no longer passes (no longer harmless, or, under an allowance, sending a secret, a file or a value
  it cannot read whole). Under a grant, the question of a consequential submission that is not a
  payment step, sends no password, card, one-time-code or file field, and is known whole (its fields
  said in time, none past the 64 besides hidden ones the child reads, no value, the pressed button's
  and each chosen option's included, longer than the 1024 characters the child reads of it) also
  takes `a` (mcp-consequence K5), because an allowance must not rest on a form Vimma did not read
  whole: it allows that submission and every later click of the same connection whose tab's site
  (registrable domain), form method, destination (scheme, host, port and path) and pressed button's
  text are the same, checked again on each click against the payment, secret and known-whole
  rules, until the grant ends (its end, `ctrl+b shift+a`, `:mcp revoke`, a built-in conversation's
  stop, the connection's close; an allowance is held in memory and never kept for a reconnect); `a`
  on a payment's question, or without a grant, allows nothing beyond that step. An allowance covers
  later submissions whatever text or personal details they send, which no question shows. Not
  covered: a page's own script that copies typed text into hidden fields before a harmless-looking
  submission, as a page's own `fetch` is not (mcp-forms F17);
  a form that sends only the page's own values runs unasked under a grant whatever it does on
  the server (deleting, unsubscribing, confirming a step whose text an earlier step sent), and
  only the payment signals of M33 add a question there; a short number typed into a plain text
  field (a quantity, but also a three-digit code) is not free text. So **must** a fill that submits (`vimma_fill` with `submit`, through a submit button's
  label or the form's default submission), under a grant too, naming the same and
  the fields it fills, only through a submit button of the filled fields' own form or that
  form's default submission, and it is not sent when the page put back a value the question
  showed. A fill allows its submission only after its last field is set, so a form the page
  submits while it is being filled is cancelled like any other.
  Before every click and every fill the tab is marked in the parent, after the page's transient user
  activation is consumed in every frame, and from then on, while its top document is the same,
  the request of every navigating form submission in it (any frame, a submit button,
  `requestSubmit()` or a later `submit()`, whatever the page cached) **must** be cancelled
  before it is sent when it carries no transient user activation, unless it is the one
  submission the question allowed, during that call, with the method and destination (scheme,
  host, port and path) it named; a redirect of a submission let through follows on. The call's
  wait for a page counts from when the click or the submission ran in the page's process, not
  from the child's reply before it, so that the allowance is still open when a busy process runs
  the step late; it still ends with the call. A step that starts no load ends its call once the
  step's frame has settled, which its own process tells: no change to its document for 250 ms
  and no request the step opened still open, 1.3 s when the page has not changed at all, at
  most 2 s; a load the step started is waited for until the new page has had its
  `DOMContentLoaded` and 200 ms without a change. A submission the step itself makes starts its
  load in that process before the settle's answer, over the same IPC channel, so the call waits
  for that load with the allowance open. A step that has started no load a second after it ran
  has its allowance withdrawn then, while the wait goes on, so a page that keeps itself busy
  (changing its document, holding a request open) never keeps the allowance open longer than
  the second it had before; the parent bounds each of these answers itself, so a page that
  blocks its own process cannot hold the call either. A submission the page makes later, after
  the call, is outside the allowance and is cancelled while the mark stays, as any other, though
  the result can no longer name it. That wait is bounded: a child that does not answer
  whether the step ran is taken as having run after 1 s, one that keeps answering that it has not
  run yet after 5 s, and the whole wait ends after 20 s. When the child skips a step, because the
  page changed the element or the form as it was pressed, it tells the parent in the same task,
  before any page script runs again, and the parent withdraws the allowance on that message: the
  message and every load or request the page's process starts later go over the same IPC
  channel, in order, so a page that puts the form back and submits by itself, at once or after
  keeping its process busy, is cancelled. The call then refuses the click, and a fill says the
  form was not sent. A submission the page starts while the element is being pressed, before
  the child's check, cannot be told from the click's own: it is let through only to the asked
  method and destination, as the click's would be. A frame of another process in the tab is
  not ordered with that message, and until the call ends it too can send only the asked
  submission. So can a subframe that skips the step and is removed before its message is sent:
  the allowance stays open until the call ends, still only for the method and destination
  asked. The result
  and `:mcp log` name the host it was going to. Clicks and fills on one tab run one at a time, so no call
  takes another's allowance. Your activation after the step (a click or a key of yours in that
  page) and your `f` hints end the mark, so your own submissions in an agent tab go through, and
  so do those of a page no agent stepped in. Not covered: a page the agent's click loaded that
  submits a form by itself (the mark ends with the document it was set on), requests that are
  not http or https, and data a button's script sends with `fetch`, also from a cancelled
  submission's `submit` listener: such a button is an ordinary click (mcp-forms F17).
  [`test_submit_asks_under_a_grant`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_basket_form_runs_under_a_grant`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_message_form_asks_under_a_grant`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_allows_that_button_on_that_site`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_is_not_offered_on_a_pay_step`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`free text, an identity field, a secret or a file makes it consequential`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a allows only a known form that pays nothing and sends no secret or file (K5)`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a is not offered for a form with a value cut to fit: it is not known whole (K5)`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`test_a_long_button_value_or_chosen_option_asks`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`an allowance ends with the grant: its end, revoke, endGrant`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_a_message_cut_or_written_late_still_asks`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`a value cut to fit, digits in other scripts or forms, or a long number is free text`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`test_page_script_submit_after_a_click_is_cancelled`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submission_the_page_makes_after_a_click_is_still_cancelled`](../tests/browser/browser_vimma_mcp_waits.js),
  [`test_an_allowed_submission_the_page_holds_back_is_cancelled_later`](../tests/browser/browser_vimma_mcp_waits.js),
  [`test_a_page_kept_busy_does_not_keep_the_allowance_open`](../tests/browser/browser_vimma_mcp_waits.js),
  [`test_an_allowed_submission_to_a_slow_server_goes_through`](../tests/browser/browser_vimma_mcp_waits.js),
  [`test_users_own_submit_in_an_agent_tab_goes_through`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submit_sent_elsewhere_than_asked_is_stopped`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_submit_listener_moving_the_destination_is_stopped`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_page_submits_after_a_cached_verdict_or_through_a_dialog_are_stopped`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_an_allowed_submit_follows_its_redirect`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_the_users_earlier_input_does_not_cover_an_agents_click`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_page_submitting_with_no_agent_step_is_untouched`](../tests/browser/browser_vimma_mcp_submit.js),
  [`vimma_activate can be granted; a submit asks under any grant and makes none`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a submit: method and host in bold, the field count, y or n only`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a submit button, a submit or image input in a form is a submit`](../packages/vimma-core/test/agent-act.test.mjs),
  [`test_fill_submit_asks_under_a_grant`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_a_skipped_submit_lets_no_later_submission_through`](../tests/browser/browser_vimma_mcp_submit.js),
  [`test_a_skipped_submit_is_not_sent_and_allows_nothing_after_it`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_a_skipped_default_submit_is_not_sent_and_allows_nothing_after_it`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_page_script_submit_after_a_fill_is_cancelled`](../tests/browser/browser_vimma_mcp_fill.js),
  [`the_submit_check_test_hook_is_read_only_in_automation`](../tests/browser/browser_vimma_security_invariants.js),
  [`test_a_page_submit_during_a_fill_is_not_the_asked_one`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_selects_ranges_and_a_submit_button_of_another_form`](../tests/browser/browser_vimma_mcp_fill.js),
  [`a fill that submits: the destination, then the fields, y or n only`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_submit_question_lists_the_fields_it_sends`](../tests/browser/browser_vimma_mcp_submit.js),
  [`a form checkpoint lists the fields it sends, sensitive ones as •••`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a form checkpoint cleans the page's names and values and cuts them to fit`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a malformed fields reply is refused, and a secret never carries a value`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a click grant covers fills; a fill that submits asks under it`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a plain button, a reset, one outside a form or one closing a dialog is not`](../packages/vimma-core/test/agent-act.test.mjs)
- M29. `agent-activate` **must** refuse, before anything is asked, a link to another site than
  the tab's (by registrable domain, mcp-drive D18; the agent follows it with `vimma_keys`, which
  asks as `vimma_open`), a link that is not http, https or `javascript:`, a text field, a select,
  an editable root, a file field (also through its `<label>`), a disabled control and a label
  of `f`'s link list. A click that loads a page takes a slot of the open rate (M3), and no click
  is made while that rate is used up.
  [`test_activate_refuses_fields_files_disabled_and_other_sites`](../tests/browser/browser_vimma_mcp_activate.js),
  [`test_activate_never_follows_a_link_moved_elsewhere_or_an_svg_link`](../tests/browser/browser_vimma_mcp_activate.js),
  [`a gone element, a field, a select, a file field, a disabled control are refused`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a link to another site is refused: vimma_keys follows it (M29)`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a link to something other than a web page is refused`](../packages/vimma-core/test/agent-act.test.mjs),
  [`anything malformed or over its cap is refused`](../packages/vimma-core/test/agent-act.test.mjs)
- M30. `agent-console` (mcp-forms F22, F23) **must not** evaluate code, call a page function,
  start the DevTools server, the Remote Agent or Marionette, or read a property of a page object.
  It reads only what Firefox keeps whether or not anyone asks: each frame's child reads its
  process's `nsIConsoleService` (script errors at error and warning level, by its document's
  inner window id, their text and position only, never their exception or stack) and
  `ConsoleAPIStorage` (the page's `console.error` and `console.warn` calls, whose arguments are
  copied only when they are strings, numbers, booleans, bigints, null or undefined, and are
  otherwise named by their `typeof` alone, so no getter, `toString` or proxy trap of the page
  runs); the parent adds what its own console service logged for those documents. A frame's
  answer is checked entry by entry (core's `parseConsoleEntry`) and cut, as any reply from a
  content process; at most 100 frames are asked, and each answers only its newest 100 entries
  after `since`, cut in the child and counted beyond, so a page that logs without end cannot
  make the parent copy and sort all of it. No user name or password of a script, file or
  request URL reaches the agent. Failed requests (HTTP status 400 and above, or a channel error other than a
  cancel, a redirect or a load turned download) **must** be logged only for channels whose top
  browsing context is a live tab of the agent workspace's container outside private windows,
  only while MCP is on, the last
  100 per tab in memory, with the URL's user name and password removed; a tab's log goes when it
  closes, and every log goes when MCP turns off.
  [`test_console_runs_no_page_code`](../tests/browser/browser_vimma_mcp_console.js),
  [`test_console_returns_failed_requests_with_status`](../tests/browser/browser_vimma_mcp_console.js),
  [`test_request_log_cleared_when_the_tab_closes_or_mcp_turns_off`](../tests/browser/browser_vimma_mcp_console.js),
  [`a console call's arguments: primitives as text, anything else as its type`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a request failed at status 400 and above, or with a channel error but a cancel`](../packages/vimma-core/test/agent-act.test.mjs),
  [`an entry from a content process is checked, and its strings cut`](../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-console: a tab and an optional since, nothing else`](../packages/vimma-core/test/control-v2.test.mjs),
  [`console_calls_become_agent_commands`](../tools/vimma-ctl/src/mcp/command.rs),
  [`test_a_noisy_page_sends_one_replys_worth`](../tests/browser/browser_vimma_mcp_console.js),
  [`a console call's huge arguments are cut before they are joined`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a frame answers only its newest entries after since, at most a list's worth`](../packages/vimma-core/test/agent-act.test.mjs),
  [`no user name or password of a script or request URL reaches the agent`](../packages/vimma-core/test/agent-act.test.mjs)
- M31. `agent-elements`' list **must** be one string inside the untrusted-content delimiters,
  wrapped by the browser with look-alike delimiters broken (M7), and `vimma-ctl mcp` and the
  protocol validator **must** refuse a list that is not, or that holds a second delimiter. At
  most 200 elements, in reading order, and no more than fit 768 KiB of the reply line, as one
  JSON object a line with the forms they name first (at most 64); every page string is
  NFKC-normalised and stripped of bidirectional and invisible characters before it is quoted,
  and of control characters too except a value's tabs and line breaks, which JSON escapes; no
  page `<`, line separator or paragraph separator appears literally in the list (each is
  escaped as `\u003c`, `\u2028`, `\u2029`), so no page string can spell a delimiter; texts and
  captions are cut at 80 characters, values at 256, hrefs and form actions at 2,048, at most 50
  options a select; the rest are dropped and counted, and the reply's URL and title are capped. The child's description
  of each element is a fresh, checked copy (core's `parseAgentElement`). A sensitive field **must
  never** be listed with its value or its selected option: a field that is or was ever a
  password field, one the page draws as dots (`-webkit-text-security`), one whose autocomplete
  field name is `current-password`, `new-password`, `one-time-code` or any `cc-*` name (a
  password type and these names are counted in the parent too, whatever the child says), and
  one form autofill's heuristics infer as a payment card field, with, in a card form, any field
  they leave to their machine-learning model; if the heuristics fail, every field of that form
  counts. A one-time-code field without that autocomplete name or a mask is not recognised. No page text beyond the elements' own is returned, except a target's accessible label and, for a text that repeats in the list, the heading of its card (mcp-forms F5, issue #693), both as its `caption`, under the same checks and cuts. The label includes the text of the elements its `aria-labelledby` names, hidden ones too, as a screen reader reads them; it never reads script, style, noscript or template text or a field's or rich text editor's content, and reads at most 8 ids and 512 characters.
  The list `agent-open`, `agent-activate` and `agent-fill` return when asked with `elements`
  (issue #584) **must** be made by the same code as `agent-elements`' own, so every rule above
  holds for it, and the validator and `vimma-ctl mcp` check it the same way; it is made only
  after the step, of a page that is no longer loading, and only while the tab is still an agent
  tab with the URL it had when the list began (else the result says why, in fixed words, and
  holds no list; a page that is one of Firefox's error pages is named by its error code, which
  the validator and `vimma-ctl mcp` accept only from a fixed list, never as the page's text;
  `vimma_elements` on such a tab refuses with the same code, and the built-in agent's stop after
  three identical refusals counts both); the result's URL and title are read at the last such check, and a tab that
  left the agent workspace meanwhile fails the call, noted in `:mcp log`, with nothing of its
  page; its labels become the connection's current ones as a `vimma_elements` list's do. The
  step's question (a checkpoint's included), its `:mcp log` row and its notice under a grant say
  that the list is taken too.
  A compact list ([agent-speed](specs/agent-speed.md) S3, S4) changes what a list holds, never
  how it is made or wrapped: every rule above holds for the lines it writes, which are the same
  lines a full list writes. How to read a list is said once, in the `vimma_elements` tool
  description; each result keeps its untrusted-content header (the page's URL and title) and its
  intro saying that the text is the page's. A list of a page whose origin the connection has
  listed before leaves out the element lines identical, label, form number and state included,
  to its last list of that origin, and the result names their labels in `repeated`: labels only
  (1 to 3 hint characters, each once), outside the delimiters, which the validator and
  `vimma-ctl mcp` refuse otherwise, so no page string reaches the agent by that route. The
  comparison runs in the parent on the lines made from the checked copies, so it adds no path
  the page controls; a page can only make a line identical to one it already showed, which says
  of its element what that line said. Form lines are always written, so the numbers mean this
  page's forms. A sensitive field's line has no value, so it stays identical whatever the page
  types into it, and no value is ever compared or returned. Labels are counted over the whole
  page, so leaving lines out changes no label; the elements a list gave, written or left out,
  are the ones the connection can click or fill, and a label the newest list did not give is
  refused. What is kept per connection is the last list's lines for at most 16 origins, dropped when the
  connection closes and when a built-in conversation's context is cleared, so a new conversation,
  or one whose model no longer has the earlier lists, gets every list in full. The lines are kept
  once the list is made, before the client has read the reply: a client that drops a reply (a
  cancelled call, a context its client compacted) can be handed labels of lines it never saw, and
  `full: true`, which the tool description names, lists every line again; a label still clicks
  only an element of the page now. `query` (at most 200 characters of one line, matched NFKC and
  case-folded against an element's label, text, caption and name as the list writes them, cut at
  80 characters, never its value) and `kinds` (kinds of the list's own) leave out the elements
  that do not match, and their labels with them; neither reaches the page.
  [`test_repeated_list_leaves_out_unchanged_lines`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_compact_list_keeps_delimiters_and_sensitive_rules`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_query_and_kinds`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_clear_forgets_the_last_element_lists`](../tests/browser/browser_vimma_agent_conversations.js),
  [`query matches only what the list writes: text cut at 80 characters, as shown`](../packages/vimma-core/test/agent-act.test.mjs),
  [`an element list leaves out lines given earlier for the same site and counts them`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field is left out only when its line, without a value, is the same`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field's value is never matched`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a list's repeated labels come with it, each a label, at most once`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a_compact_list_names_the_labels_it_left_out`](../tools/vimma-ctl/src/mcp/render.rs),
  [`element_lists_take_query_kinds_and_full`](../tools/vimma-ctl/src/mcp/args.rs),
  [`test_a_steps_list_says_nothing_of_a_tab_that_left`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_steps_return_the_element_list_vimma_elements_would`](../tests/browser/browser_vimma_mcp_elements.js),
  [`a step's list is inside the untrusted delimiters, with its dropped count`](../packages/vimma-core/test/control-v2.test.mjs),
  [`why a step's list is missing: fixed words, never with a list`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a load error: one of Firefox's codes, only with unlisted error`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a code outside the fixed list is other, never the page's text`](../packages/vimma-core/test/load-errors.test.mjs),
  [`a_load_that_ended_on_an_error_page_is_an_error_naming_it`](../tools/vimma-ctl/src/mcp/render.rs),
  [`a load that ended on Firefox's error page is an error result naming the error`](../packages/vimma-core/test/agent-results.test.mjs),
  [`an open that ends on Firefox's error page three times ends the task`](../packages/vimma-core/test/agent-loop.test.mjs),
  [`test_builtin_open_names_the_error_page`](../tests/browser/browser_vimma_agent_load_error.js),
  [`a_steps_element_list_is_untrusted_content_as_vimma_elements`](../tools/vimma-ctl/src/mcp/render.rs),
  [`an_open_with_elements_lists_the_page_it_loaded`](../tools/vimma-ctl/src/mcp/render.rs),
  [`a step that returns the element list says so in the question and the notice`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_password_and_card_fields_are_sensitive_without_values`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_elements_lists_kinds_fields_and_forms`](../tests/browser/browser_vimma_mcp_elements.js),
  [`passwords, one-time codes and every cc-* name are sensitive; email is not`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field carries no value and no selected option`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a password input is sensitive whatever the child says`](../packages/vimma-core/test/agent-act.test.mjs),
  [`no page < appears literally, and values keep no raw line or paragraph separator`](../packages/vimma-core/test/agent-act.test.mjs),
  [`an autocomplete name that is sensitive makes the field sensitive whatever the child says`](../packages/vimma-core/test/agent-act.test.mjs),
  [`anything malformed, over its cap or naming a form not reported is refused`](../packages/vimma-core/test/agent-act.test.mjs),
  [`a sensitive field says so and never carries a value`](../packages/vimma-core/test/agent-act.test.mjs),
  [`texts and captions cut at 80, values at 256, hrefs at 2,048, at most 50 options`](../packages/vimma-core/test/agent-act.test.mjs),
  [`page strings are NFKC, one line, without bidi, control or invisible characters`](../packages/vimma-core/test/agent-act.test.mjs),
  [`elements past the byte budget are left out and counted; their forms too`](../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-elements: the page, its list inside the untrusted delimiters, how many dropped`](../packages/vimma-core/test/control-v2.test.mjs),
  [`elements_list_as_untrusted_content`](../tools/vimma-ctl/src/mcp/render.rs)

  `agent-screenshot`'s image (F19) **must** be a PNG, or a JPEG when the PNG does not fit, whose
  base64 is at most 700 KiB, at most 1,280 by 16,384 pixels; unless asked `full`, it is at most
  1,024 pixels wide and the smaller of a PNG and a JPEG (issue #584); the protocol validator and
  `vimma-ctl mcp` **must** refuse any other type, size or encoding, and `vimma-ctl mcp` **must**
  pass it on as an MCP image item only after the untrusted header, which says that text in the
  image is web content and not from you. Labels drawn on it (F20) come only from the
  connection's current `vimma_elements` list of that page, and only while its top frame has
  not scrolled since the list was made and for 120 s after it, because they are drawn at the
  places the list recorded and a page that updates in place moves its elements without a
  navigation; else none is drawn and the result says the list is stale. A screenshot **must** be refused (F21) while a sensitive field as above, with a value,
  meets the viewport of any frame of the tab: each frame's child checks, just before and again
  just after the drawing, every form control of its document and its open and closed shadow
  trees, a number field showing text it cannot parse and an autofill preview counting as a
  value, a select counting when its choice differs from the page's default; a field counts even
  if the page covers or hides it otherwise, and a frame that fails counts as showing one. A
  frame that has no Vimma actor (a data: or blob: document) or does not answer in 5 s refuses
  the screenshot too, saying that Vimma could not check every frame. A scroll of the top frame
  between the two checks discards the image. The agent's own steps on that tab and its
  screenshot exclude each other: from the first check to the second, `agent-keys`,
  `agent-activate` and `agent-fill` there are denied as `in-use` (a running `agent-keys` stops
  before its next step), and a screenshot is refused while one of them runs, so the agent cannot
  scroll or change the tab between its checks. A page that is not http or https is refused
  before the question. A value the page copies out of such a field into
  other text, or draws on a canvas, is not recognised, and a value that appears and goes again
  within the moment of the drawing, between the two checks, is not seen by either.
  [`test_screenshot_refused_while_a_sensitive_value_is_on_screen`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_fits_the_reply_line`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_is_smaller_unless_asked_full`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_draws_labels`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`test_screenshot_and_the_agents_own_steps_exclude_each_other`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`the scale: at most 1,280 pixels wide, at most the device pixel ratio`](../packages/vimma-core/test/agent-act.test.mjs),
  [`labels at their element's corner, scaled; those off the image are left out`](../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-screenshot: the image, its size, the page, and the labels drawn`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a_screenshot_is_an_image_after_the_untrusted_header`](../tools/vimma-ctl/src/mcp/render.rs),
  [`screenshot_calls_become_agent_commands`](../tools/vimma-ctl/src/mcp/command.rs)

  `agent-console`'s errors and failed requests (F24) **must** each be one string inside the
  untrusted-content delimiters, wrapped by the browser as above, and the protocol validator and
  `vimma-ctl mcp` **must** refuse either list when it is not. At most 100 errors and 100 failed
  requests, newest first, one JSON object a line, and no more than fit 512 KiB of the reply
  line together, the oldest left out and counted; messages are cut at 1,000 characters and URLs
  and files at 512, page strings are NFKC-normalised and stripped of invisible characters, and
  no page `<`, line separator or paragraph separator appears literally. Messages and URLs are
  the page's own and can carry tokens it put there; they come only from the agent's own tab.
  [`the lists: newest first, only after since, at most 100 each, within the bytes`](../packages/vimma-core/test/agent-act.test.mjs),
  [`no page string can spell a delimiter or a line of its own`](../packages/vimma-core/test/agent-act.test.mjs),
  [`agent-console: the page, its errors and requests inside the delimiters, the time`](../packages/vimma-core/test/control-v2.test.mjs),
  [`console_lists_as_untrusted_content`](../tools/vimma-ctl/src/mcp/render.rs)

- M32. More than 30 `agent-elements` calls, 30 `agent-activate` and `agent-fill` calls
  together, 12 `agent-screenshot` calls, or 30 `agent-console` calls, of one connection a minute (mcp-forms F21, F26), counted when asked and before the
  question, **must** be denied as `busy`, so a grant cannot flood a page and a refused call
  cannot loop; an `agent-open`, `agent-activate` or `agent-fill` asked with `elements` counts
  as an `agent-elements` call as well (issue #584), and with those used up it is denied as
  `busy` before anything of it runs; every call, asked, under a grant or denied, **must** be in `:mcp log` (M23), a
  click with its element, a fill with its fields and values (one refused before its question,
  with its labels), and a submission with its destination, and a call under a grant shows a notice naming the page (and for a click, the
  element; for a fill, how many fields).
  [`at most 30 agent-elements per connection a minute`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_elements_under_a_grant_notice_log_and_rate`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_a_steps_list_counts_as_an_elements_call`](../tests/browser/browser_vimma_mcp_elements.js),
  [`vimma_elements: the tab in the question, the page in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`at most 30 agent-activate per connection a minute`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_activate_under_a_grant_notice_log_and_rate`](../tests/browser/browser_vimma_mcp_activate.js),
  [`vimma_activate: the element in the question, what it clicked in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_fill_submit_asks_under_a_grant`](../tests/browser/browser_vimma_mcp_fill.js),
  [`test_fills_take_labels_only_from_elements_and_share_the_click_rate`](../tests/browser/browser_vimma_mcp_fill.js),
  [`at most 12 agent-screenshot per connection a minute`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`vimma_screenshot can be granted, and its grant covers the other tools`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_screenshot_under_a_grant_notice_log_and_rate`](../tests/browser/browser_vimma_mcp_screenshot.js),
  [`vimma_screenshot: the tab in the question, the page in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`at most 30 agent-console per connection a minute`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`vimma_console can be granted, and its grant covers the other tools`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_console_under_a_grant_notice_log_and_rate`](../tests/browser/browser_vimma_mcp_console.js),
  [`vimma_console: the tab in the question, the page in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M33. A payment step (mcp-checkpoints C6) **must** ask under any grant, with only `y` and `n`
  (`x` is a plain no; `a` is no answer there and an allowance of M28 **never** covers it), and
  its yes **never** makes, lengthens or ends a grant; its no denies that step only. The pay
  phrases only add questions (mcp-consequence K6). A payment step is a `vimma_activate` click, a `vimma_fill` that submits, or a
  `vimma_keys` follow, `gu`, `gU`, `H` or `L`, in an agent tab whose page shows a payment card
  field in any frame (a `cc-*` autocomplete name or form autofill's card heuristics; a frame
  whose check fails or that does not answer within 5 s counts as one, a frame that navigates
  away or whose process ends during the check does not), or whose pressed control has a phrase
  of the fixed list (`PAY_PHRASES`, six languages) as whole words in its text, accessible name,
  title or value; the accessible name includes the text its `aria-labelledby` names, which the
  element list shows the model as the control's `caption` (issue #693), so the check reads every
  name the model is shown. Its question **must** name the button (for a key step, its keys), the host of
  the frame of the control or link the step presses or follows, followed by the tab's host in
  parentheses when that frame is of another site (a payment provider's hosted frame; a key step
  that presses nothing, and a frame with no host of its own, such as about:srcdoc, data: or
  blob:, name the tab's host), and the total the page states, quoted after "the page says" and
  cut at 40 columns; a card field's value is **never** read, and the desktop notification names
  no site, amount or URL. Not covered: a load of another site is not stopped, so a hosted
  payment page reached through a button whose words are not on the list stops the agent only at that page's own card
  fields or pay button; a page that hides its checkout (no card field shown, a button worded
  otherwise) is not recognised; a frame Vimma's actor does not cover (a data: or blob: document)
  is not asked for card fields; and the total is the page's own claim, which the user's bank or
  card statement settles.
  [`test_pay_button_outside_a_form_asks_under_a_grant`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_card_fields_in_a_cross_site_frame_make_a_pay_step`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_pay_button_in_a_cross_site_frame_names_the_frames_site`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_followed_pay_link_in_a_cross_site_frame_names_the_frames_site`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`a pay button in a frame of another site names that site, then the tab's`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_basket_button_does_not_ask`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_no_stops_the_step_and_keeps_the_grant`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_the_stated_total_is_quoted`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_a_key_that_acts_where_it_may_pay_asks`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`test_checkpoint_notice_log_row_and_notification`](../tests/browser/browser_vimma_mcp_checkpoint.js),
  [`card fields alone, and a pay phrase alone, make a payment step; neither makes none`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a phrase inside another word is not one`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`property: a phrase of the list, with any text around it apart by a space, matches`](../packages/vimma-core/test/agent-checkpoint.test.mjs),
  [`a payment checkpoint names the button, site and stated amount`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a checkpoint offers y and n only, and x is a plain no`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a checkpoint asks under a grant, its yes leaves the grant as it was`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`property: no answer to a checkpoint makes, lengthens or ends a grant`](../packages/vimma-core/test/agent-gate.test.mjs)
- M34. The `vimma-ctl` version an `agent-hello` names (`ctl`, spec
  [ship-vimma-ctl](specs/ship-vimma-ctl.md)) is a label, as `client` and `via` are: it **must**
  change only whether Vimma shows the older-client notice, **never** what the connection may do,
  so an older or a lying client gets every check any other gets. A `ctl` that is not a Vimma
  version **must** be refused with the rest of the hello. The discovery file's `version` is
  Vimma's own version, which the `welcome` gives any client anyway.
  [`test_an_older_vimma_ctl_gets_a_notice_and_still_works`](../tests/browser/browser_vimma_mcp_agent.js),
  [`says older for a client that names no version: it predates the check`](../packages/vimma-core/test/ctl-version.test.mjs),
  [`is optional, and refused with the whole hello when it is not a version`](../packages/vimma-core/test/ctl-version.test.mjs)

### The built-in agent (`agent/AgentChat.sys.mjs`, `agent/AgentKeys.sys.mjs`, `agent/AgentStore.sys.mjs`)

Vimma's own agent ([builtin-agent](specs/builtin-agent.md),
[ADR-023](adr/023-in-browser-model-client.md)): a model the user picks, local or hosted, runs
tasks the user types in Vimma, through the same agent commands and gate as an MCP agent. The
window opens with `ctrl+b i` or `:agent`; what is in force:

**Reach:** the agent workspace's tabs that its conversation owns, through `runAgentCommand` in
the browser's process, so every rule above holds for it, with no `:mcp on` and no socket. It
has no shell, files or network of its own: the agent workspace and the model's endpoint are its
only ways to send anything. Page text reaches the model inside the untrusted-content delimiters,
a mitigation and not a guarantee (M7), so a page can steer it; a steered model under its
conversation's grant can do what any grant allows (above), within its own tabs and its budget.

**The conversation grant.** A task the user sends from Vimma's own chat window is known to come
from the user, so sending it with `Enter` grants that conversation's connection, with no
question and no timer, until that task ends, however it ends (B18). Between tasks a
conversation holds no grant, so the status bar's `◇ agent granted` means an agent is working. Nothing but Vimma's chrome calls it: the
control socket has no command that sends a task, and page key events never reach chrome. The
steps that cannot be taken back still ask under it.

**The model's endpoint.** Requests carry the system text, the tool definitions, the user's
messages and the tool results (page text, element lists, console entries, screenshots for a
model with vision) to the endpoint the user configured, and nowhere else. Only the latest results
are sent whole, in blocks of `[agent] keep_results` (unset: 6 for a hosted provider, 20 for one
on this machine), so between one and two blocks' worth; older ones are sent
shortened to their first line and a note (M50), so earlier page text stops reaching the model
with each request. The conversation kept in memory still holds them whole. A hosted provider's
own terms decide what it keeps. A server on 127.0.0.1 may itself forward to a hosted model;
Vimma sees only the address.

**API keys.** A key is a login of the origin `chrome://vimma-agent` whose password is the key,
with the endpoint origin it was entered for, encrypted with OSKeyStore. Such a login is listed in `about:logins`, exported with the other
passwords and synced when the user syncs passwords; those copies hold only the ciphertext. With
a desktop keyring (GNOME Keyring, KWallet through libsecret) OSKeyStore's secret lives outside
the profile, so a copied profile does not reveal the key; without one it lives in `key4.db`,
protected by the primary password like saved passwords, and readable by anyone who reads the
profile when no primary password is set. Other processes running as the user are out of scope
(§11).

**Stored conversations.** Each conversation is one file in `<profile>/vimma/agent/`, named by a
random UUID, holding the user's messages, each task's final reply, the conversation's title, provider
and model, and a summary per task that Vimma writes (outcome, step and token counts, the hosts
the task was asked about), encrypted with the same OSKeyStore secret as the keys. They hold no
page text, tool result, element list, screenshot or step line, and not the text that comes with
the model's tool calls, which most often restates the page. A final reply may still quote what a
page said, an injection included: a reopened or cleared conversation sends it to the model again
as the agent's own earlier words, so a page that steered one task can steer a later one through
its reply. The hosts are a partial history of the agent workspace. They are not in Sync, the
session store or `about:logins`. With a desktop keyring a copied profile does not reveal them;
without one they are as safe as saved passwords. A deleted file is removed, not overwritten. A
reopened or cleared conversation sends its provider the stored text again, and nothing else from
before. Setup writes the provider it set up to `config.toml` by name, kind, endpoint, model and
vision; its key stays in login storage.

- M35. The built-in agent **must** act only through `runAgentCommand`, on one gate connection per
  conversation (`builtin:<n>`, an id no socket connection can have), with the arguments checked
  as a socket request's, so every rule of §12 applies to it; it **must** work with MCP off, and
  `:mcp off` **must not** end its grants.
  [`test_works_with_mcp_off_and_enter_grants_without_a_question`](../tests/browser/browser_vimma_agent_conversations.js),
  [`a built-in connection's grant does not cover another conversation`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`:mcp off ends the MCP grants and leaves a conversation's`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`the built-in connection ids are the only ones that say built-in`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`every agent tool has its command, and nothing else does`](../packages/vimma-core/test/agent-results.test.mjs)
- M36. A conversation **must** see and act only on the agent tabs it owns (opened, given, or
  opened from one it owns) and **must** be refused another tab with the error a tab outside the
  agent workspace gets; an MCP agent **must** see and act only on the agent tabs no conversation
  owns. Ownership is kept in memory by tab, so a tab keeps its owner when it is unloaded and
  when its opener closes; after a restart no tab is owned.
  [`test_two_conversations_see_only_their_tabs`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_an_unloaded_tab_stays_its_conversations`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_tabs_opened_from_an_owned_tab_stay_owned`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_mcp_agent_sees_only_unowned_tabs`](../tests/browser/browser_vimma_agent_conversations.js),
  [`a tab belongs to the conversation that opened it`](../packages/vimma-core/test/agent-owners.test.mjs),
  [`a tab a page opened belongs to its opener's conversation`](../packages/vimma-core/test/agent-owners.test.mjs)
- M37. A conversation's grant **must** be made only by the user sending a task without asking
  every step (`Enter`) or by an answer to its question; it **must** have no timer, **must** end
  when the task it was made for ends (done, stopped, at its budget or on an error), on a send
  that asks every step (`ctrl+Enter`), on stopping the conversation, on
  `ctrl+b shift+a`, on `:mcp revoke` and when the conversation is deleted, and **must never**
  cover another conversation. Form submissions that M28 makes ask, payment steps, `vimma_show`
  and the downloads that always ask **must** ask under it (M19, M28, M33).
  [`test_ctrl_enter_asks_every_step_and_ends_the_grant`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_grant_ends_with_its_task_and_enter_grants_again`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_checkpoint_and_show_ask_under_the_conversation_grant`](../tests/browser/browser_vimma_agent_conversations.js),
  [`a conversation grant has no expiry and ends on stop`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`a conversation grant leaves checkpoints asking`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`:mcp revoke ends a conversation grant as any other`](../packages/vimma-core/test/agent-gate.test.mjs)
- M38. An `agent-hello` whose client name starts with `built-in` (in any case, with any
  separator or none, after invisible characters or in compatibility forms) **must** be shown
  with ` (mcp)` after it, so no other program passes as the built-in agent in a question, a
  notice or `:mcp log`. Look-alike letters of other scripts are not caught; the name is a label
  and grants nothing.
  [`a client named built-in over MCP is shown with (mcp)`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_mcp_agent_sees_only_unowned_tabs`](../tests/browser/browser_vimma_agent_conversations.js)
- M39. Model requests **must** go only to the configured endpoint, `https://` unless on a
  loopback address, with `credentials: "omit"` and `redirect: "error"`; `[agent] local_only`
  **must** refuse every endpoint off this machine, in config.toml and at each request. Setup's
  probe **must** ask only 127.0.0.1 on the local servers' ports and the configured providers'
  own loopback endpoints, with a timeout of 1 s, and only while the model picker is open. The
  check before a task that a local model is still listed **must** ask only the conversation's
  own loopback endpoint, and never an endpoint off this machine. Setup's look at where a picked
  local model runs **must** ask only Ollama's port on this machine, once, after the pick, with a
  generate request that names the model and carries no prompt, then `/api/ps`.
  [`test_requests_only_to_the_endpoint_without_credentials_or_redirects`](../tests/browser/browser_vimma_agent_conversations.js),
  [`posts to the endpoint without credentials or redirects, and parses the reply`](../packages/vimma-core/test/agent-providers.test.mjs),
  [`a refused endpoint makes no request`](../packages/vimma-core/test/agent-providers.test.mjs),
  [`local_only refuses a remote endpoint`](../packages/vimma-core/test/config-agent.test.mjs),
  [`an endpoint off this machine must be https, and carry no user name`](../packages/vimma-core/test/config-agent.test.mjs),
  [`lists the models of the servers that answer, with no cookies and no redirects`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`the probe also asks the configured local endpoints, once each, never a remote one`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`a provider off this machine, or Anthropic's API, gets no request`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`its server lists it, or no longer does`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`loads the model with no prompt, then reads its GPU share and context from ps`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`asks only Ollama on this machine`](../packages/vimma-core/test/agent-setup.test.mjs),
  [`test_probe_only_on_setup_and_only_loopback`](../tests/browser/browser_vimma_agent_conversations.js)
- M40. An API key **must** be stored only as a `chrome://vimma-agent` login holding the key and
  the endpoint origin it was entered for, encrypted with OSKeyStore, and **must** be sent only to
  that origin (a provider whose endpoint config.toml changes gets no key), and **must never** be
  in a pref, config.toml (a key field there is a
  config error that does not repeat the value), a file of Vimma's, `:mcp log`, a notice, the
  conversation or an error text (a provider's error is cut at 200 characters with the key
  replaced by `•••`); it goes only into the provider's request header.
  [`test_key_stored_as_a_login_only`](../tests/browser/browser_vimma_agent_keys.js),
  [`test_stored_login_holds_only_the_keystore_ciphertext`](../tests/browser/browser_vimma_agent_keys.js),
  [`test_key_never_in_log_notice_or_error`](../tests/browser/browser_vimma_agent_keys.js),
  [`test_key_deleted`](../tests/browser/browser_vimma_agent_keys.js),
  [`test_a_key_goes_only_to_the_endpoint_it_was_stored_for`](../tests/browser/browser_vimma_agent_keys.js),
  [`a key field in [agent] is an error, with its line`](../packages/vimma-core/test/config-agent.test.mjs),
  [`the key's value never appears in the error`](../packages/vimma-core/test/config-agent.test.mjs),
  [`a provider error is cut and never contains the key`](../packages/vimma-core/test/agent-providers.test.mjs)
- M41. At most `[agent] max_running` conversations (default 3) **must** run a task at once. A
  task **must** stop at its budget (`max_steps`, `max_tokens`, `max_cost`), which nothing the
  model writes raises, and after the same call has its arguments refused or is denied three
  times in a row; `ctrl+b shift+a`
  with no question waiting **must** stop every running task.
  [`test_max_running`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_ctrl_b_shift_a_stops_every_task`](../tests/browser/browser_vimma_agent_conversations.js),
  [`a task stops at max_steps`](../packages/vimma-core/test/agent-budget.test.mjs),
  [`a task ends after the same call is refused three times in a row`](../packages/vimma-core/test/agent-loop.test.mjs),
  [`max_running and keep_days parse within their bounds`](../packages/vimma-core/test/config-agent.test.mjs)

**The chat window** (`ui/agent-chat.mjs`, `host/agent-chat-ops.mjs`, `host/agent-ui.mjs`):
Vimma's own chrome, a box in the side panel's slot, never a page. It shows the user's messages,
the model's replies, a line per step and the gate's questions of its open conversation, so it
holds text a page may have written (a reply quoting it, a tab's title or a button's words in a
step) with chrome privileges. The rules keep that text inert and keep the model from answering
for the user.

- M42. The chat window **must** set every value as text: no Markdown, HTML, image or link the
  model or a page wrote becomes markup, a request or a link; C0, C1 and bidi control characters
  are removed from the user's and the model's text, and the model's lines sit indented under the
  `agent` label, never at the window's edge where Vimma's own lines start. A step's line is built
  from the loop's and the gate's events, never from a tool's result, so no page text a result
  carries reaches the window, and a tool name the model made up is shown on one line, cut.
  [`test_reply_rendered_as_text`](../tests/browser/browser_vimma_agent_chat.js),
  [`bidi overrides and control characters go; line breaks and tabs stay`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`a reply line starting with a question glyph is indented under the agent label`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`a step the gate says nothing of shows the loop's own name for it`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`a tool name the model made up stays on one line, cut short`](../packages/vimma-core/test/agent-chat.test.mjs)
- M43. A question of the open conversation **must** show only in the window's prompt slot, an
  element outside the transcript that only `host/agent-ui.mjs` fills from `AgentGate`, and in
  one place at a time (the question line when the window is closed or open on another
  conversation). The slot **must** take keys only while focus is in the window and only once
  armed (`security.dialog_enable_delay`, M4), arming again whenever focus comes into the window
  from outside it; while it shows, the input **must** be read-only and
  `Enter` **must not** send; nothing typed in the input and nothing the model writes **must**
  answer a question, make a grant or fill the slot.
  [`test_question_in_the_prompt_slot_and_never_answered_by_the_input`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_question_on_the_question_line_when_closed`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_slot_arms_again_when_focus_comes_back_into_the_window`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_shift_enter_adds_a_line_and_ctrl_enter_asks`](../tests/browser/browser_vimma_agent_chat.js)
- M44. Giving a tab to a conversation (`P`, `:agent give`) **must** move a tab of another
  workspace to the agent workspace only after a `y`, reopened there with the agent workspace's
  container and without its history, and only if that tab is still selected and the agent
  workspace unchanged at the answer; a tab another conversation owns **must not** be given.
  Opening the window from a workspace **must not** let the agent read that workspace's tabs
  where they are: only a tab moved to the agent workspace reaches it.
  [`test_give_moves_the_tab_after_y_and_makes_it_the_conversations`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_opened_from_another_workspace_reads_none_of_its_tabs`](../tests/browser/browser_vimma_agent_chat.js)
- M45. Before a conversation's first task to an endpoint off this machine (and again after its
  provider changes), the window **must** say where page text, field values, screenshots and the
  user's messages go and send nothing without a `y` to that endpoint; `AgentChat.send` itself
  **must** refuse a task the notice was not answered for.
  [`test_external_provider_notice_before_first_task`](../tests/browser/browser_vimma_agent_chat.js),
  [`the notice before the first task names the host and, when known, who runs it`](../packages/vimma-core/test/agent-chat.test.mjs)
- M46. A hosted provider's key **must** be typed only into the window's password field, which
  hands it to `AgentKeys` (M40) and is emptied at once; the key **must not** be drawn in the
  window, the transcript, the status bar or a notice (which may show its last four characters),
  nor kept in a pref or the conversation, and an error storing it **must not** be shown with its
  text, nor recorded in Vimma's key log or its debug output. The field **must not** reveal the
  key: it has no reveal button, cancels every reveal a user can ask for (`MozWillToggleReveal`), opens no context
  menu, and gives up nothing to copy, cut or drag; it never holds a stored key, so changing a
  key means entering it again. Any way out of the field (Esc, closing the window, another
  view) empties it. A provider that needs a key and has none for
  its endpoint **must** be asked for it, and `AgentChat.send` **must** refuse it, before any
  request is sent; an endpoint **must not** carry a query or a fragment; `x` in the picker
  deletes a key after a `y`.
  [`test_hosted_openai_compatible_provider_set_up_in_the_window`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_hosted_anthropic_provider_asks_for_its_key_before_the_task`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_a_key_typed_and_left_is_dropped_and_no_task_goes_keyless`](../tests/browser/browser_vimma_agent_chat.js),
  [`test_an_entered_key_is_never_shown_again_nor_copied_out`](../tests/browser/browser_vimma_agent_chat.js),
  [`an endpoint with a query or a fragment is refused`](../packages/vimma-core/test/agent-providers.test.mjs)
- M47. A stored conversation **must** hold only the user's messages, each task's final reply and
  Vimma's own task summaries (with its title, provider, model and times), never a tool result,
  page text, an element list, a screenshot, a step line or an API key, and **must** be written
  only encrypted with OSKeyStore, as a 0600 file in a 0700 folder: a record that cannot be
  encrypted stays in memory and nothing is written; the folder is set to 0700 at every save, and a
  record over 400,000 bytes keeps its newest entries, so OSKeyStore can decrypt it. A record
  read back **must** be checked
  (version, a UUID id, known entry kinds, a provider of a known kind with an http or https
  endpoint) and fields it does not know dropped. A reopened conversation, and one whose context
  is cleared, **must** send the model only those entries, with no grant until a task is sent.
  [`test_stored_file_is_encrypted_and_holds_no_tool_output`](../tests/browser/browser_vimma_agent_store.js),
  [`test_nothing_written_in_clear_when_it_cannot_be_encrypted`](../tests/browser/browser_vimma_agent_store.js),
  [`test_reopened_conversation_starts_with_a_clean_context`](../tests/browser/browser_vimma_agent_store.js),
  [`test_clear_context`](../tests/browser/browser_vimma_agent_store.js),
  [`test_only_the_final_reply_is_stored_and_temp_files_go`](../tests/browser/browser_vimma_agent_store.js),
  [`a long conversation keeps its newest entries within MAX_RECORD_BYTES`](../packages/vimma-core/test/agent-store.test.mjs),
  [`a single entry over MAX_RECORD_BYTES is cut`](../packages/vimma-core/test/agent-store.test.mjs),
  [`a stored conversation holds messages, replies and summaries, never tool output`](../packages/vimma-core/test/agent-store.test.mjs),
  [`the provider keeps its prices and never a key`](../packages/vimma-core/test/agent-store.test.mjs),
  [`refuses another version, a bad provider or an unknown entry`](../packages/vimma-core/test/agent-store.test.mjs),
  [`a task summary names outcome, counts and hosts, and no page text`](../packages/vimma-core/test/agent-store.test.mjs),
  [`http and https hosts only, once each, in order`](../packages/vimma-core/test/agent-store.test.mjs)
- M48. `d` in the conversation list (after a `y`) **must** remove that conversation's file;
  `:agent forget all` (after a `y` naming the count) **must** stop running tasks and remove every
  file of the store, those it cannot read and a save's temporary files included; `[agent] keep_days` **must** remove the files
  not written for that many days, at start, when it changes and once a day, from the files' times
  alone, so it never needs the keyring. A deleted conversation's task that ends afterwards
  **must not** write its file again. The store **must not** be read or decrypted before the
  window first opens, so a user who never opens it is never asked to unlock the keyring.
  [`test_a_new_window_reads_no_stored_conversation`](../tests/browser/browser_vimma_agent_store.js),
  [`test_delete_and_forget_all_remove_files`](../tests/browser/browser_vimma_agent_store.js),
  [`test_a_deleted_conversations_task_writes_nothing_after`](../tests/browser/browser_vimma_agent_store.js),
  [`test_keep_days`](../tests/browser/browser_vimma_agent_store.js),
  [`only with keep_days, and only when unused for longer`](../packages/vimma-core/test/agent-store.test.mjs)
- M49. Setup **must** write to `config.toml` only the provider's name, kind, endpoint, model,
  vision and prices, never its key, and only when the file parses before and after the edit, with
  every other key unchanged.
  [`test_setup_writes_the_provider_and_default_to_config`](../tests/browser/browser_vimma_agent_store.js),
  [`test_setup_creates_a_missing_config_with_the_provider`](../tests/browser/browser_vimma_agent_store.js),
  [`never writes a key, and refuses a file that does not parse`](../packages/vimma-core/test/agent-config.test.mjs),
  [`keeps every other line of the file`](../packages/vimma-core/test/agent-config.test.mjs)
- M50. Shortening older results (`[agent] keep_results`) **must** only take text out of a
  request, never add page text or move it out of the untrusted-content delimiters: a shortened
  result keeps only its first text item's first line and Vimma's note that the rest was left
  out, and a result that starts with Vimma's `Untrusted web content from …` line keeps that line
  whole, so a page title that breaks the line never loses the warning after it. A result no
  longer than its shortened form is sent whole. The user's messages, the model's replies and
  every error result (`isError`: refused arguments, failures and the user's no, a checkpoint's
  among them) **must** be sent whole, and a shortened result **must** keep its call's id, so each
  step stays paired with what it did. The gate's rules do not depend on what the model still
  sees: a refusal stays enforced after its result is shortened.
  [`the loop leaves out results older than keep_results in blocks, keeping their first line`](../packages/vimma-core/test/agent-loop.test.mjs),
  [`a page's line keeps its warning even when the page's title breaks the line`](../packages/vimma-core/test/agent-loop.test.mjs),
  [`the user's messages, the replies and refusals, the user's no among them, stay whole`](../packages/vimma-core/test/agent-loop.test.mjs),
  [`a request's prefix changes only when a block is left out`](../packages/vimma-core/test/agent-loop.test.mjs)

**Agent CLIs** ([builtin-agent-cli](specs/builtin-agent-cli.md), on by default;
`vimma.agent.cli.enabled = false` turns them off): a conversation can run an agent CLI the user has, Claude Code
or Codex, whose `vimma-ctl mcp` acts on the browser as that conversation. The way in is a
one-time ticket that binds one `vimma-ctl mcp` connection to the conversation's gate
connection. It reaches only what the conversation already reaches, so a process of the user's
that reads it from the CLI's environment gains nothing the conversation does not have, and
only until the run ends. Codex has no MCP configuration file Vimma can give it, so its ticket
is in the Codex process's own environment, which its server table passes on by name; its own
shell commands get both variables set empty, but the programs its own configuration runs
outside its shell (`notify`, `hooks`) and a process of the user's that reads
`/proc/<pid>/environ` of the Codex process still reach the ticket, with the reach above.

**Reach of the CLI itself:** everything the user can do. The CLI keeps the shell, file and web
tools its own settings allow, and Vimma does not approve, refuse, count or confine them: they
act with the user's rights, under the CLI's permission model only. A page that steers the CLI's
model can make it use them, for example to read a file the user can read and send it to the
CLI's provider, or to run a command. What bounds that is the CLI's own settings; what Vimma adds
is that the first task's notice says those tools are not confined, the header lists the ones
the CLI reported for the run, and each use is a marked line in the transcript. Page text goes to
the CLI and from it to whatever model the CLI uses; Vimma cannot see where, so `local_only`
refuses every CLI. A shell command the CLI started may outlive a stop: Firefox signals the CLI's
own process, not a process group.

- M51. A ticket **must** be 256 random bits, made only by chrome code for one conversation's
  connection, good until it is revoked (when its conversation is stopped or deleted, and when
  the run it was made for ends), for one connection at a time: the first
  connection's
  `vimma-ctl mcp` session id is the only way back in after that connection drops. A second
  connection while one lives, a later one without that session id, and one after a first that
  sent none **must** be refused, with the notice
  `a second program used <cli>'s ticket and was refused`. A revoked or unknown ticket's hello
  **must** be refused before any proof is sent. A request id still in flight on the connection
  **must not** be taken again, so every waiting question stays reachable by `agent-cancel` and
  by the connection's end.
  [`test_second_connection_with_a_ticket_is_refused`](../tests/browser/browser_vimma_agent_cli.js),
  [`test_a_request_id_in_flight_is_not_reused`](../tests/browser/browser_vimma_agent_cli.js),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../tests/browser/browser_vimma_agent_cli.js),
  [`test_cli_that_ignores_sigterm_is_killed_and_takes_no_step`](../tests/browser/browser_vimma_agent_cli_run.js)
  A message sent during a task of a CLI with no live input (Codex) **must** be held, never
  written to that run, and **must** start a run only after a task that ended done; after a
  stop, a budget or a failure it is dropped with a notice, so a stop is never followed by a
  run the user did not send again.
  [`test_a_message_during_the_task_is_held_for_the_next_run`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_held_message_is_not_sent_after_a_stop`](../tests/browser/browser_vimma_agent_cli_codex.js)
- M52. A ticket's connection **must** act as its conversation's connection (M35-M37): asked
  about under the conversation's label, covered by its grant and by no other, on the tabs it
  owns. Its `agent-hello` **must not** register an MCP agent or change the label, and its
  closing **must** withdraw only the questions it was waiting on, leaving the conversation, its
  grant and its tabs.
  [`test_ticket_connection_acts_as_the_conversation`](../tests/browser/browser_vimma_agent_cli.js)
- M53. Vimma **must never** write a ticket to a pref, `config.toml`, the discovery file or any
  file of the profile, a log, a notice or `:mcp log`; the one file that holds it is the run's
  0600 MCP configuration (M56). What the CLI itself logs of that configuration is its matter:
  a ticket is good for one run, and revoked when the run ends. `vimma-ctl mcp` **must** take it only
  from `VIMMA_AGENT_TICKET` (with the port from `VIMMA_AGENT_PORT`), never print it, and with a
  ticket **must not** read the discovery file, so that process never holds the token. When its
  ticket's task has ended it **must** tell the model so, and **never** to turn MCP on.
  [`test_ticket_never_in_prefs_files_notices_or_log`](../tests/browser/browser_vimma_agent_cli.js),
  [`mcp_connects_with_a_ticket_from_the_environment`](../tools/vimma-ctl/tests/mcp.rs),
  [`the_ticket_is_never_printed`](../tools/vimma-ctl/tests/mcp.rs),
  [`a_ticket_whose_task_ended_never_says_to_turn_on_mcp`](../tools/vimma-ctl/tests/mcp.rs)
- M54. Stopping or deleting a conversation **must** revoke its tickets and close their
  connections at once, before its grant ends, so no command a CLI sends after the stop reaches
  the browser; a question the connection waited on is withdrawn, and a step already past its
  question finishes, as any stopped task's does (Behaviour 16 of builtin-agent).
  [`test_stop_and_delete_close_the_ticket_connection`](../tests/browser/browser_vimma_agent_cli.js)
- M55. An agent CLI **must** be started only when the user sends a task in the chat window, and
  only as the program at the path picked in setup (a pref, never `config.toml`), kept as `PATH`
  held it, links included, and run by that path, so a version manager's shim sees the CLI's
  name, checked before each run: an absolute path, resolved one entry at a time as the kernel
  does, to a regular executable file owned by the user or root that no other user can write;
  every link on the way owned by the user or root; and every folder the resolution looks an entry
  up in (above the file, above each link and each hop of a chain) the user's or root's and not
  writable by other users unless sticky, so that only the user or root can repoint a link or
  replace the file. A stored path that names a version manager's dispatcher itself, other than
  through a link named as the CLI, **must** be refused, since started as itself it runs the
  wrong program. Its arguments **must** come from the
  CLI's fixed builder, with the provider's model the only value in them (a model that starts
  with `-`, holds any control character (a tab or a line break included) or is longer than 200
  characters is refused, by one rule where setup's prompt line takes
  it, where `config.toml` gives it and when the command line is built), the task and the conversation before it **must** go to its standard
  input and never into an argument, and there is no shell. Its environment is Vimma's without
  the `MOZ_`, `VIMMA_`, `XRE_` and `XUL_` variables. It **must** run in a new 0700 folder of
  the user's (in `$XDG_RUNTIME_DIR`, else `~/.cache/vimma-agent-cli`), outside the profile,
  with no folder above it that another user owns or can write, sticky ones included, since the
  CLI reads instruction files from every folder above its working folder; the folder is removed
  with the run. Nothing **must** start before a task is sent but setup's `--version`, of a
  program that passes these checks, and nothing at all while `vimma.agent.cli.enabled` is off,
  when the model picker does not look at a CLI's file either. The picker's list of a CLI's models
  is Vimma's own and starts nothing; a model picked or typed there **must** pass the same rule
  before it is used. The checks cover the file the
  path names: when that file is a script, its `#!` interpreter (such as `node` through
  `/usr/bin/env`) is found on the user's `PATH` as it is in a terminal, so a `PATH` entry
  other users can write lets them choose it, there as here; and a version manager's shim (mise,
  asdf, volta) runs the real tool from the manager's own install folder and configuration, which
  Vimma does not check (a group-writable `MISE_DATA_DIR`, for example). A run **must** end, and
  revoke its ticket, when the CLI's work is done even if a child of it keeps its output open.
  A CLI that records its runs **must** be asked not to (`--no-session-persistence`,
  `--ephemeral`); Gemini CLI, which cannot be asked, **must** have what it recorded of a run
  removed when the run ends, a stop included: the project folders in its `tmp/` and `history/`
  whose `.project_root` marker names the run's folder (its session files, the whole
  conversation with the page text, among them) and the registry entry in `projects.json`,
  edited under Gemini CLI's own lock, which is waited for and never broken. At each start Vimma
  **must** remove the same of every run of its own whose folder is gone, and of every run folder
  a crash left, with the folder: one whose marked process is gone (Linux), that its own
  process id marks while unused, or older than a day and an hour; a registry that is a link
  is not edited. A project is Vimma's only when its path is a run folder's name directly in a
  folder runs are made in, so no project of the user's is ever touched. Gemini CLI's `TMPDIR` is the run's
  folder, since its error reports hold the conversation. Between a run's start and its end,
  and after a crash until the next start, the conversation is on disk in Gemini CLI's folder
  (`docs/limits.md`).
  [`test_setup_lists_only_found_clis_and_stores_the_path`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_path_checks_refuse_a_file_others_can_write`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_shim_runs_as_the_cli_it_is_named_after`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`a link on the way to it is judged by its owner`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a program that runs a tool by the name it is started as is a dispatcher`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_no_process_before_a_task`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_task_on_stdin_and_fixed_arguments`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_runs_in_an_empty_private_directory_removed_after`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_turned_off_starts_nothing`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_the_picker_lists_the_clis_models_and_uses_one`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_run_folder_others_can_write_above_is_refused`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_child_holding_the_output_does_not_keep_the_run`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`claude-code's arguments are the fixture, with the model only from the provider`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`the task is never an argument`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's arguments are the fixture`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`vimma-ctl's path is a TOML string whatever it holds`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`the task is never an argument, and goes to stdin, which then closes`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_task_on_stdin_which_closes_and_fixed_arguments`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_setup_finds_codex_with_its_version`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`a model that looks like an option is refused, not passed`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a typed model is checked with the rule the arguments use`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a cli provider's model is refused by the rule its run uses`](../packages/vimma-core/test/config-agent.test.mjs),
  [`test_setup_asks_the_clis_model_and_saves_it`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`the environment is Vimma's, minus the variables Vimma and Firefox set`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`anything else is refused, with the reason`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`gemini's arguments are the fixture`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_setup_finds_gemini_with_its_version`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_task_on_stdin_fixed_arguments_and_the_folders_settings`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_gemini_keeps_nothing_of_the_run_after_it`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_stopped_run_keeps_nothing_either`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_rejected_key_is_the_runs_error_and_its_report_goes`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_leftovers_of_runs_a_crash_ended_go_at_the_next_start`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_run_folder_a_crash_left_goes_with_its_records`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_linked_registry_is_left_a_link`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_lock_gemini_holds_is_waited_for_not_broken`](../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`only a run folder of vimma's is one of its runs`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`the registry keeps every other project, and names the runs' folders`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a slug that is not a plain folder name is never a folder to remove`](../packages/vimma-core/test/agent-cli.test.mjs)
- M56. The ticket **must** reach the CLI's `vimma-ctl mcp` only through the MCP configuration's
  `env`, in a file that is 0600 in that 0700 folder (for Gemini CLI, `.gemini/settings.json`
  there, in a 0700 `.gemini` folder, which it reads from its working directory once
  `GEMINI_CLI_TRUST_WORKSPACE=true` in its environment trusts that folder) and removed with it,
  or, for a CLI whose
  servers are arguments (Codex), through the CLI's own environment, passed to the server by
  name (`env_vars`) and set empty for the CLI's own shell commands
  (`shell_environment_policy.set`, which keeps the user's policy); **never** through a
  command line. The CLI **must** be given no MCP server but Vimma's, so that it reaches pages
  only through the gate: `--strict-mcp-config`; for Gemini CLI `--allowed-mcp-server-names`
  naming its server alone (`vimma_chat`, whose entry in the run folder's settings replaces a
  user's entry of that name whole), its extensions off (`-e none`), and a tool of any other MCP
  server that ran ending the run; or for Codex each server its own list names
  turned off by name, its apps, plugins and a skill's MCP server installs off with
  `--disable` (which fails on a feature name the version does not know), its server named apart from any the user may
  have (`vimma_chat`, whose name in the list refuses the run, as does a name that is not
  letters, digits, `_` or `-`, or a list Vimma does not read), and a call it reports to any
  other server ending the run. That `vimma-ctl` **must** be the one in the
  folder of Vimma's running binary (Linux reads it from `/proc/self/exe`), else the one the pref
  `vimma.agent.cli.vimmaCtl` names, never one found on `PATH`. The pref's file is checked as
  the CLI is (M55). The one beside the binary has its own file checked in full, but not the
  folders above it: they hold Vimma's binary, so a user who can swap one can already change
  Vimma itself, and on macOS `/Applications` is writable by the admin group. That exception
  covers only a file in the binary's own folder, and only the folders on the way to the binary
  and the links in them: a link there to a file elsewhere has every folder judged in full, and a
  chain of links that passes through another folder has that folder and its links judged even
  when it ends beside the binary, since the kernel follows the chain again at each run.
  [`test_ticket_never_in_cmdline_prefs_or_log`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_vimma_ctl_beside_the_binary_is_judged_as_the_binary_is`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_link_beside_the_binary_is_judged_where_it_leads`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`a link through a hop in another folder has that folder and link judged`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_only_vimmas_mcp_server_is_given`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`the mcp configuration names only vimma-ctl, with the ticket in its environment`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`the ticket reaches vimma-ctl through codex's environment, never its arguments`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's own commands get the ticket's variables empty, the user's policy kept`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`every other mcp server of codex's configuration is off for the run`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's features that add mcp servers are off, and fail the run once renamed`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a server name that is not a plain word, or is vimma's own, refuses the run`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's own mcp servers are read from its list`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a call to any other mcp server ends the run`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_ticket_by_name_in_codexs_environment_never_an_argument`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_every_other_server_of_codexs_configuration_is_off`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_server_named_as_vimmas_refuses_the_run`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_call_to_a_server_not_vimmas_ends_the_run`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`vimma's server is in the run folder's settings file, the ticket in its env`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`gemini trusts the run folder from its environment, and keeps its reports there`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a tool of another mcp server that ran ends the run; one never offered does not`](../packages/vimma-core/test/agent-cli.test.mjs)
- M57. A CLI's steps in the browser **must** be the conversation's: asked and granted as its
  own (the `Enter` grant covers them, checkpoints and `vimma_show` still ask), and shown from the
  gate's record, never from the CLI's account of them. A CLI's output **must** be rendered as
  text and **must never** answer a question, make a grant or fill the prompt slot. A step the
  CLI takes with a tool of its own **must** be a marked line of its own (`◆`), never a step in
  the browser.
  [`test_enter_grant_covers_cli_steps_and_checkpoints_ask`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_own_tool_lines_are_marked`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`mcp__vimma tool calls in the stream are not transcript steps`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`text is passed as written, and the window renders it as text`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`each gate event of the conversation is a step, asked or run under the grant`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`an own-tool line is marked, muted, and says when the cli's settings refused it`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`mcp tool calls of vimma's server are not transcript steps`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_codexs_own_commands_and_files_are_its_own_lines`](../tests/browser/browser_vimma_agent_cli_codex.js),
  [`a recorded gemini stream maps to replies, own-tool lines and usage`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a step its policy refuses is marked refused`](../packages/vimma-core/test/agent-cli.test.mjs)
- M58. A CLI's own shell, file and web tools are **outside** Vimma's gate (above). Before a
  conversation's first task with a CLI (and after a provider change), the window **must** say
  where page text goes and that those tools are not confined, and send nothing without a `y`;
  `AgentChat.send` **must** refuse a task the notice was not answered for. The header **must**
  list the tools the CLI reported as enabled for its run: every tool but Vimma's own, those of
  any other MCP server included, and each use of those is a `◆` line; for a CLI that reports
  no tool list (Codex), it **must** say `as its configuration allows`, never a list.
  [`test_first_task_notice_says_the_clis_own_tools_are_not_confined`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_header_lists_the_clis_own_tools_from_its_init`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`an agent CLI: its name, the model it reported, and that it decides where data goes`](../packages/vimma-core/test/agent-chat.test.mjs),
  [`test_another_mcp_servers_tools_are_listed_as_its_own`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`tools of another mcp server are the cli's own, listed and marked, not hidden`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a run with no reported tool list says its configuration decides`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_header_and_start_line_name_codexs_configuration`](../tests/browser/browser_vimma_agent_cli_codex.js)
- M59. A CLI task's steps **must** be counted where they reach the gate, and the next one
  refused at `max_steps`, so a CLI cannot under-report them; `max_minutes` (default 30)
  **must** stop it; tokens the CLI reports (cached input included, as for a hosted provider)
  count toward `max_tokens` at each model call, so
  that limit **must** stop a turn still running, not only end it. `max_cost` is not
  enforced for a CLI, whose reported cost is shown as its own estimate (`≈`), and the first task
  says so. A stream line over 1 MiB, or more than 64 MiB of output, **must** end the run.
  [`test_max_steps_counted_by_the_gate`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_max_minutes_stops_the_task`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_max_tokens_stops_a_turn_before_it_ends`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`each model call's usage counts as it comes, once, and the result adds only the rest`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`cached input counts as input, as a hosted provider's does`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_max_cost_set_is_reported_as_not_applying`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`a cli task stops at max_minutes`](../packages/vimma-core/test/agent-budget.test.mjs),
  [`reported cost is shown and max_cost does not stop a cli task`](../packages/vimma-core/test/agent-budget.test.mjs),
  [`a line over 1 MiB ends the run`](../packages/vimma-core/test/agent-cli.test.mjs),
  [`a run over 64 MiB of output is stopped`](../packages/vimma-core/test/agent-cli.test.mjs)
- M60. `local_only` **must** refuse every CLI provider, in `config.toml`, in the picker and at
  each task; a `command`, `path`, `args` or `env` key in a CLI provider **must** be a config
  error, and so is an `endpoint`.
  [`test_local_only_refuses_a_cli`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`local_only refuses a cli provider`](../packages/vimma-core/test/config-agent.test.mjs),
  [`command, path, args and env in a cli provider are errors with their line`](../packages/vimma-core/test/config-agent.test.mjs),
  [`an agent cli is written by name, kind, cli and model, never its path`](../packages/vimma-core/test/agent-config.test.mjs)
- M61. A stop (`s`, `:agent stop`, `ctrl+b shift+a`), a task's budget and its end **must**
  revoke the ticket, closing its connection, before the CLI is signalled; then `SIGTERM`, and
  `SIGKILL` after 3 s.
  [`test_stop_closes_the_connection_before_the_signal`](../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_cli_that_ignores_sigterm_is_killed_and_takes_no_step`](../tests/browser/browser_vimma_agent_cli_run.js)

## 13. Page modes (`actors/VimmaParent.sys.mjs`, `host/VimmaHost.sys.mjs`, `host/edit-keys.mjs`)

Whether a key is Vimma's or the page's depends on the tab's mode, which the content actor's focus
reports move. Specs: [m1-actor-insert-scroll](specs/m1-actor-insert-scroll.md),
[insert-focus](specs/insert-focus.md).

**Reach:** pages, through focus changes in their own frames.

- K1. Only the frame that has focus **may** report focus for a tab, and a report that is not a
  well-formed descriptor **must** be dropped; a report changes only its own tab's mode.
  [`only_the_focused_frame_may_report`](../tests/browser/browser_vimma_insert_scroll.js),
  [`malformed_descriptors_are_dropped`](../tests/browser/browser_vimma_insert_scroll.js)
- K2. After `i` or `gi`, a page **must not** turn the user's keys into Vimma commands by moving
  focus: only `Esc` or another top document ends that insert (a page restored from the
  back-forward cache is the same document).
  [`after_i_the_page_moving_focus_off_the_field_keeps_insert`](../tests/browser/browser_vimma_insert_focus.js),
  [`after_i_the_page_blurring_the_field_keeps_insert`](../tests/browser/browser_vimma_insert_focus.js),
  [`after_gi_the_page_moving_focus_off_the_field_keeps_insert`](../tests/browser/browser_vimma_insert_focus.js),
  [`explicit_insert_ends_with_the_page`](../tests/browser/browser_vimma_insert_focus.js)
- K3. `i` **must** focus only a field of its own tab: the field the user last used, asked of the
  frame and document that reported it (still in the tab, not discarded, same inner window), which
  focuses only a connected, visible, editable element of that document; otherwise the top frame's
  first field.
  [`i_focuses_the_field_last_used_in_a_cross_origin_frame`](../tests/browser/browser_vimma_insert_focus.js),
  [`i_falls_back_to_the_first_field_when_the_last_frame_navigated`](../tests/browser/browser_vimma_insert_focus.js),
  [`i_falls_back_to_the_first_field_when_the_last_is_gone`](../tests/browser/browser_vimma_insert_focus.js)
- K4. After `Esc`, a page **must not** put the tab back in insert by focusing a field other than
  while it handles the user's input, and a focus report sent before the `Esc` **must not** undo
  it; only the user's next action (a click, a key the page gets, `i`, `gi`, a hint) or another
  top document ends this. A key the user pressed after `Esc`, that a page in a content process
  handled before the blur arrived, keeps the focus it gave (insert-focus behaviour 8), and its
  focus is reported under the same rule. This holds for an uncompromised content process: a report's `user` and
  `gen` fields and `Vimma:Click` come from the content process, so a compromised one can do what
  K1 allows, no more.
  [`after_esc_a_page_refocusing_its_field_stays_in_normal`](../tests/browser/browser_vimma_insert_focus.js),
  [`after_esc_on_a_trapping_page_i_click_and_tab_enter_insert`](../tests/browser/browser_vimma_insert_focus.js),
  [`esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal`](../tests/browser/browser_vimma_insert_focus.js),
  [`tab_right_after_esc_on_a_busy_page_keeps_its_focus`](../tests/browser/browser_vimma_insert_focus.js),
  [`tab_right_before_esc_on_a_busy_page_is_blurred`](../tests/browser/browser_vimma_insert_focus.js),
  [`a_key_right_after_esc_on_a_busy_page_still_blurs`](../tests/browser/browser_vimma_insert_focus.js)
- K5. Vim's text-field keys ([key-handling-batch](specs/key-handling-batch.md) § 2) **must**
  act only on a key the user pressed, in insert mode or in a focused chrome field, and in a page
  only after the page left the key alone. `ctrl+j` and `ctrl+m` press a trusted `Enter` from the
  parent (`actors/enter-key.mjs`, a `TextInputProcessor`), which Firefox routes to the focused
  element as a keyboard's `Enter`: it carries no modifier, it is pressed only while the same
  chrome field, or the same `<browser>` and frame, still has focus, a page's reply acts only on
  the `<browser>` it came from (a late reply never edits the tab or pane focused since), and no
  message from a content process can ask for it. The content actor's `Vimma:Edit` **must** run only the three editor commands
  (`INSERT_EDIT_COMMANDS`), never Enter. A compromised content process that claims insert mode
  (K1) gets an `Enter` in place of its own `ctrl+j`, which it could synthesize itself.
  [`Enter is no editor command: the content actor never takes it`](../packages/vimma-core/test/editable.test.mjs),
  [`a_page_that_takes_ctrl_j_keeps_it`](../tests/browser/browser_vimma_edit_keys.js),
  [`a_late_reply_presses_no_enter_in_another_tab`](../tests/browser/browser_vimma_edit_keys.js),
  [`ctrl_j_m_submit_a_single_line_inputs_form_with_a_trusted_enter`](../tests/browser/browser_vimma_edit_keys.js)

- K6. `ctrl+n` and `ctrl+p` in a page's suggestion list
  ([page-suggestions](specs/page-suggestions.md)) **must** press `ArrowDown` or `ArrowUp` only
  for a key the user pressed in insert mode, only after the page left it alone, only in the
  `<browser>` the key went to, and only in the frame focused when the page's reply arrives and
  still focused, in the same mode, at the press: a page's late reply neither presses a key in,
  nor runs the chord's other binding for, the tab or pane focused since, and `Esc` meanwhile
  stops both. The key comes from the parent's `TextInputProcessor` (`actors/enter-key.mjs`, as
  for K5's `Enter`), carries no modifier, and is the page's: Vimma's own key handling skips it,
  so it neither completes a Vimma sequence nor runs a binding on an arrow key. The focused frame's actor answers `Vimma:SuggestionsOpen` with one
  boolean computed from its page's own attributes; the parent treats anything but `true` as
  "no list", and no message from a content process can ask for a key. A page, or a compromised
  content process, can at most turn the user's own `ctrl+n` into an arrow key in itself, which it
  could do by handling `ctrl+n`.
  [`suggestionListOpen`](../packages/vimma-core/test/suggestions.test.mjs),
  [`ctrl_n_and_ctrl_p_move_an_aria_combobox`](../tests/browser/browser_vimma_page_suggestions.js),
  [`a_pressed_arrow_key_runs_no_vimma_binding`](../tests/browser/browser_vimma_page_suggestions.js),
  [`a_page_that_takes_ctrl_n_keeps_it`](../tests/browser/browser_vimma_page_suggestions.js),
  [`a_late_reply_presses_no_arrow_key_in_another_tab`](../tests/browser/browser_vimma_page_suggestions.js),
  [`a_hidden_list_left_aria_expanded_is_not_open`](../tests/browser/browser_vimma_page_suggestions.js)
- K7. The content actor **must** attach only to http, https, file, `about:` and `view-source:`
  documents and Vimma's start page (`VimmaActors.register`); `moz-extension:`, `data:`, `blob:` and
  `chrome:` documents get none and stay in insert, though their `view-source:` forms match. A
  `view-source:` document is Firefox's own rendering of a source as inert markup: no page script
  runs in it, web content cannot navigate to `view-source:` (`URI_DANGEROUS_TO_LOAD`), and it is
  never framed. It loads in the process its inner URI's origin selects: a web page's source in
  that site's process, the source of a parent-process `about:` or `chrome:` page in the parent,
  where the actor already runs for `about:` pages and the start page. Its replies go through the
  same parent checks (K1, `parseHintReply`, `parseGrepReply`). Agents gain no reach from it: the
  agent tools open only http and https (M6), and the document's principal keeps the
  `view-source:` scheme, so every agent check for an http or https page refuses on it.
  [`j_k_G_and_gg_scroll_the_source`](../tests/browser/browser_vimma_view_source.js),
  [`f_labels_the_link_in_the_source_and_follows_it`](../tests/browser/browser_vimma_view_source.js),
  [`the_actor_reaches_settings_and_the_pdf_viewer_but_not_data_urls`](../tests/browser/browser_vimma_insert_scroll.js)
- K8. The scroll keys' target **must** be chosen within the frame's own document, its shadow
  trees included, and a page **must not** be able to make that choice slow: the search of a
  fixed layer over the page (a cookie banner's settings) reads at most 10,000 elements, and a
  layer with nothing to scroll is not searched again for a second. A layer with nothing to scroll
  leaves the keys to the page.
  [`j_scrolls_the_cookie_settings_list_not_the_page_behind`](../tests/browser/browser_vimma_insert_scroll.js),
  [`j_scrolls_the_page_past_a_fixed_element_that_is_no_scrolling_layer`](../tests/browser/browser_vimma_insert_scroll.js)

## 14. Build and release supply chain (`release.yml`, `aur.yml`, `homebrew.yml`, `nightly.yml`, `macos.yml`, `flatpak.yml`, `site-dispatch.yml`)

Vimma's binaries are built from Mozilla's Firefox source, this repository, and the npm packages
that drive the build, chiefly Surfer. These rules keep what reaches a build pinned and reviewed.
Spec: [build-supply-chain](specs/build-supply-chain.md), [ADR-001](adr/001-engine-firefox-surfer.md).

**Reach:** Mozilla's archive and Taskcluster, the npm registry, this repository, and GitHub's
hosted runners; for the Flatpak build only (B12), Docker Hub's Fedora image, Fedora's package
mirrors and Flathub (`dl.flathub.org`). Dependabot pull requests run and auto-merge today, whether or not a build runs.

The macOS build, `macos.yml` ([ADR-018](adr/018-macos-cross-build.md)), also runs on pull
requests that touch it. It holds no secret and only a read-only token, builds on hosted runners
under B1, B2 and B5 like the release build, and adds one download, rcodesign, pinned by SHA-256.
Its ad hoc signature proves nothing about who built the app. Its `smoke` job builds `vimma-ctl`
with the toolchain of `rust-toolchain.toml` and the crates of `Cargo.lock` (`--locked`), as
`ci.yml` does, to drive the app through the e2e smoke scenarios; that binary is never packaged.
`release.yml`'s macOS jobs, which run only while the variable `MACOS_RELEASE_ENABLED` is `true`,
hold every rule below that the Linux jobs hold: the same tag checks, the `build` environment for
the key, cosign under the same identity, and the same refusal to replace a published release's
files (B6, B9, B10). Apple's Developer ID signing and notarisation add the `macos-sign`
environment and its secrets (B14). No Linux job needs them, so a macOS failure holds back no Linux release.
[`no Linux job needs a macOS job`](../tools/package/test/release-workflow.test.mjs),
[`macos-build checks the tag like build, then cross-builds with the key`](../tools/package/test/release-workflow.test.mjs),
[`the build jobs check out clean and restore nothing from the Actions cache`](../tools/test/full-build-workflows.test.mjs),
[`reads no secret, deploys to no environment and only reads the repository`](../tools/package/test/macos.test.mjs),
[`pins one rcodesign release and its SHA-256, checked before the file is used`](../tools/package/test/macos.test.mjs)

- B1. Nothing is **ever** built from, or reported on, a Firefox source tarball unless its SHA-512
  is listed in a `SHA512SUMS` carrying exactly one good signature by a valid signing subkey of
  Mozilla's release key `14F26682D0916CDD81E37B6D61B7B526D98F0353`, pinned in
  `tools/upstream/mozilla-release-key.asc` ([ADR-021](adr/021-mozilla-release-key.md)); a
  revoked or expired subkey, another key, a second signature, a signed message in place of a
  detached signature, or a missing signature fails. The verdict comes from `gpgv`'s status lines,
  never its exit status, which is 0 for the revoked, compromised subkey. Every verification goes
  through `tools/upstream/verify-sha512.py`, called by `firefox-source.sh` (every build, PR CI
  included) and `source-check.sh` (the autopilot and the Beta canary); a tarball already on disk
  is verified like a downloaded one. On a contributor's machine, `npx surfer download` checks
  nothing, so `npm run import`, the first step of every local build and lane, refuses an
  `engine/` until `npm run verify-source` has verified the tarball it came from for
  `surfer.json`'s version (a record in `engine/.git`, which `firefox-source.sh` writes too). That
  record guards against building an unverified download, not against someone who can already
  write to `engine/`.
  `firefox-source.sh` also refuses a `surfer.json` with a `version.candidate`, which Surfer would
  fetch from `candidates/` unverified.
  A pull request that changes the pinned key file, or a line of `verify-sha512.py` that names
  `PINNED_FINGERPRINT` or `KEY_FILE`, fails the required check "Mozilla release key unchanged or
  approved" (`.github/workflows/key-guard.yml`, `tools/ci/key-guard.mjs`) until a maintainer adds
  the `key-rotation-approved` label, which needs triage access to the repository. No automation
  or agent adds that label; a maintainer adds it only after the checks in `docs/runbook.md`,
  "Mozilla's release key", and removes it if a later push changes the key again, since the label
  stays on the pull request across pushes. The check runs the base branch's copy of the script,
  and is skipped only on a merged pull request: release-please relabels a merged release pull
  request after its branch is deleted. A skipped job reports success, which is safe only once
  merged, because the head is already in `main`. A label change on a closed, unmerged pull
  request still runs the check, so its head commit cannot gain a passing check that a later pull
  request with the same head would inherit.
  A pull request that changes the guard itself (`.github/workflows/key-guard.yml`,
  `tools/ci/key-guard.mjs` or its tests) needs the same label, because under `pull_request` such
  a pull request still runs its own copy of the workflow and could rewrite it to pass; the
  label requirement on the guard's files is what makes that change visible, and the `main`
  ruleset, which requires the check by its name, is what makes it binding. The one exception is
  the pull request that first adds the guard to a base branch without one. Its scope is the
  key, the fingerprint and the guard: it does not see a change that weakens `verify-sha512.py`
  elsewhere (its call sites or its status checks); review of `tools/upstream/` covers that.
  [`test_good_signature_from_mozillas_current_subkey_passes`](../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_the_revoked_compromised_subkey_fails`](../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_another_key_fails`](../tools/upstream/test_verify_sha512.py),
  [`test_a_second_signature_beside_mozillas_fails`](../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_an_expired_subkey_fails`](../tools/upstream/test_verify_sha512.py),
  [`test_one_changed_byte_in_sha512sums_fails_the_signature`](../tools/upstream/test_verify_sha512.py),
  [`test_missing_signature_or_gpgv_cannot_check_and_exits_two`](../tools/upstream/test_verify_sha512.py),
  [`test_pinned_key_is_mozillas_primary_with_the_compromised_subkey_revoked`](../tools/upstream/test_verify_sha512.py),
  [`a SHA512SUMS without a good signature fails before engine/ is touched`](../tools/upstream/test/firefox-source.test.mjs),
  [`the source check fails on a SHA512SUMS whose signature is not good`](../tools/upstream/test/source-check.test.mjs),
  [`test_a_signed_message_in_place_of_a_detached_signature_fails`](../tools/upstream/test_verify_sha512.py),
  [`fails a tampered tarball`](../tools/upstream/test/verify-source.test.mjs),
  [`--require refuses an engine/ never verified, or verified for another version`](../tools/upstream/test/verify-source.test.mjs),
  [`npm run import refuses an engine/ whose source was never verified`](../tools/test/upstream-workflow.test.mjs),
  [`every verify-sha512.py call passes a signature`](../tools/test/upstream-workflow.test.mjs),
  [`refuses a surfer.json with a version.candidate, before anything is fetched`](../tools/upstream/test/firefox-source.test.mjs),
  [`fails a changed key file without the label`](../tools/ci/test/key-guard.test.mjs),
  [`fails a change to any of the guard's own files without the label, and passes it with`](../tools/ci/test/key-guard.test.mjs),
  [`passes the pull request that first adds the guard to a base without one`](../tools/ci/test/key-guard.test.mjs),
  [`fails a changed fingerprint without the label, and passes it with`](../tools/ci/test/key-guard.test.mjs),
  [`passes event values to run: through env only`](../tools/ci/test/key-guard.test.mjs),
  [`skips the whole job once the pull request is merged, and still runs on a closed unmerged one`](../tools/ci/test/key-guard.test.mjs),
  [`still judges when started through a symlinked path`](../tools/ci/test/key-guard.test.mjs)
- B2. A nightly or release build **never** builds from an `engine/` it did not extract in the
  same job from the tarball it verified, and **never** restores a tree, an objdir or a compiler
  cache from the Actions cache; a release **must** build in a fresh objdir with an empty
  compiler cache.
  [`a tarball already on disk is verified again and engine/ is extracted from it afresh`](../tools/upstream/test/firefox-source.test.mjs),
  [`no workflow reads or writes engine/.vimma-firefox-version`](../tools/test/full-build-workflows.test.mjs),
  [`the build jobs check out clean and restore nothing from the Actions cache`](../tools/test/full-build-workflows.test.mjs),
  [`a release builds in a fresh objdir with an empty compiler cache`](../tools/test/full-build-workflows.test.mjs)
- B3. Surfer **must** be pinned to one exact version, locked by its integrity hash, and a
  Dependabot change to any package on the release path (Surfer, `ajv` and every package they
  depend on, computed from `package-lock.json` by `tools/deps/release-path.mjs`) **never** merges
  without a person, security updates and grouped updates included. The `classify` job decides
  from the lockfile diff, running the base commit's code on the head commit's lockfile read as
  data, with a read-only token and no secrets, and shows the published diff (`npm diff`) in its
  summary and the `release-path-diff` artifact. A failed classification, an update whose
  dependency names are missing, and a Surfer name in Dependabot's metadata wait for a person too.
  [`package.json pins Surfer to an exact version, locked by integrity`](../tools/test/build-supply-chain.test.mjs),
  [`a Surfer update is never auto-merged, security updates included`](../tools/test/build-supply-chain.test.mjs),
  [`Surfer is held whatever the separator, quoting or case, or when only the title names it`](../tools/test/build-supply-chain.test.mjs),
  [`an update whose dependency list is empty waits for a person`](../tools/test/build-supply-chain.test.mjs),
  [`the release-path group comes before the minor and patch group`](../tools/test/build-supply-chain.test.mjs),
  [`dependabot-automerge classifies on base-branch code with a read-only token`](../tools/test/build-supply-chain.test.mjs),
  [`a release-path change is never auto-merged, security updates included`](../tools/test/build-supply-chain.test.mjs),
  [`the release path is Surfer, ajv and everything they depend on`](../tools/deps/test/release-path.test.mjs),
  [`the roots cover every package the release build job imports`](../tools/deps/test/release-path.test.mjs),
  [`a changed release-path package needs review, security updates included`](../tools/deps/test/release-path.test.mjs),
  [`a change only outside the release path may auto-merge`](../tools/deps/test/release-path.test.mjs),
  [`a transitive release-path package bumped in a grouped update needs review`](../tools/deps/test/release-path.test.mjs),
  [`only registry names and exact versions are handed to npm diff`](../tools/deps/test/release-path.test.mjs)
- B4. An npm install **never** runs install scripts, and the build **must** run Surfer only from
  `node_modules`, never a package `npx` fetches, and **never** lets Surfer fetch an add-on.
  [`.npmrc turns install scripts off for every install`](../tools/test/build-supply-chain.test.mjs),
  [`the full builds install with npm ci --ignore-scripts and run Surfer with npx --no`](../tools/test/build-supply-chain.test.mjs),
  [`no workflow lets npx fetch a package`](../tools/test/build-supply-chain.test.mjs),
  [`surfer.json lists no add-ons`](../tools/test/build-supply-chain.test.mjs)
- B5. A workflow **never** targets a self-hosted runner: every job runs on a standard
  GitHub-hosted image or calls a workflow file of this repository, and a `runs-on` expression
  that cannot be resolved to a hosted image fails. The test parses each workflow as YAML and
  fails on any shape it does not recognise. A job of a workflow that a pull request, a comment,
  an issue or another workflow run can trigger is held to this as the permanent guard; the build
  jobs run only from `main` (the nightly also on its schedule), and only once `NIGHTLY_ENABLED`
  or `RELEASE_ENABLED` is set. **⚠ setting:** fork pull request approval is
  `all_external_contributors`
  (`gh api repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`), so a
  fork's own workflow files run only once a person approves the run; and the organization has
  no self-hosted runner (`gh api orgs/vimma-browser/actions/runners`, organization owners only),
  since an organization runner shared with this repository is invisible to every
  repository-level check.
  [`no workflow an outsider can trigger runs a job on a self-hosted runner`](../tools/test/self-hosted-runner.test.mjs),
  [`a runs-on expression in such a workflow fails unless it resolves to a hosted image`](../tools/test/self-hosted-runner.test.mjs),
  [`a quoted job id is a job of its own`](../tools/test/self-hosted-runner.test.mjs),
  [`a job written as a flow mapping is checked`](../tools/test/self-hosted-runner.test.mjs),
  [`a matrix key is read only from the job's own strategy.matrix`](../tools/test/self-hosted-runner.test.mjs),
  [`triggers are read in every spelling YAML allows`](../tools/test/self-hosted-runner.test.mjs),
  [`no workflow names a self-hosted runner, and both build jobs run on ubuntu-24.04`](../tools/test/self-hosted-runner.test.mjs),
  [`each build job runs only from main`](../tools/test/self-hosted-runner.test.mjs)
- B6. The Safe Browsing key **must** be available only to jobs in the `build` environment,
  deployable only from `main`, and only the build jobs of `nightly.yml` and `release.yml`
  (`build` and, for the macOS `.dmg`, `macos-build`) use it. The environment's deployment rule is enforced by GitHub, outside any
  workflow file, so a branch's or tag's edited workflow cannot read the key by dropping an
  `if:`. No tag may deploy: a tag ruleset restricts moving a tag, not creating one. The key
  still ships inside every keyed binary (spec m0-safebrowsing-key): this limits who can use it
  from CI, not who can read it. **⚠ setting:** the `build` environment, with `main` as its only
  deployment rule, holds `SAFEBROWSING_API_KEY`, and no repository secret of that name exists
  (`gh api repos/vimma-browser/vimma/actions/secrets`; docs/runbook.md, "Google Safe Browsing
  key"). While a repository secret of that name remains, any job of any branch can read it.
  [`the Safe Browsing key comes only from the build environment, in the release and nightly builds`](../tools/test/build-supply-chain.test.mjs)
- B7. A change to Mozilla's release key **must** open a `security` issue within 4 hours of
  appearing in Mozilla's `KEY` file, and 60 days before the pinned signing subkey expires.
  `upstream.yml`'s `detect` job (every 4 hours) downloads
  `nightly/latest-mozilla-central/KEY` and `tools/upstream/mozilla-key-check.py` compares it
  with the pinned key in a throwaway `GNUPGHOME`; it never edits the keyring. A new subkey or
  revocation, a different primary key (never adopted: ADR-021 is reviewed) or the expiry warning
  becomes one open issue per title, written by the `key` job, which runs only `gh` with
  `issues: write`. **⚠ limit:** a failed download or parse warns and does not fail the run, so
  release detection, which drives security bumps, never waits on it.
  [`test_a_new_subkey_or_revocation_in_mozillas_key_is_reported`](../tools/upstream/test_mozilla_key_check.py),
  [`test_a_different_primary_key_is_reported_and_never_adopted`](../tools/upstream/test_mozilla_key_check.py),
  [`test_a_signing_subkey_expiring_within_60_days_is_reported`](../tools/upstream/test_mozilla_key_check.py),
  [`test_an_unchanged_key_reports_nothing`](../tools/upstream/test_mozilla_key_check.py),
  [`detect compares Mozilla's KEY with the pinned key; a change opens a security issue`](../tools/test/upstream-workflow.test.mjs)
- B8. Unless the repository variables `NIGHTLY_RELEASE_ENABLED` and `UPDATES_ENABLED` are both
  `true`, the nightly **never** creates, replaces or deletes a release, and no job of it can
  write contents. Its `build` job, which runs npm, Surfer, `mach` and the
  mochitests, holds `contents: read` only, whatever the variables, and keeps its package as a
  workflow artifact for 7 days. The failure issue comes from a `report` job with
  `issues: write` and `actions: read`, which checks out and runs no repository code, reads no
  secret, and quotes only the log the build job redacted before uploading it, with backticks
  escaped so no log line can end its code fence, and the names of the run's failed jobs and
  steps (run metadata, never another job's log). With both variables `true` (spec
  [m6a-updater](specs/m6a-updater.md), decisions 42 and 43), a nightly is also public:
  `mar-sign` signs its MAR on the channel `vimma-nightly` (UP14); `mar`, with no secret and a
  read-only token, checks the signed MAR as `release.yml`'s `mar` does and writes a
  `SHA256SUMS` that lists exactly the tarball and the MAR, named by build ID; `sign`, holding
  only `id-token: write` and running no repository code, signs that `SHA256SUMS` with cosign as
  `nightly.yml@refs/heads/main`, an identity that `release.yml`'s `IDENTITY_REGEXP` and the
  release manifest's check never accept; and `publish`, the **only** job with
  `contents: write`, checks out and runs no repository code. It uploads only files that
  `SHA256SUMS` lists (and the sums and their signature) to the rolling `nightly` release, which
  it creates as a pre-release that is never Latest, with its `nightly` tag at that commit, and
  never deletes; no job moves a tag. It refuses to touch the release when it is a draft or a full
  release, and when it already holds a newer build (a re-run of an older night). It removes only
  the files of builds older than this one, keeping the previous build's and those of the build
  the published nightly manifest offers, and removes none when the update host does not answer.
  A scheduled run builds only when `main` changed (decision 44): the `changes` job, with
  `contents: read`, no secret and no environment, runs `gh release view` and
  `tools/update/nightly-change.mjs` to compare `main`'s commit and Firefox version with the
  record that `publish` writes first in the release notes. On a match no job in the `build`
  environment starts, so the Safe Browsing key is not read that day, and `manifest` re-signs the
  recorded build (UP7); anything the record cannot vouch for builds, and a manual run always
  builds, as does a failed change check. The record only chooses between building and re-signing:
  whoever can edit the release's notes and files (write access) can delay a build or cause one,
  and can choose which build is re-signed only among genuine `nightly.yml@refs/heads/main`
  builds, since `nightly-prepare` still requires the release's `SHA256SUMS` under that cosign
  identity, the MAR on the channel `vimma-nightly`, and a build no older than the published
  offer.
  `SHA256SUMS` covers the newest build alone; a kept older build is still pinned by the manifest's
  SHA-512. Release and tag events made with
  `GITHUB_TOKEN` start no workflow, so `aur.yml`, `homebrew.yml`, `site-dispatch.yml` and
  `update-publish.yml`'s `start` never run for it. **⚠ limit:** the artifact is not private. The
  repository is public, so anyone signed in to GitHub can download it for the 7 days it is
  kept, and its name and size are listed without signing in. It holds the same package, and the
  same compiled-in Safe Browsing key, as a keyed release build. **⚠ limit:** a public nightly
  is `main` as it was that night, reviewed through pull requests and checked by CI and the full
  mochitest suite, not soaked as a release is; whether that may go public is the release gate,
  decided by setting the variable. **⚠ setting:** `NIGHTLY_RELEASE_ENABLED` is unset until
  public nightly releases start (`gh variable list`; docs/runbook.md, "Full builds").
  [`the workflow and its build job can only read the repository`](../tools/test/nightly-workflow.test.mjs),
  [`the build job keeps the package as a workflow artifact for 7 days`](../tools/test/nightly-workflow.test.mjs),
  [`every job after the build runs only with NIGHTLY_RELEASE_ENABLED and UPDATES_ENABLED`](../tools/test/nightly-workflow.test.mjs),
  [`only publish can write contents, and it runs no repository code`](../tools/test/nightly-workflow.test.mjs),
  [`the nightly release is a pre-release, never Latest or deleted, and no v* tag is touched`](../tools/test/nightly-workflow.test.mjs),
  [`publish uploads only files SHA256SUMS lists, after checking them`](../tools/test/nightly-workflow.test.mjs),
  [`cosign signs SHA256SUMS as nightly.yml on main, running no repository code`](../tools/test/nightly-workflow.test.mjs),
  [`refuses a nightly release whose state is %s, and uploads nothing`](../tools/test/nightly-workflow.test.mjs),
  [`refuses a re-run of an older night once a newer build is on the release`](../tools/test/nightly-workflow.test.mjs),
  [`keeps this build, the previous one and the one the live manifest offers`](../tools/test/nightly-workflow.test.mjs),
  [`removes nothing when the update host does not answer, nor any newer build`](../tools/test/nightly-workflow.test.mjs),
  [`a failure of any job is reported by its own job, from the redacted log artifact`](../tools/test/nightly-workflow.test.mjs),
  [`the report job names the repository, since it checks nothing out`](../tools/test/nightly-workflow.test.mjs),
  [`names the failed job and step in the issue`](../tools/test/nightly-workflow.test.mjs),
  [`reads the run's jobs with a read-only actions token, beside its issues one`](../tools/test/nightly-workflow.test.mjs),
  [`a scheduled run on an unchanged commit builds nothing and re-signs the recorded build`](../tools/test/nightly-workflow.test.mjs),
  [`a scheduled run on a changed commit builds, publishes and offers the new build`](../tools/test/nightly-workflow.test.mjs),
  [`a manual run builds, whatever the change check says`](../tools/test/nightly-workflow.test.mjs),
  [`the change check reads with contents: read alone, no secret and no environment`](../tools/test/nightly-workflow.test.mjs),
  [`a skipped day starts no job in the build environment and none that reads the Safe Browsing key`](../tools/test/nightly-workflow.test.mjs),
  [`builds when %s`](../tools/update/test/nightly-change.test.mjs),
  [`only the nightly's failure-issue step, its publish job and its change check get GH_TOKEN`](../tools/test/full-build-workflows.test.mjs)
- B9. Every file `release.yml` uploads to a release, the Arch Linux `PKGBUILD` and `SRCINFO`
  included, **must** be listed in that release's `SHA256SUMS` and get a cosign bundle from the
  `sign` job, so a user can verify any asset, and the `PKGBUILD`, which pacman runs as root, is
  checked the same way as the binaries. The `PKGBUILD` pins the SHA-256 of the tarball it
  installs, and its generator accepts only `owner/name` for the repository and
  `[A-Za-z0-9._-]` for the desktop file ID, the two values it places in shell words. It is built
  and installed with `makepkg -si` on Arch Linux before anything is signed. The `.rpm` for
  Fedora and openSUSE carries no OpenPGP signature of its own (no key exists to sign it with):
  `SHA256SUMS` and its cosign bundle cover it as they cover the `.deb`, which is why the
  documented zypper command passes `--allow-unsigned-rpm` and dnf skips its OpenPGP check for a
  local file by default. Its spec is generated, and its generator accepts only an absolute path
  of `[A-Za-z0-9._/-]` for the staged root and the output directory, `[A-Za-z0-9._+-]` for the
  bundled library names and a maintainer line without `%`, the values it places in a shell
  command or in text rpm expands as macros. It is built by `rpmbuild`
  from Ubuntu's archive on the hosted runner and installed with dnf and zypper in Fedora and
  openSUSE containers pinned by digest, before anything is signed. **⚠ setting:**
  signatures exist only while the repository variable `SIGNING_ENABLED` is `true`; without it
  `publish` uploads the assets and `SHA256SUMS` unsigned. The macOS `.dmg` and its Homebrew cask
  `vimma.rb` are listed in their own `SHA256SUMS-macos`, so `SHA256SUMS`, which `aur.yml` and the
  update manifest read, never changes when they are added; `macos-sign` signs all three with the
  same identity, after a hosted Mac has checked the checksum, the signature, the version line,
  Vimma's icon catalog, the bundle identifier and the mounted volume's window art and icon
  against the committed files, has driven the app headless through the e2e smoke scenarios with
  its own `vimma-ctl` (a job with a read-only token and no secret, before anything is signed),
  and has installed the `.dmg` through the cask.
  The macOS icon files in `configs/branding/vimma/` are binaries in the tree;
  `macos.yml` regenerates them from their sources and fails if they differ. `firefox.icns`,
  `document.icns`, `disk.icns`, `background.png` and the layer image inside `Assets.car` are
  compared byte for byte. The dmg's `dsstore` is a binary nothing regenerates: Finder writes it
  (`tools/package/macos-dsstore.sh`), review reads it as a binary, and a test parses it and
  checks the layout, the background alias and that it names no home directory. The
  flattened fallback images inside `Assets.car`, which macOS 15 and earlier draw, differ on
  every `actool` run, so the check compares only their names, pixel sizes and sizes on disk; a
  change to their pixels that keeps the size is left to review, which reads `Assets.car` as a
  binary to be regenerated, never edited.
  [`writes SHA256SUMS that sha256sum -c accepts, for every release file`](../tools/package/test/package.test.mjs),
  [`signs and uploads the PKGBUILD and SRCINFO with the other assets`](../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke runs the dmg on a hosted Mac and ties its version line to the tag`](../tools/package/test/release-workflow.test.mjs),
  [`macos-sign signs the dmg and its checksums, and runs no repository code`](../tools/package/test/release-workflow.test.mjs),
  [`macos-publish adds only the macOS files, and replaces them only when told`](../tools/package/test/release-workflow.test.mjs),
  [`regenerates the icon files on a Mac with a pinned Xcode and fails on drift`](../tools/package/test/macos.test.mjs),
  [`fails an app that still carries Firefox's unofficial icon`](../tools/package/test/macos.test.mjs),
  [`macos-smoke checks the mounted dmg's window art and volume icon`](../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke runs the e2e smoke scenarios through the app's vimma-ctl`](../tools/package/test/release-workflow.test.mjs),
  [`fails a volume with other art, such as Firefox's`](../tools/package/test/macos.test.mjs),
  [`names no home directory or Firefox volume`](../tools/package/test/macos.test.mjs),
  [`builds and installs the release PKGBUILD on Arch Linux before anything is signed`](../tools/package/test/release-workflow.test.mjs),
  [`signs and uploads the .rpm with the other vimma* assets`](../tools/package/test/rpm-smoke.test.mjs),
  [`smoke-tests the .rpm on Fedora and openSUSE before the files are uploaded for signing`](../tools/package/test/rpm-smoke.test.mjs),
  [`pins a Fedora and an openSUSE image by digest`](../tools/package/test/rpm-smoke.test.mjs),
  [`refuses the stage path %j, which the shell or the macro expander would change`](../tools/package/test/package.test.mjs),
  [`refuses a bundled library name it could not quote`](../tools/package/test/package.test.mjs),
  [`refuses a maintainer with a %, which rpm would expand as a macro`](../tools/package/test/package.test.mjs),
  [`an output dir rpm's macro expander would change, before rpmbuild runs`](../tools/package/test/package.test.mjs),
  [`needs nothing but itself: the tarball is its only source`](../tools/package/test/package.test.mjs),
  [`refuses repo %j`](../tools/package/test/package.test.mjs),
  [`refuses desktop id %j`](../tools/package/test/package.test.mjs)

- B10. A release **must** be signed only by `release.yml` run from `main` through
  `workflow_dispatch`: `release-please.yml`'s `release-build` job dispatches it with
  `GITHUB_TOKEN` (`actions: write` only, no repository code) for the tag release-please just
  created, and a manual re-run is the same dispatch. Every signature names one identity,
  `release.yml@refs/heads/main` (`IDENTITY_REGEXP`), which a workflow on another branch cannot
  obtain; the jobs' `refs/heads/main` guard only stops accidental runs from a branch. The
  `build` job refuses a tag that is not `vX.Y.Z`, resolves it to one commit and refuses that
  commit unless it is on `main`, and every job checks out that commit, so only code that
  reached `main` through review is signed; `publish` refuses to upload if the tag has moved
  since. The assets go to the release while it is still a draft, which only collaborators see;
  publishing it **never** starts a build, and `publish` refuses a published release unless the
  run sets `replace_published`. `macos-publish`, which ends hours later, may add the macOS files
  to a published release that has none, since that changes no file a user or the AUR already
  has; it re-checks the tag's commit and replaces existing macOS files only with
  `replace_published`. **⚠ setting:** a tag ruleset on `refs/tags/v*` that restricts
  updates and deletions (docs/runbook.md, "Release packages", step 9) keeps a release tag from
  being moved at all. The AUR, public the moment a push lands, **never** gets a package for
  a draft: `aur.yml` runs when a release is published (or by hand), holds no GitHub token,
  takes the `PKGBUILD` and `SRCINFO` only from the release's public download URLs, which answer
  404 for a draft, checks them against `SHA256SUMS` and the `PKGBUILD`'s version against the
  tag, and with signing on checks `SHA256SUMS` against `IDENTITY_REGEXP` before it pushes. The
  AUR key is a secret of the `aur` environment, which only `main` and `v*` tags may use. **⚠ limit:** a collaborator can publish a draft
  before its build has finished; the release is then public without its assets for that time,
  and `aur.yml` fails and opens a `release-failure` issue instead of pushing.
  [`starts only by workflow_dispatch with a tag, so publishing a release rebuilds nothing`](../tools/package/test/release-workflow.test.mjs),
  [`job %s runs only when enabled, here, from main`](../tools/package/test/release-workflow.test.mjs),
  [`builds only a vX.Y.Z tag whose commit is on main`](../tools/package/test/release-workflow.test.mjs),
  [`macos-publish adds only the macOS files, and replaces them only when told`](../tools/package/test/release-workflow.test.mjs),
  [`release-build starts release.yml on main for the tag release-please just created`](../tools/package/test/release-workflow.test.mjs),
  [`accepts release.yml at refs/heads/main`](../tools/package/test/package.test.mjs),
  [`refuses %s`](../tools/package/test/package.test.mjs),
  [`never pushes to the AUR`](../tools/package/test/release-workflow.test.mjs),
  [`runs when a release is published, or by hand with a tag; never for a draft`](../tools/package/test/release-workflow.test.mjs),
  [`takes the PKGBUILD from the published release only, with no GitHub token`](../tools/package/test/release-workflow.test.mjs),
  [`checks the release's signature against the documented identity when signing is on`](../tools/package/test/release-workflow.test.mjs),
  [`uploads to the release by its tag and leaves the draft on that tag`](../tools/package/test/release-workflow.test.mjs),
  [`builds, packages and publishes the one commit it checked`](../tools/package/test/release-workflow.test.mjs),
  [`uploads only to a draft unless told to replace a published release`](../tools/package/test/release-workflow.test.mjs),
  [`takes the AUR key from the aur environment`](../tools/package/test/release-workflow.test.mjs)

- B11. The Homebrew tap, `vimma-browser/homebrew-tap`, is public the moment a push lands, and
  `brew` runs a cask's Ruby on the user's Mac, so it **must** get only a cask that `release.yml`
  built for a published release, as the AUR does (B10). `tools/package/cask.mjs` renders the cask
  in `macos-build` from the `.dmg`'s SHA-256, and accepts only an `X.Y.Z` release version, a
  lowercase SHA-256 and an `owner/name` repository, the values it places in Ruby strings. The
  cask has no `preflight`, `postflight`, `installer` or `script` stanza, runs nothing at install,
  pins the `.dmg`'s SHA-256, and zaps only Vimma's own paths under `~/Library`, never
  `~/.config/vimma`. `macos-smoke` runs `brew style`, an offline `brew audit --cask --strict`, and
  installs the `.dmg` through the cask before anything is signed; `pkgbuild.yml` does the same with
  a stub `.dmg` on every pull request that changes `tools/package/`. Both load the cask from a
  throwaway local tap and trust only that one cask (`brew trust --cask`) for the check, so
  Homebrew's tap trust stays on for every other tap on the runner. `homebrew.yml`'s `homebrew`
  job, which pushes, runs only by `workflow_dispatch` from `main`, and only while
  `MACOS_RELEASE_ENABLED` is `true`; it holds no GitHub token, runs no repository code, and takes `vimma.rb` only from the release's public
  download URLs, which answer 404 for a draft. It checks the cask against `SHA256SUMS-macos` and
  its version against the tag, and with signing on checks `SHA256SUMS-macos` against
  `IDENTITY_REGEXP` before it pushes over SSH to github.com, whose host key is pinned. It pushes
  only `Casks/vimma.rb`, never with `--force`, and never replaces a newer cask with an older one.
  Two jobs start it, each, as `main` has it, holding only `actions: write`, no environment and no
  secret, and running no repository code: `homebrew.yml`'s own `start` job, which a published release
  (`released`, never a pre-release) runs, and `release.yml`'s `macos-tap` job, which runs when the
  macOS files reach the release. Each starts `homebrew.yml` on `main` with the tag only once
  `vimma.rb` is on the published release, so whichever of the publish and the macOS files comes
  last starts the push. Each learns that from the release's metadata, read without a token from
  the API's `releases/tags/<tag>`, which answers 404 for a draft; it also requires `draft` to be
  false and the file's upload to be complete, never requests the file itself (any request for a
  release file counts as a download, docs/runbook.md, "Release download counts"), and fails on
  any answer other than 200 or 404 and on a 200 that is not a release, so a rate limit or an outage never passes for a release
  without the cask. Starting `homebrew.yml` grants nothing: its `homebrew` job still downloads
  the cask and checks it as above. `start` runs the tag's copy of `homebrew.yml`, which anyone with write
  access can edit on a tag of their own: an edited copy may ask for any permissions and read the
  repository's and organisation's secrets, but it gets nothing a write-access user cannot already
  get by pushing a branch. It cannot deploy to the `homebrew` environment, so it cannot reach the
  tap's key. `start` checks the tag's form before it fetches anything. A failed `start` (a
  malformed tag, a dispatch GitHub refuses) or a failed push opens or comments on the
  `release-failure` issue from the `failure` job, which holds only `issues: write`, so the tap is
  never left on an older release unnoticed. The tap's key is a write deploy key of the tap alone, a secret
  of the `homebrew` environment, which only `main` may use. No tag may deploy to it (as in B6): a
  tag ruleset restricts moving a tag, not creating one, and a run's workflow file and its `if:`
  come from its ref, so a tag on an unmerged commit could carry a `homebrew.yml` that skips every
  check and pushes any Ruby to the tap. For the same reason the `homebrew` job requires
  `workflow_dispatch`: a release event runs the tag's copy of the file, so that run only starts
  `main`'s copy, as `update-publish.yml` does (UP7). **⚠ setting:** the `homebrew`
  environment's only deployment policy is the branch `main`. **⚠ setting:** the tap's
  ruleset on `main` forbids deletion and force pushes and requires a pull request; deploy keys
  bypass it, so the workflow pushes directly, and admins bypass it only through a pull request
  (docs/runbook.md, "Release packages", step 7). The tap's own
  [`check.yml`](https://github.com/vimma-browser/homebrew-tap/blob/main/.github/workflows/check.yml)
  runs `brew style` and the same offline `brew audit --cask --strict` checks, on the latest stable
  Homebrew, on the tap's pull requests and on each push to its `main`, on a GitHub-hosted
  `macos-15` runner with a `contents: read` token, no secret, no `pull_request_target` trigger
  and `Homebrew/actions/setup-homebrew` pinned by commit SHA. A fork's pull request can replace
  `check.yml` itself, so those settings do not bound it: what does is GitHub's token for a fork's
  pull request, which is read-only and gets no secret, and the tap's approval policy for fork
  runs. **⚠ setting:** the tap's fork pull request approval is `all_external_contributors`, so
  a fork's workflow runs only once a person approves it. **⚠ setting:** the tap's Actions
  permissions set `sha_pinning_required`, so GitHub refuses an action not pinned to a full
  commit SHA (docs/runbook.md, "Release packages", step 7, for both). The check is not
  required, so it never holds `homebrew.yml`'s push; it reports a pushed cask that Homebrew
  would reject. **⚠ limit:** while `MACOS_SIGNING` is not `developer-id` (B14), the `.dmg` is
  ad hoc signed and not notarised, so Gatekeeper cannot vouch for it; the cask's caveats then tell
  users to choose Open Anyway in System Settings, and never to remove the quarantine flag. A
  notarised release's cask has no caveats.
  [`names the release dmg for the version and pins its sha256`](../tools/package/test/cask.test.mjs),
  [`refuses a pre-release, a version that is not SemVer, and a bad sha256`](../tools/package/test/cask.test.mjs),
  [`refuses repo %j`](../tools/package/test/cask.test.mjs),
  [`declares arm64, the minimum macOS, the app and the vimma binary, and no flight blocks`](../tools/package/test/cask.test.mjs),
  [`zaps Application Support and Caches, never ~/.config/vimma`](../tools/package/test/cask.test.mjs),
  [`caveats point to Open Anyway, never to xattr or --no-quarantine`](../tools/package/test/cask.test.mjs),
  [`checks the cask with brew style and an offline brew audit --cask --strict`](../tools/package/test/cask.test.mjs),
  [`refuses to install outside GitHub Actions`](../tools/package/test/cask.test.mjs),
  [`macos-smoke checks the cask with brew and installs the dmg through it`](../tools/package/test/release-workflow.test.mjs),
  [`macos-tap starts homebrew.yml on main once the cask is on a published release`](../tools/package/test/release-workflow.test.mjs),
  [`takes the cask from the published release only, with no GitHub token`](../tools/package/test/release-workflow.test.mjs),
  [`runs when a release is published, or by dispatch with a tag; never on a push or a PR`](../tools/package/test/release-workflow.test.mjs),
  [`reads the release event nowhere but the start condition, TAG and the concurrency group`](../tools/package/test/release-workflow.test.mjs),
  [`a published release only starts the tap push on main`](../tools/package/test/release-workflow.test.mjs),
  [`the start step dispatches main's copy once the cask is on the published release`](../tools/package/test/release-workflow.test.mjs),
  [`the start step refuses the tag %j before anything is fetched`](../tools/package/test/release-workflow.test.mjs),
  [`the homebrew job runs only by dispatch, when the macOS release is enabled, here, from main`](../tools/package/test/release-workflow.test.mjs),
  [`the failure report covers start and the push, when the macOS release is enabled, here`](../tools/package/test/release-workflow.test.mjs),
  [`a release without the cask is an error`](../tools/package/test/release-workflow.test.mjs),
  [`the download step refuses %s`](../tools/package/test/release-workflow.test.mjs),
  [`checks SHA256SUMS-macos's signature against the documented identity when signing is on`](../tools/package/test/release-workflow.test.mjs),
  [`takes the tap key from the homebrew environment`](../tools/package/test/release-workflow.test.mjs),
  [`the tap key reaches only the push step`](../tools/package/test/release-workflow.test.mjs),
  [`pushes Casks/vimma.rb to the tap over SSH with github.com's pinned host key`](../tools/package/test/release-workflow.test.mjs),
  [`never replaces a newer cask with an older one`](../tools/package/test/release-workflow.test.mjs),
  [`reads the release's metadata and never requests a release file`](../tools/test/release-asset-checks.test.mjs),
  [`starts nothing, green, when %s`](../tools/test/release-asset-checks.test.mjs),
  [`fails when the release API answers %i`](../tools/test/release-asset-checks.test.mjs),
  [`no workflow requests a release file only to see that it exists`](../tools/test/release-asset-checks.test.mjs)

- B12. The Flatpak build, `flatpak.yml` (spec [flatpak](specs/flatpak.md)), publishes nothing,
  holds no secret and no environment, and each job's token only reads the repository. It
  **must** build a release only from the release's public download URL, which answers 404 for a
  draft, pinned to the tarball's SHA-256 in that release's `SHA256SUMS`, and with signing on
  only after `SHA256SUMS` passes `cosign verify-blob` against `IDENTITY_REGEXP`; flatpak-builder
  then refuses a tarball with any other hash. Event values reach its scripts only through `env`.
  The manifest generator accepts only a SemVer version, a lower-case SHA-256 and a bare file
  name, and its build commands are fixed strings. The build runs in a privileged container from
  the `fedora:44` image pinned by digest, on Flathub runtimes pinned by commit. A release event
  runs the tag's copy of the workflow, which has the same read-only token. The app's sandbox
  grants Firefox's Flatpak permissions and `~/.local/state/omarchy` read-only, never the home
  directory and nothing under `~/.config` but `gtk-3.0` read-only, so the Omarchy hook
  (section 7) is never installed from it. The container is privileged, since Flatpak's sandbox
  needs it inside docker, and runs the release build, which reaches the network; that is safe
  only on a GitHub-hosted runner, which every job is held to (B5). **⚠
  limit:** Fedora's packages (`flatpak`, `flatpak-builder`) are installed at their current
  versions from Fedora's signed repositories; the digest fixes only the base image.
  [`builds a published release from its download URL, checked against SHA256SUMS`](../tools/package/test/flatpak.test.mjs),
  [`checks the release's signature against the documented identity when signing is on`](../tools/package/test/flatpak.test.mjs),
  [`holds no secret and only reads the repository`](../tools/package/test/flatpak.test.mjs),
  [`passes event values to run: through env only`](../tools/package/test/flatpak.test.mjs),
  [`refuses %s`](../tools/package/test/flatpak.test.mjs),
  [`puts no input into a build command, so none can change what the build runs`](../tools/package/test/flatpak.test.mjs),
  [`pins the Fedora image by digest and the runtime and SDK by commit`](../tools/package/test/flatpak.test.mjs),
  [`grants Firefox's Flatpak permissions and the Omarchy theme read-only, never the home`](../tools/package/test/flatpak.test.mjs)
- B13. `vimma-ctl` ships inside the release packages (spec
  [ship-vimma-ctl](specs/ship-vimma-ctl.md)). `release.yml`'s `ctl` job builds it from the
  commit `build` checked, and `macos-ctl` from the commit it checks as `build` does; `macos-build`
  **must** refuse a Mac binary built from any other commit. Both jobs **must** hold only a
  read-only token, no environment and no secret, since compiling the client needs none. The
  crate has no dependencies, so cargo downloads no crate, and the toolchain comes through the
  runner's rustup at the version `rust-toolchain.toml` pins. The binary reaches users only inside
  the packages, which `SHA256SUMS` lists and the `sign` jobs sign (B9, B10); it is never an asset
  of its own. Its notices, and on Linux its SBOM entry, come from the same jobs, after the binary is
  checked: `tools/package/ctl-notices.mjs` copies the notices from the toolchain's sysroot and
  musl's `COPYRIGHT` from the repository (pinned by SHA-256 in `tools/package/vendor/README.md`),
  and reads every version from the build, so the SBOM names what is in the binary; `package`
  checks the merged SBOM against the CycloneDX schema before it is signed.
  [`ctl builds the checked commit's vimma-ctl, static, without the build environment`](../tools/package/test/release-workflow.test.mjs),
  [`ctl gathers vimma-ctl's notices and SBOM entry from the toolchain that built it`](../tools/package/test/release-workflow.test.mjs),
  [`package ships vimma-ctl's notices, lists it in the SBOM and checks both`](../tools/package/test/release-workflow.test.mjs),
  [`refuses a musl version it has no COPYRIGHT for`](../tools/package/test/ctl-notices.test.mjs),
  [`macos-ctl builds vimma-ctl on a Mac from the commit it checked, like build`](../tools/package/test/release-workflow.test.mjs),
  [`macos-build signs the Mac vimma-ctl into the app, from the same commit`](../tools/package/test/release-workflow.test.mjs),
  [`package puts vimma-ctl into every package and checks it in each`](../tools/package/test/release-workflow.test.mjs)
- B14. A macOS release is signed with Vimma's Apple Developer ID and notarised only while the
  repository variable `MACOS_SIGNING` is `developer-id` (spec
  [macos-build](specs/macos-build.md), decisions 23 to 28). The four Apple secrets,
  `APPLE_DEVELOPER_ID_P12` (the Developer ID Application certificate and its private key, as
  base64 PKCS #12), `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_NOTARY_API_KEY` (an App Store
  Connect API key, as the JSON `rcodesign encode-app-store-connect-api-key` writes) and
  `APPLE_TEAM_ID`, **must** be secrets of the `macos-sign` environment only, and only
  `release.yml`'s `macos-notarise` job reads them. Signing is split over three jobs, each on its
  own runner, so that no program the build produced ever runs where the secrets are: the
  disk-image tools that `macos-build`'s `mach` bootstrapped (`dmg`, `hfsplus`, `newfs_hfs`),
  handed over as an artifact and not checked against a pinned hash, parse the untrusted disk image
  in `macos-unpack` and pack the signed app in `macos-pack`, neither of which holds a secret, so a
  replaced tool, or a process it leaves behind, never sees a credential. `macos-notarise` **must
  not** run any binary from an artifact: it downloads the unpacked volume only as a tar file,
  fetches rcodesign by `fetch-rcodesign.sh`, which checks its SHA-256, and runs only that and
  `tools/package/macos-sign-app.sh`, which calls rcodesign and standard system tools. It holds a
  read-only token and no OIDC permission, and checks out the commit `macos-build` built. The
  job must equal its golden copy, `tools/package/test/macos-notarise.golden.txt`, line for line
  apart from the commits its actions are pinned to, and the workflow's top-level keys and `env:`
  are fixed, so any change to a command, a step key (`shell:`, `env:`, `working-directory:`) or a
  job key (`defaults:`, `container:`) is a visible change to that file in review. Before any
  credential is written, the app is unpacked and the SHA-256 of its manifest
  (`macos-app-manifest.sh`: every path, type, executable bit and SHA-256, computed with coreutils
  and `sha256sum` only) must equal `macos-build`'s job output `manifest_sha256`, the hash of the
  manifest of the app `macos-dmg.sh` signed ad hoc there. The script refuses any name that is not
  printable ASCII before it prints anything, and the step hashes its output only when the script
  succeeded, under `shell: bash` (`-eo pipefail`) for every step of the job, so a manifest it
  stopped writing partway, which could otherwise match while hiding a subtree, is never accepted.
  Only the hash reaches this job, as a job
  output, because an artifact can be deleted and uploaded again by any job of the run with its
  `ACTIONS_RUNTIME_TOKEN`, while a job's outputs cannot be changed by another job. So a replaced
  `macos-volume` artifact, or an app a replaced unpack tool changed, is refused before any
  credential exists. A replaced `macos-signed-app` or `macos` artifact would have to carry
  Vimma's Developer ID signature, notarised, for the tag's version line, or `macos-smoke`'s
  signature, team and version checks fail. The manifest refuses any symlink, as Vimma.app has none,
  and the sign script refuses a symlink again, as well as a name rcodesign's scope syntax could
  misread (such as `:` or `@`) and an `Info.plist` whose `CFBundleExecutable` is not one plain
  file name (letters, digits, `.`, `_`, `+`, `-` and spaces, since Firefox's helpers such as
  "Vimma GPU Helper" have spaces in their names), so
  rcodesign cannot be led to read or write a file outside the bundle. The
  shell's `printf` writes the p12, its password and the key to files of mode 600 under
  `$RUNNER_TEMP`; rcodesign gets only their paths, never a secret on a command line; an
  `always()` step deletes them before the signed app is uploaded; no step echoes a secret. Before
  signing, the certificate's subject must be a Developer ID Application certificate whose team
  ID is `APPLE_TEAM_ID`. rcodesign's `--for-notarization` refuses any other certificate and a
  signature without Apple's timestamp. With `MACOS_SIGNING` set, a missing secret fails the
  release; it never falls back to an ad hoc `.dmg`. A hosted Mac then checks the published app
  with `codesign -dvv`, `spctl --assess` and `stapler validate`, and requires its team ID to be
  the repository variable `MACOS_TEAM_ID` (public in every signature, so not a secret), before
  `macos-sign` cosigns it; Gatekeeper alone would accept any team's notarised app. **⚠
  setting:** the `macos-sign` environment's only deployment policy is the branch `main`, so no
  branch or tag can run an edited workflow that reads the secrets (as in B6), and no repository
  secret of these names exists. It has no required reviewer, since a Firefox security release
  ships without a person. **⚠ limit:** whoever can merge to `main` can change `release.yml` to
  misuse the secrets, as for every other environment. **⚠ limit:** the manifest hash comes from
  the same release run as the build, so it guards against `macos-unpack`, not against a
  compromised build, which signs what it builds anyway. Nor does it catch a disk-image tool that
  is already malicious inside `macos-build`: `macos-dmg.sh` runs mach's `unpack_dmg` with the same
  tools before it writes the manifest, so the manifest describes whatever that tool produced, and
  such a tool, running inside `macos-build`, could also write the `manifest_sha256` output itself.
  **⚠ limit:** nothing pins the
  disk-image tools themselves. A replaced tool in `macos-pack` could pack a different app than
  the one notarised, which `macos-smoke`'s signature checks then fail; it could also add other
  entries to the `.dmg`, which is not signed, or point its Applications link elsewhere, and
  `macos-dmg-check.sh` checks only the art files, not that nothing else is on the volume.
  **A leaked p12** lets its holder sign any Mac software that Gatekeeper accepts as Vimma's team,
  and, with any API key of the team, notarise it, until Apple revokes the certificate. The
  response is in `docs/runbook.md`, "Developer ID signing": unset `MACOS_SIGNING` so releases go
  out ad hoc, delete the secrets, ask Apple to revoke the certificate, then issue a new one. Once
  Apple revokes it, Gatekeeper refuses software signed with it; whether Vimma releases signed
  before the leak keep opening depends on the date Apple revokes it from (**unverified**: no
  revocation has been tried). **A leaked API key** lets its holder notarise and read the team's
  notarisation history, not sign: revoke it in App Store Connect (Users and Access,
  Integrations) and create a new one. The certificate's expiry is read from the certificate
  (its `notAfter` date, or the certificate list on developer.apple.com), not assumed, and it is
  renewed as the runbook's "Rotating" paragraph says, with a reminder 60 days before that date.
  [`the Apple secrets come from the macos-sign environment, in macos-notarise alone`](../tools/package/test/release-workflow.test.mjs),
  [`the macos-sign job runs no binary of the build: only the pinned rcodesign`](../tools/package/test/release-workflow.test.mjs),
  [`runs rcodesign and no disk-image tool, mach, node or other program of the build`](../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a symlink that leaves the app, before rcodesign runs`](../tools/package/test/macos-developer-id.test.mjs),
  [`refuses every symlink, even one that stays inside the app, and an app that is a link`](../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a file name outside [A-Za-z0-9._+ -] in a path it scopes a setting to`](../tools/package/test/macos-developer-id.test.mjs),
  [`signs the released 0.1.10 bundle's layout, spaced helper names passed intact`](../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a CFBundleExecutable with a / or .., and a binary Info.plist`](../tools/package/test/macos-developer-id.test.mjs),
  [`changes when a byte, an executable bit or a file name changes`](../tools/package/test/macos-developer-id.test.mjs),
  [`macos-notarise checks the app against macos-build's manifest hash before the credentials`](../tools/package/test/release-workflow.test.mjs),
  [`the check catches %s`](../tools/package/test/release-workflow.test.mjs),
  [`a manifest script that stops partway never passes the hash check`](../tools/package/test/release-workflow.test.mjs),
  [`refuses a name with a newline, a control character or a non-ASCII byte, printing nothing`](../tools/package/test/macos-developer-id.test.mjs),
  [`%s runs only when MACOS_SIGNING is developer-id, after %s`](../tools/package/test/release-workflow.test.mjs),
  [`writes the credentials to owner-only files and fails when one is missing`](../tools/package/test/release-workflow.test.mjs),
  [`removes the credentials in an always() step before anything is uploaded`](../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke takes the ad hoc dmg only when Developer ID is off`](../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke checks the Developer ID of Vimma's team, notarisation and Gatekeeper`](../tools/package/test/release-workflow.test.mjs),
  [`fails %s`](../tools/package/test/macos-developer-id.test.mjs),
  [`checks the certificate is a Developer ID Application of APPLE_TEAM_ID before signing`](../tools/package/test/macos-developer-id.test.mjs),
  [`passes the password and the API key as files, never on a command line`](../tools/package/test/macos-developer-id.test.mjs),
  [`signs in one rcodesign run, nested code inside-out with mach macos-sign's settings`](../tools/package/test/macos-developer-id.test.mjs),
  [`the browser gets Firefox's production entitlements without the restricted pair`](../tools/package/test/macos-developer-id.test.mjs)

- B15. `site-dispatch.yml` (spec [site-keys-mirror](specs/site-keys-mirror.md)) tells
  `vimma-browser/vimma-site` about a published release (`vimma-release`, never for a
  pre-release) or a change to `docs/bindings.json` on `main` (`vimma-bindings`). Its `dispatch`
  job holds the private key of the org's GitHub App `vimma-site-dispatch`, the secret
  `SITE_DISPATCH_APP_KEY` of the `site-dispatch` environment, with the app's client ID in the
  variable `SITE_DISPATCH_APP_ID`. The key **must** reach only `main`'s copy of the workflow:
  with it a token can push to `vimma-site`'s branches, and `release-sync.yml` there sets
  auto-merge on its `release-sync/<tag>` pull requests and keeps commits pushed to them by hand,
  while `vimma-site`'s `main` ruleset asks for no approval, only the `build` check. A commit
  pushed to an open release-sync branch therefore merges itself and deploys to vimma.dev.
  `dispatch` **must** declare `environment: site-dispatch` and run only for a push to `main` or a
  `workflow_dispatch` on `refs/heads/main`. Its `GITHUB_TOKEN` has no permission, it checks
  nothing out and runs no repository code. `actions/create-github-app-token`, pinned by commit
  SHA, **must** mint the token for `vimma-site` alone with `contents: write`, what the
  `repository_dispatch` endpoint requires; the token lasts an hour, and the one API call goes to
  `vimma-site`'s `dispatches`. Without the variable or the key the job fails, so a release the
  site was never told about shows as a red run. A published release runs only `start`, from the
  tag's copy of the file, which anyone with write access can edit on a tag of their own; `start` holds only `actions: write`, no environment and
  no secret, runs no repository code, and starts `site-dispatch.yml` on `main` with
  `release=true`, as `homebrew.yml` does (B11). An edited copy on a tag or branch may ask for any
  permissions and read the repository's and organisation's secrets, but gets nothing a
  write-access user cannot already get by pushing a branch: it cannot deploy to the
  `site-dispatch` environment, so it cannot reach the key. Event values, the release's tag among
  them, reach the shell only through `env`. **⚠ setting:** the `site-dispatch` environment's
  only deployment policy is the branch `main`, and the repository holds no
  `SITE_DISPATCH_APP_KEY` of its own (docs/runbook.md, "vimma.dev's keys"). **⚠ setting:** the
  app holds only Contents read and write (with Metadata read) and is installed on `vimma-site`
  alone, so a leaked key reaches no other repository and cannot change `vimma-site`'s workflows
  (that needs the Workflows permission). **⚠ limit:** the Cloudflare Workers and Pages app builds
  `vimma-site`'s pushed branches, so a leaked key could also get a branch of its own built as a
  preview.
  [`the job that uses the key deploys to site-dispatch and runs only from main`](../tools/test/site-dispatch-workflow.test.mjs),
  [`the release event never reaches the key: start only starts main's copy`](../tools/test/site-dispatch-workflow.test.mjs),
  [`has no permission at the top level, and only start asks for one: actions: write`](../tools/test/site-dispatch-workflow.test.mjs),
  [`mints the app token for vimma-browser/vimma-site alone, with contents: write only`](../tools/test/site-dispatch-workflow.test.mjs),
  [`holds the app's key and no other secret, and no personal token`](../tools/test/site-dispatch-workflow.test.mjs),
  [`pins every action by full commit SHA and checks nothing out`](../tools/test/site-dispatch-workflow.test.mjs),
  [`sends the dispatch to vimma-site only`](../tools/test/site-dispatch-workflow.test.mjs),
  [`passes the tag and every event value to run: through env only`](../tools/test/site-dispatch-workflow.test.mjs),
  [`finds every form of run: script, so none escapes the env-only check`](../tools/test/site-dispatch-workflow.test.mjs),
  [`keeps the release event's run, a release dispatch and a bindings dispatch apart`](../tools/test/site-dispatch-workflow.test.mjs),
  [`fails without the app's ID or key instead of skipping the dispatch`](../tools/test/site-dispatch-workflow.test.mjs),
  [`never runs for a pre-release or outside vimma-browser/vimma`](../tools/test/site-dispatch-workflow.test.mjs)
- B16. The fonts in `tests/e2e/fonts/` are binary files from outside the project that a browser
  opens: the e2e harness gives them to the scenarios' browser on Linux (issue #944), and
  no package ships them. Each **must** be an unchanged copy of an upstream release (DejaVu 2.37,
  whose tarball's SHA-256 matched on GitHub and SourceForge; Liberation 2.1.5, whose font matched
  Ubuntu's package but for one glyph), and its own SHA-256 **must** be the one
  `tests/e2e/fonts/README.md` records, so a changed file fails the tests rather than reaching a
  browser unreviewed. The harness lets the content sandbox read that one folder in the
  throwaway profile only.
  [`lists every font file with the SHA-256 it has`](../tools/e2e/test/fonts.test.mjs),
  [`offers no font outside the vendored folder`](../tools/e2e/test/fonts.test.mjs),
  [`lets content processes read the pinned fonts' folder as well, when asked`](../tools/e2e/test/launcher.test.mjs)
- B17. D2 draws the two SVG pictures in `ARCHITECTURE.md` (issue #943). It is a build tool from
  outside the project (terrastruct/d2, MPL-2.0) that runs on a contributor's machine and is
  never shipped. `tools/diagrams/render.ts` **must** pin its release by version (v0.9.0) and by
  the SHA-256 of each platform's tarball, copied from the release's `SHA256SUMS`, and **must**
  check the downloaded bytes in memory before handing them to `tar` on stdin. It unpacks into a
  folder beside the cache and moves it into place, and records the binary's own SHA-256, so an
  interrupted or altered install is downloaded again rather than run. D2 **must** run only when
  a person runs `npm run diagrams`: no workflow, no other npm script, `npm ci`, lint or test
  renders. CI runs only `npm run diagrams:check`, which needs no D2 and fails on an SVG that is
  behind its source, was edited by hand, or holds a script, `foreignObject`, an event handler or
  an address other than the SVG namespaces and D2's embedded `data:` fonts.
  `VIMMA_D2=<path>` uses a binary the person chose; only the version it reports is checked.
  The SVGs embed subsets of D2's default fonts, Source Sans Pro and Source Code Pro (SIL OFL
  1.1). **⚠ limit:** the pin trusts the release that GitHub served when the sums were copied.
  [`is a fixed release, with a SHA-256 for each platform contributors use`](../tools/diagrams/test/render.test.ts),
  [`a download whose checksum differs is refused`](../tools/diagrams/test/render.test.ts),
  [`is unpacked aside and moved into place, with its hash recorded and checked on use`](../tools/diagrams/test/render.test.ts),
  [`a half-unpacked cache, with no recorded hash, is not used`](../tools/diagrams/test/render.test.ts),
  [`VIMMA_D2 of the pinned version is used, with no cache folder needed`](../tools/diagrams/test/render.test.ts),
  [`no workflow and no npm script but diagrams renders: CI only checks`](../tools/diagrams/test/render.test.ts),
  [`fails when an SVG was edited after the render`](../tools/diagrams/test/render.test.ts),
  [`the committed SVGs hold none of them`](../tools/diagrams/test/render.test.ts)
- B18. A guard that a workflow runs from the base branch (`git show "$BASE:tools/…"`: the
  docs-only classifier in ci.yml and e2e.yml, the release key guard in key-guard.yml) judges the
  pull request whose checkout it runs in, so **nothing** of that checkout may run before it: no
  action but `actions/checkout`, and no `node`, `npm`, `npx` or `yarn` step. Setting up a tool
  counts: `actions/setup-node` prints the versions of `npm` and `yarn` in the checkout, and a
  package manager reads its configuration, which can name a program to start, from the current
  directory, so a pull request could run its own code before the guard and change what the guard
  answers. These guards therefore run on the runner image's own Node and stay `.mjs` (ADR-025,
  decision 7). The `actions/setup-node` steps that run before other tools, on trusted refs only,
  set `YARN_IGNORE_PATH`, which Yarn 1 honours, and `package-manager-cache: false`.
  [`nothing runs in the pull request's checkout before a guard from the base`](../tools/test/runner-node.test.ts),
  [`a setup-node before a guard or a token-holding tool never caches by itself`](../tools/test/runner-node.test.ts)

## 15. Live grep (`host/grep.mjs`, `actors/VimmaChild.sys.mjs`, `actors/grep-matcher.mjs`)

`ctrl+b f g` searches the text of the tabs in its scope: the parent sends the query to each
frame's own content process, which builds a text model of its own document on the page's thread,
matches the query in that process's worker thread, and answers with the matching lines. The
widest scope adds recently closed tabs and windows, whose titles and URLs (Firefox keeps no page
text for them) are matched in a worker thread of the parent process.
Spec: [live-grep](specs/live-grep.md).

**Reach:** only you, with the key or `:grep`. No control-socket command reaches it, so neither
`vimma-ctl` nor an agent connection can run it or read its results (S7). Each frame answers from
its own document only, and no page receives another page's text. Three things are exposed, and
accepted because Firefox's own find bar exposes the same:

- **The query** goes to the content process of every frame in scope, third-party iframes
  included, from the `this window` scope on the agent workspace's tabs, and from the
  `all windows` scope the tabs of your other windows on the same side of the private line. A
  compromised content process can read it.
- **A jump** selects the match as find does: the chosen page sees the selection
  (`getSelection()`, `selectionchange`) and the focus it gets.
- **Building the text model** runs on the page's main thread, so a page can see that it was
  searched from the time it takes.

Rules:

- L1. Live grep **must** search only windows on its own side of the private line, and other
  windows only once the scope is widened to them: a normal window **never** searches or lists a
  private tab, open or recently closed, and a private window **never** lists a normal tab, open
  or recently closed, nor a closed normal window. A window SessionStore does not track yet is
  skipped, not searched.
  [`private_tabs_never_reach_a_normal_window_and_back`](../tests/browser/browser_vimma_live_grep_windows.js),
  [`all_windows_searches_the_other_windows_and_enter_goes_there`](../tests/browser/browser_vimma_live_grep_windows.js),
  [`a_window_sessionstore_does_not_track_is_skipped`](../tests/browser/browser_vimma_live_grep_windows.js)
- L2. A frame's reply comes from a content process that may be compromised: the parent **must**
  copy it field by field, cut to the limits (100 listed and 1,000 counted matches a frame, lines
  of 162 characters, 21 preview lines of 302 characters, a preview's match within its line),
  and drop a malformed one.
  [`a good reply is copied`](../packages/vimma-core/test/grep.test.mjs),
  [`drops %j`](../packages/vimma-core/test/grep.test.mjs),
  [`cuts overlong contexts and too many matches`](../packages/vimma-core/test/grep.test.mjs),
  [`a reply's timedOut and cut flags are kept as booleans`](../packages/vimma-core/test/grep.test.mjs),
  [`parsePreviewReply checks and cuts the preview`](../packages/vimma-core/test/grep.test.mjs),
  [`parsePreviewReply clips the match to its line`](../packages/vimma-core/test/grep.test.mjs)
- L3. Rows, the preview and its title **must** show page text, titles and URLs, recently closed
  ones included, as text nodes and `<mark>` elements made in chrome, **never** parsed as HTML
  (C1).
  [`page_text_with_markup_stays_text`](../tests/browser/browser_vimma_live_grep.js),
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../tools/security/test/chrome-source.test.ts)
- L4. The agent workspace's tabs **must** be searched only when the scope includes them, and
  their results **must** be marked as the agent's, so an agent's page is never taken for yours;
  a recently closed tab or window is the agent's when the tab its row shows was in the agent
  workspace's container.
  [`agent_tabs_only_in_window_scope_marked_and_last`](../tests/browser/browser_vimma_live_grep_windows.js),
  [`agent workspace rows are marked and come last`](../packages/vimma-core/test/grep.test.mjs),
  [`a closed window takes the agent marking of the tab it shows`](../packages/vimma-core/test/grep.test.mjs)
- L5. Page text **must not** outlive the picker: when it closes, every frame the query was sent
  to is told to drop its text model, its observer and its worker, whether or not it answered;
  the parent keeps no rows; the grep list holds only the lines it shows, in memory, never on
  disk or in the session store, and drops a tab's lines when the tab or its window closes, and
  stops watching a closed window. The recently closed titles and URLs a search sends to the
  parent's worker are held under one key a picker session and dropped when the picker closes.
  A `]q`/`[q` step that ends after the picker opened again leaves its frame to that search,
  which tells it to drop its text when it closes.
  [`closing_tells_every_searched_frame_to_drop_its_text`](../tests/browser/browser_vimma_live_grep.js),
  [`a_step_that_ends_after_grep_reopens_leaves_the_new_search_alone`](../tests/browser/browser_vimma_live_grep.js),
  [`a_step_whose_tab_switch_ends_after_grep_reopens_stops_there`](../tests/browser/browser_vimma_live_grep.js),
  [`a_reply_held_past_close_still_gets_grep_end`](../tests/browser/browser_vimma_live_grep.js),
  [`the_grep_list_steps_with_bracket_q_and_grep_resumes`](../tests/browser/browser_vimma_live_grep.js),
  [`pruneGrepList drops a closed tab's rows and keeps its place`](../packages/vimma-core/test/grep.test.mjs),
  [`the_grep_list_drops_a_closed_windows_lines`](../tests/browser/browser_vimma_live_grep_windows.js),
  [`the_closed_titles_have_one_matcher_key_until_close`](../tests/browser/browser_vimma_live_grep_windows.js)
- L6. A regular expression **must** run on page text only in a worker thread of the page's
  content process (one a process, shared by its frames), and on recently closed titles and URLs
  only in a worker thread of the parent process, line by line, and a query **must** be stopped
  when it has run for 1 second, answering `timed out`; a frame's newer query replaces its older
  one, as a picker session's newer closed query replaces its older one, and a frame drops a
  query older than one it has seen in this picker session. A backtracking pattern therefore
  costs at most a second of one worker thread a query, and neither the page nor the browser's
  own window stops responding. A query over 1,000 characters is not sent.
  [`a_frame_answers_timed_out_within_its_budget`](../tests/browser/browser_vimma_live_grep.js),
  [`a_catastrophic_pattern_never_freezes_the_page`](../tests/browser/browser_vimma_live_grep.js),
  [`a_frame_drops_an_older_query`](../tests/browser/browser_vimma_live_grep.js),
  [`grep_end_resets_the_frames_generation`](../tests/browser/browser_vimma_live_grep.js),
  [`one_worker_a_process_and_none_for_a_blank_frame`](../tests/browser/browser_vimma_live_grep.js),
  [`an_over_long_query_says_so_and_is_not_sent`](../tests/browser/browser_vimma_live_grep.js),
  [`a_catastrophic_pattern_on_closed_titles_never_freezes_the_browser`](../tests/browser/browser_vimma_live_grep_windows.js),
  [`a match never spans two lines`](../packages/vimma-core/test/grep.test.mjs)
- L7. A page **must not** be able to make the parent hold an unbounded search: at most 100
  frames are searched in a tab, and at most 2,000 matches are held, those of the replies first
  in the list, the last that fits cut to fill the 2,000; the rest keep only their counts. At
  most 25 recently closed tabs and 5 closed windows of at most 20 tabs each, each title and URL
  cut to 1,000 characters, are matched, one match a title or URL so that no entry can use up
  the count for the rest. A row's host is cut to 64 characters, and a URL without a host gives
  none, never the URL; a tab's title is cut to 300 characters.
  [`frames_past_the_cap_are_not_searched`](../tests/browser/browser_vimma_live_grep.js),
  [`matches are kept until 2,000 are held; past that only counts`](../packages/vimma-core/test/grep.test.mjs),
  [`the last reply that fits only in part is cut, so exactly 2,000 are held`](../packages/vimma-core/test/grep.test.mjs),
  [`newest first, at most 25 tabs and 5 windows, as Firefox keeps`](../packages/vimma-core/test/grep.test.mjs),
  [`a closed window's tabs past 20 and fields past 1,000 characters are not matched`](../packages/vimma-core/test/grep.test.mjs),
  [`one closed title matching a thousand times cannot crowd out the rest`](../packages/vimma-core/test/grep.test.mjs),
  [`a host-less URL gives no host, and a closed row's URL and host are cut`](../packages/vimma-core/test/grep.test.mjs),
  [`a better-ranked reply that arrives last still keeps its matches`](../packages/vimma-core/test/grep.test.mjs)
- L8. A jump, from the picker or `]q` / `[q`, **must** go only to the document that was searched:
  a frame that has navigated since gets nothing, and the notice says the match is gone.
  [`a_jump_never_reaches_a_document_the_frame_navigated_to`](../tests/browser/browser_vimma_live_grep.js)

## 16. Update check (`updates/VimmaUpdates.sys.mjs`, `update-publish.yml`, the MAR in `release.yml` and `nightly.yml`)

Spec: [m6a-updater](specs/m6a-updater.md) (delivery 1) and [update-notices](specs/update-notices.md).
Vimma fetches one signed manifest from `updates.vimma.dev` every 12 hours, at startup when a check
is due, and on `:update`, and tells the status bar, about:vimma and, once per version, a short
message whether a newer release exists; a security release also asks once per session whether
to show the update command, and once it is installed, whether to restart (UP11). Only the AppImage installs anything: it replaces its own file with
the offered AppImage (UP10); every other install downloads and installs nothing, except a tarball
built with Firefox's updater (UP12), which Firefox's own check and download update through
Vimma's hook (UP13). Who can reach it: whoever
controls the update host or the network path (TLS stops the path), _you_ through `about:config`
and `config.toml`, and the control socket's full role (`app.update_check` and `app.restart`, as
it can run `app.quit`). The agent role reaches no action, so a local AI agent can neither trigger
a check nor restart Vimma.
_Pages_ and _extensions_ cannot reach it.

- UP1. A manifest is accepted **only** when its signature (RSASSA-PKCS1-v1_5, SHA-384, over
  `vimma-update-xml-v1\n` and the file) verifies under a key pinned in the build
  (`core/update-keys.mjs`); keys from the pref `vimma.update.testKeys` count only when
  `Cu.isInAutomation`. An unsigned, altered or otherwise signed manifest offers nothing, and a
  build with no pinned key refuses every manifest.
  [`a key that is not pinned is refused, even with a valid signature`](../packages/vimma-core/test/updates.test.mjs),
  [`one flipped byte in the body fails`](../packages/vimma-core/test/updates.test.mjs),
  [`a signature over the body without the domain prefix fails`](../packages/vimma-core/test/updates.test.mjs),
  [`no pinned key at all refuses every manifest (before the key ceremony)`](../packages/vimma-core/test/updates.test.mjs),
  [`every pinned key is an RSA-4096 SPKI whose id matches, one per slot`](../packages/vimma-core/test/updates.test.mjs),
  [`a signature made as Cloud KMS makes it (raw PKCS#1 over a SHA-384 DigestInfo) verifies`](../packages/vimma-core/test/updates.test.mjs),
  [`refusals_show_after_three_in_a_row`](../tests/browser/browser_vimma_update_check.js)
- UP2. A verified manifest is **never** accepted for another channel or platform, with a serial
  older than one this profile accepted or than the running build's ID (replay), or with a serial
  more than a day ahead of the clock, and an older or equal build, or the Vimma version that is
  already running, is **never** offered (downgrade). A release build **must** carry one build ID
  in its binary and its `application.ini` (the manifest's source): release.yml and nightly.yml fix
  `MOZ_BUILD_DATE` and fail a package whose two differ. Withholding updates or serving an old
  manifest for long is what a compromised host can still do; the feed's age shows after 45 days
  (7 for nightly).
  [`channel and target mismatches are refused`](../packages/vimma-core/test/updates.test.mjs),
  [`replay: a serial below the one accepted, or below this build, is refused; equal is accepted`](../packages/vimma-core/test/updates.test.mjs),
  [`downgrade: an older or equal build is no offer, not an error`](../packages/vimma-core/test/updates.test.mjs),
  [`the Vimma version already running is no offer, whatever its build ID`](../packages/vimma-core/test/updates.test.mjs),
  [`the_vimma_version_running_is_never_offered`](../tests/browser/browser_vimma_update_check.js),
  [`a packaged build ID that differs from the binary's is a problem`](../tools/release/test/build-id.test.mjs),
  [`release.yml's Linux and macOS builds fix MOZ_BUILD_DATE before they build`](../tools/package/test/release-workflow.test.mjs),
  [`a release feed older than 45 days and a nightly one older than 7 are stale`](../packages/vimma-core/test/updates.test.mjs),
  [`replay_is_refused_and_downgrade_offers_nothing`](../tests/browser/browser_vimma_update_check.js),
  [`a serial more than a day ahead of the clock is refused; up to a day is accepted`](../packages/vimma-core/test/updates.test.mjs),
  [`a_serial_from_the_future_is_refused`](../tests/browser/browser_vimma_update_check.js)
- UP3. A check **never** sends cookies, a referrer, the user's languages or anything that
  identifies the install: the request is an anonymous, uncached GET with an empty
  `Accept-Language` whose URL may carry only the platform and the update channel
  (`%BUILD_TARGET%`, `%CHANNEL%`), over https (plain http only in automation), and it **never**
  follows a redirect. Its other headers are Necko's, the same for every install of a build.
  [`newer_build_is_offered_and_the_request_is_anonymous`](../tests/browser/browser_vimma_update_check.js),
  [`the_url_may_name_only_platform_and_channel`](../tests/browser/browser_vimma_update_check.js),
  [`redirects_are_not_followed`](../tests/browser/browser_vimma_update_check.js),
  [`ask updates.vimma.dev with the platform and channel only`](../tools/branding/test/branding-prefs.test.ts)
- UP4. With `[updates] check = false` or `vimma.update.enabled` = `false`, and in a build run from
  its objdir, Vimma **never** makes an update request, and shows no update message or question.
  A `config.toml` with errors **never** turns checks on past an opt-out it may state: a
  `check = false` still readable in it holds, and while `[updates] check` cannot be read
  (the file cannot be read or its TOML does not parse; `updates` is not a table; `check` is not
  a boolean; `[updates]` has other keys but no `check`; the file has a top-level key Vimma does
  not know, such as `[update]`; or a boolean `check` sits in another table) and only the
  defaults stand in for the file, no check runs but `:update`, which the pref still stops. A
  file that parses applies its `check` as a valid file would. Apart from
  `:update`, an attempt that got no answer is **never** repeated within 10 minutes, so restarts
  send no burst of requests.
  [`off_by_pref_or_config_sends_nothing`](../tests/browser/browser_vimma_update_check.js),
  [`nothing_at_all_with_checks_off`](../tests/browser/browser_vimma_update_notices.js),
  [`checks off or a source build: never due`](../packages/vimma-core/test/update-notices.test.mjs),
  [`a failed attempt does not count as a check, but is not retried within 10 minutes`](../packages/vimma-core/test/update-notices.test.mjs),
  [`startup_checks_when_due_and_not_when_fresh`](../tests/browser/browser_vimma_update_notices.js),
  [`a_source_build_checks_nothing`](../tests/browser/browser_vimma_update_check.js),
  [`a_config_with_errors_still_turns_checks_off`](../tests/browser/browser_vimma_update_check.js),
  [`a file with errors: a readable check = false holds; else the config in force, or held`](../packages/vimma-core/test/updates.test.mjs),
  [`a file that parses but has errors checks as a valid file would (#741)`](../packages/vimma-core/test/updates.test.mjs),
  [`:update runs while checks are held, never past a stated opt-out`](../packages/vimma-core/test/updates.test.mjs),
  [`an opt-out under a misspelt or misplaced table may mean check = false`](../packages/vimma-core/test/updates.test.mjs),
  [`an_opt_out_under_a_misspelt_table_never_turns_checks_on`](../tests/browser/browser_vimma_update_check.js),
  [`a_config_that_parses_with_errors_still_checks`](../tests/browser/browser_vimma_update_check.js),
  [`update_runs_while_checks_are_held`](../tests/browser/browser_vimma_update_check.js)
- UP5. A response is read **only** up to 256 KiB, counted after decompression: a larger
  `Content-Length` is refused unread, and a longer body or a compression bomb is cancelled at the
  cap. Manifest text is parsed **only** after its signature verifies, and only in the one format
  the release pipeline writes: at most 64 KiB, no DTD or entity declarations, at most one
  `<update>`. The commands about:vimma shows are built from a SemVer version and shell-quoted
  paths, never from free text in the manifest; a saved result (the pref `vimma.update.last`) is
  checked the same way when read back.
  [`an_oversized_or_compressed_bomb_response_is_refused`](../tests/browser/browser_vimma_update_check.js),
  [`an oversized manifest is refused before any crypto`](../packages/vimma-core/test/updates.test.mjs),
  [`shellQuote leaves plain paths alone and quotes the rest`](../packages/vimma-core/test/updates.test.mjs),
  [`tarball: quit, download and check it, then unpack over the install's parent, quoted`](../packages/vimma-core/test/updates.test.mjs),
  [`a pinned key that is not a valid SPKI refuses, never throws`](../packages/vimma-core/test/updates.test.mjs),
  [`a_damaged_saved_result_is_dropped_not_thrown`](../tests/browser/browser_vimma_update_check.js)
- UP6. A package manager's install (the `.deb`, the `.rpm`, the release `PKGBUILD`, the AUR's
  `vimma-bin`)
  is **never** told to unpack a tarball over its install directory: every package except the
  tarball carries the `is-packaged-app` marker with its package type, the release refuses a
  `./mach package` tarball that already has one, and only an install without a marker gets the
  tarball's command. The release workflow's smoke test checks the type of the installed `.deb`
  and, without `$APPIMAGE`, of the extracted AppImage, the marker of the `.rpm` installed on
  Fedora and openSUSE, and that the tarball has no marker.
  [`every package type except the tarball carries the marker`](../tools/package/test/package.test.mjs),
  [`gives each package type its own update hint, and only the tarball an untar`](../tools/package/test/package.test.mjs),
  [`a tarball that already carries an install-source marker`](../tools/package/test/package.test.mjs),
  [`the .deb and AppImage smoke test checks each install type, and the tarball's lack of one`](../tools/package/test/release-workflow.test.mjs),
  [`checks the version line, the marker, the launcher, the desktop file and rpm -V`](../tools/package/test/rpm-smoke.test.mjs)
  On macOS ([macos-homebrew](specs/macos-homebrew.md) decisions 8 and 19) no install is told to
  download or unpack anything: the app at `/Applications/Vimma.app` with
  `/opt/homebrew/Caskroom/vimma/` present gets `brew upgrade --cask vimma`, and any other copy
  gets no command, only the release page, since a `.dmg` that `curl` fetches carries no
  quarantine flag and so would skip Gatekeeper's check. Nothing is written into the bundle.
  **⚠ limit:** Vimma 0.1.6 on a Mac calls itself a tarball install and shows the Linux tarball
  command for a macOS offer, without a hash (the macOS manifest names no tarball); the guide
  tells those users not to run it (decision 21).
  [`homebrew: brew upgrade --cask vimma (macos-homebrew decision 8)`](../packages/vimma-core/test/updates.test.mjs),
  [`dmg: the release page and the drag, with no command (macos-homebrew decision 19)`](../packages/vimma-core/test/updates.test.mjs),
  [`a Caskroom and an /Applications path change nothing on Linux`](../packages/vimma-core/test/updates.test.mjs),
  [`macos_installs_get_their_own_steps`](../tests/browser/browser_vimma_update_check.js)
  The Flatpak ([flatpak](specs/flatpak.md) decision 10; marker `vimma-package=flatpak`) gets
  only `flatpak update dev.vimma.browser`, in `:update`, the security question's steps and the
  one-time message, a fixed string with no part taken from the manifest (the message adds only
  the verified offer's version, as for every install):
  its `/app` is read-only and Flathub's build, not the release's files, is what it runs. The
  marker outranks `$APPIMAGE`, which a Flatpak started from an AppImage's process inherits, so a
  Flatpak is never handed the AppImage's replacement (UP10).
  [`flatpak: flatpak update, with no download (spec flatpak, decision 10)`](../packages/vimma-core/test/updates.test.mjs),
  [`is flatpak, whose update hint is flatpak update, never the tarball's unpack`](../tools/package/test/flatpak.test.mjs),
  [`flatpak_gets_flatpak_update`](../tests/browser/browser_vimma_update_check.js),
  [`a Flatpak names flatpak update, for an ordinary and a security release`](../packages/vimma-core/test/update-notices.test.mjs),
  [`not an AppImage install: nothing to replace`](../packages/vimma-core/test/appimage-update.test.mjs),
  [`a_flatpak_is_told_to_run_flatpak_update`](../tests/browser/browser_vimma_update_notices.js)

- UP7. A manifest is **only** signed by `update-publish.yml` run from `main`, and **only** for a
  release that is published (not a draft or a pre-release) and whose tag is on `main`, or as an
  empty manifest that offers nothing. Publishing a release starts a job that, as `main` has it,
  holds only `actions: write` and runs no repository code; it starts the workflow again on
  `main`, so the file that signs is always `main`'s, never a tag's. That job runs the tag's copy
  of the file, which anyone with write access can edit on a tag of their own: an edited copy may
  ask for any permissions and read the repository's and organisation's secrets, but it gets
  nothing a write-access user cannot already get by pushing a branch. It cannot deploy to the
  `update-signing` or `update-publish` environment, so it cannot reach the signing key or the
  deploy key. The signing job is the **only** job with
  `id-token: write`, uses the `update-signing` environment (deployment branch `main` alone), and
  runs no repository code: it checks the body's shape with the shell, signs the SHA-384
  DigestInfo with Cloud KMS and checks the signature with openssl. Before any pattern, it refuses
  a body with a byte that is not printable ASCII or a newline, or that does not end in a newline,
  because GNU grep may end a line at a NUL byte in a file it takes for binary, and a line check
  alone would then pass a body that hides another target or URL behind one. The job that builds the body
  holds no secret and installs no dependency. Before anything is pushed, a separate job checks
  the signed file with the verifier and the pinned key the browser uses and with openssl. Every
  file named in the manifest **must** match the release's `SHA256SUMS`, which **must** carry
  release.yml's cosign signature (an unsigned release gets no manifest), and is downloaded again after
  signing and checked against the signed size and SHA-512. A serial that is not newer than the
  published manifest's, a serial more than a day ahead of the clock, and an offer older than the
  published one are refused. The urgency comes from the labels of each commit's pull request;
  a label read that fails transiently (an HTTP 5xx, a body that is not JSON, a network error) is
  tried four times in all, 2, 4 and 8 s apart, and a commit whose labels still cannot be read
  **must** fail the run, never count as unlabelled, so a security release is never published as
  a normal one. The responses are parsed as raw JSON in `manifest.mjs`, not through jq, and their
  shape is checked: a pulls response that is not a list of pull requests, each with a list of
  labels with string names, fails the run (jq would read `{}` as no labels), and so does a
  releases list that does not contain the tag being published (such a list is malformed or cut
  short, and counting from it could widen the range of commits to the whole history; a wider
  range can only raise the urgency, but costs a label read per commit). The push uses a deploy key that can write only to
  `vimma-updates`, kept in the `update-publish` environment (deployment branch `main` alone),
  reached only by the push step, to a pinned github.com host key, and **never** forced; nothing is
  pushed unless `UPDATES_ENABLED` is `true`. **⚠ setting:** the environments' branch rules and the
  Workload Identity condition on `job_workflow_ref` (docs/runbook.md, "Update signing keys and
  the update host", step 7) are what keep another branch or workflow away from the key; the
  workflow's own `refs/heads/main` guard only stops accidental runs. The signing job also
  refuses a serial outside the last hour, and a dry run's real signature is kept one day, as a
  workflow artifact any signed-in GitHub user can download.
  The macOS manifest (`Darwin_aarch64-gcc3`, [macos-homebrew](specs/macos-homebrew.md) decisions
  16 to 18) is signed by the same jobs, key and environments, from the workflow's `target` input:
  its one file, the `.dmg`, **must** match `SHA256SUMS-macos`, which **must** carry release.yml's
  cosign signature, and is checked against it before the secretless `prepare` job (on a macOS
  runner) mounts it read-only to read its build ID; the signing job refuses a body for another
  target than the one asked for. The macOS run starts once the `.dmg` is on the published
  release, which the starting jobs learn from the release's metadata as in B11; `prepare` then
  checks again that the release is published and downloads the `.dmg` itself. Each target has its own concurrency group, so its serials only
  grow; a push that the other target's push beat is rebased onto it (another file), never forced.
  The nightly channel's manifest (`…/vimma-nightly/update.xml`, [m6a-updater](specs/m6a-updater.md)
  decisions 42 and 43) is signed by the same key and environments, by `nightly-prepare`,
  `nightly-sign` and `nightly-publish`, which run **only** in `nightly.yml`'s call from `main`
  (`github.workflow_ref`) and only while `UPDATES_ENABLED` and `NIGHTLY_RELEASE_ENABLED` are
  `true`. Before any pattern, `nightly-sign` runs the signing job's byte check, the same shell
  text: it refuses a body with a byte that is not printable ASCII or a newline, or that does not
  end in a newline, and refuses when grep fails, since a line check alone would pass a body that
  hides another channel or URL behind a NUL byte. `nightly-prepare` holds no secret; it requires the `nightly` release to be a public
  pre-release, checks its `SHA256SUMS` against `nightly.yml`'s cosign identity (never
  `release.yml`'s, so neither channel's sums can stand in for the other's), checks that the MAR
  verifies under the committed certificates on the channel `vimma-nightly`, and that the
  tarball's `application.ini` names the build asked for. `nightly-sign` runs no repository code
  and signs only the seven lines a nightly manifest for that build has: the channel
  `vimma-nightly`, the Linux target, a serial within the last hour, a `normal` offer of
  `X.Y.Z-nightly.<buildID>`, one `<patch>` and one `<vimmaTarball>` at that build's URLs on the
  `nightly` release, and nothing else. `nightly-publish` downloads both files again, checks the
  signed file with the browser's verifier and with openssl, and pushes only
  `…/vimma-nightly/update.xml`, never forced; a missing deploy key fails the run. A called job
  reads an environment secret only when its caller passes it, so `nightly.yml`'s `manifest` call
  passes `UPDATES_DEPLOY_KEY` by name (declared optional in `workflow_call`), never every secret
  with `inherit`; only `nightly-publish`, deploying to `update-publish`, reads it in a call and
  gets the environment's value, and the `mar-sign` calls pass none. **⚠ setting:** the key
  lives only in the `update-publish` environment; a repository or organisation secret of that
  name, readable from any branch, would also flow into the call, and none may exist
  (`gh api repos/vimma-browser/vimma/actions/secrets`). The release
  jobs refuse a body for any channel but `vimma`, `manifest.mjs` checks each channel before a
  push, and the client refuses a manifest for another channel (UP2), so a nightly offer never
  reaches a release install, nor a release offer a nightly install. Each channel's serials and
  offers only grow: an offer of an older build than the published nightly manifest's is
  refused. **⚠ limit:** a nightly is always offered as `normal` (decision 43), so a nightly
  that carries a Firefox security fix gets no restart question; Firefox's updater still stages
  it and applies it at the next start.
  On a scheduled day when `main` did not change (decision 44), `nightly.yml` makes the same call
  with the build the `nightly` release records, and these three jobs re-sign it unchanged: the
  same environments, permissions, Workload Identity condition, byte check and seven-line check,
  so the body differs from that build's earlier manifest only in its serial. The client takes
  the newer serial with an offer of its own version as up to date, with no download and no
  notice, and the nightly feed never goes stale while the nightly runs.
  **⚠ limit:** without a required reviewer on `update-signing`, anyone with write access can
  start a run on `main` that re-signs a published release or offers nothing (withholding
  updates).
  [`grants nothing by default, and each job only what it needs`](../tools/update/test/update-workflow.test.mjs),
  [`an unchanged day's re-sign offers the same build under a newer serial, and installs stay current`](../tools/update/test/nightly-manifest.test.mjs),
  [`only sign, mar-sign and nightly-sign mint an OIDC token or name the signing environment`](../tools/update/test/update-workflow.test.mjs),
  [`%s runs only in nightly.yml's call on main, with UPDATES_ENABLED and NIGHTLY_RELEASE_ENABLED`](../tools/update/test/update-workflow.test.mjs),
  [`nightly-prepare reads the public nightly pre-release and its nightly.yml signature`](../tools/update/test/update-workflow.test.mjs),
  [`nightly-prepare checks the MAR's channel and builds the nightly channel's manifest`](../tools/update/test/update-workflow.test.mjs),
  [`nightly-publish checks the signed file, then pushes only the nightly channel's path`](../tools/update/test/update-workflow.test.mjs),
  [`the release jobs never write the nightly path, nor the nightly jobs the release path`](../tools/update/test/update-workflow.test.mjs),
  [`nightly-sign signs the nightly's body so that the browser's verifier accepts it`](../tools/update/test/update-workflow.test.mjs),
  [`nightly-sign refuses to sign %s`](../tools/update/test/update-workflow.test.mjs),
  [`sign, the release's check, refuses the nightly's body`](../tools/update/test/update-workflow.test.mjs),
  [`checkSigned, the release's check, refuses a nightly manifest`](../tools/update/test/nightly-manifest.test.mjs),
  [`checkSignedNightly refuses a release manifest, whatever it offers`](../tools/update/test/nightly-manifest.test.mjs),
  [`checkSignedNightly refuses another key, a changed file, another build and a moved MAR`](../tools/update/test/nightly-manifest.test.mjs),
  [`refuses an older build than the published nightly manifest offers, and an old serial`](../tools/update/test/nightly-manifest.test.mjs),
  [`is offered to a nightly install of an older build, and to no release install`](../tools/update/test/nightly-manifest.test.mjs),
  [`the signing job %s runs no repository code: no checkout, no node, no npm`](../tools/update/test/update-workflow.test.mjs),
  [`a published release only starts the run on main, and only with UPDATES_ENABLED`](../tools/update/test/update-workflow.test.mjs),
  [`%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run`](../tools/update/test/update-workflow.test.mjs),
  [`checks that the release is published, not a pre-release, and on main`](../tools/update/test/update-workflow.test.mjs),
  [`checks SHA256SUMS against release.yml's signature, and refuses an unsigned release`](../tools/update/test/update-workflow.test.mjs),
  [`the publish job verifies with the browser's verifier and with openssl before any push`](../tools/update/test/update-workflow.test.mjs),
  [`the deploy key lives in its own environment and reaches only the push steps`](../tools/update/test/update-workflow.test.mjs),
  [`a call receives the deploy key only by name, optional, and only nightly.yml's manifest passes it`](../tools/update/test/update-workflow.test.mjs),
  [`pushes one commit naming the version to main, never forced, to a pinned host key`](../tools/update/test/update-workflow.test.mjs),
  [`a push the other target's run beat rebases and lands, with no git identity configured`](../tools/update/test/update-workflow.test.mjs),
  [`signs the body so that the browser's verifier accepts it under the KMS key`](../tools/update/test/update-workflow.test.mjs),
  [`refuses to sign %s`](../tools/update/test/update-workflow.test.mjs),
  [`every asset must be listed with the hash of the file that was downloaded`](../tools/update/test/manifest.test.mjs),
  [`must be newer than the published manifest's; equal or older is refused`](../tools/update/test/manifest.test.mjs),
  [`checkSigned refuses another key, a changed file, an older serial and another version`](../tools/update/test/manifest.test.mjs),
  [`refuses to offer an older version than the published manifest does`](../tools/update/test/manifest.test.mjs),
  [`retries a transient failure, then reads the labels`](../tools/update/test/manifest.test.mjs),
  [`throws after four attempts that all fail, never answering no labels`](../tools/update/test/manifest.test.mjs),
  [`throws at once on a failure that is not transient`](../tools/update/test/manifest.test.mjs),
  [`throws at once on %s instead of answering no labels`](../tools/update/test/manifest.test.mjs),
  [`throws at once on %s instead of widening the range`](../tools/update/test/manifest.test.mjs),
  [`downloads the target's files and sums, and passes the target to manifest.mjs`](../tools/update/test/update-workflow.test.mjs),
  [`checks a macOS body against the macOS target, and refuses a Linux one there`](../tools/update/test/update-workflow.test.mjs),
  [`runs one manifest per target at a time, never cancelling one half done`](../tools/update/test/update-workflow.test.mjs),
  [`refuses a .dmg that does not match SHA256SUMS-macos`](../tools/update/test/manifest.test.mjs),
  [`checkSigned takes the target: a Linux manifest is refused for macOS and back`](../tools/update/test/manifest.test.mjs),
  [`macos-tap starts the macOS update manifest once the .dmg is on a published release`](../tools/package/test/release-workflow.test.mjs),
  [`a published release whose .dmg is already there starts the macOS manifest too`](../tools/update/test/update-workflow.test.mjs),
  [`fails when the release API answers %i`](../tools/test/release-asset-checks.test.mjs)
- UP8. A command about:vimma shows **never** installs or replaces anything with a file it has not
  checked: every download uses `curl -f` (an HTTP error stops it) and `--proto =https`, and when
  the signed manifest gives the file's SHA-512, `sha512sum -c` checks it before `apt`, `dnf`,
  `zypper`, `tar` or `mv` runs. The `.rpm`'s zypper command passes `--allow-unsigned-rpm`, so
  for it that check is the only one, as it is for the `.deb`. A tarball is downloaded to a file and checked before it is unpacked, never piped
  into `tar`. Asset hashes are read only from the signed manifest, only as 128 lower-case hex
  digits, and a saved result keeps only well-formed ones. **⚠ limit:** the release `PKGBUILD`'s
  command still fetches `latest/download/PKGBUILD` without a hash of its own; `makepkg` checks
  the tarball against the SHA-256 that `PKGBUILD` pins.
  [`every download fails on an HTTP error and refuses anything but https (V-07)`](../packages/vimma-core/test/updates.test.mjs),
  [`rpm: download and check it, then install it with dnf or zypper`](../packages/vimma-core/test/updates.test.mjs),
  [`the checked commands run: a matching file installs, a different one stops before`](../packages/vimma-core/test/updates.test.mjs),
  [`reads each package's size and SHA-512 (the release pipeline's asset elements)`](../packages/vimma-core/test/updates.test.mjs),
  [`offerAssets keeps only well-formed entries (a saved result read back)`](../packages/vimma-core/test/updates.test.mjs),
  [`update_command_opens_the_steps`](../tests/browser/browser_vimma_update_check.js)
- UP9. The security update question (`Show the update command? (y/N)`) is **never** answered by
  a key pressed before it armed: keys count only `security.dialog_enable_delay` (1,000 ms) after
  it appears or after its window comes to the front or leaves it, an earlier key starts the
  delay again, and a held key never answers. It **never** takes focus, **never** opens while
  focus is in a field, while another Vimma overlay, the agent question or a Firefox permission
  prompt is open, in hint, copy or element mode, or in a private window; a key that arrives
  while focus is in a field or a page is in DOM full screen is **never** taken as an answer; and `y` **only** opens about:vimma's Updates section: nothing is installed or
  run. The one-time message is a notice that takes no focus and no keys.
  [`a_security_update_asks_once_per_session`](../tests/browser/browser_vimma_update_notices.js),
  [`early_and_held_keys_never_answer`](../tests/browser/browser_vimma_update_notices.js),
  [`another_window_in_front_arms_it_again`](../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_for_an_open_overlay`](../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_for_copy_mode`](../tests/browser/browser_vimma_update_notices.js),
  [`y_shows_the_update_steps_and_esc_dismisses`](../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_while_the_user_types`](../tests/browser/browser_vimma_update_notices.js),
  [`no_question_in_a_private_window`](../tests/browser/browser_vimma_update_notices.js),
  [`a_new_version_is_announced_once`](../tests/browser/browser_vimma_update_notices.js),
  [`y or Y shows the steps; n, Esc, Enter and any other key dismiss`](../packages/vimma-core/test/update-notices.test.mjs)

- UP10. The AppImage **only** replaces its own file (`$APPIMAGE`) with a download whose size
  and SHA-512 match a manifest verified by a check in the running process (an offer restored
  from the saved result, the pref `vimma.update.last`, waits for a check), checked on the file as written to disk, after every
  write is synced, and before the rename; anything else leaves the file as it was and removes
  the download. It replaces nothing unless its GRE directory carries the
  `vimma-package=appimage` marker and lies inside `$APPDIR`, so a program started from another
  AppImage, which inherits that AppImage's `$APPIMAGE`, never overwrites it. Outside automation
  the download **must** come from `https://github.com/vimma-browser/vimma/releases/download/`
  (path segments only), so a leaked manifest key alone cannot point installs at a file of its
  own. The download is anonymous (no cookies, no referrer, an empty `Accept-Language`), follows
  GitHub's redirect to its asset host but must end on https, stops past the signed size or after
  60 seconds without data or after 6 hours, and is written to a hidden file in the same
  directory whose name no other file has, created by this process alone, so a second Vimma
  never writes into it or removes it; part files left by a killed run are removed after a day.
  A symbolic link at `$APPIMAGE` is refused. The file is made `0755` and renamed over
  `$APPIMAGE`; the running Vimma keeps its mounted image, and nothing restarts it. Checks off
  (UP4) download nothing, and turning them off stops a download under way. **⚠ limit:** the manifest's hash is the AppImage's only signature: an
  AppImage carries no MAR signature the way Firefox's updater checks one, so a leaked primary key
  together with any release asset of the project (an older AppImage included) can install that
  asset; the replay and downgrade rules (UP2) compare the manifest's versions, not the file's.
  [`a_newer_appimage_replaces_the_file`](../tests/browser/browser_vimma_update_appimage.js),
  [`a_wrong_hash_leaves_the_file_alone`](../tests/browser/browser_vimma_update_appimage.js),
  [`a_larger_download_than_signed_is_refused`](../tests/browser/browser_vimma_update_appimage.js),
  [`an_unwritable_directory_falls_back_to_the_steps`](../tests/browser/browser_vimma_update_appimage.js),
  [`another_install_type_never_touches_appimage`](../tests/browser/browser_vimma_update_appimage.js),
  [`checks_off_never_downloads`](../tests/browser/browser_vimma_update_appimage.js),
  [`a_saved_offer_is_installed_only_after_a_check`](../tests/browser/browser_vimma_update_appimage.js),
  [`another_downloads_part_file_neither_blocks_nor_is_removed`](../tests/browser/browser_vimma_update_appimage.js),
  [`a_symlinked_appimage_is_not_replaced`](../tests/browser/browser_vimma_update_appimage.js),
  [`without the AppDir's own appimage marker, $APPIMAGE is never replaced`](../packages/vimma-core/test/appimage-update.test.mjs),
  [`a Vimma that does not run from $APPDIR is not the AppImage $APPIMAGE names`](../packages/vimma-core/test/appimage-update.test.mjs),
  [`a download from %s is refused outside automation`](../packages/vimma-core/test/appimage-update.test.mjs),
  [`another size or hash: refused, with the reason`](../packages/vimma-core/test/appimage-update.test.mjs)

- UP11. Vimma **never** restarts by itself: only `:restart` (action `app.restart`), `y` in the
  restart question, or Firefox's own restart commands do. The restart question
  (`Security update 0.3.1 is ready. Restart now? Tabs come back. (y/N)`) is asked **only** for a
  security release that is already in place (an AppImage that replaced its file, or a tarball
  whose update Firefox's updater will apply at the next start), once per session and again 24
  hours after an answer, and arms, waits and refuses keys exactly as the question of UP9. It
  **never** hides a loss: while the private workspace has tabs it says they will close, and when
  session restore will bring no tab back it says `Tabs will not come back`;
  a loss that appears while the line is open (a private tab opened since) makes `y` ask
  `:restart`'s `y/N` before anything restarts. `:restart` asks that `y/N` first whenever tabs
  would be lost. A restart asks Firefox's `quit-application-requested` observers with
  `restart`, and a page's beforeunload can still keep its window, which cancels it. Every install
  but the AppImage restarts through Firefox (`eAttemptQuit | eRestart`). The AppImage restarts
  only when its install type is the AppImage (UP10's marker rule) and `$APPIMAGE` is an absolute
  path to an executable file: it quits, and **only** in `quit-application`, once no window can
  refuse, it starts the relaunch script of C2 on its own process id, with the profile and its
  local directory in `XRE_PROFILE_PATH` and `XRE_PROFILE_LOCAL_PATH` as Firefox's restart passes
  them; a quit that a window refused starts nothing. The script gives up after 120 seconds and
  then starts nothing, so a process id reused by another program never keeps it waiting for
  long. **⚠ limit:** an AppImage's restart is a quit and a new start: with history cleared on
  close (`privacy.sanitize.sanitizeOnShutdown`), the session is purged and no tab comes back,
  where Firefox's restart keeps it (the question and `:restart` say so first); the new process
  gets none of the old one's command-line arguments; and when Vimma runs as a systemd service
  unit, not a scope, systemd may stop the script with the unit, so nothing starts.
  [`an_appimage_quits_and_starts_its_file_again`](../tests/browser/browser_vimma_restart.js),
  [`a_refused_quit_starts_nothing_and_leaves_the_session_as_it_was`](../tests/browser/browser_vimma_restart.js),
  [`a_cancelled_request_quits_nothing`](../tests/browser/browser_vimma_restart.js),
  [`a_tarball_restarts_through_firefox`](../tests/browser/browser_vimma_restart.js),
  [`an_appimage_whose_file_cannot_run_restarts_through_firefox`](../tests/browser/browser_vimma_restart.js),
  [`private_tabs_ask_before_they_close`](../tests/browser/browser_vimma_restart.js),
  [`a_replaced_security_update_asks_to_restart`](../tests/browser/browser_vimma_update_appimage.js),
  [`a_staged_security_update_asks_to_restart`](../tests/browser/browser_vimma_update_verify.js),
  [`an_ordinary_replaced_update_asks_nothing`](../tests/browser/browser_vimma_update_appimage.js),
  [`answered in this session: asked again 24 hours later, not sooner`](../packages/vimma-core/test/update-notices.test.mjs),
  [`the_restart_question_says_what_a_restart_loses`](../tests/browser/browser_vimma_update_appimage.js),
  [`history_cleared_on_close_asks_before_an_appimage_restart`](../tests/browser/browser_vimma_restart.js),
  [`history cleared on close: an AppImage's restart is a quit, so the session is purged`](../packages/vimma-core/test/restart.test.mjs),
  [`an AppImage without a usable $APPIMAGE falls back to Firefox's restart`](../packages/vimma-core/test/restart.test.mjs),
  [`gives up after RELAUNCH_WAIT_S when the old process never exits`](../packages/vimma-core/test/restart.test.mjs)
- UP12. Firefox's updater is built **only** with `VIMMA_UPDATES=1` (the release and nightly
  jobs; source and dev builds keep `--disable-updater`), **only** for the update channel
  `vimma`, and such a binary **only** asks `updates.vimma.dev` and **only** applies a MAR signed
  by a key whose certificate Vimma commits (`configs/updater/`, which `npm run import` links to
  `engine/toolkit/mozapps/update/updater/vimma/` where `moz-build.patch` reads it; ADR-016). It
  **never** trusts Mozilla's keys, test-signing keys (`dep1.der`, `dep2.der`, whose
  private halves are public) included: the mozconfig stops the build when either of Vimma's
  certificates is missing or empty in the engine (a dangling link counts as missing) or differs
  from the committed one, the import refuses to link a missing, empty or symlinked one, and `moz-build.patch` stops it on any other channel, since every
  other channel embeds Mozilla's. The manifest check's pinned keys (UP1) are generated from the
  same certificates, so the two verifiers trust the same keys, and a certificate that is not
  self-signed by its own key is refused. The primary's certificate is made from the request
  `update-cert.mjs` builds for the pinned primary key; only `--any-key`, for throwaway test
  keys, takes another. `check-build.mjs` checks a package (the URL, both channel files, and
  that its `updater` carries Vimma's certificates and none of Mozilla's): `release.yml`'s
  `package` job on the release tarball, and `nightly.yml` on its tarball once it is set to the
  `vimma-nightly` channel (UP14). Firefox's check runs Vimma's verifier first (UP13).
  **⚠ limit:** Artifact builds (ADR-010) run Mozilla's prebuilt updater, which trusts only
  Mozilla's keys, and keep `aus5.mozilla.org`; they are never shipped.
  [`is not built without VIMMA_UPDATES (source and dev builds)`](../tools/test/mozconfig-updater.test.mjs),
  [`refuses VIMMA_UPDATES=1 without Vimma's certificates, so no updater trusts Mozilla's test keys`](../tools/test/mozconfig-updater.test.mjs),
  [`refuses any other value of VIMMA_UPDATES rather than guessing`](../tools/test/mozconfig-updater.test.mjs),
  [`links both certificates into the engine and ignores them in its git`](../tools/import/test/link-update-certs.test.mjs),
  [`refuses a repository without a certificate, so no import leaves a half-set behind`](../tools/import/test/link-update-certs.test.mjs),
  [`refuses a certificate that is a link, which could lead to any file on the machine`](../tools/import/test/link-update-certs.test.mjs),
  [`refuses VIMMA_UPDATES=1 when a certificate in the engine is not the committed one`](../tools/test/mozconfig-updater.test.mjs),
  [`fails when the updater lacks Vimma's certificate or carries one of Mozilla's`](../tools/update/test/check-build.test.mjs),
  [`fails without the [AppUpdate] URL or with another host`](../tools/update/test/check-build.test.mjs),
  [`the repository: update-keys.mjs is what the committed certificates give`](../tools/update/test/gen-update-keys.test.mjs),
  [`pins the primary once when the secondary slot holds the primary again (decision 39)`](../tools/update/test/gen-update-keys.test.mjs),
  [`refuses a signature that is not the key's own over this request`](../tools/update/test/update-cert.test.mjs),
  [`refuses a certificate whose self-signature does not verify`](../tools/update/test/gen-update-keys.test.mjs),
  [`fails when --mozilla-certs lacks Mozilla's certificates, rather than comparing nothing`](../tools/update/test/check-build.test.mjs),
  [`CLI: request, then assemble with a KMS signature, refusing a key other than the pinned primary`](../tools/update/test/update-cert.test.mjs),
  [`package checks the release tarball's updater, whether or not updates are on`](../tools/update/test/pipeline-workflows.test.mjs),
  [`packages for the nightly channel and checks the updater before the upload`](../tools/update/test/pipeline-workflows.test.mjs),
  [`rewrites both channel files, and nothing else in them`](../tools/update/test/channel.test.mjs)

- UP13. Firefox's update check **never** hands Firefox's update parser (`#parseUpdates`) or its
  choice of an update a manifest that Vimma's rules (UP1, UP2) have not accepted:
  `UpdateService-sys-mjs.patch` (ADR-003) runs Vimma's verifier on the answer first, a refused
  manifest fails the check as a malformed file does, a manifest that offers nothing newer makes
  Firefox offer nothing, and a prefixed element name (which Firefox would read by its local name)
  is refused. While checks are off or held (but for `:update`, only for its own check), in a
  build run from its objdir (UP4), and until Vimma knows the install type and has read
  `config.toml`, the check ends as not allowed before any request. Its
  request is anonymous, with an empty `Accept-Language`, follows no redirect (UP3), asks for the
  file uncompressed and is **never** decoded, so a compressed answer fails the signature, and it
  is cancelled past 256 KiB (UP5). A manifest offers at most one MAR, a complete one on https.
  The MAR's download **never** carries cookies (spec decision 1): requests from chrome with no
  browsing context to the URL the verified manifest named (compared as Necko writes it), and to
  the URLs its anonymous requests are redirected to until the download ends, go without them;
  any other request is left as it is. The MAR's own signature is the
  updater's check (UP12). On a tarball Firefox's updater updates, Vimma's own fetch stays off,
  so one check runs, and `:update` starts Firefox's.
  **⚠ limit:** XMLHttpRequest reports progress about every 50 ms, so beyond the cap the parent
  holds at most what arrives in one such interval before the request is cancelled. Firefox's
  timer, not Vimma's, decides when a tarball checks (`app.update.interval`, 12 hours). Turning
  checks off stops later checks, not a download Firefox already started for a verified offer.
  XMLHttpRequest builds its XML document from the answer before the verifier runs, as Firefox
  without Vimma does.
  [`a_signed_newer_build_is_offered_and_the_request_is_anonymous`](../tests/browser/browser_vimma_update_verify.js),
  [`a_manifest_failing_the_rules_never_reaches_firefox`](../tests/browser/browser_vimma_update_verify.js),
  [`a_replay_is_refused_and_a_downgrade_offers_nothing`](../tests/browser/browser_vimma_update_verify.js),
  [`checks_off_send_no_request`](../tests/browser/browser_vimma_update_verify.js),
  [`an_oversized_or_compressed_body_is_refused`](../tests/browser/browser_vimma_update_verify.js),
  [`the_mar_download_goes_without_cookies`](../tests/browser/browser_vimma_update_verify.js),
  [`a_real_download_is_shown_on_restart`](../tests/browser/browser_vimma_update_verify.js),
  [`no_check_before_the_install_type_is_known`](../tests/browser/browser_vimma_update_verify.js),
  [`update_checks_a_tarball_through_firefoxs_updater`](../tests/browser/browser_vimma_update_verify.js),
  [`refuses two <patch> elements, so Firefox can pick no MAR the download rule misses`](../packages/vimma-core/test/updates.test.mjs)

- UP14. A complete MAR is **only** signed by `update-publish.yml`'s `mar-sign` job, which
  `release.yml` or `nightly.yml` run from `main` calls (`workflow_call`), and **only** for that
  caller's own MAR on that caller's channel: a release's MAR on `vimma`, and a nightly build's on
  `vimma-nightly` only while `NIGHTLY_RELEASE_ENABLED` is `true` (B8). The caller
  (`github.workflow_ref`) picks the channel and the name the file must have, never an input. A
  called job is the called file's job, so its OIDC token names
  `update-publish.yml` at `refs/heads/main`: the Workload Identity condition on `job_workflow_ref`
  (UP7) admits no new workflow, and the key is reached by no job of `release.yml` or `nightly.yml`
  itself. The job refuses to run unless its caller is `release.yml` or `nightly.yml` at
  `refs/heads/main` and `UPDATES_ENABLED` is `true`, uses the `update-signing` environment
  (deployment branch `main` alone), holds only `id-token: write` and runs no repository code. `release.yml`'s calling job
  allows the union of what `update-publish.yml`'s jobs ask for (`actions: write`, `contents: read`,
  `pull-requests: read`, `issues: write`, `id-token: write`), because GitHub refuses a call whose
  jobs, skipped ones included, ask for more than the caller allows; that is a ceiling, and in a call
  no job but `mar-sign` runs (`start` needs the release event, the others no `mar` input). Before
  Cloud KMS signs anything it checks with the shell alone that the file is named as the caller's
  MAR (the tag's for `release.yml`, `vimma-nightly-<buildID>-linux-x86_64.complete.mar` for
  `nightly.yml`), that its size field is its size, that it has exactly one signature entry, 512
  bytes of RSA-PKCS#1 v1.5 with SHA-384 (algorithm 2), all zero, and that its product information
  block names the caller's channel, byte for byte with its NUL. The channel is in the signed
  bytes, so a nightly MAR never installs on a release install, nor a release MAR on a nightly
  install (the updater's error 22). It signs every byte but that placeholder, bytes that start with `MAR1`, while
  a manifest's signed bytes start with `vimma-update-xml-v1\n`, so under the one key (spec decision 12) a MAR signature can never pass as a manifest's or back. It checks KMS's signature with openssl
  and writes in only the signature bytes. The MAR is built in `package`, a job with no secret, from
  the release tarball with the build's own host `mar` and Mozilla's `make_full_update.sh`
  (`tools/update/mar.mjs build`). Then `mar`, a job with no secret and a read-only token, checks
  that the signed MAR differs from the one `package` built only in its signature bytes, that the
  signature verifies under the committed certificates with `mar.mjs` and with Mozilla's `signmar`
  (the updater's own verification code, from this release's build), that its channel is the release
  channel and its product version the build's Firefox version, and that it installs exactly the
  release tarball's files, byte for byte; only then does `SHA256SUMS` list it, so cosign signs it
  with the other assets and `publish` uploads it. While `UPDATES_ENABLED` is `true`, `sign` and
  `publish` **never** run unless `mar` succeeded, so a release never ships without the MAR its
  manifest offers, and `mar` fails when the calling job did not succeed or left no signed MAR (a
  call whose `mar-sign` job was skipped ends as success with no artifact), so the release run fails
  and opens the `release-failure` issue rather than uploading nothing. In a call, the manifest's
  jobs need `update-publish.yml` to be the run's own workflow (`github.workflow_ref`, the caller's
  in a call), and a call has a concurrency group of its own. The manifest offers a MAR (`<patch>`)
  **only** when the release's cosign-signed `SHA256SUMS` lists it, with its size and SHA-512 and at
  the release's own download URL; the manifest's signing job refuses a `<patch>` at any other URL, a
  second one, or one in the macOS manifest, and the publish job downloads the MAR again and checks
  it against the signed manifest. `nightly.yml`'s `mar` job checks a nightly's signed MAR the same
  way, on the channel `vimma-nightly`, before its `SHA256SUMS` lists it (B8); without
  `NIGHTLY_RELEASE_ENABLED` the nightly builds its MAR as a check and keeps none
  ([m6a-updater](specs/m6a-updater.md), decision 42). Both workflows' build jobs pack the MAR
  tools the `mar` job runs (`signmar`, the NSS libraries of the objdir it loads, the host `mar`)
  with one script, `tools/update/mar-tools.mjs`, which fails the build, before anything is
  uploaded, unless `signmar` and `mar` start from the packed directory with every library of
  the objdir that ldd lists found there; a pack that missed a library would otherwise surface only in `mar`, after
  `mar-sign` had signed. It runs the build's own tools only in the build job, which built them and
  already runs the build's code, after the Safe Browsing key file is deleted; no other job that
  holds a secret runs them.
  **⚠ limit:** the key signs what the build job built: a compromised build (it compiles Firefox with
  the Safe Browsing key in reach) can produce a malicious MAR that `mar-sign` then signs, as it can
  produce a malicious tarball that cosign signs; it cannot copy the key out, and every signature is
  in Cloud KMS's audit log. A signed MAR is kept 7 days as a workflow artifact of the release run,
  which any signed-in GitHub user can download before the release is published; an install applies
  it only when a manifest signed by the same key offers it. Firefox's updater refuses a MAR only
  when its Firefox version is older, so a signed MAR of an older Vimma on the same Firefox would
  apply; what keeps installs from it is the manifest's serial and downgrade rules (UP2) and its
  SHA-512 pin of the offered MAR.
  **⚠ setting:** as UP7, the `update-signing` environment's branch rule and the Workload Identity
  condition keep other branches and workflows from the key; `github.workflow_ref` only keeps another
  workflow on `main` from calling `mar-sign`. Since any repository's workflow can call
  `update-publish.yml@main` and its token then names that file too, the condition's
  `assertion.repository` clause and the IAM member's subject, which names the repository by its ID,
  **must** never be dropped.
  [`is called by release.yml and nightly.yml alone, and mar-sign signs only for those two`](../tools/update/test/update-workflow.test.mjs),
  [`only sign, mar-sign and nightly-sign mint an OIDC token or name the signing environment`](../tools/update/test/update-workflow.test.mjs),
  [`signs a nightly's MAR for nightly.yml on main, on the nightly channel`](../tools/update/test/update-workflow.test.mjs),
  [`the MAR is signed by update-publish.yml's mar-sign, with this run's MAR`](../tools/test/nightly-workflow.test.mjs),
  [`the mar job checks the signed MAR for the nightly channel, against the tarball`](../tools/test/nightly-workflow.test.mjs),
  [`the mar job fails, loudly, when the MAR was not signed`](../tools/test/nightly-workflow.test.mjs),
  [`the signing job %s runs no repository code: no checkout, no node, no npm`](../tools/update/test/update-workflow.test.mjs),
  [`signs the placeholder so that the updater's check accepts it under the KMS key`](../tools/update/test/update-workflow.test.mjs),
  [`refuses to sign %s`](../tools/update/test/update-workflow.test.mjs),
  [`refuses a <patch> %s`](../tools/update/test/update-workflow.test.mjs),
  [`refuses a <patch> in the macOS manifest`](../tools/update/test/update-workflow.test.mjs),
  [`downloads the MAR SHA256SUMS lists, and the one the signed manifest offers`](../tools/update/test/update-workflow.test.mjs),
  [`writes signmar's layout byte for byte, with the signature zeroed`](../tools/update/test/mar.test.mjs),
  [`signmar's signature verifies over the bytes around the placeholder`](../tools/update/test/mar.test.mjs),
  [`the signed bytes start with the MAR ID, so no manifest signature can pass as a MAR's`](../tools/update/test/mar.test.mjs),
  [`accepts a MAR signed the way the KMS key signs, and refuses one byte changed`](../tools/update/test/mar.test.mjs),
  [`refuses a MAR no given key signed`](../tools/update/test/mar.test.mjs),
  [`mar-sign calls update-publish.yml, the one workflow the key signs for`](../tools/update/test/pipeline-workflows.test.mjs),
  [`mar-sign's permissions are the ceiling update-publish.yml's jobs need, no more`](../tools/update/test/pipeline-workflows.test.mjs),
  [`mar fails, loudly, when the MAR was not signed, so a release never stops silently`](../tools/update/test/pipeline-workflows.test.mjs),
  [`%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run`](../tools/update/test/update-workflow.test.mjs),
  [`mar checks the signed MAR with no secret: same content, the certificates, signmar`](../tools/update/test/pipeline-workflows.test.mjs),
  [`packs with the script release.yml uses, on every nightly`](../tools/test/nightly-workflow.test.mjs),
  [`packs after the key file is gone, before the MAR is built and anything is uploaded`](../tools/test/nightly-workflow.test.mjs),
  [`packs signmar's libraries from a relative objdir, which ldd names by absolute path`](../tools/update/test/mar-tools.test.mjs),
  [`fails, naming it, when a library signmar loads is missing`](../tools/update/test/mar-tools.test.mjs),
  [`cosign signs the MAR with the other assets, after it is checked`](../tools/update/test/pipeline-workflows.test.mjs),
  [`publish uploads the MAR and the new SHA256SUMS, never a release that lost its MAR`](../tools/update/test/pipeline-workflows.test.mjs),
  [`runs the release's MAR step for the nightly channel, and keeps it only for a public nightly`](../tools/update/test/pipeline-workflows.test.mjs),
  [`prepareRelease offers the MAR SHA256SUMS lists, with its size and SHA-512`](../tools/update/test/manifest.test.mjs),
  [`checkSigned checks the MAR the manifest offers against the downloaded file`](../tools/update/test/manifest.test.mjs),
  [`checkSigned refuses a <patch> at any URL but the release's MAR`](../tools/update/test/manifest.test.mjs)

**Key custody** (spec §6, decisions 16 and 17): the primary manifest key is a non-exportable
Google Cloud KMS key that only `update-publish.yml`'s signing jobs on `main`, in the `update-signing` environment, can
ask to sign, through GitHub OIDC: `sign` and `nightly-sign` for manifests (UP7) and `mar-sign`, called by `release.yml` and `nightly.yml`, for MARs (UP14); the secondary is to be generated and kept offline by the maintainer (not made yet). Their
setup is in [runbook.md](runbook.md#update-signing-keys-and-the-update-host-spec-m6a-updater).
The primary's public key is pinned in `update-keys.mjs` (its SHA-256 is recorded in the runbook
and checked by
[`the shipped primary: exactly one, RSA-4096, the recorded key, verifies RSASSA-PKCS1-v1_5 SHA-384`](../packages/vimma-core/test/updates.test.mjs));
the secondary is pinned in a later release, an ordinary one whose manifest the primary signs.
Firefox's updater embeds the same keys as self-signed certificates, the secondary slot holding the
primary's again until then (decision 39; runbook step 5b, UP12).
Until then a lost or leaked primary cannot be replaced through the update check: installs keep
trusting it until they are updated by hand. A leaked primary can announce a version that does
not exist and link its details page anywhere over https, but the commands about:vimma shows
still name only the project's own release downloads (UP5), and only the AppImage installs
anything, and only a release asset of the project (UP10).
It can also mark such an offer as a security release, and hold back genuine manifests for up to a
day by signing a serial ahead of the clock (UP2).

## 17. Site compatibility workflow (`sites.yml`, `tools/sites`)

Spec: [site-compat](specs/site-compat.md), decisions 1, 11 and 12, and its snapshot layer (SC5). Every night a hosted runner
loads about 25 live websites in an artifact build, compares the results with the previous
scheduled run and keeps one issue labelled `site-compat` up to date. Who can reach it: the
_pages_ it loads, which choose their titles, their text, where they redirect and what the checks
report about them, and so choose text that ends up in a GitHub issue. Nobody else: the workflow
runs on `schedule` and `workflow_dispatch` only, never on a pull request.

- SC1. The job that runs the browser on live pages holds **only** `contents: read`, and no step
  of it keeps or exports a token (checkout uses its read-only token and does not persist it); the workflow reads no secret, and the top-level permissions are empty. The
  diff and the issue text are made by a second job, on a fresh runner, from that job's
  `results.json` alone, with read permissions only (`actions` for the artifacts, `issues` to
  find the open issue), so code that escaped the browser onto its runner could not rewrite the
  issue text. The suite's step turns workflow commands off while it logs page text, so a page
  cannot add annotations or masks to the run.
  [`the browser job only reads the repository, and holds no token in any step`](../tools/test/sites-workflow.test.mjs),
  [`the compare job only reads, and works from the browser job's results.json alone`](../tools/test/sites-workflow.test.mjs),
  [`stops workflow commands while the suite logs page text`](../tools/test/sites-workflow.test.mjs),
  [`has no secrets, and no permission at the top level`](../tools/test/sites-workflow.test.mjs),
  [`runs nightly and by hand, never on a pull request or a push`](../tools/test/sites-workflow.test.mjs)
- SC2. `issues: write` is **only** in the report job, which checks out nothing and runs no
  repository code: it runs `gh` on the `issue.md` the compare job wrote, passed as `--body-file`.
  The action and issue number reach its script through `env`, never through an expression in the
  script, and the number must be digits.
  The report job downloads the compare job's own upload by its artifact id, and runs only when
  that job succeeded, so an artifact of the same name uploaded from the browser job's runner is
  never the one posted.
  [`issues: write is only in the report job, which checks out and runs no repository code`](../tools/test/sites-workflow.test.mjs),
  [`the report job takes the compare job's own upload, by id, only after it succeeded`](../tools/test/sites-workflow.test.mjs)
- SC3. Text from a page or a check (titles, failure reasons) **never** reaches the issue body
  outside an inline code span, so GitHub renders no mention, issue or commit reference, link,
  image or HTML from it. Each value is put on one line with control and format characters
  (bidirectional overrides among them) replaced, cut to 160 characters, and fenced with more
  backticks than it contains. Lists stop at 50 entries and the body at 60 000 characters. The run
  link is written only when it is a GitHub Actions run URL, and the baseline's commit only when
  it is hexadecimal.
  [`puts no untrusted text outside a code span`](../tools/sites/test/diff.test.ts),
  [`wraps text in a code span, where GitHub renders no mention, reference, link or HTML`](../tools/sites/test/diff.test.ts),
  [`picks a fence longer than any run of backticks inside, padded at a backtick edge`](../tools/sites/test/diff.test.ts),
  [`puts everything on one line: newlines, control and bidirectional characters`](../tools/sites/test/diff.test.ts),
  [`cuts to MAX_TEXT characters, and says when it is empty`](../tools/sites/test/diff.test.ts),
  [`caps the list and the body`](../tools/sites/test/diff.test.ts),
  [`drops a run URL that is not GitHub's`](../tools/sites/test/diff.test.ts)
- SC4. The previous run's `results.json` and `diff.json` are used **only** when they have the
  expected shape: site ids of lowercase letters, digits and dashes, statuses and check ids from
  fixed sets, strings where strings belong. Anything else is reported and compared as no
  baseline, so a damaged artifact cannot inject names or open an issue. Site names come from the
  repository's `sites.json`, whose test forbids anything GitHub would turn into a mention,
  reference or link.
  [`names nothing GitHub would turn into a mention, reference or link`](../tools/sites/test/sites-data.test.ts),
  [`rejects a run of the wrong shape, unknown statuses and check ids, and odd site ids`](../tools/sites/test/diff.test.ts),
  [`round-trips the tracked list through diff.json, and rejects one of the wrong shape`](../tools/sites/test/diff.test.ts),
  [`reports no baseline when the previous artifact is missing or malformed`](../tools/sites/test/compare.test.ts)
- SC5. The **snapshot gate** (`npm run sites -- --offline`, run by e2e.yml on every pull request)
  loads only the files in `tests/e2e/fixtures/sites/`, from a page server on 127.0.0.1, and never
  a live site: no other mode of the suite runs in e2e.yml. Each snapshot is third-party page
  content, recorded once and committed, so a test holds every file to the recorder's guarantees:
  it starts with a Content-Security-Policy that lets nothing run or load (`default-src 'none'`,
  inline styles only), and holds no script, event handler, frame, image or other embedded
  content, no URL attribute, no `url()`, `@import` or `image-set()` in a style, and no link but a
  fragment or the local `followed.html`. The checker reads markup where the browser's parser
  could read text (inside `<svg>`, after an abrupt comment end), never the reverse, and decodes
  CSS escapes and comments first. It is a backstop of what the recorder removes, not the only
  barrier: the policy blocks anything it might miss, and the offline profile sends every host
  but 127.0.0.1 to a proxy port where nothing listens, with WebRTC off. A pull request can change
  the checker and its tests as well as the snapshots, so the review of that pull request is the
  control; what such a change could reach is the job below. Only pages whose licence allows a copy are recorded
  (`--record` refuses any other id), and a new or changed snapshot is reviewed in its pull
  request like code. The step runs in the mochitest job (`contents: read`, no secret); its report
  and screenshots, which show only committed snapshots, are uploaded as an artifact when it
  fails, and nothing from it reaches an issue.
  [`rejects scripts and every element that loads or embeds something`](../tools/sites/test/snapshot.test.ts),
  [`rejects event handlers however they are written`](../tools/sites/test/snapshot.test.ts),
  [`allows only fragment links and the follow target as href`](../tools/sites/test/snapshot.test.ts),
  [`rejects every other attribute that names a URL`](../tools/sites/test/snapshot.test.ts),
  [`rejects url(), @import and image-set() in styles`](../tools/sites/test/snapshot.test.ts),
  [`wants the doctype, and the CSP as the first thing in <head>`](../tools/sites/test/snapshot.test.ts),
  [`ends a comment where the parser does: <!-->, <!--->, --!>`](../tools/sites/test/snapshot.test.ts),
  [`reads markup inside raw-text elements too, as in <svg>, where they are not raw`](../tools/sites/test/snapshot.test.ts),
  [`reads CSS escapes and comments before looking for loads`](../tools/sites/test/snapshot.test.ts),
  [`each have a manifest entry with a licence that allows redistribution`](../tools/sites/test/snapshot.test.ts),
  [`runs the suite only offline, after the e2e scenarios, on the artifact build`](../tools/test/sites-workflow.test.mjs)

## 18. Release download counts workflow (`downloads.yml`, `tools/stats`)

Runbook: "Release download counts". Once a day a hosted runner reads every published release
asset's `download_count` and appends it to `downloads.csv` on the `stats` branch, an orphan
branch outside `main`'s history. It is the only workflow whose own job token pushes commits, so
these rules keep that token away from `main` and from code. Who can reach it: anyone with write
access, who can change the workflow or `tools/stats` on a branch of their own; the data it reads
(asset names and counts of our own releases) comes from GitHub's API. It runs on `schedule` and
`workflow_dispatch` only, never on a pull request or a push. A manual run can name any branch,
so both jobs **refuse** to run unless the run is in this repository and on `main`: a manual run
from another branch whose copy of the workflow is unchanged refuses, so that branch's
`tools/stats` never runs with the write token. The guard lives in each branch's own copy of the
file, so it binds only an unchanged copy. **⚠ limit:**
anyone with write access can run a changed workflow from their own ref (`gh workflow run
--ref`, or a workflow of their own `on: push`) and get a `contents: write` job token. That token
can write any branch but `main`, which its ruleset refuses, and create, move or delete any tag.
This is the same reach as pushing a branch (B11, B15, UP7), and nothing in this file can narrow
it: the mitigations sit outside it, as rulesets for tags and for `stats`, or a GitHub App or
deploy key that may write `stats` alone in place of the job token.
[`runs once a day and by hand, never on a pull request or a push`](../tools/test/downloads-workflow.test.mjs),
[`both jobs run only in this repository from main; record only after collect succeeded`](../tools/test/downloads-workflow.test.mjs)

- DC1. The workflow holds **no** secret: only the job token, with nothing granted at the top
  level. The `collect` job, which runs repository code, holds **only** `contents: read` and does
  not keep its checkout's credentials. Traffic (views, clones, referrers) is therefore not
  recorded: its API needs the Administration permission, which a job token cannot be given, and
  recording it would mean the workflow's first stored secret. Before the script, `collect` sets up
  `.nvmrc`'s Node with `actions/setup-node`, pinned by commit SHA, with no cache and
  `package-manager-cache: false` (otherwise a `packageManager` field naming npm in `package.json`
  would turn on caching by itself), so the script never runs on the runner image's own Node,
  whose version this repository does not choose (ADR-025); the action runs with the same
  read-only token.
  [`grants nothing by default; reads in collect, writes contents only in record`](../tools/test/downloads-workflow.test.mjs),
  [`every job sets up Node before it runs node, npm or npx, but the listed ones`](../tools/test/runner-node.test.ts),
  [`a setup-node before a guard or a token-holding tool never caches by itself`](../tools/test/runner-node.test.ts),
  [`collect runs the script without a stored credential`](../tools/test/downloads-workflow.test.mjs),
  [`stays tiny: no npm install, short timeouts, no secret, runs in order`](../tools/test/downloads-workflow.test.mjs)
- DC2. `contents: write` is **only** in the `record` job, which checks out the `stats` branch,
  runs no repository code (no `node`, no `npm`), and pushes **only** the fixed refspec
  `HEAD:stats`: the workflow has one `git push`. The token itself could write any branch and
  create, move or delete any tag, so in this workflow those limits rest on the job's code, and
  on a changed copy of the workflow they do not hold at all (the limit above). `main` rests on
  its ruleset: it requires a pull request and has no bypass actor, so a push by the job token is
  refused. Tags and the `stats` branch have no ruleset unless the
  maintainer adds one (runbook, "Where it can push").
  [`record runs no repository code and pushes only to the stats branch`](../tools/test/downloads-workflow.test.mjs)
- DC3. The history is **append-only**: `record` refuses a new `downloads.csv` that does not begin
  byte for byte with the one on `stats`, and runs only after `collect` succeeded, from that run's
  own artifact. A failed fetch of the history fails the run rather than starting a new one.
  [`record only appends: the new file must begin with the recorded history`](../tools/test/downloads-workflow.test.mjs)
- DC4. Every action is pinned by a full commit SHA.
  [`every action it uses is pinned by a full commit SHA`](../tools/test/downloads-workflow.test.mjs)

## 19. Site permissions (`host/permission-ops.mjs`)

`:site` (or `:permissions`) opens a picker over the selected tab's site permissions, where `a`,
`b`, `r` and `Enter` allow, block, reset or step a permission for that site. It changes what a
site may do (camera, microphone, location, notifications), so these rules keep it to the page
you meant and to Firefox's own rules. Spec: [site-permissions](specs/site-permissions.md).

**Reach:** only you, with `:site` or a key you bind (it has no default key). No control-socket or
MCP command reaches it, and an agent's keys are a fixed list without it (S7, M16), so neither
`vimma-ctl`'s agent role nor an agent can open it. A `full`-role connection holds your token and
can type `:site` as your keyboard can (§1). It reads only the selected page's permissions,
which Firefox's site information panel shows already, and stores nothing of its own.

- SP1. It **must** refuse in the agent workspace: `:site`, and every key while it is open,
  check the selected tab's container and its page's principal, and refuse when either is the
  agent workspace's, so a permission is never given to a page an agent drives. A picker open
  on another tab closes when an agent's tab is selected.
  [`test_the_agent_workspace_refuses_and_grants_nothing`](../tests/browser/browser_vimma_site_permissions.js)
- SP2. It **must** act only on the page it was opened for: every key checks that the selected
  tab is the one it opened in and that its principal is the one it listed, and closes the picker
  otherwise; selecting another tab closes it. A page without site permissions (`about:` pages)
  gets no picker.
  [`test_acts_only_on_the_page_it_was_opened_for`](../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_page_without_site_permissions_says_so`](../tests/browser/browser_vimma_site_permissions.js)
- SP3. Each row **must** show the state Firefox has for the site, read from `SitePermissions`
  with the tab's browser (temporary and globally blocked permissions included), and the row
  **must** show the new state after a change.
  [`test_lists_every_permission_with_its_real_state`](../tests/browser/browser_vimma_site_permissions.js),
  [`test_keys_change_it_through_firefox_and_the_row_follows`](../tests/browser/browser_vimma_site_permissions.js),
  [`one row per permission, by Firefox's label, with its real state`](../packages/vimma-core/test/sitepermissions.test.mjs)
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
  [`changes a site permission only from the site permissions picker`](../tools/security/test/chrome-source.test.ts),
  [`test_popups_can_be_allowed_blocked_and_reset`](../tests/browser/browser_vimma_site_permissions.js),
  [`test_site_and_popups_share_one_popup_permission`](../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_private_window_keeps_a_popup_block_for_its_session`](../tests/browser/browser_vimma_site_permissions.js),
  [`a state Firefox does not offer for the permission is refused`](../packages/vimma-core/test/sitepermissions.test.mjs),
  [`a locked row changes nothing`](../packages/vimma-core/test/sitepermissions.test.mjs),
  [`test_a_state_firefox_does_not_offer_is_refused`](../tests/browser/browser_vimma_site_permissions.js),
  [`test_a_locked_default_makes_the_row_read_only`](../tests/browser/browser_vimma_site_permissions.js)
- SP5. No control, MCP or agent code **must** reach it: nothing under `ctl/` or `agent/` imports
  the picker's ops, and the agent's keys are the spec's fixed list.
  [`changes a site permission only from the site permissions picker`](../tools/security/test/chrome-source.test.ts),
  [`the whitelist is the spec's table`](../packages/vimma-core/test/agent-keys.test.mjs)

## 20. The PDF viewer (`actors/pdf-view.mjs`, `host/pdf-ops.mjs`, `host/outline-ops.mjs`)

Vimma drives Firefox's pdf.js viewer through its content actor: it reads the page, page count,
page label and find count to show them in the status bar, chooses the PDF viewer's key
bindings, sends the viewer the page, zoom, layout and presentation operations those keys run,
reads the document's outline into a chrome panel (once when a PDF opens in the selected tab, and
on the user's `Tab`), gives the viewer's own toolbar, find bar and menus the theme's colours
through two style sheets, keeps marks (positions in
a document) in the parent's memory, and shows or copies a link's target on `F` and `c`. Spec:
[pdf-mode](specs/pdf-mode.md).

**Reach:** the PDF being viewed, through pdf.js, which a malformed PDF may compromise (pdf.js
parses untrusted files, and CVE-2024-4367 let a PDF run script in the viewer); web pages, which
can define `PDFViewerApplication` or frame a PDF. A compromised viewer is treated as a hostile
page that also controls every pdf.js function and event the adapter touches. A compromised
content process can claim pdf.js's principal for its top document, as it can claim any
principal; that gives it no more than in-bounds status text and the user's own `[modal.pdf]`
bindings, so it is accepted here.

- V1. The adapter **must** waive Xrays only in a top-level document whose principal passes
  `schemeIs("resource")` and `originNoSuffix === "resource://pdf.js"`, Firefox's own test
  (`nsContentUtils::IsPDFJS`), so that it holds in every container; never on the content type,
  the URL or the presence of `window.PDFViewerApplication`.
  [`a_page_that_defines_PDFViewerApplication_gets_no_pdf_keys`](../tests/browser/browser_vimma_pdf_status.js),
  [`pdf_keys_work_in_a_workspace_container`](../tests/browser/browser_vimma_pdf_status.js)
- V2. The parent **must** decide the `pdf` keymap context from the top `WindowGlobalParent`'s
  `documentPrincipal` with the same test, and **must** accept state only from the actor of that
  window global; a pdf.js document in a frame or `<embed>` **must not** set the context or
  report state. A document that only inherits pdf.js's principal (an `about:blank`, `blob:` or
  `data:` page the viewer opens) is not the viewer: the parent also requires an `http`, `https`
  or `file` document URI, which the viewer keeps from the PDF it shows.
  [`a_pdf_in_a_frame_gets_no_pdf_context`](../tests/browser/browser_vimma_pdf_status.js)
- V3. The adapter **must** pass pdf.js only functions made with `Cu.exportFunction`, arrays and
  objects of primitives made with `Cu.cloneInto` into the viewer's window as `PdfJsChild` does (a
  mark's `XYZ` destination and the history and scroll arguments that go with it, an internal
  link's explicit destination read from its fragment), or an outline entry's target
  that pdf.js itself gave it (V8); no chrome object **may** be passed in.
  [`a_hostile_viewer_gets_only_primitives_through`](../tests/browser/browser_vimma_pdf_status.js)
- V4. Exported callbacks **must** read their arguments through Xrays, never waived, and only the
  fields they need; the child **must** keep only values whose `typeof` is `number`, `boolean` or
  `string` before `sendAsyncMessage`, and **must not** `await` a value returned by pdf.js. An
  asynchronous result (the outline, the named destinations, the page of a link's named
  destination) **must** come back only through a
  `Cu.exportFunction` callback passed to the promise's own `then` seen through Xrays, so that a
  viewer's object with a `then` of its own is never called; the result is read by the same rules.
  [`a_hostile_viewer_gets_only_primitives_through`](../tests/browser/browser_vimma_pdf_status.js),
  [`a_hostile_outline_gets_only_primitives_through`](../tests/browser/browser_vimma_pdf_outline.js)
- V5. Bursts of pdf.js callbacks and of chrome-only events (`pagesloaded`, which the viewer can
  fire at will through `FirefoxCom.request("dispatchGlobalEvent")`) **must** be coalesced to at
  most one state message per 100 ms per document.
  [`a_flood_of_pagesloaded_is_coalesced`](../tests/browser/browser_vimma_pdf_status.js)
- V6. The parent **must** parse every state record with `parsePdfState`, which bounds every
  number, drops a page label over 32 characters and strips control and Unicode format characters
  (categories Cc and Cf: bidirectional overrides and isolates, zero-width characters), and the
  status bar **must** draw it as text.
  [`pdf state outside its bounds is dropped`](../packages/vimma-core/test/pdf.test.mjs),
  [`a page label cannot carry bidi or zero-width characters`](../packages/vimma-core/test/pdf.test.mjs)
- V7. The parent **must** send the viewer only operations: a name from `PDF_OPS` and one bounded
  integer, checked by `parsePdfOp` in the parent before sending and again in the child before the
  adapter touches pdf.js; `go` (a mark) also carries a position, exactly four bounded numbers
  (`parsePdfPosition`), which is also how the parent checks the position the viewer reports when a
  mark is set. No script, markup or object **may** go into the viewer, and no CSS text other than
  the theme's token sheet under V12. `F` asks for an
  internal link's page by the hint's generation and index only, and the parent keeps the answer only
  when it is a page of the document. The adapter passes pdf.js only those numbers and its own fixed
  strings (`page-fit`, `page-width`, a mark's `XYZ`, cloned under V3), and measures the page for `H`, `L`, `P` and `ctrl+f` through
  Xrays (the viewer's container and page elements), so none of the viewer's script runs for it. In
  presentation mode the scroll keys (`Vimma:Scroll`) turn pages through the same checked operations,
  and fall back to scrolling when the adapter applied none.
  Accepted: in the PDF viewer `ctrl+o` and `ctrl+i` step to a neighbouring entry of the same
  document without Firefox's user-interaction check (decision 9), so a compromised viewer that
  pushes many same-document entries makes them step through each; a count (`9ctrl+o`) or the
  toolbar's back button still leaves, so it is a nuisance, not a trap.
  [`the parent sends only operations and numbers`](../packages/vimma-core/test/pdf.test.mjs),
  [`the_parent_sends_only_operations_and_numbers`](../tests/browser/browser_vimma_pdf_keys.js),
  [`pdf marks`](../packages/vimma-core/test/pdf.test.mjs),
  [`marks`](../tests/browser/browser_vimma_pdf_marks.js)
- V8. The adapter **must** read the outline only when the parent asks (the `outline` operation):
  for the user's `Tab` in the PDF viewer, and once per document when the viewer reports its first
  state in the selected tab with `[ui] pdf_outline` shown (pdf-mode decision 19). That read is
  keyed by the top window global, never by the viewer's own count of documents, so a viewer cannot
  have it read or shown again by claiming a new document. An outline read that way is shown
  without focus, so it takes no key, only in normal mode, and never over another panel or under a
  picker. Accepted: a PDF's outline titles (at most 512 characters each) show in a chrome panel
  without a key press, under the panel's visible `Outline` heading, as page titles show in tabs. The adapter **must** send only each entry's title, level, page number, kind, collapsed flag
  and, for a URL entry, its URL, never a destination; it cuts titles to 512 characters and stops at
  5,000 entries and a depth of 32. The parent **must** take an outline message only from the top
  viewer's current actor after asking that document for it (for `Tab`, opening the panel only if no
  other key was pressed, the tab is still selected and at most 2 s passed; when the PDF opened,
  only if the tab is still selected and in normal mode), and **must** parse it with
  `parsePdfOutline`, which drops the whole message for more than 5,000 entries, a level deeper than
  32 or more than one step below the previous entry's, a title over 512 characters, a URL over
  8,192, a page outside the document, an unknown kind or an unknown field, and strips control and
  format characters (Cc, Cf) from titles. `Enter` names an entry by its index (V7); its destination,
  named action or layer change stays in the child, which hands pdf.js back its own object; a named
  action is followed only when it is one of pdf.js's navigation actions (not `Print` or `SaveAs`).
  The outline panel **must** set titles with `textContent` (§6, C1). A URL entry is opened in the
  tab only when it is `http` or `https` (`outlineUrlAllowed`), after `checkLoadURIWithPrincipal`
  against the viewer's principal, which triggers the load, with no referrer and no fixup, as a link
  chosen with `f` loads; never with the system principal, which would make it look typed and could
  route it to another workspace (§2). pdf.js already gives a `javascript:` link no URL, so such an
  entry follows nothing. A link target from `F` or `c` is shown in the notice or copied as text
  only when it parses as a URL, as the URL parser writes it, without control or format
  characters, and never followed.
  [`the_outline_is_read_only_on_the_users_key`](../tests/browser/browser_vimma_pdf_outline.js),
  [`the_outline_is_shown_when_a_pdf_with_one_opens`](../tests/browser/browser_vimma_pdf_outline.js),
  [`pdf_outline_hidden_keeps_it_closed`](../tests/browser/browser_vimma_pdf_outline.js),
  [`an outline outside its bounds is dropped`](../packages/vimma-core/test/pdfoutline.test.mjs),
  [`each_kind_of_entry`](../tests/browser/browser_vimma_pdf_outline.js),
  [`outlineUrlAllowed`](../packages/vimma-core/test/pdfoutline.test.mjs),
  [`links`](../tests/browser/browser_vimma_pdf_marks.js)
- V9. Presentation mode **may** go full screen without user activation, as Firefox allows the
  pdf.js principal (`dom/base/Element.cpp`); Vimma **must** request it only for the user's own
  key or `:present` command in the PDF viewer, so it adds no spoofing surface: a page cannot
  reach it, the content process cannot ask the parent for it, and Firefox's full-screen warning
  still shows.
  [`presentation_only_on_the_users_key`](../tests/browser/browser_vimma_pdf_keys.js),
  [`presentation`](../tests/browser/browser_vimma_pdf_keys.js)

- V10. Vimma **must not** write any `pdfjs.*` pref other than the defaults
  `pdfjs.featuresNotificationImpressionLimit = 0` and `pdfjs.sidebarViewOnLoad = 0`
  (`firefox-branding.js`; the second only stops pdf.js opening its sidebar by itself), and never
  one that
  changes scripting, fetching or sandboxing (`pdfjs.enableScripting`, `pdfjs.disabled`).
  [`pdf_mode_writes_no_pdfjs_prefs`](../tests/browser/browser_vimma_pdf_status.js)

- V11. The parsed outline **must** stay in the parent's memory, for the tab's current document
  only, and **must** be dropped when the tab navigates or closes, or pdf.js opens another PDF in
  the same viewer (the state message counts the documents the viewer opened); the panel closes
  with it. Marks **must** stay in the parent's memory too, by document URL without its
  fragment, at most 1,000 documents; a private window's marks are kept apart and dropped when
  the last private window closes. Neither is ever written.
  [`the_outline_is_read_only_on_the_users_key`](../tests/browser/browser_vimma_pdf_outline.js),
  [`another_pdf_in_the_same_viewer_drops_the_outline`](../tests/browser/browser_vimma_pdf_outline.js),
  [`a_read_under_way_does_not_outlive_its_document`](../tests/browser/browser_vimma_pdf_outline.js),
  [`private_marks_go_with_the_private_windows`](../tests/browser/browser_vimma_pdf_marks.js)

- V12. The viewer's look (pdf-mode decisions 18 and 20) **must** be CSS only: the child loads, with
  `windowUtils.loadSheetUsingURIString` as author sheets of the viewer's top document (after V1's
  check), the fixed `chrome://browser/skin/vimma/firefox-pdf.css` and a `data:text/css` sheet of
  the theme's tokens; it runs nothing in the viewer, passes pdf.js nothing and reads nothing back.
  The parent **must** send the token sheet only to the actor of the top viewer's current window
  global (V2's test), on that actor's request or on a theme change, and only the stylesheet
  `ThemeHost` built from validated colours (core `themeStylesheet`); the child takes only a string
  of at most 64 KiB. Accepted: script in a compromised viewer can read the theme's colours from its
  own computed style; they are the colours of the user's desktop theme, which any page shown under
  `prefers-color-scheme` already narrows down, and no web page can read the viewer's document
  (another principal).
  [`the_viewer_follows_the_theme`](../tests/browser/browser_vimma_pdf_look.js),
  [`pdfjs_sidebar_stays_closed`](../tests/browser/browser_vimma_pdf_look.js),
  [`the_theme_reaches_only_the_viewer`](../tests/browser/browser_vimma_pdf_look.js)

## 21. Downloads picker (`host/download-ops.mjs`)

`ctrl+b d` (or `:downloads`) opens a picker over the window's downloads, where one key opens a
file, opens it in the system's app, shows it in its folder, copies its link or path, opens the
page it came from, pauses, resumes, cancels or retries a download, removes it from the list,
deletes its file, allows or removes a blocked download through Firefox's own dialog, or opens
Firefox's full downloads view. It lists files on your disk and
hands them to the OS, so these rules keep it to Firefox's own download code and out of an
agent's reach. Spec: [downloads](specs/downloads.md).

**Reach:** only you, with `ctrl+b d`, `:downloads` or a key you bind. No control-socket or MCP
command reaches it, and an agent's keys are a fixed list without it (S7, M16). A `full`-role
connection holds your token and can press `ctrl+b d` as your keyboard can (§1). It shows what
Firefox's panel and Library show already, and stores nothing of its own. File names and
referring pages are chosen by the sites the files came from.

- D1. A row's file name, host, verdict and path **must** be set as text (C1), and a row **must**
  show the host a download came from, **never** its URL, so a token in a download link is not on
  screen; a download with no file path is named by its URL's last path segment or host. `y`
  copies the full link only on request.
  [`test_names_with_html_stay_text`](../tests/browser/browser_vimma_downloads.js),
  [`a row shows the host, never the URL`](../packages/vimma-core/test/downloads.test.mjs),
  [`a download with no file path is named by its URL's last segment, never the URL`](../packages/vimma-core/test/downloads.test.mjs)
- D2. A private window **must** list only its own private session's downloads, and a normal
  window **never** a private one; the status bar's segment counts the same way. A private
  download is gone with its session, as in Firefox.
  [`test_a_private_window_lists_only_private_downloads`](../tests/browser/browser_vimma_downloads.js),
  [`test_a_private_window_counts_only_its_private_downloads`](../tests/browser/browser_vimma_downloads.js)
- D3. A download Firefox blocked by a verdict **must** be released only through Firefox's own
  dialog, `DownloadsCommon.confirmUnblockDownload` with the `chooseUnblock` type, opened by `!`
  with the picker closed first: that dialog words the warning by verdict, its default button
  (`Enter`) removes the file, and `Esc` cancels. Vimma **must never** use `chooseOpen`, whose
  default opens the file, and an allow **must** open nothing: a download whose question was
  answered "open" is released without opening, and the file is opened afterwards only with `o`,
  through Firefox's executable prompt. `!` **must** do nothing with
  `browser.safebrowsing.allowOverride` off, for a `Malware` verdict (which can only be removed,
  as in Firefox's Library), for an agent download (D4), or without blocked data. `Enter` on a
  blocked row **must** only show Firefox's reason and the keys that apply. The dialog's answer
  **must** act only on the download asked about, as in D5: if its state, data or file changed,
  or `allowOverride` was turned off, before the answer, nothing is done. Removing (`d`) and
  deleting (`shift+d`) blocked data **must** confirm the block (`Download.confirmBlock`), as
  Firefox's own remove does, and a content-analysis `Malware` download **must never** be removed
  or deleted from the picker, because the scanner, not the user, owns it. Firefox's dialog keeps
  Vimma's dialog keys (firefox-dialogs): `y` runs its first button, "Allow download", only once
  the keys are armed after `security.notification_enable_delay` with no key in between, so a key
  typed on into the dialog cannot allow it.
  [`test_a_blocked_download_unblocks_only_through_firefoxs_dialog`](../tests/browser/browser_vimma_downloads.js),
  [`test_enter_in_firefoxs_unblock_dialog_never_reaches_the_picker`](../tests/browser/browser_vimma_downloads.js),
  [`test_enter_on_a_blocked_download_says_why_and_the_keys`](../tests/browser/browser_vimma_downloads.js),
  [`test_no_unblock_when_allowOverride_is_false`](../tests/browser/browser_vimma_downloads.js),
  [`test_a_malware_verdict_can_only_be_removed`](../tests/browser/browser_vimma_downloads.js),
  [`test_a_content_analysis_malware_verdict_cannot_be_unblocked_removed_or_deleted`](../tests/browser/browser_vimma_downloads.js),
  [`test_d_on_a_blocked_download_deletes_its_data`](../tests/browser/browser_vimma_downloads.js),
  [`test_D_on_a_blocked_download_confirms_the_block`](../tests/browser/browser_vimma_downloads.js),
  [`unblock needs blocked data and allowOverride`](../packages/vimma-core/test/downloads.test.mjs),
  [`a Malware verdict refuses !`](../packages/vimma-core/test/downloads.test.mjs),
  [`a content-analysis Malware verdict refuses !, d and shift+d`](../packages/vimma-core/test/downloads.test.mjs),
  [`an answer in Firefox's unblock dialog stands only while it still applies`](../packages/vimma-core/test/downloads.test.mjs)
- D4. An agent download (M11's test: its container, its tab's container, or a path in the
  quarantine folder) **must never** be opened, opened in the system's app, retried, allowed or
  followed to its referring page from the picker, because its file is admitted only under M12
  and its page was chosen by the agent; `o` is refused twice, by the picker and by M12's
  `launchDownload` override. Showing it in its folder, copying its link or path and removing it
  stay. A history entry with no file path is **never** retried from the picker either, because
  without its folder it cannot be told apart from an agent download. For any download, `u`
  **must** open only an `http:` or `https:` page, never a script,
  `data:` or `file:` address a page chose as its referrer, and **must** open it in the
  download's own container (the window's non-agent one for a history entry), **never** the agent
  workspace's, even with that workspace on screen: the full referrer may carry a token.
  [`test_the_picker_never_opens_an_agent_download`](../tests/browser/browser_vimma_downloads.js),
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_u_opens_the_referring_page`](../tests/browser/browser_vimma_downloads.js),
  [`an agent download refuses o, shift+o, u, r and !`](../packages/vimma-core/test/downloads.test.mjs),
  [`the keys that apply follow isCommandEnabled for each state`](../packages/vimma-core/test/downloads.test.mjs)
- D5. `shift+d` (delete the file) and `c` (cancel, which removes the partial data) **must** ask
  `y/N` first, and the picker **must** close before the question shows, because an open picker
  takes every key first and a `y` meant for the question would otherwise reach it. A yes **must**
  act only on the download asked about: if it left the list, changed state, or its file moved or
  went before the answer, nothing is done and the notice says so. Both run through Firefox's own
  commands (`Download.cancel` and `removePartialData`, `DownloadsCommon.deleteDownloadFiles`);
  `d` removes only the list and history entry, keeps the file, and does not ask, as in Firefox.
  [`test_cancel_asks_and_removes_the_partial_file`](../tests/browser/browser_vimma_downloads.js),
  [`test_D_asks_and_deletes_the_file`](../tests/browser/browser_vimma_downloads.js),
  [`test_the_y_answer_goes_to_the_question_never_to_the_picker`](../tests/browser/browser_vimma_downloads.js),
  [`test_an_answer_does_nothing_if_the_download_changed`](../tests/browser/browser_vimma_downloads.js),
  [`shift+d and c need a y/N; d does not`](../packages/vimma-core/test/downloads.test.mjs),
  [`a yes stands only for the download asked about (docs/security.md D5)`](../packages/vimma-core/test/downloads.test.mjs)
- D6. No agent role **may** reach the picker or the downloads list: `downloads.picker` is not
  one of `vimma_keys`' actions, no control or MCP command lists or opens a download, and no
  `ctl/` or `agent/` module imports the picker's ops.
  [`downloads.picker is not an agent key action (docs/specs/downloads.md decision 16)`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`opens and reveals downloads only through Firefox's Download, from download-ops`](../tools/security/test/chrome-source.test.ts)
