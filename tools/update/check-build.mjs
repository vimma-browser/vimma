#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Checks an updater-enabled (VIMMA_UPDATES=1) Vimma install, an unpacked tarball or
 * `dist/vimma`, before anything is signed or published (docs/specs/m6a-updater.md "Delivery",
 * sub-PR 2):
 *
 * - application.ini's [AppUpdate] URL is updates.vimma.dev's (moz-configure.patch), not
 *   Mozilla's aus5.mozilla.org;
 * - update-settings.ini accepts MARs for the `vimma` channel only, and channel-prefs.js says
 *   `vimma` (a nightly package rewrites both; --channel);
 * - the `updater` binary carries the bytes of Vimma's certificates (moz-build.patch) and of
 *   none of Mozilla's (dep1.der, dep2.der and the release and nightly ones beside them).
 *
 *   check-build.mjs INSTALL_DIR [--certs DIR] [--mozilla-certs DIR] [--channel NAME]
 *       --certs: Vimma's primary.der and secondary.der (default: configs/updater)
 *       --mozilla-certs: the engine's toolkit/mozapps/update/updater (default: under engine/)
 *
 * Exit 0 when every check passes; 1 with each problem on stderr.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CERT_DIR } from "./cert-dir.mjs";

/**
 * Mozilla's certificates beside the updater's moz.build (Firefox 159.0.1): each must be found,
 * so a wrong --mozilla-certs fails instead of comparing nothing.
 */
export const MOZILLA_CERTS = [
  "dep1.der",
  "dep2.der",
  "nightly_aurora_level3_primary.der",
  "nightly_aurora_level3_secondary.der",
  "release_primary.der",
  "release_secondary.der",
  "xpcshellCertificate.der",
];

export const UPDATE_URL =
  "https://updates.vimma.dev/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml";

/**
 * @param {string} text an ini file
 * @param {string} section
 * @param {string} key
 * @returns {string | null}
 */
function iniValue(text, section, key) {
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) current = head[1];
    else if (current === section && line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return null;
}

/**
 * @param {{ install: string, certs: string, mozilla: string, channel?: string }} o
 * @returns {string[]} the problems found; empty when the install passes
 */
export function checkBuild({ install, certs, mozilla, channel = "vimma" }) {
  /** @type {string[]} */
  const problems = [];
  const read = (/** @type {string} */ f) => {
    const p = join(install, f);
    if (!existsSync(p)) {
      problems.push(`${f}: missing`);
      return null;
    }
    return readFileSync(p);
  };
  const appini = read("application.ini");
  if (appini) {
    const url = iniValue(appini.toString("utf8"), "AppUpdate", "URL");
    if (url === null)
      problems.push("application.ini: no [AppUpdate] URL (built without the updater?)");
    else if (url !== UPDATE_URL)
      problems.push(`application.ini: [AppUpdate] URL is ${url}, not ${UPDATE_URL}`);
  }
  const settings = read("update-settings.ini");
  if (settings) {
    const ids = iniValue(settings.toString("utf8"), "Settings", "ACCEPTED_MAR_CHANNEL_IDS");
    if (ids !== channel) {
      problems.push(`update-settings.ini: ACCEPTED_MAR_CHANNEL_IDS is ${ids}, not ${channel}`);
    }
  }
  const prefs = read("defaults/pref/channel-prefs.js");
  if (prefs) {
    const m = /pref\("app\.update\.channel",\s*"([^"]*)"\)/.exec(prefs.toString("utf8"));
    if (m?.[1] !== channel) {
      problems.push(`channel-prefs.js: app.update.channel is ${m?.[1] ?? "unset"}, not ${channel}`);
    }
  }
  const updater = read("updater");
  if (updater) {
    for (const f of ["primary.der", "secondary.der"]) {
      if (!updater.includes(readFileSync(join(certs, f)))) {
        problems.push(`updater: does not embed Vimma's ${f}`);
      }
    }
    const present = new Set(readdirSync(mozilla));
    for (const f of MOZILLA_CERTS.filter((n) => !present.has(n))) {
      problems.push(`${join(mozilla, f)}: missing, so the updater cannot be checked against it`);
    }
    for (const f of [...present].filter((n) => n.endsWith(".der")).sort()) {
      if (updater.includes(readFileSync(join(mozilla, f)))) {
        problems.push(`updater: embeds Mozilla's ${f}`);
      }
    }
  }
  return problems;
}

/** @param {string[]} argv */
function main(argv) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  /** @type {{ install?: string, certs: string, mozilla: string, channel: string }} */
  const o = {
    certs: join(root, CERT_DIR),
    mozilla: join(root, "engine/toolkit/mozapps/update/updater"),
    channel: "vimma",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--certs") o.certs = argv[++i];
    else if (a === "--mozilla-certs") o.mozilla = argv[++i];
    else if (a === "--channel") o.channel = argv[++i];
    else if (!a.startsWith("--") && o.install === undefined) o.install = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!o.install)
    throw new Error("usage: check-build.mjs INSTALL_DIR [--certs DIR] [--mozilla-certs DIR]");
  const problems = checkBuild(/** @type {Required<typeof o>} */ (o));
  if (problems.length) {
    for (const p of problems) console.error(`check-build: ${p}`);
    process.exit(1);
  }
  console.log(
    `check-build: ${o.install} ok (updates.vimma.dev, channel ${o.channel}, Vimma's certificates)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`check-build: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
