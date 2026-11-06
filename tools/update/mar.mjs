#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The complete MAR of a release or nightly (docs/specs/m6a-updater.md §6 and §7), the file
 * Firefox's updater applies to a tarball install.
 *
 * Mozilla's `signmar -s` signs only with a private key held in an NSS database, and the update
 * key lives in Cloud KMS and never leaves it, so the signature is made in three steps: `build`
 * here adds a signature block whose one signature is a zeroed placeholder, exactly where and
 * how `signmar -s` puts its own; update-publish.yml's signing job (no repository code) has KMS
 * sign the bytes around the placeholder and writes the signature into it; `verify` here checks
 * the result as the updater does (libmar's mar_verify.c), and release.yml also runs Mozilla's
 * own `signmar -v` on it.
 *
 * The MAR format (modules/libmar/src/mar_private.h, sign/mar_sign.c, Firefox 159.0.1), all
 * numbers big-endian: "MAR1", the offset of the index (u32), the size of the whole file (u64),
 * the number of signatures (u32), each signature as algorithm ID (u32, 2 = RSA-PKCS#1 v1.5 with
 * SHA-384), length (u32) and bytes, the number of additional blocks (u32), each as its size
 * (u32, its own 8 header bytes included), its ID (u32, 1 = product information: the MAR channel
 * ID and the product version, each NUL-terminated), then the files' content, then the index:
 * its length (u32) and per file its offset, size and mode (u32 each) and NUL-terminated name.
 * A signature covers every byte of the file except the signature bytes themselves.
 *
 *   mar.mjs build --tarball FILE --tools DIR --channel vimma|vimma-nightly --out FILE
 *       the complete MAR of a `./mach package` tarball, with the signature placeholder; DIR
 *       holds the build's host `mar` and Mozilla's make_full_update.sh and common.sh
 *       (tools/update-packaging), which `./mach repackage mar` runs the same way
 *   mar.mjs placeholder --in FILE --out FILE
 *       the signature placeholder alone, for an unsigned MAR
 *   mar.mjs same-content --placeholder FILE --signed FILE
 *       the signed MAR differs from the placeholder MAR only in the signature bytes
 *   mar.mjs verify --mar FILE --cert DER [--cert DER] --channel ID [--product-version V]
 *       one signature, by one of the certificates' keys, and the channel and version asked for
 *
 * Node built-ins only, so no job that runs it installs dependencies.
 */

import { execFileSync } from "node:child_process";
import { X509Certificate, constants, verify as rsaVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MAR_ID = "MAR1";
/** The only signature algorithm the updater accepts: RSA-PKCS#1 v1.5 with SHA-384. */
export const SIGNATURE_ALGORITHM = 2;
/** An RSA-4096 signature, the update key's size (§6). */
export const SIGNATURE_LENGTH = 512;
/** libmar's limits (mar_private.h): a longer signature or a larger file is refused. */
const MAX_SIGNATURE_LENGTH = 2048;
const MAX_SIGNATURES = 8;
const MAX_MAR_SIZE = 524288000;
const PRODUCT_INFO_BLOCK = 1;
/** The MAR channel IDs a Vimma updater accepts (update-settings.ini; spec §1). */
export const CHANNELS = Object.freeze(["vimma", "vimma-nightly"]);
/** make_full_update.sh's xz filter for x86_64 (mozbuild/repackaging/mar.py, _BCJ_OPTIONS). */
const BCJ_OPTIONS = "--x86";

/**
 * @param {boolean} ok
 * @param {string} why
 * @returns {asserts ok}
 */
function need(ok, why) {
  if (!ok) throw new Error(why);
}

/**
 * @typedef {object} Mar
 * @property {number} offsetToIndex
 * @property {{ algorithm: number, offset: number, length: number }[]} signatures
 *   offset: where the signature's bytes start
 * @property {string | null} channel         the product information block's MAR channel ID
 * @property {string | null} productVersion  and its product version
 * @property {{ name: string, offset: number, size: number, offsetAt: number }[]} entries
 *   offsetAt: where the entry's offset field is, in the index
 */

/**
 * A NUL-terminated string at `at`, no longer than `max` bytes before the NUL.
 * @param {Buffer} buf
 * @param {number} at
 * @param {number} end
 * @param {number} max
 */
function cString(buf, at, end, max) {
  const nul = buf.indexOf(0, at);
  need(nul >= 0 && nul < end && nul - at <= max, "a string with no NUL in its block");
  return { value: buf.toString("utf8", at, nul), next: nul + 1 };
}

/**
 * A MAR's header, signatures, product information and index, every offset checked against the
 * file. Only the format with a signature block, which Mozilla's `mar -c` writes.
 * @param {Buffer} buf
 * @returns {Mar}
 */
export function readMar(buf) {
  need(buf.length >= 24 && buf.toString("latin1", 0, 4) === MAR_ID, "not a MAR (no MAR1)");
  need(buf.length <= MAX_MAR_SIZE, "larger than the updater accepts");
  const offsetToIndex = buf.readUInt32BE(4);
  need(buf.readBigUInt64BE(8) === BigInt(buf.length), "the size field is not the file's size");
  const count = buf.readUInt32BE(16);
  need(count <= MAX_SIGNATURES, `${count} signatures`);
  let at = 20;
  /** @type {Mar["signatures"]} */
  const signatures = [];
  for (let i = 0; i < count; i++) {
    need(at + 8 <= offsetToIndex, "a signature past the content");
    const algorithm = buf.readUInt32BE(at);
    const length = buf.readUInt32BE(at + 4);
    need(length > 0 && length <= MAX_SIGNATURE_LENGTH, `a signature of ${length} bytes`);
    need(at + 8 + length <= offsetToIndex, "a signature past the content");
    signatures.push({ algorithm, offset: at + 8, length });
    at += 8 + length;
  }
  need(at + 4 <= offsetToIndex, "no additional-block count");
  const blocks = buf.readUInt32BE(at);
  at += 4;
  let channel = null;
  let productVersion = null;
  for (let i = 0; i < blocks; i++) {
    need(at + 8 <= offsetToIndex, "an additional block past the content");
    const size = buf.readUInt32BE(at);
    const id = buf.readUInt32BE(at + 4);
    need(size >= 8 && at + size <= offsetToIndex, "an additional block past the content");
    if (id === PRODUCT_INFO_BLOCK) {
      need(channel === null, "two product information blocks");
      const c = cString(buf, at + 8, at + size, 63);
      const v = cString(buf, c.next, at + size, 31);
      channel = c.value;
      productVersion = v.value;
    }
    at += size;
  }
  const contentStart = at;
  need(offsetToIndex + 4 <= buf.length, "the index is past the end");
  const indexLength = buf.readUInt32BE(offsetToIndex);
  const end = offsetToIndex + 4 + indexLength;
  need(end === buf.length, "the index does not end the file");
  /** @type {Mar["entries"]} */
  const entries = [];
  for (let p = offsetToIndex + 4; p < end;) {
    need(p + 12 < end, "a cut index entry");
    const offset = buf.readUInt32BE(p);
    const size = buf.readUInt32BE(p + 4);
    const name = cString(buf, p + 12, end, 4096);
    need(name.value !== "", "an index entry with no name");
    need(
      offset >= contentStart && offset + size <= offsetToIndex,
      `${name.value}: outside the content`,
    );
    entries.push({ name: name.value, offset, size, offsetAt: p });
    p = name.next;
  }
  return { offsetToIndex, signatures, channel, productVersion, entries };
}

/**
 * The MAR with a signature block of one SHA-384 signature whose bytes are zero: the layout
 * `signmar -s` writes (mar_repackage_and_sign), so the bytes a signature covers are the same.
 * @param {Buffer} buf an unsigned MAR
 */
export function addSignaturePlaceholder(buf) {
  const mar = readMar(buf);
  need(mar.signatures.length === 0, "the MAR is already signed");
  const added = 8 + SIGNATURE_LENGTH;
  const entry = Buffer.alloc(added);
  entry.writeUInt32BE(SIGNATURE_ALGORITHM, 0);
  entry.writeUInt32BE(SIGNATURE_LENGTH, 4);
  const out = Buffer.concat([buf.subarray(0, 20), entry, buf.subarray(20)]);
  out.writeUInt32BE(mar.offsetToIndex + added, 4);
  out.writeBigUInt64BE(BigInt(out.length), 8);
  out.writeUInt32BE(1, 16);
  for (const e of mar.entries) out.writeUInt32BE(e.offset + added, e.offsetAt + added);
  readMar(out);
  return out;
}

/**
 * Every byte of the MAR but its signatures' bytes: what each signature covers (libmar's
 * mar_extract_and_verify_signatures). It starts with "MAR1", which keeps a MAR signature apart
 * from the manifest's (signed after `vimma-update-xml-v1\n`) under the one key (decision 12).
 * @param {Buffer} buf
 */
export function signedBytes(buf) {
  const { signatures } = readMar(buf);
  need(signatures.length > 0, "the MAR has no signature block");
  /** @type {Buffer[]} */
  const parts = [];
  let at = 0;
  for (const s of signatures) {
    parts.push(buf.subarray(at, s.offset));
    at = s.offset + s.length;
  }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts);
}

/**
 * The MAR with `signature` written over its one zeroed placeholder.
 * @param {Buffer} buf
 * @param {Buffer} signature
 */
export function insertSignature(buf, signature) {
  const { signatures } = readMar(buf);
  need(signatures.length === 1, "not one signature placeholder");
  const [s] = signatures;
  need(s?.algorithm === SIGNATURE_ALGORITHM, "the placeholder is not for SHA-384");
  need(s.length === signature.length, `a ${signature.length}-byte signature for ${s.length} bytes`);
  need(
    buf.subarray(s.offset, s.offset + s.length).every((b) => b === 0),
    "the placeholder is not zeroed",
  );
  const out = Buffer.from(buf);
  signature.copy(out, s.offset);
  return out;
}

/**
 * The checks the updater makes before it applies a MAR (mar_verify.c, the product information
 * block against update-settings.ini), with one signature: one key signs today; a rotation (§6)
 * adds the second signature and the second check with it.
 * @param {Buffer} buf
 * @param {readonly (import("node:crypto").KeyObject | X509Certificate)[]} keys  one must have made the signature
 * @param {{ channel: string, productVersion?: string }} want
 */
export function verifyMar(buf, keys, want) {
  const mar = readMar(buf);
  need(mar.signatures.length === 1, `${mar.signatures.length} signatures, not 1`);
  const [s] = mar.signatures;
  need(s?.algorithm === SIGNATURE_ALGORITHM, "the signature is not RSA-PKCS#1 v1.5 with SHA-384");
  const data = signedBytes(buf);
  const signature = buf.subarray(s.offset, s.offset + s.length);
  const ok = keys.some((k) =>
    rsaVerify(
      "sha384",
      data,
      { key: k instanceof X509Certificate ? k.publicKey : k, padding: constants.RSA_PKCS1_PADDING },
      signature,
    ),
  );
  need(ok, "the signature does not verify under any given key");
  need(mar.channel === want.channel, `MAR channel ${mar.channel}, not ${want.channel}`);
  if (want.productVersion !== undefined) {
    need(
      mar.productVersion === want.productVersion,
      `product version ${mar.productVersion}, not ${want.productVersion}`,
    );
  }
  return { channel: mar.channel, productVersion: mar.productVersion, entries: mar.entries.length };
}

/**
 * application.ini's [App] Version (Firefox's version), which make_full_update.sh writes into the
 * product information block as `./mach repackage mar` does.
 * @param {string} text
 */
function appVersion(text) {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) section = head[1] ?? "";
    else if (section === "App" && line.startsWith("Version=")) return line.slice(8);
  }
  throw new Error("application.ini has no [App] Version");
}

/**
 * The complete MAR of a `./mach package` tarball, with the signature placeholder.
 * @param {{ tarball: string, tools: string, channel: string, out: string }} o
 */
export function buildMar({ tarball, tools, channel, out }) {
  need(CHANNELS.includes(channel), `channel ${channel} is not ${CHANNELS.join(" or ")}`);
  const work = mkdtempSync(join(tmpdir(), "vimma-mar-"));
  try {
    const tree = join(work, "tree");
    mkdirSync(tree);
    execFileSync("tar", ["-xJf", tarball, "-C", tree]);
    const tops = readdirSync(tree);
    need(tops.length === 1, `the tarball has ${tops.length} top-level entries, not one`);
    const dir = join(tree, /** @type {string} */ (tops[0]));
    const version = appVersion(readFileSync(join(dir, "application.ini"), "utf8"));
    const unsigned = join(work, "unsigned.mar");
    execFileSync(join(tools, "make_full_update.sh"), ["-q", unsigned, dir], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        MAR: join(tools, "mar"),
        MOZ_PRODUCT_VERSION: version,
        MAR_CHANNEL_ID: channel,
        BCJ_OPTIONS,
      },
    });
    const placed = addSignaturePlaceholder(readFileSync(unsigned));
    const mar = readMar(placed);
    need(mar.channel === channel, `make_full_update.sh wrote channel ${mar.channel}`);
    need(mar.productVersion === version, `make_full_update.sh wrote version ${mar.productVersion}`);
    writeFileSync(out, placed);
    return { channel, productVersion: version, entries: mar.entries.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tarball: { type: "string" },
      tools: { type: "string" },
      channel: { type: "string" },
      out: { type: "string" },
      in: { type: "string" },
      mar: { type: "string" },
      cert: { type: "string", multiple: true },
      "product-version": { type: "string" },
      placeholder: { type: "string" },
      signed: { type: "string" },
    },
  });
  switch (command) {
    case "build": {
      const { tarball, tools, channel, out } = values;
      need(
        !!tarball && !!tools && !!channel && !!out,
        "build needs --tarball --tools --channel --out",
      );
      const r = buildMar({ tarball, tools, channel, out });
      console.log(
        `mar: ${out}: channel ${r.channel}, Firefox ${r.productVersion}, ${r.entries} files, unsigned`,
      );
      return;
    }
    case "placeholder": {
      need(!!values.in && !!values.out, "placeholder needs --in and --out");
      writeFileSync(values.out, addSignaturePlaceholder(readFileSync(values.in)));
      return;
    }
    case "same-content": {
      need(
        !!values.placeholder && !!values.signed,
        "same-content needs --placeholder and --signed",
      );
      const placeholder = readFileSync(values.placeholder);
      const signed = readFileSync(values.signed);
      const a = readMar(placeholder);
      const b = readMar(signed);
      need(
        JSON.stringify(a.signatures) === JSON.stringify(b.signatures),
        "the signature blocks differ",
      );
      need(
        signedBytes(placeholder).equals(signedBytes(signed)),
        "the signed MAR's content differs",
      );
      console.log("mar: the signed MAR differs from the placeholder only in its signature");
      return;
    }
    case "verify": {
      need(
        !!values.mar && !!values.cert?.length && !!values.channel,
        "verify needs --mar --cert --channel",
      );
      const certs = values.cert.map((f) => new X509Certificate(readFileSync(f)));
      const r = verifyMar(readFileSync(values.mar), certs, {
        channel: values.channel,
        productVersion: values["product-version"],
      });
      console.log(
        `mar: ${values.mar}: signed, ${r.channel} ${r.productVersion}, ${r.entries} files`,
      );
      return;
    }
    default:
      throw new Error(
        "usage: mar.mjs build|placeholder|same-content|verify (see the file's header)",
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`mar: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
