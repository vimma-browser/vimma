// Issue #901: what a launch that never reached its control socket reports about the browser.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../launcher.ts";
import { parseStat, processReport, profileTimeline, startupLockReport } from "../startup-probe.ts";

const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.ts", import.meta.url));
const linux = process.platform === "linux";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "vimma-e2e-probe-test-"));
  dirs.push(d);
  return d;
};

/** A /proc/<pid>/stat line: comm, then fields 3 onwards (state, ppid, pgrp, ... utime, stime). */
const stat = (
  pid: number,
  comm: string,
  { state = "S", ppid = 1, pgrp = pid, utime = 0, stime = 0, threads = 1 } = {},
) => {
  // fields 3..22 of proc(5); 14 and 15 are utime and stime, 20 is num_threads
  const f = Array.from({ length: 20 }, () => "0");
  f[0] = state;
  f[1] = String(ppid);
  f[2] = String(pgrp);
  f[11] = String(utime);
  f[12] = String(stime);
  f[17] = String(threads);
  return `${pid} (${comm}) ${f.join(" ")}\n`;
};

describe("parseStat", () => {
  it("reads a command name that holds spaces and parentheses", () => {
    expect(parseStat(stat(42, "Web Content (x)", { pgrp: 7, utime: 150, stime: 50 }))).toEqual({
      pid: 42,
      comm: "Web Content (x)",
      state: "S",
      ppid: 1,
      pgrp: 7,
      cpuSeconds: 2,
      threads: 1,
    });
  });

  it("returns null for text that is not a stat line", () => {
    expect(parseStat("")).toBeNull();
    expect(parseStat("12 no parentheses")).toBeNull();
  });
});

describe("processReport", () => {
  const fakeProc = () => {
    const proc = tempDir();
    const add = (pid: number, line: string, tasks: Record<number, [string, string]> = {}) => {
      mkdirSync(join(proc, String(pid), "task"), { recursive: true });
      writeFileSync(join(proc, String(pid), "stat"), line);
      for (const [tid, [taskLine, wchan]] of Object.entries(tasks)) {
        mkdirSync(join(proc, String(pid), "task", tid));
        writeFileSync(join(proc, String(pid), "task", tid, "stat"), taskLine);
        writeFileSync(join(proc, String(pid), "task", tid, "wchan"), wchan);
      }
    };
    return { proc, add };
  };

  it("lists the group's processes and the main process's threads, main thread first", () => {
    const { proc, add } = fakeProc();
    add(100, stat(100, "vimma", { utime: 2900, stime: 100, threads: 3 }), {
      100: [stat(100, "vimma", { state: "D", utime: 20, stime: 10 }), "io_schedule"],
      101: [stat(101, "Gecko_IOThread", { pgrp: 100, utime: 2800 }), "do_epoll_wait"],
      102: [stat(102, "Timer", { pgrp: 100, state: "R" }), "0"],
    });
    add(130, stat(130, "Isolated Web Co", { ppid: 100, pgrp: 100, utime: 50 }));
    add(999, stat(999, "bash", { pgrp: 999 }));
    writeFileSync(join(proc, "self"), "not a pid");

    const report = processReport(100, { proc });
    expect(report).toContain("processes in the browser's process group 100");
    expect(report).toMatch(/^ {2}100 vimma +state S +cpu 30\.00 s +3 threads$/m);
    expect(report).toMatch(/^ {2}130 Isolated Web Co +state S +cpu 0\.50 s +1 threads$/m);
    expect(report).not.toContain("bash");
    const lines = report.split("\n");
    const threads = lines.slice(lines.findIndex((l) => l.startsWith("threads of 100")) + 1);
    expect(threads[0]).toMatch(/^ {2}100 vimma +state D +cpu 0\.30 s +in io_schedule +\(main\)$/);
    expect(threads[1]).toMatch(/^ {2}101 Gecko_IOThread +state S +cpu 28\.00 s +in do_epoll_wait$/);
    expect(threads[2]).toMatch(/^ {2}102 Timer +state R +cpu 0\.00 s +running$/);
  });

  it("says so when no process of the group is left", () => {
    const { proc } = fakeProc();
    expect(processReport(100, { proc })).toMatch(/no process left in the browser's group 100/);
  });

  it("is empty where there is no /proc (macOS)", () => {
    expect(processReport(100, { proc: join(tempDir(), "missing") })).toBe("");
  });
});

describe("profileTimeline", () => {
  it("lists the profile's entries by last change, in seconds since spawn", () => {
    const profile = tempDir();
    const spawnedAt = 1_700_000_000_000;
    const at = (name: string, offsetMs: number) => {
      const t = (spawnedAt + offsetMs) / 1000;
      utimesSync(join(profile, name), t, t);
    };
    writeFileSync(join(profile, "user.js"), "");
    at("user.js", -200);
    writeFileSync(join(profile, "compatibility.ini"), "");
    at("compatibility.ini", 1500);
    mkdirSync(join(profile, "startupCache"));
    at("startupCache", 2250);
    symlinkSync("127.0.0.1:+4242", join(profile, "lock"));

    const report = profileTimeline(profile, spawnedAt);
    const lines = report.split("\n");
    expect(lines[0]).toMatch(/^profile entries by last change, in seconds since spawn/);
    expect(lines.slice(1, 4)).toEqual([
      "  -0.200 s  user.js",
      "  +1.500 s  compatibility.ini",
      "  +2.250 s  startupCache/",
    ]);
    // The lock symlink is named, never its target (it holds the machine's address).
    expect(report).toMatch(/^ {2}[+-]\d+\.\d{3} s {2}lock -> \(symlink\)$/m);
    expect(report).not.toContain("127.0.0.1");
    expect(report).toMatch(/^profile lock: lock only/m);
  });

  it("says when start-up stopped between the fcntl lock and the lock symlink", () => {
    const profile = tempDir();
    writeFileSync(join(profile, ".parentlock"), "");
    expect(profileTimeline(profile, Date.now())).toMatch(
      /\.parentlock but no lock symlink: .*hostname/,
    );
    symlinkSync("127.0.0.1:+1", join(profile, "lock"));
    expect(profileTimeline(profile, Date.now())).toMatch(/got past this lock/);
  });

  it("says when the browser never locked its profile", () => {
    const profile = tempDir();
    writeFileSync(join(profile, "user.js"), "");
    expect(profileTimeline(profile, Date.now())).toMatch(
      /no lock and no \.parentlock: the browser never locked this profile/,
    );
  });

  it("says when the profile cannot be listed", () => {
    expect(profileTimeline(join(tempDir(), "gone"), Date.now())).toMatch(/cannot list/);
  });
});

describe("startupLockReport", () => {
  // nsRemoteService::LockStartup takes an nsProfileLock on $TMPDIR/<program> before the profile's.
  it("lists the start-up lock folder in TMPDIR and where its lock got", () => {
    const tmp = tempDir();
    const spawnedAt = Date.now() - 5000;
    mkdirSync(join(tmp, "vimma"));
    writeFileSync(join(tmp, "vimma", ".parentlock"), "");
    const report = startupLockReport(tmp, spawnedAt);
    expect(report).toMatch(/^TMPDIR entries by last change, in seconds since spawn/);
    expect(report).toMatch(/^ {2}\+\d+\.\d{3} s {2}vimma\/\.parentlock$/m);
    expect(report).toMatch(/^start-up lock vimma: \.parentlock but no lock symlink: .*hostname/m);
  });

  it("says when TMPDIR holds no start-up lock", () => {
    expect(startupLockReport(tempDir(), Date.now())).toMatch(
      /^no start-up lock in TMPDIR: not taken yet, or already released/m,
    );
  });
});

describe.runIf(linux)("a launch that never reaches its socket (fake browser)", () => {
  it("reports the profile's entries and the browser's processes", async () => {
    const tmpRoot = tempDir();
    let profile = "";
    const err = await launch({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never", FAKE_BROWSER_CHILD: "1" } },
      xvfb: false,
      tmpRoot,
      runtimeRoot: tempDir(),
      keep: true,
      discoveryTimeoutMs: 1500,
      graceMs: 300,
      onProfile: (p: string) => (profile = p),
      log: () => {},
    }).catch((e: unknown) => e);
    dirs.push(profile);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/no usable control socket within 1500 ms/);
    expect(message).toMatch(/^ {2}\+\d+\.\d{3} s {2}fake-browser\.json$/m);
    expect(message).toMatch(/no lock and no \.parentlock/);
    const grandchild = readFileSync(join(profile, "grandchild.pid"), "utf8").trim();
    expect(message).toMatch(new RegExp(`^ {2}${grandchild} \\S+ +state `, "m"));
    expect(message).toMatch(/\(main\)$/m);
  });
});

describe.runIf(linux)("a launch slower than slowLaunchMs (fake browser)", () => {
  it("logs where start-up was at that time, once the socket has come", async () => {
    const logged: string[] = [];
    const session = await launch({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER_DELAY_MS: "1200" } },
      xvfb: false,
      tmpRoot: tempDir(),
      runtimeRoot: tempDir(),
      discoveryTimeoutMs: 5000,
      slowLaunchMs: 300,
      graceMs: 300,
      log: (line) => logged.push(line),
    });
    try {
      expect(logged).toHaveLength(1);
      const [line] = logged as [string];
      expect(line).toMatch(
        /^launch: the control socket came \d+\.\d s after spawn, later than 0\.3 s/,
      );
      expect(line).toMatch(/^start-up at 0\.3 s since spawn:$/m);
      expect(line).toMatch(/^ {2}[+-]\d+\.\d{3} s {2}user\.js$/m);
      expect(line).toMatch(/^processes in the browser's process group \d+/m);
    } finally {
      await session.teardown();
    }
  });

  it("a launch that times out reports start-up both at slowLaunchMs and at the end", async () => {
    const err = await launch({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never" } },
      xvfb: false,
      tmpRoot: tempDir(),
      runtimeRoot: tempDir(),
      discoveryTimeoutMs: 1200,
      slowLaunchMs: 300,
      graceMs: 300,
    }).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toMatch(/^start-up at 0\.3 s since spawn:$/m);
    expect(message).toMatch(/^start-up at the end of the wait:$/m);
    expect(message.match(/^profile entries by last change/gm)).toHaveLength(2);
    expect(message.match(/^browser stderr with the time since spawn/gm)).toHaveLength(1);
  });
});
