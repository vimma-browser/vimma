## 14. Build and release supply chain (`release.yml`, `aur.yml`, `homebrew.yml`, `nightly.yml`, `macos.yml`, `flatpak.yml`, `site-dispatch.yml`)

Vimma's binaries are built from Mozilla's Firefox source, this repository, and the npm packages
that drive the build, chiefly Surfer. These rules keep what reaches a build pinned and reviewed.
Spec: [build-supply-chain](../specs/build-supply-chain.md), [ADR-001](../adr/001-engine-firefox-surfer.md).

**Reach:** Mozilla's archive and Taskcluster, the npm registry, this repository, and GitHub's
hosted runners; for the Flatpak build only (B12), Docker Hub's Fedora image, Fedora's package
mirrors and Flathub (`dl.flathub.org`). Dependabot pull requests run and auto-merge today, whether or not a build runs.

The macOS build, `macos.yml` ([ADR-018](../adr/018-macos-cross-build.md)), also runs on pull
requests that touch it. It holds no secret and only a read-only token, builds on hosted runners
under B1, B2 and B5 like the release build, and adds one download, rcodesign, pinned by SHA-256.
Its ad hoc signature proves nothing about who built the app. Its `smoke` job builds `vimma-ctl`
with the toolchain of `rust-toolchain.toml` and the crates of `Cargo.lock` (`--locked`), as
`ci.yml` does, to drive the app through the e2e smoke scenarios; that binary is never packaged.
`release.yml`'s macOS jobs, which run only while the variable `MACOS_RELEASE_ENABLED` is `true`,
hold every rule below that the Linux jobs hold: the same tag checks, the `build` environment for
the key, cosign under the same identity, and the same refusal to replace a published release's
files (B6, B9, B10). Apple's Developer ID signing and notarisation add the `macos-sign`
environment and its secrets (B14). No Linux job needs them, so a macOS failure holds back no Linux release.
[`no Linux job needs a macOS job`](../../tools/package/test/release-workflow.test.mjs),
[`macos-build checks the tag like build, then cross-builds with the key`](../../tools/package/test/release-workflow.test.mjs),
[`the build jobs check out clean and restore nothing from the Actions cache`](../../tools/test/full-build-workflows.test.ts),
[`reads no secret, deploys to no environment and only reads the repository`](../../tools/package/test/macos.test.mjs),
[`pins one rcodesign release and its SHA-256, checked before the file is used`](../../tools/package/test/macos.test.mjs)

Every job of these workflows that sets up Node takes the exact version in `.nvmrc` of the commit it
checked out (`node-version-file: .nvmrc`), never a bare major such as `node-version: 22`, which
resolves to whichever 22.x the runner's tool cache or the version manifest has that day: the
release tools run on the Node their tests ran on. Every release tag has `.nvmrc`; the build jobs
of the same commit read it too, so a tree without it could not be released anyway.
[`every setup-node step takes .nvmrc's version`](../../tools/test/runner-node.test.ts)

- B1. Nothing is **ever** built from, or reported on, a Firefox source tarball unless its SHA-512
  is listed in a `SHA512SUMS` carrying exactly one good signature by a valid signing subkey of
  Mozilla's release key `14F26682D0916CDD81E37B6D61B7B526D98F0353`, pinned in
  `tools/upstream/mozilla-release-key.asc` ([ADR-021](../adr/021-mozilla-release-key.md)); a
  revoked or expired subkey, another key, a second signature, a signed message in place of a
  detached signature, or a missing signature fails. The verdict comes from `gpgv`'s status lines,
  never its exit status, which is 0 for the revoked, compromised subkey. Every verification goes
  through `tools/upstream/verify-sha512.py`, called by `firefox-source.sh` (every build, PR CI
  included) and `source-check.sh` (the autopilot and the Beta canary); a tarball already on disk
  is verified like a downloaded one. On a contributor's machine, `npx surfer download` checks
  nothing, so `npm run import`, the first step of every local build and lane, refuses an
  `engine/` until `npm run verify-source` has verified the tarball it came from for
  `surfer.json`'s version (a record in `engine/.git`, which `firefox-source.sh` writes too). That
  record guards against building an unverified download, not against someone who can already
  write to `engine/`.
  `firefox-source.sh` also refuses a `surfer.json` with a `version.candidate`, which Surfer would
  fetch from `candidates/` unverified.
  A pull request that changes the pinned key file, or a line of `verify-sha512.py` that names
  `PINNED_FINGERPRINT` or `KEY_FILE`, fails the required check "Mozilla release key unchanged or
  approved" (`.github/workflows/key-guard.yml`, `tools/ci/key-guard.mjs`) until a maintainer adds
  the `key-rotation-approved` label, which needs triage access to the repository. No automation
  or agent adds that label; a maintainer adds it only after the checks in `docs/runbook/ci-mozillas-release-key.md`,
  "Mozilla's release key", and removes it if a later push changes the key again, since the label
  stays on the pull request across pushes. The check runs the base branch's copy of the script,
  and is skipped only on a merged pull request: release-please relabels a merged release pull
  request after its branch is deleted. A skipped job reports success, which is safe only once
  merged, because the head is already in `main`. A label change on a closed, unmerged pull
  request still runs the check, so its head commit cannot gain a passing check that a later pull
  request with the same head would inherit.
  A pull request that changes the guard itself (`.github/workflows/key-guard.yml`,
  `tools/ci/key-guard.mjs` or its tests) needs the same label, because under `pull_request` such
  a pull request still runs its own copy of the workflow and could rewrite it to pass; the
  label requirement on the guard's files is what makes that change visible, and the `main`
  ruleset, which requires the check by its name, is what makes it binding. The one exception is
  the pull request that first adds the guard to a base branch without one. Its scope is the
  key, the fingerprint and the guard: it does not see a change that weakens `verify-sha512.py`
  elsewhere (its call sites or its status checks); review of `tools/upstream/` covers that.
  [`test_good_signature_from_mozillas_current_subkey_passes`](../../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_the_revoked_compromised_subkey_fails`](../../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_another_key_fails`](../../tools/upstream/test_verify_sha512.py),
  [`test_a_second_signature_beside_mozillas_fails`](../../tools/upstream/test_verify_sha512.py),
  [`test_signature_by_an_expired_subkey_fails`](../../tools/upstream/test_verify_sha512.py),
  [`test_one_changed_byte_in_sha512sums_fails_the_signature`](../../tools/upstream/test_verify_sha512.py),
  [`test_missing_signature_or_gpgv_cannot_check_and_exits_two`](../../tools/upstream/test_verify_sha512.py),
  [`test_pinned_key_is_mozillas_primary_with_the_compromised_subkey_revoked`](../../tools/upstream/test_verify_sha512.py),
  [`a SHA512SUMS without a good signature fails before engine/ is touched`](../../tools/upstream/test/firefox-source.test.mjs),
  [`the source check fails on a SHA512SUMS whose signature is not good`](../../tools/upstream/test/source-check.test.mjs),
  [`test_a_signed_message_in_place_of_a_detached_signature_fails`](../../tools/upstream/test_verify_sha512.py),
  [`fails a tampered tarball`](../../tools/upstream/test/verify-source.test.mjs),
  [`--require refuses an engine/ never verified, or verified for another version`](../../tools/upstream/test/verify-source.test.mjs),
  [`npm run import refuses an engine/ whose source was never verified`](../../tools/test/upstream-workflow.test.ts),
  [`every verify-sha512.py call passes a signature`](../../tools/test/upstream-workflow.test.ts),
  [`refuses a surfer.json with a version.candidate, before anything is fetched`](../../tools/upstream/test/firefox-source.test.mjs),
  [`fails a changed key file without the label`](../../tools/ci/test/key-guard.test.mjs),
  [`fails a change to any of the guard's own files without the label, and passes it with`](../../tools/ci/test/key-guard.test.mjs),
  [`passes the pull request that first adds the guard to a base without one`](../../tools/ci/test/key-guard.test.mjs),
  [`fails a changed fingerprint without the label, and passes it with`](../../tools/ci/test/key-guard.test.mjs),
  [`passes event values to run: through env only`](../../tools/ci/test/key-guard.test.mjs),
  [`skips the whole job once the pull request is merged, and still runs on a closed unmerged one`](../../tools/ci/test/key-guard.test.mjs),
  [`still judges when started through a symlinked path`](../../tools/ci/test/key-guard.test.mjs)
- B2. A nightly or release build **never** builds from an `engine/` it did not extract in the
  same job from the tarball it verified, and **never** restores a tree, an objdir or a compiler
  cache from the Actions cache; a release **must** build in a fresh objdir with an empty
  compiler cache.
  [`a tarball already on disk is verified again and engine/ is extracted from it afresh`](../../tools/upstream/test/firefox-source.test.mjs),
  [`no workflow reads or writes engine/.vimma-firefox-version`](../../tools/test/full-build-workflows.test.ts),
  [`the build jobs check out clean and restore nothing from the Actions cache`](../../tools/test/full-build-workflows.test.ts),
  [`a release builds in a fresh objdir with an empty compiler cache`](../../tools/test/full-build-workflows.test.ts)
- B3. Surfer **must** be pinned to one exact version, locked by its integrity hash, and a
  Dependabot change to any package on the release path (Surfer, `ajv` and every package they
  depend on, computed from `package-lock.json` by `tools/deps/release-path.ts`) **never** merges
  without a person, security updates and grouped updates included. The `classify` job decides
  from the lockfile diff, running the base commit's code on the head commit's lockfile read as
  data, with a read-only token and no secrets. It checks out only the base commit, sets up
  `.nvmrc`'s Node there, and only then fetches the head commit, whose lockfile it writes to
  `$RUNNER_TEMP`: setup-node's `npm` and `yarn` read the base commit's configuration, and no file
  of the pull request ever reaches the workspace. It shows the published diff (`npm diff`) in its
  summary and the `release-path-diff` artifact. A failed classification, an update whose
  dependency names are missing, and a Surfer name in Dependabot's metadata wait for a person too.
  [`package.json pins Surfer to an exact version, locked by integrity`](../../tools/test/build-supply-chain.test.ts),
  [`a Surfer update is never auto-merged, security updates included`](../../tools/test/build-supply-chain.test.ts),
  [`Surfer is held whatever the separator, quoting or case, or when only the title names it`](../../tools/test/build-supply-chain.test.ts),
  [`an update whose dependency list is empty waits for a person`](../../tools/test/build-supply-chain.test.ts),
  [`the release-path group comes before the minor and patch group`](../../tools/test/build-supply-chain.test.ts),
  [`dependabot-automerge classifies on base-branch code with a read-only token`](../../tools/test/build-supply-chain.test.ts),
  [`classify sets up Node on the base commit alone, before any of the head commit`](../../tools/test/build-supply-chain.test.ts),
  [`classify's order check catches %s`](../../tools/test/build-supply-chain.test.ts),
  [`a release-path change is never auto-merged, security updates included`](../../tools/test/build-supply-chain.test.ts),
  [`the release path is Surfer, ajv and everything they depend on`](../../tools/deps/test/release-path.test.ts),
  [`the roots cover every package the release build job imports`](../../tools/deps/test/release-path.test.ts),
  [`a changed release-path package needs review, security updates included`](../../tools/deps/test/release-path.test.ts),
  [`a change only outside the release path may auto-merge`](../../tools/deps/test/release-path.test.ts),
  [`a transitive release-path package bumped in a grouped update needs review`](../../tools/deps/test/release-path.test.ts),
  [`only registry names and exact versions are handed to npm diff`](../../tools/deps/test/release-path.test.ts)
- B4. An npm install **never** runs install scripts, and the build **must** run Surfer only from
  `node_modules`, never a package `npx` fetches, and **never** lets Surfer fetch an add-on.
  [`.npmrc turns install scripts off for every install`](../../tools/test/build-supply-chain.test.ts),
  [`the full builds install with npm ci --ignore-scripts and run Surfer with npx --no`](../../tools/test/build-supply-chain.test.ts),
  [`no workflow lets npx fetch a package`](../../tools/test/build-supply-chain.test.ts),
  [`surfer.json lists no add-ons`](../../tools/test/build-supply-chain.test.ts)
- B5. A workflow **never** targets a self-hosted runner: every job runs on a standard
  GitHub-hosted image or calls a workflow file of this repository, and a `runs-on` expression
  that cannot be resolved to a hosted image fails. The test parses each workflow as YAML and
  fails on any shape it does not recognise. A job of a workflow that a pull request, a comment,
  an issue or another workflow run can trigger is held to this as the permanent guard; the build
  jobs run only from `main` (the nightly also on its schedule), and only once `NIGHTLY_ENABLED`
  or `RELEASE_ENABLED` is set. **⚠ setting:** fork pull request approval is
  `all_external_contributors`
  (`gh api repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`), so a
  fork's own workflow files run only once a person approves the run; and the organization has
  no self-hosted runner (`gh api orgs/vimma-browser/actions/runners`, organization owners only),
  since an organization runner shared with this repository is invisible to every
  repository-level check.
  [`no workflow an outsider can trigger runs a job on a self-hosted runner`](../../tools/test/self-hosted-runner.test.ts),
  [`a runs-on expression in such a workflow fails unless it resolves to a hosted image`](../../tools/test/self-hosted-runner.test.ts),
  [`a quoted job id is a job of its own`](../../tools/test/self-hosted-runner.test.ts),
  [`a job written as a flow mapping is checked`](../../tools/test/self-hosted-runner.test.ts),
  [`a matrix key is read only from the job's own strategy.matrix`](../../tools/test/self-hosted-runner.test.ts),
  [`triggers are read in every spelling YAML allows`](../../tools/test/self-hosted-runner.test.ts),
  [`no workflow names a self-hosted runner, and both build jobs run on ubuntu-24.04`](../../tools/test/self-hosted-runner.test.ts),
  [`each build job runs only from main`](../../tools/test/self-hosted-runner.test.ts)
- B6. The Safe Browsing key **must** be available only to jobs in the `build` environment,
  deployable only from `main`, and only the build jobs of `nightly.yml` and `release.yml`
  (`build` and, for the macOS `.dmg`, `macos-build`) use it. The environment's deployment rule is enforced by GitHub, outside any
  workflow file, so a branch's or tag's edited workflow cannot read the key by dropping an
  `if:`. No tag may deploy: a tag ruleset restricts moving a tag, not creating one. The key
  still ships inside every keyed binary (spec m0-safebrowsing-key): this limits who can use it
  from CI, not who can read it. **⚠ setting:** the `build` environment, with `main` as its only
  deployment rule, holds `SAFEBROWSING_API_KEY`, and no repository secret of that name exists
  (`gh api repos/vimma-browser/vimma/actions/secrets`; docs/runbook/ci-google-safe-browsing-key.md, "Google Safe Browsing
  key"). While a repository secret of that name remains, any job of any branch can read it.
  [`the Safe Browsing key comes only from the build environment, in the release and nightly builds`](../../tools/test/build-supply-chain.test.ts)
- B7. A change to Mozilla's release key **must** open a `security` issue within 4 hours of
  appearing in Mozilla's `KEY` file, and 60 days before the pinned signing subkey expires.
  `upstream.yml`'s `detect` job (every 4 hours) downloads
  `nightly/latest-mozilla-central/KEY` and `tools/upstream/mozilla-key-check.py` compares it
  with the pinned key in a throwaway `GNUPGHOME`; it never edits the keyring. A new subkey or
  revocation, a different primary key (never adopted: ADR-021 is reviewed) or the expiry warning
  becomes one open issue per title, written by the `key` job, which runs only `gh` with
  `issues: write`. **⚠ limit:** a failed download or parse warns and does not fail the run, so
  release detection, which drives security bumps, never waits on it.
  [`test_a_new_subkey_or_revocation_in_mozillas_key_is_reported`](../../tools/upstream/test_mozilla_key_check.py),
  [`test_a_different_primary_key_is_reported_and_never_adopted`](../../tools/upstream/test_mozilla_key_check.py),
  [`test_a_signing_subkey_expiring_within_60_days_is_reported`](../../tools/upstream/test_mozilla_key_check.py),
  [`test_an_unchanged_key_reports_nothing`](../../tools/upstream/test_mozilla_key_check.py),
  [`detect compares Mozilla's KEY with the pinned key; a change opens a security issue`](../../tools/test/upstream-workflow.test.ts)
- B8. Unless the repository variables `NIGHTLY_RELEASE_ENABLED` and `UPDATES_ENABLED` are both
  `true`, the nightly **never** creates, replaces or deletes a release, and no job of it can
  write contents. Its `build` job, which runs npm, Surfer, `mach` and the
  mochitests, holds `contents: read` only, whatever the variables, and keeps its package as a
  workflow artifact for 7 days. The failure issue comes from a `report` job with
  `issues: write` and `actions: read`, which checks out and runs no repository code, reads no
  secret, and quotes only the log the build job redacted before uploading it, with backticks
  escaped so no log line can end its code fence, and the names of the run's failed jobs and
  steps (run metadata, never another job's log). With both variables `true` (spec
  [m6a-updater](../specs/m6a-updater.md), decisions 42 and 43), a nightly is also public:
  `mar-sign` signs its MAR on the channel `vimma-nightly` (UP14); `mar`, with no secret and a
  read-only token, checks the signed MAR as `release.yml`'s `mar` does and writes a
  `SHA256SUMS` that lists exactly the tarball and the MAR, named by build ID; `sign`, holding
  only `id-token: write` and running no repository code, signs that `SHA256SUMS` with cosign as
  `nightly.yml@refs/heads/main`, an identity that `release.yml`'s `IDENTITY_REGEXP` and the
  release manifest's check never accept; and `publish`, the **only** job with
  `contents: write`, checks out and runs no repository code. It uploads only files that
  `SHA256SUMS` lists (and the sums and their signature) to the rolling `nightly` release, which
  it creates as a pre-release that is never Latest, with its `nightly` tag at that commit, and
  never deletes; no job moves a tag. It refuses to touch the release when it is a draft or a full
  release, and when it already holds a newer build (a re-run of an older night). It removes only
  the files of builds older than this one, keeping the previous build's and those of the build
  the published nightly manifest offers, and removes none when the update host does not answer.
  A scheduled run builds only when `main` changed (decision 44): the `changes` job, with
  `contents: read`, no secret and no environment, runs `gh release view` and
  `tools/update/nightly-change.mjs` to compare `main`'s commit and Firefox version with the
  record that `publish` writes first in the release notes. On a match no job in the `build`
  environment starts, so the Safe Browsing key is not read that day, and `manifest` re-signs the
  recorded build (UP7); anything the record cannot vouch for builds, and a manual run always
  builds, as does a failed change check. The record only chooses between building and re-signing:
  whoever can edit the release's notes and files (write access) can delay a build or cause one,
  and can choose which build is re-signed only among genuine `nightly.yml@refs/heads/main`
  builds, since `nightly-prepare` still requires the release's `SHA256SUMS` under that cosign
  identity, the MAR on the channel `vimma-nightly`, and a build no older than the published
  offer.
  `SHA256SUMS` covers the newest build alone; a kept older build is still pinned by the manifest's
  SHA-512. Release and tag events made with
  `GITHUB_TOKEN` start no workflow, so `aur.yml`, `homebrew.yml`, `site-dispatch.yml` and
  `update-publish.yml`'s `start` never run for it. **⚠ limit:** the artifact is not private. The
  repository is public, so anyone signed in to GitHub can download it for the 7 days it is
  kept, and its name and size are listed without signing in. It holds the same package, and the
  same compiled-in Safe Browsing key, as a keyed release build. **⚠ limit:** a public nightly
  is `main` as it was that night, reviewed through pull requests and checked by CI and the full
  mochitest suite, not soaked as a release is; whether that may go public is the release gate,
  decided by setting the variable. **⚠ setting:** `NIGHTLY_RELEASE_ENABLED` is unset until
  public nightly releases start (`gh variable list`; docs/runbook/ci-full-builds.md, "Full builds").
  [`the workflow and its build job can only read the repository`](../../tools/test/nightly-workflow.test.ts),
  [`the build job keeps the package as a workflow artifact for 7 days`](../../tools/test/nightly-workflow.test.ts),
  [`every job after the build runs only with NIGHTLY_RELEASE_ENABLED and UPDATES_ENABLED`](../../tools/test/nightly-workflow.test.ts),
  [`only publish can write contents, and it runs no repository code`](../../tools/test/nightly-workflow.test.ts),
  [`the nightly release is a pre-release, never Latest or deleted, and no v* tag is touched`](../../tools/test/nightly-workflow.test.ts),
  [`publish uploads only files SHA256SUMS lists, after checking them`](../../tools/test/nightly-workflow.test.ts),
  [`cosign signs SHA256SUMS as nightly.yml on main, running no repository code`](../../tools/test/nightly-workflow.test.ts),
  [`refuses a nightly release whose state is %s, and uploads nothing`](../../tools/test/nightly-workflow.test.ts),
  [`refuses a re-run of an older night once a newer build is on the release`](../../tools/test/nightly-workflow.test.ts),
  [`keeps this build, the previous one and the one the live manifest offers`](../../tools/test/nightly-workflow.test.ts),
  [`removes nothing when the update host does not answer, nor any newer build`](../../tools/test/nightly-workflow.test.ts),
  [`a failure of any job is reported by its own job, from the redacted log artifact`](../../tools/test/nightly-workflow.test.ts),
  [`the report job names the repository, since it checks nothing out`](../../tools/test/nightly-workflow.test.ts),
  [`names the failed job and step in the issue`](../../tools/test/nightly-workflow.test.ts),
  [`reads the run's jobs with a read-only actions token, beside its issues one`](../../tools/test/nightly-workflow.test.ts),
  [`a scheduled run on an unchanged commit builds nothing and re-signs the recorded build`](../../tools/test/nightly-workflow.test.ts),
  [`a scheduled run on a changed commit builds, publishes and offers the new build`](../../tools/test/nightly-workflow.test.ts),
  [`a manual run builds, whatever the change check says`](../../tools/test/nightly-workflow.test.ts),
  [`the change check reads with contents: read alone, no secret and no environment`](../../tools/test/nightly-workflow.test.ts),
  [`a skipped day starts no job in the build environment and none that reads the Safe Browsing key`](../../tools/test/nightly-workflow.test.ts),
  [`builds when %s`](../../tools/update/test/nightly-change.test.mjs),
  [`only the nightly's failure-issue step, its publish job and its change check get GH_TOKEN`](../../tools/test/full-build-workflows.test.ts)
- B9. Every file `release.yml` uploads to a release, the Arch Linux `PKGBUILD` and `SRCINFO`
  included, **must** be listed in that release's `SHA256SUMS` and get a cosign bundle from the
  `sign` job, so a user can verify any asset, and the `PKGBUILD`, which pacman runs as root, is
  checked the same way as the binaries. The `PKGBUILD` pins the SHA-256 of the tarball it
  installs, and its generator accepts only `owner/name` for the repository and
  `[A-Za-z0-9._-]` for the desktop file ID, the two values it places in shell words. It is built
  and installed with `makepkg -si` on Arch Linux before anything is signed. The `.rpm` for
  Fedora and openSUSE carries no OpenPGP signature of its own (no key exists to sign it with):
  `SHA256SUMS` and its cosign bundle cover it as they cover the `.deb`, which is why the
  documented zypper command passes `--allow-unsigned-rpm` and dnf skips its OpenPGP check for a
  local file by default. Its spec is generated, and its generator accepts only an absolute path
  of `[A-Za-z0-9._/-]` for the staged root and the output directory, `[A-Za-z0-9._+-]` for the
  bundled library names and a maintainer line without `%`, the values it places in a shell
  command or in text rpm expands as macros. It is built by `rpmbuild`
  from Ubuntu's archive on the hosted runner and installed with dnf and zypper in Fedora and
  openSUSE containers pinned by digest, before anything is signed. **⚠ setting:**
  signatures exist only while the repository variable `SIGNING_ENABLED` is `true`; without it
  `publish` uploads the assets and `SHA256SUMS` unsigned. The macOS `.dmg` and its Homebrew cask
  `vimma.rb` are listed in their own `SHA256SUMS-macos`, so `SHA256SUMS`, which `aur.yml` and the
  update manifest read, never changes when they are added; `macos-sign` signs all three with the
  same identity, after a hosted Mac has checked the checksum, the signature, the version line,
  Vimma's icon catalog, the bundle identifier and the mounted volume's window art and icon
  against the committed files, has driven the app headless through the e2e smoke scenarios with
  its own `vimma-ctl` (a job with a read-only token and no secret, before anything is signed),
  and has installed the `.dmg` through the cask.
  The macOS icon files in `configs/branding/vimma/` are binaries in the tree;
  `macos.yml` regenerates them from their sources and fails if they differ. `firefox.icns`,
  `document.icns`, `disk.icns`, `background.png` and the layer image inside `Assets.car` are
  compared byte for byte. The dmg's `dsstore` is a binary nothing regenerates: Finder writes it
  (`tools/package/macos-dsstore.sh`), review reads it as a binary, and a test parses it and
  checks the layout, the background alias and that it names no home directory. The
  flattened fallback images inside `Assets.car`, which macOS 15 and earlier draw, differ on
  every `actool` run, so the check compares only their names, pixel sizes and sizes on disk; a
  change to their pixels that keeps the size is left to review, which reads `Assets.car` as a
  binary to be regenerated, never edited.
  [`writes SHA256SUMS that sha256sum -c accepts, for every release file`](../../tools/package/test/package.test.mjs),
  [`signs and uploads the PKGBUILD and SRCINFO with the other assets`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke runs the dmg on a hosted Mac and ties its version line to the tag`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-sign signs the dmg and its checksums, and runs no repository code`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-publish adds only the macOS files, and replaces them only when told`](../../tools/package/test/release-workflow.test.mjs),
  [`regenerates the icon files on a Mac with a pinned Xcode and fails on drift`](../../tools/package/test/macos.test.mjs),
  [`fails an app that still carries Firefox's unofficial icon`](../../tools/package/test/macos.test.mjs),
  [`macos-smoke checks the mounted dmg's window art and volume icon`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke runs the e2e smoke scenarios through the app's vimma-ctl`](../../tools/package/test/release-workflow.test.mjs),
  [`fails a volume with other art, such as Firefox's`](../../tools/package/test/macos.test.mjs),
  [`names no home directory or Firefox volume`](../../tools/package/test/macos.test.mjs),
  [`builds and installs the release PKGBUILD on Arch Linux before anything is signed`](../../tools/package/test/release-workflow.test.mjs),
  [`signs and uploads the .rpm with the other vimma* assets`](../../tools/package/test/rpm-smoke.test.mjs),
  [`smoke-tests the .rpm on Fedora and openSUSE before the files are uploaded for signing`](../../tools/package/test/rpm-smoke.test.mjs),
  [`pins a Fedora and an openSUSE image by digest`](../../tools/package/test/rpm-smoke.test.mjs),
  [`refuses the stage path %j, which the shell or the macro expander would change`](../../tools/package/test/package.test.mjs),
  [`refuses a bundled library name it could not quote`](../../tools/package/test/package.test.mjs),
  [`refuses a maintainer with a %, which rpm would expand as a macro`](../../tools/package/test/package.test.mjs),
  [`an output dir rpm's macro expander would change, before rpmbuild runs`](../../tools/package/test/package.test.mjs),
  [`needs nothing but itself: the tarball is its only source`](../../tools/package/test/package.test.mjs),
  [`refuses repo %j`](../../tools/package/test/package.test.mjs),
  [`refuses desktop id %j`](../../tools/package/test/package.test.mjs)

- B10. A release **must** be signed only by `release.yml` run from `main` through
  `workflow_dispatch`: `release-please.yml`'s `release-build` job dispatches it with
  `GITHUB_TOKEN` (`actions: write` only, no repository code) for the tag release-please just
  created, and a manual re-run is the same dispatch. Every signature names one identity,
  `release.yml@refs/heads/main` (`IDENTITY_REGEXP`), which a workflow on another branch cannot
  obtain; the jobs' `refs/heads/main` guard only stops accidental runs from a branch. The
  `build` job refuses a tag that is not `vX.Y.Z`, resolves it to one commit and refuses that
  commit unless it is on `main`, and every job checks out that commit, so only code that
  reached `main` through review is signed; `publish` refuses to upload if the tag has moved
  since. The assets go to the release while it is still a draft, which only collaborators see;
  publishing it **never** starts a build, and `publish` refuses a published release unless the
  run sets `replace_published`. `macos-publish`, which ends hours later, may add the macOS files
  to a published release that has none, since that changes no file a user or the AUR already
  has; it re-checks the tag's commit and replaces existing macOS files only with
  `replace_published`. **⚠ setting:** a tag ruleset on `refs/tags/v*` that restricts
  updates and deletions (docs/runbook/ci-release-packages.md, "Release packages", step 9) keeps a release tag from
  being moved at all. The AUR, public the moment a push lands, **never** gets a package for
  a draft: `aur.yml` runs when a release is published (or by hand), holds no GitHub token,
  takes the `PKGBUILD` and `SRCINFO` only from the release's public download URLs, which answer
  404 for a draft, checks them against `SHA256SUMS` and the `PKGBUILD`'s version against the
  tag, and with signing on checks `SHA256SUMS` against `IDENTITY_REGEXP` before it pushes. The
  AUR key is a secret of the `aur` environment, which only `main` and `v*` tags may use. **⚠ limit:** a collaborator can publish a draft
  before its build has finished; the release is then public without its assets for that time,
  and `aur.yml` fails and opens a `release-failure` issue instead of pushing.
  [`starts only by workflow_dispatch with a tag, so publishing a release rebuilds nothing`](../../tools/package/test/release-workflow.test.mjs),
  [`job %s runs only when enabled, here, from main`](../../tools/package/test/release-workflow.test.mjs),
  [`builds only a vX.Y.Z tag whose commit is on main`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-publish adds only the macOS files, and replaces them only when told`](../../tools/package/test/release-workflow.test.mjs),
  [`release-build starts release.yml on main for the tag release-please just created`](../../tools/package/test/release-workflow.test.mjs),
  [`accepts release.yml at refs/heads/main`](../../tools/package/test/package.test.mjs),
  [`refuses %s`](../../tools/package/test/package.test.mjs),
  [`never pushes to the AUR`](../../tools/package/test/release-workflow.test.mjs),
  [`runs when a release is published, or by hand with a tag; never for a draft`](../../tools/package/test/release-workflow.test.mjs),
  [`takes the PKGBUILD from the published release only, with no GitHub token`](../../tools/package/test/release-workflow.test.mjs),
  [`checks the release's signature against the documented identity when signing is on`](../../tools/package/test/release-workflow.test.mjs),
  [`uploads to the release by its tag and leaves the draft on that tag`](../../tools/package/test/release-workflow.test.mjs),
  [`builds, packages and publishes the one commit it checked`](../../tools/package/test/release-workflow.test.mjs),
  [`uploads only to a draft unless told to replace a published release`](../../tools/package/test/release-workflow.test.mjs),
  [`takes the AUR key from the aur environment`](../../tools/package/test/release-workflow.test.mjs)

- B11. The Homebrew tap, `vimma-browser/homebrew-tap`, is public the moment a push lands, and
  `brew` runs a cask's Ruby on the user's Mac, so it **must** get only a cask that `release.yml`
  built for a published release, as the AUR does (B10). `tools/package/cask.mjs` renders the cask
  in `macos-build` from the `.dmg`'s SHA-256, and accepts only an `X.Y.Z` release version, a
  lowercase SHA-256 and an `owner/name` repository, the values it places in Ruby strings. The
  cask has no `preflight`, `postflight`, `installer` or `script` stanza, runs nothing at install,
  pins the `.dmg`'s SHA-256, and zaps only Vimma's own paths under `~/Library`, never
  `~/.config/vimma`. `macos-smoke` runs `brew style`, an offline `brew audit --cask --strict`, and
  installs the `.dmg` through the cask before anything is signed; `pkgbuild.yml` does the same with
  a stub `.dmg` on every pull request that changes `tools/package/`. Both load the cask from a
  throwaway local tap and trust only that one cask (`brew trust --cask`) for the check, so
  Homebrew's tap trust stays on for every other tap on the runner. `homebrew.yml`'s `homebrew`
  job, which pushes, runs only by `workflow_dispatch` from `main`, and only while
  `MACOS_RELEASE_ENABLED` is `true`; it holds no GitHub token, runs no repository code, and takes `vimma.rb` only from the release's public
  download URLs, which answer 404 for a draft. It checks the cask against `SHA256SUMS-macos` and
  its version against the tag, and with signing on checks `SHA256SUMS-macos` against
  `IDENTITY_REGEXP` before it pushes over SSH to github.com, whose host key is pinned. It pushes
  only `Casks/vimma.rb`, never with `--force`, and never replaces a newer cask with an older one.
  Two jobs start it, each, as `main` has it, holding only `actions: write`, no environment and no
  secret, and running no repository code: `homebrew.yml`'s own `start` job, which a published release
  (`released`, never a pre-release) runs, and `release.yml`'s `macos-tap` job, which runs when the
  macOS files reach the release. Each starts `homebrew.yml` on `main` with the tag only once
  `vimma.rb` is on the published release, so whichever of the publish and the macOS files comes
  last starts the push. Each learns that from the release's metadata, read without a token from
  the API's `releases/tags/<tag>`, which answers 404 for a draft; it also requires `draft` to be
  false and the file's upload to be complete, never requests the file itself (any request for a
  release file counts as a download, docs/runbook/ci-release-download-counts.md, "Release download counts"), and fails on
  any answer other than 200 or 404 and on a 200 that is not a release, so a rate limit or an outage never passes for a release
  without the cask. Starting `homebrew.yml` grants nothing: its `homebrew` job still downloads
  the cask and checks it as above. `start` runs the tag's copy of `homebrew.yml`, which anyone with write
  access can edit on a tag of their own: an edited copy may ask for any permissions and read the
  repository's and organisation's secrets, but it gets nothing a write-access user cannot already
  get by pushing a branch. It cannot deploy to the `homebrew` environment, so it cannot reach the
  tap's key. `start` checks the tag's form before it fetches anything. A failed `start` (a
  malformed tag, a dispatch GitHub refuses) or a failed push opens or comments on the
  `release-failure` issue from the `failure` job, which holds only `issues: write`, so the tap is
  never left on an older release unnoticed. The tap's key is a write deploy key of the tap alone, a secret
  of the `homebrew` environment, which only `main` may use. No tag may deploy to it (as in B6): a
  tag ruleset restricts moving a tag, not creating one, and a run's workflow file and its `if:`
  come from its ref, so a tag on an unmerged commit could carry a `homebrew.yml` that skips every
  check and pushes any Ruby to the tap. For the same reason the `homebrew` job requires
  `workflow_dispatch`: a release event runs the tag's copy of the file, so that run only starts
  `main`'s copy, as `update-publish.yml` does (UP7). **⚠ setting:** the `homebrew`
  environment's only deployment policy is the branch `main`. **⚠ setting:** the tap's
  ruleset on `main` forbids deletion and force pushes and requires a pull request; deploy keys
  bypass it, so the workflow pushes directly, and admins bypass it only through a pull request
  (docs/runbook/ci-release-packages.md, "Release packages", step 7). The tap's own
  [`check.yml`](https://github.com/vimma-browser/homebrew-tap/blob/main/.github/workflows/check.yml)
  runs `brew style` and the same offline `brew audit --cask --strict` checks, on the latest stable
  Homebrew, on the tap's pull requests and on each push to its `main`, on a GitHub-hosted
  `macos-15` runner with a `contents: read` token, no secret, no `pull_request_target` trigger
  and `Homebrew/actions/setup-homebrew` pinned by commit SHA. A fork's pull request can replace
  `check.yml` itself, so those settings do not bound it: what does is GitHub's token for a fork's
  pull request, which is read-only and gets no secret, and the tap's approval policy for fork
  runs. **⚠ setting:** the tap's fork pull request approval is `all_external_contributors`, so
  a fork's workflow runs only once a person approves it. **⚠ setting:** the tap's Actions
  permissions set `sha_pinning_required`, so GitHub refuses an action not pinned to a full
  commit SHA (docs/runbook/ci-release-packages.md, "Release packages", step 7, for both). The check is not
  required, so it never holds `homebrew.yml`'s push; it reports a pushed cask that Homebrew
  would reject. **⚠ limit:** while `MACOS_SIGNING` is not `developer-id` (B14), the `.dmg` is
  ad hoc signed and not notarised, so Gatekeeper cannot vouch for it; the cask's caveats then tell
  users to choose Open Anyway in System Settings, and never to remove the quarantine flag. A
  notarised release's cask has no caveats.
  [`names the release dmg for the version and pins its sha256`](../../tools/package/test/cask.test.mjs),
  [`refuses a pre-release, a version that is not SemVer, and a bad sha256`](../../tools/package/test/cask.test.mjs),
  [`refuses repo %j`](../../tools/package/test/cask.test.mjs),
  [`declares arm64, the minimum macOS, the app and the vimma binary, and no flight blocks`](../../tools/package/test/cask.test.mjs),
  [`zaps Application Support and Caches, never ~/.config/vimma`](../../tools/package/test/cask.test.mjs),
  [`caveats point to Open Anyway, never to xattr or --no-quarantine`](../../tools/package/test/cask.test.mjs),
  [`checks the cask with brew style and an offline brew audit --cask --strict`](../../tools/package/test/cask.test.mjs),
  [`refuses to install outside GitHub Actions`](../../tools/package/test/cask.test.mjs),
  [`macos-smoke checks the cask with brew and installs the dmg through it`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-tap starts homebrew.yml on main once the cask is on a published release`](../../tools/package/test/release-workflow.test.mjs),
  [`takes the cask from the published release only, with no GitHub token`](../../tools/package/test/release-workflow.test.mjs),
  [`runs when a release is published, or by dispatch with a tag; never on a push or a PR`](../../tools/package/test/release-workflow.test.mjs),
  [`reads the release event nowhere but the start condition, TAG and the concurrency group`](../../tools/package/test/release-workflow.test.mjs),
  [`a published release only starts the tap push on main`](../../tools/package/test/release-workflow.test.mjs),
  [`the start step dispatches main's copy once the cask is on the published release`](../../tools/package/test/release-workflow.test.mjs),
  [`the start step refuses the tag %j before anything is fetched`](../../tools/package/test/release-workflow.test.mjs),
  [`the homebrew job runs only by dispatch, when the macOS release is enabled, here, from main`](../../tools/package/test/release-workflow.test.mjs),
  [`the failure report covers start and the push, when the macOS release is enabled, here`](../../tools/package/test/release-workflow.test.mjs),
  [`a release without the cask is an error`](../../tools/package/test/release-workflow.test.mjs),
  [`the download step refuses %s`](../../tools/package/test/release-workflow.test.mjs),
  [`checks SHA256SUMS-macos's signature against the documented identity when signing is on`](../../tools/package/test/release-workflow.test.mjs),
  [`takes the tap key from the homebrew environment`](../../tools/package/test/release-workflow.test.mjs),
  [`the tap key reaches only the push step`](../../tools/package/test/release-workflow.test.mjs),
  [`pushes Casks/vimma.rb to the tap over SSH with github.com's pinned host key`](../../tools/package/test/release-workflow.test.mjs),
  [`never replaces a newer cask with an older one`](../../tools/package/test/release-workflow.test.mjs),
  [`reads the release's metadata and never requests a release file`](../../tools/test/release-asset-checks.test.ts),
  [`starts nothing, green, when %s`](../../tools/test/release-asset-checks.test.ts),
  [`fails when the release API answers %i`](../../tools/test/release-asset-checks.test.ts),
  [`no workflow requests a release file only to see that it exists`](../../tools/test/release-asset-checks.test.ts)

- B12. The Flatpak build, `flatpak.yml` (spec [flatpak](../specs/flatpak.md)), publishes nothing,
  holds no secret and no environment, and each job's token only reads the repository. It
  **must** build a release only from the release's public download URL, which answers 404 for a
  draft, pinned to the tarball's SHA-256 in that release's `SHA256SUMS`, and with signing on
  only after `SHA256SUMS` passes `cosign verify-blob` against `IDENTITY_REGEXP`; flatpak-builder
  then refuses a tarball with any other hash. Event values reach its scripts only through `env`.
  The manifest generator accepts only a SemVer version, a lower-case SHA-256 and a bare file
  name, and its build commands are fixed strings. The build runs in a privileged container from
  the `fedora:44` image pinned by digest, on Flathub runtimes pinned by commit. A release event
  runs the tag's copy of the workflow, which has the same read-only token. The app's sandbox
  grants Firefox's Flatpak permissions and `~/.local/state/omarchy` read-only, never the home
  directory and nothing under `~/.config` but `gtk-3.0` read-only, so the Omarchy hook
  (section 7) is never installed from it. The container is privileged, since Flatpak's sandbox
  needs it inside docker, and runs the release build, which reaches the network; that is safe
  only on a GitHub-hosted runner, which every job is held to (B5). **⚠
  limit:** Fedora's packages (`flatpak`, `flatpak-builder`) are installed at their current
  versions from Fedora's signed repositories; the digest fixes only the base image.
  [`builds a published release from its download URL, checked against SHA256SUMS`](../../tools/package/test/flatpak.test.mjs),
  [`checks the release's signature against the documented identity when signing is on`](../../tools/package/test/flatpak.test.mjs),
  [`holds no secret and only reads the repository`](../../tools/package/test/flatpak.test.mjs),
  [`passes event values to run: through env only`](../../tools/package/test/flatpak.test.mjs),
  [`refuses %s`](../../tools/package/test/flatpak.test.mjs),
  [`puts no input into a build command, so none can change what the build runs`](../../tools/package/test/flatpak.test.mjs),
  [`pins the Fedora image by digest and the runtime and SDK by commit`](../../tools/package/test/flatpak.test.mjs),
  [`grants Firefox's Flatpak permissions and the Omarchy theme read-only, never the home`](../../tools/package/test/flatpak.test.mjs)
- B13. `vimma-ctl` ships inside the release packages (spec
  [ship-vimma-ctl](../specs/ship-vimma-ctl.md)). `release.yml`'s `ctl` job builds it from the
  commit `build` checked, and `macos-ctl` from the commit it checks as `build` does; `macos-build`
  **must** refuse a Mac binary built from any other commit. Both jobs **must** hold only a
  read-only token, no environment and no secret, since compiling the client needs none. The
  crate has no dependencies, so cargo downloads no crate, and the toolchain comes through the
  runner's rustup at the version `rust-toolchain.toml` pins. The binary reaches users only inside
  the packages, which `SHA256SUMS` lists and the `sign` jobs sign (B9, B10); it is never an asset
  of its own. Its notices, and on Linux its SBOM entry, come from the same jobs, after the binary is
  checked: `tools/package/ctl-notices.mjs` copies the notices from the toolchain's sysroot and
  musl's `COPYRIGHT` from the repository (pinned by SHA-256 in `tools/package/vendor/README.md`),
  and reads every version from the build, so the SBOM names what is in the binary; `package`
  checks the merged SBOM against the CycloneDX schema before it is signed.
  [`ctl builds the checked commit's vimma-ctl, static, without the build environment`](../../tools/package/test/release-workflow.test.mjs),
  [`ctl gathers vimma-ctl's notices and SBOM entry from the toolchain that built it`](../../tools/package/test/release-workflow.test.mjs),
  [`package ships vimma-ctl's notices, lists it in the SBOM and checks both`](../../tools/package/test/release-workflow.test.mjs),
  [`refuses a musl version it has no COPYRIGHT for`](../../tools/package/test/ctl-notices.test.mjs),
  [`macos-ctl builds vimma-ctl on a Mac from the commit it checked, like build`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-build signs the Mac vimma-ctl into the app, from the same commit`](../../tools/package/test/release-workflow.test.mjs),
  [`package puts vimma-ctl into every package and checks it in each`](../../tools/package/test/release-workflow.test.mjs)
- B14. A macOS release is signed with Vimma's Apple Developer ID and notarised only while the
  repository variable `MACOS_SIGNING` is `developer-id` (spec
  [macos-build](../specs/macos-build.md), decisions 23 to 28). The four Apple secrets,
  `APPLE_DEVELOPER_ID_P12` (the Developer ID Application certificate and its private key, as
  base64 PKCS #12), `APPLE_DEVELOPER_ID_P12_PASSWORD`, `APPLE_NOTARY_API_KEY` (an App Store
  Connect API key, as the JSON `rcodesign encode-app-store-connect-api-key` writes) and
  `APPLE_TEAM_ID`, **must** be secrets of the `macos-sign` environment only, and only
  `release.yml`'s `macos-notarise` job reads them. Signing is split over three jobs, each on its
  own runner, so that no program the build produced ever runs where the secrets are: the
  disk-image tools that `macos-build`'s `mach` bootstrapped (`dmg`, `hfsplus`, `newfs_hfs`),
  handed over as an artifact and not checked against a pinned hash, parse the untrusted disk image
  in `macos-unpack` and pack the signed app in `macos-pack`, neither of which holds a secret, so a
  replaced tool, or a process it leaves behind, never sees a credential. `macos-notarise` **must
  not** run any binary from an artifact: it downloads the unpacked volume only as a tar file,
  fetches rcodesign by `fetch-rcodesign.sh`, which checks its SHA-256, and runs only that and
  `tools/package/macos-sign-app.sh`, which calls rcodesign and standard system tools. It holds a
  read-only token and no OIDC permission, and checks out the commit `macos-build` built. The
  job must equal its golden copy, `tools/package/test/macos-notarise.golden.txt`, line for line
  apart from the commits its actions are pinned to, and the workflow's top-level keys and `env:`
  are fixed, so any change to a command, a step key (`shell:`, `env:`, `working-directory:`) or a
  job key (`defaults:`, `container:`) is a visible change to that file in review. Before any
  credential is written, the app is unpacked and the SHA-256 of its manifest
  (`macos-app-manifest.sh`: every path, type, executable bit and SHA-256, computed with coreutils
  and `sha256sum` only) must equal `macos-build`'s job output `manifest_sha256`, the hash of the
  manifest of the app `macos-dmg.sh` signed ad hoc there. The script refuses any name that is not
  printable ASCII before it prints anything, and the step hashes its output only when the script
  succeeded, under `shell: bash` (`-eo pipefail`) for every step of the job, so a manifest it
  stopped writing partway, which could otherwise match while hiding a subtree, is never accepted.
  Only the hash reaches this job, as a job
  output, because an artifact can be deleted and uploaded again by any job of the run with its
  `ACTIONS_RUNTIME_TOKEN`, while a job's outputs cannot be changed by another job. So a replaced
  `macos-volume` artifact, or an app a replaced unpack tool changed, is refused before any
  credential exists. A replaced `macos-signed-app` or `macos` artifact would have to carry
  Vimma's Developer ID signature, notarised, for the tag's version line, or `macos-smoke`'s
  signature, team and version checks fail. The manifest refuses any symlink, as Vimma.app has none,
  and the sign script refuses a symlink again, as well as a name rcodesign's scope syntax could
  misread (such as `:` or `@`) and an `Info.plist` whose `CFBundleExecutable` is not one plain
  file name (letters, digits, `.`, `_`, `+`, `-` and spaces, since Firefox's helpers such as
  "Vimma GPU Helper" have spaces in their names), so
  rcodesign cannot be led to read or write a file outside the bundle. The
  shell's `printf` writes the p12, its password and the key to files of mode 600 under
  `$RUNNER_TEMP`; rcodesign gets only their paths, never a secret on a command line; an
  `always()` step deletes them before the signed app is uploaded; no step echoes a secret. Before
  signing, the certificate's subject must be a Developer ID Application certificate whose team
  ID is `APPLE_TEAM_ID`. rcodesign's `--for-notarization` refuses any other certificate and a
  signature without Apple's timestamp. With `MACOS_SIGNING` set, a missing secret fails the
  release; it never falls back to an ad hoc `.dmg`. A hosted Mac then checks the published app
  with `codesign -dvv`, `spctl --assess` and `stapler validate`, and requires its team ID to be
  the repository variable `MACOS_TEAM_ID` (public in every signature, so not a secret), before
  `macos-sign` cosigns it; Gatekeeper alone would accept any team's notarised app. **⚠
  setting:** the `macos-sign` environment's only deployment policy is the branch `main`, so no
  branch or tag can run an edited workflow that reads the secrets (as in B6), and no repository
  secret of these names exists. It has no required reviewer, since a Firefox security release
  ships without a person. **⚠ limit:** whoever can merge to `main` can change `release.yml` to
  misuse the secrets, as for every other environment. **⚠ limit:** the manifest hash comes from
  the same release run as the build, so it guards against `macos-unpack`, not against a
  compromised build, which signs what it builds anyway. Nor does it catch a disk-image tool that
  is already malicious inside `macos-build`: `macos-dmg.sh` runs mach's `unpack_dmg` with the same
  tools before it writes the manifest, so the manifest describes whatever that tool produced, and
  such a tool, running inside `macos-build`, could also write the `manifest_sha256` output itself.
  **⚠ limit:** nothing pins the
  disk-image tools themselves. A replaced tool in `macos-pack` could pack a different app than
  the one notarised, which `macos-smoke`'s signature checks then fail; it could also add other
  entries to the `.dmg`, which is not signed, or point its Applications link elsewhere, and
  `macos-dmg-check.sh` checks only the art files, not that nothing else is on the volume.
  **A leaked p12** lets its holder sign any Mac software that Gatekeeper accepts as Vimma's team,
  and, with any API key of the team, notarise it, until Apple revokes the certificate. The
  response is in `docs/runbook/ci-macos-build.md`, "Developer ID signing": unset `MACOS_SIGNING` so releases go
  out ad hoc, delete the secrets, ask Apple to revoke the certificate, then issue a new one. Once
  Apple revokes it, Gatekeeper refuses software signed with it; whether Vimma releases signed
  before the leak keep opening depends on the date Apple revokes it from (**unverified**: no
  revocation has been tried). **A leaked API key** lets its holder notarise and read the team's
  notarisation history, not sign: revoke it in App Store Connect (Users and Access,
  Integrations) and create a new one. The certificate's expiry is read from the certificate
  (its `notAfter` date, or the certificate list on developer.apple.com), not assumed, and it is
  renewed as the runbook's "Rotating" paragraph says, with a reminder 60 days before that date.
  [`the Apple secrets come from the macos-sign environment, in macos-notarise alone`](../../tools/package/test/release-workflow.test.mjs),
  [`the macos-sign job runs no binary of the build: only the pinned rcodesign`](../../tools/package/test/release-workflow.test.mjs),
  [`runs rcodesign and no disk-image tool, mach, node or other program of the build`](../../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a symlink that leaves the app, before rcodesign runs`](../../tools/package/test/macos-developer-id.test.mjs),
  [`refuses every symlink, even one that stays inside the app, and an app that is a link`](../../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a file name outside [A-Za-z0-9._+ -] in a path it scopes a setting to`](../../tools/package/test/macos-developer-id.test.mjs),
  [`signs the released 0.1.10 bundle's layout, spaced helper names passed intact`](../../tools/package/test/macos-developer-id.test.mjs),
  [`refuses a CFBundleExecutable with a / or .., and a binary Info.plist`](../../tools/package/test/macos-developer-id.test.mjs),
  [`changes when a byte, an executable bit or a file name changes`](../../tools/package/test/macos-developer-id.test.mjs),
  [`macos-notarise checks the app against macos-build's manifest hash before the credentials`](../../tools/package/test/release-workflow.test.mjs),
  [`the check catches %s`](../../tools/package/test/release-workflow.test.mjs),
  [`a manifest script that stops partway never passes the hash check`](../../tools/package/test/release-workflow.test.mjs),
  [`refuses a name with a newline, a control character or a non-ASCII byte, printing nothing`](../../tools/package/test/macos-developer-id.test.mjs),
  [`%s runs only when MACOS_SIGNING is developer-id, after %s`](../../tools/package/test/release-workflow.test.mjs),
  [`writes the credentials to owner-only files and fails when one is missing`](../../tools/package/test/release-workflow.test.mjs),
  [`removes the credentials in an always() step before anything is uploaded`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke takes the ad hoc dmg only when Developer ID is off`](../../tools/package/test/release-workflow.test.mjs),
  [`macos-smoke checks the Developer ID of Vimma's team, notarisation and Gatekeeper`](../../tools/package/test/release-workflow.test.mjs),
  [`fails %s`](../../tools/package/test/macos-developer-id.test.mjs),
  [`checks the certificate is a Developer ID Application of APPLE_TEAM_ID before signing`](../../tools/package/test/macos-developer-id.test.mjs),
  [`passes the password and the API key as files, never on a command line`](../../tools/package/test/macos-developer-id.test.mjs),
  [`signs in one rcodesign run, nested code inside-out with mach macos-sign's settings`](../../tools/package/test/macos-developer-id.test.mjs),
  [`the browser gets Firefox's production entitlements without the restricted pair`](../../tools/package/test/macos-developer-id.test.mjs)

- B15. `site-dispatch.yml` (spec [site-keys-mirror](../specs/site-keys-mirror.md)) tells
  `vimma-browser/vimma-site` about a published release (`vimma-release`, never for a
  pre-release) or a change to `docs/bindings.json` on `main` (`vimma-bindings`). Its `dispatch`
  job holds the private key of the org's GitHub App `vimma-site-dispatch`, the secret
  `SITE_DISPATCH_APP_KEY` of the `site-dispatch` environment, with the app's client ID in the
  variable `SITE_DISPATCH_APP_ID`. The key **must** reach only `main`'s copy of the workflow:
  with it a token can push to `vimma-site`'s branches, and `release-sync.yml` there sets
  auto-merge on its `release-sync/<tag>` pull requests and keeps commits pushed to them by hand,
  while `vimma-site`'s `main` ruleset asks for no approval, only the `build` check. A commit
  pushed to an open release-sync branch therefore merges itself and deploys to vimma.dev.
  `dispatch` **must** declare `environment: site-dispatch` and run only for a push to `main` or a
  `workflow_dispatch` on `refs/heads/main`. Its `GITHUB_TOKEN` has no permission, it checks
  nothing out and runs no repository code. `actions/create-github-app-token`, pinned by commit
  SHA, **must** mint the token for `vimma-site` alone with `contents: write`, what the
  `repository_dispatch` endpoint requires; the token lasts an hour, and the one API call goes to
  `vimma-site`'s `dispatches`. Without the variable or the key the job fails, so a release the
  site was never told about shows as a red run. A published release runs only `start`, from the
  tag's copy of the file, which anyone with write access can edit on a tag of their own; `start` holds only `actions: write`, no environment and
  no secret, runs no repository code, and starts `site-dispatch.yml` on `main` with
  `release=true`, as `homebrew.yml` does (B11). An edited copy on a tag or branch may ask for any
  permissions and read the repository's and organisation's secrets, but gets nothing a
  write-access user cannot already get by pushing a branch: it cannot deploy to the
  `site-dispatch` environment, so it cannot reach the key. Event values, the release's tag among
  them, reach the shell only through `env`. **⚠ setting:** the `site-dispatch` environment's
  only deployment policy is the branch `main`, and the repository holds no
  `SITE_DISPATCH_APP_KEY` of its own (docs/runbook/ci-vimma-devs-keys.md, "vimma.dev's keys"). **⚠ setting:** the
  app holds only Contents read and write (with Metadata read) and is installed on `vimma-site`
  alone, so a leaked key reaches no other repository and cannot change `vimma-site`'s workflows
  (that needs the Workflows permission). **⚠ limit:** the Cloudflare Workers and Pages app builds
  `vimma-site`'s pushed branches, so a leaked key could also get a branch of its own built as a
  preview.
  [`the job that uses the key deploys to site-dispatch and runs only from main`](../../tools/test/site-dispatch-workflow.test.ts),
  [`the release event never reaches the key: start only starts main's copy`](../../tools/test/site-dispatch-workflow.test.ts),
  [`has no permission at the top level, and only start asks for one: actions: write`](../../tools/test/site-dispatch-workflow.test.ts),
  [`mints the app token for vimma-browser/vimma-site alone, with contents: write only`](../../tools/test/site-dispatch-workflow.test.ts),
  [`holds the app's key and no other secret, and no personal token`](../../tools/test/site-dispatch-workflow.test.ts),
  [`pins every action by full commit SHA and checks nothing out`](../../tools/test/site-dispatch-workflow.test.ts),
  [`sends the dispatch to vimma-site only`](../../tools/test/site-dispatch-workflow.test.ts),
  [`passes the tag and every event value to run: through env only`](../../tools/test/site-dispatch-workflow.test.ts),
  [`finds every form of run: script, so none escapes the env-only check`](../../tools/test/site-dispatch-workflow.test.ts),
  [`keeps the release event's run, a release dispatch and a bindings dispatch apart`](../../tools/test/site-dispatch-workflow.test.ts),
  [`fails without the app's ID or key instead of skipping the dispatch`](../../tools/test/site-dispatch-workflow.test.ts),
  [`never runs for a pre-release or outside vimma-browser/vimma`](../../tools/test/site-dispatch-workflow.test.ts)
- B16. The fonts in `tests/e2e/fonts/` are binary files from outside the project that a browser
  opens: the e2e harness gives them to the scenarios' browser on Linux (issue #944), and
  no package ships them. Each **must** be an unchanged copy of an upstream release (DejaVu 2.37,
  whose tarball's SHA-256 matched on GitHub and SourceForge; Liberation 2.1.5, whose font matched
  Ubuntu's package but for one glyph), and its own SHA-256 **must** be the one
  `tests/e2e/fonts/README.md` records, so a changed file fails the tests rather than reaching a
  browser unreviewed. The harness lets the content sandbox read that one folder in the
  throwaway profile only.
  [`lists every font file with the SHA-256 it has`](../../tools/e2e/test/fonts.test.ts),
  [`offers no font outside the vendored folder`](../../tools/e2e/test/fonts.test.ts),
  [`lets content processes read the pinned fonts' folder as well, when asked`](../../tools/e2e/test/launcher.test.ts)
- B17. D2 draws the two SVG pictures in `ARCHITECTURE.md` (issue #943). It is a build tool from
  outside the project (terrastruct/d2, MPL-2.0) that runs on a contributor's machine and is
  never shipped. `tools/diagrams/render.ts` **must** pin its release by version (v0.9.0) and by
  the SHA-256 of each platform's tarball, copied from the release's `SHA256SUMS`, and **must**
  check the downloaded bytes in memory before handing them to `tar` on stdin. It unpacks into a
  folder beside the cache and moves it into place, and records the binary's own SHA-256, so an
  interrupted or altered install is downloaded again rather than run. D2 **must** run only when
  a person runs `npm run diagrams`: no workflow, no other npm script, `npm ci`, lint or test
  renders. CI runs only `npm run diagrams:check`, which needs no D2 and fails on an SVG that is
  behind its source, was edited by hand, or holds a script, `foreignObject`, an event handler or
  an address other than the SVG namespaces and D2's embedded `data:` fonts.
  `VIMMA_D2=<path>` uses a binary the person chose; only the version it reports is checked.
  The SVGs embed subsets of D2's default fonts, Source Sans Pro and Source Code Pro (SIL OFL
  1.1). **⚠ limit:** the pin trusts the release that GitHub served when the sums were copied.
  [`is a fixed release, with a SHA-256 for each platform contributors use`](../../tools/diagrams/test/render.test.ts),
  [`a download whose checksum differs is refused`](../../tools/diagrams/test/render.test.ts),
  [`is unpacked aside and moved into place, with its hash recorded and checked on use`](../../tools/diagrams/test/render.test.ts),
  [`a half-unpacked cache, with no recorded hash, is not used`](../../tools/diagrams/test/render.test.ts),
  [`VIMMA_D2 of the pinned version is used, with no cache folder needed`](../../tools/diagrams/test/render.test.ts),
  [`no workflow and no npm script but diagrams renders: CI only checks`](../../tools/diagrams/test/render.test.ts),
  [`fails when an SVG was edited after the render`](../../tools/diagrams/test/render.test.ts),
  [`the committed SVGs hold none of them`](../../tools/diagrams/test/render.test.ts)
- B18. A guard that a workflow runs from the base branch (`git show "$BASE:tools/…"`: the
  docs-only classifier in ci.yml and e2e.yml, the release key guard in key-guard.yml) judges the
  pull request whose checkout it runs in, so **nothing** of that checkout may run before it. In
  such a job exactly one step runs the guard, and only `actions/checkout`, pinned by its full
  commit, comes before it, with no input but `fetch-depth` and `persist-credentials`, and no
  `run:` step of any kind: a script from the checkout, `make`,
  corepack, pnpm, bun or node by its path would each run the pull request's code, so the rule
  refuses every `run:` step rather than judging commands. Setting up a tool counts:
  `actions/setup-node` prints the versions of `npm` and `yarn` in the checkout, and a package
  manager reads its configuration, which can name a program to start, from the current
  directory, so a pull request could run its own code before the guard and change what the guard
  answers. The guard step's `run:` text is pinned exactly, so a command appended after it fails
  the test; it has no `shell:` or `working-directory:`, and its environment holds only the event
  values it reads, each pinned (`BASE` is the base commit, `HEAD`, `PR_LABELS`): `NODE_OPTIONS` or
  `BASH_ENV` would make its own node or bash load a file from the checkout. The job's keys come
  from a short allow-list (no `container:`, `services:`, `defaults:`, `env:` or
  `continue-on-error:`), and so do its workflow's (no `defaults:` or `env:`), since each changes
  how the guard step runs or what its failure means. All four guard jobs (ci.yml `check` and `vimma-ctl-macos`, e2e.yml `changes`,
  key-guard.yml) meet this with no exception. These guards therefore run on the runner image's
  own Node and stay `.mjs` (ADR-025, decision 7). The `actions/setup-node` steps that run before
  other tools, on trusted refs only, set `YARN_IGNORE_PATH`, which Yarn 1 honours, and
  `package-manager-cache: false`.
  [`nothing runs in the pull request's checkout before a guard from the base`](../../tools/test/runner-node.test.ts),
  [`refuses %s before or around a guard from the base`](../../tools/test/runner-node.test.ts),
  [`refuses a workflow-level defaults or env in a guard's workflow`](../../tools/test/runner-node.test.ts),
  [`a setup-node before a guard or a token-holding tool never caches by itself`](../../tools/test/runner-node.test.ts)
- B19. Every `actions/checkout` in a job that a pull request runs (a workflow with a
  `pull_request*`, `merge_group`, `issue_comment` or `workflow_run` trigger, or one such a
  workflow calls) **must** set
  `persist-credentials: false`. Without it the checkout writes the job's token into
  `.git/config`, where every later step reads it, and in these jobs the later steps are the pull
  request's own `npm ci`, scripts and tests; a read-only token still reads the repository and its
  API as the workflow. No step in these jobs needs the stored token: they read the history the
  checkout fetched (`fetch-depth: 0` where commitlint or a classifier needs the range), and a
  fetch of a missing commit works without credentials while the repository is public. The one
  exception is claude.yml `spec-pr`, which pushes the `claude/spec-*` branch with the checkout's
  credentials and runs only after `spec`, which only an `issues` event starts; the test checks
  that condition as well as the list.
  [`every checkout a pull request runs sets persist-credentials: false, but the listed ones`](../../tools/test/checkout-credentials.test.ts),
  [`a listed checkout runs only after a job that no pull request event starts`](../../tools/test/checkout-credentials.test.ts),
  [`follows a reusable workflow that a pull request workflow calls`](../../tools/test/checkout-credentials.test.ts)
