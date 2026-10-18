#!/usr/bin/env python3
"""Re-export the patches that apply only with fuzz, against a new Firefox release.

Spec upstream-bump-automation, sub-PR 3. `surfer import` refuses a patch that needs fuzz (its
outer context changed upstream), although its own lines still apply. For each `fuzz` patch in a
patch-check.py report this applies the patch with the context it needed (`git apply -C<n>` and
Surfer's whitespace flags) to a scratch git repository holding the pristine upstream files, and
writes `git diff --full-index` of the result, as `surfer export` does. A result whose added and
removed lines differ from the original patch's is refused, never written.

  reexport.py --report patch-check.json --tree DIR --root REPO --out DIR

--tree holds the pristine upstream files (source-check.sh extracts them from the verified
tarball); --root is the repository whose src/**/*.patch the report names. Writes OUT/reexport.json
({"state": "none" | "reexported" | "skipped" | "refused", "reexported": [...], "refused": [...]})
and, only when every fuzz patch re-exported, OUT/<label> for each. A report with a failed patch
is skipped: that bump needs a person (or sub-PR 4) anyway, and one commit should fix it whole.

Exit status: 0 none or reexported, 1 skipped or refused. Python stdlib only.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

from patches import parse_patch, safe_relpath

# Surfer's PATCH_ARGS, as in patch-check.py.
SURFER_ARGS = ["--ignore-space-change", "--ignore-whitespace"]


def changes(text):
    """The (file, line) of every added and removed line, in order."""
    return [
        (f.path, line)
        for f in parse_patch(text)
        for h in f.hunks
        for line in h.body
        if line[:1] in ("+", "-")
    ]


def same_changes(old, new):
    return changes(old) == changes(new)


def git(cwd, *args, stdin=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CEILING_DIRECTORIES"] = str(Path(cwd).parent)  # never find an enclosing repository
    return subprocess.run(
        ["git", "-c", "user.name=reexport", "-c", "user.email=reexport@invalid", *args],
        cwd=cwd, env=env, input=stdin, capture_output=True, text=True, check=False,
    )  # fmt: skip


def reexport_one(text, tree, context):
    """The re-exported patch text, or (None, reason)."""
    files = parse_patch(text)
    with tempfile.TemporaryDirectory(prefix="reexport-") as tmp:
        work = Path(tmp) / "tree"
        work.mkdir()
        for f in files:
            src = Path(tree) / f.path
            if f.old_path is not None:
                if not safe_relpath(f.path) or not src.is_file():
                    return None, f"{f.path} is not in the upstream tree"
                dest = work / f.path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(src.read_bytes())
        for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "upstream", "--allow-empty"]):
            r = git(work, *args)
            if r.returncode:
                return None, r.stderr.strip()
        r = git(work, "apply", *SURFER_ARGS, f"-C{context}", stdin=text)
        if r.returncode:
            return None, f"git apply -C{context}: {r.stderr.strip()}"
        git(work, "add", "-A")
        # Explicit prefixes and no external diff or colour: a user's git config (for example
        # diff.mnemonicPrefix) must not change the format surfer import reads.
        r = git(work, "diff", "--cached", "--full-index", "--no-ext-diff", "--no-color",
                "--src-prefix=a/", "--dst-prefix=b/")  # fmt: skip
        if r.returncode or not r.stdout:
            return None, "no diff after applying"
        return r.stdout, None


def run(report, tree, root, out):
    result = {"state": "none", "reexported": [], "refused": []}
    patches = report.get("patches", []) if report.get("ran") else []
    if any(p.get("status") == "failed" for p in patches):
        result["state"] = "skipped"
        return result, {}
    written = {}
    for p in patches:
        if p.get("status") != "fuzz":
            continue
        label = p.get("patch", "")
        parts = PurePosixPath(label).parts
        if not safe_relpath(label) or parts[:1] != ("src",) or not label.endswith(".patch"):
            result["refused"].append({"patch": label, "reason": "not a src/**/*.patch path"})
            continue
        old = (Path(root) / label).read_text(encoding="utf-8")
        fuzz = max((h.get("fuzz", 0) for h in p.get("hunks", [])), default=0)
        new, reason = reexport_one(old, tree, max(0, 3 - fuzz))
        if new is None:
            result["refused"].append({"patch": label, "reason": reason})
        elif not same_changes(old, new):
            result["refused"].append({"patch": label, "reason": "added or removed lines changed"})
        else:
            written[label] = new
            result["reexported"].append(label)
    if result["refused"]:
        result["state"] = "refused"
        result["reexported"] = []
        return result, {}
    if written:
        result["state"] = "reexported"
    return result, written


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", required=True, help="patch-check.py's JSON report")
    parser.add_argument("--tree", required=True, help="the pristine upstream files")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--out", required=True, help="directory for reexport.json and patches")
    args = parser.parse_args(argv)
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    result, written = run(report, args.tree, args.root, args.out)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for label, text in written.items():
        dest = out / label
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
    (out / "reexport.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    for label in result["reexported"]:
        print(f"reexport: {label} re-exported")
    for r in result["refused"]:
        print(f"reexport: {r['patch']} refused: {r['reason']}")
    if result["state"] == "skipped":
        print("reexport: a patch failed; nothing re-exported")
    return 0 if result["state"] in ("none", "reexported") else 1


if __name__ == "__main__":
    sys.exit(main())
