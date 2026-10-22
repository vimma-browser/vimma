# Spec: ship-vimma-ctl

Status: implemented · Area: `.github/workflows/release.yml`, `tools/package/package.mjs`,
`tools/package/cask.mjs`, `tools/package/macos-dmg.sh`, `tools/package/arch-smoke.sh`,
`tools/package/rpm-smoke.sh`, `tools/package/cask-check.sh`, `tools/vimma-ctl/` (`build.rs`,
`src/version.rs`, `src/mcp.rs`, `src/mcp_serve.rs`), `packages/vimma-core/src/ctl-version.mjs`,
`packages/vimma-core/src/control.mjs`, `src/browser/base/content/vimma/ctl/agent-commands.mjs`,
`src/browser/base/content/vimma/ctl/VimmaControl.sys.mjs`,
`src/browser/base/content/vimma/ctl/AgentGate.sys.mjs`,
`src/browser/base/content/vimma/host/agent-ui.mjs` · Upstream patches: none · ADR:
[ADR-011](../adr/011-vimma-ctl-rust.md), [ADR-019](../adr/019-agents-over-mcp.md)

Issue: [#506](https://github.com/vimma-browser/vimma/issues/506)

## Summary

Every release artifact carries `vimma-ctl` next to the `vimma` binary, so the package manager,
the AppImage or the in-app update steps that replace the browser replace the client with it, and
an MCP host points at the shipped binary instead of one built by hand. An agent connection names
its `vimma-ctl` version; a client older than the browser keeps working with the tools it knows,
and both the agent and the user are told that it is older.

## Problem

`vimma-ctl` was in no release artifact. The guide had users build it with `cargo build --release`
in `tools/vimma-ctl/`, and nothing updated that binary afterwards. Browser and client then drift
apart: a browser that serves the mcp-forms commands (`agent-elements`, `agent-activate`,
`agent-fill`, `agent-screenshot`, `agent-console`) behind a client built before them offers an
agent only the older tools, with no message that anything is missing. The agent then reports
that it cannot click or fill, although the browser can.

## Behaviour

1. Each Linux release file carries `vimma-ctl` next to `vimma`: `vimma/vimma-ctl` in the
   tarball, `usr/lib/vimma/vimma-ctl` in the AppImage, `/usr/lib/vimma/vimma-ctl` with a
   `/usr/bin/vimma-ctl` link in the `.deb` and the `.rpm`, and `/opt/vimma/vimma-ctl` with a
   `/usr/bin/vimma-ctl` link from the `PKGBUILD`. The macOS `.dmg` carries
   `Vimma.app/Contents/MacOS/vimma-ctl`, and the Homebrew cask links it into Homebrew's `bin`.
   `package.mjs` refuses to package without it.
2. An AppImage started through a link named `vimma-ctl` runs the `vimma-ctl` inside it, with
   its arguments; under any other name it starts Vimma as before.
3. `vimma-ctl --version` prints `vimma-ctl X.Y.Z (protocol 2)`, where `X.Y.Z` is the Vimma
   version of the tree it was built from; `vimma-ctl mcp`'s `serverInfo` gives the same version.
4. `vimma-ctl mcp`'s `agent-hello` carries `ctl`, its own version. Vimma accepts an
   `agent-hello` without it, as older clients send, and refuses one whose `ctl` is not a Vimma
   version.
5. When Vimma is newer than the client, `vimma-ctl mcp` says so: in its server instructions when
   the discovery file already names a newer Vimma at `initialize`, and at the top of the first
   tool result after it connects to a newer Vimma, once per Vimma version.
6. Vimma shows a one-line notice for an agent connection whose `ctl` is older than Vimma, or
   missing, once no agent question waits; the connection works as any other. The notice reads
   `vimma-ctl 0.1.7 is older than Vimma 0.1.8: agents get fewer tools until you update it`,
   without the client's version when it names none.
7. The discovery file names Vimma's version, `version`, when Vimma's display version is
   `X.Y.Z` with an optional pre-release.

## Research

- **The AppImage runtime sets `ARGV0`.** The type-2 runtime release `20251108` that
  `tools/package/fetch-appimagetool.sh` pins was run with a link named `vimma-ctl` pointing at
  an AppImage packaged by `package.mjs`, both mounted through FUSE and with
  `APPIMAGE_EXTRACT_AND_RUN=1`: in both, `AppRun` saw the link's name in `$ARGV0` and ran
  `usr/lib/vimma/vimma-ctl` (checked on 2026-10-22 on Linux 7.2).
- **glibc.** `vimma-ctl` built for `x86_64-unknown-linux-gnu` on `ubuntu:24.04` (glibc 2.39)
  with Rust 1.99.1 requires the symbol version `GLIBC_2.34` (`objdump -T`). The `.deb` declares
  `libc6 (>= 2.31)` (`DEB_DEPENDS` in `tools/package/package.mjs`), the floor of the browser
  itself. Built for `x86_64-unknown-linux-musl` in the same container, it is one
  `static-pie linked` file of 873 KiB that needs no system library.
- **No crate is downloaded.** The crate has no dependencies (ADR-011); with an empty
  `CARGO_HOME`, `cargo build --release --locked` reads the crates.io index to resolve the lock
  file and downloads no crate (its one dev-dependency, `proptest`, is fetched only for tests).
- **The tarball update path.** The update steps for a tarball install unpack the new release
  tarball over the install's parent directory (`updateSteps`, `tarball`, in
  `packages/vimma-core/src/updates.mjs`); an AppImage is replaced at its own path, and the
  `.deb`, `.rpm`, `PKGBUILD` and Homebrew updates replace the whole package. A file inside the
  release tarball's `vimma/` directory is therefore replaced by every update path.
- **When `vimma-ctl mcp` connects.** It connects at the first tool call, not at `initialize`
  ([vimma-mcp](vimma-mcp.md), decision 40), so the server instructions are sent before it has
  talked to Vimma; the `welcome` line already carries Vimma's version
  (`MOZ_APP_VERSION_DISPLAY`, `ctl/VimmaControl.sys.mjs`).

## Design

1. **Built by the release workflow, in jobs of their own.** `release.yml`'s `ctl` job builds the
   Linux binary after `build`, from the commit `build` checked, and `package` puts it into every
   package; `macos-ctl` builds the Mac binary and `macos-build` signs it into the app. Neither
   job deploys to the `build` environment, so the Safe Browsing key is out of their reach, since
   compiling a std-only client needs no secret.
2. **One static Linux binary (musl).** Vimma's own floor is glibc 2.31, and a glibc build on the
   Ubuntu 24.04 runner needs `GLIBC_2.34`, so it would not run everywhere the browser does; a
   static musl binary runs on every distribution and inside the AppImage alike. Rejected: building
   in an older container or against Mozilla's sysroot, because both add an image or toolchain to
   pin for a binary that needs nothing from the system.
3. **The Mac binary is built on a hosted Mac.** The cross-build runner links Firefox through
   `mach` with its bootstrapped toolchain and SDK; a standalone Mach-O binary from cargo would
   need that linker set up by hand. A native `cargo build` on `macos-15` gives an arm64 binary
   with no extra setup. `macos-ctl` checks the tag as `build` does, and `macos-build` refuses a
   binary built from any commit but the one it checked, so the app and its client share a source.
4. **Vimma's version, from surfer.json.** `build.rs` reads
   `brands.vimma.release.displayVersion` from `surfer.json` into `VIMMA_VERSION`, so a client
   and the browser built from one tree carry one version and release-please keeps bumping one
   file. Rejected: bumping `Cargo.toml`'s version with release-please, because `Cargo.lock`
   repeats it and `cargo build --locked` fails when the two drift; and setting the version only
   in the release job, because a source build would then claim an old version and always warn.
5. **The release tarball is mach's, repacked with `vimma-ctl`.** `package.mjs` copies the
   binary into the unpacked `vimma/` before it builds anything, so the tarball, the AppImage, the
   `.deb`, the `.rpm` and the `PKGBUILD` (which installs the tarball) carry the same file, and
   every update path replaces it with the browser. The tarball is packed with owner and group 0
   and sorted names, as `mach package` makes it. Rejected: a separate `vimma-ctl` release asset,
   because every update command installs one file per install type and would leave it behind.
6. **An older client keeps its own tools.** Vimma checks every command it receives on the
   agent connection, so an older client is a smaller tool set, never a weaker gate; it is
   welcomed, its commands run, and only the notice differs. Rejected: refusing an older client
   until it is updated, because an update in the middle of a session would end the agent's work
   without making anything safer.
7. **A missing `ctl` counts as older.** Clients from before this change send no `ctl`, and they
   are the ones the notice is for, so Vimma says `vimma-ctl is older than Vimma X.Y.Z`. A client
   newer than Vimma gets no notice, because its extra tools fail with `unknown-command` and the
   update notice already tells the user about a newer Vimma.
8. **The version check compares X.Y.Z.** A pre-release sorts before its release, and two
   pre-releases of one release compare equal, so nightlies of one release never warn about
   each other. vimma-core's `compareVersions` and vimma-ctl's `version::compare` implement the
   same rule, each with its own tests.
9. **The notice is per connection, and waits for the question line.** Each MCP session opens
   one connection and keeps it, so a notice per connection names each stale session once. The
   connection opens at the agent's first call, whose question follows the hello at once, and a
   notice shown then would cover the question's answer keys; so `AgentGate.notify` marks it
   `hold`, and `host/agent-ui.mjs` shows it 1.6 s after no question waits (after an answer's own
   1.5 s notice), for 6 s, as long as an update announcement stays.
10. **The discovery file names Vimma's version.** `vimma-ctl mcp` reads it before `initialize`
    answers, so the server instructions can already say the client is older; the version is no
    secret, since the `welcome` and `vimma --version` give it too.
11. **The client's note goes at the top of the first tool result.** Server instructions are
    fixed for the session, and Vimma may be updated during it, so the first result after each
    connection to a newer Vimma carries the note too, once per Vimma version, so it does not
    repeat on every call. The note tells the agent to ask the user to update `vimma-ctl`.
12. **The AppImage dispatches on its name.** An AppImage is one file, so a link named
    `vimma-ctl` to it selects the client, as multi-call binaries do. Rejected: a `--ctl` flag,
    because every other argument goes to Firefox's own command-line parsing.
13. **The weekly macOS build is unchanged.** `macos-dmg.sh` adds `vimma-ctl` only when
    `VIMMA_CTL` names one, which `release.yml` sets; the weekly build's dmg is a test build,
    not an artifact users install.
14. **The Flatpak gets the file, not a command.** Its manifest copies the release tarball's
    `vimma/` into `/app/lib/vimma`, so `vimma-ctl` is inside the sandbox, but nothing puts it on
    the host's `PATH`. Whether `flatpak run --command=/app/lib/vimma/vimma-ctl` finds the
    sandboxed profile was not checked. A host-side command is left to the [flatpak](flatpak.md)
    spec, because exposing a sandboxed binary to the host is a sandbox decision.

## Security and privacy

- No new browser surface. `ctl` is a label, like `client` and `via`: it changes only whether
  the notice is shown, never what the connection may do (docs/security.md, M33). The discovery
  file's new `version` is public information.
- The release gains two build jobs, `ctl` and `macos-ctl`, with a read-only token, no
  environment and no secret; the Rust toolchain comes through the runner's rustup from the
  version pinned in `rust-toolchain.toml`, and no crate is downloaded. The binary reaches users
  only inside packages that `SHA256SUMS` lists and the `sign` jobs sign (docs/security.md, B13).
- The agent-facing note is text `vimma-ctl` writes itself, never page content.

## Tests

- vitest (`packages/vimma-core/test/ctl-version.test.mjs`): `compareVersions` orders by number,
  puts a pre-release before its release, returns NaN for anything else; `isCtlVersion` accepts
  SemVer up to 64 characters; `ctlVersionNotice` says nothing for a client as new or newer,
  names both versions for an older one, says older for a client with no version.
- Contract fixtures (`tests/contract/control/v2/`): `request-agent-hello-ctl.valid.json` and
  `.invalid.json`, `discovery-version.valid.json` and `.invalid.json`, checked by vimma-core's
  validator and by vimma-ctl's decoder.
- cargo (`tools/vimma-ctl/tests/mcp.rs`): `agent_hello_names_this_vimma_ctl_version`,
  `an_older_client_says_so_in_its_first_tool_result`,
  `the_instructions_name_an_older_client_when_the_discovery_file_does`; `version.rs` unit tests.
- mochitest (`tests/browser/browser_vimma_mcp_agent.js`):
  `test_an_older_vimma_ctl_gets_a_notice_and_still_works`,
  `test_the_older_client_notice_waits_for_the_question_line`.
- vitest (`tools/package/test/package.test.mjs`): `runs vimma-ctl when started through a link
named vimma-ctl`, `repacks the mach tarball under the release name with vimma-ctl next to
vimma`, `puts vimma-ctl next to vimma in the AppDir, and on PATH in the .deb and the .rpm`,
  `puts the tarball's vimma-ctl on PATH`, `refuses to package without an executable vimma-ctl`;
  the `.deb` and `.rpm` contents tests check the binary and its link.
- vitest (`tools/package/test/release-workflow.test.mjs`, the `vimma-ctl` group): the `ctl`,
  `macos-ctl`, `package`, `macos-build` and `macos-smoke` jobs; `cask.test.mjs`: the cask links
  `vimma-ctl` and `cask-check.sh` checks the link.
- `tools/package/arch-smoke.sh`, `rpm-smoke.sh` and `cask-check.sh`, on pull requests with stub
  binaries and in `release.yml` with the real ones: `vimma-ctl --version` on `PATH` names the
  release's version.

## Docs and changelog

- `docs/guide.md`: "Installing" names where each package puts `vimma-ctl`; "Connecting an
  agent's tool" points MCP hosts at the shipped binary and describes the older-client notice;
  "Scripting with vimma-ctl" drops the build step.
- `CONTRIBUTING.md`: building `vimma-ctl` from source, and where its version comes from.
- `docs/security.md`: M33 and B13.
- `CHANGELOG.md`: "Release packages ship vimma-ctl, and an older vimma-ctl says it is older".

## Delivery

One pull request, closing #506.

## Open questions

None.
