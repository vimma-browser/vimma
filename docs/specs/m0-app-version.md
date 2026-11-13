# Spec: m0-app-version

Status: implemented · Milestone: M0 · Area: build config (`configs/common/mozconfig`,
`tools/version-files/`), two one-line upstream patches (`ClientEnvironment`, `Targeting`)
Prerequisite: m0-branding, m0-user-agent and m0-mozilla-services merged.

## User story

As a Vimma user, everything in the browser that asks "which Firefox is this?" gets Firefox 157's
answer, so webcompat interventions, Remote Settings filters, add-on updates from AMO and backups
behave as they do in Firefox 157. Where I look for the product version (`vimma --version`, the
About dialog, about:support, Settings), I still see Vimma's own version, `0.1.0`.

## Scope

- **Two versions, two files.** `MOZ_APP_VERSION` (`appinfo.version`, `application.ini`
  `Version`) becomes the Firefox version from `surfer.json` `version.version` (`157.0.1` when
  this was built, `158.0` now);
  `MOZ_APP_VERSION_DISPLAY` stays `brands.vimma.release.displayVersion` (`0.1.0`).
  `configs/common/mozconfig` adds `ac_add_options --with-version-file-path=browser/config/vimma`,
  a configure option Firefox already has (`build/moz.configure/init.configure`, `milestone()`).
- **The files are generated**, never committed: `tools/version-files/version-files.mjs` (Since
  changed: `version-files.ts`, ADR-025) (`npm run version-files`, run by `npm run import` before
  `surfer import`) reads `surfer.json` and writes `src/browser/config/vimma/version.txt` (Firefox
  version) and `version_display.txt` (Vimma version), git-ignored like `vimma/core/`.
  `surfer import` links them into `engine/browser/config/vimma/`. It fails loudly if either version
  is missing or not a dotted version (Surfer silently falls back to `1.0.0`). Each file starts with
  the MPL header as `#` lines, because `surfer license-check` walks `src/` (git-ignored files too);
  configure reads only the last line, as with `config/milestone.txt`.
- **Two readers of the display version that mean "Firefox version"**, patched to read
  `MOZ_APP_VERSION`, one word each:
  - `src/toolkit/components/utils/ClientEnvironment-sys-mjs.patch`: `ClientEnvironmentBase.version`
    (Remote Settings and Normandy JEXL `env.version`).
  - `src/toolkit/components/messaging-system/targeting/Targeting-sys-mjs.patch`:
    `TargetingEnvironment.version` (Nimbus and ASRouter targeting `version`, which overrides
    any custom context).
- ADR-003 patch register: both patches. `docs/runbook.md`: the smoke check shows both versions.
- **Nightly**: the `--version` check is unchanged by this spec (it printed `Vimma Vimma 0.1.0`;
  spec firefox-versions later made it `Vimma 0.1.0 · Firefox <version>`); a second check reads
  `application.ini` and requires `Version=` to be `surfer.json` `version.version`.
- `browser_vimma_branding.js`: its "appinfo.version is 0.x" assertion moves to
  `AppConstants.MOZ_APP_VERSION_DISPLAY` (see Tests).

## Who sees which version

| Consumer                                                                                                   | Reads                                     | Before  | After                |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------- | -------------------- |
| Webcompat interventions `min_version`/`max_version` (`interventions.js:276`, via `getAppVersion`)          | `appinfo.version`                         | 0.1.0   | 157.0.1              |
| `runtime.getBrowserInfo().version` (`ext-runtime.js`)                                                      | `appinfo.version`                         | 0.1.0   | 157.0.1              |
| Add-on update/install URLs `%APP_VERSION%`, `%CURRENT_APP_VERSION%` (`AddonManager`, `AddonUpdateChecker`) | `appinfo.version`                         | 0.1.0   | 157.0.1              |
| Remote Settings / Normandy JEXL `env.version` (`ClientEnvironment`)                                        | display, **patched** to `MOZ_APP_VERSION` | 0.1.0   | 157.0.1              |
| Nimbus / ASRouter targeting `version` (`Targeting.sys.mjs`)                                                | display, **patched** to `MOZ_APP_VERSION` | 0.1.0   | 157.0.1              |
| ASRouter `firefoxVersion`                                                                                  | `MOZ_APP_VERSION`                         | 0       | 157                  |
| Telemetry probe expiry, Glean metric expiry (build time, `glean_parser_flags`)                             | `MOZ_APP_VERSION`                         | 0.1.0   | 157.0.1              |
| newtab `runtime-metrics-<major>.json` (`AboutNewTabResourceMapping`, `webext-glue/moz.build`)              | `MOZ_APP_VERSION`                         | 0       | 157                  |
| BackupService `appVersion` recorded and compared                                                           | `MOZ_APP_VERSION`                         | 0.1.0   | 157.0.1              |
| `MOZ_APP_MAXVERSION` (langpack/extension max)                                                              | `MOZ_APP_VERSION`                         | `0.*`   | `157.*`              |
| App update URL `%VERSION%` (`UpdateUtils`)                                                                 | `appinfo.version`                         | 0.1.0   | 157.0.1 (M6 decides) |
| Add-on compatibility, blocklist                                                                            | `appinfo.platformVersion`                 | 157.0.1 | 157.0.1              |
| `vimma --version` (`DumpVersion`, `nsAppRunner.cpp`)                                                       | `MOZ_APP_VERSION_DISPLAY`                 | 0.1.0   | **0.1.0**            |
| About dialog (`aboutDialog.js`), Settings "updates" (`about-firefox.mjs`), about:support                   | `MOZ_APP_VERSION_DISPLAY`                 | 0.1.0   | **0.1.0**            |
| Package metadata (`informulate.py`), Windows `.rc` product version                                         | `MOZ_APP_VERSION_DISPLAY`                 | 0.1.0   | **0.1.0**            |
| Sidebar/GenAI Nimbus `minVersion`, `PageloadEvent`, Glean `app_display_version`                            | `MOZ_APP_VERSION_DISPLAY`                 | 0.1.0   | 0.1.0 (Out of scope) |

## Tests (write first)

`tests/browser/browser_vimma_app_version.js` (mochitest browser-chrome). The Firefox version is
`Services.appinfo.platformVersion` (Gecko's `config/milestone.txt`), which for a Firefox release
equals Firefox's app version, so upstream bumps need no test change.

- Given the running browser, then `Services.appinfo.version` and `AppConstants.MOZ_APP_VERSION`
  equal `platformVersion`.
- Given `AppConstants.MOZ_APP_VERSION_DISPLAY`, then it is `0.x.y` (plan §7) and differs from
  `appinfo.version`: Vimma's product version.
- Given `ClientEnvironmentBase.version`, then it equals `platformVersion`.
- Given a `TargetingContext`, when evaluating `version`, then it equals `platformVersion`; and
  `ASRouterTargeting.Environment.firefoxVersion` is its major number.
- Given the webcompat add-on's background page, when calling `browser.appConstants.getAppVersion()`
  (the value `interventions.js` parses), then it equals `platformVersion`.
- Given a test extension, when calling `browser.runtime.getBrowserInfo()`, then `version` equals
  `platformVersion`.
- Given the About dialog, when it has loaded, then the `#version` l10n `version` argument is
  `MOZ_APP_VERSION_DISPLAY`.

`tools/version-files/test/version-files.test.mjs` (Since changed: `version-files.test.ts`, ADR-025)
(vitest): `versionFiles(surferJson)` returns the two files, each with the MPL header as `#` lines
and the version on the last line; it throws when `version.version` or `displayVersion` is missing
or malformed; `writeVersionFiles` creates the directory and writes both.

**Changed assertion** in `browser_vimma_branding.js`: "`appinfo.version` is 0.x" becomes
"`AppConstants.MOZ_APP_VERSION_DISPLAY` is 0.x". Reason: `appinfo.version` is now deliberately
the Firefox version; the 0.x rule (plan §7) is about the product version, which lives in the
display version. The assertion is moved, not loosened; `browser_vimma_app_version.js` adds the
stricter check that `appinfo.version` is exactly the Firefox version.

## Out of scope

- The About dialog's "Vimma 0.x · Firefox N" line (plan §7): needs an `aboutDialog.js` hunk or
  an injection of ours; with this spec the dialog still shows `0.1.0`.
- `runtime.getBrowserInfo().name` stays `Vimma` (Zen reports `Firefox`); add-ons that sniff the
  name are not known to break.
- Restoring a Firefox backup into Vimma: BackupService also refuses a different `appName`
  (`firefox` vs `vimma`), so this spec fixes only the version half.
- The app update URL and update manifest versions (M6). `%VERSION%` is now 157.0.1;
  `%DISPLAY_VERSION%` does not exist in `UpdateUtils`, so M6 picks its own scheme.
- Readers of the display version that only matter with a Nimbus enrollment (Sidebar, GenAI
  `minVersion`) or with telemetry upload (`PageloadEvent`, Glean): both are off
  (m0-mozilla-services).

## Rejected options

| Option                                                                                    | Why rejected                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rewrite `browser/config/version.txt` after Surfer                                         | Surfer's `applyConfig` writes both stock files on every `surfer build`, including the nightly's after `npm run import`; we would race it on every build                        |
| Zen's route: `ZEN_FIREFOX_VERSION` in `AppConstants`, patch each reader (≥ 8 patches)     | Surfer does write `export ZEN_FIREFOX_VERSION=157.0.1` into our mozconfig, but configure only sees it with Zen's `toolkit/moz.configure` hunk; then every reader needs a patch |
| Both files = Firefox version, Vimma version in our own constant                           | `--version`, About dialog, about:support and Settings would all show 157.0.1 and each would need a hunk to show ours                                                           |
| Keep `appinfo.version` = 0.1.0, fix webcompat via `general.useragent.compatMode` or prefs | No pref feeds any of these readers                                                                                                                                             |
| Commit the two files in `src/`                                                            | A second copy of both versions; `bump-surfer-json.py` and release-please would each have to edit it                                                                            |

## Settled (2026-10-09, from the Firefox 157.0.1 tree, Surfer 1.14.9, Zen `dev`, LibreWolf `main`, Floorp `main`)

- **Surfer.** `commands/build.js` `applyConfig` writes `release.displayVersion` (or `1.0.0`) to
  both `browser/config/version.txt` and `version_display.txt` on every `surfer build`, including
  `SURFER_MOZCONFIG_ONLY=1`. The brand config has no separate field; nothing in Surfer reads
  `--with-version-file-path`. `constants/mozconfig.js` appends
  `export ZEN_FIREFOX_VERSION=<version.version>` to every generated mozconfig.
- **Configure.** `milestone()` reads `config/milestone.txt`, `browser/config/version.txt`,
  `browser/config/version_display.txt`, then `<version path>/version.txt` and
  `version_display.txt` if they exist (`<version path>` defaults to `browser/config`). With more
  than three files, `MOZ_APP_VERSION` is the fourth and `MOZ_APP_VERSION_DISPLAY` the last. So
  `--with-version-file-path` makes Surfer's two writes irrelevant without touching them.
- **What reads which.** `application.ini` `Version=@MOZ_APP_VERSION@` → `appinfo.version`;
  `AppConstants.MOZ_APP_VERSION{,_DISPLAY}` are substituted from config; `DumpVersion` prints
  `<vendor> <name> MOZ_APP_VERSION_DISPLAY`; the About dialog formats
  `AppConstants.MOZ_APP_VERSION_DISPLAY` and only tests `appinfo.version` for an `a1` (nightly)
  suffix.
- **Reconfigure.** `config_status_deps` (`moz.configure`) lists only the stock
  `browser/config/version*.txt`, not ours. Surfer rewrites those on every `npm run import`, so
  configure re-runs and re-reads ours anyway; after editing only our files by hand, run
  `./mach configure`.
- **Others.** Zen keeps its own version in both files and patches each reader against
  `ZEN_FIREFOX_VERSION` (`AppConstants`, `ext-runtime.js`, `AddonManager`, `Blocklist`,
  `UpdateUtils`, `aboutDialog.js`). LibreWolf writes the Firefox version to `version.txt` and
  `<firefox>-<release>` to `version_display.txt` (`scripts/librewolf-patches.py`): our choice.
  Floorp writes its own version into both files and keeps Gecko's elsewhere (`tools/src/update.ts`).
- **Profiles.** `appinfo.version` going from 0.1.0 to 157.0.1 is an upgrade, so existing dev
  profiles open without the downgrade prompt; the add-on manager re-checks compatibility once.
- **Build cost**: after `npm run import`, `./mach build` reconfigured and rebuilt for 927 s
  (15.5 min; `MOZ_APP_VERSION` is a define in gfx, telemetry, xre and others); no clobber. A
  second import plus build with unchanged versions took 16 s. `vimma --version` prints
  `Vimma Vimma 0.1.0`; `application.ini` has `Version=157.0.1`.
- **Red/green**: before the change `browser_vimma_app_version.js` failed 8 of 11 checks
  (`Services.appinfo.version - "0.1.0" == "157.0.1"`, likewise `MOZ_APP_VERSION`,
  `ClientEnvironment env.version`, targeting `version`, ASRouter `firefoxVersion` `0 == 157`,
  webcompat `getAppVersion()`, `runtime.getBrowserInfo().version`, and display vs app version
  `"0.1.0" != "0.1.0"`); after it, 11/11 pass and all mochitests pass (120 passed, 0 failed).
