# Spec: flatpak

Status: accepted (sub-PR 1 implemented; sub-PR 2, the Flathub submission, in
[#465](https://github.com/vimma-browser/vimma/issues/465)) · Area: `tools/package/flatpak.mjs`
(new), `tools/package/flatpak-smoke.sh` (new), `.github/workflows/flatpak.yml` (new),
`docs/runbook.md`, `docs/security.md` · Upstream patches: none · ADR: none

Issues: [#295](https://github.com/vimma-browser/vimma/issues/295),
[#465](https://github.com/vimma-browser/vimma/issues/465)

Engine paths are relative to `engine/` and were checked against Firefox 158.0. Flatpak facts were
checked with flatpak 1.18.4 and flatpak-builder 1.4.12 from Fedora 44 (`rpm -q` in the
`fedora:44` image), against Flathub on 2026-10-21 (`flatpak remote-info flathub …`), and by
building the 0.1.6 release tarball with `tools/package/flatpak-smoke.sh`.

## Summary

Vimma gets a Flatpak manifest, `dev.vimma.browser`, that repackages the release tarball on the
Freedesktop runtime, as Flathub builds Firefox-based browsers. CI builds, installs and runs it
for every pull request that changes the packaging and for every published release. Publishing
it on Flathub is a separate step (sub-PR 2), so that the listing goes public only when the
maintainer submits it.

## Problem

Release assets are a tarball, an AppImage, a `.deb` and a `PKGBUILD` (spec
[m6-packaging](m6-packaging.md)). None of them installs from a distribution's software centre
or updates with the rest of the system on every distribution. Flathub does both, and Zen,
LibreWolf and Floorp are published there. A Flathub submission needs a manifest that builds
and an app that runs in its sandbox; neither existed, and nothing would notice if a release
broke them.

## Behaviour

1. `node tools/package/flatpak.mjs --out DIR --version X.Y.Z --date YYYY-MM-DD --sha256 HEX`
   writes `dev.vimma.browser.json`, a flatpak-builder manifest that downloads
   `vimma-X.Y.Z-linux-x86_64.tar.xz` from the release `vX.Y.Z` and refuses it unless it has the
   given SHA-256, and the four files the manifest names: `vimma.sh`,
   `dev.vimma.browser.desktop`, `dev.vimma.browser.metainfo.xml` and `dev.vimma.browser.png`.
   With `--tarball FILE` in place of `--sha256`, the tarball is copied next to the manifest and
   named by file.
2. The built app installs Vimma in `/app/lib/vimma`, with `is-packaged-app` reading
   `vimma-package=flatpak`, and `/app/bin/vimma`, which starts it with `--name
dev.vimma.browser`. The desktop file, the metainfo and the icons (16 to 128 px from the
   tarball, 512 px from `configs/branding/vimma/`) are named after the app id.
3. `flatpak run dev.vimma.browser --version` prints the release's version line.
4. Inside the sandbox, `config.toml` is `~/.var/app/dev.vimma.browser/config/vimma/config.toml`
   and the profiles are in `~/.var/app/dev.vimma.browser/config/vimma/vimma/`. The Omarchy
   theme in `~/.local/state/omarchy/current/theme` is read, never written.
5. `flatpak.yml` builds a stub tarball's Flatpak on every pull request that changes
   `tools/package/`, the branding, `surfer.json` or the workflow, and the published release's
   Flatpak when a release is published or when run by hand with a tag. Each run checks the
   version line, the marker, the exported desktop file (`desktop-file-validate`) and the metainfo
   (`appstreamcli validate`); a release run also starts Vimma headless and takes a screenshot.

## Research

- **Mozilla's own Flatpak.** `mach repackage flatpak` builds Firefox's Flatpak from the release
  tarball on `org.freedesktop.Platform` 25.08 (`FREEDESKTOP_VERSION`,
  `python/mozbuild/mozbuild/repackaging/flatpak.py:25`) with the permissions at lines 245-270,
  and its launcher passes `--name org.mozilla.firefox`
  (`browser/installer/linux/app/flatpak/files/bin/firefox.in`).
- **The BaseApp.** Mozilla's Flatpak copies in `org.mozilla.firefox.BaseApp`
  (`flatpak.py:27,107-137`). On Flathub that BaseApp is marked end-of-life with the note that
  it is meant to be used by Firefox and Thunderbird (`flatpak remote-info --log flathub
app/org.mozilla.firefox.BaseApp/x86_64/25.08`, commit `7d5a63c8…`).
- **The runtime alone is enough.** The 0.1.6 tarball, built on `org.freedesktop.Platform` 25.08
  without the BaseApp, prints its version line and renders a page headless
  (`flatpak-smoke.sh --release`).
- **D-Bus names.** Firefox owns `org.mozilla.<name>.<profile>` for remoting, where `<name>` is
  the lower-cased application name (`xpcom/glue/XREAppData.cpp:50-59`,
  `toolkit/components/remote/nsDBusRemoteServer.cpp:202`), `org.mozilla.vimma` for Vimma, and
  MPRIS names under `org.mpris.MediaPlayer2.firefox` (`widget/gtk/MPRISServiceHandler.h:16`).
- **Paths in the sandbox.** Flatpak sets `XDG_CONFIG_HOME` to
  `~/.var/app/dev.vimma.browser/config` and `XDG_STATE_HOME` to
  `~/.var/app/dev.vimma.browser/.local/state`; `HOME` stays the real home, whose contents are
  hidden unless granted (checked with `flatpak run --command=sh`). Vimma's `config.toml` and its
  profiles follow `XDG_CONFIG_HOME` (`config/ConfigHost.sys.mjs`), so they land under
  `~/.var/app/`. The Omarchy theme path is `~/.local/state/omarchy/current/theme` from the real
  `HOME` (`ui/theme-host.mjs`, `DEFAULT_PATH`), and Vimma polls it every 2 seconds, so a read-only
  grant is enough for live theme changes.
- **AppStream icons.** `configs/branding/vimma/logo.svg` wraps a PNG behind a licence comment;
  `appstreamcli compose`, which flatpak-builder runs, fails on it with `file-read-error`. The
  512 px PNG passes.
- **Updates.** Firefox's updater stands aside in a Flatpak, since `isPackagedApp` is true there
  (spec [m6a-updater](m6a-updater.md), section 3). Vimma's update check reads the marker:
  `vimma-package=flatpak` is not a type it knows, so it gives `packaged`
  (`packages/vimma-core/src/updates.mjs`, `installTypeFrom`), whose hint names the tool the user
  installed with and never runs a command.

## Design

1. **Repackage the release tarball, not a source build.** The manifest's one module unpacks the
   tarball `release.yml` built and signed, because that is the binary every other package
   carries, and Flathub accepts browsers built this way. Rejected: building Firefox from source
   in Flathub's builder, because it would be a second build of each release, hours long, on
   infrastructure the release checks do not cover.
2. **The Freedesktop 25.08 runtime, without Mozilla's BaseApp.** Reason: it is the runtime
   Mozilla's own Flatpak uses, the tarball runs on it alone, and the BaseApp is end-of-life for
   anything but Firefox and Thunderbird.
3. **App id `dev.vimma.browser`.** It is `surfer.json`'s `appId`, already the macOS bundle
   identifier, so the id names the same app on every platform, and Flathub's verification of
   `vimma.dev` covers it.
4. **`--name dev.vimma.browser` in the launcher.** GTK takes it as the program name, so the
   Wayland app id and the X11 class match the desktop file, as Mozilla's launcher does. The
   desktop file's `StartupWMClass` says the same.
5. **Firefox's sandbox permissions, plus the Omarchy theme read-only.** The manifest grants what
   Mozilla's Flatpak grants (network, display, sound, smart cards, printing, devices, Downloads,
   GTK settings read-only, Kerberos, speech, the portals' D-Bus names), the D-Bus names Vimma
   owns, and `~/.local/state/omarchy` read-only, so that the status bar follows the desktop's
   theme as in the other packages. Rejected: `--allow=devel`, which lifts the sandbox's block on
   `ptrace` and `perf`, because Vimma needs neither; `--persist=.mozilla`, because
   Vimma keeps nothing there; the home directory or `~/.config/vimma`, because a Flatpak and
   another install of Vimma would then share one profile, which Firefox refuses to open in an
   older version once a newer one has used it.
6. **No vimma-open.** The desktop file runs `vimma %u`. Reason: vimma-open walks `/proc` up to
   the app that opened a link (spec [workspace-routing](workspace-routing.md)), and inside the
   sandbox's PID namespace that walk ends at Flatpak's own processes, so every link would count
   as opened by no app. Routing by app does not apply to the Flatpak; routing by URL does.
7. **The marker `vimma-package=flatpak`, with no new install type yet.** The update check then
   gives `packaged` and its generic hint, never the tarball's unpack command, which would write
   into the read-only `/app`. Reason: no user can install this Flatpak until it is on Flathub,
   and the right hint (`flatpak update`, or no notice, since Flathub updates the app) belongs
   with the submission in sub-PR 2.
8. **CI in its own workflow, after the release is published.** `flatpak.yml` builds a stub on
   pull requests and the real release once it is public, from the URL Flathub would download.
   Reason: the Flatpak is not a release asset, so a failure must not hold back a release, and
   the release's public download URL is the input Flathub's builder gets. Rejected: a step in
   `release.yml`'s `package` job, because a broken Flatpak would then stop every Linux asset
   from being signed and uploaded.
9. **Built in a Fedora container, pinned by digest, on runtimes pinned by commit.** The smoke
   script runs `flatpak-builder` from Fedora 44 in a privileged container, because Flatpak's
   sandbox needs user namespaces, which Ubuntu 24.04's AppArmor withholds from unprivileged
   processes on GitHub's runners. The runtime and SDK are pinned to Flathub commits with
   `flatpak update --commit`, so a run builds on exactly the runtime it names; related refs
   (GL drivers, codecs, translations) are not installed, since they would come unpinned and
   nothing in the smoke test needs them. Rejected: `org.flatpak.Builder` from Flathub, which
   also brings `flatpak-builder-lint`, because it adds the 26.08 SDK and its own BaseApp, about
   a gigabyte more on every run; Flathub runs the linter on the submission (sub-PR 2).

## Security and privacy

`flatpak.yml` holds no secret, deploys to no environment, and its jobs have `contents: read`
only. Its release job reads `SHA256SUMS` from the release's public download URL, which answers
only for a published release, and with signing on verifies `SHA256SUMS` against release.yml's
identity (`IDENTITY_REGEXP`) before it pins the tarball's SHA-256 in the manifest;
flatpak-builder refuses a download with any other hash. A release event runs the tag's copy of
the workflow, which holds the same read-only token, so a tag cannot obtain more. The Fedora
image is pinned by digest and the runtimes by commit; the Fedora packages come from Fedora's
signed repositories at their current versions. The manifest's build commands are fixed strings:
the version and SHA-256 are validated and appear only in the source's URL and hash. Nothing is
published. In the sandbox, Vimma can read the Omarchy theme but not write it, and cannot reach
`~/.config/omarchy/hooks`, so it never installs the Omarchy hook (docs/security.md, section 7).
The control socket listens on 127.0.0.1 as in the other packages; with `--share=network` the
sandbox shares the host's loopback, so `vimma-ctl` on the host can reach it with
`XDG_CONFIG_HOME=~/.var/app/dev.vimma.browser/config` (not checked end to end).

## Tests

- vitest, `tools/package/test/flatpak.test.mjs`: the manifest group (`names the app surfer.json's
appId and runs on the Freedesktop 25.08 runtime`, `takes the release tarball from the tag's
download URL, pinned by SHA-256`, `refuses %s`, `grants Firefox's Flatpak permissions and the
Omarchy theme read-only, never the home`, `installs Vimma in /app/lib/vimma with the flatpak
marker, the launcher and its files`, `puts no input into a build command, so none can change
what the build runs`), the desktop entry, launcher and metainfo groups, `writeFlatpak`, the
  install type, `flatpak-smoke.sh` and `flatpak.yml`.
- CI: `flatpak.yml`'s `stub` job on pull requests and its `release` job on published releases.

## Docs and changelog

`docs/runbook.md`, "Flatpak": what CI builds and how to submit to Flathub. `docs/security.md`,
B12. `docs/guide.md` and `docs/limits.md` change with sub-PR 2, when users can install it.
Changelog: `ci: build and run a Flatpak of each release (not yet on Flathub)`.

## Delivery

1. The manifest generator, the smoke script and `flatpak.yml` (#295).
2. The Flathub submission (#465): the `flatpak` install type and its update hint, screenshots in
   the metainfo, `flatpak-builder-lint`, the guide and limits, and the submission itself, which
   the maintainer starts.

## Open questions

None. When to submit to Flathub is a release decision, tracked in #465.
