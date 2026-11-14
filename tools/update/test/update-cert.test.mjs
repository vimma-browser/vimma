// docs/specs/m6a-updater.md §6 ("Key ceremony"), decision 39, and
// docs/runbook/ci-update-signing-keys-and-the-update-host.md step 5b: the updater's certificates.
// The primary's private key cannot leave Cloud KMS, so its self-signed certificate is made in two
// steps: tools/update/update-cert.mjs writes the to-be-signed part and its SHA-384 DigestInfo, KMS
// signs that (raw PKCS#1), and the tool assembles and checks the certificate. Here a key generated
// in the test stands in for KMS, signing exactly as it does.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  X509Certificate,
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  SHA384_DIGESTINFO_PREFIX,
  assembleCertificate,
  certificateRequest,
  certificateSpki,
} from "../update-cert.mjs";

const SCRIPT = new URL("../update-cert.mjs", import.meta.url).pathname;

/** A 4096-bit key, as the KMS key and the offline secondary are. */
function rsaKey() {
  return generateKeyPairSync("rsa", { modulusLength: 4096 });
}

/**
 * What `gcloud kms asymmetric-sign` returns for an RSA_SIGN_RAW_PKCS1_4096 key: PKCS#1 v1.5
 * type-1 padding over exactly the bytes sent.
 * @param {import("node:crypto").KeyObject} privateKey
 * @param {Uint8Array} bytes
 */
const kmsSign = (privateKey, bytes) =>
  new Uint8Array(privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, bytes));

const spkiOf = (/** @type {import("node:crypto").KeyObject} */ k) =>
  new Uint8Array(k.export({ type: "spki", format: "der" }));

describe("update-cert: the updater's self-signed certificate", () => {
  it("builds a certificate KMS can sign, which NSS-style parsers and openssl accept", () => {
    const { publicKey, privateKey } = rsaKey();
    const req = certificateRequest(spkiOf(publicKey), "primary");
    expect([...req.digestInfo.slice(0, SHA384_DIGESTINFO_PREFIX.length)]).toEqual([
      ...SHA384_DIGESTINFO_PREFIX,
    ]);
    expect(Buffer.from(req.digestInfo.slice(SHA384_DIGESTINFO_PREFIX.length))).toEqual(
      createHash("sha384").update(req.tbs).digest(),
    );
    const der = assembleCertificate(
      req.tbs,
      kmsSign(privateKey, req.digestInfo),
      spkiOf(publicKey),
    );
    const cert = new X509Certificate(der);
    expect(cert.subject).toBe("CN=Vimma update signing primary");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(publicKey)).toBe(true);
    expect(cert.publicKey.export({ type: "spki", format: "der" })).toEqual(
      publicKey.export({ type: "spki", format: "der" }),
    );
    expect(cert.validTo).toMatch(/9999/);
    expect(certificateSpki(der)).toEqual(spkiOf(publicKey));
    // openssl reads it as a sha384WithRSAEncryption certificate with a good self-signature.
    const dir = tempDir("vimma-update-cert-");
    writeFileSync(join(dir, "c.der"), der);
    const text = execFileSync(
      "openssl",
      ["x509", "-inform", "DER", "-in", join(dir, "c.der"), "-noout", "-text"],
      {
        encoding: "utf8",
      },
    );
    expect(text).toContain("sha384WithRSAEncryption");
    expect(text).toContain("Public-Key: (4096 bit)");
  }, 60_000);

  it("is deterministic, so anyone can rebuild the request from the public key and compare", () => {
    const { publicKey } = rsaKey();
    const a = certificateRequest(spkiOf(publicKey), "primary");
    const b = certificateRequest(spkiOf(publicKey), "primary");
    expect(a.tbs).toEqual(b.tbs);
    expect(certificateRequest(spkiOf(publicKey), "secondary").tbs).not.toEqual(a.tbs);
  }, 60_000);

  it("refuses a signature that is not the key's own over this request", () => {
    const { publicKey, privateKey } = rsaKey();
    const other = rsaKey();
    const req = certificateRequest(spkiOf(publicKey), "primary");
    expect(() =>
      assembleCertificate(req.tbs, kmsSign(other.privateKey, req.digestInfo), spkiOf(publicKey)),
    ).toThrow(/signature/);
    const another = certificateRequest(spkiOf(other.publicKey), "primary");
    expect(() =>
      assembleCertificate(req.tbs, kmsSign(privateKey, another.digestInfo), spkiOf(publicKey)),
    ).toThrow(/signature/);
  }, 60_000);

  it("refuses a key that is not RSA-4096", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => certificateRequest(spkiOf(small.publicKey), "primary")).toThrow(/RSA-4096/);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => certificateRequest(spkiOf(ec.publicKey), "primary")).toThrow(/RSA-4096/);
  }, 60_000);

  it("CLI: request, then assemble with a KMS signature, refusing a key other than the pinned primary", () => {
    const dir = tempDir("vimma-update-cert-cli-");
    const { publicKey, privateKey } = rsaKey();
    writeFileSync(join(dir, "key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    const run = (/** @type {string[]} */ args) =>
      execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" });
    const out = run([
      "request",
      "--public-key",
      join(dir, "key.pem"),
      "--slot",
      "primary",
      "--out-dir",
      dir,
    ]);
    expect(out).toContain("gcloud kms asymmetric-sign");
    const digestInfo = readFileSync(join(dir, "primary.digestinfo.bin"));
    writeFileSync(join(dir, "sig.bin"), kmsSign(privateKey, digestInfo));
    const assemble = [
      "assemble",
      "--dir",
      dir,
      "--slot",
      "primary",
      "--signature",
      join(dir, "sig.bin"),
      "--out",
      join(dir, "primary.der"),
    ];
    // A test key is not the primary update-keys.mjs pins, so the real path refuses it...
    expect(() => run(assemble)).toThrow(/pinned primary/);
    // ...and --any-key (tests and rehearsals with a throwaway key) accepts it.
    run([...assemble, "--any-key"]);
    // A request file that is not the one certificateRequest makes for this key and slot (stale,
    // edited, or another slot's) is refused even when the signature over it verifies.
    const other = certificateRequest(spkiOf(publicKey), "secondary");
    writeFileSync(join(dir, "primary.tbs.der"), other.tbs);
    writeFileSync(join(dir, "sig.bin"), kmsSign(privateKey, other.digestInfo));
    expect(() => run([...assemble, "--any-key"])).toThrow(/request/);
    const cert = new X509Certificate(readFileSync(join(dir, "primary.der")));
    expect(cert.verify(publicKey)).toBe(true);
  }, 60_000);
});
