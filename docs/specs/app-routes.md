# Spec: app-routes

Status: draft · Area: `packages/vimma-core/src/routes.mjs`; `src/browser/base/content/vimma/`
(`workspaces/WorkspaceRouter.sys.mjs`, `about/AboutVimma.sys.mjs`, `about/about.mjs`);
`tools/package/vimma-open.sh`, `tools/package/package.mjs`, `tools/package/cask.mjs`, the macOS
bundle manifest; `.github/workflows/macos.yml`; `docs/guide.md`, `docs/security.md`,
`docs/limits.md` · Upstream patches: one new, `src/toolkit/xre/MacApplicationDelegate-mm.patch`
(its ADR-003 register line is in decision 6) · ADR: none. No new dependency.

Issue: [#635](https://github.com/vimma-browser/vimma/issues/635)

Builds on [workspace-routing](workspace-routing.md), which added `[[routes]]` rules and their
`app` key, and on [vimma-mcp](vimma-mcp.md) (decision 42: links from other apps never take the
agent workspace's container), [private-workspace](private-workspace.md) (decision 8c: routing
never enters or leaves the private workspace), [flatpak](flatpak.md) (decision 6: no `vimma-open`
in the Flatpak) and [macos-homebrew](macos-homebrew.md) (the cask). Vimma paths were checked on
`main` at cfa6793 and are under `src/browser/base/content/vimma/` unless they start with
`packages/`, `docs/`, `tests/`, `tools/` or `src/`. Engine paths are relative to `engine/` and were
read in Firefox 159.0, the version `main` builds (`surfer.json`). macOS SDK paths are relative to
`MacOSX26.5.sdk/System/Library/Frameworks/` in the Command Line Tools. Other projects were read at
the commit named where they are cited, on GitHub, on the day the spec was written.

## Summary

A `[[routes]]` rule with `app = "..."` sends the links another application opens to a workspace,
alone or together with a `domain` or `url`. Today that works only on Linux, and only when the
link reaches Vimma through `vimma-open` from a process whose parent chain names the app. This spec
makes the same rules work on macOS, where the sender of the Apple Event that carries the link is
known; makes a terminal count as the app for the commands run in it; and adds an explicit
`vimma-open --from <app>` for the callers whose sender no platform reports. The rules, their
order and their schema stay as they are.

## Problem

Different apps stand for different roles, and their links belong in different containers. For
example, Microsoft sign-in links (`login.microsoftonline.com`) opened from a terminal belong to an
administrator account kept in the `admin` workspace, while the same sign-in links opened from
Microsoft Teams belong to the everyday account in `work`. The rules for that can already be
written:

```toml
[[routes]]
app = "ghostty"
domain = "microsoftonline.com"
workspace = "admin"

[[routes]]
app = "com.microsoft.teams2"
workspace = "work"
```

but today they match nothing on macOS, and little on Linux:

- **macOS.** No app is ever known. A link from another app arrives as an Apple Event, which
  Firefox turns into a command line with `-url` only (Research, "macOS"); `vimma-open` is not
  installed, and LaunchServices would not run it, since a macOS default browser is an app bundle.
- **Linux, a link clicked in Ghostty.** Ghostty's GTK front end opens links through the desktop
  portal's OpenURI, and only falls back to `xdg-open` when that fails (Research, "Linux"). The
  portal starts `vimma-open`, whose walk up the parent chain ends at `xdg-desktop-portal` with no
  app, as it does for every Flatpak app.
- **Linux, a command run in a terminal.** `az login` in Ghostty runs `xdg-open` from a Python
  process named `az`. `vimma-open` names the nearest process that is not an opener or a shell,
  `az`, so `app = "ghostty"` does not match, though the link was opened from Ghostty.
- **Every platform, a caller with no reported sender.** A shell's `open URL` on macOS, a process
  started by systemd, a sandboxed app: there is no way to say on the command line which app the
  link is from.

## Behaviour

1. **Rules are unchanged.** `[[routes]]` keeps its keys (`app`, `domain`, `url`, `workspace`),
   their meaning and its precedence: file order, the first rule that matches wins, every key of a
   rule must match. A config file valid today stays valid (`schema = 2`).
2. **A link carries the names of the app that opened it, nearest first**, up to four lower-case
   names. A rule's `app` matches when it equals any of them. On macOS the names are the sending
   app's bundle identifier and the name of its executable (`com.mitchellh.ghostty`, `ghostty`); on
   Linux they are the process names on the way up from `vimma-open`, past openers and shells (`az`,
   `ghostty`). An `app` value may be up to 64 characters, so that bundle identifiers fit.
3. **macOS: a link from another app names that app** when the Apple Event that carries it was
   sent by a running application, such as a link cmd-clicked in Ghostty or opened by an Electron
   app such as Slack. A link from a command-line tool (`open`, `osascript`) or from Handoff names no
   app.
4. **macOS: a link that starts Vimma names its app too**, as a link that reaches a running Vimma
   does.
5. **`vimma-open --from <app> <url>`** opens `<url>` as a link from `<app>`, on Linux and on macOS
   (where the Homebrew cask installs `vimma-open`). It is the way to name the app for a caller no
   platform identifies, and for a terminal's commands:

   ```sh
   # ~/.zshrc: links that commands in Ghostty open count as Ghostty's
   [ "$TERM_PROGRAM" = ghostty ] && export BROWSER="vimma-open --from ghostty"
   ```

6. **An unknown app matches no `app` rule.** `domain` and `url` rules still apply, then Firefox's
   container guess, then the workspace default, as for any link from another app today.
7. **Where app rules apply** is where workspace-routing's external routing points are: a link
   from another app, and the first tab of a window opened for one (including a cold start). A
   page's own navigation, and the links a page opens, are never routed (workspace-routing,
   decision 3), and an app rule never produces the same-tab hint (decision 3 below).
8. **Never the agent or the private workspace.** A link from another app never opens in the agent
   workspace, whatever its app or rule (vimma-mcp, decision 42), and never in the private
   workspace (private-workspace, decision 8c). `:route` and about:vimma mark an app rule naming the
   agent workspace as never followed.
9. **about:vimma shows the last app.** Its Routing section says which names the most recent link
   from another app carried and which rule it matched, without its URL, so a user can see what to
   write in `app`. A rule that an earlier rule always wins against is marked
   `shadowed by rule N`.

## Research

### macOS: how a link from another app reaches Firefox

- **Firefox registers as a handler** for `http` and `https` in its bundle
  (`browser/app/macbuild/Contents/Info.plist.in:207-218`). An app that opens a link calls
  `NSWorkspace` or LaunchServices, which sends the browser a `kInternetEventClass`/`kAEGetURL`
  Apple Event.
- **AppKit hands the event to the delegate's `application:openURLs:`** (`NSApplication.h:409-412` in
  `AppKit.framework/Headers/`, macOS 10.13 and later). Firefox installs no Apple Event handler
  of its own for it: a search of `toolkit/`, `widget/`, `browser/` and `xpcom/` for `kAEGetURL`,
  `keySenderPIDAttr` and `currentAppleEvent` finds nothing. `MacApplicationDelegate`
  (`toolkit/xre/MacApplicationDelegate.mm:361-364`) forwards to its `openURLs:` (`:389-438`).
- **`openURLs:` builds a command line.** For each URL (skipping `chrome:`, `:396-399`) it appends
  `-url <url>` (`:408-409`), then runs it as `STATE_REMOTE_EXPLICIT` (`:427-432`), synchronously,
  inside the event's dispatch. The command-line handlers run in category order, so Vimma's
  `k-vimma-from` handler runs before `m-browser` and `x-default`
  (`browser/components/components.conf:30`, `:40`). `x-default` takes the `-url` values
  (`browser/components/BrowserContentHandler.sys.mjs:1685-1687`) and, for one URL, calls
  `handURIToExistingBrowser` (`:1736-1752`), which calls `openURI(… OPEN_EXTERNAL …)`
  (`:1299-1320`): the same external routing point as Linux's remote command line.
- **A cold start buffers the URLs.** `InitializeMacApp` spins the event loop once to collect the
  URLs the app was launched to open (`MacApplicationDelegate.mm:147-190`); `openURLs:` stores them
  while `sLaunchStatus` is `CollectingURLs` (`:402-406`), and `SetupMacCommandLine` appends them as
  `-url` to the startup command line (`toolkit/xre/nsCommandLineServiceMac.mm:111-117`), which runs
  later, outside any Apple Event. The command-line handler of workspace-routing is registered by
  the first window, after that command line ran, which is why Linux passes a cold start's app in
  `VIMMA_FROM`.
- **Handoff** (`continueUserActivity`) calls the same `openURLs:` with a URL from another device
  and no Apple Event (`MacApplicationDelegate.mm:371-381`).
- **A second `vimma` process** run from a shell sends its command line to the running one over a
  `CFMessagePort` (`toolkit/components/remote/nsMacRemoteServer.mm:32-69`, `STATE_REMOTE_AUTO`),
  so `vimma -vimma-from <app> <url>` reaches the `k-vimma-from` handler on macOS as it does on
  Linux.

### macOS: what is known about the sender

- **The event's sender.** While an Apple Event handler registered with `NSAppleEventManager` runs,
  `[[NSAppleEventManager sharedAppleEventManager] currentAppleEvent]` is that event
  (`Foundation.framework/Headers/NSAppleEventManager.h:40-41`). Its attributes include
  `keySenderPIDAttr` (`'spid'`, the sender's pid) and `keySenderAuditTokenAttr` (`'tokn'`), both
  read-only, set by the system, not by the sender
  (`CoreServices.framework/Frameworks/AE.framework/Headers/AEDataModel.h:210-211`), and
  `keySenderApplicationSandboxed` (`:216`). `NSRunningApplication`'s class method
  `runningApplicationWithProcessIdentifier:` maps the pid to an app with a `bundleIdentifier` and
  an `executableURL` (`AppKit.framework/Headers/NSRunningApplication.h:95`, `:101`, `:165`); it
  returns nil for a process that is not an app.
- **Prior art: Finicky**, a macOS browser chooser (johnste/finicky at 4a38875). It installs its
  own `kAEGetURL` handler (`apps/finicky/src/main.m:244-247`), reads `keySenderPIDAttr` and maps it
  with `NSRunningApplication` (`:269-270`), and passes the app's name, bundle id and path to its
  rules. Its issue #168 reports that a link opened with `open URL` in a terminal has no opener: the
  sender is `/usr/bin/open`, which is not an app; the workaround in that thread, `open --wait-apps`,
  keeps `open` running while the event is handled.
- **Ghostty** (ghostty-org/ghostty at df1c99c). On macOS a cmd-clicked link is opened in Ghostty's
  own process with `NSWorkspace.shared.open(url)` (`macos/Sources/Ghostty/Ghostty.App.swift:865`,
  `:873` for links it checks first), so the sender is Ghostty, whose bundle identifier is
  `com.mitchellh.ghostty` (`PRODUCT_BUNDLE_IDENTIFIER` in
  `macos/Ghostty.xcodeproj/project.pbxproj`).
  A command run in Ghostty that opens a browser does so itself, usually through `/usr/bin/open`:
  CPython's `webbrowser`, which `az` uses, runs `/usr/bin/open` on macOS
  (`Lib/webbrowser.py:650-690`, python/cpython `main`) unless `BROWSER` is set (`:572-574`). Ghostty
  sets `TERM_PROGRAM=ghostty` for its shells (`src/termio/Exec.zig:755`).
- **Electron apps** (Slack, and other chat and mail clients) open a link with
  `shell.openExternal`, which on macOS calls `NSWorkspace`'s
  `openURL:configuration:completionHandler:` in the app's process (electron/electron at 3e2350d,
  `shell/common/platform_util_mac.mm:113-147`), so the sender is the app.
- **Microsoft Teams** (the current client) is not Electron and its source is not public. Its bundle
  identifier is `com.microsoft.teams2`, and it keeps its data in a container of that name under
  `~/Library/Containers/`, so it runs in the App Sandbox (Microsoft's "new Teams for Mac install
  prerequisites" page). Whether its link opens carry its own pid as the sender was not checked;
  the first sub-PR that ships detection records it (Delivery, sub-PR 3).
- **Not checked:** whether the sender of the event that launches an app (a cold start) is the app
  that asked LaunchServices to open the URL, or LaunchServices itself; and whether
  `currentAppleEvent` is set while AppKit calls `application:openURLs:` (the header promises it
  for handlers registered with the manager, and AppKit's handling of `kAEGetURL` is internal).
  Decision 6 says what Vimma does in either case.

### Linux: what is known about the sender

- **What arrives.** A link from another app reaches a running Vimma as a command line over D-Bus:
  `nsDBusRemoteServer::HandleOpenURL` (`toolkit/components/remote/nsDBusRemoteServer.cpp:35-46`)
  passes the argument list to `nsUnixRemoteServer::HandleCommandLine`
  (`toolkit/components/remote/nsUnixRemoteServer.cpp:59-123`). The method call's sender
  (`HandleMethodCall`'s `aSender`, `nsDBusRemoteServer.cpp:50`) is the short-lived `vimma` client
  process, never the app; asking the bus for its pid (`GetConnectionUnixProcessID`) leads to the
  same parent chain `vimma-open` already walks, later, and racing the client's exit.
- **`xdg-open` callers.** Electron's `shell.openExternal` on Linux runs `xdg-open <url>` as a child
  process (`shell/common/platform_util_linux.cc:361-366`, `:396-405`), as Ghostty's fallback does
  (`src/os/open.zig:34-41`). `vimma-open` then finds the app (workspace-routing, decision 6).
- **Portal callers.** Ghostty's GTK front end opens every `http(s)` link through the OpenURI portal
  first (`src/apprt/gtk/class/application.zig:2672-2690`) and uses `xdg-open` only when that call
  fails (`:2081-2089`); it sends an empty parent window (`src/apprt/gtk/portal/OpenURI.zig:301`).
  The portal knows the caller's app id (flatpak/xdg-desktop-portal at 8bcdc73,
  `desktop-portal/open-uri.c:567`), but `launch_application_with_uri` passes the launched
  browser only `PARENT_WINDOW_ID` and an activation token (`:202-254`). The browser is a child of
  `xdg-desktop-portal`, so `vimma-open` names no app.
- **The activation token.** `XDG_ACTIVATION_TOKEN` names the app being activated, not the one
  that asked (`set_app_id`, "the application id of the client being activated",
  wayland-protocols `staging/xdg-activation/xdg-activation-v1.xml:153-161`, GitHub mirror
  wayland-mirror/wayland-protocols, `main`), and only the compositor can resolve it.
  `DESKTOP_STARTUP_ID` is X11 startup notification, whose content the launcher chooses.
- **Terminals.** A command in a terminal is the terminal's child, so the chain from `vimma-open`
  is `xdg-open`, the command (`az`, `gh`, `nvim`), shells, the terminal. A program inside tmux
  or screen is a child of the multiplexer's server, which is not a child of the terminal.
- **A Flatpak Vimma** gets no app from any of these (flatpak, decision 6).
- **Per-app browsers.** Freedesktop's default applications are per user and per desktop
  (`mimeapps.list` and `xdg-settings set default-web-browser`), never per calling app; an app that
  lets the user pick a browser command does so in its own settings. This was read from the
  Freedesktop "Association between MIME types and applications" specification and the
  `xdg-settings` manual, not from a particular xdg-utils version.

### Alternatives that need no sender detection

- **A browser chooser (Finicky, Choosy, Velja on macOS).** The chooser is the default browser and
  sends each link to a browser by its own rules, including the opener. It would need to start
  Vimma with a workspace, which `vimma` cannot take on its command line, and on macOS it has the
  same sender limits as Vimma's own detection, because it reads the same attribute.
- **`vimma-ctl open`** (`tools/vimma-ctl/src/cli.rs:143-147`) opens a URL through the control
  socket. The socket is off by default (docs/security.md S1), needs the `full` role, and while MCP
  is on every new `full` connection waits for a `y/N` (S13), so a link would ask each time; it has
  no workspace argument either.
- **One browser registration per workspace** (a desktop file, or on macOS an app bundle, per
  workspace). An app's links follow the system default browser, so this would change the
  workspace of every app at once, which is the problem itself.
- **An explicit name on the command line.** `vimma -vimma-from <app> <url>` already exists on both
  platforms (workspace-routing, decision 6), but only `vimma-open` sets the cold start's
  `VIMMA_FROM`, and `vimma-open` takes no name.

## Design

```
macOS app ─NSWorkspace─▶ kAEGetURL ─▶ openURLs: (patch) ─┬─ running: -vimma-from a,b -url U ─┐
                                                         └─ cold start: VIMMA_FROM=a,b        │
Linux app ─xdg-open─▶ vimma-open (walk /proc, or --from) ─▶ vimma -vimma-from a,b U ─(D-Bus)─┤
shell: BROWSER="vimma-open --from ghostty" ───────────────────────────────────────────────────┤
                                                                                              ▼
            k-vimma-from handler / VIMMA_FROM ─▶ WorkspaceRouter.apps ─▶ matchRoute(url, apps)
```

1. **The rules and their order stay.** No new key, no new value, no schema change: `app` is
   compared with the names a link carries, and file order decides between an app rule, a domain
   rule and a rule with both, as workspace-routing decision 2 says, because one ordered list is the
   only precedence a reader can check by reading the file. Rejected: "a rule with an app wins over
   one without", because it makes the effective order differ from the written one, and the same
   result is one line higher in the file. For the example in Problem, the app rules go above any
   `domain = "microsoftonline.com"` rule for typed and other links.
2. **The app hint is a list of names, nearest first.** `-vimma-from` and `VIMMA_FROM` carry up to
   four names separated by commas (`az,ghostty`); a rule matches when its `app` equals any of them.
   A comma cannot occur in a name, so the list needs no quoting, and an older single name is a
   list of one. Each name must be a token, `[a-z0-9][a-z0-9._+-]{0,63}` (64 characters, up from 32,
   so that reverse-DNS bundle identifiers fit); a name that is not one is dropped and the others
   kept, and names after the fourth are dropped. Reason: a terminal's commands should count as the
   terminal's without listing every command, and a macOS app is known by both its bundle
   identifier and its executable name, so the same `app = "ghostty"` works on both platforms.
   Rejected: an array value for `app`, because one more rule is as short and `:route` shows one
   name per rule.
3. **App rules apply only at the external routing points.** The link from another app
   (`externalUserContextId`) and the first tab of a window opened for one (`firstTab`) see the
   names; `routeLinkIn` (the URL bar, `:open`, bookmarks) and the same-tab hint call `match` with
   none, as today, because what the user types and what a page loads have no opener app. A page's
   navigation is never moved (workspace-routing, decision 5): a sign-in that starts in a `work`
   tab and bounces through `login.microsoftonline.com` stays in `work`.
4. **Unknown means no app rule.** With no names, `matchRoute` skips every rule with `app`, and
   the chain goes on as today: a `domain` or `url` rule, Firefox's guess, the workspace default.
   Rejected: a guess from the focused window or the frontmost app, because a background app's link
   (a chat notification while the terminal has focus) would be put in the terminal's workspace
   (Open question 2).
5. **Never the agent or the private workspace.** `externalUserContextId` and `firstTab` keep
   `notAgent` around the rule's container, so an app rule naming the agent workspace is skipped
   from outside, as any rule is (vimma-mcp, decision 42); `unroutable` keeps private windows out
   (private-workspace, decision 8c). about:vimma's Routing section marks such a rule
   `never for links from other apps: the agent workspace`, so that a rule that can never match does
   not look as if it works. Reason: the names are a hint any local process can give (Security and
   privacy), so they may select only what a link with no app could also reach.
6. **macOS: a patch in `openURLs:` reads the sender.** The new patch
   `src/toolkit/xre/MacApplicationDelegate-mm.patch` changes `-[MacApplicationDelegate openURLs:]`:
   - Take `currentAppleEvent`; only if its class is `kInternetEventClass` and its id `kAEGetURL`,
     read `keySenderPIDAttr`; for a pid other than Vimma's own, take
     `runningApplicationWithProcessIdentifier:` and from it the bundle identifier and the last
     path component of `executableURL`, lower-cased, each kept only if it is a token (decision 2).
   - Running Vimma: insert `-vimma-from <names>` before the first `-url`, so the existing
     `k-vimma-from` handler takes it and holds it while `x-default` opens the link in the same
     task. Cold start (`CollectingURLs`): `setenv("VIMMA_FROM", names, 1)`, which
     `WorkspaceRouter` reads once and clears before the first window's first tab, as on Linux.
   - No names (no event, Handoff, a sender that is not an app such as `/usr/bin/open`): nothing is
     added, and the link opens unrouted by app.

   Reason: the sender is known only while the event is being handled, and only native code can
   read it; reusing the flag and the variable keeps the rest of the path the one Linux uses and
   already tests. If the first build shows `currentAppleEvent` is nil inside `openURLs:`, the same
   patch instead installs a `kAEGetURL` handler with `NSAppleEventManager`'s `setEventHandler:`
   in `applicationWillFinishLaunching:`, which reads the sender and calls `openURLs:`, as Finicky
   does; that is the same register line with two hunks. Rejected: JavaScript through
   js-ctypes calling the Objective-C runtime from the command-line handler, because it cannot see
   a cold start's event (the startup command line runs after it), and hand-declared
   `objc_msgSend` signatures break silently between architectures. Rejected: the audit token and
   a code-signature check of the sender, because the result is a hint whichever way it is read
   (Open question 4).

   ADR-003 register line, added by the sub-PR that adds the patch:
   `src/toolkit/xre/MacApplicationDelegate-mm.patch`, at most 2 hunks and 32 lines. Why: a link
   from another app on macOS names the app that sent it; `openURLs:` reads the `kAEGetURL`
   event's sender (`keySenderPIDAttr`, then `NSRunningApplication`) and passes its bundle
   identifier and executable name as `-vimma-from`, or as `VIMMA_FROM` at a cold start, for
   `[[routes]]` `app` rules (app-routes). Only native code sees the event.

7. **Linux: `vimma-open` names every app on the way.** The walk keeps going after the first name
   it takes, skipping openers and shells as now, and collects up to four names, nearest first; it
   still stops at pid 1, `systemd`, `init` and the portal, after 16 steps, and at a name that is not
   a token (which ends the list there). `az` in Ghostty gives `az,ghostty`, Slack gives `slack`.
   Reason: decision 2. The existing tests that assert a single name (a link `nvim` opens in a
   terminal) assert the full list instead, which is a stricter check of the same behaviour.
8. **`vimma-open --from <app> <url>`.** With exactly these three arguments, `<app>` lower-cased
   and a token, and `<url>` not starting with `-`, `vimma-open` skips the walk and runs
   `vimma -vimma-from <app> <url>` with `VIMMA_FROM=<app>`; anything else with `--from` exits 64
   with a message. Reason: the callers no platform identifies (a shell's commands, systemd units,
   the portal) need one way that works on both platforms, and `BROWSER`, which CPython, `gh` and
   `xdg-open` honour, can name it. On macOS the cask installs it: the script ships in
   `Vimma.app/Contents/Resources/vimma-open`, finds `../MacOS/vimma` next to it, and the cask adds
   a `binary` stanza; the `/proc` walk finds nothing there and is skipped. Rejected:
   `--workspace <name>`, because it would let any caller pick any workspace, including one no
   rule names, while `--from` leaves the choice to `config.toml` (Open question 5).
9. **about:vimma shows the last names and shadowed rules.** `WorkspaceRouter` keeps, in memory
   only, the names of the most recent link from another app and the rule it matched; the Routing
   section shows them (`last link from another app: az, ghostty → rule 1 (admin)`) and never its
   URL, and the `:bug` report keeps only the rule count. Core `shadowedBy(routes, i)` returns an
   earlier rule that matches everything rule `i` matches (its `app` absent or equal, and its
   `domain` or `url` absent or covering rule `i`'s), and the section marks rule `i`
   `shadowed by rule N`. Reason: on macOS there is no command to run from an app to learn its name,
   and with app and domain rules mixed, an unreachable rule is the likeliest mistake.

## Security and privacy

- **The names are a hint, never an authority.** Any local process can run
  `vimma -vimma-from com.microsoft.teams2 <url>`, build an app with that bundle identifier, or
  run `vimma-open --from teams`. A name can only select a workspace that a rule in `config.toml`
  names, that exists, and that is neither the agent's nor private (decision 5); it is never used in
  a path, a shell command, a pref name or a log line, only compared with `app` values. So the
  most a forged name does is open a URL in a container the user's rules already route some links
  to.
- **Another workspace's cookies.** A malicious local app could open an OAuth or single sign-on URL
  in `work` by claiming to be Teams, where the user's session may complete it. That is no more
  than it can do without the hint: a link from another app already opens in a workspace with the
  user's logins (a `domain` rule, Firefox's guess or the workspace default), and malware running as
  the user can read the profile directly (docs/security.md §11). The agent workspace, whose pages
  agents read, is excluded at every external routing point (M24).
- **What is recorded.** The last link's names live in memory and appear only in about:vimma;
  nothing is written to disk, and the URL is never shown with them. App names can reveal which
  programs a user runs, so the `:bug` report omits them.
- **The patch's input.** The sender's pid comes from the system, not from the sender
  (`AEDataModel.h:210`). The names it passes are filtered to the token alphabet in native code
  and checked again in `WorkspaceRouter`, so no name can carry a comma, a flag or a newline into
  the command line.
- **docs/security.md.** §2 "Workspace routing": R4 says "up to four names, each a token of at most
  64 characters"; a new R7: on macOS, the names come only from the sender of a `kAEGetURL` event
  that is a running app, and nothing from the URL or the event's parameters. §7 "`vimma-open`": O6
  says 64 characters and the list; a new O8: `--from` takes exactly an app token and one URL that
  is not a flag. §2's reach line gains "local apps on macOS (the Apple Event's sender)".
- **Review.** Sub-PRs 2 and 3 change how links from other apps are routed, so each gets a review
  by a fresh agent before merging, as docs/security.md changes do.

## Tests

Written first and seen to fail.

- **Vitest, `packages/vimma-core/test/routes.test.mjs`:**
  - `an app rule matches any name the link carries, nearest first`
  - `the Ghostty and Teams rules route one sign-in link two ways` (the Problem's config:
    `az,ghostty` to `admin`, `com.microsoft.teams2,msteams` to `work`, no names to the domain
    rule below them)
  - `an app list keeps its tokens, drops the rest, and stops at four`
  - `a bundle identifier of up to 64 characters is an app name; 65 is not`
  - `with no app known, app rules never match and domain rules still do`
  - `shadowedBy finds an earlier rule that matches everything a later one does, and only then`
- **Fuzz, `packages/vimma-core/test/fuzz/routes.fuzz.test.mjs`:** `parseAppList
returns only tokens, at most four`.
- **Shell, `tools/package/test/vimma-open.test.mjs`:** `names every app on the way: az in ghostty`;
  `--from names the app and skips the walk`; `--from refuses a name that is not a token`;
  `--from refuses a URL that is a flag`; `stops the list at a name that is not a token`; the
  existing cases with their full lists.
- **Mochitest, `tests/browser/browser_vimma_workspace_routes.js`:**
  `an_external_link_matches_an_app_rule_by_any_of_its_names`,
  `an_app_list_with_a_bad_name_routes_by_the_good_ones`,
  `the_startup_app_list_routes_the_first_tab`,
  `the_url_bar_and_the_hint_ignore_app_rules`,
  `about_vimma_shows_the_last_apps_without_the_url`,
  `about_vimma_marks_a_shadowed_rule_and_an_agent_rule`.
  In `browser_vimma_agent_outside_opens.js`:
  `an_app_rule_naming_the_agent_workspace_is_not_followed`; in
  `browser_vimma_workspace_routes.js`: `an_app_rule_never_opens_a_link_in_the_private_workspace`.
- **e2e (Linux, Xvfb):** a scenario `app-routes.json` with a new step `external` (runs the
  packaged `vimma-open` with the given arguments against the running instance):
  `vimma-open --from teams <url>` switches to `work`, a plain `vimma-open <url>` from the harness
  goes to the domain rule's workspace, checked with `wait-for-state`.
- **macOS smoke (`macos.yml`, on the hosted Mac, not headless, since a headless start does not run
  the event loop that receives Apple Events, `MacApplicationDelegate.mm:154`):** a helper app
  built in the job from `tools/package/test/link-opener.swift`, bundle identifier
  `dev.vimma.test.link-opener`, opens a URL with Vimma through `NSWorkspace`; with a rule for that
  identifier, `vimma-ctl state` reports its workspace, once with Vimma running and once from a cold
  start. `open -a Vimma <url>` reports the domain rule's workspace (no app).

## Docs and changelog

- **`docs/guide.md`, "Routing: which workspace a link opens in":** "By application" covers both
  platforms: the names a link carries (bundle identifier and executable on macOS; the apps on the
  way on Linux), the Ghostty/Teams example, `vimma-open --from` with the `BROWSER` line, that
  about:vimma shows the last link's names, and what has no app (portal and Flatpak callers, a
  shell's `open`, Handoff, a program inside tmux).
- **`docs/limits.md`:** the routing limits line lists the macOS cases with no app and that a Linux
  link Ghostty opens through the portal has none.
- **`docs/specs/workspace-routing.md`:** a `(Since changed: …; see app-routes.)` note at decision
  6 and at the token's length, since that spec is implemented and frozen.
- **`CHANGELOG.md` `[Unreleased]`** (added at merge): "Routing rules with `app` work on macOS",
  "a terminal's commands count as the terminal for `app` rules", "`vimma-open --from <app>`".

## Delivery

Each sub-PR is mergeable and tested on its own.

1. **`feat(core): app hints are lists of names`.** `routes.mjs`: `parseAppList`, the 64-character
   token, list matching, `shadowedBy`; its Vitest and fuzz cases. `WorkspaceRouter` accepts a list
   in `-vimma-from` and `VIMMA_FROM`. A single name behaves as today, so only the longer `app`
   values are visible: a guide line, no changelog line.
2. **`feat(routing): vimma-open names every app on the way and takes --from`.** Decisions 7 to 9
   on Linux: the walk, `--from`, about:vimma's last names, shadowed and agent rules; the e2e step;
   docs/security.md R4, O6, O8; guide and limits. Reviewed by a fresh agent.
3. **`feat(macos): links from other apps name the app that sent them`.** The patch and its
   ADR-003 line (decision 6), R7, the macOS smoke with the helper app. Its description records
   what the smoke showed for a cold start and whether `currentAppleEvent` was set (Research,
   "Not checked"), and a manual check of a link from Teams in about:vimma. Reviewed by a fresh
   agent.
4. **`feat(macos): vimma-open in the app bundle`.** The script in `Contents/Resources`, the bundle
   manifest, the cask's `binary`, the guide's macOS `BROWSER` recipe. Sets this spec to
   `implemented` and closes the issue.

## Open questions

1. **Terminal commands on macOS.** A command that runs `/usr/bin/open` sends the event from `open`,
   which is not an app. (a) Name no app; the `BROWSER="vimma-open --from ghostty"` line covers
   terminals (decision 8). (b) Also walk up from a sender that is not an app with
   `sysctl(KERN_PROC_PID)` to the first process that is one, which works only while `open` still
   runs when the event is handled, and Finicky #168 suggests it often does not.
   **Recommendation: (a)**, because a walk that works by timing would route the same command
   differently from one run to the next; (b) can follow if the smoke shows `open` alive.
2. **A guess when the app is unknown.** (a) None (decision 4). (b) The focused window's app
   (Hyprland's `activewindow`, X11's `_NET_ACTIVE_WINDOW`, macOS's `frontmostApplication`), as a
   separate, opt-in key. **Recommendation: (a)**, because a link from a background app would be
   attributed to whatever has focus, and the fallback differs per compositor, with none on GNOME.
3. **A rule for every link from another app.** (a) None: a `domain` rule applies to typed and
   external links alike. (b) `app = "*"`, which matches every link from another app, whether its
   app is known or not, as Zen's default route for external links does. **Recommendation: (b)**, as
   a small follow-up after sub-PR 2, because "sign-in links from anywhere else go to `work`" is
   otherwise not expressible without also routing what the user types.
4. **Checking the sender's code signature on macOS.** (a) No: the bundle identifier is a hint like
   a Linux process name. (b) A `team` key compared with the sender's Team ID, read from its audit
   token with the Security framework, so that a look-alike bundle identifier cannot claim Teams.
   **Recommendation: (a)**, because a forged name reaches only workspaces the rules already route
   to (Security and privacy), and (b) adds a key that only macOS can honour.
5. **A workspace chosen by the caller.** (a) None: callers name an app, `config.toml` picks the
   workspace (decision 8). (b) `vimma-open --workspace <name>`, or a `--workspace` for
   `vimma-ctl open` on the `full` role, for scripts. **Recommendation: (a)**, because (b) lets any
   local caller choose any workspace, and a script can name itself with `--from` and get a rule.
