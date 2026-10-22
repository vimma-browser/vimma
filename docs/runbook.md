# Runbook

## Machine

- Reference machine for the timings below: 16 threads (Ryzen AI 7 PRO 350), 58 GiB RAM, Linux
  (Omarchy), Node 22, Python 3.

## First Firefox build

| Step                   | Date       | Result                                                                                                                                                                                                         |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surfer setup-project` | 2026-10-09 | Firefox stable 157.0.1; name Vimma, binary `vimma`, app id `dev.vimma.browser`. The prompts were scripted; Surfer crashed after writing the config (import cycle), so `binaryName`/`appId` were fixed by hand. |
| `surfer download`      | 2026-10-09 | 753 s (12.5 min) incl. unpack and `git init` of `engine/`. `.surfer/` 774 MB, `engine/` 7.6 GB.                                                                                                                |
| `surfer bootstrap`     | 2026-10-09 | toolchains into `~/.mozbuild` (clang, cbindgen, …); no errors                                                                                                                                                  |
| `surfer build`         | 2026-10-09 | 2321 s (38.7 min) wall, CPU 75 %, on Ryzen AI 7 PRO 350 (16 threads), 58 GB RAM. `engine/` 22 GB after build.                                                                                                  |

Repository: <https://github.com/vimma-browser/vimma>; `MOZ_SOURCE_REPO` in `configs/common/mozconfig` points at it.

```sh
npx surfer setup-project   # interactive: name vimma, Firefox release
npx surfer download
npm run verify-source      # the tarball against Mozilla's signed SHA512SUMS (ADR-021)
npx surfer bootstrap
npx surfer build
npm start                  # tools/start.mjs: the build with ~/.cache/vimma-dev-profile
```

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
core (`coredumpctl list vimma`), not a minidump, and nothing is sent anywhere. Studies,
experiments, sponsored content and Mozilla promos are off by default in
`src/browser/branding/vimma/pref/firefox-branding.js`; `about:config` turns any back on. In a
local build `dist/bin` symlinks that file, so an edit to it applies at the next launch, no build
needed; the crash-reporter flag needs `npm run import && (cd engine && ./mach build)`.

Placeholder artwork: `configs/branding/vimma/*.svg`, rendered by `tools/branding/render.sh`
(`rsvg-convert`, ImageMagick). Replace the SVGs, re-run the script, commit the PNG/ICO outputs.

## Re-importing after a patch changes

`surfer import` applies each `src/**/*.patch` as `git apply -R` (failure ignored), then
`git apply`. When a patch changed since the last import, its reverse no longer matches what the
old version left in `engine/`, so the forward apply fails ("Exiting due to error") on a file
that still carries the old hunks. `npm run import` therefore runs
`tools/import/restore-patched.mjs` first: it reads the `+++ b/<path>` line of each header pair in
`src/**/*.patch` and runs `git -C engine checkout -- <those files>` (11 files today), so every
import starts from upstream. It touches only those files: never `git checkout .`, never a
clean. A file a patch creates (`--- /dev/null`) is skipped, as is a path upstream does not track.

```sh
node tools/import/restore-patched.mjs --dry-run   # list the files and the git command, change nothing
```

Without an `engine/` (before `surfer download`) it does nothing.

## Moving the checkout

`surfer import` links `engine/` into `src/` with absolute symlinks, and an objdir records the
checkout's absolute path in Make dependency, cargo and config files. After `mv old new`, links
dangle and the build mixes paths. The 2026-10-10 move (`~/repositories/VimHerdr` →
`~/repositories/vimma`) needed about 139k symlinks retargeted and the old path rewritten in about
6.9k objdir text files. `tools/import/relocate-checkout.mjs` does both:

```sh
mv ~/repositories/old ~/repositories/new && cd ~/repositories/new
git worktree prune                     # or `git worktree repair` for worktrees you keep
node tools/import/relocate-checkout.mjs --from ~/repositories/old --dry-run   # counts only
node tools/import/relocate-checkout.mjs --from ~/repositories/old
npm run import && npx surfer build     # mach reconfigures; the 2026-10-10 full build: 21 min
```

1. Every symlink under `engine/` (not `.git`) whose absolute target lies in the old checkout is
   pointed at the same place in this one. Relative links and links elsewhere stay.
2. In each `engine/obj-*`, the old path is replaced in text files outside `dist/` (`dist/` is
   links, handled by step 1). The path only matches whole: `/old/repo` does not touch
   `/old/repo2`. Binaries (a NUL byte) and files over 64 MB are left for the build to relink.

Upstream sources and anything outside `engine/` are never written; a second run changes
nothing. Things outside the repo that name the old path (a launcher such as
`~/.local/bin/vimma-dev` or a `.desktop` file) are yours to update. A lane (below) does not need this: `npm run lane:setup -- --force` rebuilds it.

## Testing

### Mochitests that send keys to a page

Set up, await, then press (issues #14, #18). `tests/browser/head.js`, which the harness loads
before every test in the directory, has the helpers:

```js
await recordPageKeys(browser); // listener in place in the content process
await focusContent(browser); // chrome and content focus
EventUtils.synthesizeKey("j");
Assert.ok(await waitForPageKey(browser, ["j"]), "page received j, not default-prevented");
Assert.deepEqual(await pageKeys(browser), ["j"], "and nothing else");
```

Do not use `BrowserTestUtils.waitForContentEvent` followed by `synthesizeKey`: it installs its
listener through `sharedData.flush()`, which the content process picks up later, so the key can
beat the listener. Do not rely on `browser.focus()` either: it moves chrome focus; the content
process takes focus later. On a 2-CPU runner both race the key. Neither matters for keys that
only chrome handles (Vimma's chords, the help overlay, the URL bar).

Typing into an editable page makes the editor scroll the caret into view at the page's next
refresh tick, not at once (Selection's async ScrollSelectionIntoView). A test that types and
then scrolls must first wait for that tick (`afterRefreshTick` in
`browser_vimma_insert_scroll.js`, issue #46), or a late tick scrolls back to the caret.

To shake out a race, run a test repeatedly on two busy CPUs (what the hosted runner has):

```sh
for i in 1 2 3 4; do taskset -c 0,1 sh -c 'while :; do :; done' & done
taskset -c 0,1 npm run mochitest -- --repeat=49 tests/browser/browser_vimma_<name>.js
kill $(jobs -p)
```

Pass `--repeat=N` with `=`: `tools/mochitest.mjs` treats a bare `N` as a test path. Plan §5: no
retries in CI; a flaky test gets quarantined and an issue the same day.

### The control socket (spec m0-control-server)

`tests/browser/browser_vimma_control.js` drives the server with a raw socket client, and its last
task runs the real `vimma-ctl state` against it. It finds the binary through the test file's
symlink into this checkout (`tools/vimma-ctl/target/{release,debug}/vimma-ctl`), or `VIMMA_CTL`.
Without one it skips that task; the e2e workflow builds the binary (debug) and passes
`--setenv=VIMMA_REQUIRE_CTL=1`, which turns the skip into a failure. Locally:

```sh
(cd tools/vimma-ctl && cargo build --release)
npm run mochitest -- tests/browser/browser_vimma_control.js
```

Test-only prefs shorten the limits: `vimma.control.helloTimeoutMs` (5000) and
`vimma.control.idleTimeoutMs` (60000). By hand, against a real build:

```sh
p=$(mktemp -d); echo 'user_pref("vimma.control.enabled", true);' > "$p/user.js"
engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma --headless --no-remote --profile "$p" &
tools/vimma-ctl/target/release/vimma-ctl --profile "$p" state
tools/vimma-ctl/target/release/vimma-ctl --profile "$p" send-keys ctrl+q   # quits; file removed
```

A normal quit (`ctrl+q`) deletes `vimma-control.json`. `SIGTERM` does not:
measured on 157.0.1 (headless), the process dies by the signal within ~20 ms (exit 143) without
running quit observers, so the file stays and `vimma-ctl` reports "not running". To end a run
cleanly, send `ctrl+q` (with `browser.warnOnQuitShortcut` = `false` in `user.js`) and keep
`SIGTERM`/`SIGKILL` as the fallback.

### Running a local build (`npm start`)

`npm start` runs the full build (`engine/obj-x86_64-pc-linux-gnu`) if present, else the artifact
build with `XUL_APP_FILE` as `tools/mochitest.mjs` does, with
`~/.cache/vimma-dev-profile` (`--profile DIR`, `--fresh` for a temp profile, `--import` to run
`npm run import` first, browser flags after a second `--`). It refuses a profile in use: a POSIX
lock on `<profile>/.parentlock` (`/proc/locks`) or a `lock` symlink whose pid is alive (the link
can outlive the browser).

It merges `security.sandbox.content.read_path_whitelist=<repo>/src/` into the profile's `user.js`.
In a local objdir the chrome files are symlinks into `engine/`, which `surfer import` links to the
repo's `src/`, outside the Firefox tree; the content sandbox then refuses them and the console
says `Failed to load chrome://browser/content/vimma/actors/VimmaChild.sys.mjs` (no hints, no
insert mode). Mochitests relax the sandbox, so they never see it. The e2e harness writes the same
pref (`devPrefs` from `tools/start.mjs`) and keeps the default sandbox, and its
`m0-content-actor` scenario fails without it (checked: `normal` instead of `insert`). Any scenario
also fails when the browser logs a `Failed to load chrome://browser/content/vimma/…`.

### End-to-end tests (`npm run e2e`, spec m0-e2e-harness)

Scenarios in `tests/e2e/scenarios/*.json` run against a real build, each in a fresh temp profile
(`vimma.control.enabled=true`, no first-run pages, no telemetry), driven through `vimma-ctl`.
Pages: `open "fixture:<name>"` loads `tests/e2e/fixtures/<name>` from a local HTTP server on
127.0.0.1 (a web content process; a `file:` URL would go to the file process, which may read any
file). Names: `m<N>-<slug>` for a milestone happy path, `issue-<N>-<slug>` (plus `"issue": N`) for a
regression test. A scenario with a `pending` reason is reported as `PENDING`, launched never
and passed never. Each run ends with `send-keys ctrl+q` (after `esc` if the help overlay is
open), so the browser removes its discovery file; signals are the fallback.

```sh
(cd tools/vimma-ctl && cargo build --locked)     # the driver runs this binary
npx vitest run tools/e2e/                        # the harness's own tests (fake server)
npm run e2e                                      # all scenarios, full objdir build
npm run e2e -- --filter m0-happy-path            # names containing the text
npm run e2e -- --artifact                        # engine/obj-artifact, as CI does
npm run e2e -- --build path/to/dist/bin | --tarball vimma-0.1.0-linux-x86_64.tar.xz
npm run e2e -- --xvfb --keep                     # own Xvfb on a desktop; keep the profiles
npm run e2e -- --run-pending --filter m0         # run a pending scenario anyway (to watch it fail)
MOZ_HEADLESS=1 npm run e2e -- --artifact --filter m3   # no Xvfb at hand: headless, no screenshots
```

A `restart` step (`m3-restart-restore`) quits with `ctrl+q` and starts the build again on the
same profile; a scenario's `prefs` override the harness's `user.js` (`null`: the build's
default). `"restart": "kill"` (`m3-crash-restore`) is a crash instead: it waits until
SessionStore's `sessionstore-backups/recovery.jsonlz4` exists and has not changed for 3 s (set
`browser.sessionstore.interval` low in the scenario's `prefs`, or that wait takes 15 s+), sends
SIGKILL to the browser pid the harness started (its content processes follow; any left in its
process group are killed after 5 s; never `pkill -f`), and starts again. The dead browser's
`vimma-control.json` stays, as after a real crash; the relaunch skips the file whose `pid` is
the killed one until the new browser rewrites it. The harness profile turns
`resume_from_crash` off; a crash scenario sets it to `null` (the build's default, on).

Scroll positions are read from the page, not from the control socket: `fixture:long.html`
titles itself `long <top|middle|bottom> <navigation type>`, so after a restart the reloaded
page says `back_forward` (SessionStore restores it from its history entry) where the stale
saved label still says `navigate` (`m3-restart-scroll`). Without Xvfb, `MOZ_HEADLESS=1` runs every scenario that takes no screenshot.

Without `DISPLAY` (CI) the harness starts its own Xvfb at 1280×800×24; with a desktop, pass
`--xvfb` for screenshots and to keep the window off your screen. The browser never inherits
your desktop's environment: it gets an allowlisted env (no `GDK_SCALE`, `QT_*`, `GTK_THEME`,
Wayland or locale; `HOME` and `TMPDIR` inside the temp profile) and the profile pins
`layout.css.devPixelsPerPx=1.0` and a light theme, so local screenshots match CI's. Timeouts are
hard: a scenario's deadline kills its launch and any running `vimma-ctl`. The whole suite has a
5-minute budget (`--budget SECS`).
Exit 0: nothing failed (pending is not failure, nor a pass); 1: a failure; 2: usage.

**Baselines.** Screenshots are compared with `tests/e2e/baselines/<name>.png`; more than 0.5 % of
differing pixels fails, and the actual and diff images land in `e2e-output/`. To change a
baseline:

```sh
npm run e2e -- --xvfb --update-baselines --filter <scenario>   # refused when CI is set
```

look at the new PNG, and commit it with a changelog line saying which baseline changed and why
(CONTRIBUTING.md: never edit a baseline without one). A missing baseline fails; nothing creates one
silently. Fonts differ between machines: if CI's diff exceeds 0.5 % on a baseline made locally,
take CI's actual image from the `e2e-output` artifact of the failed run (kept 7 days) instead.
A missing baseline also leaves `<name>.actual.png` there, so a new scenario's first baseline
comes from CI the same way: `gh run download <run-id> -n e2e-output`. Baselines are plain git blobs, not LFS
(the spec's "LFS: not now" says when to revisit).

**Troubleshooting Xvfb.**

- `Xvfb not found`: install `xvfb` (Ubuntu/Debian), `xorg-server-xvfb` (Arch) or
  `xorg-x11-server-Xvfb` (Fedora). GitHub's `ubuntu-24.04` image has it.
- `Xvfb exited with code 1`: read the stderr in the message. The harness picks a free display
  with `-displayfd`, so a stale `/tmp/.X*-lock` should not matter; a sandbox without
  `/tmp/.X11-unix` write access does.
- The browser opens on your desktop: you have `DISPLAY` set and did not pass `--xvfb`.
- `no usable control socket within 30000 ms`: the build has no control server yet, the pref did
  not apply (check `user.js` with `--keep`), or the browser is stuck; the message ends with the
  browser's stderr. `--discovery-timeout SECS` for a slow machine.
- A black screenshot: the window has not painted; the capture waits for two identical frames
  200 ms apart (at most 2 s), so check the scenario waits for the state it photographs.
- Leftovers after a crash of the harness itself: `pkill -f vimma-e2e-profile-` and
  `rm -rf /tmp/vimma-e2e-*`. Normally SIGINT/SIGTERM kill the browser's process group, stop Xvfb
  and remove the profile.

### Site compatibility (`npm run sites`, spec site-compat)

`npm run sites` loads each site of `tools/sites/sites.json` once in a real build, one fresh
profile per site under the harness's own Xvfb, and runs the same checks on each: hints and
following one, scrolling (main and inner scrollers), find, `yy`, insert and Esc on the search
field, `ctrl+b` never reaching the page, the site's own shortcuts (info only), errors from
Vimma's code and the status bar's mode after each step. Keys go through `vimma-ctl`; the page is
read over the DevTools protocol on a Unix socket in the profile's temp dir (not WebDriver, which
sets `navigator.webdriver` and draws more bot checks). It writes `site-compat-output/`:
`results.json`, `report.md`, `report.html` and `screenshots/`.

```sh
npm run sites                                  # every site, the default build
npm run sites -- --filter github,mdn           # ids or names containing either term
npm run sites -- --artifact                    # engine/obj-artifact
npm run sites -- --pref name=value             # an extra profile pref (repeatable)
```

- Takes 20-40 s per site, about 10 min for the list. It exits 0 whenever it wrote a report:
  failures are findings, not a broken build.
- "blocked (bot check)" and "consent" are the site's doing (a Cloudflare or Google check, a
  consent wall it could not reject), not Vimma's. They depend on the network: run it from home
  when the nightly shows many.
- `--retry-blocked` loads each blocked site once more at the end of the run. The nightly passes
  it; leave it off at home, where every extra visit makes the next bot check more likely.
- **The nightly diff and the `site-compat` issue.** After the run, `sites.yml` downloads the
  previous scheduled run's artifact and runs `tools/sites/compare.mjs`: the changes go into the
  job summary and `diff.md`, and the regressions it tracks (checks that passed before and fail
  now) into `diff.json` for the next night. A new regression opens one issue labelled
  `site-compat`; each scheduled run updates it and closes it once every tracked check passes
  again. A check that has failed since before it was first compared opens no issue. To see what
  a run compared with, open the compare job's summary; to start tracking afresh, close the issue
  (it reopens only on a new regression). If a night could not compare (an expired, missing or
  damaged artifact), the issue says the tracking was interrupted and is no longer closed
  automatically: close it by hand once the report shows its checks passing. A night whose
  harness failed fails the run and is skipped as a baseline; the next night compares with the
  last successful one.
- Adding a site: an entry in `sites.json` (`id`, `name`, an https `url`; optional `search`, a CSS
  selector for its search field, and `find`, a word on the page). `npm test` checks the file.
- **The snapshot gate** (`npm run sites -- --offline`). e2e.yml replays the pages recorded in
  `tests/e2e/fixtures/sites/` (Wikipedia, MDN, docs.python.org, doc.rust-lang.org: the ones
  whose licence allows a copy here) from a page server on 127.0.0.1, with every other host
  unreachable, and runs the same checks but the site's shortcuts. It fails the pull request when
  a check that passed on the recording (`expect` in `snapshots.json`) does not pass now; its
  report and screenshots are then the `site-compat-offline` artifact. About 25 s, safe to run
  anywhere: it loads no live site. A failure is Vimma's, since the page cannot have changed.
- **Recording a snapshot.** `npm run sites -- --record wikipedia` loads the live page once and
  writes a checked snapshot into `site-compat-output/snapshots/`; `--record <id>=<url>` records
  from a saved copy instead. Only the ids in `SNAPSHOT_LICENCES` (`tools/sites/snapshot.mjs`) are
  accepted. Copy the file into the fixtures, set its `snapshots.json` entry from an offline run
  and add its attribution row to the README there. A site whose licence allows no copy gets a
  hand-written minimal fixture of the structure that broke instead.
- Running it from a worktree against the main checkout's build: pass
  `--build <main>/engine/obj-x86_64-pc-linux-gnu/dist/bin` and
  `--pref security.sandbox.content.read_path_whitelist=<main>/src/`, or the content actor
  cannot load.

## Parallel browser lanes

A lane is a git worktree (e.g. an agent's under `.claude/worktrees/`) with its own `engine/` and
artifact build, so several agents can run browser specs at once without sharing a tree. In the
worktree:

```sh
ln -s <main checkout>/node_modules node_modules   # or npm ci
npm run lane:setup          # copy, reset, import, artifact build, verify
npm run mochitest -- --artifact tests/browser/
npm run lane:teardown       # when done: removes this worktree's engine/
```

`tools/lanes/lane-setup.mjs`:

1. reflink-copies the main checkout's `engine/` (`--source <checkout>` for another) without
   any `obj-*` dir, keeping the engine's own `.git` and modes (`cp -a --reflink=always`);
2. resets the copy to upstream as Surfer's `surfer reset` would, but scoped: unlinks the
   symlinks that lead into the source checkout (the source's `surfer import` made them, with
   absolute paths), `git checkout -- .` (undoes our `.patch` files and the lines import added
   to `engine/.gitignore`), `git clean -fd` (no `-x`: what import added, not upstream-ignored
   files) and removes `mozconfig*`;
3. runs this worktree's `npm run import` and `tools/artifact-build` into `engine/obj-artifact`;
4. checks that no symlink leads into the source checkout and some lead into the lane, runs
   `browser_vimma_branding.js`, and prints timings and disk (`btrfs filesystem du`).

Cost, measured 2026-10-09 (Firefox 157.0.1, 16 threads, Mozilla's artifacts already cached in
`~/.mozbuild/package-frontend`; a cold cache downloads 163 MB once, shared by all lanes):

| Phase          | Time   |
| -------------- | ------ |
| copy (reflink) | 4.8 s  |
| reset          | 23.2 s |
| import         | 1.0 s  |
| artifact build | 36.5 s |
| mochitest      | 8.6 s  |

About 75 s in all. Disk: 5.06 GB total but **0.59 GB exclusive** (the reflinked tree shares
its extents with the source; `obj-artifact` and rewritten files are the lane's own). The whole
`tests/browser/` suite then takes 22 s in the lane.

Protection of the main checkout: setup and teardown refuse to run in it (the first entry of
`git worktree list`), whatever path it is reached by; setup only reads the source `engine/` and
writes under the lane's; teardown refuses an `engine/` that is a symlink or resolves into the
main checkout's. Setup refuses an existing `engine/` unless `--force`, and refuses a non-reflink
copy (about 6 GB, minutes) unless `--allow-copy`: the lane must be on the same btrfs filesystem.

Limits:

- **Artifact builds only.** Specs that change build config, `moz.configure`, compiled-in
  defines or C++ (ADR-010 "Known gaps", `skip-if = ["artifact"]` tests) need the main
  checkout's full build; do them there, one at a time.
- **One lane per worktree** (its `engine/`). After changing `src/` or `tests/` paths, rerun
  `npm run import` there; after a Firefox bump, `npm run lane:setup -- --force` from a source
  checkout on the new release.
- **CPU:** an artifact build is CPU-bound (the front-end build). On a 16-thread machine run at
  most about 3 artifact builds at once, and none while the main checkout runs a full build;
  mochitests are light, a few in parallel are fine.
- **Don't set up a lane while the source checkout is mid-import** (or mid-`git` in its
  `engine/`): the copy is a snapshot. Stray `*.lock` files copied from its `engine/.git` are
  removed in the lane (and logged), never in the source; a half-applied import is undone by
  the reset, but rerun setup with `--force` if anything looks off.
- With `--source <other worktree>`, links into both that worktree and the main checkout are
  removed and checked. All git (and import) children run without inherited `GIT_*`
  variables, and reset refuses an `engine/` that is not the top of its own git repo.
- mach keeps a small per-tree state dir in `~/.mozbuild/srcdirs/engine-<hash>` (about 2 MB
  per lane); teardown leaves it.

## CI and automation (spec m0-pipeline)

| Workflow                   | Trigger                                            | Runner                    | Needs from you                             |
| -------------------------- | -------------------------------------------------- | ------------------------- | ------------------------------------------ |
| `ci.yml`                   | push to `main` (once per tree), PRs, manual        | `ubuntu-latest` + macOS   | nothing                                    |
| `e2e.yml`                  | PRs, manual, upstream.yml                          | `ubuntu-24.04`            | nothing (ADR-010)                          |
| `nightly.yml`              | 03:00 UTC, manual                                  | `ubuntu-24.04`            | the `NIGHTLY_ENABLED` variable             |
| `upstream.yml`             | every 4 h (`:17`), manual                          | `ubuntu-latest` + e2e.yml | allow Actions to open PRs; optional token  |
| `claude.yml`               | `@claude`, `spec`+`claude:go`                      | `ubuntu-latest`           | a secret, two labels, Actions may open PRs |
| `release-please.yml`       | push to `main`, manual                             | `ubuntu-latest`           | Actions may open PRs; optional token       |
| `release.yml`              | release published, manual                          | `ubuntu-24.04`            | see "Release packages" (gated off)         |
| `homebrew.yml`             | `macos-tap` in `release.yml`, manual (`main` only) | `ubuntu-24.04`            | see "Release packages" (gated off)         |
| `pkgbuild.yml`             | `tools/package/` on PRs and `main` (once per tree) | `ubuntu-24.04` + macOS    | nothing (Arch Linux in docker; brew)       |
| `mutation.yml`             | Sundays 04:23 UTC, manual                          | `ubuntu-latest`           | nothing (creates its `mutation` label)     |
| `semgrep.yml`              | push to `main` (once per tree), PRs, Mon, manual   | `ubuntu-latest`           | nothing                                    |
| `codeql.yml`               | push to `main`, PRs, Mon, manual                   | `ubuntu-latest`           | nothing; skipped while the repo is private |
| `dependabot-automerge.yml` | Dependabot's PRs                                   | `ubuntu-latest`           | nothing (Dependabot, below)                |
| `site-dispatch.yml`        | `docs/bindings.json` on `main`, release published  | `ubuntu-latest`           | a token secret (vimma.dev, below)          |
| `spec-status.yml`          | daily, issue closed, specs, manual                 | `ubuntu-latest`           | nothing (creates its `spec-status` label)  |

Locally, before pushing: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:py`,
`npm run license-check`, `npx surfer license-check`, `npx commitlint --from main`.
Workflow YAML: `go run github.com/rhysd/actionlint/cmd/actionlint@latest` (reads
`.github/actionlint.yaml`; not a repo dependency).

### The GitHub organization

The repositories live in the `vimma-browser` organization: `vimma-browser/vimma` (public, the
browser) and `vimma-browser/vimma-site` (private, vimma.dev). Its owner is the maintainer,
`JRanne`. Sponsorship stays on the maintainer's personal GitHub Sponsors account
(`.github/FUNDING.yml`), and the roadmap board is a project of that personal account.

`tools/repo.mjs` names the canonical repository, the site's repository and the maintainer's
login; `tools/test/repo.test.mjs` checks that every `github.repository == '…'` guard, the site
dispatch, the signing identity and the published URLs agree with it. Forks skip every guarded
job. An organization cannot be @-mentioned or add a label as a person, so the `claude:go` gate
and the upstream workflows' mentions name the maintainer's login, not
`github.repository_owner`.

### Merging and branch protection

`main` is protected by the repository ruleset "main" (`gh api repos/vimma-browser/vimma/rulesets`):
changes land through a squash-merged pull request only, with no force-push or deletion, and
these status checks must pass:

- `lint, typecheck, test, commitlint, licences` (ci.yml)
- `mochitest (artifact build)` (e2e.yml)
- `semgrep (javascript, typescript, rust, secrets, github-actions)` (semgrep.yml)
- `CodeQL (javascript-typescript)` and `CodeQL (rust)` (codeql.yml)

The ruleset also requires CodeQL code scanning results without errors or high-severity alerts.
`vimma-ctl on macOS` (ci.yml, spec macos-build, sub-PR 2) runs vimma-ctl's clippy and tests on
`macos-15` and is informational: it is not in the ruleset, so a red run shows on the pull
request without blocking it.
A required check whose workflow never starts stays pending and blocks the merge, so none of
these workflows has a `paths` filter; a job or step skipped by `if:` reports success instead
(next section).

**Actions settings.** Two repository settings back the workflow tests, which cannot read them
with a workflow token (docs/security.md, B5; spec build-supply-chain, decisions 7 and 19):

- Fork pull request approval stays `all_external_contributors`, so a fork's own workflow files run
  only once a person approves the run. Check:
  `gh api repos/vimma-browser/vimma/actions/permissions/fork-pr-contributor-approval`.
- `sha_pinning_required` makes GitHub refuse any action not pinned to a full commit SHA, in every
  workflow, a fork's included. Every workflow already pins by SHA. An administrator turns it on
  once:
  `gh api -X PUT repos/vimma-browser/vimma/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true`,
  and checks it with `gh api repos/vimma-browser/vimma/actions/permissions`.

An organization owner also confirms that the organization has no self-hosted runner:
`gh api orgs/vimma-browser/actions/runners` must report `total_count` 0. A runner registered at
the organization and shared with this repository through a runner group would not show in the
repository's own runner list, and the workflow test only proves no workflow asks for one.

**Residual risk:** any job token with `contents: write` (`spec-pr` in claude.yml, upstream.yml,
nightly.yml, release-please.yml) can push branches and tags; the ruleset has no bypass actors, so
none of them can push to `main` itself. Mitigations: those jobs never run code the agent wrote
with that token (claude.yml's agent job is read-only), the agent runs only for the owner
(`claude:go` added by the owner; `@claude` from owner/member/collaborator), and GitHub Actions
minutes and logs show every push. Check `git log origin/main` if anything looks off.

### Docs-only pull requests (issue #245)

A pull request whose every changed file is prose Markdown skips the work Markdown cannot affect.
`tools/ci/docs-only.mjs` decides from `git diff --name-only --no-renames base...head` (never the
title or body); ci.yml and e2e.yml run it as the base branch has it, so a pull
request cannot change the classifier that judges it.

**Docs-only** means all of these hold:

- the event is `pull_request` (a schedule, a manual run and `workflow_call` always run
  everything; so does a push to `main`, unless "Once per tree" below skips it);
- every changed path ends in `.md`;
- none is generated (`GENERATED_MARKDOWN`: `docs/bindings.md`);
- none is under `.github/`, `packages/`, `src/`, `tests/` or `tools/`, where Markdown can be a
  fixture, a vendored file pinned by hash or a template GitHub reads.

A workflow, a script, `package.json` or any other file in the same pull request runs everything.

Still runs on a docs-only pull request: prettier, commitlint, `npm run md-wording`,
`npm run security-links`,
`npm run test:py` (it reads ADR-003), the gen-docs freshness step, the Vitest files listed in
`MARKDOWN_TESTS`, Semgrep and CodeQL.

Skipped: eslint, `npm run comment-wording`, typecheck, the full Vitest suite with coverage, the bench, the licence checks,
cargo, the MPL header check, and `mochitest (artifact build)` with the e2e scenarios (the job
`changes` gates the job).

CodeQL is not skipped, although Markdown cannot change its findings: the ruleset's code
scanning rule blocks a merge until CodeQL has uploaded results for the pull request, whatever
its required checks report. With the analysis skipped, a docs-only pull request had every
required check green and still showed `mergeStateStatus` `BLOCKED`, and the only check missing
next to a code pull request was the `CodeQL` results check. The analysis takes about 2.5
minutes (Rust), so it sets how long a docs-only pull request waits.

A skipped job or step reports success, so the required checks pass. If the classifier fails,
the gated jobs run (`!cancelled()`, not `success()`). Adding a Vitest file that reads a
Markdown file of the repo through `new URL("../…/x.md", import.meta.url)` means adding it to
`MARKDOWN_TESTS`; `tools/ci/test/docs-only.test.mjs` fails until then. The same test pins the
`if:` wiring of each required job.

The gen-docs freshness step runs on every pull request: `npm run gen-docs`, then `git diff
--exit-code` on `docs/bindings.md`, `docs/bindings.json` and `packages/vimma-core/defaults.toml`.
A hand edit of a generated file fails there with the command to run.

### Draft pull requests (issue #443)

A push to a draft pull request skips the three slow required checks: `mochitest (artifact
build)` with the e2e scenarios (e2e.yml), the Semgrep scan and both CodeQL analyses. Each still
reports success, so the ruleset never waits on a check that will not come: e2e.yml and
semgrep.yml skip the job by `if:`, and codeql.yml, a matrix job, skips every step instead,
because a matrix job skipped by its own `if:` reports one check under the unexpanded
`CodeQL (${{ matrix.language }})` and the required names would never appear. CI (`lint,
typecheck, test, commitlint, licences`) and the key guard are cheap and run on drafts too.

Only the `opened` and `synchronize` events of a draft skip. Both bring a head that has had no
run, so a skipped success never replaces a real result. Every other event runs everything:
`reopened` and `ready_for_review` on a draft, pushes to `main`, schedules, manual runs and
`workflow_call` (where `github.event.pull_request` is null). Without that limit, converting a
pull request with a failed mochitest to a draft and closing and reopening it would put newer
skipped successes on the same head. For the same reason, never re-run a draft's run once the
pull request is ready: a re-run keeps the event it started with and skips again.

Marking the pull request ready for review (`gh pr ready <n>`) sends `ready_for_review`, which
ci.yml, e2e.yml, semgrep.yml and codeql.yml list, and runs the skipped checks on the same head.
A draft cannot be merged, and the skipped successes of its draft run cannot let it through
afterwards: CodeQL uploaded no analysis for that head, and the ruleset's code scanning rule
blocks a merge until one exists (seen on draft PR #249, "Docs-only pull requests" above). The
analysis takes minutes, while the same event queues the run's other checks on that head within
seconds, so they are pending, not green, by the time it lands. That margin is timing, not a
rule of GitHub's, so merge by hand only once the new run's checks are green; the automatic
security release waits for them before it sets auto-merge ("Releases" below). Converting a
pull request to a draft (`gh pr ready --undo <n>`) starts no run and leaves its results as
they are.

`tools/ci/tree-covered.mjs` takes no run as a cover when a job other than its guard was
skipped, so a draft's Semgrep run, which scanned nothing, never lets a push to `main` skip its
scan ("Once per tree" below).

The release pull request is the reason (below, "Releases"): release-please rebuilds it after
each merge to `main`, and only the state that is merged is released. Other drafts follow the
same rule: mark one ready to get the mochitests on it. `tools/test/draft-pull-requests.test.mjs`
pins the wiring.

### Once per tree (issue #358)

`ci.yml`, `semgrep.yml` and `pkgbuild.yml` run on pull requests and on pushes to `main`. A
squash merge usually gives `main` a commit whose tree is the pull request head's tree, so the
push run would check the same files again. Their first job on a push, `covered`, runs
`tools/ci/tree-covered.mjs`: it reads the pushed commit's tree and the last 50 successful
`pull_request` runs of the same workflow from the Actions API (both public; the job token holds
`actions: read` and `contents: read`, nothing more), and compares each run's head tree. A run
with the same tree counts only if every job but the guard ran (`actions/runs/<id>/jobs`): a
draft's run skips the Semgrep scan and still succeeds. On a match it outputs `skip=true` and a
notice on the run's summary names the covering run; the other jobs then skip by `if:`. Equal trees include `.github/workflows`, so the covering run used the
same workflow definition. When `main` moved after the pull request's last run, the trees differ
and the checks run as before: the ruleset does not require up-to-date branches
(`strict_required_status_checks_policy: false`), so that run is the only check of the merged
combination. Requiring up-to-date branches instead would re-run every open pull request's
checks after each merge, more than the one push run it saves. A guard that cannot reach the API
warns and lets the checks run; a guard without its variables fails before its verdict, which
leaves the output empty, runs the checks and shows a workflow bug. A docs-only pull request's
run counts as a cover although it skipped the code checks: its tree's code equals its base's,
which an earlier run of `main` checked in full or by the same rule.

`ci.yml` still lints the squash commit's message when it skips: that message is new on `main`
and release-please builds the changelog from it ("Releases" below). `codeql.yml` is not
deduplicated: code scanning keeps `main`'s alerts from analyses uploaded for commits of `main`
and compares a pull request's analysis against the latest one of its base, so a push without an
upload would leave both at the previous merge. Semgrep uploads nothing (its SARIF stays an
artifact of the run), so its push run has nothing to add. `e2e.yml` runs on pull requests only,
and `release.yml` builds once per release, so neither was duplicated.

To check a commit by hand:
`GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=vimma-browser/vimma GITHUB_SHA=<sha> node tools/ci/tree-covered.mjs --workflow ci.yml`.

### Superseded pull request runs

A new push to a pull request makes the checks still running on its previous head worthless, so
every workflow with a `pull_request` trigger sets a workflow-level `concurrency` group keyed on
`github.ref` (`refs/pull/<n>/merge`) or the pull request number, and cancels the older run of
that group. Only pull request runs are cancelled: a workflow that also runs on a push to `main`,
a schedule, a manual run or `workflow_call` sets `cancel-in-progress: ${{ github.event_name ==
'pull_request' }}`, so none of those runs is cut short once it runs (GitHub still keeps only
the newest queued run of a group). In a called workflow `github.event_name`
is the caller's event, so the upstream autopilot's and the Beta canary's calls of `e2e.yml` are
never cancelled while they run. `tools/test/workflow-concurrency.test.mjs` holds every workflow with a
`pull_request` trigger to this, and keeps concurrency groups distinct across workflows.
`dependabot-automerge.yml` is the one exception: its runs take seconds and act on the pull
request's merge state, so they keep their order.

A cancelled run does not hold a merge back. Required checks belong to a commit: the cancelled
run reported on the previous head, and the run of the newest head reports every required check
for it.

### PR mochitests (`e2e.yml`, ADR-010)

PRs run `tests/browser/` on an **artifact build**: our front end built on Mozilla's compiled
binaries for the release in `surfer.json`, on a GitHub-hosted runner. No runner, secret or
variable to set up. Same thing locally, next to the full build (≈ 0.6 GB, `engine/obj-artifact`):

```sh
npm run import
node tools/artifact-build/artifact-build.mjs     # ~25 s warm; first run downloads 163 MB
npm run mochitest -- --artifact tests/browser/
```

It runs on every PR except a docs-only one (above). Before the Firefox download it builds `vimma-ctl` and
runs the e2e harness's tests; after the mochitests, `npm run e2e -- --artifact`. For a PR opened
with `GITHUB_TOKEN`, mark it ready for review or `gh workflow run e2e.yml --ref <branch>`.

What it does not cover: compiled-in build config (C++ defines such as `--version`'s display
version and `MOZ_APP_NAME`, `--disable-crashreporter`; ADR-010 "Known gaps"). Tests of that carry
`skip-if = ["artifact"]` in `tests/browser/browser.toml`. **Until the nightly runner is live they
run only locally**, so a PR touching `*.patch`, `configs/`, `moz.configure` or branding must
report plain `npm run mochitest -- tests/browser/` on the full build (PR template checkbox).

The tool checks Mozilla's index first and prints how long the release build stays indexed. If it
fails, the message names the revision from `engine/sourcestamp.txt` and the expiry: check that
`surfer.json` points at a real release. It also refuses a display version ending in `aN`/`bN`
or containing `esr`, which would make mach search the wrong tree.

Fork PRs run the same job with a read-only token and no secrets; GitHub asks you to approve
every run from an external contributor (Settings → Actions → General; the approval policy is
`all_external_contributors`).

### Actions minutes budget

The repo is public (since 2026-10-10), so standard GitHub-hosted runners cost nothing and have
no monthly cap: minutes are no longer a reason to skip a job. What still matters is wall time
(a PR waits for its slowest required check) and the concurrency limit on hosted runners (20
jobs at once on the free plan), so keep jobs lean all the same. Rough wall time per PR push: CI ≈ 3–4
min, e2e ≈ 13 min, Semgrep ≈ 1 min, CodeQL ≈ 1 min (JavaScript) plus 2 min (Rust).
A push to `main` repeats only CodeQL and, when the merged tree differs from the pull request
head's, the rest ("Once per tree" above).

The release pull request is rebuilt by release-please after each merge to `main` that adds a
changelog line. It is opened as a draft, so a rebuild runs only CI and the key guard (about 4
min) and skips the mochitests, Semgrep and CodeQL ("Draft pull requests" above). Marking it
ready for review runs them once on the final state, `browser_vimma_app_version.js` included,
which checks the display version the build carries; the docs-only path never applies, because
the version in `surfer.json` changes. With `RELEASE_PLEASE_TOKEN` set, a rebuild pushes twice
(release-please, then the `firefox-notes` commit), and the second push cancels the first run;
without it, the release PR's pushes start no runs.

e2e.yml has no paths filter: "mochitest (artifact build)" is a required check, so the workflow
starts on every PR, and on a docs-only one the job skips by `if:` in seconds (above). The upstream autopilot runs 6 × 1 min a day, plus ≈ 16 min (issue, patch check, the
e2e suites, PR) when a release is found (spec m7-upstream-autopilot); claude.yml only when
triggered. `nightly.yml` and `release.yml` run their full builds on GitHub-hosted runners too:
about 124 min per nightly and 117 min per release, free on a standard runner, and off until
their variables are set ("Full builds" below). Usage is listed in Settings → Billing → Usage.

The bench step adds about 45 seconds to each CI run. `mutation.yml` is the largest scheduled
cost: a full run (first Sunday of the month) is estimated at 60–90 min on the 2-CPU runner
(4 916 mutants; 22 min with 12 workers locally, about 0.6 s per mutant per CPU), an incremental
week a few minutes plus one for the report job: roughly 100 min a month, free now. If the full
run gets too slow, narrow `mutate` in `stryker.config.mjs` or drop the monthly full run.

`sites.yml` (spec site-compat) runs one job a night at 04:30 UTC, and by hand: about 3.6 min of
setup (e2e.yml's steps up to the artifact build) plus the site list, about 15-20 min in all
(≈ 600 min a month, free on a standard runner). It never runs on pull requests and is not a
required check. A blocked site's retry adds about 30 s each, and the diff and the issue job
under a minute. To make it lighter, shorten `tools/sites/sites.json` or move its `cron` to fewer
nights.

`fuzz.yml` runs one job of about 5 min a night (≈ 150 min a month), plus a one-minute report job
on a failure. To halve it, run it on fewer nights (its `cron`) or lower `VIMMA_FUZZ_TIME_MS`.
The seeded fuzz properties add a few seconds to each CI run, and compiling proptest about 10 s.

`patch-audit.yml` (the quarterly patch audit, docs/rebase.md "Patch-size audit") runs two
one-minute jobs four times a year: no npm or toolchain install, only the runner's `python3`.

`upstream-beta.yml` (the Beta canary) checks for a new Firefox Beta build every 6 hours, under a
minute each time (about 2 hours a month). Each Beta build is tested once, about 16 minutes (the
patch check 2, `e2e.yml` 12, render and report 1): five builds per two-week cycle, about 11
tested builds and 3 hours a month. One run uses one hosted runner at a time.

### Mutation testing (`mutation.yml`)

Plan §5: Stryker mutates `packages/vimma-core/src` (not `vendor/`) every Sunday and runs the core's
tests against each mutant. A mutant that no test fails on **survived**: the tests would not notice
that change to the code. Survivors never fail the workflow; they go into one open issue labelled
`mutation`, which each run rewrites (and closes when none are left). Only a broken run is red.

Reading the issue and the report:

- The issue lists survivors per file as `L<line>:<col> <mutator> → <replacement>`. The HTML report
  (artifact `mutation-report` on the run, or `reports/mutation/mutation.html` locally) shows each
  one in the source, which is easier for more than a handful.
- `NoCoverage` means no test runs that code at all (rare: the coverage gate is 90 %).
- `Timeout` counts as killed: the mutant made the tests hang (usually a loop condition). Under
  heavy local parallelism a slow survivor can time out instead; CI's two workers are the reference.
- For each survivor: write a test that fails on the mutant, red first (plan §5), naming the
  behaviour, not the mutant. If the mutant cannot change behaviour (an equivalent mutant, e.g. a
  redundant guard or a log message), mark it in the source with
  `// Stryker disable next-line <Mutator>: <why it is equivalent>`; the reason is required.
- Do not chase 100 %: string-literal mutants in error messages, for example, are fine to leave
  when no caller depends on the text.

Locally: `npm run mutation` (full run the first time, about 20 min on 12 cores; later runs reuse
`reports/mutation/stryker-incremental.json` and re-test only changed files, `npx stryker run --force`
to redo everything); `npx stryker run --mutate packages/vimma-core/src/keys.mjs` for one file.

How it runs, and why: Stryker's `command` runner runs `vitest run` on the core's tests once per
mutant (`packages/vimma-core/vitest.config.mjs`, one worker, `--bail 1`). The dedicated
`@stryker-mutator/vitest-runner` 10.0.0 is not used: with Vitest 5 it skips every test inside a
`describe()` and reports their mutants as survivors (spec ci-quality-gates). Each run uploads its
results; the next week's run downloads them (`actions: read`) and re-tests only the mutants in
changed files. Because that cannot see new tests, the first Sunday of the month (or
`gh workflow run mutation.yml -f full=true`) re-tests everything. The job running Stryker has no
write token; the separate report job alone has `issues: write`.

### Fuzzing (`fuzz.yml`, spec m7-fuzzing)

The parsers of outside input (control protocol, `config.toml`, routing rules, key notation, the
command line, the Omarchy theme reader, vimma-ctl's JSON and decoders, `vimma-ctl mcp`'s JSON-RPC)
have property-based fuzz tests: fast-check in `packages/vimma-core/test/fuzz/`, proptest in
`tools/vimma-ctl/tests/protocol_props.rs` and `tools/vimma-ctl/tests/mcp_props.rs`. Every CI run checks them with a fixed seed and few
cases. `fuzz.yml` runs them nightly with a random seed and many more cases; on a failure it
uploads the artifact `fuzz-failures` (`seed.txt`, one JSON file per failing JavaScript property
with its seed, replay path and counterexample, and proptest's `*.proptest-regressions`) and opens
or comments on one issue labelled `fuzz-failure`. Close the issue when the fix is merged.

A manual run: `gh workflow run fuzz.yml` (random seed), or `-f seed=123 -f runs=5000`.

#### Fuzzing: reproducing a failing seed

JavaScript. The issue and the failure file give the seed and, per property, the replay path
(`counterexamplePath`). One property, one case, at once (the failure file's `replay` line is this
command, filled in):

```sh
VIMMA_FUZZ_SEED=<seed> VIMMA_FUZZ_PATH=<path> npx vitest run packages/vimma-core/test/fuzz \
  -t '<test title>'
```

`-t` takes the test's title as written in `test(...)`, not the failure file's name
(`config-no-throw`), which matches nothing and so runs no test.

Without `VIMMA_FUZZ_PATH`, the same seed and `VIMMA_FUZZ_RUNS` repeat the whole search (the
nightly used `VIMMA_FUZZ_RUNS=1000000` with a 15 s limit per property, so a late failure can
take that long). fast-check prints the shrunk counterexample; turn it into a plain regression
test next to the parser (see the "Regression (found by the fuzzer …)" tests), red first, then
fix. A hang leaves only `seed.txt`: run the target's file with that seed and a small
`VIMMA_FUZZ_TIME_MS` budget to find the slow input.

Rust. proptest is deterministic per seed:

```sh
cd tools/vimma-ctl
PROPTEST_RNG_SEED=<seed> PROPTEST_CASES=200000 cargo test --release --test protocol_props --test mcp_props
```

or copy the artifact's `protocol_props.proptest-regressions` (or `mcp_props.…`) to `tools/vimma-ctl/tests/`, where
proptest replays its `cc` lines first in every run; commit it with the fix as the regression.

Locally, a longer search than CI's: `VIMMA_FUZZ_SEED=$RANDOM VIMMA_FUZZ_RUNS=5000 npx vitest run
packages/vimma-core/test/fuzz` (about a minute).

### Bench baseline (`ci.yml`)

Plan §5, issue #17: key-to-action in core must stay under 50 µs and must not regress by more
than 10 %. `npm run bench` measures five cases (a single key, the prefix plus a key, a count plus
a motion, a two-key sequence, and applying a pane-focus action to a 30-tab workspace) from
`packages/vimma-core/bench/cases.mjs`, twice: as the working tree has them and as the **baseline
commit** named in `packages/vimma-core/bench/baseline.json` has them, in the same processes,
sample by sample. `npm run bench -- --check` is the CI step (about 45 s). It fails when:

- any case of the working tree takes **50 µs or more** (budget), or
- the **suite**, the geometric mean of the cases' changes against the baseline commit, is more
  than **10 %** slower, or one case is more than **25 %** slower, or a case of the baseline
  commit is gone.

The gate is the same on every machine: there are no per-runner numbers to fall back from.
`--base <commit>` measures against another commit, for example `--base origin/main` to see what
a branch costs before opening a pull request.

Why it does not flake (plan §5: no retries; flaky means quarantine):

- **The baseline is measured in the same run (issue #342).** Until issue #342 the baseline was
  numbers, one entry per runner class, recorded by other jobs. Unchanged code then read up to
  +12.5 % on the suite against them: over 88 CI runs on `main`, the Xeon 8370C entry (two
  samples) read +11.6 % to +12.5 % every time, the EPYC 9V45 and 9V74 entries +5 % to +9 %, and
  one Xeon 8573C job +10.7 %. A recorded number carries its job's image, neighbours and load, and
  the gate's 10 % margin went on that. Now both sides of each case run on the same runner, in the
  same 15 processes, a few milliseconds apart; in 20 hosted jobs over six CPU models, unchanged
  code read −1.6 % to +3.4 % on the suite (cases −3.3 % to +8.7 %), and `main` against the
  baseline commit −0.7 % to +1.6 % (cases −4.3 % to +5.8 %).
- **Sample by sample, not case after case.** Each sample sweeps over every case in an order that
  rotates per sample. Measured case after case, each case's 51 samples took their own block of
  time, and a change in the runner's load between two blocks (another process on the sibling
  hyperthread slows an allocating case more than the reference) moved one side against the
  other: in the gate's own test (below), unchanged code read from −21 % to +40 % on one case under
  the coverage pool; sample by sample, from −14 % to +12 %.
- **Load order alternates.** Two copies of identical code in one process differ by several per
  cent on the sub-microsecond cases, one way or the other, from process to process. Loading the
  working tree first in every process leaned that one way (+6 % to +8 % on the suite for
  identical code on one machine), so every other process loads and lists the baseline first,
  and the gate takes each process's own change (working tree over baseline), the median of
  those per load order, and the geometric mean of the two orders. A median of each side alone,
  or of all the changes, would keep the lean: with 8 processes of one order and 7 of the other, a
  7 % lean read identical code at +6.2 % and +7.0 %.
- **Ratios, not raw times.** Each sample times a case and then a fixed reference workload; the
  gate compares the case/reference ratio. A clock change or a busy neighbour mid-run moves both.
- **A reference that costs the same in every process.** The reference looks up integer keys in a
  `Map`. V8 hashes strings with a hash seed it picks at random per process, so a string-keyed
  table gets a different bucket layout in each process; the old string-keyed reference was up to
  22 % slower or faster from one process to the next on an AMD EPYC 7763, and every ratio of that
  process moved with it (issue #125). Integer keys are hashed without the seed. Each bench prints
  the spread (`reference 0.480 µs, +0.2 % from fastest to slowest process`); a large one says the
  reference stopped being steady.
- **The same hash seeds on every run.** The cases do use string keys (the dispatcher's trie), so
  each of the 15 processes runs with its own fixed `--hash-seed` (1 to 15): every run measures the
  same set of table layouts, not 15 new random ones.
- **Robust statistics.** Warm-up, batches of ≥ 100 µs, the median of 51 samples per round, the
  median over 5 rounds, per process. Over the 15 processes: the **lowest µs** for the budget
  (noise only adds time) and the **median change** for the gate. Not the lowest ratio: noise in
  the reference's time lowers a ratio, so the lowest ratio picked whichever process had the
  slowest reference (issue #125, PR #121).
- **It still catches a real slowdown.** A dispatcher made 20 % slower fails the gate
  (`tools/bench/test/bench.test.mjs`): the test measures the baseline, an unchanged copy and the
  slowed code as variants of one `measure()` call, as the bench measures its two sides, and gates
  the median of three such runs. By hand: a loop of 24 multiply-adds at the top of `dispatch()`
  read +15.2 % on the suite against `--base HEAD` and the step exited 1.
- **The budget has headroom.** The slowest case is about 17 µs on CI, the key cases under 1 µs.

If the step does fail without a slowing change, that is a flake: quarantine per plan §5 (open an
issue with the log; do not re-run to green), and look at the numbers before touching thresholds.

**Node is pinned exactly** in `.nvmrc`; ci, e2e, mutation, fuzz, sites, release-please and claude
use `node-version-file: .nvmrc`, and so do the nightly and release build jobs. One exception:
release.yml's package job checks out a release tag (tags from before `.nvmrc` lack it) and stays
on major 22. A Node bump is its own PR, by hand (Dependabot has no `.nvmrc` support). The bench
needs nothing for it: both sides of the comparison run on the same Node.

Moving the baseline, deliberately (like snapshots: never to make a red run green without saying
why):

1. A change that is meant to cost time (a new feature in the dispatch path), or removing or
   renaming a case, is the reason to move it. A new case needs no move: it is measured, noted as
   having no baseline yet, and held to the budget until the baseline commit has it.
2. A pull request cannot name its own merge commit, so it states the cost it brings in
   `baseline.json`'s `accepted`, per case: `"prefix + key": { "change": 0.12, "why": "per-mode
leader lookup" }`. The gate then compares the case with the baseline commit's time plus 12 %,
   and prints the accepted cost as a note. `npm run bench` shows the cost to put there.
3. A later pull request moves `commit` to a commit that has the change and empties `accepted`.
   Removing or renaming a case needs the same move: the commit must not have the old case.
4. The commit body carries a changelog line naming the cases and the change, e.g.
   `bench baseline: prefix + key +12 % from per-mode leader lookup (intended)`.

`--base <commit>` ignores `accepted`, which is relative to the stored commit.

### Key-to-paint timings (`browser_vimma_perf.js`)

Plan §5's second perf line, key-to-paint in the window, and plan §9's 200-tab risk, measured
read-only in a mochitest (no paint timestamp on the control socket): `performance.now()` just
before `EventUtils.synthesizeKey`, again when the synchronous key handling returns (**action**),
and at the first `MozAfterPaint` of the chrome window after which the result holds (**paint**).
21 presses per case; each case logs one line:

```sh
npm run mochitest -- --artifact tests/browser/browser_vimma_perf.js 2>&1 | grep VIMMA_PERF
```

| Case                | What                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `floor`             | an outline on the status bar, no key: the paint pipeline alone           |
| `key-floor`         | `ctrl+b esc`: two synthesized keys through Vimma's dispatch, no action   |
| `pane-focus`        | `ctrl+b l` / `ctrl+b h` across two live example.com panes                |
| `workspace-200-in`  | `ctrl+b )` from `main` into a workspace of 200 tabs (lazy `about:blank`) |
| `workspace-200-out` | `ctrl+b (` back, hiding the 200                                          |

Read paint against `floor`: in the headless test run the refresh driver's next paint comes
about 35 ms after any change (measured locally), so "key-to-paint < 5 ms" as an absolute is not
measurable there; what Vimma adds is action time plus paint minus floor. Local numbers
(2026-10-10, artifact build, headless, medians): floor paint 35.5 ms; key-floor action 1.1 ms;
pane-focus action 8.6 ms, paint 36.7 ms; workspace-200-in action 9.0 ms, paint 35.8 ms;
workspace-200-out action 8.6 ms, paint 34.7 ms. So 200 hidden tabs cost about as much to switch
as one pane focus, and both land in the first paint after the key; the time goes to the
synchronous action (tab selection), not to waiting for a frame.

CI (two e2e runs on PR #108, `ubuntu-24.04` hosted runner, headless artifact build, medians,
first / second): floor paint 35.1 / 36.2 ms; key-floor action 0.8 / 1.1 ms; pane-focus action
8.7 / 10.6 ms, paint 37.9 / 40.7 ms; workspace-200-in action 9.2 / 12.8 ms, paint 55.4 / 76.4
ms; workspace-200-out action 9.4 / 12.8 ms, paint 36.6 / 56.5 ms. Into the 200-tab workspace
takes one or two frames more on CI than locally.

**Budgets** (`BUDGETS` in the test, on medians, about twice the higher CI median): action 25
ms for all three cases; paint 85 ms for pane-focus, 150 ms for workspace-200-in, 115 ms for
workspace-200-out. Past one means a doubled action or about two extra frames, not runner noise.
The floors are not gated. Plan §5's "< 5 ms key-to-paint" cannot be checked as an absolute in
a headless run whose paints come every ~35 ms; the closest gated reading is the action time,
8 to 13 ms today, mostly Firefox's own tab selection. Re-record from CI
numbers only, with a changelog line in the commit body; two CI samples back them so far, so add
later runs' `VIMMA_PERF` lines here before tightening anything.

### Full builds (`nightly.yml`, `release.yml`)

Full builds, the nightly and every release, run on GitHub-hosted runners. Vimma has no
self-hosted runner and none is planned: on a public repository that takes pull requests from
forks, a self-hosted runner is a machine anyone who opens a pull request could run code on, and
it would hold the Safe Browsing key between runs (spec
[build-supply-chain](specs/build-supply-chain.md), decisions 6 and 7). Do not register one.

The build jobs of both workflows run on `ubuntu-24.04`, and a test fails if any workflow names a
self-hosted runner or a label that is not a standard GitHub-hosted image
(`tools/test/self-hosted-runner.test.mjs`, docs/security.md B5). Both install with
`npm ci --ignore-scripts` and run Surfer with `npx --no -- surfer`, so a missing
`node_modules/.bin/surfer` fails the job instead of fetching whatever npm package is called
`surfer`.

Both build jobs run on `ubuntu-24.04` and start from nothing: a clean checkout, Node from
`.nvmrc` with no npm cache, no Actions cache and no compiler cache (rule B2). The Firefox source
comes only from `tools/upstream/firefox-source.sh`, which downloads the tarball `surfer.json`
names, checks it against Mozilla's `SHA512SUMS` and Mozilla's signature on it (rule B1, next
section), deletes `engine/` and lets Surfer extract the verified file. After `npm run import` the build step deletes `engine/.git`: `surfer import` needs
that empty repository, but with it `mach` finds none of Mozilla's toolchains for
`--enable-bootstrap` (spec build-supply-chain, R14).

Measured on 2026-10-15 (run 38723067541, image `ubuntu-24.04` 20261012.334.1, 4 CPUs, 16 GB of
memory, Firefox 158.0, a keyless build of `main` as the nightly builds it):

| Step                                        | Time    | Disk, memory                                                  |
| ------------------------------------------- | ------- | ------------------------------------------------------------- |
| Free disk before anything                   |         | 86 GB of 145 GB                                               |
| `npm ci`, `firefox-source.sh`, import       | 1 min   | tarball 0.8 GB, tree 4.7 GB                                   |
| `surfer build` (cold, empty sccache)        | 113 min | 26 GB (`engine/` 21 GB, `~/.mozbuild` 2.5 GB, sccache 2.7 GB) |
| Peak memory (the Rust stage, minutes 20-35) |         | 15.3 GB of 16 GB, plus 10.4 GB of swap                        |
| Full mochitest suite                        | 7 min   | 78 tests, 6,355 checks, 0 unexpected                          |
| `./mach package`                            | 2.4 min | 87 MB tarball                                                 |
| Whole job                                   | 124 min | peak 42 GB used including the swap file                       |

Without the 16 GB swap file both jobs create, the first measured build was killed after 38 min
(run 38718105585, exit 143, while the Rust stage held all of memory). `timeout-minutes` is about
1.5 times the measured job: 190 for the nightly, 180 for the release (which runs no
mochitests). Each job's disk guard fails at once when less than 50 GB is free: the build needs
about 26 GB and the swap file 16 GB. The free space is a property of the runner image, not a
documented guarantee (GitHub documents 14 GB); if the guard fails, the image has shrunk, and
removing preinstalled toolsets (`/usr/local/lib/android` alone is about 9 GB) is the first fix.

**Switching them on.** Both stay off until a repository variable says otherwise:

```sh
gh workflow run nightly.yml --ref main                # one manual nightly from main, to check it
gh variable set NIGHTLY_ENABLED --body true           # then the 03:00 UTC schedule
gh variable set RELEASE_ENABLED --body true           # releases (set; drafts keep the gate)
```

What the nightly does once it runs: a full build of `main`, the full mochitest suite on it, the
package as the run's `vimma-nightly` artifact (kept 7 days), and on failure the log as the
`nightly-log` artifact and an issue labelled `nightly-failure` (comment `@claude` on it to hand
it to Claude Code). It creates, replaces and deletes no release: nightlies stay off the release
page until the release gate (spec [build-supply-chain](specs/build-supply-chain.md), decision
23). The artifact is not private: the repository is public, so anyone signed in to GitHub can
download it from the run page or the API for the 7 days it is kept, and its name and size are
listed without signing in. To get the latest one:

```sh
run=$(gh run list -w nightly.yml -s success -L 1 --json databaseId --jq '.[0].databaseId')
gh run download "$run" -n vimma-nightly -D ~/Downloads/vimma-nightly
```

The `build` job holds a read-only token. Only the `report` job (`issues: write`) can write, and
it checks out and runs nothing from the repository: it opens the failure issue from the
redacted log. No job can write contents. Publishing nightlies as a release again is a workflow
change, reviewed in its own PR, when the release gate lifts. A `nightly` release published
before this change stays until `gh release delete nightly --cleanup-tag --yes` removes it.

### macOS build (`macos.yml`)

`macos.yml` cross-compiles the Apple Silicon build on a GitHub-hosted `ubuntu-24.04` runner and
checks it on a hosted `macos-15` runner ([ADR-018](adr/018-macos-cross-build.md), spec
[macos-build](specs/macos-build.md)). It runs every Monday at 05:00 UTC, by hand, and on pull
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
and renders a page headless; `tools/package/macos-app-check.sh` checks its `Assets.car` has
Vimma's `AppIcon` and none of Firefox's, and that its bundle identifier is `surfer.json`'s
`appId`. The rendered icon and the page are the run's `macos-smoke` artifact.

The `icons` job, on a hosted `macos-26` runner with Xcode 26.6 pinned, regenerates the committed
macOS icon files (`Assets.car`, `firefox.icns`, `document.icns` in `configs/branding/vimma/`)
from `configs/branding/vimma/logo-mac.png` and the Icon Composer source
`configs/macos/AppIcon.icon/icon.json`, and fails if they differ
(spec [macos-homebrew](specs/macos-homebrew.md), decision 13). `actool`, which compiles
`Assets.car`, ships only with Xcode, not the Command Line Tools. After changing the logo or the
icon source, either run `node tools/package/macos-icons.mjs` on a Mac with Xcode, or push and
copy the files from the run's `macos-icons` artifact, which also holds their renderings:

```sh
gh run download "$run" -n macos-icons -D /tmp/macos-icons
cp /tmp/macos-icons/{Assets.car,firefox.icns,document.icns} configs/branding/vimma/
```

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

`release.yml` has five macOS jobs, which run only while the repository variable
`MACOS_RELEASE_ENABLED` is `true` (spec [macos-build](specs/macos-build.md), decision 12):
`macos-build` builds as `macos.yml` does, from the release tag's commit and with the Safe
Browsing key, and renders the Homebrew cask `vimma.rb` for the `.dmg`
(`tools/package/cask.mjs`); `macos-smoke` checks the `.dmg` on a hosted Mac against the tag, and
installs it through the cask (`tools/package/cask-check.sh`); `macos-sign` signs both and
`SHA256SUMS-macos` with cosign while `SIGNING_ENABLED` is `true`; `macos-publish` uploads them
to the tag's release; `macos-tap` starts `homebrew.yml` on `main` for the tag once the release
is published. `homebrew.yml` has no `release` trigger, because that would run it from the tag
(step 7 of "Release packages"). No Linux job waits for them, so the Linux files reach the
draft first, and the `.dmg` follows hours later, usually after the draft has been published.
`macos-publish` adds the macOS files to a published release that has none; if it already has
them, a re-run needs `-f replace_published=true`. A macOS failure opens the same
`release-failure` issue as a Linux one; re-running the failed jobs of the run retries only
macOS.

```sh
gh variable set MACOS_RELEASE_ENABLED --body true      # on
gh variable delete MACOS_RELEASE_ENABLED               # off
```

The `.dmg` is ad hoc signed until the Developer ID exists (spec macos-build, open question 2),
so Gatekeeper asks once before it first opens (docs/guide.md, "macOS"); the Homebrew cask says
so in its caveats (spec macos-homebrew). vimma.dev is not affected (issue #393).

To bump rcodesign: take the new release's SHA-256 for
`apple-codesign-<version>-x86_64-unknown-linux-musl.tar.gz` from
`gh release view apple-codesign/<version> -R indygreg/apple-platform-rs --json assets`, and change
`RCODESIGN_RELEASE` and `RCODESIGN_SHA256` in `fetch-rcodesign.sh` together.

### Mozilla's release key (ADR-021)

Every path that gets Firefox source (`firefox-source.sh`, `source-check.sh`,
`npm run verify-source`) accepts a tarball only when its SHA-512 is in a `SHA512SUMS` signed by
Mozilla's release key, pinned in `tools/upstream/mozilla-release-key.asc` with the primary
fingerprint `14F26682D0916CDD81E37B6D61B7B526D98F0353` in `tools/upstream/verify-sha512.py`
(docs/security.md B1). The current signing subkey, `827E…7AA3`, expires 2028-08-05.

**When Mozilla rotates the signing subkey** (announced on the Mozilla Security Blog; until the
update lands, the autopilot, the canary and PR CI fail on releases the new subkey signed, with
`gpgv reported ERRSIG, NO_PUBKEY`):

```sh
curl -fsSL https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/KEY \
  -o tools/upstream/mozilla-release-key.asc
gpg --show-keys --with-subkey-fingerprints tools/upstream/mozilla-release-key.asc
```

Check, before opening the pull request: the primary fingerprint is still `14F2 6682 D091 6CDD
81E3 7B6D 61B7 B526 D98F 0353`; the new subkey's fingerprint and expiry are the ones in Mozilla's
announcement; every subkey marked `revoked` before is still revoked (the 2025 subkey
`09BE…0256` above all); the file is the same as the `KEY` beside the newest release
(`releases/<version>/KEY`). Cite the announcement in the pull request. Update the subkey and
expiry in ADR-021 and in this section, and add the new release's `SHA512SUMS` and `.asc` to the
fixtures only if a test needs a signature by the new subkey. A different primary fingerprint is
not a routine update: stop, and review ADR-021.

The pull request fails the required check "Mozilla release key unchanged or approved"
(`.github/workflows/key-guard.yml`) until a maintainer, after the checks above, adds the
`key-rotation-approved` label; adding it re-runs the check, except on a merged pull request
(a label change there skips it). Any change to
`mozilla-release-key.asc`, or to a line of `verify-sha512.py` that names `PINNED_FINGERPRINT` or
`KEY_FILE` (a comment included), needs the label, and so does any change to the guard itself
(`.github/workflows/key-guard.yml`, `tools/ci/key-guard.mjs`, `tools/ci/test/key-guard.test.mjs`):
review such a change as a change to the key check. Never add it to a pull request whose key change
is not a reviewed rotation; remove it if a later push changes the key again, since the label
stays on the pull request across pushes.

**The key watch.** Every 4 hours `upstream.yml`'s `detect` job compares Mozilla's
`nightly/latest-mozilla-central/KEY` with the pinned key (`tools/upstream/mozilla-key-check.py`,
docs/security.md B7) and the `key` job opens, or keeps current, one `security` issue per finding:
"Mozilla's release key changed" for a new subkey, a new revocation or a different primary key,
and "Mozilla's release signing subkey expires <date>" within 60 days of the pinned subkey's
expiry. The issue lists the fingerprints. For a new subkey or revocation, follow the steps above
and close the issue with the pull request; for a different primary key, stop and review ADR-021.
The check never edits the keyring. A failed download only warns in the run's log. Its fixtures,
`tools/upstream/fixtures/key/`, are Mozilla's `KEY` of 158.0 and the same key before the
2026-08-06 rotation, made by `make-pre-rotation.py` there.

The synthetic signature fixtures in `tools/upstream/fixtures/sums/synthetic/` come from
`tools/upstream/fixtures/sums/make-synthetic.sh` (throwaway keys, no secret key committed).

### Google Safe Browsing key (spec m0-safebrowsing-key)

Safe Browsing's phishing, malware and download lists need a Google API key compiled into the
build. `configs/common/mozconfig` passes it to configure only when the key file exists:
`$VIMMA_SAFEBROWSING_KEYFILE` if set (it must then name a file), else
`~/.config/vimma/keys/safebrowsing`. Without one the build is keyless and Vimma defaults Safe
Browsing off, so Settings shows it unticked. The key is a secret: never echo, log or commit it.

Get a key: Google Cloud console → a project → enable the **Safe Browsing API** → Credentials →
Create API key → restrict it to that API. Its use is free but non-commercial, and every keyed
build shares the one key and its per-project quota (Google Cloud console → Quotas); a large user
base or commercial use needs a quota increase or Google's Web Risk API. The key is compiled into
the binaries and can be extracted from them, as Firefox's own is. Google serves the download
lists (`goog-badbinurl-proto`, `goog-downloadwhite-proto`) and the remote download check only to
Mozilla's key, so Vimma requests neither. `goog-harmful-proto` is requested but did not arrive
when the key was tested; treat it as unavailable.

**Locally**, store it without it reaching the terminal or the shell history, then rebuild:

```sh
mkdir -p ~/.config/vimma/keys && chmod 700 ~/.config/vimma/keys
( umask 077; read -rs -p "Safe Browsing API key: " k; echo
  printf '%s' "$k" > ~/.config/vimma/keys/safebrowsing )
npm run import && (cd engine && ./mach build)   # the key is a configure input: full build
tools/safebrowsing-smoke/safebrowsing-smoke.sh   # needs the network; prints table names and sizes
```

The local artifact build copies the same mozconfig, so it is keyed too (rebuild it with
`node tools/artifact-build/artifact-build.mjs`). `npm run mochitest` passes
`VIMMA_EXPECT_SAFEBROWSING_KEY=1` when the key file exists, so a stale keyless build fails
`browser_vimma_safebrowsing.js`; set `VIMMA_EXPECT_SAFEBROWSING_KEY=0` to test a keyless build
on purpose.

**In CI**, the key is the secret `SAFEBROWSING_API_KEY` of the `build` environment, which only
`main` may deploy from (no tag: anyone who can push a tag could otherwise deploy an edited
workflow from it); only the `build` jobs of `nightly.yml` and `release.yml`
name that environment (docs/security.md, B6). A repository administrator sets it up once, in
this order (until step 3, the jobs keep reading the old repository secret, so nothing breaks):

```sh
R=repos/vimma-browser/vimma
# 1. The environment, deployable only from main.
gh api -X PUT $R/environments/build --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/build/deployment-branch-policies -f name=main -f type=branch
# 2. The key as an environment secret.
gh secret set SAFEBROWSING_API_KEY --env build < ~/.config/vimma/keys/safebrowsing
# 3. Delete the repository secret, so no other job can read it.
gh secret delete SAFEBROWSING_API_KEY
# Check: the environment holds the key, the repository does not.
gh secret list --env build                  # SAFEBROWSING_API_KEY
gh secret list | grep SAFEBROWSING || echo "no repository secret: done"
```

An environment secret takes precedence over a repository secret of the same name, so steps 1
and 2 can come before or after the workflow change; step 3 comes after step 2. `nightly.yml` writes it to a mode-600
file in `$RUNNER_TEMP` and deletes it after its last `mach` call. PR builds (`e2e.yml`) never get
it: they build keyless, which `browser_vimma_safebrowsing.js` checks. `release.yml`'s `build` job
does the same as the nightly, and its smoke check fails a release built without the key.

Debugging: `browser.safebrowsing.debug` = `true` logs list updates to stdout, with the key
replaced by `[trimmed-google-api-key]`. Still check before pasting a log anywhere.

**Forks:** the nightly and release builds fail closed without `SAFEBROWSING_API_KEY`. Set your
own key as a secret of a `build` environment in your fork (the steps above, with your
repository's name), or remove the key step (your builds then ship keyless, with Safe
Browsing honestly off).

**Rotate** (quota trouble or abuse; the key is extractable from every binary by design, so a
"leak" alone is no reason): create the new key in the console, replace the local file
(the `read -rs` line above) and the secret (`gh secret set --env build` as above), rebuild and run the smoke
script, then delete the old key in the console. Builds already shipped keep the old key and
stop getting lists once it is deleted, so rotate before a release, not after.

### Upstream bumps (`upstream.yml`, the upstream autopilot)

**What it does and what you do with its PR: [docs/rebase.md](rebase.md)**, section 1 (the
playbook also covers patch failures, builds, the security fast path and rollback). Spec
[m7-upstream-autopilot](specs/m7-upstream-autopilot.md), ADR-015.

In short: every 4 h `detect` (read-only, < 1 min, no secrets) reads product-details and the MFSA
index. For a newer Firefox it opens a tracking issue labelled `upstream` (+ `security` with the
advisory and severity, mentioning you), streams and SHA-512-verifies the source tarball, dry-runs
our patches, runs `e2e.yml` on the new version (import, artifact build, `tests/browser/`,
`tests/e2e/`), pushes `upstream/firefox-X.Y.Z` and opens the PR
`upstream: firefox X.Y.Z (MFSA YYYY-N)`, with the advisories that name the release, if any (a
later run updates the title when one appears). Each release is handled once (its branch
exists); `gh workflow run upstream.yml -f rebuild=true` redoes it. If `main` is more than 3
days behind a security dot release (7 for a major, 14 otherwise), the `drift` job opens a
`security` issue and the run fails until the bump is merged.

Permissions: the workflow grants nothing by default; `detect` reads contents and issues, `track`
and `drift` write issues, `patch-check` and `test` read contents only, and only `publish` can
push and open PRs. No job uses `pull_request_target`, and none gets `SAFEBROWSING_API_KEY`: the
artifact build is keyless by design; the key is only for the nightly and release builds.

One-time setup:

1. **Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create
   and approve pull requests".** Until then `gh pr create` fails with "GitHub Actions is not
   permitted to create or approve pull requests"; the autopilot detects that message, keeps the
   pushed branch, and comments the full summary and a prefilled compare link on the tracking
   issue instead (open the PR from there). The same setting serves release-please and claude.yml.
2. **`UPSTREAM_PR_TOKEN`.** Without it a PR opened with the default `GITHUB_TOKEN` starts no
   workflows, so the autopilot opens it as a draft (mark it ready for review to start `ci.yml`
   and `e2e.yml`) and never sets auto-merge. Create a fine-grained personal access token
   (Settings → Developer settings → Fine-grained tokens): resource owner `vimma-browser`,
   **Only select repositories → vimma**, repository permissions **Contents: Read and write** and
   **Pull requests: Read and write** (Metadata: read is added automatically), nothing else and
   **no Workflows**. Store it with `gh secret set UPSTREAM_PR_TOKEN -R vimma-browser/vimma`.
   Renew it before it expires; when it lapses, bumps fall back to drafts.
3. **Auto-merge** (spec upstream-bump-automation, ADR-022): `gh variable set
AUTO_MERGE_UPSTREAM -b all -R vimma-browser/vimma` lets GitHub merge a bump whose patches
   applied clean, whose suites passed and whose diff is only the version and copied prefs, once
   every required check is green (the PR's "Auto-merge" row says why when it does not). `dot`
   limits it to dot releases. To stop: `gh variable delete AUTO_MERGE_UPSTREAM`, and
   `gh pr merge <N> --disable-auto` on a PR already set. Repository auto-merge must stay allowed
   (Settings → General → Allow auto-merge).

When patches do not apply, the `patch-issue` job opens (or, on a rerun, updates) one issue per
Firefox version titled `Firefox X.Y.Z: patches do not apply`, labelled `upstream` and `triage`,
with the failing patches and hunks and links to the bump PR and the run. Assign it to a person
or to GitHub Copilot coding agent; rebase the patches on the bump branch (docs/rebase.md, step
3). Such a bump stays a draft and never merges itself. Close the issue when the bump merges.

Every bump: the copies of `browser.newtabpage.activity-stream.asrouter.providers.cfr` and
`browser.safebrowsing.provider.google{4,5}.lists` in
`src/browser/branding/vimma/pref/firefox-branding.js` must match the new engine's (specs
m0-mozilla-services, m0-safebrowsing-key). `tools/upstream/upstream-prefs.mjs` checks both in
`e2e.yml` and prints the line to paste; the autopilot's bump PR already carries refreshed lines
and lists them, so check only that the old and new values in its "Refreshed prefs" look right. A
pref gone upstream leaves the PR a draft that names it. Before a release, run
`tools/safebrowsing-smoke/safebrowsing-smoke.sh` on a keyed full build. Patch-size review
(plan §4, Sunday): `python3 tools/upstream/patch-audit.py`.

### Firefox Beta canary (`upstream-beta.yml`)

What it does and what its issue means: [docs/rebase.md](rebase.md), "Before the release: the Beta
canary". Spec [upstream-beta-canary](specs/upstream-beta-canary.md); ADR-002 as amended.

Schedule: `41 */6 * * *`. `detect` reads product-details' `LATEST_FIREFOX_DEVEL_VERSION` and
does nothing unless it is a Beta (`N.0bM`) of an unreleased Firefox, or when `main` tested that
Beta build in the last 7 days (an artifact `upstream-beta-<version>` of a run on `main`). Then
`source-check` (`tools/upstream/source-check.sh`, as `upstream.yml`), `test` (`e2e.yml` in Beta
mode with `fail-on-findings: false`), `render` (`tools/upstream/canary.mjs render`, uploads
`upstream-beta-<version>` for 30 days: `issue.json`, `state.json`, the patch check and the suite
results) and, on `main` only, `report`, which opens, updates or closes `Firefox N beta: canary
findings` (label `upstream-beta`) and closes the issues of released versions.

Permissions: nothing by default; `detect` reads contents and Actions artifacts; `source-check`,
`test` and `render` read contents; only `report` writes, and only issues, with no checkout. No
secrets. A red run means the canary is broken, not that it found something: findings go to the
issue.

By hand:

```sh
gh workflow run upstream-beta.yml                   # the current Beta, if not tested in 7 days
gh workflow run upstream-beta.yml -f version=159.0b2  # always tests that Beta
gh workflow run upstream-beta.yml --ref <branch> -f version=159.0b2  # a branch: no issue written
gh run download <run-id> -n upstream-beta-159.0b2   # issue.json, state.json, the reports
```

A manual run on a branch skips `report`, and its artifact does not count as `main`'s tested
build, so it never delays the scheduled run. To check a run: its summary shows the rendered issue
and the comment; the artifact holds the same in `issue.json`.

### Claude Code in GitHub (`claude.yml`)

Follows `anthropics/claude-code-action` v1. Until a secret exists every run is green and skips
all work with a notice.

1. Add one secret: `gh secret set ANTHROPIC_API_KEY`, or with a Pro/Max plan run
   `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN`. The Claude GitHub app is
   not needed: the workflow passes the job's own `GITHUB_TOKEN` (`github_token` input).
2. Create the labels: `gh label create spec`, `gh label create claude:go`
   (`bot`, `upstream`, `security`, `nightly-failure` are created by the workflows).
   Tick "Allow GitHub Actions to create and approve pull requests" (see Upstream bumps).
3. Use `@claude` in an issue, comment or review (only from the owner, members or collaborators).
   Claude answers, reviews and comments; it cannot push in this mode.
4. For code: add `claude:go` to a `spec` issue yourself (the job checks that the label was added
   by the maintainer, `MAINTAINER` in `tools/repo.mjs`, so a bot or a `@claude` request cannot chain into it). Claude
   implements and commits on a runner with a read-only token; a separate job without Claude
   applies the patch, pushes `claude/spec-<issue>` and opens a draft PR labelled `bot`.
5. CI does not start on that PR by itself (GITHUB_TOKEN PRs trigger no workflows): mark it ready
   for review, or `gh workflow run ci.yml --ref claude/spec-<issue>`. Claude Code never merges.

Tokens: because `github_token: github.token` is passed, each job's `permissions:` block is the
token Claude gets (without it the action would use the Claude app's installation token with
contents, pull-requests and issues write). `mention`: contents read, pull-requests and issues
write, actions read. `spec` (Claude): contents and issues read; tools limited to file edits,
`npm test`/`lint`/`typecheck`/`coverage`/`format`/`gen-docs`/`test:py`, `git add/commit/diff/
log/status` and `gh issue view`. Tests Claude writes still run as code on that runner, which is
why its token is read-only. `spec-pr` (no Claude): contents and pull-requests write;
GITHUB_TOKEN cannot change `.github/workflows`. No other secret is passed.

### Dependabot

`.github/dependabot.yml`: npm (`/`), cargo and rust-toolchain (`tools/vimma-ctl`) and GitHub
Actions, Mondays 06:00 Helsinki, releases at least 3 days old, minor and patch grouped into one
PR per ecosystem, majors one PR each. Actions stay pinned to commit SHAs. Security updates
(Dependabot alerts) open at once. `dependabot-automerge.yml` enables GitHub auto-merge (squash)
for security, patch and minor updates, so GitHub merges them once every required check is
green; majors, every GitHub Actions update (workflows hold write tokens and the model API secret)
and every change to a release-path package (Surfer, `ajv` and everything they depend on,
`node tools/deps/release-path.mjs`), security updates included, get a comment and stay open
for review. The workflow's `classify` job decides from the lockfile diff and puts each changed
package's `npm diff` in its summary and the `release-path-diff` artifact (30 days); the comment
links the run. If `classify` fails, the PR is held as well: re-run the workflow, or review it
as a release-path change. Surfer and `ajv` have their own `release-path` group, so a held
update does not hold the other minor and patch updates. No repository setting is needed:
`classify` is not a required check, because it runs only on Dependabot's PRs and the
`automerge` job reads its result directly.
`.npmrc` sets `ignore-scripts=true`: no install runs a package's install scripts. Policy in
CONTRIBUTING.md, "Dependency updates". Needs: Dependabot alerts and security updates on
(Settings → Code security), and "Allow auto-merge" on (it is).

A merge by auto-merge is pushed with `GITHUB_TOKEN`, which starts no workflow on `main`: the
push runs of CI, Semgrep and release-please wait for the next ordinary push to `main`.

### Releases (`release-please.yml`)

Plan §4/§7: [release-please](https://github.com/googleapis/release-please-action) (v5.0.0, pinned
by SHA) keeps one release PR open, `chore(main): release X.Y.Z`, updated on every push to `main`.
It holds the next version and that release's `CHANGELOG.md` entry, and opens as a draft
(`"draft-pull-request": true`). **Merging it is the release**:
release-please tags `vX.Y.Z` and creates the GitHub Release with the same notes, **as a draft**
(below). Its `release-build` job then starts `release.yml`, which builds, signs and uploads the
packages to that draft (below, "Release packages"). Publishing the finished draft is the
maintainer's one click.

- **Releasing, step by step:** mark the release PR ready for review (`gh pr ready <n>`, or
  "Ready for review" on the PR); that runs the mochitests, Semgrep and CodeQL, which its draft
  rebuilds skipped ("Draft pull requests" above). Merge it once every required check is green;
  the code scanning rule keeps it blocked until CodeQL has analyzed the final head. If `main`
  gets another merge first, release-please rebuilds the PR, which stays ready, and the full
  checks run again on the new head. release-please opens only new release PRs as drafts: to
  turn the open one into a draft, run `gh pr ready --undo <n>` (no run starts, and the results
  on its head stay as they are).
- **Version source:** `surfer.json` `brands.vimma.release.displayVersion`, the version
  `vimma --version` and the About dialog show (spec m0-app-version). The release
  PR bumps it through `extra-files` (jsonpath `$.brands.vimma.release.displayVersion`), plus
  `.release-please-manifest.json`, which must always match it (tested in
  `tools/package/test/release-workflow.test.mjs`). The Firefox pin `version.version` is never
  touched; `upstream.yml` owns it. Release type `simple`: there is no root `version.txt`, so
  nothing else is written.
- **Bumps** (`release-please-config.json`, spec release-versioning): every release bumps the
  patch, whatever its commits are, breaking changes included (`"versioning":
"always-bump-patch"`): 0.1.1 → 0.1.2 → 0.1.3. The maintainer decides when to move to 0.2.0 or
  1.0.0 (below). Changelog sections: `feat` → Added, `fix` → Fixed; `perf`, `deps`, `upstream`
  and `revert` → Changed; `docs`, `test`, `build`, `ci`, `chore` and `refactor` are left out. A
  breaking change still gets its "BREAKING CHANGES" heading in the notes.
- **Moving to 0.2.0 (or 1.0.0), when you decide:** merge a PR whose squash commit ends with the
  footer `Release-As: 0.2.0`. Squash merges use the PR body as the commit body, so make that line
  the last paragraph of the PR body, on its own line, after the generated-by lines (any PR will
  do, such as the next small docs fix). release-please reads the footer before the versioning strategy, so the
  open release PR becomes `chore(main): release 0.2.0`; merge that. The footer applies once: the
  next release PR starts after the `v0.2.0` tag (which `force-tag-creation` creates even for a
  draft), so it no longer sees that commit, and patch bumps go on: 0.2.1, 0.2.2. **Use the
  footer, not `"release-as"` in the config.** The config option is applied before any commit is
  read, so it pins every later release PR to 0.2.0 until a second PR removes it; forget that,
  and every later release PR proposes 0.2.0 again. If the footer was not picked up (the release
  PR still shows the old next version), look at the squash commit's message on `main`:
  `Release-As:` must be in its last paragraph.
- **Every release starts as a draft.** `"draft": true` makes each GitHub Release a draft: only
  collaborators see it, and its download URLs answer 404 to everyone else. `release.yml` fills
  it with the packages while it is a draft, so a failed build is found before anything is public,
  and publishing it is one click on a release that already has its files. GitHub creates no tag
  for a draft, so `"force-tag-creation": true` makes release-please create `vX.Y.Z` first;
  without the tag, the next release PR would not find this release and would list every commit
  since the first one, and `release.yml` would have nothing to build. To ship a draft once its
  build is green: Releases → the draft → Edit → "Publish release". Publishing builds nothing;
  it starts `aur.yml`, which pushes the AUR package (below, "Release packages").
- **Keep drafts on, also once the release gate opens** (no public release until the maintainer
  has daily-driven Vimma). The gate is the click on "Publish release", not the config. Without
  `"draft"`, release-please would create a published release two hours before its files exist,
  and `aur.yml`, started by that publish, would fail on the missing files. A test keeps `draft`
  and `force-tag-creation` on.
- **The changelog line is the commit subject; the body explains why** (CONTRIBUTING.md). release-please
  writes subjects only. Firefox bumps are `upstream: firefox X.Y.Z (MFSA YYYY-N)` (upstream.yml),
  so a security dot release alone still produces a release PR (ADR-015: merged within 3 days).
- **The Firefox version in titles and headings** (spec firefox-versions). release-please can only
  title a release `vX.Y.Z` and head its entry `## [X.Y.Z](compare) (date)`, so two jobs after it
  edit both with `tools/release/firefox-notes.mjs` (idempotent: a second pass changes nothing):
  - `firefox-notes`, on every run while the release PR is open: reads `CHANGELOG.md` and
    `surfer.json` from `release-please--branches--main` through the API, and when the newest
    heading lacks it, pushes one `chore(release)` commit that makes it
    `## [X.Y.Z](compare) · Firefox <version> (date)` and turns each bump line into
    `Firefox <version> ([MFSA YYYY-N](advisory))`. The push uses `RELEASE_PLEASE_TOKEN` (a
    `GITHUB_TOKEN` push would leave the release PR without required checks); without the token the
    job logs a notice and does nothing. release-please rebuilds the branch (dropping the commit)
    only when the notes change, and the job then adds it back in the same run. The PR body keeps
    release-please's heading.
  - `release-title`, when a release was created: checks out its tag, titles it with
    `node tools/release/version-line.mjs` (`Vimma X.Y.Z · Firefox <version>`, which must start
    with the tag's version) and applies the same edit to its notes, through `GITHUB_TOKEN`
    (`contents: write`). It changes only the name and the notes; a draft stays a draft. The
    edit resends the tag it verified (`tag_name`): GitHub detaches a draft from its tag when an
    edit leaves `tag_name` out (it becomes `untagged-…`), and publishing that draft would create
    a new tag on `main`'s head and build that commit. The job fails if the edited release names
    any other tag. To reattach a detached draft (`gh release edit` cannot find it by tag), find
    its id with `gh api repos/vimma-browser/vimma/releases --jq '.[] | [.id, .tag_name]'` and run
    `gh api --method PATCH repos/vimma-browser/vimma/releases/<id> -f tag_name=vX.Y.Z`.

  Check either by hand: `node tools/release/firefox-notes.mjs CHANGELOG.md --surfer surfer.json`
  prints the edited file, and `node tools/release/version-line.mjs` the title.

- **First release (one-time).** No `v0.1.0` tag exists, and the manifest's `0.1.0` (what every
  build so far shows) counts as released, so the first release is **0.1.1**: the release PR
  `chore(main): release 0.1.1` on branch `release-please--branches--main` lists every
  `feat`/`fix` since the first commit and puts its entry above the hand-written
  `## [Unreleased]` section. Just before merging it, edit `CHANGELOG.md` on that branch: replace
  the generated `0.1.1` list with the `[Unreleased]` sections and delete that heading. The
  generated list also has a false "BREAKING CHANGES" item (cd70146's body has a line starting
  `BREAKING CHANGE:`). release-please rewrites the branch on every push to `main`, so make the
  edit last, on top of the `firefox-notes` commit (pull the branch first; keep the
  `· Firefox <version>` in the `0.1.1` heading). From then on every entry is generated.
- **A merged security bump releases itself** (`security-release`, spec firefox-versions,
  ADR-020), once `AUTO_SECURITY_RELEASE` is `true`. After a push to `main` that is the squash
  merge of the autopilot's `upstream/firefox-<version>` PR labelled `upstream` and `security`,
  `tools/release/security-release.mjs` sets the open release PR to auto-merge with
  `RELEASE_PLEASE_TOKEN`, pinned to its head commit (`--match-head-commit`), and comments on the
  bump PR. A draft release PR is first marked ready for review through the same token, since
  GitHub never merges a draft; that starts the full checks the draft skipped, and the job sets
  auto-merge only once the newest mochitest and Semgrep checks on the head are no longer the
  draft's skips (it polls the head's check runs for up to 3 minutes, and fails without setting
  auto-merge if they do not start; a person then merges the ready PR). GitHub merges it
  when the required checks pass; that merge's push starts this workflow again, which tags and
  creates the draft release and starts `release.yml`. Publishing the draft stays a click. Any other push logs a notice naming the check that did not hold (the run's
  summary), and the job never merges the first release PR (it requires an existing release).
  Commits merged after the bump and before the checks finish ship in the same release.
  `RELEASE_PLEASE_TOKEN` is required: with the variable on and no token, the job fails.
- **Names.** `include-component-in-tag` is off, so tags are `vX.Y.Z`, the branch is
  `release-please--branches--main` and the PR title `chore(main): release X.Y.Z`.

One-time setup:

1. Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create and
   approve pull requests" (the same setting as for upstream bumps).
2. Optional: the release PR, opened with `GITHUB_TOKEN`, triggers no CI until it is marked
   ready for review (by a person, so the event starts the workflows). Run
   `gh workflow run ci.yml --ref release-please--branches--main` before merging, or store a
   fine-grained token for this repo only (Contents, Pull requests and Issues: read/write) as
   `gh secret set RELEASE_PLEASE_TOKEN`; the workflow uses it when present.
3. Nothing more for the release build: tags and releases created with `GITHUB_TOKEN` trigger no
   workflows, but `release-build` starts `release.yml` with a `workflow_dispatch`, which
   `GITHUB_TOKEN` may send ([GitHub Docs, "Triggering a workflow from a
   workflow"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)),
   so `RELEASE_PLEASE_TOKEN` is not needed for it.

The release-please job's token has `contents`, `pull-requests` and `issues: write` (labels go
through the issues API); it runs no repository code. `firefox-notes` reads with `contents` and
`pull-requests: read` and writes only through `RELEASE_PLEASE_TOKEN`; `release-title` has
`contents: write` and nothing else. Both run only `main`'s `tools/release/` (the tag is a commit
on `main`), never code from the release branch, and keep no token in their checkout.
`security-release` has `contents: read` (it checks out `main`) and reads and merges only through
`RELEASE_PLEASE_TOKEN`.
`release-build` has `actions: write` and nothing else, runs no repository code, and only sends
the `workflow_dispatch` for `release.yml` on `main` with the new tag; it runs only when a release
was created and `RELEASE_ENABLED` is `true`.

Turning on security releases (`AUTO_SECURITY_RELEASE`), once, while releases are still drafts:

1. Check that `RELEASE_PLEASE_TOKEN` is set and unexpired (`gh secret list`), and that
   Settings → General → "Allow auto-merge" is on (`gh api repos/vimma-browser/vimma --jq
.allow_auto_merge` prints `true`).
2. `gh variable set AUTO_SECURITY_RELEASE --body true`.
3. Dry run, while `"draft": true` keeps everything private: open a PR from a branch named
   `upstream/firefox-<the version on main>` that changes only a comment, titled
   `upstream: firefox <that version>`, labelled `upstream` and `security`, and merge it. In that
   merge's `release-please` run, `security-release` should report the release PR set to
   auto-merge and comment on the PR; the release PR should then merge on its own once green,
   and a draft titled `Vimma 0.1.x · Firefox <version>` should appear. If the release PR waits
   for an approval instead (the ruleset's `require_extra_approval_for_unattributed_changes`),
   record it and turn the variable off until that is resolved. Afterwards delete the draft and
   its tag (`gh release delete v0.1.x --cleanup-tag`); the version moves on.
4. To stop the chain: `gh variable delete AUTO_SECURITY_RELEASE`, or for one release PR
   `gh pr merge --disable-auto <n>`.

### Release packages (`release.yml`, spec m6-packaging)

When release-please creates a draft release (above), its `release-build` job starts `release.yml`
on `main` with the new tag (`workflow_dispatch`). `release.yml` builds Vimma, packages it on a
hosted runner, signs, and uploads to that draft. Its `build` job builds on `ubuntu-24.04` from
freshly verified source in about 2 hours ("Full builds" above). When the maintainer publishes
the draft, `aur.yml` pushes AUR `vimma-bin`, and once the macOS files are on the published
release, `release.yml`'s `macos-tap` job starts `homebrew.yml`, which pushes the Homebrew cask;
publishing builds nothing. **Every job of these workflows is off until `RELEASE_ENABLED` is `true`**, manual
runs included, and `homebrew.yml` also needs `MACOS_RELEASE_ENABLED`.

`release.yml` starts only by `workflow_dispatch` and only from `main`, because the alternatives
are weaker. A draft fires no `release` event, and a tag pushed with `GITHUB_TOKEN` starts no
workflow. `push: tags: v*` with the tag pushed by `RELEASE_PLEASE_TOKEN` would also start a
signed build for any hand-pushed `v*` tag, and would depend on a personal token. Calling
`release.yml` as a reusable workflow from `release-please.yml` would run the two-hour build
inside that workflow's run, holding back release-please on every push to `main` in the meantime,
and would hand the caller job every permission of every release job at once. A dispatch is the
same call as the manual re-run, so one path is exercised every time.

| Asset                             | What                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `vimma-X.Y.Z-linux-x86_64.tar.xz` | `./mach package`'s tarball, renamed (one `vimma/` directory)    |
| `vimma-X.Y.Z-x86_64.AppImage`     | AppImage (appimagetool 1.9.1, runtime 20251108, both pinned)    |
| `vimma_X.Y.Z_amd64.deb`           | `/usr/lib/vimma`, `/usr/bin/vimma`, desktop file, icons         |
| `vimma-X.Y.Z-1.x86_64.rpm`        | the same layout as the `.deb`, for Fedora and openSUSE          |
| `vimma-X.Y.Z.cdx.json`            | CycloneDX 1.6 SBOM (`tools/package/sbom.mjs`)                   |
| `PKGBUILD`                        | `vimma-bin` for Arch Linux; its only source is the tarball      |
| `SRCINFO`                         | its `.SRCINFO` (GitHub renames an asset with a leading period)  |
| `SHA256SUMS`                      | checksums of the seven files above                              |
| `*.sigstore.json`                 | cosign keyless bundles, one per file above (when signing is on) |

Jobs: `build` (read-only token and the Safe Browsing key; first checks that the tag is
`vX.Y.Z` and that its commit is on `main`) → `package` (AppImage, `.deb`, `.rpm`, `PKGBUILD`,
the AUR variant, checksums; installs the `.deb` and starts it headless, installs the `.rpm` with
dnf in a Fedora container and with zypper in an openSUSE container and starts it headless there
with `tools/package/rpm-smoke.sh`, and runs `makepkg -si` on the `PKGBUILD` in an Arch Linux
container with `tools/package/arch-smoke.sh`) → `sign` (only job with
`id-token: write`) → `publish` (only job with `contents: write`; uploads to the draft by its tag
and checks that the draft is still on that tag after the notes edit) → `failure` (opens a
`release-failure` issue). `aur.yml`, on publish: `aur` (no GitHub token; the SSH key only) →
`failure`. `homebrew.yml`, from `main` when `macos-tap` starts it or by hand: `homebrew` (no GitHub
token; the tap's deploy key only) → `failure`. Locally, from a mach tarball:

```sh
tools/package/fetch-appimagetool.sh /tmp/ait
node tools/package/package.mjs --tarball engine/obj-x86_64-pc-linux-gnu/dist/vimma-*.tar.xz \
  --out dist --maintainer 'Name <email>' --appimagetool /tmp/ait/appimagetool \
  --runtime /tmp/ait/runtime-x86_64 --no-deb   # dpkg-deb only exists on Debian/Ubuntu
node tools/package/sbom.mjs --engine engine --out dist/vimma-$(node -p 'require("./surfer.json").brands.vimma.release.displayVersion').cdx.json
tools/package/arch-smoke.sh dist "$(node tools/release/version-line.mjs)"   # needs docker
tools/package/rpm-smoke.sh dist "$(node tools/release/version-line.mjs)"    # needs docker
```

`package.mjs` builds the `.rpm` with `rpmbuild` (on Arch, the `rpm-tools` package; on
Debian and Ubuntu, `rpm`); without it, pass `--no-rpm`. `rpmbuild` reads the binaries'
requirements as sonames, which Fedora and openSUSE both provide, and the spec it is given keeps
the libraries Vimma bundles out of them (spec [rpm-package](specs/rpm-package.md)).

`tools/package/arch-smoke.sh --stub` runs the same Arch Linux check on a stub tarball in about
half a minute; the `pkgbuild.yml` workflow runs it on every change to `tools/package/`, and its
`rpm` job runs `tools/package/rpm-smoke.sh --stub`, the Fedora and openSUSE check on a stub
`.rpm`, which needs `rpmbuild` on the host as well as docker. Its
`cask` job does the same for the Homebrew cask on a hosted Mac with
`tools/package/cask-check.sh --stub`: `brew style`, `brew audit --cask --strict`, then
`brew install --cask` of a stub `.dmg` and `brew uninstall --zap`. The install check refuses to
run outside GitHub Actions, because `--zap` deletes `~/Library/Application Support/Vimma`; on a
Mac, `tools/package/cask-check.sh <vimma.rb>` runs only the style and audit checks.

**The two `PKGBUILD`s.** `package.mjs` writes one `vimma-bin` PKGBUILD in two variants that
differ in one line, the install source it records in `/opt/vimma/is-packaged-app`:
`dist/PKGBUILD` (`vimma-package=pkgbuild-release`) is the release asset that Arch users
download with `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO
…/releases/latest/download/PKGBUILD && makepkg -si` (guide,
"Arch Linux"), and `dist/aur/PKGBUILD` (`vimma-package=aur`) is what goes to the AUR. `aur.yml`
runs after the build's artifacts may have expired, so it makes that variant again from the
published release's `PKGBUILD` by switching the one install-source line, and pushes it with the
release's `SRCINFO` (both variants share one); a test checks that the result equals
`dist/aur/PKGBUILD`. The desktop file and `vimma-open` are written inline in `package()`, so
neither needs another file.

**Enable it (one time):**

1. Hosted build: done ([#224](https://github.com/vimma-browser/vimma/issues/224), "Full builds"
   above); the `build` job runs on `ubuntu-24.04`.
2. Trigger: nothing to set. `release-please.yml`'s `release-build` job starts `release.yml`
   with `GITHUB_TOKEN`. The maintainer's publish, from a personal account, starts `aur.yml`.
3. Safe Browsing key: the `SAFEBROWSING_API_KEY` secret of the `build` environment ("Google
   Safe Browsing key" above);
   the `build` job fails without it, and its smoke check fails a build that lacks the key.
4. Maintainer line for the `.deb`, the `.rpm` (its `Packager`) and the PKGBUILD:
   `gh variable set PACKAGE_MAINTAINER --body 'Your Name <you@example.org>'` (public in every
   package; the `package` job fails without it).
5. Signing (recommended: keyless, no key to keep): `gh variable set SIGNING_ENABLED --body true`.
   Each signature records `vimma-browser/vimma`'s `release.yml` at `refs/heads/main` in the
   public Rekor log.
   Without the variable, `sign` is skipped and the assets go up unsigned.
6. AUR (optional; `aur.yml` is skipped with a notice until the secret exists). Arch users do
   not need it: the release's `PKGBUILD` installs Vimma without the AUR, and the `aur` job stays
   dormant until an AUR account and its key exist. The AUR does not accept new account
   registrations at the moment, so this step waits until it does; the setup below is for then:
   - Check the name is free: `curl -s 'https://aur.archlinux.org/rpc/v5/info?arg[]=vimma-bin'`
     must say `"resultcount":0` (and look at `vimma` too, which `vimma-bin` provides).
   - Create an account at <https://aur.archlinux.org/register>.
   - Make a key for the workflow only: `ssh-keygen -t ed25519 -N '' -C vimma-release -f aur_key`;
     paste `aur_key.pub` into My Account → SSH Public Key.
   - Store the key in the `aur` environment, which only `main` and `v*` tags may use, so no
     workflow on another branch can read it (the `aur` job names that environment):

     ```sh
     R=repos/vimma-browser/vimma
     gh api -X PUT $R/environments/aur --input - <<'JSON'
     { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
     JSON
     gh api -X POST $R/environments/aur/deployment-branch-policies -f name=main -f type=branch
     gh api -X POST $R/environments/aur/deployment-branch-policies -f name='v*' -f type=tag
     gh secret set AUR_SSH_KEY --env aur < aur_key
     ```

     Then delete `aur_key`. The first push creates `vimma-bin`; its maintainer is that account.
7. Homebrew tap (optional; `homebrew.yml` is skipped with a notice until the secret exists, and
   runs only while `MACOS_RELEASE_ENABLED` is `true`). Mac users can install the release's `.dmg`
   without it. `homebrew.yml` pushes the published release's `vimma.rb` to
   [vimma-browser/homebrew-tap](https://github.com/vimma-browser/homebrew-tap) as
   `Casks/vimma.rb`, so `brew install --cask vimma-browser/tap/vimma` finds it. The tap is set
   up; to recreate it, or to rotate its key:
   - The repository: `gh repo create vimma-browser/homebrew-tap --public --add-readme`. Homebrew
     maps `vimma-browser/tap` to this name.
   - A ruleset on `main`: no deletion, no force push, changes only by pull request. Deploy keys
     bypass it, so the workflow's key pushes directly; admins bypass it only through a pull
     request, so nobody else changes a cask unreviewed:

     ```sh
     gh api -X POST repos/vimma-browser/homebrew-tap/rulesets --input - <<'JSON'
     { "name": "main", "target": "branch", "enforcement": "active",
       "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
       "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" },
         { "type": "pull_request", "parameters": { "required_approving_review_count": 0,
           "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false,
           "require_last_push_approval": false, "required_review_thread_resolution": false } } ],
       "bypass_actors": [ { "actor_type": "DeployKey", "bypass_mode": "always" },
         { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" } ] }
     JSON
     ```

   - A key for the workflow only, with write access to the tap and nothing else:

     ```sh
     ssh-keygen -t ed25519 -N '' -C vimma-homebrew-tap -f tap_key
     gh repo deploy-key add tap_key.pub -R vimma-browser/homebrew-tap --allow-write \
       --title 'vimma release (homebrew.yml)'
     ```

   - The `homebrew` environment, which only `main` may use, holds the key (the `homebrew` job
     names that environment). No tag may deploy to it, by the rule in docs/security.md (B6): a
     tag ruleset restricts moving a tag, not creating one, so anyone with write access could tag
     an unmerged commit whose `homebrew.yml` skips every check and pushes any cask. For the same
     reason `homebrew.yml` has no `release` trigger, whose runs use the tag's copy of the file:

     ```sh
     R=repos/vimma-browser/vimma
     gh api -X PUT $R/environments/homebrew --input - <<'JSON'
     { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
     JSON
     gh api -X POST $R/environments/homebrew/deployment-branch-policies -f name=main -f type=branch
     gh secret set HOMEBREW_TAP_SSH_KEY --env homebrew < tap_key
     ```

     Then delete `tap_key`. To rotate: make a new key, add it as above, set the secret again,
     then remove the old key (`gh repo deploy-key list -R vimma-browser/homebrew-tap`, then
     `gh repo deploy-key delete <id> -R vimma-browser/homebrew-tap`). Each push is a commit
     `vimma X.Y.Z` by `PACKAGE_MAINTAINER`. Retry for a published release:
     `gh workflow run homebrew.yml -f tag=vX.Y.Z`.
8. Enable: `gh variable set RELEASE_ENABLED --body true` (disable: `gh variable delete
RELEASE_ENABLED`). Try it on the next release. For the macOS `.dmg` as well:
   `gh variable set MACOS_RELEASE_ENABLED --body true` ("macOS in a release", below).
9. Recommended: a tag ruleset (Settings → Rules → Rulesets → New tag ruleset, target
   `refs/tags/v*`, rules "Restrict updates" and "Restrict deletions", no bypass), so a release
   tag cannot be moved once release-please has created it. `release.yml` builds the commit the
   tag named when its build started and refuses to publish if the tag has moved since; the
   ruleset stops the move itself.

Release jobs cannot be started from a fork, and a manual run of `release.yml` does nothing
unless started from `main`, nor for a tag whose commit is not on `main`. It uploads only to a
draft: builds are not bit-for-bit reproducible, so new files under a published release would no
longer match the `PKGBUILD` the AUR has or a `SHA256SUMS` users saved. To replace a published
release's files anyway, run it with `-f replace_published=true`, then re-run `aur.yml` for that
tag (and `homebrew.yml`, when the macOS files were replaced). The release build uses its own fresh objdir (`engine/obj-release`) and an empty sccache
directory, so nothing left by a nightly or another job reaches signed binaries.

**Verify a release** (the user guide's "Installing" points here):

```sh
v=0.1.1
gh release download "v$v" -R vimma-browser/vimma
sha256sum -c SHA256SUMS              # every file OK
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/vimma-browser/vimma/\.github/workflows/release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS                         # "Verified OK"
```

A release with the macOS `.dmg` lists it and the Homebrew cask `vimma.rb` in
`SHA256SUMS-macos`, signed the same way: run the two checks again with `SHA256SUMS-macos` in place of `SHA256SUMS` (on a Mac,
`shasum -a 256 -c SHA256SUMS-macos`).

The identity accepts only this repository's `release.yml` run from `main`: `release.yml` starts
only by `workflow_dispatch` and refuses any other branch, and every signed release, `v0.1.1`
included, was signed so.
The issuer pins GitHub Actions' OIDC. Checking `SHA256SUMS`'s signature and then `sha256sum -c`
covers every file; each asset also has its own `<file>.sigstore.json`, verified the same way.
The regexp is `IDENTITY_REGEXP` in `tools/package/package.mjs`, and a test keeps the two equal.

**What the maintainer sees on a release** (from `0.1.2` on):

1. Merge the release PR `chore(main): release 0.1.2`. Within a minute, `release-please.yml`
   creates the tag `v0.1.2` and a draft release, `release-title` titles it
   `Vimma 0.1.2 · Firefox <version>`, and `release-build` shows "Started release.yml for v0.1.2"
   in its summary.
2. Actions → `release` has a new `workflow_dispatch` run on `main`, titled `release`. It takes
   a little over two hours (2 h 12 min for `v0.1.1`). The draft has no files until its `publish` job, near the end,
   uploads them all and edits the notes: an "Updating" section goes above the changelog and the
   third-party notice below it, each once (a re-run finds the heading). Both come from
   `tools/package/package.mjs` (`dist/notes/`). The update steps are there on every release,
   with or without macOS: the Mac update notice of 0.1.6 shows a Linux command and links to these
   notes, and the macOS jobs upload the `.dmg` after this edit.
3. When the run is green, the draft lists the tarball, AppImage, `.deb`, `.rpm`, SBOM, `PKGBUILD`,
   `SRCINFO`, `SHA256SUMS` and, with signing on, a `.sigstore.json` for each. Optionally check
   them as in "Verify a release" (above), with `gh release download v0.1.2` (it finds drafts).
4. Publish: Releases → the draft → Edit → "Publish release". Nothing is rebuilt; `aur.yml` runs
   for a minute and pushes `vimma-bin` (or logs a notice while `AUR_SSH_KEY` is unset).
   When the macOS files reach the published release, `release.yml`'s `macos-tap` job starts
   `homebrew.yml` on `main`. If they were already on the draft, start it by hand:
   `gh workflow run homebrew.yml -f tag=v0.1.2`.

Publish only after `release` is green: a draft published earlier is public without its files
until the build finishes, and `aur.yml` fails on the missing files (re-run it afterwards).

**If the build does not start** (no `release` run a few minutes after the draft appears): look
at the `release-please` run of the merge. `release-build` is skipped when `RELEASE_ENABLED` is
not `true` or no release was created, and fails if the dispatch is refused. Then start it by
hand, from `main`; it is the same call:

```sh
gh workflow run release.yml -R vimma-browser/vimma --ref main -f tag=v0.1.2
gh run list -R vimma-browser/vimma -w release.yml -L 1   # the new run
```

If the draft has lost its tag (`gh release view v0.1.2` does not find it, and the releases list
shows `untagged-…`), reattach it first, as in "Releases" above, so the upload finds it.

**When it fails:** a `release-failure` issue links the run, while the release is still a draft.
Fix on `main`, then re-run for the same tag. The tag is not deleted (plan §4 said so): release-please has already moved its
manifest and changelog past it, and the release notes stay valid. If the fix changes what is
built, release a patch version instead. A manual run, `gh workflow run release.yml -f tag=vX.Y.Z`,
runs the workflow file from `main` (the jobs refuse any other branch) but checks out and builds
the tag's source: a fix to the workflow file reaches the re-run, while a fix to the source or to a
script under `tools/` does not, and needs a patch release (leave the failed draft unpublished;
delete it once the patch release is out). An `aur.yml` failure also opens the issue; re-run it
with `gh workflow run aur.yml -f tag=vX.Y.Z`. That manual run uses `main`'s `aur.yml`, while the
run started by publishing uses the `aur.yml` at the release's tag, so a fix to `aur.yml` reaches
an already tagged release only through the manual run. A `homebrew.yml` failure opens it as
well; re-run it with `gh workflow run homebrew.yml -f tag=vX.Y.Z`, which, like every run of it,
uses `main`'s `homebrew.yml`. To pull a bad release: `gh release edit vX.Y.Z --draft`
(hides it); the AUR package cannot go back a version without an `epoch`, and `homebrew.yml`
never replaces a newer cask in the tap with an older one, so ship a fixed release instead.

### Flatpak (`flatpak.yml`, spec flatpak)

`tools/package/flatpak.mjs` writes the Flatpak manifest `dev.vimma.browser.json` and the four
files it names (launcher, desktop file, metainfo, icon); the manifest repackages a release
tarball on `org.freedesktop.Platform` 25.08. `tools/package/flatpak-smoke.sh` builds it with
flatpak-builder in a privileged Fedora container, installs it, and checks the version line,
the `vimma-package=flatpak` marker, the desktop file and the metainfo. Nothing is published:
Vimma is not on Flathub yet (issue #465).

- **Pull requests** that change `tools/package/`, the branding, `surfer.json` or the workflow
  run the `stub` job: a stub tarball, a few minutes, most of them downloading the runtime and
  SDK (about 870 MB).
- **A published release** runs the `release` job, which builds from the release's download URL
  pinned to the SHA-256 in its `SHA256SUMS` (signature checked with signing on), and also starts
  Vimma headless and takes a screenshot. It is not a release check: a failure leaves the
  release as it is, and only the run is red. Re-run with
  `gh workflow run flatpak.yml -f tag=vX.Y.Z`, which uses `main`'s workflow; the run a publish
  starts uses the tag's copy.
- **Locally:** `tools/package/flatpak-smoke.sh --stub`, or
  `tools/package/flatpak-smoke.sh --release vX.Y.Z <sha256> "<version line>"` with the
  tarball's line from the release's `SHA256SUMS`. Needs docker.
- **Pins:** the Fedora image digest and the runtime and SDK commits are at the top of
  `flatpak-smoke.sh`. Flathub prunes old commits in time; when `flatpak update --commit` cannot
  find one, take the current ones from
  `flatpak remote-info flathub runtime/org.freedesktop.Platform/x86_64/25.08` (and `…Sdk…`) and
  update the script in a pull request. A new runtime branch (26.08) changes `RUNTIME_VERSION` in
  `flatpak.mjs` and `RUNTIME` in the script together; a test keeps them equal.

**Submitting to Flathub** (issue #465; only once its other items are done, and only when the
maintainer decides to list Vimma):

1. Generate the files for the release to submit, with the tarball's SHA-256 from its
   `SHA256SUMS` and the release's date:
   `node tools/package/flatpak.mjs --out flathub --version X.Y.Z --date YYYY-MM-DD --sha256 <hex>`.
2. Build and lint them as Flathub does, on a machine with Flatpak:
   `flatpak install flathub org.flatpak.Builder`, then
   `flatpak run org.flatpak.Builder --force-clean --sandbox --user --install --install-deps-from=flathub --ccache --mirror-screenshots-url=https://dl.flathub.org/media/ --repo=repo builddir flathub/dev.vimma.browser.json`,
   `flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest flathub/dev.vimma.browser.json`
   and `flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo`. Fix every
   error in `flatpak.mjs`, not in the generated files.
3. Fork `flathub/flathub`, branch from its `new-pr` branch, add the generated files at the top
   level, and open a pull request against `new-pr` titled `Add dev.vimma.browser`. The
   description explains the D-Bus names outside the app id (`org.mozilla.vimma.*` for Firefox's
   remoting, `org.mpris.MediaPlayer2.firefox.*` for media keys) and the `~/.local/state/omarchy`
   read-only grant (the theme).
4. Answer the reviewers; `bot, build` in a comment starts a test build. Once merged, Flathub
   creates `flathub/dev.vimma.browser`, and you get write access to it.
5. Verify the app: on flathub.org, sign in, open the app's developer settings, choose
   "Verify" for `vimma.dev`, and publish the token Flathub gives at
   `https://vimma.dev/.well-known/org.flathub.VerifiedApps.txt` (the vimma-site repository).
6. Each later release: a pull request to `flathub/dev.vimma.browser` with the new tarball URL,
   SHA-256 and `<release>` line, generated as in step 1.

### Update signing keys and the update host (spec m6a-updater)

Vimma checks `https://updates.vimma.dev/updates/browser/<target>/<channel>/update.xml`
(`Linux_x86_64-gcc3`, or `Darwin_aarch64-gcc3` on Apple Silicon) every 12 hours and accepts only a manifest signed by a key pinned in
`packages/vimma-core/src/update-keys.mjs` (step 5; a build with no pinned key refuses every
manifest and shows nothing). These steps need the maintainer's accounts; do them once, in order.
All steps but 4 (the offline secondary key) are done. Step 7 sets up `update-publish.yml`, which
signs and publishes a manifest for every published release; nothing is published while the
repository variable `UPDATES_ENABLED` is not `true`. It is `true`, so update notices are on for
every install of 0.1.2 or later (0.1.1 pins no key and never shows one).

**1. The manifest repository** (decision 18): it holds only manifests.

```sh
gh repo create vimma-browser/vimma-updates --public \
  --description "Signed update manifests for Vimma, served at updates.vimma.dev"
git clone git@github.com:vimma-browser/vimma-updates.git && cd vimma-updates
mkdir -p public/updates
cat > wrangler.jsonc <<'JSON'
{
  "name": "vimma-updates",
  "compatibility_date": "2026-10-15",
  "workers_dev": false,
  "assets": { "directory": "./public" }
}
JSON
printf '/updates/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n' > public/_headers
printf 'User-agent: *\nDisallow: /\n' > public/robots.txt
git add -A && git commit -m "chore: static update host" && git push
```

In the repository's settings add a ruleset on `main`: block force pushes and deletion. Do not
require pull requests: the release workflow pushes manifests with a deploy key (sub-PR 4).

**2. The Worker and DNS.** Cloudflare dashboard → Workers & Pages → Create → Import a
repository → `vimma-browser/vimma-updates` (Workers Builds, deploy command `npx wrangler deploy`,
no build command). Then the Worker → Settings → Domains & Routes → Add → Custom domain →
`updates.vimma.dev`; the `vimma.dev` zone is on Cloudflare, so the DNS record and certificate
are created with it.

The Worker must stay connected to `vimma-browser/vimma-updates` through Workers Builds (the Worker's
settings list the repository and its `main` branch under Build). Workers Builds is
what deploys a manifest: `update-publish.yml` only pushes a commit to `vimma-updates`, and without
the Git connection that push changes nothing on `updates.vimma.dev`, so the run fails at its last
step, which waits until the new serial is served. To recover, connect the repository again, then
deploy the current `main` by hand from a checkout of `vimma-updates`, with an API token limited to
Workers ("Edit Cloudflare Workers" template), and re-run the failed job:

```sh
git pull && CLOUDFLARE_API_TOKEN=<workers-token> CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
```

Check:

```sh
curl -sI https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml  # 404 until a manifest exists
curl -s https://updates.vimma.dev/robots.txt                                             # served by the Worker
```

**3. The primary key in Google Cloud KMS, reached through GitHub OIDC** (decision 16). About
2.50 USD a month for an HSM RSA-4096 key version. A project ID is globally unique across Google
Cloud, so pick one of your own (for example `vimma-release-<name>`). KMS refuses requests until
the project is linked to a billing account (`gcloud billing accounts list` shows its ID).

The key's algorithm is `rsa-sign-raw-pkcs1-4096`: Cloud KMS offers no RSA-4096 PKCS#1 scheme with
SHA-384, and raw PKCS#1 lets the signer supply the SHA-384 DigestInfo itself, so the signature is
a standard RSASSA-PKCS1-v1_5 SHA-384 signature, the scheme the manifest and MAR verifiers expect.

```sh
PROJECT=vimma-release-<name> LOCATION=europe-north1 BILLING=<billing-account-id>
gcloud projects create "$PROJECT" && gcloud config set project "$PROJECT"
gcloud billing projects link "$PROJECT" --billing-account "$BILLING"
gcloud services enable cloudkms.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
gcloud kms keyrings create vimma-updates --location "$LOCATION"
gcloud kms keys create update-primary --keyring vimma-updates --location "$LOCATION" \
  --purpose asymmetric-signing --default-algorithm rsa-sign-raw-pkcs1-4096 \
  --protection-level hsm
gcloud kms keys versions get-public-key 1 --key update-primary --keyring vimma-updates \
  --location "$LOCATION" --output-file update-primary.pem

NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud iam workload-identity-pools create github --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc vimma --location global \
  --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.job_workflow_ref=assertion.job_workflow_ref' \
  --attribute-condition "assertion.repository == 'vimma-browser/vimma'"
read OWNER_ID REPO_ID < <(gh api repos/vimma-browser/vimma --jq '"\(.owner.id) \(.id)"')
SUBJECT="repo:vimma-browser@$OWNER_ID/vimma@$REPO_ID:environment:update-signing"
gcloud kms keys add-iam-policy-binding update-primary --keyring vimma-updates \
  --location "$LOCATION" --role roles/cloudkms.signerVerifier \
  --member "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/subject/$SUBJECT"
```

For this repository the member is
`principal://iam.googleapis.com/projects/<NUMBER>/locations/global/workloadIdentityPools/github/subject/repo:vimma-browser@342851495/vimma@1411511592:environment:update-signing`.

GitHub's OIDC token for this repository carries its subject (`sub`) in the immutable-ID form:
the owner and the repository are each followed by `@` and their numeric ID. IDs never change
and are never reused, unlike names, so a repository that later takes the name
`vimma-browser/vimma` (after a rename, transfer or deletion) cannot match this binding. The binding must name the subject exactly as the token carries it. A binding for the
name-only form (`repo:vimma-browser/vimma:environment:update-signing`) matches no token, and
signing fails with `PERMISSION_DENIED` on `cloudkms.cryptoKeyVersions.useToSign`. The IDs come
from `gh api repos/vimma-browser/vimma --jq '.owner.id, .id'` (owner first).

Only a job in the `update-signing` environment of `vimma-browser/vimma` gets that subject. Turn
on Data Access audit logs (Data read and Data write) for Cloud Key Management Service in IAM &
Admin → Audit Logs, so every signature is logged. In GitHub:

```sh
R=repos/vimma-browser/vimma
gh api -X PUT $R/environments/update-signing --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/update-signing/deployment-branch-policies -f name=main -f type=branch
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
  --body "projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/vimma"
gh variable set GCP_KMS_KEY_VERSION --body \
  "projects/$PROJECT/locations/$LOCATION/keyRings/vimma-updates/cryptoKeys/update-primary/cryptoKeyVersions/1"
```

No secret is stored: the key never leaves KMS. To revoke: `gcloud kms keys versions disable 1
--key update-primary --keyring vimma-updates --location "$LOCATION"`, or remove the IAM binding.

**4. The offline secondary (recovery) key** (decision 17). Not done yet: the primary is pinned
alone, and the secondary follows in a later release (step 5 says why). On a machine with
networking off (a live USB system), on removable media:

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out update-secondary.key.pem
openssl req -new -x509 -key update-secondary.key.pem -sha384 -days 36500 \
  -subj "/CN=Vimma update signing secondary" -outform DER -out secondary.der
openssl pkey -in update-secondary.key.pem -pubout -outform DER -out update-secondary.spki.der
sha256sum secondary.der update-secondary.spki.der
```

Keep `update-secondary.key.pem` on two encrypted USB sticks in separate safe places, and never on
a networked machine. Copy only `secondary.der` (the updater's certificate, sub-PR 2) and
`update-secondary.spki.der` off it. It signs only the one release that replaces a lost or leaked
primary (spec §6, "If the primary leaks").

**5. Pin the public keys** (an ordinary PR). For each SPKI DER:

```sh
openssl pkey -pubin -in update-primary.pem -outform DER -out update-primary.spki.der
for f in update-primary.spki.der update-secondary.spki.der; do
  echo "$f id=$(sha256sum "$f" | cut -c1-8) spki=$(base64 -w0 "$f")"
done
```

Add `{ id, slot: "primary" | "secondary", spki }` for each to `UPDATE_KEYS` in
`packages/vimma-core/src/update-keys.mjs`; `npm test` checks that each is an RSA-4096 key whose
id matches, and that the primary's SHA-256 is the one recorded here. Record each SHA-256 here
when it is pinned.

The primary is pinned on its own; the secondary is added in a later release. The secondary comes
from the offline ceremony in step 4, which does not have to wait for the first release: pinning
it is an ordinary release whose manifest the primary signs, so the primary alone can ship it.
Until it is pinned, a lost or leaked primary cannot be replaced through the update check, and
installs keep trusting it until they are updated by hand.

| Slot      | Key                                                                                | id         | SHA-256 of the SPKI DER                                            |
| --------- | ---------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ |
| primary   | Cloud KMS key ring `vimma-updates`, key `update-primary`, version 1, HSM, RSA-4096 | `fb4d33b6` | `fb4d33b6ea54ddb81a6a40ce50a61a6f9383b5850f27e2218045f5d3a07dab9a` |
| secondary | not pinned yet (step 4)                                                            | -          | -                                                                  |

**6. Check the chain end to end** before the pipeline exists: sign a manifest with KMS and serve
it. The raw PKCS#1 key signs exactly the bytes it is sent, so the SHA-384 DigestInfo is built
locally: the fixed DER prefix for SHA-384 followed by the 48-byte hash.

```sh
SERIAL=$(date -u +%Y%m%d%H%M%S)
printf '<?xml version="1.0"?>\n<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="%s">\n</updates>\n' \
  "$SERIAL" > update.xml
{ printf 'vimma-update-xml-v1\n'; cat update.xml; } > signed.bin
{ printf '\060\101\060\015\006\011\140\206\110\001\145\003\004\002\002\005\000\004\060'
  openssl dgst -sha384 -binary signed.bin; } > digestinfo.bin
gcloud kms asymmetric-sign --version 1 --key update-primary --keyring vimma-updates \
  --location "$LOCATION" --input-file digestinfo.bin --signature-file sig.bin
openssl dgst -sha384 -verify update-primary.pem -signature sig.bin signed.bin  # Verified OK
ID=$(sha256sum update-primary.spki.der | cut -c1-8)
printf '<!-- vimma-signature v1 key=%s sig=%s -->\n' "$ID" "$(base64 -w0 sig.bin)" >> update.xml
```

That manifest offers nothing. Committed under `public/updates/browser/Linux_x86_64-gcc3/vimma/`
in `vimma-updates`, a release build with the pinned primary shows "up to date" in about:vimma and
the manifest's serial and key; a byte changed in the file makes it "refused". Remove it again
until the release gate lifts: an accepted serial is remembered, so a later manifest must be newer.

**7. Publishing manifests** (`update-publish.yml`). When a release is published, the workflow's
`start` job starts the same workflow on `main` with the tag; the jobs that sign and push run
only there. `prepare` (no secret) checks that the release is published, not a pre-release and on
`main`, downloads its tarball, AppImage, `.deb` and `.rpm`, checks them against `SHA256SUMS` and
`SHA256SUMS` against release.yml's cosign signature (an unsigned release gets no manifest), and builds the manifest
with `tools/update/manifest.mjs`: Firefox's version and the build ID from the tarball's
`application.ini`, each file's size and SHA-512, the urgency, and a serial (the UTC time) that
must be newer than the one `updates.vimma.dev` and `vimma-updates` have. `sign` (environment
`update-signing`, `id-token: write` only, no repository code) checks the body's shape, signs it
with Cloud KMS and checks the signature with openssl. `publish` (environment `update-publish`)
downloads the files again, checks the signed file with the browser's own verifier and pinned
key and with openssl, then commits it to `vimma-updates` and pushes (never forced; one commit
per manifest, `vimma X.Y.Z: update manifest, serial S`), and waits up to 10 minutes until
`updates.vimma.dev` serves the new serial. A failure opens or comments on the
`release-failure` issue.

The macOS manifest (spec macos-homebrew, decisions 16 to 18) comes from the same workflow with
`-f target=macos`: `release.yml`'s `macos-tap` job starts it once the `.dmg` is on the published
release (and `start` does too, when the release already has a `.dmg`). Its `prepare` runs on a
macOS runner, checks the `.dmg` against `SHA256SUMS-macos` and that file's cosign signature, and
reads the build ID from the `.dmg`'s `application.ini`; `sign` and `publish` are the same jobs,
key and environments, writing `updates/browser/Darwin_aarch64-gcc3/vimma/update.xml`. A release
without a `.dmg` (`MACOS_RELEASE_ENABLED` off) gets no macOS run, and the Mac copy keeps the
previous offer.

The urgency is `security` when a commit since the previous published release is a Firefox bump
(`upstream: firefox …`) whose subject names advisories (they go into `vimmaAdvisories`) or whose
pull request has the `security` label (the autopilot puts it on a bump whose advisories it could
not read), a `fix(security)` commit, or any change whose pull request has the `security` label.
Installs then show the update in red (`⇡ X.Y.Z security: :update`).

One-time setup, in order (each step can be checked before the next):

```sh
R=repos/vimma-browser/vimma
# a. update-signing admits main alone: every signing job runs from main (the release's tag
#    only starts the run there), so a v* tag pushed on another commit cannot reach the key.
id=$(gh api $R/environments/update-signing/deployment-branch-policies \
  --jq '.branch_policies[] | select(.name == "v*") | .id')
[ -n "$id" ] && gh api -X DELETE $R/environments/update-signing/deployment-branch-policies/$id
gh api $R/environments/update-signing/deployment-branch-policies --jq '.branch_policies[].name'  # main

# b. In force: Google Cloud also checks that the token comes from update-publish.yml on main,
#    so no other workflow or branch can sign even with the environment. This replaces the
#    provider's whole condition: a later workflow that signs (for example MAR signing in
#    release.yml) needs its own job_workflow_ref added with ||. Keep the attribute mapping
#    from step 3, which maps attribute.job_workflow_ref next to attribute.repository.
gcloud iam workload-identity-pools providers update-oidc vimma --location global \
  --workload-identity-pool github --attribute-condition "assertion.repository == 'vimma-browser/vimma' && assertion.job_workflow_ref == 'vimma-browser/vimma/.github/workflows/update-publish.yml@refs/heads/main'"

# c. The update-publish environment, main alone, before any run uses it (a run would otherwise
#    create it with no branch rule).
gh api -X PUT $R/environments/update-publish --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api -X POST $R/environments/update-publish/deployment-branch-policies -f name=main -f type=branch

# d. A dry run: signs with KMS and runs every check, pushes nothing. The signature is real; the
#    signed file stays a day in the run's artifacts. Needs a published, signed release.
gh workflow run update-publish.yml -f tag=v0.1.2 -f dry_run=true
gh run watch "$(gh run list --workflow update-publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# e. The deploy key: write access to vimma-updates only.
ssh-keygen -t ed25519 -N '' -C update-publish -f updates_deploy
gh repo deploy-key add updates_deploy.pub --repo vimma-browser/vimma-updates \
  --allow-write --title "update-publish.yml (vimma-browser/vimma)"
gh secret set UPDATES_DEPLOY_KEY --env update-publish < updates_deploy
rm updates_deploy updates_deploy.pub

# f. Turn update notices on for every install (off: gh variable delete UPDATES_ENABLED).
gh variable set UPDATES_ENABLED --body true
```

Optional: a required reviewer on `update-signing` (Settings → Environments) makes every
signature wait for a person's approval. Without one, anyone with write access to the repository
can start a run on `main` that re-signs a published release or offers nothing; with a single
maintainer the approval adds a click to every release and nothing else. Approve within an hour:
the signing job refuses a serial older than that, and re-running the failed job reuses the old
body, so a late approval needs a new `gh workflow run`.

A deploy key, not a token: it can write to `vimma-updates` and nothing else, belongs to no
person's account and does not expire with one; a fine-grained token would act as the maintainer.
The `vimma-updates` ruleset (step 1) blocks force pushes and deletion, so the key can only add
commits. While `UPDATES_ENABLED` is not `true`, a run signs and verifies and then stops with a
notice, and a published release starts nothing at all (its `start` job logs a notice); with it
`true`, a missing `UPDATES_DEPLOY_KEY` fails the run and opens the `release-failure` issue. A
release published as a pre-release gets no manifest; promoting it to a full release starts the
workflow (the `released` event).

**What the maintainer sees on the next release** (with a–f done): publishing the draft starts
`aur.yml` and `update-publish.yml`; a second `update-publish` run on `main` follows within a
minute and finishes in about 5 minutes. Then `vimma-updates` has a commit `vimma X.Y.Z: update
manifest, serial …`, `curl -s https://updates.vimma.dev/updates/browser/Linux_x86_64-gcc3/vimma/update.xml`
shows it (and, a few minutes after `macos-tap`, the same under `Darwin_aarch64-gcc3`), and an
install of an older version (0.1.2 or later; earlier ones pin no key) shows
`⇡ X.Y.Z available` within 12 hours, or at once on `:update`; about:vimma shows the commands,
each with the file's SHA-512.

**Re-run, pull an update, and serials.**

- Re-publish a release's manifest (after a failure, or after `release.yml -f
replace_published=true` changed its files, whose hashes the old manifest no longer matches):
  `gh workflow run update-publish.yml -f tag=vX.Y.Z`, and `-f target=macos` for the Mac
  manifest. Every run gets a new, newer serial. The Linux manifest lists the `.rpm`, so a
  release from before the `.rpm` (0.1.6 and earlier) cannot be re-published from `main`; ship a
  new release instead.
- After two releases in quick succession, check `gh run list --workflow update-publish.yml`:
  GitHub keeps one waiting run per concurrency group (one per target), so a third run started meanwhile replaces
  the waiting one, which ends cancelled without a `release-failure` issue; start it again by hand.
- Pull a bad update (decision 22): `gh workflow run update-publish.yml -f offer=nothing`
  publishes a signed manifest that offers nothing; run it again with `-f target=macos` for Macs. Installs that have not taken the release stop
  offering it at their next check; then ship a fixed release, whose manifest offers it.
- Committing an older `update.xml` again does not undo a manifest: every install remembers the
  newest serial it accepted and refuses an older one (spec §4 rule 3), and the workflow refuses to
  sign a serial that is not newer than the published one. A serial more than a day ahead of a
  client's clock is refused by that client, so the runner's clock (the serial) must be right.
- The workflow also refuses to offer a version older than the one the published manifest offers;
  to go back to an older release, pull the update first (`offer=nothing`), then publish it.
- Turning `UPDATES_ENABLED` off stops new manifests but leaves the published one in place, and
  with it off no run pushes; to withdraw the offer too, run `-f offer=nothing` first, then
  delete the variable.

### vimma.dev's keys (`site-dispatch.yml`, spec site-keys-mirror)

`npm run gen-docs` writes `docs/bindings.json`, which vimma.dev mirrors on its keys page and in
its `?` overlay. A push to `main` that changes it sends a `repository_dispatch`
(`vimma-bindings`) to vimma-browser/vimma-site, whose workflow fetches the file at that commit and opens
a pull request. Publishing a release (not a pre-release) sends `vimma-release`, and the site's
`release-sync.yml` syncs the latest published release at once instead of at its daily run.
Until the secret exists the job skips with a notice. To set it up: create a
fine-grained token with access to vimma-browser/vimma-site only and "Contents: read and write", then
`gh secret set SITE_DISPATCH_TOKEN`. Re-send by hand with `gh workflow run site-dispatch.yml`
(`-f release=true` for a release).

### Security scanning (`semgrep.yml`, `codeql.yml`)

**Semgrep CE** runs on every PR, on pushes to `main` whose tree no pull request run scanned ("Once per tree" above) and on Mondays. It scans the repo with the public
registry rulesets `p/javascript`, `p/typescript`, `p/rust`, `p/secrets` and `p/github-actions`,
from the `semgrep/semgrep` image pinned by digest (bump the digest and the version comment
together). It does not log in to semgrep.dev and uploads nothing: `--metrics=off`, no token.
Skipped paths are in `.semgrepignore`: the engine checkout, build output, vendored code and the
generated copy of vimma-core. The job fails only on ERROR findings; WARNING and INFO findings are
listed in the step summary. Fix a finding, or suppress it on its line with
`// nosemgrep: <rule-id> -- <reason>`. A suppression without a reason is not allowed.

Reading the results: the run's **Summary** lists every finding as `SEVERITY path:line rule`. For
the details, download the `semgrep-sarif` artifact (kept for 30 days) with
`gh run download <run-id> -n semgrep-sarif`. Then open `semgrep.sarif` in VS Code's SARIF Viewer,
or list it with
`jq -r '.runs[].results[] | "\(.level) \(.locations[0].physicalLocation.artifactLocation.uri):\(.locations[0].physicalLocation.region.startLine) \(.ruleId)"' semgrep.sarif`.
Locally:
`docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -w /src <image> semgrep scan --metrics=off --config=p/javascript ... --json-output=semgrep.json`,
using the image and flags from `semgrep.yml`.

Licences: the engine is LGPL-2.1. It runs as a separate tool and is not linked into or shipped
with Vimma. The registry rules are under the Semgrep Rules License v1.0, which allows use for
internal purposes but not redistributing the rules or offering them as a service. We only run
them in our own CI.

**CodeQL** (`javascript-typescript` and `rust`, `build-mode: none`, `security-extended`, config in
`.github/codeql/codeql-config.yml`) is gated with `if: github.event.repository.private == false`,
so on a private repository (a private fork) the run shows it as skipped. This is for two
reasons. Code scanning on a private repo needs a paid GitHub Code Security licence. The CodeQL
CLI licence also allows CI analysis only of an open source codebase, and it names a private repo
as not one. This repository is public, so the job runs; its alerts appear under Security → Code
scanning.

### Licences

`npm run license-check` checks every package in `package-lock.json` against MIT, ISC,
BSD-2/3-Clause, Apache-2.0, MPL-2.0 and PSF-2.0 (also under its former id, Python-2.0). Reviewed exceptions live in
`tools/license-check/exceptions.json`, keyed by exact `name@version`, so an upgrade must be
re-reviewed; stale exceptions fail the check too.

`npm run license-check:crates` does the same for the Rust crates (`cargo metadata` on
`tools/vimma-ctl`, legacy `MIT/Apache-2.0` read as OR, dev-dependencies included); reviewed
exceptions live in `tools/license-check/cargo-exceptions.json`. vimma-ctl's binary has no
dependencies; its only dev-dependency is proptest (spec m7-fuzzing), whose tree brings the three
exceptions there (unicode-ident's Unicode-3.0 tables, and two WASI-only crates whose
`… WITH LLVM-exception OR … OR MIT` the checker cannot parse).

## vimma-ctl (control socket client)

Spec m0-control-protocol-and-vimma-ctl, ADR-007, ADR-011. A std-only Rust binary in
`tools/vimma-ctl/`; the toolchain is pinned in its `rust-toolchain.toml` (rustup honours it; a
system Rust of the same version works too).

```sh
cd tools/vimma-ctl
cargo test                                    # unit (fixtures) + integration (fake server)
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo build --release --locked                # → target/release/vimma-ctl, one file
install -Dm755 target/release/vimma-ctl ~/.local/bin/vimma-ctl
```

The control socket is **off by default**. Turn it on in `about:config`: `vimma.control.enabled`
= `true` (with it off nothing listens, and `vimma-ctl` exits 3). The browser
writes `<profile>/vimma-control.json` (port, token, pid; mode 0600) while it runs.

```sh
vimma-ctl state                     # mode, pending keys, workspace, tabs (* = selected)
vimma-ctl state --json | jq .tabs   # the raw result; unknown fields pass through
vimma-ctl send-keys ctrl+b c        # chords in Vimma's key notation, space-separated
vimma-ctl open https://example.com  # new tab; prints its id
vimma-ctl --profile /tmp/p --timeout 2 state   # --timeout: seconds, at most 3600
```

Profile: `--profile DIR`, else `VIMMA_PROFILE`, else the default in
`~/.config/vimma/vimma/profiles.ini` (`$XDG_CONFIG_HOME` honoured; legacy `~/.vimma/vimma` if
present): the `[Install…]` section's `Default`, else the `[Profile…]` with `Default=1`.

| Exit | Meaning                                             | Typical fix                                                               |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | server answered with an error (`code: msg`)         | fix the arguments (e.g. `invalid-args` for a `javascript:` URL)           |
| 2    | usage                                               | `vimma-ctl --help`                                                        |
| 3    | not reachable: no profile/file, stale, unsafe, busy | start Vimma, set the pref, `chmod 600` the file, `--profile`; busy: retry |
| 4    | token or protocol refused                           | the file is from another run; restart Vimma                               |
| 5    | malformed reply or timeout                          | a server bug; `--timeout` for a busy browser                              |
