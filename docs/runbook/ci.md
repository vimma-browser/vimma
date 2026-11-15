## CI and automation (spec m0-pipeline)

| Workflow                   | Trigger                                            | Runner                    | Needs from you                             |
| -------------------------- | -------------------------------------------------- | ------------------------- | ------------------------------------------ |
| `ci.yml`                   | push to `main` (once per tree), PRs, manual        | `ubuntu-latest` + macOS   | nothing                                    |
| `e2e.yml`                  | PRs, manual, upstream.yml                          | `ubuntu-24.04`            | nothing (ADR-010)                          |
| `nightly.yml`              | in the night when `main` changed, manual           | `ubuntu-24.04`            | nothing (`NIGHTLY_ENABLED` is set)         |
| `upstream.yml`             | every 4 h (`:17`), manual                          | `ubuntu-latest` + e2e.yml | allow Actions to open PRs; optional token  |
| `claude.yml`               | `@claude`, `spec`+`claude:go`                      | `ubuntu-latest`           | a secret, two labels, Actions may open PRs |
| `release-please.yml`       | push to `main`, manual                             | `ubuntu-latest`           | Actions may open PRs; optional token       |
| `release.yml`              | release published, manual                          | `ubuntu-24.04`            | see "Release packages" (gated off)         |
| `homebrew.yml`             | release published, `macos-tap`, manual (`main`)    | `ubuntu-24.04`            | see "Release packages" (gated off)         |
| `pkgbuild.yml`             | `tools/package/` on PRs and `main` (once per tree) | `ubuntu-24.04` + macOS    | nothing (Arch Linux in docker; brew)       |
| `mutation.yml`             | Sundays 04:23 UTC, manual                          | `ubuntu-latest`           | nothing (creates its `mutation` label)     |
| `semgrep.yml`              | push to `main` (once per tree), PRs, Mon, manual   | `ubuntu-latest`           | nothing                                    |
| `codeql.yml`               | push to `main`, PRs, Mon, manual                   | `ubuntu-latest`           | nothing; skipped while the repo is private |
| `dependabot-automerge.yml` | Dependabot's PRs                                   | `ubuntu-latest`           | nothing (Dependabot, below)                |
| `site-dispatch.yml`        | `docs/bindings.json` on `main`, release published  | `ubuntu-latest`           | an app's key, main only (vimma.dev, below) |
| `spec-status.yml`          | daily, issue closed, specs, manual                 | `ubuntu-latest`           | nothing (creates its `spec-status` label)  |
| `downloads.yml`            | daily, manual                                      | `ubuntu-latest`           | nothing (the `stats` branch, below)        |

Locally, before pushing: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:py`,
`npm run license-check`, `npx surfer license-check`, `npx commitlint --from main`.
Workflow YAML: `go run github.com/rhysd/actionlint/cmd/actionlint@latest` (reads
`.github/actionlint.yaml`; not a repo dependency).
