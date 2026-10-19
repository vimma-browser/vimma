// Starts a real Vimma build for an e2e scenario (spec m0-e2e-harness): finds the build, writes a
// throwaway profile with the control socket on, starts Xvfb when there is no display (or when
// asked), spawns the browser in its own process group, waits for <profile>/vimma-control.json,
// and tears it all down again: the whole process tree, Xvfb, the profile unless kept.
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateMessage } from "../../packages/vimma-core/src/control.mjs";
import { devPrefs } from "../start.mjs";

const ENGINE = fileURLToPath(new URL("../../engine/", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** What the browser prints when a module of ours cannot be loaded (e.g. by the content sandbox). */
export const VIMMA_LOAD_FAILURE = /Failed to load chrome:\/\/browser\/content\/vimma\/\S*/;
export const FULL_OBJDIR = "obj-x86_64-pc-linux-gnu";
export const ARTIFACT_OBJDIR = "obj-artifact";
export const WINDOW = Object.freeze({ width: 1280, height: 800 });
export const DISCOVERY_FILE = "vimma-control.json";
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Prefs for the throwaway profile. The control socket on; everything that would pop up a first
 * run page, a dialog or reach the network off. Mostly the engine's
 * remote/shared/RecommendedPreferences.sys.mjs (what Marionette applies), plus telemetry and
 * stable-pixel settings for screenshots.
 * @type {ReadonlyArray<readonly [string, boolean | number | string]>}
 */
export const PROFILE_PREFS = Object.freeze([
  ["vimma.control.enabled", true],
  // The browser runs outside a test harness here, so the first-run setup would open a tab of
  // its own in every scenario (docs/specs/first-run-setup.md decision 1).
  ["vimma.setup.offered", true],
  // Screenshots in Vimma's built-in colours, whatever Omarchy theme the machine has (HOME is
  // already inside the profile; this keeps baselines stable if that ever changes).
  ["vimma.theme.source", "builtin"],
  // No first-run config.toml under the profile's HOME: its "created …" notice would sit in the
  // first screenshots. browser_vimma_config_first_run.js covers the first run.
  ["vimma.config.firstRunDone", true],
  // first run, default browser, welcome and what's-new pages
  ["browser.shell.checkDefaultBrowser", false],
  ["browser.startup.homepage_override.mstone", "ignore"],
  ["browser.startup.page", 0],
  ["startup.homepage_welcome_url", "about:blank"],
  ["startup.homepage_welcome_url.additional", ""],
  ["browser.aboutwelcome.enabled", false],
  ["browser.preonboarding.enabled", false],
  ["termsofuse.bypassNotification", true],
  ["browser.startup.couldRestoreSession.count", -1],
  ["browser.sessionstore.resume_from_crash", false],
  ["toolkit.startup.max_resumed_crashes", -1],
  ["browser.tabs.warnOnClose", false],
  ["browser.warnOnQuit", false],
  // ctrl+q quits without a dialog: teardown quits that way, so quit observers remove the
  // discovery file (a signal skips them; spec m0-control-server)
  ["browser.warnOnQuitShortcut", false],
  ["browser.newtabpage.enabled", false],
  ["browser.uitour.enabled", false],
  // telemetry and data reporting
  ["datareporting.policy.dataSubmissionEnabled", false],
  ["datareporting.policy.dataSubmissionPolicyBypassNotification", true],
  ["datareporting.healthreport.uploadEnabled", false],
  ["datareporting.usage.uploadEnabled", false],
  ["toolkit.telemetry.enabled", false],
  ["toolkit.telemetry.unified", false],
  ["toolkit.telemetry.archive.enabled", false],
  ["toolkit.telemetry.server", "data:,"],
  ["telemetry.fog.test.localhost_port", -1],
  ["app.normandy.enabled", false],
  ["app.normandy.api_url", ""],
  ["app.shield.optoutstudies.enabled", false],
  // updates and background network
  ["app.update.disabledForTesting", true],
  ["extensions.update.enabled", false],
  ["extensions.getAddons.cache.enabled", false],
  ["extensions.systemAddon.update.enabled", false],
  ["browser.search.update", false],
  ["browser.region.network.url", ""],
  ["browser.safebrowsing.malware.enabled", false],
  ["browser.safebrowsing.phishing.enabled", false],
  ["browser.safebrowsing.downloads.enabled", false],
  ["browser.safebrowsing.blockedURIs.enabled", false],
  ["browser.safebrowsing.update.enabled", false],
  ["services.settings.server", "data:,#remote-settings-dummy/v1"],
  ["network.captive-portal-service.enabled", false],
  ["network.connectivity-service.enabled", false],
  ["browser.urlbar.suggest.searches", false],
  ["browser.topsites.contile.enabled", false],
  ["browser.translations.enable", false],
  ["browser.ml.enable", false],
  ["dom.push.connection.enabled", false],
  ["geo.provider.network.url", ""],
  ["signon.rememberSignons", false],
  // stable pixels for screenshots
  ["ui.prefersReducedMotion", 1],
  ["gfx.webrender.software", true],
  ["browser.toolbars.bookmarks.visibility", "never"],
  ["focusmanager.testmode", true],
  // the same pixels on every machine: one device pixel per CSS pixel whatever the desktop's
  // scaling, and a light theme whatever the desktop's (a desktop's GDK_SCALE=2 once leaked in)
  ["layout.css.devPixelsPerPx", "1.0"],
  ["ui.systemUsesDarkTheme", 0],
  ["layout.css.prefers-color-scheme.content-override", 1],
]);

/**
 * @param {ReadonlyArray<readonly [string, boolean | number | string]>} prefs
 * @returns {string} user.js
 */
export function userJs(prefs) {
  return prefs
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
    .join("");
}

/**
 * A new private profile directory under `tmpRoot` with our user.js.
 * @param {string} [tmpRoot]
 * @param {Record<string, boolean | number | string | null>} [overrides] a scenario's `prefs`:
 *   a value replaces ours; null leaves the pref out, so the build's own default applies (e.g.
 *   Vimma's `browser.startup.page = 3`, which a restart scenario needs)
 */
export function createProfile(tmpRoot = tmpdir(), overrides = {}) {
  const dir = mkdtempSync(join(tmpRoot, "vimma-e2e-profile-"));
  // plus npm start's dev prefs: content processes may read the repo's src/, where a local
  // objdir's chrome files lead (tools/start.mjs); harmless for a packaged build
  const prefs = new Map([...PROFILE_PREFS, ...devPrefs(REPO)]);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) prefs.delete(name);
    else prefs.set(name, value);
  }
  writeFileSync(join(dir, "user.js"), userJs([...prefs]));
  return dir;
}

/** @typedef {{ binary: string, env: Record<string, string> }} Build */

/**
 * Which build to run; see the spec's Launcher section for the order.
 * @param {{ build?: string, artifact?: boolean, engine?: string,
 *   env?: Record<string, string | undefined>, exists?: (path: string) => boolean }} options
 * @returns {Build}
 */
export function findBuild({
  build,
  artifact = false,
  engine = ENGINE,
  env = {},
  exists = existsSync,
}) {
  const artifactBin = join(engine, ARTIFACT_OBJDIR, "dist/bin/vimma");
  const artifactBuild = {
    binary: artifactBin,
    env: { XUL_APP_FILE: join(engine, ARTIFACT_OBJDIR, "dist/bin/browser/application.ini") },
  };
  /** @param {string} p */
  const explicit = (p) => {
    if (exists(join(p, "vimma"))) return { binary: join(p, "vimma"), env: {} }; // dist/bin
    if (exists(p)) return { binary: p, env: {} };
    throw new Error(`no Vimma binary at ${p} (pass the binary or its dist/bin directory)`);
  };
  if (build) return explicit(build);
  if (artifact) {
    if (!exists(artifactBin)) {
      throw new Error(
        `no artifact build at ${artifactBin}: run node tools/artifact-build/artifact-build.mjs`,
      );
    }
    return artifactBuild;
  }
  if (env.VIMMA_E2E_BUILD) return explicit(env.VIMMA_E2E_BUILD);
  const full = join(engine, FULL_OBJDIR, "dist/bin/vimma");
  if (exists(full)) return { binary: full, env: {} };
  if (exists(artifactBin)) return artifactBuild;
  throw new Error(
    `no Vimma build found; tried ${full} and ${artifactBin}. Build one, or pass --build, ` +
      "--artifact or --tarball (or set VIMMA_E2E_BUILD)",
  );
}

/**
 * Unpack a `./mach package` tarball (vimma-*.tar.xz) into `dir`; returns the build in it.
 * @param {string} tarball
 * @param {string} dir
 * @returns {Build}
 */
export function unpackTarball(tarball, dir) {
  execFileSync("tar", ["-xJf", tarball, "-C", dir]);
  const binary = join(dir, "vimma", "vimma");
  if (!existsSync(binary))
    throw new Error(`${tarball} has no vimma/vimma: not a ./mach package tarball?`);
  return { binary, env: {} };
}

/**
 * @param {string} profile
 * @param {{ width: number, height: number }} window
 * @param {{ url?: string | null, extra?: readonly string[] }} [options] `url`: the page to open;
 *   null on a restart, where a URL would open beside the restored session, which a user's plain
 *   restart never does. `extra`: more switches, before the URL (the site suite's
 *   --start-debugger-server, docs/specs/site-compat.md)
 */
export function browserArgs(profile, { width, height }, { url = "about:blank", extra = [] } = {}) {
  return [
    "-no-remote",
    "-profile",
    profile,
    // BrowserContentHandler getFeatures: the first window's size and position
    "-width",
    String(width),
    "-height",
    String(height),
    "-left",
    "0",
    "-top",
    "0",
    ...extra,
    ...(url === null ? [] : [url]),
  ];
}

/** Passed through from the caller: who we are, where programs are, and debugging switches. */
const ENV_PASSTHROUGH = ["PATH", "USER", "LOGNAME", "MOZ_HEADLESS", "MOZ_LOG", "MOZ_LOG_FILE"];
/** Also passed through when the browser uses the caller's display instead of our Xvfb. */
const DISPLAY_PASSTHROUGH = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"];

/**
 * The browser's environment, built from an allowlist rather than inherited, so a developer's
 * desktop (GDK_SCALE, GDK_DPI_SCALE, QT_*SCALE*, GTK_THEME, Wayland, locale, fontconfig and GTK
 * settings under HOME) cannot change what the screenshots show. HOME and TMPDIR live inside the
 * profile, so the user's ~/.config is not read and temp files go away with the profile. Under
 * our Xvfb the browser is forced onto X11.
 * @param {Record<string, string | undefined>} base
 * @param {{ display?: string, home?: string, tmp?: string, extra?: Record<string, string> }} o
 * @returns {Record<string, string>}
 */
export function browserEnv(base, { display, home, tmp, extra = {} }) {
  /** @type {Record<string, string>} */
  const env = {};
  const keep = display ? ENV_PASSTHROUGH : [...ENV_PASSTHROUGH, ...DISPLAY_PASSTHROUGH];
  for (const k of keep) {
    const v = base[k];
    if (v !== undefined) env[k] = v;
  }
  if (home) env.HOME = home;
  if (tmp) env.TMPDIR = tmp;
  env.LANG = "C.UTF-8";
  env.TZ = "UTC";
  env.GTK_THEME = "Adwaita";
  env.MOZ_CRASHREPORTER_DISABLE = "1";
  if (display) {
    env.DISPLAY = display;
    env.GDK_BACKEND = "x11";
    env.MOZ_ENABLE_WAYLAND = "0";
  }
  return { ...env, ...extra };
}

/** @param {string} [pathEnv] @returns {string | null} the Xvfb binary on PATH */
export function findXvfb(pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && existsSync(join(dir, "Xvfb"))) return join(dir, "Xvfb");
  }
  return null;
}

const XVFB_PACKAGES =
  "install Xvfb: package xvfb (Ubuntu/Debian), xorg-server-xvfb (Arch), xorg-x11-server-Xvfb (Fedora)";

/**
 * @typedef {{ display: string, fbFile: string, stop: () => Promise<void> }} Display
 */

/**
 * Xvfb's arguments: a free display reported on fd 3, the screen at 24-bit depth and 96 dpi,
 * black root, no cursor, the framebuffer kept as an XWD file in `fbdir` (the capture path).
 * @param {{ width: number, height: number, fbdir: string }} o
 */
export function xvfbArgs({ width, height, fbdir }) {
  return [
    "-displayfd",
    "3",
    "-screen",
    "0",
    `${width}x${height}x24`,
    "-dpi",
    "96",
    "-fbdir",
    fbdir,
    "-br",
    "-nocursor",
    "-nolisten",
    "tcp",
    "-noreset",
  ];
}

/**
 * Start Xvfb (see xvfbArgs). An abort `signal` while it starts kills it and removes the fbdir;
 * every failure path does too, so nothing outlives a cancelled launch.
 * @param {{ width: number, height: number, bin?: string | null, timeoutMs?: number,
 *   signal?: AbortSignal, env?: Record<string, string | undefined> }} options
 * @returns {Promise<Display>}
 */
export async function startXvfb({
  width,
  height,
  bin = findXvfb(),
  timeoutMs = 10_000,
  signal,
  env = process.env,
}) {
  if (!bin || !existsSync(bin))
    throw new Error(`Xvfb not found (${bin ?? "not on PATH"}); ${XVFB_PACKAGES}`);
  signal?.throwIfAborted();
  const fbdir = mkdtempSync(join(tmpdir(), "vimma-e2e-xvfb-"));
  /** @type {import("node:child_process").ChildProcess} */
  let child;
  try {
    child = spawn(bin, xvfbArgs({ width, height, fbdir }), {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
      detached: true,
      env,
    });
  } catch (e) {
    rmSync(fbdir, { recursive: true, force: true });
    throw e;
  }
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const fd3 = /** @type {import("node:stream").Readable} */ (child.stdio[3]);
  /** @type {Promise<void> | null} */
  let stopping = null;
  const stop = () =>
    (stopping ??= (async () => {
      await killTree(child, { graceMs: 2000 });
      rmSync(fbdir, { recursive: true, force: true });
    })());
  try {
    const display = await new Promise((resolve, reject) => {
      let out = "";
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        done();
        reject(new Error("Xvfb start aborted"));
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Xvfb did not start in ${timeoutMs} ms: ${stderr}`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      fd3.on("data", (d) => {
        out += d;
        const m = /^(\d+)\n/.exec(out);
        if (m) {
          done();
          resolve(`:${m[1]}`);
        }
      });
      child.on("error", (e) => {
        done();
        reject(new Error(`cannot start Xvfb: ${e.message}; ${XVFB_PACKAGES}`));
      });
      child.on("exit", (code) => {
        done();
        reject(new Error(`Xvfb exited with code ${code}: ${stderr.trim()}`));
      });
    });
    return { display, fbFile: join(fbdir, "Xvfb_screen0"), stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/**
 * A file's permission bits and text, both from one open descriptor: the mode checked is the mode
 * of the file read, even if the path is replaced in between (CodeQL js/file-system-race).
 * @param {string} path
 * @returns {{ mode: number, text: string }}
 */
function readWithMode(path) {
  const fd = openSync(path, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Wait for the control server's discovery file: present, valid protocol v1, mode 0600. After a
 * crash-style kill the dead browser's file is still there: `stalePid` (its pid) makes the wait
 * skip it until the new browser replaces it.
 * @param {string} profile
 * @param {{ timeoutMs?: number, intervalMs?: number,
 *   exited?: () => { code: number | null, signal: string | null } | null,
 *   stderrTail?: () => string, stalePid?: number | null }} [options]
 * @returns {Promise<{ protocol: number, port: number, token: string, pid: number }>}
 */
export async function waitForDiscovery(
  profile,
  {
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    intervalMs = 50,
    exited = () => null,
    stderrTail = () => "",
    stalePid = null,
  } = {},
) {
  const path = join(profile, DISCOVERY_FILE);
  const deadline = Date.now() + timeoutMs;
  const tail = () => {
    const t = stderrTail().trim();
    return t ? `\nbrowser stderr (last lines):\n${t}` : "";
  };
  let problem = "it does not exist";
  for (;;) {
    const exit = exited();
    if (exit) {
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      throw new Error(`the browser exited with ${how} before its control socket came up${tail()}`);
    }
    /** @type {{ mode: number, text: string } | null} */
    let file = null;
    try {
      file = readWithMode(path);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") {
        problem = `it cannot be read yet: ${/** @type {Error} */ (e).message}`;
      }
    }
    if (file) {
      try {
        const { mode } = file;
        const body = JSON.parse(file.text);
        const { valid, errors } = validateMessage(body, { kind: "discovery" });
        if (mode & 0o077) problem = `it has mode ${mode.toString(8)}, not 600`;
        else if (!valid) problem = `it is invalid: ${errors.join("; ")}`;
        else if (stalePid !== null && body.pid === stalePid) {
          problem = `it is the one left by the killed browser (pid ${stalePid})`;
        } else return body;
      } catch (e) {
        problem = `it cannot be read yet: ${/** @type {Error} */ (e).message}`; // mid-rename
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no usable control socket within ${timeoutMs} ms (is vimma.control.enabled on, and ` +
          `does the build have the control server?): ${path}: ${problem}${tail()}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** @param {number} pgid */
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process started with `detached: true` and everything in its process group (Firefox's
 * content processes): SIGTERM, then SIGKILL after `graceMs`, then wait until the group is gone.
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ graceMs?: number }} [options]
 */
export async function killTree(child, { graceMs = 5000 } = {}) {
  const pid = child.pid;
  if (!pid) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
    else child.once("exit", () => resolve(undefined));
  });
  /** @param {NodeJS.Signals} signal */
  const signal = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(25);
  if (groupAlive(pid)) signal("SIGKILL");
  await exited;
  const reapDeadline = Date.now() + 5000;
  while (groupAlive(pid) && Date.now() < reapDeadline) await sleep(25);
}

/**
 * Crash the browser the harness started: SIGKILL to its pid alone, as a crash or the OOM killer
 * would, so no quit observer runs and SessionStore writes nothing more. Its content processes
 * notice the dead parent and exit; any still in the harness's process group after `reapMs` are
 * SIGKILLed so the relaunch starts clean. Never a name-based kill (pkill -f): only this pid
 * and its group.
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ reapMs?: number }} [options]
 * @returns {Promise<number>} the killed pid (the stale discovery file names it)
 */
export async function crashBrowser(child, { reapMs = 5000 } = {}) {
  const pid = child.pid;
  if (!pid) throw new Error("crashBrowser: the browser has no pid");
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error("crashBrowser: the browser already exited");
  }
  const exited = new Promise((resolve) => child.once("exit", () => resolve(undefined)));
  process.kill(pid, "SIGKILL");
  await exited;
  const deadline = Date.now() + reapMs;
  while (groupAlive(pid) && Date.now() < deadline) await sleep(25);
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone meanwhile
    }
    const reapDeadline = Date.now() + 5000;
    while (groupAlive(pid) && Date.now() < reapDeadline) await sleep(25);
  }
  return pid;
}

/** SessionStore's periodic save, written every `browser.sessionstore.interval` ms when dirty. */
export const RECOVERY_FILE = join("sessionstore-backups", "recovery.jsonlz4");

/**
 * Before a crash-style kill: wait until SessionStore's recovery file exists and has not changed
 * for `quietMs`, counted from this call at the earliest. SessionStore writes it at most every
 * `browser.sessionstore.interval` ms while the session is dirty, so a quiet period of a few
 * intervals means everything the scenario did before is on disk, which is what a crash keeps.
 * @param {string} profile
 * @param {{ quietMs?: number, timeoutMs?: number, pollMs?: number }} [options]
 */
export async function waitForSessionSaved(
  profile,
  { quietMs = 3000, timeoutMs = 30_000, pollMs = 100 } = {},
) {
  const path = join(profile, RECOVERY_FILE);
  const started = Date.now();
  const deadline = started + timeoutMs;
  /** @type {number | null} */
  let mtime = null;
  let since = started;
  for (;;) {
    const now = existsSync(path) ? statSync(path).mtimeMs : null;
    if (now !== mtime) {
      mtime = now;
      since = Math.max(started, Date.now());
    }
    if (mtime !== null && Date.now() - since >= quietMs) return;
    if (Date.now() >= deadline) {
      const what =
        mtime === null ? "was never written" : `did not stay unchanged for ${quietMs} ms`;
      throw new Error(`${path} ${what} within ${timeoutMs} ms`);
    }
    await sleep(pollMs);
  }
}

/**
 * Quit the browser the way a user would, `send-keys ctrl+q`, so quit observers run and remove
 * the discovery file; a signal skips them (spec m0-control-server). The help overlay swallows
 * ctrl+q, so it is closed with `esc` first. Never throws: on any trouble, or when the browser has
 * not exited within `timeoutMs`, it returns false and the caller falls back to killTree.
 * @param {{
 *   ctl: { state: () => Promise<Record<string, any>>, sendKeys: (keys: string) => Promise<void> },
 *   child: { exitCode: number | null, signalCode: string | null,
 *     once: (event: "exit", f: () => void) => unknown },
 *   timeoutMs?: number,
 *   pollMs?: number,
 * }} options
 * @returns {Promise<boolean>} whether the browser exited
 */
export async function quitBrowser({ ctl, child, timeoutMs = 10_000, pollMs = 50 }) {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const deadline = Date.now() + timeoutMs;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
  const attempt = async () => {
    let state = await ctl.state();
    if (state.mode === "help") {
      await ctl.sendKeys("esc");
      while (state.mode === "help" && Date.now() < deadline) {
        await sleep(pollMs);
        state = await ctl.state();
      }
    }
    // The reply may be lost as the browser goes down; the exit is what counts.
    await ctl.sendKeys("ctrl+q").catch(() => {});
    return exited;
  };
  try {
    return /** @type {boolean} */ (await Promise.race([attempt().catch(() => false), timeout]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {{
 *   profile: string,
 *   child: import("node:child_process").ChildProcess,
 *   display: Display | null,
 *   discovery: { protocol: number, port: number, token: string, pid: number },
 *   stderrTail: () => string,
 *   loadFailure: () => string | null,
 *   relaunch: (options?: { stalePid?: number }) => Promise<void>,
 *   teardown: () => Promise<void>,
 * }} Session
 */

/**
 * Launch a build and wait for its control socket. On any failure everything started so far is
 * torn down before the error is thrown. `teardown` is handed out (onTeardown) before anything
 * slow starts and is idempotent; calling it, or aborting `signal`, at any point (Xvfb still
 * starting, the discovery wait) stops the Xvfb, kills the browser and removes the profile.
 * `relaunch` starts the browser again on the same profile and display once it has exited (a
 * restart: the caller quits it first and checks the discovery file is gone, or after
 * crashBrowser passes the killed pid as `stalePid`, whose discovery file stays); `child` and
 * `discovery` then describe the new one.
 * @param {{
 *   build: Build,
 *   xvfb?: boolean,
 *   xvfbBin?: string | null,
 *   xvfbEnv?: Record<string, string | undefined>,
 *   window?: { width: number, height: number },
 *   tmpRoot?: string,
 *   prefs?: Record<string, boolean | number | string | null>,
 *   keep?: boolean,
 *   args?: readonly string[],
 *   discoveryTimeoutMs?: number,
 *   graceMs?: number,
 *   baseEnv?: Record<string, string | undefined>,
 *   signal?: AbortSignal,
 *   onSpawn?: (child: import("node:child_process").ChildProcess) => void,
 *   onTeardown?: (teardown: () => Promise<void>) => void,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<Session>}
 */
export async function launch({
  build,
  xvfb = !process.env.DISPLAY,
  xvfbBin = findXvfb(),
  xvfbEnv = process.env,
  window = WINDOW,
  tmpRoot = tmpdir(),
  prefs = {},
  keep = false,
  args = [],
  discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  graceMs = 5000,
  baseEnv = process.env,
  signal,
  onSpawn = () => {},
  onTeardown = () => {},
  log = () => {},
}) {
  /** @type {Display | null} */
  let display = null;
  /** @type {Promise<Display> | null} */
  let displayStarting = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  const cancel = new AbortController();
  const profile = createProfile(tmpRoot, prefs);
  const home = join(profile, ".e2e-home");
  const tmp = join(profile, ".e2e-tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  let stderr = "";
  /** @type {string | null} */
  let loadFailure = null;
  /** @type {Promise<void> | null} */
  let tearingDown = null;
  const teardown = () =>
    (tearingDown ??= (async () => {
      cancel.abort();
      if (child) await killTree(child, { graceMs });
      // Xvfb may still be starting: wait for that to settle (the abort makes it quick), then
      // stop whatever it started. startXvfb removes its fbdir itself when it fails.
      const started = await displayStarting?.catch(() => null);
      if (started) await started.stop();
      if (keep) log(`kept profile ${profile}`);
      else rmSync(profile, { recursive: true, force: true });
    })());
  onTeardown(teardown);
  const cancelled = () =>
    tearingDown ? new Error("launch aborted (cancelled or timed out)") : null;
  const stderrTail = () => stderr.split("\n").slice(-15).join("\n");

  /** Spawn the browser on the profile (with `url` on the command line) and wait for its socket. */
  const start = async (/** @type {string | null} */ url, stalePid = null) => {
    const env = browserEnv(baseEnv, { display: display?.display, home, tmp, extra: build.env });
    const spawned = spawn(build.binary, browserArgs(profile, window, { url, extra: args }), {
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;
    onSpawn(spawned);
    /** @type {{ code: number | null, signal: string | null } | null} */
    let exit = null;
    /** @type {Error | null} */
    let spawnError = null;
    spawned.on("exit", (code, sig) => (exit = { code, signal: sig }));
    spawned.on("error", (e) => (spawnError = e));
    spawned.stderr?.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
      loadFailure ??= VIMMA_LOAD_FAILURE.exec(stderr)?.[0] ?? null;
    });
    const discovery = await waitForDiscovery(profile, {
      timeoutMs: discoveryTimeoutMs,
      exited: () => {
        const stopped = cancelled();
        if (stopped) throw stopped;
        if (spawnError)
          throw new Error(
            `cannot start ${build.binary}: ${/** @type {Error} */ (spawnError).message}`,
          );
        return exit;
      },
      stderrTail,
      stalePid,
    });
    return { spawned, discovery };
  };

  const onAbort = () => void teardown();
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (xvfb && !tearingDown) {
      displayStarting = startXvfb({ ...window, bin: xvfbBin, signal: cancel.signal, env: xvfbEnv });
      display = await displayStarting;
    }
    const stop = cancelled();
    if (stop) throw stop;
    const first = await start("about:blank");
    signal?.removeEventListener("abort", onAbort);
    /** @type {Session} */
    const session = {
      profile,
      child: first.spawned,
      display,
      discovery: first.discovery,
      stderrTail,
      loadFailure: () => loadFailure,
      async relaunch({ stalePid } = {}) {
        const running = session.child;
        if (running.exitCode === null && running.signalCode === null) {
          throw new Error("relaunch: the browser is still running; quit it first");
        }
        const stopped = cancelled();
        if (stopped) throw stopped;
        const next = await start(null, stalePid ?? null);
        session.child = next.spawned;
        session.discovery = next.discovery;
      },
      teardown,
    };
    return session;
  } catch (e) {
    signal?.removeEventListener("abort", onAbort);
    const aborted = cancelled(); // before teardown(), which sets it
    await teardown();
    throw aborted ?? e;
  }
}
