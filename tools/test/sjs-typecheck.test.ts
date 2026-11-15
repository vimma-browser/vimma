/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyName, sjsConfig, sourcePaths } from "../sjs-typecheck.ts";

// tools/sjs-typecheck.ts type-checks the .sjs handlers under tests/browser/ (issue #1070): tsc
// reads only .js and .ts files, so it checks copies named .js and reports each error at the
// .sjs file it came from.
describe("the .sjs type check (#1070)", () => {
  it("names each copy after its handler, so the copies cannot collide", () => {
    expect(copyName("tests/browser/file_vimma_slow.sjs")).toBe("file_vimma_slow.sjs.js");
  });

  it("reports an error at the .sjs file and line it came from", () => {
    const out = [
      "/tmp/x/file_a.sjs.js(3,5): error TS7006: Parameter 'r' implicitly has an 'any' type.",
      "/tmp/x/file_b.sjs.js(1,1): error TS2345: Argument of type 'A' is not assignable to 'B'.",
      "  Type 'A' is missing the following properties from type 'B': c",
      "types/sjs/sjs.d.ts(2,1): error TS2300: Duplicate identifier 'getState'.",
    ].join("\n");
    expect(sourcePaths(out, "/tmp/x", "tests/browser")).toBe(
      [
        "tests/browser/file_a.sjs(3,5): error TS7006: Parameter 'r' implicitly has an 'any' type.",
        "tests/browser/file_b.sjs(1,1): error TS2345: Argument of type 'A' is not assignable to 'B'.",
        "  Type 'A' is missing the following properties from type 'B': c",
        "types/sjs/sjs.d.ts(2,1): error TS2300: Duplicate identifier 'getState'.",
      ].join("\n"),
    );
  });

  // A handler runs in httpd.js's sandbox, not in a mochitest's scope: it gets Firefox's
  // declarations and the sandbox's globals, never the harness's (add_task, is, gBrowser).
  it("checks the copies with tests/tsconfig.json's options and the sandbox's globals only", () => {
    const config = sjsConfig("/repo/", "/tmp/x");
    expect(config.extends).toBe("/repo/tests/tsconfig.json");
    expect(config.include).toEqual([
      "/tmp/x/*.js",
      "/repo/types/*.d.ts",
      "/repo/types/mochitest/firefox.d.ts",
      "/repo/types/sjs/*.d.ts",
    ]);
    // Nothing left out, as in tests/tsconfig.json: the product modules types/vimma-modules.d.ts
    // brings in need types/firefox-modules.d.ts.
    expect(config.exclude).toEqual([]);
    expect(config.include.some((glob) => /harness|head|vimma\.d/.test(glob))).toBe(false);
  });

  // Each declaration file of types/sjs/ is in the program, and nothing else's program reads it:
  // tsconfig.json takes types/*.d.ts and tests/tsconfig.json types/mochitest/*.d.ts.
  it("keeps the sandbox's globals in a folder of their own", () => {
    const files = readdirSync(new URL("../../types/sjs/", import.meta.url));
    expect(files).toEqual(["sjs.d.ts"]);
  });
});
