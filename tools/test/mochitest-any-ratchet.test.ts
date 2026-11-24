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
// shape type-checks and only fails, or silently passes, at run time. Each has its real type now,
// the control client's replies included; this count keeps new ones out. A change that needs a
// new `any` says why in its pull request and raises MAX_ANY.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TESTS = join(ROOT, "tests/browser");
/** The `any` types (with a bare `*` or `?`) left in tests/browser after #1243: none. */
const MAX_ANY = 0;

/** The mochitests, their head files and their .sjs handlers (tsc checks only the .js). */
function sources(): string[] {
  return readdirSync(TESTS)
    .filter((name) => /\.s?js$/.test(name))
    .map((name) => join(TESTS, name));
}

describe("the browser mochitests' any ratchet (#1243)", () => {
  it(`has at most ${MAX_ANY} any in tests/browser`, () => {
    const found = sources().flatMap((p) => anys(ROOT, p));
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(MAX_ANY);
  });
});
