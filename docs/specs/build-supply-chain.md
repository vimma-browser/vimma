# Spec: build-supply-chain

Status: implemented · Area: `package.json`, `package-lock.json`, `.npmrc` (new),
`.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`,
`.github/workflows/release.yml`, `.github/workflows/nightly.yml`, `.github/workflows/e2e.yml`,
`.github/workflows/sites.yml`, `.github/workflows/upstream.yml`,
`tools/upstream/verify-sha512.py`, `tools/upstream/source-check.sh`,
`tools/upstream/firefox-source.sh` (new), `tools/upstream/verify-source.sh` (new),
`tools/upstream/mozilla-release-key.asc` (new),
`tools/upstream/mozilla-key-check.py` (new), `tools/deps/release-path.mjs` (new),
`docs/security.md`, `docs/runbook.md`, `docs/rebase.md`, `docs/review-checklist.md`,
`CONTRIBUTING.md` · Upstream patches:
none · ADR: ADR-021 (new, "Mozilla's release key is the trust anchor for the Firefox source");
[ADR-001](../adr/001-engine-firefox-surfer.md) gains one paragraph on how Surfer is pinned

## Summary

Vimma's binaries are built from three inputs: Mozilla's Firefox source tarball, Vimma's own
repository, and the npm packages that drive the build, chiefly Surfer. This spec closes the gaps
between those inputs and the binaries `release.yml` and `nightly.yml` will publish. The Firefox
source is accepted only when its hash is listed in a `SHA512SUMS` signed by Mozilla's release
key; every build extracts and verifies its own source tree and reuses nothing an earlier job
left; Surfer and every other package that runs in the release build are pinned exactly, reviewed
by a person on every change, and installed without install scripts. The full builds move from a
self-hosted machine that was never set up to GitHub-hosted runners, and a test keeps every
workflow that outsiders can trigger off self-hosted runners.

## Problem

`release.yml` and `nightly.yml` target a self-hosted runner (`[self-hosted, linux, x64,
vimma-build]`) that does not exist: no runner is registered, and both workflows are switched off
because the repository variables `RELEASE_ENABLED` and `NIGHTLY_ENABLED` are unset (GitHub API,
read 2026-10-14). No full build therefore runs in CI at all; the checks that only a full build
can make (ADR-010, "Known gaps") run only on contributors' machines. When the builds are turned
on, what they produce is packaged, signed with cosign and given an SBOM by GitHub-hosted jobs, but
those jobs sign whatever the build job produced: a signature proves that `release.yml` at the
release tag published the file, not that the file was built from Mozilla's source and Vimma's
code alone. Once security releases ship with no person in the loop
([firefox-versions](firefox-versions.md); ADR-020, planned with its sub-PR 4), nothing but the build pipeline stands between
a tampered input and every user. Today:

1. **The release and nightly builds do not verify the Firefox source.** `release.yml` (lines
   82–89) and `nightly.yml` (lines 44–52) run `npx surfer download --force` and nothing else.
   Surfer checks no hash (Research, R3). Only `e2e.yml`, `sites.yml` and
   `tools/upstream/source-check.sh` (run by `upstream.yml` and the Beta canary,
   `upstream-beta.yml`) compare the tarball with Mozilla's `SHA512SUMS`, and none of them checks
   the signature on `SHA512SUMS`: `tools/upstream/verify-sha512.py`'s docstring and
   `docs/rebase.md` ("We do not check the GPG signature on `SHA512SUMS`: HTTPS from
   archive.mozilla.org is the trust anchor") say so.
2. **A cached engine is trusted by its label.** Both workflows check out with `clean: false` and
   skip the download when `engine/.vimma-firefox-version` matches `surfer.json`, a design for a
   persistent machine. Anything that changed a file under `engine/` or `.surfer/` between runs
   would be built into the next nightly and release. Surfer itself reuses
   `.surfer/engine/firefox-<version>.source.tar.xz` whenever that file exists (R3).
3. **Surfer is a floating, auto-mergeable dependency of the build.** `package.json` has
   `"@zen-browser/surfer": "^1.14.9"`. `dependabot-automerge.yml` holds back Surfer's own
   version updates, but auto-merges a security update to Surfer and any version or security
   update to one of the packages Surfer runs (`axios`, `sharp`, `execa` and the rest of its
   closure, R5). Both build workflows then run `npm ci` with install scripts enabled. This gap
   is live today: Dependabot pull requests run and auto-merge now, whether or not any build runs.
4. **`npx surfer` can install a different package.** When `node_modules/.bin/surfer` is missing,
   `npx` installs the package named on the command line, and in CI it does so without asking
   (R4). The npm package `surfer` is an unrelated 2022 package by another publisher.
5. **The Safe Browsing key is reachable from any branch, and nothing keeps pull request code off
   a self-hosted runner.** The key is a repository secret that any workflow file on any pushed
   branch can read; only `if:` conditions inside the workflow files keep it in the two build
   jobs. No test stops a future workflow that a pull request triggers from running on a
   self-hosted runner, which on a public repository would let anyone run code on that machine
   (R7).

## Behaviour

The change is to CI; its observable behaviour is what the workflows accept, refuse and run.

1. **The Firefox source is verified before use.** A nightly or release build must fail,
   before `engine/` is created, when the source tarball's SHA-512 is not the one listed for it in
   that version's `SHA512SUMS`, or when `SHA512SUMS.asc` is not a good signature by a valid
   signing subkey of Mozilla's release key `14F26682D0916CDD81E37B6D61B7B526D98F0353`. A
   signature by a revoked or expired subkey, by another key, or no signature at all, fails.
2. **Every build verifies.** `e2e.yml`, `sites.yml`, `upstream.yml`, the Beta canary,
   `nightly.yml` and `release.yml` all obtain Firefox source through the same two scripts, so the
   same check (behaviour 1) applies to every one of them. No workflow calls `surfer download`
   directly.
3. **No build reuses a source tree or a cached tarball unverified.** The nightly and the release
   build delete `engine/` and extract it again, in the same job, from the tarball that job
   verified. A tarball that is already present is verified like a downloaded one.
   `engine/.vimma-firefox-version` is no longer written or read.
4. **Builds carry nothing over from earlier jobs.** The nightly and the release build check out
   with the default `clean: true`, install a fresh `node_modules`, and restore nothing from the
   Actions cache: no `engine/`, `.surfer/`, objdir, npm cache or compiler cache. The release
   also builds in a fresh objdir with an empty compiler cache.
5. **Surfer is pinned exactly.** `package.json` names one Surfer version, with no range, and
   `package-lock.json` pins it and every package it depends on by integrity hash.
6. **No release-path package merges without a person.** A Dependabot pull request that
   changes Surfer, `ajv`, or any package either of them depends on, by a version update or a
   security update, is never set to auto-merge. Its CI shows the diff between the published
   packages of the old and the new version.
7. **No install scripts.** No `npm ci` or `npm install` in the repository runs package
   install scripts; `release.yml` and `nightly.yml` also pass `--ignore-scripts` explicitly.
   They run Surfer only from `node_modules` and fail if it is missing.
8. **Nothing outsiders can trigger runs on a self-hosted runner.** No job of a workflow that a
   pull request, a comment, an issue or another workflow run can trigger names a self-hosted
   runner. The nightly and the release build run on GitHub-hosted runners.
9. **The Safe Browsing key is confined.** The key is an environment secret of the `build`
   environment, which only `main` may use. Only the two build jobs name that
   environment.
10. **Mozilla's key changes are noticed.** When Mozilla's published key has a subkey or a
    revocation that Vimma's pinned copy lacks, or the pinned signing subkey expires within 60
    days, `upstream.yml` opens an issue labelled `security`.
11. **Surfer fetches nothing unverified.** `surfer.json` lists no add-ons, so
    `surfer download` never fetches an add-on from addons.mozilla.org or GitHub, which it would
    do with no hash check.
12. **A build that cannot fit fails early.** The full-build jobs check free disk space before
    downloading the source and fail with the measured requirement in the message, rather than
    running out of space hours into the build.

## Research

**R1. Mozilla's release signing key.** Mozilla's security blog, "Updated GPG key for signing
Firefox and Thunderbird Releases" (2026-08-10,
`https://blog.mozilla.org/security/2026/08/10/updated-gpg-key-for-signing-firefox-and-thunderbird-releases/`),
gives the primary key fingerprint `14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526 D98F 0353` and a new
signing subkey `827E 6586 0867 9618 CD34 9F93 678E 455D 7676 7AA3`, expiring 2028-08-05. The
previous subkey was revoked after an unencrypted copy of it was committed to a private GitHub
repository; the key signs Linux tarballs, RPM packages and checksum files. The blog names two
places to obtain the key: the `KEY` file of the latest Nightly
(`https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/`) and
keys.openpgp.org. Checked with GnuPG 2.4.9 on 2026-10-14, importing
`https://archive.mozilla.org/pub/firefox/releases/158.0/KEY` (31,916 bytes):

- Primary `rsa4096/61B7B526D98F0353`, created 2015-07-17, uid
  `Mozilla Software Releases <release@mozilla.com>`, fingerprint as above.
- Eight signing subkeys: six expired (2015 to 2023 generations);
  `09BEED63F3462A2DFFAB3B875ECB6497C1A20256` (created 2025-03-13), revoked on 2026-08-06 with
  reason code 2, "Key has been compromised", comment "We no longer trust this key."; and
  `827E658608679618CD349F93678E455D76767AA3` (created 2026-08-06, expires 2028-08-05).
- The `KEY` files of 156.0, 157.0.1 and 158.0 are byte-identical.

**R2. `SHA512SUMS.asc` and what `gpgv` reports.** Each release directory has `SHA512SUMS` and a
detached signature `SHA512SUMS.asc` beside it (158.0: 630,944 and 833 bytes); the source tarball
also has its own `.asc`. Verified with `gpgv` (GnuPG 2.4.9) against a keyring exported from R1:

| Release | Signed     | Subkey             | `gpgv` exit | Status lines                       |
| ------- | ---------- | ------------------ | ----------- | ---------------------------------- |
| 158.0   | 2026-10-08 | `827E…7AA3`        | 0           | `GOODSIG`, `VALIDSIG`              |
| 157.0.1 | 2026-10-05 | `827E…7AA3`        | 0           | `GOODSIG`, `VALIDSIG`              |
| 156.0   | 2026-09-10 | `827E…7AA3`        | 0           | `GOODSIG`, `VALIDSIG`              |
| 159.0b1 | (Beta)     | `827E…7AA3`        | 0           | `GOODSIG`, `VALIDSIG`              |
| 153.0   | 2026-07-16 | `09BE…0256` (rev.) | **0**       | `REVKEYSIG`, `VALIDSIG`, no `GOOD` |

The last row is the important one: for a signature by the revoked, compromised subkey, both
`gpgv` and `gpg --verify` print "Good signature" and exit 0. Only the machine-readable status
(`--status-fd`) tells the cases apart: `REVKEYSIG` instead of `GOODSIG`. A verifier that trusts
the exit status would accept a `SHA512SUMS` signed with the compromised subkey. `gpgv` does not
read ASCII-armoured keyrings ("Can't check signature: No public key" with Mozilla's armoured
`KEY` file, still exit 0), so the keyring it is given must be binary.

**R3. Surfer's download.** In Surfer 1.14.9 (`node_modules/@zen-browser/surfer/dist/`):
`downloadFirefoxSource` (`commands/download/firefox.js:88-114`) returns early with "Using cached
download" when `.surfer/engine/firefox-<version>.source.tar.xz` exists, and otherwise downloads
it; nothing in the command reads `SHA512SUMS` or a signature. `downloadInternals`
(`firefox.js:115-155`) deletes `engine/` only with `--force`, extracts only when `engine/` is
absent, and then downloads every add-on in `surfer.json` from addons.mozilla.org or the GitHub
API (`commands/download/addon.js:30,41`), again with no hash check. Vimma's `surfer.json` has
`"addons": {}`. Unpacking runs `tar --strip-components=1 -xf`; without `CI_SKIP_INIT` Surfer then
makes `engine/` a git repository and commits the whole tree (`firefox.js:30-32`), which accounts
for most of the 12.5 minutes `docs/runbook.md` records for `surfer download`; with
`CI_SKIP_INIT=1` the e2e job's download and unpack took 56 s on a standard hosted runner (R9).

**R4. npm behaviour (npm 10.9.4, Node 22.21.0).** From npm's documentation for v10:

- `npm ci`: "If a `node_modules` is already present, it will be automatically removed before
  `npm ci` begins its install." So both build jobs already get a fresh `node_modules`.
- `--ignore-scripts` / `ignore-scripts`: "If true, npm does not run scripts specified in
  package.json files." Scripts run by name (`npm run x`) still run; their `pre`/`post` scripts do
  not. `package.json` has no `pre*` or `post*` scripts.
- `npm exec` (`npx`): packages not in the local project are installed into the npm cache, and
  "When standard input is not a TTY or a CI environment is detected, `--yes` is assumed."
  `--no` refuses instead. `npm view surfer` on 2026-10-14: version 0.0.2, maintainer
  `fractal`, last modified 2022-06-27.

**R5. What runs in the release build job, and whether it needs install scripts.** From
`package-lock.json` at `main` (7fc0226; the lockfile is unchanged since 30bf67e):

- The build job runs `tools/package/package.mjs`, `tools/sync-core.mjs`,
  `tools/version-files/version-files.mjs`, `tools/import/restore-patched.mjs` and
  `tools/package/sbom.mjs` (Node built-ins only), `tools/package/validate-sbom.mjs` (imports
  `ajv`), and Surfer (`download`, `config brand`, `import`, `build`).
- **Surfer 1.14.9** has 22 direct dependencies: `@resvg/resvg-js` 1.4.0, `async-icns` 1.0.2,
  `axios` 1.20.0, `chalk` 4.1.2, `cli-progress` 3.12.0, `commander` 6.2.1, `execa` 5.1.1,
  `fast-extract` 1.14.11, `fs-extra` 10.1.0, `ini` 3.0.1, `is-apple-silicon` 1.0.1, `kleur`
  4.1.5, `modern-async` 1.1.5, `mount-dmg` 1.0.1, `picomatch` 2.3.2, `png-to-ico` 2.1.8,
  `prompts` 2.4.2, `rustic` 1.2.2, `semver` 7.8.5, `sharp` 0.35.5 (forced by the root
  `overrides`), `tiny-glob` 0.2.9, `xmlbuilder2` 4.0.3. Its closure is 175 packages without
  optional dependencies and 215 with them; 184 are installed on linux-x64.
- **`ajv` 8.20.0** adds `fast-deep-equal`, `fast-uri`, `json-schema-traverse` and
  `require-from-string`.
- Of all 510 installed packages, two declare install scripts: `core-js-pure` 3.50.0 (in Surfer's
  closure through `modern-async`; its `postinstall` prints a funding banner) and `fsevents` 2.3.3
  (macOS only, optional; it ships a prebuilt `fsevents.node`, so its `node-gyp rebuild` is not
  needed). The native code Surfer uses, `sharp` (libvips) and `@resvg/resvg-js`, arrives as
  prebuilt platform packages selected by `os` and `cpu`, not built by a script.
- Experiment: `npm ci --ignore-scripts` of the repository's `package.json` and lockfile
  installed the same 510 packages and the same `.node` binaries as an install with scripts;
  `sharp` resized a PNG rendered by `@resvg/resvg-js`, the operation Surfer's branding step
  performs (`commands/patches/branding-patch.js:88-91`), and `surfer --version` ran. With
  `ignore-scripts=true` in `.npmrc`, `npm run <script>` still ran the script.
- `is-apple-silicon` resolves to `git+ssh://git@github.com/trickypr/is-apple-silicon.git#5f75501…`,
  pinned by commit but without an `integrity` hash, and has no scripts. Nothing in Surfer's
  `dist/` requires it.

Conclusion: no package in the release path needs an install script.

**R6. Surfer's published package.** `@zen-browser/surfer` 1.14.9 (published 2026-08-31) is 80
files, 246 KB of `tsc` output, with one maintainer on npm, an npm registry signature and no
provenance attestation (`npm view … dist`), so the published tarball cannot be tied to a commit
of `github.com/zen-browser/surfer` by anything but trust in the publisher.
`npm diff --diff=@zen-browser/surfer@1.14.8 --diff=@zen-browser/surfer@1.14.9` printed 34 lines
touching three files (`dist/utils/version.js`, `package.json`, `dist/tsconfig.tsbuildinfo`): a
diff of the published package is small and is exactly the code that runs.

**R7. GitHub settings.** Read through the REST API on 2026-10-14 and GitHub's documentation:

- Fork pull request workflow approval is `all_external_contributors`
  (`GET /repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`): a workflow run
  for a pull request from any outside contributor's fork waits until a person with write access
  approves it. This is the current setting; it is not something this spec has to change.
- No self-hosted runner is registered (`GET /repos/vimma-browser/vimma/actions/runners`:
  `total_count` 0), and no repository variables are set, so `RELEASE_ENABLED` and
  `NIGHTLY_ENABLED` are unset and neither build runs.
- The repository is owned by the organisation `vimma-browser`, on GitHub's Free plan
  (`GET /orgs/vimma-browser`: `"plan": {"name": "free"}`, read 2026-10-15). Larger runners
  (R11) need the Team plan.
- GitHub's guidance on self-hosted runners: "Self-hosted runners should almost never be used for
  public repositories on GitHub, because any user can open pull requests against the repository
  and compromise the environment".
- No environments exist; `SAFEBROWSING_API_KEY` is the only repository secret. "Secrets stored in
  an environment are only available to workflow jobs that reference the environment", and
  environments are available to public repositories on every plan; an environment's deployment
  policy limits it to named branches and tags.
- `sha_pinning_required` is `false`; every workflow already pins actions by commit SHA.
- A job summary is limited to 1 MiB per step.
- Ubuntu 24.04's `apt` depends on `gpgv` (packages.ubuntu.com, noble, apt 2.7.14build2), so every
  Ubuntu runner has it.

**R8. Time cost of verifying and re-extracting.** Measured on the reference machine in
`docs/runbook.md` (16 threads, NVMe) with the cached 157.0.1 tarball (811,383,348 bytes):
`sha512sum` 1.2 s (the hash matched line 821 of `SHA512SUMS`), `gpgv` under 0.1 s,
`tar --strip-components=1 -xf` into an empty directory 17.5 s (4.7 GB), deleting that tree 5.1 s.

**R9. The standard GitHub-hosted Linux runner.** GitHub's documentation, read 2026-10-14:

- "GitHub-hosted runners" (`docs.github.com/en/actions/reference/runners/github-hosted-runners`):
  the standard Linux x64 runner for public repositories has 4 CPUs, 16 GB RAM and 14 GB SSD.
  Standard runners are free and unlimited for public repositories.
- "Actions limits" (`docs.github.com/en/actions/reference/limits`): "Each job in a workflow can
  run for up to 6 hours of execution time" on GitHub-hosted runners (5 days on self-hosted ones).
  Cache storage is 10 GB per repository.

The documented 14 GB is far below what the runner provides in practice. Measured from the `df`
line the `e2e.yml` disk guard prints, in six successful runs on 2026-10-14 (newest: run
38554004304, image `ubuntu-24.04` version 20261004.327.1, provisioner 20261002.596, `make -j4`
confirming 4 CPUs): `/dev/root` 145 GB, 60–61 GB used, **85 GB free** before the Firefox source
is downloaded. On 2026-10-09, while the repository was private, the same job ran on the 2-CPU
runner with a 72 GB root file system and about 13 GB free before the download (spec
[m0-build-strategy](m0-build-strategy.md), the comment above `e2e.yml`'s disk guards). The free
space is a property of the current image, not a documented guarantee.

**R10. What a full Firefox build needs.** Mozilla's "Building Firefox On Linux"
(`firefox-source-docs.mozilla.org/setup/linux_build.html`, read 2026-10-14): "4GB RAM minimum,
8GB+ recommended" and "At least 30GB of free disk space"; it gives no build time. Vimma's own
measurements with Firefox 157.0.1 and `configs/linux/mozconfig` (`--enable-release`,
`--enable-optimize`, `--with-ccache=sccache`):

| Item                                      | Size or time                                   |
| ----------------------------------------- | ---------------------------------------------- |
| Source tarball                            | 0.8 GB (`docs/rebase.md`)                      |
| Unpacked tree, no `.git` (`CI_SKIP_INIT`) | 4.7 GB (spec m0-build-strategy)                |
| Objdir, `engine/obj-x86_64-pc-linux-gnu`  | 20 GB (`du`, 2026-10-14)                       |
| `~/.mozbuild` after bootstrap and builds  | 4.4 GB, `clang` 1.3 GB of it (`du`)            |
| Cold full build                           | 38.7 min wall, CPU 75 %, 16 threads, 58 GB RAM |

So one build needs about 30 GB of disk, matching Mozilla's figure. The cold build used about
38.7 × 16 × 0.75 ≈ 464 thread-minutes. On 4 CPUs that is at least 116 minutes if the build kept
all four busy at the reference machine's per-thread speed; the real figure on a hosted runner is
**not measured**. The compiler cache a single cold build produces was not measured either (the
reference machine's `~/.cache/sccache` is 11 GB, but it holds several builds).

**R11. Larger hosted runners and third-party runners.** GitHub's "Actions runner pricing"
(`docs.github.com/en/billing/reference/actions-runner-pricing`, read 2026-10-14): "Larger
runners are only available for organizations and enterprises using the GitHub Team or GitHub
Enterprise Cloud plans" and "are not free for public repositories". Linux x64 per-minute prices:
4-core $0.012, 8-core $0.022, 16-core $0.042, 32-core $0.082. "Larger runners"
(`docs.github.com/en/actions/reference/runners/larger-runners`): 8-core has 32 GB RAM and 300 GB
SSD, 16-core 64 GB and 600 GB. How other Firefox forks build Linux, from their workflow files (read
2026-10-15):

| Fork        | Where the Linux build runs                                                                                                                                                                     | Source                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Zen Browser | a self-hosted machine for x86_64 releases, `blacksmith-8vcpu-ubuntu-2404` (a third-party runner service) otherwise, after `jlumbroso/free-disk-space`; sccache in the Actions cache when asked | `zen-browser/desktop`, `.github/workflows/linux-release-build.yml` at dceca78                                    |
| Floorp      | GitHub's standard `ubuntu-latest`, `timeout-minutes: 360`, a swap file of up to 30 GB, `mach build --jobs` at three quarters of the CPUs, sccache in the Actions cache                         | `Floorp-Projects/Floorp-Runtime`, `.github/workflows/common-build.yml` and `scripts/allocate-swap.sh` at 7dd6197 |
| Waterfox    | `namespace-profile-legacy-linux-md` (Namespace, a third-party runner service), `timeout-minutes: 120`                                                                                          | `BrowserWorks/Waterfox`, `.github/workflows/build.yml` at 1de140d                                                |
| LibreWolf   | Codeberg's Forgejo Actions on LibreWolf's own runner `epsilon`, in its own container image                                                                                                     | `codeberg.org/librewolf/bsys6`, `.forgejo/workflows/build-release.yml` at 53fbe77                                |

Floorp is the one fork that builds Firefox on GitHub's free runner. Its Linux x86_64 jobs took
112 and 125 minutes for a plain build and 181 and 187 minutes for the two compiling stages of a
profile-guided build (runs 38477641016, 38551492598 and 38639808666, 2026-10-13 and 2026-10-14,
`GET /repos/Floorp-Projects/Floorp-Runtime/actions/runs/<id>/jobs`), with a compiler cache whose
hit rate the logs do not show.

**R12. A compiler cache in the Actions cache.** sccache's GitHub Actions backend
(`github.com/mozilla/sccache`, `docs/GHA.md`, read 2026-10-14) is enabled with
`SCCACHE_GHA_ENABLED=on` and needs the job's `ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN`;
"In case sccache reaches the rate limit of the service, the build will continue, but the storage
might not be performed." GitHub's "Dependency caching" reference: a run "can restore caches
created in either the current branch or the default branch", so a release run for a tag restores
caches written on `main`; caches are evicted when unused for 7 days, and least recently used
first beyond the size limit, which "can cause cache thrashing". The limit is 10 GB free per
repository; since 2025-11-20 a repository owned by a user can raise it, at $0.07 per GiB-month
above 10 GB (GitHub changelog, "GitHub Actions cache size can now exceed 10 GB per
repository"). Every job that runs on `main` with the runtime token can write `main`-scoped cache
entries, so a cache shared with the release is an input the release cannot verify.

**R13. How `mach` fetches its toolchains.** With `--enable-bootstrap` (`configs/common/mozconfig`)
configure resolves each toolchain (clang, Rust, cbindgen, the sysroot and others) to a task in
Mozilla's Taskcluster index (`build/moz.configure/bootstrap.configure:188-225`) and downloads it
with `mach artifact toolchain`, which checks the artifact against the digest in that task's
`public/chain-of-trust.json`, fetched from the same Taskcluster queue over HTTPS
(`python/mozbuild/mozbuild/artifact_commands.py:344-379`). Both files were read in Firefox
157.0.1 and are byte-identical in 158.0. The signature on the chain-of-trust file is not
checked. On a fresh hosted runner every build downloads the toolchains anew.

**R14. `--enable-bootstrap` in a tree with an empty git repository.** The first full build on a
hosted runner (run 38717749386, 2026-10-15, Firefox 158.0) stopped in configure after 18 s:
"Error loading tasks for kind fetch: … `taskcluster/scripts/misc/fetch-onnxruntime-deps.sh` did
not match anything", then "checking for the target C compiler... /usr/bin/clang" and "ERROR:
Cannot find ccache". The file is in the tarball. To find a toolchain, configure loads the
taskgraph, which hashes each toolchain's inputs with `hash_paths`
(`taskcluster/gecko_taskgraph/util/hash.py:23-46`, 158.0); that lists files through
`get_repository_object(...).get_tracked_files_finder()`, and in a git repository that is
`git ls-files` (`python/mozversioncontrol/mozversioncontrol/repo/git.py:278-280`). The empty
repository `e2e.yml` creates with `git init` for `surfer import` tracks nothing, so no toolchain
resolves and configure falls back to the system compiler and finds no `sccache`. Without `.git`,
`get_repository_object` returns `SrcRepository` for any tree with `config/milestone.txt`
(`mozversioncontrol/factory.py:124-127`), whose finder lists every file on disk except what
`.gitignore` excludes (`repo/source.py:119-140`): the source-tarball case Linux distributions
build. The next run removed `engine/.git` after `npm run import` and configure found Mozilla's
toolchains. The artifact build in `e2e.yml` does not compile and is unaffected. A developer's
`engine/`, which Surfer commits in full without `CI_SKIP_INIT`, tracks every file and is
unaffected too.

**R15. A cold full build on the standard runner, measured.** A temporary workflow on a branch
that was never merged (`measure-full-build.yml`, read-only token, no secret, publishes nothing)
ran the nightly's steps on `ubuntu-24.04` (image 20261012.334.1, 4 CPUs, 16 GB of memory) for
Firefox 158.0 and Vimma's `main` at ac9d17f, keyless, with an empty sccache:

- Run 38718105585: killed after 38 minutes of `surfer build` with exit 143 and no further log
  line; the steps marked `if: always()` did not run either. It had no swap beyond the image's
  2 GB, and the next run shows memory full at that point of the build.
- Run 38723067541, the same with a 16 GB swap file: `npm ci`, the source download and extraction
  and `npm run import` 1 minute; `surfer build` 113 minutes; the full mochitest suite 7 minutes
  (78 tests, 6,355 checks, 0 unexpected); `./mach package` 2.4 minutes (87 MB); the whole job
  124 minutes. `vimma --version` printed "Vimma 0.1.0 · Firefox 158.0".
- Memory, sampled each minute: 12.5 GB at minute 20, then 15.3 GB of 16 GB plus 10.4 GB of swap
  between minutes 25 and 35 (the Rust crates), and 2.5 to 5.7 GB for the rest of the build.
- Disk: 86 GB free of 145 GB at the start; 42 GB used by the end, of which the swap file is
  16 GB, `engine/` 21 GB, `~/.mozbuild` 2.5 GB and the sccache directory 2.7 GB.
- sccache: 5,323 compilations, 3 cache hits, as expected for an empty cache.

## Design

### Firefox source

1. **Mozilla's release key, pinned in the repository, is the trust anchor; HTTPS is not.** The
   repository carries `tools/upstream/mozilla-release-key.asc`: the primary key
   `14F26682D0916CDD81E37B6D61B7B526D98F0353` with all its subkeys, binding signatures and
   revocations, exported from Mozilla's `KEY` file (R1) and checked against the fingerprints in
   Mozilla's announcement. `verify-sha512.py` holds the primary fingerprint as a constant. The
   key is stored armoured so a change to it is readable in review; the script de-armours it with
   the Python standard library into a temporary binary keyring for `gpgv` (R2). Reason: a
   signature check moves trust from "archive.mozilla.org and its CDN served these bytes" to
   "Mozilla's release key signed these hashes", which survives a compromised mirror, CDN or TLS
   interception. Rejected: fetching `KEY` at build time (an attacker who can serve a tarball can
   serve an old `KEY` without the revocation of the compromised subkey, R1); a keyserver (adds a
   third party and a network dependency to every build).
2. **The verdict comes from `gpgv`'s status lines, never its exit code.** `verify-sha512.py`
   gains a required `--signature` argument. It runs `gpgv --status-fd` with the pinned keyring
   and accepts only when the status has exactly one `NEWSIG`, one `GOODSIG` and one `VALIDSIG`
   whose primary-key fingerprint field is the pinned fingerprint, and none of `BADSIG`,
   `ERRSIG`, `EXPSIG`, `EXPKEYSIG`, `REVKEYSIG` or `NO_PUBKEY`. Only then does it compare the
   hash. Exit status: 0 match; 1 hash mismatch or a signature that is not good; 2 cannot check
   (no `gpgv`, no `.asc`, unreadable files). Every caller treats any non-zero status as failure.
   Reason: R2 shows `gpgv` exits 0 for a signature by the compromised subkey. Rejected:
   `gpg --verify` (same exit status, and it needs a writable `GNUPGHOME`); Sequoia's `sqv` (not
   installed on Ubuntu runners; `gpgv` is, R7).
3. **Two scripts are the only ways to get Firefox source.**
   - `tools/upstream/source-check.sh VERSION` (spec
     [upstream-beta-canary](upstream-beta-canary.md)) streams the tarball through `sha512sum` and
     `patch-check.py` for `upstream.yml` and the Beta canary (`upstream-beta.yml`). It also
     downloads `SHA512SUMS.asc` and passes it to `verify-sha512.py`.
   - `tools/upstream/firefox-source.sh` (new) materialises a verified `engine/` for builds. It
     reads the version from `surfer.json`, downloads
     `.surfer/engine/firefox-<version>.source.tar.xz` with `curl` when absent, downloads
     `SHA512SUMS` and `SHA512SUMS.asc`, runs `verify-sha512.py` on the tarball, deletes `engine/`
     and only then runs `CI_SKIP_INIT=1 npx --no -- surfer download` (which finds the verified file
     and only extracts it, R3) and `git init -q engine`. `e2e.yml`, `sites.yml`, `nightly.yml` and
     `release.yml` call it. A test fails if any workflow calls `surfer download` itself. The two
     full builds delete `engine/.git` after `npm run import` and before `surfer build`: `surfer
import` needs the empty repository to apply patches inside `engine/`, and `mach` must not
     see it, or `--enable-bootstrap` resolves none of Mozilla's toolchains (R14). Rejected:
     `git add -A` in `engine/` so the repository tracks the tree (minutes of hashing 4.7 GB for
     an index nothing else reads); committing the tree as Surfer does without `CI_SKIP_INIT`
     (most of Surfer's 12.5 minutes, R3).

   Reason: the hash and signature logic exists once, so the release path, PR CI, the autopilot
   and the canary cannot drift apart, as the canary spec already intends for `source-check.sh`.
   `MOZILLA_RELEASES` overrides the archive URL in both scripts so tests can use a `file://`
   directory.

   A contributor's machine keeps `npx surfer download`, and `tools/upstream/verify-source.sh`
   (`npm run verify-source`, sub-PR 2) checks the tarball it left in `.surfer/engine/` with the
   same `verify-sha512.py`. Reason: a local `engine/` needs Surfer's commit of the pristine tree,
   which `surfer export` diffs against and `tools/lanes/lanes.mjs` resets lanes to, and
   `firefox-source.sh` makes an empty repository instead. The check runs after Surfer extracts,
   so it protects the build, not the extraction. It records the verified version and hash in
   `engine/.git/vimma-source-verified` (as `firefox-source.sh` does), and `npm run import` starts
   with `verify-source.sh --require`, which refuses an `engine/` without that record for
   `surfer.json`'s version. Reason: import is the first step of every local build and every
   lane, and the check is offline and instant, so B1 holds on a contributor's machine without
   relying on a setup step being remembered. The record lives in `engine/.git` because Surfer's
   `--force` deletes it with `engine/`, a lane's `git clean` keeps it, and a lane's copy of
   `engine/` carries it. It is a guard against building an unverified download, not against
   someone who can write to `engine/`.

4. **The tarball Vimma verifies is the one Surfer extracts.** Vimma downloads the tarball itself
   and verifies the file at the path Surfer reads (R3), in the same job, immediately before
   Surfer runs. Rejected: letting Surfer download and verifying afterwards (verification would
   then depend on Surfer's cache path never changing, and a failed check would come after
   extraction); verifying a stream and downloading again (two downloads that could differ).
5. **No build reuses `engine/` or trusts a cached tarball; nothing is trusted by label.**
   `firefox-source.sh` always verifies the tarball, whether it downloaded it or found it, then
   deletes `engine/` and re-extracts. `engine/.vimma-firefox-version` goes. The script works the
   same on a fresh hosted runner, a contributor's machine and any persistent machine a later spec
   might add, so the rule does not depend on where a build runs. Re-checking a present tarball
   costs about 1.3 s and extracting it about 18 s on the reference machine, 56 s with the
   download on a hosted runner (R8, R3). Rejected: verifying an existing `engine/` tree (it is
   modified by every import, so there is nothing to compare it with but a copy kept beside it,
   which is no anchor); keeping the `.vimma-firefox-version` shortcut with a hash of the tarball
   (the tarball is not what is built; `engine/` is). Extracting with `CI_SKIP_INIT=1` skips
   Surfer's git commit of the whole tree (R3), which a build does not need: `e2e.yml` already
   builds from an empty `git init`, and `restore-patched.mjs` has nothing to restore in a fresh
   tree.

### Where full builds run

6. **Full builds run on GitHub-hosted runners: the standard `ubuntu-24.04` runner when a cold
   build, the nightly's mochitests and packaging finish in under 4 hours on it; otherwise a
   larger hosted runner, at least for the release.** Measured: 124 minutes for the nightly's
   job (R15), so both builds run on the standard runner, free of charge. Neither build workflow
   names a self-hosted runner.
   - The standard runner comes first because it is free for a public repository and already
     exceeds what the build needs: 16 GB RAM is twice Mozilla's recommendation, and 85 GB of
     free disk is almost three times the build's 30 GB, though only 14 GB is documented (R9,
     R10). Its only open point was time: at least 116 minutes of compiling on 4 CPUs by the
     thread-minute estimate (R10), 113 measured (R15). A release, built with an empty cache,
     takes the full cold time; the nightly runs unattended at 03:00 UTC, so a long build costs
     only latency. Floorp builds on the same runner in similar times (R11).
   - The 4-hour threshold leaves the 1.5× margin of decision 10 inside GitHub's 6-hour job limit
     (R9).
   - Above the threshold, a larger hosted runner is preferred because it keeps the trust boundary
     of decision 20 and needs no machine. A 16-core runner (64 GB RAM, 600 GB SSD) would build in
     roughly the reference machine's 39 minutes, about $1.60 per build at $0.042 per minute
     (estimated from R11's prices, not measured). Only the release, built a few times a month,
     has to move there; the nightly may stay on the standard runner if it fits there. Larger
     runners need the `vimma-browser` organisation on the GitHub Team plan (R7, R11). Not needed
     while R15 holds.
   - Rejected: splitting one build over several jobs to stay under the job limit. The build fits
     one job, and carrying `engine/` or an objdir from job to job would break B2.
   - Rejected: freeing disk by removing the image's preinstalled toolsets, as Zen and Floorp do
     (R11). The build and its swap file use 42 GB of the 86 GB free (R15); removing them costs
     minutes per build. It stays the first fix if the disk guard (decision 9) ever fails.
   - Rejected: a third-party runner service, as Zen Browser uses for non-release builds (R11). It
     is faster and cheaper than a larger hosted runner, but adds a party that runs the build and
     holds the Safe Browsing key, outside the trust boundary of decision 20.
   - Rejected: a self-hosted machine. No build machine exists (R7). It is the fastest per build,
     but it is the only option that needs a machine-specific security design (a persistent
     workspace, a runner identity, a machine that holds the Safe Browsing key between runs) and
     an always-available machine. The self-hosted target is removed from both workflows rather
     than kept switched off, because keeping it would leave `clean: false` and the cached-engine
     shortcut (Problem 2) in place for a machine nobody runs. A self-hosted machine, if one is
     ever wanted, comes with its own spec and its own `docs/security.md` rules; the guard in
     decision 7 stays in force either way.

   The change is inert until `NIGHTLY_ENABLED` or `RELEASE_ENABLED` is set.

7. **Nothing an outsider can trigger runs on a self-hosted runner.** A test
   (`tools/test/self-hosted-runner.test.mjs`) reads every workflow and fails when a job of a
   workflow triggered by `pull_request`, `pull_request_target`, `pull_request_review`,
   `pull_request_review_comment`, `issue_comment`, `issues`, `discussion`,
   `discussion_comment`, `workflow_run` or `workflow_call` has a `runs-on` that names
   `self-hosted`, names a label other than a standard GitHub-hosted image, or is an expression
   the test cannot resolve. `workflow_call` is in the list because a called workflow runs with
   its caller's trigger (`e2e.yml` is called by `upstream.yml` and the Beta canary). An
   expression resolves only when it is `${{ matrix.<key> }}` over a literal list of strings in
   the job's own `strategy.matrix`, which is not itself an expression and has no `include:`; any
   other expression fails, because its value is not known from the file. A job that calls a
   reusable workflow passes only when the workflow is a file of this repository, which the test
   checks as its own file. The test parses the workflows with a YAML parser (`js-yaml`, already
   in the lockfile through commitlint and Surfer, MIT) rather than matching text, because a
   text match missed quoted job ids, jobs written as flow mappings and matrix keys nested in
   other entries; a duplicate key is a parse error and fails the test. A second test holds
   decision 6: no workflow job, whatever its triggers, targets anything but a standard
   GitHub-hosted image, and both build jobs run on `ubuntu-24.04`. actionlint does not run in
   CI, so its configuration declaring no self-hosted label only keeps a local run consistent. Reason: on a public repository
   a self-hosted runner that pull request code can reach is a machine anyone can run code on
   (R7). The first test is the permanent guard; the second changes only with a spec that adds a
   machine.

   The second test and the move of both build jobs to `ubuntu-24.04` land in sub-PR 1, not with
   the measurement in sub-PR 4, because no self-hosted runner exists or is planned (R7, decision
   6): the self-hosted label was configuration for a machine nobody runs, and removing it at
   once lets the test forbid self-hosted runners in every workflow from the first delivery
   rather than only in those an outsider can trigger. The build jobs stay switched off: the
   nightly's manual dispatch, which `NIGHTLY_ENABLED` did not gate while its job waited for a
   runner that did not exist, now needs `NIGHTLY_ENABLED` as well, because on a hosted runner a
   dispatched nightly would build and publish the rolling release from Firefox source that is
   not yet signature-checked (#222). The move therefore changes nothing that runs; on a fresh hosted runner their `clean: false` and
   `.vimma-firefox-version` shortcut have nothing to reuse, and sub-PR 4 removes them with the
   rest of decision 5. The test covers the workflow files
   on `main`; a fork's pull request runs its own head's workflow files, which is why the
   current fork approval setting (`all_external_contributors`, R7) matters: no outside fork's
   workflow runs before a person approves that run. `docs/security.md` records that setting as
   **⚠ setting** with the `gh api` command that shows it, because no test can read an admin
   setting with the workflow token.

8. **Build jobs restore nothing from the Actions cache, and neither build uses a shared compiler
   cache.**
   `release.yml` and `nightly.yml` check out with the default `clean: true`, set up Node with
   `actions/setup-node` without its `cache` input, use no `actions/cache` step, and do not set
   `SCCACHE_GHA_ENABLED`. On a hosted runner every build therefore starts from a fresh virtual
   machine with an empty local sccache directory. The release keeps its explicit fresh objdir and
   empty `SCCACHE_DIR` (`release.yml` lines 64–72), so the rule holds on any runner. Reason: a
   release run restores caches written on `main` (R12), and any job on `main` with the runtime
   token can write them, so a shared cache is an unverified input; `npm ci` would verify npm's
   cache by integrity, but the release gains nothing from it worth the exception.

   The nightly does not keep sccache in the Actions cache either, while a cold nightly fits its
   runner (decision 6, R15). A shared cache could shorten nightlies that change little, and one
   cold build's cache, 2.7 GB (R15), would fit the 10 GB free per repository beside the npm
   caches the pull request jobs use; but rate limits can drop its writes (R12), and every job on
   `main` can write it, so a nightly built from it is only as trustworthy as every such job. The
   release could not use it in any case. If nightly time becomes the constraint, a later change
   revisits this with a cache key prefix only `nightly.yml` writes and R12's eviction behaviour
   checked against that size.

9. **A disk guard before the download, and a 16 GB swap file.** Both build jobs check free
   space on the workspace's file system and fail when it is under 50 GB, naming the measured
   need (about 26 GB for the build and 16 GB for the swap file, R15). The guard comes before the
   download, so a runner image that shrinks fails in seconds, not after an hour of compiling.
   Reason: the 86 GB free today is not documented (R9). Each job then creates and enables a
   16 GB swap file. Reason: the Rust stage needs about 26 GB of memory and swap together, and
   without the file the build was killed (R15). Rejected: fewer parallel jobs instead of swap
   (as Floorp does both, R11), which lengthens the whole build to spare one stage.
10. **The job time limit follows the measurement.** `timeout-minutes` is about 1.5 times the
    measured job (R15): 190 for the nightly (124 minutes) and 180 for the release (about 117
    minutes, as it runs no mochitests), and never above 345 (15 minutes under GitHub's 6-hour
    limit, R9), so a hung build fails with the job's own log upload and failure issue rather
    than being cancelled by GitHub.
11. **Firefox's toolchains are part of the trusted base, as Mozilla ships them.** Each build
    fetches its toolchains through `--enable-bootstrap` (R13), checked by `mach` against the
    digests in Taskcluster's chain-of-trust files, over HTTPS. This spec adds no check of its own
    to that path: the toolchains come from the same organisation whose release key it trusts, and
    a stronger check would mean verifying Taskcluster's chain-of-trust signatures, which `mach`
    does not do and which would be a project of its own. `docs/security.md` §11 names the
    toolchains as trusted.

### npm packages

12. **Surfer is pinned exactly and stays a dependency; it is not vendored or forked.**
    `package.json` gets `"@zen-browser/surfer": "1.14.9"`. Reason: vendoring Surfer's `dist/`
    into `tools/` would still pull its 175-package closure from npm (R5), so it would remove one
    package from the review set and add a copy to maintain; the review of an update would be the
    same diff (R6). A fork that drops the dependencies Vimma never uses (`sharp`, `axios`,
    `mount-dmg`, `png-to-ico`, …) for the four commands it runs would shrink the closure, but is
    a port of the branding and import code with its own maintenance, and ADR-001 keeps that
    option for when Surfer stalls. With the source fetched and verified by Vimma (decision 3),
    Surfer no longer decides which Firefox bytes are built, only how they are extracted,
    patched and configured. ADR-001's consequences paragraph records this.
13. **The release path is computed, not listed by hand.** `tools/deps/release-path.mjs` reads
    `package-lock.json` and returns the dependency closure (non-optional and optional) of the
    release-path roots, `@zen-browser/surfer` and `ajv` (R5). A test checks the roots against the
    imports of the tools `release.yml`'s build job runs, so adding a package to that job without
    adding it as a root fails CI. Reason: Dependabot's security updates change transitive
    packages, and a hand-kept list of about 220 names would go stale.
14. **Dependabot never auto-merges a release-path change, security updates included.**
    `dependabot-automerge.yml` gets a `classify` job (`contents: read`, no secrets) that checks
    out the pull request's **base** commit, reads the head commit's `package-lock.json` with
    `git show` as data, and runs `release-path.mjs --diff <base lockfile> <head lockfile>`: if any
    package whose version, `resolved` or `integrity` changed is in the release path of either
    lockfile, the decision is `review`. The existing `automerge` job reads that decision; it
    keeps its own rules for majors and GitHub Actions. Reason: classifying by the lockfile
    diff, not by Dependabot's `dependency-names`, also catches a transitive package bumped by a
    grouped update. Base-branch code on head data means nothing from the pull request runs.
    Rejected: auto-merging release-path security updates for speed (Vimma ships no npm package
    code: `vimma-core` has no dependencies and `smol-toml` is vendored, ADR-012, so a
    vulnerability in a build tool is not in users' hands, while a malicious release is
    typically published as a routine update; a person's review is worth the days).
15. **The review shows the published code.** The same `classify` job runs
    `npm diff --diff=<name>@<old> --diff=<name>@<new>` for each changed release-path package and
    writes the result to the job summary, cut at 1 MiB with a pointer to the full diff in an
    artifact (`release-path-diff`, 30 days). `npm diff` downloads both tarballs and executes no
    package code. The comment the `automerge` job already posts on held pull requests links the
    run. Reason: Surfer has no provenance (R6), so the published tarball is the only artifact
    whose contents are certain to be what runs; for Surfer that diff is small.
16. **Dependabot groups the release path separately.** `.github/dependabot.yml` gets a
    `release-path` group (patterns `@zen-browser/surfer`, `ajv`) before `npm-minor-patch`, so a
    held Surfer update does not hold every other minor and patch update with it.
17. **No install scripts anywhere; Surfer only from `node_modules`.** A new `.npmrc` sets
    `ignore-scripts=true`, which covers every workflow, lane and developer machine. `release.yml`
    and `nightly.yml` also run `npm ci --ignore-scripts`, so the build does not depend on a file
    a future change could drop, and every Surfer call in them is `npx --no -- surfer …` (R4).
    Every other `npx` in the workflows also runs with `--no --`. The `--` is needed because,
    once `--no` comes first, npm 10.9.4 reads every later flag as its own: `npx --no surfer
download --force` gave `--force` to npm, and `npx --no commitlint --from A --to B --verbose`
    ran commitlint without its arguments (checked locally and in CI).
    Reason: R5 shows nothing needs a script, and an install script is the usual way a
    compromised package runs code. Rejected: `npm audit signatures` in the build (the lockfile's
    `integrity` hashes already pin the exact bytes, so a registry signature adds no check the
    install does not already make).

### Secrets and settings

18. **The Safe Browsing key moves to an environment.** A `build` environment holds
    `SAFEBROWSING_API_KEY`, with deployment allowed only from `main`, because both build jobs run
    only from `main` and a `v*` tag rule would let anyone who can push a tag deploy an edited
    workflow from it (a tag ruleset restricts updating tags, not creating them). The
    `build` jobs of `nightly.yml` and `release.yml` declare `environment: build`; the repository
    secret is deleted. Reason: today a branch's edited `nightly.yml` can drop the `if:` that keeps
    the key on `main`; an environment policy is enforced by GitHub, outside any workflow file. This
    holds on hosted runners as much as on any other: the question is which workflow runs may read
    the secret, not which machine runs them. The nightly keeps the key because its binaries are
    what people run (as a workflow artifact until the release gate, decision 23) and its
    mochitests assert the key is compiled in (`VIMMA_EXPECT_SAFEBROWSING_KEY`). The key ships
    inside every keyed binary (spec m0-safebrowsing-key), so this limits who can use it from CI,
    not who can read it.
19. **Action SHA pinning becomes a repository setting too.** Every workflow already pins actions
    by commit SHA and tests enforce it for several workflows; setting `sha_pinning_required` makes
    GitHub refuse an unpinned action in any workflow, a fork's included. A runbook step.

### What a signature attests

20. **The trust boundary.** Trusted: GitHub's hosted runner image and the Actions service,
    Mozilla's release key and Mozilla's toolchains (decision 11). Everything else that reaches a
    build is verified or pinned: Firefox source (decision 1), Vimma's code (the release tag or
    `main`, written only through pull requests under the `main` ruleset), npm packages (lockfile
    integrity, decisions 12–17), actions (commit SHAs). What the build produces is checked by
    hosted jobs (smoke tests, package checks) and then signed. A cosign signature therefore
    attests "built by `release.yml` at this tag on a GitHub-hosted runner from these verified
    inputs", and `docs/security.md` says exactly that. Making the binaries independently
    reproducible is out of scope.

### Mozilla key rotation

21. **Key changes are reviewed, and noticed early.** The pinned keyring changes only through a
    pull request a person reviews. `tools/upstream/mozilla-key-check.py`, run by `upstream.yml`'s
    `detect` job (which runs every 4 hours), downloads
    `nightly/latest-mozilla-central/KEY` (the location Mozilla names, R1), compares it with the
    pinned key and reports: a new subkey or a new revocation (an issue, labelled `security`,
    "Mozilla's release key changed", with the fingerprints and the steps from `docs/runbook.md`),
    a different primary key (the same issue, saying the pinned fingerprint and ADR-021 must be
    reviewed, never updated by the check), or the pinned signing subkey expiring within 60 days.
    It never edits the keyring. Reason: Mozilla rotates the signing subkey every two years and, as
    in August 2026, at once after an incident; a build that cannot verify fails closed (rule B1),
    so the warning should come before the first failure. A new subkey is accepted by `gpgv` only
    with a binding signature from the pinned primary, so the update is a review of Mozilla's
    announcement, not of the cryptography.

### The release gate

22. **Nothing here publishes anything.** Vimma publishes no release or nightly before its release
    gate, and `RELEASE_ENABLED` and `NIGHTLY_ENABLED` stay unset until then. Every sub-PR is
    therefore safe to merge with the builds switched off: the source verification and package
    rules protect PR CI and the autopilot at once, and the build workflows are correct before they
    first run. The measurement build in sub-PR 4 publishes nothing and reads no secret. Its
    result selects the runner under decision 6, and that runner is in place before the gate.
    Decision 23 lets `NIGHTLY_ENABLED` be set before the gate, because a nightly no longer
    publishes a release.
23. **A nightly is a workflow artifact, not a release, until the release gate.** The `build` job
    of `nightly.yml` uploads its package as the run's `vimma-nightly` artifact, kept 7 days, and
    holds only `contents: read`. No job creates, replaces or deletes a release, and none can
    write contents; the failure issue is a separate `report` job with `issues: write`, which
    checks out and runs nothing from the repository and reads no secret. Reasons: a release on
    the repository's release page is a public download that people find, install and keep, which
    the release gate rules out for unreviewed daily builds, while the maintainer still needs the
    full-build check and a binary to try. A workflow artifact gives both without a release page
    or a stable link, and expires on its own. Publishing is removed rather than kept behind a
    repository variable: flipping a variable would publish keyed binaries with no review of the
    workflow that does it, and the release gate is a decision for a reviewed change, which also
    drops every `contents: write` token from the workflow until then. Splitting off the failure
    issue keeps the remaining write token away from the job that runs npm, Surfer, `mach` and
    the mochitests. Limit: the artifact is not private. On a public repository GitHub lets
    anyone signed in download a run's artifacts for as long as they are kept (checked
    2026-10-15: the run page's download link answers 404 without a session, the REST download
    endpoint 401 without a token, and the artifact list, with names and sizes, is public), so a
    nightly is unpublished and short-lived, not secret. The Safe Browsing key it contains ships
    in every keyed binary anyway (decision 18).

## Security and privacy

This spec reduces surface: it removes trust in archive.mozilla.org's transport, in a reused
`engine/`, in floating npm versions and install scripts, in workflow-file conditions for the
Safe Browsing key, and the standing possibility of a self-hosted runner in a public repository.
New surface:

- `classify` in `dependabot-automerge.yml` runs on `pull_request` with `contents: read` and no
  secrets; it executes the base commit's code and only reads the head commit's lockfile as text
  and the registry's tarballs as data (`npm diff`). The job holding `contents: write` still
  checks out nothing.
- `mozilla-key-check.py` parses a file downloaded from archive.mozilla.org with
  `gpg --show-keys --with-colons` in a temporary `GNUPGHOME`; it imports nothing into a
  persistent keyring, and its only effect is an issue, written by the existing `publish` job.
- The nightly's `report` job holds `issues: write`; it downloads the redacted log artifact and
  calls `gh`, and checks out nothing (decision 23). The `build` job, which runs all third-party
  code, holds `contents: read` only, and no job can write contents. Its package is a workflow
  artifact that anyone signed in to GitHub can download for 7 days.
- Building on GitHub-hosted runners puts the Safe Browsing key on GitHub's virtual machines for
  the length of a job, as `e2e.yml` and every other hosted job already handle repository data.
  The key is written to a mode-600 file in `RUNNER_TEMP` and deleted after the last `mach` call,
  as today.
- The pinned key file is security-relevant. `docs/review-checklist.md` gains a line: a change to
  `tools/upstream/mozilla-release-key.asc` or the fingerprint constant must cite Mozilla's
  announcement and keep every revocation.

New section for `docs/security.md`, **§14. Build and release supply chain** (`release.yml`,
`nightly.yml`), with **Reach:** Mozilla's archive and Taskcluster, the npm registry, this
repository, and GitHub's hosted runners. Each rule links its tests (Tests, below):

- B1. Nothing is **ever** built from a Firefox source tarball unless its SHA-512 is listed in a
  `SHA512SUMS` carrying a good signature by a valid signing subkey of Mozilla's release key
  `14F26682D0916CDD81E37B6D61B7B526D98F0353`; a revoked or expired subkey, another key or a
  missing signature fails. A tarball already on disk is verified like a downloaded one.
- B2. A nightly or release build **never** builds from an `engine/` it did not extract in the
  same job from the tarball it verified, and **never** restores a tree, an objdir or a compiler
  cache from the Actions cache; a release **must** build in a fresh objdir with an empty
  compiler cache.
- B3. Surfer **must** be pinned to one exact version, and a change to any package in the release
  path **never** merges without a person, security updates included.
- B4. An npm install **never** runs install scripts, and the build **must** run Surfer only from
  `node_modules`.
- B5. A job of a workflow that a pull request, a comment, an issue or another workflow run can
  trigger **never** runs on a self-hosted runner. **⚠ setting:** fork pull request approval is
  `all_external_contributors` (`gh api repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`).
- B6. The Safe Browsing key **must** be available only to jobs in the `build` environment,
  deployable only from `main`, and only the two build jobs use it.
- B7. A change to Mozilla's release key **must** open a `security` issue within 4 hours of
  appearing in Mozilla's `KEY` file, and 60 days before the pinned signing subkey expires.

§10's G4 changes to cite B1 ("whose SHA-512 differs from a signed `SHA512SUMS`, B1"). §11, "Out
of scope and trust boundaries", gains a **Build infrastructure** entry with decision 20's
boundary (GitHub's hosted runners and Mozilla's toolchains are trusted) and what a cosign
signature does and does not attest. `docs/rebase.md` drops "HTTPS from archive.mozilla.org is
the trust anchor", and `verify-sha512.py`'s docstring drops "its GPG signature is not checked".

## Tests

Written first and seen to fail.

**Python, `tools/upstream/test_verify_sha512.py`** (real fixtures in
`tools/upstream/fixtures/sums/`: `SHA512SUMS` and `SHA512SUMS.asc` of 157.0.1 and 153.0, about
860 KB each; for the synthetic cases, signatures by throwaway keys made with
`gpg --quick-gen-key` in a temporary `GNUPGHOME` by `fixtures/sums/make-synthetic.sh`, which
keeps only public keys and signatures, so no test run starts a `gpg-agent`):

- `test_good_signature_from_mozillas_current_subkey_passes` (157.0.1)
- `test_signature_by_the_revoked_compromised_subkey_fails` (153.0, `REVKEYSIG` with exit 0, R2)
- `test_signature_by_another_key_fails`
- `test_a_second_signature_beside_mozillas_fails`
- `test_signature_by_an_expired_subkey_fails`
- `test_the_status_must_name_the_pinned_primary_key`
- `test_a_detached_signature_by_the_given_key_passes`
- `test_a_signed_message_in_place_of_a_detached_signature_fails`
- `test_one_changed_byte_in_sha512sums_fails_the_signature`
- `test_good_signature_but_a_different_hash_fails_naming_expected_and_actual`
- `test_missing_signature_or_gpgv_cannot_check_and_exits_two`
- `test_signature_argument_is_required`
- `test_pinned_key_is_mozillas_primary_with_the_compromised_subkey_revoked`

**Python, `tools/upstream/test_mozilla_key_check.py`** (fixtures: Mozilla's `KEY` of 158.0 and the
same key without the 2026-08-06 subkey and revocation):

- `test_a_new_subkey_or_revocation_in_mozillas_key_is_reported`
- `test_a_different_primary_key_is_reported_and_never_adopted`
- `test_a_signing_subkey_expiring_within_60_days_is_reported`
- `test_an_unchanged_key_reports_nothing`

**vitest, `tools/upstream/test/firefox-source.test.mjs`** (runs the script with
`MOZILLA_RELEASES` pointing at a `file://` fixture directory and a stub `surfer` in the
checkout's `node_modules/.bin`, where `npx --no` finds it):

- `a tampered tarball fails before engine/ is touched`
- `a SHA512SUMS without a good signature fails before engine/ is touched` (sub-PR 2)
- `a SHA512SUMS with no signature beside it fails before engine/ is touched` (sub-PR 2)
- `a tarball already on disk is verified again and engine/ is extracted from it afresh`
- `a tampered tarball already on disk fails like a downloaded one`
- `a missing tarball is downloaded by the script, never by Surfer`
- `fails when the archive has no SHA512SUMS, before engine/ is touched`
- `refuses surfer.json version … before it reaches a URL`
- `refuses a surfer.json with a version.candidate, before anything is fetched` (Surfer downloads
  a candidate from `candidates/` with no hash check, a file the script never verified)
- `a SHA512SUMS that does not list the tarball exits 2, keeping the tarball and engine/`

**vitest, `tools/upstream/test/source-check.test.mjs`** (extends the existing file):

- `the source check fails on a SHA512SUMS whose signature is not good`
- `the source check fails when SHA512SUMS has no signature beside it`

The script tests (`firefox-source`, `source-check`, `verify-source`) cannot carry Mozilla's real
signature, because their tarballs are made by the test. They put a `gpgv` stub
(`tools/upstream/test/fake-gpgv.mjs`) first on `PATH`, which answers like `gpgv` for a good
signature by Mozilla's current subkey only when the `.asc` names the signed file's hash, and
`BADSIG` otherwise. The scripts therefore keep no test override of the key or the fingerprint;
the cryptography is tested by `test_verify_sha512.py` alone.

**vitest, `tools/upstream/test/verify-source.test.mjs`** (sub-PR 2):

- `passes the tarball surfer download left when Mozilla's signed SHA512SUMS lists it`
- `fails a tampered tarball`
- `fails when SHA512SUMS is not signed by Mozilla's release key`
- `fails when there is no tarball to check`
- `records the verified version in engine/'s repository, where a lane copy keeps it`
- `records nothing when the check fails`
- `--require passes an engine/ verified for surfer.json's version, offline`
- `--require refuses an engine/ never verified, or verified for another version`
- `--require refuses when there is no engine/`

**vitest, `tools/test/upstream-workflow.test.mjs`** (sub-PR 2, extends the existing file):

- `every verify-sha512.py call passes a signature`
- `a report on a tarball that failed verification is never uploaded`
- `npm run import refuses an engine/ whose source was never verified`

**vitest, `tools/deps/test/release-path.test.mjs`** (fixture lockfiles):

- `the release path is Surfer, ajv and everything they depend on`
- `the roots cover every package the release build job imports`
- `a changed release-path package needs review, security updates included`
- `a change only outside the release path may auto-merge`
- `a transitive release-path package bumped in a grouped update needs review`

**vitest, `tools/test/build-supply-chain.test.mjs`** (reads the workflow and config files):

- `the full builds install with npm ci --ignore-scripts and run Surfer with npx --no`
- `.npmrc turns install scripts off for every install`
- `package.json pins Surfer to an exact version`
- `surfer.json lists no add-ons`
- `the Safe Browsing key comes only from the build environment, in the two build jobs`
- `dependabot-automerge classifies on base-branch code with a read-only token`
- `the release-path group comes before the minor and patch group`

**vitest, `tools/test/full-build-workflows.test.mjs`** (sub-PR 4, the two build jobs):

- `<workflow> gets Firefox source only through firefox-source.sh`
- `no workflow runs surfer download itself`
- `no workflow reads or writes engine/.vimma-firefox-version`
- `the build jobs check out clean and restore nothing from the Actions cache`
- `a release builds in a fresh objdir with an empty compiler cache`
- `<workflow> checks for 50 GB free before downloading Firefox source`
- `<workflow> drops engine/'s empty repository between import and build`
- `<workflow> adds a 16 GB swap file before building`
- `<workflow> stops itself before GitHub's 6-hour job limit`
- `only the nightly's failure-issue step gets GH_TOKEN` (the token that can write issues never
  reaches npm, Surfer, mach or the mochitests)

**vitest, `tools/test/nightly-workflow.test.mjs`** (decision 23):

- `the workflow and its build job can only read the repository`
- `the build job keeps the package as a workflow artifact for 7 days`
- `no job creates, edits or deletes a release, and none can write contents`
- `a failure is reported by its own job, from the redacted log artifact`
- `the report job names the repository, since it checks nothing out`

**vitest, `tools/test/self-hosted-runner.test.mjs`:**

- `no workflow an outsider can trigger runs a job on a self-hosted runner`
- `a runs-on expression in such a workflow fails unless it resolves to a hosted image`
- `no workflow names a self-hosted runner, and both build jobs run on ubuntu-24.04`
- `each build job runs only from main or for a release`

**Existing tests that change:** `tools/test/safebrowsing-workflows.test.mjs` (the key comes from
the `build` environment instead of a repository secret), `tools/test/upstream-workflow.test.mjs`
(G4 cites the signed check; the `detect` job runs the key check),
`tools/test/upstream-beta-workflow.test.mjs` (`e2e.yml` checks its download through
`firefox-source.sh`), `tools/test/sites-workflow.test.mjs` (the SHA512SUMS check is
`firefox-source.sh`; its
hosted-runner assertion moves into `self-hosted-runner.test.mjs`),
`tools/package/test/release-workflow.test.mjs` (the release build job's runner and checkout).

No mochitest or e2e scenario: nothing in the browser changes.

## Docs and changelog

- `docs/security.md`: §14 with B1 to B7 and their test links; G4 amended; §11 gains "Build
  infrastructure".
- `docs/runbook.md`, "Full builds (`nightly.yml`, `release.yml`)" (already says they run on
  GitHub-hosted runners, with the self-hosted label as a known gap): the measured time and disk
  from sub-PR 4, the disk guard, `sha_pinning_required`, the steps to switch both builds on, and
  the `build` environment with the steps to move the secret into it; the known-gap paragraph
  goes; a new
  "Mozilla's release key" section (how to update the pinned key from Mozilla's announcement and
  `KEY` file, what the issue from decision 21 asks for); the `engine/.vimma-firefox-version`
  paragraph goes.
- `docs/rebase.md`: the source check verifies Mozilla's signature; the trust-anchor sentence goes;
  step 4 of its table says the full build runs in the nightly on a hosted runner.
- ADR-010 and ADR-015: the sentences saying a full build does not fit a hosted runner are
  corrected with R9 and the sub-PR 4 measurement.
- `CONTRIBUTING.md`, "Dependency updates": release-path packages, why they are never
  auto-merged, how to read the `release-path-diff` summary, and that install scripts are off.
- `docs/review-checklist.md`: the pinned-key line (Security and privacy).
- Decision 23: `docs/security.md` B8; `docs/runbook.md`, "Full builds" (the artifact, how to
  download it, who can); `docs/limits.md`, "Build and CI"; a "Since changed"
  note in spec m0-pipeline.
- ADR-021 (new) and the ADR-001 paragraph (sub-PR 2 and sub-PR 1).
- No `docs/guide.md` or README change: nothing a user does or sees changes.
- `CHANGELOG.md`: one line, added at merge time: "Release and nightly builds verify Mozilla's
  signature on the Firefox source, never reuse a build tree, and run on GitHub-hosted runners."

## Delivery

Each sub-PR adds its `docs/security.md` rules together with the tests they link, so the link
check (`npm run security-links`) holds at every step. None needs a build machine or a build
variable, and only sub-PR 5 needs a repository setting changed; the order puts first what
protects something that runs today.

1. **`build(deps): pin surfer, no install scripts, no self-hosted runner for outsiders`.** Exact
   Surfer pin; `.npmrc`; `npm ci --ignore-scripts` and `npx --no` in `release.yml` and
   `nightly.yml`; the `release-path` Dependabot group; `dependabot-automerge.yml` also holds
   Surfer's security updates (the name check it has today, extended);
   `self-hosted-runner.test.mjs` with all four tests and both build jobs on `ubuntu-24.04`
   (decision 7); the `surfer.json` add-on test; the ADR-001 paragraph; the runbook's
   `sha_pinning_required` step. Rules B4, B5 and the Surfer half of B3. The Surfer check
   matches `@zen-browser/surfer` as a substring of the dependency names and the title, in any
   case, and an update without dependency names waits for a person: the check it replaces
   matched names joined by `","` only, while `dependabot/fetch-metadata` joins them with
   `", "`, and so let a grouped Surfer update through. A substring match does not depend on
   that format, and matching too much only holds a pull request for review. Smallest change with the
   largest effect: it closes Problem 3, which is live today because Dependabot runs and
   auto-merges now, and Problems 4 and 5's runner half.
2. **`ci(upstream): verify mozilla's signature on SHA512SUMS`.** Pinned key,
   `verify-sha512.py --signature`, `source-check.sh` and `firefox-source.sh` use it (and through
   the latter `e2e.yml`, `sites.yml` and both builds, if sub-PR 4 lands first; otherwise the
   inline checks in `e2e.yml` and `sites.yml`); `npm run verify-source` for a contributor's
   `npx surfer download`; ADR-021; G4 amended; `docs/rebase.md`; the runbook's "Mozilla's
   release key" section and the review-checklist line. Because `upstream.yml` and the Beta canary both
   run `source-check.sh`, one change covers both. B1 for PR CI, the autopilot and the canary,
   which run today, and the autopilot opens pull requests that may merge without a person
   (ADR-020).
3. **`ci(deps): hold every release-path change for review, with the package diff`.**
   `release-path.mjs`, the `classify` job and the `npm diff` summary. Completes B3.
4. **`ci(release): full builds on hosted runners, from verified, freshly extracted source`.**
   `firefox-source.sh`; `nightly.yml`, `release.yml`, `e2e.yml` and `sites.yml` use it; the
   builds run on `ubuntu-24.04` with `clean: true`, the disk guard, the swap file and no Actions
   cache, and drop `engine/.git` before building (R14); the `.vimma-firefox-version` shortcut
   goes. Before merging, a temporary job in the pull request's own CI (hosted runner, no secret,
   keyless, publishes nothing) runs `firefox-source.sh`, `npm run import` and a full build, and
   records wall time, peak disk and peak memory; the numbers go into `docs/runbook.md`, set
   `timeout-minutes` (decision 10), and select the runner (decision 6); the job is removed before
   merge. ADR-010 and ADR-015 corrected. B1 for builds (the hash; the signature with sub-PR 2),
   B2. The measurement (R15) ran from a separate branch that was never proposed for merging, so
   the pull request never carried the temporary job; it took 124 minutes, so both builds stay on
   the standard runner.
5. **`ci(release): the safe browsing key in a build environment; key rotation watch`.** The
   `build` environment (created and the secret moved by a repository administrator before
   merging, steps in the runbook), `environment: build` in both jobs, `mozilla-key-check.py` in
   `upstream.yml`, §11 "Build infrastructure". B6, B7.

## Open questions

None.
