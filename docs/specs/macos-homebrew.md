# Spec: macos-homebrew

Status: draft · Area: `src/browser/branding/vimma/` (macOS icon files, new),
`configs/branding/vimma/macos/` (icon sources, new), `configs/macos/mozconfig`,
`tools/package/` (cask generator, new), `packages/vimma-core/src/updates.mjs`,
`.github/workflows/release.yml`, `homebrew.yml` (new), `macos.yml`; the
`vimma-browser/homebrew-tap` repository (new); `docs/guide.md`, `docs/security.md`,
`docs/runbook.md`, `README.md` · Upstream patches: none (decision 9) · ADR: none

Issue: [#393](https://github.com/vimma-browser/vimma/issues/393)

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
   in the release's `SHA256SUMS`; the `.dmg` also has a cosign bundle, as every Linux asset does.
4. `brew upgrade --cask vimma` (and a plain `brew upgrade`) installs a newer release; the tap
   receives each release with no step beyond publishing it.
5. `brew uninstall --cask vimma` quits Vimma and removes the app and the `vimma` command;
   profiles, config and caches stay. `brew uninstall --zap --cask vimma` also removes the
   profiles and caches (open question 3).
6. The cask refuses to install on an Intel Mac and on a macOS older than the minimum (decision 6).
7. Before Vimma is notarised, the cask's caveats tell the user how to open it the first time
   (decision 7); after notarisation, it opens like any app.
8. Vimma's update notice, when it runs on macOS, recognises a Homebrew install and suggests
   `brew upgrade --cask vimma` (decision 8).
9. The app icon in the Dock, Finder, Launchpad, the app switcher and Get Info is the Vimma logo,
   rendered at every size from the same artwork as the Linux icons, with no grey plate around
   it. Documents Vimma opens (`.html`, `.pdf`) show a Vimma document icon, and the mounted `.dmg`
   shows a Vimma volume icon.
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
  `appId` `dev.vimma.browser` in `surfer.json`); a release build's is **unverified**.

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
   and known (open question 5).
3. **The documented install command is fully qualified,**
   `brew install --cask vimma-browser/tap/vimma`, so that one command taps the repository and
   trusts only this cask under Homebrew 6's tap trust. Rejected: `brew tap` then `brew install`,
   because it needs a separate `brew trust` step and trusts the whole tap.
4. **The cask installs the release's `.dmg`,** `vimma-V-macos-aarch64.dmg`, from
   `https://github.com/vimma-browser/vimma/releases/download/vV/`, with its SHA-256, so that Mac
   and Linux users get the same version from the same release, with the same notes, checksums
   and cosign bundles. `release.yml` gains a macOS job that adds the `.dmg` to the release, its
   line to `SHA256SUMS` and its `.sigstore.json`, under macos-build's decisions 12 and 13: the job
   exists only once the release gate opens, and a macOS failure must not hold back the Linux
   assets. The name carries Vimma's version only, as the Linux assets do (m6-packaging,
   "Artifacts and names"); macos-build decision 15's two-version name stays for workflow
   artifacts. Releases only: a pre-release gets no cask update, as the AUR gets none.
5. **The cask's contents.** `app "Vimma.app"`; `binary "#{appdir}/Vimma.app/Contents/MacOS/vimma"`
   so that `vimma --version` and the `vimma-ctl` workflow work from a terminal as on Linux;
   `uninstall quit:` with the bundle identifier, so that an uninstall does not delete a running
   app; `zap trash:` with `~/Library/Application Support/Vimma`, `~/Library/Caches/Vimma`, the
   preferences plist and the saved application state of the bundle identifier;
   `livecheck { url :url; strategy :github_latest }` so that `brew livecheck` finds new releases.
   No `preflight` or `postflight` block, because Homebrew 7 deprecates them and nothing needs one.
   `~/.config/vimma/` is not zapped, because it is the user's config and often a dotfiles symlink.
6. **Apple Silicon, macOS 15 or later.** `depends_on arch: :arm64`, because macos-build builds
   arm64 only (its decision 3); `depends_on macos: ">= :sequoia"`, because the release is tested
   on `macos-15` runners and Homebrew 7 moved macOS 14 to tier 3. Firefox's own minimum
   (`LSMinimumSystemVersion` 10.15.0, `browser/app/macbuild/Contents/Info.plist.in:257-258`) is
   lower, but an untested version is not offered.
7. **`auto_updates false`, and unsigned builds wait for the release gate.** Vimma has no macOS
   updater (macos-build decision 16), so Homebrew is the updater, and `brew upgrade` must replace
   the app. Before a Developer ID exists, the app is ad hoc signed and quarantined on download, so
   macOS refuses the first open; the cask's `caveats` explain Open Anyway in System Settings →
   Privacy & Security, and say nothing about `xattr` or `--no-quarantine`, which Homebrew
   deprecates as a circumvention. Whether the tap is published before notarisation is open
   question 1. When the macOS updater ships for signed builds, the cask switches to
   `auto_updates true`, as `zen` and `firefox` do, so that Homebrew and the updater do not fight.
8. **A Homebrew install is recognised by the Caskroom, not by a marker in the app.** The update
   check reports `homebrew` when the running app is `/Applications/Vimma.app` and
   `/opt/homebrew/Caskroom/vimma/` exists, and `updateSteps` gives `brew upgrade --cask vimma`.
   A `vimma-package=homebrew` marker inside the bundle was rejected, because the same `.dmg`
   serves the download and the cask, and writing into a signed bundle after the build breaks its
   signature. The check is in `packages/vimma-core` as a pure function of the two facts, so it is
   tested in Vitest and cannot change a Linux result: on Linux neither path exists.

### Tap updates

9. **The cask is a release asset, and `homebrew.yml` pushes it,** as the `PKGBUILD` and
   `aur.yml` do, so that Mac users get a security release without a person and the tap only
   ever receives a file the signed release contains. `release.yml`'s macOS job renders
   `vimma.rb` with `tools/package/` from the `.dmg`'s SHA-256, checks it with `brew style` and
   `brew audit --cask --strict` on `macos-15`, and adds it to `SHA256SUMS` and the signatures.
   `homebrew.yml` runs on `release: published` and on `workflow_dispatch` with a tag, checks the
   tag is `vX.Y.Z`, fetches the published `vimma.rb`, checks it against `SHA256SUMS` and
   `SHA256SUMS` against `release.yml`'s signature, and pushes it to the tap as `Casks/vimma.rb`.
   It runs nothing from the repository, and it is its own workflow, so a tap failure cannot fail
   the release. Rejected: rendering the cask in `homebrew.yml`, because the job holding the
   tap's key would then run repository code; a step in `release.yml`, because it would put the
   tap's key in the build job.
10. **The tap's credential is a deploy key held by a `homebrew` environment,** limited to `main`
    and `v*` tags as `aur` is, so that only a released tag on `main` can write to the tap, and a
    missing key skips the job instead of failing it. Rejected: a personal access token, because a
    deploy key reaches only the one repository. The tap repository's branch rules allow pushes by
    the deploy key and pull requests by others.
11. **The tap holds only generated files and a README,** so that every cask change is visible in
    this repository's review, and the tap cannot drift from the generator. The tap's own CI runs
    `brew style` and `brew audit` on pull requests.

### Icon parity

12. **The macOS icon comes from the Linux artwork.** `configs/branding/vimma/macos/` holds an
    `AppIcon` asset catalog (`Vimma.xcassets`) whose images are generated from `logo-mac.png`,
    which is byte-identical to `logo.png`, so that every platform shows the same logo. A test
    fails if `logo-mac.png` and `logo.png` differ.
13. **A compiled `Assets.car` is committed to `src/browser/branding/vimma/`,** with
    `document.icns` and `disk.icns`, because Surfer's `src/` overlay replaces the unofficial
    copies after the branding step (Research) and the Linux cross-build cannot run `actool`.
    `tools/package/macos-icons.mjs` regenerates all three on a Mac with Xcode, and a `macos.yml`
    job regenerates them and fails if they differ from the committed files, so the binaries
    cannot drift from their source. The files are inputs of cocoa builds only
    (`browser/app/moz.build:45`), so Linux builds and packages are unchanged. This supersedes
    macos-build decision 17's committed `firefox.icns`, which Surfer already generates on a Mac
    and which macOS ignores while `Assets.car` provides `AppIcon`; the committed `.icns` stays as
    the fallback for systems that read it. Rejected: compiling `Assets.car` during every build,
    because the release build runs on Linux; patching `Info.plist.in` to drop `CFBundleIconName`,
    because macOS 26 and later then draw the icon on a grey plate.
14. **The `.dmg` has a Vimma window.** `background.png` (from the Vimma artwork, the app on the
    left, an arrow to `/Applications` on the right), its `dsstore`, and the volume icon
    `disk.icns`, passed to `mach package` through `MOZ_PACKAGE_EXTRA_ARGS` in
    `configs/macos/mozconfig`, so that the mounted image looks like Vimma rather than a bare
    Firefox volume. If `MOZ_PACKAGE_EXTRA_ARGS` cannot be set from a mozconfig (**unverified**),
    the release job runs `package.py`'s DMG step itself with these arguments; no upstream patch is
    needed either way.

### Not in this spec

Submitting to Homebrew/homebrew-cask (open question 5); Developer ID signing and notarisation
(macos-build sub-PR 6); the macOS updater (macos-build decision 16); Intel builds; a formula for
`vimma-ctl` alone (it ships inside the app); MacPorts and Nix.

## Security and privacy

- **Supply chain.** The cask pins the `.dmg`'s SHA-256 and is itself a signed release asset;
  `homebrew.yml` pushes it only after checking it against `SHA256SUMS` and `SHA256SUMS` against
  `release.yml`'s signature at `refs/heads/main`, so a tap commit cannot point at a file the
  release did not build.
  `docs/security.md` gets a "Homebrew tap" entry covering this, the deploy key and its
  environment, and a test link for each claim (`npm run security-links`).
- **The tap's write credential** is a deploy key scoped to one repository, held by an environment
  restricted to `main` and `v*` tags, and used only in `homebrew.yml`, whose permissions are
  empty; the key is never printed and is removed from the runner after the push. A stolen key
  can change the tap but not the release, and Homebrew still checks the pinned SHA-256 against
  the GitHub download.
- **Gatekeeper.** The caveats never tell a user to remove quarantine or disable Gatekeeper; they
  point to the per-app Open Anyway that macOS offers. A notarised build needs no caveat.
- **Tap trust.** The documented command trusts one cask, not the whole tap.
- **Icons.** The committed `Assets.car`, `.icns` and DMG files are binaries in the tree; the
  regeneration check in `macos.yml` makes them reproducible from the committed sources, so a
  changed binary without a changed source fails CI.
- **Uninstall.** `zap` removes the profile directory, which holds history, cookies and saved
  passwords; it runs only with `--zap`, which the user types, and the guide says so.

This change touches a workflow with a secret and the release, so it gets a review by a fresh
agent before merging.

## Tests

**Vitest (`tools/package/test/`, `packages/vimma-core/test/`):**

- `cask names the release dmg for the tag and pins its sha256 from SHA256SUMS`
- `cask refuses a tag that is not vX.Y.Z and a pre-release`
- `cask declares arm64, the minimum macOS, auto_updates false, the vimma binary and no flight blocks`
- `cask zaps Application Support, Caches, the plist and saved state, and not ~/.config/vimma`
- `cask caveats mention Open Anyway and not xattr or --no-quarantine` (while unsigned)
- `installTypeFrom reports homebrew for /Applications/Vimma.app with a vimma Caskroom`
- `installTypeFrom ignores a Caskroom on Linux paths` (Linux types unchanged)
- `updateSteps for homebrew is brew upgrade --cask vimma`
- `homebrew.yml runs on release and dispatch, verifies the cask against the signed SHA256SUMS
before pushing, runs no repository code, and holds the key only in the homebrew environment`
  (workflow wiring, as `release-workflow.test.mjs` does for `aur.yml`)
- `logo-mac.png is byte-identical to logo.png`
- `the macOS icon files exist in src/browser/branding/vimma and nowhere in the Linux package
inputs`

**macOS CI (`macos.yml`, `macos-15`):**

- The icon files regenerate from `configs/branding/vimma/macos/` to the committed bytes.
- `assetutil --info` on the built app's `Assets.car` lists `AppIcon` and no `unofficial` asset.
- The rendered app icon (`NSWorkspace iconForFile:`) matches a reference rendered from
  `logo-mac.png` within a tolerance, and is not the unofficial globe.
- `brew style` and `brew audit --cask --strict` pass on the generated cask; `brew install --cask`
  from a local tap with the workflow's `.dmg` installs, `vimma --version` prints the expected
  line, `brew uninstall --zap --cask vimma` removes the app and the zap paths.

**Hand checks on a real Mac:** the Dock, Finder, the app switcher and the mounted `.dmg` show the
Vimma logo with no grey plate; `brew install --cask vimma-browser/tap/vimma` from a clean
Homebrew; first open per the caveats; `brew upgrade` to the next release.

## Docs and changelog

- `docs/guide.md`, "Install": a macOS section with the one command, the first-open step while
  unsigned, `brew upgrade`, and what `--zap` deletes.
- `README.md`: the install line for macOS, once the release gate opens.
- `docs/runbook.md`, "Releases": the tap, `homebrew.yml`, retrying it with
  `gh workflow run homebrew.yml -f tag=vX.Y.Z`, and rotating the deploy key.
- `docs/security.md`: "Homebrew tap" (above).
- `CHANGELOG.md`: "Vimma on macOS shows its own icon" with the icon sub-PR; "Install on macOS
  with Homebrew" with the tap sub-PR.
- `macos-build.md`: decision 17 and "Not in this spec" point here.

## Delivery

Each sub-PR is independently mergeable and leaves Linux unchanged.

1. **`feat(macos): vimma app, document and disk icons`.** The asset catalog source,
   `macos-icons.mjs`, the committed `Assets.car`, `document.icns` and `disk.icns`, the
   regeneration and `assetutil` checks in `macos.yml`, and the `logo-mac.png` test. Can merge
   before macos-build sub-PR 3: the artifact build on a Mac already shows the icon.
2. **`build(macos): dmg window art`.** `background.png`, `dsstore`, `MOZ_PACKAGE_EXTRA_ARGS`.
   After macos-build sub-PR 3 (the cross-built `.dmg`).
3. **`feat(package): homebrew cask generator`.** `tools/package/` cask rendering and its Vitest
   tests, and the `homebrew` install type. No workflow, no publication.
4. **Gated: `ci(release): macos dmg and the homebrew tap`.** The `release.yml` macOS job,
   `homebrew.yml`, the tap repository, its deploy key and environment, `docs/security.md`, the
   guide and the runbook. Only after the release gate opens (macos-build decision 12) and open
   question 1 is answered. Closes the feature's issue.

## Open questions

1. **Publish the tap before notarisation?** (a) yes, with the Open Anyway caveat: Mac users can
   try Vimma as soon as the gate opens, but the first open needs a trip to System Settings, and
   each update may ask again (**unverified** for an ad hoc signed app replaced in place).
   (b) only once Vimma is notarised (macos-build sub-PR 6): a clean first impression, a yearly
   Developer ID cost before the first Mac user. **Recommendation: (b)** for the public
   announcement, with (a) as an unannounced tap for testers, because a browser that macOS calls
   unverifiable is a poor first impression.
2. **Tap repository name.** (a) `vimma-browser/homebrew-tap`, command
   `vimma-browser/tap/vimma`: the common convention, room for `vimma-ctl` or nightlies later.
   (b) `vimma-browser/homebrew-vimma`, command `vimma-browser/vimma/vimma`: names the project
   but repeats it. **Recommendation: (a).**
3. **What does `--zap` remove?** (a) the profiles, caches, plist and saved state, as `zen` and
   `firefox` do: what users expect from `--zap`. (b) caches and state only, keeping profiles:
   safer, but `--zap` would then leave the largest data behind. **Recommendation: (a)**, with the
   guide stating it; `~/.config/vimma/` is never zapped (decision 5).
4. **The release bundle identifier.** (a) keep Surfer's `org.mozilla.dev.vimma.browser`: no
   change, but it carries "mozilla" and "dev". (b) set `MOZ_MACBUNDLE_ID` so the identifier is
   `dev.vimma.browser`: clean, matches `appId`, but changes where macOS stores preferences and
   state, so it must be fixed before the first public build. **Recommendation: (b)**, decided
   before sub-PR 4 because the cask's `uninstall quit:` and `zap` depend on it.
5. **Submit to Homebrew/homebrew-cask later?** (a) never: the tap is enough. (b) once notarised
   and notable: `brew install --cask vimma` with no tap, and Homebrew's own CI audits each bump,
   but each release waits for Homebrew's review. **Recommendation: (b)**, keeping the tap until
   the official cask is accepted.
6. **Intel Macs.** (a) none, as macos-build decides: Homebrew 7 already puts Intel at tier 3.
   (b) an x86_64 `.dmg` and `on_intel` in the cask, if macos-build's open question 1 adds one.
   **Recommendation: (a).**
