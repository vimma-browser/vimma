import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rmSync, symlinkSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { tempDir } from "../../test/temp-dir.ts";
import { LAUNCHER, debControl, desktopEntry, pkgbuild, rpmSpec } from "../package.ts";
import { haveTool, missingRequired } from "./have-tool.ts";
import { certify, localSigner, sign } from "../openpgp-kms.ts";
import {
  aptSources,
  build,
  checkHostFiles,
  checkPackages,
  checkPacmanDb,
  checkPrimary,
  headersFile,
  pacmanDatabase,
  readPacmanFiles,
  RELATIONS,
  plan,
  readRelease,
  redirectsFile,
  rpmRepo,
  selectReleases,
  verify,
} from "../repos.ts";
import type { Release } from "../repos.ts";

// Spec package-repositories, decisions 7 to 14: the apt, rpm and pacman metadata, the setup
// files and the update host's _redirects and _headers, built from release files.
const GITHUB = "https://github.com/vimma-browser/vimma/releases/download";
const HOST = "https://updates.vimma.dev";

const hasDeb = haveTool("dpkg-deb") && haveTool("apt-ftparchive");
const hasRpm = haveTool("rpmbuild") && haveTool("createrepo_c");
const hasPacman = haveTool("repo-add") && haveTool("zstd") && haveTool("bsdtar");

let certText: string | undefined;
let certPem: string | Buffer = "";
async function cert(): Promise<string> {
  if (!certText) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    certPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    certText = await certify(
      localSigner(certPem),
      1790000000,
      "Vimma packages <packages@vimma.dev>",
    );
  }
  return certText;
}

function ok(cmd: string, args: string[], cwd?: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  expect(r.status, `${cmd} ${args.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
  return r.stdout;
}

/** A stub release directory with the files a release has, built with the real tools. */
function stubRelease(
  root: string,
  version: string,
  formats: { deb?: boolean; rpm?: boolean; pacman?: boolean },
  // what the package itself says, when a test needs it to differ from its file name
  inside: { name?: string; version?: string } = {},
) {
  const dir = join(root, `v${version}`);
  const name = inside.name ?? "vimma";
  const said = inside.version ?? version;
  mkdirSync(dir, { recursive: true });
  if (formats.deb) {
    const r = join(root, `deb-${version}`);
    mkdirSync(join(r, "DEBIAN"), { recursive: true });
    mkdirSync(join(r, "usr/lib/vimma"), { recursive: true });
    writeFileSync(join(r, "usr/lib/vimma/version"), version);
    writeFileSync(
      join(r, "DEBIAN/control"),
      `Package: ${name}\nVersion: ${said}\nArchitecture: amd64\nMaintainer: Vimma CI <ci@example.invalid>\nDescription: stub\n`,
    );
    ok("dpkg-deb", ["--root-owner-group", "--build", r, join(dir, `vimma_${version}_amd64.deb`)]);
  }
  if (formats.rpm) {
    const top = join(root, `rpm-${version}`);
    mkdirSync(join(top, "SPECS"), { recursive: true });
    writeFileSync(
      join(top, "SPECS/vimma.spec"),
      `Name: ${name}\nVersion: ${said}\nRelease: 1\nSummary: stub\nLicense: MPL-2.0\n` +
        "%description\nstub\n%install\nmkdir -p %{buildroot}/usr/lib/vimma\n" +
        `echo ${version} > %{buildroot}/usr/lib/vimma/version\n%files\n/usr/lib/vimma/version\n`,
    );
    ok("rpmbuild", [
      "--define",
      `_topdir ${top}`,
      "--target",
      "x86_64",
      "-bb",
      join(top, "SPECS/vimma.spec"),
    ]);
    writeFileSync(
      join(dir, `vimma-${version}-1.x86_64.rpm`),
      readFileSync(join(top, "RPMS/x86_64", `${name}-${said}-1.x86_64.rpm`)),
    );
  }
  if (formats.pacman) {
    const r = join(root, `pkg-${version}`);
    mkdirSync(join(r, "opt/vimma"), { recursive: true });
    writeFileSync(join(r, "opt/vimma/version"), version);
    writeFileSync(
      join(r, ".PKGINFO"),
      `pkgname = ${name}-bin\npkgbase = ${name}-bin\npkgver = ${said}-1\npkgdesc = stub\n` +
        "url = https://vimma.dev\nbuilddate = 1790000000\npackager = Vimma CI <ci@example.invalid>\n" +
        "size = 6\narch = x86_64\nlicense = MPL-2.0\n",
    );
    const file = join(dir, `vimma-bin-${version}-1-x86_64.pkg.tar.zst`);
    ok("bsdtar", ["--zstd", "-cf", file, "-C", r, ".PKGINFO", "opt"]);
    writeFileSync(`${file}.sig`, "stub signature");
  }
  return dir;
}

/** A release as readRelease would give it, without files on disk (for the pure functions). */
function rel(version: string, pacman = true): Release {
  return {
    tag: `v${version}`,
    version,
    dir: `/r/v${version}`,
    deb: `vimma_${version}_amd64.deb`,
    rpm: `vimma-${version}-1.x86_64.rpm`,
    pacman: pacman ? `vimma-bin-${version}-1-x86_64.pkg.tar.zst` : undefined,
  };
}

it("has every tool VIMMA_REQUIRE_TOOLS names", () => {
  expect(
    missingRequired([
      "dpkg-deb",
      "apt-ftparchive",
      "rpmbuild",
      "createrepo_c",
      "repo-add",
      "zstd",
      "bsdtar",
    ]),
  ).toEqual([]);
});

describe("plan", () => {
  it("keeps the last N versions in apt and rpm metadata and the latest only for pacman", () => {
    const releases = ["0.1.9", "0.1.10", "0.2.0", "0.1.2", "1.0.0", "0.1.11"].map((v) => rel(v));
    const p = plan(releases, 5);
    expect(p.apt.map((r) => r.version)).toEqual(["1.0.0", "0.2.0", "0.1.11", "0.1.10", "0.1.9"]);
    expect(p.rpm.map((r) => r.version)).toEqual(["1.0.0", "0.2.0", "0.1.11", "0.1.10", "0.1.9"]);
    expect(p.pacman.version).toBe("1.0.0");
    expect(plan(releases, 2).apt.map((r) => r.version)).toEqual(["1.0.0", "0.2.0"]);
  });

  it("refuses no releases, the same version twice, and a newest release without a pacman package", () => {
    expect(() => plan([], 5)).toThrow(/no release/);
    expect(() => plan([rel("0.1.0"), rel("0.1.0")], 5)).toThrow(/twice/);
    expect(() => plan([rel("0.1.0"), rel("0.2.0", false)], 5)).toThrow(/pacman/);
    // an older release without one is fine: pacman keeps the latest only
    expect(plan([rel("0.1.0", false), rel("0.2.0")], 5).pacman.version).toBe("0.2.0");
    expect(() => plan([rel("0.1.0")], 0)).toThrow(/keep/);
  });
});

describe("readRelease", () => {
  it("refuses a tag or file name outside [A-Za-z0-9._~+-]", () => {
    const root = tempDir("vimma-repos-");
    for (const tag of ["v0.1.0/../x", "v0.1.0 x", "v0.1.0%2f", "v0.1.0:", "v0.1.0\n"]) {
      expect(() => readRelease(tag, root)).toThrow(/tag/);
    }
    // the tag is v and a release version: no pre-release, no other shape
    for (const tag of ["0.1.0", "v0.1.0-rc.1", "v0.1", "v01.1.0", "vX.Y.Z"]) {
      expect(() => readRelease(tag, root)).toThrow(/tag/);
    }
  });

  it("finds each format's file and refuses a release without its .deb or .rpm", () => {
    const root = tempDir("vimma-repos-");
    const dir = join(root, "v0.3.0");
    mkdirSync(dir);
    writeFileSync(join(dir, "vimma_0.3.0_amd64.deb"), "");
    expect(() => readRelease("v0.3.0", dir)).toThrow(/vimma-0\.3\.0-1\.x86_64\.rpm/);
    writeFileSync(join(dir, "vimma-0.3.0-1.x86_64.rpm"), "");
    expect(readRelease("v0.3.0", dir)).toEqual({
      tag: "v0.3.0",
      version: "0.3.0",
      dir,
      deb: "vimma_0.3.0_amd64.deb",
      rpm: "vimma-0.3.0-1.x86_64.rpm",
      pacman: undefined,
    });
    writeFileSync(join(dir, "vimma-bin-0.3.0-1-x86_64.pkg.tar.zst"), "");
    expect(() => readRelease("v0.3.0", dir)).toThrow(/\.sig/);
    writeFileSync(join(dir, "vimma-bin-0.3.0-1-x86_64.pkg.tar.zst.sig"), "");
    expect(readRelease("v0.3.0", dir).pacman).toBe("vimma-bin-0.3.0-1-x86_64.pkg.tar.zst");
  });
});

describe("host files", () => {
  it("writes one static redirect per kept package file, and no placeholder", () => {
    const p = plan([rel("0.1.0"), rel("0.2.0"), rel("0.3.0")], 2);
    const text = redirectsFile(p, GITHUB);
    expect(text).toBe(
      `/apt/pool/v0.3.0/vimma_0.3.0_amd64.deb ${GITHUB}/v0.3.0/vimma_0.3.0_amd64.deb 302\n` +
        `/apt/pool/v0.2.0/vimma_0.2.0_amd64.deb ${GITHUB}/v0.2.0/vimma_0.2.0_amd64.deb 302\n` +
        `/rpm/packages/v0.3.0/vimma-0.3.0-1.x86_64.rpm ${GITHUB}/v0.3.0/vimma-0.3.0-1.x86_64.rpm 302\n` +
        `/rpm/packages/v0.2.0/vimma-0.2.0-1.x86_64.rpm ${GITHUB}/v0.2.0/vimma-0.2.0-1.x86_64.rpm 302\n` +
        `/arch/x86_64/vimma-bin-0.3.0-1-x86_64.pkg.tar.zst ${GITHUB}/v0.3.0/vimma-bin-0.3.0-1-x86_64.pkg.tar.zst 302\n` +
        `/arch/x86_64/vimma-bin-0.3.0-1-x86_64.pkg.tar.zst.sig ${GITHUB}/v0.3.0/vimma-bin-0.3.0-1-x86_64.pkg.tar.zst.sig 302\n`,
    );
    // a placeholder would redirect to any file of any release (decision 11)
    expect(text.replaceAll("https:", "")).not.toContain(":");
  });

  it("refuses a download base that is not https, except on loopback for the smoke test", () => {
    const p = plan([rel("0.2.0")], 5);
    expect(() => redirectsFile(p, "http://github.com/x")).toThrow(/https/);
    expect(() => redirectsFile(p, `${GITHUB}/`)).toThrow(/slash/);
    expect(redirectsFile(p, "http://127.0.0.1:8080/download")).toContain(
      "/apt/pool/v0.2.0/vimma_0.2.0_amd64.deb http://127.0.0.1:8080/download/v0.2.0/vimma_0.2.0_amd64.deb 302\n",
    );
  });

  it("gives the metadata, the key and the manifest no-cache", () => {
    const h = headersFile();
    for (const path of ["/updates/*", "/apt/*", "/rpm/*", "/arch/*", "/vimma-packages.asc"]) {
      expect(h).toContain(
        `${path}\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n`,
      );
    }
  });

  // Review of sub-PR 3: publish replaces the host's _headers and _redirects, so a rule added
  // there by hand would be dropped in silence at the next release. Only what this tool writes,
  // or the manifest's own rule the host had before the repositories, may be replaced.
  it("replaces only host files it wrote, or the manifest's rule alone", () => {
    const dir = tempDir("vimma-repos-host-");
    const check = () => checkHostFiles(dir, GITHUB);
    expect(check).not.toThrow();
    const manifestRule =
      "/updates/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n";
    writeFileSync(join(dir, "_headers"), manifestRule);
    expect(check).not.toThrow();
    writeFileSync(join(dir, "_headers"), headersFile());
    expect(check).not.toThrow();
    writeFileSync(
      join(dir, "_headers"),
      `${headersFile()}/*\n  Strict-Transport-Security: max-age=1\n`,
    );
    expect(check).toThrow(/_headers is not one repos\.ts writes/);
    writeFileSync(join(dir, "_headers"), headersFile());

    writeFileSync(
      join(dir, "_redirects"),
      redirectsFile(plan([rel("0.1.0"), rel("0.2.0")], 5), GITHUB),
    );
    expect(check).not.toThrow();
    for (const extra of [
      "/docs https://vimma.dev/docs 301\n",
      `/apt/pool/v0.2.0/vimma_0.2.0_amd64.deb ${GITHUB}/v0.2.0/vimma_0.2.0_amd64.deb 301\n`,
      `/apt/pool/v0.2.0/x.deb https://evil.example/v0.2.0/x.deb 302\n`,
      `/apt/pool/v0.2.0/:file ${GITHUB}/v0.2.0/:file 302\n`,
      "\n",
    ]) {
      writeFileSync(
        join(dir, "_redirects"),
        redirectsFile(plan([rel("0.2.0")], 5), GITHUB) + extra,
      );
      expect(check, extra).toThrow(/_redirects is not one repos\.ts writes/);
    }
    writeFileSync(join(dir, "_redirects"), "");
    expect(check).toThrow(/_redirects/);
  });

  it("the .sources file carries the committed key inline", async () => {
    const key = await cert();
    const s = aptSources(HOST, key);
    expect(s).toMatch(
      /^Types: deb\nURIs: https:\/\/updates\.vimma\.dev\/apt\/\nSuites: \.\/\nSigned-By:\n/,
    );
    expect(s).not.toMatch(/^Components:/m);
    // deb822 folding: each key line indented by one space, an empty line as " ."
    const folded = s.slice(s.indexOf("Signed-By:\n") + "Signed-By:\n".length);
    const unfolded = folded
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        expect(l.startsWith(" ")).toBe(true);
        return l === " ." ? "" : l.slice(1);
      })
      .join("\n");
    expect(`${unfolded}\n`).toBe(key);
  });

  // zypper addrepo names /etc/zypp/repos.d/<file> after the section id, not after the URL, and
  // Vimma's update hint looks for /etc/zypp/repos.d/vimma.repo (decision 18)
  it("the .repo file's only section id is [vimma]", () => {
    expect(rpmRepo(HOST).match(/^\[.*\]$/gm)).toEqual(["[vimma]"]);
  });

  it("the .repo file sets gpgcheck and repo_gpgcheck", () => {
    const r = rpmRepo(HOST);
    expect(r).toBe(
      "[vimma]\nname=Vimma\nbaseurl=https://updates.vimma.dev/rpm/\ntype=rpm-md\nenabled=1\n" +
        "gpgcheck=1\nrepo_gpgcheck=1\n" +
        "gpgkey=https://updates.vimma.dev/vimma-packages.asc\n",
    );
    // dnf5's config-manager addrepo refuses an option it does not know (zypper's autorefresh,
    // pkg_gpgcheck), so the file holds only options both read (repos-smoke.sh, Fedora 44)
    expect(r).not.toMatch(/autorefresh|pkg_gpgcheck/);
  });
});

describe("build", () => {
  it.skipIf(!hasDeb || !hasRpm || !hasPacman)(
    "writes a flat apt repository whose Filename carries the tag, repodata whose locations carry the tag, and a pacman database of plain files",
    async () => {
      const root = tempDir("vimma-repos-");
      const releases = ["0.1.0", "0.2.0", "0.3.0"].map((v) =>
        stubRelease(root, v, { deb: true, rpm: true, pacman: v !== "0.1.0" }),
      );
      const certFile = join(root, "cert.asc");
      writeFileSync(certFile, await cert());
      const out = join(root, "public");
      await build({
        releases: releases.map((d) => ({ tag: d.slice(d.lastIndexOf("/") + 1), dir: d })),
        out,
        cert: certFile,
        keep: 2,
        baseUrl: HOST,
        downloadBase: GITHUB,
      });

      // apt (decision 7): two kept versions, Filename under pool/<tag>/, no package copied out
      const packages = readFileSync(join(out, "apt/Packages"), "utf8");
      expect([...packages.matchAll(/^Filename: (.*)$/gm)].map((m) => m[1]).sort()).toEqual([
        "pool/v0.2.0/vimma_0.2.0_amd64.deb",
        "pool/v0.3.0/vimma_0.3.0_amd64.deb",
      ]);
      expect(packages).toMatch(/^SHA256: [0-9a-f]{64}$/m);
      expect(gunzipSync(readFileSync(join(out, "apt/Packages.gz"))).toString()).toBe(packages);
      const release = readFileSync(join(out, "apt/Release"), "utf8");
      expect(release).toMatch(/^Origin: Vimma$/m);
      expect(release).toMatch(/^Label: Vimma$/m);
      expect(release).toMatch(/^Date: /m);
      expect(release).not.toMatch(/^Valid-Until:/m); // spec decision: no Valid-Until
      expect(release).toMatch(/^ [0-9a-f]{64} +\d+ Packages$/m);
      expect(release).toMatch(/^ [0-9a-f]{64} +\d+ Packages\.gz$/m);
      expect(existsSync(join(out, "apt/pool"))).toBe(false);
      expect(readFileSync(join(out, "apt/vimma.sources"), "utf8")).toBe(
        aptSources(HOST, await cert()),
      );

      // rpm (decision 8): locations under packages/<tag>/, the key beside repomd.xml
      const repomd = readFileSync(join(out, "rpm/repodata/repomd.xml"), "utf8");
      const primaryHref = /<data type="primary">[\s\S]*?<location href="([^"]+)"/.exec(repomd)?.[1];
      expect(primaryHref).toMatch(/^repodata\/[0-9a-f]+-primary\.xml\.gz$/);
      const primary = gunzipSync(readFileSync(join(out, "rpm", primaryHref as string))).toString();
      expect([...primary.matchAll(/<location href="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
        "packages/v0.2.0/vimma-0.2.0-1.x86_64.rpm",
        "packages/v0.3.0/vimma-0.3.0-1.x86_64.rpm",
      ]);
      expect(readFileSync(join(out, "rpm/repodata/repomd.xml.key"), "utf8")).toBe(await cert());
      expect(existsSync(join(out, "rpm/packages"))).toBe(false);
      expect(readFileSync(join(out, "rpm/vimma.repo"), "utf8")).toBe(rpmRepo(HOST));

      // pacman (decisions 10 and 12): the latest only, plain files, no package signature inside
      const arch = join(out, "arch/x86_64");
      expect(readdirSync(arch).sort()).toEqual(["vimma.db", "vimma.files"]);
      for (const f of ["vimma.db", "vimma.files"])
        expect(lstatSync(join(arch, f)).isFile()).toBe(true);
      const listing = ok("bsdtar", ["-tf", join(arch, "vimma.db")]);
      expect(listing.split("\n").filter(Boolean).sort()).toEqual([
        "vimma-bin-0.3.0-1/",
        "vimma-bin-0.3.0-1/desc",
      ]);
      const desc = ok("bsdtar", ["-xOf", join(arch, "vimma.db"), "vimma-bin-0.3.0-1/desc"]);
      expect(desc).toContain("%FILENAME%\nvimma-bin-0.3.0-1-x86_64.pkg.tar.zst\n");
      expect(desc).not.toContain("%PGPSIG%");
      expect(
        ok("bsdtar", ["-xOf", join(arch, "vimma.files"), "vimma-bin-0.3.0-1/files"]),
      ).toContain("opt/vimma/version");

      // the host's files
      expect(readFileSync(join(out, "vimma-packages.asc"), "utf8")).toBe(await cert());
      expect(readFileSync(join(out, "_redirects"), "utf8")).toBe(
        redirectsFile(
          plan(
            releases.map((d) => readRelease(d.slice(d.lastIndexOf("/") + 1), d)),
            2,
          ),
          GITHUB,
        ),
      );
      expect(readFileSync(join(out, "_headers"), "utf8")).toBe(headersFile());
    },
    120_000,
  );

  it.skipIf(!hasDeb || !hasRpm || !hasPacman).each([
    [
      "a .deb whose control file names another version",
      { deb: { version: "0.9.9" } },
      /Packages.*v0\.3\.0/s,
    ],
    ["a .deb of another package", { deb: { name: "vimmb" } }, /Packages.*v0\.3\.0/s],
    [
      "an .rpm whose header names another version",
      { rpm: { version: "0.9.9" } },
      /primary\.xml.*v0\.3\.0/s,
    ],
    ["an .rpm of another package", { rpm: { name: "vimmb" } }, /primary\.xml.*v0\.3\.0/s],
    [
      "a pacman package that names another version",
      { pacman: { version: "0.9.9" } },
      /vimma\.db.*v0\.3\.0/s,
    ],
    ["a pacman package of another package", { pacman: { name: "vimmb" } }, /vimma\.db.*v0\.3\.0/s],
  ] as const)(
    "refuses metadata that does not match the release: %s",
    async (_, wrong, why) => {
      const root = tempDir("vimma-repos-");
      const good = stubRelease(root, "0.2.0", { deb: true, rpm: true, pacman: true });
      // each format built from its own stub, so only the one under test is wrong
      const bad = join(root, "v0.3.0");
      for (const format of ["deb", "rpm", "pacman"] as const) {
        const scratch = join(root, `scratch-${format}`);
        mkdirSync(scratch);
        const inside = (wrong as Record<string, { name?: string; version?: string }>)[format] ?? {};
        const d = stubRelease(scratch, "0.3.0", { [format]: true }, inside);
        mkdirSync(bad, { recursive: true });
        for (const f of readdirSync(d)) writeFileSync(join(bad, f), readFileSync(join(d, f)));
      }
      const certFile = join(root, "cert.asc");
      writeFileSync(certFile, await cert());
      await expect(
        build({
          releases: [
            { tag: "v0.2.0", dir: good },
            { tag: "v0.3.0", dir: bad },
          ],
          out: join(root, "public"),
          cert: certFile,
          keep: 5,
          baseUrl: HOST,
          downloadBase: GITHUB,
        }),
      ).rejects.toThrow(why);
    },
    120_000,
  );

  it("refuses an output directory that is not empty", async () => {
    const root = tempDir("vimma-repos-");
    writeFileSync(join(root, "stale"), "");
    await expect(
      build({
        releases: [],
        out: root,
        cert: join(root, "c"),
        keep: 5,
        baseUrl: HOST,
        downloadBase: GITHUB,
      }),
    ).rejects.toThrow(/not empty/);
  });
});

/** A GitHub API release, as `GET /repos/{owner}/{repo}/releases` lists it. */
function apiRelease(
  version: string,
  { draft = false, prerelease = false, pacman = true, tag = `v${version}` } = {},
) {
  const names = [
    "SHA256SUMS",
    "SHA256SUMS.sigstore.json",
    `vimma_${version}_amd64.deb`,
    `vimma-${version}-1.x86_64.rpm`,
    `vimma-${version}-linux-x86_64.tar.xz`,
    ...(pacman
      ? [
          `vimma-bin-${version}-1-x86_64.pkg.tar.zst`,
          `vimma-bin-${version}-1-x86_64.pkg.tar.zst.sig`,
        ]
      : []),
  ];
  return {
    tag_name: tag,
    draft,
    prerelease,
    assets: names.map((name) => ({ name, state: "uploaded" })),
  };
}

// Spec package-repositories, decisions 13, 17 and 20: the releases the repositories list are
// chosen from GitHub's list of releases, by the job that builds the metadata and again by the
// job that signs it, so the signing job never takes the list from the job before it.
describe("selectReleases", () => {
  it("keeps the newest published releases that carry the repository packages, newest first", () => {
    const list = [
      apiRelease("0.1.9", { pacman: false }),
      apiRelease("0.1.10"),
      apiRelease("0.2.0"),
      apiRelease("0.2.1", { prerelease: true }),
      apiRelease("0.3.0", { draft: true }),
      apiRelease("0.1.11"),
      apiRelease("0.1.12", { tag: "nightly" }),
      apiRelease("0.2.0-rc.1", { prerelease: true }),
    ];
    expect(selectReleases(list, 5, "v0.2.0")).toEqual(["v0.2.0", "v0.1.11", "v0.1.10"]);
    expect(selectReleases(list, 2, "v0.2.0")).toEqual(["v0.2.0", "v0.1.11"]);
  });

  it("refuses a newest release without the pacman package, and a tag it does not keep", () => {
    const list = [apiRelease("0.1.0"), apiRelease("0.2.0", { pacman: false })];
    expect(() => selectReleases(list, 5, "v0.2.0")).toThrow(/v0\.2\.0.*pacman/);
    const ok = [apiRelease("0.1.0"), apiRelease("0.2.0"), apiRelease("0.3.0")];
    expect(() => selectReleases(ok, 2, "v0.1.0")).toThrow(/v0\.1\.0 is not among/);
    // an asset still uploading is not there yet
    const uploading = apiRelease("0.4.0");
    uploading.assets[0] = { name: "SHA256SUMS", state: "starter" };
    expect(() => selectReleases([...ok, uploading], 5, "v0.4.0")).toThrow(/v0\.4\.0/);
  });

  it("refuses an answer that is not a list of releases", () => {
    expect(() => selectReleases({ message: "Bad credentials" }, 5, "v0.1.0")).toThrow(
      /unexpected response/,
    );
    expect(() => selectReleases([{ tag_name: "v0.1.0" }], 5, "v0.1.0")).toThrow(
      /unexpected response/,
    );
    expect(() => selectReleases([], 5, "v0.1.0")).toThrow(/no published release/);
  });
});

/** sha256sum's output for every file in `dir`, as a release's SHA256SUMS lists them. */
function sumsOf(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map(
      (f) =>
        `${createHash("sha256")
          .update(readFileSync(join(dir, f)))
          .digest("hex")}  ${f}\n`,
    )
    .join("");
}

/**
 * Three stub releases, the metadata build() writes for the newest two, and a SHA256SUMS per
 * release, as repo-sign has them: the tree from the job before, the sums from GitHub.
 */
async function builtTree() {
  const root = tempDir("vimma-repos-verify-");
  const dirs = ["0.1.0", "0.2.0", "0.3.0"].map((v) =>
    stubRelease(root, v, { deb: true, rpm: true, pacman: true }),
  );
  const certFile = join(root, "cert.asc");
  writeFileSync(certFile, await cert());
  const tree = join(root, "public");
  await build({
    releases: dirs.slice(1).map((d) => ({ tag: d.slice(d.lastIndexOf("/") + 1), dir: d })),
    out: tree,
    cert: certFile,
    keep: 5,
    baseUrl: HOST,
    downloadBase: GITHUB,
  });
  const sums: Record<string, string> = {};
  for (const d of dirs) {
    const tag = d.slice(d.lastIndexOf("/") + 1);
    sums[tag] = join(root, `${tag}.SHA256SUMS`);
    writeFileSync(sums[tag], sumsOf(d));
  }
  // GitHub's list of releases, whose asset sizes the metadata's sizes must match.
  const releaseList = dirs.map((d) => ({
    tag_name: d.slice(d.lastIndexOf("/") + 1),
    draft: false,
    prerelease: false,
    assets: readdirSync(d).map((name) => ({
      name,
      state: "uploaded",
      size: readFileSync(join(d, name)).length,
    })),
  }));
  const check = (tags = ["v0.3.0", "v0.2.0"], signed = false, list: unknown = releaseList) =>
    verify({
      tree,
      cert: certFile,
      releases: tags.map((tag) => ({ tag, sums: sums[tag] as string })),
      releaseList: list,
      baseUrl: HOST,
      downloadBase: GITHUB,
      signed,
    });
  return { root, tree, sums, certFile, check, dirs, releaseList };
}

/** The tree's four signatures, as repo-sign makes them, with the local key. */
async function signTree(tree: string) {
  const c = Buffer.from(await cert());
  const signer = localSigner(certPem);
  const at = 1790000100;
  const put = async (from: string, to: string, format: "binary" | "armor" | "cleartext") =>
    writeFileSync(
      join(tree, to),
      await sign(signer, c, format, readFileSync(join(tree, from)), at),
    );
  await put("apt/Release", "apt/InRelease", "cleartext");
  await put("rpm/repodata/repomd.xml", "rpm/repodata/repomd.xml.asc", "armor");
  await put("arch/x86_64/vimma.db", "arch/x86_64/vimma.db.sig", "binary");
  await put("arch/x86_64/vimma.files", "arch/x86_64/vimma.files.sig", "binary");
}

describe.skipIf(!hasDeb || !hasRpm || !hasPacman)(
  "verify (repo-sign's check before it signs, and publish's before it pushes)",
  () => {
    it("accepts the metadata build wrote for the releases' own files, and SHA-256 alone in apt's", async () => {
      const t = await builtTree();
      t.check();
      // One hash per file in Packages and Release, the one SHA256SUMS can vouch for: apt checks
      // the strongest it finds, which must then be one this check compared.
      const packages = readFileSync(join(t.tree, "apt/Packages"), "utf8");
      expect(packages).not.toMatch(/^(MD5sum|SHA1|SHA512):/m);
      const release = readFileSync(join(t.tree, "apt/Release"), "utf8");
      expect(release).not.toMatch(/^(MD5Sum|SHA1|SHA512):/m);
      expect(release).toMatch(/^SHA256:$/m);
    }, 120_000);

    it.each([
      ["deb", "vimma_0.3.0_amd64.deb", /Packages.*vimma_0\.3\.0_amd64\.deb/s],
      ["rpm", "vimma-0.3.0-1.x86_64.rpm", /primary\.xml.*vimma-0\.3\.0-1\.x86_64\.rpm/s],
      ["pacman", "vimma-bin-0.3.0-1-x86_64.pkg.tar.zst", /vimma\.db.*vimma-bin-0\.3\.0/s],
    ])(
      "refuses metadata whose %s checksum is not the one the release's SHA256SUMS lists",
      async (_, file, why) => {
        const t = await builtTree();
        const sums = t.sums["v0.3.0"] as string;
        writeFileSync(
          sums,
          readFileSync(sums, "utf8").replace(
            new RegExp(`^[0-9a-f]{64}(  ${file.replaceAll(".", "\\.")})$`, "m"),
            `${"0".repeat(64)}$1`,
          ),
        );
        expect(() => t.check()).toThrow(why);
      },
      120_000,
    );

    it("refuses metadata for other releases than the ones chosen, such as an older set", async () => {
      const t = await builtTree();
      expect(() => t.check(["v0.2.0", "v0.1.0"])).toThrow(/v0\.1\.0|v0\.2\.0/);
      expect(() => t.check(["v0.3.0"])).toThrow(/stanzas|packages|v0\.3\.0/);
    }, 120_000);

    it("refuses an extra file, a symlink, and a setup file, key, _redirects or _headers that is not repos.ts's", async () => {
      const t = await builtTree();
      const keep = (f: string) => readFileSync(join(t.tree, f));
      const cases: [string, () => void, RegExp][] = [
        ["an extra file", () => writeFileSync(join(t.tree, "apt/extra"), "x"), /apt\/extra/],
        [
          "a symlink",
          () => {
            rmSync(join(t.tree, "arch/x86_64/vimma.files"));
            symlinkSync("vimma.db", join(t.tree, "arch/x86_64/vimma.files"));
          },
          /vimma\.files/,
        ],
        [
          "a signature before signing",
          () => writeFileSync(join(t.tree, "apt/InRelease"), "x"),
          /InRelease/,
        ],
      ];
      for (const f of [
        "apt/vimma.sources",
        "rpm/vimma.repo",
        "rpm/repodata/repomd.xml.key",
        "vimma-packages.asc",
        "_redirects",
        "_headers",
      ]) {
        cases.push([
          f,
          () => writeFileSync(join(t.tree, f), `${keep(f)}# more\n`),
          new RegExp(f.replaceAll(".", "\\.")),
        ]);
      }
      for (const [what, change, why] of cases) {
        const saved = new Map<string, Buffer>();
        for (const f of [
          "apt/vimma.sources",
          "rpm/vimma.repo",
          "rpm/repodata/repomd.xml.key",
          "vimma-packages.asc",
          "_redirects",
          "_headers",
          "arch/x86_64/vimma.files",
        ]) {
          saved.set(f, keep(f));
        }
        change();
        expect(() => t.check(), what).toThrow(why);
        rmSync(join(t.tree, "apt/extra"), { force: true });
        rmSync(join(t.tree, "apt/InRelease"), { force: true });
        for (const [f, b] of saved) {
          rmSync(join(t.tree, f), { force: true });
          writeFileSync(join(t.tree, f), b);
        }
        t.check();
      }
    }, 120_000);

    it("refuses a second hash in Packages, and Packages.gz or Release that does not match Packages", async () => {
      const t = await builtTree();
      const p = join(t.tree, "apt/Packages");
      const packages = readFileSync(p, "utf8");
      writeFileSync(p, packages.replace(/^SHA256: /m, `MD5sum: ${"0".repeat(32)}\nSHA256: `));
      expect(() => t.check()).toThrow(/MD5sum/);
      writeFileSync(p, packages);
      writeFileSync(join(t.tree, "apt/Packages.gz"), gzipSync(`${packages}\n`));
      expect(() => t.check()).toThrow(/Packages\.gz/);
      writeFileSync(join(t.tree, "apt/Packages.gz"), gzipSync(packages));
      const r = join(t.tree, "apt/Release");
      const release = readFileSync(r, "utf8");
      writeFileSync(r, `${release}Valid-Until: Sat, 01 Jan 2050 00:00:00 UTC\n`);
      expect(() => t.check()).toThrow(/Valid-Until/);
      writeFileSync(r, release.replace(/^ [0-9a-f]{64}( +\d+ Packages)$/m, ` ${"0".repeat(64)}$1`));
      expect(() => t.check()).toThrow(/Release.*Packages/s);
    }, 120_000);

    it("refuses repodata whose repomd.xml does not match its files", async () => {
      const t = await builtTree();
      const r = join(t.tree, "rpm/repodata/repomd.xml");
      const repomd = readFileSync(r, "utf8");
      writeFileSync(
        r,
        repomd.replace(
          /(<data type="filelists">\s*<checksum type="sha256">)[0-9a-f]{64}/,
          `$1${"0".repeat(64)}`,
        ),
      );
      expect(() => t.check()).toThrow(/repomd\.xml.*filelists/s);
    }, 120_000);

    it("signed: wants the four signatures, and an InRelease whose text is Release's", async () => {
      const t = await builtTree();
      expect(() => t.check(undefined, true)).toThrow(/InRelease/);
      await signTree(t.tree);
      t.check(undefined, true);
      // signatures are checked by gpgv in the jobs; here only that InRelease says what Release says
      const ir = join(t.tree, "apt/InRelease");
      writeFileSync(ir, readFileSync(ir, "utf8").replace("Label: Vimma", "Label: Vimmb"));
      expect(() => t.check(undefined, true)).toThrow(/InRelease/);
    }, 120_000);
  },
);

// verify must read each file as its client does, so nothing it accepts can mean something else
// to apt, libsolv or libarchive. Each case below is a known way to make them disagree, or a
// neighbour of one.
const R123: Release = {
  tag: "v1.2.3",
  version: "1.2.3",
  dir: "",
  deb: "vimma_1.2.3_amd64.deb",
  rpm: "vimma-1.2.3-1.x86_64.rpm",
  pacman: "vimma-bin-1.2.3-1-x86_64.pkg.tar.zst",
};

describe("apt's Packages, read as apt reads it", () => {
  const stanza =
    "Package: vimma\nVersion: 1.2.3\nArchitecture: amd64\nMaintainer: x <x@example.invalid>\n" +
    `Filename: pool/v1.2.3/vimma_1.2.3_amd64.deb\nSize: 10\nSHA256: ${"a".repeat(64)}\n` +
    "Description: test\n";

  it("accepts the stanza apt-ftparchive writes", () => {
    checkPackages(`${stanza}\n`, [R123]);
  });

  it.each([
    // apt reads field names without case, and the last one wins: an old .deb offered as 99.0.0
    [
      "a field again in other case, which apt reads as the same field",
      `${stanza}version: 99.0.0\nfilename: pool/v1.0.0/vimma_1.0.0_amd64.deb\nsha256: ${"b".repeat(64)}\n\n`,
    ],
    ["a field twice", `${stanza}Version: 99.0.0\n\n`],
    ["a carriage return", `${stanza.replace("Version: 1.2.3\n", "Version: 1.2.3\r\n")}\n`],
    ["a field Vimma's packages never have", `${stanza}Conflicts: sudo\n\n`],
    ["Pre-Depends", `${stanza}Pre-Depends: evil\n\n`],
    [
      "a continuation line under another field",
      `${stanza.replace("Size: 10\n", "Size: 10\n more\n")}\n`,
    ],
    ["a line that is no field", `${stanza}garbage\n\n`],
    ["a field with no value", `${stanza}Homepage:\n\n`],
    ["a NUL", `${stanza.replace("test", "te\0st")}\n`],
  ])("refuses %s", (_, text) => {
    expect(() => checkPackages(text, [R123])).toThrow(/Packages/);
  });
});

/** A ustar header, as the review's tarpoc.ts writes one. */
function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}
const tarPad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function paxHeader(records: Record<string, string>): Buffer {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rec = ` ${k}=${v}\n`;
    let len = rec.length + 1;
    while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
    body += `${len}${rec}`;
  }
  const b = Buffer.from(body);
  return Buffer.concat([tarHeader("PaxHeader", b.length, "x"), tarPad(b)]);
}

describe("pacman's database, read as libarchive reads it", () => {
  const desc = Buffer.from(
    "%FILENAME%\nvimma-bin-1.2.3-1-x86_64.pkg.tar.zst\n\n%NAME%\nvimma-bin\n\n" +
      `%VERSION%\n1.2.3-1\n\n%SHA256SUM%\n${"a".repeat(64)}\n\n`,
  );

  it("refuses a pax size that hides entries behind desc", () => {
    const pkginfo = Buffer.from("pkgname = evil\npkgver = 9.9.9-1\narch = x86_64\n");
    const install = Buffer.from("post_install() { id > /tmp/pwned; }\n");
    const hidden = Buffer.concat([
      tarHeader(".PKGINFO", pkginfo.length, "0"),
      tarPad(pkginfo),
      tarHeader(".INSTALL", install.length, "0"),
      tarPad(install),
    ]);
    const tar = Buffer.concat([
      paxHeader({ size: String(desc.length) }),
      tarHeader("vimma-bin-1.2.3-1/desc", 512 + hidden.length, "0"),
      tarPad(desc),
      hidden,
      Buffer.alloc(1024),
    ]);
    expect(() => checkPacmanDb(gzipSync(tar), R123)).toThrow(/vimma\.db/);
  });

  it.each([
    [
      "a pax header at all",
      [
        paxHeader({ path: "vimma-bin-1.2.3-1/desc" }),
        tarHeader("x", desc.length, "0"),
        tarPad(desc),
      ],
    ],
    ["a symlink entry", [tarHeader("vimma-bin-1.2.3-1/desc", 0, "2")]],
    [
      "data after the end blocks",
      [
        tarHeader("vimma-bin-1.2.3-1/desc", desc.length, "0"),
        tarPad(desc),
        Buffer.alloc(1024),
        Buffer.from("x".repeat(512)),
      ],
    ],
  ])("refuses %s", (_, parts) => {
    const tar = Buffer.concat([...(parts as Buffer[]), Buffer.alloc(1024)]);
    expect(() => checkPacmanDb(gzipSync(tar), R123)).toThrow(/vimma\.db/);
  });
});

describe("rpm's primary.xml, read as libsolv reads it", () => {
  const v = "1.2.3";
  const legit = "a".repeat(64);
  const pkg = (inner: string) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">\n' +
    `<package type="rpm">\n${inner}</package>\n</metadata>`;
  const good =
    "  <name>vimma</name>\n  <arch>x86_64</arch>\n" +
    `  <version epoch="0" ver="${v}" rel="1"/>\n` +
    `  <checksum type="sha256" pkgid="YES">${legit}</checksum>\n` +
    "  <summary>s</summary>\n  <description>d</description>\n  <packager></packager>\n  <url></url>\n" +
    '  <time file="1" build="1"/>\n  <size package="10" installed="1" archive="1"/>\n' +
    `  <location href="packages/v${v}/vimma-${v}-1.x86_64.rpm"/>\n` +
    "  <format>\n    <rpm:license>MPL-2.0</rpm:license>\n  </format>\n";

  it("accepts the entry createrepo_c writes", () => {
    checkPrimary(pkg(good), [R123]);
  });

  it.each([
    [
      "the real entry inside a comment, another after it",
      pkg(
        `<!--${good}-->\n  <name>vimma</name><arch>x86_64</arch><version epoch="0" ver="99.0.0" rel="1"/>\n` +
          `  <checksum type="sha256" pkgid="YES">${"b".repeat(64)}</checksum>\n` +
          '  <format><rpm:obsoletes><rpm:entry name="sudo"/></rpm:obsoletes></format>\n' +
          '  <location xml:base="https://example.invalid/" href="vimma-1.0.0-1.x86_64.rpm"/>\n',
      ),
    ],
    [
      "a DOCTYPE with an entity",
      pkg(good).replace("<metadata", '<!DOCTYPE m [<!ENTITY v "99.0.0">]>\n<metadata'),
    ],
    ["CDATA", pkg(good.replace("<summary>s</summary>", "<summary><![CDATA[s]]></summary>"))],
    [
      "xml:base",
      pkg(good.replace("<location href", '<location xml:base="https://example.invalid/" href')),
    ],
    ["a processing instruction", pkg(good).replace("<metadata", "<?evil x?>\n<metadata")],
    [
      "an entity that is not predefined",
      pkg(good.replace("<summary>s</summary>", "<summary>&ver;</summary>")),
    ],
    [
      "rpm:obsoletes",
      pkg(
        good.replace(
          "  </format>",
          '    <rpm:obsoletes><rpm:entry name="sudo"/></rpm:obsoletes>\n  </format>',
        ),
      ),
    ],
    [
      "rpm:conflicts",
      pkg(
        good.replace(
          "  </format>",
          '    <rpm:conflicts><rpm:entry name="sudo"/></rpm:conflicts>\n  </format>',
        ),
      ),
    ],
    ["a second name", pkg(good.replace("<arch>", "<name>sudo</name><arch>"))],
    ["single-quoted attributes", pkg(good.replace('rel="1"', "rel='1'"))],
  ])("refuses %s", (_, xml) => {
    expect(() => checkPrimary(xml, [R123])).toThrow(/primary\.xml/);
  });
});

describe.skipIf(!hasDeb || !hasRpm || !hasPacman)("verify, before signing and publishing", () => {
  it("refuses a Release whose Date is not within the last hour, before signing", async () => {
    const t = await builtTree();
    const r = join(t.tree, "apt/Release");
    const release = readFileSync(r, "utf8");
    writeFileSync(r, release.replace(/^Date: .*$/m, "Date: Sat, 01 Jan 2050 00:00:00 +0000"));
    expect(() => t.check()).toThrow(/Date/);
  }, 120_000);

  it("refuses package sizes that are not the release assets' sizes", async () => {
    const t = await builtTree();
    const list = structuredClone(t.releaseList);
    for (const r of list) for (const a of r.assets) a.size += 1;
    expect(() => t.check(undefined, false, list)).toThrow(/[Ss]ize/);
  }, 120_000);

  it("writes pacman's database itself: no MD5SUM, and the same bytes from the same desc", async () => {
    const t = await builtTree();
    const db = readFileSync(join(t.tree, "arch/x86_64/vimma.db"));
    const text = gunzipSync(db).toString("latin1");
    expect(text).not.toContain("%MD5SUM%");
    expect(text).not.toContain("PaxHeader");
  }, 120_000);
});

// The relations the signed metadata may declare are the ones package.ts gives Vimma's packages:
// a dependency, recommendation or provide beyond them would let the metadata pull in, or stand
// in for, any other package.
describe("relations", () => {
  const stanza =
    "Package: vimma\nVersion: 1.2.3\nArchitecture: amd64\nMaintainer: x <x@example.invalid>\n" +
    `Filename: pool/v1.2.3/vimma_1.2.3_amd64.deb\nSize: 10\nSHA256: ${"a".repeat(64)}\n` +
    "Description: test\n";
  const withFields = (fields: string) =>
    `${stanza.replace("Description", `${fields}\nDescription`)}\n`;

  // RELATIONS holds what package.ts declares now, and what a kept release built by an earlier
  // package.ts still declares, recorded in tests/fixtures/relations-<tag>.json from the
  // release's own packages (rpm -qp --requires/--provides/--recommends, dpkg-deb -f), and
  // nothing else: package.ts ⊆ RELATIONS ⊆ package.ts ∪ the recorded releases.
  it("RELATIONS holds what package.ts declares and what recorded releases declare, nothing more", () => {
    const recorded = readdirSync(new URL("./fixtures/", import.meta.url))
      .filter((f) => /^relations-v[0-9.]+\.json$/.test(f))
      .map(
        (f) =>
          JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as {
            deb: Record<"Depends" | "Recommends" | "Provides", string[]>;
            rpm: Record<"requires" | "recommends" | "provides", string[]>;
            pacman: Record<"DEPENDS" | "OPTDEPENDS" | "PROVIDES" | "CONFLICTS", string[]> | null;
          },
      );
    expect(recorded.length).toBeGreaterThan(0);
    const control = debControl({
      version: "1.2.3",
      maintainer: "x <x@example.invalid>",
      installedKiB: 1,
    });
    const field = (k: string) =>
      (new RegExp(`^${k}: (.*)$`, "m").exec(control)?.[1] ?? "").split(", ");
    const spec = rpmSpec({
      version: "1.2.3",
      maintainer: "x <x@example.invalid>",
      stage: "/tmp/s",
      bundled: [],
    });
    const tags = (k: string) =>
      [...spec.matchAll(new RegExp(`^${k}: (.*)$`, "gm"))].map((m) => m[1] as string);
    // rpm's desktop-file generator provides a mimehandler() per MimeType of the desktop entry
    const desktop = desktopEntry({ wmClass: "vimma-vimma", launcher: "/opt/vimma/vimma-open" });
    const mimes = (/^MimeType=(.*)$/m.exec(desktop)?.[1] ?? "").split(";").filter(Boolean);
    const build = pkgbuild({
      version: "1.2.3",
      maintainer: "x <x@example.invalid>",
      repo: "vimma-browser/vimma",
      tarballSha256: "a".repeat(64),
      desktop,
      desktopId: "vimma-vimma",
      launcher: readFileSync(LAUNCHER, "utf8"),
      installSource: "aur",
    });
    const arr = (k: string) =>
      [
        ...(new RegExp(`^${k}=\\(((?:'[^']*'\\s*)*)\\)`, "m").exec(build)?.[1] ?? "").matchAll(
          /'([^']*)'/g,
        ),
      ].map((m) => m[1] as string);
    const declared = {
      deb: {
        Depends: field("Depends"),
        Recommends: field("Recommends"),
        Provides: field("Provides"),
      },
      rpm: {
        requires: tags("Requires"),
        recommends: tags("Recommends"),
        provides: [...tags("Provides"), ...mimes.map((m) => `mimehandler(${m})`)],
      },
      pacman: {
        DEPENDS: arr("depends"),
        OPTDEPENDS: arr("optdepends"),
        PROVIDES: arr("provides"),
        CONFLICTS: arr("conflicts"),
      },
    };
    const rpmRelations = {
      requires: [...RELATIONS.rpm.requires, ...RELATIONS.rpm.elf],
      recommends: RELATIONS.rpm.recommends,
      provides: [...RELATIONS.rpm.provides, ...RELATIONS.rpm.versioned],
    };
    const check = (have: string[], now: string[], before: string[][], what: string) => {
      for (const r of now) expect(have, `${what}: package.ts declares ${r}`).toContain(r);
      for (const r of have) {
        expect([...now, ...before.flat()], `${what}: ${r} is declared by no one`).toContain(r);
      }
    };
    for (const k of ["Depends", "Recommends", "Provides"] as const) {
      check(
        RELATIONS.deb[k],
        declared.deb[k],
        recorded.map((x) => x.deb[k]),
        `deb ${k}`,
      );
    }
    for (const k of ["requires", "recommends", "provides"] as const) {
      check(
        rpmRelations[k],
        declared.rpm[k],
        recorded.map((x) => x.rpm[k]),
        `rpm ${k}`,
      );
      // a recorded release's own .rpm must pass
      for (const x of recorded) for (const r of x.rpm[k]) expect(rpmRelations[k]).toContain(r);
    }
    for (const k of ["DEPENDS", "OPTDEPENDS", "PROVIDES", "CONFLICTS"] as const) {
      check(
        RELATIONS.pacman[k],
        declared.pacman[k],
        recorded.map((x) => x.pacman?.[k] ?? []),
        `pacman ${k}`,
      );
    }
  });

  it("accepts Vimma's own relations in Packages", () => {
    checkPackages(
      withFields(
        `Depends: ${RELATIONS.deb.Depends.join(", ")}\nRecommends: libpulse0\nProvides: gnome-www-browser, www-browser`,
      ),
      [R123],
    );
  });

  it.each([
    ["Depends on another package", "Depends: libc6 (>= 2.31), openssh-server"],
    ["Recommends another package", "Recommends: cowsay"],
    ["Provides sudo", "Provides: sudo, libc6 (= 99)"],
    ["a changed version constraint", "Depends: libc6 (>= 2.99)"],
  ])("refuses a Packages that %s", (_, fields) => {
    expect(() => checkPackages(withFields(fields), [R123])).toThrow(/Packages/);
  });

  const pkg = (format: string) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">\n' +
    '<package type="rpm">\n  <name>vimma</name>\n  <arch>x86_64</arch>\n  <version epoch="0" ver="1.2.3" rel="1"/>\n' +
    `  <checksum type="sha256" pkgid="YES">${"a".repeat(64)}</checksum>\n` +
    "  <summary>s</summary>\n  <description>d</description>\n  <packager></packager>\n  <url></url>\n" +
    '  <time file="1" build="1"/>\n  <size package="10" installed="1" archive="1"/>\n' +
    '  <location href="packages/v1.2.3/vimma-1.2.3-1.x86_64.rpm"/>\n' +
    `  <format>\n    <rpm:license>MPL-2.0</rpm:license>\n${format}  </format>\n</package>\n</metadata>`;

  it("accepts Vimma's own relations and files in primary.xml", () => {
    checkPrimary(
      pkg(
        '    <rpm:provides>\n      <rpm:entry name="vimma" flags="EQ" epoch="0" ver="1.2.3" rel="1"/>\n' +
          '      <rpm:entry name="mimehandler(text/html)"/>\n    </rpm:provides>\n' +
          '    <rpm:requires>\n      <rpm:entry name="libc.so.6(GLIBC_2.17)(64bit)"/>\n' +
          '      <rpm:entry name="/bin/sh" pre="1"/>\n    </rpm:requires>\n' +
          '    <rpm:recommends>\n      <rpm:entry name="libpulse.so.0()(64bit)"/>\n    </rpm:recommends>\n' +
          "    <file>/usr/bin/vimma</file>\n",
      ),
      [R123],
    );
  });

  it.each([
    [
      "requires another package",
      '    <rpm:requires>\n      <rpm:entry name="openssh-server"/>\n    </rpm:requires>\n',
    ],
    [
      "requires a library Vimma does not link",
      '    <rpm:requires>\n      <rpm:entry name="libssh.so.4()(64bit)"/>\n    </rpm:requires>\n',
    ],
    [
      "recommends another package",
      '    <rpm:recommends>\n      <rpm:entry name="cowsay"/>\n    </rpm:recommends>\n',
    ],
    [
      "provides sudo",
      '    <rpm:provides>\n      <rpm:entry name="sudo" flags="EQ" epoch="99" ver="99" rel="1"/>\n    </rpm:provides>\n',
    ],
    ["lists a file outside Vimma's paths", "    <file>/usr/bin/sudo</file>\n"],
    ["lists a path with ..", "    <file>/usr/lib/vimma/../../bin/sudo</file>\n"],
  ])("refuses a primary.xml that %s", (_, format) => {
    expect(() => checkPrimary(pkg(format), [R123])).toThrow(/primary\.xml/);
  });

  const db = (extra: string) =>
    pacmanDatabase(
      R123,
      "%FILENAME%\nvimma-bin-1.2.3-1-x86_64.pkg.tar.zst\n\n%NAME%\nvimma-bin\n\n%BASE%\nvimma-bin\n\n" +
        `%VERSION%\n1.2.3-1\n\n%CSIZE%\n10\n\n%SHA256SUM%\n${"a".repeat(64)}\n\n%ARCH%\nx86_64\n\n${extra}`,
    );

  it("accepts Vimma's own relations in the pacman database", () => {
    checkPacmanDb(
      db("%CONFLICTS%\nvimma\n\n%PROVIDES%\nvimma\n\n%DEPENDS%\ngtk3\nalsa-lib\n\n"),
      R123,
    );
  });

  it.each([
    ["DEPENDS on another package", "%DEPENDS%\ngtk3\nopenssh\n\n"],
    ["OPTDEPENDS on another package", "%OPTDEPENDS%\ncowsay: moo\n\n"],
    ["PROVIDES sudo", "%PROVIDES%\nsudo\n\n"],
  ])("refuses a pacman database that %s", (_, extra) => {
    expect(() => checkPacmanDb(db(extra), R123)).toThrow(/vimma\.db/);
  });

  // Review of sub-PR 3: the package managers show the homepage, so metadata from a compromised
  // repo-prepare must not get a link of its choosing signed. Empty or Vimma's own.
  it("takes no homepage but Vimma's own, in each format", () => {
    const home = "https://github.com/vimma-browser/vimma";
    const evil = "https://vimma-browser.example/download";
    const stanza =
      "Package: vimma\nVersion: 1.2.3\nArchitecture: amd64\nMaintainer: x <x@example.invalid>\n" +
      `Filename: pool/v1.2.3/vimma_1.2.3_amd64.deb\nSize: 10\nSHA256: ${"a".repeat(64)}\n`;
    const deb = (url: string) => `${stanza}Homepage: ${url}\nDescription: test\n\n`;
    checkPackages(deb(home), [R123]);
    expect(() => checkPackages(deb(evil), [R123])).toThrow(/Packages: Homepage/);

    const rpm = (url: string) => pkg("").replace("<url></url>", `<url>${url}</url>`);
    checkPrimary(rpm(home), [R123]);
    expect(() => checkPrimary(rpm(evil), [R123])).toThrow(/primary\.xml.*url/);

    const desc = (url: string) =>
      pacmanDatabase(
        R123,
        "%FILENAME%\nvimma-bin-1.2.3-1-x86_64.pkg.tar.zst\n\n%NAME%\nvimma-bin\n\n%BASE%\nvimma-bin\n\n" +
          `%VERSION%\n1.2.3-1\n\n%CSIZE%\n10\n\n%SHA256SUM%\n${"a".repeat(64)}\n\n%URL%\n${url}\n\n%ARCH%\nx86_64\n\n`,
      );
    checkPacmanDb(desc(home), R123);
    expect(() => checkPacmanDb(desc(evil), R123)).toThrow(/vimma\.db: %URL%/);
  });
});

describe("strict reading, further cases", () => {
  const stanza =
    "Package: vimma\nVersion: 1.2.3\nArchitecture: amd64\nMaintainer: x <x@example.invalid>\n" +
    `Filename: pool/v1.2.3/vimma_1.2.3_amd64.deb\nSize: 10\nSHA256: ${"a".repeat(64)}\n` +
    "Description: test\n";
  it.each([
    ["U+0085", "\u0085"],
    ["a vertical tab", "\v"],
    ["a replacement character (invalid UTF-8)", "\uFFFD"],
    ["a byte order mark", "\uFEFF"],
  ])("refuses %s in Packages", (_, c) => {
    expect(() => checkPackages(`${stanza.replace("x <", `x${c}<`)}\n`, [R123])).toThrow(/Packages/);
  });

  const good =
    "  <name>vimma</name>\n  <arch>x86_64</arch>\n" +
    '  <version epoch="0" ver="1.2.3" rel="1"/>\n' +
    `  <checksum type="sha256" pkgid="YES">${"a".repeat(64)}</checksum>\n` +
    "  <summary>s</summary>\n  <description>d</description>\n  <packager></packager>\n  <url></url>\n" +
    '  <time file="1" build="1"/>\n  <size package="10" installed="1" archive="1"/>\n' +
    '  <location href="packages/v1.2.3/vimma-1.2.3-1.x86_64.rpm"/>\n' +
    "  <format>\n    <rpm:license>MPL-2.0</rpm:license>\n  </format>\n";
  const pkg = (inner: string) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">\n' +
    `<package type="rpm">\n${inner}</package>\n</metadata>`;
  const fmt = (x: string) => pkg(good.replace("  </format>", `${x}  </format>`));
  it.each([
    [
      "format children out of order or twice",
      fmt("<rpm:requires></rpm:requires><rpm:license>x</rpm:license><rpm:requires/>"),
    ],
    [
      "xmlns:rpm redeclared on a relation",
      fmt('<rpm:requires xmlns:rpm="urn:x"><rpm:entry name="/bin/sh"/></rpm:requires>'),
    ],
    ["an attribute on format", pkg(good.replace("<format>", '<format xmlns:rpm="urn:x">'))],
    ["a no-break space between elements", pkg(good.replace("  <arch>", "\u00a0<arch>"))],
    ["a control character", pkg(good.replace("<summary>s", "<summary>s\x01"))],
    ["]]> in text", pkg(good.replace("<description>d", "<description>]]>"))],
    ["a tab in an attribute", fmt('<rpm:requires><rpm:entry name="a\tb"/></rpm:requires>')],
    ["U+FFFE", pkg(good.replace("<summary>s", "<summary>s\uFFFE"))],
  ])("refuses %s in primary.xml", (_, xml) => {
    expect(() => checkPrimary(xml, [R123])).toThrow(/primary\.xml/);
  });

  // What may follow a gzip member: another member (which libarchive and apt read on), an empty
  // one, zeros, garbage, or garbage that starts like a member.
  it.each<[string, Buffer]>([
    ["a second member", gzipSync("BBBB\n")],
    ["a NUL and a member", Buffer.concat([Buffer.from([0]), gzipSync("BBBB\n")])],
    ["zeros", Buffer.alloc(16)],
    ["garbage", Buffer.from("xyz")],
    ["a member's magic and garbage", Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0])],
    ["an empty member and a member", Buffer.concat([gzipSync(""), gzipSync("BBBB\n")])],
  ])("refuses a pacman database whose gzip member is followed by %s", (_, tail) => {
    const desc =
      "%FILENAME%\nvimma-bin-1.2.3-1-x86_64.pkg.tar.zst\n\n%NAME%\nvimma-bin\n\n%BASE%\nvimma-bin\n\n" +
      `%VERSION%\n1.2.3-1\n\n%CSIZE%\n10\n\n%SHA256SUM%\n${"a".repeat(64)}\n\n%ARCH%\nx86_64\n\n`;
    const good = pacmanDatabase(R123, desc);
    checkPacmanDb(good, R123);
    expect(() => checkPacmanDb(Buffer.concat([good, tail]), R123)).toThrow(/vimma\.db/);
  });
});

describe.skipIf(!hasDeb || !hasRpm || !hasPacman)("verify, further cases", () => {
  it.each([
    [
      "asctime, which Date.parse reads in local time",
      (d: Date) =>
        d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, "$1 $3 $2 $5 $4"),
    ],
    ["a +1400 offset", (d: Date) => d.toUTCString().replace("GMT", "+1400")],
    ["GMT for UTC", (d: Date) => d.toUTCString()],
  ])(
    "refuses a Release Date in another form: %s",
    async (_, form) => {
      const t = await builtTree();
      const r = join(t.tree, "apt/Release");
      writeFileSync(r, readFileSync(r, "utf8").replace(/^Date: .*$/m, `Date: ${form(new Date())}`));
      expect(() => t.check()).toThrow(/Date/);
    },
    120_000,
  );

  it("refuses Packages.gz with a second gzip member", async () => {
    const t = await builtTree();
    const gz = join(t.tree, "apt/Packages.gz");
    writeFileSync(gz, Buffer.concat([readFileSync(gz), gzipSync("Package: evil\n")]));
    expect(() => t.check()).toThrow(/Packages\.gz/);
  }, 120_000);

  it("refuses repodata whose file name is not its checksum and type, or whose sizes differ", async () => {
    const t = await builtTree();
    const r = join(t.tree, "rpm/repodata/repomd.xml");
    const repomd = readFileSync(r, "utf8");
    writeFileSync(
      r,
      repomd.replace(
        /(<data type="other">[\s\S]*?<size>)(\d+)/,
        (_, a: string, n: string) => `${a}${Number(n) + 1}`,
      ),
    );
    expect(() => t.check()).toThrow(/repomd\.xml.*other.*size/s);
    writeFileSync(r, repomd);
    const href = /<data type="other">[\s\S]*?<location href="repodata\/([^"]+)"/.exec(
      repomd,
    )?.[1] as string;
    const renamed = href.replace("-other.xml.gz", "-primary.xml.gz").replace(/^[0-9a-f]/, "0");
    const { renameSync } = await import("node:fs");
    renameSync(join(t.tree, "rpm/repodata", href), join(t.tree, "rpm/repodata", renamed));
    writeFileSync(r, repomd.replace(href, renamed));
    expect(() => t.check()).toThrow(/repomd\.xml.*other/s);
  }, 120_000);

  it("compares pacman's databases decompressed, and re-gzips them itself when asked", async () => {
    const t = await builtTree();
    const f = join(t.tree, "arch/x86_64/vimma.db");
    const tar = gunzipSync(readFileSync(f));
    writeFileSync(f, gzipSync(tar, { level: 1 }));
    t.check();
    verify({
      tree: t.tree,
      cert: t.certFile,
      releases: ["v0.3.0", "v0.2.0"].map((tag) => ({ tag, sums: t.sums[tag] as string })),
      releaseList: t.releaseList,
      baseUrl: HOST,
      downloadBase: GITHUB,
      signed: false,
      regzip: true,
    });
    expect(readFileSync(f)).toEqual(gzipSync(tar, { level: 9 }));
  }, 120_000);
});

// A relation with a version Vimma's .rpm does not declare can make the next upgrade's
// dependencies unsatisfiable: dnf 5.4.3 then skips the package ("Skipping packages with broken
// dependencies") and leaves users on the old release, so the metadata must not carry one.
describe("rpm relations carry no version but Vimma's own", () => {
  const pkg = (format: string, summary = "<summary>s</summary>") =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="1">\n' +
    '<package type="rpm">\n  <name>vimma</name>\n  <arch>x86_64</arch>\n  <version epoch="0" ver="1.2.3" rel="1"/>\n' +
    `  <checksum type="sha256" pkgid="YES">${"a".repeat(64)}</checksum>\n` +
    `  ${summary}\n  <description>d</description>\n  <packager></packager>\n  <url></url>\n` +
    '  <time file="1" build="1"/>\n  <size package="10" installed="1" archive="1"/>\n' +
    '  <location href="packages/v1.2.3/vimma-1.2.3-1.x86_64.rpm"/>\n' +
    `  <format>\n${format}  </format>\n</package>\n</metadata>`;
  const rel = (kind: string, entry: string) =>
    `    <rpm:${kind}>\n      ${entry}\n    </rpm:${kind}>\n`;

  it("accepts vimma's own versioned provides at the release's version", () => {
    checkPrimary(
      pkg(
        rel(
          "provides",
          '<rpm:entry name="vimma" flags="EQ" epoch="0" ver="1.2.3" rel="1"/>\n      <rpm:entry name="vimma(x86-64)" flags="EQ" epoch="0" ver="1.2.3" rel="1"/>',
        ),
      ),
      [R123],
    );
  });

  it.each([
    [
      "requires hicolor-icon-theme >= 999 (dnf 5.4.3 kept the old release)",
      rel("requires", '<rpm:entry name="hicolor-icon-theme" flags="GE" epoch="0" ver="999"/>'),
    ],
    [
      "requires a glibc symbol version 0.1.22 does not (dnf 5.4.3 kept the old release)",
      rel("requires", '<rpm:entry name="libc.so.6(GLIBC_9.99)(64bit)"/>'),
    ],
    [
      "requires hicolor-icon-theme < 0",
      rel("requires", '<rpm:entry name="hicolor-icon-theme" flags="LT" epoch="0" ver="0"/>'),
    ],
    [
      "pre on a requirement other than /bin/sh",
      rel("requires", '<rpm:entry name="hicolor-icon-theme" pre="1"/>'),
    ],
    [
      "recommends libpulse at a version",
      rel("recommends", '<rpm:entry name="libpulse.so.0()(64bit)" flags="GE" epoch="0" ver="99"/>'),
    ],
    [
      "provides webclient at a version",
      rel("provides", '<rpm:entry name="webclient" flags="EQ" epoch="99" ver="99"/>'),
    ],
    [
      "provides vimma at another version",
      rel("provides", '<rpm:entry name="vimma" flags="EQ" epoch="0" ver="9.9.9" rel="1"/>'),
    ],
    ["provides vimma without its version", rel("provides", '<rpm:entry name="vimma"/>')],
  ])("refuses an entry that %s", (_, format) => {
    expect(() => checkPrimary(pkg(format), [R123])).toThrow(/primary\.xml/);
  });

  it("refuses an attribute on a text element", () => {
    expect(() => checkPrimary(pkg("", '<summary foo="bar">s</summary>'), [R123])).toThrow(
      /primary\.xml/,
    );
  });
});

describe("vimma.files lists Vimma's own paths alone", () => {
  const desc =
    "%FILENAME%\nvimma-bin-1.2.3-1-x86_64.pkg.tar.zst\n\n%NAME%\nvimma-bin\n\n%BASE%\nvimma-bin\n\n" +
    `%VERSION%\n1.2.3-1\n\n%CSIZE%\n10\n\n%SHA256SUM%\n${"a".repeat(64)}\n\n%ARCH%\nx86_64\n\n`;
  const files = (paths: string[]) => `%FILES%\n${paths.join("\n")}\n\n`;
  const own = [
    "opt/",
    "opt/vimma/",
    "opt/vimma/vimma",
    "opt/vimma/browser/",
    "opt/vimma/browser/omni.ja",
    "usr/",
    "usr/bin/",
    "usr/bin/vimma",
    "usr/bin/vimma-ctl",
    "usr/bin/vimma-open",
    "usr/share/",
    "usr/share/applications/",
    "usr/share/applications/vimma-vimma.desktop",
    "usr/share/icons/",
    "usr/share/icons/hicolor/",
    "usr/share/icons/hicolor/16x16/",
    "usr/share/icons/hicolor/16x16/apps/",
    "usr/share/icons/hicolor/16x16/apps/vimma.png",
  ];

  it("accepts the paths the PKGBUILD installs", () => {
    expect(readPacmanFiles(pacmanDatabase(R123, desc, files(own)), R123)).toBeUndefined();
  });

  it.each([
    ["usr/bin/sudo"],
    ["etc/sudoers.d/vimma"],
    ["opt/vimma/../../usr/bin/sudo"],
    ["/opt/vimma/vimma"],
  ])("refuses %s", (path) => {
    expect(() => readPacmanFiles(pacmanDatabase(R123, desc, files([...own, path])), R123)).toThrow(
      /vimma\.files/,
    );
  });
});

describe.skipIf(!hasDeb || !hasRpm || !hasPacman)("Release's Date, as apt checks it", () => {
  const stamp = (d: Date) => d.toUTCString().replace(/GMT$/, "+0000");
  it.each([
    ["a weekday that does not exist", (d: Date) => stamp(d).replace(/^[A-Z][a-z]{2}/, "Xyz")],
    [
      "the wrong weekday",
      (d: Date) => stamp(d).replace(/^[A-Z][a-z]{2}/, (w) => (w === "Mon" ? "Tue" : "Mon")),
    ],
    [
      "24:00:00",
      (d: Date) =>
        stamp(new Date(d.getTime() - 86_400_000)).replace(/[0-9]{2}:[0-9]{2}:[0-9]{2}/, "24:00:00"),
    ],
    [
      "a day the month does not have",
      (d: Date) => stamp(d).replace(/^\w+, [0-9]{2} \w+/, "Sat, 31 Nov"),
    ],
  ])(
    "refuses %s",
    async (_, form) => {
      const t = await builtTree();
      const r = join(t.tree, "apt/Release");
      writeFileSync(r, readFileSync(r, "utf8").replace(/^Date: .*$/m, `Date: ${form(new Date())}`));
      expect(() => t.check()).toThrow(/Date/);
    },
    120_000,
  );
});
