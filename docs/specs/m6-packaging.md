# Spec: m6-packaging

Status: implemented (tooling); gated off until the secrets and variables are set · Milestone: M6 · Area:
`tools/package/`, `.github/workflows/release.yml`
Prerequisite: release-please (`release-please.yml`) and the self-hosted `vimma-build` runner
(`nightly.yml`), both merged. The updater spec (m0-updater, PR #15) compiles the app updater
out; packages here rely on that (they are updated by apt, pacman or a new AppImage).

Since changed: this spec assumed the `build` job runs on a self-hosted `vimma-build` runner
and that the repository is private. The repository is public, no self-hosted runner is used or
planned, and the `build` job moves to a GitHub-hosted runner with [#224](https://github.com/vimma-browser/vimma/issues/224) (spec
[build-supply-chain](build-supply-chain.md), decisions 6 and 7). Until then the release stays
off; the runner rows below describe the workflow as written, not the target. #224 has since
merged, and the `build` job runs on `ubuntu-24.04`.

Since changed: the `vimma-bin` PKGBUILD is also a release asset that installs Vimma on Arch
Linux without the AUR, writes the desktop file and `vimma-open` inline, and records its install
source; see [Arch Linux without the AUR](#arch-linux-without-the-aur).

Since changed: each release also carries an `.rpm` for Fedora and openSUSE, built and
smoke-tested in the `package` job; see spec [rpm-package](rpm-package.md).

## User story

As a Linux user I install Vimma from a GitHub Release as a tarball, an AppImage or a `.deb`, or
from the AUR as `vimma-bin`, and I can check that what I downloaded is what the release workflow
built (`sha256sum -c`, `cosign verify-blob`). As the maintainer, merging the release PR builds,
packages, signs and publishes all of it without me, once I have enabled it.

## Scope

- `tools/package/package.mjs`: from the `./mach package` tarball, writes the release tarball,
  the AppImage, the `.deb`, the AUR `PKGBUILD` + `.SRCINFO` + `vimma-vimma.desktop`, and
  `SHA256SUMS`.
- `tools/package/sbom.mjs`: a CycloneDX 1.6 JSON SBOM from `surfer.json`, `engine/Cargo.lock`,
  the vendored crates' `Cargo.toml`, every `moz.yaml` in the engine tree and our vendored
  smol-toml; `validate-sbom.mjs` checks it against the official CycloneDX 1.6 JSON schema.
- `tools/package/fetch-appimagetool.sh`: downloads appimagetool and the AppImage runtime, pinned
  by version and SHA-256.
- `.github/workflows/release.yml`: build → package (+ smoke install) → sign → upload → AUR push,
  gated off until `RELEASE_ENABLED` is set.
- `nightly.yml`: its `surfer package` step is replaced by `./mach package` (see Findings).
- `docs/runbook.md` (Releases): enabling and verifying; `docs/guide.md`: "Installing" (planned).
- `README.md`: the first release adds the download and latest-release badges to the badge bar
  ([README badges](#readme-badges)).

Out of scope: macOS and Windows (M7); the update manifest, MAR files and update server (separate
spec, with the in-app updater); Flatpak (plan §9 open question); AppStream metainfo; a smoke
test of the AUR package on Arch (the `.SRCINFO` is checked against `makepkg --printsrcinfo`
where makepkg exists). (Since changed: the PKGBUILD is built and installed on Arch Linux in CI;
[Arch Linux without the AUR](#arch-linux-without-the-aur), decision 6.)

## Artifacts and names

`V` is `brands.vimma.release.displayVersion` in `surfer.json`, which release-please bumps
(runbook, Releases); the tag is `vV`. `package.mjs --tag` refuses a tag that is not exactly `vV`,
so a release can never carry packages of another version. Firefox's version (`version.version`)
appears in no file name; it is in `vimma --version`'s About dialog line and the SBOM.

| Artifact           | Name                                          | Contents                                                                                                        |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tarball            | `vimma-V-linux-x86_64.tar.xz`                 | `./mach package`'s `vimma-<firefox>.en-US.linux-x86_64.tar.xz`, renamed, unchanged: one top-level `vimma/` dir  |
| AppImage           | `vimma-V-x86_64.AppImage`                     | type-2 AppImage of `usr/lib/vimma/` + desktop file + icons; `AppRun` (below)                                    |
| Debian package     | `vimma_V_amd64.deb`                           | `usr/lib/vimma/`, `usr/bin/vimma` → `../lib/vimma/vimma`, desktop file, hicolor icons, `usr/share/doc/vimma/`   |
| SBOM               | `vimma-V.cdx.json`                            | CycloneDX 1.6 JSON                                                                                              |
| Checksums          | `SHA256SUMS`                                  | `sha256sum` format over the four files above                                                                    |
| Signatures         | `<file>.sigstore.json`                        | one cosign bundle (signature, certificate, Rekor entry) per file above and for `SHA256SUMS`                     |
| AUR (not an asset) | `PKGBUILD`, `.SRCINFO`, `vimma-vimma.desktop` | pushed to `aur.archlinux.org/vimma-bin.git`; the source is the tarball's release URL with its SHA-256 filled in |

A SemVer pre-release (`0.2.0-rc.1`, nightlies) becomes `0.2.0~rc.1` in the `.deb` (sorts before
`0.2.0`). The AUR gets releases only: `pkgbuild()` refuses a pre-release (its `pkgver` could not
hold the hyphen its download URL needs), `package.mjs` writes no AUR files for one, and
`release.yml` accepts `vX.Y.Z` tags only. (Since changed: `PKGBUILD` and `SRCINFO` are release
assets in `SHA256SUMS`, and the AUR gets `PKGBUILD` and `.SRCINFO` only; [Arch Linux without the
AUR](#arch-linux-without-the-aur).)

`package.mjs` reads `RemotingName` from the tarball's `application.ini` for `StartupWMClass`
(today `vimma-vimma`, see Findings) and refuses a tarball without `vimma/vimma` or with an
`application.ini` whose `Name` is not `Vimma`.

## Desktop integration

One `vimma-vimma.desktop` (desktop file ID = `RemotingName` from `application.ini`, so it
matches the X11 `WM_CLASS`, the Wayland `app_id` and the MPRIS name), shared by all three
packages. Generated by `desktopEntry()`, checked by
`desktop-file-validate` when it is installed (the test skips that part otherwise, and always runs
structural checks: group order, required keys, `;`-terminated lists, every action has a group).

- `Exec=vimma %u`, `Icon=vimma`, `StartupWMClass=<RemotingName>`, `Categories=Network;WebBrowser;`,
  `Terminal=false`, `StartupNotify=true`, `Keywords=…;vim;`.
- `MimeType=`: Mozilla's list from `python/mozbuild/mozbuild/repackaging/desktop_file.py` without
  `x-scheme-handler/chrome` and `x-scheme-handler/mailto` (a browser that grabs mail links is a
  surprise): `text/html`, `application/xhtml+xml`, `x-scheme-handler/http`,
  `x-scheme-handler/https`, PDF, images, audio/video, feeds, XML, JSON, `application/x-xpinstall`.
  Becoming the default browser stays the user's choice (`xdg-settings set default-web-browser
vimma-vimma.desktop`); the `.deb` also registers `x-www-browser`/`gnome-www-browser` alternatives at
  priority 40, below Firefox's 100, so it never takes over by itself.
- Actions: `new-window`, `new-private-window`, `open-profile-manager` (as upstream).
- Icons: `configs/branding/vimma/logo{16,22,24,32,48,64,128,256,512}.png` →
  `usr/share/icons/hicolor/NxN/apps/vimma.png`, `logo.svg` → `scalable/apps/vimma.svg`. The
  AUR package uses the 16–128 px icons inside the tarball (`browser/chrome/icons/default/`),
  which are the same files (Surfer's branding step copies them).

### AppImage specifics

`AppRun` sets two variables before `exec "$APPDIR/usr/lib/vimma/vimma" "$@"`:

- `MOZ_LEGACY_PROFILES=1`: the runtime mounts the image at a new `/tmp/.mount_vimma…` path on
  every start; Firefox's dedicated profiles are keyed by install path, so without this every
  launch would open a fresh profile.
- `MOZ_APP_LAUNCHER="$APPIMAGE"`, only when the runtime set `$APPIMAGE` (never empty):
  "make default browser" and the remoting service record the `.AppImage` path, not the
  temporary mount.

The runtime statically links libfuse 3.15.0 (LGPL-2.1+), so the AppDir carries
`usr/share/doc/vimma/LGPL-2.1.txt` (gnu.org's text) and `APPIMAGE-RUNTIME-NOTICE.txt`: which
runtime release, where its complete source and build scripts are, and how to relink or replace
the runtime (`--appimage-extract`, then appimagetool with `--runtime-file`). `publish` appends a
short "Third-party notice" to the release notes (once; a re-run finds the heading).

appimagetool runs with `--no-appstream` (no metainfo yet) and `--runtime-file` (the pinned
runtime; without it appimagetool downloads the latest one at build time, which is unpinned).

## Tools and licences

| Tool                                                | Licence                                                                                                 | How it is fetched                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| appimagetool 1.9.1                                  | MIT                                                                                                     | `fetch-appimagetool.sh`: GitHub release asset, SHA-256 checked; run with `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE needed)                                                                                                                             |
| AppImage type-2 runtime 20251108                    | MIT; statically links libfuse 3 (LGPL-2.1+), squashfuse (BSD-2-Clause), musl (MIT), zstd (BSD-3-Clause) | same script, SHA-256 checked. It becomes the first ~1 MB of our AppImage: unmodified upstream binary, its source is AppImage/type2-runtime at that tag; release notes link it (LGPL relinking offer is met by the public source and build scripts) |
| `dpkg-deb`                                          | GPL-2.0+ (system tool on `ubuntu-24.04`, not shipped)                                                   | preinstalled                                                                                                                                                                                                                                       |
| `desktop-file-validate`                             | GPL-2.0+ (system tool, tests only)                                                                      | `apt-get install desktop-file-utils` in the package job                                                                                                                                                                                            |
| cosign 3.0.6 via `sigstore/cosign-installer` v4.1.2 | Apache-2.0                                                                                              | action pinned by SHA; it verifies the cosign binary it downloads                                                                                                                                                                                   |
| SBOM generator                                      | ours (MPL-2.0)                                                                                          | `tools/package/sbom.mjs`                                                                                                                                                                                                                           |
| ajv 8.20.0 (schema validation)                      | MIT                                                                                                     | npm devDependency; it was already in the lockfile through eslint, now direct (no new package)                                                                                                                                                      |
| CycloneDX 1.6.2 JSON schemas, SPDX list 3.24.0      | Apache-2.0; CC0-1.0                                                                                     | vendored in `tools/package/vendor/`, sources and SHA-256 in its README                                                                                                                                                                             |

No new npm package (ajv becomes a direct devDependency at the version already installed).
Every tool runs in CI or at release time only; nothing but the AppImage runtime ends up in an
artifact.

## SBOM

**CycloneDX 1.6 JSON**, generated by our own small script rather than syft (Apache-2.0) or
cdxgen: those scan installed package metadata, and a Firefox build has none, so they would list
almost nothing. Firefox's own inventory is in the tree:

- `metadata.component`: Vimma `V`, MPL-2.0, `pkg:github/vimma-browser/vimma@vV`.
- Firefox `version.version`, MPL-2.0 (`pkg:generic/mozilla/firefox@157.0.1`).
- Every crates.io and git package in `engine/Cargo.lock` (`pkg:cargo/name@version`, the lockfile
  SHA-256 for registry crates, licence from `third_party/rust/<name>[-<version>]/Cargo.toml`).
  In-tree crates (no `source`) are part of Firefox and not listed.
- Every `moz.yaml` `origin` (name, licence, URL): the C/C++ libraries Mozilla vendors (libvpx,
  ffvpx, …). The version is the `revision` (a commit) when there is one, else the `release`
  without the trailing "(date)." Mozilla's tooling writes.
- smol-toml, which `packages/vimma-core` vendors (`pkg:npm/smol-toml@1.9.0`, BSD-3-Clause; the
  version is read from the vendored file's header).
- (Since changed: `vimma-ctl`, which every package ships, with musl, Rust's standard library
  and LLVM's libunwind as its components, added by the `package` job and checked against the
  schema there; [ship-vimma-ctl](ship-vimma-ctl.md), Security and privacy.)

Licences: a single id is looked up case-insensitively in the SPDX License List 3.24.0 (the
version CycloneDX 1.6.2's `spdx.schema.json` enumerates) and written in SPDX's spelling
(`libpng` → `Libpng`); an expression is kept only if every id and exception is on the list
(operators upper-cased, the old `MIT/Apache-2.0` form becomes `MIT OR Apache-2.0`); anything
else becomes `license.name`. `validate-sbom.mjs` validates against the official schema in the
tests and in the `build` job, so an invalid SBOM fails the release.

It lists what the source tree vendors, a superset of what is linked into the shipped binary
(test-only crates are included). That is stated in the SBOM's `metadata.properties`. npm
packages are dev tools only and never ship, so they are not listed.

## Signing: cosign keyless (recommended)

| Option                          | Needs from you                                                         | Verify                                                                 | Risks                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Keyless (GitHub OIDC)**       | nothing but `SIGNING_ENABLED=true`                                     | identity = this repo's `release.yml` at the tag, issuer GitHub Actions | the repo name and workflow path go into the public Rekor log (fine once the repo is public) |
| Key pair (`COSIGN_PRIVATE_KEY`) | generate, store, rotate a key and its password; publish the public key | `--key cosign.pub`                                                     | a leaked secret signs anything; rotation is manual                                          |

**Keyless**: there is no secret to leak, and the signature proves the file came from
`release.yml` in `vimma-browser/vimma`, run for a `vX.Y.Z` tag or from `main`. Users verify with
`--certificate-identity-regexp` `IDENTITY_REGEXP` (`package.mjs`; anchored, exact repo, only
`refs/tags/vX.Y.Z` or `refs/heads/main`) and `--certificate-oidc-issuer
https://token.actions.githubusercontent.com`; a test keeps the runbook's command equal to it.
(Since changed: `IDENTITY_REGEXP` accepts only `refs/heads/main`, since `release.yml` runs only
from `main`; docs/runbook.md, "Verify a release".) Only the `sign` job gets `id-token: write`; it runs
on a GitHub-hosted runner with no repository code except the downloaded artifacts.

Each file is signed with `cosign sign-blob --yes --bundle <file>.sigstore.json <file>`.

## Release workflow (`release.yml`)

(Since changed: `release.yml` starts only by `workflow_dispatch` on `main`, from
`release-please.yml`'s `release-build` job for the draft release-please creates, or by hand. It
uploads to the draft, and publishing rebuilds nothing. The `aur` job moved to `aur.yml`, which
runs when the release is published; docs/runbook.md, "Release packages".)

**Trigger: `release: types: [published]`**, plus `workflow_dispatch` with a `tag` input.

- release-please creates the tag and the GitHub Release (with the changelog notes) in one step;
  the workflow only adds assets to that release. With `push: tags`, the build would race the
  release creation, and any hand-pushed `v*` tag would start a release build with no notes.
- Neither event fires for a release or tag made with `GITHUB_TOKEN`, so either trigger needs
  release-please to run with `RELEASE_PLEASE_TOKEN` (a user step). `workflow_dispatch` covers
  the case without it and re-runs after a failure.
- `release` and `workflow_dispatch` cannot come from a fork or a pull request, so nothing from
  outside runs on the self-hosted runner through this workflow.
- A manual run executes the `release.yml` of the branch it is started on, so a pushed branch
  could otherwise rewrite the jobs and sign or upload anything. Every job therefore also needs
  `github.event_name == 'release' || github.ref == 'refs/heads/main'`, and the verify identity
  accepts only those refs.

Every job has `if: vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' &&
(github.event_name == 'release' || github.ref == 'refs/heads/main')` (manual runs too: the
runner and secrets must be ready first). Top-level `permissions: {}`.
`tools/package/test/release-workflow.test.mjs` checks the gate on every job, that only `sign`
has `id-token: write` and only `publish` `contents: write`, and that there is no PR or push
trigger.

**Build trust.** The `build` job uses a fresh objdir (`MOZ_OBJDIR=engine/obj-release`, deleted
first) and an empty sccache directory of its own (the nightly's sccache server is stopped first
and again at the end), so nothing a nightly or any other job left on the runner reaches signed
binaries. The cost is a cold build (~40 min) per release. The Firefox source in `engine/` is
still reused between runs (re-downloaded when `surfer.json` changes). **Until the repo has
"Require approval for all outside collaborators" set, the `vimma-build` runner must stay
offline outside builds.**

| Job       | Runner                    | Permissions       | Gate                       | Does                                                                                                                                                                        |
| --------- | ------------------------- | ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`   | self-hosted `vimma-build` | `contents: read`  | `RELEASE_ENABLED`          | checkout the tag, check tag = `vV`, fresh objdir + cache, `npm run import`, `surfer build`, `--version` and `application.ini` checks, `./mach package`, SBOM + schema check |
| `package` | `ubuntu-24.04`            | `contents: read`  | `RELEASE_ENABLED`          | `fetch-appimagetool.sh`, `package.mjs`, `desktop-file-validate`, smoke: `apt install ./vimma_V_amd64.deb`, `vimma --version`, AppImage `--version`                          |
| `sign`    | `ubuntu-24.04`            | `id-token: write` | + `SIGNING_ENABLED`        | cosign keyless bundles for every asset and `SHA256SUMS`                                                                                                                     |
| `publish` | `ubuntu-24.04`            | `contents: write` | `RELEASE_ENABLED`          | `gh release upload <tag> … --clobber` (assets, `SHA256SUMS`, bundles when signed); appends the third-party notice to the notes                                              |
| `aur`     | `ubuntu-24.04`            | none              | + `AUR_SSH_KEY` secret set | clone `ssh://aur@aur.archlinux.org/vimma-bin.git`, replace `PKGBUILD`, `.SRCINFO`, `vimma-vimma.desktop`, commit, push                                                      |
| `failure` | `ubuntu-24.04`            | `issues: write`   | any job failed             | opens or comments on a `release-failure` issue                                                                                                                              |

`publish` waits for `sign` and uploads the bundles when signing is enabled; with
`SIGNING_ENABLED` unset, `sign` is skipped and `publish` uploads unsigned assets. The AUR host key is pinned in the workflow (from `aur.archlinux.org`'s published fingerprints), not
fetched with `ssh-keyscan` at run time.

**No tag deletion on failure** (plan §4 says "tag deleted"): release-please has already moved its
manifest and changelog past that version, so deleting the tag would not bring the release PR
back; it only hides a release that does have notes. Instead the `failure` job opens an issue and
the fix is a re-run: `gh workflow run release.yml -f tag=vX.Y.Z`. `--clobber` makes re-runs
idempotent.

## Arch Linux without the AUR

(Since changed: added after the tooling above was implemented, because the `aur` job cannot run
until an AUR account exists, and without it Arch users had no package at all.) Each release
carries the `vimma-bin` `PKGBUILD` as an asset, and one command installs or updates Vimma:

```sh
curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si
```

(Since changed: the command now builds in a fixed folder, so that it works from any directory and
leaves no build files in the current one: `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si`; described in docs/guide.md, "Arch Linux".)

Engine paths were checked against Firefox 158.0 (`config/milestone.txt`).

1. **The PKGBUILD is a release asset.** Arch users get a pacman-managed install from the
   release itself, so that installing Vimma on Arch does not depend on an AUR account, which the
   `aur` job needs and the project does not have. `releases/latest/download/PKGBUILD` always
   names the newest release, so the same command installs and updates. `curl -f` makes a missing
   asset an error (exit 22) instead of a `PKGBUILD` that holds GitHub's "Not Found" page, so that
   the hours between publishing a release and its upload, or a failed release build, leave the
   user's previous `PKGBUILD` in place and stop before `makepkg` runs. Rejected: a pacman
   repository, because it needs hosting and a repository signing key of its own; telling Arch
   users to unpack the tarball, because pacman would then not own, upgrade or remove the files.
2. **The PKGBUILD needs no other file.** Its only `source` is the release tarball, by URL with
   its SHA-256 pinned; the desktop file and `vimma-open` are written in `package()` as quoted
   here-documents (`cat > … <<'VIMMA_OPEN_EOF'`, nothing expanded), so that a PKGBUILD
   downloaded on its own builds, since makepkg looks for a bare file name in `source=()` next to
   the PKGBUILD. `pkgbuild()` refuses inline content without a final newline or with a line equal
   to its delimiter, which would end the here-document early, and accepts only `owner/name`
   (`[A-Za-z0-9-]` and `[A-Za-z0-9._-]`) for the repository and `[A-Za-z0-9._-]` for the desktop
   file ID, because both are placed in double-quoted shell words that makepkg runs. The inline
   text is covered by the PKGBUILD's own line in `SHA256SUMS` and its cosign bundle. Rejected: publishing the desktop
   file and `vimma-open` as assets of their own, because that is two more downloads to name
   and keep in step for no gain; `raw.githubusercontent.com` URLs at the tag, because the package
   would then depend on the repository layout at that tag.
3. **One PKGBUILD, two variants.** `dist/PKGBUILD` (the asset) and `dist/aur/PKGBUILD` (what
   the `aur` job pushes) differ only in the install source of decision 4, so that the AUR gets
   the same tested file once it is published there. Both share one `.SRCINFO`, which must equal
   `makepkg --printsrcinfo`. The `aur` job pushes only `PKGBUILD` and `.SRCINFO` and removes the
   `vimma-vimma.desktop`, `vimma-open` and `vimma.desktop` files earlier versions pushed.
4. **The install source is recorded in `/opt/vimma/is-packaged-app`**, as
   `vimma-package=pkgbuild-release` or `vimma-package=aur`, so that the updater can tell installs
   apart and show the right command (spec [m6a-updater](m6a-updater.md), section 3 and decision
   24). Firefox treats this file as "installed by a package manager": it only tests that the
   file exists (`widget/gtk/WidgetUtilsGtk.cpp:253`, `IsPackagedAppFileExists`, read by
   `xpcom/base/nsSystemInfo.cpp:1759` as `isPackagedApp`), Mozilla's own `.deb` writes it
   (`python/mozbuild/mozbuild/repackaging/deb.py:126`), and with the updater built in it turns
   Firefox's updater off (`toolkit/mozapps/update/UpdateServiceStub.sys.mjs:214`), which is
   right for a pacman install. While the updater is compiled out its only other effect on Linux
   is to skip the unprivileged-user-namespaces warning
   (`security/sandbox/common/SandboxUtils.sys.mjs:25`), as Firefox does for its own packages.
   Rejected: a file in `/opt/vimma/distribution/`, because Firefox reads that directory
   (`toolkit/xre/nsXREDirProvider.cpp:480`): `distribution.ini` sets preferences
   (`browser/components/distribution.sys.mjs:45`), `policies.json` sets enterprise policies and
   `extensions/` are installed as add-ons (`toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs:4328`),
   so a marker there would sit in a directory whose contents change Vimma's behaviour.
5. **The `.SRCINFO` asset is named `SRCINFO`**, because GitHub renames an asset whose name has
   a leading period (docs.github.com, REST API "Upload a release asset", read 2026-10-15), and
   `SHA256SUMS` and the cosign bundle names must match the names users download.
6. **`makepkg -si` runs on Arch Linux before anything is signed.** `tools/package/arch-smoke.sh`
   starts `archlinux:base-devel` (pinned by digest, updated with pacman first), serves the
   output directory on `127.0.0.1` with `python3 -m http.server`, replaces only the URL prefix
   in a copy of the PKGBUILD (the SHA-256 stays, so makepkg still checks the bytes), compares
   `makepkg --printsrcinfo` with `SRCINFO`, runs `makepkg -si` as an unprivileged user, and
   checks `vimma --version`, the `is-packaged-app` line, `vimma-open` byte for byte, and the
   desktop file with `desktop-file-validate`. The release is not on GitHub yet when the package
   job runs, which is why the tarball is served locally. `release.yml`'s `package` job runs it
   on the release build, so a PKGBUILD that does not install is never signed or published, and
   `pkgbuild.yml` runs it on a stub tarball (`--stub`) on every change to `tools/package/`, so
   that a broken PKGBUILD fails in the pull request that breaks it.

## What each step needs from you

| Step        | Needs                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| any         | `gh variable set RELEASE_ENABLED --body true`; the `vimma-build` runner online during the release; `RELEASE_PLEASE_TOKEN` (or manual dispatch) |
| `package`   | `gh variable set PACKAGE_MAINTAINER --body 'Name <email>'` (the `.deb` `Maintainer:` and the PKGBUILD comment; the job fails without it)       |
| `sign`      | `gh variable set SIGNING_ENABLED --body true` (keyless: no key)                                                                                |
| `aur`       | an AUR account, its SSH key as `gh secret set AUR_SSH_KEY`, and the name `vimma-bin` still free on the AUR (check before the first push)       |
| public repo | the runner exposure rules in the runbook (fork PRs must not reach `vimma-build`)                                                               |

## README badges

The README opens with a centred row of shields.io badges in one muted grey style
(`labelColor=333333`, `color=666666`): licence (MPL-2.0), GitHub stars, CI status on `main` and
the Firefox version Vimma is built on (read from `surfer.json`). These work before any release
(`README.md`).

The first release that publishes assets adds two more, in the same style:

- total downloads,
  `https://img.shields.io/github/downloads/vimma-browser/vimma/total?labelColor=333333&color=666666`,
  linking to the Releases page;
- the latest release,
  `https://img.shields.io/github/v/release/vimma-browser/vimma?label=release&labelColor=333333&color=666666`,
  linking to `releases/latest`.

An AUR version badge (`https://img.shields.io/aur/version/vimma-bin`, same style) follows once the
`aur` job has pushed `vimma-bin`.

(Since changed: the badges use Vimma's own palette instead of grey, so the README matches the
browser and vimma.dev: `labelColor=0a0f12` (the background) with `color=163327` (the selection
green), and the latest-release badge in the mint accent, `color=1bf587`, as the one value a visitor
looks for first. The CI badge keeps shields.io's status colours, which carry meaning. The AUR
badge takes the same palette.)

1. **The release badges wait for the first release.** Before a release both would read "0" or
   "no releases", which tells a reader nothing, so they are added with the first published
   release and not earlier.
2. **A README edit, not a `release.yml` step.** The badges are added by hand when the first
   release is published, because shields.io reads the counts from the GitHub and AUR APIs on
   each view: once the badge is in the README it stays current without the workflow touching
   the README again. Rejected: having `release.yml` commit the badges, because `main` takes
   changes only through pull requests.

## Tests (write first)

`tools/package/test/package.test.mjs` (Vitest), against a fake `./mach package` tarball built in
a temp dir (`vimma/vimma` shell stub, `vimma-bin`, `application.ini`, `libxul.so`,
`browser/chrome/icons/default/default*.png`), `tar -cJf`:

- Version: `releaseVersion(surfer.json)` returns `displayVersion`; a mismatching `--tag` and a
  non-SemVer version throw; `debVersion` maps pre-releases; `pkgbuild`/`srcinfo` refuse them.
- Names: the table above, from the version.
- `application.ini`: `RemotingName` is read; a tarball without `vimma/vimma` or with another
  `Name` is refused.
- Desktop file: required keys, MIME list contains http(s) and text/html and not mailto,
  `StartupWMClass` from `application.ini`, every `Actions=` entry has a group; passes
  `desktop-file-validate` (skipped without it).
- Release tarball: same bytes as the input, renamed.
- AppDir: `AppRun` 0755 with `MOZ_LEGACY_PROFILES=1`, `MOZ_APP_LAUNCHER` only under the
  runtime (run with and without `$APPIMAGE`), exec of `usr/lib/vimma/vimma`; root
  `vimma-vimma.desktop` and `vimma.png`; `usr/share/doc/vimma/LGPL-2.1.txt` and the runtime
  notice (release, source URL, libfuse version, how to replace it); icons at every size;
  executables keep 0755, data files 0644, directories 0755. appimagetool is invoked (a stub that
  records its arguments) with `ARCH=x86_64`, `--no-appstream`, `--runtime-file`.
- `.deb` staging: `DEBIAN/control` fields (Package, Version, Architecture amd64, Maintainer,
  Installed-Size, Depends, Description), `postinst`/`prerm` 0755, `usr/bin/vimma` relative
  symlink, desktop file, icons, `usr/share/doc/vimma/copyright`. With `dpkg-deb` present (CI),
  the built `.deb` passes `dpkg-deb --info`/`--contents` checks.
- PKGBUILD: `pkgver`, `pkgrel=1`, source URL of the release tarball, `sha256sums` equal to the
  tarball's and the desktop file's SHA-256, `license=('MPL-2.0')`, `bash -n` clean; `.SRCINFO`
  fields match it, and equal `makepkg --printsrcinfo` when makepkg exists.
- `SHA256SUMS`: one line per artifact, `sha256sum -c` passes in the output dir.

`tools/package/test/sbom.test.mjs`: fixture `Cargo.lock`, vendored `Cargo.toml`s and
`moz.yaml`s: registry crates get purl, hash and licence; path crates are left out; git crates get
their VCS URL; `moz.yaml` licence lists become `OR`-free `licenses` arrays; the document has
`bomFormat`, `specVersion` 1.6, `serialNumber` as `urn:uuid:`, the Vimma metadata component;
licence ids in SPDX's spelling (`libpng` → `Libpng`), expressions canonicalised, unknown text as
a name; moz.yaml versions without the date; smol-toml listed; the document validates against
the official CycloneDX 1.6 schema, which rejects `license.id: "libpng"`.

`package.test.mjs` also: `IDENTITY_REGEXP` accepts `release.yml` at `refs/tags/vX.Y.Z` and
`refs/heads/main` only (not other branches, pre-release tags, PR refs, other workflows or
repos) and is what the runbook's `cosign verify-blob` uses; `RUNTIME_RELEASE` is the one
`fetch-appimagetool.sh` pins; the third-party release notes name it.

`release-workflow.test.mjs`: the gates and permissions above. Workflow: actionlint clean.

## Findings

- **`nightly.yml` could not package.** `surfer package` runs `./mach package`, then reads
  `locales/supported-languages` (Surfer's multi-locale step), which this repo does not have, so
  it throws before copying anything into `dist/`, and then it would build a MAR and update XML
  for an updater we compile out. The nightly now runs `./mach package` and publishes the tarball.
- **`StartupWMClass` is `vimma-vimma`.** `MOZ_APP_REMOTINGNAME` defaults to
  `<app name>-<update channel>` unless the channel is `release`, and Surfer sets the channel to
  the brand (`vimma`). That is also the Wayland `app_id`. The desktop file is named after it
  (`vimma-vimma.desktop`, read from `application.ini`), so shells match windows to it. A
  possible later cleanup: `MOZ_APP_REMOTINGNAME=vimma` (or the channel) for a plain `vimma`;
  that needs a full rebuild and changes the remoting name, so it is a separate decision (the
  updater spec owns the channel).
- `./mach package` on Linux makes `dist/vimma-<MOZ_PKG_VERSION>.en-US.linux-x86_64.tar.xz`
  (`MOZ_PKG_FORMAT=XZ` for GTK in `toolkit/moz.configure`; name from
  `toolkit/mozapps/installer/package-name.mk`). `MOZ_PKG_VERSION` is the Firefox version, hence
  the rename.

## Settled

- Node scripts with Vitest (the repo's test runner); Python was not needed.

## Hardening

Added before the first release, test-first where there is code: the main/release gate on every
job and an anchored verify identity; SPDX-canonical licence ids and validation against the
official schema; the LGPL text and runtime notice in the AppImage plus a release-notes notice;
smol-toml and clean moz.yaml versions in the SBOM; a fresh objdir and cache for release builds;
the desktop file ID `vimma-vimma`; AUR releases only, `ubuntu-24.04` in `failure`, no empty
`MOZ_APP_LAUNCHER`, and the `application.ini` version check in the release build.

- Install path `usr/lib/vimma` in the `.deb` (Mozilla's own `.deb` uses `usr/lib/firefox`), and
  `/opt/vimma` in the AUR package (Arch's convention for `-bin` browsers).
- The `.deb` `Depends:` is a static list of the libraries Firefox's binaries link against
  (`t64` alternatives for Ubuntu 24.04); the smoke install in the `package` job checks it
  resolves on `ubuntu-24.04`.
- Artifacts pass between jobs as workflow artifacts (retention 7 days), so the self-hosted runner
  never holds `contents: write`, `id-token: write` or the AUR key.
