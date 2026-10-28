// docs/specs/m6a-updater.md, delivery 1 ("check and tell"): the signed manifest, its rules, the
// status-bar notice and the update steps per install type. Keys are generated here; no network.
import { describe, test, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANIFEST_PREFIX,
  MAX_MANIFEST_CHARS,
  appBundleOf,
  base64Decode,
  base64Encode,
  installTypeFrom,
  judgeManifest,
  offNotice,
  OFF_NOTICE_MS,
  offerAssets,
  parseManifest,
  shellQuote,
  signatureComment,
  signedBytes,
  spkiKeyId,
  splitManifest,
  staleDays,
  updateNotice,
  updateSteps,
  updateVersionLine,
  updatesCheckAfterRead,
  updatesEnabled,
  verifyManifest,
} from "../src/updates.mjs";
import { UPDATE_KEYS } from "../src/update-keys.mjs";
import { parseConfig, rawUpdatesCheck } from "../src/config.mjs";
import { DEFAULT_CONFIG, formatDefaultsToml } from "../src/defaults.mjs";
import { parseCommandLine } from "../src/cmdline.mjs";
import { getAction } from "../src/actions.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { statusSegments } from "../src/statusbar.mjs";
import { THEME_TOKENS } from "../src/theme.mjs";

const subtle = globalThis.crypto.subtle;
const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" };

/** @returns {Promise<{ pair: CryptoKeyPair, spki: string, id: string }>} */
async function makeKey() {
  const pair = /** @type {CryptoKeyPair} */ (
    await subtle.generateKey(
      { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    )
  );
  const der = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  return { pair, spki: base64Encode(der), id: await spkiKeyId(subtle, der) };
}

/** @type {Awaited<ReturnType<typeof makeKey>>} */ let primary;
/** @type {Awaited<ReturnType<typeof makeKey>>} */ let secondary;
/** @type {Awaited<ReturnType<typeof makeKey>>} */ let stranger;

beforeAll(async () => {
  [primary, secondary, stranger] = await Promise.all([makeKey(), makeKey(), makeKey()]);
});

const pinned = () => [
  { id: primary.id, slot: "primary", spki: primary.spki },
  { id: secondary.id, slot: "secondary", spki: secondary.spki },
];

/**
 * @param {string} body
 * @param {Awaited<ReturnType<typeof makeKey>>} key
 * @param {Uint8Array} [bytes]  what is signed, when not signedBytes(body)
 */
async function sig(body, key, bytes = signedBytes(body)) {
  return {
    key: key.id,
    sig: base64Encode(new Uint8Array(await subtle.sign(ALG, key.pair.privateKey, bytes))),
  };
}

/** @param {string} body @param {...Awaited<ReturnType<typeof makeKey>>} keys */
async function signed(body, ...keys) {
  const sigs = await Promise.all(keys.map((k) => sig(body, k)));
  return body + signatureComment(sigs);
}

/**
 * The manifest of spec §2 (channel, target and serial on <updates>, decision 25).
 * @param {{ serial?: string, channel?: string, target?: string, update?: Record<string, string>
 *   | null }} [o]
 */
function manifest({
  serial = "20261028041207",
  channel = "vimma",
  target = "Linux_x86_64-gcc3",
  update = {},
} = {}) {
  const head =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${channel}" vimmaTarget="${target}" vimmaSerial="${serial}">\n`;
  if (update === null) return `${head}</updates>\n`;
  const attrs = {
    type: "minor",
    appVersion: "158.0.1",
    platformVersion: "158.0.1",
    buildID: "20261028031500",
    displayVersion: "0.3.1",
    detailsURL: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
    vimmaUrgency: "normal",
    ...update,
  };
  const list = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return (
    `${head}  <update ${list}>\n` +
    '    <patch type="complete" size="98113536" hashFunction="sha512" hashValue="ab"' +
    ' URL="https://github.com/vimma-browser/vimma/releases/download/v0.3.1/x.mar"/>\n' +
    "  </update>\n</updates>\n"
  );
}

describe("the manifest signature (spec §2, §4 rule 1)", () => {
  test("a manifest signed by the primary or the secondary verifies, and names the slot", async () => {
    const body = manifest();
    const a = await verifyManifest(await signed(body, primary), pinned(), subtle);
    expect(a).toEqual({ ok: true, body, key: { id: primary.id, slot: "primary" } });
    const b = await verifyManifest(await signed(body, secondary), pinned(), subtle);
    expect(b).toMatchObject({ ok: true, key: { id: secondary.id, slot: "secondary" } });
  });

  test("a trailing newline after the comment is allowed; nothing else is", async () => {
    const text = await signed(manifest(), primary);
    expect(text.endsWith("-->\n")).toBe(true);
    expect((await verifyManifest(text.slice(0, -1), pinned(), subtle)).ok).toBe(true);
    expect(await verifyManifest(`${text}<!-- x -->\n`, pinned(), subtle)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^unsigned/),
    });
  });

  test("a key that is not pinned is refused, even with a valid signature", async () => {
    const r = await verifyManifest(await signed(manifest(), stranger), pinned(), subtle);
    expect(r).toEqual({ ok: false, reason: "signature: not signed by a pinned key" });
  });

  test("no pinned key at all refuses every manifest (before the key ceremony)", async () => {
    const r = await verifyManifest(await signed(manifest(), primary), [], subtle);
    expect(r).toEqual({ ok: false, reason: "signature: no pinned key in this build" });
  });

  test("one flipped byte in the body fails", async () => {
    const text = await signed(manifest(), primary);
    const flipped = text.replace('appVersion="158.0.1"', 'appVersion="158.0.2"');
    expect(await verifyManifest(flipped, pinned(), subtle)).toEqual({
      ok: false,
      reason: "signature: does not verify",
    });
  });

  test("one flipped character in the signature fails", async () => {
    const text = await signed(manifest(), primary);
    const at = text.indexOf("sig=") + 10;
    const c = text[at] === "A" ? "B" : "A";
    const flipped = text.slice(0, at) + c + text.slice(at + 1);
    expect(await verifyManifest(flipped, pinned(), subtle)).toEqual({
      ok: false,
      reason: "signature: does not verify",
    });
  });

  test("a key id that is changed in the comment no longer names a pinned key", async () => {
    const text = await signed(manifest(), primary);
    const other = text.replace(`key=${primary.id}`, "key=00000000");
    expect(await verifyManifest(other, pinned(), subtle)).toEqual({
      ok: false,
      reason: "signature: not signed by a pinned key",
    });
  });

  test("missing or second comment, unsigned XML, malformed pairs: unsigned", async () => {
    const body = manifest();
    const text = await signed(body, primary);
    const cases = [
      body,
      `${text}${signatureComment([await sig(body, primary)])}`,
      body + "<!-- vimma-signature v1 -->\n",
      body + `<!-- vimma-signature v2 key=${primary.id} sig=AAAA -->\n`,
      body + `<!-- vimma-signature v1 key=XYZ sig=AAAA -->\n`,
      body.slice(0, -1) + text.slice(body.length), // no newline before the comment
    ];
    for (const c of cases) {
      const r = await verifyManifest(c, pinned(), subtle);
      expect(r.ok, c.slice(-80)).toBe(false);
      expect(/** @type {any} */ (r).reason).toMatch(/^unsigned/);
    }
  });

  test("a signature over the body without the domain prefix fails", async () => {
    const body = manifest();
    const bare = await sig(body, primary, new TextEncoder().encode(body));
    const r = await verifyManifest(body + signatureComment([bare]), pinned(), subtle);
    expect(r).toEqual({ ok: false, reason: "signature: does not verify" });
    expect(MANIFEST_PREFIX).toBe("vimma-update-xml-v1\n");
  });

  test("several signatures (rotation): one valid under a pinned key is enough", async () => {
    const body = manifest();
    const text = await signed(body, stranger, secondary);
    expect(await verifyManifest(text, pinned(), subtle)).toMatchObject({
      ok: true,
      key: { slot: "secondary" },
    });
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => sig(body, primary)));
    expect(await verifyManifest(body + signatureComment(five), pinned(), subtle)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^unsigned/),
    });
  });

  test("an oversized manifest is refused before any crypto", async () => {
    const big = manifest().replace(
      "<updates ",
      `<!--${"x".repeat(MAX_MANIFEST_CHARS)}-->\n<updates `,
    );
    const r = await verifyManifest(await signed(big, primary), pinned(), subtle);
    expect(r).toEqual({ ok: false, reason: "manifest: larger than 64 KiB" });
  });

  test("a pinned key that is not a valid SPKI refuses, never throws", async () => {
    const broken = [{ id: primary.id, slot: "primary", spki: "AAAA" }];
    const r = await verifyManifest(await signed(manifest(), primary), broken, subtle);
    expect(r).toEqual({ ok: false, reason: "signature: does not verify" });
  });

  test("splitManifest returns the body and the pairs", async () => {
    const body = manifest();
    const text = await signed(body, primary, secondary);
    const r = splitManifest(text);
    expect(r).toMatchObject({ ok: true, body });
    expect(/** @type {any} */ (r).signatures.map((/** @type {any} */ s) => s.key)).toEqual([
      primary.id,
      secondary.id,
    ]);
  });

  test("base64 round trip and the key id (first 8 hex of the SPKI's SHA-256)", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    expect(base64Encode(new TextEncoder().encode("Man"))).toBe("TWFu");
    expect(base64Encode(new TextEncoder().encode("Ma"))).toBe("TWE=");
    expect(() => base64Decode("@@@@")).toThrow();
    const der = base64Decode(primary.spki);
    const hash = new Uint8Array(await subtle.digest("SHA-256", der));
    const hex = [...hash.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(primary.id).toBe(hex);
  });
});

describe("pinned keys (update-keys.mjs)", () => {
  test("every pinned key is an RSA-4096 SPKI whose id matches, one per slot", async () => {
    const slots = UPDATE_KEYS.map((k) => k.slot);
    expect(new Set(slots).size).toBe(slots.length);
    for (const k of UPDATE_KEYS) {
      expect(["primary", "secondary"]).toContain(k.slot);
      const der = base64Decode(k.spki);
      expect(await spkiKeyId(subtle, der)).toBe(k.id);
      const key = await subtle.importKey("spki", der, ALG, true, ["verify"]);
      expect(/** @type {any} */ (key.algorithm).modulusLength).toBe(4096);
    }
  });

  // The primary's SPKI SHA-256, as recorded in docs/runbook.md ("Pin the public keys"). A changed
  // key has to change both, so a swapped key cannot pass review as a formatting edit.
  const PRIMARY_SHA256 = "fb4d33b6ea54ddb81a6a40ce50a61a6f9383b5850f27e2218045f5d3a07dab9a";

  test("the shipped primary: exactly one, RSA-4096, the recorded key, verifies RSASSA-PKCS1-v1_5 SHA-384", async () => {
    const primaries = UPDATE_KEYS.filter((k) => k.slot === "primary");
    expect(primaries).toHaveLength(1);
    const [k] = primaries;
    const der = base64Decode(k.spki);
    const hash = new Uint8Array(await subtle.digest("SHA-256", der));
    expect([...hash].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(PRIMARY_SHA256);
    expect(k.id).toBe(PRIMARY_SHA256.slice(0, 8));
    expect(await spkiKeyId(subtle, der)).toBe(k.id);
    const key = await subtle.importKey("spki", der, ALG, false, ["verify"]);
    expect(key.algorithm).toMatchObject({
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-384" },
      modulusLength: 4096,
    });
  });

  test("the runbook records the pinned primary's id and SHA-256, and no secondary yet", () => {
    const runbook = readFileSync(new URL("../../../docs/runbook.md", import.meta.url), "utf8");
    const row = runbook.split("\n").find((l) => /^\| primary\s*\|/.test(l));
    expect(row).toContain(`\`${PRIMARY_SHA256.slice(0, 8)}\``);
    expect(row).toContain(`\`${PRIMARY_SHA256}\``);
    // The secondary is pinned in a later release; until then the shipped set is the primary.
    expect(UPDATE_KEYS.map((k) => k.slot)).toEqual(["primary"]);
  });

  test("a signature made as Cloud KMS makes it (raw PKCS#1 over a SHA-384 DigestInfo) verifies", async () => {
    // RSA_SIGN_RAW_PKCS1_4096 signs exactly the bytes it is sent, with PKCS#1 v1.5 type-1
    // padding; the signer sends the DER DigestInfo (SHA-384 prefix, then the 48-byte hash), as
    // the runbook's step 6 builds it. That is RSASSA-PKCS1-v1_5 SHA-384, so a pinned primary
    // alone must accept it.
    const { generateKeyPairSync, createHash, privateEncrypt, constants } =
      await import("node:crypto");
    const kms = generateKeyPairSync("rsa", { modulusLength: 4096 });
    const der = new Uint8Array(kms.publicKey.export({ type: "spki", format: "der" }));
    const pin = { id: await spkiKeyId(subtle, der), slot: "primary", spki: base64Encode(der) };
    const body = manifest();
    const SHA384_DIGESTINFO = Buffer.from("3041300d060960864801650304020205000430", "hex");
    const digestInfo = Buffer.concat([
      SHA384_DIGESTINFO,
      createHash("sha384").update(signedBytes(body)).digest(),
    ]);
    const raw = privateEncrypt(
      { key: kms.privateKey, padding: constants.RSA_PKCS1_PADDING },
      digestInfo,
    );
    const text = body + signatureComment([{ key: pin.id, sig: base64Encode(new Uint8Array(raw)) }]);
    const r = await verifyManifest(text, [/** @type {const} */ (pin)], subtle);
    expect(r).toEqual({ ok: true, body, key: { id: pin.id, slot: "primary" } });
    const flipped = text.replace('vimmaSerial="2', 'vimmaSerial="3');
    expect((await verifyManifest(flipped, [/** @type {const} */ (pin)], subtle)).ok).toBe(false);
  }, 30_000);
});

describe("parseManifest", () => {
  test("reads the channel, target, serial and the offer", () => {
    const r = parseManifest(
      manifest({ update: { vimmaUrgency: "security", vimmaAdvisories: "MFSA 2026-110" } }),
    );
    expect(r).toEqual({
      ok: true,
      manifest: {
        channel: "vimma",
        target: "Linux_x86_64-gcc3",
        serial: "20261028041207",
        update: {
          appVersion: "158.0.1",
          buildId: "20261028031500",
          displayVersion: "0.3.1",
          detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
          urgent: true,
          advisories: ["MFSA 2026-110"],
          assets: {},
        },
      },
    });
  });

  test("an empty <updates> offers nothing but still carries its serial", () => {
    expect(parseManifest(manifest({ update: null }))).toMatchObject({
      ok: true,
      manifest: { serial: "20261028041207", update: null },
    });
    const selfClosing =
      '<?xml version="1.0"?>\n<updates vimmaChannel="vimma" vimmaTarget="t" vimmaSerial="20261028041207"/>\n';
    expect(parseManifest(selfClosing)).toMatchObject({ ok: true, manifest: { update: null } });
  });

  const H = (/** @type {string} */ c) => c.repeat(128);
  const DL = "https://github.com/vimma-browser/vimma/releases/download/v0.3.1";
  /** @param {string} children */
  const withAssets = (children) => manifest().replace(/ {4}<patch [^\n]*\n/, children);
  const tarball = `    <vimmaTarball size="86804240" hashFunction="sha512" hashValue="${H("a")}" URL="${DL}/vimma-0.3.1-linux-x86_64.tar.xz"/>\n`;
  const appimage = `    <vimmaAppImage size="111966712" hashFunction="sha512" hashValue="${H("b")}" URL="${DL}/vimma-0.3.1-x86_64.AppImage"/>\n`;
  const deb = `    <vimmaDeb size="87718612" hashFunction="sha512" hashValue="${H("c")}" URL="${DL}/vimma_0.3.1_amd64.deb"/>\n`;
  const rpm = `    <vimmaRpm size="87921340" hashFunction="sha512" hashValue="${H("f")}" URL="${DL}/vimma-0.3.1-1.x86_64.rpm"/>\n`;

  test("reads each package's size and SHA-512 (the release pipeline's asset elements)", () => {
    const r = /** @type {any} */ (parseManifest(withAssets(tarball + appimage + deb + rpm)));
    expect(r.manifest.update.assets).toEqual({
      tarball: { size: 86804240, sha512: H("a"), url: `${DL}/vimma-0.3.1-linux-x86_64.tar.xz` },
      appimage: { size: 111966712, sha512: H("b"), url: `${DL}/vimma-0.3.1-x86_64.AppImage` },
      deb: { size: 87718612, sha512: H("c"), url: `${DL}/vimma_0.3.1_amd64.deb` },
      rpm: { size: 87921340, sha512: H("f"), url: `${DL}/vimma-0.3.1-1.x86_64.rpm` },
    });
    const one = /** @type {any} */ (parseManifest(withAssets(deb)));
    expect(one.manifest.update.assets).toEqual({
      deb: { size: 87718612, sha512: H("c"), url: `${DL}/vimma_0.3.1_amd64.deb` },
    });
  });

  test.each([
    ["a hash that is not SHA-512", rpm.replace(H("f"), "f".repeat(64))],
    ["a download on plain http", rpm.replace("https://", "http://")],
    ["two of them", rpm + rpm],
  ])("refuses a <vimmaRpm> with %s", (_name, children) => {
    const r = parseManifest(withAssets(children));
    expect(r.ok).toBe(false);
    expect(/** @type {any} */ (r).reason).toMatch(/^manifest: .*<vimmaRpm>/);
  });

  test.each([
    ["another hash function", deb.replace('"sha512"', '"sha256"')],
    ["a hash that is not 128 hex digits", deb.replace(H("c"), "c".repeat(64))],
    ["an upper-case hash", deb.replace(H("c"), "C".repeat(128))],
    ["a size that is not digits", deb.replace('"87718612"', '"-1"')],
    ["a download on plain http", deb.replace("https://", "http://")],
    ["the same package twice", deb + deb],
    ["no hash", deb.replace(/ hashValue="[^"]*"/, "")],
  ])("refuses an asset with %s", (_name, children) => {
    const r = parseManifest(withAssets(children));
    expect(r.ok).toBe(false);
    expect(/** @type {any} */ (r).reason).toMatch(/^manifest: /);
  });

  const dmg = `    <vimmaDmg size="110809760" hashFunction="sha512" hashValue="${H("e")}" URL="${DL}/vimma-0.3.1-macos-aarch64.dmg"/>\n`;

  test("reads the macOS manifest's <vimmaDmg> (macos-homebrew decision 18)", () => {
    const r = /** @type {any} */ (parseManifest(withAssets(dmg)));
    expect(r.manifest.update.assets).toEqual({
      dmg: { size: 110809760, sha512: H("e"), url: `${DL}/vimma-0.3.1-macos-aarch64.dmg` },
    });
  });

  test.each([
    ["a hash that is not SHA-512", dmg.replace(H("e"), "e".repeat(64))],
    ["a download on plain http", dmg.replace("https://", "http://")],
    ["two of them", dmg + dmg],
  ])("refuses a <vimmaDmg> with %s", (_name, children) => {
    const r = parseManifest(withAssets(children));
    expect(r.ok).toBe(false);
    expect(/** @type {any} */ (r).reason).toMatch(/^manifest: .*<vimmaDmg>/);
  });

  test("offerAssets keeps only well-formed entries (a saved result read back)", () => {
    const good = { size: 1, sha512: H("d") };
    expect(offerAssets({ deb: good, tarball: { size: "1", sha512: H("d") }, x: good })).toEqual({
      deb: good,
    });
    expect(offerAssets({ appimage: { size: 1, sha512: "d".repeat(64) } })).toEqual({});
    expect(offerAssets(null)).toEqual({});
    expect(offerAssets([good])).toEqual({});
    expect(offerAssets({ dmg: good, x: good })).toEqual({ dmg: good });
    expect(offerAssets({ rpm: good })).toEqual({ rpm: good });
  });

  test("offerAssets keeps a saved download URL only when it is https (decision 19)", () => {
    const url = `${DL}/vimma-0.3.1-x86_64.AppImage`;
    expect(offerAssets({ appimage: { size: 1, sha512: H("d"), url } })).toEqual({
      appimage: { size: 1, sha512: H("d"), url },
    });
    for (const bad of ["http://example.com/x", 7, "", "javascript:x"]) {
      expect(offerAssets({ appimage: { size: 1, sha512: H("d"), url: bad } })).toEqual({
        appimage: { size: 1, sha512: H("d") },
      });
    }
  });

  test("entities in attributes are decoded", () => {
    const r = parseManifest(
      manifest({
        update: { detailsURL: "https://github.com/vimma-browser/vimma/releases?a=1&amp;b=2" },
      }),
    );
    expect(/** @type {any} */ (r).manifest.update.detailsUrl).toBe(
      "https://github.com/vimma-browser/vimma/releases?a=1&b=2",
    );
  });

  test("comments are skipped in linear time; one that never closes is refused", () => {
    const many = manifest().replace("<updates ", `${"<!-- a -->".repeat(5000)}\n<updates `);
    expect(parseManifest(many).ok).toBe(true);
    const tags = manifest({ update: null }).replace(
      "</updates>",
      `${"<update\t".repeat(5000)}</updates>`,
    );
    expect(parseManifest(tags)).toEqual({ ok: false, reason: "manifest: <update> is not closed" });
    const open = manifest().replace("</updates>", `${"<!--".repeat(5000)}</updates>`);
    expect(parseManifest(open)).toEqual({ ok: false, reason: "manifest: a comment is not closed" });
  });

  test.each([
    ["not XML", "hello\n"],
    ["two updates", manifest().replace("</updates>", '<update appVersion="1"></update></updates>')],
    ["a DOCTYPE", manifest().replace("<updates", "<!DOCTYPE x>\n<updates")],
    ["no serial", manifest().replace(/ vimmaSerial="\d+"/, "")],
    ["a serial that is not a time", manifest({ serial: "2026" })],
    ["a version that is not SemVer", manifest({ update: { displayVersion: "0.3.1; rm -rf ~" } })],
    ["a Firefox version with spaces", manifest({ update: { appVersion: "158 .0" } })],
    ["a build ID that is not digits", manifest({ update: { buildID: "2026-10-28" } })],
    ["details on plain http", manifest({ update: { detailsURL: "http://example.com/" } })],
    ["an unknown urgency", manifest({ update: { vimmaUrgency: "panic" } })],
    ["duplicate attributes", manifest({ update: { type: 'minor" type="major' } })],
  ])("refuses %s", (_name, body) => {
    const r = parseManifest(body);
    expect(r.ok).toBe(false);
    expect(/** @type {any} */ (r).reason).toMatch(/^manifest: /);
  });
});

/** A Firefox-like version comparison for the tests (the host passes Services.vc.compare). */
const compare = (/** @type {string} */ a, /** @type {string} */ b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

describe("judgeManifest (§4 rules 2 to 4)", () => {
  const running = {
    channel: "vimma",
    target: "Linux_x86_64-gcc3",
    appVersion: "158.0",
    buildId: "20261020000000",
    displayVersion: "0.3.0",
    serial: /** @type {string | null} */ (null),
    now: Date.parse("2026-10-29T00:00:00Z"),
  };
  /** @param {Parameters<typeof manifest>[0]} [o] */
  const parsed = (o) => /** @type {any} */ (parseManifest(manifest(o))).manifest;

  test("a serial more than a day ahead of the clock is refused; up to a day is accepted", () => {
    const at = (/** @type {string} */ iso) => ({ ...running, now: Date.parse(iso) });
    // serial 2026-10-28 04:12:07 UTC
    expect(judgeManifest(parsed(), at("2026-10-27T04:12:08Z"), compare).ok).toBe(true);
    expect(judgeManifest(parsed(), at("2026-10-27T04:12:06Z"), compare)).toEqual({
      ok: false,
      reason: "future: serial 20261028041207 is more than a day ahead of this clock",
    });
  });

  test("a newer Firefox version is offered", () => {
    expect(judgeManifest(parsed(), running, compare)).toMatchObject({
      ok: true,
      serial: "20261028041207",
      offer: { displayVersion: "0.3.1", appVersion: "158.0.1" },
    });
  });

  test("channel and target mismatches are refused", () => {
    expect(judgeManifest(parsed({ channel: "vimma-nightly" }), running, compare)).toEqual({
      ok: false,
      reason: 'channel: the manifest is for "vimma-nightly", this install is on "vimma"',
    });
    expect(judgeManifest(parsed({ target: "Darwin_aarch64-gcc3" }), running, compare)).toEqual({
      ok: false,
      reason:
        'target: the manifest is for "Darwin_aarch64-gcc3", this install is "Linux_x86_64-gcc3"',
    });
  });

  test("replay: a serial below the one accepted, or below this build, is refused; equal is accepted", () => {
    const seen = { ...running, serial: "20261028041208" };
    expect(judgeManifest(parsed(), seen, compare)).toEqual({
      ok: false,
      reason: "replay: serial 20261028041207 is older than 20261028041208, already accepted",
    });
    expect(judgeManifest(parsed(), { ...running, serial: "20261028041207" }, compare).ok).toBe(
      true,
    );
    const newer = { ...running, buildId: "20261101000000" };
    expect(judgeManifest(parsed({ update: null }), newer, compare)).toEqual({
      ok: false,
      reason: "replay: serial 20261028041207 is older than this build (20261101000000)",
    });
  });

  test("downgrade: an older or equal build is no offer, not an error", () => {
    const older = parsed({ update: { appVersion: "157.0.1" } });
    expect(judgeManifest(older, running, compare)).toMatchObject({ ok: true, offer: null });
    const sameFx = { ...running, appVersion: "158.0.1" };
    const at = (/** @type {string} */ buildID) =>
      judgeManifest(parsed({ update: { buildID } }), sameFx, compare);
    expect(at("20261019000000")).toMatchObject({ ok: true, offer: null });
    expect(at("20261020000000")).toMatchObject({ ok: true, offer: null });
    expect(at("20261021000000")).toMatchObject({ ok: true, offer: { buildId: "20261021000000" } });
  });

  // #563: a release whose packaged application.ini has a later build ID than its binary offered
  // itself to itself. The Vimma version this build already is is never an update.
  test("the Vimma version already running is no offer, whatever its build ID", () => {
    const self = { ...running, appVersion: "158.0.1", displayVersion: "0.3.1" };
    const later = parsed({ update: { buildID: "20261027213312" } });
    expect(judgeManifest(later, self, compare)).toMatchObject({ ok: true, offer: null });
    expect(judgeManifest(later, { ...self, displayVersion: "0.3.0" }, compare)).toMatchObject({
      ok: true,
      offer: { displayVersion: "0.3.1" },
    });
  });

  test("build IDs compare as numbers, not strings", () => {
    const sameFx = { ...running, appVersion: "158.0.1", buildId: "9" };
    const r = judgeManifest(parsed({ update: { buildID: "10" } }), sameFx, compare);
    expect(r).toMatchObject({ ok: true, offer: { buildId: "10" } });
  });

  test("an empty manifest is accepted and offers nothing", () => {
    expect(judgeManifest(parsed({ update: null }), running, compare)).toEqual({
      ok: true,
      serial: "20261028041207",
      offer: null,
    });
  });
});

describe("staleDays (§4 rule 5)", () => {
  const at = (/** @type {string} */ iso) => Date.parse(iso);
  test("a release feed older than 45 days and a nightly one older than 7 are stale", () => {
    const serial = "20261001000000";
    expect(staleDays(serial, "vimma", at("2026-11-15T00:00:00Z"))).toBeNull();
    expect(staleDays(serial, "vimma", at("2026-11-16T00:00:01Z"))).toBe(46);
    expect(staleDays(serial, "vimma-nightly", at("2026-10-08T00:00:00Z"))).toBeNull();
    expect(staleDays(serial, "vimma-nightly", at("2026-10-09T12:00:00Z"))).toBe(8);
  });
});

describe("updateNotice (§5, the rows delivery 1 has)", () => {
  const offer = { displayVersion: "0.3.1", urgent: false };
  const state = {
    enabled: true,
    installType: /** @type {const} */ ("tarball"),
    offer: /** @type {{ displayVersion: string, urgent: boolean } | null} */ (null),
    refusals: 0,
    staleDays: /** @type {number | null} */ (null),
  };

  test("nothing when up to date, before any check, or when the host did not answer", () => {
    expect(updateNotice(state)).toBeNull();
  });

  test("an offer: ⇡ 0.3.1 available, dim; urgent: red, and says what to type", () => {
    expect(updateNotice({ ...state, offer })).toEqual({
      text: "⇡ 0.3.1 available",
      tone: "info",
    });
    expect(updateNotice({ ...state, offer: { ...offer, urgent: true } })).toEqual({
      text: "⇡ 0.3.1 security: :update",
      tone: "urgent",
    });
  });

  test("three refused manifests in a row: updates: check failed; fewer: nothing", () => {
    expect(updateNotice({ ...state, refusals: 2 })).toBeNull();
    expect(updateNotice({ ...state, refusals: 3 })).toEqual({
      text: "updates: check failed",
      tone: "warn",
    });
  });

  test("a stale feed says so; an offer wins over it", () => {
    expect(updateNotice({ ...state, staleDays: 46 })).toEqual({
      text: "updates: no news for 46 days",
      tone: "warn",
    });
    expect(updateNotice({ ...state, staleDays: 46, offer })?.text).toBe("⇡ 0.3.1 available");
  });

  test("an AppImage already replaced: ⇡ 0.3.1 on restart, dim; urgent: red (§5)", () => {
    expect(updateNotice({ ...state, installType: "appimage", offer, staged: true })).toEqual({
      text: "⇡ 0.3.1 on restart",
      tone: "info",
    });
    expect(
      updateNotice({
        ...state,
        installType: "appimage",
        offer: { ...offer, urgent: true },
        staged: true,
      }),
    ).toEqual({ text: "⇡ 0.3.1 security: :restart", tone: "urgent" });
  });

  test("checks off or a source build: nothing, offer or not (decision 14)", () => {
    expect(updateNotice({ ...state, enabled: false, offer, staleDays: 50 })).toBeNull();
    expect(updateNotice({ ...state, installType: "source", offer })).toBeNull();
  });

  test("checks off while the startup notice lasts: updates: off, dim (decision 38)", () => {
    const off = { ...state, enabled: false, offShown: true };
    expect(updateNotice(off)).toEqual({ text: "updates: off", tone: "info" });
    expect(updateNotice({ ...off, offer, staleDays: 50, refusals: 3 })?.text).toBe("updates: off");
    expect(updateNotice({ ...off, offShown: false })).toBeNull();
    expect(updateNotice({ ...off, installType: "source" })).toBeNull();
    // On is on: the flag means nothing while checks run.
    expect(updateNotice({ ...state, offShown: true })).toBeNull();
  });
});

describe("offNotice (decision 38: updates: off for a few seconds, once per session)", () => {
  const off = { enabled: false, installType: /** @type {const} */ ("tarball") };

  test("the first time checks are seen off, the clock starts and the notice shows", () => {
    expect(offNotice({ ...off, since: null, now: 1000 })).toEqual({ since: 1000, shown: true });
  });

  test("it shows for OFF_NOTICE_MS, then hides for the rest of the session", () => {
    expect(OFF_NOTICE_MS).toBeGreaterThanOrEqual(3000);
    expect(OFF_NOTICE_MS).toBeLessThanOrEqual(10000);
    const at = (/** @type {number} */ now) => offNotice({ ...off, since: 1000, now });
    expect(at(1000 + OFF_NOTICE_MS - 1)).toEqual({ since: 1000, shown: true });
    expect(at(1000 + OFF_NOTICE_MS)).toEqual({ since: 1000, shown: false });
    expect(at(1000 + 86400000)).toEqual({ since: 1000, shown: false });
  });

  test("checks on: no clock; turned off later in the session, it starts then, once", () => {
    expect(offNotice({ ...off, enabled: true, since: null, now: 5 })).toEqual({
      since: null,
      shown: false,
    });
    // On again and off again after it was shown: the clock is not restarted.
    expect(offNotice({ ...off, enabled: true, since: 1000, now: 2000 })).toEqual({
      since: 1000,
      shown: false,
    });
    expect(offNotice({ ...off, since: 1000, now: 1000 + OFF_NOTICE_MS + 5 }).shown).toBe(false);
  });

  test("a source build or an install type not known yet: no clock", () => {
    for (const installType of /** @type {const} */ (["source", null])) {
      expect(offNotice({ ...off, installType, since: null, now: 5 })).toEqual({
        since: null,
        shown: false,
      });
    }
  });
});

describe("the status-bar segment", () => {
  const base = { mode: /** @type {const} */ ("normal") };
  test("the notice is a right-side segment in its tone's colour, a theme token", () => {
    const tones = /** @type {const} */ ([
      ["info", "--vimma-fg-dim"],
      ["urgent", "--vimma-text-error"],
      ["warn", "--vimma-text-yellow"],
    ]);
    for (const [tone, fg] of tones) {
      const s = statusSegments({ ...base, update: { text: "⇡ 0.3.1 available", tone } }).find(
        (x) => x.id === "update",
      );
      expect(s).toMatchObject({ side: "right", fg, text: "⇡ 0.3.1 available" });
      expect(THEME_TOKENS.map((t) => t.name)).toContain(fg);
    }
    expect(statusSegments(base).some((s) => s.id === "update")).toBe(false);
  });

  test("an urgent notice outlasts the title; a plain one gives way before it", () => {
    const seg = (/** @type {"info" | "urgent"} */ tone) =>
      /** @type {any} */ (
        statusSegments({ ...base, update: { text: "x", tone } }).find((s) => s.id === "update")
      );
    expect(seg("urgent").priority).toBeLessThan(5);
    expect(seg("info").priority).toBeGreaterThan(5);
  });
});

describe("install type (§3)", () => {
  test.each([
    [{ packaged: false, marker: null, appImage: null }, "source"],
    [{ packaged: false, marker: "vimma-package=deb\n", appImage: null }, "source"],
    [{ packaged: true, marker: null, appImage: null }, "tarball"],
    [{ packaged: true, marker: "vimma-package=deb\n", appImage: null }, "deb"],
    [{ packaged: true, marker: "vimma-package=rpm\n", appImage: null }, "rpm"],
    [{ packaged: true, marker: "vimma-package=aur\n", appImage: null }, "aur"],
    [
      { packaged: true, marker: "vimma-package=pkgbuild-release\n", appImage: null },
      "pkgbuild-release",
    ],
    [{ packaged: true, marker: "vimma-package=appimage\n", appImage: null }, "appimage"],
    [{ packaged: true, marker: "", appImage: "/home/u/Vimma.AppImage" }, "appimage"],
    [{ packaged: true, marker: "", appImage: null }, "packaged"],
    [{ packaged: true, marker: "vimma-package=snap\n", appImage: null }, "packaged"],
  ])("%j → %s", (input, type) => {
    expect(installTypeFrom(input)).toBe(type);
  });

  // The lines tools/package/package.mjs writes; only an unmarked install is a tarball, and only a
  // tarball is told to unpack over its install directory (a .deb's belongs to dpkg).
  test.each([
    ["vimma-package=deb\n", null, "deb", /sudo apt install \.\/vimma_0\.3\.1_amd64\.deb$/],
    ["vimma-package=appimage\n", "/home/u/V.AppImage", "appimage", /x86_64\.AppImage &&/],
    ["vimma-package=pkgbuild-release\n", null, "pkgbuild-release", /makepkg -si$/],
    ["vimma-package=aur\n", null, "aur", /^yay -Syu vimma-bin$/],
    [null, null, "tarball", / && tar -xJf vimma-0\.3\.1-linux-x86_64\.tar\.xz -C \/usr\/lib$/],
  ])("marker %j → %s's own hint", (marker, appImage, type, command) => {
    const got = installTypeFrom({ packaged: true, marker, appImage });
    expect(got).toBe(type);
    const offer = {
      appVersion: "158.0.1",
      buildId: "20261028031500",
      displayVersion: "0.3.1",
      detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
      urgent: false,
      advisories: [],
      assets: {},
    };
    const steps = updateSteps(got, offer, { installDir: "/usr/lib/vimma", appImage });
    expect(steps.commands).toHaveLength(1);
    expect(steps.commands[0]).toMatch(command);
    expect(/\btar\b/.test(steps.commands[0] ?? "")).toBe(type === "tarball");
  });
});

describe("install type on macOS (macos-homebrew decisions 8 and 19)", () => {
  const mac = { marker: null, appImage: null, platform: "macosx" };
  test.each([
    [{ ...mac, packaged: false, appPath: "/Applications/Vimma.app", caskroom: true }, "source"],
    [{ ...mac, packaged: true, appPath: "/Applications/Vimma.app", caskroom: true }, "homebrew"],
    [{ ...mac, packaged: true, appPath: "/Applications/Vimma.app", caskroom: false }, "dmg"],
    [{ ...mac, packaged: true, appPath: "/Users/u/Applications/Vimma.app", caskroom: true }, "dmg"],
    [{ ...mac, packaged: true, appPath: null, caskroom: true }, "dmg"],
    [
      { ...mac, packaged: true, marker: "vimma-package=deb\n", appPath: null, caskroom: false },
      "dmg",
    ],
  ])("%j → %s", (input, type) => {
    expect(installTypeFrom(input)).toBe(type);
  });

  test("a Caskroom and an /Applications path change nothing on Linux", () => {
    const facts = { appPath: "/Applications/Vimma.app", caskroom: true };
    expect(
      installTypeFrom({
        packaged: true,
        marker: null,
        appImage: null,
        platform: "linux",
        ...facts,
      }),
    ).toBe("tarball");
    expect(
      installTypeFrom({
        packaged: true,
        marker: "vimma-package=deb\n",
        appImage: null,
        platform: "linux",
        ...facts,
      }),
    ).toBe("deb");
  });

  test.each([
    ["/Applications/Vimma.app/Contents/Resources", "/Applications/Vimma.app"],
    ["/Applications/Vimma.app/Contents/Resources/", "/Applications/Vimma.app"],
    ["/Users/u/My Apps/Vimma.app/Contents/Resources", "/Users/u/My Apps/Vimma.app"],
    ["/usr/lib/vimma", null],
    ["/Applications/Vimma.app/Contents/MacOS", null],
  ])("appBundleOf(%j) → %j", (gre, app) => {
    expect(appBundleOf(gre)).toBe(app);
  });
});

describe("updateSteps (:update and about:vimma)", () => {
  /** @type {import("../src/updates.mjs").Offer} */
  const offer = {
    appVersion: "158.0.1",
    buildId: "20261028031500",
    displayVersion: "0.3.1",
    detailsUrl: "https://github.com/vimma-browser/vimma/releases/tag/v0.3.1",
    urgent: false,
    advisories: [],
    assets: {},
  };
  const H = (/** @type {string} */ c) => c.repeat(128);
  /** @type {import("../src/updates.mjs").Offer} */
  const hashed = {
    ...offer,
    assets: {
      tarball: { size: 3, sha512: H("a") },
      appimage: { size: 4, sha512: H("b") },
      deb: { size: 5, sha512: H("c") },
      rpm: { size: 6, sha512: H("d") },
    },
  };
  const where = { installDir: "/home/u/apps/vimma", appImage: null };
  const dl = "https://github.com/vimma-browser/vimma/releases/download/v0.3.1";
  const curl = "curl -fL --proto =https";

  test("pkgbuild-release: the exact mkdir … && makepkg -si command (decision 24)", () => {
    expect(updateSteps("pkgbuild-release", offer, where).commands).toEqual([
      "mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si",
    ]);
  });

  test("aur: the AUR helper", () => {
    const s = updateSteps("aur", offer, where);
    expect(s.text).toMatch(/AUR helper/);
    expect(s.commands).toEqual(["yay -Syu vimma-bin"]);
  });

  test("deb: download, check the signed manifest's SHA-512, then install it with apt", () => {
    expect(updateSteps("deb", hashed, where).commands).toEqual([
      `${curl} -o vimma_0.3.1_amd64.deb ${dl}/vimma_0.3.1_amd64.deb` +
        ` && echo '${H("c")}  vimma_0.3.1_amd64.deb' | sha512sum -c -` +
        " && sudo apt install ./vimma_0.3.1_amd64.deb",
    ]);
    const pre = { ...offer, displayVersion: "0.4.0-rc.1" };
    expect(updateSteps("deb", pre, where).commands[0]).toContain("vimma_0.4.0~rc.1_amd64.deb");
  });

  // One .rpm serves Fedora and openSUSE (spec rpm-package): a command for each one's package
  // manager. zypper refuses an unsigned package unless told; SHA256SUMS' cosign signature and
  // the signed manifest's SHA-512 are what vouch for it, as for the .deb.
  test("rpm: download and check it, then install it with dnf or zypper", () => {
    const s = updateSteps("rpm", hashed, where);
    expect(s.text).toMatch(/dnf.*Fedora.*zypper.*openSUSE/);
    const fetch =
      `${curl} -o vimma-0.3.1-1.x86_64.rpm ${dl}/vimma-0.3.1-1.x86_64.rpm` +
      ` && echo '${H("d")}  vimma-0.3.1-1.x86_64.rpm' | sha512sum -c -`;
    expect(s.commands).toEqual([
      `${fetch} && sudo dnf install ./vimma-0.3.1-1.x86_64.rpm`,
      `${fetch} && sudo zypper install --allow-unsigned-rpm ./vimma-0.3.1-1.x86_64.rpm`,
    ]);
    const pre = { ...offer, displayVersion: "0.4.0-rc.1" };
    for (const c of updateSteps("rpm", pre, where).commands) {
      expect(c).toContain("./vimma-0.4.0~rc.1-1.x86_64.rpm");
      expect(c).not.toContain("sha512sum");
    }
  });

  test("tarball: quit, download and check it, then unpack over the install's parent, quoted", () => {
    const s = updateSteps("tarball", hashed, {
      installDir: "/home/u/my apps/vimma",
      appImage: null,
    });
    expect(s.text).toMatch(/^Quit Vimma/);
    expect(s.commands).toEqual([
      `${curl} -o vimma-0.3.1-linux-x86_64.tar.xz ${dl}/vimma-0.3.1-linux-x86_64.tar.xz` +
        ` && echo '${H("a")}  vimma-0.3.1-linux-x86_64.tar.xz' | sha512sum -c -` +
        ` && tar -xJf vimma-0.3.1-linux-x86_64.tar.xz -C '/home/u/my apps'`,
    ]);
  });

  test("appimage: download next to the file, check it, and rename it over, quoted", () => {
    const s = updateSteps("appimage", hashed, {
      installDir: "/tmp/.mount",
      appImage: "/home/u/it's.AppImage",
    });
    const next = "'/home/u/it'\\''s.AppImage.new'";
    expect(s.commands).toEqual([
      `${curl} -o ${next} ${dl}/vimma-0.3.1-x86_64.AppImage` +
        ` && echo '${H("b")}  /home/u/it'\\''s.AppImage.new' | sha512sum -c -` +
        ` && chmod +x ${next} && mv ${next} '/home/u/it'\\''s.AppImage'`,
    ]);
  });

  test("every download fails on an HTTP error and refuses anything but https (V-07)", () => {
    for (const type of /** @type {const} */ (["deb", "rpm", "tarball", "appimage"])) {
      for (const o of [offer, hashed]) {
        for (const command of updateSteps(type, o, where).commands) {
          expect(command.startsWith(`${curl} -o `), `${type}: ${command}`).toBe(true);
          expect(command).not.toMatch(/\| *(?:tar|sh|bash)\b/);
        }
      }
    }
  });

  test("without a hash in the manifest the download is still checked for errors, not hashed", () => {
    expect(updateSteps("deb", offer, where).commands).toEqual([
      `${curl} -o vimma_0.3.1_amd64.deb ${dl}/vimma_0.3.1_amd64.deb` +
        " && sudo apt install ./vimma_0.3.1_amd64.deb",
    ]);
    const onlyDeb = { ...offer, assets: { deb: hashed.assets.deb } };
    expect(updateSteps("tarball", onlyDeb, where).commands[0]).not.toContain("sha512sum");
  });

  test("the checked commands run: a matching file installs, a different one stops before", () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-steps-"));
    try {
      const file = join(dir, "x.AppImage");
      writeFileSync(file, "old");
      const body = "new appimage";
      const sha512 = createHash("sha512").update(body).digest("hex");
      const fake = join(dir, "curl");
      // A curl that writes the "download" to its -o argument.
      writeFileSync(
        fake,
        `#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\nprintf '%s' "$BODY" > "$2"\n`,
        { mode: 0o755 },
      );
      const run = (/** @type {string} */ hash) => {
        const o = { ...offer, assets: { appimage: { size: body.length, sha512: hash } } };
        const [cmd = ""] = updateSteps("appimage", o, { installDir: dir, appImage: file }).commands;
        return spawnSync("sh", ["-c", cmd], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BODY: body },
        }).status;
      };
      expect(run(H("0"))).not.toBe(0);
      expect(readFileSync(file, "utf8")).toBe("old");
      expect(run(sha512)).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("homebrew: brew upgrade --cask vimma (macos-homebrew decision 8)", () => {
    const s = updateSteps("homebrew", hashed, where);
    expect(s.commands).toEqual(["brew upgrade --cask vimma"]);
    expect(s.text).toMatch(/Homebrew/);
    expect(s.link).toBe(offer.detailsUrl);
  });

  test("dmg: the release page and the drag, with no command (macos-homebrew decision 19)", () => {
    const s = updateSteps(
      "dmg",
      { ...hashed, assets: { dmg: { size: 6, sha512: H("e") } } },
      where,
    );
    expect(s.commands).toEqual([]);
    expect(s.text).toMatch(/^Quit Vimma/);
    expect(s.text).toMatch(/\.dmg/);
    expect(s.text).toMatch(/Applications/);
    expect(s.text).toMatch(/first open/);
    expect(s.text).not.toMatch(/xattr|quarantine|curl/);
    expect(s.link).toBe(offer.detailsUrl);
  });

  test("an unknown package and a source build: words and the release page only", () => {
    expect(updateSteps("packaged", offer, where)).toMatchObject({ commands: [] });
    expect(updateSteps("source", offer, where).text).toMatch(/rebuild/);
    for (const t of /** @type {const} */ (["packaged", "source", "deb", "tarball"])) {
      expect(updateSteps(t, offer, where).link).toBe(offer.detailsUrl);
    }
  });

  test("shellQuote leaves plain paths alone and quotes the rest", () => {
    expect(shellQuote("/opt/vimma")).toBe("/opt/vimma");
    expect(shellQuote("/a b")).toBe("'/a b'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("$(x)")).toBe("'$(x)'");
  });
});

describe("the version line", () => {
  test("Vimma 0.3.1 · Firefox 158.0.1, and a nightly's", () => {
    expect(updateVersionLine({ displayVersion: "0.3.1", appVersion: "158.0.1" })).toBe(
      "Vimma 0.3.1 · Firefox 158.0.1",
    );
    expect(
      updateVersionLine({ displayVersion: "0.3.1-nightly.20261028", appVersion: "158.0.1" }),
    ).toBe("Vimma 0.3.1-nightly.20261028 · Firefox 158.0.1");
  });
});

describe("[updates] check (config.toml, schema 2) and the pref", () => {
  /** @param {string[]} lines */
  const v2 = (...lines) => ["schema = 2", ...lines].join("\n") + "\n";

  test("defaults to on; false turns it off", () => {
    expect(parseConfig(v2()).config?.updates).toEqual({ check: true });
    expect(parseConfig(v2("[updates]", "check = false")).config?.updates).toEqual({
      check: false,
    });
    expect(DEFAULT_CONFIG.updates).toEqual({ check: true });
    expect(formatDefaultsToml()).toMatch(/^\[updates\]\n(#.*\n)*check = true$/m);
  });

  test("a wrong type, an unknown key and schema 1 are errors", () => {
    const errs = (/** @type {string} */ t) =>
      parseConfig(t).errors.map((e) => ({ line: e.line, path: e.path, message: e.message }));
    expect(errs(v2("[updates]", 'check = "no"'))).toEqual([
      { line: 3, path: "updates.check", message: "expected a boolean, got a string" },
    ]);
    expect(errs(v2("[updates]", "chekc = false"))).toEqual([
      { line: 3, path: "updates.chekc", message: 'unknown key "chekc"' },
    ]);
    expect(errs("schema = 1\n[updates]\ncheck = false\n")).toEqual([
      {
        line: 2,
        path: "updates",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });

  test("a file with errors: a readable check = false holds; else the config in force, or held", () => {
    const broken = "schema = 2\n[updates]\ncheck = false\n[keys]\nnope = 1\n";
    expect(rawUpdatesCheck(broken)).toBe(false);
    expect(rawUpdatesCheck("schema = 2\n[updates\n")).toBeNull();
    expect(rawUpdatesCheck("schema = 2\n[updates]\ncheck = 'no'\n")).toBeNull();
    expect(
      updatesCheckAfterRead({ errors: 0, inForce: true, raw: null, hadConfig: false }),
    ).toEqual({
      check: true,
      held: false,
    });
    expect(
      updatesCheckAfterRead({ errors: 1, inForce: true, raw: false, hadConfig: true }),
    ).toEqual({
      check: false,
      held: false,
    });
    // Defaults stand in for a broken file at startup: no check until it is fixed.
    expect(
      updatesCheckAfterRead({ errors: 1, inForce: true, raw: null, hadConfig: false }),
    ).toEqual({
      check: false,
      held: true,
    });
    // A config was in force before: it stays, its check with it.
    expect(updatesCheckAfterRead({ errors: 1, inForce: true, raw: null, hadConfig: true })).toEqual(
      {
        check: true,
        held: false,
      },
    );
  });

  test("either the file or the pref turns checks off", () => {
    expect(updatesEnabled({ pref: true, config: { check: true } })).toBe(true);
    expect(updatesEnabled({ pref: false, config: { check: true } })).toBe(false);
    expect(updatesEnabled({ pref: true, config: { check: false } })).toBe(false);
    expect(updatesEnabled({ pref: true, config: null })).toBe(true);
  });
});

describe(":update and check_updates", () => {
  test(":update runs app.update_check", () => {
    expect(parseCommandLine(":update")).toEqual({
      kind: "run",
      command: "update",
      action: { id: "app.update_check" },
    });
  });

  test("check_updates exists and has no default key", () => {
    expect(getAction("check_updates")?.id).toBe("app.update_check");
    expect(compileKeymap().bindingsFor("check_updates")).toEqual([]);
  });
});
