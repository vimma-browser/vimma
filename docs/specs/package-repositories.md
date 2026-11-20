# Spec: package-repositories

Status: draft · Area: `tools/package/repos.ts` (new), `tools/package/repos-smoke.sh` (new),
`tools/package/package.ts`, `.github/workflows/release.yml`,
`.github/workflows/update-publish.yml`, `.github/workflows/pkgbuild.yml`,
`packages/vimma-core/src/updates/updates.mjs`, `vimma-browser/vimma-updates` (`public/`),
`docs/security/14-build-and-release-supply-chain.md`, `docs/security/16-update-check.md` ·
Upstream patches: none · ADR: none

Issue: [#1417](https://github.com/vimma-browser/vimma/issues/1417)

## Summary

Vimma publishes signed package repositories for apt (Debian, Ubuntu), dnf and zypper (Fedora,
openSUSE) and pacman (Arch Linux). After a one-time setup, `sudo apt upgrade`,
`sudo dnf upgrade`, `sudo zypper up` and `sudo pacman -Syu` update Vimma with the rest of the
system, and the package manager checks an OpenPGP signature on what it installs. Today every
update of a `.deb`, `.rpm` or `PKGBUILD` install is a download and a reinstall by hand.

## Problem

Each release ships `vimma_X.Y.Z_amd64.deb`, `vimma-X.Y.Z-1.x86_64.rpm` and a `PKGBUILD` for
`vimma-bin` (specs [m6-packaging](m6-packaging.md) and [rpm-package](rpm-package.md)). None of
them comes from a repository, so:

- The system's upgrade command never updates Vimma. Vimma's update check notices a new release
  and shows a command that downloads the package, checks its SHA-512 and installs it
  (`updateSteps` in `packages/vimma-core/src/updates/updates.mjs`), which the user runs by hand
  for every release.
- The packages carry no OpenPGP signature (rpm-package, decision 6). `SHA256SUMS` and its cosign
  bundle vouch for them, but only for a user who runs `cosign verify-blob`. zypper refuses the
  `.rpm` unless given `--allow-unsigned-rpm`, and dnf warns that it skipped the OpenPGP check.
- Arch Linux users build `vimma-bin` themselves with `makepkg` from the release's `PKGBUILD`,
  about 450 MB of disk while it builds (`docs/guide.md`, "Arch Linux"). The AUR copy of the
  package cannot be published yet, because the project has no AUR account; `aur.yml` is ready
  for it.

[m6a-updater](m6a-updater.md) decision 20 deferred an apt repository because it is a second
signing system with its own key custody and hosting. With three package formats and an
alpha audience on Linux distributions, one signing system for all three is worth that cost.

## Behaviour

1. **apt.** After the setup below, `sudo apt update && sudo apt install vimma` installs Vimma,
   and `sudo apt upgrade` installs each newer release. The setup is one file:

   ```sh
   curl -fsSL https://updates.vimma.dev/apt/vimma.sources \
     | sudo tee /etc/apt/sources.list.d/vimma.sources
   ```

   The file is deb822 with the public key inline in `Signed-By`, so it trusts the key for this
   repository only, never for the rest of the system.

2. **dnf.** `sudo dnf config-manager addrepo --from-repofile=https://updates.vimma.dev/rpm/vimma.repo`,
   then `sudo dnf install vimma`; `sudo dnf upgrade` installs each newer release. dnf shows the
   key's fingerprint and asks once before trusting it.
3. **zypper.** `sudo zypper addrepo https://updates.vimma.dev/rpm/vimma.repo`, then
   `sudo zypper refresh && sudo zypper install vimma`, without `--allow-unsigned-rpm`;
   `sudo zypper up` installs each newer release. zypper shows the fingerprint and asks once.
4. **pacman.** The user imports the key with
   `curl -fsSL https://updates.vimma.dev/vimma-packages.asc | sudo pacman-key --add -` and
   trusts it with `sudo pacman-key --lsign-key <fingerprint>`, adds

   ```ini
   [vimma]
   Server = https://updates.vimma.dev/arch/$arch
   ```

   to `/etc/pacman.conf`, then runs `sudo pacman -Syu vimma-bin`. `sudo pacman -Syu` installs
   each newer release. No `makepkg` build runs on the user's machine.

5. **Signatures are checked.** Each package manager refuses metadata or a package whose
   signature is missing, made by another key, or does not match, and refuses a package whose
   checksum differs from the signed metadata. The guide prints the key's full fingerprint next
   to each setup command, so a user can compare it with what dnf, zypper or `pacman-key` shows.
6. **Every release, no pre-release.** A published release is in every repository within the
   run of `update-publish.yml` that publishes its update manifest. A pre-release or a draft is
   never added, as `update-publish.yml` already refuses them for the manifest.
7. **Update-check hints.** For a `.deb`, `.rpm` or pacman-repository install whose repository
   is set up, `:update` and `about:vimma` show the package manager's upgrade command
   (`sudo apt update && sudo apt upgrade`, `sudo dnf upgrade vimma`, `sudo zypper up vimma`,
   `sudo pacman -Syu`) instead of the download command. A `.deb` or `.rpm` installed without the
   repository keeps today's download command (and see open question 4).
8. **Downloads stay on GitHub.** Package files are downloaded from the GitHub Release. The
   update host serves only the metadata, the key and the setup files, and redirects package
   requests to the release's download URL.

## Research

Facts this design depends on, with how each was checked. No container runtime was available
where this research ran, so apt, dnf and zypper were checked in their source code and manual
pages, not run; the smoke test of sub-PR 1 runs each of them.

- **pacman follows redirects, to HTTPS too.** pacman 7.1.0 (libalpm 16.0.1) on Arch Linux,
  checked by building a stub `vimma-bin` with `makepkg --sign` and a throwaway key, building a
  database with `repo-add --sign` (repo-add 7.1.0), and serving it from a local HTTP server
  that answers each package request with `302`. `pacman -Syw` downloaded the package through
  the redirect and checked its signature. With the redirect pointing at
  `https://github.com/vimma-browser/vimma/releases/download/v0.1.22/SHA256SUMS`, pacman followed
  both hops (to github.com, then to `release-assets.githubusercontent.com`) and refused the file
  as "invalid or corrupted package (checksum)", which shows it fetched it over HTTPS. A redirect
  loop stopped at "Maximum (10) redirects followed".
- **pacman fetches a package's `.sig` from the server.** repo-add 7.1.0 leaves package
  signatures out of the database unless given `--include-sigs` (`repo-add(8)`; the test
  database had no `%PGPSIG%` entry), so pacman downloads `<package>.sig` next to the package.
  In the test it asked the repository's `Server` URL for the `.sig` when the redirect target's
  file name differed from the package's, and the redirect target's directory when the names
  matched. Either way the `.sig` must be a release file and the host must redirect it too.
- **repo-add writes symlinks.** `vimma.db` and `vimma.files` are symlinks to
  `vimma.db.tar.gz` and `vimma.files.tar.gz`, and so are their `.sig` files (same test).
- **apt follows HTTPS redirects, never to plain HTTP.** apt 2.7.14 (Ubuntu 24.04's release
  version), `methods/basehttp.cc`: lines 339–346 follow 301, 302, 303, 307 and 308 when
  `AllowRedirect` is set, which defaults to true (line 640); line 435 refuses a redirect from
  `https` to another scheme. Checked in the Debian/apt source at tag 2.7.14, not run.
- **apt takes a key inline in `Signed-By`.** `sources.list(5)` documents an ASCII-armoured key
  block as the value of `Signed-By` in a deb822 `.sources` file at apt 2.4.5 (Ubuntu 22.04),
  2.6.1 (Debian 12) and 2.7.14; and a flat repository as a `Suites` value that is an exact
  path (`./`) with no `Components`. Checked in the manual page source at those tags.
- **dnf follows redirects and checks repository metadata on request.** librepo 1.7.20,
  `librepo/handle.c` lines 59–60, sets `CURLOPT_FOLLOWLOCATION` and `CURLOPT_MAXREDIRS 6`.
  dnf5 5.4.3 (Fedora 44's, per [rpm-package](rpm-package.md)), `dnf5.conf(5)`:
  `repo_gpgcheck` checks the signature on `repomd.xml`, defaults to off, and keeps the keys for
  it apart from the package keys, per repository, so dnf may ask to import the same key twice;
  `gpgkey` lists key URLs imported when a signature cannot be checked with the keys already
  imported. Checked in source; which librepo Fedora 44 ships was not checked.
- **zypper follows redirects.** libzypp 17.38.9 sets `CURLOPT_FOLLOWLOCATION` and
  `CURLOPT_MAXREDIRS 6` (`zypp/zypp/media/MediaCurl.cc` lines 352–354,
  `zypp-logic/zypp-curl/ng/network/request.cc` lines 221–223). Checked in source; the libzypp
  version in openSUSE Leap 16.0 was not checked.
- **zypper and dnf on unsigned packages.** zypper 1.14.101 refuses an unsigned local `.rpm`
  without `--allow-unsigned-rpm`; dnf 5.4.3 installs it with a warning (rpm-package,
  "Research").
- **GitHub's release URLs redirect once.** `curl -I` on
  `https://github.com/vimma-browser/vimma/releases/download/v0.1.22/SHA256SUMS` answers `302`
  to a signed `release-assets.githubusercontent.com` URL (checked 2026-11-20). With the update
  host's redirect in front, a package download takes two redirects, under libcurl's limit of 6
  that librepo and libzypp set and pacman's 10.
- **The update host can redirect without a script.** `vimma-browser/vimma-updates` is a
  Cloudflare Worker with static assets only (`wrangler.jsonc` has `assets.directory` and no
  `main`; checked with `gh api`). Workers static assets read a `_redirects` file: a placeholder
  (`:name`) matches one path segment, a rule may redirect to an absolute URL on another host,
  302 is the default status, redirects apply before an asset match, and a file holds at most
  2,000 static and 100 dynamic rules
  ([Cloudflare's documentation](https://developers.cloudflare.com/workers/static-assets/redirects/),
  read 2026-11-20). The host already has a `_headers` file (`docs/runbook/ci-update-keys-and-update-host.md`,
  step 1).
- **Release jobs.** `release.yml`'s `package` job writes `SHA256SUMS` with `package.ts` and
  checks it (`sha256sum -c`); the `mar` job rewrites it to add the signed MAR; `sign` gives every
  `dist/vimma*` file, `PKGBUILD`, `SRCINFO` and `SHA256SUMS` a cosign bundle. Signing an `.rpm`
  rewrites its header, so it changes the file's checksum and must happen before `SHA256SUMS` is
  final. `update-publish.yml` refuses a draft or a pre-release (its `prepare` job,
  `isDraft`/`isPrerelease` check).
- **Sizes.** In release 0.1.22 the `.deb` is 89,779,500 bytes and the `.rpm` 89,175,241
  (`gh release view v0.1.22 --json assets`).
- **Install type.** `installTypeFrom` (`packages/vimma-core/src/updates/updates.mjs`) reads
  `vimma-package=<type>` from `/usr/lib/vimma/is-packaged-app` (or `/opt/vimma/` for the
  `PKGBUILD`); the `.deb` and `.rpm` from a release and from a repository are the same file, so
  the marker cannot tell them apart.

## Design

### Key

1. **One OpenPGP key for all three formats.** A primary key that only certifies, kept offline
   by the maintainer, and one signing subkey that signs apt's `InRelease`, every `.rpm`,
   `repomd.xml`, the pacman package and the pacman database. Reason: one fingerprint in the
   guide, one custody procedure and one rotation, where a key per format would triple each.
   The offline primary can revoke and replace the subkey without users trusting a new key,
   because dnf, zypper, apt and pacman trust the primary key's certificate, which carries the
   new subkey once it is refreshed. Rejected: reusing the update key (Cloud KMS, RSA PKCS#1
   over a SHA-384 digest), because it signs Mozilla update manifests and MARs in a format
   GnuPG and rpm do not produce, and a key that signs two kinds of data lets a signature on
   one be presented as the other.
2. **The subkey is a secret of a `package-signing` environment that admits `main` only, used
   by jobs that run no repository code.** The signing jobs install `gnupg` and `rpm` from
   Ubuntu's archive, import the subkey, sign, check each signature with the public key, and
   upload. Reason: the same separation the update key's `sign` and `mar-sign` jobs have
   (`update-publish.yml`, header), so a change to a repository script cannot reach the key,
   and a run on another branch or tag cannot deploy to the environment. Where the subkey lives
   (a secret or Cloud KMS) is open question 7.
3. **The public key is published three times.** In this repository as
   `configs/package-signing/vimma-packages.asc`, on the update host as
   `https://updates.vimma.dev/vimma-packages.asc`, and inline in the apt `.sources` file.
   `update-publish.yml` checks that the host's copy and the inline copy equal the committed
   file before it pushes, so the key a user downloads is the one a reviewed pull request
   added. The guide prints its full fingerprint.

### Repositories

4. **apt: a flat repository built with `apt-ftparchive`.** `apt-ftparchive packages` writes
   `Packages` (and `Packages.xz`) with `Filename: pool/vX.Y.Z/vimma_X.Y.Z_amd64.deb`,
   `apt-ftparchive release` writes `Release`, and `gpg --clearsign` makes `InRelease`. Users
   point a deb822 `.sources` file at `https://updates.vimma.dev/apt/` with `Suites: ./`.
   Reason: one architecture and one package need no suites or components, and a flat
   repository is the smallest layout every supported apt reads. Rejected: reprepro or aptly,
   because each keeps a database between runs, which a release workflow that starts from an
   empty runner would have to store; a detached `Release.gpg` as well, because every apt that
   reads deb822 reads `InRelease`.
5. **rpm: one repository for dnf and zypper, with signed packages and signed metadata.**
   `createrepo_c` writes `repodata/` with `location href="packages/vX.Y.Z/vimma-X.Y.Z-1.x86_64.rpm"`,
   `gpg --detach-sign --armor` writes `repodata/repomd.xml.asc`, and `repodata/repomd.xml.key`
   is the public key, which zypper reads. `vimma.repo` sets `gpgcheck=1`, `repo_gpgcheck=1` and
   `gpgkey=https://updates.vimma.dev/vimma-packages.asc`. Reason: the `.rpm` is already one
   package for both distributions (rpm-package, decision 2), and both read the same
   `repodata`. Package signatures protect a package downloaded alone; the metadata signature
   protects the list of packages, so both are checked.
6. **The `.rpm` is signed in `release.yml`, before `SHA256SUMS` is final.** A new
   `package-sign` job runs after `package`, takes the `release` artifact, signs the `.rpm` with
   `rpmsign --addsign`, checks it with `rpm -K` against the public key, checks that its payload
   digest did not change, and writes `SHA256SUMS` again; `mar` and `sign` then build on its
   output. Reason: signing rewrites the `.rpm`'s header, so a signature added after
   `SHA256SUMS`, the cosign bundles or the update manifest would leave them naming a file the
   release no longer has. The `.deb` stays unsigned as a file, because apt checks it through
   the SHA-256 in the signed `Packages` and has no per-package signature that `apt` verifies.
7. **pacman: a binary package built in `release.yml`, signed, in a `vimma` database.** The
   `package` job builds `vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst` from the release's `PKGBUILD` in
   the `archlinux` image that `arch-smoke.sh` already pins, with the release tarball placed in
   the build directory so `makepkg` uses it instead of downloading it; the marker it writes is
   `vimma-package=pacman`. `package-sign` adds its detached signature
   (`vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst.sig`), and both are release files that `SHA256SUMS`
   lists and `sign` gives cosign bundles. `update-publish.yml` builds the database with
   `repo-add` in the same image and signs `vimma.db` and `vimma.files` with
   `gpg --detach-sign`. Reason: a prebuilt package spares each user the build and its 450 MB,
   and a signed database lets pacman's default `SigLevel` check it. The package is named
   `vimma-bin`, the AUR's name, so a `PKGBUILD` install moves to the repository on its next
   `pacman -Syu` without removing anything. Rejected: building in the user's `makepkg` from a
   repository of `PKGBUILD`s, because pacman has no such repository type.
8. **Metadata only on the update host; package requests redirect to the GitHub Release.** The
   host serves `/apt/`, `/rpm/` and `/arch/x86_64/` metadata, `vimma-packages.asc` and the setup
   files. Its `_redirects` file sends package requests to
   `https://github.com/vimma-browser/vimma/releases/download/<tag>/<file>`: one dynamic rule
   each for `/apt/pool/:tag/:file` and `/rpm/packages/:tag/:file`, which carry the tag in the
   path for that purpose, and two static rules per published pacman version (the package and
   its `.sig`), because pacman asks for a bare file name next to the database. Reason: a
   release's packages are about 270 MB, which the host's git repository would grow by on every
   release, and GitHub already serves them; integrity does not depend on the host or GitHub,
   because the signed metadata pins each package's checksum. Every client checked follows
   redirects to HTTPS (Research).
9. **The host serves files, never symlinks.** The publish step copies `repo-add`'s
   `vimma.db.tar.gz` to `vimma.db` (and the same for `vimma.files` and the signatures), because
   how a symlink committed to `vimma-updates` reaches Cloudflare's asset upload was not
   checked, and copies leave nothing to check.
10. **Metadata is rebuilt from the release files each time.** For every version the metadata
    keeps (open question 2), `update-publish.yml` downloads that release's packages, checks them
    against its `SHA256SUMS` and that file's cosign bundle, as `prepare` does for the manifest,
    and builds the metadata from them in an empty directory. Reason: the result depends only on
    signed release files, never on what the host published before, so a tampered host cannot
    carry an entry into the next build; and it is the same build every run. Cost: about 90 MB
    per kept version per format, downloaded by a job that has no secret.
11. **`no-cache` on metadata.** `_headers` gives `/apt/*`, `/rpm/*` and `/arch/*` the same
    `Cache-Control: no-cache` as `/updates/*`, so that clients and Cloudflare see a new release
    at once. Packages are not cached by the host, because it only redirects them. A client that
    reads during a deploy may see a new `InRelease` with an old `Packages` once; apt then reports
    a hash mismatch and the next `apt update` succeeds.

### Publishing

12. **`update-publish.yml` publishes the repositories with the manifest.** A `repo-prepare` job
    (no secret) downloads and checks the release files and builds the unsigned metadata with
    `tools/package/repos.ts`; a `repo-sign` job (environment `package-signing`, no repository
    code) signs `Release`, `repomd.xml`, `vimma.db` and `vimma.files` and checks each
    signature; `publish` commits the metadata, the signatures, `_redirects` and `_headers` to
    `vimma-updates` in the same commit as the manifest. Reason: one commit makes the update
    check and the repositories announce a release at the same moment, and the job that holds
    the deploy key already exists (`update-publish` environment). Rejected: a separate
    workflow, because it would need a second deploy key or a second run of every check.
13. **Behind a repository variable.** Nothing is signed or pushed for the repositories until
    `PACKAGE_REPOS_ENABLED` is `true`, as `UPDATES_ENABLED` gates the manifest, so that each
    sub-PR can merge while `main` stays releasable and the first real run is the maintainer's
    choice. The `.rpm` signature and the pacman package in `release.yml` follow the same
    variable, so a release without the key is the same as today's.
14. **Releases only.** The repositories carry published releases, never pre-releases, drafts or
    the nightly. Reason: the repositories are the stable channel, matching the update manifest's
    `vimma` channel; a user who wants pre-releases installs them by hand.

### In the browser

15. **New install type `pacman`; repository detection for `.deb` and `.rpm`.** The pacman
    package's marker gives the install type `pacman`, whose hint is `sudo pacman -Syu`. For the
    `.deb` and `.rpm`, which are the same file from a release and from the repository, the
    update check looks for the repository's file (`/etc/apt/sources.list.d/vimma.sources`,
    `/etc/yum.repos.d/vimma.repo`, or `/etc/zypp/repos.d/vimma.repo`) and shows the package
    manager's upgrade command when it exists. Reason: the hint must be a command that works;
    the upgrade command does nothing without the repository, and the download command works
    either way. Rejected: a second marker for repository installs, because the package file is
    identical. The check reads only whether those paths exist, never their content.

## Security and privacy

New surface:

- **A signing key that package managers trust as root.** A user who sets up a repository lets
  anyone who holds the signing subkey and can serve metadata to them install code as root on
  their next upgrade. Today an attacker with the release workflow would still need the user to
  run a new download. This is the main new risk. The mitigations: the subkey alone is online,
  in an environment that admits `main` only, used by jobs that run no repository code
  (decision 2); the primary key stays offline and can revoke it; the subkey expires (open
  question 5); and a release still needs the tag checks, the `build` environment and B10's
  rules before anything is signed. A stolen subkey also needs the host (the `update-publish`
  deploy key or the Cloudflare account) or a network position to serve its metadata, because
  every repository is fetched over HTTPS from `updates.vimma.dev`.
- **The update host serves the metadata.** It cannot change a package: apt checks each `.deb`
  against the SHA-256 in the signed `Packages`, dnf and zypper check the signed `repomd.xml`
  and each `.rpm`'s own signature, and pacman checks the signed database and each package's
  signature. It can serve older signed metadata (a freeze or rollback attack), which keeps a
  user on an older Vimma; apt's `Valid-Until` would bound that (open question 8), and Vimma's
  own update check reports a newer release from its separately signed manifest either way.
- **Redirects to GitHub.** The redirect targets are fixed to
  `https://github.com/vimma-browser/vimma/releases/download/`; a placeholder can only fill a
  single path segment there (Research). GitHub serves what the release has, which B9 already
  forbids replacing once published.
- **Setup files.** The `.sources` and `.repo` files are fetched over HTTPS from the host; the
  guide's fingerprint lets a user check the key they trust. Whether the packages edit the
  package manager's sources themselves is open question 3.
- **Repository detection** reads whether three fixed paths exist; it sends nothing anywhere.

`docs/security/14-build-and-release-supply-chain.md` gains a rule (B20) for the
`package-signing` environment, its secret, the jobs that may use it and what they run, the
redirect targets, and the public key's three copies; `docs/security/16-update-check.md` covers
the new hints and the repository detection. Each implementing pull request that touches
`release.yml`, `update-publish.yml`, the key or the host gets a review by a fresh session
before it merges.

## Tests

- vitest, `tools/package/test/repos.test.ts`: `writes a flat apt repository whose Filename
carries the tag`, `writes repodata whose locations carry the tag`, `keeps the last N versions
in apt and rpm metadata and the latest only for pacman`, `writes one redirect per pacman file
and one dynamic rule each for apt and rpm`, `refuses a tag or file name outside
[A-Za-z0-9._~+-]`, `the .sources file carries the committed key inline`, `the .repo file sets
gpgcheck and repo_gpgcheck`.
- vitest, `tools/package/test/release-workflow.test.ts`: `package-sign uses the
package-signing environment and runs no repository code`, `signs the .rpm and the pacman
package before mar and sign`, `the pacman package is in SHA256SUMS and gets a cosign bundle`,
  `nothing is signed while PACKAGE_REPOS_ENABLED is not true`.
- vitest, `tools/update/test/update-workflow.test.ts`: `repo-sign runs no repository code`,
  `publish pushes the metadata in the manifest's commit`, `the host's key equals the committed
key`.
- vitest, `packages/vimma-core/test/updates.test.ts`: `install type pacman from
vimma-package=pacman`, `a .deb with the repository set up gets apt's upgrade command`, `a .rpm
with the repository set up gets dnf's and zypper's`, `a .deb without it keeps the download
command`.
- CI, `pkgbuild.yml` job `repos` (`tools/package/repos-smoke.sh`), on every pull request that
  changes `tools/package/` or the workflows: with a throwaway key, build two stub versions of
  each package, build and sign each repository with `repos.ts`, serve them over local HTTP with
  the redirects, and in `debian`, `ubuntu`, `fedora`, `opensuse/leap` and `archlinux` images
  pinned by digest: set up the repository as the guide says, install the older version,
  upgrade to the newer, and check that a tampered package, tampered metadata and metadata
  signed by another key are each refused.
- CI, `release.yml`: `rpm -K` and `gpg --verify` in `package-sign`; the smoke test of the
  pacman package installs it with `pacman -U` in the Arch image.

## Docs and changelog

- `docs/guide.md`: "Installing" gets a repository section per format with the setup commands
  and the fingerprint; "Fedora and openSUSE" drops `--allow-unsigned-rpm` for repository
  installs; "Arch Linux" leads with the repository; "Updates" names the upgrade commands.
- `README.md`: the Install section names the repositories.
- `docs/limits.md`: x86_64 only; no pre-releases in the repositories.
- `docs/runbook/`: generating the key, the environment and its secret, rotating the subkey,
  turning the repositories on and off, and the host's new paths.
- `docs/security/14-build-and-release-supply-chain.md` (B20) and
  `docs/security/16-update-check.md`.
- Implemented specs get `(Since changed: …)` notes where this replaces their decision:
  [m6a-updater](m6a-updater.md) decision 20 and limit 4, [rpm-package](rpm-package.md)
  decisions 6 and 8.
- Changelog, from the commits: "packaging: signed apt, dnf, zypper and pacman repositories".

## Delivery

Each sub-PR is mergeable on its own; nothing reaches users until the maintainer sets
`PACKAGE_REPOS_ENABLED`.

1. **Repository tool and smoke test.** `tools/package/repos.ts` (metadata, setup files,
   `_redirects`, `_headers`), its vitest tests, `tools/package/repos-smoke.sh` and the `repos`
   job in `pkgbuild.yml` with a throwaway key generated in the job.
2. **Release packages.** `release.yml`: the pacman package in `package`, the `package-sign` job
   (`.rpm` and pacman signatures, `SHA256SUMS`), and the pacman marker in `package.ts`.
   Security review.
3. **Publishing.** `update-publish.yml`'s `repo-prepare` and `repo-sign` and the extended
   `publish`; `configs/package-signing/vimma-packages.asc`; the host's paths;
   `docs/security/14-build-and-release-supply-chain.md` (B20); the runbook. Security review.
4. **Browser and docs.** The `pacman` install type, repository detection and hints in
   `updates.mjs`; `docs/guide.md`, `README.md`, `docs/limits.md`,
   `docs/security/16-update-check.md`; the `Since changed` notes. Sets this spec to
   `implemented`.

Only the maintainer can:

- generate the key (offline primary, signing subkey) and commit the public key, before sub-PR
  3 can pass its key check;
- create the `package-signing` environment, restricted to `main`, and add the subkey as its
  secret;
- approve the security reviews of sub-PRs 2 and 3;
- set `PACKAGE_REPOS_ENABLED` and run the first real release, then try each setup command on
  a real Debian or Ubuntu, Fedora, openSUSE and Arch install.

## Open questions

1. **Repository URL.** (a) Paths on `updates.vimma.dev` (`/apt`, `/rpm`, `/arch`); (b) a new
   host, `pkgs.vimma.dev`. (b) separates package traffic and could move later without touching
   the update check, but needs a DNS record, a second Worker or route, and a deploy path.
   Recommendation: (a), because the Worker, its deploy key and its checks already exist.
2. **Versions kept in the metadata.** (a) The latest only; (b) the last few. Older versions let
   a user go back after a bad release (`sudo apt install vimma=X.Y.Z`, `sudo dnf downgrade
vimma`), at about 90 MB more download per version in `repo-prepare`. Recommendation: apt and
   rpm keep the last 5 releases; pacman keeps the latest only, as pacman databases normally do.
3. **Packages that add their own repository.** (a) No: the guide's one-time setup commands;
   (b) yes: the `.deb` and `.rpm` install the repository file and key on install, as Chrome's
   packages do, so a downloaded package starts updating with the system. Recommendation: (a),
   because a package that edits the package manager's sources is surprising, and it widens what
   a compromised package could change on every machine that installs it.
4. **Hint for a `.deb` or `.rpm` without the repository.** (a) The download command plus one
   line pointing at the guide's repository section; (b) the download command only.
   Recommendation: (a), so that users who installed a file learn once that upgrades can be
   automatic.
5. **Key expiry and rotation.** (a) The signing subkey expires after 2 years, renewed or
   replaced with steps in the runbook; (b) 1 year; (c) no expiry. An expiry bounds how long a
   stolen subkey that was never noticed stays useful; each renewal means users' package
   managers must refresh the key (dnf and zypper re-import from `gpgkey`, pacman with
   `pacman-key --refresh-keys`, apt from the `.sources` file, which users would download
   again). Recommendation: (a).
6. **Key algorithm.** (a) RSA-4096; (b) Ed25519, with smaller signatures. Ed25519 support was
   not checked in every rpm, libzypp and apt version these repositories serve.
   Recommendation: (a), until the smoke test shows Ed25519 working on each target.
7. **Where the signing subkey lives.** (a) An exported subkey as a secret of the
   `package-signing` environment; (b) Google Cloud KMS, like the update key, which no job can
   export and which Google Cloud binds to one workflow file. GnuPG cannot sign with Cloud KMS
   directly; it needs a PKCS#11 bridge (Google's PKCS#11 library and a GnuPG smart card
   daemon for PKCS#11), a new dependency in the release path. Recommendation: (a) for the
   first release, revisited once the repositories are in use.
8. **`Valid-Until` in apt's `Release`.** (a) None; (b) 30 days, re-signed by a scheduled job.
   (b) stops a host from serving old signed metadata forever, but puts the key in a scheduled
   job and breaks `apt update` if a re-sign fails. Recommendation: (a), because Vimma's update
   check already reports a newer release from its own signed manifest.
