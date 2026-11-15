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

**Budgets** (`BUDGETS` in the test, on medians, about twice the higher CI median): action 25
ms for all three cases; paint 85 ms for pane-focus, 150 ms for workspace-200-in, 115 ms for
workspace-200-out. Past one means a doubled action or about two extra frames, not runner noise.
The floors are not gated. The "< 5 ms key-to-paint" budget cannot be checked as an absolute in
a headless run whose paints come every ~35 ms; the closest gated reading is the action time,
8 to 13 ms today, mostly Firefox's own tab selection. Re-record from CI
numbers only, with a changelog line in the commit body; two CI samples back them so far, so add
later runs' `VIMMA_PERF` lines here before tightening anything.
