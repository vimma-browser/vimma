import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { fakeSign, fakeSignature, withFakeGpgv } from "./fake-gpgv.mjs";

// tools/upstream/verify-source.sh (`npm run verify-source`): checks the tarball a local
// `npx surfer download` left in .surfer/engine/ against Mozilla's signed SHA512SUMS (spec
// build-supply-chain, B1), since Surfer checks nothing. The archive is a file:// directory; gpgv
// is a stub (fake-gpgv.mjs). No network.
const SCRIPT = fileURLToPath(new URL("../verify-source.sh", import.meta.url));
const VERSION = "158.0";
const NAME = `source/firefox-${VERSION}.source.tar.xz`;

const MARKER = join("engine", ".git", "vimma-source-verified");

/**
 * A checkout after `npx surfer download` (engine/ with its own repository) and an archive.
 * @param {{ tarball?: string | null, signature?: "good" | "bad", engine?: boolean }} [opts]
 */
function prepare(opts = {}) {
  const root = tempDir("verify-source-");
  const dir = join(root, "releases", VERSION);
  mkdirSync(dir, { recursive: true });
  const genuine = "genuine tarball bytes\n";
  const hash = createHash("sha512").update(genuine).digest("hex");
  writeFileSync(join(dir, "SHA512SUMS"), `${"0".repeat(128)}  other\n${hash}  ${NAME}\n`);
  if ((opts.signature ?? "good") === "good") fakeSign(join(dir, "SHA512SUMS"));
  else {
    // A signature packet over other bytes: gpgv itself answers BADSIG.
    writeFileSync(join(dir, "SHA512SUMS.asc"), fakeSignature("other bytes"));
  }
  const work = join(root, "checkout");
  mkdirSync(join(work, ".surfer", "engine"), { recursive: true });
  writeFileSync(
    join(work, "surfer.json"),
    JSON.stringify({ version: { product: "firefox", version: VERSION } }),
  );
  const tarball = opts.tarball === undefined ? genuine : opts.tarball;
  if (tarball !== null) {
    writeFileSync(join(work, ".surfer", "engine", `firefox-${VERSION}.source.tar.xz`), tarball);
  }
  if (opts.engine ?? true) mkdirSync(join(work, "engine", ".git"), { recursive: true });
  const env = withFakeGpgv({
    ...process.env,
    MOZILLA_RELEASES: `file://${join(root, "releases")}`,
  });
  /** @param {string[]} args */
  const run = (...args) =>
    spawnSync("bash", [SCRIPT, ...args], { cwd: work, env, encoding: "utf8" });
  return { work, hash, run };
}

/** @param {Parameters<typeof prepare>[0]} [opts] */
const setup = (opts) => prepare(opts).run();

describe("verify-source.sh", () => {
  it("passes the tarball surfer download left when Mozilla's signed SHA512SUMS lists it", () => {
    const r = setup();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${NAME} matches`);
  });

  it("fails a tampered tarball", () => {
    const r = setup({ tarball: "evil bytes\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SHA-512 mismatch/);
  });

  it("fails when SHA512SUMS is not signed by Mozilla's release key", () => {
    const r = setup({ signature: "bad" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not signed by Mozilla's release key/);
  });

  it("fails when there is no tarball to check", () => {
    const r = setup({ tarball: null });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/npx surfer download/);
  });

  it("records the verified version in engine/'s repository, where a lane copy keeps it", () => {
    const { work, hash, run } = prepare();
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(work, MARKER), "utf8")).toBe(`${VERSION} ${hash}\n`);
  });

  it("records nothing when the check fails", () => {
    const { work, run } = prepare({ tarball: "evil bytes\n" });
    expect(run().status).toBe(1);
    expect(existsSync(join(work, MARKER))).toBe(false);
  });

  it("--require passes an engine/ verified for surfer.json's version, offline", () => {
    const { work, run } = prepare({ signature: "bad" });
    writeFileSync(join(work, MARKER), `${VERSION} ${"a".repeat(128)}\n`);
    // A bad signature in the archive does not matter: --require reads nothing from it.
    const r = run("--require");
    expect(r.status, r.stderr).toBe(0);
  });

  it("--require refuses an engine/ never verified, or verified for another version", () => {
    const { work, run } = prepare();
    let r = run("--require");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npm run verify-source/);
    writeFileSync(join(work, MARKER), `157.0.1 ${"a".repeat(128)}\n`);
    r = run("--require");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/157\.0\.1/);
  });

  it("--require refuses when there is no engine/", () => {
    const r = prepare({ engine: false }).run("--require");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npx surfer download/);
  });
});
