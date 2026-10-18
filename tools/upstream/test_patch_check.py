"""Tests for patch-check.py. Fixture patches and trees only; no network, no engine/.

fixtures/patch-check/src holds one patch per outcome, made with `git diff` like `surfer export`;
fixtures/patch-check/tree is the "new Firefox" they are checked against:
  clean    the file is unchanged upstream
  offset   upstream added two lines above the hunk
  fuzz     upstream edited the outermost context line of the hunk
  failed   two hunks; upstream rewrote the line the second one changes
  applied  the tree already has our change (an imported engine)
  missing  upstream removed the file
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "patch-check.py"
FIXTURES = HERE / "fixtures" / "patch-check"
SRC = FIXTURES / "src"
TREE = FIXTURES / "tree"


def run(*args, stdin=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=stdin is None,
        input=stdin,
        check=False,
    )


def load_module():
    spec = importlib.util.spec_from_file_location("patch_check", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def by_name(report):
    return {Path(p["patch"]).name: p for p in report["patches"]}


def make_tarball(dest, top="firefox-158.0", extra=None, tree=TREE):
    """A source tarball of the fixture tree, laid out as archive.mozilla.org's (one top dir)."""
    with tarfile.open(dest, "w:xz") as tar:
        tar.add(tree, arcname=top)
        for name, data in (extra or {}).items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, fileobj=io.BytesIO(data))


class PatchCheckOnATree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        out = Path(cls.tmp.name)
        cls.json_path = out / "report.json"
        cls.md_path = out / "report.md"
        cls.result = run(
            "--src", str(SRC), "--engine", str(TREE), "--worktree",
            "--json", str(cls.json_path), "--markdown", str(cls.md_path),
        )  # fmt: skip
        cls.report = json.loads(cls.json_path.read_text(encoding="utf-8"))
        cls.patches = by_name(cls.report)
        cls.markdown = cls.md_path.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_exit_status_is_one_when_a_patch_would_not_import(self):
        self.assertEqual(self.result.returncode, 1, self.result.stderr)
        self.assertFalse(self.report["ok"])

    def test_every_patch_under_src_is_checked(self):
        self.assertEqual(
            sorted(self.patches),
            sorted(p.name for p in SRC.rglob("*.patch")),
        )

    def test_unchanged_file_applies_cleanly(self):
        p = self.patches["clean-txt.patch"]
        self.assertEqual(p["status"], "clean")
        self.assertTrue(p["imports"])

    def test_moved_hunk_applies_with_offset(self):
        p = self.patches["offset-txt.patch"]
        self.assertEqual(p["status"], "offset")
        self.assertTrue(p["imports"])
        self.assertEqual(p["hunks"][0]["offset"], 2)

    def test_changed_outer_context_needs_fuzz_and_would_not_import(self):
        p = self.patches["fuzz-txt.patch"]
        self.assertEqual(p["status"], "fuzz")
        self.assertFalse(p["imports"])
        self.assertEqual(p["hunks"][0]["status"], "fuzz")
        self.assertEqual(p["hunks"][0]["fuzz"], 1)

    def test_rewritten_line_fails_and_names_the_failing_hunk(self):
        p = self.patches["failed-txt.patch"]
        self.assertEqual(p["status"], "failed")
        self.assertFalse(p["imports"])
        statuses = [h["status"] for h in p["hunks"]]
        self.assertEqual(statuses, ["clean", "failed"])
        failing = p["hunks"][1]
        self.assertEqual(failing["file"], "toolkit/failed.txt")
        self.assertTrue(failing["header"].startswith("@@ -22,7 +22,7 @@"))
        self.assertIn("+failed line 25, patched by Vimma", failing["text"])
        self.assertIn("patch failed: toolkit/failed.txt:22", p["message"])

    def test_already_applied_patch_is_reported_as_applied(self):
        p = self.patches["applied-txt.patch"]
        self.assertEqual(p["status"], "applied")
        self.assertTrue(p["imports"])

    def test_missing_upstream_file_fails_with_reason(self):
        p = self.patches["missing-txt.patch"]
        self.assertEqual(p["status"], "failed")
        self.assertEqual(p["missing"], ["browser/missing.txt"])

    def test_counts_and_firefox_version(self):
        self.assertEqual(self.report["firefox"], "158.0")
        self.assertEqual(
            self.report["counts"],
            {"clean": 1, "offset": 1, "applied": 1, "fuzz": 1, "failed": 2},
        )

    def test_markdown_has_a_row_per_patch_and_the_failing_hunk(self):
        for name in self.patches:
            self.assertIn(name, self.markdown)
        self.assertIn("Firefox 158.0", self.markdown)
        self.assertIn("+failed line 25, patched by Vimma", self.markdown)
        self.assertIn("```diff", self.markdown)
        self.assertNotIn("+offset line 10", self.markdown)  # no hunk text for a passing patch

    def test_stdout_summarises_without_json_flags(self):
        r = run("--src", str(SRC), "--engine", str(TREE), "--worktree")
        self.assertEqual(r.returncode, 1)
        self.assertIn("failed-txt.patch", r.stdout)
        self.assertIn("failed", r.stdout)


class MarkdownForAPrBody(unittest.TestCase):
    def report(self, text):
        hunk = {"file": "a|b.js", "index": 1, "of": 1, "header": "@@ -1 +1 @@", "old_start": 1}
        hunk |= {"status": "failed", "offset": 0, "fuzz": 0, "text": text}
        patch = {"patch": "src/a|b-js.patch", "files": ["a|b.js"], "status": "failed"}
        patch |= {"imports": False, "missing": [], "message": "", "hunks": [hunk]}
        counts = {"clean": 0, "offset": 0, "applied": 0, "fuzz": 0, "failed": 1}
        return {"firefox": "158.0", "source": "t", "ok": False, "counts": counts,
                "patches": [patch]}  # fmt: skip

    def test_pipes_in_paths_do_not_break_the_table(self):
        md = load_module().render_markdown(self.report("-a\n+b\n"))
        row = next(line for line in md.splitlines() if line.startswith("| `src/"))
        self.assertEqual(row.replace("\\|", "").count("|"), 5, row)

    def test_backticks_in_a_hunk_get_a_longer_fence(self):
        md = load_module().render_markdown(self.report("-```\n+````\n"))
        self.assertIn("`````diff", md)

    def test_too_long_for_a_pr_body_drops_the_hunks_keeps_the_table(self):
        md = load_module().render_markdown(self.report("+x\n" * 40000))
        self.assertLess(len(md), 65536)
        self.assertIn("src/a", md)
        self.assertNotIn("```diff", md)
        self.assertIn("Hunks omitted", md)


class PatchCheckAllClean(unittest.TestCase):
    def test_exit_zero_when_every_patch_imports(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "src"
            for name in ("browser/clean-txt.patch", "browser/offset-txt.patch"):
                (src / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(SRC / name, src / name)
            out = Path(d) / "r.json"
            r = run("--src", str(src), "--engine", str(TREE), "--worktree", "--json", str(out))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(json.loads(out.read_text(encoding="utf-8"))["ok"])

    def test_list_files_prints_patched_paths(self):
        r = run("--src", str(SRC), "--list-files")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("toolkit/failed.txt", r.stdout.splitlines())
        self.assertIn("browser/missing.txt", r.stdout.splitlines())


class PatchCheckFromTarball(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.tarball = self.dir / "firefox-158.0.source.tar.xz"
        make_tarball(self.tarball)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, *args, stdin=None):
        out = self.dir / "r.json"
        r = run("--src", str(SRC), *args, "--json", str(out), stdin=stdin)
        return r, json.loads(out.read_text(encoding="utf-8")) if out.exists() else None

    def test_tarball_file_gives_the_same_verdicts_as_the_tree(self):
        r, report = self.check("--tarball", str(self.tarball))
        self.assertEqual(r.returncode, 1, r.stderr)
        statuses = {k: v["status"] for k, v in by_name(report).items()}
        self.assertEqual(statuses["clean-txt.patch"], "clean")
        self.assertEqual(statuses["offset-txt.patch"], "offset")
        self.assertEqual(statuses["failed-txt.patch"], "failed")
        self.assertEqual(report["firefox"], "158.0")

    def test_report_carries_the_source_revision_for_the_artifact_preflight(self):
        # upstream.yml asks Taskcluster for Mozilla's build of this revision (spec
        # m7-upstream-autopilot) before it spends minutes on an artifact build.
        r, report = self.check("--tarball", str(self.tarball))
        self.assertEqual(report["revision"], "0" * 40)
        self.assertEqual(report["tree"], "releases/mozilla-release")

    def test_report_names_the_mozilla_beta_tree(self):
        # A Beta tarball's sourcestamp.txt names mozilla-beta (159.0b1: spec
        # upstream-beta-canary, R3); the preflight looks Mozilla's build up in that tree's index.
        tree = self.dir / "beta-tree"
        shutil.copytree(TREE, tree)
        rev = "c0c03f3f899017ae4b7e56c0713f1ada51173c41"
        (tree / "sourcestamp.txt").write_text(
            f"20261012000000\nhttps://hg.mozilla.org/releases/mozilla-beta/rev/{rev}\n"
        )
        beta = self.dir / "firefox-159.0b1.source.tar.xz"
        make_tarball(beta, top="firefox-159.0", tree=tree)
        r, report = self.check("--tarball", str(beta))
        self.assertEqual(report["tree"], "releases/mozilla-beta")
        self.assertEqual(report["revision"], rev)

    def test_tarball_on_stdin(self):
        r, report = self.check("--tarball", "-", stdin=self.tarball.read_bytes())
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(by_name(report)["fuzz-txt.patch"]["status"], "fuzz")

    def test_only_patched_files_are_extracted_never_outside_the_tree(self):
        evil = self.dir / "evil.txt"
        bad = self.dir / "bad.tar.xz"
        make_tarball(bad, extra={"firefox-158.0/../../evil.txt": b"x\n"})
        module = load_module()
        dest = self.dir / "out"
        dest.mkdir()
        with open(bad, "rb") as f:
            found = module.extract_from_tarball(
                f, {"browser/clean.txt", "../evil.txt", "evil.txt"}, dest
            )
        self.assertEqual(found, {"browser/clean.txt"})
        self.assertFalse(evil.exists())
        self.assertEqual(sorted(p.name for p in dest.rglob("*") if p.is_file()), ["clean.txt"])

    def test_extract_writes_requested_files_from_the_stream(self):
        # Spec upstream-bump-automation, sub-PR 1: the pref refresh reads upstream's prefs files
        # from the same verified stream as the patched files.
        out = self.dir / "extracted"
        r, report = self.check(
            "--tarball", "-", "--extract", "browser/clean.txt", "--extract", "sourcestamp.txt",
            "--extract", "no/such/file.js", "--extract-to", str(out),
            stdin=self.tarball.read_bytes(),
        )  # fmt: skip
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(
            (out / "browser" / "clean.txt").read_bytes(), (TREE / "browser" / "clean.txt").read_bytes()
        )
        self.assertTrue((out / "sourcestamp.txt").is_file())
        self.assertFalse((out / "no").exists())
        self.assertEqual(by_name(report)["fuzz-txt.patch"]["status"], "fuzz")

    def test_extract_refuses_a_path_outside_the_tree(self):
        r, _ = self.check(
            "--tarball", str(self.tarball), "--extract", "../evil.txt",
            "--extract-to", str(self.dir / "x"),
        )  # fmt: skip
        self.assertEqual(r.returncode, 2)
        self.assertIn("--extract", r.stderr)

    def test_unreadable_tarball_exits_two(self):
        junk = self.dir / "junk.tar.xz"
        junk.write_bytes(b"not a tarball")
        r, _ = self.check("--tarball", str(junk))
        self.assertEqual(r.returncode, 2)
        self.assertIn("patch-check:", r.stderr)

    def test_truncated_download_exits_two(self):
        # sourcestamp.txt is in every Firefox source tarball; without it, the download was cut.
        r, _ = self.check("--tarball", "-", stdin=self.tarball.read_bytes()[:200])
        self.assertEqual(r.returncode, 2)


class PatchCheckFromGitRef(unittest.TestCase):
    """An imported engine has our patches in its working tree; HEAD is the pristine Firefox."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = Path(self.tmp.name) / "engine"
        shutil.copytree(TREE, self.engine)
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=self.tmp.name)
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com"]
        for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "Firefox 158.0"]):
            subprocess.run([*git, *args], cwd=self.engine, check=True, env=env)
        clean = self.engine / "browser" / "clean.txt"
        clean.write_text(
            clean.read_text().replace("clean line 10\n", "clean line 10, patched by Vimma\n")
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_reads_head_of_an_engine_repo(self):
        out = Path(self.tmp.name) / "r.json"
        r = run("--src", str(SRC), "--engine", str(self.engine), "--json", str(out))
        self.assertEqual(r.returncode, 1, r.stderr)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(report["source"], f"{self.engine} at HEAD")
        self.assertEqual(by_name(report)["clean-txt.patch"]["status"], "clean")

    def test_repo_without_a_commit_falls_back_to_the_working_tree(self):
        # e2e.yml: CI_SKIP_INIT=1 surfer download, then a bare `git init engine`.
        shutil.rmtree(self.engine / ".git")
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=self.tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.engine, check=True, env=env)
        out = Path(self.tmp.name) / "r.json"
        r = run("--src", str(SRC), "--engine", str(self.engine), "--json", str(out))
        self.assertEqual(r.returncode, 1, r.stderr)
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(report["source"], f"{self.engine} (working tree)")
        self.assertEqual(by_name(report)["clean-txt.patch"]["status"], "applied")

    def test_explicit_ref_that_does_not_exist_exits_two(self):
        r = run("--src", str(SRC), "--engine", str(self.engine), "--ref", "no-such-ref")
        self.assertEqual(r.returncode, 2)
        self.assertIn("no-such-ref", r.stderr)

    def test_worktree_flag_reads_the_working_tree(self):
        out = Path(self.tmp.name) / "r.json"
        run("--src", str(SRC), "--engine", str(self.engine), "--worktree", "--json", str(out))
        report = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(by_name(report)["clean-txt.patch"]["status"], "applied")


class CreateDeleteRename(unittest.TestCase):
    def test_patches_that_create_and_delete_a_file_apply_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "r.json"
            r = run(
                "--src", str(FIXTURES / "create-delete" / "src"), "--engine", str(TREE),
                "--worktree", "--json", str(out),
            )  # fmt: skip
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            patches = by_name(json.loads(out.read_text(encoding="utf-8")))
            self.assertEqual(patches["new-txt.patch"]["status"], "clean")  # creates browser/new.txt
            self.assertEqual(patches["clean-txt.patch"]["status"], "clean")  # deletes clean.txt
            self.assertEqual(patches["new-txt.patch"]["missing"], [])

    def test_a_pure_rename_is_rejected_with_a_clear_message_not_reported_failed(self):
        with tempfile.TemporaryDirectory() as d:
            md = Path(d) / "r.md"
            r = run(
                "--src", str(FIXTURES / "rename" / "src"), "--engine", str(TREE), "--worktree",
                "--markdown", str(md),
            )  # fmt: skip
            self.assertEqual(r.returncode, 2, r.stdout)
            self.assertIn("renamed-txt.patch", r.stderr)
            self.assertIn("rename", r.stderr)
            self.assertIn("did not run", md.read_text(encoding="utf-8"))


class DidNotRun(unittest.TestCase):
    """Anything but a verdict is exit 2 with a Markdown file that says the check did not run."""

    MALFORMED = FIXTURES / "malformed" / "src"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.md = Path(self.tmp.name) / "r.md"
        self.json = Path(self.tmp.name) / "r.json"

    def tearDown(self):
        self.tmp.cleanup()

    def assert_did_not_run(self, r, needle):
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertIn(needle, r.stderr)
        text = self.md.read_text(encoding="utf-8")
        self.assertIn("did not run", text)
        self.assertIn(needle, text)
        report = json.loads(self.json.read_text(encoding="utf-8"))
        self.assertFalse(report["ran"])
        self.assertFalse(report["ok"])

    def test_malformed_patch_on_a_tree(self):
        r = run(
            "--src", str(self.MALFORMED), "--engine", str(TREE), "--worktree",
            "--markdown", str(self.md), "--json", str(self.json),
        )  # fmt: skip
        self.assert_did_not_run(r, "clean-txt.patch")

    def test_malformed_patch_with_a_tarball(self):
        with tempfile.TemporaryDirectory() as d:
            tarball = Path(d) / "t.tar.xz"
            make_tarball(tarball)
            r = run(
                "--src", str(self.MALFORMED), "--tarball", str(tarball),
                "--markdown", str(self.md), "--json", str(self.json),
            )  # fmt: skip
        self.assert_did_not_run(r, "clean-txt.patch")

    def test_unreadable_tarball_writes_did_not_run(self):
        junk = Path(self.tmp.name) / "junk.tar.xz"
        junk.write_bytes(b"junk")
        r = run(
            "--src", str(SRC), "--tarball", str(junk),
            "--markdown", str(self.md), "--json", str(self.json),
        )  # fmt: skip
        self.assert_did_not_run(r, "cannot read tarball")

    def test_unexpected_exception_is_exit_two_not_a_verdict(self):
        module = load_module()

        def boom(*_args):
            raise RuntimeError("kaboom")

        module.build_report = boom
        args = ["--src", str(SRC), "--engine", str(TREE), "--worktree"]
        args += ["--markdown", str(self.md), "--json", str(self.json)]
        with open(os.devnull, "w") as null:
            stderr, sys.stderr = sys.stderr, null
            try:
                status = module.main(args)
            finally:
                sys.stderr = stderr
        self.assertEqual(status, 2)
        self.assertIn("kaboom", self.md.read_text(encoding="utf-8"))
        self.assertFalse(json.loads(self.json.read_text(encoding="utf-8"))["ran"])

    def test_list_files_on_a_malformed_patch_is_exit_two(self):
        r = run("--src", str(self.MALFORMED), "--list-files")
        self.assertEqual(r.returncode, 2)
        self.assertNotIn("Traceback", r.stderr)


class TarballDrain(unittest.TestCase):
    """upstream.yml hashes the stream with tee; --drain reads it to the end so the hash is whole."""

    def run_stdin(self, *extra):
        with tempfile.TemporaryDirectory() as d:
            tarball = Path(d) / "t.tar"
            # Wanted files first, then 1 MB of padding after them.
            with tarfile.open(tarball, "w") as tar:
                tar.add(TREE, arcname="firefox-158.0")
                info = tarfile.TarInfo("firefox-158.0/zz/padding.bin")
                info.size = 1 << 20
                tar.addfile(info, fileobj=io.BytesIO(b"\0" * info.size))
            data = tarball.read_bytes()
            # Only patches whose files exist, so every wanted file is found before the padding.
            src = Path(d) / "src"
            for name in ("browser/clean-txt.patch", "toolkit/failed-txt.patch"):
                (src / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(SRC / name, src / name)
            out = Path(d) / "r.json"
            r = run("--src", str(src), "--tarball", "-", "--json", str(out), *extra, stdin=data)
            return len(data), r, json.loads(out.read_text(encoding="utf-8"))

    def test_drain_reads_the_whole_stream(self):
        size, r, report = self.run_stdin("--drain")
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(report["tarball_bytes"], size)

    def test_without_drain_it_stops_after_the_last_wanted_file(self):
        size, _, report = self.run_stdin()
        self.assertLess(report["tarball_bytes"], size)


class MilestoneInMarkdown(unittest.TestCase):
    def test_upstream_milestone_string_is_escaped_in_the_heading(self):
        report = {"firefox": "158.0 <img src=x>|`*", "source": "t", "ok": True, "patches": []}
        report["counts"] = {"clean": 0, "offset": 0, "applied": 0, "fuzz": 0, "failed": 0}
        heading = load_module().render_markdown(report).splitlines()[0]
        self.assertNotIn("<img", heading)
        self.assertIn("&lt;img", heading)
        self.assertIn("\\`", heading)
        self.assertIn("\\*", heading)


class RealPatches(unittest.TestCase):
    def test_every_patch_in_src_parses_with_its_hunks(self):
        module = load_module()
        root = HERE.parent.parent
        patches = sorted((root / "src").rglob("*.patch"))
        self.assertTrue(patches)
        for path in patches:
            files = module.parse_patch(path.read_text(encoding="utf-8"))
            self.assertTrue(files, path)
            for f in files:
                self.assertTrue(f.hunks, path)


if __name__ == "__main__":
    unittest.main()
