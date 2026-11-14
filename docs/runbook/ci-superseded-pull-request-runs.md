### Superseded pull request runs

A new push to a pull request makes the checks still running on its previous head worthless, so
every workflow with a `pull_request` trigger sets a workflow-level `concurrency` group keyed on
`github.ref` (`refs/pull/<n>/merge`) or the pull request number, and cancels the older run of
that group. Only pull request runs are cancelled: a workflow that also runs on a push to `main`,
a schedule, a manual run or `workflow_call` sets `cancel-in-progress: ${{ github.event_name ==
'pull_request' }}`, so none of those runs is cut short once it runs (GitHub still keeps only
the newest queued run of a group). In a called workflow `github.event_name`
is the caller's event, so the upstream autopilot's and the Beta canary's calls of `e2e.yml` are
never cancelled while they run. `tools/test/workflow-concurrency.test.mjs` holds every workflow with a
`pull_request` trigger to this, and keeps concurrency groups distinct across workflows.
`dependabot-automerge.yml` is the one exception: its runs take seconds and act on the pull
request's merge state, so they keep their order.

A cancelled run does not hold a merge back. Required checks belong to a commit: the cancelled
run reported on the previous head, and the run of the newest head reports every required check
for it.
