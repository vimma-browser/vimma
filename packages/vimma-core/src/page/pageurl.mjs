/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The pure parts of the normal-mode page keys (spec: docs/specs/m1-actor-insert-scroll.md,
 * "Follow-up: normal-mode extras"): `gu` / `gU` (the URL one level up, or the site root), `p` /
 * `P` (what the clipboard text opens as) and `gi` (which text field a count picks).
 */

/** Clipboard text longer than this (after trimming) is refused, never truncated. */
export const MAX_CLIPBOARD_CHARS = 8192;

/** Schemes `gu` / `gU` never walk: no path to go up, or a page we must not re-target. */
const OPAQUE = new Set(["javascript:", "data:", "blob:", "view-source:"]);

/** @param {string} href */
function parse(href) {
  try {
    const u = new URL(href);
    return OPAQUE.has(u.protocol) ? null : u;
  } catch {
    return null;
  }
}

/**
 * The part of `u`'s path that is its root: `/`, a Windows drive in a file: URL (`/C:/`), or
 * null for a URL without a path hierarchy (about:config).
 * @param {URL} u
 */
function rootPath(u) {
  if (!u.pathname.startsWith("/")) return null;
  if (u.protocol === "file:") {
    const drive = /^\/[A-Za-z]:(?:\/|$)/.exec(u.pathname);
    if (drive) return `${drive[0].slice(0, 3)}/`;
  }
  return "/";
}

/**
 * `u` without its query and hash, its path cut to `keep(segments)`; null if that is `href`.
 * @param {string} href
 * @param {(segments: string[]) => string[]} keep
 */
function cut(href, keep) {
  const u = parse(href);
  if (!u) return null;
  const before = u.href;
  u.search = "";
  u.hash = "";
  const root = rootPath(u);
  if (root !== null) {
    const kept = keep(u.pathname.slice(root.length).split("/").filter(Boolean));
    u.pathname = root + kept.map((s) => `${s}/`).join("");
  }
  return u.href === before ? null : u.href;
}

/**
 * `gu`: the URL `levels` path segments up (a trailing slash is not a level), without its query
 * and hash. At the root only those go; null when nothing changes or the URL has no path to walk.
 * @param {string} href
 * @param {number} [levels]  a count; anything below 1 is 1
 * @returns {string | null}
 */
export function urlUp(href, levels = 1) {
  const n = Number.isFinite(levels) && levels >= 1 ? Math.floor(levels) : 1;
  return cut(href, (segments) => segments.slice(0, Math.max(0, segments.length - n)));
}

/**
 * `gU`: the site root (`/`, or a file: URL's drive), without query and hash; null if already there.
 * @param {string} href
 * @returns {string | null}
 */
export function urlRoot(href) {
  return cut(href, () => []);
}

/**
 * @typedef {{ kind: "empty" } | { kind: "refused", reason: string }
 *   | { kind: "url", text: string } | { kind: "search", text: string }} ClipboardOpen
 */

/** Schemes Vimma never opens, also behind view-source: (as the URL parser sees them). */
// eslint-disable-next-line no-control-regex -- the URL parser skips control characters here too
const REFUSED = /^(?:view-source:[\s\u0000-\u001f]*)*(javascript|data):/i;

/**
 * The one check every Vimma open of text from someone else goes through (`p` / `P`, `:open`,
 * `:tabnew`): `"javascript"` or `"data"` when a URL parser would read `text` as such a URL, also
 * behind `view-source:`, else null. The parser drops tabs and newlines anywhere, leading spaces
 * and C0 controls, and ignores case, so this does too. A `javascript:` URL runs script; a
 * `data:` one, loaded with the system principal, is a whole page of the sender's choosing.
 * @param {string} text
 * @returns {"javascript" | "data" | null}
 */
export function refusedScheme(text) {
  // eslint-disable-next-line no-control-regex -- leading C0 controls are what the parser strips
  const asUrl = text.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
  const scheme = REFUSED.exec(asUrl)?.[1]?.toLowerCase();
  return scheme === "javascript" || scheme === "data" ? scheme : null;
}

/**
 * What clipboard text opens as with `p` / `P`. The text is untrusted: control characters go,
 * whitespace is trimmed and collapsed, text over MAX_CLIPBOARD_CHARS is refused, and so is
 * anything the URL parser would read as a `javascript:` or `data:` URL (it drops tabs and
 * newlines anywhere and ignores case, so the check does too). One word with a scheme, a dot or a
 * port is a URL; anything else is a search with the default engine.
 * @param {string} raw
 * @returns {ClipboardOpen}
 */
export function classifyClipboard(raw) {
  if (typeof raw !== "string") return { kind: "empty" };
  // eslint-disable-next-line no-control-regex -- clipboard text: control characters are dropped
  const clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const flat = clean.trim().replace(/\s+/g, " ");
  if (!flat) return { kind: "empty" };
  if (flat.length > MAX_CLIPBOARD_CHARS) {
    return { kind: "refused", reason: `over ${MAX_CLIPBOARD_CHARS} characters` };
  }
  const scheme = refusedScheme(raw);
  if (scheme) return { kind: "refused", reason: `${scheme}: URL` };
  if (!flat.includes(" ") && looksLikeUrl(flat)) return { kind: "url", text: flat };
  return { kind: "search", text: flat };
}

/**
 * One word that a browser would load: it has a scheme (`https:`, `about:`, `localhost:3000`),
 * or a dot between characters (`example.com`, `bücher.example/path`).
 * @param {string} word
 */
function looksLikeUrl(word) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(word)) return true;
  const host = word.split(/[/?#]/, 1)[0] ?? "";
  return /[^.]\.[^.]/.test(host);
}

/**
 * `gi`: the 0-based index of the text field a count picks among `total` (Vim's `3gi`: the third),
 * clamped to the last; -1 with none.
 * @param {number | undefined} count
 * @param {number} total
 */
export function inputIndex(count, total) {
  if (total <= 0) return -1;
  return Math.min(Math.max(count ?? 1, 1), total) - 1;
}
