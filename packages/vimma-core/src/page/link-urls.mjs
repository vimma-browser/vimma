/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `gy` (docs/specs/copy-link-url.md): the parent's check of the link URLs a frame found under
// the caret, the selection or the focused block, and what the status bar says. The reply comes
// from a content process and is untrusted (Security and privacy).

import { stripInvisible } from "./pdf.mjs";

/** At most this many links are taken from one reply (decision 3). */
export const LINK_URLS_MAX = 100;
/**
 * A longer URL is not copied (decisions 3 and 6): HINT_REPLY_MAX_HREF, the cap of a hint's
 * link, written out because hints.mjs imports this module.
 */
export const LINK_URL_MAX = 8192;

export const NO_LINK = "no link here";
export const NOT_A_SCRIPT = "link runs a script: not copied";
export const TOO_LONG = "link too long to copy";

/**
 * A frame's reply: the URLs it found, in document order, and how many links it left out
 * because they run a script or are over the cap.
 * @typedef {{ urls: string[], scripts: number, long: number }} LinkUrlsReply
 */

/**
 * Whether `url` runs a script when opened: the `javascript:` scheme (decision 5).
 * @param {string} url
 */
export function isScriptUrl(url) {
  return URL.parse(url)?.protocol === "javascript:";
}

/** @param {unknown} n */
const isCount = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/**
 * A frame's reply of link URLs from a content process, which may be compromised: a fresh copy
 * when it is an object with an array of at most LINK_URLS_MAX strings and two counts, else null.
 * @param {unknown} value
 * @returns {LinkUrlsReply | null}
 */
export function parseLinkUrlsReply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { urls, scripts, long } = /** @type {Record<string, unknown>} */ (value);
  if (!Array.isArray(urls) || urls.length > LINK_URLS_MAX) return null;
  if (!isCount(scripts) || !isCount(long)) return null;
  if (!urls.every((u) => typeof u === "string")) return null;
  return {
    urls: [.../** @type {string[]} */ (urls)],
    scripts: /** @type {number} */ (scripts),
    long: /** @type {number} */ (long),
  };
}

/**
 * What `gy` copies from a frame's reply and what the status bar says. Only a reply that
 * parseLinkUrlsReply accepts is read; each string loses its control
 * and format characters, must parse as a URL, is written as the parser writes it, and is dropped
 * when it is a `javascript:` URL or over LINK_URL_MAX. Several URLs are copied one per line,
 * each once, in the order given (decision 13).
 * @param {unknown} reply
 * @returns {{ text: string | null, notice: string }}  text null: nothing is copied
 */
export function linkYank(reply) {
  const parsed = parseLinkUrlsReply(reply);
  if (!parsed) return { text: null, notice: NO_LINK };
  let script = parsed.scripts > 0;
  let tooLong = parsed.long > 0;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of parsed.urls) {
    if (raw.length > LINK_URL_MAX) {
      tooLong = true;
      continue;
    }
    const url = URL.parse(stripInvisible(raw));
    if (!url) continue;
    if (url.protocol === "javascript:") {
      script = true;
      continue;
    }
    if (url.href.length > LINK_URL_MAX) {
      tooLong = true;
      continue;
    }
    seen.add(url.href);
  }
  const found = [...seen];
  if (found.length === 1) return { text: found[0] ?? "", notice: `yanked ${found[0]}` };
  if (found.length > 1) return { text: found.join("\n"), notice: `yanked ${found.length} links` };
  return { text: null, notice: script ? NOT_A_SCRIPT : tooLong ? TOO_LONG : NO_LINK };
}
