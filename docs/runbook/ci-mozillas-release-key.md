### Mozilla's release key (ADR-021)

Every path that gets Firefox source (`firefox-source.sh`, `source-check.sh`,
`npm run verify-source`) accepts a tarball only when its SHA-512 is in a `SHA512SUMS` signed by
Mozilla's release key, pinned in `tools/upstream/mozilla-release-key.asc` with the primary
fingerprint `14F26682D0916CDD81E37B6D61B7B526D98F0353` in `tools/upstream/verify-sha512.py`
(docs/security/14-build-and-release-supply-chain.md B1). The current signing subkey, `827E…7AA3`, expires 2028-08-05.

**When Mozilla rotates the signing subkey** (announced on the Mozilla Security Blog; until the
update lands, the autopilot, the canary and PR CI fail on releases the new subkey signed, with
`gpgv reported ERRSIG, NO_PUBKEY`):

```sh
curl -fsSL https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/KEY \
  -o tools/upstream/mozilla-release-key.asc
gpg --show-keys --with-subkey-fingerprints tools/upstream/mozilla-release-key.asc
```

Check, before opening the pull request: the primary fingerprint is still `14F2 6682 D091 6CDD
81E3 7B6D 61B7 B526 D98F 0353`; the new subkey's fingerprint and expiry are the ones in Mozilla's
announcement; every subkey marked `revoked` before is still revoked (the 2025 subkey
`09BE…0256` above all); the file is the same as the `KEY` beside the newest release
(`releases/<version>/KEY`). Cite the announcement in the pull request. Update the subkey and
expiry in ADR-021 and in this section, and add the new release's `SHA512SUMS` and `.asc` to the
fixtures only if a test needs a signature by the new subkey. A different primary fingerprint is
not a routine update: stop, and review ADR-021.

The pull request fails the required check "Mozilla release key unchanged or approved"
(`.github/workflows/key-guard.yml`) until a maintainer, after the checks above, adds the
`key-rotation-approved` label; adding it re-runs the check, except on a merged pull request
(a label change there skips it). Any change to
`mozilla-release-key.asc`, or to a line of `verify-sha512.py` that names `PINNED_FINGERPRINT` or
`KEY_FILE` (a comment included), needs the label, and so does any change to the guard itself
(`.github/workflows/key-guard.yml`, `tools/ci/key-guard.mjs`, `tools/ci/test/key-guard.test.mjs`):
review such a change as a change to the key check. Never add it to a pull request whose key change
is not a reviewed rotation; remove it if a later push changes the key again, since the label
stays on the pull request across pushes.

**The key watch.** Every 4 hours `upstream.yml`'s `detect` job compares Mozilla's
`nightly/latest-mozilla-central/KEY` with the pinned key (`tools/upstream/mozilla-key-check.py`,
docs/security/14-build-and-release-supply-chain.md B7) and the `key` job opens, or keeps current, one `security` issue per finding:
"Mozilla's release key changed" for a new subkey, a new revocation or a different primary key,
and "Mozilla's release signing subkey expires <date>" within 60 days of the pinned subkey's
expiry. The issue lists the fingerprints. For a new subkey or revocation, follow the steps above
and close the issue with the pull request; for a different primary key, stop and review ADR-021.
The check never edits the keyring. A failed download only warns in the run's log. Its fixtures,
`tools/upstream/fixtures/key/`, are Mozilla's `KEY` of 158.0 and the same key before the
2026-08-06 rotation, made by `make-pre-rotation.py` there.

The synthetic signature fixtures in `tools/upstream/fixtures/sums/synthetic/` come from
`tools/upstream/fixtures/sums/make-synthetic.sh` (throwaway keys, no secret key committed).
