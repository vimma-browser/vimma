# Spec: close-last-tab

Status: accepted · Area: core (`packages/vimma-core/src/config/config.mjs`,
`packages/vimma-core/src/config/defaults.mjs`, `packages/vimma-core/defaults.toml`, a new
`packages/vimma-core/src/workspaces/closelast.mjs`), chrome (`host/tab-ops.mjs`,
`host/pane-ops.mjs`, `host/browser-ops.mjs`) · Upstream patches: none · ADR: none

Issue: [#1428](https://github.com/vimma-browser/vimma/issues/1428)

## Summary

A new `config.toml` setting, `[tabs] close_last`, decides what closing the last tab of a window
does. By default (`"picker"`) the workspace picker opens and lists the workspaces that still have
tabs, so the user goes on where their other work is; when no other tab is open anywhere, Vimma
quits, as `:q` on Vim's last window does and as closing tmux's last pane ends its session. The other
values keep today's new tab (`"new_tab"`), quit after a y/N question when other workspaces still
hold tabs (`"ask"`), quit (`"quit"`), or refuse the close (`"keep"`). With several windows a value
that would quit closes only that window, and Vimma quits only from the last one. Quitting goes
through Firefox's own quit, so every other workspace's tabs come back at the next start.

## Problem

Vimma sets `browser.tabs.closeWindowWithLastTab` to `false`, so that closing the last tab of a
workspace never closes a window that holds other workspaces' hidden tabs
([m3-workspaces](m3-workspaces.md) decision 9). Firefox then opens a new tab in place of the
closed one. A user who has closed every tab and keeps pressing `x` gets a fresh new-tab page each
time and has to reach for `ctrl+q`, which asks a second question. In Vim, `:q` on the last window
quits; Vimma's `:q` closes the pane, then the tab, and then nothing happens.

Turning Firefox's pref back on does not help: Firefox counts only the shown workspace's tabs
(Research), so the window closes with every other workspace's tabs in it, and its close path
also marks the window so that the next start leaves those tabs out.

## Behaviour

Terms used below:

- The **last tab of a window** is a tab whose close leaves no other open, unhidden tab in its
  window: the only tab of the shown workspace, with no pinned tab beside it. It is the same test
  Firefox applies (`#isLastTabInWindow`, Research). A split always holds two or more tabs, so
  closing one of its panes never closes the last tab; closing the last pane of a split's last
  tab does.
- **The window's other tabs** are the open tabs of the window's other workspaces (the agent
  workspace included) and, in the last normal window only, the tabs of the private workspace
  when it is open: only a quit discards them, and closing any other window leaves the private
  workspace as it is.
- **Other tabs** are the window's other tabs and the tabs of every other normal window.
- A **normal window** is any window but the private workspace's. The **last normal window** is
  the only normal window open.
- A **user close** is one of the closing actions a key runs, typed or sent with the full role's
  `vimma-ctl send-keys`, which already acts as the user's keyboard
  ([control socket](../security/01-control-socket.md)): `tab.close` (`x`,
  `ctrl+b shift+x`, `ctrl+f4`), `pane.close` (`ctrl+b x`, `:q`) on a tab with one pane,
  `panel.close_tab` (`x` in the side panel) and `panel.close_active_tab`.

1. `[tabs] close_last` takes `"picker"` (the default), `"new_tab"`, `"ask"`, `"quit"` or
   `"keep"`. Any other value is a config error, reported as for any other key, and the default
   applies. A change applies from the next close after the file is read (`:source`), with no
   restart.
2. With `"new_tab"`, a user close of the last tab of a window does what it does today: the tab
   closes and Firefox opens a new tab in the same workspace.
3. With `"picker"`, when the window has other tabs, a user close of its last tab **must** close
   the tab, open a new tab in its place as `"new_tab"` does, and open the workspace picker over
   it, headed `last tab closed`. The picker lists only the window's other workspaces that have
   tabs, each with its number, name and tab count as under `ctrl+b w`, the first one selected,
   then the private workspace when it is among the window's other tabs, then a last row,
   `quit Vimma` (`close this window` when another normal window is open).
   - `Enter` on a workspace switches to it and closes the new tab, so the closed tab's workspace
     is left with no tabs; going back to it later opens its start page, as for any empty
     workspace.
   - `Enter` on the private workspace switches to it and leaves the new tab in the normal
     window, because the private workspace is a window of its own, so closing the new tab would
     close the normal window's last tab again.
   - `Enter` on `quit Vimma` quits without another question, unless private tabs are open: then
     it asks the private part of behaviour 5's question,
     `quit Vimma? 2 private tabs are discarded y/N`. `Enter` on `close this window` closes the
     window (behaviour 8).
   - `Esc` or `q`, or the picker closing any other way, **must** leave the new tab in the
     workspace and **must not** quit Vimma or close the window. Closing that new tab again opens
     the picker again.
   - `m` is not offered, because the only tab in the workspace is the new tab.
4. With `"picker"`, when the window has no other tabs, a user close of its last tab **must**
   close the tab and quit Vimma without a question in the last normal window, and close only the
   window in any other.
5. With `"ask"`, in the last normal window, a user close of its last tab **must** close the tab
   and quit Vimma without a question when there are no other tabs. When there are, it **must**
   close the tab and then ask on the command line
   `quit Vimma? 14 tabs in 3 other workspaces come back at the next start y/N`. `y` quits; `n`,
   `esc` or any other key does what `"new_tab"` does. When private tabs are open, the question
   says so: `… 2 private tabs are discarded y/N`. In any other normal window it closes only the
   window: without a question when the window has no other tabs, and otherwise after
   `close this window? 14 tabs in 3 other workspaces go to the recently closed windows y/N`;
   `y` closes the window, and any other key does what `"new_tab"` does.
6. With `"quit"`, a user close of the last tab of the last normal window **must** close the tab
   and quit Vimma without a question, unless private tabs are open: then it asks the question of
   behaviour 5. In any other normal window it closes the window without a question.
7. With `"keep"`, a user close of the last tab of a window **must not** close it: the page stays
   open, and the command line says `last tab: not closed`. Closing a pane of a split, or any tab
   that is not the last, works as always.
8. Closing a window under behaviours 3 to 6 is the window close that `ctrl+shift+w` runs: the
   window goes to the recently closed windows (`ctrl+shift+n`), and the other windows stay as
   they are. Vimma quits only from the last normal window. That it reopens with all its
   workspaces is to be checked (decision 9).
9. A quit from behaviours 3 to 6 is Firefox's own quit, so what can stop `ctrl+q` stops it too:
   a page that asks before it is left, or downloads in progress. When the quit, or a window
   close, is stopped, the window keeps the new tab that `"new_tab"` would have opened.
10. At the next start, the session comes back as after `ctrl+q`: every other workspace with its
    tabs and pane layouts, and the closed tab's workspace with a new tab. The closed tab is in
    the recently closed tabs (`ctrl+shift+t`).
11. In the private workspace, a user close of its last tab with `"picker"`, `"ask"` or `"quit"`
    **must** close the private workspace and return to the normal window it was opened from, as
    `:private close` does but without its question, and **must not** quit Vimma. With `"new_tab"` it
    opens a new private tab, as today; with `"keep"` it is refused as in behaviour 7.
12. A close that is not a user close **must not** quit Vimma, close a window, open the picker or be
    refused: a page's own `window.close()`, an agent's `vimma_close_tab`, a control socket command
    other than the full role's `send-keys`, Firefox's `ctrl+w` given back with `[firefox] enable`,
    and the tab context menu. Those keep Firefox's behaviour under
    `browser.tabs.closeWindowWithLastTab`.
13. The setting is the same for every window and every workspace.

The setting in `config.toml`:

```toml
[tabs]
close_last = "picker"   # closing a window's last tab: "picker" (go to a workspace with tabs;
                        # quit when none is left), "new_tab", "ask", "quit" or "keep"
```

## Research

Firefox paths are relative to `engine/`, checked against Firefox 160.0.1 (`surfer.json`).

- **Firefox's last-tab rule.** `browser.tabs.closeWindowWithLastTab` defaults to `true`
  (`browser/app/profile/firefox.js:1112`); Vimma's branding sets it to `false`
  (`src/browser/branding/vimma/pref/firefox-branding.js:253`). `removeTab` takes a
  `closeWindowWithLastTab` option per call that overrides the pref
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:6463-6467`). `#isLastTabInWindow`
  (6649-6656) ignores hidden tabs, so in Vimma it is true for the only tab of the shown
  workspace even when other workspaces hold tabs. When it is true and the window is to close,
  `#beginRemoveTab` calls `closeWindow(true, warnAboutClosingWindow, "close-last-tab")`
  (6770-6790); otherwise `_endRemoveTab` opens `BROWSER_NEW_TAB_URL` in its place (6843-6844).
- **Closing the window drops the session's tabs.** `closeWindow` (`toolkit/content/globalOverlay.js:5-48`)
  calls `SessionStore.maybeDontRestoreTabs(window)` when its first argument is true (line 36),
  which marks the window `_maybeDontRestoreTabs`
  (`browser/components/sessionstore/SessionStore.sys.mjs:4933-4936`). At the next start
  `#removeExplicitlyClosedTabs` (1040-1050) drops that window's tabs, hidden ones included. So
  letting Firefox close the window would lose every other workspace's tabs.
- **Closing the last window does not quit on macOS** (`globalOverlay.js:10-11`); on Linux it
  runs `canQuitApplication("lastwindow")` and the window closes.
- **Quitting.** `goQuitApplication` (`globalOverlay.js:74-94`) runs `canQuitApplication`, whose
  observers can cancel the quit (pages that ask before they are left, downloads), then
  `Services.startup.quit(eAttemptQuit)`. With the shortcut as the source it also shows Firefox's
  quit warning when `browser.warnOnQuitShortcut` is on, the default on Linux and macOS
  (`firefox.js:376-383`). Vimma's `app.quit` (`ctrl+q`) calls it with the shortcut modifiers
  (`host/browser-ops.mjs`, `quit`).
- **Vimma's close actions.** `tab.close` is `closeTab` (`host/tab-ops.mjs`), which removes the
  selected tab through the file's `removeTab`, passing no `closeWindowWithLastTab`, so the pref
  decides. `pane.close` (`host/pane-ops.mjs`, `closePane`) calls `closeTab` when the tab has no
  split. `:q` and `:quit` run `pane.close` (`packages/vimma-core/src/keys/cmdline.mjs`); Vimma
  has no `:qa`. `x` in normal mode is `tab.close` (`packages/vimma-core/src/config/defaults.mjs`).
  The agent's close passes `closeWindowWithLastTab: false` itself
  (`ctl/agent-commands.mjs`).
- **The private workspace** is Firefox's private window, shown as a workspace
  ([private-workspace](private-workspace.md)); `:private close` closes it after a y/N question.
  Private tabs are not saved in the session, so quitting discards them.

## Design

1. **One setting with five values, in `[tabs]`.** `close_last` sits with `sleep_after` and
   `sleep_on_low_memory`, because it is about what happens to tabs. The values cover what a user
   can want at the last tab: go on with their other work (`"picker"`), keep the browser
   (`"new_tab"`), quit after a question when other work is open (`"ask"`), quit (`"quit"`), or
   keep the page (`"keep"`). Rejected: setting `browser.tabs.closeWindowWithLastTab` to `true`,
   because Firefox's close path drops every other workspace's tabs from the next session
   (Research).
2. **The default is `"picker"`**, because a user who has closed every tab of one workspace most
   likely wants their other work, and the picker takes them there in one key; when nothing is
   left anywhere, quitting is what closing the last tab means, as in Vim's `:q` and tmux's last
   pane. The value is named after what the user sees, so that `close_last = "picker"` reads as
   what happens.
3. **The host decides, before the tab closes, and quits through Firefox's quit.** `removeTab` in
   `host/tab-ops.mjs` tests for the last tab of a window before it removes the tab, passes
   `closeWindowWithLastTab: false` always, and then, when the setting says so, quits with
   `canQuitApplication` and `Services.startup.quit(eAttemptQuit)`, and closes a window with
   `closeWindow(true, …)`, as `cmd_closeWindow` (`ctrl+shift+w`) does. Quitting rather than
   closing the last window keeps the session whole (Research) and quits on macOS too, where
   closing the last window would leave Vimma running with no window. The tab closes first, so
   that it is in the recently closed tabs and the next start does not bring it back. The rule that maps the
   setting, the window's other tabs, the other windows and the private tabs to an outcome
   (`new_tab`, `picker`, `ask`, `quit`, `ask_close_window`, `close_window`, `close_private` or
   `keep`) is a pure function in `packages/vimma-core/src/workspaces/closelast.mjs`, so that
   vitest covers every case.
4. **The picker lists only workspaces that have tabs, and a way out.** An empty workspace is
   left out, because its row would lead only to a start page, which the new tab already is. The
   last row quits (or closes the window), so that a user who wanted to end the browser still
   does it from the same picker in one key; it asks nothing more, because choosing a row that
   says `quit Vimma` is already the answer, except for private tabs (decision 7).
5. **Dismissing the picker never quits**, because `Esc` is the key a user presses to back out,
   and backing out must not end the browser. It leaves the new tab, so that the window is as
   `"new_tab"` would leave it.
6. **Vimma's question replaces Firefox's quit and close warnings.** The quit passes a source other
   than the shortcut, and a window close passes no warning to `closeWindow`, so neither Firefox's
   `browser.warnOnQuitShortcut` question nor its `browser.tabs.warnOnClose` question follows Vimma's
   own, because two questions for one key press is one too many. `"ask"` with no other tabs does not
   ask at all, because nothing else is open to lose. Questions from pages and downloads still run,
   because they protect data Vimma cannot see.
7. **Private tabs always get a question before a quit**, under `"picker"` and `"quit"` too,
   because they cannot come back at the next start; every other tab can.
8. **`"keep"` refuses the close and says so**, because a user may want the close key to stop at
   the last tab without the page changing, and a refused key with no notice looks broken.
9. **With several windows, only the window closes; Vimma quits only from the last normal
   window**, because closing windows the user did not touch is a surprise, and it is what
   `ctrl+shift+w` and Firefox's own last-tab rule do. Each value applies per window: the picker
   lists that window's workspaces, `"ask"` asks about that window's other tabs, and `"keep"`
   refuses in every window. Whether a window closed this way reopens with all its workspaces
   from `ctrl+shift+n` is not yet checked, so the implementing pull request tests it.
10. **The private workspace's last tab closes the private workspace, not Vimma**, because the
    normal window is still open behind it and the user is closing private browsing, not the
    browser. No question is asked, because the closing tab is the private workspace's only tab,
    so nothing else is discarded.
11. **Every user close key follows the setting**: each action under "user close" (`x`,
    `ctrl+b shift+x`, `ctrl+f4`, `ctrl+b x` and `:q` on a tab with one pane, and the side panel's
    `x`), because one rule for every close key is
    easier to predict than one that depends on which key closed the tab.
12. **Only the user's keys quit.** The rule runs only for the actions listed under "user close",
    all of which run through the dispatcher from the window's trusted `keydown` or the full
    role's `send-keys`, because a page, an agent or another control socket command must not be
    able to end the browser or close a window by closing a tab. The full role can already quit
    with `app.quit`, so its keys gain nothing new. The agent's close already opts out (Research).
13. **The agent workspace counts like any other workspace.** Its tabs are other tabs, and it is a
    row of the picker when it has tabs, because quitting ends an agent's connection exactly as
    `ctrl+q` does today, and a separate rule would be one more thing to learn.

## Security and privacy

No new surface. The setting changes what a user's own close key does; pages, agents and the
control socket's agent role cannot reach it, and the full role's `send-keys` could already run
`app.quit` (decision 12), so none of them can quit Vimma or close a window
through it. A quit discards private tabs only after the user answers `y` to a question that says
so (decision 7).

## Tests

- Vitest, `packages/vimma-core/test/closelast.test.ts`: every value with and without the
  window's other tabs, with and without another normal window, with and without private tabs;
  the picker's rows and its last row's text; the questions' text and counts; the private
  workspace's last tab.
- Vitest, `packages/vimma-core/test/config.test.ts`: `close_last` accepts the five values,
  defaults to `"picker"` when absent, and reports an error for any other value or type.
- Mochitest, `tests/browser/browser_vimma_close_last_tab.js` (the quit is caught with a
  `quit-application-requested` observer that cancels it): `"picker"` with another workspace's
  tabs opens the picker without empty workspaces, `Enter` on a workspace switches there and
  closes the new tab, `Esc` leaves the new tab and does not quit, the `quit Vimma` row quits and
  asks first when a private tab is open; `"picker"` with no other tabs quits; `"new_tab"` opens
  a new tab as today; `"ask"` with one workspace quits without a question; `"ask"` with another
  workspace asks, `n` leaves a new tab, `y` quits; `"quit"` quits without a question; `"quit"`
  with a private tab asks; `"keep"` keeps the page and shows its notice, also in the private
  workspace; `Enter` on the private row switches there and keeps the new tab. With two normal
  windows nothing quits and the other window stays: `"picker"` with no other tabs and `"quit"`
  close the window; `"picker"` with other tabs shows `close this window`, and `Enter` on it
  closes the window; `"ask"` asks `close this window?`, `n` leaves a new tab and `y` closes;
  `"new_tab"` and `"keep"` leave both windows open; `ctrl+shift+n` reopens the closed window
  with its workspaces; a window close a page stops leaves the new tab. Also: `:q`, the side
  panel's `x` and `vimma-ctl send-keys x` follow the setting; a page's `window.close()` and the
  agent's close never quit, close the window, open the picker or get refused; a quit a page
  cancels leaves the new tab.

## Docs and changelog

- `docs/guide.md`: the `[tabs]` block of the config reference, the "Closing the last tab keeps
  the window" line under "Firefox behaviour Vimma changes", the close keys' row of the key
  table, the workspace picker section (its `last tab closed` form), and the `:q` line of the
  command table.
- `packages/vimma-core/defaults.toml`: the key with its comment.
- Changelog, from the commit subject:
  `feat(tabs): closing the last tab opens the workspace picker, or quits when nothing is left`.

## Delivery

One pull request: the config key, the core rule with its tests, the host change, the picker's
`last tab closed` form, the mochitest and the docs. It needs no feature flag, because it lands
whole, so `main` stays releasable.

## Open questions

None. The answers are decisions in Design:

1. **What is the default?** Answered: `"picker"`, decision 2.
2. **Does "nothing happens" mean today's new tab, or a refused close?** Answered: both, as
   `"new_tab"` and a new value `"keep"`, decisions 1 and 8.
3. **With `"ask"` and other workspaces' tabs, what does the user see?** Answered: the y/N
   question of behaviour 5, with the picker as the default value, decisions 2 and 4.
4. **With several normal windows, what does a value that quits do?** Answered: close only this
   window, and quit only from the last normal window, decision 9.
5. **Which keys follow the setting?** Answered: every user close, decision 11.
