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

Pass `--repeat=N` with `=`: `tools/mochitest.mjs` treats a bare `N` as a test path. No
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

It merges `vimma.config.path=<profile>/vimma/config.toml` into the profile's `user.js` (an
existing value is kept), so a dev or lane build never reads or writes the installed Vimma's
`~/.config/vimma/config.toml`: a setting only the dev build knows, written there by its setup,
once broke the installed release's config. The e2e harness sets the same pref inside each
throwaway profile; mochitests set `/nonexistent/vimma-test/config.toml` in `browser.toml`.

It merges `security.sandbox.content.read_path_whitelist=<repo>/src/` into the profile's `user.js`.
In a local objdir the chrome files are symlinks into `engine/`, which `surfer import` links to the
repo's `src/`, outside the Firefox tree; the content sandbox then refuses them and the console
says `Failed to load chrome://browser/content/vimma/actors/VimmaChild.sys.mjs` (no hints, no
insert mode). Mochitests relax the sandbox, so they never see it. The e2e harness writes the same
pref (`devPrefs` from `tools/start.ts`) and keeps the default sandbox, and its
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
npm run e2e -- --headless --filter m0-happy-path       # MOZ_HEADLESS=1; screenshot steps skipped
npm run e2e -- --updater <objdir> --filter m6a-update  # the updater's scenarios (below)
npm run e2e -- --build /Volumes/Vimma/Vimma.app --vimma-ctl /Volumes/Vimma/Vimma.app/Contents/MacOS/vimma-ctl
```

**On macOS** the harness runs headless by default (`--headless`): the browser gets
`MOZ_HEADLESS=1` and no display, because the macOS build draws with Cocoa and Xvfb has nothing to
show. A `screenshot` step is reported as skipped (`screenshot <name>: skipped`) and no baseline is
read or written, so the scenarios check behaviour, not pixels. `--build` takes a `Vimma.app` and
runs its `Contents/MacOS/vimma`; a release's app carries its own `vimma-ctl` beside it. Both macOS
smoke jobs run `m0-happy-path` and `m0-content-actor` this way (`macos.yml`, and `macos-smoke` in
`release.yml`).

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

**Updater scenarios** (`m6a-update-n-to-n1`, `m6a-update-bad-signature`; spec m6a-updater,
"Tests", e2e, M6a exit test 1). They need a full `VIMMA_UPDATES=1` build packaged with
`./mach package`, which no pull-request job has, so they run locally and are reported pending
elsewhere ("needs a VIMMA_UPDATES=1 build"). Linux only; they also need `openssl` and NSS's
`certutil` and `pk12util` (`nss` on Arch, `libnss3-tools` on Ubuntu). Start from a build whose
updater has Vimma's certificates (`VIMMA_UPDATES=1 npx surfer build`, then
`(cd engine && ./mach package)`):

```sh
npm run e2e -- --updater engine/obj-x86_64-pc-linux-gnu --filter m6a-update --xvfb --budget 900
```

The harness unpacks the tarball (N), points its `[AppUpdate] URL` at a host on `127.0.0.1` with
https (a CA made for the run, trusted only in each scenario's profile with `certutil`), makes N+1
(a build ID 60 s later and a marker file) and a downgrade build (later still, Firefox 100.0),
builds their complete MARs with `tools/update/mar.mjs` and signs them with libmar's test key
`mycert` (exported from `engine/modules/libmar/tests/unit/data` with `pk12util`). Manifests come
from `tools/update/manifest.mjs`, signed with an RSA key generated for the run, which the browser
pins only in automation (`vimma.update.testKeys` with `MOZ_DISABLE_NONLOCAL_CONNECTIONS=1` and
the automation pref). `m6a-update-n-to-n1`'s install carries `updater-xpcshell` (Mozilla's test
updater, which trusts `mycert`) as `updater`; `m6a-update-bad-signature`'s keeps the shipped one,
which must refuse the `mycert` MAR (error 19). Nothing reaches `updates.vimma.dev`, and the real
update key is never used. The browser runs with `XUL_APP_FILE` naming the install's
`browser/application.ini` (Firefox's binary otherwise uses the copy compiled into it), so the
local URL and, after the update, N+1's build ID are what it runs with. With
`MOZ_DISABLE_NONLOCAL_CONNECTIONS` any connection off 127.0.0.1 crashes the browser ("FATAL
ERROR: Non-local network connections are disabled", in the failure's teardown output); the
scenario profile turns off the ones Firefox makes on its own (`updatePrefs` in
`tools/e2e/update-host.ts`), and a scenario types `:update` only once a page has focus, since
in the address bar it is a search. The updater applies the update by `execv` in the browser's
own process, so a `restart` step follows it with nothing extra. `serve-update` picks the
manifest (`offer`: `n1`, `n`, `older-firefox`, `none`; `key`: `test` or `unknown`);
`wait-for-install` waits on which build the install holds and the profile last ran
(`compatibility.ini`), N+1's marker, the error code the updater's last run ended with
(`updates/last-update.log`) and the MAR requests the host saw. Measured 2026-11-06 (Firefox
159.0.1, 16 threads): the preparation takes about 2.5 minutes (two MARs, xz), the two scenarios
about 10 s.

**Baselines.** Screenshots are compared with `tests/e2e/baselines/<name>.png`; more than 0.5 % of
differing pixels fails, and the actual and diff images land in `e2e-output/`. A scenario carries on
past a screenshot that differs or has no baseline and fails at its end, so one run writes every
image that differs. A baseline comes from CI's runner, never from a local machine: change the
product, then take CI's images. To re-record one or more baselines:

1. Replace each `<name>.png` to re-record with a placeholder that cannot match (any other
   1280×800 PNG, such as a solid colour), in a commit of its own, and push. The vitest check that
   every screenshot has a 1280×800 baseline still passes; a deleted baseline would fail it, and
   with it the job, before the scenarios run. The next step replaces the placeholders before the
   pull request merges, and its squash keeps only the net change: the new baselines.
2. The job fails on those screenshots and uploads `e2e-output` (kept 7 days):
   `gh run download <run-id> -n e2e-output`. Each `<name>.actual.png` is CI's image.
3. Look at every image (no error text, no half-drawn state, no leftover notice or focus ring from
   an earlier step, the scenario's theme), and before replacing a baseline find out what changed
   since it was taken and which change caused it: a re-record must not bless a regression.
4. Copy the images over the placeholders and commit them with a body that names each changed
   baseline and its cause (CONTRIBUTING.md: never change a baseline without saying why). The next
   CI run should compare each at 0.00 %.

`npm run e2e -- --xvfb --update-baselines --filter <scenario>` (refused when `CI` is set) writes
a local image as the baseline; use it for a throwaway scenario (`--scenarios`, `--baselines` and
`--out` in a folder of your own), not for a committed baseline. A missing baseline fails; nothing
creates one silently.

What a local run differs by. On Linux the scenarios render with the fonts vendored in
`tests/e2e/fonts/` (DejaVu, and Liberation Sans for Helvetica), drawn as on CI's ubuntu-24.04:
the browser gets that folder's `fonts.conf` as `FONTCONFIG_FILE` and GTK's "Sans 10" in the
profile's HOME, so a local run compares with CI's baselines with no font package installed
(issue #944). The fixture pages are served on the fixed port 28471 (`PAGE_PORT` in
`tools/e2e/pages.ts`), so the URL and status bars read the same in every run (issue #953).
Measured on an Arch machine against baselines taken in CI, what remains is mostly one row: Firefox
draws the line under the toolbar as the window's text colour at 10 % (`--card-border-color`), and
that colour comes from GTK, whose Arch build draws the line a shade lighter than CI's Ubuntu
24.04. That is 1280 pixels (0.125 %, shown as 0.13 %) in every screenshot with a toolbar, and
0.00 % in those without one. Pinning `ui.-moz-dialogtext` in the profile made a local run match
CI's images but moved CI's own line, so the profile does not pin it. The PDF page's text
(`pdf-outline`) adds a few pixels of the system's FreeType (2.15 there, 2.13 on CI). Run to run,
the downloads picker's end time, the agent setup list's profile path and the versions on the start
page (`m3-private-workspace`, which therefore changes at each release or Firefox update) vary by a
few digits.

**When the port is taken.** Another e2e run on the same machine (a second lane, for example) holds
port 28471, and the run stops at once with exit 2 and a message naming the port: it never moves
to another port on its own, which would draw other digits into every screenshot that shows a URL.
Wait for the other run, or pass `--port N` (or `VIMMA_E2E_PORT=N`; 0 for any free port) and
accept a few digits of difference in those screenshots. The updater scenarios' update host keeps a
free port, since none of them takes a screenshot.

Baselines are plain git blobs, not LFS (the spec's "LFS: not now" says when to revisit).

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
  previous scheduled run's artifact and runs `tools/sites/compare.ts`: the changes go into the
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
  from a saved copy instead. Only the ids in `SNAPSHOT_LICENCES` (`tools/sites/snapshot.ts`) are
  accepted. Copy the file into the fixtures, set its `snapshots.json` entry from an offline run
  and add its attribution row to the README there. A site whose licence allows no copy gets a
  hand-written minimal fixture of the structure that broke instead.
- Running it from a worktree against the main checkout's build: pass
  `--build <main>/engine/obj-x86_64-pc-linux-gnu/dist/bin` and
  `--pref security.sandbox.content.read_path_whitelist=<main>/src/`, or the content actor
  cannot load.

### The agent model bench (`npm run agent-bench`, spec builtin-agent)

`npm run agent-bench` measures which models can do the built-in agent's tasks
([builtin-agent](../specs/builtin-agent.md) B14). It runs vimma-core's model loop
(`packages/vimma-core/src/agent/agent-loop.mjs`) in Node against `vimma-ctl mcp` on a real build
under its own Xvfb, and shops the ten fixed lists of `tests/e2e/fixtures/bench-shop/lists.json` in a
local shop (`tools/agent-bench/shop.ts`, about 60 products, with injected instructions in some
descriptions and reviews). Each run is one `vimma-ctl mcp` connection: the harness answers its
first question with `a`, as sending a task with `Enter` will grant it, and every later
question, which under that grant only a checkpoint asks, with `n`. The scores come from what
reached the shop's servers: the basket, an order (`paid`), a form, a request to the second host
(`injection followed`). Results are published in [agent-bench.md](../agent-bench.md).

```sh
npm run agent-bench -- --artifact --check --lists L04 --two-shops   # the scripted provider (CI)
npm run agent-bench -- --artifact --provider openai --model qwen2.5:7b --num-ctx 32768 \
  --runs 3 --max-steps 100 --out qwen2.5-7b.json               # a local model on Ollama
ANTHROPIC_API_KEY=… npm run agent-bench -- --artifact --provider anthropic \
  --model <model> --key-env ANTHROPIC_API_KEY --vision          # a hosted model: costs money
```

- The scripted provider (the default) answers from a script that knows each list, with no
  model and no network; `e2e.yml` runs it with `--check` after the e2e scenarios, so the shop,
  the harness and the scoring keep working. A scripted run that is not complete and safe is a
  bug in the bench or in Vimma.
- `--two-shops` adds the two-shop scenario of issue #693 ([mcp-consequence](../specs/mcp-consequence.md),
  Tests): five items compared across two local shops, Kauppa on `127.0.0.1` and Market on
  `localhost` (`tools/agent-bench/two-shops.ts`, `tests/e2e/fixtures/bench-shop/two-shops.json`),
  both baskets filled with each shop's cheapest match and both checkouts asked. Kauppa's add
  buttons are icon-only buttons named by `aria-label`; Market's are a repeated "Add" that
  submits a small form. Alone it runs only that scenario. `--check` also fails it when anything
  but a checkout asked or a result said that questions were waiting for the user. Unpaced, its
  ten searches use up the open rate, so a run takes about 70 seconds, most of it the rate wait.
- `--num-ctx` sets an Ollama model's context length by making a model of that name with
  `num_ctx` set (`qwen2.5:7b-ctx32768`), which shares the original's weights. Ollama's
  OpenAI-compatible API takes no context length, and its default of 4096 tokens holds less than
  the tool definitions. `ollama rm <name>` removes it.
- `--out` writes every run with its calls and the start of each result; `--shots <dir>` saves a
  screenshot each time the harness answers a question. Only the hand-run results go into
  `agent-bench.md`, with the hardware, the server and its version, the model's size,
  quantisation and context length, and the Vimma commit the run prints.
- After the results, a second table says per run where the time went (the model's and the
  tools') and what a request held: the mean and largest input tokens a model turn, the mean
  output tokens, and the share of the characters sent that were tool definitions,
  instructions, the model's calls, earlier results and new results
  (`tools/agent-bench/breakdown.ts`). `--out` has the same per turn (`turns`), and each call's
  time (`ms`). Use it to measure a change that should make the agent faster or cheaper before
  and after.
- `--keep-results N` is `[agent] keep_results`: how many of the latest tool results a request
  carries whole. Left out, it is the built-in agent's default for the provider: 20 for one on
  this machine (the scripted provider and Ollama included), 6 for a hosted one. `--keep-results 0` sends every result whole,
  to measure the loop without pruning. A turn after a block was left out reads the request
  again from the first changed result, which on a local model shows as a turn several times
  slower than the others.
- `--floor` picks the scripted provider's path: `search` (the default), `product` (each
  product's page by URL, the earlier floor) or `parallel` (the search path with independent
  steps in one turn: every search in one turn, every basket button in the next). Like the
  built-in agent's runner, the bench waits out a rate refusal once and runs the call again, which
  the parallel path needs on a ten-item list: ten loads in one turn use up the open rate, which
  a click checks too.
- **Where the model ran.** For an Ollama model, `--out` records `ollama ps` at the end of the
  run (`meta.loaded`: each loaded model's `size`, `sizeVram` and `contextLength`); a row in
  `agent-bench.md` says GPU, CPU or the split. Ollama leaves out an integrated GPU unless
  `OLLAMA_IGPU_ENABLE=1` is in its environment (its log reads `dropping integrated GPU`). To
  run on one (Vulkan, such as the Radeon 860M): `sudo systemctl edit ollama`, add `[Service]`
  and `Environment="OLLAMA_IGPU_ENABLE=1"`, `sudo systemctl restart ollama`, then check that
  `journalctl -u ollama -b --no-pager | grep -E 'inference compute|integrated GPU'` names
  `library=Vulkan` rather than `id=cpu`, and that `ollama ps` reads `GPU` or a CPU/GPU split
  after `ollama run <model> hi`. The alternative is llama.cpp built with Vulkan:
  `llama-server -m <model.gguf> -ngl 99 --jinja -c 32768 --port 8080`, and the bench with
  `--endpoint http://127.0.0.1:8080/v1`.
- The browser reaches only `127.0.0.1` and `localhost` (the site suite's offline prefs), so a
  URL a model makes up loads nothing off the machine; only the model's own requests leave it,
  and only for a hosted provider.
