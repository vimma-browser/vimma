## vimma-ctl (control socket client)

Spec m0-control-protocol-and-vimma-ctl, ADR-007, ADR-011. A std-only Rust binary in
`tools/vimma-ctl/`; the toolchain is pinned in its `rust-toolchain.toml` (rustup honours it; a
system Rust of the same version works too). Users get it with Vimma: every release package
ships it next to `vimma` (spec [ship-vimma-ctl](../specs/ship-vimma-ctl.md)); the commands below
are for working on it.

```sh
cd tools/vimma-ctl
cargo test                                    # unit (fixtures) + integration (fake server)
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo build --release --locked                # → target/release/vimma-ctl, one file
install -Dm755 target/release/vimma-ctl ~/.local/bin/vimma-ctl
```

The control socket is **off by default**. Turn it on in `about:config`: `vimma.control.enabled`
= `true` (with it off nothing listens, and `vimma-ctl` exits 3). The browser
writes `<profile>/vimma-control.json` (port, token, pid; mode 0600) while it runs.

```sh
vimma-ctl state                     # mode, pending keys, workspace, tabs (* = selected)
vimma-ctl state --json | jq .tabs   # the raw result; unknown fields pass through
vimma-ctl send-keys ctrl+b c        # chords in Vimma's key notation, space-separated
vimma-ctl open https://example.com  # new tab; prints its id
vimma-ctl --profile /tmp/p --timeout 2 state   # --timeout: seconds, at most 3600
```

Profile: `--profile DIR`, else `VIMMA_PROFILE`, else the default in
`~/.config/vimma/vimma/profiles.ini` (`$XDG_CONFIG_HOME` honoured; legacy `~/.vimma/vimma` if
present): the `[Install…]` section's `Default`, else the `[Profile…]` with `Default=1`.

| Exit | Meaning                                             | Typical fix                                                               |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | server answered with an error (`code: msg`)         | fix the arguments (e.g. `invalid-args` for a `javascript:` URL)           |
| 2    | usage                                               | `vimma-ctl --help`                                                        |
| 3    | not reachable: no profile/file, stale, unsafe, busy | start Vimma, set the pref, `chmod 600` the file, `--profile`; busy: retry |
| 4    | token or protocol refused                           | the file is from another run; restart Vimma                               |
| 5    | malformed reply or timeout                          | a server bug; `--timeout` for a busy browser                              |
