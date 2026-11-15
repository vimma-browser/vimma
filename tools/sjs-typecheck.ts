/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The last program of `npm run typecheck`: the .sjs handlers that httpd.js runs for the browser
// tests (tests/browser/*.sjs). tsc reads only .js and .ts files and TypeScript 7 has no stable
// compiler API to map another extension, so the handlers are copied, byte for byte, to a
// temporary folder as .js files, checked there with tests/tsconfig.json's options, and each
// error is reported at the .sjs file it came from, at the same line and column (issue #1070).
//
//   node tools/sjs-typecheck.ts

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HANDLERS = "tests/browser";
const TSC = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

/** The copy's name: the handler's own, plus `.js`, so two handlers never share one. */
export function copyName(path: string): string {
  return `${basename(path)}.js`;
}

/**
 * The program's tsconfig, written next to the copies. A handler runs in httpd.js's sandbox
 * (engine/netwerk/test/httpserver/httpd.sys.mjs), which has Firefox's globals and the state
 * functions declared in types/sjs/, and none of the mochitest harness's.
 */
export function sjsConfig(root: string, dir: string): { extends: string; include: string[] } {
  return {
    extends: `${root}tests/tsconfig.json`,
    include: [
      `${dir}/*.js`,
      `${root}types/*.d.ts`,
      `${root}types/mochitest/firefox.d.ts`,
      `${root}types/sjs/*.d.ts`,
    ],
  };
}

/**
 * tsc's output with each copy's path replaced by its handler's (`dir/x.sjs.js` → `x.sjs`). tsc
 * names a file by its path relative to its working directory, so `dir` is given that way.
 */
export function sourcePaths(output: string, dir: string, handlers: string): string {
  return output
    .split(`${dir}/`)
    .reduce((out, part) => `${out}${handlers}/${part.replace(/^([^(\s]+\.sjs)\.js\b/, "$1")}`);
}

function main() {
  const handlers = readdirSync(join(ROOT, HANDLERS)).filter((name) => name.endsWith(".sjs"));
  const dir = mkdtempSync(join(tmpdir(), "vimma-sjs-typecheck-"));
  try {
    for (const name of handlers)
      copyFileSync(join(ROOT, HANDLERS, name), join(dir, copyName(name)));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(sjsConfig(ROOT, dir)));
    const tsc = spawnSync(
      process.execPath,
      [TSC, "-p", join(dir, "tsconfig.json"), "--pretty", "false"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (tsc.error) throw tsc.error;
    const output = sourcePaths(`${tsc.stdout}${tsc.stderr}`, relative(ROOT, dir), HANDLERS);
    if (tsc.status !== 0) {
      process.stderr.write(output);
      // Not process.exit(): it would skip the finally and leave the temporary folder behind.
      process.exitCode = tsc.status ?? 1;
      return;
    }
    process.stdout.write(`${HANDLERS}/*.sjs: ${handlers.length} handlers, no type errors\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
