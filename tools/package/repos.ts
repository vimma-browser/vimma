#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The unsigned metadata of the apt, rpm and pacman repositories, built from release files
 * (docs/specs/package-repositories.md, decisions 7 to 14), laid out as the update host serves
 * it:
 *
 *   apt/Packages, apt/Packages.gz, apt/Release, apt/vimma.sources
 *   rpm/repodata/…, rpm/repodata/repomd.xml.key, rpm/vimma.repo
 *   arch/x86_64/vimma.db, arch/x86_64/vimma.files
 *   vimma-packages.asc, _redirects, _headers
 *
 *   repos.ts build --out DIR --cert FILE --release TAG=DIR [--release TAG=DIR …] [--keep N]
 *       [--base-url URL] [--download-base URL]
 *   repos.ts select --releases FILE --tag TAG [--keep N]
 *       prints the tags the repositories keep, newest first, from GitHub's list of releases
 *       (`GET /repos/{owner}/{repo}/releases`, saved in FILE)
 *   repos.ts verify --tree DIR --cert FILE --releases FILE --release TAG=SUMS [--release …]
 *       [--signed] [--base-url URL] [--download-base URL]
 *       checks a tree build wrote against the releases' SHA256SUMS files and GitHub's list of
 *       releases (each file's size), before it is signed
 *       and (with --signed, its signatures then present) before it is published
 *
 * Each TAG=DIR is a release's tag and a directory with its files: vimma_X.Y.Z_amd64.deb,
 * vimma-X.Y.Z-1.x86_64.rpm and, for the newest, vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst with its
 * .sig. apt and rpm keep the newest N (default 5) releases, pacman the newest only. The packages
 * themselves are not written: the host redirects their requests to the GitHub Release
 * (decision 11). The signatures come after, from openpgp-kms.ts: apt/InRelease (cleartext),
 * rpm/repodata/repomd.xml.asc (armour), arch/x86_64/vimma.db.sig and vimma.files.sig (binary).
 *
 * `build` runs apt-ftparchive (apt-utils), createrepo_c and repo-add (pacman) from PATH. The
 * output depends only on the release files given, never on what the host served before
 * (decision 13). `select` and `verify` run no other program: the signing job runs them, with
 * openpgp-kms.ts, as the only repository code it holds (decision 15).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";

export const DEFAULT_BASE_URL = "https://updates.vimma.dev";
export const DEFAULT_DOWNLOAD_BASE = "https://github.com/vimma-browser/vimma/releases/download";
export const DEFAULT_KEEP = 5;

/** What a path segment of a redirect may hold: a placeholder fills exactly one (decision 11). */
const SAFE = /^[A-Za-z0-9._~+-]+$/;
/** A release version: no pre-release (decision 17). */
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** One release's files, by name, in `dir`. */
export interface Release {
  tag: string;
  version: string;
  dir: string;
  deb: string;
  rpm: string;
  /** The pacman package; its detached signature is the same name with .sig. */
  pacman: string | undefined;
}

/** The releases each format's metadata lists. */
export interface Plan {
  apt: Release[];
  rpm: Release[];
  pacman: Release;
}

function safeName(name: string, what: string): string {
  if (!SAFE.test(name) || name === "." || name === "..") {
    throw new Error(`repos: ${what} ${JSON.stringify(name)} is not in [A-Za-z0-9._~+-]`);
  }
  return name;
}

/** The release in `dir` for `tag`, with each format's file checked to exist. */
export function readRelease(tag: string, dir: string): Release {
  safeName(tag, "tag");
  const version = tag.slice(1);
  if (!tag.startsWith("v") || !VERSION.test(version)) {
    throw new Error(`repos: tag ${tag} is not vX.Y.Z (no pre-release)`);
  }
  const need = (name: string) => {
    safeName(name, "file name");
    if (!existsSync(join(dir, name)))
      throw new Error(`repos: ${tag}: ${join(dir, name)} is missing`);
    return name;
  };
  const deb = need(`vimma_${version}_amd64.deb`);
  const rpm = need(`vimma-${version}-1.x86_64.rpm`);
  let pacman: string | undefined = `vimma-bin-${version}-1-x86_64.pkg.tar.zst`;
  if (existsSync(join(dir, pacman))) need(`${pacman}.sig`);
  else pacman = undefined;
  return { tag, version, dir, deb, rpm, pacman };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest first: apt and rpm keep `keep` releases, pacman the newest, which must have one. */
export function plan(releases: Release[], keep: number): Plan {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`repos: --keep must be at least 1`);
  if (releases.length === 0) throw new Error("repos: no release given");
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  sorted.forEach((r, i) => {
    if (i > 0 && r.version === sorted[i - 1]?.version) {
      throw new Error(`repos: release ${r.version} given twice`);
    }
  });
  const [newest] = sorted;
  if (!newest) throw new Error("repos: no release given");
  if (!newest.pacman)
    throw new Error(`repos: the newest release, ${newest.tag}, has no pacman package`);
  const kept = sorted.slice(0, keep);
  return { apt: kept, rpm: kept, pacman: newest };
}

/** An absolute URL with no trailing slash; plain HTTP only on loopback, for the smoke test. */
function baseUrl(value: string, what: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`repos: ${what} must be https: ${value}`);
  }
  if (value.endsWith("/")) throw new Error(`repos: ${what} must not end in a slash: ${value}`);
  if (url.search || url.hash || /\s/.test(value)) throw new Error(`repos: bad ${what}: ${value}`);
  return value;
}

/**
 * The host's _redirects (Cloudflare Workers static assets): one static rule per package file the
 * metadata lists, to that file in its own release (decision 11). No placeholder, so the host
 * redirects only to the files the signed metadata names, never to another asset of a release.
 */
export function redirectsFile(p: Plan, downloadBase: string): string {
  const base = baseUrl(downloadBase, "download base");
  const rule = (path: string, tag: string, file: string) =>
    `${path}/${safeName(tag, "tag")}/${safeName(file, "file name")}` +
    ` ${base}/${tag}/${file} 302`;
  const pkg = p.pacman.pacman as string;
  const lines = [
    ...p.apt.map((r) => rule("/apt/pool", r.tag, r.deb)),
    ...p.rpm.map((r) => rule("/rpm/packages", r.tag, r.rpm)),
    `/arch/x86_64/${safeName(pkg, "file name")} ${base}/${p.pacman.tag}/${pkg} 302`,
    `/arch/x86_64/${pkg}.sig ${base}/${p.pacman.tag}/${pkg}.sig 302`,
  ];
  return `${lines.join("\n")}\n`;
}

// --- Strict readers -------------------------------------------------------------------------
//
// What repo-sign signs is read by apt, libsolv (dnf, zypper) and libarchive (pacman), each with
// its own parser. A check that reads a file more leniently than they do can be shown one thing
// while they read another: a field repeated in other case, an entry inside an XML comment, a
// tar entry hidden behind a pax size. So each reader below accepts only the shape this
// repository's build writes, puts the file back together from what it read, and refuses it
// unless that is byte for byte the input: nothing it skipped can reach a client.

/**
 * The relations Vimma's packages may declare, per format: what package.ts gives them (its
 * test, "the lists equal what package.ts declares", keeps the two in step) and, for the .rpm,
 * what rpmbuild adds: the desktop file's application() and mimehandler() provides, and the
 * sonames its ELF scan finds in the binaries (release 0.1.22's, by soname; the symbol versions
 * in parentheses vary). A relation outside these lets signed metadata pull in another package
 * or stand in for one. When package.ts drops a relation, it stays here while a kept release
 * still declares it.
 */
export const RELATIONS = {
  deb: {
    Depends: [
      "libc6 (>= 2.31)",
      "libasound2t64 | libasound2",
      "libatk1.0-0t64 | libatk1.0-0",
      "libcairo-gobject2",
      "libcairo2",
      "libdbus-1-3",
      "libfontconfig1",
      "libfreetype6",
      "libgdk-pixbuf-2.0-0",
      "libglib2.0-0t64 | libglib2.0-0",
      "libgtk-3-0t64 | libgtk-3-0",
      "libpango-1.0-0",
      "libpangocairo-1.0-0",
      "libx11-6",
      "libx11-xcb1",
      "libxcb-shm0",
      "libxcb1",
      "libxcomposite1",
      "libxcursor1",
      "libxdamage1",
      "libxext6",
      "libxfixes3",
      "libxi6",
      "libxrandr2",
      "libxrender1",
      "libxtst6",
    ],
    Recommends: ["libpulse0"],
    Provides: ["gnome-www-browser", "www-browser"],
  },
  rpm: {
    requires: ["hicolor-icon-theme", "/bin/sh", "rtld(GNU_HASH)"],
    recommends: ["libpulse.so.0()(64bit)"],
    provides: [
      "vimma",
      "vimma(x86-64)",
      "webclient",
      "application()",
      "application(vimma-vimma.desktop)",
      ...[
        "application/json",
        "application/pdf",
        "application/rdf+xml",
        "application/rss+xml",
        "application/x-xpinstall",
        "application/xhtml+xml",
        "application/xml",
        "audio/flac",
        "audio/ogg",
        "audio/webm",
        "image/avif",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/svg+xml",
        "image/webp",
        "text/html",
        "text/xml",
        "video/ogg",
        "video/webm",
        "x-scheme-handler/http",
        "x-scheme-handler/https",
      ].map((m) => `mimehandler(${m})`),
    ],
    sonames: [
      "ld-linux-x86-64.so.2",
      "libX11-xcb.so.1",
      "libX11.so.6",
      "libXcomposite.so.1",
      "libXcursor.so.1",
      "libXdamage.so.1",
      "libXext.so.6",
      "libXfixes.so.3",
      "libXi.so.6",
      "libXrandr.so.2",
      "libXrender.so.1",
      "libXtst.so.6",
      "libasound.so.2",
      "libatk-1.0.so.0",
      "libc.so.6",
      "libcairo-gobject.so.2",
      "libcairo.so.2",
      "libdbus-1.so.3",
      "libdl.so.2",
      "libfontconfig.so.1",
      "libfreetype.so.6",
      "libgcc_s.so.1",
      "libgdk-3.so.0",
      "libgdk_pixbuf-2.0.so.0",
      "libgio-2.0.so.0",
      "libglib-2.0.so.0",
      "libgobject-2.0.so.0",
      "libgtk-3.so.0",
      "libm.so.6",
      "libpango-1.0.so.0",
      "libpangocairo-1.0.so.0",
      "libpthread.so.0",
      "libresolv.so.2",
      "librt.so.1",
      "libstdc++.so.6",
      "libxcb-shm.so.0",
      "libxcb.so.1",
    ],
  },
  pacman: {
    DEPENDS: ["alsa-lib", "dbus", "gtk3", "hicolor-icon-theme", "libxt", "mime-types", "ttf-font"],
    OPTDEPENDS: [
      "ffmpeg: H.264, AAC and MP3 playback",
      "libpulse: PulseAudio audio (also via pipewire-pulse)",
      "networkmanager: location detection via available Wi-Fi networks",
    ],
    PROVIDES: ["vimma"],
    CONFLICTS: ["vimma"],
  },
};

/** Whether an rpm relation name is one Vimma's .rpm may declare in `kind`. */
function rpmRelation(kind: "requires" | "recommends" | "provides", name: string): boolean {
  if (RELATIONS.rpm[kind].includes(name)) return true;
  if (kind !== "requires") return false;
  // a soname, bare or with a symbol version: libc.so.6()(64bit), libc.so.6(GLIBC_2.17)(64bit)
  const m = /^(.+?)\((?:[A-Za-z0-9_.]*)\)\(64bit\)$/.exec(name);
  return !!m?.[1] && RELATIONS.rpm.sonames.includes(m[1]);
}

/** The paths Vimma's .rpm installs, in primary.xml and filelists.xml. */
const RPM_PATH =
  /^\/usr\/(?:lib\/vimma(?:\/[^/]+)*|bin\/vimma(?:-open|-ctl)?|share\/applications\/vimma-vimma\.desktop|share\/doc\/vimma(?:\/[^/]+)*|share\/icons\/hicolor\/(?:[0-9]+x[0-9]+|scalable)\/apps\/vimma\.(?:png|svg))$/;
function rpmPath(path: string): boolean {
  return RPM_PATH.test(path) && !path.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * One gzip member, as Node's zlib and createrepo_c write it (no optional header fields), and
 * nothing after it: apt, librepo and libarchive read on into a second member or past trailing
 * bytes in ways that differ from each other, so any of them is refused.
 */
function gunzipOne(gz: Buffer, what: string): Buffer {
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8 || gz[3] !== 0) {
    fail("is not one plain gzip member");
  }
  let out: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    out = inflateRawSync(gz.subarray(10), { info: true }) as unknown as typeof out;
  } catch {
    return fail("is not gzip");
  }
  const end = 10 + out.engine.bytesWritten;
  if (gz.length !== end + 8) fail("has something after its gzip member");
  if (
    gz.readUInt32LE(end) !== crc32(out.buffer) ||
    gz.readUInt32LE(end + 4) !== out.buffer.length % 2 ** 32
  ) {
    fail("has a wrong gzip checksum or size");
  }
  return out.buffer;
}

/**
 * Text no reader may see differently: no C0 or C1 control (but LF), no BOM, no U+FFFD (what an
 * invalid UTF-8 byte decodes to) and no noncharacter.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const BAD_CHARS = /[\x00-\x09\x0B-\x1F\x7F-\x9F\uFEFF\uFFFD\uFFFE\uFFFF]/;

/** The fields a stanza of Packages may have: what package.ts writes and apt-ftparchive adds. */
const PACKAGES_FIELDS = [
  "Package",
  "Version",
  "Architecture",
  "Maintainer",
  "Installed-Size",
  "Depends",
  "Recommends",
  "Provides",
  "Section",
  "Priority",
  "Homepage",
  "Description",
  "Filename",
  "Size",
  "SHA256",
];

/**
 * A deb822 file of `allowed` fields only, in their exact spelling: each line `Key: value`, or a
 * continuation (` text`) under a field of `multiline`, which alone may have an empty first
 * line; no field twice, compared without case as apt compares them; stanzas apart by one empty
 * line; LF only.
 */
function deb822(
  text: string,
  what: string,
  allowed: string[],
  multiline: string[],
  trailer: string,
): Map<string, string[]>[] {
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  if (BAD_CHARS.test(text)) fail("has a control character, BOM, U+FFFD or noncharacter");
  if (!text.endsWith(`\n${trailer}`)) fail("does not end as the build writes it");
  const body = text.slice(0, text.length - 1 - trailer.length);
  const out = body.split("\n\n").map((block) => {
    const fields = new Map<string, string[]>();
    const seen = new Set<string>();
    let current: string[] | undefined;
    let key = "";
    for (const line of block.split("\n")) {
      const cont = /^ (\S(?:.*\S)?)$/.exec(line);
      if (cont?.[1] !== undefined) {
        if (!current || !multiline.includes(key))
          fail(`a continuation line under ${key || "nothing"}`);
        (current as string[]).push(cont[1]);
        continue;
      }
      const m = /^([A-Za-z][A-Za-z0-9-]*):(?: (\S(?:.*\S)?))?$/.exec(line);
      if (!m?.[1]) fail(`line ${JSON.stringify(line)} is no field`);
      key = (m as RegExpExecArray)[1] as string;
      const value = (m as RegExpExecArray)[2];
      if (!allowed.includes(key)) fail(`${key} is not a field it may have`);
      if (seen.has(key.toLowerCase())) fail(`${key} is there twice`);
      seen.add(key.toLowerCase());
      if (value === undefined && !multiline.includes(key)) fail(`${key} has no value`);
      current = [value ?? ""];
      fields.set(key, current);
    }
    return fields;
  });
  const again =
    out
      .map((f) =>
        [...f]
          .map(([k, v]) => {
            const [first, ...rest] = v;
            const head = first === "" ? `${k}:` : `${k}: ${first}`;
            return [head, ...rest.map((l) => ` ${l}`)].join("\n");
          })
          .join("\n"),
      )
      .join("\n\n") + `\n${trailer}`;
  if (again !== text) fail("is not in the form the build writes");
  return out;
}

const one = (f: Map<string, string[]>, key: string) => {
  const v = f.get(key);
  return v?.length === 1 ? v[0] : undefined;
};

/**
 * Refuses apt's Packages unless it has exactly one stanza per kept release, each the package
 * `vimma` at the release's version, at the release's path (and, with `sums` and `sizes`, under
 * the SHA-256 and size of that release's file): the signature will vouch for what
 * apt-ftparchive read from the files, so a file that is not the release it claims stops here.
 */
export function checkPackages(
  text: string,
  releases: Release[],
  sums?: (r: Release, file: string) => string,
  sizes?: (r: Release, file: string) => number,
): void {
  const found = deb822(text, "Packages", PACKAGES_FIELDS, ["Description"], "\n");
  for (const r of releases) {
    const s = found.filter((f) => one(f, "Filename") === `pool/${r.tag}/${r.deb}`);
    const f = s[0];
    if (
      s.length !== 1 ||
      !f ||
      one(f, "Package") !== "vimma" ||
      one(f, "Version") !== r.version ||
      one(f, "Architecture") !== "amd64"
    ) {
      throw new Error(`repos: Packages does not list vimma ${r.version} for ${r.tag}`);
    }
    if (
      !/^[1-9][0-9]*$/.test(one(f, "Size") ?? "") ||
      !/^[0-9a-f]{64}$/.test(one(f, "SHA256") ?? "")
    ) {
      throw new Error(`repos: Packages: pool/${r.tag}/${r.deb} has no Size or SHA256`);
    }
    if (sums && one(f, "SHA256") !== sums(r, r.deb)) {
      throw new Error(
        `repos: Packages: the SHA256 of pool/${r.tag}/${r.deb} is not the one ${r.tag}'s SHA256SUMS lists`,
      );
    }
    if (sizes && one(f, "Size") !== String(sizes(r, r.deb))) {
      throw new Error(
        `repos: Packages: the Size of pool/${r.tag}/${r.deb} is not the release file's`,
      );
    }
  }
  for (const f of found) {
    for (const key of ["Depends", "Recommends", "Provides"] as const) {
      const value = one(f, key);
      if (value === undefined) continue;
      for (const clause of value.split(", ")) {
        if (!RELATIONS.deb[key].includes(clause)) {
          throw new Error(
            `repos: Packages: ${key} ${JSON.stringify(clause)} is not one of Vimma's`,
          );
        }
      }
    }
  }
  if (found.length !== releases.length) {
    throw new Error(`repos: Packages has ${found.length} stanzas, want ${releases.length}`);
  }
}

/** An XML element as the strict reader keeps it: enough to write it back byte for byte. */
interface XmlElement {
  name: string;
  attrs: [string, string][];
  /** Written `<x/>`, not `<x></x>`. */
  empty: boolean;
  children: (XmlElement | string)[];
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

/**
 * The subset of XML that createrepo_c writes: the declaration, elements, attributes in double
 * quotes, text, and the five predefined entities. No comment, CDATA, DOCTYPE, processing
 * instruction, other entity or xml: attribute (xml:base would move a package's location), each
 * of which libsolv reads in a way a check by pattern would not.
 */
function readXml(text: string, what: string): XmlElement {
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  if (!text.startsWith(XML_DECL)) fail("does not start with the XML declaration");
  if (BAD_CHARS.test(text)) fail("has a character XML forbids, or a control character");
  if (text.includes("]]>")) fail("has ]]> in its text");
  if (text.includes("<!")) fail("has a comment, CDATA or DOCTYPE");
  if (text.indexOf("<?", 1) !== -1) fail("has a processing instruction");
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) fail("has an entity that is not predefined");
  let at = XML_DECL.length;
  const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;
  const name = () => {
    NAME.lastIndex = at;
    const m = NAME.exec(text);
    if (!m) fail(`no name at ${at}`);
    at += (m as RegExpExecArray)[0].length;
    return (m as RegExpExecArray)[0];
  };
  const element = (depth: number): XmlElement => {
    if (depth > 32) fail("nests too deep");
    if (text[at] !== "<") fail(`no element at ${at}`);
    at += 1;
    const el: XmlElement = { name: name(), attrs: [], empty: false, children: [] };
    // No tab or newline in a value: XML turns each into a space when it reads the attribute.
    const ATTR = / ([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)="([^"<\t\n]*)"/y;
    for (;;) {
      ATTR.lastIndex = at;
      const m = ATTR.exec(text);
      if (!m) break;
      const [, k, v] = m as unknown as [string, string, string];
      if (k.startsWith("xml:")) fail(`${el.name} has ${k}`);
      if (el.attrs.some(([a]) => a === k)) fail(`${el.name} has ${k} twice`);
      el.attrs.push([k, v]);
      at += m[0].length;
    }
    if (text.startsWith("/>", at)) {
      at += 2;
      el.empty = true;
      return el;
    }
    if (text[at] !== ">") fail(`${el.name}: a malformed tag at ${at}`);
    at += 1;
    for (;;) {
      if (text.startsWith("</", at)) {
        at += 2;
        if (name() !== el.name || text[at] !== ">") fail(`${el.name} is not closed`);
        at += 1;
        return el;
      }
      if (text[at] === "<") el.children.push(element(depth + 1));
      else {
        const end = text.indexOf("<", at);
        if (end === -1) fail(`${el.name} is not closed`);
        el.children.push(text.slice(at, end));
        at = end;
      }
    }
  };
  const root = element(0);
  const rest = text.slice(at);
  if (rest !== "" && rest !== "\n") fail("has more after its root element");
  const write = (e: XmlElement): string =>
    `<${e.name}${e.attrs.map(([k, v]) => ` ${k}="${v}"`).join("")}` +
    (e.empty
      ? "/>"
      : `>${e.children.map((c) => (typeof c === "string" ? c : write(c))).join("")}</${e.name}>`);
  if (`${XML_DECL}${write(root)}${rest}` !== text) fail("is not in the form createrepo_c writes");
  return root;
}

const unescapeXml = (s: string) =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e] ?? "",
  );

/** The element children of `e`; text between them must be white space only. */
function elementsOf(e: XmlElement, what: string): XmlElement[] {
  for (const c of e.children) {
    if (typeof c === "string" && !/^[ \n]*$/.test(c)) {
      throw new Error(`repos: ${what}: text in ${e.name}`);
    }
  }
  return e.children.filter((c): c is XmlElement => typeof c !== "string");
}

/** The text of a leaf element (no element inside), entities decoded. */
function textOf(e: XmlElement, what: string): string {
  if (e.children.some((c) => typeof c !== "string")) {
    throw new Error(`repos: ${what}: ${e.name} holds an element`);
  }
  return unescapeXml(e.children.join(""));
}

/** The attributes of `e`, which must be exactly `names`, in that order. */
function attrsOf(e: XmlElement, names: string[], what: string): Record<string, string> {
  if (e.attrs.map(([k]) => k).join(" ") !== names.join(" ")) {
    throw new Error(
      `repos: ${what}: ${e.name} has attributes ${e.attrs.map(([k]) => k).join(" ") || "none"}`,
    );
  }
  return Object.fromEntries(e.attrs.map(([k, v]) => [k, unescapeXml(v)]));
}

const PRIMARY_CHILDREN = [
  "name",
  "arch",
  "version",
  "checksum",
  "summary",
  "description",
  "packager",
  "url",
  "time",
  "size",
  "location",
  "format",
];
/**
 * What a package's <format> may hold: the relations Vimma's .rpm declares (requires,
 * recommends, provides) and descriptive fields; never obsoletes, conflicts or the weak
 * relations that would let it replace or remove another package.
 */
const FORMAT_CHILDREN = [
  "rpm:license",
  "rpm:vendor",
  "rpm:group",
  "rpm:buildhost",
  "rpm:sourcerpm",
  "rpm:header-range",
  "rpm:provides",
  "rpm:requires",
  "rpm:recommends",
  "file",
];
const RPM_NS = {
  common: "http://linux.duke.edu/metadata/common",
  filelists: "http://linux.duke.edu/metadata/filelists",
  other: "http://linux.duke.edu/metadata/other",
  repo: "http://linux.duke.edu/metadata/repo",
  rpm: "http://linux.duke.edu/metadata/rpm",
};

/**
 * Refuses primary.xml unless it lists exactly vimma X.Y.Z-1 for each kept release, at its path,
 * in the shape createrepo_c writes, with nothing that would make it replace another package
 * (and, with `sums` and `sizes`, under its release file's SHA-256 and size).
 */
export function checkPrimary(
  xml: string,
  releases: Release[],
  sums?: (r: Release, file: string) => string,
  sizes?: (r: Release, file: string) => number,
): void {
  const what = "primary.xml";
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  const root = readXml(xml, what);
  if (root.name !== "metadata") fail("its root is not metadata");
  const top = attrsOf(root, ["xmlns", "xmlns:rpm", "packages"], what);
  if (top.xmlns !== RPM_NS.common || top["xmlns:rpm"] !== RPM_NS.rpm) fail("wrong namespaces");
  const packages = elementsOf(root, what);
  const listed = new Map<string, XmlElement>();
  for (const p of packages) {
    if (p.name !== "package" || attrsOf(p, ["type"], what).type !== "rpm")
      fail("an entry that is not an rpm package");
    const kids = elementsOf(p, what);
    if (kids.map((k) => k.name).join(" ") !== PRIMARY_CHILDREN.join(" ")) {
      fail(`a package of ${kids.map((k) => k.name).join(", ")}`);
    }
    const [
      name,
      arch,
      version,
      checksum,
      summary,
      description,
      packager,
      url,
      time,
      size,
      location,
      format,
    ] = kids as XmlElement[] & { length: 12 };
    const v = attrsOf(version as XmlElement, ["epoch", "ver", "rel"], what);
    const href = attrsOf(location as XmlElement, ["href"], what).href ?? "";
    if (
      textOf(name as XmlElement, what) !== "vimma" ||
      textOf(arch as XmlElement, what) !== "x86_64" ||
      v.epoch !== "0" ||
      v.rel !== "1"
    ) {
      fail(`a package that is not vimma for x86_64 at release 1: ${href}`);
    }
    const c = attrsOf(checksum as XmlElement, ["type", "pkgid"], what);
    if (
      c.type !== "sha256" ||
      c.pkgid !== "YES" ||
      !/^[0-9a-f]{64}$/.test(textOf(checksum as XmlElement, what))
    ) {
      fail(`${href}: no sha256 checksum`);
    }
    for (const leaf of [summary, description, packager, url]) textOf(leaf as XmlElement, what);
    attrsOf(time as XmlElement, ["file", "build"], what);
    const sz = attrsOf(size as XmlElement, ["package", "installed", "archive"], what);
    for (const n of Object.values(sz))
      if (!/^[0-9]+$/.test(n)) fail(`${href}: a size that is no number`);
    attrsOf(format as XmlElement, [], what);
    let last = -1;
    for (const f of elementsOf(format as XmlElement, what)) {
      const at = FORMAT_CHILDREN.indexOf(f.name);
      if (at === -1) fail(`${href} has ${f.name}`);
      // createrepo_c's order, each once; only <file> repeats, at the end
      if (at < last || (at === last && f.name !== "file"))
        fail(`${href}: ${f.name} out of order or twice`);
      last = at;
      if (["rpm:provides", "rpm:requires", "rpm:recommends"].includes(f.name)) {
        attrsOf(f, [], what);
        const kind = f.name.slice(4) as "provides" | "requires" | "recommends";
        for (const e of elementsOf(f, what)) {
          if (e.name !== "rpm:entry" || !e.empty) fail(`${href}: ${f.name} holds ${e.name}`);
          for (const [k] of e.attrs) {
            if (!["name", "flags", "epoch", "ver", "rel", "pre"].includes(k))
              fail(`${href}: an entry with ${k}`);
          }
          const name = unescapeXml(e.attrs.find(([k]) => k === "name")?.[1] ?? "");
          if (!rpmRelation(kind, name))
            fail(`${href}: ${kind} ${JSON.stringify(name)} is not one of Vimma's`);
        }
      } else if (f.name === "rpm:header-range") {
        attrsOf(f, ["start", "end"], what);
      } else if (f.name === "file") {
        if (f.attrs.some(([k, v]) => k !== "type" || !["dir", "ghost"].includes(v))) {
          fail(`${href}: a file with other attributes`);
        }
        if (!rpmPath(textOf(f, what)))
          fail(`${href}: the file ${JSON.stringify(textOf(f, what))} is not in Vimma's paths`);
      } else {
        attrsOf(f, [], what);
        textOf(f, what);
      }
    }
    if (listed.has(href)) fail(`${href} twice`);
    listed.set(href, p);
    const r = releases.find((x) => href === `packages/${x.tag}/${x.rpm}`);
    if (!r || v.ver !== r.version) continue;
    if (sums && textOf(checksum as XmlElement, what) !== sums(r, r.rpm)) {
      fail(`the checksum of packages/${r.tag}/${r.rpm} is not the one ${r.tag}'s SHA256SUMS lists`);
    }
    if (sizes && sz.package !== String(sizes(r, r.rpm))) {
      fail(`the size of packages/${r.tag}/${r.rpm} is not the release file's`);
    }
  }
  for (const r of releases) {
    const p = listed.get(`packages/${r.tag}/${r.rpm}`);
    const ver = p
      ? attrsOf(elementsOf(p, what)[2] as XmlElement, ["epoch", "ver", "rel"], what).ver
      : undefined;
    if (ver !== r.version) {
      throw new Error(`repos: primary.xml does not list vimma ${r.version}-1 for ${r.tag}`);
    }
  }
  if (packages.length !== releases.length || top.packages !== String(releases.length)) {
    fail(`has ${packages.length} packages, want ${releases.length}`);
  }
}

/** Refuses filelists.xml or other.xml unless it lists exactly the packages `pkgids` names. */
function checkFilelists(xml: string, type: "filelists" | "other", pkgids: string[]): void {
  const what = `${type}.xml`;
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  const root = readXml(xml, what);
  if (root.name !== (type === "other" ? "otherdata" : "filelists")) fail("wrong root");
  const top = attrsOf(root, ["xmlns", "packages"], what);
  if (top.xmlns !== RPM_NS[type] || top.packages !== String(pkgids.length))
    fail("wrong namespace or count");
  const ids = elementsOf(root, what).map((p) => {
    if (p.name !== "package") fail(`has ${p.name}`);
    const a = attrsOf(p, ["pkgid", "name", "arch"], what);
    if (a.name !== "vimma" || a.arch !== "x86_64") fail("a package that is not vimma for x86_64");
    const [version, ...rest] = elementsOf(p, what);
    if (version?.name !== "version") fail("a package without its version first");
    attrsOf(version as XmlElement, ["epoch", "ver", "rel"], what);
    for (const e of rest) {
      if (type === "filelists") {
        if (
          e.name !== "file" ||
          e.attrs.some(([k, v]) => k !== "type" || !["dir", "ghost"].includes(v))
        ) {
          fail(`has ${e.name}`);
        }
        if (!rpmPath(textOf(e, what)))
          fail(`the file ${JSON.stringify(textOf(e, what))} is not in Vimma's paths`);
      } else if (e.name !== "changelog") fail(`has ${e.name}`);
      else attrsOf(e, ["author", "date"], what);
      textOf(e, what);
    }
    return a.pkgid ?? "";
  });
  if ([...ids].sort().join(" ") !== [...pkgids].sort().join(" ")) {
    fail("does not list exactly the releases' .rpm files");
  }
}

/** repomd.xml's three index files, in the shape createrepo_c writes it. */
function readRepomd(xml: string): {
  type: string;
  href: string;
  checksum: string;
  open: string;
  size: number;
  openSize: number;
}[] {
  const what = "repomd.xml";
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  const root = readXml(xml, what);
  if (root.name !== "repomd") fail("wrong root");
  const top = attrsOf(root, ["xmlns", "xmlns:rpm"], what);
  if (top.xmlns !== RPM_NS.repo || top["xmlns:rpm"] !== RPM_NS.rpm) fail("wrong namespaces");
  const [revision, ...data] = elementsOf(root, what);
  if (revision?.name !== "revision" || !/^[0-9]+$/.test(textOf(revision, what)))
    fail("no revision first");
  const out = data.map((d) => {
    if (d.name !== "data") fail(`has ${d.name}`);
    const type = attrsOf(d, ["type"], what).type ?? "";
    const kids = elementsOf(d, what);
    const names = "checksum open-checksum location timestamp size open-size";
    if (kids.map((k) => k.name).join(" ") !== names)
      fail(`${type} holds ${kids.map((k) => k.name).join(", ")}`);
    const [checksum, open, location, timestamp, size, openSize] = kids as XmlElement[];
    for (const c of [checksum, open] as XmlElement[]) {
      if (attrsOf(c, ["type"], what).type !== "sha256" || !/^[0-9a-f]{64}$/.test(textOf(c, what))) {
        fail(`repomd.xml's ${type} has no sha256 checksum`);
      }
    }
    for (const n of [timestamp, size, openSize] as XmlElement[]) {
      attrsOf(n, [], what);
      if (!/^[0-9]+$/.test(textOf(n, what))) fail(`${type}: ${n.name} is no number`);
    }
    const href = attrsOf(location as XmlElement, ["href"], what).href ?? "";
    // createrepo_c's name, the file's own checksum and type: nothing else may be fetched
    if (href !== `repodata/${textOf(checksum as XmlElement, what)}-${type}.xml.gz`) {
      fail(`${type} has location ${href}`);
    }
    return {
      type,
      href,
      checksum: textOf(checksum as XmlElement, what),
      open: textOf(open as XmlElement, what),
      size: Number(textOf(size as XmlElement, what)),
      openSize: Number(textOf(openSize as XmlElement, what)),
    };
  });
  if (
    out
      .map((d) => d.type)
      .sort()
      .join(" ") !== "filelists other primary"
  ) {
    fail("repomd.xml does not list exactly primary, filelists and other");
  }
  return out;
}

/** A tar entry the strict reader keeps: a directory or a regular file. */
interface TarEntry {
  name: string;
  data: Buffer;
}

const TAR_BLOCK = 512;

/**
 * pacman's databases as this tool writes them (`pacmanDb`), never repo-add's own bytes: ustar
 * headers of a directory and regular files, uid and gid 0, mtime 0, then gzip. One writer, so
 * `readPacmanDb` can demand those exact bytes back.
 */
function tarHeader(name: string, size: number, dir: boolean): Buffer {
  if (Buffer.byteLength(name) > 99 || /[^A-Za-z0-9._+/-]/.test(name)) {
    throw new Error(`repos: tar: bad entry name ${JSON.stringify(name)}`);
  }
  const h = Buffer.alloc(TAR_BLOCK);
  h.write(name, 0, "latin1");
  h.write(dir ? "0000755\0" : "0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write("        ", 148, "latin1");
  h.write(dir ? "5" : "0", 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  h.write("root", 265, "latin1");
  h.write("root", 297, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const dir = e.name.endsWith("/");
    parts.push(tarHeader(e.name, dir ? 0 : e.data.length, dir));
    if (!dir) {
      parts.push(e.data, Buffer.alloc((TAR_BLOCK - (e.data.length % TAR_BLOCK)) % TAR_BLOCK));
    }
  }
  parts.push(Buffer.alloc(2 * TAR_BLOCK));
  return Buffer.concat(parts);
}

/** The keys a database's desc may have, in repo-add's order; MD5SUM and PGPSIG are dropped. */
const DESC_KEYS = [
  "FILENAME",
  "NAME",
  "BASE",
  "VERSION",
  "DESC",
  "CSIZE",
  "ISIZE",
  "SHA256SUM",
  "URL",
  "LICENSE",
  "ARCH",
  "BUILDDATE",
  "PACKAGER",
  "CONFLICTS",
  "PROVIDES",
  "DEPENDS",
  "OPTDEPENDS",
];

/** A desc as `%KEY%` blocks, each its value lines and an empty line. */
function descBlocks(text: string): [string, string[]][] {
  if (BAD_CHARS.test(text)) throw new Error("repos: vimma.db: desc has a control character");
  const blocks: [string, string[]][] = [];
  if (!text.endsWith("\n\n"))
    throw new Error("repos: vimma.db: desc does not end in an empty line");
  for (const block of text.slice(0, -2).split("\n\n")) {
    const [head, ...values] = block.split("\n");
    const m = /^%([A-Z0-9]+)%$/.exec(head ?? "");
    if (!m?.[1] || !values.length || values.some((v) => !v || v.startsWith("%"))) {
      throw new Error(`repos: vimma.db: desc has a malformed block ${JSON.stringify(head)}`);
    }
    blocks.push([m[1], values]);
  }
  return blocks;
}

const descText = (blocks: [string, string[]][]) =>
  blocks.map(([k, v]) => `%${k}%\n${v.join("\n")}\n\n`).join("");

/**
 * The database's desc for the release, as Vimma publishes it: repo-add's, without MD5SUM (the
 * SHA-256 is there) or PGPSIG (pacman fetches the .sig), and refused when it has a key pacman
 * would act on beyond installing this package, such as REPLACES.
 */
function canonicalDesc(text: string, r: Release, sha?: string, size?: number): string {
  const fail = (m: string): never => {
    throw new Error(`repos: vimma.db: ${m}`);
  };
  const blocks = descBlocks(text).filter(([k]) => k !== "MD5SUM" && k !== "PGPSIG");
  let last = -1;
  for (const [k] of blocks) {
    const i = DESC_KEYS.indexOf(k);
    if (i === -1) fail(`desc has %${k}%`);
    if (i <= last) fail(`desc has %${k}% out of order or twice`);
    last = i;
  }
  const get = (k: string) => blocks.find(([key]) => key === k)?.[1];
  const single = (k: string) => {
    const v = get(k);
    return v?.length === 1 ? v[0] : undefined;
  };
  if (
    single("NAME") !== "vimma-bin" ||
    single("BASE") !== "vimma-bin" ||
    single("VERSION") !== `${r.version}-1` ||
    single("FILENAME") !== r.pacman ||
    single("ARCH") !== "x86_64"
  ) {
    fail(`does not list exactly vimma-bin ${r.version}-1 for ${r.tag}`);
  }
  for (const k of ["DEPENDS", "OPTDEPENDS", "PROVIDES", "CONFLICTS"] as const) {
    for (const v of get(k) ?? []) {
      if (!RELATIONS.pacman[k].includes(v))
        fail(`%${k}% ${JSON.stringify(v)} is not one of Vimma's`);
    }
  }
  if (
    !/^[0-9a-f]{64}$/.test(single("SHA256SUM") ?? "") ||
    !/^[0-9]+$/.test(single("CSIZE") ?? "")
  ) {
    fail(`${r.pacman} has no SHA256SUM or CSIZE`);
  }
  if (sha !== undefined && single("SHA256SUM") !== sha) {
    fail(`the SHA256SUM of ${r.pacman} is not the one ${r.tag}'s SHA256SUMS lists`);
  }
  if (size !== undefined && single("CSIZE") !== String(size)) {
    fail(`the CSIZE of ${r.pacman} is not the release file's size`);
  }
  return descText(blocks);
}

/** vimma.db (desc alone) or vimma.files (desc and the file list), gzipped. */
export function pacmanDatabase(r: Release, desc: string, files?: string): Buffer {
  return gzipSync(pacmanTar(r, desc, files), { level: 9 });
}

/** The tar inside vimma.db or vimma.files. */
function pacmanTar(r: Release, desc: string, files?: string): Buffer {
  const dir = `vimma-bin-${r.version}-1/`;
  const entries: TarEntry[] = [
    { name: dir, data: Buffer.alloc(0) },
    { name: `${dir}desc`, data: Buffer.from(desc, "utf8") },
  ];
  if (files !== undefined) entries.push({ name: `${dir}files`, data: Buffer.from(files, "utf8") });
  return writeTar(entries);
}

/**
 * The entries of a database this tool wrote: only ustar directories and regular files, every
 * checksum right, no pax or GNU header, the two end blocks and nothing after. Then the caller
 * writes the same entries again and demands the same bytes.
 */
function readTar(data: Buffer, what: string): TarEntry[] {
  const fail = (m: string): never => {
    throw new Error(`repos: ${what}: ${m}`);
  };
  const entries: TarEntry[] = [];
  let at = 0;
  for (;;) {
    if (at + TAR_BLOCK > data.length) fail("ends inside a header");
    const h = data.subarray(at, at + TAR_BLOCK);
    if (h.every((b) => b === 0)) {
      if (data.length !== at + 2 * TAR_BLOCK || !data.subarray(at).every((b) => b === 0)) {
        fail("has something after its end");
      }
      return entries;
    }
    const field = (from: number, len: number) => h.subarray(from, from + len).toString("latin1");
    if (field(257, 8) !== "ustar\x0000") fail("an entry that is not ustar");
    const type = field(156, 1);
    if (type !== "0" && type !== "5")
      fail(`an entry of type ${JSON.stringify(type)}, not a file or directory`);
    const sizeField = field(124, 12);
    if (!/^[0-7]{11}\0$/.test(sizeField)) fail("a malformed size");
    const size = parseInt(sizeField.slice(0, 11), 8);
    const name = field(0, 100).replace(/\0+$/, "");
    if (name.includes("\0") || !/^\0*$/.test(field(345, 155))) fail("a malformed name");
    if ((type === "5") !== name.endsWith("/") || (type === "5" && size !== 0))
      fail(`${name}: type and name disagree`);
    if (at + TAR_BLOCK + size > data.length) fail(`${name} runs past the end`);
    entries.push({ name, data: Buffer.from(data.subarray(at + TAR_BLOCK, at + TAR_BLOCK + size)) });
    at += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

/**
 * Refuses a pacman database unless it is exactly what `pacmanDb` writes for the release: its
 * directory and desc (and for vimma.files its file list), in those bytes. Returns the desc.
 */
function readPacmanDb(
  gz: Buffer,
  r: Release,
  what: "vimma.db" | "vimma.files",
  sha?: string,
  size?: number,
): { desc: string; files: string | undefined } {
  const dir = `vimma-bin-${r.version}-1/`;
  // Compared decompressed: two runners' zlib may compress the same tar differently, and the
  // signing job writes the gzip it signs itself (verify's regzip).
  const tar = gunzipOne(gz, what);
  const entries = readTar(tar, what);
  const names = entries.map((e) => e.name).join(" ");
  const want = what === "vimma.db" ? `${dir} ${dir}desc` : `${dir} ${dir}desc ${dir}files`;
  if (names !== want)
    throw new Error(`repos: ${what} does not list exactly vimma-bin ${r.version}-1 for ${r.tag}`);
  const desc = entries[1]?.data.toString("utf8") ?? "";
  if (canonicalDesc(desc, r, sha, size) !== desc)
    throw new Error(`repos: ${what}: desc is not in canonical form`);
  let files: string | undefined;
  if (what === "vimma.files") {
    files = entries[2]?.data.toString("utf8") ?? "";
    if (!/^%FILES%\n(?:[^\0\r\n%][^\0\r\n]*\n)*\n?$/.test(files))
      throw new Error("repos: vimma.files: a malformed file list");
  }
  if (!pacmanTar(r, desc, files).equals(tar))
    throw new Error(`repos: ${what} is not the tar repos.ts writes`);
  return { desc, files };
}

/** The files of a tar archive by name (ustar and pax, as bsdtar writes them). */
export function untar(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  let paxPath: string | undefined;
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, len: number) =>
      header
        .subarray(from, from + len)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar")
      ? field(345, 155)
      : "";
    const body = data.subarray(at + 512, at + 512 + size);
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
    } else if (type !== "g") {
      const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      files.set(name, body);
      paxPath = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Refuses the pacman database unless it holds exactly vimma-bin X.Y.Z-1 of the release, in the
 * form this tool writes it.
 */
export function checkPacmanDb(tarGz: Buffer, r: Release): void {
  readPacmanDb(tarGz, r, "vimma.db");
}

/**
 * The host's _headers: the update manifest's rule, which the host already has, and the same for
 * the repositories and the key, so clients and Cloudflare see a release at once (decision 14).
 */
export function headersFile(): string {
  return ["/updates/*", "/apt/*", "/rpm/*", "/arch/*", "/vimma-packages.asc"]
    .map((p) => `${p}\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n`)
    .join("");
}

/**
 * apt's deb822 source with the key inline in Signed-By, so apt trusts it for this repository
 * only (Behaviour 1). A flat repository: Suites is the exact path ./ and there are no
 * Components (sources.list(5)).
 */
export function aptSources(host: string, cert: string): string {
  const base = baseUrl(host, "base URL");
  const key = cert
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => (l === "" ? " ." : ` ${l}`))
    .join("\n");
  return `Types: deb\nURIs: ${base}/apt/\nSuites: ./\nSigned-By:\n${key}\n`;
}

/**
 * The .repo file for dnf and zypper (decision 8): package and metadata signatures both checked.
 * Only options both read: dnf5's `config-manager addrepo --from-repofile` refuses one it does
 * not know, such as zypper's autorefresh and pkg_gpgcheck, which zypper's setup command sets
 * with flags instead.
 */
export function rpmRepo(host: string): string {
  const base = baseUrl(host, "base URL");
  return (
    `[vimma]\nname=Vimma\nbaseurl=${base}/rpm/\ntype=rpm-md\nenabled=1\n` +
    `gpgcheck=1\nrepo_gpgcheck=1\ngpgkey=${base}/vimma-packages.asc\n`
  );
}

/**
 * apt-ftparchive writes MD5, SHA-1, SHA-256 and SHA-512 by default; only SHA-256, the hash a
 * release's SHA256SUMS lists, so `verify` compares every hash apt may check (apt uses the
 * strongest one a file lists).
 */
const APT_SHA256_ONLY = [
  "-o",
  "APT::FTPArchive::MD5=false",
  "-o",
  "APT::FTPArchive::SHA1=false",
  "-o",
  "APT::FTPArchive::SHA512=false",
];

function tool(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`repos: ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`repos: ${cmd} ${args.join(" ")} failed:\n${r.stderr}`);
  return r.stdout;
}

export interface BuildOptions {
  releases: { tag: string; dir: string }[];
  out: string;
  cert: string;
  keep: number;
  baseUrl: string;
  downloadBase: string;
}

/** Writes the host's repository files into `out`, which must be empty or not yet exist. */
export async function build(opts: BuildOptions): Promise<void> {
  if (existsSync(opts.out) && readdirSync(opts.out).length > 0) {
    throw new Error(`repos: ${opts.out} is not empty`);
  }
  const p = plan(
    opts.releases.map((r) => readRelease(r.tag, r.dir)),
    opts.keep,
  );
  const cert = readFileSync(opts.cert, "utf8");
  if (!cert.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----\n")) {
    throw new Error(`repos: ${opts.cert} is not an armoured OpenPGP certificate`);
  }
  const sources = aptSources(opts.baseUrl, cert);
  const repo = rpmRepo(opts.baseUrl);
  const redirects = redirectsFile(p, opts.downloadBase);

  const work = mkdtempSync(join(tmpdir(), "vimma-repos-"));
  try {
    const out = opts.out;
    mkdirSync(out, { recursive: true });

    // apt: Packages from a pool laid out as the host's paths, then Release over it.
    const aptWork = join(work, "apt");
    for (const r of p.apt) {
      mkdirSync(join(aptWork, "pool", r.tag), { recursive: true });
      copyFileSync(join(r.dir, r.deb), join(aptWork, "pool", r.tag, r.deb));
    }
    const packages = tool("apt-ftparchive", [...APT_SHA256_ONLY, "packages", "pool"], aptWork);
    checkPackages(packages, p.apt);
    const apt = join(out, "apt");
    mkdirSync(apt);
    writeFileSync(join(apt, "Packages"), packages);
    writeFileSync(join(apt, "Packages.gz"), gzipSync(packages, { level: 9 }));
    const release = tool(
      "apt-ftparchive",
      [
        ...APT_SHA256_ONLY,
        "-o",
        "APT::FTPArchive::Release::Origin=Vimma",
        "-o",
        "APT::FTPArchive::Release::Label=Vimma",
        "-o",
        "APT::FTPArchive::Release::Architectures=amd64",
        "-o",
        "APT::FTPArchive::Release::Description=Vimma, a keyboard-first browser",
        "release",
        ".",
      ],
      apt,
    );
    writeFileSync(join(apt, "Release"), release);
    writeFileSync(join(apt, "vimma.sources"), sources);

    // rpm: repodata over packages/<tag>/<file>; gzip, which every dnf and zypper reads, and no
    // sqlite databases, which neither needs.
    const rpmWork = join(work, "rpm");
    for (const r of p.rpm) {
      mkdirSync(join(rpmWork, "packages", r.tag), { recursive: true });
      copyFileSync(join(r.dir, r.rpm), join(rpmWork, "packages", r.tag, r.rpm));
    }
    tool(
      "createrepo_c",
      ["--no-database", "--general-compress-type=gz", "--checksum=sha256", "--quiet", "."],
      rpmWork,
    );
    const repomd = readFileSync(join(rpmWork, "repodata", "repomd.xml"), "utf8");
    const primary = /<data type="primary">[\s\S]*?<location href="([^"]+)"/.exec(repomd)?.[1];
    if (!primary) throw new Error("repos: repomd.xml names no primary.xml");
    checkPrimary(gunzipSync(readFileSync(join(rpmWork, primary))).toString("utf8"), p.rpm);
    const repodata = join(out, "rpm", "repodata");
    mkdirSync(repodata, { recursive: true });
    for (const f of readdirSync(join(rpmWork, "repodata"))) {
      copyFileSync(join(rpmWork, "repodata", f), join(repodata, f));
    }
    // zypper reads the key next to repomd.xml when it first meets the repository.
    writeFileSync(join(repodata, "repomd.xml.key"), cert);
    writeFileSync(join(out, "rpm", "vimma.repo"), repo);

    // pacman: repo-add over the newest package, without --sign and without --include-sigs, so
    // pacman fetches the package's .sig through the redirect (Research). The host gets plain
    // copies, never repo-add's symlinks (decision 12).
    const archWork = join(work, "arch");
    mkdirSync(archWork);
    const pkg = p.pacman.pacman as string;
    copyFileSync(join(p.pacman.dir, pkg), join(archWork, pkg));
    tool("repo-add", ["--quiet", "vimma.db.tar.gz", pkg], archWork);
    const arch = join(out, "arch", "x86_64");
    mkdirSync(arch, { recursive: true });
    // repo-add's entries, written again by this file's own tar writer, so what is signed is a
    // form verify can demand byte for byte: libarchive could otherwise read in repo-add's tar
    // entries that a lenient check does not see.
    const dir = `vimma-bin-${p.pacman.version}-1`;
    const added = untar(gunzipSync(readFileSync(join(archWork, "vimma.db.tar.gz"))));
    const addedFiles = untar(gunzipSync(readFileSync(join(archWork, "vimma.files.tar.gz"))));
    const rawDesc = added.get(`${dir}/desc`);
    const files = addedFiles.get(`${dir}/files`);
    if (!rawDesc || !files) {
      throw new Error(
        `repos: vimma.db does not list exactly vimma-bin ${p.pacman.version}-1 for ${p.pacman.tag}`,
      );
    }
    const desc = canonicalDesc(rawDesc.toString("utf8"), p.pacman);
    writeFileSync(join(arch, "vimma.db"), pacmanDatabase(p.pacman, desc));
    writeFileSync(
      join(arch, "vimma.files"),
      pacmanDatabase(p.pacman, desc, files.toString("utf8")),
    );
    checkPacmanDb(readFileSync(join(arch, "vimma.db")), p.pacman);

    writeFileSync(join(out, "vimma-packages.asc"), cert);
    writeFileSync(join(out, "_redirects"), redirects);
    writeFileSync(join(out, "_headers"), headersFile());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The files a release needs for the repositories to list it (decision 10). */
export function repoFiles(version: string): string[] {
  const pkg = `vimma-bin-${version}-1-x86_64.pkg.tar.zst`;
  return [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `vimma_${version}_amd64.deb`,
    `vimma-${version}-1.x86_64.rpm`,
    pkg,
    `${pkg}.sig`,
  ];
}

/**
 * The tags the repositories keep, newest first, from GitHub's list of releases: published
 * releases (no draft, no pre-release, decision 17) whose files include the pacman package and
 * its signature, which a release has only when it was built with PACKAGE_REPOS_ENABLED, so every
 * `.rpm` listed is signed too. At most `keep` (decision 20). The newest published release must
 * be one of them, so the repositories never stop at an older version while a newer one is out,
 * and `tag`, the release the run publishes, must be among them.
 */
export function selectReleases(list: unknown, keep: number, tag: string): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`repos: --keep must be at least 1`);
  const bad = () => new Error("repos: unexpected response: not a list of releases");
  if (!Array.isArray(list)) throw bad();
  const published: { tag: string; version: string; files: Set<string> }[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) throw bad();
    const r = item as Record<string, unknown>;
    if (
      typeof r.tag_name !== "string" ||
      typeof r.draft !== "boolean" ||
      typeof r.prerelease !== "boolean" ||
      !Array.isArray(r.assets)
    ) {
      throw bad();
    }
    const files = new Set<string>();
    for (const asset of r.assets as unknown[]) {
      const a = asset as Record<string, unknown> | null;
      if (typeof a !== "object" || a === null || typeof a.name !== "string") throw bad();
      // an asset still uploading is not there yet
      if (a.state === "uploaded") files.add(a.name);
    }
    const version = r.tag_name.slice(1);
    if (r.draft || r.prerelease || !r.tag_name.startsWith("v") || !VERSION.test(version)) continue;
    published.push({ tag: r.tag_name, version, files });
  }
  published.sort((a, b) => compareVersions(b.version, a.version));
  const [newest] = published;
  if (!newest) throw new Error("repos: no published release");
  const missing = (r: { version: string; files: Set<string> }) =>
    repoFiles(r.version).filter((f) => !r.files.has(f));
  if (missing(newest).length) {
    throw new Error(
      `repos: the newest release, ${newest.tag}, has no ${missing(newest).join(", ")}: ` +
        "a release built while PACKAGE_REPOS_ENABLED was not true has no pacman package",
    );
  }
  const kept = published
    .filter((r) => !missing(r).length)
    .slice(0, keep)
    .map((r) => r.tag);
  if (!kept.includes(tag)) {
    throw new Error(
      `repos: ${tag} is not among the releases the repositories keep: ${kept.join(", ")}`,
    );
  }
  return kept;
}

/** A SHA256SUMS file (sha256sum's output) as file name -> SHA-256. */
function parseSums(text: string, what: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *]([^/\s]+)$/.exec(line);
    if (!m?.[1] || !m[2] || sums.has(m[2]))
      throw new Error(`repos: ${what}: bad line ${JSON.stringify(line)}`);
    sums.set(m[2], m[1]);
  }
  return sums;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Every regular file under `dir`, relative and sorted; anything else (a symlink) is refused. */
function listTree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(join(dir, rel));
    if (st.isDirectory()) out.push(...listTree(dir, rel));
    else if (st.isFile()) out.push(rel);
    else throw new Error(`repos: ${rel} is not a regular file`);
  }
  return out;
}

/** The signed text of a cleartext-signed message, dash-escaping undone (RFC 4880, 7.1). */
function cleartextBody(text: string): string | undefined {
  const head = "-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n";
  const end = text.indexOf("\n-----BEGIN PGP SIGNATURE-----\n");
  if (!text.startsWith(head) || end < head.length) return undefined;
  return text
    .slice(head.length, end)
    .split("\n")
    .map((l) => (l.startsWith("- ") ? l.slice(2) : l))
    .join("\n");
}

export interface VerifyOptions {
  tree: string;
  cert: string;
  /** Each kept release's tag and its SHA256SUMS file. */
  releases: { tag: string; sums: string }[];
  /** GitHub's list of releases (`GET /repos/{owner}/{repo}/releases`): each file's size. */
  releaseList: unknown;
  baseUrl: string;
  downloadBase: string;
  /**
   * The tree's four signatures are there (after repo-sign), not yet (before). Before, Release's
   * Date must also be within the last hour: a Date ahead of the clock makes apt refuse every
   * later Release as older.
   */
  signed: boolean;
  /** The time Date is checked against, in milliseconds; now by default. */
  now?: number;
  /** After the checks, write vimma.db and vimma.files again with this file's own gzip. */
  regzip?: boolean;
}

/**
 * Refuses a tree unless it is exactly the metadata `build` writes for these releases: the files
 * and no other, no symlink, each package listed under the SHA-256 its release's SHA256SUMS
 * gives it and under no other hash, every index file under the checksum its parent lists, and
 * the setup files, the key, _redirects and _headers as this file writes them. repo-sign runs it
 * on what repo-prepare built before anything is signed, so a fault or a compromise in the job
 * that runs the build tools cannot get other packages, other releases or another key signed;
 * publish runs it again on what it pushes (decisions 6 and 15).
 */
export function verify(opts: VerifyOptions): void {
  const fail = (message: string): never => {
    throw new Error(`repos: ${message}`);
  };
  const releases: Release[] = opts.releases.map(({ tag }) => {
    safeName(tag, "tag");
    const version = tag.slice(1);
    if (!tag.startsWith("v") || !VERSION.test(version)) fail(`tag ${tag} is not vX.Y.Z`);
    return {
      tag,
      version,
      dir: "",
      deb: `vimma_${version}_amd64.deb`,
      rpm: `vimma-${version}-1.x86_64.rpm`,
      pacman: `vimma-bin-${version}-1-x86_64.pkg.tar.zst`,
    };
  });
  const p = plan(releases, Math.max(releases.length, 1));
  const sums = new Map(
    opts.releases.map(({ tag, sums: file }) => [tag, parseSums(readFileSync(file, "utf8"), file)]),
  );
  const listed = (r: Release, file: string) =>
    sums.get(r.tag)?.get(file) ?? fail(`${r.tag}'s SHA256SUMS does not list ${file}`);
  const cert = readFileSync(opts.cert, "utf8");
  if (!cert.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----\n")) {
    fail(`${opts.cert} is not an armoured OpenPGP certificate`);
  }
  const path = (rel: string) => join(opts.tree, rel);

  // rpm's index names its own files, so it comes first: the set of files depends on it.
  // Each file's size as GitHub lists it, which the metadata's sizes must equal.
  const assetSizes = new Map<string, number>();
  if (!Array.isArray(opts.releaseList)) fail("unexpected response: not a list of releases");
  for (const item of opts.releaseList as unknown[]) {
    const r = item as { tag_name?: unknown; assets?: unknown };
    if (typeof r?.tag_name !== "string" || !Array.isArray(r.assets)) {
      fail("unexpected response: not a list of releases");
    }
    for (const a of r.assets as { name?: unknown; size?: unknown }[]) {
      if (typeof a?.name === "string" && typeof a.size === "number") {
        assetSizes.set(`${r.tag_name as string}/${a.name}`, a.size);
      }
    }
  }
  const sized = (r: Release, file: string) =>
    assetSizes.get(`${r.tag}/${file}`) ?? fail(`GitHub lists no size for ${r.tag}/${file}`);

  // rpm's index names its own files, so it comes first: the set of files depends on it.
  const data = readRepomd(readFileSync(path("rpm/repodata/repomd.xml"), "utf8"));

  const signatures = [
    "apt/InRelease",
    "rpm/repodata/repomd.xml.asc",
    "arch/x86_64/vimma.db.sig",
    "arch/x86_64/vimma.files.sig",
  ];
  const want = [
    "apt/Packages",
    "apt/Packages.gz",
    "apt/Release",
    "apt/vimma.sources",
    "rpm/vimma.repo",
    "rpm/repodata/repomd.xml",
    "rpm/repodata/repomd.xml.key",
    ...data.map((d) => `rpm/${d.href}`),
    "arch/x86_64/vimma.db",
    "arch/x86_64/vimma.files",
    "vimma-packages.asc",
    "_redirects",
    "_headers",
    ...(opts.signed ? signatures : []),
  ].sort();
  const have = listTree(opts.tree);
  const extra = have.filter((f) => !want.includes(f));
  const missing = want.filter((f) => !have.includes(f));
  if (extra.length || missing.length) {
    fail(
      `the tree is not the metadata for ${releases.map((r) => r.tag).join(", ")}` +
        (extra.length ? `; not expected: ${extra.join(", ")}` : "") +
        (missing.length ? `; missing: ${missing.join(", ")}` : ""),
    );
  }

  // apt: one stanza per release, read as apt reads it, under its release file's SHA-256 and
  // size and no other hash.
  const packagesBytes = readFileSync(path("apt/Packages"));
  checkPackages(packagesBytes.toString("utf8"), p.apt, listed, sized);
  if (!gunzipOne(readFileSync(path("apt/Packages.gz")), "Packages.gz").equals(packagesBytes)) {
    fail("Packages.gz is not Packages");
  }
  const releaseText = readFileSync(path("apt/Release"), "utf8");
  const [fields] = deb822(
    releaseText,
    "Release",
    ["Architectures", "Date", "Description", "Label", "Origin", "SHA256"],
    ["SHA256"],
    "",
  );
  const release = fields ?? new Map<string, string[]>();
  if ([...release.keys()].join(" ") !== "Architectures Date Description Label Origin SHA256") {
    fail(`Release has ${[...release.keys()].join(", ")}`);
  }
  for (const [key, value] of [
    ["Origin", "Vimma"],
    ["Label", "Vimma"],
    ["Architectures", "amd64"],
  ] as const) {
    if (one(release, key) !== value) fail(`Release's ${key} is not ${value}`);
  }
  if (!opts.signed) {
    // apt-ftparchive's form alone (apt 2.6 and later end it in +0000, older ones in UTC), since
    // Date.parse also reads other forms, asctime's in local time
    const stamp = one(release, "Date") ?? "";
    if (
      !/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} (?:UTC|\+0000)$/.test(
        stamp,
      )
    ) {
      fail(`Release's Date ${JSON.stringify(stamp)} is not in apt-ftparchive's form`);
    }
    const date = Date.parse(stamp.replace(/ UTC$/, " +0000"));
    const age = (opts.now ?? Date.now()) - date;
    if (!(age >= -300_000 && age <= 3_600_000)) fail("Release's Date is not within the last hour");
  }
  const indexed = (release.get("SHA256") ?? []).slice(1).map((l) => {
    const m = /^([0-9a-f]{64}) +([0-9]+) (Packages|Packages\.gz)$/.exec(l);
    if (!m) return fail(`Release: a malformed SHA256 line ${JSON.stringify(l)}`);
    return [m[1], m[2], m[3]] as [string, string, string];
  });
  if (
    release.get("SHA256")?.[0] !== "" ||
    indexed.map((e) => e[2]).join(" ") !== "Packages Packages.gz"
  ) {
    fail("Release does not list Packages and Packages.gz alone");
  }
  for (const [hash, size, name] of indexed) {
    const file = readFileSync(path(`apt/${name}`));
    if (hash !== sha256(file) || size !== String(file.length))
      fail(`Release does not match ${name}`);
  }

  // rpm: each index file under the checksums repomd.xml gives it; each package read as libsolv
  // reads it, under its release file's SHA-256 and size.
  const opened = new Map<string, string>();
  for (const d of data) {
    const file = readFileSync(path(`rpm/${d.href}`));
    if (sha256(file) !== d.checksum)
      fail(`repomd.xml's ${d.type} checksum does not match ${d.href}`);
    if (file.length !== d.size) fail(`repomd.xml's ${d.type} size is not ${d.href}'s`);
    const plain = gunzipOne(file, d.href);
    if (plain.length !== d.openSize) fail(`repomd.xml's ${d.type} open-size is not ${d.href}'s`);
    if (sha256(plain) !== d.open)
      fail(`repomd.xml's ${d.type} open-checksum does not match ${d.href}`);
    opened.set(d.type, plain.toString("utf8"));
  }
  checkPrimary(opened.get("primary") ?? "", p.rpm, listed, sized);
  const rpmSums = p.rpm.map((r) => listed(r, r.rpm));
  checkFilelists(opened.get("filelists") ?? "", "filelists", rpmSums);
  checkFilelists(opened.get("other") ?? "", "other", rpmSums);

  // pacman: both databases exactly the bytes this tool writes for the newest release, under its
  // package's SHA-256 and size.
  const pkg = p.pacman.pacman as string;
  const db = readPacmanDb(
    readFileSync(path("arch/x86_64/vimma.db")),
    p.pacman,
    "vimma.db",
    listed(p.pacman, pkg),
    sized(p.pacman, pkg),
  );
  const filesDb = readPacmanDb(
    readFileSync(path("arch/x86_64/vimma.files")),
    p.pacman,
    "vimma.files",
    listed(p.pacman, pkg),
    sized(p.pacman, pkg),
  );
  if (filesDb.desc !== db.desc) fail("vimma.files's desc is not vimma.db's");

  // The files this tool writes itself, byte for byte: the key in its three places is the
  // committed one (decision 6), and the redirects name only the kept packages.
  const exact: [string, string][] = [
    ["apt/vimma.sources", aptSources(opts.baseUrl, cert)],
    ["rpm/vimma.repo", rpmRepo(opts.baseUrl)],
    ["rpm/repodata/repomd.xml.key", cert],
    ["vimma-packages.asc", cert],
    ["_redirects", redirectsFile(p, opts.downloadBase)],
    ["_headers", headersFile()],
  ];
  for (const [rel, text] of exact) {
    if (!readFileSync(path(rel)).equals(Buffer.from(text, "utf8"))) {
      fail(`${rel} is not the file repos.ts writes for these releases and this key`);
    }
  }

  // After signing: apt's InRelease says exactly what Release says. gpgv checks the signatures.
  if (opts.signed) {
    const body = cleartextBody(readFileSync(path("apt/InRelease"), "utf8"));
    if (body === undefined || `${body}\n` !== releaseText) fail("InRelease's text is not Release");
  }

  // The signing job signs gzip it wrote itself around the tar it just checked, never another
  // job's compression of it.
  if (opts.regzip) {
    writeFileSync(path("arch/x86_64/vimma.db"), pacmanDatabase(p.pacman, db.desc));
    writeFileSync(
      path("arch/x86_64/vimma.files"),
      pacmanDatabase(p.pacman, filesDb.desc, filesDb.files),
    );
  }
}

const USAGE =
  "usage: repos.ts build --out DIR --cert FILE --release TAG=DIR [--release TAG=DIR …] [--keep N]\n" +
  "  [--base-url URL] [--download-base URL]\n" +
  "       repos.ts select --releases FILE --tag TAG [--keep N]\n" +
  "       repos.ts verify --tree DIR --cert FILE --releases FILE --release TAG=SUMS [--release TAG=SUMS …]\n" +
  "  [--signed] [--regzip-pacman] [--base-url URL] [--download-base URL]";

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      cert: { type: "string" },
      release: { type: "string", multiple: true },
      keep: { type: "string" },
      "base-url": { type: "string" },
      "download-base": { type: "string" },
      releases: { type: "string" },
      tag: { type: "string" },
      tree: { type: "string" },
      signed: { type: "boolean" },
      "regzip-pacman": { type: "boolean" },
    },
  });
  if (positionals.length) throw new Error(USAGE);
  const keep = values.keep === undefined ? DEFAULT_KEEP : Number(values.keep);
  const pairs = (what: string) =>
    (values.release ?? []).map((r) => {
      const i = r.indexOf("=");
      if (i < 1) throw new Error(`repos: --release wants TAG=${what}: ${r}`);
      return { tag: r.slice(0, i), path: r.slice(i + 1) };
    });
  if (command === "select" && values.releases && values.tag) {
    const list: unknown = JSON.parse(readFileSync(values.releases, "utf8"));
    process.stdout.write(`${selectReleases(list, keep, values.tag).join("\n")}\n`);
    return;
  }
  if (command === "verify" && values.tree && values.cert && values.release && values.releases) {
    verify({
      tree: values.tree,
      cert: values.cert,
      releases: pairs("SUMS").map((r) => ({ tag: r.tag, sums: r.path })),
      releaseList: JSON.parse(readFileSync(values.releases, "utf8")) as unknown,
      baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
      downloadBase: values["download-base"] ?? DEFAULT_DOWNLOAD_BASE,
      signed: values.signed ?? false,
      regzip: values["regzip-pacman"] ?? false,
    });
    process.stdout.write(
      `repos: ${values.tree} is the metadata for ${pairs("SUMS")
        .map((r) => r.tag)
        .join(", ")}\n`,
    );
    return;
  }
  if (command !== "build" || !values.out || !values.cert || !values.release) {
    throw new Error(USAGE);
  }
  await build({
    releases: pairs("DIR").map((r) => ({ tag: r.tag, dir: r.path })),
    out: values.out,
    cert: values.cert,
    keep,
    baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
    downloadBase: values["download-base"] ?? DEFAULT_DOWNLOAD_BASE,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
