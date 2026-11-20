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
 *
 * Each TAG=DIR is a release's tag and a directory with its files: vimma_X.Y.Z_amd64.deb,
 * vimma-X.Y.Z-1.x86_64.rpm and, for the newest, vimma-bin-X.Y.Z-1-x86_64.pkg.tar.zst with its
 * .sig. apt and rpm keep the newest N (default 5) releases, pacman the newest only. The packages
 * themselves are not written: the host redirects their requests to the GitHub Release
 * (decision 11). The signatures come after, from openpgp-kms.ts: apt/InRelease (cleartext),
 * rpm/repodata/repomd.xml.asc (armour), arch/x86_64/vimma.db.sig and vimma.files.sig (binary).
 *
 * Runs apt-ftparchive (apt-utils), createrepo_c and repo-add (pacman) from PATH. The output
 * depends only on the release files given, never on what the host served before (decision 13).
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
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
import { gzipSync } from "node:zlib";

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
 * The host's _redirects (Cloudflare Workers static assets): a dynamic rule each for apt's and
 * rpm's package paths, which carry the tag, and a static rule for the pacman package and its
 * signature, which pacman asks for next to the database (decision 11).
 */
export function redirectsFile(p: Plan, downloadBase: string): string {
  const base = baseUrl(downloadBase, "download base");
  const r = p.pacman;
  const pkg = safeName(r.pacman as string, "file name");
  const tag = safeName(r.tag, "tag");
  return [
    `/apt/pool/:tag/:file ${base}/:tag/:file 302`,
    `/rpm/packages/:tag/:file ${base}/:tag/:file 302`,
    `/arch/x86_64/${pkg} ${base}/${tag}/${pkg} 302`,
    `/arch/x86_64/${pkg}.sig ${base}/${tag}/${pkg}.sig 302`,
    "",
  ].join("\n");
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
    const packages = tool("apt-ftparchive", ["packages", "pool"], aptWork);
    for (const r of p.apt) {
      if (!packages.includes(`\nFilename: pool/${r.tag}/${r.deb}\n`)) {
        throw new Error(`repos: apt-ftparchive left out ${r.deb}`);
      }
    }
    const apt = join(out, "apt");
    mkdirSync(apt);
    writeFileSync(join(apt, "Packages"), packages);
    writeFileSync(join(apt, "Packages.gz"), gzipSync(packages, { level: 9 }));
    const release = tool(
      "apt-ftparchive",
      [
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
    copyFileSync(join(archWork, "vimma.db.tar.gz"), join(arch, "vimma.db"));
    copyFileSync(join(archWork, "vimma.files.tar.gz"), join(arch, "vimma.files"));

    writeFileSync(join(out, "vimma-packages.asc"), cert);
    writeFileSync(join(out, "_redirects"), redirects);
    writeFileSync(join(out, "_headers"), headersFile());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const USAGE =
  "usage: repos.ts build --out DIR --cert FILE --release TAG=DIR [--release TAG=DIR …] [--keep N]\n" +
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
    },
  });
  if (command !== "build" || positionals.length || !values.out || !values.cert || !values.release) {
    throw new Error(USAGE);
  }
  const releases = values.release.map((r) => {
    const i = r.indexOf("=");
    if (i < 1) throw new Error(`repos: --release wants TAG=DIR: ${r}`);
    return { tag: r.slice(0, i), dir: r.slice(i + 1) };
  });
  await build({
    releases,
    out: values.out,
    cert: values.cert,
    keep: values.keep === undefined ? DEFAULT_KEEP : Number(values.keep),
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
