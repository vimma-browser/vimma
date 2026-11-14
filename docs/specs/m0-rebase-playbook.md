# Spec: m0-rebase-playbook

Status: implemented · Milestone: M0 · Area: upstream (`tools/upstream/`,
`.github/workflows/upstream.yml`, `docs/rebase.md`)

## User story

As the maintainer, when Firefox ships a release I get a bump PR that already says which of our
`.patch` files still apply, and a playbook that takes me from that PR to a merged, tested bump in
half a day (plan §6), so the monthly rebase stops being the project's biggest risk (plan §9).

## Scope

- `docs/rebase.md`: the playbook. Detection, download, import, resolving a failed hunk,
  `surfer export`, full and artifact builds with the whole mochitest suite, the artifact preflight,
  version files, the branding prefs comparison, the cfr provider refresh, the M4 split-view
  contract as the canary for upstream split-view changes, the security dot-release fast path, and
  rollback.
- `tools/upstream/patch-check.py`: dry run of every `src/**/*.patch` against a Firefox tree with
  `git apply --check` and Surfer's flags. Reports, per patch, clean / offset / applied / fuzz /
  failed, with each failing hunk. JSON for machines and a Markdown summary for a PR body. The tree
  is `engine/` (HEAD or the working tree) or a source tarball, a file or stdin.
- `upstream.yml`: put that summary in the bump PR's body. Least privilege: the check runs in a
  read-only job, and only the job that opens the PR can write.
- `tools/upstream/patch-audit.py`: plan §4's Sunday patch-size review. Shows each patch's files,
  hunks and changed lines, flags a patch missing from the ADR-003 register and a register line
  without a patch.
- `docs/runbook/` points to the playbook; `docs/limits.md` gets what we learned.

## Tests (written first)

- `tools/upstream/test_patch_check.py`: one fixture patch per verdict, made with `git diff` like
  `surfer export`, against a fixture "new Firefox" tree (`fixtures/patch-check/`). Covers: the
  verdicts and `imports`; the offset value; fuzz 1; a two-hunk patch whose second hunk fails, named
  by header and text; a file gone upstream. Also the counts and the Firefox version from
  `config/milestone.txt`, and the Markdown (a row per patch, failing hunks only, `|` escaped, a
  longer fence for backticks, hunks dropped past a PR body's size). Tree sources: a tarball file,
  stdin, an unreadable or cut-off tarball (exit 2), extraction limited to patched paths (never
  outside the directory). Also an engine repo's HEAD versus its working tree, a repo without a
  commit (e2e.yml's) and a missing `--ref`. Finally, every real `src/**/*.patch` parses.
- `tools/upstream/test_patch_audit.py`: the register is read only from the "Patch register"
  table; unregistered and missing patches are flagged with exit 1; hunks and changed lines per
  patch; and **this repo's register matches `src/`** (so `npm run test:py` in CI enforces
  ADR-003's "every new .patch needs a line").

Red (before the scripts existed): `Ran 26 tests … FAILED (failures=7, errors=5)`, every new test
failing with `can't open file '…/tools/upstream/patch-check.py'` (or `patch-audit.py`). Two more
tests were added red later. One was the Markdown table with `|` in a path (`AssertionError: 7 != 5`).
The other was the repo without a commit (`patch-check: …/engine: no commit 'HEAD'`, exit 2 instead
of 1). Green: `npm run test:py` → `Ran 48 tests … OK`.

Hardening (PR #31): 15 new tests. They cover create, delete, rename and malformed fixtures;
"did not run" in both modes, plus for a crash and for `--list-files`; `--drain`; the milestone
escaping; and `test_verify_sha512.py`. Red: `Ran 63 tests … FAILED (failures=8, errors=5)`.
Two already passed: create/delete, and the missing-SHA512SUMS case, which exited 2 only because
the script itself was missing. Green: `Ran 63 tests … OK`.

## Findings (2026-10-09, Firefox 157.0.1)

- **All six patches apply cleanly to 157.0.1**, both from the release tarball and from
  `engine/` at HEAD (`6 patches: 6 clean`). On the imported working tree all six are `applied`.
- **Register matches `src/`**: 6 patches, 6 hunks, +10 −5 lines. The largest is
  `tab-bar-visibility-js.patch` (1,366 characters, +4 −2). All are far below the 8,000 characters
  at which `surfer export` warns.
- **`surfer import` stops at the first patch that fails.** Surfer's `TaskList` throws on the first
  error, so the remaining patches are not even tried. `git apply` has no fuzz, so a hunk whose
  context drifted fails just as hard as one whose lines are gone. Before applying, Surfer runs
  `git apply -R` and discards the error, which is why an already-patched engine imports again. So
  patch-check checks every patch and hunk on its own, and reports "fuzz" (applies with
  `git apply -C2`/`-C1`) separately from "failed": a fuzz verdict is a mechanical re-export.
- **The source tarball fits a hosted runner easily, because nothing is unpacked.** The tarball is
  811,383,348 bytes. Streamed through patch-check, only the patched files (plus
  `config/milestone.txt` and `sourcestamp.txt`) are written; disk use is a few kilobytes, against
  14 GB on the runner. Decompression is the cost. Locally (16 threads): `xz -T1` of the whole
  stream takes 20.8 s, `xz -T2` 10.0 s, and `cat tarball | patch-check.py --tarball -` 25 to 31 s.
  Python's `lzma` is single-threaded, and the read stops once the last wanted file is out, so
  `cat` dies of SIGPIPE (141). Estimate for `ubuntu-latest`: 1 to 2 min, download included
  (archive.mozilla.org is a CDN). The check job's timeout went from 5 to 15 min; it costs minutes
  only when a release is found.
- **The pipeline's status is patch-check's own** (`${PIPESTATUS[2]}` after `curl | tee`). A real
  download failure shows up as exit 2 (an empty or truncated xz stream), and the PR body says the
  check did not run. Simulated with a 300 MB prefix of the 157.0.1 tarball:
  `cannot read tarball -: unexpected end of data`, status 2, "norun".
- **Tarball hash.** The workflow streams the tarball once: `tee` feeds a FIFO
  read by `sha512sum` and patch-check, which runs with `--drain` so it reads to the end and the
  hash covers the whole file. The hash is compared with the `source/firefox-X.Y.source.tar.xz`
  line of `https://archive.mozilla.org/pub/firefox/releases/X.Y/SHA512SUMS`
  (`tools/upstream/verify-sha512.py`). A mismatch fails the job, names both hashes and opens no
  PR. For 157.0.1, `SHA512SUMS` line 821 (`c019202b…102858`) equals `sha512sum` of the cached
  tarball. The local simulation of the whole step (`cat` in place of `curl`) printed
  `6 patches: 6 clean` and `matches SHA512SUMS`. **GPG is not checked** (`SHA512SUMS.asc`
  exists): HTTPS from archive.mozilla.org is the trust anchor, the tarball only feeds a report,
  and the build uses `surfer download`'s own copy. Adding it would mean pinning Mozilla's release
  signing key in the repo and rotating it.
- **Did not run is not "patches fail".** A malformed or unsupported patch (rename, copy,
  mode-only, no hunks) or any unexpected exception gives exit 2. It also writes a
  `patch-check.md` that says the check did not run, and a JSON report with `"ran": false`.
  upstream.yml maps exit 0, 1 and 2 to `result=ok|fail|norun`, and the PR body opens with a
  matching verdict line. A pure rename is rejected with a message that names the patch, because
  `surfer export` never writes one; creating and deleting a file are supported and checked.
- **Artifact preflight for 157.0.1**: the index entry
  `gecko.v2.mozilla-release.shippable.revision.737ec77d…firefox.linux64-opt` exists, with expiry
  `2027-10-05T13:54:14Z`.

## Out of scope

- Claude Code resolving conflicts on the bump PR (plan §4: ≤3 pushes). claude.yml's `@claude`
  job is read-only today; the summary and the JSON artifact are its inputs once it can push.
- Auto-merge of clean bumps and the `security` flag and auto-approval (plan §4); `maintenance.yml`
  (the Sunday run would call `patch-audit.py`; the quarterly `patch-audit.yml` now runs it).
- An automated cfr provider comparison: the playbook has a one-line check instead.

## Settled

- Python stdlib, like the rest of `tools/upstream`, with a shared parser (`patches.py`).
- Run on a hosted runner against the release tarball, not on the self-hosted runner: it needs no
  machine online, and it checks exactly the bytes `surfer download` will fetch.
