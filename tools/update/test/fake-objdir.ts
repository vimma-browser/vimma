/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A stand-in engine tree and objdir for tools/update/mar-tools.ts and the workflow steps that
// run it, compiled with the system C compiler (the runners' and a Linux developer's `cc`).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

export function cc(out: string, source: string, args: string[] = []) {
  const src = `${out}.c`;
  writeFileSync(src, source);
  // Ubuntu's toolchain links with --as-needed, which drops a library no symbol is taken from;
  // these stand-ins take none, and must keep their dependencies as the real ones do.
  execFileSync("cc", ["-o", out, src, "-Wl,--no-as-needed", ...args], { stdio: "pipe" });
  rmSync(src);
}

/** The objdir's stand-in libraries, with the libraries each links to (-l names). */
const LIBRARIES = [
  ["libmozsqlite3.so", []],
  ["libnss3.so", ["mozsqlite3"]],
  ["libsoftokn3.so", ["mozsqlite3"]],
  ["libfreeblpriv3.so", []],
  // A library of the objdir that signmar does not load: never packed.
  ["libxul.so", []],
] as const;

/**
 * Compiles the stand-in tree's libraries, signmar and mar into `dir`. Nothing compiled holds a
 * path (the libraries have no run path, signmar's is $ORIGIN), so the files can be copied into
 * any number of trees: a test file compiles them once instead of once per tree.
 */
export function compileStandIns(dir: string) {
  for (const [name, deps] of LIBRARIES) {
    cc(join(dir, name), `int ${name.replace(/\W/g, "_")}(void) { return 0; }\n`, [
      "-shared",
      "-fPIC",
      `-L${dir}`,
      ...deps.map((d) => `-l${d}`),
    ]);
  }
  cc(
    join(dir, "signmar"),
    "int libnss3_so(void); int libmozsqlite3_so(void);\n" +
      "int main(void) { return libnss3_so() + libmozsqlite3_so(); }\n",
    [`-L${dir}`, "-lnss3", "-lmozsqlite3", "-Wl,-rpath,$ORIGIN"],
  );
  cc(join(dir, "mar"), "int main(void) { return 0; }\n");
}

/**
 * A checkout with an engine tree and an objdir laid out as mozbuild leaves them: dist/bin holds
 * symlinks to the objects built elsewhere in the objdir; signmar finds its libraries through an
 * $ORIGIN run path, and the libraries, which have none as NSS's have none, find each other only
 * through LD_LIBRARY_PATH.
 * @param standIns a directory compileStandIns filled; without one, they are compiled
 */
export function fakeTree(root: string, standIns?: string) {
  const obj = join(root, OBJ);
  const bin = join(obj, "dist/bin");
  const built = join(obj, "security");
  for (const d of [bin, built, join(obj, "dist/host/bin")]) mkdirSync(d, { recursive: true });
  const from = standIns ?? mkdtempSync(join(root, "stand-ins-"));
  if (!standIns) compileStandIns(from);
  for (const [name] of LIBRARIES) {
    copyFileSync(join(from, name), join(built, name));
    symlinkSync(join(built, name), join(bin, name));
  }
  copyFileSync(join(from, "signmar"), join(bin, "signmar"));
  copyFileSync(join(from, "mar"), join(obj, "dist/host/bin/mar"));
  if (!standIns) rmSync(from, { recursive: true });
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
