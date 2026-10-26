# Spec: macos-build

Status: draft (sub-PRs 1, 3, 6 and 7 built; sub-PR 2 built except its two macOS mochitests;
sub-PR 5's macOS key inventory built, #384) · Area: `configs/macos/mozconfig`,
`configs/macos/entitlements/` (new), `tools/package/macos-dmg.sh` (new),
`tools/package/macos-dmg-unpack.sh`, `macos-sign-app.sh`, `macos-dmg-pack.sh` and
`macos-developer-id-check.sh` (new),
`configs/branding/vimma/`, `tools/artifact-build/`,
`tools/e2e/`, `tools/mochitest.mjs`, `tools/start.mjs`, `tools/vimma-ctl/src/discovery.rs`,
`tools/vimma-ctl/src/mcp_serve.rs`, `.github/workflows/ci.yml`, `e2e.yml`, `macos.yml` (new),
`release.yml`;
`docs/guide.md`, `docs/limits.md`, `CONTRIBUTING.md`, `docs/runbook.md` · Upstream patches: none
(decision 7) · ADR:
[ADR-018](../adr/018-macos-cross-build.md) ("macOS is cross-compiled on Linux, arm64 first")

Issue: [#238](https://github.com/vimma-browser/vimma/issues/238)

Engine paths are relative to `engine/` and were checked against Firefox 158.0. Surfer paths
(`S/`) are relative to `node_modules/@zen-browser/surfer`, version 1.14.9. Zen Browser
references are `zen-browser/desktop`, branch `dev` at commit b53d568. GitHub and Apple facts come
from their documentation as cited; anything not confirmed from a primary source is marked
**unverified**.

## Summary

Vimma is built and tested on Linux x86_64 only. This spec makes macOS on Apple Silicon the second
platform: a `.dmg` cross-compiled on a GitHub-hosted Linux runner, signed, smoke-tested on a
GitHub-hosted Mac, and Vimma's front-end tests run on a Mac on every pull request. Test builds are
ad hoc signed; a release is signed with Vimma's Developer ID and notarised by Apple once the
repository variable `MACOS_SIGNING` is `developer-id`. It needs no Mac to build, and publishes
nothing until the release gate opens. Windows is not a target platform.

## Problem

- Vimma's audience, keyboard-first developers, is largely on Linux and macOS, and Vimma cannot be
  run on a Mac at all.
- `configs/macos/mozconfig` exists but has never been used: it is the Linux file plus `-j4`, with
  no target, no SDK and no signing.
- Nothing tests Vimma's code on macOS. Several parts assume Linux and fail or behave differently
  there: `vimma-ctl` cannot find a running Vimma's profile on macOS without `--profile`
  (`tools/vimma-ctl/src/discovery.rs:58-73`), the developer tools read `/proc/locks` and Linux
  objdir paths (`tools/start.mjs:40, 197`), and the e2e harness starts Xvfb
  (`tools/e2e/launcher.mjs:269-387`).
- A change that breaks macOS shows no red check, so the Linux-only assumptions accumulate.
- `plan.md` and `docs/limits.md` still listed Windows as "when cheap", which no longer reflects the
  platform order.

## Behaviour

1. A `.dmg` for Apple Silicon (`aarch64-apple-darwin`) is built by CI from the same commit and the
   same Firefox release as the Linux build, and is available as a workflow artifact.
2. The app in that `.dmg` launches on Apple Silicon. A release signed with Vimma's Developer ID
   and notarised opens like any app: Gatekeeper accepts it, offline too, from its stapled ticket.
   An ad hoc signed build (every `macos.yml` build, and a release while `MACOS_SIGNING` is not
   `developer-id`) makes macOS ask once, in System Settings > Privacy & Security, before it first
   opens.
3. Every Vimma key works as on Linux: `ctrl+b` is the prefix, and the modal layer, hints,
   workspaces, panes, the side panel, the status bar and `ctrl+b ?` behave the same.
4. `cmd+q` quits, as `ctrl+q` does on Linux: Firefox's `accel` is `cmd` (meta) on macOS, and
   `[firefox] disable = "all"` keeps `cmd+q` (fate d in the macOS inventory, decision 22).
5. A character typed with Option matches a binding for that character: Option+shift+8 on a Finnish
   layout types `{` and fires a `{` binding. An `alt+<letter>` binding does not fire on a Mac
   (open question 4).
6. Without Omarchy, Vimma uses its built-in palette and follows the system's light or dark
   setting live. Nothing mentions Omarchy or Hyprland, and no Omarchy path is polled.
7. The private workspace opens as its own window, as on any non-Hyprland system.
8. `vimma-ctl` with no `--profile` and no `VIMMA_PROFILE` finds the running Vimma, whose profiles
   live in `~/Library/Application Support/Vimma/`. A discovery file left by a crashed Vimma is
   reported as stale, as on Linux.
9. `config.toml` is read from `$XDG_CONFIG_HOME/vimma/config.toml`, else
   `~/.config/vimma/config.toml`, as on Linux (decision 18).
10. `vimma --version` prints the same line as on Linux, `Vimma <vimma> · Firefox <firefox>`
    (firefox-versions).
11. A pull request that breaks Vimma's front end on macOS shows a failing check from a hosted Mac.
12. Once the maintainer sets the repository variable `MACOS_RELEASE_ENABLED`, every release has a
    `vimma-<vimma>-macos-aarch64.dmg`, its `SHA256SUMS-macos` and their Sigstore bundles beside
    the Linux files. Before that, and always for vimma.dev, nothing macOS-related is published.
13. While `MACOS_SIGNING` is `developer-id`, the released app is signed with Vimma's Developer ID
    Application certificate, under the hardened runtime with Vimma's production entitlements, with
    a secure timestamp, notarised and stapled; a hosted Mac checks this with `codesign`, `spctl`
    and `stapler` before anything is published. A missing signing secret then fails the release;
    it never falls back to an ad hoc `.dmg`. Otherwise the release is ad hoc signed, and its run's
    summary says so.

## Research

### Surfer on macOS

- **Platform.** `process.surferPlatform` is `SURFER_PLATFORM`, else `process.platform`
  (`S/dist/index.js:5-11`); `darwin` maps to `macos` (`S/dist/commands/build.js:19-23`), which
  selects `configs/macos/mozconfig`.
- **mozconfig.** `applyConfig` (`build.js:50-66`) concatenates `configs/common/mozconfig`,
  `configs/<os>/mozconfig`, an optional root `mozconfig` and Surfer's own block, whose only Mac
  line is `MOZ_MACBUNDLE_NAME="<brand>.app"` (`S/dist/constants/mozconfig.js:59`).
- **Ours.** `configs/macos/mozconfig` is the Linux file plus `-j4`. `configs/common/mozconfig`
  already has what a Mac build needs: `--enable-bootstrap` (line 20), `--disable-crashreporter`
  (24), `--disable-updater` (44), and a Safe Browsing key only when a key file exists, so keyless
  builds work and default Safe Browsing off (46-59).
- **`surfer build --ui`** is `./mach build faster` on every OS (`build.js:89`).
- **Packaging.** Vimma's workflows call `./mach package` directly (`nightly.yml:104-111`,
  `release.yml:134-138`). For a cocoa target `MOZ_PKG_FORMAT` defaults to `DMG`
  (`toolkit/moz.configure:3699-3707`), and the package is named
  `<app>-<firefox version>.<locale>.mac.dmg` (`toolkit/mozapps/installer/package-name.mk:18`;
  `mac` from `toolkit/moz.configure:3637`).
- **Not in Surfer:** no signing, no universal build, no `--target` option. Surfer's update code
  names a macOS MAR `macos.mar` and maps Apple Silicon to the update platform
  `Darwin_aarch64-gcc3` (`S/dist/commands/updates/browser.js:22-31, 54`).
- **Icons.** Surfer converts `configs/branding/<brand>/logo-mac.png` into `firefox.icns` only
  when `process.platform` is `darwin` (`S/dist/commands/patches/branding-patch.js:68-81`), so a
  Linux cross build needs the `.icns` committed. macOS takes the app icon from `Assets.car`
  first, so that is committed too (spec [macos-homebrew](macos-homebrew.md), decision 13).
- **Download on a Mac.** `surfer download` requires GNU tar (`gtar`) on macOS
  (`S/dist/commands/download/firefox.js:49-52`).

### Firefox's macOS build requirements

- **SDK.** The minimum is macOS SDK 26.5 (`build/moz.configure/toolchain.configure:254-255`);
  configure stops on an older one (311-315). With `--enable-bootstrap` and no `--with-macos-sdk`,
  configure fetches `MacOSX26.5.sdk` from Mozilla's toolchain tasks (258-264;
  `taskcluster/kinds/toolchain/macos-sdk.yml`, task `macosx64-sdk-26.5`). The SDK minimum can
  rise with any Firefox release; bootstrap then fetches the new one. Whether redistributing the
  SDK is permitted is **unverified**; Vimma only fetches it, as every Firefox contributor does.
- **Deployment target** defaults to 11.0 for aarch64 and 10.15 for x86_64
  (`toolchain.configure:197-208`).
- **Mozilla builds macOS on Linux.** Its macOS build tasks run on `b-linux-docker-amd` workers
  (`taskcluster/kinds/build/macosx.yml:8`) with `build/macosx/cross-mozconfig.common` (cctools on
  `PATH`, the DMG tools, `--target=x86_64-apple-darwin`, lines 8-23), and notarise on Linux with
  rcodesign (`taskcluster/docs/kinds.md:51-56`).
- **Linker and DMG tools.** With clang 15 or newer the macOS linker is lld; ld64 from cctools is
  the fallback when cross-compiling (`toolchain.configure:1822-1827`). `make_dmg` uses
  `DMG_TOOL`, `HFS_TOOL` and `MKFSHFS` when configure found them, and otherwise fetches
  `dmg/dmg`, `dmg/hfsplus` and `hfsplus/newfs_hfs` with `bootstrap_toolchain`
  (`python/mozbuild/mozbuild/action/make_dmg.py:49-53`). Zen fetches cctools, libdmg and hfsplus
  explicitly instead (below); whether bootstrap alone is enough is confirmed in sub-PR 3.
- **Building on a Mac** needs Xcode or the command line tools (`mach bootstrap` checks
  `xcode-select --print-path`, `python/mozboot/mozboot/osx.py:90-111`) and "at least 30GB of free
  disk space" (firefox-source-docs, "Building Firefox On macOS").
- **Signing tool.** `mach macos-sign` (`tools/signing/macos/mach_commands.py:24`) signs ad hoc by
  default, or with a p12 through rcodesign (`--use_rcodesign`, line 106). It is limited to Firefox
  by `conditions=[conditions.is_firefox]` (line 40), which Zen patches out. Ad hoc signing with
  `-e production` is refused because production entitlements need a team ID and the bundle
  "will not be launchable" (204-245). An unsigned build therefore uses the `developer`
  entitlements (`security/mac/hardenedruntime/developer/`).
- **Production entitlements** (`security/mac/hardenedruntime/production/firefox.browser.xml`) name
  Mozilla's team ID in `com.apple.application-identifier` (lines 31-32) and request passkeys
  (`com.apple.developer.web-browser.public-key-credential`, line 35), which need a provisioning
  profile. A signed Vimma needs its own copy with its own team ID.
- **Universal binaries** are made by Mozilla's `toolkit/mozapps/installer/unify.py` (with
  `python/mozbuild/mozpack/unify.py`) from two `.app` bundles, not by plain `lipo`.
- **Artifact builds** support a Mac host: mach picks the job `macosx64-aarch64` from
  `TARGET_CPU` (`python/mozbuild/mozbuild/artifacts.py:1459-1464`), and `MacArtifactJob` fetches
  `public/build/target.dmg` (774-775).

### Zen Browser's macOS pipeline

Zen cross-compiles both architectures on Linux and uses Macs only to profile, unify, sign and
notarise (`zen-browser/desktop`, `dev` at b53d568):

- **Cross build** (`.github/workflows/macos-release-build.yml`): runs on
  `blacksmith-8vcpu-ubuntu-2404`, a third-party runner service (line 39), matrix
  `[x86_64, aarch64]` (47), frees disk with `jlumbroso/free-disk-space` (51), fetches
  `linux64-cctools-port`, `linux64-libdmg` and `linux64-hfsplus` with `mach artifact toolchain`
  (105-113), and builds with `SURFER_PLATFORM=darwin` (132-141).
- **PGO**: an instrumented build is profiled on hosted Macs (`macos-profile-build.yml`).
- **Unify, sign, notarise** (`macos-universal-release-build.yml`, on `macos-26`): `unify`,
  `cargo install apple-codesign`, the p12 from a secret, `mach macos-sign -r -c release -e
production`, `make_dmg`, `xcrun notarytool submit --wait`, `xcrun stapler staple`.
- **Measured times** (GitHub API, Zen runs 37900069684 and 37495693564): one architecture's cross
  build 28-53 minutes on 8 vCPU; signing 29 s; notarising and stapling 6.5 minutes.

### GitHub-hosted runners

From GitHub's "GitHub-hosted runners" reference
(`docs.github.com/en/actions/reference/runners/github-hosted-runners`), "Actions limits"
(`docs.github.com/en/actions/reference/limits`), "Larger runners"
(`docs.github.com/en/actions/reference/runners/larger-runners`) and "Actions runner pricing"
(`docs.github.com/en/billing/reference/actions-runner-pricing`), read October 2026:

| Runner (public repository)                     | CPU    | RAM   | Documented SSD | Price per minute |
| ---------------------------------------------- | ------ | ----- | -------------- | ---------------- |
| Standard Linux x64, `ubuntu-24.04`             | 4      | 16 GB | 14 GB          | free             |
| Standard macOS arm64, `macos-15`, `macos-26`   | 3 (M1) | 7 GB  | 14 GB          | free             |
| Standard macOS Intel, `macos-15-intel`         | 4      | 14 GB | 14 GB          | free             |
| Larger Linux, 16-core                          | 16     | 64 GB | 600 GB         | $0.042           |
| Larger macOS arm64, `macos-15-xlarge` (M2 Pro) | 5      | 14 GB | 14 GB          | $0.102           |

- "Each job in a workflow can run for up to 6 hours of execution time." The free plan allows at
  most 5 concurrent macOS jobs. Cache storage is 10 GB per repository.
- "Larger runners are only available for organizations and enterprises using the GitHub Team or
  GitHub Enterprise Cloud plans" and "are not free for public repositories". Vimma's repository
  belongs to a user account, so larger runners would need a move to an organisation.
- The standard Linux runner has far more free disk than documented: [build-supply-chain](build-supply-chain.md)
  (R9) measured 85 GB free on `ubuntu-24.04` before the Firefox source is
  downloaded. A Firefox build needs about 30 GB (R10 there). The free disk on hosted Macs beyond
  the documented 14 GB is **not measured**.
- GitHub announced that Intel macOS images end when the macOS 15 image retires in fall 2027
  (GitHub changelog, 2025-09-19); `macos-26-intel` is listed with no end date.
- **Consequence.** A native Firefox build does not fit a hosted Mac by its documented limits
  (14 GB against Mozilla's 30 GB), including the paid `xlarge`. A cross build on the standard
  Linux runner fits its measured disk and, by the estimate below, its time limit. Hosted Macs are
  for running a build, not making one.

### Apple: Developer ID, notarisation, unsigned builds

- **Apple Developer Program**: 99 USD per membership year (developer.apple.com/programs/enroll,
  read from the search result; the page is script-rendered). It provides the Developer ID
  Application certificate that notarisation needs.
- **Notarisation** needs Developer ID signing, the hardened runtime and a secure timestamp
  ("Notarizing macOS software before distribution"); `xcrun notarytool submit … --wait`, then
  `xcrun stapler staple`. With an Apple ID it needs an app-specific password ("Customizing the
  notarization workflow").
- **rcodesign on Linux** (apple-codesign 0.29.0, the pinned release; its `docs/` and
  `src/cli/mod.rs` at tag `apple-codesign/0.29.0`): `rcodesign sign` signs a bundle's nested
  bundles and Mach-O binaries recursively, inside-out, in one run ("Nested Signing By Default").
  Settings without a scope apply to the main entity only; `<path>:<value>` scopes a setting to a
  bundle-relative path, and to everything inside it when the path is a nested bundle
  (`apple_codesign_settings_scope.rst`). The secure timestamp defaults to
  `http://timestamp.apple.com/ts01` whenever a certificate signs (`APPLE_TIMESTAMP_URL`).
  `--for-notarization` refuses a certificate that is not Apple-issued Developer ID or a signature
  without a timestamp, and turns the hardened runtime on for every Mach-O
  (`ensure_for_notarization_settings` in `signing_settings.rs`). `rcodesign notary-submit
--api-key-file <json> --wait --staple <path>` notarises with an App Store Connect API key, the
  JSON that `rcodesign encode-app-store-connect-api-key` writes, and staples a bundle's ticket into
  `Contents/CodeResources` (`stapling.rs`); a `.dmg` and a `.pkg` can be notarised and stapled too.
  `rcodesign analyze-certificate` prints a certificate's subject and team ID.
- **How Mozilla signs and notarises Firefox** (Firefox 158.0): `mach macos-sign -r` signs with
  rcodesign in one run, with the hardened runtime and entitlements scoped per helper
  (`tools/signing/macos/mach_commands.py`, `sign_with_rcodesign`), from the list in
  `taskcluster/config.yml` (`mac-signing.hardened-sign-config.production`): `plugin-container.app`
  and `media-plugin-helper.app` with their own entitlement files, `security-module-helper.app` on
  Nightly only, the runtime flag alone on the other helpers, `XUL` and the dylibs, and the browser
  entitlements on the app. Its `production-without-restricted` option drops
  `com.apple.application-identifier` and `com.apple.developer.web-browser.public-key-credential`
  for "a Developer ID certificate not associated with an account approved for the restricted
  entitlements"; with them, signing needs "a provisioning profile to be added to the bundle". The
  release pipeline notarises the signed `.app` (`taskcluster/kinds/build-mac-notarization`) and
  only then makes the `.dmg` (`taskcluster/kinds/repackage`, which depends on it); no signing
  task takes the `.dmg`.
- **Apple Silicon runs nothing unsigned**: "any executable must be signed before it's allowed to
  run … a simple ad-hoc signature is sufficient", but ad hoc binaries "cannot pass through
  Gatekeeper" (macOS Big Sur 11.0.1 universal apps release notes).
- **What a tester sees** with an ad hoc build downloaded in a browser: macOS refuses to open it.
  Since Sequoia, "users will no longer be able to Control-click to override Gatekeeper … They'll
  need to visit System Settings > Privacy & Security" (Apple developer news, 2024-08-06) and choose
  **Open Anyway** once. Removing the quarantine attribute
  (`xattr -dr com.apple.quarantine /Applications/Vimma.app`) is common practice (**unverified**
  against an Apple page). macOS 26 is assumed to behave as Sequoia (**unverified**). A file
  fetched with `gh run download` or `curl` carries no quarantine attribute.
- **Secrets in CI** (GitHub's "Sign Xcode applications" guide): the p12 as a base64 secret and its
  password in a temporary keychain deleted in an `always()` step. With rcodesign the p12 needs no
  keychain.
- **Checking a signed app on a Mac:** `codesign -dvv` prints the `Authority=` chain, the
  `TeamIdentifier=`, `Timestamp=` for a secure timestamp, and the code directory's flags, which
  include `runtime` under the hardened runtime; `spctl --assess --type execute -vv` prints
  `source=Notarized Developer ID` for a notarised app; `xcrun stapler validate` checks a stapled
  ticket. These output formats are **unverified** against a Vimma build: no Developer ID build
  exists before the first signed release, whose smoke job confirms them.

### Homebrew

- Homebrew 5.0 (brew.sh, 2025-11-12): "Casks without codesigning are deprecated. We will disable
  all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026." The official
  cask repository also requires notability (Homebrew's Acceptable Casks policy).
- "You don't need to sign software to put it in your own tap" (Homebrew discussion 6334), but
  Gatekeeper still stops an unsigned app on first open.

### Vimma's Linux-specific parts and their macOS behaviour

Paths under `vimma/` are `src/browser/base/content/vimma/`.

| Part                    | Where                                                                                                               | On macOS before this spec                                                                                                                                                                                        | Needed                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Omarchy theme           | `vimma/ui/theme-host.mjs`: `lookForOmarchy` 102-107, `syncTimer` 286-293                                            | Omarchy is looked for once per process; without it no poll timer runs and the built-in palette follows the system appearance (theme-appearance, implemented). `about:vimma` shows no Omarchy rows                | Nothing                                             |
| Omarchy hook            | `vimma/omarchy/OmarchyHook.sys.mjs:108-109, 134-140`                                                                | Runs only where Omarchy was found; otherwise returns `"no-omarchy"` without looking                                                                                                                              | Nothing                                             |
| Hyprland private swap   | `vimma/host/private-swap.mjs:138-141` (gate), `vimma/host/hypr/HyprIpc.sys.mjs:104-110`                             | `isWayland` is false, so the gate answers "not on Wayland" (or "headless" under `MOZ_HEADLESS`); the private workspace opens as its own window, with nothing logged (158)                                        | A test that the gate holds on macOS                 |
| Private window position | `vimma/host/private-ops.mjs:155-156`                                                                                | Not Wayland, so `screenX` and `screenY` are passed and the window opens over the normal one                                                                                                                      | Nothing                                             |
| Wake lock               | `vimma/services/WakeLock.sys.mjs:27-33`                                                                             | Returns unless the platform is `linux`; macOS uses Firefox's `IOPMAssertion` wake lock (`widget/cocoa/nsAppShell.mm:74-80`)                                                                                      | Nothing                                             |
| `config.toml` path      | `vimma/config/ConfigHost.sys.mjs:5-6, 57`                                                                           | `$XDG_CONFIG_HOME/vimma/config.toml`, else `~/.config/vimma/config.toml`; works as is                                                                                                                            | Nothing (decision 18)                               |
| Profile directory       | Firefox: `toolkit/xre/nsXREDirProvider.cpp:1122-1134` (Application Support), 1591-1594 (vendor ignored)             | Profiles live in `~/Library/Application Support/Vimma/`, beside `profiles.ini`                                                                                                                                   | `vimma-ctl` must look there                         |
| vimma-ctl discovery     | `tools/vimma-ctl/src/discovery.rs:58-73`                                                                            | Looks only in `$XDG_CONFIG_HOME/vimma/vimma` (default `~/.config/vimma/vimma`) and `~/.vimma/vimma`: **cannot find the profile** without `--profile` or `VIMMA_PROFILE`                                          | The macOS root (decision 19)                        |
| vimma-ctl stale check   | `discovery.rs:209-229`                                                                                              | `/proc/<pid>` on Linux only; elsewhere every discovery file counts as live. The handshake still protects the token (211-213)                                                                                     | `ps -p <pid>` on macOS (decision 20)                |
| Control socket          | `vimma/ctl/VimmaControl.sys.mjs:8, 815-817`                                                                         | TCP on 127.0.0.1 with a discovery file in the profile: portable                                                                                                                                                  | Nothing                                             |
| vimma-ctl in CI         | `.github/workflows/ci.yml:110-130`                                                                                  | Built and tested on `ubuntu-latest` only                                                                                                                                                                         | A macOS cargo job                                   |
| Agent attention         | `vimma/host/agent-ui.mjs:180-188` (vimma-mcp)                                                                       | `getAttention()` bounces the Dock icon (`widget/cocoa/nsCocoaWindow.mm:7338-7341`); `nsIAlertsService` posts through `widget/cocoa/MacOSNotificationCenter.mm`. Whether an ad hoc app may post is **unverified** | A hand check                                        |
| `vimma-ctl mcp` caller  | `tools/vimma-ctl/src/mcp_serve.rs:508-519` (`parent_name`): `/proc/<ppid>/comm` on Linux only                       | No `/proc` on macOS; the caller gets no name label                                                                                                                                                               | The macOS process name (decision 21)                |
| Keys: accel             | `vimma/host/firefox-keys.mjs:60-62`; `xulKeyChord`, `planFirefoxKeys` in `packages/vimma-core/src/firefox-keys.mjs` | `accel` is meta; `disable = "all"` keeps `cmd+q`                                                                                                                                                                 | The macOS key inventory (decision 22)               |
| Keys: Option characters | `packages/vimma-core/src/keys.mjs:376-406`; `widget/cocoa/nsCocoaUtils.mm:725-731` (Option sets AltGraph)           | Option+shift+8 is `{` and matches a `{` binding (key-handling-batch). Option+j types `∆`, so an `alt+j` binding never fires                                                                                      | Open question 4                                     |
| Keys: text bindings     | `packages/vimma-core/src/editable.mjs:119-121`; `vimma/host/VimmaHost.sys.mjs:144, 1691-1696`                       | On macOS Vimma leaves `ctrl+h` to Cocoa, which already deletes backward (`widget/cocoa/NativeKeyBindings.mm:87`)                                                                                                 | Nothing                                             |
| Keys: native menu bar   | `widget/cocoa/nsMenuItemX.mm:316-357`                                                                               | Each menu item takes its key equivalent from its `<key>` element. Whether turning a `<key>` off (firefox-keys) also clears the menu's equivalent is **unverified**                                               | A hand check; the macOS key inventory               |
| Dev tools               | `tools/start.mjs:40` (Linux objdir), 197 (`/proc/locks`); `tools/mochitest.mjs:53` (`dist/bin/…`)                   | Wrong paths on a Mac                                                                                                                                                                                             | Platform paths                                      |
| Artifact builds         | `tools/artifact-build/artifact-build.mjs:143` (`…firefox.linux64-opt`), 255 (`dist/bin` launcher symlink)           | mach supports a Mac host (research above)                                                                                                                                                                        | The macOS namespace and the `.app` layout           |
| e2e harness             | `tools/e2e/launcher.mjs:29, 161-182` (Linux paths), 269-387 (Xvfb); `tools/e2e/e2e.mjs:139`                         | Starts Xvfb whenever `DISPLAY` is unset, which is always on a Mac; screenshots come from Xvfb's framebuffer (`screenshot.mjs`, `xwd.mjs`)                                                                        | `MOZ_HEADLESS=1`, the `.app` binary, no screenshots |
| Packaging               | `tools/package/` (tarball, AppImage, `.deb`, AUR)                                                                   | Linux only                                                                                                                                                                                                       | The `.dmg` from `mach package`                      |

## Design

### Platforms

1. **Windows is not a target platform.** Vimma's audience is keyboard-first developers on Linux
   and macOS; a Windows build would add a third toolchain, signing scheme and key model for few of
   them. `docs/limits.md` and the roadmap in `plan.md` §6 say "not planned".
2. **Linux first, macOS next.** Linux x86_64 stays the platform every feature is built and
   gated on. macOS is the second platform and gets this spec's CI; features may be Linux-only
   (decision 11), never Mac-only.
3. **arm64 only, until open question 1 says otherwise.** Every Mac sold since 2023 is Apple
   Silicon, GitHub's Intel macOS images end in 2027, and one architecture halves the build. The
   cross build sets `--target=aarch64-apple-darwin`, so the deployment target is 11.0.

### Where the build runs

4. **No self-hosted build machine.** None is registered, none is planned, and on a public
   repository a self-hosted runner reachable from pull requests is a machine anyone can run code
   on (build-supply-chain R7 and decision 7). The macOS build must not name a
   self-hosted runner. Rejected: the earlier plan to build on a `vimma-build` runner beside the
   Linux nightly, because that runner does not exist and build-supply-chain removes it from both workflows.
5. **Cross-compile on a GitHub-hosted Linux runner; never build on a hosted Mac.** This is what
   Mozilla and Zen do. `configs/macos/mozconfig` gains `--target=aarch64-apple-darwin`; the SDK,
   clang (lld) and the DMG tools come through `--enable-bootstrap` and `bootstrap_toolchain`, and
   sub-PR 3 adds an explicit `mach artifact toolchain` fetch of cctools, libdmg and hfsplus only if
   bootstrap proves insufficient. The file stays usable on a Mac host for a contributor who builds
   natively. The runner type follows build-supply-chain decision 6 (open question 6 confirms it for macOS):
   - The standard `ubuntu-24.04` runner first: free, 16 GB RAM, and about 85 GB free disk
     measured against the 30 GB a build needs. A disk guard fails the job before the download when
     less than 40 GB is free (build-supply-chain decision 9). Freeing disk (`jlumbroso/free-disk-space`, as Zen
     does) is the fallback if the image shrinks; it is not needed today.
   - A cold cross build on 4 CPUs is estimated at 1.5 to 3 hours (from build-supply-chain's estimate of at least
     116 minutes for a Linux build on 4 CPUs, and Zen's 28-53 minutes on 8 vCPU); sub-PR 3
     measured 133 minutes for the whole job, 44 GB of disk with the swap file. If it exceeds build-supply-chain's 4-hour threshold, the macOS build follows the
     Linux release to a larger hosted Linux runner, which needs an organisation on the GitHub Team
     plan (paid, about $0.042 per minute for 16 cores).
   - Rejected: building on a hosted Mac. The documented 14 GB SSD is under half of what a build
     needs, on the free runner and on the paid `xlarge` alike, and the free arm64 Mac has 3 cores
     and 7 GB RAM.
   - Rejected: a third-party runner service (Zen's Blacksmith). It adds a party that runs the
     build, outside build-supply-chain's trust boundary (build-supply-chain decision 6).
6. **The macOS build follows the build-supply-chain rules.** It verifies the Firefox source against
   Mozilla's signed `SHA512SUMS` and extracts it afresh, restores nothing from the Actions cache
   and uses no shared compiler cache, so every build is cold (build-supply-chain decisions 1-5 and 8). Sub-PR 3 reuses that spec's
   source-verification step once it is implemented, rather than adding a second one.

### Testing on Macs without building on them

7. **No upstream patch for signing.** Instead of patching `conditions.is_firefox` out of
   `mach macos-sign` (Zen's approach), `tools/package/macos-dmg.sh` unpacks the `.dmg` from
   `mach package` with mach's `unpack_dmg`, runs `rcodesign sign` on the app (ad hoc now, a p12
   later) and packs it again with `make_dmg`. rcodesign 0.29.0 is a pinned download
   (`tools/package/fetch-rcodesign.sh`, MPL-2.0). Vimma's own production entitlements come with
   the Developer ID (decisions 23 to 28).
8. **Hosted Macs run what was built.** A `macos-15` job downloads the `.dmg` artifact, mounts it,
   verifies the signature, launches Vimma headless and runs a smoke e2e through `vimma-ctl`. It is
   free on a public repository.
9. **Front-end tests on a Mac without a Firefox build.** `tools/artifact-build` learns the macOS
   namespace (`gecko.v2.mozilla-release.shippable.revision.<rev>.firefox.macosx64-aarch64-opt`,
   confirmed in sub-PR 1) and the `.app` layout, so a `macos-15` runner gets Mozilla's build of
   the same release with Vimma's chrome on top, as ADR-010 does on Linux. That runs Vitest and the
   mochitests (headless) on a real Mac on every pull request, with no Apple account.

### Signing, publishing and updates

10. **Test builds are ad hoc signed.** Every `macos.yml` build, and a release while
    `MACOS_SIGNING` is not `developer-id` (decision 26), is ad hoc signed with no entitlements and
    no hardened runtime, so that a fork or a pull request builds and runs with no Apple
    credential. Entitlements take effect only under the hardened runtime, and an ad hoc app on
    Apple Silicon starts without it: checked in sub-PR 3, where the ad hoc app passes
    `codesign --verify --deep --strict` and renders pages with its content processes. Rejected:
    the `developer` entitlements, which would only matter under a hardened runtime this build does
    not use. `docs/guide.md` tells testers of such a build about Open Anyway and `xattr`.
11. **Linux-only features stay Linux-only and fail quietly.** Omarchy theming, the Omarchy hook and
    the Hyprland private swap are inactive on macOS, as the table above shows, without warnings.
    No Omarchy wording appears where Omarchy is absent (theme-appearance), so `about:vimma` adds no
    "Omarchy theme: not found" line; this supersedes the earlier idea of one.
12. **Release gate: a variable, opened before the Developer ID.** `release.yml` has four macOS
    jobs (`macos-build`, `macos-smoke`, `macos-sign`, `macos-publish`) that run only when the
    repository variable `MACOS_RELEASE_ENABLED` is `true`, on top of the Linux release's own
    conditions. They need no manual step, because a Firefox security release ships without a
    person (firefox-versions; ADR-020, planned with its sub-PR 4). The gate could open with ad hoc
    builds, before the Developer ID (decision 26): a tester who presses Open Anyway once gets
    every release from the same page as Linux users, checksummed and signed with the same
    Sigstore identity, instead of a 90-day workflow artifact found through a run's page.
    Rejected: waiting for notarisation, which costs 99 USD a year before anyone outside has run
    the build. The `.dmg` has its own checksum file, `SHA256SUMS-macos`, so `SHA256SUMS`, which the
    AUR package and the updater read, stays exactly the Linux files. The macOS build ends hours
    after the Linux one, usually after the maintainer has published the draft, so `macos-publish`
    adds its files to a published release when it has none yet, and replaces them only with
    `replace_published`, as `publish` does.
13. **macOS never blocks a Linux release.** `macos.yml` is its own workflow, not a step of
    `nightly.yml`, `release.yml` or the Firefox bump, and no Linux job in `release.yml` needs a
    macOS job, so a macOS-only breakage cannot hold back a Linux security release; it opens the
    same failure issue. It runs weekly, on `workflow_dispatch`, and on pull requests that touch
    `configs/macos/` or the workflow itself. A Firefox bump that breaks macOS (for example a new
    SDK minimum) shows within a week.
14. **Test builds are keyless.** `macos.yml` builds without the Safe Browsing key, so Safe
    Browsing is off by default in those builds (`configs/common/mozconfig:46-59`). The key stays in
    as few jobs as possible. `release.yml`'s `macos-build` uses the key as `build` does, from the
    `build` environment (docs/security.md, B6), so released `.dmg` files have Safe Browsing on.
15. **Artifact names carry both versions.** `mach package` names the file
    `vimma-<firefox>.en-US.mac.dmg`; the workflow uploads it as
    `vimma-<vimma>-firefox-<firefox>-macos-aarch64`, matching the version line of
    firefox-versions.
16. **Updater (M6a) on macOS: later, and only for signed builds.** Firefox's macOS updater uses the
    same `update.xml` and MAR format, and Surfer already names the platform `Darwin_aarch64-gcc3`
    and the MAR `macos.mar`. An update rewrites files inside the signed bundle, so updating an ad
    hoc app would break its signature (**unverified**, to confirm in M6a). Unsigned macOS builds
    therefore get no updater: testers reinstall the `.dmg`. The updater spec (PR #143, pending)
    lists macOS manifests as out of scope and decides the rest.
17. **Branding.** Superseded by spec [macos-homebrew](macos-homebrew.md), decisions 12 to 14:
    `configs/branding/vimma/` holds the compiled `Assets.car`, `firefox.icns` and
    `document.icns`, generated from `logo-mac.png` by `tools/package/macos-icons.mjs`, because
    macOS reads the icon from `Assets.car` and the Linux cross build cannot compile it. The DMG
    window art is decision 14 there.

### Files and processes on macOS

18. **`config.toml` stays in `~/.config/vimma/` on macOS.** Vimma reads
    `$XDG_CONFIG_HOME/vimma/config.toml`, else `~/.config/vimma/config.toml`, on macOS as on
    Linux (`vimma/config/ConfigHost.sys.mjs`). This follows the existing behaviour, so a Mac
    user's file stays where it is, and it is where developers keep their Neovim, tmux, Ghostty
    and Alacritty configs on a Mac, so one dotfiles repository works on both platforms.
    Rejected: `~/Library/Application Support/Vimma/config.toml`, the Apple convention beside the
    profile, because it is hidden from most dotfiles setups and would move every existing file.
    The profile stays where Firefox puts it (decision 19).
19. **`vimma-ctl` looks for the profile where Firefox puts it.** On macOS, Firefox keeps
    `profiles.ini` and the profiles in `~/Library/Application Support/Vimma/`: the app's name
    under Application Support, with the vendor ignored (`toolkit/xre/nsXREDirProvider.cpp:1122-1134,
1591-1594`). It reads `XDG_CONFIG_HOME` and the legacy dot directory only on GTK
    (`nsXREDirProvider.cpp:1311-1560`, inside `MOZ_WIDGET_GTK`). So `vimma-ctl` on macOS uses
    that folder and ignores both, since following them would send a Mac user who sets
    `XDG_CONFIG_HOME` for other tools to a folder with no profiles. Linux is unchanged. Rejected:
    honouring `XDG_CONFIG_HOME` for the profile on macOS as `config.toml` does, because Firefox
    does not.
20. **The stale check asks `ps` on macOS.** `vimma-ctl` forbids `unsafe` and has no
    dependencies (ADR-011), so it cannot call `kill(2)` itself. On macOS it runs
    `/bin/ps -o pid= -p <pid>`, which, like `/proc/<pid>` on Linux, finds a running process
    whoever owns it; pid 0 and pids past `i32::MAX` count as exited. When `/bin/ps` cannot run,
    the file counts as live and the handshake decides, as before. Linux keeps `/proc`, because it
    needs no child process. Rejected: `/bin/kill -0`, because it fails for another user's process
    as for an exited one, and only its localised message tells them apart.
21. **The MCP caller's name on macOS comes from `ps`.** `vimma-ctl mcp` sends its parent
    process's name as a label for Vimma's question (vimma-mcp). With no `/proc` on macOS, it runs
    `/bin/ps -o comm= -p <ppid>`, which prints the executable's path, and keeps the last component,
    cleaned to 32 printable characters as on Linux. The label is never proof of anything
    (vimma-mcp decision 4). Rejected: `proc_name` from libproc, because it needs `unsafe` FFI.

### Keys on macOS

22. **A macOS inventory derived from the Linux one.** `FIREFOX_SHORTCUTS_MACOS`
    (`packages/vimma-core/src/firefox-keys.mjs`) is the Linux inventory with each row's macOS
    chord (`MAC_CHANGES`, by `<key>` id), without the keys macOS lacks (`focusURLBar2`,
    `key_reload_skip_cache2`, `ctrl+F4`, F10 and the menu bar's access keys, since
    `ui.key.menuAccessKey` is 0 there), and with macOS's own keys (`MAC_ONLY`). The host reads it
    on a Mac for what `disable = "all"` turns off and which out-of-keyset tab keys it stops; the
    keymap, the page-first rule and `bindings.md` stay on the Linux table, because Vimma's keymap
    is the same on both platforms until the macOS keymap (issues #385, #386) changes it. A row
    whose key moves to a chord Vimma does not bind is fate c there (unbound, its `<key>` off):
    `cmd+t`, `cmd+l`, `cmd+1..9`, the DevTools' `cmd+alt+<key>` and ShortcutUtils' `meta+{`,
    `meta+}` (also with `ctrl`, which `ShortcutUtils.getSystemActionForEvent` ignores) and
    `alt+meta+<arrow>` tab keys (Firefox 158, `toolkit/modules/ShortcutUtils.sys.mjs:380-445`).
    `key_quitApplication` is `cmd+q` and `internal` on macOS
    (`browser/base/content/browser-sets.inc.xhtml`, the `XP_MACOSX` branch), so it is fate d:
    `"all"` keeps it, as behaviour 4 says. A `<key>` that is off may still run from the native
    menu bar in a windowed build: `nsMenuItemX::SetKeyEquiv`
    (`widget/cocoa/nsMenuItemX.mm:313-360`) copies the chord of a menu item's `<key>` without
    reading its `disabled`, the item's enabled state follows its command (`SetEnabled`,
    `nsMenuItemX.mm:427-447`), and a keydown nothing in Gecko consumed goes to the menu bar's
    key equivalents (`dom/events/EventStateManager.cpp:4024`,
    `nsCocoaWindow::PostHandleKeyEvent` and `SendEventToNativeMenuSystem`,
    `widget/cocoa/nsCocoaWindow.mm:626-672`). The engine source reads so; it is not yet
    confirmed in a running windowed build, which headless tests cannot show, and is part of
    sub-PR 5's hand check of the native menu bar. Rejected: a macOS chord column in every row,
    because the keymap, `pageFirst` and the docs would each have to pick a column while only
    the host and the coverage test differ by platform; and a hand-written second table, because
    its 149 rows would be kept in step with Linux's 140 by hand, where 77 rows change their
    chord, 12 go and 21 are macOS's own.

### Developer ID and notarisation

23. **Three jobs between `macos-build` and `macos-smoke`: `macos-unpack`, `macos-notarise` and
    `macos-pack`, each on its own runner.** `macos-unpack` opens the ad hoc `.dmg` that
    `macos-build` made and checksummed and uploads the volume as a tar file, which keeps the app's
    links and modes. `macos-notarise`, in the `macos-sign` environment, unpacks that tar, signs the
    app with the Developer ID, notarises and staples it, and uploads the signed app.
    `macos-pack` puts the signed app back beside the window art, packs a new `.dmg`, renders the
    cask without its Open Anyway caveat, rewrites `SHA256SUMS-macos` and replaces the `macos`
    artifact. A GitHub job has one environment, and `macos-build` is in `build` for the Safe
    Browsing key (decision 14), so the Apple secrets need another job. They need a runner of their
    own besides, because the disk-image tools come from `macos-build` unpinned (decision 28) and
    parse an untrusted image: a replaced tool, or a process it leaves behind, could wait for the
    key on a runner it shares with the secrets, and reordering steps within one job would not stop
    that. So the tools run only in `macos-unpack` and `macos-pack`, which hold no secret, and
    `macos-notarise` runs no binary from an artifact: only rcodesign, fetched and checked against
    its pinned SHA-256, through `tools/package/macos-sign-app.sh`, which calls rcodesign and
    standard system tools. The job must equal a golden copy kept beside its test, apart from the
    commits its actions are pinned to, because a check that parses its shell to allowlist
    commands can always be bypassed (backticks, `&`, process substitution, tar's own exec
    options, a step's `shell:` or `env:`). Before any credential exists, it compares the hash of
    the unpacked app's manifest (`tools/package/macos-app-manifest.sh`: each path, type,
    executable bit and SHA-256, with coreutils only) with `macos-build`'s job output
    `manifest_sha256`, the hash of the manifest of the app `macos-dmg.sh` signed ad hoc there.
    The hash travels as a job output, not an artifact, because any job of the run can replace an
    artifact and no job can change another's outputs. It guards against `macos-unpack`, not a
    compromised build, nor a tool already malicious in `macos-build`, whose `unpack_dmg` runs
    before the manifest is written and which could set the output itself. The job runs every
    step under `shell: bash` (`-eo pipefail`), the manifest script checks every name before it
    prints anything, and the step hashes its output only when it succeeded, because a manifest
    cut off partway could equal the real one while a subtree stays hidden. Vimma.app has no
    symlink (an installed Vimma.app on Firefox 158.0.1, inspected with `find -type l`, has none; its frameworks are
    flat), so the manifest and the sign script refuse any symlink, which a chain of links could
    otherwise use to lead rcodesign outside the bundle; the sign script also refuses a name
    rcodesign's `<path>:<value>` scopes could misread and an `Info.plist` whose
    `CFBundleExecutable` is not one plain file name. The three jobs come
    before `macos-smoke` so that the hosted Mac checks the signed `.dmg` that is published.
    `tools/package/macos-developer-id-check.sh` there runs `codesign --verify --deep --strict`,
    reads `codesign -dvv` for the Developer ID Application authority, the team ID of the
    repository variable `MACOS_TEAM_ID` on the app and its nested code, a secure timestamp and the
    `runtime` flag, and requires `spctl --assess --type execute -vv` to answer
    `source=Notarized Developer ID` and `xcrun stapler validate` to pass. The team is compared
    because Gatekeeper accepts any team's notarised app; it is a variable, not a secret, since
    every signature shows it. Rejected: signing in `macos-build`, which would put the p12 in the
    `build` environment beside a two-hour build; one job that unpacks, signs and packs, which runs
    the handed-over tools on the runner that holds the key; signing in the cosign job `macos-sign`,
    which runs after the smoke check, so the Mac would never see the Developer ID signature, and
    which runs no repository code by design; signing on a hosted Mac with `codesign` and a
    temporary keychain, because rcodesign signs on Linux from a p12 file with no keychain, as
    Mozilla does.
24. **Vimma's production entitlements are Firefox's, without the two restricted ones.**
    `configs/macos/entitlements/` holds `browser.xml` (Firefox 158.0's
    `production/firefox.browser.xml`), `plugin-container.xml` and `media-plugin-helper.xml`
    (Firefox's files unchanged), so that Vimma's content processes JIT, the CDM helper loads its
    library and the browser keeps camera, microphone, location, USB, smart card and PKCS #11
    access under the hardened runtime exactly as Firefox does. `browser.xml` leaves out
    `com.apple.application-identifier` and `com.apple.developer.web-browser.public-key-credential`,
    because those need Apple's approval for the team and a provisioning profile in the bundle,
    which mach calls `production-without-restricted` (Research); so the files name no team and no
    bundle identifier, and the team ID is used to check the certificate (decision 27). Platform
    passkeys do not work until both are added
    ([#544](https://github.com/vimma-browser/vimma/issues/544)). The files are compared with
    Firefox's on a Firefox bump, as `docs/runbook.md` says. Rejected: Firefox's file with the
    team ID swapped in, because without a provisioning profile the app would not start.
25. **One `rcodesign sign` with mach's per-path settings, then the app is notarised, stapled and
    packed.** `tools/package/macos-sign-app.sh` signs as `mach macos-sign -r` does for the
    release channel: one run on the app, which rcodesign signs inside-out, with the runtime flag
    scoped to each helper app, binary and dylib in Mozilla's production list that is present, the
    two helper apps' entitlement files scoped to them, `vimma-ctl` added to the list, and
    `browser.xml` and the runtime flag on the app. It adds `--for-notarization`, so rcodesign
    refuses a certificate that is not Developer ID or a signature without Apple's timestamp, and
    turns the runtime on for any Mach-O the list misses, since notarisation rejects such a binary.
    `rcodesign notary-submit --wait --staple` then notarises the `.app` and staples its ticket into
    `Contents/CodeResources`, and only then is the `.dmg` packed, as Mozilla does (Research), so
    the installed app carries its ticket and Gatekeeper accepts it offline. The `.dmg` itself is
    not signed, as Firefox's is not. The disk image is unpacked and packed with Mozilla's own tools
    as `mozpack/dmg.py` calls them on Linux (`tools/package/macos-dmg-unpack.sh`,
    `macos-dmg-pack.sh`), and the pack refuses an app without a stapled ticket. Rejected: notarising the `.dmg` alone, which leaves
    the app in `/Applications` without a stapled ticket, so a first start offline fails; and
    `codesign`-style separate runs per path, which rcodesign does not need.
26. **`MACOS_SIGNING=developer-id` turns Developer ID on, and then a missing secret fails the
    release.** Vimma is enrolled in the Apple Developer Program (99 USD a year), because
    Gatekeeper refuses an ad hoc app's first open and Homebrew disables casks that fail
    Gatekeeper (Research), so a public Mac download needs notarisation. The repository variable,
    not the presence of the secrets, decides, so that a
    deleted, renamed or unreadable secret, or an environment that a misconfiguration hides from
    the job, stops the release with an error instead of publishing an ad hoc `.dmg` to users who
    installed a notarised one, which Gatekeeper would refuse and the Homebrew cask would install
    without its caveat. While the variable is unset, `macos-build`'s ad hoc `.dmg` is released as
    before, and the run's summary and a warning say it is ad hoc signed and not notarised.
    `macos.yml`, forks and pull requests never sign with the Developer ID. Rejected: signing
    whenever the secrets are present, because the absence of a secret is silent; and requiring the
    secrets for every release, because a release must still be possible while the certificate is
    being set up or replaced, as an ad hoc one that says so.
27. **The `macos-sign` environment, `main` only, with no required reviewer.** It holds
    `APPLE_DEVELOPER_ID_P12` (base64), `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_NOTARY_API_KEY`
    (the JSON of `rcodesign encode-app-store-connect-api-key`) and `APPLE_TEAM_ID`; only `main`
    may deploy to it, as `build` and `homebrew` (docs/security.md, B14), so no branch or tag can
    read the secrets by editing a workflow. No reviewer is required, because a Firefox security
    release ships without a person (decision 12). The job writes the p12, its password and the key
    with the shell's `printf` to files of mode 600 under `$RUNNER_TEMP`, passes only their paths
    to rcodesign, and deletes them in an `always()` step before anything is uploaded. Before signing it checks that the certificate's subject is a Developer ID
    Application and its team ID is `APPLE_TEAM_ID`, so a certificate from another team, or an
    Apple Development certificate, never signs a release. Rejected: a required reviewer, which
    would hold every security release for a person.
28. **The disk-image tools come from `macos-build`, and never reach the secrets.** `macos-unpack`
    and `macos-pack` have no `engine/` and no `mach`, so `macos-build` copies the `dmg`, `hfsplus` and `newfs_hfs` that its `mach`
    bootstrapped from Mozilla's Taskcluster, found as `make_dmg.py` finds them, into a one-day
    artifact, only for a Developer ID release. They run on the same runner image they were built
    for, and only on runners without the Apple secrets (decision 23). A replaced tool in
    `macos-unpack` is caught by the manifest; one in `macos-pack` could pack another app, which
    `macos-smoke`'s signature checks then fail, or add entries to the unsigned `.dmg`, which no
    check covers yet (docs/security.md, B14). Rejected: downloading
    the Firefox source again for `mach`, which adds gigabytes and minutes for three small binaries,
    and pinning the tools by hash, because they are rebuilt with Mozilla's toolchain tasks and the
    pin would change with Firefox releases (not measured).

### Not in this spec

A vimma.dev download (decision 12); platform passkeys (decision 24); the Homebrew cask and tap
([macos-homebrew](macos-homebrew.md)); x86_64 and
universal builds (decision 3); PGO and LTO tuning; the macOS updater beyond decision 16; Mac App
Store distribution; the Firefox Beta canary on macOS (upstream-beta-canary tests Linux only);
Mac-native integrations such as Handoff, the Services menu or a global hotkey.

## Security and privacy

- **Build trust.** The macOS build runs on a GitHub-hosted runner under the same rules as the
  Linux builds in build-supply-chain: verified Firefox source, no restored caches, toolchains from Mozilla's
  Taskcluster through `mach` as trusted inputs. No self-hosted runner exists for pull request
  code to reach.
- **Secrets.** `macos.yml` needs none: no Safe Browsing key (decision 14), no Apple credentials.
  The Developer ID p12, its password, the App Store Connect API key and the team ID are secrets of
  the `macos-sign` environment, which only `main` may deploy from, read by `macos-notarise` alone,
  which runs no binary of the build, and written to owner-only files that an `always()` step
  deletes (decisions 23 and 27). With rcodesign
  the p12 never enters a keychain. A leaked p12 lets its holder sign software that Gatekeeper
  accepts as Vimma's team until Apple revokes the certificate; a leaked API key lets its holder
  notarise under the team until it is revoked in App Store Connect. `docs/security.md`, B14, and
  `docs/runbook.md` describe the response.
- **Ad hoc builds.** An ad hoc signature proves nothing about who built the app. Testers get the
  `.dmg` from this repository's GitHub Release, and check it with cosign against the same identity
  as the Linux files, `release.yml` at `refs/heads/main`; the guide says how. Open Anyway lowers Gatekeeper for that one app only.
- **Entitlements.** Ad hoc builds carry none and run without the hardened runtime (decision
  10), so they get none of its protections against injected libraries and unsigned code. The
  Developer ID build turns the hardened runtime on with Vimma's own production entitlements, which
  keep Firefox's exceptions: JIT, and library validation off for PKCS #11 modules and the CDM
  (decision 24).
- **Privacy.** No new data leaves the machine. Keyless test builds have Safe Browsing off by
  default, which the guide's macOS section states.

## Tests

Gate for calling a macOS build working: unit tests, a build that launches, and a smoke e2e, all on
a hosted Mac, plus the hand checks.

**Vitest (`vimma-core`), on `macos-15` (sub-PR 1):** the whole suite, unchanged. Core is pure, so
any failure is a test that assumes Linux.

**cargo test (`tools/vimma-ctl`), on Linux and macOS (sub-PR 2):**

- `profiles_root_finds_application_support_vimma_on_macos`
- `xdg_config_home_does_not_move_the_macos_profile_root`
- `finds_the_default_profile_through_profiles_ini` (`tests/cli.rs`, the host's own layout)
- `a_discovery_file_whose_pid_has_exited_is_stale_on_every_unix`
- `ps_tells_a_running_pid_from_an_exited_one`
- `parent_name_names_the_parent_process`, `name_from_ps_keeps_the_executable_name`

**Mochitests, headless, artifact build, on `macos-15` (sub-PRs 1 and 2):**

- the existing suite; each failure is fixed, or marked `skip-if` for macOS in
  `tests/browser/browser.toml` with an issue, never loosened
- `browser_vimma_private_swap.js`: `the swap gate answers not on wayland on macos`
- `browser_vimma_theme_appearance.js`: the existing "no poll timer runs" detection test, run on
  macOS unchanged
- `browser_vimma_firefox_keys.js`: `accel is cmd and disable all keeps cmd+q on macos`

**Build and smoke, on `macos-15` (sub-PRs 3 and 4):**

- `the dmg mounts and codesign --verify --deep passes`
- `vimma --version prints the vimma and firefox versions`
- `vimma starts headless with the control socket and vimma-ctl version answers`
- e2e `m0-happy-path` and `m0-content-actor` under `MOZ_HEADLESS=1`; no screenshot baselines on
  macOS

**Developer ID (sub-PR 7):** vitest in `tools/package/test/macos-developer-id.test.mjs`, with stub
`rcodesign` and disk-image tools:

- `the browser gets Firefox's production entitlements without the restricted pair`
- `macos-dmg-unpack.sh`: `unpacks the dmg with the disk-image tools, as mach's unpack_dmg does on
Linux`
- `macos-sign-app.sh`: `checks the certificate is a Developer ID Application of APPLE_TEAM_ID
before signing`, `signs in one rcodesign run, nested code inside-out with mach macos-sign's
settings`, `notarises and staples the app after signing it`, `passes the password and the API
key as files, never on a command line`, `refuses a symlink that leaves the app, before rcodesign
runs`, `runs rcodesign and no disk-image tool, mach, node or other program of the build`
- `macos-dmg-pack.sh`: `packs the volume as mach's make_dmg does on Linux`, `refuses an app
without a stapled ticket, so an unsigned app is never packed`
- `macos-developer-id-check.sh`: `passes a Developer ID app under the hardened runtime, notarised,
stapled and accepted`, and fails an ad hoc signature, no hardened runtime, no secure timestamp, a
  nested binary of another team, another team's notarised app, Gatekeeper's rejection and no
  stapled ticket

and in `tools/package/test/release-workflow.test.mjs`: `the Apple secrets come from the macos-sign
environment, in macos-notarise alone`, `the macos-sign job runs no binary of the build: only the
pinned rcodesign`, `writes the credentials to owner-only files and fails when one is missing`,
`removes the credentials in an always() step before anything is uploaded`, `macos-smoke takes the
ad hoc dmg only when Developer ID is off` and `macos-smoke checks the Developer ID of Vimma's team,
notarisation and Gatekeeper`. The real signature, notarisation and Gatekeeper's verdict are checked
by the first signed release's `macos-smoke`.

**Hand checks on a real Mac (open question 3):** Open Anyway on the current macOS; `ctrl+b` and
every `ctrl+b` key; Option-composed `{` `}` `[` `]` `@` `|` `~` on a Finnish layout; `cmd+q`,
`cmd+w`, `cmd+t`, `cmd+l` with `[firefox] disable = "all"` and with the defaults; the native menu
bar's key equivalents after firefox-keys turns keys off; fullscreen and split panes; system dark
and light switching the built-in palette live; `vimma-ctl` with no flags; the agent workspace's
Dock bounce and notification.

## Docs and changelog

With this spec: `docs/limits.md` "Platforms and packaging" says macOS comes later, links this spec
and says Windows is not planned; the roadmap in `plan.md` §6 says the same.

With the sub-PRs:

- `docs/guide.md` "Getting started": a macOS section (where the `.dmg` comes from, Open Anyway,
  `xattr`, Apple Silicon only, unsigned so no passkeys, Safe Browsing off in test builds);
  "Keys": Option and alt on a Mac, `cmd` as accel; "config.toml": the macOS path; "Scripting with
  vimma-ctl": the profile location.
- `docs/limits.md`: macOS limits (unsigned, no updater, no Omarchy, no Hyprland swap, no Intel
  build); the `.icns` line under "Branding" goes with sub-PR 3.
- README "Status": "Linux x86_64; macOS arm64 in CI" once sub-PR 4 is green.
- `CONTRIBUTING.md`: building on a Mac (Xcode or the command line tools, `brew install gnu-tar`,
  30 GB disk) and the cross build.
- `docs/runbook.md`: `macos.yml`, its measured time and disk; with sub-PR 7, setting up and
  rotating the certificate and the API key, the `macos-sign` environment, and re-running signing.
- `docs/security.md`, B14 with sub-PR 7: the Apple secrets, their environment, and a leaked p12 or
  API key.
- ADR-018 with sub-PR 3.
- `CHANGELOG.md` `[Unreleased]`: one line per sub-PR that changes what a user can run (sub-PRs 2,
  3, 6 and 7); CI-only sub-PRs need none.

## Delivery

Each sub-PR is independently mergeable and tested. Sub-PRs 1 and 2 need no Mac, no money and no
full build.

1. **`ci(macos): front-end tests on a mac runner`.** `artifact-build.mjs` picks the namespace and
   `.app` layout by platform; `mochitest.mjs` and `start.mjs` learn the macOS paths and skip
   `/proc/locks` on macOS. A new `macos-15` job in `e2e.yml`: `npm ci`, Vitest, artifact build,
   the mochitests headless, and a `df` line recording the free disk. Not required at first (open
   question 5).
2. **`fix(macos): platform fallbacks`.** vimma-ctl's macOS profile root and `kill(pid, 0)` stale
   check, with tests (decisions 19 and 20); the MCP caller's name (decision 21); a macOS cargo
   job in `ci.yml`, informational like sub-PR 1's; the config path stays (decision 18). The
   swap-gate and keys mochitests on macOS run in sub-PR 1's Mac job, so they follow it.
3. **`build(macos): an arm64 cross build`.** ADR-018. `configs/macos/mozconfig` for the cross
   build; `macos.yml` on `ubuntu-24.04` (decision 5) with build-supply-chain's source verification and disk
   guard; `npm run import`, `surfer build`, `./mach package`, ad hoc `rcodesign` (decision 10),
   upload as an artifact. Measures the cold build time and sets `timeout-minutes`. It also
   carries the first `macos-15` smoke job (mount, `codesign --verify --deep --strict`, arm64,
   `vimma --version`, a page rendered headless), so no `.dmg` is uploaded untested. The branding
   `.icns` and DMG background (decision 17) follow separately (issue #393). After the
   build-supply-chain source-verification sub-PR.
4. **`test(macos): smoke the dmg on a mac`.** The smoke job gains the two smoke scenarios through
   `vimma-ctl`, launched with `MOZ_HEADLESS=1`. The e2e launcher learns `MOZ_HEADLESS` instead of
   Xvfb on macOS, the `.app` binary path and "no screenshots".
5. **`docs(macos): keys inventory`.** The macOS firefox-keys inventory, `FIREFOX_SHORTCUTS_MACOS`
   (decision 22, built with #384), the native menu bar check (whether a `<key>` that is off
   still runs from its menu item in a windowed build), and Option/alt behaviour in
   `docs/guide.md`.
6. **`build(macos): a dmg in every release`.** The four macOS jobs in `release.yml` behind
   `MACOS_RELEASE_ENABLED` (decision 12): the cross build with the Safe Browsing key, the
   `macos-15` smoke check against the tag, cosign, and an add-only upload. The guide's macOS
   install section.
7. **`build(macos): developer id and notarisation`** (built). The `macos-unpack`,
   `macos-notarise` and `macos-pack` jobs behind `MACOS_SIGNING` (decisions 23 to 28): secrets in
   the `macos-sign` environment; `rcodesign
sign` with Vimma's production entitlements; `rcodesign notary-submit --wait --staple` on the
   app; a new `.dmg` and cask; the Developer ID checks in `macos-smoke`. Passkeys follow in #544.

Time and cost per run:

| Item                                              | Time per run                                      | Cost                          |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------------- |
| Sub-PR 1 job (Vitest, artifact build, mochitests) | 20-30 min (estimate; the Linux job's limit is 45) | $0 (public repo)              |
| Sub-PR 2 cargo job on macOS                       | about 3 min                                       | $0                            |
| Sub-PR 3 cold cross build on `ubuntu-24.04`       | 133 min (measured)                                | $0                            |
| Same on a 16-core larger Linux runner (fallback)  | about 40 min (estimate)                           | about $1.70, plus a Team plan |
| Sub-PR 4 smoke on `macos-15`                      | about 10 min                                      | $0                            |
| Sub-PR 7 signing and notarisation                 | about 7 min more (Zen: 29 s and 6.5 min)          | 99 USD a year                 |

## Open questions

1. **arm64 only, or universal?** (a) arm64 only: one build, a smaller download, matches every
   current Mac; Intel Mac owners cannot run it. (b) universal via `unify.py`: covers Intel Macs,
   but doubles the build time and the download and needs a Mac (or a Linux port of the unify
   step) to merge. (c) separate x86_64 `.dmg`: covers Intel without unify, doubles the builds.
   **Recommendation: (a)**, and add x86_64 only if a tester has an Intel Mac, since GitHub's
   Intel images end in 2027.
2. **Change the roadmap order?** (a) macOS entirely after M6: nothing competes with the updater
   and the daily-driver work. (b) sub-PRs 1 and 2 now, as a parallel lane, the rest after M6a:
   they cost nothing, need no full build and find Linux assumptions while the code is fresh.
   (c) all of it now: earliest Mac build, but competes with M6a. **Recommendation: (b)**, so the
   updater's MAR and manifest work is designed with a second platform in view; sub-PR 7 when the
   gate nears.
3. **Is a Mac available for the hand checks?** (a) the maintainer's Apple Silicon Mac: enough.
   (b) none: CI covers launch and smoke, but keys, Gatekeeper and the menu bar need a person, so a
   trusted tester runs the list. (c) a rented cloud Mac: last resort, slow for interactive key
   testing. **Recommendation: (a) if available, else (b)**, before a macOS build is called
   working.
4. **`alt+<letter>` bindings on a Mac.** Option+j types `∆`, so a user's `alt+j` never fires.
   (a) document it: Option is for characters on a Mac, as in Mac terminals by default. (b) an
   "Option as alt" setting matching the physical key: more code and a second matching rule.
   **Recommendation: (a)** now; no default binding uses alt, and (b) can follow if users ask.
5. **Is the macOS front-end job required for merging?** (a) required at once: catches every
   macOS break, but a new and possibly flaky job blocks all pull requests. (b) informational,
   then required once green and not flaky for two weeks, as the Linux e2e job was.
   **Recommendation: (b).**
6. **Which hosted runner runs the cross build?** No self-hosted machine is planned (decision 4).
   (a) the standard `ubuntu-24.04` runner: free, 85 GB measured free disk, 1.5-3 hours estimated,
   within the 6-hour limit. (b) a larger hosted Linux runner: about 40 minutes, but paid and only
   for organisations on the Team plan. (c) a hosted Mac, natively: documented 14 GB disk, too
   small for a 30 GB build even on the paid `xlarge`. **Recommendation: (a)**, as build-supply-chain decides for
   Linux, moving to (b) together with the Linux release only if sub-PR 3 measures more than 4
   hours.
