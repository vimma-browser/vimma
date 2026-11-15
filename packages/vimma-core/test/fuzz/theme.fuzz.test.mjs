// Fuzzing the Omarchy colors.toml reader (theme.mjs). A theme is a file anyone can publish, and
// its colours become CSS in Vimma's chrome. Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  PALETTE_KEYS,
  TOKYO_NIGHT,
  parseOmarchyColors,
  resolveTheme,
  tokensToCss,
} from "../../src/config/theme.mjs";
import { parseConfig } from "../../src/config/config.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";
import { tomlDoc } from "./toml-arb.mjs";

/** A stock-looking colors.toml with some values replaced by hostile ones. */
const colorsToml = fc
  .array(
    fc.tuple(
      fc.oneof(
        { weight: 8, arbitrary: fc.constantFrom(...PALETTE_KEYS) },
        { weight: 1, arbitrary: fc.constantFrom(...PROTO_NAMES, "hyprland_border") },
      ),
      fc.oneof(
        { weight: 6, arbitrary: fc.constantFrom('"#7aa2f7"', '"#FFF"', '"dark"', '"light"') },
        {
          weight: 2,
          arbitrary: fc.constantFrom(
            '"#fff;} body{background:url(https://evil/)}"',
            '"#fff\\n}"',
            '"red"',
            '"#12345g"',
            '"#ffff"',
            '"expression(alert(1))"',
            "0xffffff",
            "[]",
            "{}",
            "true",
          ),
        },
        { weight: 1, arbitrary: nastyString.map((s) => JSON.stringify(s)) },
      ),
    ),
    { maxLength: PALETTE_KEYS.length + 4 },
  )
  .chain((pairs) => {
    const given = new Map(pairs);
    // Usually a complete palette, so the token and CSS steps run too.
    return fc.boolean().map((complete) => {
      const lines = [...given].map(([k, v]) => `${JSON.stringify(k)} = ${v}`);
      if (complete) {
        for (const k of PALETTE_KEYS) {
          if (!given.has(k)) lines.push(`${k} = ${JSON.stringify(TOKYO_NIGHT[k])}`);
        }
      }
      return `${lines.join("\n")}\n`;
    });
  });

/** A font that config.toml accepts, from the same validator the host uses. */
const font = fc
  .oneof(fc.constantFrom("Caskaydia Mono", "monospace", "A, B, serif", " , ,"), nastyString)
  .filter((f) => parseConfig(`[theme]\nfont = ${JSON.stringify(f)}\n`).errors.length === 0);

describe("Omarchy colors.toml fuzzing", () => {
  test(
    "parseOmarchyColors never throws; a palette has every key, as #rrggbb or a mode",
    () =>
      fuzz(
        "theme-parse",
        fc.property(fc.oneof(colorsToml, tomlDoc), fc.boolean(), (text, lightMode) => {
          const r = within(2000, () => parseOmarchyColors(text, { lightMode }));
          expect(r.palette === null).toBe(r.errors.length > 0);
          if (!r.palette) return;
          expect(Object.keys(r.palette).sort()).toEqual([...PALETTE_KEYS].sort());
          for (const [k, v] of Object.entries(r.palette)) {
            if (k === "mode") expect(["dark", "light"]).toContain(v);
            else expect(v).toMatch(/^#[0-9a-f]{6}$/);
          }
        }),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "any theme file and any accepted font give CSS that tokensToCss accepts",
    () =>
      fuzz(
        "theme-css",
        fc.property(colorsToml, font, (text, f) => {
          const { tokens } = resolveTheme({
            theme: { source: "omarchy", font: f, colors: {} },
            omarchy: text,
          });
          const css = tokensToCss(tokens);
          // One rule, one declaration per line: nothing broke out of a value.
          expect(css.match(/[{}]/g)).toEqual(["{", "}"]);
          expect(css.split("\n").filter((l) => l.startsWith("  --vimma-")).length).toBe(
            Object.keys(tokens).length,
          );
        }),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "tokensToCss refuses any token value resolveTheme could not have made",
    () =>
      fuzz(
        "theme-css-refuses",
        fc.property(
          fc.dictionary(
            fc.oneof(fc.constantFrom("--vimma-bg", "--vimma-font"), nastyString),
            nastyString,
          ),
          (tokens) => {
            let css;
            try {
              css = tokensToCss(tokens);
            } catch (e) {
              expect(e).toBeInstanceOf(TypeError);
              return;
            }
            expect(css.match(/[{}]/g)).toEqual(["{", "}"]);
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "a hostile theme file is read in bounded time: deep, huge, many keys",
    () => {
      for (const text of [
        `${"a.".repeat(100_000)}b = 1`,
        `[${"a.".repeat(100_000)}b]`,
        `accent = "${"#".repeat(4 << 20)}"`,
        Array.from({ length: 50_000 }, (_, i) => `k${i} = "#fff"`).join("\n"),
        `x = ${"[".repeat(100_000)}`,
      ]) {
        const r = within(5000, () => parseOmarchyColors(text));
        expect(r.palette).toBeNull();
      }
    },
    FUZZ_TIMEOUT,
  );
});
