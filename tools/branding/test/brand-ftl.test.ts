// Vimma's brand.ftl replaces the one Surfer generates from its template (spec
// firefox-surfaces-trim, delivery step 3), because the template lacks -brand-shortcut-name, which
// the Linux desktop entry and the private-browsing shortcut text reference. The names must stay
// those in surfer.json, and every term a stock Firefox brand defines must exist, or the strings
// that use it fail to resolve. The stock brand needs engine/; the plain CI job skips that check.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const OURS = `${root}src/browser/branding/vimma/locales/en-US/brand.ftl`;
const OFFICIAL = `${root}engine/browser/branding/official/locales/en-US/brand.ftl`;

/**
 * Term ids and their single-line values.
 *
 * @param {string} text Fluent source
 * @returns {Map<string, string>}
 */
function terms(text) {
  return new Map([...text.matchAll(/^(-[a-z][\w-]*) = (.*)$/gm)].map((m) => [m[1], m[2]]));
}

describe("Vimma brand.ftl", () => {
  const ours = existsSync(OURS) ? terms(readFileSync(OURS, "utf8")) : new Map();

  it("defines -brand-shortcut-name", () => {
    expect(ours.get("-brand-shortcut-name")).toBe("Vimma");
  });

  it("uses the names in surfer.json", () => {
    const brand = JSON.parse(readFileSync(`${root}surfer.json`, "utf8")).brands.vimma;
    expect(ours.get("-brand-shorter-name")).toBe(brand.brandShorterName);
    expect(ours.get("-brand-short-name")).toBe(brand.brandShortName);
    expect(ours.get("-brand-full-name")).toBe(brand.brandFullName);
    expect(ours.get("-brand-product-name")).toBe(brand.brandShortName);
    expect(ours.get("-vendor-short-name")).toBe("Vimma");
  });

  it.skipIf(!existsSync(OFFICIAL))("defines every term a stock Firefox brand defines", () => {
    const missing = [...terms(readFileSync(OFFICIAL, "utf8")).keys()].filter((t) => !ours.has(t));
    expect(missing).toEqual([]);
  });
});
