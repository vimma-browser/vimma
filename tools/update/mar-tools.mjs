#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A Linux build's MAR tools for the jobs after it (docs/specs/m6a-updater.md §7), packed the same
 * way by release.yml and nightly.yml: the host `mar` and Mozilla's make_full_update.sh and
 * common.sh, which build the complete MAR; signmar with the libraries of the objdir it loads,
 * for Mozilla's own check of the signed MAR; and Mozilla's update certificates, which
 * check-build.mjs makes sure the updater does not embed.
 *
 *   mar-tools.mjs pack --objdir DIR --engine DIR --out DIR   pack into a fresh DIR, then check
 *   mar-tools.mjs check --dir DIR                           check a packed DIR
 *
 * The check runs the tools from the packed directory as the later jobs do (LD_LIBRARY_PATH set
 * to it): ldd finds every library, each library packed is the one loaded, and signmar and mar
 * start. A pack that misses a library fails the build, before anything is uploaded; the first
 * public nightly's did not, and its mar job found out after the MAR was signed.
 *
 * Node built-ins and ldd only. It runs the build's own signmar and mar, which the build job has
 * already run as part of the build; no job that holds a secret runs it.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** NSS opens these itself at startup (dlopen), so ldd does not list them. */
const DLOPENED = ["libsoftokn3.so", "libfreeblpriv3.so"];
/** signmar's verification is NSS's: an ldd list without it means the list was misread. */
const NSS = "libnss3.so";
const SCRIPTS = ["make_full_update.sh", "common.sh"];
const CERTS = "mozilla-certs";

/**
 * The libraries ldd resolved: `name => /path (0x…)` lines. The vDSO and the loader, which have
 * no `=>`, and the libraries it did not find are left out.
 * @param {string} text ldd's output
 * @returns {{ name: string, path: string }[]}
 */
export function librariesIn(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\S+) => (\/\S*) \(0x[0-9a-f]+\)\s*$/.exec(line);
    if (m && m[1] && m[2]) found.push({ name: m[1], path: m[2] });
  }
  return found;
}

/**
 * @param {string} text ldd's output
 * @returns {string[]} the names of the libraries ldd did not find
 */
export function missingIn(text) {
  const missing = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\S+) => not found\s*$/.exec(line);
    if (m && m[1]) missing.push(m[1]);
  }
  return missing;
}

/**
 * ldd's output for `file`. ldd prints absolute paths whatever path it is given, so every
 * comparison below is between real paths.
 * @param {string} file
 * @param {NodeJS.ProcessEnv} [env]
 */
function ldd(file, env = process.env) {
  const r = spawnSync("ldd", [file], { encoding: "utf8", env });
  if (r.error) throw new Error(`ldd ${file}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ldd ${file}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** @param {string} path */
const dirOf = (path) => realpathSync(resolve(path, ".."));

/**
 * @param {boolean} ok
 * @param {string} message
 * @returns {asserts ok}
 */
function need(ok, message) {
  if (!ok) throw new Error(message);
}

/**
 * Packs the MAR tools of `objdir` and `engine` into a fresh `out`, then checks them.
 * @param {{ objdir: string, engine: string, out: string }} o
 * @returns {string[]} the files packed, beside the certificates
 */
export function pack({ objdir, engine, out }) {
  const bin = join(objdir, "dist/bin");
  const signmar = join(bin, "signmar");
  const tools = [
    join(objdir, "dist/host/bin/mar"),
    signmar,
    ...SCRIPTS.map((s) => join(engine, "tools/update-packaging", s)),
  ];
  for (const t of tools) need(existsSync(t), `${t}: not found`);
  const listed = ldd(signmar);
  const missing = missingIn(listed);
  need(missing.length === 0, `signmar needs ${missing.join(", ")}, which ldd did not find`);
  const binDir = realpathSync(bin);
  // The objdir's own libraries, wherever ldd says they are: the paths are dist/bin's symlinks
  // to the objects, so their directory is compared, not their targets.
  const libraries = librariesIn(listed)
    .filter((l) => dirOf(l.path) === binDir)
    .map((l) => l.path);
  need(
    libraries.some((l) => basename(l) === NSS),
    `ldd lists no ${NSS} of ${bin} for signmar; it listed:\n${listed}`,
  );
  for (const d of DLOPENED) {
    need(existsSync(join(bin, d)), `${join(bin, d)}: not found`);
    libraries.push(join(bin, d));
  }
  const certDir = join(engine, "toolkit/mozapps/update/updater");
  const certs = readdirSync(certDir).filter((f) => f.endsWith(".der"));
  need(certs.length > 0, `${certDir}: no update certificates`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, CERTS), { recursive: true });
  for (const f of [...tools, ...libraries]) copyFileSync(f, join(out, basename(f)));
  for (const c of certs) copyFileSync(join(certDir, c), join(out, CERTS, c));
  const packed = [...tools, ...libraries].map((f) => basename(f));
  check(out);
  return packed;
}

/**
 * Checks a packed directory as the later jobs use it: every tool and library present, ldd
 * finding each library and the packed copy where there is one, and both programs starting.
 * @param {string} dir
 */
export function check(dir) {
  const real = realpathSync(dir);
  const files = readdirSync(real);
  for (const f of ["mar", "signmar", ...SCRIPTS, ...DLOPENED]) {
    need(files.includes(f), `${dir}: no ${f}`);
  }
  need(
    existsSync(join(real, CERTS)) && readdirSync(join(real, CERTS)).some((f) => f.endsWith(".der")),
    `${dir}: no ${CERTS}/*.der`,
  );
  const env = { ...process.env, LD_LIBRARY_PATH: real };
  const libraries = files.filter((f) => /\.so(\.\d+)*$/.test(f));
  need(libraries.includes(NSS), `${dir}: no ${NSS}`);
  for (const f of ["signmar", "mar", ...libraries]) {
    const listed = ldd(join(real, f), env);
    const missing = missingIn(listed);
    need(missing.length === 0, `${dir}/${f} needs ${missing.join(", ")}, not in ${dir}`);
    for (const l of librariesIn(listed)) {
      need(
        !files.includes(l.name) || dirOf(l.path) === real,
        `${dir}/${f} loads ${l.path}, not ${dir}/${l.name}`,
      );
    }
  }
  // Both print their usage and exit non-zero without arguments; a program the loader cannot
  // start exits 127 with "error while loading shared libraries".
  for (const f of ["signmar", "mar"]) {
    const r = spawnSync(join(real, f), [], { encoding: "utf8", env, timeout: 30_000 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    need(
      !r.error && r.status !== 127 && r.signal === null && !/error while loading/.test(output),
      `${dir}/${f} does not start: ${r.error?.message ?? output.trim()}`,
    );
  }
}

/** @param {string[]} argv */
function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      objdir: { type: "string" },
      engine: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
    },
  });
  if (command === "pack") {
    const { objdir, engine, out } = values;
    need(!!objdir && !!engine && !!out, "pack needs --objdir --engine --out");
    const packed = pack({ objdir, engine, out });
    console.log(`${out}: ${packed.join(" ")}, ${CERTS}/`);
    console.log(`${out}: signmar and mar start with the packed libraries`);
  } else if (command === "check") {
    need(!!values.dir, "check needs --dir");
    check(values.dir);
    console.log(`${values.dir}: signmar and mar start with the packed libraries`);
  } else {
    throw new Error(
      "usage: mar-tools.mjs pack --objdir DIR --engine DIR --out DIR | check --dir DIR",
    );
  }
}

// Real paths: a checkout reached through a symlink still runs main.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`mar-tools.mjs: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
