// Issue #901: what a browser that never reached its control socket was doing when the launcher
// gave up. Once, on CI, the first launch after the mochitest suite wrote no discovery file in
// 30 s, and its stderr could not say which start-up phase stalled. A failed launch now also
// reports, read without privileges while the browser still runs:
// - the profile's entries by last change, in seconds since spawn, so the phases the browser
//   reached show (the profile lock first, then compatibility.ini, prefs, the startup cache,
//   session files), and those of its TMPDIR, where the start-up lock comes before the profile's;
//   Firefox's two nsProfileLocks each look up the machine's hostname on the main thread, and a
//   resolver that does not answer stalls start-up there (shown on a local run with an unreachable
//   nameserver);
// - the processes in the browser's process group (content processes start only after the first
//   window) and the main process's threads, with their state, CPU time and kernel wait channel,
//   so a main thread that blocks (state S or D, little CPU) tells from one that is busy (R).
// Names only: no file contents and no symlink targets (the lock's target holds the machine's
// address), so nothing from the profile reaches a public CI log.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** USER_HZ, the unit of utime and stime in /proc/<pid>/stat on every Linux the harness runs on. */
const CLOCK_TICKS = 100;
/** At most this many threads of the main process are listed, the main thread always first. */
export const PROBE_MAX_THREADS = 30;
/** At most this many profile entries are listed, the most recently changed ones. */
export const PROBE_MAX_ENTRIES = 60;

export type ProcStat = {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  pgrp: number;
  cpuSeconds: number;
  threads: number;
};

/**
 * One /proc/<pid>/stat (or task/<tid>/stat) line. The command name is in parentheses and may
 * itself hold spaces and parentheses, so the fields start after the last ")".
 */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 1 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  // fields 3 onwards of proc(5): state ppid pgrp session tty_nr tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice num_threads
  const f = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (!Number.isInteger(pid) || f.length < 18) return null;
  return {
    pid,
    comm: text.slice(open + 1, close),
    state: f[0] as string,
    ppid: Number(f[1]),
    pgrp: Number(f[2]),
    cpuSeconds: (Number(f[11]) + Number(f[12])) / CLOCK_TICKS,
    threads: Number(f[17]),
  };
}

const readStat = (path: string) => {
  try {
    return parseStat(readFileSync(path, "utf8"));
  } catch {
    return null; // gone meanwhile
  }
};

const readWchan = (path: string) => {
  try {
    const w = readFileSync(path, "utf8").trim();
    return w && w !== "0" ? `in ${w}` : "running";
  } catch {
    return "wait channel unknown";
  }
};

const cpu = (s: number) => `cpu ${s.toFixed(2)} s`;

/**
 * The processes of process group `pgid` (the browser and its content processes: the launcher
 * spawns it detached, so its pid is the group's id), then the threads of the process `pgid`,
 * the main thread first and the others busiest first.
 * @returns "" where there is no /proc (macOS)
 */
export function processReport(
  pgid: number,
  { proc = "/proc", maxThreads = PROBE_MAX_THREADS }: { proc?: string; maxThreads?: number } = {},
): string {
  let pids: string[];
  try {
    pids = readdirSync(proc).filter((name) => /^\d+$/.test(name));
  } catch {
    return "";
  }
  const group = pids
    .map((pid) => readStat(join(proc, pid, "stat")))
    .filter((s): s is ProcStat => s !== null && s.pgrp === pgid)
    .sort((a, b) => a.pid - b.pid);
  if (!group.length) return `no process left in the browser's group ${pgid}`;
  const lines = [
    `processes in the browser's process group ${pgid} (content processes start after the first ` +
      "window):",
    ...group.map(
      (s) => `  ${s.pid} ${s.comm}  state ${s.state}  ${cpu(s.cpuSeconds)}  ${s.threads} threads`,
    ),
  ];
  let tids: string[] = [];
  try {
    tids = readdirSync(join(proc, String(pgid), "task")).filter((t) => /^\d+$/.test(t));
  } catch {
    // the main process is gone, or its threads cannot be read
  }
  const threads = tids
    .map((tid) => {
      const s = readStat(join(proc, String(pgid), "task", tid, "stat"));
      return s && { ...s, wchan: readWchan(join(proc, String(pgid), "task", tid, "wchan")) };
    })
    .filter((t) => t !== null)
    .sort((a, b) =>
      a.pid === pgid ? -1 : b.pid === pgid ? 1 : b.cpuSeconds - a.cpuSeconds || a.pid - b.pid,
    );
  if (threads.length) {
    const shown = threads.slice(0, maxThreads);
    const more = threads.length - shown.length;
    lines.push(
      `threads of ${pgid} (state, CPU time, kernel wait channel; main thread first, then the ` +
        `busiest${more ? `; ${more} more not shown` : ""}):`,
      ...shown.map(
        (t) =>
          `  ${t.pid} ${t.comm}  state ${t.state}  ${cpu(t.cpuSeconds)}  ${t.wchan}` +
          `${t.pid === pgid ? "  (main)" : ""}`,
      ),
    );
  }
  return lines.join("\n");
}

/**
 * Where a Linux nsProfileLock::Lock got in folder `names` (the profile, or the start-up lock's
 * folder): it takes the fcntl lock on .parentlock, then looks up the machine's own hostname
 * (PR_GetHostByName, on the main thread) for the signature of the "lock" symlink, and only then
 * makes that symlink.
 */
function lockPhase(what: string, names: readonly string[]): string {
  const fcntl = names.includes(".parentlock");
  const symlink = names.includes("lock");
  if (fcntl && symlink) return `${what}: .parentlock and lock (start-up got past this lock)`;
  if (fcntl) {
    return (
      `${what}: .parentlock but no lock symlink: start-up stopped between the fcntl lock and ` +
      "the symlink, which waits for a lookup of the machine's hostname"
    );
  }
  if (symlink) return `${what}: lock only (start-up got past this lock)`;
  return `${what}: neither .parentlock nor lock`;
}

const secs = (ms: number) => `${ms < 0 ? "-" : "+"}${(Math.abs(ms) / 1000).toFixed(3)} s`;

/** `dir`'s entries (and with `depth` 2 their children) with their mtimes; [] if unreadable. */
function entries(dir: string, spawnedAtMs: number, depth = 1, prefix = "") {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ label: string; ms: number }> = [];
  for (const name of names) {
    try {
      const st = lstatSync(join(dir, name));
      const path = `${prefix}${name}`;
      const label = st.isSymbolicLink()
        ? `${path} -> (symlink)`
        : st.isDirectory()
          ? `${path}/`
          : path;
      out.push({ label, ms: st.mtimeMs - spawnedAtMs });
      if (depth > 1 && st.isDirectory()) {
        out.push(...entries(join(dir, name), spawnedAtMs, depth - 1, `${path}/`));
      }
    } catch {
      // removed meanwhile
    }
  }
  return out.sort((a, b) => a.ms - b.ms || a.label.localeCompare(b.label));
}

/**
 * The start-up lock: before the profile's lock, nsRemoteService::LockStartup takes another
 * nsProfileLock on $TMPDIR/<program>, with the same hostname lookup, and removes that folder once
 * start-up is done. `tmp` is the browser's TMPDIR (inside the profile, so only this browser's).
 */
export function startupLockReport(
  tmp: string,
  spawnedAtMs: number,
  { platform = process.platform }: { platform?: string } = {},
): string {
  const all = entries(tmp, spawnedAtMs, 2);
  const inside = (d: string) =>
    all
      .filter((e) => e.label.startsWith(`${d}/`))
      .map((e) => e.label.slice(d.length + 1).replace(/ -> \(symlink\)$/, ""));
  const lockDirs = all
    .filter((e) => /^[^/]+\/$/.test(e.label))
    .map((e) => e.label.slice(0, -1))
    .filter((d) => inside(d).some((n) => n === ".parentlock" || n === "lock"));
  return [
    "TMPDIR entries by last change, in seconds since spawn:",
    ...all.slice(-PROBE_MAX_ENTRIES).map((e) => `  ${secs(e.ms)}  ${e.label}`),
    // Only Linux makes the lock symlink these conclusions rest on (macOS takes .parentlock only).
    ...(platform !== "linux"
      ? []
      : lockDirs.length
        ? lockDirs.map((d) => lockPhase(`start-up lock ${d}`, inside(d)))
        : ["no start-up lock in TMPDIR: not taken yet, or already released after start-up"]),
  ].join("\n");
}

/**
 * The profile's top-level entries by last change, in seconds since `spawnedAtMs` (epoch ms),
 * oldest first: the start-up phases the browser reached. Directories end in "/", symlinks show
 * as "-> (symlink)" without their target.
 */
export function profileTimeline(
  profile: string,
  spawnedAtMs: number,
  {
    maxEntries = PROBE_MAX_ENTRIES,
    platform = process.platform,
  }: { maxEntries?: number; platform?: string } = {},
): string {
  let names: string[];
  try {
    names = readdirSync(profile);
  } catch (e) {
    return `profile entries: cannot list ${profile}: ${(e as Error).message}`;
  }
  const all = entries(profile, spawnedAtMs);
  const shown = all.slice(-maxEntries);
  const dropped = all.length - shown.length;
  const phase = lockPhase("profile lock", names);
  const older = dropped ? ` (${dropped} older not shown)` : "";
  return [
    `profile entries by last change, in seconds since spawn${older}:`,
    ...shown.map((e) => `  ${secs(e.ms)}  ${e.label}`),
    // As in startupLockReport: a conclusion on Linux only.
    ...(platform !== "linux"
      ? []
      : [
          phase.endsWith("neither .parentlock nor lock")
            ? "no lock and no .parentlock: the browser never locked this profile"
            : phase,
        ]),
  ].join("\n");
}

/**
 * Everything above for a browser that has not written its discovery file: the profile's
 * timeline, its TMPDIR's start-up lock (when `tmp` is given), then its processes. `pid` is the
 * browser's (its process group's) pid.
 */
export function startupProbe({
  profile,
  pid,
  spawnedAtMs,
  tmp,
  proc,
}: {
  profile: string;
  pid: number | undefined;
  spawnedAtMs: number;
  tmp?: string;
  proc?: string;
}): string {
  const parts = [profileTimeline(profile, spawnedAtMs)];
  if (tmp) parts.push(startupLockReport(tmp, spawnedAtMs));
  if (pid) parts.push(processReport(pid, { proc }));
  return parts.filter(Boolean).join("\n");
}

/** The machine's counters a sample compares with the previous one; null where not offered. */
export type MachineCounters = {
  /** CPU time stolen by the hypervisor, summed over all CPUs (/proc/stat). */
  stealSeconds: number | null;
  /** CPU time idle while I/O was outstanding, summed over all CPUs (/proc/stat). */
  iowaitSeconds: number | null;
  /** Pressure stall time, "some" (at least one task stalled), from /proc/pressure (PSI). */
  stallSeconds: { cpu: number; io: number; memory: number } | null;
};

const PRESSURE = ["cpu", "io", "memory"] as const;

/** The machine's CPU steal and iowait and its pressure stall totals, read without privileges. */
export function readMachine({ proc = "/proc" }: { proc?: string } = {}): MachineCounters {
  let stealSeconds: number | null = null;
  let iowaitSeconds: number | null = null;
  try {
    // cpu user nice system idle iowait irq softirq steal ...
    const f = readFileSync(join(proc, "stat"), "utf8").split("\n")[0]!.trim().split(/\s+/);
    if (f[0] === "cpu" && f.length >= 9) {
      iowaitSeconds = Number(f[5]) / CLOCK_TICKS;
      stealSeconds = Number(f[8]) / CLOCK_TICKS;
    }
  } catch {
    // no /proc (macOS)
  }
  let stallSeconds: MachineCounters["stallSeconds"] = null;
  try {
    const total = (name: string) => {
      const m = /^some .*\btotal=(\d+)/m.exec(readFileSync(join(proc, "pressure", name), "utf8"));
      if (!m) throw new Error(`no "some" line in pressure/${name}`);
      return Number(m[1]) / 1e6;
    };
    const [cpu, io, memory] = PRESSURE.map(total) as [number, number, number];
    stallSeconds = { cpu, io, memory };
  } catch {
    // a kernel without PSI (CONFIG_PSI off, or psi=0)
  }
  return { stealSeconds, iowaitSeconds, stallSeconds };
}

/**
 * What process `pid` has read from storage so far (read_bytes of /proc/<pid>/io: page cache
 * misses, not reads the cache served). The launcher is the browser's parent, which may read it.
 * @returns null where it cannot be read (gone, no /proc, not permitted)
 */
export function readDiskBytes(pid: number, { proc = "/proc" }: { proc?: string } = {}) {
  try {
    const m = /^read_bytes:\s*(\d+)/m.exec(readFileSync(join(proc, String(pid), "io"), "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Bytes as megabytes, one decimal. */
export const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** At most this many samples are listed, the latest ones. */
export const PROBE_MAX_SAMPLES = 60;

/**
 * Issue #901: a sample of start-up about each second, taken by the launcher while it waits for
 * the socket. One snapshot at the timeout cannot tell a main thread that blocked for 25 s
 * (state S, its CPU time flat, the machine idle) from one starved of CPU (state R) or from a
 * machine that stopped as a whole: a paused VM (steal grows, and the harness's own timer comes
 * late, "harness lag") or a disk stall (iowait and the io pressure grow). Each sample lists the
 * main thread's state, CPU time and wait channel, what the browser has read from disk so far,
 * how late the harness's own timer fired, and how much the machine's steal, iowait and pressure stall time grew since the previous sample.
 */
export function startupSampler({
  pid,
  spawnedAtMs,
  proc = "/proc",
  now = Date.now,
  intervalMs = 1000,
  maxSamples = PROBE_MAX_SAMPLES,
}: {
  pid: number | undefined;
  spawnedAtMs: number;
  proc?: string;
  now?: () => number;
  intervalMs?: number;
  maxSamples?: number;
}) {
  const samples: string[] = [];
  let dropped = 0;
  let lastAt = spawnedAtMs;
  let last = readMachine({ proc });
  const delta = (a: number | null, b: number | null) =>
    a === null || b === null ? null : Math.max(0, a - b);
  return {
    sample() {
      const at = now();
      const machine = readMachine({ proc });
      // macOS has no /proc: the harness's lag still shows there
      let main = existsSync(proc) ? "main gone" : "main unknown (no /proc)";
      if (pid) {
        const task = join(proc, String(pid), "task", String(pid));
        const s = readStat(join(task, "stat"));
        if (s) {
          main = `main ${s.state} ${cpu(s.cpuSeconds)} ${readWchan(join(task, "wchan"))}`;
          const read = readDiskBytes(pid, { proc });
          if (read !== null) main += `  disk read ${megabytes(read)}`;
        }
      }
      const lag = Math.max(0, at - lastAt - intervalMs) / 1000;
      const parts = [`  ${secs(at - spawnedAtMs)}  ${main}`, `harness lag ${lag.toFixed(1)} s`];
      const steal = delta(machine.stealSeconds, last.stealSeconds);
      const iowait = delta(machine.iowaitSeconds, last.iowaitSeconds);
      if (steal !== null) parts.push(`steal ${steal.toFixed(2)} s`);
      if (iowait !== null) parts.push(`iowait ${iowait.toFixed(2)} s`);
      const stall = machine.stallSeconds;
      const stallBefore = last.stallSeconds;
      if (stall && stallBefore) {
        const stalls = PRESSURE.map(
          (k) => `${k} ${(delta(stall[k], stallBefore[k]) as number).toFixed(2)}`,
        );
        parts.push(`stall ${stalls.join(" ")} s`);
      }
      samples.push(parts.join("  "));
      if (samples.length > maxSamples) {
        samples.shift();
        dropped++;
      }
      lastAt = at;
      last = machine;
    },
    format(): string {
      if (!samples.length) return "start-up samples: none yet";
      return [
        "start-up samples about each second since spawn (the main thread's state, CPU time and " +
          "wait channel; what the browser read from disk so far; how late the harness's own timer fired; the machine's CPU steal and " +
          "iowait over all CPUs and its pressure stall time since the previous sample" +
          `${dropped ? `; ${dropped} earlier samples dropped` : ""}):`,
        ...samples,
      ].join("\n");
    },
  };
}
