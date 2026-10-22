import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROFILE_PREFS,
  browserArgs,
  browserEnv,
  createProfile,
  crashBrowser,
  findBuild,
  launch,
  quitBrowser,
  userJs,
  waitForDiscovery,
  waitForSessionSaved,
  xvfbArgs,
} from "../launcher.mjs";
import { devPrefs } from "../../start.mjs";
import { startFakeServer } from "./fake-server.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
const FAKE_XVFB = fileURLToPath(new URL("./fixtures/fake-xvfb.mjs", import.meta.url));
const E2E_CLI = fileURLToPath(new URL("../e2e.mjs", import.meta.url));

/** @type {string[]} */
const dirs = [];
/** @type {Array<() => Promise<void>>} */
const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "vimma-e2e-test-"));
  dirs.push(d);
  return d;
};

/** @param {number} pid @returns {string} ps's state letters, "" once the pid is gone */
const psState = (pid) => {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch (err) {
    // ps exits 1 with no output for a pid that does not exist; anything else is a real error.
    if (/** @type {{ status?: number }} */ (err).status === 1) return "";
    throw err;
  }
};

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // An orphan that has exited still answers signal 0 until init reaps it, which launchd on
  // macOS may do only after the process group already looks empty.
  const state = psState(pid);
  return state !== "" && !state.startsWith("Z");
};

describe("alive", () => {
  it("counts an exited process that no one has reaped yet (a zombie) as gone", async () => {
    // The exec'd sleep never waits for the backgrounded one, which stays a zombie for 5 s.
    const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 5"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    cleanups.push(async () => void parent.kill("SIGKILL"));
    const zombie = Number(
      await new Promise((resolve) => parent.stdout.once("data", (d) => resolve(String(d).trim()))),
    );
    for (let i = 0; i < 200 && !psState(zombie).startsWith("Z"); i++) await sleep(25);
    expect(psState(zombie)).toMatch(/^Z/);
    expect(() => process.kill(zombie, 0)).not.toThrow();
    expect(alive(zombie)).toBe(false);
    expect(alive(/** @type {number} */ (parent.pid))).toBe(true);
  });
});

describe("findBuild", () => {
  const engine = "/repo/engine/";
  const full = "/repo/engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma";
  const art = "/repo/engine/obj-artifact/dist/bin/vimma";
  const artIni = "/repo/engine/obj-artifact/dist/bin/browser/application.ini";
  /** @param {string[]} present */
  const exists = (present) => (/** @type {string} */ p) => present.includes(p);

  it("prefers an explicit --build binary, or the vimma inside a dist/bin directory", () => {
    expect(findBuild({ build: "/x/vimma", engine, exists: exists(["/x/vimma"]) })).toEqual({
      binary: "/x/vimma",
      env: {},
    });
    expect(findBuild({ build: "/x/bin", engine, exists: exists(["/x/bin/vimma"]) })).toEqual({
      binary: "/x/bin/vimma",
      env: {},
    });
  });

  it("uses the artifact objdir with XUL_APP_FILE, as tools/mochitest.mjs does", () => {
    expect(findBuild({ artifact: true, engine, exists: exists([art, artIni]) })).toEqual({
      binary: art,
      env: { XUL_APP_FILE: artIni },
    });
  });

  it("falls back to VIMMA_E2E_BUILD, then the full objdir, then the artifact objdir", () => {
    expect(
      findBuild({ engine, env: { VIMMA_E2E_BUILD: "/e/vimma" }, exists: exists(["/e/vimma"]) }),
    ).toEqual({ binary: "/e/vimma", env: {} });
    expect(findBuild({ engine, exists: exists([full, art, artIni]) }).binary).toBe(full);
    expect(findBuild({ engine, exists: exists([art, artIni]) })).toEqual({
      binary: art,
      env: { XUL_APP_FILE: artIni },
    });
  });

  it("names every path it tried when there is no build", () => {
    expect(() => findBuild({ engine, exists: exists([]) })).toThrow(
      new RegExp(`no Vimma build found[^]*${full}[^]*${art}`),
    );
    expect(() => findBuild({ build: "/nope", engine, exists: exists([]) })).toThrow(/\/nope/);
  });
});

describe("profile", () => {
  it("turns the control socket on and first run, telemetry and updates off", () => {
    const prefs = Object.fromEntries(PROFILE_PREFS);
    expect(prefs["vimma.control.enabled"]).toBe(true);
    // The first-run setup tab would add a tab every scenario counts (first-run-setup decision 1).
    expect(prefs["vimma.setup.offered"]).toBe(true);
    expect(prefs["browser.shell.checkDefaultBrowser"]).toBe(false);
    expect(prefs["browser.startup.homepage_override.mstone"]).toBe("ignore");
    expect(prefs["datareporting.policy.dataSubmissionEnabled"]).toBe(false);
    expect(prefs["toolkit.telemetry.enabled"]).toBe(false);
    expect(prefs["app.update.disabledForTesting"]).toBe(true);
    expect(prefs["browser.sessionstore.resume_from_crash"]).toBe(false);
    // ctrl+q quits without a dialog, so teardown can quit cleanly (spec m0-control-server)
    expect(prefs["browser.warnOnQuitShortcut"]).toBe(false);
    // no first-run config.toml, and so no "created …" notice in the first screenshot
    expect(prefs["vimma.config.firstRunDone"]).toBe(true);
  });

  it("writes user.js lines that Firefox's pref parser reads", () => {
    expect(
      userJs([
        ["a.b", true],
        ["c", 3],
        ["d", 'say "hi"\\'],
      ]),
    ).toBe('user_pref("a.b", true);\nuser_pref("c", 3);\nuser_pref("d", "say \\"hi\\"\\\\");\n');
  });

  it("lets a scenario override a pref, or drop it (null) to keep the build's default", () => {
    const dir = createProfile(tempDir(), { "browser.startup.page": null, "x.y": 2 });
    const js = readFileSync(join(dir, "user.js"), "utf8");
    expect(js).not.toContain('"browser.startup.page"');
    expect(js).toContain('user_pref("x.y", 2);');
    expect(js).toContain('user_pref("vimma.control.enabled", true);');
    const plain = readFileSync(join(createProfile(tempDir()), "user.js"), "utf8");
    expect(plain).toContain('user_pref("browser.startup.page", 0);');
  });

  it("creates a private temp profile holding user.js", () => {
    const dir = createProfile(tempDir());
    expect(readFileSync(join(dir, "user.js"), "utf8")).toContain(
      'user_pref("vimma.control.enabled", true);',
    );
  });

  it("lets content processes read the repo's src/, as npm start's profile does", () => {
    // A local objdir's chrome files are symlinks into src/; without this VimmaChild never loads
    // in the default content sandbox (m0-content-actor checks it against a real build).
    const js = readFileSync(join(createProfile(tempDir()), "user.js"), "utf8");
    const [[name, value]] = devPrefs(REPO_ROOT);
    expect(js).toContain(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  });
});

describe("browser command line and environment", () => {
  it("passes the profile, no-remote and a fixed window at the origin", () => {
    expect(browserArgs("/p", { width: 1280, height: 800 })).toEqual([
      "-no-remote",
      "-profile",
      "/p",
      "-width",
      "1280",
      "-height",
      "800",
      "-left",
      "0",
      "-top",
      "0",
      "about:blank",
    ]);
  });

  it("opens no URL on a restart, which would add a tab to the restored session", () => {
    const args = browserArgs("/p", { width: 1280, height: 800 }, { url: null });
    expect(args).not.toContain("about:blank");
    expect(args.slice(0, 3)).toEqual(["-no-remote", "-profile", "/p"]);
  });

  it("puts extra switches before the URL (the site suite's --start-debugger-server)", () => {
    const args = browserArgs(
      "/p",
      { width: 1280, height: 800 },
      { extra: ["--start-debugger-server", "/p/rdp.sock"] },
    );
    expect(args.slice(-3)).toEqual(["--start-debugger-server", "/p/rdp.sock", "about:blank"]);
  });

  it("points the browser at our Xvfb and away from Wayland", () => {
    const env = browserEnv(
      { PATH: "/bin", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" },
      { display: ":99", extra: { XUL_APP_FILE: "/a.ini" } },
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      DISPLAY: ":99",
      GDK_BACKEND: "x11",
      MOZ_ENABLE_WAYLAND: "0",
      XUL_APP_FILE: "/a.ini",
      MOZ_CRASHREPORTER_DISABLE: "1",
    });
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
  });

  it("keeps the caller's display when it does not start Xvfb", () => {
    const env = browserEnv({ DISPLAY: ":0", WAYLAND_DISPLAY: "w" }, {});
    expect(env.DISPLAY).toBe(":0");
    expect(env.WAYLAND_DISPLAY).toBe("w");
  });

  // GDK_SCALE=2 on a developer's desktop gave a 2× crop. Local runs must render as CI.
  const desktop = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    USER: "dev",
    LANG: "fi_FI.UTF-8",
    LC_ALL: "fi_FI.UTF-8",
    TZ: "Europe/Helsinki",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-1",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XAUTHORITY: "/run/user/1000/xauth",
    XDG_CONFIG_HOME: "/home/dev/.config",
    XDG_DATA_HOME: "/home/dev/.local/share",
    GDK_SCALE: "2",
    GDK_DPI_SCALE: "1.5",
    GDK_BACKEND: "wayland",
    QT_SCALE_FACTOR: "2",
    QT_AUTO_SCREEN_SCALE_FACTOR: "1",
    QT_SCREEN_SCALE_FACTORS: "2",
    GTK_THEME: "Adwaita:dark",
    MOZ_ENABLE_WAYLAND: "1",
    MOZ_USE_XINPUT2: "1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    RANDOM_THING: "x",
  };

  it("under Xvfb, builds a minimal env: no scaling, theme, locale or home of the desktop", () => {
    expect(
      browserEnv(desktop, { display: ":99", home: "/p/.e2e-home", tmp: "/p/.e2e-tmp" }),
    ).toEqual({
      PATH: "/usr/bin",
      USER: "dev",
      HOME: "/p/.e2e-home",
      TMPDIR: "/p/.e2e-tmp",
      LANG: "C.UTF-8",
      TZ: "UTC",
      DISPLAY: ":99",
      GDK_BACKEND: "x11",
      MOZ_ENABLE_WAYLAND: "0",
      GTK_THEME: "Adwaita",
      MOZ_CRASHREPORTER_DISABLE: "1",
    });
  });

  it("on the caller's display, keeps only what reaching that display needs", () => {
    expect(browserEnv(desktop, { home: "/h", tmp: "/t" })).toEqual({
      PATH: "/usr/bin",
      USER: "dev",
      HOME: "/h",
      TMPDIR: "/t",
      LANG: "C.UTF-8",
      TZ: "UTC",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XAUTHORITY: "/run/user/1000/xauth",
      GTK_THEME: "Adwaita",
      MOZ_CRASHREPORTER_DISABLE: "1",
    });
  });

  it("passes debugging switches through, and the build's own variables", () => {
    const env = browserEnv(
      { PATH: "/b", MOZ_HEADLESS: "1", MOZ_LOG: "x:5", GDK_SCALE: "2" },
      { display: ":9", home: "/h", tmp: "/t", extra: { XUL_APP_FILE: "/a.ini" } },
    );
    expect(env).toMatchObject({ MOZ_HEADLESS: "1", MOZ_LOG: "x:5", XUL_APP_FILE: "/a.ini" });
    expect(env.GDK_SCALE).toBeUndefined();
  });

  it("pins one device pixel per CSS pixel and a light theme in the profile", () => {
    const prefs = Object.fromEntries(PROFILE_PREFS);
    expect(prefs["layout.css.devPixelsPerPx"]).toBe("1.0");
    expect(prefs["ui.systemUsesDarkTheme"]).toBe(0);
  });

  it("starts Xvfb at 96 dpi with no cursor", () => {
    const args = xvfbArgs({ width: 1280, height: 800, fbdir: "/fb" });
    expect(args).toEqual(expect.arrayContaining(["-nocursor", "-br", "-noreset"]));
    expect(args.join(" ")).toContain("-screen 0 1280x800x24");
    expect(args.join(" ")).toContain("-dpi 96");
    expect(args.join(" ")).toContain("-fbdir /fb");
    expect(args.join(" ")).toContain("-displayfd 3");
  });
});

describe("waitForDiscovery", () => {
  it("returns the discovery file once the server writes it", async () => {
    const profile = tempDir();
    /** @type {import("./fake-server.mjs").FakeServer | undefined} */
    let fake;
    setTimeout(async () => {
      fake = await startFakeServer(profile);
    }, 300);
    const discovery = await waitForDiscovery(profile, { timeoutMs: 5000 });
    expect(discovery.port).toBe(fake?.port);
    expect(discovery.token).toBe(fake?.token);
    await fake?.close();
  });

  it("times out naming the pref, the file and the browser's stderr", async () => {
    const profile = tempDir();
    const started = Date.now();
    await expect(
      waitForDiscovery(profile, { timeoutMs: 400, stderrTail: () => "GLib warning: foo" }),
    ).rejects.toThrow(/400 ms[^]*vimma\.control\.enabled[^]*vimma-control\.json[^]*GLib warning/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not accept a discovery file others can read until it is 0600", async () => {
    const profile = tempDir();
    const fake = await startFakeServer(profile, { discoveryMode: 0o644 });
    cleanups.push(() => fake.close());
    chmodSync(fake.discoveryPath, 0o644);
    await expect(waitForDiscovery(profile, { timeoutMs: 400 })).rejects.toThrow(/mode 644/);
    setTimeout(() => chmodSync(fake.discoveryPath, 0o600), 200);
    await expect(waitForDiscovery(profile, { timeoutMs: 3000 })).resolves.toMatchObject({
      port: fake.port,
    });
  });

  it("reports an invalid discovery file instead of a bare timeout", async () => {
    const profile = tempDir();
    writeFileSync(join(profile, "vimma-control.json"), '{"protocol":1}', { mode: 0o600 });
    await expect(waitForDiscovery(profile, { timeoutMs: 300 })).rejects.toThrow(/port/);
  });

  it("skips the discovery file a killed browser left behind (stalePid)", async () => {
    const profile = tempDir();
    const fake = await startFakeServer(profile);
    cleanups.push(() => fake.close());
    const { pid } = JSON.parse(readFileSync(fake.discoveryPath, "utf8"));
    await expect(waitForDiscovery(profile, { timeoutMs: 300, stalePid: pid })).rejects.toThrow(
      new RegExp(`left by the killed browser \\(pid ${pid}\\)`),
    );
    await expect(
      waitForDiscovery(profile, { timeoutMs: 300, stalePid: pid + 1 }),
    ).resolves.toMatchObject({ pid });
  });

  it("fails at once when the browser exits before the socket is up", async () => {
    const profile = tempDir();
    const started = Date.now();
    await expect(
      waitForDiscovery(profile, {
        timeoutMs: 10_000,
        exited: () => ({ code: 7, signal: null }),
        stderrTail: () => "crashed on purpose",
      }),
    ).rejects.toThrow(/exited with code 7[^]*crashed on purpose/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("launch and teardown (fake browser)", () => {
  /** @param {Record<string, string>} env @param {object} [opts] */
  const start = (env, opts = {}) =>
    launch({
      build: { binary: FAKE_BROWSER, env },
      xvfb: false,
      tmpRoot: tempDir(),
      discoveryTimeoutMs: 5000,
      graceMs: 500,
      ...opts,
    });

  it("reports a front-end module the browser failed to load (the sandbox regression)", async () => {
    const line =
      "JavaScript error: , line 0: Error: Failed to load " +
      "chrome://browser/content/vimma/actors/VimmaChild.sys.mjs";
    const bad = await start({ FAKE_BROWSER_STDERR: line });
    cleanups.push(() => bad.teardown());
    await sleep(200);
    expect(bad.loadFailure()).toBe(
      "Failed to load chrome://browser/content/vimma/actors/VimmaChild.sys.mjs",
    );
    const good = await start({});
    cleanups.push(() => good.teardown());
    expect(good.loadFailure()).toBeNull();
  });

  it("starts the browser with the profile and waits for its control socket", async () => {
    const session = await start({ FAKE_BROWSER_DELAY_MS: "200" });
    cleanups.push(() => session.teardown());
    expect(session.discovery.pid).toBeGreaterThan(0);
    const seen = JSON.parse(readFileSync(join(session.profile, "fake-browser.json"), "utf8"));
    expect(seen.argv).toContain(session.profile);
    expect(seen.argv).toContain("-no-remote");
  });

  it("the spawned browser sees the scrubbed env, with HOME and TMPDIR inside the profile", async () => {
    const session = await start(
      {},
      { baseEnv: { ...process.env, GDK_SCALE: "2", MOZ_ENABLE_WAYLAND: "1" } },
    );
    cleanups.push(() => session.teardown());
    const seen = JSON.parse(readFileSync(join(session.profile, "fake-browser.json"), "utf8"));
    expect(seen.env.GDK_SCALE).toBeUndefined();
    expect(seen.env.MOZ_ENABLE_WAYLAND).toBeUndefined();
    expect(seen.home).toBe(join(session.profile, ".e2e-home"));
    expect(seen.tmp).toBe(join(session.profile, ".e2e-tmp"));
  });

  it("kills the whole process tree and removes the profile on teardown", async () => {
    const session = await start({ FAKE_BROWSER_CHILD: "1" });
    const grandchild = Number(readFileSync(join(session.profile, "grandchild.pid"), "utf8"));
    const pid = /** @type {number} */ (session.child.pid);
    expect(alive(pid) && alive(grandchild)).toBe(true);
    await session.teardown();
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(existsSync(session.profile)).toBe(false);
  });

  it("relaunches in the same profile once the browser has exited (a restart)", async () => {
    const session = await start({ FAKE_BROWSER_DELAY_MS: "100" });
    cleanups.push(() => session.teardown());
    const first = /** @type {number} */ (session.child.pid);
    await expect(session.relaunch()).rejects.toThrow(/still running/);
    const exited = new Promise((resolve) => session.child.once("exit", resolve));
    process.kill(first, "SIGTERM");
    await exited;
    rmSync(join(session.profile, "vimma-control.json"), { force: true });
    writeFileSync(join(session.profile, "kept.txt"), "x");
    await session.relaunch();
    const second = /** @type {number} */ (session.child.pid);
    expect(second).not.toBe(first);
    expect(session.discovery.pid).toBe(second);
    expect(existsSync(join(session.profile, "kept.txt"))).toBe(true);
    const seen = JSON.parse(readFileSync(join(session.profile, "fake-browser.json"), "utf8"));
    expect(seen.argv).toContain(session.profile);
    expect(seen.argv).not.toContain("about:blank"); // like a user's restart: the session only
    await session.teardown();
    expect(alive(second)).toBe(false);
    expect(existsSync(session.profile)).toBe(false);
  });

  it("crashBrowser SIGKILLs the browser alone, reaps its children, keeps its files", async () => {
    const session = await start({ FAKE_BROWSER_CHILD: "1", FAKE_BROWSER_IGNORE_TERM: "1" });
    cleanups.push(() => session.teardown());
    const pid = /** @type {number} */ (session.child.pid);
    const grandchild = Number(readFileSync(join(session.profile, "grandchild.pid"), "utf8"));
    const killed = await crashBrowser(session.child, { reapMs: 300 });
    expect(killed).toBe(pid);
    expect(session.child.signalCode).toBe("SIGKILL");
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false); // a content process would follow its parent
    // No quit observers ran: the discovery file stays, as after a real crash.
    expect(existsSync(join(session.profile, "vimma-control.json"))).toBe(true);
    await session.relaunch({ stalePid: pid });
    expect(session.discovery.pid).toBe(session.child.pid);
    expect(session.discovery.pid).not.toBe(pid);
  });

  it("escalates to SIGKILL when the browser ignores SIGTERM", async () => {
    const session = await start({ FAKE_BROWSER_IGNORE_TERM: "1" });
    const pid = /** @type {number} */ (session.child.pid);
    await session.teardown();
    expect(alive(pid)).toBe(false);
  });

  it("keeps the profile with keep", async () => {
    const session = await start({}, { keep: true });
    await session.teardown();
    expect(existsSync(join(session.profile, "user.js"))).toBe(true);
    dirs.push(session.profile);
  });

  it("cleans up when the launch fails: browser exits early", async () => {
    const tmpRoot = tempDir();
    await expect(
      launch({
        build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "exit" } },
        xvfb: false,
        tmpRoot,
        discoveryTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited with code 7[^]*crashed on purpose/);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("hands out teardown before waiting, so a signal mid-launch cleans up (manual check bug)", async () => {
    const tmpRoot = tempDir();
    /** @type {Array<() => Promise<void>>} */
    const registered = [];
    /** @type {number[]} */
    const pids = [];
    const launching = launch({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never" } },
      xvfb: false,
      tmpRoot,
      discoveryTimeoutMs: 20_000,
      graceMs: 300,
      onTeardown: (/** @type {() => Promise<void>} */ t) => registered.push(t),
      onSpawn: (/** @type {import("node:child_process").ChildProcess} */ child) =>
        pids.push(/** @type {number} */ (child.pid)),
    });
    const outcome = launching.catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    expect(registered).toHaveLength(1);
    const started = Date.now();
    await Promise.all([registered[0]?.(), registered[0]?.()]); // idempotent
    expect(await outcome).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(/** @type {number} */ (pids[0]))).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("cleans up when the launch fails: no control socket, process tree killed", async () => {
    const tmpRoot = tempDir();
    /** @type {number[]} */
    const pids = [];
    await expect(
      launch({
        build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never", FAKE_BROWSER_CHILD: "1" } },
        xvfb: false,
        tmpRoot,
        discoveryTimeoutMs: 500,
        graceMs: 300,
        onSpawn: (/** @type {import("node:child_process").ChildProcess} */ child) =>
          pids.push(/** @type {number} */ (child.pid)),
      }),
    ).rejects.toThrow(/vimma\.control\.enabled/);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(pids).toHaveLength(1);
    expect(alive(/** @type {number} */ (pids[0]))).toBe(false);
  });
});

// Ctrl+C while Xvfb was still starting must leave no live Xvfb and no fbdir.
describe("cancelling while Xvfb starts (fake Xvfb)", () => {
  /** @param {string} record */
  const readRecord = (record) =>
    /** @type {{ pid: number, fbdir: string }} */ (JSON.parse(readFileSync(record, "utf8")));

  it("teardown during Xvfb startup stops Xvfb and removes its fbdir", async () => {
    const tmpRoot = tempDir();
    const record = join(tempDir(), "xvfb.json");
    /** @type {Array<() => Promise<void>>} */
    const registered = [];
    const launching = launch({
      build: { binary: FAKE_BROWSER, env: {} },
      xvfb: true,
      xvfbBin: FAKE_XVFB,
      tmpRoot,
      graceMs: 300,
      xvfbEnv: { ...process.env, FAKE_XVFB_DELAY_MS: "1500", FAKE_XVFB_RECORD: record },
      onTeardown: (/** @type {() => Promise<void>} */ t) => registered.push(t),
    });
    const outcome = launching.catch((e) => e);
    for (let i = 0; i < 100 && !existsSync(record); i++) await sleep(20);
    const { pid, fbdir } = readRecord(record);
    expect(alive(pid) && existsSync(fbdir)).toBe(true);
    await registered[0]?.();
    expect(await outcome).toBeInstanceOf(Error);
    expect(alive(pid)).toBe(false);
    expect(existsSync(fbdir)).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("an abort signal cancels the launch the same way", async () => {
    const record = join(tempDir(), "xvfb.json");
    const controller = new AbortController();
    const launching = launch({
      build: { binary: FAKE_BROWSER, env: {} },
      xvfb: true,
      xvfbBin: FAKE_XVFB,
      tmpRoot: tempDir(),
      graceMs: 300,
      xvfbEnv: { ...process.env, FAKE_XVFB_DELAY_MS: "1500", FAKE_XVFB_RECORD: record },
      signal: controller.signal,
    }).catch((e) => e);
    for (let i = 0; i < 100 && !existsSync(record); i++) await sleep(20);
    const started = Date.now();
    controller.abort();
    expect(await launching).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(3000);
    const { pid, fbdir } = readRecord(record);
    expect(alive(pid)).toBe(false);
    expect(existsSync(fbdir)).toBe(false);
  });

  it("an abort during the discovery wait kills the browser at once", async () => {
    const controller = new AbortController();
    /** @type {number[]} */
    const pids = [];
    const launching = launch({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never" } },
      xvfb: false,
      tmpRoot: tempDir(),
      discoveryTimeoutMs: 60_000,
      graceMs: 300,
      onSpawn: (/** @type {import("node:child_process").ChildProcess} */ c) =>
        pids.push(/** @type {number} */ (c.pid)),
      signal: controller.signal,
    }).catch((e) => e);
    await sleep(300);
    const started = Date.now();
    controller.abort();
    expect(String(await launching)).toMatch(/abort/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(alive(/** @type {number} */ (pids[0]))).toBe(false);
  });

  it("SIGINT to the CLI while Xvfb starts leaves no Xvfb, fbdir or profile", async () => {
    const tmp = tempDir();
    const bin = tempDir();
    symlinkSync(FAKE_XVFB, join(bin, "Xvfb"));
    const scenarios = tempDir();
    writeFileSync(
      join(scenarios, "m0-x.json"),
      JSON.stringify({ name: "m0-x", description: "x", steps: [{ keys: "esc" }] }),
    );
    const record = join(tempDir(), "xvfb.json");
    const cli = spawn(
      process.execPath,
      [
        E2E_CLI,
        "--xvfb",
        "--build",
        FAKE_BROWSER,
        "--vimma-ctl",
        process.execPath,
        "--scenarios",
        scenarios,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: tmp,
          FAKE_XVFB_DELAY_MS: "3000",
          FAKE_XVFB_RECORD: record,
        },
        stdio: "ignore",
      },
    );
    for (let i = 0; i < 200 && !existsSync(record); i++) await sleep(20);
    const { pid, fbdir } = readRecord(record);
    cli.kill("SIGINT");
    const code = await new Promise((r) => cli.on("exit", (c) => r(c)));
    expect(code).toBe(130);
    expect(alive(pid)).toBe(false);
    expect(existsSync(fbdir)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("waitForSessionSaved (before a crash-style kill)", () => {
  /** @param {string} profile */
  const recovery = (profile) => join(profile, "sessionstore-backups", "recovery.jsonlz4");

  it("waits for SessionStore's recovery file to exist and go quiet", async () => {
    const profile = tempDir();
    const started = Date.now();
    setTimeout(() => {
      mkdirSync(join(profile, "sessionstore-backups"));
      writeFileSync(recovery(profile), "1");
    }, 150);
    setTimeout(() => writeFileSync(recovery(profile), "2"), 350);
    await waitForSessionSaved(profile, { quietMs: 300, timeoutMs: 5000, pollMs: 20 });
    // the last write at ~350 ms, then 300 ms of quiet
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(readFileSync(recovery(profile), "utf8")).toBe("2");
  });

  it("counts the quiet from the call, not from an older write", async () => {
    const profile = tempDir();
    mkdirSync(join(profile, "sessionstore-backups"));
    writeFileSync(recovery(profile), "old");
    const started = Date.now();
    await waitForSessionSaved(profile, { quietMs: 250, timeoutMs: 5000, pollMs: 20 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("times out when SessionStore never writes", async () => {
    const profile = tempDir();
    await expect(
      waitForSessionSaved(profile, { quietMs: 100, timeoutMs: 300, pollMs: 20 }),
    ).rejects.toThrow(/recovery\.jsonlz4[^]*300 ms/);
  });
});

describe("quitBrowser (ctrl+q first, so the discovery file is removed)", () => {
  /** A child that exits when told to, like the browser after ctrl+q. */
  const fakeChild = () => {
    /** @type {Array<() => void>} */
    const waiters = [];
    const child = {
      exitCode: /** @type {number | null} */ (null),
      signalCode: null,
      once: (/** @type {string} */ _e, /** @type {() => void} */ f) => void waiters.push(f),
      exit() {
        child.exitCode = 0;
        for (const f of waiters.splice(0)) f();
      },
    };
    return child;
  };
  /**
   * @param {{ mode?: string, quits?: boolean, fail?: boolean }} o
   */
  const fakeCtl = ({ mode = "normal", quits = true, fail = false }, child = fakeChild()) => {
    /** @type {string[]} */
    const sent = [];
    let current = mode;
    const ctl = {
      sent,
      async state() {
        if (fail) throw new Error("not running");
        return { mode: current, pending: null };
      },
      async sendKeys(/** @type {string} */ keys) {
        sent.push(keys);
        if (keys === "esc" && current === "help") current = "normal";
        if (keys === "ctrl+q" && quits) setTimeout(() => child.exit(), 5);
      },
    };
    return { ctl, child };
  };

  it("sends ctrl+q and reports a clean exit", async () => {
    const { ctl, child } = fakeCtl({});
    expect(await quitBrowser({ ctl, child, timeoutMs: 1000 })).toBe(true);
    expect(ctl.sent).toEqual(["ctrl+q"]);
  });

  it("closes the help overlay first: ctrl+q while help is open is swallowed", async () => {
    const { ctl, child } = fakeCtl({ mode: "help" });
    expect(await quitBrowser({ ctl, child, timeoutMs: 1000, pollMs: 5 })).toBe(true);
    expect(ctl.sent).toEqual(["esc", "ctrl+q"]);
  });

  it("gives up (false) when the browser does not exit, so the caller signals it", async () => {
    const { ctl, child } = fakeCtl({ quits: false });
    expect(await quitBrowser({ ctl, child, timeoutMs: 100 })).toBe(false);
  });

  it("gives up (false) when the socket does not answer, without throwing", async () => {
    const { ctl, child } = fakeCtl({ fail: true });
    expect(await quitBrowser({ ctl, child, timeoutMs: 100 })).toBe(false);
    expect(ctl.sent).toEqual([]);
  });

  it("does nothing for a browser that already exited", async () => {
    const { ctl, child } = fakeCtl({});
    child.exit();
    expect(await quitBrowser({ ctl, child, timeoutMs: 100 })).toBe(true);
    expect(ctl.sent).toEqual([]);
  });
});
