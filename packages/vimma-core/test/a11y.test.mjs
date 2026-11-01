import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mergeWithDefaults } from "../src/config.mjs";
import { MODES } from "../src/modes.mjs";
import { WORKSPACE_COLOR_TOKENS, statusAnnouncement, statusSegments } from "../src/statusbar.mjs";
import {
  BADGES,
  FOCUS_SURFACE_TOKENS,
  MIN_CONTRAST,
  MIN_FOCUS_CONTRAST,
  SURFACE_TOKENS,
  TEXT_TOKENS,
  contrastRatio,
  resolveTheme,
} from "../src/theme.mjs";

// Spec docs/specs/m7-a11y.md: what the status bar speaks, and WCAG AA contrast of every text
// token Vimma's chrome draws, on every surface it draws it on, in both variants of the built-in
// vimma palette, the built-in Tokyo Night and a light theme; and WCAG non-text contrast (3:1) of
// the focus colour (focus rings, the focused pane's outline) on every surface it touches.

/** @import { Announced } from "../src/statusbar.mjs" */

/** @param {string} name */
const fixture = (name) =>
  readFileSync(new URL(`../../../tests/contract/theme/${name}`, import.meta.url), "utf8");
const theme = mergeWithDefaults({}).theme;

const THEMES = {
  "vimma dark (built in)": resolveTheme({ theme: { ...theme, source: "file" } }),
  "vimma light (built in)": resolveTheme({ theme: { ...theme, source: "file" }, scheme: "light" }),
  "Tokyo Night (built in)": resolveTheme({
    theme: { ...theme, source: "file", name: "tokyo-night" },
  }),
  "Tokyo Night (Omarchy)": resolveTheme({ theme, omarchy: fixture("tokyo-night.colors.toml") }),
  "a light theme (Catppuccin Latte)": resolveTheme({
    theme,
    omarchy: fixture("light.colors.toml"),
  }),
  "a base-only theme (Event Horizon)": resolveTheme({
    theme,
    omarchy: fixture("event-horizon.colors.toml"),
  }),
};

describe("statusAnnouncement: the mode, said once, and only where nothing else says it", () => {
  /** @type {Announced} */
  const start = { mode: "normal", notFound: null };

  /**
   * Feeds `inputs` one after another; the texts spoken.
   * @param {Array<{ mode: import("../src/modes.mjs").Mode,
   *   find?: import("../src/find.mjs").FindStatus | null, url?: string | null,
   *   agentWaiting?: number }>} inputs
   */
  const speak = (inputs, last = start) => {
    const said = [];
    for (const input of inputs) {
      const r = statusAnnouncement(last, input);
      if (r.text !== null) said.push(r.text);
      last = r.last;
    }
    return said;
  };

  test("a new mode is spoken, the same mode again is not", () => {
    expect(speak([{ mode: "insert" }, { mode: "insert" }, { mode: "normal" }])).toEqual([
      "insert mode",
      "normal mode",
    ]);
  });

  test.each([["help"], ["command"], ["panel"]])(
    "%s mode is not spoken: its own focused UI says it, and the way back is silent",
    (mode) => {
      expect(speak([{ mode: /** @type {any} */ (mode) }, { mode: "normal" }])).toEqual([]);
    },
  );

  test("hint, visual and resize mode have no focused UI: they and the way back are spoken", () => {
    expect(speak([{ mode: "hint" }, { mode: "normal" }])).toEqual(["hint mode", "normal mode"]);
    expect(speak([{ mode: "visual" }, { mode: "normal" }])).toEqual(["visual mode", "normal mode"]);
    expect(speak([{ mode: "resize" }])).toEqual(["resize mode"]);
  });

  test("a search that found nothing is spoken once, after the line closes", () => {
    const find = { query: "zzz", notFound: true };
    expect(
      speak([
        { mode: "command", find, url: "https://a/" },
        { mode: "normal", find, url: "https://a/" },
        { mode: "normal", find, url: "https://a/" },
      ]),
    ).toEqual(["Pattern not found: zzz"]);
  });

  test("the same failed search on another page, or again after a hit, is spoken again", () => {
    const miss = { query: "zzz", notFound: true };
    const hit = { query: "zzz", total: 2, current: 1 };
    expect(
      speak([
        { mode: "normal", find: miss, url: "https://a/" },
        { mode: "normal", find: miss, url: "https://b/" },
        { mode: "normal", find: hit, url: "https://b/" },
        { mode: "normal", find: miss, url: "https://b/" },
      ]),
    ).toEqual(["Pattern not found: zzz", "Pattern not found: zzz", "Pattern not found: zzz"]);
  });

  test("a mode change and a failed search at once are one message", () => {
    expect(speak([{ mode: "insert", find: { query: "q", notFound: true }, url: "u" }])).toEqual([
      "insert mode. Pattern not found: q",
    ]);
  });

  // docs/specs/vimma-mcp.md decision 24: a question that waits is said once.
  test("an agent question waiting is spoken when the count rises, not again while it waits", () => {
    expect(
      speak([
        { mode: "normal", agentWaiting: 1 },
        { mode: "normal", agentWaiting: 1 },
        { mode: "normal", agentWaiting: 2 },
        { mode: "normal", agentWaiting: 0 },
        { mode: "normal", agentWaiting: 1 },
      ]),
    ).toEqual([
      "Agent request waiting: ctrl+b shift+a to answer",
      "2 agent requests waiting",
      "Agent request waiting: ctrl+b shift+a to answer",
    ]);
  });

  // docs/specs/element-focus.md decision 16: the focused block's kind and length, on each move.
  test("element focus says the block's kind and length on focus and on each move", () => {
    const p = { kind: "paragraph", length: 412, seq: 1 };
    expect(
      speak([
        { mode: "element" },
        { mode: "element", element: p },
        { mode: "element", element: p },
        { mode: "element", element: { kind: "list item", length: 1, seq: 2 } },
        { mode: "element", element: { kind: "list item", length: 1, seq: 3 } },
        { mode: "normal" },
      ]),
    ).toEqual([
      "element mode. paragraph, 412 characters",
      "list item, 1 character",
      "list item, 1 character",
      "normal mode",
    ]);
  });

  test("every mode has an answer and the result is a fresh object", () => {
    for (const mode of MODES) {
      const r = statusAnnouncement(start, { mode });
      expect(r.last).not.toBe(start);
      expect(typeof r.text === "string" || r.text === null).toBe(true);
    }
  });
});

describe("contrast (WCAG 2.x AA, 4.5:1)", () => {
  test("the built-in vimma's two variants are the light and the dark one", () => {
    expect(THEMES["vimma dark (built in)"].mode).toBe("dark");
    expect(THEMES["vimma light (built in)"].mode).toBe("light");
    expect(THEMES["Tokyo Night (built in)"].tokens["--vimma-bg"]).toBe("#1a1b26");
  });

  test("the text tokens and surfaces checked are theme tokens", () => {
    const tokens = THEMES["Tokyo Night (built in)"].tokens;
    for (const t of [...TEXT_TOKENS, ...SURFACE_TOKENS]) expect(tokens[t], t).toMatch(/^#/);
  });

  for (const [name, r] of Object.entries(THEMES)) {
    test(`${name}: every text token on every surface`, () => {
      const failures = [];
      for (const fg of TEXT_TOKENS) {
        for (const bg of SURFACE_TOKENS) {
          const ratio = contrastRatio(String(r.tokens[fg]), String(r.tokens[bg]));
          if (ratio < MIN_CONTRAST) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
      expect(r.warnings.filter((w) => w.includes("WCAG"))).toEqual([]);
    });

    test(`${name}: link hints and every mode badge`, () => {
      const pairs = [
        ["--vimma-hint-fg", "--vimma-hint-bg"],
        ...BADGES.map((b) => [`--vimma-mode-${b}-fg`, `--vimma-mode-${b}`]),
      ];
      for (const [fg, bg] of pairs) {
        const ratio = contrastRatio(String(r.tokens[fg]), String(r.tokens[bg]));
        expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
    });
  }

  for (const [name, r] of Object.entries(THEMES)) {
    test(`${name}: the focus colour reaches ${MIN_FOCUS_CONTRAST}:1 on every surface it touches`, () => {
      const failures = [];
      for (const bg of FOCUS_SURFACE_TOKENS) {
        const ratio = contrastRatio(String(r.tokens["--vimma-focus"]), String(r.tokens[bg]));
        if (ratio < MIN_FOCUS_CONTRAST)
          failures.push(`--vimma-focus on ${bg}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }

  test("the focus surfaces are the text surfaces plus the pane gap (--vimma-muted)", () => {
    expect(FOCUS_SURFACE_TOKENS).toEqual([...SURFACE_TOKENS, "--vimma-muted"]);
    expect(MIN_FOCUS_CONTRAST).toBe(3);
  });

  test("the focus colour is the accent wherever the accent already reaches 3:1", () => {
    for (const name of [
      "vimma dark (built in)",
      "Tokyo Night (built in)",
      "Tokyo Night (Omarchy)",
    ]) {
      const t = /** @type {any} */ (THEMES)[name].tokens;
      expect(t["--vimma-focus"], name).toBe(t["--vimma-accent"]);
    }
    // vimma light's #006b5e is 2.93:1 on its pane gap (#a0b3af): one 5% step toward black.
    const light = THEMES["vimma light (built in)"].tokens;
    expect(light["--vimma-accent"]).toBe("#006b5e");
    expect(light["--vimma-focus"]).toBe("#006659");
  });

  test("every status bar segment without a badge draws in a checked text token", () => {
    const text = new Set(TEXT_TOKENS);
    const segs = statusSegments({
      mode: "normal",
      pending: ["g"],
      workspace: { name: "w", index: 1, color: "yellow" },
      tab: { index: 1, count: 2, title: "t", url: "https://a/" },
      pane: { index: 1, count: 2 },
      loading: true,
      find: { query: "q", notFound: true },
      configErrors: [{ line: 1, path: "x", message: "bad" }],
      alerts: ["containers are off"],
    });
    for (const s of segs.filter((seg) => !seg.bg)) expect(text.has(s.fg), s.fg).toBe(true);
    for (const t of Object.values(WORKSPACE_COLOR_TOKENS)) expect(text.has(t), t).toBe(true);
  });

  test("a palette's own colour stays as given; only its text token is made readable", () => {
    const r = THEMES["a light theme (Catppuccin Latte)"];
    expect(r.tokens["--vimma-yellow"]).toBe("#df8e1d");
    expect(r.tokens["--vimma-text-yellow"]).not.toBe("#df8e1d");
    const tokyo = THEMES["Tokyo Night (built in)"];
    expect(tokyo.tokens["--vimma-text-yellow"]).toBe(tokyo.tokens["--vimma-yellow"]);
  });
});
