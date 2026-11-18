/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/security/12-agents-mcp.md M26 and docs/specs/m1-hints.md (issue #1303): the user's own hint
// gives the page their transient user activation, and nothing else in Vimma can. Over every file
// of src/browser/base/content/vimma/ (comments left out, as they may name what is avoided): the
// calls that give activation are only in actors/user-gesture.mjs, the message that asks for it
// is only in the parent and child actors, and the functions that send it are called only from
// the host, whose hint keys are typed in chrome. browser_vimma_security_invariants.js checks the
// same chain inside those files.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const VIMMA = fileURLToPath(new URL("../../src/browser/base/content/vimma/", import.meta.url));

/** `text` without its comments. */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

/** Each source file under `dir` with its code, comments stripped; `core/` is vimma-core's copy. */
function sources(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const all = readdirSync(dir, { recursive: true, encoding: "utf8" });
  for (const file of all.filter((f) => /\.(m?js|html|xhtml)$/.test(f) && !f.startsWith("core/"))) {
    out.set(file, strip(readFileSync(join(dir, file), "utf8")));
  }
  return out;
}

/** The files of `files` whose code matches `pattern`, sorted. */
function filesWith(files: Map<string, string>, pattern: RegExp): string[] {
  return [...files]
    .filter(([, code]) => pattern.test(code))
    .map(([file]) => file)
    .sort();
}

/** The rules, as functions of a tree's files, so that the test can show each one failing. */
const rules = {
  activation: (files: Map<string, string>) =>
    filesWith(files, /\bsetHandlingUserInput\b|\bnotifyUserGestureActivation\b/),
  message: (files: Map<string, string>) => filesWith(files, /Vimma:ActivateHint/),
  callers: (files: Map<string, string>) => filesWith(files, /\.activateHint\(|\b_hintKey\(/),
};

describe("user activation comes only from the user's hint (M26, #1303)", () => {
  const tree = sources(VIMMA);

  it("reads the tree", () => {
    expect(tree.size).toBeGreaterThan(50);
    expect(tree.has("actors/user-gesture.mjs")).toBe(true);
  });

  it("only actors/user-gesture.mjs gives a page user activation", () => {
    expect(rules.activation(tree)).toEqual(["actors/user-gesture.mjs"]);
  });

  it("only the parent and child actors name Vimma:ActivateHint", () => {
    expect(rules.message(tree)).toEqual([
      "actors/VimmaActors.sys.mjs",
      "actors/VimmaChild.sys.mjs",
    ]);
  });

  it("only the host calls activateHint and _hintKey", () => {
    expect(rules.callers(tree)).toEqual(["host/VimmaHost.sys.mjs"]);
  });

  it("each rule names a file that breaks it", () => {
    const broken = new Map(tree);
    broken.set(
      "ctl/AgentStray.sys.mjs",
      'win.windowUtils.setHandlingUserInput(true);\nactor.sendQuery("Vimma:ActivateHint", {});\n' +
        "VimmaActors.activateHint(target);\n",
    );
    expect(rules.activation(broken)).toContain("ctl/AgentStray.sys.mjs");
    expect(rules.message(broken)).toContain("ctl/AgentStray.sys.mjs");
    expect(rules.callers(broken)).toContain("ctl/AgentStray.sys.mjs");
    // A mention in a comment is not a call.
    const note = strip("// setHandlingUserInput, Vimma:ActivateHint, x.activateHint(\n");
    const commented = new Map([["b.mjs", note]]);
    expect([rules.activation, rules.message, rules.callers].map((r) => r(commented))).toEqual([
      [],
      [],
      [],
    ]);
  });
});
