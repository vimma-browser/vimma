"""Tests for mozilla-key-check.py: Mozilla's published KEY compared with the pinned key.

Fixtures only, no network (fixtures/key/): Mozilla's KEY of 158.0, byte for byte, and the same
key as it was before 2026-08-06 (pre-rotation.asc, from make-pre-rotation.py), without the
signing subkey 827E…7AA3 and the revocation of 09BE…0256. A key with another primary is the
throwaway key of fixtures/sums/synthetic/packets/.
"""

import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "mozilla-key-check.py"
KEYS = HERE / "fixtures" / "key"
KEY_158 = KEYS / "158.0-KEY"
PRE_ROTATION = KEYS / "pre-rotation.asc"
OTHER = HERE / "fixtures" / "sums" / "synthetic" / "packets" / "key.asc"
PINNED = HERE / "mozilla-release-key.asc"
MOZILLA = "14F26682D0916CDD81E37B6D61B7B526D98F0353"
CURRENT_SUBKEY = "827E658608679618CD349F93678E455D76767AA3"
COMPROMISED_SUBKEY = "09BEED63F3462A2DFFAB3B875ECB6497C1A20256"


def run(current, pinned=None, today="2026-10-17"):
    """Runs the check; returns (exit status, stdout, the GITHUB_OUTPUT text, stderr)."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "github-output"
        argv = [sys.executable, str(SCRIPT), "--current", str(current), "--today", today,
                "--github-output", str(out)]
        if pinned is not None:
            argv += ["--pinned", str(pinned)]
        result = subprocess.run(argv, capture_output=True, text=True, check=False)
        written = out.read_text(encoding="utf-8") if out.exists() else ""
    return result.returncode, result.stdout, written, result.stderr


class MozillaKeyCheck(unittest.TestCase):
    def test_a_new_subkey_or_revocation_in_mozillas_key_is_reported(self):
        status, report, output, err = run(KEY_158, pinned=PRE_ROTATION)
        self.assertEqual(status, 0, err)
        self.assertIn("key-title=Mozilla's release key changed\n", output)
        self.assertIn("New subkey", report)
        self.assertIn(CURRENT_SUBKEY, report)
        self.assertIn("New revocation", report)
        self.assertIn(COMPROMISED_SUBKEY, report)
        self.assertIn("docs/runbook.md", report)
        self.assertNotIn("different primary key", report)
        # The whole report reaches the issue through the step output.
        self.assertIn(CURRENT_SUBKEY, output)

    def test_a_different_primary_key_is_reported_and_never_adopted(self):
        before = hashlib.sha256(PINNED.read_bytes()).hexdigest()
        status, report, output, err = run(OTHER)
        self.assertEqual(status, 0, err)
        self.assertIn("key-title=Mozilla's release key changed\n", output)
        other = (OTHER.parent / "fingerprint").read_text(encoding="ascii").strip()
        self.assertIn("different primary key", report)
        self.assertIn(other, report)
        self.assertIn(MOZILLA, report)
        self.assertIn("ADR-021", report)
        self.assertEqual(hashlib.sha256(PINNED.read_bytes()).hexdigest(), before)

    def test_a_signing_subkey_expiring_within_60_days_is_reported(self):
        # 827E…7AA3 expires 2028-08-05: 56 days after 2028-06-10, 65 after 2028-06-01.
        status, report, output, err = run(KEY_158, pinned=KEY_158, today="2028-06-10")
        self.assertEqual(status, 0, err)
        self.assertIn("key-title=Mozilla's release signing subkey expires 2028-08-05\n", output)
        self.assertIn(CURRENT_SUBKEY, report)
        self.assertIn("56 days", report)
        status, report, output, err = run(KEY_158, pinned=KEY_158, today="2028-06-01")
        self.assertEqual((status, report, output), (0, "", ""), err)

    def test_an_unchanged_key_reports_nothing(self):
        self.assertEqual(run(PINNED)[:3], (0, "", ""))
        self.assertEqual(run(PRE_ROTATION, pinned=PRE_ROTATION, today="2026-07-01")[:3],
                         (0, "", ""))

    def test_a_file_that_is_not_a_key_cannot_be_checked_and_exits_two(self):
        with tempfile.NamedTemporaryFile("w", suffix=".asc") as junk:
            junk.write("<html>not found</html>\n")
            junk.flush()
            status, report, output, _ = run(junk.name)
        self.assertEqual((status, report, output), (2, "", ""))


if __name__ == "__main__":
    unittest.main()
