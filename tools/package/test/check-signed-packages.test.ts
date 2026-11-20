// Spec package-repositories, decisions 9 and 10: release.yml's packages job checks what
// update-publish.yml's package-sign job returned, with no secret, before SHA256SUMS lists it.
// gpg and gpgv are real, with a throwaway key; rpm and rpmkeys are stand-ins whose "package" is a
// header line and a payload, so the script's own logic is what is tested (release.yml runs it on
// the real .rpm, with Ubuntu's rpm).
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
 * one that says `corrupt` gives its payload and then fails, as a read cut short would. Like rpm 6.0, the rpm stand-in knows only some tags:
 * for an unknown one it prints an error and nothing else, and still exits 0.
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
case " $* " in
  *" %{NEVRA} "*) printf 'vimma-0.3.1-1.x86_64' ;;
  *) echo 'error: incorrect format: unknown tag' >&2 ;;
esac
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
  return { cert, sign };
}

/** dist/ as package leaves it and signed/ as package-sign returns it, all consistent. */
function release(dir: string, signer: ReturnType<typeof key>) {
  const dist = join(dir, "dist");
  const signed = join(dir, "signed");
  mkdirSync(dist);
  mkdirSync(signed);
  writeFileSync(join(dist, RPM), "header\npayload\n");
  writeFileSync(join(dist, PKG), "pacman package");
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
  writeFileSync(join(signed, RPM), "header signed\npayload\n");
  signer.sign(join(dist, PKG), join(signed, `${PKG}.sig`));
  writeFileSync(
    join(signed, "SHA256SUMS"),
    sums([
      [RPM, "header signed\npayload\n"],
      [PKG, "pacman package"],
      [`${PKG}.sig`, readFileSync(join(signed, `${PKG}.sig`))],
      ["vimma-0.3.1-linux-x86_64.tar.xz", "t"],
    ]),
  );
  return { dist, signed };
}

// Linux only: release.yml runs the script on ubuntu-24.04, and it uses GNU find and sha256sum.
describe.skipIf(process.platform !== "linux" || !has("gpg") || !has("gpgv"))(
  "check-signed-packages.sh",
  () => {
    const run = (dir: string, cert: string, tag = TAG) =>
      spawnSync(SCRIPT, [tag, join(dir, "dist"), join(dir, "signed"), cert], {
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
      const { dir, signer, signed, dist } = setup();
      key("other").sign(join(dist, PKG), join(signed, `${PKG}.sig`));
      expect(run(dir, signer.cert).stderr).toMatch(/\.sig: no valid signature by the package key/);
    });

    it("refuses a pacman package that changed after it was signed", () => {
      const { dir, signer, dist } = setup();
      writeFileSync(join(dist, PKG), "another pacman package");
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
  },
);
