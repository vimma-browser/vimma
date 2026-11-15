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
import { lstatSync, readFileSync, readdirSync } from "node:fs";
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
    lines.push(
      `threads of ${pgid} (state, CPU time, kernel wait channel; main thread first, then the ` +
        `busiest${threads.length > shown.length ? `; ${threads.length - shown.length} more not shown` : ""}):`,
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
export function startupLockReport(tmp: string, spawnedAtMs: number): string {
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
    ...(lockDirs.length
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
  { maxEntries = PROBE_MAX_ENTRIES }: { maxEntries?: number } = {},
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
  return [
    `profile entries by last change, in seconds since spawn${dropped ? ` (${dropped} older not shown)` : ""}:`,
    ...shown.map((e) => `  ${secs(e.ms)}  ${e.label}`),
    phase.endsWith("neither .parentlock nor lock")
      ? "no lock and no .parentlock: the browser never locked this profile"
      : phase,
  ].join("\n");
}

/**
 * Everything above for a browser that has not written its discovery file: the profile's
 * timeline, its TMPDIR's start-up lock (when `tmp` is given), then its processes. `pid` is the browser's (its process group's) pid.
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
