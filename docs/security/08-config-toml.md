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
  [`broken text keeps the previous config active, unchanged`](../../packages/vimma-core/test/config.test.mjs),
  [`workspace %s is an error`](../../packages/vimma-core/test/config.test.mjs)
- F3. The config is **never** executed: no value is evaluated as code or run as a command. An
  agent CLI provider names only which supported CLI it is and its model; a `command`, `path`,
  `args` or `env` key in one is an error (M60).
  [`never builds code from text: no eval, Function or sandbox evaluation`](../../tools/security/test/chrome-source.test.ts),
  [`command, path, args and env in a cli provider are errors with their line`](../../packages/vimma-core/test/config-agent.test.mjs)
- F4. `:route add` **must** write each value as one escaped TOML string, and write nothing when
  the result would not parse. The host reaches `ConfigHost.addRoute` only through
  `host/host-services.mjs`, which `vimma.js` fills (§21, D4); asked before that, it writes
  nothing.
  [`appendRouteText quotes a workspace name as a TOML string`](../../packages/vimma-core/test/routes.test.mjs),
  [`appendRouteText refuses what would not parse, and says why`](../../packages/vimma-core/test/routes.test.mjs),
  [`route_add_creates_a_private_config_toml`](../../tests/browser/browser_vimma_security_invariants.js),
  [`route_add_says_why_config_toml_refused_the_rule`](../../tests/browser/browser_vimma_workspace_routes.js),
  [`test_before_it_is_provided_each_service_does_the_least`](../../tests/browser/browser_vimma_host_services.js)
- F5. Reading `config.toml` **never** throws, hangs or changes a built-in prototype; nesting
  deeper than 32 levels is refused; a key, colour or modifier named like an `Object` member
  (`constructor`, `__proto__`) is unknown, never looked up; an accepted config holds only values
  its schema allows.
  [`parseConfig never throws, on any text, and its result is well-formed`](../../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`an accepted config holds only what the schema allows`](../../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`huge and deeply nested files are refused or read in bounded time`](../../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`a workspace colour named after an Object member is an error, not a value`](../../packages/vimma-core/test/fuzz/config.fuzz.test.mjs),
  [`a prototype member name is never a key or a modifier: constructor, toString, __proto__`](../../packages/vimma-core/test/fuzz/keys.fuzz.test.mjs),
  [`nesting deeper than MAX_DEPTH, by dotted keys, headers or values, is refused at its line`](../../packages/vimma-core/test/toml.test.mjs)
