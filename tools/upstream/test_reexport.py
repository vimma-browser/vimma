"""Tests for reexport.py (spec upstream-bump-automation, sub-PR 3). Fixture patches and trees only.

fixtures/patch-check/src/toolkit/fuzz-txt.patch needs fuzz against fixtures/patch-check/tree (the
outermost context line changed upstream); failed-txt.patch does not apply at all.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from patches import parse_patch

HERE = Path(__file__).resolve().parent
CHECK = HERE / "patch-check.py"
SCRIPT = HERE / "reexport.py"
FIXTURES = HERE / "fixtures" / "patch-check"
TREE = FIXTURES / "tree"


def changes(text):
    return [
        (f.path, line)
        for f in parse_patch(text)
        for h in f.hunks
        for line in h.body
        if line[:1] in "+-"
    ]


class Reexport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def repo_with(self, *names):
        """A repository root whose src/ holds only the named fixture patches, and its report."""
        for name in names:
            dest = self.root / "src" / "toolkit" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(FIXTURES / "src" / "toolkit" / name, dest)
        report = self.root / "patch-check.json"
        subprocess.run(
            [sys.executable, str(CHECK), "--src", str(self.root / "src"), "--engine", str(TREE),
             "--worktree", "--json", str(report)],
            capture_output=True, check=False,
        )  # fmt: skip
        return report

    def run_reexport(self, report):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--report", str(report), "--tree", str(TREE),
             "--root", str(self.root), "--out", str(self.out)],
            capture_output=True, text=True, check=False,
        )  # fmt: skip

    def test_fuzz_patch_is_reexported_and_applies_clean(self):
        r = self.run_reexport(self.repo_with("fuzz-txt.patch"))
        self.assertEqual(r.returncode, 0, r.stderr)
        new = self.out / "src" / "toolkit" / "fuzz-txt.patch"
        result = json.loads((self.out / "reexport.json").read_text())
        self.assertEqual(result["state"], "reexported")
        self.assertEqual(result["reexported"], ["src/toolkit/fuzz-txt.patch"])
        # The re-exported patch applies with full context, as surfer import needs.
        check = subprocess.run(
            ["git", "apply", "--check", "--ignore-space-change", "--ignore-whitespace", str(new)],
            cwd=TREE, capture_output=True, text=True, check=False,
        )  # fmt: skip
        self.assertEqual(check.returncode, 0, check.stderr)
        text = new.read_text()
        self.assertTrue(text.startswith("diff --git a/toolkit/fuzz.txt b/toolkit/fuzz.txt\nindex "))
        self.assertRegex(text.splitlines()[1], r"^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$")

    def test_reexport_keeps_added_and_removed_lines(self):
        self.run_reexport(self.repo_with("fuzz-txt.patch"))
        old = (FIXTURES / "src" / "toolkit" / "fuzz-txt.patch").read_text()
        new = (self.out / "src" / "toolkit" / "fuzz-txt.patch").read_text()
        self.assertNotEqual(old, new)
        self.assertEqual(changes(new), changes(old))

    def test_failed_patch_is_not_reexported(self):
        r = self.run_reexport(self.repo_with("fuzz-txt.patch", "failed-txt.patch"))
        self.assertEqual(r.returncode, 1)
        result = json.loads((self.out / "reexport.json").read_text())
        self.assertEqual(result["state"], "skipped")
        self.assertEqual(result["reexported"], [])
        self.assertFalse((self.out / "src").exists())

    def test_a_result_with_other_changed_lines_is_refused(self):
        sys.path.insert(0, str(HERE))
        import importlib.util

        spec = importlib.util.spec_from_file_location("reexport", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        old = (FIXTURES / "src" / "toolkit" / "fuzz-txt.patch").read_text()
        self.assertTrue(module.same_changes(old, old))
        self.assertFalse(module.same_changes(old, old.replace("patched by Vimma", "patched")))

    def test_a_report_label_outside_src_is_refused(self):
        report = self.root / "patch-check.json"
        report.write_text(json.dumps({
            "ran": True, "counts": {"failed": 0, "fuzz": 1},
            "patches": [{"patch": "../evil.patch", "status": "fuzz", "hunks": [{"fuzz": 1}]}],
        }))  # fmt: skip
        r = self.run_reexport(report)
        self.assertEqual(r.returncode, 1)
        result = json.loads((self.out / "reexport.json").read_text())
        self.assertEqual(result["state"], "refused")
        self.assertEqual(result["refused"][0]["patch"], "../evil.patch")


if __name__ == "__main__":
    unittest.main()
