# Spec: package-repositories

Status: accepted (sub-PR 1, the signer, the repository tool and the smoke test, sub-PR 2,
package signing, and sub-PR 3, publishing, implemented; sub-PR 4, the browser's hints, built;
the certificate committed; the repositories are not published yet) ·
Area: `tools/package/repos.ts` (new), `tools/package/repos-smoke.sh` (new),
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
3. **zypper.** `sudo zypper addrepo --refresh --gpgcheck-strict https://updates.vimma.dev/rpm/vimma.repo`
   (decision 8), then
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
   repository keeps today's download command, with one line pointing at the guide's repository
   section (decision 22).
8. **Downloads stay on GitHub.** Package files are downloaded from the GitHub Release. The
   update host serves only the metadata, the key and the setup files, and redirects package
   requests to the release's download URL.

## Research

Facts this design depends on, with how each was checked. No container runtime was available
where this research first ran, so apt, dnf and zypper were checked in their source code and
manual pages, not run; the smoke test of sub-PR 1 ran each of them afterwards ("Checked in the
smoke test", the last item below).

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
- **Cloud KMS.** Prices from [cloud.google.com/kms/pricing](https://cloud.google.com/kms/pricing),
  read 2026-11-20: an active asymmetric RSA 3072, RSA 4096 or elliptic-curve key version costs
  0.003424658 USD an hour at the HSM level (2.50 USD a month for an account's first 2,000) and
  0.000082192 USD an hour at the software level (0.06 USD a month); an HSM RSA 2048 version
  costs 1.00 USD a month. Cryptographic operations cost 0.03 USD per 10,000 at both levels, so
  a release's few signatures cost nothing measurable. The key algorithms
  `RSA_SIGN_PKCS1_4096_SHA256` and `RSA_SIGN_PKCS1_4096_SHA512` sign a SHA-256 or SHA-512
  digest with RSASSA-PKCS1-v1_5 (the `kms-integrations` PKCS#11 user guide, release
  pkcs11-v1.9, lists both). The update key uses `rsa-sign-raw-pkcs1-4096` only because KMS
  has no SHA-384 scheme (runbook, step 3).
- **rpmsign calls an external command.** In rpm 4.18.2, 4.19.1 and 4.20.1, `macros.in` defines
  `%__gpg_sign_cmd` as a `gpg -sbo %{__signature_filename} -- %{__plaintext_filename}`
  command line that a macro file can replace. rpm 4.18.2's `sign/rpmgensig.c` sets
  `__plaintext_filename` to `-` and writes the header to the command through a pipe (lines
  202–208), then parses the signature packet the command wrote with `pgpPrtParams` (line 145).
  Ubuntu 24.04's `rpm` package, which the release's `package` job installs, is 4.18.2
  ([rpm-package](rpm-package.md), "Research"). Checked in the rpm source at those tags.
- **gpg through a PKCS#11 bridge.** `gnupg-pkcs11-scd(1)` requires a certificate object on the
  token for each private key (man page in `alonbl/gnupg-pkcs11-scd`, latest release 0.11.0 of
  2024-10-27; Ubuntu 24.04 ships 0.10.0, checked on packages.ubuntu.com). Google's `kmsp11`
  exposes certificates only when `generate_certs` is on, which its user guide says is meant
  for Java's PKCS#11 provider and discourages otherwise, or from PEM certificates given in its
  configuration; it is distributed as a release archive from
  `GoogleCloudPlatform/kms-integrations` (pkcs11-v1.9, 2025-12-09), not in Ubuntu's archive.
  The bridge was not tried.
- **Verifiers for the tests.** Ubuntu 24.04 ships `gpgv` (GnuPG) and Sequoia's `sqv` 1.1.0
  (packages.ubuntu.com, `sqv 1.1.0-1build2`), so the signer's tests can check each signature
  with two independent OpenPGP implementations.
- **Sizes.** In release 0.1.22 the `.deb` is 89,779,500 bytes and the `.rpm` 89,175,241
  (`gh release view v0.1.22 --json assets`).
- **Checked in the smoke test.** `tools/package/repos-smoke.sh` (sub-PR 1, run with rootless
  podman 6.1.4 on 2026-11-20) built each repository with a throwaway key, served it over local
  HTTP with the host's `_redirects` and a second redirect standing in for GitHub's, and used it
  from containers:
  - apt 3.0.4 (Debian 13) and apt 2.8.4 (Ubuntu 24.04) read the deb822 file with the key inline
    in `Signed-By` and the flat repository, installed the older stub, upgraded to the newer one
    and followed both redirects. apt 3.0 checks `InRelease` with `sqv` (it splits the
    cleartext message itself) and refused a changed `InRelease` with "Message has been
    manipulated" and one signed by another key with "Missing key"; apt 2.8 checks with `gpgv`
    and said `BADSIG` and `NO_PUBKEY`. Both refused a `.deb` with one bit changed: "Hash Sum
    mismatch". For `Suites: ./` apt asks for `/apt/./InRelease` with the dot segment as
    written, so the host must answer that path as `/apt/InRelease`. The smoke test's server
    removes dot segments, as the update host does: with `curl --path-as-is`,
    `https://updates.vimma.dev/./robots.txt` answers 200 like `/robots.txt` (2026-11-20).
  - dnf5 5.4.3 with rpm 6.0.2 (Fedora 44): `dnf config-manager addrepo --from-repofile` refuses
    a `.repo` file with an option dnf5 does not know ("Cannot set repository option
    \"autorefresh=1\": Option \"autorefresh\" not found"). With `gpgcheck=1` and
    `repo_gpgcheck=1` it imported the key from `gpgkey` once, installed and upgraded through two
    redirects, and refused a changed `repomd.xml` ("Bad PGP signature"), one signed by another
    key ("Signing key not found"), a changed `.rpm` ("checksum doesn't match") and an `.rpm`
    signed by another key ("Signature verification failed"). When a host that the user already
    trusted switched to another key, `dnf upgrade` (answering no to the key) reported "Signing
    key not found", skipped the repository and exited 0 ("Nothing to do"), leaving the
    installed version; zypper refused the same case ("Signature verification failed").
  - zypper 1.14.101 with rpm 4.20.1 (openSUSE Leap 16.0): with `gpgcheck=1` and
    `repo_gpgcheck=1` from the `.repo` file and the metadata signature verified, it installed an
    `.rpm` signed by another key, because libzypp then trusts the checksum in the signed
    metadata and checks a package's own signature only with `pkg_gpgcheck` on. `zypper addrepo
--gpgcheck-strict` on the `.repo` URL sets `pkg_gpgcheck=1` (and `--refresh` sets
    `autorefresh=1`, without which `zypper up` reads the metadata of the last refresh); with them
    it refused that package ("NOKEY"), a changed `repomd.xml` ("Signature verification
    failed"), one signed by another key ("signed with an unknown key") and a changed `.rpm`
    ("Digest verification failed").
  - pacman 7.1.0 (Arch Linux): installed from the database and upgraded with `pacman -Syu`.
    Through GitHub-like redirects, whose last URL does not end in the package's name, it asked
    the repository's `Server` for the package's `.sig`, so the static `.sig` rule is used. It
    refused a changed `vimma.db` ("signature … is invalid"), one signed by another key ("key …
    is unknown"), a changed package ("invalid or corrupted package (checksum)") and a package
    signed by another key (after trying to look the key up on a keyserver). Under the default
    `SigLevel` (`Required DatabaseOptional`) it accepted a `vimma.db` served without its `.sig`;
    the packages' signatures were still required.
  - `rpmsign` 4.18.0 (Debian 12) signed through the signer by `%__gpg_sign_cmd` with the header
    on standard input, and needs `%_gpg_name` defined (any value) before it runs the command;
    `rpm -K` accepted the result. rpm 6.0.1 (Ubuntu 26.04, the `ubuntu-latest` runner) changed
    the command: `%__gpg_sign_cmd` is a parametric macro whose arguments `%1` and `%2` are the
    header file and the signature file (no `%__signature_filename`), and rpm runs its words as
    written, where rpm 4.18 drops the second word (its own macro is `<gpg path> gpg <options>`).
    One parametric definition serves both: it runs `/usr/bin/env env <node>`, reads `%1` or
    else standard input, and writes `%2` or else `%__signature_filename`
    (`tools/package/test/openpgp-kms.test.ts`, checked with rpm 4.18.0 and 6.0.1). `repo-add`
    6.0.2 from Debian's `pacman-package-manager` needs the `makepkg` package for the libraries
    it sources, and pacman 7.1.0 reads its database.
    Sequoia's `sqv` 1.1.0 verifies detached signatures only.
- **Install type.** `installTypeFrom` (`packages/vimma-core/src/updates/updates.mjs`) reads
  `vimma-package=<type>` from `/usr/lib/vimma/is-packaged-app` (or `/opt/vimma/` for the
  `PKGBUILD`); the `.deb` and `.rpm` from a release and from a repository are the same file, so
  the marker cannot tell them apart.

## Design

### Key

1. **One OpenPGP key for all three formats.** It signs apt's `InRelease`, every `.rpm`,
   `repomd.xml`, the pacman package and the pacman database. Reason: one fingerprint in the
   guide, one custody procedure and one place to revoke, where a key per format would triple
   each.
2. **The repositories get their own key, not the update key.** Reason: the update key,
   `update-primary`, is the key every install's updater pins
   (`packages/vimma-core/src/updates/update-keys.mjs`; docs/runbook/ci-update-keys-and-update-host.md,
   step 3), and it signs update manifests and MARs with raw PKCS#1 over a SHA-384 digest.
   Separate keys mean that a job that can sign packages cannot sign a browser update, and that
   rotating one key does not break the other. No other project key can serve: cosign signs
   keylessly with a short-lived certificate, and the Apple Developer ID and SSH deploy keys are
   not keys that package managers accept.
3. **The key is an RSA-4096 key in Google Cloud KMS, at the HSM protection level, in its own
   key ring.** Key ring `vimma-packages`, key `package-signing`, purpose
   `asymmetric-signing`, algorithm `rsa-sign-pkcs1-4096-sha256`, in the project and location of
   the update key. Its IAM binding admits only GitHub OIDC tokens whose subject is the
   `package-signing` environment of `vimma-browser/vimma`, and `update-primary`'s admits only
   `update-signing`, so that a compromised job in either environment cannot sign with the other
   key. Reasons: no private key exists outside the HSM, so none can leak from a GitHub secret or
   a runner; and the jobs reach it through the GitHub OIDC route to KMS that `update-publish.yml`
   already uses, whose provider admits tokens from `update-publish.yml` on `main` only
   (runbook, step 7b). The `package-sign` job that signs the release's packages is therefore a
   job of `update-publish.yml` that `release.yml` calls, as `mar-sign` is, so that its token
   names `update-publish.yml` and the provider needs no change. RSA-4096 with SHA-256, because
   every apt, rpm, libzypp and pacman these repositories serve verifies RSA signatures with
   SHA-256, while Ed25519 support was not checked in each of them. HSM, because this key lets
   package managers install code as root, and it costs 2.50 USD a month against 0.06 USD at the
   software level (Research, "Cloud KMS"). Rejected: an exported OpenPGP subkey as a GitHub
   environment secret, because the private key would then sit in GitHub, where a workflow
   change that reached the environment could copy it, and nothing could tell.
4. **The KMS key is the OpenPGP primary key; there are no subkeys.** KMS holds one key pair per
   key version, with no OpenPGP structure, so the OpenPGP certificate is built around it once:
   a version 4 public-key packet for the KMS public key with a fixed creation time (the
   fingerprint depends on it), a user ID `Vimma packages <packages@vimma.dev>`, and a
   self-signature (type `0x13`, key flags certify and sign) that KMS makes. The certificate is
   committed as `configs/package-signing/vimma-packages.asc` with the KMS key version it names.
   Consequence: the key cannot be replaced behind a stable primary as a subkey could. A new KMS
   key version, or a new key, is a new OpenPGP key, which every user imports again, so a key
   version is never rotated on a schedule (decision 23).
5. **Signatures are made by a small signer in `tools/`, not by gpg.** `tools/package/openpgp-kms.ts`
   writes OpenPGP version 4 signature packets itself (RFC 4880, section 5.2.3: hashed
   subpackets for the creation time and the issuer fingerprint, hash algorithm SHA-256, public
   key algorithm RSA) and gets the RSA signature from KMS's `asymmetricSign` over the SHA-256
   digest; RSASSA-PKCS1-v1_5 with SHA-256, which `rsa-sign-pkcs1-4096-sha256` produces, is the
   signature an OpenPGP RSA signature carries. It writes three forms: a binary detached
   signature (the pacman package and database), an ASCII-armoured detached signature
   (`repomd.xml.asc`), and a cleartext-signed message (apt's `InRelease`, signature type
   `0x01` over the canonical text). rpm signs through it by setting `%__gpg_sign_cmd`, which
   rpmsign 4.18 to 4.20 runs with the header on standard input (`__plaintext_filename` is `-`)
   and the output path in `__signature_filename`, and rpm 6.0 runs as a parametric macro with
   the header file and the output path as `%1` and `%2`; one parametric definition serves both
   (Research, "Checked in the smoke test"), and rpmsign parses the packet the command writes.
   The file imports only Node's built-ins and reaches KMS over HTTPS with the job's OIDC access
   token, so the signing job adds no dependency. It sends the token only to Cloud KMS's global
   or regional endpoint (a test's fake on a literal loopback address aside), and refuses a key
   version that is not `RSA_SIGN_PKCS1_4096_SHA256` at the `HSM` level, a reply whose CRC32Cs
   or key version name do not match, and a public key or signature that is not the
   certificate's. The signing jobs run this one file from `main` and nothing else from
   the repository, but for `repo-sign`'s check of the metadata (decision 15), `repos.ts select`
   and `repos.ts verify`, which import only Node's built-ins and start no other program.
   Rejected: `gpg` through Google's PKCS#11 library for Cloud KMS (`kmsp11`) and
   `gnupg-pkcs11-scd`, because `gnupg-pkcs11-scd` needs a certificate object beside each
   private key, which `kmsp11` provides only by generating X.509 certificates at start-up, an
   option its guide reserves for Java; `kmsp11` is not in Ubuntu's archive; and making the
   OpenPGP binding through the bridge, and `rpmsign`, `repo-add --sign` and `--clearsign`
   through it, were not shown to work, against a signer whose output `gpgv` and `sqv` check in
   tests.
6. **The public key is published three times.** In this repository as
   `configs/package-signing/vimma-packages.asc`, on the update host as
   `https://updates.vimma.dev/vimma-packages.asc`, and inline in the apt `.sources` file.
   `update-publish.yml` checks that the host's copy and the inline copy equal the committed
   file, and that the KMS public key matches the certificate's key packet, before it pushes, so
   the key a user downloads is the one a reviewed pull request added. The guide prints its full
   fingerprint. Self-hosted apt, rpm and pacman repositories need no registration with any
   distribution, because each package manager trusts the key its user adds. Uploading the
   public key to `keys.openpgp.org` is optional, so that `gpg --recv-keys` finds it; nothing in
   the setup depends on it.

### Repositories

7. **apt: a flat repository built with `apt-ftparchive`.** `apt-ftparchive packages` writes
   `Packages` (and `Packages.gz`, which Node's zlib writes, so no compressor is installed) with
   `Filename: pool/vX.Y.Z/vimma_X.Y.Z_amd64.deb` and SHA-256 as its only hash, because apt
   checks the strongest hash a file lists and SHA-256 is the one a release's `SHA256SUMS` lets
   `repo-sign` compare (decision 15),
   `apt-ftparchive release` writes `Release`, and the signer (decision 5) makes `InRelease`.
   Users point a deb822 `.sources` file at `https://updates.vimma.dev/apt/` with `Suites: ./`.
   Reason: one architecture and one package need no suites or components, and a flat
   repository is the smallest layout every supported apt reads. Rejected: reprepro or aptly,
   because each keeps a database between runs, which a release workflow that starts from an
   empty runner would have to store; a detached `Release.gpg` as well, because every apt that
   reads deb822 reads `InRelease`.
8. **rpm: one repository for dnf and zypper, with signed packages and signed metadata.**
   `createrepo_c` writes `repodata/` with `location href="packages/vX.Y.Z/vimma-X.Y.Z-1.x86_64.rpm"`,
   the signer writes `repodata/repomd.xml.asc`, and `repodata/repomd.xml.key`
   is the public key, which zypper reads. `vimma.repo` sets `gpgcheck=1`, `repo_gpgcheck=1` and
   `gpgkey=https://updates.vimma.dev/vimma-packages.asc`, and no option that only zypper reads,
   because dnf5's `config-manager addrepo` refuses the file over one. zypper's setup command
   adds `--refresh` and `--gpgcheck-strict` instead, because without `pkg_gpgcheck` zypper
   installs a package signed by any key once the metadata signature checks out (Research,
   "Checked in the smoke test"). Reason: the `.rpm` is already one
   package for both distributions (rpm-package, decision 2), and both read the same
   `repodata`. Package signatures protect a package downloaded alone; the metadata signature
   protects the list of packages, so both are checked.
9. **The `.rpm` is signed during the release, before `SHA256SUMS` is final.** A new
   `package-sign` job, a job of `update-publish.yml` that `release.yml` calls after `package`
   (decision 3), takes the `release` artifact, signs the `.rpm` with `rpmsign --addsign`
   through the signer, checks it with `rpm -K` against the committed public key, checks that
   its payload digest did not change, and writes `SHA256SUMS` again; `mar` and `sign` then build on its
   output. Reason: signing rewrites the `.rpm`'s header, so a signature added after
   `SHA256SUMS`, the cosign bundles or the update manifest would leave them naming a file the
   release no longer has. The `.deb` stays unsigned as a file, because apt checks it through
   the SHA-256 in the signed `Packages` and has no per-package signature that `apt` verifies.
   `package` hands `package-sign` a `packages-unsigned` artifact with only the `.rpm`, the pacman
   package and `SHA256SUMS`, not the whole `release` artifact, because the signing job then
   holds nothing but what it signs. The pacman package is never in the `release` artifact, and
   `packages` adds it to the release only after checking its signature, because `sign` and
   `publish` take every `dist/vimma*` file, and a run re-run with `PACKAGE_REPOS_ENABLED` unset
   would otherwise ship it unsigned. A `packages` job in `release.yml` checks `package-sign`'s
   output again with no secret (`tools/package/check-signed-packages.sh`), as `mar` checks the
   signed MAR, because it is the job that `mar`, `sign` and `publish` wait for, and it fails a
   release whose `package-sign` was skipped or failed, where a called workflow whose job was
   skipped would end as a success.
10. **pacman: a binary package built in `release.yml`, signed, in a `vimma` database.** The
    `package` job builds `vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst` from the release's `PKGBUILD` in
    the `archlinux` image that `arch-smoke.sh` already pins, with the release tarball placed in
    the build directory so `makepkg` uses it instead of downloading it; the marker it writes is
    `vimma-package=pacman`. `package-sign` adds its detached signature
    (`vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst.sig`), and both are release files that `SHA256SUMS`
    lists and `sign` gives cosign bundles. `update-publish.yml` builds the database with
    `repo-add`, without `--sign`, from Ubuntu 24.04's `pacman-package-manager` 6.0.2 on the
    runner, and the signer writes the detached signatures of `vimma.db` and `vimma.files`.
    Ubuntu's `repo-add` rather than the Arch image, because the job then runs all three
    repository tools on the runner with no container, and the same version from Debian 12
    builds the database that pacman 7.1.0 reads in the smoke test (Research). Reason: a
    prebuilt package spares each user the build and its 450 MB, and a signed database lets pacman's default `SigLevel` check it. The package is named
    `vimma-bin`, the AUR's name, so a `PKGBUILD` install moves to the repository on its next
    `pacman -Syu` without removing anything. Rejected: building in the user's `makepkg` from a
    repository of `PKGBUILD`s, because pacman has no such repository type.
11. **Metadata only on the update host; package requests redirect to the GitHub Release.** The
    host serves `/apt/`, `/rpm/` and `/arch/x86_64/` metadata, `vimma-packages.asc` and the setup
    files. Its `_redirects` file sends package requests to
    `https://github.com/vimma-browser/vimma/releases/download/<tag>/<file>`: one static rule
    per package file the metadata lists, `/apt/pool/<tag>/<file>` and
    `/rpm/packages/<tag>/<file>` for each kept release and the pacman package and its `.sig`
    next to the database, where pacman asks for them, built from names checked against
    `[A-Za-z0-9._~+-]`. No placeholder, because a rule such as `/apt/pool/:tag/:file` would
    redirect to any file of any release, not only to the packages the signed metadata names;
    at 5 kept releases that is 12 rules, far under the 2,000 static rules a file may hold.
    Reason: a
    release's packages are about 270 MB, which the host's git repository would grow by on every
    release, and GitHub already serves them; integrity does not depend on the host or GitHub,
    because the signed metadata pins each package's checksum. Every client checked follows
    redirects to HTTPS (Research).
12. **The host serves files, never symlinks.** `repos.ts` writes `vimma.db` and `vimma.files` as
    plain files (from `repo-add`'s entries, decision 15), and the signatures beside them,
    because how a symlink committed to `vimma-updates` reaches Cloudflare's asset upload was not
    checked, and plain files leave nothing to check.
13. **Metadata is rebuilt from the release files each time.** For every version the metadata
    keeps (decision 20), `update-publish.yml` downloads that release's packages, checks them
    against its `SHA256SUMS` and that file's cosign bundle, as `prepare` does for the manifest,
    checks each `.rpm` and pacman package's own signature against the committed certificate,
    and builds the metadata from them in an empty directory. Reason: the result depends only on
    signed release files, never on what the host published before, so a tampered host cannot
    carry an entry into the next build; and it is the same build every run. Cost: about 90 MB
    per kept version per format, downloaded by a job that has no secret.
14. **`no-cache` on metadata.** `_headers` gives `/apt/*`, `/rpm/*` and `/arch/*` the same
    `Cache-Control: no-cache` as `/updates/*`, so that clients and Cloudflare see a new release
    at once. Packages are not cached by the host, because it only redirects them. A client that
    reads during a deploy may see a new `InRelease` with an old `Packages` once; apt then reports
    a hash mismatch and the next `apt update` succeeds.

### Publishing

15. **`update-publish.yml` publishes the repositories with the manifest.** A `repo-prepare` job
    (no secret) downloads and checks the release files and builds the unsigned metadata with
    `tools/package/repos.ts`; a `repo-sign` job (environment `package-signing`, running only
    the signer and `repos.ts`'s checks) chooses the releases again from GitHub's list, reads
    their `SHA256SUMS` from GitHub, refuses metadata that is not exactly what `repos.ts` writes
    for them (`repos.ts verify`: every package under its release's SHA-256, every index under
    the checksum its parent lists, no other release, file or hash, and the key in its three
    places the committed one), then signs `Release`, `repomd.xml`, `vimma.db` and `vimma.files`,
    and checks each signature with `gpgv` against the committed key. It reads `SHA256SUMS` only
    under `release.yml`'s cosign signature, and reads each metadata file in the exact shape the
    build writes, refusing it unless writing back what it read gives the same bytes, because a
    check that reads a file more leniently than apt, libsolv or libarchive can be shown one
    thing while they read another (a field repeated in other case, an entry in an XML comment,
    a tar entry behind a pax size). For the same reason `repos.ts` writes the pacman databases
    itself from repo-add's entries, without `%MD5SUM%`, rather than signing repo-add's tar,
    compares them decompressed, and `repo-sign` writes their gzip itself before signing,
    because two runners' zlib may compress the same tar differently. The relations the
    metadata may declare are pinned to those `tools/package/package.ts` gives Vimma's
    packages (and, for the `.rpm`, the exact sonames and symbol versions rpmbuild's ELF scan
    found and the desktop file's provides; and what a kept release built by an earlier
    package.ts still declares, recorded from its packages), with no version on an rpm relation
    but Vimma's own provides at the release's version, and its file lists to Vimma's own paths,
    because signed metadata with another dependency or provide would let a package manager
    install or replace any other package as root, and a version Vimma does not declare can make
    an upgrade unsatisfiable, which dnf skips silently. The
    check is in the signing job, because `repo-prepare` runs the build tools and their packages, and a fault
    there must not be able to get other packages or older releases signed; `publish` commits
    the metadata, the signatures, `_redirects` and `_headers` to `vimma-updates` in the same commit as the manifest. Reason: one commit makes the update
    check and the repositories announce a release at the same moment, and the job that holds
    the deploy key already exists (`update-publish` environment). Rejected: a separate
    workflow, because it would need a second deploy key or a second run of every check.
16. **Behind a repository variable.** Nothing is signed or pushed for the repositories until
    `PACKAGE_REPOS_ENABLED` is `true`, as `UPDATES_ENABLED` gates the manifest, so that each
    sub-PR can merge while `main` stays releasable and the first real run is the maintainer's
    choice. The `.rpm` signature and the pacman package in the release follow the same
    variable, so a release made before the key exists is the same as today's.
17. **Releases only.** The repositories carry published releases, never pre-releases, drafts or
    the nightly. Reason: the repositories are the stable channel, matching the update manifest's
    `vimma` channel; a user who wants pre-releases installs them by hand.

### In the browser

18. **New install type `pacman`; repository detection for `.deb` and `.rpm`.** The pacman
    package's marker gives the install type `pacman`, whose hint is `sudo pacman -Syu`. For the
    `.deb` and `.rpm`, which are the same file from a release and from the repository, the
    update check looks for the repository's file (`/etc/apt/sources.list.d/vimma.sources`,
    `/etc/yum.repos.d/vimma.repo`, or `/etc/zypp/repos.d/vimma.repo`) and shows the package
    manager's upgrade command when it exists. dnf keeps the name of the `.repo` URL's file,
    while `zypper addrepo` names the file after the section id inside it, so the `.repo`
    file's only section id is exactly `[vimma]` (`repos.ts` tests it, and the smoke test checks
    both paths). Reason: the hint must be a command that works;
    the upgrade command does nothing without the repository, and the download command works
    either way. Rejected: a second marker for repository installs, because the package file is
    identical. The check reads only whether those paths exist, never their content.

### Host, retention and key lifetime

19. **The repositories are paths on `updates.vimma.dev`: `/apt`, `/rpm` and `/arch`.** Reason:
    the Worker, its deploy key and its checks already exist, where a new host such as
    `pkgs.vimma.dev` would need a DNS record, a second Worker or route, and a deploy path.
    Rejected: a separate host, which would separate package traffic and could move later
    without touching the update check, but at that cost.
20. **apt and rpm metadata keep the last 5 releases; pacman's database keeps the latest only.**
    The releases kept are the newest published releases that carry the pacman package and its
    signature, and the newest published release must be one of them (`repos.ts select`),
    because a release built while `PACKAGE_REPOS_ENABLED` was not `true` has an unsigned `.rpm`,
    which dnf and zypper refuse, and the repositories must never stop at an older version while
    a newer one is out. Reason for keeping 5: older versions let a user go back after a bad
    release (`sudo apt install vimma=X.Y.Z`, `sudo dnf downgrade vimma`), at about 90 MB more download
    per version in `repo-prepare`; pacman databases normally carry one version of a package.
21. **The `.deb` and `.rpm` do not add their own repository or key on install.** Users set the
    repository up once with the guide's commands. Reason: a package that edits the package
    manager's sources is surprising, and it widens what a compromised package could change on
    every machine that installs it. Rejected: installing the repository file and key from the
    package, as Chrome's packages do.
22. **A `.deb` or `.rpm` installed without the repository gets the download command and one line
    pointing at the guide's repository section.** Reason: users who installed a file learn
    once that upgrades can come with the system's own.
23. **The certificate has no expiry.** The runbook's replacement steps cover a key that must be
    retired. Reason: the private key cannot be copied out of KMS, and signing access is
    withdrawn by disabling the key version or its IAM binding, so an expiry bounds little;
    each extension would need every user to refresh the key by hand on apt (download the
    `.sources` file again) and pacman (`pacman-key --refresh-keys` reaches only a keyserver
    copy), dnf and zypper may not refresh a key they already imported either (not checked), and
    an expired key stops upgrades for anyone who missed the step.
24. **apt's `Release` has no `Valid-Until`.** Reason: Vimma's update check already reports a
    newer release from its own signed manifest, while a 30-day `Valid-Until` would put the key
    in a scheduled re-signing job and break `apt update` whenever a re-sign failed.

### Before the repositories are published

25. **The browser's hints ship before the repositories; the line of decision 22 and the guide's
    setup sections wait for them.** The `pacman` install type and the repository detection
    need no switch: a `vimma-package=pacman` marker exists only in the repository's package,
    and a repository file only after its setup, so neither can show before the repositories
    exist. The line of decision 22 sits behind `vimma.feature.packageRepos` (default `false`,
    `CONTRIBUTING.md`, "Unfinished features"), and the guide's repository sections, the
    README's and `docs/limits.md`'s lines wait for the pull request of Delivery step 5. Reason:
    `PACKAGE_REPOS_ENABLED` is a repository variable that a browser build cannot read, and until
    the maintainer sets it, the line and the setup commands would point users at a repository
    that does not exist; a build released in between still shows a command that works.
26. **An `.rpm` hint names only the package managers whose repository file exists.** With
    `/etc/yum.repos.d/vimma.repo` alone the hint is `sudo dnf upgrade vimma`, with
    `/etc/zypp/repos.d/vimma.repo` alone `sudo zypper up vimma`, and with both, both. Reason: a
    command for a package manager whose repository is not set up finds nothing to upgrade.

## Security and privacy

New surface:

- **A signing key that package managers trust as root.** A user who sets up a repository lets
  anyone who can sign with the key and can serve metadata to them install code as root on
  their next upgrade. Today an attacker with the release workflow would still need the user to
  run a new download. This is the main new risk. The mitigations: the private key never leaves
  Cloud KMS's HSM, so it cannot be copied, only used; only a job of `update-publish.yml` on
  `main` in the `package-signing` environment can use it, and that environment cannot reach
  the update key (decision 3); the signing jobs run the signer and nothing else from the
  repository (decision 5); KMS's Data Access audit log records every signature; disabling the
  key version or removing its IAM binding stops all signing at once; and a release still needs
  the tag checks, the `build` environment and B10's rules before anything is signed. Signing
  access alone also needs the host (the `update-publish` deploy key or the Cloudflare account)
  or a network position to serve its metadata, because every repository is fetched over HTTPS
  from `updates.vimma.dev`. A key that must be replaced is a new key every user imports again
  (decision 4).
- **The update host serves the metadata.** It cannot change a package: apt checks each `.deb`
  against the SHA-256 in the signed `Packages`, dnf and zypper check the signed `repomd.xml`
  and each `.rpm`'s own signature, and pacman checks the signed database and each package's
  signature. It can serve older signed metadata (a freeze or rollback attack), which keeps a
  user on an older Vimma; apt's `Release` has no `Valid-Until` to bound that (decision 24), and
  Vimma's own update check reports a newer release from its separately signed manifest.
- **Redirects to GitHub.** The redirect targets are fixed to
  `https://github.com/vimma-browser/vimma/releases/download/`; a placeholder can only fill a
  single path segment there (Research). GitHub serves what the release has, which B9 already
  forbids replacing once published.
- **Setup files.** The `.sources` and `.repo` files are fetched over HTTPS from the host; the
  guide's fingerprint lets a user check the key they trust. The packages never edit the
  package manager's sources themselves (decision 21).
- **Repository detection** reads whether three fixed paths exist; it sends nothing anywhere.

`docs/security/14-build-and-release-supply-chain.md` gains a rule (B21) for the
`package-signing` environment, the KMS key and its IAM binding, the jobs that may use it and
what they run, the redirect targets, and the public key's three copies; `docs/security/16-update-check.md` covers
the new hints and the repository detection. Each implementing pull request that touches
`release.yml`, `update-publish.yml`, the key or the host gets a review by a fresh session
before it merges.

## Tests

- vitest, `tools/package/test/openpgp-kms.test.ts`, with a local RSA-4096 key standing in for
  KMS: `a detached signature verifies with gpgv and sqv`, `an armoured detached signature
verifies with gpgv and sqv`, `a cleartext-signed InRelease verifies with gpgv and sqv and
apt-style dash-escaping`, `the certificate's self-signature verifies and its fingerprint is
the committed one`, `rpmsign through %__gpg_sign_cmd gives a package rpm -K accepts` (where
  rpm is installed), `imports only node: built-ins`, each way a KMS reply can be wrong refused
  against a local fake (nothing written, the token never printed), and `talks only to Cloud
KMS, or to a fake on a literal loopback address`.
- vitest, `tools/package/test/repos.test.ts`: `writes a flat apt repository whose Filename
carries the tag`, `writes repodata whose locations carry the tag`, `keeps the last N versions
in apt and rpm metadata and the latest only for pacman`, `writes one static redirect per kept
package file, and no placeholder`, `refuses a tag or file name outside [A-Za-z0-9._~+-]`,
  `the .sources file carries the committed key inline`, `the .repo file sets gpgcheck and
repo_gpgcheck`, `the .repo file's only section id is [vimma]`, and `refuses metadata that does
not match the release` (a `.deb`, `.rpm` or pacman package whose own name or version differs
  from its release's), `keeps the newest published releases that carry the repository packages,
newest first`, `refuses metadata whose %s checksum is not the one the release's SHA256SUMS
lists`, `refuses metadata for other releases than the ones chosen, such as an older set` and
  the other `verify` cases.
- vitest, `tools/package/test/release-workflow.test.ts`: `release.yml calls
update-publish.yml's package-sign`, `signs the .rpm and the pacman package before mar and
sign`, `the pacman package is in SHA256SUMS and gets a cosign bundle`,
  `nothing is signed while PACKAGE_REPOS_ENABLED is not true`.
- vitest, `tools/update/test/update-workflow.test.ts`: `package-sign and repo-sign use the
package-signing environment and run only the signer` (for `repo-sign`: `repo-sign uses the
package-signing environment and runs only the signer and repos.ts's checks`), `repo-sign checks
the metadata against the releases it chooses itself before KMS signs`, `no job in
update-signing names the package key, and no job in package-signing names the update key`,
  `publish pushes the metadata in the manifest's commit`, `the host's key equals the committed
key`.
- vitest, `packages/vimma-core/test/updates.test.ts`: `install type pacman from
vimma-package=pacman`, `a .deb with the repository set up gets apt's upgrade command`, `a .rpm
with the repository set up gets dnf's and zypper's`, `a .deb without it keeps the download
command`, `without the repository, the download command and, when asked, one line to the
guide`.
- mochitest, `tests/browser/browser_vimma_update_check.js`:
  `package_repositories_get_the_upgrade_command` (repository files under a test root, the
  feature pref off and on).
- CI, `pkgbuild.yml` job `repos` (`tools/package/repos-smoke.sh`), on every pull request that
  changes `tools/package/` or the workflows: with a throwaway local key in the signer, build two stub versions of
  each package, build and sign each repository with `repos.ts`, serve them over local HTTP with
  the redirects, and in `debian`, `ubuntu`, `fedora`, `opensuse/leap` and `archlinux` images
  pinned by digest: set up the repository as the guide says, install the older version,
  upgrade to the newer, and check that a tampered package, tampered metadata and metadata
  signed by another key are each refused.
- CI, `package-sign` and `repo-sign`: `rpm -K` and `gpgv` against the committed key; the smoke test of the
  pacman package installs it with `pacman -U` in the Arch image.

## Docs and changelog

- `docs/guide.md`: "Installing" gets a repository section per format with the setup commands
  and the fingerprint; "Fedora and openSUSE" drops `--allow-unsigned-rpm` for repository
  installs; "Arch Linux" leads with the repository; "Updates" names the upgrade commands.
- `README.md`: the Install section names the repositories.
- `docs/limits.md`: x86_64 only; no pre-releases in the repositories.
- `docs/runbook/`: the KMS key, its IAM binding and the environment (the commands under
  Delivery), making the certificate, replacing the key, turning the repositories on and off,
  and the host's new paths.
- `docs/security/14-build-and-release-supply-chain.md` (B21) and
  `docs/security/16-update-check.md`.
- Implemented specs get `(Since changed: …)` notes where this replaces their decision:
  [m6a-updater](m6a-updater.md) decision 20 and limit 4, [rpm-package](rpm-package.md)
  decisions 6 and 8.
- Changelog, from the commits: "packaging: signed apt, dnf, zypper and pacman repositories".

## Delivery

Each sub-PR is mergeable on its own; nothing reaches users until the maintainer sets
`PACKAGE_REPOS_ENABLED`.

1. **Signer, repository tool and smoke test.** `tools/package/openpgp-kms.ts` (decision 5),
   `tools/package/repos.ts` (metadata, setup files, `_redirects`, `_headers`), their vitest
   tests, `tools/package/repos-smoke.sh` and the `repos` job in `pkgbuild.yml` with a throwaway
   local key generated in the job.
2. **Release packages.** `release.yml`: the pacman package in `package` and the call to
   `update-publish.yml`'s new `package-sign` job (`.rpm` and pacman signatures, `SHA256SUMS`);
   the pacman marker in `package.ts`. Security review.
3. **Publishing.** `update-publish.yml`'s `repo-prepare` and `repo-sign` and the extended
   `publish`; `configs/package-signing/vimma-packages.asc`, which the maintainer makes and
   commits (below; until then `repo-prepare` stops with an error that names the runbook step);
   the host's paths;
   `docs/security/14-build-and-release-supply-chain.md` (B21); the runbook. Security review.
4. **Browser and docs.** The `pacman` install type, repository detection and hints in
   `updates.mjs`, the line of decision 22 behind `vimma.feature.packageRepos`;
   `docs/guide.md`'s update-hint table, `docs/security/16-update-check.md`; the
   `Since changed` notes of m6a-updater decision 20 and limit 4 and rpm-package decision 8.
5. **Turning on.** After the maintainer sets `PACKAGE_REPOS_ENABLED` and a release reaches the
   repositories (decision 25): `docs/guide.md`'s repository sections, `README.md`,
   `docs/limits.md`; removes `vimma.feature.packageRepos` and every read of it; the
   `Since changed` notes of rpm-package decision 6 and m6-packaging decision 1, if sub-PR 2 has
   not added them. Sets this spec to `implemented`.

Only the maintainer can:

- create the KMS key, its IAM binding and the `package-signing` environment (below), and make
  and commit the certificate with the signer, before sub-PRs 2 and 3 can sign;
- turn on KMS's Data Access audit logs for the new key ring, if they are not on for the
  project already;
- approve the security reviews of sub-PRs 2 and 3;
- set `PACKAGE_REPOS_ENABLED` and run the first real release, then try each setup command on
  a real Debian or Ubuntu, Fedora, openSUSE and Arch install.

The maintainer's one-time setup, in the project and location of the update key
(docs/runbook/ci-update-keys-and-update-host.md, step 3, whose workload identity pool and
provider it reuses):

```sh
PROJECT=<the update key's project> LOCATION=<its location>
gcloud kms keyrings create vimma-packages --location "$LOCATION"
gcloud kms keys create package-signing --keyring vimma-packages --location "$LOCATION" \
  --purpose asymmetric-signing --default-algorithm rsa-sign-pkcs1-4096-sha256 \
  --protection-level hsm
gcloud kms keys versions get-public-key 1 --key package-signing --keyring vimma-packages \
  --location "$LOCATION" --output-file package-signing.pem

NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
read OWNER_ID REPO_ID < <(gh api repos/vimma-browser/vimma --jq '"\(.owner.id) \(.id)"')
SUBJECT="repo:vimma-browser@$OWNER_ID/vimma@$REPO_ID:environment:package-signing"
gcloud kms keys add-iam-policy-binding package-signing --keyring vimma-packages \
  --location "$LOCATION" --role roles/cloudkms.signerVerifier \
  --member "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/subject/$SUBJECT"

R=repos/vimma-browser/vimma
gh api -X PUT $R/environments/package-signing --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/package-signing/deployment-branch-policies -f name=main -f type=branch
gh variable set GCP_PACKAGE_KEY_VERSION --body \
  "projects/$PROJECT/locations/$LOCATION/keyRings/vimma-packages/cryptoKeys/package-signing/cryptoKeyVersions/1"
```

Then the certificate: `node tools/package/openpgp-kms.ts certify --key-version
"$GCP_PACKAGE_KEY_VERSION" --created <time> --user-id 'Vimma packages <packages@vimma.dev>'
--out configs/package-signing/vimma-packages.asc`
run with the maintainer's own Google Cloud credentials, which writes
`configs/package-signing/vimma-packages.asc` for a pull request. The binding names the
`package-signing` subject only; `update-primary`'s binding is not changed, so neither
environment can use the other's key. No secret is stored.
