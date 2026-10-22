/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Theme tokens: CSS custom properties from a palette in Omarchy's colors.toml vocabulary.
 * See docs/specs/m5-core-config-and-theme.md § Theme tokens. The host applies them.
 */
import { trimBlanks } from "./strings.mjs";
import { formatPath, locateKeys, parseToml } from "./toml.mjs";

/** @typedef {Record<string, string>} Palette  PALETTE_KEYS → "#rrggbb", plus mode */
/** @typedef {Record<string, string>} Tokens   "--vimma-*" → CSS value */

/**
 * @typedef {object} ThemeError
 * @property {number} [line]
 * @property {number} [column]
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {object} ThemeToken
 * @property {string} name          CSS custom property
 * @property {string} [from]        palette key the value comes from
 * @property {string} [textOn]      token this one is text on: the value is picked for contrast
 * @property {boolean} [readable]   text on every SURFACE_TOKENS: `from`, moved toward black or
 *   white just far enough to reach MIN_CONTRAST on each (spec m7-a11y)
 * @property {boolean} [focus]      a focus indicator: `from`, moved toward black or white just
 *   far enough to reach MIN_FOCUS_CONTRAST on every FOCUS_SURFACE_TOKENS
 * @property {boolean} [badge]    a status-bar badge: `from`, unless an earlier badge already
 *   has that colour (badgeColors)
 * @property {string} description
 */

/** Keys of an Omarchy 4 colors.toml, in its file order (docs/notes/omarchy-theming.md). */
export const PALETTE_KEYS = Object.freeze([
  "mode",
  "accent",
  "selection",
  "muted",
  "background",
  "dark_background",
  "darker_background",
  "lighter_background",
  "foreground",
  "dark_foreground",
  "light_foreground",
  "bright_foreground",
  "red",
  "yellow",
  "orange",
  "green",
  "cyan",
  "blue",
  "magenta",
  "brown",
  "bright_red",
  "bright_yellow",
  "bright_green",
  "bright_cyan",
  "bright_blue",
  "bright_magenta",
]);

/**
 * The base set: the colours a colors.toml must give, by name or by its ANSI stand-in
 * (BASE_ALIASES). Omarchy derives none of them either; every other key is derived from these.
 */
const BASE_KEYS = Object.freeze([
  "accent",
  "background",
  "foreground",
  "red",
  "yellow",
  "green",
  "cyan",
  "blue",
  "magenta",
]);

/**
 * Names that stand in for a missing palette key, first match wins: Omarchy's short names, then
 * the ANSI colours of themes made before its named palette (omarchy-theme-color,
 * resolve_theme_colors, Omarchy 4.0.0.alpha; docs/specs/m5-core-config-and-theme.md).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const BASE_ALIASES = Object.freeze({
  background: ["bg", "color0"],
  foreground: ["fg", "color7"],
  dark_background: ["dark_bg"],
  darker_background: ["darker_bg"],
  lighter_background: ["lighter_bg"],
  dark_foreground: ["dark_fg", "color8"],
  light_foreground: ["light_fg"],
  bright_foreground: ["bright_fg", "color15"],
  muted: ["color8"],
  red: ["color1"],
  green: ["color2"],
  yellow: ["color3"],
  blue: ["color4"],
  magenta: ["color5", "purple"],
  cyan: ["color6"],
  bright_red: ["color9"],
  bright_green: ["color10"],
  bright_yellow: ["color11"],
  bright_blue: ["color12"],
  bright_magenta: ["color13", "bright_purple"],
  bright_cyan: ["color14"],
});

/** Every key parseOmarchyColors reads, so validates: the palette, its stand-ins, the terminal's
 * selection colour. */
const READ_KEYS = Object.freeze([
  ...new Set([
    ...PALETTE_KEYS.filter((k) => k !== "mode"),
    ...Object.values(BASE_ALIASES).flat(),
    "selection_background",
  ]),
]);

/**
 * Vimma's own palette, dark: vimma.dev's colours (assets/css/site.css in vimma-browser/vimma-site).
 * Mint is the accent (the normal-mode badge, focus) and the link hints; body text stays the
 * site's grey-green. Keys marked "derived" have no colour on the site: each is picked to sit with
 * the site's yellow, red and greens at about their lightness and saturation.
 * @type {Readonly<Palette>}
 */
export const VIMMA_DARK = Object.freeze({
  mode: "dark",
  accent: "#1bf587", // --accent, the mint
  selection: "#163327", // --selection
  muted: "#2a3d36", // --border
  background: "#0a0f12", // --bg
  dark_background: "#070b0d", // --bg-dark
  darker_background: "#040708", // --bg-darker
  lighter_background: "#111a1b", // --bg-light
  foreground: "#c4cec8", // --fg, the grey-green body text
  dark_foreground: "#849690", // --fg-muted
  light_foreground: "#e0e4df", // derived: halfway from --fg to --fg-bright
  bright_foreground: "#fcfbf7", // --fg-bright, the wordmark
  red: "#ff6b6b", // --red
  yellow: "#f2c94c", // --yellow
  orange: "#f59e5b", // derived: between --yellow and --red
  green: "#8eeeb8", // --green
  cyan: "#5fd7c9", // derived: a sea-green teal next to the mint
  blue: "#6cb4ee", // derived: a soft sky blue
  magenta: "#c79bf0", // derived: a soft violet
  brown: "#a67c52", // derived: a warm tan, for the resize badge
  bright_red: "#ff8f8f", // derived: --red, lighter
  bright_yellow: "#ffdd7a", // derived: --yellow, lighter
  bright_green: "#1bf587", // --mint: the link hints
  bright_cyan: "#8af0e2", // derived: cyan, lighter
  bright_blue: "#9ccdff", // derived: blue, lighter
  bright_magenta: "#dcb8ff", // derived: magenta, lighter
});

/**
 * Vimma's own palette, light: vimma.dev under prefers-color-scheme: light. The accent is the
 * site's deep green; the hints keep the mint, with dark text on it.
 * @type {Readonly<Palette>}
 */
export const VIMMA_LIGHT = Object.freeze({
  mode: "light",
  accent: "#056a39", // --accent
  selection: "#c6efd8", // --selection
  muted: "#a3b0a9", // --border
  background: "#f5f4ef", // --bg
  dark_background: "#eae9e2", // --bg-dark
  darker_background: "#e1e0d8", // --bg-darker
  lighter_background: "#fcfbf7", // --bg-light
  foreground: "#1d2924", // --fg
  dark_foreground: "#4b5a53", // --fg-muted
  light_foreground: "#34413b", // derived: halfway from --fg to --fg-muted
  bright_foreground: "#0a0f12", // --fg-bright
  red: "#a1232d", // --red
  yellow: "#7a5200", // --yellow
  orange: "#9a4500", // derived: between --yellow and --red
  green: "#2a5a40", // --green
  cyan: "#0b5c4e", // --accent-2, the site's teal
  blue: "#1f5f99", // derived: a deep blue at --green's depth
  magenta: "#7b3f99", // derived: a deep violet
  brown: "#6b4a2b", // derived: a dark tan
  bright_red: "#c2303b", // derived: --red, brighter
  bright_yellow: "#946400", // derived: --yellow, brighter
  bright_green: "#1bf587", // --mint: the link hints
  bright_cyan: "#0e7666", // derived: cyan, brighter
  bright_blue: "#2b70b5", // derived: blue, brighter
  bright_magenta: "#9150b3", // derived: magenta, brighter
});

/** Omarchy's stock tokyo-night colors.toml, built in as `[theme] name = "tokyo-night"` (dark). */
/** @type {Readonly<Palette>} */
export const TOKYO_NIGHT = Object.freeze({
  mode: "dark",
  accent: "#7aa2f7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  light_foreground: "#b4bee6",
  bright_foreground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  orange: "#eb927b",
  green: "#9ece6a",
  cyan: "#449dab",
  blue: "#7aa2f7",
  magenta: "#ad8ee6",
  brown: "#75493d",
  bright_red: "#ff7a93",
  bright_yellow: "#ff9e64",
  bright_green: "#b9f27c",
  bright_cyan: "#0db9d7",
  bright_blue: "#7da6ff",
  bright_magenta: "#bb9af7",
});

/**
 * @typedef {object} BuiltinTheme
 * @property {Readonly<Palette>} dark
 * @property {Readonly<Palette>} [light]  with one, the theme follows prefers-color-scheme
 */

/** The built-in palettes, by `[theme] name`. */
/** @type {Readonly<Record<string, Readonly<BuiltinTheme>>>} */
export const BUILTIN_THEMES = Object.freeze({
  vimma: Object.freeze({ dark: VIMMA_DARK, light: VIMMA_LIGHT }),
  "tokyo-night": Object.freeze({ dark: TOKYO_NIGHT }),
});

/** `[theme] name` by default. */
export const DEFAULT_THEME_NAME = "vimma";

/**
 * `[theme] appearance` (docs/specs/theme-appearance.md): the built-in palette's variant. "system"
 * follows prefers-color-scheme, live; "dark" and "light" fix it. Omarchy themes decide their own.
 * @typedef {"system" | "dark" | "light"} Appearance
 */
/** @type {readonly Appearance[]} */
export const APPEARANCES = Object.freeze(/** @type {Appearance[]} */ (["system", "dark", "light"]));

/**
 * Tokens a built-in takes from another palette key than THEME_TOKENS says: vimma's link hints
 * are the mint (bright_green), as on vimma.dev, where an Omarchy theme's are its yellow.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const BUILTIN_ROLES = Object.freeze({
  vimma: Object.freeze({ "--vimma-hint-bg": "bright_green" }),
});

/**
 * Status-bar badge colour per mode, plus the pending prefix: the palette slot each badge asks for.
 * A theme can give two slots one colour (Catppuccin's bright magenta is its magenta); badgeColors
 * then moves the later badge, so every badge keeps a colour of its own.
 */
const BADGE_COLORS = Object.freeze({
  normal: "accent",
  insert: "green",
  visual: "magenta",
  command: "yellow",
  hint: "orange",
  // Beside VISUAL's magenta, the mode `v` leads into, and apart from it (element-focus 17).
  element: "bright_magenta",
  help: "cyan",
  panel: "blue",
  resize: "brown",
  prefix: "red",
});

/** Badges the status bar can show: every mode, and `prefix`. */
export const BADGES = Object.freeze(Object.keys(BADGE_COLORS));

/**
 * How far apart two badges' colours must be (CIE76 delta E): about where two flat swatches stop
 * reading as one colour at a glance, since a badge is recognised by its colour before its text.
 */
export const MIN_BADGE_DISTANCE = 10;

const ANSI = ["red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown"];
const BRIGHT = ["red", "yellow", "green", "cyan", "blue", "magenta"];

/** @type {readonly ThemeToken[]} */
export const THEME_TOKENS = Object.freeze([
  { name: "--vimma-color-scheme", from: "mode", description: "dark or light, for color-scheme" },
  { name: "--vimma-font", description: "font family list from [theme] font" },
  { name: "--vimma-bg", from: "background", description: "window background" },
  { name: "--vimma-bg-dark", from: "dark_background", description: "darker surface" },
  { name: "--vimma-bg-darker", from: "darker_background", description: "darkest surface" },
  { name: "--vimma-bg-light", from: "lighter_background", description: "raised surface" },
  { name: "--vimma-fg", from: "foreground", description: "text" },
  {
    name: "--vimma-fg-dim",
    from: "dark_foreground",
    readable: true,
    description: "secondary text, readable on every surface",
  },
  { name: "--vimma-fg-light", from: "light_foreground", description: "light text" },
  { name: "--vimma-fg-bright", from: "bright_foreground", description: "emphasised text" },
  { name: "--vimma-accent", from: "accent", description: "accent" },
  {
    name: "--vimma-focus",
    from: "accent",
    focus: true,
    description: "focus rings and the focused pane's outline: the accent, at 3:1 where it touches",
  },
  { name: "--vimma-muted", from: "muted", description: "borders, inactive" },
  { name: "--vimma-selection", from: "selection", description: "selected row background" },
  ...ANSI.map((c) => ({ name: `--vimma-${c}`, from: c, description: `${c}` })),
  ...BRIGHT.map((c) => ({
    name: `--vimma-bright-${c}`,
    from: `bright_${c}`,
    description: `bright ${c}`,
  })),
  { name: "--vimma-error", from: "red", description: "errors (config error indicator)" },
  { name: "--vimma-warning", from: "yellow", description: "warnings" },
  { name: "--vimma-success", from: "green", description: "success" },
  { name: "--vimma-statusbar-bg", from: "dark_background", description: "status bar" },
  { name: "--vimma-statusbar-fg", from: "foreground", description: "status bar text" },
  { name: "--vimma-hint-bg", from: "yellow", description: "link hint label" },
  { name: "--vimma-hint-fg", textOn: "--vimma-hint-bg", description: "link hint text" },
  {
    name: "--vimma-element-outline",
    from: "accent",
    description: "the focused text block's outline (element focus)",
  },
  ...Object.entries(BADGE_COLORS).flatMap(([badge, from]) => [
    {
      name: `--vimma-mode-${badge}`,
      from,
      badge: true,
      description: `${badge} mode badge, apart from every other badge's colour`,
    },
    {
      name: `--vimma-mode-${badge}-fg`,
      textOn: `--vimma-mode-${badge}`,
      description: `${badge} mode badge text`,
    },
  ]),
  // Coloured text (spec m7-a11y): the palette colour, made readable on every surface. The colour
  // tokens above stay as the palette gives them, for dots, borders and a user's own CSS.
  ...[
    ["accent", "accent"],
    ["error", "red"],
    ["warning", "yellow"],
    ["success", "green"],
  ].map(([c, from]) => ({
    name: `--vimma-text-${c}`,
    from,
    readable: true,
    description: `${c} text, readable on every surface`,
  })),
  ...ANSI.map((c) => ({
    name: `--vimma-text-${c}`,
    from: c,
    readable: true,
    description: `${c} text, readable on every surface`,
  })),
  ...BRIGHT.map((c) => ({
    name: `--vimma-text-bright-${c}`,
    from: `bright_${c}`,
    readable: true,
    description: `bright ${c} text, readable on every surface`,
  })),
]);

/**
 * The backgrounds Vimma's chrome draws text on: windows and pages, panels, pickers, the
 * command line and the status bar, and a selected row.
 */
export const SURFACE_TOKENS = Object.freeze([
  "--vimma-bg",
  "--vimma-bg-dark",
  "--vimma-statusbar-bg",
  "--vimma-selection",
]);

/**
 * Every token Vimma's chrome draws text in, on any of SURFACE_TOKENS (spec m7-a11y). The CSS and
 * the status bar use no other colour for text (tools/test/chrome-css.test.mjs).
 */
export const TEXT_TOKENS = Object.freeze([
  "--vimma-fg",
  "--vimma-fg-dim",
  "--vimma-fg-bright",
  "--vimma-statusbar-fg",
  ...THEME_TOKENS.filter((t) => t.name.startsWith("--vimma-text-")).map((t) => t.name),
]);

/**
 * What a focus ring or the focused pane's outline touches: the surfaces above, and the pane gap
 * (split.css paints it --vimma-muted), which shows at the outline's rounded corners and where a
 * split edge meets it.
 */
export const FOCUS_SURFACE_TOKENS = Object.freeze([...SURFACE_TOKENS, "--vimma-muted"]);

/** Pairs (text, background) checked against WCAG AA. Badge text is picked to pass already. */
const CONTRAST_PAIRS = [
  ["--vimma-fg", "--vimma-bg"],
  ["--vimma-fg", "--vimma-selection"],
  ["--vimma-fg-bright", "--vimma-selection"],
  ["--vimma-statusbar-fg", "--vimma-statusbar-bg"],
  ["--vimma-hint-fg", "--vimma-hint-bg"],
  ...BADGES.map((b) => [`--vimma-mode-${b}-fg`, `--vimma-mode-${b}`]),
];

/** WCAG 2.x AA minimum for normal text. */
export const MIN_CONTRAST = 4.5;

/** WCAG 2.x minimum for non-text contrast (1.4.11), focus indicators included. */
export const MIN_FOCUS_CONTRAST = 3;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `#rgb` or `#rrggbb`. No alpha: contrast needs opaque colours.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isHexColor(value) {
  return typeof value === "string" && HEX.test(value);
}

/**
 * @param {string} hex  a hex colour (isHexColor)
 * @returns {string} lowercase #rrggbb
 */
export function normalizeHex(hex) {
  const h = hex.toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

/**
 * The colour's linear-light sRGB channels, 0 to 1.
 * @param {string} hex  a hex colour
 * @returns {[number, number, number]}
 */
function linearRgb(hex) {
  const h = normalizeHex(hex);
  /** @param {number} at */
  const channel = (at) => {
    const c = parseInt(h.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

/** @param {string} hex */
function luminance(hex) {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio, 1 to 21.
 * @param {string} a  hex colour
 * @param {string} b  hex colour
 */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** @param {unknown} v */
const describe = (v) => (typeof v === "string" ? JSON.stringify(v) : `a ${typeof v}`);

/**
 * Read an Omarchy colors.toml. A file with only the base set (BASE_KEYS, by name or ANSI colour)
 * is complete: every other key is derived as Omarchy derives it (deriveMissing). Keys Vimma does
 * not read (hyprland_*, cursor, …) are ignored; Omarchy owns them.
 * @param {string} text
 * @param {{ lightMode?: boolean }} [options]  lightMode: the theme ships a light.mode file
 * @returns {{ palette: Palette | null, errors: ThemeError[] }}
 */
export function parseOmarchyColors(text, { lightMode = false } = {}) {
  const parsed = parseToml(text);
  if (!parsed.ok) return { palette: null, errors: [{ path: "", ...parsed.error }] };
  const raw = parsed.value;
  const lineOf = locateKeys(text);
  /** @param {string} key */
  const at = (key) => ({ line: lineOf([key]), path: formatPath([key]) });
  /** @type {ThemeError[]} */
  const errors = [];
  /** @type {Record<string, string>} */
  const given = {};
  for (const key of READ_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (isHexColor(v)) given[key] = normalizeHex(v);
    else
      errors.push({
        ...at(key),
        message: `must be a hex colour like "#7aa2f7", got ${describe(v)}`,
      });
  }
  if (raw.mode !== undefined && raw.mode !== "dark" && raw.mode !== "light") {
    errors.push({ ...at("mode"), message: `must be "dark" or "light", got ${describe(raw.mode)}` });
  }
  /** @type {Palette} */
  const palette = {};
  for (const key of PALETTE_KEYS) {
    if (key === "mode") continue;
    const from = [key, ...(BASE_ALIASES[key] ?? [])].find((k) => k in given);
    if (from) palette[key] = /** @type {string} */ (given[from]);
  }
  for (const key of BASE_KEYS) {
    // A key or stand-in with an invalid value is reported already, at its line.
    if (key in palette || [key, ...(BASE_ALIASES[key] ?? [])].some((k) => k in raw)) continue;
    const ansi = BASE_ALIASES[key]?.find((k) => k.startsWith("color"));
    const or = ansi ? ` (or its ANSI name "${ansi}")` : "";
    errors.push({ path: formatPath([key]), message: `missing key "${key}"${or}` });
  }
  if (errors.length) return { palette: null, errors };
  deriveMissing(palette, given);
  palette.mode =
    raw.mode === "dark" || raw.mode === "light"
      ? raw.mode
      : lightMode || channelSum(/** @type {string} */ (palette.background)) > 382
        ? "light"
        : "dark";
  // In PALETTE_KEYS order, as the built-in palettes are written.
  /** @type {Palette} */
  const ordered = {};
  for (const k of PALETTE_KEYS) ordered[k] = /** @type {string} */ (palette[k]);
  return { palette: ordered, errors };
}

/**
 * Fill the keys a colors.toml left out from the base set, in place. Each rule is Omarchy's
 * (omarchy-theme-color, Omarchy 4.0.0.alpha), so Vimma shows what the terminal and the bar show,
 * except where Vimma's chrome needs more (selection) or kept its own rule (brown).
 * @param {Palette} p  the base set present, plus any other key the file gave
 * @param {Record<string, string>} given  every colour the file gave, by its own name
 */
function deriveMissing(p, given) {
  const bg = /** @type {string} */ (p.background);
  const fg = /** @type {string} */ (p.foreground);
  p.light_foreground ??= fg;
  p.bright_foreground ??= fg;
  p.lighter_background ??= bg;
  p.dark_foreground ??= fg;
  p.muted ??= p.dark_foreground;
  p.dark_background ??= mix(bg, "#000000", 0.25);
  p.darker_background ??= mix(bg, "#000000", 0.5);
  for (const c of BRIGHT) p[`bright_${c}`] ??= mix(/** @type {string} */ (p[c]), "#ffffff", 0.2);
  // Keys some stock themes leave out. orange is Omarchy's rule; brown (the resize badge) keeps
  // Vimma's: Omarchy's orange at half brightness would recolour stock themes without a brown.
  p.orange ??= /** @type {string} */ (p.yellow);
  p.brown ??= /** @type {string} */ (p.dark_foreground);
  // Omarchy takes the terminal's selection colour, made for selection_foreground text. Vimma draws
  // foreground on a selected row, so the colour moves toward background until that reads.
  if (!p.selection) {
    const from = given.selection_background ?? given.color8 ?? bg;
    p.selection = towardReadable(from, bg, [fg, /** @type {string} */ (p.bright_foreground)]);
  }
}

/**
 * `color`, or the first 5% step from it toward `to` on which every `texts` colour reaches
 * MIN_CONTRAST: the hue stays, the text reads. `to` when no step does.
 * @param {string} color  #rrggbb
 * @param {string} to  #rrggbb
 * @param {readonly string[]} texts  #rrggbb
 */
function towardReadable(color, to, texts) {
  for (let step = 0; step <= 20; step++) {
    const c = mix(color, to, step / 20);
    if (texts.every((t) => contrastRatio(t, c) >= MIN_CONTRAST)) return c;
  }
  return to;
}

/**
 * Red + green + blue, 0 to 765: Omarchy's test for a light background (over 382) when a theme
 * names no mode.
 * @param {string} hex  #rrggbb
 */
function channelSum(hex) {
  return [1, 3, 5].reduce((sum, at) => sum + parseInt(hex.slice(at, at + 2), 16), 0);
}

const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/**
 * `Caskaydia Mono` → `"Caskaydia Mono", monospace`; generic families stay bare. The config
 * validator has already rejected quotes, semicolons, braces and backslashes.
 * @param {string} font
 */
function cssFontFamily(font) {
  const families = font.split(",").map(trimBlanks).filter(Boolean);
  const out = families.map((f) => (GENERIC_FONTS.has(f) ? f : cssString(f)));
  if (!GENERIC_FONTS.has(/** @type {string} */ (families.at(-1)))) out.push("monospace");
  return out.join(", ");
}

/**
 * A CSS string literal; defensive even though the config validator rejects these characters.
 * @param {string} s
 */
function cssString(s) {
  let body = "";
  for (const c of s) {
    const code = /** @type {number} */ (c.codePointAt(0));
    if (c === "\\" || c === '"') body += `\\${c}`;
    else if (code < 0x20 || code === 0x7f) body += `\\${code.toString(16)} `;
    else body += c;
  }
  return `"${body}"`;
}

/**
 * Text colour for `bg`: the palette's background or foreground, whichever contrasts more;
 * black or white if neither reaches MIN_CONTRAST (one of them always does, at ≥ 4.58:1).
 * @param {string} bg
 * @param {Palette} palette
 */
function textOn(bg, palette) {
  /** @param {string[]} candidates */
  const best = (candidates) =>
    /** @type {string} */ (
      candidates.reduce((a, b) => (contrastRatio(b, bg) > contrastRatio(a, bg) ? b : a))
    );
  const pick = best([
    /** @type {string} */ (palette.background),
    /** @type {string} */ (palette.foreground),
  ]);
  return contrastRatio(pick, bg) >= MIN_CONTRAST ? pick : best(["#000000", "#ffffff"]);
}

/**
 * @param {Palette} palette  complete: every PALETTE_KEYS entry
 * @param {string} font
 * @param {Readonly<Record<string, string>>} [roles]  token → palette key, over THEME_TOKENS' from
 * @returns {Tokens}
 */
function paletteToTokens(palette, font, roles = {}) {
  /** @type {Tokens} */
  const tokens = {};
  const badges = badgeColors(palette);
  for (const t of THEME_TOKENS) {
    const from = Object.hasOwn(roles, t.name) ? roles[t.name] : t.from;
    if (t.badge) tokens[t.name] = /** @type {string} */ (badges[t.name]);
    else if (t.textOn) tokens[t.name] = textOn(/** @type {string} */ (tokens[t.textOn]), palette);
    else if (from) tokens[t.name] = /** @type {string} */ (palette[from]);
    else tokens[t.name] = cssFontFamily(font);
  }
  // Once every surface has its value.
  /** @param {readonly string[]} names */
  const values = (names) => names.map((s) => /** @type {string} */ (tokens[s]));
  const surfaces = values(SURFACE_TOKENS);
  const focusSurfaces = values(FOCUS_SURFACE_TOKENS);
  for (const t of THEME_TOKENS) {
    const value = /** @type {string} */ (tokens[t.name]);
    if (t.readable) tokens[t.name] = readable(value, surfaces, MIN_CONTRAST);
    else if (t.focus) tokens[t.name] = readable(value, focusSurfaces, MIN_FOCUS_CONTRAST);
  }
  return tokens;
}

/**
 * Each badge's colour, by token name. A badge keeps its slot's colour when that is at least
 * MIN_BADGE_DISTANCE from the colour of every badge before it in BADGE_COLORS that kept its own.
 * The others, in the same order, take their slot's colour lightened or darkened by the smallest
 * 5% step that sets it apart from every badge placed so far: a shade of the colour asked for keeps
 * the badge recognisable (ELEMENT a deeper VISUAL), where taking another slot would push that
 * slot's badge on in turn. Badge text is chosen after (textOn), so every pick still gets AA text.
 * @param {Palette} palette
 * @returns {Record<string, string>}
 */
function badgeColors(palette) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {string[]} */
  const placed = [];
  /** @param {string} c */
  const apart = (c) => placed.every((p) => colorDistance(c, p) >= MIN_BADGE_DISTANCE);
  const wants = Object.entries(BADGE_COLORS).map(([badge, slot]) => ({
    name: `--vimma-mode-${badge}`,
    want: /** @type {string} */ (palette[slot]),
  }));
  /** @type {typeof wants} */
  const moved = [];
  for (const w of wants) {
    if (!apart(w.want)) moved.push(w);
    else placed.push((out[w.name] = w.want));
  }
  /** @param {string} c */
  const room = (c) => Math.min(...placed.map((p) => colorDistance(c, p)));
  for (const { name, want } of moved) {
    /** @type {string[]} */
    const shades = [];
    for (let step = 1; step <= 20; step++) {
      shades.push(mix(want, "#ffffff", step / 20), mix(want, "#000000", step / 20));
    }
    // A theme of a few greys has no shade apart from them all: the one with the most room.
    const pick = shades.find(apart) ?? shades.reduce((a, b) => (room(b) > room(a) ? b : a));
    placed.push((out[name] = pick));
  }
  return out;
}

/**
 * CIELAB (D65) L*, a*, b*.
 * @param {string} hex  a hex colour
 * @returns {[number, number, number]}
 */
function lab(hex) {
  const [r, g, b] = linearRgb(hex);
  /** @param {number} t */
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * CIE76 delta E between two colours (sRGB, D65): 0 for one colour, 100 from black to white.
 * @param {string} a  hex colour
 * @param {string} b  hex colour
 */
export function colorDistance(a, b) {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * `color`, or the first step of 5% toward black or white (whichever contrasts more with the
 * surfaces) that reaches `min` on every one of them: the hue stays, the text (or ring) shows.
 * @param {string} color  #rrggbb
 * @param {readonly string[]} surfaces  #rrggbb
 * @param {number} min  contrast ratio to reach
 * @returns {string} #rrggbb
 */
function readable(color, surfaces, min) {
  /** @param {string} c */
  const worst = (c) => Math.min(...surfaces.map((s) => contrastRatio(c, s)));
  if (worst(color) >= min) return color;
  const target = worst("#000000") >= worst("#ffffff") ? "#000000" : "#ffffff";
  for (let step = 1; step < 20; step++) {
    const c = mix(color, target, step / 20);
    if (worst(c) >= min) return c;
  }
  return target;
}

/**
 * @param {string} a  #rrggbb
 * @param {string} b  #rrggbb
 * @param {number} t  0 is `a`, 1 is `b`
 */
function mix(a, b, t) {
  let out = "#";
  for (const at of [1, 3, 5]) {
    const x = parseInt(a.slice(at, at + 2), 16);
    const y = parseInt(b.slice(at, at + 2), 16);
    out += Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/**
 * @typedef {object} ThemeConfig
 * @property {"omarchy" | "file"} source
 * @property {string} [name]   the built-in palette (BUILTIN_THEMES); DEFAULT_THEME_NAME without
 * @property {string} [appearance]  the built-in palette's variant (APPEARANCES); "system"
 *   without one. `colors.mode` wins over it.
 * @property {string} font
 * @property {Record<string, string>} colors   [theme.colors], validated
 */

/**
 * @typedef {object} ResolvedTheme
 * @property {Tokens} tokens
 * @property {"dark" | "light"} mode
 * @property {ThemeError[]} errors
 * @property {string[]} warnings
 * @property {boolean} adaptive  the tokens are a built-in's with a light variant, and no
 *   `[theme.colors] mode` pins one: they change with `scheme`
 */

/**
 * Tokens for the configured theme. Without an Omarchy theme (source "file", or none found) they
 * are the built-in palette `theme.name`, in the variant for `scheme` when it has a light one. On
 * errors the tokens are that built-in's (overlaid by [theme.colors]); a host that already shows
 * a theme keeps it, as for config.
 * @param {{ theme: ThemeConfig, omarchy?: string | null, omarchyLightMode?: boolean,
 *   scheme?: "dark" | "light" }} input
 *   omarchy: the text of the current Omarchy colors.toml, or null when there is none;
 *   scheme: the colour scheme the browser prefers (prefers-color-scheme), "dark" by default
 * @returns {ResolvedTheme}
 */
export function resolveTheme({ theme, omarchy = null, omarchyLightMode = false, scheme = "dark" }) {
  /** @type {ThemeError[]} */
  let errors = [];
  /** @type {string[]} */
  const warnings = [];
  let name = theme.name ?? DEFAULT_THEME_NAME;
  if (!Object.hasOwn(BUILTIN_THEMES, name)) {
    errors.push({ path: "theme.name", message: `unknown theme ${describe(name)}` });
    name = DEFAULT_THEME_NAME;
  }
  const builtin = /** @type {BuiltinTheme} */ (BUILTIN_THEMES[name]);
  let appearance = theme.appearance ?? "system";
  if (!APPEARANCES.includes(/** @type {Appearance} */ (appearance))) {
    const message = `must be "system", "dark" or "light", got ${describe(appearance)}`;
    errors.push({ path: "theme.appearance", message });
    appearance = "system";
  }
  const modePinned = theme.colors.mode === "dark" || theme.colors.mode === "light";
  // [theme.colors] mode is an override on top of any palette: it wins over appearance.
  const pinned = modePinned || appearance !== "system";
  const variant = modePinned ? theme.colors.mode : appearance === "system" ? scheme : appearance;
  /** @type {Palette} */
  let base = { ...(variant === "light" && builtin.light ? builtin.light : builtin.dark) };
  let fromBuiltin = true;
  if (theme.source === "omarchy") {
    // No Omarchy file: the built-in palette, and nothing to report (theme-appearance A).
    if (omarchy !== null) {
      const r = parseOmarchyColors(omarchy, { lightMode: omarchyLightMode });
      if (r.palette) {
        base = r.palette;
        fromBuiltin = false;
      }
      errors = [...errors, ...r.errors];
    }
  }
  /** @type {Palette} */
  const palette = { ...base };
  // Validated again here: these values become CSS, and callers other than parseConfig exist.
  for (const [key, v] of Object.entries(theme.colors)) {
    const path = formatPath(["theme", "colors", key]);
    if (!PALETTE_KEYS.includes(key)) {
      errors.push({ path, message: `unknown colour key "${key}"` });
    } else if (key === "mode") {
      if (v === "dark" || v === "light") palette.mode = v;
      else errors.push({ path, message: `must be "dark" or "light", got ${describe(v)}` });
    } else if (isHexColor(v)) {
      palette[key] = normalizeHex(v);
    } else {
      errors.push({ path, message: `must be a hex colour like "#7aa2f7", got ${describe(v)}` });
    }
  }
  const roles = fromBuiltin ? BUILTIN_ROLES[name] : undefined;
  const tokens = paletteToTokens(palette, theme.font, roles);
  for (const [fg, bg] of CONTRAST_PAIRS) {
    const ratio = contrastRatio(
      /** @type {string} */ (tokens[/** @type {string} */ (fg)]),
      /** @type {string} */ (tokens[/** @type {string} */ (bg)]),
    );
    if (ratio < MIN_CONTRAST) {
      const shown = Math.floor(ratio * 100) / 100;
      warnings.push(`${fg} on ${bg}: ${shown}:1 is below ${MIN_CONTRAST}:1 (WCAG AA)`);
    }
  }
  const mode = palette.mode === "light" ? "light" : "dark";
  const adaptive = fromBuiltin && !pinned && builtin.light !== undefined;
  return { tokens, mode, errors, warnings, adaptive };
}

/**
 * The colour scheme web pages are given (spec content-color-scheme): set only while the theme
 * fixes dark or light, so that a theme following the system leaves pages on Firefox's own choice.
 */
export const CONTENT_SCHEME_TOKEN = "--vimma-content-color-scheme";

/**
 * The stylesheet for the configured theme. A built-in with a light variant (vimma) gives its
 * dark tokens, then its light ones under `@media (prefers-color-scheme: light)`, so the page
 * switches with the browser's colour scheme, live, with no script. Anything else is one block,
 * with CONTENT_SCHEME_TOKEN for web pages.
 * Warnings only the light variant has start with "light: ".
 * @param {{ theme: ThemeConfig, omarchy?: string | null, omarchyLightMode?: boolean,
 *   selector?: string }} input  as resolveTheme; selector as tokensToCss
 * @returns {{ css: string, errors: ThemeError[], warnings: string[] }}
 */
export function themeStylesheet({ selector = ":root", ...input }) {
  const dark = resolveTheme({ ...input, scheme: "dark" });
  const tokens = dark.adaptive
    ? dark.tokens
    : { ...dark.tokens, [CONTENT_SCHEME_TOKEN]: dark.mode };
  let css = tokensToCss(tokens, selector);
  const warnings = [...dark.warnings];
  if (dark.adaptive) {
    const light = resolveTheme({ ...input, scheme: "light" });
    css += `@media (prefers-color-scheme: light) {\n${tokensToCss(light.tokens, selector)}}\n`;
    for (const w of light.warnings) if (!dark.warnings.includes(w)) warnings.push(`light: ${w}`);
  }
  return { css, errors: dark.errors, warnings };
}

const CSS_STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const FONT_ITEM = `(?:${CSS_STRING}|[a-z-]+)`;
const FONT_LIST = new RegExp(`^${FONT_ITEM}(?:, ${FONT_ITEM})*$`);

/**
 * Only values resolveTheme can produce: #rrggbb, a color-scheme keyword, a quoted font list.
 * @param {string} name
 * @param {unknown} value
 */
function safeToken(name, value) {
  if (!/^--vimma-[a-z0-9-]+$/.test(name) || typeof value !== "string") return false;
  if (name === "--vimma-color-scheme" || name === CONTENT_SCHEME_TOKEN) {
    return value === "dark" || value === "light";
  }
  if (name === "--vimma-font") return FONT_LIST.test(value);
  return /^#[0-9a-f]{6}$/.test(value);
}

/**
 * The stylesheet the host injects. Throws TypeError on a value resolveTheme could not have made,
 * so a caller passing untrusted tokens cannot inject CSS.
 * @param {Tokens} tokens
 * @param {string} [selector]
 */
export function tokensToCss(tokens, selector = ":root") {
  if (!/^[^{};]+$/.test(selector))
    throw new TypeError(`unsafe selector ${JSON.stringify(selector)}`);
  const body = Object.entries(tokens)
    .map(([k, v]) => {
      if (!safeToken(k, v)) throw new TypeError(`unsafe token ${k}: ${JSON.stringify(v)}`);
      return `  ${k}: ${v};\n`;
    })
    .join("");
  return `${selector} {\n${body}}\n`;
}
