# ADR-016: Vimma's own update channel

- Status: Accepted
- Date: 2026-11-04

## Context

A tarball install can only update itself through Firefox's updater (spec
[m6a-updater](../specs/m6a-updater.md) §3): it fetches `[AppUpdate] URL` from `application.ini`,
downloads the complete MAR the manifest names and lets the `updater` binary apply it after
checking the MAR's signature against the two certificates compiled into it. Every one of those
is fixed when the binary is built, and an installed copy can only change them by taking an
update signed under the old ones. Built as Firefox builds it for any channel other than
Mozilla's, Vimma's updater would ask `aus5.mozilla.org` and trust `dep1.der` and `dep2.der`,
Mozilla's test-signing keys, whose private halves anyone can find in Mozilla's source tree.

## Decision

- **The update host is `updates.vimma.dev`**, a name of its own under Vimma's domain, set as
  `MOZ_APPUPDATE_HOST` by one `set_config` line in `src/browser/moz-configure.patch`. The path
  is Firefox's fixed template, `/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml`, so a check
  names only the platform and the channel. The host serves committed static files from
  `vimma-browser/vimma-updates`, a repository that holds only manifests (spec decision 18). The
  name is built into every updater-enabled binary for life, so it is a name of its own: the
  hosting can move to another provider by DNS alone, without a client update. Artifact builds keep Mozilla's host: their updater is
  Mozilla's prebuilt one, which trusts only Mozilla's keys, and they are never shipped
  (ADR-010).
- **The channel is `vimma`** (Surfer's `--enable-update-channel=vimma`, MAR channel ID `vimma`),
  for release and nightly builds alike; a nightly package rewrites `channel-prefs.js` and
  `update-settings.ini` to `vimma-nightly` (spec §1). Updates never touch those two files, so an
  install keeps its channel.
- **The updater trusts Vimma's certificates only.** `src/toolkit/mozapps/update/updater/moz-build.patch`
  adds one branch for the channel `vimma` that embeds `vimma/primary.der` and
  `vimma/secondary.der`, files of Vimma's own beside Mozilla's, which stay untouched (overwriting
  them, as Zen does, would hide the change from a rebase). The primary is the Cloud KMS key that
  also signs the manifest (spec decisions 12 and 16); until the offline ceremony makes the
  recovery key, the secondary slot holds the primary's certificate again (decision 39).
- **One source for both verifiers.** `packages/vimma-core/src/update-keys.mjs`, the keys the
  manifest check pins, is generated from those certificates (`npm run gen-update-keys`), and a
  test fails when the two disagree, so the manifest check and the updater cannot drift apart.
- **The updater is built only for releases and nightlies.** `configs/common/mozconfig` passes
  `--enable-updater` only when `VIMMA_UPDATES=1`, which the release and nightly jobs set, and
  stops the build when either certificate is missing, so no Vimma binary can fall back to
  Mozilla's test keys. A source or dev build keeps `--disable-updater` (spec m0-updater): its
  build ID is newer than every release's, so it would never be offered anything useful, and its
  checks would only add traffic to the host.
- **Before a package is signed or published**, `tools/update/check-build.mjs` checks it: the
  `[AppUpdate] URL` is the host's, both channel files say `vimma`, and the `updater` binary
  carries the bytes of Vimma's certificates and of none of Mozilla's.

## Reasoning

The host, the channel and the certificates are the parts of the trust chain that every
updater-enabled binary carries for life, so they are decided once, before the first such binary
ships, and recorded here rather than only in a spec that later changes. Separate files and a
branch in `moz.build`, not overwritten Mozilla files, keep the change one small hunk that fails
loudly at `surfer import` when upstream moves the code around it.

## Alternatives rejected

- **Overwrite Mozilla's DER files** (Zen's way): no patch, but a rebase that changes those files
  would silently put Mozilla's keys back, and the repository would carry files under Mozilla's
  names with Vimma's keys in them.
- **Serve updates from `vimma.dev/updates/` or GitHub Pages** (spec decision 18): the site's
  deploy key would need a bypass of its ruleset and could then push any site change to
  production, and Pages caches for 10 minutes with no way for the repository to change it.
- **Build the updater into every build**: source and dev builds would check a host that never
  offers them anything and would ship Firefox's update UI with no feed behind it.
- **A throwaway key in the secondary slot** until the ceremony: it is either held by someone,
  which adds a party who can sign a Vimma update, or discarded, which adds nothing (decision 39).

## Consequences

- A leaked primary can sign MARs that every install accepts; recovery needs the offline
  secondary (spec §6, "If the primary leaks"), and until it exists, installs must be updated by
  hand. `docs/security.md` UP12 states the limit.
- The primary's certificate is self-signed by the KMS key, which only the maintainer's
  credentials can ask to sign outside the release workflow (`docs/runbook.md`, "Update signing
  keys and the update host", step 5b).
- Three upstream files carry Vimma's hunks for updates (`browser/moz.configure`,
  `toolkit/mozapps/update/updater/moz.build`, and with the manifest hook of sub-PR 3,
  `toolkit/mozapps/update/UpdateService.sys.mjs`); each has a line in ADR-003's register.
