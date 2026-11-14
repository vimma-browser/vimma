# Spec: m0-mozilla-services

Status: implemented · Milestone: M0 · Area: default prefs (`src/browser/branding/vimma/pref/`), build
config (`configs/*/mozconfig`)
Prerequisite: m0-branding and m0-user-agent merged (Vimma brand prefs file; Firefox UA).

## User story

As a Vimma user, my browser does not enrol me in Mozilla's studies or experiments, does not send
crash reports to Mozilla under a Firefox look-alike name, and shows no sponsored content; the
services that keep me safe (certificate revocation, add-on blocklist, Safe Browsing, Sync, add-on
installs) work as they do in Firefox, and I can turn any of these defaults back in
`about:config`.

## Scope

- **Default prefs** in `src/browser/branding/vimma/pref/firefox-branding.js` (ours since
  m0-branding), in a section headed `Mozilla services (spec m0-mozilla-services)`. Values in the
  table below. `pref()` defaults only: nothing is locked.
- **Crash reporter off at build time**: `ac_add_options --disable-crashreporter` in
  `configs/common/mozconfig`; the `--enable-crashreporter` line leaves
  `configs/windows/mozconfig`.
- **Dead mozconfig lines removed**: `mk_add_options MOZ_TELEMETRY_REPORTING=` and
  `mk_add_options MOZ_DATA_REPORTING=` from `configs/{linux,macos,windows}/mozconfig`, replaced by
  a comment in `configs/common/mozconfig` that says why telemetry does not upload (see Settled).
- **Sponsored address-bar suggestions**: `src/browser/base/content/vimma/services/MozillaServices.sys.mjs`,
  called from `vimma.js`, sets `browser.urlbar.suggest.quicksuggest.sponsored` to false on the
  user branch when the user has no value of their own (Firefox Suggest overwrites the default
  branch at runtime, see Settled). It runs at every window, again after `QuickSuggest.initPromise`
  resolves, and whenever `browser.urlbar.quicksuggest.migrationVersion` changes (Suggest's
  migrations, which run at browser-idle-startup after our first window, can clear the value).
  Registered in our `jar.mn`; no upstream file changes.
- `docs/runbook/`: crashes now leave a core dump (systemd-coredump), not a minidump.

## Services

"Default here" is the value in the Firefox 157.0.1 tree as we build it (unofficial, update
channel `vimma`, `MOZ_DATA_REPORTING`, `MOZ_NORMANDY`, `MOZ_SERVICES_HEALTHREPORT` and
`MOZ_CRASHREPORTER` all set by configure). Pref names below are `browser.newtabpage.activity-stream.`
→ `as.` for brevity.

| Service                               | What it does                                                                                                                          | Default here                                                                                                                                                                                    | Ours                                                                         | Why                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normandy                              | Fetches recipes from `normandy.cdn.mozilla.net`: pref studies, rollouts, add-on studies                                               | `app.normandy.enabled` true, `app.normandy.api_url` Mozilla's                                                                                                                                   | `app.normandy.enabled` false, `app.normandy.api_url` ""                      | Mozilla's recipes target Firefox; we do not join them. `RecipeRunner.checkPrefs` disables on either pref                                                                                                                                         |
| Shield / Nimbus opt-out studies       | Nimbus enrols in experiments from Remote Settings `nimbus-desktop-experiments`                                                        | `app.shield.optoutstudies.enabled` true                                                                                                                                                         | false                                                                        | Same; `ExperimentAPI.studiesEnabled` needs this pref and the health-report pref                                                                                                                                                                  |
| Nimbus rollouts                       | Same loader, rollouts (feature configs) instead of studies                                                                            | `nimbus.rollouts.enabled` true                                                                                                                                                                  | false                                                                        | Rollouts change features on a Firefox schedule we do not test against                                                                                                                                                                            |
| Firefox Labs                          | Opt-in features listed in Settings, delivered by Nimbus                                                                               | on (`policies.isAllowed("FirefoxLabs")`)                                                                                                                                                        | unchanged                                                                    | The user opts in per feature; no enrolment without a click                                                                                                                                                                                       |
| Health report / usage upload          | The "send technical and interaction data" switches; also gates Nimbus studies                                                         | `datareporting.healthreport.uploadEnabled` true, `datareporting.usage.uploadEnabled` true                                                                                                       | false, false                                                                 | Nothing uploads (see Settled), so the switches should say so                                                                                                                                                                                     |
| Data-submission policy notice         | The infobar "Vimma automatically sends some data to Mozilla"                                                                          | `datareporting.policy.dataSubmissionEnabled` true                                                                                                                                               | false                                                                        | The notice would be false: we send none                                                                                                                                                                                                          |
| Crash reporter (main process)         | Breakpad/minidump writer; the crash reporter client submits to `crash-reports.mozilla.com`                                            | built in, `ServerURL` Mozilla's, "send" ticked                                                                                                                                                  | `--disable-crashreporter`                                                    | No pref changes the server; Mozilla should not get Vimma crashes. M6 adds opt-in reporting to our own server                                                                                                                                     |
| Tab crash page                        | "Send a crash report" box on the crashed-tab page                                                                                     | `browser.tabs.crashReporting.sendReport` true                                                                                                                                                   | false                                                                        | Opt-in when M6 brings the reporter back                                                                                                                                                                                                          |
| Unsubmitted-crash prompt, auto-submit | Offers or sends pending reports at startup                                                                                            | `browser.crashReports.unsubmittedCheck.enabled` false (non-Nightly), `…autoSubmit2` false                                                                                                       | unchanged                                                                    | Already off                                                                                                                                                                                                                                      |
| Sponsored stories (spocs)             | Paid stories in the new-tab stories feed                                                                                              | `as.showSponsored` true; `as.system.showSponsored` by region                                                                                                                                    | `as.showSponsored` false, `as.system.showSponsored` false                    | No ads                                                                                                                                                                                                                                           |
| Stories feed (ex-Pocket)              | Mozilla-curated stories on the new tab from `merino.services.mozilla.com`                                                             | `as.feeds.section.topstories` true                                                                                                                                                              | false                                                                        | It is the feed the spocs ride in; the user can turn it on under New Tab settings                                                                                                                                                                 |
| Sponsored shortcuts                   | Paid tiles among the new-tab shortcuts (Contile/MARS)                                                                                 | `as.showSponsoredTopSites` true, `browser.topsites.contile.enabled` true                                                                                                                        | both false                                                                   | No ads                                                                                                                                                                                                                                           |
| Sponsored address-bar suggestions     | Firefox Suggest sponsored results                                                                                                     | `browser.urlbar.suggest.quicksuggest.sponsored` true in US, GB, DE, FR, IT and the 157 EU regions (set at runtime by region)                                                                    | false on the user branch, unless the user set it (`MozillaServices.sys.mjs`) | No ads; the user can tick "Suggestions from sponsors" in Settings                                                                                                                                                                                |
| ASRouter remote messages              | What's-new, feature and add-on recommendations from Remote Settings `cfr`                                                             | `as.asrouter.providers.cfr` enabled; `as.asrouter.userprefs.cfr.{addons,features}` true                                                                                                         | provider `"enabled":false`; both userprefs false                             | Messages advertise Firefox features and Mozilla products, and are targeted at Firefox versions                                                                                                                                                   |
| ASRouter Nimbus messages              | Messages delivered as experiments                                                                                                     | on                                                                                                                                                                                              | unchanged                                                                    | Empty once Nimbus studies and rollouts are off                                                                                                                                                                                                   |
| Mozilla product promos                | VPN promo, "More from Mozilla" pane, Pin and Relay promos (ASRouter `promoType`), about:protections mobile-app card and VPN banner    | `browser.vpn_promo.enabled`, `browser.preferences.moreFromMozilla`, `browser.promo.{pin,relay}.enabled`, `browser.contentblocking.report.show_mobile_app` true; `…report.hide_vpn_banner` false | all off (`hide_vpn_banner` true)                                             | Not our products. `browser.promo.syncPromo` (Sync sign-in) stays: Sync is kept; `browser.promo.cookiebanners` is only read by a profile migration                                                                                                |
| Telemetry, Glean                      | Usage pings                                                                                                                           | not uploaded (Settled)                                                                                                                                                                          | unchanged                                                                    | Off at build time already                                                                                                                                                                                                                        |
| **Keep: Remote Settings**             | Signed collections from `firefox.settings.services.mozilla.com` (CRLite, blocklists, certs, …)                                        | on                                                                                                                                                                                              | **unchanged**                                                                | Security-critical: CRLite revocation (`security.remote_settings.crlite_filters.enabled`), intermediates, add-on blocklist                                                                                                                        |
| **Keep: add-on blocklist**            | Blocks malicious add-ons (`extensions.blocklist.enabled`)                                                                             | on                                                                                                                                                                                              | **unchanged**                                                                | Security-critical                                                                                                                                                                                                                                |
| **Keep: Safe Browsing**               | Phishing and malware lists (`browser.safebrowsing.{phishing,malware}.enabled`)                                                        | on                                                                                                                                                                                              | **unchanged** with a key; keyless builds default it off                      | Security-critical. Works in builds made with a Google key (spec `m0-safebrowsing-key`)                                                                                                                                                           |
| **Keep: Firefox Sync**                | Accounts and Sync (`identity.fxaccounts.enabled`)                                                                                     | on                                                                                                                                                                                              | **unchanged**                                                                | Mozilla's Sync servers accept Gecko-based forks (Zen, LibreWolf, Waterfox use them); user-initiated                                                                                                                                              |
| **Keep: AMO**                         | Add-on search, install and updates from `addons.mozilla.org` (`extensions.update.enabled`)                                            | on                                                                                                                                                                                              | **unchanged**                                                                | Add-ons and their security updates                                                                                                                                                                                                               |
| **Keep: GMP (OpenH264, Widevine)**    | Downloads the H.264 codec (WebRTC calls) and the Widevine DRM module from `aus5.mozilla.org/update/3/GMP/…` (`media.gmp-manager.url`) | on                                                                                                                                                                                              | **unchanged** (spec m0-updater)                                              | Deliberate exception: the request carries version, build ID, OS, locale and channel, so Mozilla learns someone runs Vimma and on which platform; in exchange video calls and DRM video work. Users can turn the plugins off in Add-ons > Plugins |

Left as Firefox has them (local features, not Mozilla services; revisit with keyboard UX if they
annoy): the startup default-browser prompt (`browser.shell.checkDefaultBrowser`, which offers
"don't ask again"), local onboarding messages, UITour (only on `mozilla.org` pages).

(Since changed: the Firefox Labs pane is hidden and Firefox's AI features are off by default, the
startup default-browser prompt and the local onboarding messages are off, and UITour's URL is
empty, all as plain prefs; [firefox-surfaces-trim](firefox-surfaces-trim.md), decisions 3 and 13.)

## How the defaults are applied

| Mechanism                              | Upstream patch                                                | User can override                 | Verdict                                                                                |
| -------------------------------------- | ------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| **`firefox-branding.js` (ours)**       | none: Surfer symlinks our copy over the generated one         | yes (about:config, `user.js`)     | **chosen**                                                                             |
| A new prefs file, e.g. `vimma.js`      | a `package-manifest.in` hunk, or the file is not shipped      | yes                               | rejected: loads before `firefox.js` (see Settled), so `firefox.js` wins; needs a patch |
| `#include` in `firefox.js` (Zen's way) | one hunk in `firefox.js`                                      | yes                               | rejected: a patch for no gain over the branding file                                   |
| `distribution/policies.json`           | packaging needs one                                           | **no**: policies lock their prefs | rejected: users could not opt back into studies, stories or crash reporting            |
| Autoconfig (`.cfg`, LibreWolf's way)   | packaging, `general.config.filename` default                  | only for `defaultPref`            | rejected: more moving parts for the same `defaultPref` effect                          |
| Build flags                            | `MOZ_NORMANDY` is `imply_option`ed by `browser/moz.configure` | no                                | used only for the crash reporter, where no pref exists                                 |

The branding prefs file is not preprocessed for non-official brands (`JS_PREFERENCE_FILES` in
`branding-common.mozbuild`), so it cannot `#include` a second file; the services section lives in
it directly.

## Tests (write first)

`tests/browser/browser_vimma_mozilla_services.js` (mochitest browser-chrome). The harness profile
sets user values for several of these prefs (`testing/profiles/*/user.js`: `app.normandy.api_url`,
`nimbus.rollouts.enabled`, `app.shield.optoutstudies.enabled`, `extensions.blocklist.enabled`,
`services.settings.server`, …), so the test reads the **default branch**, which is what Vimma
ships.

- Given the default branch, then each "Ours" value in the table holds, and
  `as.asrouter.providers.cfr` parses to `enabled: false`.
- Given the running browser, when Normandy has initialised `RecipeRunner`, then
  `RecipeRunner.enabled` is false; `ExperimentAPI.studiesEnabled` and `rolloutsEnabled` are
  false. (Service state; under the harness these hold before the change too, because
  `unittest-required/user.js` empties `app.normandy.api_url` and turns studies and rollouts off.
  The default-branch checks are what go red.)
- Given the running browser, then `browser.urlbar.suggest.quicksuggest.sponsored` is false
  (the harness region turns it on by default); given a user value true,
  `MozillaServices.applyUserDefaults()` keeps it; given no user value, it sets false again.
- Given home region DE, locale en-US, Vimma's user value false and
  `quicksuggest.migrationVersion` 0 (a fresh profile), when `QuickSuggest._test_reset()` reruns
  the migrations, then the user value is set again (migration 5 cleared it).
- Given `AppConstants`, then `MOZ_CRASHREPORTER`, `MOZILLA_OFFICIAL` and
  `MOZ_TELEMETRY_REPORTING` are false, so a build that turns on official telemetry fails here.
- Given the default branch, then the kept services keep Firefox's values:
  `security.remote_settings.crlite_filters.enabled`, `extensions.blocklist.enabled`,
  `identity.fxaccounts.enabled`, `extensions.update.enabled` true (Safe Browsing's prefs moved
  to `browser_vimma_safebrowsing.js`, spec m0-safebrowsing-key); no default
  `services.settings.server`, and
  `AppConstants.REMOTE_SETTINGS_SERVER_URLS[0]` is `firefox.settings.services.mozilla.com`;
  `extensions.getAddons.get.url` is AMO's.

## Out of scope

- Opt-in crash reporting to our own server, update server and update manifest (M6); until then
  the app updater is not built and system add-on updates are off (spec m0-updater).
- A Safe Browsing API key (Open issues).
- Telemetry prefs beyond the switches above (`toolkit.telemetry.*`): nothing uploads.
- Hardening beyond Firefox's privacy model (LibreWolf-style), search engine defaults, DoH.

## Settled (2026-10-09, from the Firefox 157.0.1 tree, Zen `dev` and LibreWolf `settings`)

- **Why telemetry does not upload.** `MOZ_TELEMETRY_REPORTING` is an env option of
  `toolkit/moz.configure` defaulting to `MOZILLA_OFFICIAL`, which we do not set; Glean is built
  with `glean_disable_upload`. `mk_add_options` only exports to `make`, never to configure, so
  `mk_add_options MOZ_TELEMETRY_REPORTING=` did nothing either. `MOZ_DATA_REPORTING` is computed
  (`toolkit/moz.configure`: telemetry or health report or crash reporter or Normandy), so its
  `mk_add_options` line did nothing; it stays set because `browser/moz.configure` implies
  `MOZ_NORMANDY` and `MOZ_SERVICES_HEALTHREPORT` is on. Its effect is pref defaults
  (`datareporting.*`, `app.shield.optoutstudies.enabled`), which our prefs override.
- **Pref file order.** App default prefs load in reverse alphabetical order, so the last loaded
  (winning) file is the alphabetically first: `firefox-branding.js` beats `firefox.js`
  (`Preferences.cpp`, `pref_LoadPrefsInDir` and the omni.ja branch). A `vimma.js` would load first
  and lose.
- **Newtab defaults respect ours.** `DefaultPrefs.init` (`ActivityStreamPrefs.sys.mjs`) skips any
  pref that already has a default, so file defaults win over `PREFS_CONFIG`, including the
  region-computed `system.showSponsored`.
- **Crash reporter.** `ServerURL` comes from `application.ini` (`build/application.ini.in`,
  `MOZ_CRASHREPORTER_URL`, default `https://crash-reports.mozilla.com`); there is no pref for it,
  and the client's "submit" box is ticked by default. Pointing `--with-crashreporter-url` at a
  host we do not run would only make submissions fail. Zen disables the reporter in release
  builds, LibreWolf in all builds. Without it, a crash goes to systemd-coredump, which the
  `diagnose-crash` workflow already reads.
- **Firefox Suggest owns its defaults.** `QuickSuggest.sys.mjs` saves the file defaults, then
  writes region/locale defaults to the default branch on every startup and on region change
  (`intendedDefaultPrefs`), so a prefs-file default for `suggest.quicksuggest.sponsored` loses
  wherever Suggest is on, Finland included (bug 2066294's EU list). There is no Nimbus fallback
  pref to set. The pref is `sticky`, so a user-branch false is kept even if it equals a default,
  and Settings writes a user value when the user ticks it; our module writes only when there is
  none. Policies (`FirefoxSuggest.SponsoredSuggestions`) would lock it; rejected as above.
- **Suggest migrations clear our value on a fresh profile.** `QuickSuggest.init` runs at
  browser-idle-startup (`BrowserComponents.manifest`), after our first window; with
  `migrationVersion` 0 every migration runs, and `_migrateUserPrefsTo_5` clears the user value
  for DE/FR/IT with an English locale. In this tree that alone does not show sponsored results
  (DE/FR/IT turn the default on only for `de`/`fr`/`it`), but nothing would put our value back
  until the next window, and a later upstream default could make it visible. We re-apply after
  `initPromise` (as `Policies.sys.mjs` does for `FirefoxSuggest`) and on the migration-version
  pref change, which the mochitest drives.
- **Accepted: our value looks like the user's.** Once written, the sponsored pref's user value
  cannot be told from a real choice of false, and an about:config "Reset" is undone at the next
  window. Accepted: the only way to keep sponsored results on is to tick them in Settings, which
  stores true. The pref is not synced (`services.sync.prefs.sync.*` has no entry for it), so our
  value does not spread to other devices.
- **Prettier and pref files.** Prettier wraps the long `providers.cfr` line and adds a trailing
  comma, which libpref's parser rejects ("expected pref attribute after ','"), dropping the pref;
  the line carries `// prettier-ignore` with that reason.
- **ASRouter provider pref.** Providers are JSON prefs; ours is a full copy of upstream's value
  with `"enabled":false`, so flipping it back in `about:config` gives a working provider (a bare
  `{"id":"cfr","enabled":false}` would leave a broken one). It shadows upstream's value, so each
  rebase must refresh the copy from `firefox.js` (`docs/runbook/ci-upstream-bumps.md`, Upstream
  bumps); the
  mochitest checks only the id and `enabled`.
- **Build cost**: after `npm run import`, `./mach build` with `--disable-crashreporter` took
  1763 s (29 min, reconfigure plus a large C++/Rust rebuild); no clobber. Prefs in the branding
  file alone need no build in a local tree (`dist/bin` symlinks it); `surfer build --ui` is not
  enough for the crash-reporter flag or the new `jar.mn` entry.
- **Red/green**: before, the mochitest failed 22 of 35 checks (every default above still
  Firefox's, `MOZ_CRASHREPORTER` true, a default `services.settings.server` check written wrong
  and fixed to `prefHasDefaultValue`); with the Suggest task added, 37/37 pass. All five Vimma
  mochitests pass (99 checks). Hardening: the new promo prefs and the migration test failed
  5 of 47 (`Vimma's value is set again - false == true`); after the fix 47/47, all 109 checks
  pass. No C++ rebuild (prefs and our module are symlinked into `dist/bin`).
- **Zen and LibreWolf.** Zen: generated `zen.js` included from `firefox.js`; Normandy off with
  `api_url` locked empty, studies locked off, newtab stories and sponsored off, nothing for
  Nimbus. LibreWolf: `librewolf.cfg` `lockPref`s plus `policies.json`
  (`DisableFirefoxStudies`, `DisableTelemetry`, `FirefoxHome`, `UserMessaging`); locks everything.
  We take Zen's unlocked approach and LibreWolf's coverage of Nimbus and ASRouter.

## Open issues

- **Resolved by m0-safebrowsing-key:** builds with a key file get the key; keyless builds default
  phishing and malware off at runtime, so Settings is honest. Download reputation is off in every
  build (Google serves it only to Mozilla's key). The note below is kept as found.
- **Known gap (resolved, see above): Safe Browsing does not work.** Our build has
  `MOZ_GOOGLE_SAFEBROWSING_API_KEY` `no-google-safebrowsing-api-key`, and `SafeBrowsing.sys.mjs`
  skips every Google provider when the key is that placeholder, so no phishing, malware or
  download-reputation lists are fetched; only Mozilla's tracking-protection lists (`shavar`) update. Settings still shows "Block
  dangerous and deceptive content" ticked. No pref hides or qualifies that checkbox
  (`browser/components/preferences/config/privacy.mjs` has no visibility gate for it); the only
  pref route is turning `browser.safebrowsing.{phishing,malware}.enabled` off, which would make
  the UI truthful but must then be undone when the key lands, so it is left on. Follow-up spec
  `m0-safebrowsing-key`: the key (`--with-google-safebrowsing-api-keyfile`, a CI secret).
- **Version-gated Remote Settings filters** saw `0.1.0` (m0-user-agent Open issues); since
  m0-app-version they see the Firefox version. CRLite and the blocklist are not version-gated, so
  they were unaffected.
- **M6:** opt-in crash reporting (re-enable the reporter with `--with-crashreporter-url` pointing
  at our server, `browser.tabs.crashReporting.sendReport` stays false), and the update manifest.
