# Spec: site-compat

Status: implemented · Milestone: after private-swap (testing infrastructure, no
user-visible change) · Area: `tools/sites/` (new), `tools/e2e/launcher.mjs` (one option),
`.github/workflows/sites.yml` (new), `package.json` (one script), `.github/workflows/e2e.yml`
(one step), `tests/e2e/fixtures/sites/` (new). No upstream patch, no product code, no new
dependency.

Issue: [#262](https://github.com/vimma-browser/vimma/issues/262)

Engine paths are relative to `engine/` (Firefox 157.0.1). Timings were measured with
`gh run list` / `gh run view` on 2026-10-12. GitHub's billing and runner facts were checked
against docs.github.com the same day (links in Research).

## Goal

Run automated tests on the sites most developers use, to see how well Vimma works on them, starting
with sites that need no login. The suite must be cheap enough to run on GitHub's hosted runners, or
else justify a dedicated runner.

## Cost in short

Free, and light. The repo is public, and GitHub's billing docs say "GitHub Actions usage is free
for self-hosted runners and for public repositories that use standard GitHub-hosted runners".
A nightly run is one job of about 20 minutes on one standard runner (estimate below): about
600 runner-minutes a month at no charge, 1 of the 20 hosted jobs the free plan runs at once, at
an hour when no PR is waiting. A dedicated runner is not needed for cost. It could matter for
**IP reputation**: some sites show bot checks more often to datacenter IPs. The plan is to run
on GitHub's runners every night and run `npm run sites` from home when wanted; a self-hosted
runner is not used (decision 10).

## User stories

- As the maintainer, `npm run sites` loads each site on the list once in a real Vimma build
  under Xvfb, runs the same checks on each, and writes a JSON file plus an HTML and a Markdown
  report: a table of site × check (pass, fail, skipped with a reason, or blocked), screenshots,
  load times and key-to-effect latencies. `npm run sites -- --filter github` runs a subset.
- As the maintainer, every night the `sites` workflow does the same on a GitHub-hosted runner,
  writes the table into the job summary and uploads the report as an artifact. It never runs
  on a pull request and never blocks a merge.
- As the maintainer, a site that shows a bot check or captcha is reported as
  "blocked (bot check)" and a consent wall Vimma could not get past as "consent", not as a
  failure of Vimma. Where a consent page has a plain "Reject all" button, the run clicks it and
  carries on.
- As the maintainer, I can edit the site list (`tools/sites/sites.json`) without touching code.
- As the maintainer, a site that takes over a Vimma key (YouTube's `k`, GitHub's `s`) shows up
  as a note in the report, so I know which bindings users of that site lose in normal mode.

## Research

### How e2e.yml and nightly.yml build and run Vimma

- `e2e.yml` (the required "mochitest (artifact build)" check) runs on `ubuntu-24.04`, a
  standard hosted runner. It builds `vimma-ctl` (`cargo build --locked`), downloads the Firefox
  source tarball (checked against Mozilla's `SHA512SUMS`), runs `npm run import`, makes an
  **artifact build** (`tools/artifact-build/artifact-build.mjs`: our front end on Mozilla's
  compiled binaries for that exact release, ADR-010), then runs the mochitests and
  `npm run e2e -- --artifact` (`.github/workflows/e2e.yml:91-147`). No secret, read-only
  token.
- `nightly.yml` is the **full** build on the self-hosted `vimma-build` runner (a full build
  does not fit a hosted runner: 22 GB, 39 min). It is gated by `NIGHTLY_ENABLED` and holds the
  Safe Browsing secret (`.github/workflows/nightly.yml:1-30`). The site suite must not go
  there: it would need that self-hosted runner and sit next to a secret, and it needs neither.
  It reuses e2e.yml's artifact build in a workflow of its own. (Since changed: no self-hosted
  runner is used or planned; the nightly moves to a hosted runner with [#224](https://github.com/vimma-browser/vimma/issues/224), spec
  build-supply-chain, decision 6. The site suite still stays out of it, because it needs
  neither the full build nor the secret.)
- Step times of a recent successful e2e run (run 38229657690): checkout, Node, `npm ci` 12 s;
  `vimma-ctl` 9 s; harness tests 9 s; Firefox source tarball 58 s; import 1 s; artifact build
  127 s; mochitests 258 s; e2e scenarios 39 s. The last 20 successful runs took 6.4 to 8.9 min
  (median 8.4). **Setup up to a runnable artifact build is about 3.6 min**; the site suite
  replaces the mochitests and scenarios.

### The harness to build on

- `tools/e2e/launcher.mjs` makes the throwaway profile (`createProfile`, line 133, with the prefs
  at line 42: first-run pages, telemetry and background network off), starts Xvfb, spawns the
  browser in its own process group and waits for the control socket (`launch`, line 664).
  `tools/e2e/driver.mjs:92` (`Ctl`) runs `vimma-ctl` for `send-keys`, `state` and `open`.
- `state` (`ctl/VimmaControl.sys.mjs:260`) reports `mode`, `pending` (`"prefix"` after
  `ctrl+b`), `workspace` and each tab's `id` (the browserId), `url` and `title`. That is enough
  for keys, navigation and modes, but not for what a check must see in the page: scroll
  positions, the focused element, hint labels, the find result, the clipboard, errors.

### How to observe the page without changing what a site sees

Four options were tried or read:

1. **WebDriver BiDi or Marionette.** Both turn on `navigator.webdriver`:
   `Navigator::Webdriver()` returns true while either reports `isBrowserAutomationRunning`
   (`dom/base/Navigator.cpp:2352-2374`; `remote/components/RemoteAgent.sys.mjs:146-148`), and
   there is no pref to hide it (`dom/webidl/Navigator.webidl:316-318` has no `[Pref]`). Bot
   checks (Cloudflare, Google) look for exactly that, so the suite would measure its own
   automation. Rejected.
2. **A test-only probe command on the control socket.** Honest, but it adds product surface
   (protocol, Rust client, a pref gate, a security review) for a test tool. Kept as the fallback
   if option 4 breaks.
3. **A helper WebExtension.** Release builds enforce add-on signing
   (`toolkit/moz.configure:2018-2029`; `MOZ_REQUIRE_SIGNING = 1` in the artifact build's
   `config.status`). A temporary install needs a privileged client anyway. Rejected.
4. **The DevTools remote debugging server (chosen).** `--start-debugger-server <path>` opens
   the DevTools protocol (RDP) on a Unix socket (`devtools/startup/DevToolsStartup.sys.mjs:1245-1266`)
   when `devtools.debugger.remote-enabled` and `devtools.chrome.enabled` are on (line 23). It is
   what about:debugging and `web-ext run` use. It is not browser automation, so
   `navigator.webdriver` stays `false` (checked live on Wikipedia). It can evaluate read-only
   probes in the parent process (chrome scope: the status bar, the hint layer, `VimmaHost.status`,
   the clipboard) and in a tab (scroll positions, the focused element, links under a hint).
   The prototype got all of these on GitHub and Wikipedia.

So the suite drives with `vimma-ctl`, the shipped client, exactly like the e2e scenarios, and
uses RDP only to look. RDP framing is `<byte length>:<JSON>`; a reply comes from the actor in
request order; `evaluateJSAsync` answers `{ resultID }` and then sends an `evaluationResult`
event (`devtools/shared/specs/webconsole.js:45-60, 149-165`). A client of about 200 lines in Node
needs no dependency.

### What each check can see

- **Hints.** The labels are drawn in the chrome document, in `#vimma-hints` with one
  `.vimma-hint` per target, `data-label` and `left`/`top` at the target's top-left in content
  CSS pixels times the zoom (`ui/hint-overlay.mjs:13, 50-55`). A probe in the tab maps each
  label's point to the link under it (`elementFromPoint(...).closest("a[href]")`), so the suite
  can choose a same-tab link and type its label.
- **Scrolling.** `j`/`k` step 60 px, `ctrl+d`/`ctrl+u` half a page, `gg`/`G` top and bottom
  (`packages/vimma-core/src/defaults.mjs:105-121`). The actor scrolls the document's scrolling
  element, or the largest scrollable inner element when the page is an app shell or locked
  (`actors/VimmaChild.sys.mjs:457-510`). The probe lists the scrolling element and every inner
  element that can scroll, so a check sees which one moved.
- **Find.** `VimmaHost.status(win).find` (`host/VimmaHost.sys.mjs:1091-1106`) holds the query,
  `notFound`, `current` and `total` once the find bar reports (live on GitHub: "neovim",
  10 matches).
- **`yy`.** `page.yank_url` copies `currentURI.spec` with `nsIClipboardHelper`
  (`host/page-ops.mjs:75-80`). The suite writes a sentinel first and reads the clipboard back
  in chrome. It always runs under its own Xvfb, so it never touches the desktop's clipboard.
- **`ctrl+b`.** `state.pending` is `"prefix"` after `ctrl+b`. A keydown listener the probe adds
  to the page's window (capture phase) shows whether the page saw the key.
- **Status bar.** The mode segment is `#vimma-statusbar [data-segment=mode]`, its text the mode
  in capitals (`ui/statusbar.mjs:17`, `packages/vimma-core/src/statusbar.mjs:159-160`). It
  renders on a scheduled frame: right after `i` it still said `NORMAL` once in the prototype,
  so the check polls for up to a second before it compares.
- **Errors.** Content processes forward their console messages to the parent's console
  service (`dom/ipc/ContentChild.cpp:475-504`, `ContentParent::RecvScriptError`,
  `dom/ipc/ContentParent.cpp:4914`). One `nsIConsoleListener` in the parent therefore sees
  errors from chrome and from the actor. The suite keeps those whose source or stack is under
  `chrome://browser/content/vimma/` and, through `console-api-log-event`, Vimma's own
  `console.error`. GitHub alone logs dozens of the site's own errors and warnings (the
  prototype saw referrer-policy warnings); those are ignored.
- **Site shortcuts.** A key the site handles shows as `defaultPrevented`, a focus change, a URL
  change, a scroll or a new dialog. On GitHub, `s` focused the search field (and Vimma went to
  insert mode, correctly). How the key reaches the page is settled in the implementation log.

### Bot checks, consent walls and IP reputation

- Recognisable from the URL, the title, the start of the page text and the iframes: Cloudflare's
  "Just a moment..." / "Verify you are human" and `challenges.cloudflare.com` (Stack Overflow,
  Cloudflare docs, CodePen), Google's `/sorry/` page and "unusual traffic", reCAPTCHA and
  hCaptcha iframes, Reddit's "whoa there, pardner!" and "blocked by network security",
  DuckDuckGo's anomaly page, Akamai's "Access Denied". Consent walls: `consent.google.com`,
  `consent.youtube.com` ("Before you continue"), and common consent-manager containers
  (OneTrust, Sourcepoint, Quantcast, Didomi, Funding Choices).
- **IP reputation.** GitHub-hosted runners are Azure datacenter IPs. Reddit, Google search and
  Cloudflare-fronted sites (Stack Overflow) challenge datacenter ranges far more often than a home
  connection. Expect some of those to show as blocked on some nights. That is why bot checks are
  their own status, and why `npm run sites` from a home network is the second half of the plan.
- **Consent.** The runner is in the US, so Google and YouTube usually show no consent wall
  there. From Finland they do. A "Reject all" click is safe (it only refuses), so the suite
  tries it. It never clicks "Accept".

### GitHub's terms that matter here

- Billing (<https://docs.github.com/en/billing/concepts/product-billing/github-actions>):
  "GitHub Actions usage is free for self-hosted runners and for public repositories that use
  standard GitHub-hosted runners." "Larger runners are always charged for, even when used by
  public repositories." So the workflow uses `ubuntu-24.04`, never a larger runner.
- Runners (<https://docs.github.com/en/actions/reference/runners/github-hosted-runners>): a
  standard Linux runner for a public repo has 4 CPUs, 16 GB RAM and 14 GB SSD.
- Self-hosted security (<https://docs.github.com/en/actions/reference/security/secure-use>,
  "Hardening for self-hosted runners"): "self-hosted runners should almost never be used for
  public repositories", because "any user can open pull requests against the repository and
  compromise the environment", and a self-hosted runner "can be persistently compromised by
  untrusted code in a workflow".

## Cost and runtime

| Part                                               | Time            | Source                                                        |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| Checkout, Node, `npm ci`, `vimma-ctl`              | ≈ 0.4 min       | e2e run 38229657690                                           |
| Firefox source, import, artifact build             | ≈ 3.1 min       | same                                                          |
| 25 site entries × ≈ 15-35 s (launch, load, checks) | ≈ 10-14 min     | measured 8.6 min for 22 locally (sub-PR 1); nightly 10-14 min |
| Retry of blocked sites (decision 11), diff, upload | ≈ 0.5-1.5 min   | 2-3 blocked sites a night × ≈ 30 s                            |
| **Total per night**                                | **≈ 13-17 min** | budgeted as 20 min                                            |

- About 600 runner-minutes a month, free (public repo, standard runner). The job takes 1 of the
  free plan's 20 concurrent hosted jobs, at 04:30 UTC, when no PR is waiting on e2e.
- Artifacts: one PNG per site after load and one with the hint labels showing, plus one per
  failed check: roughly 40-60 PNGs of 100-400 kB, so about 10-20 MB a night. Kept 14 days.
- Network: each site is loaded once, plus the one link a hint follows. No crawling. That is a
  few MB per site, one visit a day from one IP. Well under anything a site would notice.
- **Self-hosted alternative.** Free too, but on a public repo it is only acceptable if: the workflow
  that uses it is triggered **only** by `schedule` and `workflow_dispatch` (never `pull_request`,
  `pull_request_target`, `issue_comment` or `push` from forks), the runner is registered to this
  repo with a dedicated label, it runs in a dedicated VM or container that is reset after each job
  (ephemeral runner), it holds no secret beyond its registration, and it is **not a developer's
  daily machine**. `nightly.yml` already uses that pattern for the full build (`if:` on the event
  and ref). The gain would be a residential IP, which matters only if bot checks swamp the hosted
  results.

## Decisions

1. **A separate workflow, `sites.yml`, on `ubuntu-24.04`.** Triggers: `schedule` (04:30 UTC
   daily) and `workflow_dispatch` (with an optional `filter`). Never `pull_request` or `push`; a
   workflow test enforces that. It is not a required check. It reuses e2e.yml's steps up to
   the artifact build (copied, with the tarball's SHA-512 check). It does not touch
   `nightly.yml`.
2. **Drive with `vimma-ctl`, observe with RDP** (Research, option 4). The probes only read,
   except a few narrow writes: the clipboard sentinel, a keydown recorder on the page's window
   for the `ctrl+b` check, focusing the search field, synthetic key events for the shortcut
   check (and a synthetic Escape and blur after each), and a "Reject all" click on a consent
   wall.
3. **One fresh profile and browser per site**, as e2e does per scenario: no cookies or state
   carry over, and a crash costs one site. The launcher gains an `args` option for
   `--start-debugger-server`, and the profile gets the three DevTools prefs on top of e2e's.
4. **Firefox's normal user agent**, unchanged (Vimma's UA is Firefox's, spec m0-user-agent).
   The window is 1280 × 800, the e2e size.
5. **Checks per site, in this order**, each recorded as `pass`, `fail`, `skip` (with a reason) or
   `info`:
   1. `load`: the page loads (`readyState` complete) within 45 s; records the navigation-timing
      load time. A bot check or consent wall here makes the site `blocked` or `consent`, and the
      remaining checks `skip` with that reason.
   2. `scroll`: `j`, `k`, `G`, `gg`, `ctrl+d`, `ctrl+u` each move the main scrolling element or
      an inner scroller the right way. Records which one moved and the `j` latency. `skip` when
      nothing on the page can scroll.
   3. `find`: `/`, a word taken from the visible text (or the site's `find` entry), Enter: the
      find status has the query and at least one match, and the mode is back to normal.
   4. `yank`: `yy` puts the tab's URL on the clipboard.
   5. `insert`: focusing the site's search field (its `search` selector, else the first visible
      search or text input) gives insert mode; Esc gives normal mode and the field loses focus.
      `skip` when the page has no such field.
   6. `prefix`: `ctrl+b` in normal mode and in a focused field gives `pending: "prefix"`, and the
      page sees no `ctrl+b` keydown.
   7. `shortcuts` (`info`): Vimma's single normal-mode keys, dispatched to the page as synthetic
      key events (Vimma does not see them); the ones the site reacts to are listed. Stops at the
      first key that navigates. (Changed in sub-PR 1 from "pressed in pass-through insert
      mode": see the implementation log.)
   8. `hints`: `f` shows labels (count and the visible links/buttons are recorded); typing the
      label of a same-tab link navigates. Last, because it leaves the page.
   9. `errors`: no uncaught error and no `console.error` from Vimma's code during the visit.
   10. `statusbar`: after every step above, `state.mode` is the expected mode and the status bar
       shows it.
6. **Latency** is measured in Node from the `vimma-ctl send-keys` call to the effect seen by
   polling (10 ms): an upper bound that includes starting `vimma-ctl` (a few ms) and one RDP
   round trip. Good enough to spot a page where `j` takes 300 ms instead of 30.
7. **Statuses per site**: `ok` (no fail), `fail`, `blocked`, `consent`, `error` (the harness
   could not load or drive it). The run's exit code is 0 when it produced a report, whatever the
   sites did, and 1 when the harness itself failed. It is a report, not a gate.
8. **Output** in `site-compat-output/` (git-ignored): `results.json`, `report.md` (also the job
   summary), `report.html` (self-contained, screenshots linked), `screenshots/<site>-<n>.png`.
9. **The list is data**, `tools/sites/sites.json`: `id`, `name`, `url`, and optional `search`
   (CSS selector), `find` (a word on the page), `notes`. A unit test checks its shape.
10. **GitHub-hosted runners only, plus local runs.** If bot checks swamp the nightly results,
    the response is a shorter site list or a local run from a residential network, not a
    self-hosted runner, because on a public repository a self-hosted runner is a machine that
    needs a security design of its own, and Vimma runs none for any workflow (spec
    [build-supply-chain](build-supply-chain.md), decisions 6 and 7). Rejected: the self-hosted
    alternative in Research, for that reason.
11. **A blocked site is retried once, at the end of the run, on the nightly runner only.**
    `npm run sites -- --retry-blocked` loads each site whose status is `blocked` (bot check) a
    second time, in a fresh profile, after every other site has run; `sites.yml` passes the flag
    and local runs do not by default. A bot check on a datacenter IP is often a short-lived rate
    or reputation decision, so a second visit minutes later turns some of them into a real
    result, at the cost of one more page load for that site only. A home IP is the opposite
    case: it is the developer's own connection, and every extra visit to a site that already
    challenges it makes the next challenge more likely. The retry's result replaces the first
    one, which stays in `results.json` under `retry` (its status and block reason); the report
    lists every retried site with both outcomes. A consent wall is not retried, because it does
    not go away on its own.
12. **Regressions go to one rolling issue labelled `site-compat`.** Each nightly run compares
    its results with the previous scheduled run's `results.json` (downloaded from that run's
    artifact) and writes the changes into the job summary and `diff.md`. A **regression** is a
    check that passed in the previous run and fails now. Regressions are tracked from night to
    night in `diff.json`, which each run uploads as its `site-compat-diff` artifact: a tracked
    regression stays
    until its check passes again, and stays while its site could not be checked (blocked,
    consent, a harness error on that site, or the check skipped). A site removed from the list drops out. The
    issue is opened when a new regression appears and none is open, updated on each scheduled
    run while any regression is tracked, and closed with a comment when none is left, the
    pattern of `spec-status.yml`. A failure in the artifact alone goes unseen, and one issue
    rather than one per failure keeps a live suite, whose sites change without notice, from
    filling the tracker. Checks that already failed before they were first compared (the known
    failures of the first run) are listed in the diff but open no issue, because they are not
    news. Only `schedule` runs touch the issue: a `workflow_dispatch` run, often filtered, shows
    its diff in the job summary only, so the night-to-night chain stays one run per night. If
    the previous `results.json` has expired or cannot be read, the run has no baseline and says
    so, but still checks the tracked regressions from the previous `diff.json` against its own
    results; an issue open across such a break is not closed automatically (implementation log,
    sub-PR 2).

    Page titles and check reasons come from live pages and end up in the issue body, where
    Markdown would render, `@name` would notify a user and `#123` or a URL would link another
    issue. Every such value is written as an inline code span (no mentions,
    references, links or HTML render inside one), with control and bidirectional-override
    characters replaced, and cut to 160 characters; a list stops at 50 entries and the body at
    60 000 characters. The downloaded `results.json` and `diff.json` are checked for shape (site
    ids, statuses and check ids from known sets) and rejected otherwise. The job that runs the
    browser can only read the repository. A second job, on a fresh runner, takes only that
    job's `results.json`, downloads the previous run's files and writes the diff and the issue
    text, with read permissions only (`actions` for the artifacts, `issues` to find the open
    issue). `issues: write` belongs to a third job that checks out nothing and runs only `gh` on
    that text (docs/security.md, "Site compatibility workflow").

13. **Shortcut conflicts are reported, not acted on.** The `shortcuts` check stays `info`. A
    per-site pass-through list would be a user-facing configuration feature with its own design
    (which keys, how sites are matched, how it meets insert mode and the prefix), so it belongs
    in a spec of its own; the report already gives that spec its data.
14. **Three more sites:** the Hacker News comments page of a long thread, a crates.io crate page
    and a GitLab project page, for 25 entries, because each adds a page structure the list
    lacked: a deeply nested table of comments with hundreds of links, an Ember app shell, and a
    large Vue application that is often behind a bot check. GitLab stays only while it loads
    from the hosted runner on most nights; if it is blocked night after night, it is removed, as
    decision 10 prescribes for bot checks that swamp the results.

## Sub-PRs

1. **This one.** `tools/sites/` (RDP client, probes, checks, bot-check classification, results,
   report, CLI), `sites.json` with the 22 entries, `npm run sites`, `sites.yml`, unit tests for
   the pure parts and the workflow's shape, one local live run whose table goes into the PR.
2. **Night-to-night diff, retry and alerts** (decisions 11, 12 and 14): `--retry-blocked`, the
   comparison with the previous scheduled run, `diff.md` and `diff.json`, the rolling
   `site-compat` issue, and the three new sites. Unit tests with recorded `results.json` files
   from nightly runs.
3. **Snapshot layer**, the per-PR gate (design below). Not small, so not in sub-PR 1.

### Snapshot layer (design; sub-PR 3)

Goal: run the same checks on PRs, offline and deterministic, against recorded versions of
selected pages, and fail the PR when a check that passed on the recording fails.

- **What is recorded.** Not the network (a recording proxy needs a CA in the profile, a
  Python or Go dependency, and replays scripts that phone home). Instead the page's **rendered
  DOM** after load: `document.documentElement.outerHTML` with scripts, event handlers and
  `<iframe>` sources removed, every same-origin and fetchable stylesheet inlined (from
  `document.styleSheets[*].cssRules`), images replaced by sized placeholders, and inner
  scrollers' `overflow` kept. Taken through the same RDP connection, by
  `npm run sites -- --record <id>`. What it keeps: links, buttons, inputs, layout and inner
  scroll containers, which is what hints, scrolling, find, insert and `ctrl+b` depend on. What it
  loses: the site's scripts, so app shells (Excalidraw, YouTube, CodePen's editor) and site
  shortcuts cannot be replayed. Those stay live-only.
- **Licences decide what may be committed.** The repo is public. Only pages whose licence
  allows redistribution go in `tests/e2e/fixtures/sites/`: Wikipedia and MDN (CC BY-SA, with
  attribution in a README next to them), docs.python.org (PSF documentation licence),
  doc.rust-lang.org (MIT/Apache-2.0). GitHub, Stack Overflow's layout, YouTube, Google and the
  rest are not committed. For those, a failure found by the live run becomes a **hand-written
  minimal fixture** that reproduces the structure (an app-shell scroller, a shadow-DOM button, a
  page that grabs `keydown`), named after the issue, like the existing e2e fixtures (plan §5:
  one regression test per bug).
- **How it runs.** A scenario type in `tools/e2e` (or `npm run sites -- --offline`) serves the
  fixtures from the existing page server on 127.0.0.1 and runs the checks above except
  `shortcuts`. On PRs it runs inside e2e.yml after the scenarios, adding about 1 min for 4-6
  pages. Screenshots are not compared (fonts differ between machines; the checks assert on
  state).
- **Size:** recorder, sanitiser, offline mode, 4-6 fixtures with attribution, e2e.yml wiring
  and tests: a PR of its own.

## Test plan

- Vitest, written first (`tools/sites/test/`):
  - `classify.test.mjs`: Cloudflare, Google `/sorry/`, reCAPTCHA/hCaptcha iframes, Reddit,
    DuckDuckGo and Akamai pages are `bot-check`; Google/YouTube consent pages and consent
    manager containers are `consent`, with the reject button found when it is there; ordinary
    pages that mention "captcha" in an article are not.
  - `results.test.mjs`: a site's status from its checks (fail beats skip, blocked and consent
    skip the rest, `info` never fails), the summary counts, the exit code, the mode-step
    aggregation for `statusbar`.
  - `report.test.mjs`: the Markdown table (one row per site, one column per check, symbols and
    reasons, latency and load columns), the HTML report escapes page titles and links the
    screenshots, the summary line.
  - `rdp.test.mjs`: packet framing (split and joined chunks, UTF-8 lengths), replies matched to
    requests per actor, `evaluationResult` matched by `resultID`, a closed socket rejects what is
    pending. Against a fake RDP server on a Unix socket.
  - `sites-data.test.mjs`: every entry has a unique `id`, an `https` URL, and only known fields.
  - `tools/test/sites-workflow.test.mjs`: `sites.yml` runs on `schedule` and
    `workflow_dispatch` only, on `ubuntu-24.04`, with `contents: read`, no secrets, every action
    pinned by SHA, and the report uploaded even when the run fails.
  - `tools/e2e/test/launcher.test.mjs`: `browserArgs` puts extra switches before the URL.
- Vitest for sub-PR 2, written first, on `results.json` files recorded from nightly runs
  (`tools/sites/test/fixtures/`):
  - `diff.test.mjs`: a check that passed and now fails is a new regression; one that failed in
    both runs is not; a tracked regression stays while it fails or its site is blocked and goes
    when it passes or the site leaves the list; status changes, added and removed sites; no
    baseline, and a baseline of the wrong shape, give an empty comparison; the issue action for
    each case (create, update, close, none, and none for a run that is not scheduled); titles
    and reasons with Markdown, `@mentions`, `#123`, URLs, backticks, newlines and bidirectional
    overrides come out as inert code spans, cut to length, and the body stays under its cap.
  - `results.test.mjs`: which sites a retry runs (blocked only), and how a retry's result
    replaces the first while keeping its status, block and screenshots.
  - `report.test.mjs`: the retried sites' section.
  - `sites-workflow.test.mjs`: `--retry-blocked` in `sites.yml` and not in `npm run sites`;
    the browser job's permissions are read-only, `issues: write` is only in a job with no
    checkout and no `node` or `npm`, and that job reaches the issue only through `gh` and
    files.
- Vitest for sub-PR 3, written first:
  - `snapshot.test.mjs`: `verifySnapshot` rejects scripts, every element that loads or embeds
    something, event handlers however they are written, any `href` but a fragment or the follow
    target, every other URL attribute, `url()`, `@import` and `image-set()` in styles, and a
    missing or weakened Content-Security-Policy; it is not fooled by markup in comments, text or
    `<style>`. Every committed snapshot passes it, is in `snapshots.json` with its licence, and is
    attributed in the README. The manifest's shape; which ids may be recorded; the gate (a check
    that passed on the recording and does not now fails it, as does a skipped one that fails, a
    snapshot that did not run or a harness error; `shortcuts` is ignored) and its summary.
  - `sites-workflow.test.mjs`: e2e.yml runs the suite only with `--offline`, after the
    scenarios, as a Beta-mode suite, and uploads its output when it fails.
- Live: one local run over the full list under Xvfb from the maintainer's network; the summary
  table goes into the PR. Then one `workflow_dispatch` run after merge to compare the hosted
  runner's bot-check rate (decision 10).

## Docs to update

- `docs/runbook.md`, "Actions minutes budget": one paragraph for `sites.yml` (≈ 15-20 min a
  night, free, never on PRs).
- `CONTRIBUTING.md`: `npm run sites` under the test commands.
- `docs/security.md`: the site workflow's issue writes and how untrusted page text is written
  into the issue (sub-PR 2).
- No guide, README or changelog change: nothing user-visible changes.

## Out of scope

- Sites behind a login (Gmail, GitHub notifications, Slack, Jira). A later spec, with a
  throwaway account and a secret, which would need its own security review.
- Crawling, or more than one page per entry (plus the one link a hint follows).
- Screenshot comparison of live sites (they change daily).
- Fixing what the suite finds: each problem becomes an issue and its own spec or bug fix.
- Running on macOS or Windows, or on Wayland.

## Implementation log (sub-PR 1)

What changed from the plan above, and why:

- **The shortcut check sends synthetic key events to the page, not keys in pass-through mode.**
  Vimma's `i` is no clean pass-through: `mode.insert` also sends `Vimma:FocusInput`, which
  focuses the page's first text field (`host/VimmaHost.sys.mjs:700-703`). On GitHub that is the
  "Go to file" box, so the "shortcut" keys were typed into it. When the page then moves focus
  itself (GitHub's file list, YouTube's consent dialog), the focus report puts the tab back in
  normal mode (`onFocusReport`, `VimmaHost.sys.mjs:1194-1202`). The keys that followed then ran
  as Vimma commands (`t` opened tabs). Synthetic `keydown`/`keypress`/`keyup` at the focused
  element never reach Vimma and trigger no Firefox default action. The cost is that sites that
  ignore untrusted events are under-reported, and this check is `info` only. After the probe,
  the page is reloaded (`r`), or `H` after a navigation, when a key opened something (MDN's `/`
  search, regex101's `?` help), so the hints check sees the page as it loaded.
- **Waiting for a load** also waits for the tab's busy state to end, after the settle delay too.
  Stack Overflow's first `complete` document was replaced by the real page while the checks
  ran.
- **Long strings.** A probe result over the DevTools server's long-string limit (Hacker News'
  hint links) comes back as a `longString` actor and is fetched with `substring`.
- **Consent text.** Google's consent dialog arrives in the IP's language ("Ennen kuin jatkat
  Googleen" from Finland), often at the end of the body. The pattern covers English, Finnish,
  German and French and searches the whole text (up to 30 000 characters). YouTube's lightbox
  is matched by its element (`ytd-consent-bump-v2-lightbox tp-yt-paper-dialog`). "Reject all"
  / "Hylkää kaikki" are clicked. In the last run the YouTube click worked.
- **Hint counts** are read once the labels stop changing (subframes answer late).

Local live run (this machine's network, the main checkout's full build, 22 entries, 8.6 min):
18 ok, 2 fail, 2 blocked (bot check). Reddit (reCAPTCHA) and Google search (`/sorry/`) were
blocked from a home IP after a few runs that day. Both loaded fine in earlier runs, so one IP's
repeated visits are enough to trigger them.

Problems found (each one becomes its own issue or spec; none is fixed here):

1. **Find leaves you in insert mode when the match is in a text field.** On YouTube and
   DuckDuckGo, `/neovim` Enter matches the query in the page's search box. Closing the find bar
   focuses the match, so the tab goes to insert mode, and `n` would type into the box.
2. **A Firefox error during a hint click on YouTube.** `PictureInPictureChild.sys.mjs:1627`
   throws `shadowRoot is null`. The stack runs through `VimmaChild.sys.mjs:428`, the synthetic
   `click()` of a hint. The follow still navigates. To check: whether a user's click does the
   same, and whether the actor should skip the synthetic mouse events on `<video>` overlays.
3. **`i` focuses the first text field** (above). That is intended, but it means Vimma has no
   pure pass-through mode for sites with their own single-key shortcuts. (Since changed: a page
   moving focus no longer ends insert entered with `i`, and `i` returns to the field last used;
   [insert-focus](insert-focus.md).) The shortcut report
   lists 15 of 22 sites where that matters, mostly `/` (13 sites) and `?` (7).
4. **Insert check skips.** GitHub PR pages, MDN, doc.rust-lang.org and Vercel docs show search
   as a button that opens a dialog, so the suite finds no field to focus, and Excalidraw has no
   text field at all. Not a Vimma problem, but insert mode goes unchecked on those five; a later
   version could open the search dialog first.

Everything else passed on every site that loaded: hints (21-150 labels; the follow navigated in
12-470 ms), `j`/`k`/`gg`/`G`/`ctrl+d`/`ctrl+u` (the main scroller everywhere except regex101, where Vimma correctly scrolled its inner app pane; CodePen and Excalidraw have nothing to scroll), `yy`, `ctrl+b`
never reaching the page (normal mode and in a field), and the status bar agreeing with the mode
after every step. Key-to-effect: `j` 7-17 ms, `f` 16-27 ms, `yy` 4-8 ms, including `vimma-ctl`'s
start.

## Implementation log (sub-PR 2)

What changed from the plan above, and why:

- **The baseline is the latest successful scheduled run on `main`**, found with `gh run list`
  while the current run is still in progress, so a run never compares with itself. A
  `workflow_dispatch` run is compared with it too, but never becomes a baseline, and a filtered
  run (its `--filter` is recorded in `results.json`) removes no site from the tracked list: the
  sites it did not visit stay tracked as not checked.
- **The open issue is looked up by the compare job** (`issues: read`), so the choice between
  create, update, close and nothing is made in tested code (`issueAction` in
  `tools/sites/diff.mjs`). The report job only carries the choice out.
- **Retried screenshots** are named `<site>.retry-<n>-<label>.png`, so the first visit's are
  kept beside them, and no site id (letters, digits and dashes) can produce the same name.
- **A broken chain never closes the issue.** A tracked regression must not vanish because one
  night could not compare: a run that stopped early (a harness error) keeps the sites it did not
  reach tracked and lists none as removed; a night whose previous `results.json` is missing
  still carries the tracked list from `diff.json` and checks it against its own results. Each
  `diff.json` records whether its chain is complete. When it is not and an issue is open, or is
  opened that night (its list may then be missing regressions), the issue is updated with a note
  and never closed automatically; closing it by hand starts the tracking afresh. A partial run
  never closes it either. A harness error fails the run, and the baseline is always the last
  successful scheduled run, so the night after one compares with the night before it and finds
  that night's regressions again.
- **A regression is measured against each check's last known result**, kept in `diff.json`
  (`known`), not only the previous night's: a check that passed, was skipped on a blocked night,
  and then fails is still a regression. A check that no longer exists drops out of the list.
- **The diff runs in a job of its own** (`compare`), on a fresh runner, from the browser job's
  `results.json` alone, so code that escaped the browser onto that runner could not rewrite the
  issue text or the environment of the step that writes it. The suite's step also turns workflow
  commands off (`::stop-commands::`) while it logs page text.
- The tests compare three recorded nightly runs (2026-10-19 to 2026-10-21, 22 entries each).
  They show the case the tracking is built for: insert mode and the status bar fail every night
  on YouTube, Google search, DuckDuckGo and regex101 (focusing the search field does not give
  insert mode), so those failures predate the comparison and open no issue; they are listed in
  each night's report.

## Implementation log (sub-PR 3)

What changed from the plan above, and why:

- **Four snapshots:** Wikipedia, MDN, docs.python.org and doc.rust-lang.org, the four pages on
  the list whose licence allows a copy (`SNAPSHOT_LICENCES` in `tools/sites/snapshot.mjs`;
  `--record` refuses any other id). No hand-written fixture yet: none of the live run's findings
  so far is a structure the four lack.
- **Every link leads to `followed.html`**, a page next to the snapshots, and fragment links
  stay. A link to the live site would make the hints check leave the machine; one to a missing
  page would depend on how the browser shows a 404.
- **Nothing in a snapshot can run or load, three times over.** The recorder removes scripts,
  handlers, frames, media and URL attributes and replaces `url()` in styles; every snapshot
  starts with a Content-Security-Policy (`default-src 'none'`, inline styles only) that blocks
  whatever it missed; and the offline profile sends every host but 127.0.0.1 to a proxy port
  where nothing listens. `verifySnapshot` checks the first two on every committed file. The
  DevTools server's evaluations, which the checks read the page with, are not subject to the
  page's policy.
- **Stylesheets are pruned** to the rules whose selector, without pseudo-classes, matches
  something on the page, and `@font-face` rules are dropped (fonts are not loaded). That keeps
  the four files at 0.2 to 0.8 MB.
- **The expected results are written by hand** in `snapshots.json` from the first offline run,
  not by the recorder, so a change to them is a reviewed line. Insert is `skip` on MDN and
  doc.rust-lang.org, as in the live run: their search is a button.
- **Recording from a saved copy** (`--record <id>=<url>`). The four were recorded from a local
  copy of each page and its stylesheets, each fetched once, so recording put no extra visits
  from a developer's network on the live sites. The copies served no scripts, which the
  snapshot drops anyway.
- **In e2e.yml** after the scenarios, as a Beta-mode suite (`sites-offline` in
  `suite-results.mjs`): about 25 s for the four on a local machine. Screenshots are not
  compared, as planned; they are uploaded with the report when the gate fails.
