/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A stand-in engine tree and objdir for tools/update/mar-tools.mjs and the workflow steps that
// run it, compiled with the system C compiler (the runners' and a Linux developer's `cc`).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** nightly.yml's objdir, relative to the checkout. */
export const OBJ = "engine/obj-x86_64-pc-linux-gnu";

/** What pack leaves in its directory for the stand-in tree. */
export const PACKED = [
  "common.sh",
  "libfreeblpriv3.so",
  "libmozsqlite3.so",
  "libnss3.so",
  "libsoftokn3.so",
  "make_full_update.sh",
  "mar",
  "mozilla-certs",
  "signmar",
];

/**
 * @param {string} out
 * @param {string} source
 * @param {string[]} args
 */
export function cc(out, source, args = []) {
  const src = `${out}.c`;
  writeFileSync(src, source);
  execFileSync("cc", ["-o", out, src, ...args], { stdio: "pipe" });
  rmSync(src);
}

/**
 * A checkout with an engine tree and an objdir laid out as mozbuild leaves them: dist/bin holds
 * symlinks to the objects built elsewhere in the objdir, and signmar finds its libraries through
 * an $ORIGIN run path.
 * @param {string} root
 */
export function fakeTree(root) {
  const obj = join(root, OBJ);
  const bin = join(obj, "dist/bin");
  const built = join(obj, "security");
  for (const d of [bin, built, join(obj, "dist/host/bin")]) mkdirSync(d, { recursive: true });
  const lib = (/** @type {string} */ name, /** @type {string[]} */ deps = []) => {
    cc(join(built, name), `int ${name.replace(/\W/g, "_")}(void) { return 0; }\n`, [
      "-shared",
      "-fPIC",
      `-L${built}`,
      ...deps.map((d) => `-l${d}`),
      "-Wl,-rpath,$ORIGIN",
    ]);
    symlinkSync(join(built, name), join(bin, name));
  };
  lib("libmozsqlite3.so");
  lib("libnss3.so", ["mozsqlite3"]);
  lib("libsoftokn3.so");
  lib("libfreeblpriv3.so");
  // A library of the objdir that signmar does not load: never packed.
  lib("libxul.so");
  cc(
    join(bin, "signmar"),
    "int libnss3_so(void); int libmozsqlite3_so(void);\n" +
      "int main(void) { return libnss3_so() + libmozsqlite3_so(); }\n",
    [`-L${built}`, "-lnss3", "-lmozsqlite3", "-Wl,-rpath,$ORIGIN"],
  );
  cc(join(obj, "dist/host/bin/mar"), "int main(void) { return 0; }\n");
  const packaging = join(root, "engine/tools/update-packaging");
  mkdirSync(packaging, { recursive: true });
  for (const f of ["make_full_update.sh", "common.sh"]) {
    writeFileSync(join(packaging, f), "#!/bin/sh\n");
    chmodSync(join(packaging, f), 0o755);
  }
  const certs = join(root, "engine/toolkit/mozapps/update/updater");
  mkdirSync(certs, { recursive: true });
  writeFileSync(join(certs, "release_primary.der"), "der");
  writeFileSync(join(certs, "release_secondary.der"), "der");
  return { obj, bin, built };
}
