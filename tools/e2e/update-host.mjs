/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The update scenarios of the e2e harness (docs/specs/m6a-updater.md, "Tests", e2e): a local
// update host on 127.0.0.1 over https, manifests built by tools/update/manifest.mjs and signed
// with a key generated for the run, complete MARs built by tools/update/mar.mjs and signed with
// libmar's test key `mycert`, and the installs they update. Nothing here touches the real update
// key or updates.vimma.dev: the browser trusts the manifest key only in automation
// (vimma.update.testKeys), and `mycert` only through `updater-xpcshell`, Mozilla's test build of
// the updater, which the "test" installs carry in place of the shipped `updater`.
//
// The host's certificate comes from a CA made for the run, which only the scenario's profile
// trusts (certutil), because the manifest and the browser both refuse a MAR URL that is not
// https (core/updates.mjs readPatch).

import { execFileSync } from "node:child_process";
import {
  constants,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  webcrypto,
} from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import {
  RELEASES_URL,
  base64Encode,
  signatureComment,
  signedBytes as manifestBytes,
  spkiKeyId,
} from "../../packages/vimma-core/src/updates.mjs";
import { buildManifest, marName } from "../update/manifest.mjs";
import { buildMarFromDir, insertSignature, signedBytes as marBytes } from "../update/mar.mjs";

/** The file N+1 adds, so the scenario can tell the MAR's files reached the install. */
export const MARKER = "vimma-e2e-update-marker";
/** The updater's error codes the scenarios expect (toolkit/mozapps/update/common/updatererrors.h). */
export const UPDATER_ERRORS = Object.freeze({ CERT_VERIFY: 19, VERSION_DOWNGRADE: 23 });
const BUILD_ID = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * application.ini's lines, with the section each is in.
 * @param {string} text
 */
function iniLines(text) {
  let section = "";
  return text.split("\n").map((raw) => {
    const line = raw.trim();
    const head = /^\[(.+)\]$/.exec(line);
    if (head) section = head[1] ?? "";
    const eq = line.indexOf("=");
    const key = !head && eq > 0 ? line.slice(0, eq) : null;
    return { raw, section, key, value: key === null ? null : line.slice(eq + 1) };
  });
}

/**
 * @param {string} text  an ini file
 * @param {string} section
 * @param {string} key
 * @returns {string | null}
 */
export function iniValue(text, section, key) {
  return iniLines(text).find((l) => l.section === section && l.key === key)?.value ?? null;
}

/**
 * The ini file with `key` in `section` set to `value`. A key that is not there is refused, not
 * added: the scenarios change only what the build wrote.
 * @param {string} text @param {string} section @param {string} key @param {string} value
 */
export function setIni(text, section, key, value) {
  const lines = iniLines(text);
  const at = lines.findIndex((l) => l.section === section && l.key === key);
  if (at < 0) throw new Error(`application.ini: no ${key} in [${section}]`);
  return lines.map((l, i) => (i === at ? `${key}=${value}` : l.raw)).join("\n");
}

/**
 * The build ID of the build that last ran on a profile: compatibility.ini's `LastVersion`,
 * `<version>_<appBuildID>/<platformBuildID>`, which Firefox writes at every start.
 * @param {string} text
 */
export function lastBuildId(text) {
  const last = iniValue(text, "Compatibility", "LastVersion");
  return /_(\d{14})\//.exec(last ?? "")?.[1] ?? null;
}

/**
 * A build ID `seconds` later.
 * @param {string} buildId @param {number} seconds
 */
export function laterBuildId(buildId, seconds) {
  const m = BUILD_ID.exec(buildId);
  if (!m) throw new Error(`${buildId} is not a build ID`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const at = Date.UTC(
    /** @type {number} */ (y),
    /** @type {number} */ (mo) - 1,
    d,
    h,
    mi,
    /** @type {number} */ (s) + seconds,
  );
  return new Date(at).toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * A Vimma version `n` patch releases later, without a pre-release part.
 * @param {string} version @param {number} n
 */
export function laterVersion(version, n) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`${version} is not a Vimma version`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + n}`;
}

/**
 * A manifest key for this run, in the shape vimma.update.testKeys takes, with its private key.
 * @returns {Promise<{ id: string, slot: "primary", spki: string,
 *   privateKey: import("node:crypto").KeyObject }>}
 */
export async function makeManifestKey() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const id = await spkiKeyId(webcrypto.subtle, spki);
  return { id, slot: "primary", spki: base64Encode(spki), privateKey };
}

/**
 * The manifest body with its signature comment (core/updates.mjs, rule 1): RSA-PKCS#1 v1.5
 * with SHA-384 over the prefixed body, as Cloud KMS signs a published one.
 * @param {string} body
 * @param {{ id: string, privateKey: import("node:crypto").KeyObject }} key
 */
export function signManifest(body, key) {
  const sig = sign("sha384", Buffer.from(manifestBytes(body)), {
    key: key.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return body + signatureComment([{ key: key.id, sig: base64Encode(new Uint8Array(sig)) }]);
}

/** Sizes and hashes for the packages a manifest must list; the scenarios download none. */
const NO_PACKAGE = Object.freeze({ size: 1, sha512: "0".repeat(128) });

/**
 * A manifest body from tools/update/manifest.mjs offering `offer`, whose `<patch>` is the local
 * MAR instead of the release's (the one thing the release manifest does not let a caller set).
 * @param {{ serial: string,
 *   offer: { appVersion: string, buildId: string, displayVersion: string },
 *   mar: { size: number, sha512: string, url: string } }} o
 */
export function localManifest({ serial, offer, mar }) {
  if (!mar.url.startsWith("https://")) throw new Error(`the MAR URL ${mar.url} is not https`);
  const body = buildManifest({
    serial,
    update: {
      ...offer,
      urgency: "normal",
      advisories: [],
      mar: { size: mar.size, sha512: mar.sha512 },
      assets: { tarball: NO_PACKAGE, appimage: NO_PACKAGE, deb: NO_PACKAGE, rpm: NO_PACKAGE },
    },
  });
  const v = offer.displayVersion;
  // The release's MAR URL exactly as manifest.mjs writes it (marUrl there), as a plain string.
  const released = `URL="${RELEASES_URL}/download/v${v}/${marName(v)}"`;
  if (body.split(released).length !== 2) {
    throw new Error("manifest.mjs wrote no single <patch> URL to replace");
  }
  return body.split(released).join(`URL="${mar.url}"`);
}

/**
 * A MAR from mar.mjs's `build` (one zeroed placeholder) signed with `privateKey`.
 * @param {Buffer} buf
 * @param {import("node:crypto").KeyObject} privateKey
 */
export function signMar(buf, privateKey) {
  const signature = sign("sha384", marBytes(buf), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  });
  return insertSignature(buf, signature);
}

/**
 * The error code the updater's last run ended with (`failed: <code>`), or null when it ended
 * otherwise or never ran: the last status line of `updates/last-update.log`, which the updater
 * itself writes in the install. Firefox's own record of a failed update (updates.xml) is not
 * written in every case: after an update was applied in the same install, a later failed one
 * left none.
 * @param {string} log
 */
export function updaterError(log) {
  const statuses = [...log.matchAll(/Writing status to file: (.+)$/gm)];
  const last = statuses.at(-1)?.[1]?.trim() ?? "";
  const m = /^failed: (\d+)$/.exec(last);
  return m ? Number(m[1]) : null;
}

/**
 * Where the browser reads its application.ini from in the scenarios (updateEnv): beside the
 * browser's own files, the directory Firefox takes as the application's when XUL_APP_FILE
 * names the file (an artifact build's dist/bin/browser/application.ini).
 */
const APP_INI = "browser/application.ini";

/**
 * Writes application.ini where the package has it and where the scenarios' browser reads it
 * (APP_INI), so both say the same and a MAR of the tree carries both.
 * @param {string} dir @param {string} text
 */
function writeIni(dir, text) {
  writeFileSync(join(dir, "application.ini"), text);
  writeFileSync(join(dir, APP_INI), text);
}

/**
 * A copy of an unpacked `./mach package` tree (`vimma/`) as an install the scenario updates:
 * its update URL is the local host's, and with `testUpdater` its `updater` is Mozilla's test
 * build (`updater-xpcshell`, which trusts `mycert`), as Mozilla's own updater tests do.
 * @param {{ from: string, to: string, url: string, testUpdater: string | null }} o
 * @returns {string} the install directory
 */
export function installTree({ from, to, url, testUpdater }) {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const ini = join(to, "application.ini");
  writeIni(to, setIni(readFileSync(ini, "utf8"), "AppUpdate", "URL", url));
  if (testUpdater) {
    const mode = statSync(join(to, "updater")).mode & 0o777;
    copyFileSync(testUpdater, join(to, "updater"));
    chmodSync(join(to, "updater"), mode);
  }
  return to;
}

/**
 * N+1 from N's tree: a later build ID (what Firefox's updater and rule 4 compare), the marker
 * file, and with `appVersion` another Firefox version (the downgrade MAR's product version comes
 * from it, mar.mjs).
 * @param {{ from: string, to: string, buildId: string, appVersion?: string }} o
 * @returns {string}
 */
export function nextTree({ from, to, buildId, appVersion }) {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const ini = join(to, "application.ini");
  let text = setIni(readFileSync(ini, "utf8"), "App", "BuildID", buildId);
  if (appVersion) text = setIni(text, "App", "Version", appVersion);
  writeIni(to, text);
  writeFileSync(join(to, MARKER), `${buildId}\n`);
  return to;
}

/**
 * A CA for the run and a certificate for 127.0.0.1 it signs (openssl). Only the scenario's
 * profile trusts the CA (trustCa).
 *
 * Every extension comes from openssl.cnf written here (`-config`), never from the machine's own
 * config: OpenSSL 1.1.1's stock one (Homebrew's openssl@1.1, first on the macOS runners' PATH)
 * adds its v3_ca section to a self-signed certificate, and 1.1.1 and LibreSSL add -addext's
 * extensions beside it instead of in its place, so the CA carried Basic Constraints twice and
 * OpenSSL 3 and NSS refused it as an issuer.
 * @param {string} dir
 * @returns {{ ca: string, caFile: string, cert: string, key: string }}
 */
export function hostCertificate(dir) {
  const f = (/** @type {string} */ n) => join(dir, n);
  const run = (/** @type {string[]} */ args) =>
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  writeFileSync(
    f("openssl.cnf"),
    [
      "[ req ]",
      "distinguished_name = dn",
      "x509_extensions = ca",
      "[ dn ]",
      "[ ca ]",
      "basicConstraints = critical,CA:TRUE",
      "keyUsage = critical,keyCertSign,cRLSign",
      "subjectKeyIdentifier = hash",
      "[ host ]",
      "basicConstraints = critical,CA:FALSE",
      "keyUsage = critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = IP:127.0.0.1",
      "subjectKeyIdentifier = hash",
      "authorityKeyIdentifier = keyid",
      "",
    ].join("\n"),
  );
  const config = ["-config", f("openssl.cnf")];
  run(
    ["req", ...config, "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", f("ca.key")]
      .concat(["-out", f("ca.pem"), "-days", "2", "-sha256"])
      .concat(["-subj", "/CN=Vimma e2e update host CA"]),
  );
  run(
    ["req", ...config, "-newkey", "rsa:2048", "-nodes", "-keyout", f("host.key")].concat([
      "-out",
      f("host.csr"),
      "-subj",
      "/CN=127.0.0.1",
    ]),
  );
  run(
    ["x509", "-req", "-in", f("host.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key")]
      .concat(["-CAcreateserial", "-out", f("host.pem"), "-days", "2", "-sha256"])
      .concat(["-extfile", f("openssl.cnf"), "-extensions", "host"]),
  );
  return {
    ca: readFileSync(f("ca.pem"), "utf8"),
    caFile: f("ca.pem"),
    cert: readFileSync(f("host.pem"), "utf8"),
    key: readFileSync(f("host.key"), "utf8"),
  };
}

/**
 * Makes the profile trust the run's CA, before the browser first starts on it (NSS's certutil).
 * @param {string} profile @param {string} caFile
 */
export function trustCa(profile, caFile) {
  const db = `sql:${profile}`;
  const opts = { stdio: /** @type {const} */ (["ignore", "ignore", "pipe"]) };
  if (!existsSync(join(profile, "cert9.db"))) {
    execFileSync("certutil", ["-N", "-d", db, "--empty-password"], opts);
  }
  execFileSync(
    "certutil",
    ["-A", "-d", db, "-n", "vimma-e2e-update-host", "-t", "C,,", "-i", caFile],
    opts,
  );
}

/**
 * @typedef {{ path: string, cookie: boolean, range: string | null }} HostRequest
 * @typedef {{
 *   origin: string,
 *   serve: (text: string | null) => void,
 *   addFile: (name: string, file: string) => string,
 *   requests: () => HostRequest[],
 *   marRequests: () => number,
 *   close: () => Promise<void>,
 * }} UpdateHost
 */

/**
 * The local update host: `/update.xml` (whatever the query) answers the manifest last given to
 * `serve` (404 before, or after `serve(null)`), and `/<name>` each file added, with the byte
 * ranges nsIncrementalDownload asks for. It listens on 127.0.0.1 only.
 * @param {{ cert: string, key: string }} tls
 * @returns {Promise<UpdateHost>}
 */
export async function startUpdateHost({ cert, key }) {
  /** @type {string | null} */
  let manifest = null;
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {HostRequest[]} */
  const log = [];
  const server = createServer({ cert, key }, (req, res) => {
    const path = new URL(req.url ?? "/", "https://127.0.0.1").pathname;
    const range = req.headers.range ?? null;
    log.push({ path, cookie: req.headers.cookie !== undefined, range });
    if (path === "/update.xml") {
      if (manifest === null) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/xml", "Cache-Control": "no-store" });
      return void res.end(manifest);
    }
    const file = files.get(path.slice(1));
    if (!file) return void res.writeHead(404).end();
    const size = statSync(file).size;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    if (!m) {
      res.writeHead(200, { "Content-Length": size, "Accept-Ranges": "bytes" });
      return void createReadStream(file).pipe(res);
    }
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    if (start > end) {
      return void res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    }
    res.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the update host has no port");
  const origin = `https://127.0.0.1:${address.port}`;
  return {
    origin,
    serve: (text) => void (manifest = text),
    addFile: (name, file) => {
      if (!/^[\w.-]+$/.test(name)) throw new Error(`${name} is not a plain file name`);
      files.set(name, file);
      return `${origin}/${name}`;
    },
    requests: () => log.map((r) => ({ ...r })),
    marRequests: () => log.filter((r) => r.path.endsWith(".mar")).length,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A file's size and SHA-512, as the manifest's `<patch>` names them.
 * @param {string} file
 */
export function fileDigest(file) {
  const data = readFileSync(file);
  return { size: data.length, sha512: createHash("sha512").update(data).digest("hex") };
}

/**
 * The prefs an update scenario's browser needs: automation, so the run's manifest key is pinned
 * (vimma.update.testKeys), with MOZ_DISABLE_NONLOCAL_CONNECTIONS, which crashes the browser on
 * any connection off 127.0.0.1; so the speculative connections Firefox makes on its own (a
 * focused address bar connects to the search engine) are off, as in Mozilla's test profiles
 * (testing/profiles/unittest-required/user.js). And Firefox's updater on, which the harness's
 * profile turns off for every other scenario.
 * @param {{ id: string, slot: string, spki: string }} key
 */
export const updatePrefs = (key, url) => ({
  "security.turn_off_all_security_so_that_viruses_can_take_over_this_computer": true,
  "vimma.update.url": url,
  "vimma.update.testKeys": JSON.stringify([key]),
  "app.update.disabledForTesting": false,
  "browser.urlbar.speculativeConnect.enabled": false,
  "network.http.speculative-parallel-limit": 0,
  "network.predictor.enabled": false,
  "browser.search.suggest.enabled": false,
  // Firefox's update timer also checks for media plugins (GMPs) at aus5.mozilla.org.
  "media.gmp-manager.updateEnabled": false,
  "media.gmp-manager.url.override": "data:text/plain,",
});

/**
 * The environment an update scenario's browser runs in. Firefox's binary carries its
 * application.ini compiled in (browser/app/nsBrowserApp.cpp) and reads a file only when
 * XUL_APP_FILE names it, as the artifact build does; so the install's file (APP_INI), with the
 * local update URL, and after the update N+1's build ID, is what the browser runs with. The updater
 * execs the browser in the same process, so the variables reach N+1 too.
 * @param {string} install
 */
export const updateEnv = (install) => ({
  MOZ_DISABLE_NONLOCAL_CONNECTIONS: "1",
  XUL_APP_FILE: join(install, APP_INI),
});

/** Where Mozilla's tree keeps libmar's test NSS database, which holds `mycert` and its key. */
const MYCERT_DB = "modules/libmar/tests/unit/data";
/** Where a build with tests puts Mozilla's test updater (updater-xpcshell/moz.build). */
const TEST_UPDATER = "_tests/xpcshell/toolkit/mozapps/update/tests/updater-xpcshell";
/** The Firefox version of the downgrade MAR: older than any Vimma is built on. */
const OLDER_FIREFOX = "100.0";

/**
 * `mycert`'s private key, out of libmar's test database (NSS's pk12util, then openssl).
 * @param {string} engine  the Firefox tree
 * @param {string} dir     a private directory for the PKCS #12 file
 */
export function mycertKey(engine, dir) {
  const p12 = join(dir, "mycert.p12");
  execFileSync(
    "pk12util",
    ["-o", p12, "-n", "mycert", "-d", `sql:${join(engine, MYCERT_DB)}`, "-W", "e2e", "-K", ""],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const pem = execFileSync(
    "openssl",
    ["pkcs12", "-in", p12, "-nocerts", "-nodes", "-passin", "pass:e2e"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return createPrivateKey(pem);
}

/**
 * Vimma's and Firefox's versions from the build's `--version` line (`Vimma 0.1.15 · Firefox
 * 159.0.1`, tools/release/version-line.mjs).
 * @param {string} binary
 */
export function buildVersions(binary) {
  const line = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const m = /^Vimma (\S+) · Firefox (\S+)$/.exec(line);
  if (!m) throw new Error(`${binary} --version printed "${line}"`);
  return { display: /** @type {string} */ (m[1]), firefox: /** @type {string} */ (m[2]) };
}

/**
 * @typedef {{
 *   host: UpdateHost,
 *   caFile: string,
 *   testKey: { id: string, slot: "primary", spki: string },
 *   buildIds: { n: string, n1: string, older: string },
 *   newInstall: (updater: "test" | "shipped", to: string) => string,
 *   serve: (spec: import("./scenario.mjs").UpdateServe) => void,
 *   close: () => Promise<void>,
 * }} UpdateRun
 */

/**
 * Everything the update scenarios share, made once per run from a VIMMA_UPDATES=1 objdir with
 * a `./mach package` tarball: N (the tarball, its update URL the local host's), N+1 (a later
 * build ID and the marker) and the downgrade build (later still, an older Firefox), their
 * complete MARs signed with `mycert`, the manifest keys and the host.
 * @param {{ objdir: string, engine: string, work: string, log?: (line: string) => void }} o
 * @returns {Promise<UpdateRun>}
 */
export async function prepareUpdateRun({ objdir, engine, work, log = () => {} }) {
  const dist = join(objdir, "dist");
  const tarball = readdirSync(dist).find((f) => /^vimma-.*\.linux-x86_64\.tar\.xz$/.test(f));
  if (!tarball) throw new Error(`no vimma-*.linux-x86_64.tar.xz in ${dist}: run ./mach package`);
  const testUpdater = join(objdir, TEST_UPDATER);
  if (!existsSync(testUpdater)) throw new Error(`no ${testUpdater}: a build with tests has it`);
  const tools = join(work, "mar-tools");
  mkdirSync(tools);
  copyFileSync(join(dist, "host/bin/mar"), join(tools, "mar"));
  for (const f of ["make_full_update.sh", "common.sh"]) {
    copyFileSync(join(engine, "tools/update-packaging", f), join(tools, f));
  }
  chmodSync(join(tools, "mar"), 0o755);
  chmodSync(join(tools, "make_full_update.sh"), 0o755);
  const keys = join(work, "keys");
  mkdirSync(keys, { mode: 0o700 });
  const mycert = mycertKey(engine, keys);

  log(`update run: unpacking ${tarball}`);
  const src = join(work, "src");
  mkdirSync(src);
  execFileSync("tar", ["-xJf", join(dist, tarball), "-C", src]);
  const tls = join(work, "tls");
  mkdirSync(tls, { mode: 0o700 });
  const cert = hostCertificate(tls);
  const host = await startUpdateHost(cert);
  try {
    const url = `${host.origin}/update.xml`;
    const n = installTree({
      from: join(src, "vimma"),
      to: join(work, "n"),
      url,
      testUpdater: null,
    });
    const nTest = installTree({ from: n, to: join(work, "n-test"), url, testUpdater });
    const ini = readFileSync(join(n, "application.ini"), "utf8");
    const nId = /** @type {string} */ (iniValue(ini, "App", "BuildID"));
    const appVersion = /** @type {string} */ (iniValue(ini, "App", "Version"));
    const { display } = buildVersions(join(n, "vimma"));
    const buildIds = { n: nId, n1: laterBuildId(nId, 60), older: laterBuildId(nId, 120) };
    /** @param {string} name @param {string} dir */
    const mar = (name, dir) => {
      const out = join(work, name);
      buildMarFromDir({ dir, tools, channel: "vimma", out: `${out}.unsigned` });
      writeFileSync(out, signMar(readFileSync(`${out}.unsigned`), mycert));
      return { ...fileDigest(out), url: host.addFile(name, out) };
    };
    log("update run: building the N+1 and downgrade MARs");
    const n1Mar = mar(
      "n1.mar",
      nextTree({ from: nTest, to: join(work, "n1"), buildId: buildIds.n1 }),
    );
    const olderMar = mar(
      "older.mar",
      nextTree({
        from: nTest,
        to: join(work, "older"),
        buildId: buildIds.older,
        appVersion: OLDER_FIREFOX,
      }),
    );
    const testKey = await makeManifestKey();
    const unknownKey = await makeManifestKey();
    // Each manifest is newer than the last (the replay rule) and than every build it offers.
    const start = [serialNow(), laterBuildId(buildIds.older, 1)].sort().at(-1);
    let served = 0;
    const offers = {
      n1: {
        offer: { appVersion, buildId: buildIds.n1, displayVersion: laterVersion(display, 1) },
        mar: n1Mar,
      },
      n: {
        offer: { appVersion, buildId: buildIds.n, displayVersion: laterVersion(display, 2) },
        mar: n1Mar,
      },
      "older-firefox": {
        offer: { appVersion, buildId: buildIds.older, displayVersion: laterVersion(display, 3) },
        mar: olderMar,
      },
    };
    return {
      host,
      caFile: cert.caFile,
      testKey: { id: testKey.id, slot: testKey.slot, spki: testKey.spki },
      buildIds,
      newInstall: (updater, to) => {
        cpSync(updater === "test" ? nTest : n, to, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
        return to;
      },
      serve: ({ offer, key = "test" }) => {
        const serial = laterBuildId(/** @type {string} */ (start), served++);
        const body =
          offer === "none"
            ? buildManifest({ serial, update: null })
            : localManifest({ serial, ...offers[offer] });
        host.serve(signManifest(body, key === "test" ? testKey : unknownKey));
      },
      close: () => host.close(),
    };
  } catch (e) {
    await host.close();
    throw e;
  }
}

/** The current UTC time as a serial (YYYYMMDDhhmmss). */
function serialNow() {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * What a `wait-for-install` step compares: which build the install holds and the profile last
 * ran (n, n1, or null when they differ or are neither), N+1's marker, the error code the
 * updater's last run ended with, and the MAR requests the host saw since `since`.
 * @param {{ install: string, profile: string, run: UpdateRun, since: number }} o
 * @returns {import("./scenario.mjs").InstallState}
 */
export function installState({ install, profile, run, since }) {
  const read = (/** @type {string} */ f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const installed = iniValue(read(join(install, "application.ini")), "App", "BuildID");
  const ran = lastBuildId(read(join(profile, "compatibility.ini")));
  const name = (/** @type {string | null} */ id) =>
    id === run.buildIds.n ? "n" : id === run.buildIds.n1 ? "n1" : null;
  return {
    buildId: installed === ran ? name(installed) : null,
    marker: existsSync(join(install, MARKER)),
    updateError: updaterError(read(join(install, "updates/last-update.log"))),
    marRequests: run.host.marRequests() - since,
  };
}
