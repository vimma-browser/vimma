// npm run build: `surfer build` (or `./mach build` with --mach) under a Python that engine/mach
// supports (#458). Surfer runs `./mach`, whose `#!/usr/bin/env python3` takes the first python3
// on PATH, so the chosen interpreter goes first on PATH through a directory of links to it.
//
//   npm run build                  # full build (npx surfer build)
//   npm run build -- --ui          # front end only (npx surfer build --ui)
//   npm run build -- --mach        # ./mach build, after a moz.build change
//   npm run build -- --dry-run     # print the command and the python3 mach would get
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { machEnv, machPythonOrExit, writePythonShim } from "./mach-python.mjs";

/**
 * @param {string[]} argv arguments after `npm run build --`
 * @param {string} root absolute path of the checkout
 * @param {string} engine absolute path of engine/
 * @param {string} python the interpreter for `./mach`
 * @returns {{ command: string, args: string[], cwd: string, dryRun: boolean }}
 */
export function buildCommand(argv, root, engine, python) {
  const dryRun = argv.includes("--dry-run");
  const mach = argv.includes("--mach");
  const rest = argv.filter((a) => a !== "--dry-run" && a !== "--mach");
  if (mach) return { command: python, args: ["./mach", "build", ...rest], cwd: engine, dryRun };
  return { command: "surfer", args: ["build", ...rest], cwd: root, dryRun };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const engine = join(root, "engine");
  if (!existsSync(join(engine, "mach"))) {
    console.error("npm run build: engine/mach not found; run `npx surfer download` first.");
    process.exit(1);
  }
  // null when engine/mach no longer declares its range: then mach finds python3 on PATH itself.
  const python = machPythonOrExit(engine, "npm run build");
  const argv = process.argv.slice(2);
  const { command, args, cwd, dryRun } = buildCommand(argv, root, engine, python ?? "python3");
  const shim = mkdtempSync(join(tmpdir(), "vimma-build-python-"));
  let status;
  try {
    if (python) writePythonShim(shim, python);
    const env = machEnv(process.env, shim, homedir(), existsSync);
    if (dryRun) {
      const probe = spawnSync(
        "python3",
        ["-c", "import platform, sys; print(platform.python_version(), sys.executable)"],
        { env, encoding: "utf8" },
      );
      console.log(`npm run build: would run \`${[command, ...args].join(" ")}\` in ${cwd}`);
      console.log(`npm run build: python3 on its PATH: ${probe.stdout.trim() || "did not run"}`);
      status = probe.status ?? 1;
    } else {
      const res = spawnSync(command, args, { cwd, env, stdio: "inherit" });
      status = res.status ?? 1;
    }
  } finally {
    rmSync(shim, { recursive: true, force: true });
  }
  process.exit(status ?? 1);
}
