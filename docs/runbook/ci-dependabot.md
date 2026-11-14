### Dependabot

`.github/dependabot.yml`: npm (`/`), cargo and rust-toolchain (`tools/vimma-ctl`) and GitHub
Actions, Mondays 06:00 Helsinki, releases at least 3 days old, minor and patch grouped into one
PR per ecosystem, majors one PR each. Actions stay pinned to commit SHAs. Security updates
(Dependabot alerts) open at once. `dependabot-automerge.yml` enables GitHub auto-merge (squash)
for security, patch and minor updates, so GitHub merges them once every required check is
green; majors, every GitHub Actions update (workflows hold write tokens and the model API secret)
and every change to a release-path package (Surfer, `ajv` and everything they depend on,
`node tools/deps/release-path.ts`), security updates included, get a comment and stay open
for review. The workflow's `classify` job decides from the lockfile diff and puts each changed
package's `npm diff` in its summary and the `release-path-diff` artifact (30 days); the comment
links the run. If `classify` fails, the PR is held as well: re-run the workflow, or review it
as a release-path change. A re-run reuses the event's base commit, so a PR whose base predates
`tools/deps/release-path.ts` (opened before #989, or reopened later) fails again: comment
`@dependabot rebase` on it, which sends a new event on the current `main`, or review it. Surfer and `ajv` have their own `release-path` group, so a held
update does not hold the other minor and patch updates. No repository setting is needed:
`classify` is not a required check, because it runs only on Dependabot's PRs and the
`automerge` job reads its result directly.
`.npmrc` sets `ignore-scripts=true`: no install runs a package's install scripts. Policy in
CONTRIBUTING.md, "Dependency updates". Needs: Dependabot alerts and security updates on
(Settings → Code security), and "Allow auto-merge" on (it is).

A merge by auto-merge is pushed with `GITHUB_TOKEN`, which starts no workflow on `main`: the
push runs of CI, Semgrep and release-please wait for the next ordinary push to `main`.
