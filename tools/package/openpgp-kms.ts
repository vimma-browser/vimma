#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * OpenPGP signatures for the package repositories, made with an RSA key in Google Cloud KMS
 * (docs/specs/package-repositories.md, decisions 4 and 5). The private key never leaves KMS, so
 * gpg cannot sign: this file writes the OpenPGP version 4 packets itself (RFC 4880, sections
 * 5.2 and 5.5) and asks KMS's asymmetricSign for the RSASSA-PKCS1-v1_5 signature over the
 * SHA-256 digest, which is exactly the signature an OpenPGP RSA signature packet carries.
 *
 *   openpgp-kms.ts certify (--key-version NAME | --local-key PEM) --created TIME --user-id UID
 *       --out FILE
 *       the armoured certificate: the key packet, the user ID and a self-signature (type 0x13,
 *       key flags certify and sign) made at TIME, so the same key and TIME give the same bytes
 *   openpgp-kms.ts sign (--key-version NAME | --local-key PEM) --cert FILE
 *       --format binary|armor|cleartext --in FILE|- --out FILE [--time TIME]
 *       a detached signature (binary: the pacman package and database, and rpmsign's
 *       %__gpg_sign_cmd, which passes the header as a file or on standard input), an armoured
 *       detached one (repomd.xml.asc), or a cleartext-signed message (apt's InRelease); --time
 *       sets the signature's creation time (ISO 8601 with a zone, or seconds), default now
 *   openpgp-kms.ts fingerprint --cert FILE
 *       prints the certificate's fingerprint, 40 hex digits
 *
 * NAME is a KMS key version resource name; KMS is reached over HTTPS with the access token in
 * KMS_ACCESS_TOKEN (a job sets it from `gcloud auth print-access-token`). PEM is a local RSA
 * private key, for tests and the smoke run. `sign` refuses a key other than the one the
 * certificate names, and every signature is checked against the key before it is written.
 *
 * Node built-ins only: the signing jobs run this one file and install nothing (decision 5).
 */

import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateEncrypt,
  publicDecrypt,
} from "node:crypto";
import type { Hash, KeyObject } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** DER of the SHA-256 DigestInfo up to the 32-byte hash (RFC 8017, section 9.2, note 1). */
const SHA256_DIGESTINFO_PREFIX = Buffer.from("3031300d060960864801650304020105000420", "hex");

/** The only KMS algorithm accepted: PKCS#1 v1.5 over a SHA-256 digest (decision 3). */
export const KMS_ALGORITHM = "RSA_SIGN_PKCS1_4096_SHA256";

const KEY_VERSION_RE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*$/;

// RFC 4880 constants.
const TAG_SIGNATURE = 2;
const TAG_PUBLIC_KEY = 6;
const TAG_USER_ID = 13;
const ALGO_RSA = 1;
const HASH_SHA256 = 8;
const HASH_SHA512 = 10;
const SUB_CREATED = 2;
const SUB_ISSUER = 16;
const SUB_PREFERRED_HASH = 21;
const SUB_KEY_FLAGS = 27;
const SUB_ISSUER_FPR = 33;
const SIG_BINARY = 0x00;
const SIG_TEXT = 0x01;
const SIG_POSITIVE_CERT = 0x13;

/** Something that signs a SHA-256 digest with the certificate's RSA key. */
export interface Signer {
  publicKey: KeyObject;
  /** The RSASSA-PKCS1-v1_5 signature over a SHA-256 digest. */
  sign(digest: Buffer): Promise<Buffer>;
}

/** A signer with a local RSA private key (PEM), standing in for KMS in tests and the smoke run. */
export function localSigner(pem: string | Buffer): Signer {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa")
    throw new Error("openpgp-kms: --local-key is not an RSA key");
  return {
    publicKey: createPublicKey(key),
    async sign(digest) {
      return privateEncrypt(
        { key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([SHA256_DIGESTINFO_PREFIX, digest]),
      );
    },
  };
}

/** CRC32C (Castagnoli), which KMS uses to check a request and its reply in transit. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The KMS endpoint: Cloud KMS's global or regional endpoint, or, for a test's fake, plain HTTP on
 * a literal loopback address. KMS_ENDPOINT must be written exactly as that origin (no user info,
 * path, port on https, or other spelling of an address), so an inherited variable cannot send
 * the access token anywhere else.
 */
export function kmsEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.KMS_ENDPOINT || "https://cloudkms.googleapis.com";
  const ok =
    /^https:\/\/cloudkms(?:\.[a-z0-9-]+\.rep)?\.googleapis\.com$/.test(value) ||
    /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(value);
  let canonical: boolean;
  try {
    canonical = new URL(value).origin === value;
  } catch {
    canonical = false;
  }
  if (!ok || !canonical) {
    throw new Error(
      "openpgp-kms: KMS_ENDPOINT must be https://cloudkms.googleapis.com, " +
        "https://cloudkms.<region>.rep.googleapis.com, or http://127.0.0.1:<port> or " +
        `http://[::1]:<port> for a test: ${value}`,
    );
  }
  return value;
}

async function kmsJson(
  url: string,
  token: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`openpgp-kms: KMS answered ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** A signer backed by a Cloud KMS key version (asymmetricSign over the REST API). */
export async function kmsSigner(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Signer> {
  if (!KEY_VERSION_RE.test(name)) {
    throw new Error(`openpgp-kms: --key-version is not a KMS key version resource name: ${name}`);
  }
  const token = env.KMS_ACCESS_TOKEN;
  if (!token) throw new Error("openpgp-kms: KMS_ACCESS_TOKEN is not set");
  const base = `${kmsEndpoint(env)}/v1/${name}`;
  const pub = await kmsJson(`${base}/publicKey`, token);
  if (pub.algorithm !== KMS_ALGORITHM) {
    throw new Error(
      `openpgp-kms: the key version's algorithm is ${pub.algorithm}, want ${KMS_ALGORITHM}`,
    );
  }
  // Decision 3: the key never leaves an HSM.
  if (pub.protectionLevel !== "HSM") {
    throw new Error(
      `openpgp-kms: the key version's protection level is ${pub.protectionLevel}, want HSM`,
    );
  }
  if (typeof pub.pem !== "string") throw new Error("openpgp-kms: KMS returned no public key");
  if (pub.pemCrc32c === undefined || Number(pub.pemCrc32c) !== crc32c(Buffer.from(pub.pem))) {
    throw new Error("openpgp-kms: the public key's CRC32C is missing or does not match");
  }
  return {
    publicKey: createPublicKey(pub.pem),
    async sign(digest) {
      const res = await kmsJson(`${base}:asymmetricSign`, token, {
        digest: { sha256: digest.toString("base64") },
        digestCrc32c: String(crc32c(digest)),
      });
      if (res.verifiedDigestCrc32c !== true) {
        throw new Error("openpgp-kms: KMS did not confirm the digest's CRC32C");
      }
      if (res.name !== name)
        throw new Error(`openpgp-kms: KMS signed with ${res.name}, not ${name}`);
      if (typeof res.signature !== "string")
        throw new Error("openpgp-kms: KMS returned no signature");
      const sig = Buffer.from(res.signature, "base64");
      if (Number(res.signatureCrc32c) !== crc32c(sig)) {
        throw new Error("openpgp-kms: the signature's CRC32C does not match");
      }
      return sig;
    },
  };
}

// --- Packets -----------------------------------------------------------------------------------

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** A packet with a new-format header (RFC 4880, section 4.2.2). */
function packet(tag: number, body: Buffer): Buffer {
  const n = body.length;
  let len: Buffer;
  if (n < 192) len = Buffer.from([n]);
  else if (n < 8384) len = Buffer.from([((n - 192) >> 8) + 192, (n - 192) & 0xff]);
  else len = Buffer.concat([Buffer.from([0xff]), u32(n)]);
  return Buffer.concat([Buffer.from([0xc0 | tag]), len, body]);
}

/** A multiprecision integer (RFC 4880, section 3.2): bit count, then big-endian bytes. */
function mpi(value: Buffer): Buffer {
  let i = 0;
  while (i < value.length - 1 && value[i] === 0) i++;
  const bytes = value.subarray(i);
  const top = bytes.readUInt8(0);
  const bits = (bytes.length - 1) * 8 + (top === 0 ? 0 : 32 - Math.clz32(top));
  return Buffer.concat([u16(bits), bytes]);
}

function subpacket(type: number, data: Buffer): Buffer {
  if (data.length + 1 >= 192) throw new Error("openpgp-kms: subpacket too long");
  return Buffer.concat([Buffer.from([data.length + 1, type]), data]);
}

/** The RSA modulus and exponent of a public key. */
function rsaNumbers(key: KeyObject): { n: Buffer; e: Buffer } {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("openpgp-kms: not an RSA key");
  return { n: Buffer.from(jwk.n, "base64url"), e: Buffer.from(jwk.e, "base64url") };
}

/** An OpenPGP version 4 RSA key: its packet body, fingerprint and key ID. */
export interface Key {
  body: Buffer;
  created: number;
  fingerprint: Buffer;
  keyId: Buffer;
  n: Buffer;
  e: Buffer;
}

function keyFromBody(body: Buffer): Key {
  if (body[0] !== 4 || body[5] !== ALGO_RSA) {
    throw new Error("openpgp-kms: the certificate's key is not a version 4 RSA key");
  }
  const created = body.readUInt32BE(1);
  let at = 6;
  const read = (): Buffer => {
    const bits = body.readUInt16BE(at);
    const len = Math.ceil(bits / 8);
    const v = body.subarray(at + 2, at + 2 + len);
    at += 2 + len;
    return v;
  };
  const n = read();
  const e = read();
  const fingerprint = createHash("sha1")
    .update(Buffer.from([0x99]))
    .update(u16(body.length))
    .update(body)
    .digest();
  return { body, created, fingerprint, keyId: fingerprint.subarray(12), n, e };
}

function keyFor(publicKey: KeyObject, created: number): Key {
  const { n, e } = rsaNumbers(publicKey);
  return keyFromBody(
    Buffer.concat([Buffer.from([4]), u32(created), Buffer.from([ALGO_RSA]), mpi(n), mpi(e)]),
  );
}

/**
 * A version 4 signature packet: hashed subpackets for the creation time and the issuer
 * fingerprint (plus `extra`), the issuer key ID unhashed, as gpg writes it, for verifiers that
 * look only there (rpm's own parser among them).
 */
async function signaturePacket(opts: {
  signer: Signer;
  key: Key;
  type: number;
  time: number;
  hash: Hash;
  extra?: Buffer[];
}): Promise<Buffer> {
  const { signer, key, type, time, hash } = opts;
  const hashed = Buffer.concat([
    subpacket(SUB_CREATED, u32(time)),
    subpacket(SUB_ISSUER_FPR, Buffer.concat([Buffer.from([4]), key.fingerprint])),
    ...(opts.extra ?? []),
  ]);
  const head = Buffer.concat([
    Buffer.from([4, type, ALGO_RSA, HASH_SHA256]),
    u16(hashed.length),
    hashed,
  ]);
  hash.update(head);
  hash.update(Buffer.concat([Buffer.from([4, 0xff]), u32(head.length)]));
  const digest = hash.digest();
  const sig = await signer.sign(digest);
  checkSignature(key, digest, sig);
  const unhashed = subpacket(SUB_ISSUER, key.keyId);
  return packet(
    TAG_SIGNATURE,
    Buffer.concat([head, u16(unhashed.length), unhashed, digest.subarray(0, 2), mpi(sig)]),
  );
}

/** Refuses a signature that is not the certificate key's PKCS#1 v1.5 signature over `digest`. */
function checkSignature(key: Key, digest: Buffer, sig: Buffer): void {
  const pub = createPublicKey({
    key: { kty: "RSA", n: key.n.toString("base64url"), e: key.e.toString("base64url") },
    format: "jwk",
  });
  let recovered: Buffer;
  try {
    recovered = publicDecrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, sig);
  } catch {
    throw new Error("openpgp-kms: the signature does not verify with the certificate's key");
  }
  if (!recovered.equals(Buffer.concat([SHA256_DIGESTINFO_PREFIX, digest]))) {
    throw new Error("openpgp-kms: the signature does not verify with the certificate's key");
  }
}

// --- Armour ------------------------------------------------------------------------------------

function crc24(data: Buffer): Buffer {
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  crc &= 0xffffff;
  return Buffer.from([crc >> 16, (crc >> 8) & 0xff, crc & 0xff]);
}

/** ASCII armour (RFC 4880, section 6.2), with the CRC-24 line every reader accepts. */
export function armor(kind: "PUBLIC KEY BLOCK" | "SIGNATURE", data: Buffer): string {
  const b64 = data.toString("base64");
  const lines = [`-----BEGIN PGP ${kind}-----`, ""];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  lines.push(`=${crc24(data).toString("base64")}`, `-----END PGP ${kind}-----`, "");
  return lines.join("\n");
}

/** The packets inside an armoured block (or the bytes themselves, when not armoured). */
export function dearmor(text: Buffer): Buffer {
  const s = text.toString("latin1");
  const m =
    /^-----BEGIN PGP [A-Z ]+-----\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)^-----END PGP /m.exec(s);
  const armoured = m?.[1];
  if (armoured === undefined) return text;
  const body = armoured
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("="))
    .join("");
  const data = Buffer.from(body, "base64");
  const sum = /^=([A-Za-z0-9+/]{4})\r?$/m.exec(armoured)?.[1];
  if (sum !== undefined && !Buffer.from(sum, "base64").equals(crc24(data))) {
    throw new Error("openpgp-kms: armour checksum does not match");
  }
  return data;
}

/** The first version 4 public-key packet of a certificate. */
export function certificateKey(cert: Buffer): Key {
  const data = dearmor(cert);
  let at = 0;
  while (at < data.length) {
    const first = data.readUInt8(at);
    if (!(first & 0x80)) throw new Error("openpgp-kms: not an OpenPGP packet");
    let tag: number;
    let len: number;
    let hdr: number;
    if (first & 0x40) {
      tag = first & 0x3f;
      const o = data.readUInt8(at + 1);
      if (o < 192) [len, hdr] = [o, 2];
      else if (o < 224) [len, hdr] = [((o - 192) << 8) + data.readUInt8(at + 2) + 192, 3];
      else if (o === 255) [len, hdr] = [data.readUInt32BE(at + 2), 6];
      else throw new Error("openpgp-kms: partial lengths are not used in a certificate");
    } else {
      tag = (first >> 2) & 0x0f;
      const lt = first & 3;
      if (lt === 0) [len, hdr] = [data.readUInt8(at + 1), 2];
      else if (lt === 1) [len, hdr] = [data.readUInt16BE(at + 1), 3];
      else if (lt === 2) [len, hdr] = [data.readUInt32BE(at + 1), 5];
      else throw new Error("openpgp-kms: indeterminate lengths are not used in a certificate");
    }
    if (tag === TAG_PUBLIC_KEY) return keyFromBody(data.subarray(at + hdr, at + hdr + len));
    at += hdr + len;
  }
  throw new Error("openpgp-kms: the certificate has no public-key packet");
}

/** Refuses a signer whose key is not the certificate's. */
function sameKey(key: Key, signer: Signer): void {
  const { n, e } = rsaNumbers(signer.publicKey);
  const strip = (b: Buffer) => b.subarray(b.findIndex((x) => x !== 0));
  if (!strip(n).equals(strip(key.n)) || !strip(e).equals(strip(key.e))) {
    throw new Error(
      `openpgp-kms: the signing key is not the certificate's key ${key.fingerprint.toString("hex").toUpperCase()}`,
    );
  }
}

// --- Certificate and signatures ----------------------------------------------------------------

/** The armoured certificate: key packet, user ID and positive self-certification. */
export async function certify(signer: Signer, created: number, userId: string): Promise<string> {
  if (!userId || /[\r\n]/.test(userId)) throw new Error("openpgp-kms: bad user ID");
  const key = keyFor(signer.publicKey, created);
  const uid = Buffer.from(userId, "utf8");
  const hash = createHash("sha256")
    .update(Buffer.from([0x99]))
    .update(u16(key.body.length))
    .update(key.body)
    .update(Buffer.from([0xb4]))
    .update(u32(uid.length))
    .update(uid);
  const sig = await signaturePacket({
    signer,
    key,
    type: SIG_POSITIVE_CERT,
    time: created,
    hash,
    extra: [
      subpacket(SUB_KEY_FLAGS, Buffer.from([0x03])), // certify and sign
      subpacket(SUB_PREFERRED_HASH, Buffer.from([HASH_SHA256, HASH_SHA512])),
    ],
  });
  return armor(
    "PUBLIC KEY BLOCK",
    Buffer.concat([packet(TAG_PUBLIC_KEY, key.body), packet(TAG_USER_ID, uid), sig]),
  );
}

export type Format = "binary" | "armor" | "cleartext";

/**
 * The canonical lines of a cleartext-signed message: split at LF, each line without its
 * trailing spaces and tabs (RFC 4880, section 7.1, which every verifier applies too), and the
 * final line ending left out, because the armour's own line break follows it.
 */
function cleartextLines(data: Buffer): string[] {
  const text = data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(data)) {
    throw new Error("openpgp-kms: a cleartext message must be UTF-8");
  }
  if (text.length === 0) throw new Error("openpgp-kms: refusing to sign an empty message");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.replace(/[ \t\r]+$/, ""));
}

/** Signs `data` in one of the three forms; `time` is the signature's creation time. */
export async function sign(
  signer: Signer,
  cert: Buffer,
  format: Format,
  data: Buffer,
  time: number,
): Promise<Buffer> {
  const key = certificateKey(cert);
  sameKey(key, signer);
  if (format === "cleartext") {
    const lines = cleartextLines(data);
    const hash = createHash("sha256").update(lines.join("\r\n"), "utf8");
    const sig = await signaturePacket({ signer, key, type: SIG_TEXT, time, hash });
    // Dash-escaping (section 7.1): a line that starts with "-" gets "- " in front, so no line
    // of the message can pass for an armour header.
    const body = lines.map((l) => (l.startsWith("-") ? `- ${l}` : l)).join("\n");
    return Buffer.from(
      `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${body}\n${armor("SIGNATURE", sig)}`,
      "utf8",
    );
  }
  const sig = await signaturePacket({
    signer,
    key,
    type: SIG_BINARY,
    time,
    hash: createHash("sha256").update(data),
  });
  return format === "armor" ? Buffer.from(armor("SIGNATURE", sig)) : sig;
}

// --- Command line ------------------------------------------------------------------------------

/** Seconds since the epoch from an ISO 8601 time with a zone, or a number of seconds. */
export function parseTime(value: string): number {
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (!/(Z|[+-][0-9]{2}:?[0-9]{2})$/.test(value)) {
    throw new Error(`openpgp-kms: a time needs a zone (Z or +hh:mm): ${value}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`openpgp-kms: not a time: ${value}`);
  return Math.floor(ms / 1000);
}

async function readInput(path: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = path === "-" ? process.stdin : createReadStream(path);
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function signerFrom(values: {
  "key-version"?: string;
  "local-key"?: string;
}): Promise<Signer> {
  const kv = values["key-version"];
  const local = values["local-key"];
  if (Boolean(kv) === Boolean(local)) {
    throw new Error("openpgp-kms: give exactly one of --key-version and --local-key");
  }
  return kv ? kmsSigner(kv) : localSigner(readFileSync(local as string));
}

const USAGE = `usage:
  openpgp-kms.ts certify (--key-version NAME | --local-key PEM) --created TIME --user-id UID --out FILE
  openpgp-kms.ts sign (--key-version NAME | --local-key PEM) --cert FILE
      --format binary|armor|cleartext --in FILE|- --out FILE [--time TIME]
  openpgp-kms.ts fingerprint --cert FILE`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "key-version": { type: "string" },
      "local-key": { type: "string" },
      cert: { type: "string" },
      created: { type: "string" },
      "user-id": { type: "string" },
      format: { type: "string" },
      in: { type: "string" },
      out: { type: "string" },
      time: { type: "string" },
    },
  });
  if (positionals.length) throw new Error(`${USAGE}\nunexpected argument: ${positionals[0]}`);
  if (command === "fingerprint") {
    if (!values.cert) throw new Error(USAGE);
    const key = certificateKey(readFileSync(values.cert));
    process.stdout.write(`${key.fingerprint.toString("hex").toUpperCase()}\n`);
    return;
  }
  if (command === "certify") {
    if (!values.created || !values["user-id"] || !values.out) throw new Error(USAGE);
    const signer = await signerFrom(values);
    writeFileSync(values.out, await certify(signer, parseTime(values.created), values["user-id"]));
    const key = certificateKey(readFileSync(values.out));
    process.stdout.write(`${key.fingerprint.toString("hex").toUpperCase()}\n`);
    return;
  }
  if (command === "sign") {
    const format = values.format;
    if (format !== "binary" && format !== "armor" && format !== "cleartext") throw new Error(USAGE);
    if (!values.cert || !values.in || !values.out) throw new Error(USAGE);
    const cert = readFileSync(values.cert);
    certificateKey(cert); // refuse a bad certificate before anything is sent to KMS
    const signer = await signerFrom(values);
    const time = values.time ? parseTime(values.time) : Math.floor(Date.now() / 1000);
    const out = await sign(signer, cert, format, await readInput(values.in), time);
    writeFileSync(values.out, out);
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
