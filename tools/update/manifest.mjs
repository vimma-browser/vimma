#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The update manifest of a published release (docs/specs/m6a-updater.md §2 and §7), for
 * .github/workflows/update-publish.yml. Its `prepare` job builds the unsigned body here, its
 * `sign` job signs it with Cloud KMS (no repository code runs there), and its `publish` job
 * checks the signed file here, with the verifier the browser runs
 * (packages/vimma-core/src/updates.mjs) and the keys the browser pins, before it is pushed.
 *
 *   manifest.mjs commits --tag vX.Y.Z --repo owner/name  > commits.json
 *       the subjects and pull-request labels since the previous published release (git, gh)
 *   manifest.mjs build --tag vX.Y.Z --assets DIR --commits FILE [--published FILE]... --out FILE
 *       the body for the release's files in DIR (the three Linux packages and SHA256SUMS, or
 *       with --target macos the .dmg and SHA256SUMS-macos)
 *   manifest.mjs build --offer nothing [--published FILE]... --out FILE
 *       a body that offers nothing (pulls an update; docs/runbook.md)
 *   manifest.mjs verify --signed FILE (--tag vX.Y.Z --assets DIR | --offer nothing)
 *       [--published FILE]...
 *       checks a signed manifest; prints serial=, version= and key= lines for $GITHUB_OUTPUT
 *   build and verify take --target linux|macos (linux when absent): the manifest's build
 *   target, its files and its path (spec macos-homebrew, decisions 16 to 18)
 *   manifest.mjs pem
 *       the pinned primary key as PEM, for openssl
 *
 * Node built-ins only, so no job that runs it installs dependencies.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ASSET_ELEMENTS,
  FUTURE_SERIAL_MS,
  RELEASES_URL,
  parseManifest,
  signedBytes,
  splitManifest,
  verifyManifest,
} from "../../packages/vimma-core/src/updates.mjs";
import { UPDATE_KEYS } from "../../packages/vimma-core/src/update-keys.mjs";

/** The release channel (`app.update.channel` in channel-prefs.js). */
export const CHANNEL = "vimma";
/**
 * Each build target with a manifest: Firefox's `%BUILD_TARGET%` (`OS_TARGET` + `_` + the XPCOM
 * ABI), the release files it lists and the sums file they are checked against. The .dmg has its
 * own sums file because release.yml publishes it in a later job than the Linux packages.
 */
export const TARGETS = Object.freeze({
  linux: {
    target: "Linux_x86_64-gcc3",
    kinds: /** @type {AssetKind[]} */ (["tarball", "appimage", "deb"]),
    sums: "SHA256SUMS",
  },
  macos: {
    target: "Darwin_aarch64-gcc3",
    kinds: /** @type {AssetKind[]} */ (["dmg"]),
    sums: "SHA256SUMS-macos",
  },
});
/** @typedef {keyof typeof TARGETS} Os */
export const TARGET = TARGETS.linux.target;
/**
 * Where a target's manifest lives in vimma-browser/vimma-updates: the Worker serves `public/`,
 * at the path Firefox's update URL template gives (`/updates/browser/%BUILD_TARGET%/%CHANNEL%/…`).
 * @param {Os} os
 */
export function manifestPath(os) {
  return `public/updates/browser/${targetOf(os).target}/${CHANNEL}/update.xml`;
}
export const MANIFEST_PATH = manifestPath("linux");
/** DER prefix of a SHA-384 DigestInfo (RFC 8017 §9.2, note 1). */
const SHA384_DIGESTINFO = Buffer.from("3041300d060960864801650304020205000430", "hex");

const TAG = /^v(\d+\.\d+\.\d+)$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const FIREFOX_VERSION = /^\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?$/;
const BUILD_ID = /^\d{14}$/;
const SERIAL = /^\d{14}$/;
const ADVISORY = /^MFSA \d{4}-\d{1,4}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;

/** @typedef {import("../../packages/vimma-core/src/updates.mjs").Assets} Assets */
/** @typedef {keyof typeof ASSET_ELEMENTS} AssetKind */
/**
 * @typedef {object} Release
 * @property {string} appVersion      Firefox's version (application.ini `Version`)
 * @property {string} buildId         application.ini `BuildID`
 * @property {string} displayVersion  Vimma's version
 * @property {"normal" | "security"} urgency
 * @property {string[]} advisories    MFSA IDs
 * @property {Required<Assets>} assets
 */

/**
 * @param {string} os
 * @returns {(typeof TARGETS)[Os]}
 */
function targetOf(os) {
  if (!Object.hasOwn(TARGETS, os)) throw new Error(`no target ${os} (linux or macos)`);
  return TARGETS[/** @type {Os} */ (os)];
}

/**
 * A target's release file names, as tools/package/package.mjs and release.yml write them.
 * @param {string} version
 * @param {Os} [os]
 * @returns {Partial<Record<AssetKind, string>>}
 */
export function assetNames(version, os = "linux") {
  /** @type {Record<AssetKind, string>} */
  const all = {
    tarball: `vimma-${version}-linux-x86_64.tar.xz`,
    appimage: `vimma-${version}-x86_64.AppImage`,
    deb: `vimma_${version.replace("-", "~")}_amd64.deb`,
    dmg: `vimma-${version}-macos-aarch64.dmg`,
  };
  return Object.fromEntries(targetOf(os).kinds.map((k) => [k, all[k]]));
}

/**
 * @param {Partial<Record<AssetKind, string>>} names
 * @param {AssetKind} kind
 */
const nameOf = (names, kind) => names[kind] ?? kind;

/**
 * @param {boolean} ok
 * @param {string} why
 * @returns {asserts ok}
 */
function need(ok, why) {
  if (!ok) throw new Error(why);
}

/**
 * The manifest body: everything the signature covers (spec §2). Every value is checked against
 * the format the client accepts, so none needs escaping and none can add markup.
 * @param {{ serial: string, update: Release | null, os?: Os }} input
 */
export function buildManifest({ serial, update, os = "linux" }) {
  need(SERIAL.test(serial), `serial ${serial} is not a UTC time (YYYYMMDDhhmmss)`);
  const { target, kinds } = targetOf(os);
  let body =
    '<?xml version="1.0"?>\n' +
    `<updates vimmaChannel="${CHANNEL}" vimmaTarget="${target}" vimmaSerial="${serial}">\n`;
  if (update) {
    const v = update.displayVersion;
    need(VERSION.test(v), `${v} is not a Vimma version (X.Y.Z)`);
    need(FIREFOX_VERSION.test(update.appVersion), `${update.appVersion} is not a Firefox version`);
    need(BUILD_ID.test(update.buildId), `${update.buildId} is not a build ID`);
    need(update.urgency === "normal" || update.urgency === "security", "unknown urgency");
    need(
      update.advisories.every((a) => ADVISORY.test(a)),
      `advisories ${update.advisories.join(", ")} are not MFSA IDs`,
    );
    const names = assetNames(v, os);
    const advisories = update.advisories.length
      ? ` vimmaAdvisories="${update.advisories.join(", ")}"`
      : "";
    body +=
      `  <update type="minor" appVersion="${update.appVersion}"` +
      ` platformVersion="${update.appVersion}" buildID="${update.buildId}"` +
      ` displayVersion="${v}" detailsURL="${RELEASES_URL}/tag/v${v}"` +
      ` vimmaUrgency="${update.urgency}"${advisories}>\n`;
    for (const kind of kinds) {
      const name = nameOf(names, kind);
      const a = update.assets[kind];
      need(!!a, `no ${name}`);
      need(Number.isSafeInteger(a.size) && a.size >= 0, `${name}: size ${a.size}`);
      need(SHA512_HEX.test(a.sha512), `${name}: ${a.sha512} is not a SHA-512`);
      body +=
        `    <${ASSET_ELEMENTS[kind]} size="${a.size}" hashFunction="sha512"` +
        ` hashValue="${a.sha512}" URL="${RELEASES_URL}/download/v${v}/${name}"/>\n`;
    }
    body += "  </update>\n";
  }
  return body + "</updates>\n";
}

/**
 * The serial for a manifest made at `now`: its UTC time, YYYYMMDDhhmmss.
 * @param {Date} now
 */
export function serialAt(now) {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * The serial for a manifest made at `now`, which must be newer than the published one: the
 * replay rule (spec §4 rule 3) makes every client refuse anything older than it has accepted.
 * @param {Date} now
 * @param {string | null} published
 */
export function nextSerial(now, published) {
  const serial = serialAt(now);
  if (published !== null && BigInt(serial) <= BigInt(published)) {
    throw new Error(
      `serial ${serial} is not newer than the published ${published}; is the clock behind?`,
    );
  }
  return serial;
}

/**
 * SHA256SUMS (or SHA256SUMS-macos) as `sha256sum` writes it.
 * @param {string} text
 * @param {string} [file] the sums file's name, for messages
 * @returns {Map<string, string>} file name -> SHA-256
 */
export function parseSums(text, file = "SHA256SUMS") {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *]([^/\s]+)$/.exec(line);
    if (!m) throw new Error(`${file}: malformed line ${JSON.stringify(line)}`);
    const [, hash = "", name = ""] = m;
    if (sums.has(name)) throw new Error(`${file}: ${name} is listed twice`);
    sums.set(name, hash);
  }
  return sums;
}

/**
 * Every asset must be in the sums file with the SHA-256 of the file that was downloaded.
 * @param {Map<string, string>} sums
 * @param {Partial<Record<AssetKind, { name: string, sha256: string }>>} files
 * @param {string} [file] the sums file's name, for messages
 */
export function checkAssets(sums, files, file = "SHA256SUMS") {
  for (const f of Object.values(files)) {
    const { name, sha256 } = f;
    const listed = sums.get(name);
    if (!listed) throw new Error(`${name} is not in ${file}`);
    if (listed !== sha256) {
      throw new Error(`${name}: SHA-256 ${sha256} does not match ${file} (${listed})`);
    }
  }
}

/**
 * Whether a release is urgent (spec §7, "Urgency"), from the commits since the previous
 * published release: a Firefox bump (`upstream: firefox …`) whose subject names advisories or
 * whose pull request carries the `security` label (the autopilot labels a bump whose advisories
 * it could not read as security, G3), a `fix(security)` commit, or any change whose pull
 * request carries the `security` label.
 * @param {readonly { subject: string, labels: readonly string[] }[]} commits
 * @returns {{ urgency: "normal" | "security", advisories: string[] }}
 */
export function urgencyOf(commits) {
  /** @type {string[]} */
  const advisories = [];
  let security = false;
  for (const { subject, labels } of commits) {
    const bump = /^upstream(?:\([^)]*\))?!?: firefox /i.test(subject);
    const ids = bump ? [...subject.matchAll(/MFSA \d{4}-\d{1,4}/g)].map((m) => m[0]) : [];
    for (const id of ids) if (!advisories.includes(id)) advisories.push(id);
    if (ids.length || labels.includes("security") || /^fix\(security\)!?:/.test(subject)) {
      security = true;
    }
  }
  return { urgency: security ? "security" : "normal", advisories };
}

/** @param {string} tag */
const semver = (tag) => TAG.exec(tag)?.[1]?.split(".").map(Number) ?? null;

/**
 * The newest release tag below `current`, from the published releases' tags; null for the first.
 * @param {readonly string[]} tags
 * @param {string} current
 */
export function previousRelease(tags, current) {
  const now = semver(current);
  if (!now) throw new Error(`${current} is not a vX.Y.Z tag`);
  /** @param {number[]} a @param {number[]} b */
  const cmp = (a, b) =>
    (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
  let best = /** @type {string | null} */ (null);
  for (const tag of tags) {
    const v = semver(tag);
    if (!v || cmp(v, now) >= 0) continue;
    const b = best && semver(best);
    if (!b || cmp(v, b) > 0) best = tag;
  }
  return best;
}

/**
 * The SHA-384 DigestInfo of the prefixed body: what Cloud KMS's raw PKCS#1 key signs (the sign
 * job builds the same bytes with printf and openssl; its test compares them).
 * @param {string} body
 */
export function digestInfo(body) {
  const hash = createHash("sha384").update(signedBytes(body)).digest();
  return Buffer.concat([SHA384_DIGESTINFO, hash]);
}

/** The pinned primary key as a PEM SubjectPublicKeyInfo, for `openssl dgst -verify`. */
export function pinnedPem() {
  const primary = UPDATE_KEYS.find((k) => k.slot === "primary");
  if (!primary) throw new Error("no primary key is pinned in update-keys.mjs");
  const lines = primary.spki.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Firefox's version and the build ID, from `vimma/application.ini` in the tarball: what
 * `Services.appinfo.version` and `appBuildID` say in the installed build, which the client
 * compares an offer against (spec §4 rule 4).
 * @param {string} tarball
 */
export function releaseInfo(tarball) {
  return iniInfo(
    execFileSync("tar", ["-xJOf", tarball, "vimma/application.ini"], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    }),
  );
}

/**
 * The same from the app inside the .dmg: the Mac build has its own build ID (it is built in
 * another job), so the Linux tarball's would not match it. hdiutil is macOS's, so this runs on
 * a macOS runner; the image is mounted read-only and not browsed.
 * @param {string} dmg
 */
export function dmgInfo(dmg) {
  const mount = mkdtempSync(join(dirname(dmg), ".vimma-dmg-"));
  execFileSync("hdiutil", [
    "attach",
    "-quiet",
    "-nobrowse",
    "-readonly",
    "-mountpoint",
    mount,
    dmg,
  ]);
  try {
    return iniInfo(
      readFileSync(join(mount, "Vimma.app/Contents/Resources/application.ini"), "utf8"),
    );
  } finally {
    execFileSync("hdiutil", ["detach", "-quiet", mount]);
    rmSync(mount, { recursive: true, force: true });
  }
}

/**
 * Firefox's version and the build ID from application.ini's `[App]` section.
 * @param {string} ini
 */
function iniInfo(ini) {
  const app = /^\[App\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(ini)?.[1] ?? "";
  const appVersion = /^Version=(.*)$/m.exec(app)?.[1]?.trim() ?? "";
  const buildId = /^BuildID=(.*)$/m.exec(app)?.[1]?.trim() ?? "";
  need(FIREFOX_VERSION.test(appVersion), `application.ini: Version ${appVersion} is not Firefox's`);
  need(BUILD_ID.test(buildId), `application.ini: BuildID ${buildId} is not a build ID`);
  return { appVersion, buildId };
}

/**
 * A file's size and hashes. The packages are about 100 MB each, which one read handles.
 * @param {string} path
 */
function hashFile(path) {
  const data = readFileSync(path);
  return {
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    sha512: createHash("sha512").update(data).digest("hex"),
  };
}

/**
 * The published manifest's channel, serial and offered version (read, not verified: it only
 * sets the floor the new manifest must clear). A file that is there but unreadable stops the
 * run: the floor would be unknown.
 * @param {string | null} text
 * @returns {{ serial: string, version: string | null } | null}
 */
export function publishedState(text) {
  if (text === null || text === "") return null;
  const split = splitManifest(text);
  if (!split.ok) throw new Error(`the published manifest: ${split.reason}`);
  const parsed = parseManifest(split.body);
  if (!parsed.ok) throw new Error(`the published manifest: ${parsed.reason}`);
  return {
    serial: parsed.manifest.serial,
    version: parsed.manifest.update?.displayVersion ?? null,
  };
}

/**
 * The highest floor among the published copies (the update host and the repository can differ
 * for a moment while Cloudflare deploys).
 * @param {readonly (string | null)[]} texts
 */
function floorOf(texts) {
  let floor = /** @type {{ serial: string, version: string | null } | null} */ (null);
  for (const t of texts) {
    const s = publishedState(t);
    if (s && (!floor || BigInt(s.serial) > BigInt(floor.serial))) floor = s;
  }
  return floor;
}

/** @param {string} a @param {string} b X.Y.Z */
function versionOrder(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * @param {string} version
 * @param {{ version: string | null } | null} floor
 */
function noOlderThan(version, floor) {
  if (floor?.version && versionOrder(version, floor.version) < 0) {
    throw new Error(
      `${version} is older than ${floor.version}, which the published manifest offers`,
    );
  }
}

/**
 * The unsigned manifest for a published release: its files (checked against the target's sums
 * file), the Firefox version and build ID inside the tarball or the .dmg, the urgency from its
 * commits, and a serial newer than the published one.
 * @param {{ tag: string, dir: string, commits: readonly { subject: string, labels: readonly string[] }[],
 *   published: string | readonly (string | null)[] | null, now: Date, os?: Os,
 *   appInfo?: (path: string) => { appVersion: string, buildId: string } }} input
 *   `appInfo` reads the version and build ID from the package (releaseInfo or dmgInfo)
 */
export function prepareRelease({ tag, dir, commits, published, now, os = "linux", appInfo }) {
  const version = TAG.exec(tag)?.[1];
  if (!version) throw new Error(`${tag} is not a vX.Y.Z release tag`);
  const { kinds, sums } = targetOf(os);
  const floor = floorOf(Array.isArray(published) ? published : [/** @type {any} */ (published)]);
  noOlderThan(version, floor);
  const names = assetNames(version, os);
  /** @type {Partial<Record<AssetKind, { name: string, size: number, sha256: string, sha512: string }>>} */
  const files = {};
  for (const kind of kinds) {
    const name = nameOf(names, kind);
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`${name} was not downloaded`);
    files[kind] = { name, ...hashFile(path) };
  }
  checkAssets(parseSums(readFileSync(join(dir, sums), "utf8"), sums), files, sums);
  const info = appInfo ?? (os === "macos" ? dmgInfo : releaseInfo);
  const { appVersion, buildId } = info(
    join(dir, nameOf(names, os === "macos" ? "dmg" : "tarball")),
  );
  const assets = /** @type {Required<Assets>} */ (
    Object.fromEntries(
      kinds.map((k) => [k, { size: files[k]?.size ?? 0, sha512: files[k]?.sha512 ?? "" }]),
    )
  );
  const body = buildManifest({
    serial: nextSerial(now, floor?.serial ?? null),
    update: { appVersion, buildId, displayVersion: version, ...urgencyOf(commits), assets },
    os,
  });
  return { body, version };
}

/**
 * The checks before a push: the signature under a pinned key (the browser's verifier), the
 * channel and target, a serial newer than the published one and not ahead of the clock, and for
 * a release, its version, its details page and every file's size and SHA-512; with no tag, an
 * offer of nothing.
 * @param {string} text  the signed manifest
 * @param {{ keys: readonly import("../../packages/vimma-core/src/updates.mjs").PinnedKey[],
 *   tag: string | null, dir: string | null, published: string | readonly (string | null)[] | null,
 *   now: Date, os?: Os }} options
 */
export async function checkSigned(text, { keys, tag, dir, published, now, os = "linux" }) {
  const { target, kinds } = targetOf(os);
  const verified = await verifyManifest(text, keys, globalThis.crypto.subtle);
  if (!verified.ok) throw new Error(verified.reason);
  const parsed = parseManifest(verified.body);
  if (!parsed.ok) throw new Error(parsed.reason);
  const m = parsed.manifest;
  need(m.channel === CHANNEL && m.target === target, `for ${m.channel} ${m.target}, not ${target}`);
  const floor = floorOf(Array.isArray(published) ? published : [/** @type {any} */ (published)]);
  if (floor && BigInt(m.serial) <= BigInt(floor.serial)) {
    throw new Error(`serial ${m.serial} is not newer than the published ${floor.serial}`);
  }
  const issued = Date.parse(
    m.serial.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, "$1-$2-$3T$4:$5:$6Z"),
  );
  need(issued <= now.getTime() + FUTURE_SERIAL_MS, `serial ${m.serial} is ahead of the clock`);
  const out = { serial: m.serial, version: m.update?.displayVersion ?? "", key: verified.key.id };
  if (tag === null) {
    need(m.update === null, `the manifest offers ${m.update?.displayVersion}, not nothing`);
    return out;
  }
  const version = TAG.exec(tag)?.[1];
  need(!!version, `${tag} is not a vX.Y.Z release tag`);
  const u = m.update;
  need(!!u, "the manifest offers nothing");
  need(u.displayVersion === version, `the manifest offers ${u.displayVersion}, not ${version}`);
  need(u.detailsUrl === `${RELEASES_URL}/tag/${tag}`, `details page ${u.detailsUrl}`);
  noOlderThan(version, floor);
  need(dir !== null, "no directory with the release's files");
  const names = assetNames(version, os);
  for (const kind of kinds) {
    const name = nameOf(names, kind);
    const a = u.assets[kind];
    need(!!a, `the manifest has no ${name}`);
    const path = join(dir, name);
    need(existsSync(path), `${name} was not downloaded`);
    const f = hashFile(path);
    need(f.size === a.size && f.sha512 === a.sha512, `${name} does not match the manifest`);
  }
  return out;
}

/** @param {string} path */
const readOrNull = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/**
 * The subjects since the previous published release, each with its pull request's labels.
 * @param {string} tag
 * @param {string} repo
 */
function commitsSince(tag, repo) {
  /** @param {string[]} args */
  const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 });
  const tags = gh([
    "api",
    `repos/${repo}/releases`,
    "--paginate",
    "--jq",
    ".[] | select(.draft == false and .prerelease == false) | .tag_name",
  ])
    .split("\n")
    .filter(Boolean);
  const previous = previousRelease(tags, tag);
  const range = previous ? `${previous}..${tag}` : tag;
  const log = execFileSync("git", ["log", "--format=%H%x09%s", range], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\t");
      const labels = gh([
        "api",
        `repos/${repo}/commits/${sha}/pulls`,
        "--jq",
        "[.[].labels[].name] | unique | .[]",
      ])
        .split("\n")
        .filter(Boolean);
      return { sha, subject, labels };
    });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: "string" },
      repo: { type: "string" },
      assets: { type: "string" },
      commits: { type: "string" },
      published: { type: "string", multiple: true },
      offer: { type: "string" },
      out: { type: "string" },
      signed: { type: "string" },
      target: { type: "string", default: "linux" },
    },
  });
  const os = /** @type {Os} */ (values.target ?? "linux");
  targetOf(os);
  const published = (values.published ?? []).map(readOrNull);
  const nothing = values.offer === "nothing";
  if (values.offer !== undefined && !nothing) throw new Error("--offer takes only `nothing`");
  switch (command) {
    case "commits": {
      need(!!values.tag && !!values.repo, "commits needs --tag and --repo");
      process.stdout.write(`${JSON.stringify(commitsSince(values.tag, values.repo), null, 1)}\n`);
      return;
    }
    case "build": {
      need(!!values.out, "build needs --out");
      if (nothing) {
        const floor = floorOf(published);
        writeFileSync(
          values.out,
          buildManifest({
            serial: nextSerial(new Date(), floor?.serial ?? null),
            update: null,
            os,
          }),
        );
        return;
      }
      need(
        !!values.tag && !!values.assets && !!values.commits,
        "build needs --tag --assets --commits",
      );
      const commits = JSON.parse(readFileSync(values.commits, "utf8"));
      const { body } = prepareRelease({
        tag: values.tag,
        dir: values.assets,
        commits,
        published,
        now: new Date(),
        os,
      });
      writeFileSync(values.out, body);
      const offer = /** @type {any} */ (parseManifest(body)).manifest.update;
      console.error(
        `manifest: Vimma ${offer.displayVersion} · Firefox ${offer.appVersion}, build ${offer.buildId}, ` +
          `${offer.urgent ? `security (${offer.advisories.join(", ") || "no advisory ID"})` : "normal"}`,
      );
      return;
    }
    case "verify": {
      need(!!values.signed, "verify needs --signed");
      need(
        nothing || (!!values.tag && !!values.assets),
        "verify needs --tag and --assets, or --offer nothing",
      );
      const r = await checkSigned(readFileSync(values.signed, "utf8"), {
        keys: UPDATE_KEYS,
        tag: nothing ? null : (values.tag ?? null),
        dir: values.assets ?? null,
        published,
        now: new Date(),
        os,
      });
      process.stdout.write(`serial=${r.serial}\nversion=${r.version}\nkey=${r.key}\n`);
      return;
    }
    case "pem":
      process.stdout.write(pinnedPem());
      return;
    default:
      throw new Error("usage: manifest.mjs commits|build|verify|pem (see the file's header)");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`manifest: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
