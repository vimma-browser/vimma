# Spec: m3-workspaces

Status: implemented, except the leftover in [#260](https://github.com/vimma-browser/vimma/issues/260)
(a key to move a background tab); split into sub-specs (see Breakdown). Sub-specs 1 (store), 2a (routing), 2b
(switching), 3 (persistence), 4a (lifecycle), 4b (move), 5 (picker), 6 (side panel), 7 (e2e
restart scenario) and the 4a/4b/5 leftovers are merged; the 200-tab measurement is in
`browser_vimma_perf.js` (runbook, "Key-to-paint timings") ·
Milestone: M3 · Area: host
(`src/browser/base/content/vimma/workspaces/`, `ui/`), four upstream patch files (five hunks)

Plan §6 M3: container-backed workspaces; hidden tabs; `prefix+)`/`prefix+(`; a `prefix+w` picker; a
`<leader>n` side panel with `panel` mode; SessionStore persistence and restore; `[workspaces]`
config. **Gate:** a login in `work` is invisible in `personal`; a restart restores workspaces,
tabs and scroll positions.

This spec is the umbrella: it records the research, the decisions and the architecture, and
splits the work into one-session sub-specs. The pure model is already specified in
[m3-m4-core-models](m3-m4-core-models.md) (PR #10, `workspaces.mjs`, `snapshot.mjs`) and the
`[workspaces]` schema in [m5-core-config-and-theme](m5-core-config-and-theme.md). Engine paths are
relative to `engine/` (Firefox 157.0.1); Zen paths are relative to `zen-browser/desktop` at
`185e856f`.

## User stories

- As a user, my tabs live in named workspaces (`work`, `admin`, `personal`), each a Firefox
  container: a site I am signed in to in `work` sees no cookies or storage of mine in `personal`.
- As a user, `prefix+)` / `prefix+(` go to the next / previous workspace (wrapping), and I see only
  that workspace's tabs: `prefix+1..9`, `gt`, `ctrl+tab`, `ctrl+pagedown` and closing a tab never
  take me into another workspace.
- As a user, a new tab (`prefix+c`, `t`, `ctrl+t`, a bookmark, a link from another app) opens in
  the current workspace's container; a link opened from a page stays in that page's container.
- As a user, `prefix+w` lists the workspaces (`/` filters); Enter switches. From it I can also
  move the current tab to another workspace, after a warning that the page is reopened and its
  history and form state are lost.
- As a user, `prefix+shift+n` / `prefix+shift+w` / `prefix+shift+d` create, rename and close a
  workspace. Closing asks first when it has tabs, and says whether the site data goes too.
- As a user, `prefix+b` opens a panel on the left headed by the current workspace
  (name, colour, `prefix+(` / `prefix+)` neighbours), listing its tabs as numbered rows; `1-9`, `j/k`,
  Enter pick a tab; `prefix+b` / `Esc` close it.
- As a user, `[workspaces]` in `config.toml` defines my workspaces, their order, colour, icon and
  home page; without it I get one workspace and can add more at runtime.
- As a user, quitting and restarting vimma brings back every workspace, every tab in the right
  workspace and container, the active workspace and tab, and each page's scroll position.

## Research (Firefox 157 engine)

### Containers (contextual identities)

- **API** (`toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs`, CIS below):
  `create(name, icon, color)` (391-432) returns an identity with a fresh `userContextId` from an
  ever-increasing counter (`++_lastUserContextId`); it does **not** validate icon or colour (only
  the WebExtension API does, `toolkit/components/extensions/parent/ext-contextualIdentities.js:29-40`),
  so validation stays in our config schema. `update(id, name, icon, color)` (434-465),
  `remove(id)` (500-526), `getPublicIdentities()` / `getPublicIdentityFromId(id)` (752-786),
  `closeContainerTabs(id)` (897-918, resolves once every remote browser is destroyed, 933-951).
  Notifications: `contextual-identity-created` / `-updated` / `-deleted` / `-reordered`.
- **Storage:** `<profile>/containers.json`, version 6 (CIS:7, 1061-1065), written with a 1500 ms
  debounce, an `AsyncShutdown.profileBeforeChange` blocker and an atomic `tmpPath` write
  (CIS:356-389). Valid colours and icons (CIS:25-113) are exactly the lists our config schema
  accepts. A fresh profile has Firefox's four public defaults (personal, work, banking, shopping,
  ids 1-4) plus two private system identities (CIS:176-257).
- **`remove(id)` clears the container's site data**: it calls
  `Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId })` (CIS:510) before
  dropping the identity. It does **not** close tabs. The same clear broadcasts
  `clear-origin-attributes-data`, on which SessionStore forgets closed tabs of that container
  (`browser/components/sessionstore/SessionStore.sys.mjs:1016-1024, 5004-5014`): after a delete,
  "undo close tab" cannot bring them back.
- **Prefs** (`browser/app/profile/firefox.js:2766-2771`): `privacy.userContext.enabled` (default
  true). Flipping it to false makes CIS close every container tab, clear the data of every public
  container and reset `containers.json` to the defaults (CIS:237, 268-283): every workspace
  container and its logins are gone. `privacy.userContext.ui.enabled` only shows the Settings box.
  Isolation itself does not depend on either pref: the origin attributes come from the browser's
  `usercontextid` attribute.
- **Id reuse after a reset:** `resetDefault()` (on a missing or corrupt `containers.json`)
  recomputes the counter from the defaults, so ids ≥ 6 can be handed out again; it first clears
  only ids that still have cookies (CIS:320-337, 957-984). Our definitions must not trust a stored
  `userContextId` blindly (see Container lifecycle).
- **A tab's container is fixed for its browser's lifetime.** `addTab(uri, { userContextId })` sets
  the `usercontextid` attribute on tab and browser
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:4546-4565, 3052-3054`); the origin
  attributes are read once when the browsing context attaches (`nsFrameLoader.cpp` 3567-3585 and
  3821-3843, in `dom/base/`) and `BrowsingContext::CanSetOriginAttributes` refuses (MOZ_CRASH for an attached
  content context) afterwards (`docshell/base/BrowsingContext.cpp:1791-1815`). Changing container
  means a new tab.
- **Default container of a new tab:** `addTab` computes `openerTab` (`Tabbrowser.sys.mjs:3767-3772`)
  and passes it to the private `#createTab`, which inherits the opener's container when none is
  given (4546-4549); otherwise the tab is in container 0 ("no container"). Between the two, a
  **lazy** tab (`createLazyBrowser`) records its `userContextId` into its SessionStore state
  (3860-3868, bug 1819794), so a default applied in `#createTab` would come too late for it: the
  lazy tab would restore into container 0.
  `ctrl+t` (`BrowserCommands.openTab`, `browser/base/content/browser-commands.js:228+`), bookmarks,
  `alt+enter` in the URL bar and the replacement tab Firefox opens when the last tab closes
  (`Tabbrowser.sys.mjs:6626-6633`) pass no container, so they land in container 0. External links
  use `URILoadingHelper.guessUserContextId` (`browser/modules/URILoadingHelper.sys.mjs:880-920`),
  which only looks at **visible** tabs (so with hidden tabs it guesses within the active
  workspace) and returns null when nothing matches.
- **A window's first tab bypasses `addTab`**: `#setupInitialBrowserAndTab` (`Tabbrowser.sys.mjs:644-810`)
  takes its container from `window.arguments[5]`, an adopted tab, or the opener's
  `openWindowInfo` (648-700), else container 0. `ctrl+n`, "open link in new window" without an
  opener and an external link that opens a window all start in container 0.
- **New-tab preload is container 0 only:** `#createTab` uses the preloaded `about:newtab` browser
  only when `!userContextId` (4697-4706), and `NewTabPagePreloading.maybeCreatePreloadedBrowser`
  (`browser/components/tabbrowser/NewTabPagePreloading.sys.mjs:98-110`) keeps creating one per
  window. With every tab in a container, the preloaded browser is never used and costs a content
  document per window. A per-container preload would need a patch to both.
- **Synced prefs:** Firefox Sync syncs `browser.startup.page` (`firefox.js:1817`) and
  `privacy.userContext.enabled` (1893): a linked Firefox could turn restore off, or turn
  containers off, which wipes them (above).

### What a container isolates

Isolated (keyed by `OriginAttributes.userContextId`), with the engine test or code that shows it:

| Data                                         | Evidence                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cookies, localStorage                        | `browser/components/contextualidentity/test/browser/browser_usercontext.js:33-80`                                                  |
| sessionStorage, IndexedDB                    | `browser/components/contextualidentity/test/browser/browser_forgetaboutsite.js:269-301`                                            |
| HTTP cache, image cache                      | `browser_forgetaboutsite.js:154, 219`; `netwerk/base/LoadContextInfo.h:21-28`                                                      |
| Service workers, BroadcastChannel, blob URLs | `browser_serviceworkers.js`, `browser_blobUrl.js` (same directory)                                                                 |
| HTTP auth cache                              | `netwerk/protocol/http/nsHttpAuthCache.cpp:22-25`                                                                                  |
| DNS cache, connections, TLS sessions         | `netwerk/dns/nsHostResolver.cpp:323-325`; `netwerk/protocol/http/nsHttpConnectionInfo.cpp:293`; `nsSocketTransport2.cpp:1203-1217` |
| Alt-Svc                                      | `netwerk/protocol/http/AlternateServices.cpp:62-67`                                                                                |

**Not isolated** (shared by every workspace):

| Data                                              | Evidence                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HSTS                                              | `security/manager/ssl/nsSiteSecurityService.cpp:249-252, 264-267` ("Don't isolate by userContextId")                                                       |
| Site permissions (camera, notifications, …)       | `extensions/permissions/PermissionManager.cpp:4375-4389`: stripped unless `permissions.isolateBy.userContext` (default false, `StaticPrefList.yaml:17435`) |
| Saved logins (password manager)                   | stored by origin without origin attributes (`toolkit/components/passwordmgr/LoginManagerParent.sys.mjs:137-139` keys only generated passwords)             |
| History, bookmarks, stored favicons, form history | no `userContextId` in `toolkit/components/places/*.sys.mjs` or `satchel/FormHistory.sys.mjs` (grep)                                                        |
| Downloads list                                    | only records the source container (`toolkit/components/downloads/DownloadCore.sys.mjs:1794-1797`)                                                          |

So the gate (a login cookie) holds, but a saved password autofills in every workspace (the
`autofill` key in `[workspaces]`, M6), history and the URL bar's suggestions mix workspaces, and
a permission granted in one is granted in all. These go to `docs/limits.md`.

### Hidden tabs

- `gBrowser.hideTab(tab, source)` / `showTab(tab)` (`Tabbrowser.sys.mjs:7535-7612`) are plain
  chrome methods; extensions reach them through `tabs.hide()` with the `tabHide` permission
  (`browser/components/extensions/parent/ext-tabs.js:1646-1663`). `hideTab` silently does nothing
  for a tab that is **pinned, selected, closing, or sharing camera/mic/screen** (7565-7572); with
  a `source` it records `hiddenBy` in SessionStore, without one it does not. A split-view tab is
  hidden together with its siblings (7604-7611); when one member is the selected tab, that member
  stays selected and not hidden while the wrapper gets `display: none` (7596-7603), a state
  mismatch upstream accepts. **Selecting a hidden tab shows it** (1865).
- `gBrowser.visibleTabs` excludes hidden tabs (588-590, `content/tabs.js:945-949`), and everything
  tab-navigational uses it: `selectTabAtIndex` (`ctrl+1..9`, 7626-7641), `ctrl+pagedown` /
  `ctrl+tab` without previews (`toolkit/content/widgets/tabbox.js:149-165, 1189-1190, 1233-1259`),
  the `ctrl+tab` MRU panel (`content/browser-ctrlTab.js` 486, 614 and 800-802), and the tab to select after a close (`_findTabToBlurTo`, 7013-7090, never picks a
  hidden tab). Firefox View excludes hidden tabs (`browser/components/firefoxview/OpenTabs.sys.mjs:357`);
  the all-tabs panel lists them under "Hidden tabs" (`content/browser-allTabsMenu.js:45-127`).
  URL-bar "switch to tab" does include hidden tabs (3843); selecting one un-hides it.
- **Closing the last visible tab** ignores hidden tabs (`#isLastTabInWindow`, 6419-6436): with
  `browser.tabs.closeWindowWithLastTab` (default true, `firefox.js:1113`) the **window closes with
  every hidden tab in it**; with false, Firefox opens a new tab in container 0 (6626-6633). The
  decision is taken before `TabClose` fires (6547-6647), so the host cannot intervene.
- **SessionStore** saves `hidden` per tab (`browser/components/sessionstore/TabState.sys.mjs:176`)
  and restores it with `hideTab`/`showTab` inside the same synchronous restore
  (`SessionStore.sys.mjs:6488-6492`): restored tabs come back hidden without a flash.
- **Memory:** restored non-selected tabs stay lazy (no content process) until selected
  (`SessionStore.sys.mjs:5880-5882, 6459-6477`; `browser.sessionstore.restore_on_demand`).
  `TabUnloader` has no preference for hidden tabs (`browser/components/tabbrowser/TabUnloader.sys.mjs:32-40`)
  and is off on Linux (`browser.tabs.unloadOnLowMemory`, `firefox.js:1213-1217`). Nothing unloads
  hidden tabs automatically.
- **Audio:** hiding does not mute; the tab container tracks hidden tabs playing sound
  (`hiddensoundplaying`, `content/tabs.js:287-316`).
- **Moving a tab to another window** (`adoptTab`) does not carry `hidden` but carries custom tab
  values (`SessionStore.sys.mjs:1339-1350`); `duplicateTab` copies all custom values (`extData`)
  (`SessionStore.sys.mjs:3730-3765`; tests `browser_393716.js`, `browser_465215.js`).

### SessionStore

- `setCustomTabValue(tab, key, string)` / `getCustomTabValue` / `deleteCustomTabValue`
  (`SessionStore.sys.mjs:4790-4834`): strings only, kept in a WeakMap and serialised as the tab's
  `extData`; they work on lazy tabs. `setCustomWindowValue` / `getCustomWindowValue` (4716-4780)
  likewise per window. Both go into `sessionstore-backups/recovery.jsonlz4` every
  `browser.sessionstore.interval` (15 s) and `sessionstore.jsonlz4` at shutdown
  (`SessionFile.sys.mjs:73-110`), so they survive a crash up to the last 15 s while the user is
  active. After 3 minutes of user idleness (`browser.sessionstore.idleDelay`, `firefox.js:1558`)
  the interval becomes `browser.sessionstore.interval.idle`, 1 hour (1554).
- **Trap:** during a restore, `#restoreTab` replaces a tab's custom values with its saved
  `extData` (6361-6365). A value set in a `TabOpen` handler before that is lost.
- **Order of a window restore** (`#restoreWindow`, 5812+): `SSWindowStateBusy` →
  `createTabsForSessionRestore` (all tabs, one fragment) → `#restoreTab` for each tab
  synchronously (custom values, then `hidden`) → `SSWindowStateReady` → `SSWindowRestored`
  (6103-6115). After all windows: `sessionstore-windows-restored` (1559, 1588, 7692) and
  `SessionStore.promiseAllWindowsRestored` (575). `SSTabRestoring` fires when a tab's history is
  restored into a browser, which for lazy tabs is only on first selection (8398-8413).
- **Restores into a live window** happen too: `setBrowserState`, `setWindowState` and "Restore
  previous session" (`restoreLastSession`) run `#restoreWindow` on an open window, with the same
  `SSWindowStateBusy` … `SSWindowStateReady` bracket (5826-5827). With `overwriteTabs` the window's
  custom values are dropped first; otherwise the restored keys replace ours one by one
  (5930-5944).
- **A normal restart does not restore tabs** by default: `browser.startup.page` is 1
  (`firefox.js:337`); only 3, `resume_session_once` or a crash restores the session
  (`SessionStartup.sys.mjs:337-345, 415-429`); otherwise only pinned tabs come back and the rest
  wait for "restore previous session".
- **Scroll positions** are saved per history entry and for the current document
  (`toolkit/modules/sessionstore/SessionHistory.sys.mjs:214-222`) and restored when the tab
  restores (`SessionStore.sys.mjs:8325-8335`); `privacy_level` does not filter them
  (`PrivacyFilter.sys.mjs:22-77`). Nothing for us to build; lazy tabs get theirs on selection.
- **No tab identity survives a restart:** `permanentKey` is per session (`Tabbrowser.sys.mjs:3034`)
  and `TabState` saves no id (`TabState.sys.mjs:160-217`), so we keep our own uuid in a custom
  tab value, and must re-mint it on a duplicate (which copies it).
- **Our own JSON file:** `JSONFile` (`toolkit/modules/JSONFile.sys.mjs`) debounces `saveSoon()`
  (1500 ms), writes with `IOUtils.writeJSON` and `tmpPath` (atomic rename,
  `xpcom/ioutils/IOUtils.cpp:1459-1479`), keeps an optional `backupTo`, and flushes pending saves
  at `profileBeforeChange` (128-133, 489-500). Plain `IOUtils.writeJSON` gives the atomic write
  but no shutdown flush of a debounced save. Precedent: `browser/components/customkeys/CustomKeys.sys.mjs:30-32`.

### "Reopen in Container"

`TabContextMenu.reopenInContainer` (`browser/components/tabbrowser/content/tab-context-menu.js:1174-1240`)
opens `gBrowser.addTab(currentURI.spec, { userContextId, pinned, tabIndex: index + 1,
triggeringPrincipal })`, where the principal is the tab's content principal (or, for a lazy tab,
the one in `SessionStore.getTabState`) rewrapped with `principalWithOA(…, { userContextId })`;
it selects the new tab if the old one was selected and copies mute. **Only the URL travels**: no
back/forward history, form data, scroll position or POST data, and the old tab stays open.
Restoring the old tab's SessionStore state into a tab of another container (`duplicateTab`'s
pattern, 3701-3714) would carry history, but its entries keep principals with the old origin
attributes (`toolkit/modules/sessionstore/SessionHistory.sys.mjs:535-553`, which docshell asserts
on, `docshell/base/nsDocShell.cpp:9259-9265`) and its sessionStorage is keyed by the old
container's origin (`toolkit/components/sessionstore/SessionStoreUtils.cpp:1617-1641, 1788`):
copying it across would leak data between containers. We do not.

### Sidebar

- `SidebarController` (`browser/components/sidebar/browser-sidebar.js`, 3046 lines) keeps panels
  in a JS map (113-283); a custom panel can be inserted at runtime only through private fields
  (`sidebars`, the hard-coded `toolsNameMap` for launcher icons, 15-24). Panels are documents in
  `<browser id="sidebar">`, an in-process chrome browser (`browser/base/content/browser-box.inc.xhtml:24`);
  web content needs a nested remote `<browser type="content">`, as the AI chatbot does
  (`browser/components/genai/chat.js:136-146`). State is saved by SessionStore
  (`SessionStore.sys.mjs:5411-5413, 6694-6701`). The area is in heavy development: 117 files,
  23 `sidebar.*` prefs, a Nimbus feature that writes user prefs
  (`toolkit/components/nimbus/FeatureManifest.yaml:5302-5318`,
  `browser/components/sidebar/SidebarManager.sys.mjs:127-173`), its own `Escape` handling
  (564-569) and `SidebarFocused` focus logic.
- `#browser` (`browser-box.inc.xhtml:5-30`) is a flex `hbox`; `#tabbrowser-tabbox` has `flex="1"`.
  A box inserted from JS needs no `browser.xhtml` patch. `SidebarController.setPosition()` rewrites
  `style.order` of every child by DOM index (`browser-sidebar.js:1001-1006`), so our box pins its
  place with an `!important` `order` in our stylesheet.
- Firefox's sidebar keys stay: `accel+h` history, `accel+alt+x` chatbot, `accel+alt+u` open tabs,
  `ctrl+alt+z` toggle (`browser/base/content/browser-sets.inc.xhtml:291-334`). `accel+b`
  (bookmarks) is our prefix and never reaches Firefox (capturing listener, m0-key-capture).

### Zen (`src/zen/spaces/`, formerly `workspaces`)

- **Container binding is optional and loose**: a space has `containerTabId` (0 = none); new tabs
  take the active space's container through a `Tabbrowser-sys-mjs.patch` hunk in `addTab`
  (`getContextIdIfNeeded`), and with `zen.workspaces.force-container-workspace` a tab opened in
  another space's container is moved there and the window switches. Visibility follows a
  `zen-workspace-id` attribute, not the container, so mismatches are allowed and confuse users
  (zen-browser/desktop issues #6904, #11268, #14371).
- **No hideTab**: each space is its own DOM container of tabs, and `gBrowser.tabs` is overridden to
  the active space. That needs about ten patches so upstream code that wants every tab (SessionStore,
  TabStateFlusher, TabUnloader, tabbox, URILoadingHelper, ctrl+tab) sees them; Zen used `hideTab`
  before and now un-hides legacy hidden tabs on init.
- **Persistence**: tab fields added to `TabState` by patch, spaces in SessionStore window data by
  patch, plus their own `zen-sessions.jsonlz4` (JSONFile, rotating backups) and a migration away
  from a Places table. Startup restore is patched into `SessionStartup` (always resume) and
  `restoreTabs`. Tabs whose space is missing are removed as "zombies" (`skipSessionStore`).
- **Lessons** (issues): session loss on a storage migration (#12460, #9062, #10978) → plan
  migrations and keep a backup; tabs lost when a space vanished (#10345) → never drop orphans;
  external and delayed opens landing in the wrong space (#4197, #9728, #15517, #14100) and a
  freeze when external opens switched spaces (#10666) → do not switch on background opens;
  multi-window duplicates (#14004) → a stable per-tab id with a dedupe rule; pinned/"essentials"
  across spaces and containers (#8427, #12573, #13940) → keep pinned tabs out of the model.

## Decisions

1. **Strict container binding.** Every workspace owns exactly one container of its own (never
   container 0, never one of Firefox's defaults, never shared). A tab belongs to the workspace
   that owns its container. This is the invariant the gate needs and what Zen's loose binding
   lacked. A tab in a container no workspace owns (container 0 from an extension or "Open in No
   Container", Firefox's default containers) is adopted by the active workspace and marked
   `foreign` in the picker and the panel; we never reopen it behind the user's back.
2. **Hidden tabs via `gBrowser.hideTab` / `showTab`** (plan §2), not Zen's DOM split: every
   upstream consumer of `visibleTabs` (ctrl+tab, `ctrl+1..9`, close-selects-next, Firefox View,
   URL-bar guessing) becomes workspace-scoped with **zero patches**, and SessionStore restores the
   hidden flag natively.
3. **One upstream patch file, two hunks** (`Tabbrowser-sys-mjs.patch`): a tab or window opened
   with no container takes the active workspace's container.
   - _Hunk 1, in `addTab`_, right after `openerTab` is computed (`Tabbrowser.sys.mjs:3767-3772`),
     not in `#createTab`: lazy tabs record their container into SessionStore before `#createTab`
     would see it (3860-3868). Without it, `ctrl+t`, bookmarks, `alt+enter`, external links and
     the last-tab replacement open in container 0, and fixing them up after `TabOpen` would mean
     reopening a tab whose load (maybe a POST) has already started.
   - _Hunk 2, in `#setupInitialBrowserAndTab`_, after the `openWindowInfo` override (648-700): a
     window's first tab never goes through `addTab`, so without it `ctrl+n` and an external link
     that opens a window start in container 0 (`foreign`) and decision 10 has no mechanism. The
     alternative, replacing the blank initial tab after the window opens, was rejected: it flashes,
     throws away the first load (an external link's URL, maybe a POST, has already started, the
     same problem hunk 1 solves) and adds a code path that only new windows exercise.
   - Both hunks only fill a missing value (`??=`), so an explicit container, including an explicit
     0 ("Open in No Container", an extension's `cookieStoreId`), an opener's container and an
     adopted tab's container stay as upstream computes them. Both call one function of ours,
     imported on use so script order does not matter:
     `ChromeUtils.importESModule("chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs").WorkspaceStore.defaultUserContextId(window)`
     (hunk 2 now calls `firstTabUserContextId`, which applies the rules of
     [workspace-routing](workspace-routing.md) before falling back to it).
     It returns the active workspace's container of that window, or for a window still being set
     up, of the most recently focused browser window, or at startup the definitions file's
     `lastActive` workspace (read synchronously on first use, as `ContextualIdentityService`
     does with `ensureDataReady`); `null` for private windows and popups, and when workspaces are
     disabled, so upstream behaviour is untouched there.
   - _A third one-line hunk_, `BrowserDOMWindow-sys-mjs.patch` (found in 2a): an external link
     does not reach `addTab` with no container. `#getContentWindowOrOpenURI`
     (`browser/modules/BrowserDOMWindow.sys.mjs:256-259`) passes
     `guessUserContextId(uri) || DEFAULT_USER_CONTEXT_ID`, an explicit 0, so hunk 1's `??=` never
     fires. The hunk makes the fallback `null`; `addTab` then applies hunk 1. A guess (a visible
     tab on the same host) still wins. The research above ("returns null when nothing matches")
     was right about the helper, not about its caller.
   - A runtime wrap of `addTab` is rejected for the reason m0-tabstrip-hidden gives: a patch fails
     loudly at `surfer import`, a wrap breaks silently.
4. **Side panel: our own box**, inserted from JS into `#browser`, not `SidebarController` (answers
   plan §9). Keys stay in the chrome document's dispatcher (`panel` mode) with no hop into a panel
   document; no dependency on the sidebar's private map, its Escape and focus handling, its
   revamp/visibility state machine or Nimbus; no patch. A web page in the panel later is the same
   nested remote `<browser>` either way. Cost: we persist nothing (the panel is closed at start,
   plan §2) and pin `order` in CSS.
5. **Starter workspaces: only the commented example** (answers plan §9). Without `[workspaces]`,
   first run creates one workspace, `main` (gray, circle). Creating `work`/`admin`/`personal`
   presumes a life layout, adds three containers to Firefox's Settings and, being config-defined,
   could not be deleted (decision 7). `defaults.toml` keeps a commented example (`work`).
6. **Moving a tab = reopen by URL in the target container** (Firefox's "Reopen in Container"),
   then close the original. History, form data, scroll and POST data are lost; the tab's rename
   label and mute state carry over. Restoring the session history across containers is rejected
   (principal and sessionStorage leaks, above).
7. **Containers are never deleted silently.**
   - _Runtime workspace_ (created with `prefix+shift+n`): closing it, after confirmation, closes
     its tabs in every window and **removes its container, which deletes its site data**. The
     prompt says so: `Close "shop" (4 tabs) and delete its cookies and site data? y/N`.
   - _Config workspace_ (in `[workspaces]`): closing it closes its tabs only, and the prompt says
     the workspace stays because it is in `config.toml`; the workspace and its container (logins)
     stay.
   - _A config workspace removed from the file_ becomes a runtime workspace with its tabs and
     data; the user can then close it. Nothing is removed at startup.
   - We never touch containers we did not create, and never adopt Firefox's default ones (a
     profile's existing "Work" container may already hold someone's logins).
8. **Persistence in three places**, each where its identity lives:

   | What                                                                                | Where                                                                  | Why                                                                                                                      |
   | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | Workspace definitions (global)                                                      | `<profile>/vimma-workspaces.json` (JSONFile, `backupTo`)               | Shared by all windows; outlives sessions (a `startup.page` change, "clear history"). Plan §3's JSON file.                |
   | Per-window state: active workspace, tab order, active tab, pane layouts, tab labels | `SessionStore.setCustomWindowValue(win, "vimma-workspaces", snapshot)` | Windows have no id across restarts; the value travels with the window through crash recovery and "reopen closed window". |
   | Tab identity and membership                                                         | `setCustomTabValue(tab, "vimma-tab", uuid)` and `"vimma-workspace"`    | Plan §3; travels with the tab through undo-close, adopt-to-window and session restore.                                   |

   This refines plan §3, which put pane layouts in the JSON file: a pane layout belongs to a
   window, and a window can only be found again through SessionStore. The window snapshot is the
   core's schema 1 (`toSnapshot`, with M2's `tabLabels`), so `canWrite` guards both it and the
   definitions file.

9. **Restore is on by default**: our branding prefs set `browser.startup.page = 3` (resume the
   previous session), and `browser.tabs.closeWindowWithLastTab = false` so that closing the last
   tab of a workspace never closes a window full of hidden workspaces (Firefox then opens a new
   tab, which the patch puts in the workspace's container). Both are ordinary defaults the user
   can change; the limits say what changing them costs. Sync must not change them behind the
   user's back: `services.sync.prefs.sync.browser.startup.page` and
   `services.sync.prefs.sync.privacy.userContext.enabled` default to `false` (a linked Firefox with
   containers off would otherwise wipe every workspace container). The idle save interval
   (`browser.sessionstore.interval.idle`, 1 hour) stays: it applies only after 3 minutes without
   input, when the model rarely changes; a crash then can lose a background tab's membership,
   which the reconcile repairs from the container (Reconcile, step 4), not the tab.
10. **Workspaces are global, membership is per window.** A workspace created, renamed or closed in
    one window changes it in every window; each window has its own active workspace and its own
    tabs. A new window starts in the active workspace of the window it was opened from (or the
    first workspace), through hunk 2 of decision 3: its first tab opens in that workspace's
    container, and the window's model starts with that workspace active. Private windows and
    popups have no workspaces.
11. **Pinned tabs are out of the model.** `hideTab` refuses pinned tabs, so a pinned tab would
    leak into every workspace. With the tab strip hidden Vimma offers no way to pin; a tab pinned
    by an extension or an imported session is unpinned by the host on `TabPinned` with a status
    message. A tab sharing camera/mic/screen cannot be hidden either: it stays visible in the
    workspace the user switches to, marked in the status bar, until sharing stops.
12. **Background opens never switch workspace.** A tab opened in another workspace's container
    (a link from a `work` page opened with `F`, an extension) joins that workspace hidden, with a
    status message (`opened in work`); only selecting it (picker, URL-bar switch-to-tab, panel)
    switches. Zen's switch-on-open caused misrouted tabs and a freeze (#10666).
13. **New-tab preload off** (`browser.newtab.preload = false` in our branding prefs). Firefox uses a
    preloaded `about:newtab` only for container 0 (`Tabbrowser.sys.mjs:4697-4706`), and every
    Vimma tab is in a container, so the preloaded browser is never used and costs a document per
    window. Preloading per container needs patches to `#createTab` and `NewTabPagePreloading`;
    rejected unless the measurement says otherwise. Sub-spec 2a measures `ctrl+t` to the first
    paint of `about:newtab` (median of 20, Vimma in a container without preload vs stock Firefox in
    container 0 with preload). Criterion: within 100 ms of stock, the decision stands; slower, a
    follow-up spec weighs a per-container preload patch.
14. **One split = one workspace.** Firefox's split view accepts tabs of different containers in one
    wrapper; Vimma does not allow one wrapper to span workspaces (a foreign tab is in its
    workspace, so a split of it with a workspace tab is allowed). Vimma's own pane operations
    cannot break it: core's `withPanes` rejects a tab outside the workspace (`unknown-tab`). For
    a wrapper made outside Vimma (extension, a restored Firefox session), when M4's adoption
    (`SplitViewCreated`, m4-split-panes) finds members of another workspace, it takes them out of
    the wrapper (unsplit; they stay in their workspace, nothing is reopened) and says so in the
    status bar. Switching selects the target workspace's tab before hiding (see the mapping
    table), so the selected-member mismatch upstream allows (`Tabbrowser.sys.mjs:7596-7603`: the
    selected member stays visible while its wrapper is `display: none`) does not arise from a
    switch; the switch test asserts that every member of a hidden workspace's wrapper is
    `hidden`.

## Architecture

```
config.toml [workspaces] ─┐
vimma-workspaces.json ────┼─▶ WorkspaceStore (per app)  ──containers──▶ ContextualIdentityService
                          │     definitions, reconcile, writes
                          ▼
             WindowWorkspaces (per window) ── model ──▶ vimma-core workspaces.mjs (pure)
               │  gBrowser events: TabOpen, TabClose, TabSelect, TabPinned, TabAttrModified
               │  SessionStore: window value, tab values, SSWindowStateBusy/Ready
               ├─▶ gBrowser.hideTab / showTab / selectedTab / addTab / removeTab
               ├─▶ status bar segment, prefix+w picker (M2 picker.mjs), side panel
               └─▶ VimmaHost actions: workspace.*, sidebar.toggle, panel.*
```

- **`workspaces/WorkspaceStore.sys.mjs`** (one per app, a module singleton): loads and saves
  `vimma-workspaces.json`, reconciles it with `[workspaces]` and `ContextualIdentityService`,
  creates/updates/removes our containers, and notifies windows (`vimma-workspaces-changed`
  observer topic) of definition changes. The pure part (reconcile, schema validation) is a new
  core module, `packages/vimma-core/src/workspacedefs.mjs`, tested in Vitest.
- **`workspaces/WindowWorkspaces.sys.mjs`** (one per window, started by `VimmaHost.init` like
  `TabStrip`, in a `try`/`catch`): owns the window's core `Workspaces` state, maps tab uuids to
  tab elements, listens to tab and SessionStore events, applies the model to the window
  (`hideTab`/`showTab`, selection), writes the window snapshot after each change.
- **`ui/side-panel.mjs`** + `browser/themes/shared/vimma/side-panel.css`.
- Ids: a workspace's id is a global string from the definitions file (`ws-<uuid>`), passed into
  the core model; the model's `container` field holds the `userContextId` as a string; tab ids are
  the `vimma-tab` uuids.
- **Core change** (small, in the first sub-spec): `createWorkspaces` and `addWorkspace` accept an
  optional `id` (validated unique, `duplicate-id`), because ids must agree across windows; the
  model's own `w<n>` minting stays for callers that pass none.

### Mapping the model to Firefox

| Model operation                     | Host                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `switchWorkspace` / next / previous | Select the target's `activeTab` (if empty: open its `home` or `about:newtab` in its container), then `showTab` its tabs and `hideTab` the others. Selecting first matters: the selected tab cannot be hidden. |
| `openTab` (on `TabOpen`)            | Workspace = owner of `tab.userContextId`, else the active one (`foreign`). Position from the tab's index among its workspace's tabs. Not activated unless it is selected.                                     |
| `closeTab` (on `TabClose`)          | Drop it; Firefox already picked the next tab among visible ones, which the host reports with `selectTab`. Ignored while the window is closing.                                                                |
| `selectTab` (on `TabSelect`)        | If the tab is in another workspace (URL-bar switch-to-tab, picker, `undo close tab`), switch to it: show its workspace, hide the rest.                                                                        |
| `moveTab`                           | Reopen by URL in the target container (decision 6), `moveTab(s, old, target, { newTabId })`, close the old tab.                                                                                               |
| `deleteWorkspace`                   | Confirm (decision 7), `removeTab` each of `closedTabs` (all windows), then for a runtime workspace `ContextualIdentityService.remove` after the browsers are gone.                                            |
| `addWorkspace` / `renameWorkspace`  | `ContextualIdentityService.create` / `update`, then the definitions file.                                                                                                                                     |

Tab order: the model's per-workspace order is the order of those tabs in `gBrowser.tabs` (hidden
tabs keep their DOM position). The host reads order from Firefox rather than moving tabs to match
the model, so `TabMove` updates the model and no tab is ever moved behind the user's back.

## Container lifecycle

- **Created** from `[workspaces]` at startup for each config workspace without a live container,
  and at runtime by `prefix+shift+n`, with `ContextualIdentityService.create(name, icon, color)`.
  The container's name is the workspace name.
- **Updated** when config changes a workspace's colour or icon or a rename happens
  (`ContextualIdentityService.update`).
- **Checked** at every startup: a definition whose `userContextId` is missing from
  `getPublicIdentities()`, or whose identity's name no longer matches what we wrote (a reset reused
  the id), gets a new container. Its restored tabs keep the old id (still isolated, but no longer
  the workspace's) and are marked `foreign`; the status bar says that the container of the
  workspace was lost and that its sites need a new sign-in.
- **Removed** only by closing a runtime workspace after confirmation (decision 7).
- `contextual-identity-deleted` for one of ours (the user deleted it in Settings, which closes its
  tabs and then removes it: `browser/components/preferences/config/containers.mjs:124-126`) keeps
  the workspace and gives it a new, empty container at once; nothing else is removed.
- `privacy.userContext.enabled = false`: at startup the host shows a persistent status-bar error
  and runs with workspaces disabled (one implicit workspace, no containers); it does not flip the
  pref back.

## Persistence and restore

### Formats

- `vimma-workspaces.json`: `{ schema: 1, lastActive, workspaces: [{ id, name, userContextId,
color, icon, home?, source, bookmarksFolder? }] }` with `source` `"config"` or `"runtime"`, and
  `bookmarksFolder` the Places guid of the workspace's folder in the Bookmarks Toolbar (optional,
  so still schema 1; see [bookmarks](bookmarks.md) decision 11), in workspace order
  (config order first, runtime ones after, in creation order). `lastActive` is the workspace a
  window switched to last (debounced with the rest), used for the first window at startup
  (decision 3). JSONFile with `backupTo: "vimma-workspaces.json.bak"`.
- Window value `vimma-workspaces`: `JSON.stringify(toSnapshot(state, { tabLabels }))`, written on
  every settled model change (`setCustomWindowValue` only marks SessionStore dirty; its own 15 s
  cadence and the shutdown write persist it).
- Tab values `vimma-tab` (uuid) and `vimma-workspace` (workspace id).
- **Newer files:** before every write, `canWrite` on the current file / window value. A newer
  definitions file puts the session in read-only workspaces (no create/rename/delete, status bar
  says so); a newer window value is left untouched for that window. Unreadable definitions are
  moved aside (`vimma-workspaces.json.corrupt-<date>`) and rebuilt from config, containers and
  tab values, never silently emptied (Zen #12460).

### The restore lifecycle: provisional model, re-entrant pending

A window cannot know in advance whether SessionStore will restore into it: the first window at
startup may or may not get a session, a window SessionStore opens is restored after it loads,
and `setBrowserState`, `setWindowState`, "Restore previous session" and undo-close-tab restore
into a live window at any time. So the host never waits to be told "no restore is coming".
Instead:

- **Build at once.** `WindowWorkspaces.init` builds a provisional model from the live tabs (the
  reconcile below), with the active workspace from decision 3's default.
- **Re-entrant pending.** SessionStore brackets every restore into a window, whole-window or
  single-tab (`#restoreTab` sets the busy state and clears it at its end,
  `SessionStore.sys.mjs:6331, 6514`), with a busy counter that fires `SSWindowStateBusy` on 0 → 1
  and `SSWindowStateReady` on 1 → 0 (7847-7873). On every `SSWindowStateBusy` the window enters
  **pending**: tab events are queued, not applied; no visibility changes; no window-value writes
  (tab values set now would be overwritten by `extData`, and our window value may be replaced,
  5930-5944). On every `SSWindowStateReady` it runs the reconcile and leaves pending. Any number
  of brackets, in any window, at any time, work the same way.
- **Tab events outside a bracket** are handled in a microtask, so a path that adds a tab and then
  restores it in the same task (undo close, `duplicateTab`) has set `extData` first; if a bracket
  opened meanwhile, the event waits for its `SSWindowStateReady`.
- **Side effects wait for the session.** Actions that create or change tabs on their own
  (opening `home` in an empty workspace, unpinning) wait until
  `SessionStore.promiseAllWindowsRestored` has resolved, which also happens when there is nothing
  to restore (`SessionStore.sys.mjs:1586-1593`), and the window is not pending. A user-opened
  window after startup is therefore settled as soon as it is built.

### Reconcile (idempotent; runs at init and on every `SSWindowStateReady`)

1. `WorkspaceStore.init()` has run once per app (first window): load the definitions file and
   read `config.toml`'s `[workspaces]` once (`parseConfig`; the M5 host adds polling and
   `:source`). Reconcile definitions (`workspacedefs.mjs`, pure): config workspaces by name, keep
   runtime ones, turn removed config ones into runtime ones, create a `main` workspace if the
   result is empty; then check containers (lifecycle above) and write the file if anything
   changed.
2. Parse the window value with `fromSnapshot` (on error or a newer schema: log, start from the
   definitions). Align its workspaces with the definitions: drop unknown ones, add missing ones
   (empty), take names and order from the definitions.
3. Read every live tab's `vimma-tab` and `vimma-workspace`; mint a uuid for tabs without one;
   re-mint the second of any duplicate (a duplicated tab copies its values).
4. Drop snapshot tabs that are not live (`closeTab`); add live tabs the snapshot lacks
   (`openTab` into the workspace that owns the tab's container; for a `foreign` tab, the one in
   its `vimma-workspace`, else the active one). Never close a live tab because its workspace is
   unknown (Zen's zombie sweep): it goes to the active workspace. Live tabs are the truth; the
   snapshot only supplies order, active tabs, pane layouts and labels.
5. The active workspace is the workspace of `gBrowser.selectedTab`; apply visibility (SessionStore
   already restored `hidden`, so this is normally a no-op) and write the window value.
6. Scroll: nothing to do; SessionStore restores it when each tab restores (lazy tabs on first
   selection).

### Event order on a normal session restore

`VimmaHost.init` (script in `browser.xhtml`) → provisional model (the initial tab) → delayed
startup → `SSWindowStateBusy` (pending) → tabs created, `TabOpen` × n (queued), each `#restoreTab`
sets `extData` and `hidden` → `SSWindowStateReady` → reconcile → `SSWindowRestored` → status bar
and panel render → `sessionstore-windows-restored` and `promiseAllWindowsRestored` (side effects
allowed).

## Side panel

- `#vimma-panel`, a `vbox` inserted as the first child of `#browser` by `ui/side-panel.mjs`;
  `side-panel.css` gives it `order: -1 !important` and a fixed width token. Hidden until opened;
  never persisted open (plan §2: closed by default).
- Content (chrome HTML, rendered from core data like the help overlay): a header with the
  workspace dot (container colour), `index:name`, and the neighbours (`prefix+(` previous name,
  `prefix+)` next name); then the workspace's tabs as rows `n  label  host`, the active tab marked,
  `foreign` and sound-playing tabs marked.
- Mode `panel` while open (exists in `MODES`, keys in `defaults.mjs`): `1-9` selects that tab and
  closes the panel; `j`/`k` move the highlight; `Enter` selects the highlighted tab and closes;
  `Esc` and `toggle_sidebar` (`prefix+b`) close. `prefix+)`/`prefix+(` switch workspace
  with the panel open and it re-renders. Focus stays in the chrome document; closing returns focus
  to the selected browser.
- A web page in the panel is out of scope for M3; when needed it is a nested
  `<browser type="content" remote="true">` as in `browser/components/genai/chat.js:136-146`.

## Upstream patches

| Patch                                                        | Hunks | Why                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch` | 2     | `addTab`, after `openerTab` (3767-3772), unless `pinned`: `userContextId ??= openerTab?.userContextId ?? <our default>`. `#setupInitialBrowserAndTab`, after the `openWindowInfo` override (698-700): `userContextId ??= <our default>`. Decision 3. |
| `src/browser/modules/BrowserDOMWindow-sys-mjs.patch`         | 1     | `#getContentWindowOrOpenURI` (256-259): no container guess for an external link → `null`, not 0, so `addTab` routes it. Decision 3, found in 2a.                                                                                                     |
| `src/browser/modules/URILoadingHelper-sys-mjs.patch`         | 1     | `openLinkIn`, before `updatePrincipals`: a new window with no container takes the opening page's, else the workspace's. Found in 2a.                                                                                                                 |
| `src/browser/base/content/browser-init-js.patch`             | 1     | `_handleURIToLoad`: no `arguments[5]` → the first tab's container, not 0. Found in 2a.                                                                                                                                                               |

ADR-003 register line, added by sub-spec 2a with the patch: "`Tabbrowser-sys-mjs.patch`: tabs
and a window's first tab opened with no container take the active workspace's container
(`addTab` after `openerTab`; `#setupInitialBrowserAndTab`), so new tabs, lazy tabs and new
windows are isolated from the start (m3-workspaces, decision 3)."

Everything else is ours: prefs in `browser/branding/vimma/pref/firefox-branding.js`
(`browser.startup.page`, `browser.tabs.closeWindowWithLastTab`, `browser.newtab.preload`,
`services.sync.prefs.sync.browser.startup.page`,
`services.sync.prefs.sync.privacy.userContext.enabled`), modules and CSS under `vimma/`. Not
needed (checked):
`browser.xhtml` (the panel is inserted from JS), SessionStore and TabState (custom values),
`tabs.js` / ctrl+tab / TabUnloader (`hideTab` keeps upstream's own scoping), SessionStartup
(`browser.startup.page` instead of forcing resume).

Upstream's split view, on which M4 builds (m4-split-panes), is hidden as a unit by `hideTab`
(7604-7611); decision 14 keeps each wrapper inside one workspace.

## Test plan

Mochitests (`tests/browser/`, one per acceptance criterion; the gate's two first):

(Since changed: the sub-specs named their test files differently. The `browser_vimma_workspaces_*.js`
names below were never created; the tests are in `tests/browser/browser_vimma_workspace_*.js`,
listed in each sub-spec's Settled section.)

- `browser_vimma_workspaces_isolation.js` (**gate 1**): Given workspaces `work` and `personal`
  (test containers), when a page on `https://example.com` in `work` sets a cookie
  `session=work` and a localStorage key, then a tab on the same URL in `personal` sees neither
  (`document.cookie`, `localStorage` via `SpecialPowers.spawn`), `Services.cookies` has the cookie
  only under `work`'s `userContextId`, and the `work` tab still sees both after switching back.
  Also (routing, the patch): a new tab from `prefix+c`, `ctrl+t`, a bookmark and an external
  link opens in the active workspace's container; a **lazy** tab opened in the background
  (`createLazyBrowser`) records that container in `SessionStore.getTabState` and restores into
  it; `ctrl+n` and an external link that opens a window start in the opener window's workspace
  and its container (not `foreign`); a link opened with `F`/middle-click keeps its page's
  container; an explicit container 0 stays 0 (`foreign`); a private window is untouched.
- `browser_vimma_workspaces_restore.js` (**gate 2**): Given two workspaces with three tabs, one
  renamed, one page scrolled to `y = 1200` (`file_vimma_long.html`), `personal` active, when the
  test flushes (`TabStateFlusher.flush`), saves `SessionStore.getBrowserState()`, closes the
  window's tabs and restores the state with `SessionStore.setBrowserState` (the session-store
  tests' restart simulation, `browser/components/sessionstore/test/head.js:96-125`), then the
  definitions, every tab's workspace and uuid, the order, the active workspace and tab, the label
  and the hidden flags come back, and selecting the scrolled tab shows `scrollY === 1200`.
  A real quit/start is the M3 e2e happy path (plan §5), once `tools/e2e` exists.
- `browser_vimma_workspaces_live_restore.js`: restores into a running model. `setWindowState`
  with and without `overwriteTabs`, `setBrowserState`, "Restore previous session" and undo
  close tab each leave every tab in the right workspace with a unique uuid; tab events during the
  bracket are applied after `SSWindowStateReady`; two brackets in a row (a second restore before
  the first is ready) end in one consistent model; a new window opened by the user after startup
  is settled without any restore event.
- `browser_vimma_workspaces_switch.js`: `prefix+)`/`prefix+(` wrap; only the active workspace's tabs
  are visible; `ctrl+tab`, `alt+1..9`, `ctrl+pagedown` stay in it; closing the active tab selects
  one in the same workspace; closing the last one opens a new tab in the same container and keeps
  the window; switching to an empty workspace opens its `home`. With a split in the workspace
  being left, every member of its wrapper is `hidden` after the switch, and a wrapper with a
  member of another workspace is unsplit (decision 14).
- `browser_vimma_workspaces_events.js`: URL-bar switch-to-tab and undo-close into another workspace
  switch to it; a background open in another workspace's container stays hidden with a status
  message; a duplicate tab gets a new uuid; a tab adopted from another window keeps its workspace;
  a pinned tab is unpinned; a container-0 tab is `foreign`.
- `browser_vimma_workspaces_lifecycle.js`: config workspaces create containers with name, colour
  and icon; a second start creates none; a removed container is recreated; closing a runtime
  workspace asks, closes tabs in every window and removes the container; its cookie is gone,
  asserted only after the `clear-origin-attributes-data` observer fires
  (`TestUtils.topicObserved`), because `ContextualIdentityService.remove` does not await its
  data clear (CIS:510);
  closing a config workspace keeps container and cookie; a newer definitions file is never
  overwritten; Firefox's default containers are untouched.
- `browser_vimma_workspaces_move.js`: moving a tab reopens its URL in the target container (cookie
  of the target applies), keeps label and mute, closes the original, and stays in the current
  workspace; a lazy tab moves by its saved URL.
- `browser_vimma_side_panel.js`: `prefix+b` opens the panel on the left listing the workspace's
  tabs; `j`/`k`/`1-9`/Enter/Esc; `prefix+)` re-renders it; it stays leftmost when
  `sidebar.position_start` flips; focus returns to the page on close.
- **Limits as tests**: a permission granted in `work` is visible in `personal`; HSTS is shared.
  When either is fixed, the test and the limits line go together.
- Vitest: `workspacedefs.mjs` reconcile table (config add/remove/reorder, renamed config entry,
  missing containers, an empty result → `main`), schema fixtures `tests/contract/workspaces/v1/`,
  and the core `id` option.
- Performance: e2e with 200 tabs over 4 workspaces, `prefix+)` to paint (plan §9 risk); the
  `ctrl+t` new-tab measurement of decision 13 (sub-spec 2a, recorded in its Settled section).

## Risks

| Risk                                                                                                   | Mitigation                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setting a tab value before `#restoreTab` loses it (overwritten by `extData`)                           | Re-entrant pending from `SSWindowStateBusy` to `SSWindowStateReady`; microtask handling of tab events; tests cover undo-close and live-window restores. |
| `closeWindowWithLastTab = true` (user's choice) closes a window with hidden workspaces                 | Default false; limits line; the window stays in "recently closed windows" with all its tabs.                                                            |
| `containers.json` reset (corrupt file) reuses ids and clears data                                      | Startup container check by id and name; `foreign` marking; status-bar warning. Upstream behaviour; limits.                                              |
| `privacy.userContext.enabled = false` wipes every container                                            | Detected at startup, workspaces disabled with an error; limits line.                                                                                    |
| Sync or about:config turns containers or restore off                                                   | Sync prefs for both off by default (decision 9); startup check of `privacy.userContext.enabled`; limits lines.                                          |
| The two `Tabbrowser` hunks drift on a rebase                                                           | Each fills one variable next to stable code (opener and window-argument handling); `surfer import` fails loudly; the routing tests catch a silent move. |
| Extensions using `tabs.hide`/`show` (Multi-Account Containers, Simple Tab Groups) fight our visibility | Re-apply visibility on `TabShow`/`TabHide` we did not cause; document as unsupported in limits.                                                         |
| Hidden-tab memory with hundreds of tabs                                                                | Lazy restore keeps them cheap; 200-tab e2e; unloading hidden tabs is a later spec.                                                                      |
| Multi-window edge cases (Zen #14004)                                                                   | uuid per tab with re-mint on duplicate; definitions global, membership per window; events test.                                                         |

## Breakdown into sub-specs

Each is one session, in order. M2's host pieces (status bar, picker UI, prompt line) are a
dependency for 4b, 5 and parts of 4a.

| #   | Sub-spec                   | Scope                                                                                                                                                                                                                                                                                       | Depends on             |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | `m3-workspace-store`       | Core: `workspacedefs.mjs` (schema, reconcile, `main` default, `lastActive`) and the optional `id` in `workspaces.mjs`. Host: `WorkspaceStore` (JSONFile, `canWrite`, containers create/update/check, one-shot `[workspaces]` read, `defaultUserContextId`). Lifecycle test (no delete yet). | PR #10 merged          |
| 2a  | `m3-workspace-routing`     | The two-hunk patch and its ADR-003 line; new-tab, lazy-tab and new-window routing; `foreign` tabs; `browser.newtab.preload = false` with the decision-13 measurement. **Gate 1** test with the routing cases.                                                                               | 1                      |
| 2b  | `m3-workspace-switching`   | `WindowWorkspaces`: tab uuids, `TabOpen`/`TabClose`/`TabSelect`/`TabMove`/`TabPinned`, `hideTab`/`showTab`, `prefix+)`/`prefix+(`, empty workspace opens `home`, `closeWindowWithLastTab` pref, the one-split-one-workspace rule. Switch and events tests.                                  | 2a                     |
| 3   | `m3-workspace-persistence` | Window value and tab values, the provisional model and re-entrant pending, the reconcile, `browser.startup.page = 3` and the sync prefs, duplicate and adopt handling, `canWrite` for the window value, `tabLabels`. **Gate 2** and live-restore tests.                                     | 2b                     |
| 4a  | `m3-workspace-lifecycle`   | `prefix+shift+n/w/d` (new, rename, close with the confirmation rules), cross-window propagation, `contextual-identity-deleted`, the `privacy.userContext.enabled` check. Lifecycle test.                                                                                                    | 3; M2 prompt line      |
| 4b  | `m3-workspace-move`        | Move a tab: reopen by URL in the target container, label and mute, lazy tabs; the warning text. Move test.                                                                                                                                                                                  | 4a                     |
| 5   | `m3-workspace-picker`      | `prefix+w` (M2 `picker.mjs` with workspace items, `m` = move current tab here with the warning), the status bar's workspace segment and `opened in …` messages.                                                                                                                             | 4b; M2 picker and bar  |
| 6   | `m3-side-panel`            | `#vimma-panel`, `panel` mode wiring, rows, neighbours, focus. Side-panel test.                                                                                                                                                                                                              | 2b (works without 3-5) |
| 7   | `m3-e2e`                   | Real restart happy path and the 200-tab measurement on the e2e harness.                                                                                                                                                                                                                     | 3; `tools/e2e` on main |

## Settled: sub-spec 1, m3-workspace-store (2026-10-09)

- Core `workspacedefs.mjs`: `readDefinitions` (schema 1; fixtures in `tests/contract/workspaces/v1/`),
  `canWriteDefinitions`, `reconcileDefinitions` (config by name in file order, then runtime; a
  removed config workspace becomes runtime; empty → `main`, gray circle, `runtime`; idempotent:
  a no-op returns its input), `planContainers` (adopt by stored id **and** name, update drifted
  colour/icon, create otherwise; never matches by name alone, so Firefox's defaults are never
  adopted), `addRuntimeWorkspace`, `removeWorkspaceDefinition` (refuses config workspaces and the
  last one), `withContainer`, `setLastActive`. `config.mjs` now exports `CONTAINER_COLORS`,
  `CONTAINER_ICONS`, `MAX_WORKSPACE_NAME`.
- Host `workspaces/WorkspaceStore.sys.mjs`: `WorkspaceStoreImpl` and the app singleton
  `WorkspaceStore`. JSONFile with `backupTo` and a `beforeSave` that re-checks `canWrite` on the
  file on disk. A newer file → `readOnly` (nothing written, no container made); valid JSON that
  fails validation is copied to `.corrupt-<date>` and rebuilt; unparsable JSON is JSONFile's own
  `.corrupt` rename plus restore from the backup. Containers whose stored id is gone or reused
  get a new one (`lostContainers` lists the names for the status bar, 5); the reused container
  is left alone. `defaultUserContextId(win)`: the window's active workspace (`setActive`), else
  the top window's, else `lastActive`; null for private windows, popups and containers off.
- **Config seam:** the constructor takes `config` (core `mergeWithDefaults(...).workspaces`); M5
  passes it. Nothing reads `config.toml` yet, so every profile gets `main`.
- **Delete** (moved forward from 4a): `deleteWorkspace(id, { confirmed: true })` only; without
  it, `not-confirmed`. It closes the container's tabs, then `ContextualIdentityService.remove`,
  which clears the site data; a container whose name is no longer ours is not removed. The
  prompt, cross-window closing and the config-workspace message stay in 4a.
- **Not wired at startup yet:** nothing calls `WorkspaceStore.init()` until 2a/2b (the patch and
  `WindowWorkspaces`), so no container appears in a profile before tabs can use it. No pref is
  changed; the `privacy.userContext.enabled` check is read through the `enabled` option (the
  test cannot flip the pref: Firefox then wipes every container). Nothing user-visible, so no
  guide change.
- Tests: `workspacedefs.test.mjs` (Vitest) and `browser_vimma_workspace_store.js`: first run,
  round trip, a newer file left byte-for-byte, adopt/replace without deleting, confirmed delete
  removing container and cookie (after `clear-origin-attributes-data`), containers off, private
  windows. Mutation check: skipping `CIS.remove` fails the delete task.

## Settled: sub-spec 2a, m3-workspace-routing (2026-10-09)

- **Patches:** `Tabbrowser-sys-mjs.patch`, two hunks as planned. Hunk 1 (`addTab`, 8 lines) is
  guarded by `!pinned`: a tab opened pinned keeps upstream's container (decision 11 unpins it in
  2b). Hunk 2 (`#setupInitialBrowserAndTab`, 4 lines). Plus a third patch file, not planned:
  `BrowserDOMWindow-sys-mjs.patch` (1 line, decision 3), because external links passed an
  explicit 0. Both files have ADR-003 register lines; the two Tabbrowser hunks call
  `WorkspaceStore.defaultUserContextId(window)` (imported on use).
- **Startup wiring:** `vimma.js` calls `WorkspaceStore.init()` once per app (not awaited, in a
  `catch`), so every profile now gets `main` and its container at first start. The per-window
  active workspace is still `setActive` (2b's `WindowWorkspaces` will call it); until then every
  window routes to `lastActive`, which is `main`. `defaultUserContextId` now reads the file
  synchronously whenever JSONFile has not loaded it yet, not only before `init()` starts: the first
  window's first tab is set up while `init()` is still loading. On a brand-new profile that tab
  still predates `main` and opens in container 0 (limits).
- **Preload:** `browser.newtab.preload = false` (decision 13). Measured in the lane (artifact
  build, headless, 16 threads): `ctrl+t` to the new tab's `about:newtab` loaded plus one animation
  frame, median of 20 after a warm-up. Vimma (container, no preload): **76 ms** (71-82). Stock
  behaviour in the same build (container 0, preload on, refilled after each tab): **35 ms**
  (34-35). +41 ms, within the 100 ms criterion: the decision stands.
- **Tests:** `browser_vimma_workspace_routing.js`: gate 1 (a cookie and a localStorage key set in
  one workspace's container are invisible to the same page in another; `Services.cookies` has it
  only under the first; the first still sees both), startup wiring (`main`, `ctrl+t` into it),
  `ctrl+t`, an external link, a lazy tab and its SessionStore state, a new window's first tab, a
  `target=_blank` link and a `relatedToCurrent` tab keeping the opener's container, explicit
  containers (including 0), a pinned tab, a private window. Red before the patch (10 failures),
  green after; the whole `tests/browser/` suite passes. Mutation check: dropping
  `openerTab?.userContextId ??` from hunk 1 fails the `relatedToCurrent` assertion (a link click
  passes its container explicitly, so it alone did not catch it).
- **Privacy hardening:** two more paths opened in container 0, so two more one-hunk
  patches. `URILoadingHelper-sys-mjs.patch`: `openLinkIn(url, "window")` (context-menu "Open Link
  in New Window", bookmark and URL-bar new windows) packed an undefined container into
  `window.arguments[5]` as an explicit 0; the hunk, before `updatePrincipals`, fills it with the
  opening page's container (a content triggering principal) or else the active workspace's,
  never for a private window. `browser-init-js.patch`: a new window's URL with no
  `arguments[5]` (an external link opening a window) loaded with container 0 and so opened a
  second tab beside the routed first tab; it now uses the first tab's container. The context
  menu needs no patch of its own: its triggering principal carries the page's container. The
  store caches `lastActive`'s container in `vimma.workspaces.startupUserContextId` on every
  save, so a start routes its first tab without the synchronous file read (the read stays as
  the fallback). Tests: context-menu "Open Link in New Window" from a page in another container
  than the active one, `openTrustedLinkIn(url, "window")`, an external link opened as a window
  (one tab), and the cache pref; all red before, green after.
- **Not done here:** `foreign` marking needs the window model (2b). Bookmarks and `alt+enter` go
  through the same `addTab` path as `ctrl+t` and are not tested separately. Nothing
  user-visible yet (no switching), so no guide change.

## Settled: sub-spec 2b, m3-workspace-switching (2026-10-10)

- **`workspaces/WindowWorkspaces.sys.mjs`**, one per window, started by `VimmaHost.init` (in a
  `try`) after `WorkspaceStore.init()` and `DOMContentLoaded`; none in private windows and popups,
  nor with containers off. It builds the core model from the definitions and the live tabs, and
  calls `WorkspaceStore.setActive` on build and every switch, so routing (2a) follows the
  window's workspace. Tab ids are `linkedPanel`, as the picker and `PaneView` use; uuids in tab
  values come with persistence (3).
- **Switching** (`prefix+)`/`prefix+(`, `:wsnext`/`:wsprev`, `:workspace name|number`): core
  `switchWorkspace`/`next`/`previous`, then `planWorkspaceSwitch` applied as the mapping table
  says: select the target's `activeTab` (none: `addTrustedTab` of its `home`, else the start page,
  in its container), `showTab` the target's, `hideTab` one tab per other group. `unsplit` is only
  logged; adopting foreign splits is M4 sub-spec 6. `workspace.switch` is now an action
  (`switch_workspace`, unbound; with no text it opens `:workspace `), and `PENDING_ACTIONS` is
  empty. Unknown name: notice `no workspace "x"`. No `select_workspace_1..9` (prefix+1..9 are
  tabs; numbered actions would add nine unbound rows to the overlay).
- **Splits** (decision 14): `PaneView.swap(from, to)` parks the window's pane tree, wrapper and
  laid-out set under the workspace being left and brings back the target's, before any
  selection; `reconcile()` after the switch lays it out. Hiding one member hides the wrapper
  (asserted: every member and the wrapper `hidden`). Per-workspace trees in the core model stay
  M4 sub-spec 6.
- **Events:** `TabOpen` (and `TabUnpinned`) puts a tab in the workspace owning its container,
  else in the active one, marked **`foreign`** (a set in the window object, `isForeign(tab)`;
  shown by the picker of 5 and the panel of 6). A tab joining a workspace not shown is hidden
  (decision 12), except Firefox's replacement for a closing last tab: hiding it left
  `selectedTab` on the removed tab (found by the routing test's cleanup), so a tab is hidden at
  `TabOpen` only when another visible tab is not closing. `TabClose` and `TabPinned` drop it;
  `TabSelect` of another workspace's tab (picker, switch-to-tab, undo close) switches, in a
  microtask, after Firefox's own selection. `TabMove` is not needed: the picker reads order from
  `gBrowser.tabs`. The store's `vimma-workspaces-changed` adds, renames and removes workspaces;
  a removed workspace's live tabs go to the active one (never closed).
- **Pinned tabs** stay out of the model and visible in every workspace (the planner never hides
  them). Unpinning them on `TabPinned` (decision 11) is deferred: with no Vimma key to pin it
  needs the restore path of 3 to be worth it. (Since changed: unpinned on `TabPinned` with a notice; see "Settled: pinned tabs and lost
  containers".)
- **Tab keys and picker:** `selectableTabs` is already `visibleTabs`, now the workspace's.
  `pickerWorkspaces` returns the window model, tabs in DOM order; Enter on another workspace's
  tab selects it, and `TabSelect` switches.
- **Status bar:** `VimmaHost.status` passes `workspace: { name, index, color }`; the segment is
  `● 2:work`. `browser_vimma_statusbar.js`'s narrow-bar check now uses 40ch (the segment takes
  nine columns of the old 30).
- **Pref:** `browser.tabs.closeWindowWithLastTab = false` (decision 9).
- **Tests:** `browser_vimma_workspace_switching.js` (7 tasks): prefix+)/prefix+( with wrap, hiding,
  restore of the selected tab, the bar; tab keys and ctrl+tab within the workspace; a split
  hidden whole and back laid out; pinned tabs; the picker across workspaces switching; ctrl+t
  and a container-0 tab (`foreign`); `:workspace` by name, number and an unknown name. Red
  before (module missing: 8 failures), green after; the whole `tests/browser/` suite passes.
  Mutation check: not calling `hideTab` in the switch fails 17 assertions.

## Settled: sub-spec 3, m3-workspace-persistence (2026-10-10)

- **Tab ids are uuids now**, not `linkedPanel`: a lazy tab (every restored background tab) has
  no panel until it is first selected, so 2b's model put `null` in it. `WindowWorkspaces` keeps
  tab → uuid (`idOf`, `tabOf`); the uuid is the tab value `vimma-tab`, the workspace id
  `vimma-workspace`. `PaneView` still uses panels; the conversion happens only when saving and
  restoring. The goto picker keeps panel ids and uses the uuid for a lazy tab (`tabById` falls
  back to `tabOf`), so `VimmaHost` is unchanged.
- **Saving**: at the end of every task that changed the model, a pane tree (`PaneView.onChange`
  after each reconcile) or a label (`VimmaTabLabelChanged`, fired by `setTabLabel`), the tab
  values and the window value `vimma-workspaces` (`toSnapshot` with every workspace's tree, the
  shown one and the parked ones, in uuids, and `tabLabels`) are written, unless the window value
  has a newer schema (`canWrite`) or a restore is under way. A microtask, not a timer: nothing is
  lost when the window closes or the app quits right after a change; `SSWindowClosing` and
  `SSWindowStateBusy` also flush. Unchanged text is not written again.
- **Restoring**: `SSWindowStateBusy` → pending (tab events and the definitions observer are not
  applied, nothing is written); `SSWindowStateReady` → the reconcile, which is also the build at
  init (a window whose start finds a restore under way builds on its Ready). It re-reads the
  uuids (tab value first; a second holder of one gets a new uuid), places every open tab in the
  workspace owning its container, else (foreign) the snapshot's or its `vimma-workspace`'s, else
  the active one; restores each workspace's selected tab from the snapshot; the active workspace
  is the selected tab's. A window value that differs from what this window last wrote is a
  restored one: its labels fill tabs that came back without `vimma.tabLabel`, and its pane trees
  go to `PaneView.restore` (the active one shown, the others parked; a lazy member gets its
  browser with `gBrowser.insertBrowser`, as split-view activation does). Firefox restores
  `hidden`, the split wrappers and the scroll positions.
- **Labels: no consolidation.** The rename seam planned to read `vimma.tabLabel` once into the
  snapshot and drop the tab value. Dropping it would lose a label on undo-close-tab and on a move
  to another window (only tab values travel with a tab), so the tab value stays the source of
  truth; the snapshot's `tabLabels` is written too and fills a tab that lacks the value.
- **Prefs**: `browser.startup.page = 3`, `services.sync.prefs.sync.browser.startup.page` and
  `services.sync.prefs.sync.privacy.userContext.enabled` = `false` (decision 9).
- **Tests**: `browser_vimma_workspace_restore.js`. Gate 2: two workspaces built in one window
  (A: start tab, a long page scrolled to 1200, a renamed tab selected; B: two tabs split
  side by side, active), `SessionStore.getBrowserState()`, that window's state (its tab label
  values removed, so the label must come from the snapshot) restored with `setWindowState` into
  a fresh window: workspaces, membership and uuids in order, active workspace, each selected
  tab, hidden flags, the label, B's pane tree with its rectangles within 1 px, and the long page
  lazy until selected, then `scrollY === 1200`. A newer-schema window value: one workspace with
  every tab, a new tab joins it, the value left byte for byte. The three prefs. Red before (11
  failures), green after; whole `tests/browser/` suite green. Mutation checks: not restoring each
  workspace's selected tab fails "A's selected tab is remembered"; dropping the
  `browser.startup.page` pref fails its assertion. `browser_vimma_workspace_switching.js`'s
  helpers read the model's id with `idOf` (the id changed, not the assertions).
- **Not done here:** a real quit and relaunch: the e2e harness launches one browser per
  scenario and has no restart step, so it moves to sub-spec 7 (`m3-restart-restore`). The
  live-restore test of the plan (undo close tab, two brackets in a row, `setWindowState` without
  overwrite) is covered only by the gate's path through the same bracket; side effects waiting
  for `promiseAllWindowsRestored` and unpinning (decision 11) are still open. Parked pane trees
  are saved and restored but only the active workspace's layout is asserted.

## Settled: sub-specs 4a and 4b, m3-workspace-lifecycle and m3-workspace-move (2026-10-10)

- **Keys and commands.** `prefix+shift+n` / `:wsnew name`, `prefix+shift+w` / `:wsrename name`,
  `prefix+shift+d` / `:wsdelete [name|number]`, and `:wsmove name|number` (action
  `move_to_workspace`, `workspace.move_tab`, unbound: plan §2 binds no key). A key opens the
  command line with its command typed (`wsrename <current name>`), as `switch_workspace` does;
  no new text UI. `:wsn` stays `:wsnext` through an alias (Vim's `:wsn[ext]`), since `wsnew`
  made the prefix ambiguous. The host side is `host/workspace-ops.mjs`.
- **Core** (`workspacedefs.mjs`): `renameWorkspaceDefinition` (refuses a config workspace, whose
  name is its `[workspaces]` key and what a reconcile matches by: rename it in `config.toml`),
  `closeWorkspaceQuestion` (decision 7's texts) and `newWorkspaceLooks` (the first colour no
  workspace uses, a circle).
- **Store:** `newWorkspace(name)`, `renameWorkspace(id, name)` (updates the container's name too,
  only while it is still ours: the startup check adopts by id and name), and
  `closeWorkspace(id, { confirmed })`: a runtime workspace goes through `deleteWorkspace`
  (container and site data), a config one only has `closeContainerTabs` (every window); the last
  workspace stays. Every change notifies the windows, whose `#sync` (2b) applies it, so creating,
  renaming and closing reach every window.
- **The y/N question** reuses the rename prompt's line (`RenamePrompt.ask`): `y` (or `Y`) is yes,
  any other key no. On yes, a window showing the workspace switches to the previous one first;
  the store then closes it. A config workspace with no tabs is not asked about (notice).
- **Move** (`WindowWorkspaces.moveTab`): out of the split first (`PaneView.close()` on the
  focused pane keeps its tab; a wrapper not ours is `unsplitTabs()`), then `addTab` of the URL
  in the target's container with `reopenInContainer`'s principal rules (a lazy tab's from
  SessionStore), right after the original; `TabOpen` of that copy applies core's
  `moveTab(s, old, target, { newTabId })` and hides it; the label (`setTabLabel`) and mute
  (`toggleMuteAudio(muteReason)`) carry over; the original is removed. A workspace left empty
  gets its home tab first, so the window stays where it was. Persistence needs nothing new: the
  model change is saved by 3's `#save`, and the copy's `vimma-workspace` value is the target.
- **Tests:** `browser_vimma_workspace_ops.js` (7 tasks): the last workspace refused; create by
  key (cycling, bar, snapshot, home tab in the container, a taken name refused); rename by
  command (bar, container, snapshot); close asks, `n` keeps, `y` deletes container and cookie
  (after `clear-origin-attributes-data`), main's cookie stays; a config workspace keeps its
  container and loses its tabs, and refuses a rename; move keeps label and mute, alpha loses it,
  beta has it, the window stays; a split member leaves the split and moves by number. Red before
  (8 failures), green after; whole `tests/browser/` suite green, `browser_vimma_workspace_restore.js`
  included. `browser_vimma_help_overlay.js`: new/rename/close workspace rows are runnable now
  (the not-yet examples are the picker and the side panel). Mutation check: not copying the label
  fails "the label is kept".
- **Hardening (PR #64):** the `y` stands for the workspace as asked about: its `source`,
  name and container go to `closeWorkspace` (`asked`) and are checked again at the answer, so
  a `config.toml` reload that made a config workspace runtime meanwhile refuses with `changed`
  instead of deleting its data. `deleteWorkspace` returns `{ cleared }`; a container no longer
  recognisably ours (renamed in Settings) keeps its tabs and data, and the notice says so.
  New names of digits only are refused (`:wsmove 2` reads digits as a place; a file's existing
  names and `[workspaces]` keys are not checked: config keeps accepting number-like names, which
  `:wsmove 2` still reads as a place). Container 0 is never passed to `closeContainerTabs`. A
  move's refusals all come before the tab leaves its split. A held key (`e.repeat`) is no answer.
  Tests added: the default container's cookie survives a delete, only the deleted container's
  `clear-origin-attributes-data` fires, Esc and Enter answer no, a config workspace with no tabs
  is refused, moving a workspace's last tab opens its home tab, plus fixes 1-3 and 5 (red: 8
  unexpected; green). Mutation check: reporting `cleared: true` always fails the kept-data test.
- **Not done here:** a lazy background tab is moved by its saved URL in code but only the
  selected tab can be moved (picker `m` is sub-spec 5, with the warning before the move; `:wsmove`
  says afterwards that the history stayed behind). `contextual-identity-deleted` (a container
  removed in Settings gets a new one) and the startup `privacy.userContext.enabled` status-bar
  error from 4a's scope are still open.

## Settled: sub-spec 5, m3-workspace-picker (2026-10-10)

- **Core** (`picker.mjs`): the goto picker's state machine, matching and highlights now take
  either item kind. `workspaceItems(model, isForeign)` gives one `WorkspaceItem` per workspace
  (`kind: "workspace"`, place, name, `tabCount`, `foreignCount`, `active`); a workspace matches
  by its name only. `itemId` is a tab's or a workspace's id: `openPicker`'s option is `activeId`
  and Enter's effect is `{ type: "select", id }` (both were tab-only). `m` in browse mode on a
  workspace row gives `{ type: "move", id }`; in a goto picker it does nothing, in search it
  types. `workspacedefs.mjs`: `moveTabQuestion(name)`, decision 6's warning.
- **UI**: the same dialog class (`GotoPicker`, now with a look: id, heading, hint, a row's cells)
  and `WorkspacePicker` (`#vimma-workspace-picker`); a row reads
  `2  work  3 tabs, 1 foreign · current`, and the current workspace's row is also
  `.vimma-picker-active` (its index in `--vimma-accent`).
  `picker.css` styles `.vimma-picker`, so both take the theme tokens.
- **Keys**: `prefix+w` / `:workspace` with no name (`workspace.picker`): `j`/`k`, `/` filters,
  Enter switches (`switchTo({ id })`), `m` moves the selected tab, `Esc`/`q` close. No rename,
  delete or create keys in the picker: the spec gives those to `prefix+shift+w/d/n` only.
- **Move from the picker** (`moveTabFromPicker`): the picker closes, and the rename prompt's line
  asks `moveTabQuestion` ("Move this tab to "beta"? It is reopened there; its back/forward
  history and form data are lost. y/N"); `y` runs 4b's `moveTab`. As with closing, the yes stands for what was asked about:
  at the answer the tab must still be the selected one and the workspace still there under the
  same name, else `nothing was moved`. A move to the tab's own workspace is refused without
  asking (a foreign tab may move into the workspace it was adopted by).
- **`opened in "work"`** (decision 12): `WindowWorkspaces` takes a `notify` option; a `TabOpen`
  that `#adopt` hides in another workspace calls it, and the host shows the notice. The status
  bar's workspace segment was done in 2b.
- **Tests:** `browser_vimma_workspace_picker.js` (7 tasks): the list, counts, current mark and
  selection, theme token, `/` filter and highlight, Enter switches, Esc keeps; `:workspace`
  opens it; `m` asks, `n` keeps, `y` moves and the window stays; a rename before the `y` moves
  nothing; `m` on the own workspace refused unasked; a background open says where. Red before
  (7 unexpected), green after; the whole `tests/browser/` suite passes. Vitest: workspace items,
  name-only matching, `m`/Enter effects, selection kept by id, the question text. The notice
  examples in `browser_vimma_tab_keys.js`, `browser_vimma_statusbar.js`,
  `browser_vimma_cmdline.js` and `browser_vimma_help_overlay.js` used `ctrl+b w` as the
  not-yet key; they use `ctrl+b b` (side panel) now, and `workspace_picker` is in the overlay's runnable list. Mutation check: dropping
  the name comparison from the stale-answer guard fails "the answer is refused".
- **Not done here:** a moved lazy background tab still needs selecting first (the picker moves
  the selected tab); `contextual-identity-deleted` and the startup `privacy.userContext.enabled`
  error stay open from 4a.

## Settled: sub-spec 6, m3-side-panel (2026-10-10)

- **What it shows** (as the "Side panel" section planned): the current workspace only, never a
  list of every workspace (plan §2). Head: a dot in the workspace's colour (the status bar's
  `WORKSPACE_COLOR_TOKENS`), `index:name`, and `ctrl+b ( <previous> · ctrl+b ) <next>` (wrapping;
  none with one workspace). Rows: number, label (rename > title > URL, as the picker), host,
  `♪` while playing, `foreign`; the selected tab's row is `.vimma-panel-active`. Tabs in window
  order (`pickerWorkspaces`); pinned tabs are in no workspace and not listed, so a row's number
  is the place among the workspace's tabs, not `prefix+N`'s (which counts pinned tabs first).
- **Core** `sidepanel.mjs`: `openPanel(model, info, { color, selectedId })`,
  `refreshPanel` (the highlight stays on its tab within the same workspace, else the active tab)
  and `panelKey`: `panel.down`/`up` clamp at the ends (as the pickers), `panel.open` and
  `panel.select` give `{ type: "select", id }`, a digit past the last row
  `{ type: "refuse", text: "no tab 9 in work" }` (a notice; the panel stays open),
  `panel.close` `{ type: "close" }`.
- **Keymap:** a `[keys]` binding that starts with `<leader>` now lives in `normal` and `panel`
  mode, so `<leader>n` closes what it opened, and a user's rebinding of `toggle_sidebar` does too.
  Prefix and ctrl/alt chords were global already (`prefix+b`, `prefix+)`).
- **Host:** `ui/side-panel.mjs` (`SidePanel`), a XUL `vbox#vimma-panel` prepended to `#browser`
  on first open, `side-panel.css` with `order: -1 !important` and `--vimma-panel-width` (18rem).
  `sidebar.toggle` opens or closes it (no workspaces, a private window: the picker's notice).
  `_mode` is `panel` while it is open (after help, the pickers and the `:` line, which go over
  it); `panel` is modal like `help`: an unbound plain key is consumed, never the page's.
  Re-rendered on `WindowWorkspaces`' change (switch, rename) and on `TabOpen`/`TabClose`/
  `TabSelect`/`TabAttrModified`/`TabMove` while open.
- **Focus:** opening focuses the panel; closing focuses the selected page if focus was in the
  panel. Firefox moves focus to the page at the end of every tab switch
  (`_adjustFocusBeforeTabSwitch` blurs chrome, `AsyncTabSwitcher` focuses the browser), so the
  panel takes focus back on `TabSwitchDone` while open (prefix+), prefix+c from the panel).
- **Not-yet examples:** with `ctrl+b b` built, no default binding under the prefix and no `:`
  command is unbuilt. `head.js` `bindUnbuiltPrefixKey()` binds `history_back` to `ctrl+b o` for
  the notice tests in `browser_vimma_tab_keys.js`, `_statusbar.js`, `_cmdline.js` and
  `_help_overlay.js` (same assertions, the notice now names "Go back"; the overlay's dimmed
  example row is `history_back`). `:sidebar` in `browser_vimma_cmdline.js` now asserts the panel
  opens: the unbuilt-command notice is the keys' `_run` path, still covered by `ctrl+b o`.
- **Tests:** `browser_vimma_side_panel.js` (9 tasks): hidden at start, `<leader>n` opens it
  leftmost with header, neighbours, numbered rows, the active row, focus, `panel` mode and the
  theme token; j/k clamp, Enter selects and focuses the page; a digit selects, a missing one is
  refused; Esc, `prefix+b` and unbound keys never reach the page; prefix+)/prefix+( re-render with
  focus kept; a tab opened while open gets a row; leftmost with `sidebar.position_start=false`;
  `:sidebar`. Red before (8 failures: no panel), green after; the whole `tests/browser/`
  suite passes. Vitest `sidepanel.test.mjs` (18). Mutation check: dropping `!important` from
  the panel's `order` fails "still the leftmost box".
- **Left:** a mouse (clicking a row); a configurable width in `config.toml`; a web page in the
  panel stays out of scope.
- **Later (2026-10-10):** the leader has no default bindings: `toggle_sidebar` is
  `prefix+b` only, and `space n` does nothing by default. The leader option and `<leader>`
  bindings in `[keys]` stay (a user's `toggle_sidebar = ["prefix+b", "<leader>n"]` still opens
  and closes the panel, in `normal` and `panel` mode). The side-panel mochitest presses
  `ctrl+b b` where it pressed `space n`, with a task that `space n` leaves it closed.

## Settled: the 4a/4b/5 leftovers, m3-container-edges (2026-10-10)

- **Container deleted outside Vimma.** Grepped, not guessed: `CIS.remove(id)` (CIS:500-526)
  clears the container's data, drops the identity and fires `contextual-identity-deleted`; it
  closes no tab. Settings (`containers.mjs:124-126`) runs `closeContainerTabs` first; an
  extension's `contextualIdentities.remove` (`ext-contextualIdentities.js:327-353`) does not, so
  its tabs stay open in the deleted container. As the Container lifecycle planned, the app's
  store (`watch: true`; test stores do not observe) keeps the workspace and creates a new
  container at once, saves and notifies; Vimma's own delete drops the definition before it
  removes the container, so it never matches. Each window's `#sync` gives the model the new
  container (core `setWorkspaceContainer`), marks tabs left in the old one `foreign` (they stay
  in the workspace) and says `"ext" lost its container (deleted outside Vimma); …`. New tabs
  route to the new container, never 0; the definitions file and the window snapshot carry it.
  Not done while `readOnly` (nothing may be created) or with containers off.
- **Containers off at startup:** `WorkspaceStore.alert` (`CONTAINERS_OFF_ALERT`) while
  `disabled`; `VimmaHost.status` passes it as `alerts`, which core's status bar shows as a
  persistent `alert` segment (error colour, right side, after config errors), unlike a notice.
  Vimma does not set the pref: Firefox's default is already `true` (`firefox.js`), so a branding
  default would change nothing, and flipping a user's `false` back is what the plan rejects.
- **Lazy move:** `moveTab` of a tab without `linkedPanel` reopens it with `createLazyBrowser`
  and `lazyTabTitle` (as `adoptTab` keeps lazy tabs): URL, title and label come along, nothing
  loads until it is selected, and its SessionStore state has the target container. `:wsmove`
  and the picker's `m` still act on the selected tab, which is never lazy, so this path is
  reached only through `moveTab` (a later per-row move, e.g. in the side panel, gets it free).
- **Number-like names:** core `workspaceRefFor(model, text)`: a workspace of exactly that name
  first, else digits are a place, else a name; `:workspace`, `:wsmove` and `:wsdelete` use it.
  New names of digits stay refused (4a), and `config.test.mjs`'s file-order test is unchanged.
- **Tests:** `browser_vimma_workspace_edges.js` (6 tasks): an extension-style delete (new
  container named after the workspace, model, notice, old tab kept and foreign, `ctrl+t` into
  the new one, file and snapshot), a Settings-style delete (empty workspace, home tab in the new
  container), Vimma's own delete not recreating, the containers-off alert (a store of its own
  with `enabled: () => false`; the app store marked `disabled` for the bar; persistent past Esc;
  the pref untouched), a lazy move, and `:workspace 2` / `:wsmove 2` with config names `2` and
  `x`. Red before (11 unexpected), green after; the whole `tests/browser/` suite passes. Vitest:
  `setWorkspaceContainer`, `workspaceRefFor`, the `alert` segment (3 red, then green). Mutation
  check: not marking the old container's tabs foreign fails "marked foreign".
- **Left:** a key to move a background (possibly lazy) tab from a list; `lostContainers` from
  the startup check is still not shown in the status bar. (Since changed: `lostContainers` is shown; see "Settled: pinned tabs and lost
  containers".)

## Settled: pinned tabs and lost containers (2026-10-18)

- **Pinned tabs (decision 11).** `TabPinned` drops the tab from the model and, after the event
  (tabbrowser is still inside `pinTab` while it dispatches `TabPinned`), `unpinTab`s it; its
  `TabUnpinned` puts it back in the workspace of its container, and the notice reads
  `unpinned "<label>": a pinned tab would show in every workspace` (core `unpinnedNotice`). The
  pinned-tab guards in the tab keys, `:q`, the side panel and the agent's tab list stay, because
  windows without workspaces (private windows, popups, containers off) still have pinned tabs;
  their tests set `WindowWorkspaces.unpinsPinnedTabs = false` to reach them in a window with
  workspaces.
- **Lost containers.** `WorkspaceStore.alerts` adds core's `lostContainersAlert(lostContainers)`
  after the containers-off alert; `VimmaHost.status` passes it to the bar as an `alert` segment,
  persistent for the session, because the lost sign-ins are a lasting condition that a timed
  notice could hide before it is read.
- **Tests:** `browser_vimma_workspace_switching.js` (a tab pinned outside Vimma is unpinned,
  stays in its workspace, a notice says so, and it is hidden in another workspace),
  `browser_vimma_workspace_edges.js` (the lost-containers alert persists past Esc and goes with
  the list); vitest for both texts. Red before (2 vitest, 2 mochitest failures), green after.
- **Left:** a default key to move a background tab from a list; the spec names none. (Since
  changed: `m` in the side panel; see "Settled: moving a background tab from the side panel".)

## Settled: moving a background tab from the side panel (2026-10-18)

- **Decision:** `m` on a side-panel row opens the workspace picker, and the workspace chosen there
  gets that row's tab, because panel-mode keys never reach the page, the row names the tab
  without selecting it (so a lazy tab stays lazy), and it mirrors `m` in the workspace picker.
  Rejected: `m` in the goto (tab-list) picker followed by a second prompt for the workspace,
  because `m` there is a search character and the second prompt would add a step; and only a
  `:wsmove <tab> <workspace>` command, because typing a tab reference is slower than pointing at
  a row.
- **Keys:** `[modal.panel] m = "panel.move"` (action `panel_move_tab`). The bookmarks panel
  shares `panel` mode and keeps `m` as its move to a folder, because both panels are never open
  at once: core `bookmarksKey` treats `panel.move` as `bookmarks.move`, and the host sends the
  action to whichever panel is open. `bookmarks_move` is unbound by default and still rebindable.
- **Core** (`sidepanel.mjs`): `panel.move` gives `{ type: "move", id }` for the highlighted row,
  refuses a pinned row (`PINNED_MOVE_TEXT`), and does nothing in an empty workspace.
- **Host:** the panel closes, then `WorkspacePicker.openFor(tab, title)` opens the picker with
  the heading `Move "<title>" to`; there Enter means `m`, because Enter must not switch
  workspace. The choice runs `pickerMove` and `moveTabFromPicker` with the row's tab instead of
  the selected one, so the private workspace's move and decision 6's warning are the same code.
  The stale-answer guard keeps the workspace-name check and the tab's `isConnected`, but not
  "still selected", because the row's tab was never selected.
- **Tests:** vitest (the `move` effect for the highlighted row, the pinned refusal, the empty
  workspace, `m` in panel mode, `panel.move` in the bookmarks panel); mochitest
  `browser_vimma_side_panel.js` (Esc moves nothing, the own workspace is refused unasked, `y`
  moves a background tab to another workspace while the window and its selected tab stay, a tab
  closed before the `y` moves nothing). Red before (5 vitest, 2 mochitest failures), green after.

## Settled: sub-spec 7, m3-e2e (restart part, 2026-10-10)

- **Scenario** `tests/e2e/scenarios/m3-restart-restore.json`, gate 2 on a real quit and start:
  fresh profile; `main` gets a page that sets the persistent cookie `ws=main` in its container
  (`tests/e2e/fixtures/cookie.html#<name>`); `prefix+shift+n` creates `work` (cookie
  `ws=work`, then `prefix+v` splits it) and `personal` (`ws=personal`); `prefix+(` back to `work`;
  `ctrl+q`; the same profile starts again. Asserted after the start: `work` active with its
  three tabs and its split (axis `x`, two leaves); `prefix+)` → `personal`, → `main`, → `work`
  (order, count and wrap), each with its tabs, titles and no split where there was none; then
  a fresh tab of `cookie.html` in each workspace sees only that workspace's cookie, so the
  containers and their cookie jars came back mapped to the right workspaces. In `work` that
  tab shows in the focused pane and the split stays. Stable 3/3 locally (headless, artifact
  build); with `browser.startup.page = 0` instead of Vimma's 3 it fails at the first check
  after the start (one tab, no split), as it should.
- **Harness** (spec m0-e2e-harness): a `restart: "quit"` step (`ctrl+q`, the discovery file
  must be gone, `launch`'s new `relaunch()` on the same profile and display), a scenario
  `prefs` field (`null` drops one of the harness's prefs, here `browser.startup.page = 0`), and
  `fixture:<name>#<fragment>`. The relaunch passes no `about:blank` on the command line: a URL
  argument opens beside the restored session, which gave `work` a fourth tab on the first try
  (a harness artefact, not a product bug: a user's `vimma <url>` does the same, by design).
- **Control server**: `state.workspace` is the active workspace's name and `state.panes` the
  pane tree in `state`'s tab ids (shape in m0-control-protocol-and-vimma-ctl), read-only; no
  new command and no change to `vimma-ctl` (it prints `state --json` as received).
  `browser_vimma_control.js` asserts both (red before: 3 failures).
- **Not done here:** the 200-tab `prefix+)` measurement (plan §9 risk) needs a paint timestamp
  the control socket does not report; a crash-style kill and crash-recovery restore (the
  harness profile turns `resume_from_crash` off, and the 15 s save interval makes it a timing
  test); the scroll position after a real restart (gate 2's mochitest covers it).
- **Still open after m4-split-panes sub-spec 7** (2026-10-10): the 200-tab measurement was not
  folded into the M4 e2e gate. It has the same blocker as M4's key-to-paint timing: a paint
  timestamp from the control socket (a protocol addition, its own spec with the perf gate).

## Settled: workspace keys move to `prefix+(` / `prefix+)` (2026-10-10)

- **Decision:** normal mode lacked Vim's `ctrl+d` and `ctrl+u`, and those keys are Vim defaults, so
  workspace switching moves to other keys. `next_workspace`
  is `prefix+)` and `previous_workspace` `prefix+(` (tmux's `switch-client -n` / `-p` keys),
  global like every `[keys]` binding, so they work from normal, insert, visual and panel mode as
  `ctrl+i` / `ctrl+u` did. The `prefix+w` picker stays. Normal mode gains vim's `ctrl+d` /
  `ctrl+u` (half page, as `d` / `u`, which stay), `ctrl+e` / `ctrl+y` (a step, as `j` / `k`) and
  `ctrl+o` / `ctrl+i` (history back / forward, as `H` / `L`). `ctrl+f` is left to Firefox's find
  and `ctrl+b` stays the prefix. In insert mode all six are the page's (and then Firefox's).
- **Firefox keys given up in normal mode:** `ctrl+d` (bookmark: `prefix+a`), `ctrl+u` (view
  source: `gf`), `ctrl+o` (Open File: the File menu or `:open file:///…`), `ctrl+i` (Page Info:
  the menu). `ctrl+e` and `ctrl+y` are no Firefox key on Linux (`ctrl+e` is search on other
  platforms; Linux uses `ctrl+j`), so they clash with nothing. Recorded in docs/limits.md.
- **Layout:** the host matches a chord by `KeyboardEvent.key` (`chordFromEvent`), and a shifted
  punctuation key is its character with shift folded in, so `prefix+(` is whatever key types `(`:
  `shift+9` on US, `shift+8` on Finnish. `prefix+0` is unaffected (unbound; `cancel`).
- **Tests:** dispatcher (core): `prefix+(`/`)` in every mode, `(` from a shift+8 event, old keys no
  longer switch in any mode, the six ctrl keys in normal and insert, a count with `ctrl+d` (13
  red, then green). Mochitests: `ctrl+d`/`ctrl+u`/`ctrl+e`/`ctrl+y` scroll and reach the page in
  insert mode (`browser_vimma_insert_scroll.js`), `ctrl+o`/`ctrl+i` walk history with no file
  picker (`browser_vimma_nav_keys.js`), the old keys no longer switch
  (`browser_vimma_workspace_switching.js`); 11 unexpected before, 0 after. The workspace tests and
  the e2e scenarios (m3-restart-restore, m4-split-panes) press the new keys; no assertion changed.
  Mutation check: binding `<C-d>` to `scroll.down` fails two dispatcher tests.

## Settled: crash restore and scroll after a real restart (e2e leftovers, 2026-10-10)

- **`m3-crash-restore`**: `main` with a long page scrolled to the bottom (`G`), `work` with a
  split, `personal` empty, `main` active; `"restart": "kill"` (harness, spec m0-e2e-harness)
  waits for `recovery.jsonlz4` to settle (`browser.sessionstore.interval` 500 ms in the
  scenario), SIGKILLs the browser pid and starts again. Asserted: `main` active with the page
  reloaded at the bottom, then `prefix+)` through `work` (three tabs, the split) and `personal`
  back to `main`. Crash recovery (`resume_from_crash`, the build default) and Vimma's
  `browser.startup.page = 3` each restore it alone (checked); with both off it fails at the
  first check after the start (one tab). 3/3 locally (Xvfb, artifact build), about 7 s.
- **`m3-restart-scroll`**: two long pages, one at the bottom and one part-way down (`j j j`),
  `ctrl+q`, start: the selected one reloads part-way down, the other keeps its saved label until
  selected. The page reports where it is in its title (`tests/e2e/fixtures/long.html`); the
  navigation type (`navigate` vs `back_forward`) tells the reloaded page from the stale label.
  A load counter in localStorage was tried first and fails after a SIGKILL (its last write is
  lost), hence the navigation type. Red check: the fixture forcing `scrollTo(0, 0)` on a
  restored load fails it ("long top back_forward").
- **Watch:** after merging main's Vim-buffer workspace keys, `m3-crash-restore` failed once in
  21 local runs (the first run after a fresh artifact build): the second `prefix+)` after the
  restart left the window in `work` (with its split) for 10 s, as if the key was lost. It did
  not recur in 20 more runs, 6 of them on two busy CPUs, and CI passed. If it recurs, quarantine
  it with an issue (plan §5) and look at keys sent while a restored split's tabs load.

## Settled: workspaces as Vim buffers (2026-10-10)

- **Goal:** workspace switching works like Vim buffers: an alternate workspace as
  `ctrl+^`, unimpaired-style `]w` / `[w`, and short commands like the buffer commands.
- **Alternate (`last_workspace`, `workspace.last`):** core's model gains an optional
  `alternate` (Vim's `#`): every change of `active` through `updateState` records the workspace
  left, if it is still in the list; an alternate that is deleted or becomes active is dropped
  (`deleteWorkspace` of the active one keeps a different alternate). `lastWorkspace` switches to
  it, which swaps the two, so a second press toggles. Nothing tracked recency before: the store's
  `lastActive` is app-wide (the next start's routing), the panes' `mru` is per split, so neither
  fits. Per window, since the model is. **Persisted** as the snapshot's optional `alternate`
  field (schema 1 stays: written only when set, read leniently, dropped unless it names another
  workspace), in the window value; `#reconcile` rebuilds the model with switches of its own, so
  it then sets the saved alternate explicitly (`setAlternate`). Without one the runner says
  `no previous workspace in this window`.
- **Keys:** `[keys] last_workspace = ["prefix+^", "prefix+ctrl+6"]` (every mode; tmux's last
  session is `prefix+L`, but that is a pane key here), `[modal.normal]` `<C-^>` and `<C-6>`;
  `]w` / `[w` run `workspace.next` / `.previous`. No normal-mode binding started with `[` or `]`
  before (`prefix+[` is copy mode, a prefix key).
- **Dead keys (widget/gtk):** `KeymapWrapper::ComputeDOMKeyNameIndex` maps every
  `GDK_dead_*` keyval to `KEY_NAME_INDEX_Dead` (`widget/NativeKeyToDOMKeyName.inc:452-461`);
  `ctrl` does not change the keyval's level, so Finnish `ctrl+shift+¨` is `key = "Dead"`
  (`code = "BracketRight"`, `keyCode` 0 by `ComputeDOMKeyCode`, nsGtkKeyUtils.cpp:1264-1299),
  and `chordFromEvent` returns null for it. In a dead-key sequence the IM's commit keeps the raw
  key value (IMContextWrapper.cpp, "expose raw keyCode and key value"), so `^` never arrives as
  a chord on those layouts. US `ctrl+shift+6` is `key = "^"` with shift (folded away). `ctrl+6`
  is `key = "6"` on every layout and is no Firefox key on Linux (`key_selectTab6` is `alt` under
  `XP_GNOME`, browser-sets.inc.xhtml:380-391), hence the `ctrl+6` aliases. Finnish `]` / `[` are
  `AltGr+9` / `AltGr+8`, matched by key-handling-batch § 3.
- **Commands:** aliases `ws` (`:workspace`), `wn` / `wp` (`:wsnext` / `:wsprev`), `wd`
  (`:wsdelete`), `wa` (`:wsnew`), and `:workspaces` (picker, like `:ls`); `:ws #` is the
  alternate unless a workspace is named `#`. `wsn` stays `:wsnext`. **Prefixes:** `:ws` was
  ambiguous and is now exact; `:workspaces` would have made `:wo`…`:workspac` ambiguous, so
  `parseCommandLine` now lets a candidate whose name begins a word of every other candidate win
  (Vim's shortest abbreviation): `:wor` → `:workspace`, and likewise `:bookm` → `:bookmark`,
  `:addo` → `:addon` (ambiguous before). `:w` stays ambiguous. No word belongs to two commands
  (a core test). **Completion:** `ARGUMENT_KINDS` maps `workspace`, `wsdelete` and `wsmove` to
  the host's `workspace` names list (`workspaceNames`), and keeps the word as typed (`:ws per` →
  `ws personal`); `:wa` names a new workspace and completes nothing.
- **Tests:** core: model and snapshot (6 red, then green; the round-trip property covers the
  field), commands and keys (26 red, then green), including GTK-shaped US and Finnish events.
  Mochitest `browser_vimma_workspace_buffer_keys.js`: `ctrl+^` toggles and back, `ctrl+6`,
  `ctrl+b ^` / `ctrl+b ctrl+6` from insert mode, the notice in a new window, `]w` / `[w` (also
  as AltGr+9 / AltGr+8), every alias, `Tab` completion, and the alternate across a session
  restore (saved alternate `main`, where the rebuild alone would give `A`); 10 unexpected
  before, 0 after; 9 repeats on two busy CPUs clean. Mutation check: dropping the
  `setAlternate` in `#reconcile` fails the new-window and restore tasks.

## Out of scope

Per-workspace autofill stance (`autofill`, M6); syncing workspaces between devices; a web page in
the side panel; unloading hidden tabs; URL-to-workspace routing rules (since built in their own
spec, [workspace-routing](workspace-routing.md): `[[routes]]` by domain, URL or the app that opened
the link, through the same three patch hunks as decision 3); isolating permissions
(`permissions.isolateBy.userContext` is a possible later opt-in, untested by us); pinned tabs;
config reload of `[workspaces]` while running (M5 host: it reuses the definitions reconcile).

## Cross-reference: bookmarks per workspace

Each workspace owns a folder in the Bookmarks Toolbar, kept in its definition as
`bookmarksFolder` (the folder's Places guid; a folder made outside Vimma is found by the
workspace's name and then linked). `:wsrename` renames the folder; `:wsdelete` of a runtime
workspace with bookmarks asks a second question (keep the folder, move its bookmarks to another
workspace, delete them; Esc closes nothing), under the same stale-answer guard as its y/N. The
bookmarks panel and quick add are rooted at the current workspace's folder. Details, tests and
the Settled note: [bookmarks](bookmarks.md), decisions 11 and 12.
