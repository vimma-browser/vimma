# Spec: m5-omarchy-theme

Status: implemented, including instant reload · Area: UI (`src/browser/base/content/vimma/ui/theme-host.mjs`,
`vimma.js`, `ui/statusbar.mjs`, `start/start.mjs`)

The theme half of M5. `config.toml` loading and its `[theme]` table: [m5-config-load](m5-config-load.md).

## User story

As an Omarchy user, Vimma's chrome UI (status bar, command line, pickers, hints, notices, pane
borders, start page) has my current Omarchy theme's colours, and when I switch theme with
`omarchy-theme-set` every open window and start page follows within 2 seconds, with no restart
(at once through the theme-set hook Vimma installs, "Instant reload by default" below).
Without Omarchy I get the built-in palette (`[theme] name`, Vimma's own by default), and I can
force it.

## Scope

- **One theme host per app:** `ui/theme-host.mjs`, imported with `ChromeUtils.importESModule`
  (one module instance for all windows) and started from `vimma.js` with `ThemeHost.init(window)`
  before `VimmaHost.init`. It replaces the status bar's one-off Tokyo Night sheet (the only
  injection point): each window gets ONE author sheet (`windowUtils.loadSheetUsingURIString`, a
  `data:text/css` URI of `tokensToCss(tokens, ":root")`); on a change the new sheet is loaded and
  then the old one removed, so no frame lacks tokens. The status bar still loads `statusbar.css`.
- **Start page:** `start.mjs` (parent process, system principal) imports the same module and calls
  `ThemeHost.attachDocument(document)`: a `<style>` in the page's head, kept in a `WeakRef` set
  and rewritten on every change. `start.css`'s fallbacks cover the first paint.
- **Read:** `colors.toml` with `IOUtils.readUTF8` from the directory in `vimma.theme.omarchyPath`
  (default `~/.local/state/omarchy/current/theme`; `~` is `Services.dirsvc` `Home`), and whether
  `light.mode` exists; then core's `resolveTheme({ theme: { source: "omarchy", font: "monospace",
colors: {} }, omarchy, omarchyLightMode })` and `tokensToCss` (strict validation; nothing else
  reaches the sheet).
- **Startup never waits:** the module starts with the built-in palette's CSS (computed
  synchronously from core, no I/O); the first check runs async and swaps when it completes.
- **Poll:** every `vimma.theme.pollMs` (default 2000, a test knob) an async `IOUtils.stat` of
  `colors.toml` plus `IOUtils.exists(light.mode)`. The signature is the path, `lastModified`,
  `creationTime`, `size` and the light flag; the file is read only when it changes. The stat
  describes the file the path resolves to now, so `omarchy-theme-set`'s swap of `current/theme`
  (Omarchy 4 replaces the directory with `mv`; older setups use a symlink) changes it: no sync
  `realpath` on the main thread. One check at a time; a tick during a check is skipped. The
  timer stops when the last window closes.
- **Errors:** a file `resolveTheme` rejects keeps the last good theme; one `console.warn` listing
  each error with its line, and `vimma-theme-error` is notified. The signature is kept, so the
  same broken file is not re-read or re-logged. Contrast warnings go to `console.info`.
- **Missing theme:** no `colors.toml` means the built-in palette, unless an Omarchy theme was
  applied since startup or the last `vimma.theme.*` change: then the theme stays
  (omarchy-theme-set's `rm -rf` before its `mv` would otherwise flash the built-in palette for one
  poll).
- **Prefs:** `vimma.theme.source` = `omarchy` (default) or `builtin`; `vimma.theme.omarchyPath`.
  A change to either re-checks at once. `vimma-theme-changed` is notified after new tokens apply.
- **Hermetic tests:** `tests/browser/browser.toml` sets `vimma.theme.source=builtin` for the
  directory, so a developer's own Omarchy theme never reaches other tests' colour assertions;
  `browser_vimma_theme.js` turns it back on. The e2e harness gives the browser a `HOME` inside
  its temp profile and sets `vimma.theme.source=builtin` (`tools/e2e/launcher.mjs`; since
  changed: `launcher.ts`, ADR-025), so its baselines use the built-in palette.

## Tests (written first)

`tests/browser/browser_vimma_theme.js` (Linux only: `ln -s`), with hand-written Omarchy 4
`colors.toml` fixtures in a temp dir, `current/theme` a symlink, `vimma.theme.pollMs` = 100:

- the status bar's computed background is the fixture's `dark_background` (the
  `--vimma-statusbar-bg` source) and `--vimma-bg` its `background`;
- an open start page has the fixture's background and follows a rewrite;
- rewriting the file updates the bar within a few polls;
- a broken file (`dark_background = "not a colour"`) keeps the previous colours, also after more
  polls;
- `ln -sfn` of `current/theme` to another theme dir updates;
- a theme without a `mode` key and with `light.mode` gives `--vimma-color-scheme: light`;
- a path with no Omarchy theme gives the built-in palette (now Vimma's, `#070b0d`; Tokyo Night's
  `#13141c` when this was written), and back; `builtin` forces it.

Red (before the host existed): 4 of 5 tasks failed (`timed out` waiting for the fixture's
colours). Green: 11/11. Mutation check: dropping the `return` after a rejected file made
`broken_file_keeps_the_previous_colours` fail (`rgb(19, 20, 28)` instead of `rgb(24, 48, 24)`);
reverted. Full `tests/browser/` in a lane: 1843 expected, 0 unexpected.

Follow-up (2026-10-10, M5 polish): the `ctrl+b ?` overlay was the one surface still on system
colours. `help-overlay.css` now uses the picker's tokens (`--vimma-bg-dark` surface and sticky
header, `--vimma-fg` text, `--vimma-muted` border, `--vimma-accent` headings and focused filter,
`--vimma-color-scheme`), each with the old system colour as fallback. Two tasks,
`overlays_and_prompts_follow_a_{dark,light}_theme`, open the overlay, the `ctrl+b g` picker, the
`:` line and the `ctrl+b T` rename prompt under a dark and a light fixture and compare their
computed background and text with `--vimma-bg-dark` and `--vimma-fg`. Red: 8 failures, all the
overlay's (`rgb(255, 255, 255)` instead of `rgb(48, 16, 48)`; the picker, line and prompt already
passed). Green: 37/37. Mutation: the overlay's `color` back to `CanvasText` failed both text
assertions (`rgb(251, 251, 254)` vs `rgb(169, 177, 214)`); reverted. The e2e help baseline is
re-recorded from CI's image (the overlay is now Tokyo Night).

## Instant reload (2026-10-10)

Opt-in: a theme change shows as soon as `omarchy-theme-set` finishes, not at the next poll.

- **Why not a file watch:** Firefox 157 exposes none to chrome JS. `IOUtils`
  (`dom/chrome-webidl/IOUtils.webidl`) and `nsIFile` have no watch; no `.idl` names a watcher
  (Windows' `nsINativeFileWatcher` is long gone); the only `inotify`/`GFileMonitor` users are the
  sandbox's syscall tables and `widget/gtk/nsLookAndFeel` (GTK settings, internal). An inotify
  loop through js-ctypes would be a native call in a security-reviewed area for no gain over (b),
  so: no.
- **Mechanism (b):** checked on this machine (Omarchy 4): `omarchy-theme-set` swaps the theme
  directory (`rm -rf` + `mv`), retints its own apps in parallel, then runs `omarchy-hook theme-set
<name>`, which runs `~/.config/omarchy/hooks/theme-set` and each non-`.sample` file in
  `theme-set.d/` as `bash <file> <name>`. The hook (then `tools/omarchy/vimma-theme-reload.sh`,
  copied there by the user) ran `vimma-ctl --timeout 2 reload-theme`, silently, and always
  exits 0. Superseded by "Instant reload by default" below.
- **`reload-theme`** (control protocol v1, m0-control-protocol-and-vimma-ctl): authenticated like
  every command, no args. `ThemeHost.reload()` waits for a check in flight, clears the signature
  (so a same-size, same-mtime rewrite is read too) and runs one check; the response
  `{ changed }` comes after the new sheet is in every window. Nothing else changes: same path pref,
  same validation, the "missing theme" rule intact.
- **Fallback:** the 2 s poll stays. Without the socket (off by default), `vimma-ctl` on `PATH` or
  the hook, nothing changes.

Tests (written first). `browser_vimma_control.js` `test_reload_theme`: with `pollMs` an hour,
rewriting `colors.toml` and then a request before `hello`, a request after `hello` without
`auth`, and a wrong token leave the bar alone (each connection closed); an authenticated
`reload-theme` answers `{ changed: true }` and the bar has the new colour when the reply is read,
no waiting; again `{ changed: false }`; `args.path` is `invalid-args`. `test_vimma_ctl_end_to_end`
runs the real `vimma-ctl reload-theme` (`unchanged`). Vitest: the contract fixtures
(`request-`/`response-reload-theme`), the validator, and `tools/omarchy/test/theme-hook.test.mjs`
(Since changed: `theme-hook.test.ts`, ADR-025) (the hook run as `omarchy-hook` runs it, with a fake
`vimma-ctl` in a temp `HOME`). Cargo: CLI parsing, result decoding, an integration test against the
fake server.

Red: mochitest 4 failures (`"unknown-command" == "invalid-args"`, `"rgb(16, 24, 32)" ==
"rgb(48, 16, 48)"`, the results `undefined`); Vitest 5 (control) + 4 (hook, no script); cargo
did not compile (`no variant named ReloadTheme`). Green: control mochitest 258/258 with
`VIMMA_REQUIRE_CTL=1`, Vitest and cargo all pass. Mutation: `reload()` not awaiting its check
(`poll()` for `await poll()`) failed three assertions (`{"changed":false}` vs `true`, the bar
still `rgb(16, 24, 32)`); reverted.

## Instant reload by default

Instant reload is on by default, so a theme switch reaches Vimma with no setup. The control socket stays off by default (a loopback
TCP port any local user can reach); the hook uses Firefox's command-line remoting instead, which
is always on.

- **Remoting, checked in the 157.0.1 tree and on this machine:** `nsAppRunner` hands a second
  launch's command line to `nsRemoteService::StartClient`; on GTK with D-Bus it is
  `nsDBusRemoteClient`, which calls `OpenURL(ay)` on `org.mozilla.<app>.<base64 profile path>`,
  path `/org/mozilla/<app>/Remote`, interface `org.mozilla.<app>`; `<app>` is
  `GetDBusAppName()`, the lower-cased `Name` from `application.ini` (`vimma` in both builds; the
  artifact build's `firefox-bin` registered `org.mozilla.vimma.*` too, measured with
  `busctl --user list`). So a Vimma command line never reaches Firefox (`org.mozilla.firefox.*`)
  or another profile. `nsDBusRemoteServer` passes the buffer to
  `nsUnixRemoteServer::HandleCommandLine` (`[argc][argv offsets]<cwd>\0<argv>\0...`, LE u32), which
  runs every `command-line-handler` with `STATE_REMOTE_AUTO`. **`--no-remote` is a no-op in 157:**
  `nsAppRunner.cpp` strips it ("now unsupported"); only `--new-instance`/`MOZ_NEW_INSTANCE` skips
  the client, and the server starts in every run (a `--headless --no-remote` Vimma owned its
  D-Bus name). `npm start` drops the flag; nothing else changes for dev builds.
- **Handler:** `omarchy/OmarchyHook.sys.mjs` registers an `nsICommandLineHandler` at runtime, once
  per process, from `vimma.js` (`registerFactory` + category entry `l-vimma-reload-theme`,
  before `m-browser`), like about:vimma: no upstream patch and no `components.conf`, whose static
  registration an artifact build cannot add (it is compiled into libxul). It consumes
  `-vimma-reload-theme`, sets `preventDefault` (so `BrowserContentHandler` opens no window) and
  calls `ThemeHost.reload()`.
- **Not running:** a launch with the flag and no instance would start Vimma (the handler is
  registered after the first command line runs), so the hook never launches the binary: it lists
  `org.mozilla.vimma.*` names with `busctl --user list` and sends `OpenURL` with the encoded
  command line to each, i.e. every running Vimma profile, dev and test instances included (a
  reload with an unchanged file is a no-op). No name: nothing happens. Without busctl or a
  successful call it falls back to `vimma-ctl --timeout 2 reload-theme` (VIMMA_CTL or PATH),
  which needs the socket on. Silent, exit 0. Measured: a `vimma -vimma-reload-theme` client
  against the running instance returned in 38 ms.
- **Auto-install:** at startup, if `$HOME/.config/omarchy/hooks/` exists (omarchy-hook reads
  `$HOME`, not `XDG_CONFIG_HOME`), Vimma writes `theme-set.d/vimma-theme-reload.sh`, mode 0644,
  creating `theme-set.d` if needed; a last line `# Written by Vimma ... sha256:<hash of the
rest>` marks it. Same hash: Vimma's and unedited, kept up to date. Otherwise the user's: never
  written or removed. Written once per profile (`vimma.theme.omarchyHookInstalled`): a hook the
  user deletes stays deleted. `vimma.theme.omarchyHook` (default `true`) `false` removes the
  unedited hook, live, and clears that flag. Never at startup under automation
  (`Cu.isInAutomation`, mochitests) or in permanent private browsing; e2e runs have HOME inside
  the profile. Only failures are logged.
- **Gap:** between Firefox starting its remote server and the first window loading `vimma.js`
  (well under a second), a hook call would find no handler and open a window. A static
  `components.conf` registration would close it in full builds only.

Tests (written first). `browser_vimma_omarchy_hook.js`: `test_remote_reload_theme` runs the
category's handlers in order on a `STATE_REMOTE_AUTO` line (what `nsCommandLine::Run` does; it is
not scriptable): the flag is consumed, `preventDefault` set, no `domwindowopened`, the window and
tab counts unchanged (also 200 ms later), the bar shows the new colour. `test_installer` against
temp HOMEs: no Omarchy, missing (written, 0644), unchanged (not rewritten), an old unedited copy
(updated), an edited one (left alone, also on opt-out), opt-out (removed, then nothing), on again
(written), deleted by the user (not again), and startup blocked under automation. Vitest
`tools/omarchy/test/theme-hook.test.mjs` (Since changed: `theme-hook.test.ts`, ADR-025) with fake
`busctl`, `vimma-ctl` and `vimma`: the decoded `OpenURL` buffer to each `org.mozilla.vimma.*` name
only, no Vimma (no call, `vimma` never run), both fallbacks, silence and exit 0.
`tools/test/start.test.mjs`: no `--no-remote`. By hand, an artifact build with a temp HOME: the hook
appeared at startup; after a `colors.toml` change the installed hook (bus list narrowed to that
instance) made a following `vimma-ctl reload-theme` answer `unchanged` (a control round answered
`changed`), still one tab.

Red: Vitest 1 (no `busctl call`), `start.test.mjs` 1, the mochitest crashed (no module). Green:
Vitest 6/6 and 22/22, the mochitest 30/30. Mutation: without `preventDefault` the mochitest failed
(`and nothing else handles the line`, `still no window - 2 == 1`); reverted.

## Only where Omarchy is (2026-10-13)

[theme-appearance](theme-appearance.md) A: Omarchy is looked for once per process
(`~/.local/share/omarchy` or `~/.local/state/omarchy`, or a user-set `vimma.theme.omarchyPath`).
Without it there is no poll timer, no `stat` and no hook check; the timer also stops while the
source is forced built in. `~` in the path resolves against the HOME the detection used.

## Base-only colors.toml (2026-10-14)

Issue #266. Themes made before Omarchy's named palette, and generators that still write the
terminal's colours, ship a `colors.toml` with only `accent`, `foreground`, `background`,
`cursor`, `selection_foreground`, `selection_background`, `color0` to `color15` and border or tab
colours. Event Horizon (`oldjobobo/omarchy-event-horizon-theme`) is one. Vimma used to reject such a
file for its 17 missing keys and fall back to the built-in palette, so it stopped following the
desktop theme while every other Omarchy app followed it.

**Verified (Omarchy 4.0.0.alpha, `bin/omarchy-theme-color`, `resolve_theme_colors`).** Omarchy
itself accepts these files: it reads Omarchy's short names (`bg`, `fg`, `dark_bg`, …), then fills
each missing named key from an ANSI colour or derives it, and renders its templates from the
result. All 22 stock themes in that version ship the full named palette (`mode`, `accent`,
`selection`, `muted`, the background and foreground shades, the 8 colours and 6 bright ones);
`white`, `solitude` and `last-horizon` leave out `orange` and `brown`.

**Decision: derive what Omarchy derives, the same way.** The base set is `accent`, `background`,
`foreground`, `red`, `yellow`, `green`, `cyan`, `blue` and `magenta`, each by its name or by its
stand-in below. A file without one of them is rejected with
`missing key "red" (or its ANSI name "color1")`; an invalid value is rejected at its line under
the key the file used (`color2`, say). Omarchy derives no accent, so neither does Vimma. A named
key always wins over its stand-in. The reason for following Omarchy rule for rule: Vimma's chrome
then has the colours the terminal, the bar and the launcher already show.

| Key                                         | When the file leaves it out                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `background`, `foreground`                  | `bg` / `fg`, else `color0` / `color7`                                                                          |
| `red green yellow blue magenta cyan`        | `color1` to `color6` (`magenta` also `purple`)                                                                 |
| `bright_red green yellow blue magenta cyan` | `color9` to `color14` (`bright_magenta` also `bright_purple`), else the colour 20% toward white                |
| `light_foreground`                          | `light_fg`, else `foreground` (Omarchy sets `color7` to `foreground` first)                                    |
| `bright_foreground`                         | `bright_fg`, else `color15`, else `foreground`                                                                 |
| `dark_foreground`                           | `dark_fg`, else `color8`, else `foreground`                                                                    |
| `muted`                                     | `color8`, else `dark_foreground`                                                                               |
| `lighter_background`                        | `lighter_bg`, else `background` (Omarchy sets `color0` to `background` first)                                  |
| `dark_background`, `darker_background`      | `dark_bg` / `darker_bg`, else `background` 25% / 50% toward black                                              |
| `orange`                                    | `yellow`                                                                                                       |
| `brown`                                     | `dark_foreground`                                                                                              |
| `selection`                                 | `selection_background`, else `color8`, else `background`; then toward `background` (below)                     |
| `mode`                                      | `light` with a `light.mode` file, else `light` when `background`'s red + green + blue is over 382, else `dark` |

Two rules differ from Omarchy, each for a reason:

- **`selection`.** Omarchy takes `selection_background` as is: terminals draw
  `selection_foreground` on it. Vimma draws `foreground` (and `bright_foreground`) on a selected
  row, so the derived colour moves toward `background` in 5% steps until both reach 4.5:1
  (`MIN_CONTRAST`, [m7-a11y](m7-a11y.md)). Event Horizon's `#26bbd9` gives `#216577`: the same
  teal, at 5.02:1 under `#fadad1`. A `selection` the file names is kept as given, and the existing
  contrast warning still covers it.
- **`brown`** stays `dark_foreground`, Vimma's fallback before this change. Omarchy's
  (`orange` at 50% toward black) would recolour the resize badge of the three stock themes that
  leave `brown` out.

`mode` from the background's channel sum is Omarchy's own test for a theme that names no mode; a
light base-only theme without `light.mode` was otherwise drawn as dark.

Tests: `packages/vimma-core/test/theme.test.mjs`, "a colors.toml with only the base keys", with
`tests/contract/theme/event-horizon.colors.toml` (the file as Event Horizon ships it, comments
dropped): every derived key, no errors and no contrast warnings; a missing base key named with its
ANSI name; an invalid ANSI value at its line; named keys over stand-ins; short names and
`purple`; mode from the background. `a11y.test.mjs` runs every text token on every surface, the
badges and the focus colour for Event Horizon too. All 22 stock themes resolve to the same tokens
as before the change (compared one by one against the previous `theme.mjs`).

## Limits

- Without the hook (no Omarchy, opted out or deleted), up to 2 s latency per theme change
  (polling). With it, Vimma follows when
  Omarchy runs its hooks, which is after it has retinted its own apps (terminals restart first).
- Font, `[theme.colors]` overrides and `[theme] source = "file"` come with `config.toml` loading.
- Not covered: Hyprland's gaps, rounding and borders (docs/notes/omarchy-theming.md).
- Issue #66 (2026-10-10): a check still reading the old path when the path or source changed
  applied that theme afterwards; `recheck()` now bumps a generation and a stale check drops
  what it read (test `a_path_change_during_a_check_is_not_undone_by_it`; m5-config-load).

## Settled

- `.mjs` in `ui/`, not a `.sys.mjs`: it is only ever imported through `importESModule`, like
  `split/PaneView.mjs`, and relative imports of `../core/*.mjs` work there.
- No change to `VimmaHost.sys.mjs` (another spec owned it at the time).
