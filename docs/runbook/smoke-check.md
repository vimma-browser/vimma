## Smoke check

```sh
bin=engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma
$bin --version   # "Vimma 0.1.0 · Firefox 158.0" (node tools/release/version-line.mjs prints the same)
grep '^Version=' engine/obj-x86_64-pc-linux-gnu/dist/bin/application.ini
                 # "Version=158.0": appinfo.version is the Firefox version (spec m0-app-version)
# navigator.userAgent stays Firefox's: "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101
# Firefox/158.0", no Vimma token (spec m0-user-agent; browser_vimma_user_agent.js checks it)
p=$(mktemp -d)
timeout 20 $bin --headless --no-remote --profile "$p" about:blank || true   # first run: profile + bookmarks; timeout exits 124
$bin --headless --no-remote --profile "$p" --screenshot /tmp/shot.png "data:text/html,<h1>ok</h1>"
```

Where unprivileged user namespaces are denied (ubuntu-24.04 runners, through AppArmor), `--version`
also writes `Sandbox: CanCreateUserNamespace() ... EPERM` to stderr. The version line is on stdout,
so scripts compare stdout alone; release.yml and nightly.yml do
(tools/release/test/smoke-check.test.mjs).

The brand is `vimma` (spec m0-branding): `npm run import` selects it (`surfer config brand vimma`)
and rewrites `engine/mozconfig`, so `npm run import && (cd engine && ./mach build)` builds it.
Changing branding needs a full `./mach build`, not `--ui`. Profiles now live under the Vimma
vendor/name, so profiles from the old `unofficial` builds are not picked up.

Two versions (spec m0-app-version): `npm run import` writes `src/browser/config/vimma/version.txt`
(the Firefox version, `appinfo.version`) and `version_display.txt` (Vimma's, `--version` and the
About dialog) from `surfer.json`; the mozconfig points configure at them. Surfer still writes
`displayVersion` into the stock `browser/config/version*.txt`, which configure then ignores. After
editing the generated files by hand, run `./mach configure`; `npm run import` triggers it anyway.
If the files are missing (a fresh clone without `npm run import`, or after `git clean -fdX`), the
mozconfig stops the build with "browser/config/vimma/version.txt is missing; run 'npm run import'"
rather than letting configure fall back to Surfer's 0.1.0.

Profiles are stamped with the Firefox version (158.0), so a build from before m0-app-version
(appinfo.version 0.1.0) sees any profile opened by a newer build as a downgrade and refuses it
(`MOZ_BLOCK_PROFILE_DOWNGRADE`). When testing old and new builds side by side, give each its own
`--profile`, or pass `--allow-downgrade`.

`--screenshot` on a brand-new profile quits while Places is still importing the default
bookmarks and logs "Failed to import bookmarks … 0x8046001e" (`NS_ERROR_ILLEGAL_DURING_SHUTDOWN`).
That is an upstream shutdown race, not a broken import: hence the warm-up run above.
`tests/browser/browser_vimma_branding.js` checks the import itself.

Mozilla services (spec m0-mozilla-services): builds have no crash reporter
(`--disable-crashreporter` in `configs/common/mozconfig`), so a crash leaves a systemd-coredump
core (`coredumpctl list | grep vimma`: a tab's process is named `Web Content`, so
`coredumpctl list vimma` misses it), not a minidump, and nothing is sent anywhere. Studies,
experiments, sponsored content and Mozilla promos are off by default in
`src/browser/branding/vimma/pref/firefox-branding.js`; `about:config` turns any back on. In a
local build `dist/bin` symlinks that file, so an edit to it applies at the next launch, no build
needed; the crash-reporter flag needs `npm run import && (cd engine && ./mach build)`.

Placeholder artwork: `configs/branding/vimma/*.svg`, rendered by `tools/branding/render.sh`
(`rsvg-convert`, ImageMagick). Replace the SVGs, re-run the script, commit the PNG/ICO outputs.
