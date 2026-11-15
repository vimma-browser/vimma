# Spec: m5-config-load

Status: implemented · Milestone: M5 · Area: `src/browser/base/content/vimma/config/`
(new), `host/VimmaHost.sys.mjs`, `ui/theme-host.mjs`, `ui/help-overlay.mjs`, `ui/statusbar.mjs`,
`vimma.js`

The host half of M5's config, on top of core's `reloadConfig` and `formatConfigError`
([m5-core-config-and-theme](m5-core-config-and-theme.md), schema 2 in
[m3-m4-core-prep](m3-m4-core-prep.md)). Plan §6 M5 gate: "a broken config line shows file:line in
the status bar and the old config stays active". Plan §3: poll the file every 2 s; `:source`
forces a read.

## User stories

- As a user, I save `~/.config/vimma/config.toml` with `[keys] new_tab = "prefix+t"` and within
  2 seconds `ctrl+b t` opens a tab in every window, without a restart.
- As a user, a typo on line 3 shows `config.toml:3: keys.new_tabb: unknown action … (did you mean
"new_tab"?)` in red in the status bar; my previous config keeps working until I fix the line,
  and fixing it clears the message.
- As a user, `:source` reads the file at once.
- As a user, `[panes] max`, `[modal] hint_chars`, `[sites."<host>"] insert` and `[theme]`
  (source, font, colours) apply the same way.

## Design

`config/ConfigHost.sys.mjs`, one per app (a shared ES module), started by `vimma.js` for each
window after `VimmaHost` and `PaneViews`:

- **Path:** the pref `vimma.config.path` when set (`~/` expanded), else
  `$XDG_CONFIG_HOME/vimma/config.toml` when that variable is absolute, else
  `~/.config/vimma/config.toml`. Only that file is read; the folder is never listed (it also
  holds the profiles). Nothing is written to it but by `:config` when it is missing (below).
- **Reads:** at the first window (not awaited: windows start on the built-in keymap), every
  `vimma.config.pollMs` (2000, minimum 50) when `IOUtils.stat`'s `lastModified|size` changed,
  on `:source`, and when the path pref changes. One read at a time; `:source` during a running
  read queues one more. A missing file (also: removed between stat and read) is `""`: the
  defaults, silently.
- **Parse:** core `reloadConfig(active, text)`: all or nothing; on errors the previous config stays
  (before the first good read: the defaults).
- **Apply** (only when the active config changed):
  - `VimmaHost.configure({ keymap, hintChars, sites })`: new in this spec, additive. Each window
    drops a pending sequence, gets a new dispatcher on the keymap, and its `ctrl+b ?` overlay is
    rebuilt from it (`HelpOverlay.setKeymap`). Windows opened later start on it. `hintChars` goes
    to `startHints`; `sites` to `insertModeAfterFocus` through `matchSiteRule` on the focused
    browser's `currentURI.host` (no host: `auto`).
  - `PaneView.max` for each window (`[panes] max`); a new window gets it in `ConfigHost.init`.
  - `ThemeHost.setConfig(theme)`: `source = "file"` stops following Omarchy, as the
    `vimma.theme.source = builtin` pref does (either one suffices); `font` and `[theme.colors]`
    overlay both sources. Unchanged settings cost nothing; a change rechecks at once.
- **Errors:** `VimmaHost.configure({ configErrors })` after every read; `status()` returns them and
  the status bar passes them to core's existing `error` segment (`config.toml:N: …`, `N errors:
…` for several). All of them are logged once per change with the full path
  (`console.error`). A successful read clears them.
- **`:source`:** `RUNNERS["config.reload"]` notifies `vimma-config-reload`; ConfigHost observes
  it, so the host does not import ConfigHost (no import cycle).
- **Hermetic tests:** `tests/browser/browser.toml` sets `vimma.config.path` to a path that does
  not exist, so a developer's own config never rebinds keys under other tests.

## Tests (written first)

`tests/browser/browser_vimma_config.js` (a temporary `vimma.config.path`, `pollMs` 100):

- `[keys] new_tab = "prefix+t"` takes effect after the poll: `ctrl+b t` opens a tab, `ctrl+b c`
  no longer does.
- A broken line keeps the old mapping (`ctrl+b t` still opens a tab, the broken file's
  `prefix+y` does not); the status bar shows `config.toml:3:` with the suggestion; fixing the
  file clears it.
- With a 10-minute poll, `:source` loads the file.
- `schema = 2`, `[panes] max = 2`: the third split is refused (`at most 2 panes`), no tab opened;
  without the file the maximum is 4 again. (Since changed: 8 again, the new default (#691).)
- With an Omarchy fixture followed, `[theme] source = "file"` switches the status bar to the
  built-in Vimma palette (Tokyo Night with `name = "tokyo-night"`),
  `[theme.colors] dark_background` overrides it, and removing the file brings Omarchy back.

Red: the run before `ConfigHost.sys.mjs` existed crashed on `Missing chrome or resource URLs:
chrome://browser/content/vimma/config/ConfigHost.sys.mjs`. Green: 35 passed, 0 failed. Mutation:
not passing `[panes] max` to the pane view fails `panes_max_refuses_a_third_split`; reverted.

## Limits

- Up to 2 s latency (polling, plan §3). Two saves in the same millisecond with the same size
  are seen as one.
- `[workspaces]` applies live since M3 persistence (PR #59): `apply` passes it to
  `WorkspaceStore.setConfig`, which reconciles the definitions as `init()` does (a workspace
  removed from the file becomes runtime), creates containers, saves and notifies the windows.
- Only the first error is shown in the bar; `about:vimma` lists all of them and the theme's
  warnings ([m5-about-vimma](m5-about-vimma.md)).
- User overrides are marked `*` in `ctrl+b ?` (core's `bindingTable`; browser test
  `the_help_overlay_marks_and_lists_an_override`, added 2026-10-10). `:source <path>` and
  `:config` (open the file in a tab) came later (§ `:source <path>` and `:config`).
- Not covered by a browser test: `[modal] hint_chars` and `[sites]` (core tests cover their
  logic; the host only passes them through).

## `:source <path>` and `:config`

Status: implemented (2026-10-10). The plan says only "`:source`" and this
spec's Limits "`:config` (open the file in a tab)"; the choices below are ours.

- **`:source <path>` replaces, it does not merge.** The file is read and applied as
  config.toml is: whole, over the defaults, or not at all (core `reloadConfig`). Merging two
  files would need rules for `[keys]` lists, `[unbind]` and `[workspaces]` that the
  all-or-nothing check (conflicts across the whole file) cannot give. The file stays in force
  until config.toml's stat changes (the poll then reads config.toml) or a plain `:source`;
  `ConfigHost.path` names it meanwhile (about:vimma). It is not polled itself.
- **Paths:** core `resolveSourcePath`: `~`, `~/…`, `$HOME`, `$XDG_CONFIG_HOME` and their
  `${…}` forms expand at the start (an unset or relative `XDG_CONFIG_HOME` is `~/.config`);
  other variables and `~user` stay as typed; a relative path is next to config.toml; `.`/`..`
  resolve. One pair of quotes around the whole argument is dropped (cmdline's `unwrap`).
- **Errors:** as config.toml's, in the status bar's error segment, but named after the file
  (`VimmaHost.configure({ configFile })`): `work.toml: no such file` (a missing file is an
  error here; config.toml missing means the defaults), `work.toml: cannot be read`,
  `bad.toml:2: …`. The config in force stays. about:vimma formats them with
  `ConfigHost.errorsPath`.
- **`:config`** (action `config.edit`, `edit_config`): opens
  `view-source:file:///…/config.toml` in a new tab (view-source shows it as text, whatever
  type Firefox gives `.toml` over `file:`). When the file is missing it is first created, folders
  too, from core's `formatConfigTemplate()`: defaults.toml with every setting commented out
  and the table headers kept, so it means exactly the defaults (Vitest). This is the one
  write to the config folder; `IOUtils.writeUTF8(…, { mode: "create" })` never overwrites a
  file. A failure to create shows a notice (`VimmaHost.say`).

Tests: `config-source.test.mjs` (paths, the template), `cmdline.test.mjs` (`:source <path>`,
`:config`); `browser_vimma_config.js` `colon_source_a_path_replaces_the_config_and_reports_that_file`
and `colon_config_opens_the_file_and_creates_it_from_the_template`. Red: both browser tasks
timed out (`:source work.toml loads`; no new tab), the Vitest cases failed (`not a command`,
`formatConfigTemplate is not a function`). Green: config, theme and about 158/158; 19 repeats
of config and theme on two busy CPUs, 2241/2241. Mutation: dropping `sourced = null` in the
poll's read fails "config.toml is the file in force again"; reverted.

Issue #66 (`browser_vimma_theme.js` flaked in CI): a real race in `theme-host.mjs`. A check
reading the old Omarchy path when the path pref changed went on to record and apply that
theme and set `loaded`; the recheck then found the new path missing and, `loaded` being true,
kept the old theme for good (the CI failure: `no_omarchy_dir_means_tokyo_night`, now
`no_omarchy_dir_means_the_builtin_vimma`, timed out, then the poll timer was left running).
Fixed with a generation counter: a check started before `recheck()` drops what it read. New test
`a_path_change_during_a_check_is_not_undone_by_it` reproduces it deterministically (red with
the same three failures as CI, green after).
