## 8. `config.toml` (`config/ConfigHost.sys.mjs`)

A local file you trust and edit. Spec: [m5-config-load](../specs/m5-config-load.md),
[ADR-008](../adr/008-config-toml.md).

- F1. A config.toml Vimma creates **must** be mode 0600 in a 0700 folder; Vimma never creates
  routes.toml (F9). Vimma changes an existing file only from `:route add` (an append to the
  routes file: routes.toml when it exists, else config.toml), the setup page's setting steps
  (each step's own keys on its `enter`, never from a private window), the built-in agent's
  setup, and `:siteunbind --save` / `:sitebind --delete`, each run one at a time in the one
  queue of config.toml and routes.toml edits, so that no two edits race. Every edit goes through
  `ConfigHost`'s atomic writer (`writeFileNow`; `rewriteConfig`; the setup's keys through
  `setConfigKeys` and `setTomlKeys`), never on a parse error, when the file would not load with
  the edit (checked with `parseConfig` or `parseRoutesFile` before the rename) or when it
  changed while it was edited, atomically through a renamed temporary file that has the file's
  mode before any text goes in, renamed over the target of a symlinked file. A setup step names only a step and the index of a choice the host sent that
  page; the host plans the keys from its own step table against the file as it is at `enter`,
  and writes only those that change the value in force, so an edit made meanwhile is kept. The
  one value a page proposes is the prefix step's own key: the host reads it as one chord in
  Vimma's key notation, judges it again by the keymap of the file at `enter` (a key with ctrl,
  alt or meta, not esc, enter or tab, not the leader, not a key `[firefox] enable` gives back,
  not copy, paste, cut, undo, redo or macOS's quit, hide, minimize and settings, not a
  text-field key while insert editing is on, not the first key of a binding outside the prefix),
  and writes only `[keys] prefix` with that
  chord's canonical text, so the page can neither name another key nor put text of its own in
  the file. The keys pressed while the step waits for one stay in the page's memory: Vimma does
  not keep them among its recent keys, and only the chord saved reaches the host.
  [`a_missing_folder_is_created_private`](../../tests/browser/browser_vimma_config_first_run.js),
  [`an_existing_file_is_never_touched`](../../tests/browser/browser_vimma_config_first_run.js),
  [`route_add_creates_a_private_config_toml`](../../tests/browser/browser_vimma_security_invariants.js),
  [`route_add_writes_nothing_over_a_file_changed_meanwhile`](../../tests/browser/browser_vimma_routes_file.js),
  [`a_step_creates_a_private_config_toml_when_absent`](../../tests/browser/browser_vimma_setup.js),
  [`a_step_keeps_comments_and_mode_of_config_toml`](../../tests/browser/browser_vimma_setup.js),
  [`a_parse_error_writes_nothing_and_action_steps_still_work`](../../tests/browser/browser_vimma_setup_v2_flow.js),
  [`an_edit_made_while_a_step_is_open_is_kept`](../../tests/browser/browser_vimma_setup_v2_flow.js),
  [`a_symlinked_config_toml_stays_a_link`](../../tests/browser/browser_vimma_setup_v2_flow.js),
  [`a_private_window_saves_nothing`](../../tests/browser/browser_vimma_setup_v2_flow.js),
  [`the_page_cannot_name_a_key_or_value`](../../tests/browser/browser_vimma_setup_v2_flow.js),
  [`the_host_judges_the_pressed_prefix_again`](../../tests/browser/browser_vimma_setup_v2_keys.js),
  [`prefix_step_records_a_key_and_esc_goes_back_to_the_list`](../../tests/browser/browser_vimma_setup_v2_keys.js),
  [`the host reads only one chord in Vimma's notation`](../../packages/vimma-core/test/setup-steps.test.ts),
  [`an edit the file would not load with is refused, with the reason`](../../packages/vimma-core/test/config-set-keys.test.ts),
  [`adds [theme] before [theme.colors] when only the sub-table exists`](../../packages/vimma-core/test/toml.test.ts),
  [`route_add_waits_for_a_running_rewrite`](../../tests/browser/browser_vimma_workspace_routes.js)
- F2. Every value **must** be validated; a broken file keeps the last good config and a bad
  value (such as a `javascript:` home page) is an error. An unknown key with no close match
  is left out with a warning and never reaches the resolved config (a key from a newer build);
  in `[updates]`, a boolean `check` elsewhere, a table's name under another table, and an agent
  CLI provider's program, command and secret keys, and a credential-looking name in `[agent]`,
  a provider or `[mcp]`, it stays an error, so a misplaced update opt-out fails closed and a
  secret is still pointed to login storage. Accepted risk: a key a newer build added to tighten
  something (in `[mcp]` or `[agent]`, say) is dropped by an older build while the rest of the
  same file applies, loosenings included; before, the older build refused the file and kept its
  previous config, which lacked that key too, so neither way enforced it.
  [`in a known table is a warning; the rest of the file applies`](../../packages/vimma-core/test/config-unknown-keys.test.ts),
  [`a program, command or secret in a CLI provider (M60)`](../../packages/vimma-core/test/config-unknown-keys.test.ts),
  [`an opt-out under a misspelt or misplaced table may mean check = false`](../../packages/vimma-core/test/updates.test.ts).
  A broken routes.toml keeps the last
  good routes while the rest of config.toml applies, and one never read well (a syntax error,
  a FIFO, a link to nothing) applies no rule and no `default_workspace` rather than
  config.toml's (routes-file decisions 3 and 5), unless the rules cached at the last change
  came from routes.toml: those are its last good read at a cold start. A routes.toml that is
  not a regular file is never opened, so it cannot block the reads of config.toml.
  [`broken text keeps the previous config active, unchanged`](../../packages/vimma-core/test/config.test.ts),
  [`a_broken_routes_toml_keeps_the_last_good_routes_and_config_toml_applies`](../../tests/browser/browser_vimma_routes_file.js),
  [`a_routes_toml_never_read_well_applies_no_rule`](../../tests/browser/browser_vimma_routes_file.js),
  [`workspace %s is an error`](../../packages/vimma-core/test/config.test.ts)
- F3. The config is **never** executed: no value is evaluated as code or run as a command. An
  agent CLI provider names only which supported CLI it is and its model; a `command`, `path`,
  `args` or `env` key in one is an error (M60).
  [`never builds code from text: no eval, Function or sandbox evaluation`](../../tools/security/test/chrome-source.test.ts),
  [`command, path, args and env in a cli provider are errors with their line`](../../packages/vimma-core/test/config-agent.test.ts)
- F4. `:route add` **must** write each value as one escaped TOML string, to the routes file
  only (routes.toml when it exists, else config.toml; it never creates routes.toml and never
  moves rules), and write nothing when the result would not parse or the file changed meanwhile.
  A file it cannot write is said so, with the lines to add by hand. It is reachable only from
  Vimma's own command line in a window with workspaces, never a private window, the agent role
  or a page. The host reaches `ConfigHost.addRoute` only through `host/host-services.mjs`, which
  `vimma.js` fills (§21, D4); asked before that, it writes nothing.
  [`appendRouteText quotes a workspace name as a TOML string`](../../packages/vimma-core/test/routes.test.ts),
  [`appendRouteText refuses what would not parse, and says why`](../../packages/vimma-core/test/routes.test.ts),
  [`appendRouteFileText appends a quoted block and refuses a broken file`](../../packages/vimma-core/test/routes-file.test.ts),
  [`:route add into routes.toml writes the domain and workspace as given, or refuses (F4)`](../../packages/vimma-core/test/fuzz/routes.fuzz.test.ts),
  [`route_add_creates_a_private_config_toml`](../../tests/browser/browser_vimma_security_invariants.js),
  [`route_add_writes_nothing_over_a_file_changed_meanwhile`](../../tests/browser/browser_vimma_routes_file.js),
  [`route_add_to_a_read_only_config_toml_says_what_to_add_by_hand`](../../tests/browser/browser_vimma_routes_file.js),
  [`route_add_in_a_private_window_writes_nothing`](../../tests/browser/browser_vimma_routes_file.js),
  [`route_add_says_why_config_toml_refused_the_rule`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`test_before_it_is_provided_each_service_does_the_least`](../../tests/browser/browser_vimma_host_services.js)
- F5. Reading `config.toml` **never** throws, hangs or changes a built-in prototype; nesting
  deeper than 32 levels is refused; a key, colour or modifier named like an `Object` member
  (`constructor`, `__proto__`) is unknown, never looked up; an accepted config holds only values
  its schema allows.
  [`parseConfig never throws, on any text, and its result is well-formed`](../../packages/vimma-core/test/fuzz/config.fuzz.test.ts),
  [`an accepted config holds only what the schema allows`](../../packages/vimma-core/test/fuzz/config.fuzz.test.ts),
  [`huge and deeply nested files are refused or read in bounded time`](../../packages/vimma-core/test/fuzz/config.fuzz.test.ts),
  [`a workspace colour named after an Object member is an error, not a value`](../../packages/vimma-core/test/fuzz/config.fuzz.test.ts),
  [`a prototype member name is never a key or a modifier: constructor, toString, __proto__`](../../packages/vimma-core/test/fuzz/keys.fuzz.test.ts),
  [`nesting deeper than MAX_DEPTH, by dotted keys, headers or values, is refused at its line`](../../packages/vimma-core/test/toml.test.ts)
- F6. `bookmarks.toml` beside `config.toml` (spec: [bookmarks-file](../specs/bookmarks-file.md),
  mirrored into Places and written back as F7 says, on by default) is a file that may come from
  someone else's repository, and it drives writes to Places from the parent's main thread.
  Its values are URLs, never evaluated, and only `http`, `https`, `file`, `about`, and
  `javascript:` behind the gate below; every other scheme (`data:`, `chrome:`, `resource:`,
  `view-source:`, `blob:`, `jar:`, `place:`, …) is an error at its line. It **cannot** hold a
  setting, so a shared or pulled file cannot allow bookmarklets (D12); a `javascript:` line
  reaches Places only while the last `config.toml` that applied says `[bookmarks] bookmarklets =
"user"` or `"agent"` (a file with errors, or one `:source <file>` loaded, does not count), because a bookmark in Places
  runs from Firefox's own Library and toolbar (D13); with `"none"` the mirror neither adds,
  changes nor removes a `javascript:` bookmark, at any depth, also when a table is removed.
  Reading is bounded: a file over 4 MiB, or that is not a regular file (a FIFO would block the
  queue), is not read, and it is read with a byte cap; at most 20,000 bookmarks and folders (the
  folders paths make count) and 32 names per path; keys are built one level at a time and the walks over Places are iterative, so a 4 MiB
  file of either worst shape reads and plans in bounded time. Names refuse control,
  bidirectional and invisible characters; errors cut what they repeat to 80 characters; paths
  and table names are kept in `Map`s, so a title such as `__proto__` is an ordinary title. A
  file with an error, or a missing file (or a missing `config.toml` that held the tables), is
  never applied: both directions pause (D9), until the file reads or `:bookmarks forget`. The
  plan reaches only the tables' own folders: one claimed set across all tables, a base guid
  reused only inside a mirrored folder, and a folder from the stored base
  (`<profile>/vimma-bookmarks.json`, which a damaged or edited copy could point anywhere)
  trusted only at the Bookmarks Toolbar's top, inside another table's folder there, or as the
  workspace's own linked folder; bookmarks elsewhere are never read or written (Behaviour 21).
  A run that would delete more than 20 bookmarks, or more than half of a table's, whether the
  file dropped them or Sync and the Library added them, or any bookmark of a folder a table
  takes over without a base (also after a new or restored Places database), asks y/N first;
  the question never replaces an open prompt or command line nor opens while a page field has
  the keys, and ignores keys for 1 s as it appears; no answer applies nothing, and a yes approves the removals it showed and no more.
  Accepted risk: many small edits, each under the limits, are applied without a question
  (each says what it removed). Two devices with different files and Sync on both put each
  other's changes back; F7's loop guard stops that. No control-socket or MCP command reads or
  writes the file.
  [`refuses data: URLs, relative URLs, non-string values, inline tables and nested tables at their line`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`refuses keys other than [bookmarks.<name>] tables in bookmarks.toml`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`refuses a file over 4 MiB without parsing it`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`titles __proto__ and constructor are ordinary titles`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`javascript: lines are skipped below bookmarklets = "user", and those already in Places are kept`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`parse never throws and an accepted file holds only valid lines`](../../packages/vimma-core/test/fuzz/bookmarks-file.fuzz.test.ts),
  [`javascript_lines_wait_for_bookmarklets_and_data_lines_never_reach_places`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_broken_file_pauses_both_ways_and_names_the_line`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_missing_file_pauses_and_forget_turns_the_mirror_off`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_large_deletion_asks_and_n_applies_nothing`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_table_over_a_folder_with_bookmarks_asks_under_write_back_none`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`bookmarks_outside_mirrored_folders_are_untouched`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`allows only http, https, file and about, and javascript: behind the bookmarklets gate`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a 4 MiB file of deep paths or of many folders reads and plans in bounded time`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`one claimed set: a workspace folder dragged into another table's folder is moved back, not deleted`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a removed table keeps protected bookmarklets, also inside its folders`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a base folder outside the toolbar's top that is not the workspace's is not trusted`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`outside additions put back count toward the large-deletion question`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`the_question_waits_for_the_command_line_and_ignores_an_early_key`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`bookmarks_toml_is_read_with_no_pref_set`](../../tests/browser/browser_vimma_bookmarks_file.js)
- F7. Vimma writes the bookmarks file (spec: [bookmarks-file](../specs/bookmarks-file.md),
  Delivery slices 2 and 3): its own bookmark keys in a mirrored folder edit
  `bookmarks.toml` (or `config.toml`'s inline tables) first and Places after it, under
  `[bookmarks] write_back = "all"` (the default) or `"vimma"`, and under `"all"` a change made
  to a mirrored folder outside Vimma's keys (the Library, the star, an add-on, an import, Sync)
  is written too, merged three ways with the file and the base. The setting is read only from
  `config.toml` (D12), so a pulled file cannot turn writing on; with `"none"` the keys refuse,
  and in a private window they always refuse, so nothing done in private browsing reaches a file
  that may be committed. Outside changes carry no window, so the window a change came from is
  the focused one, followed up its openers to a browser window (the Library and the bookmark
  dialogs are windows of their own), the Library counting as the browser window that last opened
  or raised it (`PlacesCommandHook.showPlacesOrganizer`, which only focuses a Library already
  open, so its `opener` is not enough; a Library brought forward by clicking it keeps that window); when no browser window is found, or the check throws,
  the most recent browser window decides, so the check fails closed. Under `"all"`, an addition
  or change from a private window, or from a Library or dialog a private window opened or
  raised, is never written (an addition stays in Places only, listed in the base's `local`
  list; a change is put back); removals are written, as they add nothing to the file. A later
  change to that bookmark itself from a normal window (its title, URL or folder; not a sort,
  which moves every bookmark of the folder) takes it off the `local` list and writes it; a
  folder made in a private window stays local with its contents. A run forgets only the window
  marks no event touched while it ran. An add-on's write carries no window either and counts as
  the focused window's.
  What an outside change can put into the file is what Places holds in the mirrored folders,
  where the user, Sync or an add-on put it: the merge writes it through the same line writer and
  checks below, so a URL the file refuses (`data:`, `place:`, `chrome:`, a bookmarklet while
  `bookmarklets` is `"none"`), a path deeper than 32 names, or a hidden character never reaches
  the file; such an item stays in Places as it is and no run removes it. Names are cleaned as
  for the keys. Every outside removal of more than 20 bookmarks, or of more than half of a
  table's, asks y/N first in the window (D14, the same question rules as F6); `n`, `Esc` or no
  answer puts the removed ones back into Places from the file and writes the rest of the change,
  so declining never deletes, on this device or through Sync on others, what the same batch
  added. The guide warns, in its first paragraph,
  that every URL in a mirrored folder, Sync's included, goes into the file and every commit of
  it. A merge whose edit does not read back as merged, or a write that fails, writes nothing and
  pauses until the file changes, keeping Places' change; when both sides changed one bookmark
  the file wins; a removal on one side and a change on the other keeps the item. A Places item
  is taken for a base item whose guid Sync's dedupe replaced only when no table of the base
  holds its guid and the base guid is gone from Places, so a bookmark moved from another table, or a
  new one where a moved one was, is never taken for a base item that a removal in the file then
  deletes (#1434); likewise a table whose folder is gone is read from a top-level folder of its
  name only when no table of the base holds that folder's guid, so another table's subfolder
  moved to the toolbar's top never becomes the deleted table. When Places
  made a new database at start-up (a restored backup), the first run writes nothing back
  (D17). Writes: only the
  bookmarks file in `config.toml`'s folder (or the file its symlink points to, as for
  `config.toml`), through a temporary file in the same folder created empty, given the file's
  mode before any text goes in, and renamed over it; a link to nothing, or a file that is not a
  regular file, is never replaced, and a key never creates `bookmarks.toml` (only
  `:bookmarks export` does, F8). A file that changed while it was edited is edited again once
  from its new text, else nothing is written. Every edit, `config.toml`'s included, and every apply runs in one queue (D11), so no two
  edits read the same text. The line writer keeps every other byte and is verified: the edited
  text is read again and must hold exactly the lines meant, in order, with every other key of
  the file unchanged, and then must read as the mirror reads it, without an error, else nothing
  is written (D10). So Vimma never writes a URL the file refuses (`data:`, a scheme outside
  `http`, `https`, `file`, `about`), a `javascript:` URL unless `bookmarklets` is `"user"` or
  `"agent"`, a name with control, bidirectional or invisible characters (they are dropped from a
  page title first), a name over 4,096 characters, or a file over 4 MiB or 20,000 bookmarks and
  folders. Nothing reaches Places when the write fails. When the Places step of a change fails before it
  changed anything, the file and the base are put back; once part of it is in Places, the edit
  stays and a run brings Places to the file, so an item may end up twice but never nowhere
  (D18). A move out of the file whose Places step fails after an editor saved the file
  meanwhile writes the line back (else moves the bookmark to Other Bookmarks), and a base that
  cannot be saved after a file write (a full disk) is kept in memory while the change goes on,
  so neither leaves a bookmark in neither the file nor the base (#1347). A file over 4 MiB is
  not read for an edit either. A key's delete removes only the item
  its y/N named; a takeover of a folder that has bookmarks writes them into the table and
  deletes nothing (D7); the guide warns that a shared file's table can so take a personal folder's
  bookmarks into it. A bookmark put back three times in ten minutes (two devices with different
  files and Sync; under `"all"`, the file winning over Places' change of one bookmark, counted
  by its guid) pauses its table both ways with a notice and a status bar line, until the file
  changes (bookmarks-file decision 2).
  [`editBookmarkLines keeps every other byte, comments and CRLF line ends`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`editBookmarkLines refuses an edit whose result does not parse to the expected model`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`an edit of config.toml's inline tables keeps every other key`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`never writes a URL the file refuses, nor a bookmarklet below bookmarklets = user`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`an empty title is written as the URL, outer spaces trimmed, hidden characters dropped`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`the result is checked: over the line limit is refused`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`a bookmark put back three times in ten minutes trips its table`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`tasks run one at a time, in order; a failure does not stop the next`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`quick_add_writes_the_file_first_and_keeps_its_comments`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_private_window_does_not_write_the_file`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`write_back_none_refuses_vimma_keys_and_puts_library_changes_back`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_bookmark_put_back_three_times_pauses_its_table`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`config_and_bookmarks_edits_are_serialised`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_table_over_a_folder_with_bookmarks_writes_them_into_the_table`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`an_edited_file_keeps_its_mode_and_symlink`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_dangling_link_or_a_fifo_is_never_replaced`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_file_changed_during_an_edit_is_retried_once`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_move_out_whose_places_step_fails_loses_nothing`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_paused_table_refuses_wsdelete_and_makes_no_folder`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`a_move_into_a_table_that_fails_partway_loses_nothing`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`editBookmarkLines on any parsed file either refuses or yields the expected model`](../../packages/vimma-core/test/fuzz/bookmarks-file.fuzz.test.ts),
  [`many subtrees go into a table as one edit, within budget at 5,000 lines`](../../packages/vimma-core/test/bookmarks-edit.test.ts),
  [`an outside add, rename, URL change and removal are written, keeping comments`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`the file wins when both changed one bookmark; removed and changed keeps it`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`Places items the file cannot hold are kept in Places, never written or removed`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`a Places-only item (made in a private window) stays out of the file and is kept`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`a new item where a base item was is not that item when its guid moved to another table`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`an item moved from another table into a removed item's place is moved, not that item`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`a deleted table is not read from another table's subfolder of its name moved to the top`](../../packages/vimma-core/test/bookmarks-merge.test.ts),
  [`merging then parsing never loses an item present in either side, and settles`](../../packages/vimma-core/test/fuzz/bookmarks-merge.fuzz.test.ts),
  [`write_back_all_is_the_default_and_writes_a_library_change_after_a_burst`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_sync_removal_of_many_asks_and_n_puts_them_back`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_url_the_file_cannot_hold_stays_in_places_only`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_private_window_change_is_not_written`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_library_change_from_a_normal_window_is_written_beside_a_private_one`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`the_loop_guard_holds_across_two_simulated_devices`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_move_out_whose_places_step_fails_and_whose_line_cannot_go_back_loses_nothing`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_base_that_cannot_be_saved_after_a_move_out_loses_nothing`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`a_mixed_sync_batch_answered_n_or_not_at_all_keeps_its_additions`](../../tests/browser/browser_vimma_bookmarks_file_outside.js),
  [`keepRemovals puts removals back and still writes the batch's additions, renames and moves`](../../packages/vimma-core/test/bookmarks-merge.test.ts)
- F8. `:bookmarks export` writes Places' workspace folders to a new `bookmarks.toml` (spec:
  [bookmarks-file](../specs/bookmarks-file.md) Behaviour 17, Delivery slice 4). It writes through the same writer and queue as F7 (D11): a new file is created mode
  0600 in a 0700 folder, never over a link to nothing or a file that is not a regular file. An
  existing file is replaced only by `:bookmarks export!`, after a y/N that says what the file
  holds, after a 1 s key settle, and only while it still holds the text the question
  described. Right before the replace, its old text is written, the same way, to a backup that
  is always a new 0600 file (`bookmarks.toml.bak`, then `.bak.2`, … one past the highest number
  beside it), never over an existing file, whatever its type or mode; none is written when the
  newest backup already holds that text or when the file changed since the question. Nothing is
  replaced when the backup fails, and backups are never overwritten, so a line only the file
  held (a bookmarklet the settings keep out of Places, a table of a paused mirror) stays in one
  even across later `export!`s. The export is checked as the line writer's edits are:
  the text is read again and must hold exactly the tables and items meant, with no error, else
  nothing is written; a `data:` URL, a scheme the file refuses, a name it cannot hold and items
  deeper than 32 folders are left out and counted, and names are cleaned as in F7. A
  `javascript:` bookmark is exported whatever `bookmarklets` says, because it is already in the
  user's Places; it reaches Places from the file only under F6's rule. Bookmarks outside the
  workspaces' folders are not exported, so the Menu, Other Bookmarks and loose toolbar bookmarks
  never reach a file that may be committed; each table's folder is the one the mirror's next load
  takes (D6, shared code), and a table the base already mirrors is exported from its folder even
  without a workspace, so `export!` never drops a table whose bookmarks the mirror
  would then delete. A private window exports nothing. The only Places writes are renames of
  exported items to the names the file holds (Behaviour 15); an item left out stays, and the
  first load asks before it would delete it (Behaviour 18). Agents cannot reach it: the agent
  role's `vimma_keys` refuses `:` (mcp-drive D9).
  [`export: one table per linked workspace, in the order given, Places order inside`](../../packages/vimma-core/test/bookmarks-export.test.ts),
  [`export: data: left out and counted; other schemes the file refuses too; javascript: kept`](../../packages/vimma-core/test/bookmarks-export.test.ts),
  [`export: more bookmarks and folders than the file holds is refused`](../../packages/vimma-core/test/bookmarks-export.test.ts),
  [`export then parse gives the same model: an exported file reads back without an error`](../../packages/vimma-core/test/fuzz/bookmarks-file.fuzz.test.ts),
  [`export_writes_one_table_per_workspace_and_opens_it`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`a_data_bookmark_is_left_out_and_never_deleted`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`export_refuses_an_existing_file_and_export_bang_replaces_it_after_yes`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`a_file_changed_while_export_bang_asks_is_not_replaced`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`a_private_window_does_not_export`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`export_bang_twice_keeps_every_older_file_in_a_backup`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`a_backup_is_a_new_0600_file_beside_a_fifo_or_a_wider_backup`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`a_failed_replace_after_the_backup_keeps_the_file`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`the_export_bang_question_ignores_a_key_typed_as_it_appears`](../../tests/browser/browser_vimma_bookmarks_export.js),
  [`export: the base's folder wins over the workspace's link, as at the mirror's first load`](../../packages/vimma-core/test/bookmarks-export.test.ts),
  [`export: many items of one name are named in linear time`](../../packages/vimma-core/test/bookmarks-export.test.ts)
- F9. `routes.toml` beside `config.toml` (spec: [routes-file](../specs/routes-file.md)) holds the
  `[[routes]]` rules and `[routing] default_workspace` when it exists, so it decides which
  workspace, and so which cookies, a site or another program's link opens in. It carries
  exactly `config.toml`'s trust: a local file you create, edit or pull from a repository of
  your own (Vimma never creates it), located beside `config.toml`'s path (not a symlink's
  target). When it exists it owns `[routing]` too: config.toml's `default_workspace` is ignored. It holds only `[[routes]]` and
  `[routing]`, every other key is an error at its line, it is read only when it is a regular
  file of up to 1 MiB, and its
  rules are checked by the same `validateRoutes` as `config.toml`'s, so every routing
  guarantee (02 R6 to R10, 12 M24) holds whichever file holds them. Nothing in it is executed.
  [`parseRoutesFile reads [[routes]] and [routing] as config.toml does`](../../packages/vimma-core/test/routes-file.test.ts),
  [`parseRoutesFile refuses another top-level key at its line`](../../packages/vimma-core/test/routes-file.test.ts),
  [`parseRoutesFile refuses a file over 1 MiB`](../../packages/vimma-core/test/routes-file.test.ts),
  [`routes_toml_rules_apply_and_config_toml_rules_are_ignored_with_a_warning`](../../tests/browser/browser_vimma_routes_file.js),
  [`routes_toml_is_found_beside_a_symlinked_config_toml`](../../tests/browser/browser_vimma_routes_file.js),
  [`a_fifo_or_a_dangling_link_named_routes_toml_is_an_error`](../../tests/browser/browser_vimma_routes_file.js),
  [`a_symlinked_routes_toml_is_followed_and_a_large_one_refused`](../../tests/browser/browser_vimma_routes_file.js),
  [`a_broken_routes_toml_at_start_keeps_the_cached_routes_toml_rules`](../../tests/browser/browser_vimma_routes_file.js)
