/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anys } from "./jsdoc-any.ts";

// Issue #1243: the browser mochitests are type-checked JavaScript (tests/tsconfig.json), and an
// `any` in a test hides what it hides in product code: a renamed result field or a wrong argument
// shape type-checks and only fails, or silently passes, at run time. This count keeps new ones out;
// the agent and MCP tests (SECOND_SLICE) and the control client's messages they read are still to
// be typed.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS = join(ROOT, "tests/browser");
/** The agent and MCP tests, the second slice of #1243. */
const SECOND_SLICE = /^browser_vimma_(mcp|agent)_.*\.js$/;
/**
 * The `any` types (with a bare `*` or `?`) left in tests/browser after #1243's first slice: the
 * agent and MCP tests', and the control client's messages (head_vimma_control.js), which only
 * those tests read deeply.
 */
const MAX_ANY = 222;

/** The mochitests, their head files and their .sjs handlers (tsc checks only the .js). */
function sources(filter: (name: string) => boolean = () => true): string[] {
  return readdirSync(TESTS)
    .filter((name) => /\.s?js$/.test(name) && filter(name))
    .map((name) => join(TESTS, name));
}

describe("the browser mochitests' any ratchet (#1243)", () => {
  it("has no any outside the agent and MCP tests but the control client's messages", () => {
    const found = sources((name) => !SECOND_SLICE.test(name)).flatMap((p) => anys(ROOT, p));
    expect(found).toEqual(["tests/browser/head_vimma_control.js: any[]"]);
  });

  it(`has at most ${MAX_ANY} any in tests/browser`, () => {
    const found = sources().flatMap((p) => anys(ROOT, p));
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(MAX_ANY);
  });
});
