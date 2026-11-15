/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vitest global setup (vitest.config.ts): every test file and every tool it spawns gets a temp
// dir of its own for the run, and the run fails if anything is left in it. The dir is removed
// either way, so a leak fails CI loudly but never piles up in /tmp (#207).

import { tmpdir } from "node:os";
import { isolateTmp } from "./temp-dir.mjs";

/**
 * Caches made under the temp dir on purpose and reused across runs, not leaks: Node's module
 * compile cache (node:module enableCompileCache, which vitest turns on for its workers).
 */
const CACHES = new Set(["node-compile-cache"]);

/** @returns {() => void} the global teardown */
export default function setup() {
  const finish = isolateTmp(process.env, tmpdir());
  return () => {
    const left = finish().filter((name) => !CACHES.has(name));
    if (left.length === 0) return;
    const shown = left.slice(0, 20).join(", ") + (left.length > 20 ? ", ..." : "");
    throw new Error(
      `tests left ${left.length} ${left.length === 1 ? "entry" : "entries"} in the temp dir: ` +
        `${shown}. Make them with tempDir() from tools/test/temp-dir.mjs, or remove them in an ` +
        "afterEach/afterAll.",
    );
  };
}
