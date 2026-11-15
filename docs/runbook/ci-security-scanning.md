### Security scanning (`semgrep.yml`, `codeql.yml`)

**Semgrep CE** runs on every PR, on pushes to `main` whose tree no pull request run scanned ("Once per tree" above) and on Mondays. It scans the repo with the public
registry rulesets `p/javascript`, `p/typescript`, `p/rust`, `p/secrets` and `p/github-actions`,
from the `semgrep/semgrep` image pinned by digest (bump the digest and the version comment
together). It does not log in to semgrep.dev and uploads nothing: `--metrics=off`, no token.
Skipped paths are in `.semgrepignore`: the engine checkout, build output, vendored code and the
generated copy of vimma-core. The job fails only on ERROR findings; WARNING and INFO findings are
listed in the step summary. Fix a finding, or suppress it on its line with
`// nosemgrep: <rule-id> -- <reason>`. A suppression without a reason is not allowed.

Reading the results: the run's **Summary** lists every finding as `SEVERITY path:line rule`. For
the details, download the `semgrep-sarif` artifact (kept for 30 days) with
`gh run download <run-id> -n semgrep-sarif`. Then open `semgrep.sarif` in VS Code's SARIF Viewer,
or list it with
`jq -r '.runs[].results[] | "\(.level) \(.locations[0].physicalLocation.artifactLocation.uri):\(.locations[0].physicalLocation.region.startLine) \(.ruleId)"' semgrep.sarif`.
Locally:
`docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -w /src <image> semgrep scan --metrics=off --config=p/javascript ... --json-output=semgrep.json`,
using the image and flags from `semgrep.yml`.

Licences: the engine is LGPL-2.1. It runs as a separate tool and is not linked into or shipped
with Vimma. The registry rules are under the Semgrep Rules License v1.0, which allows use for
internal purposes but not redistributing the rules or offering them as a service. We only run
them in our own CI.

**CodeQL** (`javascript-typescript` and `rust`, `build-mode: none`, `security-extended`, config in
`.github/codeql/codeql-config.yml`) is gated with `if: github.event.repository.private == false`,
so on a private repository (a private fork) the run shows it as skipped. This is for two
reasons. Code scanning on a private repo needs a paid GitHub Code Security licence. The CodeQL
CLI licence also allows CI analysis only of an open source codebase, and it names a private repo
as not one. This repository is public, so the job runs; its alerts appear under Security → Code
scanning.
