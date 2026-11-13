#!/usr/bin/env node
/**
 * The version line, `Vimma <vimma> · Firefox <firefox>` (spec firefox-versions, decision 3):
 * what `vimma --version` prints (src/toolkit/xre/nsAppRunner-cpp.patch) and what the release
 * scripts compare it with. `<vimma>` is surfer.json brands.vimma.release.displayVersion,
 * `<firefox>` is version.version; the separator is U+00B7 MIDDLE DOT with a space on each side.
 * The string is written here and once in C++; browser_vimma_version_line.js (full build) holds
 * the two together.
 * Usage: node tools/release/version-line.mjs   (prints the line for ./surfer.json)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { surferVersions } from "../version-files/version-files.ts";

/**
 * @param {import("../version-files/version-files.ts").SurferConfig} surferJson parsed surfer.json
 * @returns {string} e.g. `Vimma 0.5.2 · Firefox 158.0`
 * @throws when either version is missing or malformed
 */
export function versionLine(surferJson) {
  const { firefox, display } = surferVersions(surferJson, "vimma");
  return `Vimma ${display} · Firefox ${firefox}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8"));
  console.log(versionLine(config));
}
