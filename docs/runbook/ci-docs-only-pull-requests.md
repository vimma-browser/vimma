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
the MPL header check, and `mochitest (artifact build)` with the e2e scenarios (below). cargo
runs only when the change touches `docs/guide.md`, which vimma-ctl's tests read (below).

CodeQL is not skipped, although Markdown cannot change its findings: the ruleset's code
scanning rule blocks a merge until CodeQL has uploaded results for the pull request, whatever
its required checks report. With the analysis skipped, a docs-only pull request had every
required check green and still showed `mergeStateStatus` `BLOCKED`, and the only check missing
next to a code pull request was the `CodeQL` results check. The analysis takes about 2.5
minutes (Rust), so it sets how long a docs-only pull request waits.

A skipped job or step reports success, so the required checks pass. If the classifier fails,
the gated jobs run (`!cancelled()`, not `success()`). Adding a Vitest file that reads a
Markdown file of the repo through `new URL("../…/x.md", import.meta.url)` means adding it to
`MARKDOWN_TESTS`; `tools/ci/test/docs-only.test.ts` fails until then. The same test pins the
`if:` wiring of each required job.

**Pull requests the browser jobs skip.** The mochitest jobs of `e2e.yml` (the artifact build, the mochitests, the e2e scenarios, the
site snapshot gate and the agent bench, about 30 minutes, plus the two macOS shards) are the
slowest checks, and most tooling and workflow changes cannot reach them. The same classifier
answers a second question, `browser-tests`, with `needsBrowser`; the job `changes` passes it on,
and both mochitest jobs skip with `if:` when it is `false`. The required check
`mochitest (artifact build)` then reports success in seconds.

Browser tests are skipped when the event is `pull_request` and every changed path is one of:

- prose Markdown, as for docs-only above;
- a workflow other than `e2e.yml` (`.github/workflows/*.yml`);
- a file or folder named in `BROWSER_SKIP`: GitHub's templates and settings under `.github/`,
  the lint, format, commit and mutation configs at the root, `types/`, and the `tools/` folders
  that no job of `e2e.yml` runs (lint, spec, release, security, licence, CI guards and the like);
- a Vitest file under `tools/` (`*.test.ts`, `*.test.mjs` and so on), except under
  `tools/e2e/` and `tools/branding/`, whose tests `e2e.yml` runs.

`BROWSER_SKIP` is an allowlist on purpose: a path it does not name, a new folder or a new
top-level file included, runs the browser jobs. So does everything they read: `src/`,
`packages/`, `tests/`, `configs/`, `surfer.json`, `package.json` and its lockfile, `.nvmrc`,
`.npmrc`, `vitest.config.ts`, `e2e.yml` itself, and the tools that build, launch or drive the
browser (`tools/import`, `tools/sync-core.ts`, `tools/version-files`, `tools/artifact-build`,
`tools/mochitest.ts`, `tools/e2e`, `tools/sites`, `tools/agent-bench`, `tools/branding`,
`tools/upstream`, `tools/vimma-ctl`, `tools/lanes`, `tools/build.ts`, `tools/start.ts`, and the
modules these import, such as `tools/update`, `tools/package` and `tools/test`). A test in
`tools/ci/test/docs-only.test.ts` walks every tracked script that is not skipped and fails when
one imports a file that is, so a skipped folder cannot quietly become one the browser jobs load.

`tools/ci/` is skipped because the workflows run the classifier from the base branch: a change
to it judges the next pull request, never its own, and its tests run in the check job.

The macOS mochitest job also runs the whole Vitest suite (`npm test`) on macOS. It is
informational, and skipping it with the mochitests means a change to a tool's tests alone is
tested on Linux only; the Linux check job runs the full suite on every pull request.

**vimma-ctl's cargo steps.** The cargo steps of the check job (toolchain, fmt, clippy, tests, the crates' licences) and the
`vimma-ctl on macOS` job run when the classifier's `rust` answer (`needsRust`) is not `false`. They
skip when every changed path is one the browser jobs skip, or under `src/`, `tests/browser/`,
`tests/e2e/` or `tools/e2e/`, or `e2e.yml`: vimma-ctl reads none of these. They run for any other
path, and always for the inputs of vimma-ctl that the browser jobs skip (`RUST_INPUTS`):
`docs/guide.md`, which `tests/guide_snippets.rs` reads, `ci.yml`, and `tools/license-check/`.
`surfer.json`, `tests/contract/` and `packages/vimma-core/src/`, which vimma-ctl also reads, are
not skipped at all.

Each gate compares with `!= 'false'`, so an empty output runs the job or step: any event but
`pull_request`, a classifier that failed, and a base branch whose classifier predates the
answer.

The gen-docs freshness step runs on every pull request: `npm run gen-docs`, then `git diff
--exit-code` on `docs/bindings.md`, `docs/bindings.json` and `packages/vimma-core/defaults.toml`.
A hand edit of a generated file fails there with the command to run.
