/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #1033: tools/ci/memory-watch.sh runs beside `surfer build` in nightly.yml and
// release.yml. It logs memory and disk each minute, warns (rate-limited) when memory runs low,
// swap fills or the kernel's OOM killer kills, and asks the OOM killer to spare the runner agent.
// Here it reads a fake /proc and runs fake sudo, pgrep, choom, free, df and dmesg from PATH.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.ts";

const SCRIPT = fileURLToPath(new URL("../memory-watch.sh", import.meta.url));

const GB = 1024 * 1024; // kB

function meminfo(availableKb: number, swapTotalKb: number, swapFreeKb: number) {
  return [
    `MemTotal:       ${16 * GB} kB`,
    `MemFree:          100000 kB`,
    `MemAvailable:   ${availableKb} kB`,
    `SwapTotal:      ${swapTotalKb} kB`,
    `SwapFree:       ${swapFreeKb} kB`,
    "",
  ].join("\n");
}

/**
 * A fake /proc and a bin dir of fakes; `calls` collects every fake's arguments. The fake /proc
 * holds a process tree: the watch (MEMORY_WATCH_SELF=500) under the step shell (400), under
 * Runner.Worker (300, oom_score_adj 0), under Runner.Listener (200, oom_score_adj 100), under
 * systemd (1); and a decoy (900) whose argv names Runner.Worker but is no ancestor, and an
 * ancestor whose argv names Runner.Listener but runs bash.
 */
function fixture(mem: string, oomKills = 0) {
  const dir = tempDir("vimma-memory-watch-");
  const proc = join(dir, "proc");
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  mkdirSync(proc);
  mkdirSync(bin);
  writeFileSync(join(proc, "meminfo"), mem);
  writeFileSync(join(proc, "vmstat"), `pgfault 1\noom_kill ${oomKills}\n`);
  writeFileSync(calls, "");
  const fake = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\necho "${name} $*" >> '${calls}'\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // sudo -n <command...>: runs the command (a fake too), as a passwordless sudo would.
  fake("sudo", '[ "$1" = -n ] && shift; exec "$@"');
  fake("choom", "true");
  fake("free", 'echo "Mem:  15995  15000  200"; echo "Swap: 16383  12000  4383"');
  fake(
    "df",
    'echo "Filesystem Size Used Avail Use% Mounted on"; echo "/dev/root 145G 90G 55G 63% /"',
  );
  fake("dmesg", 'echo "[3600.1] Out of memory: Killed process 4242 (rustc) total-vm:9000000kB"');
  const pid = (n: number, ppid: number, exe: string, adj: number, argv: string) => {
    const d = join(proc, String(n));
    mkdirSync(d);
    writeFileSync(join(d, "status"), `Name:\tx\nUmask:\t0022\nState:\tS\nPPid:\t${ppid}\n`);
    symlinkSync(exe, join(d, "exe"));
    writeFileSync(join(d, "oom_score_adj"), `${adj}\n`);
    writeFileSync(join(d, "cmdline"), argv.replaceAll(" ", "\0"));
  };
  pid(500, 400, "/usr/bin/bash", 0, "bash tools/ci/memory-watch.sh");
  pid(400, 350, "/usr/bin/bash", 0, "bash -e /home/runner/work/_temp/x.sh Runner.Listener");
  pid(350, 300, "/usr/bin/bash", 0, "bash Runner.Worker");
  pid(300, 200, "/home/runner/actions-runner/bin/Runner.Worker", 0, "Runner.Worker spawnclient");
  pid(200, 1, "/home/runner/actions-runner/bin/Runner.Listener", 100, "Runner.Listener run");
  pid(1, 0, "/usr/lib/systemd/systemd", 0, "/sbin/init");
  pid(900, 1, "/usr/bin/sleep", 0, "sleep 99 Runner.Worker");
  return { proc, bin, calls, dir };
}

const choomCalls = (f: ReturnType<typeof fixture>) =>
  readFileSync(f.calls, "utf8")
    .split("\n")
    .filter((c) => c.startsWith("choom "));

/**
 * Runs the watch for `ticks` rounds `interval` seconds apart; `during` runs once it started.
 */
function run(
  f: ReturnType<typeof fixture>,
  env: Record<string, string>,
  during?: () => void,
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], {
      env: {
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        MEMORY_WATCH_PROC: f.proc,
        MEMORY_WATCH_SELF: "500",
        MEMORY_WATCH_INTERVAL: "0",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ out, code }));
    during?.();
  });
}

const warnings = (out: string) => out.split("\n").filter((l) => l.startsWith("::warning"));

describe("memory-watch.sh", () => {
  it("logs free -m and df -h / each round and warns on nothing when memory is fine", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    const { out, code } = await run(f, { MEMORY_WATCH_TICKS: "3" });
    expect(code).toBe(0);
    expect(out.match(/^memory-watch: minute \d+/gm)).toHaveLength(3);
    expect(out.match(/^Swap: 16383/gm)).toHaveLength(3);
    expect(out.match(/^\/dev\/root .* \/$/gm)).toHaveLength(3);
    expect(warnings(out)).toEqual([]);
    const calls = readFileSync(f.calls, "utf8");
    expect(calls).toContain("free -m");
    expect(calls).toContain("df -h /");
  });

  it("shields only the Runner.Worker and Runner.Listener it runs under, by their executable", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    const { out } = await run(f, { MEMORY_WATCH_TICKS: "2" });
    // Shielded once at the start, restored once at the end; never the decoy (900) nor the
    // ancestors whose argv only names the runner (400, 350).
    expect(choomCalls(f)).toEqual([
      "choom -n -999 -p 300",
      "choom -n -999 -p 200",
      "choom -n 0 -p 300",
      "choom -n 100 -p 200",
    ]);
    expect(readFileSync(f.calls, "utf8")).toContain("sudo -n choom -n -999 -p 300");
    expect(out).toContain(
      "memory-watch: runner agent 300 (Runner.Worker): oom_score_adj -999, was 0",
    );
    expect(out).toContain(
      "memory-watch: runner agent 200 (Runner.Listener): oom_score_adj -999, was 100",
    );
  });

  it("gives the runner agent its oom_score_adj back on SIGTERM, so later steps are killable", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    const child = spawn("bash", [SCRIPT], {
      env: {
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        MEMORY_WATCH_PROC: f.proc,
        MEMORY_WATCH_SELF: "500",
        MEMORY_WATCH_INTERVAL: "30",
      },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const closed = new Promise((r) => child.on("close", r));
    for (let i = 0; i < 50 && !out.includes("memory-watch: minute 1"); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(choomCalls(f)).toEqual(["choom -n -999 -p 300", "choom -n -999 -p 200"]);
    child.kill("SIGTERM");
    await closed;
    expect(choomCalls(f)).toEqual([
      "choom -n -999 -p 300",
      "choom -n -999 -p 200",
      "choom -n 0 -p 300",
      "choom -n 100 -p 200",
    ]);
  });

  it("restores nothing it did not change", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    writeFileSync(
      join(f.bin, "choom"),
      `#!/usr/bin/env bash\necho "choom $*" >> '${f.calls}'\n[ "$4" = 300 ] || exit 1\n`,
    );
    const { out } = await run(f, { MEMORY_WATCH_TICKS: "1" });
    expect(choomCalls(f)).toEqual([
      "choom -n -999 -p 300",
      "choom -n -999 -p 200",
      "choom -n 0 -p 300",
    ]);
    expect(out).toContain(
      "memory-watch: runner agent 200 (Runner.Listener): could not set oom_score_adj",
    );
  });

  it("keeps watching when sudo or choom fail, or no runner agent is found", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    writeFileSync(
      join(f.bin, "sudo"),
      "#!/usr/bin/env bash\necho 'sudo: a password is required' >&2\nexit 1\n",
    );
    const { out, code } = await run(f, { MEMORY_WATCH_TICKS: "2" });
    expect(code).toBe(0);
    expect(out.match(/^memory-watch: minute \d+/gm)).toHaveLength(2);

    const alone = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    const second = await run(alone, { MEMORY_WATCH_TICKS: "2", MEMORY_WATCH_SELF: "900" });
    expect(second.code).toBe(0);
    expect(choomCalls(alone)).toEqual([]);
    expect(second.out).toContain("memory-watch: no runner agent among this step's ancestors");
  });

  it("warns on low memory and full swap at most once every 5 rounds", async () => {
    const f = fixture(meminfo(800 * 1024, 16 * GB, 4 * GB));
    const { out } = await run(f, { MEMORY_WATCH_TICKS: "12" });
    const w = warnings(out);
    // Rounds 1, 6 and 11.
    expect(w).toHaveLength(3);
    expect(w[0]).toMatch(/^::warning title=Build memory::/);
    expect(w[0]).toContain("800 MB available");
    expect(w[0]).toContain("swap 75% used");
  });

  it("warns on swap over half full alone, and not at exactly half", async () => {
    const half = fixture(meminfo(4 * GB, 16 * GB, 8 * GB));
    expect(warnings((await run(half, { MEMORY_WATCH_TICKS: "1" })).out)).toEqual([]);
    const over = fixture(meminfo(4 * GB, 16 * GB, 8 * GB - 1024));
    const w = warnings((await run(over, { MEMORY_WATCH_TICKS: "1" })).out);
    expect(w).toHaveLength(1);
    expect(w[0]).not.toContain("available");
    expect(w[0]).toContain("swap 50% used");
  });

  it("stops at 10 warnings and says so", async () => {
    const f = fixture(meminfo(500 * 1024, 16 * GB, 16 * GB));
    const { out } = await run(f, { MEMORY_WATCH_TICKS: "30", MEMORY_WATCH_GAP: "1" });
    expect(warnings(out)).toHaveLength(10);
    expect(out).toMatch(/^memory-watch: 10 warnings, no more in this step$/m);
  });

  it("warns at once on a new OOM kill, naming what the kernel killed", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB), 3);
    const { out } = await run(f, { MEMORY_WATCH_TICKS: "15", MEMORY_WATCH_INTERVAL: "0.2" }, () =>
      setTimeout(() => writeFileSync(join(f.proc, "vmstat"), "oom_kill 4\n"), 1000),
    );
    const w = warnings(out);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("OOM killer killed 1 process");
    expect(w[0]).toContain("Killed process 4242 (rustc)");
  });

  it("stops at once on SIGTERM, sleeping or not", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    const started = Date.now();
    const child = spawn("bash", [SCRIPT], {
      env: {
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
        MEMORY_WATCH_PROC: f.proc,
        MEMORY_WATCH_SELF: "500",
        MEMORY_WATCH_INTERVAL: "30",
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    child.kill("SIGTERM");
    await new Promise((r) => child.on("close", r));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
