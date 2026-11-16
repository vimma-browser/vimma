# Spec: m0-updater

Status: implemented · Milestone: M0 · Area: build config (`configs/*/mozconfig`), default prefs
(`src/browser/branding/vimma/pref/`), `tools/artifact-build`
Prerequisite: m0-mozilla-services and m0-app-version merged.

## User story

As a Vimma user, my browser never asks Mozilla's update server (`aus5.mozilla.org`) for a
Firefox build or for Mozilla's system add-ons, because Vimma is not Firefox and has no update
manifest yet; the About dialog and Settings show no update button and no update error. My
add-ons still update from addons.mozilla.org, and video calls and DRM video still get their
codecs.

## Problem (found while checking m0-mozilla-services)

The built `application.ini` has
`[AppUpdate] URL=https://aus5.mozilla.org/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml`
(`build/moz.build` hard-codes `aus5.mozilla.org` unless `CONFIG["MOZ_APPUPDATE_HOST"]` is set,
and no configure option sets it; Surfer's `export MOZ_APPUPDATE_HOST=…` never reaches it). The
update service checks it on its timer (`app.update.interval`, 24 h), from BrowserGlue's old-build
check (`app.update.checkInstallTime.days` = 2), whenever the About dialog or Settings opens, and
from the button. Measured: the service's URL is
`https://aus5.mozilla.org/updates/browser/Linux_x86_64-gcc3/vimma/update.xml`. Separately,
`extensions.systemAddon.update.url` asks aus5 with `%VERSION%` (157.0.1), build ID, OS and
locale on the add-on manager's daily timer.

## Scope

- **No app updater at build time**: `ac_add_options --disable-updater` in
  `configs/common/mozconfig`; the `--enable-updater` lines leave `configs/{linux,macos}/mozconfig`
  (Surfer's template). Windows' maintenance service and the update agent default to the updater
  setting, so they go too.
- **System add-on updates off**: `extensions.systemAddon.update.enabled` false and
  `extensions.systemAddon.update.url` "" in `firefox-branding.js`, as defaults (not locked).
- **Artifact build** (`tools/artifact-build/artifact-build.mjs`; since changed: `artifact-build.ts`, ADR-025) drops `--disable-updater`, as it
  drops `--disable-crashreporter`; ADR-010 gets the row and the known gap.
- No upstream patch, no new dependency.

## Services

Every Firefox 157.0.1 consumer of aus5 or of update URLs, from `firefox.js`, `all.js` and
`application.ini`:

| Service                               | What it asks                                                                                                                | Default here                                           | Ours                                | Why                                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App update (Balrog)                   | `aus5.mozilla.org/updates/browser/<target>/vimma/update.xml` on a timer, at old-build check, in About and Settings          | built (`--enable-updater`), URL from `application.ini` | **not built** (`--disable-updater`) | Mozilla's server has no Vimma builds; asking it tells Mozilla who runs Vimma and could one day offer a Firefox build. M6 brings our own manifest                                                                                                                      |
| System add-on updates (Balrog)        | `aus5.mozilla.org/update/3/SystemAddons/157.0.1/<buildid>/<target>/<locale>/vimma/<os>/…` daily                             | `extensions.systemAddon.update.enabled` true, URL aus5 | **off**: enabled false, URL ""      | Measured 2026-10-09 for 157.0.1 and 2026-10-15 for 158.0: aus5 answers `<updates></updates>` on both `vimma` and `release`, so it delivers nothing; webcompat interventions now come from Remote Settings (`webcompat-interventions`, kept). Privacy cost, no benefit |
| Add-on updates (AMO)                  | `versioncheck.addons.mozilla.org` / `versioncheck-bg.addons.mozilla.org` (`extensions.update.url`, `…background.url`) daily | on, `extensions.update.autoUpdateDefault` true         | **unchanged**                       | Users expect add-ons and their security fixes to update; not aus5                                                                                                                                                                                                     |
| GMP (OpenH264, Widevine)              | `aus5.mozilla.org/update/3/GMP/…` (`media.gmp-manager.url`)                                                                 | on                                                     | **unchanged** (kept deliberately)   | Measured: answers `vimma` with OpenH264 (WebRTC H.264 calls) and Widevine (DRM video). Turning it off breaks both; the request carries no user ID. LibreWolf turns it off with DRM; we keep Firefox's behaviour                                                       |
| Language-pack updates                 | AMO (`app.update.langpack.enabled`)                                                                                         | on                                                     | unchanged                           | AMO; follows app updates, so idle without the updater                                                                                                                                                                                                                 |
| Update prefs in `firefox-branding.js` | `app.update.url.manual`, `…details`, `checkInstallTime.days`, `badgeWaitTime`, …                                            | ours (m0-branding)                                     | unchanged                           | Unread without the updater, but upstream's unofficial brand defines them (`tools/branding/test`), and M6 needs them                                                                                                                                                   |

## Options for the app updater

Behaviour read from `UpdateService.sys.mjs`, `UpdateServiceStub.sys.mjs`, `AppUpdater.sys.mjs`,
`aboutDialog{.xhtml,.js,-appUpdater.js}` and `preferences/config/about-firefox.mjs`:

| Option                                                            | Network                                                                                                                                                                                                         | About dialog                                                                                     | Settings                                                                                   | Build                                                                      | Verdict                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`--disable-updater`** (LibreWolf, Debian/Fedora Firefox)        | none: no update service, no `[AppUpdate]` section, BrowserGlue's old-build check is gated on `AppConstants.MOZ_UPDATER`                                                                                         | version only; the whole update box is `#ifdef MOZ_UPDATER`                                       | "Updates are managed by your operating system" bar; no button, no auto-update choice       | full rebuild (define in libxul); artifact build must drop it (gap)         | **chosen**                                                                                                         |
| Policy `DisableAppUpdate` (+ `AppUpdateURL`, LibreWolf adds both) | none (`UpdateServiceStub.updateDisabled`)                                                                                                                                                                       | "Updates disabled by your organization" (`policyDisabled`)                                       | "Your browser is being managed by your organization" banner; about:policies populated      | needs `distribution/policies.json` packaged (a `package-manifest.in` hunk) | rejected: locked, and tells every user an organisation manages their browser                                       |
| Prefs only                                                        | no pref stops it: `app.update.url` is gone, the URL comes from `Services.appinfo.updateURL` or the `AppUpdateURL` policy; `app.update.auto` only stops downloads; `disabledForTesting` works only in automation | unchanged                                                                                        | unchanged                                                                                  | none                                                                       | rejected: impossible                                                                                               |
| Own URL (patch `build/moz.build` or `application.ini.in`)         | our host                                                                                                                                                                                                        | "Update check failed" until a manifest exists: the repo is private (404), M6 has no manifest yet | same error in the update box and a "Couldn't check for updates" alert on the security card | a patch, no C++                                                            | rejected for M0: an error state on every About open; this is M6's route (with `MOZ_APPUPDATE_HOST` and a manifest) |
| Empty URL (patch `application.ini.in`)                            | none (`update_url_not_available`)                                                                                                                                                                               | "Update check failed" (`checkingFailed`)                                                         | same error                                                                                 | a patch                                                                    | rejected: error state                                                                                              |
| `resource://` URL to a bundled empty `update.xml`                 | none                                                                                                                                                                                                            | would say "up to date", which is false once a newer Vimma exists                                 | same                                                                                       | a patch                                                                    | rejected: impossible anyway, the checker QIs the channel to `nsIHttpChannelInternal` and throws                    |

An option without a C++ rebuild that works in the artifact build would have been preferable. None
exists that is both silent and honest in the UI: every no-rebuild option either shows an error
or a managed-browser notice. `--disable-updater` needs no upstream patch, only one mozconfig line,
and is how distributions ship Firefox.

## Tests (write first)

`tests/browser/browser_vimma_updater.js` (full build only: `skip-if = ["artifact"]`, see Known
gap). The harness profile sets `app.update.disabledForTesting` and `app.update.checkInstallTime`
false; each task clears them first.

- Given `AppConstants`, then `MOZ_UPDATER` is false; `Services.appinfo.updateURL` is "".
- Given the update checker, if it exists, then `getUpdateURL(BACKGROUND_CHECK)` is null. (The URL
  rather than a request: a real check first waits for other running instances of the app,
  `waitForOtherInstances`, which a developer's own browser makes nondeterministic.)
- Given `checkInstallTime.days` 0, when BrowserGlue's `_checkForOldBuildUpdates` runs, then no
  request goes to aus5 (an `http-on-opening-request` observer records and cancels any).
- Given the About dialog, then it has no `#updateDeck` and no `#checkForUpdatesButton`, no error
  panel is visible, the version is, and opening it made no aus5 request.
- Given Settings > General, then the updates group shows neither `updateApp` (status, button)
  nor `installationFieldset`, and opening it made no aus5 request.

`tests/browser/browser_vimma_system_addons.js` (both builds; prefs only):

- Given the default branch, then `extensions.systemAddon.update.enabled` is false and its URL "".
- Given the harness's system add-on prefs cleared, when `AddonManagerPrivate.backgroundUpdateCheck()`
  runs, then no request goes to aus5.
- Given the default branch, then `extensions.update.enabled` and `autoUpdateDefault` are true and
  both update URLs are on `versioncheck{,-bg}.addons.mozilla.org`; `media.gmp-manager.url` is
  aus5's `/update/3/GMP/` endpoint (kept deliberately; a change must be a decision).

Both share `tests/browser/head_vimma_aus.js` (the request watcher).

`tools/artifact-build/test/artifact-build.test.mjs` (Since changed: `artifact-build.test.ts`, ADR-025): the generated artifact mozconfig drops
`--disable-updater` (fixture updated: our mozconfig no longer has `--enable-updater`).

## Out of scope

- Our update manifest, server and signing (M6): set `MOZ_APPUPDATE_HOST` (needs a configure
  hunk, the CONFIG value is never set) or patch `application.ini.in`, drop `--disable-updater`,
  and replace Mozilla's update-signing (MAR) certificates under `toolkit/mozapps/update/updater/`
  with ours; re-enabling is more than flipping the flag.
- GMP and Widevine policy (kept as Firefox has it); DRM prompts.
- Remote Settings (kept, m0-mozilla-services).

## Known gap

PR CI cannot see this spec's app-updater half: Mozilla's libxul in the artifact build aborts on
startup without `UpdateServiceStub.sys.mjs` ("Missing chrome or resource URLs"), so
`artifact-build.mjs` (Since changed: `artifact-build.ts`, ADR-025) drops `--disable-updater` and that build keeps Mozilla's updater, aus5 URL
and update UI. `browser_vimma_updater.js` runs only on full builds (locally, and in the nightly
once live). ADR-010 lists it. The system add-on half is prefs and runs in CI.

## Settled (2026-10-09, from the Firefox 157.0.1 tree, LibreWolf `settings`/`source`, Zen `dev`)

- **LibreWolf**: `--disable-updater` in its mozconfig, plus policies `DisableAppUpdate` and
  `AppUpdateURL: https://localhost`, `app.update.auto` locked false; GMP off with DRM
  (`media.gmp-manager.url` `data:text/plain,`). System add-on updates stay at Firefox's default
  (on, aus5): neither a pref nor the `DisableSystemAddonUpdate` policy (`SysAddonUpdate`, the
  only other input to `AddonManager.systemUpdateEnabled`).
- **Zen**: its own update server (Surfer's update tooling); no system add-on or GMP prefs, so
  both keep Firefox's aus5 defaults.
- **System add-ons: we differ from both** because the endpoint returns nothing (Services). If
  Mozilla starts shipping a system add-on that matters (it did for webcompat before the move to
  Remote Settings), `about:config` turns it back on; nothing is locked.
- **What the user sees** (full build): About shows "Vimma", the version (`0.1.0 (64-bit)`) and the
  usual blurbs, no update box. Settings > General > "Vimma updates" shows only the bar "Updates
  are managed by your operating system" (accurate for a package-managed install; for a source
  build it means "not by Vimma"). **Known gap for M6:** tarball and AppImage users (plan §6) get
  no updates at all, and this wording implies someone else handles them. No pref or Fluent
  override changes it without a patch (`update-application-updates-managed-by-os` takes no brand
  variable, and a duplicate Fluent id does not override); M6 replaces it with our updater or a
  one-string ftl patch ("Vimma does not update itself yet; see releases on GitHub"); the security card omits its update bullet
  (`#okUpdateStatus` treats no updater as OK). No button, no error.
- **Build cost**: after `npm run import`, `./mach build` with `--disable-updater` took 1805 s
  (30 min, reconfigure plus a libxul rebuild); no clobber. The artifact build with the flag
  configured and built in 27 s, then crashed at startup ("Missing chrome or resource URLs"
  for `UpdateServiceStub.sys.mjs`), hence the drop.
- **Red/green** (full build): before the change the two mochitests failed 10 checks:
  `MOZ_UPDATER` `true === false`; `Services.appinfo.updateURL` the aus5 URL; both system add-on
  defaults; `getUpdateURL` `"https://aus5.mozilla.org/updates/browser/Linux_x86_64-gcc3/vimma/update.xml" == null`;
  the add-on manager's check requested
  `https://aus5.mozilla.org/update/3/SystemAddons/157.0.1/<buildid>/Linux_x86_64-gcc3/en-US/vimma/…`;
  the About dialog had `#updateDeck` and `#checkForUpdatesButton`; Settings showed `updateApp`
  and `installationFieldset`. After it, 26/26 pass; the whole suite passes on the full build
  (204 passed, 0 failed) and on the artifact build (186 passed, 0 failed,
  `browser_vimma_updater.js` and `browser_vimma_crash_reporter.js` skipped).
