# Spec: rpm-package

Status: implemented · Area: `tools/package/package.mjs`, `tools/package/rpm-smoke.sh`,
`.github/workflows/release.yml`, `.github/workflows/pkgbuild.yml`,
`.github/workflows/update-publish.yml`, `tools/update/manifest.mjs`,
`packages/vimma-core/src/updates.mjs` · Upstream patches: none · ADR: none

Issue: [#294](https://github.com/vimma-browser/vimma/issues/294)

## Summary

Each Linux release also carries `vimma-X.Y.Z-1.x86_64.rpm`, one package that installs with dnf
on Fedora and with zypper on openSUSE and lays Vimma out as the `.deb` does. Users of those
distributions get a package-manager install that pulls in its libraries and can be removed
cleanly, instead of the AppImage or the tarball.

## Problem

Release assets are a tarball, an AppImage, a `.deb` and a `PKGBUILD` (spec
[m6-packaging](m6-packaging.md)). On Fedora and openSUSE the `.deb` does not install, so users
run the AppImage, which their package manager does not know about, or unpack the tarball,
whose libraries they install by hand.

## Behaviour

1. `tools/package/package.mjs` writes `vimma-X.Y.Z-1.x86_64.rpm` next to the other assets
   (`vimma-X.Y.Z~pre-1.x86_64.rpm` for a pre-release), unless it is given `--no-rpm`.
2. The package installs `/usr/lib/vimma`, `/usr/bin/vimma`, `/usr/bin/vimma-open`, the desktop
   file `vimma-vimma.desktop`, the hicolor icons and `/usr/share/doc/vimma/copyright`, the same
   files as the `.deb`, and `/usr/lib/vimma/is-packaged-app` with `vimma-package=rpm`.
3. `sudo dnf install ./vimma-X.Y.Z-1.x86_64.rpm` on Fedora and
   `sudo zypper install --allow-unsigned-rpm ./vimma-X.Y.Z-1.x86_64.rpm` on openSUSE install it
   with its requirements, and `vimma --version` prints the release's version line.
4. `SHA256SUMS` lists the `.rpm`, the `sign` job gives it a cosign bundle, and `publish` uploads
   it with the other assets.
5. The update manifest for `Linux_x86_64-gcc3` lists the `.rpm` with its size and SHA-512 in a
   `<vimmaRpm>` element, and `:update` on an `.rpm` install shows two commands that download
   it, check its SHA-512 and install it, one with dnf and one with zypper. `about:vimma` names
   the install type `.rpm`.
6. Every pull request that changes `tools/package/` builds an `.rpm` from a stub tarball and
   installs it on Fedora and openSUSE (`pkgbuild.yml`, job `rpm`); `release.yml`'s `package`
   job does the same with the release build before anything is signed, and also starts Vimma
   headless there and takes a screenshot.

## Research

- **Tooling.** `rpmbuild` 4.18.2 is in Ubuntu 24.04's archive as the package `rpm`
  (`4.18.2+dfsg-2.1build2`, checked with `dpkg -s rpm` in `ubuntu:24.04`). Its licence is
  GPL-2.0-or-later, with LGPL-2.0-or-later for the libraries (`/usr/share/doc/rpm/copyright`);
  it is a build tool and nothing of it ships in the package. Its ELF dependency generator
  (`/usr/lib/rpm/fileattrs/elf.attr`, `elfdeps`) runs there as on Fedora.
- **Requirements.** On the 0.1.6 release tarball, rpmbuild's scan gives sonames only
  (`libgtk-3.so.0()(64bit)`, `libasound.so.2()(64bit)`, `libc.so.6(GLIBC_2.34)(64bit)`,
  `libstdc++.so.6(GLIBCXX_3.4.29)(64bit)` …) plus `/bin/sh` for `vimma-open`. With the bundled
  libraries excluded (Design, decision 3), dnf 5.4.3 on Fedora 44 and zypper 1.14.101 on
  openSUSE Leap 16.0 resolve all of them; Vimma then starts headless and renders a page on
  both (checked with `tools/package/rpm-smoke.sh` on that tarball).
- **Signatures.** dnf 5.4.3 installs a local unsigned package with the warning "skipped OpenPGP
  checks for 1 package from repository: @commandline". zypper 1.14.101 aborts with "Signature
  verification failed [6-File is unsigned]" unless given `--allow-unsigned-rpm`. Both checked in
  the containers above.
- **Caches.** On Fedora 44, `desktop-file-utils` and `gtk3` refresh the desktop database and
  the hicolor icon cache from rpm file triggers on `/usr/share/applications` and
  `/usr/share/icons/hicolor`; on Leap 16.0, `desktop-file-utils` and `gtk3-tools` do the same
  (`rpm -q --filetriggers`). Fedora's `firefox` provides `webclient` (`dnf repoquery
--provides firefox`).
- **Versions.** rpm allows no `-` in a Version and sorts `~` before the release since rpm 4.10
  (`rpmlib(TildeInVersions)`); Fedora 44 has rpm 6.0.2 and Leap 16.0 rpm 4.20.1.

## Design

1. **rpmbuild from a staged root, as the `.deb` is built with dpkg-deb.** `package.mjs` stages
   the `.deb`'s layout without `DEBIAN/` and writes a spec whose `%install` copies the staged
   root into the build root, then runs `rpmbuild -bb --target x86_64`. Reason: one packaging
   path, testable without a container, and the same files in both packages. Rejected: nfpm or
   fpm, because each is a new tool to pin and licence-check for what rpmbuild, a distribution
   package, already does; building inside a Fedora container, because the package job would
   then depend on a container for the build as well as for the test.
2. **One `.rpm` for Fedora and openSUSE.** Reason: the files and the binaries are the same for
   both, and soname requirements resolve on both. Rejected: one package per distribution,
   because nothing in them would differ but the name.
3. **Requirements are rpmbuild's soname scan, minus the bundled libraries.** The spec keeps
   automatic requirements and sets `__requires_exclude` to the base names of every shared
   library in `/usr/lib/vimma` (each ending at the `(` of its qualifiers), and
   `__provides_exclude_from` to `/usr/lib/vimma/`. Reason: Fedora and openSUSE name their
   packages differently (`gtk3` and `libgtk-3-0`) but provide the same sonames, so a list of
   package names like the `.deb`'s `Depends` would need two packages. Without the exclusion the
   package would require `libxul.so()(64bit)`, which only it has, and would offer its own
   `libnss3.so` to every other package's resolve. `Requires: hicolor-icon-theme` covers the icon
   directories, and `Recommends: libpulse.so.0()(64bit)` the sound library Firefox loads at run
   time, which the scan cannot see.
4. **No strip, no debuginfo, no build-id links.** `debug_package` and `__os_install_post` are
   `%{nil}` and `_build_id_links` is `none`, so that rpmbuild leaves mach's binaries as they are
   and adds no `/usr/lib/.build-id` files that could clash with another package.
5. **No scriptlets.** The `.rpm` runs nothing at install or removal, because Fedora and openSUSE
   refresh the desktop and icon caches with rpm file triggers, and neither has the Debian
   `x-www-browser` alternative the `.deb`'s `postinst` registers. `Provides: webclient`, as
   Fedora's own Firefox package has, marks it as a web browser.
6. **Unsigned, as the `.deb`.** The package has no OpenPGP signature; `SHA256SUMS` and its
   cosign bundle vouch for it, and the update command checks the SHA-512 from the signed
   manifest. Reason: a signing key would need its own custody and a published public key for
   one package format, the cost decision 20 of [m6a-updater](m6a-updater.md) weighed for an apt
   repository. Its consequence is the `--allow-unsigned-rpm` in every zypper command.
7. **Release `1`, xz payload.** Every Vimma version is packaged once, so its Release is always
   `1`; the payload is xz (`w6.xzdio`), as the `.deb`, which every supported Fedora and openSUSE
   reads.
8. **Updates as the `.deb`.** The marker `vimma-package=rpm` gives the install type `rpm`, and
   `:update` shows a dnf and a zypper command, each downloading the new `.rpm`, checking it with
   `sha512sum -c` and installing it. Reason: there is no Vimma repository for dnf or zypper, as
   there is none for apt (m6a-updater, decision 20). The manifest lists the `.rpm` as a
   required asset, so every release from this one on carries it; a release before it cannot be
   re-published from `main` (docs/runbook.md, "Re-run, pull an update, and serials").
9. **Smoke-tested on Fedora 44 and openSUSE Leap 16.0, pinned by digest.** Reason: those are
   the current releases of each, and each run installs the release's current packages, so a
   digest only fixes the base image. Tumbleweed was not chosen, because its rolling repository
   would change what the test means from one day to the next.

## Security and privacy

The `.rpm` is a new release asset under the same rules as the others (docs/security.md, B9):
listed in `SHA256SUMS`, signed by the `sign` job, built and installed before anything is signed.
The spec generator places the staged root's path in a shell command and two values in rpm
macros unquoted, so it accepts only an absolute path of `[A-Za-z0-9._/-]` and library names of
`[A-Za-z0-9._+-]`, the output directory only as a path of `[A-Za-z0-9._/-]`, and the maintainer
line only as `Name <email>` without `%`, since rpm expands macros in tag values and in its
`--define` values. The update command for it is
held to UP8: `curl -f --proto =https`, then `sha512sum -c` before dnf or zypper runs. The new
CI inputs are `rpm` from Ubuntu's archive and the `fedora` and `opensuse/leap` images, pinned by
digest; none of them runs with a secret or a write token.

## Tests

- vitest, `tools/package/test/package.test.mjs`: `maps a pre-release for rpm (~ sorts first
there too)`, `names every artifact after the Vimma version, not Firefox's`, the `RPM spec`
  group, `stages the .rpm root as the .deb's, without dpkg's control files`, `builds an .rpm
that rpm can read, owned by root` (where rpmbuild is installed), `every package type except
the tarball carries the marker`, `install-type.mjs names each staged package as the update
check would`.
- vitest, `packages/vimma-core/test/updates.test.mjs`: the install type for
  `vimma-package=rpm`, `refuses a <vimmaRpm> with %s`, `rpm: download and check it, then
install it with dnf or zypper`.
- vitest, `tools/update/test/manifest.test.mjs` and `update-workflow.test.mjs`: the manifest's
  `<vimmaRpm>` and the downloaded file list.
- vitest, `tools/package/test/rpm-smoke.test.mjs`: the smoke script and its wiring in
  `release.yml` and `pkgbuild.yml`.
- CI: `pkgbuild.yml`'s `rpm` job (stub), `release.yml`'s "Smoke test the .rpm on Fedora and
  openSUSE" (release build).

## Docs and changelog

`README.md` (Install, Status), `docs/guide.md` ("Installing", "Fedora and openSUSE", "Updates"),
`docs/runbook.md` (release assets, jobs, local packaging, manifests), `docs/limits.md`,
`docs/security.md` (B9, UP6, UP8). Changelog: "packaging: an .rpm for Fedora and openSUSE".

## Delivery

One pull request.

## Open questions

None.
