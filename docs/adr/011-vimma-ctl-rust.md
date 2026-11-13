# ADR-011: vimma-ctl is written in Rust

- Status: Accepted
- Date: 2026-10-09

## Context

ADR-007 gives Vimma a control socket and names a user-facing client, `vimma-ctl`; plan §3 left
its language open ("Python/Node CLI"). The client runs outside the browser: in shell scripts,
window-manager bindings (Hyprland `bind = …, exec, vimma-ctl send-keys …`) and the e2e harness.
It is called often and must start fast. It ships to users, first through the AUR (plan §4,
release), so it should be one self-contained file. ADR-004 (JavaScript with JSDoc) covers code
inside the browser and is not changed by this.

## Decision

`vimma-ctl` is a Rust binary crate at `tools/vimma-ctl/` (a standalone crate, not a workspace at
the repo root: it is our only Rust, and a root `Cargo.toml` would sit beside Surfer's tree for no
gain). It uses **std only**: TCP, timeouts, file permissions and a small strict JSON
parser/printer (`src/json.rs`) are written against the standard library. Any future dependency
needs a licence check (`npm run license-check:crates`) and a PR line, like npm packages.

The protocol is specified once (docs/specs/m0-control-protocol-and-vimma-ctl.md) and pinned by
JSON fixtures in `tests/contract/control/v1/`, which both the Rust client's tests and
vimma-core's JavaScript validator (used by the browser-side server) read.

## Reasoning

- **Startup.** A Rust binary starts in about a millisecond; Node needs tens of milliseconds and
  Python about as many before the first byte is sent. A key binding or a loop in a script feels
  the difference.
- **One file to ship.** `cargo build --release` gives one static-enough ELF with no interpreter
  to install or keep in step; the AUR package is a `cp`. A Node CLI needs Node at a compatible
  version on every user's machine (or a bundled runtime of ~40 MB); Python needs Python and
  a packaging story (zipapp, pipx).
- **No dependencies.** The client needs a TCP socket, a line reader with a deadline, and JSON for
  a handful of message shapes. std covers the first two; a 300-line parser with tests covers the
  third. No supply chain, nothing for Renovate to bump, a licence check that stays trivial.
  `serde_json` would also be acceptable (MIT OR Apache-2.0) but brings `serde` and number
  formatting crates for no protocol need.
- **Contract, not shared code.** The server is JavaScript (ADR-004) and the client Rust, so they
  cannot share an implementation. They share fixtures instead; each side's tests run every
  fixture, and a Rust test reads vimma-core's `MODES` and `ERROR_CODES` so the lists cannot drift.

## Alternatives rejected

- **Node CLI.** Same language as the rest of the repo and could import vimma-core's validator
  directly. Rejected: users would need Node installed, startup is slower, and distribution means
  either a runtime dependency in the AUR package or a bundled runtime.
- **Python.** Rejected for the same distribution reasons (an interpreter at a compatible version,
  packaging), with no advantage over Node for this repo.
- **Shell (`nc`/`socat` + `jq`).** Too fragile for the handshake, timeouts and error reporting,
  and depends on tools users may lack. Fine as an example in the docs, not as the client.

## Consequences

- CI installs the toolchain pinned in `tools/vimma-ctl/rust-toolchain.toml` with the runner's
  rustup and runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (clippy
  `pedantic` is on in `Cargo.toml`) and `cargo test`, as steps of the existing `ci.yml` job (one
  job on purpose: minutes are billed per job). No third-party toolchain action.
- Crate licences are checked by `tools/license-check/cargo-license-check.mjs` (Since changed:
  `cargo-license-check.ts`, ADR-025) from `cargo metadata`, against the same allowlist as npm
  packages (`npm run license-check:crates`).
- Distribution is one binary: `cargo build --release --locked` in `tools/vimma-ctl/`. The release
  workflow and the AUR package pick it up when they exist.
- Contributors who touch the client need a Rust toolchain; everyone else does not. The browser
  build does not depend on the crate.
- Bumping the toolchain is a one-line change to `rust-toolchain.toml` (Renovate does not manage
  it); new clippy lints may need fixes then.
