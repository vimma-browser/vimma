/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ADR-025 decision 1: new code under tools/ is TypeScript, and the .mjs files there move to .ts
// area by area (#946). mjs-allowlist.txt lists the .mjs files still waiting: a new .mjs file
// fails here, and so does a listed file that is gone, so each move takes its files off the list.
// tools/claude-plugin stays .mjs (decision 7) and is not listed.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIST = new URL("mjs-allowlist.txt", import.meta.url);

/** The listed paths: one per line, `#` starts a comment line. */
function readAllowlist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** What breaks the ratchet: a tracked .mjs file under tools/ off the list, a listed file gone. */
function ratchetErrors(tracked: string[], listed: string[]): string[] {
  const mjs = tracked.filter(
    (p) => p.startsWith("tools/") && p.endsWith(".mjs") && !p.startsWith("tools/claude-plugin/"),
  );
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

  it("leaves tools/claude-plugin's hooks out: they stay .mjs (decision 7)", () => {
    expect(ratchetErrors(["tools/claude-plugin/hooks/guard.mjs"], [])).toEqual([]);
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
