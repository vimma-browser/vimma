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
 *   repos.ts verify --tree DIR --cert FILE --release TAG=SUMS [--release TAG=SUMS …] [--signed]
 *       [--base-url URL] [--download-base URL]
 *       checks a tree build wrote against the releases' SHA256SUMS files, before it is signed
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
import { gunzipSync, gzipSync } from "node:zlib";

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

/** The stanzas of a Debian control-style file, each as its fields. */
function stanzas(text: string): Map<string, string>[] {
  return text
    .split(/\n\n+/)
    .filter((b) => b.trim())
    .map((b) => {
      const fields = new Map<string, string>();
      for (const line of b.split("\n")) {
        const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
        if (m?.[1] && m[2] !== undefined) fields.set(m[1], m[2]);
      }
      return fields;
    });
}

/**
 * Refuses apt's Packages unless it has exactly one stanza per kept release, each the package
 * `vimma` at the release's version, at the release's path: the signature will vouch for what
 * apt-ftparchive read from the files, so a file that is not the release it claims stops here.
 */
export function checkPackages(text: string, releases: Release[]): void {
  const found = stanzas(text);
  for (const r of releases) {
    const s = found.filter((f) => f.get("Filename") === `pool/${r.tag}/${r.deb}`);
    if (s.length !== 1 || s[0]?.get("Package") !== "vimma" || s[0]?.get("Version") !== r.version) {
      throw new Error(`repos: Packages does not list vimma ${r.version} for ${r.tag}`);
    }
  }
  if (found.length !== releases.length) {
    throw new Error(`repos: Packages has ${found.length} stanzas, want ${releases.length}`);
  }
}

/** Refuses primary.xml unless it lists exactly vimma X.Y.Z-1 for each kept release. */
export function checkPrimary(xml: string, releases: Release[]): void {
  const packages = [...xml.matchAll(/<package type="rpm">([\s\S]*?)<\/package>/g)].map(
    (m) => m[1] ?? "",
  );
  for (const r of releases) {
    const href = `packages/${r.tag}/${r.rpm}`;
    const own = packages.filter((p) => p.includes(`<location href="${href}"/>`));
    const p = own[0] ?? "";
    const version = /<version epoch="0" ver="([^"]*)" rel="([^"]*)"\/>/.exec(p);
    if (
      own.length !== 1 ||
      /<name>([^<]*)<\/name>/.exec(p)?.[1] !== "vimma" ||
      /<arch>([^<]*)<\/arch>/.exec(p)?.[1] !== "x86_64" ||
      version?.[1] !== r.version ||
      version?.[2] !== "1"
    ) {
      throw new Error(`repos: primary.xml does not list vimma ${r.version}-1 for ${r.tag}`);
    }
  }
  if (packages.length !== releases.length) {
    throw new Error(`repos: primary.xml has ${packages.length} packages, want ${releases.length}`);
  }
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
 * Refuses the pacman database unless it holds exactly vimma-bin X.Y.Z-1 of the release, from
 * the release's package file.
 */
export function checkPacmanDb(tarGz: Buffer, r: Release): void {
  const entries = [...untar(gunzipSync(tarGz)).entries()].filter(([n]) => !n.endsWith("/"));
  const dir = `vimma-bin-${r.version}-1`;
  const desc = entries.length === 1 && entries[0]?.[0] === `${dir}/desc` ? entries[0][1] : null;
  const text = desc?.toString("utf8") ?? "";
  const value = (key: string) => new RegExp(`(?:^|\\n)%${key}%\\n([^\\n]*)\\n`).exec(text)?.[1];
  if (
    value("NAME") !== "vimma-bin" ||
    value("VERSION") !== `${r.version}-1` ||
    value("FILENAME") !== r.pacman
  ) {
    throw new Error(`repos: vimma.db does not list exactly vimma-bin ${r.version}-1 for ${r.tag}`);
  }
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
    checkPacmanDb(readFileSync(join(archWork, "vimma.db.tar.gz")), p.pacman);
    copyFileSync(join(archWork, "vimma.db.tar.gz"), join(arch, "vimma.db"));
    copyFileSync(join(archWork, "vimma.files.tar.gz"), join(arch, "vimma.files"));

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

/** The fields of a Release file: `Key: value`, and a hash list's indented lines under its key. */
function releaseFields(text: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const m = /^([A-Za-z0-9-]+):(?: (.*))?$/.exec(line);
    if (m?.[1]) {
      if (fields.has(m[1])) throw new Error(`repos: Release has ${m[1]} twice`);
      current = m[2] === undefined ? [] : [m[2]];
      fields.set(m[1], current);
    } else if (line.startsWith(" ") && current) {
      current.push(line.slice(1));
    } else {
      throw new Error(`repos: Release: bad line ${JSON.stringify(line)}`);
    }
  }
  return fields;
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
  baseUrl: string;
  downloadBase: string;
  /** The tree's four signatures are there (after repo-sign), not yet (before). */
  signed: boolean;
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
  const repomd = readFileSync(path("rpm/repodata/repomd.xml"), "utf8");
  const data = [...repomd.matchAll(/<data type="([a-z_]+)">([\s\S]*?)<\/data>/g)].map((m) => {
    const body = m[2] ?? "";
    const href = /<location href="(repodata\/[A-Za-z0-9._-]+)"\/>/.exec(body)?.[1];
    const checksum = /<checksum type="sha256">([0-9a-f]{64})<\/checksum>/.exec(body)?.[1];
    if (!href || !checksum) fail(`repomd.xml's ${m[1]} has no sha256 checksum or location`);
    return { type: m[1] ?? "", href: href as string, checksum: checksum as string };
  });
  if (
    (repomd.match(/<data /g) ?? []).length !== data.length ||
    data
      .map((d) => d.type)
      .sort()
      .join(" ") !== "filelists other primary"
  ) {
    fail("repomd.xml does not list exactly primary, filelists and other");
  }

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

  // apt: one stanza per release, at its path, under its release's SHA-256 and no other hash.
  const packagesBytes = readFileSync(path("apt/Packages"));
  const packages = packagesBytes.toString("utf8");
  checkPackages(packages, p.apt);
  const found = stanzas(packages);
  for (const hash of ["MD5sum", "SHA1", "SHA512"]) {
    if (found.some((s) => s.has(hash)))
      fail(`Packages has ${hash}; SHA256 is the one hash it may list`);
  }
  if ((packages.match(/^SHA256:/gm) ?? []).length !== p.apt.length) {
    fail("Packages does not have one SHA256 per package");
  }
  for (const r of p.apt) {
    const s = found.find((f) => f.get("Filename") === `pool/${r.tag}/${r.deb}`);
    if (s?.get("SHA256") !== listed(r, r.deb)) {
      fail(
        `Packages: the SHA256 of pool/${r.tag}/${r.deb} is not the one ${r.tag}'s SHA256SUMS lists`,
      );
    }
  }
  if (!gunzipSync(readFileSync(path("apt/Packages.gz"))).equals(packagesBytes)) {
    fail("Packages.gz is not Packages");
  }
  const releaseText = readFileSync(path("apt/Release"), "utf8");
  const fields = releaseFields(releaseText);
  for (const key of fields.keys()) {
    if (!["Origin", "Label", "Architectures", "Description", "Date", "SHA256"].includes(key)) {
      fail(`Release has ${key}`);
    }
  }
  for (const [key, value] of [
    ["Origin", "Vimma"],
    ["Label", "Vimma"],
    ["Architectures", "amd64"],
  ]) {
    if (fields.get(key as string)?.join("\n") !== value) fail(`Release's ${key} is not ${value}`);
  }
  const indexed = (fields.get("SHA256") ?? []).map((l) => l.trim().split(/\s+/));
  const names = indexed.map((e) => e[2]).sort();
  if (names.join(" ") !== "Packages Packages.gz")
    fail("Release does not list Packages and Packages.gz alone");
  for (const [hash, size, name] of indexed) {
    const file = readFileSync(path(`apt/${name}`));
    if (hash !== sha256(file) || size !== String(file.length))
      fail(`Release does not match ${name}`);
  }

  // rpm: each index file under the checksum repomd.xml gives it; each package under its
  // release's SHA-256.
  const opened = new Map<string, string>();
  for (const d of data) {
    const file = readFileSync(path(`rpm/${d.href}`));
    if (sha256(file) !== d.checksum)
      fail(`repomd.xml's ${d.type} checksum does not match ${d.href}`);
    opened.set(d.type, gunzipSync(file).toString("utf8"));
  }
  const primary = opened.get("primary") ?? "";
  checkPrimary(primary, p.rpm);
  const rpmSums = p.rpm.map((r) => listed(r, r.rpm));
  for (const [i, r] of p.rpm.entries()) {
    const block = [...primary.matchAll(/<package type="rpm">([\s\S]*?)<\/package>/g)]
      .map((m) => m[1] ?? "")
      .find((b) => b.includes(`<location href="packages/${r.tag}/${r.rpm}"/>`));
    const pkgid = /<checksum type="sha256" pkgid="YES">([0-9a-f]{64})<\/checksum>/.exec(
      block ?? "",
    )?.[1];
    if (pkgid !== rpmSums[i]) {
      fail(
        `primary.xml: the checksum of packages/${r.tag}/${r.rpm} is not the one ${r.tag}'s SHA256SUMS lists`,
      );
    }
  }
  for (const type of ["filelists", "other"]) {
    const ids = [...(opened.get(type) ?? "").matchAll(/<package pkgid="([^"]*)"/g)].map(
      (m) => m[1],
    );
    if (ids.sort().join(" ") !== [...rpmSums].sort().join(" ")) {
      fail(`${type}.xml does not list exactly the releases' .rpm files`);
    }
  }

  // pacman: the newest release's package under its SHA-256, and vimma.files saying the same.
  const db = readFileSync(path("arch/x86_64/vimma.db"));
  checkPacmanDb(db, p.pacman);
  const pkg = p.pacman.pacman as string;
  const dir = `vimma-bin-${p.pacman.version}-1`;
  const desc = untar(gunzipSync(db)).get(`${dir}/desc`) ?? Buffer.alloc(0);
  const sha = /(?:^|\n)%SHA256SUM%\n([^\n]*)\n/.exec(desc.toString("utf8"))?.[1];
  if (sha !== listed(p.pacman, pkg)) {
    fail(`vimma.db: the SHA256SUM of ${pkg} is not the one ${p.pacman.tag}'s SHA256SUMS lists`);
  }
  if (desc.toString("utf8").includes("%PGPSIG%")) fail("vimma.db carries the package's signature");
  const files = [
    ...untar(gunzipSync(readFileSync(path("arch/x86_64/vimma.files")))).entries(),
  ].filter(([n]) => !n.endsWith("/"));
  if (
    files
      .map(([n]) => n)
      .sort()
      .join(" ") !== `${dir}/desc ${dir}/files` ||
    !files.find(([n]) => n === `${dir}/desc`)?.[1].equals(desc)
  ) {
    fail(`vimma.files does not hold exactly ${dir}'s desc, as vimma.db has it, and its files`);
  }

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
}

const USAGE =
  "usage: repos.ts build --out DIR --cert FILE --release TAG=DIR [--release TAG=DIR …] [--keep N]\n" +
  "  [--base-url URL] [--download-base URL]\n" +
  "       repos.ts select --releases FILE --tag TAG [--keep N]\n" +
  "       repos.ts verify --tree DIR --cert FILE --release TAG=SUMS [--release TAG=SUMS …] [--signed]\n" +
  "  [--base-url URL] [--download-base URL]";

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
  if (command === "verify" && values.tree && values.cert && values.release) {
    verify({
      tree: values.tree,
      cert: values.cert,
      releases: pairs("SUMS").map((r) => ({ tag: r.tag, sums: r.path })),
      baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
      downloadBase: values["download-base"] ?? DEFAULT_DOWNLOAD_BASE,
      signed: values.signed ?? false,
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
