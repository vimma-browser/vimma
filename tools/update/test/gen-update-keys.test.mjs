// docs/specs/m6a-updater.md "Delivery" (sub-PR 2) and decision 39: the manifest check's pinned
// keys (packages/vimma-core/src/update-keys.mjs) are generated from the certificates Firefox's
// updater embeds (src/toolkit/mozapps/update/updater/vimma/*.der), so the two verifiers trust
// the same keys from one source. Keys and certificates are generated in the test.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  CERT_DIR,
  UPDATE_KEYS_FILE,
  readCertificates,
  renderUpdateKeys,
} from "../gen-update-keys.mjs";
import { spkiKeyId } from "../../../packages/vimma-core/src/updates.mjs";

const SCRIPT = new URL("../gen-update-keys.mjs", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * A self-signed RSA-4096 certificate made with openssl, as the offline ceremony makes the
 * secondary (docs/runbook.md step 4).
 * @param {string} dir
 * @param {string} file
 * @param {string} cn
 */
function certificate(dir, file, cn) {
  const key = join(dir, `${file}.key.pem`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
  writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }));
  execFileSync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    key,
    "-sha384",
    "-days",
    "1",
    "-subj",
    `/CN=${cn}`,
    "-outform",
    "DER",
    "-out",
    join(dir, file),
  ]);
  return new Uint8Array(readFileSync(join(dir, file)));
}

/** Imports a generated module from a file and returns its UPDATE_KEYS. */
async function load(/** @type {string} */ text) {
  const dir = tempDir("vimma-update-keys-mod-");
  const file = join(dir, "update-keys.mjs");
  writeFileSync(file, text);
  return (await import(file)).UPDATE_KEYS;
}

const spkiB64 = (/** @type {Uint8Array} */ cert) =>
  Buffer.from(
    execFileSync("openssl", ["x509", "-inform", "DER", "-noout", "-pubkey"], { input: cert }),
  )
    .toString()
    .replace(/-----[A-Z ]+-----|\s/g, "");

describe("gen-update-keys: update-keys.mjs from the updater's certificates", () => {
  it("pins the primary once when the secondary slot holds the primary again (decision 39)", async () => {
    const dir = tempDir("vimma-update-keys-");
    const primary = certificate(dir, "primary.der", "Vimma update signing primary");
    writeFileSync(join(dir, "secondary.der"), primary);
    const text = await renderUpdateKeys(readCertificates(dir));
    const keys = await load(text);
    const spki = spkiB64(primary);
    const id = await spkiKeyId(crypto.subtle, Buffer.from(spki, "base64"));
    expect(keys).toEqual([{ id, slot: "primary", spki }]);
    expect(Object.isFrozen(keys) && Object.isFrozen(keys[0])).toBe(true);
    expect(text).toContain("npm run gen-update-keys");
  }, 60_000);

  it("pins both when the secondary is a key of its own", async () => {
    const dir = tempDir("vimma-update-keys-");
    const primary = certificate(dir, "primary.der", "Vimma update signing primary");
    const secondary = certificate(dir, "secondary.der", "Vimma update signing secondary");
    const keys = await load(await renderUpdateKeys(readCertificates(dir)));
    expect(keys.map((/** @type {{ slot: string }} */ k) => k.slot)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(keys[0].spki).toBe(spkiB64(primary));
    expect(keys[1].spki).toBe(spkiB64(secondary));
  }, 60_000);

  it("refuses a missing slot, a key that is not RSA-4096 and a file that is not a certificate", () => {
    const dir = tempDir("vimma-update-keys-");
    certificate(dir, "primary.der", "Vimma update signing primary");
    expect(() => readCertificates(dir)).toThrow(/secondary\.der/);
    const small = join(dir, "small.key.pem");
    writeFileSync(
      small,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
    );
    execFileSync("openssl", [
      "req",
      "-new",
      "-x509",
      "-key",
      small,
      "-subj",
      "/CN=small",
      "-outform",
      "DER",
      "-out",
      join(dir, "secondary.der"),
    ]);
    expect(() => readCertificates(dir)).toThrow(/RSA-4096/);
    writeFileSync(join(dir, "secondary.der"), "not a certificate");
    expect(() => readCertificates(dir)).toThrow(/secondary\.der/);
  }, 60_000);

  it("--check fails when update-keys.mjs differs from what the certificates give", async () => {
    const dir = tempDir("vimma-update-keys-");
    const primary = certificate(dir, "primary.der", "Vimma update signing primary");
    writeFileSync(join(dir, "secondary.der"), primary);
    const out = join(dir, "update-keys.mjs");
    const run = (/** @type {string[]} */ args) =>
      execFileSync(process.execPath, [SCRIPT, "--certs", dir, "--out", out, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });
    run([]);
    expect(run(["--check"])).toContain("up to date");
    writeFileSync(out, readFileSync(out, "utf8").replace(/"[A-Za-z0-9+/]{10}/, '"AAAAAAAAAA'));
    expect(() => run(["--check"])).toThrow(/gen-update-keys/);
  }, 60_000);

  it("the repository: update-keys.mjs is what the committed certificates give", async () => {
    const certs = join(ROOT, CERT_DIR);
    if (!existsSync(join(certs, "primary.der"))) {
      // Until the KMS-signed primary certificate is committed (docs/runbook.md step 5b), no
      // updater can be built: configs/common/mozconfig refuses VIMMA_UPDATES=1 without it
      // (mozconfig-updater.test.mjs), so there is no second verifier to disagree with. The
      // manifest check pins the primary by hand until then (updates.test.mjs).
      expect(existsSync(join(certs, "secondary.der"))).toBe(false);
      return;
    }
    const expected = await renderUpdateKeys(readCertificates(certs));
    expect(readFileSync(join(ROOT, UPDATE_KEYS_FILE), "utf8")).toBe(expected);
    const sha = createHash("sha256")
      .update(readFileSync(join(certs, "primary.der")))
      .digest("hex");
    expect(readFileSync(join(ROOT, "docs/runbook.md"), "utf8")).toContain(sha);
  }, 60_000);
});
