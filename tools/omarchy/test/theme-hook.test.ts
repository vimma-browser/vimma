// The Omarchy theme-set hook (spec m5-omarchy-theme, "Instant reload"). omarchy-hook runs every
// file in ~/.config/omarchy/hooks/theme-set.d/ as `bash <file> <theme-name>`; this runs ours the
// same way with fake busctl, vimma-ctl and vimma binaries, in a temporary directory, never the
// user's ~/.config or session bus.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = fileURLToPath(
  new URL("../../../src/browser/base/content/vimma/omarchy/vimma-theme-reload.sh", import.meta.url),
);

/** Two running Vimma profiles, plus other Gecko apps that must not be asked. */
const BUS_NAMES = [
  "org.mozilla.vimma.L2hvbWUvYS9wcm9maWxl 100 vimma juuso :1.10 user@1000.service - -",
  "org.mozilla.firefox.L2hvbWUvYi9wcm9maWxl 101 firefox juuso :1.11 user@1000.service - -",
  "org.mozilla.zen.L2hvbWUvYy9wcm9maWxl 102 zen juuso :1.12 user@1000.service - -",
  "org.mozilla.vimma.L3RtcC9w 103 vimma juuso :1.13 user@1000.service - -",
  "org.freedesktop.Notifications 104 mako juuso :1.14 user@1000.service - -",
];

/** @type {string} */
let dir;
/** @type {string} */
let bin;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vimma-theme-hook-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A fake program in `bin` that appends its arguments, one per line and a blank line after, to
 * `<dir>/<name>.calls`, prints noise on both streams and exits with `code`.
 * @param {string} name
 * @param {number} code
 * @param {string} [stdout]  printed instead of the noise
 */
function fake(name, code, stdout) {
  const path = join(bin, name);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/${name}.calls"\necho >> "${dir}/${name}.calls"\n` +
      (stdout === undefined ? "echo noise; echo err >&2\n" : `cat <<'EOF'\n${stdout}\nEOF\n`) +
      `exit ${code}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake busctl: `list` prints `names`, `call` records and exits with `callCode`.
 * @param {string[]} names
 * @param {number} [callCode]
 */
function fakeBusctl(names, callCode = 0) {
  const path = join(bin, "busctl");
  const list = names.join("\n");
  writeFileSync(
    path,
    `#!/bin/bash
printf '%s\\n' "$@" >> "${dir}/busctl.calls"; echo >> "${dir}/busctl.calls"
for a in "$@"; do
  if [[ $a == list ]]; then cat <<'EOF'
${list}
EOF
    exit 0; fi
  if [[ $a == call ]]; then echo noise; echo err >&2; exit ${callCode}; fi
done
exit 1
`,
  );
  chmodSync(path, 0o755);
}

/**
 * @param {Record<string, string>} [env]
 * @param {string[]} [args]  what omarchy-hook passes: the theme name
 */
function runHook(env = {}, args = ["tokyo-night"]) {
  return spawnSync("/bin/bash", [HOOK, ...args], {
    env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, ...env },
    encoding: "utf8",
    timeout: 10000,
  });
}

/** @param {string} name  each call's argument list */
function calls(name) {
  const file = join(dir, `${name}.calls`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n\n")
    .filter(Boolean)
    .map((c) => c.split("\n"));
}

/**
 * nsUnixRemoteServer::HandleCommandLine's buffer, decoded: [argc][offset of each argv]
 * <workingdir>\0<argv[0]>\0<argv[1]>\0..., integers little-endian 32-bit.
 * @param {Buffer} buf
 */
function decode(buf) {
  const argc = buf.readUInt32LE(0);
  const cstr = (/** @type {number} */ at) => buf.toString("latin1", at, buf.indexOf(0, at));
  const argv = [];
  for (let i = 0; i < argc; i++) argv.push(cstr(buf.readUInt32LE(4 * (i + 1))));
  return { argc, workingDir: cstr(4 * (argc + 1)), argv, last: buf[buf.length - 1] };
}

/** The `ay` argument of a recorded `busctl call`: its count, then that many bytes. */
function payload(/** @type {string[]} */ call) {
  const at = call.indexOf("ay");
  const count = Number(call[at + 1]);
  const bytes = call.slice(at + 2, at + 2 + count).map(Number);
  expect(bytes).toHaveLength(count);
  expect(call.length).toBe(at + 2 + count);
  return Buffer.from(bytes);
}

describe("vimma-theme-reload.sh", () => {
  it("asks every running Vimma, over Firefox's D-Bus remoting, to reload its theme", () => {
    fakeBusctl(BUS_NAMES);
    fake("vimma-ctl", 0);
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    const sent = calls("busctl").filter((c) => c.includes("call"));
    expect(sent.map((c) => c[c.indexOf("call") + 1])).toEqual([
      "org.mozilla.vimma.L2hvbWUvYS9wcm9maWxl",
      "org.mozilla.vimma.L3RtcC9w",
    ]);
    for (const c of sent) {
      expect(c).toContain("--user");
      const at = c.indexOf("call");
      expect(c.slice(at + 2, at + 6)).toEqual([
        "/org/mozilla/vimma/Remote",
        "org.mozilla.vimma",
        "OpenURL",
        "ay",
      ]);
      expect(decode(payload(c))).toEqual({
        argc: 2,
        workingDir: "/",
        argv: ["vimma", "-vimma-reload-theme"],
        last: 0,
      });
    }
    expect(calls("vimma-ctl"), "delivered: no fallback").toEqual([]);
  });

  it("never starts Vimma: with none running it does nothing and says nothing", () => {
    fakeBusctl(BUS_NAMES.filter((n) => !n.startsWith("org.mozilla.vimma.")));
    fake("vimma", 0);
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(calls("busctl").filter((c) => c.includes("call"))).toEqual([]);
    expect(calls("vimma")).toEqual([]);
  });

  it("falls back to vimma-ctl when no Vimma answers on D-Bus", () => {
    fakeBusctl([]);
    fake("vimma-ctl", 3);
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(calls("vimma-ctl")).toEqual([["--timeout", "2", "reload-theme"]]);
  });

  it("falls back to vimma-ctl when the D-Bus call fails", () => {
    fakeBusctl(BUS_NAMES, 1);
    fake("vimma-ctl", 0);
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(calls("vimma-ctl")).toEqual([["--timeout", "2", "reload-theme"]]);
  });

  it("uses vimma-ctl alone without busctl, and VIMMA_CTL when set", () => {
    const ctl = fake("vimma-ctl", 0);
    // Only the fakes: no busctl, and vimma-ctl not on PATH.
    const r = runHook({ PATH: join(dir, "empty"), VIMMA_CTL: ctl });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(calls("vimma-ctl")).toEqual([["--timeout", "2", "reload-theme"]]);
  });

  // docs/security.md: the theme name comes from a theme directory anyone can publish. It must
  // never reach Vimma or vimma-ctl as an argument (a flag, a path, a URL).
  it("never passes its arguments on: a hostile theme name changes nothing", () => {
    const hostile = ["-profile /tmp/x", "--remote-debugging-port", "9222", "$(touch pwned)"];
    fakeBusctl(BUS_NAMES);
    let r = runHook({}, hostile);
    expect(r.status).toBe(0);
    for (const c of calls("busctl").filter((c) => c.includes("call"))) {
      expect(decode(payload(c)).argv).toEqual(["vimma", "-vimma-reload-theme"]);
    }
    fakeBusctl([]);
    fake("vimma-ctl", 0);
    r = runHook({}, hostile);
    expect(r.status).toBe(0);
    expect(calls("vimma-ctl")).toEqual([["--timeout", "2", "reload-theme"]]);
    expect(existsSync(join(dir, "pwned")) || existsSync("pwned")).toBe(false);
  });

  it("does nothing without either", () => {
    const r = runHook({ PATH: join(dir, "empty") });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });
});
