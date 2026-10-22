# Spec: private-swap-macos

Status: draft (Delivery 1 and 2 built; the hand checks and open question 1 are open) · Area:
`packages/vimma-core/src/` (`hyprswap.mjs`'s pair state machine moved to a backend-neutral
`privatepair.mjs`, `nativeswap.mjs` new); `host/private-swap.mjs` (a backend switch),
`host/native-swap.mjs` (new, and its `jar.mn` line), `host/private-ops.mjs`,
`about/AboutVimma.sys.mjs`; `docs/guide.md`, `docs/limits.md` · Upstream patches: none · ADR:
none (no window manager IPC, so [ADR-017](../adr/017-window-manager-ipc.md) does not apply)

Issue: [#415](https://github.com/vimma-browser/vimma/issues/415)

Engine paths are relative to `engine/` and were read in Firefox 158.0.1 (`config/milestone.txt`,
the version in `surfer.json`). Facts about macOS that this spec could not check against source
are marked **unverified**, with the check that settles them.

## Summary

On Hyprland the private workspace takes the normal Vimma window's place
([private-swap](private-swap.md)): one window on screen whose contents change. On macOS it is
still a second window that opens beside the first. This spec brings swap in place to macOS
without a window manager: Vimma opens the private window at exactly the normal window's frame
(screen, position, size, zoomed or not), hides the normal window, and reverses this when you
switch back, close the private window or open a link from another app. The browser process owns
both windows, so Vimma does it with Firefox's own window visibility call, as Firefox does when it
hides windows at shutdown.

## Problem

On macOS, `ctrl+b shift+p` opens the private workspace as a second window at the current window's
size and position ([private-workspace](private-workspace.md), decision 7). Both windows are then
on screen, stacked: the normal window shows around or behind the private one if either is
moved or resized, both appear in Mission Control and in `` cmd+` ``, and going back raises the
normal window over the private one instead of replacing it. The private workspace does not read
as a workspace within one window, which is the gap private-swap closed on Hyprland.
`docs/limits.md` says the swap does nothing on macOS.

macOS has no window manager that Vimma could ask to swap two windows, and none is needed: a
process can hide and show its own windows and set their frames. What Hyprland does with a
special workspace, Vimma can do on macOS by hiding the normal window.

## Behaviour

1. As a user on macOS, `ctrl+b shift+p` (or `ctrl+shift+p`, `:private`, the picker) shows the
   private workspace exactly where my Vimma window was: the same screen, position and size, and
   zoomed if it was zoomed. My normal window is no longer on screen (whether macOS still lists it
   in the Window menu is open question 1). Going back (the toggle, `ctrl+^`, `ctrl+b (`,
   `ctrl+b )`, the picker, `:ws`) shows my normal window in the private window's place and hides
   the private window.
2. As a user, the windows do not animate: no zoom-in of a new window, no fade-out of the hidden
   one.
3. As a user, if I close the private window in any way (`ctrl+b shift+d`, `ctrl+shift+w`,
   `cmd+shift+w`, `cmd+w` on its last tab, the red close button, File → Close Window, a script),
   my normal window comes back in its place. It is never left hidden while no Vimma window is on
   screen.
4. As a user, if I move or resize the private window, going back shows my normal window at the
   private window's new frame.
5. As a user, a link I open from another app while the private workspace is shown opens in my
   normal window, which comes back in the private window's place and comes to the front.
6. As a user, if I pick the hidden normal window from the Window menu or the Dock menu (where
   macOS lists it, see Research), it comes back in the private window's place, as if I had
   switched back.
7. As a user whose Vimma window is in full screen (its own Space), going to the private workspace
   opens it in a fullscreen Space of its own, and going back switches to my normal window's
   Space. A window in full screen is never hidden (decision 7).
8. As a user, if Vimma quits or crashes while the private workspace is shown, the next start shows
   my normal window as usual. Nothing about the swap is written to disk.
9. As a user, if a swap cannot be done, Vimma shows my normal window, says
   `private: the swap failed; showing it as a window` once, and opens the private workspace as a
   window of its own until the config is next reloaded.
10. As a user, `[private] placement = "window"` in `config.toml` keeps today's behaviour, and
    `about:vimma` says which placement is in force on macOS and why.
11. As a user on Linux, nothing changes: Hyprland keeps private-swap's design, and other systems
    keep the second window (decision 14).

## Research

### Hiding a window: what Firefox already does

- Firefox hides its own browser windows from chrome JavaScript with
  `window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).visibility = false`: SessionStore
  hides every window while it flushes at shutdown
  (`browser/components/sessionstore/SessionStore.sys.mjs:2431-2440`), Tabbrowser hides a window
  whose last tab is being adopted elsewhere, after `windowUtils.suppressAnimation(true)`
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:7233-7246`), and the WebRTC indicator shows
  and hides its window the same way (`browser/base/content/webrtcIndicator.js:86-93, 484-491`).
- `visibility` is `nsIBaseWindow`'s attribute (`widget/nsIBaseWindow.idl:180`).
  `AppWindow::SetVisibility` hides the chrome docshell and calls the widget's `Show(aVisibility)`
  (`xpfe/appshell/AppWindow.cpp:850-873`). The getter always returns `true`
  (`AppWindow.cpp:839-848`, bug 306245), so Vimma cannot read a window's visibility back and
  must keep its own record. The WebRTC indicator works around the same limit with an attribute
  for its tests (`webrtcIndicator.js:89-93`).
- Hiding the docshell does not tear down the chrome document's layout: `nsDocumentViewer::Hide`
  returns early for a sticky viewer (`layout/base/nsDocumentViewer.cpp:1742-1759`), and viewers
  are sticky by default (`nsDocumentViewer.cpp:462`). So showing the window again needs no
  re-layout of the browser UI and the hidden window keeps its tabs, scroll positions and state.
- On macOS, `nsCocoaWindow::Show(false)` rolls up popups and calls `[mWindow orderOut:nil]`
  (`widget/cocoa/nsCocoaWindow.mm:5715-5732`). `Show(true)` calls `EnsureFrameIsOnScreen()` and
  `[mWindow makeKeyAndOrderFront:nil]`, with no animation when animation is suppressed
  (`nsCocoaWindow.mm:5670-5701`). `windowUtils.suppressAnimation(aSuppress)`
  (`dom/interfaces/base/nsIDOMWindowUtils.idl:462`) sets the window's
  `NSWindowAnimationBehaviorNone` (`nsCocoaWindow.mm:6153-6159`).
- A hidden window that macOS marks as not visible becomes fully occluded
  (`nsCocoaWindow.mm:7149-7198`), which deactivates its docshell: its pages report
  `document.hidden` and are throttled, as for a window behind another. Media keeps playing, as it
  does in Hyprland's special workspace. **Unverified:** that `orderOut:` triggers
  `windowDidChangeOcclusionState` (`nsCocoaWindow.mm:8083`). Check: hide a window playing a page
  that logs `visibilitychange`.

### Frame, zoom and full screen on macOS

- Firefox's `sizemode` on macOS is `fullscreen` in full screen, `minimized` when miniaturized,
  `maximized` when zoomed and `normal` otherwise (`nsCocoaWindow.mm:7086-7096`). A move that makes
  the frame equal the zoomed frame changes it to `maximized` (`nsCocoaWindow.mm:7113-7117`).
  `window.maximize()` queues a `Zoom` transition that zooms only a window that is not zoomed
  already and first records its restored bounds (`nsCocoaWindow.mm:6700-6708`).
- The restored (un-zoomed) bounds of a browser window are written to its root element's
  `screenX`, `screenY`, `width` and `height` attributes (`xpfe/appshell/AppWindow.cpp:1898-1960`;
  the browser window persists them, `browser/base/content/browser.xhtml:21`). Vimma can therefore
  open the private window at the normal window's restored frame and zoom it, so that un-zooming
  the private window goes to a real smaller frame. **Unverified:** that the attributes are current
  at switch time (they are written by `AppWindow`'s persist timer). Check: zoom, unzoom, move and
  zoom again, then read the attributes and compare with the frame before zooming.
- Firefox's own full screen (`F11`, View → Enter Full Screen, the green button) uses the macOS
  native transition: `window.fullScreen` goes through `FullscreenReason::ForFullscreenMode`,
  which calls `MakeFullScreenWithNativeTransition` (`dom/base/nsGlobalWindowOuter.cpp:4374-4379`),
  and a browser window with `NSWindowCollectionBehaviorFullScreenPrimary` gets a native
  fullscreen Space (`nsCocoaWindow.mm:6483-6522`). Only one window of the process can be in a
  native transition at a time (`sWindowInNativeTransition`, `nsCocoaWindow.mm:6791-6806`), and a
  transition takes the length of macOS's Space animation.
- A page's full screen (the Fullscreen API) is emulated full screen on the same Space unless
  `full-screen-api.macos-native-full-screen` is set (`nsCocoaWindow.mm:6279-6282, 6475-6477`), and
  Firefox leaves it when another window opens or is raised (`full-screen-api.exit-on.windowOpen`
  and `.windowRaise`, both `true`, `modules/libpref/init/StaticPrefList.yaml:6991-6998`). So by
  the time a swap runs, only Firefox's own (native) full screen can be in force.
- **Unverified:** what macOS does when a window in a native fullscreen Space is ordered out. The
  Space may stay as an empty black Space, or macOS may close it. Check by hand (Tests).
- Spaces: Firefox reads and sets a window's Space only through private CoreGraphics calls
  (`nsCocoaWindow.mm:6030-6151`, `Window.getWorkspaceID()` and `moveToWorkspace()`,
  `dom/webidl/Window.webidl:782-784`). For a window that has never been visible,
  `moveToWorkspace` is deferred until it is shown (`nsCocoaWindow.mm:6074-6095, 5705-5713`).
  **Unverified:** on which Space a window lands when it is ordered back in after `orderOut:`.
  macOS documents that an ordered-out window leaves its Space; Vimma expects it on the active
  Space, which is the Space of the window it replaces. Check by hand with two Spaces.
- Positions on macOS are in desktop pixels (points), and sizes in CSS pixels
  (`AppWindow.cpp:1914-1916`). A window opened with `screenX`, `screenY`, `outerWidth` and
  `outerHeight` features is placed there on macOS, which is what Vimma does today off Wayland
  (`src/browser/base/content/vimma/host/private-ops.mjs:151-163`).
- Opening a window with the `suppressanimation` feature sets
  `CHROME_SUPPRESS_ANIMATION` (`toolkit/components/windowwatcher/nsWindowWatcher.cpp:2015-2017`).
  Firefox itself opens new windows without animation when the opener is maximized
  (`browser/modules/BrowserWindowTracker.sys.mjs:389-393`).

### Focus, activation and links

- `nsCocoaWindow::SetFocus` raises a window only if it is visible or miniaturized
  (`nsCocoaWindow.mm:7234-7250`). A hidden window's `win.focus()` therefore does nothing on
  macOS, and does not reveal it. With `mozilla.widget.raise-on-setfocus` (default `true`,
  `StaticPrefList.yaml:14597-14600`) a visible window's `focus()` also activates the app when
  it is in the background.
- External links go to `BrowserWindowTracker.getTopWindow({ private: false })`
  (`browser/components/BrowserContentHandler.sys.mjs:1323-1335`), which does not skip hidden
  windows (`BrowserWindowTracker.sys.mjs:207-235`), so the link lands in the hidden normal window.
  `BrowserDOMWindow` adds the tab, which fires `TabOpen` synchronously, and only then calls
  `win.focus()` (`browser/modules/BrowserDOMWindow.sys.mjs:159-173`). A `TabOpen` listener that
  shows the normal window synchronously therefore makes Firefox's own `focus()` raise and
  activate it. On Hyprland the same hook had to race an asynchronous socket; on macOS there is
  no race.
- `nsCocoaWindow`'s constructor turns automatic window tabbing off
  (`nsCocoaWindow.mm:4931-4933`), so macOS never merges the two windows into one tabbed window.

### The Window menu, `` cmd+` ``, the Dock and Mission Control

- The window list in Vimma's Window menu is macOS's own: Firefox declares the XUL Window menu
  as `NSApp.windowsMenu` (`widget/cocoa/nsMenuX.mm:160-164`), and macOS appends the windows
  (`browser/base/content/browser-menubar.inc.xhtml:410-424`, which warns not to modify the menu
  for that reason). The Dock menu is Firefox's items (`toolkit/xre/MacApplicationDelegate.mm:275`)
  plus macOS's window list. `` cmd+` `` is macOS's "Move focus to next window"; Firefox binds no key
  for it.
- **Unverified:** whether macOS lists an ordered-out window in the Window menu and the Dock menu,
  and whether `` cmd+` `` cycles to it. Ordered-out windows are not on screen, so Mission Control
  and App Exposé do not show them (also **unverified**). Check by hand. Either way the design
  holds: if the user brings the hidden window forward from a menu, it becomes key, Vimma sees its
  `activate` event and completes the swap back (decision 7).
- Dock icon click: `applicationShouldHandleReopen:` calls `nsNativeAppSupportCocoa::ReOpen`
  (`toolkit/xre/MacApplicationDelegate.mm:248-259`), which looks for a visible window that is
  not miniaturized, else deminiaturizes the most recent browser window, and opens a new window
  only if there are no windows at all (`toolkit/xre/nsNativeAppSupportCocoa.mm`, `ReOpen`).
  A hidden window counts as a window, so if the only windows left were hidden, a Dock click
  would do nothing. Vimma never reaches that state (decision 6).
- `cmd+h` (Hide Vimma) and unhiding restore the windows that were on screen at the time, so the
  hidden normal window stays hidden (**unverified**; check by hand).

### Session and disk

- SessionStore saves only `width`, `height`, `screenX`, `screenY` and `sizemode` for a window's
  frame (`SessionStore.sys.mjs:151`), plus its Space
  (`SessionStore.sys.mjs:5539-5541, 5953-5955`). It has no notion of a hidden window, so the
  normal window is saved as an ordinary window and comes back visible after a quit or a crash.
  For a hidden window `getWorkspaceID()` falls back to the active Space
  (`nsCocoaWindow.mm:6056-6066`), so the window is restored there.
- Private windows are not restorable by macOS's own window restoration, and have snapshot
  restoration disabled (`nsCocoaWindow.mm:5221-5226`). SessionStore does not save them.

### Linux without Hyprland

- On Wayland, hiding a toplevel unmaps it (`widget/gtk/nsWindowWayland.cpp:2238-2253, 1275-1287`).
  A Wayland client cannot choose its position, so the private window cannot be put at the normal
  window's position, and a window shown again is placed by the compositor, not where it was.
  Vimma already omits the position on Wayland (`host/private-ops.mjs:156-157`).
- On X11 (`widget/gtk/nsWindowX11.cpp:317-370`), clients can request a position, but the window
  manager may place and decorate a re-mapped window as it likes.
- Hyprland keeps private-swap's design, because unmapping a tiled window would close its tile and
  re-tile the workspace, which is what private-swap's special workspace avoids.

### Prior art

Zen (`zen-browser/desktop`, default branch, searched with `gh search code` for
`nsIBaseWindow).visibility` and `treeOwner.QueryInterface(Ci.nsIBaseWindow)`) has no code that
hides browser windows; it reads `nsIBaseWindow` only in session store tests. Firefox's private
browsing on macOS is always a separate window. No Firefox fork found does this.

### Vimma today

- `private-ops.mjs`: `openPrivate` opens the private window with the current size and, off
  Wayland, position (`151-163`); `enterPrivate`, `showNormal` and `closePrivate` call
  `PrivateSwap.enter`, `PrivateSwap.show` and `PrivateSwap.beforeClose`, and fall back to
  `win.focus()` when those decline (`136-176, 265-278`).
- `private-swap.mjs` gates on Wayland and Hyprland (`gate()`, `137-144`), learns window
  addresses, and drives core's `pairStep` (`packages/vimma-core/src/hyprswap.mjs:545`), the pair
  state machine for `enter`, `leave`, `closing`, `activated` and `moved`, which knows nothing of
  Hyprland beyond window identifiers. It watches each window's `unload`, `activate` and `TabOpen`
  (`private-swap.mjs:493-506`).
- `[private] placement = "swap" | "window"` defaults to `"swap"`
  (`packages/vimma-core/src/config.mjs:215-219, 817`; `defaults.mjs:364`).
- `privacy.exposeContentTitleInWindow.pbm` is `false`
  (`src/browser/branding/vimma/pref/firefox-branding.js:166`), on every platform.
- Mochitests run headless (`tools/mochitest.mjs:41`), so on macOS too the windows are
  `HeadlessWidget`s: `Show` records visibility and raises a shown toplevel, and `SetFocus` raises
  only a visible one (`widget/headless/HeadlessWidget.cpp:164-198`). AppKit's behaviour is not
  exercised by any CI job.

## Design

### The mechanism

Vimma keeps the same in-memory **pair** as private-swap: the normal window the private
workspace was entered from, and the private window shown in its place (the **slot window**). On
macOS, "show X in place of Y" is one synchronous step in the parent process:

1. Read Y's frame: position and size, `windowState`, and, if Y is zoomed, its restored frame.
2. Suppress animation on both windows (`windowUtils.suppressAnimation(true)`).
3. If X is new, it was opened at Y's frame (restored frame if Y is zoomed) with
   `suppressanimation`. Otherwise move and resize X to Y's frame, restoring X first if it is
   zoomed and Y is not.
4. If Y is zoomed, zoom X (`maximize()`).
5. Show X (`visibility = true`), which orders it in and makes it key.
6. Hide Y (`visibility = false`).
7. Restore animation behaviour on both.

X is shown before Y is hidden, at the same frame, so nothing behind them shows through.

### Decisions

1. **Swap in place on macOS by native window visibility.** Vimma hides the normal window with
   `nsIBaseWindow.visibility`, because Firefox uses the same call to hide browser windows
   (Research) and the browser process owns both windows. Rejected: minimizing the normal window
   (`cmd+m`), because it animates into the Dock, stays in Mission Control and is a state the user
   can change; moving it off screen, because `EnsureFrameIsOnScreen` moves it back and it would
   stay in `` cmd+` ``; an upstream patch with an AppKit call, because the existing call does what
   is needed.
2. **The frame is copied, not tracked.** Each swap reads the slot window's frame at that moment,
   so that a moved or resized private window hands its new frame to the normal window (behaviour
   4), as Hyprland's swap reads the live state. Position goes in desktop pixels and size in CSS
   pixels, the units `AppWindow` uses (Research), so that windows on screens with different scale
   factors keep their frame. A zoomed window's restored frame comes from its root element's
   persisted attributes; if they are missing, X is opened at Y's zoomed frame and zoomed, so
   that it looks the same and only un-zooming differs.
3. **Same backend switch, same state machine.** `private-swap.mjs` picks a backend once per
   config load: Hyprland (unchanged) on Wayland with Hyprland, native on macOS, none elsewhere.
   Core's `pairStep` becomes backend-neutral in `privatepair.mjs` (window identifiers are opaque
   strings; the native backend uses a per-window counter; the user moving Hyprland's parked
   window out is the neutral `unparked` event, which `hyprswap.mjs` maps its `moved` event to),
   so that both backends share one tested state machine and
   `private-ops.mjs` keeps calling `PrivateSwap.enter`, `show` and `beforeClose` unchanged.
   Rejected: a second, macOS-only module wired into `private-ops.mjs`, because the two backends
   follow the same rules for which window swaps and when.
4. **Which windows swap** is private-swap's decision 6, unchanged: entering from normal window N
   first shows any other hidden normal window again; the most recent private browser window is
   shown in N's place, or a new one is opened there; a private window visible elsewhere is only
   focused; pop-ups and extra private windows never swap or hide. Leaving to a normal window
   other than the hidden one first shows the hidden one again in the slot, then focuses the
   target. Reason: one hidden window at most, so no window can be forgotten. Vimma's keys run
   in pop-ups too, so the native backend declines a switch made from a pop-up (a window whose
   `toolbar.visible` is false) and shows the private workspace as a window. Whenever the native
   backend declines while the private window is hidden (a pop-up, `"window"` placement, a
   failure), it shows every hidden window first, because the caller's `focus()` cannot show a
   hidden window on macOS.
5. **Focus.** Showing a window with `visibility = true` makes it key (Research), so the swap
   calls no `focus()`. When the swap runs while Vimma is not the active app (a link, or
   `vimma-ctl send-keys` from a terminal), Vimma then calls `focus()` on the shown window so that
   `raise-on-setfocus` activates the app, as Firefox would for a link.
6. **Never stranded.**
   - **The slot window closes** (any close path in behaviour 3): on its `unload` event, Vimma
     shows the hidden normal window at the slot window's frame. Every close path ends in
     `AppWindow::Destroy`, which destroys the docshell, and so fires `unload`, before it
     destroys the native window (`xpfe/appshell/AppWindow.cpp:541-565`, Firefox 158.0.1), so
     the hidden window is shown while the closing one still exists and the Dock's reopen
     (Research) always finds a visible one. Off GTK, `AppWindow::Destroy` first orders the
     closing window out (`mWindow->Show(false)`, `AppWindow.cpp:522-524`), so for that moment
     no Vimma window is on screen and the desktop behind may show for a frame; the hand checks
     look for it. The `close` event is not used, because the close-tabs warning can still cancel
     it after Vimma would have acted, and every close path reaches `unload` anyway.
     `ctrl+b shift+d` swaps first, then closes, so it has no such moment.
   - **A link reaches the hidden normal window** (`TabOpen` while hidden): Vimma swaps it back
     in place synchronously; Firefox's own `focus()` follows and brings Vimma to the front
     (behaviour 5).
   - **The hidden window becomes key** without Vimma (the Window menu, the Dock menu, `` cmd+` ``,
     if macOS offers it there): its `activate` event completes the swap back, so that the user
     never sees both windows at once.
   - **The slot window is minimized:** nothing changes; the normal window stays hidden, and
     restoring the private window from the Dock shows the private workspace. A Dock click while
     the private window is minimized deminiaturizes it (Research).
   - **Quit or crash** with a window hidden: nothing about the pair is written anywhere, and
     SessionStore saves the normal window as an ordinary window (Research), so the next start
     shows it. This is private-swap's "nothing written to disk", for the same reason: no flag is
     needed.
7. **Native full screen: never hide a fullscreen window.** Vimma never hides a window that is in
   a native fullscreen Space, because what macOS does with an ordered-out fullscreen window is
   unverified (Research), and this is the only way that needs no unverified AppKit behaviour and
   no repeated native transitions. A private window entered from a fullscreen normal window is
   opened and put in full screen of its own; going back focuses the other window, and macOS
   switches Spaces, with its own animation. A window that goes full screen while it is the slot
   window is not hidden either: going back shows the hidden window as a window of its own and
   forgets the pair. Rejected: leaving full screen on the normal window, swapping and entering
   full screen on the private window, because every switch would then take two native
   transitions, which Firefox serializes and each of which lasts as long as macOS's Space
   animation; no swap at all in full screen, because the private workspace would then be a
   plain second window exactly where full screen makes it most visible; hiding the fullscreen
   window like any other, because it depends on the unverified behaviour above. The last can
   be revisited once the hand check shows what macOS does.
8. **Multiple normal windows.** Only the window the private workspace was entered from is
   hidden. Other normal windows stay on screen, so the private window replaces one window, not
   the app's windows, the same as on Hyprland.
9. **Failure fallback.** If any step throws, or the shown window does not report the frame it
   was given within one event loop turn, Vimma shows every hidden window of the pair at the slot
   frame, forgets the pair, says `private: the swap failed; showing it as a window` once, and
   uses `"window"` placement until the next config reload. Reason: as on Hyprland, a broken swap
   must leave the user with visible windows and a working private workspace.
10. **Config.** `[private] placement` keeps its values and its `"swap"` default (schema 2,
    `config.mjs`), so that existing configs keep working: `"swap"` means the native swap on
    macOS and Hyprland's swap on Hyprland; `"window"` opts out everywhere. No new key, action or
    binding. macOS gets the swap by default, since the hand checks run before the delivering PR
    merges and `"window"` stays one line away. Rejected: `"window"` on macOS until the hand
    checks have run on a released build, because that needs a per-platform default, so the same
    `config.toml` would mean different things on Linux and macOS. The comment that
    `defaults.mjs` writes into the generated `config.toml` names macOS next to Hyprland.
11. **`about:vimma`.** The window manager line reads, on macOS,
    `Window manager: none needed (macOS), private placement: swap`, or `window (config)`, or
    `window (swap failed)`, or `window (config not read yet)` before `config.toml` is read, when
    no window is hidden yet. It shows no frame, title or window identifier, because the page can
    be copied into a bug report.
12. **Privacy.** The private window's title stays `Vimma Private Browsing`
    (`privacy.exposeContentTitleInWindow.pbm`, already `false` on macOS), which matters more now
    because the private window holds the normal window's place in the Window menu, the Dock
    menu and screen-sharing pickers. The pair, the frames and the hidden state stay in memory.
13. **Core** (pure, Vitest): `nativeswap.mjs` plans "show X in place of Y" from two plain frame
    records (`{ x, y, width, height, sizemode, restored }`): the frame and zoom to apply to X,
    whether X must be restored first, and whether the swap is refused (a fullscreen window, a
    minimized window, a zero-size frame). The host reads and applies frames; core decides, so that
    every frame rule is covered by Vitest without a browser.
14. **Scope: macOS only.** The native backend is selected on macOS alone. On Linux nothing
    changes: Hyprland keeps private-swap's design, because unmapping a tiled window would close
    its tile and re-tile the workspace (Research), and every other system keeps the second
    window, because on Wayland a client cannot place its window and a re-shown window is placed
    by the compositor, and on X11 the window manager may re-place a re-mapped window, so "exactly
    where it was" cannot be kept there. Rejected: the native mechanism on X11 or on every
    non-Hyprland system, for that reason.

## Security and privacy

No new surface. The swap uses chrome-only calls in the parent process (`nsIBaseWindow`,
`windowUtils`, window geometry), opens no socket and runs no program, and no page can call any
of it. What a hidden window hides is only its pixels: its pages keep running, the clipboard is
shared as before, and `vimma-ctl state` reports both windows as today (`"private": true` with
`null` URLs and titles for the private one). Nothing new is written to disk: the pair is in
memory, SessionStore never sees a hidden flag, and private windows stay out of macOS window
restoration (Research). `docs/security.md` needs no change, since no security-sensitive
component (the control socket, MCP, the agent gate, content actors) is touched.

## Tests

- **Vitest** (`packages/vimma-core`):
  - `nativeswap.test.mjs`: plans for a normal, a zoomed (with and without a restored frame), a
    minimized and a fullscreen Y; X zoomed and Y not (restore first); frames on a second screen
    with negative coordinates; a zero-size frame refused.
  - `hyprswap.test.mjs`: the existing `pairStep` cases pass with opaque identifiers that are not
    Hyprland addresses.
  - `config.test.mjs`: unchanged values and default; `defaults.test.mjs.snap` changes only the
    comment line, with the changelog line the snapshot rule asks for.
- **Mochitest** `browser_vimma_private_swap_native.js`, headless, with the native backend forced
  by a test hook (headless otherwise selects no backend). It runs in the Linux job and in the
  macOS job, since both use `HeadlessWidget`. A spy records each window's `visibility` writes,
  because the getter always returns `true` (Research).
  - Entering: the private window ends at the normal window's `screenX`, `screenY`, `outerWidth`,
    `outerHeight` and `windowState` (normal and maximized); the normal window got
    `visibility = false` after the private one got `true`; `Services.focus.activeWindow` is the
    private window; no `focus()` was called on the hidden window.
  - Leaving by the toggle, `ctrl+^`, `ctrl+b )` and the picker: the mirror image, at the private
    window's frame after the test moved and resized it.
  - Closing the slot window by `ctrl+shift+w`, `window.close()` and `ctrl+b shift+d`: the normal
    window is shown at the slot frame before the private window's `unload` completes.
  - A link through `nsIBrowserDOMWindow.openURI` with `OPEN_EXTERNAL` while the normal window is
    hidden: the tab opens there, the normal window is shown in the slot, and the private window
    is hidden.
  - An `activate` of the hidden window: the swap back runs.
  - Two normal windows: entering from the second shows the first again before hiding the second.
  - A thrown error in the backend: both windows end visible, the message is said once, and the
    next switch uses `"window"` placement.
  - `[private] placement = "window"`: no `visibility` write at all.
  - No disk: the profile directory has no new file and `SessionStore.getWindowState` of the
    normal window has no field the test did not expect.
  - A config reload to `"window"` while the private window is hidden shows it and forgets the
    pair; the next switch shows that window.
  - A pop-up: `ctrl+b shift+p` in it never hides it or the normal window, and shows a hidden
    private window.
  - Two normal windows, then a swap that breaks half way: the hidden window comes back at the
    last swap's slot, not an earlier one's.
  - A private window that ignores the size it is given: the frame check fails the swap.
  - A fullscreen normal window: nothing is hidden, the private window goes full screen.
  - The un-zoomed frame of a private window entered from a zoomed one is the restored frame.
  - Going back before a new private window has started up: nothing is hidden later.
  - Activations and new tabs during a swap do not start another one.
  - No swap while Vimma quits, and none before `config.toml` is read.
  - Every public member of the Hyprland backend is routed by the backend switch.
- **e2e:** none. The e2e harness runs under Xvfb on Linux, where this backend is never selected.
- **By hand on a Mac** (recorded in a Results section, as private-swap does), on the current
  macOS release with a non-headless build (`npm start`, or `npm run mochitest -- --headed` for
  the mochitest): no animation on enter and leave, including a zoomed window's zoom
  (`maximize()` calls `[NSWindow zoom:]`, whose resize animation `animationBehavior` may not
  govern); no flash of the desktop when the slot window is closed by the red button, `cmd+w`
  or `ctrl+shift+w` (decision 6); no false `swap failed` from the frame check, which reads a
  window's frame after it was moved while ordered out; the hidden window absent from Mission
  Control, App Exposé and `` cmd+` ``, and whether the Window menu and the Dock menu list it;
  picking it there swaps back; a link from another app while Vimma is in the background; the
  red close button, `cmd+w` on the last tab and File → Close Window; `cmd+h` and unhide; a Dock
  click; two Spaces (the window shown on the active Space); two displays with different scale
  factors; a zoomed window, un-zoomed afterwards; a native fullscreen window (decision 7),
  including what macOS does if a fullscreen window is ordered out; `kill -9` while the normal
  window is hidden, then a restart; `document.hidden` in the hidden window.

## Docs and changelog

- `docs/guide.md`, "Private workspace": the paragraph "On Hyprland it takes your Vimma window's
  place" becomes "On Hyprland and macOS …", with a short macOS item (how: Vimma hides the normal
  window itself, no window manager involved; a fullscreen window is never hidden (decision 7);
  the Window menu behaviour found by the hand checks). "Elsewhere" lists other Linux systems and
  `placement = "window"`. The `config.toml` section's `[private] placement` text names macOS.
- `docs/limits.md`: the macOS line drops "the Hyprland private-window swap"; a new line says that
  on macOS the hidden normal window still runs its pages and still appears to scripts
  (`vimma-ctl state`), and states the fullscreen limit (decision 7).
- README status, if it lists the private workspace's swap as Hyprland-only.
- `CHANGELOG.md` [Unreleased]: added by the maintainer at merge time, except the line for the
  `defaults` snapshot, which the PR that changes it adds.

## Delivery

1. **refactor(private): a backend-neutral pair state machine.** Core only: `pairStep` takes
   opaque identifiers, and `nativeswap.mjs` with its Vitest cases. No behaviour change; the
   Hyprland mochitest still passes.
2. **feat(private): swap in place on macOS.** `native-swap.mjs`, the backend switch in
   `private-swap.mjs`, the `about:vimma` line, the `defaults.mjs` comment and its snapshot, the
   headless mochitest, the guide and limits, and the hand checks recorded in Results. Mergeable
   alone; it sets the status to `implemented` once the Results record the hand checks and
   open question 1 is settled.

## Open questions

1. **The hidden window in the Window menu and the Dock menu.** If the hand check shows that macOS
   still lists the hidden window: (a) leave it listed; picking it swaps back (decision 6). (b) Keep
   it out with `NSWindow.excludedFromWindowsMenu`, which needs an upstream patch and an ADR-003
   register line, because chrome JavaScript cannot set it. **Recommendation: (a)**, because the
   entry then works as a way back to the normal window, and it costs no patch.
