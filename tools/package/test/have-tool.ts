/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tests that run a system tool (gpgv, sqv, rpm, apt-ftparchive, createrepo_c, repo-add) skip
// where it is not installed, so `npm test` passes on any machine. pkgbuild.yml's repos job
// installs every one of them and names them in VIMMA_REQUIRE_TOOLS, where a missing tool fails
// the run instead of skipping the tests that need it.

import { spawnSync } from "node:child_process";

/** The tools VIMMA_REQUIRE_TOOLS (comma-separated) says must be installed. */
export const requiredTools = (process.env.VIMMA_REQUIRE_TOOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Whether `tool` is on PATH. */
export function haveTool(tool: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(tool)) throw new Error(`bad tool name ${tool}`);
  return spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0;
}

/** The tools of `tools` that VIMMA_REQUIRE_TOOLS names but are not installed. */
export function missingRequired(tools: string[]): string[] {
  return tools.filter((t) => requiredTools.includes(t) && !haveTool(t));
}
