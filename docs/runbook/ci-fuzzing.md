### Fuzzing (`fuzz.yml`, spec m7-fuzzing)

The parsers of outside input (control protocol, `config.toml`, routing rules, key notation, the
command line, the Omarchy theme reader, vimma-ctl's JSON and decoders, `vimma-ctl mcp`'s JSON-RPC)
have property-based fuzz tests: fast-check in `packages/vimma-core/test/fuzz/`, proptest in
`tools/vimma-ctl/tests/protocol_props.rs` and `tools/vimma-ctl/tests/mcp_props.rs`. Every CI run checks them with a fixed seed and few
cases. `fuzz.yml` runs them nightly with a random seed and many more cases; on a failure it
uploads the artifact `fuzz-failures` (`seed.txt`, one JSON file per failing JavaScript property
with its seed, replay path and counterexample, and proptest's `*.proptest-regressions`) and opens
or comments on one issue labelled `fuzz-failure`. Close the issue when the fix is merged.

A manual run: `gh workflow run fuzz.yml` (random seed), or `-f seed=123 -f runs=5000`.

#### Fuzzing: reproducing a failing seed

JavaScript. The issue and the failure file give the seed and, per property, the replay path
(`counterexamplePath`). One property, one case, at once (the failure file's `replay` line is this
command, filled in):

```sh
VIMMA_FUZZ_SEED=<seed> VIMMA_FUZZ_PATH=<path> npx vitest run packages/vimma-core/test/fuzz \
  -t '<test title>'
```

`-t` takes the test's title as written in `test(...)`, not the failure file's name
(`config-no-throw`), which matches nothing and so runs no test.

Without `VIMMA_FUZZ_PATH`, the same seed and `VIMMA_FUZZ_RUNS` repeat the whole search (the
nightly used `VIMMA_FUZZ_RUNS=1000000` with a 15 s limit per property, so a late failure can
take that long). fast-check prints the shrunk counterexample; turn it into a plain regression
test next to the parser (see the "Regression (found by the fuzzer …)" tests), red first, then
fix. A hang leaves only `seed.txt`: run the target's file with that seed and a small
`VIMMA_FUZZ_TIME_MS` budget to find the slow input.

Rust. proptest is deterministic per seed:

```sh
cd tools/vimma-ctl
PROPTEST_RNG_SEED=<seed> PROPTEST_CASES=200000 cargo test --release --test protocol_props --test mcp_props
```

or copy the artifact's `protocol_props.proptest-regressions` (or `mcp_props.…`) to `tools/vimma-ctl/tests/`, where
proptest replays its `cc` lines first in every run; commit it with the fix as the regression.

Locally, a longer search than CI's: `VIMMA_FUZZ_SEED=$RANDOM VIMMA_FUZZ_RUNS=5000 npx vitest run
packages/vimma-core/test/fuzz` (about a minute).
