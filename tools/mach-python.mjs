// The Python interpreter mach runs with, for tools/mochitest.mjs and tools/build.mjs. mach runs
// under the first python3 on PATH, and a Python newer than engine/mach supports (for example 3.15
// from mise) breaks the build and the test manifests in places far from the cause.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

/** @typedef {{ min: number[], max: number[] }} PythonBounds */

/**
 * The Python range engine/mach declares it supports. Outside it mach may break in odd places:
 * Python 3.15's re.Scanner rejects the capturing groups in manifestparser's expression scanner,
 * so every `skip-if` in a manifest fails to parse.
 * @param {string} machSource the text of engine/mach
 * @returns {PythonBounds | null}
 */
export function machPythonBounds(machSource) {
  /** @param {string} name */
  const tuple = (name) => {
    const m = machSource.match(new RegExp(`^${name} = \\((\\d+), (\\d+)\\)`, "m"));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const min = tuple("MIN_PYTHON_VERSION");
  const max = tuple("MAX_PYTHON_VERSION_TO_CONSIDER");
  return min && max ? { min, max } : null;
}

/**
 * The interpreter to run mach with: VIMMA_MACH_PYTHON if set, else the first `python3`, then
 * `python3.N` (newest first), on PATH whose version is inside `bounds`.
 * @param {Record<string, string | undefined>} env
 * @param {PythonBounds} bounds
 * @param {(path: string) => boolean} exists
 * @param {(path: string) => string | null} probe the interpreter's version, null if it fails to run
 * @returns {{ python: string | null, version: string | null, tried: string[] }}
 */
export function pickMachPython(env, bounds, exists, probe) {
  if (env.VIMMA_MACH_PYTHON) return { python: env.VIMMA_MACH_PYTHON, version: null, tried: [] };
  const [major] = bounds.min;
  const names = [`python${major}`];
  for (let minor = bounds.max[1]; minor >= bounds.min[1]; minor--)
    names.push(`python${major}.${minor}`);
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  /** @type {string[]} */
  const tried = [];
  const seen = new Set();
  for (const name of names) {
    for (const dir of dirs) {
      const path = join(dir, name);
      if (seen.has(path) || !exists(path)) continue;
      seen.add(path);
      const version = probe(path);
      if (!version) {
        tried.push(`${path} (did not run)`);
        continue;
      }
      const [ma, mi] = version.split(".").map(Number);
      const v = ma * 1000 + mi;
      const lo = bounds.min[0] * 1000 + bounds.min[1];
      const hi = bounds.max[0] * 1000 + bounds.max[1];
      if (v >= lo && v <= hi) return { python: path, version, tried };
      tried.push(`${path} (${version})`);
    }
  }
  return { python: null, version: null, tried };
}

/** @param {string} path */
export function pythonVersion(path) {
  const res = spawnSync(path, ["-c", "import platform; print(platform.python_version())"], {
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * What to tell the developer about a pick: `error` (the lines to print before stopping) when none
 * fits, else a `note` naming the chosen interpreter when another one was skipped.
 * @param {string} label the command, for example `npm run build`
 * @param {PythonBounds} bounds
 * @param {{ python: string | null, version: string | null, tried: string[] }} pick
 * @returns {{ error: string[] | null, note: string | null }}
 */
export function pickReport(label, bounds, pick) {
  const range = `${bounds.min.join(".")} to ${bounds.max.join(".")}`;
  if (!pick.python) {
    const error = [
      `${label}: mach supports Python ${range} (engine/mach), and none was found on PATH.`,
    ];
    if (pick.tried.length) error.push(`Found outside that range: ${pick.tried.join(", ")}.`);
    error.push("Install a Python in that range, or set VIMMA_MACH_PYTHON to one.");
    return { error, note: null };
  }
  if (!pick.tried.length) return { error: null, note: null };
  return {
    error: null,
    note: `${label}: using ${pick.python} (${pick.version}); mach supports Python ${range}.`,
  };
}

/**
 * Makes `dir` hold `python3` and `python` linked to `python`. With `dir` first on PATH, the
 * `#!/usr/bin/env python3` line of `./mach`, which Surfer runs, finds the chosen interpreter.
 * @param {string} dir an empty directory
 * @param {string} python
 */
export function writePythonShim(dir, python) {
  for (const name of ["python3", "python"]) symlinkSync(python, join(dir, name));
}

/**
 * The environment to run mach in: `shimDir` first on PATH, and `~/.mozbuild/sccache` (where
 * `mach bootstrap` puts sccache, which the mozconfig's --with-ccache=sccache names) last, when it
 * holds sccache and PATH does not already list it.
 * @param {Record<string, string | undefined>} env
 * @param {string} shimDir
 * @param {string} home
 * @param {(path: string) => boolean} exists
 * @returns {Record<string, string | undefined>}
 */
export function machEnv(env, shimDir, home, exists) {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const sccache = join(home, ".mozbuild", "sccache");
  const tail = !dirs.includes(sccache) && exists(join(sccache, "sccache")) ? [sccache] : [];
  return { ...env, PATH: [shimDir, ...dirs, ...tail].join(delimiter) };
}

/**
 * The interpreter to run engine/mach with, or null when engine/mach no longer declares its range
 * (then plain `./mach`). Prints the pick's note, or its error and exits 1 when none fits.
 * @param {string} engine absolute path of engine/
 * @param {string} label
 * @returns {string | null}
 */
export function machPythonOrExit(engine, label) {
  const bounds = machPythonBounds(readFileSync(join(engine, "mach"), "utf8"));
  if (!bounds) return null;
  const pick = pickMachPython(process.env, bounds, existsSync, pythonVersion);
  const { error, note } = pickReport(label, bounds, pick);
  if (error) {
    for (const line of error) console.error(line);
    process.exit(1);
  }
  if (note) console.log(note);
  return pick.python;
}
