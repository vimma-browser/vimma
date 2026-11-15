# Spec: theme-appearance

Status: implemented · Area: `packages/vimma-core/src/` (`theme.mjs`, `config.mjs`,
`defaults.mjs`, `cmdline.mjs`, `actions.mjs`); `ui/theme-host.mjs`,
`omarchy/OmarchyHook.sys.mjs`, `host/VimmaHost.sys.mjs` (one runner), `about/`, `start/`.
No upstream patch, no new dependency. Builds on [m5-omarchy-theme](m5-omarchy-theme.md) and
[m5-core-config-and-theme](m5-core-config-and-theme.md).

## Goal

- A: installed on a Linux system without Omarchy, Vimma does not look for Omarchy.
- B: the built-in palette's appearance can be fixed or follow the system's setting, and a first-time
  user can change it easily from the keyboard.

## A. Omarchy only where Omarchy is

Today `[theme] source` defaults to `"omarchy"`, `theme-host.mjs` stats
`~/.local/state/omarchy/current/theme/colors.toml` every 2 s whether or not it exists, and
`OmarchyHook` checks `~/.config/omarchy/hooks` at every start. Core's `resolveTheme` also has an
"Omarchy theme not found" warning (the host never reached it: it passes `source = "file"` when it
has no file).

Checked on this machine (Omarchy 4, packaged): Omarchy lives in `/usr/share/omarchy`
(`$OMARCHY_PATH`), `~/.local/share/omarchy` is a symlink to it, and `omarchy-theme-set` keeps the
current theme in `~/.local/state/omarchy/current/theme` (`CURRENT_THEME_PATH`). Older, git-installed
Omarchy has `~/.local/share/omarchy` as a real directory. Both are under the user's `HOME`, which
is what makes a temp `HOME` a test fixture.

Decisions:

1. **Omarchy is installed** when `~/.local/share/omarchy` or `~/.local/state/omarchy` exists
   (either, following symlinks), or when `vimma.theme.omarchyPath` has a user value (an explicit
   path is an opt-in: tests, e2e, a theme kept elsewhere). `$OMARCHY_PATH` is not read: it is only
   set in sessions Omarchy starts, and the two directories cover every install.
2. **Checked once per process**, async, when the first window opens. Installing Omarchy later
   takes a restart. `ThemeHost.detectOmarchy(home)` runs the check again (tests only).
3. **Without Omarchy**: no poll timer and no `stat` at all; `OmarchyHook` does not look for
   `~/.config/omarchy/hooks` (it waits for the detection, then skips); the built-in palette
   applies; nothing the user sees says "Omarchy": `about:vimma` shows the source as `built in`
   and leaves out the Omarchy path and `colors.toml` rows; core's "Omarchy theme not found"
   warning is gone (a missing Omarchy is not a problem to report). The start page shows the
   `:theme` tip (B).
4. **With Omarchy**: unchanged. The poll, the hook, the "missing theme" rule all stay.
5. Also the same when `vimma.theme.source = builtin` or `[theme] source = "file"`: no timer runs
   while nothing would be read (today the timer ticked and returned).
6. **macOS** ([macos-build](macos-build.md)): the theme poll stops on macOS while Omarchy is
   absent, because this spec stops it on every platform. `about:vimma` does not say "Omarchy
   theme: not found" there (macos-build decision 11): no Omarchy wording off Omarchy, because a
   missing Omarchy is not a problem to report on a system that never had it.

## B. Built-in appearance: dark, light or the system's

The built-in `vimma` palette (`VIMMA_DARK` / `VIMMA_LIGHT`) follows `prefers-color-scheme`.

(Since changed: web pages now get the scheme an appearance or an Omarchy theme fixes, unless
Firefox's Website appearance is set; [content-color-scheme](content-color-scheme.md).)

Decisions:

1. **Config:** `[theme] appearance = "system" | "dark" | "light"` (schema 2, as `[theme] name`).
   `"system"` is today's behaviour: light or dark as the system or Firefox is, live. `"dark"` and
   `"light"` fix the built-in palette's variant: the sheet is one block, no `@media`.
   Validation: a string, one of the three, with the closest as suggestion. Not written in
   `defaults.toml` (only as a comment): left out, the setting is the pref below.
2. **How it relates to `[theme.colors] mode`:** `mode` is a palette override and applies to any
   source (an Omarchy palette too); when set it wins over `appearance`. `appearance` only picks
   the built-in palette's variant; it never changes an Omarchy theme, which decides its own
   (its `mode` key or `light.mode`). Tokyo Night has no light variant: it stays dark.
3. **`:theme`** (action `theme_appearance`, id `theme.appearance`, group Config, no default key):
   `:theme dark`, `:theme light`, `:theme system`; Tab completes the three. Bare `:theme` switches
   to the other of what shows now (dark ↔ light), the easiest first step. Applies at once in every
   window and start page.
4. **Persistence and "config always wins":** without `[theme] appearance` in `config.toml`,
   `:theme` stores the choice in the pref `vimma.theme.appearance` (default `"system"`; `system`
   clears it), so it survives restarts. With it, `config.toml` wins: `:theme` changes nothing and
   its notice says `config.toml sets [theme] appearance = "dark"; change it there`. With
   `[theme.colors] mode` set, the pref is stored but the notice says `mode` pins the colours.
   With an Omarchy theme showing, the pref is stored and the notice says the Omarchy theme is
   shown; the choice applies when the built-in palette does.
5. **Notices:** `theme: dark`, `theme: light`, `theme: system (light now)`; an unknown word is an
   error notice `theme: "blue" is not dark, light or system`.
6. **First-time discoverability, no which-key:** the start page's key hint line gains
   `:theme light/dark` while the built-in palette is in use (hidden when Vimma follows Omarchy);
   `about:vimma`'s Theme section shows `Appearance` (value, where it comes from, and how to
   change it). The guide's theming section is rewritten for non-Omarchy users first.
7. **Keymap footprint:** this change adds one row to `actions.mjs` and touches only the `[theme]`
   lines of `defaults.mjs`; `docs/bindings.md` and the snapshots are regenerated from them.

## Tests (written first)

- **Vitest** (`theme.test.mjs`, `config-v2.test.mjs`, `cmdline.test.mjs`):
  - without an Omarchy file there is no warning (was "Omarchy theme not found");
  - `appearance = "dark"` with `scheme: "light"` gives the dark tokens and the reverse; `"system"`
    (and absent) follows `scheme`; `[theme.colors] mode` wins over `appearance`; Tokyo Night with
    `"light"` stays dark; an Omarchy palette ignores `appearance`;
  - `themeStylesheet` with `"dark"` or `"light"` is one block, no `@media`;
  - an invalid `appearance` from a caller is an error at `theme.appearance` and `"system"` applies;
  - config: `appearance = "light"` parses and resolves to `"light"`; absent stays absent;
    `"lite"` suggests `"light"`; `1` is a type error; schema 1 says "new in schema 2";
    `defaults.toml` documents it as a comment and still parses;
  - `:theme light` runs `theme.appearance` with text `light`; `:theme ` completes
    `dark light system`.
- **Mochitest** `browser_vimma_theme_appearance.js` (no Omarchy fixture paths; it clears
  `vimma.theme.omarchyPath` and sets `vimma.theme.source=omarchy`):
  - detection against a temp `HOME` without Omarchy: `status.omarchy` false, no timer
    (`status.polling` false), source `built in`, the built-in palette shows; with
    `~/.local/share/omarchy` in the temp `HOME`: detected, polling;
  - `OmarchyHook.syncIfInstalled(home, false)` does not look for hooks without Omarchy;
  - `:theme light` under a dark desktop turns the bar light at once and sets the pref; `:theme`
    toggles back to dark; `:theme system` clears the pref and follows the desktop; a
    `[theme] appearance` from config wins (`setConfig`) and the notice says so; a bad word is
    an error notice;
  - the start page shows the `:theme` tip without Omarchy, not with it.
    Persistence across restarts is the pref (Firefox writes `prefs.js`); the e2e run below checks
    it with a real restart.
- **Screenshots** (real build, Xvfb, no Omarchy prefs): `:theme dark`, `:theme light`, the start
  page tip, about:vimma's Theme section; one run with `vimma.theme.omarchyPath` at
  `~/.local/share/omarchy/themes/ristretto`: the Omarchy colours win after `:theme light`.

## Results

- Vitest red: 17 failures (`:theme` unknown, no `appearance` key, the Omarchy warning still
  there, `defaults.toml` without the comment). Green: 2228/2228 in core, with the help-text and
  `defaults.toml` snapshots re-recorded (the `theme_appearance` row; the `[theme]` comments).
- Mochitest red: 10 failures (`ThemeHost.detectOmarchy is not a function`, the poll timer left
  running). Green: 35/35. Mutations: a timer that ignores the detection failed `no poll timer
runs` and `the poll stops`; the old about page failed the four about:vimma checks; reading
  "Omarchy shown" after setting the pref (whose observer resets it) lost the Omarchy notice.
  Full `tests/browser/` in a lane: 5445 passed before the last two tasks, 0 failed after the
  stale-warning fix (an Omarchy theme's contrast warnings stayed in `status` after the built-in
  palette applied; now reset).
- Screenshots (artifact build, Xvfb, no Omarchy prefs): `:theme dark` and `:theme light`, the
  completion list, the start page tip in both, the choice kept after a restart, about:vimma's
  Theme section; with `vimma.theme.omarchyPath` at Omarchy's ristretto theme, `:theme light`
  keeps ristretto's colours and says so, and the start page has no tip.
- The e2e baselines are unchanged: `m3-private-workspace` (a start page) differs by 0.38 % in
  CI with the tip, under the 0.5 % threshold.
