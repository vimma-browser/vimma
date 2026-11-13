#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Links Vimma's update certificates (configs/updater/primary.der and secondary.der) into
 * engine/toolkit/mozapps/update/updater/vimma/, where the updater's moz-build.patch embeds them
 * and configs/common/mozconfig checks for them (docs/specs/m6a-updater.md "Delivery", sub-PR 2).
 *
 * They are not under src/, which `surfer import` links the same way, because
 * `surfer license-check` reads every file there as text for an MPL header and skips only a
 * fixed list of extensions: a binary certificate can carry neither. Like surfer, this makes a
 * symlink and lists it in engine/.gitignore. Run by `npm run import`, after `surfer import`.
 *
 * CLI: node tools/import/link-update-certs.mjs
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CERT_DIR } from "../update/cert-dir.mjs";

/** Relative to engine/; moz-build.patch reads `vimma/<slot>.der` beside the updater's moz.build. */
export const ENGINE_CERT_DIR = "toolkit/mozapps/update/updater/vimma";
const SLOTS = ["primary.der", "secondary.der"];

/**
 * @param {string} root the repository
 * @param {string} engine its engine/
 * @returns {string[]} the links made, engine-relative
 */
export function linkUpdateCerts(root, engine) {
  if (!existsSync(engine)) throw new Error(`no engine at ${engine}; run npm run download first`);
  // Check both before linking either, so a failed run leaves no half-set for a build to embed.
  const sources = SLOTS.map((f) => {
    const src = join(root, CERT_DIR, f);
    // lstat: a committed link could lead to any file on the build machine.
    const st = lstatSync(src, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size === 0) {
      throw new Error(
        `${src}: missing, empty or not a regular file (docs/runbook.md, "Update signing keys")`,
      );
    }
    return src;
  });
  mkdirSync(join(engine, ENGINE_CERT_DIR), { recursive: true });
  const gitignore = join(engine, ".gitignore");
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8").split("\n") : [];
  /** @type {string[]} */
  const linked = [];
  SLOTS.forEach((f, i) => {
    const rel = `${ENGINE_CERT_DIR}/${f}`;
    const dest = join(engine, rel);
    // force: also a dangling link from when the certificates were under src/.
    rmSync(dest, { force: true });
    symlinkSync(/** @type {string} */ (sources[i]), dest);
    if (!ignored.includes(rel)) appendFileSync(gitignore, `\n${rel}`);
    linked.push(rel);
  });
  return linked;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    for (const rel of linkUpdateCerts(root, join(root, "engine"))) {
      console.log(`link-update-certs: engine/${rel} -> ${CERT_DIR}`);
    }
  } catch (e) {
    console.error(`link-update-certs: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
