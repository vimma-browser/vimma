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
  reaches Places only while `config.toml`'s own text says `[bookmarks] bookmarklets = "user"`
  or `"agent"` (a file `:source <file>` loaded does not count), because a bookmark in Places
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
  the question never replaces an open prompt or command line and ignores keys for 400 ms as it
  appears; no answer applies nothing, and a yes approves the removals it showed and no more.
  Accepted risks until later slices: many small edits, each under the limits, are applied
  without a question (each says what it removed); and two devices with different files and
  Sync on both put each other's changes back at every sync (bookmarks-file decision 2b, which
  stops this, comes with write-back; large put-backs still ask). Vimma never writes
  `bookmarks.toml` in this slice; no control-socket or MCP command reads or writes it.
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
  [`a_table_over_a_folder_with_bookmarks_asks_before_deleting_them`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`bookmarks_outside_mirrored_folders_are_untouched`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`allows only http, https, file and about, and javascript: behind the bookmarklets gate`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a 4 MiB file of deep paths or of many folders reads and plans in bounded time`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`one claimed set: a workspace folder dragged into another table's folder is moved back, not deleted`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a removed table keeps protected bookmarklets, also inside its folders`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`a base folder outside the toolbar's top that is not the workspace's is not trusted`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`outside additions put back count toward the large-deletion question`](../../packages/vimma-core/test/bookmarks-file.test.ts),
  [`the_question_waits_for_the_command_line_and_ignores_an_early_key`](../../tests/browser/browser_vimma_bookmarks_file.js),
  [`with_the_feature_pref_off_nothing_is_read_or_refused`](../../tests/browser/browser_vimma_bookmarks_file.js)
