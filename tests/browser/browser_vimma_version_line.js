/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-versions.md (behaviour 1; nsAppRunner-cpp.patch). The C++ patch is
// only in a full build, so browser.toml skips this on an artifact build (ADR-010).

"use strict";

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

/**
 * Runs this app's binary with `args`: { exitCode, out } (stdout and stderr together).
 * @param {string[]} args
 */
async function runApp(args) {
  const bin = Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
  const proc = await Subprocess.call({ command: bin, arguments: args, stderr: "stdout" });
  let out = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) out += chunk;
  const { exitCode } = await proc.wait();
  return { exitCode, out };
}

add_task(async function test_version_flag_prints_vimma_and_firefox() {
  // tools/release/version-line.mjs writes the same line from surfer.json for the release scripts.
  const expected = `Vimma ${AppConstants.MOZ_APP_VERSION_DISPLAY} · Firefox ${Services.appinfo.version}\n`;
  for (const flag of ["--version", "-v"]) {
    const { exitCode, out } = await runApp([flag]);
    Assert.equal(exitCode, 0, `${flag} exits 0`);
    Assert.equal(out, expected, `${flag} prints Vimma's version and the Firefox it is built on`);
  }
});
