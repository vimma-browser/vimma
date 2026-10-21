// docs/specs/m6a-updater.md §5: `:restart` (action app.restart), and how an AppImage restarts into
// the file it replaced. Pure rules, plus the relaunch script run by a real /bin/sh.
import { describe, test, expect, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELAUNCH_SCRIPT,
  RELAUNCH_WAIT_S,
  relaunchCommand,
  restartConfirmation,
  restartKeepsTabs,
  restartPlan,
} from "../src/restart.mjs";
import { parseCommandLine } from "../src/cmdline.mjs";
import { getAction } from "../src/actions.mjs";
import { compileKeymap } from "../src/keymap.mjs";

const APPIMAGE = "/home/u/Applications/vimma-0.1.0-x86_64.AppImage";

describe(":restart and the restart action", () => {
  test(":restart runs app.restart", () => {
    expect(parseCommandLine(":restart")).toEqual({
      kind: "run",
      command: "restart",
      action: { id: "app.restart" },
    });
  });

  test("restart exists and has no default key", () => {
    expect(getAction("restart")?.id).toBe("app.restart");
    expect(compileKeymap().bindingsFor("restart")).toEqual([]);
  });
});

describe("restartPlan (how this install restarts)", () => {
  test("an AppImage starts its file again, which may now hold the new version", () => {
    expect(restartPlan({ installType: "appimage", appImage: APPIMAGE })).toEqual({
      kind: "appimage",
      path: APPIMAGE,
    });
  });

  test("every other install restarts through Firefox, which runs the same binary path", () => {
    for (const installType of /** @type {const} */ (["tarball", "deb", "aur", "source"])) {
      expect(restartPlan({ installType, appImage: APPIMAGE })).toEqual({ kind: "firefox" });
    }
  });

  test("an AppImage without a usable $APPIMAGE falls back to Firefox's restart", () => {
    for (const appImage of [null, "", "relative/vimma.AppImage", "/tmp/a\0b"]) {
      expect(restartPlan({ installType: "appimage", appImage })).toEqual({ kind: "firefox" });
    }
  });
});

describe("relaunchCommand", () => {
  test("/bin/sh runs a fixed script; the pid and the path are arguments, never script text", () => {
    const cmd = relaunchCommand({ pid: 4242, appImage: APPIMAGE });
    expect(cmd).toEqual({
      program: "/bin/sh",
      args: ["-c", RELAUNCH_SCRIPT, "vimma-restart", "4242", APPIMAGE],
    });
    expect(RELAUNCH_SCRIPT).not.toContain(APPIMAGE);
  });

  test("refuses a pid that is not a positive integer and a path that is not absolute", () => {
    expect(() => relaunchCommand({ pid: 0, appImage: APPIMAGE })).toThrow();
    expect(() => relaunchCommand({ pid: 1.5, appImage: APPIMAGE })).toThrow();
    expect(() => relaunchCommand({ pid: 7, appImage: "vimma.AppImage" })).toThrow();
  });

  test("gives up after RELAUNCH_WAIT_S when the old process never exits", () => {
    expect(RELAUNCH_WAIT_S).toBe(120);
    expect(RELAUNCH_SCRIPT).toContain(String(RELAUNCH_WAIT_S * 5));
  });
});

describe("the relaunch script under /bin/sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "vimma-relaunch-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** An executable that records that it ran, at a path with characters a shell would expand. */
  function fakeAppImage() {
    const marker = join(dir, "ran");
    const path = join(dir, "it's $(touch pwned) `x` ; vimma.AppImage");
    writeFileSync(path, `#!/bin/sh\necho "$@" > '${marker}'\n`);
    chmodSync(path, 0o755);
    return { path, marker };
  }

  test("starts the AppImage only once the old process has exited, with no arguments", async () => {
    const { path, marker } = fakeAppImage();
    const old = spawn("sleep", ["0.6"]);
    const { program, args } = relaunchCommand({
      pid: /** @type {number} */ (old.pid),
      appImage: path,
    });
    const helper = spawn(program, args, { cwd: dir });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker), "not while the old process runs").toBe(false);
    await new Promise((r) => helper.on("exit", r));
    expect(readFileSync(marker, "utf8")).toBe("\n");
    expect(existsSync(join(dir, "pwned")), "the path is never shell text").toBe(false);
  });

  test("a process that is already gone: starts at once", () => {
    const { path, marker } = fakeAppImage();
    rmSync(marker, { force: true });
    const gone = spawnSync("true");
    const { program, args } = relaunchCommand({ pid: gone.pid ?? 999999, appImage: path });
    const r = spawnSync(program, args, { cwd: dir, timeout: 5000 });
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("restartKeepsTabs (whether session restore brings the tabs back)", () => {
  const base = { appImage: false, permanentPrivate: false, clearsHistoryOnClose: false };

  test("Firefox's restart and an AppImage's both bring them back", () => {
    expect(restartKeepsTabs(base)).toBe(true);
    expect(restartKeepsTabs({ ...base, appImage: true })).toBe(true);
  });

  test("history cleared on close: an AppImage's restart is a quit, so the session is purged", () => {
    expect(restartKeepsTabs({ ...base, appImage: true, clearsHistoryOnClose: true })).toBe(false);
    expect(restartKeepsTabs({ ...base, clearsHistoryOnClose: true })).toBe(true);
  });

  test("permanent private browsing keeps no tab across any restart", () => {
    expect(restartKeepsTabs({ ...base, permanentPrivate: true })).toBe(false);
  });
});

describe("restartConfirmation (the y/N :restart asks before tabs are lost)", () => {
  test("nothing to lose: no question", () => {
    expect(restartConfirmation({ privateTabs: 0, tabsKept: true })).toBeNull();
  });

  test("says how many private tabs close and ends in (y/N)", () => {
    expect(restartConfirmation({ privateTabs: 1, tabsKept: true })).toBe(
      "Restart Vimma? 1 private tab will close. (y/N)",
    );
    expect(restartConfirmation({ privateTabs: 3, tabsKept: true })).toBe(
      "Restart Vimma? 3 private tabs will close. (y/N)",
    );
  });

  test("tabs that will not come back are said first, private or not", () => {
    for (const privateTabs of [0, 2]) {
      expect(restartConfirmation({ privateTabs, tabsKept: false })).toBe(
        "Restart Vimma? Tabs will not come back. (y/N)",
      );
    }
  });
});
