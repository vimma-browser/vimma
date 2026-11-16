#!/usr/bin/env python3
"""Patch-size audit: every src/**/*.patch with its files, hunks and changed lines, against the
ADR-003 patch register.

Run by the quarterly patch-audit.yml (ARCHITECTURE.md): review patch sizes and move code out of
.patch files.
Flags a patch missing from the register (ADR-003: every .patch needs a line there) and a
register line whose patch no longer exists. `large` marks a patch at or over 8000 characters,
the size at which `surfer export` warns.

The register also gives each patch a budget (its most hunks and changed lines) and the date it was
last reviewed. A patch over its budget, or a register line without one, fails the audit; a review
older than --max-age-days (92, a quarter) is listed as due but does not change the exit status, so
CI stays green while the quarterly run (.github/workflows/patch-audit.yml) opens an issue for it.

Exit status: 0 the register matches and every patch is within budget, 1 it does not, 2 the files
or arguments could not be read. Python stdlib only; docs/rebase.md, "Patch-size audit".
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

from patches import find_patches, parse_patch

ROOT = Path(__file__).resolve().parent.parent.parent
ADR = Path("docs/adr/003-own-files-minimal-patches.md")
REGISTER_HEADING = re.compile(r"^#+\s+Patch register\s*$")
PATCH_CELL = re.compile(r"^\|\s*`(src/[^`]+\.patch)`")
SURFER_WARN_CHARS = 8000  # surfer export: "Exported patch is over 8000 characters"
MAX_AGE_DAYS = 92  # a quarter: patch-audit.yml runs on the first day of every third month


def read_register(text):
    """Patch paths in the first column of the table under the "Patch register" heading."""
    paths = []
    inside = False
    for line in text.splitlines():
        if REGISTER_HEADING.match(line):
            inside = True
        elif inside and line.startswith("#"):
            break
        elif inside and (m := PATCH_CELL.match(line)):
            paths.append(m.group(1))
    return paths


def _cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _count(cell):
    return int(cell) if cell.isdigit() else None


def _date(cell):
    try:
        return datetime.date.fromisoformat(cell).isoformat()
    except ValueError:
        return None


def read_budgets(text):
    """{patch: {hunks, lines, reviewed}} from the register's Hunks, Lines and Reviewed columns.

    A missing column, an empty cell, or a value that is not a count or an ISO date is None.
    """
    budgets = {}
    columns = None
    inside = False
    for line in text.splitlines():
        if REGISTER_HEADING.match(line):
            inside = True
        elif inside and line.startswith("#"):
            break
        elif inside and columns is None and line.startswith("|"):
            columns = _cells(line)
        elif inside and (m := PATCH_CELL.match(line)):
            row = dict(zip(columns or [], _cells(line)))
            budgets[m.group(1)] = {
                "hunks": _count(row.get("Hunks", "")),
                "lines": _count(row.get("Lines", "")),
                "reviewed": _date(row.get("Reviewed", "")),
            }
    return budgets


def audit(root, src, adr, today=None, max_age_days=MAX_AGE_DAYS):
    root = Path(root)
    today = today or datetime.date.today()
    text = Path(adr).read_text(encoding="utf-8")
    register = read_register(text)
    budgets = read_budgets(text)
    none = {"hunks": None, "lines": None, "reviewed": None}
    rows = []
    for path in find_patches(src):
        patch = path.read_text(encoding="utf-8")
        files = parse_patch(patch)
        hunks = [h for f in files for h in f.hunks]
        rel = path.resolve().relative_to(root.resolve()).as_posix()
        budget = budgets.get(rel, none)
        reviewed = budget["reviewed"]
        rows.append(
            {
                "patch": rel,
                "files": len(files),
                "hunks": len(hunks),
                "added": sum(h.added for h in hunks),
                "removed": sum(h.removed for h in hunks),
                "chars": len(patch),
                "large": len(patch) >= SURFER_WARN_CHARS,
                "registered": rel in register,
                "budget": {"hunks": budget["hunks"], "lines": budget["lines"]},
                "reviewed": reviewed,
                "age_days": (
                    (today - datetime.date.fromisoformat(reviewed)).days if reviewed else None
                ),
            }
        )
    present = {r["patch"] for r in rows}
    registered = [r for r in rows if r["registered"]]
    over = []
    for r in registered:
        used = {"hunks": r["hunks"], "lines": r["added"] + r["removed"]}
        for what in ("hunks", "lines"):
            limit = r["budget"][what]
            if limit is not None and used[what] > limit:
                over.append({"patch": r["patch"], "what": what, "used": used[what], "budget": limit})
    return {
        "adr": str(adr),
        "today": today.isoformat(),
        "max_age_days": max_age_days,
        "patches": rows,
        "totals": {
            "patches": len(rows),
            "hunks": sum(r["hunks"] for r in rows),
            "added": sum(r["added"] for r in rows),
            "removed": sum(r["removed"] for r in rows),
        },
        "unregistered": sorted(r["patch"] for r in rows if not r["registered"]),
        "missing": [p for p in register if p not in present],
        "over_budget": over,
        "unbudgeted": [
            r["patch"]
            for r in registered
            if None in (r["budget"]["hunks"], r["budget"]["lines"], r["reviewed"])
        ],
        "due": [
            {"patch": r["patch"], "reviewed": r["reviewed"], "age_days": r["age_days"]}
            for r in registered
            if r["age_days"] is not None and r["age_days"] > max_age_days
        ],
    }


def failed(report):
    """True when the audit fails: a register mismatch, or a patch over or without a budget."""
    return bool(
        report["unregistered"] or report["missing"] or report["over_budget"] or report["unbudgeted"]
    )


def render(report):
    head = ("Patch", "Files", "Hunks", "+", "-", "Chars", "Register")
    rows = [
        (
            r["patch"],
            str(r["files"]),
            str(r["hunks"]),
            str(r["added"]),
            str(r["removed"]),
            str(r["chars"]) + (" large" if r["large"] else ""),
            "yes" if r["registered"] else "NO",
        )
        for r in report["patches"]
    ]
    widths = [max(len(row[i]) for row in [head, *rows]) for i in range(len(head))]

    def fmt(row):
        cells = [row[0].ljust(widths[0])] + [c.rjust(w) for c, w in zip(row[1:-1], widths[1:-1])]
        return "  ".join([*cells, row[-1]]).rstrip()

    t = report["totals"]
    out = [fmt(head), *map(fmt, rows)]
    out.append(f"Total: {t['patches']} patches, {t['hunks']} hunks, +{t['added']} -{t['removed']}")
    if report["unregistered"]:
        out.append(f"Not in the ADR-003 register ({report['adr']}):")
        out += [f"  {p}" for p in report["unregistered"]]
    if report["missing"]:
        out.append("In the ADR-003 register but no such file:")
        out += [f"  {p}" for p in report["missing"]]
    if not report["unregistered"] and not report["missing"]:
        out.append(f"Register matches src/ ({t['patches']} patches).")
    large = [r["patch"] for r in report["patches"] if r["large"]]
    if large:
        out.append(f"Over {SURFER_WARN_CHARS} characters (surfer export warns): {', '.join(large)}")
    for o in report["over_budget"]:
        out.append(f"Over budget: {o['patch']}: {o['used']} {o['what']}, budget {o['budget']}")
    for p in report["unbudgeted"]:
        out.append(f"No budget or review date in the register: {p}")
    for d in report["due"]:
        out.append(f"Due for review: {d['patch']}: last reviewed {d['reviewed']}, {d['age_days']} days")
    return "\n".join(out) + "\n"


def _used(used, limit):
    if limit is None:
        return f"{used} / —"
    return f"{used} / {limit}" + (" **over**" if used > limit else "")


def render_markdown(report):
    """The report as Markdown: the body of the quarterly tracking issue."""
    t = report["totals"]
    out = [
        f"Patch audit of {t['patches']} patches on {report['today']} against the ADR-003 register "
        f"(`{report['adr']}`). Hunks and lines are used / budget; a review is due after "
        f"{report['max_age_days']} days.",
        "",
        "| Patch | Hunks | Lines | Chars | Reviewed | Age (days) |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in report["patches"]:
        b = r["budget"]
        age = "—" if r["age_days"] is None else str(r["age_days"])
        out.append(
            f"| `{r['patch']}` | {_used(r['hunks'], b['hunks'])} | "
            f"{_used(r['added'] + r['removed'], b['lines'])} | "
            f"{r['chars']}{' large' if r['large'] else ''} | {r['reviewed'] or '—'} | {age} |"
        )
    out += ["", f"Total: {t['patches']} patches, {t['hunks']} hunks, +{t['added']} -{t['removed']}."]
    sections = [
        ("Not in the register", [f"- `{p}`" for p in report["unregistered"]]),
        ("In the register but no such file", [f"- `{p}`" for p in report["missing"]]),
        (
            "Over budget",
            [
                f"- `{o['patch']}`: {o['used']} {o['what']}, budget {o['budget']}"
                for o in report["over_budget"]
            ],
        ),
        ("No budget or review date in the register", [f"- `{p}`" for p in report["unbudgeted"]]),
        (
            f"Due for review (last reviewed over {report['max_age_days']} days ago)",
            [
                f"- `{d['patch']}`: last reviewed {d['reviewed']}, {d['age_days']} days"
                for d in report["due"]
            ],
        ),
    ]
    for title, items in sections:
        if items:
            out += ["", f"### {title}", "", *items]
    if not failed(report) and not report["due"]:
        out += ["", "Every patch is registered, within budget and reviewed this quarter."]
    return "\n".join(out) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(ROOT), help="repository root (default: this repo)")
    parser.add_argument("--src", help="directory of .patch files (default: ROOT/src)")
    parser.add_argument("--adr", help=f"the register (default: ROOT/{ADR})")
    parser.add_argument("--json", help="write the report as JSON here")
    parser.add_argument("--markdown", help="write the report as Markdown here (the issue body)")
    parser.add_argument("--today", help="the ISO date reviews are aged against (default: today)")
    parser.add_argument(
        "--max-age-days",
        type=int,
        default=MAX_AGE_DAYS,
        help=f"a review older than this many days is due (default: {MAX_AGE_DAYS})",
    )
    args = parser.parse_args(argv)
    root = Path(args.root)
    try:
        today = datetime.date.fromisoformat(args.today) if args.today else None
        report = audit(
            root,
            Path(args.src or root / "src"),
            Path(args.adr or root / ADR),
            today=today,
            max_age_days=args.max_age_days,
        )
    except (OSError, ValueError) as err:
        print(f"patch-audit: {err}", file=sys.stderr)
        return 2
    sys.stdout.write(render(report))
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.markdown:
        Path(args.markdown).write_text(render_markdown(report), encoding="utf-8")
    return 1 if failed(report) else 0


if __name__ == "__main__":
    sys.exit(main())
