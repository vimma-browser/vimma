# Spec: m6a-updater

Status: accepted (sub-PR 1, sub-PR 3's AppImage replacement, urgent restart question, `:restart` and `updates: off` notice, and sub-PR 4's release manifest implemented; Firefox's updater for tarball installs, that is sub-PRs 2 and 5, the rest of sub-PR 3 and sub-PR 4's MAR and nightly parts, tracked in [#456](https://github.com/vimma-browser/vimma/issues/456)) · Area: `configs/common/mozconfig`, `src/browser/branding/vimma/pref/firefox-branding.js`,
`src/browser/base/content/vimma/updates/` (new), `packages/vimma-core/src/updates.mjs` (new),
`packages/vimma-core/src/update-keys.mjs` (new), `vimma/about/`,
`config.mjs`, `actions.mjs`, `cmdline.mjs`, `statusbar.mjs`, `tools/package/`, `tools/update/`
(new), `.github/workflows/{release,nightly}.yml`, `update-publish.yml` (new),
`tests/browser/`, `tests/e2e/`, and the repository that serves the manifest
(`vimma-browser/vimma-updates`, new; decision 18) ·
Upstream patches: `src/browser/moz-configure.patch` (existing, grows: "1 hunk, 6 lines:
`MOZ_APPUPDATE_HOST` is `updates.vimma.dev` (m6a-updater)"), `src/toolkit/mozapps/update/updater/moz-build.patch`
(new: "1 hunk, 6 lines: channel `vimma` embeds Vimma's update certificates (m6a-updater)"),
`src/toolkit/mozapps/update/UpdateService-sys-mjs.patch` (new: "2 hunks, 10 lines: Vimma verifies
the update manifest before Firefox parses it (m6a-updater)") · ADR: ADR-016 (new, "Vimma's own
update channel"; the number is free on `main` and reserved for this spec), ADR-003 (three register
lines), ADR-010 (the artifact-build gap, unchanged)

Issues: [#217](https://github.com/vimma-browser/vimma/issues/217) (delivered parts),
[#456](https://github.com/vimma-browser/vimma/issues/456) (Firefox's updater for tarball installs)

Prerequisites: m0-updater (whose `--disable-updater` this reverses for release and nightly
builds), m6-packaging (the artifacts), build-supply-chain delivery 4
([#224](https://github.com/vimma-browser/vimma/issues/224), the full builds on GitHub-hosted
runners), m7-upstream-autopilot (the security bump PRs), upstream-bump-automation
([#259](https://github.com/vimma-browser/vimma/issues/259), which merges a green bump by itself)
and firefox-versions (the version line and the release half of the security path).

Engine paths are relative to `engine/` and were checked against Firefox 158.0 (`surfer.json`
`version.version`, `config/milestone.txt`); every cited line was re-read on 2026-10-15. Zen
references are from `zen-browser/desktop` (branch `dev`) and `zen-browser/updates-server` on
GitHub, read on 2026-10-11.

## Summary

Vimma installs keep themselves current the way Firefox does. Release and nightly builds turn
Firefox's own updater back on and point it at a static, signed manifest on updates.vimma.dev; the updater
applies complete MARs signed with Vimma's own key, never Mozilla's server. The AppImage replaces
its own file; `.deb` and AUR installs get a status-bar hint. A release that carries a Firefox
security fix is marked urgent and reaches installs with no person in the pipeline, and Vimma never
restarts on its own.

## Problem

- Vimma has no updater. `configs/common/mozconfig` builds with `--disable-updater` (m0-updater),
  so an install stays on the Firefox it shipped with until its owner downloads a new release by
  hand. A Firefox security fix that `main` carries within the deadline `docs/security.md` G2 sets
  (3 days after a security dot release, 7 after a major) does not reach anyone who installed
  earlier.
- Turning the updater back on as Firefox ships it is unsafe for Vimma: a build on the `vimma`
  channel embeds Mozilla's test-signing certificates (Research, "Which certificates"), and the URL
  points at Mozilla's `aus5.mozilla.org`.
- Firefox's update manifest is not authenticated, and Firefox's own checks let an older signed
  Vimma on the same Firefox version through (Research, "What the design must add").
- The AppImage cannot be updated by Firefox's updater (its install directory is a read-only
  squashfs mount), and `.deb` and AUR installs belong to their package managers.
- The release pipeline stops for a person twice on the way from a Firefox security release to a
  Vimma release: merging the bump PR and merging the release PR. Spec upstream-bump-automation
  removes the first stop and spec firefox-versions the second; this spec carries the release
  from GitHub to installed copies.

## Behaviour

1. **Tarball.** As a Vimma user who installed the tarball in a directory I can write, Vimma
   checks updates.vimma.dev every 12 hours, downloads a signed update in the background, and
   applies it the next time I start Vimma, with my workspaces, tabs, panes and scroll positions
   intact. No request goes to Mozilla's update server.
2. **Read-only tarball.** If the install directory is not writable, the status bar says an update
   exists and `:update` explains that the owner of the directory has to update it.
3. **AppImage** (decision 19). Vimma downloads the new AppImage next to the running one,
   checks it against the signed manifest and renames it over the old file; the next start runs
   the new version under the same path.
4. **`.deb`, the release PKGBUILD and AUR.** Vimma never touches the installed files. The
   status bar shows `⇡ <version> available`, and `:update` shows how to update: download the new
   `.deb` from the release page, run `curl -fLO
https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si` again
   for a `vimma-bin` built from the release's PKGBUILD (decision 24), or update `vimma-bin` with
   an AUR helper.
5. **Notices.** The status bar's right side shows the states in Design §5: `⇡ 0.3.1 on restart`
   once an update is staged, `⇡ 0.3.1 security: :restart` in `--vimma-text-error` for an urgent
   one, `updates: check failed` after three failed checks, `updates: no news for N days` for a
   stale feed, `updates: off` when checks are off.
6. **Urgent prompt.** Once per session, at the next idle moment in normal mode, an urgent staged
   update asks in the command line `Security update 0.3.1 is ready. Restart now? Tabs come back.
(y/N)`. `y` restarts; any other key dismisses it until the next session or for 24 hours. When
   the private workspace has tabs, the question adds `Private tabs will close.` before `(y/N)`.
7. **Never an automatic restart.** Vimma restarts only on `:restart`, `y` in the urgent prompt, or
   Firefox's own "Restart to update" button.
8. **Commands.** `:update` (action `app.update_check`) checks now and reports the result in the
   command line: up to date, offered, staged, failed (with the reason), or off. `:restart` (action
   `app.restart`) restarts through Firefox's restart path. Both are bindable, have no default key,
   and appear in `ctrl+b ?` and `docs/bindings.md` like every action.
9. **about:vimma.** The Version section adds the install type, channel, last check and its result,
   the offered update as a version line (`Vimma 0.3.1 · Firefox 158.0.1`, spec firefox-versions),
   its urgency, the manifest serial and the key that signed it.
10. **Off switch.** `config.toml` `[updates] check = false` (or the pref `vimma.update.enabled` =
    `false`) stops every update request; the status bar shows `updates: off` once per session.
    (Since changed: for a few seconds after startup, then it hides; decision 38.)
11. **Refusals.** An unsigned or wrongly signed manifest, a manifest for another channel or
    target, an older manifest than one already accepted, and an offer of an older or equal build
    are refused; no update is downloaded. The reason is shown in about:vimma.
12. **Pipeline.** Publishing a release builds, signs and publishes its MAR and the manifest with
    no manual step; the nightly does the same for the nightly channel. A green security bump PR
    merges itself under spec upstream-bump-automation, and spec firefox-versions releases it.

## Research

### How Firefox finds, checks and applies an update (Firefox 158.0)

- **URL.** `CheckerService.getUpdateURL` (`toolkit/mozapps/update/UpdateService.sys.mjs:5493`)
  reads `Services.appinfo.updateURL` (line 5500), which is `[AppUpdate] URL` in `application.ini`
  (`toolkit/xre/CreateAppData.cpp:69`), then the `AppUpdateURL` policy if any (line 5506), and
  fills it with `UpdateUtils.formatUpdateURL` (line 5523; `toolkit/modules/UpdateUtils.sys.mjs:72`).
  The template is fixed in `build/application.ini.in:54-55`:
  `https://@MOZ_APPUPDATE_HOST@/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml`, and
  `build/moz.build:95-97` substitutes `aus5.mozilla.org` unless `CONFIG["MOZ_APPUPDATE_HOST"]` is
  set. No configure option sets it (m0-updater); Surfer's `export MOZ_APPUPDATE_HOST=localhost:7648`
  in the generated `engine/mozconfig` never reaches it. There is no `app.update.url` pref
  (`browser/app/profile/firefox.js:161`: "removed in Bug 1568994").
- **Channel.** `%CHANNEL%` is the default-branch pref `app.update.channel`
  (`UpdateUtils.getUpdateChannel`, `UpdateUtils.sys.mjs:36`), which ships in
  `defaults/pref/channel-prefs.js` in the install directory (`browser/app/profile/channel-prefs.js:9`,
  `@MOZ_UPDATE_CHANNEL@`). Surfer configures `--enable-update-channel=vimma` and
  `MAR_CHANNEL_ID=ACCEPTED_MAR_CHANNEL_IDS=vimma`. `%BUILD_TARGET%` is `Linux_x86_64-gcc3`.
  Measured in m0-updater: `…/updates/browser/Linux_x86_64-gcc3/vimma/update.xml`.
- **The request** (`#updateCheck`, line 5628): an `XMLHttpRequest` from the system principal,
  `LOAD_BYPASS_CACHE` and `INHIBIT_CACHING` (lines 5648-5650), `beConservative` (line 5653),
  `Cache-Control: no-cache` and `Pragma: no-cache` (lines 5660-5663), sent at line 5698. `force=1`
  is appended for a foreground check (line 5526); `mig64=1` only on Windows (`#getCanMigrate`,
  line 5411). Vimma's URL template uses only `%BUILD_TARGET%` and `%CHANNEL%`, so the request
  carries no version, build ID, locale or identifier. The request does not set `LOAD_ANONYMOUS`,
  so cookies the profile holds for the update host would be sent.
- **Parsing** (lines 5756-5770): `#parseUpdates(request)` (line 5854) runs inside a `try`; any
  exception ends the check as `#getCheckFailedObject(status, 200, request)`, the result for a
  malformed XML.
- **Selection** (`#selectUpdate`, line 3792; line 3812): an `<update>` is skipped when
  `updateIsAtLeastAsOldAs` (lines 1955-1964) holds: `appVersion` lower than
  `Services.appinfo.version` by `Services.vc.compare`, **or equal with the same `buildID`**. An
  equal `appVersion` with any other build ID, older included, is offered.
- **XML format** (`class Update`, line 2320; `#parseUpdates`): `<updates><update type appVersion
displayVersion buildID platformVersion detailsURL …><patch type="complete" URL hashFunction
hashValue size/></update></updates>`. Unknown attributes are kept in the property bag; unknown
  child elements are skipped; comments are ignored.
- **Download** (`class Downloader`, line 5942; `netwerk/base/nsIncrementalDownload.cpp:138`,
  `mLoadFlags{LOAD_NORMAL}`): a system-principal channel with normal load flags, so cookies for the
  MAR host are sent. The file's `hashValue` is checked; it is then staged in the background
  (`app.update.staging.enabled` true, `firefox.js:158`) and swapped in at the next start.
- **The updater** (`toolkit/mozapps/update/updater/`) checks, before touching a file:
  - the MAR signature, RSA PKCS#1 v1.5 with SHA-384 (`modules/libmar/sign/mar_sign.c:92`,
    `modules/libmar/verify/cryptox.c:66`), against `primaryCert.h` **or** `secondaryCert.h`
    (`ArchiveReader::VerifySignature`, `archivereader.cpp:73-91`); one valid signature is enough,
    and a MAR may carry up to 8 (`MAX_SIGNATURES`, `modules/libmar/src/mar.h:22`);
  - the MAR's channel ID against `ACCEPTED_MAR_CHANNEL_IDS` in `update-settings.ini` in the
    install directory (`PopulategMARStrings`, `updater.cpp:3344`; called at line 3391), else
    `MAR_CHANNEL_MISMATCH_ERROR` (22; `archivereader.cpp:141`);
  - the MAR's product version against the updater's compiled `MOZ_APP_VERSION`
    (`updater.cpp:3393-3394`): older is `VERSION_DOWNGRADE_ERROR` (23), **equal passes**
    (`VerifyProductInformation`, `archivereader.cpp:119-170`, the comparison at lines 162-165).
    For Vimma that version is Firefox's (spec m0-app-version), so the updater blocks going back to
    an older Firefox but not to an older Vimma on the same Firefox;
  - a bad signature is `CERT_VERIFY_ERROR` (19). The three codes are defined in
    `toolkit/mozapps/update/common/updatererrors.h:42-46`.
- **Which certificates.** `toolkit/mozapps/update/updater/moz.build:110-128` picks the DER files by
  `MOZ_UPDATE_CHANNEL`: `beta`/`release`/`esr` → Mozilla's release keys, `nightly*` → Mozilla's
  nightly keys, anything else (Vimma's `vimma`) → `dep1.der`/`dep2.der`, Mozilla's test-signing
  keys. `gen_cert_header.py` turns them into byte arrays. There is no certificate chain, expiry or
  revocation: the updater trusts exactly the embedded public keys. The test updater
  (`updater-xpcshell/`, `TEST_UPDATER`, `updater-xpcshell/moz.build:14`) embeds
  `xpcshellCertificate.der` (`moz.build:132`), whose private key is in
  `modules/libmar/tests/unit/data` (`cert9.db`/`key4.db`, nickname `mycert`, `moz.build:97-99`);
  Mozilla's browser update tests copy that updater over `updater` (`copyTestUpdater`,
  `toolkit/mozapps/update/tests/browser/head.js:362`).
- **Making MARs.** `./mach repackage mar --input <tarball> --mar <host mar> --output <file>
--arch x86_64 --mar-channel-id vimma` (`repackage_mar`,
  `python/mozbuild/mozbuild/repackaging/mar.py:29`) runs
  `tools/update-packaging/make_full_update.sh` with `MOZ_PRODUCT_VERSION` from the tarball's
  `application.ini` (lines 60-65). The host `mar` is built with `NO_SIGN_VERIFY`
  (`modules/libmar/tool/moz.build:21`); signing is `signmar` (links NSS):
  `signmar -d <nssdb> -n <nickname> -s in out`, and `-X`/`-I` extract and import a detached
  signature. Partial MARs (`make_incremental_update.sh`, zucchini) need the previous build.
- **Channel files survive updates.** `tools/update-packaging/common.sh:95-112` and
  `make_incremental_zucchini.py:266,285` write `channel-prefs.js` and `update-settings.ini` as
  `add-if-not`: an update never changes an installed copy's channel.
- **Turning the updater off for a package.** `updateDisabled`
  (`toolkit/mozapps/update/UpdateServiceStub.sys.mjs:210-216`) is true when the `appUpdate` policy
  forbids it; when `app.update.disabledForTesting` is set and the process is in automation or
  driven by Marionette or the Remote Agent (lines 198-205); or when
  `Services.sysinfo.getProperty("isPackagedApp")` is true. On Linux that is Snap/Flatpak or a file
  named `is-packaged-app` in the GRE directory (`IsPackagedAppFileExists`,
  `widget/gtk/WidgetUtilsGtk.cpp:253-275`; `xpcom/base/nsSystemInfo.cpp:1760-1761`). Mozilla's own
  `.deb` and `.rpm` repackaging writes exactly that file
  (`python/mozbuild/mozbuild/repackaging/deb.py:126`, `rpm.py:99`). With it, the About dialog and
  Settings hide the updater (`AppUpdater.#updateDisabledByPackage`,
  `toolkit/mozapps/update/AppUpdater.sys.mjs:253,423`); no request is made, no policy banner is
  shown and no patch is needed.
- **Installs Vimma cannot write.** `getCanApplyUpdates` (`UpdateService.sys.mjs:702`) tests write
  access to the update directory and `isAppBaseDirWritable` (line 656) to the install directory;
  without it the service still checks but offers a manual download (`app.update.url.manual`). An
  AppImage's install directory is the read-only squashfs mount, so Firefox's updater can never
  apply there.
- **What the user sees.** `toolkit/mozapps/update/UpdateListener.sys.mjs` badges the app menu
  after `app.update.badgeWaitTime` (line 69; Vimma's is 0) and shows a "Restart to update"
  doorhanger after `app.update.promptWaitTime` (Vimma's is 24 h); restarting is
  `quit-application-requested` and `Services.startup.quit(eAttemptQuit | eRestart)` (lines
  160-173). Firefox restarts by itself with no windows open only on macOS
  (`app.update.noWindowAutoRestart.enabled` under `#ifdef XP_MACOSX`, `firefox.js:205-211`); on
  Linux it never restarts by itself.
- **Timers.** `app.update.interval` is 86400 s in Vimma's `firefox-branding.js` (line 21);
  Mozilla's release branding uses 43200. `app.update.timerFirstInterval` is 30 s
  (`firefox.js:102`); BrowserGlue's old-build check runs after `app.update.checkInstallTime.days`
  (2 in Vimma's branding; `browser/components/BrowserGlue.sys.mjs:432-450`). No pref stops checks
  other than the interval; the enterprise policy `DisableAppUpdate` does, with the "managed by your
  organization" banner m0-updater rejected.
- **WebCrypto in chrome modules.** `crypto.subtle` is available in `.sys.mjs` modules:
  `browser/components/backup/ArchiveEncryption.sys.mjs` imports a key (line 469) and verifies a
  signature (line 498). Vimma can verify an RSA PKCS#1 v1.5 SHA-384 signature with the public key
  the updater embeds.
- **`Cu.isInAutomation`** is true only when the process started with
  `MOZ_DISABLE_NONLOCAL_CONNECTIONS=1` and the pref
  `security.turn_off_all_security_so_that_viruses_can_take_over_this_computer` is set
  (`js/xpconnect/src/nsXPConnect.cpp:1211,1230`). It lets a test key be honoured without being a
  switch any user has.
- **Test hooks.** Mozilla's update tests swap the URL with `setUpdateURL`
  (`toolkit/mozapps/update/tests/data/shared.js:274`), so a mochitest needs no policy.

### Prior art

- **Zen** (`zen-browser/updates-server`, GitHub Pages at `updates.zen-browser.app`): one static
  `updates/browser/<target>/<channel>/update.xml` per target and channel (`release`, `twilight`),
  committed by a bot on each release. The Linux file is one `<update type="minor"
appVersion="1.23.2b" buildID=…>` with one complete MAR from the GitHub Release (114 MB). Zen's
  `appVersion` is its own version because its `appinfo.version` is; Vimma's is Firefox's.
- **Zen's signing** (`scripts/mar_sign.sh`): one RSA-4096 key and a self-signed certificate, kept
  base64-encoded in GitHub Actions secrets and imported into an NSS DB at release time; the public
  DER is copied over `release_primary.der`, `release_secondary.der`, `dep1.der`, `dep2.der` and
  `xpcshellCertificate.der`. No secondary key, no rotation. Zen also patches
  `updater-common.build` to add `-Wl,-rpath=$ORIGIN` on Linux so the updater finds NSS next to it
  (`src/toolkit/mozapps/update/updater/updater-common-build.patch`); Firefox 158.0's
  `updater-common.build` sets an rpath only for macOS (lines 31 and 107).
- **Zen's AppImage** is not updated by the browser: its install script (`appimage.sh`) uses
  `zsync` against a published `.zsync` file. LibreWolf compiles the updater out (m0-updater).
  Mozilla's `.deb` uses `is-packaged-app` and its apt repository.
- **AppImage tools.** AppImageUpdate reads update information embedded in the image
  (`gh-releases-zsync|owner|repo|latest|*.AppImage.zsync`) and needs a separate tool or
  AppImageLauncher run by the user; nothing in the browser.

### Vimma today

- `configs/common/mozconfig` has `--disable-updater` (line 44, m0-updater); the artifact build
  keeps Mozilla's prebuilt updater and aus5 URL (ADR-010 gap). `firefox-branding.js` already sets
  `app.update.interval`, `promptWaitTime`, `badgeWaitTime` 0, `url.manual`, `url.details` and
  `checkInstallTime.days`.
- `release.yml`'s `build` job (line 45) and `nightly.yml` (line 26) name
  `[self-hosted, linux, x64, vimma-build]`, but no self-hosted runner is registered and none is
  planned. The [build-supply-chain](build-supply-chain.md) spec (accepted) moves both full builds
  to GitHub-hosted runners in its delivery 4,
  [#224](https://github.com/vimma-browser/vimma/issues/224) (open), puts the Safe Browsing key in
  a `build` environment, and adds a test that no workflow job names a self-hosted runner. Until
  then neither workflow can run a full build, and m6-packaging's status line says its tooling is
  gated off for that reason. `release.yml`'s `sign` (cosign keyless, the only `id-token: write`) and
  `publish` (the only `contents: write`) already run on `ubuntu-24.04`. `nightly.yml` builds,
  tests and publishes the rolling `nightly` release in one job with `contents: write`.
- `upstream.yml` (m7) opens the bump PR, a draft unless every patch applies, the suites passed and
  `UPSTREAM_PR_TOKEN` is set. Spec upstream-bump-automation (draft, #259) sets a green bump to
  auto-merge when the repository variable `AUTO_MERGE_UPSTREAM` allows its release kind (`dot`
  for dot releases, `all` for majors too; unset by default) and only the expected lines changed;
  a bump whose patches had to be re-exported always waits for a person (its Behaviour 5 and 6, and
  its decisions 10 and 15). A bump for a Firefox release with an advisory, or whose advisories
  could not be read, carries the labels `upstream` and `security` (`tools/upstream/detect.mjs:87`,
  G3: unknown counts as security), and its subject lists the advisories, `upstream: firefox 158.0
(MFSA 2026-106)` (firefox-versions decision 9).
- Spec firefox-versions (merged) owns the release half of the security path: with
  `AUTO_SECURITY_RELEASE` on, a merged security bump sets the open release PR to auto-merge, and
  the release carries whatever is on `main` (its decisions 11 to 17). Releases are titled
  `Vimma <vimma> · Firefox <firefox>`, the changelog heading is
  `## [<vimma>](<compare>) · Firefox <firefox> (<date>)`, and `tools/release/version-line.mjs`
  writes the version line.
- Releases are drafts until the maintainer has daily-driven Vimma (the release gate, spec
  release-versioning); `release.yml` runs on `release: published` only, so it does not run for a
  draft. The rolling `nightly` release is a public prerelease (`nightly.yml`, `gh release create
nightly --prerelease`), and its schedule does nothing until the repository variable
  `NIGHTLY_ENABLED` is `true`.
- `vimma-site` deploys `main` to vimma.dev via Cloudflare Workers Builds in one or two minutes;
  `static/` is copied to the site root as is and skipped by the site checks. A push to `main`
  deploys whether or not the repository's GitHub checks pass: Cloudflare does not wait for CI
  (vimma-site `README.md`, "Deploying", at `44e8f90`). The repository's ruleset `main` requires a
  pull request and status checks and has no bypass actor (read through the GitHub rulesets API on
  2026-10-15), so no key can push to `main` directly today. vimma.dev is public: no Cloudflare
  Access rule sits in front of it (`curl -I https://vimma.dev/` answers 200).

### What the design must add

1. **Firefox's update XML is not authenticated.** TLS protects it in transit, but whoever
   controls the update host (the Cloudflare account, a push to the repository it serves) can
   serve any XML. The MAR
   signature stops them from running their own code. It does not stop a rollback: an older
   **signed** Vimma on the same Firefox version passes both Firefox's selection (equal
   `appVersion`, different `buildID`) and the updater (equal product version). Nor does it stop a
   freeze (serving the old XML forever). Vimma therefore signs the XML and checks it itself
   (Design §4).
2. **`appVersion` must be Firefox's version.** Selection compares it to
   `Services.appinfo.version`, which is Firefox's (m0-app-version), and the MAR's product version
   must not be below the updater's `MOZ_APP_VERSION`, also Firefox's. A Vimma-only release on the
   same Firefox is newer only by build ID. `displayVersion` carries Vimma's version for the UI.
3. **A `vimma` channel build trusts Mozilla's test keys today.** Re-enabling the updater without
   changing `moz.build` would embed `dep1.der`/`dep2.der`. The certificate choice must be Vimma's
   before the first updater-enabled build ships.
4. **A `.deb` from a GitHub Release is not updated by apt.** There is no Vimma apt repository, so
   the hint says "download the new `.deb`" (decision 20). The AUR package is
   updated by the user's AUR helper.
5. **The MAR download sends GitHub cookies.** The `<patch URL>` is
   `github.com/…/releases/download/…`, which redirects to a signed, expiring asset URL; the
   system-principal download sends the profile's `github.com` cookies on the first hop. Vimma
   strips them (decision 1).
6. **A security fix without a manual step needs the bump PR merged automatically.** Spec
   firefox-versions merges the release PR and spec upstream-bump-automation the bump PR. A bump
   whose patches had to be re-exported still waits for a person (that spec's decision 15), so the
   "no person in the pipeline" promise holds for bumps whose patches apply as they are; this spec
   does not add a second auto-merge rule (decision 3).
7. **Cloudflare Workers static assets** cap a file at 25 MiB, so MARs (about 80 to 115 MB)
   cannot live on the update host; they stay on GitHub Releases, as Zen's do.

## Design

### 1. Channels and URLs

| Channel | `app.update.channel` | MAR channel ID  | Manifest                                                                               | Built by      |
| ------- | -------------------- | --------------- | -------------------------------------------------------------------------------------- | ------------- |
| release | `vimma`              | `vimma`         | `https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml`         | `release.yml` |
| nightly | `vimma-nightly`      | `vimma-nightly` | `https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma-nightly/update.xml` | `nightly.yml` |

- The compile-time channel stays `vimma` for both (it also picks the certificates and, through
  `MOZ_APP_REMOTINGNAME`, the desktop file ID `vimma-vimma`; m6-packaging). The nightly tarball
  gets its channel at packaging time: `package.mjs --channel nightly` rewrites
  `defaults/pref/channel-prefs.js` and `update-settings.ini` inside it. Updates never touch those
  files, so a nightly install stays nightly and a release install never accepts a nightly MAR
  (error 22).
- `MOZ_APPUPDATE_HOST` = `updates.vimma.dev`, set by one `set_config` line in the existing
  `src/browser/moz-configure.patch`. The path is Firefox's fixed template.
- Everything on updates.vimma.dev is a committed static file in the repository
  `vimma-browser/vimma-updates`, deployed by Cloudflare Workers Builds; there is no server code.
  `update.xml` per channel is generated and signed by the release workflow (§7). Every binary
  embeds the host for life (an install can only move to another host through an update from the
  old one), which is why the host is a name of its own (decision 18).

### 2. The manifest

```xml
<?xml version="1.0"?>
<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261028041207">
  <update type="minor" appVersion="158.0.1" platformVersion="158.0.1" buildID="20261028031500"
          displayVersion="0.3.1" detailsURL="https://github.com/vimma-browser/vimma/releases/tag/v0.3.1"
          vimmaUrgency="security" vimmaAdvisories="MFSA 2026-110">
    <patch type="complete" size="98113536" hashFunction="sha512" hashValue="…"
           URL="https://github.com/vimma-browser/vimma/releases/download/v0.3.1/vimma-0.3.1-linux-x86_64.complete.mar"/>
    <vimmaAppImage size="…" hashFunction="sha512" hashValue="…"
           URL="https://github.com/vimma-browser/vimma/releases/download/v0.3.1/vimma-0.3.1-x86_64.AppImage"/>
  </update>
</updates>
<!-- vimma-signature v1 key=3f2a91c0 sig=BASE64 -->
```

(Values are illustrative.)

(Since changed: until sub-PR 2 builds the updater in, a release has no MAR, so the manifest has
no `<patch>`; it carries `<vimmaTarball>`, `<vimmaAppImage>` and `<vimmaDeb>`, each with `size`,
`hashFunction="sha512"`, `hashValue` and `URL`, and the commands `:update` shows check the
download against that SHA-512 before installing it (docs/security.md UP8);
`tools/update/manifest.mjs`.)

- One `<update>`, the newest build of the channel; an `<updates>` with no `<update>` (still
  signed, still with its channel, target and serial) means "nothing offered". The channel,
  target and serial sit on `<updates>` (decision 25). Nightlies use `displayVersion="0.3.1-nightly.20261028031500"`, the build ID after the release
  version, so that each build has its own (decision 40).
- `appVersion` is Firefox's version and `displayVersion` Vimma's (What the design must add, 2);
  together they are the version line `Vimma 0.3.1 · Firefox 158.0.1` that about:vimma and
  `:update` show, written by the same rule as `tools/release/version-line.mjs`.
- `vimmaSerial` is the UTC time the manifest was generated (`YYYYMMDDhhmmss`, the build-ID
  format). `vimmaUrgency` is `security` or `normal`; `vimmaAdvisories` lists the MFSA IDs, if
  any.
- **Signature**: RSASSA-PKCS1-v1_5 with SHA-384 over the bytes `vimma-update-xml-v1\n` followed by
  the file up to and including the newline before the comment. The prefix separates it from MAR
  signatures (a MAR starts `MAR1`), so the one key cannot be tricked into signing across uses.
  `key=` names the key by the first 8 hex digits of its SPKI SHA-256; the comment may hold up to
  four `key=… sig=…` pairs (rotation, §6), and one that verifies under a pinned key is enough.
- Served with `Cache-Control: no-cache` (a `_headers` rule in `vimma-updates`).

### 3. Install types and how each package sets its mode

| Install                | Updater                        | Set by                                                                                                                      | Vimma's module does                                                            |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Tarball, writable dir  | Firefox's, on                  | nothing (no `is-packaged-app`)                                                                                              | notices, the urgent prompt, staleness warning                                  |
| Tarball, read-only dir | Firefox's checks, cannot apply | (same tarball)                                                                                                              | hint: "Vimma can't write `/opt/vimma`; update it as its owner or reinstall"    |
| AppImage               | off                            | `usr/lib/vimma/is-packaged-app` in the AppDir, content `vimma-package=appimage`                                             | fetches the manifest, replaces `$APPIMAGE` itself (below)                      |
| `.deb`                 | off                            | `usr/lib/vimma/is-packaged-app`, content `vimma-package=deb`                                                                | fetches the manifest, hint: "download vimma_0.3.1_amd64.deb"                   |
| Release `PKGBUILD`     | off                            | `PKGBUILD` `package()` writes `/opt/vimma/is-packaged-app`, content `vimma-package=pkgbuild-release`                        | fetches the manifest, hint: the exact `curl … && makepkg -si` command          |
| AUR `vimma-bin`        | off                            | `PKGBUILD` `package()` writes `/opt/vimma/is-packaged-app`, content `vimma-package=aur`                                     | fetches the manifest, hint: "update vimma-bin with your AUR helper"            |
| Source / dev build     | not built                      | `configs/common/mozconfig`: `--enable-updater` only when `VIMMA_UPDATES=1` (release and nightly jobs set it); else as today | nothing; about:vimma says "updates: not built in (source build)"               |
| Artifact build (CI)    | Mozilla's prebuilt             | ADR-010 gap, unchanged                                                                                                      | the verifier hook is Vimma's, so it refuses aus5's unsigned XML; never shipped |

Firefox only tests that the file exists; the `vimma-package=` line is for Vimma's hint text.
Detection order in `VimmaUpdates.sys.mjs`: no `omni.ja` in the GRE directory (a build run from
its objdir) → source build (decision 28; once sub-PR 2 builds the updater in, `AppConstants.MOZ_UPDATER`
false also means a source build);
`isPackagedApp` and `$APPIMAGE` set → AppImage; `isPackagedApp` → read the file's package name;
else Firefox's updater, and `aus.canUsuallyApplyUpdates` (`UpdateService.sys.mjs:4156`) tells
writable from read-only.

**AppImage: Vimma replaces the file** (decision 19). The squashfs is read-only, so MARs
cannot apply. Vimma's module, after a verified manifest offers a newer build, downloads
`vimmaAppImage` to
`<dir of $APPIMAGE>/.vimma-update-<buildID>.AppImage.part` (anonymous request, decision 1), checks
size and SHA-512 against the signed manifest, sets mode `0755`, fsyncs and renames it over
`$APPIMAGE`. The running process keeps its mounted image (the old inode); the next start runs the
new one under the same path, so the desktop entry and `MOZ_APP_LAUNCHER` stay right. A directory
it cannot write falls back to the hint. Rejected: AppImageUpdate/zsync (a tool the user has to
run, so updates are not automatic) and MAR-patching an extracted copy (the AppImage would stop
being one file). The file keeps its old name (`vimma-0.1.0-x86_64.AppImage` now holding 0.3.1);
the guide says so, and about:vimma shows the real version.

(Since changed: the replacement is built in `packages/vimma-core/src/appimage-update.mjs` and
`VimmaUpdates.sys.mjs`, with these rules. It runs only when the GRE directory's
`is-packaged-app` says `vimma-package=appimage` and lies inside `$APPDIR`, because `$APPIMAGE` is
inherited by every program an AppImage starts (decision 34). The download URL must be one of the
project's release downloads (`https://github.com/vimma-browser/vimma/releases/download/…`, path
segments only), because a leaked manifest key would otherwise be enough to point every AppImage at
a file of its own; with that rule it also needs a release asset in the project. Only an offer
verified by a check in the running process is installed, because the saved result it may be
restored from is a pref anyone can edit. The part file gets a name no other file has
(`.vimma-update-<buildID>.AppImage.part`, numbered when taken), created by one process alone, so
two Vimma processes running the same AppImage never write or remove each other's download; part
files older than a day are leftovers of a killed run and are removed. A symbolic link at
`$APPIMAGE` is refused, because the rename would replace the link and not the file it names. Every write is synced, and the size and SHA-512 are
checked on the file as written, before the rename. A target that already has the offered size
and SHA-512 counts as replaced without a download. An urgent replaced update shows
`⇡ 0.3.1 security: restart` until `:restart` exists (since changed: `⇡ 0.3.1 security: :restart`,
§5), the one-time message says
`Vimma 0.3.1 is installed · restart Vimma to use it` (or `fixes security issues · …`) once the
file is replaced and not before, and the `Show the update command?` question of spec
update-notices is not asked, because an AppImage that replaced its file has no command left to
run. A failed replacement keeps the offer and its manual steps and is tried again at the next
check.)

### 4. Client: verification, downgrade and replay

`UpdateVerifier` (pure logic in `packages/vimma-core/src/updates.mjs`, WebCrypto passed in) is
called from two places with the same rules:

- **Firefox's checker**, through `src/toolkit/mozapps/update/UpdateService-sys-mjs.patch`: before
  `request.send` (`UpdateService.sys.mjs:5698`) it calls `VimmaUpdates.beforeCheck(request)`, which
  adds `LOAD_ANONYMOUS` and, with `[updates] check = false`, returns false so the check ends as
  checks-not-allowed; in the `try` before `#parseUpdates(request)` (line 5758) it awaits
  `VimmaUpdates.verify(request)`, which throws on any failure, so the check fails exactly as a
  malformed XML does (`#getCheckFailedObject(status, 200, request)`) and no update is offered. A
  patch, not an observer: if a rebase moves this code, `surfer import` fails instead of updates
  silently going unverified (the precedent is
  `src/browser/components/tabbrowser/content/tab-bar-visibility-js.patch`).
- **Vimma's own fetch** for AppImage, `.deb` and AUR (Firefox's checker is off there): `fetch`
  with `credentials: "omit"`, `cache: "no-store"`, the same URL (`Services.appinfo.updateURL`
  formatted by `UpdateUtils.formatUpdateURL`), the same timer interval and the same verifier.

Rules, in order (each failure has a reason string for about:vimma and the status bar):

1. The trailing comment parses and the signature verifies under a pinned key: the primary or
   secondary slot. The public keys are the SPKI of the DER certificates the updater embeds,
   generated into `vimma/updates/keys.mjs` at import time from
   `src/toolkit/mozapps/update/updater/vimma/`. A test key is accepted only from the pref
   `vimma.update.testKeys` and only when `Cu.isInAutomation`.
2. `vimmaChannel` equals `UpdateUtils.UpdateChannel` and `vimmaTarget` equals the build target (a
   nightly or other-target manifest served at the release path is refused).
3. **Replay**: `vimmaSerial` must be ≥ the highest serial this profile has accepted
   (`vimma.update.serial`, written after each success) and ≥ the running build's own build ID, so
   a fresh profile on a new build cannot be offered a manifest older than itself.
4. **Downgrade**: the offered `(appVersion, buildID)` must be strictly newer than
   `(Services.appinfo.version, Services.appinfo.appBuildID)`, versions compared with
   `Services.vc.compare` and build IDs as numbers, and its `displayVersion` must differ from the
   running build's Vimma version (decision 40). A manifest that passes 1 to 3 but offers an
   older or equal build, or the version already running, is not an error: the verifier removes
   the `<update>` and the check finds nothing. A saved offer is dropped at startup on the same
   terms.
5. **Freeze**: a verified manifest whose serial is older than 45 days (release) or 7 days
   (nightly) still counts, but the status bar shows `updates: no news for N days` once a day,
   unless checks are off (decision 14).
   Firefox has shipped a major release every two weeks since 154.0 (ADR-002, amended by spec
   upstream-beta-canary), nearly always with an advisory, so a release manifest older than 45 days
   means the feed or the pipeline has missed about three Firefox releases; a shorter limit would
   warn during an ordinary gap between releases.

Firefox then downloads, checks the hash and stages, and the updater checks the MAR's signature,
channel and Firefox version. The server or GitHub can withhold updates, but cannot install code
Vimma did not sign or roll a profile back.

### 5. Notices, urgent updates, restart

Core decides from plain data (`updateNotice(state)` in `updates.mjs`: install type, Firefox
updater state, offered and running versions, urgency, last check, now); the host renders it.

| State                                                        | Status bar (right side)                                 | Colour                                  | Extra                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Downloading / staging                                        | nothing                                                 |                                         | silent                                                                                                                    |
| Staged, normal                                               | `⇡ 0.3.1 on restart`                                    | `--vimma-fg-dim`                        | applies at the next start, whenever that is                                                                               |
| Staged, urgent                                               | `⇡ 0.3.1 security: :restart`                            | `--vimma-text-error`                    | the once-per-session `y/N` question (Behaviour 6), re-asked after 24 h                                                    |
| Offered, not staged (packages; every install until sub-PR 3) | `⇡ 0.3.1 available`, urgent `⇡ 0.3.1 security: :update` | `--vimma-fg-dim` / `--vimma-text-error` | `:update` opens about:vimma's Updates section: the exact commands for the install type and the release link (decision 29) |
| AppImage replaced                                            | `⇡ 0.3.1 on restart`                                    | as staged                               | as staged                                                                                                                 |
| Manifest refused 3 times in a row (decision 27)              | `updates: check failed`                                 | `--vimma-text-yellow`                   | reason in about:vimma                                                                                                     |
| Stale feed (rule 5)                                          | `updates: no news for N days`                           | `--vimma-text-yellow`                   | once a day                                                                                                                |
| Checks off                                                   | `updates: off`                                          | `--vimma-fg-dim`                        | once per session, for 5 seconds (decision 38)                                                                             |

(Since changed: an offer is also announced once per version by a short message, and an urgent
offer asks `Show the update command? (y/N)` once per session; spec
[update-notices](update-notices.md).)

- The urgent question uses the command line's `y/N` form, as the add-on picker's removal
  question does (`packages/vimma-core/src/addons.mjs:100`). `y` runs `app.restart`.
  (Since changed: it is the question line of spec [update-notices](update-notices.md), with its
  guards and arming delay, because it opens without a key from the user; decision 35.)
- `:restart` (action `app.restart`) is Firefox's restart path: `quit-application-requested`
  (add-ons and unsaved-form prompts can cancel), then `eAttemptQuit | eRestart`; the session comes
  back through SessionStore as on any restart (workspaces, panes, scroll). The private workspace
  is a private window, whose tabs a restart closes, hence the extra sentence in the question.
  (Since changed: the AppImage quits and starts its own file again instead, decision 36; `:restart`
  asks first while private tabs are open, decision 37.)
- Firefox's own badge and doorhanger stay as Firefox has them (`badgeWaitTime` 0,
  `promptWaitTime` 24 h); they are the mouse path to the same restart.
- **Interval**: `app.update.interval` becomes 43200 (12 h, Mozilla's release branding value)
  instead of 86400, so urgent releases are seen within 12 h of publication, plus the 30 s
  first-run timer. Vimma's own fetch (packaged installs) uses the same pref (decision 13).
  (Since changed: Vimma's fetch checks 5 s after the first window's delayed startup instead of
  30 s after load, and only a check with a verified answer resets the interval; spec
  [update-notices](update-notices.md).)

### 6. Signing and keys

**What is signed with what:**

| Artifact                           | Signature                                       | Verified by                                                       |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| Complete MAR                       | update key (RSA-4096, PKCS#1 v1.5, SHA-384)     | the installed `updater` (embedded primary/secondary certificates) |
| `update.xml`                       | same update key, domain-separated (§2)          | Vimma's verifier (same public keys, WebCrypto)                    |
| AppImage file (in-app replacement) | its SHA-512 inside the signed `update.xml`      | Vimma's verifier                                                  |
| Every release asset, MAR included  | cosign keyless bundle (unchanged, m6-packaging) | people, with `cosign verify-blob`; not the browser                |

Cosign stays for people and auditors: an installed browser cannot verify a Sigstore bundle
offline (it needs Fulcio roots and Rekor through TUF), and the updater only knows the RSA keys it
was built with. One update key signs both MARs and the manifest (decision 12).

**Certificates in the build.** `src/toolkit/mozapps/update/updater/moz-build.patch` adds one
branch to `moz.build`: channel `vimma` → `vimma/primary.der` and `vimma/secondary.der` (Vimma's
files, beside it). Mozilla's DER files stay untouched (Zen overwrites them, which hides the change
from a rebase). The `updater-xpcshell` test updater keeps Mozilla's test certificate. Whether the
Linux updater needs Zen's `-Wl,-rpath=$ORIGIN` hunk to find NSS is checked in sub-PR 1 by running
the built updater from an installed tarball; if it does, that hunk joins the same patch.

**Primary and secondary.** The updater accepts either slot, so:

- **primary**: the online key every release is signed with;
- **secondary**: a cold recovery key, generated by the maintainer on an offline machine and kept
  off any network (decision 17), used only to sign the one release that replaces a leaked or
  lost primary.

**Where the primary key lives**: Google Cloud KMS, reached through GitHub OIDC (option C below,
decision 16). The options that were weighed:

| Option                                                                  | Automation | If CI or a workflow is compromised                                                                                                                            | If the key leaks                                     | Cost / setup                                                                                                                                |
| ----------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. GitHub Actions secret** (Zen's way)                                | full       | anything that runs in the signing job's environment can copy the key out, silently, once                                                                      | it signs MARs until rotation, from anywhere, no log  | none; an environment `update-signing` limited to `main` and `v*` tags                                                                       |
| **C. Cloud KMS via GitHub OIDC** (GCP Cloud KMS or AWS KMS, HSM-backed) | full       | can ask KMS to sign while the job runs, cannot copy the key; every signature is in the cloud audit log; IAM bound to `repo:vimma-browser/vimma` + environment | cannot leak (non-exportable); revoke the IAM binding | a cloud account; about 1–3 USD a month; NSS signs through the provider's PKCS#11 library or a digest-signing step (new tool: licence check) |
| B. On a self-hosted build machine (file, or a hardware token)           | —          | —                                                                                                                                                             | —                                                    | **not viable**: Vimma has no self-hosted build machine and none is planned (below)                                                          |
| D. Offline key + online subkey                                          | —          | —                                                                                                                                                             | —                                                    | **not possible for MARs**: the updater has no chain or expiry, only the two embedded keys; D becomes the cold secondary above               |

Option B, a key file or a hardware token (for example a YubiKey via PKCS#11) on the
`vimma-build` runner, assumed a self-hosted build machine. None is registered, none is planned,
and the build-supply-chain spec moves full builds to GitHub-hosted runners and
rejects a self-hosted machine; a hosted runner is a fresh virtual machine that cannot hold a
token. B would need a machine to exist only to sign, online whenever a release or nightly runs,
with its own security design. It is kept here as a rejected option; if a self-hosted machine is
ever added, its own spec can revisit it.

**Key ceremony (any option).** RSA-4096, a self-signed certificate per slot (the updater only
reads the public key; the subject is `CN=Vimma update signing primary|secondary`; validity is
irrelevant). The two public DERs are committed under `src/toolkit/mozapps/update/updater/vimma/`
with their SHA-256 in the runbook. The secondary's private half is never on a networked machine.

**Rotation (planned, for example every two years or on any doubt).** Release R carries an updater
with `primary = new`, `secondary = cold` and is signed with the **old** primary, which every client
still trusts. Releases after R carry **two** signatures, old and new primary (a MAR holds up to 8;
`signmar` adds several), for four weeks (two Firefox release cycles), so a client that had not yet
installed R can still take whatever is newest; after that, the new primary alone. The manifest
carries both signatures for the same period (§2), since a client before R verifies it with the old
primary only.

**If the primary leaks:** revoke it (C: disable the key version; A: delete the secret), sign an
emergency release with the **cold secondary** that embeds a fresh primary and the same secondary,
publish it with `vimmaUrgency="security"`, and say so in a GitHub advisory. Until clients update,
the attacker can sign MARs but also needs to serve a manifest; that is signed with the same key,
so they additionally need the update host or a TLS interception, and HTTPS and the separate host
credentials are the remaining wall. **If both leak:** there is no in-band recovery; the advisory
tells users to reinstall from a release whose updater carries new keys (checked with cosign).

### 7. Release pipeline

New gate: repository variable `UPDATES_ENABLED` (together with `RELEASE_ENABLED`, and the key
being configured). Every job below also keeps m6-packaging's gate (`release` event or `main`).

**`release.yml`:**

| Job                    | Runner                             | Permissions / secrets                                                                                             | Does                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build` (changed)      | the full-build runner (decision 4) | `contents: read`; no update secret                                                                                | `VIMMA_UPDATES=1`; after `./mach package`: `./mach repackage mar … --mar-channel-id vimma` → unsigned `vimma-V-linux-x86_64.complete.mar`; uploads it with `mar-tools` (`signmar` and its NSS libraries from `dist/bin`) and `update-meta.json` (build ID, Firefox version, Vimma version)          |
| `package` (changed)    | `ubuntu-24.04`                     | `contents: read`                                                                                                  | `is-packaged-app` into AppDir, `.deb`, PKGBUILD; checks that the tarball has none and that `update-settings.ini` says `vimma`                                                                                                                                                                       |
| `update-sign` (new)    | `ubuntu-24.04`                     | environment `update-signing`; C: `id-token: write`; A: the key secret                                             | signs the MAR (`signmar -s`), verifies it against the committed DERs (`signmar -v`), runs `tools/update/manifest.mjs` (XML from `update-meta.json`, MAR and AppImage size/SHA-512, urgency), signs the XML, verifies it with the core verifier                                                      |
| `sign` (unchanged)     | `ubuntu-24.04`                     | `id-token: write`                                                                                                 | cosign bundles, now also for the signed MAR                                                                                                                                                                                                                                                         |
| `publish` (changed)    | `ubuntu-24.04`                     | `contents: write`                                                                                                 | uploads the signed MAR with the other assets                                                                                                                                                                                                                                                        |
| `update-publish` (new) | `ubuntu-24.04`                     | environment `update-site`; `SITE_DEPLOY_KEY` (write deploy key for the manifest repository only); no GitHub token | downloads the MAR and AppImage **from the release URLs** and checks size and hash against the signed XML, then commits `…/updates/browser/Linux_x86_64-gcc3/vimma/update.xml` to the manifest repository's `main` and pushes; polls the update host until the new serial is served (10 min timeout) |
| `failure` (changed)    | `ubuntu-24.04`                     | `issues: write`                                                                                                   | as today, also for the new jobs                                                                                                                                                                                                                                                                     |

(Since changed: `update-sign` signs both the MAR and the manifest by raw PKCS#1 KMS signing over a
SHA-384 DigestInfo that the job builds itself, because the KMS key is `rsa-sign-raw-pkcs1-4096`
(decision 16) and `signmar -s` signs only with a private key held in an NSS database, which a
non-exportable KMS key cannot be placed in. This is a constraint on sub-PR 4: its MAR signing
path must use raw PKCS#1 KMS signing over a SHA-384 DigestInfo; `signmar -v` still verifies the
result.)

(Since changed: the release manifest is published by a workflow of its own,
`update-publish.yml`, on `release: released`, because a release has no MAR until sub-PR 2 and
"check and tell" (decision 26) needs only the manifest; `release.yml` gains the MAR steps with
sub-PR 2. The published release's run only starts the workflow on `main`, so the
`update-signing` environment admits `main` alone and a `v*` tag pushed on another commit cannot
reach the key. Its jobs are `prepare` (no secret: release checks, `SHA256SUMS` and cosign, the
body from `tools/update/manifest.mjs`, which also holds the urgency rule), `sign` (no repository
code) and `publish`, whose deploy key is `UPDATES_DEPLOY_KEY` in the environment `update-publish`
rather than `SITE_DEPLOY_KEY` in `update-site`, names that cannot be confused with
`vimma-browser/vimma-site`'s. The urgency also counts a `fix(security)` commit and any pull
request with the `security` label, because a Vimma security fix needs the same prompt restart as
a Firefox one. docs/runbook.md, "Update signing keys and the update host", step 7, and
docs/security.md UP7.)

- **Urgency** is computed in `update-sign` by `tools/update/urgency.mjs`: the release is urgent
  when any commit since the previous tag is an `upstream: firefox <version>` bump whose PR carried
  the `security` label, the same classification `tools/upstream/detect.mjs` applies (unknown
  counts as security, G3) and spec firefox-versions keys its automatic release on. The advisory
  IDs in those subjects (firefox-versions decision 9) go into `vimmaAdvisories`.
- **Direct push, not a PR**, to the manifest repository, because a PR would need a merge, a
  manual step. The deploy key can write only that repository, and the commit touches only the
  `updates/` tree. A CI check there cannot stop a bad push, because Cloudflare deploys without
  waiting for CI (Research, "Vimma today"); the manifest repository holds nothing else, so the
  push can change only manifests (decision 18). The host cannot forge an update
  (the XML is signed); its compromise can only withhold or replay, which rules 3 to 5 catch.
- **Release secrets stay isolated** (plan §8): the build job never sees the update key, the site
  key or a write token; the agent workflow (`claude.yml`) gets none of them; each secret lives in a GitHub
  environment whose deployment rule allows only `main` and `v*` tags.
- A re-run is idempotent: the MAR upload uses `--clobber`, and `update-publish` commits nothing
  when the file is unchanged.

**`nightly.yml`** splits into `build` (the full-build runner, `contents: read`, as today plus
`VIMMA_UPDATES=1`, `package.mjs --channel nightly`, and the MAR with channel ID `vimma-nightly`),
then the same `update-sign` and `update-publish` jobs (shared as a reusable workflow
`update-publish.yml`) writing `…/vimma-nightly/update.xml`, and `publish` (`ubuntu-24.04`,
`contents: write`) for the rolling `nightly` release. Nightly MARs point at the `nightly` tag's
asset URL with a build-ID file name (`vimma-nightly-<buildID>-linux-x86_64.complete.mar`), because
the rolling release replaces its assets; the previous MAR is kept as an asset until the next build
so a client that just read the old manifest can still download it.
While the release gate holds, `nightly.yml` publishes no `nightly` release: it keeps each build
as a private workflow artifact (`docs/runbook.md`). The nightly manifest jobs
above therefore start only when public nightly releases do (decision 23).

**The bump and release halves of the security path** are other specs' (decision 3): spec
upstream-bump-automation merges a green bump PR under `AUTO_MERGE_UPSTREAM`, and spec
firefox-versions (decision 17) merges the release PR under `AUTO_SECURITY_RELEASE` and releases
whatever is on `main` after the bump. From there `release.yml` and the jobs above publish.
`update-publish` comments on the m7 tracking issue "reached <host> at <time>, <hours> after the
advisory", so the issue shows the whole path from advisory to installs.

### 8. Decisions

1. **Downloads are anonymous.** `VimmaUpdates` observes `http-on-modify-request` for
   system-principal channels with no browsing context whose URL is the selected patch's URL or its
   redirect, and clears `Cookie`. This is a privacy measure, so failing open is acceptable, unlike
   verification.
2. **updates.vimma.dev serves `/updates/` publicly with no access rule**, so that clients can
   fetch the manifest as soon as it is committed; vimma.dev has no Cloudflare Access in front of
   it either. Rejected: keeping the manifest behind an access rule until publication (clients
   cannot authenticate to it, and nothing on the path is secret: the manifest is the same static
   file for every install).
3. **This spec auto-merges nothing.** Spec upstream-bump-automation merges a green bump PR under
   `AUTO_MERGE_UPSTREAM`, and spec firefox-versions (decision 17) merges the release PR under
   `AUTO_SECURITY_RELEASE`, so this spec only carries a published release to installed copies,
   because a second auto-merge rule for the same bump PR (for example a variable that merges
   every `security`-labelled bump) would let two variables and two allowlists decide one merge.
   When those variables are turned on is decided in those specs (in upstream-bump-automation,
   its decision 10). A security bump whose patches had to be re-exported waits for a person
   there; this spec accepts that limit, because a patch that changed is reviewed before it ships
   to every install. Rejected: auto-merging the release PR
   here when every changelog entry in it is an `upstream:` line, because a security fix would
   wait for a person whenever any feature had merged since the last release.
4. **The update jobs do not depend on a self-hosted machine.** The `build` job only gains steps
   (`VIMMA_UPDATES=1`, `./mach repackage mar`, the uploads) and runs wherever `release.yml` and
   `nightly.yml` run their full build: today a self-hosted label with no runner behind it, and on
   GitHub-hosted runners once build-supply-chain delivery 4
   ([#224](https://github.com/vimma-browser/vimma/issues/224)) lands. The build job holds
   no update secret in either case; signing and the site push run in separate `ubuntu-24.04` jobs
   with their own environments. The MAR is produced in the build job because `./mach repackage
mar` needs the host `mar` tool from the same objdir. Nothing here can ship before the full
   builds run somewhere, so this spec's pipeline sub-PR lands after build-supply-chain.
5. **Complete MARs only**; partial MARs later (they need the previous build in the pipeline).
6. **`type="minor"`** always (Firefox's "major" UI is for unsupported operating systems).
7. **One manifest per channel and target**, because the client refuses a manifest for another
   channel or target (§4 rule 2), so each build reads only its own file; aarch64 and macOS add
   files later. (Since changed: the macOS notice manifest is
   [macos-homebrew](macos-homebrew.md) decisions 16 to 21.)
8. **The m0-updater mochitests change**: on a build with `VIMMA_UPDATES=1`, `MOZ_UPDATER` is true
   and the URL is updates.vimma.dev; "no request to aus5" stays a test in both builds.
9. **Settings' "Updates are managed by your operating system"** is accurate for `.deb` and AUR;
   for the AppImage it is not, and the guide says Vimma updates the file itself. No string patch.
10. **A hook in `UpdateService.sys.mjs`, not an observer** (§4), because a moved hook fails
    `surfer import` loudly while an observer would silently stop verifying.
11. **Vimma never restarts on its own**, urgent or not, because a restart can lose unsaved form
    input and closes private tabs; the urgent prompt and the red segment make the security case
    visible without taking the decision away.
12. **One update key signs MARs and the manifest**, domain-separated by the manifest prefix (§2),
    because a leaked MAR key is only useful together with a manifest that offers the MAR, and the
    prefix stops a signature made for one use from passing as the other. The choice can be
    reversed in an ordinary release, because the manifest key lives only in `keys.mjs`, not in the
    updater binary. Rejected: a separate manifest key, which doubles the ceremony, the custody and
    the rotation for a leak that already needs both.
13. **The check interval is 12 hours** (`app.update.interval` 43200, Mozilla's release branding
    value), because it halves the time an urgent release waits on a running install against
    today's 24 hours, at the cost of two GETs a day of a small static file that carries no
    identifier (Security and privacy). Rejected: 24 hours (an urgent fix reaches a running
    install up to a day later); shorter than 12 hours (no Firefox release cadence needs it).
14. **`[updates] check = false` also hides the stale-feed warning**, because with checks off
    there is no feed to be stale, and the warning would be noise after an explicit opt-out; the
    once-per-session `updates: off` stays, so the state is never invisible. (Since changed: it
    shows for a few seconds and hides; decision 38.)
15. **Checks are on by default**, as in Firefox, because an install that never hears of a security
    release stays vulnerable, and a check sends no identifier (Security and privacy). The guide's
    "Updates" section names the off switch. Rejected: off by default, because the people who never
    change a default are the ones a security update most needs to reach.
16. **The primary key lives in Google Cloud KMS, HSM protection level, reached through GitHub
    OIDC** (§6, option C), because the signing job can then only ask for signatures while it runs,
    every signature is in the cloud audit log, and the key cannot be exported, so revoking the IAM
    binding ends a compromise; this keeps a long-lived signing secret out of CI, as m6-packaging
    did by choosing cosign keyless. It costs about 2.50 USD a month for the RSA-4096 key version
    (0.003424658 USD per hour, and 0.03 USD per 10,000 signing operations;
    `cloud.google.com/kms/pricing`, read 2026-10-15). The signing integration (Google's PKCS#11
    library loaded into NSS for `signmar`, or a digest-signing step) has not been tried with
    `signmar`; sub-PR 1 tries it, and the library gets a licence check before it is used.
    Rejected: a GitHub Actions secret (Zen's way), because anything that runs in the signing job
    could copy the key out once and silently, and a copied key signs from anywhere with no log;
    it remains the fallback only if the KMS integration proves unworkable, which would reopen
    this decision in this spec.
    (Since changed: the key's algorithm is `rsa-sign-raw-pkcs1-4096`, because Cloud KMS has no
    RSA-4096 PKCS#1 v1.5 scheme with SHA-384 (its PKCS#1 signing algorithms are
    `rsa-sign-pkcs1-{2048,3072,4096}-sha256`, `rsa-sign-pkcs1-4096-sha512` and
    `rsa-sign-raw-pkcs1-{2048,3072,4096}`), while the manifest (`SIGNATURE_ALGORITHM` in
    `updates.mjs`) and the MAR (§2) both need SHA-384. The signer hashes with SHA-384 itself and
    sends KMS the DER DigestInfo, so the result is a standard RSASSA-PKCS1-v1_5 SHA-384
    signature; `docs/runbook.md`, "Update signing keys and the update host", steps 3 and 6.)
17. **The maintainer generates the cold secondary once, on an offline machine, and keeps its
    private half offline** (paper or a USB stick in a safe), because the secondary matters only
    when the primary is lost or leaked, and an offline copy held by the one person who already
    publishes releases is the smallest trusted set; only its public DER enters the repository.
    Rejected: a second trusted person, because it adds a party who can sign a Vimma update; a
    second KMS key, because it is not offline and shares the cloud account's failure modes with
    the primary.
18. **The manifest is served from `updates.vimma.dev`, a new repository
    `vimma-browser/vimma-updates` that holds only manifests, deployed by Cloudflare Workers
    Builds with a `_headers` file**, because the bot that pushes manifests should be able to
    write nothing else, and a hostname of its own lets the hosting move to another provider by
    DNS alone, without a client update. It costs one more repository, one more Worker and one DNS
    record. Rejected: `vimma.dev/updates/…` from `vimma-site`, because its deploy key would need a
    bypass of the site's ruleset and could then push any site change straight to production
    (Cloudflare deploys without waiting for CI); GitHub Pages on a subdomain, because Pages
    answers with `Cache-Control: max-age=600` that the repository cannot change (seen on
    `updates.zen-browser.app` on 2026-10-15), so a client may get a copy up to 10 minutes old.
19. **The AppImage replaces its own file** after a verified manifest offers a newer build (§3),
    because an AppImage has no package manager to fall back on and updates without a person are
    the point of this spec; Vimma then writes a file outside its profile, and the file keeps its
    old name. A directory Vimma cannot write falls back to the hint. Rejected: a hint only, because
    an AppImage install would stay on its old Firefox until its owner acts; downloading next to
    the old file with a hint to swap, because a person still acts and two large files sit side
    by side.
20. **`.deb` installs get a hint only** ("download the new `.deb`", with a link to the release),
    because an apt repository would be a second signing system (a signed `Release` file, a second
    key with its own ceremony and custody, hosting for every `.deb`) for one package format. It is
    revisited when `.deb` users ask for one.
21. **An urgent update shows the red status-bar segment and asks the `(y/N)` restart question once
    per session**, asked again after 24 hours (Behaviour 6, §5), because a security fix that is
    staged but never applied protects nobody, and once a day is rare enough not to train a reflex
    `n`. Vimma still never restarts on its own (decision 11). Rejected: the red segment only,
    because it is easy to stop seeing.
22. **A bad update is handled by rolling forward only**: the maintainer pulls the update (a newer
    manifest with an empty `<updates/>`, Docs and changelog) and ships a fixed release; installs
    that already took the bad one stay on it until the fix arrives. Reason: downgrade protection
    is a security property of the whole design. Rejected: keeping the previous version on disk
    for a user-run rollback, because it is a local downgrade path that rules 3 and 4 (§4)
    otherwise forbid and can bring back the Firefox with the security hole; holding normal
    releases back for 48 hours, because nightly users already run a release's code days before it
    ships, which is the soak a delay would add.
23. **M6a closes on exit test 1 (the local N to N+1 e2e) and a `workflow_dispatch` dry run of
    `update-sign` and `update-publish` that pushes nothing; the security rehearsal runs with the
    first security release after the release gate lifts**, because publishing a manifest that
    installs follow is publishing a release, the gate holds until the maintainer has
    daily-driven Vimma, and everything the rehearsal adds over exit test 1 is the pipeline, which
    the dry run covers up to the push. `UPDATES_ENABLED` stays off until then. Rejected: turning
    on the nightly manifest before the gate, because it opens the gate for nightly users (and
    nightly builds are private workflow artifacts until the gate lifts, so they have no public
    MAR to offer); keeping M6a open until the gate lifts, because the work that can be verified
    would wait on a decision unrelated to it.
24. **A `vimma-bin` built from the release's PKGBUILD gets the exact command as its hint**:
    `:update` shows `curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si`,
    the command that installed it (`PKGBUILD_INSTALL_COMMAND` in `tools/package/package.mjs`),
    because rerunning it is the whole update and the user may not remember where it came from
    (since changed: the command is now `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si`, which works from any directory; described in
    docs/guide.md, "Arch Linux");
    the `vimma-package=pkgbuild-release` line that package writes (spec m6-packaging, "Arch
    Linux without the AUR", decision 4) tells it apart from an AUR install, whose users update
    with their AUR helper instead. Rejected: one hint for both, because "update with your AUR
    helper" does nothing for a package no AUR helper knows, and the curl command would replace an
    AUR install with a copy its helper no longer tracks.

25. **The manifest's channel, target and serial are attributes of `<updates>`, not of
    `<update>`**, because a manifest that offers nothing (decision 22's pull of a bad update)
    still needs a serial for the replay rule and a channel and target for rule 2; Firefox's
    parser reads only the `<update>` children and ignores attributes on the root.
26. **Delivery starts with "check and tell"**: Vimma's own signed-manifest check for every
    packaged install, before Firefox's updater is built in, because telling an install that a
    newer (often security) release exists, with the exact steps for its install type, needs no
    build change, no MAR pipeline and no key inside a binary, so it can ship while the updater
    sub-PRs wait for the full builds (decision 4). The manifest key is pinned in
    `update-keys.mjs`, an ordinary file, so it can change in any release (decision 12).
27. **A host that does not answer is not shown in the status bar**, only in about:vimma and the
    browser console, because updates.vimma.dev serves nothing until the release gate lifts
    (decision 23) and a laptop offline for a day would otherwise warn every user; a manifest that
    arrives and fails verification still counts toward `updates: check failed`, because that is
    what a tampered host or a broken pipeline produces. A failed check keeps an offer already
    verified.
28. **A build run from its objdir never checks**, detected by the missing `omni.ja` (every
    package has one), because its build ID is newer than every release's and its requests would
    only add traffic from development and test runs; about:vimma says "not checked (source
    build)". A test may set the install type through a pref honoured only when
    `Cu.isInAutomation`.
29. **`:update` opens about:vimma's Updates section when an update exists**, because the exact
    commands (the PKGBUILD URL, a quoted install path) are longer than the command line and need
    to be selectable to copy; "up to date", "off" and failures stay one-line notices.
30. **The manifest URL is the pref `vimma.update.url`, and it may use only `%BUILD_TARGET%` and
    `%CHANNEL%` and only `https`**, because then a check sends nothing but the platform and the
    channel even when the pref is changed, and a changed URL still has to serve a manifest signed
    by a pinned key. Plain `http` is allowed only in automation, for a local test host. Vimma's
    fetch also refuses redirects (`redirect: "error"`), because a static manifest never moves and
    a redirect could lead the request to plain http or another host; and it sends
    `Accept-Language` empty, because Necko otherwise adds the profile's languages
    (`nsHttpHandler::AddStandardRequestHeaders`, Firefox 158.0), which say something about the
    user. The other headers Necko adds (user agent, `Accept`, `Accept-Encoding`, `Priority`,
    `Sec-Fetch-*`) are the same for every install of a build.
31. **A config.toml with errors never turns checks on.** When the file cannot be applied, a
    `[updates] check = false` that can still be read from its TOML holds; otherwise the config in
    force before keeps its value, and when only the defaults stand in for the broken file (at
    startup) no check runs until it is fixed, because the defaults would otherwise silently undo
    an opt-out that the broken file still states; about:vimma says "off until config.toml's
    errors are fixed".
32. **A manifest response may hold at most 256 KiB, counted after decompression**: a larger
    `Content-Length` is refused before reading, and the body is read as a stream and cancelled
    past the cap, because a compromised host could otherwise send a body or a gzip or brotli bomb
    large enough to exhaust the parent process's memory before the signature is checked. It
    counts as a refused manifest.
33. **A serial more than a day ahead of the clock is refused**, because the replay rule would
    otherwise let one manifest signed with a wrong clock lock every profile that accepted it out
    of every later manifest; a day leaves room for a client clock that is slightly behind.
34. **The AppImage carries the `is-packaged-app` marker too**, because it is the only sign that
    belongs to the AppImage build itself: `$APPIMAGE` is inherited by every program an AppImage
    starts, so a tarball Vimma launched from another AppImage sees it as well. The marker lets
    detection require the AppDir's own `vimma-package=appimage` before it offers to replace
    `$APPIMAGE`; today `installTypeFrom` still accepts `$APPIMAGE` without a marker, and making
    the marker required is a separate change (since changed: replacing the file requires the
    marker and a GRE directory inside `$APPDIR`; the install type shown and the manual steps
    still accept `$APPIMAGE` alone). The cost is that Firefox, which reads the marker
    as "packaged app" (`isPackagedApp`), stops showing its warning that the content sandbox runs
    without unprivileged user namespaces (`security/sandbox/common/SandboxUtils.sys.mjs:25`,
    Firefox 158.0), as it already does for the `.deb` and the PKGBUILD; `docs/limits.md` states
    this. Rejected: an AppImage without the marker, detected by `$APPIMAGE` only, because nothing
    would then tell this build's AppImage from a tarball started by another AppImage.
35. **The urgent restart question is the question line of update-notices, not a `y/N` that
    takes focus**, because it opens at a moment the user did not choose, as the security question
    of that spec does: it never takes focus, opens only after 1,500 ms without a key, out of
    fields and overlays, and counts keys only after `security.dialog_enable_delay`, so a page
    cannot have the user restart Vimma by asking for `y` as the line appears. It is asked only
    once the update is in place (today, an AppImage that replaced its file), because before that
    a restart applies nothing; an ordinary update asks nothing, because the dim segment says it
    applies at the next start. An answer lasts for the session and for 24 hours in a session that
    runs on (decision 21); a clock set back since the answer asks again, so a wrong clock never
    silences it. Rejected: also asking before the file is in place, because `y` would restart
    into the old version.
36. **An AppImage restarts by quitting and starting `$APPIMAGE` again, not through Firefox's
    restart**, because Firefox's restart starts the same binary path
    (`toolkit/xre/nsAppRunner.cpp:2675`, `LaunchChild`), which in an AppImage lies inside the
    image mounted at this start: it would run the old version even after the file was replaced,
    and keep the old mount alive (checked with the 0.1.6 and 0.1.5 AppImages). Vimma asks
    `quit-application-requested` with `restart` as Firefox's restart does, quits with
    `eAttemptQuit`, and in `quit-application`, once no window can refuse, starts `/bin/sh` with a
    fixed script that waits for this process to exit (up to 120 s, longer than Firefox's
    shutdown watchdog, `toolkit.asyncshutdown.crash_timeout` 60 s plus 10 s) and then runs
    `$APPIMAGE` with no arguments; the process id and the path are positional parameters, never
    script text. The profile goes in `XRE_PROFILE_PATH` and `XRE_PROFILE_LOCAL_PATH`, as
    `AppShutdown::MaybeDoRestart` passes it, and `browser.sessionstore.resume_session_once` is set
    before the quit so the session comes back, as SessionStore sets it for a restart; a quit that
    a window refused restores that pref, drops the observer and starts nothing. Only the AppImage this Vimma is (the marker rule of
    decision 34) is started, never one whose `$APPIMAGE` it inherited, and a missing or
    non-executable file falls back to Firefox's restart. It is the second process chrome code may
    start (`docs/security.md` C2, UP11). Rejected: starting the AppImage at once, because the new
    instance would meet the old one's profile lock and remote server; teaching the AppImage's
    `AppRun` to wait, because the replaced file is the new release, so the waiting would depend on
    what the next release's `AppRun` does. The costs: the restart is a quit, so with history
    cleared on close (`privacy.sanitize.sanitizeOnShutdown`) SessionStore's purge observer stays
    and the session is cleared (`SessionStore.sys.mjs` `#onQuitApplication` removes it only for a
    restart), so no tab comes back, which the questions say first (decision 37); and the new
    process gets none of the old one's command-line arguments, as a launch from the desktop.
37. **`:restart` asks `Restart Vimma? N private tabs will close. (y/N)` while the private
    workspace has tabs, and `Restart Vimma? Tabs will not come back. (y/N)` when session restore
    will bring none back** (an AppImage with history cleared on close, or permanent private
    browsing), as `:private close` asks before it closes them, because the command is otherwise
    one keystroke from losing them. The urgent question says the same in its text, and `y` there
    restarts without a second question unless a loss appeared while the line was open, which
    `y` then asks about first.
38. **With checks off, `updates: off` shows for 5 seconds, once per session, then hides**: the
    clock starts the first time a status bar draws while checks are off on an install that checks
    (not a source build), and turning checks on and off again later in the session does not start
    it again (core `offNotice`). The reason: the notice exists so that an install that never
    checks says so (decision 14), and seeing it once at startup is enough for that; kept on the
    bar all session, the segment takes room on the right side for a state set on purpose.
    Rejected: a permanent segment
    (noise after an explicit opt-out), and no segment at all (an install that stopped checking by
    an old config line would then never say so). about:vimma's Updates section shows the state
    at any time.
39. **Until the offline ceremony makes the cold secondary (decision 17), the updater's secondary
    certificate slot holds the primary certificate a second time**, and the slot gets the cold
    secondary's certificate in a later release. The updater is built with a certificate in each
    slot (§6), and the secondary does not exist yet. The primary twice makes the updater trust
    exactly the one key the manifest check pins (`update-keys.mjs`, runbook step 5), so the two
    verifiers agree. Rejected: a throwaway key generated for the slot, because it is either
    held by someone, which adds a party who can sign a Vimma update, or discarded, which adds
    nothing; and waiting for the ceremony, because it would hold back every tarball update
    without making a lost primary any more recoverable than it is with the AppImage and the
    manifest today.
40. **The Vimma version already running is never offered, whatever the build IDs say, and each
    build job fixes `MOZ_BUILD_DATE`.** `./mach package` writes `buildid.h` and
    `application.ini` again, and without `MOZ_BUILD_DATE` they take the time of packaging, later
    than the build ID compiled into the binary (`Services.appinfo.appBuildID`). The manifest reads
    its build ID from the packaged `application.ini` (§7), so 0.1.10 offered itself to itself as
    a security update on Linux and macOS, and an AppImage would replace itself with the same
    release again
    ([#563](https://github.com/vimma-browser/vimma/issues/563)). Fixing `MOZ_BUILD_DATE` once per
    job, as Mozilla's release automation does, removes the cause; `tools/release/build-id.mjs`
    fails a release or nightly whose binary (`--full-version`) and `application.ini` disagree, so
    a mismatch cannot ship again; and the client rule removes the symptom for any build ID error
    that gets past both, because every release tag is a new Vimma version. Its cost: a rebuild of
    one Vimma version is never offered to an install of that version, which no release does (a
    fix is a new version). It holds only while each build of a feed has its own
    `displayVersion`, so a nightly's carries its build ID (§2): with the day alone, two nightlies
    of one day would hide each other's fixes. Rejected: reading the build ID from the binary in `manifest.mjs`,
    because the macOS binary cannot run on the Linux job that builds the manifest; and comparing
    Vimma versions instead of build IDs in rule 4, because Firefox's updater, which tarball
    installs are to use (sub-PRs 2 and 5), selects by build ID, and the two must agree.

### 9. Not in this spec

Partial MARs; macOS (now [macos-homebrew](macos-homebrew.md)), Windows and aarch64 manifests; an apt repository (decision 20); Flatpak;
a cookie-less download mirror; changing the remoting name or compile-time channel; a "Vimma does
not update itself" Fluent patch (no longer needed for tarballs); background updates while Vimma is
closed (Linux has no update agent).

## Security and privacy

**Trust chain.** TLS to updates.vimma.dev, then the manifest signature (§2, §4), then the MAR signature
checked by the updater against two embedded keys (§6). Each compromise and what it allows:

| Compromised                                 | Can                                                                    | Cannot                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The update host or its deploy key           | withhold the manifest; serve an old one (caught by rules 3 and 5)      | offer an unsigned or older build; install code                                     |
| GitHub release assets                       | replace a MAR or AppImage (download fails the hash or signature check) | install code                                                                       |
| A workflow run with the signing environment | A: copy the key; C: sign while the job runs, logged in the cloud       | C: take the key away                                                               |
| The primary key                             | sign MARs and manifests until rotation; still needs to serve them      | survive the cold-secondary recovery release                                        |
| The build job                               | build a malicious MAR, which still has to be signed in `update-sign`   | sign it, push the site or write the release (no secret or write token in that job) |

**Privacy.**

- **What a check sends**: `GET https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/<channel>/update.xml`
  (plus `?force=1` for `:update` or Firefox's "Check for updates"), Firefox's standard user agent,
  no cookies (`LOAD_ANONYMOUS` from the hook; Vimma's fetch uses `credentials: "omit"`), an empty
  `Accept-Language` and no redirect followed (decision 30). No Vimma version, build ID, locale, OS
  version or identifier: every install of a channel requests the same static file. Cloudflare sees the IP address and the time; the update host has no analytics.
- **What a download sends**: a GET to GitHub for the MAR (or AppImage) with the cookie header
  stripped (decision 1); GitHub sees the IP address. A cookie-less mirror (an R2 bucket on a
  separate hostname) is possible later and not needed for the guarantee.
- **How often**: every 12 h, at startup if the last check is older, when about:preferences or the
  About dialog opens (Firefox's behaviour), and on `:update`.
- **Glean**: the update code records Glean metrics locally; Vimma builds never upload them
  (m0-mozilla-services). No new telemetry.
- **Off**: `config.toml` `[updates] check = false` (a schema 2 key, added to `TOP_KEYS` and
  `SCHEMA_2_KEYS` in `config.mjs` like `[search]`; no migration). It stops background checks and
  Vimma's fetch (the hook answers checks-not-allowed), so no request leaves at all; the About
  dialog then says the check failed (Firefox has no "off by user" panel without a policy) and the
  status bar shows `updates: off` once per session. The same switch is the pref
  `vimma.update.enabled` for people without a config file. `app.update.auto` = false (Settings:
  "Check for updates but let you choose to install them") keeps checks but stops downloads, as in
  Firefox.

**Local surface.** `app.restart` and `app.update_check` are ordinary actions: the control
socket's full role can run them, as it can `app.quit`. The agent role of control protocol 2 (spec
vimma-mcp) has a closed list of agent commands (`AGENT_COMMANDS` in
`packages/vimma-core/src/control.mjs`) and reaches no action, so a local AI agent cannot
restart Vimma or trigger an update check.

## Tests

Written first and seen to fail.

- **Vitest** `packages/vimma-core/test/updates.test.mjs` (WebCrypto from Node, keys generated in
  the test): signature split and verify (primary, secondary, wrong key, one flipped byte in the
  body, in the comment, a missing or second comment, the domain prefix absent → fails); channel and
  target mismatch; replay (serial below stored, below own build ID; equal accepted); downgrade
  (older `appVersion`; equal `appVersion` with older, equal and newer build ID; numeric not string
  build-ID order; the running Vimma version with a newer build ID); freeze thresholds per channel, and no stale warning with checks off; `updateNotice` for every row of the §5 table;
  the `y/N` prompt once per session and its 24 h re-ask; install-type detection; the version line
  (`Vimma 0.3.1 · Firefox 158.0.1`, `0.3.1-nightly.20261028031500`).
  `config.test.mjs`: `[updates] check`, wrong type, schema 1 → "is new in schema 2";
  `cmdline.test.mjs`: `:update`, `:restart`; `actions.test.mjs`: both actions have no default key
  and appear in help. Snapshots (`defaults.toml`, help) are re-recorded with a changelog line.
- **Tools** `tools/update/test/manifest.test.mjs`: XML from fixtures (attributes, sizes, hashes,
  nightly names, empty `<updates/>`), urgency from fixture commit logs (a `security`-labelled
  bump, an unknown-advisory bump, none), signing round trip with a test key, the deploy commit
  touching only `updates/**`. `tools/package/test/package.test.mjs`: `is-packaged-app` and
  its content in AppDir, `.deb` and PKGBUILD, absent from the tarball; `--channel nightly`
  rewrites both channel files. `release-workflow.test.mjs` / a new `update-workflow.test.mjs`:
  gates, environments, that only `update-sign` gets the key or `id-token` among the new jobs, only
  `update-publish` the site key, the build job gets neither, no pull-request trigger.
  `tools/branding/test/branding-prefs.test.mjs`: `app.update.interval` is 43200.
- **Mochitest** `tests/browser/browser_vimma_update_verify.js` (full build with
  `VIMMA_UPDATES=1`; in automation, `vimma.update.testKeys` set; XML served by an `.sjs` on
  `mochi.test`, reached by swapping `Services.appinfo.updateURL` the way `setUpdateURL` does):
  - a valid signed XML → `checkForUpdates` offers it; the request had no `Cookie` header although
    the test set one for the host;
  - **bad signature**, unsigned XML, a nightly manifest on the release channel → check fails, no
    update, about:vimma shows the reason;
  - **replay**: serve serial S, then S−1 → refused; **downgrade**: same Firefox version, older
    build ID → no update offered; a MAR download URL request carries no `Cookie`;
  - `[updates] check = false` → no request at all (an `http-on-opening-request` watcher), status
    bar `updates: off`.
- **Mochitest** `browser_vimma_update_notice.js`: fake update states (an `nsIUpdate` from XML via
  the update manager's test hooks) → status bar text and colour per §5; the urgent prompt appears
  once, `n` dismisses, `y` calls the restart path (stubbed `Services.startup.quit`), private tabs
  add the warning; `:update` messages; about:vimma's Version rows. `browser_vimma_updater.js` (m0)
  changes as decision 8 says.
- **Mochitest** `browser_vimma_update_packaged.js`: with the module's install type injected and a
  fake `$APPIMAGE` in a temp directory: the AppImage is downloaded from `mochi.test`,
  hash-checked, renamed over the file, mode 0755; a wrong hash leaves the file alone; an
  unwritable directory gives the hint; `.deb` and AUR show their hint texts.
- **e2e** `tests/e2e/scenarios/m6a-update-n-to-n1.json` (full build, Xvfb):
  1. extract the nightly tarball (N) into a temp install; copy the build's `updater-xpcshell` over
     `updater` (Mozilla's practice; it trusts the libmar test key `mycert`); point `[AppUpdate] URL`
     in the copy's `application.ini` at `http://127.0.0.1:<port>/…`; start with
     `MOZ_DISABLE_NONLOCAL_CONNECTIONS=1`, the automation pref and `vimma.update.testKeys`;
  2. N+1 = N's tarball with a later `BuildID` in `application.ini` and a marker file, made into a
     complete MAR with `./mach repackage mar` and signed with `mycert`; the XML is generated by
     `tools/update/manifest.mjs`, signed with the test manifest key and served by a local HTTP
     server;
  3. build a profile: two workspaces, tabs, a split, a scroll position; `:update`; wait (control
     `state.update`) until staged; the status bar shows `⇡ … on restart`;
  4. quit and start again (the startup applies the staged update and relaunches; the harness
     follows the new process through the control file); assert `appBuildID` is N+1's, the marker
     exists, and workspaces, tabs, split and scroll equal step 3 (as `m3-restart-restore`);
  5. **downgrade**: serve N's build ID again with a newer serial → no update; serve a MAR whose
     product version is an older Firefox → `update.status` `failed: 23`;
  6. **bad signature**: the **shipped** `updater` (Vimma's certificates) given the
     `mycert`-signed MAR → `failed: 19`; the Vimma verifier given an XML signed by an unknown key →
     no download.
- **Security rehearsal (M6a exit test 2; runs after the release gate lifts, decision 23)**: with
  `AUTO_MERGE_UPSTREAM=all` (spec upstream-bump-automation), `AUTO_SECURITY_RELEASE=true` (spec
  firefox-versions) and a real Firefox security release whose patches apply as they are, the
  tracking issue shows advisory → bump PR merged → release → `update.xml` served → a scheduled job
  installs the previous release's tarball from its GitHub Release into a fresh directory, starts
  it under Xvfb and sees it offer and stage the new release, with no person acting in between.
  Proven twice, as M7's gate was.

## Docs and changelog

- `docs/guide.md`: a new "Updates" section (after "Privacy defaults"): how each install type
  updates, the status-bar notices, the urgent `y/N` prompt, `:update` and `:restart`, that Vimma
  never restarts on its own, `[updates] check`, what a check sends, the AppImage keeping its file
  name. "Installing" loses "Vimma has no in-app updater"; the FAQ "Does Vimma update itself?"
  changes; "Privacy defaults" says Firefox's updater is built in and asks updates.vimma.dev only;
  "config.toml" gains `[updates]` in "What applies live" and "Schema". `docs/bindings.md` is
  regenerated (`npm run gen-docs`) for the two actions.
- `docs/runbook.md`, "Release packages": the key ceremony and where the public DERs and their
  hashes are; the chosen key option's setup (environment, OIDC/IAM or secret); `UPDATES_ENABLED`;
  `SITE_DEPLOY_KEY` (a deploy key with write on the manifest repository only); rotation and the
  leaked-key procedure; how to pull a bad update (decision 22): publish a newer serial with an
  empty `<updates/>` through `workflow_dispatch` of `update-publish.yml` (committing the previous
  `update.xml` again does not work, because the replay rule refuses its older serial).
- `docs/security.md`: the update trust chain and the compromise table above.
- `docs/limits.md`: no partial MARs; `.deb` has no apt repository; the AppImage keeps its file
  name.
- README: the feature list gains "updates itself (tarball, AppImage), signed with Vimma's own
  key; package installs get a hint"; Status unchanged until the first release.
- `CHANGELOG.md` [Unreleased], Added: "Vimma updates itself from updates.vimma.dev with updates signed by
  its own key; security updates are marked and ask once to restart." The maintainer adds it at
  merge time.

## Delivery

The key custody and the update host (decisions 16 to 18) are built into every updater-enabled
binary; ADR-016 records them in sub-PR 2. Sub-PRs, in order, each independently mergeable and
tested:

1. **Check and tell** (decision 26; no build change): `updates.mjs` (signature, parsing, rules 1
   to 5, `updateNotice`, the steps per install type), `update-keys.mjs` (the pinned public keys,
   empty until the key ceremony in `docs/runbook.md`), `[updates] check` in `config.mjs`, the
   action `app.update_check` and `:update`, the status bar's update segment,
   `vimma/updates/VimmaUpdates.sys.mjs` (Vimma's own fetch for every packaged install, every
   12 hours and on `:update`), about:vimma's Updates section and its report line, and
   `app.update.interval` 43200. Tests: `updates.test.mjs`, `branding-prefs.test.mjs`,
   `browser_vimma_update_check.js` (a local manifest host and a key generated in the test).
2. **Build and keys** (mozconfig, the three patches, `keys.mjs` generation from the DER files, so
   that `update-keys.mjs` and the updater's certificates have one source, prefs, ADR-016, the
   ADR-003 register lines): done when a `VIMMA_UPDATES=1` build has
   `[AppUpdate] URL=https://updates.vimma.dev/…`, `update-settings.ini` says `vimma`, the `updater` binary
   contains Vimma's primary DER's bytes and not `dep1.der`'s, and the built updater applies a
   test-signed MAR from an installed tarball (rpath question answered).
3. **Host for Firefox's updater** (the `UpdateService-sys-mjs.patch` hook calling the same
   verifier, the staged notices, the urgent prompt, `:restart`, `updates: off` once per session,
   AppImage replacement, the anonymous MAR download, the control `state` field): the remaining
   mochitests.
4. **Packaging and pipeline** (`package.mjs`, `tools/update/`, `release.yml`, `nightly.yml`,
   `update-publish.yml`): workflow tests and a dry run. Lands after the
   build-supply-chain implementation, whose full builds this extends (decision 4).
5. **e2e and the security rehearsal**: the scenarios above; the M6a gate.

## Open questions

None. The questions this spec raised are answered in §8, decisions 16 to 23.
