### The built-in agent (`agent/AgentChat.sys.mjs`, `agent/AgentKeys.sys.mjs`, `agent/AgentStore.sys.mjs`)

Vimma's own agent ([builtin-agent](../specs/builtin-agent.md),
[ADR-023](../adr/023-in-browser-model-client.md)): a model the user picks, local or hosted, runs
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
  [`test_works_with_mcp_off_and_enter_grants_without_a_question`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`a built-in connection's grant does not cover another conversation`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`:mcp off ends the MCP grants and leaves a conversation's`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`the built-in connection ids are the only ones that say built-in`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`every agent tool has its command, and nothing else does`](../../packages/vimma-core/test/agent-results.test.mjs)
- M36. A conversation **must** see and act only on the agent tabs it owns (opened, given, or
  opened from one it owns) and **must** be refused another tab with the error a tab outside the
  agent workspace gets; an MCP agent **must** see and act only on the agent tabs no conversation
  owns. Ownership is kept in memory by tab, so a tab keeps its owner when it is unloaded and
  when its opener closes; after a restart no tab is owned.
  [`test_two_conversations_see_only_their_tabs`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_an_unloaded_tab_stays_its_conversations`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_tabs_opened_from_an_owned_tab_stay_owned`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_mcp_agent_sees_only_unowned_tabs`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`a tab belongs to the conversation that opened it`](../../packages/vimma-core/test/agent-owners.test.mjs),
  [`a tab a page opened belongs to its opener's conversation`](../../packages/vimma-core/test/agent-owners.test.mjs)
- M37. A conversation's grant **must** be made only by the user sending a task without asking
  every step (`Enter`) or by an answer to its question; it **must** have no timer, **must** end
  when the task it was made for ends (done, stopped, at its budget or on an error), on a send
  that asks every step (`ctrl+Enter`), on stopping the conversation, on
  `ctrl+b shift+a`, on `:mcp revoke` and when the conversation is deleted, and **must never**
  cover another conversation. Form submissions that M28 makes ask, payment steps, `vimma_show`
  and the downloads that always ask **must** ask under it (M19, M28, M33).
  [`test_ctrl_enter_asks_every_step_and_ends_the_grant`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_grant_ends_with_its_task_and_enter_grants_again`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_checkpoint_and_show_ask_under_the_conversation_grant`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`a conversation grant has no expiry and ends on stop`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`a conversation grant leaves checkpoints asking`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`:mcp revoke ends a conversation grant as any other`](../../packages/vimma-core/test/agent-gate.test.mjs)
- M38. An `agent-hello` whose client name starts with `built-in` (in any case, with any
  separator or none, after invisible characters or in compatibility forms) **must** be shown
  with ` (mcp)` after it, so no other program passes as the built-in agent in a question, a
  notice or `:mcp log`. Look-alike letters of other scripts are not caught; the name is a label
  and grants nothing.
  [`a client named built-in over MCP is shown with (mcp)`](../../packages/vimma-core/test/agent-gate.test.mjs),
  [`test_mcp_agent_sees_only_unowned_tabs`](../../tests/browser/browser_vimma_agent_conversations.js)
- M39. Model requests **must** go only to the configured endpoint, `https://` unless on a
  loopback address, with `credentials: "omit"` and `redirect: "error"`; `[agent] local_only`
  **must** refuse every endpoint off this machine, in config.toml and at each request. Setup's
  probe **must** ask only 127.0.0.1 on the local servers' ports and the configured providers'
  own loopback endpoints, with a timeout of 1 s, and only while the model picker is open. The
  check before a task that a local model is still listed **must** ask only the conversation's
  own loopback endpoint, and never an endpoint off this machine. Setup's look at where a picked
  local model runs **must** ask only Ollama's port on this machine, once, after the pick, with a
  generate request that names the model and carries no prompt, then `/api/ps`.
  [`test_requests_only_to_the_endpoint_without_credentials_or_redirects`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`posts to the endpoint without credentials or redirects, and parses the reply`](../../packages/vimma-core/test/agent-providers.test.mjs),
  [`a refused endpoint makes no request`](../../packages/vimma-core/test/agent-providers.test.mjs),
  [`local_only refuses a remote endpoint`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`an endpoint off this machine must be https, and carry no user name`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`lists the models of the servers that answer, with no cookies and no redirects`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`the probe also asks the configured local endpoints, once each, never a remote one`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`a provider off this machine, or Anthropic's API, gets no request`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`its server lists it, or no longer does`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`loads the model with no prompt, then reads its GPU share and context from ps`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`asks only Ollama on this machine`](../../packages/vimma-core/test/agent-setup.test.mjs),
  [`test_probe_only_on_setup_and_only_loopback`](../../tests/browser/browser_vimma_agent_conversations.js)
- M40. An API key **must** be stored only as a `chrome://vimma-agent` login holding the key and
  the endpoint origin it was entered for, encrypted with OSKeyStore, and **must** be sent only to
  that origin (a provider whose endpoint config.toml changes gets no key), and **must never** be
  in a pref, config.toml (a key field there is a
  config error that does not repeat the value), a file of Vimma's, `:mcp log`, a notice, the
  conversation or an error text (a provider's error is cut at 200 characters with the key
  replaced by `•••`); it goes only into the provider's request header.
  [`test_key_stored_as_a_login_only`](../../tests/browser/browser_vimma_agent_keys.js),
  [`test_stored_login_holds_only_the_keystore_ciphertext`](../../tests/browser/browser_vimma_agent_keys.js),
  [`test_key_never_in_log_notice_or_error`](../../tests/browser/browser_vimma_agent_keys.js),
  [`test_key_deleted`](../../tests/browser/browser_vimma_agent_keys.js),
  [`test_a_key_goes_only_to_the_endpoint_it_was_stored_for`](../../tests/browser/browser_vimma_agent_keys.js),
  [`a key field in [agent] is an error, with its line`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`the key's value never appears in the error`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`a provider error is cut and never contains the key`](../../packages/vimma-core/test/agent-providers.test.mjs)
- M41. At most `[agent] max_running` conversations (default 3) **must** run a task at once. A
  task **must** stop at its budget (`max_steps`, `max_tokens`, `max_cost`), which nothing the
  model writes raises, and after the same call has its arguments refused or is denied three
  times in a row; `ctrl+b shift+a`
  with no question waiting **must** stop every running task.
  [`test_max_running`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`test_ctrl_b_shift_a_stops_every_task`](../../tests/browser/browser_vimma_agent_conversations.js),
  [`a task stops at max_steps`](../../packages/vimma-core/test/agent-budget.test.mjs),
  [`a task ends after the same call is refused three times in a row`](../../packages/vimma-core/test/agent-loop.test.mjs),
  [`max_running and keep_days parse within their bounds`](../../packages/vimma-core/test/config-agent.test.mjs)

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
  [`test_reply_rendered_as_text`](../../tests/browser/browser_vimma_agent_chat.js),
  [`bidi overrides and control characters go; line breaks and tabs stay`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`a reply line starting with a question glyph is indented under the agent label`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`a step the gate says nothing of shows the loop's own name for it`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`a tool name the model made up stays on one line, cut short`](../../packages/vimma-core/test/agent-chat.test.mjs)
- M43. A question of the open conversation **must** show only in the window's prompt slot, an
  element outside the transcript that only `host/agent-ui.mjs` fills from `AgentGate`, and in
  one place at a time (the question line when the window is closed or open on another
  conversation). The slot **must** take keys only while focus is in the window and only once
  armed (`security.dialog_enable_delay`, M4), arming again whenever focus comes into the window
  from outside it; while it shows, the input **must** be read-only and
  `Enter` **must not** send; nothing typed in the input and nothing the model writes **must**
  answer a question, make a grant or fill the slot.
  [`test_question_in_the_prompt_slot_and_never_answered_by_the_input`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_question_on_the_question_line_when_closed`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_slot_arms_again_when_focus_comes_back_into_the_window`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_shift_enter_adds_a_line_and_ctrl_enter_asks`](../../tests/browser/browser_vimma_agent_chat.js)
- M44. Giving a tab to a conversation (`P`, `:agent give`) **must** move a tab of another
  workspace to the agent workspace only after a `y`, reopened there with the agent workspace's
  container and without its history, and only if that tab is still selected and the agent
  workspace unchanged at the answer; a tab another conversation owns **must not** be given.
  Opening the window from a workspace **must not** let the agent read that workspace's tabs
  where they are: only a tab moved to the agent workspace reaches it.
  [`test_give_moves_the_tab_after_y_and_makes_it_the_conversations`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_opened_from_another_workspace_reads_none_of_its_tabs`](../../tests/browser/browser_vimma_agent_chat.js)
- M45. Before a conversation's first task to an endpoint off this machine (and again after its
  provider changes), the window **must** say where page text, field values, screenshots and the
  user's messages go and send nothing without a `y` to that endpoint; `AgentChat.send` itself
  **must** refuse a task the notice was not answered for. A message whose provider's key is
  still being read when the user leaves the transcript **must not** be sent, nor its notice
  asked: it stays in the input, and a notice says so. A second Enter while that key is read
  **must not** send the message again (nor as steering into the task the first one starts): it
  stays in the input, and a notice says so. A message edited while its key is read **must
  not** be sent, neither the text of the first Enter nor the edit: the edit stays in the input,
  and a notice says so. Text in the input belongs to the conversation it
  was typed in: switching conversations keeps each one's input apart, and a message that was
  not sent or was refused goes back to its own conversation's input, never to the one shown
  after a switch, so Enter sends nothing to a provider it was not written for; a notice names
  the conversation that keeps it. Text put back goes before what the user typed since, never
  over it, and the notice says where it is. A conversation deleted while its message waits
  takes the message with it, and `:agent forget all` leaves no text for the next conversation.
  [`test_external_provider_notice_before_first_task`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_a_send_waiting_for_its_key_hint_is_sent_only_if_the_user_stayed`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_second_enter_while_a_send_reads_its_key_sends_nothing_twice`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_message_kept_unsent_stays_with_its_own_conversation`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_refused_send_keeps_both_its_message_and_what_was_typed_since`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_message_edited_while_its_key_is_read_is_not_sent`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_conversation_deleted_while_its_key_is_read_takes_its_message`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_forget_all_leaves_no_text_for_the_next_conversation`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`the notice before the first task names the host and, when known, who runs it`](../../packages/vimma-core/test/agent-chat.test.mjs)
- M46. A hosted provider's key **must** be typed only into the window's password field, which
  hands it to `AgentKeys` (M40) and is emptied at once; the key **must not** be drawn in the
  window, the transcript, the status bar or a notice (which may show its last four characters),
  nor kept in a pref or the conversation, and an error storing it **must not** be shown with its
  text, nor recorded in Vimma's key log or its debug output. The field **must not** reveal the
  key: it has no reveal button, cancels every reveal a user can ask for (`MozWillToggleReveal`), opens no context
  menu, and gives up nothing to copy, cut or drag; it never holds a stored key, so changing a
  key means entering it again. Any way out of the field (Esc, closing the window or the
  browser window, another view or conversation, another provider's key field) empties it and
  forgets which provider it was for, leaving nothing to bring back with an undo. A model pick,
  a send, a send's refusal or a key's store that answers after the user left the list or the
  field it came from (a key hint can wait on the keyring, a local model's preparation for a
  minute; a prompt line a picker row opens, and focus moving out of the window to a page, the
  address bar or anywhere else, count as leaving; the browser window losing OS focus, as to a
  keyring prompt, does not) **must not** switch the view or move focus, so it never opens the
  key field or the picker over another view nor takes focus from the field, prompt or page the
  user is typing in: the pick is not used, the message is not sent (or, refused, stays in the
  input), each with a notice, and the stored key changes no conversation's model, which its
  notice says, with how to use the key (unless the key was asked for the shown conversation's
  own model) and never the key's text; of two picks, the later is used. A key stored after focus left the window leaves the transcript shown, unfocused,
  instead of an empty key field for no provider. Opening the window the first time, which
  waits for the stored conversations to be decrypted, **must not** take focus from a user who
  moved meanwhile to another field of the window's chrome (the address bar, the command line)
  or to another tab: it opens without focus, and what was to follow is not done, with a notice
  (`:agent give`'s question is not asked; `:agent forget all`'s y/N is not asked, so a typed y
  deletes nothing). A move between two fields of the same page, or inside one shadow host, is
  not seen by this check, as the chrome document's focused element stays the same. A second key entered while one is being stored is
  not stored, and a notice without its text says so. A provider that needs a key and has none
  for its endpoint **must** be asked for it, and `AgentChat.send` **must** refuse it, before any
  request is sent; an endpoint **must not** carry a query or a fragment; `x` in the picker
  deletes a key after a `y`. The window reaches the keys only through what the host hands it
  from `host/host-services.mjs`: `AgentKeys` narrowed to `hint`, `set` and `delete`, never the
  call that returns a key, passed straight through so that the registry holds no key, and
  provided once by `vimma.js` and never replaced (D4 says what the caller check is worth). Asked
  for before it is provided, no key is known, stored or deleted.
  [`test_hosted_openai_compatible_provider_set_up_in_the_window`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_the_picker_shows_a_keys_end_and_x_deletes_it_after_y`](../../tests/browser/browser_vimma_agent_host.js),
  [`test_the_keys_service_is_agentkeys_without_a_way_to_read_a_key`](../../tests/browser/browser_vimma_host_services.js),
  [`test_code_named_vimma_js_cannot_replace_the_chat_windows_services`](../../tests/browser/browser_vimma_host_services.js),
  [`test_before_it_is_provided_each_service_does_the_least`](../../tests/browser/browser_vimma_host_services.js),
  [`test_hosted_anthropic_provider_asks_for_its_key_before_the_task`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_a_key_typed_and_left_is_dropped_and_no_task_goes_keyless`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_an_entered_key_is_never_shown_again_nor_copied_out`](../../tests/browser/browser_vimma_agent_chat.js),
  [`test_every_way_out_of_the_key_field_empties_it`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_left_while_its_model_is_prepared_leaves_the_key_field_alone`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_whose_window_closed_while_it_was_prepared_is_not_used`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_the_later_of_two_picks_wins_whichever_is_ready_first`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_left_before_its_key_hint_opens_no_key_field`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_key_stored_after_the_field_was_left_switches_nothing`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_key_deleted_as_the_picker_opens_again_is_shown_gone`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_refused_send_opens_the_picker_only_if_the_user_stayed`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_prompt_opened_from_the_picker_ends_a_pick_still_waiting`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_second_key_entered_while_one_is_stored_is_said_dropped`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_send_whose_key_hint_fails_asks_for_the_key_only_if_the_user_stayed`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_failed_preparation_replaced_by_a_later_pick_says_nothing`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_on_a_list_reloaded_after_a_key_deletion_says_so`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_answering_after_focus_left_the_window_takes_no_focus`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_pick_whose_browser_window_lost_os_focus_is_still_used`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_send_or_refusal_answering_after_focus_left_moves_nothing`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_key_stored_after_focus_left_the_window_takes_no_focus`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_key_stored_after_the_field_was_left_says_the_model_is_unchanged`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_opening_on_first_use_takes_focus_only_from_a_user_who_stayed`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_agent_give_on_first_use_gives_nothing_after_focus_moved`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_forget_all_on_first_use_asks_only_a_user_who_stayed`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_key_asked_by_a_send_says_nothing_of_an_unchanged_model`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`test_a_refused_add_provider_leaves_a_waiting_pick_alone`](../../tests/browser/browser_vimma_agent_picker_race.js),
  [`an endpoint with a query or a fragment is refused`](../../packages/vimma-core/test/agent-providers.test.mjs)
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
  [`test_stored_file_is_encrypted_and_holds_no_tool_output`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_nothing_written_in_clear_when_it_cannot_be_encrypted`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_reopened_conversation_starts_with_a_clean_context`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_clear_context`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_only_the_final_reply_is_stored_and_temp_files_go`](../../tests/browser/browser_vimma_agent_store.js),
  [`a long conversation keeps its newest entries within MAX_RECORD_BYTES`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`a single entry over MAX_RECORD_BYTES is cut`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`a stored conversation holds messages, replies and summaries, never tool output`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`the provider keeps its prices and never a key`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`refuses another version, a bad provider or an unknown entry`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`a task summary names outcome, counts and hosts, and no page text`](../../packages/vimma-core/test/agent-store.test.mjs),
  [`http and https hosts only, once each, in order`](../../packages/vimma-core/test/agent-store.test.mjs)
- M48. `d` in the conversation list (after a `y`) **must** remove that conversation's file;
  `:agent forget all` (after a `y` naming the count) **must** stop running tasks and remove every
  file of the store, those it cannot read and a save's temporary files included; `[agent] keep_days` **must** remove the files
  not written for that many days, at start, when it changes and once a day, from the files' times
  alone, so it never needs the keyring. A deleted conversation's task that ends afterwards
  **must not** write its file again. The store **must not** be read or decrypted before the
  window first opens, so a user who never opens it is never asked to unlock the keyring.
  [`test_a_new_window_reads_no_stored_conversation`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_delete_and_forget_all_remove_files`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_a_deleted_conversations_task_writes_nothing_after`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_keep_days`](../../tests/browser/browser_vimma_agent_store.js),
  [`only with keep_days, and only when unused for longer`](../../packages/vimma-core/test/agent-store.test.mjs)
- M49. Setup **must** write to `config.toml` only the provider's name, kind, endpoint, model,
  vision and prices, never its key, and only when the file parses before and after the edit, with
  every other key unchanged.
  [`test_setup_writes_the_provider_and_default_to_config`](../../tests/browser/browser_vimma_agent_store.js),
  [`test_setup_creates_a_missing_config_with_the_provider`](../../tests/browser/browser_vimma_agent_store.js),
  [`never writes a key, and refuses a file that does not parse`](../../packages/vimma-core/test/agent-config.test.mjs),
  [`keeps every other line of the file`](../../packages/vimma-core/test/agent-config.test.mjs)
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
  [`the loop leaves out results older than keep_results in blocks, keeping their first line`](../../packages/vimma-core/test/agent-loop.test.mjs),
  [`a page's line keeps its warning even when the page's title breaks the line`](../../packages/vimma-core/test/agent-loop.test.mjs),
  [`the user's messages, the replies and refusals, the user's no among them, stay whole`](../../packages/vimma-core/test/agent-loop.test.mjs),
  [`a request's prefix changes only when a block is left out`](../../packages/vimma-core/test/agent-loop.test.mjs)

**Agent CLIs** ([builtin-agent-cli](../specs/builtin-agent-cli.md), on by default;
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
  [`test_second_connection_with_a_ticket_is_refused`](../../tests/browser/browser_vimma_agent_cli.js),
  [`test_a_request_id_in_flight_is_not_reused`](../../tests/browser/browser_vimma_agent_cli.js),
  [`test_ticket_listener_with_mcp_off_takes_only_tickets`](../../tests/browser/browser_vimma_agent_cli.js),
  [`test_cli_that_ignores_sigterm_is_killed_and_takes_no_step`](../../tests/browser/browser_vimma_agent_cli_run.js)
  A message sent during a task of a CLI with no live input (Codex) **must** be held, never
  written to that run, and **must** start a run only after a task that ended done; after a
  stop, a budget or a failure it is dropped with a notice, so a stop is never followed by a
  run the user did not send again.
  [`test_a_message_during_the_task_is_held_for_the_next_run`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_held_message_is_not_sent_after_a_stop`](../../tests/browser/browser_vimma_agent_cli_codex.js)
- M52. A ticket's connection **must** act as its conversation's connection (M35-M37): asked
  about under the conversation's label, covered by its grant and by no other, on the tabs it
  owns. Its `agent-hello` **must not** register an MCP agent or change the label, and its
  closing **must** withdraw only the questions it was waiting on, leaving the conversation, its
  grant and its tabs.
  [`test_ticket_connection_acts_as_the_conversation`](../../tests/browser/browser_vimma_agent_cli.js)
- M53. Vimma **must never** write a ticket to a pref, `config.toml`, the discovery file or any
  file of the profile, a log, a notice or `:mcp log`; the one file that holds it is the run's
  0600 MCP configuration (M56). What the CLI itself logs of that configuration is its matter:
  a ticket is good for one run, and revoked when the run ends. `vimma-ctl mcp` **must** take it only
  from `VIMMA_AGENT_TICKET` (with the port from `VIMMA_AGENT_PORT`), never print it, and with a
  ticket **must not** read the discovery file, so that process never holds the token. When its
  ticket's task has ended it **must** tell the model so, and **never** to turn MCP on.
  [`test_ticket_never_in_prefs_files_notices_or_log`](../../tests/browser/browser_vimma_agent_cli.js),
  [`mcp_connects_with_a_ticket_from_the_environment`](../../tools/vimma-ctl/tests/mcp.rs),
  [`the_ticket_is_never_printed`](../../tools/vimma-ctl/tests/mcp.rs),
  [`a_ticket_whose_task_ended_never_says_to_turn_on_mcp`](../../tools/vimma-ctl/tests/mcp.rs)
- M54. Stopping or deleting a conversation **must** revoke its tickets and close their
  connections at once, before its grant ends, so no command a CLI sends after the stop reaches
  the browser; a question the connection waited on is withdrawn, and a step already past its
  question finishes, as any stopped task's does (Behaviour 16 of builtin-agent).
  [`test_stop_and_delete_close_the_ticket_connection`](../../tests/browser/browser_vimma_agent_cli.js)
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
  (`docs/limits.md`). The chat window reaches `AgentCli` only through what the host hands it
  from `host/host-services.mjs`, narrowed to `enabled`, `find`, `noneFound` and `use`: neither
  the window nor any host module can start a CLI through the registry. The host and the window
  reach `AgentChat` there the same way, without `issueTicket` (M51), `reset` or `prune`.
  [`test_setup_lists_only_found_clis_and_stores_the_path`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_the_cli_service_is_agentcli_without_a_way_to_start_one`](../../tests/browser/browser_vimma_host_services.js),
  [`test_the_conversations_service_is_agentchat_without_tickets_or_reset`](../../tests/browser/browser_vimma_host_services.js),
  [`test_path_checks_refuse_a_file_others_can_write`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_shim_runs_as_the_cli_it_is_named_after`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`a link on the way to it is judged by its owner`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a program that runs a tool by the name it is started as is a dispatcher`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_no_process_before_a_task`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_task_on_stdin_and_fixed_arguments`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_runs_in_an_empty_private_directory_removed_after`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_turned_off_starts_nothing`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_the_picker_lists_the_clis_models_and_uses_one`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_run_folder_others_can_write_above_is_refused`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_child_holding_the_output_does_not_keep_the_run`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`claude-code's arguments are the fixture, with the model only from the provider`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`the task is never an argument`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's arguments are the fixture`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`vimma-ctl's path is a TOML string whatever it holds`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`the task is never an argument, and goes to stdin, which then closes`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_task_on_stdin_which_closes_and_fixed_arguments`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_setup_finds_codex_with_its_version`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`a model that looks like an option is refused, not passed`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a typed model is checked with the rule the arguments use`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a cli provider's model is refused by the rule its run uses`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`test_setup_asks_the_clis_model_and_saves_it`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`the environment is Vimma's, minus the variables Vimma and Firefox set`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`anything else is refused, with the reason`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`gemini's arguments are the fixture`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_setup_finds_gemini_with_its_version`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_task_on_stdin_fixed_arguments_and_the_folders_settings`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_gemini_keeps_nothing_of_the_run_after_it`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_stopped_run_keeps_nothing_either`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_rejected_key_is_the_runs_error_and_its_report_goes`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_leftovers_of_runs_a_crash_ended_go_at_the_next_start`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_run_folder_a_crash_left_goes_with_its_records`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_linked_registry_is_left_a_link`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`test_a_lock_gemini_holds_is_waited_for_not_broken`](../../tests/browser/browser_vimma_agent_cli_gemini.js),
  [`only a run folder of vimma's is one of its runs`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`the registry keeps every other project, and names the runs' folders`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a slug that is not a plain folder name is never a folder to remove`](../../packages/vimma-core/test/agent-cli.test.mjs)
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
  [`test_ticket_never_in_cmdline_prefs_or_log`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_vimma_ctl_beside_the_binary_is_judged_as_the_binary_is`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_a_link_beside_the_binary_is_judged_where_it_leads`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`a link through a hop in another folder has that folder and link judged`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_only_vimmas_mcp_server_is_given`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`the mcp configuration names only vimma-ctl, with the ticket in its environment`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`the ticket reaches vimma-ctl through codex's environment, never its arguments`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's own commands get the ticket's variables empty, the user's policy kept`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`every other mcp server of codex's configuration is off for the run`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's features that add mcp servers are off, and fail the run once renamed`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a server name that is not a plain word, or is vimma's own, refuses the run`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`codex's own mcp servers are read from its list`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a call to any other mcp server ends the run`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_ticket_by_name_in_codexs_environment_never_an_argument`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_every_other_server_of_codexs_configuration_is_off`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_server_named_as_vimmas_refuses_the_run`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`test_a_call_to_a_server_not_vimmas_ends_the_run`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`vimma's server is in the run folder's settings file, the ticket in its env`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`gemini trusts the run folder from its environment, and keeps its reports there`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a tool of another mcp server that ran ends the run; one never offered does not`](../../packages/vimma-core/test/agent-cli.test.mjs)
- M57. A CLI's steps in the browser **must** be the conversation's: asked and granted as its
  own (the `Enter` grant covers them, checkpoints and `vimma_show` still ask), and shown from the
  gate's record, never from the CLI's account of them. A CLI's output **must** be rendered as
  text and **must never** answer a question, make a grant or fill the prompt slot. A step the
  CLI takes with a tool of its own **must** be a marked line of its own (`◆`), never a step in
  the browser.
  [`test_enter_grant_covers_cli_steps_and_checkpoints_ask`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_own_tool_lines_are_marked`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`mcp__vimma tool calls in the stream are not transcript steps`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`text is passed as written, and the window renders it as text`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`each gate event of the conversation is a step, asked or run under the grant`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`an own-tool line is marked, muted, and says when the cli's settings refused it`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`mcp tool calls of vimma's server are not transcript steps`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_codexs_own_commands_and_files_are_its_own_lines`](../../tests/browser/browser_vimma_agent_cli_codex.js),
  [`a recorded gemini stream maps to replies, own-tool lines and usage`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a step its policy refuses is marked refused`](../../packages/vimma-core/test/agent-cli.test.mjs)
- M58. A CLI's own shell, file and web tools are **outside** Vimma's gate (above). Before a
  conversation's first task with a CLI (and after a provider change), the window **must** say
  where page text goes and that those tools are not confined, and send nothing without a `y`;
  `AgentChat.send` **must** refuse a task the notice was not answered for. The header **must**
  list the tools the CLI reported as enabled for its run: every tool but Vimma's own, those of
  any other MCP server included, and each use of those is a `◆` line; for a CLI that reports
  no tool list (Codex), it **must** say `as its configuration allows`, never a list.
  [`test_first_task_notice_says_the_clis_own_tools_are_not_confined`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_header_lists_the_clis_own_tools_from_its_init`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`an agent CLI: its name, the model it reported, and that it decides where data goes`](../../packages/vimma-core/test/agent-chat.test.mjs),
  [`test_another_mcp_servers_tools_are_listed_as_its_own`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`tools of another mcp server are the cli's own, listed and marked, not hidden`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a run with no reported tool list says its configuration decides`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_header_and_start_line_name_codexs_configuration`](../../tests/browser/browser_vimma_agent_cli_codex.js)
- M59. A CLI task's steps **must** be counted where they reach the gate, and the next one
  refused at `max_steps`, so a CLI cannot under-report them; `max_minutes` (default 30)
  **must** stop it; tokens the CLI reports (cached input included, as for a hosted provider)
  count toward `max_tokens` at each model call, so
  that limit **must** stop a turn still running, not only end it. `max_cost` is not
  enforced for a CLI, whose reported cost is shown as its own estimate (`≈`), and the first task
  says so. A stream line over 1 MiB, or more than 64 MiB of output, **must** end the run.
  [`test_max_steps_counted_by_the_gate`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_max_minutes_stops_the_task`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_max_tokens_stops_a_turn_before_it_ends`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`each model call's usage counts as it comes, once, and the result adds only the rest`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`cached input counts as input, as a hosted provider's does`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`test_max_cost_set_is_reported_as_not_applying`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`a cli task stops at max_minutes`](../../packages/vimma-core/test/agent-budget.test.mjs),
  [`reported cost is shown and max_cost does not stop a cli task`](../../packages/vimma-core/test/agent-budget.test.mjs),
  [`a line over 1 MiB ends the run`](../../packages/vimma-core/test/agent-cli.test.mjs),
  [`a run over 64 MiB of output is stopped`](../../packages/vimma-core/test/agent-cli.test.mjs)
- M60. `local_only` **must** refuse every CLI provider, in `config.toml`, in the picker and at
  each task; a `command`, `path`, `args` or `env` key in a CLI provider **must** be a config
  error, and so is an `endpoint`.
  [`test_local_only_refuses_a_cli`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`local_only refuses a cli provider`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`command, path, args and env in a cli provider are errors with their line`](../../packages/vimma-core/test/config-agent.test.mjs),
  [`an agent cli is written by name, kind, cli and model, never its path`](../../packages/vimma-core/test/agent-config.test.mjs)
- M61. A stop (`s`, `:agent stop`, `ctrl+b shift+a`), a task's budget and its end **must**
  revoke the ticket, closing its connection, before the CLI is signalled; then `SIGTERM`, and
  `SIGKILL` after 3 s.
  [`test_stop_closes_the_connection_before_the_signal`](../../tests/browser/browser_vimma_agent_cli_run.js),
  [`test_cli_that_ignores_sigterm_is_killed_and_takes_no_step`](../../tests/browser/browser_vimma_agent_cli_run.js)
