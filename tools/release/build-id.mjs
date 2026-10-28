#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Checks that a packaged build's binary and its application.ini carry the same build ID (#563).
 * The binary's ID is what `Services.appinfo.appBuildID` says at run time; application.ini's is
 * what the update manifest (tools/update) offers. When they differ, the release
 * offers itself to itself as an update. They differ when `./mach package` writes application.ini
 * again after the build without a fixed `MOZ_BUILD_DATE`, so the build jobs set one; this check
 * makes a release fail rather than ship a mismatch.
 *
 *   node tools/release/build-id.mjs --binary <vimma> --ini <application.ini>
 *       prints `build-id=<id>` (for $GITHUB_OUTPUT), or an ::error:: line and exits 1
 *
 * Node built-ins only.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BUILD_ID = /^\d{14}$/;

/**
 * The app and platform build IDs from `vimma --full-version`
 * (`<vendor> <name> <version> <app build ID> <platform build ID>`), or null.
 * @param {string} line
 * @returns {{ app: string, platform: string } | null}
 */
export function fullVersionBuildIds(line) {
  const words = line.trim().split(/\s+/);
  const [app, platform] = words.slice(-2);
  if (words.length < 4 || !BUILD_ID.test(app ?? "") || !BUILD_ID.test(platform ?? "")) {
    return null;
  }
  return { app: /** @type {string} */ (app), platform: /** @type {string} */ (platform) };
}

/**
 * `BuildID` of application.ini's `[App]` section, or null.
 * @param {string} text
 */
export function iniBuildId(text) {
  const app = /^\[App\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const id = /^BuildID=(.*)$/m.exec(app)?.[1]?.trim() ?? "";
  return BUILD_ID.test(id) ? id : null;
}

/**
 * What is wrong with a build's IDs, or null when they agree.
 * @param {string} fullVersion  the binary's `--full-version` output
 * @param {string} ini          its application.ini
 */
export function buildIdProblem(fullVersion, ini) {
  const ids = fullVersionBuildIds(fullVersion);
  if (!ids) return `--full-version printed no build IDs: ${JSON.stringify(fullVersion.trim())}`;
  if (ids.platform !== ids.app) {
    return `the binary's platform build ID ${ids.platform} differs from its app build ID ${ids.app}`;
  }
  const packaged = iniBuildId(ini);
  if (!packaged) return "application.ini has no [App] BuildID";
  if (packaged !== ids.app) {
    return `application.ini has BuildID ${packaged}, the binary ${ids.app}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, ini: { type: "string" } },
  });
  if (!values.binary || !values.ini) {
    console.error("usage: build-id.mjs --binary <vimma> --ini <application.ini>");
    process.exit(2);
  }
  // stdout alone: the sandbox's user-namespace probe writes to stderr on some runners
  const fullVersion = execFileSync(values.binary, ["--full-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const problem = buildIdProblem(fullVersion, readFileSync(values.ini, "utf8"));
  if (problem) {
    console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`build-id=${fullVersionBuildIds(fullVersion)?.app}`);
}
