// docs/specs/m6a-updater.md "Delivery" (sub-PR 2): Vimma's update certificates are binary DER
// files, which `surfer license-check` (it reads every file under src/ for an MPL header) cannot
// accept, so they live in configs/updater/ and `npm run import` links them to the path the
// updater's moz-build.patch reads.
import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_CERT_DIR, linkUpdateCerts } from "../link-update-certs.mjs";
import { CERT_DIR } from "../../update/gen-update-keys.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SLOTS = ["primary.der", "secondary.der"];

/** Every file under `dir`, relative to it. @param {string} dir @returns {string[]} */
function walk(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** A repository with certificates and an engine/ with the .gitignore surfer import keeps. */
function fixture() {
  const root = tempDir("vimma-link-certs-");
  mkdirSync(join(root, CERT_DIR), { recursive: true });
  for (const f of SLOTS) writeFileSync(join(root, CERT_DIR, f), `${f}-bytes`);
  mkdirSync(join(root, "engine"));
  writeFileSync(join(root, "engine/.gitignore"), "obj-*\n");
  return { root, engine: join(root, "engine") };
}

describe("the update certificates' location", () => {
  it("is outside src/, which surfer license-check reads as text", () => {
    expect(CERT_DIR.startsWith("src/")).toBe(false);
    expect(walk(join(ROOT, "src")).filter((f) => f.endsWith(".der"))).toEqual([]);
    for (const f of SLOTS) expect(lstatSync(join(ROOT, CERT_DIR, f)).isFile()).toBe(true);
  });

  it("is where the updater's moz-build.patch and the mozconfig guard read from in engine/", () => {
    const patch = readFileSync(
      join(ROOT, "src/toolkit/mozapps/update/updater/moz-build.patch"),
      "utf8",
    );
    // moz.build's inputs are relative to its own directory, toolkit/mozapps/update/updater.
    expect(ENGINE_CERT_DIR).toBe("toolkit/mozapps/update/updater/vimma");
    for (const f of SLOTS) expect(patch).toContain(`.inputs += ["vimma/${f}"]`);
    const mozconfig = readFileSync(join(ROOT, "configs/common/mozconfig"), "utf8");
    expect(mozconfig).toContain(`$topsrcdir/${ENGINE_CERT_DIR}/$_vimma_cert`);
  });

  it("is linked by npm run import, after surfer import", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.import).toMatch(
      /surfer import && node tools\/import\/link-update-certs\.mjs &&/,
    );
  });
});

describe("linkUpdateCerts", () => {
  it("links both certificates into the engine and ignores them in its git", () => {
    const { root, engine } = fixture();
    linkUpdateCerts(root, engine);
    for (const f of SLOTS) {
      const link = join(engine, ENGINE_CERT_DIR, f);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(root, CERT_DIR, f));
      expect(readFileSync(link, "utf8")).toBe(`${f}-bytes`);
    }
    const ignore = readFileSync(join(engine, ".gitignore"), "utf8").split("\n");
    for (const f of SLOTS) expect(ignore).toContain(`${ENGINE_CERT_DIR}/${f}`);
  });

  it("runs again without change, and replaces a link left by an older import", () => {
    const { root, engine } = fixture();
    mkdirSync(join(engine, ENGINE_CERT_DIR), { recursive: true });
    // The certificates' old place, src/…/vimma/, which surfer import linked: now dangling.
    symlinkSync(join(root, "src/gone/primary.der"), join(engine, ENGINE_CERT_DIR, "primary.der"));
    writeFileSync(join(engine, ENGINE_CERT_DIR, "secondary.der"), "a stale copy");
    linkUpdateCerts(root, engine);
    linkUpdateCerts(root, engine);
    for (const f of SLOTS) {
      expect(readFileSync(join(engine, ENGINE_CERT_DIR, f), "utf8")).toBe(`${f}-bytes`);
    }
    const ignore = readFileSync(join(engine, ".gitignore"), "utf8").split("\n");
    expect(ignore.filter((l) => l === `${ENGINE_CERT_DIR}/primary.der`)).toHaveLength(1);
  });

  it("refuses a repository without a certificate, so no import leaves a half-set behind", () => {
    const { root, engine } = fixture();
    writeFileSync(join(root, CERT_DIR, "secondary.der"), "");
    expect(() => linkUpdateCerts(root, engine)).toThrow(/secondary\.der/);
    expect(existsSync(join(engine, ENGINE_CERT_DIR, "primary.der"))).toBe(false);
  });

  it("refuses a missing engine/", () => {
    const { root } = fixture();
    expect(() => linkUpdateCerts(root, join(root, "no-engine"))).toThrow(/no-engine/);
  });
});
