### macOS build (`macos.yml`)

`macos.yml` cross-compiles the Apple Silicon build on a GitHub-hosted `ubuntu-24.04` runner and
checks it on a hosted `macos-15` runner ([ADR-018](../adr/018-macos-cross-build.md), spec
[macos-build](../specs/macos-build.md)). It runs every Monday at 05:00 UTC, by hand, and on pull
requests that touch `configs/macos/`, the Vimma branding, the workflow or its scripts. It is keyless (Safe
Browsing is off by default in its builds), holds no secret and has a read-only token. Nothing in
the Linux nightly or the Linux release jobs depends on it.

The `build` job follows the release build's steps ("Full builds" above), with
`SURFER_PLATFORM=darwin` for `surfer build`, so Surfer reads `configs/macos/mozconfig`
(`--target=aarch64-apple-darwin`) and `--enable-bootstrap` fetches the macOS SDK, clang and the
disk-image tools from Mozilla. After `./mach package`, `tools/package/macos-dmg.sh` unpacks the
`.dmg`, ad hoc signs `Vimma.app` with rcodesign (`tools/package/fetch-rcodesign.sh`, pinned by
SHA-256) and packs it again. The run's artifact is
`vimma-<vimma>-firefox-<firefox>-macos-aarch64`, kept 90 days. The `smoke` job mounts it on a
Mac, runs `codesign --verify --deep --strict`, checks the binary is arm64 and the version line,
and renders a page headless; it then builds `vimma-ctl` (the weekly `.dmg` ships none) and runs
the e2e smoke scenarios `m0-happy-path` and `m0-content-actor` headless through it
(`npm run e2e -- --headless`, "End-to-end tests" above); `tools/package/macos-app-check.sh` checks its `Assets.car` has
Vimma's `AppIcon` and none of Firefox's, and that its bundle identifier is `surfer.json`'s
`appId`. `tools/package/macos-dmg-check.sh` checks the mounted volume's `.DS_Store`,
`.background/background.png` and `.VolumeIcon.icns` are the committed `dsstore`, `background.png`
and `disk.icns`, and that the volume's custom icon flag is set. The rendered icon and the page are
the run's `macos-smoke` artifact.

The `icons` job, on a hosted `macos-26` runner with Xcode 26.6 pinned, regenerates the committed
macOS icon files (`Assets.car`, `firefox.icns`, `document.icns`, and the `.dmg`'s `disk.icns`
and `background.png`, in `configs/branding/vimma/`) from `configs/branding/vimma/logo-mac.png`
and the Icon Composer source `configs/macos/AppIcon.icon/icon.json`, and fails if they differ
(spec [macos-homebrew](../specs/macos-homebrew.md), decision 13). `actool`, which compiles
`Assets.car`, ships only with Xcode, not the Command Line Tools. After changing the logo or the
icon source, either run `node tools/package/macos-icons.mjs` on a Mac with Xcode, or push and
copy the files from the run's `macos-icons` artifact, which also holds their renderings:

```sh
gh run download "$run" -n macos-icons -D /tmp/macos-icons
cp /tmp/macos-icons/{Assets.car,firefox.icns,document.icns,disk.icns,background.png} \
  configs/branding/vimma/
```

The `.dmg` window's layout, `configs/branding/vimma/dsstore`, is the `.DS_Store` Finder writes,
so no job can regenerate it byte for byte (it records dates and the disk image's location).
After changing `DMG_LAYOUT` in `tools/package/macos-icons.mjs` or the background, run
`tools/package/macos-dsstore.sh --out "$RUNNER_TEMP/dsstore"` on a GitHub-hosted `macos-15`
runner (a short-lived workflow on the branch that uploads the file as an artifact, with
`contents: read` and pinned actions, removed again before merge) and commit the downloaded file.
It lays out a scratch disk image in Finder through AppleScript, which the hosted image allows
without a prompt, and copies the `.DS_Store`. A developer's Mac is not used, because Finder
records the machine's per-user temp-dir hash and volume UUIDs in the file.
`tools/package/test/macos.test.mjs` checks that it places `Vimma.app` and the Applications link
where `DMG_LAYOUT` says, shows the background from the Vimma volume, and names no home directory.

`actool` names the catalog's flattened fallback images with a fresh UUID and writes them anew on
every run, so the check compares `assetutil --info` without those names and digests, and
without the header. A new Xcode can change the catalog: bump `DEVELOPER_DIR` and commit the
regenerated files in the same PR. The files live in `configs/branding/vimma/`, whose top-level
files Surfer's branding step copies over Firefox's, not in `src/`, whose license check needs an
MPL header in every file. On a Mac host `npm run import` overwrites `firefox.icns` there with
Surfer's own 512 px version; restore it with `git checkout configs/branding/vimma/firefox.icns`
(the package tests fail on the 512 px file).

To run it and fetch the `.dmg`:

```sh
gh workflow run macos.yml --ref main
run=$(gh run list -w macos.yml -s success -L 1 --json databaseId --jq '.[0].databaseId')
gh run download "$run" -D ~/Downloads/vimma-macos
```

The first green run (run 39205860770, Firefox 158.0 for Vimma 0.1.5, cold, no compiler cache)
took 133 minutes for `build`, 129 of them in `surfer build`, and 45 seconds for `smoke`. The
build used 44 GB of the runner's disk, the 16 GB swap file included, and left 42 GB free; the
`.dmg` is 109 MB. `timeout-minutes` is 200, about 1.5 times the job, as for the Linux builds.

#### macOS in a release

`release.yml` has six macOS jobs, which run only while the repository variable
`MACOS_RELEASE_ENABLED` is `true` (spec [macos-build](../specs/macos-build.md), decision 12):
`macos-ctl` builds `vimma-ctl` on a hosted Mac from the tag's commit (spec
[ship-vimma-ctl](../specs/ship-vimma-ctl.md)); `macos-build` builds as `macos.yml` does, from the release tag's commit and with the Safe
Browsing key, and renders the Homebrew cask `vimma.rb` for the `.dmg`
(`tools/package/cask.mjs`), with that `vimma-ctl` signed into `Vimma.app/Contents/MacOS`;
`macos-smoke` checks the `.dmg` on a hosted Mac against the tag, runs the e2e smoke scenarios
through the app's own `vimma-ctl`, and installs it through the cask (`tools/package/cask-check.sh`); `macos-sign` signs both and
`SHA256SUMS-macos` with cosign while `SIGNING_ENABLED` is `true`; `macos-publish` uploads them
to the tag's release; `macos-tap` starts `homebrew.yml` on `main` for the tag once the release
is published. Publishing a release whose macOS files are already on it starts `homebrew.yml`
too: its release event runs only a `start` job, which dispatches `main`'s copy for the tag,
because the push itself must never run from the tag (step 7 of "Release packages"). No Linux job waits for them, so the Linux files reach the
draft first, and the `.dmg` follows hours later, usually after the draft has been published.
`macos-publish` adds the macOS files to a published release that has none; if it already has
them, a re-run needs `-f replace_published=true`. A macOS failure opens the same
`release-failure` issue as a Linux one; re-running the failed jobs of the run retries only
macOS.

```sh
gh variable set MACOS_RELEASE_ENABLED --body true      # on
gh variable delete MACOS_RELEASE_ENABLED               # off
```

While the repository variable `MACOS_SIGNING` is not `developer-id`, the `.dmg` is ad hoc
signed, so Gatekeeper asks once before it first opens (docs/guide.md, "macOS"), the Homebrew cask
says so in its caveats (spec macos-homebrew), and `macos-build`'s summary and a warning say the
release is ad hoc signed and not notarised. With it, three more jobs, `macos-unpack`,
`macos-notarise` and `macos-pack`, sign the app with the Developer ID and notarise it between
`macos-build` and `macos-smoke` ("Developer ID signing" below). vimma.dev is not affected (issue #393).

To bump rcodesign: take the new release's SHA-256 for
`apple-codesign-<version>-x86_64-unknown-linux-musl.tar.gz` from
`gh release view apple-codesign/<version> -R indygreg/apple-platform-rs --json assets`, and change
`RCODESIGN_RELEASE` and `RCODESIGN_SHA256` in `fetch-rcodesign.sh` together.

#### Developer ID signing

A release is signed with Vimma's Developer ID and notarised by three jobs of `release.yml` while
`MACOS_SIGNING` is `developer-id` (spec [macos-build](../specs/macos-build.md), decisions 23 to 28;
docs/security/14-build-and-release-supply-chain.md, B14), each on its own runner so that the disk-image tools `macos-build`'s `mach`
bootstrapped never run beside the Apple secrets:

- `macos-unpack` opens `macos-build`'s ad hoc `.dmg` with those tools
  (`tools/package/macos-dmg-unpack.sh`) and uploads the volume as `macos-volume.tar`;
- `macos-notarise`, the only job in the `macos-sign` environment, unpacks the tar, refuses the
  app unless the hash of its manifest (`tools/package/macos-app-manifest.sh`) equals
  `macos-build`'s job output `manifest_sha256` (a mismatch means the unpack step changed it),
  runs
  `tools/package/macos-sign-app.sh` (one `rcodesign sign` with the hardened runtime and
  `configs/macos/entitlements/`, then `rcodesign notary-submit --wait --staple` on the app) with
  the pinned rcodesign alone, and uploads the signed app;
- `macos-pack` packs it with the volume's art (`tools/package/macos-dmg-pack.sh`), renders the
  cask without its Open Anyway caveat, rewrites `SHA256SUMS-macos` and replaces the run's `macos`
  artifact.

`macos-smoke` then runs `tools/package/macos-developer-id-check.sh` on the app:
`codesign --verify --deep --strict`, the Developer ID authority and the team ID of the repository
variable `MACOS_TEAM_ID` in `codesign -dvv` on the app and its nested code, a secure timestamp, the
`runtime` flag, `spctl --assess --type execute` answering `source=Notarized Developer ID`, and
`xcrun stapler validate`. Notarisation usually takes minutes; rcodesign waits up to an hour, and
the job stops at 75 minutes.

**Setting it up.** Once, by the Account Holder of the Apple Developer Program membership:

1. In the Apple Developer account, Certificates, Identifiers & Profiles, create a **Developer ID
   Application** certificate (the G2 sub-CA). Create the key and the signing request on your own
   machine, so the private key never leaves it until it becomes a secret:

   ```sh
   openssl genrsa -out vimma-developer-id.key.pem 2048
   rcodesign generate-certificate-signing-request --pem-file vimma-developer-id.key.pem \
     --csr-pem-file vimma-developer-id.csr.pem
   ```

   Upload the `.csr.pem`, download the `.cer`, and bundle key and certificate into a p12 with a
   long random password:

   ```sh
   openssl x509 -inform DER -in developerID_application.cer -out vimma-developer-id.crt.pem
   openssl pkcs12 -export -inkey vimma-developer-id.key.pem -in vimma-developer-id.crt.pem \
     -out vimma-developer-id.p12   # asks for the export password
   ```

   A p12 exported from Keychain Access works too. Check it before uploading:
   `rcodesign analyze-certificate --p12-file vimma-developer-id.p12 --p12-password-file p12-password.txt`
   prints `Subject CN: Developer ID Application: …` and the `Team ID`.

2. In App Store Connect, Users and Access, Integrations, App Store Connect API, create a **team
   key** with the **Developer** role. Download the `.p8` (it can be downloaded once), note its key
   ID and the issuer ID, and encode them:

   ```sh
   rcodesign encode-app-store-connect-api-key -o notary-api-key.json <issuer-id> <key-id> AuthKey_<key-id>.p8
   ```

3. Create the `macos-sign` environment (Settings, Environments) with **Deployment branches and
   tags** set to the branch `main` only, and no required reviewers, since a security release is
   unattended. Add its secrets from files, so nothing goes through the shell history:

   ```sh
   R=repos/vimma-browser/vimma
   gh api -X PUT $R/environments/macos-sign --input - <<'JSON'
   { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
   JSON
   gh api -X POST $R/environments/macos-sign/deployment-branch-policies -f name=main -f type=branch
   base64 -i vimma-developer-id.p12 | gh secret set APPLE_DEVELOPER_ID_P12 --env macos-sign
   gh secret set APPLE_DEVELOPER_ID_P12_PASSWORD --env macos-sign < p12-password.txt
   gh secret set APPLE_NOTARY_API_KEY --env macos-sign < notary-api-key.json
   gh secret set APPLE_TEAM_ID --env macos-sign --body <team-id>
   gh api $R/environments/macos-sign/deployment-branch-policies --jq '.branch_policies[].name'  # main
   gh api $R/actions/secrets --jq '.secrets[].name'   # no APPLE_* here
   ```

   The team ID is the ten characters in the certificate's name, "Developer ID Application: Name
   (TEAMID)". Then delete the local p12, `.p8`, JSON and password files, or keep them only in an
   encrypted password manager.

4. Set the team ID that `macos-smoke` requires, as a repository variable (it is printed in every
   signature, so it need not be secret), then turn signing on, and check the first release's
   three signing jobs and `macos-smoke`:

   ```sh
   gh variable set MACOS_TEAM_ID --body <team-id>
   gh variable set MACOS_SIGNING --body developer-id   # on; a missing secret now fails releases
   gh variable delete MACOS_SIGNING                    # off: releases go out ad hoc again
   ```

**Changing `macos-notarise`.** The job must equal `tools/package/test/macos-notarise.golden.txt`
apart from its pinned commits (docs/security/14-build-and-release-supply-chain.md, B14); a change to it fails the package tests
until the golden copy is changed to match, so that the review of a pull request shows every
line the job holding the Apple secrets runs. Copy the job's lines from `release.yml` without the
commit SHAs, as the test's error message shows them.

**Re-running signing.** A failed `macos-notarise` (for example Apple's notary service timing
out) is re-run with the run's failed jobs, `gh run rerun <run-id> --failed`: it takes
`macos-unpack`'s volume again, which the run keeps for a day. Once `macos-pack` has succeeded, the
`macos` artifact holds the signed `.dmg`, which `macos-dmg-unpack.sh` refuses as "already
notarised and stapled"; re-run the whole release (`gh workflow run release.yml -f tag=vX.Y.Z`)
to sign again. `rcodesign notary-log --api-key-file notary-api-key.json <submission-id>` shows Apple's
reasons for a rejection; the submission ID is in the job's log.

**Rotating.** Do not assume a fixed validity for a Developer ID Application certificate; read
its expiry from the certificate itself, with
`openssl x509 -noout -enddate -in vimma-developer-id.crt.pem` (the `notAfter` date), or from the
certificate list in Certificates, Identifiers & Profiles on developer.apple.com. Put that date in
the maintainer's calendar with a reminder 60 days before; make a new certificate as in step 1 and
replace `APPLE_DEVELOPER_ID_P12` and its password, then set the next reminder from the new
certificate's expiry. Apps signed with the old one keep
opening after it expires, since their signatures carry a secure timestamp. The API key does not
expire; rotate it by creating a new key, replacing `APPLE_NOTARY_API_KEY`, and then revoking the
old key in App Store Connect. Neither rotation needs a code change.

**If a secret leaks.** Unset `MACOS_SIGNING` first, so the next release does not use it, and
delete the secret from the environment. A leaked p12 (with or without its password): ask Apple to
revoke the certificate through Apple Developer Support, make a new one and set the secrets again.
A leaked API key: revoke it in App Store Connect, Users and Access, Integrations, and create a
new one. Open a `security` issue that says which releases were signed with the old certificate.
