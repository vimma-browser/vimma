/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What an agent gets back from vimma_api_call (docs/specs/agent-apis.md, behaviours 8, 11, 12 and
 * 14; decision 13): a header line, and the reply with only the fields the agent asked for, cut
 * at the cap, with the service's token replaced by `[token]`, inside the untrusted-content
 * delimiters (M7).
 *
 * A reply is text from the network that any user of the service may have written, so: JSON is
 * read only through own properties and rebuilt with fixed keys defined, never assigned; every
 * walk is bounded by the fields' depth and MAX_NESTING; a reply the engine cannot parse or
 * serialise (nested past its limits) is treated as text; the token is replaced after Unicode
 * folding and before the cut, so neither a look-alike spelling nor a cut leaves any of it; and
 * the header shows only keys that are printable and short.
 */

import { wrapUntrusted } from "../agent/agent.mjs";

/** The cap of a reply when neither the service nor the agent sets one (decision 13). */
export const DEFAULT_MAX_CHARS = 20_000;
/** The smallest and largest cap `max_chars` may set (behaviour 3). */
export const MIN_MAX_CHARS = 1_000;
export const MAX_MAX_CHARS = 500_000;
/** The largest reply read (behaviour 14); the host stops the download there. */
export const MAX_REPLY_BYTES = 5 * 1024 * 1024;
/** What every occurrence of the token becomes (behaviour 8). */
export const TOKEN_MARK = "[token]";
/** Fields one call may name, segments in one field and characters in one field. */
export const MAX_FIELDS = 50;
export const MAX_FIELD_DEPTH = 10;
export const MAX_FIELD_CHARS = 200;

/** Arrays inside arrays that field selection walks; deeper ones become null. */
const MAX_NESTING = 32;
/** Keys the header lists before "+N more". */
const SHAPE_KEYS = 20;
/**
 * A key the header may show, outside the delimiters: letters, digits and `_ . -`, at most 24
 * characters, so a key can neither look like a delimiter nor carry more than a few words.
 */
const SHOWN_KEY = /^[\w.-]{1,24}$/;
/**
 * A look-alike delimiter's start, with or without its closing `>`. wrapUntrusted's own pattern
 * looks ahead for that `>` and so scans to the end of the text at each unclosed one, which is
 * quadratic at a 500,000-character cap; broken here first with a zero-width space, those
 * places no longer match it.
 */
const LOOK_ALIKE_START = /<(?=\s{0,40}\/?\s{0,40}untrusted)/gi;
const MEDIA = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

/** A call's arguments or reply that the shaper refuses, with a message for the agent. */
export class ApiReplyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ApiReplyError";
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `n` with thousands separated by commas, as the spec's examples write numbers. */
const fmt = (/** @type {number} */ n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The fields an agent named, as paths of segments, checked before anything is sent: at most
 * MAX_FIELDS distinct dotted paths of printable characters, each segment non-empty.
 * @param {unknown} fields  `fields` as the agent sent it; unset means the whole reply
 * @returns {string[][] | null}
 * @throws {ApiReplyError}
 */
export function parseFields(fields) {
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields)) throw new ApiReplyError("fields must be a list of dotted paths.");
  if (fields.length > MAX_FIELDS) throw new ApiReplyError(`fields may name at most ${MAX_FIELDS}.`);
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const f of fields) {
    if (
      typeof f !== "string" ||
      f.length === 0 ||
      f.length > MAX_FIELD_CHARS ||
      !/^[\x20-\x7e]+$/.test(f)
    ) {
      throw new ApiReplyError(
        `Each field must be a dotted path of at most ${MAX_FIELD_CHARS} printable characters.`,
      );
    }
    const path = f.split(".");
    if (path.some((s) => s === "") || path.length > MAX_FIELD_DEPTH) {
      throw new ApiReplyError(
        `Each field must be names joined by dots, at most ${MAX_FIELD_DEPTH} deep, such as user.login.`,
      );
    }
    out.set(f, path);
  }
  return [...out.values()];
}

/**
 * Sets `obj[key]` as an own property even when `key` is `__proto__`.
 * @param {object} obj @param {string} key @param {unknown} value
 */
function define(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The parts of `value` the paths name, applied to every element of an array at any depth, so
 * that `user.login` keeps each issue's login (behaviour 11). A missing path is left out; a
 * primitive where a path goes on keeps nothing (null in an array, to keep the places).
 * @param {unknown} value @param {string[][]} paths @param {number} nesting
 * @returns {unknown}
 */
function pick(value, paths, nesting) {
  if (Array.isArray(value)) {
    return nesting >= MAX_NESTING ? null : value.map((v) => pick(v, paths, nesting + 1) ?? null);
  }
  if (!isObj(value)) return undefined;
  /** @type {Map<string, string[][]>} */
  const byKey = new Map();
  for (const [first = "", ...rest] of paths) {
    const list = byKey.get(first) ?? [];
    list.push(rest);
    byKey.set(first, list);
  }
  const out = {};
  for (const [key, rests] of byKey) {
    if (!Object.hasOwn(value, key)) continue;
    const child = value[key];
    const kept = rests.some((r) => r.length === 0) ? child : pick(child, rests, nesting);
    if (kept !== undefined) define(out, key, kept);
  }
  return out;
}

/**
 * `value` with only the parts `paths` names; the value itself without paths, or when it is not
 * an object or an array.
 * @param {unknown} value @param {string[][] | null} paths
 */
export function selectFields(value, paths) {
  if (!paths) return value;
  const kept = pick(value, paths, 0);
  return kept === undefined ? value : kept;
}

/**
 * The cap of one reply: the agent's `max_chars` within the service's (behaviour 3), and never
 * below MIN_MAX_CHARS.
 * @param {number | undefined} serviceMax  the service's `max_chars`, already validated
 * @param {unknown} asked  the agent's `max_chars`
 * @throws {ApiReplyError} when `asked` is not a positive whole number
 */
export function replyCap(serviceMax, asked) {
  const ceiling = Math.min(serviceMax ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
  if (asked === undefined) return ceiling;
  if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 1) {
    throw new ApiReplyError("max_chars must be a positive whole number.");
  }
  return Math.max(MIN_MAX_CHARS, Math.min(asked, ceiling));
}

/**
 * A Content-Type's media type in lower case, such as `application/json`; "" when there is none
 * or it is not a plain `type/subtype`.
 * @param {unknown} contentType
 */
export function mediaType(contentType) {
  if (typeof contentType !== "string") return "";
  const media = (contentType.slice(0, 200).split(";")[0] ?? "").trim().toLowerCase();
  return MEDIA.test(media) ? media : "";
}

const isJson = (/** @type {string} */ media) =>
  /^application\/(?:[\w.!#$&^-]*\+)?json$/.test(media);
const isText = (/** @type {string} */ media) =>
  media.startsWith("text/") || /^application\/(?:[\w.!#$&^-]*\+)?xml$/.test(media);

/**
 * The spellings of a token a reply may echo: as given and folded, JSON-escaped (with `\/` too)
 * and percent-encoded in upper and lower case. Escapes beyond these (HTML entities, `\u` in JSON
 * that does not parse) are not undone.
 * @param {string} token
 */
function spellings(token) {
  const folded = token.normalize("NFKC");
  const all = new Set();
  for (const t of [token, folded]) {
    const json = JSON.stringify(t).slice(1, -1);
    const pct = encodeURIComponent(t);
    for (const v of [
      t,
      json,
      json.replaceAll("/", "\\/"),
      pct,
      pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    ]) {
      all.add(v);
    }
  }
  return [...all].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * `text` with every spelling of `token` replaced by TOKEN_MARK. If any is left after that
 * (only a token that contains the mark itself could do it), nothing of the text is kept.
 * @param {string} text @param {string | undefined} token
 */
function scrub(text, token) {
  if (!token) return text;
  let out = text;
  const forms = spellings(token);
  for (const form of forms) out = out.replaceAll(form, TOKEN_MARK);
  return forms.some((f) => out.includes(f))
    ? "(withheld: the reply contains the service's token)"
    : out;
}

/**
 * `s` cut to `max` UTF-16 units, never splitting a surrogate pair.
 * @param {string} s @param {number} max
 */
function cutAt(s, max) {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Keys as the header lists them: shown when printable and short, the rest counted.
 * @param {Record<string, unknown>} obj
 */
function keyList(obj) {
  const keys = Object.keys(obj);
  const shown = [];
  let hidden = 0;
  for (const k of keys) {
    if (shown.length < SHAPE_KEYS && SHOWN_KEY.test(k)) {
      const v = obj[k];
      shown.push(Array.isArray(v) ? `${k} (array of ${fmt(v.length)})` : k);
    } else hidden++;
  }
  return `${shown.join(", ")}${hidden ? `${shown.length ? ", " : ""}+${fmt(hidden)} more` : ""}`;
}

/**
 * A JSON value's shape for the header of a cut reply (behaviour 12): its top-level keys and the
 * lengths of the arrays among them, or an array's length and its first object's keys.
 * @param {unknown} value
 */
function shapeOf(value) {
  if (Array.isArray(value)) {
    const first = value.find(isObj);
    return `array of ${fmt(value.length)}${first ? `, each an object with keys ${keyList(first)}` : ""}`;
  }
  if (isObj(value)) return `object with keys ${keyList(value)}`;
  return value === null ? "null" : typeof value;
}

/**
 * The header line and the delimited reply of one call (behaviour 12):
 *
 *   GET https://api.github.com/repos/o/r/issues?state=open → 200 application/json, 140,618 characters, 3,544 after fields
 *
 * A reply over the cap is cut there, and the header says so and, for JSON, gives its shape so
 * the agent can ask again with `fields`. Any status is shaped alike: a 4xx reply's body usually
 * says which argument was wrong (behaviour 14).
 * @param {{ method: string, url: string, status: number, contentType?: string, text: string,
 *   fields?: unknown, maxChars?: number, token?: string }} reply
 *   `url` is the address as sent; `maxChars` a cap from replyCap; `token` the service's token,
 *   when it has one
 * @returns {{ header: string, body: string }}
 * @throws {ApiReplyError} for a reply that is not JSON or text, one over MAX_REPLY_BYTES, and
 *   fields parseFields refuses
 */
export function shapeReply({ method, url, status, contentType, text, fields, maxChars, token }) {
  const paths = parseFields(fields);
  const media = mediaType(contentType);
  if (text.length > MAX_REPLY_BYTES) {
    throw new ApiReplyError(`The reply is over 5 MiB (${fmt(text.length)} characters).`);
  }
  const kind = isJson(media) ? "json" : isText(media) ? "text" : text === "" ? "empty" : null;
  if (!kind) {
    throw new ApiReplyError(
      `The reply is ${media || "of no stated type"}, ${fmt(text.length)} characters: Vimma ` +
        "returns JSON and text replies only.",
    );
  }
  const cap = maxChars ?? DEFAULT_MAX_CHARS;

  // JSON is read and written again compactly, which also turns escapes back into letters, so a
  // token spelt with \u escapes is found by the scrub below.
  let out = text;
  /** @type {unknown} */
  let shaped;
  let parsed = false;
  if (kind === "json") {
    try {
      shaped = selectFields(JSON.parse(text), paths);
      const written = JSON.stringify(shaped);
      if (typeof written === "string") {
        out = written;
        parsed = true;
      }
    } catch {
      // Not JSON after all, or nested past the engine's limits: it goes back as text.
    }
  }
  // JSON that does not parse keeps its escapes: they are undone here, so the scrub finds a token
  // spelt with them.
  if (kind === "json" && !parsed) {
    out = out
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replaceAll("\\/", "/");
  }
  // Folded first (wrapUntrusted folds too), so full-width letters cannot spell the token past
  // the scrub and the cut holds after the fold. Only a head of the text is folded, since one
  // character can fold to 18: NFKC shrinks text at most threefold (a Hangul syllable from three
  // jamo), so four times the cap and the token still covers the cap, and a token cut at that
  // bound lies past the cap.
  const whole = out.length;
  const bound = 4 * (cap + (token?.length ?? 0)) + 16;
  out = scrub((whole > bound ? out.slice(0, bound) : out).normalize("NFKC"), token);

  let header = `${method} ${url} → ${status}${media ? ` ${media}` : ""}, ${fmt(text.length)} characters`;
  if (paths && parsed) header += `, ${fmt(whole)} after fields`;
  if (paths && !parsed) header += "; fields apply to JSON replies only";
  if (whole > bound || out.length > cap) {
    out = cutAt(out, cap);
    header += `, cut at ${fmt(cap)}.`;
    if (parsed) {
      header += ` Shape: ${shapeOf(shaped)}. Ask again with fields to keep what you need.`;
    }
  }
  out = out.replace(LOOK_ALIKE_START, "<\u200b");
  header = scrub(header.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "), token);
  return { header, body: wrapUntrusted(out) };
}
