# ADR-021: Mozilla's release key is the trust anchor for the Firefox source

- Status: Accepted
- Date: 2026-10-15

## Context

Every Vimma build starts from Mozilla's Firefox source tarball. Until now the tarball was
accepted when its SHA-512 matched the line in `SHA512SUMS`, fetched from the same archive over
HTTPS, so the trust anchor was archive.mozilla.org, its CDN and the TLS connection to it. Mozilla
signs `SHA512SUMS` with a detached OpenPGP signature (`SHA512SUMS.asc`) by a signing subkey of
its release key. In August 2026 Mozilla revoked one signing subkey as compromised and issued a
new one ("Updated GPG key for signing Firefox and Thunderbird Releases", Mozilla Security Blog,
2026-08-10). `gpgv` exits 0 for a signature by that revoked subkey; only its status lines say
`REVKEYSIG` (spec [build-supply-chain](../specs/build-supply-chain.md), R1 and R2).

## Decision

- `tools/upstream/mozilla-release-key.asc` holds Mozilla's release key exactly as Mozilla
  publishes it in the `KEY` file beside each release (byte-identical to
  `https://archive.mozilla.org/pub/firefox/releases/158.0/KEY` and
  `nightly/latest-mozilla-central/KEY`, checked 2026-10-15): primary
  `14F26682D0916CDD81E37B6D61B7B526D98F0353`, every subkey with its binding signature and the
  revocation of `09BEED63F3462A2DFFAB3B875ECB6497C1A20256`. The primary fingerprint matches the
  one in Mozilla's announcement above and keys.openpgp.org's copy; the current signing subkey,
  `827E658608679618CD349F93678E455D76767AA3`, expires 2028-08-05.
- `tools/upstream/verify-sha512.py` holds the primary fingerprint as `PINNED_FINGERPRINT`, runs
  `gpgv --status-fd` against a binary keyring made from the pinned file, and accepts a
  `SHA512SUMS` only with exactly one `NEWSIG`, one `GOODSIG` and one `VALIDSIG` whose primary
  fingerprint is the pinned one, and none of `BADSIG`, `ERRSIG`, `EXPSIG`, `EXPKEYSIG`,
  `REVKEYSIG`, `NO_PUBKEY` or `ERROR`. Only then does it compare the tarball's hash.
- Every path that gets Firefox source uses it: `firefox-source.sh` (every build, PR CI
  included), `source-check.sh` (the upstream autopilot and the Beta canary) and
  `npm run verify-source` (a contributor's `npx surfer download`). A missing signature, a
  signature that is not good, or a hash mismatch fails; nothing is extracted or reported first.
- The signature file must hold one detached signature and nothing else: one armoured
  `PGP SIGNATURE` block (or binary data) of signature packets only, checked before `gpgv` runs,
  and a `PLAINTEXT` status line is refused too. A signed message carries its own data, and a
  `gpgv` that checked that data would report a good signature over bytes the script never reads.
- On a contributor's machine `npm run import` starts with `verify-source.sh --require`, which
  refuses an `engine/` with no record (in `engine/.git`) that its tarball was verified for
  `surfer.json`'s version. The record is written by `npm run verify-source` and by
  `firefox-source.sh`, is deleted with `engine/`, and is copied into lanes with it.

## Key rotation

Mozilla rotates the signing subkey about every two years, and at once after an incident. A new
subkey is accepted by `gpgv` only with a binding signature from the pinned primary, so a rotation
is an update of `mozilla-release-key.asc` from Mozilla's new `KEY` file, reviewed against
Mozilla's announcement, with every revocation kept (`docs/runbook/ci-mozillas-release-key.md`,
"Mozilla's release key"; `docs/review-checklist.md`). Until the update lands, builds and the
autopilot fail closed on releases signed by the new subkey. A change of the primary fingerprint
means Mozilla replaced its root of trust: it is a review of this ADR, never a routine update. Spec
build-supply-chain's sub-PR 5 adds a watch that opens a `security` issue when Mozilla's published
key changes.
(Since changed: a pull request that changes `mozilla-release-key.asc`, or a line of
`verify-sha512.py` that names `PINNED_FINGERPRINT` or `KEY_FILE`, fails the required check
"Mozilla release key unchanged or approved" (`.github/workflows/key-guard.yml`) until a
maintainer adds the `key-rotation-approved` label, because review alone can miss a key change
inside a large or unrelated pull request, and a label needs triage access, which an outside
contributor does not have.)

## Reasoning

A signature check moves trust from "the archive and its transport served these bytes" to
"Mozilla's release key signed these hashes", which survives a compromised mirror, CDN or TLS
interception. Pinning the key in the repository, rather than fetching `KEY` at build time, means
an attacker who can serve a tarball cannot also serve an old key without the revocation. Judging
by status lines rather than the exit code is required, because the exit code accepts the revoked
subkey.

## Alternatives rejected

- **Fetching `KEY` from the archive at build time**: the same origin as the tarball; an attacker
  could serve a copy without the revocation.
- **A keyserver**: a third party and a network dependency in every build.
- **`gpg --verify`**: the same exit status as `gpgv`, and it needs a writable `GNUPGHOME`.
- **Sequoia's `sqv`**: not installed on GitHub's Ubuntu runners; `gpgv` is (apt depends on it).

## Consequences

- `gpgv` is a requirement of every build and of `npm run verify-source` (Ubuntu: package
  `gpgv`; macOS: GnuPG). An existing checkout runs `npm run verify-source` once before its next
  `npm run import`.
- A signature cannot tell the release from a superseded build candidate of the same version,
  which Mozilla signs with the same key (`docs/limits.md`).
- The repository carries Mozilla's signed `SHA512SUMS` of two releases as test fixtures (about
  1.7 MB), because a signature covers the whole file.
- docs/security/, B1 and G4.
