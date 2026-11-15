# Spec: m7-fuzzing

Status: implemented · Milestone: M7 (security hardening) · Area: `packages/vimma-core/test/fuzz/`,
`tools/vimma-ctl/tests/protocol_props.rs`, `.github/workflows/fuzz.yml`

## User story

As the maintainer, I know that the code reading input from outside Vimma (other local programs,
config files, themes anyone can publish, pasted text) neither crashes, hangs, pollutes
prototypes nor accepts what its schema forbids, on far more inputs than hand-written tests try,
and a nightly run tells me when a change breaks that.

## Scope

The parsers of outside input (plan M7: "fuzzing of the control protocol, `config.toml` and
routing parsers"), and two more that take the same kind of text:

| Target                                                                                       | Who writes the input                    | Tests                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Control protocol: `LineFramer`, `validateMessage` (control.mjs)                              | any local process, before the handshake | `test/fuzz/control.fuzz.test.mjs`         |
| vimma-ctl's JSON parser and decoders (json.rs, protocol.rs)                                  | the server, the discovery file          | `tools/vimma-ctl/tests/protocol_props.rs` |
| `config.toml`: smol-toml, schema validation, migrations, `locateKeys` (config.mjs, toml.mjs) | you, and what you paste from elsewhere  | `test/fuzz/config.fuzz.test.mjs`          |
| Routing rules and URL matching (routes.mjs)                                                  | you (rules); pages and apps (URLs)      | `test/fuzz/routes.fuzz.test.mjs`          |
| Key notation (keys.mjs)                                                                      | config.toml, `send-keys`, keydown       | `test/fuzz/keys.fuzz.test.mjs`            |
| The `:` command line (cmdline.mjs)                                                           | you, pasted text; add-on names          | `test/fuzz/cmdline.fuzz.test.mjs`         |
| Omarchy `colors.toml` and theme CSS (theme.mjs)                                              | theme authors                           | `test/fuzz/theme.fuzz.test.mjs`           |

Out of scope: Gecko's own parsers (docs/security/11-out-of-scope-and-trust-boundaries.md § Out of
scope), and the browser-side glue that only passes these parsers' results on.

## Properties

Every target has, where it applies:

- **No throw but the documented error.** `parseKey`/`parseBinding` throw only
  `KeyNotationError`; `parseConfig`, `parseOmarchyColors`, `validateMessage`, `validateRoutes`,
  `matchRoute`, `parseCommandLine` and vimma-ctl's decoders never throw (never panic in Rust).
- **No hang.** Each case runs within a time budget (`within()`), and every target has a case of
  megabyte or deeply nested input with a budget of a few seconds.
- **No prototype pollution.** After every property the harness checks that `Object.prototype`,
  `Array.prototype`, `Function.prototype` and `String.prototype` are unchanged; generators put
  `__proto__`, `constructor`, `toString` and the other `Object.prototype` names in keys and values.
- **Round trips.** Key notation (`parse(format(parse(text)))`), config paths
  (`parsePath(formatPath(p))`), the control framing (lines out = lines in, however the bytes are
  chunked), vimma-ctl's JSON (parse ∘ print) and requests (one line, whatever they hold).
- **Validators reject everything outside the schema.** An accepted config holds only schema
  values (checked independently of config.mjs); a valid protocol message with one field of
  another type, or an unknown field where the protocol is strict, is invalid; `send-keys` passes
  only chords the server can parse, `open` only short http(s), file and about URLs; `:route add`
  writes exactly the given values; a theme gives only `#rrggbb` colours and one CSS rule.
- **Routing never matches outside the rule's domain.** For generated domains (ASCII, IDN, one
  label, `*.` rules) the fuzzer builds hosts around them (`evil-github.com`, `github.com.evil`,
  `xgithub.com`, Cyrillic lookalikes) and disguises them (`github.com@evil`, path, query,
  fragment, `\`, `%2e`, the ideographic full stop, ports, other schemes); a match must agree with
  the URL parser's host. The rule's own host and subdomains always match.

## How it runs

- **JavaScript:** fast-check (MIT, already a dev dependency) under Vitest. The harness
  (`test/fuzz/harness.mjs`) reads `VIMMA_FUZZ_SEED` (default 20261010), `VIMMA_FUZZ_RUNS`
  (default 100 per property, times a per-property weight), `VIMMA_FUZZ_TIME_MS`,
  `VIMMA_FUZZ_PATH` (replay one case) and `VIMMA_FUZZ_OUT` (a JSON file per failure).
- **Rust:** cargo-fuzz needs a nightly toolchain and CI pins stable (rust-toolchain.toml), so
  proptest (MIT OR Apache-2.0, a dev-dependency only, ADR-011) runs in `cargo test` with a fixed
  seed unless `PROPTEST_RNG_SEED` is set; `PROPTEST_CASES` sets the number of cases.
- **CI (ci.yml):** the seeded set runs inside `npm run coverage` and `cargo test`: about 4 s of
  Vitest across workers, under 1 s of Rust properties plus about 10 s compiling proptest.
- **Nightly (fuzz.yml):** a random seed (saved before anything runs), up to 15 s per JavaScript
  property and 200,000 Rust cases; about 4–5 minutes. A failure uploads the seed and each failing
  case (artifact `fuzz-failures`) and opens or comments on one issue labelled `fuzz-failure`. The
  job running our code has `contents: read` only; the report job alone can write issues.
- **Mutation testing** leaves the fuzz properties out (packages/vimma-core/vitest.config.mjs):
  Stryker runs the suite once per mutant.

## Findings (2026-10-10)

Each bug was fixed test-first, its minimal input kept as a regression test.

| Bug                                                                                                                                                                                                                                                    | Severity                                                          | Commit                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| keys.mjs looked keys and modifiers up in plain objects: `parseKey("constructor")` threw a TypeError (a config.toml binding of it crashed the reload), `"__proto__+a"` read as `a`                                                                      | low (F2: a bad file must keep the last good config)               | `fix(security): key names like constructor are unknown keys, …`  |
| `color = "constructor"` passed validation (`in` on the alias table) and the workspace's colour became the Object function                                                                                                                              | low (F2)                                                          | `fix(security): a workspace colour named like an object member…` |
| TOML nesting by dotted keys or table headers was unbounded (smol-toml's `maxDepth` covers inline values only): a stack overflow at 20,000 levels, quadratic time and memory in `locateKeys`, out of memory at 100,000. Reachable from an Omarchy theme | medium-low (a theme anyone can publish can freeze or crash Vimma) | `fix(security): toml nested deeper than 32 levels is refused…`   |
| The `[sites]` IPv6 pattern backtracked quadratically: minutes for a 512 KiB key                                                                                                                                                                        | low (your own file)                                               | `fix(config): a long [sites] key is checked in linear time`      |
| An unknown command-line word was compared with every command by edit distance: 8 s on the main thread for a 1 MiB paste                                                                                                                                | low                                                               | `fix(cmdline): a pasted megabyte no longer freezes the window…`  |
| `validateMessage` called `String()` on a `type` like `{"toString":0}` and threw; the server did the same for an unknown `command`, which wedged the connection until the idle timeout                                                                  | low (needs the token)                                             | `fix(ctl): a message type or command that is not a string…`      |
| vimma-ctl read `-0` as no integer at all, where vimma-core's validator reads 0                                                                                                                                                                         | none in practice                                                  | `fix(vimma-ctl): -0 reads as the integer 0…`                     |

Nothing found in routing (no rule matched outside its domain in 3 × 3,000 runs per property
locally plus CI), the theme's CSS escaping, or vimma-ctl's parser and decoders apart from `-0`.

**Upstream report to file** (smol-toml, squirrelchat/smol-toml): `maxDepth` does not bound
nesting made with dotted keys (`a.a.a….b = 1`) or table headers, so the depth of a parsed
document is bounded only by its size. Vimma works around it in `parseToml` (an iterative depth
check, MAX_DEPTH 32); the vendored copy is unchanged.

## Settled

- **The control server's framing moved into the core** as `LineFramer` (control.mjs), so the
  fuzzer drives the same loop the server runs; the server keeps its behaviour (test_limits).
- **proptest's licence exceptions.** Its tree has three crates the licence check cannot pass
  alone, reviewed in `tools/license-check/cargo-exceptions.json`: unicode-ident
  (`(MIT OR Apache-2.0) AND Unicode-3.0`, compile-time only) and the WASI-only wasip2 and
  wit-bindgen (`Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`). None reaches the binary.
- **Server-to-client messages and results stay lenient** (unknown fields ignored, spec
  m0-control-protocol-and-vimma-ctl); the strictness properties cover requests, hellos, auths and
  response envelopes only. Reserved commands' args are not read, so not checked.

## Follow-up

- File the smol-toml report above; drop the depth workaround's dotted-key part if upstream
  bounds it.
- Coverage-guided fuzzing (cargo-fuzz, Jazzer.js) if a stable toolchain or the budget allows.
