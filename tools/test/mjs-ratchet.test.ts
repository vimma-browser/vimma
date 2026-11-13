/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-025 decision 1: new Node code under tools/ is TypeScript, and the .mjs files there move to
// .ts area by area (#946). mjs-allowlist.txt lists the .mjs files still waiting: a new .mjs, .js
// or .cjs file fails here, and so does a listed file that is gone, so each move takes its files
// off the list. Outside the rule: tools/claude-plugin and the guards workflows run from the base
// branch (BASE_GUARDS), which stay .mjs (decision 7), and a script a browser page loads, which is a
// .js file in a fixtures/ folder.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIST = new URL("mjs-allowlist.txt", import.meta.url);

/** The listed paths: one per line, `#` starts a comment line. */
function readAllowlist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * The guards ci.yml, e2e.yml and key-guard.yml run from the base branch on the runner's own Node,
 * with nothing of the pull request run before them, and key-guard's test, which the guard's
 * GUARD_PATHS names: they stay .mjs for good (ADR-025, decision 7).
 */
const BASE_GUARDS = [
  "tools/ci/docs-only.mjs",
  "tools/ci/key-guard.mjs",
  "tools/ci/test/key-guard.test.mjs",
];

/** Whether a tracked path is JavaScript that Node runs under tools/, which the rule covers. */
function nodeJavaScript(p: string): boolean {
  if (!p.startsWith("tools/") || p.startsWith("tools/claude-plugin/")) return false;
  if (BASE_GUARDS.includes(p)) return false;
  if (p.endsWith(".js") && p.includes("/fixtures/")) return false; // a script a page loads
  return /\.(?:mjs|cjs|js)$/.test(p);
}

/** What breaks the ratchet: Node JavaScript under tools/ off the list, a listed file gone. */
function ratchetErrors(tracked: string[], listed: string[]): string[] {
  const mjs = tracked.filter(nodeJavaScript);
  return [
    ...mjs.filter((p) => !listed.includes(p)).map((p) => `${p} is new: write it as .ts (ADR-025)`),
    ...listed
      .filter((p) => !mjs.includes(p))
      .map((p) => `${p} is listed but not tracked: take it off tools/test/mjs-allowlist.txt`),
  ];
}

describe("the .mjs files left under tools/ (ADR-025, #946)", () => {
  it("fails on a new .mjs file and on a listed file that is gone", () => {
    const listed = ["tools/a/old.mjs", "tools/a/moved.mjs"];
    const tracked = ["tools/a/old.mjs", "tools/a/moved.ts", "tools/b/new.mjs", "src/x.mjs"];
    expect(ratchetErrors(tracked, listed)).toEqual([
      "tools/b/new.mjs is new: write it as .ts (ADR-025)",
      "tools/a/moved.mjs is listed but not tracked: take it off tools/test/mjs-allowlist.txt",
    ]);
  });

  it("sees new .js and .cjs Node files too, but not a script a page loads from fixtures/", () => {
    const tracked = [
      "tools/b/new.js",
      "tools/b/new.cjs",
      "tools/promo/fixtures/probe.js",
      "tools/e2e/test/fixtures/page/app.js",
      "tools/b/fixtures/node-helper.mjs",
    ];
    expect(ratchetErrors(tracked, [])).toEqual([
      "tools/b/new.js is new: write it as .ts (ADR-025)",
      "tools/b/new.cjs is new: write it as .ts (ADR-025)",
      "tools/b/fixtures/node-helper.mjs is new: write it as .ts (ADR-025)",
    ]);
  });

  it("leaves tools/claude-plugin's hooks out: they stay .mjs (decision 7)", () => {
    expect(ratchetErrors(["tools/claude-plugin/hooks/guard.mjs"], [])).toEqual([]);
  });

  it("leaves the base-branch guards out: they stay .mjs (decision 7)", () => {
    expect(ratchetErrors(BASE_GUARDS, [])).toEqual([]);
    expect(ratchetErrors(["tools/ci/tree-covered.mjs"], [])).toEqual([
      "tools/ci/tree-covered.mjs is new: write it as .ts (ADR-025)",
    ]);
  });

  it("reads one path per line and skips comments and blank lines", () => {
    expect(readAllowlist("# why\n\ntools/a/x.mjs\n  tools/b/y.mjs  \n")).toEqual([
      "tools/a/x.mjs",
      "tools/b/y.mjs",
    ]);
  });

  it("lists exactly the .mjs files git tracks under tools/, sorted", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "tools"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    const listed = readAllowlist(readFileSync(LIST, "utf8"));
    expect(ratchetErrors(tracked, listed)).toEqual([]);
    expect(listed).toEqual([...listed].sort());
  });
});
