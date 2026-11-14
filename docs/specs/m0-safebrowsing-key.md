# Spec: m0-safebrowsing-key

Status: implemented · Milestone: M0 · Area: build config
(`configs/common/mozconfig`), default prefs (`src/browser/branding/vimma/pref/`), CI
(`.github/workflows/{nightly,release}.yml`), `MozillaServices.sys.mjs`, `tools/mochitest.mjs`,
`tools/safebrowsing-smoke`
Prerequisite: m0-mozilla-services merged (it lists Safe Browsing as a known gap pointing here),
m0-updater merged (same full rebuild).

## User story

As a Vimma user, Google Safe Browsing protects me from phishing, malware and unwanted-software
sites as in Firefox, on by default, and I can turn it off in Settings or `about:config`. If I
build Vimma myself without a Google API key, Settings tells me honestly that the protection is
off instead of showing it ticked.

## Scope

- **Key at build time.** `configs/common/mozconfig` passes
  `--with-google-safebrowsing-api-keyfile=<file>` only when the key file exists: the file named
  by `VIMMA_SAFEBROWSING_KEYFILE`, else `$HOME/.config/vimma/keys/safebrowsing`. Without one,
  the option is left out and configure uses its keyless default. A `VIMMA_SAFEBROWSING_KEYFILE`
  naming no file stops the build (a CI step that lost its file must not build keyless silently).
- **Only the lists our key gets.** `firefox-branding.js` sets
  `browser.safebrowsing.provider.google{4,5}.lists` to upstream's values without
  `goog-badbinurl-proto` and `goog-downloadwhite-proto`, and
  `browser.safebrowsing.downloads.remote.enabled` false (Settled: Google serves those only to
  Mozilla's key).
- **Honest keyless state.** `MozillaServices.applySafeBrowsingDefaults()` (our module, run from
  `vimma.js` at every window) sets the **default branch** of
  `browser.safebrowsing.phishing.enabled` and `browser.safebrowsing.malware.enabled` to false when
  `AppConstants` has no key. With a key it changes nothing (Firefox's defaults, true).
- **CI.** `nightly.yml` writes the `SAFEBROWSING_API_KEY` secret to a mode-600 file in
  `$RUNNER_TEMP` with a shell builtin (our steps never echo it nor put it on a command line;
  upstream's build does: it passes `-DMOZ_GOOGLE_SAFEBROWSING_API_KEY=…` to the preprocessor, so
  the key shows in `/proc` during the build, and it stays in mode-644 configure output in the
  objdir: `config.status*`, `config/autoconf.mk`, `toolkit/modules/backend.mk`; keep the runner
  single-user. The nightly scrubs the key from its log before the artifact upload and the failure
  issue, where secret masking doesn't apply), exports
  `VIMMA_SAFEBROWSING_KEYFILE`, and deletes the file after the last `mach` call (`if: always()`;
  `mach` re-reads the mozconfig on every call, so the file must outlive tests and packaging). A
  missing secret fails the nightly. PR builds (`e2e.yml`) get no secret and build keyless.
  `release.yml`'s `build` job (merged from PR #23 during this spec) does the same, and its smoke
  check fails a build whose `AppConstants` still has the placeholder (it runs no mochitests).
  `tools/test/safebrowsing-workflows.test.mjs` checks the steps in both and that no other release
  job and no PR workflow mentions the secret.
- **Test expectation.** `tools/mochitest.mjs` passes `--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=1|0`
  to the browser: `VIMMA_EXPECT_SAFEBROWSING_KEY` from the environment if set (the nightly sets
  `1`), else whether the key file exists.
- **Smoke script** `tools/safebrowsing-smoke/safebrowsing-smoke.sh`: launches the real build
  headless on a temp profile and waits for Google's lists to land on disk.
- Docs: `docs/guide.md` (what it does, how to opt out; uBlock Origin with its malware and
  phishing lists), `docs/limits.md`, `docs/runbook/` (providing, rotating and debugging the
  key; refreshing the list prefs on upstream bumps), README status, m0-mozilla-services.
- No upstream patch, no new dependency.

## How the key reaches the browser (Firefox 157.0.1 tree)

- `toolkit/moz.configure:1153` `simple_keyfile("Google Safebrowsing API")`, the template in
  `build/moz.configure/keyfiles.configure`, defines `--with-google-safebrowsing-api-keyfile`.
  With the option, configure reads the file and strips it; an empty file or an unreadable path is
  a `FatalCheckError` (the build stops). Without it, the value is the string
  `no-google-safebrowsing-api-key`. Either way `set_config("MOZ_GOOGLE_SAFEBROWSING_API_KEY")`.
  configure prints only "checking for the Google Safebrowsing API key... yes/no"; the key itself
  is in the objdir (`config.status`), never in the repo.
- `toolkit/modules/moz.build:299` passes it as a `DEFINE` into the preprocessed
  `AppConstants.sys.mjs:185` (`MOZ_GOOGLE_SAFEBROWSING_API_KEY: "@…@"`).
- `URLFormatter.sys.mjs:127` resolves `%GOOGLE_SAFEBROWSING_API_KEY%` from AppConstants;
  `all.js:3393–3430` use it in the `google`, `google4`, `google5` provider URLs and the download
  reputation URL. `trimSensitiveURLs` (`URLFormatter.sys.mjs:180`) replaces it in Safe Browsing's
  debug log.
- `SafeBrowsing.sys.mjs:537` `checkGoogleSafeBrowsingKey` returns false for every `google*`
  provider when the formatted key is empty or the placeholder, and `updateProviderURLs` then
  clears that provider's update and gethash URLs: no Google list is ever fetched. `google5` is
  enabled (`all.js:3427`) and preferred over `google4` where a table exists in both.
- `UrlClassifierListManager.sys.mjs:459`: the first update runs 3 s plus up to 60 s after
  `SafeBrowsing.init`, which BrowserGlue runs as an early idle task (`BrowserGlue.sys.mjs:1084`).
- **Artifact builds pick the key up.** `AppConstants.sys.mjs` is an `EXTRA_PP_JS_MODULES` file,
  preprocessed in our objdir, not taken from Mozilla's binaries. `tools/artifact-build` copies
  `engine/mozconfig`, conditional included. Measured: the local artifact build with the key file
  has no placeholder in `obj-artifact/dist/bin/modules/AppConstants.sys.mjs`; with `HOME` pointed
  at an empty directory (as on a PR runner) it has the placeholder.

## Options for the keyless state

| Option                                                                       | Settings                                                                                 | Network | Verdict                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| Leave Firefox's defaults                                                     | "Block dangerous and deceptive content" ticked, protects nothing                         | none    | rejected: the checkbox lies                                                                   |
| Prefs file defaults false                                                    | honest keyless, but **keyed builds too** ship it off                                     | none    | rejected: keyed builds must keep it on; the branding prefs file is not preprocessed, no `#if` |
| **Runtime default-branch false when `AppConstants` has no key** (our module) | unticked, the "Safe Browsing is off" security warning shows, download sub-options greyed | none    | **chosen**: keyed builds keep Firefox's defaults; no user value is written                    |
| Same, on the user branch                                                     | same                                                                                     | none    | rejected: would survive into a later keyed build and look like the user's choice              |

Default-branch values set at runtime are not saved, so a keyless build never leaves a trace in the
profile; the same profile in a keyed build gets Firefox's `true` back. SafeBrowsing observes
`browser.safebrowsing.*` and re-reads its prefs on change, and runs only at idle after our first
window anyway. `downloads.enabled` (the "Block dangerous downloads" box) stays on in every build:
under an unticked parent box it is greyed out, and turning it off would add a second permanent
security warning to Settings for a check that has no lists to use (Settled).

## Tests (write first)

`tests/browser/browser_vimma_safebrowsing.js` (both builds). It never prints the key: only
booleans, lengths, URL hosts.

- Given `VIMMA_EXPECT_SAFEBROWSING_KEY` (`1` or `0`), then the build has a key exactly when
  expected (a nightly that lost its secret, or a PR build that gained one, fails here).
- Given the default branch, then the `google4` and `google5` lists include neither Mozilla-only
  download table and still include `googpub-phish-proto`, `goog-malware-proto` and
  `goog-unwanted-proto`; `downloads.remote.enabled` is false.
- Keyed: `AppConstants.MOZ_GOOGLE_SAFEBROWSING_API_KEY` has length > 0 and is not the
  placeholder; `checkGoogleSafeBrowsingKey("google4")` and `("google5")` are true; the
  default-branch `google4` and `google5` update URLs, formatted, are on
  `safebrowsing.googleapis.com`, contain no `%GOOGLE_SAFEBROWSING_API_KEY%`, and their `key`
  parameter is non-empty and not the placeholder; the running `SafeBrowsing` has a non-empty
  `google4` update URL (the harness points it at a local dummy) and maps the three fetched tables
  to `google5`; phishing and malware keep Firefox's default true.
- Keyless: phishing and malware default to false, with no user value; the running `SafeBrowsing`
  has empty `google4`/`google5` update URLs; Settings > Privacy shows `#enableSafeBrowsing`
  unticked.
- Either build: `applySafeBrowsingDefaults("no-google-safebrowsing-api-key")` and `("")` set both
  defaults false; `applySafeBrowsingDefaults("<a fake key>")` leaves them as they were.
- `browser_vimma_mozilla_services.js`: phishing and malware move out of the always-true "kept"
  list; they are checked here instead (true keyed, false keyless).

`tools/test/mochitest.test.mjs`: the expectation is passed as `--setenv`, from the key file's
presence or an explicit environment value.
`tools/test/safebrowsing-workflows.test.mjs`: the nightly and release `build` jobs write the key
file with a builtin, never echo the secret, delete the file `if: always()`, and check the result
(nightly: `VIMMA_EXPECT_SAFEBROWSING_KEY=1`; release: the placeholder grep); no other release job
and not `e2e.yml` mention the secret.

**List updates need the network**, which mochitests block (non-local connections abort the
run). A mocked server would only test Firefox's list manager against our fake, not that our key
works with Google, which is what breaks: this spec's own first smoke run found that the stock
list set fetches nothing with a non-Mozilla key, which no mock would have shown. So:
`tools/safebrowsing-smoke/safebrowsing-smoke.sh [bin] [seconds]`, documented in the runbook,
launches the real build headless on a temp profile, waits (default 180 s) until
`googpub-phish-proto`, `goog-malware-proto` and `goog-unwanted-proto` all have data in the
profile's `safebrowsing/` directory, and prints only table file names and sizes; the browser's
output goes to a temp file that is deleted. Run it after a key change, an upstream bump, and
before a release; not in CI (PR CI is keyless and the nightly is not live).

## Out of scope

- Google's other keys (location service, Bing); Mozilla's `shavar` lists (unchanged, keyless).
- Our own Safe Browsing proxy, or hiding the key from binaries (impossible client-side).
- Restoring download reputation (needs Mozilla's key or Google's agreement).

## Settled (2026-10-09, Firefox 157.0.1 tree, measured against Google with our key)

- **Google serves our key only part of Firefox's list set.** Status codes with our key: v5
  `hashLists:batchGet` 200 for `se-4b` (phishing), `mw-4b` (malware), `uws-4b` (unwanted),
  `pha-4b`, `gc-32b`; **404 for `mwb-4b` (`goog-badbinurl-proto`) and `csdda-32b`
  (`goog-downloadwhite-proto`)**. v4 `threatListUpdates:fetch`: 200 for MALWARE, **403** once
  MALICIOUS_BINARY is in the batch. `sb-ssl.google.com/safebrowsing/clientreport/download`
  (remote download check): **403** with our key (400 with the placeholder). One refused list
  fails the whole batch: the first keyed smoke run fetched nothing ("download error for
  googpub-phish-proto,goog-malware-proto,…: 404" in the redacted debug log). These are
  Mozilla-negotiated lists; dropping the two tables from the provider lists makes the batch
  succeed. The cost is download reputation (limits.md); the site lists still apply to every
  load, downloads included.
- **`downloads.enabled` stays on.** Off, Settings would show the "Safe Browsing is off" warning
  permanently in keyed builds, nudging users to turn on a check that has no lists. On, it is
  harmless. Documented in the guide and limits instead.
- **Debug logging redacts the key.** With `browser.safebrowsing.debug`, provider URLs are logged
  with `key=[trimmed-google-api-key]` (`URLFormatter.trimSensitiveURLs`); measured: the key does
  not appear in the log. This spec's diagnosis still read the log only through a filter.
- **Expectation, not inference.** The test must fail a nightly that lost its secret, so it
  compares with an expectation passed in, rather than branching on AppConstants alone.
- **Build cost**: after rebasing onto PR #15 (`--disable-updater`), `npm run import` then
  `./mach build` took 101 s: the objdir had already been fully rebuilt with `--disable-updater`
  for PR #15's own testing, so this measures only the key (reconfigure, `AppConstants` and
  dependants). The artifact build took 21 s. The list prefs need no build (`dist/bin` symlinks
  the branding file).
- **Red/green.** Vitest: 4 failing (`expectSafeBrowsingKey is not a function`), then 8/8.
  Mochitest on the keyless full build before the change, with the key file present: 6 failures
  (`build has a Safe Browsing key: false - false === true`; the three keyless defaults
  `true === false`; `Settings shows Safe Browsing off - true === false`;
  `applySafeBrowsingDefaults is not a function`). After the smoke finding, the list task went red
  first: 5 failures (both providers still asked for both download tables;
  `no remote download checks - true === false`). Green: full build (keyed) 252 passed, 0
  failed, 3 todo across the suite, `browser_vimma_safebrowsing.js` 38/38; artifact build
  (keyed) 235 passed, 0 failed; artifact build keyless (`HOME` on an empty directory, as PR CI)
  `browser_vimma_safebrowsing.js` 30/30 and `browser_vimma_mozilla_services.js` 44/44.
- **Final runs** (rebased on `main` with PR #23 and the split-view spike): full build (keyed)
  486 passed, 0 failed, 3 todo; artifact build (keyed) 469 passed, 0 failed, 2 todo. One earlier
  full-build run died before any test (Marionette could not install the mochikit add-on,
  `ERROR_FILE_ACCESS`, right after an incremental build); the re-run passed unchanged.
- **Workflow test**: red with `release.yml` as merged from PR #23 (1 of 3 failed: no key-file
  step), green 3/3 after.
- **Smoke.** Keyed full build: all three tables after 60–70 s (`googpub-phish-proto.vlpset`
  ~4.9 MB, `goog-malware-proto.vlpset` ~279 KB, `goog-unwanted-proto.vlpset` ~106 KB, stored
  under `google4/`). Keyless builds: only Mozilla's `*-digest256` tables, exit 1. v5
  `hashes:search` (the full-hash confirmation) answers our key 200.

## Open issues

- Each upstream bump must refresh the two `lists` copies from `all.js` (runbook, Upstream bumps).
