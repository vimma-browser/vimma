# Spec: tab-search

Status: implemented · Area: `packages/vimma-core/src/` (`picker.mjs`, `tabsearch.mjs` new,
`actions.mjs`, `cmdline.mjs`); `src/browser/base/content/vimma/` (`host/goto.mjs`,
`host/tab-search.mjs` new, `host/VimmaHost.sys.mjs`, `ui/picker.mjs`, `jar.mn`);
`src/browser/themes/shared/vimma/picker.css` · Upstream patches: none · ADR: none. No new
dependency.

Issue: [#215](https://github.com/vimma-browser/vimma/issues/215)

Builds on [m2-picker-rename](m2-picker-rename.md) (the goto picker),
[m3-workspaces](m3-workspaces.md) (sub-spec 5, the workspace picker and its `m`),
[private-workspace](private-workspace.md) (decision 5b: a normal window never shows a private
tab's title or URL), [vimma-mcp](vimma-mcp.md) (the agent workspace, decisions 9, 11 and 24) and
[firefox-keys](firefox-keys.md) (`ctrl+shift+a` is `addons_manager`). Vimma paths are checked on
main at 7fc0226 and are under `src/browser/base/content/vimma/` unless they start with
`packages/`, `src/browser/themes/`, `docs/`, `tests/` or `tools/`. Engine paths are relative to
`engine/` and checked against Firefox 158.0.

## Summary

The goto picker (`ctrl+b g`, `b`, `:ls`) becomes tab search, modelled on Chromium's and Brave's
Tab Search: one keyboard list that finds any open tab in any workspace of any normal window, and
any recently closed tab or window. It opens ready to type. Each row shows its workspace, window
and audio state; `Enter` goes to the tab, or reopens a closed one. Private tabs never appear
outside the private workspace, agent tabs are marked `◇`, and lazy tabs stay unloaded. Tab
search only finds tabs; closing and moving them stays in the side panel.

## Problem

With many tabs across workspaces and windows, finding one tab is slow or impossible from the
keyboard today:

- The goto picker lists only the current window. A tab in another window cannot be found from
  Vimma at all.
- A row does not show its workspace, so two tabs with the same title in `work` and `personal`
  look the same.
- A tab closed by mistake a few tabs ago can only be reached by pressing `ctrl+shift+t`
  repeatedly, which reopens every tab closed after it too. There is no list of closed tabs.
- A tab playing audio cannot be found from the picker; only the side panel marks it, and only
  for the current workspace.
- The picker opens in a browse mode, so finding a tab by name takes `/` before the first letter.
- The agent workspace's tabs appear in the picker with no marker, indistinguishable from the
  user's own.

## Behaviour

1. As a Vimma user with 150 tabs across `work`, `personal` and two windows, `ctrl+b g` and a few
   letters (`jira 412`) find the tab, and `Enter` takes me there: the right window comes to the
   front and the right workspace becomes active. No tab that was not loaded loads.
2. As a Vimma user who closed a tab by mistake three tabs ago, `ctrl+b g`, then `Tab` (to
   "Recently closed") or part of its title, then `Enter` reopen it in its own workspace, with
   its history, and go there. `ctrl+shift+t` still reopens only the last one.
3. As a Vimma user who closed a window, its row under "Recently closed" (`3 tabs`, `closed
window`) reopens it with `Enter`.
4. As a Vimma user who hears audio somewhere, the playing tab's row shows `♪` (and `muted` when
   muted), and typing `playing` or `muted` finds those rows.
5. As a Vimma user, every letter I type goes into the search, `j`, `k` and `q` included;
   `ctrl+n` / `ctrl+p` and the arrow keys move, and one `Esc` closes the list.
6. As a user of the private workspace, a normal window's tab search never lists a private tab's
   title or URL, open or closed, and the private window's tab search lists only private tabs.
7. As a Vimma user running an agent, the agent workspace's tabs are listed marked `◇ agent`,
   after my own workspaces, so an agent's tab is never mistaken for mine.
8. As a screen-reader user, the list is a listbox whose options name the tab, its workspace and
   its window or "recently closed", and the number of matches is announced as I type.

Keys and commands (decisions 2 and 7):

| Key or command                   | Where         | Does                                            |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `ctrl+b g`, `b`, `:ls`           | unchanged     | `goto_picker`: opens tab search, ready to type  |
| `:tabsearch [text]`, `:ts`, `:b` | command line  | opens tab search with the text already typed    |
| letters, `Backspace`, `ctrl+w/u` | in the picker | type and edit the query                         |
| `ctrl+n` / `ctrl+p`, `Down`/`Up` | in the picker | move                                            |
| `Tab` / `shift+tab`              | in the picker | next / previous section                         |
| `Enter`                          | in the picker | goes to the tab; reopens a closed tab or window |
| `Esc`                            | in the picker | closes it                                       |

No default key and no config key is added. `keys.goto_picker` stays configurable as every
action is (firefox-keys).

## Research

### Chromium and Brave Tab Search

Chromium source checked at `chromium/src` main, commit a879a00e (2026-10-14, `chrome/VERSION`
158.0.8105.0), through `chromium.googlesource.com`. Brave source checked at `brave/brave-core`
master, commit 3446fc820e (`package.json` version 1.99.42), through the GitHub API.

- **Brave ships Chromium's Tab Search** and adds a setting for its button: the pref
  `brave.tabs_search_show` (`components/constants/pref_names.h`, `kTabsSearchShow`), labelled
  "Show tab search button" (`app/brave_settings_strings.grdp:314-316`). Brave's help centre
  places Tab Focus Mode, an AI grouping feature out of scope here, under the same button
  (<https://support.brave.app/hc/ar/articles/35200007195917-How-to-use-Tab-Focus-Mode>; a help
  page, no version stated).
- **Shortcut.** `ctrl+shift+a` (`cmd+shift+a` on macOS) is `IDC_TAB_SEARCH` in Chromium
  (`chrome/browser/ui/accelerator_table.cc:63-64`, `VKEY_A` with `EF_SHIFT_DOWN |
EF_PLATFORM_ACCELERATOR`); Brave inherits it.
- **It is a WebUI bubble**, `chrome://tab-search.top-chrome`, source in
  `chrome/browser/resources/tab_search/`: `tab_search_page.ts`, `tab_search_item.ts`,
  `tab_search_group_item.ts`, `selectable_lazy_list.ts` (a virtualised list) and
  `alert_indicators/` (audio and recording icons).
- **Every window's tabs.** `tab_search_page.ts:682` walks `profileData.windows`, every window of
  the profile, into one open-tabs list, sorted by `lastActiveTimeTicks`, most recent first, with
  the active window's visible tab moved to the bottom "because it's not likely users want to
  click on it" (`:940-953`). Some third-party guides say it searches the current window only; the
  source says otherwise.
- **Sections.** "Audio and video" (tabs with `tabHasMediaAlerts()`, `:956-1002`, not shown while a
  query is typed), "Open tabs", and "Recently closed" (tabs, split views and closed tab groups,
  `:720-747`, `:1011-1035`), capped at `recentlyClosedDefaultItemDisplayCount` (`:167-168`) and
  expandable.
- **Search.** Fuse.js options (`:145-166`) over `tab.title` (weight 2), `tabGroup.title` (1.5) and
  `hostname` (1), `threshold: 0.0`, with matched characters highlighted.
- **Keys and accessibility.** `Up`/`Down` move, `Enter` switches (to another window too), `Esc`
  closes the bubble; each row has a close button (`apiProxy_.closeTab()`, `:652`), and the screen
  reader hears the result count (`getA11ySearchResultText_()`, `:480`).

What Vimma takes: one place to find any tab, every window, recently closed in the same list,
media markers, close from the list, and a way in that starts typing. What Vimma leaves: the
mouse-first bubble and its button, tab-group sections (Vimma has workspaces instead), the
recency order (decision 3) and the AI grouping.

### Vimma today

- **The goto picker** (`goto.picker`: `prefix+g`, `b` in normal mode, `:ls` and `:b`; guide
  "Goto picker and tab rename" and the command table; `packages/vimma-core/src/defaults.mjs:106`,
  `:198`, `cmdline.mjs:106`):
  - It lists every tab of every workspace **of the current window**, workspace by workspace
    (`host/goto.mjs:35-62` `pickerWorkspaces`, `:81-100` `gotoItems`; core `picker.mjs:353-373`
    `pickerItems`). A private window lists its own visible tabs (`goto.mjs:52-61`).
  - Matching is fuzzy per whitespace-separated term over the rename or title (`display`), title,
    URL and workspace name; every term must match some field (`picker.mjs:303-330`). Tiers are
    exact > prefix > word > substring > subsequence > diacritics-folded (`picker.mjs:85-92`,
    `scoreField` `:226`), and field weights are `display 300, title 250, url 150, workspace 100`
    (`:95`).
  - Keys: `j`/`k`/`Down`/`Up`/`ctrl+n`/`ctrl+p`, `/` to search, `left`/`right` to jump workspace
    sections on a blank query (`jumpSection`, `:466-485`), `Enter`, `Esc`/`q` (`pickerKey`,
    `:506-563`). `m` is the workspace picker's only (`:533`); `x`, `d`, `o`, `u` and `shift+p` are
    the add-on picker's (`ADDON_KEYS`, `:73-79`). No key acts on a tab row besides `Enter`.
  - The UI (`ui/picker.mjs`, look `GOTO` at `:45`) shows per row the tab number, the display
    label with `<mark>` highlights (the display field only, `:221-227`) and the host. **The
    workspace name is not shown on a row** and there are no section headings, though the list
    is ordered by workspace. The list is `role=listbox` with options and
    `aria-activedescendant` (`:247-253`, `:285`; m7-a11y).
  - Selecting a lazy tab works: `tabById` (`goto.mjs:69-74`) falls back to the window model's
    uuid for a tab with no `linkedPanel`; title and URL are read from `linkedBrowser` without
    loading (`:93-97`).
  - The agent workspace's tabs are listed with no marker: `pickerItems` takes no agent id, while
    `workspaceItems` marks the agent row `◇ agent` (`picker.mjs:382-398`, `AGENT_GLYPH` in
    `agent.mjs:13`).
  - A new item list while open keeps the selection (`setPickerItems`, `picker.mjs:433-440`,
    `ui/picker.mjs:157-161`); the add-on picker's refresh uses it.
- **The workspace picker** (`ctrl+b w`): one row per workspace, the agent workspace last among
  the normal ones and the `◆ private` row after them (`host/private-ops.mjs:286`
  `pickerItemsWithPrivate`; private-workspace decision 5, vimma-mcp decision 9). `m` moves the
  current tab there after `moveTabQuestion` (`packages/vimma-core/src/workspacedefs.mjs:534`),
  which asks the agent variant of the question when the target is the agent workspace
  (vimma-mcp decision 11; host `host/workspace-ops.mjs:341`).
- **The side panel** (`ctrl+b b`): the current workspace only. Rows carry `♪` for
  `tab.soundPlaying` (`host/VimmaHost.sys.mjs:1073`, `ui/side-panel.mjs:262`). `x` closes the
  tab and keeps the panel open, refusing a pinned tab with `PINNED_TEXT`
  (`packages/vimma-core/src/sidepanel.mjs:66`, `:354-364`; host `closeTabById`,
  `host/tab-ops.mjs:79-87`). Its header never names the agent workspace as a neighbour (the
  `skip` option, `sidepanel.mjs:58-59`, `:99-108`).
- **Recently closed.** Only `restore_tab` (`ctrl+shift+t`), which runs Firefox's
  `History:RestoreLastClosedTabOrWindowOrSession` (`host/tab-ops.mjs:94-99`), and
  `restore_window`, mapped to `History:UndoCloseWindow` (`host/browser-ops.mjs:17`). No list.
- **Other windows.** Nothing in Vimma lists their tabs. `BrowserWindowTracker.orderedWindows` is
  used by about:vimma and the private workspace (`about/AboutVimma.sys.mjs:241`,
  `host/private-ops.mjs:89-102`).
- **Keys.** `ctrl+shift+a` is `addons_manager`, page first (`defaults.mjs:127`;
  `docs/bindings.md:139`, `:309`; firefox-keys sub-PR 1, #171). Prefix keys in use
  (`defaults.mjs`): `( ) ? [ ^ a b c ctrl+6 e enter g h j k l minus n p r space v w x z` and
  `shift+a b d h j k l n p t w x`. toolbar-toggle reserves `prefix+u`; live grep plans
  `prefix+f g` (live-grep). Tab search adds no key (decision 2).
- **Themes.** `picker.css` uses the theme tokens `--vimma-bg-dark`, `--vimma-fg`,
  `--vimma-fg-bright`, `--vimma-fg-dim`, `--vimma-muted`, `--vimma-selection`,
  `--vimma-text-accent` and `--vimma-focus`, with system-colour fallbacks. The agent's colour is
  `--vimma-text-cyan` (vimma-mcp decision 24; `packages/vimma-core/src/statusbar.mjs:65`).
- **Tests to extend.** `tests/browser/browser_vimma_picker.js`, `browser_vimma_workspace_picker.js`,
  `browser_vimma_private_workspace.js` (pins "no private tab in a normal window's goto picker"),
  `browser_vimma_a11y.js`, `browser_vimma_focus_rings.js`. The e2e baselines in
  `tests/e2e/baselines/` are `m0-happy-path-help.png`, `m0-mcp-stdio-grant.png`,
  `m0-mcp-stdio-question.png`, `m3-private-workspace.png` and `m4-split-panes.png`; none shows the
  picker.

### Firefox (checked against 158.0)

- **"List all tabs"** (`gTabsPanel`, `browser/components/tabbrowser/content/browser-allTabsMenu.js:13`,
  `init` `:52`): an audio list (`tab.soundPlaying || tab.muted`, `:62`) above the window's
  visible tabs (`!tab.hidden`, `:68`), and a hidden-tabs subview (`:214`). It has **no search
  field of its own**: its "Search tabs" button (`allTabsMenu-searchTabs`,
  `browser-allTabsMenu.inc.xhtml:8`, handled at `:147`) calls
  `gURLBar.search(UrlbarShared.RESTRICT_TOKENS.OPENPAGE, { searchModeEntry: "tabmenu" })`
  (`searchTabs`, `:277-281`). Rows come from `TabsListBase` / `TabsPanel`
  (`browser/components/tabbrowser/TabsList.sys.mjs:58`, `:449`). The panel opens on
  `ctrl+shift+tab` only when the most-recently-used `ctrl+tab` is on
  (`browser/components/tabbrowser/content/browser-ctrlTab.js` `onKeyDown` `:585`, `:607-608`;
  `showAllTabs` `:471-473`; `browser.ctrlTab.sortByRecentlyUsed`,
  `browser/app/profile/firefox.js:1278`, default false). In Vimma `ctrl+shift+tab` is
  `previous_tab`. `Browser:ShowAllTabs` (`browser/base/content/browser-sets.inc.xhtml:90`,
  `browser-sets.js:208`) is also in the View menu.
- **URL bar tab search.** The `%` restrict token (`OPENPAGE`,
  `browser/components/urlbar/content/UrlbarShared.mjs:194`; `RESTRICT_OPENPAGE` `:171`) or the
  "Tabs" search mode (`:444-448`). `UrlbarProviderOpenTabs`
  (`browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs:30-32`) keeps open URLs per
  `userContextId` and group. Tabs register on location change
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:10744-10761`) and lazy browsers from their
  `lazyBrowserURI` (`:3850-3860`); hidden tabs (other workspaces) stay registered. Switch-to-tab
  respects containers (`browser/modules/URILoadingHelper.sys.mjs:1049-1051`, called from
  `switchToTab`, `UrlbarParentController.sys.mjs:1119`). It matches URL and title through
  Places, ranks with history, and shows neither workspace, window nor rename: it is a URL bar
  result, not a list. The only `switchTabs` pref is
  `browser.urlbar.switchTabs.adoptIntoActiveWindow` (`firefox.js:703`, default false).
- **Firefox View** (no keyboard shortcut; menu item `menu_openFirefoxView`,
  `browser/base/content/browser-menubar.inc.xhtml:380`). "Open tabs" lists tabs per window with
  hidden tabs filtered out (`browser/components/firefoxview/OpenTabs.sys.mjs:357`) and separate
  targets for normal and private windows (`:124`, `:146`, `:442-448`). "Recently closed"
  (`recentlyclosed.mjs:167-180`) is `SessionStore.getClosedTabData` plus
  `getClosedTabDataFromClosedWindows` when `browser.sessionstore.closedTabsFromClosedWindows` is
  on (`firefox.js:1565`, default true), sorted by `closedAt`, with the URL from the current
  history entry of the saved state (`getTabStateValue`, `:155`). It reopens with
  `undoCloseById` (`:220`) or `undoClosedTabFromClosedWindow` (`:222`) and dismisses with
  `forgetClosedTabById` (`:263-275`).
- **SessionStore** (`browser/components/sessionstore/SessionStore.sys.mjs`):
  `getClosedTabData(options)` (`:4036`; `browser.sessionstore.closedTabsFromAllWindows`,
  `firefox.js:1564`, default true), `getClosedTabDataForWindow` (`:4013`),
  `getClosedTabDataFromClosedWindows` (`:4057`), `getClosedTabCount` (`:3972`),
  `getClosedWindowData` (`:4630`), `undoCloseById(closedId, includePrivate, targetWindow)`
  (`:4957`), `undoClosedTabFromClosedWindow` (`:4372`), `forgetClosedTabById` (`:4570`),
  `undoCloseWindow` (`:4686`). A closed-tab entry (`#maybeSaveClosedTab`, `:2947-2990`) carries
  `title`, `image`, `closedAt`, `sourceWindowId` and the full `state`, whose `userContextId`
  (`TabState.sys.mjs:210`) is the tab's container, so a reopened tab returns to its workspace's
  container. A private tab closed in a normal window is never saved (`:2953-2957`); a private
  window keeps its own closed tabs. Caps: `browser.sessionstore.max_tabs_undo` 25 per window and
  `max_windows_undo` 5 (`firefox.js:1599`, `:1603`).
- **Audio.** `tab.muted`, `tab.soundPlaying` and `tab.activeMediaBlocked` read attributes
  (`browser/components/tabbrowser/content/tab.js:241`, `:255`, `:263`); `toggleMuteAudio` is at
  `:826`.
- **Lazy tabs.** A lazy browser (`#createLazyBrowser`, `Tabbrowser.sys.mjs:3136`) answers
  `contentTitle` and `currentURI` from `SessionStore.getLazyTabValue(tab, "title" | "url")`
  (`:3150-3160`; `getLazyTabValue`, `SessionStore.sys.mjs:4899`), so reading them loads nothing.
  A lazy tab has no `linkedPanel` (Vimma's `tabById` handles it). Pending tabs carry
  `pending="true"` (`SessionStore.sys.mjs:3016`, `:6527`), and
  `browser.sessionstore.restore_on_demand` is true (`firefox.js:1616`).
- **`ctrl+shift+a`** is `key_openAddons`, command `Tools:Addons`
  (`browser/base/content/browser-sets.inc.xhtml:187`). Firefox has no tab-search key besides the
  all-tabs panel's conditional `ctrl+shift+tab`.

### Zen

Checked against Zen 1.23.1b (built on Firefox 157.0.1, `application.ini`), by unpacking its
installed `browser/omni.ja`; no Zen source tree is checked out. Zen's command palette is a URL
bar provider (`modules/ZenUBActionsProvider.sys.mjs:139`, `ZenUrlbarProviderGlobalActions`, with
actions in `ZenUBGlobalActions.sys.mjs`) that offers "switch to workspace" entries (`:178-197`),
but Zen has **no tab-search list**. Its patched `switchToTabHavingURI` walks every workspace's
browsers (`modules/URILoadingHelper.sys.mjs:1028`, `gZenWorkspaces.allUsedBrowsers`) and switches
workspace when needed (`:1084`), so Zen's tab search is Firefox's `%` across spaces. The one idea
to borrow, "switching to a tab in another space switches the space", Vimma's picker already
does.

## Design

Data flow: the host (`host/tab-search.mjs`, new) collects items from every browser window on
the same side of the private line, this one first (`gotoItems`, extended, for each), and
SessionStore's closed tabs and windows. The pure core (`tabsearch.mjs`, new) orders them into
sections, applies the private filter, the caps and the accessible names; `picker.mjs` matches,
ranks and handles keys and returns effects; the host applies them (go to a tab, reopen a closed
one).

1. **Extend the goto picker; no second picker.** `goto.picker` becomes tab search: the same
   dialog, the same core state machine. Two lists that both find tabs would split muscle memory,
   tests and docs; Chromium and Brave have one. Its heading becomes "Tabs", its action name
   stays `goto_picker` (a config name users may have bound), and its help text becomes "Tab
   search: every tab, every window, recently closed". A separate tab-search picker beside the
   goto picker was rejected: it would keep the goto picker's look and baseline unchanged, at the
   cost of two lists with overlapping jobs and duplicated keys, tests and docs.
2. **One key, ready to type.** Tab search is `ctrl+b g` (and `b` in normal mode, `:ls`), and
   it opens with the cursor in the search, as Chromium's Tab Search does: the first thing a user
   does in it is type. There is no browse mode, so every letter types (`j`, `k`, `q`, `/` and
   `x` too), `ctrl+n` / `ctrl+p` and the arrows move, and one `Esc` closes it. `:tabsearch
[text]` (aliases `:ts`, and `:b`, after Vim's `:b {name}`) opens it with the text already
   typed. One key to remember was chosen over a second action on a find group (`ctrl+b f f`
   for tab search beside live grep's `ctrl+b f g`): the goto picker already finds tabs, so a
   second key for the same list would only add a binding to learn. `b` stays because it is
   bound today and does not conflict. `ctrl+shift+a`, Chromium's key, stays `addons_manager`
   (firefox-keys, fate a), because Firefox users expect it there; a user who wants it writes
   `keys.goto_picker = ["prefix+g", "ctrl+shift+a"]`. The workspace and add-on pickers keep
   their browse mode. (Since changed: Firefox 159 made `ctrl+shift+a` its own tab search and
   moved Add-ons to `ctrl+shift+f`, so `ctrl+shift+a` is now a default key of `goto_picker`;
   [firefox-keys](firefox-keys.md) decision 17's note.)
3. **What it lists, in order** (blank query):
   1. The current window's workspaces: the current workspace first, then the window's workspace
      order, the agent workspace last (decision 6). Before, the current workspace sat wherever
      it fell in the order. Putting it first keeps the selected row, which the picker opens on,
      near the top, and the nearest tabs nearest. Chromium's recency order with the visible tab
      at the bottom was rejected: Vimma's tabs are organised by workspace, and a list that
      reorders on every switch defeats `Tab` section jumps.
   2. Every other normal window, most recently used first (`BrowserWindowTracker.orderedWindows`),
      each window's workspaces in its own order. Rows carry the window as `w2`, `w3`: the
      window's position when the picker opens, so window 1 is always this one. Listing this
      window only, as before, was rejected because a tab in another window would stay
      unfindable from the keyboard; a config switch that limits the list to this window was
      left out until there is a need for it, since Chromium lists every window without one.
   3. "Recently closed": closed tabs of every normal window, newest first, then closed windows
      as one row each (`3 tabs · closed window`). The caps are 25 tabs and 5 windows, matching
      Firefox's own `browser.sessionstore.max_tabs_undo` (25 per window) and `max_windows_undo`
      (5). The section matches Chromium's and Firefox View's "Recently closed" and uses the
      SessionStore calls Firefox View already relies on. Closed tabs without closed windows were
      rejected because a closed window would then have no keyboard path besides
      `restore_window`, which reopens only the last one; leaving both out would keep
      `ctrl+shift+t` as the only way back and leave behaviour 2 unsolved.

   A section starts with a heading row (`role=presentation`, not an option), so moving skips
   it: `work · 12`, `personal · 40 · w2`, `Recently closed · 9`. With a query, matches are ranked
   across sections by score, and each row still shows its workspace, window and `closed` tag.

4. **A row** reads: index (the tab's number in its workspace, blank for a closed tab), the
   display label with highlights, then a muted cell: workspace name, window (`w2`, other windows
   only), markers; then the host. Markers are `♪` (playing), `muted`, `pinned`, `◇` before the
   agent workspace's name, and `closed` (`closed window`). The marker words (`playing`, `muted`,
   `pinned`, `agent`, `closed`) are searchable as a fifth field, `markers`, weight 50, so
   `playing` finds the audible tabs, as Firefox's all-tabs panel lists them apart. Highlights
   also cover the host cell where a URL match falls inside the host.
5. **Private stays private.** A normal window's tab search never lists a private tab, open or
   closed (private-workspace decision 5b). The private window's tab search lists only the
   private workspace's tabs and its own closed tabs, never another window's. Firefox draws the
   same line: Firefox View keeps separate targets for normal and private windows, and
   SessionStore never saves a private tab closed in a normal window (Research). A test pins each
   direction.
6. **Agent workspace: listed, marked, last.** Its tabs show `◇ agent` and come after the user's
   workspaces in each window; a tie in score never ranks an agent row above a user row (a tie
   breaker, not a score penalty). With `[mcp]` off and the agent workspace empty, nothing shows.
   Listing them is what lets the user see what an agent opened and go there; hiding them was
   rejected for that reason. A closed agent tab is marked `◇` too, and reopens in the agent
   container because SessionStore's saved `userContextId` puts it there. Listing them only
   while `[mcp]` is on was rejected too: an agent's tabs outlive the setting, and the user must
   still be able to find them.
7. **Tab search finds; the side panel manages.** The list has no key that changes a tab: no
   close, forget, reopen-and-stay or move. Closing, moving and reordering tabs belong to the
   side panel (`ctrl+b b`: `x`, `m`, marks), which shows one workspace's tabs as a list to work
   on; tab search is a list to leave. Management keys in a type-first list would need a mode
   switch before every letter that is also a key, which is the browse mode decision 2 removes,
   and two places that close tabs would split the habits the side panel builds. `Enter` on a
   closed row reopens it, because going to a closed tab means reopening it. `Tab` /
   `shift+tab` jump to the next / previous section with or without a query, because neither
   types a character. These are the picker's own keys, not keymap bindings (as before,
   m2-picker-rename "Keys"); the hint line lists them.
8. **`Enter` on another window's tab** focuses that window (`win.focus()`), selects the tab
   (WindowWorkspaces' `TabSelect` path switches its workspace if needed, as before) and closes
   the picker in this window. On another workspace in this window it behaves as before. A row
   whose tab closed while the list was open does nothing.
9. **Lazy tabs stay lazy.** Title and URL come from `linkedBrowser.contentTitle || tab.label` and
   `linkedBrowser.currentURI`, as before (`host/goto.mjs`); for a pending tab, SessionStore's
   lazy browser answers both without loading (Research). Closed tabs come from
   `SessionStore.getClosedTabData({ private })` (title, and the URL of the saved state's current
   history entry) and closed windows from `getClosedWindowData`; `undoCloseById` reopens
   either. Nothing is fetched. Favicons are not shown: Vimma's picker is text, and loading icons
   for hundreds of rows is the cost Chromium pays with a virtual list.
10. **Performance.** The list is built once when the picker opens; matching runs per key over at
    most a few hundred items. Each text's grapheme units are cached, so a key segments only the
    query, not every title and URL again, and a field whose letters cannot occur in order is
    skipped before any tier is tried. Budget: 500 open and 25 closed items, a 22-key sequence,
    each key under 8 ms in Vitest (a test in `picker.test.mjs`). At most 200 rows are rendered,
    a window that follows the selection with `… N more` rows above and below, so `ctrl+n` and
    `Tab` still reach every row. Chromium answers the same problem with a virtualised list
    (`selectable_lazy_list.ts`); a fixed window is simpler and enough for a list one narrows by
    typing.
11. **Accessibility.** The same listbox and option semantics and `aria-activedescendant` as
    before. Heading rows are `role=presentation`, and the section's name is in each option's
    accessible name instead (`"Jira 412, work, window 2"`, `"Docs, work, recently closed"`),
    because a listbox cannot hold headings. A polite live region announces `12 tabs` or
    `no tabs match` after a query change, not on every move (as Chromium's
    `getA11ySearchResultText_`). Every marker is a word, or a glyph with an accessible word (`♪`
    is announced "playing").
12. **Theme.** Existing tokens only: headings `--vimma-text-accent`; the muted cell
    `--vimma-fg-dim`, as the host cell (`--vimma-muted` is a border colour whose contrast as text
    is not checked, `tools/test/chrome-css.test.mjs`); the `closed` tag in italics; `◇` in the agent's colour, `--vimma-text-cyan`
    (vimma-mcp decision 24). No new token, so Omarchy and the built-in themes work unchanged.
13. **Out of scope.** Tabs in other Firefox profiles; synced tabs from other devices (Firefox
    View has them; Vimma keeps Sync as Firefox has it, m0-mozilla-services); searching page
    content (Firefox has no index of it, and loading lazy tabs to search them breaks decision 9;
    live grep covers loaded pages); tab groups (Vimma has workspaces); AI grouping and Brave's
    Tab Focus Mode; favicons in the list; a toolbar button (Vimma has no tab strip); managing
    tabs from the list (decision 7).

## Security and privacy

Tab search is chrome UI in the user's own window and adds no control-socket command, so nothing
new is exposed to `vimma-ctl` or to an agent connection; an agent cannot open, read or drive the
picker. The data it shows (titles and URLs of open and closed tabs) is already visible in
Firefox View and the URL bar's `%` mode. The two boundaries that matter are enforced and tested:
a normal window never lists a private tab, open or closed (decision 5), and agent tabs are
always marked so the user can tell them apart (decision 6). The list changes no tab besides
selecting one or reopening a closed one, so it cannot move a page into the agent workspace.
Closed-tab data is read from SessionStore in the parent process and never leaves it.

## Tests

Written first and seen to fail.

### Vitest (`packages/vimma-core/test/`)

- `picker.test.mjs` ("tab search"):
  - `pickerItems` with an agent id and a window: the current workspace first, the agent
    workspace last, other windows in their own order with `window: n`; rows carry `playing`,
    `muted`, `pinned`, `agent` and their marker words.
  - `filterItems`: `playing`, `muted` and `closed` match the `markers` field; a closed item
    matches title and URL with URL highlights; a tie never ranks an agent row first.
  - `pickerKey`: `Enter` on a closed row gives `{ type: "reopen", id }`, on a tab `select`; `x`,
    `u`, `m` and `d` do nothing; `tab` / `shift+tab` jump sections with and without a query and
    stay in search; type-first: every letter types, `Esc` closes, `ctrl+n` / `ctrl+p` and the
    arrows move; `openPicker(items, { typeFirst, query })` starts typing with the query applied.
  - The budget of decision 10: 500 + 25 items, 22 keys after warm-up passes, each key's fastest
    of five passes under 8 ms, and no text segmented again (`unitsBuilt`).
  - The workspace picker's `m` still moves, and the goto picker's `m` does nothing.
- `tabsearch.test.mjs` (new, pure): the order (this window, other windows, closed tabs newest
  first, closed windows); the private filter in both directions; the caps (25 and 5); a closed
  agent tab's marker; section keys and headings; accessible names; the live count text; the
  200-row window.
- `cmdline.test.mjs`: `:tabsearch [text]`, `:ts` and `:b [text]` run `goto.picker` with the
  text; `:tab` completes `tabnew`, `tabrename`, `tabsearch`.
- `help.test.mjs`: the `goto_picker` row keeps `ctrl+b g, b` with the new description, and there
  is no `tab_search` row. The help snapshot is re-recorded and `docs/bindings.md` and
  `bindings.json` are regenerated.

### Mochitests (`tests/browser/`)

- `browser_vimma_tab_search.js` (new): headings with the current workspace first (headings are
  not options, the dialog is named "Tabs"); it opens typing (`/` shown, `j` and `x` type, one
  `Esc` closes, `:tabsearch jira` opens with the query and `Enter` goes there); another
  window's tab is listed as `w2` and `Enter` focuses that window and selects it; three closed
  tabs, `Tab` reaches the newest, `Enter` reopens the second in its workspace's container with
  its two history entries and switches to its workspace; a closed window is one row and `Enter`
  reopens it; a lazy tab is listed with title and host and stays lazy; `♪` and `muted` are shown
  and `playing` finds the tab; an agent tab is marked `◇ agent` and listed last, and a closed
  agent tab reopens in the agent container.
- `browser_vimma_picker.js`: arrows and `ctrl+n` / `ctrl+p` move and `j` types; the Finnish
  ranking test types without `/`; one `Esc` closes; `:ls` and `b` open it.
- `browser_vimma_private_workspace.js`: a normal window's tab search lists no private tab, open or
  closed; the private window's lists its own closed tab and no normal tab, open or closed.
- `browser_vimma_a11y.js`: the dialog and listbox are named "Tabs", an option's name includes its
  workspace, headings are not options, and the polite live region says `no tabs match` and a
  count.
- `browser_vimma_workspace_switching.js`, `browser_vimma_pane_focus.js` and
  `browser_vimma_side_panel_unsplit.js` type their queries without `/`.

### e2e and screenshots

Checked in Xvfb with the Omarchy theme (`vimma.theme.source=omarchy`) through a throwaway
scenario: two workspaces, a closed tab and a second window, blank and with a query, and the
`ctrl+b ?` overlay filtered to the row. No committed baseline: the rows show the fixture
server's host, whose port changes on every run, so a screenshot of the list differs between
runs by more than the harness's 0.5 % tolerance.

## Docs and changelog

- **`docs/guide.md`**: "Goto picker and tab rename" becomes "Tab search and tab rename": what is
  listed and in what sections, the keys, the markers, other windows, recently closed, the
  private and agent rules, and the pointer to the side panel for managing tabs. Also the keys
  table row for `ctrl+b g`, `b`; the command table (`:ls`, `:tabsearch`, `:ts`, `:b`); and the
  workspaces paragraph, which now says tab search lists other windows' tabs too.
- **README**: the feature list's picker line becomes "tab search: every tab of every workspace
  and window, and recently closed, fuzzy by title, URL or your rename".
- **`docs/bindings.md`, `bindings.json`**: regenerated with `npm run gen-docs` (the description).
- **`CHANGELOG.md` [Unreleased]**, added by the maintainer at merge. Suggested line: "Tab search:
  `ctrl+b g` opens ready to type and finds tabs in every workspace and window and recently
  closed tabs and windows; rows show workspace, window, audio and agent markers".

## Delivery

| #   | Title                                                                           | Scope                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `feat(picker): tab search finds every tab, in every window and recently closed` | Core (`picker.mjs` type-first, sections, markers, cache; `tabsearch.mjs`), host (`tab-search.mjs`, `goto.mjs`), UI and CSS, `:tabsearch`/`:ts`/`:b`, help description and gen-docs, guide and README, the tests above. |

One pull request, because the list, its type-first keys and the cross-window and closed data are
one change to one picker.

## Open questions

None. Every question is answered in Design.
