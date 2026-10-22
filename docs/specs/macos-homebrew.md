# Spec: macos-homebrew

Status: draft (sub-PRs 1 to 3 and 5 implemented; sub-PR 4 in #408) · Area: `configs/branding/vimma/` (macOS icon
files, new), `configs/macos/AppIcon.icon/` (icon source, new), `configs/macos/mozconfig`,
`src/browser/branding/vimma/configure.sh`, `tools/package/` (cask generator and icon
generator, new), `packages/vimma-core/src/updates.mjs`,
`src/browser/base/content/vimma/updates/VimmaUpdates.sys.mjs`, `vimma/about/`,
`tools/update/manifest.mjs`, `.github/workflows/release.yml`, `update-publish.yml`,
`homebrew.yml` (new), `macos.yml`; the
`vimma-browser/homebrew-tap` repository (new); `docs/guide.md`, `docs/security.md`,
`docs/runbook.md`, `README.md` · Upstream patches: none (decision 9) · ADR: none

Issues: [#393](https://github.com/vimma-browser/vimma/issues/393),
[#408](https://github.com/vimma-browser/vimma/issues/408),
[#409](https://github.com/vimma-browser/vimma/issues/409)

Engine paths are relative to `engine/` and were checked against Firefox 158.0. Surfer paths
(`S/`) are relative to `node_modules/@zen-browser/surfer`, version 1.14.9. Homebrew facts were
checked against Homebrew 7.0.9 and its documentation as cited. Icon behaviour was checked on an
Apple Silicon Mac running macOS 27.0.1 with an artifact build of Firefox 158.0. Anything not
confirmed from a primary source is marked **unverified**.

## Summary

A Mac user installs Vimma with one Homebrew command, gets the same version and release notes as
the Linux packages, updates it with `brew upgrade`, and sees Vimma's own icon in the Dock,
Finder, the app switcher and the mounted `.dmg`, the same artwork as on Linux. The cask lives in
Vimma's own tap and installs the `.dmg` that the release publishes beside the Linux packages.
This spec builds on [macos-build](macos-build.md) and opens nothing before its release gate.

## Problem

- macos-build produces a `.dmg` but publishes it nowhere (its decision 12), and lists a Homebrew
  cask as out of scope. Mac developers, Vimma's second audience, install their tools with
  Homebrew; a download they have to find, mount, drag and update by hand is the path they avoid.
- A Mac build of Vimma shows Firefox's "unofficial" globe icon, not Vimma's. The Linux packages
  show the Vimma logo (`configs/branding/vimma/logo.png`).
- Linux releases reach Arch users through the AUR automatically (`aur.yml`). Nothing does the
  same for a Mac, so a Mac release would lag behind or need a person, which a Firefox security
  release must not (firefox-versions).

## Behaviour

1. `brew install --cask vimma-browser/tap/vimma` installs `Vimma.app` into `/Applications` and a
   `vimma` command on the `PATH`. No separate `brew tap` or `brew trust` step is needed with the
   fully qualified name (Research, "Tap trust").
2. The installed version is the latest published `vX.Y.Z` GitHub Release, the same release whose
   notes and Linux packages the AUR and the download page point to. `vimma --version` prints the
   same `Vimma <vimma> · Firefox <firefox>` line as the Linux build of that release.
3. Homebrew verifies the download against the SHA-256 in the cask, which equals the `.dmg`'s line
   in the release's `SHA256SUMS-macos`; the `.dmg` also has a cosign bundle, as every Linux asset
   does.
4. `brew upgrade --cask vimma` (and a plain `brew upgrade`) installs a newer release; the tap
   receives each release with no step beyond publishing it.
5. `brew uninstall --cask vimma` quits Vimma and removes the app and the `vimma` command;
   profiles, config and caches stay. `brew uninstall --zap --cask vimma` also removes the
   profiles and caches (decision 5).
6. The cask refuses to install on an Intel Mac and on a macOS older than the minimum (decision 6).
7. Before Vimma is notarised, the cask's caveats tell the user how to open it the first time
   (decision 7); after notarisation, it opens like any app.
8. Vimma on macOS shows the same update notices as on Linux when a newer release carries a
   `.dmg` (decisions 16 to 18). `:update` and `about:vimma` then suggest
   `brew upgrade --cask vimma` for a Homebrew install (decision 8), and for a `.dmg` installed by
   hand, the release page to download the new `.dmg` from and drag over the old app
   (decision 19). Vimma downloads and installs nothing itself (decision 20).
9. The app icon in the Dock, Finder, Launchpad, the app switcher and Get Info is the Vimma logo,
   rendered at every size from the same artwork as the Linux icons, with no grey plate around
   it. Documents Vimma opens (`.html`, `.pdf`) show a Vimma document icon. The mounted `.dmg`
   keeps the default volume icon for now (decision 14).
10. Nothing in a Linux build, package or release asset changes: the icon files are macOS-only
    build inputs, and the Linux jobs neither read nor produce them.

## Research

### Homebrew (7.0.9)

- **Formula or cask.** Homebrew builds formulae from source or installs its own bottles; GUI
  apps distributed as `.dmg`, like Firefox and Zen Browser, are casks (`brew info --cask firefox`,
  `brew info --cask zen`, checked with Homebrew 7.0.9). A source-built formula would compile
  Firefox on the user's Mac, which takes hours.
- **Reference casks.** `zen` installs `zen.macos-universal.dmg` from GitHub Releases, declares
  `auto_updates true`, `app "Zen.app"`, a `binary` wrapper for the `zen` command,
  `uninstall quit:` with its bundle identifier, and a `zap trash:` list of
  `~/Library/Application Support/Zen`, `~/Library/Caches/Zen`, its preferences plist and saved
  application state. `firefox` is similar and declares `depends_on macos:`. (`brew info --cask
--json=v2`, checked with Homebrew 7.0.9.)
- **Official repository.** Homebrew 5.0.0 (release notes, brew.sh, 2025-11-12) deprecated casks
  without code signing and announced that casks in `Homebrew/homebrew-cask` failing Gatekeeper
  checks are disabled from September 2026; the Cask Cookbook says official casks "must also meet
  the Gatekeeper requirement". Homebrew/homebrew-cask also has a notability requirement for new
  casks.
- **Quarantine.** Homebrew 5.0.0 deprecated `--no-quarantine` and `--quarantine`, because
  Homebrew "does not wish to easily provide circumvention to macOS security features". A cask's
  download is quarantined, so Gatekeeper checks the app on first open.
- **Tap trust.** Since Homebrew 6.0, a third-party tap must be trusted before its casks install.
  Installing with the fully qualified name (`brew install --cask user/repo/cask`) trusts only that
  item; otherwise `brew trust --cask user/repo/cask` or `brew trust user/repo`.
  `HOMEBREW_NO_REQUIRE_TAP_TRUST` is deprecated (docs.brew.sh/Tap-Trust).
- **Homebrew 7.0** (migration guide, docs.brew.sh): `preflight` and `postflight` blocks are
  deprecated in favour of declarative steps, with warnings for third-party taps until 2027-12-11;
  `url verified:` is deprecated; casks marked `auto_updates` are upgraded by `brew upgrade` by
  default; Intel macOS and macOS 14 moved to support tier 3; casks run in a sandbox.
- **Tap naming.** A tap repository `vimma-browser/homebrew-tap` is addressed as
  `vimma-browser/tap`, so the cask's full name is `vimma-browser/tap/vimma` (Homebrew's "Taps"
  documentation).
- **Prefix.** On Apple Silicon, Homebrew's prefix is `/opt/homebrew`, and an installed cask keeps
  its metadata in `/opt/homebrew/Caskroom/<token>/<version>/` (checked on this Mac).

### Vimma's Linux release (m6-packaging, release-versioning)

- `release.yml` runs by `workflow_dispatch` on `main` with a `vX.Y.Z` tag, dispatched by
  release-please: build, package, sign every asset with cosign keyless (`<file>.sigstore.json`),
  write `SHA256SUMS`, and upload to the draft release. Publishing the draft is the maintainer's
  click and rebuilds nothing. Asset names carry Vimma's version only
  (`vimma-V-linux-x86_64.tar.xz`). The `PKGBUILD` is one of the assets.
- `aur.yml` runs on `release: published` (and on `workflow_dispatch` with a tag). It runs
  nothing from the repository: it fetches the published release's `PKGBUILD` and `SRCINFO`,
  checks them against `SHA256SUMS` and `SHA256SUMS` against `release.yml`'s signature, and pushes
  them to the AUR with `AUR_SSH_KEY`, held by the `aur` environment whose deployment refs are
  `main` and `v*` tags. A missing key skips the job (`.github/workflows/aur.yml:1-22`,
  `release.yml:1-15`).
- The update check tells installs apart with `vimma-package=<type>` in the `is-packaged-app`
  marker beside `omni.ja` (`installTypeFrom`, `packages/vimma-core/src/updates.mjs:529-539`) and
  gives each type its update commands (`updateSteps`, same file).

### The update check on macOS (Firefox 158.0, Vimma 0.1.6)

- The manifest URL is `vimma.update.url`,
  `https://updates.vimma.dev/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml`
  (`src/browser/branding/vimma/pref/firefox-branding.js`). Vimma fills `%BUILD_TARGET%` as
  Firefox does, `Services.appinfo.OS + "_" + UpdateUtils.ABI` (`target()` in
  `src/browser/base/content/vimma/updates/VimmaUpdates.sys.mjs`;
  `toolkit/modules/UpdateUtils.sys.mjs:87-88`). `OS` is the build's `OS_TARGET`
  (`toolkit/xre/nsAppRunner.cpp:1200-1202`), `Darwin` for a macOS build; `ABI` is
  `Services.appinfo.XPCOMABI` (`UpdateUtils.sys.mjs:1073-1092`), which is `TARGET_XPCOM_ABI`,
  `<target cpu>-gcc3` (`build/moz.configure/toolchain.configure:2524-2531`), with the cpu
  `aarch64` for `--target=aarch64-apple-darwin` (`TARGET_CPU` in an Apple Silicon objdir's
  `config/autoconf.mk`). So an Apple Silicon build asks for
  `updates/browser/Darwin_aarch64-gcc3/vimma/update.xml`, which updates.vimma.dev answers with
  404: `update-publish.yml` writes only `Linux_x86_64-gcc3`.
- The client refuses a manifest whose `vimmaTarget` is not its own target (`judgeManifest`,
  `packages/vimma-core/src/updates.mjs`), and, when the Firefox version is equal, offers an
  update only for a later build ID. The Linux and macOS builds of one release are separate
  builds with their own build IDs: in v0.1.6, `application.ini` says `BuildID=20261019130931`
  in the tarball (its published manifest) and `BuildID=20261019132138` in
  `Vimma.app/Contents/Resources/application.ini` of the `.dmg`.
- The v0.1.6 `.dmg` has `omni.ja` in `Vimma.app/Contents/Resources/`, which is `GreD`, and no
  `is-packaged-app` marker, so the Linux rules of `installTypeFrom` read it as a tarball. Its
  `AppConstants.MOZ_UPDATER` is `false` (from `--disable-updater` in
  `configs/common/mozconfig`) and its `application.ini` has no `[AppUpdate]` section, so no
  Firefox updater runs on macOS.
- A file that `curl` downloads carries no `com.apple.quarantine` attribute (`xattr -l` on a
  release file fetched with the system's curl 8.7.1, macOS 27.0.1), so Gatekeeper does not
  check an app copied out of it on first open; a Homebrew cask's download does carry it
  (Homebrew 5.0.0's release notes, above), as a browser's download does.

### Icons in a macOS build (Firefox 158.0, Surfer 1.14.9)

- `browser/app/moz.build:74-77` copies `{branding}/firefox.icns`, `document.icns` and
  `Assets.car` into `Vimma.app/Contents/Resources/` for cocoa builds only (the block starts at
  line 45, `if CONFIG["MOZ_WIDGET_TOOLKIT"] == "cocoa"`). `browser/installer/package-manifest.in:45`
  requires `Assets.car`. `browser/app/macbuild/Contents/Info.plist.in:191-194` sets
  `CFBundleIconFile` to `firefox.icns` and `CFBundleIconName` to `AppIcon`.
- Surfer generates `firefox.icns` from `logo-mac.png` on a Mac host only
  (`S/dist/commands/patches/branding-patch.js:70-85`), and copies every other file from
  `browser/branding/unofficial` that it has not written itself (`copyMozFiles`, same file,
  lines 114-145). So a Vimma build carries Firefox's unofficial `Assets.car` (its asset names are
  `AppIcon_Assets/unofficial-*`, read with `assetutil --info`), `document.icns`, `disk.icns`,
  `background.png` and `dsstore`.
- Surfer then links Vimma's `src/` tree over the engine (`importFolders`, run after the branding
  step in `applyPatches`, `S/dist/commands/patches/command.js:184-192`). Vimma already overrides
  a branding file this way: `src/browser/branding/vimma/pref/firefox-branding.js`.
- `configs/branding/vimma/logo-mac.png` is byte-identical to `logo.png` (1024 × 1024), the source
  of the Linux icons.
- Rendering the app's icon with `NSWorkspace iconForFile:` on macOS 27.0.1: the build shows the
  unofficial globe, because macOS takes `AppIcon` from `Assets.car` before `CFBundleIconFile`.
  With `Assets.car` removed, macOS falls back to Vimma's `firefox.icns` but draws it small on a
  grey plate, the treatment macOS 26 and later give an icon that is not in an asset catalog.
- `Assets.car` is compiled by `actool`, which ships with Xcode, not with the Command Line Tools,
  and runs only on macOS. GitHub's `macos-15` images include Xcode (version **unverified**). A
  Linux cross-build cannot run it.
- `mach package` builds the `.dmg` through `python/mozbuild/mozbuild/action/package.py:54-70`,
  which accepts `--dsstore`, `--background` and `--icon`; `toolkit/mozapps/installer/upload-files.mk:21-28`
  passes only `MOZ_PACKAGE_EXTRA_ARGS`, which no in-tree file sets, so a default `.dmg` has no
  window background or volume icon. Whether `mk_add_options MOZ_PACKAGE_EXTRA_ARGS=…` in a
  mozconfig reaches it is **unverified**.
- The dev build's bundle identifier is `org.mozilla.dev.vimma.browser` (its `Info.plist`, from
  `appId` `dev.vimma.browser` in `surfer.json`): macOS names the bundle
  `<distribution id>.<MOZ_MACBUNDLE_ID>`, and Firefox's default distribution id is `org.mozilla`.
- `brew style` rejects `depends_on macos: ">= :sequoia"` and accepts `depends_on macos: :sequoia`,
  which means the same minimum. `brew audit --cask` without `--online`, `--signing` or `--new`
  downloads nothing (`Library/Homebrew/cask/audit.rb`), and `brew style` checks a cask outside a
  tap against a stricter rule set, so both run on a throwaway local tap (`brew tap-new --no-git`).
  Checked with Homebrew 7.0.9.

## Design

### Distribution

1. **A cask, not a formula,** because Vimma ships as a signed app bundle built in CI, and a
   formula would build Firefox from source on the user's Mac for hours. Rejected: a formula
   installing a prebuilt tarball, because Homebrew installs GUI apps as casks and a formula
   cannot place an app in `/Applications`.
2. **Vimma's own tap, `vimma-browser/homebrew-tap`,** because Homebrew/homebrew-cask rejects a
   cask that fails Gatekeeper and requires notability, and a tap lets Vimma ship each release
   the moment it is published. Rejected: submitting to homebrew-cask first, because an unsigned
   build is refused and a new browser is not yet notable; it can follow once Vimma is notarised
   and known (open question 1). The name follows Homebrew's common convention and leaves room for
   `vimma-ctl` or nightlies later. Rejected: `vimma-browser/homebrew-vimma`, because its command
   `vimma-browser/vimma/vimma` repeats the name.
3. **The documented install command is fully qualified,**
   `brew install --cask vimma-browser/tap/vimma`, so that one command taps the repository and
   trusts only this cask under Homebrew 6's tap trust. Rejected: `brew tap` then `brew install`,
   because it needs a separate `brew trust` step and trusts the whole tap.
4. **The cask installs the release's `.dmg`,** `vimma-V-macos-aarch64.dmg`, from
   `https://github.com/vimma-browser/vimma/releases/download/vV/`, with its SHA-256, so that Mac
   and Linux users get the same version from the same release, with the same notes, checksums
   and cosign bundles. `release.yml`'s macOS jobs add the `.dmg` to the release with its own
   `SHA256SUMS-macos` and `.sigstore.json` bundles, under macos-build's decisions 12 and 13: the
   jobs run only while `MACOS_RELEASE_ENABLED` is `true`, and a macOS failure does not hold back
   the Linux assets. A separate checksum file keeps `SHA256SUMS`, which `aur.yml` and the update
   manifest read, unchanged when the macOS files arrive hours after the Linux ones. The name carries Vimma's version only, as the Linux assets do (m6-packaging,
   "Artifacts and names"); macos-build decision 15's two-version name stays for workflow
   artifacts. Releases only: a pre-release gets no cask update, as the AUR gets none.
5. **The cask's contents.** `app "Vimma.app"`; `binary "#{appdir}/Vimma.app/Contents/MacOS/vimma"`
   so that `vimma --version` and the `vimma-ctl` workflow work from a terminal as on Linux;
   `uninstall quit:` with the bundle identifier, so that an uninstall does not delete a running
   app; `zap trash:` with `~/Library/Application Support/Vimma`, `~/Library/Caches/Vimma`, the
   preferences plist and the saved application state of the bundle identifier (decision 15);
   `livecheck { url :url; strategy :github_latest }` so that `brew livecheck` finds new releases.
   No `preflight` or `postflight` block, because Homebrew 7 deprecates them and nothing needs one.
   `~/.config/vimma/` is not zapped, because it is the user's config and often a dotfiles symlink.
   `--zap` removes the profiles too, as `zen` and `firefox` do, because that is what users expect
   from it and keeping them would leave the largest data behind; it runs only when the user types
   `--zap`, and the guide says what it deletes. Rejected: zapping caches and state only.
6. **Apple Silicon, macOS 15 or later.** `depends_on arch: :arm64`, because macos-build builds
   arm64 only (its decision 3); `depends_on macos: :sequoia` (macOS 15 or later), because the
   release is tested
   on `macos-15` runners and Homebrew 7 moved macOS 14 to tier 3. Firefox's own minimum
   (`LSMinimumSystemVersion` 10.15.0, `browser/app/macbuild/Contents/Info.plist.in:257-258`) is
   lower, but an untested version is not offered.
7. **`auto_updates false`, and the tap is published before notarisation.** Vimma has no macOS
   updater (macos-build decision 16), so Homebrew is the updater, and `brew upgrade` must replace
   the app. Before a Developer ID exists, the app is ad hoc signed and quarantined on download, so
   macOS refuses the first open; the cask's `caveats` explain Open Anyway in System Settings →
   Privacy & Security, and say nothing about `xattr` or `--no-quarantine`, which Homebrew
   deprecates as a circumvention. The tap ships with the macOS release, as the AUR ships with the
   Linux one, so that Mac users can try Vimma as soon as the release carries a `.dmg`; the
   caveat is the cost, and the `.dmg` downloaded by hand has the same one. Rejected: waiting for
   notarisation (macos-build sub-PR 6), because it would hold the tap back behind a yearly
   Developer ID cost while the `.dmg` itself is already public. When the macOS updater ships for
   signed builds, the cask switches to `auto_updates true`, as `zen` and `firefox` do, so that
   Homebrew and the updater do not fight.
8. **A Homebrew install is recognised by the Caskroom, not by a marker in the app.** The update
   check reports `homebrew` when the running app is `/Applications/Vimma.app` and
   `/opt/homebrew/Caskroom/vimma/` exists, and `updateSteps` gives `brew upgrade --cask vimma`.
   A `vimma-package=homebrew` marker inside the bundle was rejected, because the same `.dmg`
   serves the download and the cask, and writing into a signed bundle after the build breaks its
   signature. The check is in `packages/vimma-core` as a pure function of the two facts, so it is
   tested in Vitest and cannot change a Linux result: on Linux neither path exists. Decisions 16
   to 20 make the notice that shows this command reach macOS.

### Tap updates

9. **The cask is a release asset, and `homebrew.yml` pushes it,** as the `PKGBUILD` and
   `aur.yml` do, so that Mac users get a security release without a person and the tap only
   ever receives a file the signed release contains. `release.yml`'s `macos-build` job renders
   `vimma.rb` with `tools/package/cask.mjs` from the `.dmg`'s SHA-256 and lists it in
   `SHA256SUMS-macos`; `macos-smoke` checks it with `brew style` and an offline
   `brew audit --cask --strict` on `macos-15` and installs the `.dmg` through it; `macos-sign`
   signs it. `homebrew.yml` runs only by `workflow_dispatch` with a tag, from `main`, and
   checks the tag is `vX.Y.Z`, fetches the published `vimma.rb`, checks it against
   `SHA256SUMS-macos`, its version against the tag, and `SHA256SUMS-macos` against
   `release.yml`'s signature, and pushes it to the tap as `Casks/vimma.rb`, never replacing a
   newer cask with an older one. It runs nothing from the repository, and it is its own
   workflow, so a tap failure cannot fail the release. `release.yml`'s `macos-tap` job, holding
   only `actions: write`, starts `homebrew.yml` on `main` for the tag once the cask is
   downloadable from the published release, since the `.dmg` usually arrives hours after the
   publish. Rejected: a `release: published` trigger, because a release event runs the tag's
   copy of the workflow, and anyone with write access can create a tag on an unmerged commit whose
   copy skips every check; rendering the cask in `homebrew.yml`, because the job holding the
   tap's key would then run repository code; a step in `release.yml`, because it would put the
   tap's key in the build job.
10. **The tap's credential is a deploy key held by a `homebrew` environment,** limited to `main`,
    so that only a workflow file reviewed onto `main` can write to the tap, and a missing key
    skips the job instead of failing it. No tag may deploy to it, because a tag ruleset restricts
    moving a tag, not creating one (`docs/security.md`, B6). Rejected: a personal access token, because a
    deploy key reaches only the one repository. The tap repository's branch rules allow pushes by
    the deploy key and pull requests by others.
11. **The tap holds only generated files and a README,** so that every cask change is visible in
    this repository's review, and the tap cannot drift from the generator. The tap's own CI,
    `check.yml`, runs the same checks as `cask-check.sh`, `brew style` and an offline
    `brew audit --cask --strict`, on the latest stable Homebrew, on the tap's pull requests and
    pushes to `main`, so that a cask passes the same rules in both places and a network failure
    cannot fail the tap with no cask change. `cask-check.sh` runs the runner image's Homebrew on
    the one cask, so a new Homebrew audit rule can turn the tap red before this repository's
    `cask` job. It is not a required check, so it never holds `homebrew.yml`'s push. Rejected: `--online`, because it
    downloads the `.dmg` and queries GitHub, and `macos-smoke` already installs the `.dmg`
    through the cask.

### Icon parity

12. **The macOS icon comes from the Linux artwork.** `configs/macos/AppIcon.icon/icon.json` is
    an Icon Composer document whose single layer is the Vimma logo, so that every platform shows
    the same logo and macOS 26 and later draw it with their own shape and lighting rather than on
    a grey plate. Rejected: an `.xcassets` catalog of pre-rendered sizes, because Icon Composer's
    format is what current macOS renders natively and it holds one source instead of a set of
    bitmaps.
13. **The compiled icon files are committed to `configs/branding/vimma/`:** `Assets.car`,
    `firefox.icns` and `document.icns`, because Surfer's branding step copies that directory's
    top-level files into the engine's branding directory and the Linux cross-build cannot run
    `actool`. They live there rather than under `src/`, because every file under `src/` must
    carry an MPL header, which a binary cannot. `tools/package/macos-icons.mjs` compiles them
    with `actool`, and `macos.yml`'s `icons` job, on a Mac with a pinned Xcode, regenerates them
    and fails if they differ from the committed files, so the binaries cannot drift from their
    source. The drift check normalises the fallback renditions `actool` writes into `Assets.car`
    under a fresh UUID name on every run, comparing their sizes and source layer rather than
    their names and bytes. The files are inputs of cocoa builds only (`browser/app/moz.build:45`),
    so Linux builds and packages are unchanged. This supersedes macos-build decision 17's
    committed `firefox.icns` generated by Surfer, which macOS ignores while `Assets.car` provides
    `AppIcon`; the committed `firefox.icns` stays as the fallback for systems that read it.
    Rejected: compiling `Assets.car` during every build, because the release build runs on Linux;
    patching `Info.plist.in` to drop `CFBundleIconName`, because macOS 26 and later then draw the
    icon on a grey plate.
14. **The `.dmg` window and volume icon come later,** so that the app icon ships without waiting
    for them. A `background.png`, its `dsstore` and a `disk.icns` volume icon would be passed to
    `mach package` through `MOZ_PACKAGE_EXTRA_ARGS`, which no in-tree file sets and whose reach
    from a mozconfig is **unverified**; until then the mounted image shows the default volume
    icon and no window art, and no `disk.icns` is committed. Rejected: running `package.py`'s DMG
    step by hand in the release job now, because the dmg is repacked by
    `tools/package/macos-dmg.sh` (macos-build) and a second packaging path would need its own
    checks.
15. **The bundle identifier is `dev.vimma.browser`,** `surfer.json`'s `appId`, because macOS
    keeps preferences and window state under it, the cask's `uninstall quit:` and `zap` name it,
    and changing it after the first public build would strand every user's settings.
    `configs/macos/mozconfig` sets the distribution id to `dev.vimma` and
    `src/browser/branding/vimma/configure.sh` sets `MOZ_MACBUNDLE_ID` to `browser`, so the bundle
    is `dev.vimma.browser`; both are macOS only, so Linux keeps Firefox's `org.mozilla`.
    `tools/package/cask.mjs` reads `appId` from `surfer.json`, so the cask follows it. Rejected:
    Surfer's default `org.mozilla.dev.vimma.browser`, because it carries "mozilla" and "dev".

### Update notices

16. **A second manifest, for the macOS target.** `update-publish.yml` signs and publishes
    `updates/browser/Darwin_aarch64-gcc3/vimma/update.xml` for a release whose `.dmg` is
    published, because that is the path an Apple Silicon build asks for (Research, "The update
    check on macOS") and the client refuses a manifest for another target. It takes a `target`
    input, `linux` (the default, unchanged) or `macos`, and each run writes the one file of its
    target. A `macos` run is started by `release.yml`'s `macos-tap` job once the `.dmg` is on a
    published release, and by `update-publish.yml`'s own `start` job when a release is
    published with its `.dmg` already there, since the `.dmg` usually arrives hours after the
    publish, and sometimes before it. A release without a `.dmg` (`MACOS_RELEASE_ENABLED` off,
    or a failed macOS build) starts no `macos` run, so the previous macOS manifest stands
    rather than one that names a file the release lacks. Both runs use the same key, the same
    `sign` job and checks, with the expected target taken from the input, the same verification
    before the push and the same `update-publish` environment, so the macOS file adds no
    secret, permission or trust beyond the Linux one. `offer=nothing` with `target=macos` pulls
    a macOS update as it does a Linux one. Rejected: one run writing both files at publish,
    because the `.dmg` is rarely there yet; listing the `.dmg` in the Linux manifest, because a
    manifest names one target and the Linux serial would move whenever macOS files arrive.
17. **The macOS manifest carries the macOS build's Firefox version and build ID.** For the
    `macos` target, `prepare` runs on a `macos-15` runner, checks the `.dmg` against
    `SHA256SUMS-macos` after verifying that file's cosign signature (the identity of
    `release.yml` on `main`, as for `SHA256SUMS`), mounts it read-only, and reads
    `Vimma.app/Contents/Resources/application.ini`, because the client compares build IDs when
    the Firefox version is equal and the two builds' IDs differ (Research): a Linux build ID
    later than the Mac's would offer Mac users the version they already run. Rejected: the
    Linux build ID; unpacking the `.dmg` on Linux with mach's `unpack_dmg`, because it needs the
    Firefox source and bootstrapped tools in a job meant to hold only public files.
18. **`<vimmaDmg>` names the `.dmg` in the manifest,** with the same attributes and rules as
    `<vimmaTarball>`, `<vimmaAppImage>` and `<vimmaDeb>` (m6a-updater §2): at most one, a
    whole-number size, a lower-case SHA-512 and an https URL, so that the client reads and
    refuses it exactly as the others. The macOS manifest carries only `<vimmaDmg>`, and the
    Linux manifest is unchanged, because each target downloads only its own files. Firefox's
    own manifest parser ignores the element, as it ignores the others.
19. **Install types on macOS: `homebrew` and `dmg`.** `installTypeFrom` takes the platform, the
    app bundle's path and whether `/opt/homebrew/Caskroom/vimma/` exists, as plain facts the
    host gathers. On macOS a build without `omni.ja` is `source`, the cask's app is `homebrew`
    (decision 8), and anything else with `omni.ja` is `dmg`; the `is-packaged-app` marker is not
    read, because no macOS build writes one and one written into the bundle would break its
    signature. For `dmg`, `updateSteps` says to quit Vimma, download the new `.dmg` from the
    release page and drag Vimma over the copy in Applications, notes that macOS asks again on
    the first open (the guide's "The first open"), links the release page and gives no
    command, because a `.dmg` that `curl` fetches carries no quarantine attribute (Research), so
    a command would skip the Gatekeeper check that decision 7 never tells users to bypass.
    Rejected: a `curl`, `hdiutil` and `ditto` command, for that reason; reporting `tarball`, whose
    steps do not apply to a Mac.
20. **A notice, never an update.** Vimma on macOS shows the notice and the steps and changes no
    file, because macOS builds have no Firefox updater (Research) and an update that rewrote the
    ad hoc signed bundle would break its signature (macos-build decision 16). The manifest
    carries no `<patch>` and no MAR. Rejected: a macOS MAR, until Developer ID signing exists.
21. **Vimma 0.1.6 on a Mac gets the notice with Linux steps, and the guide says so.** 0.1.6 is
    the only release with a `.dmg`; it reads the macOS manifest (its parser skips the
    `<vimmaDmg>` it does not know), shows the notice, and, finding `omni.ja` and no marker,
    calls itself `tarball`, so `:update` shows the Linux tarball command. The macOS manifest is
    published anyway, because the notice is the only way those installs learn of a newer
    release, and the guide's Updates section tells 0.1.6 Mac users to ignore the command and
    update with `brew upgrade --cask vimma` or the new `.dmg`; the release after it shows the
    right steps. Rejected: holding the macOS manifest back, because 0.1.6 would then never hear
    of an update; a different manifest path for newer builds, because it departs from Firefox's
    URL template and would hide every update from 0.1.6.

### Not in this spec

Submitting to Homebrew/homebrew-cask (open question 1); Developer ID signing and notarisation
(macos-build sub-PR 6); the macOS updater (macos-build decision 16); Intel builds; a formula for
`vimma-ctl` alone (it ships inside the app); MacPorts and Nix.

## Security and privacy

- **Supply chain.** The cask pins the `.dmg`'s SHA-256 and is itself a signed release asset;
  `homebrew.yml` pushes it only after checking it against `SHA256SUMS-macos` and
  `SHA256SUMS-macos` against `release.yml`'s signature at `refs/heads/main`, so a tap commit
  cannot point at a file the release did not build.
  `docs/security.md` gets a "Homebrew tap" entry covering this, the deploy key and its
  environment, and a test link for each claim (`npm run security-links`).
- **The tap's write credential** is a deploy key scoped to one repository, held by an environment
  restricted to `main`, and used only in `homebrew.yml`, whose permissions are
  empty; the key is never printed and is removed from the runner after the push. A stolen key
  can change the tap but not the release, and Homebrew still checks the pinned SHA-256 against
  the GitHub download.
- **Gatekeeper.** The caveats never tell a user to remove quarantine or disable Gatekeeper; they
  point to the per-app Open Anyway that macOS offers. A notarised build needs no caveat.
- **Tap trust.** The documented command trusts one cask, not the whole tap.
- **Icons.** The committed `Assets.car` and `.icns` files are binaries in the tree; the
  regeneration check in `macos.yml` makes them reproducible from the committed sources, so a
  changed binary without a changed source fails CI.
- **Update manifest.** The macOS manifest is signed by the same Cloud KMS key, in the same
  `sign` job, checked by the same verifier and the browser's pinned keys before the push, and
  pushed with the same deploy key (decision 16); the client applies the same rules to it as to
  the Linux one. It names a `.dmg` only after the `.dmg` matched `SHA256SUMS-macos` and that
  file matched `release.yml`'s signature, so a manifest cannot point at a file the release did
  not build. `docs/security.md`'s update manifest entries say so. The macOS `prepare` job holds
  no secret, as the Linux one, and mounts only a `.dmg` whose checksum it has verified.
- **Uninstall.** `zap` removes the profile directory, which holds history, cookies and saved
  passwords; it runs only with `--zap`, which the user types, and the guide says so.

This change touches a workflow with a secret and the release, so it gets a review by a fresh
agent before merging.

## Tests

**Vitest (`tools/package/test/`, `packages/vimma-core/test/`):**

- `cask names the release dmg for the tag and pins its sha256`
- `cask refuses a tag that is not vX.Y.Z and a pre-release`
- `cask declares arm64, the minimum macOS, auto_updates false, the vimma binary and no flight blocks`
- `cask zaps Application Support, Caches, the plist and saved state, and not ~/.config/vimma`
- `cask caveats mention Open Anyway and not xattr or --no-quarantine` (while unsigned)
- `installTypeFrom reports homebrew for /Applications/Vimma.app with a vimma Caskroom`
- `installTypeFrom ignores a Caskroom on Linux paths` (Linux types unchanged)
- `updateSteps for homebrew is brew upgrade --cask vimma`
- `installTypeFrom reports dmg for any other packaged app on macOS, and source without omni.ja`
- `installTypeFrom on macOS ignores an is-packaged-app marker`
- `updateSteps for dmg links the release page and gives no command`
- `parseManifest reads <vimmaDmg>, and refuses a second one, a bad hash or an http URL`
- `manifest.mjs builds the Darwin_aarch64-gcc3 manifest from the dmg, SHA256SUMS-macos and the
app's application.ini` (`tools/update/test/`)
- `update-publish.yml signs and publishes the macOS manifest at its own path, checks the
Darwin target before signing, and runs prepare on macos-15 for it`
- `macos-tap and start start update-publish.yml for the macOS target once the dmg is on a
published release`
- `homebrew.yml runs on release and dispatch, verifies the cask against the signed
SHA256SUMS-macos before pushing, runs no repository code, and holds the key only in the
homebrew environment` (workflow wiring, as `release-workflow.test.mjs` does for `aur.yml`)
- `macos-tap starts homebrew.yml on main once the cask is on a published release`
- `the macOS icon files exist in configs/branding/vimma and nowhere in the Linux package
inputs`

**macOS CI (`macos.yml`, `macos-15`):**

- The icon files regenerate from `configs/macos/AppIcon.icon/` to the committed files, with
  `actool`'s UUID-named fallback renditions normalised.
- `assetutil --info` on the built app's `Assets.car` lists `AppIcon` and no `unofficial` asset.
- The rendered app icon (`NSWorkspace iconForFile:`) matches a reference rendered from
  `logo-mac.png` within a tolerance, and is not the unofficial globe.
- `brew style` and `brew audit --cask --strict` pass on the generated cask; `brew install --cask`
  from a local tap with the release's `.dmg` installs the app, keeps its signature and links
  `vimma`, and `brew uninstall --zap --cask vimma` removes the app and the zap paths and leaves
  `~/.config/vimma`. `release.yml`'s `macos-smoke` runs this on the real `.dmg`, and
  `pkgbuild.yml`'s `cask` job on a stub `.dmg` for every packaging change.

**Mochitest (`tests/browser/browser_vimma_update_check.js`):** with the install type set to
`homebrew`, `:update` shows `brew upgrade --cask vimma`; with `dmg`, the release page and no
command.

**Hand checks on a real Mac:** the Dock, Finder, the app switcher and the mounted `.dmg` show the
Vimma logo with no grey plate; `brew install --cask vimma-browser/tap/vimma` from a clean
Homebrew; first open per the caveats; `brew upgrade` to the next release.

## Docs and changelog

- `docs/guide.md`, "Install": a macOS section with the one command, the first-open step while
  unsigned, `brew upgrade`, and what `--zap` deletes.
- `README.md`: the install line for macOS, once the release gate opens.
- `docs/runbook.md`, "Releases": the tap, `homebrew.yml`, retrying it with
  `gh workflow run homebrew.yml -f tag=vX.Y.Z`, and rotating the deploy key.
- `docs/security.md`: "Homebrew tap" (above), and the update manifest entries for the macOS
  file (decision 16).
- `docs/guide.md`, "Updates": macOS is checked; the rows for a Homebrew and a `.dmg` install.
- `docs/runbook.md`, "Update signing keys and the update host": the `target` input.
- `CHANGELOG.md`: "Vimma on macOS shows its own icon" with the icon sub-PR; "Install on macOS
  with Homebrew" with the tap sub-PR.
- `macos-build.md`: decision 17 and "Not in this spec" point here.

## Delivery

Each sub-PR is independently mergeable and leaves Linux unchanged. The macOS `.dmg` already
joins a release behind `MACOS_RELEASE_ENABLED` (macos-build, #397 and #398).

1. **`feat(macos): vimma app, document and fallback icons`** (#403). The Icon Composer source,
   `macos-icons.mjs`, the committed `Assets.car`, `firefox.icns` and `document.icns`, the
   regeneration check in `macos.yml`'s `icons` job, and the bundle identifier (decision 15).
2. **`feat(release): publish the homebrew cask to vimma-browser/homebrew-tap`** (#404). The cask
   generator `tools/package/cask.mjs` and its Vitest tests, `tools/package/cask-check.sh`, the
   cask in `release.yml`'s macOS jobs and the `macos-tap` job, `homebrew.yml`, the `cask` job in
   `pkgbuild.yml`, and the guide, runbook and `docs/security.md`. The tap repository, its
   ruleset, deploy key and the `homebrew` environment already exist and are documented in the
   runbook. Runs only while `MACOS_RELEASE_ENABLED` is `true`. Needs sub-PR 1 first, because the
   cask's `uninstall quit:` and `zap` name the bundle identifier it sets.
3. **`feat(updates): update notices on macos`.** Decisions 8 and 16 to 21: the `homebrew` and
   `dmg` install types and their steps in `packages/vimma-core`, `<vimmaDmg>`, the host's
   Caskroom check, the macOS manifest in `tools/update/manifest.mjs` and `update-publish.yml`,
   its start from `release.yml`'s `macos-tap`, and the guide, runbook and `docs/security.md`.
   Closes the feature's issue; sub-PRs 4 and 5 then have issues of their own.
4. **`build(macos): dmg window art`** (#408). Decision 14: `background.png`, `dsstore`, `disk.icns`
   and `MOZ_PACKAGE_EXTRA_ARGS`.
5. **The tap's own CI** (decision 11, #409), in `vimma-browser/homebrew-tap`: `check.yml`, with
   `brew style` and `brew audit --cask --strict` on its pull requests and pushes, and the runbook
   and `docs/security.md`.

## Open questions

1. **Submit to Homebrew/homebrew-cask later?** (a) never: the tap is enough. (b) once notarised
   and notable: `brew install --cask vimma` with no tap, and Homebrew's own CI audits each bump,
   but each release waits for Homebrew's review. **Recommendation: (b)**, keeping the tap until
   the official cask is accepted.
2. **Intel Macs.** (a) none, as macos-build decides: Homebrew 7 already puts Intel at tier 3.
   (b) an x86_64 `.dmg` and `on_intel` in the cask, if macos-build's open question 1 adds one.
   **Recommendation: (a).**
