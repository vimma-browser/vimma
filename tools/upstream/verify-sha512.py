#!/usr/bin/env python3
"""Check Mozilla's signature on SHA512SUMS, then a file's SHA-512 against its line in it.

source-check.sh (upstream.yml, the Beta canary) and firefox-source.sh (every build) download
https://archive.mozilla.org/pub/firefox/releases/X.Y/SHA512SUMS and its detached signature
SHA512SUMS.asc, hash the tarball with sha512sum, and call this script. It accepts the hash only
when SHA512SUMS carries a good signature by a valid signing subkey of Mozilla's release key,
pinned in mozilla-release-key.asc and by PINNED_FINGERPRINT below (spec build-supply-chain,
decisions 1 and 2; ADR-021; docs/security/14-build-and-release-supply-chain.md B1). HTTPS is not
the trust anchor.

The verdict comes from gpgv's machine-readable status lines, never its exit status: gpgv exits 0
for a signature by a revoked subkey (REVKEYSIG) and for one by an unknown key (NO_PUBKEY).

Exit status: 0 good signature and matching hash; 1 a signature that is not good, or a hash
mismatch (both hashes printed); 2 cannot check (no gpgv, a missing or unreadable file, no entry
for the name). Python stdlib only.
"""

import argparse
import base64
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Mozilla Software Releases <release@mozilla.com>, the primary key of Mozilla's release signing
# key. Source: Mozilla Security Blog, "Updated GPG key for signing Firefox and Thunderbird
# Releases" (2026-08-10), which gives "14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353"; equal to
# the primary of https://archive.mozilla.org/pub/firefox/releases/158.0/KEY and of
# keys.openpgp.org's copy (checked 2026-10-15). Mozilla rotates the signing subkey, not this
# primary: a new subkey arrives as an update of mozilla-release-key.asc
# (docs/runbook/ci-mozillas-release-key.md, "Mozilla's release key"). A change to this constant
# means Mozilla replaced its root of trust and needs ADR-021 reviewed, never a routine update.
PINNED_FINGERPRINT = "14F26682D0916CDD81E37B6D61B7B526D98F0353"
KEY_FILE = Path(__file__).resolve().with_name("mozilla-release-key.asc")

HASH = re.compile(r"[0-9a-f]{128}")
FINGERPRINT = re.compile(r"[0-9A-F]{40}")
# Any of these anywhere in the status means the signature is not accepted. KEYEXPIRED is not
# among them: gpgv prints it for every expired subkey in the keyring, even when the signature is
# by the current one; an expired signing subkey shows as EXPKEYSIG instead.
# PLAINTEXT means gpgv found signed data inside the signature file: a signed message, never a
# detached signature over SHA512SUMS (also refused before gpgv runs, see detached_signature).
REFUSED = (
    "BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG", "NO_PUBKEY", "ERROR", "PLAINTEXT",
)
SIGNATURE_TAG = 2  # RFC 4880, section 5.2


class CannotCheck(Exception):
    """The check could not run (exit 2)."""


class Untrusted(Exception):
    """The signature is not a good one by the pinned key (exit 1)."""


def dearmor(text, label="PUBLIC KEY BLOCK"):
    """The binary data of the first ASCII-armoured `label` block (RFC 4880, section 6).

    gpgv reads only binary keyrings: given an armoured one it reports "No public key" and still
    exits 0 (spec build-supply-chain, R2). The key is stored armoured so a change is readable.
    """
    lines = text.splitlines()
    try:
        start = lines.index(f"-----BEGIN PGP {label}-----")
        end = lines.index(f"-----END PGP {label}-----", start)
    except ValueError as err:
        raise CannotCheck(f"no armoured {label.lower()}") from err
    body = lines[start + 1 : end]
    # Armour headers end at the first empty line.
    body = body[body.index("") + 1 :] if "" in body else body
    checksum = None
    if body and body[-1].startswith("="):
        checksum = body.pop()[1:]
    data = base64.b64decode("".join(body), validate=True)
    if checksum is not None and base64.b64decode(checksum) != crc24(data).to_bytes(3, "big"):
        raise CannotCheck("the key file's armour checksum is wrong")
    return data


def crc24(data):
    """The OpenPGP armour checksum (RFC 4880, section 6.1)."""
    crc = 0xB704CE
    for byte in data:
        crc ^= byte << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
    return crc & 0xFFFFFF


def packet_tags(data):
    """The tag of every OpenPGP packet in `data` (RFC 4880, section 4.2); raises Untrusted on a
    header this check does not accept (indeterminate or partial lengths, which a detached
    signature never needs) or on data that does not end on a packet boundary."""
    tags, at = [], 0
    while at < len(data):
        head = data[at]
        if not head & 0x80:
            raise Untrusted(f"not an OpenPGP packet at byte {at}")
        if head & 0x40:  # new format
            tag, first = head & 0x3F, data[at + 1] if at + 1 < len(data) else None
            if first is None or 224 <= first < 255:
                raise Untrusted("an unsupported packet length")
            if first < 192:
                header, length = 2, first
            elif first < 224:
                header, length = 3, ((first - 192) << 8) + data[at + 2] + 192
            else:
                header, length = 6, int.from_bytes(data[at + 2 : at + 6], "big")
        else:  # old format
            tag, kind = (head >> 2) & 0x0F, head & 0x03
            if kind == 3:
                raise Untrusted("an indeterminate packet length")
            size = (1, 2, 4)[kind]
            header, length = 1 + size, int.from_bytes(data[at + 1 : at + 1 + size], "big")
        at += header + length
        if at > len(data):
            raise Untrusted("a truncated packet")
        tags.append(tag)
    return tags


def detached_signature(raw):
    """The binary detached signature in a signature file, armoured or binary. Raises Untrusted
    unless the file is nothing but signature packets: a signed message (opaque or cleartext)
    carries its own data, and a gpgv that checked that data instead of SHA512SUMS would print a
    good signature over bytes this script never looks at."""
    if raw.lstrip().startswith(b"-----"):
        text = raw.decode("ascii", errors="replace").strip()
        # Exactly one armoured block and nothing around it: dearmor() reads only the first
        # block, so anything else in the file would be dropped unseen.
        if not (text.startswith("-----BEGIN PGP SIGNATURE-----")
                and text.endswith("-----END PGP SIGNATURE-----")
                and text.count("-----BEGIN ") == 1 and text.count("-----END ") == 1):
            raise Untrusted("not a detached signature (not exactly one armoured signature block)")
        try:
            data = dearmor(text, "SIGNATURE")
        except (CannotCheck, ValueError) as err:
            raise Untrusted(f"not a detached signature ({err})") from err
    else:
        data = raw
    tags = packet_tags(data)
    if not tags or any(tag != SIGNATURE_TAG for tag in tags):
        raise Untrusted(f"not a detached signature (packet tags {tags})")
    return data


def signature_verdict(status, fingerprint):
    """The signing subkey's fingerprint if gpgv's status shows exactly one good signature by the
    key whose primary fingerprint is `fingerprint`; otherwise raises Untrusted."""
    records = [
        line.split()[1:]
        for line in status.splitlines()
        if line.startswith("[GNUPG:] ") and len(line.split()) > 1
    ]
    keywords = [r[0] for r in records]
    refused = sorted({k for k in keywords if k in REFUSED})
    if refused:
        raise Untrusted(f"gpgv reported {', '.join(refused)}")
    counts = {k: keywords.count(k) for k in ("NEWSIG", "GOODSIG", "VALIDSIG")}
    if counts != {"NEWSIG": 1, "GOODSIG": 1, "VALIDSIG": 1}:
        raise Untrusted(f"not exactly one good signature ({counts})")
    validsig = next(r for r in records if r[0] == "VALIDSIG")
    # VALIDSIG <fpr> <date> <ts> <expire> <version> <reserved> <pk-algo> <hash-algo> <class>
    # <primary-fpr> (GnuPG's doc/DETAILS).
    if len(validsig) < 11 or not FINGERPRINT.fullmatch(validsig[1]):
        raise Untrusted("malformed VALIDSIG status line")
    if validsig[10] != fingerprint:
        raise Untrusted(f"signed by {validsig[10]}, not the pinned key {fingerprint}")
    return validsig[1]


def check_signature(sums, signature, key_file=KEY_FILE, fingerprint=PINNED_FINGERPRINT):
    """Checks that `signature` (a detached-signature file) is a good signature over the bytes
    `sums` by `fingerprint`'s key, read from `key_file`. Returns the signing subkey."""
    gpgv = shutil.which("gpgv")
    if gpgv is None:
        raise CannotCheck("gpgv not found (Ubuntu: package gpgv; macOS: GnuPG)")
    try:
        keyring = dearmor(Path(key_file).read_text(encoding="ascii"))
        raw = Path(signature).read_bytes()
    except OSError as err:
        raise CannotCheck(str(err)) from err
    sig = detached_signature(raw)
    with tempfile.TemporaryDirectory(prefix="verify-sha512-") as tmp:
        home = Path(tmp) / "gnupg"
        home.mkdir(mode=0o700)
        # gpgv checks these copies, and the hash is then read from the same bytes: nothing can
        # change SHA512SUMS between the signature check and the lookup.
        (Path(tmp) / "keyring.gpg").write_bytes(keyring)
        (Path(tmp) / "SHA512SUMS.sig").write_bytes(sig)
        (Path(tmp) / "SHA512SUMS").write_bytes(sums)
        result = subprocess.run(
            [gpgv, "--homedir", str(home), "--status-fd", "1",
             "--keyring", str(Path(tmp) / "keyring.gpg"),
             "--", str(Path(tmp) / "SHA512SUMS.sig"), str(Path(tmp) / "SHA512SUMS")],
            capture_output=True, text=True, check=False,
        )
    return signature_verdict(result.stdout, fingerprint)


def expected_hash(sums_text, name):
    """The hash SHA512SUMS lists for exactly `name`, or None."""
    for line in sums_text.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].lstrip("*").strip() == name:
            return parts[0].lower()
    return None


def actual_hash(sha512sum_text):
    """The hash from sha512sum's output (`<hash>  -` or `<hash>  file`)."""
    first = sha512sum_text.split(None, 1)[0].lower() if sha512sum_text.strip() else ""
    if not HASH.fullmatch(first):
        raise ValueError(f"not a SHA-512 hash: {sha512sum_text.strip()[:80]!r}")
    return first


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sums", required=True, help="Mozilla's SHA512SUMS file")
    parser.add_argument("--signature", required=True, help="its detached SHA512SUMS.asc")
    parser.add_argument("--name", required=True, help="e.g. source/firefox-158.0.source.tar.xz")
    parser.add_argument("--actual", required=True, help="file holding sha512sum's output")
    args = parser.parse_args(argv)
    try:
        sums = Path(args.sums).read_bytes()
        subkey = check_signature(sums, args.signature)
        expected = expected_hash(sums.decode("utf-8"), args.name)
        actual = actual_hash(Path(args.actual).read_text(encoding="utf-8"))
    except Untrusted as err:
        print(f"verify-sha512: {args.sums} is not signed by Mozilla's release key: {err}",
              file=sys.stderr)
        return 1
    except (CannotCheck, OSError, ValueError) as err:
        print(f"verify-sha512: cannot check: {err}", file=sys.stderr)
        return 2
    if expected is None:
        print(f"verify-sha512: no entry for {args.name} in {args.sums}", file=sys.stderr)
        return 2
    if expected != actual:
        print(
            f"verify-sha512: SHA-512 mismatch for {args.name}\n"
            f"  expected (SHA512SUMS): {expected}\n  actual (downloaded):   {actual}",
            file=sys.stderr,
        )
        return 1
    print(
        f"verify-sha512: SHA512SUMS signed by Mozilla's release key (subkey {subkey}); "
        f"{args.name} matches ({actual[:16]}…)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
