// npm start (tools/start.mjs): argument parsing, build selection, user.js merging, profile
// preparation and the already-running check. Nothing here launches a browser.
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAC_READ_PATH_PREF,
  READ_PATH_PREF,
  browserCommand,
  devPrefs,
  startPrefs,
  mergeUserJs,
  parseStartArgs,
  prepareProfile,
  profileInUse,
  selectBuild,
} from "../start.mjs";

/** @type {string[]} */
const dirs = [];
// The real path: on macOS tmpdir() is under /var, a link to /private/var.
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "vimma-start-test-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseStartArgs", () => {
  it("defaults to the persistent dev profile, no import, not fresh", () => {
    expect(parseStartArgs([], "/home/u")).toEqual({
      profile: "/home/u/.cache/vimma-dev-profile",
      fresh: false,
      import: false,
      help: false,
      browserArgs: [],
    });
  });

  it("takes --profile, --fresh, --import, and passes what follows -- to the browser", () => {
    expect(
      parseStartArgs(["--profile", "p", "--import", "--", "--jsconsole", "about:blank"], "/h"),
    ).toMatchObject({
      profile: join(process.cwd(), "p"),
      import: true,
      fresh: false,
      browserArgs: ["--jsconsole", "about:blank"],
    });
    expect(parseStartArgs(["--fresh"], "/h").fresh).toBe(true);
  });

  it("refuses --fresh with --profile, and unknown flags", () => {
    expect(() => parseStartArgs(["--fresh", "--profile", "p"], "/h")).toThrow(/either/);
    expect(() => parseStartArgs(["--bogus"], "/h")).toThrow();
  });
});

describe("selectBuild", () => {
  const engine = "/repo/engine";
  /** @param {string[]} present */
  const exists = (present) => (/** @type {string} */ p) => present.includes(p);
  const full = "/repo/engine/obj-x86_64-pc-linux-gnu/dist/bin/vimma";
  const artifact = "/repo/engine/obj-artifact/dist/bin/vimma";

  const linux = { platform: "linux", arch: "x64" };

  it("prefers the full build, which needs no XUL_APP_FILE", () => {
    expect(selectBuild({ engine, exists: exists([full, artifact]), ...linux })).toEqual({
      kind: "full",
      binary: full,
      env: {},
    });
  });

  it("falls back to the artifact build with XUL_APP_FILE, as tools/mochitest.mjs runs it", () => {
    expect(selectBuild({ engine, exists: exists([artifact]), ...linux })).toEqual({
      kind: "artifact",
      binary: artifact,
      env: { XUL_APP_FILE: "/repo/engine/obj-artifact/dist/bin/browser/application.ini" },
    });
  });

  it("says how to build one when there is none", () => {
    expect(() => selectBuild({ engine, exists: exists([]), ...linux })).toThrow(
      /surfer build[^]*artifact/,
    );
  });

  describe("on Apple Silicon", () => {
    const mac = { platform: "darwin", arch: "arm64" };
    const macFull = "/repo/engine/obj-aarch64-apple-darwin/dist/Vimma.app/Contents/MacOS/vimma";
    const macArtifact = "/repo/engine/obj-artifact/dist/Vimma.app/Contents/MacOS/vimma";

    it("runs the full build's .app", () => {
      expect(selectBuild({ engine, exists: exists([macFull, macArtifact]), ...mac })).toEqual({
        kind: "full",
        binary: macFull,
        env: {},
      });
    });

    it("falls back to the artifact build's .app with XUL_APP_FILE", () => {
      expect(selectBuild({ engine, exists: exists([macArtifact]), ...mac })).toEqual({
        kind: "artifact",
        binary: macArtifact,
        env: { XUL_APP_FILE: "/repo/engine/obj-artifact/dist/bin/browser/application.ini" },
      });
    });

    it("ignores the Linux paths", () => {
      expect(() => selectBuild({ engine, exists: exists([full, artifact]), ...mac })).toThrow(
        /Vimma\.app[^]*surfer build/,
      );
    });
  });
});

describe("browserCommand", () => {
  it("runs with the profile, then the extra arguments, and keeps remoting on", () => {
    // Firefox 157 ignores --no-remote (nsAppRunner strips it); without it the dev instance
    // still answers the Omarchy hook's -vimma-reload-theme (spec m5-omarchy-theme).
    expect(browserCommand({ binary: "/b/vimma" }, "/p", ["about:blank"])).toEqual([
      "/b/vimma",
      ["--profile", "/p", "about:blank"],
    ]);
  });
});

describe("devPrefs", () => {
  it("lets content processes read the repo's src/ (absolute, trailing slash)", () => {
    const root = tempDir();
    expect(devPrefs(root, "linux")).toEqual([[READ_PATH_PREF, `${root}/src/`]]);
    expect(READ_PATH_PREF).toBe("security.sandbox.content.read_path_whitelist");
  });

  it("resolves a symlinked checkout, since the objdir's links resolve to the real path", () => {
    const real = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(real, link);
    expect(devPrefs(link, "linux")[0]?.[1]).toBe(`${real}/src/`);
  });

  it("on macOS sets the mac sandbox's testing read path instead (a subpath, no slash)", () => {
    const real = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(real, link);
    expect(devPrefs(link, "darwin")).toEqual([[MAC_READ_PATH_PREF, `${real}/src`]]);
    expect(MAC_READ_PATH_PREF).toBe("security.sandbox.content.mac.testing_read_path1");
  });
});

describe("startPrefs", () => {
  it("turns on the browser toolbox, remote debugging and dump() for npm start only", () => {
    const root = tempDir();
    const prefs = new Map(startPrefs(root, "linux"));
    expect(prefs.get(READ_PATH_PREF)).toBe(`${root}/src/`);
    expect(prefs.get("devtools.chrome.enabled")).toBe(true);
    expect(prefs.get("devtools.debugger.remote-enabled")).toBe(true);
    expect(prefs.get("browser.dom.window.dump.enabled")).toBe(true);
    expect(prefs.get("devtools.console.stdout.chrome")).toBe(true);
    // Left at the shipped 0: devtools.chrome.enabled already lifts the console's paste guard.
    expect(prefs.has("devtools.selfxss.count")).toBe(false);
    // devPrefs is shared with the e2e harness, which needs none of these.
    expect(new Map(devPrefs(root, "linux")).has("devtools.chrome.enabled")).toBe(false);
  });

  it("carries the mac read path on macOS", () => {
    const root = tempDir();
    const prefs = new Map(startPrefs(root, "darwin"));
    expect(prefs.get(MAC_READ_PATH_PREF)).toBe(`${root}/src`);
    expect(prefs.has(READ_PATH_PREF)).toBe(false);
    expect(prefs.get("devtools.chrome.enabled")).toBe(true);
  });
});

describe("mergeUserJs", () => {
  const prefs = /** @type {const} */ ([[READ_PATH_PREF, "/repo/src/"]]);

  it("writes the pref into an empty user.js", () => {
    expect(mergeUserJs("", prefs)).toBe(`user_pref("${READ_PATH_PREF}", "/repo/src/");\n`);
  });

  it("keeps every other line, comments included", () => {
    const existing = '// mine\nuser_pref("a.b", true);\n\nuser_pref("c", "d");\n';
    const merged = mergeUserJs(existing, prefs);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).toContain(`user_pref("${READ_PATH_PREF}", "/repo/src/");`);
  });

  it("is idempotent", () => {
    const once = mergeUserJs('user_pref("a", 1);\n', prefs);
    expect(mergeUserJs(once, prefs)).toBe(once);
  });

  it("adds the path to an existing whitelist instead of replacing it", () => {
    const existing = `user_pref("${READ_PATH_PREF}", "/opt/fonts/");\nuser_pref("z", 2);\n`;
    expect(mergeUserJs(existing, prefs)).toBe(
      `user_pref("${READ_PATH_PREF}", "/opt/fonts/,/repo/src/");\nuser_pref("z", 2);\n`,
    );
  });

  it("never drops a path that is already there", () => {
    const existing = `user_pref("${READ_PATH_PREF}", "/old/src/,/repo/src/");\n`;
    expect(mergeUserJs(existing, prefs)).toBe(existing);
  });

  it("adds a newline before appending to a file without one", () => {
    expect(mergeUserJs('user_pref("a", 1);', prefs)).toBe(
      `user_pref("a", 1);\nuser_pref("${READ_PATH_PREF}", "/repo/src/");\n`,
    );
  });
});

describe("prepareProfile", () => {
  it("creates the profile directory and its user.js", () => {
    const profile = join(tempDir(), "deep", "profile");
    prepareProfile(profile, [[READ_PATH_PREF, "/repo/src/"]]);
    expect(readFileSync(join(profile, "user.js"), "utf8")).toContain("/repo/src/");
  });

  it("merges into an existing user.js without clobbering it", () => {
    const profile = tempDir();
    writeFileSync(join(profile, "user.js"), 'user_pref("browser.startup.page", 3);\n');
    prepareProfile(profile, [[READ_PATH_PREF, "/repo/src/"]]);
    const js = readFileSync(join(profile, "user.js"), "utf8");
    expect(js).toContain('user_pref("browser.startup.page", 3);');
    expect(js).toContain(`user_pref("${READ_PATH_PREF}", "/repo/src/");`);
  });
});

describe("profileInUse", () => {
  const linux = { platform: "linux" };

  it("is null for a profile without a lock", () => {
    expect(profileInUse(tempDir(), linux)).toBeNull();
  });

  it("names the pid of a live lock (Firefox's lock symlink, ip:+pid)", () => {
    const profile = tempDir();
    symlinkSync(`127.0.0.1:+${process.pid}`, join(profile, "lock"));
    expect(profileInUse(profile, linux)).toEqual({ pid: process.pid });
  });

  it("ignores a stale lock left by a crash or a clean quit (its pid is gone)", () => {
    const profile = tempDir();
    symlinkSync("127.0.0.1:+12345", join(profile, "lock"));
    expect(profileInUse(profile, { alive: () => false, ...linux })).toBeNull();
  });

  it("names the pid holding a POSIX lock on .parentlock (/proc/locks), even without lock", () => {
    const profile = tempDir();
    writeFileSync(join(profile, ".parentlock"), "");
    const ino = statSync(join(profile, ".parentlock")).ino;
    const procLocks = () =>
      `1: POSIX  ADVISORY  WRITE 4242 00:2a:${ino} 0 EOF\n2: FLOCK  ADVISORY  WRITE 7 00:2a:1 0 EOF\n`;
    expect(profileInUse(profile, { procLocks, ...linux })).toEqual({ pid: 4242 });
    expect(profileInUse(profile, { procLocks: () => "", ...linux })).toBeNull();
  });

  it("treats an unreadable lock as in use (better a clear refusal than a second instance)", () => {
    const profile = tempDir();
    symlinkSync("garbage", join(profile, "lock"));
    expect(profileInUse(profile, linux)).toEqual({ pid: null });
  });

  // toolkit/profile/nsProfileLock.cpp: on macOS Firefox holds an fcntl lock on .parentlock (open
  // while it runs, left behind after) and makes no `lock` link; without fcntl, .parentlock
  // itself becomes the ip:+pid link. There is no /proc/locks, so lsof names the holder.
  describe("on macOS", () => {
    const NO_PROC = () => {
      throw new Error("no /proc/locks on macOS");
    };

    it("names the pid that has .parentlock open", () => {
      const profile = tempDir();
      writeFileSync(join(profile, ".parentlock"), "");
      /** @type {string[]} */
      const asked = [];
      const openers = (/** @type {string} */ path) => {
        asked.push(path);
        return [4242];
      };
      expect(profileInUse(profile, { platform: "darwin", openers, procLocks: NO_PROC })).toEqual({
        pid: 4242,
      });
      expect(asked).toEqual([join(profile, ".parentlock")]);
    });

    it("is null when nothing has .parentlock open (left behind by a quit)", () => {
      const profile = tempDir();
      writeFileSync(join(profile, ".parentlock"), "");
      const openers = () => [];
      expect(profileInUse(profile, { platform: "darwin", openers, procLocks: NO_PROC })).toBeNull();
    });

    it("reads a .parentlock link (the fallback without fcntl) like Linux's lock link", () => {
      const profile = tempDir();
      symlinkSync("127.0.0.1:+4242", join(profile, ".parentlock"));
      const openers = () => [];
      const darwin = { platform: "darwin", openers, procLocks: NO_PROC };
      expect(profileInUse(profile, { ...darwin, alive: () => true })).toEqual({ pid: 4242 });
      expect(profileInUse(profile, { ...darwin, alive: () => false })).toBeNull();
    });

    it("ignores a Linux lock link", () => {
      const profile = tempDir();
      symlinkSync(`127.0.0.1:+${process.pid}`, join(profile, "lock"));
      const openers = () => [];
      expect(profileInUse(profile, { platform: "darwin", openers, procLocks: NO_PROC })).toBeNull();
    });
  });
});
