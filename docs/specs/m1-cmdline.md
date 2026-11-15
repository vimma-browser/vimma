# Spec: m1-cmdline

Status: implemented · Milestone: M1 (prototype slice) · Area: UI
(`ui/cmdline.mjs`), host (`host/VimmaHost.sys.mjs`, `host/tab-ops.mjs`), core (`actions.mjs`,
`cmdline.mjs`)

## User story

As a user, `:` in normal mode opens a Vim-style command line at the bottom of the window. I type
`:tabnew`, `:q`, `:open example.com`, `:map` or any action by name; `Tab` / `shift+Tab` cycle
completions, `Up` / `Down` walk earlier lines, `Enter` runs and `Esc` cancels. A typo keeps the
line open and tells me what I probably meant. Nothing I type into it reaches the page.

## Scope

- **UI:** `ui/cmdline.mjs` (`CommandLine`) + `browser/themes/shared/vimma/cmdline.css`, both
  in our `jar.mn`. Built on first use, one per window.
- **Host:** `command.open` and `command.cancel` runners; `_mode` reports `command` while the line
  is open; `_runCommand(state, result)` runs a parsed line through `_run` (the path keys take),
  refusing `PENDING_ACTIONS`. Opening and closing call #34's `_emit`, so the status bar shows
  `COMMAND` and leaves it however the line closes. Runners take an optional third argument, the
  command's free text.
- **Runners added:** `pane.close` (until M4's panes every tab is one pane, so it closes the tab:
  `:q`, `prefix+x`), `page.open` (`:open`), and `tab.new` with text (`:tabnew url`).
- **Core:** `page.open` moves from `PENDING_ACTIONS` into `actions.mjs` as `open_url` (unbound;
  `npm run gen-docs`); `:help` (alias `:h`) joins `COMMANDS` → `help.show`.
- No upstream patch, no build-config change, no new dependency.

## Tests (write first)

`tests/browser/browser_vimma_cmdline.js`:

- `:` on a page in normal mode opens the line, focus in its input, mode `command`; `Esc` closes
  it, focus back on the page, mode `normal`.
- `:tabnew` Enter opens a tab; `:q` closes the selected tab; on a pinned tab it closes nothing
  and selects the first unpinned tab (as `tab.close`); the last tab with
  `browser.tabs.closeWindowWithLastTab` false leaves a fresh tab.
- `Tab` completes `tabn` → `tabnew` and cycles to core's next candidate, `shift+Tab` back; `Up`
  recalls the previous command line, `Down` returns to the draft.
- An unknown command (`:tabnwe`) shows an error naming `tabnew` and the line stays open.
- `:open example.com` loads `http(s)://example.com/` through fixup; `:tabnew example.com` does so
  in a new tab.
- `:vsplit` shows m2-tab-keys' "Split right: not implemented yet"; `:workspace work` (pending)
  shows "… not available yet"; `:map` and `:help` open the bindings overlay. (Every command
  runs since M4 and m3-workspaces: the test now runs `:sidebar`, and `:workspace work` reports
  `no workspace "work"`.)
- `:` in a text field (insert) is typed into it; the line does not open.
- The page sees none of the keys typed into the line (head.js race-free helpers).

`packages/vimma-core/test/cmdline.test.mjs`: `PENDING_ACTIONS` is `["workspace.switch"]` (empty
since m3-workspaces);
`:open x` parses to `page.open`; `:help`, `:h` → `help.show`.

## Out of scope

Argument completion (URLs, workspace names), `:set`, `:bug`, counts and ranges, persisting
history, `ctrl+r`/`ctrl+w`-style line editing beyond what an `<input>` does, mouse on the
completion list.

## Settled (2026-10-09)

- **The input.** A chrome-level HTML `<input>` inside our own container, `div#vimma-cmdline`,
  inserted right after `#browser` in the chrome `<body>` (a flex column). The container takes no
  height; its panel is `position: absolute; bottom: 0` and overlays the bottom of the content,
  so opening it never reflows the page. #34's status bar (`#vimma-statusbar`) is also after
  `#browser`, built at window init; the container goes before it, so the line sits just above
  the bar (and at the window's foot if the bar failed to build).
  `role="combobox"` on the input, with `aria-controls` / `aria-activedescendant` on the list.
- **Keys while it is open.** The host reports mode `command` (the line is open; it closes when
  focus leaves it within the window). The dispatcher still sees every key first: `Esc` is the
  `command` keymap's `command.cancel`, and `ctrl+b` sequences work as in every mode. Everything
  else passes, the host does not consume it, and it reaches the input, whose own `keydown`
  listener handles `Tab`, `shift+Tab`, `Up`, `Down` and `Enter` (and prevents their defaults:
  `Tab` would move focus). These are editing keys of the line, not actions, so `actions.mjs`
  stays the user's keymap. Focus is in chrome, so the page gets no key at all.
- **Closing.** `Esc` restores focus to what had it before `:` (the page), else the selected
  browser. `Enter` closes first, restoring focus, then runs, so `:scroll_down` finds the page
  focused and `:tabnew` can move focus to the new tab's URL bar. Focus moving elsewhere in the
  window (a click, `ctrl+b c`) closes the line without running; the window losing focus
  (alt+tab) keeps it open. A tab switch underneath closes it and focuses the new tab.
- **History** is in memory: one list of entries shared by the non-private windows of a session
  (Vim's is global too), newest 100 lines, kept by core's `pushHistory` (every executed line,
  errors included, as Vim). Each command line keeps its own cursor and draft, so browsing in one
  window never moves another's. **A private window gets its own throwaway
  history**, dropped with the window, and nothing typed there enters the shared list
  (`:tabrename secret` in a private window was otherwise recalled by a normal window's `Up`).
  Persisting it later goes to a file in the profile directory (`vimma/cmdline-history.json`,
  like Vim's shada), not a pref: prefs are settings, are rewritten whole to `prefs.js` on change
  and are not meant for growing lists. **Persistence must exclude private-window input**: only
  the shared store is ever written.
- **Completion popup:** a plain list (`ul[role=listbox]`) above the input, keyboard only, up to
  core's 20 candidates with a scroll, each row the name and its description. It follows typing
  while the line is just the command word; `Tab` selects the next candidate into the input
  (`shift+Tab` the previous, both wrapping), typing ends the cycle. A line with an argument has
  no candidates (core: argument completion is out of scope).
- **Errors** show inline under the input (`role="alert"`), core's message plus "did you mean"
  with its suggestions; the line stays open with the text, the next edit clears it. An empty
  line (`:` Enter) just closes, as Vim.
- **Running.** A `run` result goes through `_run`, so `RUNNERS`, `CONTENT_RUNNERS` and m2-tab-keys'
  "<action>: not implemented yet" notice apply as they do to keys (`:vsplit`, `:tabrename`).
  An id in `PENDING_ACTIONS` (`workspace.switch`) is refused with "<command>: not available yet"
  in the same notice, never passed to `_run`. Text rides in a third runner argument; `Action`
  stays `{ id, count?, arg? }`.
- **`:open` (`page.open`)** is `openTrustedLinkIn(text, "current", { allowThirdPartyFixup: true })`:
  `allowThirdPartyFixup` sets `LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP | LOAD_FLAGS_FIXUP_SCHEME_TYPOS`
  (URILoadingHelper.sys.mjs `openInCurrentTab`), and docshell then runs `URIFixup` with keyword
  lookup (`nsDocShellLoadState::CreateFromLoadURIOptions`): `example.com` gets a scheme, words go
  to the default search engine (`keyword.enabled`), as typing them in the URL bar and pressing
  Enter. The URL bar's own heuristic (`UrlbarInput`) is not used: it needs the async provider
  query and the panel. Pinned tabs keep Firefox's rule (a host change opens a new tab).
  `:tabnew text` is the same in `"tab"`. `open_url` with no text (a key bound to it) opens the
  line prefilled with `open `.
- **`:q` → `pane.close`** closes the tab with m2-tab-keys' `closeTab` (pinned: selects the first
  unpinned tab; the last tab closes the window unless `closeWindowWithLastTab` is false). M4
  replaced the runner with "close the pane; the last pane closes the tab". `prefix+x` gets the
  same runner, so it is no longer dimmed.
- **Insert mode:** `:` is not bound in `insert`, so it is typed. In chrome text fields (URL bar)
  the mode is `insert` too.
- **Theme:** the stylesheet reads M5's tokens (`--vimma-bg-dark`, `--vimma-fg`,
  `--vimma-accent`, `--vimma-selection`, `--vimma-error`, `--vimma-font`) with `Canvas` /
  `CanvasText` fallbacks; the status bar (#34) loads the token sheet once per window.
- **Notice, fullscreen.** The which-key layering (the line dropping to
  `z-index: 4` while a prefix was pending) went with the strip (removed on 2026-10-09; see
  m2-statusbar-whichkey, Settled). While the line is open (`:root[vimma-cmdline-open]`)
  the notice moves above it: a `ResizeObserver` on the panel sets `--vimma-cmdline-height` on
  the root. In DOM fullscreen (`:root[inDOMFullscreen]`) `:` does not open the line and an open
  one is hidden, as the status bar is; entering DOM fullscreen needs focus in the page, which
  already closes the line.
- **`javascript:` URLs** are refused by `:open` and `:tabnew` before loading,
  with the notice "blocked: javascript: URLs can't be opened from the command line": the load
  failed silently and `:tabnew` left a blank tab. The check ignores case, surrounding space,
  tabs and newlines, as URL parsing does. Since issue #98 it is `p`'s check (`refusedScheme`)
  and refuses `data:` too, also behind `view-source:`; the notice reads "blocked: javascript:
  and data: URLs can't be opened from the command line".
- **Verified:** core red 4 failed (`:help`, `:h`, `PENDING_ACTIONS`, `open_url`), green 1044/0
  (the `prefix+?` snapshot gains the `open_url` row). Browser red, host without the line: 20/26
  passed (": opens the command line - false == true", the page saw `[":", "z"]`, `:q` timed
  out). Green: `browser_vimma_cmdline.js` 138/0. Mutation: `_runCommand` without the
  `PENDING_ACTIONS` refusal fails "a pending action is refused" ("workspace.switch: not
  implemented yet"); reverted. Full `tests/browser/` 889/0 on the artifact build.
- **Reconciled with #34 (status bar, which-key):** merged with rerere off; README and
  `browser.toml` by hand. `VimmaHost.status(win).mode` replaced this spec's own `mode(win)`. New
  test: the bar says `COMMAND` while the line is open and leaves it when focus moving elsewhere
  closes the line; the line's bottom meets the bar's top. It passed before the `changed`
  callback (the bar's debounced refresh happened to run after the close), so the callback is
  there to make it deterministic, not to fix an observed failure. Full `tests/browser/` 973/0.
- **Hardening:** six new tests, red first (12 failures: a normal window recalled the
  private line, the other window reset this one's cursor, the strip was covered at 2 of 3
  points, the notice bottom 741 > line top 512, `:` opened in fullscreen, `javascript:` showed no
  notice and left a tab). Green: `browser_vimma_cmdline.js` 201/0 after merging main (mutation
  testing CI, #36). Mutation: private windows using the shared store fail "a normal window does
  not"; reverted. Full `tests/browser/` 1033/0 on the artifact build; `npm test` 1418/0.

(Since changed: `:settings [pane]`, with the aliases `:preferences` and `:prefs`, opens Firefox's
Settings (`about:preferences`), because Settings had no key or command and the menu button is a
mouse path. A Settings tab already open in the current workspace is selected rather than a second
one opened, as Firefox's own `openPreferences` does, so the command never piles up Settings tabs.
The optional pane is one of `home`, `search`, `privacy` and `sync`, the panes a keyboard user
changes most, completed by `Tab`; an unknown pane is refused with the nearest name. It has no
default key: a command is enough for a page opened this rarely, and it can be bound as
`settings` in `config.toml`.)
