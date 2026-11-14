# Spec: m0-user-agent

Status: implemented · Milestone: M0 · Area: build config (`src/browser/moz-configure.patch`)
Prerequisite: m0-branding merged (brand, basename and vendor are Vimma; `displayVersion` 0.1.0).

## User story

As a Vimma user, websites see the same user agent as Firefox 157.0 on my platform, so sites that
sniff for `Firefox/` work, and nothing in the UA reveals or depends on the Vimma brand.

## Scope

- **UA name**: `src/browser/moz-configure.patch` gains one line in its existing hunk,
  `imply_option("MOZ_APP_UA_NAME", "Firefox")`. With it `nsHttpHandler` treats the app as
  Firefox: it appends `Firefox/<major>.0` and no `<AppName>/<version>` token.
- ADR-003's patch register: the `moz-configure.patch` row names both lines.
- `docs/runbook/`: the expected UA in the smoke check.
- **Version gating**: researched below (Settled). Nothing changes in this spec; the findings are
  recorded as open issues for the versioning work (plan §7, M6).

## Tests (write first)

- `tests/browser/browser_vimma_user_agent.js` (mochitest browser-chrome), with the expected token
  derived as `Firefox/${parseInt(Services.appinfo.platformVersion)}.0`, so upstream bumps need no
  test change:
  - Given a browser window, when reading chrome `navigator.userAgent`, then it contains and ends
    with `Firefox/157.0`, contains `rv:157.0)`, and does not contain `Vimma`.
  - Given a tab with `https://example.com/`, when reading `content.navigator.userAgent` through
    `SpecialPowers.spawn`, then the same holds.

## Out of scope

- Changing `appinfo.version` / `MOZ_APP_VERSION` back to the Firefox version, or patching the
  places that read it (see Open issues).
- Update URLs and the update server (M6).
- `navigator.userAgentData`/Client Hints (not shipped by Firefox 157 on desktop).
- Per-site UA overrides. The bundled webcompat interventions are version-gated and misfired
  until m0-app-version (see Open issues).

## Settled (2026-10-09, from the Firefox 157.0.1 tree, Surfer 1.14.9 and Zen's `dev` branch)

- **How the UA is built** (`netwerk/protocol/http/nsHttpHandler.cpp`): `mAppName` is
  `MOZ_APP_UA_NAME`; if that is empty it falls back to `appinfo.UAName` (null in our
  `application.ini`) and then `appinfo.name` ("Vimma"), with `appinfo.version` as `mAppVersion`.
  `BuildUserAgent` appends `Firefox/MOZILLA_UAVERSION` only when `mAppName == "Firefox"` or pref
  `general.useragent.compatMode.firefox` is true, and appends `<mAppName>/<mAppVersion>` whenever
  the name is not Firefox. Before: `Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101
Vimma/0.1.0`. After: `… Gecko/20100101 Firefox/157.0`, byte-identical to Firefox 157.0's.
  `MOZILLA_UAVERSION` comes from `config/milestone.txt` (major only), not from our version files.
- **Why not a pref or a mozconfig line.** `general.useragent.compatMode.firefox` would add
  `Firefox/157.0` but keep `Vimma/0.1.0`; `general.useragent.override` is a fixed string that
  breaks per platform and per upstream bump. `MOZ_APP_UA_NAME` is a `project_flag`
  (`toolkit/moz.configure`), which `build/moz.configure/util.configure` declares with
  `possible_origins=("implied",)`, so an `export` in a mozconfig is rejected; only
  `imply_option` sets it. Firefox for Android does exactly this (`mobile/android/moz.configure`).
  Zen gets the same result by changing the flag's default in `toolkit/moz.configure` (LibreWolf's
  `firefox-in-ua.patch`); our line sits in the patch we already carry, so no new patch file.
- **Add-ons use the Gecko version: yes.** WebExtensions get `targetApplications =
[{ id: "toolkit@mozilla.org", minVersion: strict_min_version, … }]` (`XPIInstall.sys.mjs`), and
  `isCompatibleWith` compares the toolkit id against `appinfo.platformVersion` (157.0.1)
  (`XPIDatabase.sys.mjs`). The blocklist compares `platformVersion` too. So `strict_min_version`
  works.

- **Build cost**: after `npm run import`, `./mach build` reconfigured and rebuilt the HTTP handler
  in 101 s; no clobber. `vimma --version` still prints `Vimma Vimma 0.1.0`.
- **Red/green**: before the patch the mochitest failed 6 of 8 checks (chrome and content UA
  `… Gecko/20100101 Vimma/0.1.0`); after it, 8/8 pass with `… Gecko/20100101 Firefox/157.0`.

## Open issues (versioning work, plan §7 / M6)

Addressed by [m0-app-version](m0-app-version.md): `appinfo.version` and `MOZ_APP_VERSION` become
the Firefox version, `MOZ_APP_VERSION_DISPLAY` stays Vimma's, and `ClientEnvironment` and
`Targeting` read the former. Its "Who sees which version" table supersedes the list below, which
records the state before it.

Surfer writes `displayVersion` into both `browser/config/version.txt` and `version_display.txt`,
so `appinfo.version`, `MOZ_APP_VERSION` and `MOZ_APP_VERSION_DISPLAY` are all `0.1.0`. Places
that read them as a Firefox version (Zen patches each of them against its own
`ZEN_FIREFOX_VERSION`, which Surfer already writes into our mozconfig as `157.0.1`):

- `runtime.getBrowserInfo()` reports `version: "0.1.0"` (`ext-runtime.js`); add-ons that gate on
  it see a very old Firefox.
- Add-on update and install URLs: `%APP_VERSION%`/`%CURRENT_APP_VERSION%` are `0.1.0`
  (`AddonManager.sys.mjs`, `AddonUpdateChecker.sys.mjs`); AMO may offer wrong versions.
- Update URL `%VERSION%` is `0.1.0` (`UpdateUtils.sys.mjs`); M6 owns updates anyway.
- Normandy, Nimbus and Remote Settings JEXL filters see `env.version` = `0.1.0`
  (`ClientEnvironment.sys.mjs` returns `MOZ_APP_VERSION_DISPLAY`), so records gated on a Firefox
  version are filtered out. ASRouter's `firefoxVersion` is `0`.
- Webcompat interventions gate on `Services.appinfo.version`
  (`browser/extensions/webcompat/lib/interventions.js:276`): 16 with `min_version` are skipped and
  11 with `max_version` ≤ 150 still apply, so sites fixed upstream keep old UA spoofs. This PR does
  fix `ua_helpers.js:45`, which fell back to `Firefox/58.0` without a Firefox token.
- Telemetry probe expiry compares `MOZ_APP_VERSION` (`TelemetryControllerParent.sys.mjs`), so no
  probe ever expires; newtab looks for `runtime-metrics-0.json`
  (`AboutNewTabResourceMapping.sys.mjs`); backups record `appVersion: 0.1.0` and refuse to
  restore a backup whose `appVersion` is higher (`BackupService.sys.mjs`), so a Firefox backup
  cannot be restored into Vimma.

Options were (a) keep `version.txt` at the Firefox version and only `version_display.txt` at
ours, or (b) Zen's route, patching each reader to use `ZEN_FIREFOX_VERSION`. m0-app-version
chose (a) without fighting Surfer, through configure's `--with-version-file-path`, and rejected
(b) as too many patches.
