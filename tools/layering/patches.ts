/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox patches (docs/security/12-agents-mcp.md section 12): the added lines of the .patch files
// under src/, which load Vimma modules from Firefox's own files that the module scan does not read.

import { posix } from "node:path";
import { LAYERS_FILE, lettersOnly, type Restricted, WIDEN } from "./model.ts";
import { codePoint, decodeEntities } from "./pages.ts";
import { OPTIONS } from "./scan.ts";
import { canonical, ROOTS, unescape, vimmaPath } from "./urls.ts";

/** The added lines of today's build-file patches that name Vimma's folder (patchErrors). */
const BUILD_LINES = new Set([
  '    "content/vimma",',
  '    "content/vimma/licence/list.html",',
  '    "content/vimma/licence/body.html",',
  '    "content/vimma/licence/product-name.html",',
]);

/**
 * A patch line as the code in it reads: JavaScript escapes (`\x47`, `\u0047`, `\u{47}`) and
 * character references decoded, and tabs and line breaks, escaped or not, dropped, as a URL
 * parser drops them.
 */
function decodeEscapes(line: string): string {
  return decodeEntities(line)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&[a-z][a-z0-9]*;/gi, "")
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a, b, c) =>
      codePoint(parseInt(String(a ?? b ?? c), 16)),
    )
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => codePoint(parseInt(octal, 8)))
    .replace(/\\[tnr]|[\t\r\n]/g, "")
    .replace(/\\/g, "");
}

/**
 * Firefox patches (the .patch files under src/) load Vimma modules by chrome:// URL from
 * Firefox's own files, which the module scan does not read; a patch is text in many languages,
 * so each added line is read as text. It fails when it names a restricted module, by any URL
 * that reaches its file (an escaped one, one with `..`, a resource:// one) or by its file name
 * alone (`base + "AgentGate.sys.mjs"`); no patch is on a restricted module's list. It fails too
 * when it holds a piece of a Vimma URL that names no file: a folder, or a URL cut short by `${`
 * or a closing quote (`"chrome://browser/content/" + …`), since a URL built from parts hides
 * which module it loads.
 */
export function patchErrors(
  patches: { file: string; text: string }[],
  restricted: Record<string, Restricted>,
): string[] {
  const errors: string[] = [];
  const files = Object.keys(restricted).map((m) => [m, lettersOnly(posix.basename(m))] as const);
  for (const { file, text } of patches) {
    /** The Firefox file the hunk changes, from its `+++ b/…` header. */
    let changed = "";
    text.split("\n").forEach((line, i) => {
      const header = /^\+\+\+ (?:b\/)?(\S+)/.exec(line);
      if (header) changed = header[1] ?? "";
      if (!line.startsWith("+") || line.startsWith("+++")) return;
      const named = new Set<string>();
      const pieces: string[] = [];
      const decoded = decodeEscapes(line);
      // A build file (moz.build, jar.mn, a manifest) that names Vimma's folder could package or
      // export its files under another URL; only the lines browser/base/moz.build adds today
      // may (the folder in DIRS, the licence pages in the about:license inputs).
      if (
        /(^|\/)(moz\.build|[^/]*\.mozbuild|[^/]*\.mn|[^/]*\.manifest)$/.test(changed) &&
        lettersOnly(decoded).includes("contentvimma") &&
        !(changed === "browser/base/moz.build" && BUILD_LINES.has(line.slice(1)))
      )
        errors.push(
          `${file}:${i + 1}: names Vimma's folder (content/vimma) in a build file; ${WIDEN}`,
        );
      // The lookbehind starts a scheme only at its first letter, so a long run of letters is
      // read once, not once per letter.
      for (const [url] of decoded.matchAll(
        /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,);]*/gi,
      )) {
        const canon = canonical(url);
        const v = vimmaPath(canon);
        const path = v && v.path !== "" ? posix.normalize(v.path) : (v?.path ?? null);
        if (path !== null && restricted[path]) named.add(path);
        else if (
          path !== null ? !/\.[a-z0-9]+$/i.test(path) : ROOTS.some((r) => r.startsWith(canon))
        )
          pieces.push(url);
      }
      if (
        /\bglobal\s*:/.test(decoded) &&
        [...decoded.matchAll(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,);]*/gi)].some(
          ([url]) => vimmaPath(canonical(url)) !== null,
        )
      )
        errors.push(`${file}:${i + 1}: ${OPTIONS}`);
      const lower = unescape(decoded).toLowerCase();
      const letters = lettersOnly(lower);
      for (const [module, base] of files) if (letters.includes(base)) named.add(module);
      if (/content\/browser\/vimma/i.test(lower))
        errors.push(
          `${file}:${i + 1}: maps or names Vimma's packaged files by their path (content/browser/vimma); only vimma/jar.mn packages them`,
        );
      for (const module of named)
        errors.push(
          `${file}:${i + 1}: names ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import, and a Firefox patch is none of them: ${restricted[module]?.review ?? ""}`,
        );
      for (const piece of pieces)
        errors.push(
          `${file}:${i + 1}: builds a Vimma URL from parts (${piece}); a Firefox patch names each Vimma module by its whole chrome:// URL, so that the check can read it`,
        );
    });
  }
  return errors;
}
