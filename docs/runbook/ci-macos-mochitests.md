### macOS mochitests (`e2e.yml`, spec macos-build)

The job `mochitest-macos` runs the front-end tests on hosted Apple Silicon Macs (`macos-15`), as
sub-PR 1 of [macos-build](../specs/macos-build.md) describes, in two shards that run in parallel
on runners of their own: `mochitest (artifact build, macOS, shard 1/2)` and `shard 2/2`. Each
shard's steps: `npm ci`; the whole Vitest suite (`npm test`); GNU tar and `gpgv` from Homebrew when
the image lacks them; `tools/upstream/firefox-source.sh`; `npm run import`;
`node tools/artifact-build/artifact-build.ts`, which fetches Mozilla's `macosx64-aarch64-opt`
build of the same release; and `npm run mochitest -- --artifact --shard=N/2`, headless, with one
pref set (below). `df -k .` records the free disk before the download, after the unpack and after
the tests, because GitHub documents only 14 GB for hosted Macs. On a failure a shard uploads
`mochitest-macos-logs-1` or `mochitest-macos-logs-2` (its TBPL log and the objdir's `config.log`,
kept 7 days). `fail-fast` is off, so one shard's failure does not cancel the other.

**Why two shards** ([#1569](https://github.com/vimma-browser/vimma/issues/1569)). As one job,
green runs took 35 to 44 minutes in November 2026, 33 of them in the mochitests. The hosted Mac is
a shared virtual machine with 3 vCPU and 7 GB, and its speed varies by 1.3 to 1.5 times between
runs, so one long job left every test close to its limits, and most macOS-only flakes that month
were timing failures on the slow runs. Larger macOS runners are billed and are not used.

**How the files are split.** `--shard=N/M` (`tools/mochitest-shards.ts`) takes the test files of
`tests/browser/browser.toml` and assigns them, longest first, each to the shard with the least
time so far, using `tools/mochitest-times.json`: each file's median seconds over six green macOS
runs (November 2026). A file the table does not name, such as a new test, counts as the median
file, so it lands in a shard without an edit to the table. The split depends only on the manifest
and the table, and each shard keeps the manifest's order. With the November table both shards
hold 985 s of tests; mochitest's own `--total-chunks 2`, which cuts the manifest into halves of
equal file counts, left them 13 % apart. When the shards drift apart by more than a few minutes,
refresh the table from the `TEST_START` lines of recent green job logs (`gh run view --log`).

**Time limit.** A shard was estimated at 23 minutes (5.5 minutes of setup and Vitest, 16.4 of
mochitests), so `timeout-minutes` is 35, about 1.5 times a shard, as for the macOS build
([#1546](https://github.com/vimma-browser/vimma/issues/1546)): the growing suite does not hit the
limit, and a hung run still fails with its own log.

It runs on every pull request except a docs-only one, gated by the same `changes` job as the
Linux job, and on a manual run without a `firefox-version`. It does not run when `upstream.yml` or
`upstream-beta.yml` call `e2e.yml` with a version, because a macOS failure must never block a
Linux release (spec macos-build, decision 13). It does not build `vimma-ctl`, so
`browser_vimma_control.js` skips there; vimma-ctl's own macOS tests run in `ci.yml` (`vimma-ctl
on macOS`). The e2e smoke scenarios run on macOS in the smoke jobs of `macos.yml` and
`release.yml` instead ("macOS build" below), against the built `.dmg`.

**Informational, not required.** The job is new and its runner type has no history in this
repository, so a flaky macOS run would otherwise block every pull request (spec macos-build,
decision 34). It fails visibly, with no `continue-on-error`, and the ruleset "main" must not list
it among the required checks ("Merging and branch protection" above). It becomes a candidate for
a required check once it has been green and not flaky for about two weeks, as the Linux job was.
The timeouts that kept it red on every run are explained below.

**Background tabs and QoS** ([#605](https://github.com/vimma-browser/vimma/issues/605)). Firefox
lowers a content process to background priority when none of its tabs is shown, and on macOS
(`threads.lower_mainthread_priority_in_background`, on by default there and off on Linux
releases) it also moves that process's main thread to the background QoS class. A real Mac runs
those threads on its efficiency cores. The hosted runner is a virtual machine with three
identical cores, where they starve: the job failed on every pull request, each time in a few of
the files that load or read hidden tabs (the agent workspace's, the MCP tools', live grep's
window scope), as fixed waits of 5 s, the 20 s page load of an agent read or the 45 s file limit
ran out. An A/B run of the same commit had 15 failures with the default and 1 with the pref off.
Two changes follow from it:

- Agent commands raise the content process of the tab they work on to foreground priority while
  they run (`raisePriority` in `ctl/agent-waits.mjs`, through `nsIRemoteTab.priorityHint`, as the
  tab switcher does for a tab about to be shown), so an agent on a real Mac is not slowed by
  this either. `browser_vimma_mcp_agent.js` checks it on every platform.
- The job runs the mochitests with
  `--setpref=threads.lower_mainthread_priority_in_background.enabled=false`, because a test's own
  loads and page scripts in hidden tabs measure the runner's scheduler rather than Vimma.

A failure in a hidden-tab test on this job is therefore a real one again. A test that reads
what a background tab's process sends the parent (session history, a title, typed keys) waits
for it, as `TabStateFlusher.flush` or a polled value does, instead of reading it once.

**A slower machine, not a different one.** The runner's main thread is often busy for longer
than on Linux, and the remaining flakes all came from that, each with a fix in the code or in
what a test waits for:

- A page-first key (`ctrl+l`) pressed into a tab whose content process is still starting was
  lost: Firefox sends a page that is not ready for input no key and dispatches the keypress at
  the `<browser>` again, and Vimma waited for a reply that never came. Vimma now runs the key
  from that second keypress (`browser_vimma_browser_keys.js`,
  `a_page_first_key_runs_in_a_tab_whose_process_is_still_starting`; it was the tabstrip file's
  first `ctrl+l`, right after `browser_vimma_tab_search.js` started new processes).
- A Hyprland request timed out when the main thread was held past its 500 ms (a window opening)
  with the reply already queued behind the timer. The 500 ms now count in steps of at most
  50 ms, so time the main thread was held does not use them up (`HyprIpc.sys.mjs`;
  `browser_vimma_private_swap.js`, `a_reply_held_up_by_a_busy_main_thread_still_counts`).
- The toolbar's overflow menu was compared after a fixed 300 ms while CustomizableUI was still
  moving buttons, one layout flush per button. The test now waits for
  `overflowable.isHandlingOverflow()` to end, as Firefox's own tests do.
- A focus wait lost its target in a tab opened a moment before. A new tab starts on the initial
  `about:blank`, and its page then replaces that document with a new window global, after the
  tab shows in the side panel and while `webProgress` reports no load. SpecialPowers'
  `EnsureFocus`, sent to the first document, failed with "Actor 'SpecialPowers' destroyed".
  `browser_vimma_tabline.js` now waits until each tab it opens has its page's document
  ([#1350](https://github.com/vimma-browser/vimma/issues/1350)).
- A wait for a reload ended on the document the reload was about to replace. pdf.js sends
  `textlayerrendered` once for each page it draws, page 2 a few milliseconds after page 1; a wait
  for that event, set for the next reload before the previous load had drawn page 2, took page 2's
  event, and the focus wait that followed failed with "Actor 'SpecialPowers' destroyed" when the reload replaced the
  document. `browser_vimma_pdf_keys.js` now waits until the window global is replaced and the new
  document has drawn a text layer ([#1511](https://github.com/vimma-browser/vimma/issues/1511)).
- The harness lists repeating timers once as the run starts, and a repeating timer is out of
  that list while it fires: ConfigHost's poll firing at that moment was reported as left by the
  first file (`browser_vimma_a11y.js`). The poll is now a one-shot timer set again at each tick.

A new flake on this job is looked for in the same places first: an event or reply that a busy
main thread delays, and a fixed wait that a test should replace with the condition it waits for.

When it fails:

- **Vitest:** a test that assumes Linux (a path, `/proc`, a shell tool). Make the test or the
  code portable, or gate the macOS difference on `process.platform === "darwin"`; never loosen a
  Linux expectation.
- **Source, import or artifact build:** compare with the Linux job in the same run. If only macOS
  fails, read the step log and `config.log`; a missing Taskcluster index for
  `macosx64-aarch64-opt` means Mozilla's build for that revision has expired or does not exist.
- **Mochitests:** reproduce on a Mac with "Building on macOS" in
  [CONTRIBUTING.md](../../CONTRIBUTING.md). Fix the test or the code; a test that cannot pass on
  macOS gets `skip-if = ["os == 'mac'"]` in `tests/browser/browser.toml` with a comment naming
  its issue.

**Merging past a red shard.** The macOS shards are not required checks, and a red shard does not
block a merge when all of these hold: the failing test is in a file the pull request does not
touch, and `main` also shows that failure (a recent run on `main` or on another pull request).
The failure then gets an issue labelled `flaky` and `owner:mac` (or a comment on the existing
one), the pull request body names it, and the shard is re-run at most once. A failure in a file
the pull request touches still blocks the merge, as does a failure that `main` does not show. The
reason: these are shared 3-vCPU runners whose speed varies by 1.3 to 1.5 times between runs, so
an unrelated timing failure there says more about the runner than about the change.
