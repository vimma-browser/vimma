# ADR-018: macOS is cross-compiled on Linux, arm64 first

- Status: Accepted
- Date: 2026-10-19

## Context

Vimma builds for Linux x86_64 on GitHub-hosted `ubuntu-24.04` runners (spec
[build-supply-chain](../specs/build-supply-chain.md)). macOS is the second platform (spec
[macos-build](../specs/macos-build.md)). A Firefox build needs about 30 GB of disk; GitHub
documents 14 GB for its hosted Macs, on the free runner and the paid `xlarge` alike, and the free
arm64 Mac has 3 cores and 7 GB of memory. Vimma has no self-hosted runner and plans none
(build-supply-chain, decision 7). Mozilla builds its macOS releases on Linux, and Zen Browser
does the same; Firefox's `--enable-bootstrap` fetches the macOS SDK, clang and the disk-image
tools for such a build.

## Decision

- The macOS build is cross-compiled on a standard GitHub-hosted `ubuntu-24.04` runner, by
  `.github/workflows/macos.yml`, under the same supply-chain rules as the Linux release build:
  verified Firefox source extracted in the job, nothing restored from the Actions cache, a fresh
  objdir and compiler cache, a disk guard and a 16 GB swap file. No job builds on a hosted Mac.
- One architecture: `configs/macos/mozconfig` sets `--target=aarch64-apple-darwin`. Every Mac
  sold since 2023 is Apple Silicon, GitHub's Intel macOS images end in 2027, and one architecture
  halves the build. An Intel or universal build is added only if a tester needs one (spec
  macos-build, decision 3).
- `configs/macos/mozconfig` is read only when Surfer builds for darwin (`SURFER_PLATFORM=darwin`
  on Linux, or a Mac host), so the Linux build does not change. A test checks that the Linux and
  common mozconfigs name no target.
- Signing uses no upstream patch. `mach macos-sign` signs only official Firefox builds
  (`conditions.is_firefox`), so `tools/package/macos-dmg.sh` unpacks the `.dmg` from
  `mach package` with mach's own `unpack_dmg`, runs `rcodesign sign` on the app and packs it with
  `make_dmg`. rcodesign (apple-codesign, MPL-2.0) is a pinned download
  (`tools/package/fetch-rcodesign.sh`); it signs on Linux without a keychain.
- `macos.yml`'s builds, and a release while the repository variable `MACOS_SIGNING` is not
  `developer-id`, are ad hoc signed, with no entitlements and no hardened runtime: entitlements
  take effect only under the hardened runtime, which an ad hoc app on Apple Silicon does not need
  to start. A release with `MACOS_SIGNING=developer-id` is re-signed in `release.yml`'s
  `macos-notarise` job, still on Linux and still with rcodesign, with Vimma's Developer ID
  Application certificate, the hardened runtime and Vimma's production entitlements
  (`configs/macos/entitlements/`), then notarised and stapled with `rcodesign notary-submit`
  (`tools/package/macos-sign-app.sh`; spec macos-build, decisions 23 to 28). The disk image is
  opened and packed again in two jobs of their own (`macos-unpack`, `macos-pack`), so the
  disk-image tools from the build never run beside the signing secrets. The certificate and the
  App Store Connect API key are secrets of the `macos-sign` environment, which only `main` may
  deploy from.
- A hosted `macos-15` runner, which is free on a public repository, checks what was built: the
  `.dmg` mounts, `codesign --verify --deep --strict` passes, the binary is arm64, the version line
  matches and a page renders headless.
- macOS never blocks Linux. `macos.yml` is its own workflow, and nothing in the Linux nightly or
  the Linux release jobs depends on it.

## Consequences

- No Mac is needed to build or to sign, and no new kind of runner is added; the Linux and macOS
  builds share one set of supply-chain rules and tests (`tools/test/full-build-workflows.test.mjs`).
  The Developer ID adds one credential set, confined to one short job (docs/security.md, B14).
- A cold cross build takes about 2 hours 15 minutes on a 4-CPU runner (133 minutes measured,
  `docs/runbook.md`, "macOS build"). If it grows past 4 hours, it moves to a larger hosted Linux runner together with the
  Linux release (build-supply-chain, decision 6).
- An ad hoc app proves nothing about who built it. Gatekeeper refuses it at first start until the
  user allows it under System Settings → Privacy & Security → Open Anyway. A Developer ID release
  opens without that step. Platform passkeys, which need restricted entitlements and a
  provisioning profile, work in neither (issue #544).
- Surfer generates the macOS icon only on a Mac host, and `actool`, which compiles the
  `Assets.car` macOS reads it from, runs only on a Mac with Xcode. The icon files are therefore
  committed and a Mac job checks they match their sources (spec macos-homebrew, decision 13).
