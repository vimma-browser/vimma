/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { errorsByFile, ratchetErrors, readAllowlist } from "../mochitest-typecheck.ts";

// tools/mochitest-typecheck.ts runs tests/tsconfig.json's program (npm run typecheck) and holds
// it to tools/test/mochitest-allowlist.txt: the files there may still have type errors, every
// other file may not, and a listed file that has none must come off the list (issue #959).
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIST = new URL("mochitest-allowlist.txt", import.meta.url);

describe("the mochitest type-check ratchet (#959)", () => {
  it("groups tsc's errors by file, with each error's continuation lines", () => {
    const out = [
      "tests/browser/a.js(3,5): error TS2339: Property 'x' does not exist on type 'Y'.",
      "tests/browser/b.js(1,1): error TS2345: Argument of type 'A' is not assignable to 'B'.",
      "  Type 'A' is missing the following properties from type 'B': c",
      "tests/browser/a.js(9,2): error TS7006: Parameter 'w' implicitly has an 'any' type.",
      "",
    ].join("\n");
    expect(errorsByFile(out)).toEqual(
      new Map([
        [
          "tests/browser/a.js",
          [
            "tests/browser/a.js(3,5): error TS2339: Property 'x' does not exist on type 'Y'.",
            "tests/browser/a.js(9,2): error TS7006: Parameter 'w' implicitly has an 'any' type.",
          ],
        ],
        [
          "tests/browser/b.js",
          [
            "tests/browser/b.js(1,1): error TS2345: Argument of type 'A' is not assignable to 'B'.\n" +
              "  Type 'A' is missing the following properties from type 'B': c",
          ],
        ],
      ]),
    );
  });

  it("fails on errors in an unlisted file, and on a listed file that is clean or gone", () => {
    const errors = new Map([
      ["tests/browser/listed.js", ["tests/browser/listed.js(1,1): error TS2304: x"]],
      ["tests/browser/new.js", ["tests/browser/new.js(2,1): error TS2304: y"]],
    ]);
    const listed = ["tests/browser/clean.js", "tests/browser/gone.js", "tests/browser/listed.js"];
    const tracked = ["tests/browser/clean.js", "tests/browser/listed.js", "tests/browser/new.js"];
    expect(ratchetErrors(errors, listed, tracked)).toEqual([
      "tests/browser/new.js(2,1): error TS2304: y",
      "tests/browser/clean.js has no type errors now: take it off tools/test/mochitest-allowlist.txt",
      "tests/browser/gone.js is listed but not tracked: take it off tools/test/mochitest-allowlist.txt",
    ]);
  });

  it("never lets an error outside the listed test files through", () => {
    const errors = new Map([
      ["types/mochitest/harness.d.ts", ["types/mochitest/harness.d.ts(1,1): error TS2300: z"]],
    ]);
    expect(ratchetErrors(errors, [], [])).toEqual([
      "types/mochitest/harness.d.ts(1,1): error TS2300: z",
    ]);
  });

  it("passes when only listed files have errors", () => {
    const errors = new Map([["tests/browser/a.js", ["tests/browser/a.js(1,1): error TS2304: x"]]]);
    expect(ratchetErrors(errors, ["tests/browser/a.js"], ["tests/browser/a.js"])).toEqual([]);
  });

  it("reads one path per line and skips comments and blank lines", () => {
    expect(readAllowlist("# why\n\ntests/browser/a.js\n  tests/browser/b.js  \n")).toEqual([
      "tests/browser/a.js",
      "tests/browser/b.js",
    ]);
  });

  // Whether each listed file still has errors takes a full tsc run, which npm run typecheck
  // makes; this checks the list's shape.
  it("lists tracked JavaScript test files, sorted, each once", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "tests"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    const listed = readAllowlist(readFileSync(LIST, "utf8"));
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) {
      expect(tracked).toContain(p);
      expect(p).toMatch(/^tests\/.*\.js$/);
    }
    expect(listed).toEqual([...new Set(listed)].sort());
  });
});
