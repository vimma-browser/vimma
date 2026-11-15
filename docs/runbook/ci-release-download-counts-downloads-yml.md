### Release download counts (`downloads.yml`, issue #647)

GitHub keeps one running `download_count` per release asset and no history, so a jump in a count
cannot be told apart from our own automation fetching an asset (a package check, a mirror, a
test). `downloads.yml` records every asset's count once a day, so the history shows when counts
jump and whether the jumps line up with workflow runs.

- **Where the data lives:** `downloads.csv` on the `stats` branch, an orphan branch that holds
  only that file and a short README. It shares no history with `main`, never enters a release,
  and the `main` ruleset does not cover it, so the ruleset stays as it is. Each run adds one
  commit there: one row per asset, `date,tag,asset,downloads` (the date is the UTC day of the
  run). Drafts are left out.
- **How it runs:** at 06:17 UTC and by hand (`gh workflow run downloads.yml`). A row is dated by
  the UTC day the run starts, and scheduled runs here start about three hours late, so the
  schedule sits early in the day: a late-evening one lands on the next day on most nights but
  not all, recording one day twice (the second run is skipped) and the next not at all. The `collect` job
  has `contents: read` only: it fetches the history from the public branch, takes the snapshot
  with `tools/stats/downloads.ts` and appends it unless that day is already recorded. The
  `record` job has `contents: write`, checks out only the `stats` branch, runs no repository
  code, refuses a file that does not begin with the recorded history, and pushes. No secret. A
  push by the job token starts no workflow. Both jobs take well under a minute.
- **Reading it:**

  ```sh
  git fetch origin stats && git show origin/stats:downloads.csv > /tmp/downloads.csv
  node tools/stats/downloads.ts summary --csv /tmp/downloads.csv            # per release, per day
  node tools/stats/downloads.ts summary --csv /tmp/downloads.csv --assets   # and per asset
  ```

  Each line has the total and the change since that release's (or asset's) previous snapshot;
  the run's job summary shows the same table. To match a jump against our automation, list that
  day's runs: `gh run list --created <date> --limit 100`.

- **Where it can push:** the `record` job's token has `contents: write` on the whole
  repository: it could write any branch and create, move or delete any tag, so the limits are
  elsewhere. Both jobs refuse a run off `main` or outside this repository, so a manual run from
  a branch with an unchanged workflow never runs that branch's `tools/stats` with the token;
  the job pushes only the fixed refspec `HEAD:stats` from a checkout of `stats`, and it runs no
  repository code that could change that. These hold for an unchanged copy of the file only:
  anyone with write access can run a changed copy from their own ref (or a workflow of their
  own) and get a `contents: write` token, as with any branch they push (docs/security/18-release-download-counts-workflow.md,
  section 18). A push to `main` is refused anyway: the `main` ruleset requires a pull request
  and has no bypass actor, so the job token cannot update it. Tags have no ruleset. The `stats`
  branch itself is not protected; to keep its history from being deleted or rewritten by
  anyone with write access, add a ruleset for it
  with the deletion and non-fast-forward rules (the job only ever fast-forwards):

  ```sh
  gh api -X POST repos/vimma-browser/vimma/rulesets --input - <<'JSON'
  {"name": "stats", "target": "branch", "enforcement": "active",
   "conditions": {"ref_name": {"include": ["refs/heads/stats"], "exclude": []}},
   "rules": [{"type": "deletion"}, {"type": "non_fast_forward"}]}
  JSON
  ```

  Do not add a pull request or status check rule there: the job pushes directly.

- **Recreating the branch** (only if it is ever deleted): an orphan branch whose `downloads.csv`
  is the header line `date,tag,asset,downloads`. Until it exists, the run fails at the fetch
  rather than starting a history that could replace the old one.
- **Traffic (views, clones, referrers) is not recorded.** GitHub keeps those for 14 days only,
  but its traffic API (`/traffic/views`, `/traffic/clones`, `/traffic/popular/referrers`)
  needs the Administration (read) repository permission (GitHub's "Permissions required for
  fine-grained personal access tokens"), and `permissions:` has no `administration` key, so the
  job token cannot be given it. Recording them needs a fine-grained token or a GitHub App with that
  permission, stored as a secret: a decision for the maintainer, since it would be the
  workflow's first secret.
