#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The self-signed certificate Firefox's updater embeds for an update key
 * (docs/specs/m6a-updater.md §6, "Key ceremony"; docs/runbook.md, "Update signing keys and the
 * update host", step 5b). The updater reads only the certificate's public key (NSS
 * CERT_NewTempCertificate, then CERT_ExtractPublicKey: modules/libmar/verify/cryptox.c), but the
 * certificate is still self-signed, so that anyone can check with openssl that it was made by
 * the key it names.
 *
 * The primary's private key never leaves Cloud KMS, so openssl cannot sign the certificate. This
 * tool splits the work: `request` writes the to-be-signed certificate and the SHA-384 DigestInfo
 * over it, KMS signs the DigestInfo (the key is RSA_SIGN_RAW_PKCS1_4096, which signs exactly the
 * bytes it is sent), and `assemble` joins the two and checks the signature and the key.
 *
 *   update-cert.mjs request --public-key update-primary.pem --slot primary --out-dir DIR
 *       writes DIR/primary.tbs.der and DIR/primary.digestinfo.bin; prints the gcloud command
 *   update-cert.mjs assemble --dir DIR --slot primary --signature sig.bin --out primary.der
 *       [--any-key]
 *       the certificate; refuses a signature that does not verify, and (without --any-key, for
 *       throwaway test keys) a key other than the primary pinned in update-keys.mjs
 *
 * Every field is fixed (serial from the key, validity to 9999-12-31), so the request is the same
 * each time it is made from the same key, and a reviewer can rebuild it from the public key.
 *
 * Node built-ins only.
 */

import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATE_KEYS } from "../../packages/vimma-core/src/update-keys.mjs";

/** DER of the SHA-384 DigestInfo up to the 48-byte hash (RFC 8017, section 9.2, note 1). */
export const SHA384_DIGESTINFO_PREFIX = Uint8Array.from(
  Buffer.from("3041300d060960864801650304020205000430", "hex"),
);

/** AlgorithmIdentifier sha384WithRSAEncryption (1.2.840.113549.1.1.12), NULL parameters. */
const SHA384_WITH_RSA = Buffer.from("300d06092a864886f70d01010c0500", "hex");

/** The validity: from the day the format was settled, to RFC 5280's "no well-defined end". */
const NOT_BEFORE = "261101000000Z"; // UTCTime, 2026-11-01
const NOT_AFTER = "99991231235959Z"; // GeneralizedTime

/** @typedef {"primary" | "secondary"} Slot */

/**
 * @param {number} tag
 * @param {...Uint8Array} parts
 * @returns {Buffer}
 */
function tlv(tag, ...parts) {
  const body = Buffer.concat(parts);
  const n = body.length;
  /** @type {number[]} */
  let len;
  if (n < 0x80) len = [n];
  else {
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    len = [0x80 | bytes.length, ...bytes];
  }
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}

/** @param {string} cn */
const name = (cn) =>
  tlv(
    0x30,
    tlv(0x31, tlv(0x30, Buffer.from("0603550403", "hex"), tlv(0x0c, Buffer.from(cn, "utf8")))),
  );

/**
 * @param {Uint8Array} spki DER SubjectPublicKeyInfo
 * @returns {import("node:crypto").KeyObject}
 */
function rsa4096(spki) {
  const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 4096) {
    throw new Error("update keys are RSA-4096 (docs/specs/m6a-updater.md §6)");
  }
  return key;
}

/**
 * The to-be-signed certificate for an update key and the DigestInfo KMS signs.
 * @param {Uint8Array} spki DER SubjectPublicKeyInfo of an RSA-4096 key
 * @param {Slot} slot
 * @returns {{ tbs: Uint8Array, digestInfo: Uint8Array }}
 */
export function certificateRequest(spki, slot) {
  rsa4096(spki);
  const subject = name(`Vimma update signing ${slot}`);
  // A positive 16-byte serial derived from the key and slot: unique per certificate, and the
  // same every time.
  const serial = createHash("sha256").update(slot).update(spki).digest().subarray(0, 16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const tbs = tlv(
    0x30,
    tlv(0x02, serial),
    SHA384_WITH_RSA,
    subject,
    tlv(0x30, tlv(0x17, Buffer.from(NOT_BEFORE)), tlv(0x18, Buffer.from(NOT_AFTER))),
    subject,
    Buffer.from(spki),
  );
  const digestInfo = Buffer.concat([
    SHA384_DIGESTINFO_PREFIX,
    createHash("sha384").update(tbs).digest(),
  ]);
  return { tbs: new Uint8Array(tbs), digestInfo: new Uint8Array(digestInfo) };
}

/**
 * The DER certificate, after checking that `signature` is the key's own over `tbs`.
 * @param {Uint8Array} tbs from certificateRequest
 * @param {Uint8Array} signature the raw RSA signature KMS returned
 * @param {Uint8Array} spki the key the certificate must name
 * @returns {Uint8Array}
 */
export function assembleCertificate(tbs, signature, spki) {
  const key = rsa4096(spki);
  const der = tlv(
    0x30,
    Buffer.from(tbs),
    SHA384_WITH_RSA,
    tlv(0x03, Buffer.from([0]), Buffer.from(signature)),
  );
  const cert = new X509Certificate(der);
  if (!Buffer.from(certificateSpki(der)).equals(Buffer.from(spki))) {
    throw new Error("the request names another key than --public-key");
  }
  if (!cert.verify(key)) {
    throw new Error("the signature does not verify with the certificate's own key");
  }
  return new Uint8Array(der);
}

/**
 * @param {Uint8Array} der a certificate
 * @returns {Uint8Array} its DER SubjectPublicKeyInfo
 */
export function certificateSpki(der) {
  const cert = new X509Certificate(Buffer.from(der));
  return new Uint8Array(cert.publicKey.export({ type: "spki", format: "der" }));
}

/**
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    if (a === "--any-key") out["any-key"] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    }
  }
  return out;
}

/** @param {string | boolean | undefined} v */
const slotOf = (v) => {
  if (v !== "primary" && v !== "secondary") throw new Error("--slot is primary or secondary");
  return /** @type {Slot} */ (v);
};

/** @param {string | boolean | undefined} v @param {string} flag */
const str = (v, flag) => {
  if (typeof v !== "string") throw new Error(`${flag} is required`);
  return v;
};

/** @param {string[]} argv */
function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const slot = slotOf(args.slot);
  if (cmd === "request") {
    const pem = readFileSync(str(args["public-key"], "--public-key"));
    const spki = new Uint8Array(createPublicKey(pem).export({ type: "spki", format: "der" }));
    const dir = str(args["out-dir"], "--out-dir");
    mkdirSync(dir, { recursive: true });
    const { tbs, digestInfo } = certificateRequest(spki, slot);
    writeFileSync(join(dir, `${slot}.tbs.der`), tbs);
    writeFileSync(join(dir, `${slot}.spki.der`), spki);
    writeFileSync(join(dir, `${slot}.digestinfo.bin`), digestInfo);
    console.log(`wrote ${slot}.tbs.der, ${slot}.spki.der and ${slot}.digestinfo.bin in ${dir}`);
    console.log("sign the DigestInfo with the key, for the primary:");
    console.log(
      `  gcloud kms asymmetric-sign --version 1 --key update-primary --keyring vimma-updates \\\n` +
        `    --location "$LOCATION" --input-file ${join(dir, `${slot}.digestinfo.bin`)} ` +
        `--signature-file ${join(dir, `${slot}.sig.bin`)}`,
    );
    return;
  }
  if (cmd === "assemble") {
    const dir = str(args.dir, "--dir");
    const spki = new Uint8Array(readFileSync(join(dir, `${slot}.spki.der`)));
    if (!args["any-key"]) {
      const pinned = UPDATE_KEYS.find((k) => k.slot === "primary");
      if (!pinned || Buffer.from(pinned.spki, "base64").compare(Buffer.from(spki)) !== 0) {
        throw new Error(
          "the key is not the pinned primary (packages/vimma-core/src/update-keys.mjs); " +
            "pass --any-key only for a throwaway test key",
        );
      }
    }
    const tbs = new Uint8Array(readFileSync(join(dir, `${slot}.tbs.der`)));
    const sig = new Uint8Array(readFileSync(str(args.signature, "--signature")));
    const der = assembleCertificate(tbs, sig, spki);
    const out = str(args.out, "--out");
    writeFileSync(out, der);
    console.log(`${out}: sha256 ${createHash("sha256").update(der).digest("hex")}`);
    return;
  }
  throw new Error("usage: update-cert.mjs request|assemble ... (see the header)");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`update-cert: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
