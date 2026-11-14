// docs/specs/m6a-updater.md §2, §7 and decisions 42 and 43: the nightly's update manifest. It is
// published at …/vimma-nightly/update.xml for the channel `vimma-nightly`, offers the build on
// the rolling `nightly` release (its complete MAR as `<patch>` and its tarball), and names the
// build as `X.Y.Z-nightly.<buildID>`. A nightly manifest is never accepted where a release one is
// checked, nor the reverse. Keys are generated here; nothing is fetched.
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { constants, createHash, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  base64Encode,
  judgeManifest,
  parseManifest,
  signatureComment,
  spkiKeyId,
  staleDays,
} from "../../../packages/vimma-core/src/updates/updates.mjs";
import {
  CHANNEL,
  NIGHTLY_CHANNEL,
  assetNames,
  buildManifest,
  buildNightlyManifest,
  checkSigned,
  checkSignedNightly,
  digestInfo,
  manifestPath,
  nightlyNames,
  nightlyVersion,
  prepareNightly,
  prepareRelease,
} from "../manifest.mjs";

const subtle = globalThis.crypto.subtle;
const HASH = (/** @type {string} */ c) => c.repeat(128);
const BUILD = "20261112030512";
const DL = "https://github.com/vimma-browser/vimma/releases/download/nightly";
const MAR_URL = `${DL}/vimma-nightly-${BUILD}-linux-x86_64.complete.mar`;
const TARBALL_URL = `${DL}/vimma-nightly-${BUILD}-linux-x86_64.tar.xz`;

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
 * Signs as Cloud KMS's raw PKCS#1 key does, over the DigestInfo the sign job builds.
 * @param {string} body
 * @param {Awaited<ReturnType<typeof kmsKey>>} k
 */
function kmsSign(body, k) {
  const raw = privateEncrypt(
    { key: k.pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    digestInfo(body),
  );
  return body + signatureComment([{ key: k.pin.id, sig: raw.toString("base64") }]);
}

/** @type {Awaited<ReturnType<typeof kmsKey>>} */ let key;
/** @type {Awaited<ReturnType<typeof kmsKey>>} */ let stranger;
beforeAll(async () => {
  [key, stranger] = await Promise.all([kmsKey(), kmsKey()]);
}, 60_000);

const update = () => ({
  appVersion: "160.0",
  buildId: BUILD,
  version: "0.1.18",
  tarball: { size: 86804240, sha512: HASH("a") },
  mar: { size: 98113536, sha512: HASH("e") },
});

/**
 * The nightly release's files as the download step leaves them: the tarball (a real tar.xz
 * with vimma/application.ini), the MAR and SHA256SUMS listing both.
 * @param {{ ini?: string, buildId?: string }} [options]
 */
function fakeNightly({ ini, buildId = BUILD } = {}) {
  const dir = tempDir("vimma-nightly-");
  const names = nightlyNames(buildId);
  const src = join(dir, "src");
  mkdirSync(join(src, "vimma"), { recursive: true });
  writeFileSync(
    join(src, "vimma", "application.ini"),
    ini ?? `[App]\nVendor=Vimma\nName=Vimma\nVersion=160.0\nBuildID=${buildId}\n`,
  );
  execFileSync("tar", ["-cJf", join(dir, names.tarball), "-C", src, "vimma"]);
  writeFileSync(join(dir, names.mar), `MAR1 nightly ${buildId}`);
  const sha = (/** @type {string} */ n) =>
    createHash("sha256")
      .update(readFileSync(join(dir, n)))
      .digest("hex");
  writeFileSync(
    join(dir, "SHA256SUMS"),
    [names.mar, names.tarball].map((n) => `${sha(n)}  ${n}\n`).join(""),
  );
  return dir;
}

describe("the nightly channel's names", () => {
  it("is vimma-nightly, published at its own path beside the release channel's", () => {
    expect(NIGHTLY_CHANNEL).toBe("vimma-nightly");
    expect(manifestPath("linux", "nightly")).toBe(
      "public/updates/browser/Linux_x86_64-gcc3/vimma-nightly/update.xml",
    );
    expect(manifestPath("linux")).toBe("public/updates/browser/Linux_x86_64-gcc3/vimma/update.xml");
    expect(() => manifestPath("macos", "nightly")).toThrow(/nightly/);
  });

  it("names the files by build ID, since the rolling release replaces its assets", () => {
    expect(nightlyNames(BUILD)).toEqual({
      tarball: `vimma-nightly-${BUILD}-linux-x86_64.tar.xz`,
      mar: `vimma-nightly-${BUILD}-linux-x86_64.complete.mar`,
    });
    expect(() => nightlyNames("2026111203")).toThrow(/build ID/);
  });

  it("gives each build its own displayVersion: the release version, then the build ID", () => {
    expect(nightlyVersion("0.1.18", BUILD)).toBe(`0.1.18-nightly.${BUILD}`);
    expect(() => nightlyVersion("0.1", BUILD)).toThrow(/X\.Y\.Z/);
    expect(() => nightlyVersion("0.1.18", "today")).toThrow(/build ID/);
  });
});

describe("buildNightlyManifest (spec §2, decision 42)", () => {
  it("writes the nightly channel, the build's version, the MAR and the tarball on the nightly tag", () => {
    const body = buildNightlyManifest({ serial: "20261112041207", update: update() });
    expect(body).toBe(
      '<?xml version="1.0"?>\n' +
        '<updates vimmaChannel="vimma-nightly" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261112041207">\n' +
        `  <update type="minor" appVersion="160.0" platformVersion="160.0" buildID="${BUILD}"` +
        ` displayVersion="0.1.18-nightly.${BUILD}"` +
        ` detailsURL="https://github.com/vimma-browser/vimma/releases/tag/nightly" vimmaUrgency="normal">\n` +
        `    <patch type="complete" size="98113536" hashFunction="sha512" hashValue="${HASH("e")}" URL="${MAR_URL}"/>\n` +
        `    <vimmaTarball size="86804240" hashFunction="sha512" hashValue="${HASH("a")}" URL="${TARBALL_URL}"/>\n` +
        "  </update>\n" +
        "</updates>\n",
    );
    const parsed = parseManifest(body);
    expect(parsed.ok).toBe(true);
    const m = /** @type {any} */ (parsed).manifest;
    expect(m.channel).toBe("vimma-nightly");
    expect(m.update).toMatchObject({
      displayVersion: `0.1.18-nightly.${BUILD}`,
      buildId: BUILD,
      urgent: false,
      marUrl: MAR_URL,
    });
    expect(Object.keys(m.update.assets)).toEqual(["tarball"]);
  });

  it("is offered to a nightly install of an older build, and to no release install", () => {
    const m = /** @type {any} */ (
      parseManifest(buildNightlyManifest({ serial: "20261112041207", update: update() }))
    ).manifest;
    const running = {
      target: "Linux_x86_64-gcc3",
      appVersion: "160.0",
      buildId: "20261111030000",
      displayVersion: "0.1.18",
      serial: null,
      now: Date.UTC(2026, 10, 12, 5),
    };
    const compare = (/** @type {string} */ a, /** @type {string} */ b) =>
      a === b ? 0 : a < b ? -1 : 1;
    expect(judgeManifest(m, { ...running, channel: "vimma-nightly" }, compare)).toMatchObject({
      ok: true,
      offer: { displayVersion: `0.1.18-nightly.${BUILD}` },
    });
    expect(
      judgeManifest(m, { ...running, channel: "vimma-nightly", buildId: BUILD }, compare),
    ).toMatchObject({ ok: true, offer: null });
    expect(judgeManifest(m, { ...running, channel: "vimma" }, compare)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["a build ID that is not one", { buildId: "2026" }, /build ID/],
    ["a version that is not X.Y.Z", { version: "0.1.18-rc.1" }, /X\.Y\.Z/],
    ["a Firefox version that is not one", { appVersion: "latest" }, /Firefox/],
    ["an empty MAR", { mar: { size: 0, sha512: HASH("e") } }, /MAR/],
    ["a MAR without a SHA-512", { mar: { size: 1, sha512: "e" } }, /MAR/],
    ["a tarball without a SHA-512", { tarball: { size: 1, sha512: "a" } }, /tarball/],
  ])("refuses %s", (_name, change, why) => {
    expect(() =>
      buildNightlyManifest({ serial: "20261112041207", update: { ...update(), ...change } }),
    ).toThrow(why);
  });

  it("offers nothing with an empty <updates> for the nightly channel", () => {
    expect(buildNightlyManifest({ serial: "20261112041207", update: null })).toBe(
      '<?xml version="1.0"?>\n' +
        '<updates vimmaChannel="vimma-nightly" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261112041207">\n' +
        "</updates>\n",
    );
  });
});

describe("prepareNightly and checkSignedNightly (the nightly jobs' checks)", () => {
  const now = new Date(Date.UTC(2026, 10, 12, 4, 12, 7));
  const prepare = (/** @type {Partial<Parameters<typeof prepareNightly>[0]>} */ over = {}) =>
    prepareNightly({
      buildId: BUILD,
      version: "0.1.18",
      dir: fakeNightly(),
      published: null,
      now,
      ...over,
    });

  it("builds the manifest from the files, SHA256SUMS and the tarball's application.ini", () => {
    const dir = fakeNightly();
    const { body, version } = prepare({ dir });
    expect(version).toBe(`0.1.18-nightly.${BUILD}`);
    const m = /** @type {any} */ (parseManifest(body)).manifest;
    expect(m.serial).toBe("20261112041207");
    expect(m.channel).toBe("vimma-nightly");
    const mar = readFileSync(join(dir, nightlyNames(BUILD).mar));
    expect(body).toContain(
      `<patch type="complete" size="${mar.length}" hashFunction="sha512" hashValue="${createHash("sha512").update(mar).digest("hex")}" URL="${MAR_URL}"/>`,
    );
    expect(m.update.assets.tarball.url).toBe(TARBALL_URL);
    expect(m.update.appVersion).toBe("160.0");
  });

  it("refuses a tarball whose application.ini names another build", () => {
    const dir = fakeNightly({
      ini: "[App]\nVendor=Vimma\nName=Vimma\nVersion=160.0\nBuildID=20261111030000\n",
    });
    expect(() => prepare({ dir })).toThrow(/20261111030000/);
  });

  it("refuses a file that does not match SHA256SUMS, and a missing MAR", () => {
    const dir = fakeNightly();
    writeFileSync(join(dir, nightlyNames(BUILD).mar), "MAR1 swapped");
    expect(() => prepare({ dir })).toThrow(/complete\.mar/);
    execFileSync("rm", [join(dir, nightlyNames(BUILD).mar)]);
    expect(() => prepare({ dir })).toThrow(/complete\.mar/);
  });

  it("refuses an older build than the published nightly manifest offers, and an old serial", () => {
    const newer = kmsSign(
      buildNightlyManifest({
        serial: "20261112000000",
        update: { ...update(), buildId: "20261112035959" },
      }),
      key,
    );
    expect(() => prepare({ published: newer })).toThrow(/older/);
    const later = kmsSign(buildNightlyManifest({ serial: "20261112041207", update: null }), key);
    expect(() => prepare({ published: later })).toThrow(/not newer/);
    // A re-run of the same build, after its manifest was published, is a new serial for it.
    const same = kmsSign(buildNightlyManifest({ serial: "20261112040000", update: update() }), key);
    expect(prepare({ published: same }).version).toBe(`0.1.18-nightly.${BUILD}`);
  });

  // Decision 44: on a day main did not change, nightly.yml calls the same jobs with the build
  // already offered. The offer is byte for byte the same but for the serial, the published
  // manifest's checks pass, and a nightly install of that build takes it as up to date: no
  // download, no notice, and a feed that is never stale while the nightly runs.
  it("an unchanged day's re-sign offers the same build under a newer serial, and installs stay current", async () => {
    const dir = fakeNightly();
    const first = kmsSign(prepare({ dir }).body, key);
    const day = 86_400_000;
    for (const days of [1, 6, 8]) {
      const later = new Date(now.getTime() + days * day);
      const { body } = prepare({ dir, published: first, now: later });
      const lines = (/** @type {string} */ t) =>
        t.split("\n").filter((l) => !/vimma-signature/.test(l));
      const changed = lines(body).filter((l, i) => l !== lines(first)[i]);
      expect(changed).toEqual([expect.stringMatching(/^<updates .* vimmaSerial="\d{14}">$/)]);
      const signed = kmsSign(body, key);
      const opts = {
        keys: [key.pin],
        buildId: BUILD,
        version: "0.1.18",
        dir,
        published: first,
        now: later,
      };
      const { serial } = await checkSignedNightly(signed, opts);
      expect(BigInt(serial)).toBeGreaterThan(BigInt("20261112041207"));
      const m = /** @type {any} */ (parseManifest(body)).manifest;
      const running = {
        channel: "vimma-nightly",
        target: "Linux_x86_64-gcc3",
        appVersion: "160.0",
        buildId: BUILD,
        displayVersion: `0.1.18-nightly.${BUILD}`,
        serial: "20261112041207",
        now: later.getTime(),
      };
      const compare = (/** @type {string} */ a, /** @type {string} */ b) =>
        a === b ? 0 : a < b ? -1 : 1;
      expect(judgeManifest(m, running, compare)).toEqual({ ok: true, serial, offer: null });
      expect(staleDays(serial, "vimma-nightly", later.getTime())).toBeNull();
    }
    // Without the re-sign, the first manifest is stale after 7 days.
    expect(staleDays("20261112041207", "vimma-nightly", now.getTime() + 8 * day)).toBe(8);
  }, 30_000);

  it("checkSignedNightly accepts the signed manifest and the files it names", async () => {
    const dir = fakeNightly();
    const { body } = prepare({ dir });
    const opts = { keys: [key.pin], buildId: BUILD, version: "0.1.18", dir, published: null, now };
    await expect(checkSignedNightly(kmsSign(body, key), opts)).resolves.toEqual({
      serial: "20261112041207",
      version: `0.1.18-nightly.${BUILD}`,
      key: key.pin.id,
    });
  }, 30_000);

  it("checkSignedNightly refuses another key, a changed file, another build and a moved MAR", async () => {
    const dir = fakeNightly();
    const { body } = prepare({ dir });
    const opts = { keys: [key.pin], buildId: BUILD, version: "0.1.18", dir, published: null, now };
    await expect(checkSignedNightly(kmsSign(body, stranger), opts)).rejects.toThrow(/signature/);
    const text = kmsSign(body, key);
    await expect(checkSignedNightly(text, { ...opts, buildId: "20261112035959" })).rejects.toThrow(
      /20261112035959/,
    );
    await expect(checkSignedNightly(text, { ...opts, version: "0.1.19" })).rejects.toThrow(
      /0\.1\.19/,
    );
    const moved = body.replace(MAR_URL, "https://example.com/vimma.complete.mar");
    await expect(checkSignedNightly(kmsSign(moved, key), opts)).rejects.toThrow(/patch/);
    const published = kmsSign(
      buildNightlyManifest({ serial: "20261112041207", update: null }),
      key,
    );
    await expect(checkSignedNightly(text, { ...opts, published })).rejects.toThrow(/not newer/);
    writeFileSync(join(dir, nightlyNames(BUILD).mar), "MAR1 swapped");
    await expect(checkSignedNightly(text, opts)).rejects.toThrow(/complete\.mar/);
  }, 30_000);

  it("checkSignedNightly refuses a manifest without the MAR, or with a release's files", async () => {
    const dir = fakeNightly();
    const { body } = prepare({ dir });
    const opts = { keys: [key.pin], buildId: BUILD, version: "0.1.18", dir, published: null, now };
    const noPatch = body.replace(/ {4}<patch [^\n]*\n/, "");
    await expect(checkSignedNightly(kmsSign(noPatch, key), opts)).rejects.toThrow(/patch/);
    const deb = body.replace(
      "  </update>",
      `    <vimmaDeb size="1" hashFunction="sha512" hashValue="${HASH("c")}" URL="${DL}/x.deb"/>\n  </update>`,
    );
    await expect(checkSignedNightly(kmsSign(deb, key), opts)).rejects.toThrow(/vimmaDeb|deb/);
  }, 30_000);
});

describe("the two channels never cross (docs/security/16-update-check.md UP2, UP14)", () => {
  const now = new Date(Date.UTC(2026, 10, 12, 4, 12, 7));

  it("checkSigned, the release's check, refuses a nightly manifest", async () => {
    const dir = fakeNightly();
    const { body } = prepareNightly({
      buildId: BUILD,
      version: "0.1.18",
      dir,
      published: null,
      now,
    });
    await expect(
      checkSigned(kmsSign(body, key), {
        keys: [key.pin],
        tag: "v0.1.18",
        dir,
        published: null,
        now,
      }),
    ).rejects.toThrow(/vimma-nightly/);
  }, 30_000);

  it("checkSignedNightly refuses a release manifest, whatever it offers", async () => {
    const release = buildManifest({
      serial: "20261112041207",
      update: {
        appVersion: "160.0",
        buildId: BUILD,
        displayVersion: "0.1.18",
        urgency: "normal",
        advisories: [],
        assets: {
          tarball: { size: 1, sha512: HASH("a") },
          appimage: { size: 2, sha512: HASH("b") },
          deb: { size: 3, sha512: HASH("c") },
          rpm: { size: 4, sha512: HASH("d") },
        },
      },
    });
    expect(release).toContain(`vimmaChannel="${CHANNEL}"`);
    await expect(
      checkSignedNightly(kmsSign(release, key), {
        keys: [key.pin],
        buildId: BUILD,
        version: "0.1.18",
        dir: fakeNightly(),
        published: null,
        now,
      }),
    ).rejects.toThrow(/channel|vimma/);
  }, 30_000);

  it("prepareRelease finds no release in a nightly's files", () => {
    const dir = fakeNightly();
    expect(assetNames("0.1.18").tarball).not.toBe(nightlyNames(BUILD).tarball);
    expect(() =>
      prepareRelease({ tag: "v0.1.18", dir, commits: [], published: null, now }),
    ).toThrow(/was not downloaded/);
  });
});

describe("tools/update/manifest.mjs --channel nightly (the CLI nightly-prepare and nightly-publish run)", () => {
  const cli = new URL("../manifest.mjs", import.meta.url).pathname;

  it("build writes the nightly body; verify refuses it unsigned, and says why", () => {
    const dir = fakeNightly();
    const out = join(dir, "update.xml.body");
    const common = ["--channel", "nightly", "--build-id", BUILD, "--version", "0.1.18"];
    execFileSync("node", [cli, "build", ...common, "--assets", dir, "--out", out]);
    const parsed = /** @type {any} */ (parseManifest(readFileSync(out, "utf8")));
    expect(parsed.manifest.channel).toBe("vimma-nightly");
    expect(parsed.manifest.update.displayVersion).toBe(`0.1.18-nightly.${BUILD}`);
    let error = "";
    try {
      execFileSync("node", [cli, "verify", ...common, "--assets", dir, "--signed", out], {
        stdio: "pipe",
      });
    } catch (e) {
      error = String(/** @type {any} */ (e).stderr);
    }
    expect(error).toMatch(/manifest: .*signature/);
  });

  it("refuses a tag, another target or offer=nothing on the nightly channel", () => {
    const dir = fakeNightly();
    const common = ["--channel", "nightly", "--build-id", BUILD, "--version", "0.1.18"];
    for (const extra of [
      ["--tag", "v0.1.18"],
      ["--target", "macos"],
      ["--offer", "nothing"],
    ]) {
      const r = spawnSync(
        "node",
        [cli, "build", ...common, ...extra, "--assets", dir, "--out", join(dir, "x")],
        { encoding: "utf8" },
      );
      expect(r.status, extra.join(" ")).not.toBe(0);
    }
  });
});
