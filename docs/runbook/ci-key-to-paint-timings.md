### Key-to-paint timings (`browser_vimma_perf.js`)

The second performance budget, key-to-paint in the window, and the 200-tab risk in
[roadmap.md](../roadmap.md), measured read-only in a mochitest (no paint timestamp on the control
socket): `performance.now()` just before `EventUtils.synthesizeKey`, again when the synchronous key
handling returns (**action**), and at the first `MozAfterPaint` of the chrome window after which the
result holds (**paint**).
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

**Budgets** (`BUDGETS` in the test, on medians, about twice the higher Linux CI median): action 25
ms for all three cases; paint 85 ms for pane-focus, 150 ms for workspace-200-in, 115 ms for
workspace-200-out. Past one means a doubled action or about two extra frames, not runner noise.
The floors are not gated. The "< 5 ms key-to-paint" budget cannot be checked as an absolute in
a headless run whose paints come every ~35 ms; the closest gated reading is the action time,
8 to 13 ms today, mostly Firefox's own tab selection. Re-record from CI
numbers only, with a changelog line in the commit body; two CI samples back them so far, so add
later runs' `VIMMA_PERF` lines here before tightening anything.

**macOS budgets** ([#1567](https://github.com/vimma-browser/vimma/issues/1567),
[#1570](https://github.com/vimma-browser/vimma/issues/1570)). The hosted macOS runner is a
shared 3-vCPU virtual machine whose speed varies by up to 1.46 times between runs ("macOS
mochitests" in [ci-macos-mochitests.md](ci-macos-mochitests.md)), and the Linux action budget of
25 ms failed there at 26.3 ms on a slow run. The medians of 102 macOS jobs (23 to 26 November
2026; median of the runs / highest):

| Case                | Action         | Paint           |
| ------------------- | -------------- | --------------- |
| `floor`             | 0.08 / 0.15 ms | 39.2 / 42.4 ms  |
| `key-floor`         | 1.21 / 2.46 ms |                 |
| `pane-focus`        | 12.9 / 26.3 ms | 45.1 / 70.9 ms  |
| `workspace-200-in`  | 11.1 / 22.4 ms | 79.2 / 112.7 ms |
| `workspace-200-out` | 11.3 / 22.1 ms | 54.0 / 72.5 ms  |

On macOS the action budgets are a third above the highest median, rounded up to 5 ms: pane-focus 35
ms, workspace-200-in and workspace-200-out 30 ms. The paint budgets are shared, since every macOS
paint median is inside them. A doubled action on a median macOS run (about 26 ms) passes there; the
Linux job, a required check with the 25 ms budget, is the one that catches it, and the macOS budget
catches about a tripled one. A wait of 35 ms added to `PaneView.focus` on a Mac (headless artifact
build) took the pane-focus action median from 4.7 to 43.1 ms, and the check failed: `pane-focus:
median action within 35 ms - 43.1 <= 35`.

The run's own floors were considered as the yardstick, as paint is read against `floor`, and
rejected: across the 102 jobs they do not follow the action time. The paint floor barely moves
(34.7 to 42.4 ms; correlation with the run's overall speed 0.26), and dividing pane-focus action
by the `key-floor` action narrows its spread only from 3.5 to 3.1 times (workspace-200-out's
widens, 3.4 to 4.0). A floor that does follow it, such as selecting a tab without a key, runs
Vimma's own tab-select handlers, so it would rise with the regressions the budget is there to
catch.
