# Omarchy theming: how it actually works

Researched 2026-10-09 on Omarchy 4 ("quattro"), from the installed scripts in
`/usr/share/omarchy/bin/` and the
[manual's theme page](https://learn.omacom.io/2/the-omarchy-manual/92/making-your-own-theme).
Input for the M5 theme spec. Re-check the scripts before relying on details; Omarchy moves fast.

## Where the theme is

- Current theme: `~/.local/state/omarchy/current/theme/`. (Older Omarchy used
  `~/.config/omarchy/current/theme`; that path no longer exists.)
- Stock themes: `/usr/share/omarchy/themes/<name>/`; user themes: `~/.config/omarchy/themes/<name>/`.
- `omarchy-theme-current` prints the theme name; `omarchy-font-current` prints the system font.

## `colors.toml`

Every theme ships one. Hex `#rrggbb` only. Keys (a stock dark theme shown):

```toml
mode = "dark"            # or "light"; light themes may also ship an empty light.mode file
accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"
red = "#f7768e"          # also yellow orange green cyan blue magenta brown
bright_red = "#ff7a93"   # also bright_yellow bright_green bright_cyan bright_blue bright_magenta
```

These map one-to-one onto Vimma's CSS custom properties (`--vimma-accent`, `--vimma-bg`, …).

## How apps follow theme changes

- **Templates:** `omarchy-theme-set-templates` renders `*.tpl` files from
  `/usr/share/omarchy/default/themed/` and the user's `~/.config/omarchy/themed/` into the theme dir,
  replacing `{{ key }}` (hex) and `{{ key_rgb }}` (`r,g,b`). This is how Obsidian, VS Code and
  Chromium get themed.
- **Hook:** files in `~/.config/omarchy/hooks/theme-set.d/` (and a single
  `~/.config/omarchy/hooks/theme-set`) run after every theme switch, with the theme name as `$1`.
  Checked on Omarchy 4 (2026-10-10): `omarchy-theme-set` ends with `omarchy-hook theme-set
<name>`, which runs each non-`.sample` file as `bash <file> <name>` (so no exec bit needed),
  after the theme directory swap and after the parallel app retints (`omarchy-restart-terminal`,
  `omarchy-theme-set-browser`, …), with its output discarded.
- **Chromium/Brave:** set by browser policy (`omarchy-theme-set-browser`), accent colour only.
- **Firefox prior art:** [Omafox](https://addons.mozilla.org/en-US/firefox/addon/omafox/)
  ([source](https://github.com/cover/omafox), MIT): a WebExtension plus an AUR native-messaging
  host that syncs Firefox/Zen colours with the current theme.

## Decision for Vimma (answers plan §9)

Read `colors.toml` directly with the TOML parser from ADR-008 and poll its mtime with the config
reload (plan §3). Nothing to install, works for every theme, stock or user. A `theme-set.d` hook
gives instant refresh: Vimma installs `vimma-theme-reload.sh` itself, which sends
`-vimma-reload-theme` over Firefox's D-Bus command-line remoting, with `vimma-ctl reload-theme` as
the fallback (spec m5-omarchy-theme, "Instant reload by default"; opt out with
`vimma.theme.omarchyHook`).

## Not covered by Omarchy

No published guidance on fonts, corner radius, borders or gaps for third-party apps. The nearest
source of truth is the user's Hyprland config (`general:gaps_*`, `decoration:rounding`,
`general:border_size`); mirror those if Vimma should feel native.
