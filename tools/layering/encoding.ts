/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Encoding (docs/security.md section 12): every file the check reads must be the UTF-8 it is read
// as, so that a file Firefox decodes otherwise is not read as something harmless.

/**
 * Why a file's bytes are not what the check reads them as, if they are not: a byte order mark
 * (a parser would decode UTF-16, or skip it), a NUL byte, or bytes that are not UTF-8. The
 * check reads every file as UTF-8, so a file must be exactly that.
 * @param bytes  the file's contents
 * @param label  the file, for the error
 */
export function encodingErrors(bytes: Uint8Array, label: string): string[] {
  const why =
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
      ? "starts with a byte order mark"
      : bytes.includes(0)
        ? "holds a NUL byte"
        : (() => {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              return null;
            } catch {
              return "is not valid UTF-8";
            }
          })();
  return why === null
    ? []
    : [
        `${label}: ${why}; the check reads UTF-8 without a byte order mark, as Firefox reads these files only then`,
      ];
}
