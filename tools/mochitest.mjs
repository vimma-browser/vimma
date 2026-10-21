// Runs our mochitests through mach. `surfer import` symlinks tests/ under this engine path.
// --artifact: against the artifact build (ADR-010, tools/artifact-build/artifact-build.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAppIni } from "./artifact-build/artifact-build.mjs";

const ENGINE_TESTS = "browser/base/zen-components/";

/**
 * Whether the build under test should have a Google Safe Browsing key (spec m0-safebrowsing-key):
 * VIMMA_EXPECT_SAFEBROWSING_KEY if set (the nightly deletes its key file after packaging), else
 * whether the key file configs/common/mozconfig reads exists.
 * @param {Record<string, string | undefined>} env
 * @param {string} home
 * @param {(path: string) => boolean} exists
 * @returns {boolean}
 */
export function expectSafeBrowsingKey(env, home, exists) {
  const explicit = env.VIMMA_EXPECT_SAFEBROWSING_KEY;
  if (explicit === "1" || explicit === "0") return explicit === "1";
  const keyfile =
    env.VIMMA_SAFEBROWSING_KEYFILE || join(home, ".config", "vimma", "keys", "safebrowsing");
  return exists(keyfile);
}

/**
 * @param {string[]} argv arguments after `npm run mochitest --`
 * @param {string} engine absolute path of engine/, with a trailing slash
 * @param {boolean} [expectKey] passed to the tests as VIMMA_EXPECT_SAFEBROWSING_KEY
 * @returns {{ args: string[], env: Record<string, string> }} mach arguments and extra env
 */
export function mochitestCommand(argv, engine, expectKey) {
  const flags = argv.filter((a) => a.startsWith("-"));
  const paths = argv.filter((a) => !a.startsWith("-"));
  const mapped = (paths.length ? paths : ["tests/browser/"]).map(
    (p) => ENGINE_TESTS + p.replace(/^\.\//, ""),
  );
  const headless = flags.includes("--headed") ? [] : ["--headless"];
  const keyEnv =
    expectKey === undefined ? [] : [`--setenv=VIMMA_EXPECT_SAFEBROWSING_KEY=${expectKey ? 1 : 0}`];
  const artifact = flags.includes("--artifact");
  const rest = flags.filter((f) => f !== "--headed" && f !== "--artifact");
  if (!artifact)
    return { args: ["mochitest", ...headless, ...keyEnv, ...rest, ...mapped], env: {} };
  return {
    args: [
      "mochitest",
      ...headless,
      ...keyEnv,
      `--setenv=XUL_APP_FILE=${engine}obj-artifact/dist/bin/browser/application.ini`,
      ...rest,
      ...mapped,
    ],
    env: { MOZCONFIG: `${engine}mozconfig.artifact` },
  };
}

/**
 * The test browser's environment: ours plus `extra`, without HYPRLAND_INSTANCE_SIGNATURE, so no
 * test (even --headed) talks to the developer's own Hyprland (docs/specs/private-swap.md).
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} extra
 */
export function childEnv(env, extra) {
  const out = { ...env, ...extra };
  delete out.HYPRLAND_INSTANCE_SIGNATURE;
  return out;
}

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
function pythonVersion(path) {
  const res = spawnSync(path, ["-c", "import platform; print(platform.python_version())"], {
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const engine = new URL("../engine/", import.meta.url).pathname;
  const expectKey = expectSafeBrowsingKey(process.env, homedir(), existsSync);
  const { args, env } = mochitestCommand(process.argv.slice(2), engine, expectKey);
  // A bare `./mach build` since the artifact build regenerates application.ini, not our copy.
  if (env.MOZCONFIG) refreshAppIni(engine);
  const bounds = machPythonBounds(readFileSync(join(engine, "mach"), "utf8"));
  /** @type {string[]} */
  let command = ["./mach"];
  if (bounds) {
    const pick = pickMachPython(process.env, bounds, existsSync, pythonVersion);
    const range = `${bounds.min.join(".")} to ${bounds.max.join(".")}`;
    if (!pick.python) {
      console.error(
        `npm run mochitest: mach supports Python ${range} (engine/mach), and none was found on PATH.`,
      );
      if (pick.tried.length) console.error(`Found outside that range: ${pick.tried.join(", ")}.`);
      console.error("Install a Python in that range, or set VIMMA_MACH_PYTHON to one.");
      process.exit(1);
    }
    if (pick.tried.length)
      console.log(
        `npm run mochitest: using ${pick.python} (${pick.version}); mach supports Python ${range}.`,
      );
    command = [pick.python, "./mach"];
  }
  const res = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: engine,
    stdio: "inherit",
    env: childEnv(process.env, env),
  });
  process.exit(res.status ?? 1);
}
