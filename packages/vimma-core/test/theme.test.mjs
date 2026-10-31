import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BADGES,
  BUILTIN_THEMES,
  DEFAULT_THEME_NAME,
  PALETTE_KEYS,
  THEME_TOKENS,
  TOKYO_NIGHT,
  VIMMA_DARK,
  VIMMA_LIGHT,
  MIN_BADGE_DISTANCE,
  MIN_CONTRAST,
  colorDistance,
  contrastRatio,
  isHexColor,
  normalizeHex,
  parseOmarchyColors,
  resolveTheme,
  themeStylesheet,
  tokensToCss,
} from "../src/theme.mjs";
import { mergeWithDefaults } from "../src/config.mjs";
import { MODES } from "../src/modes.mjs";

/** @param {string} name */
const fixture = (name) =>
  readFileSync(new URL(`../../../tests/contract/theme/${name}`, import.meta.url), "utf8");

const defaults = mergeWithDefaults({}).theme;
/** @param {Partial<typeof defaults>} over */
const themeCfg = (over = {}) => ({ ...defaults, ...over });
/** @param {Partial<typeof defaults>} over */
const tokyoCfg = (over = {}) => themeCfg({ name: "tokyo-night", ...over });

describe("hex colours", () => {
  test.each(["#fff", "#FFF", "#1a1b26", "#A9B1D6"])("%s is a hex colour", (c) => {
    expect(isHexColor(c)).toBe(true);
  });
  test.each(["#xyz", "#12345", "#1234567", "fff", "rgba(0,0,0,1)", "#1a1b26ff", "", 3])(
    "%j is not a hex colour",
    (c) => {
      expect(isHexColor(c)).toBe(false);
    },
  );
  test("normalises to lowercase #rrggbb", () => {
    expect(normalizeHex("#FFF")).toBe("#ffffff");
    expect(normalizeHex("#A9B1D6")).toBe("#a9b1d6");
  });
});

describe("contrastRatio (WCAG 2.x)", () => {
  test("black on white is 21:1 and symmetric", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 5);
  });
  test("equal colours are 1:1", () => {
    expect(contrastRatio("#7aa2f7", "#7aa2f7")).toBeCloseTo(1, 5);
  });
  test("#777 on white is just under 4.5:1", () => {
    const r = contrastRatio("#777777", "#ffffff");
    expect(r).toBeLessThan(4.5);
    expect(r).toBeGreaterThan(4.4);
  });
});

describe("parseOmarchyColors", () => {
  test("the Tokyo Night fixture parses to the built-in palette", () => {
    const r = parseOmarchyColors(fixture("tokyo-night.colors.toml"));
    expect(r.errors).toEqual([]);
    expect(r.palette).toEqual(TOKYO_NIGHT);
  });

  test("a light theme without orange and brown fills them, ignoring extra keys", () => {
    const r = parseOmarchyColors(fixture("light.colors.toml"));
    expect(r.errors).toEqual([]);
    expect(r.palette?.mode).toBe("light");
    expect(r.palette?.orange).toBe(r.palette?.yellow);
    expect(r.palette?.brown).toBe(r.palette?.dark_foreground);
    expect(r.palette).not.toHaveProperty("hyprland_active_border");
  });

  test("an invalid colour and a missing key are errors; the invalid one has its line", () => {
    const r = parseOmarchyColors(fixture("invalid.colors.toml"));
    expect(r.palette).toBeNull();
    expect(r.errors).toEqual([
      expect.objectContaining({ path: "accent", line: 4, message: expect.stringMatching(/hex/) }),
      expect.objectContaining({ path: "foreground", message: expect.stringMatching(/missing/) }),
    ]);
  });

  test("a syntax error is reported with its line", () => {
    const r = parseOmarchyColors('mode = "dark"\naccent = #7aa2f7\n');
    expect(r.palette).toBeNull();
    expect(r.errors[0]?.line).toBe(2);
  });

  test("a bad mode is an error; no mode is dark, or light with lightMode", () => {
    const base = fixture("tokyo-night.colors.toml").replace('mode = "dark"\n', "");
    expect(parseOmarchyColors(base).palette?.mode).toBe("dark");
    expect(parseOmarchyColors(base, { lightMode: true }).palette?.mode).toBe("light");
    expect(parseOmarchyColors(`mode = "dim"\n${base}`).errors[0]?.path).toBe("mode");
  });
});

// Themes made before Omarchy's named palette carry only the base keys: accent, foreground,
// background, selection_* and ANSI color0-color15. Every other key is derived as Omarchy's own
// omarchy-theme-color derives it, so Vimma matches the terminal and the bar.
describe("parseOmarchyColors: a colors.toml with only the base keys", () => {
  const eventHorizon = fixture("event-horizon.colors.toml");
  const base = [
    'accent = "#26bbd9"',
    'foreground = "#fadad1"',
    'background = "#1c1e26"',
    ...["#1c1e26", "#e95678", "#29d398", "#fab795", "#26bbd9", "#ee64ac", "#59e3e3", "#fadad1"].map(
      (c, i) => `color${i} = "${c}"`,
    ),
  ].join("\n");

  test("Event Horizon is accepted, every key derived from the base set", () => {
    const r = parseOmarchyColors(eventHorizon);
    expect(r.errors).toEqual([]);
    expect(r.palette).toEqual({
      mode: "dark", // no mode, no light.mode: background's channel sum 96 is under 383
      accent: "#26bbd9",
      selection: "#216577", // selection_background, toward background until foreground reads
      muted: "#6c6f93", // color8
      background: "#1c1e26",
      dark_background: "#15171d", // background, 25% toward black
      darker_background: "#0e0f13", // background, 50% toward black
      lighter_background: "#1c1e26", // background (Omarchy has set color0 to it)
      foreground: "#fadad1",
      dark_foreground: "#6c6f93", // color8
      light_foreground: "#fadad1", // foreground (Omarchy has set color7 to it)
      bright_foreground: "#fadad1", // color15
      red: "#e95678", // color1
      yellow: "#fab795", // color3
      orange: "#fab795", // yellow
      green: "#29d398", // color2
      cyan: "#59e3e3", // color6
      blue: "#26bbd9", // color4
      magenta: "#ee64ac", // color5
      brown: "#6c6f93", // dark_foreground
      bright_red: "#ec6a88", // color9
      bright_yellow: "#fbc3a7", // color11
      bright_green: "#3fdaa4", // color10
      bright_cyan: "#6be4e6", // color14
      bright_blue: "#3fc4de", // color12
      bright_magenta: "#f075b5", // color13
    });
  });

  test("Event Horizon resolves with no errors and no contrast warnings", () => {
    const r = resolveTheme({ theme: themeCfg(), omarchy: eventHorizon });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.tokens["--vimma-bg"]).toBe("#1c1e26");
    expect(r.tokens["--vimma-statusbar-bg"]).toBe("#15171d");
    expect(r.tokens["--vimma-accent"]).toBe("#26bbd9");
  });

  test("without color8-15 or selection_background: bright colours 20% toward white", () => {
    const r = parseOmarchyColors(base);
    expect(r.errors).toEqual([]);
    const p = /** @type {Record<string, string>} */ (r.palette);
    expect(p.bright_red).toBe("#ed7893"); // #e95678, 20% toward white
    expect(p.bright_foreground).toBe("#fadad1"); // foreground
    expect(p.dark_foreground).toBe("#fadad1"); // foreground (Omarchy's rule; fg-dim reads)
    expect(p.muted).toBe("#fadad1"); // dark_foreground
    // selection falls back to color8, then color0: the background itself.
    expect(p.selection).toBe("#1c1e26");
  });

  test("color0 and color7 stand in for background and foreground", () => {
    const text = base.replace(/^(foreground|background) = .*\n/gm, "");
    const p = parseOmarchyColors(text).palette;
    expect(p?.background).toBe("#1c1e26");
    expect(p?.foreground).toBe("#fadad1");
  });

  test("a named key wins over its ANSI colour", () => {
    const p = parseOmarchyColors(`${base}\nred = "#ff0000"\nmuted = "#333333"`).palette;
    expect(p?.red).toBe("#ff0000");
    expect(p?.muted).toBe("#333333");
  });

  test("Omarchy's short names and purple are read too", () => {
    const text = `${base.replace(/^color5 = .*$/m, "")}\npurple = "#aa00aa"\nbg = "#000000"`;
    const p = parseOmarchyColors(text.replace(/^background = .*$/m, "")).palette;
    expect(p?.magenta).toBe("#aa00aa");
    expect(p?.background).toBe("#000000");
  });

  test("an explicit selection is kept as given, contrast or not", () => {
    const p = parseOmarchyColors(`${eventHorizon}\nselection = "#26bbd9"`).palette;
    expect(p?.selection).toBe("#26bbd9");
  });

  test("without mode or light.mode, a light background makes a light theme", () => {
    const light = base
      .replace('background = "#1c1e26"', 'background = "#f5f4ef"')
      .replace('foreground = "#fadad1"', 'foreground = "#1d2924"');
    expect(parseOmarchyColors(light).palette?.mode).toBe("light");
    expect(parseOmarchyColors(light, { lightMode: false }).palette?.mode).toBe("light");
  });

  test("a missing base colour is rejected, naming the key and its ANSI name", () => {
    const r = parseOmarchyColors(base.replace(/^color1 = .*$/m, ""));
    expect(r.palette).toBeNull();
    expect(r.errors).toEqual([
      { path: "red", message: 'missing key "red" (or its ANSI name "color1")' },
    ]);
  });

  test("an invalid ANSI colour is rejected at its line", () => {
    const r = parseOmarchyColors(base.replace('color2 = "#29d398"', 'color2 = "green"'));
    expect(r.palette).toBeNull();
    expect(r.errors).toEqual([
      expect.objectContaining({ path: "color2", line: 6, message: expect.stringMatching(/hex/) }),
    ]);
  });

  test("a missing accent is rejected: Omarchy derives no accent either", () => {
    const r = parseOmarchyColors(base.replace(/^accent = .*$/m, ""));
    expect(r.errors).toEqual([{ path: "accent", message: 'missing key "accent"' }]);
  });
});

describe("resolveTheme", () => {
  // theme-appearance A: no Omarchy is not a problem to report, so no warning names it.
  test("the default source without an Omarchy file is the built-in vimma, without a warning", () => {
    const r = resolveTheme({ theme: themeCfg() });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.mode).toBe("dark");
    expect(r.tokens["--vimma-bg"]).toBe("#071011");
    expect(r.tokens["--vimma-fg"]).toBe("#c2d6d3");
    expect(r.tokens["--vimma-accent"]).toBe("#2cf5d2");
    expect(r.tokens["--vimma-color-scheme"]).toBe("dark");
    expect(r.tokens["--vimma-font"]).toBe("monospace");
  });

  test('name = "tokyo-night" without an Omarchy file is Tokyo Night, without a warning', () => {
    const r = resolveTheme({ theme: tokyoCfg() });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.tokens["--vimma-bg"]).toBe("#1a1b26");
    expect(r.tokens["--vimma-accent"]).toBe("#7aa2f7");
  });

  test("source = file is the named built-in without a warning, even when Omarchy text is given", () => {
    const light = fixture("light.colors.toml");
    const r = resolveTheme({ theme: tokyoCfg({ source: "file" }), omarchy: light });
    expect(r.warnings).toEqual([]);
    expect(r.tokens["--vimma-bg"]).toBe("#1a1b26");
    const v = resolveTheme({ theme: themeCfg({ source: "file" }), omarchy: light });
    expect(v.warnings).toEqual([]);
    expect(v.tokens["--vimma-bg"]).toBe("#071011");
  });

  test("an Omarchy theme wins over the built-in name: Omarchy users see no change", () => {
    const text = fixture("tokyo-night.colors.toml");
    const vimma = resolveTheme({ theme: themeCfg(), omarchy: text });
    const tokyo = resolveTheme({ theme: tokyoCfg(), omarchy: text });
    expect(vimma.tokens).toEqual(tokyo.tokens);
    const light = resolveTheme({ theme: themeCfg(), omarchy: text, scheme: "light" });
    expect(light.tokens).toEqual(tokyo.tokens);
  });

  test('the built-in vimma is light with scheme "light", dark otherwise', () => {
    const r = resolveTheme({ theme: themeCfg({ source: "file" }), scheme: "light" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.mode).toBe("light");
    expect(r.tokens).toMatchObject({
      "--vimma-color-scheme": "light",
      "--vimma-bg": "#f3f6f4",
      "--vimma-fg": "#1b2a28",
      "--vimma-accent": "#006b5e",
      "--vimma-selection": "#c3efe6",
    });
    const dark = resolveTheme({ theme: themeCfg({ source: "file" }), scheme: "dark" });
    expect(dark.tokens["--vimma-bg"]).toBe("#071011");
  });

  test("Tokyo Night is dark-only: a light scheme changes nothing", () => {
    const light = resolveTheme({ theme: tokyoCfg({ source: "file" }), scheme: "light" });
    const dark = resolveTheme({ theme: tokyoCfg({ source: "file" }) });
    expect(light.tokens).toEqual(dark.tokens);
    expect(light.mode).toBe("dark");
  });

  test("vimma's link hints are the magenta, the aqua is the normal badge", () => {
    // The two neons of the Aqua Split palette: hints in the magenta, with the variant's own
    // background as text (dark on the neon, light on the deep berry), the mode in the aqua.
    const dark = resolveTheme({ theme: themeCfg({ source: "file" }) });
    expect(dark.tokens["--vimma-hint-bg"]).toBe("#ff4fb8");
    expect(dark.tokens["--vimma-hint-fg"]).toBe("#071011");
    expect(dark.tokens["--vimma-mode-normal"]).toBe("#2cf5d2");
    const light = resolveTheme({ theme: themeCfg({ source: "file" }), scheme: "light" });
    expect(light.tokens["--vimma-hint-bg"]).toBe("#b0226f");
    expect(light.tokens["--vimma-hint-fg"]).toBe("#f3f6f4");
    expect(light.tokens["--vimma-mode-normal"]).toBe("#006b5e");
    // Tokyo Night keeps its yellow hints
    expect(resolveTheme({ theme: tokyoCfg() }).tokens["--vimma-hint-bg"]).toBe("#e0af68");
  });

  test("[theme.colors] mode pins one vimma variant whatever the scheme", () => {
    const r = resolveTheme({
      theme: themeCfg({ source: "file", colors: { mode: "light" } }),
      scheme: "dark",
    });
    expect(r.mode).toBe("light");
    expect(r.tokens["--vimma-bg"]).toBe("#f3f6f4");
    const d = resolveTheme({
      theme: themeCfg({ source: "file", colors: { mode: "dark" } }),
      scheme: "light",
    });
    expect(d.tokens["--vimma-bg"]).toBe("#071011");
  });

  // docs/specs/theme-appearance.md, B.
  describe("[theme] appearance", () => {
    const VIMMA_DARK_BG = "#071011";
    const VIMMA_LIGHT_BG = "#f3f6f4";
    test.each([
      ["dark", "light", VIMMA_DARK_BG, "dark"],
      ["light", "dark", VIMMA_LIGHT_BG, "light"],
      ["system", "light", VIMMA_LIGHT_BG, "light"],
      ["system", "dark", VIMMA_DARK_BG, "dark"],
    ])("appearance %s under a %s scheme is the %s palette", (appearance, scheme, bg, mode) => {
      const r = resolveTheme({
        theme: themeCfg({ source: "file", appearance }),
        scheme: /** @type {"dark" | "light"} */ (scheme),
      });
      expect(r.errors).toEqual([]);
      expect(r.tokens["--vimma-bg"]).toBe(bg);
      expect(r.mode).toBe(mode);
      expect(r.adaptive).toBe(appearance === "system");
    });

    test("left out, it is system: the scheme decides", () => {
      const r = resolveTheme({ theme: themeCfg({ source: "file" }), scheme: "light" });
      expect(r.tokens["--vimma-bg"]).toBe(VIMMA_LIGHT_BG);
      expect(r.adaptive).toBe(true);
    });

    test("[theme.colors] mode wins over appearance", () => {
      const r = resolveTheme({
        theme: themeCfg({ source: "file", appearance: "light", colors: { mode: "dark" } }),
        scheme: "light",
      });
      expect(r.tokens["--vimma-bg"]).toBe(VIMMA_DARK_BG);
      expect(r.mode).toBe("dark");
    });

    test("Tokyo Night has no light variant: light stays dark", () => {
      const r = resolveTheme({ theme: tokyoCfg({ source: "file", appearance: "light" }) });
      expect(r.tokens["--vimma-bg"]).toBe("#1a1b26");
      expect(r.mode).toBe("dark");
    });

    test("an Omarchy theme decides its own: appearance changes nothing", () => {
      const text = fixture("tokyo-night.colors.toml");
      const plain = resolveTheme({ theme: themeCfg(), omarchy: text });
      const light = resolveTheme({ theme: themeCfg({ appearance: "light" }), omarchy: text });
      expect(light.tokens).toEqual(plain.tokens);
    });

    test("dark or light is one block in the stylesheet, without @media", () => {
      for (const appearance of ["dark", "light"]) {
        const r = themeStylesheet({ theme: themeCfg({ source: "file", appearance }) });
        expect(r.css, appearance).not.toContain("@media");
        const tokens = resolveTheme({
          theme: themeCfg({ source: "file", appearance }),
        }).tokens;
        // The fixed scheme is also the one web pages get (spec content-color-scheme).
        const page = { "--vimma-content-color-scheme": appearance };
        expect(r.css).toBe(tokensToCss({ ...tokens, ...page }, ":root"));
      }
    });

    test("an unknown value from a caller is an error, and system applies", () => {
      const r = resolveTheme({
        theme: themeCfg({ source: "file", appearance: "blue" }),
        scheme: "light",
      });
      expect(r.errors).toEqual([
        { path: "theme.appearance", message: 'must be "system", "dark" or "light", got "blue"' },
      ]);
      expect(r.tokens["--vimma-bg"]).toBe(VIMMA_LIGHT_BG);
    });
  });

  test("Omarchy Tokyo Night has the expected tokens and passes every contrast check", () => {
    const r = resolveTheme({ theme: themeCfg(), omarchy: fixture("tokyo-night.colors.toml") });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.tokens).toMatchObject({
      "--vimma-bg": "#1a1b26",
      "--vimma-bg-dark": "#13141c",
      "--vimma-muted": "#414868",
      "--vimma-selection": "#292e42",
      "--vimma-statusbar-bg": "#13141c",
      "--vimma-statusbar-fg": "#a9b1d6",
      "--vimma-mode-normal": "#7aa2f7",
      "--vimma-mode-insert": "#9ece6a",
      "--vimma-mode-prefix": "#f7768e",
      "--vimma-hint-bg": "#e0af68",
      "--vimma-hint-fg": "#1a1b26",
      "--vimma-error": "#f7768e",
      "--vimma-bright-magenta": "#bb9af7",
    });
  });

  test("a light Omarchy theme is light and every badge stays readable", () => {
    const r = resolveTheme({ theme: themeCfg(), omarchy: fixture("light.colors.toml") });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.mode).toBe("light");
    expect(r.tokens["--vimma-color-scheme"]).toBe("light");
    expect(r.tokens["--vimma-bg"]).toBe("#eff1f5");
    for (const badge of BADGES) {
      const bg = /** @type {string} */ (r.tokens[`--vimma-mode-${badge}`]);
      const fg = /** @type {string} */ (r.tokens[`--vimma-mode-${badge}-fg`]);
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
    // neither palette text colour reaches 4.5:1 on this yellow, so the text falls back to black
    expect(r.tokens["--vimma-hint-fg"]).toBe("#000000");
  });

  test("an invalid Omarchy file gives errors and the named built-in's tokens", () => {
    const r = resolveTheme({ theme: themeCfg(), omarchy: fixture("invalid.colors.toml") });
    expect(r.errors.map((e) => e.path)).toEqual(["accent", "foreground"]);
    expect(r.tokens["--vimma-bg"]).toBe("#071011");
    const t = resolveTheme({ theme: tokyoCfg(), omarchy: fixture("invalid.colors.toml") });
    expect(t.tokens["--vimma-bg"]).toBe("#1a1b26");
  });

  test("[theme.colors] overlays the Omarchy palette", () => {
    const r = resolveTheme({
      theme: themeCfg({ colors: { accent: "#ff0000" } }),
      omarchy: fixture("light.colors.toml"),
    });
    expect(r.tokens["--vimma-accent"]).toBe("#ff0000");
    expect(r.tokens["--vimma-mode-normal"]).toBe("#ff0000");
    expect(r.tokens["--vimma-bg"]).toBe("#eff1f5");
  });

  test("[theme.colors] mode switches the colour scheme", () => {
    const r = resolveTheme({ theme: tokyoCfg({ source: "file", colors: { mode: "light" } }) });
    expect(r.mode).toBe("light");
  });

  test("omarchyLightMode makes a palette without mode light", () => {
    const text = fixture("light.colors.toml").replace('mode = "light"\n', "");
    const r = resolveTheme({ theme: themeCfg(), omarchy: text, omarchyLightMode: true });
    expect(r.mode).toBe("light");
  });

  test("[theme.colors] accent is the focus colour when it reaches 3:1, nudged when not", () => {
    const keep = resolveTheme({
      theme: themeCfg({ source: "file", colors: { accent: "#ff79c6" } }),
    });
    expect(keep.tokens["--vimma-accent"]).toBe("#ff79c6");
    expect(keep.tokens["--vimma-focus"]).toBe("#ff79c6");
    // A dark accent on vimma dark's near-black surfaces: moved toward white until it shows.
    const dim = resolveTheme({
      theme: themeCfg({ source: "file", colors: { accent: "#203040" } }),
    });
    expect(dim.tokens["--vimma-accent"]).toBe("#203040");
    const focus = String(dim.tokens["--vimma-focus"]);
    expect(focus).not.toBe("#203040");
    for (const bg of ["--vimma-bg", "--vimma-bg-dark", "--vimma-muted", "--vimma-selection"]) {
      expect(contrastRatio(focus, String(dim.tokens[bg])), bg).toBeGreaterThanOrEqual(3);
    }
  });

  test("low fg/bg contrast warns, naming both tokens and the ratio", () => {
    const r = resolveTheme({
      theme: themeCfg({ source: "file", colors: { foreground: "#777777", background: "#ffffff" } }),
    });
    expect(r.warnings).toContainEqual(
      expect.stringMatching(/--vimma-fg on --vimma-bg: 4\.4\d?:1 is below 4\.5:1/),
    );
  });

  test("a named font is quoted with a generic fallback; a generic family is not quoted", () => {
    const named = resolveTheme({ theme: themeCfg({ source: "file", font: "Caskaydia Mono" }) });
    expect(named.tokens["--vimma-font"]).toBe('"Caskaydia Mono", monospace');
    const generic = resolveTheme({ theme: themeCfg({ source: "file", font: "sans-serif" }) });
    expect(generic.tokens["--vimma-font"]).toBe("sans-serif");
  });
});

describe("untrusted input cannot inject CSS", () => {
  const evil = "red; } * { background: url(http://evil/) } :root {";

  test("resolveTheme drops a non-hex overlay colour with an error", () => {
    const r = resolveTheme({ theme: themeCfg({ source: "file", colors: { accent: evil } }) });
    expect(r.errors).toEqual([
      expect.objectContaining({
        path: "theme.colors.accent",
        message: expect.stringMatching(/hex/),
      }),
    ]);
    expect(r.tokens["--vimma-accent"]).toBe("#2cf5d2");
    expect(tokensToCss(r.tokens)).not.toContain("evil");
  });

  test("resolveTheme drops unknown overlay keys and a bad mode with errors", () => {
    const r = resolveTheme({
      theme: themeCfg({ source: "file", colors: { "--x": "#fff", mode: evil } }),
    });
    expect(r.errors.map((e) => e.path)).toEqual(["theme.colors.--x", "theme.colors.mode"]);
    expect(r.mode).toBe("dark");
    expect(r.tokens["--vimma-color-scheme"]).toBe("dark");
  });

  test("a font with a long run of blanks is trimmed in linear time (CodeQL js/polynomial-redos)", () => {
    const font = `x${" ".repeat(200_000)}y`;
    const start = performance.now();
    const r = resolveTheme({ theme: themeCfg({ source: "file", font }) });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(r.tokens["--vimma-font"]).toBe(`"${font}", monospace`);
  });

  test("a hostile font stays inside one quoted CSS string", () => {
    const font = 'x"; } * { background: url(http://evil/) } :root { --a: "\\\n';
    const r = resolveTheme({ theme: themeCfg({ source: "file", font }) });
    expect(r.tokens["--vimma-font"]).toBe(
      '"x\\"; } * { background: url(http://evil/) } :root { --a: \\"\\\\\\a ", monospace',
    );
    expect(() => tokensToCss(r.tokens)).not.toThrow();
  });

  test.each([
    [{ "--vimma-bg": evil }],
    [{ "--vimma-bg": "#fff" }],
    [{ "--vimma-bg; } * {": "#ffffff" }],
    [{ "--vimma-color-scheme": "dark; }" }],
    [{ "--vimma-font": "x; } * { color: red" }],
    [{ "--vimma-font": '"a" } b' }],
  ])("tokensToCss rejects %j", (tokens) => {
    expect(() => tokensToCss(tokens)).toThrow(TypeError);
  });

  test.each([["dark"], ["light"]])("tokensToCss accepts color-scheme %s", (v) => {
    expect(tokensToCss({ "--vimma-color-scheme": v })).toContain(`: ${v};`);
  });

  test("tokensToCss rejects a selector that could close the rule", () => {
    expect(() => tokensToCss({}, ":root } * {")).toThrow(TypeError);
  });
});

describe("tokens", () => {
  test("every mode, and the pending prefix, has a status-bar badge", () => {
    expect([...BADGES].sort()).toEqual([...MODES, "prefix"].sort());
  });

  // docs/specs/element-focus.md decision 17.
  test("element focus: an outline token from the accent, a badge apart from VISUAL's", () => {
    const outline = THEME_TOKENS.find((t) => t.name === "--vimma-element-outline");
    expect(outline).toMatchObject({ from: "accent" });
    const r = resolveTheme({ theme: themeCfg() });
    expect(r.tokens["--vimma-element-outline"]).toBe(r.tokens["--vimma-accent"]);
    for (const [name, theme] of Object.entries(BUILTIN_THEMES)) {
      for (const appearance of /** @type {const} */ (["dark", "light"])) {
        if (!theme[appearance]) continue;
        const cfg = themeCfg({ name, appearance });
        const t = resolveTheme({ theme: cfg }).tokens;
        expect(t["--vimma-mode-element"], `${name} ${appearance}`).not.toBe(
          t["--vimma-mode-visual"],
        );
        const fg = /** @type {string} */ (t["--vimma-mode-element-fg"]);
        const bg = /** @type {string} */ (t["--vimma-mode-element"]);
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  // Every theme Vimma ships or is tested with: the built-ins in each variant, and each fixture.
  const badgeThemes = () => {
    /** @type {[string, ReturnType<typeof resolveTheme>][]} */
    const out = [];
    for (const [name, theme] of Object.entries(BUILTIN_THEMES)) {
      for (const appearance of /** @type {const} */ (["dark", "light"])) {
        if (theme[appearance])
          out.push([
            `${name} ${appearance}`,
            resolveTheme({ theme: themeCfg({ name, appearance }) }),
          ]);
      }
    }
    const omarchy = themeCfg({ source: "omarchy" });
    for (const file of [
      "tokyo-night.colors.toml",
      "light.colors.toml",
      "event-horizon.colors.toml",
      "catppuccin.colors.toml",
    ]) {
      out.push([file, resolveTheme({ theme: omarchy, omarchy: fixture(file) })]);
    }
    return out;
  };

  test("every badge has a colour of its own, apart from every other badge's", () => {
    for (const [name, r] of badgeThemes()) {
      expect(r.errors, name).toEqual([]);
      const colours = BADGES.map((b) => /** @type {string} */ (r.tokens[`--vimma-mode-${b}`]));
      for (let i = 0; i < BADGES.length; i++) {
        for (let j = i + 1; j < BADGES.length; j++) {
          const d = colorDistance(
            /** @type {string} */ (colours[i]),
            /** @type {string} */ (colours[j]),
          );
          expect(
            d,
            `${name}: ${BADGES[i]} ${colours[i]} vs ${BADGES[j]} ${colours[j]}`,
          ).toBeGreaterThanOrEqual(MIN_BADGE_DISTANCE);
        }
      }
    }
  });

  // A theme of nine greys has no room for ten greys MIN_BADGE_DISTANCE apart.
  test("a monochrome theme still gives every badge a grey of its own", () => {
    const t = resolveTheme({
      theme: themeCfg({ source: "omarchy" }),
      omarchy: fixture("mono.colors.toml"),
    }).tokens;
    const colours = BADGES.map((b) => /** @type {string} */ (t[`--vimma-mode-${b}`]));
    for (let i = 0; i < colours.length; i++) {
      for (let j = i + 1; j < colours.length; j++) {
        // Twice the just-noticeable difference (delta E 2.3).
        const d = colorDistance(
          /** @type {string} */ (colours[i]),
          /** @type {string} */ (colours[j]),
        );
        expect(d, `${BADGES[i]} vs ${BADGES[j]}`).toBeGreaterThanOrEqual(5);
      }
    }
  });

  test("every badge's text reaches WCAG AA on it", () => {
    const mono = resolveTheme({
      theme: themeCfg({ source: "omarchy" }),
      omarchy: fixture("mono.colors.toml"),
    });
    for (const [name, r] of [...badgeThemes(), ["mono.colors.toml", mono]]) {
      for (const b of BADGES) {
        const fg = /** @type {string} */ (r.tokens[`--vimma-mode-${b}-fg`]);
        const bg = /** @type {string} */ (r.tokens[`--vimma-mode-${b}`]);
        expect(contrastRatio(fg, bg), `${name} ${b}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
      expect(
        r.warnings.filter((w) => w.includes("--vimma-mode-")),
        name,
      ).toEqual([]);
    }
  });

  test("a badge whose slot repeats an earlier badge's colour takes a shade of it", () => {
    // catppuccin.colors.toml: color13 is color5, and with no orange, orange is yellow.
    const t = resolveTheme({
      theme: themeCfg({ source: "omarchy" }),
      omarchy: fixture("catppuccin.colors.toml"),
    }).tokens;
    // The earlier badge keeps its slot.
    expect(t["--vimma-mode-visual"]).toBe("#cba6f7");
    expect(t["--vimma-mode-command"]).toBe("#f9e2af");
    // The later one is its slot's colour 15% toward black: the first step far enough from both.
    expect(t["--vimma-mode-element"]).toBe("#ad8dd2");
    expect(t["--vimma-mode-hint"]).toBe("#d4c095");
    // No other badge moves to make room.
    expect(t["--vimma-mode-help"]).toBe("#94e2d5");
    expect(t["--vimma-mode-panel"]).toBe("#89b4fa");
    expect(t["--vimma-mode-prefix"]).toBe("#f38ba8");
  });

  test("badges that keep their slots apart keep the slot's colour", () => {
    const t = resolveTheme({ theme: themeCfg({ name: "vimma", appearance: "dark" }) }).tokens;
    expect(t["--vimma-mode-visual"]).toBe(VIMMA_DARK.magenta);
    expect(t["--vimma-mode-element"]).toBe(VIMMA_DARK.bright_magenta);
    expect(t["--vimma-mode-hint"]).toBe(VIMMA_DARK.orange);
    expect(t["--vimma-mode-prefix"]).toBe(VIMMA_DARK.red);
  });

  // The normal badge is the aqua: insert's green and help's cyan must stay apart from it, and from
  // each other, without badgeColors having to move them.
  test.each([
    ["dark", VIMMA_DARK],
    ["light", VIMMA_LIGHT],
  ])("vimma %s keeps insert and help apart from the aqua normal badge", (appearance, palette) => {
    const t = resolveTheme({ theme: themeCfg({ name: "vimma", appearance }) }).tokens;
    expect(t["--vimma-mode-normal"]).toBe(palette.accent);
    expect(t["--vimma-mode-insert"]).toBe(palette.green);
    expect(t["--vimma-mode-help"]).toBe(palette.cyan);
    const apart = 2 * MIN_BADGE_DISTANCE;
    expect(colorDistance(palette.accent, palette.green)).toBeGreaterThanOrEqual(apart);
    expect(colorDistance(palette.accent, palette.cyan)).toBeGreaterThanOrEqual(apart);
    expect(colorDistance(palette.green, palette.cyan)).toBeGreaterThanOrEqual(apart);
  });

  test("colorDistance is CIE76 delta E: 0 for one colour, 100 from black to white", () => {
    expect(colorDistance("#cba6f7", "#CBA6F7")).toBe(0);
    expect(colorDistance("#000000", "#ffffff")).toBeCloseTo(100, 1);
  });

  test("every palette key has a token, and every token has a value", () => {
    const r = resolveTheme({ theme: themeCfg({ source: "file" }) });
    const names = THEME_TOKENS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(r.tokens).sort()).toEqual([...names].sort());
    for (const key of PALETTE_KEYS) {
      if (key === "mode") continue;
      expect(THEME_TOKENS.some((t) => t.from === key)).toBe(true);
    }
  });

  test("tokensToCss emits one declaration per token inside the selector", () => {
    const r = resolveTheme({ theme: themeCfg({ source: "file" }) });
    const css = tokensToCss(r.tokens);
    expect(css.startsWith(":root {\n")).toBe(true);
    expect(css).toContain("  --vimma-bg: #071011;\n");
    expect(css.match(/--vimma-[a-z-]+:/g)).toHaveLength(THEME_TOKENS.length);
    expect(tokensToCss({ "--vimma-bg": "#000000" }, "#vimma-root")).toBe(
      "#vimma-root {\n  --vimma-bg: #000000;\n}\n",
    );
  });
});

describe("built-in palettes", () => {
  test('"vimma" is the default; "tokyo-night" stays available by name', () => {
    expect(DEFAULT_THEME_NAME).toBe("vimma");
    expect(defaults.name).toBe("vimma");
    expect(Object.keys(BUILTIN_THEMES).sort()).toEqual(["tokyo-night", "vimma"]);
    expect(BUILTIN_THEMES.vimma).toEqual({ dark: VIMMA_DARK, light: VIMMA_LIGHT });
    expect(BUILTIN_THEMES["tokyo-night"]?.dark).toBe(TOKYO_NIGHT);
    expect(BUILTIN_THEMES["tokyo-night"]?.light).toBeUndefined();
  });

  test.each([
    ["dark", VIMMA_DARK],
    ["light", VIMMA_LIGHT],
  ])("vimma %s has every palette key as #rrggbb", (mode, palette) => {
    expect(Object.keys(palette).sort()).toEqual([...PALETTE_KEYS].sort());
    expect(palette.mode).toBe(mode);
    for (const key of PALETTE_KEYS) {
      if (key !== "mode") expect(palette[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // vimma.dev's assets/css/site.css (vimma-browser/vimma-site): the colours the site has. The
  // site's --green is a shade of the aqua there; Vimma's green is the insert badge, which must not
  // read as the normal badge's aqua, so it stays a green and is not matched.
  test.each([
    [
      "dark",
      VIMMA_DARK,
      {
        background: "#071011",
        dark_background: "#050c0d",
        darker_background: "#030708",
        lighter_background: "#0e1b1c",
        selection: "#123532",
        muted: "#234040",
        foreground: "#c2d6d3",
        dark_foreground: "#7f9a96",
        bright_foreground: "#f5fffd",
        accent: "#2cf5d2",
        magenta: "#ff4fb8",
        yellow: "#f2c94c",
        red: "#ff6b6b",
      },
    ],
    [
      "light",
      VIMMA_LIGHT,
      {
        background: "#f3f6f4",
        dark_background: "#e7ecea",
        darker_background: "#dde3e1",
        lighter_background: "#fbfdfc",
        selection: "#c3efe6",
        muted: "#a0b3af",
        foreground: "#1b2a28",
        dark_foreground: "#4a5b58",
        bright_foreground: "#071011",
        accent: "#006b5e",
        magenta: "#b0226f",
        yellow: "#7a5200",
        red: "#a1232d",
      },
    ],
  ])("vimma %s takes vimma.dev's colours", (_mode, palette, site) => {
    expect(palette).toMatchObject(site);
  });
});

describe("themeStylesheet", () => {
  test("the built-in vimma: dark tokens, then light ones under prefers-color-scheme: light", () => {
    const r = themeStylesheet({ theme: themeCfg({ source: "file" }) });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    const dark = tokensToCss(resolveTheme({ theme: themeCfg({ source: "file" }) }).tokens);
    const light = tokensToCss(
      resolveTheme({ theme: themeCfg({ source: "file" }), scheme: "light" }).tokens,
    );
    expect(r.css).toBe(`${dark}@media (prefers-color-scheme: light) {\n${light}}\n`);
  });

  test("the fallback vimma (source omarchy, no Omarchy file) follows the scheme too", () => {
    const r = themeStylesheet({ theme: themeCfg() });
    expect(r.css).toContain("@media (prefers-color-scheme: light)");
    expect(r.warnings).toEqual([]);
  });

  test("Tokyo Night, an Omarchy theme and a pinned mode are one block", () => {
    const one = [
      themeStylesheet({ theme: tokyoCfg({ source: "file" }) }),
      themeStylesheet({ theme: themeCfg(), omarchy: fixture("light.colors.toml") }),
      themeStylesheet({ theme: themeCfg({ source: "file", colors: { mode: "dark" } }) }),
    ];
    for (const r of one) {
      expect(r.css).not.toContain("@media");
      expect(r.css.match(/\{/g)).toHaveLength(1);
    }
  });

  test("a fixed scheme is passed to web pages; one that follows the system is not", () => {
    const fixed = [
      [themeStylesheet({ theme: themeCfg({ source: "file", appearance: "light" }) }), "light"],
      [themeStylesheet({ theme: themeCfg({ source: "file", appearance: "dark" }) }), "dark"],
      [themeStylesheet({ theme: tokyoCfg({ source: "file" }) }), "dark"],
      [themeStylesheet({ theme: themeCfg(), omarchy: fixture("light.colors.toml") }), "light"],
      [
        themeStylesheet({ theme: themeCfg({ source: "file", colors: { mode: "light" } }) }),
        "light",
      ],
    ];
    for (const [r, mode] of fixed) {
      expect(r.css).toContain(`  --vimma-content-color-scheme: ${mode};\n`);
      expect(r.css).toContain(`  --vimma-color-scheme: ${mode};\n`);
    }
    for (const r of [
      themeStylesheet({ theme: themeCfg({ source: "file" }) }),
      themeStylesheet({ theme: themeCfg() }),
      themeStylesheet({ theme: themeCfg({ source: "file", appearance: "system" }) }),
    ]) {
      expect(r.css).not.toContain("--vimma-content-color-scheme");
    }
  });

  test("tokensToCss takes only dark or light for the content colour scheme", () => {
    expect(tokensToCss({ "--vimma-content-color-scheme": "light" })).toContain(": light;");
    expect(() => tokensToCss({ "--vimma-content-color-scheme": "normal" })).toThrow(TypeError);
  });

  test("a selector reaches both blocks; light-only contrast warnings say so", () => {
    const r = themeStylesheet({
      theme: themeCfg({ source: "file", colors: { foreground: "#ffffff" } }),
      selector: "#x",
    });
    expect(r.css.match(/#x \{/g)).toHaveLength(2);
    expect(r.warnings).toContainEqual(expect.stringMatching(/^light: --vimma-fg on --vimma-bg/));
    expect(r.warnings.filter((w) => !w.startsWith("light: "))).toEqual([]);
  });
});
