# Spec: private-swap

Status: implemented (Results records the hand checks run so far; the rest of the Test plan's
hand-check list is not recorded) · Milestone: after
[private-workspace](private-workspace.md) (merged, #142) · Area: `packages/vimma-core/src/`
(`hyprswap.mjs` new, `config.mjs`, `defaults.mjs`); `host/hypr/HyprIpc.sys.mjs` (new),
`host/private-swap.mjs` (new), `host/private-ops.mjs`, `about/AboutVimma.sys.mjs`,
`config/ConfigHost.sys.mjs`, `branding/vimma/pref/firefox-branding.js` (one pref, decided
question 1). No upstream patch. ADR: [017-window-manager-ipc](../adr/017-window-manager-ipc.md).

Engine paths are relative to `engine/` (Firefox 157.0.1). Hyprland facts were checked on this
machine: Hyprland 0.56.2 (commit `efb5099`, Lua config, Omarchy), read-only commands only.

## Goal

The private workspace opens in a window of its own, where it should feel like a workspace within the
normal window. On Hyprland, Vimma closes that gap with **swap in place**. Going to the private
workspace hides the normal Vimma window in a Hyprland special workspace and puts the private window
exactly where the normal one was: the same Hyprland workspace, the same tiling slot, size and
position, and the same fullscreen or floating state. Going back swaps again. The user sees one
window whose contents change. Hyprland only; other window managers and X11 keep today's behaviour.

This reverses decision 7 and decided question 1 of private-workspace.md ("Vimma runs no WM
command"): a window of its own tiled beside the normal one does not read as a workspace, and on
Hyprland the compositor can place it where the normal window was. Per-tab private browsing in one
window is still infeasible (private-workspace.md, option C): Firefox decides privacy per window, so
the private workspace stays a private window. This spec changes where that window is shown.

## User stories

- As a user on Hyprland, `ctrl+b shift+p` makes the private workspace appear exactly where my
  Vimma window was: same workspace, same tile, same size, still fullscreen if it was. My normal
  window is not beside it, behind it or on another workspace I can see. Pressing it again (or
  `ctrl+^`, `ctrl+b (`, `ctrl+b )`, the picker) puts my normal window back in the same place.
- As a user, the other windows on that workspace do not move when I switch: the tile keeps its
  size, and the split layout does not change.
- As a user, if I close the private window in any way (`ctrl+b shift+d`, `ctrl+shift+w`,
  `SUPER+W`), my normal window comes back in its place. It is never left hidden.
- As a user, a link I click in another app opens in my normal window, and I see it (decided
  question 2).
- As a user, if Vimma quits or crashes while the private workspace is shown, the next start
  shows my normal window as usual. Nothing about the private workspace or the swap was written
  to disk.
- As a user without Hyprland (another compositor, X11), or with `[private] placement = "window"`,
  everything works as it does today.

## Research

### Talking to Hyprland

- **Two Unix sockets** live in `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/`:
  `.socket.sock` takes one request per connection and replies, and `.socket2.sock` streams events
  as `name>>data` lines. On this machine the directory is `drwx------` and owned by the user, so
  only the user's own processes can reach it. The path is 95 bytes long, under the 107-byte `sun_path` limit
  that `nsSocketTransport::InitWithName` checks (`netwerk/base/nsSocketTransport2.cpp:846-849`).
- **Request format** (checked with a Python client on `.socket.sock`): `j/<cmd>` returns JSON
  (`j/version`, `j/clients`, `j/getoption misc:focus_on_activate`). `[[BATCH]]a;b` runs several
  commands in one request. The replies are joined with `\n\n\n`. A failing command does not stop
  the batch:
  `[[BATCH]]dispatch hl.dsp.no_op();dispatch notadispatcher` →
  `ok\n\n\nerror: return hl.dispatch(notadispatcher):1: …`. So a batch is one round trip, but it
  is not a transaction.
- **The dispatch dialect depends on the config language.** With a Lua config (Omarchy's,
  `~/.local/share/omarchy/default/hypr/*.lua`), `dispatch X` runs `return hl.dispatch(X)` as Lua.
  The error above says so, and `dispatch hl.dsp.no_op()` replies `ok`. Hyprland still ships the
  legacy config manager and a translator for the old dispatcher names
  (`/usr/include/hyprland/src/config/legacy/DispatcherTranslator.hpp`). Omarchy's own scripts
  try the Lua form first and fall back to the legacy name
  (`/usr/bin/omarchy-launch-signal:10`, `omarchy-hyprland-focus-app:30`,
  `omarchy-hyprland-window-pop:24-39`). Vimma has to speak both, and must treat the Lua dialect
  as code execution in the compositor: `hl.exec_cmd` runs a shell. That is the main reason for
  the fixed command set below.
- **Dispatchers needed** (names from Omarchy's bindings and scripts, and from argument errors in
  the Hyprland binary, `strings /usr/bin/Hyprland`):

  | Step                   | Lua dialect                                                                                                                                 | Legacy dialect                                                                 |
  | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
  | Move without following | `hl.dsp.window.move({ workspace = W, follow = false, window = "address:A" })` (`tiling.lua:28`, `window-pop:32`)                            | `movetoworkspacesilent W,address:A`                                            |
  | Focus a window         | `hl.dsp.focus({ window = "address:A" })` (`omarchy-hyprland-focus-app:30`)                                                                  | `focuswindow address:A`                                                        |
  | Swap with the focused  | `hl.dsp.window.swap({ other = "address:B" })` (`other` is the key next to `hl.window.swap` in the binary; to confirm in step 1 of the plan) | `swapwindow address:B`                                                         |
  | Fullscreen state       | `hl.dsp.window.fullscreen_state({ internal, client, window })` ("expected a table { internal, client, action?, window? }")                  | `fullscreenstate I C` (acts on the focused window)                             |
  | Float / tile           | `hl.dsp.window.float({ action = "enable" \| "disable", window })` (`window-pop:25`)                                                         | `setfloating address:A` / `settiled address:A`                                 |
  | Exact size / position  | `hl.dsp.window.resize({ x, y, window })`, `hl.dsp.window.move({ x, y, window })` (`window-pop:29-32`)                                       | `resizewindowpixel exact X Y,address:A`, `movewindowpixel exact X Y,address:A` |
  | Probe the dialect      | `hl.dsp.no_op()` → `ok`                                                                                                                     | anything else                                                                  |

- **Events on `.socket2.sock`** (names present in the binary): `openwindow>>ADDR,WS,CLASS,TITLE`,
  `closewindow>>ADDR`, `movewindowv2>>ADDR,WSID,WSNAME`, `windowtitlev2>>ADDR,TITLE`,
  `activespecialv2>>ID,NAME,MON`. The event stream carries **every** window's title, other apps'
  included. Vimma reads it only to match its own nonce (below).
- **No exec needed.** `nsISocketTransportService.createUnixDomainTransport(nsIFile)`
  (`netwerk/base/nsISocketTransportService.idl:95`, implemented at
  `netwerk/base/nsSocketTransportService2.cpp:1039-1060`, XP_UNIX only) gives an async stream
  transport in the parent process, the same machinery as the control socket
  (`ctl/VimmaControl.sys.mjs:641-648`). `nsIServerSocket.initWithFilename`
  (`netwerk/base/nsIServerSocket.idl:163`) is its server side, so a test can be the fake
  Hyprland (`netwerk/test/unit/test_unix_domain.js:72, 146` does both). The alternative,
  `Subprocess.sys.mjs` running `hyprctl`, spawns a process for each switch (tens of ms), finds
  `hyprctl` on `PATH` (shadowable), passes command text as argv, and adds an exec path to a
  browser that has none today. Rejected (ADR-017).

### Telling the two Vimma windows apart

- `hyprctl clients -j` on this machine: the Vimma window is `class: vimma-vimma`,
  `initialTitle: Vimma`, with a `pid`, an `address` (`0x571e4538c0b0`), `workspace {id, name}`,
  `floating`, `fullscreen`, `fullscreenClient`, `grouped`, `pinned`, `at`, `size`, `monitor`,
  `xdgTag: ""` and `stableId`. A private window is the same process, so it has the same `pid`
  and the same class. GTK's class does not depend on privacy (private-workspace.md research).
  Only the title differs.
- `xdgTag` would be ideal (xdg-toplevel-tag), but Firefox does not implement that protocol
  (`grep -rn toplevel_tag engine/widget/gtk` finds nothing). Firefox's Wayland window title is
  `gtk_window_set_title` (`widget/gtk/nsWindow.cpp:1903-1918`), fed by the chrome document's
  title, which Tabbrowser sets (`Tabbrowser.sys.mjs:1769-1810`).
- **Chosen: a nonce title.** Vimma sets the chrome window's `document.title` to
  `vimma-<32 hex>` (random, held in memory), waits for `windowtitlev2>>ADDR,vimma-<nonce>` on
  the event socket, and caches `ADDR` for that window. Then it restores the real title
  (`gBrowser.updateTitlebar()`). The address is stable for the window's life and is dropped on
  `closewindow>>ADDR` or when the window unloads. It is resolved when a Vimma window opens on
  Hyprland, so no title flashes at switch time. As a fallback, if no event arrives within
  500 ms, `j/clients` is searched for that title and our `pid` (`Services.appinfo.processID`,
  `xpcom/system/nsIXULRuntime.idl:218`). (Since changed: without the event or the title in
  `j/clients`, Vimma waits up to 2 s and searches `j/clients` again, so a late-named fresh
  window can show its nonce title for that long; `docs/guide.md`, "On a busy machine", and
  [#422](https://github.com/vimma-browser/vimma/issues/422).)
- Rejected: "the active window when the key arrived" (wrong for `vimma-ctl send-keys`, a
  focus race), "the one new address with our pid" (ambiguous with pop-ups and `ctrl+n`), and
  `initialTitle` (identical for every normal window).

### Hyprland behaviour the swap relies on (this machine)

`hyprctl getoption`: `general:layout = dwindle`, `dwindle:preserve_split = true`,
`misc:focus_on_activate = true`, `misc:on_focus_under_fullscreen = 1`,
`misc:close_special_on_empty = true` (default), `group:auto_group = true` (default),
`group:group_on_movetoworkspace = false` (default),
`binds:hide_special_on_workspace_change = true`, `animations:enabled = true`.

- **Dwindle:** a window moved into a workspace splits the focused node. Removing a leaf hands
  its box to its sibling. So "move private in, swap private and normal, move normal out" leaves
  private in normal's exact box, and every other tile in its old box. Under master and scrolling
  layouts, swapping exchanges the two windows' positions in the order, and removing normal
  restores the old order, with the same result. This is to be checked by hand under each layout
  (test plan).
- **Special workspaces** are hidden unless toggled. Omarchy binds only `special:scratchpad`
  (`tiling.lua:27-28`), and its bar does not show special workspaces (no `special` in
  `shell/plugins/bar/widgets/Workspaces.qml`). Focusing a window in a hidden special workspace,
  for example after an activation request with `focus_on_activate`, opens that special workspace
  over the current one. That is the "stranded" risk below.
- **Groups:** with `group_on_movetoworkspace = false`, a window moved next to a group tiles
  beside it rather than joining it. The swap does not try to reorder a group.
- **Hyprland's own log** (`hyprland.log`, 434 668 lines) has no line with `vimma-vimma` or
  `Private Browsing`, so on this machine it does not record window titles.

### Firefox paths that touch the parked window

- **External links** go to `BrowserWindowTracker.getTopWindow({ private: false })`
  (`browser/components/BrowserContentHandler.sys.mjs:1324-1333`), which is the parked normal
  window. `BrowserDOMWindow` then calls `win.focus()`
  (`browser/modules/BrowserDOMWindow.sys.mjs:124, 172, 445`), which becomes an xdg-activation
  request (`widget/gtk/WidgetUtilsGtk.cpp:424-460`). With `focus_on_activate`, Hyprland would
  show the special workspace with the normal window floating over the private one.
- **Private window title:** `<page title> — Vimma Private Browsing` on Linux
  (`Tabbrowser.sys.mjs:1773-1810`, `browser.ftl:11-14`). Firefox's own pref
  `privacy.exposeContentTitleInWindow.pbm` (`browser/app/profile/firefox.js:2810`, read at
  `Tabbrowser.sys.mjs:52-55, 1717-1725`) set to `false` makes it just `Vimma Private Browsing`.
- **Vimma today:** `openPrivate` passes size and, off Wayland, position
  (`host/private-ops.mjs:146-159`). `enterPrivate` and `showNormal` call `win.focus()`
  (`166-172`, `131-138`). `leavePrivate` remembers the window left, in memory
  (`41-46, 190-197`). `closePrivate` closes every private window after the question
  (`256-266`). Core's `privateToggle`, `privateReturn` and `cycleFromPrivate` decide where a
  key goes (`packages/vimma-core/src/privatews.mjs:44-77`). The swap changes how the host
  shows a window, not where a key goes, so core's existing rules stay as they are.

## Design

### The mechanism

Vimma keeps one **pair** in memory: the normal window the private workspace was entered from,
and the private window shown in its place (the **slot window**). At most one of them is
**parked** in `special:vimma`. "Show X in place of Y" reads the live state (`j/clients`, one
request), plans with core, and sends one `[[BATCH]]`:

1. If Y is fullscreen, set Y's fullscreen state to `0 0` (remember Y's `fullscreen`,
   `fullscreenClient`).
2. If X is floating and Y is not, tile X (or the other way round).
3. Move X to Y's workspace without following (X is new, or parked in `special:vimma`).
4. Focus X, then swap with Y. X now holds Y's slot, and Y holds the slot X was given.
5. Move Y to `special:vimma` without following. Y's temporary slot collapses into X's.
6. Focus X. If step 1 ran, set X's fullscreen state to Y's old values.

A floating Y is simpler. X is moved in, set floating, resized and moved to Y's exact `size` and
`at`, and Y is parked; no swap. Firefox does not call `win.focus()` on the swap path. Hyprland's
focus gives the window keyboard focus, and GTK's focus-in activates it in Firefox. Calling
`focus()` on a parked window would send an activation request and open the special workspace.

The first entry opens the private window as today (`OpenBrowserWindow`), waits for its address
(nonce, above), then runs the same batch. Until then it is a new tile beside normal; the planned
hand check records how long that lasts (a frame or two plus Hyprland's open animation).

### Decisions

1. **Swap in place on Hyprland, by default.** New config key `[private] placement = "swap" |
"window"` (schema 2, default `"swap"`, read live). `"swap"` applies only when Hyprland is
   found (below). Elsewhere, and with `"window"`, private-workspace.md's behaviour is unchanged.
   No new key bindings and no new actions. The existing keys switch the same way, and only the
   way a window is shown changes.
2. **Socket IPC, no exec** (ADR-017). `HyprIpc.sys.mjs` opens `.socket.sock` per request and
   holds one `.socket2.sock` connection while swap placement is active. Only the parent process
   uses it. Content processes and actors never see it, and nothing a page sends can reach it.
3. **Finding Hyprland.** `HYPRLAND_INSTANCE_SIGNATURE` must match `^[A-Za-z0-9_]{1,128}$`.
   `XDG_RUNTIME_DIR` must be an absolute path. The socket is
   `$XDG_RUNTIME_DIR/hypr/<sig>/.socket.sock`, with no other location and no config override.
   Missing variables, a missing socket, a refused connection, no reply within 500 ms, or a
   probe that fails both dialects all mean "no Hyprland". Placement is then `"window"` for the
   session, `about:vimma` says why, and the browser console gets at most one line per session.
   Each later switch retries once if the cause was a timeout.
4. **Fixed command set, built in core.** `hyprswap.mjs` encodes a closed list of verbs (move,
   focus, swap, fullscreen state, float/tile, exact size, exact position, no-op, `j/clients`) in
   both dialects. Arguments are only:
   - addresses matching `^0x[0-9a-f]{1,16}$`,
   - integer workspace ids, or a workspace name matching `^[A-Za-z0-9_.-]{1,64}$` passed as
     `name:<name>`,
   - integers for geometry and fullscreen modes,
   - the constant `special:vimma`.

   Any other value refuses the swap, and that switch falls back to `"window"` behaviour. No
   title, URL, user text or config string is ever put in a command. Lua mode is code execution
   in the compositor, so a test checks every encoded command against a whitelist pattern. The
   encoder has no string escaping, so there is nothing to get wrong.

5. **Identifying windows: the nonce title** (research). Resolved once per Vimma window on
   Hyprland, when it opens (and lazily for windows that were open before Hyprland was found).
   The nonce is random and says nothing about the window. The event parser compares each
   `windowtitlev2` title against pending nonces and drops it at once. It stores and logs no
   other title.
6. **Which windows swap.**
   - Entering private from normal window N: if another normal window is parked, it is first
     swapped back into its slot. Then the most recent private browser window, if it is parked,
     is shown in N's place; if there is none, a new one is opened and shown in N's place. If the
     most recent private window is visible somewhere else (for example a second one from
     `ctrl+n`), Vimma just focuses it, as today, and parks nothing.
   - Leaving private (toggle, `ctrl+^`, `ctrl+b (`/`)`, the picker, `:ws`): if the target normal
     window is the parked one, it is shown in the slot window's place and the slot window is
     parked. If the target is another normal window, the parked one is swapped back first, then
     the target is focused as today.
   - Pop-ups and extra private windows are never swapped or parked.
   - **Grouped or pinned** Y: no swap. X is moved to Y's workspace and focused, as the
     `"window"` placement would place it (with `auto_group`, a new private window opens inside
     the group, which is the old `SUPER+G` recipe and still works).
7. **Never stranded** (recovery):
   - **The slot window closes** (`ctrl+shift+w`, `SUPER+W`, `ctrl+b shift+d`, a script): on
     its `unload`, before the surface goes, Vimma sends the batch that shows the parked normal
     window in its place. If that arrives too late, `closewindow>>ADDR` moves the normal window
     into the slot window's last workspace and focuses it (best effort: a new tile).
     `ctrl+b shift+d` swaps first, waits for the reply, then closes.
   - **A link or activation reaches the parked normal window** (decided question 2): a
     `TabOpen` in the parked window, or its `activate` event, swaps it back in place, as
     Firefox's own focus would have taken you there. The `TabOpen` hook runs before Firefox's
     `win.focus()` (`BrowserDOMWindow.sys.mjs:124`), so the batch usually lands before the
     activation request, and the special workspace never opens.
   - **The user shows `special:vimma`** (a `toggle_special` binding, a script): nothing breaks.
     Focusing the parked window there is an activation and swaps it back.
   - **The user moves a parked window out** of `special:vimma` (`movewindowv2` to another
     workspace): Vimma forgets the pair and does not fight. Both windows are then ordinary
     windows, and the next entry starts a new pair.
   - **The user moves the visible window** to another workspace or monitor: the slot moves with
     it, because every swap reads the live state first.
   - **Vimma quits or crashes** with a window parked: both windows belong to the dead process,
     so Hyprland drops them. The next start restores the normal window as a fresh surface,
     placed by Hyprland as any new window. **Nothing is written to disk**, not even a "parked"
     flag: none is needed. Hyprland crashing takes the session with it.
   - **Monitors:** workspaces keep their ids when monitors change, so the batch needs nothing
     monitor-specific. `special:vimma` is shown on whichever monitor toggles it.
   - **Swap failures:** each batch reply is checked. If a step failed, Vimma tries to show the
     normal window (move it out of `special:vimma` to the active workspace and focus it), clears
     the pair, says `private: the window manager refused the swap; showing it as a window` once,
     and uses `"window"` placement until the next config reload.
8. **Leak guarantees (private-workspace.md decision 8) still hold.**
   - Commands carry only addresses, ids, integers and constants (decision 4), never anything
     from a private (or any) page.
   - The event stream's titles stay in memory only as long as it takes to compare them with
     the nonce. They are never logged, and error messages quote no event text (a test checks).
   - Nothing about the pair, the parked state or addresses is written to disk or to SessionStore.
   - The window title Hyprland sees (decided question 1): Vimma defaults
     `privacy.exposeContentTitleInWindow.pbm` to `false`, so the private window's title is
     `Vimma Private Browsing`, without the page title, in Hyprland's clients, the bar,
     screen-sharing pickers and the event stream. The user can turn it back in `about:config`.
     This matters more now: the private window sits in the normal window's place, so anything
     that shows "the Vimma window's title" shows the private one.
9. **Core** (pure, Vitest): `hyprswap.mjs` parses the clients JSON into records without titles,
   parses event lines, encodes commands per dialect, decides the dialect from the probe reply,
   and plans the batch for "show X in place of Y" (tiled, floating, fullscreen, grouped or
   pinned → no-swap fallback, invalid workspace name → refusal). It also owns the pair's small
   state machine (`enter`, `leave`, `slotClosing`, `parkedActivated`, `parkedMovedByUser`,
   `failed`). The host does the I/O, the nonce, the Firefox hooks and the `unload` path.
10. **`about:vimma`** gains one line, for example `Window manager: Hyprland 0.56.2 (lua), private
placement: swap`, or the reason it is `window`. It shows no addresses or titles.

## Test plan

- **Vitest** `hyprswap.test.mjs`:
  - The encoder: every verb in both dialects. A property test (fast-check) runs random
    addresses, ids, names and geometry through the planner. Each output command matches the
    whitelist pattern or the plan is a refusal, and no output contains a character outside
    `[A-Za-z0-9_.:,{}()= "\-]`. Bad addresses, `-1`, `+1`, `e+1`, names with quotes or brackets,
    and `special:` prefixes in user names are refused.
  - The parser: `j/clients` records keep no `title` or `initialTitle`. Events: `windowtitlev2`
    matches only the pending nonce, and the other variants parse. Malformed lines are ignored.
  - Dialect detection from `ok` and error replies, and batch reply splitting on `\n\n\n`.
  - Plans: tiled, floating, fullscreen (`fullscreen` 1 and 2, with the client state), floating
    to tiled and back, grouped or pinned → no swap, the slot window closing, the parked window
    activated, the user moving the parked window, failure handling.
  - The pair state machine: two normal windows, a second private window, pop-ups ignored.
  - `config.test.mjs`: `[private] placement` parses, defaults to `"swap"`, rejects other values,
    is schema 2. `defaults.test.mjs.snap` gains the key; the changelog line the rules ask for.
- **Mochitest** `browser_vimma_private_swap.js`, with a **fake Hyprland**: a
  `nsIServerSocket.initWithFilename` pair (`.socket.sock`, `.socket2.sock`) in a temp dir. A
  test-only hook in `HyprIpc` points at it; the environment is not changed. The fake keeps a
  small model (clients, workspaces, special workspaces), applies the commands it gets, records
  them, and emits `windowtitlev2` when a test window's title becomes a nonce (the test reads
  the chrome `document.title`). It covers:
  - Entering: one private window opens, and the fake ends with private on normal's workspace
    with normal's `at`/`size`, and normal in `special:vimma`. The recorded batch equals core's
    plan. No `win.focus()` was called on the parked window (spy).
  - Leaving by each route (toggle, `ctrl+^`, `ctrl+b )`, picker): the mirror image.
  - Fullscreen and floating normal windows; a grouped one (no swap, today's focus).
  - Closing the slot window three ways (`ctrl+shift+w`, `window.close()`, `ctrl+b shift+d`):
    normal is shown in its place, and the swap reply comes before the close for `ctrl+b shift+d`.
  - An external link (`BrowserContentHandler`'s `handURIToExistingBrowser` path, through
    `nsIBrowserDOMWindow.openURI` with `OPEN_EXTERNAL`) to the parked window swaps it back into
    the slot and parks the private window (decided question 2).
  - The fake moving the parked window away (`movewindowv2`) clears the pair, and the next entry
    starts fresh.
  - No Hyprland (no socket, a refused connection, a silent server, a server that errors on both
    probes): behaviour equals today's private-workspace mochitest, with one console line at most.
  - **No leaks:** every byte the fake received matches the whitelist and contains none of the
    private test page's title, URL or host. The profile directory holds no new file. The
    console has no line containing a fake event's title.
  - **Neutral title** (decided question 1): `privacy.exposeContentTitleInWindow.pbm` defaults
    to `false`, and a private window showing a page with a known title has the chrome
    `document.title` `Vimma Private Browsing`; with the pref set to `true`, the page title is back.
  - `[private] placement = "window"` with the fake present: no command is sent apart from the
    address resolution, which also stops.
- **e2e:** not in CI. Xvfb has no Hyprland, and the e2e harness's screenshot baselines assume
  none. Feasible later: a nested Hyprland (Hyprland runs as a Wayland client in a window) with
  a scripted config, if a headless Aquamarine backend proves usable. Not part of this spec.
- **By hand on Hyprland/Omarchy** (recorded in Results). On a scratch workspace, first confirm
  the Lua `swap` argument name (step 1 of the plan, a disposable pair of terminals, never the
  user's windows unasked). Then: dwindle with 1, 2 and 3 tiles (the other tiles keep their
  boxes, measured with `hyprctl clients -j` before and after), master layout, scrolling layout,
  a fullscreen and a maximized Vimma, a floating Vimma, a grouped Vimma, two monitors, a link
  from another app while private is shown, `SUPER+W` on the private window, `pkill -9` Vimma
  while normal is parked and then a restart, toggling `special:vimma` by hand, and how long
  the first open shows a split. If Hyprland's move animation is visible, record it. The fix
  (turning animations off for the two windows during the batch) is a follow-up, not a
  blocker.

## Docs

- `docs/guide.md`, "Private workspace": replace "It is a second window …" and the `SUPER+G`
  recipe with "On Hyprland the private workspace takes your Vimma window's place: same
  workspace, same tile, same size, fullscreen if it was. Your normal window waits in a hidden
  special workspace (`special:vimma`) and comes back when you switch back, when the private
  window closes, or when a link from another app arrives." Keep a short note: elsewhere (other
  compositors, X11, or `[private] placement = "window"`), it is a second window, as before. A
  grouped Vimma window keeps the group behaviour. Explain that Vimma talks to Hyprland over its
  socket with a fixed set of commands and sends no page titles or URLs. `config.toml`: the
  `[private] placement` key. "Privacy defaults": a row for the private window's title
  (`privacy.exposeContentTitleInWindow.pbm` = `false`; set it to `true` to show page titles).
- `docs/limits.md`: the private workspace is still a second window for the window manager. On
  Hyprland, Vimma hides the one you are not using. Hyprland's event stream and other tools
  still see both windows (`hyprctl clients`).
- README feature list: "Private workspace (on Hyprland it replaces the Vimma window in place)".
- `CHANGELOG.md` [Unreleased]: the maintainer adds it at merge time.

## Upstream patches

None. `createUnixDomainTransport`, `nsIServerSocket`, chrome `document.title`,
`Tabbrowser.updateTitlebar`, window `unload`/`activate`/`TabOpen` events and a pref default are
all usable from our own files. ADR-017 records the decision to talk to the window manager at all.

## Plan

1. Confirm the Lua `hl.dsp.window.swap` argument (`other`) and the legacy forms on a scratch
   workspace with two terminals. Record the result here.
2. Core `hyprswap.mjs` with Vitest (red, then green) and the config key.
3. `HyprIpc.sys.mjs` and the fake Hyprland. Then `private-swap.mjs` wired into
   `private-ops.mjs`'s `enterPrivate`, `leavePrivate`, `showNormal` and `closePrivate`, with the
   mochitest.
4. The pref default (decided question 1), `about:vimma`, docs, and the manual
   checks.

## Results

### Step 1: the Lua swap argument, checked live (2026-10-12)

On this machine (Hyprland 0.56.2, Lua config), with four throwaway `foot` terminals that the
check launched itself into two hidden special workspaces (`special:vimmatest` and
`special:vimmapark`, via `hl.dsp.exec_cmd(cmd, { workspace = "special:… silent" })`). The
user's windows, focus and visible workspace were never touched; the terminals were killed by
PID afterwards, and both special workspaces closed with them.

- `hl.dsp.window.swap({ window = "address:X", other = "address:Y" })` replies `ok` and swaps
  the two windows **without focusing either**. The `window` key works on swap, so the Lua plan
  needs no focus before the swap (the legacy `swapwindow` still acts on the focused window, so
  the legacy encoding focuses first).
- `hl.dsp.window.move({ workspace = "special:…", follow = false, window = … })`, `float({ action
= "enable" | "disable", window })`, `resize({ x, y, window })` (exact size), `move({ x, y,
window })` (exact position) and `fullscreen_state({ internal, client, window })` all reply `ok`
  and act on the named window.
- **Tiles keep their boxes** (dwindle, `preserve_split`): with two tiles and with three, the
  window moved in, swapped into a tile, and that tile's window parked: the new window had the
  parked one's exact `at`/`size`, and every other tile's box was the same as before. Swapping
  back left `j/clients` identical to the start, for each of the three slots.
- Batch replies are `ok` joined by `\n\n\n`. A swap with a missing window replies
  `warning: hl.window.swap: target window not found`, not `error:`; Vimma treats anything but
  `ok` as a failure.
- Not checked: the legacy dialect (this config is Lua), the master and scrolling layouts, and
  everything in the hand-check list below that needs a real Vimma window.

### Fix: the first swap never ran on a real desktop (2026-10-12)

`OpenBrowserWindow` returns the new window while it still shows the initial `about:blank`,
which has no `delayedStartupPromise`, so `enter()` did not wait and set the nonce title on that
document. On Wayland the title never reaches Hyprland. The private window's own `init` then
reused the same pending lookup, the lookup timed out, and `enter()` gave up without a word,
leaving the private window tiled beside the normal one. The fake Hyprland saw every window,
`about:blank` included, so the tests passed. Now the lookup waits for the window's
`browser-delayed-startup-finished` (or its close), the fake only sees a window once its browser
document is up, and a window Hyprland never names is logged once and shown in `about:vimma`.
Checked with a throwaway profile on Hyprland 0.56.2: enter, back, enter again and
`ctrl+b shift+d` each left the windows where the design says (normal in `special:vimma` while
private holds its slot, and the other way round).

## Out of scope

Other window managers (Sway, niri, KWin and GNOME have no comparable socket or need a different
design); per-tab private browsing (private-workspace.md option C); changing the user's Hyprland
config or adding window rules; showing both windows side by side on purpose (that is
`placement = "window"`); remembering the pair across a restart.

## Decided questions

1. **Neutral private window title:** yes. Vimma defaults `privacy.exposeContentTitleInWindow.pbm`
   to `false`, so the private window's title is only `Vimma Private Browsing`, never the page
   title, in the bar, screen-sharing pickers and Hyprland's event stream. It stays changeable in
   `about:config`, and the guide's "Privacy defaults" table lists it.
2. **A link from another app while the private workspace is shown:** Vimma swaps the normal
   window back into place, so the link shows at once, as Firefox's own focus would have done
   (decision 7). The private workspace stays parked and one key away.
