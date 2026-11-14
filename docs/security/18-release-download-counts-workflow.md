## 18. Release download counts workflow (`downloads.yml`, `tools/stats`)

Runbook: "Release download counts". Once a day a hosted runner reads every published release
asset's `download_count` and appends it to `downloads.csv` on the `stats` branch, an orphan
branch outside `main`'s history. It is the only workflow whose own job token pushes commits, so
these rules keep that token away from `main` and from code. Who can reach it: anyone with write
access, who can change the workflow or `tools/stats` on a branch of their own; the data it reads
(asset names and counts of our own releases) comes from GitHub's API. It runs on `schedule` and
`workflow_dispatch` only, never on a pull request or a push. A manual run can name any branch,
so both jobs **refuse** to run unless the run is in this repository and on `main`: a manual run
from another branch whose copy of the workflow is unchanged refuses, so that branch's
`tools/stats` never runs with the write token. The guard lives in each branch's own copy of the
file, so it binds only an unchanged copy. **⚠ limit:**
anyone with write access can run a changed workflow from their own ref (`gh workflow run
--ref`, or a workflow of their own `on: push`) and get a `contents: write` job token. That token
can write any branch but `main`, which its ruleset refuses, and create, move or delete any tag.
This is the same reach as pushing a branch (B11, B15, UP7), and nothing in this file can narrow
it: the mitigations sit outside it, as rulesets for tags and for `stats`, or a GitHub App or
deploy key that may write `stats` alone in place of the job token.
[`runs once a day and by hand, never on a pull request or a push`](../../tools/test/downloads-workflow.test.ts),
[`both jobs run only in this repository from main; record only after collect succeeded`](../../tools/test/downloads-workflow.test.ts)

- DC1. The workflow holds **no** secret: only the job token, with nothing granted at the top
  level. The `collect` job, which runs repository code, holds **only** `contents: read` and does
  not keep its checkout's credentials. Traffic (views, clones, referrers) is therefore not
  recorded: its API needs the Administration permission, which a job token cannot be given, and
  recording it would mean the workflow's first stored secret. Before the script, `collect` sets up
  `.nvmrc`'s Node with `actions/setup-node`, pinned by commit SHA, with no cache and
  `package-manager-cache: false` (otherwise a `packageManager` field naming npm in `package.json`
  would turn on caching by itself), so the script never runs on the runner image's own Node,
  whose version this repository does not choose (ADR-025); the action runs with the same
  read-only token.
  [`grants nothing by default; reads in collect, writes contents only in record`](../../tools/test/downloads-workflow.test.ts),
  [`every job sets up Node before it runs node, npm or npx, but the listed ones`](../../tools/test/runner-node.test.ts),
  [`a setup-node before a guard or a token-holding tool never caches by itself`](../../tools/test/runner-node.test.ts),
  [`collect runs the script without a stored credential`](../../tools/test/downloads-workflow.test.ts),
  [`stays tiny: no npm install, short timeouts, no secret, runs in order`](../../tools/test/downloads-workflow.test.ts)
- DC2. `contents: write` is **only** in the `record` job, which checks out the `stats` branch,
  runs no repository code (no `node`, no `npm`), and pushes **only** the fixed refspec
  `HEAD:stats`: the workflow has one `git push`. The token itself could write any branch and
  create, move or delete any tag, so in this workflow those limits rest on the job's code, and
  on a changed copy of the workflow they do not hold at all (the limit above). `main` rests on
  its ruleset: it requires a pull request and has no bypass actor, so a push by the job token is
  refused. Tags and the `stats` branch have no ruleset unless the
  maintainer adds one (runbook, "Where it can push").
  [`record runs no repository code and pushes only to the stats branch`](../../tools/test/downloads-workflow.test.ts)
- DC3. The history is **append-only**: `record` refuses a new `downloads.csv` that does not begin
  byte for byte with the one on `stats`, and runs only after `collect` succeeded, from that run's
  own artifact. A failed fetch of the history fails the run rather than starting a new one.
  [`record only appends: the new file must begin with the recorded history`](../../tools/test/downloads-workflow.test.ts)
- DC4. Every action is pinned by a full commit SHA.
  [`every action it uses is pinned by a full commit SHA`](../../tools/test/downloads-workflow.test.ts)
