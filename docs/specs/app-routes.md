# Spec: app-routes

Status: draft · Area: `packages/vimma-core/src/routes.mjs`; `src/browser/base/content/vimma/`
(`workspaces/WorkspaceRouter.sys.mjs`, `workspaces/WindowWorkspaces.sys.mjs`,
`host/route-ops.mjs`, `about/AboutVimma.sys.mjs`, `about/about.mjs`); `tools/package/vimma-open.sh`,
`tools/package/package.mjs`, `tools/package/cask.mjs`, the macOS bundle manifest; `tools/e2e/`;
`.github/workflows/macos.yml`; `docs/guide.md`, `docs/security.md`, `docs/limits.md` · Upstream
patches: one new, `src/toolkit/xre/MacApplicationDelegate-mm.patch` (its ADR-003 register line is
in decision 11) · ADR: none. No new dependency.

Issue: [#635](https://github.com/vimma-browser/vimma/issues/635)

Builds on [workspace-routing](workspace-routing.md), which added `[[routes]]` rules and their
`app` key, and on [vimma-mcp](vimma-mcp.md) (decision 42: links from other apps never take the
agent workspace's container), [private-workspace](private-workspace.md) (decision 8c: routing
never enters or leaves the private workspace), [flatpak](flatpak.md) (decision 6: no `vimma-open`
in the Flatpak) and [macos-homebrew](macos-homebrew.md) (the cask). Vimma paths were checked on
`main` at cfa6793 and are under `src/browser/base/content/vimma/` unless they start with
`packages/`, `docs/`, `tests/`, `tools/` or `src/`. Engine paths are relative to `engine/` and were
read in Firefox 159.0, the version `main` builds (`surfer.json`). macOS SDK paths are relative to
`MacOSX26.5.sdk/` in the Command Line Tools. Other projects were read at the commit or branch named
where they are cited, on GitHub, on the day the spec was written. Process chains marked "observed"
were read with `/bin/ps` on a Mac running macOS 27.0.1, with Ghostty and herdr installed from their
usual distributions.

## Summary

A `[[routes]]` rule with `app = "..."` sends the links another program opens to a workspace, alone
or together with a `domain` or `url`. Today that works only on Linux, only through `vimma-open`, and
only by the nearest process that is not a shell. This spec makes the rules work for the programs
developers run in terminals (a CLI's sign-in link, an agent in a multiplexer pane) on Linux and
macOS, through `BROWSER=vimma-open`, which walks the whole process chain; makes links from macOS
apps name their sender; and keeps the rules, their keys and the schema as they are.

## Problem

Different programs stand for different roles, and their links belong in different containers. A
developer signs in to Azure as an administrator from a terminal and as an everyday user from
Microsoft Teams. `az login`, run in Ghostty or in herdr inside Ghostty, should open its Microsoft
sign-in page in the `admin` workspace, and the same sign-in link from Teams should open in `work`.
Today none of these paths names the right program:

- **macOS.** No program is ever known. A link from another app arrives as an Apple Event that
  Firefox turns into a command line with `-url` only (Research, "macOS"), and `vimma-open` is not
  installed. Without `BROWSER`, CPython opens links through `osascript` or `/usr/bin/open`, neither
  of which is the terminal.
- **Linux, a CLI in a terminal.** `az` is a script that runs Python, so `vimma-open` names the
  nearest process that is not a shell, `python3`, and stops; `app = "ghostty"` never matches.
- **Linux, a link clicked in Ghostty.** Ghostty's GTK front end opens links through the desktop
  portal, so the walk ends at `xdg-desktop-portal` with no program, as for every Flatpak app.
- **Multiplexers.** In tmux, and in herdr once it has been detached, a pane's processes are
  children of a server that is not a child of the terminal.

## Behaviour

1. **Rules keep their syntax.** `[[routes]]` keeps its keys (`app`, `domain`, `url`, `workspace`),
   and `app` stays one string (it does not take a list; Open question 5). A config file valid today
   stays valid (`schema = 2`), and a rule with no `app` keeps its meaning.
2. **A link carries the names of the programs that opened it, nearest first**, up to eight
   lower-case names, shells included: `az login` run in herdr inside Ghostty on macOS gives
   `python,zsh,herdr,zsh,ghostty`. An `app` value may be up to 64 characters, so that macOS bundle
   identifiers fit.
3. **Which rule wins.** Only the rules with `app` above the first matching rule without `app`
   compete: of those that match, the one matching the nearest name wins, the earlier in the file on
   a tie. If none of them matches, the first matching rule without `app` wins, as today. Rules
   below it never apply to that link. `app = "herdr"` therefore beats `app = "ghostty"` for a link
   herdr's pane opened, whichever of the two comes first, as long as both are above any matching
   rule without `app`.
4. **`BROWSER=vimma-open` attributes CLI links.** With `export BROWSER=vimma-open`, every program
   that honours `BROWSER` (CPython's `webbrowser`, `gh`, `xdg-open` on a generic desktop) runs
   `vimma-open <url>`, which walks the process chain on Linux and on macOS, returns at once, and
   never makes a newly started Vimma the terminal's child. The worked example:

   ```toml
   [[routes]]
   app = "herdr"
   domain = "login.microsoftonline.com"
   workspace = "admin"

   [[routes]]
   app = "ghostty"
   domain = "login.microsoftonline.com"
   workspace = "admin"

   [[routes]]
   app = "com.microsoft.teams2"
   workspace = "work"
   ```

   ```sh
   # ~/.zshrc (or ~/.bashrc, config.fish)
   export BROWSER=vimma-open
   ```

   `az login` in Ghostty (`python,zsh,ghostty` on macOS, where framework Python's process is
   named `Python`; `python3,zsh,ghostty` on Linux) and in herdr inside Ghostty
   (`python,zsh,herdr,zsh,ghostty`) open the sign-in page in `admin`; the same link from Teams
   opens in `work`. The `herdr` rule keeps the second case working when the chain ends at herdr's
   server (a detached and reattached session, Behaviour 5), where Ghostty is not known.

5. **Multiplexers.** Inside tmux, zellij or a detached herdr, the chain ends at the multiplexer
   server, so a rule naming `tmux`, `zellij` or `herdr` works, and a rule naming the terminal
   behind it does not. The terminal is known only while the server still runs under it, as herdr's
   does until its session is first detached. Following a client to its terminal is Open
   question 6.
6. **macOS apps name themselves.** A link a running app sends (a cmd-click in Ghostty, Slack and
   other Electron apps) carries the app's bundle identifier and executable name
   (`com.mitchellh.ghostty,ghostty`). A link from a command-line tool that calls `/usr/bin/open` or
   `osascript` itself, without `BROWSER`, carries no names (decision 12), and neither does
   Handoff.
7. **A link that starts Vimma names its program** when it comes through `vimma-open`. One that
   comes from a macOS app as an Apple Event does so only if the event's sender is that app at a cold
   start too, which sub-PR 3 measures; otherwise it names nothing and docs/limits.md says so.
8. **An unknown program matches no `app` rule.** `domain` and `url` rules still apply, then
   Firefox's container guess, then the workspace default, as today.
9. **App rules apply to links from other programs only**: a link from another app and the first
   tab of a window opened for one. A page's own navigation, and the links a page opens, are never
   routed (workspace-routing, decision 3). A tab placed by an app rule is not hinted back to a
   `domain` rule's workspace while it stays on the host it was opened on.
10. **Never the agent or the private workspace.** A link from another program never opens in the
    agent workspace (vimma-mcp, decision 42) or in the private workspace (private-workspace,
    decision 8c). A rule naming the agent workspace is passed over for such a link and matching goes
    on with the next rule; `:route` and about:vimma mark it. When such a rule names one of the
    link's programs (an agent CLI), rules for programs farther up the chain (its terminal) do not
    apply to that link.
11. **`vimma-open --from <app> <url>`** names the program explicitly, for a caller that is not on
    the chain (a systemd unit, a script started elsewhere).
12. **about:vimma shows the last names.** Its Routing section says which names the most recent link
    from another program carried and which rule it matched, without its URL, and marks a rule that
    an earlier rule always wins against as `shadowed by rule N`.

## Research

### macOS: how a link from another app reaches Firefox

- **Firefox registers as a handler** for `http` and `https` in its bundle
  (`browser/app/macbuild/Contents/Info.plist.in:207-218`). An app that opens a link calls
  `NSWorkspace` or LaunchServices, which sends the browser a `kInternetEventClass`/`kAEGetURL`
  Apple Event.
- **AppKit hands the event to the delegate's `application:openURLs:`** (`NSApplication.h:409-412`
  in `System/Library/Frameworks/AppKit.framework/Headers/`, macOS 10.13 and later). Firefox
  installs no Apple Event handler of its own for it: a search of `toolkit/`, `widget/`, `browser/`
  and `xpcom/` for `kAEGetURL`, `keySenderPIDAttr` and `currentAppleEvent` finds nothing.
  `MacApplicationDelegate` (`toolkit/xre/MacApplicationDelegate.mm:361-364`) forwards to its
  `openURLs:` (`:389-438`).
- **`openURLs:` builds a command line.** For each URL (skipping `chrome:`, `:396-399`) it appends
  `-url <url>` (`:408-409`), then runs it as `STATE_REMOTE_EXPLICIT` (`:427-432`), synchronously,
  inside the event's dispatch. The command-line handlers run in category order, so Vimma's
  `k-vimma-from` handler runs before `m-browser` and `x-default`
  (`browser/components/components.conf:30`, `:40`). `x-default` takes the `-url` values
  (`browser/components/BrowserContentHandler.sys.mjs:1685-1687`), treats any other argument that
  is not a flag as a URL (`:1719-1734`) and, for one URL, calls `handURIToExistingBrowser`
  (`:1736-1752`), which calls `openURI(… OPEN_EXTERNAL …)` (`:1299-1320`): the same external
  routing point as Linux's remote command line.
- **A cold start buffers the URLs.** `InitializeMacApp` spins the event loop once to collect the
  URLs the app was launched to open (`MacApplicationDelegate.mm:147-190`; not in headless mode,
  `:154`); `openURLs:` stores them while `sLaunchStatus` is `CollectingURLs` (`:402-406`), and
  `SetupMacCommandLine` appends them as `-url` to the startup command line
  (`toolkit/xre/nsCommandLineServiceMac.mm:111-117`), which runs later, outside any Apple Event.
  Workspace-routing's command-line handler is registered by the first window, after that command
  line ran, which is why a cold start's names travel in `VIMMA_FROM`.
- **Handoff** (`continueUserActivity`) calls the same `openURLs:` with a URL from another device
  and no Apple Event (`MacApplicationDelegate.mm:371-381`).
- **A second `vimma` process** run from a shell sends its command line to the running one over a
  `CFMessagePort` (`toolkit/components/remote/nsMacRemoteServer.mm:32-69`, `STATE_REMOTE_AUTO`).
  When no instance answers, the process goes on to start the browser itself
  (`nsRemoteService::StartClient`, `toolkit/components/remote/nsRemoteService.cpp:243-246`, has no
  mode that only forwards), so run from a terminal it would become the terminal's child.
- **`open(1)`** (macOS 27.0.1 manual page): an opened application inherits the caller's environment;
  `--env VAR` adds a variable for a launched application; `--args` passes the remaining arguments to
  a launched application's `main()`. The manual does not say what `--args` does for an application
  that is already running; LaunchServices does not deliver them to it, which sub-PR 4's smoke
  confirms.

### macOS: what is known about the sender

- **The event's sender.** While an Apple Event handler registered with `NSAppleEventManager` runs,
  `[[NSAppleEventManager sharedAppleEventManager] currentAppleEvent]` is that event
  (`System/Library/Frameworks/Foundation.framework/Headers/NSAppleEventManager.h:40-41`). Its
  read-only attributes give the sender the system reports: `keySenderPIDAttr` (`'spid'`) and
  `keySenderAuditTokenAttr` (`'tokn'`)
  (`System/Library/Frameworks/CoreServices.framework/Frameworks/AE.framework/Headers/AEDataModel.h:210-211`),
  `keySenderApplicationSandboxed` (`:216`), and `keyActualSenderAuditToken`, "the actual (possibly
  over-ridden) audit token for the sender" (`:217`): the reported sender can differ from the
  process that built the event. `NSRunningApplication`'s class method
  `runningApplicationWithProcessIdentifier:` maps a pid to an app with a `bundleIdentifier` and an
  `executableURL` (`System/Library/Frameworks/AppKit.framework/Headers/NSRunningApplication.h:95`,
  `:101`, `:165`). It returns nil for a process that is not an app and for one that has exited.
  A pid can be reused once its process exits; `audit_token_to_pidversion`
  (`usr/include/bsm/libbsm.h:1576`) tells two processes with the same pid apart, but nothing maps
  an audit token to an `NSRunningApplication` directly.
- **Prior art: Finicky**, a macOS browser chooser (johnste/finicky at 4a38875). It installs its
  own `kAEGetURL` handler (`apps/finicky/src/main.m:244-247`), reads `keySenderPIDAttr` and maps it
  with `NSRunningApplication` (`:269-270`). Its issue #168 reports that a link opened with
  `open URL` in a terminal has no opener: the sender is `/usr/bin/open`, which is not an app; the
  workaround in that thread, `open --wait-apps`, keeps `open` running while the event is handled.
- **Ghostty** (ghostty-org/ghostty at df1c99c). A cmd-clicked link is opened in Ghostty's own
  process with `NSWorkspace.shared.open(url)` (`macos/Sources/Ghostty/Ghostty.App.swift:865`, `:873`
  for links it checks first), so the sender is Ghostty, bundle identifier `com.mitchellh.ghostty`
  (`PRODUCT_BUNDLE_IDENTIFIER` in `macos/Ghostty.xcodeproj/project.pbxproj`). Ghostty sets
  `TERM_PROGRAM=ghostty` (`src/termio/Exec.zig:755`) and `GHOSTTY_RESOURCES_DIR`,
  `GHOSTTY_BIN_DIR` (`:639`, `:693`) for its shells.
- **CLIs.** CPython's `webbrowser` (python/cpython) opens a link on macOS through
  `MacOSXOSAScript`, which runs `osascript` with `open location`, in 3.13 and 3.14
  (`Lib/webbrowser.py:496` on `3.13`, `:495` on `3.14`), and through `/usr/bin/open` on `main`
  (`:650-690`). Either way the sender is not an app. Both honour `BROWSER` first (`:572-594` on
  `main`): a value without `%s` becomes `GenericBrowser(value)`, which runs `[value, url]` as one
  executable name and its argument and waits for it to exit (`:178-200`), so
  `BROWSER="vimma-open --from ghostty"` fails (no executable has that name), and a value with `%s`
  is split with `shlex` instead (`:52-58`). `gh` (cli/go-gh at 4e83b33,
  `pkg/browser/browser.go:64-79`) splits `BROWSER` with `shlex`, appends the URL and waits. A
  `BROWSER` value of one command name with no arguments works with both. The Azure CLI's `az` is a
  script that runs Python, so the process that runs the browser is Python.
- **Electron apps** (Slack, and other chat and mail clients) open a link with
  `shell.openExternal`, which on macOS calls `NSWorkspace`'s
  `openURL:configuration:completionHandler:` in the app's process (electron/electron at 3e2350d,
  `shell/common/platform_util_mac.mm:113-147`), so the sender is the app.
- **Microsoft Teams** (the current client) is not Electron and its source is not public. Its bundle
  identifier is `com.microsoft.teams2`, and it keeps its data in a container of that name under
  `~/Library/Containers/`, so it runs in the App Sandbox (Microsoft's "new Teams for Mac install
  prerequisites" page). Whether its link opens carry its own pid as the sender, and the name of its
  executable, were not checked; sub-PR 3 records both.
- **Not checked:** whether the sender of the event that launches an app (a cold start) is the app
  that asked LaunchServices to open the URL, or LaunchServices, the Dock or Finder; whether
  `currentAppleEvent` is set while AppKit calls `application:openURLs:` (the header promises it for
  handlers registered with the manager, and AppKit's handling of `kAEGetURL` is internal); and
  whether `/usr/bin/open` and `osascript`, and their parents, still run when the event is handled.
  Decisions 11 and 12 say what Vimma does in each case.
- **Constraints for a measurement on a Mac (observed, macOS 27.0.1).** LaunchServices refuses to
  launch an app from a temporary directory (`lsregister -dump` lists such a bundle as
  `launch-disabled in-temp-dir`), so a helper app for a measurement must live outside `/tmp`, for
  example in `~/Applications`, and be unregistered afterwards. CPython's `webbrowser.open()` tries
  each registered browser in turn until one succeeds (`Lib/webbrowser.py:76-96` on `main`), which
  on macOS means Chrome, Firefox and then Safari when the default handler fails, so a test calls
  one handler, `webbrowser.get().open(url)`, never `webbrowser.open`, to avoid starting other
  apps.

### Process chains and multiplexers

- **What a chain looks like (observed, macOS).** A shell in a herdr pane in Ghostty:
  `zsh` → `herdr` → `herdr` → `zsh` → `login` → `ghostty`, whose parent is `launchd` (pid 1). With
  `/bin/ps`, `ucomm` gives the accounting name (`zsh`, `herdr`, `ghostty`), at most 16 bytes
  (`MAXCOMLEN`, `usr/include/sys/param.h:95`); `comm` gives a path for some processes
  (`/Applications/Ghostty.app/Contents/MacOS/ghostty`, `/usr/bin/login`) and the login shell's
  `argv[0]` (`-zsh`) for others. An app LaunchServices started has `launchd` as its parent; a
  program started from a shell has the shell. A framework build of Python (Homebrew's, python.org's)
  runs as `Python.app/Contents/MacOS/Python`, so a path inside an `.app` bundle does not mean a GUI
  app.
- **Linux.** `/proc/<pid>/comm` is the executable's name, at most 15 bytes. A terminal started by
  the compositor (Hyprland's `exec`) has the compositor as its parent; one started with `uwsm app`
  or `app2unit` has `systemd --user`; an app opened through the portal has `xdg-desktop-portal`.
- **tmux** (tmux/tmux at a245801) forks its server and calls `daemon(1, 0)`
  (`proc.c:375-388`, from `server.c:190`), so the server's parent is pid 1 and a pane's chain ends
  there. On Linux it names its processes `tmux: server` and `tmux: client` with
  `prctl(PR_SET_NAME)` (`compat/setproctitle.c:29-46`, `proc.c:195`); elsewhere the name stays
  `tmux`. In a pane it sets `TERM_PROGRAM=tmux` (`environ.c:267`), overwriting the terminal's, and
  `TMUX=<socket>,<server pid>,<session>` (`:282-283`); nothing in a pane's environment names the
  client. Asking the server (`tmux display-message -p '#{client_pid}'`) does not start a server
  (`cmd-display-message.c:49` has no `CMD_STARTSERVER`), but it runs any `after-display-message`
  hook the user configured (`CMD_AFTERHOOK`, same line), so a probe could run user commands on every
  link, and its cost was not measured.
- **herdr** (herdrdev/herdr at bc8c289) keeps panes in a background server that outlives the client
  (`README.md:31`). In a pane it sets `TERM_PROGRAM=herdr` (`src/pane.rs:107`) and removes the
  outer terminal's handles (`ITERM_SESSION_ID`, `WEZTERM_PANE`, `KITTY_WINDOW_ID`, `TMUX`,
  `ZELLIJ` and others, `:119-134`), but not `GHOSTTY_RESOURCES_DIR` or `GHOSTTY_BIN_DIR`, which a
  pane inherits from the shell that started the server. In the observed chain the server was still
  the child of the client that started it, so the chain reached Ghostty; after a detach and a new
  attach the server is no longer under any terminal.
- **zellij** also runs panes under a server process; its source was not checked for this spec.
- **`TERM_PROGRAM`** names the terminal a shell runs in: `ghostty` (Ghostty, above), `WezTerm`
  (wezterm/wezterm, `config/src/config.rs:1621`), `tmux` and `herdr` inside those. The values
  `iTerm.app`, `Apple_Terminal` and `vscode` are what iTerm2, Terminal and VS Code are known to set;
  their sources were not checked. It is inherited by everything started from that shell, including
  a GUI app.
- **Inherited terminal variables** (`GHOSTTY_RESOURCES_DIR`) in a multiplexer pane name the terminal
  that started the server, which may not be the one attached now.

### Linux: what reaches Vimma

- **What arrives.** A link from another program reaches a running Vimma as a command line over
  D-Bus: `nsDBusRemoteServer::HandleOpenURL`
  (`toolkit/components/remote/nsDBusRemoteServer.cpp:35-46`) passes the argument list to
  `nsUnixRemoteServer::HandleCommandLine` (`toolkit/components/remote/nsUnixRemoteServer.cpp:59-123`).
  The method call's sender (`HandleMethodCall`'s `aSender`, `nsDBusRemoteServer.cpp:50`) is the
  short-lived `vimma` client process; asking the bus for its pid leads to the chain `vimma-open`
  already walks, later, and racing the client's exit.
- **`xdg-open` callers.** Electron's `shell.openExternal` on Linux runs `xdg-open <url>` as a child
  process (`shell/common/platform_util_linux.cc:361-366`, `:396-405`), as Ghostty's fallback does
  (`src/os/open.zig:34-41`); `vimma-open` then walks from it.
- **Portal callers.** Ghostty's GTK front end opens every `http(s)` link through the OpenURI portal
  first (`src/apprt/gtk/class/application.zig:2672-2690`) and uses `xdg-open` only when that call
  fails (`:2081-2089`); it sends an empty parent window (`src/apprt/gtk/portal/OpenURI.zig:301`).
  The portal knows the caller's app id (flatpak/xdg-desktop-portal at 8bcdc73,
  `desktop-portal/open-uri.c:567`), but `launch_application_with_uri` passes the launched browser
  only `PARENT_WINDOW_ID` and an activation token (`:202-254`).
- **The activation token.** `XDG_ACTIVATION_TOKEN` names the app being activated, not the one that
  asked (`set_app_id`, "the application id of the client being activated", wayland-protocols
  `staging/xdg-activation/xdg-activation-v1.xml:153-161`, GitHub mirror
  wayland-mirror/wayland-protocols, `main`), and only the compositor can resolve it.
  `DESKTOP_STARTUP_ID` is X11 startup notification, whose content the launcher chooses.
- **A Flatpak Vimma** gets no names from any of these (flatpak, decision 6).
- **Per-app browsers.** Freedesktop's default applications are per user and per desktop
  (`mimeapps.list`, `xdg-settings set default-web-browser`), never per calling app; this was read
  from the Freedesktop "Association between MIME types and applications" specification and the
  `xdg-settings` manual, not from a particular xdg-utils version.

### Alternatives that need no sender detection

- **A browser chooser (Finicky, Choosy, Velja on macOS).** The chooser is the default browser and
  sends each link to a browser by its own rules. It would need to start Vimma with a workspace,
  which `vimma` cannot take on its command line, and it has the same sender limits, because it
  reads the same attribute.
- **`vimma-ctl open`** (`tools/vimma-ctl/src/cli.rs:143-147`) opens a URL through the control
  socket. The socket is off by default (docs/security.md S1), needs the `full` role, and while MCP
  is on every new `full` connection waits for a `y/N` (S13), so a link would ask each time.
- **One browser registration per workspace** (a desktop file, or on macOS an app bundle, per
  workspace). An app's links follow the system default browser, so this changes the workspace of
  every app at once, which is the problem itself.

### Firefox and web pages

- **A page can start another app** through an external protocol (`msteams:`, `slack:`), and that
  app may then open a URL in the browser. Firefox asks before handing a page's URL to an app unless
  the user allowed that site and handler before (`toolkit/mozapps/handling/ContentDispatchChooser.sys.mjs:60-129`).
- **The same-tab hint** (`WindowWorkspaces.#hint`,
  `workspaces/WindowWorkspaces.sys.mjs:557-575`) and `:route move` (`host/route-ops.mjs:84`) match
  the tab's URL with no names, `WorkspaceRouter.match(url, null)`.
- **A rule naming the agent workspace** is matched and then dropped at the external routing points:
  `externalUserContextId` and `firstTab` wrap the matched rule's container in `notAgent`, which
  returns null, and fall through to Firefox's guess and the workspace default
  (`workspaces/WorkspaceRouter.sys.mjs`), without trying the rules after it.
- **Today's token** is `[a-z0-9][a-z0-9._+-]{0,31}` (`packages/vimma-core/src/routes.mjs`, `APP`);
  `validateRoutes` refuses an `app` that is not a string ("expected a string"), so `app` takes no
  list.

## Design

```
CLI ─ BROWSER=vimma-open ─▶ vimma-open walks the chain ─┬─ Linux: setsid vimma -vimma-from N U
Linux app ─ xdg-open ─▶ vimma-open (desktop entry) ─────┤
                                                        ├─ macOS running: vimma -vimma-from N U
                                                        └─ macOS cold: open -a --env VIMMA_FROM=N
macOS app ─ kAEGetURL ─▶ openURLs: (patch) ─▶ -vimma-from N, or VIMMA_FROM=N at a cold start
                                   ▼
   k-vimma-from handler / VIMMA_FROM ─▶ WorkspaceRouter ─▶ matchRoute(url, names, skip: agent)
```

### Names and matching

1. **No new key, no new value.** `app` stays a string; the change is what it is compared with.
   Reason: one rule per program keeps `:route`, `:route add` and about:vimma one name per rule, and
   an older Vimma reads every file this one writes. A list value is Open question 5.
2. **The names are a list, nearest first.** `-vimma-from` and `VIMMA_FROM` carry up to eight names
   separated by commas; a comma cannot occur in a name, so the list needs no quoting, and a single
   name is a list of one. A name is a token, `[a-z0-9][a-z0-9._+-]{0,63}`, 64 characters so that
   bundle identifiers fit; core `parseAppList` drops a name that is not one, collapses consecutive
   duplicates and keeps at most eight. Reason: a program run in a terminal should count as the
   program, its shells and the terminal at once, so that a rule can name whichever of them stands
   for the role. Eight fits a typical chain (`python,zsh,herdr,zsh,ghostty`, plus an agent CLI and
   a nested shell) with room; past eight the launcher keeps the seven nearest and the farthest
   (decision 6), because the farthest is the terminal or app, the name rules use most.
3. **Which rule wins: the nearest name among the app rules above the first other match.**
   `matchRoute` finds the first matching rule without `app`, N. The candidates are the matching
   rules with `app` above N (all of them when there is no N); the one matching the nearest name
   wins, the earlier in the file on a tie; with no candidate, N wins. Rules below N are inert for
   that link. With no names, only rules without `app` can match. Reason: the nearer program is
   the more
   specific claim, so `app = "herdr"` should beat `app = "ghostty"` for a link from a herdr pane
   without the user having to order them; and between a rule with `app` and one without, file order
   stays the precedence workspace-routing decision 2 set, so `app = "ghostty"` with
   `domain = "login.microsoftonline.com"` above a plain `domain = "login.microsoftonline.com"` rule
   still wins for links from Ghostty. Shells are harmless: a shell matters only when a rule names
   it, and then only when no nearer name matched. Rejected: plain file order over all names,
   because `ghostty` written above `herdr` would then always win; letting any app rule compete once
   one matches above N, because a `herdr` rule below N would then win or lose depending on an
   unrelated `ghostty` rule above N; and "any rule with `app` beats any rule without", because it
   makes the effective order differ from the written one for every kind of rule.
4. **Unknown means no app rule.** With no names, the chain goes on as today: a `domain` or `url`
   rule, Firefox's guess, the workspace default. Rejected: a guess from the focused window or the
   frontmost app, because a background app's link (a chat notification while the terminal has
   focus) would take the terminal's workspace (Open question 1).
5. **A rule naming the agent workspace is passed over, and matching goes on.** At the external
   routing points `matchRoute` gets `skip: [<agent workspace>]` and treats such a rule as one whose
   workspace does not exist, so a later rule can still apply; about:vimma marks it
   `never for links from other apps: the agent workspace`. Reason: a rule naming a workspace that
   does not exist is already skipped this way (workspace-routing, decision 2), and stopping at a
   rule that can never apply would make later rules depend on a rule the user cannot see working.
   This changes today's behaviour, which falls through to Firefox's guess; the existing test
   `a_route_rule_naming_the_agent_workspace_is_not_followed_from_outside` stays, and a new one
   checks that the next rule applies. Private windows stay unroutable (`unroutable`).
   - **An agent CLI's link never borrows the terminal's rules.** When a rule with `app` that names
     the agent workspace matches one of the link's names, the names after that one are dropped
     before matching, so only rules for that name or a nearer one, and rules without `app`, can
     apply, then Firefox's guess and the workspace default. Reason: with
     `app = "claude"` routed to the agent workspace above `app = "ghostty"` with
     `domain = "login.microsoftonline.com"` routed to `admin`, a prompt-injected agent's sign-in
     URL (`claude,zsh,ghostty`) would otherwise open with `admin`'s cookies, where today it gets
     the guess or the default.

### Collecting the names

6. **`vimma-open` walks the whole chain on Linux and macOS.** From its parent upwards, at most 32
   steps, it reads each process's parent and name while every process on the chain still runs,
   since each waits for its child. On Linux it reads `/proc/<pid>/stat` and `comm` with the
   shell's `read` builtin, so a step starts no process. On macOS it takes one listing,
   `/bin/ps -U "$(id -u)" -o pid=,ppid=,ucomm=`, and walks it in the shell; `-U` selects by real
   user, so the setuid `login` between Ghostty and the shell stays in it (observed), and `-A` is
   left out because on macOS it widens the listing to every user's processes. Each name is
   lower-cased, and the walk:
   - skips openers and wrappers that are never the program meant (`xdg-open`, `gio`,
     `gio-launch-desktop`, `gtk-launch`, `kde-open*`, `kioclient*`, `exo-open`, `gnome-open`,
     `wslview`, `sensible-browser`, `x-www-browser`, `open`, `osascript`, `vimma`, `vimma-open`,
     `env`, `nohup`, `setsid`, `timeout`, `login`, and the AppImage runtime);
   - keeps shells (`zsh`, `bash`, `fish`, `nu`, `sh`) and every other name, collapsing consecutive
     duplicates, and maps Linux's `tmux: server` and `tmux: client` to `tmux`;
   - ends at a multiplexer server (`tmux`, `zellij`, `herdr`) whose parent is pid 1 or a process
     of the stop list below, after naming it, because a daemonised server is no longer under the
     terminal; on a systemd desktop its parent is usually `systemd --user`, which systemd makes a
     child subreaper (not checked against a systemd version here);
   - ends without naming it at pid 1 (`launchd`, `systemd`, `init`), `systemd --user`, the portal
     (`xdg-desktop-por*`, `flatpak-portal`), and a compositor or session process (`hyprland`,
     `sway`, `river`, `niri`, `kwin_wayland`, `kwin_x11`, `gnome-shell`, `plasmashell`,
     `gnome-session*`, `xfce4-session`, `uwsm`, `sddm`, `gdm*`, `lightdm`, `xorg`, `xwayland`);
   - ends the list at a name that is not a token, after the names before it.

   When the walk ends at the 32-step limit or at a name that is not a token, the farthest name kept
   (decision 2) is the last process reached, not a terminal. Otherwise the walk stops at the
   terminal or app that a launcher, LaunchServices or the compositor started, and names it. Reason: these are the processes whose name says which program the user
   was in; the stop list keeps the compositor and session out, so that a rule such as
   `app = "hyprland"` cannot match every link. Rejected: stopping at the first process inside an
   `.app` bundle on macOS, because framework Python runs as `Python.app/Contents/MacOS/Python` and
   the walk would stop before the terminal.

7. **A multiplexer server ends the chain.** `vimma-open` does not look for the server's client.
   Reason: a client shows one session of possibly several, so a session's link could be credited
   to a terminal showing another; a second server (`tmux -L other`), another user's process of the
   same name, and an attach or detach during the walk would each name the wrong terminal or none.
   Rejected: asking the server (`tmux display-message -p '#{client_pid}'`), because it runs the
   user's `after-display-message` hooks on every link and its cost was not measured; and the
   inherited `GHOSTTY_RESOURCES_DIR`, because it names the terminal that started the server, not
   the one attached. An opt-in client lookup is Open question 6.
8. **`TERM_PROGRAM` is the farthest name.** When `TERM_PROGRAM`, lower-cased, is a token not
   already in the list, it is added last (within the cap). Reason: it names the terminal for a
   chain that does not reach one (VS Code's integrated terminal, a chain cut by `setsid`), and as
   the farthest name it never outranks a program the walk found.
9. **`vimma-open` hands the link off and returns at once.** CPython and `gh` wait for the browser
   command to exit (Research, "CLIs"), and a Vimma started as the terminal's child would block them
   and die with the terminal.
   - Linux: `setsid -f <vimma> -vimma-from <names> <url>` with `VIMMA_FROM=<names>`, falling back
     to `nohup … &` without util-linux's `setsid`, so a cold start runs in its own session, not
     under the terminal.
   - macOS, Vimma running (`pgrep -U <uid> -x vimma`): the bundle's `Contents/MacOS/vimma` with
     `-vimma-from <names> <url>`, run with `nohup … &`, which forwards over the remote server and
     exits. `pgrep` also matches a development build or a Vimma running another profile; the
     forward then finds no server for the default profile and starts Vimma itself, detached from
     the caller but still under the terminal's session.
   - macOS, not running: `open -a <Vimma.app> --env VIMMA_FROM=<names> --args <url>`, so
     LaunchServices starts Vimma, not the terminal, and the URL arrives as an argument, with no
     Apple Event for decision 11's patch to read. If Vimma starts between the check and the call,
     `--args` is dropped and the link is lost; if it quits between them, the forwarding process
     starts Vimma under the terminal. Both windows are a few milliseconds, and the smoke measures
     the first.

   Reason: one non-blocking path per platform that carries the names, with no Apple Event sent by
   `vimma-open` itself, so no Automation (TCC) permission is needed. Rejected: sending the
   `kAEGetURL` event with an extra parameter from `osascript`, because macOS may ask the user to let
   the terminal control Vimma, which was not checked.

10. **`--from <app>` names the program explicitly.** `vimma-open --from <app> <url>` skips the walk;
    `<app>` must be a token and `<url>` must not start with `-`, or it exits 64. Reason: a systemd
    unit or a script started outside any terminal has no useful chain. It is not needed for
    `BROWSER`, which must be one command name (Research, "CLIs"). Rejected: `--workspace <name>`,
    because any caller could then pick any workspace, while `--from` leaves the choice to
    `config.toml` (Open question 4).
11. **macOS: a patch in `openURLs:` names the sending app.** The new patch
    `src/toolkit/xre/MacApplicationDelegate-mm.patch` changes `-[MacApplicationDelegate openURLs:]`:
    - Take `currentAppleEvent`; only if its class is `kInternetEventClass` and its id `kAEGetURL`,
      read `keySenderPIDAttr`; for a pid other than Vimma's own, take
      `runningApplicationWithProcessIdentifier:`, and from it the bundle identifier and the name of
      its executable, lower-cased, each kept only if it is a token. When
      `keySenderApplicationSandboxed` is true, only the bundle identifier is kept, because a
      sandboxed app's executable name is whatever its developer chose, while an App Store app's
      bundle identifier is registered to one developer team; a sandboxed app distributed outside
      the store can still use any bundle identifier (Open question 3). A sender that is not an
      app or has exited gives no names.
    - Running Vimma: insert `-vimma-from <names>` before the first `-url`, so the existing
      `k-vimma-from` handler takes it while `x-default` opens the link in the same task.
    - Cold start (`CollectingURLs`): `setenv("VIMMA_FROM", names, 1)` when there are names, and
      `unsetenv("VIMMA_FROM")` when there are none, so a `VIMMA_FROM` inherited from the caller's
      environment (`open` passes it on, and so does `launchctl setenv`) never names a link that
      arrived as an Apple Event. If sub-PR 3's smoke shows that the sender at a cold start is
      LaunchServices, the Dock or Finder rather than the app, the patch only unsets it, and
      docs/limits.md says that such a link names no program.

    Reason: the sender is known only while the event is handled, and only native code can read it;
    reusing the flag and the variable keeps the rest of the path the one Linux uses. A reused pid
    could name the wrong app if the sender exited and another app took its pid before the event was
    handled; the names are a hint (Security and privacy), so this is accepted, and an audit-token
    check is Open question 3. If `currentAppleEvent` turns out to be nil inside `openURLs:`, the
    patch instead installs its own `kAEGetURL` handler in `applicationWillFinishLaunching:`, as
    Finicky does, which reads the sender and calls `openURLs:`; that needs more lines than the
    budget below and a new register line in the same sub-PR. Rejected: js-ctypes calls into the
    Objective-C runtime from the command-line handler, because they cannot see a cold start's event
    and hand-declared `objc_msgSend` signatures break silently between architectures.

    ADR-003 register line, added by sub-PR 3: `src/toolkit/xre/MacApplicationDelegate-mm.patch`,
    at most 2 hunks and 32 lines. Why: a link from another app on macOS names the app that sent
    it; `openURLs:` reads the `kAEGetURL` event's sender (`keySenderPIDAttr`, then
    `NSRunningApplication`) and passes its bundle identifier and executable name as `-vimma-from`,
    or as `VIMMA_FROM` at a cold start (unsetting an inherited one), for `[[routes]]` `app` rules
    (app-routes). Only native code sees the event.

12. **A non-app sender names nothing; a walk from it is a later step.** When the sender is
    `/usr/bin/open` or `osascript` (a CLI run without `BROWSER`), Vimma names nothing, and
    `BROWSER=vimma-open` is the supported path for CLIs, which covers `az login`. Reason: whether
    those processes and their parents still run when the event is handled was not measured, and a
    walk that works by timing would route the same command differently from one run to the next.
    Not in this spec: a best-effort walk in the patch from the sender's pid up its parents, with
    `vimma-open`'s rules, while they still run. It becomes its own issue and sub-PR, with its own
    register line, if a measurement shows they do: a window-less helper app in `~/Applications`,
    registered for a throwaway URL scheme and unregistered afterwards (Research, "Constraints for a
    measurement on a Mac"), logging for `open`, `osascript` and a cold start whether the sender and
    its parents exist when the event is handled.

### Where names are used

13. **Names reach only the external routing points.** `externalUserContextId` and `firstTab` match
    with them; `routeLinkIn` (the URL bar, `:open`, bookmarks) matches with none, as today, because
    what the user types has no opener program. A page's navigation is never moved
    (workspace-routing, decision 5).
14. **A tab placed by an app rule is not hinted back.** When an app rule places a tab,
    `WorkspaceRouter` keeps that tab's names and host in a `WeakMap` (the names of the routed open
    are held until `TabOpen` adopts the tab `openURI` creates, which happens in the same task). The
    hint, `:route move` and about:vimma's match for the tab then call `match(url, names)` while the
    tab is on that host, and `match(url, null)` once it has navigated to another host. Reason:
    without the names, the `domain` rule below the Ghostty rule would hint at once that the sign-in
    page belongs in `work`, and `:route move` would move it there; after the tab leaves the host,
    it is the page's own navigation, which the hint describes as today. The record goes with the
    tab. A window's first tab is created by `#setupInitialBrowserAndTab`
    (`browser/components/tabbrowser/Tabbrowser.sys.mjs:689`), which fires no `TabOpen` (only the
    paths through `#fireTabOpen` do, `:4050`, `:5213`, `:5308`), so `firstTab` records the names
    against the window's first tab itself once `gBrowser.selectedTab` exists; that covers a cold
    start through `vimma-open` or from a macOS app, and a link opened as a new window.
15. **about:vimma shows the last names and shadowed rules.** `WorkspaceRouter` keeps, in memory
    only, the names of the most recent link from another program and the rule it matched; the
    Routing section shows them (for example
    `last link from another app: python, zsh, herdr, zsh, ghostty → rule 1 (admin)`), never its
    URL, and the `:bug` report keeps only the rule count. Core
    `shadowedBy(routes, i, { skip })` returns an earlier rule `j` that wins over rule `i` at every
    routing point where `i` applies: `j` has no `app` or the same `app` as `i`, `j`'s `domain` or
    `url` is absent or covers `i`'s, and `j` is not skipped (a missing workspace, or the agent
    workspace, which applies only to typed opens); a rule with `app` below a covering rule without
    one is inert (decision 3). A rule with `app` never shadows one without, since the latter also
    applies to typed opens. The section marks rule `i` `shadowed by rule N`.
    Reason: with app and domain rules mixed, an unreachable rule is the likeliest mistake.

## Security and privacy

- **The names are a hint, never an authority.** Any local process can run
  `vimma -vimma-from com.microsoft.teams2 <url>` or `vimma-open --from ghostty <url>`, run a binary
  named `ghostty` so that the walk names it, or ship an app whose executable is named `msteams`.
  A name can only select a workspace that a rule in `config.toml` names, that exists, and that is
  neither the agent's nor private (decision 5); it is never used in a path, a shell command, a pref
  name or a log line, only compared with `app` values.
- **Another workspace's cookies.** A local program that claims to be Teams can open an OAuth or
  single sign-on URL in `work`, where the user's session may complete it. That is no more than it
  can do without the hint, since a link from another program already opens in a workspace with the
  user's logins (a `domain` rule, Firefox's guess or the workspace default), and malware running as
  the user can read the profile directly (docs/security.md §11).
- **Residual risks.** (1) A sandboxed or App Store app can name its executable after another
  program; on macOS only its bundle identifier is used (decision 11), a sandboxed app distributed
  outside the store can still choose any bundle identifier, and on Linux nothing tells a look-alike
  name apart. (2) A web page can start another app through an external protocol, after Firefox's
  prompt or a remembered "always allow", and that app's next link then carries its name. (3) Every
  program run in a terminal carries the terminal's names, an AI agent's CLI included, so a
  prompt-injected agent's link matches the terminal's rules unless a rule names the agent's CLI
  first: a rule naming the agent workspace cuts the names there (decision 5), and the guide
  recommends routing agent CLIs (`claude`, `codex`) by name to a workspace with no privileged
  sign-ins. For a workspace that holds privileged sign-ins, the guide recommends pairing `app` with
  `domain`, as the worked example does, so that a forged name opens only the sign-in host there.
  Open question 3 weighs a Team ID check.
- **What is recorded.** The last link's names and each app-placed tab's names live in memory only
  and appear only in about:vimma; nothing is written to disk, the URL is never shown with them, and
  the `:bug` report omits them, because they can reveal which programs a user runs.
- **The patch's input.** The pid is the sender the system reports (`AEDataModel.h:210`), which may
  be an overridden sender (`:217`); the names are filtered to the token alphabet in native code and
  checked again by `parseAppList`, so no name can carry a comma, a flag or a newline into the
  command line.
- **docs/security.md.** §2 "Workspace routing": R4 becomes "the names (`-vimma-from`, `VIMMA_FROM`)
  are at most eight tokens of at most 64 characters each, and only select a workspace a rule
  names"; new R7: "a link that arrives as an Apple Event is named only by its sender, when that is
  a running app; an inherited `VIMMA_FROM` never names it; any launch whose URL is an argument
  trusts `VIMMA_FROM`, since Vimma cannot tell `vimma-open` from another launcher, and a value set
  with `launchctl setenv` reaches every such launch until logout"; new R8: "a rule naming the agent
  workspace never applies to a link from another program, and when it matches one of the link's
  names, no rule for a farther name applies". §2's reach line gains "local
  programs on macOS (the Apple Event's sender)". §7 "`vimma-open`": O6 says the list and 64
  characters; new O8: "`--from` takes exactly an app token and one URL that is not a flag"; new
  O9: "`vimma-open` never runs a command of the multiplexer it inspects".
- **Review.** Sub-PRs 1 to 4 each change the untrusted hint's parser, its collection or the
  routing of links from other programs, so each updates docs/security.md and gets a review by a
  fresh agent before merging.

## Tests

Written first and seen to fail.

- **Vitest, `packages/vimma-core/test/routes.test.mjs`:**
  - `az login in Ghostty and in herdr in Ghostty goes to admin; Teams goes to work`: the worked
    example's rules with a `domain = "login.microsoftonline.com"` rule to `work` below them;
    `python3,zsh,ghostty`, `python3,zsh,herdr,zsh,ghostty` and `python3,zsh,herdr` give `admin`;
    `com.microsoft.teams2,msteams` gives `work` by the Teams rule; no names give the domain
    rule's `work`.
  - `the nearest name wins among app rules: az,herdr,ghostty picks herdr whatever the file order`
  - `slack,ghostty picks the slack rule over the ghostty rule`
  - `a rule without app earlier in the file beats later app rules; a later one does not`
  - `an app rule below the first matching rule without app never applies`: (1) `app = "ghostty"`
    with the sign-in domain → `admin`, (2) the sign-in domain → `work`, (3) `app = "herdr"` →
    `personal`; `python3,zsh,herdr,zsh,ghostty` gives `admin`, and with rule 1 deleted, `work`
  - `an agent workspace rule cuts the names: claude,zsh,ghostty never reaches the ghostty rule`
  - `a shell in the chain matches only a rule that names it, and only when no nearer name matched`
  - `parseAppList collapses consecutive duplicates: python3,zsh,herdr,herdr,zsh,ghostty`
  - `parseAppList keeps at most eight names, drops non-tokens, keeps the rest`
  - `an app name is a token of 1 to 64 characters`: replaces the `"a".repeat(33)` case of
    `an app name is a simple token` (`routes.test.mjs:300`) with `"a".repeat(64)` accepted and
    `"a".repeat(65)` refused, so the bound is tested on both sides rather than loosened
  - `a skipped workspace's rule is passed over and the next rule applies`
  - `with no app known, app rules never match and domain rules still do`
  - `shadowedBy: a covering earlier rule shadows, an app rule never shadows one without app`
  - `shadowedBy: a skipped rule shadows nothing`
- **Fuzz, `packages/vimma-core/test/fuzz/routes.fuzz.test.mjs`:** `parseAppList returns only tokens,
at most eight, never two equal neighbours`.
- **Shell, `tools/package/test/vimma-open.test.mjs`** (a fake `/proc` on Linux and a fake `ps` on
  macOS, as `VIMMA_OPEN_PROC` does today):
  - `BROWSER=vimma-open through CPython's webbrowser names the chain`: a process chain standing in
    for Ghostty and herdr (`ghostty` → `zsh` → `herdr` → `zsh`, as stub executables) runs
    `python3 -I -c 'import webbrowser; webbrowser.get().open(URL)'` with `BROWSER=vimma-open`
    (one handler, never `webbrowser.open`, which would try other browsers); the stub `vimma`
    records `-vimma-from python3,zsh,herdr,zsh,ghostty` and the URL, and the call returns true
    before the stub `vimma` exits.
  - `a gh-style caller appends the URL to BROWSER and gets the same names`
  - `keeps shells and collapses duplicates`; `stops at the compositor without naming it`;
    `stops at launchd and names the app below it`; `skips login, open and osascript`
  - `a daemonised tmux server ends the list at tmux, whatever its clients`;
    `a server under systemd --user ends the list too`; `maps tmux: server to tmux`;
    `never runs tmux or herdr`; `walks one ps listing of the user's own processes` (macOS)
  - `adds TERM_PROGRAM last when the walk did not find it`
  - `keeps the seven nearest names and the farthest past eight`
  - `--from names the app and skips the walk`; `--from refuses a name that is not a token`;
    `--from refuses a URL that is a flag`
  - `returns before a cold-started vimma exits` (Linux `setsid`, macOS `open` stub)
  - the existing cases with their full lists.
- **Mochitest, `tests/browser/browser_vimma_workspace_routes.js`:**
  `an_external_link_matches_by_the_nearest_name`, `an_app_list_with_a_bad_name_routes_by_the_rest`,
  `the_startup_name_list_routes_the_first_tab`, `the_url_bar_ignores_app_rules`,
  `an_app_routed_tab_is_not_hinted_back_by_a_domain_rule`,
  `route_move_keeps_an_app_routed_tab_until_it_leaves_the_host`,
  `about_vimma_shows_the_last_names_without_the_url`,
  `about_vimma_marks_a_shadowed_rule_and_an_agent_rule`,
  `an_app_rule_never_opens_a_link_in_the_private_workspace`. In
  `browser_vimma_agent_outside_opens.js`: `a_rule_after_one_naming_the_agent_workspace_applies`,
  `an_agent_cli_link_skips_farther_app_rules_after_an_agent_rule`. Also
  `a_cold_start_app_routed_first_tab_is_not_hinted_back`.
- **e2e (Linux, Xvfb):** a scenario `app-routes.json` with a new step `external`, which runs the
  packaged `vimma-open` with the given arguments. The harness runs the browser and the step under
  one `dbus-run-session`, so the D-Bus remote has a session bus, and the step sets `VIMMA_BIN` to a
  wrapper that adds `-profile <harness profile>`, so the forwarded command line reaches the
  instance under test: `vimma-open --from teams <url>` switches to `work`; `vimma-open <url>` from
  the harness goes to the domain rule's workspace, checked with `wait-for-state`.
- **macOS smoke (`macos.yml`, on the hosted Mac, not headless, since a headless start does not run
  the event loop that receives Apple Events):** a helper app built in the job from
  `tools/package/test/link-opener.swift` into `~/Applications` (LaunchServices launches nothing from
  a temporary directory) and unregistered at the end, bundle identifier
  `dev.vimma.test.link-opener`, opens a
  URL with Vimma through `NSWorkspace`; with a rule for that identifier, `vimma-ctl state` reports
  its workspace, with Vimma running and from a cold start (the cold-start result decides decision
  11's last case). `VIMMA_FROM=x open -a Vimma <url>` reports the workspace of the rule without
  `app`, since an inherited value names nothing. `vimma-open` with a stub chain, running and cold,
  reports the app rule's workspace and returns before Vimma has started.

## Docs and changelog

- **`docs/guide.md`, "Routing: which workspace a link opens in":** "By application" covers both
  platforms: the names a link carries and the nearest-first rule; the worked example (the three
  rules and `export BROWSER=vimma-open`, with the note that the `herdr` rule keeps a detached
  session working); multiplexers; the advice to pair `app` with `domain` for sign-in workspaces and
  to route agent CLIs (`claude`, `codex`) by name to a workspace with no privileged sign-ins; that about:vimma shows the last link's names; `--from`; and what has no
  names (portal and Flatpak callers, a CLI calling `open` or `osascript` without `BROWSER`,
  Handoff, a detached multiplexer with several clients).
- **`docs/limits.md`:** the routing limits line lists the cases with no names.
- **`docs/specs/workspace-routing.md`:** `(Since changed: …; see app-routes.)` notes at decisions 2
  (the nearest name among app rules), 6 (the walk keeps shells and goes past the first program) and
  at the token's length, since that spec is implemented and frozen.
- **`CHANGELOG.md` `[Unreleased]`** (added at merge), one line per sub-PR: "Routing rules with
  `app` compare every program on the way, nearest first, and accept names of up to 64
  characters"; "`BROWSER=vimma-open` routes links from command-line tools by the terminal and
  multiplexer they run in"; "Links from macOS apps name the app for `app` rules"; "`vimma-open` on
  macOS".

## Delivery

Each sub-PR is mergeable and tested on its own, updates docs/security.md for what it changes, and
gets a review by a fresh agent before merging.

1. **`feat(routing): app rules match every name a link carries, nearest first`.** Core
   `parseAppList`, the 64-character token, nearest-first matching, `skip`, `shadowedBy`, with
   Vitest and fuzz cases; `WorkspaceRouter` accepts lists in `-vimma-from` and `VIMMA_FROM` and
   passes over agent-workspace rules (decision 5); R4 and R8; guide lines; a changelog line, since
   longer names and the new precedence are visible.
2. **`feat(routing): vimma-open walks the whole chain and hands off without blocking`.** Linux:
   decisions 6 to 10, per-tab names and the hint (decision 14), about:vimma (decision 15), the e2e
   step, the shell tests including CPython's `webbrowser`; O6, O8, O9; guide and limits.
3. **`feat(macos): links from other apps name the app that sent them`.** The patch and its ADR-003
   line (decision 11), R7, the macOS smoke with the helper app. Its description records the
   cold-start sender, whether `currentAppleEvent` was set, and Teams' sender and executable name as
   about:vimma shows them.
4. **`feat(macos): vimma-open in the app bundle`.** The `ps` walk and the macOS hand-off
   (decision 9); the script in `Contents/Resources/vimma-open`, the bundle manifest, the cask's
   `binary`; the guide's macOS setup. Sets this spec to `implemented` and closes the issue.

## Open questions

1. **A guess when the program is unknown.** (a) None (decision 4). (b) The focused window's app
   (Hyprland's `activewindow`, X11's `_NET_ACTIVE_WINDOW`, macOS's `frontmostApplication`), as a
   separate, opt-in key. **Recommendation: (a)**, because a link from a background app would be
   attributed to whatever has focus, and the fallback differs per compositor, with none on GNOME.
2. **A rule for every link from another program.** (a) None: a `domain` rule applies to typed and
   external links alike. (b) `app = "*"`, which matches every link from another program, whether
   its names are known or not, as Zen's default route for external links does.
   **Recommendation: (b)**, as a small follow-up after sub-PR 2, because "sign-in links from
   anywhere else go to `work`" is otherwise not expressible without also routing what the user
   types.
3. **Checking the sender's identity on macOS.** (a) No: names are hints (Security and privacy),
   paired with `domain` where it matters. (b) Resolve the sender from its audit token with the
   Security framework (`SecCodeCopyGuestWithAttributes`), which also rules out pid reuse, and offer
   a `team` key compared with its Team ID, so that a look-alike app cannot claim Teams.
   **Recommendation: (a)**, because a forged name reaches only workspaces the rules already route
   to, the residual risks (a look-alike executable name, a page starting an app through an
   external protocol) are met by pairing `app` with `domain`, and (b) adds a key only macOS can
   honour.
4. **A workspace chosen by the caller.** (a) None: callers name a program, `config.toml` picks the
   workspace (decision 10). (b) `vimma-open --workspace <name>`, or a `--workspace` for
   `vimma-ctl open` on the `full` role, for scripts. **Recommendation: (a)**, because (b) lets any
   local caller choose any workspace, and a script can name itself with `--from` and get a rule.
5. **A list value for `app`.** (a) One string per rule (decision 1); the worked example uses one
   rule for `herdr` and one for `ghostty`. (b) `app = ["herdr", "ghostty"]`, matching when any
   listed name is among the link's names, at the nearest of them. **Recommendation: (a)**, because
   two rules are as clear, `:route add` and about:vimma stay one name per rule, and an older Vimma
   refuses a list (`expected a string`) and would keep its last good config.
6. **Following a multiplexer's client to its terminal.** (a) No: the chain ends at the server
   (decision 7), and the multiplexer's own rule applies. (b) Opt-in (`[routes] follow_clients`
   or a `vimma-open` flag): list the user's own processes once (`ps -U "$(id -u)"`, with Linux's
   `tmux: client` mapped like the walk's names), treat a server whose parent is pid 1 or a
   stop-list process as detached, and continue from its client when exactly one exists. It still
   cannot know which session that client shows, so a link from a detached session can be credited
   to the terminal showing another. **Recommendation: (a)**, because a rule naming the multiplexer
   covers the case without a guess, as the worked example's `herdr` rule does.
