### Release packages (`release.yml`, spec m6-packaging)

When release-please creates a draft release (above), its `release-build` job starts `release.yml`
on `main` with the new tag (`workflow_dispatch`). `release.yml` builds Vimma, packages it on a
hosted runner, signs, and uploads to that draft. Its `build` job builds on `ubuntu-24.04` from
freshly verified source in about 2 hours ("Full builds" above). When the maintainer publishes
the draft, `aur.yml` pushes AUR `vimma-bin`, and once the macOS files are on the published
release, `homebrew.yml` pushes the Homebrew cask (started by the publish, or by `release.yml`'s
`macos-tap` job when the macOS files land later); publishing builds nothing. **Every job of these workflows is off until `RELEASE_ENABLED` is `true`**, manual
runs included, and `homebrew.yml` also needs `MACOS_RELEASE_ENABLED`.

`release.yml` starts only by `workflow_dispatch` and only from `main`, because the alternatives
are weaker. A draft fires no `release` event, and a tag pushed with `GITHUB_TOKEN` starts no
workflow. `push: tags: v*` with the tag pushed by `RELEASE_PLEASE_TOKEN` would also start a
signed build for any hand-pushed `v*` tag, and would depend on a personal token. Calling
`release.yml` as a reusable workflow from `release-please.yml` would run the two-hour build
inside that workflow's run, holding back release-please on every push to `main` in the meantime,
and would hand the caller job every permission of every release job at once. A dispatch is the
same call as the manual re-run, so one path is exercised every time.

| Asset                                   | What                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `vimma-X.Y.Z-linux-x86_64.tar.xz`       | `./mach package`'s tarball, renamed (one `vimma/` directory)                                                                    |
| `vimma-X.Y.Z-x86_64.AppImage`           | AppImage (appimagetool 1.9.1, runtime 20251108, both pinned)                                                                    |
| `vimma_X.Y.Z_amd64.deb`                 | `/usr/lib/vimma`, `/usr/bin/vimma`, desktop file, icons                                                                         |
| `vimma-X.Y.Z-1.x86_64.rpm`              | the same layout as the `.deb`, for Fedora and openSUSE                                                                          |
| `vimma-X.Y.Z.cdx.json`                  | CycloneDX 1.6 SBOM (`tools/package/sbom.mjs`)                                                                                   |
| `PKGBUILD`                              | `vimma-bin` for Arch Linux; its only source is the tarball                                                                      |
| `SRCINFO`                               | its `.SRCINFO` (GitHub renames an asset with a leading period)                                                                  |
| `vimma-X.Y.Z-linux-x86_64.complete.mar` | the complete MAR Firefox's updater applies to a tarball install, signed with the update key (while `UPDATES_ENABLED` is `true`) |
| `SHA256SUMS`                            | checksums of the files above                                                                                                    |
| `*.sigstore.json`                       | cosign keyless bundles, one per file above (when signing is on)                                                                 |

Jobs: `build` (read-only token and the Safe Browsing key; first checks that the tag is
`vX.Y.Z` and that its commit is on `main`) → `ctl` (`vimma-ctl` from the same commit, static for
`x86_64-unknown-linux-musl`; read-only token, no secret; spec
[ship-vimma-ctl](../specs/ship-vimma-ctl.md); then `tools/package/ctl-notices.mjs` writes
`vimma-ctl-licenses/`, the notices of musl, Rust's standard library and LLVM's libunwind, from
that toolchain, and `vimma-ctl`'s SBOM entry) → `package` (AppImage, `.deb`, `.rpm`, `PKGBUILD`,
the AUR variant, checksums, each with `vimma-ctl` and `vimma-ctl-licenses/` next to `vimma`, and
the release tarball repacked with them; adds `vimma-ctl` to the SBOM and checks it against the
CycloneDX schema; installs the `.deb` and starts it headless, installs the `.rpm` with
dnf in a Fedora container and with zypper in an openSUSE container and starts it headless there
with `tools/package/rpm-smoke.sh`, and runs `makepkg -si` on the `PKGBUILD` in an Arch Linux
container with `tools/package/arch-smoke.sh`; checks the release tarball's updater with
`tools/update/check-build.mjs`, and while `UPDATES_ENABLED` is `true` builds the complete MAR
from it with a zeroed signature placeholder, `tools/update/mar.mjs build`) → `mar-sign` (calls
`update-publish.yml`, whose job of that name signs the MAR with the Cloud KMS update key; see
"Update signing keys and the update host", step 8) → `mar` (no secret: the signed MAR differs
from package's only in its signature, verifies under `configs/updater/` with `mar.mjs` and with
the build's own `signmar`, and joins `SHA256SUMS`) → `sign` (cosign; with `mar-sign`, the only
jobs with `id-token: write`) → `publish` (only job with `contents: write`; uploads to the draft by its tag
and checks that the draft is still on that tag after the notes edit) → `failure` (opens a
`release-failure` issue). `aur.yml`, on publish: `aur` (no GitHub token; the SSH key only) →
`failure`. `homebrew.yml`, on publish: `start` (`actions: write` only; starts `main`'s copy for
the tag when `vimma.rb` is on the release) → `failure`. From `main` when `start` or `macos-tap`
starts it, or by hand: `homebrew` (no GitHub token; the tap's deploy key only) → `failure`. Locally, from a mach tarball:

```sh
tools/package/fetch-appimagetool.sh /tmp/ait
# as the ctl job: rustup's pinned toolchain with the musl target (or download the job's artifact)
(cd tools/vimma-ctl && rustup target add x86_64-unknown-linux-musl &&
  cargo build --release --locked --target x86_64-unknown-linux-musl)
mkdir ctl && cp tools/vimma-ctl/target/x86_64-unknown-linux-musl/release/vimma-ctl ctl/
node tools/package/ctl-notices.mjs --target x86_64-unknown-linux-musl --binary ctl/vimma-ctl \
  --out ctl/vimma-ctl-licenses --component ctl/vimma-ctl.cdx.json
node tools/package/sbom.mjs --engine engine --out /tmp/vimma.cdx.json
node tools/package/package.mjs --tarball engine/obj-x86_64-pc-linux-gnu/dist/vimma-*.tar.xz \
  --ctl ctl/vimma-ctl --ctl-licenses ctl/vimma-ctl-licenses \
  --sbom /tmp/vimma.cdx.json --ctl-component ctl/vimma-ctl.cdx.json \
  --out dist --maintainer 'Name <email>' --appimagetool /tmp/ait/appimagetool \
  --runtime /tmp/ait/runtime-x86_64 --no-deb   # dpkg-deb only exists on Debian/Ubuntu
node tools/package/validate-sbom.mjs dist/vimma-*.cdx.json
tools/package/arch-smoke.sh dist "$(node tools/release/version-line.mjs)"   # needs docker
tools/package/rpm-smoke.sh dist "$(node tools/release/version-line.mjs)"    # needs docker
```

`package.mjs` builds the `.rpm` with `rpmbuild` (on Arch, the `rpm-tools` package; on
Debian and Ubuntu, `rpm`); without it, pass `--no-rpm`. `rpmbuild` reads the binaries'
requirements as sonames, which Fedora and openSUSE both provide, and the spec it is given keeps
the libraries Vimma bundles out of them (spec [rpm-package](../specs/rpm-package.md)).

`tools/package/arch-smoke.sh --stub` runs the same Arch Linux check on a stub tarball in about
half a minute; the `pkgbuild.yml` workflow runs it on every change to `tools/package/`, and its
`rpm` job runs `tools/package/rpm-smoke.sh --stub`, the Fedora and openSUSE check on a stub
`.rpm`, which needs `rpmbuild` on the host as well as docker. Its
`cask` job does the same for the Homebrew cask on a hosted Mac with
`tools/package/cask-check.sh --stub`: `brew style`, `brew audit --cask --strict`, then
`brew install --cask` of a stub `.dmg` and `brew uninstall --zap`. The install check refuses to
run outside GitHub Actions, because `--zap` deletes `~/Library/Application Support/Vimma`; on a
Mac, `tools/package/cask-check.sh <vimma.rb>` runs only the style and audit checks. The script
puts the cask in a throwaway local tap, `vimma-check/local`. Homebrew 6.0 and later refuse to load
a cask from a third-party tap that is not trusted, `brew audit` included, so on a Homebrew that has
`brew trust` the script runs `brew trust --cask vimma-check/local/vimma`, and at the end removes
the trust with `brew untrust` before it removes the tap: Homebrew keeps the trust in its
`trust.json`, apart from the tap, so `brew untap` alone would leave it. It never trusts a whole tap or sets `HOMEBREW_NO_REQUIRE_TAP_TRUST`, which
would turn the check off for every tap on the machine. When a run fails with "Refusing to load
cask ... from untrusted tap", the trust step did not run: check that `brew commands --quiet` on
that Homebrew lists `trust`.

**The two `PKGBUILD`s.** `package.mjs` writes one `vimma-bin` PKGBUILD in two variants that
differ in one line, the install source it records in `/opt/vimma/is-packaged-app`:
`dist/PKGBUILD` (`vimma-package=pkgbuild-release`) is the release asset that Arch users
download with `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO
…/releases/latest/download/PKGBUILD && makepkg -si` (guide,
"Arch Linux"), and `dist/aur/PKGBUILD` (`vimma-package=aur`) is what goes to the AUR. `aur.yml`
runs after the build's artifacts may have expired, so it makes that variant again from the
published release's `PKGBUILD` by switching the one install-source line, and pushes it with the
release's `SRCINFO` (both variants share one); a test checks that the result equals
`dist/aur/PKGBUILD`. The desktop file and `vimma-open` are written inline in `package()`, so
neither needs another file.

**Enable it (one time):**

1. Hosted build: done ([#224](https://github.com/vimma-browser/vimma/issues/224), "Full builds"
   above); the `build` job runs on `ubuntu-24.04`.
2. Trigger: nothing to set. `release-please.yml`'s `release-build` job starts `release.yml`
   with `GITHUB_TOKEN`. The maintainer's publish, from a personal account, starts `aur.yml`.
3. Safe Browsing key: the `SAFEBROWSING_API_KEY` secret of the `build` environment ("Google
   Safe Browsing key" above);
   the `build` job fails without it, and its smoke check fails a build that lacks the key.
4. Maintainer line for the `.deb`, the `.rpm` (its `Packager`) and the PKGBUILD:
   `gh variable set PACKAGE_MAINTAINER --body 'Your Name <you@example.org>'` (public in every
   package; the `package` job fails without it).
5. Signing (recommended: keyless, no key to keep): `gh variable set SIGNING_ENABLED --body true`.
   Each signature records `vimma-browser/vimma`'s `release.yml` at `refs/heads/main` in the
   public Rekor log.
   Without the variable, `sign` is skipped and the assets go up unsigned.
6. AUR (optional; `aur.yml` is skipped with a notice until the secret exists). Arch users do
   not need it: the release's `PKGBUILD` installs Vimma without the AUR, and the `aur` job stays
   dormant until an AUR account and its key exist. The AUR does not accept new account
   registrations at the moment, so this step waits until it does; the setup below is for then:
   - Check the name is free: `curl -s 'https://aur.archlinux.org/rpc/v5/info?arg[]=vimma-bin'`
     must say `"resultcount":0` (and look at `vimma` too, which `vimma-bin` provides).
   - Create an account at <https://aur.archlinux.org/register>.
   - Make a key for the workflow only: `ssh-keygen -t ed25519 -N '' -C vimma-release -f aur_key`;
     paste `aur_key.pub` into My Account → SSH Public Key.
   - Store the key in the `aur` environment, which only `main` and `v*` tags may use, so no
     workflow on another branch can read it (the `aur` job names that environment):

     ```sh
     R=repos/vimma-browser/vimma
     gh api -X PUT $R/environments/aur --input - <<'JSON'
     { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
     JSON
     gh api -X POST $R/environments/aur/deployment-branch-policies -f name=main -f type=branch
     gh api -X POST $R/environments/aur/deployment-branch-policies -f name='v*' -f type=tag
     gh secret set AUR_SSH_KEY --env aur < aur_key
     ```

     Then delete `aur_key`. The first push creates `vimma-bin`; its maintainer is that account.
7. Homebrew tap (optional; `homebrew.yml` is skipped with a notice until the secret exists, and
   runs only while `MACOS_RELEASE_ENABLED` is `true`). Mac users can install the release's `.dmg`
   without it. `homebrew.yml` pushes the published release's `vimma.rb` to
   [vimma-browser/homebrew-tap](https://github.com/vimma-browser/homebrew-tap) as
   `Casks/vimma.rb`, so `brew install --cask vimma-browser/tap/vimma` finds it. The tap is set
   up; to recreate it, or to rotate its key:
   - The repository: `gh repo create vimma-browser/homebrew-tap --public --add-readme`. Homebrew
     maps `vimma-browser/tap` to this name.
   - A ruleset on `main`: no deletion, no force push, changes only by pull request. Deploy keys
     bypass it, so the workflow's key pushes directly; admins bypass it only through a pull
     request, so nobody else changes a cask unreviewed:

     ```sh
     gh api -X POST repos/vimma-browser/homebrew-tap/rulesets --input - <<'JSON'
     { "name": "main", "target": "branch", "enforcement": "active",
       "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
       "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" },
         { "type": "pull_request", "parameters": { "required_approving_review_count": 0,
           "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false,
           "require_last_push_approval": false, "required_review_thread_resolution": false } } ],
       "bypass_actors": [ { "actor_type": "DeployKey", "bypass_mode": "always" },
         { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" } ] }
     JSON
     ```

   - The tap's check, `.github/workflows/check.yml` in the tap: `brew style` and an offline
     `brew audit --cask --strict` on `macos-15`, on every pull request and every push to `main`:
     the checks `tools/package/cask-check.sh` runs here, but on the latest stable Homebrew and
     the whole tap, so a new Homebrew audit rule can turn the tap red before the `cask` job here. It is not a required check in the ruleset, so
     `homebrew.yml`'s push lands first and the check then runs on it. When it fails on `main`,
     the pushed cask came from a release: fix `tools/package/cask.mjs` here and ship a fixed
     release, since `homebrew.yml` never replaces a newer cask with an older one. Its one action,
     `Homebrew/actions/setup-homebrew`, is pinned by commit SHA with its tag in a comment, and
     the tap has no Dependabot: bump it by hand from Homebrew's releases.

   - The tap's Actions settings, as for this repository ("Actions settings", above), which an
     administrator applies: `sha_pinning_required`, so GitHub refuses any action not pinned to
     a full commit SHA, and fork pull request approval `all_external_contributors`, so a fork's
     own workflow files run only once a person approves the run (docs/security/14-build-and-release-supply-chain.md, B11):

     ```sh
     gh api -X PUT repos/vimma-browser/homebrew-tap/actions/permissions \
       -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
     gh api -X PUT repos/vimma-browser/homebrew-tap/actions/permissions/fork-pr-contributor-approval \
       -f approval_policy=all_external_contributors
     ```

   - A key for the workflow only, with write access to the tap and nothing else:

     ```sh
     ssh-keygen -t ed25519 -N '' -C vimma-homebrew-tap -f tap_key
     gh repo deploy-key add tap_key.pub -R vimma-browser/homebrew-tap --allow-write \
       --title 'vimma release (homebrew.yml)'
     ```

   - The `homebrew` environment, which only `main` may use, holds the key (the `homebrew` job
     names that environment). No tag may deploy to it, by the rule in docs/security/14-build-and-release-supply-chain.md (B6): a
     tag ruleset restricts moving a tag, not creating one, so anyone with write access could tag
     an unmerged commit whose `homebrew.yml` skips every check and pushes any cask. For the same
     reason the `homebrew` job runs only by `workflow_dispatch`: a release event's run uses the
     tag's copy of the file, so it runs only `start`, which holds no secret and starts `main`'s
     copy:

     ```sh
     R=repos/vimma-browser/vimma
     gh api -X PUT $R/environments/homebrew --input - <<'JSON'
     { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
     JSON
     gh api -X POST $R/environments/homebrew/deployment-branch-policies -f name=main -f type=branch
     gh secret set HOMEBREW_TAP_SSH_KEY --env homebrew < tap_key
     ```

     Then delete `tap_key`. To rotate: make a new key, add it as above, set the secret again,
     then remove the old key (`gh repo deploy-key list -R vimma-browser/homebrew-tap`, then
     `gh repo deploy-key delete <id> -R vimma-browser/homebrew-tap`). Each push is a commit
     `vimma X.Y.Z` by `PACKAGE_MAINTAINER`. Retry for a published release:
     `gh workflow run homebrew.yml -f tag=vX.Y.Z`.
8. Enable: `gh variable set RELEASE_ENABLED --body true` (disable: `gh variable delete
RELEASE_ENABLED`). Try it on the next release. For the macOS `.dmg` as well:
   `gh variable set MACOS_RELEASE_ENABLED --body true` ("macOS in a release", below).
9. Recommended: a tag ruleset (Settings → Rules → Rulesets → New tag ruleset, target
   `refs/tags/v*`, rules "Restrict updates" and "Restrict deletions", no bypass), so a release
   tag cannot be moved once release-please has created it. `release.yml` builds the commit the
   tag named when its build started and refuses to publish if the tag has moved since; the
   ruleset stops the move itself.

Release jobs cannot be started from a fork, and a manual run of `release.yml` does nothing
unless started from `main`, nor for a tag whose commit is not on `main`. It uploads only to a
draft: builds are not bit-for-bit reproducible, so new files under a published release would no
longer match the `PKGBUILD` the AUR has or a `SHA256SUMS` users saved. To replace a published
release's files anyway, run it with `-f replace_published=true`, then re-run `aur.yml` for that
tag (and `homebrew.yml`, when the macOS files were replaced). The release build uses its own fresh objdir (`engine/obj-release`) and an empty sccache
directory, so nothing left by a nightly or another job reaches signed binaries.

**Verify a release** (the user guide's "Installing" points here):

```sh
v=0.1.1
gh release download "v$v" -R vimma-browser/vimma
sha256sum -c SHA256SUMS              # every file OK
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/vimma-browser/vimma/\.github/workflows/release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS                         # "Verified OK"
```

A release with the macOS `.dmg` lists it and the Homebrew cask `vimma.rb` in
`SHA256SUMS-macos`, signed the same way: run the two checks again with `SHA256SUMS-macos` in place of `SHA256SUMS` (on a Mac,
`shasum -a 256 -c SHA256SUMS-macos`).

The identity accepts only this repository's `release.yml` run from `main`: `release.yml` starts
only by `workflow_dispatch` and refuses any other branch, and every signed release, `v0.1.1`
included, was signed so.
The issuer pins GitHub Actions' OIDC. Checking `SHA256SUMS`'s signature and then `sha256sum -c`
covers every file; each asset also has its own `<file>.sigstore.json`, verified the same way.
The regexp is `IDENTITY_REGEXP` in `tools/package/package.mjs`, and a test keeps the two equal.

**What the maintainer sees on a release** (from `0.1.2` on):

1. Merge the release PR `chore(main): release 0.1.2`. Within a minute, `release-please.yml`
   creates the tag `v0.1.2` and a draft release, `release-title` titles it
   `Vimma 0.1.2 · Firefox <version>`, and `release-build` shows "Started release.yml for v0.1.2"
   in its summary.
2. Actions → `release` has a new `workflow_dispatch` run on `main`, titled `release`. It takes
   a little over two hours (2 h 12 min for `v0.1.1`). The draft has no files until its `publish` job, near the end,
   uploads them all and edits the notes: an "Updating" section goes above the changelog and the
   third-party notice below it, each once (a re-run finds the heading). Both come from
   `tools/package/package.mjs` (`dist/notes/`). The update steps are there on every release,
   with or without macOS: the Mac update notice of 0.1.6 shows a Linux command and links to these
   notes, and the macOS jobs upload the `.dmg` after this edit.
3. When the run is green, the draft lists the tarball, AppImage, `.deb`, `.rpm`, SBOM, `PKGBUILD`,
   `SRCINFO`, `SHA256SUMS` and, with signing on, a `.sigstore.json` for each. Optionally check
   them as in "Verify a release" (above), with `gh release download v0.1.2` (it finds drafts).
4. Publish: Releases → the draft → Edit → "Publish release". Nothing is rebuilt; `aur.yml` runs
   for a minute and pushes `vimma-bin` (or logs a notice while `AUR_SSH_KEY` is unset).
   `homebrew.yml` pushes the cask to the tap without a hand step: if the macOS files were
   already on the draft, publishing starts it; if they reach the published release later,
   `release.yml`'s `macos-tap` job starts it then. Either way it runs from `main`. To retry, or
   if the tap still shows the previous version: `gh workflow run homebrew.yml -f tag=v0.1.2`.

Publish only after `release` is green: a draft published earlier is public without its files
until the build finishes, and `aur.yml` fails on the missing files (re-run it afterwards).

**If the build does not start** (no `release` run a few minutes after the draft appears): look
at the `release-please` run of the merge. `release-build` is skipped when `RELEASE_ENABLED` is
not `true` or no release was created, and fails if the dispatch is refused. Then start it by
hand, from `main`; it is the same call:

```sh
gh workflow run release.yml -R vimma-browser/vimma --ref main -f tag=v0.1.2
gh run list -R vimma-browser/vimma -w release.yml -L 1   # the new run
```

If the draft has lost its tag (`gh release view v0.1.2` does not find it, and the releases list
shows `untagged-…`), reattach it first, as in "Releases" above, so the upload finds it.

**When it fails:** a `release-failure` issue links the run, while the release is still a draft. Fix
on `main`, then re-run for the same tag. The tag is not deleted: release-please has already moved
its manifest and changelog past it, and the release notes stay valid. If the fix changes what is
built, release a patch version instead. A manual run, `gh workflow run release.yml -f tag=vX.Y.Z`,
runs the workflow file from `main` (the jobs refuse any other branch) but checks out and builds
the tag's source: a fix to the workflow file reaches the re-run, while a fix to the source or to a
script under `tools/` does not, and needs a patch release (leave the failed draft unpublished;
delete it once the patch release is out). An `aur.yml` failure also opens the issue; re-run it
with `gh workflow run aur.yml -f tag=vX.Y.Z`. That manual run uses `main`'s `aur.yml`, while the
run started by publishing uses the `aur.yml` at the release's tag, so a fix to `aur.yml` reaches
an already tagged release only through the manual run. A `homebrew.yml` failure opens it as
well, a failed `start` on publish included; re-run it with `gh workflow run homebrew.yml -f tag=vX.Y.Z`, which, like every run of it,
uses `main`'s `homebrew.yml`. To pull a bad release: `gh release edit vX.Y.Z --draft`
(hides it); the AUR package cannot go back a version without an `epoch`, and `homebrew.yml`
never replaces a newer cask in the tap with an older one, so ship a fixed release instead.
