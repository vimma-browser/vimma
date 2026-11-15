#!/usr/bin/env node
/**
 * Prints the install type Vimma's update check gives the install in a GRE directory, as
 * VimmaUpdates.sys.mjs detectInstall decides it (spec m6a-updater, section 3): packaged when
 * omni.ja is there, the `is-packaged-app` marker, and `$APPIMAGE`. release.yml's smoke test
 * runs it on the installed .deb and the extracted AppImage.
 *
 *   node tools/package/install-type.mjs <gre-dir>
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installTypeFrom } from "../../packages/vimma-core/src/updates/updates.mjs";
import { PACKAGED_APP_FILE } from "./package.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: install-type.mjs <gre-dir>");
  process.exit(64);
}
const markerPath = join(dir, PACKAGED_APP_FILE);
console.log(
  installTypeFrom({
    packaged: existsSync(join(dir, "omni.ja")),
    marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null,
    appImage: process.env.APPIMAGE || null,
  }),
);
