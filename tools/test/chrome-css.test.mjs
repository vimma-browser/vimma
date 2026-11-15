import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { TEXT_TOKENS } from "../../packages/vimma-core/src/config/theme.mjs";

// Spec docs/specs/m7-a11y.md: Vimma's chrome CSS draws text only in tokens whose contrast
// packages/vimma-core/test/a11y.test.mjs checks, dims nothing with opacity (which would undo
// that check), and moves nothing (prefers-reduced-motion then has nothing to turn off).

const cssDir = new URL("../../src/browser/themes/shared/vimma/", import.meta.url);
const uiDir = new URL("../../src/browser/base/content/vimma/", import.meta.url);
const sheets = readdirSync(cssDir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ name: f, text: readFileSync(new URL(f, cssDir), "utf8") }));

/** Text tokens picked for contrast against their own background (hint labels, mode badges). */
const TEXT_ON = /^--vimma-(hint|mode-[a-z]+)-fg$/;

/** @param {string} css  the declarations, comments dropped */
const declarations = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+);/g)].map(
    (m) => ({ property: m[1] ?? "", value: (m[2] ?? "").trim() }),
  );

describe("chrome CSS", () => {
  it("has sheets to check", () => {
    expect(sheets.length).toBeGreaterThan(5);
  });

  it("draws text only in tokens whose contrast is checked", () => {
    const allowed = new Set(TEXT_TOKENS);
    for (const { name, text } of sheets) {
      for (const { property, value } of declarations(text)) {
        if (property !== "color") continue;
        const token = /var\((--vimma-[a-z0-9-]+)/.exec(value)?.[1];
        if (!token) continue;
        expect(allowed.has(token) || TEXT_ON.test(token), `${name}: color: ${value}`).toBe(true);
      }
    }
  });

  it("points Firefox's text colour tokens only at tokens whose contrast is checked", () => {
    // firefox-*.css theme Firefox's surfaces through its own tokens (--text-color,
    // --panel-text-color, --link-color, ...): what they draw in is text too.
    const allowed = new Set(TEXT_TOKENS);
    const textToken = /^--[a-z-]*(text-color|link-color|icon-color|icon-fill)[a-z-]*$/;
    let checked = 0;
    for (const { name, text } of sheets) {
      for (const { property, value } of declarations(text)) {
        if (!textToken.test(property)) continue;
        const token = /^var\((--vimma-[a-z0-9-]+)\)/.exec(value)?.[1];
        if (!token) continue;
        checked++;
        expect(allowed.has(token) || TEXT_ON.test(token), `${name}: ${property}: ${value}`).toBe(
          true,
        );
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("never dims text with opacity", () => {
    for (const { name, text } of sheets) {
      for (const { property, value } of declarations(text)) {
        if (property === "opacity") expect(value, `${name}: opacity: ${value}`).toBe("1");
      }
    }
  });

  it("animates nothing, so prefers-reduced-motion has nothing to turn off", () => {
    for (const { name, text } of sheets) {
      for (const { property, value } of declarations(text)) {
        expect(property, `${name}: ${property}: ${value}`).not.toMatch(/^(transition|animation)/);
        if (property === "scroll-behavior") expect(value, name).not.toBe("smooth");
      }
    }
  });

  it("scrolls the UI's lists without smooth scrolling", () => {
    for (const sub of ["ui", "about", "start"]) {
      const dir = new URL(`${sub}/`, uiDir);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
        expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/behavior:\s*["']smooth/);
      }
    }
  });
});
