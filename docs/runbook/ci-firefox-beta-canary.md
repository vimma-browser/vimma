### Firefox Beta canary (`upstream-beta.yml`)

What it does and what its issue means: [docs/rebase.md](../rebase.md), "Before the release: the Beta
canary". Spec [upstream-beta-canary](../specs/upstream-beta-canary.md); ADR-002 as amended.

Schedule: `41 */6 * * *`. `detect` reads product-details' `LATEST_FIREFOX_DEVEL_VERSION` and
does nothing unless it is a Beta (`N.0bM`) of an unreleased Firefox, or when `main` tested that
Beta build in the last 7 days (an artifact `upstream-beta-<version>` of a run on `main`). Then
`source-check` (`tools/upstream/source-check.sh`, as `upstream.yml`), `test` (`e2e.yml` in Beta
mode with `fail-on-findings: false`), `render` (`tools/upstream/canary.mjs render`, uploads
`upstream-beta-<version>` for 30 days: `issue.json`, `state.json`, the patch check and the suite
results) and, on `main` only, `report`, which opens, updates or closes `Firefox N beta: canary
findings` (label `upstream-beta`) and closes the issues of released versions.

Permissions: nothing by default; `detect` reads contents and Actions artifacts; `source-check`,
`test` and `render` read contents; only `report` writes, and only issues, with no checkout. No
secrets. A red run means the canary is broken, not that it found something: findings go to the
issue.

By hand:

```sh
gh workflow run upstream-beta.yml                   # the current Beta, if not tested in 7 days
gh workflow run upstream-beta.yml -f version=159.0b2  # always tests that Beta
gh workflow run upstream-beta.yml --ref <branch> -f version=159.0b2  # a branch: no issue written
gh run download <run-id> -n upstream-beta-159.0b2   # issue.json, state.json, the reports
```

A manual run on a branch skips `report`, and its artifact does not count as `main`'s tested
build, so it never delays the scheduled run. To check a run: its summary shows the rendered issue
and the comment; the artifact holds the same in `issue.json`.
