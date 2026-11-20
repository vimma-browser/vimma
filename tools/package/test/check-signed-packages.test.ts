// Spec package-repositories, decisions 9 and 10: release.yml's packages job checks what
// update-publish.yml's package-sign job returned, with no secret, before SHA256SUMS lists it.
// gpg and gpgv are real, with a throwaway key; rpm and rpmkeys are stand-ins whose "package" is a
// header line and a payload, so the script's own logic is what is tested (release.yml runs it on
// the real .rpm, with Ubuntu's rpm).
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.ts";

const SCRIPT = fileURLToPath(new URL("../check-signed-packages.sh", import.meta.url));
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

const TAG = "v0.3.1";
const RPM = "vimma-0.3.1-1.x86_64.rpm";
const PKG = "vimma-bin-0.3.1-1-x86_64.pkg.tar.zst";
const sum = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** rpm and rpmkeys stand-ins: the first line is the header, a signed one says `signed`. */
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
printf '%s vimma-0.3.1-1.x86_64' "$(tail -n +2 "$f" | sha256sum | cut -c1-64)"
`,
    { mode: 0o755 },
  );
  return bin;
}

/** A throwaway key in its own GNUPGHOME, and its armoured certificate. */
function key(dir: string, name: string) {
  const home = join(dir, `gnupg-${name}`);
  mkdirSync(home, { mode: 0o700 });
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
  const cert = join(dir, `${name}.asc`);
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

describe.skipIf(!has("gpg") || !has("gpgv"))("check-signed-packages.sh", () => {
  const run = (dir: string, cert: string, tag = TAG) =>
    spawnSync(SCRIPT, [tag, join(dir, "dist"), join(dir, "signed"), cert], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
  const setup = () => {
    const dir = tempDir("vimma-signed-packages-");
    shims(dir);
    const signer = key(dir, "packages");
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
    key(dir, "other").sign(join(dist, PKG), join(signed, `${PKG}.sig`));
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
});
