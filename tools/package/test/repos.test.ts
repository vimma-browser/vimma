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
import { gunzipSync } from "node:zlib";
import { tempDir } from "../../test/temp-dir.ts";
import { haveTool, missingRequired } from "./have-tool.ts";
import { certify, localSigner } from "../openpgp-kms.ts";
import {
  aptSources,
  build,
  headersFile,
  plan,
  readRelease,
  redirectsFile,
  rpmRepo,
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
async function cert(): Promise<string> {
  if (!certText) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    certText = await certify(localSigner(pem), 1790000000, "Vimma packages <packages@vimma.dev>");
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
    mkdirSync(join(r, "usr/share/vimma"), { recursive: true });
    writeFileSync(join(r, "usr/share/vimma/version"), version);
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
        "%description\nstub\n%install\nmkdir -p %{buildroot}/usr/share/vimma\n" +
        `echo ${version} > %{buildroot}/usr/share/vimma/version\n%files\n/usr/share/vimma/version\n`,
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
    mkdirSync(join(r, "usr/share/vimma"), { recursive: true });
    writeFileSync(join(r, "usr/share/vimma/version"), version);
    writeFileSync(
      join(r, ".PKGINFO"),
      `pkgname = ${name}-bin\npkgbase = ${name}-bin\npkgver = ${said}-1\npkgdesc = stub\n` +
        "url = https://vimma.dev\nbuilddate = 1790000000\npackager = Vimma CI <ci@example.invalid>\n" +
        "size = 6\narch = x86_64\nlicense = MPL-2.0\n",
    );
    const file = join(dir, `vimma-bin-${version}-1-x86_64.pkg.tar.zst`);
    ok("bsdtar", ["--zstd", "-cf", file, "-C", r, ".PKGINFO", "usr"]);
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
      ).toContain("usr/share/vimma/version");

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
