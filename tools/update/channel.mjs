#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sets a `./mach package` tarball's update channel (docs/specs/m6a-updater.md §1). The
 * compile-time channel stays `vimma`, because it picks the updater's certificates
 * (moz-build.patch) and the desktop file ID; the nightly tarball gets `vimma-nightly` here, in
 * both files that name it: `defaults/pref/channel-prefs.js` (`app.update.channel`, the
 * manifest's URL) and `update-settings.ini` (`ACCEPTED_MAR_CHANNEL_IDS`, the MARs the updater
 * applies). An update never rewrites either file, so a nightly install stays nightly and a
 * release install never applies a nightly MAR (the updater's error 22).
 *
 *   channel.mjs --tarball FILE --channel vimma-nightly --out FILE
 *
 * Node built-ins only, so no job that runs it installs dependencies.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packTarball } from "../package/package.mjs";
import { CHANNELS } from "./mar.mjs";

const PREFS = "defaults/pref/channel-prefs.js";
const SETTINGS = "update-settings.ini";
const PREF_LINE = /^pref\("app\.update\.channel", "([^"]*)"\);$/gm;
const SETTINGS_LINE = /^ACCEPTED_MAR_CHANNEL_IDS=(.*)$/gm;

/**
 * @param {string} text
 * @param {RegExp} line  global and multiline, with the channel as its one group
 * @param {string} file  for messages
 * @param {(channel: string) => string} write
 */
function replaceOnce(text, line, file, write) {
  const found = [...text.matchAll(line)];
  if (found.length !== 1) throw new Error(`${file}: ${found.length} channel lines, not one`);
  const was = found[0]?.[1];
  if (was !== "vimma") throw new Error(`${file}: channel ${was}, not the build's vimma`);
  return text.replace(line, () => write(was));
}

/**
 * Rewrites both channel files of an unpacked install from `vimma` to `channel`.
 * @param {string} dir  the install (the tarball's `vimma/`)
 * @param {string} channel
 */
export function setChannel(dir, channel) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`channel ${channel} is not ${CHANNELS.join(" or ")}`);
  }
  const prefsPath = join(dir, PREFS);
  const settingsPath = join(dir, SETTINGS);
  const prefs = replaceOnce(
    readFileSync(prefsPath, "utf8"),
    PREF_LINE,
    PREFS,
    () => `pref("app.update.channel", "${channel}");`,
  );
  const settings = replaceOnce(
    readFileSync(settingsPath, "utf8"),
    SETTINGS_LINE,
    SETTINGS,
    () => `ACCEPTED_MAR_CHANNEL_IDS=${channel}`,
  );
  writeFileSync(prefsPath, prefs);
  writeFileSync(settingsPath, settings);
}

/**
 * @param {{ tarball: string, channel: string, out: string }} o
 */
export function setTarballChannel({ tarball, channel, out }) {
  const work = mkdtempSync(join(tmpdir(), "vimma-channel-"));
  try {
    execFileSync("tar", ["-xJf", tarball, "-C", work]);
    const tops = readdirSync(work);
    if (tops.length !== 1 || tops[0] !== "vimma") {
      throw new Error(`${tarball}: top-level entries ${tops.join(", ")}, not vimma/`);
    }
    setChannel(join(work, "vimma"), channel);
    packTarball(work, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        tarball: { type: "string" },
        channel: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.tarball || !values.channel || !values.out) {
      throw new Error("usage: channel.mjs --tarball FILE --channel vimma-nightly --out FILE");
    }
    setTarballChannel({ tarball: values.tarball, channel: values.channel, out: values.out });
  } catch (e) {
    console.error(`channel: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
