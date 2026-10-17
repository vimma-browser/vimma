#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Writes pre-rotation.asc for test_mozilla_key_check.py: Mozilla's KEY of 158.0 (158.0-KEY,
byte for byte https://archive.mozilla.org/pub/firefox/releases/158.0/KEY) as it was before
2026-08-06, without the signing subkey 827E…7AA3 and without the revocation of 09BE…0256.

Packets are dropped, never re-signed, so every remaining signature is Mozilla's own. gpg's
--export-filter cannot select a signature by its class, hence this script.

    python3 tools/upstream/fixtures/key/make-pre-rotation.py
"""

import base64
import hashlib
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEW_SUBKEY = "827E658608679618CD349F93678E455D76767AA3"
SUBKEY_REVOCATION = 0x28  # RFC 4880, section 5.2.1
PUBLIC_SUBKEY, SIGNATURE = 14, 2

spec = importlib.util.spec_from_file_location("v", HERE.parent.parent / "verify-sha512.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def packets(data):
    """(tag, header and body bytes, body bytes) for each packet; new-format lengths and old-format
    1, 2 and 4-byte lengths only, which is all Mozilla's KEY uses."""
    at = 0
    while at < len(data):
        head = data[at]
        if head & 0x40:
            tag, first = head & 0x3F, data[at + 1]
            if first < 192:
                hl, n = 2, first
            elif first < 224:
                hl, n = 3, ((first - 192) << 8) + data[at + 2] + 192
            else:
                hl, n = 6, int.from_bytes(data[at + 2 : at + 6], "big")
        else:
            tag, size = (head >> 2) & 0x0F, (1, 2, 4)[head & 0x03]
            hl, n = 1 + size, int.from_bytes(data[at + 1 : at + 1 + size], "big")
        yield tag, data[at : at + hl + n], data[at + hl : at + hl + n]
        at += hl + n


def main():
    data = verify.dearmor((HERE / "158.0-KEY").read_text(encoding="ascii"))
    out, dropping = b"", False
    for tag, whole, body in packets(data):
        if tag == PUBLIC_SUBKEY:
            fpr = hashlib.sha1(b"\x99" + len(body).to_bytes(2, "big") + body).hexdigest().upper()
            dropping = fpr == NEW_SUBKEY
        if dropping or (tag == SIGNATURE and body[0] == 4 and body[1] == SUBKEY_REVOCATION):
            continue
        out += whole
    text = base64.b64encode(out).decode("ascii")
    lines = [text[i : i + 64] for i in range(0, len(text), 64)]
    crc = base64.b64encode(verify.crc24(out).to_bytes(3, "big")).decode("ascii")
    armour = ["-----BEGIN PGP PUBLIC KEY BLOCK-----", "", *lines, f"={crc}",
              "-----END PGP PUBLIC KEY BLOCK-----", ""]
    (HERE / "pre-rotation.asc").write_text("\n".join(armour), encoding="ascii")


if __name__ == "__main__":
    main()
