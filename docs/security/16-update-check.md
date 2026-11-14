## 16. Update check (`updates/VimmaUpdates.sys.mjs`, `update-publish.yml`, the MAR in `release.yml` and `nightly.yml`)

Spec: [m6a-updater](../specs/m6a-updater.md) (delivery 1) and [update-notices](../specs/update-notices.md).
Vimma fetches one signed manifest from `updates.vimma.dev` every 12 hours, at startup when a check
is due, and on `:update`, and tells the status bar, about:vimma and, once per version, a short
message whether a newer release exists; a security release also asks once per session whether
to show the update command, and once it is installed, whether to restart (UP11). Only the AppImage installs anything: it replaces its own file with
the offered AppImage (UP10); every other install downloads and installs nothing, except a tarball
built with Firefox's updater (UP12), which Firefox's own check and download update through
Vimma's hook (UP13). Who can reach it: whoever
controls the update host or the network path (TLS stops the path), _you_ through `about:config`
and `config.toml`, and the control socket's full role (`app.update_check` and `app.restart`, as
it can run `app.quit`). The agent role reaches no action, so a local AI agent can neither trigger
a check nor restart Vimma.
_Pages_ and _extensions_ cannot reach it.

- UP1. A manifest is accepted **only** when its signature (RSASSA-PKCS1-v1_5, SHA-384, over
  `vimma-update-xml-v1\n` and the file) verifies under a key pinned in the build
  (`core/update-keys.mjs`); keys from the pref `vimma.update.testKeys` count only when
  `Cu.isInAutomation`. An unsigned, altered or otherwise signed manifest offers nothing, and a
  build with no pinned key refuses every manifest.
  [`a key that is not pinned is refused, even with a valid signature`](../../packages/vimma-core/test/updates.test.mjs),
  [`one flipped byte in the body fails`](../../packages/vimma-core/test/updates.test.mjs),
  [`a signature over the body without the domain prefix fails`](../../packages/vimma-core/test/updates.test.mjs),
  [`no pinned key at all refuses every manifest (before the key ceremony)`](../../packages/vimma-core/test/updates.test.mjs),
  [`every pinned key is an RSA-4096 SPKI whose id matches, one per slot`](../../packages/vimma-core/test/updates.test.mjs),
  [`a signature made as Cloud KMS makes it (raw PKCS#1 over a SHA-384 DigestInfo) verifies`](../../packages/vimma-core/test/updates.test.mjs),
  [`refusals_show_after_three_in_a_row`](../../tests/browser/browser_vimma_update_check.js)
- UP2. A verified manifest is **never** accepted for another channel or platform, with a serial
  older than one this profile accepted or than the running build's ID (replay), or with a serial
  more than a day ahead of the clock, and an older or equal build, or the Vimma version that is
  already running, is **never** offered (downgrade). A release build **must** carry one build ID
  in its binary and its `application.ini` (the manifest's source): release.yml and nightly.yml fix
  `MOZ_BUILD_DATE` and fail a package whose two differ. Withholding updates or serving an old
  manifest for long is what a compromised host can still do; the feed's age shows after 45 days
  (7 for nightly).
  [`channel and target mismatches are refused`](../../packages/vimma-core/test/updates.test.mjs),
  [`replay: a serial below the one accepted, or below this build, is refused; equal is accepted`](../../packages/vimma-core/test/updates.test.mjs),
  [`downgrade: an older or equal build is no offer, not an error`](../../packages/vimma-core/test/updates.test.mjs),
  [`the Vimma version already running is no offer, whatever its build ID`](../../packages/vimma-core/test/updates.test.mjs),
  [`the_vimma_version_running_is_never_offered`](../../tests/browser/browser_vimma_update_check.js),
  [`a packaged build ID that differs from the binary's is a problem`](../../tools/release/test/build-id.test.mjs),
  [`release.yml's Linux and macOS builds fix MOZ_BUILD_DATE before they build`](../../tools/package/test/release-workflow.test.mjs),
  [`a release feed older than 45 days and a nightly one older than 7 are stale`](../../packages/vimma-core/test/updates.test.mjs),
  [`replay_is_refused_and_downgrade_offers_nothing`](../../tests/browser/browser_vimma_update_check.js),
  [`a serial more than a day ahead of the clock is refused; up to a day is accepted`](../../packages/vimma-core/test/updates.test.mjs),
  [`a_serial_from_the_future_is_refused`](../../tests/browser/browser_vimma_update_check.js)
- UP3. A check **never** sends cookies, a referrer, the user's languages or anything that
  identifies the install: the request is an anonymous, uncached GET with an empty
  `Accept-Language` whose URL may carry only the platform and the update channel
  (`%BUILD_TARGET%`, `%CHANNEL%`), over https (plain http only in automation), and it **never**
  follows a redirect. Its other headers are Necko's, the same for every install of a build.
  [`newer_build_is_offered_and_the_request_is_anonymous`](../../tests/browser/browser_vimma_update_check.js),
  [`the_url_may_name_only_platform_and_channel`](../../tests/browser/browser_vimma_update_check.js),
  [`redirects_are_not_followed`](../../tests/browser/browser_vimma_update_check.js),
  [`ask updates.vimma.dev with the platform and channel only`](../../tools/branding/test/branding-prefs.test.ts)
- UP4. With `[updates] check = false` or `vimma.update.enabled` = `false`, and in a build run from
  its objdir, Vimma **never** makes an update request, and shows no update message or question.
  A `config.toml` with errors **never** turns checks on past an opt-out it may state: a
  `check = false` still readable in it holds, and while `[updates] check` cannot be read
  (the file cannot be read or its TOML does not parse; `updates` is not a table; `check` is not
  a boolean; `[updates]` has other keys but no `check`; the file has a top-level key Vimma does
  not know, such as `[update]`; or a boolean `check` sits in another table) and only the
  defaults stand in for the file, no check runs but `:update`, which the pref still stops. A
  file that parses applies its `check` as a valid file would. Apart from
  `:update`, an attempt that got no answer is **never** repeated within 10 minutes, so restarts
  send no burst of requests.
  [`off_by_pref_or_config_sends_nothing`](../../tests/browser/browser_vimma_update_check.js),
  [`nothing_at_all_with_checks_off`](../../tests/browser/browser_vimma_update_notices.js),
  [`checks off or a source build: never due`](../../packages/vimma-core/test/update-notices.test.mjs),
  [`a failed attempt does not count as a check, but is not retried within 10 minutes`](../../packages/vimma-core/test/update-notices.test.mjs),
  [`startup_checks_when_due_and_not_when_fresh`](../../tests/browser/browser_vimma_update_notices.js),
  [`a_source_build_checks_nothing`](../../tests/browser/browser_vimma_update_check.js),
  [`a_config_with_errors_still_turns_checks_off`](../../tests/browser/browser_vimma_update_check.js),
  [`a file with errors: a readable check = false holds; else the config in force, or held`](../../packages/vimma-core/test/updates.test.mjs),
  [`a file that parses but has errors checks as a valid file would (#741)`](../../packages/vimma-core/test/updates.test.mjs),
  [`:update runs while checks are held, never past a stated opt-out`](../../packages/vimma-core/test/updates.test.mjs),
  [`an opt-out under a misspelt or misplaced table may mean check = false`](../../packages/vimma-core/test/updates.test.mjs),
  [`an_opt_out_under_a_misspelt_table_never_turns_checks_on`](../../tests/browser/browser_vimma_update_check.js),
  [`a_config_that_parses_with_errors_still_checks`](../../tests/browser/browser_vimma_update_check.js),
  [`update_runs_while_checks_are_held`](../../tests/browser/browser_vimma_update_check.js)
- UP5. A response is read **only** up to 256 KiB, counted after decompression: a larger
  `Content-Length` is refused unread, and a longer body or a compression bomb is cancelled at the
  cap. Manifest text is parsed **only** after its signature verifies, and only in the one format
  the release pipeline writes: at most 64 KiB, no DTD or entity declarations, at most one
  `<update>`. The commands about:vimma shows are built from a SemVer version and shell-quoted
  paths, never from free text in the manifest; a saved result (the pref `vimma.update.last`) is
  checked the same way when read back.
  [`an_oversized_or_compressed_bomb_response_is_refused`](../../tests/browser/browser_vimma_update_check.js),
  [`an oversized manifest is refused before any crypto`](../../packages/vimma-core/test/updates.test.mjs),
  [`shellQuote leaves plain paths alone and quotes the rest`](../../packages/vimma-core/test/updates.test.mjs),
  [`tarball: quit, download and check it, then unpack over the install's parent, quoted`](../../packages/vimma-core/test/updates.test.mjs),
  [`a pinned key that is not a valid SPKI refuses, never throws`](../../packages/vimma-core/test/updates.test.mjs),
  [`a_damaged_saved_result_is_dropped_not_thrown`](../../tests/browser/browser_vimma_update_check.js)
- UP6. A package manager's install (the `.deb`, the `.rpm`, the release `PKGBUILD`, the AUR's
  `vimma-bin`)
  is **never** told to unpack a tarball over its install directory: every package except the
  tarball carries the `is-packaged-app` marker with its package type, the release refuses a
  `./mach package` tarball that already has one, and only an install without a marker gets the
  tarball's command. The release workflow's smoke test checks the type of the installed `.deb`
  and, without `$APPIMAGE`, of the extracted AppImage, the marker of the `.rpm` installed on
  Fedora and openSUSE, and that the tarball has no marker.
  [`every package type except the tarball carries the marker`](../../tools/package/test/package.test.mjs),
  [`gives each package type its own update hint, and only the tarball an untar`](../../tools/package/test/package.test.mjs),
  [`a tarball that already carries an install-source marker`](../../tools/package/test/package.test.mjs),
  [`the .deb and AppImage smoke test checks each install type, and the tarball's lack of one`](../../tools/package/test/release-workflow.test.mjs),
  [`checks the version line, the marker, the launcher, the desktop file and rpm -V`](../../tools/package/test/rpm-smoke.test.mjs)
  On macOS ([macos-homebrew](../specs/macos-homebrew.md) decisions 8 and 19) no install is told to
  download or unpack anything: the app at `/Applications/Vimma.app` with
  `/opt/homebrew/Caskroom/vimma/` present gets `brew upgrade --cask vimma`, and any other copy
  gets no command, only the release page, since a `.dmg` that `curl` fetches carries no
  quarantine flag and so would skip Gatekeeper's check. Nothing is written into the bundle.
  **⚠ limit:** Vimma 0.1.6 on a Mac calls itself a tarball install and shows the Linux tarball
  command for a macOS offer, without a hash (the macOS manifest names no tarball); the guide
  tells those users not to run it (decision 21).
  [`homebrew: brew upgrade --cask vimma (macos-homebrew decision 8)`](../../packages/vimma-core/test/updates.test.mjs),
  [`dmg: the release page and the drag, with no command (macos-homebrew decision 19)`](../../packages/vimma-core/test/updates.test.mjs),
  [`a Caskroom and an /Applications path change nothing on Linux`](../../packages/vimma-core/test/updates.test.mjs),
  [`macos_installs_get_their_own_steps`](../../tests/browser/browser_vimma_update_check.js)
  The Flatpak ([flatpak](../specs/flatpak.md) decision 10; marker `vimma-package=flatpak`) gets
  only `flatpak update dev.vimma.browser`, in `:update`, the security question's steps and the
  one-time message, a fixed string with no part taken from the manifest (the message adds only
  the verified offer's version, as for every install):
  its `/app` is read-only and Flathub's build, not the release's files, is what it runs. The
  marker outranks `$APPIMAGE`, which a Flatpak started from an AppImage's process inherits, so a
  Flatpak is never handed the AppImage's replacement (UP10).
  [`flatpak: flatpak update, with no download (spec flatpak, decision 10)`](../../packages/vimma-core/test/updates.test.mjs),
  [`is flatpak, whose update hint is flatpak update, never the tarball's unpack`](../../tools/package/test/flatpak.test.mjs),
  [`flatpak_gets_flatpak_update`](../../tests/browser/browser_vimma_update_check.js),
  [`a Flatpak names flatpak update, for an ordinary and a security release`](../../packages/vimma-core/test/update-notices.test.mjs),
  [`not an AppImage install: nothing to replace`](../../packages/vimma-core/test/appimage-update.test.mjs),
  [`a_flatpak_is_told_to_run_flatpak_update`](../../tests/browser/browser_vimma_update_notices.js)

- UP7. A manifest is **only** signed by `update-publish.yml` run from `main`, and **only** for a
  release that is published (not a draft or a pre-release) and whose tag is on `main`, or as an
  empty manifest that offers nothing. Publishing a release starts a job that, as `main` has it,
  holds only `actions: write` and runs no repository code; it starts the workflow again on
  `main`, so the file that signs is always `main`'s, never a tag's. That job runs the tag's copy
  of the file, which anyone with write access can edit on a tag of their own: an edited copy may
  ask for any permissions and read the repository's and organisation's secrets, but it gets
  nothing a write-access user cannot already get by pushing a branch. It cannot deploy to the
  `update-signing` or `update-publish` environment, so it cannot reach the signing key or the
  deploy key. The signing job is the **only** job with
  `id-token: write`, uses the `update-signing` environment (deployment branch `main` alone), and
  runs no repository code: it checks the body's shape with the shell, signs the SHA-384
  DigestInfo with Cloud KMS and checks the signature with openssl. Before any pattern, it refuses
  a body with a byte that is not printable ASCII or a newline, or that does not end in a newline,
  because GNU grep may end a line at a NUL byte in a file it takes for binary, and a line check
  alone would then pass a body that hides another target or URL behind one. The job that builds the body
  holds no secret and installs no dependency. Before anything is pushed, a separate job checks
  the signed file with the verifier and the pinned key the browser uses and with openssl. Every
  file named in the manifest **must** match the release's `SHA256SUMS`, which **must** carry
  release.yml's cosign signature (an unsigned release gets no manifest), and is downloaded again after
  signing and checked against the signed size and SHA-512. A serial that is not newer than the
  published manifest's, a serial more than a day ahead of the clock, and an offer older than the
  published one are refused. The urgency comes from the labels of each commit's pull request;
  a label read that fails transiently (an HTTP 5xx, a body that is not JSON, a network error) is
  tried four times in all, 2, 4 and 8 s apart, and a commit whose labels still cannot be read
  **must** fail the run, never count as unlabelled, so a security release is never published as
  a normal one. The responses are parsed as raw JSON in `manifest.mjs`, not through jq, and their
  shape is checked: a pulls response that is not a list of pull requests, each with a list of
  labels with string names, fails the run (jq would read `{}` as no labels), and so does a
  releases list that does not contain the tag being published (such a list is malformed or cut
  short, and counting from it could widen the range of commits to the whole history; a wider
  range can only raise the urgency, but costs a label read per commit). The push uses a deploy key that can write only to
  `vimma-updates`, kept in the `update-publish` environment (deployment branch `main` alone),
  reached only by the push step, to a pinned github.com host key, and **never** forced; nothing is
  pushed unless `UPDATES_ENABLED` is `true`. **⚠ setting:** the environments' branch rules and the
  Workload Identity condition on `job_workflow_ref` (docs/runbook/ci-update-keys-and-update-host.md, "Update signing keys and
  the update host", step 7) are what keep another branch or workflow away from the key; the
  workflow's own `refs/heads/main` guard only stops accidental runs. The signing job also
  refuses a serial outside the last hour, and a dry run's real signature is kept one day, as a
  workflow artifact any signed-in GitHub user can download.
  The macOS manifest (`Darwin_aarch64-gcc3`, [macos-homebrew](../specs/macos-homebrew.md) decisions
  16 to 18) is signed by the same jobs, key and environments, from the workflow's `target` input:
  its one file, the `.dmg`, **must** match `SHA256SUMS-macos`, which **must** carry release.yml's
  cosign signature, and is checked against it before the secretless `prepare` job (on a macOS
  runner) mounts it read-only to read its build ID; the signing job refuses a body for another
  target than the one asked for. The macOS run starts once the `.dmg` is on the published
  release, which the starting jobs learn from the release's metadata as in B11; `prepare` then
  checks again that the release is published and downloads the `.dmg` itself. Each target has its own concurrency group, so its serials only
  grow; a push that the other target's push beat is rebased onto it (another file), never forced.
  The nightly channel's manifest (`…/vimma-nightly/update.xml`, [m6a-updater](../specs/m6a-updater.md)
  decisions 42 and 43) is signed by the same key and environments, by `nightly-prepare`,
  `nightly-sign` and `nightly-publish`, which run **only** in `nightly.yml`'s call from `main`
  (`github.workflow_ref`) and only while `UPDATES_ENABLED` and `NIGHTLY_RELEASE_ENABLED` are
  `true`. Before any pattern, `nightly-sign` runs the signing job's byte check, the same shell
  text: it refuses a body with a byte that is not printable ASCII or a newline, or that does not
  end in a newline, and refuses when grep fails, since a line check alone would pass a body that
  hides another channel or URL behind a NUL byte. `nightly-prepare` holds no secret; it requires the `nightly` release to be a public
  pre-release, checks its `SHA256SUMS` against `nightly.yml`'s cosign identity (never
  `release.yml`'s, so neither channel's sums can stand in for the other's), checks that the MAR
  verifies under the committed certificates on the channel `vimma-nightly`, and that the
  tarball's `application.ini` names the build asked for. `nightly-sign` runs no repository code
  and signs only the seven lines a nightly manifest for that build has: the channel
  `vimma-nightly`, the Linux target, a serial within the last hour, a `normal` offer of
  `X.Y.Z-nightly.<buildID>`, one `<patch>` and one `<vimmaTarball>` at that build's URLs on the
  `nightly` release, and nothing else. `nightly-publish` downloads both files again, checks the
  signed file with the browser's verifier and with openssl, and pushes only
  `…/vimma-nightly/update.xml`, never forced; a missing deploy key fails the run. A called job
  reads an environment secret only when its caller passes it, so `nightly.yml`'s `manifest` call
  passes `UPDATES_DEPLOY_KEY` by name (declared optional in `workflow_call`), never every secret
  with `inherit`; only `nightly-publish`, deploying to `update-publish`, reads it in a call and
  gets the environment's value, and the `mar-sign` calls pass none. **⚠ setting:** the key
  lives only in the `update-publish` environment; a repository or organisation secret of that
  name, readable from any branch, would also flow into the call, and none may exist
  (`gh api repos/vimma-browser/vimma/actions/secrets`). The release
  jobs refuse a body for any channel but `vimma`, `manifest.mjs` checks each channel before a
  push, and the client refuses a manifest for another channel (UP2), so a nightly offer never
  reaches a release install, nor a release offer a nightly install. Each channel's serials and
  offers only grow: an offer of an older build than the published nightly manifest's is
  refused. **⚠ limit:** a nightly is always offered as `normal` (decision 43), so a nightly
  that carries a Firefox security fix gets no restart question; Firefox's updater still stages
  it and applies it at the next start.
  On a scheduled day when `main` did not change (decision 44), `nightly.yml` makes the same call
  with the build the `nightly` release records, and these three jobs re-sign it unchanged: the
  same environments, permissions, Workload Identity condition, byte check and seven-line check,
  so the body differs from that build's earlier manifest only in its serial. The client takes
  the newer serial with an offer of its own version as up to date, with no download and no
  notice, and the nightly feed never goes stale while the nightly runs.
  **⚠ limit:** without a required reviewer on `update-signing`, anyone with write access can
  start a run on `main` that re-signs a published release or offers nothing (withholding
  updates).
  [`grants nothing by default, and each job only what it needs`](../../tools/update/test/update-workflow.test.mjs),
  [`an unchanged day's re-sign offers the same build under a newer serial, and installs stay current`](../../tools/update/test/nightly-manifest.test.mjs),
  [`only sign, mar-sign and nightly-sign mint an OIDC token or name the signing environment`](../../tools/update/test/update-workflow.test.mjs),
  [`%s runs only in nightly.yml's call on main, with UPDATES_ENABLED and NIGHTLY_RELEASE_ENABLED`](../../tools/update/test/update-workflow.test.mjs),
  [`nightly-prepare reads the public nightly pre-release and its nightly.yml signature`](../../tools/update/test/update-workflow.test.mjs),
  [`nightly-prepare checks the MAR's channel and builds the nightly channel's manifest`](../../tools/update/test/update-workflow.test.mjs),
  [`nightly-publish checks the signed file, then pushes only the nightly channel's path`](../../tools/update/test/update-workflow.test.mjs),
  [`the release jobs never write the nightly path, nor the nightly jobs the release path`](../../tools/update/test/update-workflow.test.mjs),
  [`nightly-sign signs the nightly's body so that the browser's verifier accepts it`](../../tools/update/test/update-workflow.test.mjs),
  [`nightly-sign refuses to sign %s`](../../tools/update/test/update-workflow.test.mjs),
  [`sign, the release's check, refuses the nightly's body`](../../tools/update/test/update-workflow.test.mjs),
  [`checkSigned, the release's check, refuses a nightly manifest`](../../tools/update/test/nightly-manifest.test.mjs),
  [`checkSignedNightly refuses a release manifest, whatever it offers`](../../tools/update/test/nightly-manifest.test.mjs),
  [`checkSignedNightly refuses another key, a changed file, another build and a moved MAR`](../../tools/update/test/nightly-manifest.test.mjs),
  [`refuses an older build than the published nightly manifest offers, and an old serial`](../../tools/update/test/nightly-manifest.test.mjs),
  [`is offered to a nightly install of an older build, and to no release install`](../../tools/update/test/nightly-manifest.test.mjs),
  [`the signing job %s runs no repository code: no checkout, no node, no npm`](../../tools/update/test/update-workflow.test.mjs),
  [`a published release only starts the run on main, and only with UPDATES_ENABLED`](../../tools/update/test/update-workflow.test.mjs),
  [`%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run`](../../tools/update/test/update-workflow.test.mjs),
  [`checks that the release is published, not a pre-release, and on main`](../../tools/update/test/update-workflow.test.mjs),
  [`checks SHA256SUMS against release.yml's signature, and refuses an unsigned release`](../../tools/update/test/update-workflow.test.mjs),
  [`the publish job verifies with the browser's verifier and with openssl before any push`](../../tools/update/test/update-workflow.test.mjs),
  [`the deploy key lives in its own environment and reaches only the push steps`](../../tools/update/test/update-workflow.test.mjs),
  [`a call receives the deploy key only by name, optional, and only nightly.yml's manifest passes it`](../../tools/update/test/update-workflow.test.mjs),
  [`pushes one commit naming the version to main, never forced, to a pinned host key`](../../tools/update/test/update-workflow.test.mjs),
  [`a push the other target's run beat rebases and lands, with no git identity configured`](../../tools/update/test/update-workflow.test.mjs),
  [`signs the body so that the browser's verifier accepts it under the KMS key`](../../tools/update/test/update-workflow.test.mjs),
  [`refuses to sign %s`](../../tools/update/test/update-workflow.test.mjs),
  [`every asset must be listed with the hash of the file that was downloaded`](../../tools/update/test/manifest.test.mjs),
  [`must be newer than the published manifest's; equal or older is refused`](../../tools/update/test/manifest.test.mjs),
  [`checkSigned refuses another key, a changed file, an older serial and another version`](../../tools/update/test/manifest.test.mjs),
  [`refuses to offer an older version than the published manifest does`](../../tools/update/test/manifest.test.mjs),
  [`retries a transient failure, then reads the labels`](../../tools/update/test/manifest.test.mjs),
  [`throws after four attempts that all fail, never answering no labels`](../../tools/update/test/manifest.test.mjs),
  [`throws at once on a failure that is not transient`](../../tools/update/test/manifest.test.mjs),
  [`throws at once on %s instead of answering no labels`](../../tools/update/test/manifest.test.mjs),
  [`throws at once on %s instead of widening the range`](../../tools/update/test/manifest.test.mjs),
  [`downloads the target's files and sums, and passes the target to manifest.mjs`](../../tools/update/test/update-workflow.test.mjs),
  [`checks a macOS body against the macOS target, and refuses a Linux one there`](../../tools/update/test/update-workflow.test.mjs),
  [`runs one manifest per target at a time, never cancelling one half done`](../../tools/update/test/update-workflow.test.mjs),
  [`refuses a .dmg that does not match SHA256SUMS-macos`](../../tools/update/test/manifest.test.mjs),
  [`checkSigned takes the target: a Linux manifest is refused for macOS and back`](../../tools/update/test/manifest.test.mjs),
  [`macos-tap starts the macOS update manifest once the .dmg is on a published release`](../../tools/package/test/release-workflow.test.mjs),
  [`a published release whose .dmg is already there starts the macOS manifest too`](../../tools/update/test/update-workflow.test.mjs),
  [`fails when the release API answers %i`](../../tools/test/release-asset-checks.test.mjs)
- UP8. A command about:vimma shows **never** installs or replaces anything with a file it has not
  checked: every download uses `curl -f` (an HTTP error stops it) and `--proto =https`, and when
  the signed manifest gives the file's SHA-512, `sha512sum -c` checks it before `apt`, `dnf`,
  `zypper`, `tar` or `mv` runs. The `.rpm`'s zypper command passes `--allow-unsigned-rpm`, so
  for it that check is the only one, as it is for the `.deb`. A tarball is downloaded to a file and checked before it is unpacked, never piped
  into `tar`. Asset hashes are read only from the signed manifest, only as 128 lower-case hex
  digits, and a saved result keeps only well-formed ones. **⚠ limit:** the release `PKGBUILD`'s
  command still fetches `latest/download/PKGBUILD` without a hash of its own; `makepkg` checks
  the tarball against the SHA-256 that `PKGBUILD` pins.
  [`every download fails on an HTTP error and refuses anything but https (V-07)`](../../packages/vimma-core/test/updates.test.mjs),
  [`rpm: download and check it, then install it with dnf or zypper`](../../packages/vimma-core/test/updates.test.mjs),
  [`the checked commands run: a matching file installs, a different one stops before`](../../packages/vimma-core/test/updates.test.mjs),
  [`reads each package's size and SHA-512 (the release pipeline's asset elements)`](../../packages/vimma-core/test/updates.test.mjs),
  [`offerAssets keeps only well-formed entries (a saved result read back)`](../../packages/vimma-core/test/updates.test.mjs),
  [`update_command_opens_the_steps`](../../tests/browser/browser_vimma_update_check.js)
- UP9. The security update question (`Show the update command? (y/N)`) is **never** answered by
  a key pressed before it armed: keys count only `security.dialog_enable_delay` (1,000 ms) after
  it appears or after its window comes to the front or leaves it, an earlier key starts the
  delay again, and a held key never answers. It **never** takes focus, **never** opens while
  focus is in a field, while another Vimma overlay, the agent question or a Firefox permission
  prompt is open, in hint, copy or element mode, or in a private window; a key that arrives
  while focus is in a field or a page is in DOM full screen is **never** taken as an answer; and `y` **only** opens about:vimma's Updates section: nothing is installed or
  run. The one-time message is a notice that takes no focus and no keys.
  [`a_security_update_asks_once_per_session`](../../tests/browser/browser_vimma_update_notices.js),
  [`early_and_held_keys_never_answer`](../../tests/browser/browser_vimma_update_notices.js),
  [`another_window_in_front_arms_it_again`](../../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_for_an_open_overlay`](../../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_for_copy_mode`](../../tests/browser/browser_vimma_update_notices.js),
  [`y_shows_the_update_steps_and_esc_dismisses`](../../tests/browser/browser_vimma_update_notices.js),
  [`the_question_waits_while_the_user_types`](../../tests/browser/browser_vimma_update_notices.js),
  [`no_question_in_a_private_window`](../../tests/browser/browser_vimma_update_notices.js),
  [`a_new_version_is_announced_once`](../../tests/browser/browser_vimma_update_notices.js),
  [`y or Y shows the steps; n, Esc, Enter and any other key dismiss`](../../packages/vimma-core/test/update-notices.test.mjs)

- UP10. The AppImage **only** replaces its own file (`$APPIMAGE`) with a download whose size
  and SHA-512 match a manifest verified by a check in the running process (an offer restored
  from the saved result, the pref `vimma.update.last`, waits for a check), checked on the file as written to disk, after every
  write is synced, and before the rename; anything else leaves the file as it was and removes
  the download. It replaces nothing unless its GRE directory carries the
  `vimma-package=appimage` marker and lies inside `$APPDIR`, so a program started from another
  AppImage, which inherits that AppImage's `$APPIMAGE`, never overwrites it. Outside automation
  the download **must** come from `https://github.com/vimma-browser/vimma/releases/download/`
  (path segments only), so a leaked manifest key alone cannot point installs at a file of its
  own. The download is anonymous (no cookies, no referrer, an empty `Accept-Language`), follows
  GitHub's redirect to its asset host but must end on https, stops past the signed size or after
  60 seconds without data or after 6 hours, and is written to a hidden file in the same
  directory whose name no other file has, created by this process alone, so a second Vimma
  never writes into it or removes it; part files left by a killed run are removed after a day.
  A symbolic link at `$APPIMAGE` is refused. The file is made `0755` and renamed over
  `$APPIMAGE`; the running Vimma keeps its mounted image, and nothing restarts it. Checks off
  (UP4) download nothing, and turning them off stops a download under way. **⚠ limit:** the manifest's hash is the AppImage's only signature: an
  AppImage carries no MAR signature the way Firefox's updater checks one, so a leaked primary key
  together with any release asset of the project (an older AppImage included) can install that
  asset; the replay and downgrade rules (UP2) compare the manifest's versions, not the file's.
  [`a_newer_appimage_replaces_the_file`](../../tests/browser/browser_vimma_update_appimage.js),
  [`a_wrong_hash_leaves_the_file_alone`](../../tests/browser/browser_vimma_update_appimage.js),
  [`a_larger_download_than_signed_is_refused`](../../tests/browser/browser_vimma_update_appimage.js),
  [`an_unwritable_directory_falls_back_to_the_steps`](../../tests/browser/browser_vimma_update_appimage.js),
  [`another_install_type_never_touches_appimage`](../../tests/browser/browser_vimma_update_appimage.js),
  [`checks_off_never_downloads`](../../tests/browser/browser_vimma_update_appimage.js),
  [`a_saved_offer_is_installed_only_after_a_check`](../../tests/browser/browser_vimma_update_appimage.js),
  [`another_downloads_part_file_neither_blocks_nor_is_removed`](../../tests/browser/browser_vimma_update_appimage.js),
  [`a_symlinked_appimage_is_not_replaced`](../../tests/browser/browser_vimma_update_appimage.js),
  [`without the AppDir's own appimage marker, $APPIMAGE is never replaced`](../../packages/vimma-core/test/appimage-update.test.mjs),
  [`a Vimma that does not run from $APPDIR is not the AppImage $APPIMAGE names`](../../packages/vimma-core/test/appimage-update.test.mjs),
  [`a download from %s is refused outside automation`](../../packages/vimma-core/test/appimage-update.test.mjs),
  [`another size or hash: refused, with the reason`](../../packages/vimma-core/test/appimage-update.test.mjs)

- UP11. Vimma **never** restarts by itself: only `:restart` (action `app.restart`), `y` in the
  restart question, or Firefox's own restart commands do. The restart question
  (`Security update 0.3.1 is ready. Restart now? Tabs come back. (y/N)`) is asked **only** for a
  security release that is already in place (an AppImage that replaced its file, or a tarball
  whose update Firefox's updater will apply at the next start), once per session and again 24
  hours after an answer, and arms, waits and refuses keys exactly as the question of UP9. It
  **never** hides a loss: while the private workspace has tabs it says they will close, and when
  session restore will bring no tab back it says `Tabs will not come back`;
  a loss that appears while the line is open (a private tab opened since) makes `y` ask
  `:restart`'s `y/N` before anything restarts. `:restart` asks that `y/N` first whenever tabs
  would be lost. A restart asks Firefox's `quit-application-requested` observers with
  `restart`, and a page's beforeunload can still keep its window, which cancels it. Every install
  but the AppImage restarts through Firefox (`eAttemptQuit | eRestart`). The AppImage restarts
  only when its install type is the AppImage (UP10's marker rule) and `$APPIMAGE` is an absolute
  path to an executable file: it quits, and **only** in `quit-application`, once no window can
  refuse, it starts the relaunch script of C2 on its own process id, with the profile and its
  local directory in `XRE_PROFILE_PATH` and `XRE_PROFILE_LOCAL_PATH` as Firefox's restart passes
  them; a quit that a window refused starts nothing. The script gives up after 120 seconds and
  then starts nothing, so a process id reused by another program never keeps it waiting for
  long. **⚠ limit:** an AppImage's restart is a quit and a new start: with history cleared on
  close (`privacy.sanitize.sanitizeOnShutdown`), the session is purged and no tab comes back,
  where Firefox's restart keeps it (the question and `:restart` say so first); the new process
  gets none of the old one's command-line arguments; and when Vimma runs as a systemd service
  unit, not a scope, systemd may stop the script with the unit, so nothing starts.
  [`an_appimage_quits_and_starts_its_file_again`](../../tests/browser/browser_vimma_restart.js),
  [`a_refused_quit_starts_nothing_and_leaves_the_session_as_it_was`](../../tests/browser/browser_vimma_restart.js),
  [`a_cancelled_request_quits_nothing`](../../tests/browser/browser_vimma_restart.js),
  [`a_tarball_restarts_through_firefox`](../../tests/browser/browser_vimma_restart.js),
  [`an_appimage_whose_file_cannot_run_restarts_through_firefox`](../../tests/browser/browser_vimma_restart.js),
  [`private_tabs_ask_before_they_close`](../../tests/browser/browser_vimma_restart.js),
  [`a_replaced_security_update_asks_to_restart`](../../tests/browser/browser_vimma_update_appimage.js),
  [`a_staged_security_update_asks_to_restart`](../../tests/browser/browser_vimma_update_verify.js),
  [`an_ordinary_replaced_update_asks_nothing`](../../tests/browser/browser_vimma_update_appimage.js),
  [`answered in this session: asked again 24 hours later, not sooner`](../../packages/vimma-core/test/update-notices.test.mjs),
  [`the_restart_question_says_what_a_restart_loses`](../../tests/browser/browser_vimma_update_appimage.js),
  [`history_cleared_on_close_asks_before_an_appimage_restart`](../../tests/browser/browser_vimma_restart.js),
  [`history cleared on close: an AppImage's restart is a quit, so the session is purged`](../../packages/vimma-core/test/restart.test.mjs),
  [`an AppImage without a usable $APPIMAGE falls back to Firefox's restart`](../../packages/vimma-core/test/restart.test.mjs),
  [`gives up after RELAUNCH_WAIT_S when the old process never exits`](../../packages/vimma-core/test/restart.test.mjs)
- UP12. Firefox's updater is built **only** with `VIMMA_UPDATES=1` (the release and nightly
  jobs; source and dev builds keep `--disable-updater`), **only** for the update channel
  `vimma`, and such a binary **only** asks `updates.vimma.dev` and **only** applies a MAR signed
  by a key whose certificate Vimma commits (`configs/updater/`, which `npm run import` links to
  `engine/toolkit/mozapps/update/updater/vimma/` where `moz-build.patch` reads it; ADR-016). It
  **never** trusts Mozilla's keys, test-signing keys (`dep1.der`, `dep2.der`, whose
  private halves are public) included: the mozconfig stops the build when either of Vimma's
  certificates is missing or empty in the engine (a dangling link counts as missing) or differs
  from the committed one, the import refuses to link a missing, empty or symlinked one, and `moz-build.patch` stops it on any other channel, since every
  other channel embeds Mozilla's. The manifest check's pinned keys (UP1) are generated from the
  same certificates, so the two verifiers trust the same keys, and a certificate that is not
  self-signed by its own key is refused. The primary's certificate is made from the request
  `update-cert.mjs` builds for the pinned primary key; only `--any-key`, for throwaway test
  keys, takes another. `check-build.mjs` checks a package (the URL, both channel files, and
  that its `updater` carries Vimma's certificates and none of Mozilla's): `release.yml`'s
  `package` job on the release tarball, and `nightly.yml` on its tarball once it is set to the
  `vimma-nightly` channel (UP14). Firefox's check runs Vimma's verifier first (UP13).
  **⚠ limit:** Artifact builds (ADR-010) run Mozilla's prebuilt updater, which trusts only
  Mozilla's keys, and keep `aus5.mozilla.org`; they are never shipped.
  [`is not built without VIMMA_UPDATES (source and dev builds)`](../../tools/test/mozconfig-updater.test.mjs),
  [`refuses VIMMA_UPDATES=1 without Vimma's certificates, so no updater trusts Mozilla's test keys`](../../tools/test/mozconfig-updater.test.mjs),
  [`refuses any other value of VIMMA_UPDATES rather than guessing`](../../tools/test/mozconfig-updater.test.mjs),
  [`links both certificates into the engine and ignores them in its git`](../../tools/import/test/link-update-certs.test.mjs),
  [`refuses a repository without a certificate, so no import leaves a half-set behind`](../../tools/import/test/link-update-certs.test.mjs),
  [`refuses a certificate that is a link, which could lead to any file on the machine`](../../tools/import/test/link-update-certs.test.mjs),
  [`refuses VIMMA_UPDATES=1 when a certificate in the engine is not the committed one`](../../tools/test/mozconfig-updater.test.mjs),
  [`fails when the updater lacks Vimma's certificate or carries one of Mozilla's`](../../tools/update/test/check-build.test.mjs),
  [`fails without the [AppUpdate] URL or with another host`](../../tools/update/test/check-build.test.mjs),
  [`the repository: update-keys.mjs is what the committed certificates give`](../../tools/update/test/gen-update-keys.test.mjs),
  [`pins the primary once when the secondary slot holds the primary again (decision 39)`](../../tools/update/test/gen-update-keys.test.mjs),
  [`refuses a signature that is not the key's own over this request`](../../tools/update/test/update-cert.test.mjs),
  [`refuses a certificate whose self-signature does not verify`](../../tools/update/test/gen-update-keys.test.mjs),
  [`fails when --mozilla-certs lacks Mozilla's certificates, rather than comparing nothing`](../../tools/update/test/check-build.test.mjs),
  [`CLI: request, then assemble with a KMS signature, refusing a key other than the pinned primary`](../../tools/update/test/update-cert.test.mjs),
  [`package checks the release tarball's updater, whether or not updates are on`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`packages for the nightly channel and checks the updater before the upload`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`rewrites both channel files, and nothing else in them`](../../tools/update/test/channel.test.mjs)

- UP13. Firefox's update check **never** hands Firefox's update parser (`#parseUpdates`) or its
  choice of an update a manifest that Vimma's rules (UP1, UP2) have not accepted:
  `UpdateService-sys-mjs.patch` (ADR-003) runs Vimma's verifier on the answer first, a refused
  manifest fails the check as a malformed file does, a manifest that offers nothing newer makes
  Firefox offer nothing, and a prefixed element name (which Firefox would read by its local name)
  is refused. While checks are off or held (but for `:update`, only for its own check), in a
  build run from its objdir (UP4), and until Vimma knows the install type and has read
  `config.toml`, the check ends as not allowed before any request. Its
  request is anonymous, with an empty `Accept-Language`, follows no redirect (UP3), asks for the
  file uncompressed and is **never** decoded, so a compressed answer fails the signature, and it
  is cancelled past 256 KiB (UP5). A manifest offers at most one MAR, a complete one on https.
  The MAR's download **never** carries cookies (spec decision 1): requests from chrome with no
  browsing context to the URL the verified manifest named (compared as Necko writes it), and to
  the URLs its anonymous requests are redirected to until the download ends, go without them;
  any other request is left as it is. The MAR's own signature is the
  updater's check (UP12). On a tarball Firefox's updater updates, Vimma's own fetch stays off,
  so one check runs, and `:update` starts Firefox's.
  **⚠ limit:** XMLHttpRequest reports progress about every 50 ms, so beyond the cap the parent
  holds at most what arrives in one such interval before the request is cancelled. Firefox's
  timer, not Vimma's, decides when a tarball checks (`app.update.interval`, 12 hours). Turning
  checks off stops later checks, not a download Firefox already started for a verified offer.
  XMLHttpRequest builds its XML document from the answer before the verifier runs, as Firefox
  without Vimma does.
  [`a_signed_newer_build_is_offered_and_the_request_is_anonymous`](../../tests/browser/browser_vimma_update_verify.js),
  [`a_manifest_failing_the_rules_never_reaches_firefox`](../../tests/browser/browser_vimma_update_verify.js),
  [`a_replay_is_refused_and_a_downgrade_offers_nothing`](../../tests/browser/browser_vimma_update_verify.js),
  [`checks_off_send_no_request`](../../tests/browser/browser_vimma_update_verify.js),
  [`an_oversized_or_compressed_body_is_refused`](../../tests/browser/browser_vimma_update_verify.js),
  [`the_mar_download_goes_without_cookies`](../../tests/browser/browser_vimma_update_verify.js),
  [`a_real_download_is_shown_on_restart`](../../tests/browser/browser_vimma_update_verify.js),
  [`no_check_before_the_install_type_is_known`](../../tests/browser/browser_vimma_update_verify.js),
  [`update_checks_a_tarball_through_firefoxs_updater`](../../tests/browser/browser_vimma_update_verify.js),
  [`refuses two <patch> elements, so Firefox can pick no MAR the download rule misses`](../../packages/vimma-core/test/updates.test.mjs)

- UP14. A complete MAR is **only** signed by `update-publish.yml`'s `mar-sign` job, which
  `release.yml` or `nightly.yml` run from `main` calls (`workflow_call`), and **only** for that
  caller's own MAR on that caller's channel: a release's MAR on `vimma`, and a nightly build's on
  `vimma-nightly` only while `NIGHTLY_RELEASE_ENABLED` is `true` (B8). The caller
  (`github.workflow_ref`) picks the channel and the name the file must have, never an input. A
  called job is the called file's job, so its OIDC token names
  `update-publish.yml` at `refs/heads/main`: the Workload Identity condition on `job_workflow_ref`
  (UP7) admits no new workflow, and the key is reached by no job of `release.yml` or `nightly.yml`
  itself. The job refuses to run unless its caller is `release.yml` or `nightly.yml` at
  `refs/heads/main` and `UPDATES_ENABLED` is `true`, uses the `update-signing` environment
  (deployment branch `main` alone), holds only `id-token: write` and runs no repository code. `release.yml`'s calling job
  allows the union of what `update-publish.yml`'s jobs ask for (`actions: write`, `contents: read`,
  `pull-requests: read`, `issues: write`, `id-token: write`), because GitHub refuses a call whose
  jobs, skipped ones included, ask for more than the caller allows; that is a ceiling, and in a call
  no job but `mar-sign` runs (`start` needs the release event, the others no `mar` input). Before
  Cloud KMS signs anything it checks with the shell alone that the file is named as the caller's
  MAR (the tag's for `release.yml`, `vimma-nightly-<buildID>-linux-x86_64.complete.mar` for
  `nightly.yml`), that its size field is its size, that it has exactly one signature entry, 512
  bytes of RSA-PKCS#1 v1.5 with SHA-384 (algorithm 2), all zero, and that its product information
  block names the caller's channel, byte for byte with its NUL. The channel is in the signed
  bytes, so a nightly MAR never installs on a release install, nor a release MAR on a nightly
  install (the updater's error 22). It signs every byte but that placeholder, bytes that start with `MAR1`, while
  a manifest's signed bytes start with `vimma-update-xml-v1\n`, so under the one key (spec decision 12) a MAR signature can never pass as a manifest's or back. It checks KMS's signature with openssl
  and writes in only the signature bytes. The MAR is built in `package`, a job with no secret, from
  the release tarball with the build's own host `mar` and Mozilla's `make_full_update.sh`
  (`tools/update/mar.mjs build`). Then `mar`, a job with no secret and a read-only token, checks
  that the signed MAR differs from the one `package` built only in its signature bytes, that the
  signature verifies under the committed certificates with `mar.mjs` and with Mozilla's `signmar`
  (the updater's own verification code, from this release's build), that its channel is the release
  channel and its product version the build's Firefox version, and that it installs exactly the
  release tarball's files, byte for byte; only then does `SHA256SUMS` list it, so cosign signs it
  with the other assets and `publish` uploads it. While `UPDATES_ENABLED` is `true`, `sign` and
  `publish` **never** run unless `mar` succeeded, so a release never ships without the MAR its
  manifest offers, and `mar` fails when the calling job did not succeed or left no signed MAR (a
  call whose `mar-sign` job was skipped ends as success with no artifact), so the release run fails
  and opens the `release-failure` issue rather than uploading nothing. In a call, the manifest's
  jobs need `update-publish.yml` to be the run's own workflow (`github.workflow_ref`, the caller's
  in a call), and a call has a concurrency group of its own. The manifest offers a MAR (`<patch>`)
  **only** when the release's cosign-signed `SHA256SUMS` lists it, with its size and SHA-512 and at
  the release's own download URL; the manifest's signing job refuses a `<patch>` at any other URL, a
  second one, or one in the macOS manifest, and the publish job downloads the MAR again and checks
  it against the signed manifest. `nightly.yml`'s `mar` job checks a nightly's signed MAR the same
  way, on the channel `vimma-nightly`, before its `SHA256SUMS` lists it (B8); without
  `NIGHTLY_RELEASE_ENABLED` the nightly builds its MAR as a check and keeps none
  ([m6a-updater](../specs/m6a-updater.md), decision 42). Both workflows' build jobs pack the MAR
  tools the `mar` job runs (`signmar`, the NSS libraries of the objdir it loads, the host `mar`)
  with one script, `tools/update/mar-tools.mjs`, which fails the build, before anything is
  uploaded, unless `signmar` and `mar` start from the packed directory with every library of
  the objdir that ldd lists found there; a pack that missed a library would otherwise surface only in `mar`, after
  `mar-sign` had signed. It runs the build's own tools only in the build job, which built them and
  already runs the build's code, after the Safe Browsing key file is deleted; no other job that
  holds a secret runs them.
  **⚠ limit:** the key signs what the build job built: a compromised build (it compiles Firefox with
  the Safe Browsing key in reach) can produce a malicious MAR that `mar-sign` then signs, as it can
  produce a malicious tarball that cosign signs; it cannot copy the key out, and every signature is
  in Cloud KMS's audit log. A signed MAR is kept 7 days as a workflow artifact of the release run,
  which any signed-in GitHub user can download before the release is published; an install applies
  it only when a manifest signed by the same key offers it. Firefox's updater refuses a MAR only
  when its Firefox version is older, so a signed MAR of an older Vimma on the same Firefox would
  apply; what keeps installs from it is the manifest's serial and downgrade rules (UP2) and its
  SHA-512 pin of the offered MAR.
  **⚠ setting:** as UP7, the `update-signing` environment's branch rule and the Workload Identity
  condition keep other branches and workflows from the key; `github.workflow_ref` only keeps another
  workflow on `main` from calling `mar-sign`. Since any repository's workflow can call
  `update-publish.yml@main` and its token then names that file too, the condition's
  `assertion.repository` clause and the IAM member's subject, which names the repository by its ID,
  **must** never be dropped.
  [`is called by release.yml and nightly.yml alone, and mar-sign signs only for those two`](../../tools/update/test/update-workflow.test.mjs),
  [`only sign, mar-sign and nightly-sign mint an OIDC token or name the signing environment`](../../tools/update/test/update-workflow.test.mjs),
  [`signs a nightly's MAR for nightly.yml on main, on the nightly channel`](../../tools/update/test/update-workflow.test.mjs),
  [`the MAR is signed by update-publish.yml's mar-sign, with this run's MAR`](../../tools/test/nightly-workflow.test.mjs),
  [`the mar job checks the signed MAR for the nightly channel, against the tarball`](../../tools/test/nightly-workflow.test.mjs),
  [`the mar job fails, loudly, when the MAR was not signed`](../../tools/test/nightly-workflow.test.mjs),
  [`the signing job %s runs no repository code: no checkout, no node, no npm`](../../tools/update/test/update-workflow.test.mjs),
  [`signs the placeholder so that the updater's check accepts it under the KMS key`](../../tools/update/test/update-workflow.test.mjs),
  [`refuses to sign %s`](../../tools/update/test/update-workflow.test.mjs),
  [`refuses a <patch> %s`](../../tools/update/test/update-workflow.test.mjs),
  [`refuses a <patch> in the macOS manifest`](../../tools/update/test/update-workflow.test.mjs),
  [`downloads the MAR SHA256SUMS lists, and the one the signed manifest offers`](../../tools/update/test/update-workflow.test.mjs),
  [`writes signmar's layout byte for byte, with the signature zeroed`](../../tools/update/test/mar.test.mjs),
  [`signmar's signature verifies over the bytes around the placeholder`](../../tools/update/test/mar.test.mjs),
  [`the signed bytes start with the MAR ID, so no manifest signature can pass as a MAR's`](../../tools/update/test/mar.test.mjs),
  [`accepts a MAR signed the way the KMS key signs, and refuses one byte changed`](../../tools/update/test/mar.test.mjs),
  [`refuses a MAR no given key signed`](../../tools/update/test/mar.test.mjs),
  [`mar-sign calls update-publish.yml, the one workflow the key signs for`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`mar-sign's permissions are the ceiling update-publish.yml's jobs need, no more`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`mar fails, loudly, when the MAR was not signed, so a release never stops silently`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run`](../../tools/update/test/update-workflow.test.mjs),
  [`mar checks the signed MAR with no secret: same content, the certificates, signmar`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`packs with the script release.yml uses, on every nightly`](../../tools/test/nightly-workflow.test.mjs),
  [`packs after the key file is gone, before the MAR is built and anything is uploaded`](../../tools/test/nightly-workflow.test.mjs),
  [`packs signmar's libraries from a relative objdir, which ldd names by absolute path`](../../tools/update/test/mar-tools.test.mjs),
  [`fails, naming it, when a library signmar loads is missing`](../../tools/update/test/mar-tools.test.mjs),
  [`cosign signs the MAR with the other assets, after it is checked`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`publish uploads the MAR and the new SHA256SUMS, never a release that lost its MAR`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`runs the release's MAR step for the nightly channel, and keeps it only for a public nightly`](../../tools/update/test/pipeline-workflows.test.mjs),
  [`prepareRelease offers the MAR SHA256SUMS lists, with its size and SHA-512`](../../tools/update/test/manifest.test.mjs),
  [`checkSigned checks the MAR the manifest offers against the downloaded file`](../../tools/update/test/manifest.test.mjs),
  [`checkSigned refuses a <patch> at any URL but the release's MAR`](../../tools/update/test/manifest.test.mjs)

**Key custody** (spec §6, decisions 16 and 17): the primary manifest key is a non-exportable
Google Cloud KMS key that only `update-publish.yml`'s signing jobs on `main`, in the `update-signing` environment, can
ask to sign, through GitHub OIDC: `sign` and `nightly-sign` for manifests (UP7) and `mar-sign`, called by `release.yml` and `nightly.yml`, for MARs (UP14); the secondary is to be generated and kept offline by the maintainer (not made yet). Their
setup is in [docs/runbook/ci-update-keys-and-update-host.md](../runbook/ci-update-keys-and-update-host.md#update-signing-keys-and-the-update-host-spec-m6a-updater).
The primary's public key is pinned in `update-keys.mjs` (its SHA-256 is recorded in the runbook
and checked by
[`the shipped primary: exactly one, RSA-4096, the recorded key, verifies RSASSA-PKCS1-v1_5 SHA-384`](../../packages/vimma-core/test/updates.test.mjs));
the secondary is pinned in a later release, an ordinary one whose manifest the primary signs.
Firefox's updater embeds the same keys as self-signed certificates, the secondary slot holding the
primary's again until then (decision 39; runbook step 5b, UP12).
Until then a lost or leaked primary cannot be replaced through the update check: installs keep
trusting it until they are updated by hand. A leaked primary can announce a version that does
not exist and link its details page anywhere over https, but the commands about:vimma shows
still name only the project's own release downloads (UP5), and only the AppImage installs
anything, and only a release asset of the project (UP10).
It can also mark such an offer as a security release, and hold back genuine manifests for up to a
day by signing a serial ahead of the clock (UP2).
