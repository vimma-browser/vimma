# Spec: temporary-containers

Status: draft · Area: core (`packages/vimma-core/src/actions.mjs`, `defaults.mjs`, `config.mjs`,
`cmdline.mjs`, a new `packages/vimma-core/src/workspaces/tempcontainers.mjs`, `statusbar.mjs`,
`ui/tabline.mjs`, `ui/sidepanel.mjs`, `ui/picker.mjs`), chrome (`workspaces/WorkspaceStore.sys.mjs`,
`workspaces/WindowWorkspaces.sys.mjs`, `workspaces/WorkspaceRouter.sys.mjs`, `host/tab-ops.mjs`,
`host/pane-ops.mjs`, `host/close-last-ops.mjs`, `ui/statusbar.mjs`, `ui/tabline.mjs`,
`ui/side-panel.mjs`, `ctl/VimmaControl.sys.mjs`) · Upstream patches: none, unless open question
1 is answered with option C (one more hunk in `Tabbrowser-sys-mjs.patch`) · ADR: none

Issue: [#1602](https://github.com/vimma-browser/vimma/issues/1602)

Builds on [m3-workspaces](m3-workspaces.md) (every workspace is a container, `foreign` tabs),
[private-workspace](private-workspace.md) (the private workspace, and its option B and decision
11), [workspace-routing](workspace-routing.md), [multiple-splits](multiple-splits.md),
[close-last-tab](close-last-tab.md) and [vimma-mcp](vimma-mcp.md). Engine paths are relative to
`engine/` and were checked against Firefox 161.0.

## Summary

A temporary container is a tab, or a small group of tabs, inside the current workspace that has
cookies and site storage of its own and loses them when its last tab closes. It lets a user sign
in to a second account, or look at a site signed out, beside their normal tabs, in the same
workspace and the same split, without opening the private workspace or making a workspace for
it. It is optional: a user who never opens one sees nothing new.

The feature is named "temporary container", not "private", because it is not private browsing:
its history, cache and session entries reach disk like any tab's (Research), and the
[private-workspace](private-workspace.md) spec reserves the word "private" for Firefox's private
browsing (its decision 11).

## Problem

Each workspace is one container ([m3-workspaces](m3-workspaces.md)), so every tab in a workspace
shares one set of sign-ins. Three cases do not fit:

- **Two sessions side by side.** A course site in one pane and a notes site in the other is a
  split within one workspace and works today. Following a guide signed in to an admin account in
  one pane while a personal account of the same site is open in the other does not: both panes
  share the workspace's cookies, so signing in to one signs out the other.
- **A clean session next to a signed-in one.** Checking what a page shows to a visitor who is
  not signed in, or testing a sign-up flow, needs a tab without the workspace's cookies.
- **A quick look without leaving the workspace.** The [private workspace](private-workspace.md)
  is a separate window. Its tabs cannot sit in a split with a normal tab (private-workspace,
  "Split view and PaneView"), and going there leaves the workspace and its split.

Today the only way to get a throwaway container in Vimma is a container add-on such as Temporary
Containers. Its tabs belong to no workspace and join the current one as `foreign` tabs
(`docs/guide.md`, "Add-ons that clash with Vimma"), with no Vimma key, no marker beyond
`foreign`, and an add-on with access to every page.

## Behaviour

Keys and names below are proposals where an open question says so; every key is rebindable in
`config.toml`, like the prefix and the leader.

1. As a Vimma user, `:tmp` (long form `:temporary`) opens a new tab in a new temporary container
   in the current workspace and selects it. `:tmp <url or search>` opens that page in it. A
   default key is open question 3.
2. As a Vimma user, `:tmp vsplit` / `:tmp split` (`:tmp vs` / `:tmp sp`) split the current pane
   right / down, as `:vsplit` / `:split` do, with the new pane in a new temporary container.
   This puts a temporary session beside a signed-in tab of the same workspace in one split.
3. As a Vimma user, a page in a temporary container that opens a tab or a pop-up (a link with
   `target=_blank`, `window.open`, `F`, a middle click) opens it in the same temporary container,
   so a sign-in pop-up and the page that opened it share their cookies. Which other opens join
   it is open question 2.
4. As a Vimma user, the tab line, the side panel, the workspace picker and the status bar mark a
   tab in a temporary container, in text that does not depend on colour, and tabs of different
   temporary containers can be told apart (open question 5).
5. As a Vimma user, when the last tab of a temporary container closes, its cookies, storage and
   cache are deleted at once (open question 7). The workspace stays as it was.
6. As a Vimma user, a temporary container is not restored at the next start, and anything a crash
   left behind is deleted then (open question 7).
7. As a Vimma user, a temporary tab stays in the workspace it was opened in: `:wsmove`, the
   picker's `m` and the side panel's move refuse it with
   `a temporary tab stays in its workspace: open it again with :tmp there`.
8. As a Vimma user, `:tmp` in the agent workspace and in the private workspace is refused, with
   `no temporary containers in the agent workspace` / `the private workspace is discarded when
it closes already`.
9. As a Vimma user who turns on the automatic mode (open question 4), every new tab I open
   (`ctrl+t`, `ctrl+b c`, `t`, `:tabnew`, `P`) opens in a new temporary container instead of the
   workspace's container.
10. As a Vimma user, links from other apps never open in a temporary container; they open in a
    workspace's container as today ([workspace-routing](workspace-routing.md)).

## Research

### Containers and private browsing in Firefox

- **Two separate origin attributes.** A container is `userContextId`; private browsing is
  `privateBrowsingId`. Both are origin attributes fixed when a browsing context attaches
  (`docshell/base/BrowsingContext.cpp`, `CanSetOriginAttributes`; m3-workspaces research). A
  `<browser>` can ask for a container through its `usercontextid` attribute, but cannot ask to be
  private: its privacy is its window's (private-workspace research, `nsFrameLoader.cpp`).
  Private browsing per tab inside a normal window was examined in full and rejected as option C
  of [private-workspace](private-workspace.md): about 220 front-end call sites decide privacy by
  window, and each missed one leaks silently.
- **Creating and deleting a container.** `ContextualIdentityService.create(name, icon, color)`
  returns a public identity with a fresh id from an ever-increasing counter
  (`toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs:393-433`).
  `remove(userContextId)` calls `Services.clearData.deleteDataFromOriginAttributesPattern({
userContextId })` before dropping the identity (same file, 552-575), so the container's cookies,
  storage and cache go with it. It works on public identities only (`i.public`, 556-558). The
  same clear broadcasts `clear-origin-attributes-data`, on which SessionStore forgets closed tabs
  of that container (`browser/components/sessionstore/SessionStore.sys.mjs:220, 1255`).
  Identities are written to `containers.json` (m3-workspaces research).
- **What a container keeps apart.** Cookies, localStorage, sessionStorage, IndexedDB, HTTP and
  image cache, service workers, the HTTP auth cache, DNS cache, connections and TLS sessions are
  keyed by `userContextId` (m3-workspaces, "What a container isolates", with the engine tests).
  HSTS is not (`security/manager/ssl/nsSiteSecurityService.cpp:249, 264`, "Don't isolate by
  userContextId"). History, bookmarks, favicons, form history, saved logins and the downloads
  list are not (m3-workspaces, same table). Site permissions are, in Vimma, because Vimma sets
  `permissions.isolateBy.userContext` (`src/browser/branding/vimma/pref/firefox-branding.js:249`).
- **History.** The docshell skips global history when the browsing context's
  `UseGlobalHistory` is false or it is private (`docshell/base/nsDocShell.cpp:11920`).
  `UseGlobalHistory` is set from the absence of a `disableglobalhistory` attribute on the
  embedding `<browser>` when the context attaches (`docshell/base/BrowsingContext.cpp:855-856`).
  `Tabbrowser.sys.mjs` never sets that attribute (grep), so keeping a tab's visits out of history
  needs a change where it builds the tab's browser (`createBrowser`, 3178, called from
  `#createBrowserForTab`, 4843).
- **New tabs inherit the opener's container.** Vimma's hunk in `addTab`
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:3960-3968`, `Tabbrowser-sys-mjs.patch`)
  gives a tab with no container the opener tab's container (`openerTab`, which is also the
  selected tab when `relatedToCurrent`), else the active workspace's. Firefox's own
  `#createTab` does the same for a related tab (4746-4750). A pop-up shares its opener's origin
  attributes (`BrowserDOMWindow.sys.mjs` and `docs/security/03-workspace-deletion-and-containers.md`,
  W8). So tabs a temporary tab's page opens land in its container without new code.
- **Session restore** writes container tabs with their `userContextId`; only private windows are
  dropped (`toolkit/modules/sessionstore/PrivacyFilter.sys.mjs:108-126`).
- **Private-browsing-only prefs** (`network.cookie.cookieBehavior.pbmode`,
  `network.http.referer.defaultPolicy.pbmode`; `modules/libpref/init/StaticPrefList.yaml:15033,
15359`) apply only to private contexts, never to a container.

### Vimma today

- **A workspace owns one container.** `WorkspaceStore` creates it with
  `ContextualIdentityService.create` (`workspaces/WorkspaceStore.sys.mjs:305`) and reconciles the
  definitions with the public identities at startup (`planContainers`,
  `packages/vimma-core/src/workspaces/workspacedefs.mjs:317`). A container no longer
  recognisably a workspace's is kept with its data (`docs/security/03-workspace-deletion-and-containers.md`, W4).
- **`foreign` tabs.** A tab whose container no workspace owns joins the active workspace as
  `foreign` (`WindowWorkspaces.sys.mjs`, `#foreign` and `isForeign`; m3-workspaces decision on
  `openTab`). The picker counts them (`foreignCount`, `packages/vimma-core/src/ui/picker.mjs:577`)
  and the side panel marks them (`packages/vimma-core/src/ui/sidepanel.mjs:145`). A temporary
  tab without this spec would be such a tab.
- **One split is one workspace** (m3-workspaces decision 14): a foreign tab is in its workspace,
  so a split of it with a workspace tab is allowed. Splits are made with `ctrl+b v`, `ctrl+b -`,
  `:vsplit` and `:split` (`docs/guide.md`, "Several splits").
- **External links** take their container from `WorkspaceRouter.externalUserContextId`, which
  falls back to Firefox's `URILoadingHelper.guessUserContextId` and filters the agent container
  out of the guess (`workspaces/WorkspaceRouter.sys.mjs:446`, `notAgent`). The guess looks at
  visible tabs (`browser/modules/URILoadingHelper.sys.mjs:911`), so without a filter it could
  pick a temporary container shown on screen.
- **Agents** see only tabs in the agent workspace's container
  (`docs/security/12-agents-mcp.md`, M2), and a tab a user did not open there never takes that
  container (M24).
- **The private workspace** is Firefox's private window shown as a workspace
  ([private-workspace](private-workspace.md)); closing its last tab closes it
  ([close-last-tab](close-last-tab.md), behaviour 11). It is the feature to use when nothing
  must reach disk.
- **The bookmarks mirror** never writes a change made in a private window to `bookmarks.toml`
  (`docs/security/08-config-toml.md`, F7). A temporary tab is in a normal window, so its
  bookmarks are written like any other.
- **Free keys.** `prefix+t` and `prefix+o` have no default
  (`packages/vimma-core/src/config/defaults.mjs`, grep of `prefix+`). No command named `:tmp`
  or `:temporary` exists (`packages/vimma-core/src/keys/cmdline.mjs`).

### Prior art

- **Temporary Containers** (Firefox add-on 1.9.2, last updated 2021-02-08, read from
  `addons.mozilla.org/api/v5/addons/addon/temporary-containers/` on 2026-11-27): "Easily open
  disposable containers that isolate attached data and are deleted after usage", opened from the
  toolbar, by link clicks, per website, or for every new tab in its "Automatic Mode". It asks for
  `<all_urls>`, `cookies`, `tabs`, `webRequestBlocking` and `contextualIdentities`. Its
  behaviour beyond that description was not checked in its source.
- **Firefox Multi-Account Containers** keeps named, lasting containers, which Vimma's workspaces
  already are.

## Design

1. **A temporary container is a real Firefox container that Vimma deletes.** Vimma creates it
   with `ContextualIdentityService.create` and deletes it with `remove`, because those clear the
   container's site data through Firefox's own `clearData` path, the same one a closed workspace
   uses (`docs/security/03-workspace-deletion-and-containers.md`, W1 to W3), and need no upstream
   patch. Rejected: private browsing per tab, because private-workspace option C showed it needs
   a C++ patch and a review of about 220 call sites on every Firefox release.
2. **It is called a temporary container, never private**, because it keeps history, cache on
   disk and session entries that private browsing would not, and calling it private would
   promise a guarantee it does not give, which the private-workspace spec counts as a security
   problem (its option B verdict and decision 11).
3. **It belongs to the workspace it was opened in.** Vimma keeps a map of temporary
   `userContextId` to workspace id, and `openTab` puts a tab of such a container in that
   workspace, not the active one, and not as `foreign`, so that the picker and the side panel
   show it where the user opened it and a split of it with the workspace's tabs is a split of one
   workspace (m3-workspaces decision 14).
4. **A temporary tab stays in its workspace** (behaviour 7), because moving a tab reopens it in
   the target's container (m3-workspaces), which would carry a page opened to stay apart into a
   signed-in container, and moving only some of a container's tabs would leave one container in
   two workspaces.
5. **Vimma records the containers it made**, in `vimma-workspaces.json` next to the workspace
   definitions, so that a container left by a crash or a kill is deleted at the next start. A
   recorded id is deleted only when its identity still has the name Vimma gave it, so that a
   container reused or renamed outside Vimma keeps its data, as W4 asks for workspaces.
6. **Optional and out of the way**, because Vimma lets each user choose how to work: with no
   temporary container open, no marker, notice, setting or Firefox surface changes, and the
   automatic mode is off by default (open question 4).
7. **No temporary containers in the agent workspace or the private workspace** (behaviour 8).
   The agent workspace confines agents by its container (M2), so a second container inside it
   would be a tab agents cannot see in the workspace made for them. The private workspace is
   discarded on close already, so a temporary container would add nothing there.
8. **Links from other apps never take a temporary container** (behaviour 10), because a link from
   outside was not opened by the throwaway session and should land with the user's normal
   sign-ins. `WorkspaceRouter.externalUserContextId` filters temporary containers out of
   Firefox's guess as it filters the agent container (`notAgent`).
9. **Splits.** `:tmp vsplit` / `:tmp split` make a split as `:vsplit` / `:split` do, with the
   new pane's tab in a new temporary container, so that the main use case (a temporary session
   beside a signed-in page) is one command. Closing a pane follows the pane rules of
   [multiple-splits](multiple-splits.md); when it was the container's last tab, the container is
   deleted as for any tab.
10. **Close-last-tab.** A temporary tab is a tab like any other for
    [close-last-tab](close-last-tab.md): when it is the last tab of the window, `[tabs]
close_last` decides, and its container is deleted as the tab closes, so that no setting value
    keeps a throwaway session alive.
11. **Pure core.** `packages/vimma-core/src/workspaces/tempcontainers.mjs` holds the map from
    container to workspace, the refusals (`agent-workspace`, `private-workspace`,
    `move-temporary`), the startup cleanup plan from the recorded ids and the live identities, and
    the marker text, so that each rule is tested in Vitest; the host owns
    `ContextualIdentityService`, tabs and the file.

### Alternatives

- **Split view across workspaces.** A split that shows tabs of several workspaces would also put
  two sign-ins side by side. Not chosen, because it blurs what a workspace is: today a workspace
  is one container, one set of tabs and one layout, and a split belonging to two of them would
  have no clear answer to which workspace is shown, where a new tab goes, what `ctrl+^` returns to
  or what closing a workspace closes. Temporary containers inside one workspace cover the same
  use cases and keep the workspace model as it is. This replaces a separate spec for such splits.
- **The private workspace beside a normal tab.** Not possible, because the private workspace is
  a separate window and Firefox refuses to mix private and normal tabs in one
  (private-workspace, "Split view and PaneView").
- **A scratch workspace** wiped on close (private-workspace option B and decided question 5).
  Not chosen, because a workspace cannot share a split with another workspace (m3-workspaces
  decision 14), so it misses the side-by-side case, and making a workspace for a quick look is
  heavier than a tab.
- **Leaving it to the Temporary Containers add-on.** Not chosen as the answer, because its tabs
  are `foreign` with no Vimma key, marker or cleanup tied to Vimma's workspaces, and it needs
  access to every page. It keeps working as it does today.

## Security and privacy

- **What is discarded, and when.** On the last tab's close: cookies, localStorage,
  sessionStorage, IndexedDB, service workers, HTTP and image cache, and site permissions of that
  container, through `remove`. Until then they are on disk like any container's, and after a
  crash until the next start (decision 5).
- **What is kept.** History and form history (unless open question 1 is answered with C), saved
  logins the user chooses to save, bookmarks the user adds (written to `bookmarks.toml` like any
  other, because a temporary tab is not in a private window and F7 does not apply), downloads and
  their list entries, HSTS entries, and session-restore entries until the container is deleted
  (`clear-origin-attributes-data` then forgets its closed tabs). The guide must say this in its
  first lines about the feature, so that no one takes it for private browsing.
- **Add-ons** see temporary tabs as they see any tab, and the container is listed by
  `contextualIdentities.query`, because it is a public identity. An add-on can remove it; Vimma
  then treats its tabs as `foreign`.
- **Agents and MCP.** Agents never see a temporary tab, because they see only the agent
  container's tabs (M2), and none can be opened in the agent workspace (decision 7). Whether an
  agent tool or `vimma-ctl` gets more is open question 6.
- **Implementation is security-sensitive**, because it creates and deletes containers and their
  data: the implementing pull requests update
  `docs/security/03-workspace-deletion-and-containers.md` with invariants (only Vimma's own
  temporary containers are ever deleted; a workspace's container never is; a deleted container's
  data is gone) and get the separate review.

## Tests

Written first and seen to fail.

- **Vitest** `tempcontainers.test.ts`: a temporary container's tab belongs to the workspace it was
  opened in; the refusals in the agent and private workspaces; moving a temporary tab is refused;
  the startup plan deletes only recorded ids whose identity has Vimma's name, and keeps a renamed
  or reused one; the marker text. `cmdline.test.ts`: `:tmp`, `:temporary`, `:tmp <url>`,
  `:tmp vsplit`, `:tmp split`.
- **Mochitest** `browser_vimma_temporary_containers.js`:
  `tmp_opens_a_tab_in_a_new_container_in_the_current_workspace`;
  `a_cookie_set_in_a_temporary_tab_is_not_seen_by_the_workspace_and_back`;
  `a_popup_from_a_temporary_tab_shares_its_container`;
  `closing_the_last_temporary_tab_removes_the_container_and_its_cookies`;
  `tmp_vsplit_puts_a_temporary_pane_beside_a_workspace_pane`;
  `a_temporary_tab_cannot_move_workspace`; `tmp_is_refused_in_the_agent_workspace`;
  `an_external_link_never_lands_in_a_temporary_container`;
  `a_recorded_container_left_by_a_crash_is_removed_at_startup`;
  `a_renamed_recorded_container_is_kept`;
  `agent_tabs_list_no_temporary_tab`.
- **e2e** `temporary-container`: open one with `:tmp`, split with `:tmp vsplit`, a status-bar and
  tab-line baseline with the marker in a stock theme, and in the Omarchy theme by hand.

## Docs and changelog

- `docs/guide.md`: a "Temporary containers" section under Workspaces that starts with what it is
  and is not (not private browsing; what is kept), then the command, the key if one is chosen, the
  automatic mode, the markers and what closing does. "Add-ons that clash with Vimma" says Vimma
  has temporary containers of its own. "Features at a glance" gains a line.
- `docs/limits.md`: history, HSTS and downloads are shared; data stays on disk until the last tab
  closes or, after a crash, until the next start.
- `docs/security/03-workspace-deletion-and-containers.md`: the invariants above.
- `CHANGELOG.md` comes from the commits.

## Delivery

1. Core module, the container map, `:tmp` and its refusals, deletion on last close and the
   startup cleanup, behind `vimma.feature.temporary_containers` (default `false`), so `main`
   stays releasable.
2. Markers in the status bar, tab line, side panel and picker, with screenshots in both themes.
3. `:tmp vsplit` / `:tmp split`.
4. The automatic mode and the default key, if chosen; the guide; the flag removed.

## Open questions

1. **What kind of isolation?**
   - A. Private browsing per tab: rejected already (private-workspace option C), listed for
     completeness.
   - B. A temporary container that records history like any tab. No upstream patch; the guide
     says plainly that history is kept.
   - C. A temporary container whose tabs get `disableglobalhistory`, so no visit reaches history.
     Needs a hunk in `Tabbrowser-sys-mjs.patch` and a full build (ADR-010), and the attribute
     has to be set before the browser attaches, also for tabs a page opens.
   - Session restore is the same under B and C: the tabs are written until the container is
     deleted (question 7).
   - Recommendation: B, because the use cases are separate sign-ins rather than secrecy, the
     private workspace already covers secrecy, and B needs no upstream patch; C can follow if
     history turns out to matter.
2. **Scope: one tab or a group?**
   - A. One tab: tabs it opens go to the workspace's container. Not possible for pop-ups, which
     must share their opener's origin attributes, so sign-in pop-ups would break.
   - B. A group: tabs and pop-ups a temporary tab's page opens join its container (Firefox's and
     Vimma's opener rule, no new code); `ctrl+t` from it opens a normal workspace tab.
   - C. As B, and `ctrl+t`, `t` and `:tabnew` from a temporary tab also join its container.
   - Recommendation: B, because it is what Firefox does already, sign-in flows work, and a new
     tab the user opens is predictably the workspace's.
3. **Default key.** `:tmp` exists either way.
   - A. `ctrl+b t` (free; `t` for temporary).
   - B. `ctrl+b o` (free).
   - C. No default key; users bind `temporary_tab` in `config.toml`.
   - Recommendation: A, because it is free, easy to remember, and sits with the other tab keys
     under the prefix. The split variants stay unbound.
4. **Automatic mode** (every new tab temporary, like the add-on's "Automatic Mode").
   - A. A setting, `[tabs] new_tab_container = "workspace" | "temporary"`, default
     `"workspace"`.
   - B. A per-workspace setting in `[workspaces]`, so one workspace can be all temporary.
   - C. No automatic mode.
   - Recommendation: A, off by default, because it covers the add-on's main mode with one line
     and keeps the feature out of the way; B can follow if one workspace needs it.
5. **How is it shown?**
   - A. A text marker with a number per container (`tmp1`, `tmp2`) in the tab line and side
     panel, `◇ tmp1` in the status bar after the workspace segment when the current tab is
     temporary, and `2 temporary` in the picker's count, in a theme colour that no workspace
     marker uses.
   - B. Colour only.
   - C. One shared `tmp` marker with no number.
   - Recommendation: A, because text works without colour, the number tells two temporary
     sessions in one split apart, and `◇` echoes the private workspace's `◆` without claiming
     to be it.
6. **Agents, MCP and `vimma-ctl`.**
   - A. Agents cannot open or see temporary tabs; `vimma-ctl state` (the user's full role)
     lists them with `"temporary": true`; no new command.
   - B. As A, and `vimma-ctl open --temporary`.
   - C. An agent tool that opens temporary containers in the agent workspace.
   - Recommendation: A, because the agent workspace's confinement is its container and a second
     one there would weaken what M2 tests, and scripts can see what is temporary without a new
     command to secure.
7. **Last tab closed, and restore.**
   - A. Delete the container as its last tab closes; never restore it; delete leftovers at the
     next start. Undo-close-tab cannot bring its tabs back.
   - B. Delete it a few minutes after its last tab closes, so `ctrl+shift+t` can undo a mistaken
     close.
   - C. Restore its tabs at the next start into a new, empty temporary container (signed out).
   - Recommendation: A, because "temporary" should mean gone when closed, it is the easiest rule
     to explain, and data never waits on a timer; C restores pages that no longer work signed
     out.
