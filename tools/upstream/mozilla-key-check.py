#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Compares Mozilla's published release key with the pinned one and reports what changed.

Spec build-supply-chain, decision 21; docs/security.md, B7. upstream.yml's detect job downloads
https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/KEY and passes it as
--current. Reported, as an issue title and body written to --github-output (key-title,
key-report) and the body to stdout:

  - a subkey or a subkey revocation the pinned key does not have;
  - a primary key other than the pinned one (never adopted: ADR-021 must be reviewed);
  - the pinned signing subkey expiring within 60 days of --today.

Nothing to report writes nothing. The pinned keyring is only read, never edited: a new key
lands through a reviewed pull request (docs/runbook.md, "Mozilla's release key").
Exit status: 0 checked (whether or not something was reported); 2 cannot check (no gpg, or a
file that holds no public key).
"""

import argparse
import datetime
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PINNED = Path(__file__).resolve().with_name("mozilla-release-key.asc")
EXPIRY_WARNING_DAYS = 60
CHANGED = "Mozilla's release key changed"
RUNBOOK = "docs/runbook.md, \"Mozilla's release key\""


class CannotCheck(Exception):
    """The check could not run (exit 2)."""


def show_key(path):
    """The primary fingerprint and {subkey fingerprint: (validity, capabilities, expiry epoch or
    None)} of the key in `path`, from `gpg --show-keys --with-colons` (GnuPG's doc/DETAILS).

    --show-keys only lists the file; the throwaway GNUPGHOME keeps gpg from touching, or
    trusting, any keyring of the runner's.
    """
    gpg = shutil.which("gpg")
    if gpg is None:
        raise CannotCheck("gpg not found")
    with tempfile.TemporaryDirectory(prefix="mozilla-key-check-") as home:
        result = subprocess.run(
            [gpg, "--homedir", home, "--batch", "--show-keys", "--with-colons",
             "--with-subkey-fingerprints", "--", str(path)],
            capture_output=True, text=True, check=False,
        )
    primary, subkeys, last = None, {}, None
    for line in result.stdout.splitlines():
        f = line.split(":")
        if f[0] == "pub":
            if primary is not None:
                raise CannotCheck(f"{path} holds more than one key")
            last = "pub"
        elif f[0] == "sub":
            last = (f[1], f[11], int(f[6]) if f[6] else None)
        elif f[0] == "fpr" and last == "pub":
            primary, last = f[9], None
        elif f[0] == "fpr" and isinstance(last, tuple):
            subkeys[f[9]], last = last, None
    if primary is None:
        raise CannotCheck(f"{path} holds no public key")
    return primary, subkeys


def day(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).date()


def report(current, pinned, today):
    """(title, body) for what an issue must say, or None when nothing changed."""
    pin_primary, pin_subs = show_key(pinned)
    cur_primary, cur_subs = show_key(current)
    if cur_primary != pin_primary:
        return CHANGED, "\n".join([
            f"Mozilla's `KEY` file now holds a different primary key: `{cur_primary}`; the",
            f"pinned primary is `{pin_primary}`.",
            "",
            "Mozilla rotates signing subkeys, not this primary. Nothing is updated by this check:",
            "review ADR-021 and Mozilla's announcement before any change to the pinned key or",
            f"fingerprint ({RUNBOOK}). Until then builds keep verifying against the pinned key.",
        ])
    lines = []
    for fpr in sorted(set(cur_subs) - set(pin_subs)):
        validity, caps, expiry = cur_subs[fpr]
        until = day(expiry).isoformat() if expiry else "never"
        lines.append(f"- New subkey `{fpr}` (capabilities `{caps}`, expires {until}"
                     f"{', revoked' if validity == 'r' else ''}).")
    for fpr in sorted(set(cur_subs) & set(pin_subs)):
        if cur_subs[fpr][0] == "r" and pin_subs[fpr][0] != "r":
            lines.append(f"- New revocation of subkey `{fpr}`.")
    if lines:
        return CHANGED, "\n".join([
            f"Mozilla's `KEY` file differs from the pinned key (primary `{pin_primary}`):",
            "",
            *lines,
            "",
            "Check Mozilla's announcement, then update `tools/upstream/mozilla-release-key.asc`",
            f"through a reviewed pull request ({RUNBOOK}). Until then builds fail on releases",
            "a new subkey signed.",
        ])
    # The pinned signing subkey: valid today, signing-capable, the latest expiry among those.
    signing = [
        (expiry, fpr) for fpr, (validity, caps, expiry) in pin_subs.items()
        if validity not in ("r", "e") and "s" in caps and expiry and day(expiry) >= today
    ]
    if signing:
        expiry, fpr = max(signing)
        left = (day(expiry) - today).days
        if left <= EXPIRY_WARNING_DAYS:
            date = day(expiry).isoformat()
            return f"Mozilla's release signing subkey expires {date}", "\n".join([
                f"The pinned signing subkey `{fpr}` expires {date}, in {left} days, and",
                "Mozilla's `KEY` file has no newer one yet. Once it expires, every build fails",
                "to verify Firefox source (docs/security.md, B1). Watch for Mozilla's",
                f"announcement of the next subkey and update the pinned key ({RUNBOOK}).",
            ])
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--current", required=True, help="Mozilla's KEY file, as downloaded")
    parser.add_argument("--pinned", default=str(PINNED), help=argparse.SUPPRESS)
    parser.add_argument("--today", type=datetime.date.fromisoformat,
                        default=datetime.datetime.now(datetime.timezone.utc).date())
    parser.add_argument("--github-output", help="append key-title and key-report here")
    args = parser.parse_args(argv)
    try:
        found = report(args.current, args.pinned, args.today)
    except (CannotCheck, OSError) as err:
        print(f"mozilla-key-check: cannot check: {err}", file=sys.stderr)
        return 2
    if found is None:
        return 0
    title, body = found
    print(body)
    if args.github_output:
        delimiter = f"EOF_{secrets.token_hex(16)}"
        with open(args.github_output, "a", encoding="utf-8") as out:
            out.write(f"key-title={title}\nkey-report<<{delimiter}\n{body}\n{delimiter}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
