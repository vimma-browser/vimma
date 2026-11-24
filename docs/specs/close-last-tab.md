# Spec: close-last-tab

Status: draft · Area: core (`packages/vimma-core/src/config/config.mjs`,
`packages/vimma-core/src/config/defaults.mjs`, `packages/vimma-core/defaults.toml`, a new
`packages/vimma-core/src/workspaces/closelast.mjs`), chrome (`host/tab-ops.mjs`,
`host/pane-ops.mjs`, `host/browser-ops.mjs`) · Upstream patches: none · ADR: none

Issue: [#1428](https://github.com/vimma-browser/vimma/issues/1428)

## Summary

A new `config.toml` setting, `[tabs] close_last`, decides what closing the last tab of a window
does: open a new tab in its place as today (`"new_tab"`), quit Vimma and ask first when other
workspaces still hold tabs (`"ask"`), or quit Vimma (`"quit"`). With `"ask"` or `"quit"`,
`x`, `ctrl+b shift+x` or `:q` on a lone tab ends the browser, as `:q` on Vim's last window does
and as closing tmux's last pane ends its session. Quitting goes through Firefox's own quit, so
every other workspace's tabs come back at the next start.

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
- **Other tabs** are every open tab outside the closing tab's workspace: the hidden tabs of the
  window's other workspaces (the agent workspace included), the tabs of other normal windows,
  and the tabs of the private workspace.
- A **user close** is one of the closing actions a key runs: `tab.close` (`x`,
  `ctrl+b shift+x`, `ctrl+f4`), `pane.close` (`ctrl+b x`, `:q`) on a tab with one pane,
  `panel.close_tab` (`x` in the side panel) and `panel.close_active_tab`.

1. `[tabs] close_last` takes `"new_tab"`, `"ask"` or `"quit"`. Any other value is a config
   error, reported as for any other key, and the default applies. A change applies from the next
   close after the file is read (`:source`), with no restart.
2. With `"new_tab"`, a user close of the last tab of a window does what it does today: the tab
   closes and Firefox opens a new tab in the same workspace.
3. With `"ask"`, a user close of the last tab of a window, when there are no other tabs,
   **must** close the tab and quit Vimma without a question.
4. With `"ask"`, when there are other tabs, it **must** close the tab and then ask on the
   command line `quit Vimma? 14 tabs in 3 other workspaces come back at the next start y/N`.
   `y` quits; `n`, `esc` or any other key does what `"new_tab"` does. When private tabs are
   among the other tabs, the question says so: `… 2 private tabs are discarded y/N`.
5. With `"quit"`, a user close of the last tab of a window **must** close the tab and quit
   Vimma without a question, unless private tabs are open: then it asks the question of
   behaviour 4.
6. A quit from behaviours 3 to 5 is Firefox's own quit, so what can stop `ctrl+q` stops it too:
   a page that asks before it is left, or downloads in progress. When the quit is stopped, the
   window keeps the new tab that `"new_tab"` would have opened.
7. At the next start, the session comes back as after `ctrl+q`: every other workspace with its
   tabs and pane layouts, and the closed tab's workspace with a new tab. The closed tab is in the
   recently closed tabs (`ctrl+shift+t`).
8. In the private workspace, a user close of its last tab with `"ask"` or `"quit"` **must**
   close the private workspace and return to the normal window, as `:private close` does but
   without its question, and **must not** quit Vimma. With `"new_tab"` it opens a new private
   tab, as today.
9. A close that is not a user close **must not** quit Vimma: a page's own `window.close()`, an
   agent's `vimma_close_tab`, a command over the control socket, Firefox's `ctrl+w` given back
   with `[firefox] enable`, and the tab context menu. Those keep Firefox's behaviour under
   `browser.tabs.closeWindowWithLastTab`.
10. The setting is the same for every window and every workspace.

The setting in `config.toml`:

```toml
[tabs]
close_last = "new_tab"   # closing a window's last tab: "new_tab", "ask" (quit; asks when
                         # other workspaces have tabs) or "quit"
```

(The default value is open question 1; `"new_tab"` is the recommendation.)

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

1. **One setting with three values, in `[tabs]`.** `close_last` sits with `sleep_after` and
   `sleep_on_low_memory`, because it is about what happens to tabs. Three values cover the three
   things a user can want: keep the browser (`"new_tab"`), quit but not lose track of other work
   without a question (`"ask"`), and quit (`"quit"`). Rejected: setting
   `browser.tabs.closeWindowWithLastTab` to `true`, because Firefox's close path drops every
   other workspace's tabs from the next session (Research).
2. **The host decides, before the tab closes, and quits through Firefox's quit.** `removeTab` in
   `host/tab-ops.mjs` tests for the last tab of a window before it removes the tab, passes
   `closeWindowWithLastTab: false` always, and then, when the setting says so, quits with
   `canQuitApplication` and `Services.startup.quit(eAttemptQuit)`. Quitting rather than closing
   the window keeps the session whole (Research) and quits on macOS too, where closing the last
   window would leave Vimma running with no window. The tab closes first, so that it is in the
   recently closed tabs and the next start does not bring it back. The rule that maps the
   setting, the other tabs and the private tabs to an outcome (`new_tab`, `ask` or `quit`) is a
   pure function in `packages/vimma-core/src/workspaces/closelast.mjs`, so that vitest covers
   every case.
3. **Vimma's question replaces Firefox's quit warning.** The quit passes a source other than the
   shortcut, so Firefox's `browser.warnOnQuitShortcut` question does not follow Vimma's own,
   because two questions for one key press is one too many. `"ask"` with no other tabs does not
   ask at all, because nothing else is open to lose. Questions from pages and downloads still
   run, because they protect data Vimma cannot see.
4. **Private tabs always get a question**, under `"quit"` too, because they cannot come back at
   the next start; every other tab can.
5. **The private workspace's last tab closes the private workspace, not Vimma**, because the
   normal window is still open behind it and the user is closing private browsing, not the
   browser. No question is asked, because the closing tab is the private workspace's only tab,
   so nothing else is discarded.
6. **Only the user's keys quit.** The rule runs only for the actions listed under "user close",
   all of which run from the window's trusted `keydown` through the dispatcher, because a page,
   an agent or a script on the control socket must not be able to end the browser by closing a
   tab. The agent's close already opts out (Research).
7. **The agent workspace counts like any other workspace.** Its tabs are other tabs for
   behaviour 4, because quitting ends an agent's connection exactly as `ctrl+q` does today, and a
   separate rule would be one more thing to learn.

## Security and privacy

No new surface. The setting changes what a user's own close key does; pages, agents and the
control socket cannot reach it (decision 6), so none of them can quit Vimma through it. A quit
discards private tabs only after the user answers `y` to a question that says so (decision 4).

## Tests

- Vitest, `packages/vimma-core/test/closelast.test.ts`: every value with and without other
  tabs, with and without private tabs; the question's text and counts; the private workspace's
  last tab.
- Vitest, `packages/vimma-core/test/config.test.ts`: `close_last` accepts the three values,
  defaults when absent, and reports an error for any other value or type.
- Mochitest, `tests/browser/browser_vimma_close_last_tab.js` (the quit is caught with a
  `quit-application-requested` observer that cancels it): `"new_tab"` opens a new tab as today;
  `"ask"` with one workspace quits without a question; `"ask"` with another workspace asks, `n`
  leaves a new tab, `y` quits; `"quit"` quits without a question; `"quit"` with a private tab
  asks; `:q` and the side panel's `x` follow the setting; a page's `window.close()` and the
  agent's close never quit; a quit a page cancels leaves the new tab.

## Docs and changelog

- `docs/guide.md`: the `[tabs]` block of the config reference, the "Closing the last tab keeps
  the window" line under "Firefox behaviour Vimma changes", and the `:q` line of the command
  table.
- `packages/vimma-core/defaults.toml`: the key with its comment.
- Changelog, from the commit subject:
  `feat(tabs): closing the last tab can quit vimma ([tabs] close_last)`.

## Delivery

One pull request: the config key, the core rule with its tests, the host change, the mochitest
and the docs. It needs no feature flag, because it lands whole and its default (open question 1)
can keep today's behaviour.

## Open questions

1. **What is the default?** Options: `"new_tab"`, today's behaviour; `"ask"`, Vim's `:q`
   behaviour, but then a single `x` on a lone tab quits the browser without a question;
   `"quit"`, the same with no question at all. Recommendation: `"new_tab"`, because `x` and
   `ctrl+b shift+x` are fast keys that a user presses in a row to clear tabs, and one press too
   many must not end the browser for users who have not chosen it.
2. **Does "nothing happens" mean today's new tab, or a refused close?** Options: `"new_tab"`
   only (the tab closes and a new tab replaces it); add `"keep"`, which refuses the close and
   says `last tab: close_last keeps it`; or both. Recommendation: `"new_tab"` only, because a
   refused close leaves a page on screen that the user asked to close, and the new tab already
   guarantees that nothing quits; `"keep"` can be added later as a fourth value without breaking
   any file.
3. **With `"ask"` and other workspaces' tabs, what does the user see?** Options: the y/N question
   of behaviour 4; the workspace picker, with a row that quits Vimma; switching to the most
   recently used workspace that has tabs; or the y/N question with a third answer, `w`, that
   opens the workspace picker. Recommendation: the y/N question, because it has the same shape as
   `:wsdelete` and `:private close`, takes one key and says what happens to the other tabs; the
   picker turns a close into navigation the user did not ask for and is one key away anyway
   (`ctrl+b w`), and switching silently moves the user somewhere they did not choose.
4. **With several normal windows, what does `"ask"` or `"quit"` do?** Options: close only this
   window (its other workspaces' tabs go to the recently closed windows, `ctrl+shift+n`) and quit
   only from the last normal window; or quit Vimma with every window. Recommendation: close only
   this window, because closing windows the user did not touch is a surprise, and it is what
   `ctrl+shift+w` and Firefox's own last-tab rule do. The question of behaviour 4 then names
   this window's other workspaces and says they go to the recently closed windows. Whether a
   window closed this way can be reopened with all its workspaces is not yet checked; the
   implementing pull request tests it.
5. **Which keys follow the setting?** Options: every user close (behaviour list); or only
   `pane.close` (`:q`, `ctrl+b x`), so that `:q` follows Vim and `x` never quits. Recommendation:
   every user close, because the reported case is pressing the close key again after clearing
   the tabs, and one rule for every close key is easier to predict than one that depends on which
   key closed the tab.
