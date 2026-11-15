/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headFiles, headTypes } from "../gen-mochitest-head.ts";

// The shared helpers of tests/browser (head.js, which the harness loads into every test, and the
// head_*.js files tests load with loadSubScript) are declared to the type check by
// types/mochitest/head.d.ts, which tsc generates from their JSDoc (npm run gen-mochitest-head).
describe("types/mochitest/head.d.ts (#959)", () => {
  it("covers every head file in tests/browser", () => {
    expect(headFiles()).toEqual(
      expect.arrayContaining(["tests/browser/head.js", "tests/browser/head_vimma_control.js"]),
    );
    for (const f of headFiles()) expect(f).toMatch(/^tests\/browser\/head(_[a-z_]+)?\.js$/);
  });

  it("is what the head files declare: run npm run gen-mochitest-head after editing one", async () => {
    const file = readFileSync(new URL("../../types/mochitest/head.d.ts", import.meta.url), "utf8");
    expect(file).toBe(await headTypes());
  }, 60_000);
});
