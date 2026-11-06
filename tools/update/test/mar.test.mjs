// tools/update/mar.mjs: the complete MAR of a release or nightly (docs/specs/m6a-updater.md §6
// and §7). Cloud KMS cannot sign through `signmar -s` (its key never enters an NSS database), so
// the MAR gets its signature block with a zeroed placeholder here, update-publish.yml's signing
// job signs the bytes around it, and this file checks the result as the updater does.
//
// The fixtures were made with Mozilla's own tools, built from Firefox 159.0.1's
// modules/libmar against NSS: `mar -H vimma -V 159.0.1 -c unsigned.mar` over three small files,
// then `signmar -s` with a throwaway RSA-4096 key whose certificate is test-cert.der (the key
// was not kept). So a placeholder here that matches signmar's layout byte for byte, and a
// signature that verifies over the bytes this file says are signed, are what the updater reads.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  X509Certificate,
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  verify,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  SIGNATURE_LENGTH,
  addSignaturePlaceholder,
  insertSignature,
  readMar,
  signedBytes,
  verifyMar,
} from "../mar.mjs";

const FIXTURES = new URL("fixtures/mar/", import.meta.url);
const SCRIPT = new URL("../mar.mjs", import.meta.url).pathname;
const unsigned = () => readFileSync(new URL("unsigned.mar", FIXTURES));
const signmarSigned = () => readFileSync(new URL("signmar-signed.mar", FIXTURES));
const testCert = () => readFileSync(new URL("test-cert.der", FIXTURES));
/** DER prefix of a SHA-384 DigestInfo (RFC 8017 §9.2, note 1). */
const SHA384_DIGESTINFO = Buffer.from("3041300d060960864801650304020205000430", "hex");

/** A signature made the way the KMS key makes one: PKCS#1 v1.5 over a DigestInfo it is sent. */
function kmsSign(/** @type {import("node:crypto").KeyObject} */ key, /** @type {Buffer} */ data) {
  const info = Buffer.concat([SHA384_DIGESTINFO, createHash("sha384").update(data).digest()]);
  return privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, info);
}

describe("readMar", () => {
  it("reads the product information block and the index of an unsigned MAR", () => {
    const mar = readMar(unsigned());
    expect(mar.signatures).toEqual([]);
    expect(mar.channel).toBe("vimma");
    expect(mar.productVersion).toBe("159.0.1");
    expect(mar.entries.map((e) => e.name).sort()).toEqual([
      "vimma/a.txt",
      "vimma/b.txt",
      "vimma/update-settings.ini",
    ]);
  });

  it("reads signmar's signature block", () => {
    const mar = readMar(signmarSigned());
    expect(mar.signatures).toEqual([{ algorithm: 2, offset: 28, length: SIGNATURE_LENGTH }]);
    expect(mar.channel).toBe("vimma");
  });

  it.each([
    ["no MAR ID", (/** @type {Buffer} */ b) => Buffer.concat([Buffer.from("XAR1"), b.subarray(4)])],
    ["a cut file", (/** @type {Buffer} */ b) => b.subarray(0, b.length - 3)],
    [
      "a size field that is not the file's",
      (/** @type {Buffer} */ b) => {
        const c = Buffer.from(b);
        c.writeBigUInt64BE(BigInt(c.length + 1), 8);
        return c;
      },
    ],
    [
      "an entry outside the content",
      (/** @type {Buffer} */ b) => {
        const c = Buffer.from(b);
        const index = c.readUInt32BE(4);
        c.writeUInt32BE(c.length, index + 4);
        return c;
      },
    ],
  ])("refuses %s", (_name, change) => {
    expect(() => readMar(change(unsigned()))).toThrow();
  });
});

describe("addSignaturePlaceholder", () => {
  it("writes signmar's layout byte for byte, with the signature zeroed", () => {
    const signed = signmarSigned();
    const expected = Buffer.from(signed);
    expected.fill(0, 28, 28 + SIGNATURE_LENGTH);
    expect(addSignaturePlaceholder(unsigned()).equals(expected)).toBe(true);
  });

  it("refuses a MAR that is already signed", () => {
    expect(() => addSignaturePlaceholder(signmarSigned())).toThrow(/already signed/);
  });
});

describe("signedBytes and insertSignature", () => {
  it("signmar's signature verifies over the bytes around the placeholder", () => {
    const placeholder = addSignaturePlaceholder(unsigned());
    const signature = signmarSigned().subarray(28, 28 + SIGNATURE_LENGTH);
    const key = new X509Certificate(testCert()).publicKey;
    expect(verify("sha384", signedBytes(placeholder), key, signature)).toBe(true);
    expect(insertSignature(placeholder, signature).equals(signmarSigned())).toBe(true);
  });

  it("the signed bytes start with the MAR ID, so no manifest signature can pass as a MAR's", () => {
    expect(signedBytes(addSignaturePlaceholder(unsigned())).subarray(0, 4).toString()).toBe("MAR1");
  });

  it("refuses a signature of the wrong length, or a placeholder that is not zeroed", () => {
    const placeholder = addSignaturePlaceholder(unsigned());
    expect(() => insertSignature(placeholder, Buffer.alloc(256, 1))).toThrow();
    expect(() => insertSignature(signmarSigned(), Buffer.alloc(SIGNATURE_LENGTH, 1))).toThrow(
      /placeholder/,
    );
  });
});

describe("verifyMar", () => {
  const cert = () => new X509Certificate(testCert());

  it("accepts signmar's MAR under its certificate, with the channel and version asked for", () => {
    expect(
      verifyMar(signmarSigned(), [cert()], { channel: "vimma", productVersion: "159.0.1" }),
    ).toEqual({ channel: "vimma", productVersion: "159.0.1", entries: 3 });
  });

  it("accepts a MAR signed the way the KMS key signs, and refuses one byte changed", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
    const placeholder = addSignaturePlaceholder(unsigned());
    const signed = insertSignature(placeholder, kmsSign(privateKey, signedBytes(placeholder)));
    expect(verifyMar(signed, [publicKey], { channel: "vimma" }).entries).toBe(3);
    const changed = Buffer.from(signed);
    changed[changed.length - 20] ^= 1;
    expect(() => verifyMar(changed, [publicKey], { channel: "vimma" })).toThrow(/signature/);
  });

  it.each([
    ["an unsigned MAR", () => unsigned(), {}],
    ["another channel", () => signmarSigned(), { channel: "vimma-nightly" }],
    ["another Firefox version", () => signmarSigned(), { productVersion: "160.0" }],
  ])("refuses %s", (_name, mar, want) => {
    expect(() => verifyMar(mar(), [cert()], { channel: "vimma", ...want })).toThrow();
  });

  it("refuses a MAR no given key signed", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
    expect(() => verifyMar(signmarSigned(), [publicKey], { channel: "vimma" })).toThrow(
      /signature/,
    );
  });
});

describe("mar.mjs, the commands the workflows run", () => {
  /** @param {string[]} args */
  const run = (args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

  it("placeholder, then verify with the certificates", () => {
    const dir = tempDir("vimma-mar-");
    writeFileSync(join(dir, "in.mar"), unsigned());
    const p = run(["placeholder", "--in", join(dir, "in.mar"), "--out", join(dir, "out.mar")]);
    expect(p.stderr).toBe("");
    expect(p.status).toBe(0);
    const expected = Buffer.from(signmarSigned());
    expected.fill(0, 28, 28 + SIGNATURE_LENGTH);
    expect(readFileSync(join(dir, "out.mar")).equals(expected)).toBe(true);

    writeFileSync(join(dir, "cert.der"), testCert());
    writeFileSync(join(dir, "signed.mar"), signmarSigned());
    const ok = run([
      "verify",
      "--mar",
      join(dir, "signed.mar"),
      "--cert",
      join(dir, "cert.der"),
      "--channel",
      "vimma",
      "--product-version",
      "159.0.1",
    ]);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("vimma 159.0.1");
    const bad = run([
      "verify",
      "--mar",
      join(dir, "out.mar"),
      "--cert",
      join(dir, "cert.der"),
      "--channel",
      "vimma",
    ]);
    expect(bad.status).not.toBe(0);
  });

  it("same-content: the signed MAR differs from the placeholder only in the signature", () => {
    const dir = tempDir("vimma-mar-");
    const placeholder = addSignaturePlaceholder(unsigned());
    writeFileSync(join(dir, "p.mar"), placeholder);
    writeFileSync(join(dir, "s.mar"), signmarSigned());
    const same = run([
      "same-content",
      "--placeholder",
      join(dir, "p.mar"),
      "--signed",
      join(dir, "s.mar"),
    ]);
    expect(same.status, same.stderr).toBe(0);
    const other = Buffer.from(signmarSigned());
    other[other.length - 1] ^= 1;
    writeFileSync(join(dir, "o.mar"), other);
    expect(
      run(["same-content", "--placeholder", join(dir, "p.mar"), "--signed", join(dir, "o.mar")])
        .status,
    ).not.toBe(0);
  });

  it("build: runs Mozilla's make_full_update.sh on the tarball's top directory, then the placeholder", () => {
    const dir = tempDir("vimma-mar-build-");
    mkdirSync(join(dir, "pkg", "vimma"), { recursive: true });
    writeFileSync(
      join(dir, "pkg", "vimma", "application.ini"),
      "[App]\nVersion=159.0.1\nBuildID=20261106000000\n",
    );
    writeFileSync(join(dir, "pkg", "vimma", "precomplete"), "");
    execFileSync("tar", ["-cJf", join(dir, "vimma.tar.xz"), "-C", join(dir, "pkg"), "vimma"]);
    const tools = join(dir, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "mar"), "#!/bin/sh\nexit 0\n");
    // A stand-in for make_full_update.sh: records what it was given, writes the fixture MAR.
    writeFileSync(
      join(tools, "make_full_update.sh"),
      `#!/bin/sh
set -e
[ "$1" = -q ] && shift && quiet=yes
printf '%s\\n' "quiet=$quiet" "MAR=$MAR" "MOZ_PRODUCT_VERSION=$MOZ_PRODUCT_VERSION" "MAR_CHANNEL_ID=$MAR_CHANNEL_ID" \\
  "BCJ_OPTIONS=$BCJ_OPTIONS" "dir=$(basename "$2")" "precomplete=$(test -f "$2/precomplete" && echo yes)" > "${dir}/seen"
cp "${new URL("unsigned.mar", FIXTURES).pathname}" "$1"
`,
    );
    chmodSync(join(tools, "mar"), 0o755);
    chmodSync(join(tools, "make_full_update.sh"), 0o755);
    const r = run([
      "build",
      "--tarball",
      join(dir, "vimma.tar.xz"),
      "--tools",
      tools,
      "--channel",
      "vimma",
      "--out",
      join(dir, "out.mar"),
    ]);
    expect(r.stderr).not.toMatch(/error/i);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "seen"), "utf8").split("\n")).toEqual([
      "quiet=yes",
      `MAR=${join(tools, "mar")}`,
      "MOZ_PRODUCT_VERSION=159.0.1",
      "MAR_CHANNEL_ID=vimma",
      "BCJ_OPTIONS=--x86",
      "dir=vimma",
      "precomplete=yes",
      "",
    ]);
    expect(readMar(readFileSync(join(dir, "out.mar"))).signatures).toEqual([
      { algorithm: 2, offset: 28, length: SIGNATURE_LENGTH },
    ]);
  });

  it("build refuses a channel other than vimma or vimma-nightly", () => {
    const r = run([
      "build",
      "--tarball",
      "x",
      "--tools",
      "y",
      "--channel",
      "release",
      "--out",
      "z",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/channel/);
  });
});
