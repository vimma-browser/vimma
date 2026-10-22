// docs/specs/m6a-updater.md §2 and §7: the update manifest a published release gets, built by
// tools/update/manifest.mjs, signed in update-publish.yml's `sign` job and checked before the
// push with the verifier the browser runs (packages/vimma-core/src/updates.mjs). Keys are
// generated here; nothing is fetched. A run with VIMMA_UPDATE_ASSETS=<dir> (a release's
// tarball, AppImage, .deb and SHA256SUMS, downloaded by hand) also builds, signs and verifies a
// manifest for those real files.
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, privateEncrypt, constants } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  base64Encode,
  parseManifest,
  signatureComment,
  signedBytes,
  spkiKeyId,
  verifyManifest,
} from "../../../packages/vimma-core/src/updates.mjs";
import {
  CHANNEL,
  MANIFEST_PATH,
  TARGET,
  assetNames,
  buildManifest,
  checkAssets,
  checkSigned,
  commitLabels,
  digestInfo,
  dmgInfo,
  manifestPath,
  nextSerial,
  parseSums,
  pinnedPem,
  prepareRelease,
  previousRelease,
  publishedTags,
  releaseInfo,
  serialAt,
  urgencyOf,
} from "../manifest.mjs";

const subtle = globalThis.crypto.subtle;
const HASH = (c) => c.repeat(128);
const RELEASES = "https://github.com/vimma-browser/vimma/releases";

/** An RSA-4096 key as Cloud KMS holds it, and the pin for it. */
async function kmsKey() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
  const der = new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }));
  const pin = /** @type {const} */ ({
    id: await spkiKeyId(subtle, der),
    slot: "primary",
    spki: base64Encode(der),
  });
  return { pair, pin };
}

/**
 * Signs as RSA_SIGN_RAW_PKCS1_4096 does: PKCS#1 v1.5 type-1 padding over the DigestInfo the
 * caller sends, nothing hashed by the key.
 * @param {string} body
 * @param {Awaited<ReturnType<typeof kmsKey>>} key
 */
function kmsSign(body, key) {
  const raw = privateEncrypt(
    { key: key.pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    digestInfo(body),
  );
  return body + signatureComment([{ key: key.pin.id, sig: raw.toString("base64") }]);
}

const offer = () => ({
  appVersion: "158.0.1",
  buildId: "20261028031500",
  displayVersion: "0.3.1",
  urgency: /** @type {"normal" | "security"} */ ("normal"),
  advisories: /** @type {string[]} */ ([]),
  assets: {
    tarball: { size: 86804240, sha512: HASH("a") },
    appimage: { size: 111966712, sha512: HASH("b") },
    deb: { size: 87718612, sha512: HASH("c") },
    rpm: { size: 87921340, sha512: HASH("d") },
  },
});

/** @type {Awaited<ReturnType<typeof kmsKey>>} */ let key;
/** @type {Awaited<ReturnType<typeof kmsKey>>} */ let stranger;
beforeAll(async () => {
  [key, stranger] = await Promise.all([kmsKey(), kmsKey()]);
}, 60_000);

const DL = "https://github.com/vimma-browser/vimma/releases/download/v0.3.1";

describe("buildManifest (spec §2)", () => {
  it("writes the format the client parses: channel, target and serial on <updates>, one <update>", () => {
    const body = buildManifest({ serial: "20261028041207", update: offer() });
    expect(body).toBe(
      '<?xml version="1.0"?>\n' +
        '<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261028041207">\n' +
        '  <update type="minor" appVersion="158.0.1" platformVersion="158.0.1"' +
        ' buildID="20261028031500" displayVersion="0.3.1"' +
        ` detailsURL="${RELEASES}/tag/v0.3.1" vimmaUrgency="normal">\n` +
        `    <vimmaTarball size="86804240" hashFunction="sha512" hashValue="${HASH("a")}"` +
        ` URL="${RELEASES}/download/v0.3.1/vimma-0.3.1-linux-x86_64.tar.xz"/>\n` +
        `    <vimmaAppImage size="111966712" hashFunction="sha512" hashValue="${HASH("b")}"` +
        ` URL="${RELEASES}/download/v0.3.1/vimma-0.3.1-x86_64.AppImage"/>\n` +
        `    <vimmaDeb size="87718612" hashFunction="sha512" hashValue="${HASH("c")}"` +
        ` URL="${RELEASES}/download/v0.3.1/vimma_0.3.1_amd64.deb"/>\n` +
        `    <vimmaRpm size="87921340" hashFunction="sha512" hashValue="${HASH("d")}"` +
        ` URL="${RELEASES}/download/v0.3.1/vimma-0.3.1-1.x86_64.rpm"/>\n` +
        "  </update>\n" +
        "</updates>\n",
    );
    const parsed = parseManifest(body);
    expect(parsed).toEqual({
      ok: true,
      manifest: {
        channel: CHANNEL,
        target: TARGET,
        serial: "20261028041207",
        update: {
          appVersion: "158.0.1",
          buildId: "20261028031500",
          displayVersion: "0.3.1",
          detailsUrl: `${RELEASES}/tag/v0.3.1`,
          urgent: false,
          advisories: [],
          assets: {
            tarball: {
              size: 86804240,
              sha512: HASH("a"),
              url: `${DL}/vimma-0.3.1-linux-x86_64.tar.xz`,
            },
            appimage: {
              size: 111966712,
              sha512: HASH("b"),
              url: `${DL}/vimma-0.3.1-x86_64.AppImage`,
            },
            deb: { size: 87718612, sha512: HASH("c"), url: `${DL}/vimma_0.3.1_amd64.deb` },
            rpm: { size: 87921340, sha512: HASH("d"), url: `${DL}/vimma-0.3.1-1.x86_64.rpm` },
          },
        },
      },
    });
  });

  it("marks a security release and lists its advisories", () => {
    const body = buildManifest({
      serial: "20261028041207",
      update: { ...offer(), urgency: "security", advisories: ["MFSA 2026-110", "MFSA 2026-111"] },
    });
    expect(body).toContain(
      'vimmaUrgency="security" vimmaAdvisories="MFSA 2026-110, MFSA 2026-111"',
    );
    const parsed = /** @type {any} */ (parseManifest(body));
    expect(parsed.manifest.update.urgent).toBe(true);
    expect(parsed.manifest.update.advisories).toEqual(["MFSA 2026-110", "MFSA 2026-111"]);
  });

  it("offers nothing with an empty <updates> that still carries its serial (the kill switch)", () => {
    const body = buildManifest({ serial: "20261028041207", update: null });
    expect(body).toBe(
      '<?xml version="1.0"?>\n' +
        '<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261028041207">\n' +
        "</updates>\n",
    );
    expect(parseManifest(body)).toMatchObject({ ok: true, manifest: { update: null } });
  });

  it.each([
    ["a serial that is not a UTC time", { serial: "2026" }],
    ["a version that is not X.Y.Z", { update: { displayVersion: '0.3.1" x="' } }],
    ["a Firefox version with a quote", { update: { appVersion: '158.0"' } }],
    ["a build ID that is not digits", { update: { buildId: "2026-10-28" } }],
    ["an unknown urgency", { update: { urgency: "panic" } }],
    ["an advisory that is not an MFSA ID", { update: { advisories: ["CVE-2026-1"] } }],
    [
      "a hash that is not SHA-512 hex",
      { update: { assets: { ...offer().assets, deb: { size: 1, sha512: "ab" } } } },
    ],
    [
      "a size that is not a whole number",
      { update: { assets: { ...offer().assets, deb: { size: 1.5, sha512: HASH("c") } } } },
    ],
    [
      "a missing asset",
      {
        update: { assets: { tarball: offer().assets.tarball, appimage: offer().assets.appimage } },
      },
    ],
  ])("refuses %s rather than writing it", (_name, change) => {
    const input = {
      serial: change.serial ?? "20261028041207",
      update: { ...offer(), .../** @type {any} */ (change.update ?? {}) },
    };
    expect(() => buildManifest(/** @type {any} */ (input))).toThrow();
  });

  it("names the release's files as package.mjs does", () => {
    expect(assetNames("0.3.1")).toEqual({
      tarball: "vimma-0.3.1-linux-x86_64.tar.xz",
      appimage: "vimma-0.3.1-x86_64.AppImage",
      deb: "vimma_0.3.1_amd64.deb",
      rpm: "vimma-0.3.1-1.x86_64.rpm",
    });
  });

  it("is published at the path Firefox's URL template gives the release channel", () => {
    expect(MANIFEST_PATH).toBe("public/updates/browser/Linux_x86_64-gcc3/vimma/update.xml");
  });
});

describe("the serial (spec §2, §4 rule 3)", () => {
  it("is the UTC time of the build, YYYYMMDDhhmmss", () => {
    expect(serialAt(new Date(Date.UTC(2026, 9, 28, 4, 12, 7)))).toBe("20261028041207");
  });

  it("must be newer than the published manifest's; equal or older is refused", () => {
    const now = new Date(Date.UTC(2026, 9, 28, 4, 12, 7));
    expect(nextSerial(now, null)).toBe("20261028041207");
    expect(nextSerial(now, "20261028041206")).toBe("20261028041207");
    expect(() => nextSerial(now, "20261028041207")).toThrow(/not newer/);
    expect(() => nextSerial(now, "20261101000000")).toThrow(/not newer/);
  });

  it("compares as numbers, not as text", () => {
    expect(() => nextSerial(new Date(Date.UTC(2026, 9, 28)), "9")).not.toThrow();
  });
});

describe("SHA256SUMS", () => {
  const sums =
    `${"1".repeat(64)}  PKGBUILD\n` +
    `${"2".repeat(64)}  vimma-0.3.1-linux-x86_64.tar.xz\n` +
    `${"3".repeat(64)}  vimma-0.3.1-x86_64.AppImage\n` +
    `${"4".repeat(64)}  vimma_0.3.1_amd64.deb\n`;
  const files = {
    tarball: { name: "vimma-0.3.1-linux-x86_64.tar.xz", sha256: "2".repeat(64) },
    appimage: { name: "vimma-0.3.1-x86_64.AppImage", sha256: "3".repeat(64) },
    deb: { name: "vimma_0.3.1_amd64.deb", sha256: "4".repeat(64) },
  };

  it("reads `<sha256>  <name>` lines", () => {
    expect(parseSums(sums).get("vimma_0.3.1_amd64.deb")).toBe("4".repeat(64));
  });

  it("refuses a malformed line and a file named twice", () => {
    expect(() => parseSums("xyz  a\n")).toThrow();
    expect(() => parseSums(`${"1".repeat(64)}  a\n${"2".repeat(64)}  a\n`)).toThrow(/twice/);
  });

  it("every asset must be listed with the hash of the file that was downloaded", () => {
    expect(() => checkAssets(parseSums(sums), files)).not.toThrow();
    const swapped = { ...files, deb: { ...files.deb, sha256: "5".repeat(64) } };
    expect(() => checkAssets(parseSums(sums), swapped)).toThrow(/vimma_0\.3\.1_amd64\.deb/);
    const unlisted = sums.replace(/^.*AppImage\n/m, "");
    expect(() => checkAssets(parseSums(unlisted), files)).toThrow(/not in SHA256SUMS/);
  });
});

describe("urgency (spec §7)", () => {
  /** @param {string} subject @param {string[]} [labels] */
  const c = (subject, labels = []) => ({ subject, labels });

  it("a Firefox bump with advisories is a security release and lists them", () => {
    expect(
      urgencyOf([
        c("feat(hints): bigger labels (#300)"),
        c("upstream: firefox 158.0.1 (MFSA 2026-110, MFSA 2026-111) (#301)", [
          "upstream",
          "security",
        ]),
      ]),
    ).toEqual({ urgency: "security", advisories: ["MFSA 2026-110", "MFSA 2026-111"] });
  });

  it("a bump whose advisories were unknown carries the security label: security (G3)", () => {
    expect(urgencyOf([c("upstream: firefox 158.0.2 (#302)", ["upstream", "security"])])).toEqual({
      urgency: "security",
      advisories: [],
    });
  });

  it("a bump without an advisory or the label is normal", () => {
    expect(urgencyOf([c("upstream: firefox 158.0.2 (#302)", ["upstream"])])).toEqual({
      urgency: "normal",
      advisories: [],
    });
  });

  it("a fix(security) commit, or any change labelled security, is a security release", () => {
    expect(
      urgencyOf([c("fix(security): ship release firefox's devtools defaults (#318)")]).urgency,
    ).toBe("security");
    expect(urgencyOf([c("fix(hints): escape labels (#320)", ["security"])]).urgency).toBe(
      "security",
    );
  });

  it("other commits, security-sounding or not, are normal", () => {
    expect(
      urgencyOf([
        c("ci(security): require a maintainer label (#291)"),
        c("docs(security): a model"),
        c("feat(updates): more"),
      ]),
    ).toEqual({ urgency: "normal", advisories: [] });
  });

  it("lists each advisory once, in order", () => {
    expect(
      urgencyOf([
        c("upstream: firefox 158.0.1 (MFSA 2026-110)"),
        c("upstream: firefox 158.0.2 (MFSA 2026-110, MFSA 2026-112)"),
      ]).advisories,
    ).toEqual(["MFSA 2026-110", "MFSA 2026-112"]);
  });

  it("counts from the newest published release below this one", () => {
    expect(previousRelease(["v0.1.1", "v0.1.3", "v0.1.10", "v0.2.0"], "v0.1.11")).toBe("v0.1.10");
    expect(previousRelease(["v0.1.1"], "v0.1.1")).toBe(null);
    expect(previousRelease(["nightly", "v0.1.1-rc.1", "v0.1.0"], "v0.1.2")).toBe("v0.1.0");
  });
});

describe("reading a commit's labels (spec §7: urgency fails closed)", () => {
  /** An error as execFileSync throws it when gh exits non-zero. */
  const ghError = (/** @type {string} */ stderr) =>
    Object.assign(new Error("Command failed: gh api"), { stderr });
  const HTTP_500 = ghError("unexpected end of JSON input\n");
  /** A gh that answers with `replies` in turn (an Error is thrown), and the waits it was given. */
  const fake = (/** @type {(string | Error)[]} */ ...replies) => {
    const calls = /** @type {string[][]} */ ([]);
    const waits = /** @type {number[]} */ ([]);
    const run = (/** @type {string[]} */ args) => {
      calls.push(args);
      const r = replies[Math.min(calls.length, replies.length) - 1];
      if (r instanceof Error) throw r;
      return r ?? "";
    };
    return { run, sleep: async (/** @type {number} */ ms) => void waits.push(ms), calls, waits };
  };

  /** The commits/<sha>/pulls response for pull requests carrying these labels. */
  const pulls = (/** @type {string[][]} */ ...labels) =>
    JSON.stringify(
      labels.map((names, i) => ({ number: i + 1, labels: names.map((name) => ({ name })) })),
    );

  it("retries a transient failure, then reads the labels", async () => {
    const gh = fake(HTTP_500, pulls(["upstream", "security"], ["security"]));
    await expect(commitLabels("abc", "vimma-browser/vimma", gh)).resolves.toEqual([
      "security",
      "upstream",
    ]);
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]).toContain("repos/vimma-browser/vimma/commits/abc/pulls");
    expect(gh.calls[0]).not.toContain("--jq");
    expect(gh.waits).toEqual([2000]);
  });

  it("retries an HTTP 5xx and a network error as transient", async () => {
    const gh = fake(
      ghError("gh: Server Error (HTTP 502)\n"),
      ghError("Get https://api.github.com/: dial tcp: i/o timeout\n"),
      pulls(["security"]),
    );
    await expect(commitLabels("abc", "o/r", gh)).resolves.toEqual(["security"]);
    expect(gh.waits).toEqual([2000, 4000]);
  });

  it("retries a successful exit whose body is not JSON", async () => {
    const gh = fake("", '[{"labels":[{"na', pulls(["security"]));
    await expect(commitLabels("abc", "o/r", gh)).resolves.toEqual(["security"]);
    expect(gh.waits).toEqual([2000, 4000]);
  });

  it("a commit with no pull request or no labels has none", async () => {
    await expect(commitLabels("abc", "o/r", fake(pulls()))).resolves.toEqual([]);
    await expect(commitLabels("abc", "o/r", fake(pulls([])))).resolves.toEqual([]);
  });

  it.each([
    ["an object", "{}"],
    ["null", "null"],
    ["a pull request without labels", '[{"number":1}]'],
    ["a pull request that is not an object", "[null]"],
    ["labels that are not a list", '[{"labels":{}}]'],
    ["a label without a string name", '[{"labels":[{"name":7}]}]'],
  ])("throws at once on %s instead of answering no labels", async (_, body) => {
    const gh = fake(body, pulls(["security"]));
    await expect(commitLabels("abc", "o/r", gh)).rejects.toThrow(/labels of abc/);
    expect(gh.calls).toHaveLength(1);
  });

  it("throws after four attempts that all fail, never answering no labels", async () => {
    const gh = fake(HTTP_500);
    await expect(commitLabels("abc", "o/r", gh)).rejects.toThrow(/abc.*4 attempts/s);
    expect(gh.calls).toHaveLength(4);
    expect(gh.waits).toEqual([2000, 4000, 8000]);
  });

  it("throws at once on a failure that is not transient", async () => {
    const gh = fake(ghError("gh: Not Found (HTTP 404)\n"), pulls(["security"]));
    await expect(commitLabels("abc", "o/r", gh)).rejects.toThrow(/HTTP 404/);
    expect(gh.calls).toHaveLength(1);
    expect(gh.waits).toEqual([]);
  });
});

describe("reading the published releases (spec §7: the range of commits)", () => {
  const ghError = (/** @type {string} */ stderr) =>
    Object.assign(new Error("Command failed: gh api"), { stderr });
  const fake = (/** @type {(string | Error)[]} */ ...replies) => {
    const calls = /** @type {string[][]} */ ([]);
    const waits = /** @type {number[]} */ ([]);
    const run = (/** @type {string[]} */ args) => {
      calls.push(args);
      const r = replies[Math.min(calls.length, replies.length) - 1];
      if (r instanceof Error) throw r;
      return r ?? "";
    };
    return { run, sleep: async (/** @type {number} */ ms) => void waits.push(ms), calls, waits };
  };
  /** One entry of the releases list. */
  const release = (/** @type {string} */ tag_name, draft = false, prerelease = false) => ({
    tag_name,
    draft,
    prerelease,
  });
  /** The releases list as `gh api --paginate --slurp` prints it: a list of pages. */
  const pages = (/** @type {object[][]} */ ...p) => JSON.stringify(p);

  it("reads the published releases' tags from every page", async () => {
    const gh = fake(
      ghError("gh: Server Error (HTTP 500)\n"),
      pages(
        [release("v0.1.8", true), release("v0.1.7"), release("v0.1.7-rc.1", false, true)],
        [release("v0.1.6")],
      ),
    );
    await expect(publishedTags("v0.1.7", "o/r", gh)).resolves.toEqual(["v0.1.7", "v0.1.6"]);
    expect(gh.calls[0]).toEqual(
      expect.arrayContaining(["repos/o/r/releases", "--paginate", "--slurp"]),
    );
    expect(gh.calls[0]).not.toContain("--jq");
    expect(gh.waits).toEqual([2000]);
  });

  it.each([
    ["an object", "{}"],
    ["null", "null"],
    ["a page that is an object", "[{}]"],
    ["a release without a tag", '[[{"draft":false,"prerelease":false}]]'],
    ["a release without its draft flag", '[[{"tag_name":"v0.1.7","prerelease":false}]]'],
    ["no pages", "[]"],
    ["a list without the current tag", pages([release("v0.1.6")])],
    ["a list with the current tag only as a draft", pages([release("v0.1.7", true)])],
  ])("throws at once on %s instead of widening the range", async (_, body) => {
    const gh = fake(body, pages([release("v0.1.7")]));
    await expect(publishedTags("v0.1.7", "o/r", gh)).rejects.toThrow(/published releases/);
    expect(gh.calls).toHaveLength(1);
  });
});

describe("signing round trip (the verifier the browser runs)", () => {
  it("a manifest signed as Cloud KMS signs verifies under the pinned key, and only it", async () => {
    const body = buildManifest({ serial: "20261028041207", update: offer() });
    const text = kmsSign(body, key);
    expect(await verifyManifest(text, [key.pin], subtle)).toEqual({
      ok: true,
      body,
      key: { id: key.pin.id, slot: "primary" },
    });
    expect((await verifyManifest(text, [stranger.pin], subtle)).ok).toBe(false);
    const changed = text.replace('hashValue="a', 'hashValue="b');
    expect((await verifyManifest(changed, [key.pin], subtle)).ok).toBe(false);
  }, 30_000);

  it("digestInfo is the SHA-384 DigestInfo of the prefixed body", () => {
    const body = buildManifest({ serial: "20261028041207", update: null });
    const prefix = Buffer.from("3041300d060960864801650304020205000430", "hex");
    const hash = createHash("sha384").update(signedBytes(body)).digest();
    expect(digestInfo(body)).toEqual(Buffer.concat([prefix, hash]));
  });

  it("pinnedPem is the pinned primary as a PEM public key openssl reads", () => {
    const pem = pinnedPem();
    expect(pem).toMatch(
      /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/,
    );
    const dir = tempDir("vimma-pem-");
    writeFileSync(join(dir, "k.pem"), pem);
    const text = execFileSync(
      "openssl",
      ["pkey", "-pubin", "-in", join(dir, "k.pem"), "-text_pub", "-noout"],
      {
        encoding: "utf8",
      },
    );
    expect(text).toMatch(/4096 bit/);
  });
});

/**
 * A release directory as the download step leaves it: the three assets (a real tar.xz with
 * vimma/application.ini, as `./mach package` makes) and SHA256SUMS.
 * @param {string} version
 * @param {{ ini?: string }} [options]
 */
function fakeRelease(version, { ini } = {}) {
  const dir = tempDir("vimma-release-");
  const names = assetNames(version);
  const src = join(dir, "src");
  mkdirSync(join(src, "vimma"), { recursive: true });
  writeFileSync(
    join(src, "vimma", "application.ini"),
    ini ?? "[App]\nVendor=Vimma\nName=Vimma\nVersion=158.0\nBuildID=20261016111135\n",
  );
  execFileSync("tar", ["-cJf", join(dir, names.tarball), "-C", src, "vimma"]);
  writeFileSync(join(dir, names.appimage), `appimage ${version}`);
  writeFileSync(join(dir, names.deb), `deb ${version}`);
  writeFileSync(join(dir, names.rpm), `rpm ${version}`);
  const sha = (/** @type {string} */ n) =>
    createHash("sha256")
      .update(readFileSync(join(dir, n)))
      .digest("hex");
  writeFileSync(
    join(dir, "SHA256SUMS"),
    Object.values(names)
      .map((n) => `${sha(n)}  ${n}\n`)
      .join(""),
  );
  return dir;
}

describe("prepareRelease and checkSigned (the jobs' checks)", () => {
  const now = new Date(Date.UTC(2026, 9, 28, 4, 12, 7));
  const commits = [
    { subject: "upstream: firefox 158.0 (MFSA 2026-106) (#186)", labels: ["upstream"] },
  ];

  it("reads Firefox's version and the build ID from the tarball's application.ini", () => {
    const dir = fakeRelease("0.3.1");
    expect(releaseInfo(join(dir, assetNames("0.3.1").tarball))).toEqual({
      appVersion: "158.0",
      buildId: "20261016111135",
    });
  });

  it("builds the manifest from the files, their sums, the commits and the published serial", () => {
    const dir = fakeRelease("0.3.1");
    const { body, version } = prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now });
    expect(version).toBe("0.3.1");
    const m = /** @type {any} */ (parseManifest(body)).manifest;
    expect(m.serial).toBe("20261028041207");
    expect(m.update).toMatchObject({
      appVersion: "158.0",
      buildId: "20261016111135",
      displayVersion: "0.3.1",
      urgent: true,
      advisories: ["MFSA 2026-106"],
    });
    const deb = readFileSync(join(dir, "vimma_0.3.1_amd64.deb"));
    expect(m.update.assets.deb).toEqual({
      size: deb.length,
      sha512: createHash("sha512").update(deb).digest("hex"),
      url: "https://github.com/vimma-browser/vimma/releases/download/v0.3.1/vimma_0.3.1_amd64.deb",
    });
    const rpm = readFileSync(join(dir, "vimma-0.3.1-1.x86_64.rpm"));
    expect(m.update.assets.rpm).toEqual({
      size: rpm.length,
      sha512: createHash("sha512").update(rpm).digest("hex"),
      url: "https://github.com/vimma-browser/vimma/releases/download/v0.3.1/vimma-0.3.1-1.x86_64.rpm",
    });
  });

  it("refuses a file that does not match SHA256SUMS", () => {
    const dir = fakeRelease("0.3.1");
    writeFileSync(join(dir, "vimma-0.3.1-x86_64.AppImage"), "swapped");
    expect(() => prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now })).toThrow(
      /vimma-0\.3\.1-x86_64\.AppImage/,
    );
  });

  it("refuses a missing asset", () => {
    const dir = fakeRelease("0.3.1");
    execFileSync("rm", [join(dir, "vimma_0.3.1_amd64.deb")]);
    expect(() => prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now })).toThrow(
      /vimma_0\.3\.1_amd64\.deb/,
    );
  });

  it("refuses a tag that is not vX.Y.Z, and an application.ini without a build ID", () => {
    const dir = fakeRelease("0.3.1");
    expect(() => prepareRelease({ tag: "0.3.1", dir, commits, published: null, now })).toThrow();
    const bad = fakeRelease("0.3.1", { ini: "[App]\nVersion=158.0\n" });
    expect(() =>
      prepareRelease({ tag: "v0.3.1", dir: bad, commits, published: null, now }),
    ).toThrow(/BuildID/);
  });

  it("refuses when the published manifest's serial is not older", () => {
    const dir = fakeRelease("0.3.1");
    const published = kmsSign(buildManifest({ serial: "20261028041207", update: null }), key);
    expect(() => prepareRelease({ tag: "v0.3.1", dir, commits, published, now })).toThrow(
      /not newer/,
    );
  });

  it("refuses to offer an older version than the published manifest does", () => {
    const dir = fakeRelease("0.3.1");
    const published = kmsSign(
      buildManifest({ serial: "20261027000000", update: { ...offer(), displayVersion: "0.3.2" } }),
      key,
    );
    expect(() => prepareRelease({ tag: "v0.3.1", dir, commits, published, now })).toThrow(/older/);
  });

  it("checkSigned accepts the signed manifest and the files it names", async () => {
    const dir = fakeRelease("0.3.1");
    const { body } = prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now });
    const r = await checkSigned(kmsSign(body, key), {
      keys: [key.pin],
      tag: "v0.3.1",
      dir,
      published: null,
      now,
    });
    expect(r).toMatchObject({ serial: "20261028041207", key: key.pin.id });
  }, 30_000);

  it("checkSigned refuses another key, a changed file, an older serial and another version", async () => {
    const dir = fakeRelease("0.3.1");
    const { body } = prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now });
    const opts = { keys: [key.pin], tag: "v0.3.1", dir, published: null, now };
    await expect(checkSigned(kmsSign(body, stranger), opts)).rejects.toThrow(/signature/);
    const text = kmsSign(body, key);
    await expect(checkSigned(text, { ...opts, tag: "v0.3.2" })).rejects.toThrow(/0\.3\.2/);
    const published = kmsSign(buildManifest({ serial: "20261028041207", update: null }), key);
    await expect(checkSigned(text, { ...opts, published })).rejects.toThrow(/not newer/);
    writeFileSync(join(dir, "vimma_0.3.1_amd64.deb"), "deb 0.3.1 swapped");
    await expect(checkSigned(text, opts)).rejects.toThrow(/vimma_0\.3\.1_amd64\.deb/);
  }, 30_000);

  it("checkSigned with no tag accepts only a manifest that offers nothing", async () => {
    const empty = kmsSign(buildManifest({ serial: "20261028041207", update: null }), key);
    const opts = { keys: [key.pin], tag: null, dir: null, published: null, now };
    await expect(checkSigned(empty, opts)).resolves.toMatchObject({ serial: "20261028041207" });
    const dir = fakeRelease("0.3.1");
    const { body } = prepareRelease({ tag: "v0.3.1", dir, commits, published: null, now });
    await expect(checkSigned(kmsSign(body, key), opts)).rejects.toThrow(/offers/);
  }, 30_000);

  it("an unsigned or unreadable published manifest stops the run: its floor is unknown", () => {
    const dir = fakeRelease("0.3.1");
    for (const published of [buildManifest({ serial: "20261027000000", update: null }), "<html>"]) {
      expect(() => prepareRelease({ tag: "v0.3.1", dir, commits, published, now })).toThrow(
        /the published manifest/,
      );
    }
  });

  it("checkSigned refuses a serial more than a day ahead of the clock", async () => {
    const later = new Date(now.getTime() + 2 * 86_400_000);
    const text = kmsSign(buildManifest({ serial: serialAt(later), update: null }), key);
    await expect(
      checkSigned(text, { keys: [key.pin], tag: null, dir: null, published: null, now }),
    ).rejects.toThrow(/ahead/);
  }, 30_000);
});

/**
 * A macOS release directory as the download step leaves it: the .dmg and SHA256SUMS-macos, which
 * also lists the cask (release.yml's macos-package job).
 * @param {string} version
 */
function fakeMacRelease(version) {
  const dir = tempDir("vimma-release-macos-");
  const dmg = assetNames(version, "macos").dmg;
  writeFileSync(join(dir, dmg), `dmg ${version}`);
  writeFileSync(join(dir, "vimma.rb"), "cask");
  const sha = (/** @type {string} */ n) =>
    createHash("sha256")
      .update(readFileSync(join(dir, n)))
      .digest("hex");
  writeFileSync(
    join(dir, "SHA256SUMS-macos"),
    `${sha(dmg)}  ${dmg}\n${sha("vimma.rb")}  vimma.rb\n`,
  );
  return dir;
}

describe("the macOS manifest (spec macos-homebrew, decisions 16 to 18)", () => {
  const now = new Date(Date.UTC(2026, 9, 28, 4, 12, 7));
  const macInfo = () => ({ appVersion: "158.0", buildId: "20261019132138" });
  const macOffer = () => ({ ...offer(), assets: { dmg: { size: 90000000, sha512: HASH("d") } } });

  it("names the .dmg as release.yml does and publishes at the Darwin target's path", () => {
    expect(assetNames("0.3.1", "macos")).toEqual({ dmg: "vimma-0.3.1-macos-aarch64.dmg" });
    expect(manifestPath("macos")).toBe(
      "public/updates/browser/Darwin_aarch64-gcc3/vimma/update.xml",
    );
    expect(manifestPath("linux")).toBe(MANIFEST_PATH);
  });

  it("writes the Darwin target and only the <vimmaDmg> element", () => {
    const body = buildManifest({ serial: "20261028041207", update: macOffer(), os: "macos" });
    expect(body).toBe(
      '<?xml version="1.0"?>\n' +
        '<updates vimmaChannel="vimma" vimmaTarget="Darwin_aarch64-gcc3" vimmaSerial="20261028041207">\n' +
        '  <update type="minor" appVersion="158.0.1" platformVersion="158.0.1"' +
        ' buildID="20261028031500" displayVersion="0.3.1"' +
        ` detailsURL="${RELEASES}/tag/v0.3.1" vimmaUrgency="normal">\n` +
        `    <vimmaDmg size="90000000" hashFunction="sha512" hashValue="${HASH("d")}"` +
        ` URL="${RELEASES}/download/v0.3.1/vimma-0.3.1-macos-aarch64.dmg"/>\n` +
        "  </update>\n" +
        "</updates>\n",
    );
    expect(parseManifest(body)).toMatchObject({
      ok: true,
      manifest: { target: "Darwin_aarch64-gcc3", update: { assets: macOffer().assets } },
    });
    expect(() => buildManifest({ serial: "20261028041207", update: offer(), os: "macos" })).toThrow(
      /macos-aarch64\.dmg/,
    );
  });

  it("builds from the .dmg, SHA256SUMS-macos and the Mac build's own application.ini", () => {
    const dir = fakeMacRelease("0.3.1");
    const { body } = prepareRelease({
      tag: "v0.3.1",
      dir,
      commits: [],
      published: null,
      now,
      os: "macos",
      appInfo: macInfo,
    });
    const m = /** @type {any} */ (parseManifest(body)).manifest;
    expect(m.target).toBe("Darwin_aarch64-gcc3");
    expect(m.update).toMatchObject({ appVersion: "158.0", buildId: "20261019132138" });
    expect(Object.keys(m.update.assets)).toEqual(["dmg"]);
  });

  it("refuses a .dmg that does not match SHA256SUMS-macos", () => {
    const dir = fakeMacRelease("0.3.1");
    writeFileSync(join(dir, "vimma-0.3.1-macos-aarch64.dmg"), "swapped");
    expect(() =>
      prepareRelease({
        tag: "v0.3.1",
        dir,
        commits: [],
        published: null,
        now,
        os: "macos",
        appInfo: macInfo,
      }),
    ).toThrow(/SHA256SUMS-macos/);
  });

  it("checkSigned takes the target: a Linux manifest is refused for macOS and back", async () => {
    const dir = fakeMacRelease("0.3.1");
    const { body } = prepareRelease({
      tag: "v0.3.1",
      dir,
      commits: [],
      published: null,
      now,
      os: "macos",
      appInfo: macInfo,
    });
    const text = kmsSign(body, key);
    const opts = { keys: [key.pin], tag: "v0.3.1", dir, published: null, now };
    await expect(checkSigned(text, { ...opts, os: "macos" })).resolves.toMatchObject({
      serial: "20261028041207",
    });
    await expect(checkSigned(text, opts)).rejects.toThrow(/Darwin_aarch64-gcc3/);
    const linux = kmsSign(buildManifest({ serial: "20261028041207", update: null }), key);
    await expect(
      checkSigned(linux, { ...opts, tag: null, dir: null, os: "macos" }),
    ).rejects.toThrow(/Linux_x86_64-gcc3/);
  }, 30_000);

  it.runIf(process.platform === "darwin")(
    "reads the version and build ID from the app inside a real .dmg (hdiutil)",
    () => {
      const dir = tempDir("vimma-dmg-");
      const res = join(dir, "src", "Vimma.app", "Contents", "Resources");
      mkdirSync(res, { recursive: true });
      writeFileSync(
        join(res, "application.ini"),
        "[App]\nName=Vimma\nVersion=158.0\nBuildID=20261019132138\n",
      );
      const dmg = join(dir, "v.dmg");
      execFileSync("hdiutil", ["create", "-quiet", "-srcfolder", join(dir, "src"), dmg]);
      expect(dmgInfo(dmg)).toEqual({ appVersion: "158.0", buildId: "20261019132138" });
    },
    60_000,
  );
});

const REAL = process.env.VIMMA_UPDATE_ASSETS;
describe.runIf(REAL && existsSync(REAL))("a real release's files (VIMMA_UPDATE_ASSETS)", () => {
  it("builds, signs with a throwaway RSA-4096 key in raw PKCS#1 and verifies", async () => {
    const dir = /** @type {string} */ (REAL);
    const tar = execFileSync("ls", [dir], { encoding: "utf8" }).match(
      /^vimma-(\d+\.\d+\.\d+)-linux-x86_64\.tar\.xz$/m,
    );
    const version = /** @type {string} */ (tar?.[1]);
    const now = new Date();
    const { body } = prepareRelease({ tag: `v${version}`, dir, commits: [], published: null, now });
    process.stdout.write(body);
    const text = kmsSign(body, key);
    const r = await checkSigned(text, {
      keys: [key.pin],
      tag: `v${version}`,
      dir,
      published: null,
      now,
    });
    expect(r.key).toBe(key.pin.id);
  }, 300_000);
});
