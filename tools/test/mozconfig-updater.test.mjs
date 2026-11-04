// docs/specs/m6a-updater.md §3 and "Delivery" (sub-PR 2): configs/common/mozconfig builds
// Firefox's updater in only when VIMMA_UPDATES=1 (the release and nightly jobs), and then only
// with Vimma's own update certificates in the tree. Sources the real file under sh with
// ac_add_options and mk_add_options stubbed, as mach does.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";
import { artifactMozconfig } from "../artifact-build/artifact-build.mjs";

const MOZCONFIG = readFileSync(new URL("../../configs/common/mozconfig", import.meta.url), "utf8");
const CERT_DIR = "toolkit/mozapps/update/updater/vimma";

/**
 * A topsrcdir with the files the mozconfig checks for.
 * @param {{ certs?: string[] }} [opts] the certificate files to create under CERT_DIR
 */
function srcdir({ certs = [] } = {}) {
  const dir = tempDir("vimma-mozconfig-");
  mkdirSync(join(dir, "browser/config/vimma"), { recursive: true });
  for (const f of ["version.txt", "version_display.txt"]) {
    writeFileSync(join(dir, "browser/config/vimma", f), "159.0.1\n");
  }
  mkdirSync(join(dir, CERT_DIR), { recursive: true });
  for (const c of certs) writeFileSync(join(dir, CERT_DIR, c), "der");
  return dir;
}

/**
 * Sources `text` as mach would and returns the ac_add_options it passed.
 * @param {string} text
 * @param {string} topsrcdir
 * @param {Record<string, string>} env
 */
function source(text, topsrcdir, env = {}) {
  const dir = tempDir("vimma-mozconfig-run-");
  const file = join(dir, "mozconfig");
  writeFileSync(file, text);
  const script = [
    "ac_add_options() { printf 'AC %s\\n' \"$*\"; }",
    "mk_add_options() { :; }",
    `. "${file}"`,
  ].join("\n");
  const r = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      topsrcdir,
      VIMMA_SAFEBROWSING_KEYFILE: "",
      ...env,
    },
  });
  const options = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("AC "))
    .map((l) => l.slice(3));
  return { status: r.status, options, stderr: r.stderr };
}

const updaterOptions = (/** @type {string[]} */ options) =>
  options.filter((o) => /^--(enable|disable)-updater\b/.test(o));

describe("configs/common/mozconfig: the updater", () => {
  it("is not built without VIMMA_UPDATES (source and dev builds)", () => {
    const r = source(MOZCONFIG, srcdir());
    expect(r.status).toBe(0);
    expect(updaterOptions(r.options)).toEqual(["--disable-updater"]);
  });

  it("is built with VIMMA_UPDATES=1 when both of Vimma's certificates are in the tree", () => {
    const r = source(MOZCONFIG, srcdir({ certs: ["primary.der", "secondary.der"] }), {
      VIMMA_UPDATES: "1",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(updaterOptions(r.options)).toEqual(["--enable-updater"]);
  });

  it("refuses VIMMA_UPDATES=1 without Vimma's certificates, so no updater trusts Mozilla's test keys", () => {
    for (const certs of [[], ["primary.der"], ["secondary.der"]]) {
      const r = source(MOZCONFIG, srcdir({ certs }), { VIMMA_UPDATES: "1" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`${CERT_DIR}/`);
      expect(r.stderr).toContain("docs/runbook.md");
    }
  });

  it("refuses any other value of VIMMA_UPDATES rather than guessing", () => {
    for (const value of ["0", "yes", "true", "2"]) {
      const r = source(MOZCONFIG, srcdir({ certs: ["primary.der", "secondary.der"] }), {
        VIMMA_UPDATES: value,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("VIMMA_UPDATES");
    }
  });

  it("stays valid shell in the artifact build, which drops --disable-updater (ADR-010)", () => {
    const r = source(artifactMozconfig(MOZCONFIG), srcdir());
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(updaterOptions(r.options)).toEqual([]);
    expect(r.options).toContain("--enable-artifact-builds");
  });
});
