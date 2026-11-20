import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { haveTool, missingRequired } from "./have-tool.ts";

// Spec package-repositories, decision 5: the OpenPGP signer for the package repositories. A
// local RSA-4096 key stands in for Cloud KMS; every signature is checked by two independent
// OpenPGP implementations, GnuPG's gpgv and Sequoia's sqv, as apt, rpm and pacman use one or
// the other.
const SIGNER = fileURLToPath(new URL("../openpgp-kms.ts", import.meta.url));
const run = promisify(execFile);
const UID = "Vimma packages <packages@vimma.dev>";
const CREATED = "2026-11-01T00:00:00Z";

const hasGpg = haveTool("gpg") && haveTool("gpgv");
const hasSqv = haveTool("sqv");
const hasRpm = haveTool("rpmbuild") && haveTool("rpmsign") && haveTool("rpm");

let dir: string;
let keyPem: string;
let otherPem: string;
let cert: string;
let fingerprint: string;

/** A file of random bytes to sign. */
function data(): string {
  const f = join(dir, `data-${randomBytes(4).toString("hex")}.bin`);
  writeFileSync(f, randomBytes(100_000));
  return f;
}

function signer(...args: string[]) {
  return run(process.execPath, [SIGNER, ...args], { encoding: "utf8" });
}

function sh(cmd: string, args: string[], opts: { input?: string | Buffer } = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/** A binary keyring for gpgv, which does not read armour. */
function gpgvKeyring(asc: string): string {
  const out = join(dir, `keyring-${randomBytes(4).toString("hex")}.gpg`);
  const r = sh("gpg", ["--batch", "--homedir", gnupgHome(), "--dearmor", "--output", out, asc]);
  expect(r.status, r.stderr).toBe(0);
  return out;
}

function gnupgHome(): string {
  const home = mkdtempSync(join(dir, "gnupg-"));
  return home;
}

function gpgv(keyring: string, ...args: string[]) {
  return sh("gpgv", ["--homedir", gnupgHome(), "--keyring", keyring, ...args]);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vimma-openpgp-kms-"));
  const pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
  keyPem = join(dir, "key.pem");
  writeFileSync(keyPem, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  otherPem = join(dir, "other.pem");
  writeFileSync(otherPem, other.privateKey.export({ type: "pkcs8", format: "pem" }));
  cert = join(dir, "cert.asc");
  const { stdout } = await signer(
    "certify",
    "--local-key",
    keyPem,
    "--created",
    CREATED,
    "--user-id",
    UID,
    "--out",
    cert,
  );
  fingerprint = stdout.trim();
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("has every tool VIMMA_REQUIRE_TOOLS names", () => {
  expect(missingRequired(["gpg", "gpgv", "sqv", "rpm", "rpmbuild", "rpmsign"])).toEqual([]);
});

describe("certify", () => {
  it.skipIf(!hasGpg)(
    "the certificate's self-signature verifies and its fingerprint is the one printed",
    () => {
      const home = gnupgHome();
      expect(sh("gpg", ["--batch", "--homedir", home, "--import", cert]).status).toBe(0);
      const r = sh("gpg", ["--batch", "--homedir", home, "--with-colons", "--check-sigs"]);
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.split("\n");
      const pub = lines.find((l) => l.startsWith("pub:"))?.split(":") ?? [];
      expect(pub[3]).toBe("1"); // RSA
      expect(pub[2]).toBe("4096");
      expect(pub[11]).toBe("scSC"); // sign and certify
      expect(lines.find((l) => l.startsWith("fpr:"))?.split(":")[9]).toBe(fingerprint);
      expect(lines.find((l) => l.startsWith("uid:"))?.split(":")[9]).toBe(UID);
      // "sig:!" is a self-signature gpg checked and found good
      expect(lines.filter((l) => l.startsWith("sig:"))).toHaveLength(1);
      expect(lines.find((l) => l.startsWith("sig:"))).toMatch(/^sig:!:/);
      expect(lines.find((l) => l.startsWith("sig:"))?.split(":")[5]).toBe(
        String(Date.parse(CREATED) / 1000),
      );
    },
  );

  it("is the same certificate each time from the same key and time", async () => {
    const again = join(dir, "again.asc");
    await signer(
      "certify",
      "--local-key",
      keyPem,
      "--created",
      CREATED,
      "--user-id",
      UID,
      "--out",
      again,
    );
    expect(readFileSync(again, "utf8")).toBe(readFileSync(cert, "utf8"));
    const { stdout } = await signer("fingerprint", "--cert", again);
    expect(stdout.trim()).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[0-9A-F]{40}$/);
  });

  it("refuses a time without a zone", async () => {
    await expect(
      signer(
        "certify",
        "--local-key",
        keyPem,
        "--created",
        "2026-11-01T00:00:00",
        "--user-id",
        UID,
        "--out",
        join(dir, "x.asc"),
      ),
    ).rejects.toThrow(/zone/);
  });
});

describe("sign", () => {
  async function sig(format: string, input: string): Promise<string> {
    const out = `${input}.${format}.sig`;
    await signer(
      "sign",
      "--local-key",
      keyPem,
      "--cert",
      cert,
      "--format",
      format,
      "--in",
      input,
      "--out",
      out,
    );
    return out;
  }

  it.skipIf(!hasGpg || !hasSqv)("a detached signature verifies with gpgv and sqv", async () => {
    const file = data();
    const s = await sig("binary", file);
    expect(readFileSync(s).readUInt8(0) & 0x80).toBe(0x80); // a binary packet, not armour
    const g = gpgv(gpgvKeyring(cert), s, file);
    expect(g.status, g.stderr).toBe(0);
    expect(g.stderr).toContain(`Good signature from "${UID}"`);
    const q = sh("sqv", ["--keyring", cert, s, file]);
    expect(q.status, q.stderr).toBe(0);
    expect(q.stdout.trim()).toBe(fingerprint);
    // and both refuse it over other bytes
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from("x")]));
    expect(gpgv(gpgvKeyring(cert), s, file).status).not.toBe(0);
    expect(sh("sqv", ["--keyring", cert, s, file]).status).not.toBe(0);
  });

  it.skipIf(!hasGpg || !hasSqv)(
    "an armoured detached signature verifies with gpgv and sqv",
    async () => {
      const file = data();
      const s = await sig("armor", file);
      expect(readFileSync(s, "utf8")).toMatch(
        /^-----BEGIN PGP SIGNATURE-----\n\n[A-Za-z0-9+/=\n]+\n=[A-Za-z0-9+/]{4}\n-----END PGP SIGNATURE-----\n$/,
      );
      const g = gpgv(gpgvKeyring(cert), s, file);
      expect(g.status, g.stderr).toBe(0);
      const q = sh("sqv", ["--keyring", cert, s, file]);
      expect(q.status, q.stderr).toBe(0);
      expect(q.stdout.trim()).toBe(fingerprint);
    },
  );

  it.skipIf(!hasGpg || !hasSqv)(
    "a cleartext-signed InRelease verifies with gpgv and sqv and apt-style dash-escaping",
    async () => {
      const text =
        "Origin: Vimma\nLabel: Vimma\nDate: Fri, 20 Nov 2026 00:00:00 UTC\n" +
        "-----BEGIN PGP SIGNATURE-----\n- a dash line\nFrom the start\ntrailing   \nSHA256:\n" +
        " 0123abcd 1234 Packages\n";
      const file = join(dir, "Release");
      writeFileSync(file, text);
      const s = await sig("cleartext", file);
      const signed = readFileSync(s, "utf8");
      expect(signed.startsWith("-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n")).toBe(true);
      expect(signed).toContain("\n- -----BEGIN PGP SIGNATURE-----\n- - a dash line\n");
      // gpgv, as apt before 3.0 calls it, verifies the whole file and gives back the message
      const recovered = join(dir, "Release.out");
      const g = gpgv(gpgvKeyring(cert), "--output", recovered, s);
      expect(g.status, g.stderr).toBe(0);
      expect(readFileSync(recovered, "utf8")).toBe(text.replace("trailing   \n", "trailing\n"));
      // apt 3.0 splits the file itself (SplitClearSignedFile: undo the dash-escaping, a newline
      // between lines but none after the last) and gives sqv the detached signature
      const [, body, armour] =
        /^-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n([\s\S]*?)\n(-----BEGIN PGP SIGNATURE-----\n[\s\S]*)$/.exec(
          signed,
        ) ?? [];
      expect(body).toBeDefined();
      expect(armour).toBeDefined();
      const message = (body ?? "")
        .split("\n")
        .map((l) => (l.startsWith("- ") ? l.slice(2) : l))
        .join("\n");
      writeFileSync(join(dir, "msg"), message);
      writeFileSync(join(dir, "msg.sig"), armour ?? "");
      const q = sh("sqv", ["--keyring", cert, join(dir, "msg.sig"), join(dir, "msg")]);
      expect(q.status, q.stderr).toBe(0);
      expect(q.stdout.trim()).toBe(fingerprint);
      // a changed line fails
      const tampered = join(dir, "InRelease.bad");
      writeFileSync(tampered, signed.replace("Label: Vimma", "Label: Vimmb"));
      expect(gpgv(gpgvKeyring(cert), tampered).status).not.toBe(0);
    },
  );

  it.skipIf(!hasGpg)("signs standard input, as rpmsign sends the header", async () => {
    const file = data();
    const out = join(dir, "stdin.sig");
    const child = execFile(process.execPath, [
      SIGNER,
      "sign",
      "--local-key",
      keyPem,
      "--cert",
      cert,
      "--format",
      "binary",
      "--in",
      "-",
      "--out",
      out,
    ]);
    child.stdin?.end(readFileSync(file));
    await new Promise<void>((resolve, reject) =>
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))),
    );
    const g = gpgv(gpgvKeyring(cert), out, file);
    expect(g.status, g.stderr).toBe(0);
  });

  it("refuses a key that is not the certificate's", async () => {
    const file = data();
    await expect(
      signer(
        "sign",
        "--local-key",
        otherPem,
        "--cert",
        cert,
        "--format",
        "binary",
        "--in",
        file,
        "--out",
        `${file}.sig`,
      ),
    ).rejects.toThrow(/not the certificate's key/);
  });
});

describe("KMS", () => {
  it.skipIf(!hasGpg)(
    "signs through asymmetricSign with the access token, and checks the CRC32Cs",
    async () => {
      const name =
        "projects/vimma-test/locations/europe-north1/keyRings/vimma-packages/cryptoKeys/package-signing/cryptoKeyVersions/1";
      const { localSigner, crc32c } = await import("../openpgp-kms.ts");
      const local = localSigner(readFileSync(keyPem));
      const pem = local.publicKey.export({ type: "spki", format: "pem" }) as string;
      const seen: string[] = [];
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", async () => {
          seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
          if (req.headers.authorization !== "Bearer t0ken") return res.writeHead(401).end();
          if (req.method === "GET" && req.url === `/v1/${name}/publicKey`) {
            res.end(
              JSON.stringify({
                pem,
                algorithm: "RSA_SIGN_PKCS1_4096_SHA256",
                pemCrc32c: String(crc32c(Buffer.from(pem))),
                name,
              }),
            );
            return;
          }
          if (req.method === "POST" && req.url === `/v1/${name}:asymmetricSign`) {
            const j = JSON.parse(body);
            const digest = Buffer.from(j.digest.sha256, "base64");
            const ok = Number(j.digestCrc32c) === crc32c(digest);
            const s = await local.sign(digest);
            res.end(
              JSON.stringify({
                signature: s.toString("base64"),
                signatureCrc32c: String(crc32c(s)),
                verifiedDigestCrc32c: ok,
                name,
              }),
            );
            return;
          }
          res.writeHead(404).end();
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const port = (server.address() as AddressInfo).port;
        const file = data();
        const out = join(dir, "kms.sig");
        await run(
          process.execPath,
          [
            SIGNER,
            "sign",
            "--key-version",
            name,
            "--cert",
            cert,
            "--format",
            "binary",
            "--in",
            file,
            "--out",
            out,
          ],
          {
            env: {
              ...process.env,
              KMS_ACCESS_TOKEN: "t0ken",
              KMS_ENDPOINT: `http://127.0.0.1:${port}`,
            },
          },
        );
        expect(gpgv(gpgvKeyring(cert), out, file).status).toBe(0);
        expect(seen).toEqual([
          `GET /v1/${name}/publicKey Bearer t0ken`,
          `POST /v1/${name}:asymmetricSign Bearer t0ken`,
        ]);
      } finally {
        server.close();
      }
    },
  );

  it("refuses a plain-HTTP endpoint off loopback, a bad key version name and a missing token", async () => {
    const { kmsEndpoint, kmsSigner } = await import("../openpgp-kms.ts");
    expect(() => kmsEndpoint({ KMS_ENDPOINT: "http://example.com" })).toThrow(/https/);
    expect(() => kmsEndpoint({ KMS_ENDPOINT: "https://example.com/x" })).toThrow(/origin/);
    expect(kmsEndpoint({})).toBe("https://cloudkms.googleapis.com");
    await expect(kmsSigner("projects/x/../y", { KMS_ACCESS_TOKEN: "t" })).rejects.toThrow(
      /resource name/,
    );
    await expect(
      kmsSigner("projects/vimma-test/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", {}),
    ).rejects.toThrow(/KMS_ACCESS_TOKEN/);
  });
});

describe("rpm", () => {
  it.skipIf(!hasRpm || !hasGpg)(
    "rpmsign through %__gpg_sign_cmd gives a package rpm -K accepts",
    () => {
      const top = join(dir, "rpmbuild");
      for (const d of ["SPECS", "RPMS", "BUILD", "SOURCES", "SRPMS"])
        mkdirSync(join(top, d), { recursive: true });
      writeFileSync(
        join(top, "SPECS", "stub.spec"),
        "Name: vimma-stub\nVersion: 1.0.0\nRelease: 1\nSummary: stub\nLicense: MPL-2.0\nBuildArch: noarch\n" +
          "%description\nstub\n%install\nmkdir -p %{buildroot}/usr/share/vimma-stub\necho hi > %{buildroot}/usr/share/vimma-stub/hi\n" +
          "%files\n/usr/share/vimma-stub/hi\n",
      );
      const b = sh("rpmbuild", [
        "--define",
        `_topdir ${top}`,
        "-bb",
        join(top, "SPECS", "stub.spec"),
      ]);
      expect(b.status, b.stderr).toBe(0);
      const pkg = join(top, "RPMS", "noarch", "vimma-stub-1.0.0-1.noarch.rpm");
      const payload = sh("rpm", ["-qp", "--qf", "%{PAYLOADSHA256}", pkg]).stdout;
      // rpmbuild's own signing command line, with the signer in place of gpg (decision 9)
      const cmd =
        `${process.execPath} node ${SIGNER} sign --local-key ${keyPem} --cert ${cert} --format binary ` +
        "--in - --out %{shescape:%{__signature_filename}}";
      const s = sh("rpmsign", [
        "--define",
        "_gpg_name Vimma packages",
        "--define",
        `__gpg_sign_cmd ${cmd}`,
        "--addsign",
        pkg,
      ]);
      expect(s.status, s.stderr).toBe(0);
      const db = join(dir, "rpmdb");
      mkdirSync(db);
      expect(sh("rpm", ["--dbpath", db, "--import", cert]).status).toBe(0);
      const k = sh("rpm", ["--dbpath", db, "-Kv", pkg]);
      expect(k.status, k.stdout + k.stderr).toBe(0);
      expect(k.stdout).toMatch(/Header V4 RSA\/SHA256 Signature, key ID [0-9a-f]{8}: OK/);
      expect(k.stdout.toLowerCase()).toContain(fingerprint.slice(-8).toLowerCase());
      // signing touches only the header; the payload digest stays
      expect(sh("rpm", ["-qp", "--qf", "%{PAYLOADSHA256}", pkg]).stdout).toBe(payload);
    },
    60_000,
  );
});

it("imports only node: built-ins", () => {
  const src = readFileSync(SIGNER, "utf8");
  const specifiers = [
    ...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  for (const s of specifiers) expect(s).toMatch(/^node:/);
  expect(src).not.toMatch(/\bimport\s*\(/);
  expect(src).not.toMatch(/\brequire\s*\(/);
});
