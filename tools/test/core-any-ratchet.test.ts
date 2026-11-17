/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anyCount, anys, jsdocTypes } from "./jsdoc-any.ts";

// Issue #1225: vimma-core stays JavaScript with JSDoc (ADR-025, decision 6), and `tsc --checkJs`
// accepts `any` there, which turns its checks off. The slices of #1225 replace each `any` with
// the real type; this count keeps new ones out. Every slice is done and none is left: a change
// that needs a new `any` says why in its pull request and raises MAX_ANY.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "packages/vimma-core/src");
/** Third-party code, checked by its own project. */
const VENDOR = join(SRC, "vendor");
/** The `any` types (with a bare `*` or `?`) left in vimma-core's src/ after #1225: none. */
const MAX_ANY = 0;

/** Every .mjs and .js file under `dir`, but vendor/. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return path === VENDOR ? [] : sources(path);
    return /\.m?js$/.test(e.name) ? [path] : [];
  });
}

describe("vimma-core's any ratchet (#1225)", () => {
  it("counts `*` and `?`, which checkJs reads as any, and each any in a type", () => {
    expect(anyCount("*")).toBe(1);
    expect(anyCount(" ? ")).toBe(1);
    expect(anyCount("Record<string, any> | any[]")).toBe(2);
    expect(anyCount("Array<*>")).toBe(1);
    expect(anyCount("*[] | Map<string, *>")).toBe(2);
    expect(anyCount("* | null")).toBe(1);
    expect(anyCount("(*)")).toBe(1);
    expect(anyCount("x ** 2")).toBe(0);
    expect(anyCount("{ a: string,\n *   b: number }")).toBe(0);
    expect(anyCount("?string")).toBe(0);
    expect(anyCount("string")).toBe(0);
  });

  it("finds the type expressions of JSDoc tags, not prose", () => {
    const src = [
      "/** Takes any key. @param {Record<string, any>} a @returns {{ b: { c: any[] } }} */",
      "/**",
      " * @typedef {{ d: string,",
      " *   e: any }} F  any case",
      " */",
      "const any = 1; // { any }",
    ].join("\n");
    expect(jsdocTypes(src).map((t) => t.replace(/\s+/g, " "))).toEqual([
      "Record<string, any>",
      "{ b: { c: any[] } }",
      "{ d: string, * e: any }",
    ]);
  });

  it("has no any in packages/vimma-core/src/agent, #1225's first slice", () => {
    const found = sources(join(SRC, "agent")).flatMap((p) => anys(ROOT, p));
    expect(found).toEqual([]);
  });

  it(`has at most ${MAX_ANY} any in packages/vimma-core/src`, () => {
    const found = sources(SRC).flatMap((p) => anys(ROOT, p));
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(MAX_ANY);
  });
});
