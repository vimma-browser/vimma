### Docs-only pull requests (issue #245)

A pull request whose every changed file is prose Markdown skips the work Markdown cannot affect.
`tools/ci/docs-only.mjs` decides from `git diff --name-only --no-renames base...head` (never the
title or body); ci.yml and e2e.yml run it as the base branch has it, so a pull
request cannot change the classifier that judges it. It runs on the runner image's own Node, and
only the checkout comes before it: no step runs anything in the pull request's checkout first,
not even `actions/setup-node`, whose version checks start the package managers there, and those
read their configuration from the checkout (docs/security/14-build-and-release-supply-chain.md, B18). That is why it stays `.mjs`
(ADR-025, decision 7). Started through a symlinked path the classifier does nothing and exits 0,
which runs everything; the runners' `$RUNNER_TEMP` is a real path.

**Docs-only** means all of these hold:

- the event is `pull_request` (a schedule, a manual run and `workflow_call` always run
  everything; so does a push to `main`, unless "Once per tree" below skips it);
- every changed path ends in `.md`;
- none is generated (`GENERATED_MARKDOWN`: `docs/bindings.md`);
- none is under `.github/`, `packages/`, `src/`, `tests/` or `tools/`, where Markdown can be a
  fixture, a vendored file pinned by hash or a template GitHub reads.

A workflow, a script, `package.json` or any other file in the same pull request runs everything.

Still runs on a docs-only pull request: prettier, commitlint, `npm run md-wording`,
`npm run security-links`,
`npm run test:py` (it reads ADR-003), the gen-docs freshness step, the Vitest files listed in
`MARKDOWN_TESTS`, Semgrep and CodeQL.

Skipped: eslint, `npm run comment-wording`, typecheck, the full Vitest suite with coverage, the bench, the licence checks,
cargo, the MPL header check, and `mochitest (artifact build)` with the e2e scenarios (the job
`changes` gates the job).

CodeQL is not skipped, although Markdown cannot change its findings: the ruleset's code
scanning rule blocks a merge until CodeQL has uploaded results for the pull request, whatever
its required checks report. With the analysis skipped, a docs-only pull request had every
required check green and still showed `mergeStateStatus` `BLOCKED`, and the only check missing
next to a code pull request was the `CodeQL` results check. The analysis takes about 2.5
minutes (Rust), so it sets how long a docs-only pull request waits.

A skipped job or step reports success, so the required checks pass. If the classifier fails,
the gated jobs run (`!cancelled()`, not `success()`). Adding a Vitest file that reads a
Markdown file of the repo through `new URL("../…/x.md", import.meta.url)` means adding it to
`MARKDOWN_TESTS`; `tools/ci/test/docs-only.test.mjs` fails until then. The same test pins the
`if:` wiring of each required job.

The gen-docs freshness step runs on every pull request: `npm run gen-docs`, then `git diff
--exit-code` on `docs/bindings.md`, `docs/bindings.json` and `packages/vimma-core/defaults.toml`.
A hand edit of a generated file fails there with the command to run.
