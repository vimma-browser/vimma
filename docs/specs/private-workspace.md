# Spec: private-workspace

Status: implemented (#142; placement on Hyprland revised by [private-swap](private-swap.md)) ·
Milestone: after M3 (builds
on [m3-workspaces](m3-workspaces.md) and the side panel) · Area: `packages/vimma-core/src/`
(`privatews.mjs` new, `actions.mjs`, `defaults.mjs`, `cmdline.mjs`, `picker.mjs`,
`sidepanel.mjs`, `statusbar.mjs`); `host/workspace-ops.mjs`, `host/VimmaHost.sys.mjs`,
`workspaces/WindowWorkspaces.sys.mjs`, `ui/side-panel.mjs`, `ui/statusbar.mjs`,
`ctl/VimmaControl.sys.mjs`. No upstream patch.

Engine paths are relative to `engine/` (Firefox 157.0.1). Zen paths are inside the omni.ja
files of Zen 1.23.1b (`~/Downloads/zen`, BuildID 20261006042626), unpacked to a scratch
directory.

## Goal

Private browsing opened with a key, as a private workspace inside the Vimma window rather than a
separate private window, with the guarantees of a private window.

## Short answer

Not in full, without forking Firefox's front end. Gecko's core could keep private and normal tabs
apart inside one window. Firefox's front end could not: about 220 places decide privacy by
window, and every one of them would leak a private tab's data into the normal profile. The design
below gives the user the workspace experience with private-window guarantees that are real,
because they are Firefox's own. The "private workspace" is Firefox's private window, and Vimma
presents it as one more workspace. You switch to it with the workspace keys, the picker lists it,
and the status bar and side panel show it. On Hyprland it can share the Vimma window's frame as a
window group. It is still a second window of the window manager, and this spec says so plainly.
Anything short of real private browsing (a throwaway container) is rejected under the name
"private".

## User stories

- As a user, `ctrl+b shift+p` (or `ctrl+shift+p`, or `:private`) takes me to my private
  workspace and opens it if there is none. Pressing it again in the private workspace takes me
  back to the workspace I came from.
- As a user, `ctrl+b )` / `ctrl+b (` in the private workspace take me to my first / last
  workspace, and cycling in a normal window never enters it. `ctrl+^` in it takes me back to the
  workspace I left. `ctrl+b w` lists it as the last row, with its tab count, or `new` when it is
  closed.
- As a user, in the private workspace the status bar says `◆ private`, and `ctrl+b b` lists its
  tabs. Splits, hints, find, copy mode and the command line work as in any workspace.
- As a user, nothing I do in the private workspace stays on disk. That covers history, cookies
  and site storage, cache, form history, the downloads list, session restore and Vimma's own
  files. It is the same as a Firefox private window, because it is one. Add-ons run there only
  if I allowed them in private windows. Searches use the private search engine if I set one.
- As a user, `ctrl+b shift+d` in the private workspace asks
  `Close the private workspace (5 tabs)? Its history, cookies and site data are discarded. y/N`.
  Then it closes it and the data is gone.
- As a user on Hyprland (Omarchy), I can make the private workspace open in the same frame as my
  Vimma window (a window group), so switching swaps what the frame shows. The guide says how,
  and says that without a group it is a second tiled window.

## Research

### How Gecko decides that a page is private

- **Privacy belongs to the browsing context, not to the window, in the engine core.**
  `BrowsingContext::SetPrivateBrowsing` sets `mPrivateBrowsingId` and syncs it into the
  context's origin attributes (`docshell/base/BrowsingContext.cpp:1897-1925`). It can only be
  set before the context attaches (`CanSetOriginAttributes`, same lines). Each top-level content
  context is counted on its own. `CanonicalAttach` / discard increase and decrease a global
  count of private content contexts (`docshell/base/CanonicalBrowsingContext.cpp:88-125,
1766-1775`). When the count reaches 0 it fires `last-pb-context-exited` (unless
  `browser.privatebrowsing.autostart`). About 35 services clear their private data on that
  signal: cookies (`netwerk/cookie/CookieService.cpp`), cache (`netwerk/cache2/CacheObserver.cpp`),
  DNS, TLS session tokens, permissions, quota storage, service workers, image cache, media cache,
  `ClearDataService.sys.mjs:2584` and more (grep `last-pb-context-exited`, 36 non-test files).
  The signal is global, so private data is cleared when the last private tab anywhere closes.
- **History, cookies, cache and HSTS follow the context.** The docshell records global history
  only when `!UsePrivateBrowsing()` (`docshell/base/nsDocShell.cpp:12879`). Channels take
  privacy from the load context or origin attributes (`docshell/base/SerializedLoadContext.cpp:39-48`).
  Private cache entries never touch disk (`netwerk/cache2/CacheStorageService.cpp:899-905`).
  HSTS keeps private entries apart (`security/manager/ssl/nsSiteSecurityService.cpp:310, 353`).
  Process selection keys on the principal's origin attributes
  (`dom/ipc/ProcessIsolation.cpp:429-463`), and `toolkit/modules/E10SUtils.sys.mjs` has no
  privacy logic (grep). So process choice needs no change for a private tab.
- **But a `<browser>` cannot ask to be private.** `nsFrameLoader::EnsureBrowsingContextAttached`
  takes the flag from the parent document's context (the chrome window) and applies it
  (`dom/base/nsFrameLoader.cpp:3783-3846`, lines 3792, 3819, 3845). The only per-`<browser>`
  overrides are `usercontextid` and `geckoViewSessionContextId`, both for XUL elements only
  (`PopulateOriginContextIdsFromAttributes`, 3567-3593). Nothing reads a `private` attribute.
  So "is this tab private" is "is its window private", fixed when the window is created
  (`CHROME_PRIVATE_WINDOW`, `xpfe/appshell/nsAppShellService.cpp:410-411, 580-585`).
- **Popups have to match their opener.** `BrowsingContext` coherency checks require an opener and
  its popup to have the same `mPrivateBrowsingId` (`BrowsingContext.cpp:903-913`). Today a
  `window.open` from a private tab lands in the same private window, so they always match.
  `BrowserDOMWindow` takes privacy from `openWindowInfo` (`browser/modules/BrowserDOMWindow.sys.mjs:322-324`),
  but `#openURIInNewTab` opens the tab in the current window whatever its privacy (107-114).
  With mixed windows, that path would create a private opener with a non-private popup.
- **GeckoView's "per-session" privacy is per window.** Each `GeckoSession` is its own chrome
  window, opened with `,private` when the session is private
  (`widget/android/nsWindow.cpp:1867-1873`; `mobile/android/geckoview/.../GeckoSession.java:1834`).
  Android's private tabs are private windows underneath, so no Gecko embedder runs mixed privacy
  in one window.

### How the front end decides (per window, everywhere)

- `PrivateBrowsingUtils.isBrowserPrivate(browser)` returns **the chrome window's** privacy under
  e10s (`toolkit/modules/PrivateBrowsingUtils.sys.mjs:35-46`: "we have to look at the chrome
  window's private browsing status"). `isWindowPrivate` has 208 non-test callers under
  `browser/` and 14 under `toolkit/`. `isBrowserPrivate` has 41 and 17, all of them window
  answers in e10s.
- **URL bar:** `isPrivate` is read once, when the window's input is built
  (`browser/components/urlbar/content/UrlbarInputBase.mjs:307`). It controls the default engine,
  history and search suggestions, and switch-to-tab results. The open-pages table marks private
  tabs by window (`UrlbarShared.mjs:495-496`, `PRIVATE_USER_CONTEXT_ID = -1`).
- **SessionStore:** a window is private or not (`SessionStore.sys.mjs:1487-1488`). The file
  writer drops private **windows** only. `PrivacyFilter.filterPrivateWindowsAndTabs` removes
  windows despite its name (`toolkit/modules/sessionstore/PrivacyFilter.sys.mjs:108-125`;
  callers `SessionSaver.sys.mjs:263`, `SessionStore.sys.mjs:1954`). A tab-level `isPrivate`
  exists only to keep private tabs out of a normal window's closed-tab list (2916-2920).
- **Extensions:** a tab's `incognito` is its window's (`browser/components/extensions/parent/ext-browser.js:1050-1052`).
  Tab access is checked "at browser window level" (1296-1299, `canAccessWindow`). Tab ids of a
  non-private window are handed to add-ons that are not allowed in private browsing
  (`toolkit/components/extensions/parent/ext-tabs-base.js:70`).
- **Downloads** pick the private or public list by window (`browser/components/downloads/DownloadsCommon.sys.mjs:795-828`).
  **Form history** is skipped for private content windows
  (`toolkit/components/satchel/FormHistoryChild.sys.mjs:48-53`); that check is per context.
- **Search** uses the private default engine in a private window
  (`browser/components/search/SearchUIUtils.sys.mjs:283, 427, 445`).
- **Tab moves:** Firefox refuses to move a tab between private and non-private windows
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:7119-7125`, drag and drop `content/drag-and-drop.js:2929`,
  `browser/components/extensions/parent/ext-tabs.js:1731-1735`).
- **Firefox View, the sidebar's open tabs and split view's tab picker** list tabs by window
  privacy (`browser/components/firefoxview/OpenTabs.sys.mjs:124, 146, 442-448`;
  `tabbrowser/content/opentabs-splitview.mjs:40-44`).
- **External links** go to the most recent **non-private** window unless permanent private
  browsing is on (`browser/components/BrowserContentHandler.sys.mjs:1324-1330`).
- **No per-tab private browsing in Firefox.** A grep for "private tab", "PrivateTab" and
  "per-tab private" over the engine's non-test code finds only window-level uses. The comments
  that say "private tab" mean a tab in a private window, as Tabbrowser.sys.mjs:7119 and
  SessionStore.sys.mjs:2916 do. No code or comment plans mixed windows.

### Split view and PaneView

Firefox's split view and Vimma's `PaneView` arrange the panels of one tabbrowser, inside one
window. A private tab would need to share a window with normal tabs to sit next to one, so the
question is the same as above. Under the chosen design the private workspace has its own
`PaneView` (it is its own window), and its splits hold only private tabs. Firefox refuses
cross-privacy swaps (`swapBrowsersAndCloseOther`, Tabbrowser.sys.mjs:7119-7125). No private
pane can sit beside a normal one.

### Prior art

- **Zen (verified in its omni.ja):** private browsing is a separate private window. Zen's spaces
  are off there (`privateWindowOrDisabled`, `browser/modules/zen/ZenSpaceManager.mjs:707-721`).
  The window shows one synthetic space named "Incognito" with a private-window icon (2674-2681).
  This is the same shape as alternative A, minus switching from the normal window. Zen's
  `Tabbrowser.sys.mjs` (`gre/moz-src/...`) has no per-browser private flag. Its
  `zen-private-browsing-shortcut` is only listed in `ZenKeyboardShortcuts.mjs:78`, and the
  command behind it is not in the JS we can read.
- **Floorp and other forks:** not installed locally; nothing is claimed about them.
- **GeckoView / Firefox for Android:** per window, as above.

### Hyprland and Omarchy (what A depends on)

Checked on this machine with Hyprland 0.56.2 and Omarchy's defaults:

- `misc:focus_on_activate = true` (Omarchy `default/hypr/looknfeel.lua:109`, and
  `hyprctl getoption` confirms it). An activation request from Vimma raises and focuses the other
  window, so a key in one Vimma window can bring the other forward.
- `group:auto_group = true` (`hyprctl getoption`, the default). While a grouped window has focus,
  a new window joins its group. Omarchy binds `SUPER+G` to toggle grouping
  (`default/hypr/bindings/tiling.lua:73`) and themes the group bar (`looknfeel.lua:34-50`). With
  Vimma in a group, the private window opens as a second tab of the same frame. Focusing it then
  swaps what the frame shows. That is the closest a WM gets to "same window".
- `misc:on_focus_under_fullscreen = 1` (`looknfeel.lua:111`): a window focused while another is
  fullscreen takes over the fullscreen slot.
- Vimma's windows have class `vimma-vimma` (`hyprctl clients`). GTK gives private windows the same
  class: `widget/gtk/nsWindow.cpp`'s `RefreshWindowClass` (4626+) does not depend on privacy.
  Only the title differs. Firefox appends the private-window suffix
  (`Tabbrowser.sys.mjs:1775-1807`).
- On Wayland a client cannot place its windows, and a tiling WM ignores size requests. Vimma can
  match the size and position of the private window to the current one on X11 or a floating WM,
  but not on Hyprland.

### Vimma today

- Private windows work and have no workspaces: `WindowWorkspaces` does not start in them
  (`workspaces/WindowWorkspaces.sys.mjs:176`), and `WorkspaceStore.defaultUserContextId` returns
  null for them (`WorkspaceStore.sys.mjs:431-445`). The side panel shows a notice
  (`ui/side-panel.mjs:69`). The goto picker lists the window's own tabs (`host/goto.mjs:31`), and
  `limits.md` says "Private windows and pop-ups have no workspaces".
- The command line keeps a separate in-memory history for each private window and never writes
  it (`ui/cmdline.mjs:38-41, 57-62, 95`).
- `vimma-ctl`'s `state` reports the top window, including a private one, with tab URLs and titles
  (`ctl/VimmaControl.sys.mjs:97-98`; protocol spec, `workspace: null` "in a private window").
- The add-on picker toggles "run in private windows" (`host/addon-ops.mjs:281-303`).
- Keys: `[keys]` (`packages/vimma-core/src/defaults.mjs:49-91`) has no `prefix+shift+p`. Pending
  PRs: #136 takes `prefix+u` (toolbar), #137 takes no key. A chord with `ctrl`/`alt`/`meta` in
  `[keys]` is global, in every mode (`keymap.mjs:153-160`). Vimma consumes a key it binds
  (`consume`, `host/VimmaHost.sys.mjs:753-756`), so Firefox's own `<key>` for that chord does not
  run. Firefox binds `ctrl+shift+p` to `key_privatebrowsing`
  (`browser/base/content/browser-sets.inc.xhtml:350`) → `Tools:PrivateBrowsing` →
  `OpenBrowserWindow({ private: true })` (`browser-sets.js:299-300`), a new private window on
  every press.

## The three options

### C. Real per-tab private browsing in one window: rejected

What it would take, at minimum:

1. A C++ patch to `nsFrameLoader` so a XUL `<browser privatebrowsing="true">` starts private,
   like `usercontextid`. This means a full Gecko build, not `surfer build --ui`. It touches the
   most security-sensitive part of the engine we carry.
2. Patches so popups and `target=_blank` from a private tab get a private `<browser>`
   (`BrowserDOMWindow` 107-114 and `#createTab`). Without them the opener coherency check
   (`BrowsingContext.cpp:903-913`) rejects the popup, or a private page opens a normal one.
3. A rewrite of `PrivateBrowsingUtils.isBrowserPrivate`, and then a review of about 220 call
   sites that ask the window. Each one is a leak or a broken feature. The ones that leak into the
   normal profile:
   - SessionStore writes the tab to `sessionstore.jsonlz4`, because the filter drops windows, not
     tabs (PrivacyFilter.sys.mjs:108-125). URL, title, form data, scroll and session history
     reach disk.
   - The URL bar is built once per window (UrlbarInputBase.mjs:307). A search typed for a private
     tab uses the normal engine. It can be stored as form history or a recent search, it gets
     history suggestions, and its URL goes into the open-pages table as a normal tab.
   - Add-ons not allowed in private see the tab, its URL and title, and its events through `tabs`
     and `windows` (ext-browser.js:1050-1052, 1296-1299).
   - Downloads from it go to the public list (DownloadsCommon.sys.mjs:795-828).
   - Firefox View, the sidebar's open tabs and split view's picker list it among non-private tabs
     (OpenTabs.sys.mjs:124, 146).
   - The window title shows its page title with no private suffix, which the WM and screen
     sharing then see.
   - Undo-close-tab, tab groups, PiP, sharing and screenshots each check the window.
4. A second review on every Firefox release (four weeks), because every new `isWindowPrivate`
   call upstream is another leak.

Verdict: the engine core could do it, and that is the encouraging part. The front end is the
problem: the patch set is large, spread out and silent when it fails. A missed call site leaks
private data without any error. No fork does this, and Mozilla never planned it. Rejected; see
decided question 7 for what would change this.

### B. A throwaway container workspace: rejected as "private"

A workspace with its own `userContextId` whose site data is cleared when it closes
(`ContextualIdentityService.remove` clears by `userContextId`, m3-workspaces research).
`<browser disableglobalhistory>` would also keep history out
(`docshell/base/BrowsingContext.cpp:816-817`). It would need a `Tabbrowser` patch, because the
attribute only counts when the context is created.

| Private-window guarantee             | Throwaway container                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No history                           | Only with a new `Tabbrowser` patch (`disableglobalhistory`); favicons and the open-pages table still see it                                                        |
| Cookies and storage discarded        | Yes, on close (`deleteDataFromOriginAttributesPattern`), but they live on disk until then and after a crash                                                        |
| Cache in memory only                 | No: the disk cache is used, then cleared                                                                                                                           |
| HSTS and site permissions kept apart | No: HSTS is not keyed by container (`nsSiteSecurityService.cpp:249-252, 264-267`), and permissions are shared                                                      |
| No form history                      | No (`FormHistoryChild.sys.mjs:48-53` checks privacy only)                                                                                                          |
| No session restore                   | No: SessionStore writes its tabs; a crash restores them                                                                                                            |
| No downloads list entries            | No (the public list)                                                                                                                                               |
| Add-ons only if allowed in private   | No: every add-on sees it                                                                                                                                           |
| PBM-only settings (`*.pbmode` prefs) | No: `network.cookie.cookieBehavior.pbmode`, `network.http.referer.defaultPolicy.pbmode` and the rest (`StaticPrefList.yaml:14596+`) apply only to private contexts |
| Private search engine                | No                                                                                                                                                                 |
| Same window, workspace keys          | Yes                                                                                                                                                                |

Verdict: it keeps the single window and fails most of the guarantees. Calling it
"private" would mislead, which is a security problem in itself. Rejected as the private
workspace. A "scratch workspace" whose data is wiped on close could be its own feature under its
own name, if wanted. It is out of scope for now (decided question 5).

### A. The private window presented as a workspace: chosen

Every guarantee is Firefox's own, unchanged, because the private workspace is a private window.
Vimma adds the workspace experience on top: keys, cycle position, picker row, status bar, side
panel. It patches nothing. The cost is that it is a second WM window, which the WM shows next to
or in front of the first. Under Hyprland a window group makes it share the frame; without one
it tiles beside Vimma.

UX, honestly:

- **Grouped (recommended on Hyprland):** the private workspace is a second tab of the Vimma frame.
  `ctrl+b )` swaps the frame to it. The group bar shows both titles, and the private one has
  Firefox's private suffix. This comes close to a workspace in the same window.
- **Not grouped (Omarchy's default dwindle):** opening it splits the screen, and both stay visible.
  Switching moves the focus. This is a private window with Vimma keys, and the guide must not
  promise more.
- **Fullscreen Vimma:** with `on_focus_under_fullscreen = 1` the private window should take over
  the fullscreen slot when focused. To verify by hand (test plan).
- **Floating WMs and X11:** Vimma opens it at the current window's size and position, so it covers
  the same area.
- **Focus:** the switch is a keypress in a Vimma window, so Firefox has a fresh user-input serial
  for the Wayland activation request, and Omarchy's `focus_on_activate` honours it. Without
  `focus_on_activate` (other setups), Hyprland only marks the window urgent. The guide says so.

## Leak paths, and how the design closes each

| Path                                               | Under A                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History, cookies, storage, cache, HSTS, form data  | Firefox's private window; cleared on `last-pb-context-exited` (above)                                                                                         |
| SessionStore file                                  | Private windows are never written (PrivacyFilter.sys.mjs:108-125)                                                                                             |
| Downloads list, search engine, add-ons, URL bar    | Firefox's per-window rules apply correctly, since the window is private                                                                                       |
| Vimma's `vimma-workspaces.json` / window snapshots | Decision 8a: nothing about the private workspace is written; `WindowWorkspaces` stays off in private windows                                                  |
| Normal window's "previous workspace" (`ctrl+^`)    | Decision 8a: kept in memory only; the saved snapshot keeps the last normal workspace                                                                          |
| Command-line history                               | Already per private window, never written (`ui/cmdline.mjs:38-41`)                                                                                            |
| Goto picker (`ctrl+b g`) in a normal window        | Lists that window's tabs only (`host/goto.mjs:31`); a test pins that no private tab shows                                                                     |
| Workspace picker in a normal window                | Shows the row `private` and a tab count, never titles or URLs                                                                                                 |
| Moving a tab out (`:wsmove`, picker `m`)           | Decision 5: refused from private to normal, as Firefox refuses (Tabbrowser.sys.mjs:7119-7125)                                                                 |
| Workspace routing                                  | Decision 8c: never routes into or out of the private workspace                                                                                                |
| `vimma-ctl state` of a private window              | Decision 8d: URLs and titles withheld by default                                                                                                              |
| Bookmarks added from it                            | An explicit act, as in Firefox; it goes where a window without workspaces puts it (`host/bookmark-ops.mjs:94`)                                                |
| Status-bar notices in a normal window              | Decision 8e: no notice in a normal window names a private page                                                                                                |
| Copy mode yank / clipboard                         | The system clipboard, as in Firefox; the guide says so                                                                                                        |
| Window title seen by the WM, screen sharing        | Firefox's private suffix; the page title is visible to the WM, as in Firefox                                                                                  |
| Private data shared with other private windows     | One private jar for all private contexts (`privateBrowsingId` is always 1), as in Firefox: every private window is part of the private workspace (decision 4) |

## Decisions

1. **Approach A.** The private workspace is Firefox's private browsing window. Vimma never
   creates private tabs in a normal window and patches nothing for this. User-facing text calls
   it the "private workspace", and the guide's first sentence says it is a private window that
   Vimma treats as a workspace.
2. **Keys and command** (new action `workspace.private`, `[keys]` name `private_workspace`, group
   "Workspaces", all rebindable):
   - `private_workspace = ["prefix+shift+p", "ctrl+shift+p"]`. `prefix+shift+p` is free
     (defaults.mjs, and the pending PRs #136/#137 take no `p`). It mirrors `prefix+shift+n` (new
     workspace), and tmux leaves `P` unbound.
   - `ctrl+shift+p` is Firefox's "New Private Window". Vimma takes it over with the same meaning
     done Vimma's way: go to the private workspace, or open it if there is none, instead of a new
     private window per press. Binding it in `[keys]` makes it global, and `consume` stops
     Firefox's `<key>`. **Coordination with the firefox-keys spec:** that spec turns Firefox's
     shortcuts into Vimma bindings. Its table should list `ctrl+shift+p` → `workspace.private`
     and point here, with no second binding. If it lands first, this spec drops `ctrl+shift+p`
     from its own default and uses that table's entry. If the user unbinds it, Firefox's command
     opens a private window, which still joins the private workspace (decision 4).
   - The command is `:private` (`:priv`). `:private close` closes it, with the question from
     decision 3. `:workspace` / `:ws` names only normal workspaces, so a user workspace named
     `private` keeps its name and `:ws private` reaches it.
   - The action toggles. Outside the private workspace it goes there, opening it if needed. Inside
     it, it goes back to the workspace you came from, as `ctrl+^` does.
3. **Lifecycle.** The private workspace exists while at least one private browser window is open
   (`toolbar.visible`; popups do not count). Opening calls `OpenBrowserWindow({ private: true })`
   from the current window. Its first tab is Vimma's start page, which private windows already
   get (start-page spec). Closing it (`ctrl+b shift+d`, `:wd` or `:private close` in it) asks
   `Close the private workspace (5 tabs)? Its history, cookies and site data are discarded. y/N`
   and then closes every private window. Closing one with the WM (`SUPER+W`) or `ctrl+shift+w`
   is Firefox's normal close. Firefox clears the data when the last private context goes. The
   private workspace can be closed even when it is the only "workspace" with tabs.
   - `browser.privatebrowsing.autostart` (every window private): the key says
     `every window is private (permanent private browsing)` and does nothing.
   - Private browsing disabled by enterprise policy (`PrivateBrowsingUtils.enabled`, line 12):
     `private browsing is turned off by policy`.
4. **Every private window is part of it.** "Go to the private workspace" raises the most recent
   private window (`BrowserWindowTracker.getTopWindow({ private: true })`). The picker counts
   the tabs of all private windows. `ctrl+n` in a private window and Firefox's "Open Link in New
   Private Window" make more of them. They share one cookie jar anyway.
5. **Switching.** The private workspace is reached only by its own key (`workspace.private`),
   `:private` and the picker. It is never a cycle or alternate target, so cycling never drops you
   into it by accident.
   - `ctrl+b (` / `ctrl+b )`, `]w` / `[w`, `:wn` / `:wp` in a normal window cycle the normal
     workspaces only, whether or not private is open: today's cycle, unchanged.
   - In private, `ctrl+b )` goes to the first workspace and `ctrl+b (` to the last, in the most
     recent normal window. Cycling leaves private but never enters it.
   - `ctrl+^` from private goes back to the workspace you left, in the window you left. In a
     normal window `ctrl+^` ignores private: its alternate is the last normal workspace.
   - Going to the other window is `win.focus()`, plus a workspace switch in the normal window
     when the target is not its current workspace. The normal window is left as it is.
   - Workspace picker (`ctrl+b w`, both kinds of window): the normal workspaces, then a last row
     `◆ private · 5 tabs` (or `◆ private · new`). `Enter` goes there. In the private window,
     normal rows switch the most recent normal window. `m` (move this tab) on the private row
     from a normal window reopens the tab's URL in the private workspace after the usual `y/N`.
     The URL is already in normal history, so nothing new leaks, and Firefox has "Open Link in
     New Private Window" for the same thing. `m` on a normal row from the private window, and
     `:wsmove` there, is refused: `a private tab cannot leave the private workspace`.
6. **Status bar and side panel in the private window.** The workspace segment is `◆ private` in
   the theme's magenta. The glyph and the word carry it without colour. The side panel replaces
   today's "no workspaces" notice with the window's tabs under a `◆ private` head. Its neighbours
   are the `ctrl+b (` / `ctrl+b )` targets from decision 5. Marks and "show together" work, since
   they only need a `PaneView`. Normal windows show nothing new beyond the picker row. The
   private window keeps no workspace model (`WindowWorkspaces` stays off). The status bar and the
   panel get their data from a small private-window adapter in the host.
7. **Window placement.** Vimma opens the private window at the current window's size and, where
   the platform allows (X11, floating WMs), its position. On Wayland it does not try, because
   Hyprland decides. ~~Vimma does not run `hyprctl` or any other WM command.~~ **Superseded:**
   on Hyprland the private window swaps into the Vimma window's place, over
   Hyprland's socket. See [private-swap](private-swap.md) and ADR-017. Off Hyprland, or with
   `[private] placement = "window"`, this decision stands as written.
8. **Leak protections in Vimma's own code** (the private window's own guarantees are Firefox's):
   - a. Nothing about the private workspace is written to disk. That covers
     `vimma-workspaces.json` (no `lastActive`), SessionStore window and tab values of normal
     windows (the saved "previous workspace" stays the last normal one, and the in-memory one
     may be `private`), the routing history and any log. Command-line history already behaves.
   - b. A normal window never shows a private tab's title or URL: not in the goto picker, the
     side panel, the workspace picker (count only), help, or `about:vimma`.
   - c. Workspace routing never moves a load into or out of the private workspace. A link from
     another app goes to the normal window, as Firefox does (BrowserContentHandler.sys.mjs:1324-1330);
     the WM focuses it, so you leave the private workspace.
   - d. `vimma-ctl state` of a private window reports `"private": true` and `"workspace":
"private"`, with each tab's `url` and `title` as `null`. Pane structure and each tab's id,
     place, selection, pinning and `loading` are kept, so scripts can still drive it and wait for a page to load. No config
     switch.
   - e. No status-bar notice in a normal window names a page of the private workspace.
9. **Add-ons, search and protections** are Firefox's, per private window. Add-ons need "Run in
   Private Windows" (`ctrl+b e`, `shift+p`), and Vimma's start page and its own UI need no
   add-on. The private default engine applies when
   `browser.search.separatePrivateDefault.enabled` is on. Vimma's `:open @alias` follows the
   search-engines spec's decision 12 (PR #137).
10. **Core** (pure, Vitest): `privatews.mjs` holds the cycle targets seen from the private window
    (`cycleFromPrivate(order, dir)`: first or last normal workspace), the `ctrl+^` target from
    private, the picker's private row, the toggle rule for `workspace.private`, and the
    refusals (`move-out-of-private`, `permanent-private`, `policy-disabled`). The host owns window
    lookup, `OpenBrowserWindow`, focus, sizing and the ctl redaction.
11. **Never "private" for anything else.** No Vimma feature other than this one uses the word
    for something short of Firefox's private browsing (option B, decided question 5).

## Test plan

- **Vitest** `privatews.test.mjs`: cycling from private in both directions; normal cycling and
  the normal `ctrl+^` never return private; `ctrl+^` from private; the toggle; the picker row (count, `new`); the
  refusals. `actions.test.mjs` / `defaults.test.mjs`: `private_workspace` on `prefix+shift+p`
  and `ctrl+shift+p` reaches `workspace.private` in every mode. `cmdline.test.mjs`: `:private`,
  `:priv`, `:private close`. Snapshots (`help.test.mjs.snap`, `defaults.test.mjs.snap`) gain the
  row and keys, with the changelog line the rules ask for.
- **Mochitest** `browser_vimma_private_workspace.js`:
  - `ctrl+b shift+p` opens exactly one private window and focuses it. Pressing it again there
    focuses the normal window back. `ctrl+shift+p` opens no second private window (Firefox's
    `<key>` did not run).
  - With private open, `ctrl+b )` from the last workspace wraps to the first, not to private;
    in private `ctrl+b )` / `(` reach the first and last workspaces; `ctrl+^` from private
    returns to the workspace left, and `ctrl+^` in the normal window does not enter private.
  - The status bar segment `◆ private`, and the side panel listing the private tabs.
  - **No leaks:** the test visits a page in the private workspace, sets a cookie and
    localStorage, types into a form and submits it, starts a download, and adds a tab label.
    Then: `PlacesUtils.history.hasVisits` is false; no form history entry exists; the public
    downloads list is unchanged; `SessionStore.getBrowserState()` written by `SessionSaver`
    holds no private window; `vimma-workspaces.json` and the normal window's
    `vimma-workspaces` window value are unchanged and do not name the private workspace.
  - **Discard on close:** `ctrl+b shift+d` then `y` closes every private window, and
    `last-pb-context-exited` fires. Afterwards the private cookie
    (`Services.cookies.getCookiesFromHost(host, { privateBrowsingId: 1 })`) and storage are gone.
  - A normal window's goto picker, side panel and workspace picker show no private title or URL.
  - Moving a tab: from private to normal is refused with the message; from normal to private, `m`
    reopens it there.
  - `vimma-ctl state` against the private window has `private: true` and null URLs and titles.
  - Permanent private browsing and the policy case give their messages (pref and policy set in
    the test).
- **e2e** `m3-private-workspace` under Xvfb (no WM): open, switch out and back by keys, close.
  A status-bar baseline of the private window, which is a new baseline with its changelog line.
- **Manual on Hyprland/Omarchy** (recorded in Results; Xvfb has no WM): grouped (opens in the
  group, switching swaps the frame), not grouped (tiles beside, switching focuses), fullscreen
  Vimma (`on_focus_under_fullscreen = 1`), and `focus_on_activate = false` (urgent only).

## Docs

- `docs/guide.md`: a "Private workspace" section under Workspaces. It covers what it is (a
  Firefox private window that Vimma treats as a workspace), the keys, what is discarded and
  when, add-ons, search, closing, and the Hyprland recipe with the honest note about tiling.
  It also notes that a link from another app takes you to the normal window. The workspace keys
  table gains the private row. "Firefox's own shortcuts" says `ctrl+shift+p` is Vimma's.
- `docs/limits.md`: replace "Private windows and pop-ups have no workspaces" with the private
  workspace's limits. It is a second WM window. There is one private workspace, not several.
  Private windows have no normal workspaces. Links from other apps never open in it. The private
  cookie jar is shared by all private windows.
- `docs/bindings.md` regenerated; the README feature list gains the private workspace.
- `CHANGELOG.md` [Unreleased]: the maintainer adds it at merge time.

## Upstream patches

None. Option A uses `OpenBrowserWindow`, `BrowserWindowTracker`, `PrivateBrowsingUtils` and
`win.focus()`, which are public chrome API. No ADR line is needed. Option C would have needed a
C++ patch to `nsFrameLoader.cpp` and many front-end hunks. Option B would have needed a
`Tabbrowser` hunk. Both are rejected above.

## Out of scope

Per-tab private browsing in a normal window (option C); a throwaway container workspace
(option B, decided question 5); several separate private workspaces (Firefox has one private cookie
jar); Vimma running WM commands (since reversed on Hyprland: [private-swap](private-swap.md));
restoring a private workspace after a restart (that would break the guarantee).

## Decided questions

1. **Hyprland grouping:** ~~Vimma runs no WM command; the guide documents the `SUPER+G`
   recipe.~~ **Reversed: the private window swaps in place** on Hyprland, in
   [private-swap](private-swap.md).
2. **Scripts and private pages:** `vimma-ctl state` hides private URLs and titles. No switch.
3. **`ctrl+shift+p`:** goes to the private workspace (toggles back from it), same as
   `ctrl+b shift+p`. Firefox's "New Private Window" key no longer runs.
4. **Cycle:** own key only. Private is not in the `(` / `)` cycle or the `ctrl+^` alternate of a
   normal window (decision 5).
5. **Scratch workspace:** not wanted now. Out of scope.
6. **Moving a tab into private:** allowed after the `y/N` prompt (decision 5).
7. **Per-tab private browsing:** rejected until Mozilla supports it upstream.
