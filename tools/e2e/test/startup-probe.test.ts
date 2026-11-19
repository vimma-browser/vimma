// Issue #901: what a launch that never reached its control socket reports about the browser.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, warmUp } from "../launcher.ts";
import {
  parseStat,
  processReport,
  profileTimeline,
  readDiskBytes,
  readMachine,
  startupLockReport,
  startupSampler,
} from "../startup-probe.ts";

const FAKE_BROWSER = fileURLToPath(new URL("./fixtures/fake-browser.ts", import.meta.url));
const linux = process.platform === "linux";
/** The lock conclusions are drawn on Linux only; these tests check them on any machine. */
const LINUX = { platform: "linux" };

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

/** A fake /proc with the machine's counters: /proc/stat's cpu line and the PSI files. */
const fakeMachine = (
  proc: string,
  {
    steal = 0,
    iowait = 0,
    psi = { cpu: 0, io: 0, memory: 0 } as Record<string, number> | null,
  } = {},
) => {
  // cpu user nice system idle iowait irq softirq steal guest guest_nice, in USER_HZ
  writeFileSync(join(proc, "stat"), `cpu  100 0 50 1000 ${iowait} 0 0 ${steal} 0 0\ncpu0 1 2\n`);
  if (!psi) return;
  mkdirSync(join(proc, "pressure"), { recursive: true });
  for (const [name, us] of Object.entries(psi)) {
    const full = name === "cpu" ? 0 : Math.floor(us / 2);
    writeFileSync(
      join(proc, "pressure", name),
      `some avg10=0.00 avg60=0.00 avg300=0.00 total=${us}\n` +
        `full avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\n`,
    );
  }
};

describe("readMachine", () => {
  it("reads CPU steal and iowait from /proc/stat and the stall totals from /proc/pressure", () => {
    const proc = tempDir();
    fakeMachine(proc, { steal: 250, iowait: 30, psi: { cpu: 1_500_000, io: 400, memory: 0 } });
    expect(readMachine({ proc })).toEqual({
      stealSeconds: 2.5,
      iowaitSeconds: 0.3,
      stallSeconds: { cpu: 1.5, io: 0.0004, memory: 0 },
    });
  });

  it("leaves out what the kernel does not offer (no PSI, no /proc)", () => {
    const proc = tempDir();
    fakeMachine(proc, { psi: null });
    expect(readMachine({ proc })).toEqual({
      stealSeconds: 0,
      iowaitSeconds: 0,
      stallSeconds: null,
    });
    expect(readMachine({ proc: join(proc, "missing") })).toEqual({
      stealSeconds: null,
      iowaitSeconds: null,
      stallSeconds: null,
    });
  });
});

describe("startupSampler", () => {
  // Issue #901: one snapshot at the timeout cannot tell a main thread blocked for 25 s from a
  // machine that stopped (a paused VM, a writeback stall): a sample each second can.
  const setup = () => {
    const proc = tempDir();
    const task = (state: string, utime: number, wchan: string, readMB = 0) => {
      writeFileSync(join(proc, "100", "io"), `read_bytes: ${readMB * 1_000_000}\n`);
      writeFileSync(join(proc, "100", "task", "100", "stat"), stat(100, "vimma", { state, utime }));
      writeFileSync(join(proc, "100", "task", "100", "wchan"), wchan);
    };
    mkdirSync(join(proc, "100", "task", "100"), { recursive: true });
    let t = 1_700_000_000_000;
    const clock = { now: () => t, advance: (ms: number) => (t += ms) };
    return { proc, task, clock, spawnedAtMs: t };
  };

  it("lists each sample: the main thread, the harness's lag and the machine's deltas", () => {
    const { proc, task, clock, spawnedAtMs } = setup();
    fakeMachine(proc);
    const sampler = startupSampler({ pid: 100, spawnedAtMs, proc, now: clock.now });
    clock.advance(1000);
    task("R", 80, "0", 1);
    fakeMachine(proc, { steal: 10, iowait: 2, psi: { cpu: 300_000, io: 0, memory: 0 } });
    sampler.sample();
    // the harness itself stalled: this sample came 26 s after the previous one
    clock.advance(26_000);
    task("S", 85, "poll_schedule_timeout.constprop.0", 151);
    fakeMachine(proc, { steal: 2410, iowait: 2, psi: { cpu: 300_000, io: 24_000_000, memory: 0 } });
    sampler.sample();

    const lines = sampler.format().split("\n");
    expect(lines[0]).toMatch(/^start-up samples about each second since spawn/);
    expect(lines[1]).toBe(
      "  +1.000 s  main R cpu 0.80 s running  disk read 1.0 MB  harness lag 0.0 s  " +
        "steal 0.10 s  iowait 0.02 s  stall cpu 0.30 io 0.00 memory 0.00 s",
    );
    expect(lines[2]).toBe(
      "  +27.000 s  main S cpu 0.85 s in poll_schedule_timeout.constprop.0  disk read 151.0 MB  " +
        "harness lag 25.0 s  " +
        "steal 24.00 s  iowait 0.00 s  stall cpu 0.00 io 24.00 memory 0.00 s",
    );
  });

  it("says when the main thread is gone and leaves out what the machine does not offer", () => {
    const { proc, clock, spawnedAtMs } = setup();
    const sampler = startupSampler({ pid: 100, spawnedAtMs, proc, now: clock.now });
    clock.advance(1000);
    sampler.sample();
    expect(sampler.format().split("\n")[1]).toBe("  +1.000 s  main gone  harness lag 0.0 s");
  });

  it("keeps only the last maxSamples, and says how many it dropped", () => {
    const { proc, clock, spawnedAtMs } = setup();
    const sampler = startupSampler({ pid: 100, spawnedAtMs, proc, now: clock.now, maxSamples: 2 });
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      sampler.sample();
    }
    const lines = sampler.format().split("\n");
    expect(lines[0]).toMatch(/3 earlier samples dropped/);
    expect(lines.slice(1).map((l) => l.trim().split(" ")[0])).toEqual(["+4.000", "+5.000"]);
  });

  it("says so before the first sample", () => {
    const { proc, clock, spawnedAtMs } = setup();
    expect(startupSampler({ pid: 100, spawnedAtMs, proc, now: clock.now }).format()).toBe(
      "start-up samples: none yet",
    );
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

    const report = profileTimeline(profile, spawnedAt, LINUX);
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
    expect(profileTimeline(profile, Date.now(), LINUX)).toMatch(
      /\.parentlock but no lock symlink: .*hostname/,
    );
    symlinkSync("127.0.0.1:+1", join(profile, "lock"));
    expect(profileTimeline(profile, Date.now(), LINUX)).toMatch(/got past this lock/);
  });

  it("says when the browser never locked its profile", () => {
    const profile = tempDir();
    writeFileSync(join(profile, "user.js"), "");
    expect(profileTimeline(profile, Date.now(), LINUX)).toMatch(
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
    const report = startupLockReport(tmp, spawnedAt, LINUX);
    expect(report).toMatch(/^TMPDIR entries by last change, in seconds since spawn/);
    expect(report).toMatch(/^ {2}\+\d+\.\d{3} s {2}vimma\/\.parentlock$/m);
    expect(report).toMatch(/^start-up lock vimma: \.parentlock but no lock symlink: .*hostname/m);
  });

  it("says when TMPDIR holds no start-up lock", () => {
    expect(startupLockReport(tempDir(), Date.now(), LINUX)).toMatch(
      /^no start-up lock in TMPDIR: not taken yet, or already released/m,
    );
  });
});

// macOS's nsProfileLock takes only .parentlock and makes no lock symlink, so the Linux
// conclusion ("stopped before the hostname lookup") would be wrong there.
describe("lock conclusions on other platforms", () => {
  it("lists the entries but draws no lock conclusion off Linux", () => {
    const profile = tempDir();
    const spawnedAt = Date.now();
    writeFileSync(join(profile, ".parentlock"), "");
    mkdirSync(join(profile, "vimma"));
    writeFileSync(join(profile, "vimma", ".parentlock"), "");
    for (const report of [
      profileTimeline(profile, spawnedAt, { platform: "darwin" }),
      startupLockReport(profile, spawnedAt, { platform: "darwin" }),
    ]) {
      expect(report).toMatch(/^ {2}[+-]\d+\.\d{3} s {2}(vimma\/)?\.parentlock$/m);
      expect(report).not.toMatch(/lock symlink|hostname|never locked|start-up lock|got past/);
    }
    expect(profileTimeline(profile, spawnedAt, { platform: "linux" })).toMatch(/hostname/);
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
    // sampled about each second while it waited (1.5 s: at least one sample)
    expect(message).toMatch(/^start-up samples about each second since spawn/m);
    expect(message).toMatch(/^ {2}\+1\.\d{3} s {2}main \S+ cpu \d+\.\d\d s .* harness lag /m);
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
      expect(line).toMatch(/^start-up samples/m);
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

// Issue #901: on CI the first scenario's launch is the runner's first headed start (the
// mochitests before it run headless), so it reads the build, GTK, X11 and Mesa from a cold disk:
// every launch over 10 s there was the first scenario's, its main thread in disk wait. The
// warm-up start takes that once, outside every scenario's discovery timeout.
describe.runIf(linux)("the warm-up start before the first scenario (fake browser)", () => {
  const coldBuild = (marker: string) => ({
    binary: FAKE_BROWSER,
    env: { FAKE_BROWSER_COLD_MARKER: marker, FAKE_BROWSER_COLD_MS: "1500" },
  });
  const options = () => ({
    xvfb: false,
    tmpRoot: tempDir(),
    runtimeRoot: tempDir(),
    graceMs: 300,
  });

  it("without it, a cold machine's first start misses the scenario's discovery timeout", async () => {
    const build = coldBuild(join(tempDir(), "warm"));
    const err = await launch({ build, ...options(), discoveryTimeoutMs: 1000 }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/no usable control socket within 1000 ms/);
  });

  it("takes the cold start, so the first scenario's launch is within its timeout", async () => {
    const build = coldBuild(join(tempDir(), "warm"));
    const logged: string[] = [];
    await warmUp({ build, ...options(), log: (line) => logged.push(line) });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^warm-up: the build's first start took \d+\.\d s \(control socket after \d+\.\d s; read [\d.]+ MB from disk\)/,
    );
    const session = await launch({ build, ...options(), discoveryTimeoutMs: 1000 });
    await session.teardown();
  });

  it("fails with the launch's report when even the warm-up start never comes up", async () => {
    const err = await warmUp({
      build: { binary: FAKE_BROWSER, env: { FAKE_BROWSER: "never" } },
      ...options(),
      timeoutMs: 800,
      log: () => {},
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(
      /^warm-up: the build did not start: no usable control socket within 800 ms/,
    );
    expect((err as Error).message).toMatch(/^profile entries by last change/m);
  });
});

describe("readDiskBytes", () => {
  it("reads read_bytes from /proc/<pid>/io, null when it cannot", () => {
    const proc = tempDir();
    mkdirSync(join(proc, "7"));
    writeFileSync(join(proc, "7", "io"), "rchar: 900\nread_bytes: 4096000\nwrite_bytes: 0\n");
    expect(readDiskBytes(7, { proc })).toBe(4_096_000);
    expect(readDiskBytes(8, { proc })).toBeNull();
  });
});
