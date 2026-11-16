// docs/specs/m6a-updater.md §7: release.yml and nightly.yml hand their build's MAR tools (the
// host `mar`, Mozilla's update scripts, signmar with the NSS libraries it loads from beside it,
// and Mozilla's update certificates) to later jobs, packed by tools/update/mar-tools.ts and
// checked to run from the packed directory before they are uploaded. The first public nightly
// packed signmar without its libraries: the workflow's ldd filter compared ldd's absolute paths
// with a relative objdir, matched none of them, and the mar job's signmar then failed to start
// (libmozsqlite3.so not found). A stand-in objdir is compiled here with the system C compiler:
// a signmar linked, with an $ORIGIN run path, to libraries beside it, as Mozilla's is.
//
// Each test starts processes (pack or check, then ldd for each program and library, then signmar
// and mar). Compiling the stand-ins and packing them once for the file keeps each test to that:
// compiling them again in every test took them past vitest's 5 s with every CPU busy (#1084).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.ts";
import { librariesIn, missingIn } from "../mar-tools.ts";
import { OBJ, PACKED, cc, compileStandIns, fakeTree } from "./fake-objdir.ts";

const SCRIPT = fileURLToPath(new URL("../mar-tools.ts", import.meta.url));

const run = (cwd: string, args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LD_LIBRARY_PATH: "" },
  });

const LINUX = process.platform === "linux";

/** compileStandIns' files, and the ones single tests swap in. */
let standIns = "";
// Ten compiler runs, the file's one irreducible cost: on a loaded machine (every CPU busy) they
// take several seconds, more than a hook's default 10 s leaves room for.
beforeAll(() => {
  if (!LINUX) return;
  standIns = mkdtempSync(join(tmpdir(), "vimma-mar-tools-cc-"));
  compileStandIns(standIns);
  cc(join(standIns, "signmar-without-nss"), "int main(void) { return 0; }\n");
  cc(join(standIns, "libnssdbm3.so"), "int libnssdbm3_so(void) { return 0; }\n", [
    "-shared",
    "-fPIC",
  ]);
  // Linked as -lnssdbm3, so it needs libnssdbm3.so whatever its own file is called.
  cc(join(standIns, "freebl-with-nssdbm3.so"), "int libfreeblpriv3_so(void) { return 0; }\n", [
    "-shared",
    "-fPIC",
    `-L${standIns}`,
    "-lnssdbm3",
  ]);
}, 30_000);
afterAll(() => {
  if (standIns) rmSync(standIns, { recursive: true, force: true });
});

describe("mar-tools.ts: reading ldd", () => {
  const LDD = [
    "\tlinux-vdso.so.1 (0x00007ffd4b1f6000)",
    "\tlibnss3.so => /home/runner/work/vimma/vimma/engine/obj/dist/bin/libnss3.so (0x00007f1)",
    "\tlibmozsqlite3.so => /home/runner/work/vimma/vimma/engine/obj/dist/bin/libmozsqlite3.so (0x00007f2)",
    "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f3)",
    "\tlibgone.so => not found",
    "\t/lib64/ld-linux-x86-64.so.2 (0x00007f4)",
  ].join("\n");

  it("lists every library ldd resolved, by name and path", () => {
    expect(librariesIn(LDD)).toEqual([
      { name: "libnss3.so", path: "/home/runner/work/vimma/vimma/engine/obj/dist/bin/libnss3.so" },
      {
        name: "libmozsqlite3.so",
        path: "/home/runner/work/vimma/vimma/engine/obj/dist/bin/libmozsqlite3.so",
      },
      { name: "libc.so.6", path: "/lib/x86_64-linux-gnu/libc.so.6" },
    ]);
  });

  it("lists the libraries ldd did not find", () => {
    expect(missingIn(LDD)).toEqual(["libgone.so"]);
    expect(missingIn("\tlibc.so.6 => /lib/libc.so.6 (0x1)\n")).toEqual([]);
  });
});

// ldd, ELF and $ORIGIN run paths: Linux, where the nightly and the release build their MAR tools.
describe.skipIf(process.platform !== "linux")("mar-tools.ts pack", () => {
  it("packs signmar's libraries from a relative objdir, which ldd names by absolute path", () => {
    const root = tempDir("vimma-mar-tools-");
    fakeTree(root, standIns);
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readdirSync(join(root, "mar-tools")).sort()).toEqual(PACKED);
    expect(readdirSync(join(root, "mar-tools/mozilla-certs")).sort()).toEqual([
      "release_primary.der",
      "release_secondary.der",
    ]);
    expect(r.stdout).toContain("mar-tools: signmar and mar start with the packed libraries");
  });

  it("packs from an absolute objdir, as release.yml's MOZ_OBJDIR is", () => {
    const root = tempDir("vimma-mar-tools-");
    const { obj } = fakeTree(root, standIns);
    const r = run(root, ["pack", "--objdir", obj, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, "mar-tools")).sort()).toEqual(PACKED);
  });

  it("starts from an empty directory: nothing an earlier pack left stays", () => {
    const root = tempDir("vimma-mar-tools-");
    fakeTree(root, standIns);
    mkdirSync(join(root, "mar-tools"));
    writeFileSync(join(root, "mar-tools/stale.so"), "");
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, "mar-tools/stale.so"))).toBe(false);
  });

  it("fails when signmar needs a library that the objdir does not have", () => {
    const root = tempDir("vimma-mar-tools-");
    const { bin, built } = fakeTree(root, standIns);
    rmSync(join(bin, "libmozsqlite3.so"));
    rmSync(join(built, "libmozsqlite3.so"));
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("libmozsqlite3.so");
  });

  it("fails when ldd names no NSS library of the objdir: signmar would not verify anything", () => {
    const root = tempDir("vimma-mar-tools-");
    const { obj } = fakeTree(root, standIns);
    copyFileSync(join(standIns, "signmar-without-nss"), join(obj, "dist/bin/signmar"));
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("libnss3.so");
  });

  it("packs what a library NSS opens itself loads from the objdir, though signmar does not", () => {
    const root = tempDir("vimma-mar-tools-");
    const { bin, built } = fakeTree(root, standIns);
    copyFileSync(join(standIns, "libnssdbm3.so"), join(built, "libnssdbm3.so"));
    symlinkSync(join(built, "libnssdbm3.so"), join(bin, "libnssdbm3.so"));
    // Over the object dist/bin's symlink points to, which stays.
    copyFileSync(join(standIns, "freebl-with-nssdbm3.so"), join(built, "libfreeblpriv3.so"));
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, "mar-tools"))).toContain("libnssdbm3.so");
  });

  it.each([".", "..", ""])("refuses to empty --out %j, the checkout or above it", (out) => {
    const root = tempDir("vimma-mar-tools-");
    fakeTree(root, standIns);
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", out]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(root, "engine"))).toBe(true);
  });

  it("fails when a tool is missing", () => {
    const root = tempDir("vimma-mar-tools-");
    const { obj } = fakeTree(root, standIns);
    rmSync(join(obj, "dist/host/bin/mar"));
    const r = run(root, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("mar");
  });
});

describe.skipIf(process.platform !== "linux")("mar-tools.ts check", () => {
  /** A checkout whose mar-tools pack made from the stand-in tree; tests change copies of it. */
  let base = "";
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "vimma-mar-tools-packed-"));
    fakeTree(base, standIns);
    const r = run(base, ["pack", "--objdir", OBJ, "--engine", "engine", "--out", "mar-tools"]);
    expect(r.status, r.stderr).toBe(0);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** A fresh copy of the packed directory, for a test to change. */
  function packed() {
    const root = tempDir("vimma-mar-tools-");
    cpSync(join(base, "mar-tools"), join(root, "mar-tools"), { recursive: true });
    return root;
  }

  it("passes a complete directory", () => {
    const root = packed();
    const r = run(root, ["check", "--dir", "mar-tools"]);
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails, naming it, when a library signmar loads is missing", () => {
    const root = packed();
    rmSync(join(root, "mar-tools/libmozsqlite3.so"));
    const r = run(root, ["check", "--dir", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("libmozsqlite3.so");
  });

  it("fails when a library NSS opens itself at startup is missing", () => {
    const root = packed();
    rmSync(join(root, "mar-tools/libsoftokn3.so"));
    const r = run(root, ["check", "--dir", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("libsoftokn3.so");
  });

  it("fails when a tool does not start", () => {
    const root = packed();
    writeFileSync(join(root, "mar-tools/mar"), "not a program");
    chmodSync(join(root, "mar-tools/mar"), 0o755);
    const r = run(root, ["check", "--dir", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("mar");
  });

  it("fails without Mozilla's update certificates", () => {
    const root = packed();
    rmSync(join(root, "mar-tools/mozilla-certs"), { recursive: true });
    const r = run(root, ["check", "--dir", "mar-tools"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("mozilla-certs");
  });
});
