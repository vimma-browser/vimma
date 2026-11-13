# Spec: m0-e2e-harness

Status: implemented; `m0-happy-path` runs in CI since the control server (PR #38) ·
Milestone: M0 · Area: `tools/e2e/`, `tests/e2e/`, `.github/workflows/e2e.yml`
Prerequisites: ADR-007 (control socket), ADR-010 (artifact builds), ADR-011 (vimma-ctl),
spec m0-control-protocol-and-vimma-ctl (protocol v1).

## User story

As the maintainer, `npm run e2e` starts a real Vimma build in a throwaway profile under Xvfb,
drives it through the control socket with `vimma-ctl`, asserts on `state` JSON and on
screenshots against committed baselines, and tells me in under 5 minutes what passed, what
failed and what is still pending. Plan §5: one happy path per milestone and one regression test
per bug, the issue number in its name.

## Scope

This spec is the **driver half**. The browser-side control server (`ctl/VimmaControl.sys.mjs`)
is the next spec; until it lands nothing listens, so real scenarios are marked pending.

1. `tools/e2e/`: launcher, driver, scenario format and runner, screenshot capture and diff
   (layout below). Node, no new dependency.
2. Vitest against a **fake control server** speaking protocol v1 (built on vimma-core's
   `validateMessage`, so it answers in the fixtures' shapes) and a **fake browser** (a Node
   script the launcher starts like the real binary).
3. One real scenario, `tests/e2e/scenarios/m0-happy-path.json`, pending with its reason.
4. `e2e.yml`: build `vimma-ctl` and run the harness tests (Xvfb present, binary required);
   the real-build run is wired after the mochitests and reports the pending scenario as a notice.

## Architecture

```
npm run e2e ─► tools/e2e/e2e.mjs (CLI: flags, signals, exit code)
                 └─ runner.mjs   budget 5 min, per-scenario timeout, report
                      └─ per scenario, a fresh Session (launcher.mjs):
                           findBuild ─► Xvfb (when DISPLAY is unset or --xvfb)
                           ─► temp profile (user.js) ─► spawn the browser in its own process
                           group ─► wait for <profile>/vimma-control.json (0600, valid v1)
                           ─► Ctl.ready() (driver.mjs) ─► steps (scenario.mjs)
                           ─► teardown: kill the group, stop Xvfb, rm the profile
```

| File                       | Job                                                                        |
| -------------------------- | -------------------------------------------------------------------------- |
| `tools/e2e/launcher.mjs`   | find the build, write the profile, start Xvfb, spawn, discovery wait, kill |
| `tools/e2e/driver.mjs`     | run `vimma-ctl`, parse JSON, classify failures; retries only in `ready()`  |
| `tools/e2e/scenario.mjs`   | load and validate scenarios, state matching, step execution                |
| `tools/e2e/runner.mjs`     | run scenarios with timeouts and the budget, format the report, exit code   |
| `tools/e2e/png.mjs`        | minimal PNG decode (8-bit, all filters) and encode, `node:zlib` only       |
| `tools/e2e/xwd.mjs`        | decode the XWD file Xvfb keeps its framebuffer in (`-fbdir`)               |
| `tools/e2e/screenshot.mjs` | capture from Xvfb, compare with a baseline (0.5 %), write diff images      |
| `tools/e2e/e2e.mjs`        | the CLI                                                                    |

### Launcher

- **Build**, in order: `--build <binary or dist/bin dir>`; `--artifact`
  (`engine/obj-artifact/dist/bin/vimma`, with `XUL_APP_FILE=…/dist/bin/browser/application.ini`
  exactly as `tools/mochitest.mjs --artifact` sets it, ADR-010); `--tarball <vimma-*.tar.xz>`
  (unpacked into a temp dir, removed at exit); `VIMMA_E2E_BUILD`; else the full objdir
  `engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma`, else the artifact objdir. The error lists
  every path tried.
- **Profile**: `mkdtemp` (0700), `user.js` with `vimma.control.enabled=true`, first-run,
  default-browser, welcome and session-restore suppression, telemetry, Normandy, Safe Browsing,
  remote settings and other background network off (taken from the engine's
  `remote/shared/RecommendedPreferences.sys.mjs`, the set Marionette applies), reduced motion and
  software WebRender for stable pixels. The list is `PROFILE_PREFS` in `launcher.mjs`.
- **Window**: `-width 1280 -height 800 -left 0 -top 0` (handled by `BrowserContentHandler`
  `getFeatures`); Xvfb's screen is the same size, so the window fills it with no window manager.
- **Xvfb**: started directly (not `xvfb-run`), `Xvfb -displayfd 3 -screen 0 1280x800x24 -fbdir
<tmp> -br -nolisten tcp -noreset`: `-displayfd` picks a free display and tells us which, so
  parallel runs cannot collide; `-fbdir` is the capture path (below). Used when `DISPLAY` is
  unset or with `--xvfb`; the browser then gets `DISPLAY=:N`, `GDK_BACKEND=x11`,
  `MOZ_ENABLE_WAYLAND=0` and no `WAYLAND_DISPLAY`, so a Wayland desktop cannot steal it.
  Package: `xvfb` on Ubuntu 24.04 (preinstalled on GitHub's `ubuntu-24.04` image),
  `xorg-server-xvfb` on Arch, `xorg-x11-server-Xvfb` on Fedora. Missing → a clear error naming
  them.
- **Discovery wait**: poll `<profile>/vimma-control.json` (default 30 s); it must parse, pass
  `validateMessage(…, { kind: "discovery" })` and have mode 0600. If the browser exits first the
  wait fails at once with the exit code and the last lines of its stderr; on timeout the message
  names the pref and the file. Either failure prints the browser's last 200 stderr lines, each
  with its time since spawn, so a stalled startup phase shows as a gap (issue #901); a launch
  that succeeds prints nothing extra. Before the scenarios, the CI job times the hostname
  lookups that Firefox's profile lock makes (`getent hosts "$(hostname)"`), because a slow
  resolver is the main suspect for the one stall seen in CI.
- **Cleanup**: teardown first quits like a user, `send-keys ctrl+q` (the profile sets
  `browser.warnOnQuitShortcut=false`; an open help overlay swallows ctrl+q, so `esc` closes it
  first), so quit observers remove the discovery file; a clean quit that leaves the file fails
  the scenario. Then, or when ctrl+q does not end it within 10 s, or after a timeout: the
  browser is spawned `detached` (its own process group), so teardown sends
  SIGTERM to the whole group (content processes included), then SIGKILL after 5 s. Xvfb the
  same. The profile is removed unless `--keep` (then its path is printed). The CLI runs teardown
  on SIGINT/SIGTERM and on any failure, including a failed launch.

### Driver

`Ctl` runs `vimma-ctl --profile P --timeout T <command>` (path: `--vimma-ctl`, `VIMMA_CTL`, else
`tools/vimma-ctl/target/{release,debug}/vimma-ctl`; build it with `cargo build --locked`), so
the shipped client is what the tests use. `state()` uses `state --json` and returns the parsed
object; `sendKeys(keys)` and `open(url)` (returns the tab id). Failures are a `CtlError` with a
`kind` from the exit code (spec m0-control-protocol: 1 `server` with the protocol error `code`,
2 `usage`, 3 `not-running` or `busy`, 4 `auth`, 5 `protocol`).

**Retries only for connection setup**: `ready()` retries `state` while the result is
`not-running` or `busy`, until its deadline. Every other call runs once; a failed command or a
mismatched assertion is never retried (plan §5: no retries; flaky means quarantine).

### Scenario format

One JSON file per scenario in `tests/e2e/scenarios/`, file name = `name`:

```json
{
  "name": "m0-happy-path",
  "description": "…",
  "pending": "optional: why it cannot run yet",
  "timeoutSeconds": 60,
  "steps": [
    { "wait-for-state": { "mode": "insert" }, "timeoutSeconds": 10 },
    { "open": "about:blank" },
    { "keys": "ctrl+b ?" },
    { "assert-state": { "mode": "help" } },
    { "screenshot": "m0-happy-path-help" }
  ]
}
```

- **Names**: `m<N>-<slug>` for a milestone happy path, `issue-<N>-<slug>` for a regression test,
  which must also carry `"issue": N` (the same number). Anything else is rejected at load time.
- **Steps**: exactly one of `open` (URL), `keys` (Herdr chords, as `vimma-ctl send-keys`),
  `wait-for-state` (poll `state` every 100 ms until it matches; `timeoutSeconds`, default 10),
  `assert-state` (one `state`, must match now), `screenshot` (baseline name, `[a-z0-9-]+`),
  `restart` (`"quit"`: `ctrl+q`, the discovery file must be gone, then the same build starts
  again on the same profile and display, without the `about:blank` argument, which would open
  beside the restored session; m3-workspaces sub-spec 7), or `"kill"`: once SessionStore's
  recovery file has been unchanged for 3 s, SIGKILL to the browser pid the harness started (any
  of its process group left after 5 s too), then the same start; the stale discovery file is
  skipped by its `pid` (`m3-crash-restore`). Later specs added the `hold`, `sleep`, `agent`,
  `agent-result`, `ctl`, `ctl-result`, `mcp` and `mcp-result` steps (`STEP_KINDS` in
  `scenario.mjs`). (Since changed: `wait-for-profile-file` polls until a file the browser
  writes into its profile exists, with `timeoutSeconds` like `wait-for-state`. It waits for a
  browser service that `state` does not report: `m3-private-workspace` waits for
  `search.json.mozlz4`, which Firefox's SearchSettings writes once SearchService has
  initialized, so the private window's URL bar names the default engine (#236).) (Since
  changed: `type` types a text into the focused input, one `send-keys` chord per character, a
  space as `space`, at most 256 chords per call; a `fixture:<name>` in it, ending at a space or
  `]`, becomes the fixture server's URL first. The agent CLI's e2e scenario
  (`m0-agent-cli`, docs/specs/builtin-agent-cli.md) types its task with it, because a task names
  the fixture page at an address that is known only once the server runs.)
- **Prefs**: an optional `"prefs": { "name": value }` overrides the profile's `user.js`;
  `null` leaves the pref out so the build's default applies (`m3-restart-restore` drops
  `browser.startup.page = 0` to run on Vimma's 3, resume the session). (Since changed: a
  string value `checkout:<relative path>` is that path in the checkout, made absolute, so a
  scenario can name a fixture folder, as `m0-agent-cli` names the Omarchy theme in
  `tests/e2e/fixtures/omarchy-theme`, without knowing where the checkout is. The harness also
  sets `vimma.agent.cli.vimmaCtl` to the vimma-ctl it found, because a build in a checkout has
  none beside its binary for the agent CLI to start; a scenario's own value wins.)
- **Programs** (since changed): an optional `"programs": { "claude": "tests/browser/fake.py" }`
  copies each file in the checkout into a 0700 folder in the profile under its name, 0700 too,
  and the browser's `PATH` becomes that folder, then `/usr/bin` and `/bin` only. The agent CLI's
  setup lists the CLIs it finds on `PATH`, so a CLI the caller has installed would show up too
  and change the screenshot; it also runs only a CLI that other users cannot write (C4). The
  name is one file name; the path is relative, without `..`.
- **Fixtures**: `open "fixture:<name>#<fragment>"` keeps the fragment for the page to read
  (`cookie.html#work` sets the cookie `ws=work`); the server never sees it.
- **Matching** is a subset match: every key in the expected object must match (recursively);
  extra keys in `state` are ignored (protocol v1 lets the server add fields). Arrays must have
  the same length and match element by element. `null` matches only `null`.
- **Pending**: a non-empty `pending` string. The runner reports it as `PENDING (reason)`, never as
  passed, and does not launch the browser for it; `--run-pending` runs it anyway (to watch it
  fail while writing the server).

### Runner

Scenarios run one after another, each in a fresh session. Per-scenario timeout (the scenario's
`timeoutSeconds`, default 60 s, capped by what is left of the budget) and a **total budget of
5 minutes** (`--budget`): a scenario that would start after the budget is spent is reported
`SKIPPED (budget)` and fails the run. The report lists each scenario with its status
(`PASS`, `FAIL`, `TIMEOUT`, `PENDING`, `SKIPPED`), its time and the failing step. Exit 0 when
nothing failed (pending ones do not fail the run, but are counted and, on GitHub Actions,
emitted as `::notice::` and written to the step summary), 1 otherwise, 2 for usage errors.

## Screenshot strategy

- **Capture now: Xvfb's `-fbdir` framebuffer file**, which Xvfb keeps as an XWD image
  (`<fbdir>/Xvfb_screen0`) and updates as it draws. `xwd.mjs` decodes it (header big-endian per
  the XWD format, pixels per its `byte_order` and colour masks) and `png.mjs` encodes a PNG. No
  ImageMagick (`import -window root` would work, but GitHub's ubuntu-24.04 image does not ship
  ImageMagick and an `apt-get install` costs minutes), no `xwd` binary. `--screenshot` of the
  browser is unsuitable: it starts its own headless instance and cannot see a running window.
  Before capturing, the harness waits until two frames 200 ms apart are identical (at most
  2 s), so a half-painted frame is not compared. Screenshots need the harness's own Xvfb: with an
  existing `DISPLAY` and no `--xvfb`, a `screenshot` step fails with that advice (it never grabs
  a desktop).
- **Later: the protocol's `screenshot` command** (reserved in v1, `not-implemented`) replaces
  the capture behind the same `capture()` function once the server implements it; baselines
  then need regenerating only if what is captured changes (window vs screen).
- **Comparison**: a pixel differs when any RGBA channel differs by more than 2 (absorbs
  rounding); the run fails when more than **0.5 %** of pixels differ (`diffPixels / (w × h) ≤
0.005` passes). Different sizes fail. On failure the actual image and a diff image (differing
  pixels red over a dimmed copy) go to `e2e-output/` (git-ignored).
- **Baselines** live in `tests/e2e/baselines/<name>.png`. A missing baseline fails (never
  created silently). `--update-baselines` (explicit, never default, refused when `CI` is set)
  writes them; per [CONTRIBUTING.md](../../CONTRIBUTING.md) every baseline change needs a
  changelog line, i.e. a commit whose subject says which baseline changed and why.
- **Dependencies**: none. pixelmatch (ISC, small) was considered; a byte-wise diff with a
  tolerance is ~30 lines, and PNG handling is `node:zlib` plus a CRC table, so there is nothing
  to licence-check or keep updated.

### LFS: not now

Baselines are committed as plain git blobs, marked `binary` in `.gitattributes`. The repo is 6 MB; a
1280×800 browser screenshot PNG is ~50–150 kB, and the plan's rate (one happy path per milestone
plus regressions) adds well under 5 MB a year. Git LFS on the free private plan has a 1 GiB storage
and 1 GiB/month bandwidth quota, and every CI checkout with `lfs: true` spends bandwidth on all
baselines, which would cost more than it saves at this size. Revisit when `tests/e2e/baselines/`
passes 25 MB or a single baseline passes 1 MB (then `git lfs migrate import
--include="tests/e2e/baselines/*.png"`).

## CI integration (`e2e.yml`)

- The mochitest job (which has no paths filter; a docs-only PR skips it) first builds `vimma-ctl`
  (`rustup toolchain install`, `cargo build --locked`) and runs `npx vitest run tools/e2e/` with
  `E2E_REQUIRE_CTL=1` and `E2E_REQUIRE_XVFB=1`, so the driver tests and the real Xvfb capture test
  cannot skip there. This runs before the Firefox download, so a harness bug fails in about a
  minute. The same tests run in `ci.yml` through `npm run coverage`; there the binary and Xvfb may
  be missing and those tests are skipped with the reason in their name.
- After the mochitests: `npm run e2e -- --artifact` on the artifact build. While every scenario
  is pending it launches nothing and prints a `::notice::` naming the pending scenarios and the
  reason; it is not a pass. When the server spec lands, it removes `pending` and this step runs
  the scenarios for real. On failure the job uploads `e2e-output/` (7 days).
- `permissions: contents: read`, no secrets, actions pinned to SHAs (unchanged).

## Tests (written first)

`tools/e2e/test/*.test.mjs` (Vitest; fake server in `test/fake-server.mjs`, fake browser in
`test/fixtures/fake-browser.mjs`):

- launcher: build resolution order and errors; profile prefs; launch args and env (artifact
  `XUL_APP_FILE`, Xvfb env); discovery wait succeeds when the file appears late, rejects a
  0644 file and an invalid one until fixed, times out with the pref named, fails fast when the
  browser exits; teardown kills the whole process group (a grandchild too) and removes the
  profile, keeps it with `keep`; cleanup also runs when the launch fails.
- driver: `state`/`send-keys`/`open` through the real `vimma-ctl` against the fake server;
  `busy` is retried by `ready()` until free; `unauthorized` fails at once (exit 4, `auth`);
  server gone between calls → `not-running`, not retried; a dropped connection → `protocol`;
  a server error keeps its code (`invalid-args`); commands are never retried.
- scenario: name rules (milestone, `issue-N` with matching `issue`), step validation, subset
  matching, `wait-for-state` timeout message.
- runner: pass, fail (with the step), timeout, pending (not launched, not passed), budget
  exhaustion, teardown on every path, exit codes and report text.
- images: PNG round trip; decoding a real ImageMagick PNG (all filter types) and XWD fixture;
  synthetic XWD in both byte orders; tolerance maths (exactly 0.5 % passes, one more pixel
  fails, channel tolerance, size mismatch); baseline missing / update / compare.
- Xvfb: a real `Xvfb` capture is 1280×800 and black with `-br` (skipped without Xvfb unless
  `E2E_REQUIRE_XVFB=1`).

## What the server spec must provide for `m0-happy-path` to run

1. With `vimma.control.enabled=true` in `user.js`, the server starts at startup (before or soon
   after the first window; the harness waits 30 s) and writes `<profile>/vimma-control.json`,
   0600, valid per the discovery fixture.
2. `state` returns `mode: "insert"` for the M0 base mode with no overlay (spec m0-help-overlay)
   and `"help"` while the overlay is open; `tabs` with `url` and `selected`.
3. `open {url: "about:blank"}` opens and selects a new tab.
4. `send-keys "ctrl+b ?"` goes through the dispatcher like real keydowns, so the overlay opens
   (the bare-prefix path, ADR-009).
5. The server deletes the discovery file at shutdown. SIGTERM does not run quit observers
   (control server report), so the harness quits with ctrl+q and keeps signals as the fallback.
6. Startup shows exactly one tab, `about:blank` (`browser.startup.page=0` in the profile), so
   after `open` the state has two tabs, the new one selected. If Vimma's startup differs, change
   the scenario's `tabs` expectation in the server PR and say why.
7. Then: remove `pending` from the scenario and create the baseline once on Linux, check it by
   eye, and commit it with a changelog line:

   ```sh
   npm run e2e -- --xvfb --update-baselines --filter m0-happy-path
   ```

   Baselines made locally may differ from the runner's fonts: if CI's diff exceeds 0.5 %, take the baseline from CI's `e2e-output/`.

8. Replace `capture()` with the protocol's `screenshot` command when it is implemented.

## Out of scope

The server; macOS/Windows; parallel scenarios; performance timers (plan §5 Performance row).

## Implementation log (2026-10-09)

- TDD red: all six test files failed with "Cannot find module '../png.mjs'" (and
  `../driver.mjs`, `../launcher.mjs`, `../runner.mjs`, `../scenario.mjs`); green: 92 passed,
  1 skipped (the Xvfb capture test: no Xvfb on the dev box; CI requires it).
- Manual check with the real full build (`--build …/dist/bin/vimma --run-pending`, headless,
  temp profile): the browser starts with the profile, no control socket appears (no server yet),
  the run fails after `--discovery-timeout` with the pref named and the browser's stderr, and no
  process or profile is left. **Bug found:** SIGINT while the launch was still waiting for the
  discovery file left the browser running, because teardown was registered only after the
  launch returned. Red: a new launcher test ("hands out teardown before waiting") failed with
  `expected [] to have a length of 1`; fix: `launch({ onTeardown })` hands out an idempotent
  teardown before anything slow starts; green: 93 passed, 1 skipped. Re-checked by hand: SIGINT
  mid-launch → exit 130, browser process group gone, profile removed.
- Checked on GitHub's runner-images readme (ubuntu-24.04): `xvfb` is installed, ImageMagick
  and x11-apps (`xwd`) are not; rustup is. Hence capture through `-fbdir`, no apt step.
- No new dependency: `npm run license-check` and `license-check:crates` unchanged.

## Hardening

Supersedes the sections above where they differ.

- **Cancellation while Xvfb starts.** A SIGINT at 0.03 to 0.12 s left a live Xvfb or its
  fbdir: teardown ran while `startXvfb` was pending with `display = null`. Now `launch` keeps
  the pending start, teardown aborts it (`startXvfb({ signal })` kills Xvfb and removes the
  fbdir on abort and on every failure) and stops whatever it returns; `stop()` is idempotent.
  Tests: teardown during Xvfb startup, an abort signal during startup and during the discovery
  wait, and SIGINT to the CLI while a fake Xvfb starts (no Xvfb, fbdir or profile left).
- **Minimal browser env.** The browser's environment is built from an allowlist (`PATH`,
  `USER`, `LOGNAME`, `MOZ_HEADLESS`, `MOZ_LOG*`, plus `DISPLAY`, `WAYLAND_DISPLAY`,
  `XDG_RUNTIME_DIR`, `XAUTHORITY` only when using the caller's display), with `HOME` and
  `TMPDIR` inside the profile (`.e2e-home`, `.e2e-tmp`: no `~/.config` GTK or fontconfig
  settings, and temp files such as remote-settings bundles go with the profile), `LANG=C.UTF-8`,
  `TZ=UTC`, `GTK_THEME=Adwaita`; under Xvfb `GDK_BACKEND=x11` and `MOZ_ENABLE_WAYLAND=0`.
  `GDK_SCALE` (a 2× crop on the dev box), `GDK_DPI_SCALE`, `QT_*` and the rest never reach it.
  The profile pins `layout.css.devPixelsPerPx="1.0"`, `ui.systemUsesDarkTheme=0` and a light
  content colour scheme; Xvfb runs at `-dpi 96` with `-nocursor`. A fake browser's own variables
  now go through `build.env`, as an artifact build's `XUL_APP_FILE` does. (Since changed: a
  browser that does not get the caller's `XDG_RUNTIME_DIR`, under our Xvfb or headless, gets a
  private 0700 folder as one, made under the caller's `XDG_RUNTIME_DIR`, else `~/.cache`, and
  removed with the profile. The agent CLI's run folder (docs/specs/builtin-agent-cli.md, C6)
  lies in `XDG_RUNTIME_DIR`, else `~/.cache` under `HOME`, and refuses one with a folder above
  it that other users can write: the profile's `HOME` lies in the shared `/tmp`.) (Since changed:
  on Linux a scenario's browser renders with vendored fonts through its own fontconfig file and
  GTK settings, and the profile names the URL bar's engine from the start (issue #944); described
  in `tests/e2e/fonts/README.md` and the runbook's "Baselines".) (Since changed: the fixture pages
  are served on the fixed port 28471, and a run whose port is taken stops with exit 2 instead of
  taking another; a screenshot that differs no longer stops its scenario, which fails at its end;
  the baselines were re-recorded from CI (issue #953).)
- **`ready()` and a server still starting.** The first server build answers
  `failed: no browser window` until its first window exists (≈ 70 % of runs failed at 0.7 s).
  `ready()` retries that one message, within its deadline; any other `failed` and every
  command outside `ready()` still fail at once.
- **Hard timeouts.** The runner passes the scenario's AbortSignal to `startSession`; the CLI
  hands it to `launch` (cancels Xvfb and the browser) and to `Ctl` (`execFile({ signal })`
  SIGKILLs a running `vimma-ctl`; `ready()` stops). After a timeout the runner waits at most
  `settleMs` (10 s, and never past the budget) before moving on; a session that arrives later is
  torn down when it does. Tests use stubs that hang and ignore the abort.
- **CI artifacts.** `e2e.yml` uploads `e2e-output/` on failure (`actions/upload-artifact`,
  pinned, 7 days).
- **XWD guards.** Mask scans are bounded (32 iterations; `0xFFFFFFFF` used to loop forever);
  masks must be one run of at most 16 bits inside `bits_per_pixel` and must not overlap;
  `header_size` below 100, `byte_order` other than 0/1, a zero or > 16384 dimension and
  `bytes_per_line` < width × bytes per pixel are rejected. A fast-check property corrupts every
  header field (2000 runs): the decoder returns a well-formed image or throws an `Error`.
- **Output.** "Baselines rewritten" is printed only when a screenshot step wrote one, naming it.
- TDD: red, 13 failed in launcher/driver/runner, and the XWD file hung on the 0xFFFFFFFF mask
  (killed by `timeout`); green: 120 passed, 1 skipped (Xvfb, absent on the dev box).
- Manual check against the current local full build, which now has the control server: steps 1
  to 6 of `m0-happy-path` passed in 1.0 s (state, open, `ctrl+b ?`, mode `help`); the
  screenshot step failed as designed without the harness's Xvfb (none on the dev box). Nothing
  left behind.

### M0 finish (PR after #38)

- `pending` removed from `m0-happy-path`; its expectations already matched the server (checked
  by hand, headless artifact build: startup `insert` with one `about:blank` tab, two tabs after
  `open`, `help` after `ctrl+b ?`; ctrl+q in help changed nothing, `esc` then ctrl+q quit and
  removed `vimma-control.json`). The fake server already spoke hello→challenge→auth→welcome.
- Teardown quits with ctrl+q (`quitBrowser`, unit-tested with a fake ctl and child: plain,
  help open, no exit, dead socket, already exited) before the signals.
- A missing baseline now also writes `<name>.actual.png` to `e2e-output/`, so CI's first run
  supplies a baseline from CI's own environment (Xvfb, fonts); the first one was taken from it.
  `--update-baselines` stays refused when `CI` is set.
- **Real-sandbox check** (with `npm start`): local objdirs symlink chrome files into the repo's
  `src/`, which the default content sandbox may not read, so VimmaChild failed to load outside
  mochitests (which relax the sandbox). The harness profile now takes `devPrefs` from
  `tools/start.mjs` (the read-path whitelist) and keeps the default sandbox, and
  `m0-content-actor` opens `fixture:focus-later.html` from a 127.0.0.1 page server (a web
  content process), waits for `normal`, then for `insert` when the page focuses an input 2 s
  later; only the actor reports that. Red without the pref (headless artifact build: "expected
  insert, got normal"), green with it. Any scenario also fails if the browser's stderr has
  `Failed to load chrome://browser/content/vimma/…`. Chosen over a separate script: it reuses
  the launch, the socket and the CI step, and costs one ~3 s scenario.

## Re-recording the help-overlay baseline

`tests/e2e/baselines/m0-happy-path-help.png` once showed an old legend line that CI passed within
the 0.5 % tolerance; it has since been re-recorded with later overlay changes. A re-recording is not
trivial, because the baseline must come from CI's own image (fonts differ locally: a local run
differs by 18.6 % here), and `e2e.yml` uploads `e2e-output/` only when a step fails, while a
comparison within tolerance writes no actual image at all. To re-record: in a branch, make CI
produce the image (for example a one-off run with the baseline deleted, which fails as "missing" and
writes `m0-happy-path-help.actual.png`), take it with `gh run download <run-id> -n e2e-output`,
check it by eye and commit it with a changelog line in the body. (Since changed: with the fonts
pinned (issue #944) a local run of this scenario differs from CI's baseline by 0.23 % instead of
18.6 %; the baseline still comes from CI, because the rasteriser is the machine's FreeType.)
