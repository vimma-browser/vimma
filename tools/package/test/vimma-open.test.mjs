// vimma-open (specs workspace-routing, decision 6, and app-routes, decisions 6 to 10): the
// desktop entry's launcher, and the command `BROWSER=vimma-open` runs. It walks its parent
// processes in /proc, nearest first, keeping every program and shell on the way to the terminal
// or app, and hands `vimma -vimma-from <names> <url>` off in its own session, so the caller never
// waits for the browser. Run here against fake /proc trees and a fake vimma, and once against
// real processes through CPython's `webbrowser`.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("../vimma-open.sh", import.meta.url));

/** @type {string} */
let dir;
/** @type {string} */
let proc;

/**
 * A fake vimma: its arguments one per line, then VIMMA_FROM, written to `calls` in one rename
 * (it runs detached, so the test waits for the file). While `hold` exists it does not exit.
 * @param {string} to
 */
function fakeVimma(to) {
  writeFileSync(
    to,
    `#!/bin/sh
: > "${dir}/calls.tmp"
for a in "$@"; do printf '%s\\n' "$a" >> "${dir}/calls.tmp"; done
printf 'VIMMA_FROM=%s\\n' "\${VIMMA_FROM-unset}" >> "${dir}/calls.tmp"
mv "${dir}/calls.tmp" "${dir}/calls"
while [ -e "${dir}/hold" ]; do sleep 0.05; done
`,
  );
  chmodSync(to, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vimma-open-"));
  proc = join(dir, "proc");
  mkdirSync(proc);
  fakeVimma(join(dir, "vimma"));
});
afterEach(() => {
  rmSync(join(dir, "hold"), { force: true });
  rmSync(dir, { recursive: true, force: true });
});

/** @param {number} ms */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The fake vimma's call, once it has made it (it runs detached from the launcher).
 * @returns {{ args: string[], from: string }}
 */
function waitForCall() {
  const file = join(dir, "calls");
  for (let i = 0; i < 200 && !existsSync(file); i++) pause(25);
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  const from = /** @type {string} */ (lines.pop());
  return { args: lines, from };
}

/**
 * A fake /proc/<pid>: `stat` (with the comm in parentheses, at most 15 bytes, as the kernel
 * writes it), `comm` and, when given, an `exe` link.
 * @param {number} pid
 * @param {string} comm
 * @param {number} ppid
 * @param {string} [exe]
 */
function processEntry(pid, comm, ppid, exe) {
  const d = join(proc, String(pid));
  mkdirSync(d);
  const name = comm.slice(0, 15);
  writeFileSync(join(d, "stat"), `${pid} (${name}) S ${ppid} ${pid} ${pid} 0 -1 4194304 1 0\n`);
  writeFileSync(join(d, "comm"), `${name}\n`);
  if (exe) symlinkSync(exe, join(d, "exe"));
}

/**
 * A chain of processes, farthest first: `chain(1, ["ghostty", "zsh"])` makes ghostty (pid 100,
 * parent 1) and zsh (101, parent 100). Returns the nearest one's pid.
 * @param {number} top  the farthest process's parent
 * @param {string[]} names
 * @param {number} [from]
 */
function chain(top, names, from = 100) {
  let parent = top;
  names.forEach((name, i) => {
    processEntry(from + i, name, parent);
    parent = from + i;
  });
  return parent;
}

/**
 * Runs the launcher as if its parent were `ppid`, and returns the fake vimma's call.
 * @param {string[]} args
 * @param {{ ppid?: number, env?: Record<string, string>, launcher?: string }} [options]
 * @returns {{ args: string[], from: string, status: number | null }}
 */
function run(args, { ppid = 0, env = {}, launcher = LAUNCHER } = {}) {
  rmSync(join(dir, "calls"), { force: true });
  const r = spawnSync("/bin/sh", [launcher, ...args], {
    env: {
      PATH: "/usr/bin:/bin",
      VIMMA_OPEN_PROC: proc,
      VIMMA_OPEN_PPID: String(ppid),
      VIMMA_BIN: join(dir, "vimma"),
      ...env,
    },
    encoding: "utf8",
  });
  return { ...waitForCall(), status: r.status };
}

/**
 * The names a link from `ppid` carries (`-vimma-from`), or null when it carries none.
 * @param {number} ppid
 * @param {Record<string, string>} [env]
 */
function names(ppid, env = {}) {
  const { args, from } = run([LINK], { ppid, env });
  if (args[0] !== "-vimma-from") {
    expect(from).toBe("VIMMA_FROM=unset");
    return null;
  }
  expect(from).toBe(`VIMMA_FROM=${args[1]}`);
  return args[1];
}

const LINK = "https://github.com/vimma-browser/vimma";

describe("vimma-open", () => {
  it("names the app behind xdg-open", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1, "/usr/lib/slack/slack");
    processEntry(200, "xdg-open", 100);
    expect(run([LINK], { ppid: 200 })).toEqual({
      args: ["-vimma-from", "slack", LINK],
      from: "VIMMA_FROM=slack",
      status: 0,
    });
  });

  it("keeps shells: a link nvim opens in a terminal names nvim, its shell and the terminal", () => {
    processEntry(1, "systemd", 0);
    processEntry(300, "alacritty", 1);
    processEntry(310, "nvim", 300);
    processEntry(320, "sh", 310);
    processEntry(330, "xdg-open", 320);
    expect(run([LINK], { ppid: 330 }).args).toEqual(["-vimma-from", "sh,nvim,alacritty", LINK]);
  });

  it("a link typed into a shell names the shell and the terminal", () => {
    processEntry(1, "systemd", 0);
    processEntry(300, "alacritty", 1);
    processEntry(310, "zsh", 300);
    processEntry(320, "xdg-open", 310);
    expect(names(320)).toBe("zsh,alacritty");
  });

  it("keeps shells and collapses duplicates", () => {
    processEntry(1, "systemd", 0);
    const near = chain(1, ["ghostty", "zsh", "herdr", "herdr", "zsh", "zsh", "python3"]);
    expect(names(near)).toBe("python3,zsh,herdr,zsh,ghostty");
  });

  it("skips gio and its launch helper (comm truncated to 15 bytes)", () => {
    processEntry(1, "systemd", 0);
    processEntry(400, "Discord", 1);
    processEntry(410, "gio", 400);
    processEntry(420, "gio-launch-desktop", 410);
    expect(names(420)).toBe("discord");
  });

  it("skips login, open, osascript and the wrappers", () => {
    processEntry(1, "systemd", 0);
    const near = chain(1, ["ghostty", "login", "zsh", "env", "nohup", "timeout", "open"]);
    expect(names(near)).toBe("zsh,ghostty");
    rmSync(proc, { recursive: true });
    mkdirSync(proc);
    processEntry(1, "systemd", 0);
    expect(names(chain(1, ["kitty", "fish", "osascript", "setsid", "xdg-open"]))).toBe(
      "fish,kitty",
    );
  });

  it("stops at the compositor without naming it", () => {
    processEntry(1, "systemd", 0);
    for (const top of ["Hyprland", "sway", "niri", "gnome-shell", "uwsm", "Xwayland"]) {
      rmSync(proc, { recursive: true });
      mkdirSync(proc);
      processEntry(1, "systemd", 0);
      processEntry(50, top, 1);
      expect(names(chain(50, ["ghostty", "zsh"])), top).toBe("zsh,ghostty");
    }
  });

  it("stops at pid 1 and names the app below it", () => {
    processEntry(1, "systemd", 0);
    expect(names(chain(1, ["ghostty", "zsh"]))).toBe("zsh,ghostty");
  });

  it("knows no app behind the portal (a Flatpak app)", () => {
    processEntry(1, "systemd", 0);
    processEntry(500, "xdg-desktop-portal", 1);
    expect(run([LINK], { ppid: 500 })).toEqual({
      args: [LINK],
      from: "VIMMA_FROM=unset",
      status: 0,
    });
  });

  it("stops at systemd --user (uwsm app, app2unit) without naming it", () => {
    processEntry(1, "systemd", 0);
    processEntry(600, "systemd", 1);
    processEntry(610, "sh", 600);
    expect(names(610)).toBe("sh");
  });

  it("knows no app when the parent is gone (reparented to pid 1)", () => {
    processEntry(1, "systemd", 0);
    expect(run([LINK], { ppid: 1 }).args).toEqual([LINK]);
    expect(run([LINK], { ppid: 999 }).args).toEqual([LINK]);
  });

  it("skips the AppImage runtime that started it", () => {
    processEntry(1, "systemd", 0);
    processEntry(700, "slack", 1);
    processEntry(710, "xdg-open", 700);
    processEntry(720, "Vimma-1.0.0-x8", 710, "/opt/apps/Vimma-1.0.0-x86_64.AppImage");
    const r = run([LINK], {
      ppid: 720,
      env: { APPIMAGE: "/opt/apps/Vimma-1.0.0-x86_64.AppImage" },
    });
    expect(r.args).toEqual(["-vimma-from", "slack", LINK]);
  });

  it("a daemonised tmux server ends the list at tmux, whatever its clients", () => {
    processEntry(1, "systemd", 0);
    // The client runs in Ghostty, but the server is pid 1's child: the walk never sees it.
    chain(1, ["ghostty", "zsh", "tmux: client"], 900);
    expect(names(chain(1, ["tmux: server", "zsh", "python3"]))).toBe("python3,zsh,tmux");
  });

  it("a server under systemd --user ends the list too", () => {
    processEntry(1, "systemd", 0);
    processEntry(50, "systemd", 1);
    expect(names(chain(50, ["herdr", "zsh", "az"]))).toBe("az,zsh,herdr");
  });

  it("maps tmux: server to tmux", () => {
    processEntry(1, "systemd", 0);
    expect(names(chain(1, ["tmux: server", "bash"]))).toBe("bash,tmux");
  });

  it("a herdr server still under its client reaches the terminal", () => {
    processEntry(1, "systemd", 0);
    const near = chain(1, ["ghostty", "zsh", "herdr", "herdr", "zsh", "python3"]);
    expect(names(near)).toBe("python3,zsh,herdr,zsh,ghostty");
  });

  it("never runs tmux or herdr", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["tmux", "herdr", "zellij"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\n: > "${dir}/ran-${tool}"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    processEntry(1, "systemd", 0);
    const near = chain(1, ["tmux: server", "herdr", "zellij", "zsh"]);
    expect(names(near, { PATH: `${bin}:/usr/bin:/bin`, TMUX: "/tmp/tmux-1/default,1,0" })).toBe(
      "zsh,zellij,herdr,tmux",
    );
    for (const tool of ["tmux", "herdr", "zellij"]) {
      expect(existsSync(join(dir, `ran-${tool}`)), tool).toBe(false);
    }
  });

  it("adds TERM_PROGRAM last when the walk ends at a name that is not a token", () => {
    processEntry(1, "systemd", 0);
    // VS Code's integrated terminal: the shell's parent is a helper named with spaces.
    const near = chain(1, ["Code Helper (Plugin)", "zsh"]);
    expect(names(near, { TERM_PROGRAM: "vscode" })).toBe("zsh,vscode");
    expect(names(near, { TERM_PROGRAM: "zsh" })).toBe("zsh");
    expect(names(near, { TERM_PROGRAM: "Not A Token" })).toBe("zsh");
  });

  it("a_detached_child_under_an_agent_cli_gets_no_TERM_PROGRAM_name", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "node", 1);
    expect(names(100, { TERM_PROGRAM: "ghostty" })).toBe("node");
  });

  it("never adds TERM_PROGRAM when the walk reached the terminal", () => {
    processEntry(1, "systemd", 0);
    const near = chain(1, ["ghostty", "zsh", "python3"]);
    expect(names(near, { TERM_PROGRAM: "ghostty" })).toBe("python3,zsh,ghostty");
    expect(names(near, { TERM_PROGRAM: "wezterm" })).toBe("python3,zsh,ghostty");
  });

  it("keeps the seven nearest names and the farthest past eight", () => {
    processEntry(1, "systemd", 0);
    const apps = ["ghostty", "a", "b", "c", "d", "e", "f", "g", "h", "i"];
    expect(names(chain(1, apps))).toBe("i,h,g,f,e,d,c,ghostty");
  });

  it("walks at most 32 steps, then adds TERM_PROGRAM within the cap", () => {
    processEntry(1, "systemd", 0);
    const apps = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const near = chain(1, apps);
    // p39 is the nearest; the 32nd step is p8, the last process reached.
    expect(names(near)).toBe("p39,p38,p37,p36,p35,p34,p33,p8");
    expect(names(near, { TERM_PROGRAM: "ghostty" })).toBe("p39,p38,p37,p36,p35,p34,p33,ghostty");
  });

  it("stops on a loop in the tree", () => {
    processEntry(900, "sh", 900);
    expect(names(900)).toBe("sh");
  });

  it("never passes a name that is not a simple token, and keeps the names before it", () => {
    processEntry(1, "systemd", 0);
    for (const [pid, comm] of /** @type {[number, string][]} */ ([
      [800, "My App"],
      [801, "../../etc"],
      [802, "-x"],
      [803, "a;rm -rf ~"],
      [804, "ä"],
      [805, "a,b"],
    ])) {
      processEntry(pid, comm, 1);
      expect(run([LINK], { ppid: pid }).args, comm).toEqual([LINK]);
    }
    processEntry(810, "zsh", 803);
    expect(names(810)).toBe("zsh");
  });

  it("refuses a name with a newline in it", () => {
    processEntry(1, "systemd", 0);
    // comm "slack\nwork": a line-by-line reader would pass "slack".
    const d = join(proc, "810");
    mkdirSync(d);
    writeFileSync(join(d, "stat"), "810 (slack\nwork) S 1 810 810 0 -1 4194304 1 0\n");
    writeFileSync(join(d, "comm"), "slack\nwork\n");
    expect(run([LINK], { ppid: 810 }).args).toEqual([LINK]);
  });

  it("passes anything but one URL through unchanged", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    expect(run([], { ppid: 100 }).args).toEqual([]);
    expect(run(["--new-window", LINK], { ppid: 100 }).args).toEqual(["--new-window", LINK]);
    expect(run([LINK, LINK], { ppid: 100 }).args).toEqual([LINK, LINK]);
  });

  it("refuses a single argument that is a flag: %u must never smuggle one in", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    for (const arg of ["-private-window", "--profile", "-"]) {
      const r = spawnSync("/bin/sh", [LAUNCHER, arg], {
        env: {
          PATH: "/usr/bin:/bin",
          VIMMA_OPEN_PROC: proc,
          VIMMA_OPEN_PPID: "100",
          VIMMA_BIN: join(dir, "vimma"),
        },
        encoding: "utf8",
      });
      expect(r.status, arg).not.toBe(0);
      expect(r.stderr, arg).toMatch(/vimma-open: refusing/);
      pause(100);
      expect(existsSync(join(dir, "calls")), arg).toBe(false);
    }
  });

  it("never passes a VIMMA_FROM it did not set", () => {
    processEntry(1, "systemd", 0);
    processEntry(500, "xdg-desktop-portal", 1);
    expect(run([LINK], { ppid: 500, env: { VIMMA_FROM: "slack" } })).toEqual({
      args: [LINK],
      from: "VIMMA_FROM=unset",
      status: 0,
    });
    expect(run([LINK, LINK], { ppid: 500, env: { VIMMA_FROM: "slack" } }).from).toBe(
      "VIMMA_FROM=unset",
    );
  });

  it("--from names the app and skips the walk", () => {
    processEntry(1, "systemd", 0);
    const near = chain(1, ["ghostty", "zsh"]);
    expect(run(["--from", "teams", LINK], { ppid: near })).toEqual({
      args: ["-vimma-from", "teams", LINK],
      from: "VIMMA_FROM=teams",
      status: 0,
    });
  });

  /**
   * Runs the launcher with `args` and returns its status and stderr, checking that it ran nothing.
   * @param {string[]} args
   */
  function refused(args) {
    const r = spawnSync("/bin/sh", [LAUNCHER, ...args], {
      env: { PATH: "/usr/bin:/bin", VIMMA_OPEN_PROC: proc, VIMMA_BIN: join(dir, "vimma") },
      encoding: "utf8",
    });
    pause(100);
    expect(existsSync(join(dir, "calls")), args.join(" ")).toBe(false);
    return { status: r.status, stderr: r.stderr };
  }

  it("--from refuses a name that is not a token", () => {
    for (const app of ["", "Teams", "a,b", "../x", "-x", "a b", "a".repeat(65), "x\ny"]) {
      const r = refused(["--from", app, LINK]);
      expect(r.status, app).toBe(64);
      expect(r.stderr, app).toMatch(/vimma-open: --from/);
    }
  });

  it("--from refuses a URL that is a flag", () => {
    for (const url of ["-profile", "--remote-debugging-port", "-"]) {
      const r = refused(["--from", "teams", url]);
      expect(r.status, url).toBe(64);
      expect(r.stderr, url).toMatch(/vimma-open: refusing/);
    }
  });

  it("returns before a cold-started vimma exits (setsid)", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    writeFileSync(join(dir, "hold"), "");
    const started = Date.now();
    const r = spawnSync("/bin/sh", [LAUNCHER, LINK], {
      env: {
        PATH: "/usr/bin:/bin",
        VIMMA_OPEN_PROC: proc,
        VIMMA_OPEN_PPID: "100",
        VIMMA_BIN: join(dir, "vimma"),
      },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(waitForCall().args).toEqual(["-vimma-from", "slack", LINK]);
  });

  it("falls back to nohup without setsid, and still returns at once", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["nohup", "mv", "sleep", "cat"]) {
      const at = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
      if (at) symlinkSync(at, join(bin, tool));
    }
    writeFileSync(join(dir, "hold"), "");
    const r = spawnSync("/bin/sh", [LAUNCHER, LINK], {
      env: {
        PATH: bin,
        VIMMA_OPEN_PROC: proc,
        VIMMA_OPEN_PPID: "100",
        VIMMA_BIN: join(dir, "vimma"),
      },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(waitForCall()).toEqual({
      args: ["-vimma-from", "slack", LINK],
      from: "VIMMA_FROM=slack",
    });
  });

  it("inside an AppImage runs vimma in place of itself, so the image stays mounted", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    // The AppImage runtime unmounts the image once AppRun's process exits: a browser handed off
    // in its own session would lose its files.
    const mount = join(dir, "mount");
    mkdirSync(join(mount, "usr/lib/vimma"), { recursive: true });
    const launcher = join(mount, "usr/lib/vimma/vimma-open");
    copyFileSync(LAUNCHER, launcher);
    const fake = join(dir, "vimma-pid");
    writeFileSync(fake, `#!/bin/sh\necho "$$ $*" > "${dir}/pid"\n`);
    chmodSync(fake, 0o755);
    const env = {
      PATH: "/usr/bin:/bin",
      VIMMA_OPEN_PROC: proc,
      VIMMA_OPEN_PPID: "100",
      VIMMA_BIN: fake,
      APPIMAGE: "/opt/apps/Vimma-1.0.0-x86_64.AppImage",
      APPDIR: mount,
    };
    const r = spawnSync("/bin/sh", [launcher, LINK], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(`${r.pid} -vimma-from slack ${LINK}\n`);

    // Another AppImage app's APPIMAGE and APPDIR reach its children: a packaged vimma-open
    // outside that mount still hands off.
    writeFileSync(join(dir, "hold"), "");
    const outside = run([LINK], { ppid: 100, env: { ...env, VIMMA_BIN: join(dir, "vimma") } });
    expect(outside.args).toEqual(["-vimma-from", "slack", LINK]);
  });

  it("a name that is not a token never hides the names beyond it", () => {
    processEntry(1, "systemd", 0);
    // A child of an agent CLI that renamed itself (prctl, a copy named "a b").
    const near = chain(1, ["ghostty", "zsh", "claude", "a b", "xdg-open"]);
    expect(names(near, { TERM_PROGRAM: "ghostty" })).toBe("claude,zsh,ghostty");
    expect(names(near, { TERM_PROGRAM: "x".repeat(65) })).toBe("claude,zsh,ghostty");
  });

  it("runs the vimma next to it when VIMMA_BIN is not set", () => {
    processEntry(1, "systemd", 0);
    processEntry(100, "slack", 1);
    const lib = join(dir, "lib");
    mkdirSync(lib);
    const launcher = join(lib, "vimma-open");
    copyFileSync(LAUNCHER, launcher);
    copyFileSync(join(dir, "vimma"), join(lib, "vimma"));
    chmodSync(join(lib, "vimma"), 0o755);
    rmSync(join(dir, "vimma"));
    const r = spawnSync("/bin/sh", [launcher, LINK], {
      env: { PATH: "/usr/bin:/bin", VIMMA_OPEN_PROC: proc, VIMMA_OPEN_PPID: "100" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(waitForCall()).toEqual({
      args: ["-vimma-from", "slack", LINK],
      from: "VIMMA_FROM=slack",
    });
  });
});

/**
 * Real processes: stub executables named after a terminal, a multiplexer and shells, each
 * running the next as its child, so /proc holds the chain CPython's `webbrowser` runs
 * `vimma-open` from. The farthest stub is named `hyprland`, a stop-list name, so the walk never
 * reaches the test runner's own processes.
 */
const PYTHON = spawnSync("/bin/sh", ["-c", "command -v python3"], {
  encoding: "utf8",
}).stdout.trim();

describe.skipIf(process.platform !== "linux" || !PYTHON)("vimma-open with real processes", () => {
  /**
   * @param {string[]} stubs  farthest first, each a stub that runs the rest of its arguments
   * @param {string[]} command  what the nearest stub runs
   * @param {Record<string, string>} [scripts]  more executables for `bin`, by name
   */
  function runChain(stubs, command, scripts = {}) {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of Object.entries(scripts)) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    for (const name of new Set(stubs)) {
      // Not `exec`, and not the last command either: each stub stays the parent of the next.
      writeFileSync(join(bin, name), `#!/bin/sh\n"$@"\nstatus=$?\nexit $status\n`);
      chmodSync(join(bin, name), 0o755);
    }
    copyFileSync(LAUNCHER, join(bin, "vimma-open"));
    chmodSync(join(bin, "vimma-open"), 0o755);
    writeFileSync(join(dir, "hold"), "");
    return new Promise((resolve) => {
      const child = spawn(
        join(bin, stubs[0]),
        [...stubs.slice(1).map((s) => join(bin, s)), ...command],
        {
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            BROWSER: "vimma-open",
            VIMMA_BIN: join(dir, "vimma"),
          },
        },
      );
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("exit", (status) => resolve({ status, out: out.trim() }));
    });
  }

  it("BROWSER=vimma-open through CPython's webbrowser names the chain", async () => {
    const result = await runChain(
      ["hyprland", "ghostty", "zsh", "herdr", "zsh"],
      [
        PYTHON,
        "-I",
        "-c",
        `import webbrowser; print(webbrowser.get().open(${JSON.stringify(LINK)}))`,
      ],
    );
    // webbrowser waits for vimma-open, which returns while the fake vimma still runs (hold).
    expect(result).toEqual({ status: 0, out: "True" });
    expect(existsSync(join(dir, "hold"))).toBe(true);
    expect(waitForCall()).toEqual({
      args: ["-vimma-from", "python3,zsh,herdr,zsh,ghostty", LINK],
      from: "VIMMA_FROM=python3,zsh,herdr,zsh,ghostty",
    });
  });

  it("a gh-style caller appends the URL to BROWSER and gets the same names", async () => {
    // gh splits BROWSER, appends the URL and waits for the command to exit.
    const gh = `#!/bin/sh\nvimma-open "$1"\nstatus=$?\necho "$status"\nexit 0\n`;
    const result = await runChain(
      ["hyprland", "ghostty", "zsh", "herdr", "zsh"],
      [join(dir, "bin", "gh"), LINK],
      { gh },
    );
    expect(result).toEqual({ status: 0, out: "0" });
    expect(waitForCall().args).toEqual(["-vimma-from", "gh,zsh,herdr,zsh,ghostty", LINK]);
  });
});
