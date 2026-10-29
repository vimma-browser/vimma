# Security model

What each risky part of Vimma may do, what it must never do, who can reach it, and the test that
holds it to that. It is a page of rules, not code: review it like a contract. Reporting a
vulnerability: [SECURITY.md](../SECURITY.md).

**How to read it.** Each rule is one "must" or "never" sentence, followed by the tests that
enforce it, as `test name` links into the test file. CI fails if a link stops resolving
(`tools/security/check-doc-links.mjs`), so a renamed or deleted test cannot leave a rule
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
  it, and it stops when both are off.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js),
  [`test_agent_role_has_its_own_switch`](../tests/browser/browser_vimma_mcp_agent.js)
- S2. It **must** listen on 127.0.0.1 only, never on another interface.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js)
- S3. The token file **must** be mode 0600 from its first byte, and `vimma-ctl` **must** refuse
  one that others can read.
  [`test_pref_starts_and_stops_the_server`](../tests/browser/browser_vimma_control.js),
  [`refuses_a_file_others_can_read`](../tools/vimma-ctl/src/discovery.rs),
  [`refuses_an_insecure_discovery_file`](../tools/vimma-ctl/tests/cli.rs)
- S4. No command **must** run before the HMAC handshake; a wrong token is refused and the
  connection closed; the token is never sent before the server proved it knows it.
  [`test_handshake`](../tests/browser/browser_vimma_control.js),
  [`challenge.valid's proof is HMAC-SHA256(token, vimma-server NUL nonce)`](../packages/vimma-core/test/control.test.mjs),
  [`a_squatter_gets_neither_the_token_nor_a_command`](../tools/vimma-ctl/tests/cli.rs)
- S5. It **must** cap connections (8 open, of which at most 4 agents; 2 waiting for a hello),
  line length (1 MiB) and handshake and idle time.
  [`test_limits`](../tests/browser/browser_vimma_control.js),
  [`test_agents_cannot_take_every_connection`](../tests/browser/browser_vimma_mcp_agent.js)
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
  and the pane structure.
  [`control_state_is_read_only`](../tests/browser/browser_vimma_security_invariants.js),
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
  `state` or protocol 1's `open`.
  [`test_agent_role_has_its_own_switch`](../tests/browser/browser_vimma_mcp_agent.js),
  [`test_each_role_runs_only_its_commands`](../tests/browser/browser_vimma_mcp_agent.js),
  [`says_the_control_socket_is_off_when_only_mcp_is_on`](../tools/vimma-ctl/tests/cli.rs)
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
- R4. The app hint (`-vimma-from`, `VIMMA_FROM`) **must** only select a workspace that a rule in
  config.toml names and that exists; anything but a short lower-case token never matches.
  [`a hint that is not a token never matches`](../packages/vimma-core/test/routes.test.mjs),
  [`a rule naming a workspace that does not exist is skipped`](../packages/vimma-core/test/routes.test.mjs)
- R5. `VIMMA_FROM` **must** be read once and cleared, so it never reaches a later window or a
  process Vimma starts.
  [`a_new_windows_first_tab_is_routed_with_the_startup_app`](../tests/browser/browser_vimma_workspace_routes.js)
- R6. A domain rule **never** matches a host outside its domain: not a lookalike
  (`evil-github.com`, `github.com.evil`, letters from another script), nor a disguise
  (`github.com@evil`, a path, query or fragment, `\`, `%2e`, the ideographic full stop).
  [`a domain rule never matches a URL whose host is outside its domain`](../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs),
  [`a domain rule matches its own host and subdomains, however written`](../packages/vimma-core/test/fuzz/routes.fuzz.test.mjs)

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
  kind of target its collection asked for: a block in an `f` or `gF` reply, or a link or control in
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
  [`installs an add-on only from the setup page`](../tools/security/test/chrome-source.test.mjs),
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

- C1. Page titles, add-on names and bookmark titles **must** be set as text (`textContent`),
  **never** parsed as HTML.
  [`page_titles_with_html_stay_text`](../tests/browser/browser_vimma_security_invariants.js),
  [`names_with_html_are_text`](../tests/browser/browser_vimma_addons.js),
  [`toggles_in_the_side_panels_slot_one_panel_at_a_time`](../tests/browser/browser_vimma_bookmarks.js),
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../tools/security/test/chrome-source.test.mjs)
- C2. Chrome code **never** builds code from text (`eval`, `Function`) and **never** starts a
  process, with two exceptions. First, the system's ClamAV scanners, `clamscan` (only
  `/usr/bin/clamscan` or `/usr/local/bin/clamscan`) and `clamdscan` (only `/usr/bin/clamdscan`
  or `/usr/local/bin/clamdscan`), never from a `PATH` search, and only a regular file another
  user (root) owns that the user cannot write, in a folder the user cannot write. They run in
  one call with arguments from three fixed builders (the scan, clamd's scan with `--fdpass`, and
  `--version`), the path after `--` and no shell, on an agent download in the quarantine folder
  (M13; [vimma-mcp](specs/vimma-mcp.md) decisions 31 g, 43-45). Second, an AppImage's restart
  (UP11): `/bin/sh` (an absolute path) with one fixed script that waits for Vimma's own process
  to exit and then runs `$APPIMAGE` with no arguments, the process id and the path passed as
  positional parameters the script **never** reads as shell text, started from one call site
  only once a quit can no longer be cancelled. Chrome code **never** calls
  native code, with one exception: the owner and type of clamd's socket (M13), read through
  js-ctypes with `statx(2)` from `libc.so.6` on Linux and `lstat(2)` from
  `/usr/lib/libSystem.B.dylib` on macOS (`lstat` on arm64, `lstat$INODE64` on x86_64, the same
  144-byte `struct stat`), neither following a symlink. libSystem is opened by its absolute path,
  which dyld resolves from its shared cache, because for a bare name dyld also searches the
  working directory of a process without the hardened runtime, so a library planted where Vimma
  starts would be loaded. Any other system or architecture, a failed call or a struct of
  another size gives no owner, so clamd is not used. [`never builds code from text: no eval, Function or sandbox evaluation`](../tools/security/test/chrome-source.test.mjs),
  [`never starts a process, but ClamAV on an agent download and an AppImage's restart`](../tools/security/test/chrome-source.test.mjs),
  [`restarts an AppImage through one fixed script, with its path never shell text`](../tools/security/test/chrome-source.test.mjs),
  [`/bin/sh runs a fixed script; the pid and the path are arguments, never script text`](../packages/vimma-core/test/restart.test.mjs),
  [`starts the AppImage only once the old process has exited, with no arguments`](../packages/vimma-core/test/restart.test.mjs),
  [`never calls native code, but statx or lstat on clamd's socket`](../tools/security/test/chrome-source.test.mjs)
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
    [`doorhangerKey`](../packages/vimma-core/test/prompt-keys.test.mjs),
    [`permission_prompts_answer_y_and_n`](../tests/browser/browser_vimma_toolbar.js),
    [`prompt_keys_arm_on_firefoxs_own_delay`](../tests/browser/browser_vimma_toolbar.js),
    [`prompt_keys_leave_live_grep_and_find_their_keys`](../tests/browser/browser_vimma_toolbar.js),
    [`KEY_KEEPING_MODES`](../packages/vimma-core/test/modes.test.mjs),
    [`prompt_keys_leave_hint_copy_and_element_mode_their_keys`](../tests/browser/browser_vimma_toolbar.js),
    [`the_addon_install_prompt_answers_y_and_n`](../tests/browser/browser_vimma_toolbar.js),
    [`the_prompts_own_fields_take_their_keys`](../tests/browser/browser_vimma_password_prompt.js)
  - Accepted, low: a page can time a reveal under the pointer (a permission request shows the
    prompt bar, a download the full toolbar); there is no hover reveal. See the spec's Security
    section.

## 7. Omarchy hook and the `vimma-open` launcher

The hook (`omarchy/vimma-theme-reload.sh`) runs when you change your Omarchy theme. Vimma
writes it into `~/.config/omarchy/hooks/theme-set.d/`. `vimma-open` (`tools/package/`) is the
desktop entry's launcher (`vimma-open %u`): it finds which app opened a link, for routing.

**Reach:** the hook gets the theme name, which comes from a theme anyone can publish.
`vimma-open` gets a URL from any local app, and reads `/proc` for the app's name.

- O1. The hook **must** only ask running Vimmas to reload their theme (D-Bus, else
  `vimma-ctl reload-theme`) and **never** start a Vimma.
  [`asks every running Vimma, over Firefox's D-Bus remoting, to reload its theme`](../tools/omarchy/test/theme-hook.test.mjs),
  [`never starts Vimma: with none running it does nothing and says nothing`](../tools/omarchy/test/theme-hook.test.mjs)
- O2. The hook **never** passes its arguments (the theme name) on to Vimma or `vimma-ctl`.
  [`never passes its arguments on: a hostile theme name changes nothing`](../tools/omarchy/test/theme-hook.test.mjs)
- O3. `-vimma-reload-theme` **must** open no window or tab.
  [`test_remote_reload_theme`](../tests/browser/browser_vimma_omarchy_hook.js)
- O4. Vimma **must** write the hook only where none is, or over its own unedited copy; an edited
  copy is yours and never touched. [`test_installer`](../tests/browser/browser_vimma_omarchy_hook.js)
- O5. `vimma-open` **never** passes a single argument that starts with `-`, so a crafted link
  cannot become a browser flag (`-profile`, `--remote-debugging-port`).
  [`refuses a single argument that is a flag: %u must never smuggle one in`](../tools/package/test/vimma-open.test.mjs)
- O6. The app name **must** be a lower-case token of at most 32 characters, and an inherited
  `VIMMA_FROM` is **never** passed on.
  [`never passes a name that is not a simple token`](../tools/package/test/vimma-open.test.mjs),
  [`refuses a name with a newline in it`](../tools/package/test/vimma-open.test.mjs),
  [`never passes a VIMMA_FROM it did not set`](../tools/package/test/vimma-open.test.mjs)
- O7. A theme's `colors.toml` (anyone can publish a theme) **must** give only `#rrggbb` colours
  and one CSS rule, and be read in bounded time however deep or large it is.
  [`parseOmarchyColors never throws; a palette has every key, as #rrggbb or a mode`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs),
  [`any theme file and any accepted font give CSS that tokensToCss accepts`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs),
  [`a hostile theme file is read in bounded time: deep, huge, many keys`](../packages/vimma-core/test/fuzz/theme.fuzz.test.mjs)

Allowed: two or more arguments pass through unchanged; a local app that runs `vimma-open` with
its own flags could run `vimma` with them directly.
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
- F3. The config is **never** executed: no value is evaluated as code or run as a command.
  [`never builds code from text: no eval, Function or sandbox evaluation`](../tools/security/test/chrome-source.test.mjs)
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

- G13. An upstream bump PR **must** be set to auto-merge only by `publish` run on `main`, only
  when `AUTO_MERGE_UPSTREAM` allows its release kind, only for a non-draft PR whose every patch
  applied clean or with an offset and whose diff changes nothing but `version.version` in
  `surfer.json` and the copied pref lines, and only pinned to the head commit that diff was read
  from. GitHub's auto-merge then waits for every required check of the `main` ruleset (spec
  [upstream-bump-automation](specs/upstream-bump-automation.md), ADR-022).
  [`auto-merge only with the variable, the token, a ready PR and the allowlist`](../tools/test/upstream-workflow.test.mjs),
  [`auto-merge uses --match-head-commit and the bump's subject`](../tools/test/upstream-workflow.test.mjs),
  [`the allowlist reads the branch as pushed`](../tools/test/upstream-workflow.test.mjs),
  [`rebuild disables auto-merge before the push`](../tools/test/upstream-workflow.test.mjs),
  [`dot allows dot releases only; unset or anything else allows none`](../tools/upstream/test/autopilot.test.mjs),
  [`names the first condition that did not hold`](../tools/upstream/test/autopilot.test.mjs),
  [`never with patches that needed fuzz, were re-exported or are applied already`](../tools/upstream/test/autopilot.test.mjs),
  [`refuses another line in firefox-branding.js`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a re-exported patch`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a new, deleted, renamed or mode-changed file`](../tools/upstream/test/bump-diff.test.mjs),
  [`refuses a file header it does not recognise instead of folding it into the last file`](../tools/upstream/test/bump-diff.test.mjs)
- G14. `UPSTREAM_PR_TOKEN` **must** reach only the `publish` job. It is fine-grained: this
  repository only, Contents and Pull requests read and write, no Workflows, so it cannot change a
  workflow file. Without it, bumps open as drafts and are never set to auto-merge.
  [`the token reaches only publish`](../tools/test/upstream-workflow.test.mjs),
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
  [docs/rebase.md](rebase.md) ("Security dot release: the fast path"). Vimma has no built-in
  updater ([`updater_is_not_built`](../tests/browser/browser_vimma_updater.js)); updates come
  with your package.
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

[mcp-drive](specs/mcp-drive.md) adds `vimma_keys` (Vimma's own page keys in an agent tab: M16,
M17, M20, M23), following its links by hint label (M18, M21), `vimma_show` (the agent workspace
brought to the front with one agent tab selected: M19, M20) and full control's wording while MCP
is on (M22), all in force. [mcp-forms](specs/mcp-forms.md) adds `vimma_elements` (an agent
tab's buttons, fields and links listed with hint labels, sensitive values left out: M25, M31,
M32), `vimma_activate` (a click on one of them, with no user activation, every form
submission asked: M25, M26, M28, M29, M32) and `vimma_fill` (fields set as form autofill sets
them, never a password, payment card, one-time-code or file field: M25, M27, M28, M32),
`vimma_screenshot` (an image of an agent tab's viewport, refused while a password or payment
card field on screen has a value: M25, M31, M32) and `vimma_console` (an agent tab's script
errors, console errors and warnings and failed requests, read without running page code: M25,
M30, M31, M32), in force. Since [#584](https://github.com/vimma-browser/vimma/issues/584),
`vimma_open`, `vimma_activate` and `vimma_fill` can return the page's element list in their
result, made and limited as a `vimma_elements` call (M31, M32), and a screenshot is smaller
unless the agent asks for it at full size (M31).

[mcp-grants](specs/mcp-grants.md) makes a grant cover every agent tool of its connection: a
grant given in answer to any question, a read included, lets that agent open URLs, follow links,
press keys, click buttons that do not submit a form, fill fields, take screenshots and download
(not dangerous or unscanned files) without asking until it ends. An open can carry in its URL
what the agent read, so a grant is a grant to fetch any http or https address from the agent
workspace. What limits it: the agent workspace's container holds none of your other logins
(vimma-mcp decision 7), so what an agent can read is what the agent workspace holds; every call
under a grant shows a notice (an open names its host) and is a `:mcp log` row with its whole URL
(M23); at most 10 opens a minute (M3); `ctrl+b shift+a` ends every grant at once; and an agent
with a shell can send what it read over its own network without Vimma anyway. A form submission,
a step that may pay, a show, a dangerous or unscanned download and a page's own download still
ask under any grant (M11, M13, M19, M28, M33). [mcp-checkpoints](specs/mcp-checkpoints.md)
makes sending a form and paying checkpoints: one `y` or `n` that shows what the step sends or
spends and leaves the grant as it was (M28, M33). The question's hint names only the keys
(`a until it quits`, or `10a 10 min`), so that the question fits one line; the guide's key
table says that `a` covers every tool, and the grant's notice, shown the moment it is made, says
so and names what still asks and the key that ends it.

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
  row, for 60 s; `x`, until it reconnects) **must** deny.
  [`test_denials_timeouts_queue_and_mute`](../tests/browser/browser_vimma_mcp_agent.js),
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
  never in the foreground: your window keeps its workspace, selected tab and focus.
  [`test_agent_open_is_background_and_checked`](../tests/browser/browser_vimma_mcp_agent.js),
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
  without it) and launch no other app through an external protocol (Firefox's chooser is
  wrapped for the agent container). Their downloads follow M11-M13. A tab of another workspace
  still asks, opens pop-ups and downloads as before.
  [`test_the_agent_container_asks_for_nothing`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_another_workspace_still_asks`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_tabs_open_no_popups`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_site_permissions_are_per_workspace`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_page_from_a_service_worker_is_denied_too`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_a_sweep_reloads_agent_tabs_that_loaded_unsandboxed`](../tests/browser/browser_vimma_mcp_agent_pages.js),
  [`test_agent_pages_launch_no_app`](../tests/browser/browser_vimma_mcp_agent_pages.js)
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
  [`bad_arguments_are_tool_errors_and_never_reach_vimma`](../tools/vimma-ctl/src/mcp.rs)
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
labels: send f again`. The label names the href captured when `f` ran, so a frame that
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
  [`a count of 100, 33 actions, 513 characters and a 257-character query are refused`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`agent-keys: a tab and 1 to 512 characters of keys, no control characters`](../packages/vimma-core/test/control-v2.test.mjs),
  [`at most 30 agent-keys per connection a minute, in OpenRate's class`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_keys_under_a_grant_notice_and_rate`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_loads_count_towards_the_open_rate`](../tests/browser/browser_vimma_mcp_keys.js),
  [`test_follows_count_towards_the_open_rate`](../tests/browser/browser_vimma_mcp_follow.js),
  [`a label is lowercase hint characters, at most the longest label of 200 links`](../packages/vimma-core/test/agent-keys.test.mjs),
  [`bad_keys_are_tool_errors_and_never_reach_vimma`](../tools/vimma-ctl/src/mcp.rs),
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
  [`keys_list_links_as_untrusted_content`](../tools/vimma-ctl/src/mcp.rs)
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
  [`the_instructions_advise_against_full_control`](../tools/vimma-ctl/src/mcp.rs)
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
  from the page; its labels replace the connection's last `f` on that tab and live by M18's
  rules, and `f<label>` follows only a link from the list, as a load (M18), and only while the
  link is still in its document. `agent-activate` (F8-F11) is held the same way: it clicks only
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
  [`activate_says_what_changed_in_place`](../tools/vimma-ctl/src/mcp.rs),
  [`agent-activate: what changed in place, from a fixed list`](../packages/vimma-core/test/control-v2.test.mjs),
  [`agent_clicks_never_synthesise_input_or_user_activation`](../tests/browser/browser_vimma_security_invariants.js),
  [`test_activate_reports_a_dialog`](../tests/browser/browser_vimma_mcp_activate.js),
  [`agent-activate: the page after the click, a dialog, a stopped submission`](../packages/vimma-core/test/control-v2.test.mjs),
  [`activate_says_what_the_click_did`](../tools/vimma-ctl/src/mcp.rs)
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
  [`fill_limits_are_tool_errors`](../tools/vimma-ctl/src/mcp.rs),
  [`fill_values_with_invisible_characters_are_tool_errors`](../tools/vimma-ctl/src/mcp.rs),
  [`vimma_fill: each field and value in the question, how many in the notice`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M28. A click that submits a form (a submit button or a submit or image input in a form whose
  method is not `dialog`, the element itself, the button it is in or its label's control)
  **must** ask every time, also under any grant, with only `y` and `n`, naming
  the form's method, destination and each field it sends by name and value (hidden fields
  counted, a file field by its name), **never** a password, payment card or one-time-code
  field's value, only its name and `•••`, or the number of fields when the page did not say in
  time; its yes **never** makes or ends a grant, and its `x` is a plain no; so **must** a fill that submits (`vimma_fill` with `submit`, through a submit button's
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
  [`console_calls_become_agent_commands`](../tools/vimma-ctl/src/mcp.rs),
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
  counts. A one-time-code field without that autocomplete name or a mask is not recognised. No page text beyond the elements' own is returned.
  The list `agent-open`, `agent-activate` and `agent-fill` return when asked with `elements`
  (issue #584) **must** be made by the same code as `agent-elements`' own, so every rule above
  holds for it, and the validator and `vimma-ctl mcp` check it the same way; it is made only
  after the step, of a page that is no longer loading, and only while the tab is still an agent
  tab with the URL it had when the list began (else the result says why, in fixed words, and
  holds no list); the result's URL and title are read at the last such check, and a tab that
  left the agent workspace meanwhile fails the call, noted in `:mcp log`, with nothing of its
  page; its labels become the connection's current ones as a `vimma_elements` list's do. The
  step's question (a checkpoint's included), its `:mcp log` row and its notice under a grant say
  that the list is taken too.
  [`test_a_steps_list_says_nothing_of_a_tab_that_left`](../tests/browser/browser_vimma_mcp_elements.js),
  [`test_steps_return_the_element_list_vimma_elements_would`](../tests/browser/browser_vimma_mcp_elements.js),
  [`a step's list is inside the untrusted delimiters, with its dropped count`](../packages/vimma-core/test/control-v2.test.mjs),
  [`why a step's list is missing: fixed words, never with a list`](../packages/vimma-core/test/control-v2.test.mjs),
  [`a_steps_element_list_is_untrusted_content_as_vimma_elements`](../tools/vimma-ctl/src/mcp.rs),
  [`an_open_with_elements_lists_the_page_it_loaded`](../tools/vimma-ctl/src/mcp.rs),
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
  [`elements_list_as_untrusted_content`](../tools/vimma-ctl/src/mcp.rs)

  `agent-screenshot`'s image (F19) **must** be a PNG, or a JPEG when the PNG does not fit, whose
  base64 is at most 700 KiB, at most 1,280 by 16,384 pixels; unless asked `full`, it is at most
  1,024 pixels wide and the smaller of a PNG and a JPEG (issue #584); the protocol validator and
  `vimma-ctl mcp` **must** refuse any other type, size or encoding, and `vimma-ctl mcp` **must**
  pass it on as an MCP image item only after the untrusted header, which says that text in the
  image is web content and not from you. Labels drawn on it (F20) come only from the
  connection's current `vimma_elements` list of that page, and only while its top frame has
  not scrolled since the list was made; else none is drawn and the result says the list is
  stale. A screenshot **must** be refused (F21) while a sensitive field as above, with a value,
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
  [`a_screenshot_is_an_image_after_the_untrusted_header`](../tools/vimma-ctl/src/mcp.rs),
  [`screenshot_calls_become_agent_commands`](../tools/vimma-ctl/src/mcp.rs)

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
  [`console_lists_as_untrusted_content`](../tools/vimma-ctl/src/mcp.rs)

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
  (`x` is a plain no), and its yes **never** makes, lengthens or ends a grant; its no denies that
  step only. A payment step is a `vimma_activate` click, a `vimma_fill` that submits, or a
  `vimma_keys` follow, `gu`, `gU`, `H` or `L`, in an agent tab whose page shows a payment card
  field in any frame (a `cc-*` autocomplete name or form autofill's card heuristics; a frame
  whose check fails or that does not answer within 5 s counts as one, a frame that navigates
  away or whose process ends during the check does not), or whose pressed control has a phrase
  of the fixed list (`PAY_PHRASES`, six languages) as whole words in its text, accessible name,
  title or value. Its question **must** name the button (for a key step, its keys), the host of
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

### The built-in agent (`agent/AgentChat.sys.mjs`, `agent/AgentKeys.sys.mjs`)

Vimma's own agent ([builtin-agent](specs/builtin-agent.md),
[ADR-023](adr/023-in-browser-model-client.md)): a model the user picks, local or hosted, runs
tasks the user types in Vimma, through the same agent commands and gate as an MCP agent. It is
behind `vimma.feature.agentChat` (off) until its chat window lands; what is in force:

**Reach:** the agent workspace's tabs that its conversation owns, through `runAgentCommand` in
the browser's process, so every rule above holds for it, with no `:mcp on` and no socket. It
has no shell, files or network of its own: the agent workspace and the model's endpoint are its
only ways to send anything. Page text reaches the model inside the untrusted-content delimiters,
a mitigation and not a guarantee (M7), so a page can steer it; a steered model under its
conversation's grant can do what any grant allows (above), within its own tabs and its budget.

**The conversation grant.** A task the user sends from Vimma's own chat window is known to come
from the user, so sending it with `Enter` grants that conversation's connection, with no
question and no expiry, until it is stopped (B18). Nothing but Vimma's chrome calls it: the
control socket has no command that sends a task, and page key events never reach chrome. The
steps that cannot be taken back still ask under it.

**The model's endpoint.** Requests carry the system text, the tool definitions, the user's
messages and every tool result (page text, element lists, console entries, screenshots for a
model with vision) to the endpoint the user configured, and nowhere else. A hosted provider's
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
  every step (`Enter`) or by an answer to its question; it **must** have no expiry, **must** end
  on a send that asks every step (`ctrl+Enter`), on stopping the conversation, on
  `ctrl+b shift+a`, on `:mcp revoke` and when the conversation is deleted, and **must never**
  cover another conversation. Form submissions, payment steps, `vimma_show` and the downloads
  that always ask **must** ask under it (M19, M28, M33).
  [`test_ctrl_enter_asks_every_step_and_ends_the_grant`](../tests/browser/browser_vimma_agent_conversations.js),
  [`test_grant_covers_later_tasks_until_stopped`](../tests/browser/browser_vimma_agent_conversations.js),
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
  probe **must** ask only 127.0.0.1 on the local servers' ports, with a timeout of 1 s, and only
  when setup asks.
  [`test_requests_only_to_the_endpoint_without_credentials_or_redirects`](../tests/browser/browser_vimma_agent_conversations.js),
  [`posts to the endpoint without credentials or redirects, and parses the reply`](../packages/vimma-core/test/agent-providers.test.mjs),
  [`a refused endpoint makes no request`](../packages/vimma-core/test/agent-providers.test.mjs),
  [`local_only refuses a remote endpoint`](../packages/vimma-core/test/config-agent.test.mjs),
  [`an endpoint off this machine must be https, and carry no user name`](../packages/vimma-core/test/config-agent.test.mjs),
  [`lists the models of the servers that answer, with no cookies and no redirects`](../packages/vimma-core/test/agent-setup.test.mjs),
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

## 13. Page modes (`actors/VimmaParent.sys.mjs`, `host/VimmaHost.sys.mjs`)

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
  top document ends this. This holds for an uncompromised content process: a report's `user` and
  `gen` fields and `Vimma:Click` come from the content process, so a compromised one can do what
  K1 allows, no more.
  [`after_esc_a_page_refocusing_its_field_stays_in_normal`](../tests/browser/browser_vimma_insert_focus.js),
  [`after_esc_on_a_trapping_page_i_click_and_tab_enter_insert`](../tests/browser/browser_vimma_insert_focus.js),
  [`esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal`](../tests/browser/browser_vimma_insert_focus.js)

## 14. Build and release supply chain (`release.yml`, `aur.yml`, `homebrew.yml`, `nightly.yml`, `macos.yml`, `flatpak.yml`)

Vimma's binaries are built from Mozilla's Firefox source, this repository, and the npm packages
that drive the build, chiefly Surfer. These rules keep what reaches a build pinned and reviewed.
Spec: [build-supply-chain](specs/build-supply-chain.md), [ADR-001](adr/001-engine-firefox-surfer.md).

**Reach:** Mozilla's archive and Taskcluster, the npm registry, this repository, and GitHub's
hosted runners; for the Flatpak build only (B12), Docker Hub's Fedora image, Fedora's package
mirrors and Flathub (`dl.flathub.org`). Dependabot pull requests run and auto-merge today, whether or not a build runs.

The macOS build, `macos.yml` ([ADR-018](adr/018-macos-cross-build.md)), also runs on pull
requests that touch it. It holds no secret and only a read-only token, builds on hosted runners
under B1, B2 and B5 like the release build, and adds one download, rcodesign, pinned by SHA-256.
Its ad hoc signature proves nothing about who built the app.
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
- B8. The nightly **never** creates, replaces or deletes a release, and no job of it can write
  contents. Its `build` job, which runs npm, Surfer, `mach` and the mochitests, holds
  `contents: read` only and keeps its package as a workflow artifact for 7 days. The failure
  issue comes from a `report` job with `issues: write`, which checks out and runs no repository
  code, reads no secret, and quotes only the log the build job redacted before uploading it,
  with backticks escaped so no log line can end its code fence. **⚠ limit:** the artifact is
  not private. The repository is public, so anyone signed in to GitHub can download it for the
  7 days it is kept, and its name and size are listed without signing in. It holds the same
  package, and the same compiled-in Safe Browsing key, as a keyed release build.
  [`the workflow and its build job can only read the repository`](../tools/test/nightly-workflow.test.mjs),
  [`the build job keeps the package as a workflow artifact for 7 days`](../tools/test/nightly-workflow.test.mjs),
  [`no job creates, edits or deletes a release, and none can write contents`](../tools/test/nightly-workflow.test.mjs),
  [`a failure is reported by its own job, from the redacted log artifact`](../tools/test/nightly-workflow.test.mjs),
  [`the report job names the repository, since it checks nothing out`](../tools/test/nightly-workflow.test.mjs),
  [`only the nightly's failure-issue step gets GH_TOKEN`](../tools/test/full-build-workflows.test.mjs)
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
  against the committed files, and has installed the `.dmg` through the cask.
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
  a stub `.dmg` on every pull request that changes `tools/package/`. `homebrew.yml`'s `homebrew`
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
  last starts the push. `start` runs the tag's copy of `homebrew.yml`, which anyone with write
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
  [`never replaces a newer cask with an older one`](../tools/package/test/release-workflow.test.mjs)

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
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../tools/security/test/chrome-source.test.mjs)
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

## 16. Update check (`updates/VimmaUpdates.sys.mjs`, `update-publish.yml`)

Spec: [m6a-updater](specs/m6a-updater.md) (delivery 1) and [update-notices](specs/update-notices.md).
Vimma fetches one signed manifest from `updates.vimma.dev` every 12 hours, at startup when a check
is due, and on `:update`, and tells the status bar, about:vimma and, once per version, a short
message whether a newer release exists; a security release also asks once per session whether
to show the update command, and once it is installed, whether to restart (UP11). Only the AppImage installs anything: it replaces its own file with
the offered AppImage (UP10); every other install downloads and installs nothing. Who can reach it: whoever
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
  [`ask updates.vimma.dev with the platform and channel only`](../tools/branding/test/branding-prefs.test.mjs)
- UP4. With `[updates] check = false` or `vimma.update.enabled` = `false`, and in a build run from
  its objdir, Vimma **never** makes an update request, and shows no update message or question.
  A `config.toml` with errors **never** turns checks on: a `check = false` still readable in it
  holds, and while only the defaults stand in for the broken file no check runs. Apart from
  `:update`, an attempt that got no answer is **never** repeated within 10 minutes, so restarts
  send no burst of requests.
  [`off_by_pref_or_config_sends_nothing`](../tests/browser/browser_vimma_update_check.js),
  [`nothing_at_all_with_checks_off`](../tests/browser/browser_vimma_update_notices.js),
  [`checks off or a source build: never due`](../packages/vimma-core/test/update-notices.test.mjs),
  [`a failed attempt does not count as a check, but is not retried within 10 minutes`](../packages/vimma-core/test/update-notices.test.mjs),
  [`startup_checks_when_due_and_not_when_fresh`](../tests/browser/browser_vimma_update_notices.js),
  [`a_source_build_checks_nothing`](../tests/browser/browser_vimma_update_check.js),
  [`a_config_with_errors_still_turns_checks_off`](../tests/browser/browser_vimma_update_check.js),
  [`a file with errors: a readable check = false holds; else the config in force, or held`](../packages/vimma-core/test/updates.test.mjs)
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
  DigestInfo with Cloud KMS and checks the signature with openssl. The job that builds the body
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
  target than the one asked for. Each target has its own concurrency group, so its serials only
  grow; a push that the other target's push beat is rebased onto it (another file), never forced.
  **⚠ limit:** without a required reviewer on `update-signing`, anyone with write access can
  start a run on `main` that re-signs a published release or offers nothing (withholding
  updates).
  [`grants nothing by default, and each job only what it needs`](../tools/update/test/update-workflow.test.mjs),
  [`only sign mints an OIDC token, and only sign names the signing environment`](../tools/update/test/update-workflow.test.mjs),
  [`the signing job runs no repository code: no checkout, no node, no npm`](../tools/update/test/update-workflow.test.mjs),
  [`a published release only starts the run on main, and only with UPDATES_ENABLED`](../tools/update/test/update-workflow.test.mjs),
  [`%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run`](../tools/update/test/update-workflow.test.mjs),
  [`checks that the release is published, not a pre-release, and on main`](../tools/update/test/update-workflow.test.mjs),
  [`checks SHA256SUMS against release.yml's signature, and refuses an unsigned release`](../tools/update/test/update-workflow.test.mjs),
  [`the publish job verifies with the browser's verifier and with openssl before any push`](../tools/update/test/update-workflow.test.mjs),
  [`the deploy key lives in its own environment and reaches only the push step`](../tools/update/test/update-workflow.test.mjs),
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
  [`macos-tap starts the macOS update manifest once the .dmg is on a published release`](../tools/package/test/release-workflow.test.mjs)
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
  security release that is already in place (an AppImage that replaced its file), once per
  session and again 24 hours after an answer, and arms, waits and refuses keys exactly as the
  question of UP9. It **never** hides a loss: while the private workspace has tabs it says they
  will close, and when session restore will bring no tab back it says `Tabs will not come back`;
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
  [`an_ordinary_replaced_update_asks_nothing`](../tests/browser/browser_vimma_update_appimage.js),
  [`answered in this session: asked again 24 hours later, not sooner`](../packages/vimma-core/test/update-notices.test.mjs),
  [`the_restart_question_says_what_a_restart_loses`](../tests/browser/browser_vimma_update_appimage.js),
  [`history_cleared_on_close_asks_before_an_appimage_restart`](../tests/browser/browser_vimma_restart.js),
  [`history cleared on close: an AppImage's restart is a quit, so the session is purged`](../packages/vimma-core/test/restart.test.mjs),
  [`an AppImage without a usable $APPIMAGE falls back to Firefox's restart`](../packages/vimma-core/test/restart.test.mjs),
  [`gives up after RELAUNCH_WAIT_S when the old process never exits`](../packages/vimma-core/test/restart.test.mjs)

**Key custody** (spec §6, decisions 16 and 17): the primary manifest key is a non-exportable
Google Cloud KMS key that only `update-publish.yml`'s signing job on `main`, in the `update-signing` environment, can
ask to sign, through GitHub OIDC (UP7); the secondary is to be generated and kept offline by the maintainer (not made yet). Their
setup is in [runbook.md](runbook.md#update-signing-keys-and-the-update-host-spec-m6a-updater).
The primary's public key is pinned in `update-keys.mjs` (its SHA-256 is recorded in the runbook
and checked by
[`the shipped primary: exactly one, RSA-4096, the recorded key, verifies RSASSA-PKCS1-v1_5 SHA-384`](../packages/vimma-core/test/updates.test.mjs));
the secondary is pinned in a later release, an ordinary one whose manifest the primary signs.
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
  [`puts no untrusted text outside a code span`](../tools/sites/test/diff.test.mjs),
  [`wraps text in a code span, where GitHub renders no mention, reference, link or HTML`](../tools/sites/test/diff.test.mjs),
  [`picks a fence longer than any run of backticks inside, padded at a backtick edge`](../tools/sites/test/diff.test.mjs),
  [`puts everything on one line: newlines, control and bidirectional characters`](../tools/sites/test/diff.test.mjs),
  [`cuts to MAX_TEXT characters, and says when it is empty`](../tools/sites/test/diff.test.mjs),
  [`caps the list and the body`](../tools/sites/test/diff.test.mjs),
  [`drops a run URL that is not GitHub's`](../tools/sites/test/diff.test.mjs)
- SC4. The previous run's `results.json` and `diff.json` are used **only** when they have the
  expected shape: site ids of lowercase letters, digits and dashes, statuses and check ids from
  fixed sets, strings where strings belong. Anything else is reported and compared as no
  baseline, so a damaged artifact cannot inject names or open an issue. Site names come from the
  repository's `sites.json`, whose test forbids anything GitHub would turn into a mention,
  reference or link.
  [`names nothing GitHub would turn into a mention, reference or link`](../tools/sites/test/sites-data.test.mjs),
  [`rejects a run of the wrong shape, unknown statuses and check ids, and odd site ids`](../tools/sites/test/diff.test.mjs),
  [`round-trips the tracked list through diff.json, and rejects one of the wrong shape`](../tools/sites/test/diff.test.mjs),
  [`reports no baseline when the previous artifact is missing or malformed`](../tools/sites/test/compare.test.mjs)
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
  [`rejects scripts and every element that loads or embeds something`](../tools/sites/test/snapshot.test.mjs),
  [`rejects event handlers however they are written`](../tools/sites/test/snapshot.test.mjs),
  [`allows only fragment links and the follow target as href`](../tools/sites/test/snapshot.test.mjs),
  [`rejects every other attribute that names a URL`](../tools/sites/test/snapshot.test.mjs),
  [`rejects url(), @import and image-set() in styles`](../tools/sites/test/snapshot.test.mjs),
  [`wants the doctype, and the CSP as the first thing in <head>`](../tools/sites/test/snapshot.test.mjs),
  [`ends a comment where the parser does: <!-->, <!--->, --!>`](../tools/sites/test/snapshot.test.mjs),
  [`reads markup inside raw-text elements too, as in <svg>, where they are not raw`](../tools/sites/test/snapshot.test.mjs),
  [`reads CSS escapes and comments before looking for loads`](../tools/sites/test/snapshot.test.mjs),
  [`each have a manifest entry with a licence that allows redistribution`](../tools/sites/test/snapshot.test.mjs),
  [`runs the suite only offline, after the e2e scenarios, on the artifact build`](../tools/test/sites-workflow.test.mjs)
