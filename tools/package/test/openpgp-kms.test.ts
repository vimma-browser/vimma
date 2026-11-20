import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** /tmp where it exists, which every Linux and macOS has; the temp dir otherwise. */
const GNUPG_PARENT = existsSync("/tmp") ? "/tmp" : tmpdir();

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

function sh(cmd: string, args: string[], opts: { input?: string | Buffer; cwd?: string } = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/** A binary keyring for gpgv, which does not read armour. */
function gpgvKeyring(asc: string): string {
  const out = join(dir, `keyring-${randomBytes(4).toString("hex")}.gpg`);
  const r = sh("gpg", [
    "--batch",
    "--no-autostart",
    "--homedir",
    gnupgHome(),
    "--dearmor",
    "--output",
    out,
    asc,
  ]);
  expect(r.status, r.stderr).toBe(0);
  return out;
}

const homes: string[] = [];

/**
 * A fresh GnuPG home under a short path: gpg looks for its agent's socket in the home, a Unix
 * socket path has at most 104 (macOS) or 108 (Linux) bytes, and gpg 2.4 exits 2 when the path is
 * longer ("can't connect to the gpg-agent: File name too long"), as under macOS's temp dirs.
 */
function gnupgHome(): string {
  const home = mkdtempSync(join(GNUPG_PARENT, "vimma-gpg-"));
  homes.push(home);
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

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

it("has every tool VIMMA_REQUIRE_TOOLS names", () => {
  expect(missingRequired(["gpg", "gpgv", "sqv", "rpm", "rpmbuild", "rpmsign"])).toEqual([]);
});

describe("certify", () => {
  it.skipIf(!hasGpg)(
    "the certificate's self-signature verifies and its fingerprint is the one printed",
    () => {
      const home = gnupgHome();
      // --no-autostart: importing a public key needs no gpg-agent, and starting one fails where
      // the homedir's socket path is too long (macOS's temp dirs) or no agent is installed
      const gpg = ["--batch", "--no-autostart", "--homedir", home];
      const imported = sh("gpg", [...gpg, "--import", cert]);
      expect(imported.status, imported.stderr).toBe(0);
      const r = sh("gpg", [...gpg, "--with-colons", "--check-sigs"]);
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
  const NAME =
    "projects/vimma-test/locations/europe-north1/keyRings/vimma-packages/cryptoKeys/package-signing/cryptoKeyVersions/1";
  const TOKEN = "ya29.s3cret-t0ken-for-the-test";

  /** What the fake KMS answers, each field a way a real or a forged answer could be wrong. */
  interface Fake {
    pem?: string;
    algorithm?: string;
    protectionLevel?: string;
    pemCrc32c?: "omit" | "wrong";
    verifiedDigestCrc32c?: boolean;
    name?: string;
    signatureCrc32c?: "omit" | "wrong";
    signWith?: string; // a PEM private key other than the certificate's
  }

  /** Runs the signer against a fake KMS; resolves with its exit code, stderr and requests. */
  async function signThroughFake(fake: Fake, out: string) {
    const { localSigner, crc32c } = await import("../openpgp-kms.ts");
    const local = localSigner(readFileSync(keyPem));
    const signer = fake.signWith ? localSigner(readFileSync(fake.signWith)) : local;
    const pem = fake.pem ?? (local.publicKey.export({ type: "spki", format: "pem" }) as string);
    const crc = (b: Buffer, how?: "omit" | "wrong") =>
      how === "omit" ? undefined : String(how === "wrong" ? crc32c(b) ^ 1 : crc32c(b));
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
        if (req.method === "GET" && req.url === `/v1/${NAME}/publicKey`) {
          res.end(
            JSON.stringify({
              pem,
              algorithm: fake.algorithm ?? "RSA_SIGN_PKCS1_4096_SHA256",
              pemCrc32c: crc(Buffer.from(pem), fake.pemCrc32c),
              protectionLevel: fake.protectionLevel ?? "HSM",
              name: NAME,
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === `/v1/${NAME}:asymmetricSign`) {
          const j = JSON.parse(body);
          const digest = Buffer.from(j.digest.sha256, "base64");
          const s = await signer.sign(digest);
          res.end(
            JSON.stringify({
              signature: s.toString("base64"),
              signatureCrc32c: crc(s, fake.signatureCrc32c),
              verifiedDigestCrc32c:
                fake.verifiedDigestCrc32c ?? Number(j.digestCrc32c) === crc32c(digest),
              name: fake.name ?? NAME,
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
      const args = [
        ...["sign", "--key-version", NAME, "--cert", cert, "--format", "binary"],
        ...["--in", file, "--out", out],
      ];
      const env = {
        ...process.env,
        KMS_ACCESS_TOKEN: TOKEN,
        KMS_ENDPOINT: `http://127.0.0.1:${port}`,
      };
      const r = await run(process.execPath, [SIGNER, ...args], { env }).then(
        (ok) => ({ code: 0, stderr: ok.stderr }),
        (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr }),
      );
      return { ...r, seen };
    } finally {
      server.close();
    }
  }

  let file: string;
  beforeAll(() => {
    file = join(dir, "kms-input.bin");
    writeFileSync(file, randomBytes(10_000));
  });

  it.skipIf(!hasGpg)(
    "signs through asymmetricSign with the access token, and checks the CRC32Cs",
    async () => {
      const out = join(dir, "kms.sig");
      const r = await signThroughFake({}, out);
      expect(r.code, r.stderr).toBe(0);
      expect(gpgv(gpgvKeyring(cert), out, file).status).toBe(0);
      expect(r.seen).toEqual([
        `GET /v1/${NAME}/publicKey Bearer ${TOKEN}`,
        `POST /v1/${NAME}:asymmetricSign Bearer ${TOKEN}`,
      ]);
    },
  );

  it.each<[string, () => Fake, RegExp]>([
    ["an unconfirmed digest CRC32C", () => ({ verifiedDigestCrc32c: false }), /confirm the digest/],
    ["another key version's name", () => ({ name: NAME.replace(/1$/, "2") }), /signed with/],
    ["no signature CRC32C", () => ({ signatureCrc32c: "omit" }), /signature's CRC32C/],
    ["a wrong signature CRC32C", () => ({ signatureCrc32c: "wrong" }), /signature's CRC32C/],
    ["another algorithm", () => ({ algorithm: "RSA_SIGN_PSS_4096_SHA256" }), /algorithm/],
    ["a software key", () => ({ protectionLevel: "SOFTWARE" }), /HSM/],
    ["no public key CRC32C", () => ({ pemCrc32c: "omit" }), /public key's CRC32C/],
    ["a wrong public key CRC32C", () => ({ pemCrc32c: "wrong" }), /public key's CRC32C/],
    [
      "a public key that is not the certificate's",
      () => ({
        pem: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
          type: "spki",
          format: "pem",
        }) as string,
      }),
      /not the certificate's key/,
    ],
    ["a signature by another key", () => ({ signWith: otherPem }), /does not verify/],
  ])("refuses %s, writes nothing and never prints the token", async (_, fake, why) => {
    const out = join(dir, `kms-refused-${randomBytes(4).toString("hex")}.sig`);
    const r = await signThroughFake(fake(), out);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(r.stderr).not.toContain(TOKEN);
    expect(existsSync(out)).toBe(false);
  });

  it("talks only to Cloud KMS, or to a fake on a literal loopback address", async () => {
    const { kmsEndpoint } = await import("../openpgp-kms.ts");
    expect(kmsEndpoint({})).toBe("https://cloudkms.googleapis.com");
    for (const ok of [
      "https://cloudkms.googleapis.com",
      "https://cloudkms.europe-north1.rep.googleapis.com",
      "http://127.0.0.1:8443",
      "http://[::1]:8443",
    ]) {
      expect(kmsEndpoint({ KMS_ENDPOINT: ok })).toBe(ok);
    }
    for (const bad of [
      "https://example.com",
      "https://cloudkms.googleapis.com.example.com",
      "https://evil.googleapis.com",
      "https://cloudkms.googleapis.com:8443",
      "https://user:pw@cloudkms.googleapis.com",
      "https://cloudkms.googleapis.com/",
      "https://cloudkms.googleapis.com/v1",
      "https://CLOUDKMS.googleapis.com",
      "http://cloudkms.googleapis.com",
      "http://localhost:8443",
      "http://127.1:8443",
      "http://0x7f.1:8443",
      "http://2130706433:8443",
      "http://user@127.0.0.1:8443",
      "https://127.0.0.1:8443",
    ]) {
      expect(() => kmsEndpoint({ KMS_ENDPOINT: bad }), bad).toThrow(/KMS_ENDPOINT/);
    }
  });

  it("refuses a bad key version name and a missing token", async () => {
    const { kmsSigner } = await import("../openpgp-kms.ts");
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
      // rpmbuild's own signing command line, with the signer in place of gpg (decision 9), in
      // one form for rpm 4.18 (Ubuntu 24.04's, which the release signs with) and rpm 6.0:
      // - rpm 4.18 runs the first word with the words from the third on as its arguments (its
      //   own macro is "<gpg path> gpg <options>"), rpm 6.0 runs the words as written, and
      //   `/usr/bin/env env <node>` runs node either way;
      // - rpm 4.18 writes the header to standard input and names the output in
      //   %__signature_filename, rpm 6.0 passes both files as the macro's arguments %1 and %2.
      const cmd =
        `/usr/bin/env env ${process.execPath} ${SIGNER} sign --local-key ${keyPem} --cert ${cert} ` +
        "--format binary --in %{?1:%{shescape:%{1}}}%{!?1:-} " +
        "--out %{?2:%{shescape:%{2}}}%{!?2:%{shescape:%{__signature_filename}}}";
      const s = sh(
        "rpmsign",
        [
          "--define",
          "_gpg_name Vimma packages",
          "--define",
          `__gpg_sign_cmd() ${cmd}`,
          "--addsign",
          pkg,
        ],
        {
          // a temp dir, so a command line that names a file rpm left unexpanded writes it there,
          // never into the checkout
          cwd: mkdtempSync(join(dir, "rpmsign-cwd-")),
        },
      );
      expect(s.status, s.stderr).toBe(0);
      const db = join(dir, "rpmdb");
      mkdirSync(db);
      expect(sh("rpm", ["--dbpath", db, "--import", cert]).status).toBe(0);
      const k = sh("rpm", ["--dbpath", db, "-Kv", pkg]);
      expect(k.status, k.stdout + k.stderr).toBe(0);
      // rpm 4.18: "Header V4 RSA/SHA256 Signature, key ID <id>: OK"; rpm 6.0 names the
      // fingerprint
      expect(k.stdout).toMatch(
        /Header (?:OpenPGP )?V4 RSA\/SHA256 [Ss]ignature, key (?:ID|fingerprint):? [0-9a-f]+: OK/,
      );
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
