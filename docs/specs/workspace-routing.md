# Spec: workspace-routing

Status: implemented (see Settled) · Milestone: after M3 (m3-workspaces listed "URL-to-workspace
routing rules" as out of scope) · Area: `packages/vimma-core/src/routes.mjs` (new), `config.mjs`,
`toml.mjs`, `cmdline.mjs`, `actions.mjs`; `src/browser/base/content/vimma/workspaces/`
(`WorkspaceRouter.sys.mjs` new, `WorkspaceStore`, `WindowWorkspaces`), `host/route-ops.mjs`
(new), `about/`, `config/ConfigHost.sys.mjs`; `tools/package/vimma-open.sh` (new) and the
packages; three existing patch hunks changed, no new hunk.

Goal: route a page to a workspace by the application that opened it or by its domain name, as
Zen's space routing does. Engine paths are
relative to `engine/` (Firefox 157.0.1). Zen paths are inside Zen's `browser/omni.ja` (the build
installed here, `modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs` and
`modules/zen/ui/ZenSpaceRoutingNavigation.sys.mjs`).

## User stories

- As a user, `[[routes]]` tables in `config.toml` say which workspace a site opens in:
  `domain = "github.com"` with `workspace = "work"` opens GitHub (and `gist.github.com`) in
  `work`'s container when I open it: typed, from `:open`, a bookmark or another app. A link a
  page opens stays in the page's container, with a hint (decision 3).
- As a user, `app = "slack"` sends every link Slack opens to `work`, and `app = "discord"` to
  `personal`, whatever the site.
- As a user, a link opened in the foreground takes me to its workspace; one opened in the
  background stays there and the status bar says `opened in "work"`.
- As a user, a page I am on that navigates (a click, a redirect, a login) to a routed site is
  never yanked out of its tab mid-load: the status bar says where the rule would put it, and
  `:route move` moves it.
- As a user, `:route` shows the rules in force and which one matches the tab I was on;
  `about:vimma` lists them too; `:route add work` adds a rule for the site I am on.

## Research

### Zen: Space Routing (the feature this spec is modelled on)

- **Rules** (`ZenSpaceRoutingManager`, stored in `zen-space-routing.jsonlz4`): `{ reference,
matchType: "contains" | "equal-to" | "regex", openIn }`, edited in a dialog; first match in list
  order wins (`routeUri`); a separate "default route for external links". Matching is on the
  **whole URL string**: `contains` with `github.com` also matches `https://evil.example/?github.com`,
  and a bad regex only logs. A tab-context-menu item adds a `contains <host>` rule.
- **Where:** a `Tabbrowser` patch calls `onBeforeAddTab` (pick the space's container) and
  `onAfterAddTab` (move the tab to the space; `changeWorkspace` when not in the background). It
  skips pinned tabs, tab groups and tabs added before startup finished (session restore).
  `shouldUseRouteContainer` replaces an inherited container only when none was given, for an
  external open, or when it is the active space's own container. `getWindowForExternalUri`
  picks a window already showing the target space.
- **In-place navigation** (`ZenSpaceRoutingNavigation`): a tabs progress listener at
  `STATE_START` of every top-level document load, when a rule names another space, calls
  `browser.stop()` and re-opens the URL with `addTab` in a new tab (a fresh `about:blank` tab is
  moved instead). That cancels POSTs and redirect chains (OAuth/SSO bounce through several
  hosts) and runs inside a progress notification; m3-workspaces records Zen's misrouted delayed
  opens and the freeze when external opens switched spaces (#4197, #9728, #14100, #15517,
  #10666).

### Firefox Multi-Account Containers ("Always open in")

`src/js/background/assignManager.js` (mozilla/multi-account-containers, main): assignments are
keyed by **hostname (+ a non-default port)**, exact, no subdomains; a `webRequest.onBeforeRequest`
listener on `main_frame` requests cancels a load whose tab is in another container and reopens it
in the assigned one (`reloadPageInContainer`), after a confirm page unless "never ask"; the
original tab is closed when it was a new or just-created tab; private tabs are skipped; duplicate
request ids or URLs within 2 s are cancelled to stop double opens (its loop guard).

### Firefox: where a tab gets its container (157)

- `URILoadingHelper.openLinkIn(window, url, where, params)` (`browser/modules/URILoadingHelper.sys.mjs:466+`)
  is the one path for the URL bar (`UrlbarParentController.loadURL` → `openTrustedLinkIn`, no
  `userContextId`), `:open` / `:tabnew` (Vimma's `openUrl`), bookmarks and history
  (`PlacesUIUtils` → `openTrustedLinkIn`; "Open in New Container Tab" passes an explicit one),
  middle/ctrl-click (`ClickHandlerParent.contentAreaClick`, which returns early for `where ==
"current"` and passes the page's container when it is not 0), the context menu's "Open Link in
  New Tab" and Vimma's `F` hints (the page's container, explicit). With `where == "current"` and a
  `userContextId` other than the target browser's, it opens a tab instead (`:574-581`).
- External links: the remote command line (`vimma <url>` while Vimma runs, over D-Bus) runs the
  `command-line-handler` category in sorted order; `nsDefaultCommandLineHandler` ("x-default",
  `browser/components/BrowserContentHandler.sys.mjs:1718-1750`) calls `handURIToExistingBrowser`
  synchronously, which calls `BrowserDOMWindow.openURI(… OPEN_EXTERNAL …)`
  (`browser/modules/BrowserDOMWindow.sys.mjs:256-260`, our existing hunk). An unknown flag is
  logged ("unrecognized command line flag") and its next argument skipped (`:1718-1725`).
- A new window's first tab: `#setupInitialBrowserAndTab` (our hunk 2); its URL is
  `window.arguments[0]` (a string, an `nsISupportsString` or an `nsIArray`, browser-init.js
  `uriToLoadPromise`).
- A page's `target=_blank` / `window.open` gets its browsing context from `openWindowInfo`, whose
  origin attributes are fixed (`BrowserDOMWindow.sys.mjs:380-382`): its container cannot change
  without dropping the opener relationship.

### Linux: who opened the link

An app opens a link with `xdg-open` (a shell script; on a generic desktop it runs the desktop
entry's `Exec` itself), `gio open` / GDesktopAppInfo (child of `gio`, which may exit before the
child looks), or the OpenURI portal (a Flatpak app: `xdg-desktop-portal`, a systemd user
service, starts the handler; the app is not in the process tree). `uwsm app` / `app2unit`
launches go through systemd. The remote command line carries only argv: nothing about the
caller reaches the running Vimma.

## Decisions

1. **Rules in `config.toml`, `[[routes]]`**, validated by core with file:line errors:

   ```toml
   [[routes]]
   domain = "github.com"        # the host and its subdomains
   workspace = "work"
   [[routes]]
   domain = "*.corp.example"    # only subdomains (not corp.example itself)
   workspace = "work"
   [[routes]]
   app = "slack"                # links Slack opens (see 6)
   workspace = "work"
   [[routes]]
   app = "discord"
   domain = "youtube.com"       # both must match
   workspace = "personal"
   [[routes]]
   url = "file:///home/me/work/"  # a URL prefix: the only way to route about:, file: and the like
   workspace = "work"
   ```

   - Keys: `workspace` (required, a workspace name), and at least one of `domain`, `url`, `app`;
     `domain` and `url` exclude each other. Several keys in one rule must all match.
   - **`domain`** matches `http:` and `https:` URLs only, on label boundaries (`github.com` matches
     `api.github.com`, not `notgithub.com`), any port. Case and a trailing dot are ignored;
     Unicode names are compared as punycode (`bücher.example` = `xn--bcher-kva.example`, both ways).
     An IP literal (`10.0.0.5`, `::1` or `[::1]`) matches only itself. `*.` only as the first
     label. A scheme, port, path or `*` elsewhere is an error with a suggestion (as `[sites]`).
   - **`url`** is a prefix of the parsed URL (`URL.href`), any scheme but `javascript:`, ending on
     a boundary: the URL ends there or goes on with `/`, `?` or `#`, unless the prefix itself ends
     in `/` (`https://example.com/app` matches `/app/x`, `/app?q`, not `/apples`). `about:`,
     `file:`, `data:`, `moz-extension:` and the like are never matched by a `domain` rule.
   - **`app`** is a token (`[a-z0-9][a-z0-9._+-]{0,31}`, compared lower-case). (Since changed:
     up to 64 characters, and a link carries up to eight names; see
     [app-routes](app-routes.md), decision 2.)
   - New in schema 2, no schema bump: nothing has been released (release gate), so no older Vimma
     reads these files. A file that declares schema 1 gets "is new in schema 2" as `[panes]` does.
   - `:route add` is the second write to `config.toml` (m5-config-load had one: `:config` creating
     a missing file). It only appends, through `IOUtils.writeUTF8(…, { mode: "append" })`, which
     follows a symlinked (dotfiles) config and never truncates; it first checks that the whole
     new text parses (a file that does not parse, or declares schema 1, or an inline
     `routes = [...]`, is refused with what to do). A missing file is created from the template
     plus the rule.

2. **Precedence: file order, the first match wins.** No implicit "domain beats app" or
   "longest match": a rule that matters more goes higher, as in Zen's list. A rule whose workspace
   does not exist (a typo, a runtime workspace closed) is skipped and flagged in `:route` and
   about:vimma; matching goes on to the next rule. (Since changed: among the `app` rules above the first matching
   rule without `app`, the one naming the nearest program wins, and a rule naming the agent
   workspace is passed over for links from other programs; see [app-routes](app-routes.md),
   decisions 3 and 5.)

3. **Where rules apply: only opens the user or chrome starts** (the routing points):
   - **`openLinkIn`**, through the existing `URILoadingHelper-sys-mjs.patch` hunk, before its
     new-window default: a load with the system triggering principal and no container given (URL
     bar, `:open`, `:tabnew`, bookmarks, history, and `p`/`P` once they exist), any `where`. An
     explicit container ("Open in New Container Tab", an extension) is the user's choice and
     stays.
   - **Never an open a page triggers** (this replaces an earlier option "(b)",
     which routed a page's links opened in a new tab or window in the page's own container). The
     threat: `ClickHandlerChild` accepts synthetic ctrl- and middle-clicks from the page's own
     script once the page has a user gesture, and `ClickHandlerParent` opens them in a
     background tab with the page's principal. With (b), a page in `personal` could open
     `https://github.com/login/oauth/authorize?...` (any URL a rule routes) hidden in `work`'s
     container, with `work`'s cookies: a login-CSRF or token grant the user never sees, and a way
     to probe `work`'s logged-in state. So every open whose triggering principal is web content (a
     link click, middle- or ctrl-click, `target=_blank`, `window.open`, the context menu's "Open
     Link in New Tab", `F` hints) stays in the opener's container, as Firefox does; when it is
     shown, the hint of decision 5 tells the user, and `:route move` moves it. When a rule names another container and `where` is `current`,
     Firefox's own rule makes it a new tab; an untouched new-tab page left behind is closed (as
     Multi-Account Containers closes a just-created tab).
   - **External links**, through the existing `BrowserDOMWindow-sys-mjs.patch` line: a rule
     (domain, url or app) first, then Firefox's guess, then the workspace default. (Since
     changed: none of the three may be the agent workspace's container; see
     [vimma-mcp](vimma-mcp.md), decision 42.)
   - **A new window's first tab**, through hunk 2 of `Tabbrowser-sys-mjs.patch`, which now calls
     `WorkspaceStore.firstTabUserContextId(window)`: the window's single URL argument is routed
     (a cold start from a link, an external link opened as a window, `ctrl+n` to a routed home
     page), else the default as before. `openLinkIn`'s own windows are routed by its hunk.
   - **Not:** same-tab navigation (link clicks, redirects, form posts, history), session restore,
     pinned tabs, Vimma's own moves, `target=_blank` / `window.open` (fixed by the opener, above),
     private windows and popups.

4. **Foreground and background.** The routed tab opens in the window it was opened from, in the
   target workspace's container. A foreground open selects it, and `WindowWorkspaces`' existing
   `TabSelect` handling switches to its workspace. A background open (a bookmark opened in the
   background, a link from another app with `browser.tabs.loadDivertedInBackground`) joins
   that workspace hidden with the existing `opened in "work"` notice (m3 decision 12). Change to
   `WindowWorkspaces.#adopt`: the hide and the notice now wait for a microtask and are skipped
   when the tab got selected meanwhile, so a foreground open is never hidden first and never says
   "opened in" (no flicker: no paint between). **No loops:** a routing point only picks a
   container for a tab being created; nothing it does is itself a routing point, and same-tab
   loads are never routed. A rule naming the workspace already shown changes nothing.

5. **Same-tab navigation to a routed site is never moved** (Zen's lesson). A tabs progress
   listener in `WindowWorkspaces` looks at each top-level location change (not same-document) of
   the selected tab, and at each tab selected: when a rule names another workspace than the
   tab's (a page's navigation, or a link a page opened, decision 3), the notice says
   `github.com goes to "work" (route 1): :route move` once per tab and host. `:route move`
   reopens the tab there with m3's move (history stays behind, as `:wsmove` says).

6. **By application: `vimma-open`.** A POSIX shell launcher (`tools/package/vimma-open.sh`,
   installed as `vimma-open` next to the `vimma` binary; the desktop entry's `Exec` and the
   AppImage's `AppRun` run it) walks parent processes from its parent through `/proc/<pid>/stat`
   and `comm`: it skips openers and wrappers (`xdg-open`, `gio`, `gio-launch-desktop`,
   `gtk-launch`, `kde-open*`, `kioclient*`, `exo-open`, shells, `env`, `nohup`, `setsid`, the
   AppImage runtime) and takes the first other process (`slack`, `discord`, `alacritty`, `nvim`).
   It stops with no app at pid 1, `systemd`, `init`, the portal (`xdg-desktop-portal*`,
   `flatpak-portal`), after 16 steps, or at a name that is not a token (a shell `case`, so a
   name with a newline cannot pass line by line). With an app and exactly one argument it runs
   `vimma -vimma-from <app> <url>` with `VIMMA_FROM=<app>` in the environment; a single argument
   that starts with `-` is refused (exit 64): `%u` must never smuggle a flag such as `-profile`
   into vimma. Otherwise it unsets any inherited `VIMMA_FROM` and runs `vimma "$@"`. The
   AppImage's `AppRun` sends only a single non-flag argument through it; desktop actions'
   flags go straight to vimma. (Since changed: the walk keeps shells and every other program up
   to the terminal or app, up to 32 steps, stops at the compositor and the session, takes
   `--from <app>`, and hands the link off in its own session without waiting; see
   [app-routes](app-routes.md), decisions 6 to 10.)
   - **Running Vimma:** `WorkspaceRouter.init()` (once per process, from `vimma.js`) registers a
     command-line handler under `k-vimma-from` (before x-default). It takes `-vimma-from <app>`
     off the line (`handleFlagWithParam`), keeps it only if it is a token, and holds it until the
     current task ends (`Services.tm.dispatchToMainThread` clears it): x-default's
     `handURIToExistingBrowser` → `openURI` runs synchronously inside the same task, so the
     external routing point sees it, and nothing later can.
   - **Cold start:** the handler is registered by the first window, after the command line ran.
     x-default logs the unknown flag and skips the app name. `WorkspaceRouter.init()` (and the
     first tab's routing, whichever comes first) reads `VIMMA_FROM` and clears it at once,
     unconditionally, so it never reaches child processes; the value is kept for the first
     window's first tab only and dropped at the first `browser-delayed-startup-finished` (a
     private first window or containers off never ask for it). A new window opened for an
     external link takes the startup app, else the command line's `-vimma-from`.
   - **Untrusted hint:** any process can run `vimma -vimma-from slack <url>`. The name is checked
     as a token in the launcher and again in Vimma, never used in a path, a shell or a pref name,
     only compared with `app` keys; it can only select a workspace a rule names, the same as the
     user typing the URL could. Unknown means no `app` rule matches; `domain`/`url` rules still do.
   - **Limits:** a Flatpak or sandboxed app (portal), an app started by systemd (`uwsm app`), or a
     `gio` that exits first gives no app; an interpreter's `comm` is the script name or the
     interpreter (`python3`); a terminal-launched `xdg-open <url>` is the terminal (shells are
     skipped). Recorded in docs/limits.md.

7. **Discoverability.** Action `route_rules` (`workspace.route`, unbound), command `:route`:
   - `:route`: opens `about:vimma?tab=<uuid>#routes` next to the tab, whose Routing section lists
     every rule (number, what it matches, workspace, skipped and why) and which rule matches the
     tab the command was typed in (by its uuid; the URL is not put in the address).
   - `:route add [workspace]`: a `domain` rule for the tab's host without a leading `www.`, to the
     named (or current) workspace, appended to `config.toml` and read at once. Refused for a
     non-http(s) page, a private window, an unknown workspace, a host an earlier rule already
     routes (it says which; "already routed" when it is the same workspace).
   - `:route move`: the tab to the workspace its rule names (m3's move).
   - about:vimma's `:bug` report has only the rule count (domains can name an employer).

8. **The routes at startup.** A cold start's first tab is set up before `ConfigHost` has read
   `config.toml`, so the router caches the resolved rules in `vimma.routes.cache` (JSON) whenever
   they change and starts from it, as the store caches `lastActive`'s container.

## Architecture

```
config.toml [[routes]] ─▶ core parseConfig/routes.mjs ─▶ ConfigHost.apply ─▶ WorkspaceRouter.setRoutes
vimma-open ─▶ vimma -vimma-from app url ─(D-Bus)─▶ k-vimma-from handler ─▶ WorkspaceRouter.app
openLinkIn hunk ──────────┐
BrowserDOMWindow line ────┼─▶ WorkspaceRouter: match(url, app) → workspace → container (store)
Tabbrowser hunk 2 ────────┘
WindowWorkspaces: TabOpen/TabSelect (switch or notice), location changes (hint)
```

- **Core `routes.mjs`:** `validateRoutes` (config problems), `resolveRoutes`, `matchRoute(routes,
{ url, app }, { workspaces })`, `describeRoute`, `isAppToken`, `routeDomainFor(url)`; in
  `config.mjs`, `appendRouteText(text, rule)` (the text to append, checked with `parseConfig`).
- **Host `WorkspaceRouter.sys.mjs`:** rules, the app hint, the routing points (`routeLinkIn`,
  `externalUserContextId`, `firstTabUserContextId`), the command-line handler, the cache pref.
- **Host `route-ops.mjs`:** `:route`, `:route add`, `:route move`.

## Test plan

- Vitest (`routes.test.mjs`, `config.test.mjs`, `toml.test.mjs`): parsing and errors with lines
  (`[[routes]]` located), subdomains and label boundaries, `*.` globs, IDN both ways, ports, IP
  literals, `about:`/`file:` only by `url`, app tokens, precedence by file order, skipped unknown
  workspaces, `appendRouteText`'s refusals.
- Mochitests (`browser_vimma_workspace_routes.js`): the URL bar and `:open` route to another
  workspace (foreground: switch, no "opened in"; the blank tab closed); a background open says
  where and does not switch; `:open` in the target workspace stays in the tab (no loop, no new
  tab); a page's scripted ctrl- and middle-click (through ClickHandler), `target=_blank`,
  `window.open` and a page's `openLinkIn` stay in the page's container, also in no container;
  a redirect inside a tab stays; an explicit container stays;
  same-tab navigation stays and hints, `:route move` moves; an external link through the
  command-line path with `-vimma-from` (app rule) and without (domain rule); an invalid app name
  is ignored even by a rule naming exactly it; a new window's first tab with `VIMMA_FROM`, not
  a later one, and none after a private first window; private windows never routed;
  `:route add` appends and the rule applies; `:route` and about:vimma list the rules and the
  match.
- Shell (`tools/package/test/vimma-open.test.mjs`): fake `/proc` trees: xdg-open → slack,
  sh → xdg-open → nvim, gio, a portal (unknown), systemd (unknown), the AppImage runtime, a bad
  name, a name with a newline, a loop, flags passed through, a single flag refused, an
  inherited `VIMMA_FROM` dropped, the sibling binary.

## Settled (2026-10-10)

- **As designed:** decisions 1-8, no new patch file and no new hunk. Three existing hunks grew:
  `Tabbrowser-sys-mjs.patch` hunk 2 calls `firstTabUserContextId` (one line changed),
  `BrowserDOMWindow-sys-mjs.patch` asks the router before Firefox's guess (+5 lines),
  `URILoadingHelper-sys-mjs.patch` calls `routeLinkIn` before its new-window default (+5
  lines). ADR-003's register lines say so.
- **Found while building (deviations):**
  - `openLinkIn` keeps its own `let userContextId` from the destructured params and passes that,
    not `params.userContextId`, to `addTab` for `tab`; only `current` (its container check) and
    windows read `params`. The first green attempt routed nothing in tabs (10 unexpected in the
    new test): the hunk now assigns the router's answer to both.
  - `WindowWorkspaces.#adopt` on `TabOpen` hides a tab of another workspace in a microtask, and
    only if it was not selected meanwhile (decision 4). Before, a foreground open into another
    workspace was hidden, said `opened in`, then shown again by its selection.
  - `:route` with no argument opens about:vimma's new Routing section (`?tab=<uuid>#routes`)
    rather than drawing a list over the page: a list needs a modal overlay with its own keys,
    and about:vimma already lists config state. It shows the tab's host, never its URL; the `:bug` report has only the rule count.
  - core `locateKeys` now indexes `[[array]]` tables, so `routes[2].url` errors carry their own
    line; `toml.test.mjs`'s array-table path gains the index the parsed value always had.
  - Packaging: `vimma-open` lives in `tools/package/vimma-open.sh`; `package.mjs` installs it
    next to `vimma` in the AppImage (AppRun runs it), the .deb (`/usr/bin/vimma-open`) and the
    AUR package (a third source file with its SHA-256; `release.yml` pushes it and the .deb smoke
    test checks it). The desktop entry's `Exec` is `vimma-open %u`; its actions stay `vimma`.
  - The startup app comes from `VIMMA_FROM` as planned; `-vimma-from` at a cold start is logged
    by x-default as an unrecognized flag and its value skipped, which is harmless.
- **Tests:** Vitest `routes.test.mjs` (30), plus `cmdline`, `actions`, `config`, `toml`; red
  first (the module missing), then green. `vimma-open.test.mjs` (12, fake `/proc`): red (no
  script), green. Mochitest `browser_vimma_workspace_routes.js` (10 tasks, 60 checks): the
  first run of the implementation had 10 unexpected (the `openLinkIn` copy above, a stale
  notice in the test, a private-window helper), then green; whole `tests/browser/` green.
  Mutation check: hiding a foreground-opened tab anyway (dropping `tab.selected` from the
  microtask's guard) fails "a foreground open does not say 'opened in'"; reverted.

## Hardening (PR #88)

- **Decision 3b dropped**: a page's opens are never routed, because of the cookie threat
  described in decision 3. The router routes `openLinkIn` only for the system principal
  with no container given; the referrer stripping that (b) needed went with it. The hint now also
  fires when a tab is selected, so a link a page opened in the background is hinted when looked
  at. Tests: a scripted ctrl-click and middle-click through ClickHandler, `openLinkIn` with a
  page's principal, `target=_blank` (hinted), `window.open`, a page in no container, a
  `location.replace` redirect. Red: 3 of them opened in `rt-work`; green after.
- `VIMMA_FROM` is read and cleared in `init()`, kept for the first window only, and unset by the
  launcher's fallback (red: still set after init; a later window took it).
- Launcher: the token check is a `case` (a newline in `comm` passed `grep -x`); a single flag
  argument is refused; `AppRun` keeps desktop actions' flags away from it.
- `url` rules match on a boundary (`/app` is not `/apples`), Vitest red then green.
- The invalid-app mochitest sets a rule whose `app` is that very string, so it fails if the hint
  were passed unchecked.
- Mutation check: without the system-principal check, the page in no container's scripted
  ctrl-click opens in `rt-work` ("its scripted ctrl-click stays in no container" fails);
  reverted. (With a container, ClickHandler's explicit container already stops it.)

## Out of scope

A rule editor UI; regex rules; routing `target=_blank` / `window.open` opens; routing by the
tab's opener app for later navigations; picking another window that shows the target workspace
(Zen's `getWindowForExternalUri`: Vimma windows have per-window workspaces, and the tab opens in
the window the link reached).
