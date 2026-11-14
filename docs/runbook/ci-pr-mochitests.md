### PR mochitests (`e2e.yml`, ADR-010)

PRs run `tests/browser/` on an **artifact build**: our front end built on Mozilla's compiled
binaries for the release in `surfer.json`, on a GitHub-hosted runner. No runner, secret or
variable to set up. Same thing locally, next to the full build (≈ 0.6 GB, `engine/obj-artifact`):

```sh
npm run import
node tools/artifact-build/artifact-build.mjs     # ~25 s warm; first run downloads 163 MB
npm run mochitest -- --artifact tests/browser/
```

It runs on every PR except a docs-only one (above). Before the Firefox download it builds `vimma-ctl` and
runs the e2e harness's tests; after the mochitests, `npm run e2e -- --artifact`. For a PR opened
with `GITHUB_TOKEN`, mark it ready for review or `gh workflow run e2e.yml --ref <branch>`.

What it does not cover: compiled-in build config (C++ defines such as `--version`'s display
version and `MOZ_APP_NAME`, `--disable-crashreporter`; ADR-010 "Known gaps"). Tests of that carry
`skip-if = ["artifact"]` in `tests/browser/browser.toml`. **Until the nightly runner is live they
run only locally**, so a PR touching `*.patch`, `configs/`, `moz.configure` or branding must
report plain `npm run mochitest -- tests/browser/` on the full build (PR template checkbox).

The tool checks Mozilla's index first and prints how long the release build stays indexed. If it
fails, the message names the revision from `engine/sourcestamp.txt` and the expiry: check that
`surfer.json` points at a real release. It also refuses a display version ending in `aN`/`bN`
or containing `esr`, which would make mach search the wrong tree.

Fork PRs run the same job with a read-only token and no secrets; GitHub asks you to approve
every run from an external contributor (Settings → Actions → General; the approval policy is
`all_external_contributors`).
