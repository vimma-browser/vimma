# Rebase playbook: moving to a new Firefox release

We track Firefox **release**: every major release (every two weeks) and every dot release (ADR-002). Our upstream
surface is the `.patch` files under `src/` (ADR-003 lists each one and why). The **upstream
autopilot** (`upstream.yml`, ADR-015) does the mechanical part on its own: it notices the release,
rebases our patches onto it, runs the PR suites and opens the PR. This page is what it does, what
you do with its PR, the manual procedure for when it cannot finish (a patch conflict, no
artifacts, a failing suite), the fast path for security releases and how to roll back.
Background: [ADR-002](adr/002-upstream-release-channel.md),
[ADR-003](adr/003-own-files-minimal-patches.md), [ADR-010](adr/010-pr-artifact-builds.md),
[ADR-015](adr/015-upstream-autopilot.md), [runbook](runbook.md) (CI and automation). Specs:
[m7-upstream-autopilot](specs/m7-upstream-autopilot.md),
[m0-rebase-playbook](specs/m0-rebase-playbook.md).

## At a glance

| #   | Step                                      | Where                                            | Time                                     |
| --- | ----------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| 1   | Autopilot: issue, patch check, suites, PR | `upstream.yml`, hosted runners                   | ≤ 6 h after the release                  |
| 2   | Download the new source                   | your machine                                     | 12.5 min                                 |
| 3   | Import; fix any patch that fails          | your machine                                     | 1 min, plus fixes                        |
| 4   | Full build + full mochitest suite         | your machine, and the hosted nightly after merge | 39 min cold + suite (nightly: about 2 h) |
| 5   | Artifact build + suite (preflight first)  | autopilot, `e2e.yml` on the PR                   | 5 min                                    |
| 6   | Version files, branding prefs, cfr, SB    | autopilot (checks prefs), your machine           | 5 min                                    |
| 7   | Split-view contract (M4 canary)           | both builds                                      | part of the suite                        |
| 8   | Mark ready, CI, merge                     | GitHub                                           | CI ≈ 8 min                               |

**When the autopilot's PR is green (the common case) you do only step 8**, until auto-merge of
a green bump is built ([#259](https://github.com/vimma-browser/vimma/issues/259)), which removes that
step too. Steps 2–7 are for a
draft: a patch that does not apply, a failing suite, or a release without Mozilla artifacts.
Decision points are marked **Decide**.

## Before the release: the Beta canary

Firefox now ships a major release every two weeks, and its first Beta appears about 15 days
before it. `upstream-beta.yml` (spec [upstream-beta-canary](specs/upstream-beta-canary.md))
tests `main` against each Beta build within about 6 hours of its publication: it verifies the
Beta's source tarball against `SHA512SUMS`, dry-runs our patches on it, and runs `e2e.yml` in
Beta mode (artifact build, every check, `tests/browser/` and `tests/e2e/`, each reported even
after another fails). It never pushes, never opens a PR and never changes `surfer.json`.

**What the issue means.** Findings go to one issue per Firefox version, `Firefox N beta: canary
findings`, labelled `upstream-beta`. A new issue mentions the owner. Its body always shows the
latest run: the Beta build and its revision, the `main` commit tested, the run link, the patches
that do not apply with their hunks, failed checks, mochitest failures grouped by test file and
failed e2e scenarios. Each later run that changes the results adds a comment, **New** and
**Fixed**; a run with the same results only refreshes the body. A run that passes completely
closes the issue, and once Firefox `N` is released the canary closes it with a link to the
autopilot's `Firefox N.0 released` issue. The run itself stays green on findings; a red run means
the canary is broken (product-details or the archive unreadable, a checksum mismatch, a crash).

**Fixing on `main` for both versions.** `main` keeps the release in `surfer.json`. A front-end fix
for a Beta change must work on the release and on the Beta alike, for example by feature-testing
the upstream API instead of checking a version (the `getClassObject` fix in #186 constructs
upstream's classes from their modules, on 157 and 158 alike). Run the suite on the Beta from your
branch with `gh workflow run e2e.yml --ref <branch> -f firefox-version=159.0b2`, and on the
release as PR CI does.

**Preparing a patch re-export.** A patch applies to one tree, so a patch the Beta breaks cannot
be fixed on `main` ahead of time. Prepare the re-export instead: check out the Beta's source
(`surfer.json` set to the Beta in a scratch checkout, `python3 tools/upstream/bump-surfer-json.py
--allow-beta 159.0b2`, never committed), redo the hunk the issue shows (section 3), and keep the
new patch on a branch. On release day the autopilot's PR fails on the same patch; apply the
prepared change there. The autopilot's tracking issue then already has the work done, and its
bump PR names the canary's issues for that version.

## 1. The autopilot: from release to PR

`upstream.yml` runs every 4 h (`:17`) and on demand (`gh workflow run upstream.yml`; add
`-f rebuild=true` to redo a release whose branch already exists). Its jobs:

1. **`detect`** (read-only, < 1 min). `tools/upstream/detect.mjs` reads product-details
   (`firefox_versions.json` for `LATEST_FIREFOX_VERSION`, `firefox.json` for release dates) and
   Mozilla's [advisories index](https://www.mozilla.org/security/advisories/). It reports whether
   the latest release is newer than `surfer.json`, whether it is a major (X.0) or dot release
   (X.Y.Z), and whether an MFSA advisory names it (a **security release**, with the advisory's
   severity). An unreadable advisories page means "unknown", which counts as security. It also
   measures **drift** (step "Drift" below). The job summary shows all of it.
2. **`track`** (`issues: write`). Opens the tracking issue **"Firefox X.Y.Z released"**, labelled
   `upstream`, and `security` when it is (or may be) a security release, with the advisory links
   and the merge deadline. A security release mentions you. If Mozilla publishes the advisory
   after the release, a later run adds `security` and mentions you then.
3. **`patch-check`** (read-only). Streams
   `https://archive.mozilla.org/pub/firefox/releases/X.Y.Z/source/firefox-X.Y.Z.source.tar.xz`
   (≈ 810 MB, the file `surfer download` fetches) through
   `tools/upstream/patch-check.py --tarball - --drain`: only the patched files are extracted, so
   the disk is barely touched; about 1–2 min. The same stream goes through `tee` into
   `sha512sum`, and `tools/upstream/verify-sha512.py` compares it with the
   `source/firefox-X.Y.Z.source.tar.xz` line of `SHA512SUMS` next to it, after checking that
   `SHA512SUMS.asc` is a good signature by Mozilla's release key, pinned in the repository
   (ADR-021, docs/security.md B1). **A bad or missing signature, or a mismatch, fails the run**:
   no PR. Then `patch-audit.py` (ADR-003 register) and the artifact preflight
   (`artifact-preflight.mjs`: is Mozilla's build of the tarball's revision in the Taskcluster
   index?). The reports are the run's `patch-check` artifact (30 days).
4. **`test`** (read-only). Only when every patch applies and the artifacts exist: `e2e.yml`, called
   with the new version. It bumps `surfer.json` in its own checkout and does what PR CI does:
   `firefox-source.sh` (signature and SHA-512 checked again), `npm run import`, the branding
   prefs test, the upstream-prefs check (cfr provider and Safe Browsing lists, step 6), the artifact build,
   `tests/browser/` and `tests/e2e/`. Without artifacts the suites are skipped and the PR says
   so: run steps 2–4 on your machine (the full-build path).
5. **`publish`** (the only job that can push). Pushes `upstream/firefox-X.Y.Z` with one commit,
   `upstream: firefox X.Y.Z`, and opens the PR of that title, labelled like the issue, which
   closes the issue on merge. Older open bump PRs and tracking issues are closed as superseded.
   For a new major, the PR body also names the Beta canary's `Firefox N beta: canary findings`
   issues, open or closed (see "Before the release: the Beta canary"), so you see what was
   already found and fixed on `main` before you review the bump.
   The PR is a **draft** unless every patch applies, the suites passed and `UPSTREAM_PR_TOKEN` is
   set (runbook): a PR opened with `GITHUB_TOKEN` starts no CI until you mark it ready.
   **If Actions may not open PRs** (the repository setting is off), the branch is still pushed
   and the tracking issue gets the whole summary plus a compare link with the title and
   `Closes #N` filled in: open the PR from it.

The PR body (`tools/upstream/autopilot-body.mjs`) is a table (tarball hash, patches, register,
artifacts, suites), the advisories, a **Conflicts** section when a patch does not apply (the
upstream files, and each failing hunk by header), what you do next, and the full patch check,
collapsed.

The patch check has one row per patch:

| Result    | Meaning                                                 | `surfer import`               |
| --------- | ------------------------------------------------------- | ----------------------------- |
| `clean`   | applies exactly                                         | applies                       |
| `offset`  | applies; a hunk moved (the note says how many lines)    | applies                       |
| `applied` | the tree already has it (only on an imported `engine/`) | reverts it, then re-applies   |
| `fuzz`    | applies only with less context (`git apply -C2`/`-C1`)  | **fails**: re-export (step 3) |
| `failed`  | a hunk's lines are gone, or the file is                 | **fails**: fix by hand        |

Each `fuzz` or `failed` hunk is listed under the table, collapsed, as the hunk from our patch.

**Decide (what you do with the PR):**

- **Green, ready for review** (a token is set) → review the diff (`surfer.json` only) and merge.
- **Green draft** ("mark it ready") → `gh pr ready <n>`: CI and e2e run as you; merge when green.
- **Draft, "some patches do not apply"** → steps 2–3 on the PR's branch (`gh pr checkout <n>`),
  push the re-exported patches; PR CI runs the suites. Or hand it to Claude: comment `@claude`
  on the PR with the Conflicts section.
- **Draft, "the suites did not pass"** → read the run's `mochitest (artifact build)` job.
  `upstream-prefs` failing prints the pref line to paste (step 6); anything else is a real
  regression: hold the bump, fix it on the branch.
- **"No Mozilla artifacts for this revision"** → steps 2–4 on your machine; e2e.yml on the PR
  will stay red until Mozilla indexes the build (it never has not, so far; check `surfer.json`).
- **"Patch check: did not run"** → no verdict at all, not "patches fail": the tarball was not
  readable (not published yet, or a network error) or a patch is malformed. Rerun with
  `gh workflow run upstream.yml -f rebuild=true`, or run the check yourself after step 2.
- **The run failed with "SHA-512 mismatch"** and no PR → do not trust that download. Rerun later;
  if it persists, compare by hand with `sha512sum .surfer/engine/firefox-X.Y.Z.source.tar.xz`.
- **A comment with a compare link instead of a PR** → open the PR from the link, then as above;
  enable the setting (runbook) so the next one is a PR.

A release is handled once its branch exists: later runs only keep the tracking issue's labels
current. To start over, close the PR with its branch (`gh pr close <n> --delete-branch`) or run
with `-f rebuild=true`.

### Drift: the deadline

Every run also compares the Firefox on `main` with every newer release. A release must be merged
within **3 days** of its release date if it is a security dot release, **7 days** for a major
release, **14 days** for a dot release without an advisory (docs/security.md, G2). Past that the
`drift` job opens one issue labelled `security`, "Vimma's Firefox X is past the security drift
limit", that mentions you, and **fails every run** until `surfer.json` on `main` moves. Merging
the bump is the fix; close the drift issue then.

## 2. Download the new source

On your machine, in the repo:

```sh
gh pr checkout <PR number>                  # branch upstream/firefox-X.Y
npx surfer download --force                 # deletes engine/ (and its 20 GB objdir), fetches X.Y
npm run verify-source                       # the tarball against Mozilla's signed SHA512SUMS
```

`surfer download` reads the version from `surfer.json` and caches the tarball in `.surfer/engine/`.
It checks no hash or signature; `npm run verify-source` checks that tarball against Mozilla's
signed `SHA512SUMS` (ADR-021) and fails if it does not match. Do not build from it if it fails.
Expect ≈ 12.5 min, `.surfer/` ≈ 0.8 GB and `engine/` ≈ 7.6 GB (runbook, First Firefox build).
Surfer commits the pristine tree as `Firefox X.Y` in `engine/.git`: that commit is what
`surfer export` diffs against, and what patch-check reads by default.

Check the patches before importing (≈ 1 s):

```sh
python3 tools/upstream/patch-check.py       # engine/ at HEAD: the pristine new Firefox
```

Expected, when all is well:

```text
patch-check: …/engine at HEAD (Firefox X.Y)
  clean    src/browser/base/content/browser-xhtml.patch
  …
11 patches: 11 clean
```

Exit status: 0 every patch imports, 1 at least one does not, 2 the check could not run (an
unreadable tree, a malformed or unsupported patch, or any crash). With 2, `--json` and
`--markdown` still write a report saying it did not run (`"ran": false`). Other
inputs: `--worktree` (the working tree, e.g. an engine you already imported, where every patch
reads `applied`), `--ref REF`, `--tarball FILE|URL|-`. For files: `--json`, `--markdown`.

## 3. Import, and fix a patch that fails

```sh
npm run import    # sync-core, version files, brand, surfer import, mozconfig
```

**How a failure shows up.** Surfer applies `src/**/*.patch` one at a time with
`git apply --ignore-space-change --ignore-whitespace`, after a silent `git apply -R` (which is why
re-importing is safe). It **stops at the first patch that fails**: the task named
`Apply …/src/<path>.patch` fails with git's message
(`error: patch failed: <file>:<line>`, `error: <file>: patch does not apply`), and later patches
are not tried. patch-check lists every failing patch, so read its report rather than repeating
the import one failure at a time.

**Fix one failed patch** (example: `browser-xhtml.patch` against `browser/base/content/browser.xhtml`):

1. Read the failing hunk (PR summary, or `python3 tools/upstream/patch-check.py --markdown x.md`).
   Note which line is ours (`+`) and which upstream lines anchored it (context).
2. Find where the anchor went in the new file:
   `grep -n 'browser-main.js' engine/browser/base/content/browser.xhtml`. If the file itself moved,
   find it with `grep -rl` or `find engine -name`. Upstream's history:
   <https://hg.mozilla.org/releases/mozilla-release/log/tip/browser/base/content/browser.xhtml>.
3. Re-make the same minimal change in `engine/`, by hand, or with
   `git -C engine apply --reject ../src/browser/base/content/browser-xhtml.patch` and then the
   `.rej` files (delete them afterwards). Keep the hunk as small as before (ADR-003); if the change
   no longer fits in a tiny hunk, stop and write it up in a spec, not in the bump PR.
4. Re-export from the repo root, with the path relative to `engine/`:

   ```sh
   npx surfer export browser/base/content/browser.xhtml
   # → Wrote "browser-xhtml.patch" to patches directory. (src/browser/base/content/)
   ```

   Surfer names the patch after the path, with dots turned to dashes. It warns if the patch is
   over 8,000 characters (it should never be).

5. Re-check and review:

   ```sh
   python3 tools/upstream/patch-check.py        # the fixed patch: clean
   git diff src/                                # same + lines as before, new context only
   python3 tools/upstream/patch-audit.py        # still registered, hunk count unchanged
   ```

6. Commit on the bump branch. For example, `upstream: re-export browser-xhtml.patch for Firefox X.Y`,
   with a body saying what moved upstream. If a patch moved to a new path, rename its ADR-003
   register line in the same commit (`npm run test:py` fails until the register matches `src/`).

**Decide (per failing patch):**

- `fuzz`: only the context drifted. Steps 3–5 are mechanical.
- `failed` with the anchor still present → re-make the change (steps 2–5).
- `failed`, file gone or anchor gone (upstream refactor) → the injection point needs a new design.
  Hold the bump (keep the PR as a draft), open a spec, and do not ship a half-working patch.

Run `npm run import` again until it completes.

## 4. Full build and the full mochitest suite

```sh
npx surfer build                                       # ≈ 39 min cold on 16 threads
engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma --version
# → Vimma 0.x.y · Firefox X.Y   (displayVersion, unchanged by a bump; the new Firefox version)
sed -n 's/^Version=//p' engine/obj-x86_64-pc-linux-gnu/dist/bin/application.ini
# → X.Y                         (the new Firefox version: spec m0-app-version)
npm run mochitest -- tests/browser/
```

These are the nightly's own smoke checks. Expect the same pass count as on `main` and zero
failures. Tests marked `skip-if = ["artifact"]` (crash reporter, updater) run only here.
Our patches change upstream behaviour (e.g. `tab-bar-visibility-js.patch`), and so do the
prefs, so a green import alone is not enough: run the whole directory, not a subset.

When a bump fails here, read `tests/browser/browser_vimma_firefox_coverage.js` first: it compares
Firefox's keysets, `ShortcutUtils` and the menu bar with `FIREFOX_SHORTCUTS` in
`packages/vimma-core/src/firefox-keys.mjs`, and each failure names the row to add (with a fate)
or drop. Then run `npm run gen-docs` so `docs/bindings.md` lists the new table.

## 5. Artifact build and the suite on it

PR CI (`e2e.yml`) does this once the PR is ready for review, because the bump changes
`surfer.json`. Run it locally too, next to the full build (≈ 0.6 GB in `engine/obj-artifact`):

```sh
node tools/artifact-build/artifact-build.mjs
# → artifact-build: Mozilla binaries of <rev> (indexed until <date>), objdir engine/obj-artifact
npm run mochitest -- --artifact tests/browser/
```

**Artifact preflight.** The artifact build needs Mozilla's own build of the exact revision in
`engine/sourcestamp.txt`, found in the Taskcluster index. The tool checks it first; to check by
hand:

```sh
rev=$(sed -n 's|.*/rev/||p' engine/sourcestamp.txt)
curl -fsS "https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-release.shippable.revision.$rev.firefox.linux64-opt"
# → { "namespace": "…", "taskId": "…", "expires": "<a year after the build>" }
```

**Decide:** HTTP 404 means Mozilla has no indexed release build of that revision. Check that
`surfer.json` pins a real release (not a candidate, beta or ESR) and that `npm run import` ran on
its tarball. The one exception is Beta mode (the Beta canary, `e2e.yml` with a `N.0bM` version):
the job's own checkout pins the Beta, never committed, and the tool looks the build up in the
`mozilla-beta` index (ADR-010, "Beta tarballs"). A full build does not need the index, but PR CI does: without it, e2e.yml stays red.

## 6. Version files, branding prefs, cfr provider

**Version files.** `npm run import` regenerates them from `surfer.json`
(`tools/version-files`, spec m0-app-version):

```sh
tail -1 src/browser/config/vimma/version.txt          # → X.Y (Firefox)
tail -1 src/browser/config/vimma/version_display.txt  # → 0.x.y (Vimma, unchanged)
```

`browser_vimma_app_version.js` compares against `Services.appinfo.platformVersion`, so a bump
needs no test edit. If it fails, the version files are stale (re-run the import), or Firefox's app
and platform versions have diverged (never so far on release). **Stop and investigate**; do not
edit the test.

**Branding prefs.** Our `firefox-branding.js` replaces upstream's unofficial one, so a pref
upstream adds there is silently dropped, and some break startup (spec m0-branding):

```sh
npx vitest run tools/branding/
# want: "Tests  1 passed (1)"
# fails with the missing pref names; add each to src/browser/branding/vimma/pref/firefox-branding.js
```

It must **pass, not skip**. The test reads upstream's
`engine/browser/branding/unofficial/pref/firefox-branding.js`, and without `engine/` it skips and
vitest still exits 0. A skip prints `branding-prefs: skipped, … is absent (run npm run import
first)` and reports `1 skipped` instead of `1 passed`. Run it after `npm run import`, in the
checkout that has the new `engine/`.

**Upstream pref copies, checked.** `node tools/upstream/upstream-prefs.mjs` (after the import)
compares both copies below with the engine's and prints the line to paste for a stale one; exit
1 then. `e2e.yml` runs it, so the autopilot's suites and PR CI catch a stale copy. The details:

**cfr provider (spec m0-mozilla-services).** We carry a full copy of upstream's
`browser.newtabpage.activity-stream.asrouter.providers.cfr` with `"enabled":false`. A stale copy
shadows upstream's provider. Compare:

```sh
node -e '
const fs = require("fs");
const re = /^pref\("browser\.newtabpage\.activity-stream\.asrouter\.providers\.cfr", (".*")\);$/m;
const cfr = (f) => JSON.parse(JSON.parse(re.exec(fs.readFileSync(f, "utf8"))[1]));
const want = { ...cfr("engine/browser/app/profile/firefox.js"), enabled: false };
const ours = cfr("src/browser/branding/vimma/pref/firefox-branding.js");
const same = JSON.stringify(ours) === JSON.stringify(want);
console.log(same ? "cfr provider: up to date" : `cfr provider: refresh to ${JSON.stringify(want)}`);
process.exit(same ? 0 : 1);'
```

If it says "refresh", put the printed JSON into our pref line, escaped as in the existing one. That
line stays one line, under `// prettier-ignore`. If the regexp finds nothing (a `TypeError`),
upstream renamed or removed the provider: read `firefox.js` and the spec before changing anything.

**Safe Browsing lists (spec m0-safebrowsing-key).** Our branding prefs override
`browser.safebrowsing.provider.google4.lists` and `…google5.lists` with upstream's value from
`engine/modules/libpref/init/all.js` minus `goog-badbinurl-proto` and `goog-downloadwhite-proto`
(Mozilla-key only; one refused list fails every update). Re-derive both from the new `all.js`,
then run `tools/safebrowsing-smoke/safebrowsing-smoke.sh` on the keyed full build: phishing,
malware and unwanted lists must arrive.

## 7. Split-view contract: the canary (M4)

`tests/browser/browser_vimma_split_contract.js` (M4 sub-spec 1, ADR-013) pins the upstream
split-view behaviour we rely on without a patch (spec m4-split-panes, Contract). It always uses
wrappers of three and four tabs, never only two. It covers an L shape of three and a 2×2 grid of
four placed at vimma-core's `layout()` rectangles, focus and the URL bar following the pane, the
find bar and notifications per pane, zoom, and `removeTab` on a member of a three-tab split. Run
it first on both builds, before the rest of the suite:

```sh
npm run mochitest -- tests/browser/browser_vimma_split_contract.js
npm run mochitest -- --artifact tests/browser/browser_vimma_split_contract.js
```

**Decide:** if it fails, Firefox changed its split view (renames, a two-tab limit, panel
reordering). Do not loosen the test or wrap upstream code at runtime. Hold the bump, and follow
the spec's risk table: the named contingency patch, with an ADR-003 register line, or a design
change.

## 8. Ready, CI, merge

For an autopilot PR that came out green, the autopilot already did steps 3, 5 and the prefs part
of 6 on the new release (its run is linked from the PR); the nightly does step 4 after the merge.
For a draft you fixed by hand, tick the rest:

- [ ] patch-check: every patch `clean`/`offset` on the new tree; re-exported patches committed
- [ ] `npm run import` completes
- [ ] full build: `--version` and `application.ini` as above; `npm run mochitest -- tests/browser/`
      green (paste counts in the PR, as the PR template asks)
- [ ] artifact build: preflight OK; `npm run mochitest -- --artifact tests/browser/` green
- [ ] `npx vitest run tools/branding/` green; `node tools/upstream/upstream-prefs.mjs` up to date
- [ ] split-view contract green on both builds

Then `gh pr ready <n>`, which starts `ci.yml` and `e2e.yml`. Merge when green. The nightly
re-downloads Firefox because `surfer.json` changed, and builds it at 03:00 UTC. release-please
then lists `upstream: firefox X.Y.Z` under Changed in the next release PR (the `upstream` type is
listed; `chore` would be hidden, which is why the autopilot does not use it).

## Security dot release: the fast path

Target: **merged within 3 days** of Mozilla's release, enforced by the drift check
(docs/security.md, G2; ADR-015). A dot release (`X.Y.Z`, e.g. 157.0.2) is a few backported
fixes; our front-end patches nearly always stay `clean`. Mozilla's advisories:
<https://www.mozilla.org/security/advisories/>.

| When         | What happens                                                                   |
| ------------ | ------------------------------------------------------------------------------ |
| 0–4 h        | `detect` sees it; tracking issue labelled `security` mentions you              |
| + ≈ 25 min   | Patch check, suites on the artifact build, PR (or a draft naming the conflict) |
| day 0–1      | You: mark ready (or review), CI green, merge                                   |
| day 1–2      | Merge the release-please PR (a dot release alone produces one), `release.yml`  |
| day 3, 00:00 | Not merged yet: `upstream.yml` fails every run, `security` drift issue opened  |

If the PR is a draft, steps 2–7 as usual, but there is no need to wait for a nightly: the local
full-build suite is the same test. Releases skipped in between need nothing extra: the autopilot
bumps straight to the latest and closes the older PR and issue as superseded; the drift check
still counts from the oldest unshipped security release. Auto-merge of `security` bumps (plan §4)
is deliberately not built; a person merges.

## Rolling back

- **Before merge:** keep the PR as a draft while you hold the bump. Its branch existing is what
  stops `upstream.yml` from redoing the release every 4 h; closing the PR without deleting the
  branch keeps it quiet too. The drift check still fails after the deadline: holding a security
  release is a decision to write down in the drift issue.
- **After merge, before a release:** revert on `main` through a PR (`git revert <merge commit>`,
  `revert:` with a body saying why). That restores `surfer.json` and any re-exported patches. The
  nightly builds the old version by itself: every build downloads and verifies the version
  `surfer.json` names (`tools/upstream/firefox-source.sh`).
  Locally: `npx surfer download --force && npm run verify-source && npm run import && npx surfer
build`. The release's
  branch still exists, so the autopilot does not reopen it; delete the branch (or run with
  `-f rebuild=true`) once the cause is fixed.
- **After a release:** do not ship an older Firefox (it reintroduces the fixed security bugs). Fix
  forward with a patch release. To pull a bad release: `gh release edit vX.Y.Z --draft` (runbook,
  Release packages).

## Patch-size audit (plan §4, Sunday maintenance)

```sh
python3 tools/upstream/patch-audit.py      # --json FILE for machines
```

```text
Patch                                                                      Files  Hunks  +  -  Chars  Register
src/browser/base/content/browser-xhtml.patch                                   1      1  1  0    651  yes
…
Total: 11 patches, 13 hunks, +49 -15
Register matches src/ (11 patches).
```

Exit 1 means a patch is not in the ADR-003 register, a register line has no patch, a patch is
over its budget (the register's Hunks and Lines columns, lines being added plus removed), or a
line has no budget or Reviewed date (all are listed). `npm run test:py` runs the same check on
every push. Review: a patch that grew (more hunks or lines than last month, or `large`, Surfer's
8,000-character warning) is a candidate for moving code into our own files (ADR-003). Propose
that in a spec, not in a bump PR. Raising a budget is a change to the register table, with the
reason in its Why cell.

**Quarterly** (`.github/workflows/patch-audit.yml`, security rule G8): on the first day of
January, April, July and October, and on manual dispatch, the audit runs and opens an issue
"Patch audit YYYY-Qn" labelled `upstream` and `audit` with the Markdown report (`--markdown`):
every patch with used / budget, its review date and age, and the reviews over 92 days old
(`--max-age-days`; due reviews are listed but do not fail the audit). Work through it: review
each patch, set its Reviewed date in the register (even when nothing changed), and close the
issue in the same PR. A failing audit also fails the run. Locally, the same report:

```sh
python3 tools/upstream/patch-audit.py --markdown /dev/stdout --today 2027-01-01
```

## Reference: measurements (Firefox 157.0.1, 2026-10-09)

- Source tarball 811,383,348 bytes; 4.2 GB unpacked stream. Full `xz` decompress: 20.8 s on one
  thread, 10.0 s on two (16-thread dev box).
- `patch-check.py --tarball` on it: 25–31 s locally, no disk beyond the 6 patched files.
- `patch-check.py` on `engine/` at HEAD: 0.15 s. All 6 patches `clean` on 157.0.1.
- `surfer download` 12.5 min; cold full build 38.7 min; artifact-build job 5.5 min on a hosted
  runner (runbook, ADR-010).
