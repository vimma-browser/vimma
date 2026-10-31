# Spec: m0-branding

Status: implemented · Milestone: M0 · Area: branding (`configs/branding/vimma/`, `src/browser/branding/vimma/`)
Prerequisite: Surfer project set up and `npx surfer build` succeeded once (plan §10 step 3).

## User story

As the vimma developer, the browser I build calls itself Vimma: `vimma --version`, the window
title, `about:` pages and the app's name and vendor say Vimma, not Mozilla or Nightly, and every
local or CI build picks this brand without anyone remembering a flag.

## Scope

- **Brand inputs** in `configs/branding/vimma/` (the directory Surfer's branding patch reads):
  `logo.png`, `logo-mac.png`, `firefox.ico`, `firefox64.ico`, `logo{16,22,24,32,48,64,128,256,512}.png`,
  and `content/` overrides for every image the Linux build packages into `chrome://branding/`
  (`about.png`, `about-logo.svg`, `about-logo-private*.png`, `about-wordmark.svg`,
  `firefox-wordmark.svg`, `document_pdf.svg`) plus `document.ico`.
- **Placeholder logo**: a plain "V" monogram on a dark rounded square, drawn as SVG paths
  (no font, no Mozilla artwork). Source `configs/branding/vimma/logo.svg` and
  `wordmark.svg`; `tools/branding/render.sh` renders every PNG/ICO with `rsvg-convert` and
  ImageMagick. Replace when real artwork exists. **Since replaced** by the window+V mark
  (`docs/assets/vimma-mark.png`, keyed transparent from the square logo);
  `render.sh` now renders every icon from it, and `logo.svg`/`about-logo.svg` embed it as a PNG.
  (Since changed: the mark moved from mint to the aqua palette, its hue turned 20 degrees, and
  the brand colours left over from Tokyo Night went with it: `surfer.json`'s `backgroundColor`,
  the About dialog's `about.png` tile, the macOS icon's fill and the wordmark's fallback stroke
  are teal-black, `#071011`, and the PDF document icon takes the aqua `#2cf5d2`.)
- **Brand config** in `surfer.json`: `brands.vimma` with short/shorter/full name "Vimma",
  background colour and `release.displayVersion` (`0.1.0`, plan §7: `0.x` until M6).
- **Brand selection by default**: `npm run import` runs `surfer config brand vimma` before
  `surfer import` and regenerates `engine/mozconfig` (`SURFER_MOZCONFIG_ONLY=1 surfer build`)
  after it, so `npm run import && (cd engine && ./mach build)` and the nightly's
  `npm run import && npx surfer build` both build the Vimma brand.
- **App name**: `configs/common/mozconfig` sets `MOZ_APP_BASENAME` to the display name `Vimma`
  (Firefox's convention: basename `Firefox`, app name `firefox`).
- **Vendor**: `src/browser/moz-configure.patch`, one line, `imply_option("MOZ_APP_VENDOR", "Vimma")`.
- **Branding prefs**: `src/browser/branding/vimma/pref/firefox-branding.js` replaces the prefs
  file Surfer generates (which points the welcome/what's-new pages at zen-browser.app).
- `docs/runbook.md`: new `--version` output, the branding symptoms removed.

## Tests (write first)

- `tests/browser/browser_vimma_branding.js` (mochitest browser-chrome):
  - Given the built browser, when reading `Services.appinfo`, then `name` is `Vimma` and `vendor`
    is `Vimma`.
  - Given the branding Fluent bundle (`branding/brand.ftl`), when formatting
    `-brand-short-name`, `-brand-full-name`, `-brand-product-name` and `-vendor-short-name`
    (through a test message), then each is `Vimma`; `brand.properties` `brandShortName` is
    `Vimma`.
  - Given a browser window, when reading `document.title`, then it ends with `Vimma`, not
    `Nightly` or `Firefox`.
  - Given `chrome://branding/content/about-logo.svg`, when fetched, then it is our mark
    (contains `vimma-mark`; `vimma-placeholder` until the real logo replaced the placeholder).
  - Given an emptied bookmarks tree and `browser.bookmarks.restore_default_bookmarks`, when
    Places init is re-run, then `bookmarks-restore-success` fires, not `bookmarks-restore-failed`.
- Given the default branch, then every pref the stock brands' `firefox-branding.js` define has a
  default (`app.update.checkInstallTime.days` and `app.update.badgeWaitTime` as ints); given
  `app.update.checkInstallTime` true, BrowserGlue's `_checkForOldBuildUpdates` does not throw;
  `about:home` and `about:newtab` render `body.activity-stream` with no `AboutNewTabRedirector`
  console error.
- `tools/branding/test/branding-prefs.test.mjs` (Vitest): our prefs file sets every pref name
  upstream's `unofficial/pref/firefox-branding.js` sets. Needs `engine/`, so it skips in the CI
  job and runs in the e2e job after `npm run import`.
- `--version` smoke check (runbook): `engine/obj-*/dist/bin/vimma --version` prints
  `Vimma Vimma 0.1.0` (since spec firefox-versions: `Vimma 0.1.0 · Firefox <version>`).

## Out of scope

Real artwork; Windows/macOS-only assets (installer bitmaps, `.icns`, MSIX, `Assets.car`,
VisualElements stay Surfer's copies of `unofficial` until M7); the About dialog's
"Vimma 0.x · Firefox N" line (plan §7); update URLs and update channel hosting (M6); the content
of the default bookmarks (still Mozilla's links; see Settled).

## Settled (2026-10-09, from Surfer 1.14.9's source and the Firefox 157.0.1 tree)

- **Two directories, as Surfer forces.** Surfer's branding patch reads `configs/branding/<name>/`
  (hard-coded `BRANDING_DIR`) and writes `engine/browser/branding/<name>/`, filling in every file
  we do not supply from `browser/branding/unofficial`. The plan's `browser/branding/vimma/` is
  therefore `configs/branding/vimma/` for inputs; `src/browser/branding/vimma/` holds only files
  that must replace Surfer's generated output (Surfer applies folder patches after branding, and
  replaces existing files with symlinks to ours).
- **No subdirectories but `content/`** in `configs/branding/vimma/`: Surfer copies every top-level
  entry with `copyFileSync` (a directory throws) and requires `content/` to exist.
- **Brand selection** lives in `.surfer/dynamicConfig.brand.json` (git-ignored, default
  `unofficial`); `surfer build` turns it into `--with-branding`, the update channel and the MAR
  channel, and writes `release.displayVersion` into `browser/config/version{,_display}.txt`.
  `surfer package` reads `brands[brand].release` and fails for `unofficial`, so the brand is
  also what makes the nightly's packaging step work.
- **`MacOSInstaller.svg` is not needed**: Surfer only hashes it to decide whether to skip
  re-applying the brand, and it never stores that hash, so the brand is re-applied on every
  import either way (cheap; only the branding jars rebuild).
- **Vendor needs a patch.** `browser/moz.configure` does `imply_option("MOZ_APP_VENDOR", "Mozilla")`
  and mozbuild raises "implied by … conflicts with …" when a mozconfig sets another value, so
  the one line is patched. `MOZ_APP_ID` stays Firefox's (add-on compatibility).
- **`--version` is `<vendor> <name> <version>`** (`DumpVersion` in `nsAppRunner.cpp`), so with
  vendor and name both Vimma it prints `Vimma Vimma 0.1.0`. Accepted; Firefox prints
  `Mozilla Firefox …`. (Spec firefox-versions later patched `DumpVersion` to print
  `Vimma <version> · Firefox <version>`.)
- **Profile location moves.** Vendor and name form the Linux profile path, so profiles made by
  earlier `unofficial` builds are not picked up. Nothing to migrate before the first release.
- **The bookmarks error was not branding.** The `--screenshot` smoke run logs
  `Failed to import bookmarks … nsresult 0x8046001e`, which is `NS_ERROR_ILLEGAL_DURING_SHUTDOWN`:
  `--screenshot` quits while Places is still importing `default-bookmarks.html`. A fresh profile
  left running imports the default bookmarks without errors (checked with the `unofficial` build:
  4 bookmarks in `places.sqlite`, no console error). The mochitest guards the import itself; the
  runbook smoke check no longer uses `--screenshot` on a fresh profile.
- **Placeholder logo**: drawn by us, released under the repo's MPL-2.0 like the rest; no
  Mozilla/Firefox artwork in the files we supply.
- **Startup errors (fixed 2026-10-09).** Our prefs file dropped two prefs every stock brand
  sets, `app.update.checkInstallTime.days` and `app.update.badgeWaitTime` (now unofficial's 2 and
  0). `BrowserGlue._checkForOldBuildUpdates` reads the first with a bare `getIntPref`; it threw
  in `_onFirstWindowLoaded`, which then skipped the `browser-first-window-ready` category, whose
  `AboutNewTab.init` maps `resource://newtab/`. Hence the second error,
  `AboutNewTabRedirector … NS_ERROR_NOT_AVAILABLE`: ours, not a dev-build quirk, and about:home
  and about:newtab never loaded. The harness hides it (`testing/profiles/common/user.js` turns
  `app.update.checkInstallTime` off), so the mochitest turns it on and calls the check directly.
  `--screenshot about:home` still logs the newtab error and hangs on any Firefox build: the
  headless shell loads into a windowless browser, so no first window, no newtab mapping. Smoke
  checks screenshot a `data:` URL.
- **No `MOZ_USER_DIR`.** Surfer's mozconfig template exports it, but configure only reads
  `--with-user-appdir` (`toolkit/moz.configure`), so `mozilla-config.h` keeps `"mozilla"`; the
  line is removed. On Linux it only names a legacy-home probe (`$HOME/mozilla`) and
  `nsAppFileLocationProvider`'s product dir; native-messaging hosts hard-code `.mozilla`. Profiles
  come from vendor and name (`~/.config/vimma/vimma`, or `~/.vimma/vimma` if that exists). Making
  it effective has no user benefit and any non-default `--with-user-appdir` sets
  `MOZ_LEGACY_HOME`, which would move every profile to `~/.vimma/vimma`.
- **Build cost**: the first `./mach build` after switching brand, basename and vendor took 977 s
  (16.3 min, reconfigure plus a large C++/Rust rebuild); no clobber was needed.
