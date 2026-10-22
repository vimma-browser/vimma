/**
 * npm start: launch the local Vimma build with a persistent dev profile.
 *
 *   npm start                          # full build if present, else the artifact build
 *   npm start -- --profile DIR         # another profile (default ~/.cache/vimma-dev-profile)
 *   npm start -- --fresh               # a throwaway profile, removed on exit
 *   npm start -- --import              # run `npm run import` first
 *   npm start -- -- --jsconsole URL    # anything after a second -- goes to the browser
 *
 * No `--no-remote`: Firefox 157 strips it unread, and remoting stays on either way. It never hands
 * off to a running Firefox: remoting is keyed by app name and profile (D-Bus
 * org.mozilla.vimma.<profile>), so the dev instance only answers `vimma <args>` for its own
 * profile, such as the Omarchy hook's `-vimma-reload-theme`. The profile's user.js gets
 * security.sandbox.content.read_path_whitelist = <repo>/src/: in a local objdir the
 * chrome files are symlinks into engine/, which `surfer import` links to this repo's src/, outside
 * the Firefox tree, so the content sandbox refuses to read them and VimmaChild never loads. On
 * macOS the pref is security.sandbox.content.mac.testing_read_path1 = <repo>/src instead.
 * Packaged builds copy the files and do not need it. It also turns on the developer tools a
 * shipped build keeps off (DEVTOOLS_PREFS). Other user.js lines are kept.
 * Refuses to start when the profile is in use by a running instance.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { refreshAppIni } from "./artifact-build/artifact-build.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
export const READ_PATH_PREF = "security.sandbox.content.read_path_whitelist";
/** The mac content sandbox's extra read path (dom/ipc/ContentParent.cpp), a Seatbelt subpath. */
export const MAC_READ_PATH_PREF = "security.sandbox.content.mac.testing_read_path1";
const FULL_OBJDIR = "obj-x86_64-pc-linux-gnu";
const ARTIFACT_OBJDIR = "obj-artifact";
const MAC_APP_BINARY = "dist/Vimma.app/Contents/MacOS/vimma";

/**
 * @param {string[]} argv arguments after `npm start --`
 * @param {string} home
 * @returns {{ profile: string, fresh: boolean, import: boolean, help: boolean,
 *   browserArgs: string[] }}
 */
export function parseStartArgs(argv, home) {
  const split = argv.indexOf("--");
  const own = split < 0 ? argv : argv.slice(0, split);
  const browserArgs = split < 0 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      profile: { type: "string" },
      fresh: { type: "boolean", default: false },
      import: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.fresh && values.profile !== undefined) {
    throw new Error("pass either --fresh or --profile, not both");
  }
  return {
    profile: values.profile ? resolve(values.profile) : join(home, ".cache", "vimma-dev-profile"),
    fresh: values.fresh,
    import: values.import,
    help: values.help,
    browserArgs,
  };
}

/**
 * The full build if there is one, else the artifact build, which runs Mozilla's binaries with
 * our front end through XUL_APP_FILE (ADR-010; tools/mochitest.mjs does the same).
 * On macOS both run the launcher inside dist/Vimma.app.
 * @param {{ engine: string, exists?: (path: string) => boolean, platform?: string,
 *   arch?: string }} options
 * @returns {{ kind: "full" | "artifact", binary: string, env: Record<string, string> }}
 */
export function selectBuild({
  engine,
  exists = existsSync,
  platform = process.platform,
  arch = process.arch,
}) {
  const mac = platform === "darwin";
  const fullObjdir = mac
    ? `obj-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : FULL_OBJDIR;
  const binary = mac ? MAC_APP_BINARY : "dist/bin/vimma";
  const full = join(engine, fullObjdir, binary);
  if (exists(full)) return { kind: "full", binary: full, env: {} };
  const artifact = join(engine, ARTIFACT_OBJDIR, binary);
  if (exists(artifact)) {
    return {
      kind: "artifact",
      binary: artifact,
      env: { XUL_APP_FILE: join(engine, ARTIFACT_OBJDIR, "dist/bin/browser/application.ini") },
    };
  }
  throw new Error(
    `no Vimma build: neither ${full} nor ${artifact} exists. Build one with ` +
      "`npx surfer build` (full) or `node tools/artifact-build/artifact-build.mjs` (artifact).",
  );
}

/**
 * @param {{ binary: string }} build
 * @param {string} profile
 * @param {string[]} extra
 * @returns {[string, string[]]}
 */
export function browserCommand(build, profile, extra) {
  return [build.binary, ["--profile", profile, ...extra]];
}

/**
 * Prefs every dev profile needs: content processes may read the repo's src/ (real path, as the
 * objdir's symlinks resolve to it; trailing slash, so the whole directory is allowed). macOS
 * takes the directory without the slash: the sandbox profile allows `(subpath <path>)`.
 * @param {string} root the repository root
 * @param {string} [platform] process.platform
 * @returns {Array<[string, string]>}
 */
export function devPrefs(root, platform = process.platform) {
  const src = `${realpathSync(root).replace(/\/$/, "")}/src`;
  if (platform === "darwin") return [[MAC_READ_PATH_PREF, src]];
  return [[READ_PATH_PREF, `${src}/`]];
}

/** Prefs whose value is a comma-separated list: merged, never replaced. */
const LIST_PREFS = new Set([READ_PATH_PREF]);
const USER_PREF = /^\s*user_pref\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(.*?)\s*\)\s*;?\s*$/;

/**
 * Merge prefs into the text of a user.js, keeping every other line as it was. A pref already
 * set is rewritten in place (a list pref gains the missing entries); a new one is appended.
 * @param {string} existing
 * @param {ReadonlyArray<readonly [string, string | number | boolean]>} prefs
 * @returns {string}
 */
export function mergeUserJs(existing, prefs) {
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const line = (/** @type {string} */ name, /** @type {unknown} */ value) =>
    `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
  for (const [name, value] of prefs) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const m = USER_PREF.exec(/** @type {string} */ (lines[i]));
      if (!m || JSON.parse(/** @type {string} */ (m[1])) !== name) continue;
      found = true;
      let next = value;
      if (LIST_PREFS.has(name)) {
        let old;
        try {
          old = JSON.parse(/** @type {string} */ (m[2]));
        } catch {
          old = "";
        }
        const entries = String(old)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!entries.includes(String(value))) entries.push(String(value));
        next = entries.join(",");
      }
      // an unchanged value keeps its line as written
      if (JSON.stringify(next) !== m[2]) lines[i] = line(name, next);
    }
    if (!found) lines.push(line(name, value));
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Developer tools a shipped build keeps off (docs/security.md, P8): the Browser Toolbox and a
 * chrome-privileged Browser Console, remote debugging, and dump() output on stdout. Only npm
 * start's profile gets them; the e2e harness shares devPrefs and needs none.
 * @type {ReadonlyArray<readonly [string, boolean]>}
 */
export const DEVTOOLS_PREFS = [
  ["devtools.chrome.enabled", true],
  ["devtools.debugger.remote-enabled", true],
  ["browser.dom.window.dump.enabled", true],
  ["devtools.console.stdout.chrome", true],
];

/**
 * What npm start writes into its profile's user.js.
 * @param {string} root the repository root
 * @param {string} [platform] process.platform
 * @returns {Array<readonly [string, string | boolean]>}
 */
export function startPrefs(root, platform = process.platform) {
  return [...devPrefs(root, platform), ...DEVTOOLS_PREFS];
}

/**
 * @param {string} profile
 * @param {ReadonlyArray<readonly [string, string | number | boolean]>} prefs
 */
export function prepareProfile(profile, prefs) {
  mkdirSync(profile, { recursive: true });
  const userJs = join(profile, "user.js");
  // Read, not exists-then-read; replace by rename, so a reader never sees half a file and a
  // link at user.js is replaced rather than written through (CodeQL js/file-system-race).
  let existing = "";
  try {
    existing = readFileSync(userJs, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  const merged = mergeUserJs(existing, prefs);
  if (merged === existing) return;
  const tmp = `${userJs}.${process.pid}.tmp`;
  writeFileSync(tmp, merged, { flag: "wx" });
  renameSync(tmp, userJs);
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
  }
}

/** @returns {string} */
function readProcLocks() {
  try {
    return readFileSync("/proc/locks", "utf8");
  } catch {
    return "";
  }
}

/**
 * The pids that have `path` open, from lsof (macOS has no /proc/locks).
 * @param {string} path
 * @returns {number[]}
 */
function lsofPids(path) {
  const res = spawnSync("lsof", ["-t", path], { encoding: "utf8" });
  return (res.stdout ?? "")
    .split("\n")
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

/**
 * Whether a running instance holds the profile. Firefox on Linux holds a POSIX lock on
 * `.parentlock` while it runs (the file itself stays after exit) and points the `lock` symlink
 * at `ip:+pid` (which a crash, or even a quit, can leave behind). So: a live lock on
 * `.parentlock` in /proc/locks, else a `lock` symlink whose pid is alive.
 * On macOS (toolkit/profile/nsProfileLock.cpp) there is no `lock` link: a process that has
 * `.parentlock` open (it keeps the fcntl-locked file open while it runs), else a `.parentlock`
 * link, the fallback where fcntl locks are not supported.
 * @param {string} profile
 * @param {{ alive?: (pid: number) => boolean, procLocks?: () => string,
 *   openers?: (path: string) => number[], platform?: string }} [deps]
 * @returns {{ pid: number | null } | null}
 */
export function profileInUse(
  profile,
  {
    alive = pidAlive,
    procLocks = readProcLocks,
    openers = lsofPids,
    platform = process.platform,
  } = {},
) {
  const mac = platform === "darwin";
  let ino = null;
  try {
    ino = statSync(join(profile, ".parentlock")).ino;
  } catch {
    // no .parentlock: never started, or not a Firefox profile yet
  }
  if (ino !== null && mac) {
    const pid = openers(join(profile, ".parentlock"))[0];
    if (pid !== undefined) return { pid };
  } else if (ino !== null) {
    for (const row of procLocks().split("\n")) {
      const m = /^\d+:\s+POSIX\s+\S+\s+\S+\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(row);
      if (m && Number(m[2]) === ino) return { pid: Number(m[1]) };
    }
  }
  let target;
  try {
    target = readlinkSync(join(profile, mac ? ".parentlock" : "lock"));
  } catch {
    return null;
  }
  const pid = /:\+(\d+)$/.exec(target)?.[1];
  if (pid === undefined) return { pid: null };
  return alive(Number(pid)) ? { pid: Number(pid) } : null;
}

function readHelp() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = /\/\*\*([^]*?)\*\//.exec(src)?.[1] ?? "";
  return doc
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/** @returns {Promise<number>} exit code */
async function main() {
  let options;
  try {
    options = parseStartArgs(process.argv.slice(2), homedir());
  } catch (e) {
    process.stderr.write(`start: ${/** @type {Error} */ (e).message}\n\n${readHelp()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${readHelp()}\n`);
    return 0;
  }
  if (options.import) {
    const r = spawnSync("npm", ["run", "import"], { cwd: REPO, stdio: "inherit" });
    if (r.status !== 0) {
      process.stderr.write("start: npm run import failed\n");
      return r.status ?? 1;
    }
  }
  const engine = join(REPO, "engine");
  const build = selectBuild({ engine });
  // A bare `./mach build` regenerates application.ini, not the copy XUL_APP_FILE names.
  if (build.kind === "artifact") refreshAppIni(engine);

  const profile = options.fresh
    ? mkdtempSync(join(tmpdir(), "vimma-fresh-profile-"))
    : options.profile;
  const held = profileInUse(profile);
  if (held) {
    process.stderr.write(
      `start: Vimma is already running with ${profile}` +
        `${held.pid ? ` (pid ${held.pid})` : ""}. Switch to that window, quit it first, or ` +
        "pass --profile DIR / --fresh for a second instance.\n",
    );
    return 1;
  }
  prepareProfile(profile, startPrefs(REPO));
  const [bin, args] = browserCommand(build, profile, options.browserArgs);
  console.log(`start: ${build.kind} build ${bin}\nstart: profile ${profile}`);
  const child = spawn(bin, args, { stdio: "inherit", env: { ...process.env, ...build.env } });
  // Ctrl+C in the terminal reaches the browser too (same process group); wait for it to quit,
  // so a --fresh profile is removed after it.
  process.on("SIGINT", () => {});
  const code = await new Promise((done) => {
    child.on("exit", (c, sig) => done(c ?? (sig ? 128 : 1)));
    child.on("error", (e) => {
      process.stderr.write(`start: cannot run ${bin}: ${e.message}\n`);
      done(1);
    });
  });
  if (options.fresh) rmSync(profile, { recursive: true, force: true });
  return /** @type {number} */ (code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`start: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
