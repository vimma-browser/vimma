### macOS mochitests (`e2e.yml`, spec macos-build)

The job `mochitest (artifact build, macOS)` runs the front-end tests on a hosted Apple Silicon
Mac (`macos-15`), as sub-PR 1 of [macos-build](../specs/macos-build.md) describes. Its steps: `npm
ci`; the whole Vitest suite (`npm test`); GNU tar and `gpgv` from Homebrew when the image lacks
them; `tools/upstream/firefox-source.sh`; `npm run import`;
`node tools/artifact-build/artifact-build.mjs`, which fetches Mozilla's `macosx64-aarch64-opt`
build of the same release; and `npm run mochitest -- --artifact tests/browser/`, headless, with
one pref set (below). `df
-k .` records the free disk before the download, after the unpack and after the tests, because
GitHub documents only 14 GB for hosted Macs. On a failure the run uploads `mochitest-macos-logs`
(the mochitests' TBPL log and the objdir's `config.log`, kept 7 days).

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
  they run (`raisePriority` in `agent-commands.mjs`, through `nsIRemoteTab.priorityHint`, as the
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
- A merge with this check red is allowed; the failure then gets an issue of its own.
