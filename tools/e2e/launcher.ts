// Starts a real Vimma build for an e2e scenario (spec m0-e2e-harness): finds the build, writes a
// throwaway profile with the control socket on, starts Xvfb when there is no display (or when
// asked) or runs it headless (macOS), spawns the browser in its own process group, waits for <profile>/vimma-control.json,
// and tears it all down again: the whole process tree, Xvfb, the profile unless kept.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateMessage } from "../../packages/vimma-core/src/control/control.mjs";
import { CONFIG_PATH_PREF, READ_PATH_PREF, devPrefs } from "../start.ts";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

const ENGINE = fileURLToPath(new URL("../../engine/", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
/**
 * The fonts every screenshot is drawn with (issue #944): DejaVu 2.37, as on CI's ubuntu-24.04,
 * so a baseline made by CI matches on any Linux machine whatever fonts it has installed.
 */
export const E2E_FONTS = join(REPO, "tests", "e2e", "fonts");
/** The fontconfig file that offers the browser only those fonts (FONTCONFIG_FILE). */
export const E2E_FONTCONFIG = join(E2E_FONTS, "fonts.conf");

/**
 * GTK's settings in the profile's HOME, read when the fonts are pinned. Firefox draws its own UI
 * in GTK's font, and Arch's GTK ships /usr/share/gtk-3.0/settings.ini naming "Adwaita Sans 11",
 * while Ubuntu's ships none and GTK's built-in "Sans 10" applies there (CI). The user's file
 * wins over the system's, so every machine gets CI's: fonts.conf maps Sans to DejaVu Sans.
 */
export const GTK_SETTINGS = "[Settings]\ngtk-font-name = Sans 10\n";

/**
 * The fontconfig file for a scenario's browser: E2E_FONTCONFIG, except on macOS, which draws
 * text with Core Text rather than fontconfig and takes no screenshots (headless). Only the
 * scenarios pin their fonts: the site suite and the agent bench load real pages, which need the
 * machine's fonts for the scripts DejaVu lacks.
 */
export function scenarioFontconfig(platform: string = process.platform): string | null {
  return platform === "darwin" ? null : E2E_FONTCONFIG;
}
/** What the browser prints when a module of ours cannot be loaded (e.g. by the content sandbox). */
export const VIMMA_LOAD_FAILURE = /Failed to load chrome:\/\/browser\/content\/vimma\/\S*/;
export const FULL_OBJDIR = "obj-x86_64-pc-linux-gnu";
export const ARTIFACT_OBJDIR = "obj-artifact";
export const WINDOW = Object.freeze({ width: 1280, height: 800 });
export const DISCOVERY_FILE = "vimma-control.json";
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
/** How many of the browser's last stderr lines a failed launch prints with their times. */
export const STDERR_TIMELINE_LINES = 200;
/** Longer stderr lines are cut to this many characters in that report. */
export const STDERR_TIMELINE_CHARS = 1000;

type Pref = readonly [string, boolean | number | string];

/**
 * Prefs for the throwaway profile. The control socket on; everything that would pop up a first
 * run page, a dialog or reach the network off. Mostly the engine's
 * remote/shared/RecommendedPreferences.sys.mjs (what Marionette applies), plus telemetry and
 * stable-pixel settings for screenshots.
 */
export const PROFILE_PREFS: ReadonlyArray<Pref> = Object.freeze([
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
  // The URL bar's placeholder names the default engine from the first paint, as in a used
  // profile, where Firefox has saved its name here. A new profile shows the engine-less one until
  // the search service has started, and then keeps it while the bar is empty (UrlbarInputBase's
  // #deferUpdatePlaceholder), so a screenshot showed either (issue #944). Google is the default
  // with the region unknown (browser.region.network.url is off).
  ["browser.urlbar.placeholderName", "Google"],
  // A private window reads its own copy (SearchUIUtils.updatePlaceholderNamePreference), with the
  // same race (issue #953).
  ["browser.urlbar.placeholderName.private", "Google"],
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

/** @returns user.js */
export function userJs(prefs: ReadonlyArray<readonly [string, boolean | number | string]>): string {
  return prefs
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
    .join("");
}

/**
 * A new private profile directory under `tmpRoot` with our user.js.
 * @param [overrides] a scenario's `prefs`:
 *   a value replaces ours; null leaves the pref out, so the build's own default applies (e.g.
 *   Vimma's `browser.startup.page = 3`, which a restart scenario needs)
 * @param [o] more folders content processes may read (the
 *   pinned fonts': the Linux content sandbox reads fonts only from the system's font folders)
 */
export function createProfile(
  tmpRoot: string = tmpdir(),
  overrides: Record<string, boolean | number | string | null> = {},
  { readPaths = [] }: { readPaths?: readonly string[] } = {},
) {
  const dir = mkdtempSync(join(tmpRoot, "vimma-e2e-profile-"));
  // plus npm start's dev prefs: content processes may read the repo's src/, where a local
  // objdir's chrome files lead (tools/start.ts); harmless for a packaged build
  const prefs = new Map([...PROFILE_PREFS, ...devPrefs(REPO)]);
  // A config.toml of the profile's own, whatever HOME the browser is given (tools/start.ts).
  prefs.set(CONFIG_PATH_PREF, join(dir, "vimma", "config.toml"));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) prefs.delete(name);
    else prefs.set(name, value);
  }
  // After a scenario's prefs, so its own read paths add to the list rather than drop these.
  if (readPaths.length) {
    const own = prefs.get(READ_PATH_PREF);
    prefs.set(READ_PATH_PREF, [...(own ? [own] : []), ...readPaths].join(","));
  }
  writeFileSync(join(dir, "user.js"), userJs([...prefs]));
  return dir;
}

export type Build = { binary: string; env: Record<string, string> };

/** Which build to run; see the spec's Launcher section for the order. */
export function findBuild({
  build,
  artifact = false,
  engine = ENGINE,
  env = {},
  exists = existsSync,
}: {
  build?: string;
  artifact?: boolean;
  engine?: string;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}): Build {
  const artifactBin = join(engine, ARTIFACT_OBJDIR, "dist/bin/vimma");
  const artifactBuild = {
    binary: artifactBin,
    env: { XUL_APP_FILE: join(engine, ARTIFACT_OBJDIR, "dist/bin/browser/application.ini") },
  };
  const explicit = (p: string) => {
    if (exists(join(p, "vimma"))) return { binary: join(p, "vimma"), env: {} }; // dist/bin
    const app = join(p, "Contents/MacOS/vimma");
    if (exists(app)) return { binary: app, env: {} }; // Vimma.app
    if (exists(p)) return { binary: p, env: {} };
    throw new Error(
      `no Vimma binary at ${p} (pass the binary, its dist/bin directory or Vimma.app)`,
    );
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

/** Unpack a `./mach package` tarball (vimma-*.tar.xz) into `dir`; returns the build in it. */
export function unpackTarball(tarball: string, dir: string): Build {
  execFileSync("tar", ["-xJf", tarball, "-C", dir]);
  const binary = join(dir, "vimma", "vimma");
  if (!existsSync(binary))
    throw new Error(`${tarball} has no vimma/vimma: not a ./mach package tarball?`);
  return { binary, env: {} };
}

/**
 * @param [options] `url`: the page to open;
 *   null on a restart, where a URL would open beside the restored session, which a user's plain
 *   restart never does. `extra`: more switches, before the URL (the site suite's
 *   --start-debugger-server, docs/specs/site-compat.md)
 */
export function browserArgs(
  profile: string,
  { width, height }: { width: number; height: number },
  { url = "about:blank", extra = [] }: { url?: string | null; extra?: readonly string[] } = {},
) {
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
 * Headless (macOS), it gets MOZ_HEADLESS=1 and no display at all.
 * With `fontconfig`, fontconfig reads that file instead of the system's /etc/fonts, so the
 * machine's installed fonts and its choice for monospace or sans-serif do not reach the pixels.
 */
export function browserEnv(
  base: Record<string, string | undefined>,
  {
    display,
    headless = false,
    home,
    tmp,
    fontconfig = null,
    extra = {},
  }: {
    display?: string;
    headless?: boolean;
    home?: string;
    tmp?: string;
    fontconfig?: string | null;
    extra?: Record<string, string>;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = display || headless ? ENV_PASSTHROUGH : [...ENV_PASSTHROUGH, ...DISPLAY_PASSTHROUGH];
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
  if (fontconfig) env.FONTCONFIG_FILE = fontconfig;
  if (headless) env.MOZ_HEADLESS = "1";
  if (display) {
    env.DISPLAY = display;
    env.GDK_BACKEND = "x11";
    env.MOZ_ENABLE_WAYLAND = "0";
  }
  return { ...env, ...extra };
}

/**
 * Where the browser draws: our own Xvfb ("xvfb"), the caller's display ("display"), or nowhere
 * ("headless", MOZ_HEADLESS=1). macOS defaults to headless, even with a DISPLAY (XQuartz sets
 * one): the macOS build draws with Cocoa, not X11, so Xvfb has nothing to show.
 */
export function displayMode({
  platform = process.platform,
  xvfb = false,
  headless = false,
  env = process.env,
}: {
  platform?: string;
  xvfb?: boolean;
  headless?: boolean;
  env?: Record<string, string | undefined>;
}): "xvfb" | "display" | "headless" {
  if (xvfb && headless) throw new Error("pass either --xvfb or --headless, not both");
  if (xvfb) return "xvfb";
  if (headless || platform === "darwin") return "headless";
  return env.DISPLAY ? "display" : "xvfb";
}

/** @returns the Xvfb binary on PATH */
export function findXvfb(pathEnv: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && existsSync(join(dir, "Xvfb"))) return join(dir, "Xvfb");
  }
  return null;
}

const XVFB_PACKAGES =
  "install Xvfb: package xvfb (Ubuntu/Debian), xorg-server-xvfb (Arch), xorg-x11-server-Xvfb (Fedora)";

export type Display = { display: string; fbFile: string; stop: () => Promise<void> };

/**
 * Xvfb's arguments: a free display reported on fd 3, the screen at 24-bit depth and 96 dpi,
 * black root, no cursor, the framebuffer kept as an XWD file in `fbdir` (the capture path).
 */
export function xvfbArgs({
  width,
  height,
  fbdir,
}: {
  width: number;
  height: number;
  fbdir: string;
}) {
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
 */
export async function startXvfb({
  width,
  height,
  bin = findXvfb(),
  timeoutMs = 10_000,
  signal,
  env = process.env,
}: {
  width: number;
  height: number;
  bin?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<Display> {
  if (!bin || !existsSync(bin))
    throw new Error(`Xvfb not found (${bin ?? "not on PATH"}); ${XVFB_PACKAGES}`);
  signal?.throwIfAborted();
  const fbdir = mkdtempSync(join(tmpdir(), "vimma-e2e-xvfb-"));
  let child: ChildProcess;
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
  const fd3 = child.stdio[3] as Readable;
  let stopping: Promise<void> | null = null;
  const stop = () =>
    (stopping ??= (async () => {
      await killTree(child, { graceMs: 2000 });
      rmSync(fbdir, { recursive: true, force: true });
    })());
  try {
    const display = await new Promise<string>((resolve, reject) => {
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
 */
function readWithMode(path: string): { mode: number; text: string } {
  const fd = openSync(path, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Issue #901: the browser's stderr since its spawn, each line stamped with the time its first
 * byte arrived, kept in a bounded buffer (the last `maxLines` lines, each cut to `maxChars`).
 * A launch that fails prints `format()`, so a stalled startup phase shows as a gap between two
 * lines (Firefox writes `Failed to create DBus proxy for org.a11y.Bus` from its first window).
 * Nothing is printed for a launch that succeeds.
 */
export function stderrTimeline({
  now = () => performance.now(),
  maxLines = STDERR_TIMELINE_LINES,
  maxChars = STDERR_TIMELINE_CHARS,
}: { now?: () => number; maxLines?: number; maxChars?: number } = {}) {
  const spawnedAt = now();
  const wallClock = new Date().toISOString();
  const lines: Array<{ ms: number; text: string }> = [];
  let partial: { ms: number; text: string } | null = null;
  let dropped = 0;
  const cut = (text: string) => (text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
  const add = (line: { ms: number; text: string }) => {
    lines.push({ ms: line.ms, text: cut(line.text.replace(/\r$/, "")) });
    if (lines.length > maxLines) {
      lines.shift();
      dropped++;
    }
  };
  const secs = (ms: number) => (ms / 1000).toFixed(3);
  return {
    push(chunk: string | Buffer) {
      const ms = now() - spawnedAt;
      const parts = String(chunk).split("\n");
      const rest = parts.pop() as string;
      for (const part of parts) {
        add(partial ? { ms: partial.ms, text: partial.text + part } : { ms, text: part });
        partial = null;
      }
      // An unfinished line keeps its first byte's time; it is cut here so it cannot grow.
      if (rest) {
        partial = partial
          ? { ms: partial.ms, text: (partial.text + rest).slice(0, maxChars + 1) }
          : { ms, text: rest.slice(0, maxChars + 1) };
      }
    },
    format(): string {
      const elapsed = now() - spawnedAt;
      const all = partial ? [...lines, { ms: partial.ms, text: cut(partial.text) }] : lines;
      const last = all.at(-1);
      if (!last) {
        return `browser stderr: nothing in the ${secs(elapsed)} s since spawn (spawned at ${wallClock})`;
      }
      const head =
        `browser stderr with the time since spawn (spawned at ${wallClock}` +
        `${dropped ? `; ${dropped} earlier lines dropped` : ""}):`;
      return [
        head,
        ...all.map((l) => `  +${secs(l.ms)} s  ${l.text}`),
        `  (${secs(elapsed)} s since spawn, ${secs(elapsed - last.ms)} s since the last line)`,
      ].join("\n");
    },
  };
}

/**
 * Wait for the control server's discovery file: present, valid protocol v1, mode 0600. After a
 * crash-style kill the dead browser's file is still there: `stalePid` (its pid) makes the wait
 * skip it until the new browser replaces it. A failure ends with `stderrReport` (the timed lines
 * of stderrTimeline) when it is given, else with `stderrTail`.
 */
export async function waitForDiscovery(
  profile: string,
  {
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    intervalMs = 50,
    exited = () => null,
    stderrTail = () => "",
    stderrReport = null,
    stalePid = null,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    exited?: () => { code: number | null; signal: string | null } | null;
    stderrTail?: () => string;
    stderrReport?: (() => string) | null;
    stalePid?: number | null;
  } = {},
): Promise<{ protocol: number; port: number; token: string; pid: number }> {
  const path = join(profile, DISCOVERY_FILE);
  const deadline = Date.now() + timeoutMs;
  const tail = () => {
    if (stderrReport) return `\n${stderrReport()}`;
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
    let file: { mode: number; text: string } | null = null;
    try {
      file = readWithMode(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        problem = `it cannot be read yet: ${(e as Error).message}`;
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
        problem = `it cannot be read yet: ${(e as Error).message}`; // mid-rename
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

function groupAlive(pgid: number) {
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
 */
export async function killTree(child: ChildProcess, { graceMs = 5000 }: { graceMs?: number } = {}) {
  const pid = child.pid;
  if (!pid) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
    else child.once("exit", () => resolve(undefined));
  });
  const signal = (signal: NodeJS.Signals) => {
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
 * @returns the killed pid (the stale discovery file names it)
 */
export async function crashBrowser(
  child: ChildProcess,
  { reapMs = 5000 }: { reapMs?: number } = {},
): Promise<number> {
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
 */
export async function waitForSessionSaved(
  profile: string,
  {
    quietMs = 3000,
    timeoutMs = 30_000,
    pollMs = 100,
  }: { quietMs?: number; timeoutMs?: number; pollMs?: number } = {},
) {
  const path = join(profile, RECOVERY_FILE);
  const started = Date.now();
  const deadline = started + timeoutMs;
  let mtime: number | null = null;
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
 * @returns whether the browser exited
 */
export async function quitBrowser({
  ctl,
  child,
  timeoutMs = 10_000,
  pollMs = 50,
}: {
  ctl: { state: () => Promise<Record<string, any>>; sendKeys: (keys: string) => Promise<void> };
  child: {
    exitCode: number | null;
    signalCode: string | null;
    once: (event: "exit", f: () => void) => unknown;
  };
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return true;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
    return (await Promise.race([attempt().catch(() => false), timeout])) as boolean;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A private D-Bus session bus for one browser, so the D-Bus remote that a second `vimma` (the
 * `external` step's vimma-open) forwards its command line over reaches the browser under test,
 * never the developer's own Vimma.
 */
export type Bus = { address: string; stop: () => Promise<void> };

/**
 * A session bus configuration with no service directories, so nothing is activated on it (a
 * portal or the accessibility bus would otherwise start under the harness).
 */
export function sessionBusConfig(socket: string) {
  return `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socket}</listen>
  <auth>EXTERNAL</auth>
  <!-- dbus's own session.conf policy; without its eavesdrop lines the remote's call is not
       delivered. The socket sits in the profile's 0700 folder. -->
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;
}

/** Starts dbus-daemon on a socket in `dir` and waits for the address it prints. */
export async function startSessionBus(
  dir: string,
  { bin = "dbus-daemon", timeoutMs = 10_000 }: { bin?: string; timeoutMs?: number } = {},
): Promise<Bus> {
  const config = join(dir, ".e2e-bus.conf");
  writeFileSync(config, sessionBusConfig(join(dir, ".e2e-bus")));
  const child = spawn(
    bin,
    [`--config-file=${config}`, "--nofork", "--nopidfile", "--print-address=1"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  let out = "";
  let err = "";
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dbus-daemon gave no address: ${err}`)),
        timeoutMs,
      );
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`cannot start ${bin} (package dbus): ${e.message}`));
      });
      child.stderr?.on("data", (d) => (err += d));
      child.stdout?.on("data", (d) => {
        out += d;
        const end = out.indexOf("\n");
        if (end > 0) {
          clearTimeout(timer);
          resolve(out.slice(0, end).trim());
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`dbus-daemon exited (${code}): ${err}`));
      });
    });
    return {
      address: address as string,
      stop: () => killTree(child, { graceMs: 1000 }),
    };
  } catch (e) {
    await killTree(child, { graceMs: 1000 });
    throw e;
  }
}

/**
 * The `vimma` an `external` step's vimma-open runs (VIMMA_BIN): the build on the profile under
 * test, so the forwarded command line reaches that browser.
 */
export function externalWrapper(binary: string, profile: string) {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\nexec ${q(binary)} -profile ${q(profile)} "$@"\n`;
}

/** The launcher the packages install as `vimma-open`. */
export const VIMMA_OPEN = join(REPO, "tools/package/vimma-open.sh");

/**
 * Runs vimma-open with `args` in `env`, as another program does; it hands the link off and
 * returns at once, so a non-zero exit or a hang is a failure.
 */
export function runVimmaOpen(
  args: readonly string[],
  {
    env,
    timeoutMs = 10_000,
    signal,
  }: { env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [VIMMA_OPEN, ...args], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
    let err = "";
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code, sig) =>
      code === 0
        ? resolve()
        : reject(new Error(`vimma-open ended with ${code ?? sig}: ${err.trim()}`)),
    );
  });
}

export type Session = {
  profile: string;
  child: ChildProcess;
  display: Display | null;
  env: () => Record<string, string>;
  discovery: { protocol: number; port: number; token: string; pid: number };
  stderrTail: () => string;
  loadFailure: () => string | null;
  relaunch: (options?: { stalePid?: number }) => Promise<void>;
  teardown: () => Promise<void>;
};

/**
 * Launch a build and wait for its control socket. On any failure everything started so far is
 * torn down before the error is thrown. `teardown` is handed out (onTeardown) before anything
 * slow starts and is idempotent; calling it, or aborting `signal`, at any point (Xvfb still
 * starting, the discovery wait) stops the Xvfb, kills the browser and removes the profile.
 * `relaunch` starts the browser again on the same profile and display once it has exited (a
 * restart: the caller quits it first and checks the discovery file is gone, or after
 * crashBrowser passes the killed pid as `stalePid`, whose discovery file stays); `child` and
 * `discovery` then describe the new one. `headless` runs the browser with MOZ_HEADLESS=1 and
 * no display (macOS, displayMode); `display` is then null.
 * `programs` (name to file) are copied into a 0700 folder in the profile, each 0700 under its
 * name, and the browser's PATH is that folder then `programPath` (the system folders, where a
 * fake CLI finds python3): the agent CLI's setup lists what it finds on PATH, which must not
 * include a CLI the caller installed, and C4 of docs/specs/builtin-agent-cli.md runs only a CLI
 * others cannot write. A browser that does not
 * get the caller's XDG_RUNTIME_DIR (our Xvfb, headless) gets a private 0700 one made under
 * `runtimeRoot` (the caller's XDG_RUNTIME_DIR, else ~/.cache), removed on teardown: the agent
 * CLI's run folder (C6) refuses one with an ancestor others can write, such as the profile's
 * /tmp. `fontconfig` is the fontconfig file the browser reads instead of the system's
 * (scenarioFontconfig), and with it GTK gets GTK_SETTINGS; null leaves the system's.
 * @param options `onProfile` changes the new profile before the browser first starts on it (the
 *   update scenarios trust their host's CA in it)
 */
export async function launch({
  build,
  headless = false,
  xvfb = !headless && !process.env.DISPLAY,
  xvfbBin = findXvfb(),
  xvfbEnv = process.env,
  window = WINDOW,
  tmpRoot = tmpdir(),
  programs = {},
  programPath = ["/usr/bin", "/bin"],
  runtimeRoot,
  prefs = {},
  fontconfig = null,
  keep = false,
  sessionBus = false,
  args = [],
  discoveryTimeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  graceMs = 5000,
  baseEnv = process.env,
  signal,
  onSpawn = () => {},
  onTeardown = () => {},
  onProfile = () => {},
  log = () => {},
}: {
  build: Build;
  headless?: boolean;
  xvfb?: boolean;
  xvfbBin?: string | null;
  xvfbEnv?: Record<string, string | undefined>;
  window?: { width: number; height: number };
  tmpRoot?: string;
  programs?: Record<string, string>;
  programPath?: readonly string[];
  runtimeRoot?: string;
  prefs?: Record<string, boolean | number | string | null>;
  fontconfig?: string | null;
  keep?: boolean;
  sessionBus?: boolean;
  args?: readonly string[];
  discoveryTimeoutMs?: number;
  graceMs?: number;
  baseEnv?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onSpawn?: (child: ChildProcess) => void;
  onTeardown?: (teardown: () => Promise<void>) => void;
  onProfile?: (profile: string) => void;
  log?: (line: string) => void;
}): Promise<Session> {
  let display: Display | null = null;
  let displayStarting: Promise<Display> | null = null;
  let child: ChildProcess | null = null;
  let bus: Bus | null = null;
  /** The browser's environment at its last start, for programs that talk to it. */
  let lastEnv: Record<string, string> = {};
  const cancel = new AbortController();
  // The sandbox resolves symlinks before it compares paths, hence the real path.
  const profile = createProfile(tmpRoot, prefs, {
    readPaths: fontconfig ? [`${realpathSync(dirname(fontconfig))}/`] : [],
  });
  const home = join(profile, ".e2e-home");
  const tmp = join(profile, ".e2e-tmp");
  mkdirSync(home);
  if (fontconfig) {
    mkdirSync(join(home, ".config", "gtk-3.0"), { recursive: true });
    writeFileSync(join(home, ".config", "gtk-3.0", "settings.ini"), GTK_SETTINGS);
  }
  mkdirSync(tmp);
  const bin = Object.keys(programs).length ? join(profile, ".e2e-bin") : null;
  if (bin) {
    mkdirSync(bin);
    chmodSync(bin, 0o700);
    for (const [name, file] of Object.entries(programs)) {
      copyFileSync(file, join(bin, name));
      chmodSync(join(bin, name), 0o700);
    }
  }
  let runDir: string | null = null;
  let stderr = "";
  let loadFailure: string | null = null;
  let tearingDown: Promise<void> | null = null;
  const teardown = () =>
    (tearingDown ??= (async () => {
      cancel.abort();
      if (child) await killTree(child, { graceMs });
      // Xvfb may still be starting: wait for that to settle (the abort makes it quick), then
      // stop whatever it started. startXvfb removes its fbdir itself when it fails.
      const started = await displayStarting?.catch(() => null);
      if (started) await started.stop();
      if (bus) await bus.stop();
      if (keep) log(`kept profile ${profile}${runDir ? ` and run folder ${runDir}` : ""}`);
      else {
        rmSync(profile, { recursive: true, force: true });
        if (runDir) rmSync(runDir, { recursive: true, force: true });
      }
    })());
  onTeardown(teardown);
  const cancelled = () =>
    tearingDown ? new Error("launch aborted (cancelled or timed out)") : null;
  const stderrTail = () => stderr.split("\n").slice(-15).join("\n");

  /** Spawn the browser on the profile (with `url` on the command line) and wait for its socket. */
  const start = async (url: string | null, stalePid: number | null = null) => {
    const env = browserEnv(baseEnv, {
      display: display?.display,
      headless,
      home,
      tmp,
      fontconfig,
      extra: build.env,
    });
    if (bin) env.PATH = [bin, ...programPath].join(delimiter);
    if (!env.XDG_RUNTIME_DIR) {
      if (!runDir) {
        const callers = baseEnv.XDG_RUNTIME_DIR;
        const root =
          runtimeRoot ?? (callers && isAbsolute(callers) ? callers : join(homedir(), ".cache"));
        mkdirSync(root, { recursive: true, mode: 0o700 });
        runDir = mkdtempSync(join(root, "vimma-e2e-run-"));
        chmodSync(runDir, 0o700);
      }
      env.XDG_RUNTIME_DIR = runDir;
    }
    if (bus) env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    lastEnv = env;
    const spawned = spawn(build.binary, browserArgs(profile, window, { url, extra: args }), {
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child = spawned;
    onSpawn(spawned);
    let exit: { code: number | null; signal: string | null } | null = null;
    let spawnError: Error | null = null;
    spawned.on("exit", (code, sig) => (exit = { code, signal: sig }));
    spawned.on("error", (e) => (spawnError = e));
    const timeline = stderrTimeline();
    // Decoded as a stream, so a character split across two chunks stays whole.
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (d) => {
      timeline.push(d);
      stderr = (stderr + d).slice(-8000);
      loadFailure ??= VIMMA_LOAD_FAILURE.exec(stderr)?.[0] ?? null;
    });
    const discovery = await waitForDiscovery(profile, {
      timeoutMs: discoveryTimeoutMs,
      exited: () => {
        const stopped = cancelled();
        if (stopped) throw stopped;
        if (spawnError)
          throw new Error(`cannot start ${build.binary}: ${(spawnError as Error).message}`);
        return exit;
      },
      stderrReport: timeline.format,
      stalePid,
    });
    return { spawned, discovery };
  };

  const onAbort = () => void teardown();
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    onProfile(profile);
    if (xvfb && !tearingDown) {
      displayStarting = startXvfb({ ...window, bin: xvfbBin, signal: cancel.signal, env: xvfbEnv });
      display = await displayStarting;
    }
    if (sessionBus && !tearingDown) bus = await startSessionBus(profile);
    const stop = cancelled();
    if (stop) throw stop;
    const first = await start("about:blank");
    signal?.removeEventListener("abort", onAbort);
    const session: Session = {
      profile,
      child: first.spawned,
      display,
      env: () => ({ ...lastEnv }),
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
