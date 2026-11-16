/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Temp dirs for tests that cannot leak. /tmp is often a tmpfs with a fixed number of inodes, and
// a dir left behind on every run fills it in a few hundred runs (#207).
//
//   import { tempDir } from "../../test/temp-dir.ts";
//   const dir = tempDir("vimma-thing-"); // in a test or a beforeEach

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * A fresh dir under the OS temp dir, removed when the current test finishes, whether it passed
 * or failed. Call it from a test or a beforeEach (vitest's onTestFinished needs a running test).
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Point TMPDIR in `env` at a fresh dir under `parent` (os.tmpdir() reads TMPDIR on every call, and
 * child processes inherit it). The returned function puts TMPDIR back, removes the dir and returns
 * the names of what was left in it, sorted: a leak, if not empty.
 */
export function isolateTmp(
  env: Record<string, string | undefined>,
  parent: string,
): () => string[] {
  const had = Object.hasOwn(env, "TMPDIR");
  const before = env.TMPDIR;
  const run = mkdtempSync(join(parent, "vimma-test-run-"));
  env.TMPDIR = run;
  return () => {
    if (had) env.TMPDIR = before;
    else delete env.TMPDIR;
    const left = readdirSync(run).sort();
    rmSync(run, { recursive: true, force: true });
    return left;
  };
}
