/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Load positions and URL cleaning (docs/security.md section 12): a specifier read as Firefox
// reads it, and the Vimma module or folder it names, so that no spelling of a URL hides a load.

import { posix } from "node:path";
import { URL_PREFIX } from "./model.ts";

/** The URL prefixes that name a file of vimma/: its chrome:// URL and its source path URL. */
const PREFIXES = [URL_PREFIX, "moz-src:///browser/base/content/vimma/"];

/**
 * Other URLs that reach the same files. browser.manifest maps chrome://browser/content/ to
 * chrome/browser/content/browser/ of the app's omni.ja, which resource:/// and resource://app/
 * name too, and resource://gre/ reaches it in an unpackaged build. The module loader accepts
 * resource:// and keys each module by its URL, so one of these loads a second copy of the
 * module, with its own state: for the agent gate, its own questions and grants. A string with
 * `content/browser/vimma` in its path, whatever its root, is refused (ALIAS).
 */
const ALIAS_ROOTS = [
  "resource:///chrome/browser/content/browser/vimma/",
  "resource://app/chrome/browser/content/browser/vimma/",
  "resource://gre/browser/chrome/browser/content/browser/vimma/",
];

type Resolved = { to: string } | "partial" | "unresolved" | "alias" | null;

/** Each `%XX` escape decoded: Firefox reads an escaped path as the file it names. */
export const unescape = (text: string) =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * A URL as Firefox reads it (net_FilterURIString, by way of nsStandardURL::SetSpecWithEncoding):
 * tab, CR and LF dropped anywhere, and bytes up to 0x20 dropped at either end.
 */
export const clean = (spec: string) => {
  const text = spec.replace(/[\t\r\n]/g, "");
  let start = 0;
  let end = text.length;
  while (start < end && isControl(text, start)) start++;
  while (end > start && isControl(text, end - 1)) end--;
  return text.slice(start, end);
};

/** Whether the character at `i` is a control character or a space (code 0x20 or below). */
const isControl = (text: string, i: number) => text.charCodeAt(i) <= 0x20;

/** A path's `.` and `..` segments resolved, as a URL parser does; `//` stays. */
function removeDots(path: string): string {
  const out: string[] = [];
  const segments = path.split("/");
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "." || seg === "..") {
      if (seg === ".." && out.length > 1) out.pop();
      if (last) out.push("");
    } else out.push(seg);
  });
  return out.join("/");
}

/**
 * The URL a specifier loads, as Firefox keys the module (scheme and host in lower case, dot
 * segments resolved, nothing decoded, query and fragment kept). A relative specifier is
 * resolved against the importer's chrome:// URL; anything else that is no URL gives null.
 */
export function loadedUrl(spec: string, file: string, relative: boolean): string | null {
  let url = clean(spec);
  if (relative && (url.startsWith("./") || url.startsWith("../")))
    url = `${URL_PREFIX}${posix.dirname(file) === "." ? "" : `${posix.dirname(file)}/`}${url}`;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)([\s\S]*)$/i.exec(url);
  if (!m) return null;
  const [, scheme = "", host = "", path = "", rest = ""] = m;
  return `${scheme.toLowerCase()}${host.toLowerCase()}${removeDots(path)}${rest}`;
}

/**
 * A specifier as the module loader keys it, near enough to compare: without a query or a
 * fragment (the same file), the scheme and host in lower case, escapes decoded and `.` and `..`
 * segments resolved. A string that is no URL keeps its dots, for posix.join to resolve.
 */
export function canonical(spec: string): string {
  const bare = unescape(clean(spec).replace(/[?#][\s\S]*$/, ""));
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i.exec(bare);
  if (!m) return bare;
  const [, scheme = "", host = "", path = ""] = m;
  return `${scheme.toLowerCase()}${host.toLowerCase()}${path && posix.normalize(path)}`;
}

/**
 * A canonical URL's path under vimma/, and whether it reaches it through another root than a
 * Vimma prefix (ALIAS_ROOTS); null for a URL outside vimma/.
 */
export function vimmaPath(canon: string): { path: string; alias: boolean } | null {
  for (const prefix of PREFIXES)
    if (canon.startsWith(prefix)) return { path: canon.slice(prefix.length), alias: false };
  // Any string, with a scheme or not: a root can be joined to such a tail at run time.
  const m = /(?:^|\/)content\/browser\/vimma(\/|$)/i.exec(canon);
  if (!m) return null;
  return { path: canon.slice(m.index + m[0].length), alias: true };
}

/**
 * What a specifier names: a Vimma module or folder (relative to vimma/), "partial" for a URL
 * cut short before its folder, "alias" for one reached through a resource:// URL (ALIAS_ROOTS),
 * or null for anything else (a Firefox module, a page, a data file). A path ending inside a
 * folder without a file extension names that folder: a base the importer appends a module name
 * to. A relative specifier counts only where a module is imported; elsewhere a string like
 * "./x.mjs" is just text.
 */
export function resolveSpec(spec: string, file: string, relativeAllowed: boolean): Resolved {
  const canon = canonical(spec);
  const named = vimmaPath(canon);
  if (named?.alias) return "alias";
  let path = named ? named.path : null;
  if (path === null && relativeAllowed && (canon.startsWith("./") || canon.startsWith("../")))
    path = posix.join(posix.dirname(file), canon);
  if (path === null) return /content\/vimma\//i.test(canon) ? "unresolved" : null;
  if (path !== "") path = posix.normalize(path);
  if (path === ".." || path.startsWith("../")) return null;
  if (/\.m?js$/.test(path)) return { to: path };
  const slash = path.indexOf("/");
  if (slash < 0) return "partial";
  if (/\.[a-z0-9]+$/i.test(path.slice(slash + 1))) return null;
  return { to: path.slice(0, slash + 1) };
}

/** Every root a URL to a file of vimma/ starts with. */
export const ROOTS = [...PREFIXES, ...ALIAS_ROOTS];
