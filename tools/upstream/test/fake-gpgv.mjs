import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";

// A stand-in for gpgv in the tests of the shell scripts that call verify-sha512.py
// (source-check.sh, firefox-source.sh). Their fixture tarballs are made by the test, so no
// SHA512SUMS listing them can carry Mozilla's real signature. The real signature check, against
// the pinned key and Mozilla's own files, is tested in test_verify_sha512.py; these tests check
// that the scripts fetch SHA512SUMS.asc, pass it on, and fail closed when it is not good.
//
// The stub prints the status lines gpgv prints for a good signature by Mozilla's current subkey
// when the signature file is fakeSignature() of the signed file, and BADSIG otherwise.
// fakeSignature() is one OpenPGP signature packet (new format, tag 2) whose body names the
// signed file's hash, so it passes verify-sha512.py's "signature packets only" check; the stub
// reads the body after the 2-byte packet header.

const MOZILLA = "14F26682D0916CDD81E37B6D61B7B526D98F0353";
const SUBKEY = "827E658608679618CD349F93678E455D76767AA3";

const STUB = `#!/usr/bin/env bash
# fake gpgv: ... -- SIGNATURE DATA
set -euo pipefail
sig=\${@: -2:1}
data=\${@: -1}
echo "[GNUPG:] NEWSIG"
if [ "$(tail -c +3 "$sig")" = "fake-signature sha512:$(sha512sum < "$data" | cut -d' ' -f1)" ]; then
  echo "[GNUPG:] GOODSIG 678E455D76767AA3 Mozilla Software Releases <release@mozilla.com>"
  echo "[GNUPG:] VALIDSIG ${SUBKEY} 2026-10-08 1791400000 0 4 0 1 10 00 ${MOZILLA}"
else
  echo "[GNUPG:] BADSIG 678E455D76767AA3 Mozilla Software Releases <release@mozilla.com>"
  exit 1
fi
`;

/** The fake signature packet over `data` that the stub accepts. @param {Buffer | string} data */
export function fakeSignature(data) {
  const body = Buffer.from(
    `fake-signature sha512:${createHash("sha512").update(data).digest("hex")}`,
  );
  return Buffer.concat([Buffer.from([0xc2, body.length]), body]);
}

/** Writes `<sums>.asc` with the fake signature over the file `sums`. @param {string} sums */
export function fakeSign(sums) {
  writeFileSync(`${sums}.asc`, fakeSignature(readFileSync(sums)));
}

/**
 * An environment whose PATH finds the fake gpgv first.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function withFakeGpgv(env) {
  const bin = join(tempDir("fake-gpgv-"), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gpgv"), STUB);
  chmodSync(join(bin, "gpgv"), 0o755);
  return { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ""}` };
}
