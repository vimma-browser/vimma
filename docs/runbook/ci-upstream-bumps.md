### Upstream bumps (`upstream.yml`, the upstream autopilot)

**What it does and what you do with its PR: [docs/rebase.md](../rebase.md)**, section 1 (the
playbook also covers patch failures, builds, the security fast path and rollback). Spec
[m7-upstream-autopilot](../specs/m7-upstream-autopilot.md), ADR-015.

In short: every 4 h `detect` (read-only, < 1 min, no secrets) reads product-details and the MFSA
index. For a newer Firefox it opens a tracking issue labelled `upstream` (+ `security` with the
advisory and severity, mentioning you), streams and SHA-512-verifies the source tarball, dry-runs
our patches, runs `e2e.yml` on the new version (import, artifact build, `tests/browser/`,
`tests/e2e/`), pushes `upstream/firefox-X.Y.Z` and opens the PR
`upstream: firefox X.Y.Z (MFSA YYYY-N)`, with the advisories that name the release, if any (a
later run updates the title when one appears). Each release is handled once (its branch
exists); `gh workflow run upstream.yml -f rebuild=true` redoes it. If `main` is more than 3
days behind a security dot release (7 for a major, 14 otherwise), the `drift` job opens a
`security` issue and the run fails until the bump is merged.

Permissions: the workflow grants nothing by default; `detect` reads contents and issues, `track`
and `drift` write issues, `patch-check` and `test` read contents only, and only `publish` can
push and open PRs. No job uses `pull_request_target`, and none gets `SAFEBROWSING_API_KEY`: the
artifact build is keyless by design; the key is only for the nightly and release builds.

One-time setup:

1. **Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create
   and approve pull requests".** Until then `gh pr create` fails with "GitHub Actions is not
   permitted to create or approve pull requests"; the autopilot detects that message, keeps the
   pushed branch, and comments the full summary and a prefilled compare link on the tracking
   issue instead (open the PR from there). The same setting serves release-please and claude.yml.
2. **Upstream App.** Without it a PR opened with the default `GITHUB_TOKEN` starts no
   workflows, so the autopilot opens it as a draft (mark it ready for review to start `ci.yml`
   and `e2e.yml`) and never sets auto-merge. The org's GitHub App `vimma-upstream-autopilot` has
   repository permissions **Contents**, **Pull requests** and **Issues: Read and write** (Metadata:
   read is added automatically), nothing else, **no Workflows** and no webhook, and is installed
   on vimma only. The variable `UPSTREAM_APP_ID` holds its client ID and the secret
   `UPSTREAM_APP_KEY`, of the `upstream-autopilot` environment (deployable only from `main`), its
   private key; each run mints a one-hour token, so nothing expires (docs/security/10-firefox-updates.md, G14).
   `node tools/upstream/create-app.mjs` creates the environment (and stops if it already allows
   another ref), then the App from a manifest, the variable and the secret: open the local
   address it prints, confirm on GitHub, then install the App on **Only select repositories →
   vimma** from the link it prints (GitHub has no API for that step). To rotate the key, generate a new one on the App's page,
   `gh secret set UPSTREAM_APP_KEY --env upstream-autopilot -R vimma-browser/vimma < new-key.pem`,
   then delete the old key there. Because `publish` deploys to that environment, it runs only
   from `main`.
3. **Auto-merge** (spec upstream-bump-automation, ADR-022): `gh variable set
AUTO_MERGE_UPSTREAM -b all -R vimma-browser/vimma` lets GitHub merge a bump whose patches
   applied clean, whose suites passed and whose diff is only the version and copied prefs, once
   every check on it is green, not only the required ones (the PR's "Auto-merge" row says why
   when it is not allowed). `upstream-merge.yml` runs each time a workflow on the PR finishes
   and sets auto-merge after the last one; its run summary names what it still waits for or
   what failed. A red or unapproved run (a macOS mochitest flake, for one) leaves the bump for a
   person: re-run the failed job, and when it turns green the merge is set as usual. `dot`
   limits it to dot releases. To stop: `gh variable delete AUTO_MERGE_UPSTREAM`, and
   `gh pr merge <N> --disable-auto` on a PR already set. Repository auto-merge must stay allowed
   (Settings → General → Allow auto-merge).

When patches do not apply, the `patch-issue` job opens (or, on a rerun, updates) one issue per
Firefox version titled `Firefox X.Y.Z: patches do not apply`, labelled `upstream` and `triage`,
with the failing patches and hunks and links to the bump PR and the run. Assign it to a person
or to GitHub Copilot coding agent; rebase the patches on the bump branch (docs/rebase.md, step
3). Such a bump stays a draft and never merges itself. Close the issue when the bump merges.

Every bump: the copies of `browser.newtabpage.activity-stream.asrouter.providers.cfr` and
`browser.safebrowsing.provider.google{4,5}.lists` in
`src/browser/branding/vimma/pref/firefox-branding.js` must match the new engine's (specs
m0-mozilla-services, m0-safebrowsing-key). `tools/upstream/upstream-prefs.mjs` checks both in
`e2e.yml` and prints the line to paste; the autopilot's bump PR already carries refreshed lines
and lists them, so check only that the old and new values in its "Refreshed prefs" look right. A
pref gone upstream leaves the PR a draft that names it. Before a release, run
`tools/safebrowsing-smoke/safebrowsing-smoke.sh` on a keyed full build. Patch-size review
(quarterly, `patch-audit.yml`): `python3 tools/upstream/patch-audit.py`.
