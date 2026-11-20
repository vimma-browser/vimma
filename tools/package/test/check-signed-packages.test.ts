// Spec package-repositories, decisions 9 and 10: release.yml's packages job checks what
// update-publish.yml's package-sign job returned, with no secret, before SHA256SUMS lists it.
// gpg and gpgv are real, with a throwaway key. Most cases use stand-ins for rpm, rpm2cpio and
// rpmkeys whose "package" is a header line and a payload, so the script's own logic is what is
// tested; one case builds and signs a real .rpm where rpm is installed (as on ubuntu-24.04, whose
// rpm release.yml runs the script with).
import { describe, expect, it, onTestFinished } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.ts";

const SCRIPT = fileURLToPath(new URL("../check-signed-packages.sh", import.meta.url));
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const TAG = "v0.3.1";
const RPM = "vimma-0.3.1-1.x86_64.rpm";
const PKG = "vimma-bin-0.3.1-1-x86_64.pkg.tar.zst";
const sum = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * rpm, rpm2cpio and rpmkeys stand-ins: the first line is the header, a signed one says `signed`,
 * one that says `corrupt` gives its payload and then fails, as a read cut short would. The
 * header's digest (SHA256HEADER) is that line without those two words, as signing leaves the main
 * header alone. Like rpm 6.0, the rpm stand-in knows only some tags: for an unknown one it prints
 * an error and nothing else, and still exits 0.
 */
function shims(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "rpmkeys"),
    `#!/bin/bash
case " $* " in
  *" --import "*) exit 0 ;;
  *" --checksig "*) f=\${!#}; head -n 1 "$f" | grep -q signed && echo "$f: digests signatures OK" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "rpm"),
    `#!/bin/bash
f=\${!#}
h=$(head -n 1 "$f" | sed 's/ signed//; s/ corrupt//')
q=$(printf '%s' "$*" | sed -n 's/.*--qf \\([^ ]*\\).*/\\1/p')
out=\${q//"%{NEVRA}"/vimma-0.3.1-1.x86_64}
out=\${out//"%{SHA256HEADER}"/$(printf %s "$h" | sha256sum | cut -c1-64)}
case $out in *"%{"*) echo 'error: incorrect format: unknown tag' >&2 ;; *) printf '%s' "$out" ;; esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "rpm2cpio"),
    `#!/bin/bash
tail -n +2 "$1"
head -n 1 "$1" | grep -q corrupt && { echo "rpm2cpio: corrupt" >&2; exit 1; }
exit 0
`,
    { mode: 0o755 },
  );
  return bin;
}

/**
 * A throwaway key in its own GNUPGHOME, and its armoured certificate. The home is a short path
 * under /tmp, since gpg-agent's socket lives in it and a Unix socket path is limited to about 100
 * bytes; its agent is stopped when the test ends.
 */
function key(name: string) {
  const home = mkdtempSync(`/tmp/vg-${name.slice(0, 3)}-`);
  chmodSync(home, 0o700);
  onTestFinished(() => {
    spawnSync("gpgconf", ["--homedir", home, "--kill", "gpg-agent"]);
    rmSync(home, { recursive: true, force: true });
  });
  const gpg = (args: string[], input?: string) =>
    execFileSync("gpg", ["--homedir", home, "--batch", "--quiet", ...args], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  gpg([
    "--passphrase",
    "",
    "--quick-gen-key",
    `${name} <${name}@example.invalid>`,
    "rsa2048",
    "sign",
    "never",
  ]);
  const cert = join(home, `${name}.asc`);
  writeFileSync(cert, gpg(["--armor", "--export"]));
  const sign = (file: string, out: string) =>
    gpg(["--yes", "--detach-sign", "--output", out, file]);
  return { cert, sign, home, name };
}

/**
 * dist/ as the release artifact has it (no pacman package), unsigned/ as package's
 * packages-unsigned artifact and signed/ as package-sign returns it, all consistent.
 */
function release(dir: string, signer: ReturnType<typeof key>) {
  const dist = join(dir, "dist");
  const unsigned = join(dir, "unsigned");
  const signed = join(dir, "signed");
  for (const d of [dist, unsigned, signed]) mkdirSync(d);
  writeFileSync(join(dist, RPM), "header\npayload\n");
  writeFileSync(join(unsigned, RPM), "header\npayload\n");
  writeFileSync(join(unsigned, PKG), "pacman package");
  writeFileSync(join(dist, "vimma-0.3.1-linux-x86_64.tar.xz"), "t");
  const sums = (files: [string, string | Buffer][]) =>
    files
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([f, c]) => `${sum(c)}  ${f}\n`)
      .join("");
  writeFileSync(
    join(dist, "SHA256SUMS"),
    sums([
      [RPM, "header\npayload\n"],
      ["vimma-0.3.1-linux-x86_64.tar.xz", "t"],
    ]),
  );
  writeFileSync(join(unsigned, "SHA256SUMS"), readFileSync(join(dist, "SHA256SUMS")));
  writeFileSync(join(signed, RPM), "header signed\npayload\n");
  signer.sign(join(unsigned, PKG), join(signed, `${PKG}.sig`));
  writeFileSync(
    join(signed, "SHA256SUMS"),
    sums([
      [RPM, "header signed\npayload\n"],
      [PKG, "pacman package"],
      [`${PKG}.sig`, readFileSync(join(signed, `${PKG}.sig`))],
      ["vimma-0.3.1-linux-x86_64.tar.xz", "t"],
    ]),
  );
  return { dist, unsigned, signed };
}

// Linux only: release.yml runs the script on ubuntu-24.04, and it uses GNU find and sha256sum.
describe.skipIf(process.platform !== "linux" || !has("gpg") || !has("gpgv"))(
  "check-signed-packages.sh",
  () => {
    const run = (dir: string, cert: string, tag = TAG) =>
      spawnSync(SCRIPT, [tag, ...["dist", "unsigned", "signed"].map((d) => join(dir, d)), cert], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
      });
    const setup = () => {
      const dir = tempDir("vimma-signed-packages-");
      shims(dir);
      const signer = key("packages");
      return { dir, signer, ...release(dir, signer) };
    };

    it("accepts package-sign's output: both signatures and the new SHA256SUMS", () => {
      const { dir, signer } = setup();
      const r = run(dir, signer.cert);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`${RPM} and ${PKG} are signed by the package key`);
    });

    it("refuses a pacman package signed by another key", () => {
      const { dir, signer, signed, unsigned } = setup();
      key("other").sign(join(unsigned, PKG), join(signed, `${PKG}.sig`));
      expect(run(dir, signer.cert).stderr).toMatch(/\.sig: no valid signature by the package key/);
    });

    it("refuses a pacman package that changed after it was signed", () => {
      const { dir, signer, unsigned } = setup();
      writeFileSync(join(unsigned, PKG), "another pacman package");
      expect(run(dir, signer.cert).stderr).toMatch(/\.sig: no valid signature/);
    });

    it("refuses an unsigned .rpm, and one whose payload changed", () => {
      const { dir, signer, signed } = setup();
      writeFileSync(join(signed, RPM), "header\npayload\n");
      expect(run(dir, signer.cert).stderr).toMatch(/no valid signature by the package key/);
      writeFileSync(join(signed, RPM), "header signed\nother payload\n");
      expect(run(dir, signer.cert).stderr).toMatch(/payload or name is not the built one's/);
    });

    // A query that reads nothing on both sides must not count as equal payloads.
    it("refuses an .rpm whose payload cannot be read", () => {
      const { dir, signer, signed } = setup();
      const corrupt = "header signed corrupt\npayload\n";
      writeFileSync(join(signed, RPM), corrupt);
      const sums = readFileSync(join(signed, "SHA256SUMS"), "utf8");
      writeFileSync(
        join(signed, "SHA256SUMS"),
        sums.replace(sum("header signed\npayload\n"), sum(corrupt)),
      );
      const r = run(dir, signer.cert);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/rpm2cpio: corrupt/);
    });

    // Signing rewrites only the signature header; the main header's digest stays the built one's.
    it("refuses an .rpm whose main header changed", () => {
      const { dir, signer, signed } = setup();
      const other = "other header signed\npayload\n";
      writeFileSync(join(signed, RPM), other);
      const sums = readFileSync(join(signed, "SHA256SUMS"), "utf8");
      writeFileSync(
        join(signed, "SHA256SUMS"),
        sums.replace(sum("header signed\npayload\n"), sum(other)),
      );
      expect(run(dir, signer.cert).stderr).toMatch(/header is not the built one's/);
    });

    // The pacman package reaches the release only through the packages job, after this check.
    it("refuses a release artifact that already holds a pacman package", () => {
      const { dir, signer, dist, unsigned } = setup();
      writeFileSync(join(dist, PKG), readFileSync(join(unsigned, PKG)));
      expect(run(dir, signer.cert).stderr).toMatch(/release artifact holds a pacman package/);
    });

    it("refuses a packages-unsigned .rpm that is not the release's", () => {
      const { dir, signer, unsigned } = setup();
      writeFileSync(join(unsigned, RPM), "header\nother payload\n");
      expect(run(dir, signer.cert).stderr).toMatch(/not the release artifact's/);
    });

    it("refuses a SHA256SUMS that is not package's with the signed packages", () => {
      const { dir, signer, signed } = setup();
      const sums = readFileSync(join(signed, "SHA256SUMS"), "utf8");
      // A line dropped, a line added, the old .rpm's line kept.
      for (const bad of [
        sums.split("\n").slice(1).join("\n"),
        `${sums}${sum("x")}  vimma-extra\n`,
        sums.replace(sum("header signed\npayload\n"), sum("header\npayload\n")),
      ]) {
        writeFileSync(join(signed, "SHA256SUMS"), bad);
        expect(run(dir, signer.cert).stderr).toMatch(/SHA256SUMS is not package's/);
      }
    });

    it("refuses an extra or missing file, and a tag that is not vX.Y.Z", () => {
      const { dir, signer, signed } = setup();
      expect(run(dir, signer.cert, "v0.3.1-rc1").stderr).toMatch(/not a vX\.Y\.Z release tag/);
      writeFileSync(join(signed, "extra"), "x");
      expect(run(dir, signer.cert).stderr).toMatch(/package-sign returned/);
      rmSync(join(signed, "extra"));
      rmSync(join(signed, `${PKG}.sig`));
      expect(run(dir, signer.cert).stderr).toMatch(/package-sign returned/);
    });

    it("refuses to run without the committed certificate", () => {
      const { dir } = setup();
      expect(run(dir, join(dir, "missing.asc")).stderr).toMatch(/no certificate/);
    });

    // The real rpm: rpmbuild, rpmsign with gpg and the throwaway key, rpmkeys and rpm2cpio.
    describe.skipIf(!["rpmbuild", "rpmsign", "rpmkeys", "rpm2cpio"].every(has))("with rpm", () => {
      it("accepts a real .rpm signed by the key, and refuses one signed by another", () => {
        const dir = tempDir("vimma-real-rpm-");
        const top = join(dir, "rpmbuild");
        mkdirSync(join(top, "SPECS"), { recursive: true });
        writeFileSync(
          join(top, "SPECS", "vimma.spec"),
          [
            "Name: vimma",
            "Version: 0.3.1",
            "Release: 1",
            "Summary: stub",
            "License: MPL-2.0",
            "BuildArch: x86_64",
            "%description",
            "stub",
            "%install",
            "mkdir -p %{buildroot}/usr/lib/vimma",
            "echo stub > %{buildroot}/usr/lib/vimma/stub",
            "%files",
            "/usr/lib/vimma/stub",
            "",
          ].join("\n"),
        );
        execFileSync("rpmbuild", [
          "-bb",
          "--quiet",
          "--define",
          `_topdir ${top}`,
          "--define",
          `_rpmdir ${dir}`,
          "--define",
          "_build_name_fmt %{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}.rpm",
          join(top, "SPECS", "vimma.spec"),
        ]);
        const signer = key("packages");
        const other = key("other");
        const { dist, unsigned, signed } = release(dir, signer);
        for (const d of [dist, unsigned]) writeFileSync(join(d, RPM), readFileSync(join(dir, RPM)));
        const signWith = (k: ReturnType<typeof key>) => {
          writeFileSync(join(signed, RPM), readFileSync(join(dir, RPM)));
          // %__gpg names gpg by path: Ubuntu's rpm 4.18 has /usr/bin/gpg2 there, which it lacks.
          const gpg = execFileSync("sh", ["-c", "command -v gpg"], { encoding: "utf8" }).trim();
          execFileSync("rpmsign", [
            "--addsign",
            "--define",
            `__gpg ${gpg}`,
            "--define",
            `_gpg_path ${k.home}`,
            "--define",
            `_gpg_name ${k.name} <${k.name}@example.invalid>`,
            join(signed, RPM),
          ]);
          const builtSums = `${sum(readFileSync(join(dir, RPM)))}  ${RPM}\n${sum("t")}  vimma-0.3.1-linux-x86_64.tar.xz\n`;
          writeFileSync(join(dist, "SHA256SUMS"), builtSums);
          writeFileSync(join(unsigned, "SHA256SUMS"), builtSums);
          writeFileSync(
            join(signed, "SHA256SUMS"),
            [
              `${sum(readFileSync(join(signed, RPM)))}  ${RPM}\n`,
              `${sum("t")}  vimma-0.3.1-linux-x86_64.tar.xz\n`,
              `${sum("pacman package")}  ${PKG}\n`,
              `${sum(readFileSync(join(signed, `${PKG}.sig`)))}  ${PKG}.sig\n`,
            ].join(""),
          );
        };
        const real = () =>
          spawnSync(SCRIPT, [TAG, dist, unsigned, signed, signer.cert], { encoding: "utf8" });
        signWith(signer);
        const ok = real();
        expect(ok.status, ok.stderr).toBe(0);
        signWith(other);
        expect(real().stderr).toMatch(/no valid signature by the package key/);
      });
    });
  },
);
