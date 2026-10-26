// Runs our mochitests through mach. `surfer import` symlinks tests/ under this engine path.
// --artifact: against the artifact build (ADR-010, tools/artifact-build/artifact-build.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAppIni } from "./artifact-build/artifact-build.mjs";
import { machPythonOrExit } from "./mach-python.mjs";

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
 * @param {{ platform?: string, src?: string }} [host] the OS, and the real path of the repo's src/
 * @returns {{ args: string[], env: Record<string, string> }} mach arguments and extra env
 */
export function mochitestCommand(argv, engine, expectKey, host = {}) {
  const { platform = process.platform } = host;
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
  // engine/'s chrome files link into src/, outside the tree the mac content sandbox may read;
  // mach turns this into security.sandbox.content.mac.testing_read_path2. Linux runs do not need it.
  if (platform === "darwin") {
    const src = host.src ?? realpathSync(fileURLToPath(new URL("../src", import.meta.url)));
    rest.unshift(`--sandbox-read-whitelist=${src}`);
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const engine = new URL("../engine/", import.meta.url).pathname;
  const expectKey = expectSafeBrowsingKey(process.env, homedir(), existsSync);
  const { args, env } = mochitestCommand(process.argv.slice(2), engine, expectKey);
  // A bare `./mach build` since the artifact build regenerates application.ini, not our copy.
  if (env.MOZCONFIG) refreshAppIni(engine);
  const python = machPythonOrExit(engine, "npm run mochitest");
  const command = python ? [python, "./mach"] : ["./mach"];
  const res = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: engine,
    stdio: "inherit",
    env: childEnv(process.env, env),
  });
  process.exit(res.status ?? 1);
}
