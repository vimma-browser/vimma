# Spec: tab-sleep

Status: draft · Area: core (`packages/vimma-core/src/workspaces/tabsleep.mjs` (new),
`packages/vimma-core/src/config/config.mjs`, `packages/vimma-core/defaults.toml`,
`packages/vimma-core/src/keys/actions.mjs`, `packages/vimma-core/src/keys/cmdline.mjs`,
`packages/vimma-core/src/ui/tabline.mjs`, `packages/vimma-core/src/ui/sidepanel.mjs`), chrome
(`services/TabSleep.sys.mjs` (new), `split/PaneView.mjs`, `ctl/VimmaControl.sys.mjs`,
`config/ConfigHost.sys.mjs`), theme (`src/browser/themes/shared/vimma/tabline.css`,
`side-panel.css`), prefs (`src/browser/branding/vimma/pref/firefox-branding.js`) · Upstream
patches: none · ADR: none

Issue: [#1404](https://github.com/vimma-browser/vimma/issues/1404)

## Summary

A tab nobody has looked at for two hours goes to sleep: Firefox unloads its page, the tab stays
in its workspace, the tab line and the side panel with its title, and selecting it loads the page
again where it was. The time is `[tabs] sleep_after` in `config.toml`, a site can be kept awake
with `[sites."<host>"] sleep = false`, and `:sleep` puts tabs to sleep at once. Tabs on screen,
tabs playing sound or sharing a camera, microphone or screen, pinned tabs, private tabs and the
agent workspace's tabs while an agent is connected never sleep on their own.

## Problem

Firefox restores a session lazily: after a restart only the selected tab of each window loads,
and the others load when they are selected (`browser.sessionstore.restore_on_demand`). Nothing
unloads a tab after that. A user who works through a hundred tabs in a day, spread over several
workspaces and splits, ends the day with a hundred loaded pages, each holding memory and, for
pages with timers or open connections, processor time. Most of them are in workspaces the user
has not opened for hours, which are hidden and invisible in the tab line.

Firefox's own answer, the low-memory tab unloader, does not help on Linux: it is off there by
default (Research), and when it is on it waits until the machine is nearly out of memory, unloads
one tab at a time and knows nothing about Vimma's panes or agent workspace.

## Behaviour

Terms: a tab is **asleep** when it has no loaded page (Firefox's lazy tab: it has no browser, or
its browser is pending). A tab is **on screen** when it is the selected tab of a window, or a pane
of the split a window currently shows (zoomed-away panes included). A tab was **last seen** when
it was last selected, or at the last check that found it on screen, whichever is later.

### Sleeping on its own

1. Every 5 minutes Vimma checks every tab of every normal window. A tab **must** be put to sleep
   when it was last seen more than `[tabs] sleep_after` minutes ago (default 120) and none of the
   rules in behaviour 2 keeps it awake.
2. A tab **must not** be put to sleep on its own while any of these holds:
   - it is on screen;
   - it is pinned;
   - it plays sound, is shown in Picture-in-Picture, or uses the camera, microphone or screen
     sharing, or holds an open WebRTC connection;
   - it is in a private window (the private workspace);
   - it is in the agent workspace and an agent is connected (`:mcp` shows the connection);
   - its page is not a web page: only `http:`, `https:` and `file:` pages sleep, so `about:`
     pages (setup, `about:vimma`, Settings, the start page) and Firefox's own pages stay;
   - its site has `sleep = false` (behaviour 6);
   - it is loading;
   - its page would ask before leaving (a `beforeunload` handler, typically unsaved changes), or
     a dialog is open over it; the page is not asked, and nothing is shown.
3. `sleep_after = 0` turns sleeping on its own off: no check runs. Tabs already asleep stay
   asleep until selected.
4. A tab opened in the background counts as seen when it opens, so a link opened in a new tab and
   left there sleeps `sleep_after` minutes later, not at the next check.
5. A change to `[tabs]` or `[sites]` applies at the next check after the config is read (on its
   own poll or `:source`); it never wakes a tab.

### Per site

6. `[sites."<host>"] sleep = false` keeps every tab whose page is on that host, or a subdomain of
   it, awake. The most specific table wins, as for `insert` and `unbind`. `sleep = true` is the
   default and may be written to override a parent domain's `false`.

### Waking

7. A sleeping tab wakes when it is selected (any key, the side panel, the tab line, tab search,
   a workspace switch that lands on it), when a split that holds it is shown, or when an agent
   lists or reads it (agent workspace only). It loads its page from its session history: the
   same URL, back and forward history, scroll position and the text typed into form fields
   (Research, "What a discard keeps").
8. Listing tabs never wakes them: the tab line, the side panel, tab search, `vimma-ctl state`
   and `:ls` show a sleeping tab without loading it.

### By hand

9. `:sleep` puts to sleep the current workspace's tabs that behaviour 2 allows, regardless of
   time. It reports `N tabs asleep` and, when some stayed awake, how many and the most common
   reason (`3 stay awake: on screen`).
10. `:sleep all` does the same for every workspace of every normal window.
11. `:sleep N` puts tab N of the current workspace to sleep (the number `alt+N` and `{N}gt`
    use). Because the user named the tab, its pin and its site's `sleep = false` do not keep it
    awake; the other rules of behaviour 2 do, and the message says which
    (`Tab 4 stays awake: it is playing sound`). `:sleep` on the tab that is on screen says
    `Tab 2 is on screen` and does nothing.
12. The action `tab.sleep` (config name `sleep_tabs`) runs `:sleep` and has no default key. In
    the side panel, `panel.sleep` puts the highlighted tab, or the marked tabs, to sleep as
    `:sleep N` does for each (default key: Open questions, 3).
13. In a private window, `:sleep` says `Private tabs do not sleep` and does nothing.

### Showing it

14. In the tab line and the side panel, a sleeping tab's row **must** be drawn in the theme's
    muted colour (`--vimma-muted`), with nothing else changed, so the layout does not move when a
    tab wakes. The row's accessible description says `asleep`, so the state is not shown by
    colour alone. This holds for every tab without a loaded page, including tabs a restart left
    lazy.
15. `vimma-ctl state` lists `asleep: true` for each sleeping tab, and leaves the field out for
    others. Its `id` already changes while a tab is asleep (Research, Vimma); this spec does not
    change that.

### Firefox's low-memory unloading

16. Low-memory unloading is decided in Open questions, 2. If it is turned on, Firefox's unloader
    **must not** unload a tab that behaviour 2 keeps awake for being on screen or in the agent
    workspace while an agent is connected.

## Research

Firefox paths are in Vimma's engine tree at Firefox 160.0.1 (`surfer.json`,
`engine/config/milestone.txt`).

### Discarding a tab

- **`gBrowser.discardBrowser(tab, force)`**
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:3542-3622`) is Firefox's unload. It refuses
  (`#mayDiscardBrowser`, lines 3500-3526) a selected, closing or already lazy tab, a tab in a
  closing window, a tab whose browser is not remote (a page in the parent process, such as
  `about:preferences` or `about:vimma`), and a tab whose page refuses
  `browser.permitUnload(action)`. Without `force`, the action is `"dontUnload"`, and an open tab
  dialog also refuses (lines 3516-3521).
- **`beforeunload`.** `permitUnload` returns `permitUnload: true` at once when no frame of the
  page has a `beforeunload` handler (`toolkit/content/widgets/browser-custom-element.mjs:1788-1792`,
  the `hasBeforeUnload` getter at 1768). With `"dontUnload"`, a page whose handler asks to
  prompt gets no prompt and the unload is refused (`docshell/base/nsIDocumentViewer.idl:65-67`).
  A handler's request counts only after the user has interacted with the page
  (`dom.require_user_interaction_for_beforeunload`, true,
  `modules/libpref/init/StaticPrefList.yaml:2849-2852`), so this is the page saying it has
  unsaved input. Vimma can therefore detect "unsaved" only for pages that register a
  `beforeunload` handler, which is what web editors do.
- **What `discardBrowser` does** (lines 3542-3622): it resets sharing state and forgets WebRTC
  streams, aborts tab dialogs, calls `SessionStore.resetBrowserToLazyState`, sets the
  `discarded` attribute only when forced (lines 3567-3571), closes the tab's find bar, removes
  the `soundplaying`, `busy` and progress attributes, destroys the browser (line 3609), creates a
  lazy browser in its place (line 3615) and fires `TabBrowserDiscarded` on the tab (line 3619).
  There is no `browser-discarded` observer topic in Firefox 160; the event is the signal.
- **`prepareDiscardBrowser(tab)`** (lines 3528-3540) flushes the tab's session state first, so
  the restore has the latest scroll and form data. Firefox's unloader calls it before
  `discardBrowser` (`TabUnloader.sys.mjs:335-336`); Vimma does the same.
- **Firefox's "Unload Tab"** (`explicitUnloadTabs`, lines 7124-7190) runs `beforeunload` with a
  prompt first, selects another tab when the selected one, or a tab of the shown split view, is
  unloaded, and then discards with `force`.
- **What a discard keeps.** SessionStore keeps the tab's session history entries
  (`browser/components/sessionstore/SessionStore.sys.mjs:3307-3360`, `resetBrowserToLazyState`),
  and its cached state includes `scroll` and `formdata`
  (`browser/components/sessionstore/TabState.sys.mjs:52-54`). Form data covers text fields,
  text areas, checkboxes, radio buttons and selects, but not password, hidden or
  `autocomplete="off"` fields (`toolkit/components/sessionstore/SessionStoreUtils.cpp:545-567`),
  and no `contenteditable` content (none is collected in that file, checked by search). What
  the page held only in script (an unsent chat message in an editor that does not use a form
  field, a paused video's position, an open WebSocket) is lost; the page starts again from its
  URL.
- **A woken tab has a new browser id.** The lazy browser is replaced by a new one when the tab
  is inserted again, and a new top-level browsing context gets a new `browserId`
  (`docshell/base/BrowsingContext.cpp:489`). Checked by reading, not by a test.

### When a tab was last used

- `tab.lastAccessed` is set when the tab element is created (`content/tab.mjs:172-173`) and when
  the selection changes, for the old and the new tab (`Tabbrowser.sys.mjs:2079-2081`). The
  selected tab of every window reports the current time (`content/tab.mjs:369-371` and 479-481:
  it stores `Infinity`). Nothing else updates it.
- A pane of a split that is on screen but not focused is not the selected tab, so its
  `lastAccessed` stays at the moment focus left it, however long it stays on screen. Hidden
  tabs in other workspaces and hidden splits keep the time they were last selected.
- SessionStore saves `lastAccessed` with the tab, so a restored tab keeps its time.

### Firefox's low-memory unloader

- `TabUnloader` (`browser/components/tabbrowser/TabUnloader.sys.mjs`) is registered at idle
  startup (`browser/components/BrowserComponents.manifest:204`). It never unloads a tab that is
  selected or has the `undiscardable` attribute (lines 53-59; `content/tab.mjs:315-325`), plays
  sound, is in Picture-in-Picture, uses WebRTC streams or peer connections, or is private
  (lines 32-40, 69-96). A pinned tab only weighs more (line 38). Tabs used in the last
  `browser.tabs.min_inactive_duration_before_unload` milliseconds (600000, 10 minutes,
  `browser/app/profile/firefox.js:1226`) are skipped (lines 249-255). It unloads one tab per
  low-memory signal, without `force` (line 336), and only when `browser.tabs.unloadOnLowMemory`
  is true (line 184). It does not know about panes: a non-selected pane on screen can be
  unloaded.
- `browser.tabs.unloadOnLowMemory` is true on macOS and Windows and false elsewhere
  (`firefox.js:1218-1222`). The pref is the only thing missing on Linux: low-memory detection
  exists there. `xpcom/base/AvailableMemoryWatcherLinux.cpp` polls `/proc/meminfo` every 5
  seconds (every second while memory is low, lines 165 and 169), counts memory as low when
  `MemAvailable` is at most 5 % of `MemTotal` or under 200 MB (lines 285-302;
  `browser.low_commit_space_threshold_percent` and `_mb`, `StaticPrefList.yaml:1832-1845`), then
  asks the unloader for one tab (line 381). It stops polling while the user is inactive (lines
  503-507). No reason for the Linux default was found in the source.

### Vimma

- **Panes.** `split/PaneView.mjs` listens for `TabBrowserDiscarded` (lines 300-304). When a tab
  of the split on screen is discarded, it gives the tab a browser back at once
  (`#onBrowserDiscarded`, lines 1208-1215, through `#asCurrent` and `#wake`, lines 1172-1181 and
  1226), so discarding a pane on screen only reloads it. A hidden split keeps its discarded tabs
  lazy, named by their workspace uuid, until it shows (issues #1318, #1332).
- **PaneView's other "asleep".** `#asleep` and `#keepAsleep` (lines 1460-1479) deactivate the
  docshell of zoomed-away and hidden panes, which stops their rendering but keeps them loaded.
  That is a different state from this spec's sleep.
- **Agents.** Agent tools name a tab by its `browserId` (`ctl/agent-tabs.mjs:136`). Listing
  agent tabs with names gives a lazy tab a browser, and a read loads it in the background
  ([vimma-mcp](vimma-mcp.md), B2; `ctl/agent-tabs.mjs:124-133`). `AgentGate.connections`
  (`host/AgentGate.sys.mjs:575`) lists the open agent connections.
- **`vimma-ctl state`** names a lazy tab by its workspace uuid until it loads
  (`ctl/VimmaControl.sys.mjs:469`, `stateTabId`) and reports it `loading: false` without
  touching its browser (line 484, `tabLoading`).
- **Config.** `[sites."<host>"]` accepts `insert` and `unbind` today (`config/config.mjs:239`,
  `SITE_KEYS`, validated at 746-775) and is matched with `matchSiteRule`
  (`keys/editable.mjs:292`): a host covers its subdomains and the most specific table wins.
  There is no `[tabs]` table. `ConfigHost` re-reads the file on a poll and on `:source`
  ([m5-config-load](m5-config-load.md)).
- **Workspaces.** [m3-workspaces](m3-workspaces.md) (Research, "Memory") left unloading hidden
  tabs to a later spec; this is that spec.

## Design

1. **Sleep is Firefox's discard, not a new state.** Vimma calls `prepareDiscardBrowser` and then
   `discardBrowser(tab, false)`, because that is the unload Firefox's own unloader, session
   restore and the tab strip already handle: the tab keeps its place, title, icon and history,
   and selecting it restores it. Rejected: closing the tab and keeping a placeholder, because it
   loses back and forward history and breaks every place that holds the tab (workspaces, panes,
   agent ownership).
2. **One check every 5 minutes, not a timer per tab.** A single interval in
   `services/TabSleep.sys.mjs` walks every tab, so that the cost is one pass over a few hundred
   tabs every 5 minutes and nothing has to be rescheduled when a tab is selected. A tab sleeps
   between `sleep_after` and `sleep_after` + 5 minutes after it was last seen, which is precise
   enough for a limit counted in hours. Rejected: a timer per tab, because each selection would
   cancel and restart one, and a hundred timers do the same work as one pass.
3. **The decision is a pure function in core.** `planSleep({ now, sleepAfterMs, tabs, sites })`
   in `packages/vimma-core/src/workspaces/tabsleep.mjs` takes plain facts per tab (last seen, on
   screen, pinned, sound, Picture-in-Picture, sharing, private, agent tab, agent connected, URL,
   loading, asleep) and returns the tabs to put to sleep and, for each kept tab, the first rule
   that keeps it. The host gathers the facts and calls Firefox, so that every rule is tested
   with vitest, and `:sleep` and the automatic check use the same rules.
4. **"Last seen" is `lastAccessed`, or the last check that found the tab on screen.** The host
   keeps a `WeakMap` from tab to the time of the last check that found it on screen, and a tab's
   last seen is the later of that and `tab.lastAccessed`, because `lastAccessed` changes only on
   selection (Research): a pane watched for three hours without focus would otherwise sleep at
   the first check after the user leaves its split. The map is not saved; after a restart only
   loaded tabs can sleep, and those were selected or shown after the restart.
5. **Every pane of the current split stays awake, zoomed-away panes included.** A tab of the
   split a window currently shows is skipped, whether or not the window is visible, because
   PaneView gives such a tab its browser back as soon as it is discarded (Research), which
   would turn a sleep into a reload. Hidden splits and other workspaces sleep like any other
   tab; PaneView already keeps their discarded tabs lazy until they show.
6. **Firefox's protections, kept and extended.** Sound, Picture-in-Picture, WebRTC streams or
   peer connections and private windows keep a tab awake, as they do for Firefox's unloader
   (`TabUnloader.sys.mjs:32-40`), because unloading them stops something the user is using.
   Vimma reads the same signals (`tab.soundPlaying`, `tab.pictureinpicture`,
   `webrtcUI.browserHasStreams`, `hasActivePeerConnections`) instead of importing Firefox's
   method table, which the module does not export. Pinned tabs never sleep on their own,
   because a pinned tab is a page kept open on purpose, usually mail or chat that should keep
   notifying (Open questions, 4).
7. **Private tabs never sleep.** The private workspace follows Firefox's unloader, which never
   unloads a private tab (`TabUnloader.sys.mjs:39`), so that a private page is never reloaded
   behind the user's back, and because the private workspace is meant to be short-lived.
   Rejected: sleeping them too, because the gain is small and a private page that has to be
   reloaded may need its login again.
8. **The agent workspace stays awake while an agent is connected.** While
   `AgentGate.connections` is not empty, the agent workspace's tabs are skipped, because agents
   name tabs by browser id and a woken tab gets a new one (Research): a tab put to sleep between
   two calls would vanish from the agent's view. With no agent connected they sleep like other
   tabs, and the next agent lists them with fresh ids ([vimma-mcp](vimma-mcp.md), B2). Rejected:
   protecting only while a request runs, because ids must stay valid between requests of one
   session.
9. **Only web pages sleep.** A tab sleeps only when its URL is `http:`, `https:` or `file:`,
   because the `about:` pages are Firefox's and Vimma's own UI: most of them run in the parent
   process, which `discardBrowser` refuses anyway (Research), and the others (the start page, a
   reader view) cost little and keep state that is not in session history, such as a setup step
   in progress. PDFs opened from the web are `http:` or `https:` and sleep.
10. **Pages that would ask stay awake, without asking.** The discard is not forced, so a page
    whose `beforeunload` handler would prompt, or that has a dialog open, keeps its tab awake
    and nothing is shown (Research, "`beforeunload`"). This is the only signal of unsaved work a
    browser has; a page without the handler keeps the text of its form fields through session
    restore, and loses what it held only in script. Rejected: forcing the discard after a
    prompt, as Firefox's "Unload Tab" does, because a prompt from a tab the user is not looking
    at, at an arbitrary time, is worse than keeping the tab loaded.
11. **The time is in minutes, generous by default.** `[tabs] sleep_after` is an integer number of
    minutes, `0` (off) or 5 to 10080 (a week), default `120`, because most tabs a user comes
    back to are reopened within the hour, while a tab unseen for two hours has usually been left.
    A limit under 5 minutes would make tabs sleep between two checks of one task. Rejected:
    seconds, because no useful value needs them; a boolean plus a fixed time, because how much
    to keep loaded depends on the machine.
12. **The site rule is a boolean.** `[sites."<host>"] sleep = false` keeps a site awake, because
    the need is "this site must keep running" (a chat, a dashboard, a music player between
    tracks). A per-site number of minutes was rejected, because nothing asks for it and it can be
    added later without breaking `false`.
13. **Changes apply at the next check and wake nothing.** `TabSleep` reads `sleep_after` and the
    site rules from the config in force at each check, so a reload needs no extra code; setting
    `0` stops the interval and setting a value starts it. No tab is woken by a config change,
    because waking means loading pages the user did not ask for.
14. **`:sleep` uses the same rules, without the time.** `:sleep`, `:sleep all` and `:sleep N`
    call `planSleep` with the time rule off, so that by hand and on its own never disagree about
    what is safe. A tab named by number ignores its pin and its site rule, because the user
    asked for that tab; it still respects on screen, sound, sharing, private, agent and
    `beforeunload`, because those protect something the user may not have in mind. The current
    tab is refused rather than switched away from, because `:sleep` should never move the user.
    The name follows the issue's wording and Vimma's "asleep"; Vim's `:sleep` (wait N seconds)
    has no use in a browser. Rejected: `:unload` and `:discard`, because the guide calls the
    state "asleep" and one word should name it.
15. **No default key in normal mode.** `tab.sleep` has a config name and no key, because putting
    tabs to sleep by hand is occasional and every free prefix key is worth more elsewhere; the
    side panel, where the user already picks tabs, gets one (Open questions, 3).
16. **Asleep means "no loaded page", whoever unloaded it.** The tab line, the side panel and
    `vimma-ctl state` show every lazy tab as asleep, whether a restart, Vimma or Firefox's
    unloader left it so, because for the user they are the same: no memory used, a reload on
    select. Firefox's `discarded` attribute is not used, because it is set only by a forced
    discard (Research).
17. **Muted colour, no icon.** A sleeping row keeps its text and width and only takes
    `--vimma-muted`, so that the line does not reflow when a tab wakes and the look follows the
    theme, as every other Vimma surface does. The accessible description carries the state for
    screen readers (WCAG 1.4.1, [m7-a11y](m7-a11y.md)). Rejected: a `z` marker, because it
    takes a column from every title in the narrow tab line.
18. **`state` gains `asleep`, without a version bump.** `vimma-ctl state` adds `asleep: true` to a
    sleeping tab, read without touching the browser as `loading` is, because clients ignore
    fields they do not know, as for `loading` and `panes`
    ([m0-control-protocol-and-vimma-ctl](m0-control-protocol-and-vimma-ctl.md), "state"). No
    control command puts a tab to sleep; a script uses `vimma-ctl send-keys ':sleep 3<CR>'`.
19. **One word, one meaning.** PaneView's `#asleep` and `#keepAsleep`, which only deactivate a
    docshell, are renamed `#deactivate` and `#keepInactive` in the first slice, so that "asleep"
    in the code means what it means in the guide.
20. **Behind a feature pref until the last slice.** `vimma.feature.tabSleep` (default `false`)
    gates the check, `:sleep` and the panel key, because the feature lands over several pull
    requests and `main` must stay releasable (`CONTRIBUTING.md`, "Unfinished features"). The
    tests set it, and set `vimma.tabs.sleepCheckMs` (default 300000) to run checks in
    milliseconds; the host also exposes `TabSleep._check(now)` so a test can move the clock.

## Security and privacy

No new surface beyond the agent workspace. Sleeping only unloads pages the user opened, through
Firefox's own discard, and never sends anything anywhere; waking loads the same URL the tab
already showed. The rules come from the user's own `config.toml`.

- **Agent tabs.** Decision 8 keeps agent tabs awake while an agent is connected, so an agent
  never loses a tab id in the middle of a session. Waking an agent tab is done only by the agent
  tools that already wake lazy tabs, after the user's answer ([vimma-mcp](vimma-mcp.md), B2).
- **Private windows.** Private tabs never sleep (decision 7), and `state.tabs[].asleep` names no
  page, so a private window gains nothing a script could read about its pages.
- **Unsaved input.** A page that registers `beforeunload` is never unloaded (decision 10). Form
  text kept for restore is SessionStore's existing, unchanged behaviour, with passwords left
  out by Firefox.

## Tests

vitest, `packages/vimma-core/test/tabsleep.test.ts` (`planSleep`):

- `a tab unseen longer than sleep_after sleeps; one seen within it stays`
- `sleep_after 0 plans nothing`
- `last seen is the later of lastAccessed and the last on-screen check`
- `on screen, pinned, sound, picture-in-picture, sharing, private and loading keep a tab awake`
- `agent workspace tabs stay awake only while an agent is connected`
- `only http, https and file pages sleep`
- `a site with sleep = false stays awake, its subdomains too; the most specific table wins`
- `a tab already asleep is not planned again`
- `by hand: the time rule is off`
- `by number: pin and site rule are ignored; on screen, sound, sharing, private and agent are not`
- `each kept tab reports the first rule that keeps it`

vitest, `packages/vimma-core/test/config.test.ts`:

- `[tabs] sleep_after accepts 0 and 5 to 10080, and rejects other numbers and types`
- `[sites."<host>"] sleep accepts a boolean and rejects other types`
- `defaults.toml sets [tabs] sleep_after = 120`

vitest, `packages/vimma-core/test/cmdline.test.ts`:

- `:sleep, :sleep all and :sleep N parse to tab.sleep with their scope`
- `:sleep with any other argument is an error that names the forms`

vitest, `packages/vimma-core/test/tabline.test.ts` and `sidepanel.test.ts`:

- `a sleeping tab's item is marked asleep and keeps its width`

mochitest, `tests/browser/browser_vimma_tab_sleep.js` (feature pref on, `TabSleep._check(now)`
with a clock moved past `sleep_after`, `fixture:` pages served by the test server):

- `a background tab unseen past sleep_after is discarded and keeps its history and scroll`
- `selecting a sleeping tab restores its page, scroll position and typed field text`
- `the selected tab and every pane of the shown split stay loaded, zoomed-away panes included`
- `a pane watched without focus does not sleep at the first check after its split is hidden`
- `a hidden split's tabs sleep and wake when the split is shown`
- `a pinned tab, a tab playing sound and a private window's tabs stay loaded`
- `a page with a beforeunload handler and user input stays loaded, and no prompt is shown`
- `an about: page stays loaded`
- `[sites."<host>"] sleep = false keeps that host's tab loaded`
- `sleep_after = 0 stops the check; a new value starts it at the next config read`
- `a download started from a tab continues while the tab sleeps`
- `the interval set by vimma.tabs.sleepCheckMs runs a check`

mochitest, `tests/browser/browser_vimma_tab_sleep_command.js`:

- `:sleep puts the workspace's other tabs to sleep and reports the count and a reason`
- `:sleep all reaches every workspace of every window`
- `:sleep N sleeps a pinned tab; :sleep on the tab on screen refuses`
- `panel.sleep sleeps the marked tabs`
- `:sleep in a private window says private tabs do not sleep`

mochitest, `tests/browser/browser_vimma_agent_tab_sleep.js`:

- `agent workspace tabs stay loaded while an agent is connected, and sleep after it leaves`
- `an agent listing a sleeping agent tab wakes it with a new id`

mochitest, `tests/browser/browser_vimma_control_state_read.js` and the contract fixtures in
`tests/contract/control/v1/`:

- `state lists asleep: true for a sleeping tab and does not load it`

e2e, `tests/e2e/scenarios/issue-1404-tab-sleep.json`: the tab line (`[ui] tabline = "always"`)
and the side panel with one sleeping and two loaded tabs, in the Vimma theme and an Omarchy
theme; baselines in `tests/e2e/baselines/`.

If low-memory unloading is turned on (Open questions, 2), mochitest
`browser_vimma_low_memory.js` uses `nsIAvailableMemoryWatcherTestingLinux`
(`xpcom/base/nsIAvailableMemoryWatcherTestingLinux.idl`) to signal low memory and checks that a
pane on screen and a connected agent's tab are not unloaded.

## Docs and changelog

The implementing pull requests add:

- `docs/guide.md`: a "Sleeping tabs" section under the tabs chapter (what sleeps, what never
  does, what is kept and lost, `[tabs] sleep_after`, `sleep = false` per site, `:sleep` and its
  forms, the muted rows); `:sleep` in the command table; `sleep` in the `[sites]` key list; the
  `asleep` field in the `vimma-ctl state` section.
- `packages/vimma-core/defaults.toml`: a commented `[tabs]` table with `sleep_after = 120`, and
  `sleep = false` in the commented `[sites]` example.
- `docs/bindings.md` and `docs/bindings.json` (generated): `sleep_tabs` and `panel.sleep`.
- [vimma-mcp](vimma-mcp.md) B2 and [m3-workspaces](m3-workspaces.md) "Memory": a "Since changed"
  note pointing here.
- Changelog, from the last slice's commit subject: "feat(tabs): put tabs to sleep after two hours
  unseen".

## Delivery

Slices 1 to 3 merge when green and verified, behind `vimma.feature.tabSleep`. Slice 4 turns the
feature on for every user and stops at ready for the maintainer, with notes on how to try it.

1. **Core rules and the check.** `planSleep`, `[tabs] sleep_after` and `[sites] sleep` in the
   config validator and `defaults.toml` (commented), `services/TabSleep.sys.mjs` with the
   interval, the last-seen map and the protections, the PaneView rename (decision 19), the test
   prefs and `browser_vimma_tab_sleep.js` and `browser_vimma_agent_tab_sleep.js`.
2. **By hand.** `:sleep` and its forms, `tab.sleep`, `panel.sleep` and its key if one is chosen,
   the messages, `browser_vimma_tab_sleep_command.js`.
3. **Showing it.** The muted rows in the tab line and the side panel with their accessible
   description, `state.tabs[].asleep` with its contract fixture, the e2e scenario and baselines.
4. **Turn it on.** Remove `vimma.feature.tabSleep`, uncomment `[tabs] sleep_after = 120` in
   `defaults.toml`, the guide section, the "Since changed" notes, status `implemented`.
5. **Low-memory unloading**, only if Open questions, 2 says yes: `browser.tabs.unloadOnLowMemory`
   in `firefox-branding.js` on Linux, `undiscardable` kept on the tabs decision 5 and 8 protect,
   its mochitest. It can merge before or after slice 4.

## Open questions

1. **Default time.** Options: 60, 120 or 240 minutes. A shorter time frees more memory and
   reloads more tabs the user comes back to. Recommendation: 120, generous enough that a tab
   left for a meeting is still loaded afterwards.
2. **Firefox's low-memory unloading on Linux.** Options: leave it off, as Firefox does; or turn
   it on (slice 5), with Vimma setting `undiscardable` on panes on screen and on the agent
   workspace's tabs while an agent is connected, and a `[tabs] sleep_on_low_memory = true` key
   to turn it off. It unloads one tab per signal when under 5 % or 200 MB of memory is
   available, which helps a machine about to swap, but it is a second unloader to keep in step
   with the rules here. Recommendation: turn it on, in slice 5.
3. **A key in the side panel.** Options: none (`:sleep N` only); `z` for `panel.sleep`, free in
   `[modal.panel]`. Recommendation: `z`, because the side panel is where several tabs are marked
   at once.
4. **Pinned tabs.** Options: never sleep on their own (decision 6); or sleep like other tabs,
   with `sleep = false` per site for the ones that must stay. Recommendation: never, because a
   pinned tab is the user's way of saying "keep this".
