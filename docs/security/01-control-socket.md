## 1. Control socket (`ctl/VimmaControl.sys.mjs`)

Lets `vimma-ctl` and scripts drive Vimma: send keys, read state, open a URL, reload the theme.
Since protocol 2 it also lets local AI agents use the agent workspace (the `agent` role, §12).
Specs: [m0-control-server](../specs/m0-control-server.md),
[m0-control-protocol-and-vimma-ctl](../specs/m0-control-protocol-and-vimma-ctl.md),
[vimma-mcp](../specs/vimma-mcp.md), [ADR-007](../adr/007-control-socket.md),
[ADR-019](../adr/019-agents-over-mcp.md).

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
  [`test_pref_starts_and_stops_the_server`](../../tests/browser/browser_vimma_control.js),
  [`test_agent_role_has_its_own_switch`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../../tests/browser/browser_vimma_agent_cli.js)
- S2. It **must** listen on 127.0.0.1 only, never on another interface.
  [`test_pref_starts_and_stops_the_server`](../../tests/browser/browser_vimma_control.js)
- S3. The token file **must** be mode 0600 from its first byte, and `vimma-ctl` **must** refuse
  one that others can read.
  [`test_pref_starts_and_stops_the_server`](../../tests/browser/browser_vimma_control.js),
  [`refuses_a_file_others_can_read`](../../tools/vimma-ctl/src/discovery.rs),
  [`refuses_an_insecure_discovery_file`](../../tools/vimma-ctl/tests/cli.rs)
- S4. No command **must** run before the HMAC handshake; a wrong token is refused and the
  connection closed; the token is never sent before the server proved it knows it. A ticket's
  handshake is the same with the ticket as the key: its hello names the ticket only by its id,
  HMAC-SHA256(ticket, `vimma-ticket` NUL), and the ticket is sent only after the server's proof;
  an auth carries a token or a ticket, never both.
  [`test_handshake`](../../tests/browser/browser_vimma_control.js),
  [`challenge.valid's proof is HMAC-SHA256(token, vimma-server NUL nonce)`](../../packages/vimma-core/test/control.test.mjs),
  [`a_squatter_gets_neither_the_token_nor_a_command`](../../tools/vimma-ctl/tests/cli.rs),
  [`an agent hello with a ticket validates; a ticket and a token together do not`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`a_ticket_handshake_proves_the_server_first`](../../tools/vimma-ctl/tests/mcp.rs)
- S5. It **must** cap connections (8 open, of which at most 4 agents; 2 waiting for a hello),
  line length (1 MiB) and handshake and idle time. A ticket's connection counts toward the 8
  but not the 4 agents, so MCP agents cannot keep out a task Vimma started; a ticket has one
  connection at a time (M51).
  [`test_limits`](../../tests/browser/browser_vimma_control.js),
  [`test_agents_cannot_take_every_connection`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_mcp_agents_cannot_keep_out_a_ticket`](../../tests/browser/browser_vimma_agent_cli.js)
- S6. A token file left by a crash **must** be removed at start; a symlink or directory in its
  place is never followed. [`test_stale_discovery_file_removed_at_start`](../../tests/browser/browser_vimma_control.js)
- S7. Only the commands of the connection's role **must** run (`full`: the four of protocol 1;
  `agent`: the seven agent commands); anything else, and any unknown argument, is refused.
  [`test_handshake`](../../tests/browser/browser_vimma_control.js),
  [`protocol version 1 with the commands of ADR-007`](../../packages/vimma-core/test/control.test.mjs),
  [`protocols 1 and 2, two roles, the agent commands apart from v1's`](../../packages/vimma-core/test/control-v2.test.mjs),
  [`test_each_role_runs_only_its_commands`](../../tests/browser/browser_vimma_mcp_agent.js)
- S8. `reload-theme` **never** takes an argument; it reads only the theme folder Vimma's own
  prefs name. [`test_reload_theme`](../../tests/browser/browser_vimma_control.js),
  [`takes no args`](../../packages/vimma-core/test/control.test.mjs)
- S9. `state` **must** be read-only: it changes no tab, selection, mode or workspace, and never
  gives an unloaded tab its browser. In a private window it **never** reports a tab's URL or
  title; it keeps each tab's id, place, selection, pinning and whether its page is still loading,
  and the pane structure of every split (`panes` and `splits`, tab ids and places only). Its
  `update` field is an allow-list of the update check's result (whether checks are on, the
  install type, the outcome and its time, the offered version and build ID, how far the update
  got) and **never** carries the reason of a refusal, the manifest's serial or key, a URL or an
  advisory; reading it starts no check and no download. Its `notice`, `prompt`, `chat` and `agent`
  fields say what is on screen for a moment as flags and counts only (whether a notice or the
  prompt line shows; the agent chat window's view, how many list rows and transcript entries it
  draws, whether a question waits in its slot and is armed; the status bar's count of waiting
  questions and its ran dot) and **never** carry text: no notice, prompt, row label, entry,
  question or agent name reaches the socket through them, and `chat` is `null` in a private
  window, where the chat window never opens. Its `agent.armed` flag says only whether the agent
  question line shows its keys hint (reported only while the bar draws the agent segment), and
  its `downloads` field only which `↓` segment the status bar draws, as one word of a fixed list
  (`progress`, `paused`, `done`, `failed`, `blocked`) or `null`; it **never** carries a file's
  name, size, URL or site, and is `null` in a private window. Its `grep` and `urlbar` fields
  are one flag each (live grep's search, preview or jump still to come; the address bar's
  suggestion list drawn for the text last searched) and **never** carry the query, the typed
  text, a count of matches or results, or a row; both are `null` in a private window. Its `pdf`
  field is one flag, whether the selected tab's PDF viewer has drawn the pages in its view, and
  `null` unless that tab shows the viewer; it **never** carries the page, the page count, the
  document's title or URL, or the outline, and is `null` in a private window. The viewer's own
  report of its drawing (section 20, V6) only ever turns that flag; a viewer that lies about it
  changes when a script's wait ends, nothing else.
  [`control_state_is_read_only`](../../tests/browser/browser_vimma_security_invariants.js),
  [`test_state_splits`](../../tests/browser/browser_vimma_control.js),
  [`test_state_update`](../../tests/browser/browser_vimma_control.js),
  [`controlUpdateState keeps only the fields the protocol names (m6a-updater 41)`](../../packages/vimma-core/test/control.test.mjs),
  [`the_private_workspace_keeps_two_splits_and_state_names_no_page`](../../tests/browser/browser_vimma_private_workspace.js),
  [`control_state_never_inserts_a_lazy_tab`](../../tests/browser/browser_vimma_security_invariants.js),
  [`vimma_ctl_state_withholds_private_urls_and_titles`](../../tests/browser/browser_vimma_private_workspace.js),
  [`vimma_ctl_state_says_whether_a_private_tab_is_loading`](../../tests/browser/browser_vimma_private_workspace.js),
  [`notice, prompt, chat and agent, when present, are flags and counts only`](../../packages/vimma-core/test/control.test.mjs),
  [`test_state_reports_the_window_and_the_notice_as_drawn`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_state_names_each_top_level_field`](../../tests/browser/browser_vimma_control.js),
  [`agent.armed is a flag, and downloads a word from a closed list or null`](../../packages/vimma-core/test/control.test.mjs),
  [`test_state_reports_the_line_armed_as_drawn`](../../tests/browser/browser_vimma_mcp_prompt_guards.js),
  [`test_state_reports_the_segment_as_drawn`](../../tests/browser/browser_vimma_downloads.js),
  [`grep and urlbar are one flag each, or null`](../../packages/vimma-core/test/control.test.mjs),
  [`test_state_reports_live_grep_as_drawn`](../../tests/browser/browser_vimma_state_waits.js),
  [`test_state_reports_the_suggestion_list_as_drawn`](../../tests/browser/browser_vimma_state_waits.js),
  [`test_a_query_under_way_is_not_settled_even_heard_late`](../../tests/browser/browser_vimma_state_waits.js),
  [`test_state_reports_a_grep_jump_until_it_has_drawn`](../../tests/browser/browser_vimma_state_waits.js),
  [`pdf is one flag, or null`](../../packages/vimma-core/test/control.test.mjs),
  [`pdfDrawn`](../../packages/vimma-core/test/pdf.test.mjs),
  [`test_state_reports_the_pdf_viewer_as_drawn`](../../tests/browser/browser_vimma_state_waits.js)
- S10. `open` **must** load only http, https, file and about URLs of at most 64 KiB, checked by
  the server itself, never only by the client.
  [`test_server_checks_the_scheme_itself`](../../tests/browser/browser_vimma_control.js),
  [`test_open`](../../tests/browser/browser_vimma_control.js)
- S11. Whatever bytes a client sends, the server's framing and validator **never** throw, hang
  or change a built-in prototype; the framing gives back exactly the lines sent and refuses a
  line over 1 MiB, and a message outside the protocol is refused.
  [`LineFramer gives back the lines sent, however the bytes are chunked`](../../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`any line a client sends, decoded as the server does, validates without throwing`](../../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`every valid message validates; one changed or added field makes it invalid`](../../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`send-keys passes only keys the server can parse; open only short http(s), file and about URLs`](../../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`a type that is not a string is an error, never a throw`](../../packages/vimma-core/test/control.test.mjs),
  [`agent-open passes only short http(s) URLs; agent labels never carry control or bidi characters`](../../packages/vimma-core/test/fuzz/control.fuzz.test.mjs),
  [`test_handshake`](../../tests/browser/browser_vimma_control.js)
- S12. The `full` role **must** run only with `vimma.control.enabled`, and the `agent` role only
  with MCP on; a hello for a role that is off is refused (`role-off`) and closed, and turning a
  switch off closes that role's connections. An agent connection **never** reaches `send-keys`,
  `state` or protocol 1's `open`. A ticket's connection is the agent role whatever the
  switches say, is not closed by a switch, and ends with its ticket (M51-M54).
  [`test_agent_role_has_its_own_switch`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_each_role_runs_only_its_commands`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`says_the_control_socket_is_off_when_only_mcp_is_on`](../../tools/vimma-ctl/tests/cli.rs),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../../tests/browser/browser_vimma_agent_cli.js)
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
  [`test_full_control_asks_only_while_mcp_is_on`](../../tests/browser/browser_vimma_mcp_control.js),
  [`prints_and_sends_a_code_while_mcp_is_on`](../../tools/vimma-ctl/tests/cli.rs),
  [`the_code_is_shown_only_after_its_auth_was_sent`](../../tools/vimma-ctl/src/client.rs),
  [`a time ahead, within 1440 minutes and a minute: control stays on until then`](../../packages/vimma-core/test/agent-prompt.test.mjs),
  [`test_control_on_minutes_turns_itself_off`](../../tests/browser/browser_vimma_mcp_control.js),
  [`waits_for_the_users_answer_while_mcp_is_on`](../../tools/vimma-ctl/tests/cli.rs),
  [`reports_refused_full_control_with_exit_4`](../../tools/vimma-ctl/tests/cli.rs)
- S14. Without `--profile` or `VIMMA_PROFILE`, `vimma-ctl` **must** read the discovery file only
  from the default profile in the `profiles.ini` where Firefox keeps it on that platform:
  `~/Library/Application Support/Vimma/` on macOS, where `XDG_CONFIG_HOME` does not move it, and
  `$XDG_CONFIG_HOME/vimma/vimma/` (or `~/.config/vimma/vimma/`, or the legacy `~/.vimma/vimma/`)
  on Linux. Its check that the file's pid still runs (`/proc` on Linux, `/bin/ps` on macOS) is
  only a hint: a reused pid passes it, and S4's handshake is what keeps the token from a process
  on the port. `vimma-ctl` runs `/bin/ps` by absolute path, never through `PATH`, and the
  caller's name it takes from it (`vimma-ctl mcp`) is a label, never proof (§12).
  [`profiles_root_finds_application_support_vimma_on_macos`](../../tools/vimma-ctl/src/discovery.rs),
  [`xdg_config_home_does_not_move_the_macos_profile_root`](../../tools/vimma-ctl/src/discovery.rs),
  [`a_discovery_file_whose_pid_has_exited_is_stale_on_every_unix`](../../tools/vimma-ctl/src/discovery.rs),
  [`ps_tells_a_running_pid_from_an_exited_one`](../../tools/vimma-ctl/src/discovery.rs),
  [`name_from_ps_keeps_the_executable_name`](../../tools/vimma-ctl/src/mcp_serve.rs)
