/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #1033: tools/ci/memory-watch.sh runs beside `surfer build` in nightly.yml and
// release.yml. It logs memory and disk each minute, warns (rate-limited) when memory runs low,
// swap fills or the kernel's OOM killer kills, and asks the OOM killer to spare the runner agent.
// Here it reads a fake /proc and runs fake sudo, pgrep, choom, free, df and dmesg from PATH.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
 * A fake /proc and a bin dir of fakes; `calls` collects every fake's arguments.
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
  fake("pgrep", "echo 101; echo 102");
  fake("choom", "true");
  fake("free", 'echo "Mem:  15995  15000  200"; echo "Swap: 16383  12000  4383"');
  fake(
    "df",
    'echo "Filesystem Size Used Avail Use% Mounted on"; echo "/dev/root 145G 90G 55G 63% /"',
  );
  fake("dmesg", 'echo "[3600.1] Out of memory: Killed process 4242 (rustc) total-vm:9000000kB"');
  return { proc, bin, calls, dir };
}

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

  it("asks the OOM killer to spare the runner agent, once, through sudo -n", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    await run(f, { MEMORY_WATCH_TICKS: "2" });
    const calls = readFileSync(f.calls, "utf8").split("\n");
    expect(calls.filter((c) => c.startsWith("pgrep "))).toEqual([
      "pgrep -f Runner\\.(Listener|Worker)",
    ]);
    expect(calls.filter((c) => c.startsWith("choom "))).toEqual([
      "choom -n -1000 -p 101",
      "choom -n -1000 -p 102",
    ]);
    expect(calls).toContain("sudo -n choom -n -1000 -p 101");
  });

  it("keeps watching when sudo, choom or pgrep fail", async () => {
    const f = fixture(meminfo(8 * GB, 16 * GB, 16 * GB));
    writeFileSync(
      join(f.bin, "sudo"),
      "#!/usr/bin/env bash\necho 'sudo: a password is required' >&2\nexit 1\n",
    );
    const { out, code } = await run(f, { MEMORY_WATCH_TICKS: "2" });
    expect(code).toBe(0);
    expect(out.match(/^memory-watch: minute \d+/gm)).toHaveLength(2);
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
        MEMORY_WATCH_INTERVAL: "30",
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    child.kill("SIGTERM");
    await new Promise((r) => child.on("close", r));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
