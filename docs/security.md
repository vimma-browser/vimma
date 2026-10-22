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
- S9. `state` **must** be read-only: it changes no tab, selection, mode or workspace.
  [`control_state_is_read_only`](../tests/browser/browser_vimma_security_invariants.js)
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
  the user ran. `:control on <minutes>` **must** turn full control off when its time is up, also
  across a restart, and **must** fail closed: an end time that is not a time ahead within 1441
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
  process, with one exception: the system's ClamAV scanners, `clamscan` (only
  `/usr/bin/clamscan` or `/usr/local/bin/clamscan`) and `clamdscan` (only `/usr/bin/clamdscan`
  or `/usr/local/bin/clamdscan`), never from a `PATH` search, and only a regular file another
  user (root) owns that the user cannot write, in a folder the user cannot write. They run in
  one call with arguments from three fixed builders (the scan, clamd's scan with `--fdpass`, and
  `--version`), the path after `--` and no shell, on an agent download in the quarantine folder
  (M13; [vimma-mcp](specs/vimma-mcp.md) decisions 31 g, 43-45). Chrome code **never** calls
  native code, with one exception: the owner and type of clamd's socket (M13), read through
  js-ctypes with `statx(2)` from `libc.so.6` on Linux and `lstat(2)` from `libSystem.B.dylib`
  on macOS (`lstat` on arm64, `lstat$INODE64` on x86_64, the same 144-byte `struct stat`),
  neither following a symlink. Any other system or architecture, a failed call or a struct of
  another size gives no owner, so clamd is not used. [`never builds code from text: no eval, Function or sandbox evaluation`](../tools/security/test/chrome-source.test.mjs),
  [`never starts a process, but ClamAV on an agent download`](../tools/security/test/chrome-source.test.mjs),
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
    between (any key restarts the wait), **never** from a text field, and go through Firefox's
    own buttons, so Firefox's click delay still applies. The wait counts from Firefox's own time
    for the prompt (`timeShown`), which Firefox moves later on its own (for example when the panel
    moves or resizes, the window is activated or another prompt takes the panel), so an armed key
    never meets a button Firefox's delay still refuses. Vimma **never** gives the prompt focus;
    `Tab` focuses the secondary (Block) button first. A prompt Firefox itself opens with focus on
    its panel (the add-on install prompt, `autofocus` in ExtensionsUI) takes the keys from there,
    under the same delay; no text field has focus then.
    [`doorhangerKey`](../packages/vimma-core/test/prompt-keys.test.mjs),
    [`permission_prompts_answer_y_and_n`](../tests/browser/browser_vimma_toolbar.js),
    [`prompt_keys_arm_on_firefoxs_own_delay`](../tests/browser/browser_vimma_toolbar.js),
    [`the_addon_install_prompt_answers_y_and_n`](../tests/browser/browser_vimma_toolbar.js)
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
  GitHub's auto-merge, so the `main` ruleset's required checks still gate it.
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

**Planned:** [mcp-drive](specs/mcp-drive.md) adds `vimma_show` and `vimma_keys` (the agent shows
a page, and runs Vimma's own page keys in an agent tab) and makes full control's questions say
that it reaches beyond the agent workspace while MCP is on. Its rules M16-M23 (key whitelist,
background-only, follows as loads, show always asked, limits, delimited link lists, full
control's wording, the audit) enter this section with their tests in the sub-PR that builds each.

- M1. Every agent command but `agent-hello`, `agent-ping` and `agent-cancel` **must** wait for
  your yes, or run under an unexpired grant of that connection and tool.
  [`test_grants_per_connection_and_tool`](../tests/browser/browser_vimma_mcp_agent.js),
  [`15 min for (conn 1, read): reads run unasked until 15:00; opens and conn 2 ask`](../packages/vimma-core/test/agent-gate.test.mjs)
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
  prompt, picker, panel or the command line open over it, and for the rest of a key sequence,
  the keys are theirs. Text an agent or a page chooses (the client name, which is the agent's own
  claim and proves nothing, and titles) is drawn as a bidi isolate (`<bdi>`), URLs as
  left-to-right isolates. A window not in front gets the urgency hint and a notification with no
  URL, no title and no buttons.
  [`test_the_line_opens_arms_and_ignores_stray_keys`](../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_focus_changes_and_early_keys_rearm_the_line`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_other_ui_opened_over_the_line_gets_the_keys`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_names_titles_and_urls_are_bidi_isolates`](../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_typing_in_a_field_waits_for_ctrl_b_shift_a`](../tests/browser/browser_vimma_mcp_prompt.js),
  [`test_a_window_not_in_front_gets_attention_and_a_notification`](../tests/browser/browser_vimma_mcp_control.js),
  [`any other key neither allows nor denies`](../packages/vimma-core/test/agent-prompt.test.mjs),
  [`a hostile title of 300 characters is literal text cut at 60 columns`](../packages/vimma-core/test/agent-prompt.test.mjs)
- M5. Grants **must** be per connection and tool, capped at `[mcp] grant_max_minutes`, held in
  memory only, and end on `:mcp revoke`, when their connection closes, on `:mcp off` and at
  expiry.
  [`grants end on revoke and on disconnect, and are listed shortest first`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`the length: a count, or the default for a bare a, capped at grant_max_minutes`](../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_grants_per_connection_and_tool`](../tests/browser/browser_vimma_mcp_agent.js),
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
  [`a grant of the tool does not run it: it waits`](../packages/vimma-core/test/agent-gate.test.mjs),
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

## 14. Build and release supply chain (`release.yml`, `aur.yml`, `homebrew.yml`, `nightly.yml`, `macos.yml`)

Vimma's binaries are built from Mozilla's Firefox source, this repository, and the npm packages
that drive the build, chiefly Surfer. These rules keep what reaches a build pinned and reviewed.
Spec: [build-supply-chain](specs/build-supply-chain.md), [ADR-001](adr/001-engine-firefox-surfer.md).

**Reach:** Mozilla's archive and Taskcluster, the npm registry, this repository, and GitHub's
hosted runners. Dependabot pull requests run and auto-merge today, whether or not a build runs.

The macOS build, `macos.yml` ([ADR-018](adr/018-macos-cross-build.md)), also runs on pull
requests that touch it. It holds no secret and only a read-only token, builds on hosted runners
under B1, B2 and B5 like the release build, and adds one download, rcodesign, pinned by SHA-256.
Its ad hoc signature proves nothing about who built the app.
`release.yml`'s macOS jobs, which run only while the variable `MACOS_RELEASE_ENABLED` is `true`,
hold every rule below that the Linux jobs hold: the same tag checks, the `build` environment for
the key, cosign under the same identity, and the same refusal to replace a published release's
files (B6, B9, B10). No Linux job needs them, so a macOS failure holds back no Linux release.
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
  and installed with `makepkg -si` on Arch Linux before anything is signed. **⚠ setting:**
  signatures exist only while the repository variable `SIGNING_ENABLED` is `true`; without it
  `publish` uploads the assets and `SHA256SUMS` unsigned. The macOS `.dmg` and its Homebrew cask
  `vimma.rb` are listed in their own `SHA256SUMS-macos`, so `SHA256SUMS`, which `aur.yml` and the
  update manifest read, never changes when they are added; `macos-sign` signs all three with the
  same identity, after a hosted Mac has checked the checksum, the signature, the version line,
  Vimma's icon catalog and the bundle identifier, and has installed the `.dmg` through the cask.
  The macOS icon files in `configs/branding/vimma/` are binaries in the tree;
  `macos.yml` regenerates them from their sources and fails if they differ. `firefox.icns`,
  `document.icns` and the layer image inside `Assets.car` are compared byte for byte. The
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
  [`builds and installs the release PKGBUILD on Arch Linux before anything is signed`](../tools/package/test/release-workflow.test.mjs),
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
  a stub `.dmg` on every pull request that changes `tools/package/`. `homebrew.yml` runs only by
  `workflow_dispatch` from `main`, and only while `MACOS_RELEASE_ENABLED` is `true`; it holds no
  GitHub token, runs no repository code, and takes `vimma.rb` only from the release's public
  download URLs, which answer 404 for a draft. It checks the cask against `SHA256SUMS-macos` and
  its version against the tag, and with signing on checks `SHA256SUMS-macos` against
  `IDENTITY_REGEXP` before it pushes over SSH to github.com, whose host key is pinned. It pushes
  only `Casks/vimma.rb`, never with `--force`, and never replaces a newer cask with an older one.
  `release.yml`'s `macos-tap` job, which holds only `actions: write` and runs no repository code,
  starts `homebrew.yml` on `main` once the cask is on a published release, since the macOS files
  usually arrive after the publish. The tap's key is a write deploy key of the tap alone, a secret
  of the `homebrew` environment, which only `main` may use. No tag may deploy to it (as in B6): a
  tag ruleset restricts moving a tag, not creating one, and a run's workflow file and its `if:`
  come from its ref, so a tag on an unmerged commit could carry a `homebrew.yml` that skips every
  check and pushes any Ruby to the tap. `homebrew.yml` has no `release` trigger for the same
  reason, since a release event runs the tag's copy of the file. **⚠ setting:** the `homebrew`
  environment's only deployment policy is the branch `main`. **⚠ setting:** the tap's
  ruleset on `main` forbids deletion and force pushes and requires a pull request; deploy keys
  bypass it, so the workflow pushes directly, and admins bypass it only through a pull request
  (docs/runbook.md, "Release packages", step 7). **⚠ limit:** the `.dmg` is ad hoc signed and not
  notarised, so Gatekeeper cannot vouch for it; the cask's caveats tell users to choose Open Anyway
  in System Settings, and never to remove the quarantine flag.
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
  [`runs only by dispatch with a tag, never for a release event or a tag ref`](../tools/package/test/release-workflow.test.mjs),
  [`job %s runs only when the macOS release is enabled, here, from main`](../tools/package/test/release-workflow.test.mjs),
  [`a release without the cask is an error`](../tools/package/test/release-workflow.test.mjs),
  [`the download step refuses %s`](../tools/package/test/release-workflow.test.mjs),
  [`checks SHA256SUMS-macos's signature against the documented identity when signing is on`](../tools/package/test/release-workflow.test.mjs),
  [`takes the tap key from the homebrew environment`](../tools/package/test/release-workflow.test.mjs),
  [`the tap key reaches only the push step`](../tools/package/test/release-workflow.test.mjs),
  [`pushes Casks/vimma.rb to the tap over SSH with github.com's pinned host key`](../tools/package/test/release-workflow.test.mjs),
  [`never replaces a newer cask with an older one`](../tools/package/test/release-workflow.test.mjs)

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
  [`private_tabs_never_reach_a_normal_window_and_back`](../tests/browser/browser_vimma_live_grep.js),
  [`all_windows_searches_the_other_windows_and_enter_goes_there`](../tests/browser/browser_vimma_live_grep.js),
  [`a_window_sessionstore_does_not_track_is_skipped`](../tests/browser/browser_vimma_live_grep.js)
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
  [`agent_tabs_only_in_window_scope_marked_and_last`](../tests/browser/browser_vimma_live_grep.js),
  [`agent workspace rows are marked and come last`](../packages/vimma-core/test/grep.test.mjs),
  [`a closed window takes the agent marking of the tab it shows`](../packages/vimma-core/test/grep.test.mjs)
- L5. Page text **must not** outlive the picker: when it closes, every frame the query was sent
  to is told to drop its text model, its observer and its worker, whether or not it answered;
  the parent keeps no rows; the grep list holds only the lines it shows, in memory, never on
  disk or in the session store, and drops a tab's lines when the tab or its window closes, and
  stops watching a closed window. The recently closed titles and URLs a search sends to the
  parent's worker are held under one key a picker session and dropped when the picker closes.
  [`closing_tells_every_searched_frame_to_drop_its_text`](../tests/browser/browser_vimma_live_grep.js),
  [`a_reply_held_past_close_still_gets_grep_end`](../tests/browser/browser_vimma_live_grep.js),
  [`the_grep_list_steps_with_bracket_q_and_grep_resumes`](../tests/browser/browser_vimma_live_grep.js),
  [`pruneGrepList drops a closed tab's rows and keeps its place`](../packages/vimma-core/test/grep.test.mjs),
  [`the_grep_list_drops_a_closed_windows_lines`](../tests/browser/browser_vimma_live_grep.js),
  [`the_closed_titles_have_one_matcher_key_until_close`](../tests/browser/browser_vimma_live_grep.js)
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
  [`a_catastrophic_pattern_on_closed_titles_never_freezes_the_browser`](../tests/browser/browser_vimma_live_grep.js),
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
to show the update command. It downloads and installs nothing. Who can reach it: whoever
controls the update host or the network path (TLS stops the path), _you_ through `about:config`
and `config.toml`, and the control socket's full role (`app.update_check`, as it can run
`app.quit`). The agent role reaches no action, so a local AI agent cannot trigger a check.
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
  more than a day ahead of the clock, and an older or equal build is **never** offered
  (downgrade). Withholding updates or serving an old
  manifest for long is what a compromised host can still do; the feed's age shows after 45 days
  (7 for nightly).
  [`channel and target mismatches are refused`](../packages/vimma-core/test/updates.test.mjs),
  [`replay: a serial below the one accepted, or below this build, is refused; equal is accepted`](../packages/vimma-core/test/updates.test.mjs),
  [`downgrade: an older or equal build is no offer, not an error`](../packages/vimma-core/test/updates.test.mjs),
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
- UP6. A package manager's install (the `.deb`, the release `PKGBUILD`, the AUR's `vimma-bin`)
  is **never** told to unpack a tarball over its install directory: every package except the
  tarball carries the `is-packaged-app` marker with its package type, the release refuses a
  `./mach package` tarball that already has one, and only an install without a marker gets the
  tarball's command. The release workflow's smoke test checks the type of the installed `.deb`
  and, without `$APPIMAGE`, of the extracted AppImage, and that the tarball has no marker.
  [`every package type except the tarball carries the marker`](../tools/package/test/package.test.mjs),
  [`gives each package type its own update hint, and only the tarball an untar`](../tools/package/test/package.test.mjs),
  [`a tarball that already carries an install-source marker`](../tools/package/test/package.test.mjs),
  [`the .deb and AppImage smoke test checks each install type, and the tarball's lack of one`](../tools/package/test/release-workflow.test.mjs)
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
  empty manifest that offers nothing. Publishing a release starts a job that holds only
  `actions: write` and runs no repository code; it starts the workflow again on `main`, so the
  file that signs is always `main`'s, never a tag's. The signing job is the **only** job with
  `id-token: write`, uses the `update-signing` environment (deployment branch `main` alone), and
  runs no repository code: it checks the body's shape with the shell, signs the SHA-384
  DigestInfo with Cloud KMS and checks the signature with openssl. The job that builds the body
  holds no secret and installs no dependency. Before anything is pushed, a separate job checks
  the signed file with the verifier and the pinned key the browser uses and with openssl. Every
  file named in the manifest **must** match the release's `SHA256SUMS`, which **must** carry
  release.yml's cosign signature (an unsigned release gets no manifest), and is downloaded again after
  signing and checked against the signed size and SHA-512. A serial that is not newer than the
  published manifest's, a serial more than a day ahead of the clock, and an offer older than the
  published one are refused. The push uses a deploy key that can write only to
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
  [`signs the body so that the browser's verifier accepts it under the KMS key`](../tools/update/test/update-workflow.test.mjs),
  [`refuses to sign %s`](../tools/update/test/update-workflow.test.mjs),
  [`every asset must be listed with the hash of the file that was downloaded`](../tools/update/test/manifest.test.mjs),
  [`must be newer than the published manifest's; equal or older is refused`](../tools/update/test/manifest.test.mjs),
  [`checkSigned refuses another key, a changed file, an older serial and another version`](../tools/update/test/manifest.test.mjs),
  [`refuses to offer an older version than the published manifest does`](../tools/update/test/manifest.test.mjs),
  [`downloads the target's files and sums, and passes the target to manifest.mjs`](../tools/update/test/update-workflow.test.mjs),
  [`checks a macOS body against the macOS target, and refuses a Linux one there`](../tools/update/test/update-workflow.test.mjs),
  [`runs one manifest per target at a time, never cancelling one half done`](../tools/update/test/update-workflow.test.mjs),
  [`refuses a .dmg that does not match SHA256SUMS-macos`](../tools/update/test/manifest.test.mjs),
  [`checkSigned takes the target: a Linux manifest is refused for macOS and back`](../tools/update/test/manifest.test.mjs),
  [`macos-tap starts the macOS update manifest once the .dmg is on a published release`](../tools/package/test/release-workflow.test.mjs)
- UP8. A command about:vimma shows **never** installs or replaces anything with a file it has not
  checked: every download uses `curl -f` (an HTTP error stops it) and `--proto =https`, and when
  the signed manifest gives the file's SHA-512, `sha512sum -c` checks it before `apt`, `tar` or
  `mv` runs. A tarball is downloaded to a file and checked before it is unpacked, never piped
  into `tar`. Asset hashes are read only from the signed manifest, only as 128 lower-case hex
  digits, and a saved result keeps only well-formed ones. **⚠ limit:** the release `PKGBUILD`'s
  command still fetches `latest/download/PKGBUILD` without a hash of its own; `makepkg` checks
  the tarball against the SHA-256 that `PKGBUILD` pins.
  [`every download fails on an HTTP error and refuses anything but https (V-07)`](../packages/vimma-core/test/updates.test.mjs),
  [`the checked commands run: a matching file installs, a different one stops before`](../packages/vimma-core/test/updates.test.mjs),
  [`reads each package's size and SHA-512 (the release pipeline's asset elements)`](../packages/vimma-core/test/updates.test.mjs),
  [`offerAssets keeps only well-formed entries (a saved result read back)`](../packages/vimma-core/test/updates.test.mjs),
  [`update_command_opens_the_steps`](../tests/browser/browser_vimma_update_check.js)
- UP9. The security update question (`Show the update command? (y/N)`) is **never** answered by
  a key pressed before it armed: keys count only `security.dialog_enable_delay` (1,000 ms) after
  it appears or after its window comes to the front or leaves it, an earlier key starts the
  delay again, and a held key never answers. It **never** takes focus, **never** opens while
  focus is in a field, while another Vimma overlay, the agent question or a Firefox permission
  prompt is open, or in a private window; a key that arrives while focus is in a field or a page
  is in DOM full screen is **never** taken as an answer; and `y` **only** opens about:vimma's Updates section: nothing is installed or
  run. The one-time message is a notice that takes no focus and no keys.
  [`a_security_update_asks_once_per_session`](../tests/browser/browser_vimma_update_notices.js),
  [`early_and_held_keys_never_answer`](../tests/browser/browser_vimma_update_notices.js),
  [`another_window_in_front_arms_it_again`](../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_for_an_open_overlay`](../tests/browser/browser_vimma_update_notices.js),
  [`y_shows_the_update_steps_and_esc_dismisses`](../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_while_the_user_types`](../tests/browser/browser_vimma_update_notices.js),
  [`no_question_in_a_private_window`](../tests/browser/browser_vimma_update_notices.js),
  [`a_new_version_is_announced_once`](../tests/browser/browser_vimma_update_notices.js),
  [`y or Y shows the steps; n, Esc, Enter and any other key dismiss`](../packages/vimma-core/test/update-notices.test.mjs)

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
still name only the project's own release downloads (UP5), and nothing is installed by the check.
It can also mark such an offer as a security release, and hold back genuine manifests for up to a
day by signing a serial ahead of the clock (UP2).
