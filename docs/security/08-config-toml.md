## 8. `config.toml` (`config/ConfigHost.sys.mjs`)

A local file you trust and edit. Spec: [m5-config-load](../specs/m5-config-load.md),
[ADR-008](../adr/008-config-toml.md).

- F1. A config.toml Vimma creates **must** be mode 0600 in a 0700 folder. Vimma changes an
  existing file only from `:route add` (an append) and the setup summary (`[search] default`,
  edited in place by `setTomlKeys`), never on a parse error, atomically through a renamed
  temporary file, keeping the file's mode.
  [`a_missing_folder_is_created_private`](../../tests/browser/browser_vimma_config_first_run.js),
  [`an_existing_file_is_never_touched`](../../tests/browser/browser_vimma_config_first_run.js),
  [`route_add_creates_a_private_config_toml`](../../tests/browser/browser_vimma_security_invariants.js),
  [`summary_keeps_comments_and_mode_of_config_toml`](../../tests/browser/browser_vimma_setup.js),
  [`summary_writes_nothing_on_a_parse_error`](../../tests/browser/browser_vimma_setup.js)
- F2. Every value **must** be validated; a broken file keeps the last good config and a bad
  value (such as a `javascript:` home page) is an error.
  [`broken text keeps the previous config active, unchanged`](../../packages/vimma-core/test/config.test.ts),
  [`workspace %s is an error`](../../packages/vimma-core/test/config.test.ts)
- F3. The config is **never** executed: no value is evaluated as code or run as a command. An
  agent CLI provider names only which supported CLI it is and its model; a `command`, `path`,
  `args` or `env` key in one is an error (M60).
  [`never builds code from text: no eval, Function or sandbox evaluation`](../../tools/security/test/chrome-source.test.ts),
  [`command, path, args and env in a cli provider are errors with their line`](../../packages/vimma-core/test/config-agent.test.ts)
- F4. `:route add` **must** write each value as one escaped TOML string, and write nothing when
  the result would not parse. The host reaches `ConfigHost.addRoute` only through
  `host/host-services.mjs`, which `vimma.js` fills (§21, D4); asked before that, it writes
  nothing.
  [`appendRouteText quotes a workspace name as a TOML string`](../../packages/vimma-core/test/routes.test.ts),
  [`appendRouteText refuses what would not parse, and says why`](../../packages/vimma-core/test/routes.test.ts),
  [`route_add_creates_a_private_config_toml`](../../tests/browser/browser_vimma_security_invariants.js),
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
  read-only mirror, behind `vimma.feature.bookmarksFile`, off by default) is a file that may come
  from someone else's repository, and it drives writes to Places from the parent's main thread.
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
  [`with_the_feature_pref_off_nothing_is_read_or_refused`](../../tests/browser/browser_vimma_bookmarks_file.js)
- F7. Vimma writes the bookmarks file (spec: [bookmarks-file](../specs/bookmarks-file.md),
  Delivery slice 2, behind the same pref): its own bookmark keys in a mirrored folder edit
  `bookmarks.toml` (or `config.toml`'s inline tables) first and Places after it, under
  `[bookmarks] write_back = "vimma"`, the default of this slice. The setting is read only from
  `config.toml` (D12); with `"none"` the keys refuse, and in a private window they always refuse,
  so nothing done in private browsing reaches a file that may be committed. Writes: only the
  bookmarks file in `config.toml`'s folder (or the file its symlink points to, as for
  `config.toml`), through a temporary file in the same folder created empty, given the file's
  mode before any text goes in, and renamed over it; a link to nothing, or a file that is not a
  regular file, is never replaced, and Vimma never creates `bookmarks.toml` here. A file that
  changed while it was edited is edited again once from its new text, else nothing is written.
  Every edit, `config.toml`'s included, and every apply runs in one queue (D11), so no two
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
  (D18). A file over 4 MiB is not
  read for an edit either. A key's delete removes only the item
  its y/N named; a takeover of a folder that has bookmarks writes them into the table and
  deletes nothing (D7); the guide warns that a shared file's table can so take a personal folder's
  bookmarks into it. A bookmark put back three times in ten minutes (two devices with different
  files and Sync) pauses its table both ways with a notice and a status bar line, until the file
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
  [`many subtrees go into a table as one edit, within budget at 5,000 lines`](../../packages/vimma-core/test/bookmarks-edit.test.ts)
