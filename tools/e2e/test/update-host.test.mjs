// The update scenarios' harness pieces (docs/specs/m6a-updater.md, "Tests", e2e): the local
// update host, the test-signed manifest and MAR, and the installs they update.
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request } from "node:https";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostCertificate,
  installState,
  iniValue,
  installTree,
  lastBuildId,
  laterBuildId,
  laterVersion,
  localManifest,
  makeManifestKey,
  nextTree,
  setIni,
  signManifest,
  signMar,
  startUpdateHost,
  updateEnv,
  updaterError,
} from "../update-host.mjs";
import {
  judgeManifest,
  parseManifest,
  verifyManifest,
} from "../../../packages/vimma-core/src/updates/updates.mjs";
import { addSignaturePlaceholder, readMar, verifyMar } from "../../update/mar.mjs";

/** @type {string[]} */
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "vimma-update-host-test-"));
  dirs.push(d);
  return d;
};
/** @type {Array<() => Promise<void>>} */
const closers = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const INI = `#Filled in at build time
[App]
Vendor=Vimma
Name=Vimma
Version=159.0.1
BuildID=20261106090000
ID={ec8030f7-c20a-464f-9b0e-13a3a9e97384}

[AppUpdate]
URL=https://updates.vimma.dev/%CHANNEL%/%BUILD_TARGET%/update.xml
`;

describe("application.ini", () => {
  it("reads and sets a key in its own section only", () => {
    expect(iniValue(INI, "App", "BuildID")).toBe("20261106090000");
    expect(iniValue(INI, "AppUpdate", "URL")).toContain("updates.vimma.dev");
    expect(iniValue(INI, "App", "URL")).toBeNull();
    const next = setIni(INI, "AppUpdate", "URL", "https://127.0.0.1:4430/update.xml");
    expect(iniValue(next, "AppUpdate", "URL")).toBe("https://127.0.0.1:4430/update.xml");
    expect(iniValue(next, "App", "BuildID")).toBe("20261106090000");
  });

  it("refuses a key that is not there, rather than adding one Firefox may not read", () => {
    expect(() => setIni(INI, "App", "Nope", "1")).toThrow(/no Nope in \[App\]/);
    expect(() => setIni(INI, "Missing", "URL", "x")).toThrow(/no URL in \[Missing\]/);
  });

  it("names the build a profile last ran from compatibility.ini", () => {
    const ini = "[Compatibility]\nLastVersion=159.0.1_20261106090100/20261106090000\n";
    expect(lastBuildId(ini)).toBe("20261106090100");
    expect(lastBuildId("[Compatibility]\n")).toBeNull();
  });
});

describe("build IDs and versions", () => {
  it("moves a build ID on by whole seconds, across a day", () => {
    expect(laterBuildId("20261106090000", 60)).toBe("20261106090100");
    expect(laterBuildId("20261231235959", 1)).toBe("20270101000000");
    expect(() => laterBuildId("2026", 1)).toThrow(/not a build ID/);
  });

  it("gives a later Vimma version, so only the build ID decides an offer", () => {
    expect(laterVersion("0.4.2", 1)).toBe("0.4.3");
    expect(laterVersion("0.4.2-nightly.1", 2)).toBe("0.4.4");
  });
});

describe("the test-signed manifest", () => {
  const running = {
    channel: "vimma",
    target: "Linux_x86_64-gcc3",
    appVersion: "159.0.1",
    buildId: "20261106090000",
    displayVersion: "0.4.2",
    serial: null,
    now: Date.UTC(2026, 10, 6, 12),
  };
  const offer = { appVersion: "159.0.1", buildId: "20261106090100", displayVersion: "0.4.3" };
  const mar = { size: 1234, sha512: "a".repeat(128), url: "https://127.0.0.1:4430/n1.mar" };
  const compare = (/** @type {string} */ a, /** @type {string} */ b) =>
    a.localeCompare(b, "en", { numeric: true });

  it("offers the local MAR, signed by a key the build pins only in automation", async () => {
    const key = await makeManifestKey();
    const text = signManifest(localManifest({ serial: "20261106110000", offer, mar }), key);
    const verified = await verifyManifest(text, [key], globalThis.crypto.subtle);
    expect(verified.ok).toBe(true);
    const parsed = parseManifest(/** @type {any} */ (verified).body);
    expect(parsed.ok).toBe(true);
    const manifest = /** @type {any} */ (parsed).manifest;
    expect(manifest.update.marUrl).toBe(mar.url);
    expect(manifest.update.buildId).toBe(offer.buildId);
    const judged = judgeManifest(manifest, running, compare);
    expect(judged).toMatchObject({ ok: true, offer: { buildId: offer.buildId } });
  });

  it("is refused under any other key: the bad-signature case", async () => {
    const key = await makeManifestKey();
    const stranger = await makeManifestKey();
    const text = signManifest(localManifest({ serial: "20261106110000", offer, mar }), stranger);
    const verified = await verifyManifest(text, [key], globalThis.crypto.subtle);
    expect(verified).toMatchObject({ ok: false });
  });

  it("offers nothing for the running build's own build ID: the downgrade case", async () => {
    const key = await makeManifestKey();
    const same = { ...offer, buildId: running.buildId, displayVersion: "0.4.4" };
    const text = signManifest(localManifest({ serial: "20261106110000", offer: same, mar }), key);
    const verified = /** @type {any} */ (
      await verifyManifest(text, [key], globalThis.crypto.subtle)
    );
    const manifest = /** @type {any} */ (parseManifest(verified.body)).manifest;
    expect(judgeManifest(manifest, running, compare)).toMatchObject({ ok: true, offer: null });
  });

  it("refuses a MAR URL that is not https, as the browser would", () => {
    expect(() =>
      localManifest({ serial: "20261106110000", offer, mar: { ...mar, url: "http://x/a.mar" } }),
    ).toThrow(/https/);
  });
});

describe("the test-signed MAR", () => {
  /** A minimal unsigned MAR: header, no signatures, a product information block, one file. */
  function unsignedMar() {
    const content = Buffer.from("hello");
    const pib = Buffer.concat([Buffer.from("vimma\x00159.0.1\x00")]);
    const pibBlock = Buffer.alloc(8);
    pibBlock.writeUInt32BE(8 + pib.length, 0);
    pibBlock.writeUInt32BE(1, 4);
    const extra = Buffer.concat([u32(1), pibBlock, pib]);
    const head = 4 + 4 + 8 + 4;
    const contentAt = head + extra.length;
    const name = Buffer.from("a.txt\0");
    const entry = Buffer.concat([u32(contentAt), u32(content.length), u32(0o644), name]);
    const index = Buffer.concat([u32(entry.length), entry]);
    const indexAt = contentAt + content.length;
    const total = indexAt + index.length;
    const header = Buffer.alloc(head);
    header.write("MAR1", 0);
    header.writeUInt32BE(indexAt, 4);
    header.writeBigUInt64BE(BigInt(total), 8);
    header.writeUInt32BE(0, 16);
    return Buffer.concat([header, extra, content, index]);
  }
  /** @param {number} n */
  function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  }

  it("verifies under the test key and under no other", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
    const other = generateKeyPairSync("rsa", { modulusLength: 4096 });
    const placed = addSignaturePlaceholder(unsignedMar());
    const signed = signMar(placed, privateKey);
    expect(readMar(signed).signatures).toHaveLength(1);
    expect(
      verifyMar(signed, [publicKey], { channel: "vimma", productVersion: "159.0.1" }),
    ).toMatchObject({ channel: "vimma", productVersion: "159.0.1", entries: 1 });
    expect(() => verifyMar(signed, [other.publicKey], { channel: "vimma" })).toThrow(
      /does not verify/,
    );
  });
});

describe("the updater's log", () => {
  const LOG = (/** @type {string} */ status) =>
    "2026-11-06 03:15:15+0000: gInvocation=UpdaterInvocation::First\n" +
    "2026-11-06 03:15:15+0000: Writing status to file: applying\n" +
    "2026-11-06 03:15:15+0000: Performing a staged update\n" +
    `2026-11-06 03:15:15+0000: Writing status to file: ${status}\n\n` +
    `2026-11-06 03:15:15+0000: ${status}\n` +
    "2026-11-06 03:15:15+0000: calling QuitProgressUI\n";

  it("gives the error code the updater's last run ended with, or null", () => {
    expect(updaterError(LOG("failed: 23"))).toBe(23);
    expect(updaterError(LOG("failed: 19"))).toBe(19);
    expect(updaterError(LOG("applied"))).toBeNull();
    expect(updaterError(LOG("succeeded"))).toBeNull();
    expect(updaterError("")).toBeNull();
    // the last status counts: a run that failed, then one that applied
    expect(updaterError(`${LOG("failed: 19")}${LOG("applied")}`)).toBeNull();
  });
});

describe("the installs", () => {
  /** @param {string} root */
  function fakeInstall(root) {
    const dir = join(root, "vimma");
    mkdirSync(join(dir, "browser"), { recursive: true });
    writeFileSync(join(dir, "application.ini"), INI);
    writeFileSync(join(dir, "updater"), "shipped updater", { mode: 0o755 });
    writeFileSync(join(dir, "vimma"), "#!/bin/sh\n", { mode: 0o755 });
    return dir;
  }

  it("points the install at the local host and, for the test case, swaps in the test updater", () => {
    const root = tmp();
    const src = fakeInstall(join(root, "src"));
    const xpcshell = join(root, "updater-xpcshell");
    writeFileSync(xpcshell, "test updater", { mode: 0o755 });
    const url = "https://127.0.0.1:4430/update.xml";
    const test = installTree({ from: src, to: join(root, "a"), url, testUpdater: xpcshell });
    expect(readFileSync(join(test, "updater"), "utf8")).toBe("test updater");
    expect(statSync(join(test, "updater")).mode & 0o111).not.toBe(0);
    expect(iniValue(readFileSync(join(test, "application.ini"), "utf8"), "AppUpdate", "URL")).toBe(
      url,
    );
    // the browser reads browser/application.ini (XUL_APP_FILE): the same text
    expect(readFileSync(join(test, "browser/application.ini"), "utf8")).toBe(
      readFileSync(join(test, "application.ini"), "utf8"),
    );
    expect(updateEnv(test)).toEqual({
      MOZ_DISABLE_NONLOCAL_CONNECTIONS: "1",
      XUL_APP_FILE: join(test, "browser/application.ini"),
    });
    const shipped = installTree({ from: src, to: join(root, "b"), url, testUpdater: null });
    expect(readFileSync(join(shipped, "updater"), "utf8")).toBe("shipped updater");
    // the source tree is left as it was
    expect(readFileSync(join(src, "updater"), "utf8")).toBe("shipped updater");
  });

  it("makes N+1 from N: a later build ID, a marker file, and Firefox's version when asked", () => {
    const root = tmp();
    const src = fakeInstall(join(root, "src"));
    const next = nextTree({ from: src, to: join(root, "n1"), buildId: "20261106090100" });
    const ini = readFileSync(join(next, "application.ini"), "utf8");
    expect(iniValue(ini, "App", "BuildID")).toBe("20261106090100");
    expect(iniValue(ini, "App", "Version")).toBe("159.0.1");
    expect(readFileSync(join(next, "browser/application.ini"), "utf8")).toBe(ini);
    expect(readFileSync(join(next, "vimma-e2e-update-marker"), "utf8")).toBe("20261106090100\n");
    const old = nextTree({
      from: src,
      to: join(root, "old"),
      buildId: "20261106090200",
      appVersion: "158.0",
    });
    expect(iniValue(readFileSync(join(old, "application.ini"), "utf8"), "App", "Version")).toBe(
      "158.0",
    );
    expect(existsSync(join(src, "vimma-e2e-update-marker"))).toBe(false);
  });
});

describe("what wait-for-install reads", () => {
  it("names the build the install holds and the profile last ran, the marker and the error", () => {
    const root = tmp();
    const install = join(root, "vimma");
    const profile = join(root, "profile");
    mkdirSync(install);
    mkdirSync(profile);
    let mars = 3;
    const run = /** @type {any} */ ({
      buildIds: { n: "20261106090000", n1: "20261106090100", older: "20261106090200" },
      host: { marRequests: () => mars },
    });
    writeFileSync(join(install, "application.ini"), INI);
    writeFileSync(
      join(profile, "compatibility.ini"),
      "[Compatibility]\nLastVersion=159.0.1_20261106090000/20261106090000\n",
    );
    expect(installState({ install, profile, run, since: 1 })).toEqual({
      buildId: "n",
      marker: false,
      updateError: null,
      marRequests: 2,
    });
    // the MAR is applied but the profile has not run it yet: neither
    writeFileSync(
      join(install, "application.ini"),
      setIni(INI, "App", "BuildID", "20261106090100"),
    );
    writeFileSync(join(install, "vimma-e2e-update-marker"), "");
    mkdirSync(join(install, "updates"));
    writeFileSync(
      join(install, "updates/last-update.log"),
      "2026-11-06 03:15:15+0000: Writing status to file: failed: 23\n",
    );
    mars = 5;
    expect(installState({ install, profile, run, since: 1 })).toEqual({
      buildId: null,
      marker: true,
      updateError: 23,
      marRequests: 4,
    });
    writeFileSync(
      join(profile, "compatibility.ini"),
      "[Compatibility]\nLastVersion=159.0.1_20261106090100/20261106090000\n",
    );
    expect(installState({ install, profile, run, since: 1 }).buildId).toBe("n1");
  });
});

describe("the local update host", () => {
  /**
   * @param {string} url @param {string} ca
   * @param {Record<string, string>} [headers]
   * @returns {Promise<{ status: number, headers: any, body: Buffer }>}
   */
  const get = (url, ca, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(url, { ca, headers }, (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on("data", (d) => parts.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });

  it("serves the manifest and the MARs over https on 127.0.0.1 only, and logs each request", async () => {
    const dir = tmp();
    const cert = hostCertificate(dir);
    const host = await startUpdateHost(cert);
    closers.push(() => host.close());
    expect(host.origin).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);

    expect((await get(`${host.origin}/update.xml`, cert.ca)).status).toBe(404);
    host.serve("<updates/>\n");
    const manifest = await get(`${host.origin}/update.xml?x=1`, cert.ca);
    expect(manifest.status).toBe(200);
    expect(manifest.body.toString()).toBe("<updates/>\n");

    const file = join(dir, "n1.mar");
    writeFileSync(file, Buffer.from("0123456789"));
    const url = host.addFile("n1.mar", file);
    expect(url).toBe(`${host.origin}/n1.mar`);
    const whole = await get(url, cert.ca);
    expect(whole.body.toString()).toBe("0123456789");
    // nsIncrementalDownload asks in ranges and needs 206 with Content-Range
    const part = await get(url, cert.ca, { Range: "bytes=2-5", Cookie: "a=b" });
    expect(part.status).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(part.body.toString()).toBe("2345");
    const tail = await get(url, cert.ca, { Range: "bytes=8-" });
    expect(tail.body.toString()).toBe("89");
    expect((await get(`${host.origin}/nope.mar`, cert.ca)).status).toBe(404);

    expect(host.requests().map((r) => [r.path, r.cookie])).toEqual([
      ["/update.xml", false],
      ["/update.xml", false],
      ["/n1.mar", false],
      ["/n1.mar", true],
      ["/n1.mar", false],
      ["/nope.mar", false],
    ]);
    expect(host.marRequests()).toBe(4);
  });

  // OpenSSL 1.1.1's stock openssl.cnf (Homebrew's openssl@1.1, first on the macOS runners'
  // PATH) has `req` add its v3_ca section to a self-signed certificate. 1.1.1 and LibreSSL put
  // -addext's extensions in beside it rather than in its place, so the CA carried Basic
  // Constraints twice, which OpenSSL 3 and NSS refuse as an issuer: "unable to verify the first
  // certificate".
  it("makes the same certificates whatever openssl.cnf the machine has", async () => {
    const dir = tmp();
    const conf = join(dir, "openssl.cnf");
    writeFileSync(
      conf,
      "[ req ]\ndistinguished_name = dn\nx509_extensions = v3_ca\nreq_extensions = v3_req\n" +
        "[ dn ]\n" +
        "[ v3_ca ]\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always,issuer\n" +
        "basicConstraints = critical,CA:true\nnsComment = from the machine's openssl.cnf\n" +
        "[ v3_req ]\nbasicConstraints = CA:FALSE\nnsComment = from the machine's openssl.cnf\n",
    );
    const saved = process.env.OPENSSL_CONF;
    process.env.OPENSSL_CONF = conf;
    let cert;
    try {
      cert = hostCertificate(dir);
    } finally {
      if (saved === undefined) delete process.env.OPENSSL_CONF;
      else process.env.OPENSSL_CONF = saved;
    }
    for (const pem of [cert.ca, cert.cert]) {
      const text = execFileSync("openssl", ["x509", "-noout", "-text"], {
        input: pem,
        encoding: "utf8",
        env: { ...process.env, OPENSSL_CONF: conf },
      });
      const names = [...text.matchAll(/^ {12}(X509v3 [^:]+|Netscape Comment):/gm)].map((m) => m[1]);
      expect(names, "each extension once").toEqual([...new Set(names)]);
      expect(names).not.toContain("Netscape Comment");
    }
    const host = await startUpdateHost(cert);
    closers.push(() => host.close());
    host.serve("<updates/>\n");
    expect((await get(`${host.origin}/update.xml`, cert.ca)).status).toBe(200);
  });
});
