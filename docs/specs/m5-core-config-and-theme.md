# Spec: m5-core-config-and-theme

Status: implemented (core); host wiring in [m5-config-load](m5-config-load.md) · Milestone: M5 · Area: `packages/vimma-core`

## User stories

- As a user, I write `~/.config/vimma/config.toml` in Herdr syntax; a mistake on line 12 shows
  `config.toml:12: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)` and my
  previous config keeps working.
- As a user on Omarchy, vimma's chrome follows my Omarchy theme, dark or light; off Omarchy it is
  the built-in `[theme] name` palette; I can override single colours in `[theme.colors]`.
- As the host (M5 host spec), I hand `vimma-core` file contents as strings and get back a validated
  config, a compiled keymap, CSS tokens, and errors that carry file and line. Core does no I/O.

## Scope

`packages/vimma-core/src/`:

| Module                   | Exports                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/smol-toml/`      | smol-toml 1.9.0 parse path, vendored as one module (see Settled)                                                                                                            |
| `toml.mjs`               | `parseToml(text)` → `{ ok, value }` / `{ ok: false, error: { line, column, message } }`; `locateKeys(text)` → `lineOf(path)`; `formatPath`, `parsePath`                     |
| `config.mjs`             | `CONFIG_SCHEMA_VERSION`, `MIGRATIONS`, `migrate`, `parseConfig`, `mergeWithDefaults`, `reloadConfig`, `formatConfigError`                                                   |
| `theme.mjs`              | `THEME_TOKENS`, `PALETTE_KEYS`, `BADGES`, `TOKYO_NIGHT`, `MIN_CONTRAST`, `isHexColor`, `normalizeHex`, `parseOmarchyColors`, `resolveTheme`, `contrastRatio`, `tokensToCss` |
| `defaults.mjs` (changed) | `DEFAULT_CONFIG` gains `workspaces` and `theme`; `formatDefaultsToml` writes them                                                                                           |
| `keymap.mjs` (changed)   | `KeymapError` gains `detail` (the message without path and suggestion)                                                                                                      |
| `actions.mjs` (changed)  | `closest(text, pool)`: the edit-distance suggestion `suggestAction` already used, now shared                                                                                |

Contract fixtures: `tests/contract/config/v1/` and `tests/contract/theme/`, run by
`packages/vimma-core/test/contract.test.mjs`.

## Schema v1

Schema 2 (identity migration, adds `[panes]`, `[sites."<host>"]` and `[modal] hint_chars`) is
specified in [m3-m4-core-prep](m3-m4-core-prep.md).

Every key is optional. "Defaults" are `DEFAULT_CONFIG` (`defaults.toml` is generated from it).
Unknown keys anywhere in the schema are errors with the closest known key as suggestion.

| Key                             | Type                      | Default                                     | Validation                                                                                                                                              |
| ------------------------------- | ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                        | integer                   | absent = version 0                          | `0 ≤ schema ≤ 1`; higher: "from a newer vimma"                                                                                                          |
| `[keys] prefix`                 | key string                | `"ctrl+b"`                                  | `compileKeymap` (key notation)                                                                                                                          |
| `[keys] <action>`               | string or list of strings | `defaults.mjs`                              | `compileKeymap`: action name from `actions.mjs` (suggestion), notation, no sequence bound twice in a mode                                               |
| `[modal] leader`                | key string                | `" "`                                       | string; notation via `compileKeymap`                                                                                                                    |
| `[modal] timeout_ms`            | integer                   | `800`                                       | `0 ≤ n ≤ 10000`                                                                                                                                         |
| `[modal.<mode>] "<seq>"`        | action string             | `defaults.mjs`                              | `<mode>` ∈ `MODES` (suggestion); action and notation via `compileKeymap`                                                                                |
| `[unbind] <mode>`               | list of strings           | `[]`                                        | `<mode>` ∈ `MODES` (suggestion); notation via `compileKeymap`                                                                                           |
| `[workspaces] <name>`           | table                     | none                                        | name 1–32 characters, no control characters; order of the file = workspace order                                                                        |
| `[workspaces.<name>] color`     | string                    | `"gray"`                                    | Firefox container colour: `gray yellow orange red pink purple violet blue cyan green`; aliases `turquoise` → `cyan`, `toolbar` → `gray`                 |
| `[workspaces.<name>] icon`      | string                    | `"circle"`                                  | Firefox container icon: `fingerprint briefcase dollar cart vacation gift food fruit pet tree chill circle fence`                                        |
| `[workspaces.<name>] home`      | string                    | none                                        | `http://…`, `https://…` or `about:…`, no whitespace                                                                                                     |
| `[workspaces.<name>] autofill`  | boolean                   | `true`                                      | boolean                                                                                                                                                 |
| `[theme] source`                | string                    | `"omarchy"`                                 | `"omarchy"` (follow Omarchy's `colors.toml`, the built-in `name` when absent) or `"file"` (the built-in `name`)                                         |
| `[theme] name` (schema 2)       | string                    | `"vimma"`                                   | `"vimma"` (vimma.dev's colours, dark and light) or `"tokyo-night"` (suggestion); added after M5, see `BUILTIN_THEMES`                                   |
| `[theme] appearance` (schema 2) | string                    | absent (the pref `:theme` sets; `"system"`) | `"system"`, `"dark"` or `"light"` (suggestion): the built-in palette's variant; `[theme.colors] mode` wins; see [theme-appearance](theme-appearance.md) |
| `[theme] font`                  | string                    | `"monospace"`                               | 1–200 characters, none of `" ; { } \ < >` or control characters (it goes into CSS)                                                                      |
| `[theme.colors] <key>`          | hex colour string         | from the source palette                     | key ∈ `PALETTE_KEYS` (Omarchy's `colors.toml` keys; suggestion); `#rgb` or `#rrggbb`, stored as `#rrggbb` lowercase                                     |
| `[theme.colors] mode`           | string                    | source palette's                            | `"dark"` or `"light"`                                                                                                                                   |

Wrong types say what was expected and what was found (`expected a boolean, got a string`).
Config is parsed with integers as BigInt, so TOML floats (`1.0`, `1e3`) are told apart from
integers and rejected for `schema` and `timeout_ms`. An unknown key in `[modal]` is
`unknown key "leadr"` with the closest of the modes, `leader` and `timeout_ms`.
Keymap tables stay as the user wrote them in the resolved config: `compileKeymap` owns the merge
(a `[keys]` list replaces the default list; `[modal.<mode>]` entries merge per sequence).

`mergeWithDefaults(user, workspaceOrder?)` → `{ schema: 1, keys, modal, unbind, workspaces: Workspace[], theme }`,
where `Workspace = { name, color, icon, home?, autofill }` in file order and
`theme = { source, font, colors }`. No `[workspaces]` → `[]`; the host creates its default
workspace (M3). JS objects list number-like keys (`2`, `10`) first, so `parseConfig` passes
the order of the names' lines in the text.

## Errors with file:line

- `ConfigError = { line?, column?, path, message, suggestion? }`. `path` is the config path
  (`keys.new_tab[1]`, `modal.normal.j`, `modal.normal."<C-w>h"`, `workspaces.work.color`): bare
  keys plain, others JSON-quoted; empty for syntax errors.
- TOML syntax errors take line and column from smol-toml's `TomlError`. An unterminated array,
  inline table or string is reported where the parser notices it, which can be the next header or
  the end of the file; the message then ends with `(unclosed "[" opened at line N?)`.
- Schema and keymap errors are located by `locateKeys(text)`, a scanner over the
  (already syntactically valid) text that records the line of every key, array element and
  inline-table member. A path that is not in the file falls back to its nearest ancestor that
  is, e.g. the `[keys]` header. `compileKeymap` names actions canonically; a `[keys]` entry the
  user wrote as an alias (`prev_workspace`) is reported under that alias, in path and message.
- All schema errors are reported at once. `compileKeymap` throws on its first error, so at most
  one keymap error is reported, and only when the keymap tables passed the schema check.
- `formatConfigError(e, file)` → `config.toml:12:5: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)`;
  no line → `config.toml: …`.
- `parseConfig(text)` → `{ config, keymap, errors, migratedFrom }`; `config` and `keymap` are
  `null` whenever `errors` is non-empty: a config is valid as a whole or not at all.
- `reloadConfig(active, text)` → `{ active, errors, kept }`: on errors the previous `active`
  (config + keymap) is returned unchanged with `kept: true` (plan M5 gate: "the old config stays
  active"). With no previous config, `active` is the defaults.

## Migrations

- `MIGRATIONS` maps a version `n` to a pure function turning a v`n` object into a v`n+1` object.
- `migrate(raw, from, to = CONFIG_SCHEMA_VERSION, registry = MIGRATIONS)` applies each step in
  order and returns `{ config, applied: ["0→1", …] }`; a missing step throws. `from > to` throws.
- v0 (no `schema` key: configs written before M5) → v1 is the identity plus `schema = 1`.
- Every new version adds a fixture pair under `tests/contract/config/v<n>/` and a migration test
  (plan §5).

## Theme tokens

The palette is Omarchy's `colors.toml` vocabulary (`docs/notes/omarchy-theming.md`). Required:
`accent selection muted background dark_background darker_background lighter_background
foreground dark_foreground light_foreground bright_foreground red yellow green cyan blue magenta
bright_red bright_yellow bright_green bright_cyan bright_blue bright_magenta`. Optional: `mode`
(default `"dark"`; or `"light"` when the host reports a `light.mode` file), `orange` (else
`yellow`), `brown` (else `dark_foreground`). Other keys in an Omarchy file (`hyprland_*`,
`active_border_color`, …) are ignored; in `[theme.colors]` they are errors.
(Since changed: an Omarchy file now needs only the base set, `accent background foreground red
yellow green cyan blue magenta` or their ANSI stand-ins, and every other key is derived; the
rules are in [m5-omarchy-theme](m5-omarchy-theme.md), "Base-only colors.toml". `[theme.colors]`
keeps this list.)

| Token                                                  | From                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--vimma-color-scheme`                                 | `mode` (`dark` / `light`, for CSS `color-scheme`)                                                                                                                                                                        |
| `--vimma-font`                                         | `[theme] font` (CSS family list, quoted unless generic)                                                                                                                                                                  |
| `--vimma-bg`, `-bg-dark`, `-bg-darker`, `-bg-light`    | `background`, `dark_`, `darker_`, `lighter_background`                                                                                                                                                                   |
| `--vimma-fg`, `-fg-dim`, `-fg-light`, `-fg-bright`     | `foreground`, `dark_`, `light_`, `bright_foreground`                                                                                                                                                                     |
| `--vimma-accent`, `--vimma-muted`, `--vimma-selection` | same-named keys                                                                                                                                                                                                          |
| `--vimma-focus`                                        | `accent`, moved toward black or white until 3:1 on every focus surface (m7-a11y)                                                                                                                                         |
| `--vimma-<colour>` (8), `--vimma-bright-<colour>` (6)  | the ANSI colours                                                                                                                                                                                                         |
| `--vimma-error`, `--vimma-warning`, `--vimma-success`  | `red`, `yellow`, `green`                                                                                                                                                                                                 |
| `--vimma-statusbar-bg`, `--vimma-statusbar-fg`         | `dark_background`, `foreground`                                                                                                                                                                                          |
| `--vimma-hint-bg`, `--vimma-hint-fg`                   | `yellow`; the better-contrast of `background` / `foreground`                                                                                                                                                             |
| `--vimma-mode-<m>`, `--vimma-mode-<m>-fg`              | badge per mode: normal `accent`, insert `green`, visual `magenta`, command `yellow`, hint `orange`, help `cyan`, panel `blue`, resize `brown`, prefix `red`; `-fg` is the better-contrast of `background` / `foreground` |

Picking badge text by contrast is what makes one rule work for light and dark themes.

(Since changed: a badge whose slot gives a colour within delta E 10 of an earlier badge's takes
that colour a shade lighter or darker; `badgeColors` in `theme.mjs` and the guide's Status bar
section describe it now.)

- `TOKYO_NIGHT`: identical to Omarchy's stock tokyo-night `colors.toml`; the built-in palette
  until `VIMMA_DARK` / `VIMMA_LIGHT` (vimma.dev's colours) replaced it as the default.
  `BUILTIN_THEMES` maps `[theme] name` to `{ dark, light? }`.
- `resolveTheme({ theme, omarchy?, omarchyLightMode?, scheme? })` →
  `{ tokens, mode, errors, warnings, adaptive }`. Base: Omarchy text when `source = "omarchy"`
  and the host found the file, else the built-in `name`, its light variant when `scheme` is
  `"light"` (or `[theme.colors] mode` or `[theme] appearance` pins it) and it has one. No
  warning when `source = "omarchy"` but no file ([theme-appearance](theme-appearance.md) A). `[theme.colors]` overlays the base for both sources. An
  invalid Omarchy file → errors with `colors.toml` lines and the built-in base; the host keeps
  the previous tokens on errors, as for config.
- `themeStylesheet({ theme, omarchy?, omarchyLightMode?, selector? })` → `{ css, errors,
warnings }`: what the host injects; an adaptive built-in adds its light tokens under
  `@media (prefers-color-scheme: light)`, so it switches with the browser, live.
- `isHexColor`: `#rgb` / `#rrggbb`, case-insensitive; no alpha (contrast needs opaque colours).
- `contrastRatio(a, b)`: WCAG 2.x, `(L1 + 0.05) / (L2 + 0.05)` with sRGB relative luminance.
  `resolveTheme` warns for each pair under 4.5:1: `fg`/`bg`, `fg`/`selection`,
  `statusbar-fg`/`statusbar-bg`, `hint-fg`/`hint-bg`, each mode badge. `fg-dim` and `muted` are
  deliberately low-contrast and not checked.
- `tokensToCss(tokens, selector = ":root")` → a CSS rule string the host injects. It throws
  `TypeError` on any value `resolveTheme` could not have produced (names `--vimma-[a-z0-9-]+`,
  values `#rrggbb`, `dark`/`light`, or a font list of CSS strings and generic families) and on a
  selector containing `{ } ;`. `resolveTheme` validates `[theme.colors]` again (unknown key,
  bad mode, non-hex → error, entry dropped) and escapes the font into CSS strings, so neither
  trusts that its input came through `parseConfig`.

## Tests (write first)

`config.test.mjs`, `toml.test.mjs`, `theme.test.mjs`, `contract.test.mjs`:

- Given the generated `defaults.toml`, when parsed, then no errors and the keymap equals `compileKeymap()`'s.
- Given an empty file, then the config is the defaults and `migratedFrom` is 0.
- Given `schema = 1` and `[keys] new_tabb = ["prefix+c"]` on line 3, then one error at line 3,
  path `keys.new_tabb`, suggestion `new_tab`, formatted `config.toml:3: keys.new_tabb: …`.
- Given a TOML syntax error on line 4, then one error with line 4 and its column, and `config` is null.
- Given `schema = 2`, then an error "newer vimma" at the `schema` line.
- Given `[modal] timeout_ms = -5` / `"800"` / `20000`, then a range or type error at that line.
- Given `[modal.nromal]`, then an error suggesting `normal`.
- Given `[keys] new_tab = ["prefix+c",` newline `"ctrl+bogus"]`, then the error is on the second line.
- Given `[workspaces] work = { color = "blu" }`, then an error at that line suggesting `blue`;
  `turquoise` is accepted and stored as `cyan`; workspace order is file order.
- Given `home = "javascript:alert(1)"`, `autofill = "no"`, `icon = "star"`, an empty or 33-character name, then errors.
- Given `[theme] source = "omarchy-ish"`, `font = "x; color: red"`, then errors.
- Given `[theme.colors] acent = "#fff"` / `accent = "blue"`, then a suggestion / a hex error.
- Given a top-level `[thmee]`, then an error suggesting `theme`.
- Given `new_tab = ["prefix+n"]` (taken by `next_tab`), then the error is on the user's line.
- Given the alias `prev_workspace` in a conflict, then the error is `keys.prev_workspace` on its
  own line, and the message never says `previous_workspace`.
- Given workspaces `work`, `2`, `"1"`, `[workspaces.10]`, then that order, not `1, 2, 10, work`.
- Given `schema = 1.0` or `timeout_ms = 1e3`, then a float error.
- Given an array left open before `[theme]`, then the error hints at the line that opened it.
- Given an active config and broken text, when `reloadConfig`, then `kept` and the old keymap stays.
- Given valid text, when `reloadConfig`, then the new config is active.
- `migrate` applies a registered chain (`0→1→2` with a test registry) in order; a gap throws;
  `from > to` throws; v0 → v1 adds `schema = 1` and keeps everything else.
- Contract: `tests/contract/config/v1/valid.toml` parses clean; each `invalid-*.toml` yields
  exactly the errors in `expected-errors.json` (line, path).
- Theme: Tokyo Night fixture → `--vimma-bg = #1a1b26`, `--vimma-accent = #7aa2f7`, no warnings;
  a light fixture → `--vimma-color-scheme = light` and badge text dark; missing `orange` falls back
  to `yellow`; `#xyz`, `#12345`, `rgba(…)` are not hex; `#FFF` normalises to `#ffffff`;
  `contrastRatio("#000", "#fff") = 21`, `("#777", "#fff") < 4.5` gives a warning naming both tokens;
  an Omarchy file with an invalid colour gives an error at its line and the built-in palette's
  tokens; `source = "omarchy"` with no file uses the built-in palette without a warning;
  `[theme.colors]` overlays Omarchy;
  `omarchyLightMode` makes a palette without `mode` light; `tokensToCss` emits every token once.
- `toml-conformance.test.mjs`: valid and invalid TOML documents per feature (strings, numbers,
  dates, arrays, tables, inline tables, arrays of tables, comments, line endings, nesting limit),
  each invalid one failing on the expected line. We own the vendored copy, so we test it.
- Injection: `resolveTheme` with `accent = "red; } * { … } :root {"` gives an error and the
  built-in palette's accent; a hostile font stays inside one CSS string; `tokensToCss` rejects
  hostile names, values and selectors (called directly).
- Coverage ≥ 90 % lines/branches/functions on our `packages/vimma-core` modules. `vendor/` is
  excluded from the gate (third-party; an upstream update must not move our gate) and covered
  by the conformance tests instead.

## Out of scope: the M5 host spec

File I/O, `~` expansion, mtime polling, `:source`, the status-bar error indicator, `about:vimma`,
injecting CSS, creating containers from `[workspaces]`, the Omarchy `theme-set.d` hook. The host:

- reads `~/.config/vimma/config.toml` (missing file = `""`), calls `reloadConfig(active, text)`
  at startup, on mtime change and on `:source`; swaps the dispatcher's keymap only when `!kept`;
- shows `formatConfigError(errors[0], path)` in the status bar and all errors in `about:vimma`;
- reads `~/.local/state/omarchy/current/theme/colors.toml` (and whether `light.mode` exists) when
  `theme.source = "omarchy"`, polls its mtime with the config, calls `resolveTheme`, and injects
  `tokensToCss(tokens)` unless there are errors (then keeps the previous tokens and reports them);
- surfaces `warnings` (contrast, Omarchy theme missing) in `about:vimma`, not the status bar;
- copies `packages/vimma-core/src/vendor/smol-toml/LICENSE` into `about:license` or an equivalent
  third-party notice when release packaging is built (M6). Done (issue #16): `about:license` lists
  it from `src/browser/base/content/vimma/licence/body.html` (ADR-012, Consequences).

## Settled (2026-10-09)

**TOML parser: smol-toml 1.9.0, BSD-3-Clause, vendored.** Candidates:

| Package             | Licence      | TOML                | Size (parse path)                        | Errors                       | Notes                                           |
| ------------------- | ------------ | ------------------- | ---------------------------------------- | ---------------------------- | ----------------------------------------------- |
| `smol-toml` 1.9.0   | BSD-3-Clause | 1.1, full toml-test | 7 ESM files, 45 KB                       | `line`, `column`, code block | no dependencies, maintained, provenance on npm  |
| `toml` 5.0.0        | MIT          | 1.1, 99 % toml-test | 113 KB generated Peggy parser + compiler | `line`, `column`             | CommonJS: would need converting, twice the size |
| `@iarna/toml` 2.2.5 | ISC          | 1.0.0-rc.1          | ~60 KB, CommonJS                         | `line`, `col`                | unmaintained since 2020                         |

- Licence check: BSD-3-Clause is on the project allowlist (`tools/license-check`), compatible
  with MPL-2.0; its terms (keep the notice) are met by the unmodified licence headers in every
  vendored file plus `vendor/smol-toml/LICENSE`. ADR-008 said "MIT"; ADR-012 amends that to
  "permissive (MIT/BSD/ISC)" and names smol-toml. It is source in the repo, not an npm dependency, so `package-lock.json` and
  `license-check` are unchanged.
- 1.9.0, not 1.9.1: 1.9.1 was published the same day; we take the release with two weeks in the
  wild. npm integrity of the tarball: `sha512-hpd+HLON7HdZXqYchMM/+LaTTbdK0AU3NngIJ4KVyWbY9bfQqdL9cD+4yf6dUoU2Ap4VsU0JkQi6FxAI1B2mXQ==`.
- Vendored as one file, `vendor/smol-toml/smol-toml.mjs`, generated by
  `tools/vendor-smol-toml.mjs` from the tarball: `dist/{error,date,util,primitive,struct,extract,parse}.js`
  joined in dependency order with their relative imports removed; `stringify` and `index` left
  out; code otherwise unchanged. One file because `surfer license-check` (CI) wants an MPL header
  on every file in `src/` and accepts other licences only through its
  `// Ignore license in this file` marker, whose global regex keeps state between files, so it
  is reliable for one such file per run; the marker is the file's last line. `sync-core` copies
  only `.mjs` into the chrome tree (what `jar.mn` packs), so `LICENSE`, `README.md` and our
  `smol-toml.d.mts` stay in `packages/`. The `.d.mts` keeps `tsc` off upstream code; prettier
  skips the file; eslint runs on it with the purity rules and only `no-cond-assign` /
  `no-useless-assignment` off for `vendor/` (upstream style).
- Line numbers: smol-toml reports them only for syntax errors; the parsed object carries no
  positions. Hence `locateKeys` (see Errors). It assumes valid TOML, which `parseToml` has
  checked first.
- Omarchy fixture: `/usr/share/omarchy` ships no licence file (the upstream repo is MIT, but the
  installed copy does not say so), so `tests/contract/theme/*.toml` are written by hand in the same
  format. The Tokyo Night values are the public Tokyo Night palette.
- Firefox container colours and icons from
  `toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs` (157.0.1).
