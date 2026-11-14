/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The fourth program of `npm run typecheck`: tsc over every JavaScript file under tests/ (the
// mochitests and their helpers, tests/tsconfig.json), held to tools/test/mochitest-allowlist.txt.
// A listed file may still have type errors; any other file may not, and a listed file with none
// fails too, so each fix takes its file off the list and the list only shrinks (issue #959).
//
//   node tools/mochitest-typecheck.ts

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LIST = "tools/test/mochitest-allowlist.txt";
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/** The listed paths: one per line, `#` starts a comment line. */
export function readAllowlist(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * tsc's errors (`--pretty false`) by file: each error with its indented continuation lines.
 */
export function errorsByFile(output: string): Map<string, string[]> {
  const errors = new Map<string, string[]>();
  let last: { file: string; index: number } | null = null;
  for (const line of output.split("\n")) {
    const m = /^(\S[^(]*)\(\d+,\d+\): error TS\d+:/.exec(line);
    if (m?.[1]) {
      const list = errors.get(m[1]) ?? [];
      list.push(line);
      errors.set(m[1], list);
      last = { file: m[1], index: list.length - 1 };
    } else if (last && /^\s+\S/.test(line)) {
      const list = errors.get(last.file);
      if (list) list[last.index] += `\n${line}`;
    } else if (line.trim()) {
      last = null;
    }
  }
  return errors;
}

/**
 * What breaks the ratchet: every error in a file that is not listed (a declaration file under
 * types/ included), then each listed file that has no errors or is not tracked.
 */
export function ratchetErrors(
  errors: Map<string, string[]>,
  listed: string[],
  tracked: string[],
): string[] {
  const unlisted = [...errors].filter(([file]) => !listed.includes(file)).flatMap(([, e]) => e);
  const stale = listed.flatMap((file) => {
    if (!tracked.includes(file)) return [`${file} is listed but not tracked: take it off ${LIST}`];
    if (!errors.has(file)) return [`${file} has no type errors now: take it off ${LIST}`];
    return [];
  });
  return [...unlisted, ...stale];
}

function main() {
  const tsc = spawnSync(
    process.execPath,
    [TSC, "-p", "tests/tsconfig.json", "--pretty", "false"],
    // The listed files' errors run to a few megabytes.
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (tsc.error) throw tsc.error;
  const output = `${tsc.stdout}${tsc.stderr}`;
  const errors = errorsByFile(output);
  if (tsc.status !== 0 && errors.size === 0) {
    process.stderr.write(output);
    process.exit(tsc.status ?? 1);
  }
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "tests"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const listed = readAllowlist(readFileSync(new URL(`../${LIST}`, import.meta.url), "utf8"));
  const problems = ratchetErrors(errors, listed, tracked);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  const held = listed.reduce((n, file) => n + (errors.get(file)?.length ?? 0), 0);
  process.stdout.write(
    `tests/tsconfig.json: no type errors outside ${LIST} (${listed.length} files there, ` +
      `${held} errors left in them)\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
