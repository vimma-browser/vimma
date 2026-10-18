#!/usr/bin/env python3
"""Dry-run every src/**/*.patch against a Firefox source tree, as `surfer import` would apply it.

For each patch: `git apply --check` with Surfer's flags (--ignore-space-change
--ignore-whitespace) on a scratch copy of the files it touches, so the engine is never changed.
Verdicts:
  clean    applies exactly                                  surfer import: applies
  offset   applies, a hunk moved (git reports the offset)    surfer import: applies
  applied  the tree already has it (an imported engine)     surfer import: reverts, re-applies
  fuzz     applies only with less context (git apply -C2/-C1) surfer import: FAILS
  failed   a hunk's lines are gone, or the file is          surfer import: FAILS
A patch that does not apply is checked hunk by hunk, so the report names each failing hunk.

The tree is one of:
  --engine DIR             default engine/; reads HEAD when DIR is a git repository with a
                           commit (Surfer commits the pristine Firefox there; the working tree
                           has our patches), else the working tree. --worktree forces the
                           working tree, --ref REF another commit.
  --tarball FILE|URL|-     a Firefox source tarball (archive.mozilla.org layout). Only the patched
                           files are extracted, to a temporary directory; `-` reads stdin, so a
                           download can be piped in without touching the disk (upstream.yml).
                           --drain reads the stream to its end (for a `tee | sha512sum` beside).
                           --extract PATH (repeatable) with --extract-to DIR also copies these
                           files out of the same stream (source-check.sh: upstream's prefs files
                           for the pref refresh); a path absent from the tarball is skipped.

Writes a text summary to stdout, and with --json/--markdown a machine-readable report and a
summary for a PR body. Exit status: 0 every patch imports, 1 at least one does not, 2 the check
did not run (unreadable tree, malformed or unsupported patch, any crash); with 2 the JSON and
Markdown still say so ("ran": false). docs/rebase.md has the procedure. Python stdlib only.
"""

import argparse
import html
import json
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from patches import find_patches, parse_patch, safe_relpath

ROOT = Path(__file__).resolve().parent.parent.parent
# Surfer's PATCH_ARGS (@zen-browser/surfer dist/constants), so a verdict matches `surfer import`.
SURFER_ARGS = ["--ignore-space-change", "--ignore-whitespace"]
FUZZ_CONTEXT = [2, 1]  # git apply -C<n>: n lines of context must match; fuzz = 3 - n
IMPORTS = {"clean", "offset", "applied"}
ORDER = ["clean", "offset", "applied", "fuzz", "failed"]
# Every Firefox source tarball has these; they also identify the release.
MILESTONE = "config/milestone.txt"
SOURCESTAMP = "sourcestamp.txt"
OFFSET = re.compile(r"^Hunk #(\d+) succeeded at \d+ \(offset (-?\d+) lines?\)\.", re.M)
CHECKING = re.compile(r"^Checking patch (.+)\.\.\.$")
MARKDOWN_LIMIT = 60000  # a PR body may hold 65536 characters


class CheckError(Exception):
    """The check could not run (exit status 2)."""


def git_env(cwd):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CEILING_DIRECTORIES"] = str(Path(cwd).parent)  # never find an enclosing repository
    return env


def apply_check(patch_text, cwd, *extra):
    """(ok, stderr) of `git apply --check` of patch_text in cwd (a plain directory)."""
    r = subprocess.run(
        ["git", "apply", "--check", "--verbose", *SURFER_ARGS, *extra],
        input=patch_text,
        cwd=cwd,
        env=git_env(cwd),
        capture_output=True,
        text=True,
        check=False,
    )
    return r.returncode == 0, r.stderr


def offsets(stderr):
    """{(file, hunk number): offset} from git apply --verbose."""
    found = {}
    current = None
    for line in stderr.splitlines():
        if m := CHECKING.match(line):
            current = m.group(1)
        elif m := OFFSET.match(line):
            found[(current, int(m.group(1)))] = int(m.group(2))
    return found


def check_hunk(fp, index, work):
    """Status, offset and fuzz of one hunk checked on its own."""
    text = fp.hunk_patch(index)
    ok, err = apply_check(text, work)
    if ok:
        off = offsets(err).get((fp.path, 1), 0)
        return {"status": "offset" if off else "clean", "offset": off, "fuzz": 0}
    for context in FUZZ_CONTEXT:
        ok, err = apply_check(text, work, f"-C{context}")
        if ok:
            off = offsets(err).get((fp.path, 1), 0)
            return {"status": "fuzz", "offset": off, "fuzz": 3 - context}
    return {"status": "failed", "offset": 0, "fuzz": 0}


def check_patch(path, label, read):
    """Report for one .patch file; read(relpath) returns the tree's bytes or None."""
    text = Path(path).read_text(encoding="utf-8")
    files = parse_patch(text)
    result = {
        "patch": label,
        "files": [f.path for f in files],
        "status": None,
        "imports": False,
        "missing": [],
        "message": "",
        "hunks": [],
    }
    with tempfile.TemporaryDirectory(prefix="patch-check-") as tmp:
        work = Path(tmp) / "tree"
        work.mkdir()
        for f in files:
            data = read(f.path)
            if data is None:
                if f.old_path is not None:
                    result["missing"].append(f.old_path)
                continue
            dest = work / f.path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        ok, err = apply_check(text, work)
        result["message"] = err.strip()
        hunk_rows = []
        if ok:
            found = offsets(err)
            for f in files:
                for n, h in enumerate(f.hunks, 1):
                    off = found.get((f.path, n), 0)
                    hunk_rows.append((f, n, h, "offset" if off else "clean", off, 0))
            status = "offset" if found else "clean"
        elif apply_check(text, work, "-R")[0]:
            status = "applied"
            hunk_rows = [
                (f, n, h, "applied", 0, 0) for f in files for n, h in enumerate(f.hunks, 1)
            ]
        else:
            for f in files:
                for n, h in enumerate(f.hunks, 1):
                    if f.old_path in result["missing"]:
                        hunk_rows.append((f, n, h, "failed", 0, 0))
                        continue
                    r = check_hunk(f, n - 1, work)
                    hunk_rows.append((f, n, h, r["status"], r["offset"], r["fuzz"]))
            states = {row[3] for row in hunk_rows}
            status = "fuzz" if "fuzz" in states and "failed" not in states else "failed"

    for f, n, h, state, off, fuzz in hunk_rows:
        row = {
            "file": f.path,
            "index": n,
            "of": len(f.hunks),
            "header": h.header,
            "old_start": h.old_start,
            "status": state,
            "offset": off,
            "fuzz": fuzz,
        }
        if state in ("fuzz", "failed"):
            row["text"] = h.text
        result["hunks"].append(row)
    result["status"] = status
    result["imports"] = status in IMPORTS
    return result


# --- trees -------------------------------------------------------------------------------------


def worktree_reader(root):
    root = Path(root)

    def read(rel):
        p = root / rel
        return p.read_bytes() if p.is_file() else None

    return read


def repo_env(engine):
    env = git_env(Path(engine) / ".")
    env.pop("GIT_CEILING_DIRECTORIES")
    return env


def resolve_commit(engine, ref):
    """The commit `ref` names in the engine repository, or None."""
    r = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
        cwd=engine,
        env=repo_env(engine),
        capture_output=True,
        text=True,
        check=False,
    )
    return r.stdout.strip() if r.returncode == 0 else None


def git_reader(engine, commit):
    env = repo_env(engine)

    def read(rel):
        r = subprocess.run(
            ["git", "show", f"{commit}:{rel}"],
            cwd=engine,
            env=env,
            capture_output=True,
            check=False,
        )
        return r.stdout if r.returncode == 0 else None

    return read


def extract_from_tarball(fileobj, wanted, dest):
    """Extract the regular files named in `wanted` (paths below the tarball's top directory) to
    dest; return the set found. Stops reading once all are found. Nothing else is written."""
    wanted = {w for w in wanted if safe_relpath(w)}
    found = set()
    dest = Path(dest)
    with tarfile.open(fileobj=fileobj, mode="r|*") as tar:
        for member in tar:
            if not member.isfile():
                continue
            parts = [p for p in member.name.split("/") if p not in ("", ".")]
            name = "/".join(parts[1:])
            if name not in wanted or name in found:
                continue
            src = tar.extractfile(member)
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            found.add(name)
            if found == wanted:
                break
    return found


def open_tarball(source):
    if source == "-":
        return sys.stdin.buffer
    if re.match(r"https?://", source):
        return urllib.request.urlopen(source, timeout=60)
    return open(source, "rb")


def source_revision(read):
    """The 40-hex revision on sourcestamp.txt's `…/rev/<hash>` line, or None. upstream.yml asks
    Taskcluster for Mozilla's build of it (the artifact preflight, spec m7-upstream-autopilot)."""
    data = read(SOURCESTAMP)
    m = re.search(rb"/rev/([0-9a-f]{40})\s*$", data or b"", re.M)
    return m.group(1).decode("ascii") if m else None


def source_tree(read):
    """The hg.mozilla.org tree on sourcestamp.txt's revision line (`releases/mozilla-release`,
    `releases/mozilla-beta` for a Beta), or None. The preflight looks the build up in that tree's
    index and accepts only those two (spec upstream-beta-canary)."""
    data = read(SOURCESTAMP)
    m = re.search(rb"^https://hg\.mozilla\.org/(\S+)/rev/[0-9a-f]{40}\s*$", data or b"", re.M)
    return m.group(1).decode("ascii", "replace") if m else None


def firefox_version(read):
    data = read(MILESTONE)
    if data is None:
        return None
    lines = [
        line.strip()
        for line in data.decode("utf-8", "replace").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    return lines[-1] if lines else None


# --- reports -----------------------------------------------------------------------------------


def summary_line(report):
    counts = report["counts"]
    parts = [f"{counts[s]} {s}" for s in ORDER if counts[s]]
    return f"{len(report['patches'])} patches: " + ", ".join(parts)


def note(p):
    if p["missing"]:
        return ", ".join(f"`{m}` is gone upstream" for m in p["missing"])
    bad = [h for h in p["hunks"] if h["status"] in ("fuzz", "failed")]
    if bad:
        return "; ".join(
            f"hunk {h['index']}/{h['of']} of `{h['file']}` "
            + (f"needs fuzz {h['fuzz']}" if h["status"] == "fuzz" else "fails")
            for h in bad
        )
    moved = [h for h in p["hunks"] if h["offset"]]
    if moved:
        return "; ".join(f"hunk {h['index']} moved {h['offset']:+d} lines" for h in moved)
    if p["status"] == "applied":
        return "already in the tree"
    return ""


def md_escape(text):
    """Inline text safe in Markdown: HTML escaped, Markdown punctuation backslashed."""
    return re.sub(r"([\\`*_\[\]|#!~])", r"\\\1", html.escape(text, quote=False))


def fence(text):
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def render_markdown(report, hunks=True):
    # config/milestone.txt comes from the tarball: escape it like any upstream text.
    title = f"Firefox {md_escape(report['firefox'])}" if report["firefox"] else "the new Firefox"
    out = [f"### Patch check against {title}", ""]
    out.append(f"Source: {report['source']}. {summary_line(report)}.")
    out.append("")
    failing = [p for p in report["patches"] if not p["imports"]]
    if failing:
        out.append(
            f"**`surfer import` will fail**: {len(failing)} patch(es) need re-exporting "
            '(docs/rebase.md, "A patch does not apply").'
        )
    else:
        out.append("Every patch applies; `surfer import` should succeed.")
    out += ["", "| Patch | Result | Hunks | Note |", "| --- | --- | --- | --- |"]
    for p in report["patches"]:
        cells = [f"`{p['patch']}`", p["status"], str(len(p["hunks"])), note(p)]
        out.append("| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |")
    if hunks:
        for p in failing:
            for h in p["hunks"]:
                if "text" not in h:
                    continue
                f = fence(h["text"])
                what = f"needs fuzz {h['fuzz']}" if h["status"] == "fuzz" else "fails"
                out += [
                    "",
                    f"<details><summary><code>{html.escape(p['patch'])}</code>: hunk "
                    f"{h['index']}/{h['of']} of <code>{html.escape(h['file'])}</code> {what}"
                    "</summary>",
                    "",
                    f"{f}diff",
                    h["text"].rstrip("\n"),
                    f,
                    "",
                    "</details>",
                ]
    text = "\n".join(out) + "\n"
    if hunks and len(text) > MARKDOWN_LIMIT:
        return render_markdown(report, hunks=False).rstrip("\n") + (
            "\n\nHunks omitted: too long for a PR body. See the `patch-check` artifact (JSON).\n"
        )
    return text


def render_text(report):
    width = max((len(p["patch"]) for p in report["patches"]), default=0)
    lines = [f"patch-check: {report['source']} (Firefox {report['firefox'] or '?'})"]
    for p in report["patches"]:
        line = f"  {p['status']:<8} {p['patch']:<{width}}  {note(p).replace('`', '')}"
        lines.append(line.rstrip())
    lines.append(summary_line(report) + ("" if report["ok"] else "; surfer import will fail"))
    return "\n".join(lines) + "\n"


# --- main --------------------------------------------------------------------------------------


def build_report(src, read, source):
    src = Path(src)
    patches = find_patches(src)
    if not patches:
        raise CheckError(f"no .patch files under {src}")
    rows = []
    for path in patches:
        label = path.relative_to(src.parent).as_posix()
        try:
            rows.append(check_patch(path, label, read))
        except ValueError as err:
            raise CheckError(f"{label}: {err}") from err
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in ORDER}
    return {
        "version": 1,
        "ran": True,
        "firefox": firefox_version(read),
        "revision": source_revision(read),
        "tree": source_tree(read),
        "source": source,
        "ok": all(r["imports"] for r in rows),
        "counts": counts,
        "patches": rows,
    }


def patched_files(src):
    files = set()
    for path in find_patches(src):
        try:
            parsed = parse_patch(Path(path).read_text(encoding="utf-8"))
        except ValueError as err:
            raise CheckError(f"{path.relative_to(Path(src).parent).as_posix()}: {err}") from err
        files.update(f.path for f in parsed)
    return sorted(files)


def did_not_run(error, source):
    """The report when no verdict exists: upstream.yml must not read it as "patches fail"."""
    return {
        "version": 1,
        "ran": False,
        "ok": False,
        "error": error,
        "firefox": None,
        "source": source,
        "counts": {},
        "patches": [],
    }


def render_did_not_run(report):
    f = fence(report["error"])
    return (
        f"### Patch check did not run\n\nSource: {report['source']}. No verdict on any patch; "
        f"run it by hand (docs/rebase.md, step 2).\n\n{f}text\n{report['error']}\n{f}\n"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--src", default=str(ROOT / "src"), help="directory of .patch files")
    tree = parser.add_mutually_exclusive_group()
    tree.add_argument("--engine", help="Firefox source tree (default: engine/)")
    tree.add_argument("--tarball", help="Firefox source tarball: file, URL or - for stdin")
    parser.add_argument("--ref", help="with --engine: read this commit (default HEAD if a repo)")
    parser.add_argument("--worktree", action="store_true", help="with --engine: working tree")
    parser.add_argument("--json", help="write the report as JSON here")
    parser.add_argument("--markdown", help="write a PR-body summary here")
    parser.add_argument("--list-files", action="store_true", help="print patched paths, exit")
    parser.add_argument(
        "--drain", action="store_true", help="with --tarball: read the stream to its end"
    )
    parser.add_argument(
        "--extract", action="append", default=[], help="with --tarball: also extract this file"
    )
    parser.add_argument("--extract-to", help="with --extract: directory to write the files to")
    args = parser.parse_args(argv)

    source = f"tarball {args.tarball}" if args.tarball else str(args.engine or "engine/")
    try:
        report = run_check(args)
    except CheckError as err:
        error = str(err)
    except Exception as err:  # anything else is "did not run", never a verdict
        error = f"unexpected {type(err).__name__}: {err}"
    else:
        if report is None:  # --list-files
            return 0
        sys.stdout.write(render_text(report))
        if args.json:
            Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        if args.markdown:
            Path(args.markdown).write_text(render_markdown(report), encoding="utf-8")
        return 0 if report["ok"] else 1

    print(f"patch-check: {error}", file=sys.stderr)
    report = did_not_run(error, source)
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.markdown:
        Path(args.markdown).write_text(render_did_not_run(report), encoding="utf-8")
    return 2


class CountingReader:
    """A binary stream that counts what is read from it, and can read the rest (--drain)."""

    def __init__(self, raw):
        self.raw = raw
        self.count = 0

    def read(self, size=-1):
        data = self.raw.read(size)
        self.count += len(data)
        return data

    def drain(self):
        while self.read(1 << 20):
            pass


def run_check(args):
    """The report, or None after --list-files. Raises CheckError when there is no verdict."""
    if args.list_files:
        print("\n".join(patched_files(args.src)))
        return None
    tarball_bytes = None
    with tempfile.TemporaryDirectory(prefix="patch-check-tree-") as tmp:
        if args.tarball:
            extra = set(args.extract)
            bad = [p for p in extra if not safe_relpath(p)]
            if bad or (extra and not args.extract_to):
                raise CheckError(f"--extract needs --extract-to and paths inside the tree: {bad}")
            wanted = set(patched_files(args.src)) | {MILESTONE, SOURCESTAMP} | extra
            try:
                with open_tarball(args.tarball) as raw:
                    stream = CountingReader(raw)
                    found = extract_from_tarball(stream, wanted, tmp)
                    if args.drain:
                        stream.drain()
                    tarball_bytes = stream.count
            except (tarfile.TarError, EOFError, lzma.LZMAError, OSError) as err:
                raise CheckError(f"cannot read tarball {args.tarball}: {err}") from err
            if SOURCESTAMP not in found:
                raise CheckError(f"{args.tarball}: no {SOURCESTAMP}; not a Firefox source tarball")
            for rel in sorted(extra & found):
                target = Path(args.extract_to) / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(Path(tmp) / rel, target)
            read = worktree_reader(tmp)
            source = f"tarball {Path(args.tarball).name if args.tarball != '-' else '(stdin)'}"
        else:
            engine = Path(args.engine or ROOT / "engine")
            if not engine.is_dir():
                raise CheckError(f"{engine} is not a directory (run `npx surfer download`)")
            is_repo = (engine / ".git").exists()
            if args.ref and (args.worktree or not is_repo):
                raise CheckError("--ref needs a git engine and no --worktree")
            ref = args.ref or "HEAD"
            commit = resolve_commit(engine, ref) if is_repo and not args.worktree else None
            if args.ref and commit is None:
                raise CheckError(f"{engine}: no commit {args.ref!r}")
            if commit:
                read = git_reader(engine, commit)
                source = f"{engine} at {ref}"
            else:
                # No commit (e2e.yml's `git init` after CI_SKIP_INIT): the working tree.
                read = worktree_reader(engine)
                source = f"{engine} (working tree)"
        report = build_report(args.src, read, source)
    if tarball_bytes is not None:
        report["tarball_bytes"] = tarball_bytes
    return report


if __name__ == "__main__":
    sys.exit(main())
