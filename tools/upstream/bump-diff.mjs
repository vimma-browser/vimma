#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The diff an upstream bump may auto-merge with (spec upstream-bump-automation, decision 8):
 * `surfer.json` changes only `version.version`, and `firefox-branding.js`, if changed at all,
 * changes only the lines of the prefs copied from upstream (upstream-prefs.mjs). Anything else,
 * a re-exported patch included, needs a person.
 *
 *   node tools/upstream/bump-diff.mjs --diff FILE --base-surfer FILE --head-surfer FILE
 *
 * FILE for --diff is `git diff --unified=0 base...head`. Prints {"ok": bool, "reason": text}.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CFR, SB_LISTS } from "./upstream-prefs.mjs";

const SURFER = "surfer.json";
const OURS = "src/browser/branding/vimma/pref/firefox-branding.js";
const COPIED = new Set([CFR, ...SB_LISTS]);
/** A changed line of OURS: one string-valued pref() call and nothing else. */
const PREF_LINE = /^[+-]pref\("([a-z0-9._-]+)", "(?:[^"\\]|\\.)*"\);$/;
/** The only header lines a plain content change has; new, deleted, renamed, mode or binary
 * files add others and are refused. */
const HEADER = /^(?:index [0-9a-f]+\.\.[0-9a-f]+ 100644|--- a\/\S+|\+\+\+ b\/\S+)$/;

/**
 * @param {{ diff: string, baseSurfer: string, headSurfer: string }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkBumpDiff({ diff, baseSurfer, headSurfer }) {
  /** @type {Map<string, string[]>} */
  const files = new Map();
  /** @type {string[] | null} */
  let lines = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const start = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (start) {
      if (start[1] !== start[2]) return { ok: false, reason: `renames ${start[1]}` };
      const path = start[1] ?? "";
      if (path !== SURFER && path !== OURS) return { ok: false, reason: `changes ${path}` };
      lines = [];
      files.set(path, lines);
      inHunk = false;
      continue;
    }
    if (line === "") continue;
    if (!lines) return { ok: false, reason: "the diff does not start with a file header" };
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (!HEADER.test(line))
        return { ok: false, reason: "adds, deletes, renames or re-modes a file" };
      continue;
    }
    lines.push(line);
  }
  if (!files.has(SURFER)) return { ok: false, reason: "surfer.json is not changed" };
  /** @type {any} */
  let base;
  /** @type {any} */
  let head;
  try {
    base = JSON.parse(baseSurfer);
    head = JSON.parse(headSurfer);
  } catch {
    return { ok: false, reason: "surfer.json does not parse" };
  }
  const v = head?.version?.version;
  if (typeof v !== "string" || v === base?.version?.version) {
    return { ok: false, reason: "surfer.json does not change version.version" };
  }
  const same = { ...head, version: { ...head.version, version: base?.version?.version } };
  if (JSON.stringify(same) !== JSON.stringify(base)) {
    return { ok: false, reason: "surfer.json changes more than version.version" };
  }
  for (const line of files.get(OURS) ?? []) {
    const m = PREF_LINE.exec(line);
    if (!m || !COPIED.has(m[1] ?? "")) {
      return { ok: false, reason: `changes a line of ${OURS} that is not a copied pref` };
    }
  }
  return { ok: true, reason: "only the version and copied prefs change" };
}

function main() {
  const { values } = parseArgs({
    options: {
      diff: { type: "string" },
      "base-surfer": { type: "string" },
      "head-surfer": { type: "string" },
    },
  });
  if (!values.diff || !values["base-surfer"] || !values["head-surfer"]) {
    throw new Error("--diff, --base-surfer and --head-surfer are required");
  }
  const r = checkBumpDiff({
    diff: readFileSync(values.diff, "utf8"),
    baseSurfer: readFileSync(values["base-surfer"], "utf8"),
    headSurfer: readFileSync(values["head-surfer"], "utf8"),
  });
  process.stdout.write(JSON.stringify(r) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`bump-diff: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
